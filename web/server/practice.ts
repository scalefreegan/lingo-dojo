import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { audioKey, cachedAudio } from "../../scripts/audio-cache.mjs";
import { failureHint, startClaude } from "../../scripts/claude.mjs";
import { clozeKey, gapped } from "../../scripts/cloze.mjs";
import { clozeItem, flagClozeItem } from "../../scripts/db/cloze.ts";
import { EDITED, PracticeError, clozeProblem, overrideReview, practiceCandidates, practiceCard, practiceDone, recordAnswer, reviewId } from "../../scripts/db/practice.ts";
import { graderPrompt, parseGraderReply } from "../../scripts/match.mjs";
import { isUuid } from "../../scripts/phrases.mjs";
import {
  buildQueue, choiceMatch, dayStart, offeredChoices, sameChoice, gradeOutcome, graderQuestion, listenMatch, localMatch, needsGrader, readAnswerInput, readDirection, readLength, readMode,
  readOverrideInput, readUtcOffset, cardVersion, phraseRevision,
} from "../../scripts/practice.mjs";
import { localeFor } from "../../scripts/voice.mjs";
import type { PracticeAnswerReply, PracticeFlagReply, PracticeQueueReply, PracticeStatsReply, PracticeTranscribeReply } from "../shared/practice.ts";
import type { LearnerCtx } from "./auth.ts";
import { clozeStatus, fillCloze, withCloze } from "./cloze.ts";
import { rawDb } from "./db.ts";
import { paidSlot } from "./paid.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";
import { readVoiceSettings } from "./store.ts";
import { SPEECH_FORMATS, practiceVoice, readAudio, sttReady, synthesize, transcribeAudio, voiceReady } from "./voice.ts";

// The Practice tab's routes (docs/DATA.md §Practice modes, §Grading):
// flashcards both ways, the listening drill, speak-it and fill the gap
// (cloze) over the active learner's active language's bank.
//
//   GET  /api/practice                       ?mode=&direction=&tz= → {stats, language, setup, cloze}: what is due and new, today's progress
//   GET  /api/practice/queue                 ?length=5|10|20&mode=flashcards|listening|speak|cloze|mixed&direction=mixed|recognize|produce&tz=
//                                            → {items, stats, language, cloze}
//   POST /api/practice/answer                {phraseId, skill, drill?, version, revision, submitId, answer? | choice? | reveal + rating, clozeId?, spoken?, durationMs?, tz?}
//                                            → the review
//   POST /api/practice/reviews/:id/override  {rating, tz?} → the review, regraded
//   POST /api/practice/cloze/:id/flag        a bad cloze sentence: never shown again; records nothing
//   GET  /api/practice/audio/:phraseId       the phrase said in the user's voice for the language (cached on disk)
//   POST /api/practice/transcribe            a speak-it recording (WAV) → {text}; records nothing
//
// Mounted with wrap's `learner: true`: the page must name the session's
// learner and language (else 409 stale_learner), and every row is read and
// written through that language's scope (scripts/db/practice.ts). Kids
// learners don't practise this way (DATA.md §Kids learners): their tab is
// hidden and these routes are a 403.
//
// `tz` is the browser's UTC offset in minutes (local minus UTC): the day
// the limits count and the day boundary FSRS schedules by turn over at
// 4 a.m. there. The server keeps no timezone per learner.
//
// Grading: the lenient local match first; on a miss with something typed
// (or said), one tool-less Haiku `claude -p` call (match.mjs graderPrompt,
// the answer fenced and defanged, the reply parsed defensively), before the
// write's transaction so no lock waits on a model. Its note is model
// output, cleaned and capped (practice.mjs gradeOutcome) before it is
// stored or sent. A listening card's picked choice is right or wrong at
// once, with no model.
//
// Audio: the phrase route takes a phrase id this language owns, never a
// hash or text, so the shared on-disk cache (scripts/audio-cache.mjs) can't
// be used to read or probe another learner's phrases, and no path is made
// from anything the client sends.

/** The grader: the cheapest model, which is plenty for one yes/no. */
const GRADER_MODEL = "claude-haiku-5-5";
const GRADER_TIMEOUT_SEC = 45;

const STATUS_BY_CODE: Record<PracticeError["code"], number> = { ENOENT: 404, ECONFLICT: 409 };

async function op<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PracticeError) throw new HttpError(STATUS_BY_CODE[e.code], e.message);
    throw e;
  }
}

const targetLocale = (ctx: LearnerCtx) => localeFor(ctx.language.targetLanguage, ctx.language.targetVariant) ?? "";
const nativeLocale = (ctx: LearnerCtx) => localeFor(ctx.learner.nativeLanguage, "") ?? "";

function languageOf(ctx: LearnerCtx): PracticeStatsReply["language"] {
  return {
    targetLanguage: ctx.language.targetLanguage,
    targetVariant: ctx.language.targetVariant,
    locale: localeFor(ctx.language.targetLanguage, ctx.language.targetVariant),
    nativeLanguage: ctx.learner.nativeLanguage,
  };
}

/**
 * The queue (and its stats) for this request's day and filters. The cloze
 * and mixed modes read each phrase's cloze sentences first (made from its
 * session lines on the way: cloze.ts withCloze, no model); so does a
 * flashcards session being started, for the sentence on each card's
 * answer side (its counts don't need them, so they don't read them). Only
 * a session being started (`start`: the queue route, never the counts the
 * tab shows or polls) has sentences written, and only for the phrases
 * that session would show in one (practice.mjs clozeWanted: a gap within
 * its length and what is left of today's limits, or its own cards with
 * none), in the background (fillCloze, under the language's daily cap):
 * the queue never waits for a model.
 */
async function queue(req: IncomingMessage, ctx: LearnerCtx, start: boolean) {
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  const now = new Date();
  const since = dayStart(now, readUtcOffset(q.get("tz")));
  const mode = readMode(q.get("mode"));
  const [read, done] = await Promise.all([practiceCandidates(rawDb(), ctx.language), practiceDone(rawDb(), ctx.language, since)]);
  const usesCloze = mode === "cloze" || mode === "mixed";
  const phrases = usesCloze || (start && mode === "flashcards") ? await withCloze(ctx, read) : read;
  const { clozeWanted, clozeWaiting, ...built } = buildQueue(phrases, {
    now,
    done,
    length: readLength(q.get("length")),
    mode,
    direction: readDirection(q.get("direction")),
    nativeLocale: nativeLocale(ctx),
  });
  if (start && clozeWanted.length) await fillCloze(ctx, clozeWanted);
  const cloze = usesCloze ? { waiting: mode === "cloze" ? clozeWaiting : 0, ...(await clozeStatus(ctx)) } : null;
  return { ...built, cloze };
}

type GraderInput = Parameters<typeof graderPrompt>[0];

/**
 * The model check on a miss: `{ grader }` with its parsed reply, or
 * `{ failed: true }` when it couldn't run or answered nothing usable (the
 * answer is then wrong, and the learner can override). A browser that gave
 * up (the page closed) cancels it.
 */
async function runGrader(res: ServerResponse, input: GraderInput): Promise<{ grader: ReturnType<typeof parseGraderReply>; failed: boolean }> {
  const ctrl = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort();
  };
  res.on("close", onClose);
  try {
    const { result } = startClaude({
      prompt: graderPrompt(input),
      model: GRADER_MODEL,
      // No tools and an empty cwd, as a voice turn: the repo's CLAUDE.md
      // (instructions for coding agents) stays out of the grade.
      cwd: os.tmpdir(),
      signal: ctrl.signal,
      tools: "none",
      maxTurns: 1,
      timeoutSec: GRADER_TIMEOUT_SEC,
    });
    const run = await result;
    // Strict: the reply must be the one JSON object. The answer is in the
    // prompt, so a reply that quotes an answer typed as {"accepted": true}
    // before its own verdict must not be read as that.
    const grader = parseGraderReply(run.text, { strict: true });
    if (!grader) console.error("[lingo-dojo] practice: the grader's reply wasn't usable; graded as wrong");
    return { grader, failed: !grader };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (msg === "cancelled") throw new HttpError(499, "cancelled");
    console.error(`[lingo-dojo] practice: the grader failed (${failureHint(msg) || msg}); graded as wrong`);
    return { grader: null, failed: true };
  } finally {
    res.off("close", onClose);
  }
}

async function answer(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const r = readAnswerInput(await readJsonBody(req));
  if (r.error !== undefined) throw new HttpError(400, r.error);
  const a = r.value;
  const { phrase, card } = await op(() => practiceCard(rawDb(), ctx.language, a.phraseId, a.skill));
  const graded = { text: phrase.text ?? "", meaning: phrase.meaning ?? "" };
  // A card already past this version is a repeat (or another tab's): the
  // write answers it from the stored review without grading it again.
  const stale = cardVersion(card ? { reps: card.reps, last_review: card.last_review } : null) !== a.version;
  // The phrase edited since the card was shown: the question the learner
  // answered isn't this one any more. Refused before any grading (the
  // write checks again, under its lock, for an edit during grading).
  if (!stale && phraseRevision(phrase) !== a.revision) throw new HttpError(409, EDITED);
  // A cloze answer is graded against the sentence it names: one of this
  // phrase's, made for its words and meaning as they are, not flagged.
  // Checked before any grading (no model call for a stale sentence), and
  // again under the write's lock.
  let gap: string | null = null;
  let full: string | null = null;
  if (a.drill === "cloze" && !stale) {
    const item = await clozeItem(rawDb(), ctx.language, a.clozeId!);
    const problem = clozeProblem(item, phrase.id, clozeKey(phrase));
    if (problem) throw new HttpError(409, problem);
    gap = gapped(item!);
    full = item!.sentence;
  }
  // No grade for a stale card: the write replays the stored review or
  // refuses (409), and never records one.
  let outcome = stale ? null : a.reveal ? gradeOutcome({ reveal: true, rating: a.rating }) : null;
  let keepAlternate = false;
  if (!a.reveal && !stale) {
    const locales = { targetLocale: targetLocale(ctx), nativeLocale: nativeLocale(ctx) };
    let match;
    if (a.choice) {
      // Only a pick among the choices this card offered: they are drawn
      // again from the same seed (phrase, card version, revision) and
      // bank, never taken from the client.
      const bank = await op(() => practiceCandidates(rawDb(), ctx.language));
      const self = bank.find((p) => p.id === phrase.id);
      const offered = self ? offeredChoices(self, bank, { version: a.version, nativeLocale: locales.nativeLocale }) : null;
      if (!offered) throw new HttpError(400, "this card offered no choices: type the answer instead");
      // The bank may have grown since the queue drew them (a capture in
      // another tab reshuffles the draw): a pick that is still some
      // phrase's meaning in this bank is graded (the right one is always
      // offered); anything else was never on offer.
      const known = offered.includes(a.answer) || bank.some((p) => sameChoice(p.meaning, a.answer));
      if (!known) throw new HttpError(409, "that isn't one of the choices this card offered; skip it");
      match = choiceMatch({ choice: a.answer, meaning: graded.meaning, nativeLocale: locales.nativeLocale });
    } else if (a.skill === "listen") match = listenMatch({ answer: a.answer, ...graded, alternates: phrase.alternates, ...locales });
    // Speak-it (and a cloze said aloud): the recogniser wrote what it
    // heard, so an accent it heard differently is close, not exact
    // (match.mjs `spoken`). A cloze gap is matched locally against the
    // phrase's own words only (the gap is them verbatim: cloze.mjs
    // findBlank). A saved alternate is another way to say the phrase, not
    // always a word that fits this sentence (Wagen for Auto in "Das ___
    // steht vor meinem Haus"), so it goes to the grader, which sees the
    // sentence.
    else match = localMatch({ skill: a.skill, answer: a.answer, ...graded, alternates: a.drill === "cloze" ? [] : phrase.alternates, ...locales, spoken: a.spoken });
    let check: { grader: ReturnType<typeof parseGraderReply>; failed: boolean } = { grader: null, failed: false };
    // A picked choice is right or wrong as it stands: no model check.
    if (!a.choice && needsGrader(match, a.answer)) {
      check = await runGrader(res, {
        ...graderQuestion({ skill: a.skill, ...graded, drill: a.drill, spoken: a.spoken, gapped: gap, full }),
        answer: a.answer,
        nativeLanguage: ctx.learner.nativeLanguage || "English",
        targetVariant: ctx.language.targetVariant || ctx.language.targetLanguage,
      });
    }
    outcome = gradeOutcome({ match, grader: check.grader, graderFailed: check.failed, answer: a.answer });
    // Only typed flashcard words are kept as another way to say it: a
    // meaning in phrases.alternates would grade as the target (practice.mjs
    // withAlternate), a transcript's spelling is the recogniser's, and a
    // word accepted for one sentence's gap may fit only that sentence.
    keepAlternate = outcome.verdict === "accepted" && a.skill === "produce" && a.drill === "flashcard";
  }
  const out = await op(() =>
    recordAnswer(rawDb(), ctx.language, {
      phraseId: a.phraseId, skill: a.skill, drill: a.drill, version: a.version, revision: a.revision, submitId: a.submitId, outcome,
      answer: a.reveal ? null : a.answer || null, durationMs: a.durationMs, utcOffsetMinutes: a.utcOffsetMinutes, keepAlternate,
      targetLocale: targetLocale(ctx), cloze: a.clozeId ? { id: a.clozeId, key: clozeKey(phrase) } : null, now: new Date(),
    }),
  );
  sendJson(res, 200, out satisfies PracticeAnswerReply);
}

/** Why phrases can't be played for this language, or null: the checks the
 *  audio route makes that need no provider call (voiceReady: the keys, a
 *  macOS voice for the locale), so the mode picker can say so before a
 *  session rather than card by card. No voice saved is not a problem: the
 *  route then speaks in the provider's default voice. */
export async function audioProblem(ctx: LearnerCtx): Promise<string | null> {
  const locale = targetLocale(ctx);
  if (!locale) return "this language has no voice locale, so its phrases can't be played";
  try {
    await voiceReady(await readVoiceSettings(ctx.user.id), locale);
    return null;
  } catch (e) {
    if (e instanceof HttpError) return e.message;
    throw e;
  }
}

/** Why answers can't be transcribed, or null (no key for the provider). */
async function speechProblem(ctx: LearnerCtx): Promise<string | null> {
  try {
    sttReady((await readVoiceSettings(ctx.user.id)).stt);
    return null;
  } catch (e) {
    if (e instanceof HttpError) return e.message;
    throw e;
  }
}

/**
 * A phrase said aloud for the listening drill, in the user's own voice for
 * the language (practiceVoice), through the audio cache: the first play
 * pays the provider, every later one (a replay, the next session) is read
 * from disk. The phrase must be one of this language's practisable
 * phrases (404 otherwise, as for any other id). The cache key includes the
 * user, and whether it was a hit is logged, never sent: no account can
 * learn by the reply, or its timing, whether another has had a text said.
 * The browser keeps it no longer than the page does (no-store).
 */
async function phraseAudio(res: ServerResponse, ctx: LearnerCtx, phraseId: string): Promise<void> {
  const ctrl = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort();
  };
  res.on("close", onClose);
  try {
    const out = await phraseClip(ctx, phraseId, ctrl.signal);
    res.writeHead(200, { "Content-Type": out.type, "Content-Length": out.audio.length, "Cache-Control": "private, no-store" });
    res.end(out.audio);
  } finally {
    res.off("close", onClose);
  }
}

/**
 * A phrase's audio as /api/practice/audio/:phraseId serves it (the same
 * checks, key and cache), with its text and cache key: also the compare
 * view's model clip on Practice speak-it (pronunciation.ts), so both read
 * one file. 404 for a phrase this language can't practise.
 */
export async function phraseClip(ctx: LearnerCtx, phraseId: string, signal: AbortSignal): Promise<{ key: string; text: string; locale: string; audio: Buffer; type: string; cached: boolean }> {
  if (!isUuid(phraseId)) throw new HttpError(404, "no such phrase");
  const { phrase } = await op(() => practiceCard(rawDb(), ctx.language, phraseId.toLowerCase(), "listen"));
  const text = (phrase.text ?? "").trim();
  if (!text) throw new HttpError(409, "this phrase has no words to say");
  const locale = targetLocale(ctx);
  if (!locale) throw new HttpError(400, "this language has no voice locale, so its phrases can't be played");
  const settings = await readVoiceSettings(ctx.user.id);
  const { provider, voice, model } = await practiceVoice(settings, locale);
  const key = audioKey({ owner: ctx.user.id, provider, voice, model, format: SPEECH_FORMATS[provider], locale, speed: 1, text });
  const out = await cachedAudio(key, () => paidSlot(ctx.user.id, () => synthesize({ provider, voice, text, locale, model }, signal)));
  console.log(`[lingo-dojo] practice audio: ${out.cached ? "hit" : "miss"} ${key.slice(0, 12)}`);
  return { key, text, locale, ...out };
}

/** What the recorder sends (recorder.ts toWav): a WAV, by whichever name. */
const RECORDING_TYPES = new Set(["audio/wav", "audio/wave", "audio/x-wav"]);

/**
 * A speak-it recording → what the recogniser heard, in the language's
 * locale, with the user's speech-to-text provider. Deliberately no
 * keyterms and nothing about the card: hinting the expected answer would
 * hear it into the transcript. Records nothing: the page shows what was
 * heard, then sends it as the answer (or records again). An empty
 * transcript is a 200 with "" (nothing heard), a provider failure a 502:
 * neither is a review. Only a WAV (415 otherwise), at most 8 MiB
 * (readAudio: 413), in one of the user's paid slots.
 */
async function transcribe(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (!RECORDING_TYPES.has(mime)) throw new HttpError(415, "a recording must be sent as audio/wav");
  const audio = await readAudio(req);
  const provider = (await readVoiceSettings(ctx.user.id)).stt;
  const locale = targetLocale(ctx);
  const text = await paidSlot(ctx.user.id, () => transcribeAudio(res, { provider, audio, mime: "audio/wav", locales: locale ? [locale] : [] }), "transcriptions");
  sendJson(res, 200, { text: text.trim() } satisfies PracticeTranscribeReply);
}

/** /api/practice, mounted with wrap's `learner: true`. */
export async function handlePractice(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (ctx.learner.mode === "kids") throw new HttpError(403, "practice isn't part of kids mode");
  const parts = subPath(req).split("/").filter(Boolean);
  if (parts.length === 0) {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    // The counts (also what the page polls while sentences are written)
    // never start a generation call.
    const { stats, cloze } = await queue(req, ctx, false);
    const [audio, speech] = await Promise.all([audioProblem(ctx), speechProblem(ctx)]);
    return sendJson(res, 200, { stats, language: languageOf(ctx), setup: { audio, speech }, cloze } satisfies PracticeStatsReply);
  }
  if (parts.length === 1 && parts[0] === "queue") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const { items, stats, cloze } = await queue(req, ctx, true);
    return sendJson(res, 200, { items, stats, language: languageOf(ctx), setup: null, cloze } satisfies PracticeQueueReply);
  }
  if (parts.length === 3 && parts[0] === "cloze" && parts[2] === "flag") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    // A bad sentence (wrong, unnatural, or the gap guessable two ways):
    // never shown again. Nothing is recorded for the card.
    if (!isUuid(parts[1])) throw new HttpError(404, "no such sentence");
    const row = await flagClozeItem(rawDb(), ctx.language, parts[1].toLowerCase(), new Date());
    if (!row) throw new HttpError(404, "no such sentence");
    return sendJson(res, 200, { flagged: true } satisfies PracticeFlagReply);
  }
  if (parts.length === 1 && parts[0] === "answer") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return answer(req, res, ctx);
  }
  if (parts.length === 2 && parts[0] === "audio") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    // A phrase id, as every other phrase route takes it; anything else is
    // no phrase of this language's (and never reaches a path).
    if (!isUuid(parts[1])) throw new HttpError(404, "no such phrase");
    return phraseAudio(res, ctx, parts[1].toLowerCase());
  }
  if (parts.length === 1 && parts[0] === "transcribe") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return transcribe(req, res, ctx);
  }
  if (parts.length === 3 && parts[0] === "reviews" && parts[2] === "override") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    const id = reviewId(parts[1]);
    if (id == null) throw new HttpError(404, "no such review");
    const r = readOverrideInput(await readJsonBody(req));
    if (r.error !== undefined) throw new HttpError(400, r.error);
    const out = await op(() => overrideReview(rawDb(), ctx.language, id, { ...r.value, targetLocale: targetLocale(ctx) }));
    return sendJson(res, 200, out satisfies PracticeAnswerReply);
  }
  sendJson(res, 404, { error: "no such route" });
}
