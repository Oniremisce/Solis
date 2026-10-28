// src/utils/remoteKeys.ts — 遥控器键桥（电脑浏览器调试与 TV 真机两端都启用）。
//   方向键 → 空间焦点移动（data-focus-group/data-focus-loop 分组约束 + 几何避障寻焦）
//   空格   → OK 确认键（电脑调试；TV 的 OK=DPAD_CENTER 走 Enter 原生 click，无需接管）
//   Tab    → 菜单键（电脑调试；preventDefault 后派发 solis:menu 事件，App 层接设置面板）
//   退格   → 返回键（电脑调试；TV 返回键由系统→Capacitor backButton 处理，不进页面 keydown）
// TV 端必须启用：WebView 内建的方向寻焦是纯几何遍历，无视分组/焦点陷阱/inert 标记——
// 方向键由本桥 preventDefault 接管后，WebView 内建寻焦只对页面未处理的键兜底，不会双重移动。
// 安装为幂等操作（先卸旧再挂新）：dev 热更新重装不会叠加监听器导致一次按键连跳多步。

import { useSettingsStore } from '../stores/settingsStore';

const FOCUSABLE_SELECTOR = [
    'button:not([disabled]):not([tabindex="-1"])',
    '[href]:not([tabindex="-1"])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

type Direction = 'up' | 'down' | 'left' | 'right';

const KEY_DIRECTIONS: Record<string, Direction> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
};

// 焦点陷阱：页面存在 [data-focus-trap]（弹框）时，焦点只在弹框内移动。
function trapRoot(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-focus-trap]');
}

function focusables(): HTMLElement[] {
    const root = trapRoot() ?? document;
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
        // checkVisibility 兼容 position:fixed 弹框（offsetParent 对 fixed 恒为 null 不可用）。
        // inert 子树（浮窗覆盖的顶栏三按钮等）不可聚焦，从候选中排除避免焦点落进不可见区域。
        .filter((el) => (el.checkVisibility?.() ?? true) && !isInert(el));
}

/** 元素位于 inert 子树内（不可聚焦不可交互）。 */
function isInert(el: HTMLElement): boolean {
    let node: HTMLElement | null = el;
    while (node) {
        if (node.inert) return true;
        node = node.parentElement;
    }
    return false;
}

// 默认焦点：界面通过 [data-default-focus] 标记"最重要的位置"（如当前激活的选项卡），
// 无焦点（窗口刚激活/页面刚打开/焦点丢失）时落到这里，而不是 DOM 顺序的第一个元素。
// 焦点陷阱（弹框）激活时优先取弹框内的标记（如设置面板的当前挡位）。
function preferredFocusable(items: HTMLElement[]): HTMLElement | null {
    const trap = trapRoot();
    const preferred = (trap ? trap.querySelector<HTMLElement>('[data-default-focus]') : null)
        ?? document.querySelector<HTMLElement>('[data-default-focus]');
    return preferred && items.includes(preferred) ? preferred : null;
}

/** 焦点组（[data-focus-group] / [data-focus-loop]）内的可聚焦成员。 */
function groupMembers(group: HTMLElement): HTMLElement[] {
    return [...group.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
        .filter((el) => (el.checkVisibility?.() ?? true) && !isInert(el));
}

/** 左右方向在焦点组内循环移动（上一曲↔播放↔下一曲、收藏↔列表）。 */
function loopInGroup(group: HTMLElement, direction: 'left' | 'right', current: HTMLElement): HTMLElement | null {
    const members = groupMembers(group);
    const index = members.indexOf(current);
    if (index === -1 || members.length < 2) return null;
    const step = direction === 'left' ? -1 : 1;
    return members[(index + step + members.length) % members.length] ?? null;
}

/** 组默认落点：组内默认焦点标记 > 播放主按钮 > 组内第一个成员。 */
function groupDefault(group: HTMLElement): HTMLElement | null {
    const members = groupMembers(group);
    if (members.length === 0) return null;
    return members.find((m) => m.hasAttribute('data-default-focus'))
        ?? members.find((m) => m.hasAttribute('data-player-primary'))
        ?? members[0]!;
}

/** 无焦点时把焦点安放到默认位置；已有焦点则不抢占。 */
function applyDefaultFocus(): void {
    const current = document.activeElement;
    if (current && current !== document.body) return;
    const items = focusables();
    if (items.length === 0) return;
    (preferredFocusable(items) ?? items[0]!).focus();
}

/** 在目标方向上找中心点最近的可聚焦元素（主方向优先，横向偏移加权惩罚）。 */
function moveFocus(direction: Direction): void {
    const items = focusables();
    if (items.length === 0) return;
    const preferred = preferredFocusable(items);
    let current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!current || !items.includes(current)) {
        // 焦点不在当前作用域：
        // - 面板容器起步（如设置页打开时容器 tabIndex=-1 持有焦点）：落 trap 内第一个
        //   可聚焦元素（第一项）即停——第一次按方向键进第一项，与激活挡位无关。
        // - 真无焦点（初始无焦点/焦点丢失）：先落默认焦点位置，再按本次方向继续移动
        //   一步——一次按键始终产生一次有效移动。
        const rootStart = current?.hasAttribute('data-focus-trap') ?? false;
        current = rootStart ? items[0]! : (preferred ?? items[0]!);
        current.focus();
        if (rootStart) return;
    }
    const curRect = current.getBoundingClientRect();
    const curX = curRect.left + curRect.width / 2;
    const curY = curRect.top + curRect.height / 2;

    // 组内左右方向：当前焦点在循环组（[data-focus-loop]）内时，只在组内循环移动。
    if (direction === 'left' || direction === 'right') {
        const loopRoot = current.closest<HTMLElement>('[data-focus-loop]');
        if (loopRoot) {
            const looped = loopInGroup(loopRoot, direction, current);
            if (looped) {
                looped.focus();
                return;
            }
        }
    }
    // 组定向垂直移动：焦点组可声明 data-group-down / data-group-up（选择器），按上/下键离开
    // 该组时直接落到指定元素——选项卡组按下键直达播放按钮；「我的」歌单卡组按上键回激活选项卡。
    if (direction === 'down' || direction === 'up') {
        const currentGroup = current.closest<HTMLElement>('[data-focus-group]');
        const selector = currentGroup?.getAttribute(direction === 'down' ? 'data-group-down' : 'data-group-up');
        if (selector) {
            const target = document.querySelector<HTMLElement>(selector);
            if (target && (target.checkVisibility?.() ?? true)) {
                target.focus();
                return;
            }
        }
    }

    let best: HTMLElement | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const el of items) {
        if (el === current) continue;
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const dx = x - curX;
        const dy = y - curY;
        let primary: number;
        let cross: number;
        if (direction === 'up') { primary = -dy; cross = Math.abs(dx); }
        else if (direction === 'down') { primary = dy; cross = Math.abs(dx); }
        else if (direction === 'left') { primary = -dx; cross = Math.abs(dy); }
        else { primary = dx; cross = Math.abs(dy); }
        if (primary <= 4) continue; // 必须在目标方向上（留少量容差）
        const score = primary + cross * 2.5;
        if (score < bestScore) {
            bestScore = score;
            best = el;
        }
    }
    // 上下移动进入焦点组（[data-focus-group]）时落组默认位置，而非几何最近的成员——
    // 播放区向上回到选项卡行落当前激活选项卡，向下进入底部操作行落收藏按钮。
    // 组可声明 data-group-first="true"（设置页挡位组）：进入组统一落第一个成员，
    // 使上键与下键的进组行为一致（否则上键落当前激活挡位，与下行不对称）。
    if (best && (direction === 'up' || direction === 'down')) {
        const group = best.closest<HTMLElement>('[data-focus-group]');
        if (group && !group.contains(current)) {
            const fallback = group.getAttribute('data-group-first') === 'true'
                ? group.querySelector<HTMLElement>('[tabindex]:not([tabindex="-1"]), button, a')
                : groupDefault(group);
            if (fallback) best = fallback;
        }
    }
    best?.focus();
}

interface BridgeWindow extends Window {
    __solisKeyBridgeKeydown?: (event: KeyboardEvent) => void;
    __solisKeyBridgeKeyup?: (event: KeyboardEvent) => void;
    __solisKeyBridgeFocus?: () => void;
    __solisSeekKeydown?: (event: KeyboardEvent) => void;
    __solisSeekKeyup?: (event: KeyboardEvent) => void;
    __solisSeekBlur?: () => void;
}

export function installRemoteKeyBridge(): void {
    // TV 真机同样启用：WebView 内建寻焦无视分组标记，方向键必须由本桥接管（见文件头说明）。

    // 幂等安装：卸掉旧实例再挂新实例，HMR/重复调用不会叠加监听器。
    const bridgeWindow = window as BridgeWindow;
    if (bridgeWindow.__solisKeyBridgeKeydown) {
        window.removeEventListener('keydown', bridgeWindow.__solisKeyBridgeKeydown);
    }
    if (bridgeWindow.__solisKeyBridgeKeyup) {
        window.removeEventListener('keyup', bridgeWindow.__solisKeyBridgeKeyup);
    }
    if (bridgeWindow.__solisKeyBridgeFocus) {
        window.removeEventListener('focus', bridgeWindow.__solisKeyBridgeFocus);
    }

    // 空格 = OK 确认键：keydown 阻断原生滚动/激活序列，keyup 统一显式 click，
    // 等价 TV 遥控器 OK（DPAD_CENTER→Enter）的确认语义，且不会与原生行为双触发。
    // 仅作用于按钮/链接类元素；输入框聚焦时空格保持原生输入。
    const isActivatable = (el: Element | null): el is HTMLElement =>
        el instanceof HTMLElement && (el.tagName === 'BUTTON' || el.tagName === 'A');

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === ' ') {
            if (isActivatable(document.activeElement)) event.preventDefault();
            return;
        }
        const direction = KEY_DIRECTIONS[event.key];
        if (direction) {
            // 输入框聚焦：左右键留给文本光标移动（不抢），上下键跳出输入框走空间导航。
            const target = event.target as HTMLElement | null;
            const inInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
            if (inInput && (direction === 'left' || direction === 'right')) return;
            event.preventDefault();
            moveFocus(direction);
            return;
        }
        if (event.key === 'Tab') {
            // Tab 在电脑调试中对应遥控器菜单键：不切焦点，派发菜单事件。
            event.preventDefault();
            window.dispatchEvent(new CustomEvent('solis:menu'));
            return;
        }
        if (event.key === 'Backspace') {
            // 退格键对应遥控器返回键：输入框非空时保持原生删除；
            // 输入框为空时退格 = 返回（收起面板，与通用 IME 惯例一致）。
            const target = event.target as HTMLElement | null;
            const inInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
            if (inInput) {
                const empty = !(target as HTMLInputElement).value;
                if (!empty) return;
                event.preventDefault();
                window.dispatchEvent(new CustomEvent('solis:back'));
                return;
            }
            event.preventDefault();
            window.dispatchEvent(new CustomEvent('solis:back'));
        }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
        if (event.key !== ' ') return;
        // 上一曲/下一曲（data-seek）由 seek 桥统一接管短按与长按语义，这里不重复 click。
        if (document.activeElement?.hasAttribute?.('data-seek')) return;
        if (isActivatable(document.activeElement)) document.activeElement.click();
    };

    bridgeWindow.__solisKeyBridgeKeydown = onKeyDown;
    bridgeWindow.__solisKeyBridgeKeyup = onKeyUp;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // 默认焦点：窗口激活或页面刚打开（无焦点）时，焦点落在界面最重要的位置。
    bridgeWindow.__solisKeyBridgeFocus = applyDefaultFocus;
    window.addEventListener('focus', applyDefaultFocus);
    requestAnimationFrame(applyDefaultFocus);
}

// ─── 长按快进快退桥（TV 与电脑调试两端都启用） ───
// 焦点在 [data-seek]（上一曲/下一曲）上按住 OK（TV=Enter）或空格（电脑调试）：
// rAF 驱动固定倍速连续 seek——速率取设置挡位（每按住 1 秒位移 seekRate 秒，默认 5），
// 松开立即停止；每帧直接派发 timeupdate，时间标签与进度条平滑连续变化。
// 按住满 2 秒才开始快进快退，未满 2 秒松开为短按切歌；两端（TV Enter / 电脑空格）同语义。

interface SeekSession {
    raf: number;
    direction: number;
    startedAt: number;
    lastFrameAt: number;
}

/** keydown 后等待触发的长按：2 秒计时到期才真正进入 seek 会话。 */
interface PendingSeek {
    direction: number;
    timer: number;
}

let seekSession: SeekSession | null = null;
let pendingSeek: PendingSeek | null = null;

/** 按住达到该时长才触发快进快退，低于视为短按（切歌）。 */
const SEEK_HOLD_MS = 2000;

function stopSeekSession(): void {
    if (!seekSession) return;
    cancelAnimationFrame(seekSession.raf);
    seekSession = null;
}

function cancelPendingSeek(): void {
    if (!pendingSeek) return;
    window.clearTimeout(pendingSeek.timer);
    pendingSeek = null;
}

/** audio 可否被 seek 桥直接操作：双播放器下仅「非快照态的活动会话元素」标记
 *  data-seek-active（快照态两元素都不标记，桥不介入——否则长按快进快退会作用于看不见的后台歌曲）。 */
function seekableAudio(): HTMLAudioElement | null {
    return document.querySelector<HTMLAudioElement>('audio[data-seek-active="true"]');
}

function startSeekSession(direction: number): void {
    stopSeekSession();
    if (!seekableAudio()) return;
    const startedAt = performance.now();
    const session: SeekSession = { raf: 0, direction, startedAt, lastFrameAt: startedAt };
    const step = (now: number): void => {
        const audio = seekableAudio();
        if (!audio) { seekSession = null; return; } // 播放页卸载（切"我的"）即终止
        const frameDt = Math.min((now - session.lastFrameAt) / 1000, 0.1);
        session.lastFrameAt = now;
        const rate = useSettingsStore.getState().seekRate;
        const duration = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
        audio.currentTime = Math.min(Math.max(0, audio.currentTime + session.direction * rate * frameDt), duration);
        // timeupdate 对 seek 的派发频率不足，每帧补发一次保证 UI 平滑（React 以 capture 委托接收）。
        audio.dispatchEvent(new Event('timeupdate'));
        session.raf = requestAnimationFrame(step);
    };
    session.raf = requestAnimationFrame(step);
    seekSession = session;
}

export function installSeekKeyBridge(): void {
    const bridgeWindow = window as BridgeWindow;
    if (bridgeWindow.__solisSeekKeydown) {
        window.removeEventListener('keydown', bridgeWindow.__solisSeekKeydown);
    }
    if (bridgeWindow.__solisSeekKeyup) {
        window.removeEventListener('keyup', bridgeWindow.__solisSeekKeyup);
    }
    if (bridgeWindow.__solisSeekBlur) {
        window.removeEventListener('blur', bridgeWindow.__solisSeekBlur);
    }
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const target = document.activeElement as HTMLElement | null;
        const delta = target?.getAttribute?.('data-seek');
        if (delta === null || delta === undefined) return;
        event.preventDefault(); // 阻 Enter 原生 click 与空格滚动
        if (event.repeat || seekSession || pendingSeek) return; // 原生重复键由计时/会话接管
        // 按住满 2 秒才进入快进快退；期间松开按短按切歌处理。
        const direction = parseInt(delta, 10) > 0 ? 1 : -1;
        const timer = window.setTimeout(() => {
            pendingSeek = null;
            startSeekSession(direction);
        }, SEEK_HOLD_MS);
        pendingSeek = { direction, timer };
    };
    const onKeyUp = (event: KeyboardEvent): void => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (seekSession) {
            stopSeekSession();
            return;
        }
        // 未满长按时长松开 = 短按切歌——TV 端 Enter 的原生 click 已被 keydown
        // preventDefault 阻断，电脑端键桥也对 data-seek 按钮放行，短按 click 由这里补发。
        if (pendingSeek) cancelPendingSeek();
        const target = document.activeElement as HTMLElement | null;
        if (target?.hasAttribute?.('data-seek')) target.click();
    };
    bridgeWindow.__solisSeekKeydown = onKeyDown;
    bridgeWindow.__solisSeekKeyup = onKeyUp;
    bridgeWindow.__solisSeekBlur = () => {
        cancelPendingSeek();
        stopSeekSession();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    // TV 上 keyup 可能丢失（失焦/切后台）：窗口失焦强制停止，防快进失控。
    window.addEventListener('blur', () => {
        cancelPendingSeek();
        stopSeekSession();
    });
}
