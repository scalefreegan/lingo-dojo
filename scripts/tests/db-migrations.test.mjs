// Migration bookkeeping (scripts/db/migrations.mjs) and the schema/SQL drift
// check (scripts/db/hand-edits.mjs). The database tests run on in-process
// PGlite; the drift check runs drizzle-kit into a temp directory. Neither
// needs a Postgres server.
//   node --test scripts/tests/db-migrations.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { freshDb } from "./testdb.mjs";
import { MIGRATIONS_DIR } from "../db/config.mjs";
import { applyHandEdits, INITIAL_MIGRATION, SET_NULL_COLUMNS } from "../db/hand-edits.mjs";
import { applyMigrations, compareMigrations, describeMigrations, migrationState, migrationsOnDisk } from "../db/migrations.mjs";
import { REPO_ROOT } from "../content.mjs";

const rowsOf = (pg) => async (text, params) => (await pg.query(text, params)).rows;

/** Three made-up migrations, oldest first, each creating one table. */
const fake = (n, when) => ({ hash: `hash-${n}`, folderMillis: when, sql: [`create table t${n} (id int)`] });
const M1 = fake(1, 1000);
const M2 = fake(2, 2000);
const M3 = fake(3, 3000);

test("the committed migrations leave a fresh database current", async (t) => {
  const { query, close } = await freshDb();
  t.after(close);
  const state = await migrationState(query);
  assert.equal(state.status, "current");
  assert.equal(state.total, migrationsOnDisk().length);
  assert.equal(state.applied, state.total);
  // Applying again is a no-op.
  const again = await applyMigrations(query);
  assert.deepEqual(again.applied, []);
});

test("compareMigrations tells behind, skipped, ahead and diverged apart", () => {
  const rec = (...ms) => ms.map((m) => ({ hash: m.hash, createdAt: m.folderMillis }));
  assert.equal(compareMigrations([M1, M2], rec(M1, M2)).status, "current");
  assert.equal(compareMigrations([M1, M2, M3], rec(M1)).status, "behind");
  assert.equal(compareMigrations([M1, M2, M3], []).status, "behind");
  // M2 merged after M3 was applied: drizzle's timestamp rule skips it forever.
  const skipped = compareMigrations([M1, M2, M3], rec(M1, M3));
  assert.equal(skipped.status, "skipped");
  assert.deepEqual(skipped.skipped.map((m) => m.hash), ["hash-2"]);
  assert.match(describeMigrations(skipped), /out-of-order/);
  assert.equal(compareMigrations([M1], rec(M1, M2)).status, "ahead");
  assert.equal(compareMigrations([M1, M3], rec(M1, M2)).status, "diverged");
  // An applied file edited afterwards changes its hash: the database knows a
  // migration the checkout doesn't, and the checkout's isn't applied.
  assert.equal(compareMigrations([{ ...M1, hash: "edited" }], rec(M1)).status, "diverged");
});

test("an out-of-order migration is caught and then applied by hash (PGlite)", async (t) => {
  const pg = await PGlite.create();
  t.after(() => pg.close());
  const query = rowsOf(pg);
  // Branch B's M3 is applied first…
  await applyMigrations(query, [M1, M3]);
  assert.equal((await migrationState(query, [M1, M3])).status, "current");
  // …then branch A's older M2 merges. Drizzle's rule (when <= newest applied)
  // would call this current; by hash it is skipped, and the boot check refuses.
  const state = await migrationState(query, [M1, M2, M3]);
  assert.equal(state.status, "skipped");
  const { applied } = await applyMigrations(query, [M1, M2, M3]);
  assert.deepEqual(applied.map((m) => m.hash), ["hash-2"]);
  assert.equal((await migrationState(query, [M1, M2, M3])).status, "current");
  assert.equal((await query(`select to_regclass('t2')::text as t`))[0].t, "t2");
});

test("a database ahead of the checkout is refused, untouched (PGlite)", async (t) => {
  const pg = await PGlite.create();
  t.after(() => pg.close());
  const query = rowsOf(pg);
  await applyMigrations(query, [M1, M2]);
  assert.equal((await migrationState(query, [M1])).status, "ahead");
  await assert.rejects(applyMigrations(query, [M1]), /refusing to migrate: the database is ahead/);
  await assert.rejects(applyMigrations(query, [M1, M3]), /refusing to migrate: the database is diverged/);
  assert.equal((await query(`select to_regclass('t3')::text as t`))[0].t, null, "nothing applied");
});

test("a failing migration rolls back whole (PGlite)", async (t) => {
  const pg = await PGlite.create();
  t.after(() => pg.close());
  const query = rowsOf(pg);
  const bad = { hash: "bad", folderMillis: 4000, sql: ["create table t4 (id int)", "select nonsense from nowhere"] };
  await assert.rejects(applyMigrations(query, [M1, bad]));
  assert.equal((await migrationState(query, [M1, bad])).applied, 0);
  assert.equal((await query(`select to_regclass('t1')::text as t`))[0].t, null);
});

/* ------------------------------- drift check ------------------------------ */

const drizzleKit = path.join(REPO_ROOT, "node_modules", ".bin", "drizzle-kit");
// drizzle-kit takes --out relative to the cwd (it prefixes "./"), and exits 0
// even when it fails, so callers check what it wrote, not its status.
const generate = (out) =>
  execFileSync(drizzleKit, ["generate", "--dialect", "postgresql", "--schema", "./scripts/db/schema.ts", "--out", path.relative(REPO_ROOT, out), "--name", "check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "postgres://localhost/unused" },
  });

test("schema.ts matches the latest migration snapshot (no ungenerated changes)", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-drift-"));
  fs.cpSync(MIGRATIONS_DIR, out, { recursive: true });
  const before = fs.readdirSync(out).filter((f) => f.endsWith(".sql"));
  const log = generate(out);
  const after = fs.readdirSync(out).filter((f) => f.endsWith(".sql"));
  assert.deepEqual(after, before, `schema.ts has changes no migration holds; run npm run db:generate\n${log}`);
  assert.match(log, /No schema changes/, `drizzle-kit did not run cleanly:\n${log}`);
});

const journal = () => JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"));

test("0000_init.sql is drizzle-kit's output plus exactly the documented hand edits", (t) => {
  // Generating from nothing reproduces the initial migration only while it is
  // the only one: schema.ts has moved on since. Its hash is in every
  // migrated database, so an edit to it is caught there (applied by hash).
  if (journal().entries.length !== 1) return t.skip("0000 is no longer the latest migration; the next test checks the latest");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-gen-"));
  generate(out);
  const [file] = fs.readdirSync(out).filter((f) => f.endsWith(".sql"));
  const generated = fs.readFileSync(path.join(out, file), "utf8");
  assert.equal(fs.readFileSync(INITIAL_MIGRATION, "utf8"), applyHandEdits(generated));
});

test("the latest later migration is exactly drizzle-kit's output from the ones before it, plus its documented hand edits", (t) => {
  const { entries } = journal();
  if (entries.length < 2) return t.skip("only the initial migration");
  const latest = entries[entries.length - 1];
  const prior = entries.slice(0, -1);
  // The migrations folder as it was before the latest one: its SQL, its
  // snapshots and a journal that ends one earlier.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-gen-"));
  fs.mkdirSync(path.join(out, "meta"));
  for (const e of prior) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(out, `${e.tag}.sql`));
    const snap = `${String(e.idx).padStart(4, "0")}_snapshot.json`;
    fs.copyFileSync(path.join(MIGRATIONS_DIR, "meta", snap), path.join(out, "meta", snap));
  }
  fs.writeFileSync(path.join(out, "meta", "_journal.json"), JSON.stringify({ ...journal(), entries: prior }));
  const log = generate(out);
  const made = fs.readdirSync(out).filter((f) => f.endsWith(".sql") && !prior.some((e) => f === `${e.tag}.sql`));
  assert.equal(made.length, 1, `drizzle-kit wrote no new migration:\n${log}`);
  // applyHandEdits is the identity for a migration with no edits (0001).
  const generated = fs.readFileSync(path.join(out, made[0]), "utf8");
  assert.equal(fs.readFileSync(path.join(MIGRATIONS_DIR, `${latest.tag}.sql`), "utf8"), applyHandEdits(generated, latest.tag));
});

test("0002's hand edits only reorder drizzle-kit's statements, relax five NOT NULLs, add the backfill and SET NULL (col)", () => {
  // Pinned on the committed file, so a change to hand-edits.mjs that slips
  // in anything else shows here, not only as a different hash.
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, "0002_language_profiles.sql"), "utf8");
  const stmts = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  const handWritten = stmts.filter((s) => s.startsWith("-- Hand-written") || /ALTER COLUMN "language_profile_id" SET NOT NULL/.test(s));
  assert.equal(handWritten.length, 1 + 5 + 1 + 5, "one insert, five table updates, one session update, five SET NOT NULL");
  const at = (re) => stmts.findIndex((s) => re.test(s));
  // Each step after what it needs.
  assert.ok(at(/^CREATE TABLE "language_profiles"/) < at(/INSERT INTO "language_profiles"/));
  assert.ok(at(/ADD COLUMN "language_profile_id"/) < at(/INSERT INTO "language_profiles"/));
  assert.ok(at(/SET NOT NULL/) < at(/PRIMARY KEY\("language_profile_id"/));
  assert.ok(at(/UNIQUE\("id","language_profile_id"\)/) < at(/"pack_revisions_pack_profile_fk"/));
  assert.ok(stmts.slice(at(/DROP COLUMN/)).every((s) => /^ALTER TABLE "learners" DROP COLUMN/.test(s)), "the learner columns go last");
  assert.match(sql, /"auth_sessions_language_profile_fk" FOREIGN KEY [^\n]*ON DELETE SET NULL \("language_profile_id"\)/);
  assert.doesNotMatch(sql, /ADD COLUMN "language_profile_id" uuid NOT NULL/);
});

test("the hand-edited keys null only their link column (PGlite catalog)", async (t) => {
  const { query, close } = await freshDb();
  t.after(close);
  const rows = await query(`
    select c.conname, a.attname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.confdelsetcols)
    where c.contype = 'f' and c.confdeltype = 'n' and c.confdelsetcols is not null
    order by 1`);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.conname, r.attname])), SET_NULL_COLUMNS);
});

test("0003's hand edits only reorder drizzle-kit's statements, relax five NOT NULLs and add the backfill", () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, "0003_phrase_bank_per_language.sql"), "utf8");
  const stmts = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  const at = (re) => stmts.findIndex((s) => re.test(s));
  assert.doesNotMatch(sql, /ADD COLUMN "language_profile_id" uuid NOT NULL/);
  assert.equal(stmts.filter((s) => /ALTER COLUMN "language_profile_id" SET NOT NULL/.test(s)).length, 5);
  // Each step after what it needs: the columns, the backfill and merge,
  // NOT NULL, the old indexes out, then the unique keys before the foreign
  // keys that reference them.
  assert.ok(at(/ADD COLUMN "language_profile_id"/) < at(/UPDATE "phrases" SET "language_profile_id"/));
  assert.ok(at(/CREATE TEMPORARY TABLE "phrase_merge"/) < at(/DROP TABLE "phrase_merge"/));
  assert.ok(at(/SET NOT NULL/) < at(/DROP INDEX "phrases_identity"/));
  assert.ok(at(/DROP INDEX "phrases_identity"/) < at(/CREATE UNIQUE INDEX "phrases_profile_identity"/));
  assert.ok(at(/"phrases_id_profile" UNIQUE/) < at(/"cards_phrase_profile_fk" FOREIGN KEY/));
  assert.ok(at(/"cards_id_profile" UNIQUE/) < at(/"reviews_card_profile_fk" FOREIGN KEY/));
  // Outside the backfill, every statement is one drizzle-kit wrote.
  const first = at(/^-- Hand-written/);
  const last = stmts.findLastIndex((s) => /SET NOT NULL/.test(s));
  const generated = [...stmts.slice(0, first), ...stmts.slice(last + 1)];
  assert.ok(generated.every((s) => /^(ALTER TABLE "\w+" ADD (COLUMN|CONSTRAINT)|DROP INDEX|CREATE (UNIQUE )?INDEX)/.test(s)));
});
