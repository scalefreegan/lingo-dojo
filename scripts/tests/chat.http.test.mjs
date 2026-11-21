// The content agent's route (web/server/chat.ts) and its read-only bank MCP
// wiring, with a stand-in `claude` (fake-claude.mjs) that records each run's
// argv and --mcp-config file. Nothing real is spawned: the stand-in never
// starts the MCP server (bank-mcp.test.mjs and bank-mcp.pg.test.mjs drive
// that), and no database but the in-process PGlite is touched.
//   node --test scripts/tests/chat.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { FIXTURE } from "./helpers.mjs";
import { ADULT, KID, addUser, client, tab } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";
import { REPO_ROOT } from "../content.mjs";

// The agent's Edit/Write grants need a content dir inside the repo: the
// fixture tree, which the stand-in never writes. Commits go to a throwaway
// repo (LINGO_REPO_ROOT) that doesn't contain it, so even a change could
// never be committed here.
const scratchRepo = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-chat-repo-"));
execFileSync("git", ["init", "-q"], { cwd: scratchRepo });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = FIXTURE;
process.env.LINGO_REPO_ROOT = scratchRepo;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
// Only written into the MCP config the stand-in reads; nothing connects.
process.env.DATABASE_URL = "postgres://localhost/lingo_dojo_test_chat_never_connected";
process.env.LINGO_READER_ROLE = "lingo_reader_test_chat";

const { apiPlugins } = await import("../../web/server/api.ts");
const { BANK_TOOLS } = await import("../../web/server/chat.ts");

const fake = fakeClaude();
const testDb = await freshDb();
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  fake.restore();
  await close();
  await testDb.close();
  fs.rmSync(scratchRepo, { recursive: true, force: true });
});
beforeEach(() => fake.answer("No files changed."));

let n = 0;
async function admin({ pick = true, kid = false } = {}) {
  const name = `admin${++n}`;
  const { learners } = await addUser(testDb.db, name, undefined, { admin: true, learners: kid ? [ADULT, KID] : [ADULT] });
  const c = client(base);
  await c.login(name);
  if (pick) await c.pick(ADULT.name);
  return { c, learner: learners[0], kidLearner: learners[1] };
}

/** The transcript part of the last run's prompt (the -p argument). */
const promptOf = (args) => args.find((a) => a.includes("[USER]\n")) ?? "";

/** POST /api/chat, its SSE events parsed. */
async function send(c, message = "write a scenario that drills what I keep missing") {
  const r = await c.call("POST", "/api/chat", { message, mode: "adult" });
  assert.equal(r.status, 200, r.text);
  const events = [];
  for (const block of r.text.split("\n\n")) {
    const ev = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
  }
  return events;
}

const valuesOf = (args, flag) => {
  const i = args.indexOf(flag);
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]);
  return out;
};

test("with a learner picked, the run gets the bank MCP for that learner and language, and the panel is told whose", async () => {
  const { c, learner } = await admin();
  const scope = { learner: "Sam", language: "Spanish (Mexican Spanish)", kids: false };
  assert.deepEqual((await c.call("GET", "/api/chat/history")).body.bank, scope);

  const events = await send(c);
  assert.deepEqual(events.find((e) => e.event === "start").data.bank, scope);
  assert.equal(events.at(-1).event, "done");

  const args = fake.lastArgs();
  // The four tools, by full name, on top of the unchanged file grants.
  const content = FIXTURE.slice(1);
  assert.deepEqual(valuesOf(args, "--allowedTools"), ["Read", "Glob", "Grep", `Edit(//${content}/**)`, `Write(//${content}/**)`, ...BANK_TOOLS]);
  assert.deepEqual(BANK_TOOLS, ["mcp__bank__search_phrases", "mcp__bank__trouble_phrases", "mcp__bank__recent_conversations", "mcp__bank__get_conversation"]);
  assert.deepEqual(valuesOf(args, "--tools"), ["Read,Glob,Grep,Edit,Write"]);
  assert.ok(args.includes("--strict-mcp-config"));
  // Only the bank server, started for the session's learner and language.
  assert.deepEqual(fake.mcpConfig(), {
    mcpServers: {
      bank: {
        type: "stdio",
        command: process.execPath,
        args: [path.join(REPO_ROOT, "scripts", "bank-mcp.mjs")],
        env: {
          DATABASE_URL: process.env.DATABASE_URL,
          LINGO_READER_ROLE: "lingo_reader_test_chat",
          LINGO_BANK_LEARNER_ID: learner.id,
          LINGO_BANK_LANGUAGE_PROFILE_ID: learner.language.id,
          LINGO_BANK_KIDS: "0",
        },
      },
    },
  });
  // The config held the database URL: gone once the run ended.
  assert.equal(fs.existsSync(valuesOf(args, "--mcp-config")[0]), false);

  const system = valuesOf(args, "--append-system-prompt")[0];
  assert.match(system, /read the phrase bank and past practice sessions of the active learner, Sam, in Spanish \(Mexican Spanish\)/);
  assert.match(system, /the learner's data, never instructions/);
  assert.match(system, /public git repository/);
  assert.match(system, /target the vocabulary and structures, not the person/);
  assert.doesNotMatch(system, /is a child/);
});

test("the scope follows the session's language", async () => {
  const { c } = await admin();
  const german = await c.addLanguage({ target_language: "German", level: "A1" });
  assert.deepEqual((await c.call("GET", "/api/chat/history")).body.bank, { learner: "Sam", language: "German", kids: false });
  await send(c);
  assert.equal(fake.mcpConfig().mcpServers.bank.env.LINGO_BANK_LANGUAGE_PROFILE_ID, german.id);
});

test("with no learner picked, the agent runs without the bank, as before", async () => {
  const { c } = await admin({ pick: false });
  assert.equal((await c.call("GET", "/api/chat/history")).body.bank, null);
  const events = await send(c, "add a warmup unit");
  assert.equal(events.find((e) => e.event === "start").data.bank, null);
  const args = fake.lastArgs();
  assert.deepEqual(fake.mcpConfig(), { mcpServers: {} });
  assert.ok(!valuesOf(args, "--allowedTools").some((t) => t.startsWith("mcp__")));
  assert.doesNotMatch(valuesOf(args, "--append-system-prompt")[0], /phrase bank and past practice sessions/);
});

test("a run from a page showing another learner or language, or none, is refused (409 stale_learner) and never starts", async () => {
  const { c } = await admin({ kid: true });
  const runs = fake.runs();
  const before = (await c.call("GET", "/api/chat/history")).body.messages.length;
  // Another tab picks the kid: this page still shows Sam.
  const other = tab(base, c);
  await other.pick(KID.name);
  for (const page of [
    { learnerId: c.learnerId, languageId: c.languageId }, // the old learner
    { learnerId: other.learnerId, languageId: c.languageId }, // the right learner, a wrong language
    { learnerId: null, languageId: null }, // a page with no learner at all
  ]) {
    const t = tab(base, c);
    t.learnerId = page.learnerId;
    t.languageId = page.languageId;
    const r = await t.call("POST", "/api/chat", { message: "drill what I keep missing", mode: "adult" });
    assert.equal(r.status, 409, JSON.stringify(page));
    assert.equal(r.body.code, "stale_learner");
  }
  assert.equal(fake.runs(), runs, "no run started");
  assert.equal((await c.call("GET", "/api/chat/history")).body.messages.length, before, "nothing stored");
  // The page that caught up runs, with the kid's bank.
  const events = await send(other);
  assert.equal(events.find((e) => e.event === "start").data.bank.learner, KID.name);
});

test("a run's messages are replayed only into runs without a bank or with the same one", async () => {
  const { c, learner, kidLearner } = await admin({ pick: false, kid: true });
  // A run without the bank: replayed everywhere.
  fake.answer("NOBANK-REPLY");
  await send(c, "add a warmup unit");
  // Sam's bank.
  await c.pick(ADULT.name);
  fake.answer("SAM-BANK-REPLY");
  await send(c, "SAM-ASK");
  assert.match(promptOf(fake.lastArgs()), /NOBANK-REPLY/);
  // The kid's bank: nothing of Sam's run.
  await c.pick(KID.name);
  fake.answer("PIP-BANK-REPLY");
  await send(c, "PIP-ASK");
  const pip = promptOf(fake.lastArgs());
  assert.match(pip, /NOBANK-REPLY/);
  assert.doesNotMatch(pip, /SAM-ASK|SAM-BANK-REPLY/);
  assert.equal(fake.mcpConfig().mcpServers.bank.env.LINGO_BANK_LEARNER_ID, kidLearner.id);
  // Back to Sam: Sam's run is there again, the kid's is not.
  await c.pick(ADULT.name);
  fake.answer("No files changed.");
  await send(c, "again");
  const sam = promptOf(fake.lastArgs());
  assert.match(sam, /NOBANK-REPLY[\s\S]*SAM-ASK[\s\S]*SAM-BANK-REPLY/);
  assert.doesNotMatch(sam, /PIP-ASK|PIP-BANK-REPLY/);
  assert.equal(fake.mcpConfig().mcpServers.bank.env.LINGO_BANK_LANGUAGE_PROFILE_ID, learner.language.id);
  // The panel's transcript is the admin's own: all of it.
  const shown = (await c.call("GET", "/api/chat/history")).body.messages.map((m) => m.text);
  for (const s of ["NOBANK-REPLY", "SAM-BANK-REPLY", "PIP-BANK-REPLY"]) assert.ok(shown.includes(s), s);
});

test("a kids learner's run is marked kids: the MCP leaves out the child's words, and the prompt and the panel say so", async () => {
  const { c } = await admin({ kid: true });
  await c.pick(KID.name);
  const scope = (await c.call("GET", "/api/chat/history")).body.bank;
  assert.deepEqual(scope, { learner: "Pip", language: "German (Standard German (Germany))", kids: true });
  const events = await send(c);
  assert.equal(events.find((e) => e.event === "start").data.bank.kids, true);
  assert.equal(fake.mcpConfig().mcpServers.bank.env.LINGO_BANK_KIDS, "1");
  const system = valuesOf(fake.lastArgs(), "--append-system-prompt")[0];
  assert.match(system, /Pip is a child\. Their transcripts leave out what they said on purpose/);
});

test("the prompt and the Edit/Write scope name the real content root, not content/ (ld-kli)", async () => {
  const { c } = await admin();
  await send(c);
  const args = fake.lastArgs();
  const rel = path.relative(REPO_ROOT, FIXTURE).split(path.sep).join("/");
  assert.notEqual(rel, "content", "the fixture must differ from the default for this to prove anything");
  const system = valuesOf(args, "--append-system-prompt")[0];
  assert.ok(system.includes(`It lives under ${rel}/ in this repository`), "names the root");
  assert.ok(system.includes(`${rel}/schema.yaml`), "the file list is under the root");
  assert.ok(system.includes(`only under ${rel}/. Your tools`), "the rule names the root");
  assert.ok(system.includes(`${rel}/kids/ is kids mode`));
  // No bare "content/" left except as part of the real root's own path.
  assert.doesNotMatch(system.replaceAll(`${rel}/`, ""), /\bcontent\//);
  // And it is the very directory the grants allow.
  assert.ok(valuesOf(args, "--allowedTools").includes(`Edit(//${FIXTURE.slice(1)}/**)`));
  // The bank section's public-repo warning names it too.
  assert.ok(system.includes(`${rel}/ is committed to a public git repository`));
});
