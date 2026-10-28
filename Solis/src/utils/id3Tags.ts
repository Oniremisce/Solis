// src/utils/id3Tags.ts — 从音频 URL 的 ID3v2 标签提取内嵌封面与歌词。
// 仅通过 Range 请求读取文件头部标签区，不整读音频文件（对齐项目性能规则）。
// 支持 v2.3/v2.4 的 APIC（封面）与 USLT（歌词）帧；本地测试曲与后续导入链路共用。

export interface Id3Tags {
    cover: Blob | null;
    lyrics: string | null;
}

const TEXT_ENCODINGS: Record<number, string> = {
    0: 'windows-1252',
    1: 'utf-16',
    2: 'utf-16be',
    3: 'utf-8',
};

/** ID3v2 标签区上限：封面通常 <500KB，超出按无标签处理，避免异常文件拉爆内存。 */
const MAX_TAG_SIZE = 4 * 1024 * 1024;

function syncSafe(view: DataView, offset: number): number {
    return ((view.getUint8(offset) & 0x7f) << 21)
        | ((view.getUint8(offset + 1) & 0x7f) << 14)
        | ((view.getUint8(offset + 2) & 0x7f) << 7)
        | (view.getUint8(offset + 3) & 0x7f);
}

function decodeText(bytes: Uint8Array, encoding: number): string {
    try {
        return new TextDecoder(TEXT_ENCODINGS[encoding] ?? 'utf-8')
            .decode(bytes).replace(/\0+$/, '');
    } catch {
        return '';
    }
}

/** 读取 null 终止字符串，返回 [文本, 消耗字节数]；编码 1/2（UTF-16）终止符为双字节。 */
function readNullTerminated(bytes: Uint8Array, offset: number, encoding: number): [string, number] {
    const wide = encoding === 1 || encoding === 2;
    let end = offset;
    while (end < bytes.length - (wide ? 1 : 0)) {
        const isTerminator = wide
            ? bytes[end] === 0 && bytes[end + 1] === 0
            : bytes[end] === 0;
        if (isTerminator) break;
        end += wide ? 2 : 1;
    }
    return [decodeText(bytes.subarray(offset, end), encoding), end + (wide ? 2 : 1) - offset];
}

async function fetchBytes(url: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    const buf = await res.arrayBuffer();
    // 服务不支持 Range（200 响应）时只取所需前缀，避免解析越界。
    return new Uint8Array(buf, 0, Math.min(buf.byteLength, end - start + 1));
}

function parseApic(data: Uint8Array<ArrayBuffer>): Blob | null {
    if (data.length < 4) return null;
    const encoding = data[0];
    let i = 1;
    // MIME 为 latin1 单字节 null 终止。
    let mimeEnd = i;
    while (mimeEnd < data.length && data[mimeEnd] !== 0) mimeEnd++;
    const mime = decodeText(data.subarray(i, mimeEnd), 0) || 'image/jpeg';
    i = mimeEnd + 1;
    i += 1; // picture type 字节
    if (i >= data.length) return null;
    const [, descLen] = readNullTerminated(data, i, encoding);
    i += descLen;
    if (i >= data.length) return null;
    return new Blob([data.subarray(i)], { type: mime });
}

function parseUslt(data: Uint8Array): string | null {
    if (data.length < 6) return null;
    const encoding = data[0];
    const [, descLen] = readNullTerminated(data, 4, encoding); // 1 字节编码 + 3 字节语言
    const text = decodeText(data.subarray(4 + descLen), encoding);
    return text || null;
}

export async function extractId3Tags(url: string): Promise<Id3Tags> {
    const head = await fetchBytes(url, 0, 9);
    if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) {
        return { cover: null, lyrics: null };
    }
    const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const version = headView.getUint8(3); // 3 = v2.3, 4 = v2.4
    const tagSize = syncSafe(headView, 6);
    if (version < 3 || version > 4 || tagSize <= 0 || tagSize > MAX_TAG_SIZE) {
        return { cover: null, lyrics: null };
    }

    const bytes = await fetchBytes(url, 0, tagSize + 9);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let offset = 10;
    if (headView.getUint8(5) & 0x40) {
        // 扩展头：v2.4 的 size 含自身，v2.3 不含（需 +4）。
        const extSize = version === 4 ? syncSafe(view, offset) : view.getUint32(offset) + 4;
        offset += extSize;
    }

    let cover: Blob | null = null;
    let lyrics: string | null = null;
    const limit = Math.min(bytes.length, tagSize + 10);
    while (offset + 10 <= limit) {
        const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding 区结束
        const size = version === 4 ? syncSafe(view, offset + 4) : view.getUint32(offset + 4);
        if (size <= 0 || offset + 10 + size > limit) break;
        const data = bytes.subarray(offset + 10, offset + 10 + size);
        if (id === 'APIC' && !cover) cover = parseApic(data);
        else if (id === 'USLT' && !lyrics) lyrics = parseUslt(data);
        offset += 10 + size;
        if (cover && lyrics) break;
    }
    return { cover, lyrics };
}
