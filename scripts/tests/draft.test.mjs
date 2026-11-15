// The web app's pure draft helpers (web/src/draft.ts). Node (23.6+) strips the TS
// types natively (draft.ts imports only types), so these run under the same
// `node --test` as the loader and assembler, with no web test runner.
//   node --test scripts/tests/draft.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { draftToPack, foreignLanguage, packToDraft } from "../../web/src/draft.ts";

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
