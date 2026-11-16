// Cloze items in the database (docs/DATA.md §Practice modes, "As built
// (phase 7c: cloze)"): which sentences a language's phrases have for the
// fill-in-the-blank drill, made from the learner's own session lines when
// one will do, the rows a generation call leaves, and a learner's flag.
// What makes a sentence usable is scripts/cloze.mjs (pure); the model call
// is web/server/cloze.ts.
//
// Owner scoping lives here, as in practice.ts: every query goes through
// forLanguageProfile. Nothing here locks a phrase or a card: an item is
// inserted (its foreign keys take a key-share lock on the phrase and the
// example for that one statement) or flagged, never inside an answer's
// transaction, and the generation call runs with no transaction at all.
//
// Erasable TypeScript only, like practice.ts: the tests import it as is.

import { and, eq, gt, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { checkExample, clozeKey, clozeable, clozeWritable, triedStill } from "../../scripts/cloze.mjs";
import { forLanguageProfile, type Db, type LanguageProfileRef } from "./owned.ts";
import { clozeItems, phraseExamples, phrases as phrases_, turns } from "./schema.ts";

type ClozeRow = typeof clozeItems.$inferSelect;

/** A sentence a card can show: what pickCloze and clozeView take. */
export interface ClozeChoice {
  id: string;
  sentence: string;
  blankStart: number;
  blankEnd: number;
  origin: "example" | "generated";
}

/** The phrase as a cloze item is made for it. */
export interface ClozePhrase {
  id: string;
  text: string | null;
  meaning: string | null;
}

/** Per phrase: its usable sentences, and whether one is worth a model call
 *  (none usable, a phrase that can be a gap, and no call made yet for its
 *  words and meaning as they are). */
export interface ClozeState {
  items: ClozeChoice[];
  needed: boolean;
}

const usable = (r: ClozeRow): r is ClozeRow & { sentence: string; blankStart: number; blankEnd: number } =>
  r.sentence != null && r.blankStart != null && r.blankEnd != null && r.flaggedAt == null;
const choice = (r: ClozeRow & { sentence: string; blankStart: number; blankEnd: number }): ClozeChoice => ({
  id: r.id, sentence: r.sentence, blankStart: r.blankStart, blankEnd: r.blankEnd, origin: r.origin,
});

/**
 * The cloze state of `phrases` (one language's, as the queue reads them),
 * brought up to date first:
 *  - items made for an earlier version of a phrase's words or meaning go
 *    (clozeKey; a new alternate isn't a new version);
 *  - a phrase with no usable item from its own session lines has its
 *    examples tried (cloze.mjs checkExample: the dojo master's line, one
 *    stretch of target words, the phrase there once, verbatim), and each
 *    usable one becomes an item (once: cloze_items_example_once).
 * No model is called here: `needed` says which phrases a call should
 * write for. A failed write is logged and skipped: the queue goes on with
 * what there is.
 */
export async function clozeStates(
  db: Db,
  profile: LanguageProfileRef,
  phrases: ClozePhrase[],
  opts: { locale: string; level: string; now?: Date },
): Promise<Map<string, ClozeState>> {
  const mine = forLanguageProfile(db, profile);
  const key = new Map(phrases.map((p) => [p.id, clozeKey(p)]));
  let rows = await mine.list(clozeItems);
  // Items of another key go, but only while the phrase still has the words
  // and meaning this request read: a request holding a copy from before an
  // edit must not delete the new key's rows (a flag with them).
  const stalePhrases = phrases.filter((p) => rows.some((r) => r.phraseId === p.id && r.phraseKey !== key.get(p.id)));
  if (stalePhrases.length) {
    const gone = new Set<string>();
    for (const p of stalePhrases) {
      const removed = await mine.remove(
        clozeItems,
        and(
          eq(clozeItems.phraseId, p.id),
          ne(clozeItems.phraseKey, key.get(p.id)!),
          sql`exists (select 1 from ${phrases_} p where p.id = ${p.id} and p.text is not distinct from ${p.text} and p.meaning is not distinct from ${p.meaning})`,
        ) as SQL,
      );
      for (const r of removed) gone.add(r.id);
    }
    rows = rows.filter((r) => !gone.has(r.id));
  }
  // Examples, for phrases with no usable item of their own lines yet.
  const ownItem = new Set(rows.filter((r) => r.origin === "example" && usable(r)).map((r) => r.phraseId));
  const tried = new Set(rows.filter((r) => r.exampleId).map((r) => r.exampleId as string));
  const scan = phrases.filter((p): p is ClozePhrase & { text: string } => !ownItem.has(p.id) && !!p.text && clozeable(p.text, opts.locale));
  if (scan.length) {
    const examples = (await mine.list(phraseExamples, inArray(phraseExamples.phraseId, scan.map((p) => p.id)))).filter((e) => !tried.has(e.id));
    const turnIds = [...new Set(examples.map((e) => e.turnId).filter((id): id is string => !!id))];
    const turnRows = turnIds.length ? await mine.list(turns, inArray(turns.id, turnIds)) : [];
    const turnOf = new Map(turnRows.map((t) => [t.id, t]));
    const byId = new Map(scan.map((p) => [p.id, p]));
    let made = false;
    for (const e of examples) {
      const p = byId.get(e.phraseId)!;
      const t = e.turnId ? turnOf.get(e.turnId) : undefined;
      const c = checkExample(e, t ? { role: t.role, fromClient: t.fromClient, lines: t.lines } : null, { text: p.text, locale: opts.locale, level: opts.level });
      if (c.reason !== undefined) continue;
      try {
        await mine.insertOrIgnore(clozeItems, {
          phraseId: p.id, phraseKey: key.get(p.id)!, origin: "example", exampleId: e.id, sentence: c.sentence, blankStart: c.start, blankEnd: c.end,
        });
        made = true;
      } catch (err) {
        // The example went meanwhile (its turn dropped): nothing to make.
        console.warn(`[lingo-dojo] cloze: an example of phrase ${p.id} couldn't be kept:`, String((err as Error)?.message || err));
      }
    }
    if (made) rows = await mine.list(clozeItems);
  }
  const out = new Map<string, ClozeState>();
  const now = opts.now ?? new Date();
  const writable = clozeWritable(opts.locale);
  for (const p of phrases) {
    const k = key.get(p.id);
    const mineNow = rows.filter((r) => r.phraseId === p.id && r.phraseKey === k);
    const items = mineNow.filter(usable).map(choice);
    // A call was made for these words and meaning: it left sentences (kept
    // or flagged), or a "nothing usable" mark that still holds (cloze.mjs
    // triedStill: 30 days, and made under the current rules).
    const called = mineNow.some((r) => r.origin === "generated" && (r.sentence != null || triedStill(r.createdAt, now)));
    out.set(p.id, { items, needed: writable && !items.length && !called && !!p.text && clozeable(p.text, opts.locale) });
  }
  return out;
}

/** What one generation call gave a phrase: its checked sentences (empty:
 *  nothing usable). */
export interface Generated {
  phraseId: string;
  /** clozeKey of the phrase as it was sent to the model. */
  phraseKey: string;
  sentences: { sentence: string; start: number; end: number }[];
}

/**
 * Keep what a generation call gave: each usable sentence as an item, or,
 * for a phrase it gave none, a row with no sentence that marks its words
 * and meaning as tried (so the phrase doesn't pay again until they
 * change). One insert per phrase, outside any transaction: a phrase
 * deleted while the model wrote is skipped (its foreign key fails), and
 * one edited meanwhile keeps rows of its old key, which the next fill
 * clears. Returns how many sentences were kept.
 */
export async function storeGenerated(db: Db, profile: LanguageProfileRef, callId: string, results: Generated[]): Promise<number> {
  const mine = forLanguageProfile(db, profile);
  let kept = 0;
  for (const g of results) {
    try {
      if (!g.sentences.length) {
        // One mark per phrase and key: a later try (the old one expired)
        // refreshes it, so it holds from now and counts for this call.
        await mine.upsert(
          clozeItems,
          { phraseId: g.phraseId, phraseKey: g.phraseKey, origin: "generated", callId, sentence: null, blankStart: null, blankEnd: null },
          { target: [clozeItems.phraseId, clozeItems.phraseKey], targetWhere: sql`${clozeItems.sentence} is null`, set: { callId, createdAt: sql`now()` } },
        );
        continue;
      }
      const rows = await mine.insertOrIgnore(
        clozeItems,
        g.sentences.map((s) => ({ phraseId: g.phraseId, phraseKey: g.phraseKey, origin: "generated" as const, callId, sentence: s.sentence, blankStart: s.start, blankEnd: s.end })),
      );
      kept += Array.isArray(rows) ? rows.length : 0;
    } catch (err) {
      console.warn(`[lingo-dojo] cloze: the sentences for phrase ${g.phraseId} weren't kept:`, String((err as Error)?.message || err));
    }
  }
  return kept;
}

/** How many generation calls this language made since `since`, counted
 *  from the rows they left (each call's sentences and marks share its
 *  call_id): the daily cap survives a restart. */
export async function clozeCallsSince(db: Db, profile: LanguageProfileRef, since: Date): Promise<number> {
  const mine = forLanguageProfile(db, profile);
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${clozeItems.callId})::int` })
    .from(clozeItems)
    .where(mine.where(clozeItems, and(isNotNull(clozeItems.callId), gt(clozeItems.createdAt, since)) as SQL));
  return Number(row?.n) || 0;
}

/** One of this language's cloze items by id, or undefined. */
export async function clozeItem(db: Db, profile: LanguageProfileRef, id: string): Promise<ClozeRow | undefined> {
  return forLanguageProfile(db, profile).get(clozeItems, eq(clozeItems.id, id));
}

/**
 * The learner flags a sentence as bad: it is never shown again (a second
 * flag changes nothing). Only a sentence (not a tried mark); undefined for
 * none of this language's.
 */
export async function flagClozeItem(db: Db, profile: LanguageProfileRef, id: string, now: Date): Promise<ClozeRow | undefined> {
  const [row] = await forLanguageProfile(db, profile).update(
    clozeItems,
    { flaggedAt: sql`coalesce(${clozeItems.flaggedAt}, ${now.toISOString()}::timestamptz)` },
    and(eq(clozeItems.id, id), isNotNull(clozeItems.sentence)) as SQL,
  );
  return row;
}
