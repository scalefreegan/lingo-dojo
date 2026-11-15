import { spawn } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { assemble } from "../../scripts/assemble.mjs";
import { failureHint, startClaude } from "../../scripts/claude.mjs";
import { REPO_ROOT, loadContent, modeRoot } from "../../scripts/content.mjs";
import {
  ELEVEN_MODELS, MINUTE_CHOICES, SILENCE_MS, SPEAKERS_BY_MODE, TTS_PROVIDERS, VOICE_MODELS, azureSpeechRequest, azureTranscribeRequest, azureVoices,
  azureVoicesRequest, configuredProviders, elevenSpeechRequest, localeFor, elevenTranscribeRequest, keytermsFrom, elevenVoices, elevenVoicesRequest, envFile,
  ageOf, castFallbacks, castPools, parseCast, speechVoices, oneLine, replayLine, REPLAY_MAX_CHARS, replayStage, replayCastNotes, retryInOtherVoice, parseChoices, parseGlosses, parseStage, parseVoiceReply, planDirective, sessionPlan, clockLine, MAX_CHOICES, MAX_GLOSSES, pickCast, pinnedNarratorGender, narratorDirective, AZURE_VOICE_RE, systemVoices, voiceSlots, elevenLibraryRequest, elevenLibrary, elevenAddRequest, transcriptText, voiceKeys, voiceSystemPrompt, voiceTurnPrompt,
} from "../../scripts/voice.mjs";
import type {
  VoiceAge, VoiceCastNote, VoiceCastReply, VoiceCastRequest, VoiceChoice,
  LibraryAddReply, LibraryAddRequest, LibraryReply, SegmentLang, SttProvider, TranscribeReply, VoiceGender, VoiceGloss, TtsProvider, VoiceHistoryItem, VoiceSettings, VoiceSettingsReply, VoiceSettingsRequest,
  VoiceLine, VoiceSpeakRequest, VoiceSpeaker, VoiceTurnReply, VoiceTurnRequest, VoicesReply,
} from "../shared/wire.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";
import { learnerMode, learnerProfile, type Ctx, type LearnerCtx } from "./auth.ts";
import { readVoiceSettings, updateVoiceSettings } from "./store.ts";
import { conversationIdOf, openConversation, saveTurn, takeTurnLock } from "./conversations.ts";

// Voice practice: run a pack as a spoken session inside the app. Four routes,
// one per step of a turn, so the browser can start playing the first line
// while the next is still being synthesized:
//
//   GET/PUT /api/voice/settings      provider, voices per speaker, turn-taking
//   GET     /api/voice/voices        ?provider=&locale= → the provider's voices
//   POST    /api/voice/transcribe    ?locales=a,b  WAV body → {text}
//   POST    /api/voice/turn          {mode, pack, history, message, conversationId?} → {lines}
//   POST    /api/voice/speak         {speaker, gender, text, lang, locale} → audio bytes
//   GET     /api/voice/library       ElevenLabs Voice Library search
//   POST    /api/voice/library/add   add a library voice to the account (admin)
//   POST    /api/voice/cast          this session's voices
//
// turn and cast act for the active learner and language, so api.ts mounts them with
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

async function readAudio(req: IncomingMessage): Promise<Uint8Array> {
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

async function handleTranscribe(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  // The first locale is the target: speech goes in as that language (English
  // can always be typed). Terms are the target phrases the dojo master just
  // used; keytermsFrom trims them to what Scribe accepts.
  const keyterms = keytermsFrom(params.getAll("term").slice(0, 200));
  const locales = (params.get("locales") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => LOCALE_RE.test(s));
  const audio = await readAudio(req);
  const provider = (await readVoiceSettings(ctx.user.id)).stt;
  const keys = keysFor(provider);
  const mime = String(req.headers["content-type"] || "audio/wav").split(";")[0];
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
    sendJson(res, 200, { text: transcriptText(provider, json), provider } satisfies TranscribeReply);
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
          ? (line.segments as { lang?: unknown; text?: unknown }[])
              .filter((g) => (g?.lang === "target" || g?.lang === "native") && typeof g.text === "string")
              .map((g) => ({ lang: g.lang as SegmentLang, text: oneLine(g.text as string).slice(0, 4000) }))
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
        ? (m.glosses as { term?: unknown; meaning?: unknown }[])
            .filter((g) => typeof g?.term === "string" && typeof g.meaning === "string")
            .slice(0, MAX_GLOSSES)
            .map((g) => ({ term: oneLine(g.term as string).slice(0, 200), meaning: oneLine(g.meaning as string).slice(0, 300) }))
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
  try {
    // A saved conversation must be this learner's and still open (else a 404
    // or 409 whose code sends the Go tab to start a new one), checked before
    // anything runs. Its part of the history starts at conversationStart.
    const conversation = conversationId ? await openConversation(ctx.user.id, ctx.language, conversationId) : null;
    // The active learner and language are the profile (content.profile is the file's).
    const content = { ...loadContent(modeRoot(mode)), profile: learnerProfile(ctx.learner, ctx.language) };
    const { markdown, warnings } = assemble(content, body.pack, mode);
    // The session's parts, for the timeline: named to the dojo master, which
    // reports where it is with a STAGE line each turn.
    const plan = sessionPlan(content, body.pack, mode);
    const settings = await readVoiceSettings(ctx.user.id);
    // With a time budget (the pack's minutes, plus any +5 min the browser
    // added), one clock line: the browser's elapsed time since the first
    // turn, and the part the last turn ended in. No budget, no line.
    let lastStage: string | null = null;
    for (const m of history) if (m.role === "master" && m.stage) lastStage = m.stage;
    const clock = clockLine({ minutes: body.pack.overrides?.minutes, elapsedMs: body.elapsedMs, plan, stage: lastStage, mode });
    const { result } = startClaude({
      prompt: voiceTurnPrompt(history, message, clock),
      // The session's narrator gender, drawn by the client at session start,
      // unless the pack's own narrator unit fixes it.
      systemPrompt:
        voiceSystemPrompt(markdown, mode) +
        (pinnedNarratorGender(body.pack.units) ? "" : narratorDirective(body.narratorGender)) +
        planDirective(plan),
      model: settings.model,
      // No tools, so no file access is needed: an empty temp cwd keeps the
      // repo's CLAUDE.md (instructions for coding agents) out of the turn.
      cwd: os.tmpdir(),
      signal: ctrl.signal,
      tools: "none",
      maxTurns: 1,
      timeoutSec: 120,
    });
    let run;
    try {
      run = await result;
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      throw new HttpError(msg === "cancelled" ? 499 : 502, failureHint(msg) || msg);
    }
    const lines = parseVoiceReply(run.text, mode);
    if (!lines.length) throw new HttpError(502, "the dojo master's reply had nothing to say aloud");
    const reply: VoiceTurnReply = { lines, glosses: parseGlosses(run.text), choices: parseChoices(run.text), plan, stage: parseStage(run.text, plan.map((p) => p.id)), castNotes: parseCast(run.text, mode), model: settings.model, durationMs: run.durationMs, costUsd: run.costUsd, warnings };
    if (conversation) {
      // Stored before the reply goes out, still under the lock. A failed
      // write doesn't cost the learner a reply that's already paid for: the
      // turn stands, unsaved, and the panel says so.
      const master = {
        role: "master" as const, lines, glosses: reply.glosses, choices: reply.choices, ...(reply.stage ? { stage: reply.stage } : {}), castNotes: reply.castNotes,
        durationMs: run.durationMs, costUsd: run.costUsd,
      };
      reply.saved = await saveTurn(ctx.language, conversation.id, { screen: all.slice(from), message, master, pack: body.pack, model: settings.model }).catch((e) => {
        console.error(`[lingo-dojo] saving a turn of conversation ${conversation.id}:`, e);
        return false;
      });
    }
    sendJson(res, 200, reply);
  } finally {
    release();
    res.off("close", onClose);
  }
}

/* ---------------------------------- speak --------------------------------- */

/** macOS `say` into a WAV the browser can play (it writes AIFF by default,
 *  which Chrome cannot). The text goes in on stdin, never argv, so a line
 *  starting with "-" is still just words. */
function sayToWav(text: string, voice: string, signal: AbortSignal): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-say-"));
  const out = path.join(dir, "line.wav");
  const args = ["--file-format=WAVE", "--data-format=LEI16@24000", "-o", out];
  if (voice) args.unshift("-v", voice);
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
  const nativeLocale = typeof body?.nativeLocale === "string" && LOCALE_RE.test(body.nativeLocale) ? body.nativeLocale : "";
  const textLocale = lang === "native" && nativeLocale ? nativeLocale : locale;
  const speaker = body?.speaker;
  if (typeof speaker !== "string" || !["narrator", "character", "sidekick"].includes(speaker)) {
    throw new HttpError(400, "speaker must be narrator, character or sidekick");
  }
  const settings = await readVoiceSettings(ctx.user.id);
  const provider = settings.tts;
  const keys = keysFor(provider);
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
  const { first, retry } = speechVoices({ set: settings.voices[provider]?.[locale] ?? {}, speaker, gender, cast, fallback, refused: refusedVoices });
  const voice = first;
  if (!voice && provider !== "system") throw new HttpError(400, `pick a ${NAMES[provider]} voice for ${speaker} first`);

  const ctrl = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort();
  };
  res.on("close", onClose);
  try {
    let audio: Buffer;
    let type = "audio/mpeg";
    if (provider === "elevenlabs") {
      let r;
      // A cast voice refused once goes straight to the retry voice after
      // that (speechVoices), so a free plan doesn't pay two calls a line.
      try {
        r = await call(provider, elevenSpeechRequest({ key: keys.elevenlabs, voice: first, text, model: settings.elevenModel, locale: textLocale }), ctrl.signal);
      } catch (e) {
        // A library voice drawn for the cast can be refused: a plan without
        // library access, or a voice since removed. retryInOtherVoice takes
        // the statuses that mean "not this voice" (400, 402, 403, 404, 422),
        // not a bad key, spent credits or a rate limit. Say the line in the
        // retry voice (speechVoices) rather than lose it.
        const status = Number(String((e as Error)?.message).match(/answered (\d{3})\b/)?.[1]);
        if (!cast || !retry || !retryInOtherVoice(status)) throw e;
        r = await call(provider, elevenSpeechRequest({ key: keys.elevenlabs, voice: retry, text, model: settings.elevenModel, locale: textLocale }), ctrl.signal);
        // The other voice worked, so it was the cast voice: skip it from now on.
        if (refusedVoices.size >= 200) refusedVoices.clear();
        refusedVoices.add(cast);
      }
      audio = Buffer.from(await r.arrayBuffer());
    } else if (provider === "azure") {
      let request;
      try {
        request = azureSpeechRequest({ key: keys.azureKey, region: keys.azureRegion, voice, text, locale: textLocale });
      } catch (e) {
        throw new HttpError(400, String((e as Error).message));
      }
      audio = Buffer.from(await (await call(provider, request, ctrl.signal)).arrayBuffer());
    } else {
      audio = await sayToWav(text, voice, ctrl.signal);
      type = "audio/wav";
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": audio.length, "Cache-Control": "no-store" });
    res.end(audio);
  } finally {
    res.off("close", onClose);
  }
}

/* --------------------------------- library -------------------------------- */

async function handleLibrary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return methodNotAllowed(res, "GET");
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  const locale = q.get("locale") ?? "";
  if (locale && !LOCALE_RE.test(locale)) throw new HttpError(400, "locale must look like es-MX");
  const keys = keysFor("elevenlabs");
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
type LibVoice = { id: string; name: string; age?: string };

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
  const all: string[] = voiceSlots(mode);
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
  // The provider's own list names the voices the learner chose, and is the
  // pool for Azure and macOS (and for ElevenLabs when the library fails).
  let own: VoiceChoice[] = [];
  if (provider === "elevenlabs") own = elevenVoices(await (await call(provider, elevenVoicesRequest({ key: keys.elevenlabs }))).json(), locale);
  else if (provider === "azure") own = azureVoices(await (await call(provider, azureVoicesRequest({ key: keys.azureKey, region: keys.azureRegion }))).json(), locale);
  else own = systemVoices(await sayList(), locale);
  for (const v of own) {
    names[v.id] = v.name;
    if (v.age) voiceAges[v.id] = v.age;
  }
  const random = slots.filter((x) => !set[x]);
  const recast = Array.isArray(body?.slots);
  // ElevenLabs draws from the Voice Library: one search per gender in play,
  // and one per slot that wants an age. null marks a search that failed
  // (castPools tells it from one that found nothing).
  const library: Record<string, LibVoice[] | null> = {};
  const aged: Record<string, LibVoice[] | null> = {};
  if (provider === "elevenlabs") {
    const search = async (gender: string, age?: VoiceAge): Promise<LibVoice[] | null> => {
      try {
        const r = elevenLibraryRequest({ key: keys.elevenlabs, locale, gender, age, sort: "usage_character_count_1y", pageSize: CAST_POOL });
        return elevenLibrary(await (await call(provider, r)).json())
          .voices.filter((v) => !refusedVoices.has(v.id))
          .map((v) => ({ id: v.id, name: v.name, age: ageOf(v.age) }));
      } catch {
        return null;
      }
    };
    const genders = [...new Set(random.map((x) => x.split(":")[1]))];
    const wantAge = random.filter((x) => ages[x]);
    await Promise.all([
      ...genders.map(async (g) => (library[g] = await search(g))),
      ...wantAge.map(async (slot) => (aged[slot] = await search(slot.split(":")[1], ages[slot]))),
    ]);
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
  if (seg === "transcribe") return handleTranscribe(req, res, ctx);
  if (seg === "speak") return handleSpeak(req, res, ctx);
  if (seg === "library") return handleLibrary(req, res);
  // turn, cast and library/add are mounted on their own paths (api.ts), for
  // their own access checks; they never reach here.
  sendJson(res, 404, { error: "no such route" });
}
