// The pack data layer on PGlite (scripts/db/packs.ts) and the file →
// database import behind `npm run db:import` (scripts/db/import.ts): both
// modes, a re-run, a missing learner, a pack deleted in the app, the target
// account. The pack files are a temp copy of the fixture library; nothing
// here reads or writes the real content/.
//   node --test scripts/tests/packs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { loadPackFiles } from "../content.mjs";
import { createFirstAdmin, createLanguageProfile, createLearner, createUser, defaultLanguageProfile, disableUser } from "../db/accounts.ts";
import { formatImportReport, importFilePacks } from "../db/import.ts";
import { deletePack, importPacks, listDeleted, listPacks, movePack, renamePack } from "../db/packs.ts";
import { languageProfiles, packRevisions, packs } from "../db/schema.ts";
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

/** A learner made by createLearner (which returns its first language) as the
 *  language-profile ref the pack functions take. */
const ref = (l) => ({ id: l.language.id, learnerId: l.id });

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
    failed: [],
    folders: ["empty", "oaxaca"],
  });
  assert.equal(adult.unreadable.length, 1);
  assert.match(adult.unreadable[0].file, /2026-10-21-broken\.yaml$/);
  assert.deepEqual(kids.result.imported, ["2026-10-20-farm-first"]);

  const samPacks = await listPacks(db, ref(sam));
  assert.deepEqual(samPacks.folders, ["empty", "oaxaca"]);
  const mezcal = samPacks.packs.find((p) => p.id === "oaxaca/2026-10-20-mezcal");
  assert.deepEqual([mezcal.folder, mezcal.title, mezcal.created, mezcal.units], ["oaxaca", "Mezcal", "2026-10-20T10:00:00-06:00", ["intro-native"]]);
  assert.equal(samPacks.packs.find((p) => p.id === "2026-10-19-market-gentle").overrides.level, "B1");
  assert.deepEqual((await listPacks(db, ref(pip))).packs.map((p) => p.id), ["2026-10-20-farm-first"]);
  const revs = await db.select().from(packRevisions).where(eq(packRevisions.learnerId, sam.id));
  assert.deepEqual(revs.map((r) => r.action), ["import", "import"]);

  assert.deepEqual(formatImportReport(report, TREES), [
    "packs → robin (admin)",
    "adult (content/packs/) → Sam (Spanish · A2): 2 imported, 0 already there, 2 folders added, 1 invalid, 1 unreadable file",
    "  + 2026-10-19-market-gentle",
    "  + oaxaca/2026-10-20-mezcal",
    "  + folder empty",
    "  + folder oaxaca",
    "  ! Bad Name/2026-10-22-x: not a valid pack id, no title, or a NUL character; skipped",
    `  ! ${adult.unreadable[0].file}: ${adult.unreadable[0].message}; skipped`,
    "kids (content/kids/packs/) → Pip (German · First words): 1 imported, 0 already there, 0 folders added",
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
    imported: [], present: ["2026-10-19-market-gentle", "oaxaca/2026-10-20-mezcal"], invalid: ["Bad Name/2026-10-22-x"], failed: [], folders: [],
  });
  assert.deepEqual(again.modes[1].result.present, ["2026-10-20-farm-first"]);
  assert.deepEqual(await db.select().from(packs), rowsAfterFirst, "nothing changed");

  // Deleted in the app (soft): the re-run must not bring it back.
  assert.equal(await deletePack(db, ref(sam), "2026-10-19-market-gentle"), true);
  const third = await importFilePacks(db, { files: library() });
  assert.ok(third.modes[0].result.present.includes("2026-10-19-market-gentle"));
  assert.deepEqual(third.modes[0].result.imported, []);
  assert.deepEqual((await listPacks(db, ref(sam))).packs.map((p) => p.id), ["oaxaca/2026-10-20-mezcal"]);
  assert.deepEqual((await listDeleted(db, ref(sam))).items.map((d) => d.pack.id), ["2026-10-19-market-gentle"]);
  assert.match(formatImportReport(third, TREES)[1], /0 imported, 2 already there, 0 folders added/);
  assert.ok(formatImportReport(third, TREES).includes("  = 2026-10-19-market-gentle (already there)"));
});

test("import: a re-run after the app renamed, moved and deleted the imported packs adds nothing back", async (t) => {
  const db = await setup(t);
  const robin = await createUser(db, { username: "robin", passwordHash: "x", isAdmin: true });
  const sam = await createLearner(db, robin.id, ADULT);
  const files = {
    packs: [
      { id: "2026-10-01-one", folder: "", title: "One" },
      { id: "2026-10-02-two", folder: "", title: "Two" },
      { id: "2026-10-03-three", folder: "", title: "Three" },
    ],
    folders: [],
  };
  assert.equal((await importPacks(db, ref(sam), files)).imported.length, 3);
  await renamePack(db, ref(sam), "2026-10-01-one", "Uno");
  await movePack(db, ref(sam), "2026-10-02-two", "kept");
  await deletePack(db, ref(sam), "2026-10-03-three");
  const before = (await listPacks(db, ref(sam))).packs.map((p) => p.id);
  assert.deepEqual(before, ["2026-10-01-uno", "kept/2026-10-02-two"]);
  const again = await importPacks(db, ref(sam), files);
  assert.deepEqual(again.imported, []);
  assert.deepEqual(again.present, ["2026-10-01-one", "2026-10-02-two", "2026-10-03-three"]);
  assert.deepEqual((await listPacks(db, ref(sam))).packs.map((p) => p.id), before);
  assert.equal((await db.select().from(packs)).length, 3, "no new row");
});

test("import: a pack with a NUL is invalid and one the database refuses is failed; the rest still import, and a first run still succeeds", async (t) => {
  const db = await setup(t);
  // A stand-in for any database refusal of one pack (a constraint the seed breaks).
  await db.execute(sql`alter table packs add constraint test_no_boom check (title <> 'Boom')`);
  const files = {
    packs: [
      { id: "2026-10-01-ok", folder: "", title: "Fine" },
      { id: "2026-10-02-nul", folder: "", title: "Has a \u0000 in it" },
      { id: "2026-10-03-nul-key", folder: "", title: "Key", overrides: { "a\u0000": "x" } },
      { id: "boomed/2026-10-04-boom", folder: "boomed", title: "Boom" },
      { id: "2026-10-05-after", folder: "", title: "After" },
    ],
    folders: [],
  };
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  const user = await createFirstAdmin(db, { username: "robin", passwordHash: "x" }, {
    learners: [{ ...ADULT }], voice: null, model: null, messages: [], packs: { adult: files },
  });
  assert.ok(user, "the admin was created");
  const { listLearners } = await import("../db/accounts.ts");
  const [sam] = await listLearners(db, user.id);
  sam.language = await defaultLanguageProfile(db, sam.id);
  const listed = await listPacks(db, ref(sam));
  assert.deepEqual(listed.packs.map((p) => p.id), ["2026-10-01-ok", "2026-10-05-after"]);
  assert.deepEqual(listed.folders, [], "the refused pack left no folder");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /boomed\/2026-10-04-boom skipped/);

  const r = await importPacks(db, ref(sam), files);
  assert.deepEqual(r.invalid, ["2026-10-02-nul", "2026-10-03-nul-key"]);
  assert.deepEqual(r.failed, ["boomed/2026-10-04-boom"]);
  assert.deepEqual(r.present, ["2026-10-01-ok", "2026-10-05-after"]);
  const report = { user: { id: user.id, username: "robin", isAdmin: true }, modes: [{ mode: "adult", learner: { id: sam.id, name: "Sam" }, result: r, unreadable: [] }] };
  const lines = formatImportReport(report, TREES);
  assert.match(lines[1], /2 invalid, 1 failed/);
  assert.ok(lines.includes("  ! boomed/2026-10-04-boom: the database refused it (logged above); skipped"));
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
  // A disabled account is refused by name, not silently filled.
  await disableUser(db, "lee");
  const rowsBefore = (await db.select().from(packs)).length;
  await assert.rejects(importFilePacks(db, { username: "lee", files: library() }), /account lee is disabled; `npm run user -- enable lee` first/);
  assert.equal((await db.select().from(packs)).length, rowsBefore);
});

test("importPacks into a learner that already has a live pack at an id skips it, leaving that pack as it is", async (t) => {
  const db = await setup(t);
  const robin = await createUser(db, { username: "robin", passwordHash: "x", isAdmin: true });
  const sam = await createLearner(db, robin.id, ADULT);
  const files = library().adult;
  await importPacks(db, ref(sam), { packs: [{ ...files.packs[0], title: "Edited in the app" }], folders: [] });
  const r = await importPacks(db, ref(sam), files);
  assert.deepEqual(r.present, ["2026-10-19-market-gentle"]);
  assert.equal((await listPacks(db, ref(sam))).packs.find((p) => p.id === "2026-10-19-market-gentle").title, "Edited in the app");
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
  for (const l of [sam, pip]) l.language = await defaultLanguageProfile(db, l.id);
  assert.deepEqual((await listPacks(db, ref(sam))).packs.map((p) => p.id), ["2026-10-19-market-gentle", "oaxaca/2026-10-20-mezcal"]);
  assert.deepEqual((await listPacks(db, ref(pip))).packs.map((p) => p.id), ["2026-10-20-farm-first"]);
  // No seed packs (an older caller): fine, none.
  const { db: db2, close } = await freshDb();
  t.after(close);
  await createFirstAdmin(db2, { username: "robin", passwordHash: "x" }, { learners: [{ ...ADULT }], voice: null, model: null, messages: [] });
  assert.deepEqual(await db2.select().from(packs), []);
});

test("import: a learner with two languages gets the packs in its oldest one, whichever it used last; a re-run after it took up another language adds nothing anywhere", async (t) => {
  const db = await setup(t);
  const robin = await createUser(db, { username: "robin", passwordHash: "x", isAdmin: true });
  const sam = await createLearner(db, robin.id, ADULT);
  const spanish = ref(sam);
  const german = await createLanguageProfile(db, sam.id, { targetLanguage: "German", level: "B1" });
  // German is the one used last: the import still goes to Spanish, the oldest.
  await db.update(languageProfiles).set({ lastUsedAt: new Date() }).where(eq(languageProfiles.id, german.id));

  const first = await importFilePacks(db, { files: library() });
  assert.deepEqual(first.modes[0].language, { id: spanish.id, targetLanguage: "Spanish", level: "A2" });
  assert.match(formatImportReport(first, TREES)[1], /→ Sam \(Spanish · A2\): 2 imported/);
  assert.deepEqual((await listPacks(db, spanish)).packs.map((p) => p.id), ["2026-10-19-market-gentle", "oaxaca/2026-10-20-mezcal"]);
  assert.deepEqual(await listPacks(db, german), { packs: [], folders: [] }, "the other language gets nothing");
  const rowsAfterFirst = (await db.select().from(packs)).length;

  // Another language added and picked since: a re-run adds nothing, there or anywhere.
  const chinese = await createLanguageProfile(db, sam.id, { targetLanguage: "Mandarin Chinese", level: "A1" });
  await db.update(languageProfiles).set({ lastUsedAt: new Date(Date.now() + 1000) }).where(eq(languageProfiles.id, chinese.id));
  const again = await importFilePacks(db, { files: library() });
  assert.deepEqual(again.modes[0].result.imported, []);
  assert.equal((await db.select().from(packs)).length, rowsAfterFirst, "no new pack row");

  // Even when the packs went to a language that is not the oldest any more
  // (Spanish archived): imported once per learner, never again.
  await db.update(languageProfiles).set({ archivedAt: new Date() }).where(eq(languageProfiles.id, spanish.id));
  const third = await importFilePacks(db, { files: library() });
  assert.equal(third.modes[0].language.id, german.id, "the oldest live one now");
  assert.deepEqual(third.modes[0].result.imported, []);
  assert.deepEqual(third.modes[0].result.present, ["2026-10-19-market-gentle", "oaxaca/2026-10-20-mezcal"]);
  assert.equal((await db.select().from(packs)).length, rowsAfterFirst);
});
