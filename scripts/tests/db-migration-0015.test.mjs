// Migration 0015 (Mandarin readings, bead ld-4i2, docs/DATA.md §Reading
// corrections and §Shared readings) on PGlite, from a 0014 database: three
// new tables, nothing changed on the old ones; the constraints hold (one
// active reading per word and scope, a recap never "corrects", words of two
// to eight characters, a learner's rows go with their language). Plain
// CREATE TABLE / INDEX, a partial unique index: nothing PostgreSQL 18 only.
// Every name here is made up.
//   node --test scripts/tests/db-migration-0015.test.mjs

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

test("0015 on a 0014 database: reading_corrections, shared_readings, shared_reading_uses and their rules", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, upTo('ADD COLUMN "reading"', "0014"));
  const [user] = await query(`insert into users (username, password_hash, is_admin) values ('ada', 'scrypt$x', true) returning id`);
  const [learner] = await query(`insert into learners (user_id, name, mode, native_language) values ($1, 'Mei', 'adult', 'English') returning id`, [user.id]);
  const [profile] = await query(`insert into language_profiles (learner_id, target_language, target_variant) values ($1, 'Mandarin Chinese', 'Taiwanese Mandarin') returning id`, [learner.id]);

  const through = upTo('CREATE TABLE "shared_readings"', "0015");
  assert.equal(through.length, 16, "the sixteenth migration");
  await applyMigrations(query, through);
  assert.equal((await migrationState(query, through)).status, "current");

  const add = (key, reading, kind, source) =>
    query(`insert into reading_corrections (learner_id, language_profile_id, key, word, reading, kind, source) values ($1, $2, $3, $3, $4, $5, $6)`, [learner.id, profile.id, key, reading, kind, source]);
  await add("得去", "děi qù", "corrected", "user");
  await assert.rejects(add("得去", "dé qù", "confirmed", "user"), /reading_corrections_pk|duplicate/);
  await assert.rejects(add("一宿", "yī xiǔ", "corrected", "recap"), /reading_corrections_by_hand/);
  await add("一宿", "yī xiǔ", "suggested", "recap");
  await assert.rejects(add("得", "děi", "corrected", "user"), /reading_corrections_word/);

  const share = (reading, status) => query(`insert into shared_readings (key, word, reading, status, source) values ('倒车', '倒車', $1, $2, 'user')`, [reading, status]);
  await share("dào chē", "active");
  await share("dǎo chē", "suggested");
  await assert.rejects(share("dǎo chē", "active"), /shared_readings_entry|duplicate/);
  await assert.rejects(query(`update shared_readings set status = 'active' where reading = 'dǎo chē'`), /shared_readings_one_active|duplicate/);
  await assert.rejects(query(`insert into shared_readings (key, word, reading, status, source, scope) values ('倒车', '倒車', 'dào chē', 'active', 'user', 'hk')`), /shared_readings_scope/);
  // Another scope may have its own active reading.
  await query(`insert into shared_readings (key, word, reading, status, source, scope) values ('倒车', '倒車', 'dǎo chē', 'active', 'admin', 'tw')`);

  // A learner's rows go with their language; the shared list stays.
  await query(`delete from language_profiles where id = $1`, [profile.id]);
  assert.equal((await query(`select count(*)::int as n from reading_corrections`))[0].n, 0);
  assert.equal((await query(`select count(*)::int as n from shared_readings`))[0].n, 3);
  // A user deleted: their name leaves the list's rows, the rows stay.
  await query(`update shared_readings set suggested_by = $1, confirmed_by = $1`, [user.id]);
  await query(`delete from users where id = $1`, [user.id]);
  assert.deepEqual(await query(`select distinct suggested_by, confirmed_by from shared_readings`), [{ suggested_by: null, confirmed_by: null }]);
});
