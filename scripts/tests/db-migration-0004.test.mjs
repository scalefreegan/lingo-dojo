// Migration 0004 (the session recap's columns) on PGlite, from a 0003
// database with conversations, turns and a bank in use: every row stays,
// the new columns take their defaults, and the schema matches a fresh
// build. The same check runs on PostgreSQL 17 in migration-0004.pg.test.mjs.
//   node --test scripts/tests/db-migration-0004.test.mjs

import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateAndCheck0004, migrationsBefore0004, migrationsThrough0004, seedBefore0004 } from "./migration-0004.mjs";

const fresh = async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  return async (text, params) => (await pg.query(text, params)).rows;
};

test("0004 on a 0003 database with conversations, turns and a bank: rows untouched, defaults filled, schema as a fresh build", async (t) => {
  const query = await fresh(t);
  await applyMigrations(query, migrationsBefore0004());
  await seedBefore0004(query);
  const built = await fresh(t);
  await applyMigrations(built, migrationsThrough0004());
  await migrateAndCheck0004(query, built);
});
