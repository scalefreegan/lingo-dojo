// Migration 0018 (an admin's Adults only settings for the file's stock
// concepts, bead ld-cvd, docs/DATA.md §Adults only, set from the page) on
// PGlite, from a 0017 database: one new table, nothing changed on the old
// ones; a row per concept id (the id's check), the setter set null when the
// account goes. Plain CREATE TABLE / ALTER TABLE: nothing PostgreSQL 18
// only. Every name here is made up.
//   node --test scripts/tests/db-migration-0018.test.mjs

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

test("0018 on a 0017 database: picture_stock_adults, one row per concept id, the setter kept as provenance only", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, upTo('CREATE TABLE "reading_check_calls"', "0017"));
  const [u] = await query(`insert into users (username, password_hash, is_admin) values ('ada', 'scrypt$x', true) returning id`);
  await query(`insert into picture_stock_concepts (id, category, description, words, adults) values ('kite', 'Toys', 'a red kite', '{kite}', false)`);

  const through = upTo('CREATE TABLE "picture_stock_adults"', "0018");
  assert.equal(through.length, 19, "the nineteenth migration");
  await applyMigrations(query, through);
  assert.equal((await migrationState(query, through)).status, "current");
  assert.deepEqual(await query(`select id, adults from picture_stock_concepts`), [{ id: "kite", adults: false }], "the added concepts are untouched");

  const set = (id, adults, by = u.id) => query(`insert into picture_stock_adults (concept_id, adults, set_by) values ($1, $2, $3)`, [id, adults, by]);
  await set("dog", true);
  await set("beer", false, null);
  await assert.rejects(set("dog", false), /duplicate key|picture_stock_adults_pkey/, "one row per concept");
  await assert.rejects(set("Bad_Id", true), /picture_stock_adults_id/);
  await assert.rejects(query(`insert into picture_stock_adults (concept_id) values ('cat')`), /null value|not-null/, "the flag is stated");
  const [row] = await query(`select updated_at from picture_stock_adults where concept_id = 'dog'`);
  assert.ok(row.updated_at instanceof Date);
  await query(`delete from users where id = $1`, [u.id]);
  assert.deepEqual(await query(`select concept_id, adults, set_by from picture_stock_adults order by concept_id`), [
    { concept_id: "beer", adults: false, set_by: null },
    { concept_id: "dog", adults: true, set_by: null },
  ], "the setting outlives the account that made it");
});
