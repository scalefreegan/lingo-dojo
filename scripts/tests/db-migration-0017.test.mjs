// Migration 0017 (the ledger of a kids session's background reading
// checks, bead ld-0mn, docs/DATA.md §Kids: resolving uncertain readings)
// on PGlite, from a 0016 database: one new table, nothing changed on the
// old ones; a row needs a language of its learner, goes with it, and holds
// counts only. Plain CREATE TABLE / INDEX: nothing PostgreSQL 18 only.
// Every name here is made up.
//   node --test scripts/tests/db-migration-0017.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";

const fresh = async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  return { query: async (text, params) => (await pg.query(text, params)).rows };
};
const upTo = (marker, what) => {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes(marker)));
  assert.ok(i >= 0, `${what} is on disk`);
  return disk.slice(0, i + 1);
};

test("0017 on a 0016 database: reading_check_calls, counts only, gone with the language", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, upTo('CREATE TABLE "shared_reading_votes"', "0016"));
  const [u] = await query(`insert into users (username, password_hash) values ('ada', 'scrypt$x') returning id`);
  const [l] = await query(`insert into learners (user_id, name, mode) values ($1, 'Pip', 'kids') returning id`, [u.id]);
  const [p] = await query(`insert into language_profiles (learner_id, target_language, target_variant, level) values ($1, 'Mandarin Chinese', 'Mainland Mandarin (Putonghua)', 'First words') returning id`, [l.id]);
  const [other] = await query(`insert into learners (user_id, name, mode) values ($1, 'Bo', 'kids') returning id`, [u.id]);

  const through = upTo('CREATE TABLE "reading_check_calls"', "0017");
  assert.equal(through.length, 18, "the eighteenth migration");
  await applyMigrations(query, through);
  assert.equal((await migrationState(query, through)).status, "current");

  const call = (learner, words, settled = null) => query(`insert into reading_check_calls (learner_id, language_profile_id, words, settled) values ($1, $2, $3, $4)`, [learner, p.id, words, settled]);
  await call(l.id, 3);
  await call(l.id, 2, 2);
  await assert.rejects(call(l.id, 0), /reading_check_calls_counts/);
  await assert.rejects(call(l.id, 1, -1), /reading_check_calls_counts/);
  await assert.rejects(call(other.id, 1), /reading_check_calls_profile_fk/, "the language must be the learner's");
  await query(`delete from language_profiles where id = $1`, [p.id]);
  assert.equal((await query(`select count(*)::int as n from reading_check_calls`))[0].n, 0, "gone with the language");
});
