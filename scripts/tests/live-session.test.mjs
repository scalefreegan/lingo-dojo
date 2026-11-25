// The Go tab's session kept for a reload (web/src/liveSession.ts,
// docs/VOICE.md §Reload): what storage holds is read as a session or not at
// all, a stored reply the page never got is taken up, and one tab at a time
// keeps and restores a language's. Node strips the TS types.
//   node --test scripts/tests/live-session.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_MAX_AGE_MS, endLeftSession, liveKeeper, parseLive, withStored } from "../../web/src/liveSession.ts";
import { IDLE_END_MS } from "../conversations.mjs";

const NOW = 1_800_000_000_000;
const me = (text) => ({ role: "learner", text });
const master = (...texts) => ({ role: "master", lines: texts.map((text) => ({ speaker: "narrator", gender: "female", text })) });
const session = (extra = {}) => ({
  v: 1, at: NOW - 60_000, entries: [master("Hola."), me("hola")], plan: [{ id: "scene", kind: "scene", title: "The scene" }],
  conversation: { id: "c1", start: 0, page: { learnerId: "L", languageId: "G" } }, unsavedFrom: null, startedAt: NOW - 120_000, baseMinutes: 10, extraMinutes: 5,
  drawn: null, buildsOn: null, cast: null, held: [["character:female|ana", { asked: "adult" }]], holder: [["character:female", "character:female|ana"]], tones: [[1, { kind: "words" }]],
  composer: "half a li", direct: false, heldRequest: null, chars: 12, ended: false, recapId: null, ...extra,
});
const parse = (s, language = "G", now = NOW) => parseLive(typeof s === "string" ? s : JSON.stringify(s), language, now);

test("a session left longer than the server keeps its conversation open is over", () => {
  assert.equal(LIVE_MAX_AGE_MS, IDLE_END_MS);
  assert.equal(parse(session({ at: NOW - LIVE_MAX_AGE_MS + 1 })).fresh, true);
  const old = parse(session({ at: NOW - LIVE_MAX_AGE_MS }));
  assert.equal(old.fresh, false);
  assert.equal(old.session.conversation.id, "c1", "its conversation is still named, to be ended");
  assert.equal(parse(session({ at: NOW + 5000 })).fresh, true, "a clock set back");
});

test("what was kept comes back whole; anything that isn't a session is nothing", () => {
  assert.deepEqual(parse(session()).session, session());
  for (const bad of [null, "", "{", "[]", "7", { ...session(), v: 2 }, session({ entries: [] }), session({ entries: [{ role: "master" }] }), session({ entries: [{ role: "x", text: "y" }] }), session({ at: "soon" })]) {
    assert.equal(bad === null ? parseLive(null, "G", NOW) : parse(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test("a field that isn't what it should be is dropped, not the session", () => {
  const s = parse(session({ conversation: { id: 7 }, plan: "x", cast: { cast: 3 }, held: [["a"], 3], holder: [["s", 1]], tones: [["0", {}]], startedAt: "now", ended: "yes", composer: 4, buildsOn: 5 })).session;
  assert.deepEqual([s.conversation, s.plan, s.cast, s.held, s.holder, s.tones, s.startedAt, s.ended, s.composer, s.buildsOn], [null, [], null, [], [], [], null, false, "", null]);
  // Another language's conversation is never gone on with.
  assert.equal(parse(session(), "OTHER").session.conversation, null);
});

test("withStored: a reply the server stored as the page went is the session's; any difference leaves the screen as it is", () => {
  const shown = [master("Hola."), me("hola")];
  const reply = master("¿Qué tal?");
  assert.deepEqual(withStored(shown, 0, [...shown, reply]), [...shown, reply]);
  assert.deepEqual(withStored(shown, 0, [master("Hola. "), me(" hola"), reply])?.length, 3, "spacing is not a difference");
  // The conversation began partway into the session.
  assert.deepEqual(withStored([master("Earlier."), ...shown], 1, [...shown, reply]).length, 4);
  for (const stored of [[], [shown[0]], shown, [master("Hola."), me("adiós"), reply], [master("Hola.", "Más."), me("hola"), reply], [me("Hola."), me("hola"), reply]]) {
    assert.equal(withStored(shown, 0, stored), null);
  }
});

/* ------------------------------- the keeper ------------------------------- */

/** A browser's storage and locks, shared by its tabs. */
function browser(t, { locks = true } = {}) {
  const store = new Map();
  const heldBy = new Set();
  const saved = [Object.getOwnPropertyDescriptor(globalThis, "localStorage"), Object.getOwnPropertyDescriptor(globalThis, "navigator")];
  const put = (k, value) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  put("localStorage", { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) });
  const request = async (name, _opts, fn) => {
    if (heldBy.has(name)) return fn(null);
    heldBy.add(name);
    try {
      return await fn({ name });
    } finally {
      heldBy.delete(name);
    }
  };
  put("navigator", locks ? { locks: { request } } : {});
  t.after(() => ["localStorage", "navigator"].forEach((k, i) => (saved[i] ? Object.defineProperty(globalThis, k, saved[i]) : delete globalThis[k])));
  return store;
}
const soon = () => new Promise((r) => setTimeout(r, 20));
const now = (extra) => session({ at: Date.now(), ...extra });

test("one tab keeps a session and gets it back; another tab neither reads nor overwrites it", async (t) => {
  const store = browser(t);
  const a = liveKeeper("G");
  assert.equal(a.read(), null, "nothing without holding it");
  a.write(now());
  await soon();
  assert.equal(a.held, true);
  assert.equal(a.read().session.composer, "half a li");
  const b = liveKeeper("G");
  assert.equal(b.some(), true);
  assert.equal(await b.take(), false);
  b.write(now({ composer: "from b" }));
  b.drop();
  await soon();
  assert.equal(a.read().session.composer, "half a li");
  // Another language is another session.
  const es = liveKeeper("H");
  es.write(now({ composer: "h" }));
  await soon();
  assert.equal(store.size, 2);
  // The page goes: the next load takes it up.
  a.close();
  await soon();
  assert.equal(await b.take(), true);
  assert.equal(b.read().session.composer, "half a li");
  b.drop();
  assert.equal(b.some(), false, "dropped");
});

test("a lock that comes after the tab has let go is let go too", async (t) => {
  browser(t);
  const a = liveKeeper("G");
  const asked = a.take();
  a.close();
  assert.equal(await asked, false);
  await soon();
  assert.equal(await liveKeeper("G").take(), true);
});

test("a language left with its Go tab off the page: its session is ended and dropped, another tab's is not", async (t) => {
  const store = browser(t);
  const ended = [];
  const end = async (c) => void ended.push(c.id);
  await endLeftSession("G", end);
  assert.deepEqual(ended, [], "nothing kept");
  const a = liveKeeper("G");
  a.write(now());
  await soon();
  await endLeftSession("G", end);
  assert.deepEqual([ended, store.size], [[], 1], "the other tab has it");
  a.close();
  await soon();
  await endLeftSession("G", end);
  assert.deepEqual([ended, store.size], [["c1"], 0]);
  // One that had ended is only dropped, and the language is free again.
  const b = liveKeeper("G");
  assert.equal(await b.take(), true);
  b.write(now({ ended: true }));
  b.close();
  await soon();
  await endLeftSession("G", end);
  assert.deepEqual([ended, store.size], [["c1"], 0]);
});

test("no locks in the browser: kept all the same; storage that refuses is no error", async (t) => {
  browser(t, { locks: false });
  const a = liveKeeper("G");
  a.write(now());
  await soon();
  assert.equal(a.read().fresh, true);
  globalThis.localStorage.setItem = () => {
    throw new Error("full");
  };
  a.write(now({ composer: "later" }));
  assert.equal(a.read().session.composer, "half a li");
});
