// The shared picture pool end to end over HTTP (web/server/picturePool.ts,
// web/server/pictures.ts, scripts/db/picturePool.ts; docs/DATA.md §The
// shared picture pool, ld-ec9): a brand-new learner's game is the pool in
// their language; the level cap (a beginner never gets a B1 word, the
// picker widens it, their own words always in); a pool word's first answer
// makes it a bank word (source `picture`); a user's drawing reaches another
// user's learner in another language with its named word; kids never get
// an adults-only concept or an adult's drawing its kids check hasn't
// passed; a drawing naming any learner is never shared; a removed picture
// leaves the pool; the naming call's ledger and cap.
// The real plugin on an in-process PGlite with a stand-in `claude` and the
// stub image provider: nothing here reaches a model or a provider. Every
// name here is made up.
//   node --test scripts/tests/picture-pool.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
fs.writeFileSync(process.env.LINGO_ENV_FILE, "");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "OPENAI_API_KEY", "BFL_API_KEY", "LINGO_IMAGES_DIR"]) delete process.env[k];
process.env.LINGO_IMAGE_PROVIDER = "stub";

const { apiPlugins } = await import("../../web/server/api.ts");
const { resetPictureMemory, settlePictureFills } = await import("../../web/server/pictures.ts");
const { resetPoolMemory, settlePoolWords } = await import("../../web/server/picturePool.ts");
const { settleExtractions } = await import("../../web/server/extraction.ts");
const { PICTURE_THEME, PICTURE_DAILY_JUDGES } = await import("../pictures.mjs");
const { POOL_DAILY_CALLS, POOL_LANGS, poolId } = await import("../picture-pool.mjs");
const { stockPicture, writeStockPicture } = await import("../picture-store.mjs");
const { placeholderPng } = await import("../../web/server/imageProvider.ts");

const fake = fakeClaude();
const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  await settled();
  await settleExtractions();
  fake.restore();
  await close();
  await testDb.close();
});

async function settled() {
  for (let i = 0; i < 3; i++) {
    await settlePictureFills();
    await settlePoolWords();
  }
}

// The stock set: five concepts a kid may have, an adults-only one, a B1 one.
const STOCK = [
  ["dog", "a friendly brown dog", "dog"],
  ["cat", "a fluffy orange cat", "cat"],
  ["ball", "a colourful ball", "ball"],
  ["apple", "a shiny red apple", "apple"],
  ["beer", "a glass of beer", "beer", "adults: true"],
  ["passport", "a closed passport", "passport"],
];
const WORDS = {
  dog: ["A1", "der Hund", "el perro", "dog"],
  cat: ["A1", "die Katze", "el gato", "cat"],
  ball: ["A1", "der Ball", "la pelota", "ball"],
  apple: ["A1", "der Apfel", "la manzana", "apple"],
  beer: ["A2", "das Bier", "la cerveza", "beer"],
  passport: ["B1", "der Reisepass", "el pasaporte", "passport"],
};
/** A made-up word in key `k`'s script, the i-th. */
const SCRIPT_BASE = { ru: 0x0430, el: 0x03b1, ar: 0x0628, hi: 0x0915, ja: 0x3042, ko: 0xac00, zh: 0x4e00 };
const scriptWord = (k, i) => {
  const b = SCRIPT_BASE[k.split("-")[0]];
  return b ? String.fromCharCode(b + i, b + i + 1) : `${k}word${"abcdefgh"[i]}`;
};
beforeEach(async () => {
  await settled();
  resetPictureMemory();
  resetPoolMemory();
  fake.picture("!auto");
  fake.poolWords("!auto");
  fake.kidsCheck("!auto");
  for (const t of ["picture_stock_concepts", "picture_pool_words", "picture_pool_levels", "picture_pool_calls"]) await q(`delete from ${t}`);
  fs.writeFileSync(
    path.join(root, "pictures.yaml"),
    ["categories:", "  Things:", ...STOCK.map(([id, d, w, extra]) => `    - { id: ${id}, description: ${d}, words: [${w}]${extra ? `, ${extra}` : ""} }`), ""].join("\n"),
  );
  // Every language named, as the real table is (else the naming call would
  // be asked about these too): the ones the tests read, and a word in its
  // script for the rest.
  fs.writeFileSync(
    path.join(root, "picture-words.yaml"),
    [
      "version: 1",
      "concepts:",
      ...Object.entries(WORDS).map(([id, [level, de, es, en]], i) => {
        const rest = POOL_LANGS.filter((k) => !["en", "de", "es"].includes(k)).map((k) => `${k}: ${scriptWord(k, i)}`);
        return `  ${id}: { level: ${level}, en: ${en}, de: ${de}, es: ${es}, ${rest.join(", ")} }`;
      }),
      "",
    ].join("\n"),
  );
  fs.rmSync(path.join(dataDir, "images"), { recursive: true, force: true });
  for (const [id] of STOCK) writeStockPicture(PICTURE_THEME.id, id, placeholderPng([40, 90, 150]), "image/png");
});

let n = 0;
async function someone(learner = KID, { name } = {}) {
  const user = `pool${++n}`;
  const l = { ...learner, ...(name ? { name } : {}) };
  await addUser(testDb.db, user, undefined, { learners: [l] });
  const c = client(base);
  await c.login(user);
  await c.pick(l.name);
  return c;
}
const status = async (who) => (await who.call("GET", "/api/game")).body.status;
const conceptOf = (who, phraseId) => Object.keys(WORDS).find((id) => poolId("phrase", who.languageId, id) === phraseId);
async function answer(who, round, pictureId) {
  return who.call("POST", "/api/game/answer", { phraseId: round.phraseId, version: round.version, revision: round.revision, submitId: crypto.randomUUID(), pictureId });
}
const rightPicture = (who, round) => round.choices.find((c) => c.id === poolId("picture", who.languageId, conceptOf(who, round.phraseId)))?.id;
const A1_ADULT = { ...ADULT, name: "Lee", level: "A1" };

test("a brand-new kids learner's game is the pool, in their language, with no adults-only or above-level picture", async () => {
  const kid = await someone(KID);
  const s = await status(kid);
  assert.deepEqual([s.pictured, s.pool, s.ready, s.poolLevel], [0, 4, true, "A1"]);
  const r = await kid.call("POST", "/api/game/start", {});
  assert.equal(r.status, 200, r.text);
  const concepts = r.body.rounds.map((x) => conceptOf(kid, x.phraseId)).sort();
  assert.deepEqual(concepts, ["apple", "ball", "cat", "dog"]);
  for (const round of r.body.rounds) {
    assert.ok(rightPicture(kid, round), "its own picture is offered");
    assert.ok(round.choices.length >= 3);
    for (const c of round.choices) {
      const pic = await kid.call("GET", `/api/game/pictures/${c.id}/${c.file}`);
      assert.equal(pic.status, 200, `picture ${c.id}`);
      assert.equal(pic.headers.get("content-type"), "image/png");
    }
  }
  // The adults-only picture is not served to a kid, even by a guessed id.
  const beerPic = poolId("picture", kid.languageId, "beer");
  assert.equal((await kid.call("GET", `/api/game/pictures/${beerPic}/x`)).status, 404);
  // Nothing was added to the bank by playing a game's start.
  assert.equal((await q("select count(*)::int n from phrases where language_profile_id = $1", [kid.languageId]))[0].n, 0);
  await settled();
});

test("a pool word's first answer makes it a bank word (source picture, its stock picture, a listen review); a resend replays", async () => {
  const sam = await someone(A1_ADULT);
  const r = await sam.call("POST", "/api/game/start", {});
  const round = r.body.rounds[0];
  const concept = conceptOf(sam, round.phraseId);
  const pictureId = rightPicture(sam, round);
  const body = { phraseId: round.phraseId, version: round.version, revision: round.revision, submitId: crypto.randomUUID(), pictureId };
  const a = await sam.call("POST", "/api/game/answer", body);
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.right, true);
  assert.equal(a.body.word.text, WORDS[concept][2], "the word in the learner's language");
  assert.equal(a.body.word.meaning, WORDS[concept][3], "the meaning in their native language");
  const [p] = await q("select id, text, source, starred from phrases where language_profile_id = $1", [sam.languageId]);
  assert.deepEqual([p.id, p.text, p.source, p.starred], [round.phraseId, WORDS[concept][2], "picture", false]);
  const [pic] = await q("select id, status, stock_id from phrase_pictures where phrase_id = $1", [p.id]);
  assert.deepEqual([pic.id, pic.status, pic.stock_id], [pictureId, "ready", concept]);
  assert.equal((await q("select count(*)::int n from reviews r join cards c on c.id = r.card_id where c.phrase_id = $1", [p.id]))[0].n, 1);
  const again = await sam.call("POST", "/api/game/answer", body);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.replayed, true);
  // It is the learner's word now: counted as theirs, out of the pool.
  const s = await status(sam);
  assert.deepEqual([s.pictured, s.pool], [1, 3]);
  // An id the pool never gave is no word.
  const bad = await sam.call("POST", "/api/game/answer", { ...body, phraseId: crypto.randomUUID(), submitId: crypto.randomUUID() });
  assert.equal(bad.status, 404);
  await settled();
});

test("levels: a beginner never gets a B1 word; the picker widens the pool; own words are in whatever their level", async () => {
  const lee = await someone(A1_ADULT);
  let s = await status(lee);
  assert.deepEqual([s.poolLevel, s.pool, s.poolByLevel], ["A1", 4, { A1: 4, A2: 5, B1: 6, B2: 6 }]);
  const at = async (level) => (await lee.call("POST", "/api/game/start", level ? { level } : {})).body.rounds.map((x) => conceptOf(lee, x.phraseId)).filter(Boolean).sort();
  assert.deepEqual(await at(), ["apple", "ball", "cat", "dog"]);
  assert.deepEqual(await at("B1"), ["apple", "ball", "beer", "cat", "dog", "passport"]);
  assert.equal((await lee.call("POST", "/api/game/start", { level: "C1" })).status, 400);
  // The learner's own words: one the pool has (it leaves the pool), and a
  // hard one of their own, drawn for them, in at A1.
  for (const [text, meaning] of [["el perro", "dog"], ["la declaración de impuestos", "tax return"]]) {
    assert.equal((await lee.call("POST", "/api/phrases", { text, meaning, starred: false })).status, 201);
  }
  await lee.call("POST", "/api/pictures/fill");
  await settled();
  s = await status(lee);
  assert.deepEqual([s.pictured, s.pool], [2, 3], "the dog is theirs now (matched to the stock picture), the tax return drawn");
  const rounds = (await lee.call("POST", "/api/game/start", {})).body.rounds;
  assert.equal(rounds.length, 5);
  assert.equal(conceptOf(lee, rounds[0].phraseId), undefined, "their own words come first");
  assert.equal(conceptOf(lee, rounds[1].phraseId), undefined);
  await settled();
});

test("a user's drawing reaches another user's learner in another language, with the word the naming call gave", async () => {
  const sam = await someone({ ...ADULT, name: "Sam" });
  assert.equal((await sam.call("POST", "/api/phrases", { text: "la mochila", meaning: "backpack", starred: false })).status, 201);
  const namingBefore = fake.poolWordsRuns();
  await sam.call("POST", "/api/pictures/fill");
  await settled();
  const [c] = await q("select id, origin, kids_safe, source_file, category, words from picture_stock_concepts");
  assert.deepEqual([c.origin, c.kids_safe, c.category, c.words], ["drawing", true, "Drawn by learners", ["backpack"]]);
  assert.ok(stockPicture(PICTURE_THEME.id, c.id), "the file copied into the stock folder");
  const [file] = await q("select file from phrase_pictures x join phrases p on p.id = x.phrase_id where p.text = 'la mochila'");
  assert.equal(c.source_file, file.file);
  // Its own word at once, the rest from one naming call (in the ledger).
  assert.equal(fake.poolWordsRuns() - namingBefore, 1);
  const words = Object.fromEntries((await q("select key, text from picture_pool_words where concept_id = $1", [c.id])).map((r) => [r.key, r.text]));
  assert.equal(words.es, "la mochila", "the owner's word is kept over the call's");
  assert.ok(words.de && words["zh-CN"]);
  assert.equal((await q("select level from picture_pool_levels where concept_id = $1", [c.id]))[0].level, "A1");
  assert.deepEqual((await q("select concepts, outcome from picture_pool_calls")).map((r) => [r.concepts, r.outcome]), [[1, "ok"]]);
  // Another user's adult learner of German: the drawing, with the German word.
  const max = await someone({ ...A1_ADULT, name: "Max", targetLanguage: "German", targetVariant: "Standard German (Germany)" });
  const rounds = (await max.call("POST", "/api/game/start", { level: "B2" })).body.rounds;
  const round = rounds.find((x) => x.phraseId === poolId("phrase", max.languageId, c.id));
  assert.ok(round, "the shared drawing is a round");
  const a = await answer(max, round, poolId("picture", max.languageId, c.id));
  assert.equal(a.status, 200, a.text);
  assert.deepEqual([a.body.right, a.body.word.text, a.body.word.meaning], [true, words.de, words.en]);
  // And a kid of another user gets it too (the check said it is fine for children).
  const kid = await someone(KID, { name: "Ada" });
  const kr = (await kid.call("POST", "/api/game/start", {})).body.rounds;
  assert.ok(kr.some((x) => x.phraseId === poolId("phrase", kid.languageId, c.id)));
  // The game's start doesn't name anything twice.
  assert.equal(fake.poolWordsRuns() - namingBefore, 1);
  await settled();
});

test("kids never get an adult's drawing its kids check hasn't passed; the check runs on the owner's judge ledger", async () => {
  const sam = await someone({ ...ADULT, name: "Sam" });
  for (const [text, meaning] of [["la cerveza artesanal", "craft beer"], ["la cometa", "kite"]]) await sam.call("POST", "/api/phrases", { text, meaning, starred: false });
  await sam.call("POST", "/api/pictures/fill");
  await settled();
  const rows = await q("select c.id, c.kids_safe, p.meaning from picture_stock_concepts c join phrase_pictures x on x.file = c.source_file join phrases p on p.id = x.phrase_id order by p.meaning");
  assert.deepEqual(rows.map((r) => [r.meaning, r.kids_safe]), [["craft beer", false], ["kite", true]]);
  const [beer, kite] = rows;
  // A drawing judged before the check asked: no verdict, kept from kids.
  await q("update picture_stock_concepts set kids_safe = null where id = $1", [kite.id]);
  const kid = await someone(KID, { name: "Ada" });
  const kidRounds = async () => (await kid.call("POST", "/api/game/start", { level: "B2" })).body.rounds.map((x) => x.phraseId);
  let ids = await kidRounds();
  for (const c of [beer, kite]) assert.ok(!ids.includes(poolId("phrase", kid.languageId, c.id)), `${c.meaning} not for a kid yet`);
  assert.equal((await kid.call("GET", `/api/game/pictures/${poolId("picture", kid.languageId, kite.id)}/x`)).status, 404);
  // The admin's Adults only can't be cleared on an unchecked drawing.
  // (Covered by the route; here the owner's next run asks the kids check.)
  const judgesBefore = (await q("select count(*)::int n from picture_calls where language_profile_id = $1 and kind = 'judge'", [sam.languageId]))[0].n;
  const checks = fake.kidsCheckRuns();
  await sam.call("POST", "/api/pictures/fill");
  await settled();
  assert.equal(fake.kidsCheckRuns() - checks, 1);
  assert.equal((await q("select count(*)::int n from picture_calls where language_profile_id = $1 and kind = 'judge'", [sam.languageId]))[0].n, judgesBefore + 1);
  assert.equal((await q("select kids_safe from picture_stock_concepts where id = $1", [kite.id]))[0].kids_safe, true);
  ids = await kidRounds();
  assert.ok(ids.includes(poolId("phrase", kid.languageId, kite.id)), "the kite reaches kids once checked");
  assert.ok(!ids.includes(poolId("phrase", kid.languageId, beer.id)), "the beer never");
  // An adult learner of another user gets both.
  const max = await someone({ ...A1_ADULT, name: "Max", targetLanguage: "German", targetVariant: "Standard German (Germany)" });
  const adultIds = (await max.call("POST", "/api/game/start", { level: "B2" })).body.rounds.map((x) => x.phraseId);
  assert.ok(adultIds.includes(poolId("phrase", max.languageId, beer.id)));
  // With the judge cap used up, no check is asked.
  await q("update picture_stock_concepts set kids_safe = null where id = $1", [kite.id]);
  const prof = (await q("select learner_id from language_profiles where id = $1", [sam.languageId]))[0];
  for (let i = 0; i < PICTURE_DAILY_JUDGES; i++) await q("insert into picture_calls (learner_id, language_profile_id, kind, words) values ($1, $2, 'judge', 1)", [prof.learner_id, sam.languageId]);
  const capped = fake.kidsCheckRuns();
  await sam.call("POST", "/api/pictures/fill");
  await settled();
  assert.equal(fake.kidsCheckRuns(), capped);
  await settled();
});

test("a drawing whose word, meaning or description names any learner on the install is never shared", async () => {
  await someone(KID, { name: "Pip" });
  const sam = await someone({ ...ADULT, name: "Sam" });
  await sam.call("POST", "/api/phrases", { text: "el perro de Pip", meaning: "Pip's puppy", starred: false });
  await sam.call("POST", "/api/phrases", { text: "la tortuga", meaning: "turtle", starred: false });
  await sam.call("POST", "/api/pictures/fill");
  await settled();
  const drawn = await q("select p.meaning, x.status from phrase_pictures x join phrases p on p.id = x.phrase_id where x.language_profile_id = $1 order by p.meaning", [sam.languageId]);
  assert.deepEqual(drawn.map((r) => [r.meaning, r.status]), [["Pip's puppy", "ready"], ["turtle", "ready"]], "drawn for Sam (Pip is another account's learner)");
  assert.deepEqual((await q("select words from picture_stock_concepts")).map((r) => r.words), [["turtle"]]);
});

test("a picture its grown-up removes leaves the pool: concept, words and file", async () => {
  const sam = await someone({ ...ADULT, name: "Sam" });
  const r = await sam.call("POST", "/api/phrases", { text: "la cometa", meaning: "kite", starred: false });
  await sam.call("POST", "/api/pictures/fill");
  await settled();
  const [c] = await q("select id from picture_stock_concepts");
  assert.ok(c);
  const rm = await sam.call("POST", `/api/pictures/phrase/${r.body.phrase.id}/remove`);
  assert.equal(rm.status, 200, rm.text);
  assert.equal((await q("select count(*)::int n from picture_stock_concepts"))[0].n, 0);
  assert.equal((await q("select count(*)::int n from picture_pool_words where concept_id = $1", [c.id]))[0].n, 0);
  assert.equal(stockPicture(PICTURE_THEME.id, c.id), null);
});

test("the naming call: one install-wide run, in the ledger as it starts, never past the daily cap", async () => {
  // A concept the table lacks (the content agent added it later).
  fs.appendFileSync(path.join(root, "pictures.yaml"), "  More:\n    - { id: kite, description: a red kite, words: [kite] }\n");
  writeStockPicture(PICTURE_THEME.id, "kite", placeholderPng([1, 2, 3]), "image/png");
  for (let i = 0; i < POOL_DAILY_CALLS; i++) await q("insert into picture_pool_calls (concepts) values (1)");
  const kid = await someone(KID);
  const before = fake.poolWordsRuns();
  await kid.call("POST", "/api/game/start", {});
  await settled();
  assert.equal(fake.poolWordsRuns(), before, "capped: no call");
  await q("delete from picture_pool_calls");
  resetPoolMemory();
  await kid.call("POST", "/api/game/start", {});
  await settled();
  assert.equal(fake.poolWordsRuns() - before, 1);
  assert.deepEqual((await q("select concepts, outcome from picture_pool_calls")).map((r) => [r.concepts, r.outcome]), [[1, "ok"]]);
  assert.ok((await status(kid)).pool >= 5, "the kite is in the pool now");
  // A failed call counts, and the run waits before trying again.
  fs.appendFileSync(path.join(root, "pictures.yaml"), "    - { id: drum, description: a toy drum, words: [drum] }\n");
  writeStockPicture(PICTURE_THEME.id, "drum", placeholderPng([4, 5, 6]), "image/png");
  fake.poolWords("!fail");
  await kid.call("POST", "/api/game/start", {});
  await settled();
  await kid.call("POST", "/api/game/start", {});
  await settled();
  assert.deepEqual((await q("select outcome from picture_pool_calls order by created_at")).map((r) => r.outcome), ["ok", "failed"]);
  // The counts and the status never start one.
  const calls = fake.poolWordsRuns();
  await status(kid);
  await kid.call("GET", "/api/pictures");
  await settled();
  assert.equal(fake.poolWordsRuns(), calls);
});
