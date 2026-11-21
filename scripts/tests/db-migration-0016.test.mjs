// Migration 0016 (who stands behind a shared reading, PR #67 review, bead
// ld-4i2, docs/DATA.md §Mandarin readings) on PGlite, from a 0015
// database: one new table, nothing changed on the old ones; one vote per
// user per entry, a vote goes with its entry and its user. Plain CREATE
// TABLE / INDEX: nothing PostgreSQL 18 only. Every name here is made up.
//   node --test scripts/tests/db-migration-0016.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";

const fresh = async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  return { query: async (text, params) => (await pg.query(text, params)).rows };
};
const upTo = (marker, what) => {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes(marker)));
  assert.ok(i >= 0, `${what} is on disk`);
  return disk.slice(0, i + 1);
};

test("0016 on a 0015 database: shared_reading_votes, one per user and entry, gone with either", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, upTo('CREATE TABLE "shared_readings"', "0015"));
  const [ada] = await query(`insert into users (username, password_hash) values ('ada', 'scrypt$x') returning id`);
  const [bo] = await query(`insert into users (username, password_hash) values ('bo', 'scrypt$x') returning id`);
  const [row] = await query(`insert into shared_readings (key, word, reading, status, source) values ('得去', '得去', 'děi qù', 'suggested', 'user') returning id`);

  const through = upTo('CREATE TABLE "shared_reading_votes"', "0016");
  assert.equal(through.length, 17, "the seventeenth migration");
  await applyMigrations(query, through);
  assert.equal((await migrationState(query, through)).status, "current");
  assert.equal((await query(`select count(*)::int as n from shared_readings`))[0].n, 1, "the old rows untouched");

  const vote = (user, source = "user") => query(`insert into shared_reading_votes (shared_reading_id, user_id, source) values ($1, $2, $3)`, [row.id, user, source]);
  await vote(ada.id);
  await vote(bo.id, "recap");
  await assert.rejects(vote(ada.id, "recap"), /duplicate key|unique|pk/i, "one vote per user per entry");
  await assert.rejects(vote(bo.id, "admin"), /shared_reading_votes_source/);
  await query(`delete from users where id = $1`, [bo.id]);
  assert.equal((await query(`select count(*)::int as n from shared_reading_votes`))[0].n, 1, "a user's votes go with them");
  await query(`delete from shared_readings where id = $1`, [row.id]);
  assert.equal((await query(`select count(*)::int as n from shared_reading_votes`))[0].n, 0, "and with their entry");
});
