// Migration 0009 (hidden scenes, docs/DATA.md §Hidden scenes) on PGlite,
// from a 0008 database with a learner and sessions: it applies, every row
// already there stays as it was, the new table starts empty and takes a
// hide for the old profile, and the schema matches a fresh build. Plain
// CREATE TABLE and a foreign key, nothing PostgreSQL 18 only.
//   node --test scripts/tests/db-migration-0009.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { applyMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";
import { catalog } from "./migration-0003.mjs";
import { migrationsBefore0008, migrationsThrough0008, seedBefore0008 } from "./migration-0008.mjs";

const fresh = async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  return { query: async (text, params) => (await pg.query(text, params)).rows };
};

const through0009 = () => {
  const disk = migrationsOnDisk();
  const i = disk.findIndex((m) => m.sql.some((s) => s.includes('CREATE TABLE "hidden_scenes"')));
  assert.ok(i >= 0, "0009 is on disk");
  return disk.slice(0, i + 1);
};

test("0009 on a 0008 database: rows untouched, hidden_scenes empty and usable, schema as a fresh build", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, migrationsBefore0008());
  await seedBefore0008(query);
  await applyMigrations(query, migrationsThrough0008());
  const before = await query(`select to_jsonb(c) as row from conversations c order by id`);
  const profiles = await query(`select to_jsonb(p) as row from language_profiles p order by id`);

  await applyMigrations(query, through0009());
  assert.equal((await migrationState(query, through0009())).status, "current");
  assert.deepEqual(await query(`select to_jsonb(c) as row from conversations c order by id`), before);
  assert.deepEqual(await query(`select to_jsonb(p) as row from language_profiles p order by id`), profiles);
  assert.deepEqual(await query(`select * from hidden_scenes`), []);
  const [p] = await query(`select id, learner_id from language_profiles`);
  await query(`insert into hidden_scenes (learner_id, language_profile_id, kind, key) values ($1, $2, 'collection', 'First steps (Mandarin)')`, [p.learner_id, p.id]);
  await assert.rejects(
    query(`insert into hidden_scenes (learner_id, language_profile_id, kind, key) values ($1, $2, 'collection', 'First steps (Mandarin)')`, [p.learner_id, p.id]),
    /hidden_scenes_pk/,
    "one row per (language, kind, key)",
  );

  const built = await fresh(t);
  await applyMigrations(built.query, through0009());
  assert.deepEqual(await catalog(query), await catalog(built.query));
});
