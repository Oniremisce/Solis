import { OnlineProviderError } from '../../types/onlineMusic';
import type {
    AudioQualityPreference,
    OnlineMusicProvider,
    PersonalFmRequestOptions,
    ProviderPage,
    QrLoginState,
} from '../../types/onlineMusic';
import type { SongResult, UnifiedSong } from '../../types';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { getPersonalFmRequestOptions } from '../../stores/usePersonalFmModeStore';
import { parseQishuiLyrics } from './qishuiLyrics';
import {
    clearQishuiSessionId,
    getQishuiTransportAvailability,
    readQishuiCookie,
    readQishuiSessionId,
    requestQishui,
    writeQishuiCookie,
    writeQishuiSessionId,
} from './qishuiTransport';
import { normalizeQishuiCollection, normalizeQishuiSong, normalizeQishuiUser, qishuiPage } from './qishuiNormalize';

// src/services/onlineMusic/qishuiProvider.ts
// 汽水音乐 adapter：能力走 qishui-api（HTTP）。v1 范围：搜索、播放、逐字歌词、扫码登录（抖音 APP 扫码）、
// 我的歌单、歌单详情与分页、推荐歌单。没有专辑/歌手/喜欢/云盘/写入能力，capabilities 如实声明 false。

const PLAYLIST_PAGE_SIZE = 20;

type QishuiPageCursorEntry = { offset: number; cursor: string };

/** 歌单游标备忘：汽水按 cursor 字符串翻页，ProviderPage 只有数字 offset，这里记下每个 offset 对应的 cursor。 */
const playlistCursorMemo = new Map<string, QishuiPageCursorEntry[]>();

const memoPlaylistCursor = (playlistId: string, entry: QishuiPageCursorEntry): void => {
    const list = playlistCursorMemo.get(playlistId) ?? [{ offset: 0, cursor: '' }];
    if (!list.some(item => item.offset === entry.offset)) list.push({ offset: entry.offset, cursor: entry.cursor });
    playlistCursorMemo.set(playlistId, list);
};

const cursorAtOrBefore = (playlistId: string, offset: number): QishuiPageCursorEntry => {
    const list = playlistCursorMemo.get(playlistId) ?? [{ offset: 0, cursor: '' }];
    return list.reduce<QishuiPageCursorEntry | null>(
        (best, item) => (item.offset <= offset && (!best || item.offset > best.offset) ? item : best),
        null,
    ) ?? { offset: 0, cursor: '' };
};

// ─── 扫码登录 ───

/** getQrKey 与 createQr 是两步 UI 流程，但汽水要码一步就返回图片：按 token 记住最近几张。 */
const qrImageByToken = new Map<string, string>();

const rememberQrImage = (token: string, image: string): void => {
    qrImageByToken.set(token, image);
    while (qrImageByToken.size > 8) {
        const oldest = qrImageByToken.keys().next().value;
        if (oldest === undefined) break;
        qrImageByToken.delete(oldest);
    }
};

const mapQrStatus = (body: Record<string, any>): QrLoginState => {
    const status = String(body?.status || '');
    switch (status) {
        case 'new':
        case 'waiting':
        case '1':
            return { state: 'waiting' };
        case 'scanned':
        case '2':
            return { state: 'scanned' };
        case 'confirmed':
        case '3': {
            const sessionid = String(body?.auth?.sessionid || '');
            const cookie = String(body?.auth?.cookie || '');
            if (sessionid) writeQishuiSessionId(sessionid);
            if (cookie) writeQishuiCookie(cookie);
            if (!sessionid && !cookie) {
                return { state: 'error', detail: { status, error_code: body?.error_code, description: body?.description } };
            }
            return { state: 'confirmed' };
        }
        case 'expired':
        case '4':
            return { state: 'expired' };
        default:
            // 未知状态按失败交给会话时间线，原始字段原样保留。
            return { state: 'error', detail: { status, error_code: body?.error_code, description: body?.description } };
    }
};

// ─── Provider ───

const requireQishuiSongRef = (song: SongResult) => {
    const source = song.sourceRef;
    if (source?.kind !== 'online' || source.providerId !== 'qishui') {
        throw new OnlineProviderError('unsupported', 'Song does not belong to Qishui', 'qishui');
    }
    return source;
};

const searchPage = (tracks: unknown[], limit: number, offset: number): ProviderPage<UnifiedSong> => {
    const items = (Array.isArray(tracks) ? tracks : []).map(normalizeQishuiSong);
    return qishuiPage(items, offset, items.length === limit && items.length > 0);
};

// ─── 私人 FM 官方推荐流（/fm/feed → /luna/pc/feed/song-tab） ───
// 三模式：DEFAULT=默认（不带 feed_preference）、FAMILIAR=熟悉（familiar）、EXPLORE=新鲜（fresh）。
// 与官方客户端一致：同一模式连续拉歌共享翻页会话（is_first_request 仅首次 true、
// mix_session_count 递增）；超时会话视为重新进入，从头开始。SCENE_RCMD/PUZZLE 汽水
// 没有对应概念，落回默认模式。

const FM_SESSION_WINDOW_MS = 10 * 60 * 1000;

type QishuiFmMode = 'default' | 'familiar' | 'fresh';

type QishuiFmSession = { counter: number; didFirstUseTime: number; lastUsedAt: number };

const qishuiFmSessions = new Map<QishuiFmMode, QishuiFmSession>();

const qishuiFmModeOf = (mode?: string | null): QishuiFmMode => (
    mode === 'FAMILIAR' ? 'familiar' : mode === 'EXPLORE' ? 'fresh' : 'default'
);

const nextQishuiFmSession = (mode: QishuiFmMode): QishuiFmSession => {
    const now = Date.now();
    const existing = qishuiFmSessions.get(mode);
    if (existing && now - existing.lastUsedAt <= FM_SESSION_WINDOW_MS) {
        const continued = { ...existing, counter: existing.counter + 1, lastUsedAt: now };
        qishuiFmSessions.set(mode, continued);
        return continued;
    }
    const freshSession = { counter: 1, didFirstUseTime: Math.floor(now / 1000), lastUsedAt: now };
    qishuiFmSessions.set(mode, freshSession);
    return freshSession;
};

export const qishuiProvider: OnlineMusicProvider = {
    id: 'qishui',
    displayName: '汽水音乐',
    shortName: '汽水',
    getAvailability: getQishuiTransportAvailability,
    capabilities: {
        search: true,
        playback: true,
        lyrics: true,
        wordByWordLyrics: true,
        auth: true,
        userLibrary: true,
        playlists: true,
        albums: false,
        artists: false,
        recommendations: true,
        mutations: false,
        personalFmModes: true,
    },
    normalizeSong: normalizeQishuiSong,
    normalizeUser: normalizeQishuiUser,
    normalizeCollection: normalizeQishuiCollection,
    songMetadata: { getSongMetadata: createProviderSongMetadata },
    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return qishuiPage([], offset, false);
            // PC 混合搜索按 cursor 翻页；上游当前对未登录请求可能返回空列表，调用方按普通空页展示。
            const data = await requestQishui<any>('/search/mixed', { keywords: query, cursor: offset });
            return searchPage(data?.tracks, limit, offset);
        },
    },
    playback: {
        async getSongDetail(id) {
            const data = await requestQishui<any>('/song/detail', { track_id: String(id) });
            return data?.track_id || data?.id ? normalizeQishuiSong(data) : null;
        },
        async getAudioSource(song, quality: AudioQualityPreference) {
            const source = requireQishuiSongRef(song);
            // 统一枚举 → 汽水档名：服务端 pickBestEntry 从 ≤优先档中取最高（曲库缺档自动降档）。
            const qishuiQuality = { standard: 'medium', high: 'highest', lossless: 'lossless', hires: 'hi_res' }[quality] ?? 'lossless';
            const data = await requestQishui<any>('/audio/info', { track_id: source.mediaId, quality: qishuiQuality });
            const cachedUrl = typeof source.providerData?.audioUrl === 'string' ? source.providerData.audioUrl : '';
            const url = String(data?.audio_url || '') || cachedUrl;
            if (!url) {
                throw new OnlineProviderError('not-playable', 'Qishui returned no audio url for this track', 'qishui',
                    data, undefined, undefined, { stage: 'song-url' });
            }
            return {
                url,
                fetchedAt: Date.now(),
                quality,
                actualQuality: typeof data?.quality === 'string' ? data.quality : undefined,
            };
        },
    },
    lyrics: {
        async getLyrics(song) {
            const source = requireQishuiSongRef(song);
            const data = await requestQishui<any>('/lyric', { track_id: source.mediaId });
            return parseQishuiLyrics(String(data?.lrc || ''));
        },
    },
    auth: {
        async getLoginStatus() {
            const sessionid = readQishuiSessionId();
            const cookie = readQishuiCookie();
            if (!sessionid && !cookie) return null;
            try {
                // cookie 串由 transport 对登录态路由自动注入；sessionid 仅作兼容标识
                const data = await requestQishui<any>('/auth/me', sessionid ? { sessionid } : {});
                const user = normalizeQishuiUser(data?.profile);
                return user.id ? user : null;
            } catch (error) {
                // 网络/服务端异常不当作「未登录」，否则一次抖动就把本地会话清掉了。
                if (error instanceof OnlineProviderError && (error.code === 'network' || error.code === 'service-unavailable' || error.code === 'timeout')) {
                    throw error;
                }
                clearQishuiSessionId();
                return null;
            }
        },
        async logout() {
            clearQishuiSessionId();
        },
        async getQrKey() {
            const data = await requestQishui<any>('/auth/qrcode');
            const token = String(data?.token || '');
            const image = String(data?.qrcode || '');
            if (!token || !image) {
                throw new OnlineProviderError('invalid-response', 'Qishui QR response is missing token or image', 'qishui', data);
            }
            rememberQrImage(token, image);
            return token;
        },
        async createQr(key) {
            const image = qrImageByToken.get(key);
            if (image) return image;
            // 缓存丢失（会话中途刷新等）无法用旧 token 补图片，明确失败让 UI 重新走一轮要码。
            throw new OnlineProviderError('invalid-response', 'Qishui QR image is not cached for this token', 'qishui');
        },
        checkQr: key => requestQishui<Record<string, any>>('/auth/qrcode/status', { token: key }).then(mapQrStatus),
        getQrTtlMs: () => 5 * 60 * 1000,
    },
    library: {
        async getUserPlaylists(_userId, limit, offset) {
            const sessionid = readQishuiSessionId();
            const cookie = readQishuiCookie();
            if (!sessionid && !cookie) {
                throw new OnlineProviderError('auth-required', 'Qishui user playlists require a session', 'qishui');
            }
            const data = await requestQishui<any>('/me/playlists', sessionid ? { sessionid } : {});
            const all = (Array.isArray(data?.playlists) ? data.playlists : []).map((item: any) => normalizeQishuiCollection(item));
            const items = all.slice(offset, offset + limit);
            return qishuiPage(items, offset, offset + items.length < all.length);
        },
    },
    catalog: {
        async getPlaylistDetail(id) {
            const data = await requestQishui<any>('/playlist/detail', { playlist_id: String(id), count: 1 });
            return data?.playlist?.id ? normalizeQishuiCollection(data.playlist) : null;
        },
        async getPlaylistTracks(id, limit, offset) {
            const playlistId = String(id);
            let entry = cursorAtOrBefore(playlistId, offset);
            const collected: UnifiedSong[] = [];
            let reached = entry.offset;
            // 上限防御：单次请求最多翻 40 页（≈800 首），防止上游 cursor 异常导致死循环。
            for (let page = 0; page < 40; page += 1) {
                if (reached >= offset && collected.length >= limit) break;
                const data = await requestQishui<any>('/playlist/detail', {
                    playlist_id: playlistId, cursor: entry.cursor, count: PLAYLIST_PAGE_SIZE,
                });
                const tracks = (Array.isArray(data?.media_resources) ? data.media_resources : [])
                    .map((item: any) => item?.track)
                    .filter((track: any) => track && track.id)
                    .map(normalizeQishuiSong);
                const nextCursor = String(data?.next_cursor || '');
                if (reached + tracks.length > offset) {
                    collected.push(...tracks.slice(offset - reached));
                }
                reached += tracks.length;
                memoPlaylistCursor(playlistId, { offset: reached, cursor: nextCursor });
                if (!nextCursor) break;
                entry = { offset: reached, cursor: nextCursor };
            }
            const hasMore = collected.length >= limit && Boolean(entry.cursor);
            return qishuiPage(collected.slice(0, limit), offset, hasMore);
        },
    },
    recommendations: {
        async getRecommendedCollections(limit) {
            const data = await requestQishui<any>('/recommend/playlist', { count: limit });
            const playlists = (Array.isArray(data?.playlists) ? data.playlists : [])
                .map((item: any) => normalizeQishuiCollection(item))
                .slice(0, limit);
            return playlists;
        },
        // 私人 FM 对接汽水官方推荐队列（feed/song-tab）：模式由全局 FM selection 驱动
        // （DEFAULT/FAMILIAR/EXPLORE 三选），老调用方不传 options 时回退读 store，与网易同约定。
        async getPersonalFm(options?: PersonalFmRequestOptions) {
            const selection = options ?? getPersonalFmRequestOptions();
            const mode = qishuiFmModeOf(selection?.mode);
            const session = nextQishuiFmSession(mode);
            const data = await requestQishui<any>('/fm/feed', {
                mode,
                first_request: session.counter === 1,
                session_count: session.counter,
                did_first_use_time: session.didFirstUseTime,
            });
            const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
            return tracks.map((item: any) => normalizeQishuiSong(item)).filter(Boolean);
        },
    },
};
