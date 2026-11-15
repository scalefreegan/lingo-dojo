import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { failureHint, startClaude } from "../../scripts/claude.mjs";
import { PracticeError, overrideReview, practiceCandidates, practiceCard, practiceDone, recordAnswer, reviewId } from "../../scripts/db/practice.ts";
import { graderPrompt, parseGraderReply } from "../../scripts/match.mjs";
import {
  buildQueue, dayStart, gradeOutcome, graderQuestion, localMatch, needsGrader, readAnswerInput, readDirection, readLength, readOverrideInput, readUtcOffset,
  cardVersion,
} from "../../scripts/practice.mjs";
import { localeFor } from "../../scripts/voice.mjs";
import type { PracticeAnswerReply, PracticeQueueReply, PracticeStatsReply } from "../shared/practice.ts";
import type { LearnerCtx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";

// The Practice tab's routes (docs/DATA.md §Practice modes, §Grading):
// flashcards both ways over the active learner's active language's bank.
//
//   GET  /api/practice                       ?tz= → {stats, language}: what is due and new, today's progress
//   GET  /api/practice/queue                 ?length=5|10|20&direction=mixed|recognize|produce&tz= → {items, stats, language}
//   POST /api/practice/answer                {phraseId, skill, version, answer?, reveal?, rating?, durationMs?, tz?} → the review
//   POST /api/practice/reviews/:id/override  {rating, tz?} → the review, regraded
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
// Grading: the lenient local match first; on a miss with something typed,
// one tool-less Haiku `claude -p` call (match.mjs graderPrompt, the answer
// fenced and defanged, the reply parsed defensively), before the write's
// transaction so no lock waits on a model. Its note is model output,
// cleaned and capped (practice.mjs gradeOutcome) before it is stored or
// sent.

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

/** The queue (and its stats) for this request's day and filters. */
async function queue(req: IncomingMessage, ctx: LearnerCtx) {
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  const now = new Date();
  const since = dayStart(now, readUtcOffset(q.get("tz")));
  const [phrases, done] = await Promise.all([practiceCandidates(rawDb(), ctx.language), practiceDone(rawDb(), ctx.language, since)]);
  return buildQueue(phrases, { now, done, length: readLength(q.get("length")), direction: readDirection(q.get("direction")) });
}

/**
 * The model check on a miss: `{ grader }` with its parsed reply, or
 * `{ failed: true }` when it couldn't run or answered nothing usable (the
 * answer is then wrong, and the learner can override). A browser that gave
 * up (the page closed) cancels it.
 */
async function runGrader(
  res: ServerResponse,
  input: { question: string; expected: string; answer: string; kind: "target" | "meaning"; nativeLanguage: string; targetVariant: string },
): Promise<{ grader: ReturnType<typeof parseGraderReply>; failed: boolean }> {
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
    const grader = parseGraderReply(run.text);
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
  // No grade for a stale card: the write replays the stored review or
  // refuses (409), and never records one.
  let outcome = stale ? null : a.reveal ? gradeOutcome({ reveal: true, rating: a.rating }) : null;
  let keepAlternate = false;
  if (!a.reveal && !stale) {
    const match = localMatch({
      skill: a.skill, answer: a.answer, ...graded, alternates: phrase.alternates, targetLocale: targetLocale(ctx), nativeLocale: nativeLocale(ctx),
    });
    let check: { grader: ReturnType<typeof parseGraderReply>; failed: boolean } = { grader: null, failed: false };
    if (needsGrader(match, a.answer)) {
      check = await runGrader(res, {
        ...graderQuestion({ skill: a.skill, ...graded }),
        answer: a.answer,
        nativeLanguage: ctx.learner.nativeLanguage || "English",
        targetVariant: ctx.language.targetVariant || ctx.language.targetLanguage,
      });
    }
    outcome = gradeOutcome({ match, grader: check.grader, graderFailed: check.failed, answer: a.answer });
    // Only words are kept as another way to say it: a meaning in
    // phrases.alternates would grade as the target (practice.mjs withAlternate).
    keepAlternate = outcome.verdict === "accepted" && a.skill === "produce";
  }
  const out = await op(() =>
    recordAnswer(rawDb(), ctx.language, {
      phraseId: a.phraseId, skill: a.skill, version: a.version, graded, outcome, answer: a.reveal ? null : a.answer || null,
      durationMs: a.durationMs, utcOffsetMinutes: a.utcOffsetMinutes, keepAlternate, targetLocale: targetLocale(ctx), now: new Date(),
    }),
  );
  sendJson(res, 200, out satisfies PracticeAnswerReply);
}

/** /api/practice, mounted with wrap's `learner: true`. */
export async function handlePractice(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (ctx.learner.mode === "kids") throw new HttpError(403, "practice isn't part of kids mode");
  const parts = subPath(req).split("/").filter(Boolean);
  if (parts.length === 0) {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const { stats } = await queue(req, ctx);
    return sendJson(res, 200, { stats, language: languageOf(ctx) } satisfies PracticeStatsReply);
  }
  if (parts.length === 1 && parts[0] === "queue") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const { items, stats } = await queue(req, ctx);
    return sendJson(res, 200, { items, stats, language: languageOf(ctx) } satisfies PracticeQueueReply);
  }
  if (parts.length === 1 && parts[0] === "answer") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return answer(req, res, ctx);
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
