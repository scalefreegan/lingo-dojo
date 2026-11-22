// Migration 0020 (the shared picture pool, bead ld-ec9, docs/DATA.md §The
// shared picture pool) on PGlite, from a 0019 database: a phrase's source
// may be `picture`; a picture row's kids verdict; a stock concept's origin
// (an admin's, as every row there stays, or a shared drawing with its
// source file); the pool's words, levels and naming ledger. Plain CREATE
// TABLE / ALTER TABLE ADD COLUMN / ADD CONSTRAINT: nothing PostgreSQL 18
// only. Every name here is made up.
//   node --test scripts/tests/db-migration-0020.test.mjs

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
const FILE = "a".repeat(64);

test("0020 on a 0019 database: the rows there are an admin's concepts; a drawing needs its file; the pool's tables checked", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, upTo('"look_alike_group"', "0019"));
  await query(`insert into picture_stock_concepts (id, category, description, words) values ('kite', 'Toys', 'a red kite', '{kite}')`);

  const through = upTo('CREATE TABLE "picture_pool_words"', "0020");
  assert.equal(through.length, 21, "the twenty-first migration");
  await applyMigrations(query, through);
  assert.equal((await migrationState(query, through)).status, "current");
  assert.deepEqual(await query(`select id, origin, source_file, kids_safe from picture_stock_concepts`), [{ id: "kite", origin: "admin", source_file: null, kids_safe: null }]);

  // A shared drawing: its source file, a kids verdict or none yet; once only per file.
  const drawing = (id, file, safe = null) => query(`insert into picture_stock_concepts (id, category, description, words, origin, source_file, kids_safe) values ($1, 'Drawn by learners', 'a blue kite', '{kite}', 'drawing', $2, $3)`, [id, file, safe]);
  await drawing("drawn-0123456789abcdef", FILE);
  await assert.rejects(drawing("drawn-1123456789abcdef", FILE), /picture_stock_concepts_source_file/);
  await assert.rejects(drawing("drawn-2123456789abcdef", "nope"), /picture_stock_concepts_origin/);
  await assert.rejects(drawing("drawn-3123456789abcdef", null), /picture_stock_concepts_origin/);
  await assert.rejects(query(`update picture_stock_concepts set kids_safe = true where id = 'kite'`), /picture_stock_concepts_origin/, "an admin's concept has no kids verdict");
  await query(`update picture_stock_concepts set kids_safe = false where id = 'drawn-0123456789abcdef'`);

  // The pool's words and levels.
  await query(`insert into picture_pool_words (concept_id, key, text) values ('kite', 'de', 'der Drachen'), ('kite', 'zh-TW', '風箏')`);
  await assert.rejects(query(`insert into picture_pool_words (concept_id, key, text) values ('kite', 'de', 'again')`), /picture_pool_words_pk/);
  await assert.rejects(query(`insert into picture_pool_words (concept_id, key, text) values ('kite', 'german', 'x')`), /picture_pool_words_key/);
  await assert.rejects(query(`insert into picture_pool_words (concept_id, key, text) values ('kite', 'fr', '')`), /picture_pool_words_text/);
  await assert.rejects(query(`insert into picture_pool_words (concept_id, key, text) values ('Kite!', 'fr', 'x')`), /picture_pool_words_concept/);
  await query(`insert into picture_pool_levels (concept_id, level) values ('kite', 'A2')`);
  await assert.rejects(query(`insert into picture_pool_levels (concept_id, level) values ('drawn-0123456789abcdef', 'C1')`), /picture_pool_levels_level/);

  // The naming ledger: a user's call, kept when the user goes.
  await query(`insert into picture_pool_calls (concepts) values (3)`);
  await assert.rejects(query(`insert into picture_pool_calls (concepts) values (0)`), /picture_pool_calls_concepts/);
  await assert.rejects(query(`insert into picture_pool_calls (concepts, outcome) values (1, 'maybe')`), /picture_pool_calls_outcome/);

  // A phrase may come from the picture game; kids_safe on a picture row is a plain nullable column.
  const [{ constraint }] = await query(`select pg_get_constraintdef(oid) as constraint from pg_constraint where conname = 'phrases_source'`);
  assert.match(constraint, /'picture'/);
  assert.deepEqual(await query(`select is_nullable, data_type from information_schema.columns where table_name = 'phrase_pictures' and column_name = 'kids_safe'`), [{ is_nullable: "YES", data_type: "boolean" }]);
});
