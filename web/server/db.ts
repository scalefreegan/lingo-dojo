// The database handle: one pg Pool and one Drizzle instance for the whole
// dev server, made on first use so that importing this module (as api.ts
// does, and so the HTTP tests do) never opens a connection. docs/DATA.md is
// the design; scripts/db/ holds the schema, migrations and setup CLI.
//
// Route code reaches personal rows through forLanguageProfile()/forLearner()/forUser()
// (scripts/db/owned.ts), which cannot build a query without the owner id.
// rawDb() is for the few owner-less lookups (a login by username, a session
// by token hash); a call to it in a route deserves a second look in review.

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { databaseUrl, readerRole, redact } from "../../scripts/db/config.mjs";
import { bankReaderProblem, describeMigrations, migrationState } from "../../scripts/db/migrations.mjs";
import { forLanguageProfile, forLearner, forUser, type Db, type LanguageProfileRef } from "../../scripts/db/owned.ts";
import * as schema from "../../scripts/db/schema.ts";

export { schema };
export type { Db };

let pool: pg.Pool | null = null;
let db: Db | null = null;
/** A database handed in from outside (setDb): the HTTP tests' PGlite. */
let injected: Db | null = null;

/** Serve every route from this handle instead of the pool: the HTTP tests
 *  mount the real plugin on an in-process PGlite (apiPlugins({ db })), so
 *  they run the real routes with no Postgres server. null goes back to the
 *  pool. */
export function setDb(handle: Db | null): void {
  injected = handle;
}

/** The pool, created on first call from DATABASE_URL (.env.local, default
 *  postgres://localhost/lingo_dojo). Read once: changing the URL needs a
 *  restart, unlike the voice keys, since the pool holds connections. */
function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: databaseUrl(), max: 10 });
    // An idle client's connection dropping (Postgres restarted) emits here;
    // unhandled, it would take the dev server down with it.
    pool.on("error", (e) => console.error("[lingo-dojo] postgres pool:", e.message));
  }
  return pool;
}

/** The Drizzle instance over the shared pool. */
export function rawDb(): Db {
  if (injected) return injected;
  if (!db) db = drizzle(getPool(), { schema });
  return db;
}

/** Rows owned by this learner (scripts/db/owned.ts). */
export const learnerRows = (learnerId: string) => forLearner(rawDb(), learnerId);
/** Rows owned by one of a learner's languages: packs, conversations, turns, … */
export const profileRows = (profile: LanguageProfileRef) => forLanguageProfile(rawDb(), profile);
/** Account rows owned by this user (scripts/db/owned.ts). */
export const userRows = (userId: string) => forUser(rawDb(), userId);

/** Close the pool (tests, shutdown). The next call makes a new one. */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  db = null;
  await p?.end();
}

const FIX = "Run `npm run db:setup` (creates the database if needed and applies migrations), then start the server again.";
/** The end of every fix for a server already running (dbGate.ts): it
 *  re-checks by itself, so nothing needs restarting. */
const BY_ITSELF = "the API comes back by itself once the database is current, with no restart.";

/**
 * The boot check's refusal. `message` is for the terminal at a first start:
 * where the database is and what to run before starting again. `problem` and
 * `liveFix` are the same news for a server that is already running (a Vite
 * restart, dbGate.ts), without the URL, so they may reach the page too.
 */
export class DatabaseNotReady extends Error {
  /** "is behind: 1 migration(s) of 10 not applied", "cannot be reached: …" */
  readonly problem: string;
  /** What to run while the server keeps running. */
  readonly liveFix: string;
  constructor(message: string, problem: string, liveFix: string) {
    super(message);
    this.name = "DatabaseNotReady";
    this.problem = problem;
    this.liveFix = liveFix;
  }
}

/**
 * The boot check: the database answers and its recorded migrations match the
 * committed ones exactly (scripts/db/migrations.mjs: behind, skipped, ahead
 * and diverged all refuse). Throws a DatabaseNotReady saying what is wrong
 * and what to run; a half-migrated schema would otherwise fail later, far
 * from the cause. It only reads; migrating is always an explicit
 * `npm run db:migrate` / `db:setup`. In a linked worktree with no
 * DATABASE_URL, databaseUrl() throws before anything connects (config.mjs).
 * api.ts runs it whenever the plugin starts, and dbGate.ts again while a
 * restarted server waits for its database.
 */
export async function checkDatabase(url?: string): Promise<{ applied: number; total: number }> {
  url ??= databaseUrl();
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  const where = redact(url);
  try {
    await client.connect();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const missing = err.code === "3D000";
    const login = err.code === "28P01" || err.code === "28000";
    const why =
      missing ? "the database does not exist"
      : err.code === "ECONNREFUSED" ? "nothing is listening (is Postgres running? brew services start postgresql@17)"
      : err.message || String(e);
    await client.end().catch(() => {});
    // `problem` and `liveFix` may reach a page (dbGate.ts), so they are fixed
    // sentences: a driver's own text can name a role, a host or a path, and
    // only the terminal gets that (the message).
    const problem =
      missing ? "does not exist"
      : err.code === "ECONNREFUSED" ? "cannot be reached: nothing is listening"
      : login ? "refused the server's login"
      : "cannot be reached";
    const liveFix =
      missing ? `Run \`npm run db:setup\`; ${BY_ITSELF}`
      : login ? `Fix the login in DATABASE_URL (the server's terminal has the details); ${BY_ITSELF}`
      : `The server's terminal has the details; ${BY_ITSELF}`;
    throw new DatabaseNotReady(`Lingo Dojo cannot reach its database at ${where}: ${why}.\n${FIX}`, problem, liveFix);
  }
  try {
    const query = async (text: string, params?: unknown[]) => (await client.query(text, params)).rows;
    const state = await migrationState(query);
    if (state.status !== "current") {
      const foreign = state.status === "ahead" || state.status === "diverged";
      const fix = foreign
        ? "This checkout can't migrate it; point DATABASE_URL at a database for this branch (or update the checkout)."
        : FIX;
      const problem = `is ${describeMigrations(state)}`;
      throw new DatabaseNotReady(
        `Lingo Dojo's database at ${where} ${problem}.\n${fix}`,
        problem,
        foreign
          ? "This checkout can't migrate it; update the checkout, or point DATABASE_URL at a database for this branch and restart."
          : `Run \`npm run db:migrate\`; ${BY_ITSELF}`,
      );
    }
    // Not fatal: without its policies or grants the agent's bank tools fail
    // closed (no rows, or an error) and everything else works. Said at boot
    // so a bad restore is noticed (docs/DATA.md §Backups).
    try {
      const problem = await bankReaderProblem(query, readerRole());
      if (problem) console.warn(`[lingo-dojo] the content agent's phrase-bank access is incomplete: ${problem}. See docs/DATA.md §Backups.`);
    } catch (e) {
      console.warn(`[lingo-dojo] could not check the content agent's phrase-bank access: ${(e as Error).message}`);
    }
    return { applied: state.applied, total: state.total };
  } finally {
    await client.end().catch(() => {});
  }
}
