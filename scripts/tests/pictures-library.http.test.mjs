// The picture game for adult learners and the picture library page (bead
// ld-318; docs/DATA.md §Kids word game, §Stock pictures): an adult plays
// the game through the same answer path (a listen review, replay and stale
// rules) and sees the word after the tap, a kid never does; "My word
// pictures" lists the active language's words only; the shared stock set is
// browsed by any logged-in user and changed only by an admin (403 for
// everyone else on every write); a concept added from the page lives in
// the database, merges into the stock list and reaches the picturable
// check; a concept of content/pictures.yaml can't be deleted; stock draws
// are queued, each in the ledger as it starts, under an install-wide cap.
// The real plugin on an in-process PGlite with a stand-in `claude` and the
// stub image provider (placeholder PNGs): nothing here reaches a model or a
// provider. Every name here is made up.
//   node --test scripts/tests/pictures-library.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
const imagesDir = path.join(dataDir, "images");
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
fs.writeFileSync(process.env.LINGO_ENV_FILE, "");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "OPENAI_API_KEY", "BFL_API_KEY", "LINGO_IMAGES_DIR"]) delete process.env[k];
process.env.LINGO_IMAGE_PROVIDER = "stub";

const { apiPlugins } = await import("../../web/server/api.ts");
const { resetPictureMemory, settlePictureFills } = await import("../../web/server/pictures.ts");
const { resetStockMemory, settleStockDraws } = await import("../../web/server/stockPictures.ts");
const { settleExtractions } = await import("../../web/server/extraction.ts");
const { PICTURE_DAILY_STOCK, PICTURE_THEME } = await import("../pictures.mjs");
const { writeStockPicture } = await import("../picture-store.mjs");

const fake = fakeClaude();
const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  await settlePictureFills();
  await settleStockDraws();
  await settleExtractions();
  fake.restore();
  await close();
  await testDb.close();
});
beforeEach(async () => {
  await settlePictureFills();
  await settleStockDraws();
  resetPictureMemory();
  resetStockMemory();
  process.env.LINGO_IMAGE_PROVIDER = "stub";
  fake.picture("!auto");
  await q("delete from picture_stock_concepts");
  await q("delete from picture_stock_calls");
  fs.writeFileSync(
    path.join(root, "pictures.yaml"),
    ["categories:", "  Animals:", "    - { id: dog, description: a friendly brown dog, words: [dog, puppy] }", "    - { id: cat, description: a fluffy orange cat, words: [cat, kitten] }", ""].join("\n"),
  );
  fs.rmSync(path.join(imagesDir, "stock"), { recursive: true, force: true });
});

let n = 0;
async function someone(learners = [ADULT], { admin = false } = {}) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { admin, learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  return c;
}
async function add(who, pairs) {
  const out = {};
  for (const [text, meaning] of pairs) {
    const r = await who.call("POST", "/api/phrases", { text, meaning, starred: false });
    assert.equal(r.status, 201, r.text);
    out[text] = r.body.phrase;
  }
  return out;
}
async function drawAll(who) {
  const r = await who.call("POST", "/api/pictures/fill");
  await settlePictureFills();
  return r;
}
const tap = (who, round, pictureId, submitId = crypto.randomUUID()) =>
  who.call("POST", "/api/game/answer", { phraseId: round.phraseId, version: round.version, revision: round.revision, submitId, pictureId, tz: 0 });
const stockFile = (id) => path.join(imagesDir, "stock", PICTURE_THEME.id, `${id}.png`);
const stockFiles = () => {
  const d = path.join(imagesDir, "stock", PICTURE_THEME.id);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => !f.startsWith(".")).sort() : [];
};
const WORDS = [["el sol", "sun"], ["la casa", "house"], ["el árbol", "tree"], ["hola", "hello"]];

/* ------------------------------- the adult game ------------------------------ */

test("an adult plays the picture game: rounds from ready pictures, a tap is a listen review, the word shown after it", async () => {
  const sam = await someone([ADULT]);
  const p = await add(sam, WORDS);
  assert.equal((await drawAll(sam)).status, 202);
  const st = (await sam.call("GET", "/api/game")).body.status;
  assert.deepEqual([st.pictured, st.ready, st.imagesToday, st.imagesCap], [3, true, 3, 200]);
  const r = await sam.call("POST", "/api/game/start");
  assert.equal(r.status, 200, r.text);
  const { rounds } = r.body;
  assert.equal(rounds.length, 3);
  assert.doesNotMatch(r.text, /sol|casa|árbol|sun|house|tree/, "the round itself carries no words, for adults too");
  const rows = await q("select id, phrase_id from phrase_pictures where language_profile_id = $1 and status = 'ready'", [sam.languageId]);
  const pictureOf = new Map(rows.map((x) => [x.phrase_id, x.id]));
  const [one, two] = rounds;
  const right = await tap(sam, one, pictureOf.get(one.phraseId));
  assert.equal(right.status, 200, right.text);
  const word = Object.values(p).find((x) => x.id === one.phraseId);
  assert.deepEqual(right.body, { right: true, pictureId: pictureOf.get(one.phraseId), replayed: false, word: { text: word.text, meaning: word.meaning } });
  const wrongPick = two.choices.find((c) => c.id !== pictureOf.get(two.phraseId)).id;
  const wrong = await tap(sam, two, wrongPick);
  assert.equal(wrong.body.right, false);
  const reviews = await q(
    "select r.mode, r.rating, r.verdict, c.skill, c.phrase_id from reviews r join cards c on c.id = r.card_id where r.language_profile_id = $1 order by r.id",
    [sam.languageId],
  );
  assert.deepEqual(reviews.map((x) => [x.mode, x.rating, x.verdict, x.skill, x.phrase_id]), [
    ["picture", 3, "exact", "listen", one.phraseId],
    ["picture", 1, "wrong", "listen", two.phraseId],
  ]);
});

test("an adult's tap: a resend replays, another answer at that version and an edited word are 409s, nothing recorded twice", async () => {
  const sam = await someone([ADULT]);
  const p = await add(sam, WORDS);
  await drawAll(sam);
  const [one, two] = (await sam.call("POST", "/api/game/start")).body.rounds;
  const submitId = crypto.randomUUID();
  const first = await tap(sam, one, one.choices[0].id, submitId);
  assert.equal(first.status, 200, first.text);
  const again = await tap(sam, one, one.choices[0].id, submitId);
  assert.deepEqual(again.body, { ...first.body, replayed: true });
  assert.equal((await tap(sam, one, one.choices[0].id)).status, 409, "a new submit at the old version is stale");
  const edited = Object.values(p).find((x) => x.id === two.phraseId);
  assert.equal((await sam.call("PATCH", `/api/phrases/${edited.id}`, { meaning: `${edited.meaning}!` })).status, 200);
  assert.equal((await tap(sam, two, two.choices[0].id)).status, 409);
  const [{ n: count }] = await q("select count(*)::int as n from reviews where language_profile_id = $1", [sam.languageId]);
  assert.equal(count, 1);
});

test("a kids learner's tap never carries the word; the kid still can't reach the adult drills", async () => {
  const pip = await someone([KID]);
  const p = await add(pip, [["der Hund", "dog"], ["die Katze", "cat"], ["der Ball", "ball"]]);
  await drawAll(pip);
  const [one] = (await pip.call("POST", "/api/game/start")).body.rounds;
  const r = await tap(pip, one, one.choices[0].id);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.body).sort(), ["pictureId", "replayed", "right"]);
  for (const [m, url] of [["GET", "/api/practice"], ["GET", "/api/practice/queue"], ["POST", "/api/practice/answer"], ["GET", `/api/practice/audio/${p["der Hund"].id}`]]) {
    assert.equal((await pip.call(m, url, m === "POST" ? {} : undefined)).status, 403, `${m} ${url}`);
  }
});

/* ------------------------------- my word pictures ----------------------------- */

test("My word pictures: the active language's words with a verdict, newest first; another account's session reads none of them", async () => {
  const sam = await someone([ADULT]);
  await add(sam, WORDS);
  await drawAll(sam);
  const r = await sam.call("GET", "/api/pictures/words");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.words.map((w) => [w.text, w.picture.status]), [["hola", "none"], ["el árbol", "ready"], ["la casa", "ready"], ["el sol", "ready"]]);
  assert.equal(r.body.status.imagesToday, 3);

  // Another account: its own (empty) list, and none of Sam's pictures by URL.
  const kim = await someone([ADULT]);
  assert.deepEqual((await kim.call("GET", "/api/pictures/words")).body.words, []);
  const mine = r.body.words.find((w) => w.picture.status === "ready").picture;
  assert.equal((await sam.call("GET", `/api/game/pictures/${mine.id}/${mine.file}`)).status, 200);
  assert.equal((await kim.call("GET", `/api/game/pictures/${mine.id}/${mine.file}`)).status, 404);
  assert.equal((await kim.call("GET", `/api/pictures/phrase/${r.body.words[0].phraseId}`)).status, 404);
  // Sam's page showing on Kim's session: the stale-learner check, not Sam's words.
  const forged = client(base, kim.jar);
  forged.learnerId = sam.learnerId;
  forged.languageId = sam.languageId;
  assert.equal((await forged.call("GET", "/api/pictures/words")).status, 409);
});

/* ------------------------------- the stock library ---------------------------- */

const WRITES = (id = "dog") => [
  ["POST", "/api/stock-pictures/admin/concepts", { name: "ice cream", category: "Food", description: "a cone of ice cream", words: "ice cream" }],
  ["POST", "/api/stock-pictures/admin/missing", { count: 2 }],
  ["POST", `/api/stock-pictures/admin/${id}/draw`, {}],
  ["POST", `/api/stock-pictures/admin/${id}/remove`, {}],
];

test("the stock set: any logged-in user browses it; every write is a 403 for a non-admin, a 401 logged out", async () => {
  const sam = await someone([ADULT]);
  const pip = await someone([KID]);
  for (const who of [sam, pip]) {
    const r = await who.call("GET", "/api/stock-pictures");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.concepts.map((c) => [c.id, c.custom, c.version]), [["dog", false, null], ["cat", false, null]]);
    assert.equal(r.body.canEdit, false);
    for (const [m, url, body] of WRITES()) assert.equal((await who.call(m, url, body)).status, 403, `${m} ${url}`);
  }
  const out = client(base);
  assert.equal((await out.call("GET", "/api/stock-pictures")).status, 401);
  for (const [m, url, body] of WRITES()) assert.equal((await out.call(m, url, body)).status, 401, `${m} ${url}`);
  await settleStockDraws();
  assert.deepEqual(stockFiles(), [], "nothing was drawn");
  assert.deepEqual(await q("select id from picture_stock_concepts"), []);
  assert.deepEqual(await q("select id from picture_stock_calls"), []);
});

test("an admin draws every missing stock picture (after confirming the count), each in the ledger as it starts; the file is served to a logged-in user", async () => {
  const ada = await someone([ADULT], { admin: true });
  const list = (await ada.call("GET", "/api/stock-pictures")).body;
  assert.equal(list.canEdit, true);
  assert.equal(list.costEach, 0.008);
  assert.equal((await ada.call("POST", "/api/stock-pictures/admin/missing", { count: 5 })).status, 409, "a count the page didn't show");
  const r = await ada.call("POST", "/api/stock-pictures/admin/missing", { count: 2 });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.body.queued, 2);
  await settleStockDraws();
  assert.deepEqual(stockFiles(), ["cat.png", "dog.png"]);
  assert.deepEqual((await q("select concept_id, outcome from picture_stock_calls order by concept_id")).map((x) => [x.concept_id, x.outcome]), [["cat", "ok"], ["dog", "ok"]]);
  const after = (await ada.call("GET", "/api/stock-pictures")).body;
  assert.equal(after.usedToday, 2);
  const dog = after.concepts.find((c) => c.id === "dog");
  assert.ok(dog.version);
  // Served to any logged-in user (a kid's session too), by its version.
  const pip = await someone([KID]);
  const f = await pip.call("GET", `/api/stock-pictures/file/dog/${dog.version}`);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get("content-type"), "image/png");
  assert.match(f.headers.get("cache-control"), /^private/);
  assert.equal((await pip.call("GET", `/api/stock-pictures/file/dog/old-version`)).status, 404);
  assert.equal((await pip.call("GET", `/api/stock-pictures/file/..%2Fdog/${dog.version}`)).status, 404);
  assert.equal((await client(base).call("GET", `/api/stock-pictures/file/dog/${dog.version}`)).status, 401);
  // Nothing left to draw: a second press queues nothing.
  assert.equal((await ada.call("POST", "/api/stock-pictures/admin/missing", { count: 0 })).body.queued, 0);
});

test("the stock cap: install-wide, counted from the ledger (failures too); past it nothing is drawn and a draw is a 429", async () => {
  const ada = await someone([ADULT], { admin: true });
  // Draws earlier today, by anyone (one failed): one left.
  await q(`insert into picture_stock_calls (concept_id, outcome) select 'old', case when g = 1 then 'failed' else 'ok' end from generate_series(1, ${PICTURE_DAILY_STOCK - 1}) g`);
  // And one from more than a day ago, which doesn't count (and is pruned).
  await q(`insert into picture_stock_calls (concept_id, outcome, created_at) values ('ancient', 'ok', now() - interval '25 hours')`);
  const r = await ada.call("POST", "/api/stock-pictures/admin/missing", { count: 2 });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.body.queued, 1, "only what the cap leaves room for");
  await settleStockDraws();
  assert.equal(stockFiles().length, 1);
  const [{ n: total }] = await q("select count(*)::int as n from picture_stock_calls where created_at > now() - interval '1 day'");
  assert.equal(total, PICTURE_DAILY_STOCK);
  assert.deepEqual(await q("select id from picture_stock_calls where concept_id = 'ancient'"), [], "pruned as a draw was entered");
  const missing = (await ada.call("GET", "/api/stock-pictures")).body.concepts.find((c) => !c.version).id;
  const draw = await ada.call("POST", `/api/stock-pictures/admin/${missing}/draw`, {});
  assert.equal(draw.status, 429);
  assert.match(draw.body.error, new RegExp(`${PICTURE_DAILY_STOCK}`));
  assert.equal((await ada.call("POST", "/api/stock-pictures/admin/missing", { count: 1 })).status, 429);
  await settleStockDraws();
  assert.equal(stockFiles().length, 1, "nothing more drawn");
});

test("a concept added from the page is stored in the database (never content/), merges into the stock list and reaches the picturable check", async () => {
  const ada = await someone([ADULT], { admin: true });
  const yaml = fs.readFileSync(path.join(root, "pictures.yaml"), "utf8");
  const bad = await ada.call("POST", "/api/stock-pictures/admin/concepts", { name: "dog", category: "Animals", description: "another dog", words: "hound" });
  assert.equal(bad.status, 400, "an id the file has");
  assert.match(bad.body.error, /already/);
  const named = await ada.call("POST", "/api/stock-pictures/admin/concepts", { name: "sam's hat", category: "Clothes", description: "a hat for Sam", words: "hat" });
  assert.equal(named.status, 400, "a learner's name in the description");
  assert.equal((await ada.call("POST", "/api/stock-pictures/admin/concepts", { name: "x", category: "Food", description: "a picture of", words: "x" })).status, 400);
  const r = await ada.call("POST", "/api/stock-pictures/admin/concepts", { name: "Ice cream", category: "Food", description: "a cone of strawberry ice cream", words: "ice cream, ice-cream cone" });
  assert.equal(r.status, 201, r.text);
  assert.equal(fs.readFileSync(path.join(root, "pictures.yaml"), "utf8"), yaml, "content/ untouched");
  assert.deepEqual(await q("select id, category, description, words from picture_stock_concepts"), [
    { id: "ice-cream", category: "Food", description: "a cone of strawberry ice cream", words: ["ice cream", "ice-cream cone"] },
  ]);
  const c = r.body.concepts.find((x) => x.id === "ice-cream");
  assert.deepEqual([c.category, c.custom], ["Food", true]);
  assert.equal(r.body.queued, 1, "its picture is asked for at once");
  await settleStockDraws();
  assert.ok(fs.existsSync(stockFile("ice-cream")));

  // A learner's word meaning "ice cream" is matched to it by the check: ready at once, no image of its own.
  const sam = await someone([ADULT]);
  await add(sam, [["el helado", "ice cream"]]);
  await drawAll(sam);
  const args = fake.pictureArgs().join("\n");
  assert.match(args, /ice-cream: ice cream, ice-cream cone/, "the check is offered the added concept");
  const [row] = await q("select status, stock_id from phrase_pictures where language_profile_id = $1", [sam.languageId]);
  assert.deepEqual([row.status, row.stock_id], ["ready", "ice-cream"]);
  const [{ n: images }] = await q("select count(*)::int as n from picture_calls where language_profile_id = $1 and kind = 'image'", [sam.languageId]);
  assert.equal(images, 0);
});

test("a concept of content/pictures.yaml can't be deleted, only redrawn; an added one is deleted with its picture", async () => {
  const ada = await someone([ADULT], { admin: true });
  writeStockPicture(PICTURE_THEME.id, "dog", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg", { dir: imagesDir });
  const del = await ada.call("POST", "/api/stock-pictures/admin/dog/remove", {});
  assert.equal(del.status, 409);
  assert.match(del.body.error, /pictures\.yaml/);
  assert.ok(fs.existsSync(path.join(imagesDir, "stock", PICTURE_THEME.id, "dog.jpg")), "its picture stays");
  // Redrawn: the same name, new bytes (a png now), a new version.
  const before = (await ada.call("GET", "/api/stock-pictures")).body.concepts.find((c) => c.id === "dog").version;
  assert.equal((await ada.call("POST", "/api/stock-pictures/admin/dog/draw", {})).status, 202);
  await settleStockDraws();
  assert.deepEqual(stockFiles(), ["dog.png"]);
  const afterV = (await ada.call("GET", "/api/stock-pictures")).body.concepts.find((c) => c.id === "dog").version;
  assert.notEqual(afterV, before);

  await ada.call("POST", "/api/stock-pictures/admin/concepts", { name: "kite", category: "Toys", description: "a red kite in the sky", words: "kite" });
  await settleStockDraws();
  assert.ok(fs.existsSync(stockFile("kite")));
  const gone = await ada.call("POST", "/api/stock-pictures/admin/kite/remove", {});
  assert.equal(gone.status, 200, gone.text);
  assert.ok(!gone.body.concepts.some((c) => c.id === "kite"));
  assert.ok(!fs.existsSync(stockFile("kite")));
  assert.deepEqual(await q("select id from picture_stock_concepts"), []);
  assert.equal((await ada.call("POST", "/api/stock-pictures/admin/kite/remove", {})).status, 404);
});

test("a word pointing at a stock picture is revalidated, not cached for a year: a redraw reaches the game", async () => {
  const ada = await someone([ADULT], { admin: true });
  await ada.call("POST", "/api/stock-pictures/admin/missing", { count: 2 });
  await settleStockDraws();
  await add(ada, [["el perro", "dog"]]);
  await drawAll(ada);
  const [w] = (await ada.call("GET", "/api/pictures/words")).body.words;
  assert.equal(w.picture.stock, true);
  const url = `/api/game/pictures/${w.picture.id}/${w.picture.file}`;
  const first = await ada.call("GET", url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "private, no-cache");
  const etag = first.headers.get("etag");
  assert.equal((await ada.call("GET", url, undefined, { "If-None-Match": etag })).status, 304);
  fs.rmSync(stockFile("dog"));
  writeStockPicture(PICTURE_THEME.id, "dog", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]), "image/jpeg", { dir: imagesDir });
  const changed = await ada.call("GET", url, undefined, { "If-None-Match": etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
});
