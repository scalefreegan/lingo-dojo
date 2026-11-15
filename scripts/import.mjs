#!/usr/bin/env node
// npm run db:import                    pack files → the first admin's learners
// npm run db:import -- --user <name>   … → that account's learners
//
// Copies the pack files into the database (docs/DATA.md §Import):
// content/packs/** to the account's first adult learner and
// content/kids/packs/** to its first kids learner, keeping folder, slug,
// title and created date; every folder under packs/ (an empty one with its
// `.keep` too) becomes a folder. It creates no account and no learner: a
// mode with no learner is skipped and said so. Safe to re-run: a pack the
// learner already has at that id, deleted ones included, is skipped, so a
// re-run adds only packs added to the files since. The app's first run does
// the same for a fresh install (web/server/seed.ts); this is for packs added
// to the files later, or another account.
//
// DATABASE_URL comes from the shell or the checkout's .env.local, like
// db:setup (scripts/db/config.mjs; a linked worktree must set one). The pack
// files come from content/ (LINGO_CONTENT_DIR moves it, as for the loader).

import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { normalizeUsername, usernameProblem } from "./auth.mjs";
import { REPO_ROOT, loadPackFiles, modeRoot } from "./content.mjs";
import { databaseUrl, redact } from "./db/config.mjs";
import { formatImportReport, importFilePacks } from "./db/import.ts";
import * as schema from "./db/schema.ts";

const USAGE = "usage: npm run db:import [-- --user <name>]";

function parseArgs(argv) {
  let user;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--user") {
      user = normalizeUsername(argv[++i] ?? "");
      const problem = usernameProblem(user);
      if (problem) throw new Error(`${problem}\n${USAGE}`);
    } else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argv[i])}\n${USAGE}`);
    }
  }
  return { user };
}

async function main() {
  const { user } = parseArgs(process.argv.slice(2));
  const url = databaseUrl();
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool, { schema });
  try {
    const roots = { adult: modeRoot("adult"), kids: modeRoot("kids") };
    const files = { adult: loadPackFiles(roots.adult), kids: loadPackFiles(roots.kids) };
    const report = await importFilePacks(db, { username: user, files });
    const trees = Object.fromEntries(Object.entries(roots).map(([m, r]) => [m, `${path.relative(REPO_ROOT, path.join(r, "packs")) || "."}/`]));
    console.log(`database: ${redact(url)}`);
    for (const line of formatImportReport(report, trees)) console.log(line);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  const hint =
    e?.code === "ECONNREFUSED" ? " (is Postgres running? brew services start postgresql@17)"
    : e?.code === "3D000" || e?.code === "42P01" ? " (run `npm run db:setup` first)"
    : "";
  console.error(`db:import: ${e?.message || e}${hint}`);
  process.exit(1);
});
