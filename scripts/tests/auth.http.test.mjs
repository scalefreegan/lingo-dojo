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
import { disableUser, enableUser, setPassword } from "../db/accounts.ts";
import { agentMessages, authSessions, learners, userSettings, users } from "../db/schema.ts";

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
    assert.deepEqual(me.body, { firstRun: true, firstRunHere: true, user: null, learners: [], learner: null });

    const c = anon();
    const r = await c.call("POST", "/api/auth/first-run", { username: " Robin ", password: PASSWORD });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.firstRun, false);
    assert.equal(r.body.user.username, "robin", "normalized");
    assert.equal(r.body.user.isAdmin, true);
    assert.equal(r.body.learner, null, "the picker comes next");
    assert.deepEqual(r.body.learners.map((l) => [l.name, l.mode, l.level]), [["Sam", "adult", "A2"], ["Pip", "kids", "First words"]]);
    assert.equal(r.body.learners[0].goals, "Order food and chat with vendors.");
    assert.equal(r.body.learners[0].target_variant, "Mexican Spanish");
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
  assert.deepEqual(me.body, { firstRun: true, firstRunHere: false, user: null, learners: [], learner: null });

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

  const made = await c.call("POST", "/api/learners", { name: " Ana ", mode: "adult", target_language: "Italian" });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.learner.name, "Ana");
  assert.equal(made.body.learner.level, "A1", "the mode's first level by default");
  const kid = (await c.call("POST", "/api/learners", { name: "Bo", mode: "kids" })).body.learner;
  assert.equal(kid.level, "First words");
  for (const bad of [{ mode: "adult" }, { name: "x" }, { name: "x", mode: "teen" }, { name: "x", mode: "adult", wizard: 1 }, { name: "x", mode: "adult", level: 3 }, { name: "x".repeat(81), mode: "adult" }, [], "nope"]) {
    assert.equal((await c.call("POST", "/api/learners", bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await c.call("GET", "/api/learners")).body.learners.map((l) => l.name), ["Ana", "Bo"]);

  const id = made.body.learner.id;
  const edited = await c.call("PATCH", `/api/learners/${id}`, { level: "B1", goals: "Read menus.", notes: "" });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.learner.level, edited.body.learner.goals, edited.body.learner.target_language], ["B1", "Read menus.", "Italian"]);
  assert.equal((await c.call("GET", `/api/learners/${id}`)).body.learner.level, "B1");
  assert.equal((await c.call("PATCH", `/api/learners/${id}`, { mode: "kids" })).status, 400, "the mode is fixed");
  assert.equal((await c.call("PATCH", `/api/learners/${id}`, { name: "" })).status, 400);

  // Pick: the session carries it, and the mode follows the learner.
  const picked = await c.call("PUT", "/api/auth/learner", { learnerId: kid.id });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.learner.name, "Bo");
  assert.equal((await c.call("GET", "/api/auth/me")).body.learner.id, kid.id);
  assert.equal((await c.call("GET", "/api/content")).body.mode, "kids");
  await c.call("PUT", "/api/auth/learner", { learnerId: id });
  assert.equal((await c.call("GET", "/api/content")).body.mode, "adult");
  assert.equal((await c.call("GET", "/api/content")).body.profile.learner_name, "Ana");
  // Back to the picker.
  assert.equal((await c.call("PUT", "/api/auth/learner", { learnerId: null })).body.learner, null);
  for (const bad of [{}, { learnerId: "not-a-uuid" }, { learnerId: "00000000-0000-4000-8000-000000000000" }]) {
    assert.equal((await c.call("PUT", "/api/auth/learner", bad)).status, 404, JSON.stringify(bad));
  }

  // Archive: out of the list, the picker for any session that had it, and no longer pickable.
  await c.call("PUT", "/api/auth/learner", { learnerId: id });
  const archived = await c.call("POST", `/api/learners/${id}/archive`);
  assert.equal(archived.status, 200);
  assert.deepEqual((await c.call("GET", "/api/learners")).body.learners.map((l) => l.name), ["Bo"]);
  assert.equal((await c.call("GET", "/api/auth/me")).body.learner, null);
  assert.equal((await c.call("PUT", "/api/auth/learner", { learnerId: id })).status, 404);
  assert.equal((await c.call("POST", `/api/learners/${id}/archive`)).status, 404, "already archived");
  assert.equal((await c.call("PATCH", `/api/learners/${id}`, { level: "C1" })).status, 404);
  assert.ok((await db.select().from(learners).where(eq(learners.id, id)))[0].archivedAt, "kept, not deleted");
  assert.equal((await c.call("GET", "/api/learners/x/y/z")).status, 404);
  assert.equal((await c.call("DELETE", `/api/learners/${kid.id}`)).status, 405);
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
