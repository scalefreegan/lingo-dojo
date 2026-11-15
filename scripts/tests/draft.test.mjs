// The web app's pure draft helpers (web/src/draft.ts). Node (23.6+) strips the TS
// types natively (draft.ts imports only types), so these run under the same
// `node --test` as the loader and assembler, with no web test runner.
//   node --test scripts/tests/draft.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { draftToPack, effectiveMinutes, foreignLanguage, minutesWarning, packToDraft, validMinutes } from "../../web/src/draft.ts";

const languages = [
  { name: "Spanish", variants: [], code: "es" },
  { name: "Japanese", variants: [], code: "ja" },
  { name: "Klingon", variants: [], code: null },
];
const sc = (language) => ({ id: "x", title: "x", summary: "", tags: [], language, collection: "c", category: null, roles: {}, beats: [], vocab: [], phrases: [], twists: [], body: "", path: "", uses_location: false });

test("foreignLanguage: a collection written for another language is named", () => {
  assert.equal(foreignLanguage([sc("es-MX"), sc("es")], languages, "Japanese"), "Spanish");
});

test("foreignLanguage: never dims the target's own language, matching on the code prefix", () => {
  assert.equal(foreignLanguage([sc("es-MX")], languages, "Spanish"), null);
  assert.equal(foreignLanguage([sc("ES_ar")], languages, "Spanish"), null);
});

test("foreignLanguage: errs toward not dimming", () => {
  assert.equal(foreignLanguage([sc("es-MX"), sc(null)], languages, "Japanese"), null, "a language-neutral scenario in the collection");
  assert.equal(foreignLanguage([sc("es-MX")], languages, "Klingon"), null, "target without a code");
  assert.equal(foreignLanguage([sc("es-MX")], languages, "Elvish"), null, "target not in languages.yaml");
  assert.equal(foreignLanguage([sc("es-MX")], languages, ""), null, "no target");
  assert.equal(foreignLanguage([], languages, "Japanese"), null, "empty collection");
  assert.equal(foreignLanguage([sc("es-MX"), sc("ja-JP")], languages, "Japanese"), null, "mixed, includes the target");
});

test("foreignLanguage: a code languages.yaml doesn't list is shown raw", () => {
  assert.equal(foreignLanguage([sc("fr-CA")], languages, "Japanese"), "fr");
});

test("location round-trips through a pack as overrides.location, trimmed; blank is omitted", () => {
  const pack = { id: "p", title: "P", created: "", scenario: "s", quick_scenario: "", units: [], overrides: { level: "B1", location: "Lyon", extra: 1 }, notes: "" };
  const draft = packToDraft(pack);
  assert.equal(draft.location, "Lyon");
  assert.deepEqual(draft.extraOverrides, { extra: 1 }, "location is not an extra override");
  assert.deepEqual(draftToPack({ ...draft, location: "  Osaka " }).overrides, { extra: 1, level: "B1", location: "Osaka" });
  assert.equal("location" in draftToPack({ ...draft, location: "  " }).overrides, false);
});

test("minutes round-trip through a pack as overrides.minutes; the picker's value is what the pack carries", () => {
  const pack = { id: "p", title: "P", created: "", scenario: "s", quick_scenario: "", units: [], overrides: { location: "Lyon", minutes: 10 }, notes: "" };
  const draft = packToDraft(pack);
  assert.equal(draft.minutes, 10);
  assert.deepEqual(draft.extraOverrides, {}, "minutes is not an extra override");
  assert.deepEqual(draftToPack(draft).overrides, { location: "Lyon", minutes: 10 });
  // The pack's own length wins over the remembered one; without one, the
  // remembered one is what the picker shows and the pack carries.
  assert.equal(effectiveMinutes(draft, 5), 10);
  const none = { ...draft, minutes: null };
  assert.equal(effectiveMinutes(none, 5), 5);
  assert.equal(draftToPack(none, effectiveMinutes(none, 5)).overrides.minutes, 5);
  assert.equal("minutes" in draftToPack(none, effectiveMinutes(none, null)).overrides, false, "No limit: no minutes");
});

test("a minutes value the picker can't hold stays an extra override, so the assembler can warn about it", () => {
  const pack = { id: "p", title: "P", created: "", scenario: "s", quick_scenario: "", units: [], overrides: { minutes: "ten" }, notes: "" };
  const draft = packToDraft(pack);
  assert.equal(draft.minutes, null);
  assert.deepEqual(draftToPack(draft).overrides, { minutes: "ten" });
  assert.deepEqual(draftToPack(draft, 15).overrides, { minutes: 15 }, "a length standing in replaces it for the session");
  // ...and since the assembler then can't see it, the Go tab warns instead.
  assert.match(minutesWarning(draft, 15), /^Pack override "minutes" must be a number of minutes above 0 and at most 240, not "ten"; ignored \(using your last choice, 15 min, until you pick one\)\.$/);
  assert.equal(minutesWarning(draft, null), null, "nothing stands in: the assembler sees it and warns itself");
  assert.equal(minutesWarning({ ...draft, minutes: 15 }, 15), null, "a picked length is the pack's own: nothing to warn about");
  assert.equal(minutesWarning(packToDraft({ ...pack, overrides: {} }), 15), null, "no minutes at all");
});

test("validMinutes rounds like readMinutes, so the picker and timeline agree with the prompt", () => {
  assert.deepEqual([validMinutes(10), validMinutes(0), validMinutes(241), validMinutes("10"), validMinutes(7.5), validMinutes(0.3)], [10, null, null, null, 8, 1]);
  // The pack keeps what it was written with; only the session reads it rounded.
  const draft = packToDraft({ id: "p", title: "P", created: "", scenario: "s", quick_scenario: "", units: [], overrides: { minutes: 7.5 }, notes: "" });
  assert.equal(draft.minutes, 7.5);
  assert.equal(validMinutes(effectiveMinutes(draft, null)), 8);
});

test("a save carries only the pack's own minutes, never the remembered default", () => {
  const pack = { id: "p", title: "P", created: "", scenario: "s", quick_scenario: "", units: [], overrides: {}, notes: "" };
  const inherited = packToDraft(pack);
  // The session (assemble, export, the voice turn) uses the remembered 10...
  assert.equal(draftToPack(inherited, effectiveMinutes(inherited, 10)).overrides.minutes, 10);
  // ...but the pack written by Save (draftToPack's default) has none.
  assert.equal("minutes" in draftToPack(inherited).overrides, false);
  // Picking a length in the picker (re-picking the shown 10 included) makes it the pack's own.
  assert.equal(draftToPack({ ...inherited, minutes: 10 }).overrides.minutes, 10);
});

test("browser storage is per language profile; a learner's keys from before profiles move to the first language opened, once", async () => {
  const { adoptLearnerKeys, languageKey, loadRememberedDraft, rememberDraft } = await import("../../web/src/draft.ts");
  const store = new Map();
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    const draft = { units: ["intro-target"], overrides: { level: "B1" }, title: "Old draft" };
    store.set("lingo-dojo.draft.v1.learner.L1", JSON.stringify(draft));
    store.set("lingo-dojo.tab.v1.learner.L1", "go");
    store.set("lingo-dojo.tab.v1.learner.L2", "library");
    store.set(languageKey("lingo-dojo.scene-filter.v1", "G1"), "already German's");
    store.set("lingo-dojo.scene-filter.v1.learner.L1", "older");

    adoptLearnerKeys("L1", "G1");
    assert.equal(loadRememberedDraft("G1").title, "Old draft", "the draft is the first language's now");
    assert.equal(store.get("lingo-dojo.tab.v1.language.G1"), "go");
    assert.equal(store.get("lingo-dojo.scene-filter.v1.language.G1"), "already German's", "a language's own key wins");
    assert.ok(![...store.keys()].some((k) => k.endsWith(".learner.L1")), "moved, not copied");
    assert.equal(store.get("lingo-dojo.tab.v1.learner.L2"), "library", "another learner's keys wait for its own first language");

    // A second language of the same learner starts fresh; each keeps its own.
    adoptLearnerKeys("L1", "G2");
    assert.equal(loadRememberedDraft("G2"), null);
    rememberDraft("G2", { ...draft, title: "Chinese draft" });
    assert.equal(loadRememberedDraft("G2").title, "Chinese draft");
    assert.equal(loadRememberedDraft("G1").title, "Old draft");
  } finally {
    globalThis.localStorage = saved;
  }
});
