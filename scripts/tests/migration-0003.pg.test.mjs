// Migration 0003 (the phrase bank moves under language profiles) on a real
// Postgres (the app runs Homebrew's PostgreSQL 17; PGlite, the rest of the
// suite, is 18): runs only when LINGO_TEST_PG_URL names a server, skipped
// otherwise. Each test makes throwaway databases there (pg-scratch.mjs),
// migrates to 0002 with data, and checks migration-0003.mjs's two cases:
// an empty bank applies and matches a fresh build, a bank row is refused
// with nothing changed. It never touches the database the URL names beyond
// connecting to it.
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/migration-0003.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateEmptyAndCheck, migrationsBefore0003, migrationsThrough0003, refuseAndCheck, seedBankRow, seedBefore0003 } from "./migration-0003.mjs";
import { scratchDatabase } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";

/** A throwaway database on the server, as one client's `query` (applyMigrations
 *  runs its transaction on one connection). */
async function scratch(t) {
  const db = await scratchDatabase(url, "m0003");
  t.after(db.drop);
  const version = (await db.query("show server_version_num"))[0].server_version_num;
  assert.ok(Number(version) >= 150000, "SET NULL (col) needs PostgreSQL 15+");
  return db.query;
}

test("0003 on a 0002 database with data and an empty bank, on real Postgres: applies, schema as a fresh build", { skip }, async (t) => {
  const query = await scratch(t);
  console.log(`migration 0003 on PostgreSQL ${(await query("show server_version_num"))[0].server_version_num}`);
  await applyMigrations(query, migrationsBefore0003());
  await seedBefore0003(query);
  const built = await scratch(t);
  await applyMigrations(built, migrationsThrough0003());
  await migrateEmptyAndCheck(query, built);
});

test("0003 refuses a 0002 database with bank rows, on real Postgres, changing nothing", { skip }, async (t) => {
  for (const table of ["phrases", "reviews"]) {
    const query = await scratch(t);
    await applyMigrations(query, migrationsBefore0003());
    await seedBefore0003(query);
    await seedBankRow(query, table);
    await refuseAndCheck(query);
  }
});
