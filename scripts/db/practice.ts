// Practice in the database (docs/DATA.md §Practice modes, §Grading): the
// rows a flashcard session reads (one language profile's phrases and their
// recognize and produce cards, today's reviews) and the one write an answer
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
// Idempotency without a client id column: the client answers against the
// card's version (practice.mjs cardVersion: reps and last review). Under
// the lock, a card still at that version takes the answer; one that moved
// on is either the same submit again (the card's latest review was a
// flashcard review whose card_before has that version: answered with that
// review, nothing written) or another tab's answer (ECONFLICT: skip it).
//
// Erasable TypeScript only, like phrases.ts: the tests import it as is.

import { and, desc, eq, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { fromRow, masteryBand, review as fsrsReview, toRow, type CardState, type Rating } from "../../scripts/fsrs.mjs";
import { cardVersion, withAlternate, withoutAlternate, type CandidatePhrase, type Outcome } from "../../scripts/practice.mjs";
import type { PracticeAnswerReply, PracticeSkill, PracticeVerdict } from "../../web/shared/practice.ts";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { cards, phrases, reviews } from "./schema.ts";

type PhraseRow = typeof phrases.$inferSelect;
type CardRow = typeof cards.$inferSelect;
type ReviewRow = typeof reviews.$inferSelect;

export class PracticeError extends Error {
  code: "ENOENT" | "ECONFLICT";
  constructor(code: PracticeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const SKILLS: PracticeSkill[] = ["recognize", "produce"];

/* ---------------------------------- reads ---------------------------------- */

/**
 * What the queue is built from: the bank's phrases a flashcard can ask
 * (words and a meaning, not suspended) with their recognize and produce
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
    lang: p.lang,
    starred: p.starred,
    suspended: p.suspended,
    lastSeenAt: p.lastSeenAt,
    createdAt: p.createdAt,
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

function reply(row: ReviewRow, card: CardRow, phrase: PhraseRow, extra: { alternateAdded: boolean; replayed: boolean }): PracticeAnswerReply {
  const state = fromRow(card);
  return {
    review: { id: Number(row.id), rating: row.rating as Rating, verdict: (row.verdict ?? "self") as PracticeVerdict, note: row.graderNote, answer: row.answer },
    card: { version: cardVersion(state), due: state.due, mastery: masteryBand(state), state: state.state, reps: state.reps, lapses: state.lapses },
    expected: { text: phrase.text ?? "", meaning: phrase.meaning ?? "" },
    ...extra,
  };
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

/** The card's latest review, or undefined. */
async function latestReview(tx: Db, profile: LanguageProfileRef, cardId: string): Promise<ReviewRow | undefined> {
  const [row] = await forLanguageProfile(tx, profile).list(reviews, eq(reviews.cardId, cardId), { orderBy: desc(reviews.id), limit: 1 });
  return row;
}

export interface AnswerWrite {
  phraseId: string;
  skill: PracticeSkill;
  /** The card version the client answered against. */
  version: string;
  /** The words and meaning the answer was graded against: an edit of the
   *  phrase meanwhile makes the grade stale (ECONFLICT). */
  graded: { text: string; meaning: string };
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
  now: Date;
}

/**
 * Record one answer (DATA.md §Grading), in one transaction: the reviews row
 * (mode flashcard, the card's state before it in `card_before`), the card's
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
      const last = await latestReview(tx, profile, card.id);
      if (last && last.mode === "flashcard" && cardVersion(last.cardBefore as unknown as CardState) === w.version) {
        return reply(last, card, phrase, { alternateAdded: false, replayed: true });
      }
      throw new PracticeError("ECONFLICT", "this card was practised somewhere else (another tab?) since it was shown; it has been skipped");
    }
    practisableOr409(phrase);
    // Graded as a repeat, yet the card is back at this version: can't
    // happen (a review only moves a card on), and must never record a guess.
    if (!w.outcome) throw new PracticeError("ECONFLICT", "this card changed while you answered; it has been skipped");
    const outcome = w.outcome;
    if (phrase.text !== w.graded.text || phrase.meaning !== w.graded.meaning) {
      throw new PracticeError("ECONFLICT", "this phrase was edited while you answered; it has been skipped");
    }
    const next = fsrsReview(before, outcome.rating, w.now, { utcOffsetMinutes: w.utcOffsetMinutes }).card;
    const [updated] = await mine.update(cards, toRow(next), eq(cards.id, card.id));
    const [row] = await mine.insert(reviews, {
      cardId: card.id,
      mode: "flashcard",
      rating: outcome.rating,
      answer: w.answer,
      verdict: outcome.verdict,
      graderNote: outcome.note,
      durationMs: w.durationMs,
      reviewedAt: w.now,
      cardBefore: before as unknown as Record<string, unknown>,
    });
    const alternates = w.keepAlternate && w.answer ? withAlternate(phrase.alternates, w.answer, { text: phrase.text ?? "", lang: w.targetLocale }) : phrase.alternates;
    const alternateAdded = alternates.length !== phrase.alternates.length;
    const [p] = await mine.update(
      phrases,
      {
        lastPracticedAt: sql`greatest(${phrases.lastPracticedAt}, ${w.now.toISOString()}::timestamptz)`,
        ...(alternateAdded ? { alternates } : {}),
      },
      eq(phrases.id, phrase.id),
    );
    return reply(row, updated, p, { alternateAdded, replayed: false });
  });
}

/** A review id from a route: a positive integer (reviews.id is a bigserial). */
export function reviewId(v: unknown): number | null {
  if (typeof v !== "string" || !/^[1-9]\d{0,14}$/.test(v)) return null;
  return Number(v);
}

/**
 * Change a flashcard answer's grade (DATA.md §Grading, Override): the card
 * is restored from the review's `card_before` and reviewed again, at the
 * review's own time, with the learner's rating; the review row keeps its
 * answer and note and becomes that rating with verdict `self`. Only the
 * card's latest review can be changed (a later one was graded from the
 * state this one left: ECONFLICT). The same rating again changes nothing,
 * so a repeated override is harmless. An Again on an answer the grader had
 * accepted takes it back out of the phrase's alternates.
 */
export async function overrideReview(
  db: Db,
  profile: LanguageProfileRef,
  id: number,
  opts: { rating: Rating; utcOffsetMinutes: number; targetLocale: string },
): Promise<PracticeAnswerReply> {
  return db.transaction(async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    const found = await mine.get(reviews, and(eq(reviews.id, id), eq(reviews.mode, "flashcard")) as SQL);
    if (!found) throw new PracticeError("ENOENT", "no such review");
    const cardRow = await mine.get(cards, eq(cards.id, found.cardId));
    if (!cardRow) throw new PracticeError("ENOENT", "no such review");
    const { phrase, card } = await lockPhraseAndCard(tx, profile, cardRow.phraseId, cardRow.skill as PracticeSkill);
    const last = await latestReview(tx, profile, card.id);
    if (!last || Number(last.id) !== id) throw new PracticeError("ECONFLICT", "this card has been reviewed again since; only its latest answer can be changed");
    if (last.rating === opts.rating) return reply(last, card, phrase, { alternateAdded: false, replayed: true });
    const before = fromRow(last.cardBefore as unknown as CardState);
    const next = fsrsReview(before, opts.rating, last.reviewedAt, { utcOffsetMinutes: opts.utcOffsetMinutes }).card;
    const [updated] = await mine.update(cards, toRow(next), eq(cards.id, card.id));
    const [row] = await mine.update(reviews, { rating: opts.rating, verdict: "self" }, eq(reviews.id, id));
    let p = phrase;
    if (opts.rating === 1 && last.verdict === "accepted" && last.answer && cardRow.skill === "produce") {
      const alternates = withoutAlternate(phrase.alternates, last.answer, opts.targetLocale);
      if (alternates.length !== phrase.alternates.length) [p] = await mine.update(phrases, { alternates }, eq(phrases.id, phrase.id));
    }
    return reply(row, updated, p, { alternateAdded: false, replayed: false });
  });
}
