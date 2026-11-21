// Revisit end to end over HTTP (docs/DATA.md §Revisit; web/server/revisit.ts,
// conversations.ts, voice.ts, extraction.ts): a scene played again builds on
// its last attempt with a finished recap (Practice again: the one pressed),
// carrying its kept phrases into the review, a briefing into the turn's
// prompt (adults) and a comparison into the new recap; History lists by
// scene; the overview counts the week and writes the digest once a day.
// On the real plugin with an in-process PGlite and a stand-in `claude` first
// on PATH. Every name here is made up.
//   node --test scripts/tests/revisit.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture, write } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

// The recall slot and its units, in the fixture copy only (as in
// recall.http.test.mjs): a backfilled slot, so a pack with no entry for it
// plays the default unit and its review block.
const recallSlot = (title) => `  - id: recall\n    title: ${title}\n    pick: one\n    required: false\n    backfill: true\n    description: Bank phrases to revisit.\n`;
fs.appendFileSync(path.join(root, "schema.yaml"), recallSlot("Phrases to revisit"));
fs.appendFileSync(path.join(root, "kids/schema.yaml"), recallSlot("Words to bring back"));
write(root, "units/recycle-due-phrases.md", "---\nid: recycle-due-phrases\nslot: recall\ntitle: Recycle due phrases\nsummary: Bring them back.\ndefault: true\n---\nWork these back into the scene.\n\n{{phrase_review}}\n");
write(root, "kids/units/recycle-words.md", "---\nid: recycle-words\nslot: recall\ntitle: Bring back old words\nsummary: By ear.\ndefault: true\n---\nSay these again in the story.\n\n{{phrase_review}}\n");

write(root, "units/intro-live-closing.md", "---\nid: intro-live-closing\nslot: intro\ntitle: Live closing\nsummary: s\nclosing: Say only the live rule.\n---\nOpen.\n");

const { apiPlugins } = await import("../../web/server/api.ts");
const { settleExtractions } = await import("../../web/server/extraction.ts");
const { lostPrevious, settleDigests } = await import("../../web/server/revisit.ts");

const fake = fakeClaude();
const REPLY = "NARRATOR-F: Bienvenido al <t>mercado</t>.\nGLOSS: mercado = market\nSTAGE: scene";

/** The first attempt's recap: two kept phrases, a correction, and the
 *  learner got "¿Qué le doy?" wrong. */
const FIRST = {
  summary: "You bought mangoes; asking what to give was hard.",
  keep: [
    { text: "¿Qué le doy?", meaning: "What can I get you?", example: "", why: "the vendor's question" },
    { text: "Quédese con la vuelta", meaning: "Keep the change", example: "", why: "paying" },
  ],
  events: [
    { phrase: "¿Qué le doy?", kind: "corrected", said: "qué doy" },
    { phrase: "mercado", kind: "produced" },
  ],
  corrections: [
    { said: "Unos mangos", better: "Unos mangos, por favor", note: "say please" },
    { said: "Yo quiero pagar", better: "¿Cuánto le debo?", note: "more natural" },
  ],
};
/** The second attempt's: the first correction fixed, the phrase now said
 *  unaided, "mercado" with a hint this time. */
const SECOND = {
  summary: "Much smoother.",
  keep: [],
  events: [
    { phrase: "¿Qué le doy?", kind: "produced" },
    { phrase: "mercado", kind: "produced_with_help" },
  ],
  corrections: [],
  last_time: [{ n: 1, result: "fixed" }, { n: 2, result: "repeated" }, { n: 9, result: "fixed" }],
};

const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  await settleExtractions();
  await settleDigests();
  fake.restore();
  await close();
  await testDb.close();
});
beforeEach(() => {
  fake.answer(REPLY);
  fake.recap(JSON.stringify(FIRST));
});

const pack = (extra = {}) => ({ title: "", created: "", scenario: "", quick_scenario: "", units: [], overrides: {}, notes: "", ...extra });
const market = () => pack({ scenario: "market" });

let n = 0;
async function someone(learners = [ADULT]) {
  const name = `rv${++n}`;
  await addUser(testDb.db, name, undefined, { learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  return c;
}

/** Start a conversation (201), returning its summary. */
async function start(who, { p = market(), mode = "adult", previous } = {}) {
  const r = await who.call("POST", "/api/conversations", { mode, pack: p, title: "Session", ...(previous ? { previous } : {}) });
  assert.equal(r.status, 201, r.text);
  return r.body.conversation;
}

/** One opening turn and one answer, then End, the recap awaited. */
async function play(who, c, { p = market(), mode = "adult", end = true } = {}) {
  const t0 = await who.call("POST", "/api/voice/turn", { mode, pack: p, history: [], message: "", elapsedMs: 0, conversationId: c.id });
  assert.equal(t0.status, 200, t0.text);
  const history = [{ role: "master", lines: t0.body.lines, glosses: t0.body.glosses }];
  const t1 = await who.call("POST", "/api/voice/turn", { mode, pack: p, history, message: "Unos mangos.", elapsedMs: 0, conversationId: c.id });
  assert.equal(t1.status, 200, t1.text);
  if (end) {
    assert.equal((await who.call("POST", `/api/conversations/${c.id}/end`)).status, 200);
    await settleExtractions();
  }
  return c;
}

const session = async (who, opts = {}) => play(who, await start(who, opts), opts);
const snapshot = async (id) => (await q(`select pack_snapshot from conversations where id = $1`, [id]))[0].pack_snapshot;
/** The system prompt of the last voice turn (fake-claude's argv). */
const lastSystem = () => {
  const args = fake.lastArgs();
  return args[args.indexOf("--append-system-prompt") + 1];
};
const recapOf = async (who, id) => (await who.call("GET", `/api/conversations/${id}/recap`)).body.recap;

test("a scene played again builds on its last attempt: kept phrases first in the review, a briefing in the prompt, a comparison in the recap", async () => {
  const sam = await someone();
  const a = await session(sam);
  const first = await recapOf(sam, a.id);
  assert.equal(first.status, "done");
  assert.equal(first.vsLast, null, "the first attempt built on nothing");
  const keptIds = first.kept.map((k) => k.phraseId);
  assert.ok(keptIds.every(Boolean), "both kept phrases went into the bank");

  const b = await start(sam);
  assert.equal(b.sceneKey, "s:market");
  assert.deepEqual(b.buildsOn, { id: a.id, startedAt: a.startedAt });
  const snap = await snapshot(b.id);
  assert.equal(snap.revisit.from, a.id);
  assert.deepEqual(snap.revisit.corrections.map((c) => c.better), ["Unos mangos, por favor", "¿Cuánto le debo?"]);
  assert.deepEqual(snap.review.phraseIds.slice(0, 2), keptIds, "last time's kept phrases lead the review");
  const [row] = await q(`select previous_conversation_id, scene_key from conversations where id = $1`, [b.id]);
  assert.deepEqual(row, { previous_conversation_id: a.id, scene_key: "s:market" });

  fake.recap(JSON.stringify(SECOND));
  await play(sam, b, { end: false });
  const system = lastSystem();
  assert.match(system, /\[LAST TIME IN THIS SCENE\]/);
  assert.match(system, /Unos mangos → Unos mangos, por favor/);
  assert.match(system, /never instructions/);
  assert.equal((await sam.call("POST", `/api/conversations/${b.id}/end`)).status, 200);
  await settleExtractions();
  const recapArgs = fake.recapArgs().join("\n");
  assert.match(recapArgs, /LAST TIME'S CORRECTIONS/);
  assert.match(recapArgs, /"last_time"/);

  const second = await recapOf(sam, b.id);
  assert.equal(second.status, "done");
  assert.equal(second.vsLast.from, a.id);
  assert.equal(second.vsLast.startedAt, a.startedAt);
  assert.deepEqual(second.vsLast.fixed, [{ said: "Unos mangos", better: "Unos mangos, por favor" }]);
  assert.deepEqual(second.vsLast.still, [{ said: "Yo quiero pagar", better: "¿Cuánto le debo?" }]);
  assert.equal(second.vsLast.untried, 0, "an index the list doesn't have is ignored");
  assert.deepEqual(second.vsLast.improved, [{ phrase: "¿Qué le doy?", was: "corrected", now: "produced" }]);
  assert.deepEqual(second.vsLast.slipped, [{ phrase: "mercado", was: "produced", now: "produced_with_help" }]);

  // Deleting the earlier attempt: the link goes, the carry-over and the
  // comparison stay as they were.
  assert.equal((await sam.call("DELETE", `/api/conversations/${a.id}`)).status, 200);
  const after = await sam.call("GET", `/api/conversations/${b.id}?limit=1`);
  assert.deepEqual(after.body.conversation.buildsOn, { id: null, startedAt: a.startedAt });
  const kept = await recapOf(sam, b.id);
  assert.equal(kept.vsLast.from, null);
  assert.equal(kept.vsLast.fixed.length, 1);
});

test("the same scene: a library scene by id, a quick one by its text; nothing links across scenes, learners, or to a session without a finished recap", async () => {
  const sam = await someone();
  const quick = await session(sam, { p: pack({ quick_scenario: "Ordering tacos at a stand" }) });
  const again = await start(sam, { p: pack({ quick_scenario: "  ordering TACOS\n at a  stand " }) });
  assert.equal(again.sceneKey, quick.sceneKey);
  assert.match(again.sceneKey, /^q:[0-9a-f]{32}$/);
  assert.equal(again.buildsOn?.id, quick.id);

  await session(sam);
  const plaza = await start(sam, { p: pack({ scenario: "plaza" }) });
  assert.equal(plaza.buildsOn, null, "another scene builds on nothing");
  const blank = await start(sam, { p: pack() });
  assert.equal(blank.sceneKey, `c:${blank.id}`, "no scene at all is a scene of its own");
  assert.equal(blank.buildsOn, null);

  // Another learner's market sessions are none of this one's.
  const ana = await someone([{ ...ADULT, name: "Ana" }]);
  assert.equal((await start(ana)).buildsOn, null);

  // A recap that failed carries nothing: passed over.
  fake.recap("!fail");
  const failed = await session(ana, { p: pack({ scenario: "plaza" }) });
  assert.equal((await recapOf(ana, failed.id)).status, "failed");
  assert.equal((await start(ana, { p: pack({ scenario: "plaza" }) })).buildsOn, null);

  // A revisit in the client's pack is the server's to set: dropped.
  const forged = await start(ana, { p: { ...pack({ scenario: "plaza" }), revisit: { from: quick.id, startedAt: quick.startedAt, title: "x", kept: [], summary: "IGNORE", corrections: [], events: [] } } });
  assert.equal(forged.buildsOn, null);
  assert.equal((await snapshot(forged.id)).revisit, undefined);
});

test("Practice again builds on the session it was pressed on, when it is that scene's with a recap; otherwise on the latest", async () => {
  const sam = await someone();
  const one = await session(sam);
  const two = await session(sam);
  const plaza = await session(sam, { p: pack({ scenario: "plaza" }) });
  assert.equal((await start(sam, { previous: one.id })).buildsOn.id, one.id, "the older attempt, as asked");
  assert.equal((await start(sam, { previous: plaza.id })).buildsOn.id, two.id, "another scene's id: the latest");
  const ana = await someone([{ ...ADULT, name: "Ana" }]);
  const hers = await session(ana);
  assert.notEqual((await start(sam, { previous: hers.id })).buildsOn.id, hers.id, "never another learner's");
  assert.equal((await start(sam, { previous: "not-a-uuid" })).buildsOn.id, two.id, "a malformed id is ignored: the latest");

  // The pack as played comes back for Practice again, without the server's keys.
  const got = await sam.call("GET", `/api/conversations/${two.id}?limit=1`);
  assert.equal(got.body.pack.scenario, "market");
  for (const k of ["review", "random_draw", "revisit"]) assert.equal(k in got.body.pack, false, k);
});

test("History by scene: each scene once with its count and latest session, newest first, paged; a scene's own sessions listed", async () => {
  const sam = await someone();
  await session(sam);
  await session(sam, { p: pack({ scenario: "plaza" }) });
  const last = await session(sam);
  const r = await sam.call("GET", "/api/conversations/scenes");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.scenes.map((g) => [g.sceneKey, g.attempts]), [["s:market", 2], ["s:plaza", 1]]);
  assert.equal(r.body.scenes[0].latest.id, last.id);
  assert.equal(r.body.nextOffset, null);
  const page = await sam.call("GET", "/api/conversations/scenes?limit=1");
  assert.equal(page.body.scenes.length, 1);
  assert.equal(page.body.nextOffset, 1);
  const one = await sam.call("GET", `/api/conversations?scene=${encodeURIComponent("s:market")}`);
  assert.equal(one.body.conversations.length, 2);
  assert.ok(one.body.conversations.every((c) => c.sceneKey === "s:market"));
  assert.equal((await sam.call("GET", "/api/conversations?scene=")).status, 400);
  assert.equal((await sam.call("POST", "/api/conversations/scenes")).status, 405);
  // Another learner sees none of it.
  const ana = await someone([{ ...ADULT, name: "Ana" }]);
  assert.deepEqual((await ana.call("GET", "/api/conversations/scenes")).body.scenes, []);
});

test("the overview counts the last 7 days and writes the digest once a day per language", async () => {
  const sam = await someone();
  const empty = await sam.call("GET", "/api/conversations/overview");
  assert.equal(empty.status, 200, empty.text);
  assert.equal(empty.body.stats.sessions, 0);
  assert.equal(empty.body.digest.text, null);
  await settleDigests();
  assert.equal(fake.digestRuns(), 0, "nothing to write about: no call");

  await session(sam);
  await session(sam, { p: pack({ scenario: "plaza" }) });
  const runs = fake.digestRuns();
  const first = await sam.call("GET", "/api/conversations/overview");
  assert.equal(first.body.stats.sessions, 2);
  assert.equal(first.body.stats.scenes, 2);
  assert.equal(first.body.stats.kept, 4);
  assert.deepEqual(first.body.stats.recurring.map((r) => [r.better, r.count]), [["Unos mangos, por favor", 2], ["¿Cuánto le debo?", 2]]);
  await settleDigests();
  assert.equal(fake.digestRuns(), runs + 1);
  const digestArgs = fake.digestArgs().join("\n");
  assert.match(digestArgs, /<recaps>/);
  assert.match(digestArgs, /Unos mangos, por favor/);

  const written = await sam.call("GET", "/api/conversations/overview");
  assert.equal(written.body.digest.text, "You practised a lot this week.");
  assert.equal(written.body.digest.status, "current");
  assert.equal(written.body.digest.sessions, 2);

  // A newer session the same day: stale, and no second call today.
  await session(sam);
  const stale = await sam.call("GET", "/api/conversations/overview");
  await settleDigests();
  assert.equal(stale.body.digest.status, "stale");
  assert.equal(fake.digestRuns(), runs + 1);
  assert.equal(stale.body.stats.sessions, 3);
});

test("a digest call that fails counts for the day, and says so", async () => {
  const sam = await someone();
  await session(sam);
  fake.digest("!fail");
  try {
    await sam.call("GET", "/api/conversations/overview");
    await settleDigests();
    const r = await sam.call("GET", "/api/conversations/overview");
    assert.equal(r.body.digest.status, "failed");
    assert.equal(r.body.digest.text, null);
    const runs = fake.digestRuns();
    await sam.call("GET", "/api/conversations/overview");
    await settleDigests();
    assert.equal(fake.digestRuns(), runs, "tried once a day");
  } finally {
    fake.digest(JSON.stringify({ digest: "You practised a lot this week." }));
  }
});

test("kids: the kept words come back, with no briefing, no comparison and no overview", async () => {
  const pip = await someone([KID]);
  const farm = pack({ scenario: "farm" });
  fake.recap(JSON.stringify({ summary: "You met a cow!", keep: [{ text: "die Kuh", meaning: "the cow", example: "", why: "" }], events: [{ phrase: "die Kuh", kind: "corrected", said: "Kuh" }], corrections: [{ said: "Kuh", better: "die Kuh", note: "" }] }));
  const one = await session(pip, { p: farm, mode: "kids" });
  const kept = (await recapOf(pip, one.id)).kept[0].phraseId;
  assert.ok(kept);
  const two = await start(pip, { p: farm, mode: "kids" });
  assert.equal(two.buildsOn.id, one.id);
  const snap = await snapshot(two.id);
  assert.equal("corrections" in snap.revisit, false, "a child carries words only");
  assert.equal(snap.review.phraseIds[0], kept);
  fake.recap(JSON.stringify({ summary: "Yay!", keep: [], events: [{ phrase: "die Kuh", kind: "produced" }], corrections: [], last_time: [{ n: 1, result: "fixed" }] }));
  await play(pip, two, { p: farm, mode: "kids" });
  assert.doesNotMatch(lastSystem(), /LAST TIME IN THIS SCENE/);
  assert.doesNotMatch(fake.recapArgs().join("\n"), /LAST TIME'S CORRECTIONS/);
  assert.equal((await recapOf(pip, two.id)).vsLast, null);
  assert.deepEqual((await pip.call("GET", "/api/conversations/overview")).body, { stats: null, digest: null });
  assert.equal((await pip.call("GET", "/api/conversations/scenes")).body.scenes[0].attempts, 2, "kids get History by scene");
});

test("a pack that moves the target language builds on no attempt in another language", async () => {
  const sam = await someone();
  await session(sam);
  const french = await start(sam, { p: pack({ scenario: "market", overrides: { target_language: "French" } }) });
  assert.equal(french.sceneKey, "s:market", "still the same scene in History");
  assert.equal(french.buildsOn, null, "but not a retry of the Spanish one");
  assert.equal((await start(sam)).buildsOn !== null, true, "the Spanish one still links");
});

test("lostPrevious tells the earlier attempt's delete racing a create from any other error", () => {
  const fk = Object.assign(new Error("insert failed"), { cause: Object.assign(new Error("fk"), { code: "23503", constraint: "conversations_previous_fk" }) });
  assert.equal(lostPrevious(fk), true);
  assert.equal(lostPrevious(Object.assign(new Error("x"), { code: "23503", constraint: "conversations_language_profile_fk" })), false);
  assert.equal(lostPrevious(new Error("boom")), false);
});

test("a recap that lands late (a Retry) makes the digest stale, whenever its session started", async () => {
  const sam = await someone();
  fake.recap("!fail");
  const early = await session(sam);
  fake.recap(JSON.stringify(FIRST));
  await session(sam, { p: pack({ scenario: "plaza" }) });
  await sam.call("GET", "/api/conversations/overview");
  await settleDigests();
  assert.equal((await sam.call("GET", "/api/conversations/overview")).body.digest.status, "current");
  assert.equal((await sam.call("POST", `/api/conversations/${early.id}/recap`)).status, 202);
  await settleExtractions();
  assert.equal((await recapOf(sam, early.id)).status, "done");
  assert.equal((await sam.call("GET", "/api/conversations/overview")).body.digest.status, "stale");
});

test("a closing is the very last thing in the live system prompt, after a revisit's briefing, once", async () => {
  const sam = await someone();
  await session(sam);
  const p = pack({ scenario: "market", units: ["intro-live-closing"] });
  const b = await start(sam, { p });
  await play(sam, b, { p, end: false });
  const system = lastSystem();
  assert.match(system, /\[LAST TIME IN THIS SCENE\]/);
  assert.ok(system.trimEnd().endsWith("Say only the live rule."), system.slice(-300));
  assert.ok(system.indexOf("[END OF LAST TIME]") < system.indexOf("## Final rules"), "after the briefing");
  assert.equal(system.split("Say only the live rule.").length, 2, "once");
});
