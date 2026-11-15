// The phrase bank in the database (docs/DATA.md §Phrase bank, §Phrase
// capture, §Metrics): one language profile's phrases, their examples and
// cards. The one data layer for them, shared by the turn write
// (web/server/conversations.ts saveTurn), the conversation start (scenario
// lists), the bank routes (web/server/phrases.ts) and the tests. The pure
// half (what a gloss or a scenario puts in, the metrics, the list's filters)
// is scripts/phrases.mjs.
//
// Owner scoping lives here and only here: every query goes through
// forLanguageProfile(tx, profile) (scripts/db/owned.ts), on the transaction
// it runs in, which filters on both the profile and its learner. The bank
// moved from the learner to the language profile in migration 0003, so a
// learner's Spanish bank and German bank are separate, like their packs and
// History.
//
// Identity: a complete phrase is one row per (profile, norm), norm being
// match.mjs normKey of its words; a pending one (a scenario meaning with no
// words yet) one per (profile, meaning_norm). `lang` is where it was first
// met (es-MX), not part of the identity. The merge rule (pairPending): when
// words turn up for a pending row's meaning (a gloss, a scenario's vocab, an
// add), the pending row is filled in if no complete phrase has those words,
// else deleted and the complete one kept (starred if the pending one was).
//
// Locks. Bank writes lock only the bank's own rows (the phrase a write
// changes, upserts' conflict rows) and no learner, profile or session row
// beyond the KEY SHARE their foreign keys take, so the lock order of
// DATA.md §Language profiles (learner → language profiles → sessions) is
// never entered from here. A write that touches several phrases takes them
// in key order (glossCaptures and scenarioEntries sort), so two of them
// can't deadlock on each other's rows.
//
// Seeing is not reviewing: a gloss bumps last_seen_at and seen_count, adds an
// example and makes the recognize card if there is none, but writes no FSRS
// review. Reviews come from practice and the post-session extraction (later
// phases); last_practiced_at is theirs to set.
//
// Erasable TypeScript only, like schema.ts: the tests import it as is.

import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
// Spelled from the repo root so they match the typed declarations in
// web/server/mjs-memory.d.ts (an ambient module is matched by pattern).
import { normKey } from "../../scripts/match.mjs";
import { MAX_EXAMPLES, TROUBLE_DAYS, phraseMetrics, type Capture, type Example } from "../../scripts/phrases.mjs";
import type { PhraseDetail, PhraseInput, PhraseSummary } from "../../web/shared/wire.ts";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { cards, phraseExamples, phrases, reviews } from "./schema.ts";

type PhraseRow = typeof phrases.$inferSelect;
type CardRow = typeof cards.$inferSelect;

export class PhraseError extends Error {
  code: "EINVAL" | "ENOENT" | "EEXIST";
  constructor(code: PhraseError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** node-postgres puts the SQLSTATE on the error, Drizzle on its cause. */
const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return (err?.code ?? err?.cause?.code) === "23505";
};

const COMPLETE = sql`${phrases.text} is not null`;
const PENDING = sql`${phrases.text} is null`;
/** The partial unique indexes the upserts target (the scope adds the profile). */
const IDENTITY = { target: [phrases.norm], targetWhere: COMPLETE };
const PENDING_IDENTITY = { target: [phrases.meaningNorm], targetWhere: PENDING };

/** A phrase id from a request, or ENOENT (a malformed id is no phrase of
 *  anyone's, and never reaches Postgres). */
function phraseId(id: unknown): string {
  if (typeof id !== "string" || !UUID_RE.test(id)) throw new PhraseError("ENOENT", "no such phrase");
  return id.toLowerCase();
}

/** The phrase, locked for the rest of the transaction. */
async function lockPhrase(tx: Db, profile: LanguageProfileRef, id: string): Promise<PhraseRow | undefined> {
  const [row] = await tx.select().from(phrases).where(forLanguageProfile(tx, profile).where(phrases, eq(phrases.id, id))).for("update");
  return row;
}

/**
 * The merge rule, for words `item` that arrive with a meaning: a pending
 * row with that meaning is filled in with the words, unless a complete
 * phrase already has them, in which case the pending row goes (and the
 * complete one is what the caller's upsert then finds). Returns whether the
 * deleted pending row was starred, for the caller to carry over.
 */
async function pairPending(tx: Db, profile: LanguageProfileRef, item: Capture): Promise<boolean> {
  if (!item.meaningNorm) return false;
  const mine = forLanguageProfile(tx, profile);
  const [pending] = await tx
    .select()
    .from(phrases)
    .where(mine.where(phrases, and(PENDING, eq(phrases.meaningNorm, item.meaningNorm))))
    .for("update");
  if (!pending) return false;
  if (!(await mine.get(phrases, and(COMPLETE, eq(phrases.norm, item.norm)) as SQL))) {
    await mine.update(phrases, { text: item.text, norm: item.norm, meaningNorm: null }, eq(phrases.id, pending.id));
    return false;
  }
  await mine.remove(phrases, eq(phrases.id, pending.id));
  return pending.starred;
}

/* --------------------------------- capture --------------------------------- */

/**
 * A dojo-master reply's glosses, seen (DATA.md §Phrase capture): each one
 * upserted ("gloss" when new), its sighting counted and timed, an example
 * from the reply's line kept (at most MAX_EXAMPLES a phrase, no repeats),
 * and its recognize card made if it has none. Not an FSRS review. Runs on
 * the turn's transaction `tx`, in a savepoint of its own: a capture that
 * fails is logged and rolled back alone, and the turn is still saved (the
 * bank is a by-product of the transcript, never the reason to lose it).
 * Returns how many phrases it wrote, or null when it failed.
 */
export async function recordGlosses(
  tx: Db,
  profile: LanguageProfileRef,
  opts: { lang: string; conversationId: string; turnId: string; items: (Capture & { example: Example | null })[] },
): Promise<number | null> {
  if (!opts.items.length) return 0;
  try {
    return await tx.transaction(async (sp) => {
      const mine = forLanguageProfile(sp, profile);
      for (const item of opts.items) {
        const carried = await pairPending(sp, profile, item);
        const now = new Date();
        const [row] = await mine.upsert(
          phrases,
          { lang: opts.lang, text: item.text, norm: item.norm, meaning: item.meaning, source: "gloss", starred: carried, firstSeenAt: now, lastSeenAt: now, seenCount: 1 },
          {
            ...IDENTITY,
            set: {
              seenCount: sql`${phrases.seenCount} + 1`,
              lastSeenAt: sql`now()`,
              firstSeenAt: sql`coalesce(${phrases.firstSeenAt}, now())`,
              // The first meaning stays: the learner may have edited it.
              meaning: sql`coalesce(${phrases.meaning}, excluded.meaning)`,
              starred: sql`${phrases.starred} or excluded.starred`,
            },
          },
        );
        if (item.example) {
          const have = await mine.list(phraseExamples, eq(phraseExamples.phraseId, row.id), { limit: MAX_EXAMPLES });
          if (have.length < MAX_EXAMPLES && !have.some((e) => e.sentence === item.example!.sentence)) {
            await mine.insert(phraseExamples, {
              phraseId: row.id, conversationId: opts.conversationId, turnId: opts.turnId, sentence: item.example.sentence, speaker: item.example.speaker,
            });
          }
        }
        // Seen once, it can be recognised: the first card (DATA.md "Three
        // cards per phrase"; listen and produce come with practice).
        await mine.insertOrIgnore(cards, { phraseId: row.id, skill: "recognize" });
      }
      return opts.items.length;
    });
  } catch (e) {
    console.error(`[lingo-dojo] phrase bank: the glosses of turn ${opts.turnId} weren't recorded:`, e);
    return null;
  }
}

/**
 * A scenario's lists at conversation start (DATA.md §Phrase capture):
 * `vocab` as complete phrases ("scenario" when new; an existing one keeps
 * its meaning, or takes this one if it had none), `phrases` as pending ones,
 * unless a complete phrase already has that meaning. Nothing is seen and no
 * card is made: the session hasn't used them yet. One transaction.
 */
export async function addScenarioPhrases(
  db: Db,
  profile: LanguageProfileRef,
  opts: { lang: string; complete: Capture[]; pending: { meaning: string; meaningNorm: string }[] },
): Promise<void> {
  if (!opts.complete.length && !opts.pending.length) return;
  await db.transaction(async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    for (const item of opts.complete) {
      const carried = await pairPending(tx, profile, item);
      await mine.upsert(
        phrases,
        { lang: opts.lang, text: item.text, norm: item.norm, meaning: item.meaning, source: "scenario", starred: carried },
        { ...IDENTITY, set: { meaning: sql`coalesce(${phrases.meaning}, excluded.meaning)`, starred: sql`${phrases.starred} or excluded.starred` } },
      );
    }
    if (!opts.pending.length) return;
    const known = new Set((await mine.list(phrases, and(COMPLETE, isNotNull(phrases.meaning)) as SQL)).map((r) => normKey(r.meaning)));
    for (const p of opts.pending) {
      if (known.has(p.meaningNorm)) continue;
      await mine.insertOrIgnore(phrases, { lang: opts.lang, meaning: p.meaning, meaningNorm: p.meaningNorm, source: "scenario" }, PENDING_IDENTITY);
    }
  });
}

/* ---------------------------------- reads ---------------------------------- */

const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

/** Lapses per phrase in the last TROUBLE_DAYS: an Again on a card that was
 *  in review (FSRS state 2) when it was graded, the definition of a lapse. */
async function lapsesByPhrase(db: Db, profile: LanguageProfileRef, ids?: string[]): Promise<Map<string, number>> {
  const mine = forLanguageProfile(db, profile);
  const rows = await db
    .select({ phraseId: cards.phraseId, n: sql<number>`count(*)::int` })
    .from(reviews)
    .innerJoin(cards, eq(cards.id, reviews.cardId))
    .where(
      mine.where(
        reviews,
        and(
          eq(reviews.rating, 1),
          sql`${reviews.cardBefore}->>'state' = '2'`,
          sql`${reviews.reviewedAt} > now() - ${sql.raw(`interval '${TROUBLE_DAYS} days'`)}`,
          ids ? inArray(cards.phraseId, ids) : undefined,
        ) as SQL,
      ),
    )
    .groupBy(cards.phraseId);
  return new Map(rows.map((r) => [r.phraseId, Number(r.n)]));
}

async function examplesByPhrase(db: Db, profile: LanguageProfileRef, ids?: string[]): Promise<Map<string, number>> {
  const rows = await db
    .select({ phraseId: phraseExamples.phraseId, n: sql<number>`count(*)::int` })
    .from(phraseExamples)
    .where(forLanguageProfile(db, profile).where(phraseExamples, ids ? inArray(phraseExamples.phraseId, ids) : undefined))
    .groupBy(phraseExamples.phraseId);
  return new Map(rows.map((r) => [r.phraseId, Number(r.n)]));
}

function summary(row: PhraseRow, cardRows: CardRow[], lapses: number, examples: number): PhraseSummary {
  return {
    id: row.id,
    text: row.text,
    meaning: row.meaning,
    note: row.note,
    lang: row.lang,
    source: row.source,
    pending: row.text == null,
    starred: row.starred,
    suspended: row.suspended,
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
    seenCount: row.seenCount,
    lastPracticedAt: iso(row.lastPracticedAt),
    createdAt: iso(row.createdAt)!,
    ...phraseMetrics(cardRows, lapses),
    exampleCount: examples,
  };
}

/** `rows` with their metrics: cards, lapses and example counts read for
 *  just those phrases (all of the bank's when `all`). */
async function withMetrics(db: Db, profile: LanguageProfileRef, rows: PhraseRow[], all = false): Promise<PhraseSummary[]> {
  if (!rows.length) return [];
  const ids = all ? undefined : rows.map((r) => r.id);
  const mine = forLanguageProfile(db, profile);
  const cardRows = await mine.list(cards, ids ? inArray(cards.phraseId, ids) : undefined);
  const byPhrase = new Map<string, CardRow[]>();
  for (const c of cardRows) byPhrase.set(c.phraseId, [...(byPhrase.get(c.phraseId) ?? []), c]);
  const lapses = await lapsesByPhrase(db, profile, ids);
  const examples = await examplesByPhrase(db, profile, ids);
  return rows.map((r) => summary(r, byPhrase.get(r.id) ?? [], lapses.get(r.id) ?? 0, examples.get(r.id) ?? 0));
}

/** The whole bank with its metrics. A bank is one learner's language, a
 *  few hundred to a few thousand rows: read whole, it is filtered, sorted
 *  and paged in memory (scripts/phrases.mjs bankPage), which keeps the
 *  mastery band fsrs.mjs's alone rather than a copy of it in SQL. */
export async function listPhrases(db: Db, profile: LanguageProfileRef): Promise<PhraseSummary[]> {
  const rows = await forLanguageProfile(db, profile).list(phrases);
  return withMetrics(db, profile, rows, true);
}

async function detail(db: Db, profile: LanguageProfileRef, row: PhraseRow): Promise<PhraseDetail> {
  const [head] = await withMetrics(db, profile, [row]);
  const examples = await forLanguageProfile(db, profile).list(phraseExamples, eq(phraseExamples.phraseId, row.id), {
    orderBy: [desc(phraseExamples.createdAt), asc(phraseExamples.id)],
    limit: MAX_EXAMPLES,
  });
  return {
    ...head,
    alternates: row.alternates,
    examples: examples.map((e) => ({ id: e.id, sentence: e.sentence, speaker: e.speaker, conversationId: e.conversationId, createdAt: iso(e.createdAt)! })),
  };
}

/** One phrase with its examples, or ENOENT (another language's or
 *  learner's phrase too). */
export async function getPhrase(db: Db, profile: LanguageProfileRef, id: unknown): Promise<PhraseDetail> {
  const row = await forLanguageProfile(db, profile).get(phrases, eq(phrases.id, phraseId(id)));
  if (!row) throw new PhraseError("ENOENT", "no such phrase");
  return detail(db, profile, row);
}

/** The complete phrase with these words (by norm), or null. */
export async function findPhrase(db: Db, profile: LanguageProfileRef, text: string): Promise<PhraseSummary | null> {
  const norm = normKey(text);
  if (!norm) return null;
  const row = await forLanguageProfile(db, profile).get(phrases, and(COMPLETE, eq(phrases.norm, norm)) as SQL);
  return row ? (await withMetrics(db, profile, [row]))[0] : null;
}

/* ---------------------------------- writes --------------------------------- */

/** Run `fn` in a transaction; a unique violation inside it (the words or
 *  the meaning another phrase has) becomes an EEXIST. */
async function inTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await db.transaction((tx) => fn(tx));
  } catch (e) {
    if (isUniqueViolation(e)) throw new PhraseError("EEXIST", "another phrase in this bank already has those words (or that meaning, for one with no words yet)");
    throw e;
  }
}

/**
 * Add or star (DATA.md: "Manual: tapping a glossed word → ☆ Star; Add in
 * the bank"): words already in the bank are starred (unless `starred` is
 * false) and keep their own meaning and note when they have them; new ones
 * are a "manual" phrase. No card and no sighting: adding isn't seeing.
 */
export async function addPhrase(
  db: Db,
  profile: LanguageProfileRef,
  lang: string,
  input: { text: string; meaning?: string | null; note?: string | null; starred?: boolean },
): Promise<{ phrase: PhraseDetail; created: boolean }> {
  const norm = normKey(input.text);
  if (!norm) throw new PhraseError("EINVAL", "text needs at least one letter or digit");
  const meaning = input.meaning ?? null;
  return inTx(db, async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    const existed = !!(await mine.get(phrases, and(COMPLETE, eq(phrases.norm, norm)) as SQL));
    const carried = await pairPending(tx, profile, { text: input.text, norm, meaning, meaningNorm: meaning ? normKey(meaning) || null : null });
    const [row] = await mine.upsert(
      phrases,
      { lang, text: input.text, norm, meaning, note: input.note ?? null, source: "manual", starred: (input.starred ?? true) || carried },
      {
        ...IDENTITY,
        set: {
          starred: sql`${phrases.starred} or excluded.starred`,
          meaning: sql`coalesce(${phrases.meaning}, excluded.meaning)`,
          note: sql`coalesce(${phrases.note}, excluded.note)`,
        },
      },
    );
    return { phrase: await detail(tx, profile, row), created: !existed };
  });
}

/**
 * Edit a phrase: its words (a pending phrase given words becomes complete),
 * meaning (a pending phrase's identity, so it can't be cleared), note,
 * starred, suspended. ENOENT for none of this language's; EEXIST when the new
 * words (or a pending phrase's new meaning) are another phrase's.
 */
export async function updatePhrase(db: Db, profile: LanguageProfileRef, id: unknown, input: PhraseInput): Promise<PhraseDetail> {
  const pid = phraseId(id);
  return inTx(db, async (tx) => {
    const row = await lockPhrase(tx, profile, pid);
    if (!row) throw new PhraseError("ENOENT", "no such phrase");
    const set: Partial<typeof phrases.$inferInsert> = {};
    if (input.text !== undefined) {
      const norm = normKey(input.text);
      if (!norm) throw new PhraseError("EINVAL", "text needs at least one letter or digit");
      set.text = input.text;
      set.norm = norm;
      set.meaningNorm = null;
    }
    if (input.meaning !== undefined) {
      set.meaning = input.meaning;
      if (row.text == null && set.text === undefined) {
        const meaningNorm = input.meaning ? normKey(input.meaning) : "";
        if (!meaningNorm) throw new PhraseError("EINVAL", "a phrase with no words yet is its meaning: give it words, or a meaning");
        set.meaningNorm = meaningNorm;
      }
    }
    if (input.note !== undefined) set.note = input.note;
    if (input.starred !== undefined) set.starred = input.starred;
    if (input.suspended !== undefined) set.suspended = input.suspended;
    const [updated] = await forLanguageProfile(tx, profile).update(phrases, set, eq(phrases.id, pid));
    return detail(tx, profile, updated);
  });
}

/** Delete a phrase for good: its cards, reviews, examples and cloze items
 *  go with it (cascade). ENOENT for none of this language's. */
export async function deletePhrase(db: Db, profile: LanguageProfileRef, id: unknown): Promise<void> {
  const gone = await forLanguageProfile(db, profile).remove(phrases, eq(phrases.id, phraseId(id)));
  if (!gone.length) throw new PhraseError("ENOENT", "no such phrase");
}
