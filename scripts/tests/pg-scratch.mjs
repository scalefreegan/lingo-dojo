// A throwaway database on the server LINGO_TEST_PG_URL names, for the .pg
// tests (they need real Postgres concurrency, which PGlite can't give). Not
// a test itself. The name carries the process id and random bytes, so test
// files running at once never share a database.
//
// The drop waits for the database's last connection to go before it drops.
// A pool's end() resolves once its clients are told to close, not once
// their backends have gone; under the whole suite's load a backend can
// still be there when the drop runs, and DROP DATABASE … WITH (FORCE)
// terminates it. The closing client then gets "terminating connection due
// to administrator command" with no one listening, an uncaught error that
// node:test charges to whatever test that file is running. That was the
// flaky failure of the .pg files run together.
//
// Migration 0005 makes the content agent's read-only role, and roles belong
// to the whole server, not one database: a test must never create (or grant
// to) the real `lingo_reader` on a server that also hosts real data. So each
// throwaway database gets its own reader role, named after it
// (readerRoleFor), and dropped right after the database. The name reaches
// the migration as `lingo.reader_role` through the connection string
// createDatabase returns (`options=-c lingo.reader_role=…`, which any role
// may set for its own session: ALTER DATABASE … SET of a custom setting
// needs a superuser), so every client and pool made from it migrates with
// that name.

import crypto from "node:crypto";
import pg from "pg";

/** A fresh, unused name for a throwaway database. */
export const scratchName = (tag = "x") => `lingo_dojo_test_${tag}_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;

/** The reader role of throwaway database `name`: lingo_dojo_test_… →
 *  lingo_reader_test_… (both carry the process id and random bytes). */
export const readerRoleFor = (name) => {
  if (!/^lingo_dojo_test_[a-z0-9_]+$/.test(name)) throw new Error(`not a throwaway database name: ${name}`);
  return name.replace(/^lingo_dojo_test_/, "lingo_reader_test_");
};

/** Make database `name` on `url`'s server; returns its connection string,
 *  whose sessions migrate with its own reader role (readerRoleFor). */
export async function createDatabase(url, name) {
  const role = readerRoleFor(name);
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const target = new URL(url);
  target.pathname = `/${name}`;
  const options = target.searchParams.get("options");
  target.searchParams.set("options", `${options ? `${options} ` : ""}-c lingo.reader_role=${role}`);
  return target.toString();
}

/** Drop database `name` once nothing is connected to it (up to `waitMs`;
 *  then by force, as before). Call it after every pool and client on it
 *  has ended. */
export async function dropDatabase(url, name, waitMs = 10_000) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    const until = Date.now() + waitMs;
    for (;;) {
      const [{ n }] = (await admin.query("select count(*)::int as n from pg_stat_activity where datname = $1", [name])).rows;
      if (!n || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await admin.query(`drop database if exists ${name} with (force)`);
    // Its grants and policies went with the database; nothing else holds it.
    await admin.query(`drop role if exists ${readerRoleFor(name)}`);
  } finally {
    await admin.end();
  }
}

/** A throwaway database with one client on it: its connection string, a
 *  one-client `query` (applyMigrations needs one connection for its
 *  transaction) and `drop`, which ends that client and drops the database. */
export async function scratchDatabase(url, tag = "x") {
  const name = scratchName(tag);
  const target = await createDatabase(url, name);
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  let dropped = false;
  return {
    name,
    url: target,
    client,
    query: async (text, params) => (await client.query(text, params)).rows,
    async drop() {
      if (dropped) return;
      dropped = true;
      await client.end().catch(() => {});
      await dropDatabase(url, name);
    },
  };
}
