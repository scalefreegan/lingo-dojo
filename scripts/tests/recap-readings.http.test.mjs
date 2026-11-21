// The recap's readings end to end (ld-4i2, docs/VOICE.md §Uncertain
// readings): a Mandarin session's recap is asked about the dojo master's
// uncertain words; a checked answer that differs from the reader is the
// learner's suggestion (still marked, listed under "Readings to check"),
// the shared list's suggestion and their bank phrase's reading; one that
// agrees confirms the word; a learner agreeing later makes it active for
// everyone; a hand choice is never replaced by a recap made again; a kids
// learner's recap may settle readings but shows none; another language's
// prompt asks nothing. The real plugin on an in-process PGlite with a
// stand-in `claude`. Every name here is made up.
//   node --test scripts/tests/recap-readings.http.test.mjs

import { test, before, after } from "node:test";
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
write(root, "scenarios/errand.md", ["---", "id: errand", "title: An errand", "summary: Out and about.", "---", "An errand."].join("\n"));

const { apiPlugins } = await import("../../web/server/api.ts");
const { settleExtractions } = await import("../../web/server/extraction.ts");

const fake = fakeClaude();
const REPLY = ["NARRATOR-F: At the bank.", "CHARACTER-F: <t>你得去銀行。他在倒車。</t>", "GLOSS: 你得去 = you have to go", "STAGE: scene"].join("\n");
const recapWith = (readings, keep = []) => JSON.stringify({ summary: "You went to the bank.", keep, events: [], corrections: [], ...(readings ? { readings } : {}) });

const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  await settleExtractions();
  fake.restore();
  await close();
  await testDb.close();
});

const TW = { ...ADULT, name: "Mei", targetLanguage: "Mandarin Chinese", targetVariant: "Taiwanese Mandarin" };
const KID_ZH = { ...KID, name: "Bo", targetLanguage: "Mandarin Chinese", targetVariant: "Taiwanese Mandarin" };
const pack = { title: "", created: "", scenario: "errand", quick_scenario: "", units: [], overrides: {}, notes: "" };
let n = 0;
async function someone(learner) {
  const name = `user${++n}`;
  const made = await addUser(testDb.db, name, undefined, { learners: [learner] });
  const c = client(base);
  await c.login(name);
  await c.pick(learner.name);
  return Object.assign(c, { userId: made.user.id });
}
async function session(who, mode = "adult") {
  fake.answer(REPLY);
  const r = await who.call("POST", "/api/conversations", { mode, pack, title: "Session" });
  assert.equal(r.status, 201, r.text);
  const c = r.body.conversation;
  const t0 = await who.call("POST", "/api/voice/turn", { mode, pack, history: [], message: "", elapsedMs: 0, conversationId: c.id });
  assert.equal(t0.status, 200, t0.text);
  const history = [{ role: "master", lines: t0.body.lines, glosses: t0.body.glosses }];
  assert.equal((await who.call("POST", "/api/voice/turn", { mode, pack, history, message: "好的", elapsedMs: 0, conversationId: c.id })).status, 200);
  assert.equal((await who.call("POST", `/api/conversations/${c.id}/end`)).status, 200);
  await settleExtractions();
  return c;
}
const promptOf = () => {
  const args = fake.recapArgs();
  return { user: args[args.indexOf("-p") + 1], system: args[args.indexOf("--system-prompt") + 1] ?? args.join(" ") };
};
const recapOf = async (who, id) => (await who.call("GET", `/api/conversations/${id}/recap`)).body.recap;

test("a Mandarin recap reads the uncertain words; a checked answer that differs is a suggestion for the learner, the shared list and the bank; one that agrees confirms", async () => {
  const mei = await someone(TW);
  fake.recap(recapWith([{ word: "得去", pinyin: "dei3 qu4" }, { word: "倒車", pinyin: "dǎo chē" }, { word: "銀行", pinyin: "yín xíng" }], [{ text: "你得去", meaning: "you have to go", example: "", why: "" }]));
  const c = await session(mei);
  const p = promptOf();
  assert.match(p.user, /WORDS TO READ \(each word, then the coach's line it is in\):\n- 得去 \| 你得去銀行。他在倒車。\n- 倒車 \| 你得去銀行。他在倒車。\n\nTRANSCRIPT:/);
  assert.match(fake.recapArgs().join("\n"), /"readings": one entry per word of WORDS TO READ/);

  // 得去: děi qù, not the reader's dé qù: a suggestion. 倒車: agrees. 銀行 wasn't asked.
  const mine = await q(`select word, reading, kind, source from reading_corrections order by word`);
  assert.deepEqual(mine, [
    { word: "倒車", reading: "dǎo chē", kind: "confirmed", source: "recap" },
    { word: "得去", reading: "děi qù", kind: "suggested", source: "recap" },
  ]);
  const shared = await q(`select word, reading, status, source, by_recap, suggested_by from shared_readings`);
  // The recap's suggestion is the session owner's vote.
  assert.deepEqual(shared, [{ word: "得去", reading: "děi qù", status: "suggested", source: "recap", by_recap: true, suggested_by: mei.userId }]);
  // The kept phrase takes the reading.
  assert.deepEqual(await q(`select text, reading from phrases where text = '你得去'`), [{ text: "你得去", reading: "nǐ děi qù" }]);
  // Mei's readings: the suggestion (still to check) and the confirmation.
  assert.deepEqual((await mei.call("GET", "/api/readings")).body.readings.map((r) => [r.word, r.kind]), [["倒車", "confirmed"], ["得去", "suggested"]]);
  // The card lists the words to check: 得去 (suggested), not 倒車 (confirmed).
  const recap = await recapOf(mei, c.id);
  assert.deepEqual(recap.readings, [{ word: "得去", sentence: "你得去銀行。他在倒車。", at: 1, suggested: true }]);
  // The count: none of the shared list's yet.
  assert.deepEqual((await q(`select changed from shared_reading_uses where conversation_id = $1`, [c.id])), [{ changed: 0 }]);

  // Mei agrees by hand: still one person (her recap, her choice).
  const r = await mei.call("POST", "/api/readings", { word: "得去", reading: "děi qù", kind: "corrected" });
  assert.equal(r.body.shared, "suggested");
  // Another user agrees: active for everyone.
  const other = await someone({ ...TW, name: "Ann" });
  assert.equal((await other.call("POST", "/api/readings", { word: "得去", reading: "děi qù", kind: "corrected" })).body.shared, "active");

  // A recap made again never replaces her choice, and the shared list's
  // reading now counts as changed in this session.
  fake.recap(recapWith([{ word: "得去", pinyin: "dé qù" }]));
  assert.equal((await mei.call("POST", `/api/conversations/${c.id}/recap`)).status, 202);
  await settleExtractions();
  assert.deepEqual(await q(`select reading, kind, source from reading_corrections where key = '得去' and language_profile_id = $1`, [mei.languageId]), [{ reading: "děi qù", kind: "corrected", source: "user" }]);
  // Settled by people now: not asked again.
  assert.doesNotMatch(promptOf().user, /- 得去 \|/);
  assert.deepEqual((await q(`select changed from shared_reading_uses where conversation_id = $1`, [c.id])), [{ changed: 2 }], "its two lines");
});

test("'This is right' on the recap of one's own session stays a suggestion; a correction back to the reader's own reading clears the bank phrase's", async () => {
  await q(`delete from shared_readings`);
  const yu = await someone({ ...TW, name: "Yu" });
  fake.recap(recapWith([{ word: "倒車", pinyin: "dào chē" }], [{ text: "倒車", meaning: "to reverse", example: "", why: "" }]));
  await session(yu);
  assert.deepEqual(await q(`select status from shared_readings where key = '倒车'`), [{ status: "suggested" }]);
  // The bank phrase took the recap's reading.
  const phrase = async () => (await q(`select p.reading from phrases p join conversations c on c.language_profile_id = p.language_profile_id join learners l on l.id = c.learner_id where l.name = 'Yu' and p.text = '倒車'`))[0].reading;
  assert.equal(await phrase(), "dào chē");
  const r = await yu.call("POST", "/api/readings", { word: "倒車", reading: "dào chē", kind: "confirmed" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.shared, "suggested", "her recap and her click are one source");
  assert.equal(((await q(`select count(*)::int as n from shared_reading_votes v join shared_readings s on s.id = v.shared_reading_id where s.key = '倒车' and s.reading = 'dào chē'`))[0]).n, 1);
  // Confirming the reader's own reading (得去 dé qù) proposes nothing.
  const own = await yu.call("POST", "/api/readings", { word: "得去", reading: "dé qù", kind: "confirmed" });
  assert.equal(own.body.shared, null);
  assert.equal((await q(`select count(*)::int as n from shared_readings where key = '得去' and reading = 'dé qù'`))[0].n, 0);
  // Yu changes her mind: the reader's dǎo chē. The phrase's stored reading
  // never outranks her choice: it goes (the reader's own again).
  const back = await yu.call("POST", "/api/readings", { word: "倒車", reading: "dǎo chē", kind: "corrected" });
  assert.equal(back.status, 200, back.text);
  assert.equal(back.body.phrases, 1);
  assert.equal(await phrase(), null);
});

test("an answer that fails a check is dropped: nothing written, the word still to check", async () => {
  const lin = await someone({ ...TW, name: "Lin" });
  await q(`delete from shared_readings`);
  fake.recap(recapWith([{ word: "倒車", pinyin: "dǎi chē" }]));
  const c = await session(lin);
  const recap = await recapOf(lin, c.id);
  assert.deepEqual(recap.readings.map((r) => [r.word, r.suggested]), [["得去", false], ["倒車", false]], "unanswered and dropped");
  assert.deepEqual((await lin.call("GET", "/api/readings")).body.readings, []);
  assert.equal((await q(`select count(*)::int as n from shared_readings where key = '倒车'`))[0].n, 0);
});

test("a kids learner's recap may settle readings, and shows none", async () => {
  const bo = await someone(KID_ZH);
  fake.recap(recapWith([{ word: "倒車", pinyin: "dào chē" }]));
  const c = await session(bo, "kids");
  assert.match(promptOf().user, /WORDS TO READ/);
  // The child's own words are not among the lines sent with the words.
  assert.doesNotMatch(promptOf().user.split("TRANSCRIPT:")[0], /好的/);
  const recap = await recapOf(bo, c.id);
  assert.equal(recap.status, "done");
  assert.deepEqual(recap.readings, []);
  assert.deepEqual((await bo.call("GET", "/api/readings")).body.readings.map((r) => [r.word, r.kind]), [["倒車", "suggested"]]);
});

test("another language: the recap prompt asks for no readings", async () => {
  const sam = await someone(ADULT);
  fake.recap(recapWith(null));
  await session(sam);
  const args = fake.recapArgs().join("\n");
  assert.doesNotMatch(args, /WORDS TO READ|"readings"/);
});
