/* The transcript's words, shared by the live session (VoicePanel) and a
 * saved one read back from History (HistoryView): how a learner's control
 * message reads, who a line is, every gloss of the session, and each line's
 * translation. Pure helpers plus one hook; the components are Transcript.tsx. */

import { useMemo } from "react";
import { haystack, isSentence, mightMatch, sentenceGlosses } from "./gloss";
import type { VoiceGender, VoiceGloss, VoiceHistoryItem, VoiceLine, VoicePlanItem, VoiceSpeaker } from "./types";

export const SPEAKER_LABEL: Record<VoiceSpeaker, string> = { narrator: "Narrator", character: "Character", sidekick: "Sidekick" };
export const GENDER_LABEL: Record<VoiceGender, string> = { female: "woman", male: "man" };

/** The Skip, Help and Explain buttons' messages; scripts/voice.mjs SKIP,
 *  HELP and EXPLAIN must match (the adapter tells the dojo master what each means). */
export const SKIP = "[skip]";
export const HELP = "[help]";
export const EXPLAIN = "[explain]";
/** Prefix of a timeline jump; scripts/voice.mjs JUMP must match. */
export const JUMP = "[jump]";
export const CONTROL_LABEL: Record<string, string> = { [SKIP]: "Skipped", [HELP]: "Asked for help", [EXPLAIN]: "Asked for an explanation" };
/** Prefix of a message straight to the dojo master (scripts/voice.mjs DIRECT). */
export const DIRECT = "[direct]";
/** Prefix of a tapped answer to a practice question (scripts/choices.mjs PICK). */
export const PICK = "[pick]";
export const pickText = (t: string) => (t.startsWith(`${PICK} `) ? t.slice(PICK.length + 1) : null);
/** A choice that is an answer to the practice, its words; null for a
 *  check-in answer (scripts/choices.mjs spokenChoice must match). */
export const spokenChoice = (c: string) => /^<t>([^<>]+)<\/t>$/.exec(c)?.[1] ?? null;
/** The kind of a warm-up's practice part (scripts/plan.mjs PRACTICE_KIND). */
export const PRACTICE_KIND = "practice";
export const directText = (t: string) => (t.startsWith(`${DIRECT} `) ? t.slice(DIRECT.length + 1) : null);

export function lineLabel(l: VoiceLine): string {
  // The narrator is one voice for the whole session (the cast fixes it), so
  // its line-by-line gender tag says nothing and can be wrong.
  if (l.speaker === "narrator" || !l.gender) return SPEAKER_LABEL[l.speaker];
  return `${SPEAKER_LABEL[l.speaker]} · ${GENDER_LABEL[l.gender]}`;
}

export function transcriptText(entries: VoiceHistoryItem[]): string {
  return entries
    .map((m) => (m.role === "learner" ? `Me: ${CONTROL_LABEL[m.text] ? `(${CONTROL_LABEL[m.text].toLowerCase()})` : jumpTarget(m.text) != null ? `(jumped to ${jumpTarget(m.text)})` : directText(m.text) != null ? `(to the dojo master) ${directText(m.text)}` : (pickText(m.text) ?? m.text)}` : m.lines.map((l) => `${lineLabel(l)}: ${l.text}`).join("\n") + (m.glosses?.length ? `\n${m.glosses.map((g) => `  ${g.term} = ${g.meaning}`).join("\n")}` : "")))
    .join("\n\n");
}

/** The part id of a "[jump] <id>" message; null for anything else. */
export function jumpTarget(text: string): string | null {
  return text.startsWith(`${JUMP} `) ? text.slice(JUMP.length + 1).trim() : null;
}

export function planTitle(plan: VoicePlanItem[], id: string): string {
  return plan.find((p) => p.id === id)?.title ?? id;
}

/** Every gloss in the session so far, the first wording of a term winning:
 *  the dojo master doesn't re-gloss a word it already explained, so a word
 *  from turn two must still be tappable in turn five. */
export function sessionGlosses(entries: { role: string; glosses?: VoiceGloss[] }[]): VoiceGloss[] {
  const seen = new Set<string>();
  const out: VoiceGloss[] = [];
  for (const e of entries) {
    for (const g of e.glosses ?? []) {
      const k = g.term.toLocaleLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(g);
    }
  }
  return out;
}

export type LineTranslation = { gloss: VoiceGloss; whole: boolean } | null;
type TrCacheRow = {
  first: VoiceGloss | undefined;
  seen: number;
  locale: string | undefined;
  lines: { texts: string[]; hays: { text: string; low: string }[]; hits: VoiceGloss[]; tr: LineTranslation }[];
};

/** Each master line's translation (what its translate button shows), worked
 *  out once per transcript change rather than on every render: the level
 *  meter re-renders many times a second while recording. Glosses only grow
 *  during a session (the first wording of a term wins, sessionGlosses), so
 *  each line remembers the glosses found in it and tests only the ones added
 *  since (a substring check, mightMatch); it is laid out again only when one
 *  of them is in it. A new turn then costs its own lines plus a few
 *  substring checks per older line, not a layout of the whole session. */
export function useLineTranslations(entries: VoiceHistoryItem[], glosses: VoiceGloss[], locale: string | null): LineTranslation[][] {
  return useMemo(() => {
    const loc = locale ?? undefined;
    return entries.map((m) => {
      if (m.role !== "master") return [] as LineTranslation[];
      let c = trCache.get(m);
      if (!c || c.first !== glosses[0] || c.seen > glosses.length || c.locale !== loc) {
        c = {
          first: glosses[0],
          seen: 0,
          locale: loc,
          lines: m.lines.map((l) => {
            const texts = (l.segments ?? []).filter((g) => g.lang === "target").map((g) => g.text);
            return { texts, hays: texts.map((t) => haystack(t, loc)), hits: [] as VoiceGloss[], tr: null as LineTranslation };
          }),
        };
      }
      if (c.seen < glosses.length) {
        const fresh = glosses.slice(c.seen);
        for (const line of c.lines) {
          const found = fresh.filter((g) => line.hays.some((h) => mightMatch(h, g, loc)));
          if (!found.length) continue;
          line.hits = [...line.hits, ...found];
          // Laid out with just the glosses that might be in it: one that isn't
          // there changes nothing, so this agrees with a layout over them all.
          const tr = sentenceGlosses(line.texts, line.hits, loc);
          // "line" when a whole sentence is in it, else the phrase(s) it
          // shows, so the button says which.
          line.tr = tr.length
            ? { gloss: tr.length === 1 ? tr[0] : { term: tr.map((t) => t.term).join(" · "), meaning: tr.map((t) => t.meaning).join(" · ") }, whole: tr.some((t) => isSentence(t, loc)) }
            : null;
        }
        c = { ...c, seen: glosses.length };
      }
      trCache.set(m, c);
      return c.lines.map((l) => l.tr);
    });
  }, [entries, glosses, locale]);
}

/** Per transcript entry (an object that never changes once made), what
 *  useLineTranslations worked out for it. Weak: an entry dropped by Restart,
 *  or a saved conversation closed, takes its row with it. */
const trCache = new WeakMap<VoiceHistoryItem, TrCacheRow>();
