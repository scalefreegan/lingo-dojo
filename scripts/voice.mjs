// Voice practice: the pure half. The app runs a pack as a spoken session in a
// push-to-talk loop — the browser records the learner, a speech-to-text
// provider transcribes it, a tool-less headless Claude answers as the dojo
// master in speaker-tagged lines, and a text-to-speech provider speaks each
// line in that speaker's voice. web/server/voice.ts does the I/O; everything
// here is string-in, string-out so `node --test` pins it without a network.
//
// Why a cascade and not a speech-to-speech model (OpenAI Realtime, Gemini
// Live): those give a handful of fixed voices, one per session, that drift
// toward a neutral accent when they mix languages. A dedicated TTS provider
// lets every speaker the frame names (narrator, character, the kids'
// sidekick) have its own native-speaker voice, and a learner-driven "send"
// means a thinking pause is never mistaken for the end of a turn.

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./content.mjs";

/* ------------------------------- providers -------------------------------- */

/** Text-to-speech providers. "system" is macOS `say`: free, offline, and the
 *  way to try the loop before signing up for anything. */
export const TTS_PROVIDERS = ["elevenlabs", "azure", "system"];
/** Speech-to-text providers. `say` has no recognizer to pair with. */
export const STT_PROVIDERS = ["elevenlabs", "azure"];

/** ElevenLabs synthesis models (the ElevenLabs skills' table, 2026-11).
 *  Eleven v4 is the default: their highest quality, and it takes a
 *  language_code that steers pronunciation, which is the whole point here. */
export const ELEVEN_MODELS = [
  { id: "eleven_v4", label: "Eleven v4", note: "best quality and accent, the default" },
  { id: "eleven_flash_v2_5", label: "Flash v2.5", note: "fastest, about half the price" },
  { id: "eleven_multilingual_v2", label: "Multilingual v2", note: "previous generation" },
  { id: "eleven_v3", label: "Eleven v3", note: "previous generation, expressive" },
];
export const DEFAULT_ELEVEN_MODEL = "eleven_v4";

/** Models offered for the dojo master's turns. A turn is one tool-less reply,
 *  ~3.7 s wall for Haiku and Sonnet alike (measured 2026-11-09), so Sonnet's
 *  better teaching costs no latency. */
export const VOICE_MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "the default" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", note: "cheapest" },
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "deeper, slower" },
];
export const DEFAULT_VOICE_MODEL = "claude-sonnet-5-5";

/* -------------------------------- speakers -------------------------------- */

/** The voices each mode's frame names (content/frame.md, content/kids/
 *  frame.md), in the order the UI lists them. */
export const SPEAKERS_BY_MODE = {
  adult: ["narrator", "character"],
  kids: ["narrator", "sidekick", "character"],
};

export function speakersFor(mode) {
  return SPEAKERS_BY_MODE[mode] ?? SPEAKERS_BY_MODE.adult;
}

/* --------------------------------- locales -------------------------------- */

// languages.yaml names languages and variants in prose ("Mexican Spanish
// (Oaxaca)"); the providers want BCP-47. A language maps to its default
// locale, and a variant overrides it when one of its keywords appears in the
// variant's name. A test checks every language in content/languages.yaml
// resolves, so a new language there fails loudly rather than silently
// speaking with the wrong locale.
const LOCALES = {
  english: ["en-US", [["british", "en-GB"], ["australian", "en-AU"]]],
  spanish: ["es-MX", [["castilian", "es-ES"], ["spain", "es-ES"], ["argentin", "es-AR"], ["colombia", "es-CO"]]],
  french: ["fr-FR", [["québ", "fr-CA"], ["queb", "fr-CA"], ["canad", "fr-CA"]]],
  german: ["de-DE", [["austria", "de-AT"], ["swiss", "de-CH"]]],
  italian: ["it-IT", []],
  portuguese: ["pt-BR", [["european", "pt-PT"], ["portugal", "pt-PT"]]],
  japanese: ["ja-JP", []],
  "mandarin chinese": ["zh-CN", [["taiwan", "zh-TW"]]],
  mandarin: ["zh-CN", [["taiwan", "zh-TW"]]],
  chinese: ["zh-CN", [["taiwan", "zh-TW"]]],
  cantonese: ["zh-HK", []],
  korean: ["ko-KR", []],
  dutch: ["nl-NL", [["flemish", "nl-BE"], ["belgi", "nl-BE"]]],
  russian: ["ru-RU", []],
  arabic: ["ar-SA", [["egypt", "ar-EG"], ["levant", "ar-LB"], ["morocc", "ar-MA"]]],
  hindi: ["hi-IN", []],
  greek: ["el-GR", []],
  swedish: ["sv-SE", []],
};

const BCP47_RE = /^[a-z]{2,3}-[A-Z]{2}$/;

/** The BCP-47 locale for a language and optional variant, or null when the
 *  language is unknown. A variant that already is a locale ("es-MX", the
 *  scenario `language` field's form) is taken as-is. */
export function localeFor(language, variant = "") {
  const v = String(variant ?? "").trim();
  if (BCP47_RE.test(v)) return v;
  const entry = LOCALES[String(language ?? "").trim().toLowerCase()];
  if (!entry) return BCP47_RE.test(String(language ?? "").trim()) ? String(language).trim() : null;
  const [fallback, overrides] = entry;
  const lower = v.toLowerCase();
  for (const [keyword, locale] of overrides) if (lower.includes(keyword)) return locale;
  return fallback;
}

/** The language half of a locale, for the providers that want ISO 639-1. */
export function languageOf(locale) {
  return String(locale ?? "").split("-")[0].toLowerCase();
}

/* ---------------------------------- keys ---------------------------------- */

/** Where the provider keys live: LINGO_ENV_FILE when set (tests point it at
 *  nothing), else <repo>/.env.local — gitignored by both `.env.*` and
 *  `*.local`. A file rather than the shell environment because the Dock app
 *  starts the server without the user's shell profile. */
export function envFile() {
  const override = process.env.LINGO_ENV_FILE;
  return override ? path.resolve(REPO_ROOT, override) : path.join(REPO_ROOT, ".env.local");
}

/** KEY=VALUE lines; `#` comments, blank lines, an `export ` prefix and one
 *  layer of matching quotes are tolerated. Nothing is interpolated. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}

/** The provider credentials: the env file under the process environment (a
 *  variable set in the shell wins). Read per call, like every other file the
 *  server reads, so adding a key needs no restart. */
export function voiceKeys(env = process.env, file = envFile()) {
  let fromFile = {};
  try {
    fromFile = parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    /* no file: keys may still come from the environment */
  }
  const get = (k) => (env[k] || fromFile[k] || "").trim();
  return {
    elevenlabs: get("ELEVENLABS_API_KEY"),
    azureKey: get("AZURE_SPEECH_KEY"),
    azureRegion: get("AZURE_SPEECH_REGION"),
  };
}

/** Which providers can run: a key (and, for Azure, a region) is present; the
 *  system voice needs macOS. */
export function configuredProviders(keys, platform = process.platform) {
  return {
    elevenlabs: !!keys.elevenlabs,
    azure: !!(keys.azureKey && keys.azureRegion),
    system: platform === "darwin",
  };
}

/* -------------------------------- the prompt ------------------------------- */

const TAG = { narrator: "NARRATOR", character: "CHARACTER", sidekick: "SIDEKICK" };

/** What the dojo master is told about this delivery, appended after the
 *  assembled pack. It is transport, not teaching: the pack still decides what
 *  happens in the session; this only fixes the shape of the text so each line
 *  can go to the right voice. */
export function voiceAdapter(mode = "adult") {
  const speakers = speakersFor(mode);
  const tags = speakers.map((s) => `${TAG[s]}:`).join(", ");
  const who = mode === "kids"
    ? "NARRATOR is you guiding, SIDEKICK is the helper character, CHARACTER is whoever the scene brings in"
    : "NARRATOR is you stepping out of the scene to guide, CHARACTER is whoever the learner talks to inside the scene";
  return `## How this session is delivered

This session runs inside Lingo Dojo, not a live voice app. Each of your turns is turned into speech line by line, and every speaker has its own native-speaker voice, so the voices, accents and pronunciation are handled for you. What you write is exactly what is spoken.

- Start every line with a speaker tag: ${tags} (${who}). One speaker per line; begin a new line whenever the speaker changes. Never put a tag in the middle of a line.
- Write only words to be spoken aloud: no markdown, lists, emoji, stage directions, or descriptions of tone or actions in brackets or asterisks.
- Mark the language of every word you say. Wrap everything spoken in the target language in <t>…</t> — a single word, a phrase, or a whole line — and leave everything in the learner's native language unwrapped. Each piece is then pronounced in its own language by the same voice, so a target word left unwrapped gets mispronounced and an English word inside <t> gets mangled. Examples:
  NARRATOR: The word for tomato here is <t>jitomate</t>. Try asking for a kilo: <t>un kilo de jitomates, por favor</t>.
  CHARACTER: <t>¡Claro que sí, güero! ¿Algo más?</t>
- Inside <t>, write the target language in its normal script (Chinese characters for Mandarin, kana and kanji for Japanese, and so on), not a romanization, so it is pronounced natively. Add a romanization only when you are explicitly teaching it, and leave that romanization outside <t>.
- Keep each turn short, then stop and wait for the learner.
- The learner's words reach you as a speech-recognition transcript. It can mishear, and it often quietly fixes pronunciation, so you cannot judge how something sounded — only what was said. If a transcript looks garbled, ask the learner to say it again rather than guessing.
- The first message is "[session start]": open the session the way your instructions say.`;
}

/** The system prompt for a voice turn: the pack as assembled, then the
 *  delivery adapter. */
export function voiceSystemPrompt(markdown, mode = "adult") {
  return `${String(markdown).trim()}\n\n${voiceAdapter(mode)}\n`;
}

export const SESSION_START = "[session start]";

/** The transcript replayed as the prompt (the chat agent's pattern): the
 *  learner's lines as heard, the dojo master's as the tagged lines spoken —
 *  with their <t> marks put back, so the model keeps seeing the format. */
export function voiceTurnPrompt(history, message) {
  const render = (m) => m.role === "learner"
    ? `[LEARNER]\n${m.text}`
    : `[DOJO MASTER]\n${(m.lines ?? []).map((l) => `${TAG[l.speaker] ?? "NARRATOR"}: ${markedText(l)}`).join("\n")}`;
  const prior = history.length ? `Session so far:\n\n${history.map(render).join("\n\n")}\n\n---\n\n` : "";
  const said = String(message ?? "").trim() || SESSION_START;
  return `${prior}[LEARNER]\n${said}\n\n[DOJO MASTER]\nReply as the dojo master, in tagged lines only.`;
}

/* ------------------------------ the reply side ----------------------------- */

const TAG_RE = /^\s*(?:\*\*)?\s*(NARRATOR|CHARACTER|SIDEKICK|HELPER)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*/i;

/** Strip what a voice would read out but a person would not say: markdown
 *  emphasis and headings, bullets, bracketed or starred stage directions. */
export function speakable(text) {
  return String(text)
    .replace(/\[[^\]]*\]/g, " ")
    // **bold** keeps its words; a lone *aside* is a stage direction and goes.
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*[^*\n]+\*/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Segments back into one display string: a space between pieces, except
 *  before closing punctuation ("jitomate." not "jitomate ."). */
export function joinSegments(segments) {
  return segments.reduce((acc, g, i) => (i === 0 || /^[.,;:!?)\]»…]/.test(g.text) ? acc + g.text : `${acc} ${g.text}`), "");
}

/** A line back in the model's own notation: target segments in <t>. */
export function markedText(line) {
  const segs = Array.isArray(line?.segments) && line.segments.length ? line.segments : [{ lang: "native", text: line?.text ?? "" }];
  return segs.map((g) => (g.lang === "target" ? `<t>${g.text}</t>` : g.text)).join(" ");
}

/** One line's text → language segments. <t>…</t> is the target language;
 *  an unclosed <t> runs to the end of the line (a model that forgets to close
 *  a whole-line wrap still gets it right). Each segment is made speakable;
 *  empty ones drop. */
export function splitSegments(text) {
  const out = [];
  const push = (lang, raw) => {
    const said = speakable(raw);
    if (said) out.push({ lang, text: said });
  };
  const re = /<t>([\s\S]*?)(?:<\/t>|$)/gi;
  let last = 0;
  for (const m of String(text).matchAll(re)) {
    push("native", String(text).slice(last, m.index));
    push("target", m[1]);
    last = m.index + m[0].length;
  }
  push("native", String(text).slice(last).replace(/<\/?t>/gi, " "));
  return out;
}

/** The model's reply as `{speaker, text, segments}` lines, in order. An
 *  untagged line continues the speaker before it (narrator at the top); a
 *  speaker the mode doesn't have falls back to the narrator; consecutive
 *  lines by the same speaker merge, and so do adjacent segments in the same
 *  language — each segment is one synthesis call. */
export function parseVoiceReply(text, mode = "adult") {
  const allowed = new Set(speakersFor(mode));
  const out = [];
  let current = "narrator";
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let line = raw;
    const m = raw.match(TAG_RE);
    if (m) {
      const tag = m[1].toLowerCase() === "helper" ? "sidekick" : m[1].toLowerCase();
      current = allowed.has(tag) ? tag : "narrator";
      line = raw.slice(m[0].length);
    }
    const segments = splitSegments(line);
    if (!segments.length) continue;
    let target = out[out.length - 1];
    if (!target || target.speaker !== current) {
      target = { speaker: current, text: "", segments: [] };
      out.push(target);
    }
    for (const g of segments) {
      const prev = target.segments[target.segments.length - 1];
      if (prev && prev.lang === g.lang) prev.text = `${prev.text} ${g.text}`;
      else target.segments.push({ ...g });
    }
    target.text = joinSegments(target.segments);
  }
  return out;
}

/* ------------------------------ request shapes ----------------------------- */

// Each provider call as {url, init}: pure, so the tests pin exactly what goes
// over the wire (and that the key goes only in a header) without a network.

export function elevenSpeechRequest({ key, voice, text, model = DEFAULT_ELEVEN_MODEL, locale }) {
  const body = { text, model_id: model };
  // language_code steers pronunciation and number reading toward the target
  // language. Multilingual v2 rejects it; the others take it.
  if (locale && model !== "eleven_multilingual_v2") body.language_code = languageOf(locale);
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
    init: {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify(body),
    },
  };
}

export function elevenVoicesRequest({ key }) {
  return {
    url: "https://api.elevenlabs.io/v2/voices?page_size=100",
    init: { method: "GET", headers: { "xi-api-key": key } },
  };
}

/** Scribe auto-detects the language, which is what a learner switching
 *  between English and the target language mid-sentence needs. */
export function elevenTranscribeRequest({ key, audio, mime = "audio/wav" }) {
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("tag_audio_events", "false");
  form.append("file", new Blob([audio], { type: mime }), "turn.wav");
  return {
    url: "https://api.elevenlabs.io/v1/speech-to-text",
    init: { method: "POST", headers: { "xi-api-key": key }, body: form },
  };
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

/** Azure voice short names: `zh-CN-XiaoxiaoMultilingualNeural`, and the HD
 *  ones with a colon (`en-US-Ava:DragonHDLatestNeural`). */
export const AZURE_VOICE_RE = /^[A-Za-z]{2,3}-[A-Za-z0-9]{2,4}-[A-Za-z0-9:]+$/;

/** `locale` is the language this text is in. A multilingual voice speaks
 *  it inside <lang> (same voice, that language's pronunciation); any other
 *  voice speaks only its own language, so the text goes in as-is. */
export function azureSsml({ voice, text, locale }) {
  if (!AZURE_VOICE_RE.test(voice)) throw new Error(`not an Azure voice name: ${JSON.stringify(voice)}`);
  const own = voice.split("-").slice(0, 2).join("-");
  const body = xmlEscape(text);
  const inner = locale && BCP47_RE.test(locale) && locale !== own && /Multilingual/i.test(voice)
    ? `<lang xml:lang="${locale}">${body}</lang>`
    : body;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${own}"><voice name="${voice}">${inner}</voice></speak>`;
}

const REGION_RE = /^[a-z0-9]+$/;
function region(r) {
  if (!REGION_RE.test(r)) throw new Error(`AZURE_SPEECH_REGION must be a region name like "eastus", got ${JSON.stringify(r)}`);
  return r;
}

export function azureSpeechRequest({ key, region: r, voice, text, locale }) {
  return {
    url: `https://${region(r)}.tts.speech.microsoft.com/cognitiveservices/v1`,
    init: {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
        "User-Agent": "lingo-dojo",
      },
      body: azureSsml({ voice, text, locale }),
    },
  };
}

export function azureVoicesRequest({ key, region: r }) {
  return {
    url: `https://${region(r)}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    init: { method: "GET", headers: { "Ocp-Apim-Subscription-Key": key } },
  };
}

/** Fast transcription with both session languages as candidates, so a reply
 *  that mixes them is recognized rather than forced into one. */
export function azureTranscribeRequest({ key, region: r, audio, locales, mime = "audio/wav" }) {
  const form = new FormData();
  form.append("audio", new Blob([audio], { type: mime }), "turn.wav");
  const uniq = [...new Set((locales ?? []).filter((l) => BCP47_RE.test(l)))];
  form.append("definition", JSON.stringify({ locales: uniq }));
  return {
    url: `https://${region(r)}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15`,
    init: { method: "POST", headers: { "Ocp-Apim-Subscription-Key": key }, body: form },
  };
}

/* ----------------------------- reply parsing ------------------------------- */

/** ElevenLabs /v2/voices → the picker's shape. Nearly every voice is
 *  "verified" in a dozen languages (the multilingual models can speak them),
 *  so that list says nothing about accent; a voice counts as a native speaker
 *  only when its primary `labels.language` is the target. Natives verified
 *  in the exact locale (es-MX, not just es) come first. */
export function elevenVoices(json, locale) {
  const lang = languageOf(locale);
  const voices = Array.isArray(json?.voices) ? json.voices : [];
  const rows = voices
    .filter((v) => v && typeof v.voice_id === "string")
    .map((v) => {
      const labels = v.labels ?? {};
      const verified = Array.isArray(v.verified_languages) ? v.verified_languages : [];
      const native = String(labels.language ?? "").toLowerCase() === lang;
      const exact = native && verified.some((x) => x?.locale === locale);
      return {
        row: {
          id: v.voice_id,
          name: String(v.name ?? v.voice_id),
          gender: labels.gender ? String(labels.gender) : "",
          note: [labels.accent || "", labels.descriptive || labels.description || "", v.category === "premade" ? "premade" : ""].filter(Boolean).join(" · "),
          match: native,
        },
        rank: (native ? 1 : 0) + (exact ? 1 : 0),
      };
    });
  return rows.sort((a, b) => b.rank - a.rank || a.row.name.localeCompare(b.row.name)).map((r) => r.row);
}

/** Azure voices/list → the picker's shape: voices whose primary or secondary
 *  locale is the target, multilingual ones first (they keep the accent when
 *  the dojo master switches to the learner's language). */
export function azureVoices(json, locale) {
  const list = Array.isArray(json) ? json : [];
  const rows = list
    .filter((v) => v && typeof v.ShortName === "string")
    .filter((v) => v.Locale === locale || (Array.isArray(v.SecondaryLocaleList) && v.SecondaryLocaleList.includes(locale)))
    .map((v) => ({
      id: v.ShortName,
      name: `${v.LocalName && v.LocalName !== v.DisplayName ? `${v.DisplayName} (${v.LocalName})` : v.DisplayName ?? v.ShortName}`,
      gender: v.Gender ? String(v.Gender) : "",
      note: [v.Locale, /Multilingual/i.test(v.ShortName) ? "multilingual" : "", v.VoiceType && v.VoiceType !== "Neural" ? v.VoiceType : ""].filter(Boolean).join(" · "),
      match: v.Locale === locale,
    }));
  const rank = (r) => (r.match ? 2 : 0) + (/multilingual/.test(r.note) ? 1 : 0);
  return rows.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
}

/** `say -v '?'` → the picker's shape for one locale. Lines look like
 *  `Tingting             zh_CN    # 你好！我叫婷婷。`; names can hold spaces and
 *  parentheses ("Eddy (Chinese (China mainland))"). */
export function systemVoices(text, locale) {
  const want = String(locale ?? "").replace("-", "_");
  const rows = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#\s?(.*)$/);
    if (!m || m[2] !== want) continue;
    rows.push({ id: m[1].trim(), name: m[1].trim(), gender: "", note: m[3].trim(), match: true });
  }
  return rows;
}

/** A provider's transcription reply → text. */
export function transcriptText(provider, json) {
  if (provider === "elevenlabs") return typeof json?.text === "string" ? json.text.trim() : "";
  const phrases = Array.isArray(json?.combinedPhrases) ? json.combinedPhrases : [];
  return phrases.map((p) => (typeof p?.text === "string" ? p.text : "")).join(" ").trim();
}

/* --------------------------------- settings -------------------------------- */

export const SILENCE_MS = { min: 500, max: 5000, default: 1600 };

/** Voice settings with every field present and in range, whatever was on
 *  disk: a stale or hand-edited data/voice.json can never put the loop in a
 *  state the UI can't show. `voices` is provider → locale → speaker → id, so
 *  a Mandarin voice choice survives switching to a Spanish pack and back. */
export function normalizeVoiceSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const voices = {};
  for (const p of TTS_PROVIDERS) {
    const byLocale = r.voices?.[p];
    if (!byLocale || typeof byLocale !== "object") continue;
    for (const [loc, bySpeaker] of Object.entries(byLocale)) {
      if (!BCP47_RE.test(loc) || !bySpeaker || typeof bySpeaker !== "object") continue;
      for (const [s, id] of Object.entries(bySpeaker)) {
        if (!(s in TAG) || typeof id !== "string" || !id.trim() || id.length > 200) continue;
        ((voices[p] ??= {})[loc] ??= {})[s] = id.trim();
      }
    }
  }
  const ms = Number(r.silenceMs);
  return {
    tts: pick(r.tts, TTS_PROVIDERS, "elevenlabs"),
    stt: pick(r.stt, STT_PROVIDERS, "elevenlabs"),
    elevenModel: pick(r.elevenModel, ELEVEN_MODELS.map((m) => m.id), DEFAULT_ELEVEN_MODEL),
    model: pick(r.model, VOICE_MODELS.map((m) => m.id), DEFAULT_VOICE_MODEL),
    turn: pick(r.turn, ["tap", "pause"], "tap"),
    silenceMs: Number.isFinite(ms) ? Math.min(SILENCE_MS.max, Math.max(SILENCE_MS.min, Math.round(ms))) : SILENCE_MS.default,
    review: typeof r.review === "boolean" ? r.review : true,
    handsFree: typeof r.handsFree === "boolean" ? r.handsFree : false,
    voices,
  };
}
