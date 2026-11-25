// Saved conversations end to end over HTTP (web/server/conversations.ts and
// the voice turn that writes them), on the real plugin with an in-process
// PGlite and a stand-in `claude` first on PATH, so nothing real is spawned
// and no provider is reachable. Every name here is made up.
//   node --test scripts/tests/conversations.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client, tab } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

const { apiPlugins } = await import("../../web/server/api.ts");
const { observeConversationEnds } = await import("../../web/server/conversations.ts");

// The stand-in `claude` (fake-claude.mjs).
const fake = fakeClaude();
const answer = fake.answer;
const runs = fake.runs;

const REPLY = [
  "NARRATOR-F: Bienvenido al <t>mercado</t>.",
  "CHARACTER-F: <pause 0.8> <t>¿Qué le doy, joven?</t>",
  "GLOSS: mercado = market | ¿Qué le doy, joven? = What can I get you, young man?",
  "CHOICES: Slower | Keep going",
  "CAST: CHARACTER-F old, Doña Carmen, the fruit vendor",
  "STAGE: scene",
].join("\n");

const testDb = await freshDb();
const q = testDb.query;
let base, close, sam, ends;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
  await addUser(testDb.db, "robin", undefined, { learners: [ADULT, KID, { ...ADULT, name: "Ana" }] });
  sam = client(base);
  await sam.login("robin");
  await sam.pick("Sam");
  observeConversationEnds((c) => ends.push(c.id));
});
after(async () => {
  observeConversationEnds(null);
  fake.restore();
  await close();
  await testDb.close();
});
beforeEach(() => {
  ends = [];
  answer(REPLY);
});

const pack = (extra = {}) => ({ title: "", created: "", scenario: "market", quick_scenario: "", units: [], overrides: { minutes: 10 }, notes: "", ...extra });

async function start(who = sam, body = {}) {
  const r = await who.call("POST", "/api/conversations", { mode: "adult", pack: pack(), title: "At the market", ...body });
  assert.equal(r.status, 201, r.text);
  return r.body.conversation;
}

/** One voice turn; the history is what the screen shows before it. */
const turn = (who, conversationId, history, message, extra = {}) =>
  who.call("POST", "/api/voice/turn", { mode: "adult", pack: pack(), history, message, elapsedMs: 0, ...(conversationId ? { conversationId } : {}), ...extra });

/** The screen after a turn: the history plus the message and the reply, as VoicePanel builds it. */
const after1 = (history, message, r) => [
  ...history,
  ...(message ? [{ role: "learner", text: message }] : []),
  { role: "master", lines: r.body.lines, glosses: r.body.glosses, choices: r.body.choices, stage: r.body.stage ?? undefined, castNotes: r.body.castNotes },
];

const stored = (id) => q("select idx, role, text, lines, glosses, choices, stage, cast_notes, duration_ms, cost_usd, from_client from turns where conversation_id = $1 order by idx", [id]);

test("POST /api/conversations stores the pack snapshot, title, mode, variant, model and planned minutes for the active learner", async () => {
  const c = await start();
  assert.match(c.id, /^[0-9a-f-]{36}$/);
  assert.equal(c.title, "At the market");
  assert.equal(c.mode, "adult");
  assert.equal(c.scenarioId, "market");
  assert.equal(c.targetVariant, "Mexican Spanish", "the learner's, when the pack doesn't override it");
  assert.equal(c.targetLanguage, "Spanish");
  assert.equal(c.nativeLanguage, "English");
  assert.equal(c.plannedMinutes, 10);
  assert.ok(c.model);
  assert.equal(c.endedAt, null);
  assert.equal(c.turnCount, 0);
  const [row] = await q("select c.pack_snapshot, l.name from conversations c join learners l on l.id = c.learner_id where c.id = $1", [c.id]);
  assert.equal(row.name, "Sam");
  // With the review it was given (none: this library has no recall slot).
  assert.deepEqual(row.pack_snapshot, { ...pack(), review: { phraseIds: [] } });
  // A pack's own variant wins; no title falls back to the scenario's.
  const other = await start(sam, { title: "", pack: pack({ overrides: { target_variant: "Castilian Spanish" } }) });
  assert.equal(other.targetVariant, "Castilian Spanish");
  // A pack that moves the target language drops the profile's variant, as
  // the prompt does (assemble.mjs effectiveProfile).
  const moved = await start(sam, { pack: pack({ overrides: { target_language: "German", native_language: "Spanish" } }) });
  assert.deepEqual([moved.targetLanguage, moved.targetVariant, moved.nativeLanguage], ["German", "", "Spanish"]);
  assert.equal(other.plannedMinutes, null, "no minutes, no limit");
  assert.ok(other.title.length > 0);
  // Malformed requests.
  assert.equal((await sam.call("POST", "/api/conversations", { mode: "adult" })).status, 400);
  assert.equal((await sam.call("POST", "/api/conversations", { mode: "kids", pack: pack() })).status, 400);
  assert.equal((await sam.call("PUT", "/api/conversations", {})).status, 405);
});

test("each successful turn stores the learner turn and the master turn, in VoiceHistoryItem's shapes, with timing, cost and model", async () => {
  const c = await start();
  const r0 = await turn(sam, c.id, [], "");
  assert.equal(r0.status, 200, r0.text);
  assert.equal(r0.body.saved, true);
  let screen = after1([], "", r0);
  const r1 = await turn(sam, c.id, screen, "Quiero mangos", { pack: pack({ overrides: { minutes: 15 } }) });
  assert.equal(r1.body.saved, true);
  screen = after1(screen, "Quiero mangos", r1);
  const rows = await stored(c.id);
  assert.deepEqual(rows.map((t) => [t.idx, t.role]), [[0, "master"], [1, "learner"], [2, "master"]]);
  const [m] = rows;
  assert.equal(m.text, null);
  assert.deepEqual(m.lines, r0.body.lines, "lines with segments, gender and timing, as the reply had them");
  assert.equal(m.lines[1].gender, "female");
  assert.ok(m.lines[1].segments.some((s) => s.lang === "target"));
  assert.ok(m.lines[1].pauseMs > 0, "the timing mark resolved");
  assert.deepEqual(m.glosses, [{ term: "mercado", meaning: "market" }, { term: "¿Qué le doy, joven?", meaning: "What can I get you, young man?" }]);
  assert.deepEqual(m.choices, ["Slower", "Keep going"]);
  assert.equal(m.stage, "scene");
  assert.deepEqual(m.cast_notes, [{ slot: "character:female", age: "old", who: "Doña Carmen, the fruit vendor" }]);
  assert.equal(m.duration_ms, 1234);
  assert.equal(m.cost_usd, 0.0125);
  assert.equal(rows[1].text, "Quiero mangos");
  assert.equal(rows[1].lines, null);
  assert.equal(rows[1].duration_ms, null);
  const [conv] = await q("select turn_count, planned_minutes, model from conversations where id = $1", [c.id]);
  assert.equal(conv.turn_count, 3);
  assert.equal(conv.planned_minutes, 15, "the length as of the last turn (+5 min, a new pick)");
  assert.equal(conv.model, r1.body.model);
  // GET gives them back as the transcript showed them.
  const g = await sam.call("GET", `/api/conversations/${c.id}`);
  assert.equal(g.status, 200, g.text);
  assert.deepEqual(g.body.turns.map(({ idx, at, durationMs, costUsd, ...item }) => item), screen.map((e) => JSON.parse(JSON.stringify(e))));
  assert.equal(g.body.turns[0].durationMs, 1234);
  assert.equal(g.body.locale, "es-MX");
  assert.ok(Array.isArray(g.body.plan) && g.body.plan.length > 0);
  assert.equal(g.body.conversation.turnCount, 3);
  assert.ok(g.body.conversation.lastTurnAt);
  // A turn without a conversation still runs, unsaved and unreported.
  const loose = await turn(sam, null, [], "");
  assert.equal(loose.status, 200);
  assert.equal(loose.body.saved, undefined);
});

test("retries, stopped turns and dropped replies: the stored turns follow the screen, idx gap-free", async () => {
  const c = await start();
  const r0 = await turn(sam, c.id, [], "");
  const screen0 = after1([], "", r0);
  // Stop raced the answer: the server stored "first answer", the browser
  // dropped it and shows only "hola". Sent again from that screen, the
  // dropped reply (and only it) is replaced.
  answer("NARRATOR-F: first answer");
  await turn(sam, c.id, screen0, "hola");
  answer("NARRATOR-F: second answer");
  const again = await turn(sam, c.id, [...screen0, { role: "learner", text: "hola" }], "");
  assert.equal(again.body.saved, true);
  let rows = await stored(c.id);
  assert.deepEqual(rows.map((t) => [t.idx, t.role, t.text]), [[0, "master", null], [1, "learner", "hola"], [2, "master", null]]);
  assert.equal(rows[2].lines[0].text, "second answer");
  assert.equal(rows[0].duration_ms, 1234, "the opening, which agreed, kept its timing");
  // A turn that failed (or was stopped) leaves "¿y?" on screen with no
  // reply; the next turn stores it, reply-less, before its own.
  const screen1 = [...after1([...screen0, { role: "learner", text: "hola" }], "", again), { role: "learner", text: "¿y?" }];
  answer("NARRATOR-F: tercera");
  const r3 = await turn(sam, c.id, screen1, "¿y ahora?");
  rows = await stored(c.id);
  assert.deepEqual(rows.map((t) => [t.idx, t.role, t.text]), [[0, "master", null], [1, "learner", "hola"], [2, "master", null], [3, "learner", "¿y?"], [4, "learner", "¿y ahora?"], [5, "master", null]]);
  // A reply the server stored but the browser dropped (Stop raced it): the
  // screen ends at the learner's words, so the next turn deletes it.
  const screen2 = after1(screen1, "¿y ahora?", r3).slice(0, -1);
  answer("NARRATOR-F: cuarta");
  await turn(sam, c.id, screen2, "otra vez");
  rows = await stored(c.id);
  assert.deepEqual(rows.map((t) => [t.idx, t.role, t.text]).slice(4), [[4, "learner", "¿y ahora?"], [5, "learner", "otra vez"], [6, "master", null]]);
  assert.equal(rows[6].lines[0].text, "cuarta");
  const [conv] = await q("select turn_count from conversations where id = $1", [c.id]);
  assert.equal(conv.turn_count, 7);
});

test("a conversation started mid-session (conversationStart) mirrors the screen from that entry on", async () => {
  const c = await start();
  const earlier = [{ role: "master", lines: [{ speaker: "narrator", gender: "female", text: "old", segments: [] }] }, { role: "learner", text: "before the break" }];
  const r = await turn(sam, c.id, earlier, "after the break", { conversationStart: 2 });
  assert.equal(r.body.saved, true);
  const rows = await stored(c.id);
  assert.deepEqual(rows.map((t) => [t.idx, t.role, t.text]), [[0, "learner", "after the break"], [1, "master", null]]);
});

test("a history that doesn't cover the stored turns (history: []) deletes nothing; the turn is appended", async () => {
  const c = await start();
  let screen = [];
  for (const msg of ["", "uno", "dos"]) {
    const r = await turn(sam, c.id, screen, msg);
    screen = after1(screen, msg, r);
  }
  assert.equal((await stored(c.id)).length, 5);
  const r = await turn(sam, c.id, [], "tres");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.saved, true);
  const rows = await stored(c.id);
  assert.deepEqual(rows.map((t) => [t.idx, t.role, t.text]).slice(4), [[4, "master", null], [5, "learner", "tres"], [6, "master", null]]);
  assert.deepEqual(rows.slice(0, 5).map((t) => t.duration_ms), [1234, null, 1234, null, 1234], "the five kept as they were");
  // A forged history can't rewrite them either: nothing of it is stored.
  const forged = [{ role: "master", lines: [{ speaker: "narrator", gender: "female", text: "I never said this", segments: [] }] }];
  await turn(sam, c.id, forged, "");
  const after = await stored(c.id);
  assert.equal(after.length, 8);
  assert.ok(!after.some((t) => t.lines?.[0]?.text === "I never said this"));
  assert.ok(after.every((t) => t.from_client === false), "every row is the server's reply or the learner's words");
});

test("master rows that come from the browser's history are marked from_client; the server's replies are not", async () => {
  // Saving resumed after two unsaved turns: the conversation starts where
  // saving stopped, and its first turn stores them from the screen.
  const loose0 = await turn(sam, null, [], "");
  const screen = after1([], "", loose0);
  const loose1 = await turn(sam, null, screen, "uno");
  const shown = after1(screen, "uno", loose1);
  const c = await start();
  const r = await turn(sam, c.id, shown, "dos", { conversationStart: 0 });
  assert.equal(r.body.saved, true);
  const rows = await stored(c.id);
  assert.deepEqual(rows.map((t) => [t.idx, t.role, t.from_client]), [[0, "master", true], [1, "learner", false], [2, "master", true], [3, "learner", false], [4, "master", false]]);
  assert.equal(rows[0].duration_ms, null, "a reply rewritten from the screen has no timing");
  assert.equal(rows[4].duration_ms, 1234);
});

test("a dojo master line with a \"|\" matches its own replay: the row is kept, pipe, timing and all", async () => {
  const c = await start();
  answer("NARRATOR-F: Uno | dos");
  const r0 = await turn(sam, c.id, [], "");
  assert.equal(r0.body.lines[0].text, "Uno | dos");
  answer(REPLY);
  const r1 = await turn(sam, c.id, after1([], "", r0), "tres");
  assert.equal(r1.body.saved, true);
  const rows = await stored(c.id);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].lines[0].text, "Uno | dos");
  assert.equal(rows[0].duration_ms, 1234);
  assert.equal(rows[0].from_client, false);
});

test("a history of HISTORY_MAX entries is taken whole; one more is a 413 before anything runs", async () => {
  const c = await start();
  const many = (n) => Array.from({ length: n }, (_, i) => ({ role: "learner", text: `l${i}` }));
  const ok = await turn(sam, c.id, many(2000), "fin", { conversationStart: 1995 });
  assert.equal(ok.status, 200, ok.text);
  const rows = await stored(c.id);
  assert.deepEqual(rows.map((t) => t.text).slice(0, 6), ["l1995", "l1996", "l1997", "l1998", "l1999", "fin"], "conversationStart indexes the history as sent");
  const before = runs();
  const tooLong = await turn(sam, c.id, many(2001), "fin", { conversationStart: 1995 });
  assert.equal(tooLong.status, 413);
  assert.equal(runs(), before);
  assert.equal((await stored(c.id)).length, 7, "nothing written");
});

test("History keeps the session's languages: a later profile change doesn't move its locales", async () => {
  await addUser(testDb.db, "lena", undefined, { learners: [{ ...ADULT, name: "Lu" }] });
  const lu = client(base);
  await lu.login("lena");
  await lu.pick("Lu");
  const own = await start(lu);
  const native = await start(lu, { pack: pack({ overrides: { native_language: "German" } }) });
  const moved = await start(lu, { pack: pack({ overrides: { target_language: "German" } }) });
  for (const c of [own, native, moved]) await turn(lu, c.id, [], "");
  await q("update learners set native_language = 'Spanish' where name = 'Lu'");
  await q("update language_profiles set target_language = 'English', target_variant = 'British English' where learner_id = (select id from learners where name = 'Lu')");
  const get = async (c) => (await lu.call("GET", `/api/conversations/${c.id}`)).body;
  assert.deepEqual([(await get(own)).locale, (await get(own)).nativeLocale], ["es-MX", "en-US"]);
  assert.deepEqual([(await get(native)).locale, (await get(native)).nativeLocale], ["es-MX", "de-DE"], "the pack's native language, not the profile's");
  assert.deepEqual([(await get(moved)).locale, (await get(moved)).nativeLocale], ["de-DE", "en-US"], "German with no variant: the profile's Mexican Spanish was dropped");
});

test("the lock is per conversation: two conversations proceed in parallel; one conversation's second turn is a 409", async () => {
  const a = await start();
  const b = await start();
  answer("NARRATOR-F: Hola.", 400);
  const [ra, rb] = await Promise.all([turn(sam, a.id, [], ""), turn(sam, b.id, [], "")]);
  assert.equal(ra.status, 200, ra.text);
  assert.equal(rb.status, 200, rb.text);
  // The same conversation from two tabs at once: one answers, one is refused.
  const before = runs();
  const [x, y] = await Promise.all([turn(sam, a.id, after1([], "", ra), "uno"), turn(tab(base, sam), a.id, after1([], "", ra), "dos")]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const locked = x.status === 409 ? x : y;
  assert.match(locked.body.error, /still answering/);
  assert.equal(locked.body.code, "turn_running");
  assert.equal(runs() - before, 1, "the refused turn never reached claude");
  const rows = await stored(a.id);
  assert.deepEqual(rows.map((t) => t.idx), [0, 1, 2], "gap-free, one turn's worth");
  // Another learner's conversation doesn't wait on this one (a second device).
  const ana = client(base);
  await ana.login("robin");
  await ana.pick("Ana");
  const c = await start(ana);
  // Someone else naming Sam's conversation while its turn runs is a 404
  // (the lock is per learner, so it says nothing about Sam's).
  answer("NARRATOR-F: Hola.", 300);
  const slow = turn(sam, b.id, after1([], "", rb), "uno");
  await new Promise((r) => setTimeout(r, 50));
  const nosy = await turn(ana, b.id, [], "", {});
  assert.equal(nosy.status, 404);
  assert.equal(nosy.body.code, "no_conversation");
  assert.equal((await slow).status, 200);
  answer(REPLY);
  const [r1, r2] = await Promise.all([turn(sam, a.id, after1(after1([], "", ra), rows[1].text, x.status === 200 ? x : y), "tres"), turn(ana, c.id, [], "")]);
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r2.status, 200, r2.text);
});

test("End is idempotent, calls the hook once, and a turn on an ended conversation is refused before anything runs", async () => {
  const c = await start();
  await turn(sam, c.id, [], "");
  const e1 = await sam.call("POST", `/api/conversations/${c.id}/end`);
  assert.equal(e1.status, 200, e1.text);
  assert.ok(e1.body.conversation.endedAt);
  const e2 = await sam.call("POST", `/api/conversations/${c.id}/end`);
  assert.equal(e2.status, 200);
  assert.equal(e2.body.conversation.endedAt, e1.body.conversation.endedAt, "the first end stands");
  assert.deepEqual(ends, [c.id], "the hook ran exactly once");
  const before = runs();
  const r = await turn(sam, c.id, [], "hola");
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "conversation_ended");
  assert.equal(runs(), before, "refused before claude");
  assert.equal((await stored(c.id)).length, 1);
  assert.equal((await sam.call("GET", `/api/conversations/${c.id}/end`)).status, 405);
});

test("End waits for the turn on its way, which is stored in the conversation it belongs to", async () => {
  const c = await start();
  answer("NARRATOR-F: despacio", 400);
  const pending = turn(sam, c.id, [], "");
  await new Promise((r) => setTimeout(r, 100));
  const e = await sam.call("POST", `/api/conversations/${c.id}/end`);
  const r = await pending;
  assert.equal(r.body.saved, true);
  assert.equal(e.status, 200);
  assert.equal(e.body.conversation.turnCount, 1);
  assert.ok(e.body.conversation.endedAt);
});

/** End and a turn sent at the same moment, `n` times, each on a fresh
 *  conversation: whichever the server takes first, the turn is either stored
 *  in it (End waited) or refused with conversation_ended before anything ran
 *  — never answered and then left unsaved. PGlite runs one transaction at a
 *  time, so End mostly wins here; conversations.pg.test.mjs races it on a
 *  real Postgres. */
async function endTurnRace(n) {
  const outcomes = { stored: 0, refused: 0 };
  for (let i = 0; i < n; i++) {
    const c = await start();
    const before = runs();
    const [e, r] = await Promise.all([sam.call("POST", `/api/conversations/${c.id}/end`), turn(sam, c.id, [], "")]);
    assert.equal(e.status, 200, e.text);
    assert.ok(e.body.conversation.endedAt);
    const rows = await stored(c.id);
    if (r.status === 200) {
      assert.equal(r.body.saved, true, `trial ${i}: a turn that ran is stored`);
      assert.equal(rows.length, 1);
      assert.equal(e.body.conversation.turnCount, 1, "End's reply already counts it");
      outcomes.stored++;
    } else {
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.code, "conversation_ended");
      assert.equal(runs(), before, `trial ${i}: refused before claude`);
      assert.equal(rows.length, 0);
      outcomes.refused++;
    }
  }
  return outcomes;
}

test("End and a turn at the same moment: the turn is stored or refused before running, never answered unsaved", async (t) => {
  const outcomes = await endTurnRace(20);
  t.diagnostic(`outcomes: ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.stored + outcomes.refused, 20);
});

test("End holding the conversation refuses a turn with conversation_ended; the turn's own 404/409 release the lock", async () => {
  const c = await start();
  await turn(sam, c.id, [], "");
  // A turn refused by its own checks (here: a stranger's id first, then an
  // ended conversation) leaves no lock behind for the next one.
  const ghost = "00000000-0000-4000-8000-000000000000";
  assert.equal((await turn(sam, ghost, [], "")).status, 404);
  assert.equal((await turn(sam, ghost, [], "")).status, 404, "not the lock's 409");
  await sam.call("POST", `/api/conversations/${c.id}/end`);
  assert.equal((await turn(sam, c.id, [], "")).body.code, "conversation_ended");
  assert.equal((await turn(sam, c.id, [], "")).body.code, "conversation_ended", "still the conversation's answer, not the lock's");
});

test("an idle end never ends a conversation whose turn is running; the turn is stored and the hook isn't called", async () => {
  const c = await start();
  await turn(sam, c.id, [], "");
  // An hour and 59 minutes idle, then a slow turn; while the dojo master
  // answers, another request comes after the two hours have passed.
  await q("update conversations set started_at = now() - interval '3 hours' where id = $1", [c.id]);
  await q("update turns set created_at = now() - interval '119 minutes' where conversation_id = $1", [c.id]);
  answer("NARRATOR-F: despacio", 400);
  const pending = turn(sam, c.id, after1([], "", { body: { lines: (await stored(c.id))[0].lines } }), "hola");
  await new Promise((r) => setTimeout(r, 150));
  await q("update turns set created_at = now() - interval '150 minutes' where conversation_id = $1", [c.id]);
  const list = await sam.call("GET", "/api/conversations?limit=100");
  assert.equal(list.body.conversations.find((x) => x.id === c.id).endedAt, null, "skipped while its turn runs");
  const r = await pending;
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.saved, true);
  assert.ok(!ends.includes(c.id), "no hook for a conversation still going");
  assert.equal((await stored(c.id)).length, 3);
});

test("paging with huge offsets and froms is an empty page, never a 500", async () => {
  const c = await start();
  for (const v of ["100000000000000000000", "9223372036854775808", "3000000000"]) {
    const l = await sam.call("GET", `/api/conversations?offset=${v}`);
    assert.equal(l.status, 200, `${v}: ${l.text}`);
    assert.deepEqual(l.body.conversations, []);
    const g = await sam.call("GET", `/api/conversations/${c.id}?from=${v}`);
    assert.equal(g.status, 200, `${v}: ${g.text}`);
    assert.deepEqual(g.body.turns, []);
  }
});

test("a conversation idle for two hours is ended by the next request that touches the learner's conversations, at its last turn", async () => {
  const idle = await start();
  await turn(sam, idle.id, [], "");
  const fresh = await start();
  const empty = await start();
  await q("update conversations set started_at = now() - interval '3 hours' where id = $1", [idle.id]);
  await q("update turns set created_at = now() - interval '150 minutes' where conversation_id = $1", [idle.id]);
  await q("update conversations set started_at = now() - interval '61 minutes' where id = $1", [fresh.id]);
  await q("update conversations set started_at = now() - interval '121 minutes' where id = $1", [empty.id]);
  const list = await sam.call("GET", "/api/conversations?limit=100");
  const byId = Object.fromEntries(list.body.conversations.map((c) => [c.id, c]));
  assert.equal(byId[idle.id].endedAt, byId[idle.id].lastTurnAt, "ended at its last turn, not now");
  assert.equal(byId[empty.id].endedAt, byId[empty.id].startedAt, "no turns: ended at its start");
  assert.equal(byId[fresh.id].endedAt, null, "an hour idle stays open");
  assert.deepEqual(ends.sort(), [idle.id, empty.id].sort(), "the hook, once each");
  await sam.call("GET", "/api/conversations");
  assert.equal(ends.length, 2, "not again");
  // The turn route ends idle ones too, and then refuses them.
  await q("update conversations set started_at = now() - interval '3 hours' where id = $1", [fresh.id]);
  const r = await turn(sam, fresh.id, [], "");
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "conversation_ended");
  assert.ok(ends.includes(fresh.id));
});

test("History lists the learner's conversations newest first, paged; a conversation's turns page too", async () => {
  // A learner of its own, so no other test's conversations are in the list.
  await addUser(testDb.db, "zoe", undefined, { learners: [{ ...ADULT, name: "Zed" }] });
  const ana = client(base);
  await ana.login("zoe");
  await ana.pick("Zed");
  const made = [];
  for (let i = 0; i < 5; i++) {
    const c = await start(ana, { title: `Session ${i}` });
    await q("update conversations set started_at = now() - make_interval(mins => $2) where id = $1", [c.id, 50 - i]);
    made.push(c.id);
  }
  const p1 = await ana.call("GET", "/api/conversations?limit=2");
  assert.equal(p1.status, 200, p1.text);
  assert.deepEqual(p1.body.conversations.map((c) => c.title), ["Session 4", "Session 3"]);
  assert.equal(p1.body.nextOffset, 2);
  const p2 = await ana.call("GET", "/api/conversations?limit=2&offset=2");
  assert.deepEqual(p2.body.conversations.map((c) => c.title), ["Session 2", "Session 1"]);
  const p3 = await ana.call("GET", "/api/conversations?limit=2&offset=4");
  assert.deepEqual(p3.body.conversations.map((c) => c.title), ["Session 0"]);
  assert.equal(p3.body.nextOffset, null);
  // Turns of one conversation, two at a time.
  const id = made[4];
  let screen = [];
  for (const msg of ["", "uno", "dos"]) {
    const r = await turn(ana, id, screen, msg);
    screen = after1(screen, msg, r);
  }
  const t1 = await ana.call("GET", `/api/conversations/${id}?limit=2`);
  assert.deepEqual(t1.body.turns.map((t) => t.idx), [0, 1]);
  assert.equal(t1.body.nextFrom, 2);
  const t2 = await ana.call("GET", `/api/conversations/${id}?from=2&limit=2`);
  assert.deepEqual(t2.body.turns.map((t) => t.idx), [2, 3]);
  const t3 = await ana.call("GET", `/api/conversations/${id}?from=4&limit=2`);
  assert.deepEqual(t3.body.turns.map((t) => t.idx), [4]);
  assert.equal(t3.body.nextFrom, null);
});

test("DELETE removes a conversation and its turns; then it is a 404", async () => {
  const c = await start();
  await turn(sam, c.id, [], "");
  const d = await sam.call("DELETE", `/api/conversations/${c.id}`);
  assert.equal(d.status, 200, d.text);
  assert.deepEqual(d.body, { deleted: true });
  assert.equal((await q("select count(*)::int as n from turns where conversation_id = $1", [c.id]))[0].n, 0);
  assert.equal((await sam.call("GET", `/api/conversations/${c.id}`)).status, 404);
  assert.equal((await sam.call("DELETE", `/api/conversations/${c.id}`)).status, 404);
  const r = await turn(sam, c.id, [], "");
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "no_conversation");
  assert.deepEqual(ends, [], "deleting an open conversation is not ending it: the hook isn't called");
});

test("every conversation route answers 409 stale_learner to a page showing another learner", async () => {
  const c = await start();
  const other = tab(base, sam);
  try {
    await other.pick("Ana");
    for (const [method, url, body] of [
      ["GET", "/api/conversations"],
      ["POST", "/api/conversations", { mode: "adult", pack: pack() }],
      ["GET", `/api/conversations/${c.id}`],
      ["POST", `/api/conversations/${c.id}/end`],
      ["DELETE", `/api/conversations/${c.id}`],
    ]) {
      const r = await sam.call(method, url, body);
      assert.equal(r.status, 409, `${method} ${url}`);
      assert.equal(r.body.code, "stale_learner", `${method} ${url}`);
    }
    const [row] = await q("select ended_at from conversations where id = $1", [c.id]);
    assert.equal(row.ended_at, null, "the stale End changed nothing");
  } finally {
    await sam.pick("Sam");
  }
});

test("another learner or user can never read, append to, end or delete a conversation, guessed id or not", async () => {
  const c = await start();
  await turn(sam, c.id, [], "");
  await addUser(testDb.db, "mallory", undefined, { learners: [{ ...ADULT, name: "Mo" }] });
  const mo = client(base);
  await mo.login("mallory");
  await mo.pick("Mo");
  // The same account's other learner (Pip, kids) is a stranger to it too.
  const pip = client(base);
  await pip.login("robin");
  await pip.pick("Pip");
  for (const [who, mode] of [[mo, "adult"], [pip, "kids"]]) {
    const list = await who.call("GET", "/api/conversations");
    assert.equal(list.status, 200);
    assert.ok(!list.body.conversations.some((x) => x.id === c.id));
    for (const [method, url] of [["GET", `/api/conversations/${c.id}`], ["POST", `/api/conversations/${c.id}/end`], ["DELETE", `/api/conversations/${c.id}`]]) {
      const r = await who.call(method, url);
      assert.equal(r.status, 404, `${method} ${url}`);
      assert.equal(r.body.code, "no_conversation");
    }
    const before = runs();
    const r = await who.call("POST", "/api/voice/turn", { mode, pack: pack(), history: [], message: "x", conversationId: c.id });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "no_conversation");
    assert.equal(runs(), before);
  }
  // Ids that aren't uuids are nobody's, never a database error.
  for (const id of ["nope", "1%20or%201%3D1", "00000000-0000-0000-0000-000000000000"]) {
    assert.equal((await sam.call("GET", `/api/conversations/${id}`)).status, 404);
  }
  assert.equal((await turn(sam, "nope", [], "")).body.code, "no_conversation");
  assert.equal((await sam.call("GET", `/api/conversations/${c.id}/turns`)).status, 404);
  // Untouched, still Sam's.
  const rows = await stored(c.id);
  assert.equal(rows.length, 1);
  const [row] = await q("select ended_at from conversations where id = $1", [c.id]);
  assert.equal(row.ended_at, null);
});

test("one learner's two languages: each has its own History; a conversation is a 404 on every route, the voice turn included, from the other language", async () => {
  await addUser(testDb.db, "kai", undefined, { learners: [{ ...ADULT, name: "Kim" }] });
  const kim = client(base);
  await kim.login("kai");
  await kim.pick("Kim");
  const spanish = await start(kim, { title: "Mercado" });
  await turn(kim, spanish.id, [], "");
  const spanishId = kim.languageId;
  const german = await kim.addLanguage({ target_language: "German", target_variant: "", level: "B1" });
  assert.notEqual(german.id, spanishId);
  // German: an empty History, and Spanish's conversation is nobody's here.
  assert.deepEqual((await kim.call("GET", "/api/conversations")).body.conversations, []);
  for (const [method, url] of [["GET", `/api/conversations/${spanish.id}`], ["POST", `/api/conversations/${spanish.id}/end`], ["DELETE", `/api/conversations/${spanish.id}`]]) {
    const r = await kim.call(method, url);
    assert.equal(r.status, 404, `${method} ${url}`);
    assert.equal(r.body.code, "no_conversation");
  }
  const before = runs();
  const r = await turn(kim, spanish.id, [], "hallo");
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "no_conversation");
  assert.equal(runs(), before, "nothing ran");
  // A German conversation is stored under German, with German's locale.
  const de = await start(kim, { title: "Bäckerei" });
  const t = await turn(kim, de.id, [], "");
  assert.equal(t.status, 200, t.text);
  const [row] = await q("select language_profile_id from conversations where id = $1", [de.id]);
  assert.equal(row.language_profile_id, german.id);
  assert.equal((await kim.call("GET", `/api/conversations/${de.id}`)).body.locale, "de-DE");
  assert.deepEqual((await kim.call("GET", "/api/conversations")).body.conversations.map((c) => c.title), ["Bäckerei"]);
  // Back to Spanish: its own History, untouched.
  await kim.pickLanguage(spanishId);
  assert.deepEqual((await kim.call("GET", "/api/conversations")).body.conversations.map((c) => c.title), ["Mercado"]);
  assert.equal((await stored(spanish.id)).length, 1, "still its one turn");
  const [sp] = await q("select ended_at from conversations where id = $1", [spanish.id]);
  assert.equal(sp.ended_at, null, "German's End changed nothing");
});

test("a tab showing the learner's other language gets 409 stale_learner on every conversation route and the voice turn", async () => {
  await addUser(testDb.db, "noa", undefined, { learners: [{ ...ADULT, name: "Nell" }] });
  const page = client(base);
  await page.login("noa");
  await page.pick("Nell");
  const c = await start(page);
  const other = tab(base, page);
  await other.addLanguage({ target_language: "Mandarin Chinese", level: "A1" });
  for (const [method, url, body] of [
    ["GET", "/api/conversations"],
    ["POST", "/api/conversations", { mode: "adult", pack: pack() }],
    ["GET", `/api/conversations/${c.id}`],
    ["POST", `/api/conversations/${c.id}/end`],
    ["DELETE", `/api/conversations/${c.id}`],
  ]) {
    const r = await page.call(method, url, body);
    assert.equal(r.status, 409, `${method} ${url}`);
    assert.equal(r.body.code, "stale_learner", `${method} ${url}`);
  }
  const before = runs();
  const r = await turn(page, c.id, [], "hola");
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "stale_learner");
  assert.equal(runs(), before);
  assert.equal((await stored(c.id)).length, 0);
  // The page that switched works.
  assert.equal((await other.call("GET", "/api/conversations")).status, 200);
});

test("the idle end covers every language and learner of the account: a German session left open ends (hook and all) on a request in Chinese, or as another learner", async () => {
  await addUser(testDb.db, "ira", undefined, { learners: [{ ...ADULT, name: "Ines" }, { ...ADULT, name: "Ivo" }] });
  const ines = client(base);
  await ines.login("ira");
  await ines.pick("Ines");
  const spanish = await start(ines, { title: "Left open" });
  await turn(ines, spanish.id, [], "");
  await q("update conversations set started_at = now() - interval '3 hours' where id = $1", [spanish.id]);
  await q("update turns set created_at = now() - interval '150 minutes' where conversation_id = $1", [spanish.id]);
  // The page switched language with the session open (its End lost).
  await ines.addLanguage({ target_language: "Mandarin Chinese", level: "A1" });
  assert.deepEqual((await ines.call("GET", "/api/conversations")).body.conversations, [], "Chinese has its own History");
  assert.deepEqual(ends, [spanish.id], "ended by a request in another language, hook called once");
  const [row] = await q("select ended_at, (select max(created_at) from turns where conversation_id = $1) as last from conversations where id = $1", [spanish.id]);
  assert.equal(new Date(row.ended_at).getTime(), new Date(row.last).getTime(), "at its last turn");

  // Another learner of the account: the same.
  const other = await start(ines, { title: "Chinese, left open" });
  await q("update conversations set started_at = now() - interval '3 hours' where id = $1", [other.id]);
  await ines.pick("Ivo");
  await ines.call("GET", "/api/conversations");
  assert.deepEqual(ends, [spanish.id, other.id]);
  // Another account's requests never end this account's (or reveal them).
  const mine = await start(ines);
  await q("update conversations set started_at = now() - interval '3 hours' where id = $1", [mine.id]);
  await sam.call("GET", "/api/conversations");
  assert.ok(!ends.includes(mine.id), "robin's request doesn't touch ira's conversations");
});
