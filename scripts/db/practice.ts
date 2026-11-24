// Practice in the database (docs/DATA.md §Practice modes, §Grading): the
// rows a practice session reads (one language profile's phrases and their
// recognize, produce and listen cards, today's reviews) and the one write an answer
// makes (its review row, the card's new FSRS state, the phrase's last
// practised time and, for an accepted produce answer, its alternates). The
// pure half (the queue, the day, grading) is scripts/practice.mjs; the
// routes and the grader call are web/server/practice.ts.
//
// Owner scoping lives here and only here: every query goes through
// forLanguageProfile(tx, profile) (scripts/db/owned.ts) on the transaction
// it runs in, so another language's or learner's phrase or review id is
// the same "not found" as one that doesn't exist.
//
// Locks. An answer locks its phrase row, then its card (made first if it
// isn't there yet): phrase before card, the order a gloss capture takes
// them in (scripts/db/phrases.ts), and only that one phrase, so it never
// waits on another phrase's writer and holds no learner, profile or
// session lock (DATA.md §Language profiles lock order). The model check
// runs before the transaction, never inside it.
//
// Idempotency without a new column: the client answers against the card's
// version (practice.mjs cardVersion: reps and last review) and the
// phrase's revision (phraseRevision: its words, meaning and alternates as
// shown), with a submit id it made for this answer. Under the lock, a card
// still at that version, of a phrase still at that revision, takes the
// answer. A card that moved on is either this same submit again (a review
// of the card carries its submit id: answered with that review, nothing
// written) or another answer (ECONFLICT: skip it).
//
// What a practice review keeps beyond the card's state goes into its
// `card_before` jsonb, beside the FSRS fields (fromRow and cardVersion
// read only those): `submit_id` (the submit that wrote it) and
// `added_alternate` (the answer this review added to the phrase's
// alternates, so an override can take it back whatever the verdict says)
// and `tone_miss` (speak-it's right words recorded as a miss for a tone,
// with the grade they had: the reply's `toneMiss`, replay and override
// alike).
//
// Erasable TypeScript only, like phrases.ts: the tests import it as is.

import { and, desc, eq, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { fromRow, masteryBand, review as fsrsReview, toRow, type CardState, type Rating } from "../../scripts/fsrs.mjs";
import { clozeKey } from "../../scripts/cloze.mjs";
import { cardVersion, phraseRevision, withAlternate, withoutAlternate, type CandidatePhrase, type Outcome } from "../../scripts/practice.mjs";
import { storedToneMiss } from "../../scripts/pronunciation-review.mjs";
import type { PracticeAnswerReply, PracticeDrill, PracticeSkill, PracticeToneMiss, PracticeVerdict } from "../../web/shared/practice.ts";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { cards, clozeItems, phrases, reviews } from "./schema.ts";

type PhraseRow = typeof phrases.$inferSelect;
type CardRow = typeof cards.$inferSelect;
type ReviewRow = typeof reviews.$inferSelect;
type ClozeRow = typeof clozeItems.$inferSelect;

export class PracticeError extends Error {
  code: "ENOENT" | "ECONFLICT";
  constructor(code: PracticeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const SKILLS: PracticeSkill[] = ["recognize", "produce", "listen"];
/** The review modes a practice answer writes (reviews.mode): every one but
 *  a session's recap, the kids word game's `picture` included (its taps go
 *  through recordAnswer too). A submit id or an override is looked up among
 *  these. */
const DRILL_MODES: (PracticeDrill | "picture")[] = ["flashcard", "listening", "speak", "cloze", "picture"];

/* ---------------------------------- reads ---------------------------------- */

/**
 * What the queue is built from: the bank's phrases a card can ask
 * (words and a meaning, not suspended) with their recognize, produce and listen
 * cards. Read whole, like the bank's list: one learner's language.
 */
export async function practiceCandidates(db: Db, profile: LanguageProfileRef): Promise<CandidatePhrase[]> {
  const mine = forLanguageProfile(db, profile);
  const rows = await mine.list(phrases, and(isNotNull(phrases.text), isNotNull(phrases.meaning), eq(phrases.suspended, false)) as SQL);
  if (!rows.length) return [];
  const cardRows = await mine.list(cards, inArray(cards.skill, SKILLS));
  const byPhrase = new Map<string, CardRow[]>();
  for (const c of cardRows) byPhrase.set(c.phraseId, [...(byPhrase.get(c.phraseId) ?? []), c]);
  return rows.map((p) => ({
    id: p.id,
    text: p.text,
    meaning: p.meaning,
    reading: p.reading,
    lang: p.lang,
    starred: p.starred,
    suspended: p.suspended,
    lastSeenAt: p.lastSeenAt,
    createdAt: p.createdAt,
    alternates: p.alternates,
    cards: (byPhrase.get(p.id) ?? []).map((c) => ({ skill: c.skill, due: c.due, reps: c.reps, state: c.state, last_review: c.last_review })),
  }));
}

/**
 * Today's practice so far (since `since`, the learner's day start): first
 * reviews of cards (`card_before` had no reps) and the other reviews. A
 * session's reviews (the post-session recap) are not practice and don't
 * count against the limits. An override changes a review in place, so it
 * counts once.
 */
export async function practiceDone(db: Db, profile: LanguageProfileRef, since: Date): Promise<{ new: number; reviews: number }> {
  const firstReview = sql`coalesce((${reviews.cardBefore}->>'reps')::int, 0) = 0`;
  const [row] = await db
    .select({
      fresh: sql<number>`count(*) filter (where ${firstReview})::int`,
      again: sql<number>`count(*) filter (where not (${firstReview}))::int`,
    })
    .from(reviews)
    .where(forLanguageProfile(db, profile).where(reviews, and(ne(reviews.mode, "session"), sql`${reviews.reviewedAt} >= ${since.toISOString()}::timestamptz`) as SQL));
  return { new: Number(row?.fresh ?? 0), reviews: Number(row?.again ?? 0) };
}

/** A phrase and its card of `skill` (null when not made yet), unlocked:
 *  what an answer is graded against before its transaction. ENOENT for
 *  none of this language's; ECONFLICT for one a flashcard can't ask. */
export async function practiceCard(db: Db, profile: LanguageProfileRef, phraseId: string, skill: PracticeSkill): Promise<{ phrase: PhraseRow; card: CardRow | null }> {
  const mine = forLanguageProfile(db, profile);
  const phrase = await mine.get(phrases, eq(phrases.id, phraseId));
  if (!phrase) throw new PracticeError("ENOENT", "no such phrase");
  practisableOr409(phrase);
  const card = (await mine.get(cards, and(eq(cards.phraseId, phraseId), eq(cards.skill, skill)) as SQL)) ?? null;
  return { phrase, card };
}

function practisableOr409(phrase: PhraseRow): void {
  if (phrase.text == null) throw new PracticeError("ECONFLICT", "this phrase has no words yet, so it can't be practised");
  if (!phrase.meaning) throw new PracticeError("ECONFLICT", "this phrase has no meaning, so it can't be practised");
  if (phrase.suspended) throw new PracticeError("ECONFLICT", "this phrase is suspended: it stays out of practice");
}

/* ---------------------------------- writes --------------------------------- */

function reply(row: ReviewRow, card: CardRow, phrase: PhraseRow, extra: { alternateAdded: boolean; replayed: boolean }, cloze: ClozeRow | null = null): PracticeAnswerReply {
  const state = fromRow(card);
  const s = cloze?.sentence;
  return {
    review: { id: Number(row.id), rating: row.rating as Rating, verdict: (row.verdict ?? "self") as PracticeVerdict, note: row.graderNote, answer: row.answer },
    card: { version: cardVersion(state), due: state.due, mastery: masteryBand(state), state: state.state, reps: state.reps, lapses: state.lapses },
    expected: { text: phrase.text ?? "", meaning: phrase.meaning ?? "", ...(phrase.reading ? { reading: phrase.reading } : {}) },
    cloze:
      s != null && cloze!.blankStart != null && cloze!.blankEnd != null
        ? { before: s.slice(0, cloze!.blankStart), blank: s.slice(cloze!.blankStart, cloze!.blankEnd), after: s.slice(cloze!.blankEnd) }
        : null,
    toneMiss: storedToneMiss(extrasOf(row).tone_miss),
    ...extra,
  };
}

/** A review's cloze item (card_before.cloze_id), if it was a cloze answer
 *  and the item is still there: for the reply's sentence. */
async function clozeOf(tx: Db, profile: LanguageProfileRef, row: ReviewRow): Promise<ClozeRow | null> {
  const id = extrasOf(row).cloze_id;
  return id ? ((await forLanguageProfile(tx, profile).get(clozeItems, eq(clozeItems.id, id))) ?? null) : null;
}

/** The phrase, then its card of `skill` (made if missing), both locked for
 *  the transaction: the lock order above. */
async function lockPhraseAndCard(tx: Db, profile: LanguageProfileRef, phraseId: string, skill: PracticeSkill): Promise<{ phrase: PhraseRow; card: CardRow }> {
  const mine = forLanguageProfile(tx, profile);
  const [phrase] = await tx.select().from(phrases).where(mine.where(phrases, eq(phrases.id, phraseId))).for("update");
  if (!phrase) throw new PracticeError("ENOENT", "no such phrase");
  // Cards are made lazily, per skill, on the first answer (DATA.md "Three
  // cards per phrase"). A card made by a capture meanwhile is kept.
  await mine.insertOrIgnore(cards, { phraseId, skill });
  const [card] = await tx
    .select()
    .from(cards)
    .where(mine.where(cards, and(eq(cards.phraseId, phraseId), eq(cards.skill, skill)) as SQL))
    .for("update");
  return { phrase, card };
}

/** What a practice review stores in card_before besides the card. */
interface ReviewExtras {
  submit_id?: string;
  added_alternate?: string;
  /** A cloze answer's sentence (cloze_items.id). */
  cloze_id?: string;
  /** Speak-it's right words recorded as a miss for a tone (stage 3,
   *  pronunciation-review.mjs practiceToneMiss). */
  tone_miss?: unknown;
}
const extrasOf = (row: ReviewRow): ReviewExtras => (row.cardBefore ?? {}) as ReviewExtras;

/** The card's review written by submit `submitId`, or undefined. */
async function reviewBySubmit(tx: Db, profile: LanguageProfileRef, cardId: string, submitId: string): Promise<ReviewRow | undefined> {
  return forLanguageProfile(tx, profile).get(
    reviews,
    and(eq(reviews.cardId, cardId), inArray(reviews.mode, DRILL_MODES), sql`${reviews.cardBefore}->>'submit_id' = ${submitId}`) as SQL,
  );
}

/** The card's latest review, or undefined. */
async function latestReview(tx: Db, profile: LanguageProfileRef, cardId: string): Promise<ReviewRow | undefined> {
  const [row] = await forLanguageProfile(tx, profile).list(reviews, eq(reviews.cardId, cardId), { orderBy: desc(reviews.id), limit: 1 });
  return row;
}

export interface AnswerWrite {
  phraseId: string;
  skill: PracticeSkill;
  /** The drill the answer came from: the review's mode (`picture`: the
   *  kids word game, web/server/pictures.ts). */
  drill: PracticeDrill | "picture";
  /** The card version the client answered against. */
  version: string;
  /** The phrase revision the card was shown (and graded) at: an edit of
   *  the phrase since makes the grade stale (ECONFLICT). */
  revision: string;
  /** The page's id for this answer: a repeat of it is a replay. */
  submitId: string;
  /** The grade; null when the card was already past `version` before
   *  grading (a repeat): then only a replay can answer it. */
  outcome: Outcome | null;
  answer: string | null;
  durationMs: number | null;
  utcOffsetMinutes: number;
  /** For an accepted produce answer: keep it as an alternate. */
  keepAlternate: boolean;
  /** The target locale, for comparing alternates (CJK spacing). */
  targetLocale: string;
  /** A cloze answer: the sentence it was shown, and the clozeKey the
   *  phrase had when it was graded. Checked again under the lock. */
  cloze?: { id: string; key: string } | null;
  /** Speak-it's right words recorded as a miss for a tone (stage 3): what
   *  the grade would have been, kept with the review (card_before
   *  .tone_miss) so a replay and an override's reply say why. */
  toneMiss?: PracticeToneMiss | null;
  now: Date;
}

/** The 409s for a cloze sentence that can't take an answer any more. */
export const CLOZE_GONE = "this sentence was changed or removed since the card was shown; skip it";
export const CLOZE_FLAGGED = "you flagged this sentence, so it can't be answered; skip it";

/** Whether cloze item `row` can take an answer for `phraseId` at `key`:
 *  null, or the 409's message. */
export function clozeProblem(row: ClozeRow | undefined | null, phraseId: string, key: string): string | null {
  if (!row || row.phraseId !== phraseId || row.sentence == null || row.phraseKey !== key) return CLOZE_GONE;
  if (row.flaggedAt) return CLOZE_FLAGGED;
  return null;
}

/**
 * Record one answer (DATA.md §Grading), in one transaction: the reviews row
 * (its mode the drill: flashcard, listening or speak; the card's state before it in `card_before`), the card's
 * new FSRS state, the phrase's last practised time and, for an accepted
 * produce answer, the answer among its alternates. A repeat of a submit
 * already recorded gets that review back (`replayed`), writing nothing.
 */
export async function recordAnswer(db: Db, profile: LanguageProfileRef, w: AnswerWrite): Promise<PracticeAnswerReply> {
  return db.transaction(async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    const { phrase, card } = await lockPhraseAndCard(tx, profile, w.phraseId, w.skill);
    const before = fromRow(card);
    if (cardVersion(before) !== w.version) {
      // Only this very submit is a replay: another answer at the same
      // version (another tab) must not come back as if it were this one.
      const same = await reviewBySubmit(tx, profile, card.id, w.submitId);
      if (same) return reply(same, card, phrase, { alternateAdded: false, replayed: true }, await clozeOf(tx, profile, same));
      throw new PracticeError("ECONFLICT", "this card was practised somewhere else (another tab?) since it was shown; it has been skipped");
    }
    practisableOr409(phrase);
    // Graded as a repeat, yet the card is back at this version: can't
    // happen (a review only moves a card on), and must never record a guess.
    if (!w.outcome) throw new PracticeError("ECONFLICT", "this card changed while you answered; it has been skipped");
    const outcome = w.outcome;
    if (phraseRevision(phrase) !== w.revision) throw new PracticeError("ECONFLICT", EDITED);
    // A cloze answer: its sentence still there, of this phrase's words and
    // meaning, and not flagged (a flag or a fill since grading).
    let cloze: ClozeRow | null = null;
    if (w.drill === "cloze") {
      cloze = (await mine.get(clozeItems, eq(clozeItems.id, w.cloze?.id ?? ""))) ?? null;
      const problem = clozeProblem(cloze, phrase.id, clozeKey(phrase));
      if (problem) throw new PracticeError("ECONFLICT", problem);
    }
    const next =fsrsReview(before, outcome.rating, w.now, { utcOffsetMinutes: w.utcOffsetMinutes }).card;
    const alternates = w.keepAlternate && w.answer ? withAlternate(phrase.alternates, w.answer, { text: phrase.text ?? "", lang: w.targetLocale }) : phrase.alternates;
    const alternateAdded = alternates.length !== phrase.alternates.length;
    const [updated] = await mine.update(cards, toRow(next), eq(cards.id, card.id));
    const [row] = await mine.insert(reviews, {
      cardId: card.id,
      mode: w.drill,
      rating: outcome.rating,
      answer: w.answer,
      verdict: outcome.verdict,
      graderNote: outcome.note,
      durationMs: w.durationMs,
      reviewedAt: w.now,
      cardBefore: {
        ...before,
        submit_id: w.submitId,
        ...(alternateAdded ? { added_alternate: alternates[alternates.length - 1] } : {}),
        ...(cloze ? { cloze_id: cloze.id } : {}),
        ...(w.toneMiss ? { tone_miss: w.toneMiss } : {}),
      },
    });
    const [p] = await mine.update(
      phrases,
      {
        lastPracticedAt: sql`greatest(${phrases.lastPracticedAt}, ${w.now.toISOString()}::timestamptz)`,
        ...(alternateAdded ? { alternates } : {}),
      },
      eq(phrases.id, phrase.id),
    );
    return reply(row, updated, p, { alternateAdded, replayed: false }, cloze);
  });
}

/** The 409 for a phrase edited since its card was shown. */
export const EDITED = "this phrase was edited since the card was shown (another tab?); skip it, and it comes back as edited in a later session";

/** A review id from a route: a positive integer (reviews.id is a bigserial). */
export function reviewId(v: unknown): number | null {
  if (typeof v !== "string" || !/^[1-9]\d{0,14}$/.test(v)) return null;
  return Number(v);
}

/**
 * Change a practice answer's grade (DATA.md §Grading, Override): the card
 * is restored from the review's `card_before` and reviewed again, at the
 * review's own time, with the learner's rating; the review row keeps its
 * answer and note and becomes that rating with verdict `self`. Only the
 * card's latest review can be changed (a later one was graded from the
 * state this one left: ECONFLICT). The same rating again changes nothing,
 * so a repeated override is harmless. An Again takes back the alternate
 * this review added (card_before.added_alternate), whatever its verdict
 * says now (an earlier override made it `self`); a later Good doesn't put
 * it back: the learner said once it was wrong.
 */
export async function overrideReview(
  db: Db,
  profile: LanguageProfileRef,
  id: number,
  opts: { rating: Rating; utcOffsetMinutes: number; targetLocale: string },
): Promise<PracticeAnswerReply> {
  return db.transaction(async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    const found = await mine.get(reviews, and(eq(reviews.id, id), inArray(reviews.mode, DRILL_MODES)) as SQL);
    if (!found) throw new PracticeError("ENOENT", "no such review");
    const cardRow = await mine.get(cards, eq(cards.id, found.cardId));
    if (!cardRow) throw new PracticeError("ENOENT", "no such review");
    const { phrase, card } = await lockPhraseAndCard(tx, profile, cardRow.phraseId, cardRow.skill as PracticeSkill);
    const last = await latestReview(tx, profile, card.id);
    if (!last || Number(last.id) !== id) throw new PracticeError("ECONFLICT", "this card has been reviewed again since; only its latest answer can be changed");
    if (last.rating === opts.rating) return reply(last, card, phrase, { alternateAdded: false, replayed: true }, await clozeOf(tx, profile, last));
    const before = fromRow(last.cardBefore as unknown as CardState);
    const restored = fsrsReview(before, opts.rating, last.reviewedAt, { utcOffsetMinutes: opts.utcOffsetMinutes }).card;
    const [updated] = await mine.update(cards, toRow(restored), eq(cards.id, card.id));
    const [row] = await mine.update(reviews, { rating: opts.rating, verdict: "self" }, eq(reviews.id, id));
    let p = phrase;
    const added = extrasOf(last).added_alternate;
    if (opts.rating === 1 && added) {
      const alternates = withoutAlternate(phrase.alternates, added, opts.targetLocale);
      if (alternates.length !== phrase.alternates.length) [p] = await mine.update(phrases, { alternates }, eq(phrases.id, phrase.id));
    }
    return reply(row, updated, p, { alternateAdded: false, replayed: false }, await clozeOf(tx, profile, row));
  });
}
