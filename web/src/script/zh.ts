/* The Mandarin reader: pinyin for Chinese text, word by word, from
 * pinyin-pro (MIT), with a traditional → simplified table built from
 * Unihan (zh-t2s.json, scripts/gen-zh-chars.mjs). Loaded on demand
 * (ruby.tsx), so a session in any other language, or with the aid off,
 * never downloads it. Deterministic:
 * the same text always reads the same, with no model in the loop.
 *
 * Traditional text is read through its simplified spelling, one character
 * for one, because the word dictionary is simplified: 銀行 must be seen as
 * 银行 to read yín háng. A traditional character whose simplified form it
 * shares with another (髮 / 發 → 发) then keeps a reading of its own
 * (ownReading). A zh-TW text then takes Taiwan's standard
 * readings where they differ (script.ts TAIWAN_READINGS). Tone sandhi is
 * off: the marks are each character's own tone, as dictionaries and
 * zhuyin textbooks print them (不是 bù shì, 一個 yī gè). */

import { pinyin } from "pinyin-pro";
import t2s from "./zh-t2s.json" with { type: "json" };
import { isHan, isPinyin, isTaiwan, particleDe, simplifyForReading, taiwanize } from "./script.ts";
import { buildExemplarIndex, commonChars, type ExemplarIndex } from "./sounds.ts";

const toSimp: Record<string, string> = t2s.t2s;

const cache = new Map<string, (string | null)[]>();
const CACHE_MAX = 4000;

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
    const simp = [...simplifyForReading(text, toSimp)];
    const items = pinyin(simp.join(""), { type: "all", toneSandhi: false, nonZh: "spaced" });
    // One item per character (nonZh "spaced" keeps every other character
    // its own item too); walk them by their origin so an item that ever
    // covers two code points can't shift the rest.
    let i = 0;
    for (const it of items) {
      const n = [...it.origin].length || 1;
      if (it.isZh && n === 1 && isHan(cps[i] ?? "") && isPinyin(it.pinyin)) out[i] = ownReading(cps[i], simp[i], it.pinyin);
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
// Read through a form chosen by context on purpose (simplifyForReading):
// 著 as 着 (看著 zhe, 睡著 zháo), 乾 as 干 (乾淨 gān); their readings span both.
const CONTEXT_FORMS = "著乾";

/** The reading for a traditional character `ch` that was read as its
 *  simplified form `simp` (in context, `r`): kept when it is one of the
 *  character's own readings (or that reading's neutral tone: 頭髮 tóu fa),
 *  else the character's own usual one. Simplification merged characters
 *  that read differently (髮 fà and 發 fā are both 发, 幹 gàn and 乾 gān
 *  both 干), so 发's reading must not be taken for 髮's. */
function ownReading(ch: string, simp: string, r: string): string {
  if (ch === simp || CONTEXT_FORMS.includes(ch)) return r;
  const own = ownReadings(ch);
  if (!own.length || own.includes(r)) return r;
  const neutral = r === r.normalize("NFD").replace(/[̀-ͯ]/g, "") && r !== "r";
  if (neutral && own.some((o) => o.normalize("NFD").replace(/[̀-ͯ]/g, "") === r)) return r;
  return own[0];
}

// The usual reading first where the library's order isn't (乾 is gān far
// more often than qián, the Qianlong / hexagram one).
const USUAL_FIRST: Record<string, string> = { 乾: "gān" };

/** Every reading of one character, its usual one first (行: xíng, háng, …),
 *  with Taiwan's first for a zh-TW profile. A traditional character's are
 *  its own (髮 fà, never 发's fā), and 著 also gets those of the form
 *  it stands for in context (着: zhe, zháo). */
export function charReadings(ch: string, locale: string): string[] {
  const s = simplifyForReading(ch, toSimp);
  const own = s === ch ? [] : ownReadings(ch);
  // 著 also stands for 着 (看著 zhe, 睡著 zháo); 乾's own (qián, gān) already
  // cover what it is read as, and 干's other one, gàn, is 幹's.
  const all = own.length ? [...own, ...(ch === "著" ? ownReadings(s) : [])] : ownReadings(s);
  const list = all.filter((r, k) => all.indexOf(r) === k);
  const usual = USUAL_FIRST[ch];
  if (usual && list.includes(usual)) list.splice(0, list.length, usual, ...list.filter((r) => r !== usual));
  if (isTaiwan(locale)) {
    const [tw] = taiwanize(ch, [list[0] ?? null]);
    if (tw && !list.includes(tw)) list.unshift(tw);
    else if (tw) list.splice(0, list.length, tw, ...list.filter((r) => r !== tw));
  }
  return list;
}

/** The one-for-one simplified form of a character (愛 → 爱), or itself. */
export function simplified(ch: string): string {
  return toSimp[ch] ?? ch;
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
