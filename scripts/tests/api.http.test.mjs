// The API routes end to end: the real Vite plugin (web/server/api.ts, loaded
// through Node's TypeScript type stripping) mounted on a tiny connect-style
// stack behind a real node:http server, driven with fetch on an ephemeral
// port. LINGO_CONTENT_DIR points the routes at a temp copy of the fixture
// library and LINGO_EXPORTS_DIR at a temp exports/, so nothing here touches
// the real content/ or exports/. The routes run on an in-process PGlite
// (freshDb), logged in as an admin with an adult learner (Sam) and a kids
// learner (Pip); auth itself is auth.http.test.mjs, and the saved-pack and
// folder routes are packs.http.test.mjs.
//   node --test scripts/tests/api.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client, tab } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";
import { languageProfiles, learners, packFolders, packs } from "../db/schema.ts";

const root = copyFixture();
const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-exports-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_EXPORTS_DIR = exportsDir;
/** Every pack and folder row, any learner's: what a refused write must not have added. */
const packRows = async () => [...(await db.select().from(packs)), ...(await db.select().from(packFolders))];

const { apiPlugins, sameOrigin } = await import("../../web/server/api.ts");

const testDb = await freshDb();
const db = testDb.db;
let base, close, session;
before(async () => {
  ({ base, close } = await serveApi(apiPlugins, { db }));
  await addUser(db, "robin", undefined, { admin: true, learners: [ADULT, KID] });
  session = client(base);
  await session.login("robin");
  await session.pick("Sam");
});
after(async () => {
  await close();
  await testDb.close();
});

const call = (...args) => session.call(...args);

const pack = {
  title: "Plaza chat",
  created: "2026-10-20T10:00:00-06:00",
  scenario: "plaza",
  quick_scenario: "",
  units: ["intro-target", "warmup-vocab"],
  overrides: { level: "B2" },
  notes: "",
};

test("sameOrigin: no Origin passes, a matching host passes, anything else is refused", () => {
  assert.equal(sameOrigin(undefined, "localhost:38400"), true);
  assert.equal(sameOrigin("http://localhost:38400", "localhost:38400"), true);
  assert.equal(sameOrigin("https://evil.example", "localhost:38400"), false);
  assert.equal(sameOrigin("not a url", "localhost:38400"), false);
  assert.equal(sameOrigin("http://localhost:38400", undefined), false);
});

test("a cross-origin request is refused on every route", async () => {
  const profileBefore = fs.readFileSync(path.join(root, "profile.yaml"), "utf8");
  const rowsBefore = await packRows();
  for (const [m, u] of [
    ["GET", "/api/content"], ["POST", "/api/assemble"], ["PUT", "/api/packs/2026-10-20-x"], ["POST", "/api/export"], ["PUT", "/api/profile"],
    ["POST", "/api/packs/2026-10-19-market-gentle/move"], ["POST", "/api/packs/2026-10-19-market-gentle/rename"],
    ["DELETE", "/api/packs/2026-10-19-market-gentle"], ["POST", "/api/folders"], ["DELETE", "/api/folders/x"],
  ]) {
    const r = await call(m, u, m === "GET" ? undefined : { pack, id: "x", level: "C2", folder: "x", title: "T", name: "x" }, { Origin: "https://evil.example" });
    assert.equal(r.status, 403, `${m} ${u}`);
  }
  assert.ok(!fs.existsSync(path.join(root, "packs", "2026-10-20-x.yaml")));
  assert.deepEqual(fs.readdirSync(path.join(root, "packs")), ["2026-10-19-market-gentle.yaml"]);
  assert.equal(fs.readFileSync(path.join(root, "profile.yaml"), "utf8"), profileBefore);
  assert.deepEqual(await packRows(), rowsBefore, "no pack or folder row was written");
});

test("GET /api/content: the library without packs, problems included", async () => {
  const { status, body } = await call("GET", "/api/content");
  assert.equal(status, 200);
  assert.deepEqual(body.schema.slots.map((s) => s.id), ["intro", "warmup", "corrections", "debrief"]);
  assert.ok(body.units.some((u) => u.id === "intro-native"));
  assert.deepEqual(body.languages.map((l) => l.name), ["English", "Spanish", "Japanese", "Italian", "Korean"]);
  assert.equal(body.packs, undefined);
  assert.equal(body.problems.length, 2);
});

/** Sam's row, as stored. */
const samRow = async () => (await db.select().from(learners).where(eq(learners.name, "Sam")))[0];
/** A learner's one language (the fixtures give each learner one), as stored. */
const languageOf = async (learnerId) => (await db.select().from(languageProfiles).where(eq(languageProfiles.learnerId, learnerId)))[0];
/** Sam's language row: target language, variant and level live there. */
const samLanguage = async () => languageOf((await samRow()).id);
/** Both of Sam's rows: what a rejected write must leave alone. */
const samBoth = async () => ({ learner: await samRow(), language: await samLanguage() });

test("PUT /api/profile merges the picker keys into the active learner, keeps the rest, validates the body, and leaves profile.yaml alone", async () => {
  const file = path.join(root, "profile.yaml");
  const fileBefore = fs.readFileSync(file, "utf8");
  const rowBefore = await samLanguage();
  try {
    const r = await call("PUT", "/api/profile", { target_language: "Spanish", target_variant: "Castilian Spanish", level: "B1" });
    assert.equal(r.status, 200);
    assert.equal(r.body.profile.target_variant, "Castilian Spanish");
    assert.equal(r.body.profile.learner_name, "Sam", "keys the body doesn't name are kept");
    assert.equal(r.body.profile.goals, "Order food and chat with vendors.");
    const row = await samLanguage();
    assert.deepEqual([row.targetLanguage, row.targetVariant, row.level], ["Spanish", "Castilian Spanish", "B1"]);
    assert.equal(fs.readFileSync(file, "utf8"), fileBefore, "the file is a seed now, never written by the app");
    assert.equal((await call("GET", "/api/content")).body.profile.level, "B1", "the next content read sees it");

    // a blank value clears the key
    const cleared = await call("PUT", "/api/profile", { target_variant: "" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.profile.target_variant, undefined);
    assert.equal((await samLanguage()).targetVariant, "");

    // rejected bodies: unknown key, non-string, too long, blank name, not an object, empty, not JSON
    const after = await samBoth();
    for (const bad of [{ goals: "prose, not a picker key" }, { level: 42 }, { level: "x".repeat(81) }, { level: "B1", goals: "" }, { learner_name: " " }, [], {}, "{not json"]) {
      const r = await call("PUT", "/api/profile", bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(r.body.error, /./);
    }
    assert.deepEqual(await samBoth(), after, "a rejected body writes nothing");
    assert.equal((await call("GET", "/api/profile")).status, 405);
    assert.equal((await call("PUT", "/api/profile/extra", { level: "A1" })).status, 404);
    assert.equal((await call("PUT", "/api/profile?mode=kids", { level: "A1" })).status, 400, "Sam is adult");
    assert.deepEqual(await samBoth(), after);
  } finally {
    // the later tests assemble against the fixture values
    await db.update(languageProfiles).set({ targetLanguage: rowBefore.targetLanguage, targetVariant: rowBefore.targetVariant, level: rowBefore.level }).where(eq(languageProfiles.id, rowBefore.id));
  }
});

test("GET /api/content re-reads disk on every call", async () => {
  fs.writeFileSync(path.join(root, "scenarios", "beach.md"), "---\nid: beach\ntitle: Beach\nsummary: Sand.\n---\n");
  try {
    const { body } = await call("GET", "/api/content");
    assert.ok(body.scenarios.some((s) => s.id === "beach"));
  } finally {
    fs.rmSync(path.join(root, "scenarios", "beach.md"));
  }
});

test("POST /api/assemble returns markdown, warnings and stats", async () => {
  const r = await call("POST", "/api/assemble", { pack: { ...pack, units: ["warmup-vocab"] } });
  assert.equal(r.status, 200);
  assert.match(r.body.markdown, /^# Lingo Dojo session: Evening in the plaza\n/);
  assert.deepEqual(r.body.warnings, ['Required slot "Introduction" has no unit selected.']);
  assert.ok(r.body.stats.words > 0);
  assert.equal((await call("POST", "/api/assemble", {})).status, 400);
  assert.equal((await call("GET", "/api/assemble")).status, 405);
});

test("POST /api/assemble?mode=kids paces a kids pack with minutes by the kids plan", async () => {
  const kidsPack = { title: "k", created: "", scenario: "farm", quick_scenario: "", units: ["intro-game", "story-quest", "game-echo"], overrides: { minutes: 5 }, notes: "" };
  // Kids mode is the kids learner's.
  await session.pick("Pip");
  let r;
  try {
    r = await call("POST", "/api/assemble?mode=kids", { pack: kidsPack });
  } finally {
    await session.pick("Sam");
  }
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.warnings, []);
  const section = r.body.markdown.split("## Time budget\n\n")[1];
  assert.match(section, /^The learner has \*\*5 minutes\*\*/);
  // The kids plan: the story, the echo game (a games unit only kids mode
  // plans), the goodbye wording.
  assert.match(section, /- Story: /);
  assert.match(section, /Echo game/);
  assert.match(section, /the goodbye/);
});

test("POST /api/export writes exports/<id>.md and refuses a bad id", async () => {
  const r = await call("POST", "/api/export", { pack, id: "2026-10-20-plaza-chat" });
  assert.equal(r.status, 200);
  assert.equal(r.body.path, path.join(exportsDir, "2026-10-20-plaza-chat.md"));
  const assembled = await call("POST", "/api/assemble", { pack });
  assert.equal(fs.readFileSync(r.body.path, "utf8"), assembled.body.markdown);
  assert.deepEqual(r.body.stats, assembled.body.stats);
  for (const id of ["../escape", "", null, "A"]) {
    assert.equal((await call("POST", "/api/export", { pack, id })).status, 400, String(id));
  }
  assert.deepEqual(fs.readdirSync(exportsDir), ["2026-10-20-plaza-chat.md"]);
});

test("an unknown /api route is a JSON 404, not the SPA shell", async () => {
  const r = await call("GET", "/api/nope");
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: "no such route" });
});

/* ---------------------------------- modes --------------------------------- */
// The mode is the active learner's: Sam is adult, Pip kids.

test("GET /api/content?mode= browses either library; the profile is the active learner's, in its own mode only", async () => {
  const kids = await call("GET", "/api/content?mode=kids");
  assert.equal(kids.status, 200);
  assert.equal(kids.body.mode, "kids");
  assert.deepEqual(kids.body.levels, ["First words", "Getting going", "Chatty"]);
  assert.deepEqual(kids.body.schema.slots.map((s) => s.id), ["intro", "story", "games"]);
  assert.deepEqual(kids.body.profile, {}, "Sam is not a kids learner");
  assert.ok(kids.body.units.some((u) => u.id === "story-quest"));
  assert.ok(kids.body.languages.length > 0, "shares the root languages");
  const adult = await call("GET", "/api/content");
  assert.equal(adult.body.mode, "adult", "no ?mode: the learner's");
  assert.equal(adult.body.profile.learner_name, "Sam");
  assert.deepEqual(adult.body.levels, ["Pre-A1", "A1", "A2", "B1", "B2", "C1", "C2"]);
  // Pre-A1 (First steps) is opt-in: a new adult learner starts at A1.
  assert.equal(adult.body.defaultLevel, "A1");
  assert.equal(adult.body.frameDrill, "", "the fixture has no frame-drill.md");
  assert.ok(!adult.body.units.some((u) => u.id === "story-quest"));
  assert.ok(!adult.body.scenarios.some((s) => s.id === "farm"));
  const explicit = await call("GET", "/api/content?mode=adult");
  assert.deepEqual(explicit.body.units.map((u) => u.id), adult.body.units.map((u) => u.id));

  await session.pick("Pip");
  try {
    const mine = await call("GET", "/api/content");
    assert.equal(mine.body.mode, "kids", "Pip's mode when no ?mode");
    assert.equal(mine.body.profile.learner_name, "Pip");
    assert.equal(mine.body.profile.level, "First words");
  } finally {
    await session.pick("Sam");
  }
});

test("an unknown mode is a 400 on every tree-scoped route, and nothing is written", async () => {
  for (const [m, u, body] of [
    ["GET", "/api/content?mode=teen"], ["PUT", "/api/profile?mode=teen", { level: "A1" }], ["GET", "/api/packs?mode=teen"],
    ["PUT", "/api/packs/2026-10-20-x?mode=teen", pack], ["POST", "/api/folders?mode=teen", { name: "x" }],
    ["POST", "/api/assemble?mode=teen", { pack }], ["POST", "/api/export?mode=teen", { pack, id: "x" }],
  ]) {
    const r = await call(m, u, body);
    assert.equal(r.status, 400, `${m} ${u}`);
    assert.match(r.body.error, /unknown mode "teen"/);
  }
  assert.ok(!fs.existsSync(path.join(root, "packs", "2026-10-20-x.yaml")));
  assert.ok(!fs.existsSync(path.join(root, "packs", "x")));
});

test("a ?mode= that disagrees with the active learner is a 400 on pack, profile, assemble and export routes, and nothing is written", async () => {
  for (const [m, u, body] of [
    ["PUT", "/api/profile?mode=kids", { level: "Chatty" }], ["GET", "/api/packs?mode=kids"], ["GET", "/api/packs/2026-10-20-farm-first?mode=kids"],
    ["PUT", "/api/packs/2026-10-20-x?mode=kids", pack], ["DELETE", "/api/packs/2026-10-19-market-gentle?mode=kids"],
    ["POST", "/api/folders?mode=kids", { name: "x" }], ["POST", "/api/assemble?mode=kids", { pack }], ["POST", "/api/export?mode=kids", { pack, id: "x" }],
  ]) {
    const r = await call(m, u, body);
    assert.equal(r.status, 400, `${m} ${u}`);
    assert.match(r.body.error, /Sam practises in adult mode, not kids/);
  }
  assert.ok(!fs.existsSync(path.join(root, "kids", "packs", "2026-10-20-x.yaml")));
  assert.ok(!fs.existsSync(path.join(root, "kids", "packs", "x")));
  assert.ok(!fs.existsSync(path.join(exportsDir, "kids")));
  // The same routes with the learner's own mode named are fine.
  assert.equal((await call("GET", "/api/packs?mode=adult")).status, 200);
});

test("the assembled prompt's Learner block is the active learner's row, not profile.yaml", async () => {
  const before = await samRow();
  const language = await samLanguage();
  try {
    await db.update(learners).set({ name: "Samira" }).where(eq(learners.id, before.id));
    await db.update(languageProfiles).set({ level: "C1" }).where(eq(languageProfiles.id, language.id));
    const r = await call("POST", "/api/assemble", { pack });
    assert.equal(r.status, 200);
    assert.match(r.body.markdown, /Samira/);
    assert.doesNotMatch(r.body.markdown, /\bSam\b/);
    assert.match(fs.readFileSync(path.join(root, "profile.yaml"), "utf8"), /learner_name: Sam\n/, "the file is untouched");
  } finally {
    await db.update(learners).set({ name: before.name }).where(eq(learners.id, before.id));
    await db.update(languageProfiles).set({ level: language.level }).where(eq(languageProfiles.id, language.id));
  }
});

test("PUT /api/profile writes the active learner's row in its own mode: the kids learner, not the adult one", async () => {
  await session.pick("Pip");
  try {
    const r = await call("PUT", "/api/profile?mode=kids", { learner_name: "Mo", level: "Chatty" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.profile.learner_name, "Mo");
    assert.equal(r.body.profile.level, "Chatty");
    assert.equal((await call("GET", "/api/content")).body.profile.learner_name, "Mo");
    assert.doesNotMatch(fs.readFileSync(path.join(root, "kids", "profile.yaml"), "utf8"), /Mo\b/, "the kids file is untouched");
    assert.equal((await samRow()).name, "Sam", "the adult learner is untouched");
  } finally {
    await call("PUT", "/api/profile", { learner_name: "Pip", level: "First words" });
    await session.pick("Sam");
  }
});

test("without a picked learner, the learner-scoped routes answer 409 and GET /api/content still works", async () => {
  await call("PUT", "/api/auth/learner", { learnerId: null });
  try {
    for (const [m, u, body] of [
      ["PUT", "/api/profile", { level: "A1" }], ["GET", "/api/packs"], ["PUT", "/api/packs/2026-10-20-x", pack], ["POST", "/api/folders", { name: "x" }],
      ["POST", "/api/assemble", { pack }], ["POST", "/api/export", { pack, id: "x" }], ["POST", "/api/voice/turn", { pack, history: [], message: "" }],
    ]) {
      const r = await call(m, u, body);
      assert.equal(r.status, 409, `${m} ${u}`);
      assert.match(r.body.error, /choose who's practicing/);
      assert.equal(r.body.code, "stale_learner", "the client goes back to the picker on it");
    }
    const c = await call("GET", "/api/content");
    assert.equal(c.status, 200);
    assert.equal(c.body.mode, "adult");
    assert.deepEqual(c.body.profile, {});
  } finally {
    await session.pick("Sam");
  }
});

/* ------------------------------ stale pages ------------------------------- */
// The session cookie is shared by every tab of a browser, so the server
// can't tell a stale tab from the mode alone: each learner-scoped call
// carries the learner its page shows (X-Learner-Id) and must match.

test("a stale tab (another tab picked a learner of the same mode) gets 409 stale_learner on every learner-scoped route; nothing is written", async () => {
  const made = await call("POST", "/api/learners", { name: "Ana", mode: "adult", target_language: "French", level: "A1" });
  assert.equal(made.status, 200, made.text);
  const anaId = made.body.learner.id;
  const other = tab(base, session);
  await other.pick("Ana");
  const anaRow = async () => ({ learner: (await db.select().from(learners).where(eq(learners.id, anaId)))[0], language: await languageOf(anaId) });
  try {
    const anaBefore = await anaRow();
    const rowsBefore = await packRows();
    // Tab 1 still shows Sam: "Save as my defaults" must not land on Ana.
    for (const [m, u, body] of [
      ["PUT", "/api/profile", { learner_name: "Sam", level: "C2" }], ["GET", "/api/packs"], ["PUT", "/api/packs/2026-10-20-stale", pack],
      ["POST", "/api/folders", { name: "stale" }], ["POST", "/api/assemble", { pack }], ["POST", "/api/export", { pack, id: "stale" }],
    ]) {
      const r = await call(m, u, body);
      assert.equal(r.status, 409, `${m} ${u}`);
      assert.equal(r.body.code, "stale_learner", `${m} ${u}`);
    }
    assert.deepEqual(await anaRow(), anaBefore, "Ana's row is untouched");
    assert.ok(!fs.existsSync(path.join(root, "packs", "2026-10-20-stale.yaml")));
    assert.ok(!fs.existsSync(path.join(root, "packs", "stale")));
    assert.ok(!fs.existsSync(path.join(exportsDir, "stale.md")));
    assert.deepEqual(await packRows(), rowsBefore, "no pack or folder row");
    // A call that names no learner is refused the same way.
    const bare = await other.call("POST", "/api/assemble", { pack }, { "X-Learner-Id": "" });
    assert.equal(bare.body.code, "stale_learner");
    // The current tab works, and writes Ana.
    const ok = await other.call("PUT", "/api/profile", { level: "B1" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await anaRow()).language.level, "B1");
  } finally {
    await session.pick("Sam");
    await call("POST", `/api/learners/${anaId}/archive`, {});
  }
});

test("another account logged in on the same browser: the first account's open page gets 409 stale_learner, never writes the new one's learner", async () => {
  await addUser(db, "lee", undefined, { learners: [{ ...ADULT, name: "Lee" }] });
  const page = tab(base, session); // robin's page, still showing Sam
  const lee = tab(base, session); // same browser: lee logs in over robin's cookie
  await lee.login("lee");
  await lee.pick("Lee");
  try {
    const r = await page.call("PUT", "/api/profile", { learner_name: "Sam", level: "C2" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "stale_learner");
    const leeRow = (await db.select().from(learners).where(eq(learners.name, "Lee")))[0];
    assert.equal((await languageOf(leeRow.id)).level, "A2", "lee's learner is untouched");
  } finally {
    await session.login("robin");
    await session.pick("Sam");
  }
});

test("learner bodies take own keys only: constructor or __proto__ is a 400, not a 500", async () => {
  const me = (await call("GET", "/api/auth/me")).body;
  for (const bad of ['"constructor":"x"', '"__proto__":"x"', '"toString":"x"']) {
    const created = await call("POST", "/api/learners", `{"name":"X","mode":"adult",${bad}}`);
    assert.equal(created.status, 400, `POST ${bad}: ${created.text}`);
    assert.match(created.body.error, /unknown learner field/);
    const patched = await call("PATCH", `/api/learners/${me.learner.id}`, `{${bad}}`);
    assert.equal(patched.status, 400, `PATCH ${bad}: ${patched.text}`);
  }
});

test("a 500 says something generic; the error itself (a failed query, its parameters) goes to the log, not the client", async () => {
  const { wrap, INTERNAL_ERROR } = await import("../../web/server/api.ts");
  const handler = wrap(() => {
    throw new Error('Failed query: update "learners" set "x" = $1 params: secret-value');
  }, { auth: "public" });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const logged = [];
  const savedError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: INTERNAL_ERROR });
    assert.doesNotMatch(text, /secret-value|learners|query/);
    assert.ok(logged.some((l) => l.includes("secret-value")), "the server log has it");
  } finally {
    console.error = savedError;
    await new Promise((resolve) => server.close(resolve));
  }
});
