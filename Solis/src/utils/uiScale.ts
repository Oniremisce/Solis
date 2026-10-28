// src/utils/uiScale.ts — 分辨率自适应：以 1920×1080 设计稿为基准整体等比缩放。
// 用 Chromium 的 zoom（TV WebView 116 与桌面 Chromium 均支持）：
// 任意窗口尺寸下逻辑视口恒为 1920×1080，所有 UI 组件比例严格一致，无需媒体查询。
// 安装为幂等操作（先卸旧再挂新），dev 热更新重装不会叠加监听器。

const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;

interface ScaleWindow extends Window {
    __solisUiScaleApply?: () => void;
}

export function installUiScale(): void {
    const apply = () => {
        const scale = Math.min(window.innerWidth / DESIGN_WIDTH, window.innerHeight / DESIGN_HEIGHT);
        (document.documentElement.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(scale);
    };

    const scaleWindow = window as ScaleWindow;
    if (scaleWindow.__solisUiScaleApply) {
        window.removeEventListener('resize', scaleWindow.__solisUiScaleApply);
    }
    scaleWindow.__solisUiScaleApply = apply;
    window.addEventListener('resize', apply);
    apply();
}
