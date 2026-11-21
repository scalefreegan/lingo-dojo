// Migration 0014 (a phrase's stored reading hint, bead ld-op2, docs/DATA.md
// §Phrase bank) on PGlite, from a 0013 database with a phrase in it: it
// applies, the old row has no reading, one can be written, and the state is
// current. One ADD COLUMN of nullable text: nothing PostgreSQL 18 only, no
// rewrite, no default. Every name here is made up.
//   node --test scripts/tests/db-migration-0014.test.mjs

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

test("0014 on a 0013 database: phrases.reading, null on the rows already there", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, upTo('CREATE TABLE "picture_stock_concepts"', "0013"));
  const [user] = await query(`insert into users (username, password_hash, is_admin) values ('ada', 'scrypt$x', true) returning id`);
  const [learner] = await query(`insert into learners (user_id, name, mode, native_language) values ($1, 'Mei', 'adult', 'English') returning id`, [user.id]);
  const [profile] = await query(
    `insert into language_profiles (learner_id, target_language, target_variant, level) values ($1, 'Mandarin Chinese', 'Taiwanese Mandarin', 'A2') returning id`,
    [learner.id],
  );
  const add = (text) =>
    query(`insert into phrases (learner_id, language_profile_id, lang, text, norm, meaning, meaning_norm, source) values ($1, $2, 'zh-TW', $3, $3, 'x', 'x', 'gloss') returning id`, [learner.id, profile.id, text]);
  const [old] = await add("你得去");
  assert.deepEqual(await query(`select column_name from information_schema.columns where table_name = 'phrases' and column_name = 'reading'`), []);

  const through = upTo('ADD COLUMN "reading"', "0014");
  assert.equal(through.length, 15, "the fifteenth migration");
  await applyMigrations(query, through);
  assert.equal((await migrationState(query, through)).status, "current");
  assert.deepEqual(await query(`select data_type, is_nullable, column_default from information_schema.columns where table_name = 'phrases' and column_name = 'reading'`), [
    { data_type: "text", is_nullable: "YES", column_default: null },
  ]);
  assert.deepEqual(await query(`select reading from phrases where id = $1`, [old.id]), [{ reading: null }]);
  await query(`update phrases set reading = 'nǐ děi qù' where id = $1`, [old.id]);
  assert.deepEqual(await query(`select reading from phrases where id = $1`, [old.id]), [{ reading: "nǐ děi qù" }]);
});
