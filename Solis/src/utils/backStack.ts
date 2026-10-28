// src/utils/backStack.ts — 返回键处理栈（后进先出）。
// 浮层（弹窗/侧滑窗）打开时注册处理器返回 true 表示已消费本次返回（关闭浮层）；
// 无人消费时由 App 根部执行默认动作（TV 原生环境最小化到后台）。

type BackHandler = () => boolean;

const stack: BackHandler[] = [];

export function registerBackHandler(handler: BackHandler): () => void {
    stack.push(handler);
    return () => {
        const index = stack.indexOf(handler);
        if (index >= 0) stack.splice(index, 1);
    };
}

/** 派发返回事件：栈顶浮层处理器依次消费；全部放行返回 false。 */
export function dispatchBack(): boolean {
    for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]()) return true;
    }
    return false;
}
