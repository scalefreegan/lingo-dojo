import type { ServerResponse } from "node:http";
import { compareTones, readTrendDays, sessionTones, toneTrend, trendWindow, TREND_MIN_SYLLABLES } from "../../scripts/pronunciation-review.mjs";
import { readUtcOffset } from "../../scripts/practice.mjs";
import { sessionChecks, toneConversation, trendChecks } from "../../scripts/db/pronunciation.ts";
import { listCorrections } from "../../scripts/db/readings.ts";
import { activeList } from "../../scripts/db/sharedReadings.ts";
import type { FlagNote } from "../../scripts/pronunciation-live.mjs";
import type { SessionTonesReply, ToneTrendReply } from "../shared/wire.ts";
import type { LearnerCtx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { HttpError, sendJson } from "./sse.ts";

// Pronunciation stage 3 (ld-ne0.4; docs/VOICE.md §Tones after the session):
// the stored tone checks read back to the adult learner, and the hand-off
// that lets a Practice speak-it answer use its own tone check.
//
//   GET /api/pronunciation/sessions/:conversationId   → SessionTonesReply
//   GET /api/pronunciation/trend?days=&tz=            → ToneTrendReply
//
// Both mounted by pronunciation.ts (wrap's `learner: true`), both reads
// only, through this language's scope (scripts/db/pronunciation.ts), with
// no model call. A kids learner gets nothing (no rows are kept for one
// anyway: the rule is said here as well, so a change there can't show a
// child a score).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A session's Tones section: its checks' counts, the flagged syllables
 *  with their lines, and the last attempt of the scene compared. A
 *  conversation that isn't this language's is a 404, like every other. */
export async function sessionTonesRoute(res: ServerResponse, ctx: LearnerCtx, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw new HttpError(404, "no such conversation", "no_conversation");
  const conv = await toneConversation(rawDb(), ctx.language, id.toLowerCase());
  if (!conv) throw new HttpError(404, "no such conversation", "no_conversation");
  if (ctx.learner.mode === "kids" || conv.mode === "kids") return sendJson(res, 200, { tones: null } satisfies SessionTonesReply);
  const now = sessionTones(await sessionChecks(rawDb(), ctx.language, conv.id));
  if (!now) return sendJson(res, 200, { tones: null } satisfies SessionTonesReply);
  // The attempt this session built on (Revisit's link; SET NULL on its
  // delete), read through the same scope: compared only when it kept
  // checks of its own.
  let vsLast: NonNullable<SessionTonesReply["tones"]>["vsLast"] = null;
  if (conv.previousConversationId) {
    const prev = await toneConversation(rawDb(), ctx.language, conv.previousConversationId);
    const was = prev ? sessionTones(await sessionChecks(rawDb(), ctx.language, prev.id)) : null;
    const vs = prev && was ? compareTones(now, was) : null;
    if (prev && vs) vsLast = { from: prev.id, startedAt: prev.startedAt.toISOString(), ...vs };
  }
  sendJson(res, 200, { tones: { ...now, vsLast } } satisfies SessionTonesReply);
}

/** The per-tone trend over the last `days` (the learner's days: `tz`, the
 *  browser's UTC offset, as Practice counts them). */
export async function toneTrendRoute(res: ServerResponse, ctx: LearnerCtx, params: URLSearchParams): Promise<void> {
  const days = readTrendDays(params.get("days"));
  const tz = readUtcOffset(params.get("tz"));
  const { from, to, since } = trendWindow(new Date(), days, tz);
  const reply: ToneTrendReply = { days, from, to, minSyllables: TREND_MIN_SYLLABLES, points: [] };
  if (ctx.learner.mode === "kids") return sendJson(res, 200, reply);
  const rows = await trendChecks(rawDb(), ctx.language, since);
  reply.points = toneTrend(rows, { utcOffsetMinutes: tz });
  sendJson(res, 200, reply);
}

/* ------------------------------ Practice speak-it ------------------------------ */
// The score route (pronunciation.ts) runs before the answer is sent: the
// page scores the recording with `phrase` and `submit`, and the server
// keeps the live bar's flags of that score here, for the answer of that
// submit (practice.ts) to take. The page never sends a verdict: the grade
// changes only on a score the server made itself. Held in this process's
// memory only: one per learner and language (a newer score replaces it),
// for HOLD_MS, and kept after the answer takes it, so a resend of that
// answer (a lost reply) whose first try was never recorded still finds it.

/** How long a score waits for its answer: Check follows the score at
 *  once, but a grader call or a retry may come a while later. Mutable for
 *  the tests, like pronunciation.ts SCORER. */
export const PRACTICE_HOLD = { ms: 10 * 60_000 };

interface Held {
  phraseId: string;
  submitId: string;
  han: string;
  flags: FlagNote[];
  at: number;
}
const held = new Map<string, Held>();
const keyOf = (ctx: LearnerCtx) => `${ctx.learner.id}:${ctx.language.id}`;

/** Keep a speak-it score's flags for its answer (adults only: Practice is
 *  theirs). */
export function holdPracticeTones(ctx: LearnerCtx, h: Omit<Held, "at">): void {
  const now = Date.now();
  for (const [k, v] of held) if (now - v.at > PRACTICE_HOLD.ms) held.delete(k);
  held.set(keyOf(ctx), { ...h, at: now });
}

/** The flags held for this submit of this phrase, with these Han
 *  characters, or null (none, another card's or another take's, expired). */
export function heldPracticeTones(ctx: LearnerCtx, { phraseId, submitId, han }: { phraseId: string; submitId: string; han: string }): FlagNote[] | null {
  const h = held.get(keyOf(ctx));
  if (!h || Date.now() - h.at > PRACTICE_HOLD.ms) return null;
  if (h.phraseId !== phraseId || h.submitId !== submitId || h.han !== han) return null;
  return h.flags;
}

/** For the tests. */
export function clearPracticeTones(): void {
  held.clear();
}

/** For the tests: the flags held for a learner and language, whatever
 *  their submit (so a test knows its negative case had a flag to drop). */
export function peekPracticeTones(learnerId: string, languageId: string): FlagNote[] | null {
  return held.get(`${learnerId}:${languageId}`)?.flags ?? null;
}

/**
 * What settles a Mandarin word's reading for this learner, beyond a stored
 * phrase reading (pronunciation-review.mjs settleFlags): their own
 * corrections and confirmations made by hand, and the shared list's active
 * entries (Taiwan-only ones in a zh-TW language only). A recap's guess isn't
 * the learner's choice and settles nothing here.
 */
export async function settlingReadings(ctx: LearnerCtx, locale: string): Promise<{ word: string; key: string; reading: string }[]> {
  const [mine, shared] = await Promise.all([listCorrections(rawDb(), ctx.language), activeList(rawDb())]);
  const tw = /-TW$/i.test(locale);
  return [
    ...mine.filter((c) => c.source === "user" && (c.kind === "corrected" || c.kind === "confirmed")).map(({ word, key, reading }) => ({ word, key, reading })),
    ...shared.entries.filter((e) => e.scope === "all" || tw).map(({ word, key, reading }) => ({ word, key, reading })),
  ];
}
