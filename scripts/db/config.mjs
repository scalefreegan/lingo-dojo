// Where the database is and where its migrations live. Pure ESM with no
// server imports, shared by the dev server (web/server/db.ts), the setup CLI
// (setup.mjs), drizzle.config.ts and the tests.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envFile, parseEnv } from "../voice.mjs";

export const DEFAULT_DATABASE_URL = "postgres://localhost/lingo_dojo";
export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** DATABASE_URL: the shell environment, else the repo-root .env.local (read
 *  the same way as the voice keys, so the Dock app, which starts without a
 *  shell profile, sees it too), else the default local database. */
export function databaseUrl(env = process.env, file = envFile()) {
  if (env.DATABASE_URL?.trim()) return env.DATABASE_URL.trim();
  try {
    const v = parseEnv(fs.readFileSync(file, "utf8")).DATABASE_URL?.trim();
    if (v) return v;
  } catch {
    /* no file: the default */
  }
  return DEFAULT_DATABASE_URL;
}

/** The database name in a postgres:// URL (the path's one segment). */
export function databaseName(url) {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!name || name.includes("/")) throw new Error(`DATABASE_URL names no database: ${redact(url)}`);
  return name;
}

/** The URL with any password masked, for messages and logs. */
export function redact(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/**
 * How far a database is behind the committed migrations. drizzle's migrator
 * records each applied migration's folderMillis in
 * drizzle.__drizzle_migrations.created_at and applies only those newer than
 * the latest row, so "current" means the latest row is at least the newest
 * migration on disk. `latestApplied` is null for a database never migrated.
 */
export function pendingMigrations(migrations, latestApplied) {
  const last = latestApplied == null ? -Infinity : Number(latestApplied);
  return migrations.filter((m) => m.folderMillis > last);
}
