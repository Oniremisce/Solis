import type { ProviderLyricsResult } from '../../types/onlineMusic';
import { parseLyricsByFormat, parseYRC } from '../../utils/lyrics/parserCore';
import { isPureMusicLyricText } from '../../utils/lyrics/pureMusic';

// src/services/onlineMusic/qishuiLyrics.ts
// 汽水的逐字歌词格式是 `[行起始,行时长]<字偏移,字时长,0>字`，与网易 YRC 差两点：
// word 标签的括号，以及字时间是相对行首的偏移（YRC 用绝对毫秒）。转换时一并修正。
// 纯文本行（无逐字标签）回落到普通 LRC 解析。

/** 把汽水逐字文本转成 YRC 文本；不是逐字格式时原样返回。 */
export const qishuiWordTextToYrc = (wordText: string): string => {
    if (!/<\d+,\d+,\d+>/.test(wordText)) return wordText;
    // 汽水的字时间戳是相对行首的偏移（每行从 <0,...> 重新计数），YRC 需要绝对毫秒：
    // 逐行把每个字偏移加上行起始时间，否则 parseYRC 的时间轴全错、逐字渲染回退逐句。
    return wordText
        .split(/\r?\n/)
        .map((line) => {
            const head = line.match(/^\[(\d+),(\d+)\]/);
            if (!head) return line.replace(/<(\d+,\d+,\d+)>/g, '($1)');
            const lineStart = parseInt(head[1], 10);
            return line.replace(/<(\d+),(\d+),(\d+)>/g, (_, offset: string, duration: string, flag: string) => (
                `(${lineStart + parseInt(offset, 10)},${duration},${flag})`
            ));
        })
        .join('\n');
};

/** 去掉时间轴得到纯文本（主歌词 / 纯音乐判定用）。 */
export const qishuiPlainTextOf = (wordText: string): string => (
    wordText
        .split(/\r?\n/)
        .map(line => line.replace(/^\[\d+,\d+\]/, '').replace(/<\d+,\d+,\d+>/g, '').trim())
        .filter(Boolean)
        .join('\n')
);

export function parseQishuiLyrics(wordText: string): ProviderLyricsResult {
    const mainText = qishuiPlainTextOf(wordText);
    if (!wordText.trim()) {
        return { lyrics: null, mainText, isPureMusic: true };
    }

    const yrcText = qishuiWordTextToYrc(wordText);
    const wordLyrics = yrcText !== wordText ? parseYRC(yrcText) : null;
    const lyrics = wordLyrics?.lines.length ? wordLyrics : parseLyricsByFormat('lrc', mainText);
    return {
        lyrics: lyrics.lines.length ? lyrics : null,
        mainText,
        wordByWordText: wordLyrics?.lines.length ? wordText : undefined,
        isPureMusic: !mainText || isPureMusicLyricText(mainText),
    };
}
