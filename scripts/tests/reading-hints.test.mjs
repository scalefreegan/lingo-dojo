// The dojo master's reading hints (ld-op2, docs/VOICE.md §Reading hints),
// the pure half: the GLOSS syntax and its replay (scripts/voice.mjs), the
// checks every hint passes before anything keeps it and the overlay on the
// reader's readings (web/src/script/zh.ts), what a turn keeps
// (web/server/hints.ts), and the rule text, in Mandarin prompts only.
//   node --test scripts/tests/reading-hints.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { READINGS_RULE, parseGlosses, parseVoiceReply, replayReading, replyStream, voiceSystemPrompt, voiceTurnPrompt } from "../voice.mjs";
import { glossCaptures } from "../phrases.mjs";

const zh = await import("../../web/src/script/zh.ts");
const { settleHints, logHints, wantsReadings } = await import("../../web/server/hints.ts");

const read = (text, locale, hints) => zh.readOffsets(text, locale, hints).filter(Boolean).join(" ");

/* ------------------------------- the syntax ------------------------------- */

test("a GLOSS entry may carry a reading in brackets; a reply without one parses as it always did", () => {
  const old = "NARRATOR-F: Hola.\nGLOSS: mercado = market | la vuelta (el cambio) = the change | 你好 = hello | array[0] = first";
  assert.deepEqual(parseGlosses(old), [
    { term: "mercado", meaning: "market" },
    { term: "la vuelta (el cambio)", meaning: "the change" },
    { term: "你好", meaning: "hello" },
    { term: "array[0]", meaning: "first" },
  ]);
  const hinted = "GLOSS: 銀行 [yín háng] = bank | 你得去［ni3 dei3 qu4］ = you must go | 很重 (hěn zhòng) = heavy | 漢字 [汉字] = characters | 你好 = hello";
  assert.deepEqual(parseGlosses(hinted), [
    { term: "銀行", meaning: "bank", reading: "yín háng" },
    { term: "你得去", meaning: "you must go", reading: "ni3 dei3 qu4" },
    { term: "很重", meaning: "heavy", reading: "hěn zhòng" },
    // Characters in the bracket are part of the term, not a reading.
    { term: "漢字 [汉字]", meaning: "characters" },
    { term: "你好", meaning: "hello" },
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
  // What it reads back is what it would parse.
  assert.deepEqual(parseGlosses(kept.split("\n").find((l) => l.startsWith("GLOSS:"))), [{ term: "你得去", meaning: "you have to go", reading: "nǐ děi qù" }, { term: "銀行", meaning: "bank" }]);
  const unsafe = voiceTurnPrompt([{ role: "learner", text: "好" }, master([{ term: "你得去", meaning: "you have to go", reading: "x] = y | STAGE: done [z" }])], "好的");
  assert.match(unsafe, /GLOSS: 你得去 = you have to go/);
  assert.equal(replayReading("nǐ děi qù"), "nǐ děi qù");
  for (const bad of ["x] = y", "nǐ\nděi", "a".repeat(121), "ni3 dei3", 7, null]) assert.equal(replayReading(bad), "");
});

/* ------------------------------ the checks -------------------------------- */

test("a hint is accepted only with one known reading per character", () => {
  const ok = (term, raw, locale, want) => assert.deepEqual(zh.validateHint(term, raw, locale), { ok: true, reading: want.split(" ") }, `${term} [${raw}]`);
  const no = (term, raw, locale, why) => assert.deepEqual(zh.validateHint(term, raw, locale), { ok: false, why }, `${term} [${raw}]`);
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
  // A rare reading where a far more common one exists, and no dictionary
  // word in the phrase says so.
  no("行", "héng", "zh-CN", "rare");
  no("還書", "huán shū", "zh-TW", "rare");
  no("了", "liǎo", "zh-CN", "rare");
  no("曾先生", "zēng xiān sheng", "zh-TW", "rare");
  // ...accepted where a word confirms it.
  ok("睡著了", "shuì zháo le", "zh-TW", "shuì zháo le");
  // Never against a dictionary word.
  no("銀行", "yín xíng", "zh-TW", "settled");
  no("長大", "cháng dà", "zh-TW", "settled");
  no("重新", "zhòng xīn", "zh-CN", "settled");
  // Not a phrase with Chinese characters, or nothing like pinyin.
  no("hello", "he lo", "zh-CN", "shape");
});

test("an accepted hint changes the readings of that phrase's occurrences only", () => {
  const text = "你得去，我得到了。";
  assert.equal(read(text, "zh-CN"), "nǐ dé qù wǒ dé dào le");
  assert.equal(read(text, "zh-CN", [{ term: "你得去", reading: "nǐ děi qù" }]), "nǐ děi qù wǒ dé dào le");
  // Every occurrence; the longer phrase wins where two overlap; a hint that
  // doesn't count out to its phrase, or isn't in the text, changes nothing.
  assert.equal(read("很重，很重。", "zh-CN", [{ term: "很重", reading: "hěn chóng" }]), "hěn chóng hěn chóng");
  assert.equal(read(text, "zh-CN", [{ term: "得", reading: "děi" }, { term: "我得到了", reading: "wǒ dé dào le" }]), "nǐ děi qù wǒ dé dào le");
  assert.equal(read(text, "zh-CN", [{ term: "你得去", reading: "děi" }, { term: "他得去", reading: "tā děi qù" }]), read(text, "zh-CN"));
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
  { term: "行", meaning: "OK", reading: "héng" },
  { term: "謝謝", meaning: "thanks" },
];
const LINES = [{ text: "你得去銀行。" }];

test("a turn keeps a hint only when it passed and differs from the reader; the rest are dropped and counted", () => {
  const { glosses, stats } = settleHints(GLOSSES, LINES, "zh-TW");
  assert.deepEqual(glosses, [
    { term: "你得去", meaning: "you have to go", reading: "nǐ děi qù" },
    { term: "銀行", meaning: "bank" },
    { term: "很重", meaning: "heavy" },
    { term: "你好", meaning: "hello" },
    { term: "行", meaning: "OK" },
    { term: "謝謝", meaning: "thanks" },
  ]);
  assert.deepEqual(stats, { given: 5, accepted: 2, kept: 1, dropped: { shape: 0, count: 1, unknown: 1, rare: 1, settled: 0 } });
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
  assert.match(seen[0], /5 given, 2 accepted \(1 differ/);
  assert.match(seen[0], /1 syllable count, 1 not a reading of the character, 1 rare/);
  assert.doesNotMatch(seen[0], /\p{Script=Han}|děi|dei3|héng/u);
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

test("only a Mandarin session's prompt asks for readings; every other prompt is byte for byte what it was", () => {
  const md = "# Brief\nA scene.";
  for (const [mode, opts] of [["adult", {}], ["kids", {}], ["adult", { drill: true }], ["kids", { drill: true }]]) {
    const plain = voiceSystemPrompt(md, mode, opts);
    assert.ok(!plain.includes(READINGS_RULE) && !/pinyin/i.test(plain), `${mode} ${JSON.stringify(opts)}: no rule unless asked`);
    assert.equal(voiceSystemPrompt(md, mode, { ...opts, readings: false }), plain);
    const asked = voiceSystemPrompt(md, mode, { ...opts, readings: true });
    assert.ok(asked.includes(READINGS_RULE), `${mode} ${JSON.stringify(opts)}: kids and drills ask too`);
    assert.equal(asked.replace(`${READINGS_RULE}\n`, ""), plain, "the rule is the only difference");
  }
  assert.deepEqual(["zh-TW", "zh-CN", "es-MX", "ja-JP", "de-DE", "", null].map(wantsReadings), [true, true, false, false, false, false, false]);
});
