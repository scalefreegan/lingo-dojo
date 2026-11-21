// The phrase bank's pure half (scripts/phrases.mjs): what glosses and
// scenario lists put in, input checks, metrics, and the bank view's list.
//   node --test scripts/tests/phrases.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { newCard, review } from "../fsrs.mjs";
import {
  LIMITS, MAX_CAPTURE_CHARS, MAX_CAPTURE_WORDS, TROUBLE_LAPSES, bankLocale, bankPage, charCount, clean, exampleFor, glossCaptures, phraseMetrics, readPhraseInput, sameLanguage,
  scenarioEntries, tooLongToCapture, wordCount,
} from "../phrases.mjs";

const LINES = [
  { speaker: "narrator", text: "You reach the stall.", segments: [{ lang: "native", text: "You reach the stall." }] },
  { speaker: "character", text: "¿Qué le doy, joven? Los mangos están a diez.", segments: [{ lang: "target", text: "¿Qué le doy, joven? Los mangos están a diez." }] },
];

test("glossCaptures: one item per target form, sentences left out, sorted by key, each with the line that holds it", () => {
  const items = glossCaptures(
    [
      { term: "mangos", meaning: "mangoes" },
      { term: "¿Qué le doy, joven?", meaning: "What can I get you, young man?" },
      { term: "Mangos", meaning: "mangoes (again)" },
      { term: "Los mangos están a diez.", meaning: "The mangoes are ten." },
      { term: "  ", meaning: "blank" },
      { term: "jitomate", meaning: "tomato" },
      { term: "¡A diez!", meaning: "at ten" },
    ],
    LINES,
    "es-MX",
  );
  assert.deepEqual(items.map((i) => i.norm), ["a diez", "jitomate", "mangos"], "four words and more are a sentence");
  assert.equal(items[0].example.sentence, "¿Qué le doy, joven? Los mangos están a diez.");
  const mangos = items.find((i) => i.norm === "mangos");
  assert.equal(mangos.meaning, "mangoes", "the first gloss of a form wins");
  assert.equal(mangos.meaningNorm, "mangoes");
  assert.deepEqual(mangos.example, { sentence: "¿Qué le doy, joven? Los mangos están a diez.", speaker: "character" });
  assert.equal(items.find((i) => i.norm === "jitomate").example, null, "not in any line: no example");
  assert.equal(wordCount("Los mangos están a diez.", "es-MX"), 5);
  assert.ok(wordCount("¿Qué le doy, joven?", "es-MX") > MAX_CAPTURE_WORDS, "four words: a sentence");
});

test("glossCaptures: a language without spaces is measured in characters, not segmenter words", () => {
  const ja = glossCaptures(
    [
      { term: "いくら", meaning: "how much" },
      { term: "ありがとうございます", meaning: "thank you" },
      { term: "このりんごはいくらですか、教えてください", meaning: "please tell me how much this apple is" },
    ],
    [],
    "ja-JP",
  );
  // ありがとうございます is one phrase, however a segmenter cuts it: kept.
  assert.deepEqual(ja.map((i) => i.text).sort(), ["ありがとうございます", "いくら"].sort());
  const zh = glossCaptures([{ term: "请再说一遍", meaning: "please say it again" }, { term: "你好", meaning: "hello" }], [], "zh-CN");
  assert.equal(zh.length, 2, "short Mandarin phrases are phrases");
  assert.equal(charCount("请再说一遍。"), 5, "punctuation isn't counted");
  assert.equal(charCount("ขอบคุณครับ") <= MAX_CAPTURE_CHARS, true, "a Thai mark isn't a character of its own");
  assert.equal(tooLongToCapture("x".repeat(MAX_CAPTURE_CHARS + 1), "zh-TW"), true);
  assert.equal(tooLongToCapture("una dos tres cuatro", "es-MX"), true);
  assert.equal(tooLongToCapture("una dos tres", "es-MX"), false);
});

test("exampleFor: the line's target words holding the term as whole words; not the term alone; null when no line has it", () => {
  assert.equal(exampleFor("¡Hola!", [{ speaker: "dojo_master", text: "Hola, ¿cómo estás?" }], "es-MX").sentence, "Hola, ¿cómo estás?");
  // A line that is only the term shows nothing of its use.
  assert.equal(exampleFor("hola", [{ speaker: "x", text: "Say hola.", segments: [{ lang: "native", text: "Say" }, { lang: "target", text: "hola" }] }], "es-MX"), null);
  assert.equal(exampleFor("¡Hola!", [{ speaker: "x", text: "Hola." }, { speaker: "y", text: "Hola, joven." }], "es-MX").sentence, "Hola, joven.");
  assert.equal(exampleFor("adiós", LINES, "es-MX"), null);
  // Whole words: "mar" isn't in "mercado", "a diez" is in "a diez.".
  assert.equal(exampleFor("mar", [{ speaker: "x", text: "Vamos al mercado." }], "es-MX"), null);
  assert.equal(exampleFor("a diez", LINES, "es-MX").speaker, "character");
  assert.equal(exampleFor("está", LINES, "es-MX"), null, "están is another word");
  // No spaces: found as text.
  assert.equal(exampleFor("いくら", [{ speaker: "x", text: "このりんごはいくらですか。" }], "ja-JP").sentence, "このりんごはいくらですか。");
  assert.ok(exampleFor("x", [{ speaker: "x", text: "x ".repeat(400) }], "es-MX").sentence.length <= LIMITS.sentence);
});

test("clean: C0 controls, DEL, NEL, zero-width and bidi characters go; ZWJ and ZWNJ stay; a note keeps its lines", () => {
  assert.equal(clean("a\u0007b\u202Ec\u2066d\u007Fe"), "abcde");
  assert.deepEqual(readPhraseInput({ text: "\u202Emangos\u202C", meaning: "mango\u0001es", note: "one\r\ntwo\u0008" }, { create: true }).value, {
    text: "mangos", meaning: "mangoes", note: "one\ntwo",
  });
  assert.deepEqual(glossCaptures([{ term: "ma\u200Fngo\u202E", meaning: "mango" }], [], "es-MX").map((i) => i.text), ["mango"], "the bidi marks too");
  assert.equal(clean("a\u0085b\u200Bc\u200Ed\u200Fe\u061Cf\u2060g\uFEFFh\u2067i"), "abcdefghi");
  // Persian and Hindi spell with the joiners: kept.
  assert.equal(clean("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645 \u0915\u094D\u200D\u0937"), "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645 \u0915\u094D\u200D\u0937");
});

test("sameLanguage: by ISO language where known, else by name; a blank side never disagrees", () => {
  assert.equal(sameLanguage("Spanish", { language: "Spanish", variant: "Castilian Spanish" }), true);
  assert.equal(sameLanguage("Spanish", { language: "German", variant: "" }), false);
  assert.equal(sameLanguage("spanish", { language: " Spanish ", variant: "" }), true);
  assert.equal(sameLanguage("Klingon", { language: "klingon" }), true);
  assert.equal(sameLanguage("Klingon", { language: "Elvish" }), false);
  assert.equal(sameLanguage("", { language: "German" }), true);
  assert.equal(sameLanguage("German", { language: "" }), true);
});

test("bankLocale: the session's locale when it is the profile's language, null when a pack moved it, empty for an unknown one", () => {
  assert.equal(bankLocale("Spanish", { targetLanguage: "Spanish", targetVariant: "Mexican Spanish" }), "es-MX");
  assert.equal(bankLocale("Spanish", { targetLanguage: "German", targetVariant: "" }), null);
  assert.equal(bankLocale("Klingon", { targetLanguage: "Klingon", targetVariant: "" }), "");
});

test("scenarioEntries: vocab complete (only in the scenario's own language), phrases pending, both deduped and sorted", () => {
  const scenario = {
    language: "es-MX",
    vocab: [{ term: "¿Cuánto cuesta?", gloss: "How much is it?" }, { term: "la vuelta", gloss: "" }, { term: "¿cuánto cuesta?", gloss: "dupe" }, { term: "" }],
    phrases: ["To this address, please", "to this address, please", ""],
  };
  const out = scenarioEntries(scenario, "es-ES");
  assert.deepEqual(out.complete.map((c) => [c.text, c.meaning]), [["¿Cuánto cuesta?", "How much is it?"], ["la vuelta", null]]);
  assert.deepEqual(out.pending, [{ meaning: "To this address, please", meaningNorm: "to this address, please" }]);
  // A Mexican Spanish scenario played in German brings no Spanish words; its
  // English meanings still pend.
  const de = scenarioEntries(scenario, "de-DE");
  assert.deepEqual(de.complete, []);
  assert.equal(de.pending.length, 1);
  assert.deepEqual(scenarioEntries(null, "es-MX"), { complete: [], pending: [] });
  // No language on the scenario: it fits every language.
  assert.equal(scenarioEntries({ vocab: [{ term: "taxi", gloss: "taxi" }] }, "de-DE").complete.length, 1);
});

test("readPhraseInput: an add needs words; an edit needs something; strings checked, trimmed, NUL refused", () => {
  assert.deepEqual(readPhraseInput({ text: "  ¿A  cómo? ", meaning: " how much? ", note: " line one\nline two ", extra: 1 }, { create: true }).value, {
    text: "¿A cómo?", meaning: "how much?", note: "line one\nline two",
  });
  assert.match(readPhraseInput({}, { create: true }).error, /text is required/);
  assert.match(readPhraseInput({ text: "  " }, { create: true }).error, /blank/);
  assert.match(readPhraseInput({ text: "¿?" }, { create: true }).error, /letter or digit/);
  assert.match(readPhraseInput({ text: "a\u0000b" }, { create: true }).error, /NUL/);
  assert.match(readPhraseInput({ text: "x".repeat(LIMITS.text + 1) }, { create: true }).error, /longer than/);
  assert.match(readPhraseInput({ text: 4 }, { create: true }).error, /string/);
  assert.match(readPhraseInput({}, {}).error, /nothing to change/);
  assert.match(readPhraseInput({ text: null }).error, /blank/);
  assert.deepEqual(readPhraseInput({ meaning: "", note: null, starred: true }).value, { meaning: null, note: null, starred: true });
  assert.match(readPhraseInput({ suspended: "yes" }).error, /true or false/);
  // A note is measured as stored: its lines kept, so runs of spaces that
  // one-lining would fold still count.
  assert.match(readPhraseInput({ note: "x\n".repeat(LIMITS.note) }).error, /longer than/);
  assert.equal(readPhraseInput({ note: `${"x".repeat(LIMITS.note)}\u0001\u0001` }).value.note.length, LIMITS.note);
  assert.match(readPhraseInput([]).error, /JSON object/);
});

test("phraseMetrics: the weakest card's band, the earliest due, trouble from lapses", () => {
  const t0 = new Date("2026-11-01T12:00:00Z");
  assert.deepEqual(phraseMetrics([], 0), { mastery: "New", due: null, lapses: 0, trouble: false, cardCount: 0 });
  const fresh = newCard(t0);
  let strong = fresh;
  for (const d of [0, 3, 12, 40]) strong = review(strong, 3, new Date(t0.getTime() + d * 86_400_000)).card;
  const learning = review(newCard(t0), 3, t0).card;
  const m = phraseMetrics([strong, learning], TROUBLE_LAPSES);
  assert.equal(m.mastery, "Learning", "only as known as its weakest card");
  assert.equal(m.due, learning.due < strong.due ? learning.due : strong.due);
  assert.equal(m.trouble, true);
  assert.equal(phraseMetrics([strong], TROUBLE_LAPSES - 1).trouble, false);
  assert.notEqual(phraseMetrics([strong]).mastery, "New");
  assert.equal(phraseMetrics([fresh]).mastery, "New", "a card never reviewed is New");
  // ...and new, not due: its due time is when it was made.
  assert.equal(phraseMetrics([fresh]).due, null);
  assert.equal(phraseMetrics([fresh, learning]).mastery, "Learning", "practised once is no longer New");
  assert.equal(phraseMetrics([fresh, learning]).due, learning.due, "due from the reviewed card only");
});

test("bankPage: search, filters, sorts, paging and the chip counts", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  const p = (id, extra) => ({
    id, text: id, meaning: null, note: null, lang: "es-MX", source: "gloss", pending: false, starred: false, suspended: false, firstSeenAt: null, lastSeenAt: null,
    seenCount: 0, lastPracticedAt: null, createdAt: "2026-11-01T00:00:00Z", mastery: "New", due: null, lapses: 0, trouble: false, cardCount: 0, exampleCount: 0, ...extra,
  });
  const items = [
    p("café", { meaning: "coffee", lastSeenAt: "2026-11-14T00:00:00Z", due: "2026-11-10T00:00:00Z", mastery: "Learning", cardCount: 1 }),
    p("la vuelta", { starred: true, lastSeenAt: "2026-11-15T00:00:00Z", due: "2026-11-20T00:00:00Z", mastery: "Familiar", cardCount: 1 }),
    p("ojo", { trouble: true, lapses: 3, due: "2026-11-01T00:00:00Z", mastery: "Learning", cardCount: 1, createdAt: "2026-11-05T00:00:00Z" }),
    p("taxi", { text: null, meaning: "taxi please", pending: true, source: "scenario" }),
    p("zzz", { suspended: true, due: "2026-11-01T00:00:00Z", mastery: "Mastered", note: "the café one" }),
  ];
  const all = bankPage(items, {}, now);
  assert.equal(all.total, 5);
  assert.deepEqual(all.counts, { all: 5, starred: 1, new: 0, due: 2, trouble: 1, pending: 1, suspended: 1, pictures: 0, bands: { New: 0, Learning: 2, Familiar: 1, Mastered: 0 } }, "the bands leave out pending and suspended, like new and due");
  assert.deepEqual(all.phrases.map((x) => x.id), ["la vuelta", "café", "ojo", "taxi", "zzz"], "last seen first, else added; ties by words");
  // Never practised is new, not due, whether its card is unreviewed or it
  // has none yet (a scene's list); a suspended or pending one is neither.
  // The "new" filter, its count and the New band agree.
  const fresh = [
    p("mango", { cardCount: 1 }),
    p("papaya", { source: "scenario" }),
    p("piña", { cardCount: 1, suspended: true }),
    p("pera", { text: null, meaning: "pear", pending: true }),
    p("uva", { mastery: "Learning", cardCount: 1, due: "2026-11-20T00:00:00Z" }),
  ];
  const page = bankPage(fresh, { show: "new" }, now);
  assert.deepEqual([page.phrases.map((x) => x.id).sort(), page.counts.new, page.counts.due, page.counts.bands.New], [["mango", "papaya"], 2, 0, 2]);
  assert.deepEqual(bankPage(fresh, { band: "New" }, now).phrases.map((x) => x.id).sort(), ["mango", "papaya"]);
  assert.deepEqual(bankPage(items, { q: "CAFE" }, now).phrases.map((x) => x.id), ["café", "zzz"], "accent- and case-blind, in note too");
  assert.deepEqual(bankPage(items, { show: "due" }, now).phrases.map((x) => x.id).sort(), ["café", "ojo"], "suspended isn't due");
  assert.deepEqual(bankPage(items, { show: "pending" }, now).phrases.map((x) => x.id), ["taxi"]);
  // With picture: only what the list query marked (ld-p1e), counted over the whole bank.
  const pictured = items.map((x, i) => ({ ...x, hasPicture: i === 0 || i === 2 || i === 4 }));
  const withPic = bankPage(pictured, { show: "pictures" }, now);
  assert.deepEqual(withPic.phrases.map((x) => x.id).sort(), ["café", "ojo", "zzz"]);
  assert.equal(withPic.counts.pictures, 3);
  assert.equal(bankPage(pictured, { show: "pictures", q: "ojo" }, now).total, 1);
  assert.deepEqual(bankPage(items, { band: "Learning", sort: "weakest" }, now).phrases.map((x) => x.id), ["ojo", "café"], "most lapses first in a band");
  assert.deepEqual(bankPage(items, { sort: "due" }, now).phrases.map((x) => x.id), ["ojo", "zzz", "café", "la vuelta", "taxi"]);
  assert.deepEqual(bankPage(items, { sort: "alpha" }, now).phrases.map((x) => x.id), ["café", "la vuelta", "ojo", "taxi", "zzz"]);
  const one = bankPage(items, { sort: "alpha", limit: 2, offset: 2 }, now);
  assert.deepEqual([one.phrases.map((x) => x.id), one.nextOffset], [["ojo", "taxi"], 4]);
  assert.equal(bankPage(items, { sort: "alpha", limit: 2, offset: 4 }, now).nextOffset, null);
  assert.equal(bankPage(items, { show: "nonsense", sort: "nonsense", band: "nonsense" }, now).total, 5, "unknown values read as the defaults");
});
