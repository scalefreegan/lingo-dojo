// The pack data layer on PGlite (scripts/db/packs.ts) and the file →
// database import behind `npm run db:import` (scripts/db/import.ts): both
// modes, a re-run, a missing learner, a pack deleted in the app, the target
// account. The pack files are a temp copy of the fixture library; nothing
// here reads or writes the real content/.
//   node --test scripts/tests/packs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { loadPackFiles } from "../content.mjs";
import { createFirstAdmin, createLearner, createUser, disableUser } from "../db/accounts.ts";
import { formatImportReport, importFilePacks } from "../db/import.ts";
import { deletePack, importPacks, listDeleted, listPacks } from "../db/packs.ts";
import { packRevisions, packs } from "../db/schema.ts";
import { copyFixture, write } from "./helpers.mjs";
import { ADULT, KID } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

/** A temp library with a folder pack, an empty folder and a broken file. */
function library() {
  const root = copyFixture();
  write(root, "packs/oaxaca/2026-10-20-mezcal.yaml", "title: Mezcal\ncreated: 2026-10-20T10:00:00-06:00\nunits: [intro-native]\n");
  write(root, "packs/empty/.keep", "");
  write(root, "packs/2026-10-21-broken.yaml", "title: [unclosed\n");
  write(root, "packs/Bad Name/2026-10-22-x.yaml", "title: Bad folder\n");
  return { adult: loadPackFiles(root), kids: loadPackFiles(`${root}/kids`) };
}

const TREES = { adult: "content/packs/", kids: "content/kids/packs/" };

async function setup(t) {
  const { db, close } = await freshDb();
  t.after(close);
  return db;
}

test("import: both modes to the first admin's learners, keeping folder, slug, title and created; empty folders too", async (t) => {
  const db = await setup(t);
  // An older non-admin and a disabled admin are passed over for the first live admin.
  await createUser(db, { username: "first", passwordHash: "x" });
  const off = await createUser(db, { username: "off", passwordHash: "x", isAdmin: true });
  await disableUser(db, "off");
  const robin = await createUser(db, { username: "robin", passwordHash: "x", isAdmin: true });
  const sam = await createLearner(db, robin.id, ADULT);
  const pip = await createLearner(db, robin.id, KID);
  await createLearner(db, off.id, { ...ADULT, name: "Off" });

  const report = await importFilePacks(db, { files: library() });
  assert.equal(report.user.username, "robin");
  const [adult, kids] = report.modes;
  assert.deepEqual(adult.learner, { id: sam.id, name: "Sam" });
  assert.deepEqual(adult.result, {
    imported: ["2026-10-19-market-gentle", "oaxaca/2026-10-20-mezcal"],
    present: [],
    invalid: ["Bad Name/2026-10-22-x"],
    folders: ["empty", "oaxaca"],
  });
  assert.equal(adult.unreadable.length, 1);
  assert.match(adult.unreadable[0].file, /2026-10-21-broken\.yaml$/);
  assert.deepEqual(kids.result.imported, ["2026-10-20-farm-first"]);

  const samPacks = await listPacks(db, sam.id);
  assert.deepEqual(samPacks.folders, ["empty", "oaxaca"]);
  const mezcal = samPacks.packs.find((p) => p.id === "oaxaca/2026-10-20-mezcal");
  assert.deepEqual([mezcal.folder, mezcal.title, mezcal.created, mezcal.units], ["oaxaca", "Mezcal", "2026-10-20T10:00:00-06:00", ["intro-native"]]);
  assert.equal(samPacks.packs.find((p) => p.id === "2026-10-19-market-gentle").overrides.level, "B1");
  assert.deepEqual((await listPacks(db, pip.id)).packs.map((p) => p.id), ["2026-10-20-farm-first"]);
  const revs = await db.select().from(packRevisions).where(eq(packRevisions.learnerId, sam.id));
  assert.deepEqual(revs.map((r) => r.action), ["import", "import"]);

  assert.deepEqual(formatImportReport(report, TREES), [
    "packs → robin (admin)",
    "adult (content/packs/) → Sam: 2 imported, 0 already there, 2 folders added, 1 invalid, 1 unreadable file",
    "  + 2026-10-19-market-gentle",
    "  + oaxaca/2026-10-20-mezcal",
    "  + folder empty",
    "  + folder oaxaca",
    "  ! Bad Name/2026-10-22-x: not a valid pack id, or no title; skipped",
    `  ! ${adult.unreadable[0].file}: ${adult.unreadable[0].message}; skipped`,
    "kids (content/kids/packs/) → Pip: 1 imported, 0 already there, 0 folders added",
    "  + 2026-10-20-farm-first",
  ]);
});

test("import: a re-run adds nothing, and a pack deleted in the app stays deleted", async (t) => {
  const db = await setup(t);
  const robin = await createUser(db, { username: "robin", passwordHash: "x", isAdmin: true });
  const sam = await createLearner(db, robin.id, ADULT);
  await createLearner(db, robin.id, KID);
  await importFilePacks(db, { files: library() });
  const rowsAfterFirst = await db.select().from(packs);

  const again = await importFilePacks(db, { files: library() });
  assert.deepEqual(again.modes[0].result, {
    imported: [], present: ["2026-10-19-market-gentle", "oaxaca/2026-10-20-mezcal"], invalid: ["Bad Name/2026-10-22-x"], folders: [],
  });
  assert.deepEqual(again.modes[1].result.present, ["2026-10-20-farm-first"]);
  assert.deepEqual(await db.select().from(packs), rowsAfterFirst, "nothing changed");

  // Deleted in the app (soft): the re-run must not bring it back.
  assert.equal(await deletePack(db, sam.id, "2026-10-19-market-gentle"), true);
  const third = await importFilePacks(db, { files: library() });
  assert.ok(third.modes[0].result.present.includes("2026-10-19-market-gentle"));
  assert.deepEqual(third.modes[0].result.imported, []);
  assert.deepEqual((await listPacks(db, sam.id)).packs.map((p) => p.id), ["oaxaca/2026-10-20-mezcal"]);
  assert.deepEqual((await listDeleted(db, sam.id)).map((d) => d.pack.id), ["2026-10-19-market-gentle"]);
  assert.match(formatImportReport(third, TREES)[1], /0 imported, 2 already there, 0 folders added/);
  assert.ok(formatImportReport(third, TREES).includes("  = 2026-10-19-market-gentle (already there)"));
});

test("import: a mode with no live learner is skipped and said so; nothing is created", async (t) => {
  const db = await setup(t);
  const robin = await createUser(db, { username: "robin", passwordHash: "x", isAdmin: true });
  const sam = await createLearner(db, robin.id, ADULT);
  const report = await importFilePacks(db, { files: library() });
  assert.equal(report.modes[1].learner, null);
  assert.equal(report.modes[1].result, undefined);
  assert.deepEqual(formatImportReport(report, TREES).at(-1), "kids (content/kids/packs/): skipped, robin has no kids learner (add one in the app, then re-run)");
  assert.equal((await db.select().from(packs)).filter((p) => p.learnerId !== sam.id).length, 0);
});

test("import: --user picks the account (admin or not) and its first learner of each mode; unknown names and no admin are errors", async (t) => {
  const db = await setup(t);
  await assert.rejects(importFilePacks(db, { files: library() }), /no admin account yet/);
  const lee = await createUser(db, { username: "lee", passwordHash: "x" });
  const first = await createLearner(db, lee.id, { ...ADULT, name: "Lee" });
  await createLearner(db, lee.id, { ...ADULT, name: "Second" });
  const report = await importFilePacks(db, { username: "lee", files: library() });
  assert.deepEqual(report.user, { id: lee.id, username: "lee", isAdmin: false });
  assert.equal(report.modes[0].learner.id, first.id);
  assert.equal(formatImportReport(report, TREES)[0], "packs → lee");
  await assert.rejects(importFilePacks(db, { username: "nobody", files: library() }), /no account named nobody/);
});

test("importPacks into a learner that already has a live pack at an id skips it, leaving that pack as it is", async (t) => {
  const db = await setup(t);
  const robin = await createUser(db, { username: "robin", passwordHash: "x", isAdmin: true });
  const sam = await createLearner(db, robin.id, ADULT);
  const files = library().adult;
  await importPacks(db, sam.id, { packs: [{ ...files.packs[0], title: "Edited in the app" }], folders: [] });
  const r = await importPacks(db, sam.id, files);
  assert.deepEqual(r.present, ["2026-10-19-market-gentle"]);
  assert.equal((await listPacks(db, sam.id)).packs.find((p) => p.id === "2026-10-19-market-gentle").title, "Edited in the app");
});

test("the first run seeds each learner with its mode's packs, in the same transaction as the admin", async (t) => {
  const db = await setup(t);
  const files = library();
  const user = await createFirstAdmin(db, { username: "robin", passwordHash: "x" }, {
    learners: [{ ...ADULT }, { ...KID }], voice: null, model: null, messages: [], packs: files,
  });
  const rows = await db.select().from(packs).orderBy(packs.slug);
  assert.equal(rows.length, 3);
  const { listLearners } = await import("../db/accounts.ts");
  const [sam, pip] = await listLearners(db, user.id);
  assert.deepEqual((await listPacks(db, sam.id)).packs.map((p) => p.id), ["2026-10-19-market-gentle", "oaxaca/2026-10-20-mezcal"]);
  assert.deepEqual((await listPacks(db, pip.id)).packs.map((p) => p.id), ["2026-10-20-farm-first"]);
  // No seed packs (an older caller): fine, none.
  const { db: db2, close } = await freshDb();
  t.after(close);
  await createFirstAdmin(db2, { username: "robin", passwordHash: "x" }, { learners: [{ ...ADULT }], voice: null, model: null, messages: [] });
  assert.deepEqual(await db2.select().from(packs), []);
});
