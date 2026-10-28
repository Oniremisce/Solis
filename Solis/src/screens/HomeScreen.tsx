import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, Settings, User } from 'lucide-react';
import type { ProviderUser } from '../types/onlineMusic';
import { qishuiProvider } from '../services/onlineMusic/qishuiProvider';
import LoginDialog from './LoginDialog';
import UserDialog from './UserDialog';
import SettingsDialog from './SettingsDialog';
import SearchPanel from './SearchPanel';
import PlayerScreen, { type PlayerMode } from './PlayerScreen';
import MineScreen from './MineScreen';
import { registerBackHandler } from '../utils/backStack';

// src/screens/HomeScreen.tsx — Solis TV 主页骨架。
// 顶栏（品牌名 + 搜索/设置/头像）+ 4 选项卡（默认/熟悉/新鲜模式 + 我的）。
// 未登录点头像弹扫码弹框；已登录点头像弹用户信息面板；设置图标弹设置面板。
// 顶栏图标与选项卡均为焦点组：左右组内循环，上下进入落组默认位置。
// 内置图标统一使用 lucide-react。

const TABS = [
    { id: 'default', label: '默认模式' },
    { id: 'familiar', label: '熟悉模式' },
    { id: 'explore', label: '新鲜模式' },
    { id: 'mine', label: '我的' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function HomeScreen() {
    const [user, setUser] = useState<ProviderUser | null>(null);
    const [activeTab, setActiveTab] = useState<TabId>('default');
    const [dialog, setDialog] = useState<null | 'login' | 'user' | 'settings' | 'search'>(null);
    // 播放页模式：跟随最近一次激活的音乐模式选项卡；切到「我的」时保持不变（播放不中断）。
    // 切换 FM 模式选项卡会改变 mode，由 PlayerScreen 的 mode effect 重拉新流（显式选流=显式播放）。
    const [playerMode, setPlayerMode] = useState<PlayerMode>('default');
    useEffect(() => {
        if (activeTab !== 'mine') setPlayerMode(activeTab);
    }, [activeTab]);

    // 歌单浮窗播放器：点歌（「我的」页歌单/搜索结果，solis:play-queue）即全屏滑出播放页本体
    // （UI 与三模式完全一致）并自动替换浮窗内容开播；收起先播下滑动画再恢复原界面，
    // 焦点落回当前激活选项卡。开/合都通知 PlayerScreen（solis:playlist-sheet）——只切显示视图：
    // 展开=视图切到歌单会话（audio 若在 FM 同时切到歌单续播）；收起=视图切回 FM 显示其暂停
    // 快照，歌单歌曲继续后台播放（audio 归还 FM 由 FM 界面的播放键/切歌/切模式显式触发）。
    const [sheetOpen, setSheetOpen] = useState(false);
    const [sheetClosing, setSheetClosing] = useState(false);
    useEffect(() => {
        const onPlayQueue = () => {
            setSheetOpen(true);
            window.dispatchEvent(new CustomEvent('solis:playlist-sheet', { detail: { open: true } }));
        };
        window.addEventListener('solis:play-queue', onPlayQueue);
        return () => window.removeEventListener('solis:play-queue', onPlayQueue);
    }, []);
    const closeSheet = useCallback(() => {
        if (sheetClosing) return;
        setSheetClosing(true);
        window.dispatchEvent(new CustomEvent('solis:playlist-sheet', { detail: { open: false } }));
        window.setTimeout(() => {
            setSheetOpen(false);
            setSheetClosing(false);
            requestAnimationFrame(() => {
                document.querySelector<HTMLElement>('.tab-btn.active')?.focus();
            });
        }, 260); // 与 sheet-down 动画时长对齐
    }, [sheetClosing]);
    // 浮窗活跃期（含收起动画中）：覆盖层显示、被盖区域 inert。
    const sheetActive = sheetOpen || sheetClosing;

    // 歌单播放会话（浮窗关了但歌单队列仍在）：顶栏显示打开浮窗按钮。
    // 会话结束（歌单播完续接 FM）：浮窗若开着则随之收起。
    const [playlistSession, setPlaylistSession] = useState(false);
    const sheetActiveRef = useRef(false);
    useEffect(() => { sheetActiveRef.current = sheetActive; }, [sheetActive]);
    useEffect(() => {
        const onSession = (e: Event) => {
            const active = Boolean((e as CustomEvent<{ active?: boolean }>).detail?.active);
            setPlaylistSession(active);
            if (!active && sheetActiveRef.current) closeSheet();
        };
        window.addEventListener('solis:playlist-session', onSession);
        return () => window.removeEventListener('solis:playlist-session', onSession);
    }, [closeSheet]);

    // 浮窗开关：开→收起（滑下），关且会话中→打开（滑上）。仅会话期间按钮可见。
    const toggleSheet = useCallback(() => {
        if (sheetActive) closeSheet();
        else {
            setSheetOpen(true);
            window.dispatchEvent(new CustomEvent('solis:playlist-sheet', { detail: { open: true } }));
        }
    }, [sheetActive, closeSheet]);

    // 浮窗打开期间返回键 = 收起浮窗。
    useEffect(() => {
        if (!sheetOpen || sheetClosing) return;
        return registerBackHandler(() => {
            closeSheet();
            return true;
        });
    }, [sheetOpen, sheetClosing, closeSheet]);

    // 浮窗打开后焦点落播放按钮（与播放页「选项卡确认后落播放按钮」规则一致）。
    useEffect(() => {
        if (!sheetOpen || sheetClosing) return;
        const timer = window.setTimeout(() => {
            document.querySelector<HTMLElement>('.player-host [data-player-primary]')?.focus();
        }, 270); // 等滑入动画完成后落焦
        return () => window.clearTimeout(timer);
    }, [sheetOpen, sheetClosing]);

    // 返回键关闭当前弹窗（登录/账号）：有浮窗时注册返回处理器，关闭即注销。
    // 设置页为右侧侧滑层，自带关闭动画与返回处理，这里不接管（避免双 handler 抢先消费）。
    useEffect(() => {
        if (!dialog || dialog === 'settings') return;
        return registerBackHandler(() => {
            setDialog(null);
            return true;
        });
    }, [dialog]);

    // 启动查一次本地会话：有登录态直接亮出头像；失败静默按未登录处理。
    useEffect(() => {
        let disposed = false;
        qishuiProvider.auth!.getLoginStatus()
            .then((u) => { if (!disposed) setUser(u); })
            .catch(() => { /* 服务不可达/未配置：保持未登录态 */ });
        return () => { disposed = true; };
    }, []);

    const handleLoggedIn = useCallback((u: ProviderUser) => {
        setUser(u);
        setDialog(null);
    }, []);

    const handleLogout = useCallback(() => {
        setUser(null);
        setDialog(null);
    }, []);

    const onAvatarClick = () => setDialog(user ? 'user' : 'login');

    // OK 确认选项卡后焦点直接置于播放页的播放/暂停按钮（「我的」无播放页则跳过）。
    // 切选项卡不改变 audio 归属：后台歌单/搜索歌曲继续播，FM 界面只显示自己的暂停快照。
    const onTabClick = (id: TabId) => {
        setActiveTab(id);
        if (id !== 'mine') {
            document.querySelector<HTMLElement>('.player-ctrl-btn[data-player-primary]')?.focus();
        }
    };

    return (
        <div className="home-screen">
            {/* 浮窗全屏覆盖期间：选项卡/「我的」页标记 inert（不可聚焦不可点），
                防止空间导航把焦点跳进被盖住的不可见元素；顶栏在浮窗外保持可操作。 */}
            <header className="home-topbar">
                <h1 className="home-brand">Solis</h1>
                <div className="topbar-actions" data-focus-loop="true" data-focus-group="true">
                    <button type="button"
                        className={`icon-btn sheet-toggle-btn${sheetActive || playlistSession ? ' visible' : ''}`}
                        title={sheetActive ? '收起播放器' : '展开播放器'}
                        aria-label={sheetActive ? '收起播放器' : '展开播放器'}
                        onClick={toggleSheet}>
                        {sheetActive
                            ? <ChevronDown size={28} strokeWidth={1.8} />
                            : <ChevronUp size={28} strokeWidth={1.8} />}
                    </button>
                    {/* 顶栏不被浮窗覆盖（浮窗从 84px 起）：四按钮始终可见可聚焦，
                        左右在同一焦点组内循环；inert 只标记真正被盖住的选项卡与「我的」页。 */}
                    <div className="topbar-actions-inner">
                        <button type="button" className="icon-btn" title="搜索" aria-label="搜索"
                            onClick={() => setDialog('search')}>
                            <Search size={28} strokeWidth={1.8} />
                        </button>
                        <button type="button" className="icon-btn" title="设置" aria-label="设置"
                            onClick={() => setDialog('settings')}>
                            <Settings size={28} strokeWidth={1.8} />
                        </button>
                        <button type="button" className="avatar-btn" onClick={onAvatarClick}
                            title={user ? user.nickname : '登录'}>
                            {user?.avatarUrl
                                ? <img className="avatar-img" src={user.avatarUrl} alt="" />
                                : <User size={28} strokeWidth={1.8} />}
                        </button>
                    </div>
                </div>
            </header>

            <nav className="home-tabs" aria-label="内容分类"
                data-focus-loop="true" data-focus-group="true"
                data-group-down=".player-ctrl-btn[data-player-primary]"
                inert={sheetActive || undefined}>
                {TABS.map((tab) => (
                    <button key={tab.id} type="button"
                        className={`tab-btn${activeTab === tab.id ? ' active' : ''}`}
                        data-default-focus={activeTab === tab.id ? 'true' : undefined}
                        onClick={() => onTabClick(tab.id)}>
                        {tab.label}
                    </button>
                ))}
            </nav>

            <main className="home-content">
                {/* 播放页常驻：切"我的"仅 CSS 隐藏（播放不中断）；歌单浮窗模式全屏滑出覆盖。
                    打开/收起动画由 player-host 上的类驱动，动画播完才切回 hidden。 */}
                <div className={[
                    'player-host',
                    activeTab === 'mine' && !sheetOpen && !sheetClosing ? 'hidden' : '',
                    sheetOpen && !sheetClosing ? 'fullscreen open' : '',
                    sheetClosing ? 'fullscreen closing' : '',
                ].filter(Boolean).join(' ')}>
                    <PlayerScreen mode={playerMode} />
                </div>
                {activeTab === 'mine' && (
                    <div className="mine-page-host" inert={sheetActive || undefined}>
                        <MineScreen user={user} />
                    </div>
                )}
            </main>

            {dialog === 'login' && (
                <LoginDialog onLoggedIn={handleLoggedIn} onClose={() => setDialog(null)} />
            )}
            {dialog === 'user' && user && (
                <UserDialog user={user} onLogout={handleLogout} onClose={() => setDialog(null)} />
            )}
            {dialog === 'settings' && (
                <SettingsDialog onClose={() => setDialog(null)} />
            )}
            {dialog === 'search' && (
                <SearchPanel onClose={() => setDialog(null)} />
            )}
        </div>
    );
}
