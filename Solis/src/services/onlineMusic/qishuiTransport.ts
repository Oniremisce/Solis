import { OnlineProviderError } from '../../types/onlineMusic';
import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from './providerStorage';

// src/services/onlineMusic/qishuiTransport.ts
// 汽水音乐 HTTP 传输层：请求 qishui-api（VITE_QISHUI_API_BASE），统一解 `{code, data}` 信封。
// 网页 / Capacitor 壳都走这条路径；没有桌面内嵌后端一说。

const getWebApiBase = (): string => {
    const viteValue = typeof import.meta !== 'undefined' && import.meta.env?.MODE !== 'test'
        ? String((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_QISHUI_API_BASE || '')
        : '';
    const processValue = typeof process !== 'undefined' ? String(process.env?.VITE_QISHUI_API_BASE || '') : '';
    return (viteValue || processValue).trim().replace(/\/$/, '');
};

/** 网页版配置的远端 API 地址（自检与诊断用）；未配置时为 null。 */
export const getQishuiWebApiBase = (): string | null => getWebApiBase() || null;

export const getQishuiTransportAvailability = () => (
    getWebApiBase()
        ? { configured: true } as const
        : { configured: false, reason: 'not-configured' } as const
);

// ─── 登录会话（扫码确认获得：sessionid + 完整 cookie 串，持久在 providerStorage） ───
// 汽水 passport 登录态是一整套 cookie（sessionid/sessionid_ss/sid_tt/...），
// 单发 sessionid 不够，后端需要完整 cookie 串拼上游请求头。

const SESSION_KEY = 'sessionid';
const SESSION_LEGACY_KEYS = ['qishui_sessionid'];
const SESSION_COOKIE_KEY = 'cookie';

export const readQishuiSessionId = (): string => (
    readProviderSessionValue('qishui', SESSION_KEY, SESSION_LEGACY_KEYS) || ''
);

export const writeQishuiSessionId = (sessionid: string): void => {
    writeProviderSessionValue('qishui', SESSION_KEY, sessionid);
};

export const readQishuiCookie = (): string => (
    readProviderSessionValue('qishui', SESSION_COOKIE_KEY) || ''
);

export const writeQishuiCookie = (cookie: string): void => {
    writeProviderSessionValue('qishui', SESSION_COOKIE_KEY, cookie);
};

export const clearQishuiSessionId = (): void => {
    removeProviderSessionValue('qishui', SESSION_KEY, SESSION_LEGACY_KEYS);
    removeProviderSessionValue('qishui', SESSION_COOKIE_KEY);
};

// ─── 请求 ───

export type QishuiRequestParams = Record<string, string | number | boolean | undefined>;

/** 这些路由只收 POST JSON 正文（bodyOnly），query 里带敏感参数会被服务端直接拒绝。 */
const POST_ROUTES = new Set(['/auth/qrcode/status', '/me/playlists', '/me/collection/mixed', '/me/collection/media', '/me/collection/media/delete']);

/** 需要登录态的路由：本地存有完整 cookie 串时自动注入 `cookie` 参数（后端优先使用）。 */
const SESSION_ROUTES = new Set(['/auth/me', '/me/playlists', '/me/collection/mixed', '/me/collection/media', '/me/collection/media/delete', '/audio/info', '/search/mixed', '/fm/feed']);

type QishuiEnvelope = { code?: unknown; message?: unknown; data?: unknown };

/** 信封与裸响应并存：只有顶层带数字 `code` 的才拆包（auth/qrcode/status 的上游体被原样内嵌，仍走同一信封）。 */
const unwrapEnvelope = (body: unknown): unknown => {
    const candidate = body as QishuiEnvelope | null;
    if (candidate && typeof candidate === 'object' && typeof candidate.code === 'number' && 'data' in candidate) {
        return candidate.data;
    }
    return body;
};

export async function requestQishui<T = unknown>(route: string, params: QishuiRequestParams = {}): Promise<T> {
    const base = getWebApiBase();
    if (!base) {
        // 网页版没配后端地址：重试不会变好，transient:false 让播放侧显示「未配置」而不是「稍后再试」。
        throw new OnlineProviderError('unavailable', 'VITE_QISHUI_API_BASE is not configured', 'qishui',
            undefined, undefined, undefined, { stage: 'config', transient: false });
    }

    // 登录态路由自动携带完整 cookie 串（后端 sessionCookie 优先取它）
    let effectiveParams = params;
    if (SESSION_ROUTES.has(route)) {
        const cookie = readQishuiCookie();
        if (cookie) effectiveParams = { ...params, cookie };
    }

    const usePost = POST_ROUTES.has(route);
    let url = `${base}${route}`;
    if (!usePost) {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(effectiveParams)) {
            if (value !== undefined && value !== '') search.set(key, String(value));
        }
        const query = search.toString();
        if (query) url = `${url}?${query}`;
    }

    let response: Response;
    try {
        response = await fetch(url, {
            method: usePost ? 'POST' : 'GET',
            ...(usePost ? {
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify(effectiveParams),
            } : {}),
        });
    } catch (error) {
        // 连 API 本身都没连上（后端未运行、远端不可达），不是汽水上游的失败。
        throw new OnlineProviderError('network', `Qishui API request ${route} failed: ${error instanceof Error ? error.message : String(error)}`,
            'qishui', error, undefined, undefined, { stage: 'backend' });
    }

    const rawText = await response.text();
    let body: unknown;
    try {
        body = rawText ? JSON.parse(rawText) : null;
    } catch {
        throw new OnlineProviderError('invalid-response', `Qishui API ${route} returned HTTP ${response.status} without a JSON body: ${rawText.slice(0, 200) || '(empty)'}`,
            'qishui', undefined, response.status, undefined, { stage: 'song-url' });
    }

    if (!response.ok) {
        const failBody = body as (QishuiEnvelope & { message?: unknown }) | null;
        const message = typeof failBody?.message === 'string' ? failBody.message : `HTTP ${response.status}`;
        // ≥500 是服务异常（暂时），<500 是形态或参数错误（持久）。
        throw new OnlineProviderError(response.status >= 500 ? 'service-unavailable' : 'invalid-response',
            `Qishui API ${route} failed: ${message}`, 'qishui', body, response.status, undefined,
            { stage: 'song-url', upstreamCode: failBody?.code as number | undefined, transient: response.status >= 500 });
    }

    const envelope = body as QishuiEnvelope | null;
    if (envelope && typeof envelope === 'object' && typeof envelope.code === 'number' && envelope.code !== 0) {
        throw new OnlineProviderError('invalid-response', `Qishui API ${route} failed: ${typeof envelope.message === 'string' ? envelope.message : `code ${envelope.code}`}`,
            'qishui', body, response.status, undefined, { stage: 'song-url', upstreamCode: envelope.code });
    }

    return unwrapEnvelope(body) as T;
}
