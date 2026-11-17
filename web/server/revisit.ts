import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { and, desc, eq, gte, isNotNull, sql, type SQL } from "drizzle-orm";
import { failureHint, startClaude } from "../../scripts/claude.mjs";
import type { LanguageProfileRef } from "../../scripts/db/owned.ts";
import { DIGEST_SESSIONS, WEEK_MS, digestPrompt, parseDigest, weekStats } from "../../scripts/revisit.mjs";
import type { OverviewReply } from "../shared/wire.ts";
import { learnerProfile, type LearnerCtx } from "./auth.ts";
import { profileRows, rawDb, schema } from "./db.ts";
import { sendJson } from "./sse.ts";
import { getModel } from "./store.ts";

// Revisit (docs/DATA.md §Revisit), the server half beside conversations.ts:
// which earlier attempt a new session builds on, and History's overview
// (the 7-day card, counted from stored rows, and the digest, written once a
// day by a tool-less `claude -p` over the week's recaps). The pure rules
// are scripts/revisit.mjs.
//
//   GET /api/conversations/overview → {stats, digest}   (mounted by conversations.ts)
//
// Every read and write goes through the active language's scope
// (profileRows): another language's or learner's sessions never count.

const { conversations, recentDigests } = schema;
type Conversation = typeof conversations.$inferSelect;
type Digest = typeof recentDigests.$inferSelect;

/**
 * The attempt a new session of scene `key` builds on: `preferred` (the
 * session Practice again was pressed on) when it is this language's, this
 * scene's, ended and its recap done; else the scene's latest such session.
 * A session whose recap failed, was skipped or is still being written has
 * nothing to carry, so it is passed over.
 */
export async function previousAttempt(profile: LanguageProfileRef, key: string, preferred: string | null): Promise<Conversation | null> {
  const mine = profileRows(profile);
  const usable = and(eq(conversations.sceneKey, key), isNotNull(conversations.endedAt), eq(conversations.extractionStatus, "done")) as SQL;
  if (preferred) {
    const row = await mine.get(conversations, and(eq(conversations.id, preferred), usable) as SQL);
    if (row) return row;
  }
  const [row] = await mine.list(conversations, usable, { orderBy: [desc(conversations.startedAt), desc(conversations.id)], limit: 1 });
  return row ?? null;
}

/* --------------------------------- digest ---------------------------------- */

/** One call's limit; a digest is one short JSON reply, tried once a day. */
const CALL_TIMEOUT_SEC = 120;

/** The claims of the digest runs going on in this server (one process), so
 *  a 'running' row a restart killed reads as failed, and the runs, for the
 *  tests to wait on. */
const live = new Set<string>();
const running = new Set<Promise<void>>();

/** Resolves when every digest run started so far has finished (the tests). */
export async function settleDigests(): Promise<void> {
  while (running.size) await Promise.allSettled([...running]);
}

/** The server's calendar day, YYYY-MM-DD: the daily cap's day. */
function today(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// The last saved turn's time, as conversations.ts reads it for History's
// lengths (an open session runs to its last turn).
const LAST_TURN = sql.raw(`(select max(t.created_at) from turns t where t.conversation_id = "conversations"."id")`);

/** The language's sessions started in the last week, newest first, with
 *  what the card and the digest read. */
async function weekRows(profile: LanguageProfileRef, now: Date) {
  return rawDb()
    .select({
      id: conversations.id,
      title: conversations.title,
      startedAt: conversations.startedAt,
      endedAt: conversations.endedAt,
      lastTurnAt: sql<Date | null>`${LAST_TURN}`.mapWith(conversations.startedAt),
      sceneKey: sql<string>`coalesce(${conversations.sceneKey}, 'c:' || ${conversations.id}::text)`,
      summary: conversations.summary,
      extraction: conversations.extraction,
      extractionStatus: conversations.extractionStatus,
    })
    .from(conversations)
    .where(profileRows(profile).where(conversations, gte(conversations.startedAt, new Date(now.getTime() - WEEK_MS))))
    .orderBy(desc(conversations.startedAt), desc(conversations.id));
}

type WeekRow = Awaited<ReturnType<typeof weekRows>>[number];

/** Write today's digest: one model call, never retried (the day's row is
 *  the cap). Holds `claim`; a run whose claim was lost writes nothing. */
async function runDigest(ctx: LearnerCtx, row: Digest, sessions: WeekRow[], claim: string): Promise<void> {
  const mine = profileRows(ctx.language);
  const finish = (set: Partial<Digest>) =>
    mine.update(recentDigests, { ...set, claim: null, finishedAt: sql`now()` } as never, and(eq(recentDigests.id, row.id), eq(recentDigests.claim, claim)) as SQL);
  try {
    const profile = learnerProfile(ctx.learner, ctx.language);
    const { system, user } = digestPrompt({
      sessions,
      nativeLanguage: String(profile.native_language || "English"),
      targetVariant: String(profile.target_variant || profile.target_language || "the target language"),
    });
    const { result } = startClaude({
      prompt: user, systemPrompt: system, model: await getModel(ctx.user.id),
      // No tools and an empty temp cwd, like a recap: the recaps are the
      // learner's data and the model needs nothing else.
      cwd: os.tmpdir(), tools: "none", maxTurns: 1, timeoutSec: CALL_TIMEOUT_SEC,
    });
    const text = parseDigest((await result).text);
    if (!text) {
      console.error(`[lingo-dojo] digest for language ${ctx.language.id}: the reply had no digest`);
      await finish({ status: "failed" });
      return;
    }
    await finish({ status: "done", text });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    console.error(`[lingo-dojo] digest for language ${ctx.language.id} failed: ${failureHint(msg) || msg}`);
    await finish({ status: "failed" }).catch((e2) => console.error("[lingo-dojo] digest: the failure couldn't be stored:", e2));
  }
}

/**
 * Today's digest, if one is due: the week has a session with a finished
 * recap newer than anything a digest has covered, and today has no row
 * yet (one per language per day, failed ones included, claimed by the
 * insert: two tabs asking at once make one call). Starts the run in the
 * background; returns today's row, new or not.
 */
async function startDigestIfDue(ctx: LearnerCtx, rows: WeekRow[], latestDone: Digest | undefined, todays: Digest | undefined): Promise<Digest | undefined> {
  if (todays) return todays;
  const recapped = rows.filter((r) => r.endedAt && r.extractionStatus === "done").slice(0, DIGEST_SESSIONS);
  const newest = recapped[0]?.startedAt;
  if (!newest || (latestDone?.through && new Date(newest) <= new Date(latestDone.through))) return undefined;
  const claim = randomUUID();
  const [row] = await profileRows(ctx.language).insertOrIgnore(
    recentDigests,
    { day: today(), status: "running", claim, through: new Date(newest), sessions: recapped.length },
    { target: [recentDigests.day] },
  );
  if (!row) return undefined; // another request claimed today first
  live.add(claim);
  const done = runDigest(ctx, row, recapped, claim)
    .catch((e) => console.error("[lingo-dojo] digest:", e))
    .finally(() => {
      live.delete(claim);
      running.delete(done);
    });
  running.add(done);
  return row;
}

/** GET /api/conversations/overview (conversations.ts mounts it, after its
 *  idle end). A kids learner gets neither part: their History stays the
 *  list, with no stats to measure a child by. */
export async function handleOverview(res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  if (ctx.learner.mode === "kids") return sendJson(res, 200, { stats: null, digest: null } satisfies OverviewReply);
  const now = new Date();
  const rows = await weekRows(ctx.language, now);
  const mine = profileRows(ctx.language);
  const [latestDone] = await mine.list(recentDigests, eq(recentDigests.status, "done"), { orderBy: [desc(recentDigests.day)], limit: 1 });
  let todays = await mine.get(recentDigests, eq(recentDigests.day, today(now)));
  todays = await startDigestIfDue(ctx, rows, latestDone, todays);
  // Today's, when it is done, is the newest done one.
  const shown = todays?.status === "done" ? todays : latestDone;
  const newest = rows.find((r) => r.endedAt && r.extractionStatus === "done")?.startedAt;
  const stale = !!newest && (!shown?.through || new Date(newest) > new Date(shown.through));
  const pending = todays?.status === "running" && !!todays.claim && live.has(todays.claim);
  const failed = !!todays && todays.status !== "done" && !pending;
  sendJson(res, 200, {
    stats: weekStats(rows, now),
    digest: {
      text: shown?.text ?? null,
      writtenAt: shown?.finishedAt ? new Date(shown.finishedAt).toISOString() : null,
      sessions: shown?.sessions ?? 0,
      status: pending ? "pending" : failed && stale ? "failed" : stale ? "stale" : "current",
    },
  } satisfies OverviewReply);
}
