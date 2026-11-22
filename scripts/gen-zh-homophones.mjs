#!/usr/bin/env node
// Homophones for speech (ld-0mn; docs/VOICE.md §Saying the settled
// reading): writes web/src/script/zh-homophones.ts. Run by hand, offline
// from the app:
//
//   npm run pinyin:homophones [-- --report]
//
// A voice reads Chinese characters itself, so a reading a person settled
// (or a checked model answer) changes nothing it says. The server swaps
// such a word's characters for ones that can only be said that way before
// the text goes to any provider (zh-speech.ts spokenText): 还钱 settled
// hái qián is said as 孩钱. This table is each syllable's stand-in.
//
// One table per script (a zh-CN text is said with simplified stand-ins,
// a zh-TW one with traditional). A stand-in for a toned syllable (never the
// neutral tone: no character is read only neutral) is a character that
//   - is common in that script: GB 2312's level 1 (the mainland's 3,755
//     most used) for zh-CN, Big5's frequently used block (Taiwan's 5,401)
//     for zh-TW, and at least MIN_FREQ in wordfreq's list (the sum of the
//     frequencies of the words it is in), so the voice surely knows it;
//   - has exactly one ordinary reading there, that syllable with its tone:
//     the reader's own list for it (zh.ts charReadings) and every reading a
//     hint may give it (knownReadings: the frequency prior's, common and
//     rare) are that one, and the reader reads it alone so;
//   - of those, is the most frequent.
// The syllables looked for are every toned reading of every character the
// prior gives two readings or more (the ones a voice can choose wrong).
// One the table has no stand-in for (děi: 得 is the only character read
// so) is left to the voice.
//
// Checked again by scripts/tests/zh-speech.test.mjs against the reader as
// it is, so a change to the reader's tables that gives a stand-in a second
// reading fails a test rather than a child's ears.
//
// Sources: the reader's own tables (zh-freq.ts, CC-CEDICT and wordfreq,
// CC BY-SA 4.0) and wordfreq's Chinese list (downloaded once into the
// gitignored cache, as gen-zh-words.mjs does). The table is a list of
// characters, under CC BY-SA 4.0 like zh-freq.ts (ZH-FREQ-LICENSE.txt).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { WORDFREQ_SHA256, WORDFREQ_URL, checkSha256, decodeCBpack, freqDir } from "./gen-zh-freq.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "web", "src", "script", "zh-homophones.ts");

/** The characters of a legacy encoding's block, by the platform's decoder. */
function block(encoding, hiFrom, hiTo, loOk) {
  const dec = new TextDecoder(encoding);
  const out = new Set();
  for (let hi = hiFrom; hi <= hiTo; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (!loOk(hi, lo)) continue;
      const c = dec.decode(new Uint8Array([hi, lo]));
      if ([...c].length === 1 && c !== "�") out.add(c);
    }
  }
  return out;
}
/** GB 2312 level 1 (rows 16–55) and Big5's frequently used block, as in web/src/script/sounds.ts. */
export const gbLevel1 = () => block("gbk", 0xb0, 0xd7, (hi, lo) => lo >= 0xa1 && (hi !== 0xd7 || lo <= 0xf9));
export const big5Common = () => block("big5", 0xa4, 0xc6, (hi, lo) => !(lo > 0x7e && lo < 0xa1) && !(hi === 0xc6 && lo > 0x7e));

const toneless = (r) => r.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC");
const toned = (r) => r !== toneless(r) || /[̄́̌̀]/.test(r.normalize("NFD"));

/** The least frequency a stand-in has (wordfreq, summed over its words). */
export const MIN_FREQ = 1e-5;

/** The one reading `ch` may have in `locales`, or null. */
export function onlyReading(zh, ch, locales = ["zh-CN", "zh-TW"]) {
  let one = null;
  for (const loc of locales) {
    const lib = zh.charReadings(ch, loc);
    const { usual, rare } = zh.knownReadings(ch, loc);
    const all = new Set([...lib, ...usual, ...rare]);
    if (all.size !== 1) return null;
    const [r] = all;
    if (one && r !== one) return null;
    const alone = zh.readCodePoints(ch, loc, { cache: false, corrections: null })[0];
    if (alone !== r) return null;
    one = r;
  }
  return one;
}

async function charFrequencies() {
  const file = path.join(freqDir(), "wordfreq", "large_zh.msgpack.gz");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    console.error(`downloading ${WORDFREQ_URL} …`);
    const res = await fetch(WORDFREQ_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  checkSha256(file, WORDFREQ_SHA256);
  const freq = decodeCBpack(zlib.gunzipSync(fs.readFileSync(file)));
  const byChar = new Map();
  for (const [w, f] of freq) for (const ch of new Set(w)) byChar.set(ch, (byChar.get(ch) ?? 0) + f);
  return byChar;
}

async function main() {
  const zh = await import("../web/src/script/zh.ts");
  const prior = zh.currentPrior();
  const wanted = new Set();
  for (const [ch, usual] of prior.ranks) {
    const all = [...usual, ...(prior.rare.get(ch) ?? [])];
    if (new Set(all).size < 2) continue;
    for (const r of all) if (toned(r)) wanted.add(r.normalize("NFC"));
  }
  const freq = await charFrequencies();
  const tables = {};
  const counts = [];
  for (const [name, locale, chars] of [["CN", "zh-CN", gbLevel1()], ["TW", "zh-TW", big5Common()]]) {
    const best = new Map();
    for (const ch of chars) {
      const r = onlyReading(zh, ch, [locale]);
      if (!r || !wanted.has(r)) continue;
      const f = freq.get(ch) ?? 0;
      if (f < MIN_FREQ) continue;
      const have = best.get(r);
      if (!have || f > have.f) best.set(r, { ch, f });
    }
    const entries = [...best].sort(([a], [b]) => (a < b ? -1 : 1));
    const missing = [...wanted].filter((r) => !best.has(r)).sort();
    counts.push(`${name} ${entries.length} (${missing.length} without)`);
    if (process.argv.includes("--report")) {
      console.log(`${name}: ${wanted.size} syllables wanted, ${entries.length} with a stand-in, ${missing.length} without: ${missing.join(" ")}`);
      for (const [r, { ch, f }] of entries) console.log(`${name}\t${r}\t${ch}\t${f.toExponential(2)}`);
    }
    tables[name] = entries.map(([r, { ch }]) => `${r}=${ch}`).join("|");
  }
  const body = [
    "/* Homophones for speech (zh-speech.ts spokenText, ld-0mn): generated by",
    " * scripts/gen-zh-homophones.mjs, do not edit. For each toned syllable a",
    " * character of two readings may be read with, the most frequent common",
    " * character of the script (GB 2312 level 1 for zh-CN, Big5's common block",
    " * for zh-TW; at least 1e-5 in wordfreq) whose one reading there is that",
    " * syllable. Derived from the reader's tables and wordfreq's Chinese list",
    " * (Robyn Speer; CC BY-SA 4.0): see ZH-FREQ-LICENSE.txt.",
    ` * Stand-ins: ${counts.join(", ")} of ${wanted.size} syllables; one without is left to the voice. */`,
    "",
    `export const HOMOPHONES_CN =\n  ${JSON.stringify(tables.CN)};`,
    `export const HOMOPHONES_TW =\n  ${JSON.stringify(tables.TW)};`,
    "",
  ].join("\n");
  fs.writeFileSync(OUT, body);
  console.error(`wrote ${path.relative(process.cwd(), OUT)}: ${counts.join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
