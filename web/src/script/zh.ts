/* The Mandarin reader: pinyin for Chinese text, word by word, from
 * pinyin-pro (MIT), with traditional text spelt in simplified characters
 * first by OpenCC's tables (t2s.ts). Loaded on demand (ruby.tsx), so a
 * session in any other language, or with the aid off, never downloads it
 * (nor OpenCC's tables). Deterministic: the same text always reads the
 * same, with no model in the loop.
 *
 * Traditional text is read through its simplified spelling, one character
 * for one, because the word dictionary is simplified: 銀行 must be seen as
 * 银行 to read yín háng, 蘋果 as 苹果 to read píng guǒ. OpenCC picks the
 * simplified form by the word where a character has several (蘋, 瞭, 乾,
 * 著, 徵, 間: t2s.ts). A traditional character whose simplified form it
 * shares with another (髮 / 發 → 发) then keeps a reading of its own
 * (ownReading). What no dictionary word settles is read by a frequency
 * prior (zh-freq.ts: the common reading, and common words). A few words the library misreads in either script are
 * corrected (READING_FIXES), a zh-TW text then takes Taiwan's standard
 * readings where they differ (script.ts TAIWAN_READINGS), and the
 * particles 地 得 兒 are read by their neighbours (particleDe), as are a few
 * characters in common phrases no dictionary has (contextRules). Tone sandhi
 * is off: the marks are each character's own tone, as dictionaries and
 * zhuyin textbooks print them (不是 bù shì, 一個 yī gè). */

import { OutputFormat, customPinyin, pinyin, segment } from "pinyin-pro";
import { TAIWAN_READINGS, isHan, isPinyin, isTaiwan, particleDe, taiwanize } from "./script.ts";
import { buildExemplarIndex, commonChars, type ExemplarIndex } from "./sounds.ts";
import { mergedWith, scriptOf, simplifyAligned } from "./t2s.ts";
import { ANYWHERE, BLOCK, FALLBACK, RANKS, WORDS } from "./zh-freq.ts";
import { COMMON_WORDS } from "./zh-words.ts";
import { NEUTRAL_WORDS } from "./zh-neutral.ts";
import { STANDARD_READINGS, UNSETTLED_WORDS } from "./zh-standard.ts";

/** Everyday words the library's dictionary misreads, in either script
 *  (it reads the simplified spelling), as CC-CEDICT and the Ministry of
 *  Education's dictionary read them: found by the CC-CEDICT sweep
 *  (scripts/pinyin-sweep.mjs, ld-37t) and each pinned in t2s.test.mjs.
 *  Given to pinyin-pro as custom words, which win over its segmentation:
 *  an entry matches wherever its characters stand in a row, even across
 *  two words (和面 would read 牛奶和面包 huó, 不当 我不当老师 dàng, 有为
 *  我有为你 wéi, 倒是 他不倒是 dào). So an entry stays only if no such
 *  run reads otherwise: each was checked against every CC-CEDICT word that
 *  holds it or overlaps either end of it, and inside frames of common
 *  words (我 你 他 不 很 有 是 在 和 的 了 也 都). Dropped for that: 和面,
 *  不当, 有为, 倒是, 倒立, 假日 (弄虚作假日益), 待会儿 (再等待会儿), 种植
 *  (这种植物), 炸鸡 (爆炸), 油炸 (汽油炸弹), 受难 (感受难以), 弹珠 (反弹),
 *  狗血 (狗血压) and 不着 alone (不着痕迹 zhuó); the long tail is ld-zid.
 *  Deliberately short. */
export const READING_FIXES: Record<string, string> = {
  嚣: "xiāo", // the character itself (嚣张, 喧嚣, 叫嚣, 甚嚣尘上): the library has áo
  睡不着: "shuì bù zháo", // V不着, can't manage to: zháo, never the zhe of 看着
  找不着: "zhǎo bù zháo",
  用不着: "yòng bù zháo", // 用不着手机 (not 着手 zhuó shǒu)
  犯不着: "fàn bù zháo",
  处理不当: "chǔ lǐ bù dàng", // improper; 不当 alone is often 不 + 当 dāng
  年轻有为: "nián qīng yǒu wéi", // 有为 alone is often 有 + 为 wèi
  挨饿: "ái è",
  挨打: "ái dǎ",
  简单明了: "jiǎn dān míng liǎo", // 明了 alone would also catch 说明了 le
  北斗星: "běi dǒu xīng", // 北斗 alone would also catch 华北斗争 dòu
  北斗七星: "běi dǒu qī xīng",
};

/* --------------------------- the frequency prior -------------------------- */

/** The frequency prior (zh-freq.ts, built by scripts/gen-zh-freq.mjs from
 *  CC-CEDICT weighted by a word-frequency list; ld-op2). The library's
 *  word dictionary holds only the words whose reading is not a character's
 *  default, so a character in a one-character segment was settled by no
 *  word: it is read by default. There the prior chooses instead:
 *  - `ranks`: a character's readings, most frequent first (行: xíng, háng),
 *    then the rare ones (`rare`). A character standing alone (no Chinese
 *    character beside it) takes the first, as does the character card.
 *  - `fallback`: the reading for a character inside a longer run that no
 *    dictionary word settled, where the words the library doesn't know
 *    mostly read it otherwise than its default (量 liàng, not liáng).
 *  - `words`: common words the reader still gets wrong, applied only where
 *    the word is the whole run of Chinese characters (a bank phrase, a
 *    gloss, a card), so none can misfire across a word boundary.
 *  - `anywhere`: those that are safe inside a sentence too (audited by
 *    the builder against every word that can overlap one, by frequency),
 *    keyed by their simplified spelling. Unlike READING_FIXES they are
 *    not the library's custom words, which match wherever the characters
 *    stand: one is applied only where it cuts through no word of the
 *    library's dictionary, and not beside a `block` word, a common word
 *    that would be misread (种植 not in 这种植物, 局长 not in 局长期).
 *  A reading that a dictionary word of the library's settles is never
 *  touched, except by an entry marked a correction (`fixes`, "!" in the
 *  table): one where CC-CEDICT reads that exact word otherwise than the
 *  library's dictionary does (五行 wǔ xíng, not háng). An `anywhere` word
 *  must also stand between two word boundaries of the platform's own word
 *  segmenter (wordStarts), so none is read across two words (五行 not in
 *  第五行, 局长 not in 中情局长期). */
export interface Prior {
  /** The `words` / `anywhere` keys allowed to replace a dictionary word's reading. */
  fixes: Set<string>;
  ranks: Map<string, string[]>;
  rare: Map<string, string[]>;
  fallback: Map<string, string>;
  words: Map<string, string[]>;
  anywhere: Map<string, string[]>;
  /** ">长=zhǎng" → the words that, starting on a word's last 长 (read
   *  zhǎng there), veto it; "<种=zhòng" → those ending on its first 种. */
  block: Map<string, Iterable<string>>;
}
const pairs = (s: string) => (s ? s.split("|") : []);
/** A prior from the tables' strings ("量liàng,liáng;liang|…", "量liàng|…",
 *  "向量=xiàng liàng|…"): what zh-freq.ts holds and the builder writes. */
export function parsePrior(t: { RANKS: string; FALLBACK: string; WORDS: string; ANYWHERE: string; BLOCK: string }): Prior {
  const p: Prior = { ranks: new Map(), rare: new Map(), fallback: new Map(), words: new Map(), anywhere: new Map(), block: new Map(), fixes: new Set() };
  const entry = (table: Map<string, string[]>, e: string) => {
    const [w, r] = e.split("=");
    if (r.startsWith("!")) p.fixes.add(w);
    table.set(w, r.replace(/^!/, "").split(" "));
  };
  for (const e of pairs(t.RANKS)) {
    const [ch] = e;
    const [usual, rare = ""] = e.slice(ch.length).split(";");
    p.ranks.set(ch, usual.split(","));
    if (rare) p.rare.set(ch, rare.split(","));
  }
  for (const e of pairs(t.FALLBACK)) {
    const [ch] = e;
    p.fallback.set(ch, e.slice(ch.length));
  }
  for (const e of pairs(t.WORDS)) entry(p.words, e);
  for (const e of pairs(t.ANYWHERE)) entry(p.anywhere, e);
  for (const e of pairs(t.BLOCK)) {
    const at = e.indexOf(":");
    p.block.set(e.slice(0, at), e.slice(at + 1).split(","));
  }
  return p;
}
let prior: Prior = parsePrior({ RANKS, FALLBACK, WORDS, ANYWHERE, BLOCK });
/** The shipped prior: the common words (applyCommon) go with it, and are
 *  left out while the builder or a test swaps in another (setPrior). */
const SHIPPED = prior;
let anywhereLongest = 0;
const measure = () => (anywhereLongest = Math.max(0, ...[...prior.anywhere.keys()].map((w) => [...w].length)));
measure();
customPinyin(READING_FIXES);
/** The prior in use. */
export const currentPrior = (): Prior => prior;
/** Swap the prior (null: none at all): for the builder, which measures the
 *  reader without it, and the tests. Empties the caches. */
export function setPrior(p: Prior | null): void {
  if (p && !p.fixes) p.fixes = new Set();
  prior = p ?? parsePrior({ RANKS: "", FALLBACK: "", WORDS: "", ANYWHERE: "", BLOCK: "" });
  measure();
  cache.clear();
  exemplarIndexes.clear();
}
/** A character's entry in a prior table: its own, else its simplified
 *  form's where it is simply that form's traditional spelling (the tables
 *  are sparse for traditional characters): never for one that shares the
 *  form with another (髮 is not 发's fā, which is 發's). */
const priorFor = <T>(table: Map<string, T>, ch: string, simp: string): T | undefined =>
  table.get(ch) ?? (simp === ch || mergedWith(ch, simp).length ? undefined : table.get(simp));

/** A text read: `readings` per code point (null for anything that is not
 *  a Chinese character with a reading), and `settled`: whether a
 *  dictionary word or a rule settled that reading (a multi-character
 *  segment of the library's, a correction, OpenCC's choice of form for 著
 *  and 乾, a particle rule). An unsettled character was read by default or
 *  by the prior; when it has more than one reading it is what
 *  ambiguousChars reports. */
export interface Detail {
  readings: (string | null)[];
  settled: boolean[];
  /** Read as part of a word of the library's dictionary (a segment of two
   *  or more characters, a correction's included): what neither the prior
   *  nor a reading hint may change. */
  dict: boolean[];
  /** In the same dictionary word as the character before it. */
  joined: boolean[];
  /** Where a word starts by the platform's word segmenter (one flag per
   *  code point and one for the end); null where there is no segmenter. */
  starts: boolean[] | null;
  /** Read by a correction (ld-4i2, Corrections): the learner's own
   *  ("mine", a correction or a confirmation), the shared list's
   *  ("shared"), or the recap's suggestion for this learner ("suggested",
   *  which leaves the reading uncertain); null where none applied. */
  fixed: (FixKind | null)[];
  /** Left at its usual reading by a rule that couldn't tell (giveBack:
   *  还 before 钱 / 书 / 你 that may be hái or huán): marked uncertain
   *  whatever its ranks say, until a person settles it. */
  doubt: boolean[];
  /** The neutral tone was put there by applyNeutral (ld-azb): the same
   *  syllable's full tone is no other reading, and a hint may not undo it. */
  neutral: boolean[];
}

/** Options for a read: `cache: false` neither reads nor fills the cache;
 *  `corrections` replaces the browser's (setCorrections) for this read
 *  (the server passes a learner's own, never the module's), and is never
 *  cached. */
export interface ReadOpts {
  cache?: boolean;
  corrections?: Corrections | null;
}

let segmenter: Intl.Segmenter | null | undefined;
/** Word boundaries by Intl.Segmenter (ICU's dictionary segmenter: 很|重要,
 *  中情局|长期|以来), per code point; null on a platform without one, where
 *  nothing that needs a boundary is applied. */
function wordStarts(cps: string[]): boolean[] | null {
  if (segmenter === undefined) segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("zh", { granularity: "word" }) : null;
  if (!segmenter) return null;
  const starts: boolean[] = new Array(cps.length + 1).fill(false);
  const at = new Map<number, number>();
  let n = 0;
  cps.forEach((c, k) => {
    at.set(n, k);
    n += c.length;
  });
  for (const s of segmenter.segment(cps.join(""))) {
    const k = at.get(s.index);
    if (k !== undefined) starts[k] = true;
  }
  starts[cps.length] = true;
  return starts;
}
/** The common words (zh-words.ts: wordfreq's top words that CC-CEDICT
 *  reads one way), by simplified spelling: each word's readings, the
 *  first the one applied, the others the same syllables with a neutral
 *  tone where CC-CEDICT lists both (东西 dōng xī / dōng xi). */
type CommonWord = {
  readings: string[][];
  trad: string[][] | null;
  /** A learner's standard reading (zh-standard.ts): written over the
   *  reader's choice, in zh-TW only where Taiwan agrees (`cnOnly` else). */
  standard?: { cnOnly: boolean; notBefore: string[]; notAfter: string[] };
};
const common = new Map<string, CommonWord>(
  COMMON_WORDS.split("|")
    .filter(Boolean)
    .map((e) => {
      const [w, rest] = e.split("=");
      const [r, t] = rest.split("~");
      return [w, { readings: r.split("/").map((x) => x.split(" ")), trad: t ? t.split(",").map((x) => [...x]) : null }];
    }),
);
/** Words CC-CEDICT reads two ways with no standard reading: always marked. */
const unsettledWords = new Set(UNSETTLED_WORDS);
// The words CC-CEDICT reads two ways, by their standard reading (PR #67).
for (const s of STANDARD_READINGS) {
  common.set(s.word, {
    readings: s.reading.split("/").map((x) => x.split(" ")),
    trad: s.trad ? [[...s.trad]] : null,
    standard: { cnOnly: !s.tw, notBefore: s.notBefore ?? [], notAfter: s.notAfter ?? [] },
  });
}
/** The neutral-tone words (zh-neutral.ts, ld-azb), by simplified spelling:
 *  the reader's reading with the neutral syllables put in. */
const neutralWords = new Map<string, string[]>(
  NEUTRAL_WORDS.split("|")
    .filter(Boolean)
    .map((e) => {
      const [w, r] = e.split("=");
      return [w, r.split(" ")];
    }),
);
const NEUTRAL_MAX = Math.max(1, ...[...neutralWords.keys()].map((w) => [...w].length));
/** The verbs a table word may follow inside one segmenter word (买东西,
 *  给朋友). */
const NEUTRAL_AFTER = "买卖拿带吃喝做给找要有没收送搬爱想看";
/** Off for scripts/pinyin-hsk-audit.mjs --write-neutral, which measures
 *  the reader without the table, and for tests of the reader without it. */
let neutralOn = true;
export function useNeutralWords(on: boolean): void {
  neutralOn = on;
  cache.clear();
}

/** Off only for scripts/gen-zh-words.mjs, which compares the reader
 *  without the list to CC-CEDICT. */
let commonOn = true;
export function useCommonWords(on: boolean): void {
  commonOn = on;
  cache.clear();
}

/**
 * The common words over one text's readings, in place (PR #67): every
 * run between word boundaries of the segmenter (one of its words, or
 * several: ICU splits the traditional 再|見) that is a common word, and
 * that cuts no word of the library's dictionary, is taken and settled
 * (never marked) where the reader agrees with CC-CEDICT:
 *   - a syllable read as CC-CEDICT reads it, or with the tone where
 *     CC-CEDICT has the neutral one (几个 jǐ gè), stays;
 *   - a doubled character CC-CEDICT reads neutral takes the neutral tone
 *     (谢谢 xiè xie, 星星 xīng xing, 刚刚 gāng gang): the reduplicated
 *     words, read alike in every word of the list;
 *   - another reading of a character with one reading (no rare one
 *     either), that nothing settled, takes CC-CEDICT's;
 *   - any other difference (a character of two ordinary readings the
 *     prior chose, 不当 dāng in 我不当老师, or with a rare one, 还给 hái
 *     in 我还给你做饭; a reading a dictionary word,
 *     rule or table entry settled) leaves the word to the reader: not
 *     taken, so the mark may show.
 * A word of zh-standard.ts (one CC-CEDICT reads two ways) takes its
 * standard reading whatever the reader chose (当天 dàng tiān), in zh-TW
 * only where Taiwan agrees.
 * The longest word wins where two start together. A person's correction
 * still outranks it (applyCorrections), and Taiwan's readings are laid
 * over it after (taiwanize).
 */
function applyCommon(cps: string[], simp: string[], joined: boolean[], starts: boolean[] | null, out: (string | null)[], settled: boolean[], tw: boolean, doubt: boolean[]): void {
  const edge = (k: number) => k >= cps.length || ((starts ? starts[k] : true) && !joined[k]);
  const bare = (r: string) => r === toneless(r);
  /** The reading at k for CC-CEDICT's `x`: the reader's, x, or undefined (a
   *  difference that leaves the word to the reader). */
  const take = (k: number, x: string, doubled: boolean): string | undefined => {
    const y = out[k];
    if (y === x) return y;
    if (y != null && bare(x) && toneless(y) === x) return doubled ? x : y;
    // Any second reading, a rare one included (还 huán), is the reader's call.
    const readings = (priorFor(prior.ranks, cps[k], simp[k])?.length ?? 0) + (priorFor(prior.rare, cps[k], simp[k])?.length ?? 0);
    if (settled[k] || readings > 1) return undefined;
    return x;
  };
  for (let i = 0; i < cps.length; ) {
    if (!isHan(cps[i]) || !edge(i)) {
      i++;
      continue;
    }
    let hit = 0;
    for (let e = Math.min(cps.length, i + COMMON_MAX); e >= i + 2 && !hit; e--) {
      if (!edge(e) || !cps.slice(i, e).every(isHan)) continue;
      if (unsettledWords.has(simp.slice(i, e).join(""))) {
        // Read two ways and no standard one (zh-standard.ts): the reader's
        // reading stands, marked, even where its dictionary had the word
        // (同行: tóng háng, a colleague, or tóng xíng, to travel together).
        // The doubt sits on the first character, so the mark is the word.
        for (let k = i; k < e; k++) settled[k] = false;
        doubt[i] = true;
        hit = e - i;
        break;
      }
      const c = common.get(simp.slice(i, e).join(""));
      if (!c || c.readings[0].length !== e - i) continue;
      // Written in traditional characters: one of the word's spellings
      // (散髮, hair, is no 散發 sàn fā).
      if (c.trad && !c.trad.some((t) => t.every((x, n) => cps[i + n] === x || cps[i + n] === simp[i + n]))) continue;
      if (c.standard) {
        // A standard reading (zh-standard.ts) is the word's, whatever the
        // reader chose; in zh-TW only where Taiwan reads it so.
        if (c.standard.cnOnly && tw) continue;
        // Part of a longer word the segmenter split (好事|者 hào shì zhě).
        const after = simp.slice(e).join("");
        if (c.standard.notBefore.some((x) => after.startsWith(x))) continue;
        // Or the end of a word before it the segmenter split (他不倒是:
        // ICU's 他不|倒是, where 不倒 may be the word).
        const before = simp.slice(0, i).join("");
        if (c.standard.notAfter.some((x) => before.endsWith(x))) continue;
        const now = out.slice(i, e);
        const r = c.readings.find((r) => r.every((x, n) => x === now[n])) ?? c.readings[0];
        r.forEach((x, n) => {
          out[i + n] = x;
          settled[i + n] = true;
        });
        hit = e - i;
        break;
      }
      for (const r of c.readings) {
        const got = r.map((x, n) => take(i + n, x, n > 0 && simp[i + n] === simp[i + n - 1]));
        if (got.some((x) => x === undefined)) continue;
        got.forEach((x, n) => {
          out[i + n] = x!;
          settled[i + n] = true;
        });
        hit = e - i;
        break;
      }
    }
    i += hit || 1;
  }
}
/** The longest common word, in characters (gen-zh-words.mjs MAX_CHARS). */
const COMMON_MAX = 6;

/** Whether a run of characters (simplified) is a word the reader knows of:
 *  a word of the library's dictionary (one segment: `joined` inside it),
 *  of the prior's tables, or of the common words. */
function knownWord(simp: string[], joined: boolean[], s: number, e: number): boolean {
  const key = simp.slice(s, e).join("");
  if (common.has(key) || prior.words.has(key) || prior.anywhere.has(key)) return true;
  for (let k = s + 1; k < e; k++) if (!joined[k]) return false;
  return !joined[e];
}

/** Personal pronouns ICU's dictionary joins to the character after them
 *  where no word stands (我还|书, 我还|你|钱, 我要|还|钱). */
const PRONOUNS = "我你他她它您咱";

/**
 * The segmenter's boundaries (wordStarts), opened after a pronoun that
 * begins a piece of two or more Chinese characters that is no word the
 * reader knows of (knownWord: 我还 is none, 我们 / 你好 are kept whole by
 * 们 / the common words), so a whole-word entry or a correction can start
 * on the character after it (还书 in 我还书). Only there: opening every
 * unknown piece (第五|行, 公安局长|时间) let the prior's words fire across
 * real words the reader's lists don't hold (五行 in 第五行, 局长 in
 * 公安局长时间), measured on the PR #63 sentence sets. Null without a
 * segmenter. Used where a word entry (the prior's `anywhere`) or a
 * correction may start or end; the mark's words stay the segmenter's own.
 */
function looseStarts(cps: string[], simp: string[], starts: boolean[] | null, joined: boolean[]): boolean[] | null {
  if (!starts) return null;
  const out = starts.slice();
  for (let s = 0; s < cps.length; ) {
    let e = s + 1;
    while (e < cps.length && !starts[e]) e++;
    if (e - s >= 2 && PRONOUNS.includes(simp[s]) && simp[s + 1] !== "们" && cps.slice(s, e).every(isHan) && !knownWord(simp, joined, s, e)) out[s + 1] = true;
    s = e;
  }
  return out;
}

const cache = new Map<string, Detail>();
const CACHE_MAX = 4000;

/** Whether `text` is in the cache: for the tests, which check that the
 *  server's reads (`cache: false`) leave nothing behind. */
export function readingCached(text: string, locale: string): boolean {
  return cache.has(`${isTaiwan(locale) ? "tw" : "cn"}\u0001${text}`);
}

/** Each code point of `text` read: its pinyin (tone marks) for a Chinese
 *  character, null for anything else. `cache: false` neither reads nor
 *  fills the cache: the server reads a learner's text this way, so no text
 *  it was asked to score outlives the request (server/pronunciation.ts). */
export function readCodePoints(text: string, locale: string, opts: ReadOpts = {}): (string | null)[] {
  return readDetail(text, locale, opts).readings;
}

/** readCodePoints with what settled each reading (Detail). */
export function readDetail(text: string, locale: string, { cache: wantCache = true, corrections: given }: ReadOpts = {}): Detail {
  const tw = isTaiwan(locale);
  const fixes = given === undefined ? active : given;
  const useCache = wantCache && given === undefined;
  const key = `${tw ? "tw" : "cn"}\u0001${text}`;
  const hit = useCache ? cache.get(key) : undefined;
  if (hit) return hit;
  const cps = [...text];
  const out: (string | null)[] = cps.map(() => null);
  const settled = cps.map(() => false);
  let fixed: (FixKind | null)[] = cps.map(() => null);
  let dict = settled;
  let joined = settled;
  let starts: boolean[] | null = null;
  const doubt = cps.map(() => false);
  const neutral = cps.map(() => false);
  if (cps.some(isHan)) {
    // A zh-TW profile's text is always read as traditional. A zh-CN one's
    // by its characters (t2s.ts scriptOf): simplified text (one with a
    // simplified-only character and no traditional-only one) is read as it
    // is, so OpenCC's t2s never re-maps it (打坏 stays huài, not 打坯 pī);
    // traditional text is converted; text that is neither (乾杯, 看著, 於是)
    // is converted with 著 read zhù unless its neighbours say otherwise.
    const script = tw ? "traditional" : scriptOf(text);
    const simp = script === "simplified" ? cps : simplifyAligned(text, { neutral: script === "neutral" });
    // 瞭 that OpenCC spells 了 (瞭解, 明瞭) is always liǎo; read as 了 the
    // library would make it le (明了 míng le) or a 了 after it liǎo (明了了).
    // So the library sees 瞭 there and the reading is set after.
    const liao = simp.map((s, k) => cps[k] === "瞭" && s === "了");
    const src = simp.map((s, k) => (liao[k] ? "瞭" : s)).join("");
    const items = pinyin(src, { type: "all", toneSandhi: false, nonZh: "spaced" });
    // One item per character (nonZh "spaced" keeps every other character
    // its own item too); walk them by their origin so an item that ever
    // covers two code points can't shift the rest.
    let i = 0;
    for (const it of items) {
      const n = [...it.origin].length || 1;
      if (it.isZh && n === 1 && isHan(cps[i] ?? "") && isPinyin(it.pinyin)) out[i] = liao[i] ? "liǎo" : ownReading(cps[i], simp[i], it.pinyin);
      i += n;
    }
    // The library's segments: a character in one of two or more was read
    // as part of a dictionary word (its own, or a correction's).
    // `joined[k]`: the character at k is in the same segment as the one
    // before it.
    joined = cps.map(() => false);
    i = 0;
    for (const seg of segment(src, { format: OutputFormat.AllSegment, toneSandhi: false, nonZh: "spaced" })) {
      const n = [...seg.origin].length || 1;
      if (n > 1 && isHan(cps[i] ?? "")) {
        for (let k = i; k < i + n && k < cps.length; k++) {
          settled[k] = true;
          joined[k] = k > i;
        }
      }
      i += n;
    }
    dict = settled.slice();
    starts = wordStarts(cps);
    // Where a word entry or a correction may start or end: the segmenter's
    // boundaries, and inside a piece of it that is no word anyone knows
    // (looseStarts: 我还|书 lets 还书 apply).
    const edges = looseStarts(cps, simp, starts, joined);
    applyPrior(cps, simp, liao, { joined, dict, starts: edges }, out, settled);
    if (commonOn && prior === SHIPPED) applyCommon(cps, simp, joined, starts, out, settled, tw, doubt);
    // The mainland's neutral tone (ld-azb); Taiwan keeps the full tones.
    if (!tw && neutralOn && prior === SHIPPED) applyNeutral(cps, simp, joined, edges, out, neutral);
    if (tw) taiwanize(text, out);
    const before = out.slice();
    particleDe(text, out);
    giveBack(cps, simp, dict, out, doubt);
    for (let k = 0; k < out.length; k++) if (out[k] !== before[k]) settled[k] = true;
    if (prior === SHIPPED) contextRules(cps, simp, dict, starts, out, settled, doubt);
    if (fixes) fixed = applyCorrections(cps, simp, { joined, starts: edges }, fixes, tw, out, settled);
  }
  const detail = { readings: out, settled, dict, joined, starts, fixed, doubt, neutral };
  if (!useCache) return detail;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, detail);
  return detail;
}

/**
 * The neutral tone in zh-CN (ld-azb): a word of zh-neutral.ts (the official
 * HSK 3.0 list prints the neutral tone and CC-CEDICT has it too: 朋友 péng
 * you, 告诉 gào su) between word boundaries of the segmenter takes it where
 * the reader gives the word's full tones. A word is changed only if each
 * syllable is the table's, or the table's neutral one with the tone on:
 * a reading a context rule or the prior chose otherwise leaves the whole
 * word alone. Nothing is settled or marked by it, and a person's
 * correction is laid over it after (applyCorrections).
 */
function applyNeutral(cps: string[], simp: string[], joined: boolean[], starts: boolean[] | null, out: (string | null)[], flag: boolean[]): void {
  const edge = (k: number) => k >= cps.length || ((starts ? starts[k] : true) && !joined[k]);
  // The segmenter makes 买东西 one word: a table word also starts right
  // after a one-character verb that opens the segmenter's word.
  const start = (k: number) => edge(k) || (k > 0 && NEUTRAL_AFTER.includes(simp[k - 1]) && edge(k - 1));
  for (let i = 0; i < cps.length; ) {
    let hit = 0;
    if (isHan(cps[i]) && start(i)) {
      for (let e = Math.min(cps.length, i + NEUTRAL_MAX); e >= i + 2 && !hit; e--) {
        if (!edge(e) || !cps.slice(i, e).every(isHan)) continue;
        const r = neutralWords.get(simp.slice(i, e).join(""));
        if (!r || r.length !== e - i) continue;
        const ok = r.every((x, n) => out[i + n] === x || (out[i + n] != null && x === toneless(x) && toneless(out[i + n]!) === x));
        if (!ok) continue;
        r.forEach((x, n) => {
          if (out[i + n] !== x) flag[i + n] = true;
          out[i + n] = x;
        });
        hit = e - i;
      }
    }
    i += hit || 1;
  }
  // 东西 is dōng xi (a thing) only where the words around it say so: after a
  // verb or measure word that takes an object (买东西, 什么东西, 这个东西, 好东西)
  // and not before a character that makes it the compass (东西南北, 东西方向,
  // 东西部). Anywhere else it keeps dōng xī, as before (CC-CEDICT: both).
  for (let i = 1; i + 1 < cps.length; i++) {
    if (simp[i] !== "东" || simp[i + 1] !== "西" || out[i] !== "dōng" || out[i + 1] !== "xī") continue;
    if (THING_BEFORE.includes(simp[i - 1]) && !(i + 2 < cps.length && COMPASS_AFTER.includes(simp[i + 2]))) {
      out[i + 1] = "xi";
      flag[i + 1] = true;
    }
  }
}
/** Before 东西 "a thing": 买卖拿带吃喝找偷丢要有没好坏些件样点个么的. */
const THING_BEFORE = "买卖拿带吃喝找偷丢要有没好坏些件样点个么的";
/** After 东西 the compass: 南北方向部边两岸侧半球走. */
const COMPASS_AFTER = "南北方向部边两岸侧半球走";

/** What may follow 钱 / 书 after 还 for it to be huán (give back): a
 *  particle, the 给 of whom, 的时候, a number. */
const AFTER_GIVEN = "了吗吧呢啊给";
const NUMERALS = "一二两三四五六七八九十百千万几半0123456789０１２３４５６７８９";

/**
 * 还 huán, give back (PR #67 reviews), in place: huán is under 5% of 还's
 * uses, so the prior reads hái, and ICU segments 我还|钱 so no word could
 * settle it. 还 before 钱 or 书 (or 你 then 钱 / 书, or 你 alone) is read
 * huán only where the phrase ends there: the text's end, punctuation or
 * another non-Chinese character, a particle or 给 (AFTER_GIVEN), 的时候,
 * or a number (我还钱, 我要还钱, 你还书了吗, 还你钱, 还钱三百). Anywhere
 * else it is left hái and marked (`doubt`): 还钱不够, 还书包里, 还书店,
 * 还你一个 can be either, and the learner or the recap settles it. Never
 * inside a dictionary word, and not 还给: 给 is as often the preposition
 * after 还 hái (我还给你做饭). CC-CEDICT reads 还书 huán; no headword holds
 * 还钱 or 还你.
 */
function giveBack(cps: string[], simp: string[], dict: boolean[], out: (string | null)[], doubt: boolean[]): void {
  for (let k = 0; k + 1 < simp.length; k++) {
    if (simp[k] !== "还" || dict[k] || out[k] !== "hái" || dict[k + 1]) continue;
    let j: number;
    if (simp[k + 1] === "钱" || simp[k + 1] === "书") j = k + 2;
    else if (simp[k + 1] === "你") j = simp[k + 2] === "钱" || simp[k + 2] === "书" ? k + 3 : k + 2;
    else continue;
    const next = cps[j];
    const ends = next == null || !isHan(next) || AFTER_GIVEN.includes(simp[j]) || simp.slice(j, j + 3).join("") === "的时候" || NUMERALS.includes(next);
    if (ends) out[k] = "huán";
    else doubt[k] = true;
  }
}

/* ------------------------------ context rules ----------------------------- */

/** What counts a measure word: a numeral, or a word that points or
 *  quantifies before one (这场, 每种, 何处, 本片, 多处). */
const COUNTERS = `${NUMERALS}这那哪每各此该本首某何多`;
/** Degree words before an adjective (很难, 太长, 最强, 过重). */
const DEGREE_BEFORE = "很太最更较挺真好超蛮极过";
/** Institutions whose head is a 长 zhǎng (警长, 馆长, 组长, 站长). */
const HEADED = "警馆局处院校部科厅队组班站社团营舰厂署司州省市县区镇乡村";
/** Weather, an illness, a fight: what a 场 cháng counts (一场雨). */
const SPELLS = "雨雪病梦风灾战仗架震";
/** What ends a subject or an adverb, after which 只 is zhǐ, only (我只,
 *  他们只, 自己只, 也只, 就只): not after a verb, where 只 is a measure
 *  word with 一 dropped (我买了只会说话的鸟 zhī). */
const ONLY_AFTER = "我你他她它们己咱也都就还却但而又才便总";
/** The last character of a word for a person (老师, 医生, 护士, 自己,
 *  我们): a verb 量 liáng or 数 shǔ follows one (让医生量). */
const PERSON_END = "我你他她它们己咱人师生士妈爸哥姐弟妹员夫子";
/** Verbs and modals 只 zhǐ, only, comes before (只会, 只想, 只用). */
const ONLY_BEFORE = "会想用要能是有好得在说看做吃给剩管顾怕知不";
/** Characters an erhua 儿 follows, and no 儿 the child in CC-CEDICT does
 *  (哥们儿, 玩意儿, 女孩儿, 今儿, 宝贝儿 …, and the HSK 3.0 erhua words:
 *  一下儿, 面条儿, 名牌儿, 胡同儿, 小偷儿, 茶馆儿), measured on its
 *  headwords (ld-7xi). */
const ERHUA_AFTER = "意孩活特伙鸟今们人地明贝妇范子昨盖馅哥天眼歌法娘样颠当倍话艺坎乐塔虫蕾蛋刺脑胆火棍皮腕把闷盹兜下条牌同偷馆";

/**
 * One context rule (ld-7xi): character `ch` (simplified) takes `reading`
 * where `when(prev, next, at)` holds of its neighbours (simplified, "" for
 * none or a non-Chinese character). A rule reads a character only where no
 * dictionary word, table word, rule or correction settled it, and settles
 * it: each is a short test of a neighbour, never a list of words. A rule
 * holds only where it is sure: anywhere else the character stays as read
 * and marked, never traded for an unmarked wrong reading (PR #69 review).
 */
interface ContextRule {
  id: string;
  ch: string;
  reading: string;
  when: (prev: string, next: string, at: { k: number; cps: string[]; simp: string[]; starts: boolean[] | null }) => boolean;
}
export const CONTEXT_RULES: ContextRule[] = [
  // 更 before what it grades (更好, 更大, 更何况): gèng. gēng (to change,
  // a night watch) lives in dictionary words: 更新, 更换, 三更.
  { id: "geng", ch: "更", reading: "gèng", when: (_, next) => next !== "" },
  // An adjective after a degree word (很难, 不难, 太长, 最强, 很差, 很累,
  // 太重): its adjective reading, not 难 nàn, 长 zhǎng, 强 qiǎng, 差 chā,
  // 累 lěi, 重 chóng.
  { id: "nan", ch: "难", reading: "nán", when: (prev) => prev !== "" && (DEGREE_BEFORE + "不").includes(prev) },
  // 多长 only closing a question (有多长, 多长啊): 多长了一颗牙 is zhǎng.
  { id: "chang", ch: "长", reading: "cháng", when: (prev, next) => prev !== "" && (DEGREE_BEFORE.includes(prev) || (prev === "多" && (next === "" || "啊呀呢吗的".includes(next)))) },
  // 长 cháng before 时 (长时间, 长时期); zhǎng, the head, after an
  // institution (警长, 馆长, 组长) where no word of length follows.
  { id: "changShi", ch: "长", reading: "cháng", when: (_, next) => next === "时" },
  { id: "zhang3", ch: "长", reading: "zhǎng", when: (prev, next) => prev !== "" && HEADED.includes(prev) && !"期久度短远寿达年".includes(next || "\0") },
  { id: "qiang", ch: "强", reading: "qiáng", when: (prev) => prev !== "" && DEGREE_BEFORE.includes(prev) },
  { id: "cha", ch: "差", reading: "chà", when: (prev) => prev !== "" && DEGREE_BEFORE.includes(prev) },
  { id: "lei", ch: "累", reading: "lèi", when: (prev) => prev !== "" && (DEGREE_BEFORE + "不").includes(prev) },
  { id: "zhong", ch: "重", reading: "zhòng", when: (prev) => prev !== "" && DEGREE_BEFORE.includes(prev) },
  // A measure word after a numeral or a pointing word (一场, 这场, 两种,
  // 一片, 一处, 一扇, 一圈, 一曲). 场 before weather, an illness or a
  // fight, a character or two on (一场雨, 一场大雪, 一场病, 一场战争), is
  // cháng in the dictionaries, chǎng in much speech: left, marked. HSK 3.0
  // lists 场 chǎng only.
  { id: "chang3", ch: "场", reading: "chǎng", when: (prev, next, { k, simp }) => prev !== "" && COUNTERS.includes(prev) && ![next, simp[k + 2] ?? ""].some((x) => x !== "" && SPELLS.includes(x)) },
  { id: "zhong3", ch: "种", reading: "zhǒng", when: (prev) => prev !== "" && COUNTERS.includes(prev) },
  { id: "pian", ch: "片", reading: "piàn", when: (prev) => prev !== "" && COUNTERS.includes(prev) },
  { id: "chu", ch: "处", reading: "chù", when: (prev) => prev !== "" && COUNTERS.includes(prev) },
  { id: "shan", ch: "扇", reading: "shàn", when: (prev) => prev !== "" && COUNTERS.includes(prev) },
  { id: "quan", ch: "圈", reading: "quān", when: (prev) => prev !== "" && COUNTERS.includes(prev) },
  { id: "qu", ch: "曲", reading: "qǔ", when: (prev) => prev !== "" && COUNTERS.includes(prev) },
  // 只: zhī counting animals after a numeral (一只, 几只, 一只只), and
  // after 这 / 那 / 哪 / 每 unless a verb follows (这只是 zhǐ, 这只有…
  // either); zhǐ, only, before a verb or a modal (只会, 只想, 只用), not
  // before a noun (只身, 只字, 只言片语, 独具只眼: zhī, a single).
  {
    id: "zhi1",
    ch: "只",
    reading: "zhī",
    when: (prev, next) => prev !== "" && ((NUMERALS + "只").includes(prev) || ("这那哪每".includes(prev) && next !== "" && !(ONLY_BEFORE + "说让证适需够算限对使令表靠为").includes(next))),
  },
  // zhǐ only at a clause's start or after a subject or an adverb (我只会,
  // 他们只想, 也只能); after anything else (a verb, 了: 买了只会说话的鸟)
  // it may be the measure word, and stays marked.
  { id: "zhi3", ch: "只", reading: "zhǐ", when: (prev, next) => next !== "" && ONLY_BEFORE.includes(next) && (prev === "" || ONLY_AFTER.includes(prev)) },
  // 为 wéi, to be or to act as, after a verb of naming or becoming outside
  // a dictionary word (定为, 转为, 题为, 实为, 结为, 化为), the verb a word
  // by itself for the segmenter: not where it ends a longer word (一定|为你,
  // 决定|为我们, 试图|为: wèi).
  { id: "wei2", ch: "为", reading: "wéi", when: (prev, _, { k, starts }) => prev !== "" && "转定题实图结化译选".includes(prev) && !!starts && starts[k - 1] && starts[k] },
  // 数 shù, several, before a number or a counted thing (数千, 数十年, 数个,
  // 数名, 数次); not before 日 (数日子 shǔ, to count the days).
  // Not after a person or 来 / 去 / 再 / 先, where it is the verb (我数十下 shǔ).
  { id: "shu", ch: "数", reading: "shù", when: (prev, next) => next !== "" && "十百千万亿个名次年月".includes(next) && !(PERSON_END + "来去再先要会能").includes(prev || "\0") },
  // 儿 closing a word after one of ERHUA_AFTER, outside a dictionary
  // word: erhua's r (男孩儿, 一下儿, 聊天儿, 玩意儿, 哥们儿, 今儿个). Not
  // after any character: 儿 is the child in as many (男儿, 健儿, 育儿,
  // 幸运儿, 混血儿), nor before another word (托儿所, 生儿育女), nor before
  // 们 (这些孩儿们: hái ér, the children, as often as háir).
  { id: "er", ch: "儿", reading: "r", when: (prev, next) => prev !== "" && ERHUA_AFTER.includes(prev) && (next === "" || next === "个") },
  // 量 at the end of a run, after a word of two or more characters (销售量,
  // 工作量, 词汇量): liàng, an amount. Not after a single-character word
  // (你帮我量, 医生来量), a person (你自己量, 让老师量), a word after 让 / 请
  // / 帮 … (让护士量), nor a verb of measuring (丈量, 称量, 车载斗量): there
  // it is the verb liáng, or may be, and stays marked. Before 一下
  // (量一下体温): liáng, to measure.
  {
    id: "liang4",
    ch: "量",
    reading: "liàng",
    when: (prev, next, { k, simp, starts }) => {
      if (prev === "" || next !== "" || !starts || starts[k - 1] || "丈称斗掂比".includes(prev) || PERSON_END.includes(prev)) return false;
      let j = k - 1;
      while (j > 0 && !starts[j]) j--;
      return !"让请帮叫给由被替".includes(simp[j - 1] ?? "\0");
    },
  },
  { id: "liang2", ch: "量", reading: "liáng", when: (_, next, { k, simp }) => next === "一" && simp[k + 2] === "下" },
  // 冲着, facing: chòng. 载有, carrying: zài. 处以, to sentence to: chǔ.
  { id: "chong", ch: "冲", reading: "chòng", when: (_, next) => next === "着" },
  { id: "zai", ch: "载", reading: "zài", when: (_, next) => next === "有" },
  { id: "chu3", ch: "处", reading: "chǔ", when: (_, next) => next === "以" },
  // 降 jiàng, to fall, before 到 / 至 / 低 (降到, 降至); xiáng (to
  // surrender) lives in dictionary words: 投降, 降服.
  { id: "jiang", ch: "降", reading: "jiàng", when: (_, next) => next !== "" && "到至低".includes(next) },
  // 干 gàn, to do, before 过 (干过); before 得 only where the text writes
  // 幹 (幹得好): simplified 干 is 乾 dry too (衣服干得很快 gān), and stays
  // marked. Never 乾.
  { id: "gan", ch: "干", reading: "gàn", when: (_, next, { k, cps }) => cps[k] !== "乾" && (next === "过" || (next === "得" && cps[k] === "幹")) },
  // 行 xíng, all right, closing a phrase after 就 / 都 / 才 / 也 (就行, 都行,
  // 才行, 就行了).
  { id: "xing", ch: "行", reading: "xíng", when: (prev, next) => prev !== "" && "就都才也".includes(prev) && (next === "" || "了吗吧啊呢".includes(next)) },
];
/** The rules switched off by id: for the measurements that keep or drop
 *  each one, and the tests. */
let rulesOff = new Set<string>();
export function useContextRules(off: Iterable<string>): void {
  rulesOff = new Set(off);
  cache.clear();
}

/**
 * The context rules over one text's readings, in place (ld-7xi): common
 * phrases CC-CEDICT has no entry for (一场, 更好, 很难) stayed marked,
 * because a character of two readings in them was read by default or by
 * the prior and nothing settled it. Each rule reads one character by its
 * neighbours, the first that holds, and settles it; never a character a
 * dictionary word, a table word or an earlier rule settled (a person's
 * correction comes after, and outranks it), nor one left in doubt.
 */
function contextRules(cps: string[], simp: string[], dict: boolean[], starts: boolean[] | null, out: (string | null)[], settled: boolean[], doubt: boolean[]): void {
  const han = (k: number) => (k >= 0 && k < cps.length && isHan(cps[k]) ? simp[k] : "");
  for (let k = 0; k < cps.length; k++) {
    if (settled[k] || dict[k] || doubt[k] || out[k] == null) continue;
    for (const r of CONTEXT_RULES) {
      if (r.ch !== simp[k] || rulesOff.has(r.id) || !r.when(han(k - 1), han(k + 1), { k, cps, simp, starts })) continue;
      out[k] = r.reading;
      settled[k] = true;
      break;
    }
  }
}

/** The prior over one text's readings, in place: each run of Chinese
 *  characters that is a table word whole takes its reading; else the
 *  `anywhere` words in it take theirs (anywhereAt), a character alone its
 *  most frequent reading, and one inside a run that no word settled the
 *  fallback, where the table has one. */
function applyPrior(cps: string[], simp: string[], liao: boolean[], seg: Pick<Detail, "joined" | "dict" | "starts">, out: (string | null)[], settled: boolean[]): void {
  // An entry may replace a dictionary word's reading only as a correction.
  const allowed = (key: string, r: string[], at: number) => prior.fixes.has(key) || r.every((x, n) => !seg.dict[at + n] || out[at + n] === x);
  const whole = (i: number, j: number) => {
    for (const [table, key] of [[prior.words, cps.slice(i, j).join("")], [prior.words, simp.slice(i, j).join("")], [prior.anywhere, simp.slice(i, j).join("")]] as const) {
      const r = table.get(key);
      if (r) return r.length === j - i && allowed(key, r, i) ? r : undefined;
    }
    return undefined;
  };
  for (let i = 0; i < cps.length; ) {
    if (!isHan(cps[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < cps.length && isHan(cps[j])) j++;
    const word = j - i > 1 ? whole(i, j) : undefined;
    for (let k = i; k < j; k++) {
      const hit = word ? null : anywhereAt(simp, seg, k, j, allowed);
      if (hit) {
        hit.forEach((r, n) => {
          out[k + n] = r;
          settled[k + n] = true;
        });
        k += hit.length - 1;
      } else if (word) {
        out[k] = word[k - i];
        settled[k] = true;
      } else if (liao[k] || (j - i > 1 && CONTEXT_FORMS.includes(cps[k])) || (simp[k] === cps[k] && NEUTRAL_KEPT.includes(cps[k]))) settled[k] = true;
      else if (!settled[k] && out[k] != null) {
        const r = j - i === 1 ? priorFor(prior.ranks, cps[k], simp[k])?.[0] : priorFor(prior.fallback, cps[k], simp[k]);
        if (r) out[k] = r;
      }
    }
    i = j;
  }
}

/** The `anywhere` word starting at `k` of the simplified text (its run
 *  ends before `end`), longest first, or null: one whose edges fall inside
 *  no word of the library's dictionary (`joined`) and on word boundaries
 *  of the platform's segmenter, with no `block` word across either of its
 *  cuts, and replacing no dictionary reading unless it is a correction. */
function anywhereAt(simp: string[], { joined, starts }: Pick<Detail, "joined" | "starts">, k: number, end: number, allowed: (key: string, r: string[], at: number) => boolean): string[] | null {
  if (joined[k] || !starts || !starts[k]) return null;
  const is = (w: string, at: number) => at >= 0 && simp.slice(at, at + [...w].length).join("") === w;
  for (let n = Math.min(anywhereLongest, end - k); n >= 2; n--) {
    const r = prior.anywhere.get(simp.slice(k, k + n).join(""));
    if (!r || r.length !== n || joined[k + n] || !starts[k + n] || !allowed(simp.slice(k, k + n).join(""), r, k)) continue;
    let blocked = false;
    for (let cut = 1; cut < n && !blocked; cut++) {
      const after = prior.block.get(`>${simp.slice(k + cut, k + n).join("")}=${r.slice(cut).join(" ")}`);
      const before = prior.block.get(`<${simp.slice(k, k + cut).join("")}=${r.slice(0, cut).join(" ")}`);
      for (const w of after ?? []) if (is(w, k + cut)) blocked = true;
      for (const w of before ?? []) if (is(w, k + cut - [...w].length)) blocked = true;
    }
    if (!blocked) return r;
  }
  return null;
}

/** The characters of `text` whose reading no word settled and that have
 *  more than one reading in use (the prior's ranks): their code-point
 *  indices. What the dojo master's reading hints are for (ld-op2). */
export function ambiguousChars(text: string, locale: string, opts: ReadOpts = {}): number[] {
  const { readings, settled } = readDetail(text, locale, opts);
  const cps = [...text];
  const out: number[] = [];
  for (let k = 0; k < cps.length; k++) {
    if (readings[k] == null || settled[k]) continue;
    const ranks = priorFor(prior.ranks, cps[k], simplified(cps[k]));
    if (ranks && ranks.length > 1) out.push(k);
  }
  return out;
}

/* --------------------------- uncertain readings --------------------------- */

/** Characters whose other readings are marginal wherever no dictionary
 *  word settled them (ld-4i2): never marked. Their other readings live in
 *  words the library's dictionary has (要 yāo in 要求, 给 jǐ in 供给, 少 shào
 *  in 少年, 几 jī in 几乎, 角 jué in 角色, 率 shuài in 率领, 扫 sào in 扫帚, 折
 *  zhē in 折腾, 分 fèn in 部分; ld-7xi: 见 xiàn in 图穷匕见, 俩 liǎng in
 *  伎俩), or a rule reads them by their neighbours
 *  (the particles 地 and 了 的 着, whose zhe the following verb settles in
 *  speech; 吗 嘛 má only in 干吗). Measured on session-style text (the
 *  reading-marks test): with them marked, 9 words in 100 were; without,
 *  under 2. Keyed by the simplified form (給 嗎 幾 掃 too). 得 stays marked:
 *  dé / děi alone is a real choice (你得去 děi). */
export const CONTEXT_SETTLED = "了的地着吗嘛要给少分几角率扫折见俩";

/** The longest word a mark or a correction covers, in characters. */
export const MAX_WORD_CHARS = 8;

/** Whether the reading at `k` is uncertain: a Chinese character that no
 *  dictionary word, rule, correction or confirmation settled (read by
 *  default or the frequency prior) and that has another ordinary reading
 *  (the prior's ranks: one at least 5% as frequent as its first in
 *  CC-CEDICT's words), unless it is one of CONTEXT_SETTLED, or the other
 *  is only the neutral tone of the same syllable (头 tou), or the reading
 *  shown is the neutral tone of the usual one (前边 bian). A word that
 *  only the recap suggested a reading for stays uncertain. */
function unsureAt(cps: string[], d: Detail, k: number): boolean {
  const cur = d.readings[k];
  if (cur == null || d.settled[k]) return false;
  if (d.doubt[k]) return true;
  const s = simplified(cps[k]);
  if (CONTEXT_SETTLED.includes(s)) return false;
  const ranks = priorFor(prior.ranks, cps[k], s);
  if (!ranks || ranks.length < 2) return false;
  // A neutral tone applyNeutral put there (前边 qián bian, ld-azb) is the
  // usual syllable's, not another reading of it.
  return ranks.some((r) => r !== cur && !(r === toneless(r) && toneless(cur) === r) && !(d.neutral[k] && toneless(r) === toneless(cur)));
}

/** An uncertain word of a text: code points [start, end), its characters,
 *  the readings shown over them, and which of them are uncertain. */
export interface UnsureWord {
  start: number;
  end: number;
  word: string;
  reading: string[];
  /** The uncertain characters' code-point indices in the text. */
  unsure: number[];
  /** Read by the recap's suggestion, not yet checked by the learner. */
  suggested: boolean;
}

/**
 * The words of `text` whose reading is uncertain (unsureAt): what the
 * transcript, the bank, Practice and the recap mark, and what the recap
 * asks the model about. A word is one of the platform's word segmenter
 * (Intl.Segmenter: 你|得|去, 一宿); one of a single character joins the
 * word after it (得去, 长着, 倒车), else the one before (有点干), so a mark
 * and a correction are always two characters or more: one character
 * corrected alone would rewrite it inside every other word. Words of more
 * than MAX_WORD_CHARS characters, and a character with no Chinese
 * neighbour, are not marked. Without a segmenter each character is a word.
 */
export function uncertainWords(text: string, locale: string, opts: ReadOpts = {}): UnsureWord[] {
  const d = readDetail(text, locale, opts);
  const cps = [...text];
  const unsure = cps.map((_, k) => unsureAt(cps, d, k));
  if (!unsure.some(Boolean)) return [];
  const words = hanWords(cps, d);
  const out: UnsureWord[] = [];
  for (let w = 0; w < words.length; w++) {
    if (!unsure.slice(words[w][0], words[w][1]).some(Boolean)) continue;
    const unit = widened(words, w, cps);
    if (!unit) continue;
    let [s] = unit;
    const e = unit[1];
    const last = out[out.length - 1];
    if (last && s < last.end) s = last.start;
    if (e - s > MAX_WORD_CHARS) continue;
    if (last && s === last.start) out.pop();
    const at = [];
    for (let k = s; k < e; k++) if (unsure[k]) at.push(k);
    out.push({ start: s, end: e, word: cps.slice(s, e).join(""), reading: d.readings.slice(s, e).map((r) => r ?? ""), unsure: at, suggested: at.some((k) => d.fixed[k] === "suggested") });
  }
  return out;
}

/** The segmenter's words of a read text, as [start, end) runs of Chinese
 *  characters (each character alone without a segmenter). */
function hanWords(cps: string[], d: Detail): [number, number][] {
  const words: [number, number][] = [];
  for (let k = 0; k < cps.length; ) {
    if (!isHan(cps[k])) {
      k++;
      continue;
    }
    let e = k + 1;
    // A doubtful 还 (giveBack) stands on its own, so its mark is 还钱, not
    // ICU's 我还 (a correction of which would reach 我还有).
    while (e < cps.length && isHan(cps[e]) && !(d.starts ? d.starts[e] : true) && !d.doubt[e]) e++;
    words.push([k, e]);
    k = e;
  }
  return words;
}

/** Words that start with one of these are function words (adverbs,
 *  conjunctions, the copula, final particles): a single character before
 *  one belongs with the word before it instead (停车|场|很 → 停车场, not
 *  场很; 第五|行|的 → 第五行). */
const FUNCTION_START = "很也都就不没太还又再才和跟与是在吗呢吧啊的";

/** Word `w` as a mark or a correction takes it: one of a single character
 *  joined to the word after it (得去, 长着, 倒车), else, or when that word
 *  is a function word, to the one before (有点干, 停车场); null when it has
 *  no Chinese neighbour. */
function widened(words: [number, number][], w: number, cps: string[]): [number, number] | null {
  const [s, e] = words[w];
  if (e - s >= 2) return [s, e];
  const next = words[w + 1];
  const prev = words[w - 1];
  const nextOk = next && next[0] === e;
  const prevOk = prev && prev[1] === s;
  if (nextOk && !(prevOk && FUNCTION_START.includes(cps[e]))) return [s, next[1]];
  if (prevOk) return [prev[0], e];
  return null;
}

/**
 * The word a correction of the character at UTF-16 offset `at` of `text`
 * is about (the character card's "This reading is wrong"): the uncertain
 * word holding it when there is one, else the segmenter's word, widened as
 * uncertainWords widens one; null when there is none of two to
 * MAX_WORD_CHARS characters. With the readings shown over it now.
 */
export function wordAt(text: string, locale: string, at: number): { word: string; reading: string[]; start: number; unsure: boolean; suggested: boolean } | null {
  let k = 0;
  let n = 0;
  for (const ch of text) {
    if (n === at) break;
    n += ch.length;
    k++;
  }
  if (n !== at) return null;
  const cps = [...text];
  if (!isHan(cps[k] ?? "")) return null;
  const hit = uncertainWords(text, locale).find((u) => u.start <= k && k < u.end);
  if (hit) return { word: hit.word, reading: hit.reading, start: hit.start, unsure: true, suggested: hit.suggested };
  const d = readDetail(text, locale);
  const words = hanWords(cps, d);
  const w = words.findIndex(([s, e]) => s <= k && k < e);
  const unit = w >= 0 ? widened(words, w, cps) : null;
  if (!unit || unit[1] - unit[0] > MAX_WORD_CHARS) return null;
  const reading = d.readings.slice(unit[0], unit[1]);
  if (!reading.every((r) => r)) return null;
  return { word: cps.slice(unit[0], unit[1]).join(""), reading: reading as string[], start: unit[0], unsure: false, suggested: false };
}

/** The same, as UTF-16 offsets: [start, end) of each uncertain word's
 *  characters in `text` (what the ruby layout counts in). */
export function unsureOffsets(text: string, locale: string, opts: ReadOpts = {}): { start: number; end: number; word: string; suggested: boolean }[] {
  const words = uncertainWords(text, locale, opts);
  if (!words.length) return [];
  const offsets: number[] = [];
  let at = 0;
  for (const ch of text) {
    offsets.push(at);
    at += ch.length;
  }
  offsets.push(at);
  return words.map((w) => ({ start: offsets[w.start], end: offsets[w.end], word: w.word, suggested: w.suggested }));
}

/** The same, indexed by UTF-16 offset (what String.slice and the gloss
 *  layout count in): the reading at the offset each character starts.
 *  `hints` (the dojo master's readings for phrases of this text) are laid
 *  over the reader's own. */
export function readOffsets(text: string, locale: string, hints?: readonly ReadingHint[] | null): (string | null)[] {
  const cps = hints?.length ? withHints(text, locale, hints) : readCodePoints(text, locale);
  const out: (string | null)[] = new Array(text.length).fill(null);
  let at = 0;
  let k = 0;
  for (const ch of text) {
    out[at] = cps[k++];
    at += ch.length;
  }
  return out;
}

/** A character's own readings, as the library has them for it (a
 *  traditional character included: 髮 fà, 幹 gàn), tone-marked only. */
const ownReadings = (ch: string) => pinyin(ch, { multiple: true, type: "array", toneSandhi: false }).filter(isPinyin);
// Read through a form OpenCC chooses by the word (t2s.ts): 著 as 着 (看著
// zhe, 睡著 zháo) or itself (著名 zhù), 乾 as 干 (乾淨 gān) or itself (乾隆
// qián); the library's own list for each lacks some of what they are read
// as in a word (著 has no zháo), so the word's reading stands.
const CONTEXT_FORMS = "著乾";
// Kept as themselves by t2s.ts neutralForm in a text of neither script
// (徵 the note zhǐ, 麽 mó): that choice is the reading, alone too.
const NEUTRAL_KEPT = "徵麽";

const toneless = (r: string) => r.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
/** `r` is one of `readings`, or the neutral tone of one (頭髮 tóu fa). */
const among = (r: string, readings: string[]) =>
  readings.includes(r) || (r === toneless(r) && r !== "r" && readings.some((o) => toneless(o) === r));

/** The reading for a traditional character `ch` that was read as its
 *  simplified form `simp` (in context, `r`). Simplification merged
 *  characters that read differently (髮 fà and 發 fā are both 发, 幹 gàn
 *  and 乾 gān both 干, 隻 zhī and 只 zhǐ both 只), so a reading of `simp`
 *  that belongs to one it was merged with, and not to `ch`, is replaced by
 *  `ch`'s own usual one: 髮 alone is fà, never 发's fā. Any other reading
 *  stands, even one the library doesn't list for `ch`: its lists for
 *  traditional characters are short (間 has only jiàn, so 時間 would read
 *  shí jiàn; 許 only xū), and the word's reading is the better guide. */
function ownReading(ch: string, simp: string, r: string): string {
  if (ch === simp || CONTEXT_FORMS.includes(ch)) return r;
  const own = ownReadings(ch);
  if (!own.length || among(r, own)) return r;
  return mergedWith(ch, simp).some((o) => among(r, ownReadings(o))) ? (prior.ranks.get(ch)?.find((x) => own.includes(x)) ?? own[0]) : r;
}

// The usual reading first where the library's order isn't (乾 is gān far
// more often than qián, the Qianlong / hexagram one).
const USUAL_FIRST: Record<string, string> = { 乾: "gān" };

/** Every reading of one character, its usual one first (行: xíng, háng, …),
 *  with Taiwan's first for a zh-TW profile, and, given the reading it has
 *  in the word it was opened from (`inContext`: 行 in 銀行 háng, 蘋 in 蘋果
 *  píng), that one first instead. A traditional character's are its own
 *  (髮 fà, never 发's fā); one that is simply the traditional spelling of
 *  its simplified form (間 → 间, 蘋 → 苹, 還 → 还: no other character merged
 *  into it) leads with that form's usual reading, since the library's
 *  lists for traditional characters are short or oddly ordered (間 has
 *  only jiàn, 蘋 pín before píng). 著 also gets those of the form it stands
 *  for in context (着: zhe, zháo). */
export function charReadings(ch: string, locale: string, inContext?: string | null): string[] {
  const s = simplified(ch);
  const own = s === ch ? [] : ownReadings(ch);
  let all: string[];
  // 著 also stands for 着 (看著 zhe, 睡著 zháo); 乾's own (qián, gān) already
  // cover what it is read as, and 干's other one, gàn, is 幹's.
  if (!own.length) all = ownReadings(s);
  else if (ch === "著") all = [...own, ...ownReadings(s)];
  else if (!mergedWith(ch, s).length) all = [...ownReadings(s).slice(0, 1), ...own];
  else all = own;
  const list = all.filter((r, k) => all.indexOf(r) === k);
  const first = (r: string) => list.splice(0, list.length, r, ...list.filter((x) => x !== r));
  // The most frequent reading leads (the prior's ranks: the character's
  // own, else its simplified form's): the library's order is not by use.
  const ranks = priorFor(prior.ranks, ch, s);
  if (ranks) for (const r of ranks.filter((x) => list.includes(x)).reverse()) first(r);
  const usual = USUAL_FIRST[ch];
  if (usual && list.includes(usual)) first(usual);
  if (isTaiwan(locale)) {
    const [tw] = taiwanize(ch, [list[0] ?? null]);
    if (tw) first(tw);
  }
  // The word's reading leads, even one the lists lack (it is what the
  // learner just saw over the character).
  if (inContext && isPinyin(inContext)) first(inContext);
  return list;
}

/** The simplified form of one character alone (愛 → 爱), or itself:
 *  OpenCC's single-character choice (蘋 → 苹, 著 → 着, 乾 → 干). */
export function simplified(ch: string): string {
  return [...ch].length === 1 ? simplifyAligned(ch)[0] : ch;
}

/** The exemplar index per script (sounds.ts buildExemplarIndex): built the
 *  first time a card needs one, over the common characters of the
 *  learner's script, each read as charReadings reads it for that locale
 *  (Taiwan's readings for zh-TW). Some 5,000 lookups, once per page. */
const exemplarIndexes = new Map<string, ExemplarIndex>();
export function exemplars(locale: string): ExemplarIndex {
  const tw = isTaiwan(locale);
  const key = tw ? "tw" : "cn";
  let index = exemplarIndexes.get(key);
  if (!index) {
    index = buildExemplarIndex(commonChars(tw), (ch) => charReadings(ch, tw ? "zh-TW" : "zh-CN"));
    exemplarIndexes.set(key, index);
  }
  return index;
}

/** A sound's text in the learner's script: the tables keep traditional
 *  characters (the zhuyin chart's), a mainland learner sees and hears the
 *  simplified form (each read the same: sounds.test.mjs). */
export function inScript(text: string, locale: string): string {
  return isTaiwan(locale) ? text : [...text].map(simplified).join("");
}

/* ------------------------------ corrections ------------------------------ */

/** What read a word over the reader (ld-4i2): see Detail.fixed. */
export type FixKind = "mine" | "shared" | "suggested" | "checked";

/** A whole-word reading from outside the reader: the word as written (two
 *  to MAX_WORD_CHARS Chinese characters) and one tone-marked syllable per
 *  character. `scope` (the shared list's): "tw" for a reading only Taiwan
 *  uses, read only for a zh-TW text; "all" (the default) everywhere. */
export interface CorrectionEntry {
  word: string;
  reading: string;
  scope?: "all" | "tw";
}

interface Entry {
  word: string;
  reading: string[];
  scope: "all" | "tw";
  /** The word has a traditional character that simplification merged
   *  with another (髮 / 發 → 发): it matches only as written. */
  merged: boolean;
}

/** The corrections a read lays over the reader's readings, by rank: the
 *  learner's own by hand (`mine`: a correction or a confirmation), the
 *  shared list's active entries (`shared`), and last the recap's word for
 *  this learner: a suggestion (`suggested`, read but still uncertain) or
 *  its agreement with the reader (`checked`, which only clears the mark:
 *  it ranks below the shared list, so a reading people settle later still
 *  reaches the learner). Each keyed by the word's simplified
 *  spelling (correctionKey), so a correction made in one script reads in
 *  the other. `version` names the set (the browser's cache). */
export interface Corrections {
  version: string;
  mine: Map<string, Entry>;
  shared: Map<string, Entry>;
  suggested: Map<string, Entry>;
  checked: Map<string, Entry>;
  longest: number;
}

/** A word's key in a corrections set and the shared list: its simplified
 *  spelling, chosen by the word (OpenCC, t2s.ts), so 還書 and 还书 are one. */
export const correctionKey = (word: string): string => simplifyAligned(word.normalize("NFC")).join("");

/** A corrections set from stored entries; one that is malformed (not two
 *  to MAX_WORD_CHARS Chinese characters with a syllable each) is skipped:
 *  a row is checked when it is written, and again here. */
export function makeCorrections(lists: { mine?: readonly CorrectionEntry[]; shared?: readonly CorrectionEntry[]; suggested?: readonly CorrectionEntry[]; checked?: readonly CorrectionEntry[] }, version = ""): Corrections {
  const c: Corrections = { version, mine: new Map(), shared: new Map(), suggested: new Map(), checked: new Map(), longest: 0 };
  for (const kind of ["mine", "shared", "suggested", "checked"] as const) {
    for (const e of lists[kind] ?? []) {
      if (!e || typeof e.word !== "string" || typeof e.reading !== "string") continue;
      const word = e.word.normalize("NFC");
      const cps = [...word];
      const reading = e.reading.normalize("NFC").split(" ");
      if (cps.length < 2 || cps.length > MAX_WORD_CHARS || !cps.every(isHan) || reading.length !== cps.length || !reading.every(isPinyin)) continue;
      const simp = simplifyAligned(word);
      const merged = cps.some((ch, k) => ch !== simp[k] && mergedWith(ch, simp[k]).length > 0);
      c[kind].set(simp.join(""), { word, reading, scope: e.scope === "tw" ? "tw" : "all", merged });
      c.longest = Math.max(c.longest, cps.length);
    }
  }
  return c;
}

/** The corrections the browser reads with (the learner's own and the
 *  shared list, set by script/ruby.tsx); none on the server, whose reads
 *  pass a learner's own explicitly (ReadOpts.corrections). */
let active: Corrections | null = null;
/** Swap the browser's corrections (null: none). Empties the cache. */
export function setCorrections(c: Corrections | null): void {
  active = c;
  cache.clear();
}
export const currentCorrections = (): Corrections | null => active;

/** Whether `fixed` is a reading a person settled (by hand, or the shared
 *  list's): it outranks the dictionary and a hint, and is not uncertain. */
const settledBy = (f: FixKind | null | undefined) => f === "mine" || f === "shared";

/**
 * The corrections over one text's readings, in place: each entry is read
 * as a whole word only, where both its ends are word boundaries of the
 * platform's segmenter (with none, the ends of a run of Chinese
 * characters) and cut through no word of the library's dictionary
 * (`joined`): 还书 in 我去还书, never 一行 inside 一行人 (行人 is one
 * word). The longest entry wins where two start together, and at one
 * length the learner's own, then the shared list's, then the recap's
 * suggestion. A person's reading (mine, shared) outranks everything, the
 * dictionary's included, and settles the word; a suggestion is read but
 * leaves it uncertain. A zh-TW text takes Taiwan's readings over a shared
 * or suggested entry (they are written for both); the learner's own stand
 * as chosen.
 */
function applyCorrections(cps: string[], simp: string[], { joined, starts }: Pick<Detail, "joined" | "starts">, c: Corrections, tw: boolean, out: (string | null)[], settled: boolean[]): (FixKind | null)[] {
  const fixed: (FixKind | null)[] = cps.map(() => null);
  if (c.longest < 2) return fixed;
  const edge = (k: number) => !joined[k] && (starts ? starts[k] : !isHan(cps[k - 1] ?? "") || !isHan(cps[k] ?? ""));
  for (let i = 0; i < cps.length; i++) {
    if (!isHan(cps[i]) || !edge(i)) continue;
    let run = i;
    while (run < cps.length && isHan(cps[run]) && run - i < c.longest) run++;
    for (let n = run - i; n >= 2; n--) {
      const end = i + n;
      if (!edge(end)) continue;
      const key = simp.slice(i, end).join("");
      const exact = cps.slice(i, end).join("");
      const fits = (e: Entry | undefined) => !!e && (e.word === exact || (!e.merged && !cps.slice(i, end).some((ch, k) => ch !== simp[i + k] && mergedWith(ch, simp[i + k]).length > 0)));
      const shared = c.shared.get(key);
      const hit: [FixKind, Entry] | null = fits(c.mine.get(key))
        ? ["mine", c.mine.get(key)!]
        : fits(shared) && (shared!.scope === "all" || tw)
          ? ["shared", shared!]
          : fits(c.suggested.get(key))
            ? ["suggested", c.suggested.get(key)!]
            : fits(c.checked.get(key))
              ? ["checked", c.checked.get(key)!]
              : null;
      if (!hit) continue;
      const [kind, e] = hit;
      const reading = tw && kind !== "mine" ? taiwanize(e.word, e.reading.slice()) : e.reading;
      for (let k = 0; k < n; k++) {
        out[i + k] = reading[k] ?? out[i + k];
        fixed[i + k] = kind;
        if (kind !== "suggested") settled[i + k] = true;
      }
      i = end - 1;
      break;
    }
  }
  return fixed;
}

export type CorrectionVerdict = { ok: true; word: string; reading: string[] } | { ok: false; why: "shape" | "count" | "unknown" };

/**
 * A correction checked before anything keeps it (the learner's, an
 * admin's, the recap's once it passed validateHint): `word` is two to
 * MAX_WORD_CHARS Chinese characters and nothing else, `reading` one
 * tone-marked syllable per character (an array or space-separated), each
 * a reading that character really has (any the reader knows, common or
 * rare, its neutral tone, 一 / 不 in any tone: fitsChar). A person may
 * choose a marginal reading a hint may not: this is their call.
 */
export function validateCorrection(word: unknown, reading: unknown, locale: string): CorrectionVerdict {
  if (typeof word !== "string" || (typeof reading !== "string" && !Array.isArray(reading)) || word.length > 64) return { ok: false, why: "shape" };
  const w = word.normalize("NFC").trim();
  const cps = [...w];
  if (cps.length < 2 || cps.length > MAX_WORD_CHARS || !cps.every(isHan)) return { ok: false, why: "shape" };
  const raw = typeof reading === "string" ? reading.split(/\s+/) : reading;
  if (raw.length > MAX_WORD_CHARS * 2 || !raw.every((x) => typeof x === "string" && x.length <= 12)) return { ok: false, why: "shape" };
  const syl = (raw as string[]).map((x) => x.normalize("NFC").trim()).filter(Boolean);
  if (syl.length !== cps.length) return { ok: false, why: "count" };
  if (!syl.every(isPinyin) || !cps.every((c, n) => fitsChar(c, syl[n], locale))) return { ok: false, why: "unknown" };
  return { ok: true, word: w, reading: syl };
}

/** The shared list's scope for a reading chosen in `locale`: "tw" when it
 *  gives a character Taiwan's own reading where the mainland's differs
 *  (script.ts TAIWAN_READINGS), so a mainland learner never reads it;
 *  "all" otherwise (a zh-TW text then takes Taiwan's readings over it). */
export function correctionScope(word: string, reading: readonly string[], locale: string): "all" | "tw" {
  if (!isTaiwan(locale)) return "all";
  return [...word.normalize("NFC")].some((c, k) => {
    const t = TAIWAN_READINGS[c];
    return !!t && t.from !== t.to && reading[k] === t.to;
  })
    ? "tw"
    : "all";
}

/* --------------------------- the dojo master's hints -------------------------- */

/** A reading the dojo master gave for a phrase it glossed (ld-op2): the
 *  phrase as written and one tone-marked syllable per Chinese character of
 *  it, separated by spaces ("yín háng"). Only ever one the server checked
 *  (validateHint) and that differs from the reader's own. */
export interface ReadingHint {
  term: string;
  reading: string;
}

/** Whether `syl` is a reading `ch` has (any the reader knows, its neutral
 *  tone, 一 / 不 in any tone, the r of erhua): what a stored reading must
 *  still be for the text it is shown over. */
function fitsChar(ch: string, syl: string, locale: string): boolean {
  if (ch === "一" || ch === "不") return toneless(syl) === (ch === "一" ? "yi" : "bu");
  const { usual, rare } = knownReadings(ch, locale);
  return among(syl, [...usual, ...rare]);
}

/** `text` read (one reading per code point) with each hint laid over the
 *  occurrences of its phrase that stand as words of their own, and nothing
 *  else touched:
 *  - a hint for one character alone is ignored (得 [děi] would rewrite 覺得,
 *    長 [zhǎng] 長城), as is one whose syllables don't count out to its
 *    characters, or name a sound a character doesn't have (a stored
 *    reading whose phrase was since edited);
 *  - an occurrence counts only where both its ends are word boundaries:
 *    not inside a word of the library's dictionary, and on a boundary of
 *    the platform's segmenter (很重 is not in 很重要); with no segmenter,
 *    only where it is the whole run of Chinese characters;
 *  - a character the library read from a dictionary word keeps that
 *    reading (the dictionary outranks the hint, the hint the prior).
 *  The longer phrase wins where two overlap. A copy: the reader's cache
 *  keeps its own. */
export function withHints(text: string, locale: string, hints: readonly ReadingHint[], opts: ReadOpts = {}): (string | null)[] {
  const d = readDetail(text, locale, opts);
  const out = d.readings.slice();
  const cps = [...text];
  const sorted = hints.filter((h) => h && typeof h.term === "string" && typeof h.reading === "string").sort((x, y) => x.term.length - y.term.length);
  for (const h of sorted) {
    const term = [...h.term.normalize("NFC")];
    const syl = h.reading.split(" ");
    const han = term.filter(isHan);
    if (han.length < 2 || han.length !== syl.length || !syl.every(isPinyin) || !han.every((c, n) => fitsChar(c, syl[n], locale))) continue;
    for (let i = 0; i + term.length <= cps.length; i++) {
      if (!term.every((c, k) => cps[i + k] === c)) continue;
      const end = i + term.length;
      const bounded = d.starts ? d.starts[i] && d.starts[end] : !isHan(cps[i - 1] ?? "") && !isHan(cps[end] ?? "");
      if (!bounded || d.joined[i] || d.joined[end]) continue;
      let n = 0;
      term.forEach((c, k) => {
        if (!isHan(c)) return;
        // A correction outranks a hint as it outranks the dictionary.
        // Nor the neutral tone applyNeutral set: the full tone of that syllable
        // is the same word read by the hint's model, not another reading.
        const keepsNeutral = d.neutral[i + k] && toneless(syl[n]) === toneless(out[i + k] ?? "");
        if (!d.dict[i + k] && !settledBy(d.fixed[i + k]) && !keepsNeutral) out[i + k] = syl[n];
        n++;
      });
      i = end - 1;
    }
  }
  return out;
}

/** The readings a hint may give `ch`: `usual` (every reading in use: the
 *  prior's ranks, common and rare, which is what CC-CEDICT's words attest
 *  (還 hái and huán, 曾 céng and the surname's zēng), the card's first,
 *  Taiwan's for a zh-TW text and the mainland's it replaces) and `rare`
 *  (the marginal ones: what only the library's long list has, attested by
 *  no word). */
export function knownReadings(ch: string, locale: string): { usual: string[]; rare: string[] } {
  const s = simplified(ch);
  const lib = charReadings(ch, locale);
  // 著 and 乾 have no ranks (the word chooses their form): all of theirs.
  const usual = [...(priorFor(prior.ranks, ch, s) ?? []), ...(priorFor(prior.rare, ch, s) ?? []), ...(CONTEXT_FORMS.includes(ch) ? lib : lib.slice(0, 1)), ...charReadings(ch, "zh-CN").slice(0, 1)];
  const t = TAIWAN_READINGS[ch];
  if (t && isTaiwan(locale)) usual.push(t.to, t.from);
  if (ch === "兒" || ch === "儿") usual.push("r");
  const uniq = (list: string[]) => list.filter((r, k) => isPinyin(r) && list.indexOf(r) === k);
  return { usual: uniq(usual), rare: uniq(lib).filter((r) => !usual.includes(r)) };
}

const TONE_MARK: Record<string, string> = { "̄": "1", "́": "2", "̌": "3", "̀": "4" };
/** A tone-marked syllable as its letters (NFD, ü's and ê's own marks
 *  kept) and its tone digit, "" for the neutral tone. */
function letters(r: string): [string, string] {
  let tone = "";
  let base = "";
  for (const c of r.normalize("NFD")) {
    if (TONE_MARK[c]) tone = TONE_MARK[c];
    else base += c;
  }
  return [base, tone];
}

export type HintVerdict = { ok: true; reading: string[] } | { ok: false; why: "shape" | "single" | "count" | "unknown" | "rare" | "settled" };

let steps = 0;
/** How many candidates the last validateHint tried: bounded by the hint's
 *  length times the candidates per character (the tests hold it to that). */
export const lastHintSteps = (): number => steps;
/** The longest hint looked at, in letters and marks per character. */
const HINT_PER_CHAR = 8;

/**
 * A reading hint checked against what the characters can be read as. The
 * dojo master may choose among a character's readings, never invent one:
 *  - `raw` is taken apart against `term`'s Chinese characters in order,
 *    each consuming one of its known readings, written with a tone mark
 *    (háng), a tone number (hang2), or bare / 5 / 0 for the neutral tone;
 *    ü may be v or u:, and spaces, apostrophes and hyphens are free. So
 *    the syllables must count out to the characters exactly ("count"
 *    when they don't, "unknown" when one is no reading of its character).
 *  - 一 and 不 take any tone of yi / bu (their sandhi) and keep the app's
 *    own; a neutral-tone syllable keeps the reader's tone where it is the
 *    same syllable (dictionaries differ on these); 兒 may be the r of erhua.
 *  - A phrase of one character takes no hint ("single"): laid over a
 *    line it would rewrite that character inside other words.
 *  - Any reading in use passes (還 huán as well as hái: the choice between
 *    a character's ordinary readings is what a hint is for). Only a
 *    marginal one (knownReadings' `rare`: in the library's long list,
 *    attested by no CC-CEDICT word) needs a dictionary word of the phrase
 *    to read the character so ("rare" otherwise).
 *  - A zh-TW text then takes Taiwan's readings over the result.
 *  - The order of authority is: a word of the library's dictionary, then
 *    the hint, then the prior's tables, then a character's default. So a
 *    hint against a dictionary word's reading (銀行 háng, 長大 zhǎng) is
 *    dropped whole ("settled"), and one against the prior's choice (抽空
 *    kōng, 第五行 háng) stands.
 *  - The work is bounded: the hint is cut off at HINT_PER_CHAR letters a
 *    character, each character's candidates are distinct, and a position
 *    that failed once is not tried again (啊啊啊… against aaa… used to take
 *    a minute).
 * `reading`: one syllable per Chinese character of `term`.
 */
export function validateHint(term: string, raw: string, locale: string): HintVerdict {
  steps = 0;
  const cps = [...term.normalize("NFC")];
  const han = cps.map((c, k) => (isHan(c) ? k : -1)).filter((k) => k >= 0);
  if (!han.length || han.length > 24 || typeof raw !== "string" || raw.length > 240) return { ok: false, why: "shape" };
  const typed = raw.toLowerCase().replace(/u:|v/g, "ü").normalize("NFD");
  const src = typed.replace(/[^a-z0-9\p{M}]/gu, "");
  if (!src) return { ok: false, why: "shape" };
  if (han.length < 2) return { ok: false, why: "single" };
  if (src.length > han.length * HINT_PER_CHAR) return { ok: false, why: "count" };
  // The reader's own reading, without anyone's corrections: what a hint
  // is judged against is the same for every learner.
  const own = readDetail(term.normalize("NFC"), locale, { cache: false, corrections: null });
  // Each character's candidates: [what is written, the reading it means, rare].
  const options = han.map((k): [string, string, boolean][] => {
    const ch = cps[k];
    const list: [string, string, boolean][] = [];
    const mine = own.readings[k];
    if (ch === "一" || ch === "不") {
      const [b] = letters(mine ?? (ch === "一" ? "yī" : "bù"));
      const marked = ch === "一" ? ["yī", "yí", "yǐ", "yì"] : ["bū", "bú", "bǔ", "bù"];
      for (const m of marked) list.push([m.normalize("NFD"), mine ?? marked[ch === "一" ? 0 : 3], false]);
      for (const t of ["", "1", "2", "3", "4", "5", "0"]) list.push([b + t, mine ?? marked[ch === "一" ? 0 : 3], false]);
      return list;
    }
    const { usual, rare } = knownReadings(ch, locale);
    for (const [group, isRare] of [[usual, false], [rare, true]] as const) {
      for (const r of group) {
        const [b, t] = letters(r);
        list.push([r.normalize("NFD"), r, isRare]);
        if (t) list.push([b + t, r, isRare]);
        // The neutral tone of this syllable: the reader's own tone where it
        // read the same syllable, else the bare syllable.
        const neutral = mine && letters(mine)[0] === b ? mine : t ? b.normalize("NFC") : r;
        for (const n of ["5", "0", ""]) list.push([b + n, neutral, t ? false : isRare]);
      }
    }
    // One candidate per spelling (the first: an ordinary reading before a
    // marginal one). Longest first, so "hang2" is not taken as "hang" and
    // a stray "2".
    const seen = new Set<string>();
    return list.filter(([w]) => !seen.has(w) && seen.add(w)).sort((x, y) => y[0].length - x[0].length);
  });
  // (character, position) pairs from which nothing fits: never tried twice.
  const dead = new Set<number>();
  const fit = (i: number, at: number): [string, boolean][] | null => {
    if (i === options.length) return at === src.length ? [] : null;
    const key = i * (src.length + 1) + at;
    if (dead.has(key)) return null;
    for (const [written, reading, rare] of options[i]) {
      steps++;
      if (!src.startsWith(written, at)) continue;
      const rest = fit(i + 1, at + written.length);
      if (rest) return [[reading, rare], ...rest];
    }
    dead.add(key);
    return null;
  };
  const got = fit(0, 0);
  if (!got) {
    const tokens = typed.split(/[\s'’\-·]+/).filter((x) => /[a-z]/.test(x)).length;
    return { ok: false, why: tokens === han.length ? "unknown" : "count" };
  }
  const full: (string | null)[] = cps.map(() => null);
  for (const [n, k] of han.entries()) {
    const [reading, rare] = got[n];
    if (rare && !(own.dict[k] && own.readings[k] === reading)) return { ok: false, why: "rare" };
    full[k] = isPinyin(reading) ? reading : own.readings[k];
  }
  if (isTaiwan(locale)) taiwanize(cps.join(""), full);
  if (han.some((k) => own.dict[k] && own.readings[k] != null && full[k] !== own.readings[k])) return { ok: false, why: "settled" };
  const reading = han.map((k) => full[k] ?? "");
  return reading.every(isPinyin) ? { ok: true, reading } : { ok: false, why: "unknown" };
}

/** What the server keeps of a gloss's hint: the checked reading when it
 *  differs from the reader's own, for the phrase alone or where it stands
 *  in one of `lines` (the turn's target-language text); null when the
 *  reader already reads it so. */
export function hintToKeep(term: string, reading: string[], lines: readonly string[], locale: string): string | null {
  const t = term.normalize("NFC");
  const hint: ReadingHint = { term: t, reading: reading.join(" ") };
  for (const text of [t, ...lines.map((l) => l.normalize("NFC")).filter((l) => l.includes(t))]) {
    const base = readCodePoints(text, locale, { cache: false });
    const laid = withHints(text, locale, [hint], { cache: false });
    if (laid.some((r, k) => r !== base[k])) return hint.reading;
  }
  return null;
}
