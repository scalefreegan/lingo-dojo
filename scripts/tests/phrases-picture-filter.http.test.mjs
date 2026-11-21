// The Phrase bank's "With picture" filter (ld-p1e): GET /api/phrases marks
// `hasPicture` for phrases whose picture row is ready (drawn or shared
// stock), counts them in `counts.pictures`, and `show=pictures` lists them.
// Pending, none, failed and removed rows don't count; another learner's
// pictures never do. Real plugin on in-process PGlite; no model or provider.
//   node --test scripts/tests/phrases-picture-filter.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { pictureKey } from "../pictures.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
delete process.env.LINGO_IMAGES_DIR;
const imagesDir = path.join(dataDir, "images");
const { apiPlugins } = await import("../../web/server/api.ts");
const { PICTURE_THEME, stockKey } = await import("../pictures.mjs");
const { writeStockPicture } = await import("../picture-store.mjs");
// An adults-only concept of our own, a plain one, and one whose file is never drawn.
fs.writeFileSync(
  path.join(root, "pictures.yaml"),
  ["categories:", "  Animals:", "    - { id: dog, description: a friendly brown dog, words: [dog] }", "    - { id: ghost, description: a pale ghost, words: [ghost] }", "  Drinks:", "    - { id: stout, description: a pint of stout, words: [stout], adults: true }", ""].join("\n"),
);
for (const id of ["dog", "stout"]) writeStockPicture(PICTURE_THEME.id, id, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg", { dir: imagesDir });

const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => ({ base, close } = await serveApi(apiPlugins, { db: testDb.db })));
after(async () => {
  await close();
  await testDb.close();
});

let n = 0;
async function someone(learner) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners: [learner] });
  const c = client(base);
  await c.login(name);
  await c.pick(learner.name);
  return c;
}
const HEX = "a".repeat(64);

/** Words added by hand; each gets the picture row named (status, stock?). */
async function bankWith(who, rows) {
  const ids = {};
  const [lp] = await q("select id, learner_id from language_profiles where id = $1", [who.languageId]);
  for (const [text, status, stock, stale] of rows) {
    const r = await who.call("POST", "/api/phrases", { text, meaning: `m-${text}`, starred: false });
    assert.equal(r.status, 201, r.text);
    ids[text] = r.body.phrase.id;
    if (!status) continue;
    const ready = status === "ready";
    await q(
      `insert into phrase_pictures (phrase_id, learner_id, language_profile_id, phrase_key, status, description, file, content_type, theme, stock_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [ids[text], lp.learner_id, lp.id, stale ? "old-key" : pictureKey({ text, meaning: `m-${text}` }), status, ["pending", "ready"].includes(status) ? "a picture" : null, ready ? (stock ? stockKey(PICTURE_THEME.id, "dog") : HEX) : null, ready ? "image/png" : null, ready ? (stock ? PICTURE_THEME.id : "t1") : null, stock ? "dog" : null],
    );
  }
  return ids;
}

const ROWS = [["uno", "ready"], ["dos", "ready", "stock"], ["tres", "pending"], ["cuatro", "none"], ["cinco", "failed"], ["seis", "removed"], ["siete", null], ["ocho", "ready", false, "stale"]];

test("hasPicture is true for ready drawn and ready stock rows only; show=pictures lists them and the count agrees", async () => {
  const sam = await someone(ADULT);
  await bankWith(sam, ROWS);
  const all = (await sam.call("GET", "/api/phrases?limit=200")).body;
  const has = Object.fromEntries(all.phrases.map((p) => [p.text, p.hasPicture]));
  assert.deepEqual(has, { uno: true, dos: true, tres: false, cuatro: false, cinco: false, seis: false, siete: false, ocho: false }); // ocho: a stale row (its words were edited), shown by nothing
  assert.equal(all.counts.pictures, 2);
  assert.equal(all.counts.all, 8);
  const shown = (await sam.call("GET", "/api/phrases?show=pictures")).body;
  assert.deepEqual(shown.phrases.map((p) => p.text).sort(), ["dos", "uno"]);
  assert.equal(shown.total, 2);
  assert.equal(shown.counts.pictures, 2, "the count is over the whole bank, whatever is shown");
  assert.deepEqual((await sam.call("GET", "/api/phrases?show=pictures&q=uno")).body.phrases.map((p) => p.text), ["uno"]);
});

test("a picture removed or drawn moves the list and its count; a kids learner's grown-up view has the filter too", async () => {
  const pip = await someone(KID);
  const ids = await bankWith(pip, [["der Hund", "ready"], ["die Katze", "pending"]]);
  assert.equal((await pip.call("GET", "/api/phrases?show=pictures")).body.total, 1);
  await q("update phrase_pictures set status = 'removed', file = null, content_type = null, theme = null where phrase_id = $1", [ids["der Hund"]]);
  await q("update phrase_pictures set status = 'ready', file = $2, content_type = 'image/png', theme = 't1' where phrase_id = $1", [ids["die Katze"], HEX]);
  const r = (await pip.call("GET", "/api/phrases?show=pictures")).body;
  assert.deepEqual(r.phrases.map((p) => p.text), ["die Katze"]);
  assert.equal(r.counts.pictures, 1);
});

test("another learner's pictures never count or mark", async () => {
  const a = await someone(ADULT);
  const b = await someone(ADULT);
  await bankWith(a, [["gato", "ready"]]);
  await bankWith(b, [["gato", null], ["perro", "pending"]]);
  const r = (await b.call("GET", "/api/phrases?show=pictures")).body;
  assert.equal(r.total, 0);
  assert.equal(r.counts.pictures, 0);
  assert.ok((await b.call("GET", "/api/phrases")).body.phrases.every((p) => p.hasPicture === false));
});

/** A word with a ready stock picture of concept `stockId`. */
async function stockWord(who, text, stockId) {
  const r = await who.call("POST", "/api/phrases", { text, meaning: `m-${text}`, starred: false });
  const [lp] = await q("select id, learner_id from language_profiles where id = $1", [who.languageId]);
  await q(
    `insert into phrase_pictures (phrase_id, learner_id, language_profile_id, phrase_key, status, description, file, content_type, theme, stock_id)
     values ($1, $2, $3, $4, 'ready', 'a picture', $5, 'image/jpeg', $6, $7)`,
    [r.body.phrase.id, lp.learner_id, lp.id, pictureKey({ text, meaning: `m-${text}` }), stockKey(PICTURE_THEME.id, stockId), PICTURE_THEME.id, stockId],
  );
}

test("the chip counts what the pictures line counts: a kids learner's adults-only or missing-file stock picture is left out, an adult's adults-only one is not", async () => {
  const stockRows = [["perro", "dog"], ["cerveza", "stout"], ["fantasma", "ghost"]];
  const pip = await someone(KID);
  for (const [w, id] of stockRows) await stockWord(pip, w, id);
  const sam = await someone(ADULT);
  for (const [w, id] of stockRows) await stockWord(sam, w, id);
  for (const [who, want] of [[pip, ["perro"]], [sam, ["cerveza", "perro"]]]) {
    const r = (await who.call("GET", "/api/phrases?show=pictures")).body;
    assert.deepEqual(r.phrases.map((p) => p.text).sort(), want);
    assert.equal(r.counts.pictures, want.length);
    assert.equal((await who.call("GET", "/api/game")).body.status.pictured, want.length, "the chip and the pictures line agree");
  }
});

test("a suspended word, or one with no meaning, has no game picture and no chip", async () => {
  const sam = await someone(ADULT);
  await stockWord(sam, "perro", "dog");
  const id = (await sam.call("GET", "/api/phrases?show=pictures")).body.phrases[0].id;
  assert.equal((await sam.call("PATCH", `/api/phrases/${id}`, { suspended: true })).status, 200);
  assert.equal((await sam.call("GET", "/api/phrases?show=pictures")).body.counts.pictures, 0);
  assert.equal((await sam.call("GET", "/api/game")).body.status.pictured, 0);
});
