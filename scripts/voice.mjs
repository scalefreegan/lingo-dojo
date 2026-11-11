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
  const tags = speakers.map((s) => `${TAG[s]}-F:`).join(", ");
  const who = mode === "kids"
    ? "NARRATOR is you guiding, SIDEKICK is the helper character, CHARACTER is whoever the scene brings in"
    : "NARRATOR is you stepping out of the scene to guide, CHARACTER is whoever the learner talks to inside the scene";
  return `## How this session is delivered

This session runs inside Lingo Dojo, not a live voice app. Each of your turns is turned into speech line by line, and every speaker has its own native-speaker voice, a woman's or a man's, so the voices, accents and pronunciation are handled for you. What you write is exactly what is spoken.

- Start every line with a speaker tag that also says whose voice it is: -F for a woman, -M for a man, e.g. ${tags} (${who}). Take the gender from your instructions and the scenario's roles (a Señora is -F, a Don is -M), keep each person's gender for the whole session, and give a new person in the scene their own. The tags are read by the app, not spoken: never say a tag out loud. One speaker per line; begin a new line whenever the speaker changes. Never put a tag in the middle of a line.
- Timing between lines is yours to set. There is always a short pause between lines, and a longer one whenever the narrator and the scene hand over. To change it, start a line with <pause N> (wait N seconds first, e.g. <pause 1.5> for a beat before a reply, or while a vendor weighs the tomatoes) or <overlap N> (start N seconds before the previous line ends, for people talking over each other or cutting in, at most 1.5). Use them in the scene where the moment calls for it; most lines need neither. Never overlap the narrator.
  <pause 1.2> CHARACTER-M: <t>Mmm… a ver, déjeme pesarlos.</t>
  <overlap 0.4> CHARACTER-F: <t>¡Oiga, yo estaba primero!</t>
- Write only words to be spoken aloud: no markdown, lists, emoji, stage directions, or descriptions of tone or actions in brackets or asterisks.
- Mark the language of every word you say. Wrap everything spoken in the target language in <t>…</t> — a single word, a phrase, or a whole line — and leave everything in the learner's native language unwrapped. Each piece is then pronounced in its own language by the same voice, so a target word left unwrapped gets mispronounced and an English word inside <t> gets mangled. Examples:
  NARRATOR-F: The word for tomato here is <t>jitomate</t>. Try asking for a kilo: <t>un kilo de jitomates, por favor</t>.
  CHARACTER-M: <t>¡Claro que sí, güero! ¿Algo más?</t>
- Inside <t>, write the target language in its normal script (Chinese characters for Mandarin, kana and kanji for Japanese, and so on), not a romanization, so it is pronounced natively. Add a romanization only when you are explicitly teaching it, and leave that romanization outside <t>.
- End every turn that has any target language with one GLOSS line, so the learner can tap a phrase to see what it means. It is shown, not spoken, and needs no speaker tag: GLOSS: then entries separated by " | ", each the target-language text exactly as you wrote it inside <t>, " = ", and its meaning in the learner's native language, a few words. Give each whole target-language sentence a natural translation, then the key words or set phrases in it that are new or matter for this scene (at most six of those), with a short note where it helps (a regional word, a polite form). Skip words already glossed earlier in the session. For example:
  GLOSS: ¡Claro que sí, güero! ¿Algo más? = Of course, blondie! Anything else? | güero = blondie, a friendly nickname for a light-skinned person | ¿Algo más? = Anything else?
- When someone speaks for the first time, and whenever a different person takes over a voice tag (a new vendor, the grandson arriving), write one CAST line just before their first line: the tag, how old they are (child, young, middle-aged or old), and a few words on who they are. The app picks a voice of that age. It is shown, not spoken. For example:
  CAST: CHARACTER-F old, Doña Carmen, the fruit vendor
- CAST lines go just before the line they introduce; GLOSS, CHOICES and STAGE lines come after all the spoken lines, in that order. Each is on its own line with its label in capitals and no speaker tag.
- Keep each turn short, then stop and wait for the learner.
- The learner's words reach you as a speech-recognition transcript. It can mishear, and it often quietly fixes pronunciation, so you cannot judge how something sounded — only what was said. If a transcript looks garbled, ask the learner to say it again rather than guessing.
- The first message is "[session start]": open the session the way your instructions say.
- "[skip]" from the learner means: skip the current exercise, drill, or question. Don't repeat it, evaluate it, or give the answer unless they ask; acknowledge in a few words and move straight on to the next step of the session. Inside the scene, the character simply moves the conversation along.
- "[help]" from the learner means they are stuck on what you just asked. Step out as the narrator, in the language your instructions say to guide in (the learner's native language unless they say otherwise): say in one sentence what you are asking them to do, then give a hint, not the answer (the first word or two, a key word with its meaning, or the pattern to use). If they ask for help again on the same thing, give a bigger hint, and on the third time the full answer for them to repeat. Then hand the turn back so they can try. If you were in the scene, say you are pausing it, and go back to it after.
- "[explain]" from the learner means they want more about what was just said. Step out as the narrator, in the language your instructions say to guide in (the learner's native language unless they say otherwise), and in two or three short sentences explain it: what it means, the key word or structure in it, and any local or cultural note that helps. Don't ask them to repeat it. Then hand back to where you were, back in the scene if that is where you were.
- When you ask the learner how the session should go (whether to keep going, go slower, try something harder, or change the scene), not when you ask a practice question, end the turn with one CHOICES line offering two to four short answers in their native language, which the app shows as buttons. It is shown, not spoken. For example:
  CHOICES: Keep going | Slow down | A harder version
  A tapped choice reaches you as "[direct]" followed by its words.
- A message that starts with "[direct]" is the learner talking to you, the dojo master, outside the practice, in their native language: a request about the session, such as changing the scene, redoing or repeating something, going slower, or a question. It is not an answer to correct or grade. Reply as the narrator, in the language your instructions say to guide in (the learner's native language unless they say otherwise): do what they ask (or say briefly why you can't), confirm in a sentence, then carry on from there, back in the scene if that is where you were.`;
}

/** The system prompt for a voice turn: the pack as assembled, then the
 *  delivery adapter. */
export function voiceSystemPrompt(markdown, mode = "adult") {
  return `${String(markdown).trim()}\n\n${voiceAdapter(mode)}\n`;
}

export const SESSION_START = "[session start]";
/** What the Skip and Help buttons send (VoicePanel's SKIP and HELP must
 *  match). */
export const SKIP = "[skip]";
export const HELP = "[help]";
/** Prefix of a message spoken straight to the dojo master, outside the
 *  practice (VoicePanel's DIRECT must match). */
export const DIRECT = "[direct]";
/** What the Explain button sends (VoicePanel's EXPLAIN must match). */
export const EXPLAIN = "[explain]";
/** Prefix of a timeline jump: "[jump] warmup:warmup-phrases" (VoicePanel's
 *  JUMP must match). */
export const JUMP = "[jump]";

/** The transcript replayed as the prompt (the chat agent's pattern): the
 *  learner's lines as heard, the dojo master's as the tagged lines spoken —
 *  with their <t> marks put back, so the model keeps seeing the format. */
export function voiceTurnPrompt(history, message) {
  const render = (m) => m.role === "learner"
    ? `[LEARNER]\n${m.text}`
    : `[DOJO MASTER]\n${castLines(m.castNotes)}${(m.lines ?? []).map((l) => `${timingFor(l)}${tagFor(l)}: ${markedText(l)}`).join("\n")}${glossLine(m.glosses)}${Array.isArray(m.choices) && m.choices.length ? `\nCHOICES: ${m.choices.join(" | ")}` : ""}${typeof m.stage === "string" && m.stage ? `\nSTAGE: ${m.stage}` : ""}`;
  const prior = history.length ? `Session so far:\n\n${history.map(render).join("\n\n")}\n\n---\n\n` : "";
  const said = String(message ?? "").trim() || SESSION_START;
  return `${prior}[LEARNER]\n${said}\n\n[DOJO MASTER]\nReply as the dojo master: tagged lines first (a CAST line just before anyone's first line), then any GLOSS, CHOICES and STAGE lines, in that order.`;
}

/* ------------------------------ the reply side ----------------------------- */

// `NARRATOR:`, `CHARACTER-F:`, `**Character (M):**`, `SIDEKICK/woman:` — the
// tag, then an optional gender, in whatever punctuation the model reached for.
const TAG_RE = /^\s*(?:[-•]\s+)?(?:\*\*)?\s*(NARRATOR|CHARACTER|SIDEKICK|HELPER)(?:\s*[-/(]\s*(F|M|FEMALE|MALE|WOMAN|MAN)\s*\)?)?\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*/i;

/** A timing mark: `<pause 1.5>` waits that many seconds before the line;
 *  `<overlap 0.4>` starts it that much before the previous one ends (people
 *  talking over each other). Asked for before the tag, but found anywhere in
 *  the line (after the tag, inside **bold**, with a decimal comma), so a
 *  misplaced mark is never read out. */
// Any spelling of the mark: "<pause 1.5>", "<pause 1.5 seconds>",
// "<pause: 1.5>", "<pause=1.5>", and run together: "<pause1.5>", "<pause2s>"
// (so no \b after the word, only "not another letter"). The number is the
// first one inside: "1.5", ".5", "1,5", or "800ms" in milliseconds. Bounded
// so it can't run away on a long line.
const TIMING_RE = /<\s{0,3}(pause|overlap)(?![a-z])([^<>\n]{0,40})>/gi;
const TIMING_NUM = /(\d*[.,]?\d+)\s*(ms\b)?/i;
/** Seconds from a timing mark's inside, or null when it names no number. */
function timingSeconds(inside) {
  const m = String(inside).match(TIMING_NUM);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return m[2] ? n / 1000 : n;
}
/** Runs of blanks (a lone \r included) → one space: every pattern below then
 *  sees at most one blank between tokens, so none of them can backtrack for
 *  long on a line padded with spaces. Lines are split on \n first. */
const squeeze = (s) => String(s).replace(/[^\S\n]+/g, " ");

/** Gaps between lines, in ms. A switch between the narrator and anyone in
 *  the scene always gets a slight delay (never an overlap), so the learner
 *  hears the change of voice and of mode. */
export const LINE_PAUSE = { narratorSwitch: 800, narratorSwitchMin: 600, newSpeaker: 400, sameSpeaker: 200, max: 4000, maxOverlap: 1500 };

/** The pause before `line` (ms; negative = overlap) after `prev`: the dojo
 *  master's own <pause>/<overlap> when it gave one, else a default by who is
 *  speaking. */
export function linePauseMs(prev, line) {
  if (!prev) return 0;
  const switching = (prev.speaker === "narrator") !== (line.speaker === "narrator");
  if (typeof line.gap === "number" && Number.isFinite(line.gap)) {
    const ms = Math.round(line.gap * 1000);
    const clamped = Math.max(-LINE_PAUSE.maxOverlap, Math.min(LINE_PAUSE.max, ms));
    return switching ? Math.max(LINE_PAUSE.narratorSwitchMin, clamped) : clamped;
  }
  if (switching) return LINE_PAUSE.narratorSwitch;
  return prev.speaker === line.speaker && prev.gender === line.gender ? LINE_PAUSE.sameSpeaker : LINE_PAUSE.newSpeaker;
}

/** A line's timing mark in the model's notation, for the replayed history. */
function timingFor(line) {
  const g = line?.gap;
  if (typeof g !== "number" || !Number.isFinite(g)) return "";
  return g < 0 ? `<overlap ${+(-g).toFixed(2)}> ` : `<pause ${+g.toFixed(2)}> `;
}

const GENDER_OF = { f: "female", female: "female", woman: "female", m: "male", male: "male", man: "male" };

/** A line's tag in the model's notation, gender included when known. */
function tagFor(line) {
  const base = TAG[line?.speaker] ?? "NARRATOR";
  return line?.gender === "female" ? `${base}-F` : line?.gender === "male" ? `${base}-M` : base;
}

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
  return segmentsFrom(text, false).segments;
}

/** splitSegments with the <t> state carried in and out, so a wrap that
 *  opens on one line and closes on a later one marks every line between. */
function segmentsFrom(text, inside) {
  const segments = [];
  const push = (raw) => {
    const said = speakable(raw);
    if (said) segments.push({ lang: inside ? "target" : "native", text: said });
  };
  let last = 0;
  for (const m of String(text).matchAll(/<(\/?)t>/gi)) {
    push(String(text).slice(last, m.index));
    inside = !m[1];
    last = m.index + m[0].length;
  }
  push(String(text).slice(last));
  return { segments, inside };
}

/** Punctuation that belongs to the words before it, never a segment (and so
 *  never a synthesis call) of its own: "<t>jitomate</t>." */
const LEADING_PUNCT_RE = /^[\s.,;:!?…)\]»。！？、，]+/;

/** A segment longer than a synthesis call should carry, split at sentence
 *  ends (a hard cut only for one enormous sentence). */
export const MAX_SEGMENT_CHARS = 1200;
export function splitLong(text, max = MAX_SEGMENT_CHARS) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = "";
  // Split at zero-width points so no character is lost or added: after a
  // Latin sentence end and its space (so "3.5" stays whole), or right after a
  // CJK full stop, which is not followed by a space.
  for (const sentence of text.split(/(?<=[.!?…]\s+)(?=\S)|(?<=[。！？])(?=\S)/)) {
    const next = cur + sentence;
    if (next.trim().length <= max) { cur = next; continue; }
    if (cur.trim()) out.push(cur.trim());
    let rest = sentence;
    while (rest.trim().length > max) { out.push(rest.slice(0, max).trim()); rest = rest.slice(max); }
    cur = rest;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The model's reply as `{speaker, gender, text, segments}` lines, in order.
 *  An untagged line continues the speaker before it (narrator at the top); a
 *  speaker the mode doesn't have falls back to the narrator; consecutive
 *  lines by the same speaker and gender merge, and so do adjacent segments
 *  in the same language — each segment is one synthesis call, so one longer
 *  than MAX_SEGMENT_CHARS is split at sentence ends. */
// The turn's definitions: shown on tap, never spoken.
// Shown-not-spoken lines are matched by their exact upper-case label, so a
// spoken "Gloss: …" or "Options: …" stays speech. A speaker tag in front
// (the adapter's "every line starts with a tag" pulls that way) is allowed.
// The tag is matched in any case, as TAG_RE does ("Narrator-F:"); only the
// label itself must be upper case. A bullet, and timing marks (bold or not)
// before or after the tag, are allowed too. The lines lose their ** bold,
// are trimmed and squeezed (one blank between tokens) and capped before
// matching (metaRest), so every optional piece below is unambiguous and
// neither a line of spaces nor a run of "**<pause 1> " can make it backtrack.
const ci = (w) => [...w].map((c) => (/[a-z]/i.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c)).join("");
const TIMING_MARKS = `(?:<[ ]?(?:${ci("pause")}|${ci("overlap")})[^<>]{0,40}> ?)*`;
const META_TAG = `^(?:[-•] )?${TIMING_MARKS}(?:(?:${["NARRATOR", "CHARACTER", "SIDEKICK", "HELPER"].map(ci).join("|")})(?: ?[-/(] ?(?:${["FEMALE", "WOMAN", "MALE", "MAN", "F", "M"].map(ci).join("|")}) ?\\)?)? ?: ?)?${TIMING_MARKS}`;
const metaRe = (label) => new RegExp(`${META_TAG}${label} ?: ?`);
/** The text after a shown-not-spoken label, or null when `rawLine` isn't
 *  that line. Matched on the line's trimmed start so leading spaces never
 *  reach the pattern. */
function metaRest(re, rawLine) {
  const line = squeeze(String(rawLine).replace(/\*\*/g, "")).trimStart();
  const m = line.slice(0, 200).match(re);
  return m ? line.slice(m[0].length) : null;
}
const isMeta = (rawLine) => [GLOSS_RE, CHOICES_RE, STAGE_RE, CAST_RE].some((re) => metaRest(re, rawLine) != null);
const GLOSS_RE = metaRe("GLOSS(?:ES)?");
export const MAX_GLOSSES = 16;
const GLOSS_TERM_CHARS = 200;
const GLOSS_MEANING_CHARS = 300;

/** The GLOSS line(s) of a reply as `{term, meaning}`: "term = meaning"
 *  entries split on "|", <t> marks dropped, duplicates (by term, ignoring
 *  case) dropped, capped at MAX_GLOSSES. A malformed entry is skipped, not
 *  fatal: a missing definition costs nothing that matters. */
export function parseGlosses(text) {
  const out = [];
  const seen = new Set();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const rest = metaRest(GLOSS_RE, rawLine);
    if (rest == null) continue;
    for (const entry of rest.split("|")) {
      const eq = entry.indexOf("=");
      if (eq < 0) continue;
      const clean = (x) => x.replace(/<\/?\s*t\s*>/gi, "").replace(/\*\*/g, "").trim();
      const term = clean(entry.slice(0, eq)).replace(/^["“”']+|["“”']+$/g, "").trim().slice(0, GLOSS_TERM_CHARS);
      const meaning = clean(entry.slice(eq + 1)).slice(0, GLOSS_MEANING_CHARS);
      if (!term || !meaning || seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());
      out.push({ term, meaning });
      if (out.length >= MAX_GLOSSES) return out;
    }
  }
  return out;
}

// Quick answers to a check-in question ("keep going?"), shown as buttons.
// "OPTIONS:" is the older label for the same line.
const CHOICES_RE = metaRe("(?:CHOICES|OPTIONS)");
export const MAX_CHOICES = 4;
const CHOICE_CHARS = 60;

/** The CHOICES line of a reply as button labels: split on "|", trimmed,
 *  duplicates dropped, at most MAX_CHOICES. */
export function parseChoices(text) {
  const out = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const rest = metaRest(CHOICES_RE, rawLine);
    if (rest == null) continue;
    for (const c of rest.split("|")) {
      const label = c.replace(/<\/?\s*t\s*>/gi, "").replace(/\*\*/g, "").trim().slice(0, CHOICE_CHARS);
      if (label && !out.some((o) => o.toLowerCase() === label.toLowerCase())) out.push(label);
      if (out.length >= MAX_CHOICES) return out;
    }
  }
  return out;
}

// Where the session is, for the timeline: one part id from the plan.
const STAGE_RE = metaRe("STAGE");

// Who a voice tag now is, so the app can give it a voice of the right age.
const CAST_RE = metaRe("CAST");
// Longest gender words first, and a word end after, so FEMALE is never
// read as F plus "EMALE".
const CAST_TAG_RE = /^(NARRATOR|CHARACTER|SIDEKICK|HELPER)(?:\s?[-/(]\s?(FEMALE|WOMAN|MALE|MAN|F|M)\b\s?\)?)?/i;
const CAST_WHO_CHARS = 80;

/** How old a voice sounds or a character is, from a provider label or the
 *  dojo master's word: "child", "young", "middle" or "old"; "" when it
 *  doesn't say. */
export function ageOf(label) {
  const w = String(label ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (/^(child|kid|little|boy|girl|toddler|baby)\b/.test(w)) return "child";
  if (/^(young|teen|teenager|teenage|youthful)\b/.test(w)) return "young";
  if (/^(middle aged|middle|adult|mature)\b/.test(w)) return "middle";
  if (/^(old|elderly|older|senior|aged)\b/.test(w)) return "old";
  return "";
}
const AGE_RANK = { child: 0, young: 1, middle: 2, old: 3 };

/** The CAST lines of a reply as {slot, age, who}: "CAST: CHARACTER-F old,
 *  Doña Carmen, the fruit vendor". A tag without a gender, a speaker the
 *  mode doesn't have, or an age it can't read is dropped; a later line for
 *  the same slot wins. */
export function parseCast(text, mode = "adult") {
  const allowed = new Set(speakersFor(mode));
  const out = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const rest = metaRest(CAST_RE, rawLine);
    if (rest == null) continue;
    const body = rest.replace(/\*\*/g, "").trim();
    const t = body.match(CAST_TAG_RE);
    if (!t || !t[2]) continue;
    const speaker = t[1].toLowerCase() === "helper" ? "sidekick" : t[1].toLowerCase();
    if (!allowed.has(speaker)) continue;
    const after = body.slice(t[0].length).replace(/<\/?\s*t\s*>/gi, "").replace(/^[\s,|:–—-]+/, "");
    // The age is a word in the first clause: "old, Doña Carmen", or "an
    // elderly woman, Doña Carmen". When it leads, it comes out of `who`.
    const clause = after.split(/[,|;]/)[0];
    const words = clause.split(/\s+/).filter(Boolean);
    let age = "";
    let lead = false;
    for (let i = 0; i < words.length && !age; i++) {
      age = ageOf(words.slice(i).join(" "));
      lead = i === 0;
    }
    if (!age) continue;
    const named = lead ? after.replace(/^[A-Za-z]+(?:[\s_-]aged)?/, "").replace(/^[\s,|:–—-]+/, "") : after;
    const who = oneLine(named).slice(0, CAST_WHO_CHARS);
    const slot = `${speaker}:${GENDER_OF[t[2].toLowerCase()]}`;
    out.delete(slot);
    out.set(slot, { slot, age, who });
  }
  return [...out.values()];
}

/** Cast notes the client sent back in the history, kept only in the shape
 *  parseCast makes: a known slot, a readable age, and `who` on one line
 *  without <t> marks, capped. Anything else is dropped. */
export function replayCastNotes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n) => typeof n?.slot === "string" && /^(narrator|character|sidekick):(female|male)$/.test(n.slot) && !!ageOf(n.age))
    .slice(0, 6)
    .map((n) => ({ slot: n.slot, age: ageOf(n.age), who: typeof n.who === "string" ? oneLine(n.who.replace(/<\/?\s*t\s*>/gi, "")).slice(0, CAST_WHO_CHARS) : "" }));
}

/** A turn's cast notes as the CAST lines it came with, for the replay. */
function castLines(notes) {
  if (!Array.isArray(notes)) return "";
  return notes
    .map((n) => {
      const [speaker, gender] = String(n?.slot ?? "").split(":");
      if (!TAG[speaker] || (gender !== "female" && gender !== "male") || !AGE_RANK.hasOwnProperty(n.age)) return "";
      return `CAST: ${TAG[speaker]}-${gender === "female" ? "F" : "M"} ${n.age === "middle" ? "middle-aged" : n.age}${n.who ? `, ${oneLine(n.who)}` : ""}\n`;
    })
    .join("");
}

/** The STAGE line's part id, if it names one of `ids`; the last valid one
 *  wins (a turn that moves on ends in the later part). */
export function parseStage(text, ids) {
  const known = new Set(ids);
  let out = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const rest = metaRest(STAGE_RE, rawLine);
    if (rest == null) continue;
    // "scene.", "`scene`", "**scene**": the id without what's around it.
    const id = (rest.replace(/[*`"'“”]/g, "").trim().split(/\s+/)[0] ?? "").replace(/[.,;:!?)]+$/, "");
    if (known.has(id)) out = id;
  }
  return out;
}

/** The slots that make up a session's parts, around the scene, by mode. */
// Kids games mostly run during the story, whenever a word needs repeating,
// so they sit at its start; one tagged "opener" (the echo game) runs before
// the story, so it sits before the scene.
const PLAN_SLOTS = {
  adult: { intro: "intro", before: ["warmup"], after: ["debrief"] },
  kids: { intro: "intro", before: [], during: ["games"], after: ["ending"], openerTag: "opener" },
};
const BEAT_CHARS = 70;

/** The session's parts in order, for the timeline and the adapter: the
 *  introduction, each warm-up, the scene and its beats (the scenario's
 *  beats list), then the debrief. `content` is loadContent's result and
 *  `pack` the pack being practised; ids are stable within a session. */
export function sessionPlan(content, pack, mode = "adult") {
  const cfg = PLAN_SLOTS[mode] ?? PLAN_SLOTS.adult;
  const byId = new Map((content?.units ?? []).map((u) => [u.id, u]));
  // Each unit once, as assemble does: a pack listing one twice must not
  // show (or run) it twice, and ids must stay unique.
  const ids = [...new Set(Array.isArray(pack?.units) ? pack.units : [])];
  const units = ids.map((id) => byId.get(id)).filter(Boolean);
  const inSlot = (slot) => units.filter((u) => u.slot === slot);
  const opener = (u) => !!cfg.openerTag && Array.isArray(u.tags) && u.tags.includes(cfg.openerTag);
  const part = (slot, u) => ({ id: `${slot}:${u.id}`, title: u.title, kind: slot });
  const plan = [];
  if (inSlot(cfg.intro).length) plan.push({ id: "intro", title: "Introduction", kind: "intro" });
  for (const slot of cfg.before) for (const u of inSlot(slot)) plan.push(part(slot, u));
  for (const slot of cfg.during ?? []) for (const u of inSlot(slot).filter(opener)) plan.push(part(slot, u));
  const scenario = (content?.scenarios ?? []).find((sc) => sc.id === pack?.scenario);
  const title = scenario?.title || (pack?.quick_scenario ? "Quick scene" : "The scene");
  plan.push({ id: "scene", title, kind: "scene" });
  // Games played during the story sit at its start: they begin with it and
  // come back whenever a word needs repeating.
  for (const slot of cfg.during ?? []) for (const u of inSlot(slot).filter((u) => !opener(u))) plan.push(part(slot, u));
  const beats = Array.isArray(scenario?.beats) ? scenario.beats : [];
  beats.forEach((b, i) => {
    // One line: a beat written over several lines would break the
    // adapter's list of parts.
    const text = String(b).replace(/\s+/g, " ").trim();
    // The beat's first clause is its name: "Arriving at the stall; Doña
    // Carmen calling out…" → "Arriving at the stall". Leading punctuation
    // is not a clause.
    const short = text.replace(/^[\s;:—–-]+/, "").split(/[;:—]/)[0].trim() || text;
    plan.push({ id: `beat:${i + 1}`, title: short.length > BEAT_CHARS ? `${short.slice(0, BEAT_CHARS - 1)}…` : short, kind: "beat", detail: text });
  });
  for (const slot of cfg.after) for (const u of inSlot(slot)) plan.push(part(slot, u));
  return plan;
}

/** The adapter's section naming this session's parts (none without a plan). */
export function planDirective(plan) {
  if (!Array.isArray(plan) || !plan.length) return "";
  const rows = plan.map((p) => `- ${p.id}: ${p.detail ?? p.title}`).join("\n");
  return `\n\n## This session's parts\n\nThe session runs through these parts in order (the learner sees them as a timeline):\n\n${rows}\n\nEnd every turn with one STAGE line naming the part you are in when the turn ends, by its id, e.g. STAGE: ${plan[0].id}. It is shown, not spoken. A game or drill that comes back inside the scene is not a part of its own then: name the scene beat it happens in (or scene, when the scene has no beats). Use a game's id only while that game is the part itself (before the scene, or after a jump to it). "${JUMP} <id>" from the learner means: go straight to that part now. Say in one short narrator sentence where you are jumping to, then start it. For a scene beat, open the scene already in the middle of that moment, as if what came before had happened: no fresh greeting, and the character's first line is about that beat (for a beat about prices, the character is already talking prices). Parts in between are skipped, warm-ups included: a jump overrides the rule about running every warm-up first. Don't go back to them unless asked.`;
}

/** Replayed text from the browser, on one line: glosses and choices go back
 *  inside one line each ("GLOSS: a = b | …"), and every line is one tagged
 *  line, so a newline or "|" would forge replay structure (a fake GLOSS or
 *  STAGE line). */
export const oneLine = (s) => String(s).replace(/[\r\n|]+/g, " ").trim();

/** A replayed turn's stage, if it is id-shaped (part ids are unit ids with
 *  a slot prefix); anything else is dropped. */
export const replayStage = (v) => (typeof v === "string" && /^[A-Za-z0-9:_.-]{1,80}$/.test(v) ? v : "");

/** A turn's glosses as the GLOSS line it came with, for the replay. */
function glossLine(glosses) {
  if (!Array.isArray(glosses) || !glosses.length) return "";
  return `\nGLOSS: ${glosses.map((g) => `${g.term} = ${g.meaning}`).join(" | ")}`;
}

export function parseVoiceReply(text, mode = "adult") {
  const allowed = new Set(speakersFor(mode));
  const out = [];
  let current = "narrator";
  let gender = null;
  let inside = false;
  // A timing mark waits for the next line that has words (it may sit on a
  // line of its own).
  let gap = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    if (!rawLine.trim() || isMeta(rawLine)) continue;
    let raw = squeeze(rawLine);
    const marks = [...raw.matchAll(TIMING_RE)];
    if (marks.length) {
      // The first mark with a number wins; all of them come out of the text.
      const t = marks.map((x) => [x[1], timingSeconds(x[2])]).find((x) => x[1] != null);
      if (t) gap = (t[0].toLowerCase() === "overlap" ? -1 : 1) * t[1];
      raw = raw.replace(TIMING_RE, " ").replace(/\*\*\s+/, "**");
      if (!raw.replace(/\*/g, "").trim()) continue;
    }
    let line = raw;
    const m = raw.match(TAG_RE);
    if (m) {
      const tag = m[1].toLowerCase() === "helper" ? "sidekick" : m[1].toLowerCase();
      current = allowed.has(tag) ? tag : "narrator";
      gender = m[2] ? GENDER_OF[m[2].toLowerCase()] : null;
      line = raw.slice(m[0].length);
      // A new speaker starts outside any wrap: a <t> the previous speaker
      // never closed must not turn this one's English into Spanish.
      inside = false;
    }
    let segments;
    ({ segments, inside } = segmentsFrom(line, inside));
    if (!segments.length) continue;
    let target = out[out.length - 1];
    // A timed line is its own line even from the same speaker: the pause
    // sits between the two.
    if (!target || target.speaker !== current || target.gender !== gender || gap != null) {
      target = { speaker: current, gender, text: "", segments: [] };
      if (gap != null) target.gap = gap;
      gap = null;
      out.push(target);
    }
    for (const g of segments) {
      const prev = target.segments[target.segments.length - 1];
      let text = g.text;
      if (prev && prev.lang !== g.lang) {
        // "<t>jitomate</t>. Try…": the period ends the Spanish, so it goes
        // with it rather than becoming an English call of its own.
        const punct = text.match(LEADING_PUNCT_RE)?.[0] ?? "";
        if (punct) {
          prev.text += punct.trim();
          text = text.slice(punct.length).trim();
          if (!text) continue;
        }
      }
      if (prev && prev.lang === g.lang) prev.text = `${prev.text} ${text}`;
      else target.segments.push({ lang: g.lang, text });
    }
  }
  out.forEach((l, i) => {
    l.segments = l.segments.flatMap((g) => splitLong(g.text).map((t) => ({ lang: g.lang, text: t })));
    l.text = joinSegments(l.segments);
    l.pauseMs = linePauseMs(out[i - 1], l);
  });
  return out;
}

/* ---------------------------------- slots ---------------------------------- */

export const GENDERS = ["female", "male"];

/** The voice slots of a mode: every speaker as a woman and as a man, e.g.
 *  "character:female". The dojo master tags each line with one. */
export function voiceSlots(mode) {
  return speakersFor(mode).flatMap((s) => GENDERS.map((g) => `${s}:${g}`));
}

const SLOT_RE = /^(narrator|character|sidekick)(?::(female|male))?$/;

/** The voice for a line, from one locale's slot map. Gender beats role: the
 *  exact slot, then the narrator's voice of the same gender, then the
 *  speaker's other gender, then an ungendered (older) choice, then anything
 *  the narrator has. "" when nothing at all is set. */
export function voiceFor(set, speaker, gender) {
  const s = set ?? {};
  const g = gender === "male" || gender === "female" ? gender : null;
  const other = g === "male" ? "female" : "male";
  const order = g
    ? [`${speaker}:${g}`, `narrator:${g}`, `${speaker}:${other}`, speaker, `narrator:${other}`, "narrator"]
    : [`${speaker}:female`, `${speaker}:male`, speaker, "narrator:female", "narrator:male", "narrator"];
  for (const k of order) if (s[k]) return s[k];
  return "";
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
/** Scribe v2. `language` (a locale like "es-MX") fixes the language instead
 *  of letting Scribe guess per clip; a learner's accented Spanish otherwise
 *  gets heard as English. `keyterms` are words to expect (the phrases the
 *  dojo master just asked for), which Scribe favours when the audio is
 *  ambiguous. */
export function elevenTranscribeRequest({ key, audio, mime = "audio/wav", language, keyterms = [] }) {
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("tag_audio_events", "false");
  if (language && BCP47_RE.test(language)) form.append("language_code", language.split("-")[0].toLowerCase());
  for (const t of keyterms.slice(0, MAX_KEYTERMS)) form.append("keyterms", t);
  form.append("file", new Blob([audio], { type: mime }), "turn.wav");
  return {
    url: "https://api.elevenlabs.io/v1/speech-to-text",
    init: { method: "POST", headers: { "xi-api-key": key }, body: form },
  };
}

/** Scribe's keyterm limits: 100 terms, each at most 5 words and under 50
 *  characters. */
export const MAX_KEYTERMS = 100;
const KEYTERM_WORDS = 5;
const KEYTERM_CHARS = 49;

/** Target-language phrases (newest first) → Scribe keyterms: cut at
 *  punctuation and into runs of at most 5 words, under 50 characters,
 *  deduplicated, capped. The browser sends the target phrases of the dojo
 *  master's latest turns: what the learner was just asked to say, repeat, or
 *  answer with, so the clearest expectation there is. */
export function keytermsFrom(phrases, max = MAX_KEYTERMS) {
  const out = [];
  const seen = new Set();
  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    // A long phrase is still vocabulary worth hinting: take it in runs of
    // five words rather than dropping it.
    const pieces = String(phrase)
      .split(/[.,;:!?¿¡…。！？、，"“”()]+/)
      .flatMap((p) => {
        const words = p.trim().split(/\s+/).filter(Boolean);
        const runs = [];
        for (let i = 0; i < words.length; i += KEYTERM_WORDS) runs.push(words.slice(i, i + KEYTERM_WORDS).join(" "));
        return runs;
      });
    for (const t of pieces) {
      if (!t || t.length > KEYTERM_CHARS) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= max) return out;
    }
  }
  return out;
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
          note: [labels.accent || "", labels.age ? String(labels.age).replace(/_/g, " ") : "", labels.descriptive || labels.description || "", v.category === "premade" ? "premade" : ""].filter(Boolean).join(" · "),
          match: native,
          age: ageOf(labels.age),
          premade: v.category === "premade",
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
// `say -v ?` gives no gender, so the cast would hand a man's line to a
// woman's voice. The macOS voices people actually get, by gender; one not
// listed has no gender and is used only when no voice of a gender is known.
const SYSTEM_VOICE_GENDER = new Map([
  ...["Alice", "Alva", "Amélie", "Anna", "Ava", "Carmit", "Damayanti", "Ellen", "Flo", "Grandma", "Ioana", "Joana", "Kanya", "Karen", "Kathy", "Kyoko", "Lana", "Laura", "Lekha", "Luciana", "Mariska", "Marisol", "Meijia", "Melina", "Milena", "Moira", "Montse", "Mónica", "Nora", "Paulina", "Samantha", "Sandy", "Sara", "Satu", "Shelley", "Sinji", "Susan", "Tara", "Tessa", "Tingting", "Victoria", "Yelda", "Yuna", "Zoe", "Zosia", "Zuzana"].map((n) => [n, "female"]),
  ...["Aaron", "Alex", "Aman", "Arthur", "Carlos", "Daniel", "Diego", "Eddy", "Fred", "Grandpa", "Hattori", "Jacques", "Jorge", "Jordi", "Juan", "Junior", "Lee", "Luca", "Maged", "Martin", "Neel", "Oliver", "Otoya", "Ralph", "Reed", "Rishi", "Rocko", "Thomas", "Tom", "Xander", "Yuri"].map((n) => [n, "male"]),
  // Sound-effect voices: shown in the picker as "novelty", never drawn for a
  // Random slot (the cast pools only take "female", "male", or no label).
  ...["Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News", "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox"].map((n) => [n, "novelty"]),
]);

export function systemVoices(text, locale) {
  const want = String(locale ?? "").replace("-", "_");
  const rows = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#\s?(.*)$/);
    if (!m || m[2] !== want) continue;
    const name = m[1].trim();
    const base = name.replace(/\s*\(.*$/, "");
    rows.push({ id: name, name, gender: SYSTEM_VOICE_GENDER.get(base) ?? "", note: m[3].trim(), match: true, age: base === "Grandma" || base === "Grandpa" ? "old" : "" });
  }
  return rows;
}

/** A provider's transcription reply → text. */
export function transcriptText(provider, json) {
  if (provider === "elevenlabs") return typeof json?.text === "string" ? json.text.trim() : "";
  const phrases = Array.isArray(json?.combinedPhrases) ? json.combinedPhrases : [];
  return phrases.map((p) => (typeof p?.text === "string" ? p.text : "")).join(" ").trim();
}


/* ------------------------------ voice library ------------------------------ */

// ElevenLabs' shared Voice Library: thousands of community and professional
// voices with an accent, a description and usage numbers, searchable by
// language and locale. On a paid plan a library voice can be used by id
// without adding it (the random cast relies on this; tested 2026-11); a free
// plan is refused (402 and similar), and /speak then retries in the slot's
// own voice, its cast fallback, or a borrowed one (speechVoices). "Use
// as…" in the browser adds one to the account (POST /v1/voices/add) so it
// shows up in the account's own list.

export const LIBRARY_SORTS = ["usage_character_count_1y", "trending", "cloned_by_count", "created_date"];

const LIBRARY_AGE = { child: "young", young: "young", middle: "middle_aged", old: "old" };
export function elevenLibraryRequest({ key, locale, gender, age, search, sort, page = 0, pageSize = 30 }) {
  const q = new URLSearchParams({ page_size: String(pageSize), page: String(Math.max(0, page | 0)) });
  if (locale) {
    q.set("language", languageOf(locale));
    q.set("locale", locale);
  }
  if (gender === "female" || gender === "male") q.set("gender", gender);
  if (LIBRARY_AGE[age]) q.set("age", LIBRARY_AGE[age]);
  if (search) q.set("search", String(search).slice(0, 100));
  q.set("sort", LIBRARY_SORTS.includes(sort) ? sort : LIBRARY_SORTS[0]);
  return { url: `https://api.elevenlabs.io/v1/shared-voices?${q}`, init: { method: "GET", headers: { "xi-api-key": key } } };
}

/** /v1/shared-voices → rows for the browser. */
export function elevenLibrary(json) {
  const voices = Array.isArray(json?.voices) ? json.voices : [];
  return {
    voices: voices
      .filter((v) => v && typeof v.voice_id === "string" && typeof v.public_owner_id === "string")
      .map((v) => ({
        id: v.voice_id,
        ownerId: v.public_owner_id,
        name: String(v.name ?? v.voice_id).trim(),
        description: typeof v.description === "string" ? v.description.trim() : "",
        accent: v.accent ? String(v.accent) : "",
        gender: v.gender ? String(v.gender) : "",
        age: v.age ? String(v.age).replace(/_/g, " ") : "",
        useCase: v.use_case ? String(v.use_case).replace(/_/g, " ") : "",
        locale: v.locale ? String(v.locale) : "",
        previewUrl: typeof v.preview_url === "string" && v.preview_url.startsWith("https://") ? v.preview_url : "",
        usage1y: Number(v.usage_character_count_1y) || 0,
        usage7d: Number(v.usage_character_count_7d) || 0,
        clonedBy: Number(v.cloned_by_count) || 0,
        added: v.is_added_by_user === true,
      })),
    hasMore: json?.has_more === true,
    total: Number(json?.total_count) || null,
  };
}

const EL_ID_RE = /^[A-Za-z0-9]{8,64}$/;

export function elevenAddRequest({ key, ownerId, voiceId, name }) {
  if (!EL_ID_RE.test(String(ownerId)) || !EL_ID_RE.test(String(voiceId))) throw new Error("not an ElevenLabs voice id");
  return {
    url: `https://api.elevenlabs.io/v1/voices/add/${ownerId}/${voiceId}`,
    init: {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: String(name || voiceId).slice(0, 100) }),
    },
  };
}

/* ---------------------------------- cast ----------------------------------- */

/** A Random slot's pool from the provider's own voice list for one gender
 *  (`list` is the picker's shape: {id, name, gender, match}): native voices
 *  labelled with that gender, then native voices with no label (which may
 *  be either), then labelled voices for other locales, then unlabelled ones.
 *  "novelty" and other labels never count. `skip` holds ids to leave out. */
export function poolFor(list, gender, skip = new Set(), age = "") {
  const ok = (Array.isArray(list) ? list : []).filter((v) => !skip.has(v.id));
  const labelled = ok.filter((v) => String(v.gender).toLowerCase() === gender);
  const unlabelled = ok.filter((v) => !v.gender);
  const tiers = [labelled.filter((v) => v.match), unlabelled.filter((v) => v.match), labelled, unlabelled];
  let pool = tiers.find((t) => t.length) ?? [];
  // An age asked for: within that tier, the voices nearest it (a voice with
  // no age label counts as a step and a half away, so a real neighbour wins).
  if (AGE_RANK.hasOwnProperty(age) && pool.length) pool = nearestAge(pool, age);
  return pool.map((v) => ({ id: v.id, name: v.name, age: v.age ?? "" }));
}

/** The voices a /speak line uses: `first` to try, and `retry` for when the
 *  provider refuses a cast voice ("" when there is no retry). The retry is
 *  the learner's voice for this exact slot, else the cast's account
 *  fallback for it, else whatever voiceFor borrows from other slots — so a
 *  refused man's line never borrows the narrator woman's voice while a
 *  man's fallback exists. A cast voice refused before goes straight to the
 *  retry voice. Without a cast, the saved choice (borrowing), else the
 *  fallback. */
export function speechVoices({ set = {}, speaker, gender, cast, fallback = "", refused = new Set() }) {
  const borrowed = voiceFor(set, speaker, gender);
  if (!cast) return { first: borrowed || fallback || "", retry: "" };
  const exact = gender === "female" || gender === "male" ? set?.[`${speaker}:${gender}`] ?? "" : "";
  const retry = exact || fallback || borrowed || "";
  if (!retry || retry === cast) return { first: cast, retry: "" };
  return refused.has(cast) ? { first: retry, retry: "" } : { first: cast, retry };
}

/** For ElevenLabs: each slot's fallback, a distinct account voice of its
 *  gender (two women never share one while the account has two). Premade
 *  voices come first (any plan can speak with them; voices added from the
 *  library may be refused like the library itself), then those nearest the
 *  slot's age when one is asked for (on a plan that refuses library voices
 *  the fallback is the voice that speaks), then natives. Voices the learner
 *  set for a slot, and `taken` ones (other slots' fallbacks in a recast),
 *  are left alone. Every slot of the mode is worked through in `all`'s
 *  order, so a recast of one slot gets the same answer as at Start rather
 *  than an earlier slot's voice; only `slots` come back. → slot → id. */
export function castFallbacks(own, slots, set = {}, { all = slots, ages = {}, taken: busy = [] } = {}) {
  const taken = new Set([...Object.values(set ?? {}).filter(Boolean), ...busy]);
  const list = Array.isArray(own) ? own : [];
  const want = new Set(slots);
  const out = {};
  const order = [...all.filter((x) => !want.has(x)), ...all.filter((x) => want.has(x)), ...slots.filter((x) => !all.includes(x))];
  for (const slot of order) {
    const gender = slot.split(":")[1];
    const age = AGE_RANK.hasOwnProperty(ages[slot]) ? ages[slot] : "";
    const dist = (v) => (!age ? 0 : AGE_RANK.hasOwnProperty(v.age) ? Math.abs(AGE_RANK[v.age] - AGE_RANK[age]) : 1.5);
    const rank = (v) => (v.premade ? 0 : 10) + dist(v) * 2 + (v.match ? 0 : 1);
    const labelled = list.filter((v) => String(v.gender).toLowerCase() === gender);
    const from = (labelled.length ? labelled : list.filter((v) => !v.gender)).slice().sort((x, y) => rank(x) - rank(y));
    const pick = from.find((v) => !taken.has(v.id)) ?? from[0];
    if (!pick) continue;
    if (want.has(slot)) out[slot] = pick.id;
    taken.add(pick.id);
  }
  return out;
}

/** /cast's pools, from what the provider gave: `library` is gender → the
 *  Voice Library's voices of that gender, `aged` is slot → that slot's
 *  age-filtered search (ElevenLabs only; null where the search failed, []
 *  where it found nothing), `own` the account's or provider's list. A slot
 *  wanting an age takes its aged search, else the gender's library voices
 *  nearest that age, else (when the library had nothing at all) the own
 *  voices nearest it. In a recast (`recast`), a slot whose searches failed
 *  is `omitted`, so the client keeps the voice it has rather than one in
 *  another language; a full draw never omits.
 *  → {pools, omitted}. */
export function castPools({ slots, set = {}, ages = {}, library = {}, aged = {}, own = [], recast = false }) {
  const pools = { female: [], male: [] };
  const omitted = [];
  const random = slots.filter((x) => !set[x]);
  for (const g of ["female", "male"]) pools[g] = library[g]?.length ? library[g] : poolFor(own, g);
  for (const slot of random) {
    const age = ages[slot];
    if (!age) continue;
    const g = slot.split(":")[1];
    if (aged[slot]?.length) pools[slot] = aged[slot];
    else if (library[g]?.length) pools[slot] = nearestAge(library[g], age);
    else if (recast && (aged[slot] === null || library[g] === null)) omitted.push(slot);
    else pools[slot] = poolFor(own, g, new Set(), age);
  }
  return { pools, omitted };
}

/** The voices of `list` nearest `age` (an unlabelled one is a step and a
 *  half away). */
function nearestAge(list, age) {
  const dist = (v) => (AGE_RANK.hasOwnProperty(v.age) ? Math.abs(AGE_RANK[v.age] - AGE_RANK[age]) : 1.5);
  const best = Math.min(...list.map(dist));
  return list.filter((v) => dist(v) === best);
}

/** Whether a provider's refusal of a cast voice is worth one retry in
 *  another voice: 402 no library access, 403, 404 a removed voice, 400/422 a
 *  voice the plan can't use. Not a bad key or spent credits (401), a rate
 *  limit (429), or a transient 408/409, which another voice won't fix. The voice is only marked refused once the retry
 *  succeeds, so an error that isn't about the voice never sticks to it. */
const VOICE_REFUSALS = new Set([400, 402, 403, 404, 422]);
export function retryInOtherVoice(status) {
  return VOICE_REFUSALS.has(status);
}

/** The narrator's gender when the pack fixes it (narrator-female,
 *  narrator-kids-male, …); null when it leaves it open, as the default
 *  narrator-native-rotating does. */
export function pinnedNarratorGender(units) {
  for (const id of Array.isArray(units) ? units : []) {
    // narrator-female, narrator-kids-male, and user-made ones such as
    // narrator-female-slow: a narrator unit whose id names one gender.
    const m = /^narrator(?:-[a-z0-9]+)*?-(female|male)(?:-[a-z0-9]+)*$/.exec(String(id));
    if (m) return m[1];
  }
  return null;
}

/** The adapter's line fixing this session's narrator. The app draws the
 *  gender (a model asked to "pick at random" picks the same one every time). */
export function narratorDirective(gender) {
  if (gender !== "female" && gender !== "male") return "";
  const [who, tag] = gender === "female" ? ["a woman", "NARRATOR-F"] : ["a man", "NARRATOR-M"];
  return `\n\n## This session's narrator\n\nFor this session the narrator is ${who}: tag every narrator line ${tag}, whatever your instructions say about choosing.`;
}

/** One session's voices: every slot the learner set keeps its voice; every
 *  other slot (Random) draws from the pool for its gender, without repeats
 *  where the pool allows. `pools` is gender → [{id, name, age?}], or a slot
 *  → its own pool (a recast for an age); `ages` is id → age for set voices;
 *  `avoid` holds ids playing other slots; `rand` is injectable for tests.
 *  → slot → {id, name, age}. */
// The age only when known, so a cast without ages keeps its old shape.
const withAge = (v, age) => (age ? { ...v, age } : v);
export function pickCast({ slots, set = {}, pools = {}, names = {}, ages = {}, avoid = [], rand = Math.random }) {
  const cast = {};
  const taken = new Set(avoid);
  for (const slot of slots) {
    const id = set[slot];
    if (id) {
      cast[slot] = withAge({ id, name: names[id] ?? id }, ages[id]);
      taken.add(id);
    }
  }
  for (const slot of slots) {
    if (cast[slot]) continue;
    const gender = slot.split(":")[1];
    // A pool drawn for this very slot (an age was asked for) comes first.
    const pool = pools[slot]?.length ? pools[slot] : pools[gender]?.length ? pools[gender] : [...(pools.female ?? []), ...(pools.male ?? [])];
    if (!pool.length) continue;
    const fresh = pool.filter((v) => !taken.has(v.id));
    const from = fresh.length ? fresh : pool;
    const pick = from[Math.floor(rand() * from.length)];
    cast[slot] = withAge({ id: pick.id, name: pick.name }, pick.age || ages[pick.id]);
    taken.add(pick.id);
  }
  return cast;
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
        if (!SLOT_RE.test(s) || typeof id !== "string" || !id.trim() || id.length > 200) continue;
        ((voices[p] ??= {})[loc] ??= {})[s] = id.trim();
      }
    }
  }
  // A choice saved before voices were split by gender ("narrator") spoke
  // every narrator line, so it becomes both gendered slots unless one is
  // already set. Migrating here (rather than only falling back in voiceFor)
  // means the pickers see the slots as filled and never auto-pick over it.
  for (const byLocale of Object.values(voices)) {
    for (const set of Object.values(byLocale)) {
      for (const key of Object.keys(set)) {
        if (key.includes(":")) continue;
        for (const g of GENDERS) set[`${key}:${g}`] ??= set[key];
        delete set[key];
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
    review: typeof r.review === "boolean" ? r.review : false,
    handsFree: typeof r.handsFree === "boolean" ? r.handsFree : false,
    voices,
  };
}
