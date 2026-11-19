import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Worker } from "node:worker_threads";
import { REPO_ROOT } from "../../scripts/content.mjs";
import { azurePronunciationRequest, azurePronunciationResult, scoresTones, type AzureAssessment, type ExpectedSyllable, type ScoreResult } from "../../scripts/pronunciation.mjs";
import { azureLimiter, azureUsable, readScoreAudio, readScoreText, scoreReply, scoreSyllables, scoringEngine, SCORE_MAX_BYTES } from "../../scripts/pronunciation-app.mjs";
import { localeFor, voiceKeys } from "../../scripts/voice.mjs";
import type { PronunciationScoreReply } from "../shared/wire.ts";
import { readCodePoints } from "../src/script/zh.ts";
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
// Engine: Azure Pronunciation Assessment for an adult learner when its keys
// are set, with the local tone check run on Azure's syllable timings
// (mergeAzure); the local scorer alone otherwise. A kids learner's audio is
// never sent to Azure, whatever keys are set: the owner's rule, decided from
// the learner's mode as the session holds it (learnerMode), never from the
// request (pronunciation-app.mjs scoringEngine). When Azure is missing,
// fails, is busy or the user is at the per-minute cap, the local scorer
// answers: never an error to the learner for that, just more "not sure".
//
// Nothing is stored: the recording is read into memory, scored in a worker
// thread (scripts/pronunciation-worker.mjs: the pitch track is synchronous
// and can take over a second), and dropped with the request. No log line
// carries the text or the audio.

const WORKER = path.join(REPO_ROOT, "scripts", "pronunciation-worker.mjs");
/** Scores running at once on this server: each is a worker thread on a
 *  core. Past it, a 429 (the page says try again). */
const MAX_WORKERS = 2;
/** A worker that hasn't answered in this long is stopped (the scorer takes
 *  well under two seconds on 30 seconds of audio). */
const WORKER_TIMEOUT_MS = 15_000;
const AZURE_TIMEOUT_MS = 15_000;
/** How much of an oversized body is read (and dropped) to answer it 413:
 *  the cap every other recording route has (voice.ts readAudio). */
const DRAIN_MAX = 8 << 20;

let workers = 0;
/** One score at a time per user: a second tap while one runs is a 429. */
const scoring = new Set<string>();
const azureCalls = azureLimiter();

/** The recording, read up to the cap (413 past it) without trusting a
 *  Content-Length. */
async function readRecording(req: IncomingMessage, res: ServerResponse): Promise<Uint8Array> {
  // Past the cap the rest is read and dropped, so the browser gets its 413
  // rather than a broken pipe; past DRAIN_MAX it isn't read at all and the
  // connection is closed after the reply.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > DRAIN_MAX) {
      res.setHeader("Connection", "close");
      throw new HttpError(413, "the recording is too long to score");
    }
    if (size <= SCORE_MAX_BYTES) chunks.push(c as Buffer);
  }
  if (size > SCORE_MAX_BYTES) throw new HttpError(413, "the recording is too long to score");
  if (!size) throw new HttpError(400, "no audio in the body");
  return new Uint8Array(Buffer.concat(chunks));
}

/** The engine in a worker thread. A crash, an error or a timeout is a 500
 *  with the generic message (the worker's text is logged, never sent). */
function runScorer(wav: Uint8Array, syllables: ExpectedSyllable[], azure: AzureAssessment | null): Promise<ScoreResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { wav, syllables, azure } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void w.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("the pronunciation scorer timed out"))), WORKER_TIMEOUT_MS);
    w.once("message", (m: { result?: ScoreResult; error?: string }) => finish(() => (m.result ? resolve(m.result) : reject(new Error(`pronunciation scorer: ${m.error}`)))));
    w.once("error", (e) => finish(() => reject(e)));
    w.once("exit", (code) => finish(() => reject(new Error(`the pronunciation scorer exited (${code})`))));
  });
}

/** One Azure assessment: the parsed reply, or why not (logged by the
 *  caller as a fallback, never shown). */
async function assessWithAzure(
  res: ServerResponse,
  ctx: LearnerCtx,
  { wav, text, locale, keys }: { wav: Uint8Array; text: string; locale: string; keys: { azureKey: string; azureRegion: string } },
): Promise<{ azure: AzureAssessment } | { fallback: "failed" | "busy" | "limit" }> {
  if (!azureCalls.take(ctx.user.id)) return { fallback: "limit" };
  const request = azurePronunciationRequest({ key: keys.azureKey, region: keys.azureRegion, audio: wav, locale, referenceText: text, scripted: true });
  // A paid call: stop it when the browser gives up.
  const ctrl = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort();
  };
  res.on("close", onClose);
  try {
    const json = await paidSlot(
      ctx.user.id,
      async () => {
        const r = await fetch(request.url, { ...request.init, signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(AZURE_TIMEOUT_MS)]) });
        if (!r.ok) throw new Error(`Azure answered ${r.status}`);
        return (await r.json()) as unknown;
      },
      "pronunciation checks",
    );
    const azure = azurePronunciationResult(json);
    if (!azureUsable(azure)) {
      console.log(`[lingo-dojo] pronunciation: Azure gave nothing usable (${azure.status}); scoring locally`);
      return { fallback: "failed" };
    }
    return { azure };
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) return { fallback: "busy" };
    if (ctrl.signal.aborted) throw new HttpError(499, "cancelled");
    // The message names the status at most, never the request (it carries the key).
    console.log(`[lingo-dojo] pronunciation: Azure failed (${String((e as Error)?.message || e).slice(0, 120)}); scoring locally`);
    return { fallback: "failed" };
  } finally {
    res.off("close", onClose);
  }
}

async function score(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const locale = localeFor(ctx.language.targetLanguage, ctx.language.targetVariant) ?? "";
  if (!scoresTones(locale)) throw new HttpError(422, "pronunciation checks aren't available for this language", "not_available");
  const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (!["audio/wav", "audio/wave", "audio/x-wav"].includes(mime)) throw new HttpError(415, "a recording must be sent as audio/wav");
  const t = readScoreText(new URL(req.url ?? "/", "http://localhost").searchParams.get("text"));
  if (t.error !== undefined) throw new HttpError(400, t.error);
  const s = scoreSyllables(t.text, readCodePoints(t.text, locale));
  if (s.error !== undefined) throw new HttpError(400, s.error);
  const wav = await readRecording(req, res);
  const a = readScoreAudio(wav);
  if (a.error !== undefined) throw new HttpError(a.status, a.error);

  if (scoring.has(ctx.user.id)) throw new HttpError(429, "a recording is already being checked; try again in a moment");
  if (workers >= MAX_WORKERS) throw new HttpError(429, "pronunciation checks are busy; try again in a moment");
  // The worker's slot is held from here, through the Azure call: a
  // recording paid for at Azure is never then turned away.
  scoring.add(ctx.user.id);
  workers++;
  try {
    const mode = learnerMode(req, ctx);
    const choice = scoringEngine({ mode, keys: voiceKeys() });
    let azure: AzureAssessment | null = null;
    let fallback: PronunciationScoreReply["fallback"] = choice.why;
    // Only an adult with keys reaches this line: scoringEngine never picks
    // Azure for a kids learner.
    if (choice.engine === "azure" && mode === "adult") {
      const keys = voiceKeys();
      const out = await assessWithAzure(res, ctx, { wav, text: t.text, locale, keys });
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

/** /api/pronunciation, mounted with wrap's `learner: true`. */
export async function handlePronunciation(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const parts = subPath(req).split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "score") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return score(req, res, ctx);
  }
  sendJson(res, 404, { error: "no such route" });
}
