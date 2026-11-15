// Pure-ish helpers for `npm run db:backup` (backup-cli.mjs): file naming, which
// backups to prune, where pg_dump lives, and the dump → rename → prune run
// itself (with an injectable spawn so tests use a fake pg_dump). No server
// imports, so `node --test` covers all of it with a temp directory.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../content.mjs";

export const KEEP_BACKUPS = 14;
const DAY_MS = 24 * 3600 * 1000;

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

/** The in-progress name, unique per process. It never matches isBackupFile, so
 *  a half-written dump is neither listed as a backup nor counted when pruning. */
export function partialName(finalName, pid = process.pid) {
  return `.${finalName}.${pid}.partial`;
}

/** Leftover .partial files of this database. */
export function isPartialFile(name, database) {
  return name.startsWith(`.${database}-`) && name.endsWith(".partial");
}

/** True for a file this tool wrote for this database (and only that). */
export function isBackupFile(name, database) {
  if (!name.startsWith(`${database}-`) || !name.endsWith(".dump")) return false;
  return /^\d{8}T\d{6}Z$/.test(stampOf(name, database));
}

function stampOf(name, database) {
  return name.slice(database.length + 1, -".dump".length);
}

/** Backups stamped after `now` (the clock was ahead when they were written). */
export function futureBackups(names, database, now = new Date()) {
  const cur = stampOf(backupFileName(database, now), database);
  return names.filter((n) => isBackupFile(n, database) && stampOf(n, database) > cur);
}

/** Backups to delete so about the newest `keep` remain. Other names are never
 *  returned, nor is anything in `protect` (the file just written, which an
 *  ahead-of-time clock could otherwise rank oldest). */
export function backupsToPrune(names, database, keep = KEEP_BACKUPS, protect = []) {
  const mine = names.filter((n) => isBackupFile(n, database)).sort();
  return mine.slice(0, Math.max(0, mine.length - keep)).filter((n) => !protect.includes(n));
}

/** Homebrew PostgreSQL directories to look in after PATH. A launchd job has a
 *  minimal PATH, so PATH alone is not enough. Version selection is separate
 *  (chooseDumpTool), so the order here only breaks ties. */
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

/** From [{ path, major }]: the server's own major if present, else the lowest
 *  newer one (earlier in the list wins ties); never an older one. */
export function chooseDumpTool(tools, serverMaj) {
  const ok = tools.filter((t) => dumpToolIsNewEnough(t.major, serverMaj));
  if (!ok.length) return null;
  const best = Math.min(...ok.map((t) => t.major));
  return ok.find((t) => t.major === best);
}

/** Split a postgres URL into one with no password (userinfo or ?password=)
 *  and the password, so it can travel in PGPASSWORD instead of argv. */
export function splitPassword(url) {
  const u = new URL(url);
  let password = u.password ? decodeURIComponent(u.password) : "";
  u.password = "";
  if (u.searchParams.has("password")) {
    password ||= u.searchParams.get("password");
    u.searchParams.delete("password");
  }
  return { url: u.toString(), password };
}

const xmlEscape = (v) =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Fill the launchd template's __NODE__/__REPO__/__HOME__ with XML-escaped values. */
export function renderPlist(template, { node, repo, home }) {
  return template
    .replace(/__NODE__/g, () => xmlEscape(node))
    .replace(/__REPO__/g, () => xmlEscape(repo))
    .replace(/__HOME__/g, () => xmlEscape(home));
}

/**
 * Dump, link into place, prune. Throws an Error with a user-facing message on
 * failure, leaving no .dump from the failed run and pruning nothing.
 */
export function runBackup({ url, database, dir, tool, now = new Date(), keep = KEEP_BACKUPS, env = process.env, spawn = spawnSync }) {
  // The directory is private when we create it; a pre-existing one is left alone.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Stale partials from crashed runs; a day's grace so a concurrent run is safe.
  for (const n of fs.readdirSync(dir)) {
    if (!isPartialFile(n, database)) continue;
    const f = path.join(dir, n);
    try {
      if (now.getTime() - fs.statSync(f).mtimeMs > DAY_MS) fs.rmSync(f, { force: true });
    } catch {
      /* raced with another run */
    }
  }

  const finalName = backupFileName(database, now);
  const dest = path.join(dir, finalName);
  const tmp = path.join(dir, partialName(finalName));
  // Exclusive and 0600: dumps hold password hashes and conversations.
  fs.closeSync(fs.openSync(tmp, "wx", 0o600));

  const { url: bare, password } = splitPassword(url);
  const childEnv = { ...env };
  if (password) childEnv.PGPASSWORD = password;
  const r = spawn(tool, ["-Fc", "-w", `--dbname=${bare}`, "-f", tmp], { encoding: "utf8", env: childEnv });
  if (r.error || r.status !== 0) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`pg_dump failed (${r.error?.message ?? `exit ${r.status}`}): ${(r.stderr ?? "").trim()}`);
  }
  try {
    fs.chmodSync(tmp, 0o600);
    // link fails if the name exists, so a same-second run never overwrites.
    fs.linkSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`cannot finish backup ${finalName}: ${e.code === "EEXIST" ? "it already exists" : e.message}`);
  }
  fs.rmSync(tmp, { force: true });

  const names = fs.readdirSync(dir);
  const warnings = [];
  const future = futureBackups(names, database, now);
  if (future.length) {
    warnings.push(`${future.length} backup(s) carry a future timestamp (was the clock ahead?): ${future.join(", ")}`);
  }
  const pruned = backupsToPrune(names, database, keep, [finalName]);
  for (const old of pruned) fs.rmSync(path.join(dir, old));
  return { dest, pruned, warnings };
}
