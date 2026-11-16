// Practice: the pure half (docs/DATA.md §Practice modes, §Grading). What a
// flashcard session's queue holds, the learner's day and its limits, the
// card version a client answers against, and how a typed answer is graded
// before and after the model check. No I/O and no clock reads (every
// function that needs the time takes `now`), so `node --test` pins it
// directly; scripts/db/practice.ts reads and writes the rows and
// web/server/practice.ts runs the grader.

import { createHash } from "node:crypto";
import { RATINGS, ratingForVerdict } from "./fsrs.mjs";
import { matchAnswer, normalizeAnswer } from "./match.mjs";
import { LIMITS, clean, isUuid } from "./phrases.mjs";
import { clozeView, pickCloze, sentenceView } from "./cloze.mjs";

/** The skills a card exercises: recognize (see the words, give the
 *  meaning), produce (see the meaning, give the words) and listen (hear the
 *  words, give the meaning). */
export const PRACTICE_SKILLS = ["recognize", "produce", "listen"];
/** The drills, named as `reviews.mode` names them: a flashcard (typed,
 *  either way), the listening drill (audio only, a choice of meanings or
 *  typed), speak-it (the meaning shown, the words said aloud) and cloze (a
 *  sentence with the phrase blanked, the meaning as a hint: typed or said). */
export const DRILLS = ["flashcard", "listening", "speak", "cloze"];
/** Which skills each drill can review. */
export const DRILL_SKILLS = { flashcard: ["recognize", "produce"], listening: ["listen"], speak: ["produce"], cloze: ["produce"] };
/** The Practice tab's mode picker: flashcards (both ways or one, as
 *  `direction` says), listening, speak-it, fill the gap (cloze), or a mix. */
export const PRACTICE_MODES = ["flashcards", "listening", "speak", "cloze", "mixed"];
/** The flashcards' skill filter: both, or one direction only. */
export const DIRECTIONS = ["mixed", "recognize", "produce"];
/** Cards a session asks, at most. */
export const SESSION_LENGTHS = [5, 10, 20];
export const DEFAULT_LENGTH = 10;
/** Per learner's day (DATA.md, proposed): cards seen for the first time, and
 *  reviews of cards seen before. Anki's defaults are the same pair. */
export const DAILY_LIMITS = { new: 20, reviews: 100 };
/** The hour the learner's day turns over (Anki's 4 a.m.), as fsrs.mjs
 *  review() counts days. */
export const ROLLOVER_HOUR = 4;
/** What one answer, and an alternate the grader accepted, may be. */
export const MAX_ANSWER = 300;
/** Alternates a phrase keeps at most: enough for the common other ways to
 *  say it, not a list that grows with every creative answer. */
export const MAX_ALTERNATES = 20;
/** A UTC offset the browser may name, in minutes (UTC-14 to UTC+14). */
export const MAX_UTC_OFFSET = 14 * 60;

const DAY = 86_400_000;
const ms = (d) => (d == null ? null : new Date(d).getTime());
const iso = (d) => (d == null ? null : new Date(d).toISOString());

/* ---------------------------------- the day --------------------------------- */

/**
 * When the learner's practice day began: the last ROLLOVER_HOUR o'clock
 * local time at or before `now`. `utcOffsetMinutes` is local minus UTC
 * (what the browser's -getTimezoneOffset() gives), so a learner at UTC-7
 * practising at 3 a.m. is still on yesterday's limits. The same shift
 * fsrs.mjs review() uses, so a "day" means one thing to both.
 */
export function dayStart(now, utcOffsetMinutes = 0, rolloverHour = ROLLOVER_HOUR) {
  const shift = utcOffsetMinutes * 60_000 - rolloverHour * 3_600_000;
  const local = ms(now) + shift;
  return new Date(Math.floor(local / DAY) * DAY - shift);
}

/** A UTC offset from a request (`?tz=` or a body's `tz`): an integer number
 *  of minutes within ±14 h, else 0 (UTC). */
export function readUtcOffset(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return Number.isInteger(n) && Math.abs(n) <= MAX_UTC_OFFSET ? n : 0;
}

/* -------------------------------- card version ------------------------------ */

/**
 * The version of a card a client answers against: its review count and the
 * time of its last review. Every review changes both, so two submits of one
 * answer (a double click, a retried fetch, a second tab) name the same
 * version and only the first can apply; the second finds the review the
 * first wrote (its `card_before` has this version) and is answered with
 * it. A card not made yet is version "0:", the same as one never reviewed.
 */
export function cardVersion(card) {
  if (!card) return "0:";
  return `${Number(card.reps) || 0}:${card.last_review ? iso(card.last_review) : ""}`;
}

/** "0:" (never reviewed), or a review count with the last review's time. */
const VERSION_RE = /^(0:|[1-9]\d{0,8}:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z)$/;
export const isVersion = (v) => typeof v === "string" && VERSION_RE.test(v);

/* ---------------------------------- the queue -------------------------------- */

/** A phrase a flashcard can ask: it has words and a meaning (a card shows
 *  one and asks for the other), and it isn't suspended. Pending phrases (a
 *  scene's meaning with no words yet) have no words. */
export const practisable = (p) => p.text != null && p.text !== "" && !!p.meaning && !p.suspended;

const reviewed = (c) => !!c && Number(c.reps) > 0 && Number(c.state) !== 0;

/** New phrases first by what the learner chose (starred), then what they
 *  met most recently, then the oldest added. */
const newOrder = (a, b) =>
  Number(!!b.phrase.starred) - Number(!!a.phrase.starred) ||
  (ms(b.phrase.lastSeenAt) ?? -Infinity) - (ms(a.phrase.lastSeenAt) ?? -Infinity) ||
  (ms(a.phrase.createdAt) ?? 0) - (ms(b.phrase.createdAt) ?? 0) ||
  (a.phrase.id < b.phrase.id ? -1 : a.phrase.id > b.phrase.id ? 1 : 0);

/**
 * The cards a session of `mode` asks, as [skill, drill] pairs in the order
 * a phrase meets them: flashcards are recognize then produce (or the one
 * `direction` names); listening is the listen card; speak-it is the
 * produce card said aloud; cloze is the produce card as a gap in a
 * sentence; mixed is all three skills, recognize as a flashcard, listen by
 * ear and produce spoken (or, for a phrase with a cloze sentence, every
 * other time as a gap: produceDrill).
 */
export function drillsFor(mode = "flashcards", direction = "mixed") {
  if (mode === "listening") return [["listen", "listening"]];
  if (mode === "speak") return [["produce", "speak"]];
  if (mode === "cloze") return [["produce", "cloze"]];
  if (mode === "mixed") return [["recognize", "flashcard"], ["listen", "listening"], ["produce", "speak"]];
  if (direction === "recognize" || direction === "produce") return [[direction, "flashcard"]];
  return [["recognize", "flashcard"], ["produce", "flashcard"]];
}

/**
 * What a session could ask now, per phrase at most one card (two cards of
 * one phrase in one session would show each other's answer, and a phrase
 * with several cards due counts once, in the queue and in its stats):
 *  - review: a card of the mode's skills that has been reviewed and is due
 *    (`due` ≤ now), the most overdue of the phrase's when several are;
 *  - new: a card never reviewed, or not made yet (cards are made lazily,
 *    on the first answer), the first in drillsFor's order. When the mode
 *    has recognize and more (flashcards both ways, mixed), the phrase's
 *    other cards are new only once its recognize card has been reviewed:
 *    a phrase is read before it is asked for or heard. A one-skill mode
 *    drops that rule (the learner chose it).
 * A phrase with a review due offers no new card. Reviews come most overdue
 * first, new ones in newOrder. Each entry names its drill.
 *
 * Cloze needs a sentence: a phrase's `cloze` is its usable items (the
 * server reads them: scripts/db/cloze.ts). In the cloze mode a phrase
 * with none is left out (its card waits for a later session or another
 * drill). `waiting` lists the candidates, in queue order (due first),
 * whose phrase has no sentence yet and is worth a model call
 * (`clozeNeeded`): the cloze and mixed modes' produce cards, and every
 * card of the flashcards mode (its answer side shows the phrase used in a
 * sentence); the server writes them sentences in the background. A
 * flashcard without one is asked all the same, with no sentence.
 */
export function candidates(phrases, { now, direction = "mixed", mode = "flashcards" }) {
  const drills = drillsFor(mode, direction);
  const skills = drills.map(([skill]) => skill);
  const drillOf = Object.fromEntries(drills);
  const gated = skills.length > 1 && skills.includes("recognize");
  const reviews = [];
  const fresh = [];
  const waitingDue = [];
  const waitingNew = [];
  const t = ms(now);
  // Where an entry goes: a produce card is asked as the mode says (mixed:
  // produceDrill), and in the cloze mode only with a sentence to show.
  const wantsSentence = (skill) => mode === "flashcards" || (skill === "produce" && (mode === "cloze" || mode === "mixed"));
  const place = (phrase, skill, card, list, waiting, kind) => {
    const hasCloze = !!phrase.cloze?.length;
    if (wantsSentence(skill) && !hasCloze && phrase.clozeNeeded) waiting.push({ phrase, card, kind });
    if (mode === "cloze" && !hasCloze) return;
    const drill = skill === "produce" && mode === "mixed" ? produceDrill(phrase, card) : drillOf[skill];
    list.push({ phrase, skill, drill, card, kind });
  };
  for (const phrase of phrases ?? []) {
    if (!practisable(phrase)) continue;
    const bySkill = Object.fromEntries((phrase.cards ?? []).map((c) => [c.skill, c]));
    const due = skills
      .map((skill) => bySkill[skill])
      .filter((c) => reviewed(c) && ms(c.due) <= t)
      .sort((a, b) => ms(a.due) - ms(b.due));
    if (due.length) {
      place(phrase, due[0].skill, due[0], reviews, waitingDue, "review");
      continue;
    }
    for (const skill of skills) {
      const card = bySkill[skill];
      if (reviewed(card)) continue;
      if (gated && skill !== "recognize" && !reviewed(bySkill.recognize)) continue;
      place(phrase, skill, card ?? null, fresh, waitingNew, "new");
      break;
    }
  }
  reviews.sort((a, b) => ms(a.card.due) - ms(b.card.due) || newOrder(a, b));
  fresh.sort(newOrder);
  waitingDue.sort((a, b) => ms(a.card.due) - ms(b.card.due) || newOrder(a, b));
  waitingNew.sort(newOrder);
  return { reviews, fresh, waiting: [...waitingDue, ...waitingNew] };
}

/** Mixed mode's drill for a produce card: a gap in one of the phrase's
 *  cloze sentences every other time (when its reviews so far are even:
 *  the first, the third…) if it has one, else said aloud. A phrase with
 *  sentences is practised both ways. */
export function produceDrill(phrase, card) {
  return phrase.cloze?.length && (Number(card?.reps) || 0) % 2 === 0 ? "cloze" : "speak";
}

/**
 * The phrases one session would show in a sentence if they had one, no
 * more: the generation a started session pays for is cut to that session.
 * The invariant (cloze.test.mjs checks it over a grid):
 *  - mixed: only the session's own produce cards, asked aloud for want of
 *    a sentence. They already hold places in it, under its length and
 *    today's limits, so nothing is wanted beyond the session.
 *  - flashcards: only the session's own cards with no sentence for their
 *    answer side, likewise.
 *  - cloze (which leaves such phrases out): at most the places the session
 *    left unfilled (its length less every card already in it, due and new
 *    alike), and within today's limits less what the session already takes:
 *    due phrases up to the reviews left, new ones up to the new cards left.
 *    The places are filled from the waiting phrases in queue order, due
 *    first.
 */
function wantedFor(mode, waiting, items, { length, left, nReviews, nNew }) {
  if (mode === "mixed" || mode === "flashcards") {
    const inSession = new Set(items.map((c) => c.phrase.id));
    return waiting.filter((w) => inSession.has(w.phrase.id)).map((w) => w.phrase);
  }
  if (mode !== "cloze") return [];
  const unfilled = Math.max(0, length - nReviews - nNew);
  const dueRoom = Math.max(0, Math.min(left.reviews - nReviews, unfilled));
  const due = waiting.filter((w) => w.kind === "review").slice(0, dueRoom);
  const newRoom = Math.max(0, Math.min(left.new - nNew, unfilled - due.length));
  const fresh = waiting.filter((w) => w.kind === "new").slice(0, newRoom);
  return [...due, ...fresh].map((w) => w.phrase);
}

/** How much of today's limits is left, given what today's practice has
 *  done (`done.new`: first reviews of cards; `done.reviews`: the rest). */
export function remaining(done, limits = DAILY_LIMITS) {
  return {
    new: Math.max(0, limits.new - (Number(done?.new) || 0)),
    reviews: Math.max(0, limits.reviews - (Number(done?.reviews) || 0)),
  };
}

/** A session length from a request: one of SESSION_LENGTHS, else the default. */
export function readLength(v) {
  const n = Number(v);
  return SESSION_LENGTHS.includes(n) ? n : DEFAULT_LENGTH;
}

/** A direction from a request: one of DIRECTIONS, else mixed. */
export const readDirection = (v) => (DIRECTIONS.includes(v) ? v : "mixed");

/** A practice mode from a request: one of PRACTICE_MODES, else flashcards
 *  (what a page from before the mode picker asks for). */
export const readMode = (v) => (PRACTICE_MODES.includes(v) ? v : "flashcards");

/**
 * One session's queue: due reviews first claim the room (owed work), up to
 * today's review limit; new cards fill what is left, up to today's new
 * limit. The new ones are spread evenly among the reviews rather than
 * bunched at the end, so a short session with both shows both. Also the
 * counts the tab shows before a session (what is due and new right now,
 * and today's progress against the limits).
 */
export function buildQueue(
  phrases,
  { now, done = { new: 0, reviews: 0 }, length = DEFAULT_LENGTH, direction = "mixed", mode = "flashcards", limits = DAILY_LIMITS, nativeLocale = "" },
) {
  const { reviews, fresh, waiting } = candidates(phrases, { now, direction, mode });
  const left = remaining(done, limits);
  const nReviews = Math.min(reviews.length, left.reviews, length);
  const nNew = Math.min(fresh.length, left.new, length - nReviews);
  const total = nReviews + nNew;
  const items = [];
  let r = 0;
  let f = 0;
  for (let i = 0; i < total; i++) {
    const takeNew = Math.floor(((i + 1) * nNew) / total) > Math.floor((i * nNew) / total);
    items.push(takeNew ? fresh[f++] : reviews[r++]);
  }
  return {
    items: items.map((c) => queueItem(c, c.drill === "listening" ? offeredChoices(c.phrase, phrases, { version: cardVersion(c.card), nativeLocale }) : null)),
    // Not for the wire: the phrases this session would show in a sentence
    // (a gap, or a flashcard's answer side) had they one, due first (what
    // a started session writes for).
    clozeWanted: wantedFor(mode, waiting, items, { length, left, nReviews, nNew }),
    // How many of the bank's phrases wait for a sentence (the cloze mode's count).
    clozeWaiting: waiting.length,
    stats: {
      due: reviews.length,
      new: fresh.length,
      done: { new: Number(done.new) || 0, reviews: Number(done.reviews) || 0 },
      limits: { ...limits },
      left,
      // What a session started now would ask: capped by the limits.
      ready: Math.min(reviews.length, left.reviews) + Math.min(fresh.length, left.new),
    },
  };
}

/**
 * The revision of a phrase as a card shows and grades it: a short hash of
 * its words, meaning and alternates. The card version doesn't move when
 * the phrase is edited (an edit touches the phrase row, not the card), so
 * the queue sends this too and an answer must name it: an edit in another
 * tab since the card was shown is a 409 before any grading, never a grade
 * against a question the learner didn't see.
 */
export function phraseRevision(phrase) {
  const alts = Array.isArray(phrase?.alternates) ? phrase.alternates : [];
  return createHash("sha256")
    .update(JSON.stringify([phrase?.text ?? null, phrase?.meaning ?? null, alts]))
    .digest("hex")
    .slice(0, 16);
}
const REVISION_RE = /^[0-9a-f]{16}$/;

/** A queue entry as the wire carries it: the card version and the phrase
 *  revision to answer against, and the drill. A flashcard or speak-it card
 *  carries both sides (the page shows one and hides the other until it is
 *  answered; it is the learner's own bank, which the Library shows
 *  anyway). A flashcard also carries the phrase used in a sentence when
 *  the phrase has one (`sentence`: the pick a cloze card of the same
 *  version would make), for its answer side only: it holds the words, so
 *  the page never shows it before the card is revealed or answered. A
 *  listening card carries neither side nor a sentence: the words are what
 *  the learner must hear, so they come only with the answer's reply (and
 *  the audio from /api/practice/audio/:phraseId); its `choices` (or null:
 *  type the answer) are the meanings to pick from. */
function queueItem({ phrase, skill, drill = "flashcard", card, kind }, choices = null) {
  const listening = drill === "listening";
  // A cloze card carries the sentence around the gap and the meaning (the
  // hint), never the words: those come with the answer's reply.
  const seed = `${phrase.id}:${cardVersion(card)}`;
  const cloze = drill === "cloze" ? pickCloze(phrase.cloze, seed) : null;
  const sentence = drill === "flashcard" ? pickCloze(phrase.cloze, seed) : null;
  return {
    phraseId: phrase.id,
    skill,
    drill,
    kind,
    text: listening || drill === "cloze" ? "" : phrase.text,
    meaning: listening ? "" : phrase.meaning,
    choices: listening ? choices : null,
    cloze: cloze ? clozeView(cloze) : null,
    sentence: sentence ? sentenceView(sentence) : null,
    lang: phrase.lang ?? "",
    starred: !!phrase.starred,
    version: cardVersion(card),
    revision: phraseRevision(phrase),
  };
}

/** How many meanings a listening card offers (the right one among them). */
export const CHOICES = 4;

/** The comparable forms of a meaning: each of its parts (meaningParts),
 *  normalized, and for an English native language without a leading
 *  "the"/"to" too (the forms localMatch would take as the same answer). */
function meaningKeys(meaning, nativeLocale) {
  const keys = new Set();
  for (const part of [String(meaning ?? ""), ...meaningParts(meaning)]) {
    const k = normalizeAnswer(part, nativeLocale);
    if (k) keys.add(k);
    if (isEnglish(nativeLocale)) {
      const bare = normalizeAnswer(part.trim().replace(EN_LEAD, ""), nativeLocale);
      if (bare) keys.add(bare);
    }
  }
  return keys;
}

/** Words that carry no meaning of their own in an English meaning: two
 *  meanings sharing only these ("how are you", "how much") aren't alike. */
const EN_STOPWORDS = new Set(
  "a an the to of in on at for and or but is are am was were be been it its i you he she we they me him her us them my your his our their this that these those do does did not no yes with by from as so if then there here what how where when who why which".split(" "),
);

/** Levenshtein distance, stopping early once it is past `max`. */
function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** A meaning's content words: its words, less English stopwords, at least
 *  three letters. */
function contentWords(keys, nativeLocale) {
  const out = new Set();
  for (const k of keys) {
    for (const w of k.split(" ")) {
      if (w.length >= 3 && !(isEnglish(nativeLocale) && EN_STOPWORDS.has(w))) out.add(w);
    }
  }
  return out;
}

/** Two content words that are one word in practice: equal, an ending away
 *  ("thank" / "thanks", "beach" / "beaches": one the start of the other and
 *  at most two letters longer, so "good" / "goodbye" stay apart), or one
 *  letter off. */
const relatedWords = (x, y) =>
  x === y ||
  (Math.min(x.length, y.length) >= 4 && (((x.startsWith(y) || y.startsWith(x)) && Math.abs(x.length - y.length) <= 2) || editDistance(x, y, 1) <= 1));

/**
 * Whether two meanings are too alike to stand side by side as choices: a
 * form in common (meaningKeys, so both would grade as right), one inside
 * the other ("bye" / "goodbye"), within two edits of each other, or a
 * content word in common ("thanks" / "thank you", "how much is it" /
 * "how much money").
 */
function tooAlike(a, b, nativeLocale) {
  const ka = meaningKeys(a, nativeLocale);
  const kb = meaningKeys(b, nativeLocale);
  if (!ka.size || !kb.size) return true;
  for (const x of ka) {
    for (const y of kb) {
      if (x === y) return true;
      if (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x))) return true;
      if (Math.min(x.length, y.length) >= 4 && editDistance(x, y, 2) <= 2) return true;
    }
  }
  const wa = contentWords(ka, nativeLocale);
  for (const y of contentWords(kb, nativeLocale)) for (const x of wa) if (relatedWords(x, y)) return true;
  return false;
}

/** A deterministic rand from a string (mulberry32 over a sha256 of it): the
 *  queue and the answer route draw the same choices for the same card. */
export function seededRand(seed) {
  let s = createHash("sha256").update(String(seed)).digest().readUInt32LE(0);
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed of a listening card's choices: the phrase, its card version
 *  and its revision, so a card shows the same choices until it is answered
 *  or edited, and the answer route can draw them again to check a pick. */
export const choiceSeed = (phraseId, version, revision) => `${phraseId}:${version}:${revision}`;

/** A choice as the wire and the answer check carry it: one line, as
 *  readAnswerInput cleans a picked choice. */
const choiceText = (s) => clean(s).replace(CONTROLS_OR_BREAKS, " ").trim();

/** Whether a picked choice (as readAnswerInput cleaned it) is `meaning`. */
export const sameChoice = (meaning, pick) => !!meaning && choiceText(meaning) === pick;

/**
 * A listening card's meanings to pick from: the phrase's own and
 * CHOICES - 1 others from the same bank, in an order drawn from `seed`
 * (choiceSeed; the bank is taken in id order first, so the same bank and
 * seed always give the same choices). A distractor must be a practisable
 * phrase's meaning not too alike (tooAlike) the right one or another
 * distractor: two choices that could both be right, or read nearly the
 * same, make the pick a coin toss. Null when the bank has too few such
 * meanings: the learner types the answer instead. `rand` overrides the
 * seed in tests.
 */
export function listenChoices(phrase, bank, { nativeLocale = "", seed = "", rand = seededRand(seed) } = {}) {
  const pool = (bank ?? [])
    .filter((p) => p.id !== phrase.id && practisable(p))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Fisher-Yates over a copy, then take the first usable ones.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const right = choiceText(phrase.meaning);
  const picked = [];
  for (const p of pool) {
    if (picked.length === CHOICES - 1) break;
    const m = choiceText(p.meaning);
    if ([right, ...picked].some((other) => tooAlike(m, other, nativeLocale))) continue;
    picked.push(m);
  }
  if (picked.length < CHOICES - 1) return null;
  const at = Math.floor(rand() * CHOICES);
  picked.splice(at, 0, right);
  return picked;
}

/** The choices a listening card of `phrase` at card `version` offers (or
 *  null): what the queue sends, and what the answer route draws again to
 *  accept only a pick that was offered. */
export function offeredChoices(phrase, bank, { version, nativeLocale = "" }) {
  return listenChoices(phrase, bank, { nativeLocale, seed: choiceSeed(phrase.id, version, phraseRevision(phrase)) });
}

/* ---------------------------------- answers ---------------------------------- */

const CONTROLS_OR_BREAKS = /\s+/g;

/**
 * An answer body, checked: `{ value }` or `{ error }` for a 400.
 *   { phraseId, skill, drill?, version, revision, submitId, answer?, choice?, reveal?, rating?, clozeId?, spoken?, durationMs?, tz? }
 * `drill` is flashcard (the default: recognize or produce, typed),
 * listening (the listen card: a `choice` among the meanings offered, or a
 * typed `answer`), speak (the produce card: `answer` is what the
 * recogniser heard, and must not be empty) or cloze (the produce card as
 * a gap in the sentence `clozeId`: typed, or said with `spoken: true`,
 * then not empty). It is the review's mode.
 * `submitId` is a uuid the page makes once per card shown: a second POST
 * with the same id is the same submit (a double click, a retried fetch)
 * and gets the first's review back; another id at the same version is
 * another answer, a 409.
 * `reveal: true` (Reveal on a recognize flashcard, then the learner's own
 * grade) takes a `rating` 1-4 and no grading; otherwise the answer is
 * graded and `rating` is refused (an override comes after, by review
 * id). An answer or choice is one line, control characters dropped, at
 * most MAX_ANSWER characters as stored; a NUL is refused outright.
 */
export function readAnswerInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const { phraseId, skill, version, revision, submitId, answer, choice, reveal, rating, durationMs, tz } = body;
  // The drill the answer came from (reviews.mode); a page from before the
  // other drills sends none, which is a flashcard.
  const drill = body.drill === undefined ? "flashcard" : body.drill;
  if (!isUuid(phraseId)) return { error: "phraseId must be a phrase id" };
  if (!DRILLS.includes(drill)) return { error: `drill must be one of ${DRILLS.join(", ")}` };
  if (!DRILL_SKILLS[drill].includes(skill)) return { error: `a ${drill} answer's skill must be ${DRILL_SKILLS[drill].join(" or ")}` };
  if (!isVersion(version)) return { error: "version must be the card version the queue gave" };
  if (typeof revision !== "string" || !REVISION_RE.test(revision)) return { error: "revision must be the phrase revision the queue gave" };
  if (!isUuid(submitId)) return { error: "submitId must be a uuid made for this answer" };
  if (reveal !== undefined && typeof reveal !== "boolean") return { error: "reveal must be true or false" };
  if (reveal && drill !== "flashcard") return { error: "only a flashcard can be revealed" };
  const line = (v, name) => {
    if (typeof v !== "string") return { error: `${name} must be a string` };
    if (v.includes("\u0000")) return { error: `${name} can't contain a NUL character` };
    const t = clean(v).replace(CONTROLS_OR_BREAKS, " ").trim();
    if (t.length > MAX_ANSWER) return { error: `${name} is longer than ${MAX_ANSWER} characters` };
    return { t };
  };
  let text = "";
  if (answer !== undefined && answer !== null) {
    const a = line(answer, "answer");
    if (a.error) return a;
    text = a.t;
  }
  // A listening card's picked meaning: one of the choices the queue gave,
  // graded as the meaning or not (no model check, no near miss).
  let picked = null;
  if (choice !== undefined && choice !== null) {
    if (drill !== "listening") return { error: "choice goes with a listening answer" };
    if (answer !== undefined && answer !== null) return { error: "send a choice or an answer, not both" };
    const c = line(choice, "choice");
    if (c.error) return c;
    if (!c.t) return { error: "choice must be one of the meanings offered" };
    picked = c.t;
  }
  // A cloze answer names the sentence it was shown (a regenerated or
  // flagged one is then refused, never graded against the old gap), and
  // whether it was said (`spoken`: the recogniser's transcript) or typed.
  const clozeId = body.clozeId;
  if (drill === "cloze") {
    if (!isUuid(clozeId)) return { error: "clozeId must be the sentence the queue gave" };
    if (body.spoken !== undefined && typeof body.spoken !== "boolean") return { error: "spoken must be true or false" };
  } else if (clozeId !== undefined || body.spoken !== undefined) return { error: "clozeId and spoken go with a cloze answer" };
  const spoken = drill === "speak" || (drill === "cloze" && body.spoken === true);
  // Speak-it (or a cloze said aloud) sends what the recogniser heard.
  // Nothing heard is not an answer (the page asks to record again), so it
  // never records a miss.
  if (spoken && !text) return { error: "nothing was heard: record your answer again" };
  let r = null;
  if (reveal) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 4) return { error: "a revealed card needs your rating: 1 (Again) to 4 (Easy)" };
    r = rating;
  } else if (rating !== undefined) {
    return { error: "rating goes with reveal; to change a graded answer, override its review" };
  }
  const d = Number.isInteger(durationMs) && durationMs >= 0 ? Math.min(durationMs, 3_600_000) : null;
  return {
    value: {
      phraseId: phraseId.toLowerCase(), skill, drill, version, revision, submitId: submitId.toLowerCase(), answer: picked ?? text, choice: picked !== null,
      reveal: !!reveal, rating: r, durationMs: d, utcOffsetMinutes: readUtcOffset(tz),
      clozeId: drill === "cloze" ? clozeId.toLowerCase() : null, spoken,
    },
  };
}

/** An override body: `{ rating: 1-4, tz? }`. */
export function readOverrideInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "the body must be a JSON object" };
  if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 4) return { error: "rating must be 1 (Again), 2 (Hard), 3 (Good) or 4 (Easy)" };
  return { value: { rating: body.rating, utcOffsetMinutes: readUtcOffset(body.tz) } };
}

/* ---------------------------------- grading ---------------------------------- */

/** English meanings often come with a leading "the" or "to" ("the
 *  change", "to eat") that an answer leaves off, or the other way round:
 *  not worth a model call. Only for an English native language. Not
 *  "a"/"an": "a few" and "a little" mean something else without it. */
const EN_LEAD = /^(the|to)\s+/i;
const isEnglish = (locale) => /^en(?![a-z])/i.test(String(locale ?? ""));

/** A meaning's own alternatives: "change; the turn", "kilo | half" and
 *  "kilo / half" list several, any of which is right. A slash only with
 *  spaces around it: "1/2", "24/7", "km/h", "and/or" and "he/she" are one
 *  meaning each. Not commas: "Keep the change, please" is one meaning, and
 *  "please" alone is not it. */
const meaningParts = (meaning) =>
  String(meaning ?? "")
    .split(/\s*[;|]\s*|\s+\/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The local check, before any model (DATA.md §Grading, match.mjs):
 *  - produce: the typed words against the phrase's words and the
 *    alternates the grader accepted before (accents and CJK spacing as
 *    matchAnswer has them);
 *  - recognize: the typed meaning against the phrase's meaning, each of
 *    the alternatives it lists, and (English) without a leading article
 *    or "to". Meanings vary too much to match strictly: a miss here is
 *    what the model check is for.
 * Returns matchAnswer's `{ verdict: exact|close|miss, note? }`.
 */
export function localMatch({ skill, answer, text, meaning, alternates = [], targetLocale = "", nativeLocale = "", spoken = false }) {
  if (skill === "produce") return matchAnswer({ answer, expected: text, alternates, lang: targetLocale, spoken });
  const parts = meaningParts(meaning);
  const expected = String(meaning ?? "");
  const first = matchAnswer({ answer, expected, alternates: parts, lang: nativeLocale });
  if (first.verdict !== "miss" || !isEnglish(nativeLocale)) return first;
  const bare = (s) => String(s).trim().replace(EN_LEAD, "");
  return matchAnswer({ answer: bare(answer ?? ""), expected: bare(expected), alternates: parts.map(bare), lang: nativeLocale });
}

/**
 * A typed answer to a listening card: the learner may write down the words
 * they heard or what they mean. Both readings are checked, as a dictation
 * (the words, as a produce card checks them) and as the meaning (as a
 * recognize card does), and the better verdict wins: exact on either beats
 * close on the other ("university" for French "université", meaning
 * "university", is the right meaning, not a typo of the words); of two
 * close ones, the nearer (an accent before a letter), the words on a tie.
 * `as` says which reading it is, and the note is that reading's. A miss on
 * both goes to the model check once, worded for a heard phrase (either
 * reading counts there).
 */
export function listenMatch({ answer, text, meaning, alternates = [], targetLocale = "", nativeLocale = "" }) {
  const words = { ...localMatch({ skill: "produce", answer, text, meaning, alternates, targetLocale }), as: "words" };
  const sense = { ...localMatch({ skill: "recognize", answer, text, meaning, targetLocale, nativeLocale }), as: "meaning" };
  // A miss on both is reported as the meaning: the model check grades it so.
  const best = closeness(sense) < closeness(words) || (sense.verdict === "miss" && words.verdict === "miss") ? sense : words;
  // Say which reading a near miss was taken as: the learner may have meant the other.
  if (best.verdict === "close" && best.note) return { ...best, note: `${best.as === "words" ? "as the words heard" : "as the meaning"}: ${best.note}` };
  return best;
}

/** How far a local verdict is from right: exact, an accent off, a letter
 *  off, a miss. */
function closeness(m) {
  if (m.verdict === "exact") return 0;
  if (m.verdict === "close") return /accent/.test(m.note ?? "") ? 1 : 2;
  return 3;
}

/**
 * A listening card's picked choice: right only when it is the phrase's
 * meaning (or one of its parts) exactly as localMatch compares meanings.
 * No near miss (a choice is clicked, not typed: one letter off is another
 * choice) and no model check. → matchAnswer's shape, `exact` or `miss`.
 */
export function choiceMatch({ choice, meaning, nativeLocale = "" }) {
  const m = localMatch({ skill: "recognize", answer: choice, meaning, nativeLocale });
  return m.verdict === "exact" ? { verdict: "exact" } : { verdict: "miss" };
}

/** What the model check is asked (match.mjs graderPrompt's inputs) for a
 *  card: the side shown, the side expected, and which way it is graded.
 *  A listening card's question is the words the learner heard (`heard`);
 *  a speak-it answer is a transcript (`spoken`), so spelling and
 *  punctuation are the recogniser's, not the learner's. */
export function graderQuestion({ skill, text, meaning, drill = "flashcard", spoken = drill === "speak", gapped = null, full = null }) {
  // A cloze answer fills a gap: the grader sees the sentence with a
  // neutral gap (cloze.mjs gapped), the meaning given as the hint, and the
  // whole sentence as written, to judge what else fits it.
  if (skill === "produce")
    return { question: meaning, expected: text, kind: "target", ...(spoken ? { spoken: true } : {}), ...(drill === "cloze" && gapped ? { gapped, ...(full ? { full } : {}) } : {}) };
  return { question: text, expected: meaning, kind: "meaning", ...(skill === "listen" ? { heard: true } : {}) };
}

const NOTE_MAX = 200;
const cleanNote = (s) => clean(s).replace(CONTROLS_OR_BREAKS, " ").trim().slice(0, NOTE_MAX) || null;

/**
 * The verdict, rating and note an answer is recorded with:
 *  - Reveal: `self` with the learner's rating;
 *  - the local match's exact (Good) or close (Hard, with its note);
 *  - a miss: the grader's reply (match.mjs parseGraderReply's shape):
 *    accepted is Good, or Hard when its hint says so; not accepted is
 *    `wrong` (Again). `grader` null (the check failed, or wasn't run for
 *    an empty answer) is `wrong` too, with a note that says why.
 * The grader's note is model output: one line, control characters gone,
 * at most NOTE_MAX characters.
 */
export function gradeOutcome({ reveal = false, rating = null, match, grader = null, graderFailed = false, answer = "" }) {
  if (reveal) return { verdict: "self", rating, note: null };
  if (match?.verdict === "exact") return { verdict: "exact", rating: ratingForVerdict("exact"), note: null };
  if (match?.verdict === "close") return { verdict: "close", rating: ratingForVerdict("close"), note: cleanNote(match.note ?? "") };
  if (grader?.accepted) return { verdict: "accepted", rating: ratingForVerdict("accepted", grader.rating_hint), note: cleanNote(grader.note) };
  if (grader) return { verdict: "wrong", rating: RATINGS.again, note: cleanNote(grader.note) };
  const why = !String(answer).trim() ? null : graderFailed ? "The answer couldn't be checked just now; if you were right, mark it Good." : null;
  return { verdict: "wrong", rating: RATINGS.again, note: why };
}

/** Whether a miss is worth the model check: something was typed. */
export const needsGrader = (match, answer) => match?.verdict === "miss" && String(answer ?? "").trim() !== "";

/**
 * `alternates` with `answer` added (an answer the grader accepted for a
 * produce card: the same answer is exact next time). Unchanged when it is
 * already there (as matchAnswer compares), too long to keep, or the list
 * is full. Recognize answers aren't kept: `phrases.alternates` holds other
 * target forms, and a meaning there would grade as the words.
 */
export function withAlternate(alternates, answer, { text = "", lang = "" } = {}) {
  const list = Array.isArray(alternates) ? alternates.filter((a) => typeof a === "string") : [];
  const a = clean(answer).replace(CONTROLS_OR_BREAKS, " ").trim();
  if (!keepable(a, text) || list.length >= MAX_ALTERNATES) return list;
  const key = normalizeAnswer(a, lang);
  if (!key || key === normalizeAnswer(text, lang) || list.some((x) => normalizeAnswer(x, lang) === key)) return list;
  return [...list, a];
}

/** How much longer than the words an alternate may be: another way to say
 *  a phrase is about its length, and a long answer the grader let through
 *  (a sentence around it, an instruction) shouldn't become an exact match
 *  for ever. */
export const ALTERNATE_RATIO = 2;
export const ALTERNATE_SLACK = 10;

/** Whether an accepted answer may be kept as an alternate: something, no
 *  braces (JSON or template text is never a phrase, and is what an answer
 *  that tries to steer the grader looks like), within LIMITS.text and at
 *  most ALTERNATE_RATIO × the words' length + ALTERNATE_SLACK characters. */
export function keepable(answer, text = "") {
  const a = String(answer ?? "");
  if (!a || /[{}]/.test(a) || a.length > LIMITS.text) return false;
  return a.length <= ALTERNATE_RATIO * String(text ?? "").length + ALTERNATE_SLACK;
}

/** `alternates` without `answer` (an Again override of an answer the grader
 *  had accepted: the learner says it wasn't right after all). */
export function withoutAlternate(alternates, answer, lang = "") {
  const list = Array.isArray(alternates) ? alternates.filter((a) => typeof a === "string") : [];
  const key = normalizeAnswer(answer, lang);
  return key ? list.filter((x) => normalizeAnswer(x, lang) !== key) : list;
}
