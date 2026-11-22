// Migration 0019 (an added stock concept's look-alike group, bead ld-2nw,
// docs/DATA.md §The game for adults, and the picture library) on PGlite,
// from a 0018 database: one nullable column on picture_stock_concepts, the
// rows already there keep theirs as null; a value has pictures.yaml's group
// format (the check). Plain ALTER TABLE ADD COLUMN / ADD CONSTRAINT CHECK:
// nothing PostgreSQL 18 only. Every name here is made up.
//   node --test scripts/tests/db-migration-0019.test.mjs

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

test("0019 on a 0018 database: picture_stock_concepts.look_alike_group, null for the rows there, checked like pictures.yaml's group", async (t) => {
  const { query } = await fresh(t);
  await applyMigrations(query, upTo('CREATE TABLE "picture_stock_adults"', "0018"));
  await query(`insert into picture_stock_concepts (id, category, description, words, adults) values ('kite', 'Toys', 'a red kite', '{kite}', true)`);

  const through = upTo('"look_alike_group"', "0019");
  assert.equal(through.length, 20, "the twentieth migration");
  await applyMigrations(query, through);
  assert.equal((await migrationState(query, through)).status, "current");
  assert.deepEqual(await query(`select id, adults, look_alike_group from picture_stock_concepts`), [{ id: "kite", adults: true, look_alike_group: null }], "the rows there keep no group");

  const add = (id, group) => query(`insert into picture_stock_concepts (id, category, description, words, look_alike_group) values ($1, 'People', 'a young lad', '{lad}', $2)`, [id, group]);
  await add("lad", "boy");
  await add("chap", "hot-drink-2");
  for (const bad of ["Boy", "two words", "-boy", "bad_id", "", "x".repeat(49)]) {
    await assert.rejects(add("bad", bad), /picture_stock_concepts_group/, JSON.stringify(bad));
  }
  await query(`update picture_stock_concepts set look_alike_group = 'boy' where id = 'kite'`);
  await query(`update picture_stock_concepts set look_alike_group = null where id = 'kite'`);
  await assert.rejects(query(`update picture_stock_concepts set look_alike_group = 'Nope' where id = 'kite'`), /picture_stock_concepts_group/);
  assert.deepEqual(await query(`select id, look_alike_group from picture_stock_concepts order by id`), [
    { id: "chap", look_alike_group: "hot-drink-2" },
    { id: "kite", look_alike_group: null },
    { id: "lad", look_alike_group: "boy" },
  ]);
});
