// Hidden library scenes (docs/DATA.md §Hidden scenes, migration 0009): the
// pure rules in web/shared/scenes.ts (the request check, the visible list,
// the random pool without hidden scenes, the empty-pool message) and the
// rows in scripts/db/hidden.ts on a fresh PGlite (hide, unhide, a repeat,
// and one language's hides invisible and untouchable from any other).
//   node --test scripts/tests/hidden.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLanguageProfile, createLearner, createUser } from "../db/accounts.ts";
import { hiddenSet, hideScene, listHidden, unhideScene } from "../db/hidden.ts";
import {
  MAX_HIDDEN_KEY, NOTHING_HIDDEN, drawRandomScene, emptiedByHides, emptyPoolMessage, hiddenSetOf, isHiddenScene, randomPool, readHiddenRef, visibleScenes,
} from "../../web/shared/scenes.ts";
import { freshDb } from "./testdb.mjs";

const languages = [
  { name: "Spanish", code: "es", variants: [] },
  { name: "Mandarin Chinese", code: "zh", variants: [] },
];
const sc = (id, collection, extra = {}) => ({ id, collection, language: null, format: "scene", ...extra });
const LIBRARY = [
  sc("cafe", "Daily life"),
  sc("taxi", "Travel essentials"),
  sc("hotel", "Travel essentials"),
  sc("hello", "First steps", { format: "drill" }),
  sc("tones", "First steps (Mandarin)", { format: "drill", language: "zh" }),
  sc("bench", null),
];
const ids = (xs) => xs.map((s) => s.id);
const hide = (scenarios = [], collections = []) => ({ scenarios, collections });

/* ---------------------------------- pure ---------------------------------- */

test("readHiddenRef: kind and key checked, the key kept exactly; an unknown id is allowed", () => {
  assert.deepEqual(readHiddenRef({ kind: "scenario", key: "no-such-scene" }), { value: { kind: "scenario", key: "no-such-scene" } });
  assert.deepEqual(readHiddenRef({ kind: "collection", key: "" }), { value: { kind: "collection", key: "" } }, `"" is the scenes in no collection`);
  assert.deepEqual(readHiddenRef({ kind: "collection", key: " Daily life" }).value.key, " Daily life", "not trimmed: it must match the library's name");
  assert.deepEqual(readHiddenRef({ kind: "collection", key: "x".repeat(MAX_HIDDEN_KEY) }).value.kind, "collection");
  for (const bad of [null, [], "cafe", { kind: "folder", key: "x" }, { kind: "scenario" }, { kind: "scenario", key: 7 }, { kind: "scenario", key: "  " }, { kind: "collection", key: "x".repeat(MAX_HIDDEN_KEY + 1) }, { kind: "scenario", key: "a\u0000b" }]) {
    assert.ok("error" in readHiddenRef(bad), JSON.stringify(bad));
  }
});

test("isHiddenScene and visibleScenes: hidden one by one or by the folder; the selected one stays", () => {
  const h = hiddenSetOf([{ kind: "scenario", key: "taxi" }, { kind: "collection", key: "First steps (Mandarin)" }, { kind: "collection", key: "" }]);
  assert.deepEqual(h, { scenarios: ["taxi"], collections: ["First steps (Mandarin)", ""] });
  assert.equal(isHiddenScene(LIBRARY[1], h), true);
  assert.equal(isHiddenScene(LIBRARY[4], h), true, "through its folder");
  assert.equal(isHiddenScene(LIBRARY[5], h), true, `"" hides the scenes in no collection`);
  assert.equal(isHiddenScene(LIBRARY[2], h), false, "its folder-mate is not hidden");
  assert.deepEqual(ids(visibleScenes(LIBRARY, h)), ["cafe", "hotel", "hello"]);
  assert.deepEqual(ids(visibleScenes(LIBRARY, h, "tones")), ["cafe", "hotel", "hello", "tones"], "the selected scene is kept, in library order");
  assert.deepEqual(ids(visibleScenes(LIBRARY, NOTHING_HIDDEN)), ids(LIBRARY));
});

test("randomPool leaves hidden scenes and hidden collections out, before the drill rule", () => {
  const all = { collections: [] };
  assert.deepEqual(ids(randomPool(LIBRARY, languages, "Spanish", all)), ["cafe", "taxi", "hotel", "bench"]);
  assert.deepEqual(ids(randomPool(LIBRARY, languages, "Spanish", all, hide(["taxi"], ["Daily life"]))), ["hotel", "bench"]);
  assert.deepEqual(ids(randomPool(LIBRARY, languages, "Spanish", { collections: ["Travel essentials"] }, hide([], ["Travel essentials"]))), [], "a chosen collection that is hidden adds nothing");
  // Every scene hidden: the drills are what is left, as a pool of only drills keeps them.
  assert.deepEqual(ids(randomPool(LIBRARY, languages, "Spanish", all, hide(["bench"], ["Daily life", "Travel essentials"]))), ["hello"]);
  assert.deepEqual(ids(randomPool(LIBRARY, languages, "Spanish", { collections: ["First steps"] }, hide(["hello"]))), []);
});

test("drawRandomScene never draws a hidden scene, and a kept scene hidden since is drawn afresh", () => {
  for (const r of [0, 0.3, 0.6, 0.99]) {
    const d = drawRandomScene(LIBRARY, languages, "Spanish", { collections: [] }, { rand: () => r, hidden: hide(["cafe", "bench"]) });
    assert.ok(["taxi", "hotel"].includes(d.scene.id), d.scene.id);
  }
  const d = drawRandomScene(LIBRARY, languages, "Spanish", { collections: ["Travel essentials"] }, { keep: "taxi", rand: () => 0, hidden: hide(["taxi"]) });
  assert.deepEqual([d.scene.id, d.kept], ["hotel", false]);
  assert.equal(drawRandomScene(LIBRARY, languages, "Spanish", { collections: ["Daily life"] }, { rand: () => 0, hidden: hide(["cafe"]) }), null);
});

test("emptiedByHides and the message: only when the hides alone empty the pool", () => {
  const daily = { collections: ["Daily life"] };
  assert.equal(emptiedByHides(LIBRARY, languages, "Spanish", daily, hide(["cafe"])), true);
  assert.equal(emptiedByHides(LIBRARY, languages, "Spanish", daily, NOTHING_HIDDEN), false, "not empty");
  assert.equal(emptiedByHides(LIBRARY, languages, "Spanish", { collections: ["Gone"] }, hide(["cafe"])), false, "empty without any hide");
  assert.match(emptyPoolMessage(daily, "Spanish", true), /in the chosen collections is hidden.*Restore/);
  assert.match(emptyPoolMessage({ collections: [] }, "Spanish", true), /every scene that fit Spanish is hidden/);
  assert.doesNotMatch(emptyPoolMessage(daily, "Spanish"), /hidden/);
});

/* -------------------------------- database -------------------------------- */

async function seed(db) {
  const user = await createUser(db, { username: "ana", passwordHash: "x", isAdmin: false });
  const ana = await createLearner(db, user.id, { name: "Ana", mode: "adult", targetLanguage: "Spanish", level: "A2" });
  const ben = await createLearner(db, user.id, { name: "Ben", mode: "adult", targetLanguage: "Spanish", level: "A1" });
  const anaZh = await createLanguageProfile(db, ana.id, { targetLanguage: "Mandarin Chinese", level: "A1" });
  const ref = (p) => ({ id: p.id, learnerId: p.learnerId });
  return { es: ref(ana.language), zh: ref(anaZh), ben: ref(ben.language) };
}

test("the migration makes hidden_scenes: its kind and key checks, and a profile's delete takes its hides", async (t) => {
  const { db, query, close } = await freshDb();
  t.after(close);
  const { es } = await seed(db);
  await assert.rejects(query(`insert into hidden_scenes (learner_id, language_profile_id, kind, key) values ($1, $2, 'folder', 'x')`, [es.learnerId, es.id]), /hidden_scenes_kind/);
  await assert.rejects(query(`insert into hidden_scenes (learner_id, language_profile_id, kind, key) values ($1, $2, 'scenario', $3)`, [es.learnerId, es.id, "x".repeat(201)]), /hidden_scenes_key_length/);
  await hideScene(db, es, "scenario", "cafe");
  await query(`delete from language_profiles where id = $1`, [es.id]);
  assert.equal((await query(`select count(*)::int as n from hidden_scenes`))[0].n, 0);
});

test("hide, a repeat that changes nothing, unhide, and hide again", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  const { es } = await seed(db);
  const first = await hideScene(db, es, "scenario", "cafe");
  assert.equal(first.created, true);
  const again = await hideScene(db, es, "scenario", "cafe");
  assert.deepEqual([again.created, again.row.hiddenAt.getTime()], [false, first.row.hiddenAt.getTime()], "the first time stays");
  await hideScene(db, es, "collection", "");
  await hideScene(db, es, "collection", "First steps (Mandarin)");
  assert.deepEqual((await listHidden(db, es)).map((r) => [r.kind, r.key]), [["scenario", "cafe"], ["collection", ""], ["collection", "First steps (Mandarin)"]]);
  assert.deepEqual(await hiddenSet(db, es), { scenarios: ["cafe"], collections: ["", "First steps (Mandarin)"] });
  assert.equal(await unhideScene(db, es, "scenario", "cafe"), true);
  assert.equal(await unhideScene(db, es, "scenario", "cafe"), false, "nothing left to unhide");
  assert.equal(await unhideScene(db, es, "collection", "cafe"), false, "the kind is part of the key");
  assert.equal((await hideScene(db, es, "scenario", "cafe")).created, true, "hiding again inserts again");
});

test("one language's hides are invisible from, and can't be removed by, another language or learner", async (t) => {
  const { db, query, close } = await freshDb();
  t.after(close);
  const { es, zh, ben } = await seed(db);
  await hideScene(db, es, "collection", "First steps (Mandarin)");
  await hideScene(db, zh, "scenario", "cafe");
  assert.deepEqual((await listHidden(db, zh)).map((r) => r.key), ["cafe"], "Ana's Mandarin sees only its own");
  assert.deepEqual(await listHidden(db, ben), []);
  assert.equal(await unhideScene(db, ben, "collection", "First steps (Mandarin)"), false);
  assert.equal(await unhideScene(db, zh, "collection", "First steps (Mandarin)"), false);
  // Ben hiding the same thing is his own row, not a conflict with Ana's.
  assert.equal((await hideScene(db, ben, "collection", "First steps (Mandarin)")).created, true);
  assert.equal((await query(`select count(*)::int as n from hidden_scenes`))[0].n, 3);
  assert.deepEqual((await listHidden(db, es)).map((r) => r.key), ["First steps (Mandarin)"]);
  // A scope with mismatched owners (Ana's profile under Ben) matches nothing.
  assert.deepEqual(await listHidden(db, { id: es.id, learnerId: ben.learnerId }), []);
});
