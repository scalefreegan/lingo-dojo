// The dojo master's reading hints (ld-op2, docs/VOICE.md §Reading hints),
// the pure half: the GLOSS syntax and its replay (scripts/voice.mjs), the
// checks every hint passes before anything keeps it and the overlay on the
// reader's readings (web/src/script/zh.ts), what a turn keeps
// (web/server/hints.ts), and the rule text behind its switch.
//   node --test scripts/tests/reading-hints.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { READINGS_RULE, parseGlosses, parseVoiceReply, replayReading, replyStream, voiceSystemPrompt, voiceTurnPrompt } from "../voice.mjs";
import { glossCaptures } from "../phrases.mjs";

const zh = await import("../../web/src/script/zh.ts");
const { settleHints, logHints, wantsReadings, readsHints, READING_HINTS_SWITCH } = await import("../../web/server/hints.ts");

const read = (text, locale, hints) => zh.readOffsets(text, locale, hints).filter(Boolean).join(" ");

/* ------------------------------- the syntax ------------------------------- */

test("without `readings` every gloss term is kept whole, as on main; with it, only a square-bracket reading is taken off", () => {
  const reply =
    "NARRATOR-F: Hola.\nGLOSS: mercado = market | la vuelta (el cambio) = the change | 你好 = hello | array[0] = first | 東京 (Tōkyō) = Tokyo | 銀行 [yín háng] = bank | 你得去［ni3 dei3 qu4］ = you must go | 很重 (hěn zhòng) = heavy | 漢字 [汉字] = characters";
  // Any language but Mandarin: nothing is a reading (this is main's parse).
  assert.deepEqual(parseGlosses(reply), [
    { term: "mercado", meaning: "market" },
    { term: "la vuelta (el cambio)", meaning: "the change" },
    { term: "你好", meaning: "hello" },
    { term: "array[0]", meaning: "first" },
    { term: "東京 (Tōkyō)", meaning: "Tokyo" },
    { term: "銀行 [yín háng]", meaning: "bank" },
    { term: "你得去［ni3 dei3 qu4］", meaning: "you must go" },
    { term: "很重 (hěn zhòng)", meaning: "heavy" },
    { term: "漢字 [汉字]", meaning: "characters" },
  ]);
  assert.deepEqual(parseGlosses(reply, { readings: false }), parseGlosses(reply));
  // Mandarin: square brackets (full-width too) after a term with a Chinese
  // character; round brackets and brackets holding characters stay a term.
  assert.deepEqual(parseGlosses(reply, { readings: true }), [
    { term: "mercado", meaning: "market" },
    { term: "la vuelta (el cambio)", meaning: "the change" },
    { term: "你好", meaning: "hello" },
    { term: "array[0]", meaning: "first" },
    { term: "東京 (Tōkyō)", meaning: "Tokyo" },
    { term: "銀行", meaning: "bank", reading: "yín háng" },
    { term: "你得去", meaning: "you must go", reading: "ni3 dei3 qu4" },
    { term: "很重 (hěn zhòng)", meaning: "heavy" },
    { term: "漢字 [汉字]", meaning: "characters" },
  ]);
});

test("streaming parity: the lines handed out early are the whole reply's, and the hinted GLOSS line is never one of them", () => {
  const reply = "NARRATOR-F: At the bank.\nCHARACTER-M: <t>你得去銀行。</t>\nCHARACTER-M: <t>行不行？</t>\nGLOSS: 你得去 [nǐ děi qù] = you have to go | 銀行 [yín háng] = bank\nSTAGE: scene";
  for (const size of [1, 3, 7, 1000]) {
    const s = replyStream("adult");
    const lines = [];
    for (let i = 0; i < reply.length; i += size) lines.push(...s.push(reply.slice(i, i + size)).lines);
    const whole = parseVoiceReply(reply, "adult");
    assert.deepEqual(lines, whole.slice(0, lines.length), `pieces of ${size}`);
    assert.ok(lines.length >= whole.length - 1);
    assert.ok(!whole.some((l) => /\[|děi/.test(l.text)), "no reading in a spoken line");
  }
});

test("replay: a kept reading goes back in its brackets, anything that isn't plain syllables does not", () => {
  const master = (glosses) => ({ role: "master", lines: [{ speaker: "character", gender: "m", text: "你得去銀行。", segments: [{ lang: "target", text: "你得去銀行。" }] }], glosses });
  const kept = voiceTurnPrompt([{ role: "learner", text: "好" }, master([{ term: "你得去", meaning: "you have to go", reading: "nǐ děi qù" }, { term: "銀行", meaning: "bank" }])], "好的");
  assert.match(kept, /GLOSS: 你得去 \[nǐ děi qù\] = you have to go \| 銀行 = bank/);
  // What it reads back is what a Mandarin session would parse.
  assert.deepEqual(parseGlosses(kept.split("\n").find((l) => l.startsWith("GLOSS:")), { readings: true }), [{ term: "你得去", meaning: "you have to go", reading: "nǐ děi qù" }, { term: "銀行", meaning: "bank" }]);
  const unsafe = voiceTurnPrompt([{ role: "learner", text: "好" }, master([{ term: "你得去", meaning: "you have to go", reading: "x] = y | STAGE: done [z" }])], "好的");
  assert.match(unsafe, /GLOSS: 你得去 = you have to go/);
  assert.equal(replayReading("nǐ děi qù"), "nǐ děi qù");
  for (const bad of ["x] = y", "nǐ\nděi", "a".repeat(121), "ni3 dei3", 7, null]) assert.equal(replayReading(bad), "");
});

/* ------------------------------ the checks -------------------------------- */

const ok = (term, raw, locale, want) => assert.deepEqual(zh.validateHint(term, raw, locale), { ok: true, reading: want.split(" ") }, `${term} [${raw}]`);
const no = (term, raw, locale, why) => assert.deepEqual(zh.validateHint(term, raw, locale), { ok: false, why }, `${term} [${raw}]`);

test("a hint is accepted only with one known reading per character", () => {
  // Tone marks, tone numbers, run together, an apostrophe.
  ok("很重", "hěn chóng", "zh-CN", "hěn chóng");
  ok("很重", "hen3 chong2", "zh-CN", "hěn chóng");
  ok("很重", "hěnchóng", "zh-CN", "hěn chóng");
  ok("女兒", "nǚ'ér", "zh-TW", "nǚ ér");
  // ü spelt v or u:.
  ok("女儿", "nv3 er2", "zh-CN", "nǚ ér");
  ok("綠色", "lu:4 se4", "zh-TW", "lǜ sè");
  // Sandhi on 一 and 不, a neutral tone, erhua: the app's own form stands.
  ok("不是", "bú shì", "zh-CN", "bù shì");
  ok("一個", "yí ge", "zh-TW", "yī gè");
  ok("東西", "dōng xi", "zh-TW", "dōng xī");
  ok("一點兒", "yì diǎnr", "zh-TW", "yī diǎn r");
  // Taiwan's reading for a zh-TW text, whichever the model wrote.
  ok("星期", "xīng qī", "zh-TW", "xīng qí");
  no("星期", "xīng qí", "zh-CN", "unknown");
  // The wrong number of syllables.
  no("很重", "zhòng", "zh-CN", "count");
  no("銀行", "yín háng le", "zh-TW", "count");
  // A sound the character doesn't have (a wrong tone is one).
  no("很重", "hěn zhōng", "zh-CN", "unknown");
  no("你好", "ní hǎo", "zh-CN", "unknown");
  // Not a phrase with Chinese characters, or nothing like pinyin.
  no("hello", "he lo", "zh-CN", "shape");
  no("很重", "，。", "zh-CN", "shape");
});

test("the order of authority: a dictionary word, then the hint, then the prior's tables, then the default (PR #63 review)", () => {
  // Any reading in use passes: the choice between a character's ordinary
  // readings is what a hint is for (the reader has hái for both).
  assert.equal(read("還錢", "zh-TW"), "huán qián", "give back, at the end (giveBack, PR #67 reviews)");
  assert.equal(read("還有", "zh-TW"), "hái yǒu");
  ok("還錢", "huán qián", "zh-TW", "huán qián");
  ok("還書", "huán shū", "zh-TW", "huán shū");
  ok("曾先生", "zēng xiān sheng", "zh-TW", "zēng xiān shēng");
  ok("你得去", "nǐ děi qù", "zh-CN", "nǐ děi qù");
  // Over what the prior chose: 抽空 is kòng by the table, 第五行 háng.
  assert.equal(read("抽空", "zh-TW"), "chōu kòng");
  assert.equal(zh.readDetail("抽空", "zh-TW", { cache: false }).dict.includes(true), false, "the table's word, not the library's");
  ok("抽空", "chōu kōng", "zh-TW", "chōu kōng");
  ok("第五行", "dì wǔ háng", "zh-TW", "dì wǔ háng");
  // Never over a word of the library's dictionary.
  no("銀行", "yín xíng", "zh-TW", "settled");
  no("長大", "cháng dà", "zh-TW", "settled");
  no("重新", "zhòng xīn", "zh-CN", "settled");
  ok("睡著了", "shuì zháo le", "zh-TW", "shuì zháo le");
  // Only a marginal reading (in the library's long list, in no CC-CEDICT
  // word: 說 yuè, 樂 yào) needs a dictionary word to confirm it.
  assert.ok(zh.knownReadings("說", "zh-TW").rare.includes("yuè"));
  assert.ok(zh.knownReadings("還", "zh-TW").usual.includes("huán"));
  no("他說", "tā yuè", "zh-TW", "rare");
  no("說話", "yuè huà", "zh-TW", "rare");
  // A phrase of one character takes no hint.
  no("長", "zhǎng", "zh-TW", "single");
  no("得", "děi", "zh-CN", "single");
});

test("checking a hint is bounded work: the worst case takes steps in proportion to its length (it took a minute)", () => {
  // 啊 has a, ā, á, ǎ, à…: every split of aaa… used to be tried.
  for (const n of [10, 12, 24]) {
    no("啊".repeat(n), "a".repeat(n + 1), "zh-CN", "count");
    assert.ok(zh.lastHintSteps() <= 40 * n, `${n} characters: ${zh.lastHintSteps()} steps`);
  }
  no("啊".repeat(24), "ā".repeat(23), "zh-CN", "count");
  assert.ok(zh.lastHintSteps() <= 40 * 24);
  // A hint longer than any reading of the phrase is not looked at.
  no("啊".repeat(24), "a".repeat(240), "zh-CN", "count");
  assert.equal(zh.lastHintSteps(), 0);
  no("很重", "hen3 chong2".repeat(30), "zh-CN", "shape");
  assert.equal(zh.lastHintSteps(), 0);
  // One that fits still fits.
  ok("啊".repeat(12), "a".repeat(12), "zh-CN", Array(12).fill("a").join(" "));
});

test("a hint is laid over its phrase only where that stands as a word of its own, never inside another word", () => {
  // The reviewer's cases: a hint for one character rewrote other words.
  const single = [
    ["長城很長", "長", "zhǎng"],
    ["我覺得你得去", "得", "děi"],
    ["這個很重要", "重", "chóng"],
    ["他很著名，看著我", "著", "zhe"],
    ["不行，去銀行", "行", "háng"],
  ];
  for (const [text, term, reading] of single) assert.equal(read(text, "zh-TW", [{ term, reading }]), read(text, "zh-TW"), `${term} in ${text}`);
  // Two characters or more, between word boundaries: 很重 is not in 很重要.
  assert.equal(read("箱子很重，很重要", "zh-TW", [{ term: "很重", reading: "hěn chóng" }]), "xiāng zǐ hěn chóng hěn zhòng yào");
  assert.equal(read("這個很重要", "zh-TW", [{ term: "很重", reading: "hěn chóng" }]), read("這個很重要", "zh-TW"));
  // That phrase's occurrences only; every one of them.
  const text = "你得去，我得到了。";
  assert.equal(read(text, "zh-CN"), "nǐ dé qù wǒ dé dào le");
  assert.equal(read(text, "zh-CN", [{ term: "你得去", reading: "nǐ děi qù" }]), "nǐ děi qù wǒ dé dào le");
  assert.equal(read("你得去！你得去。", "zh-CN", [{ term: "你得去", reading: "nǐ děi qù" }]), "nǐ děi qù nǐ děi qù");
  assert.equal(read("他還書給我", "zh-TW", [{ term: "還書", reading: "huán shū" }]), "tā huán shū gěi wǒ");
  // A character the library read from a dictionary word keeps it.
  assert.equal(read("去銀行", "zh-TW", [{ term: "去銀行", reading: "qù yín xíng" }]), "qù yín háng");
  // A hint that doesn't count out, isn't in the text, or names a sound the
  // character doesn't have (a stored reading whose phrase was edited: 長
  // zhǎng over 常常) changes nothing.
  assert.equal(read(text, "zh-CN", [{ term: "你得去", reading: "děi" }, { term: "他得去", reading: "tā děi qù" }]), read(text, "zh-CN"));
  assert.equal(read("常常", "zh-TW", [{ term: "常常", reading: "zhǎng zhǎng" }]), "cháng cháng");
  assert.equal(read(text, "zh-CN", []), read(text, "zh-CN"));
  assert.equal(read(text, "zh-CN", null), read(text, "zh-CN"));
  // The reader's own cache is not written through.
  assert.equal(read(text, "zh-CN"), "nǐ dé qù wǒ dé dào le");
});

/* --------------------------- what a turn keeps ---------------------------- */

const GLOSSES = [
  { term: "你得去", meaning: "you have to go", reading: "ni3 dei3 qu4" },
  { term: "銀行", meaning: "bank", reading: "yín háng" },
  { term: "很重", meaning: "heavy", reading: "zhòng" },
  { term: "你好", meaning: "hello", reading: "ní hǎo" },
  { term: "行", meaning: "OK", reading: "háng" },
  { term: "他說", meaning: "he says", reading: "tā yuè" },
  { term: "去銀行", meaning: "go to the bank", reading: "qù yín xíng" },
  { term: "謝謝", meaning: "thanks" },
];
const LINES = [{ text: "你得去銀行。" }];

test("a turn keeps a hint only when it passed and differs from the reader; the rest are dropped and counted", () => {
  const { glosses, stats } = settleHints(GLOSSES, LINES, "zh-TW");
  assert.deepEqual(glosses, [{ term: "你得去", meaning: "you have to go", reading: "nǐ děi qù" }, ...GLOSSES.slice(1).map(({ term, meaning }) => ({ term, meaning }))]);
  assert.deepEqual(stats, { given: 7, accepted: 2, kept: 1, dropped: { shape: 0, single: 1, count: 1, unknown: 1, rare: 1, settled: 1 } });
  // Any other language: no hint survives, whatever it says.
  for (const locale of ["es-MX", "ja-JP", "", null]) {
    const other = settleHints(GLOSSES, LINES, locale);
    assert.ok(other.glosses.every((g) => !("reading" in g)), String(locale));
    assert.equal(other.stats.kept, 0);
  }
});

test("the log line counts hints and never carries their text", (t) => {
  const seen = [];
  t.mock.method(console, "log", (...a) => seen.push(a.join(" ")));
  logHints(settleHints([{ term: "謝謝", meaning: "thanks" }], LINES, "zh-TW").stats);
  assert.deepEqual(seen, [], "nothing to say about a turn without hints");
  logHints(settleHints(GLOSSES, LINES, "zh-TW").stats);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /7 given, 2 accepted \(1 differ/);
  assert.match(seen[0], /1 syllable count, 1 not a reading of the character, 1 for one character alone, 1 marginal without a confirming word, 1 against a dictionary word/);
  assert.doesNotMatch(seen[0], /\p{Script=Han}|děi|dei3|háng|yuè/u);
});

test("the bank's capture carries a kept reading with its phrase", () => {
  const kept = settleHints(GLOSSES, LINES, "zh-TW").glosses;
  const got = glossCaptures(kept, LINES.map((l) => ({ ...l, segments: [{ lang: "target", text: l.text }] })), "zh-TW");
  const by = Object.fromEntries(got.map((c) => [c.text, c.reading]));
  assert.equal(by["你得去"], "nǐ děi qù");
  assert.equal(by["銀行"], undefined);
  assert.ok(!("reading" in got.find((c) => c.text === "銀行")));
});

/* ------------------------------ the rule text ----------------------------- */

test("the rule is in a prompt only when asked for; every other prompt is byte for byte what it was", () => {
  const md = "# Brief\nA scene.";
  for (const [mode, opts] of [["adult", {}], ["kids", {}], ["adult", { drill: true }], ["kids", { drill: true }]]) {
    const plain = voiceSystemPrompt(md, mode, opts);
    assert.ok(!plain.includes(READINGS_RULE) && !/pinyin/i.test(plain), `${mode} ${JSON.stringify(opts)}: no rule unless asked`);
    assert.equal(voiceSystemPrompt(md, mode, { ...opts, readings: false }), plain);
    const asked = voiceSystemPrompt(md, mode, { ...opts, readings: true });
    assert.ok(asked.includes(READINGS_RULE), `${mode} ${JSON.stringify(opts)}: kids and drills ask too`);
    assert.equal(asked.replace(`${READINGS_RULE}\n`, ""), plain, "the rule is the only difference");
  }
  // The cheaper, unconditional form: no judging which characters qualify.
  assert.match(READINGS_RULE, /after each glossed word of two or more characters \(not a whole sentence, not a single character\)/);
  assert.doesNotMatch(READINGS_RULE, /more than one reading/);
});

test("the switch: off by default, so no session asks; on, only a Mandarin one does (hints are read either way)", (t) => {
  const was = process.env[READING_HINTS_SWITCH];
  t.after(() => (was === undefined ? delete process.env[READING_HINTS_SWITCH] : (process.env[READING_HINTS_SWITCH] = was)));
  const locales = ["zh-TW", "zh-CN", "es-MX", "ja-JP", "de-DE", "", null];
  assert.equal(READING_HINTS_SWITCH, "LINGO_READING_HINTS");
  delete process.env[READING_HINTS_SWITCH];
  assert.deepEqual(locales.map(wantsReadings), locales.map(() => false), "off unless set");
  for (const v of ["", "0", "off", "true", "1"]) {
    process.env[READING_HINTS_SWITCH] = v;
    assert.deepEqual(locales.map(wantsReadings), locales.map(() => false), `"${v}" is not on`);
  }
  process.env[READING_HINTS_SWITCH] = "on";
  assert.deepEqual(locales.map(wantsReadings), [true, true, false, false, false, false, false]);
  delete process.env[READING_HINTS_SWITCH];
  assert.deepEqual(locales.map(readsHints), [true, true, false, false, false, false, false]);
});
