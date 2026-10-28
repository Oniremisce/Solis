import { useCallback, useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react';
import { Heart, ListMusic, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { qishuiProvider } from '../services/onlineMusic/qishuiProvider';
import { getQishuiWebApiBase } from '../services/onlineMusic/qishuiTransport';
import type { PersonalFmModeId } from '../services/onlineMusic/fmModes';
import { useSettingsStore } from '../stores/settingsStore';
import type { LyricData, UnifiedSong } from '../types';
import { activeLyricLine } from '../utils/wordLrc';
import { cachedSongsByteSize, getCachedSong, getCachedSongs, putCachedSong, type CachedSongRecord } from '../utils/songCache';
import { collectTrack, ensureLikedIds, isLikedSync, uncollectTrack } from '../utils/likedTracks';
import { registerBackHandler } from '../utils/backStack';

// src/screens/PlayerScreen.tsx — 三模式共用播放页（默认/熟悉/新鲜模式同一套组件）。
// 数据源为汽水官方推荐流（/fm/feed）：模式切换重拉队列，队列耗尽自动续拉；
// 播放地址经 /audio/info 代理直出。TV 键位：OK=播放/暂停，上一曲/下一曲短按切歌、
// 长按按设置挡位快进快退（remoteKeys seek 桥）。歌词区卡拉OK式逐字高亮（纯色，无动画）。

export type PlayerMode = 'default' | 'familiar' | 'explore';

/** 选项卡 → 汽水 FM 模式（sodam 对应关系：默认=首页推荐、熟悉=熟悉模式、新鲜=新鲜模式）。 */
const FM_MODE_BY_TAB: Record<PlayerMode, PersonalFmModeId> = {
    default: 'DEFAULT',
    familiar: 'FAMILIAR',
    explore: 'EXPLORE',
};

/** 歌词窗口：当前行上 3 下 4，共 8 行，直接切片渲染（无滚动动画）。 */
const LYRIC_WINDOW = 8;
const LYRIC_BEFORE = 3;

/** 汽水音质档名 → 徽章文案（导出供歌单浮窗播放器复用）。 */
export const QUALITY_LABEL: Record<string, string> = {
    hi_res: 'Hi-Res', spatial: '全景声', lossless: '无损', highest: '高品质', higher: '较高', medium: '标准',
};

/** 汽水音质档名 → 徽章色阶 class（标准=浅蓝 / 高品质=浅绿 / 无损=浅橙 / Hi-Res=香槟金）。 */
export const QUALITY_TONE: Record<string, string> = {
    medium: 'q-standard', higher: 'q-high', highest: 'q-high', lossless: 'q-lossless', hi_res: 'q-hires', spatial: 'q-hires',
};

export function qualityLabel(quality: string | undefined): string {
    return (quality && QUALITY_LABEL[quality]) || '';
}

function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

/** 带字结束时刻的歌词行（供逐字扫色动画使用；end 由相邻字起始推断）。 */
interface TimedWord { text: string; start: number; end: number; }
interface TimedLine { start: number; words: TimedWord[]; }

/** 汽水逐字歌词（LyricData，秒单位）→ 渲染行。字结束时刻取下一个字/下一行的起始（逐字歌词字间连续）。 */
function lyricDataToLines(data: LyricData): TimedLine[] {
    return data.lines.map((line, lineIndex) => {
        const nextLineStart = data.lines[lineIndex + 1]?.startTime ?? line.startTime + 8;
        const words = line.words.map((w, i) => ({
            text: w.text,
            start: w.startTime,
            end: line.words[i + 1]?.startTime ?? Math.max(nextLineStart, w.startTime + 0.2),
        }));
        return { start: line.startTime, words };
    });
}

/** 莫奈动效单字：底层未唱色 + 光晕，顶层亮色随字时间轴 clip 扫色（纯 CSS 动画，负 delay 对齐 seek）。 */
function MonetWord({ word, mountTime }: { word: TimedWord; mountTime: number }) {
    const dur = Math.max(0.05, word.end - word.start);
    // delay 相对挂载时刻：未来为正（等待开播），已过为负（动画填充直接呈现已唱状态）。
    const delay = word.start - mountTime;
    return (
        <span className="mo-word" style={{ '--wdur': `${dur}s`, '--wdelay': `${delay}s` } as CSSProperties}>
            <span className="mo-word-base">{word.text}</span>
            <span aria-hidden className="mo-word-fill">{word.text}</span>
        </span>
    );
}

/** 莫奈动效单行：绝对定位在轨道上自己的全局位置（--idx），挂载时捕获播放位置作字动画时间轴基准。 */
function MonetLine({ line, status, offset, index, time }: {
    line: TimedLine; status: 'active' | 'waiting' | 'passed'; offset: number; index: number; time: number;
}) {
    const mountTimeRef = useRef(time);
    const words = line.words.length > 0 ? line.words : [];
    return (
        <p className={`lyric-line mo ${status}`} data-offset={Math.min(Math.abs(offset), 3)}
            style={{ '--idx': index } as CSSProperties}>
            {words.map((w, i) => <MonetWord key={i} word={w} mountTime={mountTimeRef.current} />)}
        </p>
    );
}

function LyricView({ lines, time, motion, playing, seekEpoch, railKey, onDrift }: {
    lines: TimedLine[]; time: number; motion: boolean; playing: boolean; seekEpoch: number;
    /** 轨道键 = seek 纪元 + 显示歌曲 id：seek 或切显示歌曲时整条轨道重建（字动画基准随之刷新）。 */
    railKey: string;
    /** 检测到字动画 CSS 时钟与音频播放位置漂移超阈值时回调（整条轨道重建对齐）。 */
    onDrift: () => void;
}) {
    // 漂移检测基准：轨道（re）挂载时刻的音频位置 + 墙钟。字动画 delay 都以此为基准，
    // 音频卡顿/缓冲时 currentTime 停走而 CSS 时钟继续 → 偏差增长，超阈值即重建轨道。
    const timeRef = useRef(time);
    timeRef.current = time;
    const alignRef = useRef({ audioTime: time, wall: 0 });
    // 漂移基准重建点：seek 纪元、显示歌曲切换（轨道重建）、播放/暂停切换——暂停时长不计入
    // 墙钟基准，否则恢复播放瞬间「挂载基准 + 暂停期流逝」远超实际位置，漂移检测误报重建（闪烁）。
    useEffect(() => {
        alignRef.current = { audioTime: timeRef.current, wall: performance.now() };
    }, [seekEpoch, railKey, playing]);
    useEffect(() => {
        if (!motion || !playing) return;
        const timer = window.setInterval(() => {
            const { audioTime, wall } = alignRef.current;
            const expected = audioTime + (performance.now() - wall) / 1000;
            if (Math.abs(expected - timeRef.current) > 0.6) onDrift();
        }, 1000);
        return () => window.clearInterval(timer);
    }, [motion, playing, onDrift]);
    if (lines.length === 0) return <p className="player-lyrics-empty">暂无歌词</p>;
    const active = activeLyricLine(lines, time);
    const from = Math.max(0, active - LYRIC_BEFORE);
    const slice = lines.slice(from, from + LYRIC_WINDOW);
    if (!motion) {
        return (
            <div className="player-lyrics-list">
                {slice.map((line, i) => {
                    const lineIndex = from + i;
                    if (lineIndex !== active) {
                        return <p key={lineIndex} className="lyric-line">{line.words.map((w) => w.text).join('')}</p>;
                    }
                    return (
                        <p key={lineIndex} className="lyric-line active">
                            {line.words.map((w, j) => {
                                const sung = time >= w.start;
                                // 当前字 = 行内最后一个已唱字。
                                const isCurrent = sung && (j === line.words.length - 1 || time < line.words[j + 1].start);
                                return (
                                    <span key={j} className={`lyric-word${sung ? ' sung' : ''}${isCurrent ? ' current' : ''}`}>
                                        {w.text}
                                    </span>
                                );
                            })}
                        </p>
                    );
                })}
            </div>
        );
    }
    // 莫奈动效（莫奈轨道）：行绝对定位在各自全局位置，整条轨道随当前行弹性滚动一行——
    // 当前任播完后轨道上移，旧行弹性缩小、新行弹性放大到当前句。
    // 仅渲染当前行附近窗口（轨道远端行在渐隐区外挂载/卸载，无跳动感）。
    // seek 时整条轨道重建（key 变化），行内字动画以新播放位置为时间轴基准重新对齐。
    const MO_WINDOW_BEFORE = 4;
    const MO_WINDOW_AFTER = 5;
    const moFrom = Math.max(0, active - MO_WINDOW_BEFORE);
    const moSlice = lines.slice(moFrom, Math.min(lines.length, active + MO_WINDOW_AFTER + 1));
    return (
        <div className="player-lyrics-list mo">
            <div key={railKey} className={`mo-rail${playing ? '' : ' paused'}`}
                style={{ '--mo-active': active } as CSSProperties}>
                {moSlice.map((line, i) => {
                    const lineIndex = moFrom + i;
                    const lineEnd = line.words.length > 0 ? line.words[line.words.length - 1].end : line.start;
                    const status: 'active' | 'waiting' | 'passed' =
                        lineIndex === active ? 'active' : time >= lineEnd ? 'passed' : 'waiting';
                    return <MonetLine key={lineIndex} line={line} status={status}
                        offset={lineIndex - active} index={lineIndex} time={time} />;
                })}
            </div>
        </div>
    );
}

export default function PlayerScreen({ mode }: { mode: PlayerMode }) {
    // 双播放器架构：FM 与歌单会话各持独立 <audio>，各播各的 src、元素自己记进度。
    // 互斥规则只有一条：一个开播就暂停另一个（playSessionAudio + playing 事件双重保证）。
    // 切会话 = 暂停对方 + 恢复自己——无 src 换血、无加载等待、无跨会话定位 seek，
    // 暂停/恢复语义与单播放器完全一致，根上消除切换加载期歌词空跑/漂移重建/流中止报错。
    const fmAudioRef = useRef<HTMLAudioElement>(null);
    const plAudioRef = useRef<HTMLAudioElement>(null);
    const audioOf = (s: 'fm' | 'playlist'): HTMLAudioElement | null => (s === 'fm' ? fmAudioRef.current : plAudioRef.current);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [current, setCurrent] = useState<UnifiedSong | null>(null);
    const [lyricLines, setLyricLines] = useState<TimedLine[]>([]);
    // 莫奈歌词动效：seek 结束后重建歌词列表，字动画时间轴按新播放位置重新对齐。
    // seeked 事件 + 防抖：长按快进时桥会连续 seek，防抖避免歌词列表每帧重建。
    const [seekEpoch, setSeekEpoch] = useState(0);
    // 漂移回调必须引用稳定：currentTime 每帧渲染都会换新函数引用，不稳定会让
    // LyricView 的漂移检测 interval 频繁重置、永远到不了检测周期。
    const handleLyricDrift = useCallback(() => setSeekEpoch((e) => e + 1), []);
    const seekResetTimerRef = useRef<number | null>(null);
    const scheduleSeekRealign = () => {
        if (seekResetTimerRef.current !== null) window.clearTimeout(seekResetTimerRef.current);
        seekResetTimerRef.current = window.setTimeout(() => {
            seekResetTimerRef.current = null;
            setSeekEpoch((e) => e + 1);
        }, 300);
    };
    useEffect(() => () => {
        if (seekResetTimerRef.current !== null) window.clearTimeout(seekResetTimerRef.current);
    }, []);
    // 拉歌状态文案：loading（拉取中）与 error（含未登录引导）显示在歌词区。
    const [feedStatus, setFeedStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [feedMessage, setFeedMessage] = useState('正在拉取推荐歌曲…');
    // 实际播放音质档（服务端降档后返回），用于音质徽章。
    const [actualQuality, setActualQuality] = useState<string>('');
    // 收藏（我喜欢）状态：当前曲是否已在官方「我喜欢的音乐」歌单。
    const [liked, setLiked] = useState(false);
    const likeBusyRef = useRef(false);
    // 播放列表侧滑窗：打开时快照当前曲 + 待播队列（后台补足不实时刷新，开关/切歌时重取）。
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [queueView, setQueueView] = useState<UnifiedSong[]>([]);
    const titleViewportRef = useRef<HTMLDivElement>(null);
    const titleTextRef = useRef<HTMLSpanElement>(null);
    // 歌名溢出像素数（>0 时跑马灯滚动）；ResizeObserver 同时观察视口与文本，覆盖布局/字体变化。
    const [titleOverflow, setTitleOverflow] = useState(0);

    // 队列/历史状态放 ref：回调链（ended/按键/自动续拉）始终读写最新值，不受渲染闭包影响。
    // ref 一律指向「audio 归属会话」的数据，会话切换时重新指向（播放链路无需感知会话）。
    const queueRef = useRef<UnifiedSong[]>([]);
    const historyRef = useRef<UnifiedSong[]>([]);
    const currentRef = useRef<UnifiedSong | null>(null);
    const modeRef = useRef<PlayerMode>(mode);
    const fetchingRef = useRef(false);

    // 双会话架构：推荐流（FM）与歌单/搜索（浮窗）各持独立 <audio> 元素与播放状态，完全解耦——
    // 各播各的 src、元素自己记进度，唯一互斥规则是「一个会话开播就暂停另一个」（activeSession
    // 标记允许出声的会话）。切会话 = 暂停对方 + 恢复自己，无 src 换血、无加载等待、无跨会话定位。
    // 界面显示是独立维度（viewSession）：播放页主区域永远显示 FM 会话内容，浮窗永远显示歌单
    // 会话内容。收起浮窗只切视图不暂停歌单——FM 界面显示 FM 自己的暂停快照，歌单歌曲继续
    // 后台播放。快照态（view ≠ active）下，内容型状态（current/歌词/收藏/音质）从视图会话缓存
    // 渲染，时间型（进度/时长/播放中）在渲染层取视图会话缓存（后台元素暂停中，pausedTime 即真实位置）。
    interface PlayerSession {
        current: UnifiedSong | null;
        queue: UnifiedSong[];
        history: UnifiedSong[];
        pausedTime: number;
        snapshot: UnifiedSong[] | null;
        // 显示缓存：会话被切走时冻结内容，视图切回时恢复显示（快照态渲染的数据源）。
        lyrics: TimedLine[];
        liked: boolean;
        quality: string;
        duration: number;
    }
    const newSession = (): PlayerSession => ({
        current: null, queue: [], history: [], pausedTime: 0, snapshot: null,
        lyrics: [], liked: false, quality: '', duration: 0,
    });
    const fmSessionRef = useRef<PlayerSession>(newSession());
    const playlistSessionRef = useRef<PlayerSession | null>(null);
    // activeSession=audio 归属（播什么）；viewSession=显示归属（显示什么）。
    // 两个 state 为渲染镜像（快照态判定并触发重渲染），ref 供回调链读写最新值。
    const activeSessionRef = useRef<'fm' | 'playlist'>('fm');
    const [activeSession, setActiveSession] = useState<'fm' | 'playlist'>('fm');
    const viewSessionRef = useRef<'fm' | 'playlist'>('fm');
    const [viewSession, setViewSession] = useState<'fm' | 'playlist'>('fm');
    const sessionOf = (s: 'fm' | 'playlist') => (s === 'fm' ? fmSessionRef.current : playlistSessionRef.current);

    useEffect(() => {
        const viewport = titleViewportRef.current;
        const text = titleTextRef.current;
        if (!viewport || !text) return;
        const measure = () => setTitleOverflow(Math.max(0, text.scrollWidth - viewport.clientWidth));
        const observer = new ResizeObserver(measure);
        observer.observe(viewport);
        observer.observe(text);
        measure();
        return () => observer.disconnect();
    }, []);

    // 内容型显示状态统一发布：先写活动会话缓存（currentRef=播放链路的当前曲事实源），
    // 仅当视图会话 === 活动会话（非快照态）才刷新渲染 state——后台会话的换曲/歌词/收藏/音质
    // 变化不会污染前台界面（快照态显示由视图会话缓存决定，渲染层另行取值）。
    const publishCurrent = (song: UnifiedSong | null) => {
        const session = sessionOf(activeSessionRef.current);
        if (session && session.current !== song) {
            session.current = song;
            session.lyrics = [];
            session.liked = false;
            session.quality = '';
            session.duration = 0;
        }
        currentRef.current = song;
        if (viewSessionRef.current === activeSessionRef.current) setCurrent(song);
    };
    const publishLiked = (v: boolean) => {
        const session = sessionOf(activeSessionRef.current);
        if (session) session.liked = v;
        if (viewSessionRef.current === activeSessionRef.current) setLiked(v);
    };
    const publishQuality = (q: string) => {
        const session = sessionOf(activeSessionRef.current);
        if (session) session.quality = q;
        if (viewSessionRef.current === activeSessionRef.current) setActualQuality(q);
    };
    // 视图切换（不暂停任何元素）：内容型状态从目标会话缓存恢复；进度/时长/播放态在该会话
    // 元素已装载本会话当前曲时直接读元素（暂停元素持有原进度，零误差），否则回退会话缓存
    // （元素还装着旧曲/新会话刚建新歌未装载时，不能把旧曲进度显示给新歌）。
    const applyViewSession = (vs: 'fm' | 'playlist') => {
        const session = sessionOf(vs);
        if (!session) return;
        viewSessionRef.current = vs;
        setViewSession(vs);
        setCurrent(session.current);
        setLyricLines(session.lyrics);
        setLiked(session.liked);
        setActualQuality(session.quality);
        const a = audioOf(vs);
        const matches = !!a && session.current != null
            && loadedSongRef.current[vs] === String(session.current.id);
        setCurrentTime(matches ? a!.currentTime : (vs === 'fm' ? session.pausedTime : 0));
        setDuration(matches && Number.isFinite(a!.duration) ? a!.duration : (session.duration || 0));
        setPlaying(matches && !a!.paused);
        if (!session.current && vs === 'fm') {
            setFeedStatus('loading');
            setFeedMessage('正在拉取推荐歌曲…');
        }
        if (session.current && session.lyrics.length === 0) {
            void loadExtras(session.current, undefined, vs); // 歌词缓存缺失时兜底拉取
        }
    };

    // 自动缓存播放过的歌曲：封面 blob + 逐字歌词 + 歌名/歌手/时长元数据。
    // 开关与容量挡位来自设置；容量满后不再写入；已缓存曲目跳过；全程静默失败。
    const cachePlayedSong = async (song: UnifiedSong, lyric: LyricData | null) => {
        const settings = useSettingsStore.getState();
        if (!settings.autoCache) return;
        try {
            const key = `qishui:${song.id}`;
            const existing = await getCachedSongs();
            if (existing.some((rec) => rec.key === key)) return;
            let coverBlob: Blob | undefined;
            const coverUrl = song.album?.coverUrl ?? '';
            if (coverUrl) {
                try {
                    // CDN 无 CORS 头，浏览器直连 fetch 会被拦：封面下载走 qishui-api 图片代理。
                    const base = getQishuiWebApiBase();
                    const fetchUrl = base ? `${base}/image/proxy?url=${encodeURIComponent(coverUrl)}` : coverUrl;
                    const resp = await fetch(fetchUrl);
                    if (resp.ok) coverBlob = await resp.blob();
                } catch { /* 封面跨域/网络失败只存 URL */ }
            }
            const lyricJson = lyric ? JSON.stringify(lyric) : '';
            const metaJson = JSON.stringify({
                name: song.name,
                artists: song.artists.map((a) => a.name),
                coverUrl,
                durationMs: song.durationMs,
            });
            const record: CachedSongRecord = {
                key,
                name: song.name,
                artists: song.artists.map((a) => a.name).join(' / '),
                coverUrl,
                coverBlob,
                lyricData: lyric ?? undefined,
                durationMs: song.durationMs,
                byteSize: (coverBlob?.size ?? 0) + lyricJson.length + metaJson.length,
                cachedAt: Date.now(),
            };
            const used = await cachedSongsByteSize();
            const limitBytes = settings.cacheLimit * 1024 ** 3;
            if (used + record.byteSize > limitBytes) return; // 缓存已满：不再写入
            await putCachedSong(record);
        } catch { /* 缓存失败静默（IndexedDB 不可用等） */ }
    };

    // 音频缓存：后台整曲抓取代理流写入 IndexedDB（播放同时进行，不阻塞），
    // 重播同曲且音质挡位一致时直接用缓存 blob 播放，不再发起网络请求。
    const cacheAudio = async (song: UnifiedSong, streamUrl: string, quality: string) => {
        const settings = useSettingsStore.getState();
        if (!settings.autoCache) return;
        try {
            const resp = await fetch(streamUrl, { mode: 'cors' });
            if (!resp.ok) return;
            const blob = await resp.blob();
            const key = `qishui:${song.id}`;
            const used = await cachedSongsByteSize();
            const limitBytes = settings.cacheLimit * 1024 ** 3;
            const existing = await getCachedSong(key);
            const oldAudioSize = existing?.audioBlob?.size ?? 0;
            if (used - oldAudioSize + blob.size > limitBytes) return; // 缓存已满：不写音频
            if (existing) {
                // 文本记录已在（歌词缓存写入）：合并音频字段，byteSize 换算差额。
                await putCachedSong({
                    ...existing,
                    audioBlob: blob,
                    audioQuality: quality,
                    byteSize: existing.byteSize - oldAudioSize + blob.size,
                });
            } else {
                await putCachedSong({
                    key,
                    name: song.name,
                    artists: song.artists.map((a) => a.name).join(' / '),
                    coverUrl: song.album?.coverUrl ?? '',
                    audioBlob: blob,
                    audioQuality: quality,
                    durationMs: song.durationMs,
                    byteSize: blob.size,
                    cachedAt: Date.now(),
                });
            }
        } catch { /* 音频缓存失败静默 */ }
    };

    // blob URL 生命周期：按会话各记一个，换曲只释放本会话的上一个——另一会话元素仍持有
    // 自己的 blob（暂停后续播要用），不能全局回收。播放页卸载（切「我的」隐藏）时全部释放。
    const blobUrlsRef = useRef<{ fm: string | null; playlist: string | null }>({ fm: null, playlist: null });
    const revokeSessionBlob = (s: 'fm' | 'playlist') => {
        const url = blobUrlsRef.current[s];
        if (url) {
            URL.revokeObjectURL(url);
            blobUrlsRef.current[s] = null;
        }
    };
    useEffect(() => () => {
        revokeSessionBlob('fm');
        revokeSessionBlob('playlist');
    }, []);
    // 各元素当前装载的歌曲 id：会话切换/视图恢复据此判断「元素持有的是不是本会话当前曲」，
    // 是才原地续播（零等待），否则走 playSong 装载新歌。装载失败（error）即作废。
    const loadedSongRef = useRef<{ fm: string | null; playlist: string | null }>({ fm: null, playlist: null });

    // 歌词加载：结果写入指定会话的显示缓存（默认 audio 归属会话），仅当视图正显示该会话才落
    // 渲染 state。竞态保护：该会话已切歌则丢弃结果。
    const loadExtras = async (song: UnifiedSong, cachedLyric?: LyricData, session: 'fm' | 'playlist' = activeSessionRef.current) => {
        const target = sessionOf(session);
        if (!target || target.current !== song) return;
        // 会话缓存已有该曲歌词（快照态续播/重复加载）：直接复用——不清空 UI、不重新拉取，
        // 避免「暂无歌词」闪现与歌词轨道无谓重建（缓存命中就该无缝续走）。
        if (!cachedLyric && target.lyrics.length > 0) {
            if (viewSessionRef.current === session) setLyricLines(target.lyrics);
            return;
        }
        if (cachedLyric) {
            target.lyrics = lyricDataToLines(cachedLyric);
            if (viewSessionRef.current === session) setLyricLines(target.lyrics);
            return;
        }
        if (viewSessionRef.current === session) setLyricLines([]);
        try {
            const result = await qishuiProvider.lyrics?.getLyrics?.(song);
            if (target.current === song && result?.lyrics) {
                target.lyrics = lyricDataToLines(result.lyrics);
                if (viewSessionRef.current === session) setLyricLines(target.lyrics);
                void cachePlayedSong(song, result.lyrics);
            }
        } catch { /* 歌词缺失保持空态 */ }
    };

    // 收藏（我喜欢）状态：切歌时比对「我喜欢的音乐」曲目集合（汽水无单曲收藏态接口，
    // 集合模块级缓存单飞加载）。集合未就绪时先按未收藏显示，就绪后回调刷新。
    const refreshLiked = async (song: UnifiedSong) => {
        try {
            await ensureLikedIds();
        } catch { /* 未登录/网络失败：保持未收藏态 */ }
        const session = sessionOf(activeSessionRef.current);
        if (session?.current === song) publishLiked(isLikedSync(String(song.id)) === true);
    };

    // 收藏/取消收藏：乐观更新，失败回弹；请求期间忽略重复点击。
    // 操作对象是「当前显示」的歌曲（视图会话的当前曲），收藏态直接写该会话缓存。
    const toggleLiked = async () => {
        const session = sessionOf(viewSessionRef.current);
        const song = session?.current ?? null;
        if (!song || likeBusyRef.current) return;
        likeBusyRef.current = true;
        const next = !liked;
        setLiked(next);
        if (session) session.liked = next;
        try {
            await (next ? collectTrack(String(song.id)) : uncollectTrack(String(song.id)));
        } catch {
            setLiked(!next);
            if (session) session.liked = !next;
        }
        finally { likeBusyRef.current = false; }
    };

    // 播放启动统一入口：play() 被拒（自动播策略/手势要求）时不再静默——
    // 打 console 诊断（logcat 可见）+ 挂 pending 标志，待任意用户手势（遥控器按键/触摸）
    // 时自动重试一次。TV WebView 媒体行为与手机不一致时由此兜底。
    const pendingPlayRef = useRef(false);
    const attemptPlay = (audio: HTMLAudioElement) => {
        audio.play().then(() => {
            pendingPlayRef.current = false;
        }).catch((reason: DOMException) => {
            pendingPlayRef.current = true;
            console.warn(`[solis] play() rejected: name=${reason?.name ?? '?'} msg=${reason?.message ?? ''}`);
        });
    };
    // 会话互斥播放：一个会话开播前先暂停另一会话的元素（双播放器唯一互斥规则，
    // playing 事件里还有一道兜底）。
    const playSessionAudio = (s: 'fm' | 'playlist') => {
        const other = audioOf(s === 'fm' ? 'playlist' : 'fm');
        if (other && !other.paused) other.pause();
        const a = audioOf(s);
        if (a) attemptPlay(a);
    };

    useEffect(() => {
        const retryOnGesture = () => {
            if (!pendingPlayRef.current) return;
            const audio = audioOf(activeSessionRef.current);
            if (!audio) return;
            pendingPlayRef.current = false;
            attemptPlay(audio);
        };
        window.addEventListener('keydown', retryOnGesture, true);
        window.addEventListener('pointerdown', retryOnGesture, true);
        return () => {
            window.removeEventListener('keydown', retryOnGesture, true);
            window.removeEventListener('pointerdown', retryOnGesture, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 播放一首歌到指定会话的元素上：设置 src 后开播（开播动作内部先暂停另一会话元素）。
    // 元素级解耦后本函数只处理「新歌装载」，会话恢复续播不经过这里（switchSession 直接
    // 恢复元素播放），因此不再有任何续播 seek / 等 metadata 定位的逻辑。
    const playSong = async (song: UnifiedSong, session: 'fm' | 'playlist' = activeSessionRef.current) => {
        // 同曲重播（同一会话再次点播同一首）：内容缓存仍有效，不重置音质/收藏显示。
        const sameSong = currentRef.current === song;
        publishCurrent(song);
        setCurrentTime(0);
        if (!sameSong) {
            setDuration(0);
            publishQuality('');
            publishLiked(false);
            void refreshLiked(song);
        }
        const audio = audioOf(session);
        if (!audio) return;
        // 新请求一旦发起立即静默另一会话：装载（可能含网络等待）期间旧歌不让继续出声。
        const other = audioOf(session === 'fm' ? 'playlist' : 'fm');
        if (other && !other.paused) other.pause();
        try {
            // 优先音质挡位来自设置；曲库缺档时服务端自动降档取可用最高。
            const preferred = useSettingsStore.getState().preferredQuality;
            // 缓存命中：同曲 + 音频已缓存 + 音质挡位一致 → blob 直接播放，零网络请求。
            const cached = await getCachedSong(`qishui:${song.id}`);
            if (currentRef.current !== song) return; // 期间已切歌
            if (cached?.audioBlob && cached.audioQuality === preferred) {
                revokeSessionBlob(session);
                const blobUrl = URL.createObjectURL(cached.audioBlob);
                blobUrlsRef.current[session] = blobUrl;
                audio.src = blobUrl;
                loadedSongRef.current[session] = String(song.id);
                publishQuality(cached.audioQuality);
                playSessionAudio(session);
                void loadExtras(song, (cached.lyricData as LyricData | undefined) ?? undefined, session);
                return;
            }
            const source = await qishuiProvider.playback?.getAudioSource(song, preferred);
            if (currentRef.current !== song || !source) return; // 期间已切歌或无播放地址
            revokeSessionBlob(session);
            audio.src = source.url;
            loadedSongRef.current[session] = String(song.id);
            publishQuality(source.actualQuality ?? '');
            playSessionAudio(session);
            void loadExtras(song, undefined, session);
            void cacheAudio(song, source.url, source.actualQuality ?? '');
        } catch (error) {
            setFeedStatus('error');
            setFeedMessage('获取播放地址失败，请稍后重试');
            void error; // 单曲失败不阻塞队列，用户可手动下一曲
        }
    };

    // 拉一批 FM 推荐入队；autoPlay 时队列空则直接开播新到歌曲。
    const fetchFeed = async (autoPlay: boolean) => {
        if (fetchingRef.current) return;
        fetchingRef.current = true;
        if (!currentRef.current) {
            setFeedStatus('loading');
            setFeedMessage('正在拉取推荐歌曲…');
        }
        try {
            const tracks = await qishuiProvider.recommendations?.getPersonalFm?.({
                mode: FM_MODE_BY_TAB[modeRef.current],
            }) ?? [];
            queueRef.current.push(...tracks);
            if (autoPlay && !currentRef.current) {
                const first = queueRef.current.shift();
                if (first) {
                    setFeedStatus('ready');
                    void playSong(first);
                } else {
                    setFeedStatus('error');
                    setFeedMessage('暂无推荐歌曲');
                    return;
                }
            }
            setFeedStatus('ready');
        } catch (error) {
            const code = (error as { code?: string }).code;
            setFeedStatus('error');
            setFeedMessage(code === 'auth-required'
                ? '请先登录汽水账号（右上角头像扫码登录）'
                : '拉取推荐歌曲失败，请稍后重试');
        } finally {
            fetchingRef.current = false;
        }
    };

    // 队列待播数量低于设置挡位（5/10/20）时自动续拉补足；单批拉取失败即止。
    // 侧滑窗打开时补足完成即刷新列表（新歌只追加尾部，不重排既有条目）。
    // 仅 FM 会话补足：歌单会话的队列是固定歌单，不混入 FM 推荐；
    // 歌单播完由 playNext 终止会话转回 FM。
    const topUpQueue = async () => {
        if (activeSessionRef.current !== 'fm') return;
        while (queueRef.current.length < useSettingsStore.getState().playlistSize) {
            const before = queueRef.current.length;
            await fetchFeed(false);
            if (fetchingRef.current || queueRef.current.length === before) return;
        }
        if (drawerOpenRef.current) refreshQueueView();
    };

    // 终止歌单会话：会话数据丢弃，audio 归还 FM——有进度则从暂停处续播，无则拉新自动播。
    // （歌单播完自然续接推荐流，浮窗随之关闭。）
    const endPlaylistSession = () => {
        playlistSessionRef.current = null;
        window.dispatchEvent(new CustomEvent('solis:playlist-session', { detail: { active: false } }));
        switchSession('fm', true);
    };

    const playNext = (auto = false) => {
        // 歌单会话：队列取歌单剩余曲；耗尽即终止会话续接 FM（不向歌单混入推荐）。
        // auto=歌曲自然播完的自动切歌：只推进 audio 归属会话的队列，不受界面视图影响
        // （搜索歌曲后台播完应续歌单队列，而非被 FM 界面的快照视图劫持去播 FM）。
        if (activeSessionRef.current === 'playlist') {
            if (!auto && viewSessionRef.current !== 'playlist') {
                // 快照态（FM 界面显示 FM 暂停快照）手动切歌：audio 归还 FM（歌单进度先记入
                // 会话，浮窗可再展开续播），随后按 FM 队列逻辑继续。
                switchSession('fm', false);
            } else {
                const next = queueRef.current.shift();
                if (!next) {
                    endPlaylistSession();
                    return;
                }
                if (currentRef.current) historyRef.current.push(currentRef.current);
                setFeedStatus('ready');
                void playSong(next);
                return;
            }
        }
        if (queueRef.current.length === 0) {
            // 队列耗尽：补足后取队首开播。
            void (async () => {
                await topUpQueue();
                const song = queueRef.current.shift();
                if (!song) {
                    setFeedStatus('error');
                    setFeedMessage('暂无推荐歌曲');
                    return;
                }
                if (currentRef.current) historyRef.current.push(currentRef.current);
                setFeedStatus('ready');
                void playSong(song);
            })();
            return;
        }
        const next = queueRef.current.shift();
        if (!next) return;
        if (currentRef.current) historyRef.current.push(currentRef.current);
        setFeedStatus('ready');
        void playSong(next);
        void topUpQueue(); // 切歌消耗一首后后台补足（侧滑窗开着会刷新列表尾部）
    };

    const playPrev = () => {
        // 快照态（FM 界面显示 FM 暂停快照）的上一曲：audio 归还 FM 后按 FM 历史回退。
        if (activeSessionRef.current === 'playlist' && viewSessionRef.current !== 'playlist') {
            switchSession('fm', false);
        }
        const prev = historyRef.current.pop();
        if (!prev) return;
        if (currentRef.current) queueRef.current.unshift(currentRef.current);
        setFeedStatus('ready');
        void playSong(prev);
    };

    // 外部歌单接管（「我的」页歌单/搜索结果点歌）：整张列表灌入独立歌单会话（整体替换，
    // 不管此前浮窗是否有歌在播）——当前曲之前倒序入历史（供上一曲回退）、之后顺延入待播队列；
    // 完整快照原顺序保留（播放列表侧滑窗按歌单顺序显示全部歌曲）。歌单元素装载新歌开播；
    // FM 元素由 playSong 内部互斥暂停、原地保留进度，浮窗收起后 FM 界面即显示这份暂停快照。
    // 视图切到歌单由随后的浮窗展开事件（solis:playlist-sheet open）驱动。播放页隐藏时监听仍生效。
    useEffect(() => {
        const onPlayQueue = (e: Event) => {
            const detail = (e as CustomEvent<{ songs?: UnifiedSong[]; index?: number }>).detail;
            const songs = detail?.songs;
            if (!Array.isArray(songs) || songs.length === 0) return;
            const index = Math.max(0, Math.min(Number(detail?.index) || 0, songs.length - 1));
            // 建/替换歌单会话（点新歌单/新搜索=整体替换）。FM 元素不动——它自己记着 FM 进度
            // （暂停后 currentTime 不走），歌单开播动作（playSong）会先暂停它。
            playlistSessionRef.current = {
                current: songs[index],
                queue: songs.slice(index + 1),
                history: songs.slice(0, index).reverse(),
                pausedTime: 0,
                snapshot: songs,
                lyrics: [], liked: false, quality: '', duration: 0,
            };
            activeSessionRef.current = 'playlist';
            setActiveSession('playlist');
            queueRef.current = playlistSessionRef.current.queue;
            historyRef.current = playlistSessionRef.current.history;
            window.dispatchEvent(new CustomEvent('solis:playlist-session', { detail: { active: true } }));
            setFeedStatus('ready');
            void playSong(songs[index], 'playlist');
            if (drawerOpenRef.current) refreshQueueView();
        };
        window.addEventListener('solis:play-queue', onPlayQueue);
        return () => window.removeEventListener('solis:play-queue', onPlayQueue);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 浮窗开合（HomeScreen 驱动）：展开把活动会话切到歌单（FM 元素暂停、歌单元素从暂停处
    // 续播；歌单本来就在播则仅切视图，歌词继续走）。收起只把视图切回 FM——FM 界面显示
    // FM 自己的暂停快照（内容/进度/时长取会话缓存），歌单歌曲继续后台播放；
    // FM 的恢复由用户按播放键/切歌/切模式显式触发。
    useEffect(() => {
        const onSheet = (e: Event) => {
            const open = Boolean((e as CustomEvent<{ open?: boolean }>).detail?.open);
            if (open) {
                if (!playlistSessionRef.current) return;
                if (activeSessionRef.current === 'fm') switchSession('playlist', true);
                else if (viewSessionRef.current !== 'playlist') applyViewSession('playlist');
            } else if (viewSessionRef.current !== 'fm') {
                applyViewSession('fm');
            }
        };
        window.addEventListener('solis:playlist-sheet', onSheet);
        return () => window.removeEventListener('solis:playlist-sheet', onSheet);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 会话切换：暂停对方元素、把活动会话交给目标。两元素各自记着进度——无进度保存、
    // 无 src 换血、无加载等待。autoplay=true 时目标元素已装载本会话当前曲则原地瞬时续播
    // （快照态手动改过暂停进度且与元素位置差超阈值时先原地 seek，已装载元素 seek 零等待），
    // 否则装载新歌开播；false=只移交不播放（快照态切歌先归还，再由调用方走队列逻辑）。
    // 视图随 applyViewSession 同步。
    const switchSession = (to: 'fm' | 'playlist', autoplay: boolean) => {
        const from = activeSessionRef.current;
        if (from === to) return;
        const target = sessionOf(to);
        if (!target) return;
        audioOf(from)?.pause();
        activeSessionRef.current = to;
        setActiveSession(to);
        queueRef.current = target.queue;
        historyRef.current = target.history;
        applyViewSession(to);
        if (autoplay) {
            if (target.current) {
                const a = audioOf(to);
                if (a && loadedSongRef.current[to] === String(target.current.id)) {
                    // 元素已持有本会话歌曲：瞬时续播。快照态手动改过暂停进度（进度条点击）且
                    // 与元素位置差超阈值时先原地 seek（已装载元素 seek 零等待）。
                    if (target.pausedTime > 0 && Math.abs(a.currentTime - target.pausedTime) > 0.3) {
                        a.currentTime = target.pausedTime;
                    }
                    setFeedStatus('ready');
                    playSessionAudio(to);
                } else {
                    setFeedStatus('ready');
                    void playSong(target.current, to);
                }
            } else if (to === 'fm') {
                // FM 会话还没有当前曲（首次进入/模式重置后）：清 UI 拉首播。
                setCurrentTime(0);
                setDuration(0);
                setFeedStatus('loading');
                setFeedMessage('正在拉取推荐歌曲…');
                void (async () => {
                    await fetchFeed(true);
                    void topUpQueue();
                })();
            }
        }
    };

    // 模式切换：必然回到 FM 播放页（显式选模式=显式要求播放该流）。歌单元素暂停（进度留在
    // 元素里，顶栏浮窗按钮仍在，可再展开续播）；随后 FM 会话整体重置（清队列/历史/显示缓存）
    // 并清空 FM 元素旧装载（会话已重置，旧曲不再属于它），视图与活动会话都回到 FM，
    // 按新模式重拉首批并自动播放。
    useEffect(() => {
        modeRef.current = mode;
        if (activeSessionRef.current === 'playlist') {
            audioOf('playlist')?.pause();
            activeSessionRef.current = 'fm';
            setActiveSession('fm');
        }
        const fmAudio = fmAudioRef.current;
        if (fmAudio) {
            fmAudio.pause();
            fmAudio.removeAttribute('src');
            fmAudio.load();
            loadedSongRef.current.fm = null;
        }
        fmSessionRef.current = newSession();
        queueRef.current = fmSessionRef.current.queue;
        historyRef.current = fmSessionRef.current.history;
        viewSessionRef.current = 'fm';
        setViewSession('fm');
        publishCurrent(null);
        setLyricLines([]);
        setLiked(false);
        setActualQuality('');
        setCurrentTime(0);
        setDuration(0);
        void (async () => {
            await fetchFeed(true);
            void topUpQueue();
        })();
    }, [mode]);

    const togglePlay = () => {
        // 快照态（视图 ≠ 活动会话）：播放键 = 切到当前显示的会话续播——
        // FM 界面按播放键续播 FM（歌单元素暂停）；浮窗按播放键续播歌单（FM 元素暂停）。
        if (viewSessionRef.current !== activeSessionRef.current) {
            switchSession(viewSessionRef.current, true);
            return;
        }
        const audio = audioOf(activeSessionRef.current);
        if (!audio) return;
        if (audio.paused) playSessionAudio(activeSessionRef.current);
        else audio.pause();
    };

    // 播放列表侧滑窗：列表 = 当前播放曲（第一条）+ 下一曲将取的队列顺序（第二条起），
    // 总条数取设置的播放列表数量挡位；队列自动补足只向尾部追加，不重刷整表。
    // 打开时焦点进入列表首条（遮罩锁定主页操作）；关闭先播收起动画再卸载。
    const drawerOpenRef = useRef(false);
    useEffect(() => {
        drawerOpenRef.current = drawerOpen;
    }, [drawerOpen]);

    const [drawerClosing, setDrawerClosing] = useState(false);

    const closeDrawer = () => {
        if (!drawerOpenRef.current || drawerClosing) return;
        setDrawerClosing(true);
        window.setTimeout(() => {
            setDrawerOpen(false);
            setDrawerClosing(false);
        }, 260); // 与 drawer-out 动画时长对齐
    };

    const refreshQueueView = () => {
        // 侧滑列表按「视图会话」取数据源：FM 视图（含快照态）显示 FM 队列挡位语义；
        // 歌单视图显示完整歌单快照（当前曲自然位于其歌单位置，歌单播完续接 FM 后回挡位语义）。
        const vs = viewSessionRef.current;
        const session = sessionOf(vs);
        if (!session) return;
        const full = session.current ? [session.current, ...session.queue] : [...session.queue];
        setQueueView(vs === 'playlist' && session.snapshot ? session.snapshot : full.slice(0, useSettingsStore.getState().playlistSize));
    };

    const openDrawer = () => {
        refreshQueueView();
        setDrawerOpen(true);
        // 默认焦点：歌单视图落在当前播放曲（playing 高亮条目），FM 视图落第一首；
        // 歌单当前曲可能不在列表首条，找不到高亮条目时回退第一条。
        // 查询需在渲染帧内执行（setDrawerOpen 后 drawer 尚未挂载）。
        requestAnimationFrame(() => {
            const target = viewSessionRef.current === 'playlist'
                ? (document.querySelector<HTMLElement>('.playlist-drawer .playlist-item.playing')
                    ?? document.querySelector<HTMLElement>('.playlist-drawer .playlist-item'))
                : document.querySelector<HTMLElement>('.playlist-drawer .playlist-item');
            target?.focus();
        });
    };

    // 点击列表条目（歌单视图）：按歌单快照位置重切历史/待播（上一曲可回退到歌单前面的歌），
    // 列表仍显示完整歌单；点当前曲仅关闭侧滑窗。歌单视图首条≠当前曲，任何位置都可点播。
    // 点击列表条目（FM 视图）：丢弃其之前的待播歌曲（FM 消耗语义），该曲成为当前播放（列表第一条），
    // 其后队列顺延为第二、三…条；首条即当前播放曲，仅关闭侧滑窗。
    // 快照态（视图 ≠ 活动会话）先移交会话（元素各自保留进度）再按视图会话逻辑选歌。
    const playFromQueue = (index: number) => {
        const vs = viewSessionRef.current;
        if (vs === 'playlist') {
            const session = playlistSessionRef.current;
            const snapshot = session?.snapshot;
            if (!session || !snapshot) return;
            const song = snapshot[index];
            if (!song) return;
            if (song === session.current) { closeDrawer(); return; } // 点当前曲仅关侧滑窗
            if (activeSessionRef.current !== 'playlist') switchSession('playlist', false);
            queueRef.current = snapshot.slice(index + 1);
            historyRef.current = snapshot.slice(0, index).reverse();
            setFeedStatus('ready');
            void playSong(song);
            refreshQueueView();
            closeDrawer();
            return;
        }
        if (index <= 0) { closeDrawer(); return; } // FM 视图首条=当前播放曲，仅关侧滑窗
        if (activeSessionRef.current !== 'fm') switchSession('fm', false);
        const song = queueRef.current[index - 1];
        if (!song) return;
        queueRef.current.splice(0, index);
        const next = queueRef.current.shift();
        if (currentRef.current) historyRef.current.push(currentRef.current);
        setFeedStatus('ready');
        if (next) {
            void playSong(next);
            refreshQueueView();
            void topUpQueue(); // 选歌丢弃了之前的队列，后台补足（完成后追加到列表尾部）
        }
        closeDrawer();
    };

    const isVipOnly = (song: UnifiedSong): boolean => {
        const ref = song.sourceRef;
        return ref?.kind === 'online' && ref?.providerData?.qishuiVipOnly === true;
    };

    // 返回键关闭播放列表侧滑窗：打开时注册返回处理器（走收起动画），关闭即注销。
    useEffect(() => {
        if (!drawerOpen) return;
        return registerBackHandler(() => {
            closeDrawer();
            return true;
        });
    }, [drawerOpen]);

    const title = current?.name ?? '';
    const artistName = current ? current.artists.map((a) => a.name).join(' / ') : '';
    const coverUrl = current?.album?.coverUrl ?? null;
    const lyricMotion = useSettingsStore((s) => s.lyricMotion);
    // 徽章：VIP 限定（曲库 label_info）+ 实际播放音质档（降档后）；无数据时依次回退曲库最高档、隐藏。
    const sourceRef = current?.sourceRef;
    const songData = (sourceRef?.kind === 'online' ? sourceRef.providerData : undefined)
        ?? {} as { qishuiQuality?: string; qishuiVipOnly?: boolean };
    const vipOnly = songData.qishuiVipOnly === true;
    const qualityStamp = typeof actualQuality === 'string' && actualQuality
        ? actualQuality
        : (typeof songData.qishuiQuality === 'string' ? songData.qishuiQuality : '');
    const qualityText = qualityLabel(qualityStamp);
    const qualityTone = qualityStamp ? (QUALITY_TONE[qualityStamp] ?? '') : '';
    // 快照态（视图 ≠ audio 归属）：界面显示视图会话自己的暂停快照——播放中=否，
    // 进度/时长取会话缓存；内容型状态已由 applyViewSession 从会话缓存同步。
    const snapshotMode = viewSession !== activeSession;
    const viewSessionData = sessionOf(viewSession);
    const displayedPlaying = snapshotMode ? false : playing;
    const displayedTime = snapshotMode ? (viewSessionData?.pausedTime ?? 0) : currentTime;
    const displayedDuration = snapshotMode ? (viewSessionData?.duration ?? 0) : duration;
    const progress = displayedDuration > 0 ? (displayedTime / displayedDuration) * 100 : 0;

    // 双元素事件工厂：UI 落渲染层仅当视图正显示该会话；pausedTime/duration 持续写回各自
    // 会话缓存（后台元素暂停后冻结在暂停点，快照显示永远与元素一致）。互斥兜底：playing
    // 事件里发现另一元素还在响就暂停它（正常流程 playSessionAudio 已先行暂停）。
    // ended 只由活动会话推进队列——后台元素暂停中不会自然播完。
    // onPlaying 才解冻歌词：play 事件在 play() 调用瞬间即触发（src 仍在加载），若据此解冻，
    // 轨道会在加载期按墙钟空跑、开播后漂移重建重跑一遍；加载/缓冲期（waiting）保持冻结。
    const audioHandlers = (s: 'fm' | 'playlist') => ({
        onPlaying: () => {
            const other = audioOf(s === 'fm' ? 'playlist' : 'fm');
            if (other && !other.paused) other.pause();
            if (viewSessionRef.current === s) setPlaying(true);
        },
        onWaiting: () => { if (viewSessionRef.current === s) setPlaying(false); },
        onPause: () => { if (viewSessionRef.current === s) setPlaying(false); },
        onTimeUpdate: (e: SyntheticEvent<HTMLAudioElement>) => {
            const session = sessionOf(s);
            if (session) session.pausedTime = e.currentTarget.currentTime;
            if (viewSessionRef.current === s) setCurrentTime(e.currentTarget.currentTime);
        },
        onSeeked: () => { if (viewSessionRef.current === s) scheduleSeekRealign(); },
        onLoadedMetadata: (e: SyntheticEvent<HTMLAudioElement>) => {
            const session = sessionOf(s);
            if (session) session.duration = e.currentTarget.duration;
            if (viewSessionRef.current === s) setDuration(e.currentTarget.duration);
        },
        onError: (e: SyntheticEvent<HTMLAudioElement>) => {
            // 装载失败即作废「元素已装载本会话曲」标记；打 console（logcat 可见）便于 TV 排障。
            loadedSongRef.current[s] = null;
            const err = e.currentTarget.error;
            console.warn(`[solis] audio(${s}) error: code=${err?.code ?? '?'} msg=${err?.message ?? ''} src=${e.currentTarget.currentSrc.slice(0, 120)}`);
        },
        onEnded: () => { if (activeSessionRef.current === s) playNext(true); },
    });

    return (
        <div className="player-screen" data-mode={mode}>
            {/* 挂在组件内的两个隐藏 audio（FM/歌单各一）：切选项卡（组件复用）播放不中断。 */}
            {/* data-seek-active 仅标记非快照态的活动会话元素——长按快进快退桥据此选元素；
                快照态两元素都不标记，桥不介入（不作用于看不见的后台歌曲）。 */}
            <audio ref={fmAudioRef} preload="metadata"
                data-seek-active={!snapshotMode && activeSession === 'fm' ? 'true' : undefined}
                {...audioHandlers('fm')} />
            <audio ref={plAudioRef} preload="metadata"
                data-seek-active={!snapshotMode && activeSession === 'playlist' ? 'true' : undefined}
                {...audioHandlers('playlist')} />

            <div className="player-main">
                <section className="player-left">
                    {/* 封面纯展示：不进焦点导航、无点击行为，播放/暂停由控制按钮组承担。 */}
                    <div className="player-cover">
                        {coverUrl && <img className="player-cover-img" src={coverUrl} alt="" />}
                    </div>
                    <div className="player-title-row">
                        <div className="player-title-viewport" ref={titleViewportRef}>
                            <span ref={titleTextRef}
                                className={`player-title-text${titleOverflow > 0 ? ' scrolling' : ''}`}
                                style={titleOverflow > 0
                                    ? ({
                                        '--marquee-distance': `${titleOverflow}px`,
                                        '--marquee-duration': `${Math.max(6, titleOverflow / 40)}s`,
                                    } as CSSProperties)
                                    : undefined}>
                                {title}
                            </span>
                        </div>
                        <div className="player-stamps">
                            {qualityText && (
                                <span className={`stamp stamp-quality${qualityTone ? ` ${qualityTone}` : ''}`}>{qualityText}</span>
                            )}
                            {vipOnly && <span className="stamp stamp-vip">VIP</span>}
                        </div>
                    </div>
                    <p className="player-artist">{artistName}</p>
                    {/* 控制按钮组：左右移动在组内循环；上下进入本组落播放按钮（组默认）。
                        上一曲/下一曲短按切歌（onClick），长按走 remoteKeys seek 桥快进快退。
                        浮窗模式按上键经 data-group-up 直达顶栏开关按钮（正常模式目标隐藏，自动回退几何导航）。 */}
                    <div className="player-controls" data-focus-loop="true" data-focus-group="true"
                        data-group-up=".sheet-toggle-btn">
                        <button type="button" className="player-ctrl-btn" data-seek="-10"
                            onClick={playPrev}
                            title="上一曲（长按快退）" aria-label="上一曲">
                            <SkipBack size={36} strokeWidth={1.8} />
                        </button>
                        <button type="button" className="player-ctrl-btn" data-player-primary="true"
                            onClick={togglePlay}
                            title={displayedPlaying ? '暂停' : '播放'} aria-label={displayedPlaying ? '暂停' : '播放'}>
                            {displayedPlaying
                                ? <Pause size={48} strokeWidth={1.8} />
                                : <Play size={48} strokeWidth={1.8} />}
                        </button>
                        <button type="button" className="player-ctrl-btn" data-seek="10"
                            onClick={() => playNext()}
                            title="下一曲（长按快进）" aria-label="下一曲">
                            <SkipForward size={36} strokeWidth={1.8} />
                        </button>
                    </div>
                </section>
                <section className="player-lyrics">
                    {feedStatus !== 'ready' && !current
                        ? <p className="player-lyrics-empty">{feedMessage}</p>
                        : <LyricView lines={lyricLines} time={displayedTime}
                            motion={lyricMotion} playing={displayedPlaying} seekEpoch={seekEpoch}
                            railKey={`${current?.id ?? 'none'}:${seekEpoch}`}
                            onDrift={handleLyricDrift} />}
                </section>
            </div>
            <div className="player-bottom">
                {/* 收藏/列表组：左右移动在组内循环；上下进入本组落收藏（组默认第一个成员）。 */}
                <div className="player-actions" data-focus-loop="true" data-focus-group="true">
                    {/* 收藏：已收藏=实心红心（官方「我喜欢的音乐」歌单），点击切换并同步汽水服务端。 */}
                    <button type="button" className="player-action-btn" title="收藏" aria-label="收藏"
                        onClick={() => { void toggleLiked(); }}>
                        <Heart size={28} strokeWidth={1.8}
                            fill={liked ? '#ef4444' : 'none'}
                            color={liked ? '#ef4444' : undefined} />
                    </button>
                    <button type="button" className="player-action-btn" title="播放列表" aria-label="播放列表"
                        onClick={openDrawer}>
                        <ListMusic size={28} strokeWidth={1.8} />
                    </button>
                </div>
                <div className="player-progress">
                    <span className="progress-time">{formatTime(displayedTime)}</span>
                    {/* 点击进度条跳播：页面根有 CSS zoom 缩放，rect 是布局坐标，clientX 是视口坐标，
                        需除以 zoom 统一坐标系后算比例。快照态只更新视图会话的暂停进度，不碰后台 audio。 */}
                    <div className="progress-track"
                        onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const docRect = document.documentElement.getBoundingClientRect();
                            const zoom = docRect.width > 0 ? window.innerWidth / docRect.width : 1;
                            const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left * zoom) / (rect.width * zoom)));
                            if (snapshotMode) {
                                if (viewSessionData && displayedDuration > 0) {
                                    viewSessionData.pausedTime = ratio * displayedDuration;
                                    setCurrentTime(viewSessionData.pausedTime); // 触发重渲染以刷新快照显示
                                }
                                return;
                            }
                            const audio = audioOf(activeSessionRef.current);
                            if (!audio || !Number.isFinite(duration) || duration <= 0) return;
                            audio.currentTime = ratio * duration;
                        }}>
                        <div className="progress-fill" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="progress-time">{formatTime(displayedDuration)}</span>
                </div>
            </div>

            {/* 播放列表侧滑窗：左侧滑出，遮罩锁定主页操作，关闭反向收起动画。 */}
            <div className={`drawer-mask${drawerOpen ? ' show' : ''}`} onClick={closeDrawer} />
            <aside className={`playlist-drawer${drawerOpen ? (drawerClosing ? ' closing' : ' open') : ''}`}
                data-focus-trap={drawerOpen && !drawerClosing ? 'true' : undefined}
                aria-hidden={!drawerOpen}>
                <div className="drawer-title-block">
                    <p className="drawer-title-eyebrow">Playlist</p>
                    <p className="drawer-title-main">播放列表</p>
                    <div className="drawer-title-line" />
                </div>
                {queueView.length === 0
                    ? <p className="playlist-drawer-empty">列表为空</p>
                    : queueView.map((song) => (
                        <button key={song.id} type="button"
                            className={`playlist-item${song === current ? ' playing' : ''}`}
                            onClick={() => playFromQueue(queueView.indexOf(song))}>
                            <img className="playlist-cover" src={song.album?.coverUrl ?? ''} alt="" />
                            <span className="playlist-meta">
                                <span className="playlist-name">{song.name}</span>
                                <span className="playlist-artist">{song.artists.map((a) => a.name).join(' / ')}</span>
                            </span>
                            {isVipOnly(song) && <span className="stamp stamp-vip">VIP</span>}
                        </button>
                    ))}
            </aside>
        </div>
    );
}
