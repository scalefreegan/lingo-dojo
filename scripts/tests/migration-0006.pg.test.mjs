// Migration 0006 (fill the gap's cloze_items) on a real Postgres (the app
// runs Homebrew's PostgreSQL 17; PGlite, the rest of the suite, is 18):
// runs only when LINGO_TEST_PG_URL names a server, skipped otherwise. A
// throwaway database (pg-scratch.mjs, with its own reader role) is
// migrated to 0005, given a bank and a cloze row, and migrated on
// (migration-0006.mjs).
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/migration-0006.pg.test.mjs

import { test } from "node:test";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateAndCheck0006, migrationsBefore0006, migrationsThrough0006, seedBefore0006 } from "./migration-0006.mjs";
import { readerRoleFor, scratchDatabase } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";

async function scratch(t) {
  const db = await scratchDatabase(url, "m0006");
  t.after(db.drop);
  return db;
}

test("0006 on a 0005 database with a bank and a cloze row, on real Postgres: schema as a fresh build, reader kept out", { skip }, async (t) => {
  const db = await scratch(t);
  console.log(`migration 0006 on PostgreSQL ${(await db.query("show server_version_num"))[0].server_version_num}`);
  await applyMigrations(db.query, migrationsBefore0006());
  await seedBefore0006(db.query);
  const built = await scratch(t);
  await applyMigrations(built.query, migrationsThrough0006());
  await migrateAndCheck0006(db.query, built.query, readerRoleFor(db.name));
});
