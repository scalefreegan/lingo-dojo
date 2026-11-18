/* The sounds of Mandarin's parts, for the character card's speaker buttons
 * and its sound chart (CharCard.tsx, SoundChart.tsx): the 37 zhuyin symbols
 * and the tones, each voiced through an exemplar character, and the split
 * of one reading into its initial, final and tone. Pure (no pinyin-pro, no
 * DOM), so scripts/tests/sounds.test.mjs covers it under node --test; the
 * exemplar index for whole readings is built in zh.ts from these helpers.
 *
 * Why exemplars: text-to-speech can't be asked for "the sound ㄅ" or "the
 * second reading of 行"; given a lone character it says that character's
 * usual reading. So every sound is a character whose every reading is that
 * sound (tone aside for a symbol), and the voice that says it is the
 * learner's own (/api/voice/sound, cached on disk per user). */

import { pinyinToZhuyin } from "./script.ts";

export type SoundGroup = "initial" | "medial" | "final";

export interface ZhuyinSound {
  symbol: string;
  /** Its pinyin spelling (the medials' y/w/yu forms after a slash). */
  pinyin: string;
  group: SoundGroup;
  /** The character said for it, traditional (zh.ts `simplified` gives the
   *  simplified form for a mainland learner: they read the same). */
  char: string;
  /** What the character sounds as, in zhuyin without its tone: the
   *  symbol's own name syllable (ㄅ is said ㄅㄛ), or for ㄝ and ㄥ, which
   *  never stand alone in everyday words, a syllable that has them. */
  sound: string;
}

/* The classroom's name syllables, with every reading of each character
 * checked against pinyin-pro (scripts/tests/sounds.test.mjs). Changed from
 * the usual chart where its character has another reading that TTS could
 * say: ㄉ 得 (dé, děi, de) → 德; ㄌ 勒 (lè, lēi) → 叻 (uncommon, but read
 * only lè); ㄏ 喝 (hē, hè, yè) → 河; ㄙ 思 (sī, sāi) → 絲; ㄛ 喔 (wō, ō) → 噢.
 * ㄝ and ㄟ were both 欸, which pinyin-pro reads ǎi, ēi, ế … (and no character
 * is read only ê or only ei): ㄝ is heard in 耶 (ㄧㄝ), ㄟ in 黑 (ㄏㄟ). ㄥ's
 * 鞥 is read only ēng but is too rare to trust a voice with: ㄥ is heard in
 * 燈 (ㄉㄥ). ㄈ keeps 佛, the one exception: no character is read only fo,
 * and 佛's usual reading (the one a voice says alone) is fó. */
export const ZHUYIN_SOUNDS: readonly ZhuyinSound[] = [
  { symbol: "ㄅ", pinyin: "b", group: "initial", char: "玻", sound: "ㄅㄛ" },
  { symbol: "ㄆ", pinyin: "p", group: "initial", char: "坡", sound: "ㄆㄛ" },
  { symbol: "ㄇ", pinyin: "m", group: "initial", char: "摸", sound: "ㄇㄛ" },
  { symbol: "ㄈ", pinyin: "f", group: "initial", char: "佛", sound: "ㄈㄛ" },
  { symbol: "ㄉ", pinyin: "d", group: "initial", char: "德", sound: "ㄉㄜ" },
  { symbol: "ㄊ", pinyin: "t", group: "initial", char: "特", sound: "ㄊㄜ" },
  { symbol: "ㄋ", pinyin: "n", group: "initial", char: "訥", sound: "ㄋㄜ" },
  { symbol: "ㄌ", pinyin: "l", group: "initial", char: "叻", sound: "ㄌㄜ" },
  { symbol: "ㄍ", pinyin: "g", group: "initial", char: "哥", sound: "ㄍㄜ" },
  { symbol: "ㄎ", pinyin: "k", group: "initial", char: "科", sound: "ㄎㄜ" },
  { symbol: "ㄏ", pinyin: "h", group: "initial", char: "河", sound: "ㄏㄜ" },
  { symbol: "ㄐ", pinyin: "j", group: "initial", char: "基", sound: "ㄐㄧ" },
  { symbol: "ㄑ", pinyin: "q", group: "initial", char: "欺", sound: "ㄑㄧ" },
  { symbol: "ㄒ", pinyin: "x", group: "initial", char: "希", sound: "ㄒㄧ" },
  { symbol: "ㄓ", pinyin: "zh", group: "initial", char: "知", sound: "ㄓ" },
  { symbol: "ㄔ", pinyin: "ch", group: "initial", char: "吃", sound: "ㄔ" },
  { symbol: "ㄕ", pinyin: "sh", group: "initial", char: "詩", sound: "ㄕ" },
  { symbol: "ㄖ", pinyin: "r", group: "initial", char: "日", sound: "ㄖ" },
  { symbol: "ㄗ", pinyin: "z", group: "initial", char: "資", sound: "ㄗ" },
  { symbol: "ㄘ", pinyin: "c", group: "initial", char: "雌", sound: "ㄘ" },
  { symbol: "ㄙ", pinyin: "s", group: "initial", char: "絲", sound: "ㄙ" },
  { symbol: "ㄧ", pinyin: "i / y", group: "medial", char: "衣", sound: "ㄧ" },
  { symbol: "ㄨ", pinyin: "u / w", group: "medial", char: "烏", sound: "ㄨ" },
  { symbol: "ㄩ", pinyin: "ü / yu", group: "medial", char: "迂", sound: "ㄩ" },
  { symbol: "ㄚ", pinyin: "a", group: "final", char: "啊", sound: "ㄚ" },
  { symbol: "ㄛ", pinyin: "o", group: "final", char: "噢", sound: "ㄛ" },
  { symbol: "ㄜ", pinyin: "e", group: "final", char: "鵝", sound: "ㄜ" },
  { symbol: "ㄝ", pinyin: "ê", group: "final", char: "耶", sound: "ㄧㄝ" },
  { symbol: "ㄞ", pinyin: "ai", group: "final", char: "哀", sound: "ㄞ" },
  { symbol: "ㄟ", pinyin: "ei", group: "final", char: "黑", sound: "ㄏㄟ" },
  { symbol: "ㄠ", pinyin: "ao", group: "final", char: "熬", sound: "ㄠ" },
  { symbol: "ㄡ", pinyin: "ou", group: "final", char: "歐", sound: "ㄡ" },
  { symbol: "ㄢ", pinyin: "an", group: "final", char: "安", sound: "ㄢ" },
  { symbol: "ㄣ", pinyin: "en", group: "final", char: "恩", sound: "ㄣ" },
  { symbol: "ㄤ", pinyin: "ang", group: "final", char: "昂", sound: "ㄤ" },
  { symbol: "ㄥ", pinyin: "eng", group: "final", char: "燈", sound: "ㄉㄥ" },
  { symbol: "ㄦ", pinyin: "er", group: "final", char: "兒", sound: "ㄦ" },
];

const BY_SYMBOL = new Map(ZHUYIN_SOUNDS.map((s) => [s.symbol, s]));

/** The table's entry for one zhuyin symbol, or undefined. */
export const zhuyinSound = (symbol: string): ZhuyinSound | undefined => BY_SYMBOL.get(symbol);

export type Tone = 1 | 2 | 3 | 4 | 5;

export interface ToneSound {
  tone: Tone;
  name: string;
  /** The tone's zhuyin mark (the first tone is unmarked in print; ˉ here). */
  mark: string;
  /** The tone on ma, in pinyin. */
  pinyin: string;
  /** What is said for it, traditional. */
  text: string;
}

/* 媽 麻 馬 罵: each read only mā, má, mǎ, mà. The neutral tone has no
 * character of its own (嗎 is also má and mǎ, and a voice saying it alone
 * may pick either): it is heard as the second syllable of 媽媽 (mā ma). */
export const TONE_SOUNDS: readonly ToneSound[] = [
  { tone: 1, name: "1st tone", mark: "ˉ", pinyin: "mā", text: "媽" },
  { tone: 2, name: "2nd tone", mark: "ˊ", pinyin: "má", text: "麻" },
  { tone: 3, name: "3rd tone", mark: "ˇ", pinyin: "mǎ", text: "馬" },
  { tone: 4, name: "4th tone", mark: "ˋ", pinyin: "mà", text: "罵" },
  { tone: 5, name: "neutral tone", mark: "˙", pinyin: "ma", text: "媽媽" },
];

const TONE_OF_MARK: Record<string, Tone> = { "ˊ": 2, "ˇ": 3, "ˋ": 4, "˙": 5 };
const TONE_MARK_RE = /[ˉˊˇˋ˙]/g;

/** A zhuyin spelling without its tone mark. */
export const untoned = (zhuyin: string): string => zhuyin.replace(TONE_MARK_RE, "");

/** Pinyin initials by their zhuyin symbol. */
const INITIAL_PINYIN = new Map(ZHUYIN_SOUNDS.filter((s) => s.group === "initial").map((s) => [s.symbol, s.pinyin]));

export interface SyllableParts {
  /** The zhuyin as printed (˙ first for the neutral tone). */
  zhuyin: string;
  /** Its symbols, without the tone mark, in order. */
  symbols: string[];
  tone: Tone;
  /** The pinyin initial and its zhuyin symbol; null for a syllable with
   *  none (an, yi, wu: the y and w are spelling, part of the final). */
  initial: { pinyin: string; zhuyin: string } | null;
  /** The rest, in pinyin as written (tone mark included) and in zhuyin
   *  symbols. zhuyin is "" for zhi chi shi ri zi ci si, whose i is no sound
   *  of its own: the initial is the whole syllable. */
  final: { pinyin: string; zhuyin: string };
}

/** One reading (tone-marked pinyin: háng) split for the card's tappable
 *  parts, or null when it isn't a syllable pinyinToZhuyin knows. */
export function syllableParts(reading: string): SyllableParts | null {
  const zhuyin = pinyinToZhuyin(reading);
  if (!zhuyin) return null;
  const marks = zhuyin.match(TONE_MARK_RE) ?? [];
  const tone: Tone = (marks[0] && TONE_OF_MARK[marks[0]]) || 1;
  const symbols = [...untoned(zhuyin)];
  const written = reading.normalize("NFC");
  const py = INITIAL_PINYIN.get(symbols[0] ?? "");
  // Initials are plain letters (the tone mark is always on the final), so
  // the spelling splits at the initial's length.
  if (py && written.toLowerCase().startsWith(py)) {
    return { zhuyin, symbols, tone, initial: { pinyin: written.slice(0, py.length), zhuyin: symbols[0] }, final: { pinyin: written.slice(py.length), zhuyin: symbols.slice(1).join("") } };
  }
  return { zhuyin, symbols, tone, initial: null, final: { pinyin: written, zhuyin: symbols.join("") } };
}

/* ------------------------------ exemplar index ----------------------------- */

/** Big5's "frequently used" block (0xA440–0xC67E): Taiwan's 5,401 common
 *  traditional characters. */
function big5Common(): string[] {
  const dec = new TextDecoder("big5");
  const out: string[] = [];
  for (let hi = 0xa4; hi <= 0xc6; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo > 0x7e && lo < 0xa1) continue;
      if (hi === 0xc6 && lo > 0x7e) break;
      const c = dec.decode(new Uint8Array([hi, lo]));
      if ([...c].length === 1 && c !== "�") out.push(c);
    }
  }
  return out;
}

/** GB 2312's level 1 (rows 16–55): the mainland's 3,755 most used
 *  simplified characters. */
function gb2312Level1(): string[] {
  const dec = new TextDecoder("gbk");
  const out: string[] = [];
  for (let hi = 0xb0; hi <= 0xd7; hi++) {
    // Row 55 ends at 0xD7F9; GBK fills the five cells after it.
    for (let lo = 0xa1; lo <= (hi === 0xd7 ? 0xf9 : 0xfe); lo++) {
      const c = dec.decode(new Uint8Array([hi, lo]));
      if ([...c].length === 1 && c !== "�") out.push(c);
    }
  }
  return out;
}

/** The characters to find exemplars among: common ones in the learner's
 *  script (an exemplar the learner may know, in the form they read), read
 *  from the browser's own legacy decoders rather than shipped as data.
 *  Empty where the decoder is missing. */
export function commonChars(traditional: boolean): string[] {
  try {
    return traditional ? big5Common() : gb2312Level1();
  } catch {
    return [];
  }
}

export interface ExemplarIndex {
  /** A character read only `reading` (tone-marked pinyin), or null. */
  exact(reading: string): string | null;
  /** A character every reading of which is `zhuyin` (untoned symbols),
   *  one read only one way first, or null. */
  sound(zhuyin: string): string | null;
}

/**
 * The exemplar index over `candidates`, given each one's readings (zh.ts
 * charReadings). The first candidate found wins, so the candidate order
 * (stroke order for Big5, pinyin order for GB 2312) decides between equals.
 */
export function buildExemplarIndex(candidates: Iterable<string>, readingsOf: (ch: string) => string[]): ExemplarIndex {
  const exact = new Map<string, string>();
  const single = new Map<string, string>();
  const several = new Map<string, string>();
  for (const ch of candidates) {
    const rs = readingsOf(ch);
    if (!rs.length) continue;
    if (rs.length === 1 && !exact.has(rs[0])) exact.set(rs[0], ch);
    const sounds = new Set(rs.map((r) => untoned(pinyinToZhuyin(r) ?? "?")));
    if (sounds.size !== 1) continue;
    const [s] = sounds;
    if (s === "?") continue;
    const into = rs.length === 1 ? single : several;
    if (!into.has(s)) into.set(s, ch);
  }
  return {
    exact: (r) => exact.get(r.normalize("NFC")) ?? null,
    sound: (z) => single.get(z) ?? several.get(z) ?? null,
  };
}
