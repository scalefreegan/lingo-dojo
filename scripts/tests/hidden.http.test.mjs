// Hidden library scenes over HTTP (docs/DATA.md §Hidden scenes): the
// /api/hidden-scenes routes (no session 401, a stale page 409, a bad body
// 400, the language always the session's), and the random draw at a
// session's start and an export leaving hidden scenes and folders out,
// with the empty-pool message saying when hides emptied it. A picked
// scene that is hidden still plays. On the real plugin with an in-process
// PGlite and a stand-in `claude`. Every name here is made up.
//   node --test scripts/tests/hidden.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture, write } from "./helpers.mjs";
import { ADULT, addUser, client, tab } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-exports-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_EXPORTS_DIR = exportsDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

write(
  root,
  "languages.yaml",
  [
    "version: 1",
    "languages:",
    "  - { name: English, code: en, variants: [] }",
    "  - { name: Spanish, code: es, variants: [Mexican Spanish] }",
    "  - { name: German, code: de, variants: [] }",
  ].join("\n"),
);
// The fixture has market (es-MX) and plaza (every language), in no collection.
const scene = (id, title, extra) => ["---", `id: ${id}`, `title: ${title}`, `summary: ${title}, briefly.`, ...extra, "---", `${title} body.`].join("\n");
write(root, "scenarios/cafe.md", scene("cafe", "Coffee on the corner", ["collection: Daily life"]));
write(root, "scenarios/taxi.md", scene("taxi", "Taxi across town", ["collection: Travel essentials"]));
write(root, "scenarios/hotel.md", scene("hotel", "Checking in", ["collection: Travel essentials"]));

const { apiPlugins } = await import("../../web/server/api.ts");
const { useSceneRandom } = await import("../../web/server/randomScene.ts");

const fake = fakeClaude();
const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  useSceneRandom(null);
  fake.restore();
  await close();
  await testDb.close();
});
beforeEach(() => {
  fake.answer("NARRATOR-F: Hola.\nSTAGE: scene");
  useSceneRandom(null);
});

let n = 0;
async function someone(learner = ADULT) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners: [learner] });
  const c = client(base);
  await c.login(name);
  await c.pick(learner.name);
  return c;
}

const randomPack = (collections = []) => ({ title: "", created: "", scenario: "", quick_scenario: "", random_scene: { collections }, units: [], overrides: {}, notes: "" });
const libraryPack = (scenario) => ({ title: "", created: "", scenario, quick_scenario: "", units: [], overrides: {}, notes: "" });
const keys = (r) => r.body.hidden.map((h) => `${h.kind}:${h.key}`);

test("no session is a 401; a page showing another learner or language is 409 stale_learner, and nothing is written", async () => {
  const anon = client(base);
  for (const [m, body] of [["GET"], ["POST", { kind: "scenario", key: "cafe" }], ["DELETE", { kind: "scenario", key: "cafe" }]]) {
    assert.equal((await anon.call(m, "/api/hidden-scenes", body)).status, 401, m);
  }
  const sam = await someone();
  const spanish = sam.languageId;
  await sam.addLanguage({ target_language: "German", level: "A1" });
  // A second tab still showing Spanish.
  const old = tab(base, sam);
  old.languageId = spanish;
  const r = await old.call("POST", "/api/hidden-scenes", { kind: "scenario", key: "cafe" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "stale_learner");
  assert.equal((await old.call("GET", "/api/hidden-scenes")).status, 409);
  assert.equal((await old.call("DELETE", "/api/hidden-scenes", { kind: "scenario", key: "cafe" })).status, 409);
  assert.equal((await q("select count(*)::int as n from hidden_scenes where language_profile_id = $1", [spanish]))[0].n, 0);
});

test("a malformed body is a 400; an unknown scene id is still stored", async () => {
  const sam = await someone();
  for (const body of [{}, { kind: "folder", key: "x" }, { kind: "scenario", key: 3 }, { kind: "scenario", key: "" }, { kind: "collection", key: "x".repeat(201) }, [1]]) {
    const r = await sam.call("POST", "/api/hidden-scenes", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await sam.call("DELETE", "/api/hidden-scenes", body)).status, 400, `DELETE ${JSON.stringify(body)}`);
  }
  assert.equal((await sam.call("POST", "/api/hidden-scenes", "not json")).status, 400);
  assert.equal((await sam.call("PUT", "/api/hidden-scenes", { kind: "scenario", key: "x" })).status, 405);
  assert.equal((await sam.call("GET", "/api/hidden-scenes/extra")).status, 404);
  assert.equal((await sam.call("POST", "/api/hidden-scenes", { kind: "collection", key: "Daily life " })).status, 400, "edge spaces");
  const gone = await sam.call("POST", "/api/hidden-scenes", { kind: "scenario", key: "removed-from-the-library" });
  assert.equal(gone.status, 201, gone.text);
});

test("hide is idempotent, unhide deletes the row, and the language is the session's, never the body's", async () => {
  const sam = await someone();
  const made = await sam.call("POST", "/api/hidden-scenes", { kind: "collection", key: "Travel essentials", languageProfileId: "00000000-0000-0000-0000-000000000000" });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual([made.body.created, made.body.hidden.kind, made.body.hidden.key], [true, "collection", "Travel essentials"]);
  const again = await sam.call("POST", "/api/hidden-scenes", { kind: "collection", key: "Travel essentials" });
  assert.deepEqual([again.status, again.body.created, again.body.hidden.hiddenAt], [200, false, made.body.hidden.hiddenAt]);
  await sam.call("POST", "/api/hidden-scenes", { kind: "scenario", key: "cafe" });
  assert.deepEqual(keys(await sam.call("GET", "/api/hidden-scenes")), ["collection:Travel essentials", "scenario:cafe"]);
  const [row] = await q("select language_profile_id from hidden_scenes where key = 'cafe'");
  assert.equal(row.language_profile_id, sam.languageId);

  // Another learner's page can't see or remove them.
  const ana = await someone({ ...ADULT, name: "Ana" });
  assert.deepEqual(keys(await ana.call("GET", "/api/hidden-scenes")), []);
  assert.deepEqual((await ana.call("DELETE", "/api/hidden-scenes", { kind: "scenario", key: "cafe" })).body, { unhidden: false });
  // Nor Sam's own other language.
  await sam.addLanguage({ target_language: "German", level: "A1" });
  assert.deepEqual(keys(await sam.call("GET", "/api/hidden-scenes")), []);
  assert.deepEqual((await sam.call("DELETE", "/api/hidden-scenes", { kind: "scenario", key: "cafe" })).body, { unhidden: false });
  await sam.pickLanguage("Spanish");
  const un = await sam.call("DELETE", "/api/hidden-scenes", { kind: "scenario", key: "cafe" });
  assert.deepEqual([un.status, un.body], [200, { unhidden: true }]);
  assert.deepEqual(keys(await sam.call("GET", "/api/hidden-scenes")), ["collection:Travel essentials"]);
});

test("a session's random draw and an export leave hidden scenes and folders out; a hidden scene picked by name still plays", async () => {
  const sam = await someone();
  await sam.call("POST", "/api/hidden-scenes", { kind: "collection", key: "Travel essentials" });
  await sam.call("POST", "/api/hidden-scenes", { kind: "scenario", key: "market" });
  // Spanish without hides: market, plaza, cafe, taxi, hotel. Left: plaza, cafe.
  const drawn = new Set();
  for (const r of [0, 0.5, 0.99, 0.2, 0.7, 0.1]) {
    useSceneRandom(() => r);
    const c = await sam.call("POST", "/api/conversations", { mode: "adult", pack: randomPack(), title: "Random" });
    assert.equal(c.status, 201, c.text);
    drawn.add(c.body.conversation.scenarioId);
    const [row] = await q("select pack_snapshot from conversations where id = $1", [c.body.conversation.id]);
    assert.deepEqual([...row.pack_snapshot.random_draw.pool].sort(), ["cafe", "plaza"]);
  }
  assert.deepEqual([...drawn].sort(), ["cafe", "plaza"]);
  const ex = await sam.call("POST", "/api/export", { pack: randomPack(), id: "hidden-check" });
  assert.equal(ex.status, 200, ex.text);
  assert.equal(ex.body.drawn.pool, 2);
  // Picked by name, a hidden scene is no different.
  const taxi = await sam.call("POST", "/api/conversations", { mode: "adult", pack: libraryPack("taxi"), title: "Taxi" });
  assert.equal(taxi.status, 201, taxi.text);
  assert.equal(taxi.body.conversation.scenarioId, "taxi");
  // The preview never draws, so hides don't change it.
  assert.equal((await sam.call("POST", "/api/assemble", { pack: libraryPack("taxi") })).status, 200);
});

test("a pool emptied only by hides says so; one empty anyway keeps the old message", async () => {
  const sam = await someone();
  await sam.call("POST", "/api/hidden-scenes", { kind: "collection", key: "Travel essentials" });
  const r = await sam.call("POST", "/api/conversations", { mode: "adult", pack: randomPack(["Travel essentials"]), title: "Random" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /is hidden\. Restore some/);
  const ex = await sam.call("POST", "/api/export", { pack: randomPack(["Travel essentials"]), id: "hidden-empty" });
  assert.equal(ex.status, 400);
  assert.match(ex.body.error, /is hidden/);
  const gone = await sam.call("POST", "/api/conversations", { mode: "adult", pack: randomPack(["Gone"]), title: "Random" });
  assert.equal(gone.status, 400);
  assert.doesNotMatch(gone.body.error, /hidden/);
  // Restored, it draws again.
  await sam.call("DELETE", "/api/hidden-scenes", { kind: "collection", key: "Travel essentials" });
  assert.equal((await sam.call("POST", "/api/conversations", { mode: "adult", pack: randomPack(["Travel essentials"]), title: "Random" })).status, 201);
});

test("past the per-language cap a hide is a 409 that says why", async () => {
  const sam = await someone();
  const [{ learner_id }] = await q("select learner_id from language_profiles where id = $1", [sam.languageId]);
  await q(`insert into hidden_scenes (learner_id, language_profile_id, kind, key) select $1, $2, 'scenario', 's' || g from generate_series(1, 500) g`, [learner_id, sam.languageId]);
  const r = await sam.call("POST", "/api/hidden-scenes", { kind: "scenario", key: "cafe" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /at most 500/);
  assert.equal((await sam.call("POST", "/api/hidden-scenes", { kind: "scenario", key: "s7" })).status, 200);
});
