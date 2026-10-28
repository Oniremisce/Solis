// src/types/navidrome.ts — Navidrome 类型子集。
// 只包含 utils/lyrics/types.ts 依赖的结构化歌词类型（逐字段一致），
// 不含 NavidromeSong / 服务端响应等 TV 壳用不到的部分。

export interface StructuredLyricLine {
    start: number;
    value: string;
}

export interface StructuredLyricCue {
    start?: number;
    end?: number;
    value: string;
    byteStart?: number;
    byteEnd?: number;
}

export interface StructuredLyricCueLine {
    index: number;
    start?: number;
    end?: number;
    value: string;
    agentId?: string;
    cue?: StructuredLyricCue[];
}

export interface StructuredLyricAgent {
    id: string;
    role?: string;
    name?: string;
}

export interface StructuredLyric {
    displayArtist?: string;
    displayTitle?: string;
    lang?: string;
    kind?: 'main' | 'translation' | 'pronunciation' | string;
    line: StructuredLyricLine[];
    cueLine?: StructuredLyricCueLine[];
    agents?: StructuredLyricAgent[];
    offset?: number;
    synced?: boolean;
}
