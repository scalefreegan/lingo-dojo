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
//  - the word check's half, for languages beyond Mandarin (ld-ne0.17; the
//    last section): what may be scored (`liveWordTarget`), its own live bar
//    (`liveWordFlags`) and marks (`liveWordsReply`). Nothing of it is kept.
//
// Pure ESM with no server imports, like scripts/pronunciation-app.mjs.

import { SCORE_MAX_CHARS } from "./pronunciation-app.mjs";
import { readWordText, wordCheckLocale } from "./pronunciation-words.mjs";
import { COMMON_WORD_LISTS } from "./common-words.mjs";
import { unspacedLocale } from "../web/shared/word-check.ts";

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
  // Too many misses is more likely a misheard transcript than a learner:
  // past max(1, floor(n × maxOffShare)) offs, nothing. The floor of one is
  // deliberate: one off of one or of two still flags (a two-character word
  // with one clear miss is the most useful case there is), two of two
  // flags nothing; then one of three, two of six, three of nine.
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

/* ------------------------- words, beyond Mandarin -------------------------- */

// Live word checks (ld-ne0.17; docs/VOICE.md §Words in conversation): a
// Go-tab turn in a language the word check measures (wordCheckLocale) is
// assessed by Azure against its own transcript, as a Mandarin turn's tones
// are. The marks and rules are ld-ne0.16's (pronunciation-words.mjs); what
// is here is what differs in conversation.

const GAPS = /[\p{P}\s]/gu;

/** A text's letters, case-folded, punctuation and spaces dropped: what a
 *  turn's message must match for the score of its transcription to be used
 *  (the word check's `hanOf`). An edit of a letter is another text; a comma
 *  added in the box is not. */
export const wordsKey = (text) => String(text ?? "").normalize("NFC").toLowerCase().replace(GAPS, "");

/**
 * Each Latin-script language's everyday words (scripts/common-words.mjs:
 * the 3,000 most frequent of each, generated from one source at one cut,
 * so a word two languages share is in both lists). Only for
 * `ownLanguageLine` and `ownLanguageWord`: two languages of one script
 * can't be told apart by their letters, and the transcriber is asked for
 * the target language outright (ElevenLabs then reports that language for
 * an English line too, with probability 1: asked live, 2026-11-24), so
 * nothing else names the language of a line. Sets are built on first use.
 */
const commonSets = new Map();
function commonWords(locale) {
  const lang = String(locale ?? "").split("-")[0].toLowerCase();
  if (!Object.hasOwn(COMMON_WORD_LISTS, lang)) return null;
  if (!commonSets.has(lang)) commonSets.set(lang, new Set(COMMON_WORD_LISTS[lang].split(" ")));
  return commonSets.get(lang);
}
const WORD_SPLIT = /(?:\s|(?![-'’‐‑])\p{P})+/u;
const INNER = /['‐‑-]/;
/** A word is one of a language's when the list has it, or has every piece
 *  of it (j'ai is j' and ai in the list's own cut; a hyphenated word). */
function isCommon(set, word) {
  if (set.has(word)) return true;
  if (!INNER.test(word)) return false;
  const parts = word.split(INNER).filter(Boolean);
  return parts.length > 1 && parts.every((part, k) => set.has(part) || (k < parts.length - 1 && set.has(`${part}'`)));
}
const folded = (text) => String(text ?? "").normalize("NFC").toLowerCase().replace(/’/g, "'");

/**
 * Whether a line reads as the learner's own language, not the one they are
 * practising: more of its words are everyday words of `nativeLocale` than
 * of `targetLocale` (a word both languages have counts for both, so it
 * settles nothing; a tie is checked). Only where both are languages of
 * common-words.mjs and differ; false otherwise, and for a line with none
 * of either (a name). "Sorry, I don't understand" in a Spanish session is
 * the learner's own language; "Quiero un coffee, por favor" is not.
 *
 * Why it is needed: Azure scores a line against the reference it is given,
 * whatever the language. Asked live (2026-11-24, an English voice, es-MX),
 * it gave "Can you say that again please" three words right and "you" a 6,
 * which the live bar would have flagged as a Spanish word.
 */
export function ownLanguageLine(text, targetLocale, nativeLocale) {
  const target = commonWords(targetLocale);
  const own = commonWords(nativeLocale);
  if (!target || !own || target === own) return false;
  let t = 0;
  let n = 0;
  for (const word of folded(text).split(WORD_SPLIT)) {
    if (!word) continue;
    if (isCommon(target, word)) t++;
    if (isCommon(own, word)) n++;
  }
  return n > t;
}

/**
 * Whether one word is the learner's own language's and not the target's
 * ("coffee" in "Quiero un coffee, por favor"): such a word is never
 * flagged, whatever Azure made of it, since it was never a word of the
 * language being scored. Same lists and limits as ownLanguageLine.
 */
export function ownLanguageWord(word, targetLocale, nativeLocale) {
  const target = commonWords(targetLocale);
  const own = commonWords(nativeLocale);
  if (!target || !own || target === own) return false;
  const w = folded(word);
  return isCommon(own, w) && !isCommon(target, w);
}

/**
 * What a turn's transcript is checked against: `{ text, locale }` (the
 * Azure locale), or `{ skip }`: "locale" (not a language the word check
 * measures), "text" (not a phrase it takes: readWordText's rules, so no
 * digits or symbols, no letters of another script, and at most twelve
 * words, thirty characters in Japanese; a longer turn is not cut into
 * pieces, as a Mandarin one isn't) or "native" (a line in the learner's own
 * language: ownLanguageLine, with `nativeLocale` the transcription's second
 * locale).
 */
export function liveWordTarget(raw, locale, nativeLocale = "") {
  const azure = wordCheckLocale(locale);
  if (!azure) return { skip: "locale" };
  const t = readWordText(raw, azure);
  if (t.error !== undefined) return { skip: "text" };
  if (ownLanguageLine(t.text, azure, nativeLocale)) return { skip: "native" };
  return { text: t.text, locale: azure };
}

/**
 * The live bar for words, on top of WORD_RULES' own `off`. In conversation
 * the reference is what speech-to-text heard, so the question changes: not
 * "did they say this phrase" but "did the words they said sound right".
 * Each rule only ever withholds a flag:
 *
 *  - only Azure's `Mispronunciation` flags (`why: "sound"`), never a word it
 *    didn't hear (`Omission`): the transcriber heard that word and Azure
 *    didn't, which is two recognisers disagreeing, not a learner's slip;
 *  - and when Azure omitted or inserted any word, nothing in the turn
 *    flags: its alignment and the transcript disagree about which words
 *    were said, and a wrong word pulls Azure's scores onto its neighbours
 *    (both of the proof's false alarms sat beside a swapped word);
 *  - `flagBelow`: the word's score must be under this, stricter than the
 *    explicit check's 30. From the proof's trade-off table (docs/
 *    pronunciation-proof.md, "Omission unsure, guard on"): at 20, 1 of 535
 *    right words was off (none of the 391 in correctly read phrases), and
 *    11 of 247 words of an English voice reading the language;
 *  - `maxOffShare`: as for tones, a turn where more than this share of the
 *    words is off (floor of one) is more likely a misheard transcript.
 *
 * Not measured on running speech: the proof is short read phrases in
 * synthesized voices, and its cached replies were not re-scored with the
 * two turn-level rules (they can only lower the counts above).
 */
export const LIVE_WORD_RULES = Object.freeze({ flagBelow: 20, maxOffShare: 1 / 3 });

/**
 * The words of a turn's marks (wordMarks) that pass the live bar, as
 * indexes into `marks.words`, lowest score first (ties keep the line's
 * order). `azure` is the parsed reply the marks were made from. [] when
 * none, or when the turn as a whole looks unreliable.
 */
export function liveWordFlags(marks, azure, rules = LIVE_WORD_RULES) {
  const words = Array.isArray(marks?.words) ? marks.words : [];
  if (!words.length || marks.heard === "none") return [];
  const all = Array.isArray(azure?.words) ? azure.words : [];
  if (all.some((w) => w?.error === "Omission" || w?.error === "Insertion")) return [];
  // A word Azure sent that couldn't be placed on the line: the counts
  // differ, and "word 2 of their line" would point at the wrong word.
  if (words.length !== all.length) return [];
  const offs = words.filter((w) => w?.verdict === "off").length;
  if (offs > Math.max(1, Math.floor(words.length * rules.maxOffShare))) return [];
  const flagged = [];
  words.forEach((w, i) => {
    if (w?.verdict !== "off" || w.why !== "sound") return;
    if (!(Number.isFinite(w.score) && w.score < rules.flagBelow)) return;
    flagged.push(i);
  });
  return flagged.sort((a, b) => words[a].score - words[b].score || a - b);
}

/**
 * Whether a turn's word marks are worth showing at all. Not when Azure
 * heard none of the transcript's words, and not when more than
 * `maxOffShare` of them (floor of one) came out off by the word check's own
 * rules: the same sign that stops every flag (a misheard transcript, cuts
 * in the wrong places). Marks under such a line would be about words nobody
 * said. (A line in the learner's own language is not caught here: Azure
 * scores it much like any other. ownLanguageLine is what keeps it out.)
 */
export function liveWordsShown(marks, rules = LIVE_WORD_RULES) {
  const words = Array.isArray(marks?.words) ? marks.words : [];
  if (!words.length || marks.heard === "none") return false;
  const offs = words.filter((w) => w?.verdict === "off").length;
  return offs <= Math.max(1, Math.floor(words.length * rules.maxOffShare));
}

/** What the dojo master is told about one flagged word (scripts/voice.mjs
 *  wordPronunciationBlock): the word as the line writes it and its place
 *  among the line's words (1-based, so a word said twice is told apart).
 *  No place where words aren't spaced (Japanese): the split is Azure's, and
 *  "word 3" of an unspaced line names nothing a reader could count to. */
export function liveWordNote(marks, i, locale = "") {
  const word = marks.words[i].text;
  return unspacedLocale(String(locale)) ? { word } : { word, place: i + 1 };
}

/**
 * The Go tab's marks for the learner's line, from the word check's reply
 * (wordsReply, adults): an `off` that isn't in `flags` is shown as "not
 * sure" (reason "live_bar"), a word Azure didn't hear among them, so the
 * screen never shows a miss the live bar didn't vouch for. Every flag stays
 * off on screen; the dojo master is told the first only (one step-in a
 * turn), as for tones. No
 * `overall`: one number for a sentence said in conversation would read as a
 * grade. A reply that heard none of the words stays as it is (no verdicts).
 */
export function liveWordsReply(reply, flags) {
  const keep = new Set(flags);
  const words = reply.words.map((w, i) => {
    if (w.verdict !== "off" || keep.has(i)) return w;
    const { why: _w, sounds: _s, ...rest } = w;
    return { ...rest, verdict: "unsure", reason: "live_bar" };
  });
  return { ...reply, words, overall: null };
}
