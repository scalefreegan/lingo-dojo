// The pure rules for the keyterms a Go-tab transcription carries (ld-7q4):
// scripts/keyterms.mjs, and keytermsFrom's Scribe limits.
//   node --test scripts/tests/keyterms.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { KEYTERM_SHARE, scenarioKeyterms, sessionKeyterms } from "../keyterms.mjs";
import { keytermsFrom } from "../voice.mjs";

test("keytermsFrom drops the characters Scribe refuses and keeps every term within 50 characters and 5 words", () => {
  const terms = keytermsFrom(["hola <b>mundo</b> {x} [y] a\\b", "x".repeat(60), "uno dos tres cuatro cinco seis siete"]);
  for (const t of terms) {
    assert.doesNotMatch(t, /[<>{}[\]\\]/, t);
    assert.ok(t.length <= 50 && t.split(/\s+/).length <= 5, t);
  }
  assert.ok(terms.includes("uno dos tres cuatro cinco"));
});

test("scenarioKeyterms: vocab terms only, none for a scenario of another language", () => {
  const scenario = { language: "es-MX", vocab: [{ term: "¿A cómo el kilo?", gloss: "x" }, { term: "mezcal", gloss: "y" }], phrases: ["how much"] };
  assert.deepEqual(scenarioKeyterms(scenario, "es-MX"), ["A cómo el kilo", "mezcal"]);
  assert.deepEqual(scenarioKeyterms(scenario, "de-DE"), []);
  assert.deepEqual(scenarioKeyterms(undefined, "es-MX"), []);
});

test("sessionKeyterms: excluded phrases (a review, kept phrases) are sent from no source", () => {
  const out = sessionKeyterms({ heard: ["Cuánto cuesta", "hola"], scenario: ["cuánto cuesta", "mezcal"], bank: ["¿Cuánto cuesta?", "la vuelta"], exclude: ["¿Cuánto cuesta?"] });
  assert.deepEqual(out, ["hola", "mezcal", "la vuelta"]);
});

test("sessionKeyterms: each source under its share, deduplicated across, at most 100 in all", () => {
  const many = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const out = sessionKeyterms({ heard: ["Hola", ...many("oído", 80)], scenario: ["hola", ...many("escena", 80)], bank: many("banco", 80) });
  assert.equal(out.length, 100);
  assert.equal(out[0], "Hola");
  assert.equal(out.filter((t) => t.toLowerCase() === "hola").length, 1);
  assert.equal(out.filter((t) => t.startsWith("oído")).length, KEYTERM_SHARE.heard - 1);
  assert.equal(out.filter((t) => t.startsWith("escena")).length, KEYTERM_SHARE.scenario);
  assert.equal(out.filter((t) => t.startsWith("banco")).length, KEYTERM_SHARE.bank);
  assert.deepEqual(sessionKeyterms({}), []);
});
