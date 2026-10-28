import { useEffect } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import HomeScreen from './screens/HomeScreen';
import { installUiScale } from './utils/uiScale';
import { installRemoteKeyBridge, installSeekKeyBridge } from './utils/remoteKeys';
import { dispatchBack } from './utils/backStack';

// src/App.tsx — Solis TV 壳根组件。
// 打开即主页；1920×1080 设计稿等比缩放；电脑调试键桥（方向键/空格/Tab/退格=遥控器键）。
// 返回键（TV=KEYCODE_BACK/电脑=退格）：栈顶浮层（播放列表/弹窗）优先消费关闭，
// 无人消费且为原生环境时最小化到后台（不退出进程，TV 常规返回键语义）。

declare const __APP_VERSION__: string;
declare const __TV_BUILD_NUMBER__: string;

export default function App() {
    useEffect(() => {
        installUiScale();
        installRemoteKeyBridge();
        installSeekKeyBridge(); // 长按上一曲/下一曲快进快退（TV Enter 与电脑空格两端生效）

        // 电脑调试：Tab = 菜单键 → 呼出设置。
        const onMenu = () => {
            document.querySelector<HTMLButtonElement>('.icon-btn[aria-label="设置"]')?.click();
        };
        window.addEventListener('solis:menu', onMenu);

        // 返回键统一入口：TV 原生=Capacitor backButton，电脑调试=退格（solis:back）。
        const onBack = (): void => {
            if (dispatchBack()) return; // 栈顶浮层已消费（关闭侧滑窗/弹窗）
            if (Capacitor.isNativePlatform()) void CapacitorApp.minimizeApp();
        };
        let backButtonListener: { remove: () => unknown } | null = null;
        void CapacitorApp.addListener('backButton', onBack).then((handle) => {
            backButtonListener = handle;
        });
        window.addEventListener('solis:back', onBack);

        return () => {
            window.removeEventListener('solis:menu', onMenu);
            window.removeEventListener('solis:back', onBack);
            backButtonListener?.remove();
        };
    }, []);

    return (
        <div className="tv-root">
            <HomeScreen />
            <footer className="tv-footer">
                Solis · v{__APP_VERSION__} · tv-b{String(__TV_BUILD_NUMBER__).padStart(2, '0')}
            </footer>
        </div>
    );
}
