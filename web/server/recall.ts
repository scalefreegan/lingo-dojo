import { and, desc, sql, type SQL } from "drizzle-orm";
import { effectiveProfile } from "../../scripts/assemble.mjs";
import { normalizePack, packUnits } from "../../scripts/content.mjs";
import type { LanguageProfile } from "../../scripts/db/accounts.ts";
import type { LanguageProfileRef } from "../../scripts/db/owned.ts";
import { recallBank, recallDetails, recallPhrases, type RecallPhrase } from "../../scripts/db/phrases.ts";
import { bankLocale } from "../../scripts/phrases.mjs";
import { lookupBlock, lookupRecord, retrieve, retrievalBlock, reviewFromIds, searchLookup, selectReview, storedReviewIds } from "../../scripts/recall.mjs";
import { localeFor } from "../../scripts/voice.mjs";
import type { ContentReply, Mode, PhraseSummary, RecallItem, RecallReview } from "../shared/wire.ts";
import { profileRows, rawDb, schema } from "./db.ts";

// Recall in sessions (docs/DATA.md §Recall in sessions): the server half.
// It reads; scripts/recall.mjs (pure) decides. Three uses:
//
//   - the review block: the assembled prompt's {{phrase_review}}. A saved
//     conversation's is chosen once, when it is created (sessionReview), and
//     its phrase ids stored in its pack_snapshot (`review.phraseIds`): every
//     turn, the Go tab's line and the recap read those phrases back by id,
//     so a star or a review during the session never changes what the
//     session was asked to revisit. POST /api/assemble and /api/export (the
//     preview, Copy, an export) choose as of now;
//   - per-turn retrieval: the bank phrases most like what was just said,
//     appended to the turn's prompt;
//   - LOOKUP: the dojo master's query against the bank and past sessions.
//
// Reads only, and no row locks: one read of the language's bank per turn
// (scripts/db/phrases.ts recallBank: phrases, their cards and lapses),
// ranked in memory, and a LOOKUP's read of past sessions (pastSessions).
// Both are scoped by forLanguageProfile, so another language's or
// learner's rows never come back. A failed read never fails the turn: the
// session goes on without recall, and the server logs why.

type Content = Pick<ContentReply, "schema" | "frame" | "profile" | "units" | "scenarios">;
type Pack = Parameters<typeof normalizePack>[0];
type Snapshot = Record<string, unknown> | null | undefined;

/** Whether the pack plays a unit of the `recall` slot (its own, or the
 *  default a pack saved before the slot existed gets: packUnits). No unit,
 *  no review block (and nothing to show as revisited, or to tell the
 *  recap). */
export function picksRecall(content: Content, pack: Pack): boolean {
  const ids = new Set(packUnits(content, normalizePack(pack).units));
  return content.units.some((u) => u.slot === "recall" && ids.has(u.id));
}

/** Whether a session of this pack is in the bank's language: a pack that
 *  moves the target language (a German scene from the Spanish profile)
 *  neither fills nor reads the Spanish bank, nor searches its past
 *  sessions (scripts/phrases.mjs bankLocale, as the turn's capture asks). */
export function inBank(language: Pick<LanguageProfile, "targetLanguage">, content: Content, pack: Pack): boolean {
  const eff = effectiveProfile(content.profile, normalizePack(pack).overrides);
  return bankLocale(language.targetLanguage, { targetLanguage: String(eff.target_language ?? ""), targetVariant: String(eff.target_variant ?? "") }) != null;
}

/** The bank's locale, for the page's readings (es-MX, zh-TW). */
export const bankLocaleOf = (language: Pick<LanguageProfile, "targetLanguage" | "targetVariant">) => localeFor(language.targetLanguage, language.targetVariant) ?? null;

/** The language's bank with its metrics, or null when the read fails
 *  (logged). */
export async function readBank(profile: LanguageProfileRef): Promise<PhraseSummary[] | null> {
  try {
    return await recallBank(rawDb(), profile);
  } catch (e) {
    console.error("[lingo-dojo] recall: reading the phrase bank failed; going on without it:", e);
    return null;
  }
}

/** The scene being played, for relevance: the pack's scenario, or its quick
 *  scenario's text. */
function sceneOf(content: Content, pack: Pack) {
  const p = normalizePack(pack);
  const quick = p.quick_scenario.trim();
  if (p.scenario) {
    const found = content.scenarios.find((s) => s.id === p.scenario);
    if (found) return found;
  }
  return quick ? { id: null, title: "", body: quick } : null;
}

/** The review block's phrases from a bank already read, as of `at`: none
 *  without a recall unit. The caller has checked the session is in the
 *  bank's language. */
export function chooseReview(bank: PhraseSummary[], content: Content, pack: Pack, mode: Mode, at: Date): RecallItem[] {
  if (!picksRecall(content, pack)) return [];
  return selectReview(bank, { scenario: sceneOf(content, pack), mode, now: at });
}

/** The review block for the assemble and export routes (as of now). */
export async function reviewFor(language: LanguageProfile, content: Content, pack: Pack, mode: Mode, at = new Date()): Promise<RecallReview> {
  const locale = bankLocaleOf(language);
  if (!picksRecall(content, pack) || !inBank(language, content, pack)) return { items: [], locale };
  return { items: chooseReview((await readBank(language)) ?? [], content, pack, mode, at), locale };
}

/** What a new conversation stores as its review (`pack_snapshot.review`):
 *  the phrase ids chosen now, [] when it has nothing to revisit (no recall
 *  unit, another language, an empty bank), or null when the bank couldn't
 *  be read (nothing stored: its first turn chooses instead). */
export async function sessionReview(language: LanguageProfile, content: Content, pack: Pack, mode: Mode): Promise<{ phraseIds: string[] } | null> {
  if (!picksRecall(content, pack) || !inBank(language, content, pack)) return { phraseIds: [] };
  const bank = await readBank(language);
  return bank ? { phraseIds: chooseReview(bank, content, pack, mode, new Date()).map((p) => p.id) } : null;
}

/** The bank's words for a turn's matching (recallPhrases), or null when
 *  the read fails (logged). */
async function readPhrases(profile: LanguageProfileRef): Promise<RecallPhrase[] | null> {
  try {
    return await recallPhrases(rawDb(), profile);
  } catch (e) {
    console.error("[lingo-dojo] recall: reading the phrase bank failed; going on without it:", e);
    return null;
  }
}

/** These phrases with their metrics, by id ([] when the read fails, logged). */
async function readDetails(profile: LanguageProfileRef, ids: string[]): Promise<Map<string, PhraseSummary>> {
  try {
    return new Map((await recallDetails(rawDb(), profile, [...new Set(ids)])).map((p) => [p.id, p]));
  } catch (e) {
    console.error("[lingo-dojo] recall: reading phrase details failed; going on without them:", e);
    return new Map();
  }
}

/** `rows` (by id) as `details` has them, in order; any not found dropped. */
const detailed = (rows: { id: string }[], details: Map<string, PhraseSummary>) => rows.map((r) => details.get(r.id)).filter((p): p is PhraseSummary => !!p);

/**
 * What one voice turn gets from the bank: the review block's phrases (a
 * saved conversation's stored ones, read back by id; for a conversation
 * started before reviews were stored, chosen as of its start and returned
 * as `store` for saveTurn to keep; for an unsaved session, as of now) and
 * the retrieval's block for the prompt.
 *
 * Two reads, both plain: the bank's words for matching (no cards, no FSRS:
 * the cost of a full read grows with the bank, and the turn's ranking runs
 * on the server's one thread), then the metrics of only the phrases the
 * turn shows (the review and the hits). Choosing a review afresh (an old or
 * unsaved conversation) reads the whole bank with its metrics instead.
 * `phrases` is kept for a LOOKUP in the same turn; `inBank` false means the
 * session is in another language, and no bank was read.
 */
export async function turnRecall(
  language: LanguageProfile,
  opts: {
    content: Content; pack: Pack; mode: Mode; now: Date; message: string; lastLine: string;
    conversation: { startedAt: Date; packSnapshot: Snapshot } | null;
  },
): Promise<{ phrases: RecallPhrase[]; inBank: boolean; review: RecallItem[]; store: { phraseIds: string[] } | null; retrieval: string; ms: number }> {
  const t0 = performance.now();
  const here = inBank(language, opts.content, opts.pack);
  const none = { phrases: [], inBank: here, review: [], store: null, retrieval: "" };
  if (!here) return { ...none, ms: performance.now() - t0 };
  const stored = opts.conversation ? storedReviewIds(opts.conversation.packSnapshot) : null;
  let phrases: RecallPhrase[];
  let review: RecallItem[];
  let store: { phraseIds: string[] } | null = null;
  let details: Map<string, PhraseSummary>;
  if (stored) {
    const read = await readPhrases(language);
    if (!read) return { ...none, ms: performance.now() - t0 };
    phrases = read;
    const hits = retrieve(phrases, { message: opts.message, lastLine: opts.lastLine, mode: opts.mode });
    details = await readDetails(language, [...stored, ...hits.map((p) => p.id)]);
    review = reviewFromIds([...details.values()], stored);
    return { phrases, inBank: here, review, store, retrieval: retrievalBlock(detailed(hits, details), opts.now), ms: performance.now() - t0 };
  }
  const bank = await readBank(language);
  if (!bank) return { ...none, ms: performance.now() - t0 };
  phrases = bank;
  review = chooseReview(bank, opts.content, opts.pack, opts.mode, opts.conversation ? new Date(opts.conversation.startedAt) : opts.now);
  if (opts.conversation) store = { phraseIds: review.map((p) => p.id) };
  const hits = retrieve(bank, { message: opts.message, lastLine: opts.lastLine, mode: opts.mode }) as PhraseSummary[];
  return { phrases, inBank: here, review, store, retrieval: retrievalBlock(hits, opts.now), ms: performance.now() - t0 };
}

/** The review a finished conversation offered, for its recap: the stored
 *  phrases as the bank has them now, or, for one started before reviews
 *  were stored, chosen from the bank as of its start. Null when its pack
 *  had no recall unit (nothing was offered). The caller has checked the
 *  session was in the bank's language. */
export async function offeredReview(
  profile: LanguageProfileRef,
  content: Content,
  conv: { mode: string; startedAt: Date; packSnapshot: Snapshot },
): Promise<RecallItem[] | null> {
  const pack = (conv.packSnapshot ?? {}) as Pack;
  if (!picksRecall(content, pack)) return null;
  const stored = storedReviewIds(conv.packSnapshot);
  if (stored) return reviewFromIds((await readBank(profile)) ?? [], stored);
  return chooseReview((await readBank(profile)) ?? [], content, pack, conv.mode === "kids" ? "kids" : "adult", new Date(conv.startedAt));
}

/** The language's past sessions a LOOKUP searches (docs/DATA.md §Recall):
 *  ended ones, newest first, the conversation asking left out; only the
 *  columns searched (no recap JSON, no pack). A plain read: no row lock. */
export async function pastSessions(
  profile: LanguageProfileRef,
  exceptId: string | null,
  limit = 200,
): Promise<{ id: string; title: string; startedAt: Date; summary: string | null }[]> {
  const c = schema.conversations;
  return rawDb()
    .select({ id: c.id, title: c.title, startedAt: c.startedAt, summary: c.summary })
    .from(c)
    .where(profileRows(profile).where(c, and(sql`${c.endedAt} is not null`, exceptId ? sql`${c.id} <> ${exceptId}` : undefined) as SQL))
    .orderBy(desc(c.startedAt))
    .limit(limit);
}

/** A LOOKUP: the query against the bank (already read this turn) and the
 *  language's past sessions; neither when the session is in another
 *  language (`inBank` false), which the results say. The block for the
 *  rerun, and what the turn row records. */
export async function runLookup(
  language: LanguageProfile,
  bank: RecallPhrase[],
  query: string,
  opts: { now: Date; conversationId: string | null; inBank: boolean },
): Promise<{ block: string; record: Record<string, unknown> }> {
  const t0 = performance.now();
  if (!opts.inBank) {
    const none = { phrases: [], conversations: [] };
    return { block: lookupBlock(query, none, opts.now, { elsewhere: true }), record: lookupRecord(query, none, { ms: performance.now() - t0, elsewhere: true }) };
  }
  let conversations: Awaited<ReturnType<typeof pastSessions>> = [];
  try {
    conversations = await pastSessions(language, opts.conversationId);
  } catch (e) {
    console.error("[lingo-dojo] recall: reading past sessions for a LOOKUP failed:", e);
  }
  const found = searchLookup({ phrases: bank, conversations }, query, opts.now);
  // The phrases found, with how well they're known (the block says).
  const results = { ...found, phrases: detailed(found.phrases, await readDetails(language, found.phrases.map((p) => p.id))) };
  return { block: lookupBlock(query, results, opts.now), record: lookupRecord(query, results, { ms: performance.now() - t0 }) };
}
