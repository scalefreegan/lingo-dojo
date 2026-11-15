// The phrase bank end to end over HTTP: what a voice turn's glosses and a
// conversation's scenario lists put in (web/server/conversations.ts), and
// the bank's routes (web/server/phrases.ts), on the real plugin with an
// in-process PGlite and a stand-in `claude` first on PATH. Every name here
// is made up.
//   node --test scripts/tests/phrases.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture, write } from "./helpers.mjs";
import { ADULT, addUser, client, tab } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "no-such.env");
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];

// A scenario for every language: English meanings only (pending phrases).
write(
  root,
  "scenarios/errand.md",
  ["---", "id: errand", "title: An errand", "summary: Out shopping.", "phrases:", "  - market", "  - How much is it?", "  - Keep the change", "---", "An errand."].join("\n"),
);

const { apiPlugins } = await import("../../web/server/api.ts");

const fake = fakeClaude();
const REPLY = [
  "NARRATOR-F: Bienvenido al <t>mercado</t>.",
  "CHARACTER-F: <t>¿Qué le doy, joven? Quédese con la vuelta.</t>",
  "GLOSS: mercado = market | ¿Qué le doy, joven? = What can I get you, young man? | la vuelta = the change",
  "STAGE: scene",
].join("\n");

const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  fake.restore();
  await close();
  await testDb.close();
});
beforeEach(() => fake.answer(REPLY));
const OTHER = ["CHARACTER-F: <t>Le doy el kilo a veinte.</t>", "GLOSS: el kilo = the kilo", "STAGE: scene"].join("\n");
/** The stand-in's next replies gloss "el kilo" instead. */
const fakeOther = () => fake.answer(OTHER);

const pack = (extra = {}) => ({ title: "", created: "", scenario: "market", quick_scenario: "", units: [], overrides: {}, notes: "", ...extra });

let n = 0;
/** A fresh account with one adult (Spanish) learner, logged in and picked. */
async function someone(learners = [ADULT]) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  return c;
}

async function start(who, p = pack()) {
  const r = await who.call("POST", "/api/conversations", { mode: "adult", pack: p, title: "Session" });
  assert.equal(r.status, 201, r.text);
  return r.body.conversation;
}

const turn = (who, conversationId, history, message, p = pack()) =>
  who.call("POST", "/api/voice/turn", { mode: "adult", pack: p, history, message, elapsedMs: 0, conversationId });

const after1 = (history, message, r) => [
  ...history,
  ...(message ? [{ role: "learner", text: message }] : []),
  { role: "master", lines: r.body.lines, glosses: r.body.glosses, choices: r.body.choices, stage: r.body.stage ?? undefined, castNotes: r.body.castNotes },
];

const bank = (who, query = "") => who.call("GET", `/api/phrases${query}`);
const byText = (list) => Object.fromEntries(list.map((p) => [p.text ?? `(${p.meaning})`, p]));

test("a conversation's start puts its scenario's vocab in the bank, unseen and with no cards", async () => {
  const sam = await someone();
  await start(sam);
  const r = await bank(sam);
  assert.equal(r.status, 200, r.text);
  const got = byText(r.body.phrases);
  assert.deepEqual(Object.keys(got).sort(), ["kilo | medio", "¿Cuánto cuesta?"]);
  const p = got["¿Cuánto cuesta?"];
  assert.deepEqual(
    [p.source, p.meaning, p.lang, p.pending, p.seenCount, p.lastSeenAt, p.mastery, p.due, p.cardCount],
    ["scenario", "How much is it?", "es-MX", false, 0, null, "New", null, 0],
  );
  assert.deepEqual(r.body.language, { targetLanguage: "Spanish", targetVariant: "Mexican Spanish", locale: "es-MX" });
  // A second start of the same scene adds nothing new.
  await start(sam);
  assert.equal((await bank(sam)).body.total, 2);
});

test("a turn's glosses are seen inside the turn's transaction: upserted, counted, an example from the reply, a recognize card; no review", async () => {
  const sam = await someone();
  const c = await start(sam);
  const r0 = await turn(sam, c.id, [], "");
  assert.equal(r0.status, 200, r0.text);
  assert.equal(r0.body.saved, true);
  const [reply] = await q("select id from turns where conversation_id = $1 and role = 'master'", [c.id]);
  let got = byText((await bank(sam)).body.phrases);
  // The four-word gloss is a sentence's translation: not a phrase.
  assert.equal(got["¿Qué le doy, joven?"], undefined);
  const mercado = got["mercado"];
  // Its only target-language line is the word itself: no example.
  assert.deepEqual([mercado.source, mercado.meaning, mercado.seenCount, mercado.cardCount, mercado.exampleCount, mercado.mastery], ["gloss", "market", 1, 1, 0, "New"]);
  assert.ok(mercado.lastSeenAt && mercado.firstSeenAt);
  assert.equal(mercado.due, null, "the recognize card is new, waiting to be learned, not due");
  const vuelta = got["la vuelta"];
  const detail = (await sam.call("GET", `/api/phrases/${vuelta.id}`)).body.phrase;
  assert.deepEqual(detail.examples.map((e) => [e.sentence, e.speaker, e.conversationId]), [["¿Qué le doy, joven? Quédese con la vuelta.", "character", c.id]]);
  const [ex] = await q("select turn_id from phrase_examples where phrase_id = $1", [vuelta.id]);
  assert.equal(ex.turn_id, reply.id, "the example points at the reply that glossed it");
  const counts = (await bank(sam)).body.counts;
  // The two glossed and the scene's two from its list: all never practised.
  assert.deepEqual([counts.new, counts.due, counts.bands.New], [4, 0, 4], "met in a session: new, nothing due yet");

  // The next turn glosses it again: seen twice, still one card, and the same
  // line isn't kept twice.
  const h1 = after1([], "", r0);
  const r1 = await turn(sam, c.id, h1, "Unos mangos.");
  assert.equal(r1.status, 200, r1.text);
  got = byText((await bank(sam)).body.phrases);
  assert.deepEqual([got["mercado"].seenCount, got["mercado"].cardCount], [2, 1]);
  assert.equal(got["la vuelta"].exampleCount, 1, "the same line isn't kept twice");
  assert.equal((await q("select count(*)::int as n from reviews"))[0].n, 0, "seeing is not a review");
  assert.equal((await q("select count(*)::int as n from phrases where last_practiced_at is not null"))[0].n, 0);

  // A turn that only replays the history (its replies came from the
  // browser) captures nothing new from them: one sighting per reply.
  const r2 = await turn(sam, c.id, after1(h1, "Unos mangos.", r1), "Gracias.");
  assert.equal(r2.status, 200);
  assert.equal(byText((await bank(sam)).body.phrases)["mercado"].seenCount, 3);
});

test("words for a pending scenario phrase's meaning absorb it: its star and note carried, the pending row gone", async () => {
  const sam = await someone();
  const c = await start(sam, pack({ scenario: "errand" }));
  const list = (await bank(sam, "?show=pending")).body.phrases;
  assert.deepEqual(list.map((p) => p.meaning).sort(), ["How much is it?", "Keep the change", "market"]);
  assert.ok(list.every((p) => p.text === null && p.cardCount === 0));
  // "the change" was starred while pending, "market" given a note; the
  // market scene's vocab then pairs "How much is it?" with words.
  const change = list.find((p) => p.meaning === "Keep the change");
  await q("update phrases set meaning = 'the change', meaning_norm = 'the change', starred = true where id = $1", [change.id]);
  await sam.call("PATCH", `/api/phrases/${list.find((p) => p.meaning === "market").id}`, { note: "the big one downtown" });
  await start(sam);
  const cuanto = byText((await bank(sam)).body.phrases)["¿Cuánto cuesta?"];
  assert.deepEqual([cuanto.source, cuanto.meaning], ["scenario", "How much is it?"]);
  assert.equal(byText((await bank(sam, "?show=pending")).body.phrases)["(How much is it?)"], undefined, "absorbed");
  // Words for "the change" already in the bank: the pending row goes into
  // them, its star kept.
  await sam.call("POST", "/api/phrases", { text: "la vuelta", starred: false });
  const r = await turn(sam, c.id, [], "");
  assert.equal(r.status, 200, r.text);
  const got = byText((await bank(sam)).body.phrases);
  // Its provenance is the scene's: it was the scene's phrase before a gloss
  // gave it words.
  assert.deepEqual([got["mercado"].source, got["mercado"].seenCount, got["mercado"].meaning, got["mercado"].note], ["scenario", 1, "market", "the big one downtown"]);
  assert.equal(got["la vuelta"].starred, true, "the pending row's star carried over");
  assert.equal(got["(the change)"], undefined);
  assert.equal((await bank(sam, "?show=pending")).body.total, 0);
});

test("a stored reply the browser dropped takes its sightings with it", async () => {
  const sam = await someone();
  const c = await start(sam, pack({ scenario: "" }));
  assert.equal((await turn(sam, c.id, [], "")).status, 200);
  // A starred phrase the dropped reply also glossed stays; the rest of
  // what it alone added goes.
  await sam.call("POST", "/api/phrases", { text: "mercado" });
  const [first] = await q("select id from turns where conversation_id = $1 and role = 'master'", [c.id]);
  // The next turn's history leaves the stored reply out: it is deleted and
  // the new one stored in its place.
  fakeOther();
  const r = await turn(sam, c.id, [], "Hola.");
  assert.equal(r.status, 200, r.text);
  assert.equal((await q("select count(*)::int as n from turns where id = $1", [first.id]))[0].n, 0, "the dropped reply is gone");
  const got = byText((await bank(sam)).body.phrases);
  assert.equal(got["la vuelta"], undefined, "seen only in the dropped reply, untouched since: gone");
  assert.deepEqual([got["mercado"].seenCount, got["mercado"].lastSeenAt, got["mercado"].cardCount, got["mercado"].starred], [0, null, 0, true], "starred: kept, unseen");
  assert.deepEqual([got["el kilo"].seenCount], [1], "the new reply's own gloss");
  assert.equal((await q("select count(*)::int as n from phrase_examples where turn_id is null"))[0].n, 0, "no example left pointing nowhere");

  // A phrase seen in a reply that stays is only counted down.
  const c2 = await start(sam, pack({ scenario: "" }));
  const r1 = await turn(sam, c2.id, [], "");
  const h1 = after1([], "", r1);
  await turn(sam, c2.id, h1, "Uno.");
  assert.equal(byText((await bank(sam)).body.phrases)["el kilo"].seenCount, 3);
  // Drop the last reply: the history ends at the learner's line before it.
  const r3 = await turn(sam, c2.id, [...h1, { role: "learner", text: "Uno." }], "Otro.");
  assert.equal(r3.status, 200, r3.text);
  assert.equal((await q("select count(*)::int as n from turns where conversation_id = $1 and role = 'master'", [c2.id]))[0].n, 2);
  assert.equal(byText((await bank(sam)).body.phrases)["el kilo"].seenCount, 3, "one reply dropped, one added");
});

test("a dropped reply never deletes a phrase the learner edited, even only its meaning; a later gloss keeps the learner's meaning", async () => {
  const sam = await someone();
  const c = await start(sam, pack({ scenario: "" }));
  assert.equal((await turn(sam, c.id, [], "")).status, 200);
  const before = byText((await bank(sam)).body.phrases);
  // In another tab, after Stop: the meaning corrected, nothing else; and a
  // PATCH that changes no visible field (unstarring an unstarred phrase).
  const fix = await sam.call("PATCH", `/api/phrases/${before["la vuelta"].id}`, { meaning: "the change (money back)" });
  assert.equal(fix.status, 200, fix.text);
  assert.equal((await sam.call("PATCH", `/api/phrases/${before["mercado"].id}`, { starred: false })).status, 200);
  const [first] = await q("select id from turns where conversation_id = $1 and role = 'master'", [c.id]);
  fakeOther();
  const r = await turn(sam, c.id, [], "Hola.");
  assert.equal(r.status, 200, r.text);
  assert.equal((await q("select count(*)::int as n from turns where id = $1", [first.id]))[0].n, 0, "the dropped reply is gone");
  let got = byText((await bank(sam)).body.phrases);
  assert.ok(got["la vuelta"], "edited by hand: kept");
  assert.deepEqual([got["la vuelta"].meaning, got["la vuelta"].seenCount, got["la vuelta"].lastSeenAt], ["the change (money back)", 0, null], "kept with the learner's meaning, unseen");
  assert.ok(got["mercado"], "any PATCH counts as an edit");

  // A later gloss of it doesn't put the dojo master's meaning back.
  fake.answer(REPLY);
  const c2 = await start(sam, pack({ scenario: "" }));
  assert.equal((await turn(sam, c2.id, [], "")).status, 200);
  got = byText((await bank(sam)).body.phrases);
  assert.deepEqual([got["la vuelta"].meaning, got["la vuelta"].seenCount], ["the change (money back)", 1]);
});

test("undo acts only on what the dropped turn recorded: a reply whose capture failed changes nothing when dropped", async () => {
  const sam = await someone();
  // Turn A, in one conversation, records "mercado".
  const a = await start(sam, pack({ scenario: "" }));
  assert.equal((await turn(sam, a.id, [], "")).status, 200);
  const seenA = byText((await bank(sam)).body.phrases)["mercado"];
  assert.equal(seenA.seenCount, 1);
  // Turn B, in another, glosses it too, but its capture fails (rolled back
  // whole: no sighting, no count); the reply is stored all the same.
  const b = await start(sam, pack({ scenario: "" }));
  await q(`create function no_sightings() returns trigger language plpgsql as $$ begin raise exception 'bank down'; end $$`);
  await q(`create trigger no_sightings before insert on phrase_sightings for each row execute function no_sightings()`);
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal((await turn(sam, b.id, [], "")).body.saved, true);
  } finally {
    console.error = orig;
    await q(`drop trigger no_sightings on phrase_sightings`);
    await q(`drop function no_sightings()`);
  }
  assert.equal(byText((await bank(sam)).body.phrases)["mercado"].seenCount, 1, "B's failed capture counted nothing");
  // B's reply is dropped: A's sighting is untouched.
  fakeOther();
  const r = await turn(sam, b.id, [], "Hola.");
  assert.equal(r.status, 200, r.text);
  const got = byText((await bank(sam)).body.phrases);
  assert.ok(got["mercado"] && got["la vuelta"], "still there: A still sees them");
  assert.deepEqual([got["mercado"].seenCount, got["mercado"].lastSeenAt, got["mercado"].firstSeenAt], [1, seenA.lastSeenAt, seenA.firstSeenAt]);
  assert.equal(got["el kilo"].seenCount, 1, "B's new reply recorded");
});

test("a scene's phrase given words by a gloss stays in the bank when that reply is dropped", async () => {
  const sam = await someone();
  // The errand scene adds pending "market"; the reply's "mercado = market"
  // gives it words (absorbed: the complete row keeps the scene's provenance).
  const c = await start(sam, pack({ scenario: "errand" }));
  assert.equal((await turn(sam, c.id, [], "")).status, 200);
  let got = byText((await bank(sam)).body.phrases);
  assert.deepEqual([got["mercado"].source, got["mercado"].seenCount], ["scenario", 1]);
  assert.equal(got["la vuelta"].source, "gloss");
  fakeOther();
  const r = await turn(sam, c.id, [], "Hola.");
  assert.equal(r.status, 200, r.text);
  got = byText((await bank(sam)).body.phrases);
  // Kept, with the words it was given, unseen and with no card.
  assert.deepEqual(
    [got["mercado"].source, got["mercado"].meaning, got["mercado"].seenCount, got["mercado"].lastSeenAt, got["mercado"].cardCount],
    ["scenario", "market", 0, null, 0],
  );
  assert.equal(got["la vuelta"], undefined, "a gloss-only phrase that reply made, untouched: gone");

  // Words a reply glossed that a scene's list then names are the scene's
  // too: dropping that reply keeps them.
  fake.answer(["CHARACTER-F: <t>¿Cuánto cuesta?</t>", "GLOSS: ¿Cuánto cuesta? = How much is it?", "STAGE: scene"].join("\n"));
  const ana = await someone();
  const c2 = await start(ana, pack({ scenario: "" }));
  assert.equal((await turn(ana, c2.id, [], "")).status, 200);
  assert.equal(byText((await bank(ana)).body.phrases)["¿Cuánto cuesta?"].source, "gloss");
  await start(ana); // the market scene lists it
  assert.equal(byText((await bank(ana)).body.phrases)["¿Cuánto cuesta?"].source, "scenario");
  fakeOther();
  assert.equal((await turn(ana, c2.id, [], "Hola.")).status, 200);
  assert.equal(byText((await bank(ana)).body.phrases)["¿Cuánto cuesta?"].seenCount, 0, "kept, unseen");
});

test("two sightings in one conversation, one dropped: counted once, last seen the other's", async () => {
  const sam = await someone();
  const c = await start(sam, pack({ scenario: "" }));
  const r1 = await turn(sam, c.id, [], "");
  const h1 = after1([], "", r1);
  await turn(sam, c.id, h1, "Uno.");
  const [reply1] = await q("select id from turns where conversation_id = $1 and role = 'master' order by idx limit 1", [c.id]);
  const [first] = await q("select s.seen_at from phrase_sightings s join phrases p on p.id = s.phrase_id where p.text = 'mercado' and s.turn_id = $1", [reply1.id]);
  let m = byText((await bank(sam)).body.phrases)["mercado"];
  assert.equal(m.seenCount, 2);
  assert.notEqual(m.lastSeenAt, first.seen_at.toISOString());
  // Drop the second reply (the history ends at the learner's line before it).
  fakeOther();
  const r3 = await turn(sam, c.id, [...h1, { role: "learner", text: "Uno." }], "Otro.");
  assert.equal(r3.status, 200, r3.text);
  m = byText((await bank(sam)).body.phrases)["mercado"];
  assert.deepEqual([m.seenCount, m.lastSeenAt, m.firstSeenAt], [1, first.seen_at.toISOString(), first.seen_at.toISOString()]);
  assert.equal((await q("select count(*)::int as n from phrase_sightings where turn_id is null"))[0].n, 0);
});

test("absorbing a pending phrase keeps everything the learner set on either row", async () => {
  const sam = await someone();
  await start(sam, pack({ scenario: "errand" }));
  const list = (await bank(sam, "?show=pending")).body.phrases;
  const market = list.find((p) => p.meaning === "market");
  // The pending "market" suspended and noted; "mercado" already in the bank
  // with a note of its own.
  assert.equal((await sam.call("PATCH", `/api/phrases/${market.id}`, { note: "the big one downtown", suspended: true })).status, 200);
  assert.equal((await sam.call("POST", "/api/phrases", { text: "mercado", note: "open on Sundays", starred: false })).status, 201);
  const c = await start(sam, pack({ scenario: "" }));
  assert.equal((await turn(sam, c.id, [], "")).status, 200);
  const got = byText((await bank(sam, "?show=all&limit=200")).body.phrases);
  assert.equal(list.length, 3);
  assert.equal((await bank(sam, "?show=pending")).body.phrases.find((p) => p.meaning === "market"), undefined, "absorbed");
  assert.deepEqual([got["mercado"].note, got["mercado"].suspended, got["mercado"].meaning], ["open on Sundays\n\nthe big one downtown", true, "market"]);
});

test("a session in another language than the profile's (a pack override) leaves the bank alone", async () => {
  const sam = await someone();
  const german = pack({ overrides: { target_language: "German" } });
  const c = await start(sam, german);
  const r = await turn(sam, c.id, [], "", german);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.saved, true, "the turn itself is saved");
  assert.equal((await bank(sam)).body.total, 0, "neither the Spanish scene's vocab nor the glosses");
});

test("a capture that fails costs the bank that turn, never the turn", async () => {
  const sam = await someone();
  const c = await start(sam, pack({ scenario: "" }));
  await q(`create function no_phrases() returns trigger language plpgsql as $$ begin raise exception 'bank down'; end $$`);
  await q(`create trigger no_phrases before insert or update on phrases for each row execute function no_phrases()`);
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const r = await turn(sam, c.id, [], "");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.saved, true);
  } finally {
    console.error = orig;
    await q(`drop trigger no_phrases on phrases`);
    await q(`drop function no_phrases()`);
  }
  assert.equal((await q("select count(*)::int as n from turns where conversation_id = $1 and role = 'master'", [c.id]))[0].n, 1, "the reply is stored");
  assert.equal((await bank(sam)).body.total, 0);
  assert.ok(errors.some((e) => /weren't recorded/.test(e)), "and the failure is logged");
});

test("add, star, look up, edit, suspend and delete through the routes", async () => {
  const sam = await someone();
  // Add: a manual phrase, starred, no card.
  let r = await sam.call("POST", "/api/phrases", { text: " ¿A cómo? ", meaning: "how much?", note: "market talk" });
  assert.equal(r.status, 201, r.text);
  const p = r.body.phrase;
  assert.deepEqual([p.text, p.meaning, p.note, p.source, p.starred, p.lang, p.cardCount, p.created], ["¿A cómo?", "how much?", "market talk", "manual", true, "es-MX", 0, undefined]);
  assert.equal(r.body.created, true);
  // The same words again (another spelling of them): starred, and the
  // phrase keeps its own meaning and note.
  r = await sam.call("POST", "/api/phrases", { text: "a cómo", meaning: "price?" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.created, r.body.phrase.id, r.body.phrase.meaning, r.body.phrase.note], [false, p.id, "how much?", "market talk"]);
  // Lookup (the transcript's ☆): by words, whatever their punctuation.
  assert.equal((await sam.call("GET", `/api/phrases/lookup?text=${encodeURIComponent("¡A cómo!")}`)).body.phrase.id, p.id);
  assert.equal((await sam.call("GET", "/api/phrases/lookup?text=nada")).body.phrase, null);
  assert.equal((await sam.call("GET", "/api/phrases/lookup")).body.phrase, null);
  // A NUL (or another control) in a lookup is dropped, not a 500.
  r = await sam.call("GET", `/api/phrases/lookup?text=${encodeURIComponent("¿A\u0000 cómo?")}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.phrase.id, p.id);
  // Unstar, edit, suspend.
  r = await sam.call("PATCH", `/api/phrases/${p.id}`, { starred: false, meaning: "how much (is it)?", note: "" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.phrase.starred, r.body.phrase.meaning, r.body.phrase.note], [false, "how much (is it)?", null]);
  r = await sam.call("PATCH", `/api/phrases/${p.id}`, { text: "¿A cómo es?" });
  assert.equal(r.body.phrase.text, "¿A cómo es?");
  r = await sam.call("PATCH", `/api/phrases/${p.id}`, { suspended: true });
  assert.equal(r.body.phrase.suspended, true);
  assert.equal((await bank(sam, "?show=suspended")).body.total, 1);
  // Words another phrase has: 409, nothing changed.
  const other = (await sam.call("POST", "/api/phrases", { text: "la vuelta" })).body.phrase;
  r = await sam.call("PATCH", `/api/phrases/${other.id}`, { text: "¡a cómo es!" });
  assert.equal(r.status, 409, r.text);
  assert.equal((await sam.call("GET", `/api/phrases/${other.id}`)).body.phrase.text, "la vuelta");
  // Filters and search over the list.
  assert.deepEqual((await bank(sam, "?show=starred")).body.phrases.map((x) => x.text), ["la vuelta"]);
  assert.deepEqual((await bank(sam, "?q=COMO")).body.phrases.map((x) => x.text), ["¿A cómo es?"]);
  assert.equal((await bank(sam, "?sort=alpha&limit=1")).body.nextOffset, 1);
  // Bad input.
  for (const [method, url, body] of [
    ["POST", "/api/phrases", {}],
    ["POST", "/api/phrases", { text: "x\u0000" }],
    ["POST", "/api/phrases", { text: "¿?" }],
    ["PATCH", `/api/phrases/${p.id}`, {}],
    ["PATCH", `/api/phrases/${p.id}`, { text: "" }],
    ["PATCH", `/api/phrases/${p.id}`, { starred: "yes" }],
  ]) {
    assert.equal((await sam.call(method, url, body)).status, 400, `${method} ${url} ${JSON.stringify(body)}`);
  }
  assert.equal((await sam.call("PUT", "/api/phrases", {})).status, 405);
  assert.equal((await sam.call("GET", `/api/phrases/${p.id}/x`)).status, 404);
  // Delete: for good, with its cards and examples.
  assert.equal((await sam.call("DELETE", `/api/phrases/${p.id}`)).status, 200);
  assert.equal((await sam.call("GET", `/api/phrases/${p.id}`)).status, 404);
  assert.equal((await sam.call("DELETE", `/api/phrases/${p.id}`)).status, 404);
  assert.equal((await sam.call("GET", "/api/phrases/not-a-uuid")).status, 404);
});

test("a scene phrase deleted from the bank stays deleted at the scene's next start; adding it by hand brings it back", async () => {
  const sam = await someone();
  await start(sam);
  const cuanto = byText((await bank(sam)).body.phrases)["¿Cuánto cuesta?"];
  assert.equal((await sam.call("DELETE", `/api/phrases/${cuanto.id}`)).status, 200);
  await start(sam, pack({ scenario: "errand" }));
  const [pending] = (await bank(sam, "?show=pending&q=market")).body.phrases;
  assert.equal((await sam.call("DELETE", `/api/phrases/${pending.id}`)).status, 200);
  await start(sam);
  await start(sam, pack({ scenario: "errand" }));
  const got = byText((await bank(sam)).body.phrases);
  assert.equal(got["¿Cuánto cuesta?"], undefined, "vocab not re-added");
  assert.equal(got["(market)"], undefined, "nor a pending meaning");
  assert.equal(got["(How much is it?)"], undefined, "nor the meaning of the deleted vocab");
  assert.ok(got["kilo | medio"], "the rest of the list still comes");
  // Added by hand, it is the learner's again, and the scene keeps it.
  assert.equal((await sam.call("POST", "/api/phrases", { text: "¿Cuánto cuesta?" })).status, 201);
  await start(sam);
  assert.equal(byText((await bank(sam)).body.phrases)["¿Cuánto cuesta?"].meaning, "How much is it?", "the scene fills its meaning in");
});

test("a pending phrase given words becomes complete; its meaning can't be cleared while it has none", async () => {
  const sam = await someone();
  await start(sam, pack({ scenario: "errand" }));
  const [market] = (await bank(sam, "?show=pending&q=market")).body.phrases;
  assert.equal((await sam.call("PATCH", `/api/phrases/${market.id}`, { meaning: "" })).status, 400);
  // Another pending phrase's meaning: 409.
  assert.equal((await sam.call("PATCH", `/api/phrases/${market.id}`, { meaning: "keep the change" })).status, 409);
  const r = await sam.call("PATCH", `/api/phrases/${market.id}`, { text: "el mercado" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.phrase.pending, r.body.phrase.text, r.body.phrase.meaning], [false, "el mercado", "market"]);
  assert.equal((await bank(sam, "?show=pending")).body.total, 2);
});

test("each language has its own bank; a tab on the other language is 409 stale_learner", async () => {
  const kim = await someone([{ ...ADULT, name: "Kim" }]);
  const spanishId = kim.languageId;
  const hola = (await kim.call("POST", "/api/phrases", { text: "hola" })).body.phrase;
  const stale = tab(base, kim);
  await kim.addLanguage({ target_language: "German", target_variant: "", level: "B1" });
  // German: an empty bank, and Spanish's phrase is nobody's here.
  assert.equal((await bank(kim)).body.total, 0);
  assert.equal((await bank(kim)).body.language.locale, "de-DE");
  for (const [method, body] of [["GET"], ["PATCH", { starred: false }], ["DELETE"]]) {
    assert.equal((await kim.call(method, `/api/phrases/${hola.id}`, body)).status, 404, method);
  }
  assert.equal((await kim.call("GET", "/api/phrases/lookup?text=hola")).body.phrase, null);
  const hallo = (await kim.call("POST", "/api/phrases", { text: "hallo", meaning: "hello" })).body.phrase;
  assert.equal(hallo.lang, "de-DE");
  // Even "hola" again is German's own row.
  assert.notEqual((await kim.call("POST", "/api/phrases", { text: "hola" })).body.phrase.id, hola.id);
  // The tab still showing Spanish is stale on every route.
  for (const [method, url, body] of [
    ["GET", "/api/phrases"],
    ["POST", "/api/phrases", { text: "x" }],
    ["GET", "/api/phrases/lookup?text=hola"],
    ["GET", `/api/phrases/${hola.id}`],
    ["PATCH", `/api/phrases/${hola.id}`, { starred: true }],
    ["DELETE", `/api/phrases/${hola.id}`],
  ]) {
    const r = await stale.call(method, url, body);
    assert.equal(r.status, 409, `${method} ${url}`);
    assert.equal(r.body.code, "stale_learner");
  }
  // Back to Spanish: its bank, untouched.
  await kim.pickLanguage(spanishId);
  assert.deepEqual((await bank(kim)).body.phrases.map((p) => p.id), [hola.id]);
  assert.equal((await kim.call("GET", `/api/phrases/${hallo.id}`)).status, 404);
});

test("another learner of the account, or another account, can't see or change a bank, even by id", async () => {
  const ana = await someone([{ ...ADULT, name: "Ana" }, { ...ADULT, name: "Ben" }]);
  const p = (await ana.call("POST", "/api/phrases", { text: "secreto" })).body.phrase;
  const ben = tab(base, ana);
  await ben.pick("Ben");
  const lee = await someone([{ ...ADULT, name: "Lee" }]);
  for (const who of [ben, lee]) {
    assert.equal((await bank(who)).body.total, 0);
    assert.equal((await who.call("GET", `/api/phrases/${p.id}`)).status, 404);
    assert.equal((await who.call("PATCH", `/api/phrases/${p.id}`, { starred: false })).status, 404);
    assert.equal((await who.call("DELETE", `/api/phrases/${p.id}`)).status, 404);
    assert.equal((await who.call("GET", "/api/phrases/lookup?text=secreto")).body.phrase, null);
  }
  // No session: 401.
  assert.equal((await client(base).call("GET", "/api/phrases")).status, 401);
  // Ana's phrase is as she left it.
  await ana.pick("Ana");
  assert.equal((await ana.call("GET", `/api/phrases/${p.id}`)).body.phrase.starred, true);
});

test("metrics: the weakest card's band, the earliest due, trouble from recent lapses, and the filters over them", async () => {
  const sam = await someone();
  const c = await start(sam, pack({ scenario: "" }));
  await turn(sam, c.id, [], "");
  const { mercado, "la vuelta": vuelta } = byText((await bank(sam)).body.phrases);
  // Practice is a later phase: write its rows by hand. mercado's recognize
  // card is well known, its produce card shaky; la vuelta lapsed twice
  // this month (Again on a card in review) and once long ago.
  await q(`update cards set state = 2, reps = 6, stability = 40, due = now() + interval '30 days' where phrase_id = $1`, [mercado.id]);
  await q(
    `insert into cards (phrase_id, learner_id, language_profile_id, skill, state, reps, stability, due) select id, learner_id, language_profile_id, 'produce', 2, 2, 5, now() + interval '2 days' from phrases where id = $1`,
    [mercado.id],
  );
  const [card] = await q(`update cards set state = 3, reps = 4, stability = 1, due = now() - interval '1 day' where phrase_id = $1 returning id, learner_id, language_profile_id`, [vuelta.id]);
  for (const ago of ["1 day", "10 days", "60 days"]) {
    await q(
      `insert into reviews (card_id, learner_id, language_profile_id, mode, rating, card_before, reviewed_at) values ($1, $2, $3, 'flashcard', 1, '{"state": 2}', now() - interval '${ago}')`,
      [card.id, card.learner_id, card.language_profile_id],
    );
  }
  await q(`insert into reviews (card_id, learner_id, language_profile_id, mode, rating, card_before) values ($1, $2, $3, 'flashcard', 1, '{"state": 1}')`, [
    card.id, card.learner_id, card.language_profile_id,
  ]);
  const got = byText((await bank(sam)).body.phrases);
  assert.equal(got["mercado"].mastery, "Familiar", "the produce card holds it back");
  assert.ok(new Date(got["mercado"].due) > new Date(), "its earliest due: the produce card's");
  assert.deepEqual([got["la vuelta"].mastery, got["la vuelta"].lapses, got["la vuelta"].trouble], ["Learning", 2, true], "an Again while learning isn't a lapse; one 60 days ago is too old");
  const r = await bank(sam, "?show=due");
  assert.deepEqual(r.body.phrases.map((p) => p.text), ["la vuelta"]);
  assert.deepEqual([r.body.counts.trouble, r.body.counts.due, r.body.counts.bands.Familiar], [1, 1, 1]);
  assert.deepEqual((await bank(sam, "?show=trouble")).body.phrases.map((p) => p.text), ["la vuelta"]);
  assert.deepEqual((await bank(sam, "?band=Familiar")).body.phrases.map((p) => p.text), ["mercado"]);
  assert.deepEqual((await bank(sam, "?sort=weakest")).body.phrases.map((p) => p.text), ["la vuelta", "mercado"]);
});
