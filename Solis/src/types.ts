import type { LineRenderHints } from './utils/lyrics/renderHints';
import type { MediaId, PlaybackSourceRef, ProviderCatalogRef } from './types/onlineMusic';

// src/types.ts — TV 壳的核心领域类型。
// 汽水内核所需的最小子集（与实现保持一致），
// 不含本地音乐库 / Navidrome / framer-motion 等手机版专属类型；后续分期按需再补。

export interface LyricRuby {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
}

export interface LyricSyllable {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  endsWithSpace?: boolean;
  ruby?: LyricRuby[];
  obscene?: boolean;
  emptyBeat?: number;
}

export interface LyricAlternateText {
  role: 'translation' | 'romanization' | string;
  language?: string;
  text: string;
  syllables?: LyricSyllable[];
}

export interface Word {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  syllables?: LyricSyllable[];
}

export interface LyricBackgroundVocal {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  words: Word[];
  agentId?: string;
  translation?: string;
  romanization?: string;
  alternateTexts?: LyricAlternateText[];
}

export interface LyricAgent {
  id: string;
  name?: string;
  type?: string;
}

export interface Line {
  words: Word[];
  startTime: number;
  endTime: number;
  fullText: string;
  translation?: string;
  id?: string;
  agentId?: string;
  songPart?: string;
  blockIndex?: number;
  romanization?: string;
  alternateTexts?: LyricAlternateText[];
  backgroundVocal?: LyricBackgroundVocal;
  backgroundVocals?: LyricBackgroundVocal[];
  renderHints?: LineRenderHints;
  isChorus?: boolean;
  chorusEffect?: 'bars' | 'circles' | 'beams';
  // User-saved fine word boundaries for fullText, baked in upstream by the lyric setter.
  // join('') must equal fullText. When present it wins over every automatic segmentation.
  wordSegments?: string[];
  // Automatic word boundaries for fullText (Intl.Segmenter based), baked in by the
  // lyric setter once its engines have loaded. Used when there is no wordSegments; absent until
  // then, and the line falls back to plain Intl.Segmenter.
  autoWordSegments?: string[];
}

export interface LyricData {
  lines: Line[];
  title?: string;
  artist?: string;
  isWordByWord?: boolean;
  ttml?: {
    timingMode?: 'Word' | 'Line';
    agents?: Record<string, LyricAgent>;
  };
}

export interface Artist {
  id: MediaId;
  name: string;
  entityId?: string;
  catalogRef?: ProviderCatalogRef;
}

export interface Album {
  id: MediaId;
  name: string;
  coverUrl?: string;
  entityId?: string;
  catalogRef?: ProviderCatalogRef;
}

export interface SongPrivilege {
  id?: number;
  fee?: number;
  payed?: number;
  st?: number;
  pl?: number;
  dl?: number;
  flag?: number;
  cs?: boolean;
}

export interface NoCopyrightRecommendation {
  type?: number;
  typeDesc?: string;
  songId?: string | number;
  thirdPartySong?: unknown | null;
  expInfo?: unknown | null;
}

export type LyricProviderSource = 'netease' | 'qq' | 'kugou' | 'amll' | 'qishui';
export type AmllDbPlatform = 'ncm' | 'qq';

export interface ReplayGainInfo {
  /** ReplayGain gain values in decibels. */
  trackGain?: number;
  albumGain?: number;
  /** ReplayGain peak values as positive linear ratios. */
  trackPeak?: number;
  albumPeak?: number;
}

export interface SongResult {
  id: MediaId;
  name: string;
  artists: Artist[];
  album: Album;
  durationMs: number;
  isPureMusic?: boolean;
  aliases?: string[];
  translatedNames?: string[];
  t?: 0 | 1 | 2;
  sourceType?: 'netease' | 'cloud';
  sourceRef?: PlaybackSourceRef;
  /** Identity of the concrete bytes selected for playback; used to reject stale derived media. */
  playbackSourceRevision?: string;
  fee?: number;
  noCopyrightRcmd?: NoCopyrightRecommendation | null;
  resourceState?: boolean;
  privilege?: SongPrivilege;
  onlineLyricsState?: OnlineLyricsState;
  matchedLyricsSource?: LyricProviderSource;
  matchedLyricsProviderPlatform?: AmllDbPlatform;
  replayGain?: ReplayGainInfo;
  qqMid?: string;
  kgHash?: string;
  amllDbPlatform?: AmllDbPlatform;
}

export interface OnlineLyricsState {
  lyricsSource: 'online' | 'imported';
  importedLyrics?: LyricData | null;
  importedLyricsName?: string | null;
  hasOnlineOverride?: boolean;
  onlineOverrideLyrics?: LyricData | null;
  matchedSongId?: MediaId;
  matchedIsPureMusic?: boolean;
  matchedLyricsSource?: LyricProviderSource;
  matchedLyricsProviderPlatform?: AmllDbPlatform;
}

// Extend SongResult to support local files and Navidrome files
export interface UnifiedSong extends SongResult {
  sourceRef: PlaybackSourceRef;
  isLocal?: boolean;
  isNavidrome?: boolean;
  navidromeData?: any;
}
