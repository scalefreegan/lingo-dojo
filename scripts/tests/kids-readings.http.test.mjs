// Resolving a kids learner's uncertain readings (ld-0mn, docs/VOICE.md
// §Kids: marks and resolving, docs/DATA.md §Kids: resolving uncertain
// readings): during a kids Mandarin session the dojo master's uncertain
// words go to one background model call per batch (never the child's
// words), each answer checked like a recap's and stored as the learner's
// own settled reading, with no shared vote, under a daily cap counted from
// a ledger written as each call starts; the voice says the settled reading
// from then on. A kids word still uncertain stays out of the picture game,
// listed for the grown-up, until it is settled. The real plugin on an
// in-process PGlite with a stand-in `claude`, ElevenLabs stubbed in fetch
// and the stub image provider. Every name here is made up.
//   node --test scripts/tests/kids-readings.http.test.mjs

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-kids-readings-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_IMAGE_PROVIDER = "stub";
for (const k of ["LINGO_AUDIO_DIR", "LINGO_IMAGES_DIR"]) delete process.env[k];
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
fs.writeFileSync(process.env.LINGO_ENV_FILE, "ELEVENLABS_API_KEY=test-key\n");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "OPENAI_API_KEY", "BFL_API_KEY"]) delete process.env[k];
write(root, "kids/scenarios/errand.md", ["---", "id: errand", "title: An errand", "summary: Out and about.", "---", "An errand."].join("\n"));
write(root, "scenarios/errand.md", ["---", "id: errand", "title: An errand", "summary: Out and about.", "---", "An errand."].join("\n"));

const synths = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "api.elevenlabs.io") return realFetch(input, init);
  if (url.pathname.startsWith("/v1/text-to-speech/")) {
    const { text } = JSON.parse(init.body);
    synths.push(text);
    return new Response(`MP3:${text}`, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  return new Response(JSON.stringify({ voices: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const { apiPlugins } = await import("../../web/server/api.ts");
const { settleExtractions } = await import("../../web/server/extraction.ts");
const { settlePictureFills, resetPictureMemory } = await import("../../web/server/pictures.ts");
const { READING_CHECK_DAILY, settleReadingChecks, resetReadingChecks } = await import("../../web/server/sessionReadings.ts");

const fake = fakeClaude();
const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  await settleReadingChecks();
  await settlePictureFills();
  await settleExtractions();
  globalThis.fetch = realFetch;
  fake.restore();
  await close();
  await testDb.close();
});
beforeEach(async () => {
  await settleReadingChecks();
  resetReadingChecks();
  resetPictureMemory();
  fake.readings(JSON.stringify({ readings: [] }));
  fake.picture("!auto");
  synths.length = 0;
});

const KID_CN = { ...KID, name: "Bo", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin (Putonghua)" };
const ADULT_CN = { ...ADULT, name: "Lin", targetLanguage: "Mandarin Chinese", targetVariant: "Mainland Mandarin (Putonghua)" };
// The reader marks 得去 (dé qù, a guess) and 倒车 (dǎo chē, a guess: it is dào chē).
const LINE = "你得去银行。他在倒车。";
const REPLY = ["NARRATOR-F: At the bank.", `CHARACTER-F: <t>${LINE}</t>`, "STAGE: scene"].join("\n");
const CHILD_SAYS = "我的秘密叫长着";
const pack = { title: "", created: "", scenario: "errand", quick_scenario: "", units: [], overrides: {}, notes: "" };

let n = 0;
async function someone(learner = KID_CN, { admin = false } = {}) {
  const name = `kr${++n}`;
  await addUser(testDb.db, name, undefined, { learners: [learner], admin });
  const c = client(base);
  await c.login(name);
  await c.pick(learner.name);
  return c;
}
async function turns(who, mode = "kids", count = 2) {
  fake.answer(REPLY);
  const r = await who.call("POST", "/api/conversations", { mode, pack, title: "Session" });
  assert.equal(r.status, 201, r.text);
  const c = r.body.conversation;
  const history = [];
  for (let i = 0; i < count; i++) {
    const t = await who.call("POST", "/api/voice/turn", { mode, pack, history, message: i ? CHILD_SAYS : "", elapsedMs: 0, conversationId: c.id });
    assert.equal(t.status, 200, t.text);
    history.push({ role: "master", lines: t.body.lines }, { role: "learner", text: CHILD_SAYS });
    await settleReadingChecks();
  }
  return c;
}
const rows = (who) => q("select word, reading, kind, source, checked_by from reading_corrections where language_profile_id = $1 order by word", [who.languageId]);
const ledger = (who) => q("select words, settled from reading_check_calls where language_profile_id = $1 order by created_at", [who.languageId]);
const speak = (c, text) => c.call("POST", "/api/voice/speak", { speaker: "narrator", gender: "female", text, locale: "zh-CN" });
const promptOf = () => {
  const args = fake.readingArgs();
  return { user: args[args.indexOf("-p") + 1], all: args.join(" ") };
};

test("a kids session's uncertain words: one background check, the dojo master's lines only, validated, the learner's own, no shared vote; the voice says it next", async () => {
  const bo = await someone();
  const set = await bo.call("PUT", "/api/voice/settings", { tts: "elevenlabs", voices: { elevenlabs: { "zh-CN": { "narrator:female": "v1" } } } });
  assert.equal(set.status, 200, set.text);
  const first = await speak(bo, "他在倒车。");
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(synths, ["他在倒车。"], "before: the voice is given the text as it is");
  const ran = fake.readingRuns();
  fake.readings(JSON.stringify({ readings: [
    { word: "得去", pinyin: "děi qù" },
    { word: "倒车", pinyin: "dào chē" },
    { word: "银行", pinyin: "yín xíng" }, // never asked: dropped
  ] }));
  await turns(bo);
  assert.equal(fake.readingRuns() - ran, 1, "one call for the session's words; the same words in the next turn are not asked again");
  const { user, all } = promptOf();
  assert.match(user, /得去 \| 你得去银行。他在倒车。/);
  assert.match(user, /倒车 \|/);
  assert.doesNotMatch(user, /银行 \|/, "only the uncertain words");
  assert.doesNotMatch(all, /秘密|长着/, "never what the child said");
  assert.match(all, /--model claude-haiku-5-5/);

  assert.deepEqual(await rows(bo), [
    { word: "倒车", reading: "dào chē", kind: "confirmed", source: "recap", checked_by: "session" },
    { word: "得去", reading: "děi qù", kind: "confirmed", source: "recap", checked_by: "session" },
  ]);
  assert.deepEqual(await ledger(bo), [{ words: 2, settled: 2 }]);
  assert.equal((await q("select count(*)::int as n from shared_readings"))[0].n, 0, "no shared suggestion");
  assert.equal((await q("select count(*)::int as n from shared_reading_votes"))[0].n, 0, "no vote");
  // The voice says the settled reading from now on (到 for 倒), the text unchanged.
  synths.length = 0;
  const r = await speak(bo, "他在倒车。");
  assert.equal(r.status, 200);
  assert.deepEqual(synths, ["他在到车。"]);
});

test("an answer that fails the checks is dropped; a failed call still counts on the ledger", async () => {
  const bo = await someone();
  fake.readings(JSON.stringify({ readings: [{ word: "得去", pinyin: "dēi qù" }, { word: "倒车", pinyin: "dāo chē" }] }));
  await turns(bo, "kids", 1);
  assert.deepEqual(await rows(bo), [], "readings the characters don't have are never stored");
  assert.deepEqual(await ledger(bo), [{ words: 2, settled: 0 }]);
  resetReadingChecks();
  fake.readings("!fail");
  await turns(bo, "kids", 1);
  assert.deepEqual(await ledger(bo), [{ words: 2, settled: 0 }, { words: 2, settled: null }]);
  assert.deepEqual(await rows(bo), []);
});

test("the daily cap: counted from the ledger, past it no call is made", async () => {
  const bo = await someone();
  for (let i = 0; i < READING_CHECK_DAILY; i++) {
    await q("insert into reading_check_calls (learner_id, language_profile_id, words) values ((select learner_id from language_profiles where id = $1), $1, 1)", [bo.languageId]);
  }
  const ran = fake.readingRuns();
  fake.readings(JSON.stringify({ readings: [{ word: "倒车", pinyin: "dào chē" }] }));
  await turns(bo, "kids", 1);
  assert.equal(fake.readingRuns(), ran, "no call past the cap");
  assert.deepEqual(await rows(bo), []);
  assert.equal((await ledger(bo)).length, READING_CHECK_DAILY);
});

test("an adult's session asks nothing in the background (the recap reads theirs, as before)", async () => {
  const lin = await someone(ADULT_CN);
  const ran = fake.readingRuns();
  await turns(lin, "adult", 1);
  assert.equal(fake.readingRuns(), ran);
  assert.deepEqual(await ledger(lin), []);
});

const WORDS = [["倒车", "reversing the car"], ["苹果", "apple"], ["小狗", "puppy"], ["小猫", "kitten"]];
async function withPictures(learner) {
  const who = await someone(learner);
  const ids = {};
  for (const [text, meaning] of WORDS) {
    const r = await who.call("POST", "/api/phrases", { text, meaning, starred: false });
    assert.equal(r.status, 201, r.text);
    ids[text] = r.body.phrase.id;
  }
  assert.equal((await who.call("POST", "/api/pictures/fill")).status < 300, true);
  await settlePictureFills();
  const ready = await q("select count(*)::int as n from phrase_pictures where language_profile_id = $1 and status = 'ready'", [who.languageId]);
  assert.equal(ready[0].n, 4, "all four drawn (an uncertain word's picture is drawn meanwhile)");
  return { who, ids };
}
const inGame = async (who) => {
  const r = await who.call("POST", "/api/game/start");
  assert.equal(r.status, 200, r.text);
  return new Set(r.body.rounds.map((x) => x.phraseId));
};

test("a kids word still uncertain stays out of the game, listed for the grown-up; settled, it plays", async () => {
  const { who: bo, ids } = await withPictures(KID_CN);
  const before = await inGame(bo);
  assert.ok(!before.has(ids["倒车"]), "not before it is settled");
  assert.ok(before.has(ids["苹果"]));
  assert.equal((await bo.call("GET", "/api/game")).body.status.pictured, 3);
  const waiting = await bo.call("GET", "/api/readings/waiting");
  assert.equal(waiting.status, 200, waiting.text);
  assert.deepEqual(waiting.body.words, [{ word: "倒车", reading: ["dǎo", "chē"], text: "倒车", at: 0, phraseId: ids["倒车"] }]);
  // The grown-up settles it (the Phrase bank's control).
  const fix = await bo.call("POST", "/api/readings", { word: "倒车", reading: "dào chē", kind: "corrected" });
  assert.equal(fix.status, 200, fix.text);
  assert.deepEqual((await bo.call("GET", "/api/readings/waiting")).body.words, []);
  assert.ok((await inGame(bo)).has(ids["倒车"]), "in the game once settled");
  assert.equal((await bo.call("GET", "/api/game")).body.status.pictured, 4);
});

test("settled by the session's check, the word enters the game too; an adult's game is as before", async () => {
  const { who: bo, ids } = await withPictures(KID_CN);
  assert.ok(!(await inGame(bo)).has(ids["倒车"]));
  fake.readings(JSON.stringify({ readings: [{ word: "倒车", pinyin: "dào chē" }, { word: "得去", pinyin: "děi qù" }] }));
  await turns(bo, "kids", 1);
  assert.ok((await inGame(bo)).has(ids["倒车"]));

  const { who: lin, ids: adultIds } = await withPictures(ADULT_CN);
  assert.ok((await inGame(lin)).has(adultIds["倒车"]), "an adult plays an uncertain word, as before");
  assert.deepEqual((await lin.call("GET", "/api/readings/waiting")).body.words, []);
});

test("the grown-up sees what the program settled, and can confirm it, correct it or send it back to waiting (PR #68 review)", async () => {
  const { who: bo, ids } = await withPictures(KID_CN);
  assert.equal((await bo.call("GET", "/api/game")).body.status.heldForReading, 1, "the game says a word is held back");
  fake.readings(JSON.stringify({ readings: [{ word: "倒车", pinyin: "dào chē" }, { word: "得去", pinyin: "děi qù" }] }));
  await turns(bo, "kids", 1);
  let r = await bo.call("GET", "/api/readings/waiting");
  assert.deepEqual(r.body.words, []);
  assert.deepEqual(r.body.checked.map((c) => [c.word, c.reading, c.by]).sort(), [["倒车", "dào chē", "session"], ["得去", "děi qù", "session"]]);
  assert.ok(r.body.checked.every((c) => !Number.isNaN(Date.parse(c.at))));
  assert.equal((await bo.call("GET", "/api/game")).body.status.heldForReading, 0);
  assert.ok((await inGame(bo)).has(ids["倒车"]));

  // Back to waiting: uncertain again, listed, out of the game.
  const back = await bo.call("POST", "/api/readings/back", { word: "倒车" });
  assert.equal(back.status, 200, back.text);
  r = await bo.call("GET", "/api/readings/waiting");
  assert.deepEqual(r.body.words.map((w) => w.word), ["倒车"]);
  assert.deepEqual(r.body.checked.map((c) => c.word), ["得去"]);
  assert.ok(!(await inGame(bo)).has(ids["倒车"]));
  assert.equal((await bo.call("POST", "/api/readings/back", { word: "倒车" })).status, 404, "nothing left to send back");

  // This is right: a hand choice now, off the program's list; a hand choice
  // is never sent back.
  assert.equal((await bo.call("POST", "/api/readings", { word: "得去", reading: "děi qù", kind: "confirmed" })).status, 200);
  assert.deepEqual((await bo.call("GET", "/api/readings/waiting")).body.checked, []);
  assert.equal((await bo.call("POST", "/api/readings/back", { word: "得去" })).status, 404);
  assert.equal((await bo.call("POST", "/api/readings/back", { word: "x" })).status, 400);

  // An adult has no such lists.
  const lin = await someone(ADULT_CN);
  assert.deepEqual((await lin.call("GET", "/api/readings/waiting")).body, { words: [], checked: [] });
});

test("a kids recap suggestion from before the change is not settled: it waits, out of the game", async () => {
  const { who: bo, ids } = await withPictures(KID_CN);
  await q("insert into reading_corrections (learner_id, language_profile_id, key, word, reading, kind, source) values ((select learner_id from language_profiles where id = $1), $1, '倒车', '倒车', 'dào chē', 'suggested', 'recap')", [bo.languageId]);
  const r = await bo.call("GET", "/api/readings/waiting");
  assert.deepEqual(r.body.words.map((w) => w.word), ["倒车"]);
  assert.deepEqual(r.body.checked, []);
  assert.ok(!(await inGame(bo)).has(ids["倒车"]));
});

test("a kids learner's hand choice casts no shared vote, even on an admin's login (PR #68 review)", async () => {
  const bo = await someone(KID_CN, { admin: true });
  const r = await bo.call("POST", "/api/readings", { word: "倒车", reading: "dào chē", kind: "corrected" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.shared, null);
  assert.deepEqual(await rows(bo), [{ word: "倒车", reading: "dào chē", kind: "corrected", source: "user", checked_by: null }]);
  assert.equal((await q("select count(*)::int as n from shared_readings"))[0].n, 0);
  assert.equal((await q("select count(*)::int as n from shared_reading_votes"))[0].n, 0);
  // An adult admin's is active at once, as before.
  const ada = await someone(ADULT_CN, { admin: true });
  assert.equal((await ada.call("POST", "/api/readings", { word: "倒车", reading: "dào chē", kind: "corrected" })).body.shared, "active");
});
