#!/usr/bin/env node
// What Azure echoes back for the word check's awkward spellings and for a
// take with no speech in it (ld-ne0.16, review round 2): a handful of live
// Pronunciation Assessment replies that the word placement (`wordMarks`)
// and the no-speech rule (`azureHeardNothing`) in
// scripts/pronunciation-words.mjs were set from. Not part of `npm test`.
//
//   node scripts/pronunciation-proof-echo.mjs           print what is cached
//   node scripts/pronunciation-proof-echo.mjs --say     make the clips (free: macOS `say`, silence, noise)
//   node scripts/pronunciation-proof-echo.mjs --azure   send the missing ones (PAID; shares the word
//                                                       proof's ledger and its cap of 400 calls)
//
// Clips are free macOS voices, a silent one and a white-noise one. Keys come
// through scripts/voice.mjs voiceKeys (the process environment, e.g. node
// --env-file pointed at the main checkout's .env.local); never printed.
// Replies are cached under data/pronunciation-proof/words/echo/ (gitignored);
// the test fixtures in scripts/tests/fixtures/pronunciation/azure-echo.json are copied from
// them (`--fixtures`), reply shape only.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { azurePronunciationRequest, encodeWav, parseWav, pronunciationProvider } from "./pronunciation.mjs";
import { voiceKeys } from "./voice.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORDS = path.join(process.env.LINGO_PROOF_DIR ? path.resolve(process.env.LINGO_PROOF_DIR) : path.join(REPO, "data", "pronunciation-proof"), "words");
const DIR = path.join(WORDS, "echo");
const LEDGER = path.join(WORDS, "calls.tsv");
const MAX_CALLS = 400;
/** This probe's own share of the allowance (the review's budget). */
const PROBE_MAX = 24;
const FIXTURES = path.join(REPO, "scripts", "tests", "fixtures", "pronunciation", "azure-echo.json");
const args = new Set(process.argv.slice(2));

/** Each case: what is said (a voice and a text, or "silence"/"noise") and
 *  what it is assessed against. */
export const ECHO_CASES = [
  { id: "ar-full", locale: "ar-SA", voice: "Majed", said: "كَتَبَ الطَّالِبُ الدَّرْسَ", ref: "كَتَبَ الطَّالِبُ الدَّرْسَ", why: "full harakat" },
  { id: "ar-part", locale: "ar-SA", voice: "Majed", said: "شُكراً جزيلاً يا سَلامٌ", ref: "شُكراً جزيلاً يا سَلامٌ", why: "partly vocalised, tanween" },
  { id: "ar-tatweel", locale: "ar-SA", voice: "Majed", said: "شكـــرا جزيلا", ref: "شكـــرا جزيلا", why: "tatweel" },
  { id: "de-ss", locale: "de-DE", voice: "Anna", said: "Die Straße ist groß.", ref: "Die Straße ist groß.", why: "ß" },
  { id: "fr-apos", locale: "fr-FR", voice: "Thomas", said: "J'ai bu de l'eau.", ref: "J'ai bu de l'eau.", why: "apostrophes" },
  { id: "fr-hyphen", locale: "fr-FR", voice: "Thomas", said: "On a rendez-vous demain, d'accord ?", ref: "On a rendez-vous demain, d'accord ?", why: "hyphen" },
  { id: "es-si", locale: "es-MX", voice: "Paulina", said: "Sí, si quieres.", ref: "Sí, si quieres.", why: "sí / si" },
  { id: "hi-matra", locale: "hi-IN", voice: "Lekha", said: "मुझे किताब की ज़रूरत है", ref: "मुझे किताब की ज़रूरत है", why: "matras, nukta" },
  { id: "ja-ga", locale: "ja-JP", voice: "Kyoko", said: "私が行きます", ref: "私が行きます", why: "dakuten" },
  { id: "es-wrong1", locale: "es-MX", voice: "Paulina", said: "hola", ref: "gracias", why: "one word said, another referenced" },
  { id: "fr-wrong1", locale: "fr-FR", voice: "Thomas", said: "bonjour", ref: "merci", why: "one word said, another referenced" },
  { id: "de-wrong1", locale: "de-DE", voice: "Anna", said: "Danke", ref: "Tschüss", why: "one word said, another referenced" },
  { id: "es-wrong2", locale: "es-MX", voice: "Paulina", said: "buenas noches", ref: "muchas gracias", why: "two words said, two others referenced" },
  { id: "es-silence", locale: "es-MX", voice: "silence", said: "", ref: "hola", why: "silence" },
  { id: "es-noise", locale: "es-MX", voice: "noise", said: "", ref: "hola", why: "white noise" },
  { id: "de-noise", locale: "de-DE", voice: "noise", said: "", ref: "Danke schön", why: "white noise" },
];

const slug = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const clipFile = (c) => path.join(DIR, `${c.id}-${slug(`${c.voice}|${c.said}`)}.wav`);
const replyFile = (c) => path.join(DIR, `${c.id}-${slug(`${c.voice}|${c.said}|${c.ref}`)}.json`);
const ledgerLines = () => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean) : []);

function makeClips() {
  fs.mkdirSync(DIR, { recursive: true });
  const rate = 16_000;
  const pad = Math.round(0.2 * rate);
  for (const c of ECHO_CASES) {
    const out = clipFile(c);
    if (fs.existsSync(out)) continue;
    let samples;
    if (c.voice === "silence") samples = new Float32Array(Math.round(1.5 * rate));
    else if (c.voice === "noise") {
      // Seeded, so the clip is the same every time it is made.
      let x = 12345;
      samples = Float32Array.from({ length: Math.round(1.5 * rate) }, () => {
        x = (x * 1103515245 + 12345) % 2 ** 31;
        return (x / 2 ** 31 - 0.5) * 0.3;
      });
    } else {
      const raw = `${out}.raw.wav`;
      execFileSync("say", ["-v", c.voice, "-o", raw, "--data-format=LEI16@16000", c.said]);
      samples = parseWav(fs.readFileSync(raw)).samples;
      fs.rmSync(raw);
    }
    const padded = new Float32Array(samples.length + 2 * pad);
    padded.set(samples, pad);
    fs.writeFileSync(out, encodeWav(padded, rate));
  }
  console.log("say: clips ready");
}

async function fetchAzure() {
  const keys = voiceKeys();
  if (pronunciationProvider(keys) !== "azure") throw new Error("no AZURE_SPEECH_KEY / AZURE_SPEECH_REGION");
  let probe = ledgerLines().filter((l) => l.endsWith("\techo")).length;
  for (const c of ECHO_CASES) {
    const out = replyFile(c);
    if (fs.existsSync(out)) continue;
    if (ledgerLines().length >= MAX_CALLS) throw new Error(`the allowance of ${MAX_CALLS} calls is spent`);
    if (probe >= PROBE_MAX) throw new Error(`this probe's ${PROBE_MAX} calls are spent`);
    const request = azurePronunciationRequest({ key: keys.azureKey, region: keys.azureRegion, audio: fs.readFileSync(clipFile(c)), locale: c.locale, referenceText: c.ref, scripted: true });
    fs.appendFileSync(LEDGER, `${new Date().toISOString()}\t${c.locale}\techo\n`);
    probe++;
    const r = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(30_000) });
    // The status only: an error body can echo request details.
    if (!r.ok) throw new Error(`azure ${c.id}: HTTP ${r.status}`);
    fs.writeFileSync(out, JSON.stringify(await r.json()));
    await new Promise((res) => setTimeout(res, 1200));
  }
  console.log(`Azure: ${probe} probe calls in all; ledger ${ledgerLines().length} of ${MAX_CALLS}`);
}

/** The reply with what the tests need: status, the texts, and per word its
 *  text, error, score, timing and phonemes' scores (names kept: empty). */
function shape(json) {
  const best = Array.isArray(json?.NBest) ? json.NBest[0] : null;
  return {
    RecognitionStatus: json?.RecognitionStatus,
    ...(json?.DisplayText !== undefined ? { DisplayText: json.DisplayText } : {}),
    ...(best
      ? {
          NBest: [
            {
              Lexical: best.Lexical, ITN: best.ITN, Display: best.Display, PronScore: best.PronScore, AccuracyScore: best.AccuracyScore,
              Words: (best.Words ?? []).map((w) => ({ Word: w.Word, Offset: w.Offset, Duration: w.Duration, AccuracyScore: w.AccuracyScore, ErrorType: w.ErrorType })),
            },
          ],
        }
      : {}),
  };
}

if (args.has("--say")) makeClips();
if (args.has("--azure")) await fetchAzure();
const got = {};
for (const c of ECHO_CASES) {
  const f = replyFile(c);
  if (!fs.existsSync(f)) {
    console.log(`${c.id}: not fetched`);
    continue;
  }
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  got[c.id] = { case: c, reply: shape(j) };
  const b = j.NBest?.[0];
  console.log(`${c.id} [${c.why}] ref=${JSON.stringify(c.ref)} status=${j.RecognitionStatus} DisplayText=${JSON.stringify(j.DisplayText ?? null)} Display=${JSON.stringify(b?.Display ?? null)} Lexical=${JSON.stringify(b?.Lexical ?? null)}`);
  for (const w of b?.Words ?? []) console.log(`    ${JSON.stringify(w.Word)} ${w.ErrorType ?? w.PronunciationAssessment?.ErrorType} ${w.AccuracyScore ?? w.PronunciationAssessment?.AccuracyScore}`);
}
if (args.has("--fixtures")) {
  fs.mkdirSync(path.dirname(FIXTURES), { recursive: true });
  fs.writeFileSync(FIXTURES, `${JSON.stringify(got, null, 1)}\n`);
  console.log(`wrote ${path.relative(REPO, FIXTURES)}`);
}
