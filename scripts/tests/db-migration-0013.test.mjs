// Migration 0013 (the picture library's own stock concepts and the stock
// draw ledger, bead ld-318, docs/DATA.md §Stock pictures) on PGlite, from a
// 0012 database with an account: it applies, the checks hold, a deleted
// user leaves its concepts and ledger rows with no author, and the schema
// matches a fresh build. Two CREATE TABLEs, two foreign keys and an index:
// nothing PostgreSQL 18 only. Every name here is made up.
//   node --test scripts/tests/db-migration-0013.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";
import { catalog } from "./migration-0003.mjs";

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

test("0013 on a 0012 database: the stock concept and ledger tables, their checks, authors set null; schema as a fresh build", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, upTo('ADD COLUMN "stock_id"', "0012"));
  const [user] = await query(`insert into users (username, password_hash, is_admin) values ('ada', 'scrypt$x', true) returning id`);
  const through = upTo('CREATE TABLE "picture_stock_concepts"', "0013");
  await applyMigrations(query, through);
  assert.equal((await migrationState(query, through)).status, "current");

  const concept = (id, category, description, words) =>
    query(`insert into picture_stock_concepts (id, category, description, words, created_by) values ($1, $2, $3, $4, $5)`, [id, category, description, words, user.id]);
  await concept("ice-cream", "Food", "a cone of ice cream", ["ice cream"]);
  await assert.rejects(concept("Ice Cream", "Food", "x", ["x"]), /picture_stock_concepts_id/);
  await assert.rejects(concept("../x", "Food", "x", ["x"]), /picture_stock_concepts_id/);
  await assert.rejects(concept("kite", "", "x", ["x"]), /picture_stock_concepts_category/);
  await assert.rejects(concept("kite", "Toys", "x".repeat(81), ["x"]), /picture_stock_concepts_description/);
  await assert.rejects(concept("kite", "Toys", "a kite", []), /picture_stock_concepts_words/);
  await assert.rejects(concept("ice-cream", "Food", "again", ["x"]), /duplicate key/);

  await query(`insert into picture_stock_calls (user_id, concept_id) values ($1, 'ice-cream')`, [user.id]);
  await query(`insert into picture_stock_calls (user_id, concept_id, outcome) values ($1, 'ice-cream', 'ok')`, [user.id]);
  await assert.rejects(query(`insert into picture_stock_calls (concept_id, outcome) values ('x', 'maybe')`), /picture_stock_calls_outcome/);

  await query(`delete from users where id = $1`, [user.id]);
  assert.deepEqual(await query(`select id, created_by from picture_stock_concepts`), [{ id: "ice-cream", created_by: null }], "a concept outlives its author");
  assert.equal((await query(`select count(*)::int as n from picture_stock_calls where user_id is null`))[0].n, 2, "a paid call still counts");

  const built = await fresh(t);
  await applyMigrations(built.query, through);
  assert.deepEqual(await catalog(query), await catalog(built.query));
});
