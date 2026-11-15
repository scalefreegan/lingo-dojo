// Applying and checking the committed migrations (scripts/db/migrations/),
// by hash. The dev server's boot check, the setup CLI and the test harness
// all go through this module, so a test database is built by exactly the SQL
// and the code a real one is.
//
// Why not drizzle's migrator: it counts a migration as applied when its
// journal timestamp is at or below the newest one recorded. Two branches
// that each generate a migration can merge in the other order, and then one
// is silently never applied while everything reports current. Here a
// migration is applied when its hash is recorded, and the database is
// current only when the recorded hashes and the files on disk match exactly.
// The bookkeeping table is drizzle's own (drizzle.__drizzle_migrations: hash,
// created_at), so drizzle-kit tooling still reads it.
//
// `query(text, params?)` runs one statement and resolves to its rows. A
// pg.Client or a PGlite instance both fit: (t, p) => c.query(t, p).then(r => r.rows).
// A pg Pool does not for applyMigrations, whose transaction needs one
// connection.

import { readMigrationFiles } from "drizzle-orm/migrator";
import { MIGRATIONS_DIR } from "./config.mjs";

/** The migrations on disk, oldest first: { sql: string[], folderMillis, hash }. */
export function migrationsOnDisk(dir = MIGRATIONS_DIR) {
  return readMigrationFiles({ migrationsFolder: dir });
}

/** The recorded migrations ({ hash, createdAt }); [] for a database never
 *  migrated. Never writes. */
export async function appliedMigrations(query) {
  const [{ t }] = await query(`select to_regclass('drizzle.__drizzle_migrations')::text as t`);
  if (!t) return [];
  const rows = await query(`select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id`);
  return rows.map((r) => ({ hash: r.hash, createdAt: r.created_at == null ? null : Number(r.created_at) }));
}

/**
 * Compare the migrations on disk with the recorded ones. Pure.
 *   current   every file recorded, nothing else recorded
 *   behind    some files not yet applied, all newer than any applied one
 *   skipped   a file older than an applied one was never applied (the
 *             out-of-order merge drizzle's migrator would skip forever)
 *   ahead     the database has migrations this code doesn't know (a newer
 *             branch migrated it, or a file was edited after it was applied)
 *   diverged  both: unknown migrations recorded and files missing
 */
export function compareMigrations(disk, applied) {
  const appliedHashes = new Set(applied.map((a) => a.hash));
  const diskHashes = new Set(disk.map((m) => m.hash));
  const missing = disk.filter((m) => !appliedHashes.has(m.hash));
  const unknown = applied.filter((a) => !diskHashes.has(a.hash));
  const newestApplied = Math.max(-Infinity, ...disk.filter((m) => appliedHashes.has(m.hash)).map((m) => m.folderMillis));
  const skipped = missing.filter((m) => m.folderMillis <= newestApplied);
  const status =
    unknown.length && missing.length ? "diverged"
    : unknown.length ? "ahead"
    : skipped.length ? "skipped"
    : missing.length ? "behind"
    : "current";
  return { status, total: disk.length, applied: disk.length - missing.length, missing, skipped, unknown };
}

/** One sentence on a non-current state, for the boot check and the CLI. */
export function describeMigrations(state) {
  const n = (list) => `${list.length} migration(s)`;
  switch (state.status) {
    case "current":
      return `all ${state.total} migration(s) applied`;
    case "behind":
      return `behind: ${n(state.missing)} of ${state.total} not applied`;
    case "skipped":
      return `skipped: ${n(state.skipped)} older than one already applied never ran (an out-of-order merge); ${n(state.missing)} of ${state.total} not applied`;
    case "ahead":
      return `ahead: it has ${n(state.unknown)} this checkout doesn't have (applied from another branch, or a migration file edited after it ran)`;
    case "diverged":
      return `diverged: it has ${n(state.unknown)} this checkout doesn't have, and ${n(state.missing)} of this checkout's are not applied`;
    default:
      return state.status;
  }
}

/** Where a database stands against the migrations on disk. Read-only. */
export async function migrationState(query, disk = migrationsOnDisk()) {
  return compareMigrations(disk, await appliedMigrations(query));
}

/**
 * Apply every migration on disk whose hash isn't recorded, oldest first, in
 * one transaction. Refuses (throws, changing nothing) when the database is
 * ahead or diverged: it holds migrations this code can't account for, and
 * running more on top would only bury that. Returns the state it started
 * from and the migrations it applied.
 */
export async function applyMigrations(query, disk = migrationsOnDisk()) {
  const before = await migrationState(query, disk);
  if (before.status === "ahead" || before.status === "diverged") {
    throw new Error(`refusing to migrate: the database is ${describeMigrations(before)}. Sort it out by hand (or use a fresh database); nothing was changed.`);
  }
  if (!before.missing.length) return { before, applied: [] };
  await query("begin");
  try {
    await query(`create schema if not exists drizzle`);
    await query(`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`);
    for (const m of before.missing) {
      for (const stmt of m.sql) if (stmt.trim()) await query(stmt);
      await query(`insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`, [m.hash, m.folderMillis]);
    }
    await query("commit");
  } catch (e) {
    await query("rollback").catch(() => {});
    throw e;
  }
  return { before, applied: before.missing };
}
