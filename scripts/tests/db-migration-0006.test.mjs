// Migration 0006 (fill the gap's cloze_items) on PGlite, from a 0005
// database with a bank in use and a cloze row: every other row stays, the
// cloze row goes, the schema matches a fresh build and the reader role is
// still sound, with no access to cloze_items. The same check runs on
// PostgreSQL 17 in migration-0006.pg.test.mjs.
//   node --test scripts/tests/db-migration-0006.test.mjs

import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { READER_ROLE } from "../db/config.mjs";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateAndCheck0006, migrationsBefore0006, migrationsThrough0006, seedBefore0006 } from "./migration-0006.mjs";

const fresh = async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  return async (text, params) => (await pg.query(text, params)).rows;
};

test("0006 on a 0005 database with a bank and a cloze row: rows untouched but that one, schema as a fresh build, reader kept out", async (t) => {
  const query = await fresh(t);
  await applyMigrations(query, migrationsBefore0006());
  await seedBefore0006(query);
  const built = await fresh(t);
  await applyMigrations(built, migrationsThrough0006());
  await migrateAndCheck0006(query, built, READER_ROLE);
});
