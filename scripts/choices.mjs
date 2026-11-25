// The buttons under a turn (its CHOICES line). Pure, with no imports, so the
// voice loop and the recap read a choice the same way.

/** Prefix of a tapped answer to a practice question, one of the choices on
 *  screen: an answer, but picked, not recalled (web/src/transcript.ts PICK
 *  must match). */
export const PICK = "[pick]";

const CHOICE_CHARS = 60;
/** A phrase to say may be a whole sentence. */
const SPOKEN_CHOICE_CHARS = 160;
const MARKS_RE = /<\/?\s*(?:t|slow(?:ly)?)\s*>/gi;

/** A choice that is an answer to the practice (a phrase or word in the
 *  target language) keeps its <t> mark, and nothing else does: the mark is
 *  how a tap knows to answer rather than to ask for something, and how the
 *  recap knows the learner chose rather than remembered. Its text, or null
 *  for a check-in answer (web/src/transcript.ts spokenChoice must match). */
export const spokenChoice = (c) => /^<t>([^<>]+)<\/t>$/.exec(String(c))?.[1] ?? null;

/** A choice as kept and replayed: one line, its length capped with its mark
 *  whole; "" for nothing. A mark around part of it is dropped: "<t>hola</t>,
 *  then wave" is words about a phrase, not a phrase to say. */
export function cleanChoice(raw) {
  const s = String(raw).replace(/[\r\n|]+/g, " ").replace(/\*\*/g, "").replace(/<\/?\s*slow(?:ly)?\s*>/gi, "").trim();
  const spoken = /^<\s*t\s*>/i.test(s) && /<\/\s*t\s*>$/i.test(s) && (s.match(/<\s*t\s*>/gi) ?? []).length === 1;
  const label = s.replace(MARKS_RE, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  if (!label) return "";
  return spoken ? `<t>${label.slice(0, SPOKEN_CHOICE_CHARS).trim()}</t>` : label.slice(0, CHOICE_CHARS).trim();
}
