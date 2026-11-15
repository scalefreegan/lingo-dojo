// End racing a voice turn, on a real Postgres. PGlite (the rest of the
// suite) runs one transaction at a time, so there End nearly always wins and
// the race can't show; this runs only when LINGO_TEST_PG_URL names a
// Postgres to connect to, and is skipped otherwise.
//
// The rule it checks (web/server/conversations.ts, the lock): End and a turn
// sent at the same moment end one of two ways. The turn is stored in the
// conversation and End waited for it, or the turn is refused with
// conversation_ended before the dojo master ran. Never a turn that was
// answered (and paid for) and then left unsaved.
//
// Like first-run.pg.test.mjs, it never touches the database the URL names
// beyond connecting: it makes a throwaway database on that server, migrates
// it, races there, and drops it. The stand-in `claude` (fake-claude.mjs)
// answers; nothing real is spawned.
//   LINGO_TEST_PG_URL=postgres://localhost/some_scratch_db node --test scripts/tests/conversations.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../db/migrations.mjs";
import * as schema from "../db/schema.ts";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, addUser, client } from "./http-session.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";
const TRIALS = 60;

test(`End and a turn at the same moment on real Postgres, ${TRIALS} times: stored or refused, never answered unsaved`, { skip }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
  process.env.LINGO_CONTENT_DIR = copyFixture();
  process.env.LINGO_DATA_DIR = dataDir;
  process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
  const { apiPlugins } = await import("../../web/server/api.ts");

  const name = `lingo_dojo_test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: 16 });
  const fake = fakeClaude();
  fake.install();
  let server;
  try {
    await applyMigrations(async (text, params) => (await pool.query(text, params)).rows);
    const db = drizzle(pool, { schema });
    server = await serveApi(apiPlugins, { db });
    await addUser(db, "racer", undefined, { learners: [{ ...ADULT, name: "Rae" }] });
    const rae = client(server.base);
    await rae.login("racer");
    await rae.pick("Rae");
    const pack = { title: "", created: "", scenario: "market", quick_scenario: "", units: [], overrides: {}, notes: "" };

    const outcomes = { stored: 0, refused: 0 };
    for (let i = 0; i < TRIALS; i++) {
      const made = await rae.call("POST", "/api/conversations", { mode: "adult", pack });
      assert.equal(made.status, 201, made.text);
      const id = made.body.conversation.id;
      const before = fake.runs();
      const [e, r] = await Promise.all([
        rae.call("POST", `/api/conversations/${id}/end`),
        rae.call("POST", "/api/voice/turn", { mode: "adult", pack, history: [], message: "", elapsedMs: 0, conversationId: id }),
      ]);
      assert.equal(e.status, 200, e.text);
      const { rows } = await pool.query("select count(*)::int as n from turns where conversation_id = $1", [id]);
      if (r.status === 200) {
        assert.equal(r.body.saved, true, `trial ${i}: the turn ran, so it must be stored`);
        assert.equal(rows[0].n, 1, `trial ${i}`);
        outcomes.stored++;
      } else {
        assert.equal(r.status, 409, `trial ${i}: ${r.text}`);
        assert.equal(r.body.code, "conversation_ended", `trial ${i}`);
        assert.equal(fake.runs(), before, `trial ${i}: refused before claude`);
        assert.equal(rows[0].n, 0, `trial ${i}`);
        outcomes.refused++;
      }
    }
    t.diagnostic(`outcomes: ${JSON.stringify(outcomes)}`);
  } finally {
    await server?.close();
    fake.restore();
    await pool.end();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
});
