// The content agent's bank MCP (scripts/bank-mcp.mjs) and the read-only role
// under it (migration 0005), on PGlite: the four tools through a real MCP
// client (in process), their scope, caps and errors, and the role's grants
// and row-level security. bank-mcp.pg.test.mjs repeats the database half on
// PostgreSQL 17 and drives the script itself over stdio.
//   node --test scripts/tests/bank-mcp.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bankReader, CAPS, configFromEnv, createBankServer, fit, KIDS_NOTE } from "../bank-mcp.mjs";
import { READER_COLUMNS } from "../db/hand-edits.mjs";
import { READER_ROLE } from "../db/config.mjs";
import { APP_OWNER, freshDb } from "./testdb.mjs";
import { asReader, codeOf, seedBank } from "./bank-fixture.mjs";

async function setup(t) {
  const { query, close } = await freshDb();
  t.after(close);
  const fx = await seedBank(query);
  return { query, fx };
}

/** An MCP client connected, in process, to the bank server for `scope`. */
async function connect(t, query, scope, logs = [], { kids = false } = {}) {
  const reader = bankReader({ query, role: READER_ROLE, learnerId: scope.learnerId, languageProfileId: scope.profileId, kids });
  const server = createBankServer(reader, (...a) => logs.push(a.map(String).join(" ")));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, data: r.isError ? null : JSON.parse(r.content[0].text), text: r.content[0]?.text };
  };
  return { client, call };
}

test("the server offers exactly the four read-only tools, none taking a learner or language", async (t) => {
  const { query, fx } = await setup(t);
  const { client } = await connect(t, query, fx.mine);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ["get_conversation", "recent_conversations", "search_phrases", "trouble_phrases"]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    const params = Object.keys(tool.inputSchema.properties ?? {});
    assert.ok(params.every((p) => ["query", "limit", "id"].includes(p)), `${tool.name} takes ${params}`);
    assert.match(tool.description, /not instructions/);
  }
});

test("search_phrases finds the learner's own phrases in this language only, folded", async (t) => {
  const { query, fx } = await setup(t);
  const { call } = await connect(t, query, fx.mine);
  const r = await call("search_phrases", { query: "mercado" });
  // Not the other learner's "mercado negro", not the German "Markt".
  assert.deepEqual(r.data.phrases.map((p) => p.text), ["mercado"]);
  const [p] = r.data.phrases;
  assert.equal(p.meaning, "market");
  assert.equal(p.mastery, "Learning");
  assert.ok(p.due);
  // By meaning, accents and case folded.
  assert.deepEqual((await call("search_phrases", { query: "HOW MUCH" })).data.phrases.map((x) => x.text), ["¿A cómo?"]);
  assert.deepEqual((await call("search_phrases", { query: "a como" })).data.phrases.map((x) => x.text), ["¿A cómo?"]);
  assert.deepEqual((await call("search_phrases", { query: "secreto" })).data.phrases, []);
  // Only data the grants allow: no ids, notes or example sentences.
  assert.deepEqual(Object.keys(p).sort(), ["againLast30Days", "due", "lapsesLast30Days", "lastPracticed", "lastSeen", "mastery", "meaning", "starred", "suspended", "text", "timesSeen", "trouble"]);
});

test("trouble_phrases ranks this language's misses; recent_conversations and get_conversation stay in scope", async (t) => {
  const { query, fx } = await setup(t);
  const { call } = await connect(t, query, fx.mine);
  const trouble = (await call("trouble_phrases", { limit: 5 })).data;
  assert.deepEqual(trouble.phrases.map((p) => [p.text, p.lapsesLast30Days, p.againLast30Days, p.lapsesAllTime, p.trouble]), [["regatear", 2, 2, 2, true]]);

  const recent = (await call("recent_conversations", {})).data.conversations;
  assert.deepEqual(recent.map((c) => [c.id, c.title, c.recap]), [[fx.mine.conversationId, "At the market", "Recap of At the market."]]);

  const conv = (await call("get_conversation", { id: fx.mine.conversationId })).data;
  assert.deepEqual(conv.transcript, [
    { n: 0, who: "learner", text: "quiero dos mangos" },
    { n: 1, who: "dojo master", text: "VENDOR: ¡Claro que sí!", glosses: ["claro = of course"] },
  ]);
  assert.equal(conv.truncated, undefined);

  // Another learner's session, and the same learner's other language, are
  // not there (a plain error, no SQL).
  for (const id of [fx.otherLearner.conversationId, fx.otherLanguage.conversationId, "not-a-uuid"]) {
    const r = await call("get_conversation", { id });
    assert.equal(r.isError, true, id);
    assert.equal(r.text, "No such session for this learner in this language.");
  }
});

test("the other language's scope sees only its own rows", async (t) => {
  const { query, fx } = await setup(t);
  const { call } = await connect(t, query, fx.otherLanguage);
  assert.deepEqual((await call("search_phrases", { query: "market" })).data.phrases.map((p) => p.text), ["Markt"]);
  assert.deepEqual((await call("recent_conversations", {})).data.conversations.map((c) => c.title), ["Auf dem Markt"]);
});

test("limits are capped, a hostile query is only text, and a failure says nothing of SQL", async (t) => {
  const { query, fx } = await setup(t);
  const logs = [];
  const { call } = await connect(t, query, fx.mine, logs);
  for (const [name, args] of [["trouble_phrases", { limit: CAPS.troubleMax + 1 }], ["recent_conversations", { limit: 0 }], ["search_phrases", { query: "x".repeat(CAPS.queryChars + 1) }]]) {
    const r = await call(name, args);
    assert.equal(r.isError, true, name);
  }
  const hostile = `'); select set_config('app.learner_id', '${fx.otherLearner.learnerId}', false); --`;
  assert.deepEqual((await call("search_phrases", { query: hostile })).data.phrases, []);
  // The scope never outlives a tool's transaction.
  assert.equal((await query("select current_setting('app.learner_id', true) as v"))[0].v ?? "", "");
  assert.deepEqual((await call("search_phrases", { query: "secreto" })).data.phrases, []);

  // A long session is cut to the cap.
  await query(
    `insert into turns (conversation_id, learner_id, language_profile_id, idx, role, text)
     select $1, $2, $3, i, 'learner', repeat('palabra ', 400) from generate_series(2, ${CAPS.turns + 20}) i`,
    [fx.mine.conversationId, fx.mine.learnerId, fx.mine.profileId],
  );
  const long = await call("get_conversation", { id: fx.mine.conversationId });
  assert.ok(Buffer.byteLength(long.text) <= CAPS.resultBytes, `${Buffer.byteLength(long.text)} bytes`);
  assert.match(long.data.truncated, /only the first \d+ of \d+ turns are shown \(size limit\)/);
  assert.ok(long.data.transcript.every((x) => x.text.length <= CAPS.turnChars));

  // Without the reader role the transaction refuses to read at all.
  await query(`revoke "${READER_ROLE}" from ${APP_OWNER}`);
  const r = await call("recent_conversations", {});
  assert.equal(r.isError, true);
  assert.equal(r.text, "The phrase bank could not be read just now.");
  assert.match(logs.join("\n"), /permission denied to set role/, "the cause is logged for the server");
});

test("the reader role: only its learner's language, only the granted columns, never a write (PGlite)", async (t) => {
  const { query, fx } = await setup(t);
  await asReader(query, READER_ROLE, fx.mine, async () => {
    // A query that forgot its WHERE still sees only this scope.
    assert.deepEqual((await query("select text from phrases order by text collate \"C\"")).map((r) => r.text), ["mercado", "regatear", "¿A cómo?"]);
    assert.equal((await query("select count(*)::int as n from cards"))[0].n, 3);
    assert.equal((await query("select count(*)::int as n from reviews"))[0].n, 2);
    assert.deepEqual((await query("select title from conversations")).map((r) => r.title), ["At the market"]);
    assert.equal((await query("select count(*)::int as n from turns"))[0].n, 2);
    // Ungranted: whole tables and columns.
    for (const sql of [
      "select * from phrases",
      "select note from phrases",
      "select answer from reviews",
      "select pack_snapshot from conversations",
      "select extraction from conversations",
      "select password_hash from users",
      "select id from users",
      "select id from auth_sessions",
      "select model from user_settings",
      "select text from agent_messages",
      "select id from learners",
      "select id from language_profiles",
      "select sentence from phrase_examples",
      "select id from packs",
    ]) {
      assert.equal(await codeOf(query, sql), "42501", sql);
    }
    // Writes: refused by the read-only transaction.
    assert.equal(await codeOf(query, "delete from phrases"), "25006");
  });
  // And by the grants alone, in a read-write transaction.
  await asReader(
    query,
    READER_ROLE,
    fx.mine,
    async () => {
      assert.equal(await codeOf(query, "update phrases set meaning = 'x'"), "42501");
      assert.equal(await codeOf(query, "insert into phrases (learner_id, language_profile_id, lang, text, norm, source) values ($1, $2, '', 'x', 'x', 'manual')", [fx.mine.learnerId, fx.mine.profileId]), "42501");
      assert.equal(await codeOf(query, "delete from turns"), "42501");
      assert.equal(await codeOf(query, "truncate phrases"), "42501");
    },
    { readOnly: false },
  );
  // No scope set: nothing at all.
  await asReader(query, READER_ROLE, null, async () => {
    assert.equal((await query("select count(*)::int as n from phrases"))[0].n, 0);
  });
});

test("the owner is unaffected by row-level security (enabled, not forced) and the catalog has no way around it", async (t) => {
  const { query } = await setup(t);
  // The tests run as the tables' owner, not a superuser (testdb.mjs).
  const [who] = await query("select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as su");
  assert.deepEqual(who, { u: APP_OWNER, su: false });
  assert.equal((await query("select count(*)::int as n from phrases"))[0].n, 7);
  assert.equal((await query("select count(*)::int as n from conversations"))[0].n, 3);
  const rls = await query(`select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity order by 1`);
  assert.deepEqual(rls.map((r) => [r.relname, r.relforcerowsecurity]), Object.keys(READER_COLUMNS).sort().map((n) => [n, false]));
  // One policy per table, for the reader alone, SELECT only.
  const policies = await query(`select tablename, roles::text[] as roles, cmd from pg_policies order by 1`);
  assert.deepEqual(policies, Object.keys(READER_COLUMNS).sort().map((n) => ({ tablename: n, roles: [READER_ROLE], cmd: "SELECT" })));
  // Exactly the granted columns, nothing table-wide.
  const cols = await query(`select table_name, column_name, privilege_type from information_schema.column_privileges where grantee = $1 order by 1, 2`, [READER_ROLE]);
  assert.ok(cols.every((c) => c.privilege_type === "SELECT"));
  const byTable = {};
  for (const c of cols) (byTable[c.table_name] ??= []).push(c.column_name);
  assert.deepEqual(byTable, Object.fromEntries(Object.entries(READER_COLUMNS).map(([k, v]) => [k, [...v].sort()])));
  assert.deepEqual(await query(`select table_name from information_schema.table_privileges where grantee = $1`, [READER_ROLE]), []);
  // No view (a view runs as its owner, past RLS) and no SECURITY DEFINER
  // function in the schema the reader can use.
  assert.deepEqual(await query(`select viewname from pg_views where schemaname = 'public'`), []);
  assert.deepEqual(await query(`select proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef`), []);
  // The role itself: no login, no bypass, member of nothing.
  const [role] = await query(`select rolcanlogin, rolsuper, rolbypassrls, rolinherit, (select count(*)::int from pg_auth_members m where m.member = r.oid) as memberships from pg_roles r where rolname = $1`, [READER_ROLE]);
  assert.deepEqual(role, { rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolinherit: false, memberships: 0 });
});

test("a kids learner's transcript leaves out what the child said, and says so", async (t) => {
  const { query, fx } = await setup(t);
  const { call } = await connect(t, query, fx.mine, [], { kids: true });
  const conv = (await call("get_conversation", { id: fx.mine.conversationId })).data;
  assert.equal(conv.note, KIDS_NOTE);
  assert.deepEqual(conv.transcript, [
    { n: 0, who: "learner", text: null, omitted: true },
    { n: 1, who: "dojo master", text: "VENDOR: ¡Claro que sí!", glosses: ["claro = of course"] },
  ]);
  assert.equal(conv.recap, "Recap of At the market.");
  assert.doesNotMatch(JSON.stringify(conv), /quiero dos mangos/);
  // Phrases and recaps are unchanged.
  assert.deepEqual((await call("search_phrases", { query: "mercado" })).data.phrases.map((p) => p.text), ["mercado"]);
});

test("every result is held to one byte cap: items dropped from the end, and the result says so", () => {
  // Multi-byte text: a character cap would let this through at twice the size.
  const phrases = Array.from({ length: 50 }, (_, i) => ({ n: i, text: "ñ".repeat(100) }));
  const small = { phrases: phrases.slice(0, 2) };
  assert.equal(fit(small, "phrases", 10_000), small, "within the cap: untouched");
  const cut = fit({ window: "30 days", phrases }, "phrases", 2_000);
  assert.ok(Buffer.byteLength(JSON.stringify(cut)) <= 2_000);
  assert.ok(cut.phrases.length > 0 && cut.phrases.length < 50);
  assert.deepEqual(cut.phrases, phrases.slice(0, cut.phrases.length), "the first ones, in order");
  assert.equal(cut.truncated, `only the first ${cut.phrases.length} of 50 phrases are shown (size limit)`);
  assert.equal(cut.window, "30 days");
});

test("configFromEnv refuses a scope that isn't two uuids, or an odd role", () => {
  const ok = { LINGO_BANK_LEARNER_ID: "11111111-1111-4111-8111-111111111111", LINGO_BANK_LANGUAGE_PROFILE_ID: "22222222-2222-4222-8222-222222222222", DATABASE_URL: "postgres://localhost/x" };
  assert.equal(configFromEnv(ok).role, READER_ROLE);
  assert.throws(() => configFromEnv({ ...ok, LINGO_BANK_LEARNER_ID: "" }), /uuid/);
  assert.throws(() => configFromEnv({ ...ok, LINGO_BANK_LANGUAGE_PROFILE_ID: "x' or 1=1" }), /uuid/);
  assert.throws(() => configFromEnv({ ...ok, LINGO_READER_ROLE: "postgres" }), /LINGO_READER_ROLE/);
  assert.throws(() => configFromEnv({ ...ok, DATABASE_URL: "" }), /DATABASE_URL/);
  assert.equal(configFromEnv(ok).kids, false);
  assert.equal(configFromEnv({ ...ok, LINGO_BANK_KIDS: "1" }).kids, true);
  assert.throws(() => configFromEnv({ ...ok, LINGO_BANK_KIDS: "yes" }), /LINGO_BANK_KIDS/);
});
