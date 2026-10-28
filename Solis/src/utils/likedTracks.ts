// src/utils/likedTracks.ts — 汽水收藏（我喜欢）状态与写操作。
// 汽水没有「单曲是否已收藏」查询接口（track_v2 不带收藏态，/luna/me/collection/mixed
// 对单曲恒为空），红心初态 = 全量比对官方歌单「我喜欢的音乐」曲目集合；
// 收藏/取消收藏成功后增量维护本地集合，收藏写接口实测可加入官方「我喜欢的音乐」歌单。
import { requestQishui } from '../services/onlineMusic/qishuiTransport';
import { qishuiProvider } from '../services/onlineMusic/qishuiProvider';

const LIKED_PLAYLIST_NAME = '我喜欢的音乐';
// getPlaylistTracks 内部按上游分页翻页（单请求 count 固定），一次要够全量（内部有 40 页防御）。
const FULL_LOAD = 800;

let likedIds = new Set<string>();
let loaded = false;
let inflight: Promise<Set<string>> | null = null;

/** 红心同步查询：集合未加载完成时返回 null（不可判定），否则返回已知状态。 */
export function isLikedSync(trackId: string): boolean | null {
    return loaded ? likedIds.has(String(trackId)) : null;
}

/** 加载「我喜欢的音乐」全量曲目 id 集合（模块级缓存 + 单飞，避免并发重复拉取）。 */
export async function ensureLikedIds(): Promise<Set<string>> {
    if (loaded) return likedIds;
    if (inflight) return inflight;
    inflight = (async () => {
        const data = await requestQishui<Record<string, any>>('/me/playlists', {});
        const playlists = Array.isArray(data?.playlists) ? data.playlists : [];
        const liked = playlists.find((p: Record<string, unknown>) =>
            p?.name === LIKED_PLAYLIST_NAME || p?.title === LIKED_PLAYLIST_NAME || p?.public_title === LIKED_PLAYLIST_NAME);
        if (!liked?.id) {
            likedIds = new Set();
            loaded = true;
            return likedIds;
        }
        const page = await qishuiProvider.catalog?.getPlaylistTracks?.(String(liked.id), FULL_LOAD, 0);
        likedIds = new Set((page?.items ?? []).map((song) => String(song.id)));
        loaded = true;
        return likedIds;
    })().finally(() => { inflight = null; });
    return inflight;
}

/** 本地集合增量维护（收藏/取消成功后调用，不重拉全量）。 */
function markLiked(trackId: string, liked: boolean): void {
    if (liked) likedIds.add(String(trackId));
    else likedIds.delete(String(trackId));
}

/** 收藏当前歌曲 → 官方歌单「我喜欢的音乐」。 */
export async function collectTrack(trackId: string): Promise<void> {
    const id = String(trackId);
    await requestQishui('/me/collection/media', { track_id: id });
    markLiked(id, true);
}

/** 取消收藏。 */
export async function uncollectTrack(trackId: string): Promise<void> {
    const id = String(trackId);
    await requestQishui('/me/collection/media/delete', { track_id: id });
    markLiked(id, false);
}
