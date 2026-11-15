// Migration 0003 (the phrase bank moves under language profiles) on a
// database that already has data (PGlite): built at 0002, filled with a bank
// keyed by learner and lang, then migrated; every bank row must land under
// its learner's oldest profile, the rows the new identity makes one must be
// merged as hand-edits.mjs says, and nothing else may change. The same check
// runs on a real PostgreSQL 17 in migration-0003.pg.test.mjs.
//   node --test scripts/tests/db-migration-0003.test.mjs

import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateAndCheck0003, migrationsBefore0003, seedBefore0003 } from "./migration-0003.mjs";

const fresh = async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  return async (text, params) => (await pg.query(text, params)).rows;
};

test("0003 on a populated 0002 database: the bank under each learner's oldest profile, two-variant duplicates merged, nothing else changed", async (t) => {
  const query = await fresh(t);
  await applyMigrations(query, migrationsBefore0003());
  await seedBefore0003(query);
  await migrateAndCheck0003(query);
});

test("0003 on an empty 0002 database", async (t) => {
  const query = await fresh(t);
  await applyMigrations(query, migrationsBefore0003());
  await applyMigrations(query);
});
