// Pronunciation in live conversation, stage 2 (ld-ne0.3; docs/VOICE.md
// §Pronunciation in conversation): the pure rules around scoring a Go-tab
// turn. The engine and its worker are stage 1's (scripts/pronunciation.mjs,
// web/server/pronunciation.ts); the server half that holds a turn's score
// between its transcription and its turn is web/server/livePronunciation.ts.
//
//  - what may be scored: the transcript, only when it is Mandarin alone (Han
//    characters, punctuation and spaces) and short (stage 1's 24 characters);
//    a mixed or a long turn is not scored at all, since no span can tell
//    which part of the audio a reference character is;
//  - the live bar (`liveFlags`): stricter than the engine's own `off`. The
//    reference is what speech-to-text heard, which can be wrong, and the
//    learner is talking freely in a real room: a wrong flag in conversation
//    costs more than a missed one;
//  - the marks the Go tab shows (`liveReply`): an engine `off` below the
//    live bar is shown as "not sure", never as a miss the dojo master
//    wasn't told about;
//  - the coaching dial (`coachingOf`), a word from the browser like `pace`;
//  - the compact per-syllable record kept for stage 3 (`liveRecord`).
//
// Pure ESM with no server imports, like scripts/pronunciation-app.mjs.

import { SCORE_MAX_CHARS } from "./pronunciation-app.mjs";

/* --------------------------------- the dial -------------------------------- */

/** The coaching dial, per session: "off" (no analysis at all: nothing is
 *  scored, shown or kept), "light" (the default: the dojo master may step
 *  in once, briefly, on a clear miss) or "strict" (it asks for the word
 *  again). Kids sessions have no dial. */
export const COACHING = ["off", "light", "strict"];
export const DEFAULT_COACHING = "light";

/** The dial from a request: absent or "" is the default, one of the three
 *  words is itself, anything else (a number, another word) is null, which
 *  the routes answer 400. */
export function coachingOf(v) {
  if (v == null || v === "") return DEFAULT_COACHING;
  return typeof v === "string" && COACHING.includes(v) ? v : null;
}

/* --------------------------------- the text -------------------------------- */

const HAN_G = /\p{Script=Han}/gu;
// Han, punctuation, spaces: stage 1's text (readScoreText). Anything else
// (Latin letters, digits, emoji) is a turn in more than one language, or
// one the reader can't read: not scored.
const MANDARIN_ONLY = /^[\p{Script=Han}\p{P}\s]+$/u;
/** Stage 1's whole-text bound (punctuation and spaces included). */
const MAX_LENGTH = 64;

/** The Han characters of a text, in order: what a turn's message must
 *  match for the score of its transcription to be used. */
export const hanOf = (text) => (String(text ?? "").match(HAN_G) ?? []).join("");

/**
 * What a turn's transcript is scored against: `{ text }`, or `{ skip }`
 * with why not: "no_han" (nothing to score: English, a filler the
 * transcriber wrote in Latin letters), "mixed" (other letters, digits or
 * symbols beside the Han: a code-switched turn, whose audio holds sounds no
 * reference character stands for), "long" (over SCORE_MAX_CHARS Han
 * characters: the engine's proof is on single syllables and short phrases,
 * and nothing can cut a long turn into pieces without timings per piece).
 */
export function liveTarget(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  const han = hanOf(text).length;
  if (!han) return { skip: "no_han" };
  if (!MANDARIN_ONLY.test(text)) return { skip: "mixed" };
  if (han > SCORE_MAX_CHARS || [...text].length > MAX_LENGTH) return { skip: "long" };
  return { text };
}

/* --------------------------------- the bar --------------------------------- */

/**
 * The live bar, on top of the engine's own `off` (which already needs every
 * accepted tone ruled out, a clean measurement and, in a phrase, half a
 * semitone more: TONE_RULES). Each number only ever withholds a flag:
 *
 *  - minMarginSt: the contour must rule out every right tone by this many
 *    semitones (the engine flags at 0, 0.5 in a phrase);
 *  - minConfidence, minQuality: the engine's own confidence (quality ×
 *    the cuts' trust × the margin) and how clean the pitch was;
 *  - minVoicedMs: enough voice for five points to mean something;
 *  - maxOffShare: a turn where more than this share of the syllables comes
 *    out "off" is more likely a misheard transcript (the reference is the
 *    wrong words) or cuts in the wrong places than a learner missing that
 *    many tones: nothing in it is flagged;
 *  - quiet: interjections and particles whose tone varies with feeling in
 *    ordinary speech (啊 a/á/à, 嗯 ńg/ňg, 哦 ó/ò …): never flagged.
 *
 * Creak never flags (the engine's `creakFlags` is off; a creaky syllable
 * that came out "off" is not flagged here either), nor does Azure's sound
 * score (`reason: "sound"`): the dojo master is told about tones only, and
 * a tone it can name.
 */
export const LIVE_RULES = Object.freeze({
  minMarginSt: 1,
  minConfidence: 0.6,
  minQuality: 0.85,
  minVoicedMs: 120,
  maxOffShare: 1 / 3,
  quiet: "啊呀哇哪嗯哦噢喔呃唉哎诶欸哈嘿嗨喂吧呢嘛吗么啦咯哟呦",
});

/**
 * The syllables of an engine result that pass the live bar, as indexes,
 * most certain first (the largest margin; ties keep the line's order).
 * [] when none, or when the turn as a whole looks unreliable.
 */
export function liveFlags(result, rules = LIVE_RULES) {
  const syl = Array.isArray(result?.syllables) ? result.syllables : [];
  if (!syl.length || result?.timingsProblem) return [];
  const offs = syl.filter((s) => s?.verdict === "off").length;
  if (offs > Math.max(1, Math.floor(syl.length * rules.maxOffShare))) return [];
  const flagged = [];
  syl.forEach((s, i) => {
    if (s?.verdict !== "off") return;
    if (s.reason !== undefined && s.reason !== "tone") return;
    if (s.creaky) return;
    if (!(s.expectedTone >= 1 && s.expectedTone <= 4)) return;
    if (!Number.isInteger(s.heardTone) || s.heardTone < 1 || s.heardTone > 4) return;
    if (!Array.isArray(s.accept) || s.accept.includes(s.heardTone)) return;
    if (!(Number.isFinite(s.margin) && s.margin >= rules.minMarginSt)) return;
    if (!(Number.isFinite(s.confidence) && s.confidence >= rules.minConfidence)) return;
    if (!(Number.isFinite(s.quality) && s.quality >= rules.minQuality)) return;
    if (!(Number.isFinite(s.voicedMs) && s.voicedMs >= rules.minVoicedMs)) return;
    if (rules.quiet.includes(s.char)) return;
    flagged.push(i);
  });
  return flagged.sort((a, b) => syl[b].margin - syl[a].margin || a - b);
}

/** What the dojo master is told about one flagged syllable (the prompt
 *  block, scripts/voice.mjs pronunciationBlock): the character, where it is
 *  in the line (its place among the line's Han characters, 1-based, so a
 *  character said twice is told apart), its reading, the tones. */
export function flagNote(result, i) {
  const s = result.syllables[i];
  return { char: s.char, place: i + 1, pinyin: s.pinyin, expectedTone: s.expectedTone, heardTone: s.heardTone };
}

/* --------------------------------- the reply ------------------------------- */

/**
 * The Go tab's marks for the learner's line, from stage 1's reply
 * (pronunciation-app.mjs scoreReply): an `off` that isn't in `flags` is
 * shown as "not sure" (reason "live_bar"), so the screen never shows a miss
 * the dojo master wasn't told about and the bar didn't vouch for. No score
 * (`overall`: one number for a sentence said in conversation would read as
 * a grade) and no compare frames (no model clip exists for free speech).
 */
export function liveReply(reply, flags) {
  const keep = new Set(flags);
  const syllables = reply.syllables.map((s, i) => {
    if (s.verdict !== "off" || keep.has(i)) return s;
    const { heardTone: _h, why: _w, ...rest } = s;
    return { ...rest, verdict: "unsure", reason: "live_bar" };
  });
  const { frames: _f, ...rest } = reply;
  return { ...rest, syllables, overall: null };
}

/**
 * The compact per-syllable record a scored turn keeps (pronunciation_checks
 * .syllables) for stage 3: what was expected, the live verdict (the bar
 * applied, as on screen), the tone heard where the engine named one, how
 * sure it was, and where it sat in the recording.
 */
export function liveRecord(result, flags) {
  const keep = new Set(flags);
  return result.syllables.map((s, i) => {
    const verdict = s.verdict === "ok" ? "ok" : s.verdict === "off" && keep.has(i) ? "off" : "unsure";
    return {
      char: s.char,
      pinyin: s.pinyin,
      expectedTone: s.expectedTone,
      accept: s.accept,
      verdict,
      ...(verdict !== "unsure" && Number.isInteger(s.heardTone) ? { heardTone: s.heardTone } : {}),
      ...(verdict === "unsure" ? { reason: s.verdict === "off" ? "live_bar" : (s.reason ?? "unclear") } : {}),
      ...(Number.isFinite(s.margin) ? { margin: s.margin } : {}),
      ...(Number.isFinite(s.confidence) ? { confidence: s.confidence } : {}),
      startMs: Number.isFinite(s.startMs) ? s.startMs : null,
      endMs: Number.isFinite(s.endMs) ? s.endMs : null,
    };
  });
}
