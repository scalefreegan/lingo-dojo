// Migration 0007 (a pack's random scene) on a real Postgres (the app runs
// Homebrew's PostgreSQL 17; PGlite, the rest of the suite, is 18): runs
// only when LINGO_TEST_PG_URL names a server, skipped otherwise. A
// throwaway database (pg-scratch.mjs) is migrated to 0006, given packs, and
// migrated on (migration-0007.mjs).
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/migration-0007.pg.test.mjs

import { test } from "node:test";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateAndCheck0007, migrationsBefore0007, migrationsThrough0007, seedBefore0007 } from "./migration-0007.mjs";
import { scratchDatabase } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";

async function scratch(t) {
  const db = await scratchDatabase(url, "m0007");
  t.after(db.drop);
  return db;
}

test("0007 on a 0006 database with packs, on real Postgres: rows untouched, random_scene null, schema as a fresh build", { skip }, async (t) => {
  const db = await scratch(t);
  console.log(`migration 0007 on PostgreSQL ${(await db.query("show server_version_num"))[0].server_version_num}`);
  await applyMigrations(db.query, migrationsBefore0007());
  await seedBefore0007(db.query);
  const built = await scratch(t);
  await applyMigrations(built.query, migrationsThrough0007());
  await migrateAndCheck0007(db.query, built.query);
});
