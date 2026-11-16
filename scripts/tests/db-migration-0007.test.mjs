// Migration 0007 (a pack's random scene) on PGlite, from a 0006 database
// with packs: every row stays, random_scene is null on each, the packs read
// back through the pack layer as before, and the schema matches a fresh
// build. The same check runs on PostgreSQL 17 in migration-0007.pg.test.mjs.
//   node --test scripts/tests/db-migration-0007.test.mjs

import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { applyMigrations } from "../db/migrations.mjs";
import { listPacks } from "../db/packs.ts";
import * as schema from "../db/schema.ts";
import { migrateAndCheck0007, migrationsBefore0007, migrationsThrough0007, seedBefore0007 } from "./migration-0007.mjs";

const fresh = async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  return { pg, query: async (text, params) => (await pg.query(text, params)).rows };
};

test("0007 on a 0006 database with packs: rows untouched, random_scene null, packs read back as before, schema as a fresh build", async (t) => {
  const { pg, query } = await fresh(t);
  await applyMigrations(query, migrationsBefore0007());
  await seedBefore0007(query);
  const built = await fresh(t);
  await applyMigrations(built.query, migrationsThrough0007());
  const db = drizzle(pg, { schema });
  await migrateAndCheck0007(query, built.query, (profile) => listPacks(db, profile));
});
