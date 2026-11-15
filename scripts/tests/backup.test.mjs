import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  backupFileName,
  backupsDir,
  backupsToPrune,
  dumpToolIsNewEnough,
  isBackupFile,
  parseMajor,
  partialName,
  pgDumpCandidates,
  serverMajor,
} from "../db/backup.mjs";

test("file name carries the database and a sortable UTC stamp", () => {
  const n = backupFileName("lingo_dojo", new Date("2026-11-15T03:15:09.123Z"));
  assert.equal(n, "lingo_dojo-20261115T031509Z.dump");
  assert.ok(isBackupFile(n, "lingo_dojo"));
  assert.ok(!isBackupFile(n, "other"));
  assert.ok(!isBackupFile(partialName(n), "lingo_dojo"));
});

test("pruning keeps the newest N of this database's own files and nothing else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-backup-"));
  const names = [];
  for (let d = 1; d <= 20; d++) names.push(backupFileName("db", new Date(Date.UTC(2026, 10, d))));
  const others = ["db_other-20260101T000000Z.dump", "notes.txt", "db-latest.dump", ".db-20260101T000000Z.dump.partial"];
  for (const n of [...names, ...others]) fs.writeFileSync(path.join(dir, n), "x");
  const drop = backupsToPrune(fs.readdirSync(dir), "db", 14);
  assert.deepEqual(drop, names.slice(0, 6));
  for (const n of drop) fs.rmSync(path.join(dir, n));
  assert.equal(fs.readdirSync(dir).length, 14 + others.length);
  assert.deepEqual(backupsToPrune(fs.readdirSync(dir), "db", 14), []);
  fs.rmSync(dir, { recursive: true });
});

test("backups dir honours LINGO_BACKUPS_DIR", () => {
  assert.equal(backupsDir({ LINGO_BACKUPS_DIR: "/x/y" }, "/r"), "/x/y");
  assert.equal(backupsDir({}, "/r"), path.join("/r", "backups"));
});

test("pg_dump lookup: PATH first, then Homebrew, only existing files", () => {
  const exists = (p) => p === "/p/bin/pg_dump" || p === "/opt/homebrew/opt/postgresql@17/bin/pg_dump";
  const found = pgDumpCandidates({ PATH: "/p/bin:/q/bin:/p/bin" }, exists);
  assert.deepEqual(found, ["/p/bin/pg_dump", "/opt/homebrew/opt/postgresql@17/bin/pg_dump"]);
  assert.deepEqual(pgDumpCandidates({ PATH: "" }, () => false), []);
});

test("version parsing and the no-older rule", () => {
  assert.equal(parseMajor("pg_dump (PostgreSQL) 17.10 (Homebrew)"), 17);
  assert.equal(parseMajor("nonsense"), null);
  assert.equal(serverMajor("170010"), 17);
  assert.equal(serverMajor("garbage"), null);
  assert.ok(dumpToolIsNewEnough(17, 17));
  assert.ok(dumpToolIsNewEnough(18, 17));
  assert.ok(!dumpToolIsNewEnough(16, 17));
  assert.ok(!dumpToolIsNewEnough(null, 17));
});
