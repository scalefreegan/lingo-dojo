// Fill the gap (cloze) end to end over HTTP (web/server/practice.ts,
// cloze.ts): a sentence from the learner's own session line, sentences a
// generation call writes in the background (once per phrase's words and
// meaning, never in the queue's way, a failure only "no cloze now"), the
// answer protocol (the sentence named, stale and flagged sentences refused
// before any grading, replays, overrides, a spoken answer), flagging,
// mixed mode, a Mandarin bank, deletes, and who may see what. The real
// plugin on an in-process PGlite with a stand-in `claude` first on PATH:
// nothing here reaches a model or a provider. Every name here is made up.
//   node --test scripts/tests/cloze.http.test.mjs

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
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

const { apiPlugins } = await import("../../web/server/api.ts");
const { settleClozeFills } = await import("../../web/server/cloze.ts");

const fake = fakeClaude();
const ACCEPT = JSON.stringify({ accepted: true, rating_hint: "good", note: "That fits the gap too." });
const REJECT = JSON.stringify({ accepted: false, rating_hint: "hard", note: "That means something else." });

const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  await settleClozeFills();
  fake.restore();
  await close();
  await testDb.close();
});
beforeEach(() => {
  fake.answer(ACCEPT);
  fake.cloze(JSON.stringify({ items: [] }));
});

let n = 0;
async function someone(learners = [ADULT]) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  return c;
}

/** Phrases added by hand, each with a meaning, in this order. */
async function add(who, pairs) {
  const out = {};
  for (const [text, meaning] of pairs) {
    const r = await who.call("POST", "/api/phrases", { text, meaning, starred: false });
    assert.equal(r.status, 201, r.text);
    out[text] = r.body.phrase;
  }
  return out;
}

/** A session with one dojo-master turn whose line is `sentence` (all target
 *  words, unless `segments` says otherwise), and that line kept as an
 *  example of `phrase`. `role`/`fromClient` make it the learner's line or a
 *  browser copy instead. */
async function example(phrase, sentence, { role = "master", fromClient = false, segments = [{ lang: "target", text: sentence }] } = {}) {
  const [p] = await q("select learner_id, language_profile_id from phrases where id = $1", [phrase.id]);
  const [conv] = await q(
    `insert into conversations (learner_id, language_profile_id, pack_snapshot, title, mode, target_language) values ($1, $2, '{}', 'Market', 'adult', 'Spanish') returning id`,
    [p.learner_id, p.language_profile_id],
  );
  const lines = JSON.stringify([{ speaker: "character", gender: "female", text: sentence, segments }]);
  const [turn] = await q(
    `insert into turns (conversation_id, learner_id, language_profile_id, idx, role, text, lines, from_client) values ($1, $2, $3, 0, $4, $5, $6, $7) returning id`,
    [conv.id, p.learner_id, p.language_profile_id, role, role === "learner" ? sentence : null, role === "learner" ? null : lines, fromClient],
  );
  const [ex] = await q(
    `insert into phrase_examples (phrase_id, learner_id, language_profile_id, conversation_id, turn_id, sentence, speaker) values ($1, $2, $3, $4, $5, $6, 'character') returning id`,
    [phrase.id, p.learner_id, p.language_profile_id, conv.id, turn.id, sentence],
  );
  return { conversationId: conv.id, turnId: turn.id, exampleId: ex.id };
}

/** A generation reply: sentences per phrase, in the order the batch numbers them. */
const reply = (...lists) => JSON.stringify({ items: lists.map((sentences, i) => ({ n: i + 1, sentences })) });

const TZ = -420;
const queue = (who, qs = "") => who.call("GET", `/api/practice/queue?tz=${TZ}&mode=cloze${qs}`);
const stats = (who, qs = "") => who.call("GET", `/api/practice?tz=${TZ}&mode=cloze${qs}`);
const answer = (who, item, body, submitId = crypto.randomUUID()) =>
  who.call("POST", "/api/practice/answer", {
    phraseId: item.phraseId, skill: item.skill, drill: item.drill, version: item.version, revision: item.revision, submitId, tz: TZ,
    ...(item.cloze ? { clozeId: item.cloze.id } : {}), ...body,
  });
const itemsOf = (phraseId) => q("select * from cloze_items where phrase_id = $1 order by created_at, id", [phraseId]);

test("a session line of the dojo master's is the gap; the gap's words never travel before the answer", async () => {
  const sam = await someone();
  const p = await add(sam, [["la vuelta", "the change"]]);
  await example(p["la vuelta"], "Aquí tiene la vuelta, señora.");
  const r = await queue(sam);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.items.length, 1);
  const [it] = r.body.items;
  assert.deepEqual([it.skill, it.drill, it.text, it.meaning, it.choices], ["produce", "cloze", "", "the change", null]);
  assert.deepEqual([it.cloze.before, it.cloze.after, it.cloze.origin], ["Aquí tiene ", ", señora.", "example"]);
  assert.doesNotMatch(r.text, /vuelta/i, "not in the item, the sentence or anywhere in the reply");
  assert.deepEqual(r.body.cloze, { waiting: 0, writing: false });
  await settleClozeFills();
  assert.equal(fake.clozeRuns(), 0, "a phrase with its own line costs no call");
  const rows = await itemsOf(p["la vuelta"].id);
  assert.deepEqual(rows.map((x) => [x.origin, x.sentence, x.blank_start, x.blank_end, !!x.example_id]), [["example", "Aquí tiene la vuelta, señora.", 11, 20, true]]);
  // The same queue again makes no second item.
  await queue(sam);
  assert.equal((await itemsOf(p["la vuelta"].id)).length, 1);
});

test("lines that can't be the gap are skipped: the learner's own words, a browser copy, two target parts, an inflected form", async () => {
  const sam = await someone();
  const before0 = fake.clozeRuns();
  const p = await add(sam, [["la cuenta", "the bill"]]);
  await example(p["la cuenta"], "¿Me trae la cuenta, por favor?", { role: "learner" });
  await example(p["la cuenta"], "¿Me trae la cuenta, por favor, joven?", { fromClient: true });
  await example(p["la cuenta"], "Pide la cuenta al mesero ahora.", {
    segments: [{ lang: "target", text: "Pide" }, { lang: "native", text: "she says, then" }, { lang: "target", text: "la cuenta al mesero ahora." }],
  });
  await example(p["la cuenta"], "Ya pagamos las cuentas del mes.");
  const r = await queue(sam);
  assert.equal(r.body.items.length, 0);
  assert.deepEqual(r.body.cloze.waiting, 1);
  assert.equal(r.body.cloze.writing, true, "a call was started for it");
  await settleClozeFills();
  assert.equal(fake.clozeRuns(), before0 + 1);
  assert.deepEqual((await itemsOf(p["la cuenta"].id)).filter((x) => x.origin === "example"), []);
});

test("generated sentences: one call for the batch in the background, checked, kept; a phrase never pays twice", async () => {
  const sam = await someone();
  const p = await add(sam, [["la cuenta", "the bill"], ["¿Cuánto cuesta?", "How much is it?"], ["adiós", "goodbye"]]);
  fake.cloze(
    reply(
      ["¿Me trae la cuenta, por favor?", "Pedimos la cuenta al mesero ya."],
      ["Perdone, ¿cuánto cuesta este melón?", "¿Cuánto cuestan las naranjas hoy?"], // the second is inflected: dropped
      ["Привет, adiós, мой друг, пока.", "Adiós, adiós, hasta mañana."], // wrong script; twice: nothing usable
    ),
    150,
  );
  const runs0 = fake.clozeRuns();
  const first = await queue(sam);
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.items.length, first.body.cloze.waiting, first.body.cloze.writing], [0, 3, true], "the queue doesn't wait for the model");
  // A second look while it writes starts no second call.
  const meanwhile = await stats(sam);
  assert.equal(meanwhile.body.cloze.writing, true);
  await settleClozeFills();
  assert.equal(fake.clozeRuns(), runs0 + 1);
  const [system, user] = [fake.clozeArgs().find((a) => a.startsWith("You write")), fake.clozeArgs().find((a) => a.startsWith("PHRASES"))];
  assert.match(system, /CEFR level A2/);
  assert.match(user, /1\. la cuenta — the bill\n2\. ¿Cuánto cuesta\? — How much is it\?\n3\. adiós — goodbye/);
  assert.ok(fake.clozeArgs().includes("--model") && fake.clozeArgs().includes("claude-sonnet-5-5"));
  assert.deepEqual((await itemsOf(p["la cuenta"].id)).map((x) => x.sentence).sort(), ["¿Me trae la cuenta, por favor?", "Pedimos la cuenta al mesero ya."].sort());
  assert.deepEqual((await itemsOf(p["¿Cuánto cuesta?"].id)).map((x) => x.sentence), ["Perdone, ¿cuánto cuesta este melón?"]);
  // Nothing usable: one row with no sentence marks the phrase as tried.
  assert.deepEqual((await itemsOf(p["adiós"].id)).map((x) => [x.origin, x.sentence]), [["generated", null]]);
  const next = await queue(sam);
  assert.deepEqual(next.body.items.map((i) => i.phraseId).sort(), [p["la cuenta"].id, p["¿Cuánto cuesta?"].id].sort());
  assert.deepEqual(next.body.cloze, { waiting: 0, writing: false });
  assert.doesNotMatch(next.text, /la cuenta|cuánto cuesta/i);
  await settleClozeFills();
  assert.equal(fake.clozeRuns(), runs0 + 1, "no second call: not for the kept ones, not for the one that got nothing");
});

test("a failed call is no cloze for now: nothing kept, nothing marked, and no retry straight away", async () => {
  const sam = await someone();
  const p = await add(sam, [["la mesa", "the table"]]);
  fake.cloze("!fail");
  const runs0 = fake.clozeRuns();
  assert.equal((await queue(sam)).status, 200);
  await settleClozeFills();
  assert.equal(fake.clozeRuns(), runs0 + 1);
  assert.deepEqual(await itemsOf(p["la mesa"].id), []);
  const again = await queue(sam);
  assert.deepEqual([again.status, again.body.items.length, again.body.cloze.waiting, again.body.cloze.writing], [200, 0, 1, false]);
  await settleClozeFills();
  assert.equal(fake.clozeRuns(), runs0 + 1, "waits before trying again");
  // Another language's (another account's) bank isn't held back by it.
  const ana = await someone();
  await add(ana, [["la silla", "the chair"]]);
  fake.cloze("not json at all");
  await queue(ana);
  await settleClozeFills();
  assert.equal(fake.clozeRuns(), runs0 + 2);
});

test("answers: exact with no model; a miss goes to the grader with the gapped sentence; replays, overrides, no alternate kept", async () => {
  const sam = await someone();
  const p = await add(sam, [["la vuelta", "the change"]]);
  await example(p["la vuelta"], "Aquí tiene la vuelta, señora.");
  const [it] = (await queue(sam)).body.items;
  const runs0 = fake.runs();
  const sid = crypto.randomUUID();
  const r = await answer(sam, it, { answer: "La vuelta" }, sid);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.review.verdict, r.body.review.rating, r.body.replayed], ["exact", 3, false]);
  assert.deepEqual(r.body.cloze, { before: "Aquí tiene ", blank: "la vuelta", after: ", señora." });
  assert.equal(fake.runs(), runs0);
  const [rev] = await q("select r.mode, r.card_before->>'cloze_id' as cloze_id, c.skill from reviews r join cards c on c.id = r.card_id where c.phrase_id = $1", [it.phraseId]);
  assert.deepEqual(rev, { mode: "cloze", cloze_id: it.cloze.id, skill: "produce" });
  // The same submit again: the review it wrote, with its sentence.
  const again = await answer(sam, it, { answer: "La vuelta" }, sid);
  assert.deepEqual([again.status, again.body.replayed, again.body.review.id, again.body.cloze?.blank], [200, true, r.body.review.id, "la vuelta"]);
  // Another answer at that version is another tab's: 409.
  assert.equal((await answer(sam, it, { answer: "el cambio" })).status, 409);
  // Override.
  const o = await sam.call("POST", `/api/practice/reviews/${r.body.review.id}/override`, { rating: 1, tz: TZ });
  assert.deepEqual([o.status, o.body.review.rating, o.body.review.verdict, o.body.cloze?.blank], [200, 1, "self", "la vuelta"]);

  // A miss, on a fresh phrase: the grader sees the sentence with a neutral gap.
  const p2 = await add(sam, [["el mercado", "the market"]]);
  await example(p2["el mercado"], "Vamos al mercado.");
  await example(p2["el mercado"], "Mañana voy a el mercado con mi hermana.");
  const it2 = (await queue(sam)).body.items.find((i) => i.phraseId === p2["el mercado"].id);
  assert.ok(it2, "a phrase with a line");
  fake.answer(ACCEPT);
  const acc = await answer(sam, it2, { answer: "la plaza" });
  assert.deepEqual([acc.status, acc.body.review.verdict, acc.body.alternateAdded], [200, "accepted", false]);
  const prompt = fake.lastArgs().join("\n");
  assert.match(prompt, /Sentence shown to the learner: Mañana voy a ___ con mi hermana\./);
  assert.match(prompt, /Meaning given for the gap: the market/);
  assert.deepEqual((await q("select alternates from phrases where id = $1", [it2.phraseId]))[0].alternates, [], "a gap's word isn't kept as an alternate");
});

test("stale and wrong sentences are refused before any grading: another phrase's, unknown, flagged, none named, an edited phrase", async () => {
  const sam = await someone();
  const p = await add(sam, [["la vuelta", "the change"], ["el kilo", "the kilo"]]);
  await example(p["la vuelta"], "Aquí tiene la vuelta, señora.");
  await example(p["el kilo"], "Me da el kilo de tomates, por favor.");
  const items = (await queue(sam)).body.items;
  const vuelta = items.find((i) => i.phraseId === p["la vuelta"].id);
  const kilo = items.find((i) => i.phraseId === p["el kilo"].id);
  fake.answer(REJECT);
  const runs0 = fake.runs();
  const wrong = await answer(sam, vuelta, { answer: "nada", clozeId: kilo.cloze.id });
  assert.deepEqual([wrong.status, wrong.body.error], [409, "this sentence was changed or removed since the card was shown; skip it"]);
  assert.equal((await answer(sam, vuelta, { answer: "nada", clozeId: crypto.randomUUID() })).status, 409);
  const none = await sam.call("POST", "/api/practice/answer", { phraseId: vuelta.phraseId, skill: "produce", drill: "cloze", version: vuelta.version, revision: vuelta.revision, submitId: crypto.randomUUID(), answer: "x" });
  assert.equal(none.status, 400);
  // Flagged: refused, and the route says so.
  assert.equal((await sam.call("POST", `/api/practice/cloze/${kilo.cloze.id}/flag`, {})).status, 200);
  const flagged = await answer(sam, kilo, { answer: "nada" });
  assert.deepEqual([flagged.status, flagged.body.error], [409, "you flagged this sentence, so it can't be answered; skip it"]);
  assert.equal(fake.runs(), runs0, "no grader for any of them");
  assert.equal((await q("select count(*)::int as n from reviews r join cards c on c.id = r.card_id where c.phrase_id = any($1)", [[vuelta.phraseId, kilo.phraseId]]))[0].n, 0);
  // Edited words: the card's revision is stale (409), the old sentence goes
  // at the next fill, and the phrase is asked for again.
  const e = await sam.call("PATCH", `/api/phrases/${vuelta.phraseId}`, { text: "el cambio" });
  assert.equal(e.status, 200, e.text);
  assert.equal((await answer(sam, vuelta, { answer: "la vuelta" })).status, 409);
  // One sentence that holds both phrases once, whichever the batch numbers first.
  const both = "Me da el cambio y el kilo de pan.";
  fake.cloze(reply([both], [both]));
  const runs1 = fake.clozeRuns();
  const after = await queue(sam);
  assert.deepEqual(await itemsOf(vuelta.phraseId), [], "the old line no longer holds the words");
  assert.equal(after.body.cloze.waiting, 2, "the edited phrase, and the one whose only line was flagged");
  await settleClozeFills();
  assert.equal(fake.clozeRuns(), runs1 + 1);
  const fresh = (await queue(sam)).body.items.find((i) => i.phraseId === vuelta.phraseId);
  assert.deepEqual([fresh.cloze.before, fresh.cloze.after, fresh.cloze.origin], ["Me da ", " y el kilo de pan.", "generated"]);
  // The flagged line never comes back; a written one takes its place.
  assert.deepEqual((await queue(sam)).body.items.filter((i) => i.phraseId === kilo.phraseId).map((i) => [i.cloze.origin, i.cloze.id === kilo.cloze.id]), [["generated", false]]);
});

test("flagging: never shown again, a second flag is harmless, another account's sentence is a 404; a spare sentence takes over", async () => {
  const sam = await someone();
  const p = await add(sam, [["la cuenta", "the bill"]]);
  fake.cloze(reply(["¿Me trae la cuenta, por favor?", "Pedimos la cuenta al mesero ya."]));
  await queue(sam);
  await settleClozeFills();
  const [one] = (await queue(sam)).body.items;
  const f = await sam.call("POST", `/api/practice/cloze/${one.cloze.id}/flag`, {});
  assert.deepEqual([f.status, f.body], [200, { flagged: true }]);
  assert.equal((await sam.call("POST", `/api/practice/cloze/${one.cloze.id}/flag`, {})).status, 200);
  const [two] = (await queue(sam)).body.items;
  assert.notEqual(two.cloze.id, one.cloze.id, "the spare");
  await sam.call("POST", `/api/practice/cloze/${two.cloze.id}/flag`, {});
  const none = await queue(sam);
  assert.deepEqual([none.body.items.length, none.body.cloze.waiting], [0, 0], "both flagged: no cloze, and no new call");
  const runs = fake.clozeRuns();
  await settleClozeFills();
  assert.equal(fake.clozeRuns(), runs);
  // Someone else can't flag (or learn about) it.
  const ana = await someone();
  assert.equal((await ana.call("POST", `/api/practice/cloze/${two.cloze.id}/flag`, {})).status, 404);
  assert.equal((await ana.call("POST", `/api/practice/cloze/not-a-uuid/flag`, {})).status, 404);
  assert.equal((await ana.call("GET", `/api/practice/cloze/${two.cloze.id}/flag`)).status, 405);
  assert.ok((await itemsOf(p["la cuenta"].id)).every((x) => x.flagged_at));
});

test("a cloze said aloud: the transcript is graded with the spoken rules, and nothing heard is not an answer", async () => {
  const sam = await someone();
  const p = await add(sam, [["¿Cuánto cuesta?", "How much is it?"]]);
  await example(p["¿Cuánto cuesta?"], "Perdone, ¿cuánto cuesta este melón?");
  const [it] = (await queue(sam)).body.items;
  assert.equal((await answer(sam, it, { answer: "", spoken: true })).status, 400);
  // "cuanto" for "cuánto" said aloud is the same sound: exact.
  const r = await answer(sam, it, { answer: "cuanto cuesta", spoken: true });
  assert.deepEqual([r.status, r.body.review.verdict], [200, "exact"]);
  assert.equal((await q("select mode from reviews where id = $1", [r.body.review.id]))[0].mode, "cloze");
});

test("mixed: produce is a gap when the phrase has a sentence (after it was read), said aloud when not; limits count it once", async () => {
  const sam = await someone();
  const p = await add(sam, [["la vuelta", "the change"], ["la mesa", "the table"]]);
  await example(p["la vuelta"], "Aquí tiene la vuelta, señora.");
  const mixed = () => sam.call("GET", `/api/practice/queue?tz=${TZ}&mode=mixed&length=20`);
  // Nothing read yet: recognize flashcards only.
  const first = await mixed();
  assert.deepEqual(first.body.items.map((i) => [i.skill, i.drill]), [["recognize", "flashcard"], ["recognize", "flashcard"]]);
  for (const it of first.body.items) assert.equal((await answer(sam, it, { answer: it.meaning })).status, 200);
  // Read (and the listen cards taken out of the way), produce comes next.
  const ids = Object.values(p).map((x) => x.id);
  await q(`update cards set due = now() + interval '3 days' where phrase_id = any($1)`, [ids]);
  for (const id of ids) {
    const [c] = await q("select learner_id, language_profile_id from phrases where id = $1", [id]);
    await q(`insert into cards (phrase_id, learner_id, language_profile_id, skill, reps, state, due, last_review) values ($1, $2, $3, 'listen', 1, 2, now() + interval '3 days', now())`, [id, c.learner_id, c.language_profile_id]);
  }
  const second = await mixed();
  const by = Object.fromEntries(second.body.items.map((i) => [i.phraseId, [i.skill, i.drill, !!i.cloze]]));
  assert.deepEqual(by[p["la vuelta"].id], ["produce", "cloze", true]);
  assert.deepEqual(by[p["la mesa"].id], ["produce", "speak", false]);
  assert.equal(second.body.cloze.waiting, 0, "waiting counts only the cloze mode's");
  const st = await sam.call("GET", `/api/practice?tz=${TZ}&mode=mixed`);
  assert.deepEqual([st.body.stats.done.new, st.body.stats.new], [2, 2]);
  await settleClozeFills();
});

test("a Mandarin bank: a run of characters as the gap, readings-free items, a repeated character disqualifies", async () => {
  const lin = await someone([{ ...ADULT, name: "Lin", targetLanguage: "Mandarin Chinese", targetVariant: "Mandarin (Mainland China)", level: "A1" }]);
  const p = await add(lin, [["多少钱", "how much money"], ["一下", "a little / briefly"]]);
  await example(p["多少钱"], "这个苹果多少钱？");
  await example(p["一下"], "请等一下，我看一看。");
  fake.cloze(reply(["你等一下好吗？", "请你等一下我。"]));
  const r = await queue(lin);
  assert.equal(r.status, 200, r.text);
  const it = r.body.items.find((i) => i.phraseId === p["多少钱"].id);
  assert.deepEqual([it.cloze.before, it.cloze.after], ["这个苹果", "？"]);
  assert.doesNotMatch(r.text, /多少钱|duō|shǎo/);
  assert.equal(r.body.items.some((i) => i.phraseId === p["一下"].id), false, "一 appears twice in its line");
  await settleClozeFills();
  const gen = (await itemsOf(p["一下"].id)).map((x) => x.sentence).sort();
  assert.deepEqual(gen, ["你等一下好吗？", "请你等一下我。"].sort());
  const a = await answer(lin, it, { answer: "多 少 钱" });
  assert.deepEqual([a.status, a.body.review.verdict, a.body.cloze.blank], [200, "exact", "多少钱"]);
});

test("deletes: a phrase takes its sentences with it; a dropped example takes its item; the reader role sees none of it", async () => {
  const sam = await someone();
  const p = await add(sam, [["la vuelta", "the change"], ["la cuenta", "the bill"]]);
  const ex = await example(p["la vuelta"], "Aquí tiene la vuelta, señora.");
  await example(p["la cuenta"], "¿Me trae la cuenta, por favor?");
  await queue(sam);
  await settleClozeFills();
  assert.equal((await itemsOf(p["la vuelta"].id)).length, 1);
  await q("delete from phrase_examples where id = $1", [ex.exampleId]);
  assert.deepEqual(await itemsOf(p["la vuelta"].id), []);
  assert.equal((await sam.call("DELETE", `/api/phrases/${p["la cuenta"].id}`)).status, 200);
  assert.deepEqual(await itemsOf(p["la cuenta"].id), []);
  // The content agent's read-only role has no grant on cloze_items.
  await q("begin");
  try {
    await q("set local role lingo_reader");
    await assert.rejects(q("select sentence from cloze_items"), /permission denied/);
  } finally {
    await q("rollback");
  }
});

test("kids learners don't practise: the cloze queue and the flag route are 403", async () => {
  const pip = await someone([KID]);
  assert.equal((await queue(pip)).status, 403);
  assert.equal((await pip.call("POST", `/api/practice/cloze/${crypto.randomUUID()}/flag`, {})).status, 403);
});
