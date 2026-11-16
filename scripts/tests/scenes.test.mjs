// The random scene's pure rules (web/shared/scenes.ts): which scenes fit a
// language, the pool, the draw and its recent-scene avoidance, the request
// check; and the assembler's preview of a random pack, deterministic and
// never drawing. Node strips the TS types.
//   node --test scripts/tests/scenes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "../assemble.mjs";
import { loadContent, normalizePack } from "../content.mjs";
import {
  MAX_COLLECTION_NAME, MAX_POOL_COLLECTIONS, RECENT_SCENES, drawRandomScene, drawScene, fitsTarget, keepDrawn, missingCollections, randomPool, readRandomScene, unsavedTurnPack, withDrawnScene,
} from "../../web/shared/scenes.ts";
import { copyFixture, write } from "./helpers.mjs";

const languages = [
  { name: "Spanish", variants: [], code: "es" },
  { name: "Japanese", variants: [], code: "ja" },
  { name: "Klingon", variants: [], code: null },
];
const sc = (id, language = null, collection = null) => ({ id, title: id, summary: "", tags: [], language, collection, category: null, roles: {}, beats: [], vocab: [], phrases: [], twists: [], body: "", path: "", uses_location: false });

const LIBRARY = [
  sc("palenque", "es-MX", "Oaxaca trip"),
  sc("mercado", "es_mx", "Oaxaca trip"),
  sc("taxi", null, "Travel essentials"),
  sc("hotel", null, "Travel essentials"),
  sc("cafe", null, "Daily life"),
  sc("sushi", "ja-JP", "Tokyo trip"),
  sc("bench", null, null),
];
const ids = (list) => list.map((s) => s.id);
const all = { collections: [] };

test("fitsTarget: a scene for every language fits; one written for a language fits only it, by code prefix; no code keeps everything", () => {
  assert.equal(fitsTarget(sc("x"), languages, "Japanese"), true);
  assert.equal(fitsTarget(sc("x", "es-MX"), languages, "Spanish"), true);
  assert.equal(fitsTarget(sc("x", "ES_ar"), languages, "Spanish"), true);
  assert.equal(fitsTarget(sc("x", "es-MX"), languages, "Japanese"), false);
  assert.equal(fitsTarget(sc("x", "es-MX"), languages, "Klingon"), true, "target without a code");
  assert.equal(fitsTarget(sc("x", "es-MX"), languages, "Elvish"), true, "target not in languages.yaml");
  assert.equal(fitsTarget(sc("x", "es-MX"), languages, ""), true, "no target");
});

test("randomPool: every scene that fits the target, in library order; collections narrow it", () => {
  assert.deepEqual(ids(randomPool(LIBRARY, languages, "Spanish", all)), ["palenque", "mercado", "taxi", "hotel", "cafe", "bench"]);
  assert.deepEqual(ids(randomPool(LIBRARY, languages, "Japanese", all)), ["taxi", "hotel", "cafe", "sushi", "bench"], "the Oaxaca trip is Spanish only");
  assert.deepEqual(ids(randomPool(LIBRARY, languages, "Spanish", { collections: ["Daily life", "Travel essentials"] })), ["taxi", "hotel", "cafe"]);
  assert.deepEqual(ids(randomPool(LIBRARY, languages, "Spanish", { collections: [""] })), ["bench"], `"" is the scenes in no collection`);
});

test("randomPool: a collection the library no longer has is ignored, the rest still used; nothing left is an empty pool, never the whole library", () => {
  assert.deepEqual(ids(randomPool(LIBRARY, languages, "Spanish", { collections: ["Gone", "Daily life"] })), ["cafe"]);
  assert.deepEqual(missingCollections(LIBRARY, { collections: ["Gone", "Daily life"] }), ["Gone"]);
  assert.deepEqual(randomPool(LIBRARY, languages, "Spanish", { collections: ["Gone"] }), []);
  assert.deepEqual(randomPool(LIBRARY, languages, "Spanish", { collections: ["Tokyo trip"] }), [], "a collection for another language adds nothing");
  assert.deepEqual(randomPool([], languages, "Spanish", all), []);
});

test("drawScene: deterministic for a given random source, and covers the pool across it", () => {
  const pool = randomPool(LIBRARY, languages, "Spanish", { collections: ["Travel essentials", "Daily life"] });
  assert.equal(drawScene(pool, [], () => 0).id, "taxi");
  assert.equal(drawScene(pool, [], () => 0.5).id, "hotel");
  assert.equal(drawScene(pool, [], () => 0.99).id, "cafe");
  assert.equal(drawScene(pool, [], () => 0.5).id, drawScene(pool, [], () => 0.5).id);
  // A source out of range is clamped rather than reading past the pool.
  assert.equal(drawScene(pool, [], () => 1).id, "cafe");
  assert.equal(drawScene(pool, [], () => Number.NaN).id, "taxi");
  assert.equal(drawScene([], [], () => 0), null, "an empty pool draws nothing");
});

test("drawScene: steers clear of the last min(5, pool - 1) distinct recent scenes in the pool", () => {
  const pool = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => sc(id));
  // Newest first, with repeats, quick scenes (null) and scenes outside the pool.
  const recent = ["a", "a", null, "zz", "b", "c", "d", "e", "f", "g"];
  const drawn = new Set();
  for (let i = 0; i < 100; i++) drawn.add(drawScene(pool, recent, () => i / 100).id);
  assert.deepEqual([...drawn].sort(), ["f", "g", "h"], `the first ${RECENT_SCENES} distinct (a–e) are left out; f and g are older than that`);
  // A pool of two alternates; a pool of one still draws its scene.
  assert.equal(drawScene([sc("a"), sc("b")], ["a"], () => 0).id, "b");
  assert.equal(drawScene([sc("a"), sc("b")], ["b", "a"], () => 0).id, "a");
  assert.equal(drawScene([sc("a")], ["a", "a"], () => 0.7).id, "a");
  // Three: the last two distinct are avoided.
  assert.equal(drawScene([sc("a"), sc("b"), sc("c")], ["c", "b", "a"], () => 0.99).id, "a");
});

test("drawRandomScene: keeps a scene this session drew while it is in the pool, else draws afresh", () => {
  const random = { collections: ["Travel essentials"] };
  assert.deepEqual(
    (({ scene, pool, kept }) => [scene.id, ids(pool), kept])(drawRandomScene(LIBRARY, languages, "Spanish", random, { keep: "hotel", rand: () => 0 })),
    ["hotel", ["taxi", "hotel"], true],
  );
  const fresh = drawRandomScene(LIBRARY, languages, "Spanish", random, { keep: "cafe", recent: ["taxi"], rand: () => 0 });
  assert.deepEqual([fresh.scene.id, fresh.kept], ["hotel", false], "not in the pool: a fresh draw, steering clear of taxi");
  assert.equal(drawRandomScene(LIBRARY, languages, "Spanish", { collections: ["Gone"] }, { rand: () => 0 }), null);
});

test("withDrawnScene: the pack plays the drawn scenario as if picked", () => {
  const pack = { title: "T", created: "", scenario: "", quick_scenario: "left over", random_scene: { collections: ["x"] }, units: ["u"], overrides: { location: "Lyon" }, notes: "n" };
  assert.deepEqual(withDrawnScene(pack, "taxi"), { ...pack, scenario: "taxi", quick_scenario: "", random_scene: null });
});

test("readRandomScene: absent is not random; an object is, collections trimmed and de-duplicated; anything malformed is an error", () => {
  for (const v of [undefined, null, false]) assert.deepEqual(readRandomScene(v), { value: null });
  assert.deepEqual(readRandomScene({}), { value: { collections: [] } });
  assert.deepEqual(readRandomScene({ collections: [" Daily life ", "Daily life", ""], extra: 1 }), { value: { collections: ["Daily life", ""] } });
  for (const bad of [true, "all", 3, [], { collections: "Daily life" }, { collections: [1] }, { collections: [null] }, { collections: ["a\u0000b"] }]) {
    assert.ok("error" in readRandomScene(bad), JSON.stringify(bad));
  }
  assert.ok("error" in readRandomScene({ collections: Array.from({ length: MAX_POOL_COLLECTIONS + 1 }, (_, i) => `c${i}`) }));
  assert.ok("value" in readRandomScene({ collections: Array.from({ length: MAX_POOL_COLLECTIONS }, (_, i) => `c${i}`) }));
  assert.ok("error" in readRandomScene({ collections: ["x".repeat(MAX_COLLECTION_NAME + 1)] }));
});

test("normalizePack: a malformed random_scene reads as none (the routes refuse it before)", () => {
  assert.equal(normalizePack({ random_scene: "yes" }).random_scene, null);
  assert.deepEqual(normalizePack({ random_scene: { collections: ["A"] } }).random_scene, { collections: ["A"] });
  assert.equal(normalizePack({}).random_scene, null);
});

/** The fixture library, with codes in languages.yaml and a few generic scenes. */
function library() {
  const root = copyFixture();
  write(root, "languages.yaml", "version: 1\nlanguages:\n  - name: Spanish\n    code: es\n    variants: [Mexican Spanish]\n  - name: Japanese\n    code: ja\n    variants: []\n");
  write(root, "scenarios/cafe.md", "---\nid: cafe\ntitle: Coffee on the corner\nsummary: Ordering a coffee.\ncollection: Daily life\n---\nA café in {{location}}.\n");
  write(root, "scenarios/sushi.md", "---\nid: sushi\ntitle: Sushi counter\nsummary: In Tokyo.\nlanguage: ja-JP\ncollection: Tokyo trip\n---\nA counter.\n");
  return loadContent(root);
}
const basePack = { title: "", created: "", scenario: "", quick_scenario: "", units: ["intro-native"], overrides: {}, notes: "" };

test("assemble: a random pack previews with a marked placeholder and the pool's size, deterministic, with no scene drawn", () => {
  const content = library();
  const pack = { ...basePack, random_scene: { collections: [] } };
  const a = assemble(content, pack);
  assert.deepEqual(a, assemble(content, pack), "same inputs, same output");
  assert.match(a.markdown, /^# Lingo Dojo session: Random scene$/m);
  // market, plaza and cafe fit Spanish; sushi is Japanese only.
  assert.match(a.markdown, /## Scenario\n\n_\(Random scene: one of the 3 scenes in its pool is drawn when the session starts, so this preview has no scenario yet\.\)_/);
  for (const title of ["Buying fruit at the market", "Evening in the plaza", "Coffee on the corner", "Sushi counter"]) assert.ok(!a.markdown.includes(title), title);
  assert.deepEqual(a.warnings.filter((w) => /scenario|scene/i.test(w)), [], "a random scene is not a missing scenario");
  assert.ok(a.stats.words > 0);
  // Narrowed to a collection, and the Location left out until a scene that uses it is drawn.
  const narrowed = assemble(content, { ...pack, random_scene: { collections: ["Daily life"] }, overrides: { location: "Lyon" } });
  assert.match(narrowed.markdown, /one of the 1 scene in its pool/);
  assert.ok(!narrowed.markdown.includes("Lyon"));
});

test("assemble: an empty pool is a warning and a visible line, never another scene; a leftover scenario is ignored with a warning", () => {
  const content = library();
  const empty = assemble(content, { ...basePack, random_scene: { collections: ["Tokyo trip"] } });
  assert.match(empty.markdown, /_\(Random scene: its pool is empty/);
  assert.ok(empty.warnings.some((w) => /pool is empty/.test(w) && /Spanish/.test(w)), empty.warnings.join("\n"));
  const leftover = assemble(content, { ...basePack, scenario: "market", random_scene: { collections: [] } });
  assert.ok(leftover.warnings.some((w) => /random scene; its scenario \("market"\) is ignored/.test(w)));
  assert.ok(!leftover.markdown.includes("Buying fruit at the market"));
});

test("assemble: a drawn scene plays exactly as the same scene picked, {{location}} included", () => {
  const content = library();
  const random = { ...basePack, random_scene: { collections: ["Daily life"] }, overrides: { location: "Lyon" } };
  const draw = drawRandomScene(content.scenarios, content.languages, "Spanish", random.random_scene, { rand: () => 0 });
  const played = assemble(content, withDrawnScene(random, draw.scene.id));
  const picked = assemble(content, { ...basePack, scenario: "cafe", overrides: { location: "Lyon" } });
  assert.equal(played.markdown, picked.markdown);
  assert.match(played.markdown, /A café in Lyon\./);
});

test("a collection name of only spaces is refused; only a literal \"\" means scenes in no collection", () => {
  assert.deepEqual(readRandomScene({ collections: [""] }), { value: { collections: [""] } });
  for (const name of [" ", "  \t", "\n"]) {
    const r = readRandomScene({ collections: ["Daily life", name] });
    assert.ok("error" in r, JSON.stringify(name));
    assert.match(r.error, /only spaces/);
  }
  assert.deepEqual(readRandomScene({ collections: [" Daily life "] }), { value: { collections: ["Daily life"] } });
});

test("the voice session's keep and unsaved-turn rules", () => {
  const random = { title: "", created: "", scenario: "", quick_scenario: "", random_scene: { collections: ["Travel"] }, units: [], overrides: {}, notes: "" };
  const picked = { ...random, scenario: "plaza", random_scene: null };
  // Create: a random pack asks to keep what the session drew, once it drew.
  assert.deepEqual(keepDrawn(random, "hotel"), { drawn: "hotel" });
  assert.deepEqual(keepDrawn(random, null), {}, "nothing drawn yet: a fresh draw");
  assert.deepEqual(keepDrawn(picked, "hotel"), {}, "a picked scene never sends one");
  // An unsaved turn: the drawn scene in place, as a picked one.
  assert.deepEqual(unsavedTurnPack(random, "hotel"), { ...random, scenario: "hotel", random_scene: null });
  assert.equal(unsavedTurnPack(random, null), random, "nothing drawn: still random (the server refuses it)");
  assert.equal(unsavedTurnPack(picked, "hotel"), picked);
});
