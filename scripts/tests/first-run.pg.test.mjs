// The first-run race on a real Postgres. createFirstAdmin (scripts/db/accounts.ts)
// checks "no accounts yet" and inserts the admin in one transaction under
// LOCK TABLE users, so first runs that overlap make one admin, not several.
// PGlite (the rest of the suite) runs one transaction at a time and can't
// show the race, so this runs only when LINGO_TEST_PG_URL names a Postgres
// to connect to; skipped otherwise.
//
// It never touches the database the URL names beyond connecting to it: it
// creates a throwaway database of its own on that server, migrates it,
// races there, and drops it.
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/first-run.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../db/migrations.mjs";
import * as schema from "../db/schema.ts";
import { createFirstAdmin } from "../db/accounts.ts";

const url = process.env.LINGO_TEST_PG_URL;

test("first run on real Postgres: 12 at once, repeated, always make exactly one admin", { skip: !url && "set LINGO_TEST_PG_URL to run" }, async () => {
  const name = `lingo_dojo_test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: 16 });
  try {
    await applyMigrations(async (text, params) => (await pool.query(text, params)).rows);
    const db = drizzle(pool, { schema });
    const seed = { learners: [], voice: null, model: null, messages: [] };
    for (let round = 0; round < 5; round++) {
      await pool.query("truncate users cascade");
      const made = await Promise.all(
        Array.from({ length: 12 }, (_, i) => createFirstAdmin(db, { username: `racer-${round}-${i}`, passwordHash: "x" }, seed)),
      );
      assert.equal(made.filter(Boolean).length, 1, `round ${round}: one first run wins`);
      const { rows } = await pool.query("select count(*)::int as n from users");
      assert.equal(rows[0].n, 1, `round ${round}: one account`);
    }
  } finally {
    await pool.end();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
});
