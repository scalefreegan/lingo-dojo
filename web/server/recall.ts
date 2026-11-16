import { effectiveProfile } from "../../scripts/assemble.mjs";
import { normalizePack } from "../../scripts/content.mjs";
import type { LanguageProfile } from "../../scripts/db/accounts.ts";
import type { LanguageProfileRef } from "../../scripts/db/owned.ts";
import { listPhrases } from "../../scripts/db/phrases.ts";
import { bankLocale } from "../../scripts/phrases.mjs";
import { lookupBlock, lookupRecord, retrieve, retrievalBlock, searchLookup, selectReview } from "../../scripts/recall.mjs";
import { localeFor } from "../../scripts/voice.mjs";
import type { ContentReply, Mode, PhraseSummary, RecallItem, RecallReview } from "../shared/wire.ts";
import { pastSessions } from "./conversations.ts";
import { rawDb } from "./db.ts";

// Recall in sessions (docs/DATA.md §Recall in sessions): the server half.
// It reads; scripts/recall.mjs (pure) decides. Three uses:
//
//   - the review block: the assembled prompt's {{phrase_review}}, for the
//     voice turn (as of the conversation's start), POST /api/assemble (the
//     Go tab's preview, Copy) and POST /api/export (as of now);
//   - per-turn retrieval: the bank phrases most like what was just said,
//     appended to the turn's prompt;
//   - LOOKUP: the dojo master's query against the bank and past sessions.
//
// Reads only, and no row locks: one read of the language's bank per turn
// (scripts/db/phrases.ts listPhrases, the bank's own scoped query: phrases,
// their cards and lapses), ranked in memory, and a LOOKUP's read of past
// sessions (conversations.ts pastSessions). Both go through
// forLanguageProfile, so another language's or learner's rows never come
// back. A failed read never fails the turn: the session goes on without
// recall, and the server logs why.

type Content = Pick<ContentReply, "schema" | "frame" | "profile" | "units" | "scenarios">;
type Pack = Parameters<typeof normalizePack>[0];

/** Whether the pack picks a unit of the `recall` slot: no unit, no review
 *  block (and nothing to show as revisited, or to tell the recap). */
export function picksRecall(content: Content, pack: Pack): boolean {
  const ids = new Set(normalizePack(pack).units);
  return content.units.some((u) => u.slot === "recall" && ids.has(u.id));
}

/** Whether a session of this pack is in the bank's language: a pack that
 *  moves the target language (a German scene from the Spanish profile)
 *  neither fills nor reads the Spanish bank (scripts/phrases.mjs bankLocale,
 *  as the turn's capture asks). */
export function inBank(language: Pick<LanguageProfile, "targetLanguage">, content: Content, pack: Pack): boolean {
  const eff = effectiveProfile(content.profile, normalizePack(pack).overrides);
  return bankLocale(language.targetLanguage, { targetLanguage: String(eff.target_language ?? ""), targetVariant: String(eff.target_variant ?? "") }) != null;
}

/** The bank's locale, for the page's readings (es-MX, zh-TW). */
export const bankLocaleOf = (language: Pick<LanguageProfile, "targetLanguage" | "targetVariant">) => localeFor(language.targetLanguage, language.targetVariant) ?? null;

/** The language's bank with its metrics, or [] when the read fails (logged). */
export async function readBank(profile: LanguageProfileRef): Promise<PhraseSummary[]> {
  try {
    return await listPhrases(rawDb(), profile);
  } catch (e) {
    console.error("[lingo-dojo] recall: reading the phrase bank failed; going on without it:", e);
    return [];
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

/** The review block's phrases from a bank already read: none without a
 *  recall unit. `at` is the session's start (a turn's conversation's), so
 *  each turn of a session, and its recap, choose the same phrases. The
 *  caller has checked the session is in the bank's language. */
export function chooseReview(bank: PhraseSummary[], content: Content, pack: Pack, mode: Mode, at: Date): RecallItem[] {
  if (!picksRecall(content, pack)) return [];
  return selectReview(bank, { scenario: sceneOf(content, pack), mode, now: at });
}

/** The review block for the assemble and export routes (as of now). */
export async function reviewFor(language: LanguageProfile, content: Content, pack: Pack, mode: Mode, at = new Date()): Promise<RecallReview> {
  const locale = bankLocaleOf(language);
  if (!picksRecall(content, pack) || !inBank(language, content, pack)) return { items: [], locale };
  return { items: chooseReview(await readBank(language), content, pack, mode, at), locale };
}

/** What one voice turn gets from the bank: the review block's phrases and
 *  the retrieval's block for the prompt, from one read. `bank` is kept for
 *  a LOOKUP in the same turn. */
export async function turnRecall(
  language: LanguageProfile,
  opts: { content: Content; pack: Pack; mode: Mode; at: Date; now: Date; message: string; lastLine: string },
): Promise<{ bank: PhraseSummary[]; review: RecallItem[]; retrieval: string; ms: number }> {
  const t0 = performance.now();
  const bank = inBank(language, opts.content, opts.pack) ? await readBank(language) : [];
  const review = chooseReview(bank, opts.content, opts.pack, opts.mode, opts.at);
  const hits = retrieve(bank, { message: opts.message, lastLine: opts.lastLine, mode: opts.mode });
  const retrieval = retrievalBlock(hits, opts.now);
  return { bank, review, retrieval, ms: performance.now() - t0 };
}

/** A LOOKUP: the query against the bank (already read this turn) and the
 *  language's past sessions. The block for the rerun, and what the turn
 *  row records. */
export async function runLookup(
  language: LanguageProfile,
  bank: PhraseSummary[],
  query: string,
  opts: { now: Date; conversationId: string | null },
): Promise<{ block: string; record: Record<string, unknown> }> {
  const t0 = performance.now();
  let conversations: Awaited<ReturnType<typeof pastSessions>> = [];
  try {
    conversations = await pastSessions(language, opts.conversationId);
  } catch (e) {
    console.error("[lingo-dojo] recall: reading past sessions for a LOOKUP failed:", e);
  }
  const results = searchLookup({ phrases: bank, conversations }, query, opts.now);
  return { block: lookupBlock(query, results, opts.now), record: lookupRecord(query, results, { ms: performance.now() - t0 }) };
}
