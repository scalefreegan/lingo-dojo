// Pure helpers for `npm run db:backup` (backup-cli.mjs): file naming, which
// backups to prune, where pg_dump lives. No server imports, so `node --test`
// covers them with a temp directory.

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../content.mjs";

export const KEEP_BACKUPS = 14;

/** Where backups go: LINGO_BACKUPS_DIR (tests, odd setups), else backups/ at the repo root. */
export function backupsDir(env = process.env, root = REPO_ROOT) {
  const override = env.LINGO_BACKUPS_DIR?.trim();
  return override ? path.resolve(root, override) : path.join(root, "backups");
}

/** `<database>-20261115T031500Z.dump`: sorts by name in time order. */
export function backupFileName(database, date = new Date()) {
  const stamp = date.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  return `${database}-${stamp}.dump`;
}

/** The in-progress name. It never matches isBackupFile, so a half-written
 *  dump is neither listed as a backup nor counted when pruning. */
export function partialName(finalName) {
  return `.${finalName}.partial`;
}

/** True for a file this tool wrote for this database (and only that). */
export function isBackupFile(name, database) {
  if (!name.startsWith(`${database}-`) || !name.endsWith(".dump")) return false;
  return /^\d{8}T\d{6}Z$/.test(name.slice(database.length + 1, -".dump".length));
}

/** Backups to delete so the newest `keep` remain. Other names are never returned. */
export function backupsToPrune(names, database, keep = KEEP_BACKUPS) {
  const mine = names.filter((n) => isBackupFile(n, database)).sort();
  return mine.slice(0, Math.max(0, mine.length - keep));
}

/** Homebrew PostgreSQL 17 first (the app's server), then other installs.
 *  A launchd job has a minimal PATH, so PATH alone is not enough. */
export const HOMEBREW_BIN_DIRS = [
  "/opt/homebrew/opt/postgresql@17/bin",
  "/opt/homebrew/opt/postgresql@18/bin",
  "/opt/homebrew/opt/postgresql@16/bin",
  "/usr/local/opt/postgresql@17/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

/** Existing pg_dump candidates in search order: PATH, then the Homebrew dirs. */
export function pgDumpCandidates(env = process.env, exists = (p) => fs.existsSync(p)) {
  const dirs = [...(env.PATH ?? "").split(path.delimiter).filter(Boolean), ...HOMEBREW_BIN_DIRS];
  const seen = new Set();
  const found = [];
  for (const d of dirs) {
    const p = path.join(d, "pg_dump");
    if (seen.has(p)) continue;
    seen.add(p);
    if (exists(p)) found.push(p);
  }
  return found;
}

/** Major version from `pg_dump --version` text ("pg_dump (PostgreSQL) 17.10 (Homebrew)"). */
export function parseMajor(versionText) {
  const m = /\)\s*(\d+)(?:\.\d+)*/.exec(String(versionText)) ?? /^\D*(\d+)/.exec(String(versionText));
  return m ? Number(m[1]) : null;
}

/** Major version from `show server_version_num` ("170010" -> 17). */
export function serverMajor(versionNum) {
  const n = Number(versionNum);
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 10000) : null;
}

/** pg_dump refuses a server newer than itself, so the tool must be >= the server. */
export function dumpToolIsNewEnough(toolMajor, serverMaj) {
  return toolMajor != null && serverMaj != null && toolMajor >= serverMaj;
}
