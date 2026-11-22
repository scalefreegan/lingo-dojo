#!/usr/bin/env node
// The HSK 3.0 audit (ld-7xi; docs/VOICE.md §Uncertain readings): every
// word of the official HSK 3.0 word list (GF 0025—2021, 国际中文教育中文
// 水平等级标准, Ministry of Education of the PRC, 2021) read by the app's
// own reader (web/src/script/zh.ts) and compared with the reading the list
// prints, then with CC-CEDICT. Run by hand, offline from the app; no test
// needs it:
//
//   npm run pinyin:hsk-audit [-- --import <query-system.csv>] [--json <out>] [--show 60]
//
// The list has no stated licence, so it is a reference only: its rows live
// in a gitignored working file (data/freq/hsk/hsk-words.tsv, or
// LINGO_HSK_FILE: level, number in the level, word, pinyin as printed, one
// row a line) and nothing from it is committed but the readings we decide
// (zh-standard.ts, each with the note "HSK 3.0 level N"). The working file
// is made once by `--import` from a text copy of the list (the CSV of the
// MIT-licensed HSK-official-Query-System, which the Center for Language
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
import { cedictEntries, marked } from "./gen-zh-freq.mjs";
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

function args(argv) {
  const out = { import: null, json: null, show: 60 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--import") out.import = argv[++i];
    else if (argv[i] === "--json") out.json = argv[++i];
    else if (argv[i] === "--show") out.show = Number(argv[++i]);
  }
  return out;
}

/** The query system's CSV (No.,级别,词语,拼音,词性; alphabetical over the
 *  whole list) as the working file: rows by level in the printed order,
 *  each with its number in its level, as the PDF prints them. */
function importCsv(csv, file) {
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

  const tally = { rows: rows.length, unsplit, single: { n: 0, agree: 0, differ: [] }, multi: { n: 0, exact: 0, convention: {}, two: [], differ: [] }, tw: { n: 0, agree: 0, taiwan: [], differ: [] }, marked: [], neutral: { listNeutral: 0, readerNeutral: 0, listNeutralCedictWithList: 0, readerNeutralCedictWithList: 0 } };
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
    if (v.ok) {
      // Which way the neutral tone goes: the list's or the reader's.
      r.syl.forEach((h, k) => {
        if (syllableVerdict(app[k], h, r.chars[k]) !== "neutral") return;
        const side = h.tone === 0 ? "listNeutral" : "readerNeutral";
        tally.neutral[side]++;
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
  console.log(`  marked uncertain, zh-CN: ${tally.marked.length} (${Object.entries(byLevel).map(([k, v]) => `level ${k} ${v}`).join(", ")})`);
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
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(tally, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
