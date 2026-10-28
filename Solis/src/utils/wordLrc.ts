// src/utils/wordLrc.ts — A2 扩展逐字 LRC 解析。
// 格式：行首 [mm:ss.xx] 行时间（绝对时间戳），行内 <mm:ss.mmm>字 为每字起始时间（同为绝对时间戳，
// 注意与汽水接口的"相对行首偏移"格式不同，无需偏移换算）。元数据行（[ti:][ar:] 等）自动跳过。

export interface LyricWord {
    text: string;
    start: number;
}

export interface LyricLine {
    start: number;
    words: LyricWord[];
}

const LINE_TIME = /\[(\d+):(\d+(?:\.\d+)?)\]/;
const WORD_PART = /(<\d+:\d+(?:\.\d+)?>)/;

function toSeconds(minutes: string, seconds: string): number {
    return parseInt(minutes, 10) * 60 + parseFloat(seconds);
}

export function parseWordLrc(raw: string): LyricLine[] {
    const lines: LyricLine[] = [];
    for (const row of raw.split(/\r\n|\r|\n/)) {
        const lineMatch = LINE_TIME.exec(row);
        if (!lineMatch) continue; // [ti:]/[ar:] 等元数据行
        const start = toSeconds(lineMatch[1], lineMatch[2]);
        const body = row.slice(lineMatch.index + lineMatch[0].length);
        const words: LyricWord[] = [];
        let pending: number | null = null;
        for (const part of body.split(WORD_PART)) {
            if (!part) continue;
            if (part.startsWith('<')) {
                const m = /^<(\d+):(\d+(?:\.\d+)?)>$/.exec(part);
                if (m) pending = toSeconds(m[1], m[2]);
                continue;
            }
            if (pending !== null) {
                words.push({ text: part, start: pending });
                pending = null;
            }
        }
        if (words.length > 0) lines.push({ start, words });
    }
    return lines.sort((a, b) => a.start - b.start);
}

/** 找到 time 所在行下标（最后一个 start <= time 的行）；time 早于全部行返回 -1。 */
export function activeLyricLine(lines: LyricLine[], time: number): number {
    let active = -1;
    for (let i = 0; i < lines.length; i++) {
        if (time >= lines[i].start) active = i;
        else break;
    }
    return active;
}
