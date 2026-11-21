/* The dojo master's reading hints (ld-op2, docs/VOICE.md §Reading hints).
 * A Mandarin session's GLOSS entries may carry a reading in brackets
 * (scripts/voice.mjs READINGS_RULE, parseGlosses). The model wrote the
 * line and knows which reading it meant; it must still not be able to
 * teach a sound the character doesn't have. So every hint is checked here
 * before anything keeps it (web/src/script/zh.ts validateHint), and only
 * one that differs from what the reader shows anyway is kept: on the
 * turn's gloss (stored in turns.glosses, replayed, laid over
 * that turn's lines by the transcript) and, when the gloss fills the bank,
 * on the phrase (phrases.reading). A dropped hint costs nothing: the
 * reader's reading stands, as before there were hints. */

import type { VoiceGloss, VoiceLine } from "../shared/wire.ts";
import { scriptFor } from "../src/script/script.ts";
import { hintToKeep, validateHint } from "../src/script/zh.ts";

/** Whether sessions in `locale` ask the dojo master for readings. */
export const wantsReadings = (locale: string | null | undefined): boolean => scriptFor(locale)?.id === "zh";

export interface HintStats {
  /** Glosses that came with a hint. */
  given: number;
  /** Passed every check. */
  accepted: number;
  /** Accepted and different from the reader's reading: kept. */
  kept: number;
  /** Dropped, by reason (validateHint's). */
  dropped: { shape: number; count: number; unknown: number; rare: number; settled: number };
}

/**
 * `glosses` as the turn keeps them: each hint checked, `reading` left only
 * on the ones kept (normalised: tone-marked syllables, one space between),
 * and gone from every other, in any language but Mandarin from all.
 */
export function settleHints(glosses: VoiceGloss[], lines: Pick<VoiceLine, "text">[], locale: string | null | undefined): { glosses: VoiceGloss[]; stats: HintStats } {
  const stats: HintStats = { given: 0, accepted: 0, kept: 0, dropped: { shape: 0, count: 0, unknown: 0, rare: 0, settled: 0 } };
  const zh = wantsReadings(locale) && locale ? locale : null;
  const texts = lines.map((l) => l.text);
  const out = glosses.map(({ reading, ...g }) => {
    if (reading == null) return g;
    stats.given++;
    if (!zh) {
      stats.dropped.shape++;
      return g;
    }
    const v = validateHint(g.term, reading, zh);
    if (!v.ok) {
      stats.dropped[v.why]++;
      return g;
    }
    stats.accepted++;
    const keep = hintToKeep(g.term, v.reading, texts, zh);
    if (!keep) return g;
    stats.kept++;
    return { ...g, reading: keep };
  });
  return { glosses: out, stats };
}

/** One log line per turn that had hints: counts only, never the text. */
export function logHints(stats: HintStats): void {
  if (!stats.given) return;
  const d = stats.dropped;
  console.log(
    `[lingo-dojo] reading hints: ${stats.given} given, ${stats.accepted} accepted (${stats.kept} differ from the reader and are kept), dropped ${d.count} syllable count, ${d.unknown} not a reading of the character, ${d.rare} rare without a confirming word, ${d.settled} against a dictionary word, ${d.shape} other`,
  );
}
