#!/usr/bin/env node
// Common Mandarin words (PR #67, ld-4i2; docs/VOICE.md §Uncertain
// readings): writes web/src/script/zh-words.ts. Run by hand, offline from
// the app:
//
//   npm run pinyin:words [-- --top 20000] [-- --report]
//
// Every common word reads as CC-CEDICT reads it and is never marked: the
// top `--top` entries of wordfreq's Chinese list (20,000 by default: they
// are 94% of Chinese word tokens; the next 10,000 add 2 points, the
// 30,000 after those under 2 more) that are words of 2 to MAX_CHARS
// characters with a CC-CEDICT entry take the reading CC-CEDICT gives them
// (zh.ts applyCommon). A word CC-CEDICT reads two ways stays out (the
// reader's own rules decide it, and the mark may show), unless the two
// differ only by a neutral tone (东西 dōng xī / dōng xi): both are kept,
// and the reader's one stands. Reduplicated syllables are read alike
// (狗狗 [gou3 gou1] is gǒu gǒu: a doubled character takes its first tone,
// unless CC-CEDICT gives the second the neutral tone, 妈妈 mā ma).
// WORD_SKIP's words (gen-zh-freq.mjs: CC-CEDICT's reading isn't the
// everyday one) keep the reader's reading, settled with it, at any rank.
// A name's entry (CC-CEDICT's capitalised pinyin) counts like any other
// (华盛顿, 长江, 基督教; 明朝 Míng cháo, the dynasty, and míng zhāo,
// tomorrow morning, are two readings). An entry that only points to
// another ("see 長沙市") counts where the word has no other entry.
//
// The table holds only the words where it does something: one the reader
// (without the table) reads otherwise in either script, or one with a
// character of two ordinary readings (the prior's ranks), which the mark
// could pick out. The rest read the same with or without it.
//
// Sources (downloaded once into the gitignored caches, as gen-zh-freq.mjs
// and pinyin-sweep.mjs do): CC-CEDICT (MDBG, CC BY-SA 4.0) and wordfreq's
// Chinese list (Robyn Speer, CC BY-SA 4.0); the table is CC BY-SA 4.0 like
// zh-freq.ts (ZH-FREQ-LICENSE.txt).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { WORDFREQ_SHA256, WORDFREQ_URL, WORD_SKIP, cedictEntries, checkSha256, decodeCBpack, freqDir, marked } from "./gen-zh-freq.mjs";
import { loadCedict } from "./pinyin-sweep.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "web", "src", "script", "zh-words.ts");

/** The longest word kept, in characters (zh.ts COMMON_MAX). */
export const MAX_CHARS = 6;
/** wordfreq's top entries taken by default. */
export const TOP = 20_000;

/** Words CC-CEDICT reads one way that a sentence often reads another: a
 *  number and a measure word (一行字 yī háng, a line; CC-CEDICT's 一行 is
 *  the group, xíng). Never settled by the list. */
export const NOT_SETTLED = new Set(["一行"]);

const HAN = /^\p{Script=Han}+$/u;
const toneless = (r) => r.normalize("NFD").replace(/[̀-ͯ]/g, "");
const neutral = (r) => r === toneless(r);

/** A doubled character read alike: the second takes the first's tone
 *  unless CC-CEDICT gives either the neutral tone (狗狗 gou3 gou1 → gǒu
 *  gǒu; 妈妈 mā ma stays). Pure. */
export function evenDoubles(chars, syl) {
  const out = syl.slice();
  for (let k = 1; k < chars.length; k++) {
    if (chars[k] !== chars[k - 1] || toneless(out[k]) !== toneless(out[k - 1])) continue;
    if (!neutral(out[k]) && !neutral(out[k - 1]) && out[k] !== out[k - 1]) out[k] = out[k - 1];
  }
  return out;
}

/** Two readings of one word that differ only where one has the neutral
 *  tone of the other's syllable. */
const neutralOnly = (a, b) => a.length === b.length && a.every((x, n) => x === b[n] || (toneless(x) === toneless(b[n]) && (neutral(x) || neutral(b[n]))));

/**
 * The top words' CC-CEDICT readings, wordfreq order: `words` ({ word,
 * rank, trad, readings }: one reading, or several that differ only by a
 * neutral tone, CC-CEDICT's first first) and `two` (read two ways). Pure.
 */
export function cedictWords(entries, freq, top = TOP) {
  const ranked = [...freq].filter(([w]) => HAN.test(w)).sort((a, b) => b[1] - a[1]).slice(0, top);
  const by = new Map();
  const pointers = new Map();
  for (const e of entries) {
    if (e.variant) continue;
    const m = e.bound ? pointers : by;
    (m.get(e.simp) ?? m.set(e.simp, []).get(e.simp)).push(e);
  }
  const words = [];
  const two = [];
  ranked.forEach(([w], i) => {
    const n = [...w].length;
    if (n < 2 || n > MAX_CHARS || NOT_SETTLED.has(w)) return;
    const es = by.get(w) ?? pointers.get(w);
    if (!es) return;
    const list = [];
    for (const e of es) {
      const syl = e.syl.map(marked);
      if (syl.some((x) => !x)) continue;
      const r = evenDoubles(e.sc, syl);
      if (!list.some((x) => x.join(" ") === r.join(" "))) list.push(r);
    }
    if (!list.length) return;
    const trads = [...new Set(es.map((e) => e.trad))];
    if (list.every((r) => neutralOnly(r, list[0]))) words.push({ word: w, rank: i + 1, trad: es[0].trad, trads, readings: list });
    else two.push({ word: w, rank: i + 1, readings: list });
  });
  return { words, two };
}

async function main() {
  const top = Number(process.argv[process.argv.indexOf("--top") + 1]) || TOP;
  const { text, date } = await loadCedict();
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
  const zh = await import("../web/src/script/zh.ts");
  zh.useCommonWords(false);
  const ranks = zh.currentPrior().ranks;
  const read = (t, loc) => zh.readCodePoints(t, loc, { cache: false, corrections: null }).filter(Boolean);
  const entries = cedictEntries(text);
  const { words, two } = cedictWords(entries, freq, top);
  // WORD_SKIP's words are settled with the reader's reading at any rank
  // (喳喳, 懒洋洋: PR #63 left them to the reader on purpose).
  for (const w of WORD_SKIP) {
    if (words.some((x) => x.word === w)) continue;
    const e = entries.find((x) => x.simp === w);
    words.push({ word: w, rank: 0, trad: e?.trad ?? w, trads: [e?.trad ?? w], readings: [] });
  }
  // A simplified character written for several traditional ones (发: 發
  // and 髮): the word names its traditional spellings ("~"), so 散髮 (hair)
  // isn't read as 散发 (sàn fā, 散發).
  const from = new Map();
  for (const e of entries) e.sc.forEach((c, k) => (from.get(c) ?? from.set(c, new Set()).get(c)).add(e.tc[k]));
  const many = (w) => [...w].some((c) => (from.get(c)?.size ?? 0) > 1);
  const out = [];
  let alike = 0;
  for (const w of words) {
    const own = read(w.word, "zh-CN");
    // CC-CEDICT's reading isn't the everyday one: the reader's stands, settled.
    const readings = WORD_SKIP.has(w.word) ? [own] : w.readings;
    const tw = read(w.trad, "zh-TW");
    const same = (r) => readings.some((x) => x.length === r.length && x.every((y, n) => y === r[n]));
    const ambiguous = [...w.word].some((c) => (ranks.get(c)?.length ?? 0) > 1);
    if (!ambiguous && same(own) && same(tw)) {
      alike++;
      continue;
    }
    out.push(`${w.word}=${readings.map((r) => r.join(" ")).join("/")}${many(w.word) ? `~${w.trads.join(",")}` : ""}`);
  }
  out.sort();
  if (process.argv.includes("--report")) {
    console.log(`top ${top}: ${words.length} words read one way (${out.length} in the table, ${alike} read alike without it), ${two.length} read two ways`);
    console.log("read two ways, by frequency:", two.slice(0, 50).map((t) => `${t.word} ${t.readings.map((r) => r.join(" ")).join("/")}`).join(" · "));
  }
  const body = [
    "/* Common Mandarin words (zh.ts applyCommon): generated by",
    " * scripts/gen-zh-words.mjs, do not edit.",
    ` * Derived from CC-CEDICT (${date}; MDBG, CC BY-SA 4.0) and wordfreq's`,
    " * Chinese word list (Robyn Speer; data CC BY-SA 4.0): this table is",
    " * under CC BY-SA 4.0, see ZH-FREQ-LICENSE.txt.",
    ` * wordfreq's top ${top} words of 2 to ${MAX_CHARS} characters that CC-CEDICT reads`,
    ' * one way (or with and without a neutral tone: both, "/"), keyed by',
    ' * their simplified spelling ("~": the traditional spellings, where a',
    " * character stands for several); only those the reader would read",
    " * otherwise or could mark. */",
    "",
    `export const COMMON_WORDS = ${JSON.stringify(out.join("|"))};`,
    "",
  ].join("\n");
  fs.writeFileSync(OUT, body);
  console.log(`${out.length} words (${(body.length / 1024).toFixed(0)} KB) → ${path.relative(process.cwd(), OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
