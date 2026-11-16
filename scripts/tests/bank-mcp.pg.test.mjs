// The content agent's read-only role (migration 0005) and bank MCP on a real
// Postgres (the app runs Homebrew's PostgreSQL 17; PGlite is 18). Runs only
// when LINGO_TEST_PG_URL names a server, skipped otherwise.
//
// Roles are cluster-wide and the server may host real data, so nothing here
// touches a role named lingo_reader: each throwaway database migrates with
// its own reader role (pg-scratch.mjs readerRoleFor), and the owners made
// for the privilege cases carry the process id. All are dropped after.
//   LINGO_TEST_PG_URL=postgres://localhost/postgres node --test scripts/tests/bank-mcp.pg.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bankReader, pgSessions } from "../bank-mcp.mjs";
import { applyMigrations, bankReaderProblem, migrationsOnDisk } from "../db/migrations.mjs";
import { REPO_ROOT } from "../content.mjs";
import { asReader, codeOf, seedBank } from "./bank-fixture.mjs";
import { createDatabase, dropDatabase, readerRoleFor, scratchDatabase, scratchName } from "./pg-scratch.mjs";

const url = process.env.LINGO_TEST_PG_URL;
const skip = !url && "set LINGO_TEST_PG_URL to run";

/** A migrated throwaway database with the fixture bank. */
async function seeded(t, tag = "bank") {
  const db = await scratchDatabase(url, tag);
  t.after(db.drop);
  await applyMigrations(db.query);
  const fx = await seedBank(db.query);
  return { ...db, fx, role: readerRoleFor(db.name) };
}

test("migration 0005 on PostgreSQL 17: the reader sees one learner's language, the granted columns, and writes nothing", { skip }, async (t) => {
  const { query, fx, role } = await seeded(t);
  console.log(`migration 0005 on PostgreSQL ${(await query("show server_version_num"))[0].server_version_num}, reader role ${role}`);
  // The owner (here the server's superuser, or whoever LINGO_TEST_PG_URL is)
  // still sees every row.
  assert.equal((await query("select count(*)::int as n from phrases"))[0].n, 7);
  // The migrating role holds the reader explicitly, SET without INHERIT,
  // even as a superuser (who could SET ROLE without it).
  const grants = await query(
    `select m.set_option, m.inherit_option from pg_auth_members m
      where m.roleid = (select oid from pg_roles where rolname = $1) and m.member = (select oid from pg_roles where rolname = current_user) and m.set_option`,
    [role],
  );
  assert.deepEqual(grants, [{ set_option: true, inherit_option: false }]);
  assert.equal(await bankReaderProblem(query, role), null);
  // Applying again changes nothing (the migration is recorded once).
  assert.deepEqual((await applyMigrations(query)).applied, []);

  await asReader(query, role, fx.mine, async () => {
    // Even a query with no WHERE: this learner, this language.
    assert.deepEqual((await query("select text from phrases order by text collate \"C\"")).map((r) => r.text), ["mercado", "regatear", "¿A cómo?"]);
    assert.deepEqual((await query("select title from conversations")).map((r) => r.title), ["At the market"]);
    assert.equal((await query("select count(*)::int as n from turns"))[0].n, 2);
    assert.equal((await query("select count(*)::int as n from cards"))[0].n, 3);
    assert.equal((await query("select count(*)::int as n from reviews"))[0].n, 2);
    // Another learner's rows by id, and the same learner's other language.
    assert.deepEqual(await query("select id from conversations where id = any($1::uuid[])", [[fx.otherLearner.conversationId, fx.otherLanguage.conversationId]]), []);
    assert.deepEqual(await query("select id from phrases where id = any($1::uuid[])", [[...fx.otherLearner.phraseIds, ...fx.otherLanguage.phraseIds]]), []);
    assert.deepEqual(await query("select idx from turns where conversation_id = $1", [fx.otherLearner.conversationId]), []);
    // Ungranted tables and columns.
    for (const sql of [
      "select * from phrases",
      "select note from phrases",
      "select answer from reviews",
      "select pack_snapshot from conversations",
      "select password_hash from users",
      "select id from auth_sessions",
      "select voice from user_settings",
      "select text from agent_messages",
      "select name from learners",
      "select goals from language_profiles",
      "select sentence from phrase_examples",
      "select id from packs",
      "select hash from drizzle.__drizzle_migrations",
    ]) {
      assert.equal(await codeOf(query, sql), "42501", sql);
    }
    // In the read-only transaction every write is refused.
    for (const sql of ["delete from phrases", "update conversations set title = 'x'", "truncate turns", "create temp table x (i int)"]) {
      assert.equal(await codeOf(query, sql), "25006", sql);
    }
  });

  // With the transaction read-write, the grants alone refuse every write.
  await asReader(
    query,
    role,
    fx.mine,
    async () => {
      for (const sql of [
        "update phrases set meaning = 'x'",
        "delete from turns",
        "truncate phrases",
        "truncate users",
        "update users set is_admin = true",
        "insert into reviews (card_id, learner_id, language_profile_id, mode, rating, card_before) select id, learner_id, language_profile_id, 'flashcard', 4, '{}' from cards limit 1",
        "create table public.x (i int)",
      ]) {
        assert.equal(await codeOf(query, sql), "42501", sql);
      }
    },
    { readOnly: false },
  );

  // No scope: nothing.
  await asReader(query, role, null, async () => {
    assert.equal((await query("select count(*)::int as n from phrases"))[0].n, 0);
    assert.equal((await query("select count(*)::int as n from conversations"))[0].n, 0);
  });
});

test("what the database does not stop, mid-transaction: a SET of app.learner_id or a RESET ROLE (the MCP never sends either)", { skip }, async (t) => {
  const { query, fx, role } = await seeded(t);
  await asReader(query, role, fx.mine, async () => {
    // The scope is a setting, and any SQL in the session may change it: the
    // policies then show that learner's rows. Writes and ungranted columns
    // stay refused whatever the scope.
    await query("select set_config('app.learner_id', $1, true), set_config('app.language_profile_id', $2, true)", [fx.otherLearner.learnerId, fx.otherLearner.profileId]);
    assert.deepEqual((await query("select text from phrases order by text collate \"C\"")).map((r) => r.text), ["mercado negro", "secreto"]);
    assert.equal(await codeOf(query, "update phrases set meaning = 'x'"), "25006");
    assert.equal(await codeOf(query, "select answer from reviews"), "42501");
    // A mismatched pair (one learner, another's language) matches nothing.
    await query("select set_config('app.language_profile_id', $1, true)", [fx.mine.profileId]);
    assert.equal((await query("select count(*)::int as n from phrases"))[0].n, 0);
    // RESET ROLE returns to the connection's own role (the app's): what
    // stops it is that bank-mcp.mjs runs only its own fixed, parameterised
    // SQL. Still read-only.
    await query("reset role");
    assert.notEqual((await query("select current_user as u"))[0].u, role);
    assert.equal(await codeOf(query, "delete from phrases"), "25006");
  });
});

const BANK_MCP = path.join(REPO_ROOT, "scripts", "bank-mcp.mjs");
const mcpEnv = (dbUrl, role, scope, extra = {}) => ({
  PATH: process.env.PATH ?? "",
  // libpq's default user name, as the CLI passes it on.
  ...(process.env.USER ? { USER: process.env.USER } : {}),
  DATABASE_URL: dbUrl,
  LINGO_READER_ROLE: role,
  LINGO_BANK_LEARNER_ID: scope.learnerId,
  LINGO_BANK_LANGUAGE_PROFILE_ID: scope.profileId,
  ...extra,
});
/** The bank MCP's connections to this database. */
const mcpConnections = async (query) =>
  (await query("select count(*)::int as n from pg_stat_activity where application_name = 'lingo-dojo-bank-mcp' and datname = current_database()"))[0].n;

test("scripts/bank-mcp.mjs over stdio: four tools, scoped by its environment, never by a tool argument", { skip }, async (t) => {
  const { url: dbUrl, query, fx, role } = await seeded(t, "bankmcp");
  // The scratch URL carries its own `options=` (pg-scratch.mjs): the
  // read-only default must hold anyway.
  assert.match(dbUrl, /options=/);
  const transport = new StdioClientTransport({ command: process.execPath, args: [BANK_MCP], env: mcpEnv(dbUrl, role, fx.mine), stderr: "pipe" });
  const client = new Client({ name: "bank-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  // Closed in the test, not in t.after: the database's drop (registered
  // first) would otherwise wait for the child's connection.
  try {
    await stdioChecks(client, query, fx);
  } finally {
    await client.close();
  }
});

async function stdioChecks(client, query, fx) {
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
  };
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ["get_conversation", "recent_conversations", "search_phrases", "trouble_phrases"]);
  assert.deepEqual((await call("search_phrases", { query: "mercado" })).phrases.map((p) => p.text), ["mercado"]);
  assert.deepEqual((await call("trouble_phrases", {})).phrases.map((p) => p.text), ["regatear"]);
  assert.deepEqual((await call("recent_conversations", { limit: 5 })).conversations.map((c) => c.title), ["At the market"]);
  assert.equal((await call("get_conversation", { id: fx.mine.conversationId })).transcript.length, 2);
  assert.deepEqual(await call("get_conversation", { id: fx.otherLearner.conversationId }), { error: "No such session for this learner in this language." });
  // Its connection is named (and was checked read-only by default when it
  // opened: pgSessions, tested below).
  assert.equal(await mcpConnections(query), 1, "the MCP's connection is visible");
}

/** Newline-delimited JSON-RPC to a spawned bank MCP: send, and wait for the
 *  reply to an id. */
function rpc(child) {
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  return {
    notify: (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
    call(method, params = {}) {
      const n = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
      return new Promise((resolve) => waiting.set(n, resolve));
    },
  };
}

test("scripts/bank-mcp.mjs ends when its stdin does, and its connection goes with it", { skip }, async (t) => {
  const { url: dbUrl, query, fx, role } = await seeded(t, "bankend");
  const child = spawn(process.execPath, [BANK_MCP], { env: mcpEnv(dbUrl, role, fx.mine), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = once(child, "exit");
  t.after(() => child.kill("SIGKILL"));
  const r = rpc(child);
  await r.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  r.notify("notifications/initialized");
  const reply = await r.call("tools/call", { name: "recent_conversations", arguments: {} });
  assert.equal(reply.result.isError, undefined, JSON.stringify(reply) + stderr);
  assert.equal(await mcpConnections(query), 1);
  // The CLI's run is over: its end of the pipe closes, nothing else.
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const [code, signal] = await exited;
  clearTimeout(timer);
  assert.deepEqual([code, signal], [0, null], `exited by itself, cleanly: ${stderr}`);
  // The backend goes once the client's Terminate has been read.
  const until = Date.now() + 3_000;
  while ((await mcpConnections(query)) && Date.now() < until) await new Promise((res) => setTimeout(res, 25));
  assert.equal(await mcpConnections(query), 0, "no connection left behind");
});

test("pgSessions: read-only by default despite the URL's own options; a connection lost mid-call fails that call, and only the next call reconnects", { skip }, async (t) => {
  const { url: dbUrl, query, fx, role } = await seeded(t, "bankconn");
  const sessions = pgSessions(dbUrl);
  // Closed in the test, before the database's drop (registered first).
  try {
    await connectionChecks(sessions, dbUrl, query, fx, role);
  } finally {
    await sessions.close();
  }
});

async function connectionChecks(sessions, dbUrl, query, fx, role) {
  const q0 = await sessions.session();
  assert.equal((await q0("show default_transaction_read_only"))[0].default_transaction_read_only, "on");
  // The URL's options= still applied (it named the reader role).
  assert.equal((await q0("select current_setting('lingo.reader_role', true) as r"))[0].r, role);
  const [{ pid: first }] = await q0("select pg_backend_pid() as pid");

  // A session whose connection is killed by the server just before the
  // call's SET ROLE: that call fails, it does not carry on elsewhere.
  let kill = false;
  const statements = [];
  const session = async () => {
    const q = await sessions.session();
    return async (text, params) => {
      statements.push(text);
      if (kill && text.startsWith("set local role")) {
        kill = false;
        const [{ pid }] = await q("select pg_backend_pid() as pid");
        await query("select pg_terminate_backend($1)", [pid]);
      }
      return q(text, params);
    };
  };
  const reader = bankReader({ session, role, learnerId: fx.mine.learnerId, languageProfileId: fx.mine.profileId });
  assert.equal((await reader.recentConversations(5)).conversations.length, 1);
  kill = true;
  statements.length = 0;
  await assert.rejects(reader.recentConversations(5));
  assert.ok(!statements.some((s) => s.startsWith("select id, title")), "the call stopped at the lost connection");
  // Between calls a new connection is opened (the old one's end is noticed
  // first; give it a moment), and the next call reads as before.
  const until = Date.now() + 3_000;
  let ok = null;
  while (!ok && Date.now() < until) {
    ok = await reader.recentConversations(5).catch(() => null);
    if (!ok) await new Promise((res) => setTimeout(res, 50));
  }
  assert.equal(ok?.conversations.length, 1);
  const [{ pid: second }] = await (await sessions.session())("select pg_backend_pid() as pid");
  assert.notEqual(second, first);
}

test("0005 applies on a 0004 database with data: the owner's rows untouched, the reader scoped", { skip }, async (t) => {
  const db = await scratchDatabase(url, "m0005");
  t.after(db.drop);
  const all = migrationsOnDisk();
  const at = all.findIndex((m) => m.sql.some((s) => s.includes("0005_bank_reader")));
  assert.equal(at, all.length - 1, "0005 is the latest migration");
  await applyMigrations(db.query, all.slice(0, at));
  const fx = await seedBank(db.query);
  const before = await db.query("select id, text, meaning from phrases order by id");
  await applyMigrations(db.query, all);
  assert.deepEqual(await db.query("select id, text, meaning from phrases order by id"), before);
  await asReader(db.query, readerRoleFor(db.name), fx.otherLanguage, async () => {
    assert.deepEqual((await db.query("select text from phrases order by text collate \"C\"")).map((r) => r.text), ["Markt", "Wie viel?"]);
  });
});

/* ------------------------- who may apply the migration ------------------------ */

/** A role made for one case, dropped (with everything it owns gone first)
 *  at the end. Needs a superuser behind LINGO_TEST_PG_URL. */
async function admin(t) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const roles = [];
  const dbs = [];
  t.after(async () => {
    for (const name of dbs) await dropDatabase(url, name);
    for (const r of roles.reverse()) await c.query(`drop role if exists ${r}`);
    await c.end();
  });
  const tag = `${process.pid}_${crypto.randomBytes(3).toString("hex")}`;
  return {
    q: (text) => c.query(text),
    /** A plain role for one case. */
    async role(attrs = "nologin") {
      const role = `lingo_owner_test_${tag}_${roles.length}`;
      await c.query(`create role ${role} ${attrs}`);
      roles.push(role);
      return role;
    },
    /** Run `text` as the superuser inside database `name`. */
    async inDb(name, text) {
      const u = new URL(url);
      u.pathname = `/${name}`;
      const d = new pg.Client({ connectionString: u.toString() });
      await d.connect();
      try {
        return (await d.query(text)).rows;
      } finally {
        await d.end();
      }
    },
    /** A login role and a throwaway database it owns; the URL to it as that role. */
    async owner(attrs) {
      const role = `lingo_owner_test_${tag}_${roles.length}`;
      await c.query(`create role ${role} login ${attrs}`);
      roles.push(role);
      const name = scratchName("owner");
      const u = new URL(await createDatabase(url, name));
      dbs.push(name);
      await c.query(`alter database ${name} owner to ${role}`);
      // PostgreSQL 15+: public belongs to the database owner role pg_database_owner.
      u.username = role;
      return { role, name, reader: readerRoleFor(name), url: u.toString() };
    },
  };
}

async function migrateAs(ownerUrl) {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    const query = async (text, params) => (await c.query(text, params)).rows;
    await applyMigrations(query);
    return query;
  } finally {
    await c.end();
  }
}

async function isSuperuser() {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query("select rolsuper as ok from pg_roles where rolname = current_user")).rows[0].ok;
  } finally {
    await c.end();
  }
}

test("a non-superuser owner with CREATEROLE migrates, and its own queries still see every row", { skip }, async (t) => {
  if (!(await isSuperuser())) return t.skip("needs a superuser behind LINGO_TEST_PG_URL (it makes owners and hands them databases)");
  const a = await admin(t);
  const o = await a.owner("nosuperuser createrole");
  await migrateAs(o.url);
  const c = new pg.Client({ connectionString: o.url });
  await c.connect();
  try {
    await ownerChecks(c, o);
  } finally {
    await c.end();
  }
});

async function ownerChecks(c, o) {
  const query = async (text, params) => (await c.query(text, params)).rows;
  const fx = await seedBank(query);
  // The owner: every row of every learner (RLS enabled, not forced).
  assert.equal((await query("select count(*)::int as n from phrases"))[0].n, 7);
  assert.equal((await query("select count(*)::int as n from turns"))[0].n, 6);
  // The reader it made: scoped.
  await asReader(query, o.reader, fx.mine, async () => {
    assert.equal((await query("select count(*)::int as n from phrases"))[0].n, 3);
  });
  const [m] = await query("select set_option, inherit_option from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member where r.rolname = $1 and m.rolname = $2 and set_option", [o.reader, o.role]);
  assert.deepEqual(m, { set_option: true, inherit_option: false });
}

test("an owner without CREATEROLE is stopped with what to run, nothing changed; after a superuser runs it, 0005 applies", { skip }, async (t) => {
  if (!(await isSuperuser())) return t.skip("needs a superuser behind LINGO_TEST_PG_URL (it makes owners and hands them databases)");
  const a = await admin(t);
  const o = await a.owner("nosuperuser nocreaterole");
  await assert.rejects(migrateAs(o.url), (e) => {
    assert.match(e.message, new RegExp(`the read-only role ${o.reader} does not exist and ${o.role} may not create it`));
    assert.match(e.hint, new RegExp(`CREATE ROLE ${o.reader} NOLOGIN; GRANT ${o.reader} TO ${o.role} WITH INHERIT FALSE, SET TRUE`));
    return true;
  });
  // One transaction: not even the earlier migrations stayed.
  const c = new pg.Client({ connectionString: o.url });
  await c.connect();
  try {
    assert.equal((await c.query("select to_regclass('public.phrases')::text as t")).rows[0].t, null);
  } finally {
    await c.end();
  }
  // The hint, run by the administrator, is enough.
  await a.q(`create role ${o.reader} nologin`);
  await a.q(`grant ${o.reader} to ${o.role} with inherit false, set true`);
  await migrateAs(o.url);
});

test("an existing reader role with more than read access is refused", { skip }, async (t) => {
  if (!(await isSuperuser())) return t.skip("needs a superuser behind LINGO_TEST_PG_URL (it makes owners and hands them databases)");
  const a = await admin(t);
  const o = await a.owner("nosuperuser createrole");
  await a.q(`create role ${o.reader} nologin bypassrls`);
  await a.q(`grant ${o.reader} to ${o.role} with inherit false, set true`);
  await assert.rejects(migrateAs(o.url), /exists with more than read access/);
  await a.q(`alter role ${o.reader} nobypassrls`);
  await migrateAs(o.url);
});

test("an existing reader role held by another role, or named in this database's default privileges, is refused, naming them", { skip }, async (t) => {
  if (!(await isSuperuser())) return t.skip("needs a superuser behind LINGO_TEST_PG_URL (it makes owners and hands them databases)");
  const a = await admin(t);
  const o = await a.owner("nosuperuser createrole");
  await a.q(`create role ${o.reader} nologin`);
  await a.q(`grant ${o.reader} to ${o.role} with inherit false, set true`);
  const other = await a.role();
  await a.q(`grant ${o.reader} to ${other}`);
  await assert.rejects(migrateAs(o.url), (e) => {
    assert.match(e.message, new RegExp(`the role ${o.reader} has other members: ${other}$`));
    assert.match(e.hint, new RegExp(`REVOKE ${o.reader} FROM`));
    return true;
  });
  await a.q(`revoke ${o.reader} from ${other}`);
  // Another role's default privileges naming the reader: refused.
  await a.inDb(o.name, `alter default privileges for role ${other} in schema public grant select on tables to ${o.reader}`);
  await assert.rejects(migrateAs(o.url), new RegExp(`default privileges in this database name the role ${o.reader}: r \\(for objects of ${other} in schema public\\)`));
  await a.inDb(o.name, `alter default privileges for role ${other} in schema public revoke select on tables from ${o.reader}`);
  // The migrating role's own: cleared, and the migration goes on.
  await a.inDb(o.name, `alter default privileges for role ${o.role} grant select on tables to ${o.reader}`);
  await a.inDb(o.name, `alter default privileges for role ${o.role} in schema public grant usage on sequences to ${o.reader}`);
  const query = await migrateAs(o.url).then(() => null);
  assert.equal(query, null);
  const left = await a.inDb(o.name, `select count(*)::int as n from pg_default_acl a where exists (select 1 from aclexplode(a.defaclacl) x where x.grantee = '${o.reader}'::regrole)`);
  assert.deepEqual(left, [{ n: 0 }]);
});

test("db:setup prints Postgres's DETAIL and HINT when a migration stops", { skip }, async (t) => {
  if (!(await isSuperuser())) return t.skip("needs a superuser behind LINGO_TEST_PG_URL (it makes owners and hands them databases)");
  const a = await admin(t);
  const o = await a.owner("nosuperuser nocreaterole");
  const out = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "db", "setup.mjs"), "--migrate-only"],
      {
        env: { PATH: process.env.PATH ?? "", DATABASE_URL: o.url, LINGO_READER_ROLE: o.reader, LINGO_ENV_FILE: path.join(REPO_ROOT, "no-such.env") },
      },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stderr, new RegExp(`db migrate failed: 0005_bank_reader: the read-only role ${o.reader} does not exist and ${o.role} may not create it`));
  assert.match(out.stderr, new RegExp(`\\nhint: As a superuser, run: CREATE ROLE ${o.reader} NOLOGIN; GRANT ${o.reader} TO ${o.role} WITH INHERIT FALSE, SET TRUE; then npm run db:setup again\\.`));
});
