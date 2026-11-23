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
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { azurePronunciationResult } from "../pronunciation.mjs";
import { WORD_RULES, azureHeardNothing, checksWordsHere, heardNoneOf, quietTake, readWordText, wordCheckLocale, wordMarks, wordsReply } from "../pronunciation-words.mjs";
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
  // Arabic tatweel stretches a word; it is not another script.
  assert.deepEqual(readWordText("شكـرا", "ar-SA"), { text: "شكـرا" });
  // Punctuation separates words: "a,b,…" is thirteen words, not one;
  // apostrophes and hyphens don't split one.
  assert.ok(readWordText(Array(13).fill("uno").join(","), "es-MX").error);
  assert.ok(!readWordText(Array(6).fill("rendez-vous").join(" "), "fr-FR").error);
  assert.ok(!readWordText(Array(12).fill("j'ai").join(" "), "fr-FR").error);
  assert.equal(checksWordsHere("es-MX", "hola"), true);
  assert.equal(checksWordsHere("es-AR", "hola"), false);
  assert.equal(checksWordsHere("es-MX", "hola 3"), false);
});

/** Live replies (scripts/pronunciation-proof-echo.mjs, synthetic voices,
 *  reply shape only): what Azure really sends back. */
const ECHO = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pronunciation", "azure-echo.json"), "utf8"));
const echo = (id) => azurePronunciationResult(ECHO[id].reply);

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

test("an omitted word is off (missing) with no score; an inserted one isn't shown; a word not in the phrase is left out", () => {
  const r = wordMarks(live([["quiero", 95], ["un", 0, "Omission"], ["eh", 50, "Insertion"], ["zzz", 90], ["café", 91]]), "quiero un café", { locale: "es-MX" });
  assert.deepEqual(r.words.map((w) => [w.text, w.verdict, w.why ?? null, w.score]), [
    ["quiero", "ok", null, 95],
    ["un", "off", "missing", null],
    ["café", "ok", null, 91],
  ]);
  // The other setting, asked for explicitly: an omission is only not sure.
  const soft = wordMarks(live([["quiero", 95], ["un", 0, "Omission"]]), "quiero un", { locale: "es-MX", rules: { ...WORD_RULES, omissionOff: false } }).words[1];
  assert.deepEqual([soft.verdict, soft.reason, soft.why], ["unsure", "unclear", undefined]);
});

test("no speech: Azure's status says so, or a quiet take with every word omitted and nothing recognised", () => {
  assert.equal(azureHeardNothing(azurePronunciationResult({ RecognitionStatus: "NoMatch" })), true);
  assert.equal(azureHeardNothing(azurePronunciationResult({ RecognitionStatus: "InitialSilenceTimeout" })), true);
  assert.equal(azureHeardNothing(azurePronunciationResult({ RecognitionStatus: "Error" })), false);
  // Live (fixtures): silence, white noise and a clearly spoken wrong word
  // all come back the same: Success, every word omitted, no insertion, ".".
  for (const id of ["es-silence", "es-noise", "de-noise", "es-wrong1", "fr-wrong1", "es-wrong2"]) {
    const a = echo(id);
    assert.equal(a.text, ".", id);
    assert.ok(a.words.every((w) => w.error === "Omission"), id);
    assert.equal(azureHeardNothing(a, { quiet: true }), true, id);
    // So only the take's level tells silence from a wrong word.
    assert.equal(azureHeardNothing(a, { quiet: false }), false, id);
  }
  // Live, Danke assessed as Tschüss: a Mispronunciation, recognised text.
  assert.equal(azureHeardNothing(echo("de-wrong1"), { quiet: true }), false);
  // Something recognised, or something inserted, is speech even if quiet.
  const said = azurePronunciationResult({ RecognitionStatus: "Success", NBest: [{ Display: "hola", Words: [{ Word: "gracias", AccuracyScore: 0, ErrorType: "Omission" }] }] });
  assert.equal(azureHeardNothing(said, { quiet: true }), false);
  assert.equal(azureHeardNothing(live([["perro", 0, "Omission"], ["gato", 90, "Insertion"]]), { quiet: true }), false);
  assert.equal(azureHeardNothing(live([["la", 99], ["cuenta", 0, "Omission"]]), { quiet: true }), false);
});

test("Azure heard none of the words (live: a wrong word, noise, silence): no verdicts, heard none", () => {
  for (const [id, text] of [["es-wrong1", "gracias"], ["fr-wrong1", "merci"], ["es-wrong2", "muchas gracias"], ["es-noise", "hola"], ["de-noise", "Danke schön"]]) {
    const a = echo(id);
    assert.equal(heardNoneOf(a), true, id);
    const m = wordMarks(a, text, { locale: ECHO[id].case.locale });
    assert.equal(m.heard, "none", id);
    assert.equal(m.overall, null, id);
    assert.ok(m.words.length > 0 && m.words.every((w) => w.verdict === undefined), id);
    const adult = wordsReply(m, { kids: false, text, locale: ECHO[id].case.locale });
    assert.equal(adult.heard, "none");
    assert.equal(adult.overall, null);
    for (const w of adult.words) assert.deepEqual(Object.keys(w).sort(), ["end", "start", "text"]);
    const kid = wordsReply(m, { kids: true, text, locale: ECHO[id].case.locale });
    assert.deepEqual([kid.heard, kid.nudge], ["none", true]);
  }
  // Any partial reply keeps its marks: a word heard, an insertion, or
  // recognised text with letters.
  assert.equal(heardNoneOf(echo("de-wrong1")), false);
  const partial = wordMarks(live([["la", 99], ["cuenta", 0, "Omission"]]), "la cuenta", { locale: "es-MX" });
  assert.equal(partial.heard, undefined);
  assert.deepEqual(partial.words.map((w) => [w.verdict, w.why]), [["ok", undefined], ["off", "missing"]]);
  const swapped = wordMarks(live([["perro", 0, "Omission"], ["gato", 90, "Insertion"]]), "perro", { locale: "es-MX" });
  assert.deepEqual([swapped.heard, swapped.words[0].verdict], [undefined, "off"]);
  const recognised = azurePronunciationResult({ RecognitionStatus: "Success", NBest: [{ Display: "hola", Words: [{ Word: "gracias", AccuracyScore: 0, ErrorType: "Omission" }] }] });
  assert.deepEqual([heardNoneOf(recognised), wordMarks(recognised, "gracias", { locale: "es-MX" }).words[0].verdict], [false, "off"]);
});

test("a quiet take: its loudest 50 ms under about -40 dBFS", () => {
  const rate = 16_000;
  const noise = (amp) => Float32Array.from({ length: rate }, (_, i) => Math.sin(i * 12.9898) * amp);
  assert.equal(quietTake(new Float32Array(rate), rate), true);
  assert.equal(quietTake(noise(0.003), rate), true);
  assert.equal(quietTake(noise(0.15), rate), false);
  // One loud word in a second of quiet is enough.
  const word = new Float32Array(rate);
  word.set(noise(0.2).subarray(0, 4000), 6000);
  assert.equal(quietTake(word, rate), false);
  // A DC offset is not sound: a quiet take sitting at 0.2 is still quiet.
  assert.equal(quietTake(noise(0.003).map((x) => x + 0.2), rate), true);
  assert.equal(quietTake(noise(0.15).map((x) => x + 0.2), rate), false);
  // A few stray samples at the end join the window before: a click of
  // three samples there isn't a loud window of its own.
  const tail = new Float32Array(rate + 3);
  tail.set([0.05, -0.05, 0.05], rate);
  assert.equal(quietTake(tail, rate), true);
  // A full last window is its own.
  const end = new Float32Array(rate);
  end.set(noise(0.2).subarray(0, 800), rate - 800);
  assert.equal(quietTake(end, rate), false);
});

test("a word beside an inserted copy of itself is unsure, whatever its score (Azure aligned it to the wrong slot)", () => {
  // The proof's "je m'appelle Paul" said for "je m'appelle Marie": Azure
  // hears m'appelle as an extra word, then scores the reference's m'appelle 26.
  const r = wordMarks(live([["je", 97], ["m'appelle", 100, "Insertion"], ["m'appelle", 26, "Mispronunciation"], ["Paul", null, "Omission"]]), "je m'appelle Paul", { locale: "fr-FR" });
  assert.deepEqual(r.words.map((w) => [w.text, w.verdict, w.why ?? w.reason]), [
    ["je", "ok", undefined],
    ["m'appelle", "unsure", "unclear"],
    ["Paul", "off", "missing"],
  ]);
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

test("placed by a folded form: Arabic harakat and tatweel, ß as ss, accents; shown as written", () => {
  const ar = wordMarks(live([["شكرا", 95], ["جزيلا", 91]]), "شُكْرًا جَزِيـلًا", { locale: "ar-SA" });
  assert.deepEqual(ar.words.map((w) => w.text), ["شُكْرًا", "جَزِيـلًا"]);
  assert.equal("شُكْرًا جَزِيـلًا".slice(ar.words[1].start, ar.words[1].end), "جَزِيـلًا");
  const de = wordMarks(live([["STRASSE", 95], ["schön", 90]]), "Die Straße ist schon schön.", { locale: "de-DE" });
  assert.deepEqual(de.words.map((w) => [w.text, w.start, w.end]), [
    ["Straße", 4, 10],
    ["schön", 21, 26],
  ]);
  // The other way round, and an accent Azure leaves off.
  assert.deepEqual(wordMarks(live([["straße", 95], ["cafe", 90]]), "Strasse café", { locale: "de-DE" }).words.map((w) => w.text), ["Strasse", "café"]);
});

test("in a spaced script, placed only on whole words of the phrase", () => {
  // "a" is not the a inside "la"; it has no word of its own, so it's left out.
  const r = wordMarks(live([["a", 40, "Mispronunciation"], ["casa", 95]]), "la casa", { locale: "es-MX" });
  assert.deepEqual(r.words.map((w) => [w.text, w.start]), [["casa", 3]]);
  // A later whole word is found past a part of an earlier one.
  assert.deepEqual(wordMarks(live([["el", 95]]), "del el", { locale: "es-MX" }).words.map((w) => w.start), [4]);
  // Apostrophes and hyphens join a word, and Azure may split it there.
  assert.deepEqual(wordMarks(live([["j'", 90], ["ai", 90], ["rendez-vous", 95]]), "J'ai rendez-vous", { locale: "fr-FR" }).words.map((w) => w.text), ["J", "ai", "rendez-vous"]);
  assert.deepEqual(wordMarks(live([["rendez", 90], ["vous", 92]]), "rendez-vous", { locale: "fr-FR" }).words.map((w) => w.text), ["rendez", "vous"]);
  // Japanese has no spaces: Azure's words go anywhere after the last.
  assert.deepEqual(wordMarks(live([["こんばん", 95], ["は", 90]]), "こんばんは", { locale: "ja-JP" }).words.map((w) => w.text), ["こんばん", "は"]);
});

test("live echoes (fixtures): Azure sends the reference back as written, and every word lands on its own", () => {
  // Harakat, tanween, tatweel, ß, apostrophes, a hyphen, sí/si, matras and
  // a nukta, and Japanese split by Azure (私 が 行き ます).
  for (const id of ["ar-full", "ar-part", "ar-tatweel", "de-ss", "fr-apos", "fr-hyphen", "es-si", "hi-matra", "ja-ga"]) {
    const { case: c } = ECHO[id];
    const a = echo(id);
    const r = wordMarks(a, c.ref, { locale: c.locale });
    assert.deepEqual(r.words.map((w) => w.text), a.words.map((w) => w.text), id);
    for (const w of r.words) assert.equal(c.ref.normalize("NFC").slice(w.start, w.end), w.text, id);
    assert.ok(r.words.every((w) => w.verdict !== "off"), id);
  }
  const si = wordMarks(echo("es-si"), "Sí, si quieres.", { locale: "es-MX" }).words;
  assert.deepEqual(si.map((w) => [w.text, w.start, w.end]), [["Sí", 0, 2], ["si", 4, 6], ["quieres", 7, 14]]);
});

test("a word found without its marks keeps the marks that follow it: harakat, tanween, the last word to the end", () => {
  const text = "كَتَبَ الدَّرْسَ";
  const r = wordMarks(live([["كتب", 95], ["الدرس", 90]]), text, { locale: "ar-SA" });
  assert.deepEqual(r.words.map((w) => [w.text, w.start, w.end]), [["كَتَبَ", 0, 6], ["الدَّرْسَ", 7, 16]]);
  assert.equal(r.words.at(-1).end, text.length);
  const salam = wordMarks(live([["يا", 95], ["سلام", 95]]), "يا سَلامٌ", { locale: "ar-SA" }).words[1];
  assert.deepEqual([salam.text, salam.end], ["سَلامٌ", "يا سَلامٌ".length]);
  // Partly vocalised: the exact word where it is written bare, the bare
  // key where it isn't.
  const part = wordMarks(live([["شكراً", 95], ["جزيلا", 95]]), "شُكراً جزيلاً", { locale: "ar-SA" }).words;
  assert.deepEqual(part.map((w) => [w.text, w.start, w.end]), [["شُكراً", 0, 6], ["جزيلاً", 7, 13]]);
});

test("the nearest place wins, by either key; exact wins a tie", () => {
  // Azure's first "si" is the written "Sí": the bare key finds it there,
  // nearer than the exact key's "si", so the second's Mispronunciation
  // stays on the second word.
  const r = wordMarks(live([["si", 95], ["si", 20, "Mispronunciation"], ["quieres", 95]]), "Sí, si quieres", { locale: "es-MX" });
  assert.deepEqual(r.words.map((w) => [w.text, w.start, w.verdict]), [["Sí", 0, "ok"], ["si", 4, "off"], ["quieres", 7, "ok"]]);
  // Both at the same place: one mark, the exact one's.
  assert.deepEqual(wordMarks(live([["café", 95]]), "café", { locale: "es-MX" }).words.map((w) => [w.text, w.end]), [["café", 4]]);
});

test("no bare key where dropping marks makes two words one: Hindi, Japanese, Korean, Russian", () => {
  // Hindi: की is not क; a matra-final word keeps its matra.
  assert.deepEqual(wordMarks(live([["क", 95]]), "की", { locale: "hi-IN" }).words, []);
  const pani = wordMarks(live([["पानी", 95]]), "पानी", { locale: "hi-IN" }).words[0];
  assert.deepEqual([pani.text, pani.start, pani.end], ["पानी", 0, 4]);
  // Japanese: が is not か.
  assert.deepEqual(wordMarks(live([["か", 95]]), "が", { locale: "ja-JP" }).words, []);
  // Russian: й is not и.
  assert.deepEqual(wordMarks(live([["мои", 95]]), "мой", { locale: "ru-RU" }).words, []);
  // Korean: decomposed Hangul jamo are marks no longer; still exact only.
  assert.deepEqual(wordMarks(live([["물", 95]]), "물", { locale: "ko-KR" }).words.map((w) => w.text), ["물"]);
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
