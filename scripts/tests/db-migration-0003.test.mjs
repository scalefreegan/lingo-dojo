// Migration 0003 (the phrase bank moves under language profiles) on PGlite,
// from a 0002 database with data: with an empty bank it applies and matches
// a fresh build; with a row in any bank table it refuses, changing nothing.
// The same checks run on a real PostgreSQL 17 in migration-0003.pg.test.mjs.
//   node --test scripts/tests/db-migration-0003.test.mjs

import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { applyMigrations } from "../db/migrations.mjs";
import { BANK_TABLES, migrateEmptyAndCheck, migrationsBefore0003, refuseAndCheck, seedBankRow, seedBefore0003 } from "./migration-0003.mjs";

const fresh = async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  return async (text, params) => (await pg.query(text, params)).rows;
};

test("0003 on a 0002 database with data and an empty bank: applies, rows untouched, schema as a fresh build", async (t) => {
  const query = await fresh(t);
  await applyMigrations(query, migrationsBefore0003());
  await seedBefore0003(query);
  const built = await fresh(t);
  await applyMigrations(built);
  await migrateEmptyAndCheck(query, built);
});

for (const table of BANK_TABLES) {
  test(`0003 refuses a 0002 database with a row in ${table}, changing nothing`, async (t) => {
    const query = await fresh(t);
    await applyMigrations(query, migrationsBefore0003());
    await seedBefore0003(query);
    await seedBankRow(query, table);
    await refuseAndCheck(query);
  });
}
