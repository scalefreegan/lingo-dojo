// The shared readings' daily vote cap under concurrency, on a real Postgres
// (scripts/db/sharedReadings.ts propose): one user's votes racing on
// several connections must stop at MAX_DAILY_VOTES exactly. PGlite runs one
// transaction at a time and can't show a race, so this runs only when
// LINGO_TEST_PG_URL names a Postgres; skipped otherwise. A throwaway
// database (pg-scratch.mjs), dropped after.
//   LINGO_TEST_PG_URL=postgres://localhost/postgres node --test scripts/tests/shared-readings.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../db/migrations.mjs";
import * as schema from "../db/schema.ts";
import { createUser } from "../db/accounts.ts";
import { MAX_DAILY_VOTES, SharedLimitError, propose } from "../db/sharedReadings.ts";
import { scratchDatabase } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";
const RACERS = 8;

test("one user's votes racing on many connections stop at MAX_DAILY_VOTES exactly (PR #67 second review)", { skip }, async (t) => {
  const scratch = await scratchDatabase(url, "shared");
  const pool = new pg.Pool({ connectionString: scratch.url, max: RACERS + 2 });
  t.after(async () => {
    await pool.end();
    await scratch.drop();
  });
  await applyMigrations(scratch.query);
  const db = drizzle(pool, { schema });
  const user = await createUser(db, { username: "racer", passwordHash: "x" });
  // Two votes short of the cap, then a burst of different words at once.
  for (let i = 0; i < MAX_DAILY_VOTES - 2; i++) {
    const { rows } = await pool.query(`insert into shared_readings (key, word, reading, status, source) values ($1, $1, 'x y', 'suggested', 'user') returning id`, [`测${String.fromCodePoint(0x4e00 + i)}`]);
    await pool.query(`insert into shared_reading_votes (shared_reading_id, user_id, source) values ($1, $2, 'user')`, [rows[0].id, user.id]);
  }
  const words = Array.from({ length: RACERS * 2 }, (_, i) => `试${String.fromCodePoint(0x5000 + i)}`);
  const results = await Promise.allSettled(words.map((w) => propose(db, { word: w, key: w, reading: "shì yī", scope: "all" }, "user", user.id)));
  const passed = results.filter((r) => r.status === "fulfilled").length;
  for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof SharedLimitError, String(r.reason));
  assert.equal(passed, 2);
  const { rows } = await pool.query(`select count(*)::int as n from shared_reading_votes where user_id = $1`, [user.id]);
  assert.equal(rows[0].n, MAX_DAILY_VOTES);
});
