// Migration 0008 (revisit) on a real Postgres (the app runs Homebrew's
// PostgreSQL 17; PGlite, the rest of the suite, is 18): runs only when
// LINGO_TEST_PG_URL names a server, skipped otherwise. A throwaway
// database (pg-scratch.mjs) is migrated to 0007, given sessions, and
// migrated on (migration-0008.mjs).
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/migration-0008.pg.test.mjs

import { test } from "node:test";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateAndCheck0008, migrationsBefore0008, migrationsThrough0008, seedBefore0008 } from "./migration-0008.mjs";
import { scratchDatabase } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";

async function scratch(t) {
  const db = await scratchDatabase(url, "m0008");
  t.after(db.drop);
  return db;
}

test("0008 on a 0007 database with sessions, on real Postgres: rows untouched, scene keys as the app gives them, schema as a fresh build", { skip }, async (t) => {
  const db = await scratch(t);
  console.log(`migration 0008 on PostgreSQL ${(await db.query("show server_version_num"))[0].server_version_num}`);
  await applyMigrations(db.query, migrationsBefore0008());
  await seedBefore0008(db.query);
  const built = await scratch(t);
  await applyMigrations(built.query, migrationsThrough0008());
  await migrateAndCheck0008(db.query, built.query);
});
