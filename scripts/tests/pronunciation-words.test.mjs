// The word check's pure rules (ld-ne0.16; scripts/pronunciation-words.mjs,
// web/shared/word-check.ts): which locales, which phrases, and how Azure's
// reply becomes one mark per word. No network: replies are written here in
// the shape the live service gave the proof (docs/pronunciation-proof.md
// §Words and sounds beyond Mandarin).
//   node --test scripts/tests/pronunciation-words.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { azurePronunciationResult } from "../pronunciation.mjs";
import { WORD_RULES, checksWordsHere, readWordText, wordCheckLocale, wordMarks, wordsReply } from "../pronunciation-words.mjs";
import { REPO_ROOT } from "../content.mjs";
import { localeFor } from "../voice.mjs";

test("every language and variant in languages.yaml: checked in its exact Azure locale, or not at all", () => {
  const doc = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "content", "languages.yaml"), "utf8"));
  const got = {};
  for (const l of doc.languages) for (const v of ["", ...(l.variants ?? [])]) got[`${l.name}${v ? ` / ${v}` : ""}`] = wordCheckLocale(localeFor(l.name, v));
  assert.equal(got["Spanish"], "es-MX");
  assert.equal(got["Spanish / Castilian Spanish (Spain)"], "es-ES");
  assert.equal(got["Spanish / Argentine Spanish"], null);
  assert.equal(got["Spanish / Colombian Spanish"], null);
  assert.equal(got["German"], "de-DE");
  assert.equal(got["German / Swiss German"], null);
  assert.equal(got["German / Austrian German"], null);
  assert.equal(got["French / Québécois French"], "fr-CA");
  assert.equal(got["Japanese"], "ja-JP");
  assert.equal(got["Korean"], "ko-KR");
  assert.equal(got["Portuguese / European Portuguese"], "pt-PT");
  assert.equal(got["English / British English"], "en-GB");
  assert.equal(got["Arabic"], "ar-SA");
  assert.equal(got["Arabic / Egyptian Arabic"], "ar-EG");
  assert.equal(got["Arabic / Levantine Arabic"], null);
  assert.equal(got["Greek"], null, "Azure has no pronunciation assessment for Greek");
  // Mandarin is the tone check's, never this one's.
  assert.equal(got["Mandarin Chinese"], null);
  assert.equal(got["Mandarin Chinese / Taiwanese Mandarin"], null);
  assert.equal(wordCheckLocale("zh-HK"), null, "Cantonese: supported by Azure, not measured");
  assert.equal(wordCheckLocale("es-mx"), null);
  assert.equal(wordCheckLocale("es-MX&x=1"), null);
});

test("the phrase: its own script, words and punctuation only, a dozen words at most", () => {
  assert.deepEqual(readWordText("  ¿Dónde está el baño?  ", "es-MX"), { text: "¿Dónde está el baño?" });
  assert.deepEqual(readWordText("je m'appelle Marie", "fr-FR"), { text: "je m'appelle Marie" });
  assert.deepEqual(readWordText("水をください。", "ja-JP"), { text: "水をください。" });
  assert.deepEqual(readWordText("물 주세요", "ko-KR"), { text: "물 주세요" });
  assert.deepEqual(readWordText("где вокзал?", "ru-RU"), { text: "где вокзал?" });
  assert.deepEqual(readWordText("मुझे पानी चाहिए", "hi-IN"), { text: "मुझे पानी चाहिए" });
  assert.deepEqual(readWordText("أين المحطة؟", "ar-SA"), { text: "أين المحطة؟" });
  // Composed: a decomposed é is the same phrase.
  assert.equal(readWordText("café", "es-MX").text, "café");
  for (const [t, loc] of [["", "es-MX"], ["tengo 3 perros", "es-MX"], ["hola 🙂", "es-MX"], ["mizu", "ja-JP"], ["privet", "ru-RU"], ["Привет", "es-MX"], ["...", "es-MX"]]) {
    assert.ok(readWordText(t, loc).error, `${t} in ${loc}`);
  }
  assert.ok(readWordText(Array(13).fill("uno").join(" "), "es-MX").error);
  assert.ok(!readWordText(Array(12).fill("uno").join(" "), "es-MX").error);
  assert.ok(readWordText("あ".repeat(31), "ja-JP").error);
  assert.equal(checksWordsHere("es-MX", "hola"), true);
  assert.equal(checksWordsHere("es-AR", "hola"), false);
  assert.equal(checksWordsHere("es-MX", "hola 3"), false);
});

/** A reply as the live service sends it for a Latin-script locale. */
const live = (words) =>
  azurePronunciationResult({
    RecognitionStatus: "Success",
    NBest: [{ PronScore: 81.4, Words: words.map(([Word, AccuracyScore, ErrorType = "None", Phonemes = []], i) => ({ Word, Offset: 2_000_000 + i * 3_000_000, Duration: 2_800_000, AccuracyScore, ErrorType, Phonemes })) }],
  });

test("the bars: off needs Azure's Mispronunciation and a low score; ok needs no error and a high one; the rest is unsure", () => {
  const below = WORD_RULES.offBelow - 1;
  const r = wordMarks(
    live([
      ["la", 99],
      ["cuenta", below, "Mispronunciation"],
      ["por", WORD_RULES.offBelow, "Mispronunciation"],
      ["favor", below],
    ]),
    "La cuenta, por favor.",
    { locale: "es-MX" },
  );
  assert.deepEqual(r.words.map((w) => [w.text, w.verdict]), [
    ["La", "ok"],
    ["cuenta", "off"],
    ["por", "unsure"],
    // A low score Azure doesn't call a mispronunciation is never off.
    ["favor", "unsure"],
  ]);
  assert.equal(r.overall, 81);
  assert.deepEqual([r.words[1].startMs, r.words[1].endMs], [500, 780]);
  const okEdge = wordMarks(live([["hola", WORD_RULES.okFrom - 1]]), "hola", { locale: "es-MX" }).words[0];
  assert.equal(okEdge.verdict, "unsure");
  assert.equal(wordMarks(live([["hola", WORD_RULES.okFrom]]), "hola", { locale: "es-MX" }).words[0].verdict, "ok");
});

test("an omitted word is never off; an inserted one isn't shown; a word not in the phrase is left out", () => {
  const r = wordMarks(live([["quiero", 95], ["un", null, "Omission"], ["eh", 50, "Insertion"], ["zzz", 90], ["café", 91]]), "quiero un café", { locale: "es-MX" });
  assert.deepEqual(r.words.map((w) => [w.text, w.verdict]), [
    ["quiero", "ok"],
    ["un", WORD_RULES.omissionOff ? "off" : "unsure"],
    ["café", "ok"],
  ]);
});

test("a word beside an inserted copy of itself is unsure, whatever its score (Azure aligned it to the wrong slot)", () => {
  // The proof's "je m'appelle Paul" said for "je m'appelle Marie": Azure
  // hears m'appelle as an extra word, then scores the reference's m'appelle 26.
  const r = wordMarks(live([["je", 97], ["m'appelle", 100, "Insertion"], ["m'appelle", 26, "Mispronunciation"], ["Paul", null, "Omission"]]), "je m'appelle Paul", { locale: "fr-FR" });
  assert.deepEqual(r.words.map((w) => [w.text, w.verdict]), [
    ["je", "ok"],
    ["m'appelle", WORD_RULES.insertionGuard ? "unsure" : "off"],
    ["Paul", WORD_RULES.omissionOff ? "off" : "unsure"],
  ]);
  assert.equal(r.words[2].why, WORD_RULES.omissionOff ? "missing" : undefined);
  // Without the guard the same reply flags the right word.
  const raw = wordMarks(live([["m'appelle", 100, "Insertion"], ["m'appelle", 26, "Mispronunciation"]]), "m'appelle", { locale: "fr-FR", rules: { ...WORD_RULES, insertionGuard: false } });
  assert.equal(raw.words[0].verdict, "off");
});

test("placed on the phrase as written: case, accents, apostrophes and characters outside the BMP", () => {
  const fr = wordMarks(live([["j'ai", 95], ["faim", 30, "Mispronunciation"]]), "J'ai faim !", { locale: "fr-FR" });
  assert.deepEqual(fr.words.map((w) => [w.text, w.start, w.end]), [
    ["J'ai", 0, 4],
    ["faim", 5, 9],
  ]);
  const ja = wordMarks(live([["駅", 95], ["は", 90], ["どこ", 90], ["です", 92], ["か", 91]]), "駅はどこですか", { locale: "ja-JP" });
  assert.deepEqual(ja.words.map((w) => w.text), ["駅", "は", "どこ", "です", "か"]);
  // 𠮷 is two UTF-16 units: the slice keeps it whole.
  const wide = wordMarks(live([["𠮷野", 95]]), "𠮷野", { locale: "ja-JP" });
  assert.deepEqual([wide.words[0].start, wide.words[0].end, wide.words[0].text], [0, 3, "𠮷野"]);
});

test("the weakest sound: only where the rules name the locale, and only on an off word", () => {
  const phonemes = [
    { Phoneme: "t", AccuracyScore: 95 },
    { Phoneme: "r", AccuracyScore: 12 },
    { Phoneme: "iy", AccuracyScore: 70 },
  ];
  const off = live([["tree", 20, "Mispronunciation", phonemes]]);
  const named = wordMarks(off, "tree", { locale: "en-US", rules: { ...WORD_RULES, weakSounds: ["en-US"] } }).words[0];
  assert.deepEqual(named.sounds, [{ name: "r", score: 12 }]);
  assert.equal(wordMarks(off, "tree", { locale: "es-MX", rules: { ...WORD_RULES, weakSounds: ["en-US"] } }).words[0].sounds, undefined);
  // Unnamed phonemes (every locale but en-US, live): nothing to show.
  const unnamed = live([["pero", 20, "Mispronunciation", phonemes.map((p) => ({ ...p, Phoneme: "" }))]]);
  assert.equal(wordMarks(unnamed, "pero", { locale: "es-MX", rules: { ...WORD_RULES, weakSounds: ["es-MX"] } }).words[0].sounds, undefined);
  for (const loc of WORD_RULES.weakSounds) assert.ok(wordCheckLocale(loc), loc);
});

test("the reply: adults get marks and timings; kids only where the words are, and a nudge", () => {
  const marks = wordMarks(live([["Guten", 95], ["Morgen", 15, "Mispronunciation"]]), "Guten Morgen", { locale: "de-DE" });
  const adult = wordsReply(marks, { kids: false, text: "Guten Morgen", locale: "de-DE" });
  assert.equal(adult.kind, "words");
  assert.equal(adult.overall, 81);
  assert.deepEqual(adult.words.map((w) => w.verdict), ["ok", "off"]);
  assert.ok(adult.words.every((w) => !("azureError" in w)));
  const kid = wordsReply(marks, { kids: true, text: "Guten Morgen", locale: "de-DE" });
  assert.equal(kid.overall, null);
  assert.equal(kid.nudge, true);
  assert.deepEqual(kid.words, [
    { text: "Guten", start: 0, end: 5 },
    { text: "Morgen", start: 6, end: 12 },
  ]);
});
