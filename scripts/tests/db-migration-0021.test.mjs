// Migration 0021 (a word's own drawing's look-alike group, bead ld-44x,
// docs/DATA.md §Kids word game) on PGlite, from a 0020 database: one
// nullable column on phrase_pictures, no default (every row there keeps
// none: its description's words decide, pictures.mjs ownLookAlike), and a
// value in pictures.yaml's group format (the check). Plain ALTER TABLE ADD
// COLUMN / ADD CONSTRAINT CHECK: nothing PostgreSQL 18 only.
//   node --test scripts/tests/db-migration-0021.test.mjs

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

test("0021 on a 0020 database: phrase_pictures.look_alike, nullable with no default, checked like pictures.yaml's group", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, upTo('CREATE TABLE "picture_pool_words"', "0020"));
  const through = upTo('"look_alike" text', "0021");
  assert.equal(through.length, 22, "the twenty-second migration");
  await applyMigrations(query, through);
  assert.equal((await migrationState(query, through)).status, "current");
  assert.deepEqual(
    await query(`select is_nullable, column_default, data_type from information_schema.columns where table_name = 'phrase_pictures' and column_name = 'look_alike'`),
    [{ is_nullable: "YES", column_default: null, data_type: "text" }],
  );
  const [c] = await query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'phrase_pictures_look_alike'`);
  assert.equal(c.def, "CHECK (((look_alike IS NULL) OR (look_alike ~ '^[a-z0-9][a-z0-9-]{0,47}$'::text)))");
  // The check itself, on a value alone (no phrase row needed).
  const ok = async (v) => (await query(`select ($1::text is null or $1::text ~ '^[a-z0-9][a-z0-9-]{0,47}$') as ok`, [v]))[0].ok;
  for (const v of ["bag", "red-fruit", "hot-drink-2", null]) assert.equal(await ok(v), true, String(v));
  for (const v of ["Bag", "two words", "-bag", "bad_id", "", "x".repeat(49)]) assert.equal(await ok(v), false, v);
});
