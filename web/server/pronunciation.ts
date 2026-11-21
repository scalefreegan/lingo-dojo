import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Worker } from "node:worker_threads";
import { REPO_ROOT } from "../../scripts/content.mjs";
import { azurePronunciationRequest, azurePronunciationResult, azureRegionValid, encodeWav, parseWav, scoresTones, type AzureAssessment, type ExpectedSyllable, type ScoreResult } from "../../scripts/pronunciation.mjs";
import { azureLimiter, azureUsable, readScoreAudio, readScoreText, scoreReply, scoreSyllables, scoringEngine, SCORE_MAX_BYTES } from "../../scripts/pronunciation-app.mjs";
import { modelRecord, padSamples, padSpans, unpadRecord, type TakeFrames } from "../../scripts/pronunciation-compare.mjs";
import { decodeTo16k } from "../../scripts/audio-decode.mjs";
import { modelAnalysis } from "../../scripts/model-analysis.mjs";
import { localeFor, voiceKeys } from "../../scripts/voice.mjs";
import type { PronunciationModelReply, PronunciationScoreReply } from "../shared/wire.ts";
// The page's own Mandarin reader, the first module the server takes from
// web/src: the readings must be the ones the page shows over the text, or
// the marks would sit on other syllables. It and what it imports
// (script.ts, sounds.ts, pinyin-pro, the JSON tables) must stay free of
// browser globals at the top level; scripts/tests/server-imports.test.mjs
// loads this chain under plain node to catch that.
import { charReadings, readCodePoints, validateHint, withHints } from "../src/script/zh.ts";
import { learnerMode, type LearnerCtx } from "./auth.ts";
import { paidSlot } from "./paid.ts";
import { phraseClip } from "./practice.ts";
import { HttpError, methodNotAllowed, sendJson, subPath } from "./sse.ts";
import { isSoundText, soundClip } from "./voice.ts";

// Pronunciation scoring where the text is known (stage 1, ld-ne0.2;
// docs/VOICE.md §Pronunciation in the app):
//
//   POST /api/pronunciation/score?text=<Han>   WAV body → PronunciationScoreReply
//   GET  /api/pronunciation/model?sound=<Han>&locale=<loc>  → PronunciationModelReply
//   GET  /api/pronunciation/model?phrase=<id>               → PronunciationModelReply
//
// The second is compare mode's (ld-ne0.9, docs/VOICE.md §Compare mode):
// the model clip's pitch, loudness and syllable timings, from the audio
// the server itself cached for that sound or phrase (the same file
// /api/voice/sound and /api/practice/audio serve), decoded on the server
// and analysed once per clip (scripts/model-analysis.mjs: at most one
// Azure call per clip and record version). The learner's take is never sent again: its
// frames came back with its marks.
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

/** The model clip's decoder (scripts/audio-decode.mjs): a constant in the
 *  app, swapped by the HTTP tests (their stand-in speech isn't real MP3). */
export const MODEL = {
  decode: (audio: Uint8Array, type: string): Promise<Uint8Array | null> => decodeTo16k(audio, type),
  /** How long a model analysis waits for a decoder, or for a worker when
   *  Azure didn't answer, before it gives up with a 503. It waits rather
   *  than 429s: by then its clip may have been synthesized. (Tests shorten
   *  it.) */
  waitMs: 15_000,
};

let workers = 0;
/** Of `workers`, those running a model analysis: at most MAX_WORKERS - 1,
 *  so a model analysis never takes the last free worker and a learner's
 *  score is turned away only when another score holds it. */
let modelWorkers = 0;
/** Converters running at once for model clips (scripts/audio-decode.mjs). */
const MAX_DECODERS = 2;
let decoders = 0;

/** Wait (in turns of 50 ms) until `free()`, up to `waitMs` (Infinity: no
 *  limit), then `take()`; → the release function, which runs once. The
 *  score route never waits (it 429s at once); only model analyses do, and
 *  they hold a worker only for their worker run. No request's abort signal
 *  is passed in: this work may be shared by several requests for one clip
 *  (model-analysis.mjs), and one leaving must not cancel it for the rest. */
async function waitForSlot(free: () => boolean, take: () => () => void, waitMs: number): Promise<() => void> {
  const until = Date.now() + waitMs;
  while (!free()) {
    if (Date.now() >= until) throw new HttpError(503, "pronunciation checks are busy; try again in a moment");
    await new Promise((r) => setTimeout(r, 50));
  }
  const release = take();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}
const decoderFree = () => decoders < MAX_DECODERS;
const takeDecoder = () => {
  decoders++;
  return () => void decoders--;
};
const modelWorkerFree = () => workers < MAX_WORKERS && modelWorkers < MAX_WORKERS - 1;
const takeModelWorker = () => {
  workers++;
  modelWorkers++;
  return () => {
    workers--;
    modelWorkers--;
  };
};

/** One score at a time per user: a second tap while one runs is a 429. */
const scoring = new Set<string>();
/** Model analyses running per user: two at once (a page's request and its
 *  React dev double, or two cards), past that a 429. */
const modelling = new Map<string, number>();
const MODEL_PER_USER = 2;
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

/** The browser dropped the request (the upload cut, the page left). Its
 *  own class: `req.destroyed` can't say so, as it is also true of every
 *  request whose body has been read to the end. */
class BrowserGone extends Error {
  constructor() {
    super("pronunciation: the browser went away");
  }
}

/** The recording, read up to the cap (413 past it) without trusting a
 *  Content-Length, within SCORER.bodyTimeoutMs (past it, a ScoreFailure
 *  "slow_body": the reply goes out and the connection is closed, the rest
 *  unread). A browser that drops the upload, before or while it is read,
 *  is a BrowserGone. */
function readRecording(req: IncomingMessage, res: ServerResponse): Promise<Uint8Array> {
  // Dropped while the session was looked up, before any listener here:
  // 'close' has already fired and 'end' never will, so waiting would hold
  // the user's slot until the body timeout.
  if (req.destroyed || req.readableAborted) return Promise.reject(new BrowserGone());
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
    // Any error reading the body (a reset, an abort) or a close before its
    // end is the browser's leaving.
    const onError = () => done(() => reject(new BrowserGone()));
    const onAborted = () => done(() => reject(new BrowserGone()));
    const timer = setTimeout(() => stop(new ScoreFailure("slow_body")), SCORER.bodyTimeoutMs);
    req.on("data", onData).on("end", onEnd).on("error", onError).on("aborted", onAborted).on("close", onAborted);
  });
}

/** The engine in a worker thread: its result, or a ScoreFailure (what the
 *  worker said is dropped: it is not for the log or the page). */
function runScorer(
  wav: Uint8Array,
  syllables: ExpectedSyllable[],
  azure: AzureAssessment | null,
  timings: { startMs: number; endMs: number }[] | null = null,
): Promise<{ result: ScoreResult; frames: TakeFrames; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(SCORER.worker, { workerData: { wav, syllables, azure, timings } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void w.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new ScoreFailure("timeout"))), SCORER.timeoutMs);
    w.once("message", (m: { result?: ScoreResult; frames?: TakeFrames; durationMs?: number; error?: string }) =>
      finish(() => (m?.result && m.frames ? resolve({ result: m.result, frames: m.frames, durationMs: Number(m.durationMs) || 0 }) : reject(new ScoreFailure("error")))),
    );
    w.once("error", () => finish(() => reject(new ScoreFailure("crash"))));
    w.once("exit", () => finish(() => reject(new ScoreFailure("crash"))));
  });
}

/** One Azure assessment: the parsed reply, or why not. The log names the
 *  kind of failure only (an HTTP status at most), never the request (it
 *  carries the key) or the reply (it quotes what was said). */
async function assessWithAzure(
  res: ServerResponse | null,
  ctx: LearnerCtx,
  { wav, text, locale, keys }: { wav: Uint8Array; text: string; locale: string; keys: { azureKey: string; azureRegion: string } },
  /** The model clip's one-call ledger (model-analysis.mjs): asked inside
   *  the paid slot, right before the request goes; false means the clip's
   *  call was made before, and none is made now. */
  claim?: () => boolean,
): Promise<{ azure: AzureAssessment } | { fallback: "failed" | "busy" | "limit" }> {
  const failed = (why: string) => {
    console.log(`[lingo-dojo] pronunciation: Azure ${why}; ${claim ? "reading the model clip locally" : "scoring locally"}`);
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
  // A paid call: stop it when the browser gives up. Not the model clip's
  // (no `res`): its one call is spent once claimed, and its answer is kept
  // for the next request whether or not this browser is still there.
  const ctrl = new AbortController();
  const onClose = () => {
    if (res && !res.writableEnded) ctrl.abort();
  };
  res?.on("close", onClose);
  try {
    let status = 0;
    const json = await paidSlot(
      ctx.user.id,
      async () => {
        if (claim && !claim()) {
          status = -1;
          return null;
        }
        const r = await fetch(request.url, { ...request.init, signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(AZURE_TIMEOUT_MS)]) });
        status = r.status;
        if (!r.ok) return null;
        return (await r.json().catch(() => undefined)) as unknown;
      },
      "pronunciation checks",
    );
    // The clip's one call was made before (another request won the claim).
    if (json === null && status === -1) return { fallback: "failed" };
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
    res?.off("close", onClose);
  }
}

/** The longest `reading` taken: 24 characters' syllables with spaces. */
const MAX_READING_CHARS = 240;

async function score(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const locale = localeFor(ctx.language.targetLanguage, ctx.language.targetVariant) ?? "";
  if (!scoresTones(locale)) throw new HttpError(422, "pronunciation checks aren't available for this language", "not_available");
  const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (!["audio/wav", "audio/wave", "audio/x-wav"].includes(mime)) throw new HttpError(415, "a recording must be sent as audio/wav");
  // Before the body: the learner's mode (a `?mode=` that disagrees is a 400).
  const mode = learnerMode(req, ctx);
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const t = readScoreText(params.get("text"));
  if (t.error !== undefined) throw new HttpError(400, t.error);
  // `readings=all`: the character card, one character alone, judged
  // against every reading the card shows for it. Only the card asks;
  // Practice never does, so a phrase 好 or 不！ keeps its one reading.
  const all = params.get("readings");
  if (all !== null && all !== "all") throw new HttpError(400, "readings must be \"all\" or left out");
  const han = [...t.text].filter((c) => /\p{Script=Han}/u.test(c));
  if (all && han.length !== 1) throw new HttpError(400, "every reading is only for one character alone");
  const alternatives = all ? charReadings(han[0], locale) : null;
  // `reading`: a bank phrase's stored reading (phrases.reading, ld-op2),
  // sent back by Practice. Checked again here as any hint is (validateHint:
  // only readings the characters have), so the page can't have a recording
  // judged against a sound the text doesn't have; one that fails is
  // ignored and the reader's reading scores, as without it.
  // The limits before the body is read, and before the hint is looked at:
  // a busy user or server costs no upload and no work here. (Nothing
  // awaits between this check and the slots being taken below.) The slots
  // are held through the Azure call, so a recording paid for at Azure is
  // never then turned away.
  if (scoring.has(ctx.user.id)) throw new HttpError(429, "a recording is already being checked; try again in a moment");
  if (workers >= MAX_WORKERS) throw new HttpError(429, "pronunciation checks are busy; try again in a moment");
  const hint = params.get("reading");
  if (hint != null && hint.length > MAX_READING_CHARS) throw new HttpError(400, "reading is too long");
  const checked = hint ? validateHint(t.text, hint, locale) : null;
  const s = scoreSyllables(t.text, checked?.ok ? withHints(t.text, locale, [{ term: t.text, reading: checked.reading.join(" ") }], { cache: false }) : readCodePoints(t.text, locale, { cache: false }), { alternatives });
  if (s.error !== undefined) throw new HttpError(400, s.error);
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
    const { result, frames } = await runScorer(wav, s.syllables, azure);
    const engine = azure ? "azure" : "local";
    console.log(`[lingo-dojo] pronunciation: ${engine}${fallback ? ` (${fallback})` : ""}, ${s.syllables.length} syllables`);
    sendJson(res, 200, scoreReply(result, s.syllables, { engine, fallback: azure ? null : fallback, kids: mode === "kids", text: t.text, locale, frames }) satisfies PronunciationScoreReply);
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
    // Gone for real: the body was cut, or the connection closed under the
    // reply. Anything else, with the browser still waiting, is a 503.
    if (e instanceof BrowserGone || res.destroyed || req.readableAborted) {
      console.log("[lingo-dojo] pronunciation: the browser went away");
      throw new HttpError(499, "cancelled");
    }
    const kind = e instanceof ScoreFailure ? e.kind : "error";
    console.error(`[lingo-dojo] pronunciation: scoring failed (${kind})`);
    if (kind === "slow_body") throw new HttpError(408, "the recording took too long to arrive");
    throw new HttpError(503, "the tones couldn't be checked just now; try again");
  }
}

/** A phrase id as the practice routes take it: anything else is a 400
 *  before any lookup. */
const PHRASE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** What a sound is said in (voice.ts's own rule for /api/voice/sound). */
const LOCALE_RE = /^[a-z]{2,3}-[A-Z]{2}$/;

/**
 * GET /api/pronunciation/model: the model clip of a sound (`sound` and
 * `locale`, as the character card plays it) or of a phrase (`phrase`, as
 * Practice plays it), analysed for the compare picture. The clip is the
 * server's own cached audio for exactly that request (synthesized on a
 * miss, as the play route would); the client sends no audio. The analysis
 * is cached per clip (model-analysis.mjs). Nothing about the learner is
 * read or kept, and nothing is logged but the engine and the cache hit.
 */
async function model(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const here = localeFor(ctx.language.targetLanguage, ctx.language.targetVariant) ?? "";
  // A Practice phrase's model is Practice's, which kids mode doesn't have
  // (the practice routes are a 403 for kids): the same 403 here, first.
  if (ctx.learner.mode === "kids" && new URL(req.url ?? "/", "http://localhost").searchParams.has("phrase")) throw new HttpError(403, "practice isn't part of kids mode");
  if (!scoresTones(here)) throw new HttpError(422, "pronunciation checks aren't available for this language", "not_available");
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const sound = params.get("sound")?.trim() ?? null;
  const phrase = params.get("phrase");
  if ((sound === null) === (phrase === null)) throw new HttpError(400, "name the model: sound=<characters>&locale=… or phrase=<id>");
  if (sound !== null && !isSoundText(sound)) throw new HttpError(400, "a sound is 1 to 4 Chinese characters");
  const soundLocale = params.get("locale") ?? "";
  if (sound !== null && (!LOCALE_RE.test(soundLocale) || !scoresTones(soundLocale))) throw new HttpError(400, "locale must be a Mandarin locale, like zh-CN");
  if (phrase !== null && !PHRASE_ID_RE.test(phrase)) throw new HttpError(400, "not a phrase id");

  // The per-user limit before any provider call. The scoring workers shared
  // with the score route are taken only around the worker run itself (and
  // the converter has its own small limit): a model analysis waiting on its
  // speech or on Azure holds no one else's slot.
  const running = modelling.get(ctx.user.id) ?? 0;
  if (running >= MODEL_PER_USER) throw new HttpError(429, "the model is already being read; try again in a moment");
  modelling.set(ctx.user.id, running + 1);
  const ctrl = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort();
  };
  res.on("close", onClose);
  try {
    const clip = sound !== null ? { ...(await soundClip(ctx, sound, soundLocale, ctrl.signal)), text: sound, locale: soundLocale } : await phraseClip(ctx, phrase!, ctrl.signal);
    const t = readScoreText(clip.text);
    if (t.error !== undefined) throw new HttpError(400, "this phrase can't be compared: its text isn't only Chinese characters");
    const s = scoreSyllables(t.text, readCodePoints(t.text, clip.locale, { cache: false }));
    if (s.error !== undefined) throw new HttpError(400, "this phrase can't be compared: a character has no reading");
    const keys = voiceKeys();
    const out = await modelAnalysis({
      key: clip.key,
      audio: clip.audio,
      type: clip.type,
      chars: s.syllables.map((x) => x.char),
      // Decoded, then padded with silence (pronunciation-compare.mjs
      // MODEL_PAD_MS: a clip starts on its first sound) and checked like
      // any recording; the record is shifted back to the clip's own times.
      decode: async (audio: Uint8Array, type: string) => {
        const release = await waitForSlot(decoderFree, takeDecoder, MODEL.waitMs);
        let decoded: Uint8Array | null;
        try {
          decoded = await MODEL.decode(audio, type);
        } finally {
          release();
        }
        if (!decoded) return null;
        const { samples, sampleRate } = parseWav(decoded);
        if (sampleRate !== 16_000) throw new Error("the model clip is not 16 kHz");
        const wav = encodeWav(padSamples(samples, sampleRate), sampleRate);
        if (readScoreAudio(wav).error !== undefined) throw new Error("the model clip is not one the scorer reads");
        return wav;
      },
      // Set up: keys, and a region a request can be built with (a malformed
      // one would refuse every call, and never earns a retry).
      azureReady: scoringEngine({ keys }).engine === "azure" && azureRegionValid(keys?.azureRegion),
      assess: async (wav: Uint8Array, claim: () => boolean) => {
        const a = await assessWithAzure(null, ctx, { wav, text: t.text, locale: clip.locale, keys }, claim);
        return "azure" in a ? { azure: a.azure } : {};
      },
      // Not cancelled by a browser leaving: the analysis is shared by every
      // request for this clip and kept for the next one. With Azure's
      // answer in hand (paid for, and this clip's only call) it waits for a
      // worker as long as it takes, so the answer is always written into the
      // record; without one, up to MODEL.waitMs, then a 503 (nothing lost:
      // no call was made, and the next request reads the clip again; an
      // older record's spans stay where they are until it is replaced).
      // `spans`: an older record's Azure spans, on the clip's own times, so
      // moved onto the padded clip's.
      analyse: async (wav: Uint8Array, azure: AzureAssessment | null, spans: { startMs: number; endMs: number }[] | null) => {
        const release = await waitForSlot(modelWorkerFree, takeModelWorker, azure ? Infinity : MODEL.waitMs);
        try {
          const { result, frames, durationMs } = await runScorer(wav, s.syllables, azure, spans ? padSpans(spans) : null);
          return unpadRecord(modelRecord({ result, frames, syllables: s.syllables, durationMs }));
        } finally {
          release();
        }
      },
    });
    if ("unavailable" in out) {
      console.log(`[lingo-dojo] pronunciation: model clip unavailable (${out.unavailable})`);
      return sendJson(res, 200, { available: false, why: out.unavailable } satisfies PronunciationModelReply);
    }
    const r = out.record;
    console.log(`[lingo-dojo] pronunciation: model clip ${out.cached ? "hit" : "made"} (${r.engine}${r.spansFrom ? `, on version ${r.spansFrom}'s spans` : ""}), ${r.syllables.length} syllables`);
    sendJson(res, 200, {
      available: true,
      engine: r.engine,
      text: t.text,
      locale: clip.locale,
      durationMs: r.durationMs,
      frames: r.frames,
      syllables: r.syllables,
    } satisfies PronunciationModelReply);
  } finally {
    res.off("close", onClose);
    const left = (modelling.get(ctx.user.id) ?? 1) - 1;
    if (left > 0) modelling.set(ctx.user.id, left);
    else modelling.delete(ctx.user.id);
  }
}

/** The model route's errors leave as HttpErrors with fixed sentences, like
 *  the score route's (its URL may hold the characters). */
async function guardedModel(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  try {
    await model(req, res, ctx);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (res.destroyed) {
      console.log("[lingo-dojo] pronunciation: the browser went away");
      throw new HttpError(499, "cancelled");
    }
    const kind = e instanceof ScoreFailure ? e.kind : "error";
    console.error(`[lingo-dojo] pronunciation: model clip failed (${kind})`);
    throw new HttpError(503, "the model couldn't be read just now; try again");
  }
}

/** /api/pronunciation, mounted with wrap's `learner: true`. */
export async function handlePronunciation(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const parts = subPath(req).split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "score") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return guarded(req, res, ctx);
  }
  if (parts.length === 1 && parts[0] === "model") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    return guardedModel(req, res, ctx);
  }
  sendJson(res, 404, { error: "no such route" });
}
