// The listening and speak-it drills' pure half (scripts/practice.mjs,
// match.mjs): which cards each mode asks and in which drill, one card per
// phrase however many are due, a listening card's choices and hidden words,
// the answer body's drill and choice, how a typed listening answer and a
// picked choice are matched, and the grader's wording for each.
//   node --test scripts/tests/practice-drills.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { newCard, review } from "../fsrs.mjs";
import { graderPrompt } from "../match.mjs";
import {
  CHOICES, buildQueue, candidates, choiceMatch, drillsFor, graderQuestion, listenChoices, listenMatch, localMatch, offeredChoices, readAnswerInput, readMode, seededRand,
} from "../practice.mjs";

const NOW = new Date("2026-11-15T18:00:00Z");
const DAY = 86_400_000;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
/** A card of `skill` reviewed once, due `dueDays` from NOW (negative: due). */
function card(skill, dueDays = -1) {
  const c = review(newCard(new Date(NOW.getTime() - 10 * DAY)), 3, new Date(NOW.getTime() - 10 * DAY)).card;
  return { skill, ...c, due: new Date(NOW.getTime() + dueDays * DAY) };
}
function phrase(extra = {}) {
  n++;
  return { id: uuid(), text: `palabra ${n}`, meaning: `word ${n}`, lang: "es-MX", starred: false, suspended: false, lastSeenAt: null, createdAt: new Date(NOW.getTime() - DAY), cards: [], ...extra };
}
/** A deterministic rand: cycles through `values`. */
const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test("drillsFor and readMode: each mode's skills, in the order a phrase meets them, and the drill each is asked in", () => {
  assert.deepEqual(drillsFor("flashcards", "mixed"), [["recognize", "flashcard"], ["produce", "flashcard"]]);
  assert.deepEqual(drillsFor("flashcards", "produce"), [["produce", "flashcard"]]);
  assert.deepEqual(drillsFor("listening"), [["listen", "listening"]]);
  assert.deepEqual(drillsFor("speak"), [["produce", "speak"]]);
  assert.deepEqual(drillsFor("mixed", "produce"), [["recognize", "flashcard"], ["listen", "listening"], ["produce", "speak"]]);
  assert.equal(readMode("listening"), "listening");
  assert.equal(readMode("nope"), "flashcards");
  assert.equal(readMode(null), "flashcards");
});

test("candidates by mode: one card per phrase however many are due; mixed reads before it listens or speaks; a one-skill mode doesn't wait", () => {
  const fresh = phrase();
  const read = phrase({ cards: [card("recognize", 3)] }); // recognize reviewed, not due
  const allDue = phrase({ cards: [card("recognize", -1), card("listen", -3), card("produce", -2)] });
  const bank = [fresh, read, allDue];
  const mixed = candidates(bank, { now: NOW, mode: "mixed" });
  // The phrase with three cards due is one review: its most overdue (listen).
  assert.deepEqual(mixed.reviews.map((c) => [c.phrase.id, c.skill, c.drill]), [[allDue.id, "listen", "listening"]]);
  // New: the unread phrase as a recognize flashcard; the read one by ear next.
  assert.deepEqual(mixed.fresh.map((c) => [c.phrase.id, c.skill, c.drill]).sort(), [[fresh.id, "recognize", "flashcard"], [read.id, "listen", "listening"]].sort());
  // Listening alone: any practisable phrase, never read first.
  const listening = candidates(bank, { now: NOW, mode: "listening" });
  assert.deepEqual(listening.fresh.map((c) => c.phrase.id).sort(), [fresh.id, read.id].sort());
  assert.deepEqual(listening.reviews.map((c) => c.skill), ["listen"]);
  // Speak-it: produce cards, asked aloud.
  const speak = candidates(bank, { now: NOW, mode: "speak" });
  assert.deepEqual([...speak.reviews, ...speak.fresh].map((c) => [c.skill, c.drill]), [["produce", "speak"], ["produce", "speak"], ["produce", "speak"]]);
  // The stats count a phrase once too.
  const q = buildQueue(bank, { now: NOW, mode: "mixed", length: 20, rand: seq(0) });
  assert.deepEqual([q.stats.due, q.stats.new, q.items.length], [1, 2, 3]);
  assert.equal(new Set(q.items.map((i) => i.phraseId)).size, 3);
  // Flashcards as before: listen cards are not theirs.
  const flash = candidates([phrase({ cards: [card("listen", -1)] })], { now: NOW });
  assert.deepEqual([flash.reviews.length, flash.fresh.map((c) => c.skill)], [0, ["recognize"]]);
});

test("a listening item carries no words or meaning, only the choices; other drills carry both and no choices", () => {
  const bank = ["the bill", "a kilo", "goodbye", "the market", "how much", "tomorrow"].map((meaning) => phrase({ meaning }));
  const q = buildQueue(bank, { now: NOW, mode: "listening", length: 5 });
  assert.equal(q.items.length, 5);
  for (const item of q.items) {
    assert.deepEqual([item.drill, item.skill, item.text, item.meaning], ["listening", "listen", "", ""]);
    assert.equal(item.choices.length, CHOICES);
    const own = bank.find((p) => p.id === item.phraseId);
    assert.ok(item.choices.includes(own.meaning), "the right meaning is among them");
    assert.equal(new Set(item.choices).size, CHOICES);
    assert.ok(!item.choices.some((c) => bank.some((p) => p.text === c)), "no words among the choices");
  }
  const s = buildQueue(bank, { now: NOW, mode: "speak", length: 1 }).items[0];
  assert.deepEqual([s.drill, s.skill, s.choices, !!s.text, !!s.meaning], ["speak", "produce", null, true, true]);
});

test("listenChoices: distractors from the same bank that can't also be right; too few is null (type it)", () => {
  const target = phrase({ meaning: "the change; the turn" });
  const usable = [phrase({ meaning: "the bill" }), phrase({ meaning: "a kilo" }), phrase({ meaning: "goodbye" })];
  const clashing = [
    phrase({ meaning: "change" }), // "the change" without its article: would grade as right
    phrase({ meaning: "The turn" }), // a part of the target's meaning
    phrase({ meaning: "the bill" }), // the same as another distractor
    phrase({ meaning: "bill" }), // the same as another distractor without the article
    phrase({ meaning: "goodbye", suspended: true }),
    phrase({ meaning: null }),
    target,
  ];
  const got = listenChoices(target, [...clashing, ...usable], { nativeLocale: "en-US", rand: seq(0) });
  assert.equal(got.length, 4);
  assert.deepEqual([...got].sort(), ["a kilo", "goodbye", "the bill", "the change; the turn"].sort());
  // Two usable distractors: not enough for four.
  const noBill = clashing.filter((p) => !/bill/.test(p.meaning ?? ""));
  assert.equal(listenChoices(target, [...noBill, ...usable.slice(1)], { nativeLocale: "en-US", rand: seq(0) }), null);
  // The right one lands where rand puts it (two draws shuffle three, the third places it).
  const at = (r) => listenChoices(target, usable, { nativeLocale: "en-US", rand: seq(0, 0, r) }).indexOf(target.meaning);
  assert.deepEqual([at(0), at(0.99)], [0, 3]);
});

test("listenChoices: no distractor that is nearly the right meaning (inside it, a few letters off, a content word shared)", () => {
  const others = ["the bill", "a kilo", "tomorrow", "the market"].map((meaning) => phrase({ meaning }));
  const alike = (right, near) => {
    const target = phrase({ meaning: right });
    const bank = [target, phrase({ meaning: near }), ...others];
    for (let i = 0; i < 20; i++) {
      const got = listenChoices(target, bank, { nativeLocale: "en-US", seed: `s${i}` });
      assert.ok(got && !got.includes(near), `${near} beside ${right}`);
    }
  };
  alike("goodbye", "bye");
  alike("bye", "goodbye");
  alike("thanks", "thank you");
  alike("thank you", "thanks a lot");
  alike("how much is it?", "how much money");
  alike("the beach", "the beaches");
  // A shared start isn't a shared word: "good morning" can stand by "goodbye".
  const gm = phrase({ meaning: "good morning" });
  const gmBank = [gm, phrase({ meaning: "goodbye" }), phrase({ meaning: "the bill" }), phrase({ meaning: "a kilo" })];
  assert.ok(listenChoices(gm, gmBank, { nativeLocale: "en-US", seed: "x" }).includes("goodbye"));
  // Stopwords alone don't make two meanings alike.
  const target = phrase({ meaning: "how are you" });
  const bank = [target, phrase({ meaning: "where is it" }), phrase({ meaning: "what time" }), phrase({ meaning: "the bill" })];
  assert.equal(listenChoices(target, bank, { nativeLocale: "en-US", seed: "x" }).length, CHOICES);
  // Fewer than three left once the alike ones go: typed instead.
  const few = phrase({ meaning: "thanks" });
  assert.equal(listenChoices(few, [few, phrase({ meaning: "thank you" }), phrase({ meaning: "many thanks" }), ...others.slice(0, 2)], { nativeLocale: "en-US", seed: "x" }), null);
});

test("offeredChoices: the same card (phrase, version, revision) and bank always draw the same choices, whatever order the bank comes in", () => {
  const bank = ["the bill", "a kilo", "goodbye", "the market", "tomorrow", "the beach", "the station"].map((meaning) => phrase({ meaning }));
  const target = bank[0];
  const a = offeredChoices(target, bank, { version: "0:", nativeLocale: "en-US" });
  const b = offeredChoices(target, [...bank].reverse(), { version: "0:", nativeLocale: "en-US" });
  assert.deepEqual(a, b);
  const q = buildQueue(bank, { now: NOW, mode: "listening", length: 7, nativeLocale: "en-US" });
  assert.deepEqual(q.items.find((i) => i.phraseId === target.id).choices, a);
  // Another version: drawn afresh (deterministic too).
  const seeds = new Set(Array.from({ length: 8 }, (_, i) => JSON.stringify(offeredChoices(target, bank, { version: `${i}:x`, nativeLocale: "en-US" }))));
  assert.ok(seeds.size > 1, "the draw depends on the card version");
  assert.deepEqual(seededRand("k")(), seededRand("k")());
});

test("readAnswerInput: the drill names the review's mode and its skill; a choice only for listening; speak-it needs what was heard", () => {
  const ok = { phraseId: uuid(), version: "0:", revision: "0123456789abcdef", submitId: "0b5d6f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b" };
  const bad = (body, re) => assert.match(readAnswerInput({ ...ok, ...body }).error ?? "", re, JSON.stringify(body));
  const listen = readAnswerInput({ ...ok, skill: "listen", drill: "listening", choice: "  the change " });
  assert.deepEqual([listen.value.drill, listen.value.answer, listen.value.choice], ["listening", "the change", true]);
  const typed = readAnswerInput({ ...ok, skill: "listen", drill: "listening", answer: "la vuelta" });
  assert.deepEqual([typed.value.answer, typed.value.choice], ["la vuelta", false]);
  const spoken = readAnswerInput({ ...ok, skill: "produce", drill: "speak", answer: "la vuelta" });
  assert.equal(spoken.value.drill, "speak");
  bad({ skill: "listen" }, /flashcard answer's skill/);
  bad({ skill: "recognize", drill: "listening" }, /listening answer's skill must be listen/);
  bad({ skill: "recognize", drill: "speak", answer: "x" }, /speak answer's skill must be produce/);
  bad({ skill: "listen", drill: "dictation" }, /drill must be/);
  bad({ skill: "produce", choice: "x" }, /choice goes with a listening answer/);
  bad({ skill: "listen", drill: "listening", choice: "x", answer: "y" }, /not both/);
  bad({ skill: "listen", drill: "listening", choice: "   " }, /one of the meanings/);
  bad({ skill: "listen", drill: "listening", choice: 3 }, /choice must be a string/);
  bad({ skill: "listen", drill: "listening", reveal: true, rating: 3 }, /only a flashcard/);
  bad({ skill: "produce", drill: "speak", answer: "  " }, /nothing was heard/);
  bad({ skill: "produce", drill: "speak" }, /nothing was heard/);
});

test("listenMatch: the words heard (a dictation) or the meaning; choiceMatch: the meaning exactly, no near miss", () => {
  const base = { text: "la vuelta", meaning: "the change", alternates: ["el cambio"], targetLocale: "es-MX", nativeLocale: "en-US" };
  assert.deepEqual(listenMatch({ ...base, answer: "La vuelta" }), { verdict: "exact", as: "words" });
  assert.deepEqual(listenMatch({ ...base, answer: "el cambio" }), { verdict: "exact", as: "words" });
  assert.deepEqual(listenMatch({ ...base, answer: "change" }), { verdict: "exact", as: "meaning" });
  assert.equal(listenMatch({ ...base, answer: "la vueltaa" }).verdict, "close");
  assert.deepEqual(listenMatch({ ...base, answer: "the money back" }), { verdict: "miss", as: "meaning" });
  // Both readings are checked; the better verdict wins.
  const fr = { text: "université", meaning: "university", targetLocale: "fr-FR", nativeLocale: "en-US" };
  assert.deepEqual(listenMatch({ ...fr, answer: "university" }), { verdict: "exact", as: "meaning" }, "a right meaning near the words is not a typo");
  assert.deepEqual(listenMatch({ ...fr, answer: "université" }), { verdict: "exact", as: "words" }, "a right dictation near the meaning");
  assert.deepEqual(listenMatch({ ...fr, answer: "universite" }), { verdict: "close", note: "as the words heard: check the accent", as: "words" }, "an accent off beats a letter off");
  const univ = listenMatch({ ...fr, answer: "universitty" });
  assert.deepEqual([univ.verdict, univ.as], ["close", "meaning"], "nearer to the meaning (one letter) than to the words (two)");
  assert.match(univ.note, /^as the meaning: /);
  const sp = { text: "la vuelta", meaning: "the change", targetLocale: "es-MX", nativeLocale: "en-US" };
  assert.match(listenMatch({ ...sp, answer: "la vueltaa" }).note, /^as the words heard: /);
  assert.match(listenMatch({ ...sp, answer: "the changes" }).note, /^as the meaning: /);
  // A cognate spelled the same in both languages: exact (as the words).
  assert.deepEqual(listenMatch({ text: "taxi", meaning: "taxi", answer: "Taxi", targetLocale: "es-MX", nativeLocale: "en-US" }), { verdict: "exact", as: "words" });
  // A miss on both: one model check, which is told it is a heard phrase (either reading counts there).
  assert.equal(listenMatch({ ...fr, answer: "school" }).verdict, "miss");
  assert.deepEqual(graderQuestion({ skill: "listen", ...fr }), { question: "université", expected: "university", kind: "meaning", heard: true });
  assert.match(graderPrompt({ ...graderQuestion({ skill: "listen", ...fr }), answer: "school", nativeLanguage: "English", targetVariant: "French" }), /spelling or romanization/);
  assert.deepEqual(choiceMatch({ choice: "the change", meaning: "the change", nativeLocale: "en-US" }), { verdict: "exact" });
  assert.deepEqual(choiceMatch({ choice: "the turn", meaning: "the change; the turn", nativeLocale: "en-US" }), { verdict: "exact" });
  assert.deepEqual(choiceMatch({ choice: "the changes", meaning: "the change", nativeLocale: "en-US" }), { verdict: "miss" });
});

test("speak-it matching: a same-sound accent (cuánto/cuanto) is exact spoken, close typed; a heard stress accent is close either way", () => {
  const base = { skill: "produce", text: "¿Cuánto cuesta?", meaning: "How much is it?", targetLocale: "es-MX" };
  assert.equal(localMatch({ ...base, answer: "cuanto cuesta", spoken: true }).verdict, "exact");
  assert.equal(localMatch({ ...base, answer: "cuanto cuesta" }).verdict, "close");
  const stress = localMatch({ ...base, text: "Hablo español", answer: "habló español", spoken: true });
  assert.deepEqual(stress, { verdict: "close", note: 'heard as "habló español": check the accent' });
});

test("graderQuestion and graderPrompt: a heard phrase and a spoken answer say so; a flashcard's prompt is as before", () => {
  const p = { text: "la vuelta", meaning: "the change" };
  assert.deepEqual(graderQuestion({ skill: "listen", ...p }), { question: "la vuelta", expected: "the change", kind: "meaning", heard: true });
  assert.deepEqual(graderQuestion({ skill: "produce", ...p, drill: "speak" }), { question: "the change", expected: "la vuelta", kind: "target", spoken: true });
  assert.deepEqual(graderQuestion({ skill: "produce", ...p }), { question: "the change", expected: "la vuelta", kind: "target" });
  const common = { answer: "x", nativeLanguage: "English", targetVariant: "Mexican Spanish" };
  const heard = graderPrompt({ ...graderQuestion({ skill: "listen", ...p }), ...common });
  assert.match(heard, /heard a phrase in Mexican Spanish \(they were not shown it\)/);
  assert.match(heard, /Phrase the learner heard: la vuelta/);
  const spoken = graderPrompt({ ...graderQuestion({ skill: "produce", ...p, drill: "speak" }), ...common });
  assert.match(spoken, /speech-to-text transcript/);
  const flash = graderPrompt({ ...graderQuestion({ skill: "recognize", ...p }), ...common });
  assert.match(flash, /was shown a phrase/);
  assert.doesNotMatch(flash, /transcript|heard/);
});
