// Races that need a real Postgres. PGlite (the rest of the suite) runs one
// transaction at a time and can't show them, so these run only when
// LINGO_TEST_PG_URL names a Postgres to connect to; skipped otherwise.
//
//   - createFirstAdmin (scripts/db/accounts.ts) checks "no accounts yet" and
//     inserts the admin in one transaction under LOCK TABLE users, so first
//     runs that overlap make one admin, not several.
//   - updateVoiceSettings reads, merges and writes a user's voice settings in
//     one transaction holding the row (made first if missing) FOR UPDATE, so
//     overlapping saves all land.
//
// Each test never touches the database the URL names beyond connecting to
// it: it creates a throwaway database of its own on that server, migrates
// it, races there, and drops it.
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/first-run.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../db/migrations.mjs";
import * as schema from "../db/schema.ts";
import { createFirstAdmin, createUser, updateVoiceSettings } from "../db/accounts.ts";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";

/** A migrated throwaway database on the URL's server for `fn`, dropped after. */
async function withThrowawayDb(fn) {
  const name = `lingo_dojo_test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: 16 });
  try {
    await applyMigrations(async (text, params) => (await pool.query(text, params)).rows);
    await fn(pool, drizzle(pool, { schema }));
  } finally {
    await pool.end();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
}

test("first run on real Postgres: 12 at once, repeated, always make exactly one admin", { skip }, async () => {
  await withThrowawayDb(async (pool, db) => {
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
  });
});

test("voice settings on real Postgres: 12 overlapping saves for one user, repeated, all kept (the first ones also make the row)", { skip }, async () => {
  await withThrowawayDb(async (pool, db) => {
    const user = await createUser(db, { username: "saver", passwordHash: "x", isAdmin: false });
    for (let round = 0; round < 5; round++) {
      await pool.query("delete from user_settings");
      await Promise.all(
        Array.from({ length: 12 }, (_, i) => updateVoiceSettings(db, user.id, (stored) => ({ ...(stored ?? {}), [`k${i}`]: round }))),
      );
      const { rows } = await pool.query("select voice from user_settings where user_id = $1", [user.id]);
      assert.equal(rows.length, 1);
      assert.equal(Object.keys(rows[0].voice).length, 12, `round ${round}: every save kept, got ${Object.keys(rows[0].voice).sort()}`);
    }
  });
});
