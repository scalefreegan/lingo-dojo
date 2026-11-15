// Migration 0002 (language profiles) on a real Postgres (the app runs
// Homebrew's PostgreSQL 17; PGlite, the rest of the suite, is 18), with
// data in it: runs only when LINGO_TEST_PG_URL names a server, skipped
// otherwise. It makes a throwaway database there, migrates it to 0001,
// fills it the way the code before 0002 wrote rows, applies 0002 and checks
// every row (migration-0002.mjs), then drops it. It never touches the
// database the URL names beyond connecting to it.
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/migration-0002.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateAndCheck, migrationsBefore0002, seedBefore0002 } from "./migration-0002.mjs";
import { createDatabase, dropDatabase, scratchName } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";

test("0002 on a populated 0001 database, on real Postgres", { skip }, async () => {
  const name = scratchName("m0002");
  const target = new URL(await createDatabase(url, name));
  // One client: applyMigrations runs its transaction on one connection.
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  try {
    const version = (await client.query("show server_version_num")).rows[0].server_version_num;
    console.log(`migration 0002 on PostgreSQL ${version}`);
    assert.ok(Number(version) >= 150000, "SET NULL (col) needs PostgreSQL 15+");
    const query = async (text, params) => (await client.query(text, params)).rows;
    await applyMigrations(query, migrationsBefore0002());
    await seedBefore0002(query);
    await migrateAndCheck(query);
  } finally {
    await client.end();
    // After every pool and client on it has ended (pg-scratch.mjs).
    await dropDatabase(url, name);
  }
});
