// The post-session extraction end to end over HTTP (web/server/extraction.ts,
// scripts/db/extraction.ts): End starts one tool-less model call whose
// recap is stored on the conversation and applied to the phrase bank as
// kept phrases and FSRS session reviews; a failure is retried once and then
// offered as Retry recap; a re-run replaces what the last one wrote. On
// the real plugin with an in-process PGlite and a stand-in `claude` first
// on PATH (fake-claude.mjs answers recap calls from their own file). Every
// name here is made up.
//   node --test scripts/tests/extraction.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromRow, review } from "../fsrs.mjs";
import { serveApi } from "./connect-stack.mjs";
import { EMPTY_RECAP, fakeClaude } from "./fake-claude.mjs";
import { copyFixture } from "./helpers.mjs";
import { ADULT, KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

const { apiPlugins } = await import("../../web/server/api.ts");
const { settleExtractions } = await import("../../web/server/extraction.ts");
const { countAttempt } = await import("../db/extraction.ts");

const fake = fakeClaude();
const REPLY = [
  "NARRATOR-F: Bienvenido al <t>mercado</t>.",
  "CHARACTER-F: <t>¿Qué le doy, joven? Quédese con la vuelta.</t>",
  "GLOSS: mercado = market | la vuelta = the change",
  "STAGE: scene",
].join("\n");

/** The model's recap of the session the tests play. */
const RECAP = {
  summary: "You bought mangoes and understood the vendor.",
  keep: [
    { text: "¿Qué le doy?", meaning: "What can I get you?", example: "made up by the model", why: "the vendor's question" },
    { text: "Quédese con la vuelta", meaning: "Keep the change", example: "", why: "useful when paying" },
  ],
  events: [
    { phrase: "la vuelta", kind: "understood" },
    { phrase: "mercado", kind: "produced" },
    { phrase: "¿Qué le doy?", kind: "corrected", said: "qué doy", note: "le is needed" },
    { phrase: "nunca dicho", kind: "produced" },
  ],
  corrections: [{ said: "Unos mangos", better: "Unos mangos, por favor", note: "say please" }],
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
  fake.restore();
  await close();
  await testDb.close();
});
beforeEach(() => {
  fake.answer(REPLY);
  fake.recap(JSON.stringify(RECAP));
});

const pack = (extra = {}) => ({ title: "", created: "", scenario: "", quick_scenario: "", units: [], overrides: {}, notes: "", ...extra });

let n = 0;
async function someone(learners = [ADULT]) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  return c;
}

/** A conversation with the opening reply and one learner turn, ended; the
 *  recap run awaited. */
async function session(who, { p = pack(), mode = "adult", answer = "Unos mangos.", end = true } = {}) {
  const r = await who.call("POST", "/api/conversations", { mode, pack: p, title: "Session" });
  assert.equal(r.status, 201, r.text);
  const c = r.body.conversation;
  const t0 = await who.call("POST", "/api/voice/turn", { mode, pack: p, history: [], message: "", elapsedMs: 0, conversationId: c.id });
  assert.equal(t0.status, 200, t0.text);
  if (answer) {
    const history = [{ role: "master", lines: t0.body.lines, glosses: t0.body.glosses, stage: t0.body.stage ?? undefined }];
    const t1 = await who.call("POST", "/api/voice/turn", { mode, pack: p, history, message: answer, elapsedMs: 0, conversationId: c.id });
    assert.equal(t1.status, 200, t1.text);
  }
  if (end) {
    assert.equal((await who.call("POST", `/api/conversations/${c.id}/end`)).status, 200);
    await settleExtractions();
  }
  return c;
}

const recapOf = async (who, id) => {
  const r = await who.call("GET", `/api/conversations/${id}/recap`);
  assert.equal(r.status, 200, r.text);
  return r.body.recap;
};
const retry = async (who, id) => {
  const r = await who.call("POST", `/api/conversations/${id}/recap`);
  assert.equal(r.status, 202, r.text);
  await settleExtractions();
  return r.body.recap;
};
const bank = async (who) => Object.fromEntries((await who.call("GET", "/api/phrases")).body.phrases.map((p) => [p.text ?? `(${p.meaning})`, p]));
/** The card of one of this conversation's language's phrases. */
const cardOf = async (convId, text, skill) =>
  (await q("select k.* from cards k join phrases p on p.id = k.phrase_id join conversations c on c.language_profile_id = p.language_profile_id where c.id = $1 and p.text = $2 and k.skill = $3", [convId, text, skill]))[0];
const sessionReviews = (id) =>
  q(
    `select p.text, c.skill, r.rating, r.answer, r.grader_note, r.card_before from reviews r join cards c on c.id = r.card_id join phrases p on p.id = c.phrase_id
     where r.conversation_id = $1 and r.mode = 'session' order by p.norm, c.skill`,
    [id],
  );

test("End makes the recap: one tool-less call; summary, kept phrases, session reviews and corrections stored; the bank shows it", async () => {
  const sam = await someone();
  const runs = fake.recapRuns();
  const c = await session(sam);
  assert.equal(fake.recapRuns() - runs, 1, "one model call");
  const args = fake.recapArgs();
  assert.equal(args[args.indexOf("--tools") + 1], "", "no tools");
  assert.equal(args[args.indexOf("--max-turns") + 1], "1");
  const prompt = args[args.indexOf("-p") + 1];
  assert.match(prompt, /Learner: Unos mangos\./);
  assert.match(prompt, /Dojo master: .*¿Qué le doy, joven\?/);

  const recap = await recapOf(sam, c.id);
  assert.equal(recap.status, "done");
  assert.equal(recap.summary, RECAP.summary);
  assert.equal(recap.inBank, true);
  assert.deepEqual(recap.corrections, RECAP.corrections);
  assert.deepEqual(
    recap.kept.map((k) => [k.text, k.meaning, !!k.phraseId, k.starred]),
    [["¿Qué le doy?", "What can I get you?", true, false], ["Quédese con la vuelta", "Keep the change", true, false]],
  );
  // The made-up phrase matched nothing in the bank or the keep list: dropped.
  assert.deepEqual(
    recap.events.map((e) => [e.phrase, e.kind, e.reviewed]).sort(),
    [["la vuelta", "understood", true], ["mercado", "produced", true], ["¿Qué le doy?", "corrected", true]].sort(),
  );

  const reviews = await sessionReviews(c.id);
  assert.deepEqual(
    reviews.map((r) => [r.text, r.skill, r.rating, r.answer, r.grader_note]),
    [["la vuelta", "listen", 3, null, null], ["mercado", "produce", 3, null, null], ["¿Qué le doy?", "produce", 1, "qué doy", "le is needed"]],
  );
  assert.ok(reviews.every((r) => r.card_before.reps === 0), "each card's state before its review is kept");

  const got = await bank(sam);
  assert.deepEqual([got["¿Qué le doy?"].source, got["¿Qué le doy?"].seenCount, got["¿Qué le doy?"].mastery], ["extraction", 1, "Learning"]);
  assert.ok(got["mercado"].lastPracticedAt, "practised in the session");
  assert.equal(got["mercado"].seenCount, 2, "seen by the two replies' glosses; the recap adds no second sighting for this session");
  assert.equal(got["Quédese con la vuelta"].mastery, "New", "kept, not practised");
  assert.equal(recap.kept[0].mastery, "Learning");
  // Its example is the dojo master's own line, never the model's text.
  const [ex] = await q("select sentence, turn_id is not null as linked from phrase_examples e join phrases p on p.id = e.phrase_id where p.text = '¿Qué le doy?' and e.conversation_id = $1", [c.id]);
  assert.deepEqual(ex, { sentence: "¿Qué le doy, joven? Quédese con la vuelta.", linked: true });

  const list = (await sam.call("GET", "/api/conversations")).body.conversations;
  assert.deepEqual([list[0].recapStatus, list[0].summary], ["done", RECAP.summary]);
});

test("ending twice, or End beside a Retry, makes one recap: the claim, not memory", async () => {
  const sam = await someone();
  const c = await session(sam, { end: false });
  fake.recap(JSON.stringify(RECAP), 300);
  const runs = fake.recapRuns();
  const [a, b] = await Promise.all([sam.call("POST", `/api/conversations/${c.id}/end`), sam.call("POST", `/api/conversations/${c.id}/end`)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  // A Retry while that run is going claims nothing: it is being made.
  await new Promise((r) => setTimeout(r, 50));
  const r = await sam.call("POST", `/api/conversations/${c.id}/recap`);
  assert.equal(r.status, 202);
  assert.equal(r.body.recap.status, "pending");
  await settleExtractions();
  assert.equal(fake.recapRuns() - runs, 1);
  assert.equal((await sessionReviews(c.id)).length, 3);
  // Two Retries at once: one run.
  const before = fake.recapRuns();
  await Promise.all([sam.call("POST", `/api/conversations/${c.id}/recap`), sam.call("POST", `/api/conversations/${c.id}/recap`)]);
  await settleExtractions();
  assert.equal(fake.recapRuns() - before, 1);
  assert.equal((await q("select extraction_attempts from conversations where id = $1", [c.id]))[0].extraction_attempts, 2);
});

test("a failed call is retried once, then the recap is 'failed' with Retry recap; a retry by hand makes it", async () => {
  const sam = await someone();
  fake.recap("!fail");
  const runs = fake.recapRuns();
  const c = await session(sam);
  assert.equal(fake.recapRuns() - runs, 2, "tried twice");
  let recap = await recapOf(sam, c.id);
  assert.equal(recap.status, "failed");
  assert.match(recap.error, /something broke/);
  assert.equal(recap.summary, null);
  assert.equal((await sessionReviews(c.id)).length, 0, "nothing written");
  assert.equal((await sam.call("GET", "/api/conversations")).body.conversations[0].recapStatus, "failed");

  // A reply that isn't JSON fails the same way.
  fake.recap("Sure! Here is a summary of the session.");
  recap = await retry(sam, c.id);
  assert.equal((await recapOf(sam, c.id)).status, "failed");
  assert.match((await recapOf(sam, c.id)).error, /wasn't a recap/);

  fake.recap(JSON.stringify(RECAP));
  recap = await retry(sam, c.id);
  recap = await recapOf(sam, c.id);
  assert.equal(recap.status, "done");
  assert.equal((await sessionReviews(c.id)).length, 3);
});

test("making the recap again replaces the last one: the same reply changes nothing, a different one replaces its reviews and the phrases only it kept", async () => {
  const sam = await someone();
  const c = await session(sam);
  const learner = sam.learnerId;
  const snapshot = async () => ({
    cards: await q("select p.text, k.skill, k.reps, k.state, k.stability, k.due, k.last_review from cards k join phrases p on p.id = k.phrase_id where k.learner_id = $1 order by p.norm, k.skill", [learner]),
    reviews: await q("select card_id, rating, reviewed_at, card_before from reviews where learner_id = $1 order by card_id", [learner]),
    phrases: await q("select text, seen_count, first_seen_at, last_seen_at, last_practiced_at, source from phrases where learner_id = (select learner_id from conversations where id = $1) order by norm", [c.id]),
    sightings: await q("select phrase_id, source from phrase_sightings where conversation_id = $1 order by 1, 2", [c.id]),
    examples: await q("select phrase_id, sentence from phrase_examples where learner_id = $1 order by 1, 2", [learner]),
  });
  const first = await snapshot();
  await retry(sam, c.id);
  assert.deepEqual(await snapshot(), first, "idempotent");

  // Now the model reads it differently: "mercado" was said with help, the
  // listen event is gone, and "Quédese con la vuelta" isn't kept.
  fake.recap(
    JSON.stringify({
      ...RECAP,
      keep: [RECAP.keep[0]],
      events: [{ phrase: "mercado", kind: "produced_with_help" }, { phrase: "¿Qué le doy?", kind: "corrected" }],
    }),
  );
  await retry(sam, c.id);
  const reviews = await sessionReviews(c.id);
  assert.deepEqual(reviews.map((r) => [r.text, r.skill, r.rating]), [["mercado", "produce", 2], ["¿Qué le doy?", "produce", 1]]);
  const mercado = await cardOf(c.id, "mercado", "produce");
  const [ended] = await q("select ended_at from conversations where id = $1", [c.id]);
  const expected = review(reviews[0].card_before, 2, ended.ended_at, { utcOffsetMinutes: -new Date(ended.ended_at).getTimezoneOffset() }).card;
  assert.deepEqual(fromRow(mercado), expected, "reviewed from the card as it was before the session, not on top of the last run");
  const got = await bank(sam);
  assert.equal(got["Quédese con la vuelta"], undefined, "only the last run had it, and nothing else holds it");
  assert.equal(got["la vuelta"].lastPracticedAt, null, "its listen review is undone");
  assert.equal(await cardOf(c.id, "la vuelta", "listen"), undefined, "the listen card only that run made is gone");
  assert.equal(got["la vuelta"].seenCount, 2, "its glosses still count");
});

test("a card practised after the session keeps that history: the old session review stays and a re-run doesn't review it again", async () => {
  const sam = await someone();
  const c = await session(sam);
  const card = await cardOf(c.id, "mercado", "produce");
  // A flashcard review after it.
  await q(
    `insert into reviews (card_id, learner_id, language_profile_id, mode, rating, card_before) select id, learner_id, language_profile_id, 'flashcard', 4, '{}' from cards where id = $1`,
    [card.id],
  );
  await q("update cards set reps = reps + 1 where id = $1", [card.id]);
  const [after] = await q("select * from cards where id = $1", [card.id]);
  fake.recap(JSON.stringify({ ...RECAP, events: [{ phrase: "mercado", kind: "corrected" }] }));
  await retry(sam, c.id);
  assert.deepEqual(await q("select * from cards where id = $1", [card.id]), [after], "untouched");
  assert.deepEqual((await sessionReviews(c.id)).map((r) => [r.text, r.rating]), [["mercado", 3]], "the first run's review stays");
  assert.equal((await recapOf(sam, c.id)).events[0].reviewed, false);
});

test("the model's output is untrusted: control characters stripped, sentences not kept, a learner's edits and suspensions respected, ids ignored", async () => {
  const sam = await someone();
  const c = await session(sam, { end: false });
  const mercado = (await bank(sam))["mercado"];
  await sam.call("PATCH", `/api/phrases/${mercado.id}`, { meaning: "the market (my words)", suspended: true });
  fake.recap(
    JSON.stringify({
      summary: "Bien\u0000 hecho‮.",
      keep: [
        { text: "mer\u0007cado", meaning: "MARKET", id: "00000000-0000-4000-8000-000000000000" },
        { text: "una frase demasiado larga para ser una frase útil", meaning: "a sentence" },
      ],
      events: [{ phrase: "mercado", kind: "produced", phraseId: "00000000-0000-4000-8000-000000000000" }, { phrase: "x", kind: "aced" }],
      corrections: [{ said: "a‮b", better: "c", note: "" }],
    }),
  );
  await sam.call("POST", `/api/conversations/${c.id}/end`);
  await settleExtractions();
  const recap = await recapOf(sam, c.id);
  assert.equal(recap.summary, "Bien hecho.");
  assert.deepEqual(recap.corrections, [{ said: "ab", better: "c", note: "" }]);
  assert.deepEqual(recap.kept.map((k) => k.text), ["mercado"]);
  assert.equal(recap.kept[0].phraseId, mercado.id, "matched by its words");
  assert.deepEqual(recap.events.map((e) => [e.phrase, e.reviewed]), [["mercado", false]], "suspended: no review");
  const got = await bank(sam);
  assert.deepEqual([got["mercado"].meaning, got["mercado"].source], ["the market (my words)", "gloss"], "the learner's meaning and the gloss's provenance kept");
  assert.equal(Object.keys(got).some((t) => t.startsWith("una frase")), false);
  assert.equal((await q("select count(*)::int as n from reviews where learner_id = (select learner_id from conversations where id = $1)", [c.id]))[0].n, 0);
});

test("a kept phrase pairs a scene's pending phrase by meaning; a deleted phrase isn't brought back by the model", async () => {
  const sam = await someone();
  // A scene list with an English meaning only: a pending phrase.
  fs.writeFileSync(
    path.join(root, "scenarios/errand2.md"),
    ["---", "id: errand2", "title: An errand", "summary: Out.", "phrases:", "  - Keep the change", "---", "An errand."].join("\n"),
  );
  await q("insert into phrase_dismissals (learner_id, language_profile_id, kind, key) select learner_id, id, 'text', 'qué le doy' from language_profiles where learner_id = $1", [sam.learnerId]);
  await session(sam, { p: pack({ scenario: "errand2" }) });
  const got = await bank(sam);
  assert.equal(got["(Keep the change)"], undefined, "folded into the kept words");
  assert.equal(got["Quédese con la vuelta"].source, "scenario", "the scene's phrase stays the scene's");
  assert.equal(got["¿Qué le doy?"], undefined, "dismissed by the learner");
});

test("a scene phrase the learner deleted (a meaning dismissal) isn't brought back by a kept phrase with that meaning", async () => {
  const sam = await someone();
  fs.writeFileSync(
    path.join(root, "scenarios/errand3.md"),
    ["---", "id: errand3", "title: Another errand", "summary: Out.", "phrases:", "  - Keep the change", "---", "An errand."].join("\n"),
  );
  const c = await session(sam, { p: pack({ scenario: "errand3" }), end: false });
  const pending = (await bank(sam))["(Keep the change)"];
  assert.ok(pending, "the scene's phrase is in the bank, pending");
  assert.equal((await sam.call("DELETE", `/api/phrases/${pending.id}`)).status, 200);
  assert.equal((await q("select kind, key from phrase_dismissals where learner_id = $1", [sam.learnerId])).some((d) => d.kind === "meaning" && d.key === "keep the change"), true);
  assert.equal((await sam.call("POST", `/api/conversations/${c.id}/end`)).status, 200);
  await settleExtractions();
  assert.equal((await recapOf(sam, c.id)).status, "done");
  const got = await bank(sam);
  assert.equal(got["Quédese con la vuelta"], undefined, "deleted by meaning");
  assert.equal(got["(Keep the change)"], undefined);
  assert.ok(got["¿Qué le doy?"], "the other kept phrase is made");
});

test("nothing to recap: a session the learner never answered is skipped with no model call", async () => {
  const sam = await someone();
  const runs = fake.recapRuns();
  const c = await session(sam, { answer: "" });
  assert.equal(fake.recapRuns(), runs);
  assert.equal((await recapOf(sam, c.id)).status, "skipped");
});

test("a session in another language than the bank's: the recap is made, the bank left alone", async () => {
  const sam = await someone();
  const runs = fake.recapRuns();
  const c = await session(sam, { p: pack({ overrides: { target_language: "German" } }) });
  assert.equal(fake.recapRuns() - runs, 1);
  const recap = await recapOf(sam, c.id);
  assert.deepEqual([recap.status, recap.inBank, recap.summary], ["done", false, RECAP.summary]);
  assert.ok(recap.kept.every((k) => k.phraseId === null));
  assert.equal((await q("select count(*)::int as n from phrases p join conversations c on c.language_profile_id = p.language_profile_id where c.id = $1", [c.id]))[0].n, 0);
});

test("kids: the same pass, its prompt asking for a child's recap", async () => {
  const pip = await someone([KID]);
  fake.recap(EMPTY_RECAP);
  const c = await session(pip, { mode: "kids" });
  const prompt = fake.recapArgs();
  assert.match(prompt[prompt.indexOf("--append-system-prompt") + 1], /young child/);
  const recap = await recapOf(pip, c.id);
  assert.deepEqual([recap.status, recap.kids], ["done", true]);
});

test("an open conversation's recap is 'open' and can't be made yet; another learner's or account's is a 404", async () => {
  const sam = await someone();
  const c = await session(sam, { end: false });
  assert.equal((await recapOf(sam, c.id)).status, "open");
  assert.equal((await sam.call("POST", `/api/conversations/${c.id}/recap`)).status, 409);
  const lee = await someone();
  for (const method of ["GET", "POST"]) assert.equal((await lee.call(method, `/api/conversations/${c.id}/recap`)).status, 404);
  assert.equal((await sam.call("PUT", `/api/conversations/${c.id}/recap`)).status, 405);
});

test("a run that died with the server (running, its claim held by nobody) reads as failed and can be retried", async () => {
  const sam = await someone();
  const c = await session(sam);
  await q("update conversations set extraction_status = 'running', extraction_claim = gen_random_uuid() where id = $1", [c.id]);
  const recap = await recapOf(sam, c.id);
  assert.equal(recap.status, "failed");
  assert.match(recap.error, /interrupted/);
  // The dead run's model call, if it ever returned, counts nothing: its claim is gone.
  const [{ language_profile_id: profileId, extraction_attempts: before }] = await q("select language_profile_id, extraction_attempts from conversations where id = $1", [c.id]);
  await countAttempt(testDb.db, { id: profileId, learnerId: sam.learnerId }, c.id, crypto.randomUUID());
  assert.equal((await q("select extraction_attempts from conversations where id = $1", [c.id]))[0].extraction_attempts, before);
  await retry(sam, c.id);
  assert.equal((await recapOf(sam, c.id)).status, "done");
});
