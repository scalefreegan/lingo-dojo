#!/usr/bin/env node
// npm run db:setup    create the database named in DATABASE_URL if it is
//                     missing, then apply every pending migration
// npm run db:migrate  apply pending migrations only (the database must exist)
//
// Idempotent: on a current database both print the state and change nothing.
// Migrations are applied by hash (scripts/db/migrations.mjs); a database that
// holds migrations this checkout doesn't know is refused, untouched.
// DATABASE_URL comes from the shell or the checkout's .env.local, default
// postgres://localhost/lingo_dojo, except in a linked git worktree, which must
// set one (scripts/db/config.mjs).
//
// Not yet: the read-only `lingo_reader` role and row-level security for the
// content agent's bank MCP (DATA.md, bead ld-t5f), and the one-time import
// (`npm run db:import`, phase 2).

import pg from "pg";
import { databaseName, databaseUrl, redact } from "./config.mjs";
import { applyMigrations, describeMigrations, migrationState } from "./migrations.mjs";

const migrateOnly = process.argv.includes("--migrate-only");

/** Create the database through the server's maintenance database. */
async function ensureDatabase(url, name) {
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
  const url = databaseUrl();
  const name = databaseName(url);
  console.log(`database: ${redact(url)}`);
  if (!migrateOnly && (await ensureDatabase(url, name))) console.log(`created database ${name}`);
  // One connection: the migrations run in one transaction.
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const query = async (text, params) => (await client.query(text, params)).rows;
    const { applied } = await applyMigrations(query);
    if (applied.length) console.log(`applied ${applied.length} migration(s)`);
    const after = await migrationState(query);
    console.log(`migrations: ${describeMigrations(after)}`);
  } finally {
    await client.end();
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
