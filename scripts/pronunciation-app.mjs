// Pronunciation scoring in the app, stage 1 (ld-ne0.2): the pure half of
// POST /api/pronunciation/score (web/server/pronunciation.ts). The engine
// itself is scripts/pronunciation.mjs; this module holds the rules the
// route applies around it, so `node --test` covers them without a server:
//
//  - what text may be scored (a few Han characters, read by the caller's
//    pinyin reader) and what audio (the recorder's 16 kHz mono PCM WAV,
//    at most 30 seconds);
//  - which engine runs: Azure whenever its keys are set, for any learner,
//    the local scorer otherwise or as the fallback;
//  - on the character card, a lone character judged against every reading
//    the card shows for it (行 xíng or háng), not one reading picked;
//  - the per-user cap on Azure calls (over it, the local scorer answers);
//  - the reply: the engine's result cut down to what the page draws, with
//    each syllable's contour and the canonical shape of its tone.
//
// Pure ESM with no server imports, like scripts/practice.mjs.

import { AZURE_MAX_SECONDS, LOCAL_MAX_SECONDS, TONE_RULES, expectedSyllables, parsePinyin } from "./pronunciation.mjs";

/* ---------------------------------- text ---------------------------------- */

/** The most Han characters one score request takes. Stage 1 scores where
 *  the text is known and short: a character on the card, a Practice
 *  phrase. The engine's proof is strongest on single syllables and short
 *  phrases (docs/VOICE.md §Pronunciation, "Before wiring"); a long
 *  sentence is stage 2's. */
export const SCORE_MAX_CHARS = 24;
/** The whole text, punctuation and spaces included. */
const SCORE_MAX_LENGTH = 64;
const HAN = /\p{Script=Han}/u;
// Han characters, and the punctuation and spaces a bank phrase carries
// (你好！, 「謝謝」): punctuation ends a tone group for the sandhi rules, so
// it is kept, never scored. Latin letters, digits, emoji and the rest are
// refused: the scorer has no reading for them.
const SCORE_TEXT_RE = /^[\p{Script=Han}\p{P}\s]+$/u;

/** The text to score, or why not: `{ text }` or `{ error }`. */
export function readScoreText(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { error: "say what the recording should be: text=<Chinese characters>" };
  const cps = [...text];
  const han = cps.filter((c) => HAN.test(c)).length;
  if (cps.length > SCORE_MAX_LENGTH || !SCORE_TEXT_RE.test(text) || han === 0 || han > SCORE_MAX_CHARS) {
    return { error: `the text to score is 1 to ${SCORE_MAX_CHARS} Chinese characters (punctuation allowed, nothing else)` };
  }
  return { text };
}

/**
 * What should have been said, from the caller's readings (one per code
 * point: web/src/script/zh.ts readCodePoints for the learner's locale).
 * Every Han character must have a reading, or the syllables would no
 * longer line up with the characters on the page: `{ syllables }` or
 * `{ error }`.
 *
 * `alternatives`: on the character card only (the route passes them only
 * when the page asks, for a text of one character alone), every reading
 * the card shows for it, its usual one first (zh.ts charReadings). On the
 * card there is no context to pick one: 长 alone is cháng or zhǎng, 行 xíng
 * or háng, and a learner saying the other is not wrong. So the syllable
 * expects the usual reading and accepts the tone of every reading
 * (`readings` travels with it, for scoreReply to name the one heard). A
 * neutral usual reading (了 le, 的 de) stays the neutral tone, which is not
 * judged. A character whose readings take all four tones (拉 lā lá lǎ là)
 * can't be checked alone (`everyTone`: scoreReply says "not sure"). A
 * Practice phrase, even of one character (好, 不！), keeps its one reading.
 */
export function scoreSyllables(text, readings, { alternatives = null } = {}) {
  const cps = [...text];
  const missing = cps.find((c, i) => HAN.test(c) && !readings?.[i]);
  if (missing) return { error: `no reading is known for ${missing}, so it can't be scored` };
  const syllables = expectedSyllables(text, readings);
  const list = Array.isArray(alternatives) ? alternatives.filter((r) => typeof r === "string" && r) : [];
  if (syllables.length !== 1 || !list.length) return { syllables };
  const usual = list[0];
  const tone = parsePinyin(usual).tone;
  const tones = [...new Set(list.map((r) => parsePinyin(r).tone).filter((t) => t >= 1 && t <= 4))];
  const everyTone = tone !== 0 && [1, 2, 3, 4].every((t) => tones.includes(t));
  return {
    syllables: [{ ...syllables[0], pinyin: usual, baseTone: tone, expectedTone: tone, accept: tone === 0 ? [0] : [tone, ...tones.filter((t) => t !== tone)], half: false, readings: list, ...(everyTone ? { everyTone } : {}) }],
  };
}

/* ---------------------------------- audio --------------------------------- */

/** The recorder's format (web/src/recorder.ts toWav), the only one taken:
 *  Azure assesses 16 kHz mono PCM, and one format for both engines keeps
 *  the two paths comparable. */
export const SCORE_SAMPLE_RATE = 16_000;
export const SCORE_MAX_SECONDS = Math.min(AZURE_MAX_SECONDS, LOCAL_MAX_SECONDS);
/** Shorter than this holds no syllable worth judging. */
export const SCORE_MIN_MS = 250;
/** The body cap: 30 seconds of 16 kHz 16-bit mono, plus room for the
 *  header chunks a WAV writer may add. Checked while reading, before any
 *  parsing. */
export const SCORE_MAX_BYTES = 44 + SCORE_MAX_SECONDS * SCORE_SAMPLE_RATE * 2 + 4096;

/** A WAV's format from its header alone: `{ format, channels, sampleRate,
 *  bits, dataBytes }`, or null when it isn't a RIFF/WAVE with a fmt and a
 *  data chunk. */
export function wavHeader(u8) {
  if (!(u8 instanceof Uint8Array) || u8.length < 44) return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let fmt = null;
  for (let at = 12; at + 8 <= u8.length; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && body + 16 <= u8.length) {
      fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === "data") {
      return fmt ? { ...fmt, dataBytes: Math.min(size, u8.length - body) } : null;
    }
    at = body + size + (size & 1);
  }
  return null;
}

/** Whether a recording can be scored: `{ seconds }` or `{ error, status }`
 *  (415 for another format, 400 for one too short, 413 too long). */
export function readScoreAudio(u8) {
  const h = wavHeader(u8);
  if (!h) return { status: 415, error: "a recording must be a WAV file" };
  if ((h.format !== 1 && h.format !== 0xfffe) || h.bits !== 16 || h.channels !== 1 || h.sampleRate !== SCORE_SAMPLE_RATE) {
    return { status: 415, error: "a recording must be 16 kHz mono 16-bit PCM WAV" };
  }
  const seconds = h.dataBytes / 2 / h.sampleRate;
  if (seconds * 1000 < SCORE_MIN_MS) return { status: 400, error: "the recording is too short to score" };
  if (seconds > SCORE_MAX_SECONDS) return { status: 413, error: `a recording to score is at most ${SCORE_MAX_SECONDS} seconds` };
  return { seconds };
}

/* --------------------------------- engine --------------------------------- */

/**
 * Which engine scores a recording, before anything is tried: `{ engine,
 * why }`. Azure when its key and region are set (`pronunciationProvider`'s
 * test), else local (`why: "no_keys"`). The same for every learner, adult
 * or kids (the owner's decision, 2026-11-19): a kids learner's recording
 * goes to Azure for scoring as it already goes to the transcription
 * provider; only what the page shows differs (scoreReply's `kids`).
 */
export function scoringEngine({ keys }) {
  const azure = keys && String(keys.azureKey ?? "").trim() && String(keys.azureRegion ?? "").trim();
  return azure ? { engine: "azure", why: null } : { engine: "local", why: "no_keys" };
}

/** Azure calls one user may make in a minute; past it the local scorer
 *  answers (the page just sees more "not sure"). A learner saying a
 *  character over and over makes a call each time: this keeps a stuck
 *  key or a loop from spending the owner's credits. */
export const AZURE_PER_MINUTE = 12;

/** A sliding one-minute window per user. `take(userId, now)` is true when
 *  the call may go (and counts it), false when the user is at the cap. */
export function azureLimiter(perMinute = AZURE_PER_MINUTE, windowMs = 60_000) {
  const calls = new Map();
  return {
    take(userId, now = Date.now()) {
      const recent = (calls.get(userId) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= perMinute) {
        calls.set(userId, recent);
        return false;
      }
      recent.push(now);
      calls.set(userId, recent);
      return true;
    },
  };
}

/** Whether an Azure reply can be merged: recognised, with words. Anything
 *  else (NoMatch, silence, an empty list) is a failed call, and the local
 *  scorer answers instead. */
export function azureUsable(parsed) {
  return parsed?.status === "Success" && Array.isArray(parsed.words) && parsed.words.length > 0;
}

/* ---------------------------------- reply --------------------------------- */

const POINTS = 16;

/** The textbook shape of a tone on Chao's five-level scale, from start to
 *  end (the five points join with straight lines). The half third (a third
 *  tone before another tone) is low without the rise. Neutral: none. */
const CHAO = { 1: [5, 5], 2: [3, 5], 3: [2, 1, 4], 4: [5, 1] };
const HALF_THIRD = [2, 1, 1];

/**
 * The reference curve for a syllable: `points` values in semitones, centred
 * on their own mean (one Chao step is `stepSt`, the scorer's own, so a
 * fourth tone falls about ten semitones), or null for the neutral tone.
 * The canonical shape, not a narrator's take: decoding the narrator's
 * cached MP3 on the server would need a decoder this repo doesn't have.
 */
export function toneShape(tone, { half = false, points = POINTS, stepSt = TONE_RULES.stepSt } = {}) {
  const levels = tone === 3 && half ? HALF_THIRD : CHAO[tone];
  if (!levels) return null;
  const out = [];
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * (levels.length - 1);
    const k = Math.min(levels.length - 2, Math.floor(x));
    out.push(levels[k] + (levels[k + 1] - levels[k]) * (x - k));
  }
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  return out.map((v) => round2((v - mean) * stepSt));
}

/** A syllable's measured curve (semitones about the speaker's median, null
 *  where unvoiced) centred on its own voiced mean: the page compares
 *  shapes, since without the speaker's range the height means little (and
 *  the scorer itself reads only the shape then). [] when not measured. */
export function centredCurve(pitch) {
  const voiced = (Array.isArray(pitch) ? pitch : []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (voiced.length < 2) return [];
  const mean = voiced.reduce((a, b) => a + b, 0) / voiced.length;
  return pitch.map((v) => (typeof v === "number" && Number.isFinite(v) ? round2(v - mean) : null));
}

/**
 * The engine's result as the page gets it. Per syllable: the character,
 * its pinyin, the tone expected and every tone accepted, the verdict, the
 * heard tone only on an `off` (an `ok` or `unsure` names none: an unsure
 * guess shown would read as a verdict), why it is off (`tone`, or `sound`
 * from Azure) or unsure (the engine's reason), and both curves. `overall`
 * is left out for a kids learner (no scores in kids mode). `retry` is
 * "clipped" when the recording began inside the first syllable: the page
 * asks for it again.
 */
export function scoreReply(result, syllables, { engine, fallback = null, kids = false, text, locale, frames = null }) {
  const out = result.syllables.map((s, i) => {
    const expected = syllables[i];
    const off = s.verdict === "off";
    const span = { startMs: Number.isFinite(s.startMs) ? s.startMs : null, endMs: Number.isFinite(s.endMs) ? s.endMs : null };
    // The card's character, its readings in all four tones: whatever was
    // heard fits one, so nothing is checked.
    if (expected?.everyTone) {
      return {
        char: s.char, pinyin: s.pinyin, expectedTone: s.expectedTone, accept: s.accept, verdict: "unsure", reason: "every_tone",
        ...span, heard: centredCurve(s.pitch), reference: toneShape(s.expectedTone),
      };
    }
    // The card's character with several readings (scoreSyllables'
    // `alternatives`): an ok names the reading whose tone was heard, and
    // `usual` the usual one when the heard one is another (行 said háng is
    // "háng, another reading", not just "right"); a miss keeps the usual
    // reading as the one expected.
    const matched = s.verdict === "ok" && Array.isArray(expected?.readings) ? expected.readings.find((r) => parsePinyin(r).tone === s.heardTone) : null;
    const other = matched && matched !== expected.readings[0];
    const expectedTone = matched ? s.heardTone : s.expectedTone;
    return {
      char: s.char,
      pinyin: matched ?? s.pinyin,
      ...(other ? { usual: expected.readings[0] } : {}),
      expectedTone,
      accept: s.accept,
      ...(expected?.half && expectedTone === 3 ? { half: true } : {}),
      verdict: s.verdict === "ok" || off ? s.verdict : "unsure",
      ...(off && Number.isInteger(s.heardTone) ? { heardTone: s.heardTone } : {}),
      // Where several tones count (我 before 很; a card character's
      // readings), the one an "ok" heard: compare mode reads the curve
      // against it, not against a tone the learner didn't aim for.
      ...(s.verdict === "ok" && Array.isArray(s.accept) && s.accept.length > 1 && s.accept.includes(s.heardTone) ? { saidTone: s.heardTone } : {}),
      ...(off ? { why: s.reason === "sound" ? "sound" : "tone" } : s.verdict !== "ok" && s.reason ? { reason: s.reason } : {}),
      // Azure's 0–100 score for how the syllable sounded (its consonant and
      // vowel together: for Mandarin Azure scores whole syllables), for the
      // compare tips. Adults only: no scores in kids mode.
      ...(!kids && engine === "azure" && Number.isFinite(s.score) ? { soundScore: Math.round(s.score) } : {}),
      ...span,
      heard: centredCurve(s.pitch),
      reference: toneShape(expectedTone, { half: !!expected?.half }),
    };
  });
  return {
    engine,
    fallback,
    text,
    locale,
    syllables: out,
    overall: kids || !Number.isFinite(result.overall) || syllables.some((x) => x.everyTone) ? null : result.overall,
    retry: result.syllables[0]?.reason === "clipped" ? "clipped" : null,
    // The whole take frame by frame, for the compare picture (pronunciation-
    // compare.mjs takeFrames): sent back with the marks, never kept.
    ...(frames ? { frames } : {}),
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
