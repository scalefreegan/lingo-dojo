// Pack write races on a real Postgres (scripts/db/packs.ts). PGlite runs one
// transaction at a time and can't show them, so these run only when
// LINGO_TEST_PG_URL names a Postgres to connect to; skipped otherwise. Like
// first-run.pg.test.mjs, each test makes a throwaway database on that
// server, migrates it, races there, and drops it.
//
//   - Creates of one id at once: one pack, the rest become updates of it
//     (PUT writes "this pack at this id"), every write a revision, none lost.
//   - A move against a delete of the same pack: exactly one of them happens.
//   - Renames of different packs to one title: one gets the id, the rest 409.
//   - A folder delete against a save into that folder: the pack is never
//     left in a folder that is gone.
//   - Two undeletes of one pack, and an undelete against a restore: one
//     wins, the other is ESTATE, and the pack is never changed twice.
//
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/packs.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../db/migrations.mjs";
import * as schema from "../db/schema.ts";
import { createLearner, createUser } from "../db/accounts.ts";
import { deleteFolder, deletePack, getPack, listDeleted, listPacks, listRevisions, movePack, renamePack, restoreRevision, savePack, undeletePack } from "../db/packs.ts";
import { ADULT } from "./http-session.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";

/** A migrated throwaway database on the URL's server, with one learner, for `fn`; dropped after. */
async function withLearner(fn) {
  const name = `lingo_dojo_test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: 16 });
  try {
    await applyMigrations(async (text, params) => (await pool.query(text, params)).rows);
    const db = drizzle(pool, { schema });
    const user = await createUser(db, { username: "racer", passwordHash: "x" });
    const learner = await createLearner(db, user.id, ADULT);
    await fn(pool, db, learner.id);
  } finally {
    await pool.end();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
}

const settle = (ps) => Promise.allSettled(ps);
const codes = (results) => results.filter((r) => r.status === "rejected").map((r) => r.reason?.code ?? String(r.reason));

test("12 creates of one id at once, repeated: one live pack, every write a revision", { skip }, async () => {
  await withLearner(async (pool, db, learnerId) => {
    for (let round = 0; round < 5; round++) {
      const id = `2026-10-2${round}-race`;
      const results = await settle(Array.from({ length: 12 }, (_, i) => savePack(db, learnerId, id, { title: `T${i}`, notes: String(i) })));
      assert.deepEqual(codes(results), [], `round ${round}: no write failed`);
      assert.equal(results.filter((r) => r.value.created).length, 1, `round ${round}: one create`);
      const { rows } = await pool.query("select id from packs where slug = $1 and deleted_at is null", [id]);
      assert.equal(rows.length, 1, `round ${round}: one live pack`);
      const revs = await pool.query("select action from pack_revisions where pack_id = $1", [rows[0].id]);
      assert.equal(revs.rows.length, 12, `round ${round}: twelve revisions`);
      assert.equal(revs.rows.filter((r) => r.action === "create").length, 1);
    }
  });
});

test("a move and a delete of one pack at once, repeated: exactly one of them happens", { skip }, async () => {
  await withLearner(async (pool, db, learnerId) => {
    for (let round = 0; round < 10; round++) {
      const id = `2026-10-01-r${round}`;
      await savePack(db, learnerId, id, { title: "R" });
      const [moved, deleted] = await settle([movePack(db, learnerId, id, "elsewhere"), deletePack(db, learnerId, id)]);
      const moveOk = moved.status === "fulfilled";
      const deleteOk = deleted.status === "fulfilled" && deleted.value === true;
      assert.ok(moveOk !== deleteOk, `round ${round}: move ${moved.status}${moveOk ? "" : ` (${moved.reason?.code})`}, delete ${deleted.value}`);
      if (!moveOk) assert.equal(moved.reason.code, "ENOENT");
      const live = (await listPacks(db, learnerId)).packs.filter((p) => p.id.endsWith(`r${round}`));
      assert.deepEqual(live.map((p) => p.id), moveOk ? [`elsewhere/${id}`] : []);
    }
  });
});

test("renames of different packs to one title at once: one gets the id, the rest are EEXIST", { skip }, async () => {
  await withLearner(async (_pool, db, learnerId) => {
    for (let i = 0; i < 8; i++) await savePack(db, learnerId, `2026-10-02-p${i}`, { title: `P${i}` });
    const results = await settle(Array.from({ length: 8 }, (_, i) => renamePack(db, learnerId, `2026-10-02-p${i}`, "Same")));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.deepEqual([...new Set(codes(results))], ["EEXIST"]);
    const ids = (await listPacks(db, learnerId)).packs.map((p) => p.id);
    assert.equal(ids.filter((id) => id === "2026-10-02-same").length, 1);
    assert.equal(ids.length, 8, "no pack lost");
  });
});

test("a folder delete and a save into it at once, repeated: the pack's folder always exists", { skip }, async () => {
  await withLearner(async (pool, db, learnerId) => {
    for (let round = 0; round < 10; round++) {
      const folder = `f${round}`;
      await pool.query("insert into pack_folders (learner_id, name) values ($1, $2)", [learnerId, folder]);
      const [del, save] = await settle([deleteFolder(db, learnerId, folder), savePack(db, learnerId, `${folder}/2026-10-03-x`, { title: "X" })]);
      assert.equal(save.status, "fulfilled", `round ${round}: the save stands`);
      if (del.status === "rejected") assert.equal(del.reason.code, "ENOTEMPTY");
      const { rows } = await pool.query("select 1 from pack_folders where learner_id = $1 and name = $2", [learnerId, folder]);
      assert.equal(rows.length, 1, `round ${round}: the folder row is there for the pack in it`);
    }
  });
});

test("two undeletes of one pack at once, repeated: one brings it back, the other is ESTATE", { skip }, async () => {
  await withLearner(async (pool, db, learnerId) => {
    for (let round = 0; round < 10; round++) {
      const id = `f${round}/2026-10-03-u${round}`;
      await savePack(db, learnerId, id, { title: "U", notes: "as deleted" });
      await deletePack(db, learnerId, id);
      await deleteFolder(db, learnerId, `f${round}`);
      const [d] = (await listDeleted(db, learnerId)).items.filter((x) => x.pack.id === id);
      const results = await settle([undeletePack(db, learnerId, d.revision), undeletePack(db, learnerId, d.revision)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `round ${round}`);
      assert.deepEqual(codes(results), ["ESTATE"]);
      const { rows } = await pool.query("select count(*)::int as n from pack_revisions where action = 'restore' and snapshot->>'id' = $1", [id]);
      assert.equal(rows[0].n, 1, "one restore recorded");
      assert.ok((await listPacks(db, learnerId)).folders.includes(`f${round}`), "its folder is back");
    }
  });
});

test("an undelete and a restore of one pack at once, repeated: the restore never lands on a deleted pack", { skip }, async () => {
  await withLearner(async (_pool, db, learnerId) => {
    for (let round = 0; round < 10; round++) {
      const id = `2026-10-04-v${round}`;
      await savePack(db, learnerId, id, { title: "V", notes: "v1" });
      const [v1] = (await listRevisions(db, learnerId, { id })).items;
      await savePack(db, learnerId, id, { title: "V", notes: "v2" });
      await deletePack(db, learnerId, id);
      const [d] = (await listDeleted(db, learnerId)).items.filter((x) => x.pack.id === id);
      const [un, re] = await settle([undeletePack(db, learnerId, d.revision), restoreRevision(db, learnerId, v1.revision)]);
      assert.equal(un.status, "fulfilled", `round ${round}: the undelete always succeeds`);
      const notes = (await getPack(db, learnerId, id)).notes;
      if (re.status === "fulfilled") assert.equal(notes, "v1", "restore after the undelete");
      else {
        assert.equal(re.reason.code, "ESTATE", "restore before the undelete is refused");
        assert.equal(notes, "v2");
      }
    }
  });
});
