// Where the database is and where its migrations live. Pure ESM with no
// server imports, shared by the dev server (web/server/db.ts), the setup CLI
// (setup.mjs), drizzle.config.ts and the tests.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../content.mjs";
import { envFile, parseEnv } from "../voice.mjs";

export const DEFAULT_DATABASE_URL = "postgres://localhost/lingo_dojo";
export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** A linked git worktree has a `.git` file (pointing at the main repo's
 *  git dir) where the main checkout has a `.git` directory. */
export function isLinkedWorktree(root = REPO_ROOT) {
  try {
    return fs.statSync(path.join(root, ".git")).isFile();
  } catch {
    return false;
  }
}

/**
 * DATABASE_URL: the shell environment, else the checkout's .env.local (read
 * the same way as the voice keys, so the Dock app, which starts without a
 * shell profile, sees it too), else the default local database.
 *
 * Except in a linked worktree. .env.local is gitignored and per checkout, so
 * a worktree usually has none, and the default would be the real database:
 * the boot check's advice (`npm run db:setup`) would then apply an unmerged
 * branch's migrations to it. There, no URL is an error, not the default.
 */
export function databaseUrl(env = process.env, file = envFile(), root = REPO_ROOT) {
  if (env.DATABASE_URL?.trim()) return env.DATABASE_URL.trim();
  try {
    const v = parseEnv(fs.readFileSync(file, "utf8")).DATABASE_URL?.trim();
    if (v) return v;
  } catch {
    /* no file: the default */
  }
  if (isLinkedWorktree(root)) {
    throw new Error(
      `No DATABASE_URL is set, and ${root} is a linked git worktree. Branches and worktrees never use the ` +
        `real database (${DEFAULT_DATABASE_URL}). Set DATABASE_URL, in the shell or in this checkout's .env.local, ` +
        `to a scratch database such as postgres://localhost/lingo_dojo_scratch_<branch>, then run \`npm run db:setup\`.`,
    );
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
