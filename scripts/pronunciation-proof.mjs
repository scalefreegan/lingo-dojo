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
//   node scripts/pronunciation-proof.mjs --quick      skip the held-out threshold search (the slow part)
//   node scripts/pronunciation-proof.mjs --spans      print the "When the spans are wrong" table and stop (writes nothing)
//   node scripts/pronunciation-proof.mjs --noise      print the "With lead-in noise" tables and stop (writes nothing; with --dump, the syllables that flipped and why syllables were unsure)
//   LINGO_PROOF_AZURE_SPEAKER=<name> node scripts/pronunciation-proof.mjs --recordings --azure-recordings
//                                                     first send that ONE speaker's own recordings to Azure, for their syllable
//                                                     timings (a person's voice leaves this machine: only the speaker may decide
//                                                     that; never a child's clips; each clip once, the reply kept beside it)
//   node scripts/pronunciation-proof.mjs --fixtures   also rewrite the pitch-track fixtures the tests replay
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
// Your own recordings: `npm run pron:record` (scripts/pronunciation-record.mjs)
// records them into data/pronunciation-proof/recordings/ with a labels.tsv
// (see "Real recordings" in the report, or RECORDINGS_HELP below); they are
// scored on every run and never leave this machine. Their results are a
// person's, so they are printed and written to recordings/report.md
// (gitignored), never into the tracked report. --recordings
// (`npm run pron:proof`) scores only them and leaves the report alone.
//
// Until there are learner recordings to test on, the samples are
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
  AZURE_RULES, FALLBACK_TRUST, TIMING_RULES, TONE_RULES, TRIM_RULES, alignTimings, azurePronunciationRequest, azurePronunciationResult, mergeAzure, pronunciationProvider, applySandhi, encodeWav, expectedSyllables, parseWav, scoreTones, scribeCharTimings, speakerRange,
  trackPitch, trimToSpeech, withTone,
} from "./pronunciation.mjs";
import { PHRASES, SINGLES, azureSendable, buildPrompts, findSpeaker, parseLabels, recordingsReport, saidTones as readSaid } from "./pronunciation-recordings.mjs";
import { trackedByGit } from "./pronunciation-record.mjs";
import { GENERATED_CASES, GENERATED_PHRASES, GENERATED_VOICES, NOISE_CONDITIONS, RATE as SYNTH_RATE, SPAN_ERRORS, disturb, flips, sayCase, verdictsOf } from "./pronunciation-synth.mjs";
import { DEFAULT_ELEVEN_MODEL, elevenLibrary, elevenLibraryRequest, elevenSpeechRequest,elevenVoices, elevenVoicesRequest, voiceKeys } from "./voice.mjs";
import { readCodePoints } from "../web/src/script/zh.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.LINGO_PROOF_DIR ? path.resolve(process.env.LINGO_PROOF_DIR) : path.join(REPO, "data", "pronunciation-proof");
const REPORT = process.env.LINGO_PROOF_REPORT || path.join(REPO, "docs", "pronunciation-proof.md");
const args = new Set(process.argv.slice(2));
const LOCALE = "zh-CN";
// For trying other thresholds without editing the engine:
// LINGO_PROOF_RULES='{"sigmaSt":1.2}'. The report prints what it ran with.
const RULES = { ...TONE_RULES, ...JSON.parse(process.env.LINGO_PROOF_RULES || "{}") };

// SINGLES and PHRASES (pronunciation-recordings.mjs, shared with the
// recorder's prompt list): ma / shi / yi / ba in each tone, sixteen single
// syllables; and short phrases, the connected-speech rules among them:
// third-tone sandhi (你好, 很好, 我很好, 我想喝水), 不 (不是, 不客气, 他不来),
// 一 (一个, 一起去), the half third (我是学生, 很热), the neutral tone
// (谢谢, 什么).

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
const labelCache = new Map();
function labellings(text) {
  if (!labelCache.has(text)) labelCache.set(text, makeLabellings(text));
  return labelCache.get(text);
}
function makeLabellings(text) {
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
  pairs: {},
  why: {},
  falseAlarms: [],
});

function scoreAll(voices, texts, { baseline, timings, key = "", rules = RULES }) {
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
        const timed = alignTimings(truth, scribeOfClip(clip.scribe));
        if (timings === "scribe") cuts = timed;
        else anchors = timed.map((t) => t?.startMs ?? null);
      }
      for (const label of list) {
        const res = scoreTones({ samples: clip.samples, sampleRate: clip.sampleRate, syllables: label.syllables, timings: cuts, anchors, speaker: baseline ? clip.range : null, track: clip.track, rules });
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
          if (side === "wrong") {
            // Which tone was said for which: where the catches are and aren't.
            const pair = `${truth[k].expectedTone}→${label.syllables[k].expectedTone}`;
            const cell = (t.pairs[pair] ??= { n: 0, off: 0, ok: 0 });
            cell.n++;
            if (s.verdict === "off") cell.off++;
            if (s.verdict === "ok") cell.ok++;
            // Why a wrong tone got through.
            const why = s.verdict === "off" ? "caught"
              : s.reason === "short" || s.reason === "unvoiced" || s.reason === "untimed" ? "too little voiced sound"
              : s.reason === "creaky" || (s.verdict === "ok" && s.margin === null) ? "creak"
              : s.margin === null || s.margin < 0 ? (s.verdict === "ok" ? "contour fits the wrong label too (ok)" : "contour doesn't rule the label out (unsure)")
              : s.margin < rules.offMarginSt + ([...text].length === 1 ? 0 : rules.phraseMarginSt) ? "ruled out, margin too small"
              : s.voicedMs < rules.offMinMs ? "ruled out, voiced part too short"
              : "ruled out, measurement not clean enough";
            t.why[why] = (t.why[why] ?? 0) + 1;
          }
          if (label.kind === "right") t.confusion[truth[k].expectedTone][s.heardTone ?? "none"]++;
          if (args.has("--syllables") && label.kind === "right" && key) console.log(key, v.id, text, k, s.char, "exp", s.expectedTone, "heard", s.heardTone, s.verdict, s.reason ?? "", JSON.stringify(s.belief ?? {}), s.quality ?? "", `${s.startMs}-${s.endMs}`);
        });
      }
    }
  }
  return t;
}

/** The exact (Clopper–Pearson) 95% upper bound on a rate when k of n were
 *  seen: what a small count can and can't show. k = 0 is the "rule of
 *  three", about 3/n. */
function upperBound(k, n) {
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

// The synthesized clips begin with the first sound: no microphone
// recording does (push-to-talk is pressed before speaking), and the scorer
// takes a recording that is loud from its first frame for one that started
// mid-word (reason "clipped"). So each clip is scored with this much
// silence before it, and the recognisers' cached times, which are of the
// clip as it was sent, are moved by as much.
const LEAD_MS = 200;
const withLead = (samples, sampleRate) => {
  const lead = Math.round((sampleRate * LEAD_MS) / 1000);
  const out = new Float32Array(lead + samples.length);
  out.set(samples, lead);
  return out;
};
const later = (t) => (t && t.startMs !== null && t.startMs !== undefined ? { ...t, startMs: t.startMs + LEAD_MS, endMs: t.endMs + LEAD_MS } : t);
/** An Azure reply of a clip, parsed, on the scored clip's clock. */
const azureOfClip = (json) => {
  const azure = azurePronunciationResult(json);
  return { ...azure, words: azure.words.map((w) => ({ ...later(w), phonemes: w.phonemes.map(later) })) };
};
/** Scribe's character times of a clip, on the scored clip's clock. */
const scribeOfClip = (json) => scribeCharTimings(json).map(later);

const voices = voiceDirs().map((v) => {
  const clips = new Map();
  for (const text of [...SINGLES, ...PHRASES]) {
    const file = clipPath(v.id, text);
    if (!fs.existsSync(file)) continue;
    const wav = parseWav(fs.readFileSync(file));
    const sampleRate = wav.sampleRate;
    const samples = withLead(wav.samples, sampleRate);
    const scribeFile = file.replace(/\.wav$/, ".scribe.json");
    clips.set(text, { samples, sampleRate, track: trackPitch(samples, sampleRate), scribe: fs.existsSync(scribeFile) ? JSON.parse(fs.readFileSync(scribeFile, "utf8")) : null });
  }
  // What a session would have learnt of this voice after a few turns: its
  // range over every OTHER clip. The clip being scored is left out, so a
  // syllable is never read against a range it helped to set.
  for (const [text, clip] of clips) clip.range = speakerRange([...clips].filter(([t]) => t !== text).map(([, c]) => c.track));
  return { ...v, clips, range: speakerRange([...clips.values()].map((c) => c.track)) };
}).filter((v) => v.clips.size);

// (Scoring only the recordings needs none of them.)
if (!voices.length && !args.has("--recordings")) {
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

// With lead-in noise: the same clips with what a push-to-talk recording
// has around the speech (NOISE_CONDITIONS), the speaker's range known (the
// one from the clean clips: the surroundings are what is being tested).
// Each clip is scored two ways: cut by energy, and on the syllable times
// of Azure's cached reply for the clean clip, moved by the lead-in (no
// call is made). Every syllable's verdict is then compared with the same
// syllable's on the clean clip, the same way of scoring: totals hide a
// verdict lost here and another gained there.
const NOISE_PATHS = ["energy", "timings"];
// The energy path as it was before the rework (commit e75a163), from this
// same measurement: kept so the report can show what the rework changed.
// Totals and changes per condition, singles then phrases; generated cases.
const NOISE_BEFORE = {"clean": ["111 of 192 / 1 of 64 / 9", "0 / 0 / 0", "201 of 576 / 0 of 168 / 58", "0 / 0 / 0"], "silence": ["111 of 192 / 1 of 64 / 9", "0 / 1 / 0", "201 of 576 / 0 of 168 / 58", "0 / 1 / 1"], "room": ["111 of 192 / 1 of 64 / 9", "0 / 1 / 0", "201 of 576 / 0 of 168 / 58", "0 / 1 / 1"], "blip": ["111 of 192 / 1 of 64 / 9", "0 / 1 / 0", "176 of 576 / 0 of 168 / 50", "0 / 1 / 41"], "knockBefore": ["111 of 192 / 1 of 64 / 9", "0 / 1 / 0", "177 of 576 / 0 of 168 / 53", "0 / 1 / 42"], "knockAfter": ["111 of 192 / 1 of 64 / 9", "0 / 1 / 0", "184 of 576 / 0 of 168 / 50", "0 / 1 / 27"], "murmur": ["111 of 192 / 1 of 64 / 10", "0 / 2 / 0", "205 of 576 / 0 of 168 / 58", "0 / 1 / 1"], "nearKnockBefore": ["29 of 192 / 0 of 64 / 16", "0 / 8 / 86", "117 of 576 / 10 of 168 / 92", "10 / 55 / 144"], "nearKnockAfter": ["4 of 192 / 0 of 64 / 29", "0 / 21 / 124", "112 of 576 / 2 of 168 / 90", "2 / 60 / 141"], "knockOnset": ["80 of 192 / 1 of 64 / 14", "0 / 5 / 36", "183 of 576 / 3 of 168 / 63", "3 / 9 / 30"], "coughBefore": ["0 of 192 / 0 of 64 / 49", "0 / 43 / 141", "76 of 576 / 20 of 168 / 146", "20 / 121 / 248"], "coughAfter": ["0 of 192 / 0 of 64 / 54", "0 / 47 / 138", "71 of 576 / 11 of 168 / 149", "11 / 124 / 222"], "secondVoice": ["0 of 192 / 0 of 64 / 50", "0 / 46 / 156", "149 of 576 / 44 of 168 / 155", "44 / 141 / 243"], "hum100": ["11 of 192 / 5 of 64 / 37", "5 / 33 / 142", "104 of 576 / 21 of 168 / 139", "21 / 114 / 248"], "hum60": ["2 of 192 / 0 of 64 / 38", "0 / 33 / 157", "135 of 576 / 35 of 168 / 100", "35 / 74 / 252"], "midword": ["110 of 192 / 1 of 64 / 13", "0 / 5 / 6", "147 of 576 / 2 of 168 / 65", "2 / 15 / 79"], "echo": ["44 of 192 / 4 of 64 / 23", "4 / 17 / 94", "47 of 576 / 6 of 168 / 74", "6 / 42 / 258"]};
const MADE_BEFORE = {"plain": ["297 of 324 / 0 of 108 / 0", "0 / 0 / 0"], "pause": ["144 of 324 / 0 of 108 / 0", "0 / 0 / 201"], "soft": ["179 of 324 / 0 of 108 / 0", "0 / 0 / 166"], "gap150": ["297 of 324 / 0 of 108 / 0", "0 / 0 / 0"], "click": ["108 of 324 / 0 of 108 / 20", "0 / 20 / 209"], "uh": ["157 of 324 / 12 of 108 / 32", "12 / 32 / 175"], "breath": ["297 of 324 / 0 of 108 / 0", "0 / 0 / 0"], "split": ["285 of 324 / 0 of 108 / 0", "0 / 0 / 0"], "pauseSplit": ["162 of 324 / 57 of 108 / 80", "57 / 80 / 207"]};
const azureTimes = new Map();
function azureTimingsOf(v, text, truth, clip) {
  const key = `${v.id}|${text}`;
  if (!azureTimes.has(key)) {
    let got = null;
    const file = azurePath(v.id, text, text);
    if (fs.existsSync(file)) {
      const azure = azureOfClip(JSON.parse(fs.readFileSync(file, "utf8")));
      if (azure.status === "Success" && azure.words.length) {
        mergeAzure({ azure, syllables: truth, track: clip.track, local: (timings) => {
          got = timings;
          return null;
        } });
      }
    }
    azureTimes.set(key, got && got.every(Boolean) ? got : null);
  }
  return azureTimes.get(key);
}
let noiseDone = null;
function noiseStudy() {
  if (noiseDone) return noiseDone;
  const clipRows = [];
  let clean = null;
  let untimed = 0;
  for (const cond of NOISE_CONDITIONS) {
    const maps = { energy: { single: new Map(), phrase: new Map() }, timings: { single: new Map(), phrase: new Map() } };
    for (const v of voices) {
      for (const [k, [text, clip]] of [...v.clips].entries()) {
        const { truth, list } = labellings(text);
        const d = disturb(clip.samples, clip.sampleRate, cond, 12345 + k);
        const track = cond.key === "clean" ? clip.track : trackPitch(d.samples, clip.sampleRate);
        const azure = azureTimingsOf(v, text, truth, clip);
        if (!azure && cond.key === "clean") untimed++;
        for (const way of NOISE_PATHS) {
          if (way === "timings" && !azure) continue;
          const timings = way === "timings" ? azure.map((t) => ({ startMs: Math.max(0, t.startMs + d.shiftMs), endMs: t.endMs + d.shiftMs })) : null;
          list.forEach((label, li) => {
            const res = scoreTones({ samples: d.samples, sampleRate: clip.sampleRate, syllables: label.syllables, timings, speaker: clip.range, track, rules: RULES });
            res.syllables.forEach((x, j) => {
              if (truth[j].expectedTone === 0 || label.syllables[j].expectedTone === 0) return;
              const side = label.wrongAt.has(j) ? "wrong" : "right";
              if (side === "right" && label.kind !== "right") return;
              maps[way][[...text].length === 1 ? "single" : "phrase"].set(`${v.id}|${text}|${li}|${j}`, { side, verdict: x.verdict, reason: x.reason });
            });
          });
        }
      }
    }
    clean ??= maps;
    clipRows.push({ cond, maps, flips: Object.fromEntries(NOISE_PATHS.map((way) => [way, { single: flips(clean[way].single, maps[way].single), phrase: flips(clean[way].phrase, maps[way].phrase) }])) });
  }
  // And what the cached clips can't express, generated
  // (pronunciation-synth.mjs), in room noise; timings are where the
  // generator put each syllable.
  const made = new Map();
  for (const kase of GENERATED_CASES) {
    const maps = { energy: new Map(), timings: new Map() };
    for (const [vi, voice] of GENERATED_VOICES.entries()) {
      for (const [k, tones] of GENERATED_PHRASES.entries()) {
        const said = sayCase(kase, tones, voice, k);
        const track = trackPitch(said.samples, SYNTH_RATE);
        for (const way of NOISE_PATHS) {
          verdictsOf(maps[way], `${vi}|${tones.join("")}`, tones, (syllables) => scoreTones({ samples: said.samples, sampleRate: SYNTH_RATE, syllables, timings: way === "timings" ? said.timings : null, speaker: said.range, track, rules: RULES }));
        }
      }
    }
    made.set(kase.key, maps);
  }
  const madeRows = GENERATED_CASES.map((kase) => ({ kase, flips: Object.fromEntries(NOISE_PATHS.map((way) => [way, flips(made.get(kase.base ?? kase.key)[way], made.get(kase.key)[way])])) }));
  return (noiseDone = { clipRows, madeRows, untimed });
}
// What the timings path says when the spans themselves are wrong
// (SPAN_ERRORS), with its guards (TIMING_RULES: the jittered readings and
// the lopsided check) and without, each against the unperturbed spans
// under the same setting.
const NO_SPAN_GUARDS = Object.freeze({ ...TIMING_RULES, jitterMs: 0, lopsided: 0 });
let spanDone = null;
function spanStudy() {
  if (spanDone) return spanDone;
  const settings = { bare: NO_SPAN_GUARDS, guarded: TIMING_RULES };
  const kinds = () => ({ single: new Map(), phrase: new Map() });
  const base = { bare: kinds(), guarded: kinds() };
  // The clean verdicts under each variant's key, for flips().
  const baseAt = Object.fromEntries(SPAN_ERRORS.map((e) => [e.key, { bare: kinds(), guarded: kinds() }]));
  const now = Object.fromEntries(SPAN_ERRORS.map((e) => [e.key, { bare: kinds(), guarded: kinds() }]));
  for (const v of voices) {
    for (const [text, clip] of v.clips) {
      const { truth, list } = labellings(text);
      const azure = azureTimingsOf(v, text, truth, clip);
      if (!azure) continue;
      const kind = [...text].length === 1 ? "single" : "phrase";
      const totalMs = (clip.samples.length / clip.sampleRate) * 1000;
      const read = (into, tag, timings, timingRules) => list.forEach((label, li) => {
        const res = scoreTones({ samples: clip.samples, sampleRate: clip.sampleRate, syllables: label.syllables, timings, speaker: clip.range, track: clip.track, rules: RULES, timingRules });
        res.syllables.forEach((x, j) => {
          if (truth[j].expectedTone === 0 || label.syllables[j].expectedTone === 0) return;
          const side = label.wrongAt.has(j) ? "wrong" : "right";
          if (side === "right" && label.kind !== "right") return;
          into.set(`${v.id}|${text}|${li}|${j}${tag}`, { side, verdict: x.verdict, reason: x.reason });
        });
      });
      for (const [name, timingRules] of Object.entries(settings)) {
        const mine = new Map();
        read(mine, "", azure, timingRules);
        for (const [k, x] of mine) base[name][kind].set(k, x);
        for (const error of SPAN_ERRORS) {
          error.variants(azure, totalMs).forEach((spans, vi) => {
            read(now[error.key][name][kind], `#${vi}`, spans, timingRules);
            for (const [k, x] of mine) baseAt[error.key][name][kind].set(`${k}#${vi}`, x);
          });
        }
      }
    }
  }
  const rows = SPAN_ERRORS.map((error) => ({ error, flips: Object.fromEntries(Object.keys(settings).map((name) => [name, { single: flips(baseAt[error.key][name].single, now[error.key][name].single), phrase: flips(baseAt[error.key][name].phrase, now[error.key][name].phrase) }])) }));
  // What the guards cost where the spans were right all along.
  const cost = { single: flips(base.bare.single, base.guarded.single), phrase: flips(base.bare.phrase, base.guarded.phrase) };
  const clean = Object.fromEntries(Object.keys(settings).map((name) => [name, { single: flips(base[name].single, base[name].single), phrase: flips(base[name].phrase, base[name].phrase) }]));
  return (spanDone = { rows, cost, clean });
}
const spanTable = () => {
  const { rows } = spanStudy();
  const moved = (f) => (f.right + f.wrong ? `${f.falseOff} / ${f.wrongOk} / ${f.lost}` : "–");
  return [
    "| The spans given | Singles: no guards | Singles: guarded | Phrases: no guards | Phrases: guarded | Phrase syllables read |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.error.title} | ${moved(r.flips.bare.single)} | ${moved(r.flips.guarded.single)} | ${moved(r.flips.bare.phrase)} | ${moved(r.flips.guarded.phrase)} | ${r.flips.guarded.phrase.right + r.flips.guarded.phrase.wrong} |`),
  ];
};
if (args.has("--spans")) {
  console.log(spanTable().join("\n"));
  const { cost, clean } = spanStudy();
  const totals = (f) => `${f.caught} of ${f.wrong} / ${f.falseAlarms} of ${f.right} / ${f.passed}`;
  console.log(`clean, no guards: singles ${totals(clean.bare.single)}, phrases ${totals(clean.bare.phrase)}; guarded: singles ${totals(clean.guarded.single)}, phrases ${totals(clean.guarded.phrase)}; the guards cost ${cost.single.lost} single and ${cost.phrase.lost} phrase verdicts (new false alarms ${cost.single.falseOff + cost.phrase.falseOff}, new wrong oks ${cost.single.wrongOk + cost.phrase.wrongOk})`);
  process.exit(0);
}
const noiseTable = () => {
  const { clipRows, madeRows } = noiseStudy();
  const totals = (f) => `${f.caught} of ${f.wrong} / ${f.falseAlarms} of ${f.right} / ${f.passed}`;
  const moved = (f) => `${f.falseOff} / ${f.wrongOk} / ${f.lost}`;
  const out = [];
  for (const way of NOISE_PATHS) {
    out.push(
      `**${way === "energy" ? "Cut by energy (no timings)" : "On Azure's syllable times"}.** Totals are wrong tones caught / false alarms / wrong tones passed as ok; changes are, against the clean clip syllable by syllable, new false alarms / new wrong tones passed as ok / right verdicts lost.`,
      "",
      "| | Singles: totals | Singles: changes | Phrases: totals | Phrases: changes |",
      "| --- | --- | --- | --- | --- |",
      ...clipRows.map((r) => `| ${r.cond.title} | ${totals(r.flips[way].single)} | ${moved(r.flips[way].single)} | ${totals(r.flips[way].phrase)} | ${moved(r.flips[way].phrase)} |`),
      "",
    );
  }
  out.push(
    "**Cut by energy, before the rework** (commit e75a163; not rerun. Measured without the lead-in the clips now get, and its mid-word row had half a second of room noise before the cut, which is not a recording that starts mid-word).",
    "",
    "| | Singles: totals | Singles: changes | Phrases: totals | Phrases: changes |",
    "| --- | --- | --- | --- | --- |",
    ...clipRows.filter((r) => NOISE_BEFORE[r.cond.key]).map((r) => `| ${r.cond.title} | ${NOISE_BEFORE[r.cond.key].join(" | ")} |`),
    "",
    "| Generated three-syllable phrases, in room noise | Energy before: totals | Energy before: changes | Energy: totals | Energy: changes | Timings: totals | Timings: changes | compared with |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...madeRows.map((r) => `| ${r.kase.title} | ${(MADE_BEFORE[r.kase.key] ?? ["", ""]).join(" | ")} | ${totals(r.flips.energy)} | ${moved(r.flips.energy)} | ${totals(r.flips.timings)} | ${moved(r.flips.timings)} | ${r.kase.base ? GENERATED_CASES.find((c) => c.key === r.kase.base).title.toLowerCase() : "itself"} |`),
  );
  return out;
};
if (args.has("--noise")) {
  console.log(noiseTable().join("\n"));
  if (args.has("--dump")) {
    for (const r of noiseStudy().clipRows) for (const way of NOISE_PATHS) for (const kind of ["single", "phrase"]) {
      const why = {};
      for (const x of r.maps[way][kind].values()) if (x.verdict === "unsure") why[x.reason] = (why[x.reason] ?? 0) + 1;
      console.log(r.cond.key, way, kind, "unsure:", JSON.stringify(why));
    }
    for (const r of noiseStudy().clipRows) for (const way of NOISE_PATHS) for (const kind of ["single", "phrase"]) for (const what of ["falseOff", "wrongOk"]) if (r.flips[way][kind].keys[what].length) console.log(r.cond.key, way, kind, what, r.flips[way][kind].keys[what].join("; "));
  }
  process.exit(0);
}
const perVoice = voices.map((v) => ({ name: v.name, range: v.range, single: summary(scoreAll([v], SINGLES, { baseline: true, timings: "fallback" })), phrase: summary(scoreAll([v], PHRASES, { baseline: true, timings: "fallback" })) }));

// Pitch tracks of a few clips, for the tests to replay without the audio:
// right syllables that sit near a bar, and plain ones to flag. Synthesized
// voices only. Rounded, so a fixture is a few kilobytes.
if (args.has("--fixtures")) {
  const want = [["say-reed", "不客气"], ["eleven-21m00Tcm4TlvDq8ikWAM", "你叫什么"], ["say-reed", "我是学生"], ["say-tingting", "一个"], ["say-tingting", "妈"], ["say-tingting", "骂"], ["say-reed", "麻"], ["eleven-pNInz6obpgDQGcFmaJgB", "爸"]];
  const round = (arr, d) => [...arr].map((v) => Math.round(v * 10 ** d) / 10 ** d);
  const out = [];
  for (const [id, text] of want) {
    const v = voices.find((x) => x.id === id);
    const clip = v?.clips.get(text);
    if (!clip) continue;
    out.push({
      voice: v.name.split(" (")[0], text, readings: readCodePoints(text, LOCALE),
      range: { lowHz: Math.round(clip.range.lowHz * 10) / 10, highHz: Math.round(clip.range.highHz * 10) / 10, medianHz: Math.round(clip.range.medianHz * 10) / 10 },
      hopMs: clip.track.hopMs, f0: round(clip.track.f0, 1), rms: round(clip.track.rms, 4), periodicity: round(clip.track.periodicity, 3), zcr: round(clip.track.zcr, 3),
    });
  }
  const file = path.join(REPO, "scripts", "tests", "fixtures", "pronunciation", "tracks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `[\n${out.map((x) => JSON.stringify(x)).join(",\n")}\n]\n`);
  console.log(`Wrote ${out.length} pitch tracks to ${path.relative(REPO, file)}`);
}

// Held-out check. The thresholds a flag rests on are chosen on two voices
// (the setting that catches most while flagging at most one right syllable
// in the hundred or so those two voices say) and then measured on the other
// two, which had no say in them; then the other way round.
const GRID = {
  moveSt: [3, 3.5, 4],
  offMarginSt: [0, 0.5, 1],
  phraseMarginSt: [0, 0.5, 1],
  flatSt: [1, 1.5],
  offQuality: [0.6, 0.75],
  offMinMs: [80, 110],
  highStart: [3.7, 4.2],
  lowLevel: [2.2, 2.6],
};
// What stage 0's scorer did on the same clips (commit db2bce9, its report's
// by-voice table), for the before column.
const STAGE0 = {
  "say-tingting": { singleCaught: 23, singleAlarms: 0, phraseCaught: 59, phraseAlarms: 0 },
  "say-reed": { singleCaught: 18, singleAlarms: 0, phraseCaught: 25, phraseAlarms: 0 },
  "eleven-21m00Tcm4TlvDq8ikWAM": { singleCaught: 21, singleAlarms: 1, phraseCaught: 38, phraseAlarms: 0 },
  "eleven-pNInz6obpgDQGcFmaJgB": { singleCaught: 19, singleAlarms: 0, phraseCaught: 23, phraseAlarms: 0 },
};
function* grid(keys = Object.keys(GRID), at = {}) {
  if (!keys.length) {
    yield at;
    return;
  }
  for (const v of GRID[keys[0]]) yield* grid(keys.slice(1), { ...at, [keys[0]]: v });
}
const counts = (group, rules) => {
  const single = scoreAll(group, SINGLES, { baseline: true, timings: "fallback", rules });
  const phrase = scoreAll(group, PHRASES, { baseline: true, timings: "fallback", rules });
  const n = (t, side) => t[side].ok + t[side].unsure + t[side].off;
  return {
    single, phrase,
    alarms: single.right.off + phrase.right.off, right: n(single, "right") + n(phrase, "right"),
    caught: single.wrong.off + phrase.wrong.off, wrong: n(single, "wrong") + n(phrase, "wrong"),
  };
};
function tune(group) {
  let best = null;
  for (const g of grid()) {
    const c = counts(group, { ...TONE_RULES, ...g });
    if (c.alarms > 1) continue;
    // Most caught; among equals the one that asks for more evidence.
    if (!best || c.caught > best.c.caught || (c.caught === best.c.caught && g.offMarginSt + g.offQuality > best.g.offMarginSt + best.g.offQuality)) best = { g, c };
  }
  return best;
}
let heldOut = null;
if (voices.length === 4 && !process.env.LINGO_PROOF_RULES && !args.has("--quick") && !args.has("--recordings")) {
  // One macOS and one ElevenLabs voice, one of each sex, on each side.
  const order = ["say-tingting", "eleven-pNInz6obpgDQGcFmaJgB", "say-reed", "eleven-21m00Tcm4TlvDq8ikWAM"].map((id) => voices.find((v) => v.id === id));
  if (order.every(Boolean)) {
    const halves = [order.slice(0, 2), order.slice(2)];
    heldOut = [0, 1].map((k) => {
      const tuned = tune(halves[k]);
      return { tunedOn: halves[k], testedOn: halves[1 - k], rules: tuned.g, tuneCounts: tuned.c, test: counts(halves[1 - k], { ...TONE_RULES, ...tuned.g }), defaults: counts(halves[1 - k], TONE_RULES) };
    });
    if (args.has("--dump")) {
      const all = tune(voices);
      console.log("tuned on all four:", JSON.stringify(all.g), `alarms ${all.c.alarms}/${all.c.right} caught ${all.c.caught}/${all.c.wrong}`);
      for (const h of heldOut) console.log("tuned on", h.tunedOn.map((v) => v.id).join("+"), JSON.stringify(h.rules));
    }
  }
}

// Real recordings, when someone has dropped some in.
const REC_DIR = path.join(DIR, "recordings");
// The how-to's counts come from the prompt list itself.
const PROMPT_COUNT = { right: buildPrompts().filter((x) => x.part === "right").length, wrong: buildPrompts().filter((x) => x.part === "wrong").length };
const RECORDINGS_HELP = [
  "### How to record your clips",
  "",
  "1. In a terminal, in the repository: `npm run pron:record`.",
  "2. Open <http://127.0.0.1:38410> in Chrome or Safari on the same computer, and allow the microphone when the browser asks.",
  "3. Type a first name or nickname, pick Adult or Child, press **Start**.",
  "4. For each word: press **Listen** to hear it, press **Record** (or the space bar), say it, press **Stop** (or space again). The page plays your clip back.",
  "5. Press **Keep** (or Enter) if it is what you meant to say, or **Redo** (space) to try again. If you doubt you said it right, tick **Not sure I said it right** before keeping: that is useful, not a failure.",
  `6. Part 1 is ${PROMPT_COUNT.right} words and phrases said as shown. Part 2 is ${PROMPT_COUNT.wrong} words said in the *wrong* tone on purpose, each with a model to copy; the page explains it when you get there.`,
  "7. Stop whenever you like (**Stop for now**, or just close the tab). Every kept clip is already saved; next time, pick your name on the first screen and it carries on where you stopped.",
  "8. When you have some clips, press Ctrl-C in the terminal and run `npm run pron:proof`. It prints how the scorer did for each speaker and writes the detail to `data/pronunciation-proof/recordings/report.md`.",
  "",
  "After each kept clip the page shows a \"test readout\": what the scorer made of it. It is there to show the thing working and is not a grade; it is often unsure and sometimes wrong, which is what these recordings are for.",
  "",
  "The recorder is a local tool, not part of the app: it listens on 127.0.0.1 only, uses no login or database, plays the proof's cached model clips and makes no request to anywhere else. Recordings and their results stay under `data/` (gitignored): this report never includes them.",
  "",
  "### What a label means",
  "",
  "A label records what the speaker was **aiming for**, not what came out. A beginner's \"said as shown\" clips will hold real mistakes, so a flag on one may be a true catch that the tally counts as a false alarm. That is why the speaker's own \"not sure\" clips are counted apart, and why the false-alarm rate from a beginner's clips is an upper bound until someone who knows the language has listened to the flagged ones.",
  "",
  "### The labels file",
  "",
  "`data/pronunciation-proof/recordings/labels.tsv` (with `LINGO_PROOF_DIR` set, its `recordings/` folder): one recording per line, tab-separated; the recorder writes it, and it can be written by hand:",
  "",
  "```",
  "# file<TAB>text<TAB>said<TAB>speaker<TAB>group<TAB>unsure<TAB>processing",
  "nihao-1.wav\t你好",
  "rec-20261118-153012-ab12cd34.wav\t妈\tma2\tsam\tadult\t\traw",
  "rec-20261118-153140-0f3e9a71.wav\t我是学生\t\tsam\tadult\tunsure\traw",
  "```",
  "",
  "- `file`: WAV, M4A, MP3 or WebM in that folder; anything that isn't 16 kHz mono WAV is converted with ffmpeg (or macOS's afconvert) into `recordings/.wav16k/`. The recorder's files are already the right format.",
  "- `text`: the characters the speaker was shown.",
  "- `said`: empty when they were asked to say it as shown. Otherwise what they were asked to say instead: one pinyin syllable per character with the tone as a digit (5 or 0 for neutral). `ma2` against 妈 is a deliberate má for mā.",
  "- `speaker`: a name; recordings with the same name share a pitch range, each read against the range of that speaker's other recordings.",
  "- `group`: `adult` or `child` (optional).",
  "- `unsure`: `unsure` when the speaker ticked \"not sure I said it right\" (optional).",
  "- `processing`: `raw` when the microphone was recorded with the browser's echo cancellation, noise suppression and automatic gain off (what the recorder does now), `processed` with them on. A line without it is read as `processed`: the first recordings were made that way. When the labels hold both, the recordings report has each speaker once per setting, so a few prompts recorded again are a direct comparison.",
  "",
  "A syllable whose `said` tone is one the text accepts counts as said as shown (a flag on it is a false alarm); any other counts as wrong on purpose (a flag is a catch). Nothing is uploaded: the local scorer runs on this machine.",
].join("\n");
let recordings = null;
// Asked once, before anything is written there: a converted clip
// (`.wav16k/`) is a person's voice as much as the report is about one.
const recordingsTracked = fs.existsSync(path.join(REC_DIR, "labels.tsv")) && trackedByGit(REC_DIR);
if (recordingsTracked) {
  console.error(`Not scoring the recordings: ${REC_DIR} is inside the repository and not gitignored (or already holds tracked files), so nothing is written there.`);
  if (args.has("--recordings")) process.exit(1);
} else if (fs.existsSync(path.join(REC_DIR, "labels.tsv"))) {
  const parsed = parseLabels(fs.readFileSync(path.join(REC_DIR, "labels.tsv"), "utf8"));
  const rows = [];
  const problems = [...parsed.problems];
  // One person per name whatever its capitals, as the recorder has it:
  // one range, one line in the tables.
  // A name given two groups is a conflict to report, not one to settle
  // here: those lines are left out, and said so.
  const people = [];
  for (const r of parsed.rows) {
    const who = findSpeaker(parsed.rows, r.speaker);
    if (r.group && who.group && r.group !== who.group) problems.push(`${r.file}: speaker "${r.speaker}" is ${r.group} here and "${who.name}" is ${who.group} in an earlier line (one name, two groups: fix labels.tsv)`);
    else people.push({ ...r, speaker: who.name });
  }
  for (const label of people) {
    const { file, text } = label;
    try {
      const src = path.join(REC_DIR, file);
      if (path.dirname(path.resolve(src)) !== path.resolve(REC_DIR)) throw new Error("the file must be in the recordings folder");
      let wav = null;
      try {
        wav = parseWav(fs.readFileSync(src));
      } catch (e) {
        if (!fs.existsSync(src)) throw e;
      }
      if (!wav || wav.sampleRate !== 16000) {
        const out = path.join(REC_DIR, ".wav16k", `${file}.wav`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs) toWav16k(src, out);
        wav = parseWav(fs.readFileSync(out));
      }
      const syllables = expectedSyllables(text, readCodePoints(text, LOCALE));
      const saidTones = readSaid(label.said);
      if (saidTones && saidTones.length !== syllables.length) throw new Error(`"said" has ${saidTones.length} syllables, the text ${syllables.length}`);
      rows.push({ ...label, syllables, saidTones, samples: wav.samples, sampleRate: wav.sampleRate, track: trackPitch(wav.samples, wav.sampleRate) });
    } catch (e) {
      problems.push(`${file}: ${e.message}`);
    }
  }
  // Azure's timings for the recordings, when their speaker chose to send
  // them (--azure-recordings): asked once per clip, the reply kept in
  // `.azure/` beside the clips (0600), so no clip is sent again once it
  // has an answer (a rate-limit refusal is retried, which sends the clip
  // again). Only the speaker named in LINGO_PROOF_AZURE_SPEAKER, only when
  // labelled adult and nothing else on every line (azureSendable), and to
  // no other provider.
  const replyPath = (row) => path.join(REC_DIR, ".azure", `${row.file}.json`);
  if (args.has("--azure-recordings")) {
    const who = String(process.env.LINGO_PROOF_AZURE_SPEAKER ?? "").trim().toLowerCase();
    if (!who) throw new Error("--azure-recordings needs LINGO_PROOF_AZURE_SPEAKER: the one speaker whose own clips may be sent");
    const keys = voiceKeys();
    if (pronunciationProvider(keys) !== "azure") throw new Error("no AZURE_SPEECH_KEY / AZURE_SPEECH_REGION");
    // Decided on every label line, the ones left out as conflicts too.
    const allowed = azureSendable(parsed.rows, who);
    if (allowed.why) console.error(`Azure: nothing sent (${allowed.why}).`);
    const files = new Set(allowed.send.map((r) => r.file));
    const mine = rows.filter((r) => files.has(r.file) && r.speaker.toLowerCase() === who);
    const held = rows.length - mine.length;
    fs.mkdirSync(path.join(REC_DIR, ".azure"), { recursive: true, mode: 0o700 });
    // The replies say what a person said and how: asked of the very file
    // about to be written, not of the folder in general.
    for (const row of mine) if (trackedByGit(path.dirname(replyPath(row)), undefined, path.basename(replyPath(row)))) throw new Error(`${replyPath(row)} would not be ignored by git: nothing sent`);
    let sent = 0;
    for (const row of mine) {
      if (fs.existsSync(replyPath(row))) continue;
      const request = azurePronunciationRequest({ key: keys.azureKey, region: keys.azureRegion, audio: encodeWav(row.samples, row.sampleRate), locale: LOCALE, referenceText: row.text });
      for (let attempt = 1; ; attempt++) {
        const r = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(30_000) });
        if (r.status === 429 && attempt < 4) {
          await new Promise((done) => setTimeout(done, 20_000));
          continue;
        }
        if (!r.ok) throw new Error(`azure ${row.file}: HTTP ${r.status}`);
        fs.writeFileSync(replyPath(row), JSON.stringify(await r.json()), { mode: 0o600 });
        break;
      }
      sent++;
      await new Promise((done) => setTimeout(done, 1200));
    }
    console.log(`Azure: ${sent} recordings sent (one clip each, sent again only after a rate-limit refusal), ${mine.length - sent} already answered${held ? `, ${held} of other speakers or not labelled adult NOT sent` : ""}.`);
  }
  const detail = [];
  const marked = [];
  const timedMarks = [];
  const timedDetail = [];
  let timedClips = 0;
  for (const row of rows) {
    const others = rows.filter((x) => x !== row && x.speaker === row.speaker).map((x) => x.track);
    const res = scoreTones({ samples: row.samples, sampleRate: row.sampleRate, syllables: row.syllables, speaker: others.length ? speakerRange(others) : null, track: row.track, rules: RULES });
    const marks = res.syllables.map((x, k) => {
      const saidTone = row.saidTones?.[k] ?? null;
      if (row.syllables[k].expectedTone === 0 || saidTone === 0) return `${x.char} –`;
      const wrong = saidTone !== null && !row.syllables[k].accept.includes(saidTone);
      marked.push({ speaker: row.speaker, group: row.group, unsure: row.unsure, wrong, verdict: x.verdict, processing: row.processing });
      return `${x.char} ${x.verdict}${x.verdict === "off" ? (wrong ? " (caught)" : " (**false alarm**)") : wrong ? " (missed)" : ""}`;
    });
    detail.push(`| ${row.file} | ${row.speaker} | ${row.text} | ${row.saidTones ? row.saidTones.join(" ") : "as shown"} | ${row.unsure ? "yes" : ""} | ${row.processing} | ${marks.join(", ")} |`);
    // The same clip on Azure's syllable timings, when there is a reply.
    if (!fs.existsSync(replyPath(row))) continue;
    const azure = azurePronunciationResult(JSON.parse(fs.readFileSync(replyPath(row), "utf8")));
    if (azure.status !== "Success" || !azure.words.length) {
      problems.push(`${row.file}: Azure recognised nothing (${azure.status})`);
      continue;
    }
    timedClips++;
    const timed = mergeAzure({ azure, syllables: row.syllables, track: row.track, local: (timings) => scoreTones({ samples: row.samples, sampleRate: row.sampleRate, syllables: row.syllables, timings, speaker: others.length ? speakerRange(others) : null, track: row.track, rules: RULES }) });
    const timedSyllables = timed.syllables.map((x, k) => {
      const saidTone = row.saidTones?.[k] ?? null;
      if (row.syllables[k].expectedTone === 0 || saidTone === 0) return `${x.char} –`;
      const wrong = saidTone !== null && !row.syllables[k].accept.includes(saidTone);
      timedMarks.push({ speaker: row.speaker, group: row.group, unsure: row.unsure, wrong, verdict: x.verdict, processing: row.processing });
      // A flag names what was expected and what was heard, and whose flag
      // it is ("sound" is Azure's own, on the word; "tone" the pitch's).
      const why = x.verdict === "off" ? ` (${wrong ? "caught" : "**false alarm**"}: expected tone ${row.syllables[k].accept.join(" or ")}, heard ${x.heardTone ?? "none"}, by ${x.reason === "sound" ? "Azure's score" : "the pitch"})` : x.verdict === "unsure" ? ` (${x.reason})` : wrong ? " (missed)" : "";
      return `${x.char} ${x.verdict}${why}`;
    });
    timedDetail.push(`| ${row.file} | ${row.speaker} | ${row.text} | ${row.saidTones ? row.saidTones.join(" ") : "as shown"} | ${row.unsure ? "yes" : ""} | ${row.processing} | ${timedSyllables.join(", ")} |`);
  }
  recordings = { clips: rows.length, problems, detail, marks: marked, timed: timedClips ? { clips: timedClips, marks: timedMarks, detail: timedDetail } : null };
}

/** Print the recordings' results and write them beside the recordings
 *  (the builder is recordingsReport in pronunciation-recordings.mjs). They
 *  are a person's, so never in the tracked report, and never into a folder
 *  git could commit from. */
function writeRecordingsReport() {
  const rec = recordingsReport({ ...recordings, date: new Date().toISOString().slice(0, 10) });
  console.log(rec.console);
  const file = path.join(REC_DIR, "report.md");
  let markdown = rec.markdown;
  if (recordings.timed) {
    // The clips that have an Azure reply, read on its syllable timings
    // (the tone verdict is still the local scorer's; Azure adds a flag
    // only where it marks the word mispronounced, mergeAzure).
    const timed = recordingsReport({ ...recordings.timed, date: new Date().toISOString().slice(0, 10) });
    console.log(`\nOn Azure's syllable timings (the clips with a reply):\n${timed.console}`);
    markdown += `\n## On Azure's syllable timings\n\nThe clips with a cached Azure reply, the same count as above.\n\n${timed.markdown.split("\n").slice(4).join("\n")}`;
  }
  fs.writeFileSync(file, markdown, { mode: 0o600 });
  console.log(`Wrote ${file}`);
}

// --recordings (npm run pron:proof): score the recordings and stop. The
// tracked report is left alone, so scoring your own clips never changes a
// file git tracks.
if (args.has("--recordings")) {
  if (recordings) writeRecordingsReport();
  else console.log(`No recordings yet in ${REC_DIR}. Run \`npm run pron:record\` to make some.`);
  process.exit(0);
}

// The trade-off: the same clips at several values of the one knob that
// asks for more evidence before a flag.
const tradeOff = [-1, -0.5, 0, 0.5, 1, 1.5, 2, 3].map((offMarginSt) => ({ offMarginSt, c: counts(voices, { ...RULES, offMarginSt }) }));

// The classifier before any gate: the tone it names for each single
// syllable, by voice.
const rawByVoice = voices.map((v) => {
  const t = scoreAll([v], SINGLES, { baseline: true, timings: "fallback" });
  let ok = 0;
  let n = 0;
  for (const tone of [1, 2, 3, 4]) {
    ok += t.confusion[tone][tone];
    n += Object.values(t.confusion[tone]).reduce((a, b) => a + b, 0);
  }
  return { name: v.name, t, ok, n };
});

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
      const timed = alignTimings(truth, scribeOfClip(clip.scribe));
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
  const group = () => ({ n: 0, scores: [], marks: [], flagged: 0, under50: 0, mergedOff: 0, mergedTone: 0, mergedSound: 0, mergedOk: 0, mergedUnsure: 0, local: { off: 0 } });
  const g = { singleRight: group(), singleWrong: group(), phraseRight: group() };
  let replies = 0;
  let failed = 0;
  let example = null;
  const mergedAlarms = [];
  const mergedAtMargin = { 0: 0, 0.25: 0, 0.5: 0 };
  let worstMargin = -Infinity;
  const layouts = { flat: 0, nested: 0, multiCharWords: 0, words: 0, syllablePhonemes: 0, phonemeWords: 0 };
  for (const v of voices) {
    for (const [text, clip] of v.clips) {
      for (const ref of [text, ...minimalPairs(text)]) {
        const file = azurePath(v.id, text, ref);
        if (!fs.existsSync(file)) continue;
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        replies++;
        const azure = azureOfClip(raw);
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
        const args = { samples: clip.samples, sampleRate: clip.sampleRate, syllables, speaker: clip.range, track: clip.track, rules: RULES };
        const merged = mergeAzure({ azure, syllables, local: (timings) => scoreTones({ ...args, timings }), track: clip.track });
        const alone = scoreTones(args);
        const right = ref === text;
        if (right && !SINGLES.includes(text)) {
          for (const pm of Object.keys(mergedAtMargin)) {
            const again = mergeAzure({ azure, syllables, local: (timings) => scoreTones({ ...args, rules: { ...RULES, phraseMarginSt: Number(pm) }, timings }), track: clip.track });
            again.syllables.forEach((m, k) => {
              if (syllables[k].expectedTone !== 0 && m.verdict === "off") mergedAtMargin[pm]++;
            });
          }
          for (const m of mergeAzure({ azure, syllables, local: (timings) => scoreTones({ ...args, rules: { ...RULES, phraseMarginSt: 0, offQuality: 0, offMinMs: 0 }, timings }), track: clip.track }).syllables) {
            if (m.expectedTone !== 0 && typeof m.margin === "number" && m.quality >= RULES.offQuality && m.voicedMs >= RULES.offMinMs) worstMargin = Math.max(worstMargin, m.margin);
          }
        }
        const into = g[SINGLES.includes(text) ? (right ? "singleRight" : "singleWrong") : "phraseRight"];
        if (!right && !example && text === "妈" && ref === "马") example = raw;
        merged.syllables.forEach((m, k) => {
          if (syllables[k].expectedTone === 0) return;
          into.n++;
          if (typeof m.score === "number") {
            into.scores.push(m.score);
            into.marks.push({ score: m.score, mis: m.azureError === "Mispronunciation" });
          }
          if (m.azureError === "Mispronunciation") into.flagged++;
          if (typeof m.score === "number" && m.score < AZURE_RULES.offBelow) into.under50++;
          if (m.verdict === "off") {
            if (right) mergedAlarms.push(`${v.name.split(" (")[0]} ${text}[${k + 1}] ${m.char} expected ${m.expectedTone} heard ${m.heardTone}, margin ${m.margin}, Azure ${m.score ?? "–"}, ${m.startMs}–${m.endMs} ms`);
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
    const line = (label, x, wrong) => `| ${label} | ${x.n} | ${med(x.scores)} | ${x.flagged} (${pct(x.flagged, x.n)}) | ${x.under50} (${pct(x.under50, x.n)}) | ${x.local.off} (${pct(x.local.off, x.n)}) | ${x.mergedOff} (${pct(x.mergedOff, x.n)}): ${x.mergedTone} tone, ${x.mergedSound} sound | ${wrong ? "caught" : "false alarms"} | ${x.mergedOk} (${pct(x.mergedOk, x.n)}) |`;
    const prec = (hit, alarm) => pct(hit, hit + alarm);
    azureSection = [
      `${replies} live replies from Azure Pronunciation Assessment (\`zh-CN\`, the REST short-audio endpoint in \`${"<region>"}.stt.speech.microsoft.com\`, free F0 tier, one request at a time)${failed ? `, ${failed} of them with nothing recognised` : ""}. Every clip was assessed against its own text; each single syllable also against the other three tones of the same syllable, which is the wrong-tone sample: the audio of 妈 with 马 as the reference text. There are no wrong-tone phrase samples for Azure (it needs real characters as the reference, and the proof's phrase relabellings are pinyin only).`,
      "",
      `| | Syllables | Azure's median score | Azure marks the word \`Mispronunciation\` | Azure score under ${AZURE_RULES.offBelow} | Local scorer alone flags | Merged result flags | which are | Merged result says ok |`,
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      line("Singles, right reference", g.singleRight, false),
      line("Singles, wrong-tone reference", g.singleWrong, true),
      line("Phrases, right reference", g.phraseRight, false),
      "",
      "Where Azure's syllable score separates right from wrong, and where it doesn't. Syllables scoring under each bar (in brackets: those on a word Azure also marks `Mispronunciation`):",
      "",
      "| Score under | Singles, right | Singles, wrong tone | Phrases, right |",
      "| --- | --- | --- | --- |",
      ...[30, 40, 50, 60, 70].map((bar) => `| ${bar} | ${[g.singleRight, g.singleWrong, g.phraseRight].map((x) => `${x.marks.filter((k) => k.score < bar).length} (${x.marks.filter((k) => k.score < bar && k.mis).length}) of ${x.marks.length}`).join(" | ")} |`),
      "",
      `\`phraseMarginSt\` (the extra margin a flag needs inside a phrase, ${RULES.phraseMarginSt} semitones) was set after looking at these very syllables, above every phrase false alarm on Azure's timings: correctly said phrase syllables flagged with it at 0, 0.25 and 0.5 are ${mergedAtMargin[0]}, ${mergedAtMargin[0.25]} and ${mergedAtMargin[0.5]} of ${g.phraseRight.n}, and the cleanly measured right syllable that comes closest sits at ${Number.isFinite(worstMargin) ? worstMargin.toFixed(3) : "n/a"}. So phrase flags rest on a thin margin that these clips chose.`,
      "",
      mergedAlarms.length ? `The merged result's false alarms: ${mergedAlarms.join("; ")}.` : "The merged result flagged no correctly said syllable.",
      "",
      "A high Azure score is not evidence of a right tone (the median wrong-tone syllable scores above 60), so the merged result never turns an unclear pitch reading into \"ok\" on Azure's word.",
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
  // And nearly the most it takes: 27 seconds, 60 syllables.
  const long = new Float32Array(clip.sampleRate * 27);
  for (let i = 0; i < long.length; i++) long[i] = clip.samples[i % clip.samples.length];
  const sixty = Array.from({ length: 60 }, (_, i) => syllables[i % syllables.length]);
  const spans = sixty.map((_, i) => ({ startMs: i * 450, endMs: i * 450 + 400 }));
  const timeOf = (more) => {
    const took = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      scoreTones({ samples: long, sampleRate: clip.sampleRate, syllables: sixty, ...more });
      took.push(performance.now() - t0);
    }
    return took.sort((a, b) => a - b)[2].toFixed(0);
  };
  const track = trackPitch(long, clip.sampleRate);
  timing += `. The most it takes, 27 seconds and 60 syllables (the clip looped; median of 5): ${timeOf({})} ms cut by energy, ${timeOf({ timings: spans })} ms on timings; the pitch track is the same work in both, and with the track already in hand the rest is ${timeOf({ track })} ms and ${timeOf({ track, timings: spans })} ms`;
}

const clipCount = voices.reduce((n, v) => n + v.clips.size, 0);
const lines = [];
const p = (...s) => lines.push(...s, "");
p("# Pronunciation scoring: proof of the local tone scorer");
p(`Written by \`node scripts/pronunciation-proof.mjs\` on ${new Date().toISOString().slice(0, 10)}. Rerun it to refresh; the clips are cached, so a rerun is free. Stage 0 of the pronunciation feature (bead ld-ne0.1); the engine is \`scripts/pronunciation.mjs\`, described in [VOICE.md](VOICE.md#pronunciation).`);
p("## What was tested");
p(`${clipCount} synthesized clips from ${voices.length} voices: ${voices.map((v) => `${v.name}, ${v.gender}${v.range ? `, median ${v.range.medianHz.toFixed(0)} Hz` : ""}`).join("; ")}. Each voice says ${SINGLES.length} single syllables (ma, shi, yi, ba in each of the four tones: ${SINGLES.join(" ")}) and ${PHRASES.length} phrases (${PHRASES.join("、")}).`);
p(`The clips begin with their first sound. No microphone recording does, and the scorer takes a recording that is loud from its first frame for one that started mid-word (its first syllable is "unsure", reason "clipped"). So every clip is scored with ${LEAD_MS} ms of silence put before it, and the recognisers' cached times are moved by as much.`);
p("There are no learner recordings, so every clip is used twice over. Scored against its own text it is a **right** answer: an \"off\" there is a false alarm. Scored against the same syllables with one tone changed it is a **wrong** answer: 妈 labelled 马 is a learner who said mā for mǎ, and an \"off\" on that syllable is a catch. The connected-speech rules are applied to each label first, so a relabelling that the rules make equivalent (你 as ní before 好) is not counted as wrong. Syllables whose true or labelled tone is neutral are left out: the scorer does not judge them.");
p("The number that matters is how many \"off\" flags are false: a learner told a right tone was wrong stops believing the marks. A miss costs less. The set holds about three wrong labels for each right one, which flatters raw precision, so each table also restates it for a learner who gets one tone in five wrong.");
if (heldOut) {
  const sum = (kind, side, v) => heldOut.reduce((n, h) => n + (v === "all" ? h.test[kind][side].ok + h.test[kind][side].unsure + h.test[kind][side].off : h.test[kind][side][v]), 0);
  const line = (kind, label) => {
    const right = sum(kind, "right", "all");
    const wrong = sum(kind, "wrong", "all");
    const alarms = sum(kind, "right", "off");
    const caught = sum(kind, "wrong", "off");
    const bound = upperBound(alarms, right);
    const recall = caught / wrong;
    const stage0 = Object.values(STAGE0).reduce((n, v) => n + v[`${kind}Caught`], 0);
    const stage0Alarms = Object.values(STAGE0).reduce((n, v) => n + v[`${kind}Alarms`], 0);
    return `| ${label} | ${stage0} of ${wrong} (${pct(stage0, wrong)}), ${stage0Alarms} of ${right} false alarms | **${caught} of ${wrong} (${pct(caught, wrong)})** | **${alarms} of ${right} (${pct(alarms, right)})** | under ${(100 * bound).toFixed(1)}% | at least ${(100 * (0.2 * recall) / (0.2 * recall + 0.8 * bound)).toFixed(0)}% |`;
  };
  p("## Headline: held out by voice");
  p("The numbers to quote. Thresholds chosen on two voices, measured on the other two, both directions added up (details under \"Held out by voice\" below). Speaker's range known (from the voice's other clips), cuts by energy.");
  p(["| | Stage 0, same clips | Wrong tones caught | Right syllables flagged (false alarms) | 95% upper bound on the false-alarm rate | Precision of a flag at that bound, one tone in five wrong |", "| --- | --- | --- | --- | --- | --- |", line("single", "Single syllables"), line("phrase", "Phrases")].join("\n"));
  const half = heldOut.map((h) => `${h.testedOn.map((v) => v.name.split(" (")[0]).join(" + ")}: ${h.test.phrase.right.off} of ${h.test.phrase.right.ok + h.test.phrase.right.unsure + h.test.phrase.right.off}`).join("; ");
  p(`The phrase false alarms by half: ${half}. Every other table in this report except "Held out by voice" is **in-sample**: it runs the engine's defaults, which were chosen with all four voices in view, on those same four voices, and reads better than the table above for that reason alone.`);
  p(`What "held out" covers and what it doesn't: only the ${Object.keys(GRID).length} thresholds in the search (${Object.keys(GRID).map((k) => `\`${k}\``).join(", ")}) were chosen without the test voices. The shape of every rule, the tone templates, and the other constants (\`dipShare\`, \`riseShare\`, \`riseStart\`, \`stillSt\`, \`highLevel\`, \`lowTop\`, \`lateFrom\`, \`scaleRange\`, \`creakFlags\`) were written while looking at all four voices, and \`phraseMarginSt\` was set just above the phrase false alarms seen on them (see "Azure, live"). So even the held-out numbers are optimistic for a new voice.`);
}
p("## Results (in-sample)");
p("The engine's defaults on the four voices they were tuned on.");
const head = ["| | Singles, speaker unknown | Singles, range known | Phrases, speaker unknown | Phrases, range known" + (haveScribe ? " | Phrases, Scribe anchors, range known | Phrases, Scribe times as cuts, range known |" : " |")];
head.push(`| --- | --- | --- | --- | ---${haveScribe ? " | --- | --- |" : " |"}`);
const sums = results.map((r) => summary(r.tally));
// What the trim does to these clips, counted rather than asserted.
const trimNote = (() => {
  let clips = 0;
  let voicedLost = 0;
  const tails = [];
  for (const v of voices) {
    let touched = 0;
    for (const clip of v.clips.values()) {
      clips++;
      const trimmed = trimToSpeech(clip.track);
      let peak = 0;
      for (let i = 0; i < clip.track.f0.length; i++) if (clip.track.f0[i] > 0 && clip.track.rms[i] > peak) peak = clip.track.rms[i];
      let voiced = false;
      let loud = false;
      for (let i = 0; i < clip.track.f0.length; i++) {
        if (clip.track.f0[i] > 0 && !(trimmed.f0[i] > 0)) voiced = true;
        // "Loud": within 22 dB of the loudest voiced frame.
        if (clip.track.rms[i] > 0.08 * peak && !(trimmed.rms[i] > 0)) loud = true;
      }
      if (voiced) voicedLost++;
      if (loud) touched++;
    }
    if (touched) tails.push(`${touched} of ${v.name.split(" (")[0]}'s`);
  }
  const loudNote = tails.length ? `in ${tails.join(", ")} it silences unvoiced frames within 22 dB of the loudest voiced frame (the breathy end of a last syllable, past the ${TRIM_RULES.afterMs} ms kept after the voicing)` : "it silences no frame within 22 dB of the loudest voiced frame";
  return `On these ${clips} clips the bars alone (\`trimToSpeech\`, one opinion of where the speech is) remove a voiced frame from ${voicedLost}, and ${loudNote}. It is for real recordings, which have seconds of room and key noise around the speech.`;
})();
const creakNote = ["phraseScribe", "single"].map((key) => {
  const r = results.find((x) => x.key === key);
  return r ? `${r.tally.wrong.ok} of ${r.tally.wrong.ok + r.tally.wrong.off + r.tally.wrong.unsure} (${r.title.toLowerCase()})` : null;
}).filter(Boolean).join(" and ");
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
  const upper = upperBound;
  const bounds = results.map((r, i) => `${r.title.toLowerCase()}: ${r.tally.right.off} of ${sums[i].right}, so under ${(100 * upper(r.tally.right.off, sums[i].right)).toFixed(1)}%`);
  p(`These are small counts. A false-alarm rate measured on a few dozen or a couple of hundred syllables is only bounded, not known: with 95% confidence, ${bounds.join("; ")}. And that bound is for voices like these, on the set the thresholds were tuned on.`);
  // What that bound does to precision for a learner with one tone in five
  // wrong: the catch rate as measured, the false-alarm rate at its bound.
  const floors = results.map((r, i) => {
    const wrong = sums[i].wrong;
    const recall = wrong ? r.tally.wrong.off / wrong : 0;
    const alarm = upper(r.tally.right.off, sums[i].right);
    return `${r.title.toLowerCase()}: at least ${(100 * (0.2 * recall) / (0.2 * recall + 0.8 * alarm)).toFixed(0)}%`;
  });
  p(`So "a flag can be trusted" is not established by these counts, only not contradicted. With the false-alarm rate at that upper bound and the catch rate as measured, the precision of a flag for a learner who gets one tone in five wrong is only known to be (in-sample; the held-out figures in the headline are lower): ${floors.join("; ")}. Narrowing that takes more right syllables, from real people.`);
}
p("\"Range known\" gives the scorer the voice's pitch range measured over that voice's other clips (never the one being scored), which is what a session would know after a few turns. \"Speaker unknown\" is a first recording: only the shape of the contour counts, plus the recording's own range once it holds four syllables.");
p("## The classifier before any gate");
p("What tone the classifier names for each single syllable (speaker's range known), whatever it then decides to say about it. This is the question \"is it misreading the pitch, or just not daring to flag?\".");
p(["| Voice | Named the labelled tone | tone 1 heard as 1/2/3/4 | tone 2 | tone 3 | tone 4 |", "| --- | --- | --- | --- | --- | --- |",
  ...rawByVoice.map((v) => `| ${v.name.split(" (")[0]} | ${v.ok} of ${v.n} | ${[1, 2, 3, 4].map((tone) => [1, 2, 3, 4].map((h) => v.t.confusion[tone][h]).join("/") + (v.t.confusion[tone].none ? ` (+${v.t.confusion[tone].none} nothing)` : "")).join(" | ")} |`),
  `| **All** | **${rawByVoice.reduce((n, v) => n + v.ok, 0)} of ${rawByVoice.reduce((n, v) => n + v.n, 0)}** | | | | |`].join("\n"));
p("So the classifier mostly reads the pitch right (stage 0's named 53 of 64); the catch rate is lower than this because a flag asks for more than a best guess. What the contours of the misread and unflagged clips showed when looked at one by one: two of Rachel's first tones (妈, 八) fall by 9 and 14 semitones, a fourth tone's contour whatever the label says (Azure scores that 八 at 90 against 爸 and 61 against 八), so those two \"errors\" are probably the clips; the macOS voices say some second tones as a dip that comes back up and some third tones as a shallow dip that rises, which are each other's shapes; one fourth tone starts in the middle of the range and reads as a low third; and Adam's voice creaks, leaving a hole in the middle of several pitch tracks, which costs flags, not readings. No miss on these clips came from an octave error, from the consonant at the start, or from the range used to normalise. The misses came from the gate: stage 0 never flagged third against second or fourth in either direction (a third of all wrong labels), asked for four semitones of movement, and let a second tone's first dip or a fourth tone's first rise count as \"it climbs\" or \"it drops\".");
p("Where the catches are and aren't, by which tone was said for which (range known; caught / marked ok / all):");
{
  const cellsOf = (key) => results.find((r) => r.key === key)?.tally.pairs ?? {};
  const one = cellsOf("singleBase");
  const two = cellsOf("phraseBase");
  const fmt = (c) => (c ? `${c.off} / ${c.ok} / ${c.n}` : "–");
  p(["| Said → labelled | Singles | Phrases |", "| --- | --- | --- |", ...[...new Set([...Object.keys(one), ...Object.keys(two)])].sort().map((k) => `| ${k} | ${fmt(one[k])} | ${fmt(two[k])} |`)].join("\n"));
  p("Three pairs stay close to uncatchable by design: a third tone said for a fourth (3→4: a low fall is both), a fourth that starts low said for a third, and second against third when the second dips or the third comes back up. These voices disagree with each other about exactly those shapes, so a flag there would be a guess.");
}
if (heldOut) {
  p("## Held out by voice");
  p(`The thresholds a flag rests on were chosen on two voices and measured on the other two, which had no say in them, then the other way round. \"Chosen\" means: of ${[...grid()].length} settings (${Object.entries(GRID).map(([k, v]) => `\`${k}\` ${v.join("/")}`).join(", ")}), the one that catches the most wrong tones on the tuning voices while flagging at most one of their right syllables. Range known, cuts by energy, each clip read against the range of the voice's other clips.`);
  const cell = (c, kind) => {
    const t = c[kind];
    const right = t.right.ok + t.right.unsure + t.right.off;
    const wrong = t.wrong.ok + t.wrong.unsure + t.wrong.off;
    return `${t.wrong.off} of ${wrong} (${pct(t.wrong.off, wrong)}) caught, ${t.right.off} of ${right} false alarms`;
  };
  const before = (group, kind) => {
    const caught = group.reduce((n, v) => n + STAGE0[v.id][`${kind}Caught`], 0);
    const alarms = group.reduce((n, v) => n + STAGE0[v.id][`${kind}Alarms`], 0);
    const wrong = kind === "single" ? 48 * group.length : 144 * group.length;
    return `${caught} of ${wrong} (${pct(caught, wrong)}) caught, ${alarms} false alarms`;
  };
  const names = (g) => g.map((v) => v.name.split(" (")[0]).join(" + ");
  p(["| Tuned on | Measured on | | Stage 0 (before) | Tuned on the other two (held out) | The engine's defaults (in-sample) |", "| --- | --- | --- | --- | --- | --- |",
    ...heldOut.flatMap((h) => ["single", "phrase"].map((kind) => `| ${names(h.tunedOn)} | ${names(h.testedOn)} | ${kind === "single" ? "Singles" : "Phrases"} | ${before(h.testedOn, kind)} | ${cell(h.test, kind)} | ${cell(h.defaults, kind)} |`))].join("\n"));
  p(`Settings chosen: ${heldOut.map((h) => `on ${names(h.tunedOn)} \`${JSON.stringify(h.rules)}\``).join("; ")}. The engine's defaults are the setting chosen on all four voices where the two halves agree, and the more cautious value where they don't; the defaults column is therefore not held out, and the held-out column is the honest one. The stage 0 numbers are from that commit's report (same clips; its range included the clip being scored).`);
  const alarms = heldOut.flatMap((h) => [...h.test.single.falseAlarms, ...h.test.phrase.falseAlarms]);
  if (alarms.length) p(`Held-out false alarms: ${[...new Set(alarms)].join("; ")}.`);
}
p("## The trade-off (in-sample)");
p("The same clips (all four voices, range known) at several values of `offMarginSt`: how many semitones past its bar the evidence must be before a syllable is flagged. Negative values flag contours that only nearly rule the label out.");
{
  const lineOf = (label, c) => {
    const n = (t, side) => t[side].ok + t[side].unsure + t[side].off;
    return `| ${label} | ${c.single.right.off} of ${n(c.single, "right")} | ${c.single.wrong.off} of ${n(c.single, "wrong")} (${pct(c.single.wrong.off, n(c.single, "wrong"))}) | ${c.phrase.right.off} of ${n(c.phrase, "right")} | ${c.phrase.wrong.off} of ${n(c.phrase, "wrong")} (${pct(c.phrase.wrong.off, n(c.phrase, "wrong"))}) |`;
  };
  p(["| `offMarginSt` | Singles: false alarms | Singles: caught | Phrases: false alarms | Phrases: caught |", "| --- | --- | --- | --- | --- |",
    ...tradeOff.map((x) => lineOf(`${x.offMarginSt}${x.offMarginSt === RULES.offMarginSt ? " (default)" : ""}`, x.c)),
    lineOf("default, and creaky syllables flagged too (`creakFlags`)", counts(voices, { ...RULES, creakFlags: true }))].join("\n"));
  p("`creakFlags` is off by default. Turning it on catches more in a creaky voice, and its one extra false alarm here is Rachel's 八, the clip that falls 14 semitones; but a pitch track with a hole in it is where octave errors hide, and nothing here can tell those from a real fall, so it stays off until real recordings say otherwise.");
}
p("## With lead-in noise");
p("The clips above start and end with the speech. A push-to-talk recording doesn't: there is room noise, a key press, a knock, a cough, another voice, a hum, and the scorer has to know where the speech is before it can read a tone. This section puts those surroundings around every cached clip and scores it again, the speaker's range known, two ways: **cut by energy** (no timings: the fallback, which has to find the speech itself) and **on syllable timings** (Azure's cached reply for the CLEAN clip, each syllable's start and end moved by the lead-in; no new call was made, so Azure never heard the noisy audio). Every syllable's verdict is compared with the same syllable's verdict on the clean clip, scored the same way, because totals hide a verdict lost here and another gained there. The rule: a disturbance may cost verdicts (the third number of \"changes\"); it must not add a false alarm or a wrong tone passed as ok (the first two). The same disturbances, in small and on generated audio, are in `npm test`.");
p(noiseTable().join("\n"));
p(`Levels are dB against the clip's loudest 10 ms; knocks, blips and the murmur are a buzz at 220 Hz, the cough a noise burst over a falling 180 Hz buzz, the child three syllables at 300 to 380 Hz. The generated phrases (three voices, twelve tone patterns each, every syllable also relabelled with each other tone) are the cases the cached clips can't express; their timings are where the generator put each syllable. ${noiseStudy().untimed ? `${noiseStudy().untimed} clips have no usable cached Azure reply and are left out of the timings tables. ` : ""}The new wrong tone passed as ok that plain silence adds on the energy path is not noise: padding moves the 20 ms analysis frames, and a syllable on the edge of a bar falls the other way.`);
p([
  "What the tables say:",
  "",
  "- **On timings, nothing outside the spans it is given changes a verdict**: blips, knocks, a cough or a child's voice in the lead-in leave every row as the clean one. The scorer measures pitch inside the spans only and takes the silence floor, the octave repairs, the range gate and the recording's own range from inside them. **This is true by construction, and the rows assume what was not measured: that a recogniser draws the same spans on the noisy recording as on the clean one.** Azure was sent the clean clips only. A recogniser that stretches a span over a knock, or moves every span when there is a cough, gives the scorer wrong spans, and what happens then is the next section.",
  "- **Cut by energy, every doubt is \"unsure\".** A sound the bars can't place is read both as speech and as noise, in every combination, and a verdict stands only where all readings agree on the verdict and the tone (\"trimmed\"); sounds long enough to be a syllable (60 ms of sound, which is a 90 ms voiced run in the track: a 40 ms knock is not one) that lie apart leave the whole recording unjudged (\"scattered\"), since one may be a cough or another voice. That is why a single stray blip costs most of a phrase's verdicts. **Under noise the fallback is safe, not useful**: with a cough, another voice or a hum it says nothing at all.",
  `- **The caution costs right answers on clean clips too.** Before the rework (commit e75a163) the energy path marked 89.1% of correctly said single syllables and 70.8% of correctly said phrase syllables \"ok\"; the rework took that to 85.9% and 66.1% (an independent review's count); in this run, with the lead-in, it is ${sums[results.findIndex((r) => r.key === "singleBase")].rightOk} and ${sums[results.findIndex((r) => r.key === "phraseBase")].rightOk}. Wrong tones caught did not fall.`,
  "- **A hum** leaves everything unjudged on both paths (\"background\"): it is under the syllables too.",
  "- **A recording that starts mid-word** is loud from its first frame: the syllable it starts in is not judged (\"clipped\"), on either path. The other syllables of a phrase are still cut by energy from a first syllable that is partly missing, and that row's phrase numbers show what is left.",
  "- **Not made safe, on either path**: a pitched knock on top of the first sound, and a room that echoes. Each puts the disturbance inside the syllable, where no way of locating the speech can take it out; the rows show the false alarms and wrong oks that remain. A sound inside a timed span (a knock or cough within the last syllable's span, which Azure draws past the end of the sound) is mostly caught as two sounds in one span (\"apart\"), not always.",
].join("\n"));
p("## When the spans are wrong");
p(`The timings path believes its spans. This section gives it wrong ones: Azure's spans for each clean clip, moved or redrawn in ways that still pass the checks on their shape (in order, plausible lengths), and each syllable's verdict compared with its verdict on the spans as Azure gave them. Columns are new false alarms / new wrong tones passed as ok / right verdicts lost; "no guards" is the scorer reading each span as given, "guarded" is the scorer as it ships. Whether and how often Azure's spans are wrong like this on a real microphone is not known: these are the errors a reviewer thought of, not errors observed.`);
p(spanTable().join("\n"));
{
  const { cost, clean } = spanStudy();
  const totals = (f) => `${f.caught} of ${f.wrong} caught / ${f.falseAlarms} of ${f.right} false alarms / ${f.passed} passed as ok`;
  p([
    "The guards (`TIMING_RULES`):",
    "",
    `- **Edges.** Every recording is read again with all its spans ${TIMING_RULES.jitterMs} ms earlier and later, and with each boundary between two neighbours ${TIMING_RULES.jitterMs} ms either way; a verdict stands only where every reading gives it, for the same tone ("edges" otherwise). A reading in which the moved span merely takes in a separate sound ("apart") is not held against the verdict.`,
    `- **Lopsided.** Of two neighbouring spans, one with hardly any voice in it, or one under ${TIMING_RULES.sliverMs} ms beside one ${TIMING_RULES.lopsided} times its length: neither is judged where the other took its sound.`,
    `- **What they cost on the spans as Azure gave them**: ${cost.single.lost} single and ${cost.phrase.lost} phrase verdicts, and no new false alarm or wrong ok. Singles: ${totals(clean.bare.single)} without the guards; ${totals(clean.guarded.single)} with. Phrases: ${totals(clean.bare.phrase)} without; ${totals(clean.guarded.phrase)} with. The timings tables in the section above are the guarded scorer.`,
    "- **What they don't stop**: spans wrong by much more than the jitter in a way that still looks like syllables. The rows for 100 and 150 ms keep wrong tones passed as ok. A wrong span costs most of its clip's verdicts either way, which is the right price.",
    "- **A word Azure times as a whole** (no per-syllable times) is cut by energy inside that word's span only, on pitch finished on that span alone, and those cuts count for what any fallback cut does (`rough`).",
  ].join("\n"));
}
p("## Real recordings");
// Nothing of a person's recordings goes into this tracked file: not a
// name, not a count, not a result.
p("Everything above is synthesized speech. Real recordings are the next step: `npm run pron:record` collects them and `npm run pron:proof` scores them, per speaker, into `data/pronunciation-proof/recordings/report.md` and the terminal. That folder is gitignored and its results are deliberately left out of this report.");
p(RECORDINGS_HELP);
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
p(`\`TONE_RULES\` = \`${JSON.stringify(RULES)}\`${process.env.LINGO_PROOF_RULES ? " (overridden by LINGO_PROOF_RULES: not the engine's defaults)" : ""}; cuts made by energy are trusted at ${FALLBACK_TRUST}. With timings they are checked first (\`TIMING_RULES\` = \`${JSON.stringify(TIMING_RULES)}\`); without, the speech is found by energy (\`TRIM_RULES\` = \`${JSON.stringify(TRIM_RULES)}\`). ${trimNote}`);
p("");
p(`**What these clips cannot measure.** Every number in \`TRIM_RULES\`, and the half weight a creaky syllable's "ok" carries, was set on 43 real recordings from one speaker, one microphone, one room; none of them is held out, and synthesized voices barely creak. So the energy path doesn't rest a verdict on them: where the bars can't place a sound, the result is "unsure". What that costs and what it lets through is "With lead-in noise" above, and its small copy in \`npm test\`.`);
p("");
p(`**Creaky syllables.** A creaky syllable may be "ok" when its voiced part fits (it is never "off"), is marked \`creaky\`, and is left out of \`overall\`. That rule let more wrong tones pass as ok when it was introduced: phrases on Scribe's cuts went from 52 to 58 of 576, single syllables with nothing known about the speaker from 24 to 25 of 192 (the commit before against the commit with it, same clips). In this run: ${creakNote}.`);
p("## Before wiring this to a route");
p([
  "- **Start with single syllables and drills.** Their flags have room to spare; phrase flags rest on a half-semitone margin chosen on these clips, and the held-out phrase false alarms are the highest number in this report.",
  "- **Build the speaker's range only from the learner's other recordings**, never from the one being scored, and not at all until there are a few: without a range the height rules are silent, which is the safe side.",
  "- **Run it off the request thread.** The scorer is synchronous and refuses more than 30 seconds or 60 syllables. A pitch track made on one thread and scored on another is fine: the raw pitch is a field of the track (`rawF0`) and survives the copy; a track without it is tracked again from the samples, or nothing is judged.",
  "- **Check the recogniser's spans on real noisy recordings before trusting the timings path there**: send the same speech clean and with a knock, a cough, another voice, and compare the spans that come back. Nothing in this report measures that.",
  "- **Refuse or re-ask a recording that starts loud.** The scorer leaves its first syllable unjudged; the learner pressed the button late.",
  "- **Show unsure as nothing**, not as a soft warning: a third to a half of right syllables are unsure.",
  "- **Collect real recordings first** (the section above) and rerun this report: every number here is from four synthesizers.",
].join("\n"));
p("## Limitations");
p([
  "- **Synthesized speech is not a learner.** These voices hit their tones cleanly, in quiet, at an even pace. A learner's wrong tone is rarely a clean other tone: it is a flat second tone, a fourth that barely falls, a third with no dip. Those land in \"unsure\" by design, so on real learners expect fewer catches than here, and treat the false-alarm rate as a floor until real recordings are scored.",
  "- **The wrong answers are other syllables' right answers**, not mistakes: they are well-formed tones, the easiest kind of wrong to spot.",
  "- **The thresholds were tuned on these voices.** The held-out table tunes on two voices and measures on the other two, which is the fairest number here, but all four are synthesizers and two of them are the same engine. It shows the setting is not fitted to one voice; it does not show it fits a person.",
  "- **Nobody has tested a child's voice.** The pitch tracker searches 60–800 Hz and tones are read against the speaker's own range, so nothing in the design excludes one, but no child (and no synthesized child) is in the set.",
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
if (recordings) writeRecordingsReport();
for (const [i, r] of results.entries()) console.log(r.key.padEnd(13), JSON.stringify(sums[i]));
if (args.has("--dump")) {
  for (const r of results) {
    console.log(r.key, "false alarms:", r.tally.falseAlarms.join("; "));
    console.log(r.key, "wrong tones:", JSON.stringify(r.tally.why));
    console.log(r.key, "said→labelled caught/ok/n:", Object.entries(r.tally.pairs).sort().map(([k, c]) => `${k} ${c.off}/${c.ok}/${c.n}`).join("  "));
  }
}
