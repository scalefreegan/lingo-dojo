#!/usr/bin/env node
// npm run db:backup   pg_dump -Fc of DATABASE_URL into backups/ (gitignored;
//                     LINGO_BACKUPS_DIR overrides), keeping the newest 14.
//
// The dump goes to a dot-prefixed .partial name and is renamed only when
// pg_dump exits 0, so a failed dump never looks like a good backup. Pruning
// touches only this database's own `<db>-<UTC stamp>.dump` files.
// Restore: docs/DATA.md §Backups (pg_restore into an explicitly named database).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { databaseName, databaseUrl, redact } from "./config.mjs";
import {
  KEEP_BACKUPS,
  backupFileName,
  backupsDir,
  backupsToPrune,
  dumpToolIsNewEnough,
  parseMajor,
  partialName,
  pgDumpCandidates,
  serverMajor,
} from "./backup.mjs";

function fail(msg) {
  console.error(`db:backup: ${msg}`);
  process.exit(1);
}

async function main() {
  const url = databaseUrl();
  const name = databaseName(url);
  console.log(`database: ${redact(url)}`);

  const client = new pg.Client({ connectionString: url });
  let serverMaj;
  try {
    await client.connect();
    serverMaj = serverMajor((await client.query("show server_version_num")).rows[0].server_version_num);
  } catch (e) {
    fail(`cannot reach the database: ${e.message}`);
  } finally {
    await client.end().catch(() => {});
  }

  const candidates = pgDumpCandidates();
  if (!candidates.length) {
    fail("pg_dump not found on PATH or in the Homebrew PostgreSQL locations (brew install postgresql@17).");
  }
  // First candidate that is new enough for the server.
  let tool = null;
  const seen = [];
  for (const c of candidates) {
    const v = spawnSync(c, ["--version"], { encoding: "utf8" });
    const major = v.status === 0 ? parseMajor(v.stdout) : null;
    seen.push(`${c} (${major ?? "unusable"})`);
    if (dumpToolIsNewEnough(major, serverMaj)) {
      tool = c;
      break;
    }
  }
  if (!tool) fail(`no pg_dump as new as the server (PostgreSQL ${serverMaj}). Found: ${seen.join(", ")}.`);

  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const finalName = backupFileName(name);
  const tmp = path.join(dir, partialName(finalName));
  const dest = path.join(dir, finalName);
  const r = spawnSync(tool, ["-Fc", `--dbname=${url}`, "-f", tmp], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    fs.rmSync(tmp, { force: true });
    fail(`pg_dump failed (${r.error?.message ?? `exit ${r.status}`}): ${(r.stderr ?? "").trim()}`);
  }
  fs.renameSync(tmp, dest);
  console.log(`wrote ${dest} (${fs.statSync(dest).size} bytes, ${tool})`);

  for (const old of backupsToPrune(fs.readdirSync(dir), name, KEEP_BACKUPS)) {
    fs.rmSync(path.join(dir, old));
    console.log(`pruned ${old}`);
  }
}

main().catch((e) => fail(e.message));
