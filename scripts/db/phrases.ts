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
// met (es-MX), not part of the identity. The merge rule (absorbPending):
// when words turn up with a pending row's meaning (a gloss, a scenario's
// vocab, an add), the complete phrase for those words is made or found
// first, then the pending row is folded into it (its star, suspension,
// note, edit time and provenance carried over) and deleted.
//
// Locks. Bank writes lock only the bank's own rows (the phrase a write
// changes, upserts' conflict rows) and no learner, profile or session row
// beyond the KEY SHARE their foreign keys take, so the lock order of
// DATA.md §Language profiles (learner → language profiles → sessions) is
// never entered from here. Within the bank, one order: every complete row a
// write touches first, in norm order (an upsert inserts or locks it), then
// the pending rows, in meaning order (glossCaptures and scenarioEntries
// sort, absorbPending sorts). Two captures in one language at once (two
// tabs, two conversations) then wait for each other instead of
// deadlocking, and never try to give a pending row words another
// transaction is inserting. What is left (an edit giving a pending phrase
// words at the moment a capture adds them) is retried once (retrying) and
// otherwise reported: EEXIST from a route, a logged miss from a capture.
//
// Seeing is not reviewing: a gloss records a sighting (phrase_sightings,
// one row per phrase and reply; seen_count, first and last seen follow
// from those rows), adds an example and makes the recognize card if there
// is none, but writes no FSRS review.
//
// Provenance (`source`) only ever strengthens: manual > scenario > gloss
// (> extraction). A gloss phrase is one that exists only because replies
// glossed it; a scene's list or an add of the same words, or absorbing a
// pending scene phrase, lifts it. Undoing a dropped reply deletes only a
// gloss phrase. Reviews come from practice (a later phase) and the
// post-session extraction (scripts/db/extraction.ts, which reuses the
// exported helpers here); last_practiced_at is theirs to set.
//
// Erasable TypeScript only, like schema.ts: the tests import it as is.

import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
// Spelled from the repo root so they match the typed declarations in
// web/server/mjs-memory.d.ts (an ambient module is matched by pattern).
import { normKey } from "../../scripts/match.mjs";
import { MAX_EXAMPLES, TROUBLE_DAYS, clean, phraseMetrics, type Capture, type Example } from "../../scripts/phrases.mjs";
import type { PhraseDetail, PhraseInput, PhraseSummary } from "../../web/shared/wire.ts";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { cards, phraseDismissals, phraseExamples, phraseSightings, phrases, reviews } from "./schema.ts";

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
const sqlState = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code ?? err?.cause?.code;
};
const isUniqueViolation = (e: unknown) => sqlState(e) === "23505";

/** `run` (a whole transaction or savepoint), once more if two writers of
 *  one bank collided: a unique violation (both inserting one phrase's
 *  words) or a deadlock. The second run sees the first one's winner. */
export async function retrying<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (sqlState(e) !== "23505" && sqlState(e) !== "40P01") throw e;
    return run();
  }
}

export const COMPLETE = sql`${phrases.text} is not null`;
const PENDING = sql`${phrases.text} is null`;
/** The meaning an automatic write (a gloss, a scene's list) leaves on a
 *  phrase already there: its own, whoever set it; the incoming one only
 *  fills a blank (a phrase added by hand with no meaning, say). */
export const AUTO_MEANING = sql`coalesce(${phrases.meaning}, excluded.meaning)`;
/** Provenance, strongest first: what a phrase keeps when two sources meet
 *  (an upsert of words already here, an absorbed pending row). */
const STRENGTH = sql`array['manual', 'scenario', 'gloss', 'extraction']`;
export const stronger = (a: SQL | string, b: SQL | string) =>
  sql`(${STRENGTH})[least(array_position(${STRENGTH}, ${a}::text), array_position(${STRENGTH}, ${b}::text))]`;

/** The phrase's note with `other` (a row being folded into it) kept too:
 *  neither lost, the same one not twice. */
const withNote = (other: string | null) =>
  other == null
    ? sql`${phrases.note}`
    : sql`case when ${phrases.note} is null then ${other}::text when ${phrases.note} = ${other}::text then ${phrases.note} else ${phrases.note} || ${"\n\n" + other}::text end`;
/** The partial unique indexes the upserts target (the scope adds the profile). */
export const IDENTITY = { target: [phrases.norm], targetWhere: COMPLETE };
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
 * The merge rule, after the complete phrases are made or found: for each of
 * `found` (a complete row and the meaning its words came with), a pending
 * row with that meaning is folded into it and deleted. Nothing the learner
 * set on either is lost: starred or suspended if either was, both notes
 * (joined when they differ), the later edit time, the stronger provenance
 * (a scene's or the learner's phrase stays one), and the pending row's
 * meaning when the complete one has none or the learner edited the pending
 * one and not the complete one (it matched by meaning, so it is the same
 * meaning, in the learner's words). In meaning order, after every complete
 * row the write takes (the lock order above).
 */
export async function absorbPending(tx: Db, profile: LanguageProfileRef, found: { id: string; meaningNorm: string | null }[]): Promise<void> {
  const mine = forLanguageProfile(tx, profile);
  const todo = found.filter((f): f is { id: string; meaningNorm: string } => !!f.meaningNorm).sort((x, y) => (x.meaningNorm < y.meaningNorm ? -1 : x.meaningNorm > y.meaningNorm ? 1 : 0));
  for (const f of todo) {
    const [pending] = await tx
      .select()
      .from(phrases)
      .where(mine.where(phrases, and(PENDING, eq(phrases.meaningNorm, f.meaningNorm))))
      .for("update");
    if (!pending) continue;
    const pendingEdited = pending.editedAt != null;
    await mine.update(
      phrases,
      {
        starred: sql`${phrases.starred} or ${pending.starred}`,
        suspended: sql`${phrases.suspended} or ${pending.suspended}`,
        note: withNote(pending.note),
        meaning: pendingEdited
          ? sql`case when ${phrases.editedAt} is null then ${pending.meaning}::text else coalesce(${phrases.meaning}, ${pending.meaning}::text) end`
          : sql`coalesce(${phrases.meaning}, ${pending.meaning}::text)`,
        editedAt: sql`greatest(${phrases.editedAt}, ${pending.editedAt}::timestamptz)`,
        // A scene's pending phrase given words by a gloss stays a scene's
        // phrase: undoing that gloss mustn't take it out of the bank.
        source: stronger(sql`${phrases.source}`, pending.source),
      },
      eq(phrases.id, f.id),
    );
    await mine.remove(phrases, eq(phrases.id, pending.id));
  }
}

/** The keys of the phrases a learner deleted from this bank, which a scene's
 *  lists don't add back (`text`: norms, `meaning`: meaning norms). */
async function dismissed(tx: Db, profile: LanguageProfileRef): Promise<{ text: Set<string>; meaning: Set<string> }> {
  const rows = await forLanguageProfile(tx, profile).list(phraseDismissals);
  return {
    text: new Set(rows.filter((r) => r.kind === "text").map((r) => r.key)),
    meaning: new Set(rows.filter((r) => r.kind === "meaning").map((r) => r.key)),
  };
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
    return await retrying(() => tx.transaction(async (sp) => {
      const mine = forLanguageProfile(sp, profile);
      // The complete rows first, in norm order (items come sorted), then the
      // pending ones they absorb: the lock order.
      const rows: PhraseRow[] = [];
      for (const item of opts.items) {
        // seen_count and first/last seen are set from the sightings below.
        const [row] = await mine.upsert(
          phrases,
          { lang: opts.lang, text: item.text, norm: item.norm, meaning: item.meaning, source: "gloss" },
          // The first meaning stays, and the learner's always does.
          { ...IDENTITY, set: { meaning: AUTO_MEANING } },
        );
        rows.push(row);
      }
      await absorbPending(sp, profile, rows.map((r, i) => ({ id: r.id, meaningNorm: opts.items[i].meaningNorm })));
      for (const [i, item] of opts.items.entries()) {
        const row = rows[i];
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
      // What this turn did, row by row: undo (unrecordGlosses) reads only
      // these. A phrase is sighted once a reply, however often it glosses it.
      const ids = [...new Set(rows.map((r) => r.id))];
      await mine.insertOrIgnore(
        phraseSightings,
        ids.map((phraseId) => ({ phraseId, conversationId: opts.conversationId, turnId: opts.turnId })),
      );
      await recount(sp, profile, ids);
      return opts.items.length;
    }));
  } catch (e) {
    console.error(`[lingo-dojo] phrase bank: the glosses of turn ${opts.turnId} weren't recorded:`, e);
    return null;
  }
}

/** seen_count and first/last seen of `ids` from their sightings: the one
 *  place those three are written, so they always agree with the rows. */
export async function recount(tx: Db, profile: LanguageProfileRef, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const mine = forLanguageProfile(tx, profile);
  const s = phraseSightings;
  await mine.update(
    phrases,
    {
      seenCount: sql`(select count(*)::int from ${s} where ${s.phraseId} = ${phrases.id})`,
      firstSeenAt: sql`(select min(${s.seenAt}) from ${s} where ${s.phraseId} = ${phrases.id})`,
      lastSeenAt: sql`(select max(${s.seenAt}) from ${s} where ${s.phraseId} = ${phrases.id})`,
    },
    inArray(phrases.id, ids),
  );
}

/**
 * Undo what stored turns' captures did, when the turn write deletes them
 * (the browser dropped them: web/server/conversations.ts saveTurn), on the
 * turn's transaction, in a savepoint like recordGlosses. Exact by
 * construction: it acts only on the sighting rows those turns wrote
 * (phrase_sightings), never on what their text would gloss today, so a
 * turn whose capture failed, or a copy from the browser, changes nothing.
 * Those rows and the turns' examples go; each phrase they sighted is
 * counted again from the sightings left (seen_count, first and last seen).
 * A phrase left with no sighting at all goes too when it existed only
 * because of them: provenance gloss (no scene list, add or absorbed scene
 * phrase behind it), never edited by hand (`edited_at`), not starred,
 * suspended or noted, and no card reviewed. Any other stays, unseen,
 * without the unreviewed cards the sightings made.
 */
export async function unrecordGlosses(tx: Db, profile: LanguageProfileRef, opts: { turnIds: string[] }): Promise<void> {
  if (!opts.turnIds.length) return;
  try {
    await tx.transaction(async (sp) => {
      const mine = forLanguageProfile(sp, profile);
      const gone = await mine.remove(phraseSightings, inArray(phraseSightings.turnId, opts.turnIds));
      await mine.remove(phraseExamples, inArray(phraseExamples.turnId, opts.turnIds));
      const ids = [...new Set(gone.map((g) => g.phraseId))];
      if (!ids.length) return;
      // Locked in norm order, the bank's lock order (all are complete:
      // only complete phrases are sighted).
      const rows = await sp
        .select()
        .from(phrases)
        .where(mine.where(phrases, inArray(phrases.id, ids)))
        .orderBy(asc(phrases.norm))
        .for("update");
      await recount(sp, profile, ids);
      for (const row of rows) {
        const left = await mine.get(phraseSightings, eq(phraseSightings.phraseId, row.id));
        if (left) continue;
        const reviewed = await mine.get(cards, and(eq(cards.phraseId, row.id), sql`${cards.reps} > 0`) as SQL);
        const onlyGlossed = row.source === "gloss" && row.editedAt == null && !row.starred && !row.suspended && row.note == null && !reviewed;
        if (onlyGlossed) await mine.remove(phrases, eq(phrases.id, row.id));
        else await mine.remove(cards, and(eq(cards.phraseId, row.id), eq(cards.reps, 0)) as SQL);
      }
    });
  } catch (e) {
    // The turns still go; their sightings stay, now with no turn: counted,
    // never undone, the bank still in step with its rows.
    console.error(`[lingo-dojo] phrase bank: the sightings of dropped turns ${opts.turnIds.join(", ")} weren't undone:`, e);
  }
}

/**
 * A scenario's lists at conversation start (DATA.md §Phrase capture):
 * `vocab` as complete phrases ("scenario" when new; an existing one keeps
 * its meaning, or takes this one if it had none), `phrases` as pending ones,
 * unless a complete phrase already has that meaning. Nothing is seen and no
 * card is made: the session hasn't used them yet. What the learner deleted
 * from the bank (phrase_dismissals) isn't added back. One transaction.
 */
export async function addScenarioPhrases(
  db: Db,
  profile: LanguageProfileRef,
  opts: { lang: string; complete: Capture[]; pending: { meaning: string; meaningNorm: string }[] },
): Promise<void> {
  if (!opts.complete.length && !opts.pending.length) return;
  await retrying(() =>
    db.transaction(async (tx) => {
      const mine = forLanguageProfile(tx, profile);
      const gone = await dismissed(tx, profile);
      const found: { id: string; meaningNorm: string | null }[] = [];
      for (const item of opts.complete) {
        if (gone.text.has(item.norm)) continue;
        const [row] = await mine.upsert(
          phrases,
          { lang: opts.lang, text: item.text, norm: item.norm, meaning: item.meaning, source: "scenario" },
          { ...IDENTITY, set: { meaning: AUTO_MEANING, source: stronger(sql`${phrases.source}`, sql`excluded.source`) } },
        );
        found.push({ id: row.id, meaningNorm: item.meaningNorm });
      }
      await absorbPending(tx, profile, found);
      if (!opts.pending.length) return;
      const known = new Set((await mine.list(phrases, and(COMPLETE, isNotNull(phrases.meaning)) as SQL)).map((r) => normKey(r.meaning)));
      for (const p of opts.pending) {
        if (known.has(p.meaningNorm) || gone.meaning.has(p.meaningNorm)) continue;
        await mine.insertOrIgnore(phrases, { lang: opts.lang, meaning: p.meaning, meaningNorm: p.meaningNorm, source: "scenario" }, PENDING_IDENTITY);
      }
    }),
  );
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

/** The complete phrase with these words (by norm), or null. Control
 *  characters (a NUL too) are dropped first, as from every stored phrase. */
export async function findPhrase(db: Db, profile: LanguageProfileRef, text: string): Promise<PhraseSummary | null> {
  const norm = normKey(clean(text));
  if (!norm) return null;
  const row = await forLanguageProfile(db, profile).get(phrases, and(COMPLETE, eq(phrases.norm, norm)) as SQL);
  return row ? (await withMetrics(db, profile, [row]))[0] : null;
}

/* ---------------------------------- writes --------------------------------- */

/** Run `fn` in a transaction; a unique violation inside it (the words or
 *  the meaning another phrase has) becomes an EEXIST. */
async function inTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await retrying(() => db.transaction((tx) => fn(tx)));
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
    const [made] = await mine.upsert(
      phrases,
      { lang, text: input.text, norm, meaning, note: input.note ?? null, source: "manual", starred: input.starred ?? true, editedAt: new Date() },
      {
        ...IDENTITY,
        set: {
          // Starring or adding words already here is the learner's act too.
          editedAt: sql`now()`,
          source: stronger(sql`${phrases.source}`, sql`excluded.source`),
          starred: sql`${phrases.starred} or excluded.starred`,
          meaning: sql`coalesce(${phrases.meaning}, excluded.meaning)`,
          note: sql`coalesce(${phrases.note}, excluded.note)`,
        },
      },
    );
    await absorbPending(tx, profile, [{ id: made.id, meaningNorm: meaning ? normKey(meaning) || null : null }]);
    // Added by hand: a scene's list may bring it again.
    await mine.remove(phraseDismissals, and(eq(phraseDismissals.kind, "text"), eq(phraseDismissals.key, norm)) as SQL);
    const row = (await mine.get(phrases, eq(phrases.id, made.id)))!;
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
    // Any change by hand marks it: no automatic path deletes it or
    // overwrites what was set (DATA.md "Learner edits").
    set.editedAt = new Date();
    const [updated] = await forLanguageProfile(tx, profile).update(phrases, set, eq(phrases.id, pid));
    return detail(tx, profile, updated);
  });
}

/** Delete a phrase for good: its cards, reviews, examples and cloze items
 *  go with it (cascade), and its words and meaning are remembered as
 *  dismissed, so a scene's list doesn't add it back at the scene's next
 *  start (a session that glosses it again does: that is meeting it again).
 *  ENOENT for none of this language's. */
export async function deletePhrase(db: Db, profile: LanguageProfileRef, id: unknown): Promise<void> {
  const pid = phraseId(id);
  await db.transaction(async (tx) => {
    const mine = forLanguageProfile(tx, profile);
    const [gone] = await mine.remove(phrases, eq(phrases.id, pid));
    if (!gone) throw new PhraseError("ENOENT", "no such phrase");
    const keys: { kind: "text" | "meaning"; key: string }[] = [];
    if (gone.norm) keys.push({ kind: "text", key: gone.norm });
    const meaningKey = gone.meaningNorm ?? (gone.meaning ? normKey(gone.meaning) : "");
    if (meaningKey) keys.push({ kind: "meaning", key: meaningKey });
    if (keys.length) await mine.insertOrIgnore(phraseDismissals, keys);
  });
}
