// The dev server's boot decision (bead ld-tdd, web/server/api.ts bootGate):
// a first start on a database that isn't current refuses (throws, so
// `npm run dev` exits with what to run); a restart in the same process
// comes up behind the 503 gate, mounted ahead of every route. A stand-in
// check and flag; no database.
//   node --test scripts/tests/db-gate-boot.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFixture } from "./helpers.mjs";
import { DatabaseNotReady } from "../../web/server/db.ts";

process.env.LINGO_CONTENT_DIR = copyFixture();
const { apiPlugins, bootGate } = await import("../../web/server/api.ts");

const quiet = () => ({ lines: [], info(m) { this.lines.push(m); }, error(m) { this.lines.push(m); } });
const behind = () => new DatabaseNotReady("at postgres://secret-host/x: behind", "is behind: 1 migration(s) of 10 not applied", "Run `npm run db:migrate`.");
const failing = async () => { throw behind(); };
const passing = async () => ({ applied: 10 });

test("first start, database behind: refuses, and the process is not marked started", async () => {
  const flag = {};
  await assert.rejects(bootGate(quiet(), { check: failing, flag }), DatabaseNotReady);
  assert.equal(Object.getOwnPropertySymbols(flag).length, 0, "a refused first start must not mark the process started");
  // so a second attempt in the same state still refuses
  await assert.rejects(bootGate(quiet(), { check: failing, flag }), DatabaseNotReady);
});

test("first start current, then a restart onto a database behind: comes up gated", async () => {
  const flag = {};
  const first = await bootGate(quiet(), { check: passing, flag });
  assert.equal(first.error, null);
  const log = quiet();
  const restarted = await bootGate(log, { check: failing, flag });
  assert.ok(restarted.error instanceof DatabaseNotReady);
  assert.ok(log.lines.some((l) => /503/.test(l)), "the terminal says the API answers 503");
});

test("the plugin mounts the gate ahead of every route", async () => {
  const flag = {};
  await bootGate(quiet(), { check: passing, flag }); // the first start
  const mounts = [];
  const server = {
    middlewares: { use: (pathOrFn, fn) => mounts.push({ path: typeof pathOrFn === "string" ? pathOrFn : "", fn: fn ?? pathOrFn }) },
    config: { logger: { info() {}, error() {} } },
  };
  await apiPlugins({ boot: { check: failing, flag } }).configureServer(server);
  assert.ok(mounts.length > 2);
  assert.equal(mounts[0].path, "/api");
  // the first mount answers 503 for a request a route would otherwise take
  const reply = await new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, end: (b) => resolve({ status: res.statusCode, body: JSON.parse(b) }) };
    mounts[0].fn({ url: "/learners" }, res, () => resolve("next"));
  });
  assert.equal(reply.status, 503);
  assert.doesNotMatch(reply.body.error, /secret-host/);
  assert.match(reply.body.error, /db:migrate/);
});
