// Migration 0022 (pronunciation in sessions, bead ld-ne0.3, docs/DATA.md
// §Pronunciation in sessions) on PGlite, from a 0021 database: one new table,
// pronunciation_checks, a row per scored learner turn, owned through the
// language profile and reaching its conversation and its turn through
// (id, language_profile_id), cascading from both; a clip's three columns
// only together and only with a flag, its file name a uuid this app made.
// Plain CREATE TABLE / ADD CONSTRAINT / CREATE INDEX: nothing PostgreSQL 18
// only (checked on a PostgreSQL 17 scratch database by hand; see the PR).
//   node --test scripts/tests/db-migration-0022.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";
import { freshDb } from "./testdb.mjs";
import { ADULT, addUser } from "./http-session.mjs";

const upTo = (marker, what) => {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes(marker)));
  assert.ok(i >= 0, `${what} is on disk`);
  return disk.slice(0, i + 1);
};

test("0022 on a 0021 database: the pronunciation_checks table, empty, with its keys and indexes", async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  const query = async (text, params) => (await pg.query(text, params)).rows;
  await applyMigrations(query, upTo('"look_alike" text', "0021"));
  const through = upTo('CREATE TABLE "pronunciation_checks"', "0022");
  assert.equal(through.length, 23, "the twenty-third migration");
  await applyMigrations(query, through);
  assert.equal((await migrationState(query, through)).status, "current");
  assert.deepEqual(await query("select count(*)::int as n from pronunciation_checks"), [{ n: 0 }]);
  const cons = (await query(`select conname, confdeltype from pg_constraint where conrelid = 'pronunciation_checks'::regclass and contype = 'f' order by 1`)).map((r) => [r.conname, r.confdeltype]);
  assert.deepEqual(cons, [
    ["pronunciation_checks_conversation_fk", "c"],
    ["pronunciation_checks_profile_fk", "c"],
    ["pronunciation_checks_turn_fk", "c"],
  ]);
  const idx = (await query(`select indexname from pg_indexes where tablename = 'pronunciation_checks' order by 1`)).map((r) => r.indexname);
  assert.deepEqual(idx, ["pronunciation_checks_conversation_idx", "pronunciation_checks_pkey", "pronunciation_checks_profile_idx", "pronunciation_checks_turn"]);
  // Not a table the content agent's reader sees: no row-level security.
  assert.deepEqual(await query(`select relrowsecurity from pg_class where relname = 'pronunciation_checks'`), [{ relrowsecurity: false }]);
});

test("its checks: owner-consistent, a clip only with a flag and a uuid name, gone with the turn or the conversation", async (t) => {
  const testDb = await freshDb();
  t.after(() => testDb.close());
  const { query } = testDb;
  const { learners } = await addUser(testDb.db, "tones", undefined, { learners: [ADULT, { ...ADULT, name: "Ana" }] });
  const [sam, ana] = learners;
  const conversation = async (l) =>
    (await query(`insert into conversations (learner_id, language_profile_id, pack_snapshot, title, mode, target_language) values ($1, $2, '{}', 'Tones', 'adult', 'Mandarin Chinese') returning id`, [l.id, l.language.id]))[0].id;
  const turn = async (l, conv, idx) =>
    (await query(`insert into turns (conversation_id, learner_id, language_profile_id, idx, role, text) values ($1, $2, $3, $4, 'learner', '妈') returning id`, [conv, l.id, l.language.id, idx]))[0].id;
  const conv = await conversation(sam);
  const t0 = await turn(sam, conv, 0);
  const file = "0f8fad5b-d9cb-469f-a165-70867728950e.wav";
  const insert = (l, c, tid, extra = {}) => {
    const v = { engine: "local", coaching: "light", flagged: 1, clip_file: file, clip_bytes: 1000, clip_ms: 900, ...extra };
    return query(
      `insert into pronunciation_checks (learner_id, language_profile_id, conversation_id, turn_id, engine, coaching, syllables, flagged, clip_file, clip_bytes, clip_ms) values ($1, $2, $3, $4, $5, $6, '[]', $7, $8, $9, $10) returning id`,
      [l.id, l.language.id, c, tid, v.engine, v.coaching, v.flagged, v.clip_file, v.clip_bytes, v.clip_ms],
    );
  };
  await insert(sam, conv, t0);
  await assert.rejects(insert(sam, conv, t0), /pronunciation_checks_turn/, "one check per turn");
  const t1 = await turn(sam, conv, 1);
  for (const [bad, why] of [
    [{ flagged: 0 }, "a clip without a flag"],
    [{ clip_file: "../../etc/passwd" }, "a path"],
    [{ clip_file: "x.wav" }, "not a uuid"],
    [{ clip_bytes: null }, "a clip's columns go together"],
    [{ coaching: "off" }, "off is never scored"],
    [{ engine: "speechsuper" }, "an engine"],
    [{ flagged: -1, clip_file: null, clip_bytes: null, clip_ms: null }, "a count"],
  ]) await assert.rejects(insert(sam, conv, t1, bad), /violates check constraint/, why);
  await insert(sam, conv, t1, { flagged: 0, clip_file: null, clip_bytes: null, clip_ms: null });
  // Another learner can't hang a check on this conversation or its turn.
  await assert.rejects(insert(ana, conv, await turn(sam, conv, 2)), /foreign key/);
  // The turn's delete takes its check; the conversation's takes the rest.
  await query("delete from turns where id = $1", [t1]);
  assert.equal((await query("select count(*)::int as n from pronunciation_checks"))[0].n, 1);
  await query("delete from conversations where id = $1", [conv]);
  assert.equal((await query("select count(*)::int as n from pronunciation_checks"))[0].n, 0);
});
