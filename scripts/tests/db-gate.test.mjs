// The database gate in front of /api after a Vite restart (bead ld-tdd,
// web/server/dbGate.ts): open when the check passes; closed, it answers 503
// with what to run, re-checks at most every retryMs and one check at a
// time, and opens for good once the database is current. A stand-in check
// and clock; no database.
//   node --test scripts/tests/db-gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { notReadyMessage, openDatabaseGate } from "../../web/server/dbGate.ts";
import { DatabaseNotReady } from "../../web/server/db.ts";

const quiet = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(m), error: (m) => lines.push(m) };
};

/** Push one request through the gate: "next" if it passed, else the reply. */
function hit(gate) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => (headers[k.toLowerCase()] = v),
      end: (body) => resolve({ status: res.statusCode, headers, body: JSON.parse(body) }),
    };
    gate.middleware({ url: "/learners" }, res, () => resolve("next"));
  });
}

const behind = () =>
  new DatabaseNotReady(
    "Lingo Dojo's database at postgres://localhost/x is behind: 1 migration(s) of 10 not applied.\nRun `npm run db:setup` …",
    "is behind: 1 migration(s) of 10 not applied",
    "Run `npm run db:migrate`; the API comes back by itself once the database is current, with no restart.",
  );

test("a current database: the gate is open and every request passes", async () => {
  let calls = 0;
  const gate = await openDatabaseGate(async () => void calls++, { log: quiet() });
  assert.equal(gate.error, null);
  assert.equal(await hit(gate), "next");
  assert.equal(await hit(gate), "next");
  assert.equal(calls, 1, "an open gate never checks again");
});

test("behind: 503 naming db:migrate, no URL; re-checked at most every retryMs; opens once migrated", async () => {
  let t = 1000;
  let current = false;
  let calls = 0;
  const log = quiet();
  const check = async () => {
    calls++;
    if (!current) throw behind();
  };
  const gate = await openDatabaseGate(check, { log, retryMs: 2000, now: () => t });
  assert.ok(gate.error instanceof DatabaseNotReady);

  const r = await hit(gate);
  assert.equal(r.status, 503);
  assert.equal(r.headers["retry-after"], "2");
  assert.match(r.body.error, /behind: 1 migration\(s\) of 10 not applied/);
  assert.match(r.body.error, /npm run db:migrate/);
  assert.doesNotMatch(r.body.error, /postgres:\/\//, "the page never sees the database URL");
  assert.equal(calls, 1, "inside retryMs the last answer stands");

  current = true; // `npm run db:migrate` ran
  t += 1999;
  assert.equal((await hit(gate)).status, 503, "still inside retryMs");
  assert.equal(calls, 1);
  t += 1;
  assert.equal(await hit(gate), "next", "the first request after retryMs re-checks and passes");
  assert.equal(calls, 2);
  assert.equal(gate.error, null);
  assert.ok(log.lines.some((l) => /serving again/.test(l)));
  t += 10_000;
  assert.equal(await hit(gate), "next");
  assert.equal(calls, 2, "open for good: no more checks");
});

test("requests arriving during a re-check share it", async () => {
  let t = 0;
  let release;
  let calls = 0;
  let first = true;
  const check = async () => {
    calls++;
    if (first) {
      first = false;
      throw behind();
    }
    await new Promise((r) => (release = r));
  };
  const gate = await openDatabaseGate(check, { log: quiet(), retryMs: 10, now: () => t });
  t = 100;
  const a = hit(gate);
  const b = hit(gate);
  const c = hit(gate);
  release();
  assert.deepEqual(await Promise.all([a, b, c]), ["next", "next", "next"]);
  assert.equal(calls, 2, "one re-check for the three");
});

test("a failure that is not the boot check's still reads as a sentence", () => {
  assert.equal(notReadyMessage(new Error("No DATABASE_URL is set")), "The server's database is not ready: No DATABASE_URL is set");
  assert.equal(
    notReadyMessage(behind()),
    "The server's database is behind: 1 migration(s) of 10 not applied. Run `npm run db:migrate`; the API comes back by itself once the database is current, with no restart.",
  );
});

test("the boot check's refusal carries the live fix (nothing listening: port 1, no server touched)", async () => {
  const { checkDatabase } = await import("../../web/server/db.ts");
  const e = await checkDatabase("postgres://127.0.0.1:1/lingo_dojo_nowhere").then(() => null, (err) => err);
  assert.ok(e instanceof DatabaseNotReady);
  assert.match(e.message, /cannot reach its database at postgres:\/\/127\.0\.0\.1:1\/lingo_dojo_nowhere: nothing is listening/);
  assert.match(e.message, /start the server again/, "a first start still says to start again");
  assert.match(notReadyMessage(e), /^The server's database cannot be reached: nothing is listening.*comes back by itself/);
});
