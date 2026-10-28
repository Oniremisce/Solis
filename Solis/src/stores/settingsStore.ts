// src/stores/settingsStore.ts — TV 壳全局设置（zustand + localStorage 持久化）。
// 当前承载长按快进/快退速率与优先音质挡位；后续设置项（缓存清理等）在此扩展。

import { create } from 'zustand';
import type { AudioQualityPreference } from '../types/onlineMusic';

/** 长按快进速率挡位：每按住 1 秒，进度条位移 N 秒。 */
export type SeekRate = 5 | 10 | 20 | 30;

export const SEEK_RATES: readonly SeekRate[] = [5, 10, 20, 30];

/** 播放列表预取数量挡位：队列待播歌曲少于该值时自动续拉补足。 */
export type PlaylistSize = 5 | 10 | 20;

export const PLAYLIST_SIZES: readonly PlaylistSize[] = [5, 10, 20];

/** 元数据缓存容量挡位（GB）：封面/歌词/歌名/歌手信息，满后停止写入。 */
export type CacheLimitGB = 1 | 2 | 5;

export const CACHE_LIMITS: readonly CacheLimitGB[] = [1, 2, 5];

const SEEK_RATE_KEY = 'solis.seek-rate';
const QUALITY_KEY = 'solis.preferred-quality';
const PLAYLIST_SIZE_KEY = 'solis.playlist-size';
const AUTO_CACHE_KEY = 'solis.auto-cache';
const CACHE_LIMIT_KEY = 'solis.cache-limit';
const LYRIC_MOTION_KEY = 'solis.lyric-motion';

function loadSeekRate(): SeekRate {
    const raw = localStorage.getItem(SEEK_RATE_KEY);
    return raw === '10' || raw === '20' || raw === '30' ? (Number(raw) as SeekRate) : 5;
}

/** 优先音质挡位：请求播放地址时的目标档，曲库无该档时由服务端自动降档取可用最高。 */
export const QUALITY_OPTIONS: readonly { value: AudioQualityPreference; label: string }[] = [
    { value: 'standard', label: '标准' },
    { value: 'high', label: '高品质' },
    { value: 'lossless', label: '无损' },
    { value: 'hires', label: 'Hi-Res' },
];

function loadPreferredQuality(): AudioQualityPreference {
    const raw = localStorage.getItem(QUALITY_KEY);
    return QUALITY_OPTIONS.some((o) => o.value === raw) ? (raw as AudioQualityPreference) : 'lossless';
}

function loadPlaylistSize(): PlaylistSize {
    const raw = Number(localStorage.getItem(PLAYLIST_SIZE_KEY));
    return raw === 5 || raw === 10 || raw === 20 ? (raw as PlaylistSize) : 10;
}

function loadAutoCache(): boolean {
    return localStorage.getItem(AUTO_CACHE_KEY) !== 'false'; // 默认开启
}

function loadCacheLimit(): CacheLimitGB {
    const raw = Number(localStorage.getItem(CACHE_LIMIT_KEY));
    return raw === 2 || raw === 5 ? (raw as CacheLimitGB) : 1;
}

/** 歌词动效开关：开启=莫奈风格（整句切换动画+逐字扫色染色），关闭=标准逐字高亮。默认关闭。 */
function loadLyricMotion(): boolean {
    return localStorage.getItem(LYRIC_MOTION_KEY) === 'true';
}

interface SettingsState {
    seekRate: SeekRate;
    setSeekRate: (rate: SeekRate) => void;
    preferredQuality: AudioQualityPreference;
    setPreferredQuality: (quality: AudioQualityPreference) => void;
    playlistSize: PlaylistSize;
    setPlaylistSize: (size: PlaylistSize) => void;
    autoCache: boolean;
    setAutoCache: (enabled: boolean) => void;
    cacheLimit: CacheLimitGB;
    setCacheLimit: (limit: CacheLimitGB) => void;
    lyricMotion: boolean;
    setLyricMotion: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
    seekRate: loadSeekRate(),
    setSeekRate: (rate) => {
        localStorage.setItem(SEEK_RATE_KEY, String(rate));
        set({ seekRate: rate });
    },
    preferredQuality: loadPreferredQuality(),
    setPreferredQuality: (quality) => {
        localStorage.setItem(QUALITY_KEY, quality);
        set({ preferredQuality: quality });
    },
    playlistSize: loadPlaylistSize(),
    setPlaylistSize: (size) => {
        localStorage.setItem(PLAYLIST_SIZE_KEY, String(size));
        set({ playlistSize: size });
    },
    autoCache: loadAutoCache(),
    setAutoCache: (enabled) => {
        localStorage.setItem(AUTO_CACHE_KEY, String(enabled));
        set({ autoCache: enabled });
    },
    cacheLimit: loadCacheLimit(),
    setCacheLimit: (limit) => {
        localStorage.setItem(CACHE_LIMIT_KEY, String(limit));
        set({ cacheLimit: limit });
    },
    lyricMotion: loadLyricMotion(),
    setLyricMotion: (enabled) => {
        localStorage.setItem(LYRIC_MOTION_KEY, String(enabled));
        set({ lyricMotion: enabled });
    },
}));
