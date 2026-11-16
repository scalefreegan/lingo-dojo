// The random scene end to end over HTTP (docs/CONTENT.md "Random scene"):
// saved packs that hold one, the preview that doesn't draw, the draw when a
// conversation is made (pool, recent avoidance, snapshot, phrase bank), the
// voice turn that plays the drawn scene and never redraws, the export that
// draws its own, and the kids library kept apart. On the real plugin with
// an in-process PGlite and a stand-in `claude` first on PATH, so nothing
// real is spawned and no provider is reachable. Every name here is made up.
//   node --test scripts/tests/random-scene.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture, write } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-exports-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_EXPORTS_DIR = exportsDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

// Codes, so a scene written for one language is out of another's pool.
write(
  root,
  "languages.yaml",
  [
    "version: 1",
    "languages:",
    "  - { name: English, code: en, variants: [] }",
    "  - { name: Spanish, code: es, variants: [Mexican Spanish] }",
    "  - { name: German, code: de, variants: [Standard German (Germany)] }",
    "  - { name: Japanese, code: ja, variants: [] }",
  ].join("\n"),
);
// The fixture has market (es-MX) and plaza (every language), in no collection.
const scene = (id, title, extra) => ["---", `id: ${id}`, `title: ${title}`, `summary: ${title}, briefly.`, ...extra, "---", `${title} body.`].join("\n");
write(root, "scenarios/cafe.md", scene("cafe", "Coffee on the corner", ["collection: Daily life", "beats: [Ordering, Paying]", "phrases:", "  - A coffee with milk, please", "  - Keep the change"]));
write(root, "scenarios/taxi.md", scene("taxi", "Taxi across town", ["collection: Travel essentials", "roles:", "  dojo_master: a driver who knows {{location}} well"]));
write(root, "scenarios/hotel.md", scene("hotel", "Checking in", ["collection: Travel essentials"]));
write(root, "scenarios/sushi.md", scene("sushi", "Sushi counter", ["language: ja-JP", "collection: Tokyo trip"]));
// The kids library: farm (de-DE, "German") and one more.
write(root, "kids/scenarios/park.md", scene("park", "At the park", ["collection: Playtime"]));

const { apiPlugins } = await import("../../web/server/api.ts");
const { useSceneRandom } = await import("../../web/server/randomScene.ts");

const fake = fakeClaude();
const REPLY = ["NARRATOR-F: Hola.", "STAGE: scene"].join("\n");

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
  fake.answer(REPLY);
  useSceneRandom(null);
});

let n = 0;
/** A fresh account with one learner, logged in and picked. */
async function someone(learner = ADULT) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners: [learner] });
  const c = client(base);
  await c.login(name);
  await c.pick(learner.name);
  return c;
}

const randomPack = (collections = [], extra = {}) => ({
  title: "", created: "", scenario: "", quick_scenario: "", random_scene: { collections }, units: [], overrides: {}, notes: "", ...extra,
});
const libraryPack = (scenario) => ({ title: "", created: "", scenario, quick_scenario: "", units: [], overrides: {}, notes: "" });

async function start(who, pack, extra = {}, mode = "adult") {
  const r = await who.call("POST", "/api/conversations", { mode, pack, title: "Random scene", ...extra });
  assert.equal(r.status, 201, r.text);
  return r.body.conversation;
}
const snapshot = async (id) => (await q("select pack_snapshot, scenario_id, title from conversations where id = $1", [id]))[0];
const turn = (who, conversationId, pack, mode = "adult") =>
  who.call("POST", "/api/voice/turn", { mode, pack, history: [], message: "", elapsedMs: 0, ...(conversationId ? { conversationId } : {}) });
const prompt = () => JSON.stringify(fake.lastArgs());

test("a saved pack holds a random scene and its pool: save, load, revise and restore keep it; a scene sent with it is cleared", async () => {
  const sam = await someone();
  const id = "2026-11-16-surprise-me";
  const put = await sam.call("PUT", `/api/packs/${id}`, { ...randomPack(["Daily life", " Daily life", "Gone"]), title: "Surprise me", scenario: "market", quick_scenario: "typed" });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(
    [put.body.pack.random_scene, put.body.pack.scenario, put.body.pack.quick_scenario],
    [{ collections: ["Daily life", "Gone"] }, "", ""],
    "trimmed, de-duplicated, an unknown name kept (ignored when drawing); a random pack names no scene of its own",
  );
  const [row] = await q("select random_scene, scenario from packs where slug = $1", [id]);
  assert.deepEqual(row, { random_scene: { collections: ["Daily life", "Gone"] }, scenario: "" });
  assert.deepEqual((await sam.call("GET", `/api/packs/${id}`)).body.pack.random_scene, { collections: ["Daily life", "Gone"] });
  assert.deepEqual((await sam.call("GET", "/api/packs")).body.packs.map((p) => p.random_scene), [{ collections: ["Daily life", "Gone"] }]);

  // Saved as a library scene, then undone back to the random one.
  const lib = await sam.call("PUT", `/api/packs/${id}`, { ...libraryPack("plaza"), title: "Surprise me" });
  assert.deepEqual([lib.body.pack.random_scene, lib.body.pack.scenario], [null, "plaza"]);
  const revs = (await sam.call("GET", `/api/pack-revisions?id=${id}`)).body.revisions;
  assert.deepEqual(revs.map((r) => [r.action, r.pack.random_scene]), [["update", null], ["create", { collections: ["Daily life", "Gone"] }]]);
  const restored = await sam.call("POST", `/api/pack-revisions/${revs[1].revision}/restore`);
  assert.equal(restored.status, 200, restored.text);
  assert.deepEqual([restored.body.pack.random_scene, restored.body.pack.scenario], [{ collections: ["Daily life", "Gone"] }, ""]);
  // All of the library: an empty list, kept as such.
  const everything = await sam.call("PUT", "/api/packs/2026-11-16-anything", { ...randomPack(), title: "Anything" });
  assert.deepEqual(everything.body.pack.random_scene, { collections: [] });
});

test("a malformed pool is a 400 everywhere a pack arrives, and nothing is written", async () => {
  const sam = await someone();
  const bad = [
    "everything",
    true,
    { collections: "Daily life" },
    { collections: [7] },
    { collections: Array.from({ length: 51 }, (_, i) => `c${i}`) },
    { collections: ["x".repeat(121)] },
    { collections: ["Daily life", "   "] },
  ];
  for (const random_scene of bad) {
    const pack = { ...randomPack(), random_scene };
    const label = JSON.stringify(random_scene).slice(0, 40);
    assert.equal((await sam.call("PUT", "/api/packs/2026-11-16-bad", { ...pack, title: "Bad" })).status, 400, `save ${label}`);
    assert.equal((await sam.call("POST", "/api/assemble", { pack })).status, 400, `assemble ${label}`);
    assert.equal((await sam.call("POST", "/api/export", { pack, id: "bad" })).status, 400, `export ${label}`);
    assert.equal((await sam.call("POST", "/api/conversations", { mode: "adult", pack })).status, 400, `start ${label}`);
    assert.equal((await turn(sam, null, pack)).status, 400, `turn ${label}`);
  }
  const r = await sam.call("POST", "/api/assemble", { pack: { ...randomPack(), random_scene: { collections: [1] } } });
  assert.match(r.body.error, /random_scene\.collections must hold only collection names/);
  assert.equal((await q("select count(*)::int as n from packs where slug = '2026-11-16-bad'"))[0].n, 0);
  assert.equal((await q("select count(*)::int as n from conversations c join learners l on l.id = c.learner_id join users u on u.id = l.user_id where u.username = $1", [`user${n}`]))[0].n, 0);
  assert.ok(!fs.existsSync(path.join(exportsDir, "bad.md")));
});

test("the preview never draws: assemble shows the placeholder and the pool's size, and makes no conversation", async () => {
  const sam = await someone();
  const conversationsBefore = (await q("select count(*)::int as n from conversations"))[0].n;
  const r = await sam.call("POST", "/api/assemble", { pack: randomPack() });
  assert.equal(r.status, 200, r.text);
  // Spanish: market, plaza, cafe, taxi, hotel (sushi is Japanese only).
  assert.match(r.body.markdown, /^# Lingo Dojo session: Random scene$/m);
  assert.match(r.body.markdown, /one of the 5 scenes in its pool is drawn when the session starts/);
  assert.deepEqual(r.body.warnings.filter((w) => /scen/i.test(w)), [], "a random scene isn't a missing one");
  const empty = await sam.call("POST", "/api/assemble", { pack: randomPack(["Tokyo trip"]) });
  assert.equal(empty.status, 200, "an empty pool doesn't fail the preview");
  assert.ok(empty.body.warnings.some((w) => /pool is empty/.test(w)));
  assert.equal((await q("select count(*)::int as n from conversations"))[0].n, conversationsBefore);
});

test("starting a session draws from the pool, records the draw in the snapshot, names the conversation after the scene and adds its phrases", async () => {
  const sam = await someone();
  const c = await start(sam, randomPack(["Daily life", "Gone"], { overrides: { minutes: 10 } }));
  assert.deepEqual([c.scenarioId, c.randomScene, c.title, c.plannedMinutes], ["cafe", true, "Coffee on the corner", 10]);
  const row = await snapshot(c.id);
  assert.equal(row.scenario_id, "cafe");
  const { review, ...pack } = row.pack_snapshot;
  assert.ok(review);
  assert.deepEqual(pack, {
    ...randomPack(["Daily life", "Gone"], { overrides: { minutes: 10 } }),
    scenario: "cafe",
    random_scene: null,
    random_draw: { collections: ["Daily life", "Gone"], pool: ["cafe"], drawn: "cafe" },
  });
  // The scene's English phrases went into the bank as pending ones.
  const bank = (await sam.call("GET", "/api/phrases")).body.phrases;
  assert.deepEqual(bank.map((p) => p.meaning).sort(), ["A coffee with milk, please", "Keep the change"]);
  // History lists it as random.
  const listed = (await sam.call("GET", "/api/conversations")).body.conversations[0];
  assert.deepEqual([listed.id, listed.randomScene, listed.scenarioId], [c.id, true, "cafe"]);
  // A picked scene is not random; a client's own random_draw is not kept.
  const picked = await start(sam, { ...libraryPack("plaza"), random_draw: { drawn: "x" } }, { title: "Plaza" });
  assert.equal(picked.randomScene, false);
  assert.equal((await snapshot(picked.id)).pack_snapshot.random_draw, undefined);
});

test("a draw steers clear of the language's most recent scenes: a pool of two alternates, a pool of one still draws", async () => {
  const sam = await someone();
  const travel = randomPack(["Travel essentials"]); // taxi, hotel
  // Whatever the random source says, the scene just played is avoided.
  await start(sam, libraryPack("taxi"), { title: "Taxi" });
  for (const r of [0, 0.99, 0.5]) {
    useSceneRandom(() => r);
    await start(sam, travel);
  }
  const drawn = (await q(
    "select scenario_id from conversations c join learners l on l.id = c.learner_id join users u on u.id = l.user_id where u.username = $1 order by started_at",
    [`user${n}`],
  )).map((x) => x.scenario_id);
  assert.deepEqual(drawn, ["taxi", "hotel", "taxi", "hotel"], "each draw avoids the one before");
  // A pool of one draws its scene every time.
  useSceneRandom(() => 0.3);
  for (let i = 0; i < 2; i++) assert.equal((await start(sam, randomPack(["Daily life"]))).scenarioId, "cafe");
});

test("recent avoidance counts the last min(5, pool - 1) distinct scenes, newest first", async () => {
  const sam = await someone();
  // Newest last: hotel is the oldest of the five.
  for (const s of ["hotel", "taxi", "cafe", "plaza", "market"]) await start(sam, libraryPack(s), { title: s });
  // Pool of five (Spanish): four avoided (market, plaza, cafe, taxi), so hotel.
  for (const r of [0, 0.5, 0.99]) {
    useSceneRandom(() => r);
    assert.equal((await start(sam, randomPack())).scenarioId, "hotel");
    // That draw is now the newest: drop it again so the history stays the same.
    await q("delete from conversations where id = (select id from conversations order by started_at desc limit 1)");
  }
});

test("the voice turn plays the drawn scene, every turn, and never redraws", async () => {
  const sam = await someone();
  useSceneRandom(() => 0);
  const c = await start(sam, randomPack(["Travel essentials"], { overrides: { location: "Lyon" } }));
  const first = c.scenarioId;
  const title = first === "taxi" ? "Taxi across town" : "Checking in";
  // Turns send the draft as it is: still random. The source now says otherwise.
  useSceneRandom(() => 0.99);
  for (let i = 0; i < 2; i++) {
    const r = await turn(sam, c.id, randomPack(["Travel essentials"], { overrides: { location: "Lyon" } }));
    assert.equal(r.status, 200, r.text);
    assert.ok(prompt().includes(`# Lingo Dojo session: ${title}`), "the prompt is the drawn scene's");
    assert.ok(!prompt().includes("Random scene"));
    assert.equal(r.body.saved, true);
  }
  // {{location}} works for a drawn scene as for a picked one.
  if (first === "taxi") assert.ok(prompt().includes("a driver who knows Lyon well"));
  const after2 = await snapshot(c.id);
  assert.equal(after2.scenario_id, first);
  assert.equal(after2.pack_snapshot.random_draw.drawn, first);
  // Reading it back (a reload, History) says the same scene.
  const got = (await sam.call("GET", `/api/conversations/${c.id}`)).body;
  assert.deepEqual([got.conversation.scenarioId, got.conversation.randomScene], [first, true]);
});

test("a random scene can't play without its conversation's draw: no conversation, or one started with another scene, is a 409", async () => {
  const sam = await someone();
  const runsBefore = fake.runs();
  const none = await turn(sam, null, randomPack());
  assert.equal(none.status, 409);
  assert.match(none.body.error, /No scene has been drawn for this random scene yet/);
  const picked = await start(sam, libraryPack("plaza"), { title: "Plaza" });
  const other = await turn(sam, picked.id, randomPack());
  assert.equal(other.status, 409);
  assert.match(other.body.error, /started with another scene/);
  assert.equal(fake.runs(), runsBefore, "refused before the dojo master was asked");
});

test("a later conversation of the same session keeps the scene it drew while it is in the pool, else draws afresh", async () => {
  const sam = await someone();
  const kept = await start(sam, randomPack(["Travel essentials"]), { drawn: "hotel" });
  assert.equal(kept.scenarioId, "hotel");
  assert.equal((await snapshot(kept.id)).pack_snapshot.random_draw.kept, true);
  const fresh = await start(sam, randomPack(["Daily life"]), { drawn: "sushi" });
  assert.equal(fresh.scenarioId, "cafe", "sushi isn't in the pool: drawn afresh");
  assert.equal((await snapshot(fresh.id)).pack_snapshot.random_draw.kept, undefined);
});

test("a kept scene no longer in the pool draws afresh and still steers clear of recent scenes", async () => {
  const sam = await someone();
  await start(sam, libraryPack("taxi"), { title: "Taxi" });
  // Travel essentials: taxi and hotel. Whatever the source says, and with a
  // `drawn` that isn't in the pool, the scene just played is avoided.
  for (const r of [0, 0.99]) {
    useSceneRandom(() => r);
    const c = await start(sam, randomPack(["Travel essentials"]), { drawn: "cafe" });
    assert.equal(c.scenarioId, "hotel", `rand ${r}`);
    assert.equal((await snapshot(c.id)).pack_snapshot.random_draw.kept, undefined);
    await q("delete from conversations where id = $1", [c.id]);
  }
});

test("recent scenes are the language's own: the learner's other language doesn't count", async () => {
  const sam = await someone();
  const spanish = sam.languageId;
  await sam.addLanguage({ target_language: "German", target_variant: "Standard German (Germany)", level: "A1" });
  // German played taxi (twice, to be sure); Spanish has played nothing.
  for (let i = 0; i < 2; i++) await start(sam, libraryPack("taxi"), { title: "Taxi" });
  await sam.pickLanguage(spanish);
  const seen = new Set();
  for (const r of [0, 0.99]) {
    useSceneRandom(() => r);
    const c = await start(sam, randomPack(["Travel essentials"]));
    seen.add(c.scenarioId);
    await q("delete from conversations where id = $1", [c.id]);
  }
  assert.deepEqual([...seen].sort(), ["hotel", "taxi"], "taxi isn't avoided in Spanish");
  // In German it is.
  await sam.pickLanguage("German");
  for (const r of [0, 0.99]) {
    useSceneRandom(() => r);
    const c = await start(sam, randomPack(["Travel essentials"]));
    assert.equal(c.scenarioId, "hotel", `rand ${r}`);
    await q("delete from conversations where id = $1", [c.id]);
  }
});

test("an unsaved turn sends the session's drawn scene in place, and plays it like a picked one", async () => {
  const sam = await someone();
  const { unsavedTurnPack } = await import("../../web/shared/scenes.ts");
  const pack = unsavedTurnPack(randomPack(["Travel essentials"]), "hotel");
  const r = await turn(sam, null, pack);
  assert.equal(r.status, 200, r.text);
  assert.ok(prompt().includes("# Lingo Dojo session: Checking in"));
  assert.equal((await sam.call("GET", "/api/conversations")).body.conversations.length, 0, "nothing saved, nothing drawn");
});

test("an empty pool refuses to start, with the reason, and makes no conversation", async () => {
  const sam = await someone();
  for (const collections of [["Tokyo trip"], ["Gone"]]) {
    const r = await sam.call("POST", "/api/conversations", { mode: "adult", pack: randomPack(collections) });
    assert.equal(r.status, 400, r.text);
    assert.match(r.body.error, /The random scene's pool is empty: none of the chosen collections has scenes that fit Spanish/);
  }
  assert.equal((await sam.call("GET", "/api/conversations")).body.conversations.length, 0);
});

test("an export draws its own scene, says which, and writes that scene's prompt; an empty pool writes nothing", async () => {
  const sam = await someone();
  const r = await sam.call("POST", "/api/export", { pack: randomPack(["Travel essentials"]), id: "random-export" });
  assert.equal(r.status, 200, r.text);
  assert.ok(["taxi", "hotel"].includes(r.body.drawn.id));
  assert.equal(r.body.drawn.pool, 2);
  const md = fs.readFileSync(r.body.path, "utf8");
  assert.ok(md.startsWith(`# Lingo Dojo session: ${r.body.drawn.title}\n`));
  // A pack that isn't random says nothing about a draw.
  const plain = await sam.call("POST", "/api/export", { pack: libraryPack("plaza"), id: "plain-export" });
  assert.equal(plain.body.drawn, undefined);
  const empty = await sam.call("POST", "/api/export", { pack: randomPack(["Gone"]), id: "empty-export" });
  assert.equal(empty.status, 400);
  assert.ok(!fs.existsSync(path.join(exportsDir, "empty-export.md")));
  // An export is not a session: no conversation.
  assert.equal((await sam.call("GET", "/api/conversations")).body.conversations.length, 0);
});

test("kids: the pool is the kids library's scenes for the kid's language, never the adult library's", async () => {
  const pip = await someone(KID);
  const seen = new Set();
  for (const r of [0, 0.3, 0.6, 0.99, 0, 0.5]) {
    useSceneRandom(() => r);
    const c = await start(pip, { ...randomPack(), units: ["intro-game"] }, {}, "kids");
    seen.add(c.scenarioId);
    assert.equal(c.mode, "kids");
  }
  assert.deepEqual([...seen].sort(), ["farm", "park"], "German: the farm (de-DE) and the park; no adult scene");
  const narrowed = await start(pip, randomPack(["Playtime"]), {}, "kids");
  assert.equal(narrowed.scenarioId, "park");
  // An adult collection's name means nothing in the kids library.
  const r = await pip.call("POST", "/api/conversations", { mode: "kids", pack: randomPack(["Daily life"]) });
  assert.equal(r.status, 400);
  const preview = await pip.call("POST", "/api/assemble", { mode: "kids", pack: randomPack() });
  assert.match(preview.body.markdown, /one of the 2 scenes in its pool/);
});
