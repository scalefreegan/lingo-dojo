#!/usr/bin/env node
// The HSK 3.0 audit (ld-7xi; docs/VOICE.md §Uncertain readings): every
// word of the official HSK 3.0 word list (GF 0025—2021, 国际中文教育中文
// 水平等级标准, Ministry of Education of the PRC, 2021) read by the app's
// own reader (web/src/script/zh.ts) and compared with the reading the list
// prints, then with CC-CEDICT. Run by hand, offline from the app; no test
// needs it:
//
//   npm run pinyin:hsk-audit [-- --import <query-system.csv>] [--json <out>] [--show 60] [--write-neutral] [--write-settled]
//
// `--write-neutral` (ld-azb) writes web/src/script/zh-neutral.ts: the words
// where the list prints a neutral tone, CC-CEDICT has it too, and the
// reader (without that table) shows the full tone, each with the reader's
// reading and the neutral syllable. Only those facts are kept, never the list.
//
// `--write-settled` (ld-l1d) writes web/src/script/zh-settled.ts: the
// words the reader marks uncertain alone (in either script) though it
// reads them right, settled (zh.ts applySettled): CC-CEDICT reads the word
// exactly one way (its entries, "also pr." and "Taiwan pr." readings), the
// list prints that reading in every row it has the word (each syllable as
// printed, or 一 / 不 in their changed tone), the reader without the table
// reads it so, and no other table has the word (the common words, the
// standard readings, UNSETTLED_WORDS; a neutral-tone word may be settled,
// with its neutral tone, where applyNeutral put it in). zh-TW too only
// where CC-CEDICT has no other Taiwan reading and the reader reads each
// traditional spelling so. Left marked by hand: a verb with 着 and
// PARSED_OTHERWISE (得手: 你得手洗衣服 děi). It prints every marked word it
// leaves, and why.
//
// The list has no stated licence, so it is a reference only: its rows live
// in a gitignored working file (data/freq/hsk/hsk-words.tsv, or
// LINGO_HSK_FILE: level, number in the level, word, pinyin as printed, one
// row a line) and nothing from it is committed but the readings we decide
// (zh-standard.ts, each with the note "HSK 3.0 level N"). The working file
// is made once by `--import` from a text copy of the list (the CSV of the
// MIT-licensed HSK-official-Query-System, 词汇.csv pinned by commit and
// SHA-256 in HSK_CSV_*, which the Center for Language
// Education and Cooperation's own query system serves), checked against the
// scanned PDF by hand: rows re-read from the page images at random, and
// every row this audit finds in disagreement.
//
// Each row is read alone, in simplified characters for zh-CN and in its
// CC-CEDICT traditional spelling for zh-TW, and sorted into:
//   - agree: every syllable as printed, or by a convention we keep (below);
//   - two: the list prints the word again with the reader's reading (转动);
//   - differ: anything else, with CC-CEDICT's readings beside it, for a
//     person to classify (a reader bug, fixed through zh-standard.ts; or a
//     convention);
//   - taiwan: zh-TW differs where zh-CN agrees and Taiwan's reading
//     explains it (CC-CEDICT's "Taiwan pr.", script.ts TAIWAN_READINGS, a
//     zh-standard.ts row kept out of zh-TW); never changed for zh-TW.
// The conventions (where the list prints a word otherwise than the reader
// shows it, and both are right):
//   - 一 and 不 in their changed tone (一点儿 yìdiǎnr, 不客气 búkèqi): the
//     reader shows each character's own tone (sandhi off);
//   - the neutral tone against a full tone of the same syllable, either
//     way (dictionaries differ on these; 父亲 fù·qīn prints the full tone
//     after "·" for a syllable usually read neutral);
//   - 儿 as erhua's r or as ér.
// Single characters are counted apart: alone the reader gives a
// character's most frequent reading, and the list prints one row per sense
// (还 hái and huán), so a difference there is the list's other sense.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cedictEntries, checkSha256, marked } from "./gen-zh-freq.mjs";
import { loadCedict, parseCedict } from "./pinyin-sweep.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const hskFile = () => process.env.LINGO_HSK_FILE || path.join(here, "..", "data", "freq", "hsk", "hsk-words.tsv");

const LEVELS = { 一级: "1", 二级: "2", 三级: "3", 四级: "4", 五级: "5", 六级: "6", 高等: "7-9" };
const HAN = /^\p{Script=Han}+$/u;
const TONES = { "̄": 1, "́": 2, "̌": 3, "̀": 4 };

/** A tone-marked letter's base and tone (ǎ → a, 3; ü → ü, 0). */
function letter(ch) {
  const d = ch.normalize("NFD");
  let tone = 0;
  let base = "";
  for (const c of d) {
    if (TONES[c]) tone = TONES[c];
    else base += c;
  }
  return [base.normalize("NFC"), tone];
}

/**
 * The list's pinyin for a word of `n` characters as one tone-marked
 * syllable per character, or null where it can't be split so. Separators
 * (space, "-", "’", "∥", "//", "·") are syllable boundaries; "·" marks the
 * next syllable as one usually read neutral (`light`). A syllable starting
 * with a, o or e only follows a separator (the list writes Xī’ān), and an
 * erhua r is a syllable of its own where the character is 儿. Pure.
 */
export function syllabify(pinyin, chars, inventory) {
  const s = pinyin.normalize("NFC").toLowerCase().replace(/∥|\/\//g, "|").replace(/[’‘']/g, "|").replace(/[-\s]+/g, "|");
  const letters = [];
  const cut = [];
  const lightAt = new Set();
  let pendingLight = false;
  for (const ch of s) {
    if (ch === "|" || ch === "·") {
      cut[letters.length] = true;
      if (ch === "·") pendingLight = true;
      continue;
    }
    if (pendingLight) lightAt.add(letters.length);
    pendingLight = false;
    const [base, tone] = letter(ch);
    if (!/^[a-zü]$|^ê$/.test(base)) return null;
    letters.push({ ch, base, tone });
  }
  const n = chars.length;
  const memo = new Map();
  /** Syllables for letters[i..] and chars[k..], or null. */
  const go = (i, k) => {
    if (i === letters.length) return k === n ? [] : null;
    if (k === n) return null;
    const key = `${i},${k}`;
    if (memo.has(key)) return memo.get(key);
    let out = null;
    for (let j = Math.min(letters.length, i + 6); j > i && !out; j--) {
      let ok = true;
      for (let x = i + 1; x < j; x++) if (cut[x]) ok = false;
      if (!ok) continue;
      if (j < letters.length && !cut[j] && /^[aoeê]$/.test(letters[j].base)) {
        // A vowel can't start the next syllable without a separator,
        // except the r of erhua (handled below) which is no vowel.
        ok = false;
      }
      if (!ok) continue;
      const base = letters.slice(i, j).map((l) => l.base).join("");
      const isR = base === "r" && (chars[k] === "儿" || chars[k] === "兒");
      if (!isR && !inventory.has(base)) continue;
      const rest = go(j, k + 1);
      if (rest) {
        const tone = letters.slice(i, j).reduce((t, l) => t || l.tone, 0);
        out = [{ syl: letters.slice(i, j).map((l) => l.ch).join(""), tone, light: lightAt.has(i) }, ...rest];
      }
    }
    memo.set(key, out);
    return out;
  };
  return go(0, 0);
}

/**
 * One printed row (word, pinyin) as the words it lists: [{ word, pinyin }]
 * (simplified Han characters only). Variants ("爸爸∣爸"), an optional part
 * ("差（一）点儿 chà(yì)diǎnr": both forms), an example in brackets ("初
 * （初一） chū (chūyī)": the word and the example), a sense's note ("才
 * （名）", "称1"), two readings ("谁 shéi/shuí": both) and "…" are taken
 * apart. Pure.
 */
export function rowWords(word, pinyin) {
  const ws = word.split("∣");
  const ps = pinyin.split("∣");
  if (ws.length > 1) return ws.flatMap((w, k) => rowWords(w, ps[k] ?? ps[0]));
  // The word printed once with two pinyin variants: its first.
  if (ps.length > 1) return rowWords(word, ps[0]);
  // Two readings of one word ("谁 shéi/shuí"): both.
  const alt = pinyin.split(/(?<!\/)\/(?!\/)/);
  if (alt.length > 1) return alt.flatMap((x) => rowWords(word, x.trim()));
  let w = word.replace(/[0-9０-９]/g, "").replace(/…/g, "").trim();
  let p = pinyin.replace(/…/g, " ").trim();
  const wm = /^(.*?)（(.+?)）(.*)$/.exec(w);
  const pm = /^(.*?)\s*[(（]\s*(.+?)\s*[)）](.*)$/.exec(p);
  if (wm && !pm) w = wm[1] + wm[3];
  else if (wm && pm) {
    const [, a, b, c] = wm;
    if (b.includes(a + c) || (a + c).length === 1) {
      // An example: the word, and the example word.
      return [...rowWords(a + c, `${pm[1]}${pm[3]}`), ...rowWords(b, pm[2])];
    }
    return [...rowWords(a + c, `${pm[1]} ${pm[3]}`), ...rowWords(a + b + c, `${pm[1]} ${pm[2]} ${pm[3]}`)];
  }
  w = w.replace(/\s+/g, "");
  if (!w || !HAN.test(w)) return [];
  return [{ word: w, pinyin: p }];
}

const toneOf = (r) => [...r.normalize("NFC")].reduce((t, c) => t || letter(c)[1], 0);
const baseOf = (r) => [...r.normalize("NFC")].map((c) => letter(c)[0]).join("");

/** How the reader's syllable `a` agrees with the list's `h` for character
 *  `ch`: "exact", a convention's name, or null. Pure. */
export function syllableVerdict(a, h, ch) {
  if (a == null) return null;
  const x = a.normalize("NFC");
  const y = h.syl.normalize("NFC");
  if (x === y) return "exact";
  if ((ch === "儿" || ch === "兒") && ["r", "er"].includes(baseOf(x)) && ["r", "er"].includes(baseOf(y))) return "erhua";
  if (baseOf(x) !== baseOf(y)) return null;
  if (ch === "一" || ch === "不") return "sandhi";
  if (toneOf(x) === 0 || h.tone === 0) return h.light ? "light" : "neutral";
  return null;
}

/** A whole word: { ok, how } over its syllables. */
export function wordVerdict(app, syl, chars) {
  const how = new Set();
  for (let k = 0; k < syl.length; k++) {
    const v = syllableVerdict(app[k], syl[k], chars[k]);
    if (!v) return { ok: false, how: null, at: k };
    if (v !== "exact") how.add(v);
  }
  return { ok: true, how: how.size ? [...how].sort().join("+") : "exact" };
}

/** Words where CC-CEDICT's full-tone entry is only a variant pronunciation of
 *  the same word and sense, checked by hand (ld-azb review): they take the
 *  neutral tone. The rest with a full-tone entry (东西 dōng xī east-west,
 *  买卖 mǎi mài, 大方 dà fāng, 工夫 gōng fū, 把手 bǎ shǒu to hold hands,
 *  人家 rén jiā household, 大爷 dà yé, 公道 gōng dào justice, 说道 shuō dào
 *  said, 上头 shàng tóu, 多少 duō shǎo more or less, 生意 shēng yì vitality,
 *  妻子 qī zǐ wife and children, 本事 běn shì, 出息 chū xī) are left out. */
const SAME_SENSE = new Set(["告诉", "故事", "金子", "管子", "早晨", "摆设", "挖苦", "媳妇", "世故"]);

/** web/src/script/zh-neutral.ts: the words with a neutral tone both sources
 *  print (ld-azb). Pure data, CC BY-SA 4.0 like zh-words.ts. */
function writeNeutral(words, date) {
  const out = path.join(here, "..", "web", "src", "script", "zh-neutral.ts");
  const blocked = new Set([...words.keys()].filter((w) => w.startsWith("!")).map((w) => w.slice(1)));
  const rows = [...words].filter(([w]) => !w.startsWith("!") && !blocked.has(w)).map(([w, x]) => `${w}=${x.app.join(" ")}`).sort();
  console.log(`${blocked.size} words left out: CC-CEDICT also has a full tone for another sense: ${[...blocked].join(" ")}`);
  const body = [
    "/* Neutral-tone words for zh-CN (zh.ts applyNeutral, ld-azb): generated by",
    " * scripts/pinyin-hsk-audit.mjs --write-neutral, do not edit.",
    " * The words where the official HSK 3.0 word list (GF 0025—2021, Ministry of",
    " * Education of the PRC; no stated licence, so a reference only: nothing but",
    " * a word's reading, as a fact, is kept here, and no definition, level or",
    ` * order) prints a neutral tone and CC-CEDICT (${date}; MDBG, CC BY-SA 4.0)`,
    " * has it too, where the reader shows the full tone: each word with the",
    " * reader's reading and the neutral syllable put in. Derived from CC-CEDICT:",
    " * this table is under CC BY-SA 4.0, see ZH-FREQ-LICENSE.txt. */",
    "",
    `export const NEUTRAL_WORDS = ${JSON.stringify(rows.join("|"))};`,
    "",
  ].join("\n");
  fs.writeFileSync(out, body);
  console.log(`${rows.length} neutral-tone words → ${path.relative(process.cwd(), out)}`);
}

/** Words of one CC-CEDICT reading that a sentence often parses otherwise,
 *  its character of two readings in the other one, and where the segmenter
 *  may still bound the word (checked by hand over the two-character
 *  candidates, ld-l1d): never settled, so the mark stays. */
export const PARSED_OTHERWISE = new Map([
  ["得力", "你得力挺他 (děi, must)"],
  ["得手", "你得手洗衣服 (děi, must)"],
  ["管教", "他管教数学 (jiāo, to teach)"],
  ["去处", "去处好关系 (chǔ, to get along)"],
  ["长足", "猪长足了膘 (zhǎng, to grow)"],
  ["空想", "有空想想 (kòng, free time)"],
  ["要强", "不要强人所难 (qiǎng, to force)"],
  ["倒卖", "你倒卖了不少 (dào, yet)"],
]);

/**
 * The words to settle (ld-l1d): of the list's words of two or more
 * characters that the reader (without the settled table) marks alone in
 * either script, those it reads right by both sources. `both`: settled in
 * zh-CN and zh-TW; `cn`: zh-CN only; `left`: [word, why] for every other
 * marked word. Each settled word is [word, reading, traditional spellings
 * or null]. `tables`: words another table already decides, with its name.
 */
export function settledWords({ rows, readingsOf, cedict, entries, zh, tables }) {
  const opts = { cache: false, corrections: null };
  const from = new Map();
  for (const e of entries) e.sc.forEach((ch, k) => (from.get(ch) ?? from.set(ch, new Set()).get(ch)).add(e.tc[k]));
  const many = (w) => [...w].some((ch) => (from.get(ch)?.size ?? 0) > 1);
  const both = [];
  const cn = [];
  const left = [];
  const seen = new Set();
  for (const r of rows) {
    const w = r.word;
    if (r.chars.length < 2 || seen.has(w)) continue;
    seen.add(w);
    const c = cedict.get(w);
    const trads = (c?.trads ?? []).filter((t) => [...t].length === r.chars.length);
    const markedCn = zh.uncertainWords(w, "zh-CN", opts).length > 0;
    const markedTw = trads.some((t) => zh.uncertainWords(t, "zh-TW", opts).length > 0);
    if (!markedCn && !markedTw) continue;
    const app = zh.readCodePoints(w, "zh-CN", opts);
    const why = (() => {
      if (tables.has(w)) return tables.get(w);
      if (!c?.readings.length) return "no CC-CEDICT entry";
      // A verb and 着 is made anew in any sentence, in either sense of the
      // verb: CC-CEDICT's one entry (挨着 āi zhe, next to) says nothing of
      // 挨着打 (ái, to suffer).
      if (/[着著]$/.test(w)) return "a verb with 着: its other sense is as productive (挨着打 ái)";
      if (PARSED_OTHERWISE.has(w)) return `a sentence may parse it otherwise: ${PARSED_OTHERWISE.get(w)}`;
      if (c.readings.length > 1) return `CC-CEDICT reads it ${c.readings.length} ways: ${c.readings.map((x) => x.join(" ")).join(" / ")}`;
      const one = c.readings[0];
      // Every row the list has for the word prints CC-CEDICT's reading (一 /
      // 不 in their changed tone are how it prints them, not another reading;
      // "·", a syllable often read neutral, is).
      for (const syl of readingsOf.get(w) ?? []) {
        const v = wordVerdict(one, syl, r.chars);
        if (!v.ok || !["exact", "sandhi"].includes(v.how) || syl.some((s) => s.light)) return `HSK prints ${syl.map((s) => (s.light ? "·" : "") + s.syl).join(" ")}, CC-CEDICT ${one.join(" ")}`;
      }
      if (app.join(" ") !== one.join(" ")) return `the reader reads ${app.join(" ")}, CC-CEDICT ${one.join(" ")}`;
      return null;
    })();
    if (why) {
      left.push([w, why]);
      continue;
    }
    const one = c.readings[0];
    // Taiwan: no other reading in CC-CEDICT, and the reader reads every
    // traditional spelling so.
    const twWhy = c.taiwan.some((x) => x.join(" ") !== one.join(" "))
      ? `Taiwan pr. ${c.taiwan.map((x) => x.join(" ")).join(" / ")}`
      : trads.map((t) => [t, zh.readCodePoints(t, "zh-TW", opts).join(" ")]).find(([, x]) => x !== one.join(" "))?.join(" read ") ?? null;
    const row = [w, one.join(" "), many(w) ? trads : null];
    if (!twWhy) both.push(row);
    else if (markedCn) {
      cn.push(row);
      if (markedTw) left.push([trads.join(","), `zh-TW: ${twWhy}`]);
    } else left.push([trads.join(","), `zh-TW: ${twWhy}`]);
  }
  return { both, cn, left };
}

/** web/src/script/zh-settled.ts (ld-l1d): CC BY-SA 4.0 like zh-words.ts. */
function writeSettled({ both, cn, left }, date) {
  const out = path.join(here, "..", "web", "src", "script", "zh-settled.ts");
  const line = (rows) => rows.map(([w, r, t]) => `${w}=${r}${t ? `~${t.join(",")}` : ""}`).sort().join("|");
  console.log(`\nsettled, both scripts (${both.length}): ${both.map(([w, r]) => `${w} ${r}`).join(" · ")}`);
  console.log(`settled, zh-CN only (${cn.length}): ${cn.map(([w, r]) => `${w} ${r}`).join(" · ")}`);
  console.log(`left marked (${left.length}):`);
  for (const [w, why] of left) console.log(`  ${w}: ${why}`);
  const body = [
    "/* Settled words (zh.ts applySettled, ld-l1d): generated by",
    " * scripts/pinyin-hsk-audit.mjs --write-settled, do not edit.",
    " * Words of the official HSK 3.0 word list (GF 0025—2021, Ministry of",
    " * Education of the PRC; no stated licence, so a reference only: nothing",
    " * but a word's reading, as a fact, is kept here, and no definition, level",
    " * or order) that the reader marks uncertain though it reads them right:",
    ` * CC-CEDICT (${date}; MDBG, CC BY-SA 4.0) reads each exactly one way, the`,
    " * list prints that reading, and the reader reads it so. Each word with",
    ' * that reading ("~": its traditional spellings, where a character stands',
    " * for several). SETTLED_CN: zh-CN only. Derived from CC-CEDICT: this",
    " * table is under CC BY-SA 4.0, see ZH-FREQ-LICENSE.txt. */",
    "",
    `export const SETTLED_WORDS = ${JSON.stringify(line(both))};`,
    `export const SETTLED_CN = ${JSON.stringify(line(cn))};`,
    "",
  ].join("\n");
  fs.writeFileSync(out, body);
  console.log(`${both.length + cn.length} settled words (${(body.length / 1024).toFixed(1)} KB) → ${path.relative(process.cwd(), out)}`);
}

function args(argv) {
  const out = { import: null, json: null, show: 60, writeNeutral: false, writeSettled: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--import") out.import = argv[++i];
    else if (argv[i] === "--write-settled") out.writeSettled = true;
    else if (argv[i] === "--json") out.json = argv[++i];
    else if (argv[i] === "--show") out.show = Number(argv[++i]);
    else if (argv[i] === "--write-neutral") out.writeNeutral = true;
  }
  return out;
}

/** The text copy `--import` takes: 词汇.csv of the MIT-licensed
 *  shawkynasr/HSK-official-Query-System at this commit, checked by its
 *  SHA-256 (another copy or a later edit is refused: re-check it against
 *  the PDF, then pin it here). */
export const HSK_CSV_REPO = "https://github.com/shawkynasr/HSK-official-Query-System";
export const HSK_CSV_COMMIT = "60153c5aa1476c33aee9f161792785377d3369e2";
export const HSK_CSV_URL = `https://raw.githubusercontent.com/shawkynasr/HSK-official-Query-System/${HSK_CSV_COMMIT}/%E8%AF%8D%E6%B1%87.csv`;
export const HSK_CSV_SHA256 = "f79d832ffe2a4015d5a24d6aa9c6f734e90053a02456fa0fc37eeefb65c630cc";

/** The query system's CSV (No.,级别,词语,拼音,词性; alphabetical over the
 *  whole list) as the working file: rows by level in the printed order,
 *  each with its number in its level, as the PDF prints them. */
export function importCsv(csv, file) {
  checkSha256(csv, HSK_CSV_SHA256);
  const rows = fs.readFileSync(csv, "utf8").split(/\r?\n/).filter(Boolean).slice(1).map((l) => l.split(","));
  const by = new Map();
  for (const r of rows) {
    const level = LEVELS[r[1]];
    if (!level) throw new Error(`unknown level ${r[1]}`);
    (by.get(level) ?? by.set(level, []).get(level)).push(r);
  }
  // Rows the text copy has wrong, re-read from the scan by hand (a
  // gitignored file beside the working file: level, number, word, pinyin).
  const fixes = new Map();
  const fixFile = path.join(path.dirname(file), "hsk-fixes.tsv");
  if (fs.existsSync(fixFile)) for (const l of fs.readFileSync(fixFile, "utf8").split("\n").filter((x) => x && !x.startsWith("#"))) {
    const [level, n, w, p] = l.split("\t");
    fixes.set(`${level}/${n}`, [w, p]);
  }
  const out = [];
  for (const level of Object.values(LEVELS)) {
    (by.get(level) ?? []).sort((a, b) => Number(a[0]) - Number(b[0])).forEach((r, k) => {
      const [w, p] = fixes.get(`${level}/${k + 1}`) ?? [r[2], r[3]];
      out.push([level, k + 1, w, p].join("\t"));
    });
  }
  if (fixes.size) console.log(`${fixes.size} rows corrected from ${fixFile}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${out.join("\n")}\n`);
  console.log(`${out.length} rows → ${file}`);
}

async function main() {
  const opt = args(process.argv.slice(2));
  const file = hskFile();
  if (opt.import) importCsv(opt.import, file);
  if (!fs.existsSync(file)) throw new Error(`no working file at ${file}: make it with --import (see the header)`);
  const zh = await import("../web/src/script/zh.ts");
  // The table being written is measured against, never by itself.
  if (opt.writeNeutral) zh.useNeutralWords(false);
  if (opt.writeSettled) zh.useSettledWords(false);
  const { TAIWAN_READINGS } = await import("../web/src/script/script.ts");
  const { STANDARD_READINGS } = await import("../web/src/script/zh-standard.ts");
  const { text, date } = await loadCedict();
  const entries = cedictEntries(text);
  const { words: cwords } = parseCedict(text);
  const inventory = new Set(entries.flatMap((e) => e.syl.map((s) => s.slice(0, -1))));
  // CC-CEDICT's readings (with "also pr." and "Taiwan pr.") by simplified spelling.
  const cedict = new Map();
  const add = (simp, trad, r, taiwan) => {
    const m = r.map(marked);
    if (m.some((x) => !x)) return;
    const c = cedict.get(simp) ?? cedict.set(simp, { trads: [], readings: [], taiwan: [] }).get(simp);
    if (!c.trads.includes(trad)) c.trads.push(trad);
    const list = taiwan ? c.taiwan : c.readings;
    if (!list.some((x) => x.join(" ") === m.join(" "))) list.push(m);
  };
  for (const e of entries) add(e.simp, e.trad, e.syl, false);
  for (const w of cwords) {
    for (const r of w.readings) add(w.simp, w.trad, r, false);
    for (const r of w.taiwan) add(w.simp, w.trad, r, true);
  }
  const cnOnly = new Set(STANDARD_READINGS.filter((s) => !s.tw).map((s) => s.word));

  const printed = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
  const rows = [];
  let unsplit = 0;
  for (const [level, n, word, pinyin] of printed) {
    for (const w of rowWords(word, pinyin)) {
      const chars = [...w.word];
      const syl = syllabify(w.pinyin, chars, inventory);
      if (!syl) {
        unsplit++;
        if (unsplit <= 20) console.error(`can't split: ${level}/${n} ${w.word} ${w.pinyin}`);
        continue;
      }
      rows.push({ level, n: Number(n), word: w.word, printed: w.pinyin, syl, chars });
    }
  }
  const readingsOf = new Map();
  for (const r of rows) (readingsOf.get(r.word) ?? readingsOf.set(r.word, []).get(r.word)).push(r.syl);

  /** word → the reader's reading with the neutral syllables put in. */
  const neutralWords = new Map();
  const tally = { rows: rows.length, unsplit, single: { n: 0, agree: 0, differ: [] }, multi: { n: 0, exact: 0, convention: {}, two: [], differ: [] }, tw: { n: 0, agree: 0, taiwan: [], differ: [] }, marked: [], markedTw: [], neutral: { listNeutral: 0, readerNeutral: 0, listNeutralCedictWithList: 0, readerNeutralCedictWithList: 0 } };
  for (const r of rows) {
    const app = zh.readCodePoints(r.word, "zh-CN", { cache: false, corrections: null });
    const v = wordVerdict(app, r.syl, r.chars);
    const c = cedict.get(r.word);
    const line = { level: r.level, n: r.n, word: r.word, hsk: r.syl.map((s) => (s.light ? "·" : "") + s.syl).join(" "), app: app.join(" "), cedict: c ? c.readings.map((x) => x.join(" ")).join(" / ") : "" };
    if (r.chars.length === 1) {
      tally.single.n++;
      if (v.ok) tally.single.agree++;
      else tally.single.differ.push(line);
      continue;
    }
    tally.multi.n++;
    // Marked uncertain (zh.ts uncertainWords), whatever it reads.
    if (zh.uncertainWords(r.word, "zh-CN", { cache: false, corrections: null }).length) tally.marked.push(line);
    // And in zh-TW, in any of CC-CEDICT's traditional spellings.
    if ((c?.trads ?? []).some((t) => [...t].length === r.chars.length && zh.uncertainWords(t, "zh-TW", { cache: false, corrections: null }).length)) tally.markedTw.push(line);
    if (v.ok) {
      // Which way the neutral tone goes: the list's or the reader's.
      r.syl.forEach((h, k) => {
        if (syllableVerdict(app[k], h, r.chars[k]) !== "neutral") return;
        const side = h.tone === 0 ? "listNeutral" : "readerNeutral";
        tally.neutral[side]++;
        // Only where every row the list has for the word prints it neutral
        // (地方 dìfang and dìfāng, 精神, 大意: both ways, the reader's stands).
        const everyRow = (readingsOf.get(r.word) ?? []).every((s) => s[k] && (s[k].tone === 0 || s[k].light));
        // And where CC-CEDICT has no full-tone entry of the same syllable for
        // another sense (东西 dōng xī, 买卖 mǎi mài, 把手 bǎ shǒu): such a word
        // is not neutralised blind (zh.ts CONTEXT_NEUTRAL names the contexts).
        const otherSense = !SAME_SENSE.has(r.word) && (c?.readings ?? []).some((x) => x.length === r.chars.length && x[k] && toneOf(x[k]) !== 0 && baseOf(x[k]) === baseOf(h.syl));
        if (side === "listNeutral" && otherSense) neutralWords.set(`!${r.word}`, null);
        if (side === "listNeutral" && !h.light && everyRow && !otherSense && (c?.readings ?? []).some((x) => x[k] && toneOf(x[k]) === 0)) {
          const w = neutralWords.get(r.word) ?? neutralWords.set(r.word, { app: app.slice() }).get(r.word);
          w.app[k] = h.syl.normalize("NFC");
        }
        // CC-CEDICT with the list (a neutral tone where the list has one).
        if ((c?.readings ?? []).some((x) => x[k] && toneOf(x[k]) === h.tone)) tally.neutral[`${side}CedictWithList`]++;
      });
      if (v.how === "exact") tally.multi.exact++;
      else tally.multi.convention[v.how] = (tally.multi.convention[v.how] ?? 0) + 1;
    } else {
      // Printed again with the reader's reading (转动 zhuǎn / zhuàn).
      const other = (readingsOf.get(r.word) ?? []).some((s) => s !== r.syl && wordVerdict(app, s, r.chars).ok);
      (other ? tally.multi.two : tally.multi.differ).push(line);
    }
    // zh-TW, in the traditional spelling CC-CEDICT gives the word.
    const trad = c?.trads[0];
    if (!trad || [...trad].length !== r.chars.length) continue;
    tally.tw.n++;
    const tw = zh.readCodePoints(trad, "zh-TW", { cache: false, corrections: null });
    const tv = wordVerdict(tw, r.syl, [...trad]);
    if (tv.ok) {
      tally.tw.agree++;
      continue;
    }
    if (!v.ok) continue; // counted under zh-CN
    const twLine = { ...line, word: trad, app: tw.join(" ") };
    const explained =
      cnOnly.has(r.word) ||
      (c?.taiwan ?? []).some((x) => x.join(" ") === tw.join(" ")) ||
      [...trad].every((ch, k) => wordVerdict([tw[k]], [r.syl[k]], [ch]).ok || (TAIWAN_READINGS[ch] && TAIWAN_READINGS[ch].to === tw[k]));
    (explained ? tally.tw.taiwan : tally.tw.differ).push(twLine);
  }

  const m = tally.multi;
  const agree = m.exact + Object.values(m.convention).reduce((a, b) => a + b, 0);
  const pct = (a, b) => `${((100 * a) / b).toFixed(2)}%`;
  console.log(`HSK 3.0 working file: ${printed.length} printed rows → ${rows.length} words (${unsplit} pinyin not split one syllable a character); CC-CEDICT ${date}`);
  console.log(`words of 2+ characters, zh-CN: ${m.n}: agree ${agree} (${pct(agree, m.n)}; exactly ${m.exact}, by convention ${agree - m.exact}: ${Object.entries(m.convention).map(([k, v]) => `${k} ${v}`).join(", ")}), printed both ways ${m.two.length}, differ ${m.differ.length}`);
  const byLevel = {};
  for (const x of tally.marked) byLevel[x.level] = (byLevel[x.level] ?? 0) + 1;
  console.log(`  marked uncertain, zh-CN: ${tally.marked.length} (${Object.entries(byLevel).map(([k, v]) => `level ${k} ${v}`).join(", ")}); zh-TW (CC-CEDICT's traditional spellings): ${tally.markedTw.length}`);
  const nt = tally.neutral;
  console.log(`  the neutral-tone convention, by syllable: the list neutral, the reader full ${nt.listNeutral} (CC-CEDICT neutral too ${nt.listNeutralCedictWithList}); the reader neutral, the list full ${nt.readerNeutral} (CC-CEDICT full too ${nt.readerNeutralCedictWithList})`);
  console.log(`single characters, zh-CN: ${tally.single.n}: agree ${tally.single.agree}, differ ${tally.single.differ.length} (the list's other sense, or the reader's most frequent reading)`);
  console.log(`zh-TW (CC-CEDICT's traditional spelling): ${tally.tw.n}: agree ${tally.tw.agree}, Taiwan's reading ${tally.tw.taiwan.length}, differ where zh-CN agrees ${tally.tw.differ.length}`);
  const show = (title, list) => {
    console.log(`\n${title} (${list.length}): word | HSK | reader | CC-CEDICT`);
    for (const x of list.slice(0, opt.show)) console.log(`  ${x.level}/${x.n} ${x.word} | ${x.hsk} | ${x.app} | ${x.cedict}`);
    if (list.length > opt.show) console.log(`  … ${list.length - opt.show} more`);
  };
  show("differ, zh-CN", m.differ);
  show("printed both ways, the reader has the other", m.two);
  show("zh-TW differs where zh-CN agrees", tally.tw.differ);
  show("marked uncertain, zh-CN", tally.marked);
  show("marked uncertain, zh-TW", tally.markedTw);
  if (opt.writeNeutral) writeNeutral(neutralWords, date);
  if (opt.writeSettled) {
    const { COMMON_WORDS } = await import("../web/src/script/zh-words.ts");
    const { UNSETTLED_WORDS } = await import("../web/src/script/zh-standard.ts");
    const keys = (s) => s.split("|").filter(Boolean).map((e) => e.split("=")[0]);
    // A neutral-tone word (zh-neutral.ts) is no exception: settled only
    // where applyNeutral has put CC-CEDICT's neutral tone in (不由得 bù yóu
    // de, 挑剔 tiāo ti), so the reading is the same, and never in zh-TW,
    // where the reader keeps the full tone.
    const tables = new Map([
      ...keys(COMMON_WORDS).map((w) => [w, "a common word (zh-words.ts)"]),
      ...STANDARD_READINGS.map((s) => [s.word, "a standard reading (zh-standard.ts)"]),
      ...UNSETTLED_WORDS.map((w) => [w, "read two ways, left to a person (UNSETTLED_WORDS)"]),
    ]);
    writeSettled(settledWords({ rows, readingsOf, cedict, entries, zh, tables }), date);
  }
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(tally, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
