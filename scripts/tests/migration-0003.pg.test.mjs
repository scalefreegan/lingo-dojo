// Migration 0003 (the phrase bank moves under language profiles) on a real
// Postgres (the app runs Homebrew's PostgreSQL 17; PGlite, the rest of the
// suite, is 18), with data in it: runs only when LINGO_TEST_PG_URL names a
// server, skipped otherwise. It makes a throwaway database there, migrates
// it to 0002, fills it with a bank keyed by learner and lang, applies 0003
// and checks every row (migration-0003.mjs), then drops it. It never touches
// the database the URL names beyond connecting to it.
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/migration-0003.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateAndCheck0003, migrationsBefore0003, seedBefore0003 } from "./migration-0003.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";

test("0003 on a populated 0002 database, on real Postgres", { skip }, async () => {
  const name = `lingo_dojo_test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  // One client: applyMigrations runs its transaction on one connection.
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  try {
    const version = (await client.query("show server_version_num")).rows[0].server_version_num;
    console.log(`migration 0003 on PostgreSQL ${version}`);
    assert.ok(Number(version) >= 150000, "SET NULL (col) needs PostgreSQL 15+");
    const query = async (text, params) => (await client.query(text, params)).rows;
    await applyMigrations(query, migrationsBefore0003());
    await seedBefore0003(query);
    await migrateAndCheck0003(query);
  } finally {
    await client.end();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
});
