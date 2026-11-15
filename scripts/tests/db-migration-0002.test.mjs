// Migration 0002 (language profiles) on a database that already has data
// (PGlite): built at 0001, filled the way the code before 0002 wrote rows,
// then migrated; every row must land under its learner's one language,
// nothing may be lost, and the new keys must hold. The same check runs on a
// real PostgreSQL 17 in migration-0002.pg.test.mjs.
//   node --test scripts/tests/db-migration-0002.test.mjs

import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { applyMigrations } from "../db/migrations.mjs";
import { migrateAndCheck, migrationsBefore0002, seedBefore0002 } from "./migration-0002.mjs";

test("0002 on a populated 0001 database: one profile per learner, every pack, folder, revision, conversation and turn under it, nothing lost", async (t) => {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  t.after(() => pg.close());
  const query = async (text, params) => (await pg.query(text, params)).rows;
  await applyMigrations(query, migrationsBefore0002());
  await seedBefore0002(query);
  await migrateAndCheck(query);
});
