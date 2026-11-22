import { HOMOPHONES_CN, HOMOPHONES_TW } from "./zh-homophones.ts";
import { isHan, isTaiwan } from "./script.ts";
import { charReadings, knownReadings, readDetail, type Corrections, type FixKind } from "./zh.ts";

/* Saying the settled reading (ld-0mn, docs/VOICE.md §Saying the settled
 * reading). A voice reads Chinese characters itself: a reading a person
 * settled (or a checked model answer) changes what the learner sees, not
 * what they hear. Measured on eleven_v4 and Azure (2026-11-21): a voice
 * already says the common context words right (还钱 huán, 你得去 děi, 长着
 * zhǎng, 一行字 háng, 重新 chóng), but it says its own choice whatever was
 * settled; swapping the word's characters for ones that can only be said
 * the settled way (还钱 settled hái qián is sent as 孩钱) made both voices
 * say it, 6 times of 6. So before a Mandarin text goes to any provider the
 * server sends it through spokenText; the text shown, stored and
 * transcribed is never changed.
 *
 * Server-only (the browser never loads the table). */

const table = (s: string) => new Map(s.split("|").filter(Boolean).map((e) => e.split("=") as [string, string]));
const CN = table(HOMOPHONES_CN);
const TW = table(HOMOPHONES_TW);

/** The corrections a voice follows: a person's (the learner's own, the
 *  shared list's) and a checked model answer that settled the word
 *  (`checked`). Never a recap's suggestion still waiting for a person
 *  (`suggested`), and never the reader's own guess: a voice reads the
 *  context better than the frequency prior does (it said 你得去 děi where
 *  the prior reads dé), so only a reading someone or something checked
 *  overrides it. */
export const SPOKEN_FIXES: readonly FixKind[] = ["mine", "shared", "checked"];

/** One swapped character: its code-point index, the character, its
 *  settled reading and the stand-in sent instead. */
export interface Swap {
  at: number;
  from: string;
  reading: string;
  to: string;
}

/** The stand-in for `reading` in `locale`'s script, or null (none in the
 *  table: děi, a neutral tone). */
export function standIn(reading: string, locale: string): string | null {
  return (isTaiwan(locale) ? TW : CN).get(reading.normalize("NFC")) ?? null;
}

/** Whether a voice may say `ch` otherwise than `reading`: it has another
 *  reading, and `reading` is not both its most frequent one and the one the
 *  reader gives it here without any correction (`own`). A voice can choose
 *  wrong either way (同行 settled tóng háng: 行's usual reading is xíng, and
 *  a voice said xíng in 我们一起同行), but 同 tóng, the usual reading the
 *  reader gives too, is left as written: a swap that changes nothing
 *  heard only costs the line some of its naturalness. */
function atRisk(ch: string, reading: string, own: string | null, locale: string): boolean {
  const list = charReadings(ch, locale);
  const { usual, rare } = knownReadings(ch, locale);
  if (new Set([...list, ...usual, ...rare]).size < 2) return false;
  return reading !== list[0] || reading !== own;
}

/**
 * `text` as a voice should be given it: every character of a word that
 * `corrections` settled (SPOKEN_FIXES: read as a whole word only, between
 * word boundaries of the segmenter, never inside a longer word: zh.ts
 * applyCorrections) that a voice may say otherwise (atRisk) is swapped for its
 * reading's stand-in (zh-homophones.ts: a common character read only that
 * way), where the table has one. Everything else is left as written.
 * Without corrections, or with none that applies, the text is returned
 * unchanged (`swaps` empty).
 */
export function spokenText(text: string, locale: string, corrections: Corrections | null): { text: string; swaps: Swap[] } {
  if (!corrections || corrections.longest < 2 || !text) return { text, swaps: [] };
  const cps = [...text];
  if (!cps.some(isHan)) return { text, swaps: [] };
  const d = readDetail(text, locale, { cache: false, corrections });
  const own = readDetail(text, locale, { cache: false, corrections: null }).readings;
  const swaps: Swap[] = [];
  for (let k = 0; k < cps.length; k++) {
    const fix = d.fixed[k];
    const reading = d.readings[k];
    if (!fix || !SPOKEN_FIXES.includes(fix) || !reading || !isHan(cps[k])) continue;
    if (!atRisk(cps[k], reading, own[k], locale)) continue;
    const to = standIn(reading, locale);
    if (!to || to === cps[k]) continue;
    swaps.push({ at: k, from: cps[k], reading, to });
    cps[k] = to;
  }
  return swaps.length ? { text: cps.join(""), swaps } : { text, swaps };
}
