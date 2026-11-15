#!/usr/bin/env node
// npm run db:backup   pg_dump -Fc of DATABASE_URL into backups/ (gitignored;
//                     LINGO_BACKUPS_DIR overrides), keeping the newest 14.
// npm run db:backup:plist -- <out.plist>
//                     write the launchd template, filled in, to the path you
//                     give and nowhere else (installing is up to you;
//                     docs/DATA.md §Backups).
//
// The dump goes to a private .partial file and is linked into place only when
// pg_dump exits 0 (runBackup in backup.mjs), so a failed dump never looks like
// a good backup. Restore: docs/DATA.md §Backups.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { REPO_ROOT } from "../content.mjs";
import { databaseName, databaseUrl, redact } from "./config.mjs";
import { backupsDir, chooseDumpTool, parseMajor, pgDumpCandidates, renderPlist, runBackup, serverMajor } from "./backup.mjs";

function fail(msg) {
  console.error(`db:backup: ${msg}`);
  process.exit(1);
}

function writePlist(out) {
  if (!out) fail("usage: npm run db:backup:plist -- <output path>  (it writes there and nowhere else)");
  const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../macos/com.lingodojo.db-backup.plist.template");
  const text = renderPlist(fs.readFileSync(tpl, "utf8"), { node: process.execPath, repo: REPO_ROOT, home: os.homedir() });
  fs.writeFileSync(out, text);
  console.log(`wrote ${path.resolve(out)}`);
}

async function main() {
  if (process.argv[2] === "--plist") return writePlist(process.argv[3]);
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
  const tools = candidates.map((p) => {
    const v = spawnSync(p, ["--version"], { encoding: "utf8" });
    return { path: p, major: v.status === 0 ? parseMajor(v.stdout) : null, text: (v.stdout ?? "").trim() };
  });
  const tool = chooseDumpTool(tools, serverMaj);
  if (!tool) {
    fail(`no pg_dump as new as the server (PostgreSQL ${serverMaj}). Found: ${tools.map((t) => `${t.path} (${t.major ?? "unusable"})`).join(", ")}.`);
  }
  console.log(`using ${tool.path}: ${tool.text} (server major ${serverMaj})`);

  try {
    const { dest, pruned, warnings } = runBackup({ url, database: name, dir: backupsDir(), tool: tool.path });
    console.log(`wrote ${dest} (${fs.statSync(dest).size} bytes)`);
    for (const w of warnings) console.warn(`warning: ${w}`);
    for (const p of pruned) console.log(`pruned ${p}`);
  } catch (e) {
    fail(e.message);
  }
}

main().catch((e) => fail(e.message));
