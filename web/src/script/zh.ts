/* The Mandarin reader: pinyin for Chinese text, word by word, from
 * pinyin-pro (MIT), with a traditional → simplified table built from
 * Unihan (zh-t2s.json, scripts/gen-zh-chars.mjs). Loaded on demand
 * (ruby.tsx), so a session in any other language, or with the aid off,
 * never downloads it. Deterministic:
 * the same text always reads the same, with no model in the loop.
 *
 * Traditional text is read through its simplified spelling, one character
 * for one, because the word dictionary is simplified: 銀行 must be seen as
 * 银行 to read yín háng. A zh-TW text then takes Taiwan's standard
 * readings where they differ (script.ts TAIWAN_READINGS). Tone sandhi is
 * off: the marks are each character's own tone, as dictionaries and
 * zhuyin textbooks print them (不是 bù shì, 一個 yī gè). */

import { pinyin } from "pinyin-pro";
import t2s from "./zh-t2s.json" with { type: "json" };
import { isHan, isTaiwan, particleDe, simplifyForReading, taiwanize } from "./script.ts";

const toSimp: Record<string, string> = t2s.t2s;

const cache = new Map<string, (string | null)[]>();
const CACHE_MAX = 4000;

/** Each code point of `text` read: its pinyin (tone marks) for a Chinese
 *  character, null for anything else. */
export function readCodePoints(text: string, locale: string): (string | null)[] {
  const tw = isTaiwan(locale);
  const key = `${tw ? "tw" : "cn"}\u0001${text}`;
  const hit = cache.get(key);
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
      if (it.isZh && n === 1 && isHan(cps[i] ?? "") && it.pinyin) out[i] = it.pinyin;
      i += n;
    }
    if (tw) taiwanize(text, out);
    particleDe(text, out);
  }
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

/** Every reading of one character, its usual one first (行: xíng, háng, …),
 *  with Taiwan's first for a zh-TW profile. */
export function charReadings(ch: string, locale: string): string[] {
  const s = simplifyForReading(ch, toSimp);
  const all = pinyin(s, { multiple: true, type: "array", toneSandhi: false });
  const list = all.filter((r, k) => r && all.indexOf(r) === k);
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
