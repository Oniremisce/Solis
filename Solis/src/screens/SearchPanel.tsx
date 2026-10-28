import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { qishuiProvider } from '../services/onlineMusic/qishuiProvider';
import type { UnifiedSong } from '../types';
import { registerBackHandler } from '../utils/backStack';

// src/screens/SearchPanel.tsx — 搜索侧滑面板（右侧滑出，宽度半屏，版式与设置页一致）。
// 面板标题右侧搜索框：打开即聚焦拉起 IME，回车或点搜索按钮执行搜索；
// 结果复用歌单面板条目样式（封面/歌名/歌手/VIP），点击以整个结果列表接管播放
// （solis:play-queue → 歌单浮窗播放器滑出），面板随之收起。

const CLOSE_ANIM_MS = 260;
const PAGE_SIZE = 30;

export default function SearchPanel({ onClose }: { onClose: () => void }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<UnifiedSong[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState('');
    const [closing, setClosing] = useState(false);

    const closeWithAnim = () => {
        if (closing) return;
        setClosing(true);
        window.setTimeout(onClose, CLOSE_ANIM_MS);
    };

    // 返回键关闭面板（走收起动画）。
    useEffect(() => {
        if (closing) return;
        return registerBackHandler(() => {
            closeWithAnim();
            return true;
        });
    }, [closing]);

    // 打开即聚焦搜索框（TV 上拉起系统 IME）。
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const runSearch = async (fresh: boolean, base?: UnifiedSong[]) => {
        const q = query.trim();
        if (!q) return;
        const offset = fresh ? 0 : (base?.length ?? 0);
        if (fresh) setSearching(true);
        else setLoadingMore(true);
        setError('');
        try {
            const page = await qishuiProvider.search!.searchSongs(q, PAGE_SIZE, offset);
            const songs = page.items;
            setResults(fresh ? songs : [...(base ?? []), ...songs]);
            setHasMore(page.hasMore);
        } catch {
            setError('搜索失败，请稍后重试');
            if (fresh) setResults([]);
        } finally {
            setSearching(false);
            setLoadingMore(false);
        }
    };

    const onSubmit = (e: FormEvent) => {
        e.preventDefault();
        void runSearch(true);
    };

    // 点歌：整张结果列表交播放器接管（浮窗滑出），面板收起。
    const playSongAt = (index: number) => {
        if (!results?.[index] || closing) return;
        window.dispatchEvent(new CustomEvent('solis:play-queue', { detail: { songs: results, index } }));
        closeWithAnim();
    };

    const isVipOnly = (song: UnifiedSong): boolean => {
        const ref = song.sourceRef;
        return ref?.kind === 'online' && ref?.providerData?.qishuiVipOnly === true;
    };

    return (
        <>
            <div className={`drawer-mask${closing ? '' : ' show'}`} onClick={closeWithAnim} />
            <div className={`search-drawer${closing ? ' closing' : ' open'}`} data-focus-trap="true">
                {/* 标题行：左侧标题组，右侧搜索框（打开即聚焦）。 */}
                <div className="drawer-title-block search-title-row">
                    <div className="search-title-text">
                        <p className="drawer-title-eyebrow">Search</p>
                        <h2 className="drawer-title-main">搜索</h2>
                        <div className="drawer-title-line" />
                    </div>
                    <form className="search-box" onSubmit={onSubmit}>
                        <input ref={inputRef} className="search-input" type="text"
                            placeholder="搜索歌曲 / 歌手" value={query}
                            onChange={(e) => setQuery(e.target.value)} />
                        <button type="submit" className="icon-btn" title="搜索" aria-label="搜索">
                            <Search size={28} strokeWidth={1.8} />
                        </button>
                    </form>
                </div>

                {searching && <p className="home-placeholder">正在搜索…</p>}
                {error && <p className="home-placeholder">{error}</p>}
                {results !== null && !searching && results.length === 0 && !error && (
                    <p className="home-placeholder">没有找到相关歌曲</p>
                )}
                {results?.map((song, index) => (
                    <button key={`${song.id}-${index}`} type="button" className="playlist-item"
                        onClick={() => playSongAt(index)}
                        onFocus={() => { if (index >= results.length - 3 && hasMore && !loadingMore) void runSearch(false, results); }}>
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
        </>
    );
}
