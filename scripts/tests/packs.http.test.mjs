// The saved-pack routes end to end (docs/DATA.md §Packs): /api/packs,
// /api/folders and /api/pack-revisions on the real Vite plugin, an
// in-process PGlite (freshDb) and a temp copy of the fixture library. Packs
// are rows owned by the active learner now: every write records a revision,
// a delete is soft, and nothing is written under content/ or committed. The
// races (two creates of one id, a move against a delete) need a real
// Postgres and are in packs.pg.test.mjs.
//   node --test scripts/tests/packs.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client, tab } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";
import { packRevisions, packs } from "../db/schema.ts";

const root = copyFixture();
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_EXPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-exports-"));

const { apiPlugins } = await import("../../web/server/api.ts");

const testDb = await freshDb();
const db = testDb.db;
let base, close, robin;
before(async () => {
  ({ base, close } = await serveApi(apiPlugins, { db }));
  await addUser(db, "robin", undefined, { admin: true, learners: [ADULT, KID] });
  robin = client(base);
  await robin.login("robin");
  await robin.pick("Sam");
});
after(async () => {
  await close();
  await testDb.close();
});

const call = (...args) => robin.call(...args);

const pack = {
  title: "Plaza chat",
  created: "2026-10-20T10:00:00-06:00",
  scenario: "plaza",
  quick_scenario: "",
  units: ["intro-target", "warmup-vocab"],
  overrides: { level: "B2" },
  notes: "",
};

/** The pack files under the temp library, which no route may change. */
const packFiles = () => fs.readdirSync(path.join(root, "packs"), { recursive: true }).sort();
const filesBefore = packFiles();

/** A pack's revisions through the route: [action, title, id], newest first. */
async function history(id, c = robin) {
  const r = await c.call("GET", `/api/pack-revisions?id=${encodeURIComponent(id)}`);
  assert.equal(r.status, 200, r.text);
  return r.body.revisions.map((v) => [v.action, v.pack.title, v.pack.id]);
}

/** Delete every live pack and folder of the active learner, so a test starts empty. */
async function clear(c = robin) {
  const { packs: list, folders } = (await c.call("GET", "/api/packs")).body;
  for (const p of list) assert.equal((await c.call("DELETE", `/api/packs/${p.id}`)).status, 200);
  for (const f of folders) assert.equal((await c.call("DELETE", `/api/folders/${f}`)).status, 200);
}

test("a learner starts with no packs: the library's pack files are not listed", async () => {
  const r = await call("GET", "/api/packs");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { packs: [], folders: [], problems: [] });
});

test("PUT creates, GET lists and reads, PUT again replaces, DELETE is soft: each a revision, no file, no commit", async () => {
  const id = "2026-10-20-plaza-chat";
  const put = await call("PUT", `/api/packs/${id}`, { ...pack, id: "ignored", folder: "ignored", extra: "dropped" });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.body, { pack: { ...pack, id, folder: "" } }, "the reply is the row as stored; no commit field");
  assert.deepEqual((await call("GET", "/api/packs")).body.packs.map((p) => p.id), [id]);
  assert.equal((await call("GET", `/api/packs/${id}`)).body.pack.overrides.level, "B2");

  const again = await call("PUT", `/api/packs/${id}`, { ...pack, notes: "More numbers." });
  assert.equal(again.status, 200);
  assert.equal(again.body.pack.notes, "More numbers.");
  // A missing created is now; a missing field is its empty value, as the file loader did.
  const sparse = await call("PUT", "/api/packs/2026-10-20-sparse", { title: "  Sparse  " });
  assert.equal(sparse.body.pack.title, "Sparse");
  assert.match(sparse.body.pack.created, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(sparse.body.pack.units, []);

  const del = await call("DELETE", `/api/packs/${id}`);
  assert.deepEqual(del.body, { ok: true });
  assert.equal((await call("GET", `/api/packs/${id}`)).status, 404);
  assert.equal((await call("DELETE", `/api/packs/${id}`)).status, 404, "already deleted");
  assert.deepEqual((await call("GET", "/api/packs")).body.packs.map((p) => p.id), ["2026-10-20-sparse"]);
  const [row] = await db.select().from(packs).where(eq(packs.slug, id));
  assert.ok(row.deletedAt, "the row is kept, marked deleted");
  const revs = await db.select().from(packRevisions).where(eq(packRevisions.packId, row.id)).orderBy(packRevisions.seq);
  assert.deepEqual(revs.map((r) => r.action), ["create", "update", "delete"]);
  assert.equal(revs[2].snapshot.notes, "More numbers.", "the delete's snapshot is the content that was deleted");

  assert.deepEqual(packFiles(), filesBefore, "nothing written under content/packs");
  await clear();
});

test("pack ids and bodies are validated: traversal, case, depth and junk are 400 and nothing is written", async () => {
  const rowsBefore = await db.select().from(packs);
  for (const id of ["..%2Fevil", "a%2Fb%2Fc", "A-Upper", "-leading", "x.yaml", "a%5Cb"]) {
    const r = await call("PUT", `/api/packs/${id}`, pack);
    assert.equal(r.status, 400, `${id}: ${r.text}`);
    assert.match(r.body.error, /invalid id/);
  }
  assert.equal((await call("PUT", "/api/packs/%2E%2E", pack)).status, 404, "fetch folds the dot-segment; nothing matches");
  assert.equal((await call("PUT", "/api/packs/2026-10-20-x", { ...pack, title: "  " })).status, 400);
  assert.equal((await call("PUT", "/api/packs/2026-10-20-x", "[1,2]")).status, 400);
  assert.equal((await call("PUT", "/api/packs/2026-10-20-x", "{not json")).status, 400);
  assert.equal((await call("GET", "/api/packs/A-Upper")).status, 400);
  assert.equal((await call("PATCH", "/api/packs/2026-10-20-x", pack)).status, 405);
  assert.deepEqual(await db.select().from(packs), rowsBefore, "no row");
  assert.deepEqual(packFiles(), filesBefore);
});

test("folders: create, save into, rename, move, the one-folder-deep rule, and only an empty folder deletes", async () => {
  const made = await call("POST", "/api/folders", { name: "oaxaca" });
  assert.equal(made.status, 200, made.text);
  assert.deepEqual(made.body, { folder: "oaxaca", folders: ["oaxaca"] });
  assert.equal((await call("POST", "/api/folders", { name: "oaxaca" })).status, 409);
  for (const bad of [{ name: "Oaxaca" }, { name: "a/b" }, { name: ".." }, { name: "" }, { name: "x y" }, {}, { name: 7 }]) {
    assert.equal((await call("POST", "/api/folders", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call("GET", "/api/folders")).status, 405);
  assert.deepEqual((await call("GET", "/api/packs")).body.folders, ["oaxaca"]);

  // Save into it: the id is folder/slug, in a path or encoded.
  const id = "oaxaca/2026-10-20-mezcal";
  const put = await call("PUT", "/api/packs/oaxaca%2F2026-10-20-mezcal", { ...pack, title: "Mezcal" });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.body.pack.id, id);
  assert.equal(put.body.pack.folder, "oaxaca");
  assert.equal((await call("GET", `/api/packs/${id}`)).body.pack.title, "Mezcal");
  // A pack id names at most one folder.
  assert.equal((await call("PUT", "/api/packs/a/b/2026-10-20-deep", pack)).status, 400);
  // Saving into a folder that does not exist yet makes it, as the file write did.
  assert.equal((await call("PUT", "/api/packs/new-folder/2026-10-20-x", pack)).status, 200);
  assert.deepEqual((await call("GET", "/api/packs")).body.folders, ["new-folder", "oaxaca"]);
  assert.equal((await call("DELETE", "/api/packs/new-folder/2026-10-20-x")).status, 200);
  assert.equal((await call("DELETE", "/api/folders/new-folder")).status, 200);

  // Not empty: refused, nothing removed.
  const full = await call("DELETE", "/api/folders/oaxaca");
  assert.equal(full.status, 409);
  assert.match(full.body.error, /not empty \(1 pack\)/);

  // Rename: a new slug from the title, the date and folder kept.
  const renamed = await call("POST", `/api/packs/${id}/rename`, { title: "  Café en Oaxaca " });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.body.pack.id, "oaxaca/2026-10-20-cafe-en-oaxaca");
  assert.equal(renamed.body.pack.title, "Café en Oaxaca");
  assert.equal((await call("POST", `/api/packs/${id}/rename`, { title: "X" })).status, 404, "the old id is gone");
  // The same slug only retitles.
  const retitled = await call("POST", "/api/packs/oaxaca/2026-10-20-cafe-en-oaxaca/rename", { title: "Cafe en Oaxaca!" });
  assert.equal(retitled.body.pack.id, "oaxaca/2026-10-20-cafe-en-oaxaca");
  assert.equal(retitled.body.pack.title, "Cafe en Oaxaca!");
  assert.equal((await call("POST", "/api/packs/oaxaca/2026-10-20-cafe-en-oaxaca/rename", { title: " " })).status, 400);
  assert.equal((await call("POST", "/api/packs/oaxaca/2026-10-20-cafe-en-oaxaca/rename", {})).status, 400);

  // Move to the top level and back; moving to where it is changes nothing.
  const cafe = "2026-10-20-cafe-en-oaxaca";
  const moved = await call("POST", `/api/packs/oaxaca/${cafe}/move`, { folder: "" });
  assert.equal(moved.status, 200, moved.text);
  assert.deepEqual([moved.body.pack.id, moved.body.pack.folder], [cafe, ""]);
  assert.equal((await call("POST", `/api/packs/${cafe}/move`, { folder: "" })).body.pack.id, cafe);
  // A clash is a 409 and nothing moves; bad folders, missing packs, unknown actions.
  await call("PUT", `/api/packs/oaxaca/${cafe}`, { ...pack, title: "Clash" });
  const clash = await call("POST", `/api/packs/${cafe}/move`, { folder: "oaxaca" });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /already exists/);
  assert.equal((await call("GET", `/api/packs/${cafe}`)).body.pack.title, "Cafe en Oaxaca!", "the refused move changed nothing");
  assert.equal((await call("POST", `/api/packs/${cafe}/move`, { folder: "a/b" })).status, 400, "one folder deep");
  assert.equal((await call("POST", `/api/packs/${cafe}/move`, { folder: "Upper" })).status, 400);
  assert.equal((await call("POST", `/api/packs/${cafe}/move`, {})).status, 400);
  assert.equal((await call("POST", "/api/packs/2026-10-20-nope/move", { folder: "oaxaca" })).status, 404);
  assert.equal((await call("POST", `/api/packs/${cafe}/explode`, { folder: "oaxaca" })).status, 405);
  assert.equal((await call("POST", "/api/packs/a/b/c/move", { folder: "oaxaca" })).status, 400, "too deep an id");
  // A rename into a taken id is a 409 too.
  await call("PUT", "/api/packs/2026-10-20-plaza", { ...pack, title: "Plaza" });
  assert.equal((await call("POST", `/api/packs/${cafe}/rename`, { title: "Plaza" })).status, 409);

  // Empty the folder; then it deletes, and a second delete is a 404.
  assert.equal((await call("DELETE", `/api/packs/oaxaca/${cafe}`)).status, 200);
  const gone = await call("DELETE", "/api/folders/oaxaca");
  assert.equal(gone.status, 200, gone.text);
  assert.deepEqual(gone.body, { ok: true, folders: [] });
  assert.equal((await call("DELETE", "/api/folders/oaxaca")).status, 404);
  assert.equal((await call("DELETE", "/api/folders/..%2Funits")).status, 400);
  assert.equal((await call("DELETE", "/api/folders/Units")).status, 400);
  assert.equal((await call("DELETE", "/api/folders/a/b")).status, 400);

  // A move records a revision, as every write does.
  assert.deepEqual((await history(cafe)).map(([action]) => action), ["move", "rename", "rename", "create"]);
  assert.deepEqual(packFiles(), filesBefore, "no folder or file under content/packs");
  await clear();
});

test("revisions: listed newest first across renames and moves; restoring one puts its content back as a new revision", async () => {
  await call("PUT", "/api/packs/2026-10-21-tacos", { ...pack, title: "Tacos", notes: "v1" });
  await call("PUT", "/api/packs/2026-10-21-tacos", { ...pack, title: "Tacos", notes: "v2" });
  await call("POST", "/api/packs/2026-10-21-tacos/rename", { title: "Tacos al pastor" });
  await call("POST", "/api/packs/2026-10-21-tacos-al-pastor/move", { folder: "cdmx" });
  const id = "cdmx/2026-10-21-tacos-al-pastor";
  assert.deepEqual(await history(id), [
    ["move", "Tacos al pastor", id],
    ["rename", "Tacos al pastor", "2026-10-21-tacos-al-pastor"],
    ["update", "Tacos", "2026-10-21-tacos"],
    ["create", "Tacos", "2026-10-21-tacos"],
  ]);
  const revs = (await call("GET", `/api/pack-revisions?id=${encodeURIComponent(id)}`)).body.revisions;
  assert.match(revs[0].at, /^\d{4}-\d{2}-\d{2}T/);
  // Restore v1: the content comes back at the pack's current id.
  const v1 = revs[3].revision;
  const restored = await call("POST", `/api/pack-revisions/${v1}/restore`);
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.body.pack.id, id, "a live pack keeps its id");
  assert.equal(restored.body.pack.notes, "v1");
  assert.equal(restored.body.pack.title, "Tacos");
  assert.equal((await call("GET", `/api/packs/${id}`)).body.pack.notes, "v1");
  assert.deepEqual((await history(id))[0], ["restore", "Tacos", id]);
  // Refusals.
  assert.equal((await call("GET", "/api/pack-revisions")).status, 400, "no id");
  assert.equal((await call("GET", "/api/pack-revisions?id=2026-01-01-nope")).status, 404);
  assert.equal((await call("GET", "/api/pack-revisions?id=..%2Fx")).status, 400);
  assert.equal((await call("POST", "/api/pack-revisions/not-a-uuid/restore")).status, 404);
  assert.equal((await call("POST", "/api/pack-revisions/00000000-0000-4000-8000-000000000000/restore")).status, 404);
  assert.equal((await call("GET", `/api/pack-revisions/${v1}/restore`)).status, 405);
  assert.equal((await call("POST", "/api/pack-revisions/x/y/z")).status, 404);
  assert.equal((await call("POST", "/api/pack-revisions/deleted")).status, 405);
  await clear();
});

test("soft delete and restore: listed under deleted, restored at its id with its folder, refused when the id was taken", async () => {
  await call("PUT", "/api/packs/beach/2026-10-22-sand", { ...pack, title: "Sand", notes: "keep me" });
  await call("DELETE", "/api/packs/beach/2026-10-22-sand");
  assert.equal((await call("DELETE", "/api/folders/beach")).status, 200, "the emptied folder can go");
  const listed = await call("GET", "/api/pack-revisions/deleted");
  assert.equal(listed.status, 200);
  const sand = (r) => r.body.packs.filter((x) => x.pack.id === "beach/2026-10-22-sand");
  const deletedBefore = listed.body.packs.length;
  const [d] = listed.body.packs;
  assert.equal(d.pack.id, "beach/2026-10-22-sand");
  assert.equal(d.pack.notes, "keep me");
  assert.match(d.deletedAt, /^\d{4}-\d{2}-\d{2}T/);

  const back = await call("POST", `/api/pack-revisions/${d.revision}/restore`);
  assert.equal(back.status, 200, back.text);
  assert.deepEqual([back.body.pack.id, back.body.pack.notes], ["beach/2026-10-22-sand", "keep me"]);
  const after = (await call("GET", "/api/packs")).body;
  assert.deepEqual(after.packs.map((p) => p.id), ["beach/2026-10-22-sand"]);
  assert.deepEqual(after.folders, ["beach"], "the folder came back with it");
  assert.deepEqual(sand(await call("GET", "/api/pack-revisions/deleted")), [], "no longer listed as deleted");
  assert.deepEqual((await history("beach/2026-10-22-sand")).map(([a]) => a), ["restore", "delete", "create"]);

  // Delete again, then a new pack takes the id (the unique rule ignores
  // deleted rows): a restore must not overwrite it.
  await call("DELETE", "/api/packs/beach/2026-10-22-sand");
  const fresh = await call("PUT", "/api/packs/beach/2026-10-22-sand", { ...pack, title: "New sand" });
  assert.equal(fresh.status, 200, "a deleted pack's id is free");
  assert.deepEqual((await history("beach/2026-10-22-sand")).map(([a]) => a), ["create"], "a new pack, its own history");
  const [old] = sand(await call("GET", "/api/pack-revisions/deleted"));
  const refused = await call("POST", `/api/pack-revisions/${old.revision}/restore`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /already exists; rename or move it, then restore/);
  assert.equal((await call("GET", "/api/packs/beach/2026-10-22-sand")).body.pack.title, "New sand", "untouched");
  // Moved out of the way, the old one comes back.
  await call("POST", "/api/packs/beach/2026-10-22-sand/move", { folder: "" });
  assert.equal((await call("POST", `/api/pack-revisions/${old.revision}/restore`)).status, 200);
  assert.deepEqual((await call("GET", "/api/packs")).body.packs.map((p) => [p.id, p.title]), [
    ["2026-10-22-sand", "New sand"],
    ["beach/2026-10-22-sand", "Sand"],
  ]);
  await clear();
  assert.equal((await call("GET", "/api/pack-revisions/deleted")).body.packs.length, deletedBefore + 1, "every deleted row is listed, newest first");
});

test("every learner-scoped pack route answers 409 stale_learner for a stale page or with no learner picked, and writes nothing", async () => {
  await call("PUT", "/api/packs/2026-10-23-mine", { ...pack, title: "Mine" });
  const revision = (await call("GET", "/api/pack-revisions?id=2026-10-23-mine")).body.revisions[0].revision;
  const routes = [
    ["GET", "/api/packs"], ["GET", "/api/packs/2026-10-23-mine"], ["PUT", "/api/packs/2026-10-23-stale", pack],
    ["DELETE", "/api/packs/2026-10-23-mine"], ["POST", "/api/packs/2026-10-23-mine/move", { folder: "x" }],
    ["POST", "/api/packs/2026-10-23-mine/rename", { title: "Stale" }], ["POST", "/api/folders", { name: "stale" }],
    ["DELETE", "/api/folders/stale"], ["GET", "/api/pack-revisions?id=2026-10-23-mine"], ["GET", "/api/pack-revisions/deleted"],
    ["POST", `/api/pack-revisions/${revision}/restore`],
  ];
  const rowsBefore = await db.select().from(packs);
  const revsBefore = await db.select().from(packRevisions);
  // A second tab picks another learner of the same account: this tab is stale.
  const other = tab(base, robin);
  await other.pick("Pip");
  try {
    for (const [m, u, body] of routes) {
      const r = await call(m, u, body);
      assert.equal(r.status, 409, `${m} ${u}`);
      assert.equal(r.body.code, "stale_learner", `${m} ${u}`);
    }
  } finally {
    await robin.pick("Sam");
  }
  // No learner picked at all.
  await call("PUT", "/api/auth/learner", { learnerId: null });
  try {
    for (const [m, u, body] of routes) {
      const r = await call(m, u, body);
      assert.equal(r.status, 409, `${m} ${u}`);
      assert.equal(r.body.code, "stale_learner");
    }
  } finally {
    await robin.pick("Sam");
  }
  assert.deepEqual(await db.select().from(packs), rowsBefore);
  assert.deepEqual(await db.select().from(packRevisions), revsBefore);
  await clear();
});

test("isolation: another learner of the same account, and another account, never see or change these packs, even by guessing ids", async () => {
  // Sam's packs, a folder, a deleted pack and its revisions.
  await call("PUT", "/api/packs/secret/2026-10-24-sam", { ...pack, title: "Sam's" });
  await call("PUT", "/api/packs/2026-10-24-gone", { ...pack, title: "Sam's deleted" });
  await call("DELETE", "/api/packs/2026-10-24-gone");
  const samRevision = (await call("GET", "/api/pack-revisions?id=secret%2F2026-10-24-sam")).body.revisions[0].revision;
  const samDeleted = (await call("GET", "/api/pack-revisions/deleted")).body.packs.find((d) => d.pack.id === "2026-10-24-gone").revision;
  const samState = async () => ({
    packs: (await call("GET", "/api/packs")).body,
    revisions: await history("secret/2026-10-24-sam"),
  });
  const before = await samState();

  // Ana: a second adult learner of robin's, picked in another login of the
  // same account (another device), so Sam's page stays current.
  const made = await call("POST", "/api/learners", { name: "Ana", mode: "adult", target_language: "French", level: "A1" });
  assert.equal(made.status, 200, made.text);
  const ana = client(base);
  await ana.login("robin");
  await ana.pick("Ana");
  // Lee: another account.
  await addUser(db, "lee", undefined, { learners: [{ ...ADULT, name: "Lee" }] });
  const lee = client(base);
  await lee.login("lee");
  await lee.pick("Lee");
  try {
    for (const [who, c] of [["Ana", ana], ["Lee", lee]]) {
      assert.deepEqual((await c.call("GET", "/api/packs")).body, { packs: [], folders: [], problems: [] }, who);
      assert.deepEqual((await c.call("GET", "/api/pack-revisions/deleted")).body.packs, [], who);
      assert.equal((await c.call("GET", "/api/packs/secret/2026-10-24-sam")).status, 404, who);
      assert.equal((await c.call("GET", "/api/pack-revisions?id=secret%2F2026-10-24-sam")).status, 404, who);
      assert.equal((await c.call("DELETE", "/api/packs/secret/2026-10-24-sam")).status, 404, who);
      assert.equal((await c.call("POST", "/api/packs/secret/2026-10-24-sam/move", { folder: "" })).status, 404, who);
      assert.equal((await c.call("POST", "/api/packs/secret/2026-10-24-sam/rename", { title: "Mine now" })).status, 404, who);
      assert.equal((await c.call("DELETE", "/api/folders/secret")).status, 404, who);
      assert.equal((await c.call("POST", `/api/pack-revisions/${samRevision}/restore`)).status, 404, who);
      assert.equal((await c.call("POST", `/api/pack-revisions/${samDeleted}/restore`)).status, 404, who);
      // The same id and folder name are theirs to use, separately.
      assert.equal((await c.call("POST", "/api/folders", { name: "secret" })).status, 200, who);
      const own = await c.call("PUT", "/api/packs/secret/2026-10-24-sam", { ...pack, title: `${who}'s` });
      assert.equal(own.status, 200, who);
      assert.deepEqual((await c.call("GET", "/api/packs")).body.packs.map((p) => p.title), [`${who}'s`], who);
    }
    assert.deepEqual(await samState(), before, "Sam's packs, folder and history are untouched");
    // And Sam does not see theirs.
    assert.deepEqual((await call("GET", "/api/packs")).body.packs.map((p) => p.title), ["Sam's"]);
    assert.ok((await call("GET", "/api/pack-revisions/deleted")).body.packs.some((x) => x.pack.id === "2026-10-24-gone"));
  } finally {
    await call("POST", `/api/learners/${made.body.learner.id}/archive`, {});
  }
  await clear();
});

test("a kids learner has its own packs; the adult learner's are not in its list, and ?mode must be its own", async () => {
  await call("PUT", "/api/packs/2026-10-25-adult", { ...pack, title: "Adult" });
  await robin.pick("Pip");
  try {
    assert.deepEqual((await call("GET", "/api/packs")).body.packs, []);
    const kidsPack = { title: "Farm again", created: "2026-10-21T09:00:00-06:00", scenario: "farm", quick_scenario: "", units: ["intro-game", "story-quest"], overrides: {}, notes: "" };
    const put = await call("PUT", "/api/packs/2026-10-21-farm-again?mode=kids", kidsPack);
    assert.equal(put.status, 200, put.text);
    assert.deepEqual((await call("GET", "/api/packs")).body.packs.map((p) => p.id), ["2026-10-21-farm-again"]);
    assert.equal((await call("GET", "/api/packs?mode=adult")).status, 400, "Pip can't name the adult library");
    assert.equal((await call("GET", "/api/packs/2026-10-25-adult")).status, 404);
    assert.equal((await call("POST", "/api/folders", { name: "german" })).status, 200);
    assert.equal((await call("POST", "/api/packs/2026-10-21-farm-again/move", { folder: "german" })).body.pack.id, "german/2026-10-21-farm-again");
    assert.ok(!fs.existsSync(path.join(root, "kids", "packs", "german")), "no folder on disk");
    await clear();
  } finally {
    await robin.pick("Sam");
  }
  assert.deepEqual((await call("GET", "/api/packs")).body.packs.map((p) => p.id), ["2026-10-25-adult"]);
  await clear();
  assert.deepEqual(packFiles(), filesBefore);
});

test("a cross-origin request is refused on the revision routes too", async () => {
  for (const [m, u] of [["GET", "/api/pack-revisions/deleted"], ["POST", "/api/pack-revisions/00000000-0000-4000-8000-000000000000/restore"]]) {
    const r = await call(m, u, undefined, { Origin: "https://evil.example" });
    assert.equal(r.status, 403, `${m} ${u}`);
  }
});
