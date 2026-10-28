import { useEffect, useRef, useState } from 'react';
import {
    CACHE_LIMITS, PLAYLIST_SIZES, QUALITY_OPTIONS, SEEK_RATES,
    useSettingsStore, type CacheLimitGB, type PlaylistSize, type SeekRate,
} from '../stores/settingsStore';
import type { AudioQualityPreference } from '../types/onlineMusic';
import { clearCachedSongs, formatBytes, getCachedSongs } from '../utils/songCache';
import { registerBackHandler } from '../utils/backStack';

// src/screens/SettingsDialog.tsx — TV 设置页（右侧侧滑，版式与播放列表侧滑窗一致）。
// 板块：长按快进/快退速率、优先音质、播放列表预取数量、播放歌曲自动缓存（开关/容量/清空）。
// 打开时遮罩锁定主页、焦点落当前挡位；关闭走与滑入反向的收起动画；返回键同 X 关闭。

const CLOSE_ANIM_MS = 260;

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
    const seekRate = useSettingsStore((s) => s.seekRate);
    const setSeekRate = useSettingsStore((s) => s.setSeekRate);
    const preferredQuality = useSettingsStore((s) => s.preferredQuality);
    const setPreferredQuality = useSettingsStore((s) => s.setPreferredQuality);
    const playlistSize = useSettingsStore((s) => s.playlistSize);
    const setPlaylistSize = useSettingsStore((s) => s.setPlaylistSize);
    const autoCache = useSettingsStore((s) => s.autoCache);
    const setAutoCache = useSettingsStore((s) => s.setAutoCache);
    const cacheLimit = useSettingsStore((s) => s.cacheLimit);
    const setCacheLimit = useSettingsStore((s) => s.setCacheLimit);
    const lyricMotion = useSettingsStore((s) => s.lyricMotion);
    const setLyricMotion = useSettingsStore((s) => s.setLyricMotion);
    const dialogRef = useRef<HTMLDivElement>(null);
    // 缓存占用与曲目数：打开面板时统计，清空后刷新。
    const [usage, setUsage] = useState<{ bytes: number; count: number } | null>(null);
    // 关闭走收起动画：先标记 closing 播放反向滑出，动画结束后回调卸载。
    const [closing, setClosing] = useState(false);

    const closeWithAnim = () => {
        if (closing) return;
        setClosing(true);
        window.setTimeout(onClose, CLOSE_ANIM_MS);
    };

    // 返回键关闭设置页（走动画）；HomeScreen 对 settings 弹层不注册返回处理器，由本层接管。
    useEffect(() => {
        if (closing) return;
        return registerBackHandler(() => {
            closeWithAnim();
            return true;
        });
    }, [closing]);

    const refreshUsage = async () => {
        try {
            const records = await getCachedSongs();
            setUsage({ bytes: records.reduce((sum, rec) => sum + (rec.byteSize || 0), 0), count: records.length });
        } catch {
            setUsage({ bytes: 0, count: 0 });
        }
    };

    // 打开即聚焦卡片容器（焦点陷阱生效），方向键首步落当前挡位；同时统计缓存占用。
    useEffect(() => {
        dialogRef.current?.focus();
        void refreshUsage();
    }, []);

    return (
        <>
            <div className={`drawer-mask${closing ? '' : ' show'}`} onClick={closeWithAnim} />
            <div className={`settings-drawer${closing ? ' closing' : ' open'}`}
                ref={dialogRef} tabIndex={-1} data-focus-trap="true">
            <div className="drawer-title-block">
                <p className="drawer-title-eyebrow">Settings</p>
                <p className="drawer-title-main">设置</p>
                <div className="drawer-title-line" />
            </div>

            <div className="settings-section">
                <p className="settings-label">长按快进 / 快退速率</p>
                <p className="settings-hint">按住上一曲 / 下一曲时，每按住 1 秒进度条变化的秒数</p>
                <div className="settings-options" data-focus-loop="true" data-focus-group="true" data-group-first="true">
                    {SEEK_RATES.map((rate: SeekRate) => (
                        <button key={rate} type="button"
                            className={`settings-option${seekRate === rate ? ' active' : ''}`}
                            data-default-focus={seekRate === rate ? 'true' : undefined}
                            onClick={() => setSeekRate(rate)}>
                            {rate} 秒
                        </button>
                    ))}
                </div>
            </div>

            <div className="settings-section">
                <p className="settings-label">优先音质</p>
                <p className="settings-hint">优先取得该音质，歌曲不提供该档时自动降档取可用最高</p>
                <div className="settings-options" data-focus-loop="true" data-focus-group="true" data-group-first="true">
                    {QUALITY_OPTIONS.map((option) => (
                        <button key={option.value} type="button"
                            className={`settings-option${preferredQuality === option.value ? ' active' : ''}`}
                            onClick={() => setPreferredQuality(option.value as AudioQualityPreference)}>
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="settings-section">
                <p className="settings-label">歌词动效</p>
                <p className="settings-hint">开启后歌词整句切换与逐字染色带动效，关闭为标准逐字高亮</p>
                <div className="settings-options" data-focus-loop="true" data-focus-group="true" data-group-first="true">
                    <button type="button"
                        className={`settings-option${lyricMotion ? ' active' : ''}`}
                        onClick={() => setLyricMotion(!lyricMotion)}>
                        {lyricMotion ? '已开启' : '已关闭'}
                    </button>
                </div>
            </div>

            <div className="settings-section">
                <p className="settings-label">播放列表数量</p>
                <p className="settings-hint">播放列表内自动保持的歌曲数量，不足时后台自动补足</p>
                <div className="settings-options" data-focus-loop="true" data-focus-group="true" data-group-first="true">
                    {PLAYLIST_SIZES.map((size: PlaylistSize) => (
                        <button key={size} type="button"
                            className={`settings-option${playlistSize === size ? ' active' : ''}`}
                            onClick={() => setPlaylistSize(size)}>
                            {size} 首
                        </button>
                    ))}
                </div>
            </div>

            <div className="settings-section">
                <p className="settings-label">自动缓存播放过的歌曲</p>
                <p className="settings-hint">后台缓存封面、歌词与歌曲信息；容量满后停止缓存，可手动清空</p>
                <div className="settings-options" data-focus-loop="true" data-focus-group="true" data-group-first="true">
                    <button type="button"
                        className={`settings-option${autoCache ? ' active' : ''}`}
                        onClick={() => setAutoCache(!autoCache)}>
                        {autoCache ? '已开启' : '已关闭'}
                    </button>
                </div>
                <p className="settings-label">缓存大小上限</p>
                <div className="settings-options" data-focus-loop="true" data-focus-group="true" data-group-first="true">
                    {CACHE_LIMITS.map((limit: CacheLimitGB) => (
                        <button key={limit} type="button"
                            className={`settings-option${cacheLimit === limit ? ' active' : ''}`}
                            onClick={() => setCacheLimit(limit)}>
                            {limit} GB
                        </button>
                    ))}
                </div>
                <div className="settings-cache-row">
                    <span className="settings-hint">
                        已缓存 {usage ? `${usage.count} 首（${usage.bytes > 0 ? formatBytes(usage.bytes) : '0 KB'}）` : '…'}
                        {cacheLimit > 0 ? ` / 上限 ${cacheLimit} GB` : ''}
                    </span>
                    <button type="button" className="settings-option"
                        onClick={() => { void clearCachedSongs().then(refreshUsage); }}>
                        清空缓存
                    </button>
                </div>
            </div>
            </div>
        </>
    );
}
