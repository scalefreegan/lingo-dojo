#!/usr/bin/env node
// The pinyin sweep (ld-37t): every traditional headword of two or more Han
// characters in CC-CEDICT read by the app's own reader (web/src/script/zh.ts
// readCodePoints) for zh-TW and for zh-CN, and compared with CEDICT's
// pinyin; the simplified headwords read for zh-CN too, so a change to the
// traditional path can be shown not to move a simplified reading. Run by
// hand, offline from the app: nothing here is bundled or served.
//
//   npm run pinyin:sweep [-- --label after] [--compare data/cedict/sweep-before.json] [--top 40] [--show 40]
//
// The dictionary (CC-CEDICT, MDBG, CC BY-SA 4.0) is downloaded once into a
// gitignored cache (data/cedict/, or LINGO_CEDICT_DIR) and never committed:
// only counts and a handful of example words leave this script. Each run
// writes its readings to <cache>/sweep-<label>.json, which a later run's
// --compare diffs against (the simplified readings must not move).
//
// What counts as agreeing: the app's syllables match one of CEDICT's
// readings of the headword (its entries, and their "also pr." readings;
// for zh-TW their "Taiwan pr." ones too), syllable by syllable, where a
// syllable also matches when
//   - one side is the neutral tone and the other a tone on the same
//     syllable (頭髮 tóu fa against tou2 fa5: dictionaries differ on these);
//   - it is 一 or 不 with the same syllable in another tone (the app shows
//     each character's own tone, sandhi off: 不是 bù shì, 一個 yī gè);
//   - it is 兒 / 儿 read as erhua's r on one side and ér on the other;
//   - for zh-TW, the app gave Taiwan's reading (script.ts TAIWAN_READINGS,
//     TAIWAN_WORDS) where CEDICT has the mainland's.
// "Common" is a proxy (no frequency list with a licence that fits could be
// fetched for this): two-character words, not only a proper noun, whose
// traditional characters are all among Big5's 5,401 common ones and whose
// simplified ones among GB 2312's 3,755 level-1 ones. Disagreements are
// ranked by how many other headwords contain the word (a compound count,
// a rough stand-in for frequency).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CEDICT_URL = "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz";
export const cedictDir = () => process.env.LINGO_CEDICT_DIR || path.join(here, "..", "data", "cedict");

const HAN = /^\p{Script=Han}$/u;
const MARKS = { a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù", ü: "ǖǘǚǜ", n: "ńňǹ", m: "ḿ" };
const MARK_OF = {};
for (const [base, marks] of Object.entries(MARKS)) [...marks].forEach((m, k) => (MARK_OF[m] = [base, base === "n" ? k + 2 : base === "m" ? 2 : k + 1]));
MARK_OF["ế"] = ["ê", 2];
MARK_OF["ề"] = ["ê", 4];

/** A tone-marked syllable (the app's: nǐ, lǜ, de, r) as CEDICT spells
 *  one: lower case, ü for u:, the tone as a digit, 5 for the neutral. */
export function numbered(marked) {
  let tone = 5;
  let base = "";
  for (const ch of marked.normalize("NFC").toLowerCase()) {
    const m = MARK_OF[ch];
    if (m) {
      base += m[0];
      tone = m[1];
    } else base += ch;
  }
  // Any tone mark left (a combining one); \u00fc's diaeresis and \u00ea's circumflex stay.
  base = base.normalize("NFD").replace(/[\u0300-\u036f]/g, (c) => (c === "\u0308" || c === "\u0302" ? c : "")).normalize("NFC");
  return base + tone;
}

/** CEDICT's pinyin ("Ping2 guo3", "nu:3 er2", "xia4hai2") as numbered
 *  syllables, or null when it isn't all syllables (letters, digits). */
export function cedictSyllables(pinyin) {
  const s = pinyin.toLowerCase().replace(/u:/g, "ü").replace(/v/g, "ü");
  const out = s.match(/[a-zü]+[1-5]/g);
  if (!out || out.join("") !== s.replace(/\s+/g, "")) return null;
  return out;
}

const split = (n) => [n.slice(0, -1), Number(n.slice(-1))];

/** Whether the app's syllable `a` agrees with CEDICT's `c` for character
 *  `ch`: "exact", the name of the tolerance that lets it, or null. */
export function syllableAgrees(a, c, ch, { tw = false, taiwan = {} } = {}) {
  if (a === c) return "exact";
  const [ab, at] = split(a);
  const [cb, ct] = split(c);
  if ((ch === "兒" || ch === "儿") && ["r", "er"].includes(ab) && ["r", "er"].includes(cb)) return "erhua";
  if (ab === cb && (at === 5 || ct === 5)) return "neutral";
  if (ab === cb && (ch === "一" || ch === "不")) return "sandhi";
  // Taiwan's reading where CEDICT has the mainland's (its usual tone, or
  // another tone of the syllable: 理髮 lǐ fǎ against fa4).
  if (tw && taiwan[ch] && numbered(taiwan[ch].to) === a && (numbered(taiwan[ch].from) === c || split(numbered(taiwan[ch].from))[0] === cb)) return "taiwan";
  return null;
}

/** The app's readings for one headword (numbered, one per character)
 *  against CEDICT's candidate readings: { ok, how } where `how` names the
 *  tolerances used ("exact" when none). */
export function wordAgrees(app, candidates, chars, opts = {}) {
  let best = null;
  for (const cand of candidates) {
    if (cand.length !== app.length) continue;
    // A Taiwan word reading (垃圾 lè sè) agrees as a whole.
    if (opts.tw && opts.taiwanWords?.[chars.join("")] && opts.taiwanWords[chars.join("")].map(numbered).join(" ") === app.join(" ")) return { ok: true, how: "taiwan" };
    const how = new Set();
    let ok = true;
    for (let i = 0; i < app.length; i++) {
      const r = app[i] == null ? null : syllableAgrees(app[i], cand[i], chars[i], opts);
      if (!r) {
        ok = false;
        break;
      }
      if (r !== "exact") how.add(r);
    }
    if (ok && (!best || how.size < best.size)) best = how;
    if (best && best.size === 0) break;
  }
  return best ? { ok: true, how: best.size ? [...best].sort().join("+") : "exact" } : { ok: false, how: null };
}

/** CEDICT's lines grouped by traditional headword: { trad, simp, readings:
 *  numbered[][] (entries, then also pr.), taiwan: numbered[][] (Taiwan pr.),
 *  proper: every entry capitalised }. Only all-Han headwords of 2+
 *  characters whose pinyin is all syllables, one per character. */
export function parseCedict(text) {
  const words = new Map();
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/.exec(line);
    if (!m) continue;
    const [, trad, simp, py, defs] = m;
    const tc = [...trad];
    if (tc.length < 2 || !tc.every((c) => HAN.test(c)) || [...simp].length !== tc.length) continue;
    const main = cedictSyllables(py);
    if (!main || main.length !== tc.length) {
      skipped++;
      continue;
    }
    let w = words.get(trad);
    if (!w) words.set(trad, (w = { trad, simp, readings: [], taiwan: [], proper: true }));
    if (!/^[A-Z]/.test(py.trim())) w.proper = false;
    const add = (list, r) => r && r.length === tc.length && !list.some((x) => x.join(" ") === r.join(" ")) && list.push(r);
    add(w.readings, main);
    for (const a of defs.matchAll(/also pr\. \[([^\]]+)\]/g)) add(w.readings, cedictSyllables(a[1]));
    for (const a of defs.matchAll(/Taiwan pr\. \[([^\]]+)\]/g)) add(w.taiwan, cedictSyllables(a[1]));
  }
  return { words: [...words.values()], skipped };
}

async function loadCedict() {
  const dir = cedictDir();
  const file = path.join(dir, "cedict_1_0_ts_utf-8_mdbg.txt.gz");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    console.error(`downloading CC-CEDICT into ${dir} …`);
    const res = await fetch(CEDICT_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`CC-CEDICT download failed: ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  const date = /#! date=(\S+)/.exec(text)?.[1] ?? "?";
  return { text, date };
}

function args(argv) {
  const out = { label: "run", compare: null, top: 40, show: 40 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--label") out.label = argv[++i];
    else if (argv[i] === "--show") out.show = Number(argv[++i]);
    else if (argv[i] === "--compare") out.compare = argv[++i];
    else if (argv[i] === "--top") out.top = Number(argv[++i]);
  }
  return out;
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(2)}%` : "-");

async function main() {
  const opt = args(process.argv.slice(2));
  const { readCodePoints } = await import("../web/src/script/zh.ts");
  const { TAIWAN_READINGS, TAIWAN_WORDS } = await import("../web/src/script/script.ts");
  const { commonChars } = await import("../web/src/script/sounds.ts");
  const { text, date } = await loadCedict();
  const { words, skipped } = parseCedict(text);
  const big5 = new Set(commonChars(true));
  const gb = new Set(commonChars(false));
  if (!big5.size || !gb.size) throw new Error("this node has no Big5 / GB 2312 decoder (full ICU needed)");

  // How many headwords contain each word: the ranking stand-in.
  const contains = new Map();
  for (const w of words) {
    const c = [...w.trad];
    for (let i = 0; i < c.length; i++) for (let j = i + 2; j <= c.length; j++) {
      const s = c.slice(i, j).join("");
      if (s !== w.trad) contains.set(s, (contains.get(s) ?? 0) + 1);
    }
  }

  const tally = () => ({ n: 0, ok: 0, exact: 0, how: {}, wrong: [] });
  const runs = { tw: { all: tally(), common: tally() }, cn: { all: tally(), common: tally() }, simp: { all: tally(), common: tally() } };
  const dump = {};
  const opts = { taiwan: TAIWAN_READINGS, taiwanWords: TAIWAN_WORDS };
  /** One reading of headword `w` in run `key` (the app's, one per
   *  character, null where it gave none), checked against CEDICT. */
  const check = (w, key, read) => {
    const tw = key === "tw";
    const cands = tw ? [...w.readings, ...w.taiwan] : w.readings;
    const app = read.map((r) => (r == null ? null : numbered(r)));
    const res = app.includes(null) ? { ok: false, how: null } : wordAgrees(app, cands, key === "simp" ? [...w.simp] : [...w.trad], { ...opts, tw });
    return { ...res, cands };
  };
  const started = Date.now();
  for (const w of words) {
    const chars = [...w.trad];
    const common = chars.length === 2 && !w.proper && chars.every((c) => big5.has(c)) && [...w.simp].every((c) => gb.has(c));
    const row = {};
    for (const [key, text, locale] of [["tw", w.trad, "zh-TW"], ["cn", w.trad, "zh-CN"], ["simp", w.simp, "zh-CN"]]) {
      const read = readCodePoints(text, locale, { cache: false });
      row[key] = read.map((r) => r ?? "").join(" ");
      const res = check(w, key, read);
      const cands = res.cands;
      for (const t of common ? [runs[key].all, runs[key].common] : [runs[key].all]) {
        t.n++;
        if (res.ok) {
          t.ok++;
          if (res.how === "exact") t.exact++;
          else t.how[res.how] = (t.how[res.how] ?? 0) + 1;
        } else t.wrong.push({ word: key === "simp" ? w.simp : w.trad, app: read.map((r) => r ?? "∅").join(" "), cedict: cands.map((c) => c.join(" ")).join(" / "), rank: contains.get(w.trad) ?? 0, proper: w.proper });
      }
    }
    dump[w.trad] = row;
  }
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  // Every syllable the reader gave, in zhuyin (script.ts pinyinToZhuyin):
  // one it can't spell would show as pinyin under a zhuyin choice.
  const { pinyinToZhuyin } = await import("../web/src/script/script.ts");
  const syllables = new Set(Object.values(dump).flatMap((row) => ["tw", "cn", "simp"].flatMap((k) => row[k].split(" ").filter(Boolean))));
  const noZhuyin = [...syllables].filter((s) => pinyinToZhuyin(s) == null);
  fs.writeFileSync(path.join(cedictDir(), `syllables-${opt.label}.json`), JSON.stringify([...syllables].sort()));

  console.log(`CC-CEDICT ${date}: ${words.length} traditional headwords of 2+ Han characters (${skipped} lines skipped: pinyin not one syllable per character); read in ${secs}s`);
  console.log(`${syllables.size} distinct syllables read; without a zhuyin spelling: ${noZhuyin.length ? noZhuyin.join(" ") : "none"}`);
  const label = { tw: "traditional, zh-TW", cn: "traditional, zh-CN", simp: "simplified, zh-CN" };
  for (const key of ["tw", "cn", "simp"]) {
    for (const slice of ["all", "common"]) {
      const t = runs[key][slice];
      const how = Object.entries(t.how).map(([k, v]) => `${k} ${v}`).join(", ");
      console.log(`${label[key].padEnd(19)} ${slice.padEnd(6)} ${String(t.n).padStart(6)} words: ${String(t.n - t.ok).padStart(5)} disagree (${pct(t.n - t.ok, t.n)}); agree exactly ${t.exact}, by tolerance ${t.ok - t.exact}${how ? ` (${how})` : ""}`);
    }
  }
  for (const key of ["tw", "cn"]) {
    const top = runs[key].common.wrong.sort((a, b) => b.rank - a.rank || a.word.localeCompare(b.word)).slice(0, opt.top);
    console.log(`\nTop ${top.length} common disagreements, ${label[key]} (word: app | CEDICT | headwords containing it):`);
    for (const x of top) console.log(`  ${x.word}: ${x.app} | ${x.cedict} | ${x.rank}`);
  }

  const out = path.join(cedictDir(), `sweep-${opt.label}.json`);
  fs.writeFileSync(out, JSON.stringify({ date, counts: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { all: { n: v.all.n, wrong: v.all.n - v.all.ok }, common: { n: v.common.n, wrong: v.common.n - v.common.ok } }])), dump }));
  console.log(`\nreadings written to ${out}`);

  if (opt.compare) {
    // Every reading that moved, and whether CEDICT agreed before and after:
    // fixed, broken, or a change it disagrees with either way.
    const before = JSON.parse(fs.readFileSync(opt.compare, "utf8")).dump;
    const byTrad = new Map(words.map((w) => [w.trad, w]));
    const toRead = (s) => s.split(" ").map((r) => r || null);
    for (const key of ["tw", "cn", "simp"]) {
      const moved = { fixed: [], broken: [], other: [] };
      for (const [word, row] of Object.entries(dump)) {
        const b = before[word]?.[key];
        if (b == null || b === row[key]) continue;
        const w = byTrad.get(word);
        const was = check(w, key, toRead(b)).ok;
        const now = check(w, key, toRead(row[key])).ok;
        const line = `${key === "simp" ? w.simp : word}: ${b} → ${row[key]} | ${w.readings.map((c) => c.join(" ")).join(" / ")}`;
        moved[!was && now ? "fixed" : was && !now ? "broken" : "other"].push(line);
      }
      const n = moved.fixed.length + moved.broken.length + moved.other.length;
      console.log(`\nchanged since ${path.basename(opt.compare)}, ${label[key]}: ${n} (fixed ${moved.fixed.length}, broken ${moved.broken.length}, other ${moved.other.length})`);
      for (const kind of ["broken", "other", "fixed"]) {
        const shown = moved[kind].slice(0, opt.show);
        for (const line of shown) console.log(`  ${kind}: ${line}`);
        if (moved[kind].length > shown.length) console.log(`  … ${moved[kind].length - shown.length} more ${kind}`);
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
