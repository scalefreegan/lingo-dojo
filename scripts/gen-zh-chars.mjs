#!/usr/bin/env node
// Builds web/src/script/zh-chars.json, the character card's meanings,
// radicals, stroke counts and simplified/traditional counterparts, from the
// Unicode Unihan database. Run by hand when the data should be refreshed;
// the output is committed, so neither the app nor its install ever reaches
// the network for it:
//
//   curl -LO https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip
//   unzip Unihan.zip -d /tmp/unihan
//   node scripts/gen-zh-chars.mjs /tmp/unihan
//
// Only the characters the card can draw (hanzi-writer-data's set), their
// counterparts and the 214 Kangxi radicals are kept, so the file stays a
// few hundred KB. Unihan is under the Unicode License v3 (permissive; the
// notice must travel with copies), so the notice goes in the file itself.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KANGXI_RADICALS } from "../web/src/script/script.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..", "web");
const src = process.argv[2];
if (!src || !fs.existsSync(path.join(src, "Unihan_Readings.txt"))) {
  console.error("usage: node scripts/gen-zh-chars.mjs <directory with the unzipped Unihan_*.txt files>");
  process.exit(1);
}

const FIELDS = new Set(["kDefinition", "kMandarin", "kRSUnicode", "kTotalStrokes", "kTraditionalVariant", "kSimplifiedVariant"]);
const data = new Map();
let version = "";
for (const file of ["Unihan_Readings.txt", "Unihan_IRGSources.txt", "Unihan_RadicalStrokeCounts.txt", "Unihan_Variants.txt"]) {
  const p = path.join(src, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!version) version = /^# Unicode Version (\S+)/.exec(line)?.[1] ?? "";
    if (!line.startsWith("U+")) continue;
    const [cp, field, value] = line.split("\t");
    if (!FIELDS.has(field)) continue;
    const ch = String.fromCodePoint(parseInt(cp.slice(2), 16));
    let row = data.get(ch);
    if (!row) data.set(ch, (row = {}));
    row[field] = value;
  }
}

const fromCps = (v) => (v ?? "").split(/\s+/).filter(Boolean).map((u) => String.fromCodePoint(parseInt(u.replace(/^U\+/, "").replace(/<.*/, ""), 16)));

const wanted = new Set(KANGXI_RADICALS);
const strokesDir = path.join(web, "node_modules", "hanzi-writer-data");
for (const f of fs.readdirSync(strokesDir)) if (f.endsWith(".json")) wanted.add(f.slice(0, -5));
for (const ch of [...wanted]) {
  const row = data.get(ch);
  for (const v of [...fromCps(row?.kTraditionalVariant), ...fromCps(row?.kSimplifiedVariant)]) wanted.add(v);
}

// One row per character: [meaning, Mandarin readings, radical-stroke,
// strokes, traditional forms, simplified forms]. Arrays, not objects:
// the keys would be most of the file.
const chars = {};
for (const ch of [...wanted].sort()) {
  const row = data.get(ch);
  if (!row) continue;
  const trad = fromCps(row.kTraditionalVariant).filter((c) => c !== ch).join("");
  const simp = fromCps(row.kSimplifiedVariant).filter((c) => c !== ch).join("");
  // kTotalStrokes gives the zh-Hans count first and the zh-Hant one second
  // where they differ: a traditional character takes the second.
  const counts = (row.kTotalStrokes ?? "").split(/\s+/).filter(Boolean).map(Number);
  const strokes = (simp ? counts[counts.length - 1] : counts[0]) ?? 0;
  chars[ch] = [row.kDefinition ?? "", row.kMandarin ?? "", (row.kRSUnicode ?? "").split(/\s+/)[0], strokes, trad, simp];
}

// The traditional → simplified table the pinyin reader spells a text with
// (script.ts simplifyForReading): every character with exactly one
// simplified form that isn't itself, one for one. One that is also its own
// simplified form (乾: 乾 or 干) is left out: context decides those.
const t2s = {};
for (const [ch, row] of data) {
  const simp = fromCps(row.kSimplifiedVariant);
  if (!simp.length || simp.includes(ch)) continue;
  const one = [...new Set(simp)];
  if (one.length === 1 && [...one[0]].length === 1 && ch.length === 1) t2s[ch] = one[0];
}

const notice = fs.readFileSync(path.join(here, "..", "web", "src", "script", "UNICODE-LICENSE.txt"), "utf8");
const source = `Unicode Unihan database ${version} (https://www.unicode.org/reports/tr38/)`;
fs.writeFileSync(path.join(web, "src", "script", "zh-chars.json"), JSON.stringify({ _source: source, _license: notice, chars }) + "\n");
fs.writeFileSync(path.join(web, "src", "script", "zh-t2s.json"), JSON.stringify({ _source: source, _license: notice, t2s }) + "\n");
console.log(`${Object.keys(chars).length} characters and ${Object.keys(t2s).length} traditional → simplified pairs from Unihan ${version}`);
