import { useEffect, useRef, useState } from 'react';
import { Heart, Music2 } from 'lucide-react';
import type { ProviderUser } from '../types/onlineMusic';
import type { UnifiedSong } from '../types';
import { qishuiProvider } from '../services/onlineMusic/qishuiProvider';
import { registerBackHandler } from '../utils/backStack';

// src/screens/MineScreen.tsx — 「我的」页：两个特殊歌单入口卡。
// 「我喜欢的」「抖音收藏的音乐」来自 /me/playlists（API 数量/封面），卡片背景=首曲歌单封面
// 裁剪铺满 + 中央 lucide 线条图标 + 名称·数量；点击进入歌单曲目面板（版式与播放列表侧滑窗
// 一致：粘性标题块 + 条目缩放焦点），点歌经 solis:play-queue 事件交给播放页接管播放。

interface SpecialCard {
    id: string;
    label: string;
    /** 面板标题上方的小号英文斜体装饰文案。 */
    eyebrow: string;
    count?: number;
    cover: string;
    icon: 'heart' | 'music-2';
}

/** 两个固定入口：按歌单名匹配 /me/playlists 返回。 */
const CARD_SPECS = [
    { match: '我喜欢的音乐', label: '我喜欢的', eyebrow: 'Favorite Playlist', icon: 'heart' },
    { match: '抖音收藏的音乐', label: '抖音收藏的音乐', eyebrow: 'Saved Playlists', icon: 'music-2' },
] as const;

const PAGE_SIZE = 30;

export default function MineScreen({ user }: {
    user: ProviderUser | null;
}) {
    const [cards, setCards] = useState<SpecialCard[] | null>(null);
    const [error, setError] = useState('');
    // 歌单面板：打开的歌单 + 曲目分页（焦点临近底部自动续拉）。
    const [openCard, setOpenCard] = useState<SpecialCard | null>(null);
    const [tracks, setTracks] = useState<UnifiedSong[]>([]);
    const [tracksLoading, setTracksLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const openCardRef = useRef<SpecialCard | null>(null);
    useEffect(() => { openCardRef.current = openCard; }, [openCard]);
    // 面板收起动画期间保持挂载（滑回右侧播完再卸载）。
    const [panelClosing, setPanelClosing] = useState(false);
    // 面板打开后待首批曲目落焦点标记。
    const pendingFocusRef = useRef(false);

    // 登录态变化时拉取我的歌单，按固定名称挑出两个特殊入口。
    useEffect(() => {
        if (!user) {
            setCards(null);
            setError('');
            return;
        }
        let disposed = false;
        setError('');
        qishuiProvider.library?.getUserPlaylists(user.id, 50, 0)
            .then((page) => {
                if (disposed) return;
                const items = page.items ?? [];
                const found: SpecialCard[] = [];
                for (const spec of CARD_SPECS) {
                    const hit = items.find((c) => c.name === spec.match);
                    if (hit) {
                        found.push({
                            id: String(hit.id),
                            label: spec.label,
                            eyebrow: spec.eyebrow,
                            count: hit.trackCount,
                            cover: hit.coverUrl ?? '',
                            icon: spec.icon,
                        });
                    }
                }
                setCards(found);
            })
            .catch((e) => {
                if (!disposed) {
                    setError((e as { code?: string }).code === 'auth-required'
                        ? '请先登录汽水账号（右上角头像扫码登录）'
                        : '歌单加载失败，请稍后重试');
                }
            });
        return () => { disposed = true; };
    }, [user]);

    const loadTracks = async (card: SpecialCard, offset: number, append: boolean) => {
        if (append) setLoadingMore(true);
        else setTracksLoading(true);
        try {
            const page = await qishuiProvider.catalog?.getPlaylistTracks?.(card.id, PAGE_SIZE, offset);
            if (openCardRef.current?.id !== card.id) return; // 期间已切走
            const items = page?.items ?? [];
            setTracks((prev) => (append ? [...prev, ...items] : items));
            setHasMore(Boolean(page?.hasMore));
        } catch { /* 拉取失败保持当前列表 */ }
        finally {
            setTracksLoading(false);
            setLoadingMore(false);
        }
    };

    const openPlaylist = (card: SpecialCard) => {
        setOpenCard(card);
        setTracks([]);
        setHasMore(false);
        pendingFocusRef.current = true;
        void loadTracks(card, 0, false);
    };

    // 面板首批曲目到位后焦点落第一首歌（遥控器直接可上下选择）。
    useEffect(() => {
        if (!openCard || tracksLoading || tracks.length === 0 || !pendingFocusRef.current) return;
        pendingFocusRef.current = false;
        document.querySelector<HTMLElement>('.mine-panel .playlist-item')?.focus();
    }, [openCard, tracksLoading, tracks]);

    const loadMore = () => {
        const card = openCardRef.current;
        if (!card || loadingMore || tracksLoading || !hasMore) return;
        void loadTracks(card, tracks.length, true);
    };

    // 关面板：先播收起动画（滑回右侧）再卸载，焦点回入口卡。
    const closePanel = () => {
        if (panelClosing) return;
        const cardEl = document.getElementById(`mine-card-${openCardRef.current?.id}`);
        setPanelClosing(true);
        window.setTimeout(() => {
            setOpenCard(null);
            setPanelClosing(false);
            requestAnimationFrame(() => cardEl?.focus());
        }, 260); // 与 mine-panel-out 动画时长对齐
    };

    // 点歌：整张歌单交播放页接管（solis:play-queue），歌单浮窗播放器随之滑出（HomeScreen 监听）。
    // 留在「我的」页不切回播放页；面板静默收起，焦点留给浮窗播放按钮。
    const playSongAt = (index: number) => {
        if (!tracks[index] || panelClosing) return;
        window.dispatchEvent(new CustomEvent('solis:play-queue', { detail: { songs: tracks, index } }));
        setPanelClosing(true);
        window.setTimeout(() => {
            setOpenCard(null);
            setPanelClosing(false);
        }, 260); // 与 mine-panel-out 动画时长对齐
    };

    // 返回键关闭歌单面板。
    useEffect(() => {
        if (!openCard) return;
        return registerBackHandler(() => {
            closePanel();
            return true;
        });
    }, [openCard]);

    const isVipOnly = (song: UnifiedSong): boolean => {
        const ref = song.sourceRef;
        return ref?.kind === 'online' && ref?.providerData?.qishuiVipOnly === true;
    };

    return (
        <div className="mine-wrap">
            {cards === null && !error && (
                <p className="home-placeholder">{user ? '正在加载歌单…' : '登录后可查看我喜欢的与抖音收藏的音乐'}</p>
            )}
            {error && <p className="home-placeholder">{error}</p>}
            {cards !== null && cards.length === 0 && <p className="home-placeholder">暂未找到对应的歌单</p>}
            {cards !== null && cards.length > 0 && (
                <div className="mine-cards"
                    data-focus-group="true" data-focus-loop="true"
                    data-group-up=".tab-btn.active">
                    {cards.map((card) => (
                        <button key={card.id} id={`mine-card-${card.id}`} type="button"
                            className="mine-card"
                            style={card.cover ? { backgroundImage: `url("${card.cover}")` } : undefined}
                            onClick={() => openPlaylist(card)}>
                            <span className="mine-card-shade" aria-hidden />
                            <span className="mine-card-body">
                                {card.icon === 'heart'
                                    ? <Heart size={44} strokeWidth={1.8} />
                                    : <Music2 size={44} strokeWidth={1.8} />}
                                <span className="mine-card-name">{card.label}</span>
                                <span className="mine-card-count">{card.count ?? 0} 首</span>
                            </span>
                        </button>
                    ))}
                </div>
            )}

            {/* 蒙版：锁定未覆盖区域操作，点击关闭（与播放列表侧滑窗一致）。 */}
            {openCard && (
                <div className="drawer-mask show" onClick={closePanel} />
            )}

            {openCard && (
                <div className={`mine-panel${panelClosing ? ' closing' : ''}`} data-focus-trap="true">
                    <div className="drawer-title-block">
                        <p className="drawer-title-eyebrow">{openCard.eyebrow}</p>
                        <h2 className="drawer-title-main">{openCard.label}</h2>
                        <div className="drawer-title-line" />
                    </div>
                    {tracksLoading && <p className="home-placeholder">正在加载歌曲…</p>}
                    {!tracksLoading && tracks.length === 0 && <p className="home-placeholder">歌单暂无歌曲</p>}
                    {tracks.map((song, index) => (
                        <button key={`${song.id}-${index}`} type="button" className="playlist-item"
                            onClick={() => playSongAt(index)}
                            onFocus={() => { if (index >= tracks.length - 3) loadMore(); }}>
                            {song.album?.coverUrl
                                ? <img className="playlist-cover" src={song.album.coverUrl} alt="" />
                                : <span className="playlist-cover" />}
                            <span className="playlist-meta">
                                <span className="playlist-name">{song.name}</span>
                                <span className="playlist-artist">{song.artists.map((a) => a.name).join(' / ')}</span>
                            </span>
                            {isVipOnly(song) && <span className="stamp stamp-vip">VIP</span>}
                        </button>
                    ))}
                    {loadingMore && <p className="home-placeholder">加载更多…</p>}
                </div>
            )}
        </div>
    );
}
