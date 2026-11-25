// The learner's kept choices (docs/DATA.md §Kept choices): the rules that
// bring a browser's copy and the server's together, the page's side of it
// (web/src/prefs.ts), PUT /api/prefs and the choices in GET /api/auth/me, on
// the real plugin with an in-process PGlite, and migration 0023. Every name
// here is made up.
//   node --test scripts/tests/prefs.http.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PREFS, PREF_KEYS, readPref as readPrefBody, reconcilePref } from "../../web/shared/prefs.ts";
import { savePref } from "../db/prefs.ts";
import { serveApi } from "./connect-stack.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, addUser, client, tab } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
const { apiPlugins } = await import("../../web/server/api.ts");

const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  await close();
  await testDb.close();
});

let n = 0;
async function someone() {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners: [ADULT] });
  const c = client(base);
  await c.login(name);
  await c.pick(ADULT.name);
  return c;
}
const prefs = async (c) => (await c.call("GET", "/api/auth/me")).body.prefs;
const put = (c, key, value, at = Date.now() - 1000) => c.call("PUT", "/api/prefs", { key, value, at });

test("a choice is kept for the language and comes with the page's first reply; a later one stands", async () => {
  const sam = await someone();
  assert.deepEqual(await prefs(sam), {});
  const t = Date.now() - 60_000;
  assert.deepEqual((await put(sam, "coaching", "strict", t)).body, { saved: true });
  assert.deepEqual(await prefs(sam), { coaching: { value: "strict", at: t } });
  assert.deepEqual((await put(sam, "coaching", "off", t - 1)).body, { saved: false }, "an older choice, late");
  assert.deepEqual((await put(sam, "coaching", "off", t)).body, { saved: false }, "the same one again");
  assert.deepEqual((await put(sam, "coaching", "off", t + 1)).body, { saved: true });
  assert.equal((await prefs(sam)).coaching.value, "off");
  // Another language of the learner, and another learner, have their own.
  await sam.addLanguage({ target_language: "German", level: "A1" });
  assert.deepEqual(await prefs(sam), {});
  assert.deepEqual(await prefs(await someone()), {});
  await sam.pickLanguage("Spanish");
  assert.equal((await prefs(sam)).coaching.value, "off");
});

test("a clock ahead of the server's can't hold a choice for good", async () => {
  const sam = await someone();
  await put(sam, "ruby", "off", Date.now() + 1e9);
  assert.ok((await prefs(sam)).ruby.at <= Date.now());
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual((await put(sam, "ruby", "pinyin", Date.now())).body, { saved: true });
});

test("the first choices of two devices landing together: one row, the later one", async () => {
  const sam = await someone();
  const [l] = await q("select learner_id, id from language_profiles where id = $1", [sam.languageId]);
  const profile = { id: l.id, learnerId: l.learner_id };
  const t = Date.now() - 1000;
  await Promise.all([savePref(testDb.db, profile, { key: "practice", value: "a", at: t }), savePref(testDb.db, profile, { key: "practice", value: "b", at: t + 5 })]);
  assert.deepEqual(await q("select value from language_prefs where language_profile_id = $1", [l.id]), [{ value: "b" }]);
});

test("no session is a 401, a stale page a 409, a bad body a 400; nothing is written", async () => {
  assert.equal((await put(client(base), "ruby", "off")).status, 401);
  const anon = (await client(base).call("GET", "/api/auth/me")).body;
  assert.deepEqual([anon.prefs, anon.boot], [undefined, undefined], "nothing for no one");
  const sam = await someone();
  const spanish = sam.languageId;
  await sam.addLanguage({ target_language: "German", level: "A1" });
  const old = tab(base, sam);
  old.languageId = spanish;
  const r = await put(old, "ruby", "off");
  assert.deepEqual([r.status, r.body.code], [409, "stale_learner"]);
  for (const body of [{}, [], null, { key: "nope", value: "x", at: 1 }, { key: "toString", value: "x", at: 1 }, { key: "ruby", value: 3, at: 1 }, { key: "ruby", value: "x" }, { key: "ruby", value: "x", at: -1 }, { key: "ruby", value: "x", at: "1" }, { key: "ruby", value: "拼".repeat(PREFS.ruby.max / 2), at: 1 }]) {
    assert.equal((await sam.call("PUT", "/api/prefs", body)).status, 400, JSON.stringify(body)?.slice(0, 80));
  }
  assert.equal((await sam.call("GET", "/api/prefs")).status, 405);
  assert.equal((await sam.call("PUT", "/api/prefs/ruby", {})).status, 404);
  assert.equal((await q("select count(*)::int as n from language_prefs where language_profile_id = any($1)", [[spanish, sam.languageId]]))[0].n, 0);
});

test("GET /api/auth/me says which start of the server answers, the same one each time", async () => {
  const sam = await someone();
  const { boot } = (await sam.call("GET", "/api/auth/me")).body;
  assert.match(boot, /^[0-9a-f-]{36}$/);
  assert.equal((await sam.call("GET", "/api/auth/me")).body.boot, boot);
});

test("migration 0023: a language's choices go with it, and no reader sees them", async () => {
  const sam = await someone();
  await put(sam, "ruby", "off");
  assert.deepEqual(await q("select relrowsecurity from pg_class where relname = 'language_prefs'"), [{ relrowsecurity: false }]);
  await assert.rejects(q("insert into language_prefs (learner_id, language_profile_id, key, value, changed_at) select learner_id, id, '', 'x', now() from language_profiles where id = $1", [sam.languageId]));
  await assert.rejects(q("insert into language_prefs (learner_id, language_profile_id, key, value, changed_at) select learner_id, id, 'k', repeat('x', 65537), now() from language_profiles where id = $1", [sam.languageId]));
  await q("delete from language_profiles where id = $1", [sam.languageId]);
  assert.equal((await q("select count(*)::int as n from language_prefs where language_profile_id = $1", [sam.languageId]))[0].n, 0);
  // Every key fits the column, every limit the check.
  for (const k of PREF_KEYS) assert.ok(k.length <= 40 && PREFS[k].max <= 65536, k);
});

/* --------------------------------- the rules -------------------------------- */

test("reconcilePref: an empty browser takes the server's, an empty server is sent the browser's", () => {
  for (const rule of ["latest", "fallback"]) {
    assert.equal(reconcilePref(rule, null, null), "keep");
    assert.equal(reconcilePref(rule, null, { value: "a", at: 5 }), "take");
    assert.equal(reconcilePref(rule, { value: "a", at: null }, null), "send");
    assert.equal(reconcilePref(rule, { value: "a", at: 1 }, { value: "a", at: 5 }), "keep", "the same choice");
    assert.equal(reconcilePref(rule, { value: "b", at: 9 }, { value: "a", at: 5 }), "send", "newer here");
  }
  assert.equal(reconcilePref("latest", { value: "b", at: 1 }, { value: "a", at: 5 }), "take");
  assert.equal(reconcilePref("latest", { value: "b", at: null }, { value: "a", at: 5 }), "take", "kept before choices had a time");
  assert.equal(reconcilePref("fallback", { value: "b", at: 1 }, { value: "a", at: 5 }), "keep", "what this page is in the middle of");
});

test("readPref (a PUT's body) measures what it keeps in bytes", () => {
  assert.deepEqual(readPrefBody({ key: "ruby", value: "x".repeat(64), at: 3.4 }), { value: { key: "ruby", value: "x".repeat(64), at: 3 } });
  assert.ok("error" in readPrefBody({ key: "ruby", value: "x".repeat(65), at: 3 }));
  assert.ok("error" in readPrefBody({ key: "ruby", value: "拼".repeat(22), at: 3 }));
});

/* -------------------------------- on the page ------------------------------- */

test("the page: choices survive blocked storage, go to the server once settled, and another language's stay local", async (t) => {
  const saved = ["localStorage", "fetch"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  t.after(() => saved.forEach(([k, d]) => (d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k])));
  const store = new Map();
  const put = (k, value) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  put("localStorage", { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) });
  const sent = [];
  put("fetch", async (url, init) => {
    sent.push({ url, ...JSON.parse(init.body), language: init.headers["X-Language-Profile-Id"] });
    return new Response("{}");
  });
  const { hydratePrefs, keepPref, readPref } = await import("../../web/src/prefs.ts");
  const { setPageLearner, settleBeforeSwitch } = await import("../../web/src/api.ts");
  const page = { learnerId: "L", languageId: "G" };
  // Once one per browser: a language with none of its own starts from it.
  store.set("lingo-dojo.practice.v1", "old");
  assert.equal(readPref("G", "practice"), "old");
  setPageLearner(page);
  keepPref("G", "coaching", "strict");
  keepPref("G", "coaching", "off");
  keepPref("OTHER", "coaching", "strict");
  // `settleBeforeSwitch` sends what waits; Node has no window, so this is
  // registered only in a browser: wait the send out instead.
  await new Promise((r) => setTimeout(r, 900));
  await settleBeforeSwitch().catch(() => {});
  assert.deepEqual(sent.map((s) => [s.url, s.key, s.value, s.language]), [["/api/prefs", "coaching", "off", "G"]], "the last of a quick run, for the page's language");
  keepPref("G", "coaching", "off");
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(sent.length, 1, "nothing for what is kept already");
  // The server's copy: newer there is taken, newer here is sent.
  sent.length = 0;
  hydratePrefs(page, { coaching: { value: "light", at: Date.now() + 60_000 }, ruby: { value: "zhuyin", at: 5 }, draft: { value: "{}", at: 5 } });
  assert.deepEqual([readPref("G", "coaching"), readPref("G", "ruby"), readPref("G", "draft")], ["light", "zhuyin", "{}"]);
  keepPref("G", "ruby", "off");
  hydratePrefs(page, { ruby: { value: "zhuyin", at: 5 }, coaching: { value: "light", at: 1 }, draft: { value: "{}", at: 5 } });
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(sent.filter((s) => s.key === "ruby").map((s) => s.value), ["off"]);
  // Storage that refuses everything: the page still has its choices.
  put("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem() {} });
  keepPref("G", "ruby", "pinyin");
  assert.equal(readPref("G", "ruby"), "pinyin");
});
