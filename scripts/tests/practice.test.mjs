// The Practice tab's pure half (scripts/practice.mjs): the learner's day,
// card versions, the queue and its limits, input checks, the local match,
// the verdict a grade records, and alternates.
//   node --test scripts/tests/practice.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { newCard, review } from "../fsrs.mjs";
import { parseGraderReply } from "../match.mjs";
import {
  DAILY_LIMITS, MAX_ALTERNATES, MAX_ANSWER, keepable, phraseRevision, buildQueue, candidates, cardVersion, dayStart, gradeOutcome, graderQuestion, isVersion, localMatch, needsGrader,
  readAnswerInput, readDirection, readLength, readOverrideInput, readUtcOffset, remaining, withAlternate, withoutAlternate,
} from "../practice.mjs";

const NOW = new Date("2026-11-15T18:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
/** A card of `skill` reviewed once (Good) `daysAgo` days before NOW, so
 *  due about then plus its interval; or new (reps 0) with `fresh`. */
function card(skill, { fresh = false, due = null, reps = 1 } = {}) {
  if (fresh) return { skill, ...newCard(NOW) };
  const c = review(newCard(new Date(NOW.getTime() - 10 * DAY)), 3, new Date(NOW.getTime() - 10 * DAY)).card;
  return { skill, ...c, reps, due: (due ?? c.due) };
}
function phrase(extra = {}) {
  return { id: uuid(), text: `palabra ${n}`, meaning: `word ${n}`, lang: "es-MX", starred: false, suspended: false, lastSeenAt: null, createdAt: new Date(NOW.getTime() - DAY), cards: [], ...extra };
}
const past = (h) => new Date(NOW.getTime() - h * HOUR).toISOString();
const future = (h) => new Date(NOW.getTime() + h * HOUR).toISOString();

test("dayStart: the last 4 a.m. in the learner's own time", () => {
  // 18:00 UTC is 11:00 at UTC-7: the day began at 04:00 local, 11:00 UTC.
  assert.equal(dayStart(NOW, -420).toISOString(), "2026-11-15T11:00:00.000Z");
  // At 03:30 local (10:30 UTC) it is still yesterday's day.
  assert.equal(dayStart(new Date("2026-11-15T10:30:00Z"), -420).toISOString(), "2026-11-14T11:00:00.000Z");
  // UTC+9: 18:00 UTC is 03:00 next morning there, before the rollover.
  assert.equal(dayStart(NOW, 540).toISOString(), "2026-11-14T19:00:00.000Z");
  assert.equal(dayStart(NOW, 0).toISOString(), "2026-11-15T04:00:00.000Z");
});

test("readUtcOffset, readLength, readDirection: request values, with safe defaults", () => {
  assert.equal(readUtcOffset("-420"), -420);
  assert.equal(readUtcOffset(330), 330);
  for (const bad of ["", "abc", "1.5", 900, -900, null, undefined, "1e3"]) assert.equal(readUtcOffset(bad), 0, String(bad));
  assert.equal(readLength("5"), 5);
  assert.equal(readLength(20), 20);
  assert.equal(readLength("7"), 10);
  assert.equal(readLength(null), 10);
  assert.equal(readDirection("produce"), "produce");
  assert.equal(readDirection("listen"), "mixed");
});

test("cardVersion: reps and last review; a card not made yet is a never-reviewed one", () => {
  assert.equal(cardVersion(null), "0:");
  assert.equal(cardVersion(newCard(NOW)), "0:");
  const c = review(newCard(NOW), 3, NOW).card;
  assert.equal(cardVersion(c), `1:${NOW.toISOString()}`);
  assert.equal(cardVersion({ ...c, last_review: new Date(c.last_review) }), `1:${NOW.toISOString()}`);
  assert.ok(isVersion("0:"));
  assert.ok(isVersion(cardVersion(c)));
  for (const bad of ["", "x:", "1:", "0:2026-11-15T00:00:00.000Z", "1:yesterday", "1:2026-11-15", null, 3]) assert.equal(isVersion(bad), false, String(bad));
});

test("candidates: due reviews, new cards, at most one card per phrase, produce only after recognize in mixed", () => {
  const brandNew = phrase(); // no card at all
  const seen = phrase({ cards: [card("recognize", { fresh: true })] }); // met in a session
  const dueRec = phrase({ cards: [card("recognize", { due: past(2) })] });
  const notDue = phrase({ cards: [card("recognize", { due: future(48) })] }); // produce is new for it
  const bothDue = phrase({ cards: [card("recognize", { due: past(1) }), card("produce", { due: past(5) })] });
  const suspended = phrase({ suspended: true, cards: [card("recognize", { due: past(3) })] });
  const pending = phrase({ text: null });
  const noMeaning = phrase({ meaning: null });
  const listenOnly = phrase({ cards: [card("listen", { due: past(9) }), card("recognize", { due: future(9) })] });
  const all = [brandNew, seen, dueRec, notDue, bothDue, suspended, pending, noMeaning, listenOnly];
  const { reviews, fresh } = candidates(all, { now: NOW });
  // Most overdue first; the phrase with both due offers its most overdue (produce).
  assert.deepEqual(reviews.map((r) => [r.phrase.id, r.skill]), [[bothDue.id, "produce"], [dueRec.id, "recognize"]]);
  const freshBy = Object.fromEntries(fresh.map((f) => [f.phrase.id, f.skill]));
  assert.deepEqual(freshBy, { [brandNew.id]: "recognize", [seen.id]: "recognize", [notDue.id]: "produce", [listenOnly.id]: "produce" });
  assert.equal(fresh.find((f) => f.phrase.id === seen.id).card.reps, 0);
  assert.equal(fresh.find((f) => f.phrase.id === brandNew.id).card, null);

  // One direction: produce-only asks produce of any practisable phrase.
  const prod = candidates(all, { now: NOW, direction: "produce" });
  assert.deepEqual(prod.reviews.map((r) => r.phrase.id), [bothDue.id]);
  assert.ok(prod.fresh.some((f) => f.phrase.id === brandNew.id && f.skill === "produce"));
  const rec = candidates(all, { now: NOW, direction: "recognize" });
  assert.deepEqual(rec.reviews.map((r) => r.phrase.id), [dueRec.id, bothDue.id]);
  assert.ok(rec.fresh.every((f) => f.skill === "recognize"));
});

test("candidates: new ones starred first, then most recently seen, then oldest added", () => {
  const old = phrase({ createdAt: new Date(NOW.getTime() - 5 * DAY) });
  const young = phrase({ createdAt: new Date(NOW.getTime() - DAY) });
  const seen = phrase({ lastSeenAt: past(3) });
  const star = phrase({ starred: true });
  const { fresh } = candidates([young, old, seen, star], { now: NOW });
  assert.deepEqual(fresh.map((f) => f.phrase.id), [star.id, seen.id, old.id, young.id]);
});

test("buildQueue: reviews first claim the room, new fill the rest, spread among them; the day's limits hold", () => {
  const due = Array.from({ length: 6 }, (_, i) => phrase({ cards: [card("recognize", { due: past(10 - i) })] }));
  const fresh = Array.from({ length: 6 }, () => phrase());
  const all = [...due, ...fresh];

  const q = buildQueue(all, { now: NOW, length: 10 });
  assert.equal(q.items.length, 10);
  assert.equal(q.items.filter((i) => i.kind === "review").length, 6);
  assert.equal(q.items.filter((i) => i.kind === "new").length, 4);
  // Spread: never two new cards in a row with 6 reviews among 10.
  assert.ok(!q.items.some((it, i) => i > 0 && it.kind === "new" && q.items[i - 1].kind === "new"));
  // Items carry what the page shows and the version to answer.
  const first = q.items.find((i) => i.kind === "review");
  assert.deepEqual(Object.keys(first).sort(), ["choices", "cloze", "drill", "kind", "lang", "meaning", "phraseId", "revision", "sentence", "skill", "starred", "text", "version"]);
  assert.equal(q.items.find((i) => i.kind === "new").version, "0:");
  assert.deepEqual(q.stats, { due: 6, new: 6, done: { new: 0, reviews: 0 }, limits: DAILY_LIMITS, left: DAILY_LIMITS, ready: 12 });

  // 5 cards: all reviews.
  assert.deepEqual(buildQueue(all, { now: NOW, length: 5 }).items.map((i) => i.kind), Array(5).fill("review"));
  // 18 new done today: only 2 more new.
  const late = buildQueue(all, { now: NOW, length: 20, done: { new: 18, reviews: 0 } });
  assert.equal(late.items.filter((i) => i.kind === "new").length, 2);
  assert.equal(late.stats.ready, 8);
  // 98 reviews done: only 2 reviews, the rest new.
  const busy = buildQueue(all, { now: NOW, length: 10, done: { new: 0, reviews: 98 } });
  assert.deepEqual([busy.items.filter((i) => i.kind === "review").length, busy.items.filter((i) => i.kind === "new").length], [2, 6]);
  // Both limits reached: nothing.
  const spent = buildQueue(all, { now: NOW, length: 20, done: { new: 20, reviews: 100 } });
  assert.deepEqual([spent.items.length, spent.stats.ready], [0, 0]);
  assert.deepEqual(remaining({ new: 25, reviews: 3 }), { new: 0, reviews: 97 });
  // No duplicates.
  assert.equal(new Set(q.items.map((i) => i.phraseId)).size, q.items.length);
});

test("readAnswerInput: ids, skills, versions, lengths, NUL and control characters, reveal's rating", () => {
  const SUBMIT = "0b5d6f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
  const ok = { phraseId: uuid(), skill: "produce", version: "0:", revision: "0123456789abcdef", submitId: SUBMIT.toUpperCase(), answer: "  la\tvuelta‮ \n", tz: -420, durationMs: 4200 };
  const r = readAnswerInput(ok);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, {
    phraseId: ok.phraseId, skill: "produce", drill: "flashcard", version: "0:", revision: "0123456789abcdef", submitId: SUBMIT, answer: "la vuelta", choice: false, reveal: false,
    rating: null, durationMs: 4200, utcOffsetMinutes: -420, clozeId: null, spoken: false, tones: false,
  });
  const bad = (patch, re) => assert.match(readAnswerInput({ ...ok, ...patch }).error ?? "", re, JSON.stringify(patch));
  // tones (stage 3): a boolean, with a speak-it answer only.
  bad({ tones: true }, /speak-it/);
  bad({ tones: "yes" }, /true or false/);
  assert.equal(readAnswerInput({ ...ok, drill: "speak", tones: true }).value.tones, true);
  bad({ phraseId: "x" }, /phraseId/);
  // Shaped like a uuid, not one: refused here, never a Postgres cast error.
  bad({ phraseId: "-".repeat(36) }, /phraseId/);
  bad({ phraseId: "a".repeat(36) }, /phraseId/);
  bad({ revision: undefined }, /revision/);
  bad({ revision: "XYZ" }, /revision/);
  bad({ submitId: undefined }, /submitId/);
  bad({ submitId: "-".repeat(36) }, /submitId/);
  bad({ skill: "listen" }, /skill/); // a flashcard is recognize or produce: listen is the listening drill's
  bad({ version: "later" }, /version/);
  bad({ answer: 5 }, /string/);
  bad({ answer: "a\u0000b" }, /NUL/);
  bad({ answer: "x".repeat(MAX_ANSWER + 1) }, /longer/);
  bad({ rating: 3 }, /override/);
  bad({ reveal: true }, /rating/);
  bad({ reveal: true, rating: 5 }, /rating/);
  bad({ reveal: "yes" }, /reveal/);
  assert.equal(readAnswerInput(null).error, "the body must be a JSON object");
  assert.equal(readAnswerInput([]).error, "the body must be a JSON object");
  const rev = readAnswerInput({ ...ok, answer: undefined, reveal: true, rating: 4, durationMs: -5 });
  assert.deepEqual([rev.value.reveal, rev.value.rating, rev.value.answer, rev.value.durationMs], [true, 4, "", null]);
  // An answer that is only what's dropped stays within the cap.
  assert.equal(readAnswerInput({ ...ok, answer: " ".repeat(MAX_ANSWER + 50) + "sí" }).value.answer, "sí");
  assert.deepEqual(readOverrideInput({ rating: 2, tz: "x" }).value, { rating: 2, utcOffsetMinutes: 0 });
  assert.match(readOverrideInput({ rating: 0 }).error, /rating/);
});

test("localMatch: produce against words and alternates; recognize against the meaning, its parts and English articles", () => {
  const base = { text: "¿Cuánto cuesta?", meaning: "How much is it?", targetLocale: "es-MX", nativeLocale: "en-US" };
  assert.equal(localMatch({ ...base, skill: "produce", answer: "cuanto cuesta" }).verdict, "close");
  assert.equal(localMatch({ ...base, skill: "produce", answer: "¿Cuánto cuesta?" }).verdict, "exact");
  assert.equal(localMatch({ ...base, skill: "produce", answer: "cuánto vale", alternates: ["¿Cuánto vale?"] }).verdict, "exact");
  assert.equal(localMatch({ ...base, skill: "produce", answer: "dónde está" }).verdict, "miss");
  assert.equal(localMatch({ ...base, skill: "recognize", answer: "how much is it" }).verdict, "exact");
  assert.equal(localMatch({ ...base, skill: "recognize", answer: "what does it cost" }).verdict, "miss");
  const vuelta = { text: "la vuelta", meaning: "the change; the turn", targetLocale: "es-MX", nativeLocale: "en-US" };
  assert.equal(localMatch({ ...vuelta, skill: "recognize", answer: "the turn" }).verdict, "exact");
  assert.equal(localMatch({ ...vuelta, skill: "recognize", answer: "change" }).verdict, "exact");
  const comer = { text: "comer", meaning: "to eat", targetLocale: "es-MX", nativeLocale: "en-US" };
  assert.equal(localMatch({ ...comer, skill: "recognize", answer: "eat" }).verdict, "exact");
  // A slash with spaces lists alternatives; one inside a word or number doesn't.
  const rec = (meaning, answer) => localMatch({ skill: "recognize", text: "x", meaning, answer, nativeLocale: "en-US" }).verdict;
  assert.equal(rec("kilo / half", "half"), "exact");
  for (const [meaning, answer] of [["1/2", "1"], ["and/or", "and"], ["24/7", "7"], ["km/h", "h"], ["he/she", "he"], ["a few", "few"], ["a little", "little"]]) {
    assert.equal(rec(meaning, answer), "miss", `${answer} for ${meaning}`);
  }
  assert.equal(rec("a few", "a few"), "exact");
  assert.equal(rec("km/h", "km/h"), "exact");
  // A comma isn't a list: "please" alone is not "Keep the change, please".
  assert.equal(localMatch({ text: "Quédese con el cambio, por favor", meaning: "Keep the change, please", skill: "recognize", answer: "please", nativeLocale: "en-US" }).verdict, "miss");
  // Articles are only dropped for an English native language.
  assert.equal(localMatch({ ...comer, nativeLocale: "de-DE", skill: "recognize", answer: "eat" }).verdict, "miss");
  // CJK target: spaces never matter.
  assert.equal(localMatch({ skill: "produce", text: "谢谢你", meaning: "thank you", answer: "谢谢 你", targetLocale: "zh-CN" }).verdict, "exact");
  assert.deepEqual(graderQuestion({ skill: "produce", text: "comer", meaning: "to eat" }), { question: "to eat", expected: "comer", kind: "target" });
  assert.deepEqual(graderQuestion({ skill: "recognize", text: "comer", meaning: "to eat" }), { question: "comer", expected: "to eat", kind: "meaning" });
});

test("gradeOutcome: the verdict → rating mapping, the grader's note cleaned, a failed check is wrong with a reason", () => {
  assert.deepEqual(gradeOutcome({ match: { verdict: "exact" } }), { verdict: "exact", rating: 3, note: null });
  assert.deepEqual(gradeOutcome({ match: { verdict: "close", note: "check the accent" } }), { verdict: "close", rating: 2, note: "check the accent" });
  assert.deepEqual(gradeOutcome({ match: { verdict: "miss" }, grader: { accepted: true, rating_hint: "good", note: "Fine." } }), { verdict: "accepted", rating: 3, note: "Fine." });
  assert.deepEqual(gradeOutcome({ match: { verdict: "miss" }, grader: { accepted: true, rating_hint: "hard", note: "" } }), { verdict: "accepted", rating: 2, note: null });
  const wrong = gradeOutcome({ match: { verdict: "miss" }, grader: { accepted: false, rating_hint: "hard", note: "It means\u0007 the\n change.‮" } });
  assert.deepEqual(wrong, { verdict: "wrong", rating: 1, note: "It means the change." });
  assert.equal(gradeOutcome({ match: { verdict: "miss" }, grader: { accepted: false, rating_hint: "hard", note: "x".repeat(500) } }).note.length, 200);
  assert.match(gradeOutcome({ match: { verdict: "miss" }, graderFailed: true, answer: "algo" }).note, /couldn't be checked/);
  assert.deepEqual(gradeOutcome({ match: { verdict: "miss" }, answer: "" }), { verdict: "wrong", rating: 1, note: null });
  assert.deepEqual(gradeOutcome({ reveal: true, rating: 4 }), { verdict: "self", rating: 4, note: null });
  assert.equal(needsGrader({ verdict: "miss" }, "algo"), true);
  assert.equal(needsGrader({ verdict: "miss" }, "  "), false);
  assert.equal(needsGrader({ verdict: "close" }, "algo"), false);
});

test("phraseRevision: changes with the words, the meaning or the alternates, nothing else", () => {
  const p = { text: "la vuelta", meaning: "the change", alternates: [], starred: false };
  const r = phraseRevision(p);
  assert.match(r, /^[0-9a-f]{16}$/);
  assert.equal(phraseRevision({ ...p, starred: true, note: "x" }), r);
  for (const patch of [{ text: "la vueltas" }, { meaning: "the turn" }, { alternates: ["el cambio"] }]) assert.notEqual(phraseRevision({ ...p, ...patch }), r);
});

test("parseGraderReply strict: one JSON object (fenced or not), never one quoted before the verdict", () => {
  const verdict = '{"accepted": false, "rating_hint": "hard", "note": "No."}';
  assert.equal(parseGraderReply(verdict, { strict: true }).accepted, false);
  assert.equal(parseGraderReply("```json\n" + verdict + "\n```", { strict: true }).accepted, false);
  const quoted = 'The learner wrote {"accepted": true}. ' + verdict;
  assert.equal(parseGraderReply(quoted, { strict: true }), null);
  assert.equal(parseGraderReply(quoted).accepted, true, "the lenient reading (other callers) is unchanged");
});

test("keepable: no braces, not far longer than the words", () => {
  assert.equal(keepable("tomar", "beber"), true);
  assert.equal(keepable("{x}", "beber"), false);
  assert.equal(keepable("x".repeat(20), "beber"), true); // 2 × 5 + 10
  assert.equal(keepable("x".repeat(21), "beber"), false);
  assert.equal(keepable("", "beber"), false);
});

test("withAlternate / withoutAlternate: kept once, not the words themselves, capped", () => {
  assert.deepEqual(withAlternate([], "¿Cuánto vale?", { text: "¿Cuánto cuesta?", lang: "es" }), ["¿Cuánto vale?"]);
  assert.deepEqual(withAlternate([], "{\"accepted\": true}", { text: "¿Cuánto cuesta?" }), []);
  assert.deepEqual(withAlternate(["¿Cuánto vale?"], "cuánto vale", { text: "¿Cuánto cuesta?" }), ["¿Cuánto vale?"]);
  assert.deepEqual(withAlternate([], "cuánto cuesta", { text: "¿Cuánto cuesta?" }), []);
  assert.deepEqual(withAlternate([], "a‮b", { text: "xy" }), ["ab"]);
  assert.deepEqual(withAlternate([], "x".repeat(201), { text: "x".repeat(200) }), []);
  const full = Array.from({ length: MAX_ALTERNATES }, (_, i) => `alt ${i}`);
  assert.equal(withAlternate(full, "one more", { text: "otra vez" }).length, MAX_ALTERNATES);
  assert.deepEqual(withAlternate("not a list", "sí", { text: "claro" }), ["sí"]);
  assert.deepEqual(withoutAlternate(["¿Cuánto vale?", "otro"], "cuánto vale"), ["otro"]);
  assert.deepEqual(withoutAlternate(["otro"], ""), ["otro"]);
});
