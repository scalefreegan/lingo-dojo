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
 * particles 地 得 兒 are read by their neighbours (particleDe). Tone sandhi
 * is off: the marks are each character's own tone, as dictionaries and
 * zhuyin textbooks print them (不是 bù shì, 一個 yī gè). */

import { OutputFormat, customPinyin, pinyin, segment } from "pinyin-pro";
import { isHan, isPinyin, isTaiwan, particleDe, taiwanize } from "./script.ts";
import { buildExemplarIndex, commonChars, type ExemplarIndex } from "./sounds.ts";
import { mergedWith, scriptOf, simplifyAligned } from "./t2s.ts";
import { ANYWHERE, BLOCK, FALLBACK, RANKS, WORDS } from "./zh-freq.ts";

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
 *  A reading that a dictionary word settles is never touched. */
export interface Prior {
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
  const p: Prior = { ranks: new Map(), rare: new Map(), fallback: new Map(), words: new Map(), anywhere: new Map(), block: new Map() };
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
  for (const e of pairs(t.WORDS)) {
    const [w, r] = e.split("=");
    p.words.set(w, r.split(" "));
  }
  for (const e of pairs(t.ANYWHERE)) {
    const [w, r] = e.split("=");
    p.anywhere.set(w, r.split(" "));
  }
  for (const e of pairs(t.BLOCK)) {
    const at = e.indexOf(":");
    p.block.set(e.slice(0, at), e.slice(at + 1).split(","));
  }
  return p;
}
let prior: Prior = parsePrior({ RANKS, FALLBACK, WORDS, ANYWHERE, BLOCK });
let anywhereLongest = 0;
const measure = () => (anywhereLongest = Math.max(0, ...[...prior.anywhere.keys()].map((w) => [...w].length)));
measure();
customPinyin(READING_FIXES);
/** The prior in use. */
export const currentPrior = (): Prior => prior;
/** Swap the prior (null: none at all): for the builder, which measures the
 *  reader without it, and the tests. Empties the caches. */
export function setPrior(p: Prior | null): void {
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
export function readCodePoints(text: string, locale: string, opts: { cache?: boolean } = {}): (string | null)[] {
  return readDetail(text, locale, opts).readings;
}

/** readCodePoints with what settled each reading (Detail). */
export function readDetail(text: string, locale: string, { cache: useCache = true }: { cache?: boolean } = {}): Detail {
  const tw = isTaiwan(locale);
  const key = `${tw ? "tw" : "cn"}\u0001${text}`;
  const hit = useCache ? cache.get(key) : undefined;
  if (hit) return hit;
  const cps = [...text];
  const out: (string | null)[] = cps.map(() => null);
  const settled = cps.map(() => false);
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
    const joined = cps.map(() => false);
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
    applyPrior(cps, simp, liao, joined, out, settled);
    if (tw) taiwanize(text, out);
    const before = out.slice();
    particleDe(text, out);
    for (let k = 0; k < out.length; k++) if (out[k] !== before[k]) settled[k] = true;
  }
  const detail = { readings: out, settled };
  if (!useCache) return detail;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, detail);
  return detail;
}

/** The prior over one text's readings, in place: each run of Chinese
 *  characters that is a table word whole takes its reading; else the
 *  `anywhere` words in it take theirs (anywhereAt), a character alone its
 *  most frequent reading, and one inside a run that no word settled the
 *  fallback, where the table has one. */
function applyPrior(cps: string[], simp: string[], liao: boolean[], joined: boolean[], out: (string | null)[], settled: boolean[]): void {
  for (let i = 0; i < cps.length; ) {
    if (!isHan(cps[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < cps.length && isHan(cps[j])) j++;
    const word = j - i > 1 ? (prior.words.get(cps.slice(i, j).join("")) ?? prior.words.get(simp.slice(i, j).join("")) ?? prior.anywhere.get(simp.slice(i, j).join(""))) : undefined;
    for (let k = i; k < j; k++) {
      const hit = word ? null : anywhereAt(simp, joined, k, j);
      if (hit) {
        hit.forEach((r, n) => {
          out[k + n] = r;
          settled[k + n] = true;
        });
        k += hit.length - 1;
      } else if (word && word.length === j - i) {
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
 *  no word of the library's dictionary (`joined`), and with no `block`
 *  word across either of its cuts. */
function anywhereAt(simp: string[], joined: boolean[], k: number, end: number): string[] | null {
  if (joined[k]) return null;
  const is = (w: string, at: number) => at >= 0 && simp.slice(at, at + [...w].length).join("") === w;
  for (let n = Math.min(anywhereLongest, end - k); n >= 2; n--) {
    const r = prior.anywhere.get(simp.slice(k, k + n).join(""));
    if (!r || r.length !== n || joined[k + n]) continue;
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
export function ambiguousChars(text: string, locale: string, opts: { cache?: boolean } = {}): number[] {
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

/** The same, indexed by UTF-16 offset (what String.slice and the gloss
 *  layout count in): the reading at the offset each character starts. */
export function readOffsets(text: string, locale: string): (string | null)[] {
  const cps = readCodePoints(text, locale);
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
