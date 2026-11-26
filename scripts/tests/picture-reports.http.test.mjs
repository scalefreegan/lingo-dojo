// Draw again with a note, and reports of shared pictures (bead ld-ur3;
// docs/DATA.md §Picture reports): a redraw may say why and what the picture
// should show instead (the word's new description, cleaned like Draw it
// anyway's, a learner's name refused); a word on a shared picture gets its
// own drawing and, with a reason, the shared picture is reported to an
// admin; an open "not right for kids" report keeps it from kids learners
// until an admin resolves it; at most PICTURE_DAILY_REPORTS a day.
// The real plugin on an in-process PGlite with a stand-in `claude`, and
// OpenAI's image endpoint stubbed (the prompt it is sent is read back):
// nothing here reaches a model or a provider. Every name here is made up.
//   node --test scripts/tests/picture-reports.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
fs.writeFileSync(process.env.LINGO_ENV_FILE, "OPENAI_API_KEY=sk-test-not-a-real-key\n");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "OPENAI_API_KEY", "BFL_API_KEY", "LINGO_IMAGE_PROVIDER", "LINGO_IMAGES_DIR"]) delete process.env[k];

const { apiPlugins } = await import("../../web/server/api.ts");
const { resetPictureMemory, settlePictureFills } = await import("../../web/server/pictures.ts");
const { settlePoolWords } = await import("../../web/server/picturePool.ts");
const { settleExtractions } = await import("../../web/server/extraction.ts");
const { placeholderPng, OPENAI_IMAGE } = await import("../../web/server/imageProvider.ts");
const { PICTURE_THEME } = await import("../pictures.mjs");
const { writeStockPicture } = await import("../picture-store.mjs");
const { PICTURE_DAILY_REPORTS } = await import("../db/pictureReports.ts");

const prompts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === OPENAI_IMAGE.url) {
    prompts.push(JSON.parse(init.body).prompt);
    return new Response(JSON.stringify({ data: [{ b64_json: placeholderPng([10, 90, 150]).toString("base64") }] }), { status: 200 });
  }
  return realFetch(url, init);
};

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
  await settlePoolWords();
  await settleExtractions();
  globalThis.fetch = realFetch;
  fake.restore();
  await close();
  await testDb.close();
});
beforeEach(async () => {
  await settlePictureFills();
  await settlePoolWords();
  resetPictureMemory();
  fake.picture("!auto");
  fake.poolWords(JSON.stringify({ items: [] }));
  prompts.length = 0;
  for (const t of ["picture_reports", "picture_stock_concepts", "picture_pool_words", "picture_pool_levels", "picture_pool_calls"]) await q(`delete from ${t}`);
  fs.writeFileSync(path.join(root, "pictures.yaml"), ["categories:", "  Animals:", "    - { id: dog, description: a friendly brown dog, words: [dog] }", ""].join("\n"));
  writeStockPicture(PICTURE_THEME.id, "dog", placeholderPng([40, 90, 150]), "image/png", { dir: imagesDir });
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
async function word(who, text, meaning) {
  const r = await who.call("POST", "/api/phrases", { text, meaning, starred: false });
  assert.equal(r.status, 201, r.text);
  await who.call("POST", "/api/pictures/fill");
  await settlePictureFills();
  return r.body.phrase.id;
}
const redraw = (who, id, body) => who.call("POST", `/api/pictures/phrase/${id}/redraw`, body);
const reports = async () => q("select concept_id, reason, note, resolved_at from picture_reports order by created_at");

test("Draw again with what it should show: the word's new description is what the provider is asked; no body is today's redraw", async () => {
  const sam = await someone();
  const id = await word(sam, "el gato", "cat");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /a picture of cat/);

  const r = await redraw(sam, id, { reason: "wrong", show: "a sleeping orange cat" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.picture.description, "a sleeping orange cat");
  assert.equal(r.body.reported, undefined, "an own drawing is never reported");
  await settlePictureFills();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /a sleeping orange cat/);
  assert.doesNotMatch(prompts[1], /a picture of cat/);

  const plain = await redraw(sam, id);
  assert.equal(plain.status, 200, plain.text);
  assert.equal(plain.body.picture.description, "a sleeping orange cat", "no body keeps the description");
  await settlePictureFills();
  assert.match(prompts[2], /a sleeping orange cat/);
  assert.deepEqual(await reports(), []);
});

test("a learner's name in what it should show, nothing to draw, or a reason not on the list: a 400 and nothing changes", async () => {
  const sam = await someone();
  const id = await word(sam, "el perro", "a dog in the park");
  const row = () => q("select status, description, file from phrase_pictures where phrase_id = $1", [id]);
  const before = (await row())[0];
  for (const [body, re] of [
    [{ show: "Sam with a dog" }, /learner's name/],
    [{ show: "!!!" }, /what to draw/],
    [{ reason: "ugly" }, /reason must be one of/],
    [{ show: 5 }, /show must be text/],
  ]) {
    const r = await redraw(sam, id, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  assert.deepEqual((await row())[0], before);
  assert.deepEqual(await reports(), []);
});

test("a word on a shared picture: Draw again with a reason gives it its own drawing and reports the shared one; without a reason nothing is reported", async () => {
  const sam = await someone();
  const id = await word(sam, "el perro", "dog");
  assert.equal((await q("select stock_id from phrase_pictures where phrase_id = $1", [id]))[0].stock_id, "dog", "matched to the stock dog");
  assert.equal(prompts.length, 0);

  const r = await redraw(sam, id, { reason: "lookalike", show: "a small black puppy" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.reported, true);
  assert.equal(r.body.picture.stock, false);
  await settlePictureFills();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /a small black puppy/);
  assert.deepEqual(await reports(), [{ concept_id: "dog", reason: "lookalike", note: "a small black puppy", resolved_at: null }]);

  const bo = await someone();
  const other = await word(bo, "el perro", "dog");
  assert.equal((await redraw(bo, other, {})).body.reported, undefined);
  assert.equal((await reports()).length, 1);
});

test("an open 'not right for kids' report keeps the shared picture from kids learners until an admin resolves it", async () => {
  const pip = await someone([KID]);
  await word(pip, "der Hund", "dog");
  const kidSees = async () => (await pip.call("GET", "/api/stock-pictures")).body.concepts.some((c) => c.id === "dog");
  const kidPictured = async () => (await pip.call("GET", "/api/game")).body.status.pictured;
  assert.equal(await kidSees(), true);
  assert.equal(await kidPictured(), 1);

  const sam = await someone();
  const id = await word(sam, "el perro", "dog");
  assert.equal((await redraw(sam, id, { reason: "kids" })).body.reported, true);
  assert.equal(await kidSees(), false, "kept from kids while open");
  assert.equal(await kidPictured(), 0, "out of the kid's game");

  const ada = await someone([ADULT], { admin: true });
  const list = await ada.call("GET", "/api/stock-pictures/admin/reports");
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.reports.map((r) => [r.conceptId, r.reason, r.note]), [["dog", "kids", null]]);
  const done = await ada.call("POST", `/api/stock-pictures/admin/reports/${list.body.reports[0].id}/resolve`, {});
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.resolved, 1);
  assert.deepEqual((await ada.call("GET", "/api/stock-pictures/admin/reports")).body.reports, []);
  assert.equal(await kidSees(), true, "back for kids once resolved");
  assert.equal(await kidPictured(), 1);
  assert.equal((await ada.call("POST", `/api/stock-pictures/admin/reports/${list.body.reports[0].id}/resolve`, {})).status, 404, "already resolved");
});

test("the reports routes are an admin's: 403 for everyone else", async () => {
  const sam = await someone();
  assert.equal((await sam.call("GET", "/api/stock-pictures/admin/reports")).status, 403);
  assert.equal((await sam.call("POST", "/api/stock-pictures/admin/reports/00000000-0000-4000-8000-000000000000/resolve", {})).status, 403);
});

test(`at most ${PICTURE_DAILY_REPORTS} reports a user a day: the next is a 429 and the word is left as it was`, async () => {
  const sam = await someone();
  const id = await word(sam, "el perro", "dog");
  const userId = (await q("select id from users where username = $1", [`user${n}`]))[0].id;
  for (let i = 0; i < PICTURE_DAILY_REPORTS; i++) await q("insert into picture_reports (user_id, concept_id, reason) values ($1, 'dog', 'style')", [userId]);
  const before = (await q("select status, stock_id from phrase_pictures where phrase_id = $1", [id]))[0];
  const r = await redraw(sam, id, { reason: "wrong" });
  assert.equal(r.status, 429, r.text);
  assert.deepEqual((await q("select status, stock_id from phrase_pictures where phrase_id = $1", [id]))[0], before);
  assert.equal((await redraw(sam, id, {})).status, 200, "Draw again without a reason still works");
});

test("mergeStock: a held override (an open kids report) keeps an added concept from kids too; a plain one still never touches it", async () => {
  const { mergeStock } = await import("../pictures.mjs");
  const base = [{ id: "dog", category: "Animals", description: "a dog", words: ["dog"] }];
  const custom = [{ id: "kite", category: "Toys", description: "a kite", words: ["kite"], adults: false, origin: "admin" }];
  const adults = (o) => Object.fromEntries(mergeStock(base, custom, o).concepts.map((c) => [c.id, !!c.adults]));
  assert.deepEqual(adults([{ id: "kite", adults: true }]), { dog: false, kite: false });
  assert.deepEqual(adults([{ id: "kite", adults: true, held: true }, { id: "dog", adults: true, held: true }]), { dog: true, kite: true });
});
