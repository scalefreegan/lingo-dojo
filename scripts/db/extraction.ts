// The post-session extraction in the database (docs/DATA.md §Post-session
// extraction): the claim that lets one run at a time make a conversation's
// recap, and the one transaction that stores it and applies it to the
// language's phrase bank. The model call and the routes are
// web/server/extraction.ts; the pure half (what the reply may do, the
// transcript, examples) is scripts/extraction.mjs.
//
// Owner scoping: every query goes through forLanguageProfile (the
// conversation's language), like scripts/db/phrases.ts, whose bank helpers
// (the upsert identity, the pending merge, the recount, the retry) this
// reuses rather than copies. These are the bank's only writes outside that
// file.
//
// The claim. `conversations.extraction_status` goes to 'running' with a
// fresh `extraction_claim` token in one conditional UPDATE, so two Ends
// (two tabs, End racing the idle end) or a Retry racing the end's own run
// make one run; the loser's UPDATE matches nothing. The run's final write
// takes the conversation row FOR UPDATE and only goes ahead while the row
// still holds its token, so a run that lost its claim (taken over after it
// was presumed dead) writes nothing. A 'running' row whose token no live
// run of this server holds (the server restarted mid-run) may be claimed
// again: one server process, so its own memory knows (`live`).
//
// Idempotent. A conversation's recap can be made again (Retry recap, or
// again after it was made). Whatever the last run wrote is replaced, not
// added to: its session reviews (reviews.mode 'session', one per card and
// conversation by a unique index) are undone from `card_before` when no
// later review of that card exists, and its sightings (source
// 'extraction') deleted, before the new reply's are written. A card
// reviewed again since (in practice) keeps that history: the old session
// review stays and the new reply doesn't review that card; nor does a
// recap made (or retried) after a card was reviewed later than the
// session's end: FSRS reviews only go forward. Practice reads only the FSRS
// fields of a session review's card_before and never regrades one (its
// override takes mode 'flashcard' rows only). Phrases the
// recap kept stay where they are; one the re-run leaves with no sighting
// goes by the rule a dropped reply's undo uses (phrases.ts settleUnseen:
// only automatic paths held it, gloss or extraction, nothing the learner
// set, no reviewed card).
//
// Lock order, the bank's (scripts/db/phrases.ts): the conversation row,
// then, in one norm-ordered pass (lockInNormOrder), every complete phrase
// the write touches: the reply's kept phrases (an upsert inserts or locks
// each), the phrases its events name (by norm) and the phrases the last
// run sighted or reviewed (by id, at the norm they had when read, so one
// renamed meanwhile is still locked, restored and recounted); then the
// pending rows the merge folds in, then cards. A collision with a capture
// at the same moment is retried once.
//
// Erasable TypeScript only: the tests import it as is.

import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { keepExample, planExtraction, type Extraction, type StoredTurn } from "../../scripts/extraction.mjs";
import { fromRow, review, toRow, type CardState } from "../../scripts/fsrs.mjs";
import { normKey } from "../../scripts/match.mjs";
import { MAX_EXAMPLES, phraseMetrics } from "../../scripts/phrases.mjs";
import { MAX_SESSION_TONE_MISSES, saidItsWords, sessionToneMisses, type ToneLine } from "../../scripts/pronunciation-review.mjs";
import type { MasteryBand, RecapEvent, RecapToneMiss, RecapVsLast } from "../../web/shared/wire.ts";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { AUTO_MEANING, COMPLETE, IDENTITY, absorbPending, lockById, lockInNormOrder, recount, retrying, settleUnseen, stronger } from "./phrases.ts";
import { cards, conversations, phraseDismissals, phraseExamples, phraseSightings, phrases, reviews } from "./schema.ts";

type Conversation = typeof conversations.$inferSelect;
type PhraseRow = typeof phrases.$inferSelect;
export type ExtractionStatus = Conversation["extractionStatus"];

/** What a run stores in `conversations.extraction`: the parsed reply, with
 *  the bank phrase each item was matched to (never an id from the model). */
export interface StoredRecap {
  v: 1;
  summary: string;
  keep: { text: string; meaning: string; why: string; phraseId: string | null }[];
  events: RecapEvent[];
  corrections: { said: string; better: string; note: string }[];
  /** Items the parser or the plan left out. */
  dropped: number;
  /** The session was in the bank's language: its phrases went in. */
  inBank: boolean;
  /** Compared with the attempt it built on (scripts/revisit.mjs
   *  compareAttempts; DATA.md §Revisit); absent when it built on none. */
  vsLast?: RecapVsLast | null;
  /** Mandarin (ld-4i2): the words of the session whose reading the reader
   *  couldn't settle, and what the recap made of each
   *  (web/server/readings.ts judgeRecapReadings); absent when none was asked. */
  readings?: StoredRecapReading[];
  /** Mandarin, adults (ld-ne0.18): the phrases the session's tone flags
   *  failed, or would have; absent when none. */
  tones?: StoredToneMiss[];
}

/** A phrase a tone flag failed. `was`: the rating the model's own event
 *  gave the same card (null: it named none, or failed it for this tone:
 *  ld-ne0.20), restored by "I said it right",
 *  which sets `dismissed` (kept over a re-run). `reviewed`: the miss is the
 *  session's review of the card. `flags`: where it was heard (the line, the
 *  place in it), so a dismissal holds for those flags whatever phrase a
 *  re-run would find them in. */
export interface StoredToneMiss extends RecapToneMiss {
  was: number | null;
  flags: { line: string; place: number }[];
  reviewed: boolean;
  /** A dismissal only kept for a later run: this one has no such miss, so
   *  it isn't shown. */
  idle?: boolean;
}

/** One word the recap was asked to read (web/server/readings.ts JudgedReading). */
export interface StoredRecapReading {
  word: string;
  key: string;
  sentence: string;
  /** UTF-16 offset of the word in `sentence`. */
  at: number;
  reader: string;
  answer: string | null;
  verdict: "differs" | "agrees" | "dropped";
}

/* ---------------------------------- claim ---------------------------------- */

/**
 * Claim an ended conversation's recap for one run: 'running' with a new
 * token, when its status is one of `from`, or 'running' under a token no
 * run holds (`live`: this server's running tokens; the run that set it
 * died with an earlier server). `claim` is the new token (a fresh one when
 * absent). Returns the token and the row, or null when it isn't this
 * language's, isn't ended, or another run has it.
 */
export async function claimExtraction(
  db: Db,
  profile: LanguageProfileRef,
  conversationId: string,
  opts: { from: ExtractionStatus[]; live: string[]; claim?: string },
): Promise<{ claim: string; conversation: Conversation } | null> {
  const claim = opts.claim ?? randomUUID();
  const c = conversations;
  const orphaned = sql`(${c.extractionStatus} = 'running' and ${notInArray(c.extractionClaim, opts.live.length ? opts.live : [claim])})`;
  const [row] = await forLanguageProfile(db, profile).update(
    conversations,
    { extractionStatus: "running", extractionClaim: claim, extractionStartedAt: sql`now()`, extractionError: null },
    sql`${c.id} = ${conversationId} and ${c.endedAt} is not null and (${opts.from.length ? inArray(c.extractionStatus, opts.from) : sql`false`} or ${orphaned})`,
  );
  return row ? { claim, conversation: row } : null;
}

/** One more model call for this conversation's recap (the count of all
 *  runs), by the run holding `claim`: a run that lost its claim counts
 *  nothing. */
export async function countAttempt(db: Db, profile: LanguageProfileRef, conversationId: string, claim: string): Promise<void> {
  await forLanguageProfile(db, profile).update(
    conversations,
    { extractionAttempts: sql`${conversations.extractionAttempts} + 1` },
    and(eq(conversations.id, conversationId), eq(conversations.extractionClaim, claim)) as SQL,
  );
}

/** End a run without a recap: 'failed' (with why) or 'skipped' (nothing
 *  to recap), if it still holds its claim. */
export async function finishExtraction(
  db: Db,
  profile: LanguageProfileRef,
  conversationId: string,
  claim: string,
  status: "failed" | "skipped",
  error: string | null = null,
): Promise<void> {
  await forLanguageProfile(db, profile).update(
    conversations,
    { extractionStatus: status, extractionClaim: null, extractionError: error == null ? null : error.slice(0, 1000) },
    and(eq(conversations.id, conversationId), eq(conversations.extractionClaim, claim)) as SQL,
  );
}

/* ---------------------------------- reads ---------------------------------- */

/** The phrases that were due when the session began (a reviewed card due
 *  by then), earliest first: the prompt gives the model their exact words,
 *  so an event about one is matched to it. */
export async function duePhrasesAt(db: Db, profile: LanguageProfileRef, at: Date, limit = 20): Promise<{ text: string; meaning?: string }[]> {
  const rows = await db
    .select({ text: phrases.text, meaning: phrases.meaning, due: sql<Date>`min(${cards.due})` })
    .from(phrases)
    .innerJoin(cards, eq(cards.phraseId, phrases.id))
    .where(forLanguageProfile(db, profile).where(phrases, sql`${COMPLETE} and not ${phrases.suspended} and ${cards.reps} > 0 and ${cards.due} <= ${at}`))
    .groupBy(phrases.id)
    .orderBy(sql`min(${cards.due})`)
    .limit(limit);
  return rows.map((r) => (r.meaning ? { text: r.text!, meaning: r.meaning } : { text: r.text! }));
}

/** How the recap's kept phrases stand now: starred, and their mastery band
 *  (from their cards, as the bank shows it). A phrase since deleted is
 *  missing from the map. */
export async function recapPhrases(db: Db, profile: LanguageProfileRef, ids: string[]): Promise<Map<string, { starred: boolean; mastery: MasteryBand }>> {
  const out = new Map<string, { starred: boolean; mastery: MasteryBand }>();
  if (!ids.length) return out;
  const mine = forLanguageProfile(db, profile);
  const rows = await mine.list(phrases, inArray(phrases.id, ids));
  const cardRows = await mine.list(cards, inArray(cards.phraseId, ids));
  for (const r of rows) out.set(r.id, { starred: r.starred, mastery: phraseMetrics(cardRows.filter((c) => c.phraseId === r.id)).mastery });
  return out;
}

/* ---------------------------------- write ---------------------------------- */

/**
 * Store a run's recap and apply it, in one transaction, if the run still
 * holds its claim (else null, nothing written). `bankLocale` is the
 * session's locale when it was in the bank's language (null: a pack moved
 * it to another, and the bank is left alone; "" for one with no known
 * locale). The reviews are dated at the conversation's end, in the
 * server's time zone (`utcOffsetMinutes`, for FSRS's day boundary), so the
 * same reply made again gives the same cards.
 */
export async function applyExtraction(
  db: Db,
  profile: LanguageProfileRef,
  opts: { conversationId: string; claim: string; value: Extraction; dropped: number; bankLocale: string | null; turns: StoredTurn[]; vsLast?: RecapVsLast | null; readings?: StoredRecapReading[]; toneLines?: ToneLine[] },
): Promise<StoredRecap | null> {
  return retrying(() =>
    db.transaction(async (tx) => {
      const mine = forLanguageProfile(tx, profile);
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(mine.where(conversations, and(eq(conversations.id, opts.conversationId), eq(conversations.extractionClaim, opts.claim)) as SQL))
        .for("update");
      if (!conv) return null;
      const { value } = opts;
      let recap: StoredRecap = {
        v: 1,
        summary: value.summary,
        keep: value.keep.map((k) => ({ text: k.text, meaning: k.meaning, why: k.why, phraseId: null })),
        events: value.events.map((e) => ({ phrase: e.phrase, kind: e.kind, said: e.said ?? null, note: e.note ?? null, phraseId: null, reviewed: false })),
        corrections: value.corrections,
        dropped: opts.dropped,
        inBank: false,
        ...(opts.vsLast ? { vsLast: opts.vsLast } : {}),
        ...(opts.readings?.length ? { readings: opts.readings } : {}),
      };
      if (opts.bankLocale != null) recap = await writeBank(tx, profile, conv, { ...opts, bankLocale: opts.bankLocale }, recap);
      await mine.update(
        conversations,
        {
          summary: value.summary || null,
          extraction: recap as unknown as Record<string, unknown>,
          extractedAt: sql`now()`,
          extractionStatus: "done",
          extractionClaim: null,
          extractionError: null,
        },
        eq(conversations.id, conv.id),
      );
      return recap;
    }),
  );
}

/** What the last run of this conversation's recap left in the bank. */
async function previousRun(tx: Db, profile: LanguageProfileRef, conversationId: string) {
  const mine = forLanguageProfile(tx, profile);
  const oldReviews = await tx
    .select({ review: reviews, phraseId: cards.phraseId, skill: cards.skill, norm: phrases.norm })
    .from(reviews)
    .innerJoin(cards, eq(cards.id, reviews.cardId))
    .innerJoin(phrases, eq(phrases.id, cards.phraseId))
    .where(mine.where(reviews, and(eq(reviews.conversationId, conversationId), eq(reviews.mode, "session")) as SQL))
    .orderBy(asc(reviews.cardId));
  const oldSightings = await tx
    .select({ phraseId: phraseSightings.phraseId, norm: phrases.norm })
    .from(phraseSightings)
    .innerJoin(phrases, eq(phrases.id, phraseSightings.phraseId))
    .where(mine.where(phraseSightings, and(eq(phraseSightings.conversationId, conversationId), eq(phraseSightings.source, "extraction")) as SQL));
  return { oldReviews, oldSightings };
}

async function writeBank(
  tx: Db,
  profile: LanguageProfileRef,
  conv: Conversation,
  opts: { claim: string; value: Extraction; dropped: number; bankLocale: string; turns: StoredTurn[]; toneLines?: ToneLine[] },
  recap: StoredRecap,
): Promise<StoredRecap> {
  const mine = forLanguageProfile(tx, profile);
  const at = new Date(conv.endedAt ?? Date.now());
  const locale = opts.bankLocale || null;
  const { oldReviews, oldSightings } = await previousRun(tx, profile, conv.id);

  // What the reply may name: the bank's complete phrases among its words,
  // less what the learner deleted from the bank (the model's suggestion
  // doesn't bring back a phrase they dismissed; a session's gloss would).
  const candidates = [...new Set([...opts.value.keep.map((k) => normKey(k.text)), ...opts.value.events.map((e) => normKey(e.phrase))].filter(Boolean))];
  const existing = candidates.length ? await mine.list(phrases, and(COMPLETE, inArray(phrases.norm, candidates)) as SQL) : [];
  // Both kinds of dismissal count: the words of a deleted phrase, and the
  // meaning of a deleted one (a scene's pending phrase has only that), so a
  // kept phrase with that meaning doesn't bring back what was just deleted.
  const meanings = [...new Set(opts.value.keep.map((k) => normKey(k.meaning)).filter(Boolean))];
  const dismissedOf = async (kind: "text" | "meaning", keys: string[]) =>
    keys.length
      ? new Set((await mine.list(phraseDismissals, and(eq(phraseDismissals.kind, kind), inArray(phraseDismissals.key, keys)) as SQL)).map((d) => d.key))
      : new Set<string>();
  const goneText = await dismissedOf("text", candidates);
  const goneMeaning = await dismissedOf("meaning", meanings);
  const known = new Set(existing.map((p) => p.norm!));
  const allowed = {
    ...opts.value,
    keep: opts.value.keep.filter((k) => known.has(normKey(k.text)) || (!goneText.has(normKey(k.text)) && !goneMeaning.has(normKey(k.meaning)))),
  };
  const plan = planExtraction(allowed, { known, locale });

  // The session's tone flags (ld-ne0.18): which phrase each is in, among the
  // bank's at the session's end and the ones this recap keeps (never one
  // only added since: an earlier run's keep isn't held there by its miss).
  // A phrase the model's own event already failed needs nothing more, unless
  // its words were right: then the tone is what was corrected, and the miss
  // stands for that event (fixed later or not: the model's Again doesn't
  // clear), so it can be taken back (ld-ne0.20).
  const toneLines = opts.toneLines ?? [];
  const failed = new Map(plan.events.filter((e) => e.skill === "produce" && e.rating === 1).map((e) => [e.norm, e]));
  const own = toneLines.length ? (await mine.list(phrases, COMPLETE)).filter((p) => new Date(p.createdAt) <= at) : [];
  const ownBy = new Map(own.map((p) => [p.norm, p]));
  const hadTones = storedTones(conv.extraction);
  const dismissed = new Map(hadTones.flatMap((t) => (t.dismissed ? [[t.phraseId, t] as const] : [])));
  // What the learner said they said right: those flags fail no other phrase
  // either (one this run keeps, or a shorter one once theirs is deleted).
  const flagKey = (f: { line: string; place: number }) => `${f.place}\u0000${f.line}`;
  const rightFlags = new Set([...dismissed.values()].flatMap((t) => (t.flags ?? []).map(flagKey)));
  const misses = new Map<string, ReturnType<typeof sessionToneMisses>[number]>();
  for (const m of sessionToneMisses(toneLines, [...own, ...plan.keep.filter((k) => !ownBy.has(k.norm)).map((k) => ({ norm: k.norm, text: k.text, late: true }))], { fixed: true })) {
    const event = failed.get(m.norm);
    if (event ? !saidItsWords(event.said, m.text) : m.fixed) continue;
    const row = ownBy.get(m.norm) ?? existing.find((p) => p.norm === m.norm);
    const gone = !!row && dismissed.has(row.id);
    if (!gone && m.flags.every((f) => rightFlags.has(flagKey(f)))) continue;
    misses.set(m.norm, m);
  }

  // Every complete phrase this write touches, in one norm-ordered pass:
  // kept ones upserted ("extraction" when new; a meaning only filled when
  // blank, the stronger provenance kept), the ones events name locked by
  // norm, the last run's locked by id.
  const keepBy = new Map(plan.keep.map((k) => [k.norm, k]));
  const norms = [...new Set([...plan.keep.map((k) => k.norm), ...plan.events.map((e) => e.norm), ...misses.keys()])];
  const prev = new Map([...oldReviews, ...oldSightings].map((o) => [o.phraseId, o.norm ?? ""]));
  const taken = await lockInNormOrder([
    ...norms.map((norm) => {
      const k = keepBy.get(norm);
      return {
        norm,
        take: async () =>
          (k
            ? await mine.upsert(
                phrases,
                { lang: opts.bankLocale, text: k.text, norm, meaning: k.meaning, source: "extraction" },
                { ...IDENTITY, set: { meaning: AUTO_MEANING, source: stronger(sql`${phrases.source}`, sql`excluded.source`) } },
              )
            : await tx.select().from(phrases).where(mine.where(phrases, and(COMPLETE, eq(phrases.norm, norm)) as SQL)).for("update"))[0],
      };
    }),
    ...[...prev].map(([id, norm]) => ({ norm, take: () => lockById(tx, profile, id) })),
  ]);
  const byNorm = new Map<string, PhraseRow>();
  norms.forEach((norm, i) => {
    if (taken[i]) byNorm.set(norm, taken[i]!);
  });
  const prevRows = taken.slice(norms.length).filter((r): r is PhraseRow => !!r);
  // The merge rule: a kept phrase whose meaning a scene's pending phrase
  // has absorbs it.
  await absorbPending(
    tx,
    profile,
    plan.keep.flatMap((k) => (byNorm.has(k.norm) ? [{ id: byNorm.get(k.norm)!.id, meaningNorm: k.meaningNorm }] : [])),
  );
  // The last run's phrases are in `ids` by id: recounted and settled even
  // when renamed since that run.
  const ids = [...new Set([...byNorm.values(), ...prevRows].map((r) => r.id))];
  const fresh = new Map((ids.length ? await mine.list(phrases, inArray(phrases.id, ids)) : []).map((r) => [r.id, r]));

  // Undo the last run: its sightings, and its reviews where nothing came
  // after them.
  await mine.remove(phraseSightings, and(eq(phraseSightings.conversationId, conv.id), eq(phraseSightings.source, "extraction")) as SQL);
  const restored = new Map<string, { reps: number; skill: string }>();
  const superseded = new Set<string>();
  for (const o of oldReviews) {
    const later = await mine.get(reviews, and(eq(reviews.cardId, o.review.cardId), gt(reviews.id, o.review.id)) as SQL);
    if (later) {
      superseded.add(o.review.cardId);
      continue;
    }
    const before = fromRow(o.review.cardBefore as Parameters<typeof fromRow>[0]);
    await mine.update(cards, toRow(before), eq(cards.id, o.review.cardId));
    await mine.remove(reviews, eq(reviews.id, o.review.id));
    restored.set(o.review.cardId, { reps: before.reps, skill: o.skill });
  }

  // The new reviews: one per card, rated by the event (fsrs.mjs
  // ratingForSessionEvent), the card's state before it kept on the row.
  const utcOffsetMinutes = -at.getTimezoneOffset();
  const reviewed = new Set<string>();
  const events = new Map<string, RecapEvent>();
  const tones: StoredToneMiss[] = [];
  // The cap counts the misses written, so one skipped (suspended, dismissed,
  // reviewed since) takes no place.
  let counted = 0;
  const grades = [
    ...plan.events.map((e) => ({ ...e, event: true, miss: e.skill === "produce" ? misses.get(e.norm) : undefined })),
    // A flagged phrase the model's events don't grade (said, and not
    // named): the miss is its only review.
    ...[...misses.values()]
      .filter((m) => !plan.events.some((e) => e.norm === m.norm && e.skill === "produce"))
      .map((m) => ({ norm: m.norm, phrase: m.text, kind: "corrected" as const, skill: "produce" as const, rating: 1 as const, said: null, note: null, event: false, miss: m })),
  ].sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
  for (const e of grades) {
    const row = fresh.get(byNorm.get(e.norm)?.id ?? "");
    const out: RecapEvent = { phrase: e.phrase, kind: e.kind, said: e.said, note: e.note, phraseId: row?.id ?? null, reviewed: false };
    if (e.event) events.set(`${e.norm}\u0000${e.skill}`, out);
    const gone = row && e.miss ? dismissed.get(row.id) : undefined;
    // The model failed it for the tone itself: no other grade to go back to.
    const modelMiss = e.event && e.rating === 1 && !!e.miss;
    const was = e.event && !modelMiss ? e.rating : null;
    const miss = row && e.miss ? { phraseId: row.id, phrase: e.miss.text, line: e.miss.line, syllables: e.miss.syllables, flags: e.miss.flags, was, reviewed: false, dismissed: !!gone } : null;
    if (miss) tones.push(miss);
    if ((!e.event && (gone || counted >= MAX_SESSION_TONE_MISSES)) || (modelMiss && gone)) continue;
    // A suspended phrase is out of practice by the learner's choice.
    if (!row || row.suspended) continue;
    await mine.insertOrIgnore(cards, { phraseId: row.id, skill: e.skill });
    const [card] = await tx.select().from(cards).where(mine.where(cards, and(eq(cards.phraseId, row.id), eq(cards.skill, e.skill)) as SQL)).for("update");
    if (!card || superseded.has(card.id)) continue;
    // Reviewed since the session ended (Practice, or a later session's
    // recap, before this one was made or retried): that review already
    // grades what the learner knows now, and FSRS can't go back in time.
    if (card.last_review && new Date(card.last_review) > at) continue;
    const before: CardState = fromRow(card);
    const tone = miss && !gone && (modelMiss || counted < MAX_SESSION_TONE_MISSES) ? miss : null;
    const rating = tone ? 1 : e.rating;
    const { card: next } = review(before, rating, at, { utcOffsetMinutes });
    await mine.update(cards, toRow(next), eq(cards.id, card.id));
    await mine.insert(reviews, {
      cardId: card.id,
      mode: "session",
      rating,
      answer: e.said ?? tone?.line ?? null,
      graderNote: e.note,
      reviewedAt: new Date(next.last_review ?? at),
      conversationId: conv.id,
      cardBefore: before as unknown as Record<string, unknown>,
    });
    reviewed.add(card.id);
    out.reviewed = true;
    if (tone) {
      tone.reviewed = true;
      if (!modelMiss) counted++;
    }
  }
  // A dismissal this run had no use for (the flag didn't come up, or the
  // model failed the phrase itself) is kept for the next one.
  // The last run's miss on a card reviewed since is still the card's
  // history (its review stays above): it stays listed as counted.
  const kept = new Set(oldReviews.filter((o) => o.skill === "produce" && superseded.has(o.review.cardId)).map((o) => o.phraseId));
  for (const t of hadTones) {
    if (!t.reviewed || !kept.has(t.phraseId)) continue;
    const i = tones.findIndex((x) => x.phraseId === t.phraseId);
    if (i >= 0) tones[i] = t;
    else tones.push(t);
  }
  for (const t of dismissed.values()) if (!tones.some((x) => x.phraseId === t.phraseId)) tones.push({ ...t, idle: true });
  // A listen or produce card only the last run had made, back to never
  // reviewed and not reviewed now, goes (practice makes it again).
  for (const [cardId, r] of restored) {
    if (!reviewed.has(cardId) && r.reps === 0 && r.skill !== "recognize") await mine.remove(cards, and(eq(cards.id, cardId), eq(cards.reps, 0)) as SQL);
  }

  // Seen in this session: a phrase the recap names that none of its
  // replies glossed gets one sighting, at the session's end.
  const touched = [...new Set([...plan.keep, ...plan.events, ...misses.values()].map((x) => byNorm.get(x.norm)?.id).filter((id): id is string => !!id && fresh.has(id)))];
  if (touched.length) {
    const glossed = new Set(
      (await mine.list(phraseSightings, and(eq(phraseSightings.conversationId, conv.id), inArray(phraseSightings.phraseId, touched)) as SQL)).map((s) => s.phraseId),
    );
    await mine.insertOrIgnore(
      phraseSightings,
      touched.filter((id) => !glossed.has(id)).map((phraseId) => ({ phraseId, conversationId: conv.id, turnId: null, seenAt: at, source: "extraction" as const })),
    );
  }
  // An example for each kept phrase: a line of the dojo master's that has it.
  for (const k of plan.keep) {
    const row = fresh.get(byNorm.get(k.norm)?.id ?? "");
    const ex = row && keepExample(k.text, opts.turns, locale);
    if (!row || !ex?.turnId) continue;
    const have = await mine.list(phraseExamples, eq(phraseExamples.phraseId, row.id), { limit: MAX_EXAMPLES });
    if (have.length < MAX_EXAMPLES && !have.some((h) => h.sentence === ex.sentence)) {
      await mine.insert(phraseExamples, { phraseId: row.id, conversationId: conv.id, turnId: ex.turnId, sentence: ex.sentence, speaker: ex.speaker });
    }
  }

  // Counts and times from the rows: seen from the sightings, last
  // practised from the reviews. (`ids` holds the last run's phrases too.)
  const all = ids;
  await recount(tx, profile, all);
  if (all.length) {
    await mine.update(
      phrases,
      { lastPracticedAt: sql`(select max(r.reviewed_at) from reviews r join cards c on c.id = r.card_id where c.phrase_id = "phrases"."id")` },
      inArray(phrases.id, all),
    );
  }
  // A phrase this run leaves with no sighting goes if only automatic paths
  // held it, as a dropped reply's does (scripts/db/phrases.ts settleUnseen,
  // the one rule for both, whichever undo comes last).
  await settleUnseen(tx, profile, all);

  return {
    ...recap,
    keep: plan.keep.map((k) => ({ text: k.text, meaning: k.meaning, why: k.why, phraseId: fresh.has(byNorm.get(k.norm)?.id ?? "") ? byNorm.get(k.norm)!.id : null })),
    events: [...events.values()],
    dropped: opts.dropped + plan.dropped,
    inBank: true,
    ...(tones.length ? { tones } : {}),
  };
}

/** The tone misses a stored recap kept (none for an older recap). */
function storedTones(extraction: unknown): StoredToneMiss[] {
  const tones = (extraction as Partial<StoredRecap> | null)?.tones;
  return Array.isArray(tones) ? tones : [];
}

/**
 * "I said it right" (ld-ne0.18): take back a tone miss of a conversation's
 * recap. The card goes back to `card_before` and is graded as the model's
 * own event had it (none: the review goes, with a card it made), so no
 * lapse is left behind; the miss is marked dismissed, which a re-run of the
 * recap keeps. → "done" (already dismissed counts), "none" (no counted miss
 * for that phrase), "busy" (the recap is being made) or "later" (the card
 * was reviewed since: that history isn't rewritten).
 * Locks in the bank's order: the conversation, the phrase, the card.
 */
export async function dismissToneMiss(db: Db, profile: LanguageProfileRef, conversationId: string, phraseId: string): Promise<"done" | "none" | "busy" | "later"> {
  return retrying(() =>
    db.transaction(async (tx) => {
      const mine = forLanguageProfile(tx, profile);
      const [conv] = await tx.select().from(conversations).where(mine.where(conversations, eq(conversations.id, conversationId))).for("update");
      if (!conv) return "none" as const;
      if (conv.extractionStatus !== "done") return "busy" as const;
      const tones = storedTones(conv.extraction);
      const miss = tones.find((t) => t.phraseId === phraseId);
      if (!miss) return "none" as const;
      if (miss.dismissed) return "done" as const;
      if (!miss.reviewed) return "none" as const;
      const row = await lockById(tx, profile, phraseId);
      if (!row) return "none" as const;
      const [card] = await tx.select().from(cards).where(mine.where(cards, and(eq(cards.phraseId, phraseId), eq(cards.skill, "produce")) as SQL)).for("update");
      const old = card && (await mine.get(reviews, and(eq(reviews.cardId, card.id), eq(reviews.conversationId, conv.id), eq(reviews.mode, "session")) as SQL));
      if (!card || !old) return "none" as const;
      if (await mine.get(reviews, and(eq(reviews.cardId, card.id), gt(reviews.id, old.id)) as SQL)) return "later" as const;
      const before = fromRow(old.cardBefore as Parameters<typeof fromRow>[0]);
      if (miss.was == null) {
        await mine.remove(reviews, eq(reviews.id, old.id));
        if (before.reps === 0) await mine.remove(cards, eq(cards.id, card.id));
        else await mine.update(cards, toRow(before), eq(cards.id, card.id));
      } else {
        const at = new Date(old.reviewedAt);
        const { card: next } = review(before, miss.was as Parameters<typeof review>[1], at, { utcOffsetMinutes: -at.getTimezoneOffset() });
        await mine.update(cards, toRow(next), eq(cards.id, card.id));
        const event = (conv.extraction as Partial<StoredRecap> | null)?.events?.find((e) => e.phraseId === phraseId && e.kind !== "understood" && e.kind !== "confused");
        await mine.update(reviews, { rating: miss.was, answer: event?.said ?? null }, eq(reviews.id, old.id));
      }
      await mine.update(
        phrases,
        { lastPracticedAt: sql`(select max(r.reviewed_at) from reviews r join cards c on c.id = r.card_id where c.phrase_id = "phrases"."id")` },
        eq(phrases.id, phraseId),
      );
      const recap = conv.extraction as unknown as StoredRecap;
      // The model's own failing event, when there was one, graded nothing now.
      const events = miss.was == null ? (recap.events ?? []).map((e) => (e.phraseId === phraseId && e.kind === "corrected" ? { ...e, reviewed: false } : e)) : recap.events;
      const next = { ...recap, events, tones: tones.map((t) => (t.phraseId === phraseId ? { ...t, reviewed: false, dismissed: true } : t)) };
      await mine.update(conversations, { extraction: next as unknown as Record<string, unknown> }, eq(conversations.id, conv.id));
      return "done" as const;
    }),
  );
}
