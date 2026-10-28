// src/utils/songCache.ts — 播放过的歌曲元数据缓存（IndexedDB）。
// 缓存内容：封面图 blob、逐字歌词、歌名/歌手/时长等元数据；不缓存音频文件。
// 容量由设置挡位（1/2/5 GB）控制：写入前检查总占用，满后不再写入（不自动淘汰，手动清空释放）。

const DB_NAME = 'solis-cache';
const STORE = 'songs';

export interface CachedSongRecord {
    /** 'qishui:<mediaId>' */
    key: string;
    name: string;
    artists: string;
    coverUrl: string;
    coverBlob?: Blob;
    lyricData?: unknown;
    durationMs: number;
    /** 音频 blob（代理流整曲下载），重播同曲直接用缓存不再请求。 */
    audioBlob?: Blob;
    /** 音频实际取得的音质档（如 lossless）；重播时挡位一致才命中缓存。 */
    audioQuality?: string;
    /** 粗略占用字节数：封面 blob + 歌词/元数据 JSON + 音频 blob。 */
    byteSize: number;
    cachedAt: number;
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) {
                req.result.createObjectStore(STORE, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb();
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

export async function getCachedSongs(): Promise<CachedSongRecord[]> {
    return withStore('readonly', (store) => store.getAll() as IDBRequest<CachedSongRecord[]>);
}

/** 单曲缓存记录（含音频 blob），无则 null。 */
export async function getCachedSong(key: string): Promise<CachedSongRecord | null> {
    return withStore('readonly', (store) => store.get(key) as IDBRequest<CachedSongRecord | undefined>)
        .then((rec) => rec ?? null);
}

export async function cachedSongsByteSize(): Promise<number> {
    const records = await getCachedSongs();
    return records.reduce((sum, rec) => sum + (rec.byteSize || 0), 0);
}

export async function putCachedSong(record: CachedSongRecord): Promise<void> {
    await withStore('readwrite', (store) => store.put(record) as IDBRequest<IDBValidKey>);
}

export async function clearCachedSongs(): Promise<void> {
    await withStore('readwrite', (store) => store.clear() as IDBRequest<undefined>);
}

/** 格式化字节数为可读文本（设置面板已用量显示）。 */
export function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
}
