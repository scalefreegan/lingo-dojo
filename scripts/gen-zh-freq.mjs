#!/usr/bin/env node
// Builds web/src/script/zh-freq.ts, the Mandarin reader's frequency prior
// (ld-op2): which reading of a character is the common one, and the common
// words the reader still reads wrong. Run by hand when the data should be
// refreshed; the output is committed, so neither the app nor its install
// reaches the network for it:
//
//   npm run pinyin:freq [-- --report]
//
// Sources, each downloaded once into a gitignored cache (data/cedict/ and
// data/freq/, or LINGO_CEDICT_DIR / LINGO_FREQ_DIR) and never committed:
//   - CC-CEDICT (MDBG, CC BY-SA 4.0): each word's reading.
//   - wordfreq's large Chinese list (Robyn Speer, data CC BY-SA 4.0; built
//     from SUBTLEX-CH, Wikipedia, OpenSubtitles, news, books, the web,
//     Twitter, Reddit and Jieba's list): how often each word is used.
//   - Unihan's kHanyuPinlu and kMandarin (Unicode License v3): how a
//     character's own count splits between its readings where it stands
//     as a word by itself, and the cross-check printed by --report.
// Only the derived table leaves this script: no frequency, no definition,
// and no word whose reading the reader already gets right. It is a
// derivative of CC-CEDICT and wordfreq's data, so the table is under
// CC BY-SA 4.0 (web/src/script/ZH-FREQ-LICENSE.txt).
//
// What it works out, in stages (each measured with the app's own reader,
// web/src/script/zh.ts, with the prior so far):
//   1. RANKS: for every character with more than one reading in
//      CC-CEDICT's common-noun entries, its readings by the summed
//      frequency of the words that use each (a one-character word's count
//      split by kHanyuPinlu), most frequent first; those under RARE_SHARE
//      of the first are listed as rare.
//   2. FALLBACK: for a character inside a word the library's dictionary
//      doesn't know (a one-character segment), the reading most of that
//      frequency mass takes, where it beats what the reader gives today
//      by FLIP_MARGIN.
//   3. WORDS: every headword the reader then still reads against
//      CC-CEDICT that is common (COMMON_FREQ), or that a FALLBACK entry
//      made worse (so no headword reads worse than before): applied only
//      as a whole run of Chinese characters.
//   4. ANYWHERE: the WORDS that are safe inside a sentence too (see
//      `audit`), each with its BLOCK lists: the common words that, met
//      across its edge, mean the characters are not this word (这种 before
//      植物 for 种植).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { cedictDir, cedictSyllables, loadCedict, numbered, parseCedict, syllableAgrees, wordAgrees } from "./pinyin-sweep.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const freqDir = () => process.env.LINGO_FREQ_DIR || path.join(here, "..", "data", "freq");
// Pinned: wordfreq at a commit, Unihan at a Unicode version, each checked
// by its SHA-256 (a changed file is a changed table: re-pin on purpose).
// CC-CEDICT has no versioned download (MDBG serves the current file); its
// date goes into the table's header.
export const WORDFREQ_URL = "https://github.com/rspeer/wordfreq/raw/912caf64b657478d1dff1138efdc078947d54bb1/wordfreq/data/large_zh.msgpack.gz";
export const WORDFREQ_SHA256 = "e079d7aaff1cfb92874850cb3ffbc7b611af939d9d671c1cbda932d968467cdd";
export const UNIHAN_URL = "https://www.unicode.org/Public/18.0.0/ucd/Unihan.zip";
export const UNIHAN_ZIP_SHA256 = "4c93ea9c1f636451729a840978f1667a53886af37ba854fdcce109721c63d43e";
export const UNIHAN_READINGS_SHA256 = "9d39995b5de714e8ce93716ed5d15eaa0792d68e407cdf8a0add2893b8f4150b";
/** Throws unless `file`'s SHA-256 is `want`. */
export function checkSha256(file, want) {
  const got = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (got !== want) throw new Error(`${file}: SHA-256 is ${got}, expected ${want} (delete it to download the pinned file again)`);
}

/** A reading under this share of a character's most frequent one is rare. */
export const RARE_SHARE = 0.05;
/** A fallback replaces the reader's reading only when the words it fixes
 *  carry this many times the frequency of the words it would break. */
export const FLIP_MARGIN = 2;
/** A word at least this frequent (a share of all words; 1e-6 is one in a
 *  million, wordfreq's Zipf 3) is common enough to correct. */
export const COMMON_FREQ = 1e-7;
/** A name's entry needs this many times the chance of its characters
 *  being two everyday words (美的 is Midea, and 美 + 的). */
export const NAME_MARGIN = 50;
/** The least frequency mass behind a fallback. */
export const FALLBACK_FREQ = 1e-7;
/** A fallback replaces the library's default only where one reading
 *  dominates overwhelmingly: this share of the weighted use at the
 *  positions no word settles (PR #63 review: "the common reading over an
 *  ultra-rare one", not the likelier of two ordinary ones). */
export const FALLBACK_SHARE = 0.9;
/** What a word no list has counts for. */
const FLOOR = 1e-9;

const HAN = /^\p{Script=Han}$/u;

/* ------------------------------- the sources ------------------------------ */

/** A MessagePack value at `at` of `buf`: only the types wordfreq's files
 *  use (maps, arrays, strings, small integers). */
function unpack(buf, state) {
  const b = buf[state.at++];
  const str = (n) => {
    const s = buf.toString("utf8", state.at, state.at + n);
    state.at += n;
    return s;
  };
  const arr = (n) => Array.from({ length: n }, () => unpack(buf, state));
  const map = (n) => Object.fromEntries(Array.from({ length: n }, () => [unpack(buf, state), unpack(buf, state)]));
  const uint = (n) => {
    const v = buf.readUIntBE(state.at, n);
    state.at += n;
    return v;
  };
  if (b <= 0x7f) return b;
  if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f);
  if (b >= 0x90 && b <= 0x9f) return arr(b & 0x0f);
  if (b >= 0xa0 && b <= 0xbf) return str(b & 0x1f);
  if (b === 0xd9) return str(uint(1));
  if (b === 0xda) return str(uint(2));
  if (b === 0xdb) return str(uint(4));
  if (b === 0xdc) return arr(uint(2));
  if (b === 0xdd) return arr(uint(4));
  if (b === 0xde) return map(uint(2));
  if (b === 0xcc) return uint(1);
  if (b === 0xcd) return uint(2);
  if (b === 0xc0) return null;
  throw new Error(`msgpack: unexpected byte 0x${b.toString(16)} at ${state.at - 1}`);
}

/** wordfreq's "cBpack": a header, then one list of words per centibel
 *  (list k holds the words whose frequency is 10^(-k/100)). */
export function decodeCBpack(buf) {
  const [header, ...bins] = unpack(buf, { at: 0 });
  if (header?.format !== "cB" || header.version !== 1) throw new Error("not a wordfreq cBpack file");
  const freq = new Map();
  bins.forEach((words, k) => {
    for (const w of words) freq.set(w, 10 ** (-k / 100));
  });
  return freq;
}

async function download(url, file) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  console.error(`downloading ${url} …`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function loadWordfreq() {
  const file = path.join(freqDir(), "wordfreq", "large_zh.msgpack.gz");
  await download(WORDFREQ_URL, file);
  checkSha256(file, WORDFREQ_SHA256);
  return decodeCBpack(zlib.gunzipSync(fs.readFileSync(file)));
}

/** Unihan's kHanyuPinlu ("xíng(2943) háng(218)") and kMandarin per
 *  character. The zip is unpacked by hand once (unzip Unihan.zip
 *  Unihan_Readings.txt) into <freq dir>/unihan/. */
async function loadUnihan() {
  const dir = path.join(freqDir(), "unihan");
  const file = path.join(dir, "Unihan_Readings.txt");
  if (!fs.existsSync(file)) {
    await download(UNIHAN_URL, path.join(dir, "Unihan.zip"));
    checkSha256(path.join(dir, "Unihan.zip"), UNIHAN_ZIP_SHA256);
    throw new Error(`unpack it first: unzip ${path.join(dir, "Unihan.zip")} Unihan_Readings.txt -d ${dir}`);
  }
  checkSha256(file, UNIHAN_READINGS_SHA256);
  const pinlu = new Map();
  const mandarin = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("U+")) continue;
    const [cp, field, value] = line.split("\t");
    if (field !== "kHanyuPinlu" && field !== "kMandarin") continue;
    const ch = String.fromCodePoint(parseInt(cp.slice(2), 16));
    if (field === "kMandarin") mandarin.set(ch, value.trim().split(/\s+/).map(numbered));
    else pinlu.set(ch, value.trim().split(/\s+/).map((v) => /^(.+)\((\d+)\)$/.exec(v)).filter(Boolean).map((m) => [numbered(m[1]), Number(m[2])]));
  }
  return { pinlu, mandarin };
}

/* --------------------------------- pinyin --------------------------------- */

const VOWELS = { a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù", ü: "ǖǘǚǜ", ê: ["ê̄", "ế", "ê̌", "ề"], n: ["n̄", "ń", "ň", "ǹ"], m: ["m̄", "ḿ", "m̌", "m̀"] };
/** A numbered syllable (liang4, lü4, de5, r5) with its tone mark, as the
 *  app writes one; null when it doesn't round-trip (not a syllable). */
export function marked(n) {
  const m = /^([a-zêü]+)([1-5])$/.exec(n);
  if (!m) return null;
  const [, base, t] = m;
  // CC-CEDICT's xx5 (no reading) and the like are no syllable.
  if (!/[aeiouüê]/.test(base) && !["m", "n", "ng", "hm", "hng", "r"].includes(base)) return null;
  let out = base;
  if (t !== "5") {
    // a or e takes the mark; in ou the o; else the last vowel; a nasal
    // syllable (ng, m, n) its first letter.
    let at = base.search(/[ae]/);
    if (at < 0) at = base.indexOf("ou");
    if (at < 0) for (let k = base.length - 1; k >= 0; k--) if ("iouüê".includes(base[k])) { at = k; break; }
    if (at < 0) at = base.search(/[nm]/);
    if (at < 0) return null;
    const mark = VOWELS[base[at]]?.[Number(t) - 1];
    if (!mark) return null;
    out = base.slice(0, at) + mark + base.slice(at + 1);
  }
  return numbered(out) === n ? out : null;
}

const split = (n) => [n.slice(0, -1), Number(n.slice(-1))];

/* ------------------------------- the entries ------------------------------ */

/** CC-CEDICT's entries of any length, one per line: trad, simp, numbered
 *  syllables (one per character), proper (capitalised pinyin). */
export function cedictEntries(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/.exec(line);
    if (!m) continue;
    const [, trad, simp, py, defs] = m;
    const tc = [...trad];
    const sc = [...simp];
    if (!tc.every((c) => HAN.test(c)) || sc.length !== tc.length) continue;
    const syl = cedictSyllables(py);
    if (!syl || syl.length !== tc.length) continue;
    // A variant's or an old form's entry says nothing about use.
    out.push({ trad, simp, tc, sc, syl, proper: /^[A-Z]/.test(py.trim()), variant: /^(?:old |archaic |erhua )?variant of /.test(defs), bound: /^(?:used in|see) /.test(defs) });
  }
  return out;
}

const add = (map, a, b, w) => {
  let m = map.get(a);
  if (!m) map.set(a, (m = new Map()));
  m.set(b, (m.get(b) ?? 0) + w);
};

/** Stage 1: each character's readings with the frequency mass of the
 *  words that use them: { mass, proper }. A neutral tone inside a longer
 *  word (孩子 zi, 喜歡 huan) counts for the toned reading of the same
 *  syllable; a one-character word's own neutral reading (了 le, 得 de)
 *  stays. `proper` holds the readings only names have (俞 Yú, 單 Shàn). */
export function readingMass(entries, freq, pinlu, mandarin = new Map()) {
  const mass = new Map();
  const neutral = [];
  const groups = new Map();
  const proper = new Map();
  // The readings a character has as a word by itself (not only "used in
  // 仿佛", as 佛 fú).
  // A simplified character that is a traditional one too takes only its
  // own entries (佛 is not 彿's fú).
  const free = new Set();
  const ownEntry = new Set(entries.filter((e) => e.tc.length === 1).map((e) => e.trad));
  for (const e of entries) {
    if (e.variant) continue;
    if (e.tc.length === 1 && !e.bound) for (const c of ownEntry.has(e.simp) ? [e.trad] : [e.trad, e.simp]) free.add(`${c}${e.syl[0]}`);
    if (e.proper) {
      e.tc.forEach((c, k) => {
        add(proper, c, e.syl[k], 1);
        add(proper, e.sc[k], e.syl[k], 1);
      });
      continue;
    }
    // A one-character word by its simplified character, whose count is
    // all there is (发 for 發 and 髮, 了 for 了 and 瞭): shared once.
    const key = e.tc.length === 1 ? e.simp : `${e.trad} ${e.simp}`;
    if (!groups.has(key)) groups.set(key, []);
    const g = groups.get(key);
    const same = g.find((x) => x.syl.join(" ") === e.syl.join(" "));
    if (!same) g.push({ ...e, trads: [e.tc[0]] });
    else if (!same.trads.includes(e.tc[0])) same.trads.push(e.tc[0]);
  }
  // Longer words first: a one-character word's split needs their mass.
  const compound = new Map();
  for (const g of groups.values()) {
    if (g[0].tc.length < 2) continue;
    const w = (freq.get(g[0].simp) ?? FLOOR) / g.length;
    for (const e of g) e.tc.forEach((c, k) => { for (const ch of e.sc[k] === c ? [c] : [c, e.sc[k]]) add(compound, ch, e.syl[k], w); });
  }
  for (const g of groups.values()) {
    const f = freq.get(g[0].simp) ?? FLOOR;
    const shares = tokenShares(g, pinlu, mandarin, compound, f);
    g.forEach((e, n) => {
      const w = f * shares[n];
      if (e.tc.length === 1) {
        for (const ch of new Set([e.sc[0], ...e.trads])) add(mass, ch, e.syl[0], w);
        return;
      }
      e.tc.forEach((c, k) => {
        for (const ch of e.sc[k] === c ? [c] : [c, e.sc[k]]) {
          if (split(e.syl[k])[1] === 5) neutral.push([ch, e.syl[k], w]);
          else add(mass, ch, e.syl[k], w);
        }
      });
    });
  }
  for (const [ch, r, w] of neutral) {
    const toned = [...(mass.get(ch) ?? [])].filter(([o]) => split(o)[1] !== 5 && split(o)[0] === split(r)[0]).sort((a, b) => b[1] - a[1])[0];
    add(mass, ch, toned ? toned[0] : r, w);
  }
  for (const [ch, m] of proper) for (const r of [...m.keys()]) if (mass.get(ch)?.has(r)) m.delete(r);
  return { mass, proper, compound, free };
}

/** How one word's count is shared between its readings (`g`: its entries,
 *  one per reading). A one-character word's by kHanyuPinlu where it has
 *  counts: those count the character wherever it stands, inside longer
 *  words too, so the share the longer words explain (`compound`, their
 *  mass by reading, against the word's own count `f`) is taken out first
 *  (脏 is zàng in 心脏 and most of its count, zāng as the word "dirty").
 *  Else all to kMandarin's first, else equally. */
export function tokenShares(g, pinlu, mandarin, compound = new Map(), f = 0) {
  const { tc, sc } = g[0];
  const equal = g.map(() => 1 / g.length);
  if (tc.length > 1 || g.length === 1) return equal;
  const counts = pinlu.get(sc[0]) ?? pinlu.get(tc[0]);
  if (counts) {
    const total = counts.reduce((a, [, n]) => a + n, 0);
    const inWords = compound.get(sc[0]) ?? new Map();
    const base = (r) => split(r)[0];
    // A neutral tone inside a word counts with its syllable's toned reading.
    const massOf = (r) => [...inWords].filter(([o]) => o === r || (split(o)[1] === 5 && base(o) === base(r))).reduce((a, [, w]) => a + w, 0);
    const all = [...inWords.values()].reduce((a, w) => a + w, 0) + f;
    const got = g.map((e) => {
      const share = (counts.find(([r]) => r === e.syl[0])?.[1] ?? 0) / total;
      return f > 0 ? Math.max(0, (share * all - massOf(e.syl[0])) / f) : share;
    });
    const sum = got.reduce((a, x) => a + x, 0);
    if (sum > 0) return got.map((x) => Math.max(x / sum, 1e-3));
  }
  const first = (mandarin.get(tc[0]) ?? mandarin.get(sc[0]))?.[0];
  return g.some((e) => e.syl[0] === first) ? g.map((e) => (e.syl[0] === first ? 1 : 1e-3)) : equal;
}

/** RANKS from the mass: characters with two or more readings, the most
 *  frequent first. The reading the reader gives the character alone today
 *  (`lone`, numbered) stays first unless another carries FLIP_MARGIN times
 *  its mass, is one the character has as a word by itself (`free`), and
 *  Unihan agrees it is the customary one (kMandarin's first, or without
 *  one kHanyuPinlu's most counted): the sources count differently, and a
 *  character alone is a word, which none counts by itself (長 alone is
 *  cháng, long, though zhǎng carries more words; 佛 is fó, though 仿佛 is
 *  most of its count). */
export function ranksFrom({ mass, proper, free = new Set() }, lone = new Map(), mandarin = new Map(), pinlu = new Map()) {
  const ranks = new Map();
  const rare = new Map();
  for (const [ch, m] of mass) {
    const list = [...m].sort((a, b) => b[1] - a[1]).filter(([r]) => marked(r));
    const names = [...(proper.get(ch)?.keys() ?? [])].filter((r) => marked(r) && !m.has(r));
    if (list.length < 2 && !(list.length && names.length)) continue;
    const top = list[0];
    // A reading only names have can be today's too (佛 Fó): it stays first.
    const cur = list.find(([r]) => r === lone.get(ch)) ?? (names.includes(lone.get(ch)) ? [lone.get(ch), 0] : undefined);
    const customary = (mandarin.has(ch) ? mandarin.get(ch)[0] : [...(pinlu.get(ch) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0]) === top[0];
    const first = cur && cur !== top && !(top[1] >= FLIP_MARGIN * cur[1] && customary && free.has(`${ch}${top[0]}`)) ? cur : top;
    const usual = [first, ...list.filter((x) => x !== first && x[1] >= top[1] * RARE_SHARE)];
    ranks.set(ch, usual.map(([r]) => marked(r)));
    const rest = [...list.filter((x) => !usual.includes(x)).map(([r]) => marked(r)), ...names.filter((r) => r !== first[0]).map(marked)];
    if (rest.length) rare.set(ch, rest);
  }
  return { ranks, rare };
}

const emptyPrior = () => ({ ranks: new Map(), rare: new Map(), fallback: new Map(), words: new Map(), anywhere: new Map(), block: new Map(), fixes: new Set() });
/** A seeded shuffle's coin (mulberry32): the held-out split is the same every run. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const report = process.argv.includes("--report");
  // --holdout: the tables' character stages (RANKS, FALLBACK) built from a
  // random 80% of CC-CEDICT's headwords and tried on the other 20%, which
  // they never saw; nothing is written.
  const holdout = process.argv.includes("--holdout");
  const zh = await import("../web/src/script/zh.ts");
  const { mergedWith } = await import("../web/src/script/t2s.ts");
  const { TAIWAN_READINGS, TAIWAN_WORDS, taiwanize } = await import("../web/src/script/script.ts");
  const { text, date } = await loadCedict();
  const freq = await loadWordfreq();
  const { pinlu, mandarin } = await loadUnihan();
  let entries = cedictEntries(text);
  let { words } = parseCedict(text);
  let heldOut = [];
  if (holdout) {
    const coin = seeded(20261121);
    const test = new Set(words.filter(() => coin() < 0.2).map((w) => w.trad));
    heldOut = words.filter((w) => test.has(w.trad));
    words = words.filter((w) => !test.has(w.trad));
    entries = entries.filter((e) => !test.has(e.trad));
    console.error(`held out: ${heldOut.length} headwords; the tables are built from the other ${words.length}`);
  }
  const opts = { taiwan: TAIWAN_READINGS, taiwanWords: TAIWAN_WORDS };
  const f = (simp) => freq.get(simp) ?? FLOOR;

  // The three readings the sweep takes of each headword, and whether
  // CC-CEDICT agrees with each.
  const RUNS = [["tw", "trad", "zh-TW"], ["cn", "trad", "zh-CN"], ["simp", "simp", "zh-CN"]];
  const agrees = (w, key, readings) => {
    const app = readings.map((r) => (r == null ? null : numbered(r)));
    if (app.includes(null)) return false;
    return wordAgrees(app, key === "tw" ? [...w.readings, ...w.taiwan] : w.readings, [...(key === "simp" ? w.simp : w.trad)], { ...opts, tw: key === "tw" }).ok;
  };
  const sweep = (list = words) => {
    const ok = new Map();
    for (const w of list) ok.set(w.trad, RUNS.map(([key, form, locale]) => agrees(w, key, zh.readCodePoints(w[form], locale, { cache: false }))));
    return ok;
  };
  const count = (ok) => RUNS.map((_, k) => [...ok.values()].filter((v) => !v[k]).length);

  // Before: the reader with no prior at all.
  zh.setPrior(null);
  const before = sweep();
  const heldBefore = holdout ? sweep(heldOut) : null;
  // What the library's own dictionary settles in each headword, and how
  // (no prior touches these): an entry that would change one is a
  // correction of the library, marked "!" in the tables.
  const plain = new Map();
  for (const w of words) for (const form of new Set([w.trad, w.simp])) plain.set(form, zh.readDetail(form, "zh-CN", { cache: false }));
  const isFix = (key, r) => {
    const d = plain.get(key);
    return !!d && d.dict.some((x, k) => x && d.readings[k] !== r[k]);
  };
  console.error(`no prior: disagree ${count(before).join(" / ")} (zh-TW / traditional zh-CN / simplified)`);

  // 1. RANKS.
  const masses = readingMass(entries, freq, pinlu, mandarin);
  const lone = new Map();
  for (const ch of masses.mass.keys()) {
    // What the character card leads with today (its list has had more
    // care than the library's reading of one character: 佛 fó, not fú).
    const r = zh.charReadings(ch, "zh-CN")[0] ?? zh.readCodePoints(ch, "zh-CN", { cache: false })[0];
    if (r) lone.set(ch, numbered(r));
  }
  const { ranks, rare } = ranksFrom(masses, lone, mandarin, pinlu);
  // One lead per character whatever the script: a traditional character
  // that is simply its simplified form's spelling (蘋 → 苹, no other
  // character merged into 苹) has no entry of its own and takes that
  // form's; one that shares the form with others (為 and 爲 → 为, 髮 and 發
  // → 发) keeps its own readings but leads with the simplified form's
  // first where it has that reading (為 wèi like 为; 髮 has no fā and
  // stays fà). 著 and 乾 stand for a form chosen by the word (t2s.ts):
  // alone they keep the reader's own (著 zhe, the particle it is written
  // for in a traditional text, which is Taiwan's use of it; 乾 gān).
  for (const c of [...ranks.keys()]) {
    const s = zh.simplified(c);
    if (s === c) continue;
    if ("著乾".includes(c) || !mergedWith(c, s).length) {
      ranks.delete(c);
      rare.delete(c);
      continue;
    }
    const lead = ranks.get(s)?.[0];
    const own = ranks.get(c);
    if (lead && own.includes(lead)) ranks.set(c, [lead, ...own.filter((r) => r !== lead)]);
  }
  const prior = { ...emptyPrior(), ranks, rare };
  zh.setPrior(prior);

  // 2. FALLBACK: at every position no word settles, what CC-CEDICT reads
  // against what the reader gives, by frequency.
  const want = new Map(); // ch → reading → mass
  const kept = new Map(); // ch → mass the reader's reading agrees with
  const given = new Map(); // ch → reading → mass (what the reader gives)
  // A character that is a word by itself is most of what no word settles
  // in a sentence (三只狗, 很重): its own count, by reading, joins in.
  const tokens = new Map();
  for (const e of entries) {
    if (e.tc.length !== 1 || e.variant) continue;
    for (const c of e.tc[0] === e.sc[0] ? e.tc : [e.tc[0], e.sc[0]]) (tokens.get(c) ?? tokens.set(c, []).get(c)).push(e);
  }
  for (const [c, list] of tokens) {
    const g = list.filter((e, k) => list.findIndex((x) => x.syl[0] === e.syl[0]) === k);
    const shares = tokenShares(g, pinlu, mandarin, masses.compound, f(g[0].simp));
    const cur = lone.get(c);
    g.forEach((e, n) => {
      const w = f(e.simp) * shares[n];
      add(want, c, e.syl[0], w);
      if (cur) add(given, c, cur, w);
      if (cur && syllableAgrees(cur, e.syl[0], c, opts)) kept.set(c, (kept.get(c) ?? 0) + w);
    });
  }
  for (const w of words) {
    // Both scripts as a mainland text: the fallback is the mainland's
    // reading, and a zh-TW text takes Taiwan's over it afterwards.
    for (const form of ["trad", "simp"]) {
      if (form === "trad" && w.trad === w.simp) continue;
      const chars = [...w[form]];
      const { readings, settled } = zh.readDetail(w[form], "zh-CN", { cache: false });
      const cand = w.readings[0];
      chars.forEach((c, k) => {
        if (settled[k] || readings[k] == null) return;
        const a = numbered(readings[k]);
        add(want, c, cand[k], f(w.simp));
        add(given, c, a, f(w.simp));
        if (syllableAgrees(a, cand[k], c, opts)) kept.set(c, (kept.get(c) ?? 0) + f(w.simp));
      });
    }
  }
  const flips = [];
  const short = []; // enough behind them by the old rule, not by the share
  // The readings a character has as a word by itself (any entry of its
  // own that is not a name): a free word combines with others in words no
  // dictionary lists (逮住, 拧紧, 剥皮, 很倔), so the library's default is
  // never replaced when it is one of these.
  const single = new Set();
  for (const e of entries) if (e.tc.length === 1 && !e.proper && !e.variant) for (const c of new Set([e.trad, e.simp])) single.add(`${c}${e.syl[0]}`);
  const { commonChars } = await import("../web/src/script/sounds.ts");
  const everyday = new Set([...commonChars(true), ...commonChars(false)]);
  for (const [c, m] of want) {
    // Only the characters of the two standards' common sets (Big5's 5,401,
    // GB 2312's 3,755): a rare one's mass is one or two words.
    if (!everyday.has(c)) continue;
    const [r, w] = [...m].sort((a, b) => b[1] - a[1])[0];
    const cur = [...(given.get(c) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
    const have = kept.get(c) ?? 0;
    // Not a change of tone only between a neutral and a toned syllable, not
    // 一 / 不 (their own tone is the app's convention), and enough behind it.
    if (!cur || !marked(r) || split(r)[0] === split(cur)[0] && (split(r)[1] === 5 || split(cur)[1] === 5)) continue;
    // 地 得 兒 著 了 are read by rules of their own (script.ts particleDe, t2s.ts).
    if ("一不地得兒儿著着了瞭".includes(c) || syllableAgrees(cur, r, c, opts)) continue;
    if (!(w >= FLIP_MARGIN * have && w >= FALLBACK_FREQ && !(TAIWAN_READINGS[c] && numbered(TAIWAN_READINGS[c].to) === cur))) continue;
    const total = [...m.values()].reduce((a, x) => a + x, 0);
    const share = w / total;
    if (share >= FALLBACK_SHARE && !single.has(`${c}${cur}`)) flips.push([c, marked(r), cur, w, have]);
    else short.push([c, marked(r), marked(cur) ?? cur, Number(share.toFixed(3)), single.has(`${c}${cur}`) ? "the default is a word by itself" : "share"]);
  }
  console.error(`fallbacks: ${flips.length} characters qualify (one reading has ${FALLBACK_SHARE * 100}% of the use and the default is no word by itself); ${short.length} that the old rule took do not: ${short.sort((a, b) => a[3] - b[3]).map((x) => `${x[0]} ${x[1]}/${x[2]} ${x[3]}`).join(", ")}`);
  for (const [c, r] of flips) prior.fallback.set(c, r);
  zh.setPrior(prior);
  let afterFlips = sweep();
  console.error(`ranks + ${flips.length} fallbacks: disagree ${count(afterFlips).join(" / ")}`);
  if (holdout) {
    // The fallback alone, then with the ranks (a headword of one
    // character), on headwords the tables never saw.
    const tally = (now) => RUNS.map((_, k) => {
      let fixed = 0;
      let broken = 0;
      const which = [];
      for (const w of heldOut) {
        const [a, b] = [heldBefore.get(w.trad)[k], now.get(w.trad)[k]];
        if (!a && b) fixed++;
        if (a && !b) {
          broken++;
          which.push(k === 2 ? w.simp : w.trad);
        }
      }
      return { fixed, broken, which };
    });
    zh.setPrior({ ...emptyPrior(), fallback: prior.fallback });
    const fb = tally(sweep(heldOut));
    zh.setPrior(prior);
    const both = tally(sweep(heldOut));
    const line = (t) => t.map((x, k) => `${RUNS[k][2]}${k === 1 ? " traditional" : k === 2 ? " simplified" : ""}: ${x.fixed} fixed, ${x.broken} worse${x.broken ? ` (${x.which.slice(0, 12).join(" ")})` : ""}`).join("; ");
    console.error(`held out, wrong with no prior: ${count(heldBefore).join(" / ")} of ${heldOut.length}`);
    console.error(`held out, the fallback alone: ${line(fb)}`);
    console.error(`held out, ranks and fallback: ${line(both)}`);
    return;
  }

  // 3. WORDS: what is still wrong and common, or made worse.
  const target = (w, form) => {
    // CC-CEDICT's first reading, except where the reader's own already
    // agrees by a tolerance (a neutral tone, 一 / 不, erhua): the app's
    // conventions stay.
    // Read as a mainland text in either script: the table holds the
    // mainland's reading, and a zh-TW text takes Taiwan's over it after.
    const chars = [...w[form]];
    const cur = zh.readCodePoints(w[form], "zh-CN", { cache: false });
    const out = w.readings[0].map((c, k) => {
      const a = cur[k] == null ? null : numbered(cur[k]);
      if (a && syllableAgrees(a, c, chars[k], opts)) return cur[k];
      if ("一不".includes(chars[k])) return chars[k] === "一" ? "yī" : "bù";
      return marked(c);
    });
    if (out.includes(null) || out.join(" ") === cur.join(" ")) return null;
    // A two-character word that ends in a particle is, far more often than
    // the headword, a word and the particle (穿着 is 穿 + 着 zhe before it is
    // 穿着 chuān zhuó, attire; 端的 is 端 + 的): the list that counts words
    // can't tell them apart, so the particle's reading stays.
    if (chars.length === 2 && "的地得着著了".includes(chars[1]) && out[1] !== cur[1]) return null;
    // A numeral and one more character is as often the numeral and a
    // measure word or noun (一行字 yī háng, a line, beside 一行 yī xíng, a
    // party; 第五行 beside 五行): the reader's own stays.
    if (chars.length === 2 && "一二两兩三四五六七八九十几幾半每".includes(chars[0])) return null;
    return out;
  };
  const index = buildIndex(entries, freq, masses.mass);
  // A spelling several headwords share (斗牛 is 鬥牛 dòu niú, bullfight,
  // and the stars 斗牛 Dǒu Niú; 尽快 is 儘快 jǐn and 盡快 jìn) takes a
  // correction only if it leaves none of them worse than before.
  const sharing = new Map();
  for (const w of words) for (const form of new Set([w.trad, w.simp])) (sharing.get(form) ?? sharing.set(form, []).get(form)).push(w);
  // (A traditional text is looked up by its simplified spelling too, so a
  // simplified entry answers for every headword simplified to it.)
  const harmless = (key, reading) =>
    sharing.get(key).every((w) => RUNS.every(([run, form], k) => (w[form] !== key && w.simp !== key) || !before.get(w.trad)[k] || agrees(w, run, run === "tw" ? taiwanize(w.trad, reading.slice()) : reading)));
  let wordList;
  let afterWords;
  for (;;) {
    wordList = new Map(); // key → { r, f }
    for (const w of words) {
      const now = afterFlips.get(w.trad);
      const was = before.get(w.trad);
      const worse = now.some((ok, k) => !ok && was[k]);
      if (now.every(Boolean) || !(worse || f(w.simp) >= COMMON_FREQ)) continue;
      for (const form of ["trad", "simp"]) {
        if (form === "trad" ? now[0] && now[1] : now[2]) continue;
        const t = target(w, form);
        if (!t || wordList.has(w[form]) || !harmless(w[form], t)) continue;
        if (w.proper && f(w.simp) < NAME_MARGIN * phraseChance(w[form], t, index)) continue;
        wordList.set(w[form], { r: t.join(" "), f: f(w.simp) });
      }
    }
    prior.words = new Map([...wordList].map(([k, v]) => [k, v.r.split(" ")]));
    prior.fixes = new Set([...wordList].filter(([k, v]) => isFix(k, v.r.split(" "))).map(([k]) => k));
    zh.setPrior(prior);
    afterWords = sweep();
    // A headword a fallback made worse that no entry could put right:
    // that fallback goes.
    const bad = words.filter((w) => afterWords.get(w.trad).some((ok, k) => !ok && before.get(w.trad)[k]));
    const drop = flips.filter(([c]) => bad.some((w) => w.trad.includes(c) || w.simp.includes(c)));
    if (!drop.length) {
      if (bad.length) console.error(`worse than with no prior: ${bad.map((w) => w.trad).join(" ")}`);
      break;
    }
    for (const d of drop) {
      flips.splice(flips.indexOf(d), 1);
      prior.fallback.delete(d[0]);
    }
    prior.words = new Map();
    zh.setPrior(prior);
    afterFlips = sweep();
  }
  let after = afterWords;
  console.error(`${flips.length} fallbacks + ${prior.words.size} whole-run words: disagree ${count(after).join(" / ")}`);

  // 4. ANYWHERE: simplified spellings only (the reader matches them on
  // the simplified text), and only where the traditional spelling takes
  // the same reading.
  const simpForms = new Map(words.map((w) => [w.simp, w]));
  const accepted = [];
  const rejected = [];
  for (const [word, v] of [...wordList].sort((a, b) => b[1].f - a[1].f)) {
    const w = simpForms.get(word);
    if (!w) continue;
    const trad = wordList.get(w.trad);
    if (w.trad !== w.simp && trad && trad.r !== v.r) continue;
    const verdict = audit(word, v.r.split(" "), v.f, index);
    (verdict.ok ? accepted : rejected).push({ word, r: v.r, f: v.f, why: verdict.why, block: verdict.block });
  }
  const blockOf = () => {
    const block = new Map();
    for (const a of accepted) for (const [k, list] of a.block) block.set(k, new Set([...(block.get(k) ?? []), ...list]));
    return block;
  };
  // Then the reader itself, with all of them given to the library at
  // once: no headword may read worse than without, each must read as
  // corrected beside every common word (FRAMES), and where its characters
  // meet across two words (the most frequent words ending with its first
  // part, then those starting with its second) the reading must be the
  // one without the entry, or one CC-CEDICT has for that word.
  const contexts = [];
  for (const a of accepted) {
    const chars = [...a.word];
    for (let cut = 1; cut < chars.length; cut++) {
      const top = (list) => (list ?? []).filter((x) => x.simp && x.word !== a.word).slice(0, NEIGHBOURS);
      for (const y of top(index.byEnd.get(chars.slice(0, cut).join("")))) for (const x of top(index.byStart.get(chars.slice(cut).join("")))) contexts.push({ a, text: y.word + x.word, at: y.chars.length - cut, n: chars.length, y, x, cut });
    }
  }
  zh.setPrior(prior);
  for (const c of contexts) c.base = zh.readCodePoints(c.text, "zh-CN", { cache: false });
  for (;;) {
    prior.anywhere = new Map(accepted.map((a) => [a.word, a.r.split(" ")]));
    prior.block = blockOf();
    zh.setPrior(prior);
    after = sweep();
    const drop = new Map();
    for (const w of words) {
      if (!after.get(w.trad).some((ok, k) => !ok && before.get(w.trad)[k])) continue;
      for (const a of accepted) if (w.simp.includes(a.word)) drop.set(a.word, `${w.simp} reads worse`);
    }
    for (const a of accepted) {
      const n = [...a.word].length;
      let applied = 0;
      let miss = "";
      for (const fr of FRAMES) {
        for (const [text, at] of [[`${fr}${a.word}`, 1], [`${a.word}${fr}`, 0]]) {
          const got = zh.readCodePoints(text, "zh-CN", { cache: false }).slice(at, at + n).join(" ");
          if (got === a.r) applied++;
          else miss = `${text} reads ${got}`;
        }
      }
      if (applied < FRAMES_SHARE * 2 * FRAMES.length) drop.set(a.word, `applies beside ${applied} of ${2 * FRAMES.length} common words (${miss})`);
    }
    // Each pair of neighbours the reader then misreads counts as the two
    // words meeting by chance (their frequencies multiplied: 身心 + 脏辫 is
    // next to never, 这种 + 植物 is not), and the entry goes when those
    // together pass the same margin as the audit's.
    const misfires = new Map();
    for (const c of contexts) {
      if (!prior.anywhere.has(c.a.word)) continue;
      const got = zh.readCodePoints(c.text, "zh-CN", { cache: false });
      for (let k = 0; k < c.n; k++) {
        const i = c.at + k;
        if (got[i] === c.base[i]) continue;
        const owner = k < c.cut ? c.y : c.x;
        const idx = k < c.cut ? i : k - c.cut;
        const ok = owner.readings.some((syl) => got[i] != null && syllableAgrees(numbered(got[i]), syl[idx], owner.chars[idx], opts));
        if (ok) continue;
        const m = misfires.get(c.a.word) ?? { chance: 0, worst: 0, text: "" };
        const chance = c.y.f * c.x.f;
        m.chance += chance;
        if (chance > m.worst) Object.assign(m, { worst: chance, text: `${c.text} reads ${got.join(" ")}` });
        misfires.set(c.a.word, m);
        break;
      }
    }
    for (const a of accepted) {
      const m = misfires.get(a.word);
      if (m && m.chance * MISFIRE_MARGIN > a.f) drop.set(a.word, `misread beside its neighbours for ${(m.chance / a.f).toFixed(3)} of its use, most in ${m.text}`);
    }
    if (!drop.size) break;
    for (let k = accepted.length - 1; k >= 0; k--) {
      if (!drop.has(accepted[k].word)) continue;
      const [gone] = accepted.splice(k, 1);
      rejected.push({ ...gone, why: drop.get(gone.word) });
    }
  }
  console.error(`+ ${accepted.length} anywhere words (${rejected.length} rejected): disagree ${count(after).join(" / ")}`);

  const enc = {
    RANKS: [...ranks].map(([c, list]) => `${c}${list.join(",")}${rare.has(c) ? `;${rare.get(c).join(",")}` : ""}`).join("|"),
    FALLBACK: flips.map(([c, r]) => `${c}${r}`).join("|"),
    WORDS: [...wordList].filter(([k]) => !prior.anywhere.has(k)).map(([k, v]) => `${k}=${prior.fixes.has(k) ? "!" : ""}${v.r}`).join("|"),
    ANYWHERE: accepted.map((a) => `${a.word}=${prior.fixes.has(a.word) ? "!" : ""}${a.r}`).join("|"),
    BLOCK: [...prior.block].map(([k, set]) => `${k}:${[...set].join(",")}`).join("|"),
  };
  const out = path.join(here, "..", "web", "src", "script", "zh-freq.ts");
  const head = `/* The Mandarin reader's frequency prior (zh.ts): generated by
 * scripts/gen-zh-freq.mjs, do not edit. Derived from CC-CEDICT
 * (${date.slice(0, 10)}; MDBG, CC BY-SA 4.0) and wordfreq's Chinese word list
 * (Robyn Speer; data CC BY-SA 4.0), with Unihan's kHanyuPinlu (Unicode
 * License v3): this table is under CC BY-SA 4.0, see ZH-FREQ-LICENSE.txt.
 * RANKS: a character's readings, most frequent first, the rare ones after
 * ";". FALLBACK: the reading inside a word no dictionary settles. WORDS:
 * corrections for a whole run of characters. ANYWHERE: corrections that
 * are safe inside a sentence, except beside a BLOCK word (">长=zhǎng:长期"
 * is: a word ending 长 zhǎng is not one where 长期 starts on its 长). A
 * reading after "!" corrects pinyin-pro's own dictionary word (the only
 * entries that may replace one).
 * Loaded only with zh.ts (on demand). */
`;
  fs.writeFileSync(out, `${head}${Object.entries(enc).map(([k, v]) => `export const ${k} =\n  ${JSON.stringify(v)};\n`).join("")}`);
  const size = fs.statSync(out).size;
  console.error(`${path.relative(process.cwd(), out)}: ${size} bytes, ${zlib.gzipSync(fs.readFileSync(out), { level: 9 }).length} gzipped; ${ranks.size} characters ranked, ${flips.length} fallbacks, ${prior.words.size - accepted.length} words, ${accepted.length} anywhere, ${prior.block.size} block lists (${[...prior.block.values()].reduce((n, x) => n + x.size, 0)} words)`);

  if (report) {
    const rep = path.join(cedictDir(), "freq-report.json");
    // How RANKS' first reading compares with Unihan's.
    let both = 0;
    let same = 0;
    const differ = [];
    for (const [c, list] of ranks) {
      const km = mandarin.get(c)?.[0];
      if (!km) continue;
      both++;
      if (numbered(list[0]) === km) same++;
      else differ.push(`${c} ${list[0]} / ${marked(km) ?? km}`);
    }
    console.error(`first reading against Unihan kMandarin: ${same} of ${both} the same`);
    const changed = (k) => words.filter((w) => before.get(w.trad)[k] !== after.get(w.trad)[k]).map((w) => `${k === 2 ? w.simp : w.trad}${after.get(w.trad)[k] ? "" : " (worse)"}`);
    const fixes = [...prior.fixes].map((k) => `${k} ${plain.get(k).readings.join(" ")} → ${(prior.words.get(k) ?? prior.anywhere.get(k)).join(" ")}${prior.anywhere.has(k) ? " (anywhere)" : ""}`);
    console.error(`${fixes.length} entries correct pinyin-pro's own dictionary word: ${fixes.join("; ")}`);
    // The same words inside a sentence (TIER_FRAME), where only the
    // tables that work in running text apply: read again with no prior
    // and with this one.
    const framed = (w, key, form, locale) => {
      const [pre, post] = TIER_FRAME[form];
      return agrees(w, key, zh.readCodePoints(`${pre}${w[form]}${post}`, locale, { cache: false }).slice([...pre].length, [...pre].length + [...w[form]].length));
    };
    const top = new Set([...words].filter((w) => freq.has(w.simp)).sort((a, b) => freq.get(b.simp) - freq.get(a.simp)).slice(0, 40000));
    const sweepFramed = () => new Map([...top].map((w) => [w.trad, RUNS.map(([key, form, locale]) => framed(w, key, form, locale))]));
    const framedAfter = sweepFramed();
    zh.setPrior(null);
    const framedBefore = sweepFramed();
    zh.setPrior(prior);
    const tiers = frequencyTiers(words, freq, before, after);
    const inText = frequencyTiers([...top], freq, framedBefore, framedAfter);
    tiers.inText = inText;
    for (const t of inText.table) console.error(`in a sentence (${TIER_FRAME.simp.join("…")}): ${t}`);
    for (const t of tiers.table) console.error(t);
    fs.writeFileSync(rep, JSON.stringify({ flips, short, fixes, tiers, differ, accepted, rejected, fixed: { tw: changed(0), cn: changed(1), simp: changed(2) } }, null, 1));
    console.error(`report written to ${rep}`);
  }
}

/** The sentence a tier's words are also read in: Chinese characters on
 *  both sides, so the word is not the whole run. */
const TIER_FRAME = { simp: ["他们", "吗"], trad: ["他們", "嗎"] };

/** How often a learner meets a wrong reading: the `n` most frequent words
 *  of the frequency list that CC-CEDICT has, simplified read as zh-CN and
 *  their traditional forms as zh-TW, with the number that disagree with
 *  CC-CEDICT before (no prior: main's reader) and after, and those words'
 *  share of the tier's running text (their frequencies over the tier's). */
export function frequencyTiers(words, freq, before, after, sizes = [1000, 2000, 5000, 10000, 20000]) {
  const bySimp = new Map();
  for (const w of words) if (freq.has(w.simp)) (bySimp.get(w.simp) ?? bySimp.set(w.simp, []).get(w.simp)).push(w);
  const ranked = [...bySimp].map(([simp, list]) => ({ simp, list, f: freq.get(simp) })).sort((a, b) => b.f - a.f);
  // Simplified: right if any headword of that spelling is read right (a
  // spelling has one reading here); traditional: every form must be.
  const ok = (sweep, item, run) => (run === 2 ? item.list.some((w) => sweep.get(w.trad)[2]) : item.list.every((w) => sweep.get(w.trad)[0]));
  const table = [];
  const wrong = {};
  for (const [run, name] of [[2, "simplified zh-CN"], [0, "traditional zh-TW"]]) {
    for (const n of sizes) {
      const tier = ranked.slice(0, n);
      const mass = tier.reduce((a, x) => a + x.f, 0);
      const cell = (sweep) => {
        const bad = tier.filter((x) => !ok(sweep, x, run));
        return `${bad.length} (${((100 * bad.length) / tier.length).toFixed(2)}%, ${((100 * bad.reduce((a, x) => a + x.f, 0)) / mass).toFixed(3)}% of running text)`;
      };
      table.push(`${name}, top ${n}: before ${cell(before)}; after ${cell(after)}`);
    }
    wrong[name] = ranked.slice(0, 5000).map((x, k) => ({ ...x, rank: k + 1 })).filter((x) => !ok(after, x, run)).map((x) => `${x.rank} ${run === 2 ? x.simp : [...new Set(x.list.map((w) => w.trad))].join("/")} [${x.list.map((w) => w.readings.map((r) => r.join(" ")).join(" / ")).join(" ; ")}]`);
  }
  return { table, wrong };
}

/** What the audit needs of the dictionary: every spelling with its
 *  frequency and readings (and, for one character, how its count splits
 *  between them: `share`), by its first and by its last characters, the
 *  most frequent first. */
function buildIndex(entries, freq, mass) {
  const forms = new Map();
  for (const e of entries) {
    for (const [form, chars] of new Map([[e.trad, e.tc], [e.simp, e.sc]])) {
      let item = forms.get(form);
      if (!item) forms.set(form, (item = { word: form, chars, readings: [], f: freq.get(e.simp) ?? FLOOR, simp: false }));
      if (form === e.simp) item.simp = true;
      if (!item.readings.some((r) => r.join(" ") === e.syl.join(" "))) item.readings.push(e.syl);
    }
  }
  const byStart = new Map();
  const byEnd = new Map();
  const push = (map, k, v) => (map.get(k) ?? map.set(k, []).get(k)).push(v);
  for (const item of [...forms.values()].sort((a, b) => b.f - a.f)) {
    const m = item.chars.length === 1 ? mass.get(item.word) : null;
    const total = m ? [...m.values()].reduce((a, w) => a + w, 0) : 0;
    item.share = item.readings.map((r) => (m && total ? (m.get(r[0]) ?? 0) / total : 1 / item.readings.length));
    for (let n = 1; n <= Math.min(3, item.chars.length); n++) {
      push(byStart, item.chars.slice(0, n).join(""), item);
      push(byEnd, item.chars.slice(-n).join(""), item);
    }
  }
  return { byStart, byEnd, forms };
}

const base = (c) => split(c)[0];
/** Whether syllable `a` is another reading than `b` (a neutral tone of
 *  the same syllable is not). */
const differs = (a, b) => base(a) !== base(b) || (split(a)[1] !== split(b)[1] && split(a)[1] !== 5 && split(b)[1] !== 5);
/** The share of `item`'s use in which its characters from `at` read
 *  otherwise than `want` (numbered syllables). */
const harm = (item, at, want) => item.readings.reduce((a, r, n) => a + (want.some((w, k) => differs(r[at + k], w)) ? item.share[n] : 0), 0);

/** A neighbour this frequent is listed (BLOCK) and vetoes the entry where
 *  it stands; a rarer one is left to chance. */
const BLOCK_FREQ = 1e-6;
/** How many times more frequent the word must be than all the misfires
 *  left to chance, each estimated as its two words meeting by chance
 *  (which undercounts words that go together, hence the size of it). */
const MISFIRE_MARGIN = 10;
/** An entry must take effect beside at least this share of the FRAMES
 *  words, before it and after it. Where it doesn't, the reader's word
 *  boundary check left it out and the text reads as it did without the
 *  entry: no harm, but an entry that rarely applies earns nothing. */
const FRAMES_SHARE = 0.75;
const FRAMES = [..."我你他不很有是在和的了也都"];
/** How many of the most frequent neighbours on each side the reader is
 *  tried against. */
const NEIGHBOURS = 20;

/**
 * Whether a correction is safe inside a sentence. Its characters can
 * stand in a row across two words (和面 in 牛奶和面包, 种植 in 这种植物), so
 * for every way to cut it in two, every word ending with its first part
 * is met with every word starting with its second: the entry misfires
 * there when it gives a character another reading than that word's. Where
 * two segmentations compete the more frequent wins:
 *  - a common word of two or more characters that it would misread
 *    (BLOCK_FREQ) goes into the entry's BLOCK list, and the reader leaves
 *    the entry out wherever that word stands across its edge (这种, 长期):
 *    there the text reads as it did before;
 *  - everything else (a one-character word, which can't be told from the
 *    entry's own character, and the rare words) is left to chance, and the
 *    entry stands only if it is MISFIRE_MARGIN times more frequent than
 *    those meetings together (不当 against 不 + 当, 明了 against 说明 + 了).
 * (main then tries the reader itself on what passes.)
 */
function audit(word, reading, fw, index) {
  const chars = [...word];
  const want = reading.map(numbered);
  const block = new Map();
  let chance = 0;
  let worst = null;
  for (let cut = 1; cut < chars.length; cut++) {
    const left = chars.slice(0, cut).join("");
    const right = chars.slice(cut).join("");
    const ends = (index.byEnd.get(left) ?? []).filter((y) => y.word !== word);
    const starts = (index.byStart.get(right) ?? []).filter((x) => x.word !== word);
    const massEnds = ends.reduce((a, y) => a + y.f, 0);
    const massStarts = starts.reduce((a, x) => a + x.f, 0);
    const side = (list, other, at, wantPart, key) => {
      for (const it of list) {
        const share = harm(it, at(it), wantPart);
        if (!share) continue;
        // A block word runs across the entry's edge: one that lies wholly
        // inside the entry (分子 in 知识分子) would veto it everywhere.
        if (it.chars.length > wantPart.length && it.f >= BLOCK_FREQ && it.simp) {
          block.set(key, [...(block.get(key) ?? []), it.word]);
          continue;
        }
        const c = it.f * share * other;
        chance += c;
        if (!worst || c > worst[1]) worst = [it.word, c];
      }
    };
    side(ends, massStarts, (y) => y.chars.length - cut, want.slice(0, cut), `<${left}=${reading.slice(0, cut).join(" ")}`);
    side(starts, massEnds, () => 0, want.slice(cut), `>${right}=${reading.slice(cut).join(" ")}`);
  }
  if (chance * MISFIRE_MARGIN > fw) return { ok: false, why: `chance ${(chance / fw).toFixed(3)} of its use, most with ${worst?.[0]}`, block };
  return { ok: true, why: null, block };
}

/** The chance that a name's characters are two everyday words instead
 *  (each cut: a whole word, then a whole word, read otherwise). */
function phraseChance(word, reading, index) {
  const chars = [...word];
  const want = reading.map(numbered);
  let chance = 0;
  for (let cut = 1; cut < chars.length; cut++) {
    const l = index.forms.get(chars.slice(0, cut).join(""));
    const r = index.forms.get(chars.slice(cut).join(""));
    if (l && r && (harm(l, 0, want.slice(0, cut)) || harm(r, 0, want.slice(cut)))) chance += l.f * r.f;
  }
  return chance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
