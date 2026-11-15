// runBackup with fake pg_dump scripts: the failure, success and secrecy paths.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backupFileName, chooseDumpTool, futureBackups, renderPlist, runBackup, splitPassword } from "../db/backup.mjs";

const NOW = new Date("2026-11-15T12:00:00Z");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ld-run-"));
  const dir = path.join(root, "backups");
  const fake = (name, body) => {
    const p = path.join(root, name);
    // $out is the argument after -f.
    fs.writeFileSync(
      p,
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -f) out="$2"; shift;; esac; args="$args $1"; shift; done\n${body}\n`,
      { mode: 0o755 },
    );
    return p;
  };
  return { root, dir, fake };
}

const old = (database, days) => backupFileName(database, new Date(NOW.getTime() - days * 86400000));

test("a failing pg_dump leaves no .dump, removes the .partial, prunes nothing", () => {
  const { dir, fake } = sandbox();
  fs.mkdirSync(dir);
  const keepers = Array.from({ length: 16 }, (_, i) => old("db", i + 1));
  for (const n of keepers) fs.writeFileSync(path.join(dir, n), "x");
  const tool = fake("bad", 'echo partial > "$out"; echo boom >&2; exit 1');
  assert.throws(() => runBackup({ url: "postgres://localhost/db", database: "db", dir, tool, now: NOW }), /boom/);
  assert.deepEqual(fs.readdirSync(dir).sort(), [...keepers].sort());
});

test("a good run renames, is 0600, prunes to 14 and keeps the file just written", () => {
  const { dir, fake } = sandbox();
  fs.mkdirSync(dir);
  // 14 older files, plus two stamped in the future (clock was ahead).
  for (let i = 1; i <= 14; i++) fs.writeFileSync(path.join(dir, old("db", i)), "x");
  const future = [old("db", -3), old("db", -4)];
  for (const n of future) fs.writeFileSync(path.join(dir, n), "x");
  const tool = fake("good", 'echo data > "$out"');
  const { dest, pruned, warnings } = runBackup({ url: "postgres://localhost/db", database: "db", dir, tool, now: NOW, keep: 1 });
  assert.equal(fs.readFileSync(dest, "utf8"), "data\n");
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(dest), "just-written file survives");
  assert.ok(!pruned.includes(path.basename(dest)));
  assert.equal(pruned.length, 15); // keep=1 would drop the new file too, but it is protected
  assert.ok(warnings[0].includes("future"));
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith(".partial")));
  assert.equal(futureBackups(fs.readdirSync(dir), "db", NOW).length, 1);
});

test("the directory it creates is 0700; a second run in the same second fails without overwriting", () => {
  const { dir, fake } = sandbox();
  const tool = fake("good", 'echo one > "$out"');
  const { dest } = runBackup({ url: "postgres://localhost/db", database: "db", dir, tool, now: NOW });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const tool2 = fake("good2", 'echo two > "$out"');
  assert.throws(() => runBackup({ url: "postgres://localhost/db", database: "db", dir, tool: tool2, now: NOW }), /already exists/);
  assert.equal(fs.readFileSync(dest, "utf8"), "one\n");
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith(".partial")));
});

test("the password reaches pg_dump through PGPASSWORD, never argv", () => {
  const { root, dir, fake } = sandbox();
  const log = path.join(root, "seen.txt");
  const tool = fake("spy", `echo "ENV=$PGPASSWORD" > "${log}"; echo "ARGS=$args" >> "${log}"; echo d > "$out"`);
  runBackup({ url: "postgres://me:s%40cret@localhost/db?sslmode=prefer", database: "db", dir, tool, now: NOW, env: { PATH: process.env.PATH } });
  const seen = fs.readFileSync(log, "utf8");
  assert.match(seen, /ENV=s@cret/);
  assert.ok(!seen.split("ARGS=")[1].includes("cret"));
  assert.match(seen, /-w/);
  runBackup({ url: "postgres://me@localhost/db?password=q9", database: "db", dir, tool, now: new Date(NOW.getTime() + 5000), env: { PATH: process.env.PATH } });
  assert.match(fs.readFileSync(log, "utf8"), /ENV=q9/);
  assert.ok(!fs.readFileSync(log, "utf8").split("ARGS=")[1].includes("q9"));
});

test("stale .partial files of this database go; fresh ones and other files stay", () => {
  const { dir, fake } = sandbox();
  fs.mkdirSync(dir);
  const stale = path.join(dir, ".db-20200101T000000Z.dump.1.partial");
  const fresh = path.join(dir, ".db-20261115T115900Z.dump.2.partial");
  const other = path.join(dir, ".other-20200101T000000Z.dump.1.partial");
  for (const f of [stale, fresh, other]) fs.writeFileSync(f, "x");
  const longAgo = new Date(NOW.getTime() - 3 * 86400000);
  fs.utimesSync(stale, longAgo, longAgo);
  fs.utimesSync(other, longAgo, longAgo);
  fs.utimesSync(fresh, NOW, NOW);
  runBackup({ url: "postgres://localhost/db", database: "db", dir, tool: fake("g", 'echo d > "$out"'), now: NOW });
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.existsSync(other));
});

test("tool choice: equal major, else lowest newer, never older", () => {
  const t = (p, major) => ({ path: p, major });
  assert.equal(chooseDumpTool([t("a", 18), t("b", 17), t("c", 16)], 17).path, "b");
  assert.equal(chooseDumpTool([t("a", 18), t("b", 19), t("c", 16)], 17).path, "a");
  assert.equal(chooseDumpTool([t("c", 16), t("d", null)], 17), null);
});

test("splitPassword and renderPlist", () => {
  assert.deepEqual(splitPassword("postgres://u:p%23w@h:5432/d?x=1"), { url: "postgres://u@h:5432/d?x=1", password: "p#w" });
  assert.deepEqual(splitPassword("postgres://localhost/d"), { url: "postgres://localhost/d", password: "" });
  const out = renderPlist("<s>__NODE__</s><s>__REPO__</s><s>__HOME__</s>", { node: "/n", repo: "/a&b#<c>", home: "/h" });
  assert.equal(out, "<s>/n</s><s>/a&amp;b#&lt;c&gt;</s><s>/h</s>");
});
