import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { assemble } from "../../scripts/assemble.mjs";
import { failureHint, startClaude } from "../../scripts/claude.mjs";
import { REPO_ROOT, isDrill, loadContent, modeRoot } from "../../scripts/content.mjs";
import {
  SPEECH_FORMATS as VOICE_SPEECH_FORMATS, ELEVEN_MODELS, MINUTE_CHOICES, SILENCE_MS, SPEAKERS_BY_MODE, TTS_PROVIDERS, VOICE_MODELS, azureSpeechRequest, azureTranscribeRequest, azureVoices,
  azureVoicesRequest, configuredProviders, elevenSpeechRequest, localeFor, elevenTranscribeRequest, voiceFor, elevenVoices, elevenVoicesRequest, envFile,
  ageOf, castFallbacks, castPools, defaultVoicePlan, parseCast, speechVoices, oneLine, replayLine, REPLAY_MAX_CHARS, replayStage, replayCastNotes, retryInOtherVoice, parseChoices, parseGlosses, replayReading, parseLookup, parseStage, parseVoiceReply, planDirective, replyStream, sessionPlan, clockLine, MAX_CHOICES, MAX_GLOSSES, pickCast, pinnedNarratorGender, narratorDirective, AZURE_VOICE_RE, systemVoices, voiceSlots, elevenLibraryRequest, elevenLibraryLocale, elevenLibrarySearchable, elevenLibrary, elevenAddRequest, transcriptText, voiceKeys, voiceSystemPrompt, voiceTurnPrompt,
  SAY_SLOW_WPM, paceOf, speechPace, elevenStoredSettings, elevenVoiceSettingsRequest,
} from "../../scripts/voice.mjs";
import type {
  ErrorCode, VoiceAge, VoiceCastNote, VoiceCastReply, VoiceCastRequest, VoiceChoice,
  LibraryAddReply, LibraryAddRequest, LibraryReply, SegmentLang, SpeechPace, SttProvider, TranscribeReply, VoiceGender, VoiceGloss, TtsProvider, VoiceHistoryItem, VoiceSettings, VoiceSettingsReply, VoiceSettingsRequest,
  VoiceLine, VoiceSoundRequest, VoiceSpeakRequest, VoiceSpeaker, VoiceTurnErrorEvent, VoiceTurnLineEvent, VoiceTurnReply, VoiceTurnRequest, VoicesReply,
} from "../shared/wire.ts";
import { PLAYBACK_RATE_HEADER } from "../shared/wire.ts";
import { HttpError, methodNotAllowed, openSse, readJsonBody, sendJson, subPath, type SseSend } from "./sse.ts";
import { learnerMode, learnerProfile, type Ctx, type LearnerCtx } from "./auth.ts";
import { readVoiceSettings, updateVoiceSettings } from "./store.ts";
import { hintPhrases } from "../../scripts/db/phrases.ts";
import { CONVERSATION_ID_RE } from "../../scripts/conversations.mjs";
import { KEYTERM_SHARE, sessionKeyterms } from "../../scripts/keyterms.mjs";
import { rawDb } from "./db.ts";
import { conversationHints, conversationIdOf, openConversation, playedPack, saveTurn, takeTurnLock } from "./conversations.ts";
import { bankLocaleOf, runLookup, turnRecall } from "./recall.ts";
import { logHints, readsHints, settleHints, wantsReadings } from "./hints.ts";
import { revisitBlock, storedRevisit } from "../../scripts/revisit.mjs";
import { audioKey, cachedAudio } from "../../scripts/audio-cache.mjs";
import { paidSlot } from "./paid.ts";

// Voice practice: run a pack as a spoken session inside the app. Four routes,
// one per step of a turn, so the browser can start playing the first line
// while the next is still being synthesized:
//
//   GET/PUT /api/voice/settings      provider, voices per speaker, turn-taking
//   GET     /api/voice/voices        ?provider=&locale= → the provider's voices
//   POST    /api/voice/transcribe    ?locales=a,b&conversation=<id>&term=…  WAV body → {text}
//                                    (a learner route, mounted on its own path in api.ts)
//   POST    /api/voice/turn          {mode, pack, history, message, conversationId?} → {lines, review}
//                                    (Accept: text/event-stream → `line` events as each is final, then `reply`)
//   POST    /api/voice/speak         {speaker, gender, text, lang, locale} → audio bytes
//   POST    /api/voice/sound         {text, locale} → a character's or zhuyin symbol's sound (cached)
//   GET     /api/voice/library       ElevenLabs Voice Library search
//   POST    /api/voice/library/add   add a library voice to the account (admin)
//   POST    /api/voice/cast          this session's voices
//
// turn, cast and sound act for the active learner and language, so api.ts mounts them with
// wrap's `learner: true` (the page must name both).
//
// The browser holds the session: it sends the whole history with every
// turn. A turn that names a saved conversation (conversations.ts) is stored
// there once it succeeds, so the stored turns mirror that history. Provider keys come from the repo-root .env.local (scripts/voice.mjs
// voiceKeys) and never appear in a reply — the browser only ever learns
// whether a provider is configured.

const PROVIDER_TIMEOUT_MS = 30_000;
/** A recording is capped at 60 s client-side: 16 kHz mono 16-bit WAV is
 *  ~1.9 MB a minute, so this is generous headroom, not a working limit. */
const MAX_AUDIO_BYTES = 8 << 20;
/** Longer than any turn worth speaking; a runaway reply is cut, not billed. */
const MAX_SPEAK_CHARS = 2000;
/** A turn's model call, and the shorter rerun after a LOOKUP (the learner
 *  has already waited once, and the turn holds its lock meanwhile). */
const TURN_TIMEOUT_SEC = 120;
const LOOKUP_TIMEOUT_SEC = 45;
/** Said when a LOOKUP's rerun failed and the first reply had nothing to say
 *  aloud besides its LOOKUP line. In English: the narrator's language
 *  isn't known here without the model. */
const LOOKUP_FAILED_LINE = "NARRATOR: I couldn't look that up just now. Let's carry on.";
/** Exchanges replayed into a turn's prompt. */
const HISTORY_WINDOW = 60;
/** The most history entries a turn may send: the saved conversation mirrors
 *  all of it (the prompt still gets only the last HISTORY_WINDOW), indexed by
 *  conversationStart, so it is never trimmed — a longer one is a 413. Some
 *  1000 exchanges, hours past any session; short entries fit far more than
 *  this in the 1 MB body cap, so this is the limit that binds. */
export const HISTORY_MAX = 2000;

/* -------------------------------- settings -------------------------------- */

// The settings are the logged-in user's (store.ts: user_settings.voice), so
// two people sharing the app keep their own voices and turn-taking.

/** The reply, with the session's locales resolved from the query
 *  (?target=Spanish&variant=Mexican+Spanish&native=English): the language
 *  table lives in scripts/voice.mjs, so the browser asks rather than keeping
 *  a copy. */
function settingsReply(req: IncomingMessage, settings: VoiceSettings): VoiceSettingsReply {
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  const target = q.get("target");
  const native = q.get("native");
  return {
    settings,
    configured: configuredProviders(voiceKeys()),
    models: VOICE_MODELS,
    elevenModels: ELEVEN_MODELS,
    silence: SILENCE_MS,
    speakers: SPEAKERS_BY_MODE,
    slots: { adult: voiceSlots("adult"), kids: voiceSlots("kids") },
    minuteChoices: MINUTE_CHOICES,
    envFile: path.relative(REPO_ROOT, envFile()) || envFile(),
    locales: {
      target: target ? localeFor(target, q.get("variant") ?? "") : null,
      native: native ? localeFor(native) : null,
    },
  };
}

async function handleSettings(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  if (req.method === "GET") return sendJson(res, 200, settingsReply(req, await readVoiceSettings(ctx.user.id)));
  if (req.method === "PUT") {
    const body = await readJsonBody<VoiceSettingsRequest>(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a settings object");
    // A merge into what is stored, done under the user's row lock (store.ts
    // updateVoiceSettings), so overlapping saves from the panel all land.
    const saved = await updateVoiceSettings(ctx.user.id, (cur) => {
      // sessionMinutes merges per mode: the Go tab only knows (and sends) its
      // own mode's choice, and must not reset the other mode's.
      const minutes = body.sessionMinutes && typeof body.sessionMinutes === "object" ? { ...cur.sessionMinutes, ...body.sessionMinutes } : cur.sessionMinutes;
      return { ...cur, ...body, sessionMinutes: minutes } as VoiceSettings;
    });
    return sendJson(res, 200, settingsReply(req, saved));
  }
  methodNotAllowed(res, "GET, PUT");
}

/* -------------------------------- providers ------------------------------- */

const NAMES: Record<TtsProvider, string> = { elevenlabs: "ElevenLabs", azure: "Azure Speech", system: "macOS voices" };

/** The keys a provider needs, or a 400 that says where to put them. */
function keysFor(provider: TtsProvider | SttProvider) {
  const keys = voiceKeys();
  if (!configuredProviders(keys)[provider]) {
    const file = path.relative(REPO_ROOT, envFile()) || envFile();
    const need = provider === "elevenlabs"
      ? "ELEVENLABS_API_KEY"
      : provider === "azure" ? "AZURE_SPEECH_KEY and AZURE_SPEECH_REGION" : "macOS";
    throw new HttpError(400, provider === "system" ? "macOS voices need macOS" : `${NAMES[provider]} is not set up: add ${need} to ${file}`);
  }
  return keys;
}

/** One provider call. A failure becomes a 502 whose sentence names the
 *  provider and what it said — never the request, which carries the key. */
async function call(provider: TtsProvider | SttProvider, req: { url: string; init: RequestInit }, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(req.url, { ...req.init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    if (signal?.aborted) throw new HttpError(499, "cancelled");
    const why = timeout.aborted ? `no answer in ${PROVIDER_TIMEOUT_MS / 1000}s` : String((e as Error)?.message || e);
    throw new HttpError(502, `${NAMES[provider]} could not be reached: ${why}`);
  }
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as { detail?: { message?: string } | string; error?: { message?: string } | string; message?: string };
    const d = j.detail ?? j.error ?? j.message;
    detail = typeof d === "string" ? d : d?.message ?? detail;
  } catch {
    /* not JSON */
  }
  const hint = res.status === 401 || res.status === 403 ? " — check the key (and region) in .env.local" : "";
  throw new HttpError(502, `${NAMES[provider]} answered ${res.status}${detail ? `: ${detail}` : ""}${hint}`);
}

const LOCALE_RE = /^[a-z]{2,3}-[A-Z]{2}$/;

function isTts(v: unknown): v is TtsProvider {
  return typeof v === "string" && (TTS_PROVIDERS as string[]).includes(v);
}

/* -------------------------------- voices ---------------------------------- */

/** `say -v '?'`, the macOS voice list. */
function sayList(): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("say", ["-v", "?"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`say exited ${code}`))));
  });
}

async function handleVoices(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return methodNotAllowed(res, "GET");
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  const provider = q.get("provider");
  const locale = q.get("locale") ?? "";
  if (!isTts(provider)) throw new HttpError(400, `provider must be one of ${TTS_PROVIDERS.join(", ")}`);
  if (!LOCALE_RE.test(locale)) throw new HttpError(400, "locale must look like es-MX");
  const keys = keysFor(provider);
  let voices;
  if (provider === "elevenlabs") {
    voices = elevenVoices(await (await call(provider, elevenVoicesRequest({ key: keys.elevenlabs }))).json(), locale);
  } else if (provider === "azure") {
    voices = azureVoices(await (await call(provider, azureVoicesRequest({ key: keys.azureKey, region: keys.azureRegion }))).json(), locale);
  } else {
    voices = systemVoices(await sayList(), locale);
  }
  sendJson(res, 200, { provider, locale, voices } satisfies VoicesReply);
}

/* ------------------------------- transcribe ------------------------------- */

export async function readAudio(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_AUDIO_BYTES) throw new HttpError(413, "recording too large");
    chunks.push(c as Buffer);
  }
  if (!size) throw new HttpError(400, "no audio in the body");
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * The keyterms of one Go-tab transcription: `heard` (from the page), the
 * conversation's scene vocab and the learner's recent phrases. Only a
 * request that names a conversation (the page sends one with a listening
 * turn, never with a direct request to the dojo master, which is in the
 * native language) gets the last two. Hints must never help a recall: no
 * source may send a phrase of the conversation's frozen review or a
 * revisit's kept phrases, and a drill (the learner says each word from its
 * meaning) gets no keyterms at all, `heard` included. The conversation read is the gate: if it fails, only `heard`
 * goes. A failed bank read costs only the bank's hints. Nothing here costs
 * the transcription (failures are logged). Practice's speak-it doesn't come
 * here.
 */
async function sessionTerms(req: IncomingMessage, ctx: LearnerCtx, heard: string[], conversation: string | null): Promise<string[]> {
  let scene: Awaited<ReturnType<typeof conversationHints>> = null;
  if (conversation && CONVERSATION_ID_RE.test(conversation)) {
    try {
      scene = await conversationHints(ctx, conversation.toLowerCase(), learnerMode(req, ctx));
    } catch (e) {
      console.error("[lingo-dojo] transcribe: reading the scene failed; going on without its keyterms:", e);
    }
  }
  if (!scene) return sessionKeyterms({ heard });
  // A drill has the narrator say each word (so `heard` names the word being
  // recalled a turn later) and asks for it from its meaning: no hints.
  if (scene.drill) return [];
  let bank: string[] = [];
  let review: string[] = [];
  try {
    const read = await hintPhrases(rawDb(), ctx.language, { recent: KEYTERM_SHARE.bank, ids: scene.reviewIds });
    bank = read.recent;
    review = read.review;
  } catch (e) {
    console.error("[lingo-dojo] transcribe: reading the phrase bank failed; going on without its keyterms:", e);
    // The review's texts are unknown, so any source could be naming one.
    return [];
  }
  return sessionKeyterms({
    heard,
    scenario: scene.vocab,
    bank,
    exclude: [...review, ...scene.kept],
  });
}

export async function handleVoiceTranscribe(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  // The first locale is the target: speech goes in as that language (English
  // can always be typed). Terms Scribe is told to expect (docs/VOICE.md
  // §Listen), from three sources, each trimmed to what Scribe accepts:
  // the target phrases the dojo master just used (the page sends these, they
  // are only hints), the scene's own vocab and the learner's recent phrases
  // (both read here, the scene from the conversation's id alone: a client
  // can't name a list).
  const heard = params.getAll("term").slice(0, 200);
  const locales = (params.get("locales") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => LOCALE_RE.test(s));
  const provider = (await readVoiceSettings(ctx.user.id)).stt;
  // Only Scribe takes keyterms: no reads for the other providers.
  const keyterms = provider === "elevenlabs" && (heard.length || params.has("conversation")) ? await sessionTerms(req, ctx, heard, params.get("conversation")) : [];
  const audio = await readAudio(req);
  const mime = String(req.headers["content-type"] || "audio/wav").split(";")[0];
  // In one of the user's paid slots (paid.ts), taken after the upload so a
  // slow one holds nothing.
  const text = await paidSlot(ctx.user.id, () => transcribeAudio(res, { provider, audio, mime, locales, keyterms }), "transcriptions");
  sendJson(res, 200, { text, provider } satisfies TranscribeReply);
}

/**
 * One recording → text, with `provider` (the user's speech-to-text
 * setting). `locales[0]` is the language the speech is taken to be in;
 * `keyterms` are words to expect (Scribe only). The practice drill's
 * speak-it passes none: hinting the expected answer would hear it into the
 * transcript. A paid call, so it stops when the browser gives up on `res`.
 */
export async function transcribeAudio(
  res: ServerResponse,
  { provider, audio, mime, locales, keyterms = [] }: { provider: SttProvider; audio: Uint8Array; mime: string; locales: string[]; keyterms?: string[] },
): Promise<string> {
  const keys = keysFor(provider);
  const request = provider === "elevenlabs"
    ? elevenTranscribeRequest({ key: keys.elevenlabs, audio, mime, language: locales[0], keyterms })
    : azureTranscribeRequest({ key: keys.azureKey, region: keys.azureRegion, audio, locales, mime });
  // A paid call: stop it when the browser gives up (Stop, Close).
  const ctrl = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort();
  };
  res.on("close", onClose);
  try {
    const json = await (await call(provider, request, ctrl.signal)).json();
    return transcriptText(provider, json);
  } finally {
    res.off("close", onClose);
  }
}

/* ---------------------------------- turn ---------------------------------- */

// One turn at a time per conversation (conversations.ts takeTurnLock), or
// per login session for a turn that isn't being saved: the history is the
// client's, so a second turn racing the first would answer a conversation
// that is about to change under it.

function cleanHistory(raw: unknown): VoiceHistoryItem[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > HISTORY_MAX) throw new HttpError(413, `this session is too long to go on (over ${HISTORY_MAX} turns); press Restart to start a new one`);
  const out: VoiceHistoryItem[] = [];
  for (const m of raw) {
    if (m?.role === "learner" && typeof m.text === "string") out.push({ role: "learner", text: m.text.slice(0, REPLAY_MAX_CHARS) });
    else if (m?.role === "master" && Array.isArray(m.lines)) {
      const lines: VoiceLine[] = [];
      for (const l of m.lines as unknown[]) {
        const line = l as { speaker?: unknown; text?: unknown; segments?: unknown };
        if (typeof line?.speaker !== "string" || typeof line.text !== "string") continue;
        const segments = Array.isArray(line.segments)
          ? (line.segments as { lang?: unknown; text?: unknown; slow?: unknown }[])
              .filter((g) => (g?.lang === "target" || g?.lang === "native") && typeof g.text === "string")
              // The pace mark goes back in the replay (markedText), so the
              // dojo master sees what it marked slow and keeps to it.
              .map((g) => ({ lang: g.lang as SegmentLang, text: oneLine(g.text as string).slice(0, 4000), ...(g.slow === true ? { slow: true as const } : {}) }))
          : [];
        const gender = (line as { gender?: unknown }).gender;
        // The dojo master's own timing marks go back in the replay (timingFor),
        // so it keeps seeing the format it used.
        const gap = (line as { gap?: unknown }).gap;
        lines.push({
          speaker: line.speaker as VoiceSpeaker,
          gender: gender === "female" || gender === "male" ? gender : null,
          // One line each: a newline in a replayed line would start a new,
          // untagged line (or a fake GLOSS/STAGE line) in the transcript.
          text: replayLine(line.text),
          segments,
          ...(typeof gap === "number" && Number.isFinite(gap) ? { gap: Math.max(-1.5, Math.min(4, gap)) } : {}),
        });
      }
      // Glosses go back in the replay too, so the dojo master keeps writing
      // its GLOSS line and knows which words it has already explained.
      const glosses: VoiceGloss[] = Array.isArray(m.glosses)
        ? (m.glosses as { term?: unknown; meaning?: unknown; reading?: unknown }[])
            .filter((g) => typeof g?.term === "string" && typeof g.meaning === "string")
            .slice(0, MAX_GLOSSES)
            // A kept reading hint goes back too (only syllables and spaces:
            // replayReading), so the dojo master keeps seeing the form.
            .map((g) => ({ term: oneLine(g.term as string).slice(0, 200), meaning: oneLine(g.meaning as string).slice(0, 300), ...(replayReading(g.reading) ? { reading: replayReading(g.reading) } : {}) }))
        : [];
      const choices = Array.isArray(m.choices)
        ? (m.choices as unknown[]).filter((c): c is string => typeof c === "string").slice(0, MAX_CHOICES).map((c) => oneLine(c).slice(0, 60))
        : [];
      // The part the turn ended in goes back as its STAGE line, so the dojo
      // master keeps writing one; only an id-shaped value survives.
      const stage = replayStage(m.stage);
      // Who each voice tag is goes back as CAST lines, so the dojo master
      // keeps its characters (and their ages) straight.
      const castNotes: VoiceCastNote[] = replayCastNotes(m.castNotes);
      out.push({ role: "master", lines, ...(glosses.length ? { glosses } : {}), ...(choices.length ? { choices } : {}), ...(stage ? { stage } : {}), ...(castNotes.length ? { castNotes } : {}) });
    }
  }
  return out;
}

/** POST /api/voice/turn, mounted on its own with wrap's `learner: true`. */
export async function handleVoiceTurn(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const body = await readJsonBody<Partial<VoiceTurnRequest>>(req);
  // The active learner's mode; a body naming the other one is a 400.
  const mode = learnerMode(req, ctx, body?.mode ?? undefined);
  if (!body?.pack || typeof body.pack !== "object") throw new HttpError(400, "body must carry the pack");
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length > REPLAY_MAX_CHARS) throw new HttpError(413, "message too long");
  const all = cleanHistory(body.history);
  const history = all.slice(-HISTORY_WINDOW);
  const from = Number.isInteger(body.conversationStart) ? Math.max(0, Math.min(all.length, body.conversationStart as number)) : 0;
  // The lock first, before any await, so an End that comes in meanwhile
  // either waits for this whole turn or refuses it (conversations.ts).
  const conversationId = conversationIdOf(body.conversationId);
  const release = takeTurnLock(ctx.learner.id, conversationId, ctx.sessionId);

  // Cancel the run when the browser gives up (Stop, a page reload): listen
  // on `res`, as the chat route does — readJsonBody consumed the request.
  const ctrl = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort();
  };
  res.on("close", onClose);
  // Streaming (docs/VOICE.md §Streaming the reply): a client that accepts
  // SSE gets each spoken line as soon as it is final, so the first one is
  // being synthesized while the rest is still being written. The stream
  // opens only with the first line: everything that fails before it (a
  // stale conversation, a failed run) is the same JSON error as ever.
  const streaming = String(req.headers.accept ?? "").includes("text/event-stream");
  // Set inside the run's onText, so typed wide: a plain null would stay
  // narrowed to null for TypeScript after the awaits.
  let sse = null as SseSend | null;
  const streamed: VoiceLine[] = [];
  try {
    // A saved conversation must be this learner's and still open (else a 404
    // or 409 whose code sends the Go tab to start a new one), checked before
    // anything runs. Its part of the history starts at conversationStart.
    const conversation = conversationId ? await openConversation(ctx.user.id, ctx.language, conversationId) : null;
    // A random scene plays the scenario its conversation drew at the start
    // (a 409 without one); any other pack plays as sent.
    const pack = playedPack(body.pack, conversation);
    // The active learner and language are the profile (content.profile is the file's).
    const content = { ...loadContent(modeRoot(mode)), profile: learnerProfile(ctx.learner, ctx.language) };
    // Recall (docs/DATA.md §Recall in sessions), from one read of the bank:
    // the review block (the phrases stored on the conversation when it
    // began, read back by id, so every turn of a session and its recap offer
    // the same ones), and the bank phrases most like what was just said.
    // Reads only; never fails a turn.
    const now = new Date();
    const lastMaster = history.findLast((m) => m.role === "master");
    const recall = await turnRecall(ctx.language, {
      content, pack, mode, now, conversation,
      message,
      lastLine: lastMaster?.role === "master" ? lastMaster.lines.map((l) => l.text).join(" ") : "",
    });
    if (process.env.LINGO_DEBUG_RECALL) console.log(`[lingo-dojo] recall: ${recall.phrases.length} phrases read and ranked in ${recall.ms.toFixed(1)} ms; review ${recall.review.length}, retrieval ${recall.retrieval ? "yes" : "none"}`);
    // The Final rules (a unit's `closing`) come back apart: they go last in
    // the system prompt, after the blocks appended below.
    const { markdown, warnings, closing } = assemble(content, pack, { mode, review: recall.review, closing: "separate" });
    // The session's parts, for the timeline: named to the dojo master, which
    // reports where it is with a STAGE line each turn.
    const plan = sessionPlan(content, pack, mode);
    // A drill (First steps) is the narrator alone: the adapter allows only
    // its tag, and any other tag in the reply is voiced as the narrator.
    const drill = isDrill(content.scenarios.find((s) => s.id === pack.scenario));
    const settings = await readVoiceSettings(ctx.user.id);
    // With a time budget (the pack's minutes, plus any +5 min the browser
    // added), one clock line: the browser's elapsed time since the first
    // turn, and the part the last turn ended in. No budget, no line.
    let lastStage: string | null = null;
    for (const m of history) if (m.role === "master" && m.stage) lastStage = m.stage;
    const clock = clockLine({ minutes: pack.overrides?.minutes, elapsedMs: body.elapsedMs, plan, stage: lastStage, mode });
    // The session's narrator gender, drawn by the client at session start,
    // unless the pack's own narrator unit fixes it.
    // A session that builds on an earlier attempt of this scene (docs/DATA.md
    // §Revisit) carries a briefing on it, frozen when it began; adults only.
    // The session's target locale: the conversation's own (its pack's
    // variant), else the language profile's. A Mandarin session asks for
    // reading hints on its glosses; no other language's prompt changes.
    const targetLocale = (conversation ? localeFor(conversation.targetLanguage, conversation.targetVariant) : null) ?? bankLocaleOf(ctx.language) ?? "";
    const systemPrompt =
      voiceSystemPrompt(markdown, mode, { drill, readings: wantsReadings(targetLocale) }) +
      (pinnedNarratorGender(pack.units) ? "" : narratorDirective(body.narratorGender)) +
      planDirective(plan, { drill }) +
      (conversation ? revisitBlock(storedRevisit(conversation.packSnapshot)) : "") +
      (closing ? `\n\n${closing}\n` : "");
    const ask = async (notes: string[], timeoutSec = TURN_TIMEOUT_SEC) => {
      // Each run reads its own reply; only one run's lines are ever streamed
      // (a rerun happens only when the first sent none: replyStream).
      const reader = replyStream(mode, { drill });
      const onText = streaming
        ? (delta: string) => {
            const { lines, castNotes } = reader.push(delta);
            if (!lines.length || ctrl.signal.aborted) return;
            sse ??= openSse(res);
            for (const line of lines) {
              sse("line", { index: streamed.length, line, castNotes } satisfies VoiceTurnLineEvent);
              streamed.push(line);
            }
          }
        : undefined;
      const { result } = startClaude({
        prompt: voiceTurnPrompt(history, message, clock, notes),
        systemPrompt,
        model: settings.model,
        // No tools, so no file access is needed: an empty temp cwd keeps the
        // repo's CLAUDE.md (instructions for coding agents) out of the turn.
        cwd: os.tmpdir(),
        signal: ctrl.signal,
        tools: "none",
        maxTurns: 1,
        timeoutSec,
        onText,
      });
      try {
        return { ...(await result), streamed: reader.sent };
      } catch (e) {
        const msg = String((e as Error)?.message || e);
        throw new HttpError(msg === "cancelled" ? 499 : 502, failureHint(msg) || msg);
      }
    };
    const notes = [recall.retrieval];
    let run = await ask(notes);
    // LOOKUP: the dojo master asked for the learner's past instead of
    // replying. The server answers it (the bank and past sessions, this
    // language only) and asks once more with the results; a LOOKUP in that
    // second reply is ignored (never spoken, never run), so a turn costs
    // two model calls at most. The turn row keeps what was asked and found.
    let lookup: Record<string, unknown> | null = null;
    const query = parseLookup(run.text);
    if (query && run.streamed) {
      // Asked for after lines had already been spoken (against the
      // adapter's "only one line"): they can't be taken back, so the reply
      // stands as it is and the lookup is not run, as a LOOKUP in a rerun
      // isn't. Only a streamed turn can get here.
      lookup = { query, late: true };
    } else if (query) {
      const found = await runLookup(ctx.language, recall.phrases, query, { now, conversationId: conversation?.id ?? null, inBank: recall.inBank });
      const first = run;
      let failed = false;
      try {
        // Shorter than a first call: the learner has already waited once,
        // and the turn holds its lock meanwhile.
        run = await ask([...notes, found.block], LOOKUP_TIMEOUT_SEC);
      } catch (e) {
        // Stop or a reload: the turn is cancelled, as any. A rerun that
        // failed after its first lines went out fails the turn: the learner
        // has heard part of a reply the first one can't stand in for.
        if ((e instanceof HttpError && e.status === 499) || streamed.length) throw e;
        // A failed or timed-out rerun doesn't lose the turn: the first
        // reply stands, its LOOKUP line never spoken (parseVoiceReply), or
        // a short line from the narrator when it had nothing else to say.
        console.warn(`[lingo-dojo] voice turn: the rerun after a LOOKUP failed; using the first reply: ${(e as Error)?.message ?? e}`);
        failed = true;
        run = parseVoiceReply(first.text, mode, { drill }).length ? first : { ...first, text: `${first.text}\n${LOOKUP_FAILED_LINE}`, streamed: 0 };
      }
      if (!failed) {
        run = {
          ...run,
          durationMs: (first.durationMs ?? 0) + (run.durationMs ?? 0),
          costUsd: first.costUsd == null && run.costUsd == null ? null : (first.costUsd ?? 0) + (run.costUsd ?? 0),
        };
      }
      lookup = { ...found.record, ...(failed ? { failed: true } : parseLookup(run.text) ? { repeated: true } : {}) };
    }
    const lines = parseVoiceReply(run.text, mode, { drill });
    if (!lines.length) throw new HttpError(502, "the dojo master's reply had nothing to say aloud");
    // Every reading hint is checked before anything keeps it (hints.ts).
    const hinted = settleHints(parseGlosses(run.text, { readings: readsHints(targetLocale) }), lines, targetLocale);
    logHints(hinted.stats);
    const reply: VoiceTurnReply = { lines, glosses: hinted.glosses, choices: parseChoices(run.text), plan, stage: parseStage(run.text, plan.map((p) => p.id)), castNotes: parseCast(run.text, mode, { drill }), model: settings.model, durationMs: run.durationMs, costUsd: run.costUsd, warnings, review: { items: recall.review, locale: bankLocaleOf(ctx.language) } };
    if (conversation) {
      // Stored before the reply goes out, still under the lock. A failed
      // write doesn't cost the learner a reply that's already paid for: the
      // turn stands, unsaved, and the panel says so.
      const master = {
        role: "master" as const, lines, glosses: reply.glosses, choices: reply.choices, ...(reply.stage ? { stage: reply.stage } : {}), castNotes: reply.castNotes,
        durationMs: run.durationMs, costUsd: run.costUsd,
      };
      reply.saved = await saveTurn(ctx.language, conversation.id, { screen: all.slice(from), message, master, pack, model: settings.model, lookup, review: recall.store }).catch((e) => {
        console.error(`[lingo-dojo] saving a turn of conversation ${conversation.id}:`, e);
        return false;
      });
    }
    if (!sse) return sendJson(res, 200, reply);
    // The whole reply's parse is the turn (stored above, shown, replayed);
    // the streamed lines were read from its prefix the same way, so they
    // are its first lines. Should a malformed reply ever make them differ
    // (a spoken line after GLOSS), the browser takes these lines from where
    // it has got to.
    if (JSON.stringify(lines.slice(0, streamed.length)) !== JSON.stringify(streamed)) {
      console.warn(`[lingo-dojo] voice turn: the streamed lines differ from the whole reply's; the reply's stand`);
    }
    sse("reply", reply);
    res.end();
  } catch (e) {
    if (!sse) throw e;
    // Mid-stream: the status line went out with the first line, so the
    // failure is an event (wrap() could only cut the socket). Logged as
    // wrap() would; only an HttpError's sentence reaches the browser.
    const known = e instanceof HttpError;
    if (!known) console.error("[lingo-dojo] POST /api/voice/turn (streaming):", e);
    const ev: VoiceTurnErrorEvent = known ? { error: e.message, status: e.status, ...(e.code ? { code: e.code as ErrorCode } : {}) } : { error: "something went wrong on the server; its log has the details", status: 500 }; // api.ts INTERNAL_ERROR (not imported: api.ts imports this module)
    sse("error", ev);
    res.end();
  } finally {
    release();
    res.off("close", onClose);
  }
}

/* ---------------------------------- speak --------------------------------- */

/** macOS `say` into a WAV the browser can play (it writes AIFF by default,
 *  which Chrome cannot). The text goes in on stdin, never argv, so a line
 *  starting with "-" is still just words. */
function sayToWav(text: string, voice: string, signal: AbortSignal, speed = 1): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-say-"));
  const out = path.join(dir, "line.wav");
  const args = sayArgs(voice, out, speed);
  return new Promise<Buffer>((resolve, reject) => {
    const p = spawn("say", args, { stdio: ["pipe", "ignore", "pipe"], signal });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(e.name === "AbortError" ? new HttpError(499, "cancelled") : e));
    p.on("close", (code) => {
      if (code === 0) {
        try {
          resolve(fs.readFileSync(out));
        } catch (e) {
          reject(e);
        }
      } else reject(new HttpError(502, `say failed${err.trim() ? `: ${err.trim()}` : ` (exit ${code})`}`));
    });
    // `say` can exit before reading (a bad voice, an abort): the EPIPE that
    // follows must not become an uncaught stream error that kills the server.
    p.stdin.on("error", () => {});
    p.stdin.end(text);
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** `say`'s arguments for one line into `out`. A slower pace is `-r` with a
 *  fixed words-a-minute (SAY_SLOW_WPM: `say` has no relative rate); the
 *  normal pace passes no -r, so each voice keeps its own default. */
export function sayArgs(voice: string, out: string, speed = 1): string[] {
  const args = ["--file-format=WAVE", `--data-format=${VOICE_SPEECH_FORMATS.system}`, "-o", out];
  if (speed < 1) args.unshift("-r", String(SAY_SLOW_WPM));
  if (voice) args.unshift("-v", voice);
  return args;
}

async function handleSpeak(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const body = await readJsonBody<Partial<VoiceSpeakRequest>>(req);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) throw new HttpError(400, "text is required");
  if (text.length > MAX_SPEAK_CHARS) throw new HttpError(413, `a line is capped at ${MAX_SPEAK_CHARS} characters`);
  const locale = typeof body?.locale === "string" && LOCALE_RE.test(body.locale) ? body.locale : "";
  if (!locale) throw new HttpError(400, "locale must look like es-MX");
  // The language of this text: target words are said with the target
  // locale's pronunciation, native ones with the learner's — same voice.
  const lang: SegmentLang = body?.lang === "native" ? "native" : "target";
  // The pace is one of two words. A number, or any other word, is refused:
  // the provider settings are the server's constants, never the client's.
  const pace = paceOf(body?.pace);
  if (!pace) throw new HttpError(400, "pace must be normal or slow");
  const nativeLocale = typeof body?.nativeLocale === "string" && LOCALE_RE.test(body.nativeLocale) ? body.nativeLocale : "";
  const textLocale = lang === "native" && nativeLocale ? nativeLocale : locale;
  const speaker = body?.speaker;
  if (typeof speaker !== "string" || !["narrator", "character", "sidekick"].includes(speaker)) {
    throw new HttpError(400, "speaker must be narrator, character or sidekick");
  }
  const settings = await readVoiceSettings(ctx.user.id);
  const provider = settings.tts;
  keysFor(provider);
  // The speaker's own voice; a speaker without one borrows the narrator's,
  // so a half-set-up kids session still talks.
  // Always the speaker's own native voice, whatever language the text is in:
  // the frame's dojo master is a native speaker of the target variant who
  // also speaks the learner's language. `lang` only steers pronunciation;
  // `gender` (the dojo master's -F/-M tag) picks the woman's or man's voice.
  const gender: VoiceGender | null = body?.gender === "female" || body?.gender === "male" ? body.gender : null;
  // The session's cast names the voice; without one, the saved choice.
  // A cast drawn for another provider (the provider changed mid-session;
  // settings are shared by every window) names voices this one can't use.
  const cast = body?.provider === provider ? castVoice(provider, body?.voice) : null;
  // What a refused cast voice falls back to (speechVoices): the learner's
  // voice for this exact slot, else the account voice /cast named for it
  // (all-Random on a free plan has no saved voice, and library voices are
  // refused there), else a voice borrowed from another slot.
  const fallback = body?.provider === provider ? (castVoice(provider, body?.fallback) ?? "") : "";
  const { first: chosen, retry } = speechVoices({ set: settings.voices[provider]?.[locale] ?? {}, speaker, gender, cast, fallback, refused: refusedVoices });
  // Nothing saved, cast or to fall back on (every slot Random, and a line
  // from outside a session: the character card's Hear it): the provider's
  // default for the locale rather than a 400. macOS still says it in the
  // Mac's own voice when the locale has none installed, as before.
  // A native voice of the account first (an added library voice may be
  // refused on a free plan: defaultFallback is the premade voice to say the
  // line in then, as practiceVoice's clips do).
  const plan = chosen ? null : await defaultPlanFor(provider, locale, gender, provider === "system");
  const first = chosen || plan?.voice || "";
  const defaultFallback = plan?.fallback ?? "";
  const voice = first;

  const ctrl = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort();
  };
  res.on("close", onClose);
  try {
    const line = { provider, text, locale: textLocale, model: settings.elevenModel, pace };
    // The line's calls (a refused cast voice's retry included, one after the
    // other) hold one of the user's paid slots (paid.ts). The Go tab asks for
    // one part at a time (the next once the current one has arrived), so the
    // other slot is left for a voice draw.
    const out = await paidSlot(ctx.user.id, async (): Promise<Speech> => {
      if (provider === "elevenlabs") {
        // A cast voice refused once goes straight to the retry voice after
        // that (speechVoices), so a free plan doesn't pay two calls a line.
        try {
          return await synthesize({ ...line, voice: first }, ctrl.signal);
        } catch (e) {
          // A library voice drawn for the cast can be refused: a plan without
          // library access, or a voice since removed. retryInOtherVoice takes
          // the statuses that mean "not this voice" (400, 402, 403, 404, 422),
          // not a bad key, spent credits or a rate limit. Say the line in the
          // retry voice (speechVoices) rather than lose it.
          const status = Number(String((e as Error)?.message).match(/answered (\d{3})\b/)?.[1]);
          const other = cast ? retry : defaultFallback;
          if (!other || !retryInOtherVoice(status)) throw e;
          const said = await synthesize({ ...line, voice: other }, ctrl.signal);
          if (cast) {
            // The other voice worked, so it was the cast voice: skip it from now on.
            if (refusedVoices.size >= 200) refusedVoices.clear();
            refusedVoices.add(cast);
          } else {
            // The default is asked again next time (a plan upgrade should be
            // heard), so no refusal is remembered.
            console.warn(`[lingo-dojo] ElevenLabs refused the default voice ${first} for ${locale} (${status}): spoke in the premade voice ${other}`);
          }
          return said;
        }
      }
      return synthesize({ ...line, voice }, ctrl.signal);
    });
    res.writeHead(200, {
      "Content-Type": out.type,
      "Content-Length": out.audio.length,
      "Cache-Control": "no-store",
      // The rate the browser plays the clip at, when the voice that said
      // it couldn't slow down itself (synthesize).
      ...(out.playbackRate && out.playbackRate !== 1 ? { [PLAYBACK_RATE_HEADER]: String(out.playbackRate) } : {}),
    });
    res.end(out.audio);
  } finally {
    res.off("close", onClose);
  }
}

/** Synthesized audio and its content type. */
export interface Speech {
  audio: Buffer;
  type: "audio/mpeg" | "audio/wav";
  /** Below 1 when the clip was asked for slow and is at normal speed: the
   *  voice can't slow down (speechPace), or its stored ElevenLabs settings
   *  couldn't be read. The caller slows the playback. Absent or 1 else. */
  playbackRate?: number;
}

/** How long a voice's stored ElevenLabs settings are kept: a turn's slow
 *  pieces must not mean a read each, and a voice re-tuned in ElevenLabs
 *  should be heard that way within minutes. A failed read is kept for
 *  VOICE_LIST_FAIL_MS, so an outage costs one read per half minute. */
const VOICE_SETTINGS_TTL_MS = 10 * 60_000;
/** Per ElevenLabs key and voice. Not per app user: the settings belong to
 *  the one ElevenLabs account every user's speech goes through, so users
 *  sharing a voice share the read. */
const voiceSettings = new Map<string, { at: number; ttl: number; value: Promise<Record<string, number | boolean> | null> }>();

/** `voice`'s stored settings, to send back with a speed (scripts/voice.mjs
 *  elevenSpeechRequest: a speed alone would reset them). A free read, held
 *  in memory. null when it can't be read or isn't a settings object: the
 *  clip is then made at normal speed and the browser slows it. */
async function storedElevenSettings(key: string, voice: string): Promise<Record<string, number | boolean> | null> {
  const id = `${createHash("sha256").update(key).digest("hex").slice(0, 16)}:${voice}`;
  let held = voiceSettings.get(id);
  if (!held || Date.now() - held.at > held.ttl) {
    if (voiceSettings.size >= 500) voiceSettings.clear();
    // No request signal: the read is shared by every clip that waits on it.
    const value = call("elevenlabs", elevenVoiceSettingsRequest({ key, voice }))
      .then(async (r) => elevenStoredSettings(await r.json()))
      .catch((e) => {
        console.warn(`[lingo-dojo] ElevenLabs voice settings unread, slowing in the browser instead: ${String((e as Error)?.message || e).slice(0, 200)}`);
        return null;
      });
    const entry = { at: Date.now(), ttl: VOICE_SETTINGS_TTL_MS, value };
    void value.then((v) => {
      if (!v) entry.ttl = VOICE_LIST_FAIL_MS;
    });
    voiceSettings.set(id, entry);
    held = entry;
  }
  return held.value;
}

/** The output format each provider is asked for: scripts/voice.mjs's, the
 *  one its requests and sayToWav use (part of the phrase audio cache key). */
export const SPEECH_FORMATS: Readonly<Record<TtsProvider, string>> = VOICE_SPEECH_FORMATS;

/** The keys `provider` needs for speech-to-text, or the 400 that says where
 *  to put them (the Practice tab's speak-it check before a session). */
export function sttReady(provider: SttProvider): void {
  keysFor(provider);
}

/**
 * One line of speech from `provider` in `voice` (one call, no retry in
 * another voice). `locale` steers pronunciation; `model` is the ElevenLabs
 * model (the others ignore it). /api/voice/speak and the practice drill's
 * phrase audio (practice.ts, through the audio cache) both come here.
 * `pace` "slow" asks the provider for its slow setting where it has one
 * (speechPace: ElevenLabs voice_settings.speed, Azure <prosody rate>,
 * `say -r`); where it has none the clip comes back at normal speed and the
 * caller slows the playback. A caller that caches must put speechPace's
 * `speed` in its audioKey.
 */
export async function synthesize(
  { provider, voice, text, locale, model, pace = "normal" }: { provider: TtsProvider; voice: string; text: string; locale: string; model: string; pace?: SpeechPace },
  signal: AbortSignal,
): Promise<Speech> {
  const keys = keysFor(provider);
  const { speed, playbackRate } = speechPace(provider, pace, { model, voice });
  if (provider === "elevenlabs") {
    // A slow piece goes with the voice's stored settings or not at all.
    const stored = speed !== 1 ? await storedElevenSettings(String(keys.elevenlabs), voice) : null;
    const r = await call(provider, elevenSpeechRequest({ key: keys.elevenlabs, voice, text, model, locale, speed, settings: stored }), signal);
    return { audio: Buffer.from(await r.arrayBuffer()), type: "audio/mpeg", playbackRate: speed !== 1 && !stored ? speed : playbackRate };
  }
  if (provider === "azure") {
    let request;
    try {
      request = azureSpeechRequest({ key: keys.azureKey, region: keys.azureRegion, voice, text, locale, speed });
    } catch (e) {
      throw new HttpError(400, String((e as Error).message));
    }
    return { audio: Buffer.from(await (await call(provider, request, signal)).arrayBuffer()), type: "audio/mpeg", playbackRate };
  }
  return { audio: await sayToWav(text, voice, signal, speed), type: "audio/wav", playbackRate };
}

/** The macOS voices for a locale (`say -v '?'`, read once per process). */
let sayListOnce: Promise<string> | null = null;
export async function systemVoicesFor(locale: string): Promise<VoiceChoice[]> {
  sayListOnce ??= sayList().catch((e) => {
    sayListOnce = null;
    throw e;
  });
  return systemVoices(await sayListOnce, locale);
}

/** How long a paid provider's voice list is kept: the default voice is
 *  looked up per line, which must not mean a list call per line, but a
 *  voice removed from the account should stop being picked within the hour. */
const VOICE_LIST_TTL_MS = 60 * 60_000;
/** A failed list fetch is kept this long, so an outage (or a bad key) costs
 *  one list call per half minute, not one per tapped sound. */
const VOICE_LIST_FAIL_MS = 30_000;
/** The raw voice list per paid provider and key (ElevenLabs: the whole
 *  account's; Azure: every voice of the region), shared by every user and
 *  locale. Keyed by a hash of the key too, so a key rotated in .env.local
 *  never serves the old account's voice ids. */
const voiceLists = new Map<string, { at: number; ttl: number; json: Promise<unknown> }>();

/** Forget the cached voice lists (tests stub a provider per case). */
export function clearVoiceLists(): void {
  voiceLists.clear();
  voiceSettings.clear();
}

async function providerVoices(provider: TtsProvider, locale: string): Promise<VoiceChoice[]> {
  if (provider === "system") return systemVoicesFor(locale);
  const keys = keysFor(provider);
  const secret = provider === "elevenlabs" ? keys.elevenlabs : `${keys.azureRegion}\u0001${keys.azureKey}`;
  const id = `${provider}:${createHash("sha256").update(String(secret)).digest("hex").slice(0, 16)}`;
  let held = voiceLists.get(id);
  if (!held || Date.now() - held.at > held.ttl) {
    const request = provider === "elevenlabs" ? elevenVoicesRequest({ key: keys.elevenlabs }) : azureVoicesRequest({ key: keys.azureKey, region: keys.azureRegion });
    const json = call(provider, request).then((r) => r.json() as Promise<unknown>);
    const entry = { at: Date.now(), ttl: VOICE_LIST_TTL_MS, json };
    voiceLists.set(id, entry);
    json.catch(() => {
      entry.ttl = VOICE_LIST_FAIL_MS;
    });
    held = entry;
  }
  const json = await held.json;
  return provider === "elevenlabs" ? elevenVoices(json, locale) : azureVoices(json, locale);
}

/**
 * The voice to use when the learner saved none for `locale` (scripts/voice.mjs
 * defaultVoice: a native speaker of the locale's language first, in the
 * locale's own region, else the provider's other voices). The provider's list is read through the per-process cache. With
 * `optional` (macOS on the Go tab, whose `say` without a voice still talks)
 * an empty list is "", else a 400 that says what to do. A provider without
 * its keys is still keysFor's 400: the default replaces "no voice saved",
 * never "no provider".
 */
async function defaultVoiceFor(provider: TtsProvider, locale: string, gender: VoiceGender | null, optional = false): Promise<string> {
  return (await defaultPlanFor(provider, locale, gender, optional)).voice;
}

/** defaultVoiceFor with the premade voice to retry in after a refusal, and
 *  whether the voice is native to the locale (defaultVoicePlan). */
async function defaultPlanFor(provider: TtsProvider, locale: string, gender: VoiceGender | null, optional = false): Promise<{ voice: string; fallback: string; native: boolean }> {
  const voices = provider === "system" ? await systemVoicesFor(locale).catch(() => []) : await providerVoices(provider, locale);
  const plan = defaultVoicePlan(provider, voices, gender);
  const voice = plan.voice;
  if (voice || optional) return plan;
  // Without one, `say` would read the words in the Mac's own language, and
  // that audio would be cached: refuse instead.
  if (provider === "system") {
    throw new HttpError(400, `no macOS voice is installed for ${locale}: add one in System Settings → Accessibility → Spoken Content, or pick another voice provider`);
  }
  throw new HttpError(400, `${NAMES[provider]} has no voice for ${locale} to default to: pick one in the Go tab's voice settings`);
}

/**
 * The narrator's voice for `locale` outside a session (a practice drill's
 * phrase, the picture game's word, the character card's sounds): the user's
 * own voice setting, the narrator's first (as voiceFor borrows: the Go tab's
 * dojo master), else a native speaker of the locale's language (defaultVoice),
 * so a learner whose slots are all Random still hears the language in its
 * own accent. `fallback` is the premade voice to use if ElevenLabs refuses
 * that native library voice (outsideClip); "" for a saved voice (the learner
 * chose it) and when there is none. -> { provider, voice, model, fallback }.
 */
export async function practiceVoice(settings: VoiceSettings, locale: string, gender: VoiceGender | null = null): Promise<{ provider: TtsProvider; voice: string; model: string; fallback: string }> {
  const provider = settings.tts;
  keysFor(provider);
  const saved = voiceFor(settings.voices[provider]?.[locale] ?? {}, "narrator", gender);
  const plan = saved ? null : await defaultPlanFor(provider, locale, gender);
  return { provider, voice: saved || plan?.voice || "", model: provider === "elevenlabs" ? settings.elevenModel : "", fallback: plan?.fallback ?? "" };
}

/**
 * One phrase or sound said outside a session, through the per-user audio
 * cache (Practice's phrases, the picture game's words, the character card's
 * sounds, both compare clips). The first play pays the provider, every
 * later one is read from disk. If ElevenLabs refuses the native library
 * voice (retryInOtherVoice's statuses: a plan without library access), the
 * clip is made in the premade voice instead and stored under that voice's
 * key. The refusal is remembered for ten minutes (per key and voice), so
 * replays and preloads go straight to the premade clip, and a plan that
 * gains access is heard after that. Logged with no text.
 */
export async function outsideClip(userId: string, settings: VoiceSettings, locale: string, text: string, signal: AbortSignal): Promise<{ key: string; audio: Buffer; type: string; cached: boolean }> {
  const { provider, voice, model, fallback } = await practiceVoice(settings, locale);
  const keyFor = (v: string) => audioKey({ owner: userId, provider, voice: v, model, format: SPEECH_FORMATS[provider], locale, speed: 1, text });
  const say = (v: string) => paidSlot(userId, () => synthesize({ provider, voice: v, text, locale, model }, signal));
  const viaFallback = async () => {
    const key = keyFor(fallback);
    return { key, ...(await cachedAudio(key, () => say(fallback))) };
  };
  // A plan that refused this voice a moment ago will refuse it again: straight
  // to the premade clip (a cache hit costs no call and holds no paid slot).
  if (fallback && refusedNow(provider, voice)) return viaFallback();
  try {
    const key = keyFor(voice);
    return { key, ...(await cachedAudio(key, () => say(voice))) };
  } catch (e) {
    const status = Number(String((e as Error)?.message).match(/answered (\d{3})\b/)?.[1]);
    if (!fallback || !retryInOtherVoice(status)) throw e;
    console.warn(`[lingo-dojo] ElevenLabs refused the native voice ${voice} for ${locale} (${status}): using the premade voice ${fallback}`);
    rememberRefusal(provider, voice);
    return viaFallback();
  }
}

/** Native library voices ElevenLabs refused lately, per key hash and voice:
 *  for REFUSAL_TTL_MS the premade voice is used without asking again (like
 *  storedElevenSettings, held in memory; a plan upgrade is heard after it). */
const REFUSAL_TTL_MS = 10 * 60_000;
const refusals = new Map<string, number>();
function refusalId(provider: TtsProvider, voice: string): string {
  const secret = provider === "elevenlabs" ? keysFor(provider).elevenlabs : "";
  return `${createHash("sha256").update(String(secret)).digest("hex").slice(0, 16)}:${voice}`;
}
function rememberRefusal(provider: TtsProvider, voice: string): void {
  if (refusals.size >= 500) refusals.clear();
  refusals.set(refusalId(provider, voice), Date.now() + REFUSAL_TTL_MS);
}
function refusedNow(provider: TtsProvider, voice: string): boolean {
  const id = refusalId(provider, voice);
  const until = refusals.get(id);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  refusals.delete(id);
  return false;
}
/** Forget every remembered refusal (tests). */
export function clearRefusals(): void {
  refusals.clear();
}

/**
 * A sentence for the status when `locale` would be said in a voice that is
 * not a native speaker's: no voice saved for it and none native on the
 * account, so the default voice is another language's. A warning only: the
 * words still play. null with a saved voice, a native default, macOS (no
 * installed voice is voiceReady's own refusal) or a voice list that can't be
 * read (the audio route says why when it is played). Reads the provider's
 * list through its per-process cache, a free call.
 */
export async function voiceNote(settings: VoiceSettings, locale: string): Promise<string | null> {
  const provider = settings.tts;
  if (provider === "system" || voiceFor(settings.voices[provider]?.[locale] ?? {}, "narrator", null)) return null;
  const plan = await defaultPlanFor(provider, locale, null, true).catch(() => null);
  if (plan?.native && plan.fallback && refusedNow(provider, plan.voice)) {
    return `${NAMES[provider]} refused the native ${locale} voice (the plan may not allow library voices), so words are said in a premade voice that isn't native: use a plan that allows library voices, or save a voice in the Go tab's voice settings`;
  }
  if (!plan || plan.native) return null;
  return `${NAMES[provider]} has no native ${locale} voice on this account, so words are said in another language's voice: add one in the Go tab's voice settings`;
}

/**
 * Why `locale` can't be spoken with these settings, as practiceVoice would
 * fail, without a provider call: no keys for the provider, or (macOS) no
 * voice installed for the locale. A paid provider's default voice is only
 * looked up when a line is said, so the Practice tab's counts (which it
 * polls) never fetch a voice list. Throws the HttpError; returns otherwise.
 */
export async function voiceReady(settings: VoiceSettings, locale: string): Promise<void> {
  const provider = settings.tts;
  keysFor(provider);
  if (provider === "system" && !voiceFor(settings.voices.system?.[locale] ?? {}, "narrator", null)) await defaultVoiceFor(provider, locale, null);
}

/** What /api/voice/sound will say: at most this many characters (one
 *  character, an exemplar, or 媽媽 for the neutral tone), every one a Han
 *  character. Zhuyin and tone marks are heard through exemplar characters
 *  (web/src/script/sounds.ts), never sent: a voice reading a bare symbol
 *  says its name or nothing, and that would be paid for and cached. Keeps
 *  the route a card's sounds, not a general text-to-speech cache on the
 *  owner's credits. */
export const MAX_SOUND_CHARS = 4;
const SOUND_RE = /^\p{Script=Han}+$/u;

/**
 * POST /api/voice/sound {text, locale} → the sound of a character or zhuyin
 * symbol (the character card's readings, its zhuyin and pinyin parts, the
 * sound chart). The narrator's voice for the locale as /speak resolves it
 * outside a session (practiceVoice: the saved voice, else the provider's
 * default), through the on-disk audio cache keyed per user like the
 * practice drill's phrases (practice.ts phraseAudio): the first play pays
 * the provider, every later one is read from disk. Whether it was a hit is
 * logged, never sent. Mounted with wrap's `learner: true`.
 */
export async function handleVoiceSound(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const body = await readJsonBody<Partial<VoiceSoundRequest>>(req);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!isSoundText(text)) {
    throw new HttpError(400, `a sound is 1 to ${MAX_SOUND_CHARS} Chinese characters`);
  }
  const locale = typeof body?.locale === "string" && LOCALE_RE.test(body.locale) ? body.locale : "";
  if (!locale) throw new HttpError(400, "locale must look like es-MX");
  const ctrl = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort();
  };
  res.on("close", onClose);
  try {
    const out = await soundClip(ctx, text, locale, ctrl.signal);
    res.writeHead(200, { "Content-Type": out.type, "Content-Length": out.audio.length, "Cache-Control": "private, no-store" });
    res.end(out.audio);
  } finally {
    res.off("close", onClose);
  }
}

/** Whether `text` is something /api/voice/sound says (1–4 Han characters). */
export function isSoundText(text: string): boolean {
  return !!text && [...text].length <= MAX_SOUND_CHARS && SOUND_RE.test(text);
}

/**
 * A sound's audio as /api/voice/sound serves it: the narrator's voice for
 * `locale` (practiceVoice), through the per-user audio cache, synthesized
 * on a miss in one of the user's paid slots. Also the compare view's model
 * clip on the character card (pronunciation.ts), so both read one file.
 * `text` must already be checked (isSoundText).
 */
export async function soundClip(ctx: LearnerCtx, text: string, locale: string, signal: AbortSignal): Promise<{ key: string; audio: Buffer; type: string; cached: boolean }> {
  const settings = await readVoiceSettings(ctx.user.id);
  const out = await outsideClip(ctx.user.id, settings, locale, text, signal);
  console.log(`[lingo-dojo] sound audio: ${out.cached ? "hit" : "miss"} ${out.key.slice(0, 12)}`);
  return out;
}

/* --------------------------------- library -------------------------------- */

async function handleLibrary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return methodNotAllowed(res, "GET");
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  const locale = q.get("locale") ?? "";
  if (locale && !LOCALE_RE.test(locale)) throw new HttpError(400, "locale must look like es-MX");
  const keys = keysFor("elevenlabs");
  // Cantonese: the library can only be asked for zh, which is Mandarin
  // (elevenLibrarySearchable). No voices beats offering those as Cantonese.
  if (locale && !elevenLibrarySearchable(locale)) return sendJson(res, 200, elevenLibrary({}) satisfies LibraryReply);
  const request = elevenLibraryRequest({
    key: keys.elevenlabs,
    locale,
    gender: q.get("gender") ?? "",
    search: q.get("q") ?? "",
    sort: q.get("sort") ?? "",
    page: Number(q.get("page")) || 0,
  });
  sendJson(res, 200, elevenLibrary(await (await call("elevenlabs", request)).json()) satisfies LibraryReply);
}

/** ElevenLabs cast voices refused this run (marked once a retry in another
 *  voice worked), so later lines go straight to the retry voice and later
 *  casts leave them out. */
const refusedVoices = new Set<string>();

/** A voice named by the client's cast, if it has the provider's shape. It
 *  reaches the provider's API path or `say -v` (spawned without a shell),
 *  so anything else is ignored rather than passed through. */
function castVoice(provider: TtsProvider, v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  if (provider === "elevenlabs") return /^[A-Za-z0-9]{8,64}$/.test(v) ? v : null;
  if (provider === "azure") return AZURE_VOICE_RE.test(v) ? v : null;
  return /^[\p{L}\p{N} ().'_-]{1,100}$/u.test(v) ? v : null;
}

/** How many of the most-used library voices a Random slot draws from: a
 *  wide pick for variety, still voices people actually use. */
const CAST_POOL = 40;
/** Fewer locale-exact library voices than this and the draw widens to the
 *  whole language, so one or two voices don't play every part. */
const CAST_MIN_NATIVE = 4;
type LibVoice = { id: string; name: string; age?: string; exact?: boolean };

/** POST /api/voice/cast {mode, locale, units, ages?, slots?, avoid?} → this
 *  session's voices and narrator gender. Slots the learner set keep their
 *  voice; Random ones draw from native speakers of their gender, and of the
 *  age asked for when the dojo master named one (a CAST line): for
 *  ElevenLabs the Voice Library (usable by id on a paid plan, nothing added
 *  to the account), else the provider's own list for the locale. With
 *  `slots` only those are drawn (a recast mid-session), avoiding `avoid`;
 *  the client then keeps its narrator gender. */
export async function handleVoiceCast(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const body = await readJsonBody<Partial<VoiceCastRequest>>(req);
  const mode = learnerMode(req, ctx, body?.mode ?? undefined);
  const locale = typeof body?.locale === "string" && LOCALE_RE.test(body.locale) ? body.locale : "";
  if (!locale) throw new HttpError(400, "locale must look like es-MX");
  // The learner's own language, from the session's learner (the body's
  // only when the learner has none on file): an old tab that doesn't send
  // it still never draws a third language's voice.
  const nativeLocale = localeFor(ctx.learner.nativeLanguage) ?? (typeof body?.nativeLocale === "string" && LOCALE_RE.test(body.nativeLocale) ? body.nativeLocale : "");
  const all: string[] = voiceSlots(mode, { drill: body?.drill === true });
  const slots = Array.isArray(body?.slots) ? all.filter((x) => (body.slots as unknown[]).includes(x)) : all;
  const ages: Record<string, VoiceAge> = {};
  if (body?.ages && typeof body.ages === "object") {
    for (const [slot, a] of Object.entries(body.ages)) {
      const age = ageOf(a);
      if (all.includes(slot) && age) ages[slot] = age;
    }
  }
  const settings = await readVoiceSettings(ctx.user.id);
  const provider = settings.tts;
  const keys = keysFor(provider);
  const avoid = Array.isArray(body?.avoid) ? (body.avoid as unknown[]).slice(0, 20).map((v) => castVoice(provider, v)).filter((v): v is string => !!v) : [];
  const set: Record<string, string | undefined> = settings.voices[provider]?.[locale] ?? {};
  const names: Record<string, string> = {};
  const voiceAges: Record<string, string> = {};
  const random = slots.filter((x) => !set[x]);
  const recast = Array.isArray(body?.slots);
  // ElevenLabs draws from the Voice Library: one search per gender in play,
  // and one per slot that wants an age. null marks a search that failed
  // (castPools tells it from one that found nothing).
  const library: Record<string, LibVoice[] | null> = {};
  const aged: Record<string, LibVoice[] | null> = {};
  let own: VoiceChoice[] = [];
  // The draw's provider calls (the account's list, the library searches,
  // run side by side) count as one of the user's paid slots (paid.ts): a
  // draw ahead mid-session runs beside the next line's speech. They stop
  // when the browser gives up (the Go tab's 10 s draw timeout, Stop), as
  // /speak's do: otherwise a slow search would keep the slot for up to three
  // provider timeouts in a row, and the next turn's lines would find it taken.
  const ctrl = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort();
  };
  res.on("close", onClose);
  try {
    await paidSlot(
      ctx.user.id,
      async () => {
        // The provider's own list names the voices the learner chose, and is the
        // pool for Azure and macOS (and for ElevenLabs when the library fails).
        if (provider === "elevenlabs") own = elevenVoices(await (await call(provider, elevenVoicesRequest({ key: keys.elevenlabs }), ctrl.signal)).json(), locale, nativeLocale);
        else if (provider === "azure") own = azureVoices(await (await call(provider, azureVoicesRequest({ key: keys.azureKey, region: keys.azureRegion }), ctrl.signal)).json(), locale);
        else own = systemVoices(await sayList(), locale);
        for (const v of own) {
          names[v.id] = v.name;
          if (v.age) voiceAges[v.id] = v.age;
        }
        if (provider === "elevenlabs") {
          // The locale's own speakers first (`exact`: pickCast draws them before
          // any other). A thin search, or a locale the library refuses (400/422),
          // is topped up with every voice of the language (another Mandarin for
          // Taiwanese Mandarin). Never another language: a search that finds
          // nothing leaves the slot to the account's voices. A timeout, a rate
          // limit or a bad key is not retried wider: it would only fail twice.
          const page = async (gender: string, age: VoiceAge | undefined, anyLocale: boolean): Promise<{ voices: LibVoice[] | null; refused: boolean }> => {
            try {
              const r = elevenLibraryRequest({ key: keys.elevenlabs, locale, gender, age, sort: "usage_character_count_1y", pageSize: CAST_POOL, anyLocale });
              const voices = elevenLibrary(await (await call(provider, r, ctrl.signal)).json())
                .voices.filter((v) => !refusedVoices.has(v.id))
                .map((v) => ({ id: v.id, name: v.name, age: ageOf(v.age) }));
              return { voices, refused: false };
            } catch (e) {
              // Given up on: no wider search, no draw (the slot frees now).
              if (ctrl.signal.aborted) throw new HttpError(499, "cancelled");
              const message = String((e as Error)?.message ?? e);
              console.warn(`[voice] library search for ${locale}${anyLocale ? " (any locale)" : ""} failed: ${message}`);
              return { voices: null, refused: /answered (400|422)\b/.test(message) };
            }
          };
          const narrowed = !!elevenLibraryLocale(locale);
          const search = async (gender: string, age?: VoiceAge): Promise<LibVoice[] | null> => {
            // Cantonese: the library has no way to ask for it (elevenLibrarySearchable).
            if (!elevenLibrarySearchable(locale)) return [];
            const first = await page(gender, age, false);
            // Not narrowed to a locale: this already was the whole language.
            if (!narrowed) return first.voices;
            const exact = (first.voices ?? []).map((v) => ({ ...v, exact: true }));
            if (first.voices ? exact.length >= CAST_MIN_NATIVE : !first.refused) return first.voices ? exact : null;
            const wide = (await page(gender, age, true)).voices;
            if (!wide) return first.voices ? exact : null;
            const seen = new Set(exact.map((v) => v.id));
            return [...exact, ...wide.filter((v) => !seen.has(v.id))];
          };
          const genders = [...new Set(random.map((x) => x.split(":")[1]))];
          const wantAge = random.filter((x) => ages[x]);
          await Promise.all([
            ...genders.map(async (g) => (library[g] = await search(g))),
            ...wantAge.map(async (slot) => (aged[slot] = await search(slot.split(":")[1], ages[slot]))),
          ]);
        }
      },
      "voice draws",
    );
  } finally {
    res.off("close", onClose);
  }
  const { pools, omitted } = castPools({ slots, set, ages, library, aged, own, recast, avoid });
  for (const list of Object.values(pools)) for (const v of list) names[v.id] ??= v.name;
  const cast = pickCast({ slots, set, pools, names, ages: voiceAges, avoid });
  for (const slot of omitted) delete cast[slot];
  // ElevenLabs casts from the library, which a plan without library access
  // can't speak with; each slot gets a distinct account voice of its gender
  // (and nearest its age) to fall back on. In a recast `avoid` holds the
  // other slots' voices and fallbacks, which stay theirs.
  const fallbacks = provider === "elevenlabs" ? castFallbacks(own, slots.filter((x) => !omitted.includes(x)), set, { all, ages, taken: recast ? avoid : [] }) : {};
  const pinned = pinnedNarratorGender(Array.isArray(body?.units) ? body.units : []);
  const narratorGender: VoiceGender = pinned ?? (Math.random() < 0.5 ? "female" : "male");
  sendJson(res, 200, { provider, locale, cast, narratorGender, pinned: !!pinned, ...(Object.keys(fallbacks).length ? { fallbacks } : {}) } satisfies VoiceCastReply);
}

/** POST /api/voice/library/add: it adds a voice to the owner's ElevenLabs
 *  account (shared by every login), so it is mounted admin-only. */
export async function handleVoiceLibraryAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (subPath(req)) return sendJson(res, 404, { error: "no such route" });
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const body = await readJsonBody<Partial<LibraryAddRequest>>(req);
  const keys = keysFor("elevenlabs");
  let request;
  try {
    request = elevenAddRequest({ key: keys.elevenlabs, ownerId: String(body?.ownerId ?? ""), voiceId: String(body?.voiceId ?? ""), name: String(body?.name ?? "") });
  } catch (e) {
    throw new HttpError(400, String((e as Error).message));
  }
  const json = (await (await call("elevenlabs", request)).json()) as { voice_id?: unknown };
  const voiceId = typeof json.voice_id === "string" ? json.voice_id : String(body?.voiceId);
  sendJson(res, 200, { voiceId } satisfies LibraryAddReply);
}

/* --------------------------------- routes --------------------------------- */

export async function handleVoice(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const seg = subPath(req);
  if (seg === "settings") return handleSettings(req, res, ctx);
  if (seg === "voices") return handleVoices(req, res);
  if (seg === "speak") return handleSpeak(req, res, ctx);
  if (seg === "library") return handleLibrary(req, res);
  // turn, cast and library/add are mounted on their own paths (api.ts), for
  // their own access checks; they never reach here.
  sendJson(res, 404, { error: "no such route" });
}
