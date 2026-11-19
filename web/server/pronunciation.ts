import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Worker } from "node:worker_threads";
import { REPO_ROOT } from "../../scripts/content.mjs";
import { azurePronunciationRequest, azurePronunciationResult, scoresTones, type AzureAssessment, type ExpectedSyllable, type ScoreResult } from "../../scripts/pronunciation.mjs";
import { azureLimiter, azureUsable, readScoreAudio, readScoreText, scoreReply, scoreSyllables, scoringEngine, SCORE_MAX_BYTES } from "../../scripts/pronunciation-app.mjs";
import { localeFor, voiceKeys } from "../../scripts/voice.mjs";
import type { PronunciationScoreReply } from "../shared/wire.ts";
// The page's own Mandarin reader, the first module the server takes from
// web/src: the readings must be the ones the page shows over the text, or
// the marks would sit on other syllables. It and what it imports
// (script.ts, sounds.ts, pinyin-pro, the JSON tables) must stay free of
// browser globals at the top level; scripts/tests/server-imports.test.mjs
// loads this chain under plain node to catch that.
import { charReadings, readCodePoints } from "../src/script/zh.ts";
import { learnerMode, type LearnerCtx } from "./auth.ts";
import { paidSlot } from "./paid.ts";
import { HttpError, methodNotAllowed, sendJson, subPath } from "./sse.ts";

// Pronunciation scoring where the text is known (stage 1, ld-ne0.2;
// docs/VOICE.md §Pronunciation in the app):
//
//   POST /api/pronunciation/score?text=<Han>   WAV body → PronunciationScoreReply
//
// Mounted with wrap's `learner: true`: the page must name the session's
// learner and language. Mandarin only (scoresTones over the language's
// locale); any other language is a 422 `not_available`, and the page shows
// nothing. Practice's speak-it and the character card call it.
//
// Engine: Azure Pronunciation Assessment when its keys are set, with the
// local tone check run on Azure's syllable timings (mergeAzure); the local
// scorer alone otherwise. The same for adult and kids learners (the owner's
// decision, 2026-11-19): a kids learner's recording goes to Azure as it
// already goes to the transcription provider. Only the reply differs (no
// score for kids), from the learner's mode as the session holds it
// (learnerMode). When Azure is missing, fails, is busy or the user is at
// the per-minute cap, the local scorer answers: never an error to the
// learner for that, just more "not sure".
//
// Nothing is stored: the recording is read into memory, scored in a worker
// thread (scripts/pronunciation-worker.mjs: the pitch track is synchronous
// and can take over a second), and dropped with the request; the text is
// read without the reader's cache. No log line carries the text, the audio
// or anything Azure said: every failure here leaves as an HttpError with a
// fixed sentence, because wrap() logs the URL (which holds the text) of
// anything else.

/** The worker and how long it may take: a constant in the app, swapped by
 *  the HTTP tests for a worker that hangs or crashes. */
export const SCORER = {
  worker: path.join(REPO_ROOT, "scripts", "pronunciation-worker.mjs"),
  /** The scorer takes well under two seconds on 30 seconds of audio. */
  timeoutMs: 15_000,
  /** A body slower than this to arrive is dropped (a 30-second WAV is under
   *  a megabyte, over loopback or the tailnet). */
  bodyTimeoutMs: 20_000,
};
/** Scores running at once on this server: each is a worker thread on a
 *  core. Past it, a 429 (the page says try again). */
const MAX_WORKERS = 2;
const AZURE_TIMEOUT_MS = 15_000;
/** How much of an oversized body is read (and dropped) to answer it 413:
 *  the cap every other recording route has (voice.ts readAudio). */
const DRAIN_MAX = 8 << 20;

let workers = 0;
/** One score at a time per user: a second tap while one runs is a 429. */
const scoring = new Set<string>();
const azureCalls = azureLimiter();

/** Why this route stopped without an answer for the page, for the log: a
 *  fixed word, never anything from the request, the engine or Azure. */
class ScoreFailure extends Error {
  readonly kind: "timeout" | "crash" | "error" | "slow_body";
  constructor(kind: ScoreFailure["kind"]) {
    super(`pronunciation: ${kind}`);
    this.kind = kind;
  }
}

/** The recording, read up to the cap (413 past it) without trusting a
 *  Content-Length, within SCORER.bodyTimeoutMs (past it, a ScoreFailure
 *  "slow_body": the reply goes out and the connection is closed, the rest
 *  unread). A browser that drops the upload rejects with its own error,
 *  and req.destroyed tells guarded() it went away. */
function readRecording(req: IncomingMessage, res: ServerResponse): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // Past the cap the rest is read and dropped, so the browser gets its 413
    // rather than a broken pipe; past DRAIN_MAX it isn't read at all and the
    // connection is closed after the reply.
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      req.off("data", onData).off("end", onEnd).off("error", onError).off("aborted", onAborted).off("close", onAborted);
      fn();
    };
    const stop = (e: Error) => {
      res.setHeader("Connection", "close");
      req.pause();
      done(() => reject(e));
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > DRAIN_MAX) return stop(new HttpError(413, "the recording is too long to score"));
      if (size <= SCORE_MAX_BYTES) chunks.push(c);
    };
    const onEnd = () =>
      done(() => {
        if (size > SCORE_MAX_BYTES) reject(new HttpError(413, "the recording is too long to score"));
        else if (!size) reject(new HttpError(400, "no audio in the body"));
        else resolve(new Uint8Array(Buffer.concat(chunks)));
      });
    const onError = (e: Error) => done(() => reject(e));
    const onAborted = () => done(() => reject(new Error("aborted")));
    const timer = setTimeout(() => stop(new ScoreFailure("slow_body")), SCORER.bodyTimeoutMs);
    req.on("data", onData).on("end", onEnd).on("error", onError).on("aborted", onAborted).on("close", onAborted);
  });
}

/** The engine in a worker thread: its result, or a ScoreFailure (what the
 *  worker said is dropped: it is not for the log or the page). */
function runScorer(wav: Uint8Array, syllables: ExpectedSyllable[], azure: AzureAssessment | null): Promise<ScoreResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(SCORER.worker, { workerData: { wav, syllables, azure } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void w.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new ScoreFailure("timeout"))), SCORER.timeoutMs);
    w.once("message", (m: { result?: ScoreResult; error?: string }) => finish(() => (m?.result ? resolve(m.result) : reject(new ScoreFailure("error")))));
    w.once("error", () => finish(() => reject(new ScoreFailure("crash"))));
    w.once("exit", () => finish(() => reject(new ScoreFailure("crash"))));
  });
}

/** One Azure assessment: the parsed reply, or why not. The log names the
 *  kind of failure only (an HTTP status at most), never the request (it
 *  carries the key) or the reply (it quotes what was said). */
async function assessWithAzure(
  res: ServerResponse,
  ctx: LearnerCtx,
  { wav, text, locale, keys }: { wav: Uint8Array; text: string; locale: string; keys: { azureKey: string; azureRegion: string } },
): Promise<{ azure: AzureAssessment } | { fallback: "failed" | "busy" | "limit" }> {
  const failed = (why: string) => {
    console.log(`[lingo-dojo] pronunciation: Azure ${why}; scoring locally`);
    return { fallback: "failed" as const };
  };
  let request: { url: string; init: RequestInit };
  try {
    // A malformed region is a setup problem, not a call: built before a
    // per-minute token is spent, and the local scorer answers.
    request = azurePronunciationRequest({ key: keys.azureKey, region: keys.azureRegion, audio: wav, locale, referenceText: text, scripted: true });
  } catch {
    return failed("request could not be made (check AZURE_SPEECH_REGION)");
  }
  if (!azureCalls.take(ctx.user.id)) return { fallback: "limit" };
  // A paid call: stop it when the browser gives up.
  const ctrl = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort();
  };
  res.on("close", onClose);
  try {
    let status = 0;
    const json = await paidSlot(
      ctx.user.id,
      async () => {
        const r = await fetch(request.url, { ...request.init, signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(AZURE_TIMEOUT_MS)]) });
        status = r.status;
        if (!r.ok) return null;
        return (await r.json().catch(() => undefined)) as unknown;
      },
      "pronunciation checks",
    );
    if (json === null) return failed(`answered ${status}`);
    if (json === undefined) return failed("sent a reply that isn't JSON");
    const azure = azurePronunciationResult(json);
    if (!azureUsable(azure)) return failed("recognised nothing");
    return { azure };
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) return { fallback: "busy" };
    if (ctrl.signal.aborted) throw new HttpError(499, "cancelled");
    return failed((e as Error)?.name === "TimeoutError" ? `gave no answer in ${AZURE_TIMEOUT_MS / 1000}s` : "could not be reached");
  } finally {
    res.off("close", onClose);
  }
}

async function score(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const locale = localeFor(ctx.language.targetLanguage, ctx.language.targetVariant) ?? "";
  if (!scoresTones(locale)) throw new HttpError(422, "pronunciation checks aren't available for this language", "not_available");
  const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (!["audio/wav", "audio/wave", "audio/x-wav"].includes(mime)) throw new HttpError(415, "a recording must be sent as audio/wav");
  // Before the body: the learner's mode (a `?mode=` that disagrees is a 400).
  const mode = learnerMode(req, ctx);
  const t = readScoreText(new URL(req.url ?? "/", "http://localhost").searchParams.get("text"));
  if (t.error !== undefined) throw new HttpError(400, t.error);
  // A character alone (the card): every reading the card shows for it.
  const han = [...t.text].filter((c) => /\p{Script=Han}/u.test(c));
  const alternatives = han.length === 1 ? charReadings(han[0], locale) : null;
  const s = scoreSyllables(t.text, readCodePoints(t.text, locale, { cache: false }), { alternatives });
  if (s.error !== undefined) throw new HttpError(400, s.error);

  // The limits before the body is read: a busy user or server costs no
  // upload. The slots are held from here, through the Azure call, so a
  // recording paid for at Azure is never then turned away.
  if (scoring.has(ctx.user.id)) throw new HttpError(429, "a recording is already being checked; try again in a moment");
  if (workers >= MAX_WORKERS) throw new HttpError(429, "pronunciation checks are busy; try again in a moment");
  scoring.add(ctx.user.id);
  workers++;
  try {
    const wav = await readRecording(req, res);
    const a = readScoreAudio(wav);
    if (a.error !== undefined) throw new HttpError(a.status, a.error);
    const choice = scoringEngine({ keys: voiceKeys() });
    let azure: AzureAssessment | null = null;
    let fallback: PronunciationScoreReply["fallback"] = choice.why;
    if (choice.engine === "azure") {
      const out = await assessWithAzure(res, ctx, { wav, text: t.text, locale, keys: voiceKeys() });
      if ("azure" in out) azure = out.azure;
      else fallback = out.fallback;
    }
    const result = await runScorer(wav, s.syllables, azure);
    const engine = azure ? "azure" : "local";
    console.log(`[lingo-dojo] pronunciation: ${engine}${fallback ? ` (${fallback})` : ""}, ${s.syllables.length} syllables`);
    sendJson(res, 200, scoreReply(result, s.syllables, { engine, fallback: azure ? null : fallback, kids: mode === "kids", text: t.text, locale }) satisfies PronunciationScoreReply);
  } finally {
    workers--;
    scoring.delete(ctx.user.id);
  }
}

/** Anything thrown from here leaves as an HttpError: wrap() logs a plain
 *  Error with the request's URL, and this URL carries the text. A browser
 *  that went away (an upload dropped, the page left) just ends. */
async function guarded(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  try {
    await score(req, res, ctx);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((req.destroyed && !(e instanceof ScoreFailure)) || res.destroyed) {
      console.log("[lingo-dojo] pronunciation: the browser went away");
      throw new HttpError(499, "cancelled");
    }
    const kind = e instanceof ScoreFailure ? e.kind : "error";
    console.error(`[lingo-dojo] pronunciation: scoring failed (${kind})`);
    if (kind === "slow_body") throw new HttpError(408, "the recording took too long to arrive");
    throw new HttpError(503, "the tones couldn't be checked just now; try again");
  }
}

/** /api/pronunciation, mounted with wrap's `learner: true`. */
export async function handlePronunciation(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const parts = subPath(req).split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "score") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return guarded(req, res, ctx);
  }
  sendJson(res, 404, { error: "no such route" });
}
