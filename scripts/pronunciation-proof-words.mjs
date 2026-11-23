#!/usr/bin/env node
// The proof for word-and-sound checks beyond Mandarin (ld-ne0.16): does
// Azure Pronunciation Assessment's per-word score and `ErrorType` tell a
// right word from a wrong one well enough to show a mark? Writes the
// "Words and sounds beyond Mandarin" section of docs/pronunciation-proof.md
// (between its markers; scripts/pronunciation-proof.mjs keeps the block
// when it rewrites the rest). Not part of `npm test`.
//
//   node scripts/pronunciation-proof-words.mjs           score the cached replies, write the section
//   node scripts/pronunciation-proof-words.mjs --say     first make the free macOS `say` clips
//   node scripts/pronunciation-proof-words.mjs --azure   first send the clips to Azure (PAID / free-tier quota;
//                                                        at most WORD_PROOF_MAX_CALLS requests ever, counted
//                                                        in a ledger written before each request)
//   node scripts/pronunciation-proof-words.mjs --dump    also print every word's score
//
// Clips come only from the free macOS voices (`say`). Each phrase is used
// three ways: a native voice reading it, assessed against its own text
// (every word right: an "off" is a false alarm); the same audio assessed
// against the phrase with one word swapped (that word is wrong: an "off" on
// it is a catch, and the words around it are still right); and an English
// voice reading it (a rough accent sample: no word-level truth, only how
// often words are flagged). The keys come from .env.local, or LINGO_ENV_FILE
// pointed at another checkout's, through scripts/voice.mjs voiceKeys; they
// are never printed or written. Replies are cached under
// data/pronunciation-proof/words/ (gitignored), so a rerun costs nothing.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { azurePronunciationRequest, encodeWav, parseWav, pronunciationProvider } from "./pronunciation.mjs";
import { WORD_RULES, azureWords, wordMarks } from "./pronunciation-words.mjs";
import { WORD_PROOF_SET, swappedText } from "./pronunciation-proof-words-set.mjs";
import { voiceKeys } from "./voice.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(process.env.LINGO_PROOF_DIR ? path.resolve(process.env.LINGO_PROOF_DIR) : path.join(REPO, "data", "pronunciation-proof"), "words");
const REPORT = process.env.LINGO_PROOF_REPORT || path.join(REPO, "docs", "pronunciation-proof.md");
const args = new Set(process.argv.slice(2));
/** Every Azure request this proof may ever make (the owner's allowance). */
export const WORD_PROOF_MAX_CALLS = 400;
const LEDGER = path.join(DIR, "calls.tsv");
const LEAD_MS = 200;

const slug = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const voiceSlug = (v) => v.replace(/[^A-Za-z0-9]+/g, "_");
const clipFile = (locale, voice, said) => path.join(DIR, locale, `${voiceSlug(voice)}-${slug(said)}.wav`);
const replyFile = (locale, voice, said, ref) => path.join(DIR, locale, `${voiceSlug(voice)}-${slug(said)}.azure.${slug(ref)}.json`);

/** Every (clip, reference) pair the proof sends, with what it is. */
function plan() {
  const out = [];
  for (const lang of WORD_PROOF_SET) {
    for (const item of lang.items) {
      lang.native.forEach((voice, k) => out.push({ lang, item, kind: "right", voice, said: item.text, ref: item.text, primary: k === 0 }));
      out.push({ lang, item, kind: "swap", voice: lang.native[0], said: item.text, ref: swappedText(item) });
      out.push({ lang, item, kind: "accent", voice: lang.accent, said: item.roman ?? item.text, ref: item.text });
    }
  }
  return out;
}

/** The `say` clips, 16 kHz mono, with 200 ms of silence each side (a
 *  recording never starts on its first sound). */
function makeClips() {
  let made = 0;
  for (const p of plan()) {
    const out = clipFile(p.lang.locale, p.voice, p.said);
    if (fs.existsSync(out)) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const raw = `${out}.raw.wav`;
    execFileSync("say", ["-v", p.voice, "-o", raw, "--data-format=LEI16@16000", p.said]);
    const { samples, sampleRate } = parseWav(fs.readFileSync(raw));
    if (sampleRate !== 16_000) throw new Error(`say gave ${sampleRate} Hz`);
    const pad = Math.round((LEAD_MS / 1000) * sampleRate);
    const padded = new Float32Array(samples.length + 2 * pad);
    padded.set(samples, pad);
    fs.writeFileSync(out, encodeWav(padded, sampleRate));
    fs.rmSync(raw);
    made++;
  }
  console.log(`say: ${made} new clips`);
}

const ledgerCount = () => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).length : 0);

/** One request at a time, a pause between, each counted in the ledger
 *  BEFORE it goes (a crash mid-call still counts). Stops at the cap. A
 *  refusal other than a rate limit stops the run. */
async function fetchAzure() {
  const keys = voiceKeys();
  if (pronunciationProvider(keys) !== "azure") throw new Error("no AZURE_SPEECH_KEY / AZURE_SPEECH_REGION");
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(DIR, { recursive: true });
  let sent = 0;
  for (const p of plan()) {
    const out = replyFile(p.lang.locale, p.voice, p.said, p.ref);
    if (fs.existsSync(out)) continue;
    const wav = fs.readFileSync(clipFile(p.lang.locale, p.voice, p.said));
    const request = azurePronunciationRequest({ key: keys.azureKey, region: keys.azureRegion, audio: wav, locale: p.lang.locale, referenceText: p.ref, scripted: true });
    for (let attempt = 1; ; attempt++) {
      if (ledgerCount() >= WORD_PROOF_MAX_CALLS) throw new Error(`the allowance of ${WORD_PROOF_MAX_CALLS} Azure calls is spent`);
      fs.appendFileSync(LEDGER, `${new Date().toISOString()}\t${p.lang.locale}\t${p.kind}\n`);
      sent++;
      const r = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(30_000) });
      if (r.status === 429 && attempt < 3) {
        await pause(20_000);
        continue;
      }
      // The status only: an error body can echo request details.
      if (!r.ok) throw new Error(`azure ${p.lang.locale} ${p.kind}: HTTP ${r.status}`);
      fs.writeFileSync(out, JSON.stringify(await r.json()));
      break;
    }
    await pause(1200);
  }
  console.log(`Azure: ${sent} requests this run, ${ledgerCount()} in all (cap ${WORD_PROOF_MAX_CALLS})`);
}

if (args.has("--say")) makeClips();
if (args.has("--azure")) {
  try {
    await fetchAzure();
  } catch (e) {
    console.error(`--azure stopped: ${e.message}. Scoring what is cached.`);
  }
}

/* --------------------------------- scoring --------------------------------- */

const norm = (s) => s.normalize("NFC").toLowerCase().replace(/[\p{P}\s]/gu, "");

/** Which reference words lie in the swapped word's place: the words of
 *  Azure's reply over the reference, located in order in the normalised
 *  reference text. */
function swappedRange(item) {
  const [from, to] = item.swap;
  const ref = swappedText(item);
  const at = ref.indexOf(to, Math.max(0, item.text.indexOf(from)));
  return { start: norm(ref.slice(0, at)).length, end: norm(ref.slice(0, at)).length + norm(to).length };
}

function locateWords(words, ref) {
  const r = norm(ref);
  let cursor = 0;
  return words.map((w) => {
    if (w.error === "Insertion") return null;
    const t = norm(w.text);
    if (!t) return null;
    const at = r.indexOf(t, cursor);
    if (at < 0) return null;
    cursor = at + t.length;
    return { start: at, end: at + t.length };
  });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const quant = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");

/** Each scored reply → its words, with the truth where there is one. */
function collect() {
  const rows = [];
  const shapes = new Map();
  let replies = 0;
  let missing = 0;
  let failed = 0;
  for (const p of plan()) {
    const file = replyFile(p.lang.locale, p.voice, p.said, p.ref);
    if (!fs.existsSync(file)) {
      missing++;
      continue;
    }
    replies++;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    noteShape(shapes, p.lang.locale, json);
    const az = azureWords(json);
    if (az.status !== "Success" || !az.words.length) {
      failed++;
      rows.push({ p, words: [], marks: null, status: az.status });
      continue;
    }
    const where = locateWords(az.words, p.ref);
    const swap = p.kind === "swap" ? swappedRange(p.item) : null;
    const marks = wordMarks(az, p.ref, { locale: p.lang.locale });
    rows.push({
      p,
      az,
      status: az.status,
      marks,
      words: az.words.map((w, i) => ({
        ...w,
        truth: w.error === "Insertion" ? "inserted" : p.kind === "accent" ? "accent" : p.kind === "right" ? "right" : where[i] ? (where[i].start < swap.end && where[i].end > swap.start ? "wrong" : "right") : "unplaced",
      })),
    });
  }
  return { rows, shapes, replies, missing, failed };
}

/** What a locale's replies look like: nested or flat scores, phonemes per
 *  word and whether they are named, syllables, an example of the words. */
function noteShape(shapes, locale, json) {
  const s = shapes.get(locale) ?? { replies: 0, nested: 0, flat: 0, words: 0, phonemes: 0, named: 0, scored: 0, syllables: 0, namedSyllables: 0, examples: [], names: new Set() };
  shapes.set(locale, s);
  s.replies++;
  const best = json?.NBest?.[0];
  if (!best) return;
  if (best.PronunciationAssessment) s.nested++;
  else if ("AccuracyScore" in best) s.flat++;
  for (const w of best.Words ?? []) {
    s.words++;
    for (const ph of w.Phonemes ?? []) {
      s.phonemes++;
      const name = String(ph.Phoneme ?? "");
      if (name) {
        s.named++;
        if (s.names.size < 12) s.names.add(name);
      }
      if (typeof (ph.PronunciationAssessment?.AccuracyScore ?? ph.AccuracyScore) === "number") s.scored++;
    }
    for (const sy of w.Syllables ?? []) {
      s.syllables++;
      if (sy.Syllable) s.namedSyllables++;
    }
  }
  if (s.examples.length < 2 && (best.Words ?? []).length > 1) s.examples.push((best.Words ?? []).map((w) => w.Word).join(" · "));
}

const { rows, shapes, replies, missing, failed } = collect();
console.log(`${replies} replies cached, ${missing} missing, ${failed} with nothing recognised; ledger ${ledgerCount()} calls`);

const words = (pred) => rows.flatMap((r) => r.words.map((w) => ({ ...w, row: r })).filter((w) => pred(w)));
const isLocale = (loc) => (w) => w.row.p.lang.locale === loc;
const BARS = [30, 40, 50, 60, 70];

function stats(list) {
  const scores = list.filter((w) => Number.isFinite(w.score)).map((w) => w.score);
  const by = (t) => list.filter((w) => w.error === t).length;
  return { n: list.length, median: median(scores), p10: quant(scores, 0.1), p90: quant(scores, 0.9), mis: by("Mispronunciation"), omit: by("Omission"), under: Object.fromEntries(BARS.map((b) => [b, list.filter((w) => Number.isFinite(w.score) && w.score < b).length])), misUnder: Object.fromEntries(BARS.map((b) => [b, list.filter((w) => w.error === "Mispronunciation" && Number.isFinite(w.score) && w.score < b).length])) };
}

if (args.has("--dump")) {
  for (const r of rows) console.log(`${r.p.lang.locale} ${r.p.kind} ${r.p.voice} [${r.p.ref}] ${r.status}: ${r.words.map((w) => `${w.text}=${w.score ?? "–"}${w.error !== "None" ? `/${w.error}` : ""}(${w.truth})`).join(" ")}${r.marks ? `  → ${r.marks.words.map((m) => `${m.text}:${m.verdict}`).join(" ")}` : ""}`);
}

/* ------------------------------ what the app shows ------------------------------ */

/** The marks the app would show (wordMarks over WORD_RULES), counted
 *  against the truth: a word unit is wrong when it overlaps the swap. */
function appCounts(filter = () => true, rules = null) {
  const t = { right: 0, rightOff: 0, rightOk: 0, own: 0, ownOff: 0, wrong: 0, wrongOff: 0, wrongOk: 0, accent: 0, accentOff: 0, accentOk: 0, alarms: [] };
  for (const r0 of rows) {
    if (!r0.marks || !filter(r0)) continue;
    const r = rules ? { ...r0, marks: wordMarks(r0.az, r0.p.ref, { locale: r0.p.lang.locale, rules }) } : r0;
    const swap = r.p.kind === "swap" ? swappedRange(r.p.item) : null;
    let at = 0;
    const ref = norm(r.p.ref);
    for (const m of r.marks.words) {
      const n = norm(m.text);
      const s = ref.indexOf(n, at);
      at = s >= 0 ? s + n.length : at;
      const truth = r.p.kind === "accent" ? "accent" : r.p.kind === "right" ? "right" : s >= 0 && s < swap.end && s + n.length > swap.start ? "wrong" : "right";
      t[truth]++;
      if (m.verdict === "off") t[`${truth}Off`]++;
      if (r.p.kind === "right") {
        t.own++;
        if (m.verdict === "off") t.ownOff++;
      }
      if (m.verdict === "ok") t[`${truth}Ok`]++;
      if (truth === "right" && m.verdict === "off") t.alarms.push(`${r.p.lang.locale} ${r.p.voice.split(" (")[0]} [${r.p.ref}] ${m.text} (${m.score ?? "–"}, ${m.azureError ?? "None"})`);
    }
  }
  return t;
}

/* --------------------------------- the report --------------------------------- */

const lines = [];
const p = (...xs) => lines.push(...xs, "");
const locales = WORD_PROOF_SET.map((l) => l.locale);
const right = (w) => w.truth === "right";
const wrong = (w) => w.truth === "wrong";

p(`Written by \`node scripts/pronunciation-proof-words.mjs\` on ${new Date().toISOString().slice(0, 10)} (bead ld-ne0.16). The replies are cached, so a rerun is free.`);
p(
  `**What was tested.** ${replies} live replies from Azure Pronunciation Assessment (the same REST short-audio request as the Mandarin proof, \`azurePronunciationRequest\`: \`Granularity: Phoneme\`, \`EnableMiscue\` on, the regional \`<region>.stt.speech.microsoft.com\` host, one request at a time), ${ledgerCount()} requests made in all (the ledger counts each before it goes; the allowance was ${WORD_PROOF_MAX_CALLS}). ${locales.length} locales: ${WORD_PROOF_SET.map((l) => `${l.name} \`${l.locale}\` (${l.items.length} phrases; ${l.native.join(", ")})`).join("; ")}. Every clip is a free macOS \`say\` voice with 200 ms of silence each side. Each phrase is used three ways:`,
);
p(
  "- **right**: a native voice reading it, assessed against its own text. Every word is right, so an \"off\" is a false alarm. The ten-phrase locales have two native voices.",
  "- **swapped**: the first voice's same clip assessed against the phrase with one word changed (\"quiero un café\" against \"quiero un té\"). The changed word is wrong (a learner who said another word, or a sound far enough off to be one); the words around it are still right, and are counted with the right words.",
  "- **accent**: an English voice (Samantha; for English, the Spanish voice Paulina) reading the phrase, from a romanisation where the script is not Latin (\"konnichiwa\"). A rough accent sample: there is no word-by-word truth, only how often words are flagged.",
);
p("Synthesized speech is not a learner: the \"wrong\" words here are whole other words, the easiest kind of wrong. A learner's wrong sound inside a right word is subtler, so expect fewer catches on real speech; and the false-alarm counts are from clean, textbook voices, so treat them as a floor.");

p("### Azure's word score and ErrorType, by locale");
p("Words as Azure segments them, against the truth. \"Mis\" is `ErrorType: Mispronunciation`, \"Omit\" is `Omission` (the reference word was not heard); the scores are each word's `AccuracyScore` (0–100; an omitted word has none).");
lines.push("| Locale | Right words | median (10th pct) | Mis / Omit on right | Swapped words | median (90th pct) | Mis / Omit on swapped | Accent words | median | Mis / Omit on accent |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const loc of locales) {
  const r = stats(words((w) => isLocale(loc)(w) && right(w)));
  const x = stats(words((w) => isLocale(loc)(w) && wrong(w)));
  const a = stats(words((w) => isLocale(loc)(w) && w.truth === "accent"));
  lines.push(`| \`${loc}\` | ${r.n} | ${r.median ?? "–"} (${r.p10 ?? "–"}) | ${r.mis} / ${r.omit} | ${x.n} | ${x.median ?? "–"} (${x.p90 ?? "–"}) | ${x.mis} / ${x.omit} | ${a.n} | ${a.median ?? "–"} | ${a.mis} / ${a.omit} |`);
}
lines.push("");

p("### Where the score separates right from wrong");
p("All locales together. Words scoring under each bar (in brackets: those Azure also marks `Mispronunciation`). An omitted word has no score and is counted under every bar.");
{
  const all = { right: words(right), wrong: words(wrong), accent: words((w) => w.truth === "accent") };
  lines.push("| Score under | Right words | Swapped words | Accent words |", "| --- | --- | --- | --- |");
  for (const b of BARS) {
    const cell = (list) => {
      const under = list.filter((w) => w.error === "Omission" || (Number.isFinite(w.score) && w.score < b)).length;
      const mis = list.filter((w) => w.error === "Mispronunciation" && Number.isFinite(w.score) && w.score < b).length;
      return `${under} (${mis}) of ${list.length}`;
    };
    lines.push(`| ${b} | ${cell(all.right)} | ${cell(all.wrong)} | ${cell(all.accent)} |`);
  }
  lines.push("");
}

p("### What the app shows (`WORD_RULES`)");
p(`The bar chosen: a word is **off** when Azure marks it \`Mispronunciation\` with a score under ${WORD_RULES.offBelow}, or \`Omission\`${WORD_RULES.omissionOff ? "" : " (not used: see below)"}; **ok** when Azure marks no error and the score is ${WORD_RULES.okFrom} or more; **unsure** otherwise. ${WORD_RULES.why}`);
{
  const t = appCounts();
  const prec = t.wrongOff + t.rightOff ? (100 * t.wrongOff) / (t.wrongOff + t.rightOff) : null;
  // At one wrong word in five: precision with the base rate reweighted.
  const fa = t.right ? t.rightOff / t.right : 0;
  const catchRate = t.wrong ? t.wrongOff / t.wrong : 0;
  const at5 = catchRate + fa ? (100 * catchRate * 0.2) / (catchRate * 0.2 + fa * 0.8) : null;
  lines.push("| | Words | off | ok | unsure |", "| --- | --- | --- | --- | --- |");
  lines.push(`| Right (own text, and the unchanged words of a swapped one) | ${t.right} | **${t.rightOff} (${pct(t.rightOff, t.right)})** false alarms | ${t.rightOk} (${pct(t.rightOk, t.right)}) | ${t.right - t.rightOff - t.rightOk} |`);
  lines.push(`| Swapped (wrong) | ${t.wrong} | **${t.wrongOff} (${pct(t.wrongOff, t.wrong)})** caught | ${t.wrongOk} (${pct(t.wrongOk, t.wrong)}) passed as ok | ${t.wrong - t.wrongOff - t.wrongOk} |`);
  lines.push(`| Accent sample | ${t.accent} | ${t.accentOff} (${pct(t.accentOff, t.accent)}) | ${t.accentOk} (${pct(t.accentOk, t.accent)}) | ${t.accent - t.accentOff - t.accentOk} |`);
  lines.push("");
  p(`Precision of an off flag as measured: ${prec === null ? "n/a" : `${prec.toFixed(1)}%`}; for a learner who gets one word in five wrong (the right and wrong rates reweighted): ${at5 === null ? "n/a" : `${at5.toFixed(1)}%`}. With ${t.rightOff} false alarms in ${t.right} right words, the 95% upper bound on the false-alarm rate is ${upper(t.rightOff, t.right)}.`);
  p(`Of the right words, ${t.own} are in correctly read phrases (${t.ownOff} flagged off) and ${t.right - t.own} are the unchanged words beside a swapped one (${t.rightOff - t.ownOff} flagged off): a wrong word can pull Azure's alignment onto its neighbours.`);
  if (t.alarms.length) p(`The false alarms: ${t.alarms.join("; ")}.`);
  p("The trade-off on the same clips (right words flagged off / wrong words caught / accent words flagged off):");
  lines.push("| `offBelow` | Omission off, guard on (chosen) | Omission off, no guard | Omission unsure, guard on |", "| --- | --- | --- | --- |");
  for (const ob of [20, 25, 30, 35, 40, 50]) {
    const cell = (extra) => {
      const c = appCounts(() => true, { ...WORD_RULES, offBelow: ob, ...extra });
      return `${c.rightOff} of ${c.right} / ${c.wrongOff} of ${c.wrong} / ${c.accentOff} of ${c.accent}`;
    };
    lines.push(`| ${ob}${ob === WORD_RULES.offBelow ? " (chosen)" : ""} | ${cell({})} | ${cell({ insertionGuard: false })} | ${cell({ omissionOff: false })} |`);
  }
  lines.push("");
  lines.push("| Locale | Right: off | Swapped: caught | Swapped: passed as ok | Accent: off |", "| --- | --- | --- | --- | --- |");
  for (const loc of locales) {
    const c = appCounts((r) => r.p.lang.locale === loc);
    lines.push(`| \`${loc}\` | ${c.rightOff} of ${c.right} | ${c.wrongOff} of ${c.wrong} | ${c.wrongOk} | ${c.accentOff} of ${c.accent} |`);
  }
  lines.push("");
}

p("### What the replies look like, per locale");
lines.push("| Locale | Replies | Scores | Phonemes per word | Phonemes named | Phonemes scored | Syllables (named) | Example word split |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const loc of locales) {
  const s = shapes.get(loc);
  if (!s) continue;
  lines.push(`| \`${loc}\` | ${s.replies} | ${s.nested ? `nested ${s.nested}` : ""}${s.nested && s.flat ? ", " : ""}${s.flat ? `flat ${s.flat}` : ""} | ${s.words ? (s.phonemes / s.words).toFixed(1) : "–"} | ${s.named} of ${s.phonemes}${s.names.size ? ` (${[...s.names].slice(0, 6).map((n) => `\`${n}\``).join(" ")})` : ""} | ${s.scored} of ${s.phonemes} | ${s.syllables} (${s.namedSyllables}) | ${s.examples[0] ?? "–"} |`);
}
lines.push("");
{
  // The one-sound swaps (perro said, pero the reference): does Azure's
  // lowest phoneme score land on the sound that differs?
  const pairs = rows.filter((r) => r.p.kind === "swap" && Number.isInteger(r.p.item.pair));
  if (pairs.length) {
    p("**The weakest sound.** Ten swaps change a single sound (perro said, *pero* the reference; schön, *schon*; three, *tree*). If Azure's per-phoneme scores can point at a sound, the lowest one in the swapped word should sit where the two words differ:");
    lines.push("| Locale | Said → reference | Word score, ErrorType | Phonemes (scores) | Lowest at | The changed sound is |", "| --- | --- | --- | --- | --- | --- |");
    let landed = 0;
    for (const r of pairs) {
      const to = r.p.item.swap[1];
      const w = r.words.find((x) => norm(x.text) === norm(to));
      const ph = (w?.phonemes ?? []).filter((x) => Number.isFinite(x.score));
      const low = ph.length ? ph.reduce((m, x, i) => (x.score < ph[m].score ? i : m), 0) : null;
      const hit = low !== null && low === r.p.item.pair;
      if (hit) landed++;
      lines.push(`| \`${r.p.lang.locale}\` | ${r.p.item.swap[0]} → ${to} | ${w ? `${w.score ?? "–"}, ${w.error}` : "not placed"} | ${ph.map((x) => `${x.name || "·"} ${Math.round(x.score)}`).join(", ") || "–"} | ${low === null ? "–" : low} | ${r.p.item.pair}${hit ? " (hit)" : ""} |`);
    }
    lines.push("");
    p(`The lowest phoneme lands on the changed sound in ${landed} of ${pairs.length}.`);
  }
}
p(WORD_RULES.soundsNote);
{
  // One-sound swaps through the app's own rules: the honest limit.
  const pairs = rows.filter((r) => r.p.kind === "swap" && Number.isInteger(r.p.item.pair) && r.marks);
  const v = pairs.map((r) => {
    const to = norm(r.p.item.swap[1]);
    const m = r.marks.words.find((x) => norm(x.text) === to);
    return `${r.p.item.swap[0]} → ${r.p.item.swap[1]} ${m?.verdict ?? "not placed"}`;
  });
  const off = v.filter((x) => x.endsWith(" off")).length;
  const ok = v.filter((x) => x.endsWith(" ok")).length;
  p(`**One wrong sound in a right word is mostly not caught.** The same ten one-sound swaps through the app's rules: ${off} off, ${ok} passed as ok, the rest unsure (${v.join("; ")}). What the check catches is a word said as another word, or said so far off that Azure can't find it; a learner's single wrong vowel will usually read "not sure". That is the safe side, and it is what the page promises: marks per word, no grade per sound.`);
}
p("### What this does not show");
p(
  "- **Synthesized speech only**, one or two macOS voices per language, in silence. No learner, no microphone, no room, no child. Every false-alarm count here is a floor.",
  "- **The bars are in-sample**: chosen on these clips and measured on them. 535 right words with 2 false alarms bound the rate under 1.2% for *these* voices, not for people.",
  "- **The accent sample has no truth.** An English voice reading Spanish (or a romanisation) is flagged on 13% of its words; some of those are surely right, and nobody listened.",
  "- **Variants ride on their language.** `es-ES`, `fr-CA`, `pt-PT`, `en-GB`, `en-AU`, `en-IN`, `ar-EG` are Azure locales the app checks, measured here only through `es-MX`, `fr-FR`, `pt-BR`, `en-US` and `ar-SA`. Locales Azure supports but nothing here measured (`zh-HK` Cantonese among them) stay `not_available`.",
  "- **Word splits are Azure's.** Japanese is split by Azure, not by spaces: こんばん | は, し | て | い | ます, and お茶 as お | 茶. A mark may sit on one kana. Korean words are the spaced eojeol (물 | 주세요).",
  "- **Placement on unusual spellings is unverified live.** Every phrase here was written as Azure echoes it. A phrase with Arabic harakat or tatweel, a German ß (against an echoed SS), or an apostrophe or hyphen Azure splits at is placed by `wordMarks`' folded matching (exact first, then without marks; whole words only) and covered by tests on hand-written replies, not on what Azure actually sends back for them.",
  "- **Short phrases only** (one to five words here; the route takes twelve, or thirty Japanese characters).",
);

function upper(k, n) {
  // Clopper-Pearson one-sided 95% upper bound, by bisection.
  if (!n) return "n/a";
  const binomCdf = (k, n, q) => {
    let sum = 0;
    let term = Math.pow(1 - q, n);
    for (let i = 0; i <= k; i++) {
      sum += term;
      term = (term * (n - i) * q) / ((i + 1) * (1 - q));
    }
    return sum;
  };
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > 0.05) lo = mid;
    else hi = mid;
  }
  return `${(100 * hi).toFixed(1)}%`;
}

/* ------------------------------ into the report ------------------------------ */

const START = "<!-- words-proof:start -->";
const END = "<!-- words-proof:end -->";
const block = `${START}\n## Words and sounds beyond Mandarin\n\n${lines.join("\n").replace(/\n+$/, "")}\n${END}`;
const doc = fs.readFileSync(REPORT, "utf8");
const next = doc.includes(START) ? doc.replace(new RegExp(`${START}[\\s\\S]*?${END}`), () => block) : `${doc.replace(/\n+$/, "")}\n\n${block}\n`;
if (!args.has("--no-write")) {
  fs.writeFileSync(REPORT, next);
  console.log(`Wrote the section into ${path.relative(REPO, REPORT)}`);
} else console.log(lines.join("\n"));
