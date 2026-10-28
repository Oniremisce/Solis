import type { Artist, UnifiedSong } from '../../types';
import type { JsonValue, ProviderCollection, ProviderPage, ProviderUser } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';

// src/services/onlineMusic/qishuiNormalize.ts
// 汽水数据归一化：兼容两路来源——feed/歌单里的 track（{id,name,duration,album,artists}）
// 与分享页解析出的歌曲（{track_id,name,artists,album,audio_url,duration}）。

export type QishuiRecord = Record<string, any>;
export const qishuiRecord = (value: unknown): QishuiRecord => (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);
const text = (value: unknown) => value == null ? '' : String(value);

const artistsOf = (item: QishuiRecord): Artist[] => {
    const artists = Array.isArray(item.artists) ? item.artists : [];
    return artists.filter(artist => artist && (artist.name || artist.simple_display_name)).map(artist => ({
        id: text(artist.id),
        name: text(artist.name || artist.simple_display_name),
    }));
};

// 音质档位分值（对齐服务端 STREAM_QUALITY_RANK；spatial 为自定位次，仅用于徽章展示排序）。
const QUALITY_RANK: Record<string, number> = {
    lossless: 50, hi_res: 45, spatial: 42, highest: 40, higher: 30, medium: 20, lower: 10,
};

// feed/搜索响应里 track 的标签字段可能在 raw 包装下或直接在 track 上，两处都看。
const trackBitRates = (item: QishuiRecord): unknown[] => {
    const holder = qishuiRecord(item.raw ?? item);
    return Array.isArray(holder.bit_rates) ? holder.bit_rates : [];
};

const trackLabelInfo = (item: QishuiRecord): QishuiRecord => qishuiRecord(qishuiRecord(item.raw ?? item).label_info);

// Cached canonical songs are accepted without re-normalizing (catalogRef 回灌等场景)。
export const normalizeQishuiSong = (raw: unknown): UnifiedSong => {
    const item = qishuiRecord(raw);
    if (item.sourceRef?.kind === 'online' && item.sourceRef.providerId === 'qishui') return item as UnifiedSong;
    const id = text(item.track_id || item.id);
    if (!id) throw new OnlineProviderError('invalid-response', 'Qishui song has no id', 'qishui');
    const album = qishuiRecord(item.album);
    const data: Record<string, JsonValue> = {};
    if (item.vid) data.vid = text(item.vid);
    // 分享页直出的音频地址；过期由播放层重新取，缓存里只是省一次解析的捷径。
    if (typeof item.audio_url === 'string' && item.audio_url) data.audioUrl = item.audio_url;
    // 徽章数据：曲库最高音质档 + VIP 限定（汽水无 AI 标识字段，不做 AI 徽章）。
    const bestQuality = trackBitRates(item)
        .map((entry) => text(qishuiRecord(entry).quality))
        .filter((quality) => (QUALITY_RANK[quality] ?? 0) > 0)
        .reduce<string>((best, quality) => ((QUALITY_RANK[quality] ?? 0) > (QUALITY_RANK[best] ?? 0) ? quality : best), '');
    if (bestQuality) data.qishuiQuality = bestQuality;
    if (trackLabelInfo(item).only_vip_playable === true) data.qishuiVipOnly = true;
    return {
        id,
        name: text(item.name || item.trackName),
        artists: artistsOf(item),
        album: {
            id: text(album.id),
            name: text(album.name),
            coverUrl: text(album.cover_url),
        },
        durationMs: Math.max(0, Number(item.duration) || 0),
        sourceRef: { kind: 'online', providerId: 'qishui', mediaId: id, providerData: data },
    };
};

export const normalizeQishuiUser = (raw: unknown): ProviderUser => {
    const item = qishuiRecord(raw);
    const profile = qishuiRecord(item.profile || item.my_info || item);
    const avatarUrl = text(profile.avatar_url || profile.larger_avatar_url);
    return {
        id: text(profile.id ?? item.id),
        nickname: text(profile.nickname || profile.name),
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(profile.is_vip !== undefined ? { vipType: profile.is_vip ? 1 : 0 } : {}),
    };
};

// 汽水上游不给歌单更新时间；用日粒度的合成版本（当天内恒定）：当天多次进歌单直接显缓存（无感加载），
// 跨天首次进入才重拉刷新，兼顾体验与内容新鲜度。
const qishuiCollectionVersion = (): number => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    return dayStart.getTime();
};

export const normalizeQishuiCollection = (raw: unknown, type = 'playlist'): ProviderCollection => {
    const item = qishuiRecord(raw);
    if (item.providerId === 'qishui') return item as ProviderCollection;
    const id = text(item.id);
    if (!id) throw new OnlineProviderError('invalid-response', 'Qishui collection has no id', 'qishui');
    const trackCount = Number(item.count_tracks ?? item.track_count ?? item.song_count) || undefined;
    const creator = qishuiRecord(item.creator);
    return {
        providerId: 'qishui',
        id,
        type,
        name: text(item.title || item.name),
        coverUrl: text(item.cover_url),
        description: text(item.description || item.desc || item.intro),
        ...(trackCount !== undefined ? { trackCount } : {}),
        updatedAt: qishuiCollectionVersion(),
        ...(creator.id || creator.nickname ? {
            creator: { id: text(creator.id), nickname: text(creator.nickname || creator.name), avatarUrl: text(creator.avatar_url) },
        } : {}),
    };
};

export const qishuiPage = <T>(items: T[], offset: number, hasMore: boolean): ProviderPage<T> => ({
    items,
    nextOffset: offset + items.length,
    hasMore,
});
