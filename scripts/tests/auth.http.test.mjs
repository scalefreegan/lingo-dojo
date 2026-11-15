// Logins and learners over HTTP (web/server/auth.ts, wrap() in api.ts): the
// real plugin on an in-process PGlite. First run, login/logout, expiry and
// sliding, the throttle, the Secure flag, every access level, learner CRUD
// and picking, and that one account never sees or changes another's
// learners, settings or agent chat. Every name is made up.
//   node --test scripts/tests/auth.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, PASSWORD, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";
import { tokenHash } from "../auth.mjs";
import { drizzle } from "drizzle-orm/pglite";
import {
  archiveLanguageProfile, createLanguageProfile, createLearner, createSession, createUser, disableUser, enableUser, setPassword, setSessionLearner,
  updateLanguageProfile,
} from "../db/accounts.ts";
import * as schema from "../db/schema.ts";
import { agentMessages, authSessions, languageProfiles, learners, userSettings, users } from "../db/schema.ts";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");

const { apiPlugins } = await import("../../web/server/api.ts");
const { setDb } = await import("../../web/server/db.ts");
const { resetLoginThrottle } = await import("../../web/server/auth.ts");

let base, close;
const dbs = [];
/** A fresh, empty database for the routes from here on. */
async function freshRoutes() {
  const t = await freshDb();
  dbs.push(t);
  setDb(t.db);
  resetLoginThrottle();
  return t;
}
before(async () => ({ base, close } = await serveApi(apiPlugins, { db: (await freshRoutes()).db })));
after(async () => {
  await close();
  for (const t of dbs) await t.close();
});

const anon = () => client(base);

/** A logged-in client for a user made straight in the database. */
async function as(db, name, opts = {}) {
  const made = await addUser(db, name, PASSWORD, opts);
  const c = anon();
  await c.login(name);
  return { ...made, c };
}

/* --------------------------------- first run ------------------------------ */

test("first run: /me says so; the first account is an admin seeded from the profile and data/ files; logged in, no learner picked", async () => {
  const { db } = await freshRoutes();
  fs.writeFileSync(path.join(dataDir, "voice.json"), JSON.stringify({ turn: "pause", tts: "system", voices: { system: { "es-MX": { narrator: "Paulina" } } } }));
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ model: "claude-opus-5-5" }));
  fs.writeFileSync(
    path.join(dataDir, "chat.jsonl"),
    [
      JSON.stringify({ role: "user", text: "add a unit", ts: "2026-11-01T10:00:00.000Z" }),
      JSON.stringify({ role: "assistant", text: "Added unit x.", ts: "2026-11-01T10:00:05.000Z" }),
      "{torn line",
      JSON.stringify({ role: "commit", text: "abc1234: Added unit x.", ts: "2026-11-01T10:00:06.000Z" }),
    ].join("\n"),
  );
  try {
    const me = await anon().call("GET", "/api/auth/me");
    assert.deepEqual(me.body, { firstRun: true, firstRunHere: true, user: null, learners: [], learner: null, language: null });

    const c = anon();
    const r = await c.call("POST", "/api/auth/first-run", { username: " Robin ", password: PASSWORD });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.firstRun, false);
    assert.equal(r.body.user.username, "robin", "normalized");
    assert.equal(r.body.user.isAdmin, true);
    assert.equal(r.body.learner, null, "the picker comes next");
    assert.equal(r.body.language, null);
    // Each seeded learner has one language: the profile's.
    assert.deepEqual(r.body.learners.map((l) => [l.name, l.mode, l.languages.map((g) => [g.target_language, g.level])]), [
      ["Sam", "adult", [["Spanish", "A2"]]],
      ["Pip", "kids", [["German", "First words"]]],
    ]);
    assert.equal(r.body.learners[0].languages[0].goals, "Order food and chat with vendors.");
    assert.equal(r.body.learners[0].languages[0].target_variant, "Mexican Spanish");
    assert.match(c.jar.cookie, /^ld_session=/);

    const [settings] = await db.select().from(userSettings);
    assert.equal(settings.model, "claude-opus-5-5");
    assert.equal(settings.voice.turn, "pause");
    assert.deepEqual(settings.voice.voices, { system: { "es-MX": { "narrator:female": "Paulina", "narrator:male": "Paulina" } } }, "normalized on the way in");
    const history = await c.call("GET", "/api/chat/history");
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.messages.map((m) => [m.role, m.text, m.ts]), [
      ["user", "add a unit", "2026-11-01T10:00:00.000Z"],
      ["assistant", "Added unit x.", "2026-11-01T10:00:05.000Z"],
      ["commit", "abc1234: Added unit x.", "2026-11-01T10:00:06.000Z"],
    ]);
    assert.equal((await c.call("GET", "/api/settings")).body.model, "claude-opus-5-5");
    assert.equal((await c.call("GET", "/api/voice/settings")).body.settings.turn, "pause");
    // The seed packs went to the learner of their mode, and only to it.
    await c.pick("Sam");
    assert.deepEqual((await c.call("GET", "/api/packs")).body.packs.map((p) => [p.id, p.title]), [["2026-10-19-market-gentle", "Market, gentle corrections"]]);
    await c.pick("Pip");
    assert.deepEqual((await c.call("GET", "/api/packs")).body.packs.map((p) => [p.id, p.title]), [["2026-10-20-farm-first", "Farm, first visit"]]);
    await c.call("PUT", "/api/auth/learner", { learnerId: null });

    // Only once: a second first run is a 409 and adds nobody.
    const again = await anon().call("POST", "/api/auth/first-run", { username: "mallory", password: PASSWORD });
    assert.equal(again.status, 409);
    assert.equal((await db.select().from(users)).length, 1);
    assert.equal((await anon().call("GET", "/api/auth/me")).body.firstRun, false);

    // The files are seeds: the running app doesn't write them.
    await c.call("PUT", "/api/voice/settings", { turn: "tap" });
    await c.call("PUT", "/api/settings", { model: "claude-sonnet-5-5" });
    await c.call("DELETE", "/api/chat/history");
    assert.match(fs.readFileSync(path.join(dataDir, "voice.json"), "utf8"), /"pause"/);
    assert.match(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"), /opus/);
    assert.equal(fs.readFileSync(path.join(dataDir, "chat.jsonl"), "utf8").split("\n").length, 4);
  } finally {
    for (const f of ["voice.json", "settings.json", "chat.jsonl"]) fs.rmSync(path.join(dataDir, f), { force: true });
  }
});

/** A raw request, so the test can set Host (fetch won't). */
function raw(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, method, path: urlPath, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// The test client reaches the server from 127.0.0.1 with Host 127.0.0.1:port,
// so the first-run tests above are direct local requests. `tailscale serve`
// also connects from loopback; what gives it away is the tailnet Host and the
// X-Forwarded-* headers, so a fresh install served on a tailnet can't have its
// admin account claimed from another device.
test("first run: a request that came through the proxy is refused with a 403 and /me says to do it on the Mac", async () => {
  const { db } = await freshRoutes();
  const body = { username: "mallory", password: PASSWORD };
  const viaProxy = { Host: "dojo.example-tailnet.ts.net", Origin: "https://dojo.example-tailnet.ts.net", "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.7", "X-Forwarded-Host": "dojo.example-tailnet.ts.net" };
  const refused = await raw("POST", "/api/auth/first-run", viaProxy, body);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /on the Mac/);
  // Each tell alone is enough, with a localhost Host.
  for (const h of ["X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"]) {
    assert.equal((await raw("POST", "/api/auth/first-run", { Host: "localhost:38400", [h]: "x" }, body)).status, 403, h);
  }
  assert.equal((await raw("POST", "/api/auth/first-run", { Host: "dojo.example-tailnet.ts.net" }, body)).status, 403);
  assert.equal((await db.select().from(users)).length, 0);

  const me = await raw("GET", "/api/auth/me", viaProxy);
  assert.deepEqual(me.body, { firstRun: true, firstRunHere: false, user: null, learners: [], learner: null, language: null });

  // The same body from a direct local request still works.
  const ok = await raw("POST", "/api/auth/first-run", { Host: "localhost:38400" }, body);
  assert.equal(ok.status, 200);
  assert.equal((await db.select().from(users)).length, 1);
});

// On PGlite this can't fail: PGlite runs one transaction at a time, so the
// two first runs never overlap, and the test passes with createFirstAdmin's
// LOCK TABLE deleted. It stays as a check of the route's replies; the race
// itself is first-run.pg.test.mjs, on a real Postgres (LINGO_TEST_PG_URL).
test("first run: two at once make exactly one admin", async () => {
  const { db } = await freshRoutes();
  const [a, b] = await Promise.all([
    anon().call("POST", "/api/auth/first-run", { username: "robin", password: PASSWORD }),
    anon().call("POST", "/api/auth/first-run", { username: "lee", password: PASSWORD }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const rows = await db.select().from(users);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isAdmin, true);
  assert.equal((await db.select().from(learners)).length, 2, "one seed, not two");
});

test("first run: missing files seed nothing, quietly; bad input is a 400", async () => {
  const { db } = await freshRoutes();
  const kidsProfile = path.join(root, "kids", "profile.yaml");
  const saved = fs.readFileSync(kidsProfile, "utf8");
  fs.rmSync(kidsProfile);
  try {
    for (const bad of [{ username: "robin", password: "short" }, { username: "no spaces", password: PASSWORD }, { password: PASSWORD }, {}]) {
      assert.equal((await anon().call("POST", "/api/auth/first-run", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await anon().call("GET", "/api/auth/first-run")).status, 405);
    const r = await anon().call("POST", "/api/auth/first-run", { username: "robin", password: PASSWORD });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.learners.map((l) => l.name), ["Sam"], "no kids profile, no kids learner");
    assert.deepEqual(await db.select().from(userSettings), [], "no data/ files, no settings row");
    assert.deepEqual(await db.select().from(agentMessages), []);
  } finally {
    fs.writeFileSync(kidsProfile, saved);
  }
});

/* ------------------------------ login and logout -------------------------- */

test("login: a wrong password and an unknown user get the same 401; the right one sets an httpOnly, Lax, 30-day cookie whose hash is the session row", async () => {
  const { db } = await freshRoutes();
  await addUser(db, "robin", PASSWORD, { learners: [ADULT] });
  const wrong = await anon().call("POST", "/api/auth/login", { username: "robin", password: "not the password" });
  const nobody = await anon().call("POST", "/api/auth/login", { username: "nobody", password: PASSWORD });
  assert.equal(wrong.status, 401);
  assert.equal(nobody.status, 401);
  assert.equal(wrong.body.error, nobody.body.error);
  assert.equal((await anon().call("POST", "/api/auth/login", { username: "robin" })).status, 400);
  assert.equal((await anon().call("GET", "/api/auth/login")).status, 405);

  const c = anon();
  const r = await c.call("POST", "/api/auth/login", { username: "ROBIN", password: PASSWORD });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, "robin");
  assert.equal(r.body.user.isAdmin, false);
  assert.deepEqual(r.body.learners.map((l) => l.name), ["Sam"]);
  const [cookie] = c.setCookies;
  assert.match(cookie, /^ld_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/, "no Secure over plain http");
  const token = c.jar.cookie.slice("ld_session=".length);
  const rows = await db.select().from(authSessions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, tokenHash(token), "the row holds the hash");
  assert.ok(!JSON.stringify(rows).includes(token), "and never the token");
  const days = (rows[0].expiresAt - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, String(days));

  const me = await c.call("GET", "/api/auth/me");
  assert.equal(me.body.user.username, "robin");

  // Logout deletes the row and clears the cookie; the old cookie is dead.
  const stale = c.jar.cookie;
  const out = await c.call("POST", "/api/auth/logout");
  assert.equal(out.status, 200);
  assert.match(c.setCookies[0], /^ld_session=; .*Max-Age=0/);
  assert.equal((await db.select().from(authSessions)).length, 0);
  assert.equal((await c.call("GET", "/api/auth/me")).body.user, null);
  const replay = anon();
  replay.jar.cookie = stale;
  assert.equal((await replay.call("GET", "/api/packs")).status, 401, "a logged-out cookie is refused");
  assert.equal((await c.call("POST", "/api/auth/logout")).status, 401);
});

test("the Secure flag follows X-Forwarded-Proto: https (tailscale serve), on login and on clearing", async () => {
  const { db } = await freshRoutes();
  await addUser(db, "robin");
  const c = anon();
  const r = await c.call("POST", "/api/auth/login", { username: "robin", password: PASSWORD }, { "X-Forwarded-Proto": "https" });
  assert.equal(r.status, 200);
  assert.match(c.setCookies[0], /; HttpOnly; SameSite=Lax; Secure$/);
  await c.call("POST", "/api/auth/logout", undefined, { "X-Forwarded-Proto": "https" });
  assert.match(c.setCookies[0], /Max-Age=0; .*Secure$/);
  const plain = anon();
  await plain.call("POST", "/api/auth/login", { username: "robin", password: PASSWORD }, { "X-Forwarded-Proto": "http" });
  assert.doesNotMatch(plain.setCookies[0], /Secure/);
});

test("sessions expire after 30 days, sliding: use pushes the expiry out (at most once a minute); an expired one is a 401 and its cookie is cleared", async () => {
  const { db } = await freshRoutes();
  await addUser(db, "robin", PASSWORD, { learners: [ADULT] });
  const c = anon();
  await c.login("robin");
  const id = (await db.select().from(authSessions))[0].id;
  const row = async () => (await db.select().from(authSessions).where(eq(authSessions.id, id)))[0];

  // Seen moments ago: no write, no new cookie.
  await c.call("GET", "/api/auth/me");
  assert.equal(c.setCookies.length, 0);

  // Last seen two minutes ago, a day left: the next request slides it.
  await db.update(authSessions).set({ lastSeenAt: sql`now() - interval '2 minutes'`, expiresAt: sql`now() + interval '1 day'` }).where(eq(authSessions.id, id));
  const r = await c.call("GET", "/api/learners");
  assert.equal(r.status, 200);
  const days = ((await row()).expiresAt - Date.now()) / 86_400_000;
  assert.ok(days > 29.9, `slid to ${days} days`);
  assert.match(c.setCookies[0] ?? "", /^ld_session=.*Max-Age=2592000/, "the cookie is re-sent with the new expiry");

  // Expired: refused, and the browser is told to drop the cookie.
  await db.update(authSessions).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(authSessions.id, id));
  const dead = await c.call("GET", "/api/learners");
  assert.equal(dead.status, 401);
  assert.match(c.setCookies[0], /^ld_session=; .*Max-Age=0/);
  assert.equal((await c.call("GET", "/api/auth/me")).body.user, null);
  // The next login clears the user's expired rows.
  await c.login("robin");
  assert.equal((await db.select().from(authSessions)).length, 1);
});

test("the throttle: 5 failures for a username → 429 with Retry-After, even for the right password; other usernames are unaffected", async () => {
  const { db } = await freshRoutes();
  await addUser(db, "robin");
  await addUser(db, "lee");
  for (let i = 0; i < 5; i++) {
    assert.equal((await anon().call("POST", "/api/auth/login", { username: "robin", password: `wrong ${i}` })).status, 401);
  }
  const held = await anon().call("POST", "/api/auth/login", { username: "Robin", password: PASSWORD });
  assert.equal(held.status, 429, "the right password waits too (normalized username)");
  assert.match(held.body.error, /try again in 30 s/);
  assert.equal(held.headers.get("retry-after"), "30");
  assert.equal((await anon().call("POST", "/api/auth/login", { username: "lee", password: PASSWORD })).status, 200);
  // Unknown usernames are throttled the same way.
  for (let i = 0; i < 5; i++) await anon().call("POST", "/api/auth/login", { username: "ghost", password: "x" });
  assert.equal((await anon().call("POST", "/api/auth/login", { username: "ghost", password: "x" })).status, 429);
  resetLoginThrottle();
  assert.equal((await anon().call("POST", "/api/auth/login", { username: "robin", password: PASSWORD })).status, 200);
});

test("the throttle holds against parallel guesses: of 40 at once, 5 get an answer and the rest 429", async () => {
  const { db } = await freshRoutes();
  await addUser(db, "robin");
  const replies = await Promise.all(
    Array.from({ length: 40 }, (_, i) => anon().call("POST", "/api/auth/login", { username: "robin", password: `wrong ${i}` })),
  );
  const counts = {};
  for (const r of replies) counts[r.status] = (counts[r.status] ?? 0) + 1;
  assert.deepEqual(counts, { 401: 5, 429: 35 });
});

test("the throttle is per username and client: another client's guesses don't lock the owner out", async () => {
  const { db } = await freshRoutes();
  await addUser(db, "robin");
  // Through the local proxy (the test server is on loopback), the client is
  // the X-Forwarded-For hop the proxy added: the last one.
  const guesser = { "X-Forwarded-For": "100.64.0.9" };
  for (let i = 0; i < 5; i++) await anon().call("POST", "/api/auth/login", { username: "robin", password: `wrong ${i}` }, guesser);
  assert.equal((await anon().call("POST", "/api/auth/login", { username: "robin", password: PASSWORD }, guesser)).status, 429);
  const spoofed = { "X-Forwarded-For": "100.64.0.7, 100.64.0.9" };
  assert.equal((await anon().call("POST", "/api/auth/login", { username: "robin", password: PASSWORD }, spoofed)).status, 429, "a made-up first hop is not a new client");
  const owner = { "X-Forwarded-For": "100.64.0.7" };
  assert.equal((await anon().call("POST", "/api/auth/login", { username: "robin", password: PASSWORD }, owner)).status, 200);
});

test("a login with a username no account can have is the same 401, never reaches the throttle; the body is capped small", async () => {
  const { db } = await freshRoutes();
  await addUser(db, "robin");
  for (const username of ["x".repeat(4000), "no spaces", "../etc", "ROBIN!"]) {
    const r = await anon().call("POST", "/api/auth/login", { username, password: "whatever" });
    assert.equal(r.status, 401, username.slice(0, 20));
    assert.equal(r.body.error, "wrong username or password");
  }
  // Many of them are not throttled (they are never counted), and so neither
  // is the real account behind them.
  for (let i = 0; i < 10; i++) assert.equal((await anon().call("POST", "/api/auth/login", { username: `bad name ${i}`, password: "x" })).status, 401);
  assert.equal((await anon().call("POST", "/api/auth/login", { username: "robin", password: PASSWORD })).status, 200);
  const huge = await anon().call("POST", "/api/auth/login", { username: "x".repeat(20_000), password: "x" });
  assert.equal(huge.status, 413, "8 KB is the most a login body may be");
  assert.equal((await anon().call("POST", "/api/auth/first-run", { username: "x".repeat(20_000), password: "x" })).status, 413);
});

test("a disabled user, or a changed password, ends every session; a disabled user can't log in", async () => {
  const { db } = await freshRoutes();
  await addUser(db, "robin");
  await addUser(db, "lee");
  const robin = anon();
  await robin.login("robin");
  const lee = anon();
  await lee.login("lee");
  assert.equal(await setPassword(db, "robin", (await db.select().from(users).where(eq(users.username, "lee")))[0].passwordHash), true);
  assert.equal((await robin.call("GET", "/api/learners")).status, 401, "new password: signed out");
  assert.equal(await disableUser(db, "lee"), true);
  assert.equal((await lee.call("GET", "/api/learners")).status, 401);
  assert.equal((await anon().call("POST", "/api/auth/login", { username: "lee", password: PASSWORD })).status, 401);
  assert.equal(await disableUser(db, "nobody"), false);
  // enable undoes it: the same password works again.
  assert.equal(await enableUser(db, "lee"), true);
  assert.equal((await anon().call("POST", "/api/auth/login", { username: "lee", password: PASSWORD })).status, 200);
  assert.equal(await enableUser(db, "nobody"), false);
});

/* ------------------------------- access levels ---------------------------- */

test("access levels: anonymous is 401 everywhere but login, me and first run; a non-admin is 403 on the agent and its settings", async () => {
  const { db } = await freshRoutes();
  const admin = await as(db, "robin", { admin: true, learners: [ADULT] });
  const plain = await as(db, "lee", { learners: [KID] });
  await admin.c.pick("Sam");
  await plain.c.pick("Pip");

  const userRoutes = [
    ["GET", "/api/content"], ["PUT", "/api/profile", { level: "A1" }], ["GET", "/api/packs"], ["PUT", "/api/packs/2026-10-20-x", { title: "x" }],
    ["POST", "/api/folders", { name: "x" }], ["POST", "/api/assemble", { pack: {} }], ["POST", "/api/export", { pack: {}, id: "x" }],
    ["GET", "/api/voice/settings"], ["POST", "/api/voice/turn", {}], ["POST", "/api/voice/speak", {}], ["GET", "/api/learners"],
    ["POST", "/api/learners", { name: "x", mode: "adult" }], ["PUT", "/api/auth/learner", { learnerId: null }], ["POST", "/api/auth/logout"],
  ];
  const adminRoutes = [
    ["POST", "/api/chat", { message: "hi" }], ["GET", "/api/chat/history"], ["DELETE", "/api/chat/history"],
    ["GET", "/api/settings"], ["PUT", "/api/settings", { model: "claude-opus-5-5" }],
    // It adds a voice to the owner's ElevenLabs account, shared by everyone.
    ["POST", "/api/voice/library/add", { ownerId: "o", voiceId: "v", name: "n" }],
  ];
  for (const [m, u, body] of [...userRoutes, ...adminRoutes]) {
    const r = await anon().call(m, u, body);
    assert.equal(r.status, 401, `anonymous ${m} ${u}`);
    assert.equal(r.body.error, "log in first");
  }
  for (const [m, u, body] of adminRoutes) {
    const r = await plain.c.call(m, u, body);
    assert.equal(r.status, 403, `non-admin ${m} ${u}`);
  }
  assert.equal((await db.select().from(userSettings)).length, 0, "the refused PUT wrote nothing");
  // A non-admin reaches the user routes; the admin reaches the admin ones.
  assert.equal((await plain.c.call("GET", "/api/packs")).status, 200);
  assert.equal((await plain.c.call("GET", "/api/voice/settings")).status, 200);
  assert.equal((await admin.c.call("GET", "/api/chat/history")).status, 200);
  assert.equal((await admin.c.call("GET", "/api/settings")).status, 200);
  // Public: me and the unknown-route 404.
  assert.equal((await anon().call("GET", "/api/auth/me")).status, 200);
  assert.equal((await anon().call("GET", "/api/nope")).status, 404);
  // Cross-origin is refused before any of it.
  assert.equal((await admin.c.call("GET", "/api/learners", undefined, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await anon().call("POST", "/api/auth/login", { username: "robin", password: PASSWORD }, { Origin: "https://evil.example" })).status, 403);
});

/* --------------------------------- learners ------------------------------- */

test("learners: add, list, edit, archive and pick; the picked learner is on the session and sets the mode", async () => {
  const { db } = await freshRoutes();
  const { c } = await as(db, "robin");
  assert.deepEqual((await c.call("GET", "/api/learners")).body, { learners: [] }, "a CLI-made user starts with none");

  // A new learner comes with its first language, from the same body.
  const made = await c.call("POST", "/api/learners", { name: " Ana ", mode: "adult", target_language: "Italian" });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.learner.name, "Ana");
  assert.equal(made.body.learner.languages.length, 1);
  assert.equal(made.body.learner.languages[0].target_language, "Italian");
  assert.equal(made.body.learner.languages[0].level, "A1", "the mode's first level by default");
  const kid = (await c.call("POST", "/api/learners", { name: "Bo", mode: "kids", target_language: "Spanish" })).body.learner;
  assert.equal(kid.languages[0].level, "First words");
  for (const bad of [{ mode: "adult" }, { name: "x" }, { name: "x", mode: "teen" }, { name: "x", mode: "adult", wizard: 1 }, { name: "x", mode: "adult", level: 3 }, { name: "x".repeat(81), mode: "adult" }, [], "nope"]) {
    assert.equal((await c.call("POST", "/api/learners", bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await c.call("GET", "/api/learners")).body.learners.map((l) => l.name), ["Ana", "Bo"]);

  // An edit takes the person's own fields; a language's go through its route.
  const id = made.body.learner.id;
  const edited = await c.call("PATCH", `/api/learners/${id}`, { name: "Anna", native_language: "German" });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.learner.name, edited.body.learner.native_language, edited.body.learner.languages[0].target_language], ["Anna", "German", "Italian"]);
  assert.equal((await c.call("GET", `/api/learners/${id}`)).body.learner.name, "Anna");
  assert.equal((await c.call("PATCH", `/api/learners/${id}`, { mode: "kids" })).status, 400, "the mode is fixed");
  assert.equal((await c.call("PATCH", `/api/learners/${id}`, { name: "" })).status, 400);
  const misplaced = await c.call("PATCH", `/api/learners/${id}`, { level: "B1" });
  assert.equal(misplaced.status, 400, "level belongs to a language");
  assert.match(misplaced.body.error, /languages/);

  // Pick: the session carries the learner and its language, and the mode follows the learner.
  const picked = await c.call("PUT", "/api/auth/learner", { learnerId: kid.id });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.learner.name, "Bo");
  assert.equal(picked.body.language.id, kid.languages[0].id, "on its one language");
  const me = (await c.call("GET", "/api/auth/me")).body;
  assert.deepEqual([me.learner.id, me.language.id], [kid.id, kid.languages[0].id]);
  assert.equal((await c.call("GET", "/api/content")).body.mode, "kids");
  await c.call("PUT", "/api/auth/learner", { learnerId: id });
  assert.equal((await c.call("GET", "/api/content")).body.mode, "adult");
  assert.equal((await c.call("GET", "/api/content")).body.profile.learner_name, "Anna");
  assert.equal((await c.call("GET", "/api/content")).body.profile.target_language, "Italian");
  // Back to the picker.
  const none = (await c.call("PUT", "/api/auth/learner", { learnerId: null })).body;
  assert.deepEqual([none.learner, none.language], [null, null]);
  for (const bad of [{}, { learnerId: "not-a-uuid" }, { learnerId: "00000000-0000-4000-8000-000000000000" }]) {
    assert.equal((await c.call("PUT", "/api/auth/learner", bad)).status, 404, JSON.stringify(bad));
  }

  // Archive: out of the list, the picker for any session that had it, and no longer pickable.
  await c.call("PUT", "/api/auth/learner", { learnerId: id });
  const archived = await c.call("POST", `/api/learners/${id}/archive`);
  assert.equal(archived.status, 200);
  assert.deepEqual((await c.call("GET", "/api/learners")).body.learners.map((l) => l.name), ["Bo"]);
  const after = (await c.call("GET", "/api/auth/me")).body;
  assert.deepEqual([after.learner, after.language], [null, null]);
  assert.equal((await c.call("PUT", "/api/auth/learner", { learnerId: id })).status, 404);
  assert.equal((await c.call("POST", `/api/learners/${id}/archive`)).status, 404, "already archived");
  assert.equal((await c.call("PATCH", `/api/learners/${id}`, { name: "C" })).status, 404);
  assert.equal((await c.call("GET", `/api/learners/${id}/languages`)).status, 404, "nor are its languages reachable");
  assert.ok((await db.select().from(learners).where(eq(learners.id, id)))[0].archivedAt, "kept, not deleted");
  assert.equal((await c.call("GET", "/api/learners/x/y/z")).status, 404);
  assert.equal((await c.call("DELETE", `/api/learners/${kid.id}`)).status, 405);
});

test("languages: a learner adds, edits, picks and archives its languages; it keeps at least one; picking one lands the session on it, and a learner re-picked lands on its last-used one", async () => {
  const { db } = await freshRoutes();
  const { c } = await as(db, "robin", { learners: [ADULT] });
  const sam = (await c.call("GET", "/api/learners")).body.learners[0];
  const spanish = sam.languages[0];
  const url = `/api/learners/${sam.id}/languages`;

  // Add: the mode's first level unless one is given; bad bodies are a 400 and add nothing.
  const added = await c.call("POST", url, { target_language: "German", level: "B1", goals: "Talk with colleagues." });
  assert.equal(added.status, 200, added.text);
  const german = added.body.language;
  assert.deepEqual([german.learner_id, german.target_language, german.level, german.goals], [sam.id, "German", "B1", "Talk with colleagues."]);
  const chinese = (await c.call("POST", url, { target_language: "Mandarin Chinese" })).body.language;
  assert.equal(chinese.level, "A1");
  for (const bad of [{ name: "x" }, { mode: "kids" }, { level: 3 }, { goals: "x".repeat(2001) }, { constructor: "x" }, [], "nope"]) {
    assert.equal((await c.call("POST", url, bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await c.call("GET", url)).body.languages.map((l) => l.target_language), ["Spanish", "German", "Mandarin Chinese"]);
  assert.deepEqual((await c.call("GET", "/api/auth/me")).body.learners[0].languages.map((l) => l.target_language), ["Spanish", "German", "Mandarin Chinese"], "/me lists them with the learner");

  // Edit one language; the others are untouched.
  const edited = await c.call("PATCH", `${url}/${chinese.id}`, { target_variant: "Taiwan", level: "A2", notes: "Tones first." });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.language.target_variant, edited.body.language.level, edited.body.language.notes], ["Taiwan", "A2", "Tones first."]);
  assert.equal((await c.call("GET", `${url}/${german.id}`)).body.language.level, "B1");
  assert.equal((await c.call("PATCH", `${url}/${chinese.id}`, { name: "x" })).status, 400);

  // Pick a learner: it lands on its last-used language; then pick another of its languages.
  await c.pick("Sam");
  assert.equal((await c.call("GET", "/api/content")).body.profile.target_language, "Spanish");
  const switched = await c.call("PUT", "/api/auth/language", { languageId: german.id }, { "X-Language-Profile-Id": c.languageId });
  assert.equal(switched.status, 200, switched.text);
  assert.equal(switched.body.language.id, german.id);
  assert.equal(switched.body.learner.id, sam.id);
  c.languageId = german.id;
  const content = (await c.call("GET", "/api/content")).body;
  assert.deepEqual([content.profile.learner_name, content.profile.target_language, content.profile.level], ["Sam", "German", "B1"]);
  // Leaving and coming back to Sam: German, the one used last.
  await c.call("PUT", "/api/auth/learner", { learnerId: null });
  const back = await c.call("PUT", "/api/auth/learner", { learnerId: sam.id });
  assert.equal(back.body.language.id, german.id, "last used wins");
  c.languageId = german.id;
  for (const bad of [{}, { languageId: "not-a-uuid" }, { languageId: "00000000-0000-4000-8000-000000000000" }]) {
    assert.equal((await c.call("PUT", "/api/auth/language", bad)).status, 404, JSON.stringify(bad));
  }

  // Archive: the active one moves the session to the learner's default; the last one can't go.
  const gone = await c.call("POST", `${url}/${german.id}/archive`);
  assert.equal(gone.status, 200);
  const me = (await c.call("GET", "/api/auth/me")).body;
  assert.notEqual(me.language.id, german.id, "the session moved off it");
  assert.equal(me.language.learner_id, sam.id);
  assert.deepEqual((await c.call("GET", url)).body.languages.map((l) => l.target_language), ["Spanish", "Mandarin Chinese"]);
  assert.deepEqual((await c.call("GET", `${url}?archived=1`)).body.languages.map((l) => l.target_language).sort(), ["German", "Mandarin Chinese", "Spanish"]);
  assert.equal((await c.call("PUT", "/api/auth/language", { languageId: german.id })).status, 404, "no longer pickable");
  assert.equal((await c.call("PATCH", `${url}/${german.id}`, { level: "C1" })).status, 404);
  assert.equal((await c.call("POST", `${url}/${german.id}/archive`)).status, 404, "already archived");
  assert.equal((await c.call("POST", `${url}/${chinese.id}/archive`)).status, 200);
  const last = await c.call("POST", `${url}/${spanish.id}/archive`);
  assert.equal(last.status, 409, "a learner keeps at least one language");
  assert.match(last.body.error, /at least one language/);
  assert.deepEqual((await c.call("GET", url)).body.languages.map((l) => l.target_language), ["Spanish"]);
  assert.ok((await db.select().from(languageProfiles).where(eq(languageProfiles.id, german.id)))[0].archivedAt, "kept, not deleted");

  // Routes past the end, or methods they don't take.
  assert.equal((await c.call("GET", `${url}/${spanish.id}/archive/x`)).status, 404);
  assert.equal((await c.call("DELETE", `${url}/${spanish.id}`)).status, 405);
  assert.equal((await c.call("GET", "/api/auth/language")).status, 405);
});

test("languages across learners and accounts: another learner's or another account's language is a 404 on every route and changes nothing", async () => {
  const { db } = await freshRoutes();
  const a = await as(db, "robin", { learners: [ADULT, KID] });
  const b = await as(db, "lee", { learners: [{ ...ADULT, name: "Lee" }] });
  const [sam, pip] = a.learners;
  const samLanguage = (await db.select().from(languageProfiles).where(eq(languageProfiles.learnerId, sam.id)))[0];
  const pipLanguage = (await db.select().from(languageProfiles).where(eq(languageProfiles.learnerId, pip.id)))[0];
  // Picking touches last_used_at; everything else must stay as it was.
  const rows = async () => (await db.select().from(languageProfiles)).map(({ lastUsedAt, ...r }) => r).sort((x, y) => x.id.localeCompare(y.id));
  const before = await rows();

  // Another account: neither the learner nor its language is there.
  for (const [m, u, body] of [
    ["GET", `/api/learners/${sam.id}/languages`], ["POST", `/api/learners/${sam.id}/languages`, { target_language: "Hijacked" }],
    ["GET", `/api/learners/${sam.id}/languages/${samLanguage.id}`], ["PATCH", `/api/learners/${sam.id}/languages/${samLanguage.id}`, { level: "C2" }],
    ["POST", `/api/learners/${sam.id}/languages/${samLanguage.id}/archive`],
  ]) {
    assert.equal((await b.c.call(m, u, body)).status, 404, `lee: ${m} ${u}`);
  }
  await b.c.pick("Lee");
  assert.equal((await b.c.call("PUT", "/api/auth/language", { languageId: samLanguage.id })).status, 404, "lee can't pick Sam's language");

  // The same account, the wrong learner: Pip's language under Sam's path, or picked while Sam is active.
  await a.c.pick("Sam");
  assert.equal((await a.c.call("GET", `/api/learners/${sam.id}/languages/${pipLanguage.id}`)).status, 404);
  assert.equal((await a.c.call("PATCH", `/api/learners/${sam.id}/languages/${pipLanguage.id}`, { level: "C2" })).status, 404);
  assert.equal((await a.c.call("POST", `/api/learners/${sam.id}/languages/${pipLanguage.id}/archive`)).status, 404);
  assert.equal((await a.c.call("PUT", "/api/auth/language", { languageId: pipLanguage.id })).status, 404, "only the active learner's languages");
  assert.deepEqual(await rows(), before, "nothing changed");

  // The session table refuses a language that isn't its learner's, even past the route.
  const session = (await db.select().from(authSessions).where(eq(authSessions.userId, a.user.id)))[0];
  await assert.rejects(db.update(authSessions).set({ languageProfileId: pipLanguage.id }).where(eq(authSessions.id, session.id)));
});

/* ------------------------------- cross-tenant ----------------------------- */

test("cross-tenant: a second user never sees or changes the first user's learners, settings or agent chat", async () => {
  const { db } = await freshRoutes();
  const a = await as(db, "robin", { admin: true, learners: [ADULT, KID] });
  const b = await as(db, "lee", { admin: true, learners: [{ ...ADULT, name: "Lee" }] });
  const [sam, pip] = a.learners;
  await a.c.pick("Sam");

  // Learners: the list is your own; every route given another's id is a 404 and changes nothing.
  assert.deepEqual((await b.c.call("GET", "/api/learners")).body.learners.map((l) => l.name), ["Lee"]);
  assert.deepEqual((await b.c.call("GET", "/api/auth/me")).body.learners.map((l) => l.name), ["Lee"]);
  assert.equal((await b.c.call("GET", `/api/learners/${sam.id}`)).status, 404);
  assert.equal((await b.c.call("PATCH", `/api/learners/${sam.id}`, { name: "Hijacked" })).status, 404);
  assert.equal((await b.c.call("POST", `/api/learners/${pip.id}/archive`)).status, 404);
  assert.equal((await b.c.call("PUT", "/api/auth/learner", { learnerId: sam.id })).status, 404);
  const rows = await db.select().from(learners).where(eq(learners.userId, a.user.id));
  assert.deepEqual(rows.map((r) => [r.name, r.archivedAt]), [["Sam", null], ["Pip", null]]);
  assert.equal((await b.c.call("GET", "/api/content")).body.profile.learner_name, undefined, "no learner picked: no profile, never Sam's");
  // The session table refuses another user's learner even past the route.
  const bSession = (await db.select().from(authSessions).where(eq(authSessions.userId, b.user.id)))[0];
  await assert.rejects(db.update(authSessions).set({ learnerId: sam.id }).where(eq(authSessions.id, bSession.id)));

  // Profile writes reach only your own active learner.
  await b.c.pick("Lee");
  await b.c.call("PUT", "/api/profile", { learner_name: "Lee B", level: "C2" });
  assert.equal((await a.c.call("GET", "/api/content")).body.profile.learner_name, "Sam");
  assert.equal((await a.c.call("GET", "/api/content")).body.profile.level, "A2");

  // Settings: model and voice are per user.
  await a.c.call("PUT", "/api/settings", { model: "claude-opus-5-5" });
  await a.c.call("PUT", "/api/voice/settings", { turn: "pause" });
  assert.equal((await b.c.call("GET", "/api/settings")).body.model, "claude-sonnet-5-5");
  assert.equal((await b.c.call("GET", "/api/voice/settings")).body.settings.turn, "tap");
  await b.c.call("PUT", "/api/settings", { model: "claude-fable-5-1" });
  await b.c.call("PUT", "/api/voice/settings", { turn: "tap", handsFree: true });
  assert.equal((await a.c.call("GET", "/api/settings")).body.model, "claude-opus-5-5");
  assert.equal((await a.c.call("GET", "/api/voice/settings")).body.settings.turn, "pause");
  assert.equal((await a.c.call("GET", "/api/voice/settings")).body.settings.handsFree, false);

  // Agent chat: your own history; clearing it clears only yours.
  await db.insert(agentMessages).values([
    { userId: a.user.id, role: "user", text: "robin's question" },
    { userId: b.user.id, role: "user", text: "lee's question" },
  ]);
  assert.deepEqual((await a.c.call("GET", "/api/chat/history")).body.messages.map((m) => m.text), ["robin's question"]);
  assert.deepEqual((await b.c.call("GET", "/api/chat/history")).body.messages.map((m) => m.text), ["lee's question"]);
  assert.equal((await b.c.call("DELETE", "/api/chat/history")).status, 200);
  assert.deepEqual((await a.c.call("GET", "/api/chat/history")).body.messages.map((m) => m.text), ["robin's question"]);

  // Logging out ends only your own session.
  await b.c.call("POST", "/api/auth/logout");
  assert.equal((await a.c.call("GET", "/api/learners")).status, 200);
});

test("a language profile's target language is its identity: PUT /api/profile and PATCH can't change it, and a learner can't add a language it already has", async () => {
  const { db } = await freshRoutes();
  const { c } = await as(db, "robin", { learners: [ADULT] });
  await c.pick("Sam");
  const sam = (await c.call("GET", "/api/auth/me")).body.learner;
  const spanish = sam.languages[0];
  const url = `/api/learners/${sam.id}/languages`;
  const rows = async () => ({ learner: (await db.select().from(learners).where(eq(learners.id, sam.id)))[0], languages: await db.select().from(languageProfiles).where(eq(languageProfiles.learnerId, sam.id)) });
  const before = await rows();

  // "Save as my defaults" naming another language: refused, nothing written (not even the name in the same body).
  const moved = await c.call("PUT", "/api/profile", { learner_name: "Samuel", target_language: "German", level: "B1" });
  assert.equal(moved.status, 400, moved.text);
  assert.match(moved.body.error, /this profile is Spanish/);
  assert.deepEqual(await rows(), before, "the Spanish profile is not renamed, and the learner's half rolled back");
  // Naming its own language (any case) is fine: the stored spelling stays.
  const same = await c.call("PUT", "/api/profile", { target_language: "spanish", level: "B1" });
  assert.equal(same.status, 200, same.text);
  assert.deepEqual([same.body.profile.target_language, same.body.profile.level], ["Spanish", "B1"]);

  // The language route: variant, level, goals and notes change; the target language doesn't.
  const patched = await c.call("PATCH", `${url}/${spanish.id}`, { target_language: "French" });
  assert.equal(patched.status, 400);
  assert.match(patched.body.error, /this profile is Spanish/);
  const ok = await c.call("PATCH", `${url}/${spanish.id}`, { target_language: "Spanish", target_variant: "Castilian Spanish", goals: "Read the news." });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.body.language.target_language, ok.body.language.target_variant, ok.body.language.goals], ["Spanish", "Castilian Spanish", "Read the news."]);

  // One live profile per target language, whatever the case or variant.
  for (const body of [{ target_language: "Spanish" }, { target_language: " spanish ", target_variant: "Mexican Spanish" }]) {
    const again = await c.call("POST", url, body);
    assert.equal(again.status, 409, JSON.stringify(body));
    assert.match(again.body.error, /Sam already practises Spanish/);
  }
  assert.equal((await db.select().from(languageProfiles).where(eq(languageProfiles.learnerId, sam.id))).length, 1);
  // An archived one doesn't count: German, archived, can be added again (a fresh profile).
  const german = (await c.call("POST", url, { target_language: "German" })).body.language;
  assert.equal((await c.call("POST", `${url}/${german.id}/archive`)).status, 200);
  assert.equal((await c.call("POST", url, { target_language: "German" })).status, 200);

  // A profile with no target language yet (a library with no languages.yaml) may be given one, but not one the learner has.
  const blank = (await c.call("POST", url, {})).body.language;
  assert.equal(blank.target_language, "");
  assert.equal((await c.call("PATCH", `${url}/${blank.id}`, { target_language: "German" })).status, 409);
  const named = await c.call("PATCH", `${url}/${blank.id}`, { target_language: "Korean" });
  assert.equal(named.status, 200);
  assert.equal(named.body.language.target_language, "Korean");
  assert.equal((await c.call("PATCH", `${url}/${blank.id}`, { target_language: "Greek" })).status, 400, "and from then on it is fixed");
});

test("PUT /api/profile is all or nothing: a language archived between the session read and the write rolls the learner's half back too (409)", async () => {
  const testDb = await freshRoutes();
  const { db } = testDb;
  const { c } = await as(db, "robin", { learners: [ADULT] });
  await c.pick("Sam");
  // Archive the active language from inside the transaction, right after the
  // learner row is written: the window a concurrent archive would hit.
  await testDb.query(`create function test_archive_language() returns trigger language plpgsql as $$
    begin update language_profiles set archived_at = now() where learner_id = new.id; return new; end $$`);
  await testDb.query("create trigger test_archive_language after update on learners for each row execute function test_archive_language()");
  try {
    const r = await c.call("PUT", "/api/profile", { learner_name: "Samira", level: "C1" });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.code, "stale_learner");
    const [row] = await db.select().from(learners).where(eq(learners.name, "Sam"));
    assert.ok(row, "the name change rolled back");
    const [language] = await db.select().from(languageProfiles).where(eq(languageProfiles.learnerId, row.id));
    assert.deepEqual([language.level, language.archivedAt], ["A2", null], "and so did the trigger's archive: nothing of the write is left");
  } finally {
    await testDb.query("drop trigger test_archive_language on learners");
    await testDb.query("drop function test_archive_language()");
  }
});

test("every learner, language profile and session write keeps the one lock order: learners, then profiles, then sessions", async (t) => {
  // PGlite can't race (languages.pg.test.mjs does, on a real Postgres), so
  // this pins the order the race-safety rests on: the learner FOR UPDATE
  // first, then the profiles, in each write that checks the
  // one-per-language rule or the keep-one count.
  const fresh = await freshDb();
  t.after(fresh.close);
  const seen = [];
  const db = drizzle(fresh.client, { schema, logger: { logQuery: (q) => seen.push(q) } });
  const user = await createUser(db, { username: "order", passwordHash: "x" });
  const learner = await createLearner(db, user.id, ADULT);
  const locks = () => seen.filter((q) => /for update/i.test(q)).map((q) => /from "(\w+)"/.exec(q)?.[1]);
  const run = async (fn) => {
    seen.length = 0;
    await fn();
    return locks();
  };
  const blank = await createLanguageProfile(db, learner.id, {});
  assert.deepEqual(await run(() => createLanguageProfile(db, learner.id, { targetLanguage: "German" })), ["learners"]);
  assert.deepEqual(await run(() => updateLanguageProfile(db, learner.id, blank.id, { targetLanguage: "Italian" })), ["learners", "language_profiles"]);
  assert.deepEqual(await run(() => updateLanguageProfile(db, learner.id, blank.id, { level: "B1" })), ["learners", "language_profiles"]);
  assert.deepEqual(await run(() => archiveLanguageProfile(db, user.id, learner.id, blank.id)), ["learners", "language_profiles"]);

  // A session switch: the row locks and writes in order. Learners first (two
  // in id order when the switch changes learner), then the profile's
  // lastUsedAt, then the session.
  const steps = () =>
    seen
      .map((q) => (/for update/i.test(q) ? `lock ${/from "(\w+)"/.exec(q)?.[1]}` : /^update "(\w+)"/i.exec(q) ? `update ${/^update "(\w+)"/i.exec(q)[1]}` : null))
      .filter(Boolean);
  const other = await createLearner(db, user.id, { ...ADULT, name: "Ash" });
  const sessionId = "order-session";
  await createSession(db, user.id, sessionId, new Date(Date.now() + 3_600_000));
  const german = (await fresh.query("select id from language_profiles where learner_id = $1 and target_language = 'German'", [learner.id]))[0].id;
  seen.length = 0;
  await setSessionLearner(db, user.id, sessionId, learner.id, german);
  assert.deepEqual(steps(), ["lock learners", "update language_profiles", "update auth_sessions"]);
  seen.length = 0;
  await setSessionLearner(db, user.id, sessionId, other.id);
  assert.deepEqual(steps(), ["lock learners", "lock learners", "update language_profiles", "update auth_sessions"]);
  const lockedIds = seen.filter((q) => /for update/i.test(q)).length;
  assert.equal(lockedIds, 2, "both learners locked");
  // Locked in id order: the query params aren't in the logged text, so
  // compare the order setSessionLearner sorts by against the two ids.
  seen.length = 0;
  const params = [];
  const db2 = drizzle(fresh.client, { schema, logger: { logQuery: (q, ps) => /for update/i.test(q) && params.push(ps[0]) } });
  await setSessionLearner(db2, user.id, sessionId, learner.id, german);
  assert.deepEqual(params, [learner.id, other.id].sort());
  // Archived meanwhile: a refusal, the session unchanged.
  await archiveLanguageProfile(db, user.id, learner.id, german);
  const refused = await setSessionLearner(db, user.id, sessionId, learner.id, german);
  assert.deepEqual(refused, { refused: "language" });
});
