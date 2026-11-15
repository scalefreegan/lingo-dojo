#!/usr/bin/env node
// npm run db:setup    create the database named in DATABASE_URL if it is
//                     missing, then apply every pending migration
// npm run db:migrate  apply pending migrations only (the database must exist)
//
// Idempotent: on a current database both print the state and change nothing.
// DATABASE_URL comes from the shell or the repo-root .env.local, default
// postgres://localhost/lingo_dojo (scripts/db/config.mjs).
//
// Not yet: the read-only `lingo_reader` role and row-level security for the
// content agent's bank MCP (DATA.md, bead ld-t5f), and the one-time import
// (`npm run db:import`, phase 2).

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { MIGRATIONS_DIR, databaseName, databaseUrl, redact } from "./config.mjs";
import { migrationState } from "./migrations.mjs";

const migrateOnly = process.argv.includes("--migrate-only");
const url = databaseUrl();
const name = databaseName(url);

/** Create the database through the server's maintenance database. */
async function ensureDatabase() {
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (rowCount) return false;
    // An identifier cannot be a bind parameter; quote it instead.
    await client.query(`create database "${name.replace(/"/g, '""')}"`);
    return true;
  } finally {
    await client.end();
  }
}

async function main() {
  console.log(`database: ${redact(url)}`);
  if (!migrateOnly && (await ensureDatabase())) console.log(`created database ${name}`);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const query = async (text) => (await pool.query(text)).rows;
    const before = await migrationState(query);
    if (before.pending) {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
      console.log(`applied ${before.pending} migration(s)`);
    }
    const after = await migrationState(query);
    console.log(`migrations: ${after.total - after.pending}/${after.total} applied${after.pending ? "" : " (current)"}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  const hint =
    e?.code === "ECONNREFUSED" ? " (is Postgres running? brew services start postgresql@17)"
    : e?.code === "3D000" ? " (run `npm run db:setup` to create it)"
    : "";
  console.error(`db ${migrateOnly ? "migrate" : "setup"} failed: ${e?.message || e}${hint}`);
  process.exit(1);
});
