// Migration 0008 (revisit) on PGlite, from a 0007 database with sessions:
// every row stays, each gets its scene key (the SQL backfill agrees with
// scripts/revisit.mjs sceneKey), and the schema matches a fresh build. The
// same check runs on PostgreSQL 17 in migration-0008.pg.test.mjs.
//   node --test scripts/tests/db-migration-0008.test.mjs

import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateAndCheck0008, migrationsBefore0008, migrationsThrough0008, seedBefore0008 } from "./migration-0008.mjs";

const fresh = async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  return { pg, query: async (text, params) => (await pg.query(text, params)).rows };
};

test("0008 on a 0007 database with sessions: rows untouched, scene keys as the app gives them, schema as a fresh build", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, migrationsBefore0008());
  await seedBefore0008(query);
  const built = await fresh(t);
  await applyMigrations(built.query, migrationsThrough0008());
  await migrateAndCheck0008(query, built.query);
});
