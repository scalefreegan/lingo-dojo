#!/usr/bin/env node
// The proof for the local tone scorer (scripts/pronunciation.mjs): how often
// is it right, and above all how often is an "off" flag a false alarm?
// Writes docs/pronunciation-proof.md. Not part of `npm test`.
//
//   node scripts/pronunciation-proof.mjs              score the cached clips, write the report
//   node scripts/pronunciation-proof.mjs --say        first make the free macOS `say` clips
//   node scripts/pronunciation-proof.mjs --fetch      first buy the missing ElevenLabs clips (PAID)
//   node scripts/pronunciation-proof.mjs --scribe     first buy Scribe timings for the phrases (PAID)
//   node scripts/pronunciation-proof.mjs --azure      first send the clips to Azure pronunciation assessment (PAID / free-tier quota)
//   node scripts/pronunciation-proof.mjs --dump       also print every syllable's verdict
//
// Without a flag nothing leaves this machine and nothing is paid for.
// --fetch and --scribe use the app's own ElevenLabs requests
// (scripts/voice.mjs), --azure the engine's own Azure request, one at a
// time; the keys come from .env.local (or LINGO_ENV_FILE) and are never
// printed or written. Clips are cached under
// data/pronunciation-proof/ (gitignored; LINGO_PROOF_DIR overrides), so a
// rerun costs nothing.
//
// There are no learner recordings to test on, so the samples are
// synthesized, and each clip is used twice over: scored against its own
// text it is a right answer (any "off" is a false alarm); scored against
// the same syllables with one tone changed it is a wrong answer (an "off"
// on that syllable is a catch). 妈 labelled 马 is a learner saying mā for mǎ.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  AZURE_RULES, FALLBACK_TRUST, TONE_RULES, alignTimings, azurePronunciationRequest, azurePronunciationResult, mergeAzure, pronunciationProvider, applySandhi, expectedSyllables, parsePinyin, parseWav, scoreTones, scribeCharTimings, speakerRange,
  trackPitch, withTone,
} from "./pronunciation.mjs";
import { DEFAULT_ELEVEN_MODEL, elevenLibrary, elevenLibraryRequest, elevenSpeechRequest,elevenVoices, elevenVoicesRequest, voiceKeys } from "./voice.mjs";
import { readCodePoints } from "../web/src/script/zh.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.LINGO_PROOF_DIR ? path.resolve(process.env.LINGO_PROOF_DIR) : path.join(REPO, "data", "pronunciation-proof");
const REPORT = path.join(REPO, "docs", "pronunciation-proof.md");
const args = new Set(process.argv.slice(2));
const LOCALE = "zh-CN";
// For trying other thresholds without editing the engine:
// LINGO_PROOF_RULES='{"sigmaSt":1.2}'. The report prints what it ran with.
const RULES = { ...TONE_RULES, ...JSON.parse(process.env.LINGO_PROOF_RULES || "{}") };

// ma / shi / yi / ba in each tone: sixteen single syllables.
const SINGLES = [..."妈麻马骂诗十使是衣姨椅意八拔把爸"];
// Short phrases, the connected-speech rules among them: third-tone sandhi
// (你好, 很好, 我很好, 我想喝水), 不 (不是, 不客气, 他不来), 一 (一个, 一起去,
// 一点点), the half third (我是学生, 很热), the neutral tone (谢谢, 什么).
const PHRASES = ["你好", "不是", "一个", "很好", "谢谢", "我很好", "不客气", "一起去", "你叫什么", "我想喝水", "明天见", "今天很热", "我是学生", "他不来", "再见"];

// macOS voices are free and local; a classic synthesizer, so its tones are
// textbook. Two, one of each sex, where installed.
const SAY_VOICES = [
  { id: "say-tingting", name: "Tingting (macOS)", say: "Tingting", gender: "female" },
  { id: "say-reed", name: "Reed (macOS)", say: "Reed (Chinese (China mainland))", gender: "male" },
];

const clipPath = (voice, text) => path.join(DIR, voice, `${text}.wav`);

/* --------------------------------- gathering -------------------------------- */

function toWav16k(input, output) {
  // ffmpeg when present, else macOS's own converter. Only this script
  // decodes MP3; the app's recordings arrive as WAV.
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output]);
  } catch {
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", input, output]);
  }
}

function makeSayClips() {
  for (const v of SAY_VOICES) {
    fs.mkdirSync(path.join(DIR, v.id), { recursive: true });
    let made = 0;
    for (const text of [...SINGLES, ...PHRASES]) {
      const out = clipPath(v.id, text);
      if (fs.existsSync(out)) continue;
      try {
        execFileSync("say", ["-v", v.say, "-o", out, "--data-format=LEI16@16000", text]);
        made++;
      } catch (e) {
        console.error(`say: ${v.say} unavailable (${String(e.message).split("\n")[0]})`);
        break;
      }
    }
    console.log(`${v.name}: ${made} new clips`);
  }
}

async function paid(request, what) {
  // A call that hangs is tried again (the provider bills what it delivers);
  // a refusal is not.
  for (let attempt = 1; ; attempt++) {
    let r;
    try {
      r = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(45_000) });
    } catch (e) {
      if (attempt >= 3) throw new Error(`${what}: no answer after ${attempt} tries (${e.name})`);
      continue;
    }
    // The body of an error can echo request details; the status is enough.
    if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`);
    return r;
  }
}

/** One woman and one man to synthesize with: native Mandarin voices from
 *  the account, else the most used cmn-CN voices of the shared Voice
 *  Library (usable by id on a paid plan, as the session cast does), else
 *  two of ElevenLabs' premade multilingual voices by their public ids.
 *  Each lookup gets twenty seconds: a listing that hangs must not stop a
 *  run whose speech calls work. */
async function pickElevenVoices(key) {
  const picked = [];
  const need = (g) => !picked.some((v) => v.gender === g);
  const quick = async (request) => {
    const r = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  try {
    const list = elevenVoices(await quick(elevenVoicesRequest({ key })), LOCALE).filter((v) => v.match);
    for (const g of ["female", "male"]) {
      const v = list.find((x) => x.gender.toLowerCase() === g);
      if (v) picked.push({ id: `eleven-${v.id}`, voice: v.id, name: `${v.name} (ElevenLabs, account voice)`, gender: g });
    }
  } catch (e) {
    console.error(`ElevenLabs: the account's voice list did not answer (${e.name === "TimeoutError" ? "timed out" : e.message}); trying the Voice Library`);
  }
  for (const g of ["female", "male"]) {
    if (!need(g)) continue;
    try {
      const v = elevenLibrary(await quick(elevenLibraryRequest({ key, locale: LOCALE, gender: g, pageSize: 5 }))).voices[0];
      if (v) picked.push({ id: `eleven-${v.id}`, voice: v.id, name: `${v.name} (ElevenLabs Voice Library, ${v.locale || "zh"})`, gender: g });
    } catch (e) {
      console.error(`ElevenLabs: the Voice Library did not answer for a ${g} voice (${e.name === "TimeoutError" ? "timed out" : e.message})`);
    }
  }
  const PREMADE = { female: ["21m00Tcm4TlvDq8ikWAM", "Rachel"], male: ["pNInz6obpgDQGcFmaJgB", "Adam"] };
  for (const g of ["female", "male"]) {
    if (need(g)) picked.push({ id: `eleven-${PREMADE[g][0]}`, voice: PREMADE[g][0], name: `${PREMADE[g][1]} (ElevenLabs premade: an English voice speaking Mandarin)`, gender: g });
  }
  return picked;
}

async function fetchElevenClips() {
  const keys = voiceKeys();
  if (!keys.elevenlabs) throw new Error("no ELEVENLABS_API_KEY (set LINGO_ENV_FILE to the .env.local that has it)");
  const metaFile = path.join(DIR, "eleven-voices.json");
  fs.mkdirSync(DIR, { recursive: true });
  let voices = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : null;
  if (!voices) {
    voices = await pickElevenVoices(keys.elevenlabs);
    fs.writeFileSync(metaFile, JSON.stringify(voices, null, 2));
  }
  let bought = 0;
  for (const v of voices) {
    fs.mkdirSync(path.join(DIR, v.id), { recursive: true });
    for (const text of [...SINGLES, ...PHRASES]) {
      const out = clipPath(v.id, text);
      if (fs.existsSync(out)) continue;
      const r = await paid(elevenSpeechRequest({ key: keys.elevenlabs, voice: v.voice, text, model: DEFAULT_ELEVEN_MODEL, locale: LOCALE }), `speech ${text}`);
      const mp3 = out.replace(/\.wav$/, ".mp3");
      fs.writeFileSync(mp3, Buffer.from(await r.arrayBuffer()));
      toWav16k(mp3, out);
      fs.rmSync(mp3);
      bought++;
    }
  }
  console.log(`ElevenLabs: ${bought} clips bought (${voices.map((v) => v.name).join(", ")})`);
}

/** Scribe's reply for every cached clip: per-character timings for the
 *  phrases (and the check of what Scribe actually returns for Chinese), and
 *  for the single syllables a second opinion on the label: which character
 *  did a speech recognizer hear? */
async function fetchScribeTimings() {
  const keys = voiceKeys();
  if (!keys.elevenlabs) throw new Error("no ELEVENLABS_API_KEY");
  let bought = 0;
  for (const v of voiceDirs()) {
    for (const text of [...PHRASES, ...SINGLES]) {
      const wav = clipPath(v.id, text);
      const out = wav.replace(/\.wav$/, ".scribe.json");
      if (!fs.existsSync(wav) || fs.existsSync(out)) continue;
      // The app's own request (elevenTranscribeRequest) plus the one field
      // a later stage would add to it.
      const form = new FormData();
      form.append("model_id", "scribe_v2");
      form.append("tag_audio_events", "false");
      form.append("language_code", "zh");
      form.append("timestamps_granularity", "character");
      form.append("file", new Blob([fs.readFileSync(wav)], { type: "audio/wav" }), "turn.wav");
      const r = await paid({ url: "https://api.elevenlabs.io/v1/speech-to-text", init: { method: "POST", headers: { "xi-api-key": keys.elevenlabs }, body: form } }, `scribe ${text}`);
      fs.writeFileSync(out, JSON.stringify(await r.json()));
      bought++;
    }
  }
  console.log(`Scribe: ${bought} transcriptions bought`);
}

/** The other three tones of a single syllable's set: 妈 → 麻 马 骂. */
function minimalPairs(text) {
  const at = SINGLES.indexOf(text);
  if (at < 0) return [];
  const from = at - (at % 4);
  return SINGLES.slice(from, from + 4).filter((t) => t !== text);
}

const azurePath = (voice, text, ref) => path.join(DIR, voice, `${text}.azure.${ref}.json`);

/** Azure's reply for every cached clip against its own text, and for each
 *  single syllable against the other three tones of the same syllable (a
 *  wrong-tone sample: the audio of 妈 with 马 as the reference). One request
 *  at a time with a pause between, for the free tier's rate limit; a 429
 *  waits and tries again. */
async function fetchAzure() {
  const keys = voiceKeys();
  if (pronunciationProvider(keys) !== "azure") throw new Error("no AZURE_SPEECH_KEY / AZURE_SPEECH_REGION");
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  let bought = 0;
  for (const v of voiceDirs()) {
    for (const text of [...SINGLES, ...PHRASES]) {
      const wav = clipPath(v.id, text);
      if (!fs.existsSync(wav)) continue;
      for (const ref of [text, ...minimalPairs(text)]) {
        const out = azurePath(v.id, text, ref);
        if (fs.existsSync(out)) continue;
        const request = azurePronunciationRequest({ key: keys.azureKey, region: keys.azureRegion, audio: fs.readFileSync(wav), locale: LOCALE, referenceText: ref });
        for (let attempt = 1; ; attempt++) {
          const r = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(30_000) });
          if (r.status === 429 && attempt < 4) {
            await pause(20_000);
            continue;
          }
          if (!r.ok) throw new Error(`azure ${text}/${ref}: HTTP ${r.status}`);
          fs.writeFileSync(out, JSON.stringify(await r.json()));
          break;
        }
        bought++;
        await pause(1200);
      }
    }
  }
  console.log(`Azure: ${bought} assessments made`);
}

function voiceDirs() {
  const meta = [...SAY_VOICES];
  const file = path.join(DIR, "eleven-voices.json");
  if (fs.existsSync(file)) meta.push(...JSON.parse(fs.readFileSync(file, "utf8")));
  return meta.filter((v) => fs.existsSync(path.join(DIR, v.id)));
}

/* ---------------------------------- scoring --------------------------------- */

/** Every way to label a clip: its own text, and each syllable in each
 *  other tone (the rules re-applied, since a changed tone changes its
 *  neighbours' sandhi). A syllable of a relabelling is "wrong" when no tone
 *  the label accepts is one the true text accepts there. */
function labellings(text) {
  const truth = expectedSyllables(text, readCodePoints(text, LOCALE));
  const out = [{ kind: "right", syllables: truth, wrongAt: new Set() }];
  truth.forEach((s, i) => {
    if (s.baseTone === 0) return;
    for (const tone of [1, 2, 3, 4]) {
      if (tone === s.baseTone) continue;
      // A relabelled 一 or 不 would still trigger its own sandhi by its
      // character; the mutation is of the tone, so drop the character's
      // special status with it.
      const mutated = truth.map((x, k) => (k === i
        ? { char: x.char === "一" || x.char === "不" ? "〓" : x.char, pinyin: withTone(x.pinyin, tone), baseTone: tone, breakBefore: x.breakBefore }
        : { char: x.char, pinyin: x.pinyin, baseTone: x.baseTone, breakBefore: x.breakBefore }));
      const syllables = applySandhi(mutated);
      const wrongAt = new Set();
      syllables.forEach((m, k) => {
        if (!m.accept.some((t) => truth[k].accept.includes(t))) wrongAt.add(k);
      });
      if (wrongAt.size) out.push({ kind: "wrong", syllables, wrongAt });
    }
  });
  return { truth, list: out };
}

const tally = () => ({
  right: { ok: 0, unsure: 0, off: 0 },
  wrong: { ok: 0, unsure: 0, off: 0 },
  confusion: Object.fromEntries([1, 2, 3, 4].map((t) => [t, { 1: 0, 2: 0, 3: 0, 4: 0, none: 0 }])),
  reasons: {},
  falseAlarms: [],
});

function scoreAll(voices, texts, { baseline, timings, key = "" }) {
  const t = tally();
  for (const v of voices) {
    for (const text of texts) {
      const clip = v.clips.get(text);
      if (!clip) continue;
      const { truth, list } = labellings(text);
      // Scribe's character times, used the two ways a caller could: as
      // the syllables' extents (which they turn out not to be) and as a
      // point inside each syllable for the energy cuts to respect.
      let cuts = null;
      let anchors = null;
      if (timings === "scribe" || timings === "anchored") {
        if (!clip.scribe) continue;
        const timed = alignTimings(truth, scribeCharTimings(clip.scribe));
        if (timings === "scribe") cuts = timed;
        else anchors = timed.map((t) => t?.startMs ?? null);
      }
      for (const label of list) {
        const res = scoreTones({ samples: clip.samples, sampleRate: clip.sampleRate, syllables: label.syllables, timings: cuts, anchors, speaker: baseline ? v.range : null, track: clip.track, rules: RULES });
        res.syllables.forEach((s, k) => {
          // The neutral tone is not judged: leave it out of every count.
          if (truth[k].expectedTone === 0 || label.syllables[k].expectedTone === 0) return;
          const side = label.wrongAt.has(k) ? "wrong" : "right";
          // Each syllable counts once as right (under its own text), and
          // once per relabelling that makes it wrong.
          if (side === "right" && label.kind !== "right") return;
          t[side][s.verdict]++;
          if (s.verdict === "unsure") t.reasons[s.reason] = (t.reasons[s.reason] ?? 0) + 1;
          if (side === "right" && s.verdict === "off") t.falseAlarms.push(`${v.name} ${text}[${k + 1}] ${s.char} expected ${s.expectedTone} heard ${s.heardTone}`);
          if (label.kind === "right") t.confusion[truth[k].expectedTone][s.heardTone ?? "none"]++;
          if (args.has("--dump") && label.kind === "right" && key) console.log(key, v.id, text, k, s.char, "exp", s.expectedTone, "heard", s.heardTone, s.verdict, s.reason ?? "", JSON.stringify(s.belief ?? {}), s.quality ?? "", `${s.startMs}-${s.endMs}`);
        });
      }
    }
  }
  return t;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");

/** The line of numbers for one condition. Precision as measured depends on
 *  how many wrong labels the set happens to hold (three per right one), so
 *  it is also restated for a learner who gets one tone in five wrong. */
function summary(t) {
  const right = t.right.ok + t.right.unsure + t.right.off;
  const wrong = t.wrong.ok + t.wrong.unsure + t.wrong.off;
  const offs = t.right.off + t.wrong.off;
  const recall = wrong ? t.wrong.off / wrong : 0;
  const alarm = right ? t.right.off / right : 0;
  const at20 = 0.2 * recall + 0.8 * alarm > 0 ? (0.2 * recall) / (0.2 * recall + 0.8 * alarm) : NaN;
  return {
    right, wrong,
    precision: pct(t.wrong.off, offs),
    precisionAt20: Number.isNaN(at20) ? "n/a" : `${(100 * at20).toFixed(1)}%`,
    falseAlarms: `${t.right.off} of ${right} (${pct(t.right.off, right)})`,
    caught: `${t.wrong.off} of ${wrong} (${pct(t.wrong.off, wrong)})`,
    missedAsOk: pct(t.wrong.ok, wrong),
    rightOk: pct(t.right.ok, right),
    unsure: pct(t.right.unsure + t.wrong.unsure, right + wrong),
    unsureRight: pct(t.right.unsure, right),
  };
}

function confusionTable(t) {
  const rows = ["| said \\ heard | 1 | 2 | 3 | 4 | nothing | right |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const tone of [1, 2, 3, 4]) {
    const r = t.confusion[tone];
    const total = r[1] + r[2] + r[3] + r[4] + r.none;
    rows.push(`| tone ${tone} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} | ${r.none} | ${pct(r[tone], total)} |`);
  }
  return rows.join("\n");
}

/* ------------------------------------ main ---------------------------------- */

if (args.has("--say")) makeSayClips();
// A provider that stops answering part-way must not lose the run: what was
// bought is cached, and the report is written from whatever is there.
for (const [flag, step] of [["--fetch", fetchElevenClips], ["--scribe", fetchScribeTimings], ["--azure", fetchAzure]]) {
  if (!args.has(flag)) continue;
  try {
    await step();
  } catch (e) {
    console.error(`${flag} stopped early: ${e.message}. Rerun to fetch the rest; scoring what is cached.`);
  }
}

const voices = voiceDirs().map((v) => {
  const clips = new Map();
  for (const text of [...SINGLES, ...PHRASES]) {
    const file = clipPath(v.id, text);
    if (!fs.existsSync(file)) continue;
    const { samples, sampleRate } = parseWav(fs.readFileSync(file));
    const scribeFile = file.replace(/\.wav$/, ".scribe.json");
    clips.set(text, { samples, sampleRate, track: trackPitch(samples, sampleRate), scribe: fs.existsSync(scribeFile) ? JSON.parse(fs.readFileSync(scribeFile, "utf8")) : null });
  }
  // What a session would have learnt of this voice after a few turns.
  return { ...v, clips, range: speakerRange([...clips.values()].map((c) => c.track)) };
}).filter((v) => v.clips.size);

if (!voices.length) {
  console.error(`No clips in ${DIR}. Run with --say (free) and/or --fetch (paid).`);
  process.exit(1);
}

const conditions = [
  { key: "single", title: "Single syllables, nothing known about the speaker", texts: SINGLES, baseline: false, timings: "fallback" },
  { key: "singleBase", title: "Single syllables, speaker's range known", texts: SINGLES, baseline: true, timings: "fallback" },
  { key: "phrase", title: "Phrases, cut by energy, nothing known about the speaker", texts: PHRASES, baseline: false, timings: "fallback" },
  { key: "phraseBase", title: "Phrases, cut by energy, speaker's range known", texts: PHRASES, baseline: true, timings: "fallback" },
  { key: "phraseAnchored", title: "Phrases, cut by energy around Scribe's character times, speaker's range known", texts: PHRASES, baseline: true, timings: "anchored" },
  { key: "phraseScribe", title: "Phrases, Scribe's character times taken as the cuts, speaker's range known", texts: PHRASES, baseline: true, timings: "scribe" },
];
const haveScribe = voices.some((v) => [...v.clips.values()].some((c) => c.scribe));
const results = conditions.filter((c) => c.timings === "fallback" || haveScribe).map((c) => ({ ...c, tally: scoreAll(voices, c.texts, c) }));
const perVoice = voices.map((v) => ({ name: v.name, range: v.range, single: summary(scoreAll([v], SINGLES, { baseline: true, timings: "fallback" })), phrase: summary(scoreAll([v], PHRASES, { baseline: true, timings: "fallback" })) }));

// What Scribe's timings look like for Chinese, from the cached replies.
let scribeNote = "No Scribe replies are cached: run with `--scribe` (paid) to measure.";
if (haveScribe) {
  let clips = 0, words = 0, multi = 0, withChars = 0, matched = 0, total = 0, inside = 0;
  const spans = [];
  for (const v of voices) {
    for (const [text, clip] of v.clips) {
      if (!clip.scribe || !PHRASES.includes(text)) continue;
      clips++;
      for (const w of clip.scribe.words ?? []) {
        if (w.type !== "word" || !/\p{Script=Han}/u.test(w.text)) continue;
        words++;
        if ([...w.text].length > 1) multi++;
        if (Array.isArray(w.characters) && w.characters.length) withChars++;
      }
      const truth = expectedSyllables(text, readCodePoints(text, LOCALE));
      const timed = alignTimings(truth, scribeCharTimings(clip.scribe));
      // Where the energy cuts put each syllable, to compare Scribe against.
      const energy = scoreTones({ samples: clip.samples, sampleRate: clip.sampleRate, syllables: truth, track: clip.track }).syllables;
      total += truth.length;
      timed.forEach((t, k) => {
        if (!t) return;
        matched++;
        spans.push(t.endMs - t.startMs);
        if (energy[k].startMs !== null && t.startMs >= energy[k].startMs && t.startMs < energy[k].endMs) inside++;
      });
    }
  }
  spans.sort((x, y) => x - y);
  const med = spans.length ? Math.round(spans[spans.length >> 1]) : 0;
  const tiny = spans.filter((x) => x <= 40).length;
  scribeNote = `${clips} phrase clips were transcribed by Scribe v2 with \`timestamps_granularity=character\` (the app sends no such field today, and \`transcriptText\` keeps only \`text\`). For Chinese the reply has one \`words\` entry per character: ${words} entries, ${multi} longer than one character, ${withChars} carrying a \`characters\` array. ${matched} of ${total} expected syllables found their character in the transcript.\n\nThe times are not syllable boundaries. The median character span is ${med} ms and ${tiny} of ${spans.length} are 40 ms or shorter, in clips whose syllables last 150 to 300 ms: Scribe reports roughly when it recognized each character. Taken as cuts they leave most syllables too short to score (the last column of the table above). But ${inside} of ${matched} character start times fall inside the stretch the energy cuts give that syllable, so they work as anchors: \`scoreTones({ anchors })\` cuts by energy and keeps each piece on its character's time. On these short, pause-free clips that changes little; its use is longer speech with pauses, which this set does not contain.`;
}

// Would a recognizer do as a second opinion on the single-syllable labels?
// The tone of the character Scribe wrote down for each clip, against the
// label. (It turns out not to: a recognizer writes the likeliest word, which
// is the generosity this feature exists to get around.)
let labelNote = "";
{
  const odd = [];
  let checked = 0;
  for (const v of voices) {
    for (const text of SINGLES) {
      const clip = v.clips.get(text);
      if (!clip?.scribe) continue;
      checked++;
      const heard = String(clip.scribe.text ?? "").trim();
      const said = expectedSyllables(text, readCodePoints(text, LOCALE))[0];
      const got = expectedSyllables(heard, readCodePoints(heard, LOCALE));
      if (got.length !== 1 || got[0].baseTone !== said.baseTone) odd.push(`${v.name.split(" (")[0]} ${text} (${said.pinyin}) → "${heard}"${got.length === 1 ? ` (${got[0].pinyin})` : ""}`);
    }
  }
  if (checked) {
    labelNote = `Scribe is no second opinion here: of ${checked} single-syllable clips it wrote one character in the labelled tone for ${checked - odd.length}`
      + (odd.length ? `, and for the rest the commonest word that fits or nothing at all (${odd.slice(0, 8).join("; ")}${odd.length > 8 ? "; …" : ""}). That is the generosity this feature exists to get around, and it means the labels stay unchecked.` : ".");
  }
}

// Azure, live: what the service said about the same clips, on its own and
// merged with the local tone check (mergeAzure, the speaker's range known).
let azureSection = null;
{
  const group = () => ({ n: 0, scores: [], flagged: 0, under50: 0, mergedOff: 0, mergedTone: 0, mergedSound: 0, mergedOk: 0, mergedUnsure: 0, local: { off: 0 } });
  const g = { singleRight: group(), singleWrong: group(), phraseRight: group() };
  let replies = 0;
  let failed = 0;
  let example = null;
  const layouts = { flat: 0, nested: 0, multiCharWords: 0, words: 0, syllablePhonemes: 0, phonemeWords: 0 };
  for (const v of voices) {
    for (const [text, clip] of v.clips) {
      for (const ref of [text, ...minimalPairs(text)]) {
        const file = azurePath(v.id, text, ref);
        if (!fs.existsSync(file)) continue;
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        replies++;
        const azure = azurePronunciationResult(raw);
        if (azure.status !== "Success" || !azure.words.length) {
          failed++;
          continue;
        }
        if (raw.NBest?.[0]?.PronunciationAssessment) layouts.nested++;
        else layouts.flat++;
        for (const w of azure.words) {
          const chars = [...w.text].filter((c) => /\p{Script=Han}/u.test(c)).length;
          if (!chars) continue;
          layouts.words++;
          if (chars > 1) layouts.multiCharWords++;
          layouts.phonemeWords++;
          if (w.phonemes.length === chars && w.phonemes.every((ph) => ph.tone !== null)) layouts.syllablePhonemes++;
        }
        const syllables = expectedSyllables(ref, readCodePoints(ref, LOCALE));
        const args = { samples: clip.samples, sampleRate: clip.sampleRate, syllables, speaker: v.range, track: clip.track, rules: RULES };
        const merged = mergeAzure({ azure, syllables, local: (timings) => scoreTones({ ...args, timings }), track: clip.track });
        const alone = scoreTones(args);
        const right = ref === text;
        const into = g[SINGLES.includes(text) ? (right ? "singleRight" : "singleWrong") : "phraseRight"];
        if (!right && !example && text === "妈" && ref === "马") example = raw;
        merged.syllables.forEach((m, k) => {
          if (syllables[k].expectedTone === 0) return;
          into.n++;
          if (typeof m.score === "number") into.scores.push(m.score);
          if (m.azureError === "Mispronunciation") into.flagged++;
          if (typeof m.score === "number" && m.score < AZURE_RULES.offBelow) into.under50++;
          if (m.verdict === "off") {
            into.mergedOff++;
            if (m.reason === "tone") into.mergedTone++;
            else into.mergedSound++;
          } else if (m.verdict === "ok") into.mergedOk++;
          else into.mergedUnsure++;
          if (alone.syllables[k].verdict === "off") into.local.off++;
        });
      }
    }
  }
  if (replies) {
    const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);
    const line = (label, x, wrong) => `| ${label} | ${x.n} | ${med(x.scores)} | ${x.flagged} (${pct(x.flagged, x.n)}) | ${x.under50} (${pct(x.under50, x.n)}) | ${x.local.off} (${pct(x.local.off, x.n)}) | ${x.mergedOff} (${pct(x.mergedOff, x.n)}): ${x.mergedTone} tone, ${x.mergedSound} sound | ${wrong ? "caught" : "false alarms"} |`;
    const prec = (hit, alarm) => pct(hit, hit + alarm);
    azureSection = [
      `${replies} live replies from Azure Pronunciation Assessment (\`zh-CN\`, the REST short-audio endpoint in \`${"<region>"}.stt.speech.microsoft.com\`, free F0 tier, one request at a time)${failed ? `, ${failed} of them with nothing recognised` : ""}. Every clip was assessed against its own text; each single syllable also against the other three tones of the same syllable, which is the wrong-tone sample: the audio of 妈 with 马 as the reference text. There are no wrong-tone phrase samples for Azure (it needs real characters as the reference, and the proof's phrase relabellings are pinyin only).`,
      "",
      `| | Syllables | Azure's median score | Azure marks the word \`Mispronunciation\` | Azure score under ${AZURE_RULES.offBelow} | Local scorer alone flags | Merged result flags | which are |`,
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      line("Singles, right reference", g.singleRight, false),
      line("Singles, wrong-tone reference", g.singleWrong, true),
      line("Phrases, right reference", g.phraseRight, false),
      "",
      `On the single syllables, precision of a flag as measured (three wrong for each right): Azure's own \`Mispronunciation\` mark ${prec(g.singleWrong.flagged, g.singleRight.flagged)}, the local scorer ${prec(g.singleWrong.local.off, g.singleRight.local.off)}, the merged result ${prec(g.singleWrong.mergedOff, g.singleRight.mergedOff)}. The merged result flags on the local pitch check, or on Azure's \`Mispronunciation\` mark with a score under ${AZURE_RULES.offBelow}.`,
      "",
      `What the replies look like for Mandarin (${layouts.flat} flat, ${layouts.nested} with a nested \`PronunciationAssessment\` object): scores sit directly on the \`NBest\` entry, the word and the phoneme. ${layouts.multiCharWords} of ${layouts.words} words are longer than one character (你好, 学生: Azure segments into words). In ${layouts.syllablePhonemes} of ${layouts.phonemeWords} words the \`Phonemes\` array has exactly one entry per character: a "phoneme" is a whole syllable with its tone as a digit (\`ni 3\`, \`hao 3\`; 5 is neutral), with its own offset, duration and score. That digit is the tone of the **reference** reading (the dictionary tone, before sandhi; for a character with several readings, one of them), not the tone that was heard: Azure does not report a heard tone. \`DisplayText\` echoes the reference too. What a wrong tone changes is the score.`,
      "",
      example ? `A wrong-tone sample, verbatim (Tingting's 妈, mā, assessed against 马, mǎ):\n\n\`\`\`json\n${JSON.stringify(example)}\n\`\`\`` : "",
    ].join("\n");
  }
}

// Time to score a 3-second recording: a phrase clip looped to length.
const longest = [...voices[0].clips.entries()].filter(([t]) => PHRASES.includes(t)).sort((a, b) => b[1].samples.length - a[1].samples.length)[0];
let timing = "n/a";
if (longest) {
  const [text, clip] = longest;
  const three = new Float32Array(clip.sampleRate * 3);
  for (let i = 0; i < three.length; i++) three[i] = clip.samples[i % clip.samples.length];
  const syllables = expectedSyllables(text, readCodePoints(text, LOCALE));
  const runs = [];
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now();
    scoreTones({ samples: three, sampleRate: clip.sampleRate, syllables });
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  timing = `${runs[runs.length >> 1].toFixed(0)} ms (median of 12; slowest ${runs.at(-1).toFixed(0)} ms)`;
}

const clipCount = voices.reduce((n, v) => n + v.clips.size, 0);
const lines = [];
const p = (...s) => lines.push(...s, "");
p("# Pronunciation scoring: proof of the local tone scorer");
p(`Written by \`node scripts/pronunciation-proof.mjs\` on ${new Date().toISOString().slice(0, 10)}. Rerun it to refresh; the clips are cached, so a rerun is free. Stage 0 of the pronunciation feature (bead ld-ne0.1); the engine is \`scripts/pronunciation.mjs\`, described in [VOICE.md](VOICE.md#pronunciation).`);
p("## What was tested");
p(`${clipCount} synthesized clips from ${voices.length} voices: ${voices.map((v) => `${v.name}, ${v.gender}${v.range ? `, median ${v.range.medianHz.toFixed(0)} Hz` : ""}`).join("; ")}. Each voice says ${SINGLES.length} single syllables (ma, shi, yi, ba in each of the four tones: ${SINGLES.join(" ")}) and ${PHRASES.length} phrases (${PHRASES.join("、")}).`);
p("There are no learner recordings, so every clip is used twice over. Scored against its own text it is a **right** answer: an \"off\" there is a false alarm. Scored against the same syllables with one tone changed it is a **wrong** answer: 妈 labelled 马 is a learner who said mā for mǎ, and an \"off\" on that syllable is a catch. The connected-speech rules are applied to each label first, so a relabelling that the rules make equivalent (你 as ní before 好) is not counted as wrong. Syllables whose true or labelled tone is neutral are left out: the scorer does not judge them.");
p("The number that matters is how many \"off\" flags are false: a learner told a right tone was wrong stops believing the marks. A miss costs less. The set holds about three wrong labels for each right one, which flatters raw precision, so each table also restates it for a learner who gets one tone in five wrong.");
p("## Results");
const head = ["| | Singles, speaker unknown | Singles, range known | Phrases, speaker unknown | Phrases, range known" + (haveScribe ? " | Phrases, Scribe anchors, range known | Phrases, Scribe times as cuts, range known |" : " |")];
head.push(`| --- | --- | --- | --- | ---${haveScribe ? " | --- | --- |" : " |"}`);
const sums = results.map((r) => summary(r.tally));
const row = (label, f) => `| ${label} | ${sums.map(f).join(" | ")} |`;
p([
  ...head,
  row("Right syllables scored", (s) => s.right),
  row("Wrong syllables scored", (s) => s.wrong),
  row("**False alarms** (right, flagged off)", (s) => s.falseAlarms),
  row("**Precision of an off flag**, as measured", (s) => s.precision),
  row("Precision at one wrong tone in five", (s) => s.precisionAt20),
  row("Wrong tones caught (flagged off)", (s) => s.caught),
  row("Wrong tones passed as ok", (s) => s.missedAsOk),
  row("Right tones marked ok", (s) => s.rightOk),
  row("Right tones marked unsure", (s) => s.unsureRight),
  row("Marked unsure, all", (s) => s.unsure),
].join("\n"));
{
  // What a small count can and can't show: the exact 95% upper bound on the
  // false-alarm rate when k of n right syllables were flagged (k = 0 is the
  // "rule of three", about 3/n).
  const upper = (k, n) => {
    if (!n) return NaN;
    const tail = (q) => {
      let sum = 0;
      let term = (1 - q) ** n;
      for (let i = 0; i <= k; i++) {
        sum += term;
        term *= ((n - i) / (i + 1)) * (q / (1 - q));
      }
      return sum;
    };
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (tail(mid) > 0.05) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  const bounds = results.map((r, i) => `${r.title.toLowerCase()}: ${r.tally.right.off} of ${sums[i].right}, so under ${(100 * upper(r.tally.right.off, sums[i].right)).toFixed(1)}%`);
  p(`These are small counts. A false-alarm rate measured on a few dozen or a couple of hundred syllables is only bounded, not known: with 95% confidence, ${bounds.join("; ")}. And that bound is for voices like these, on the set the thresholds were tuned on.`);
}
p("\"Range known\" gives the scorer the voice's pitch range measured over all of that voice's clips, which is what a session would know after a few turns. \"Speaker unknown\" is a first recording: only the shape of the contour counts, plus the recording's own range once it holds four syllables.");
for (const r of results) {
  p(`### ${r.title}`);
  p("Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:");
  p(confusionTable(r.tally));
  const reasons = Object.entries(r.tally.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  if (reasons) p(`Why syllables were unsure (all labels): ${reasons}.`);
  if (r.tally.falseAlarms.length) p(`False alarms: ${[...new Set(r.tally.falseAlarms)].slice(0, 12).join("; ")}${r.tally.falseAlarms.length > 12 ? "; …" : ""}.`);
}
p("### By voice (range known, cut by energy)");
p(["| Voice | Singles: false alarms | Singles: caught | Phrases: false alarms | Phrases: caught |", "| --- | --- | --- | --- | --- |", ...perVoice.map((v) => `| ${v.name} | ${v.single.falseAlarms} | ${v.single.caught} | ${v.phrase.falseAlarms} | ${v.phrase.caught} |`)].join("\n"));
if (azureSection) {
  p("## Azure, live");
  p(azureSection);
}
p("## Scribe's timings");
p(scribeNote);
p("## Speed");
p(`Scoring a 3-second, 16 kHz recording on this machine (${process.arch}, Node ${process.version}): ${timing}. Nearly all of it is the pitch track.`);
p("## Settings this ran with");
p(`\`TONE_RULES\` = \`${JSON.stringify(RULES)}\`${process.env.LINGO_PROOF_RULES ? " (overridden by LINGO_PROOF_RULES: not the engine's defaults)" : ""}; cuts made by energy are trusted at ${FALLBACK_TRUST}.`);
p("## Limitations");
p([
  "- **Synthesized speech is not a learner.** These voices hit their tones cleanly, in quiet, at an even pace. A learner's wrong tone is rarely a clean other tone: it is a flat second tone, a fourth that barely falls, a third with no dip. Those land in \"unsure\" by design, so on real learners expect fewer catches than here, and treat the false-alarm rate as a floor until real recordings are scored.",
  "- **The wrong answers are other syllables' right answers**, not mistakes: they are well-formed tones, the easiest kind of wrong to spot.",
  "- **The thresholds were tuned on this same set.** There is no held-out data. The by-voice table shows the spread, not generalisation.",
  "- **Nobody has tested a child's voice.** The pitch tracker searches 60–600 Hz and tones are read against the speaker's own range, so nothing in the design excludes one, but no child (and no synthesized child) is in the set.",
  `- **The labels are trusted, not checked.** A synthesizer can misread a lone character, or say it with a sentence's falling intonation; nobody listened to these clips. A clip said in the wrong tone shows up as a miss or a false alarm that isn't the scorer's fault. ${labelNote || "Run with `--scribe` for a recognizer's second opinion on the single-syllable labels."}`,
  `- **${voices.length} voices, none of them a person.** No microphone, no room, no background noise.${voices.some((v) => /premade/.test(v.name)) ? " The ElevenLabs voices are premade English voices speaking Mandarin through the app's default model, not native Mandarin voices: the account's voice list and the Voice Library search did not answer when the clips were bought, so the script fell back to two public voice ids. Their lone syllables are the least textbook clips in the set: Rachel's 妈 holds level and then drops nine semitones, which the scorer hears as a fourth tone and which may well be one." : ""}`,
  "- **Free conversation is harder than these phrases**: faster, with tones squeezed by their neighbours, focus and sentence intonation on top, and cuts that depend on the transcript being right. The phrase numbers are an upper bound for it.",
  "- **Neutral tones are not judged**, and sandhi across word groups is taken leniently (both readings accepted), so some real mistakes can never be flagged.",
  azureSection
    ? "- **Azure is verified live for zh-CN only, on these same synthesized clips.** Not run: zh-TW, Spanish, a recording near the 30-second limit, a learner's voice. `AZURE_RULES` were set from these replies, so the same caveat about tuning applies."
    : "- **The Azure path is untested against the live service** in this run: no Azure replies are cached (`--azure`).",
].join("\n"));
fs.writeFileSync(REPORT, lines.join("\n").replace(/\n+$/, "\n"));
console.log(`Wrote ${path.relative(REPO, REPORT)}`);
for (const [i, r] of results.entries()) console.log(r.key.padEnd(13), JSON.stringify(sums[i]));
