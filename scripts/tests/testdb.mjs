// The test database: a fresh, fully migrated Postgres per call, in process
// (PGlite, Postgres compiled to WASM), so `npm test` needs no Postgres
// server and can never touch the dev database. Not a test itself (the npm
// glob is *.test.mjs).
//
//   import { freshDb } from "./testdb.mjs";
//   const { db, query, close } = await freshDb();
//   await forLearner(db, learnerId).list(phrases);   // the server's Drizzle API
//   t.after(close);
//
// The real migrations are applied, unchanged, by the same by-hash migrator
// `npm run db:setup` uses (scripts/db/migrations.mjs), with pg_trgm loaded
// as a PGlite extension. PGlite is PostgreSQL 18 while the app runs on
// Homebrew's 17: migration SQL must still be valid on 17. Migrating takes about a second, so it
// is done once per process and the result kept as a data-dir image; each call
// boots a new instance from that image (what PGlite's clone() does), so every
// caller still starts from an empty, current schema of its own. The migrating
// instance is closed straight away: an open PGlite holds the process about
// ten seconds past the last test.
//
// The owner is not a superuser. PGlite's session user is the superuser
// `postgres`, which bypasses row-level security; the app's role, on a server
// set up by someone else, may be only the tables' owner. So the image is
// migrated as APP_OWNER (NOSUPERUSER, CREATEROLE, as a database owner set up
// by an administrator would be) and every database this hands out runs as
// it: the whole suite then shows that migration 0005's RLS (enabled, not
// forced) leaves the owner's every query path seeing its rows, and that
// 0005 applies for a non-superuser owner with CREATEROLE.

import "./no-network.mjs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { applyMigrations } from "../db/migrations.mjs";
import * as schema from "../db/schema.ts";

const extensions = { pg_trgm };
let image = null;

/** The role every test database runs as: owns every table, not a superuser. */
export const APP_OWNER = "lingo_app_owner";
const BECOME_OWNER = `set session authorization ${APP_OWNER}`;

function migratedImage() {
  image ??= (async () => {
    const pg = await PGlite.create({ extensions });
    try {
      await pg.exec(`
        create role ${APP_OWNER} login nosuperuser createrole;
        grant create on database postgres to ${APP_OWNER};
        grant create on schema public to ${APP_OWNER};
        ${BECOME_OWNER};`);
      await applyMigrations(async (text, params) => (await pg.query(text, params)).rows);
      return await pg.dumpDataDir("none");
    } finally {
      await pg.close();
    }
  })();
  return image;
}

/**
 * A fresh migrated database. `db` is a Drizzle instance with the schema,
 * typed like the server's (scripts/db/owned.ts `Db`), so the owned-row
 * helpers and every Drizzle query work on it as they do in the app.
 * `query(text, params)` runs raw SQL and resolves to the rows; `client` is
 * the PGlite instance; `close()` frees it (an unclosed one delays the test
 * process's exit by about ten seconds, so pass it to `t.after`).
 */
export async function freshDb() {
  const client = await PGlite.create({ loadDataDir: await migratedImage(), extensions });
  await client.exec(BECOME_OWNER);
  const db = drizzle(client, { schema });
  return {
    db,
    client,
    query: async (text, params) => (await client.query(text, params)).rows,
    close: () => client.close(),
  };
}
