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
 * (ownReading). A few words the library misreads in either script are
 * corrected (READING_FIXES), a zh-TW text then takes Taiwan's standard
 * readings where they differ (script.ts TAIWAN_READINGS), and the
 * particles 地 得 兒 are read by their neighbours (particleDe). Tone sandhi
 * is off: the marks are each character's own tone, as dictionaries and
 * zhuyin textbooks print them (不是 bù shì, 一個 yī gè). */

import { customPinyin, pinyin } from "pinyin-pro";
import { isHan, isPinyin, isTaiwan, particleDe, taiwanize } from "./script.ts";
import { buildExemplarIndex, commonChars, type ExemplarIndex } from "./sounds.ts";
import { mergedWith, scriptOf, simplifyAligned } from "./t2s.ts";

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
customPinyin(READING_FIXES);

const cache = new Map<string, (string | null)[]>();
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
export function readCodePoints(text: string, locale: string, { cache: useCache = true }: { cache?: boolean } = {}): (string | null)[] {
  const tw = isTaiwan(locale);
  const key = `${tw ? "tw" : "cn"}\u0001${text}`;
  const hit = useCache ? cache.get(key) : undefined;
  if (hit) return hit;
  const cps = [...text];
  const out: (string | null)[] = cps.map(() => null);
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
    const items = pinyin(simp.map((s, k) => (liao[k] ? "瞭" : s)).join(""), { type: "all", toneSandhi: false, nonZh: "spaced" });
    // One item per character (nonZh "spaced" keeps every other character
    // its own item too); walk them by their origin so an item that ever
    // covers two code points can't shift the rest.
    let i = 0;
    for (const it of items) {
      const n = [...it.origin].length || 1;
      if (it.isZh && n === 1 && isHan(cps[i] ?? "") && isPinyin(it.pinyin)) out[i] = liao[i] ? "liǎo" : ownReading(cps[i], simp[i], it.pinyin);
      i += n;
    }
    if (tw) taiwanize(text, out);
    particleDe(text, out);
  }
  if (!useCache) return out;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
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
  return mergedWith(ch, simp).some((o) => among(r, ownReadings(o))) ? own[0] : r;
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
