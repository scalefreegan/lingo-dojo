// Applying and checking the committed migrations (scripts/db/migrations/).
// Driver-agnostic: the dev server and setup CLI pass a node-postgres Drizzle
// instance, the tests a PGlite one; both go through drizzle's own migrator,
// so a test database is built by exactly the SQL a real one is.

import { readMigrationFiles } from "drizzle-orm/migrator";
import { MIGRATIONS_DIR, pendingMigrations } from "./config.mjs";

/** The migrations on disk, oldest first (drizzle's MigrationMeta). */
export function migrationsOnDisk(dir = MIGRATIONS_DIR) {
  return readMigrationFiles({ migrationsFolder: dir });
}

/**
 * Where a database stands against the migrations on disk. `query(text)`
 * runs one SQL statement and resolves to its rows, so this works over a pg
 * Pool or a PGlite instance alike. Never writes: the boot check must not
 * migrate behind the user's back.
 */
export async function migrationState(query, dir = MIGRATIONS_DIR) {
  const [{ t }] = await query(`select to_regclass('drizzle.__drizzle_migrations')::text as t`);
  let latest = null;
  if (t) {
    const [row] = await query(`select max(created_at)::text as latest from drizzle.__drizzle_migrations`);
    latest = row?.latest == null ? null : Number(row.latest);
  }
  const all = migrationsOnDisk(dir);
  return { latestApplied: latest, total: all.length, pending: pendingMigrations(all, latest).length };
}
