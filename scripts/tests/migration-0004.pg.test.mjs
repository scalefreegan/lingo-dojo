// Migration 0004 (the session recap's columns) on a real Postgres (the app
// runs Homebrew's PostgreSQL 17; PGlite, the rest of the suite, is 18):
// runs only when LINGO_TEST_PG_URL names a server, skipped otherwise. A
// throwaway database (pg-scratch.mjs) is migrated to 0003, filled with
// conversations, turns and a bank in use, and migrated on: rows untouched,
// defaults filled, schema as a fresh build (migration-0004.mjs).
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/migration-0004.pg.test.mjs

import { test } from "node:test";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateAndCheck0004, migrationsBefore0004, migrationsThrough0004, seedBefore0004 } from "./migration-0004.mjs";
import { scratchDatabase } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";

async function scratch(t) {
  const db = await scratchDatabase(url, "m0004");
  t.after(db.drop);
  return db.query;
}

test("0004 on a 0003 database with conversations, turns and a bank, on real Postgres: rows untouched, schema as a fresh build", { skip }, async (t) => {
  const query = await scratch(t);
  console.log(`migration 0004 on PostgreSQL ${(await query("show server_version_num"))[0].server_version_num}`);
  await applyMigrations(query, migrationsBefore0004());
  await seedBefore0004(query);
  const built = await scratch(t);
  await applyMigrations(built, migrationsThrough0004());
  await migrateAndCheck0004(query, built);
});
