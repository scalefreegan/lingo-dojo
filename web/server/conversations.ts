import type { IncomingMessage, ServerResponse } from "node:http";
import { and, asc, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { loadContent, modeRoot } from "../../scripts/content.mjs";
import {
  CONVERSATION_ID_RE, IDLE_END_MS, MAX_PAGE, MAX_TURN_PAGE, PAGE_SIZE, TURN_PAGE, conversationTitle, itemFromRow, planTurnWrite, readPage,
} from "../../scripts/conversations.mjs";
import { forLearner } from "../../scripts/db/owned.ts";
import { readMinutes } from "../../scripts/plan.mjs";
import { localeFor, sessionPlan } from "../../scripts/voice.mjs";
import type {
  ConversationCreateRequest, ConversationReply, ConversationSummary, ConversationTurn, ConversationTurnsReply, ConversationsReply, ErrorCode,
  PackInput, VoiceHistoryItem, VoicePlanItem,
} from "../shared/wire.ts";
import { learnerMode, type LearnerCtx } from "./auth.ts";
import { learnerRows, rawDb, schema } from "./db.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";
import { readVoiceSettings } from "./store.ts";

// Saved conversations (docs/DATA.md §Conversations): every voice session is
// stored for its learner, turn by turn, and listed in the Library's History.
//
//   POST   /api/conversations             {mode, pack, title?} → {conversation}  (201)
//   GET    /api/conversations             ?offset=&limit= → {conversations, nextOffset}, newest first
//   GET    /api/conversations/:id         ?from=&limit= → {conversation, turns, nextFrom, plan, locale}
//   POST   /api/conversations/:id/end     → {conversation}; idempotent
//   DELETE /api/conversations/:id         → {deleted: true}; the turns go with it
//
// All of them act for the active learner (wrap's `learner: true`), and every
// row is read and written through that learner's scope (learnerRows), so
// another learner's conversation id, guessed or not, is the same 404 as one
// that doesn't exist. The turns themselves are written by the voice turn
// route (voice.ts) through saveTurn below, after the dojo master answered.
//
// Ending: End, leaving the Go tab, closing the panel, Restart and page
// unload all call /end. A conversation nobody ended is ended lazily, two
// hours after its last turn, by the next request that touches its learner's
// conversations (endIdle; there is no timer). Whichever way, the one write
// that sets ended_at calls onConversationEnded, exactly once.

const { conversations, turns } = schema;
export type Conversation = typeof conversations.$inferSelect;

const NO_CONVERSATION: ErrorCode = "no_conversation";
const CONVERSATION_ENDED: ErrorCode = "conversation_ended";

/* --------------------------------- the hook -------------------------------- */

let endObserver: ((c: Conversation) => void) | null = null;

/** The HTTP tests count the hook's calls through this; nothing else sets it. */
export function observeConversationEnds(fn: ((c: Conversation) => void) | null): void {
  endObserver = fn;
}

/**
 * Called exactly once for each conversation, right after the write that set
 * its ended_at (End, Restart, leaving Go, closing the panel, page unload, or
 * the two-hour idle end) — that write only matches a row whose ended_at is
 * still null, so a second End or a racing idle end finds nothing and never
 * gets here. The post-session extraction (DATA.md §Post-session extraction,
 * phase 5) attaches here; it does nothing yet. It must not throw into the
 * request that ended the conversation, and anything slow belongs in the
 * background (the End request is often a page-unload beacon).
 */
export function onConversationEnded(conversation: Conversation): void {
  endObserver?.(conversation);
}

function ended(rows: Conversation[]): void {
  for (const c of rows) {
    try {
      onConversationEnded(c);
    } catch (e) {
      console.error(`[lingo-dojo] conversation ${c.id} end hook:`, e);
    }
  }
}

/* --------------------------------- the lock -------------------------------- */

// One voice turn at a time per conversation: the transcript is the browser's
// and the stored turns mirror it, so a second turn racing the first would
// answer, and write, a conversation that is about to change under it. Keyed
// by conversation, so two learners, or two devices, never block each other.
// A turn with no conversation (creating one failed) falls back to its login
// session, the lock this replaced: two tabs of one browser share it.
const turning = new Map<string, Promise<void>>();

export function turnLockKey(conversationId: string | null, sessionId: string): string {
  return conversationId ? `conversation:${conversationId}` : `session:${sessionId}`;
}

/** Take the lock for `key`, or a 409 while a turn holds it. Returns the
 *  release, to call once the turn's reply (and its write) is done. */
export function takeTurnLock(key: string): () => void {
  if (turning.has(key)) throw new HttpError(409, "the dojo master is still answering the last turn");
  let release!: () => void;
  turning.set(key, new Promise<void>((resolve) => (release = resolve)));
  return () => {
    turning.delete(key);
    release();
  };
}

/** Wait out the turn running for this conversation, if any: End waits, so a
 *  turn already on its way (the learner left Go while the dojo master was
 *  thinking) is stored in the conversation it belongs to, not refused. */
async function turnSettled(conversationId: string): Promise<void> {
  await turning.get(turnLockKey(conversationId, ""));
}

/* --------------------------------- queries --------------------------------- */

// The last saved turn's time, as a correlated subquery on a conversation.
// Spelled out with an alias and the outer table's name: Drizzle leaves the
// table off a column in a one-table query, and an unqualified "id" inside
// the subquery would be the turn's own.
const LAST_TURN = sql.raw(`(select max(t.created_at) from turns t where t.conversation_id = "conversations"."id")`);
const lastTurnAt = sql<Date | null>`${LAST_TURN}`.mapWith(turns.createdAt);
/** When the conversation last moved: its last turn, else its start. */
const lastActivity = sql`coalesce(${LAST_TURN}, "conversations"."started_at")`;

/** End this learner's conversations that have been idle for two hours, at
 *  their last activity (so History's length isn't two idle hours longer),
 *  and run the hook for each. Called by every route that touches the
 *  learner's conversations, the voice turn included. */
export async function endIdle(learnerId: string): Promise<void> {
  const rows = await learnerRows(learnerId).update(
    conversations,
    { endedAt: sql`${lastActivity}` },
    sql`${conversations.endedAt} is null and ${lastActivity} < now() - ${sql.raw(`interval '${IDLE_END_MS} milliseconds'`)}`,
  );
  ended(rows);
}

async function summaryOf(learnerId: string, id: string): Promise<ConversationSummary | null> {
  const [row] = await rawDb()
    .select({ c: conversations, lastTurnAt })
    .from(conversations)
    .where(learnerRows(learnerId).where(conversations, eq(conversations.id, id)));
  return row ? summary(row.c, row.lastTurnAt) : null;
}

const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

function summary(c: Conversation, last: Date | string | null): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    mode: c.mode,
    scenarioId: c.scenarioId,
    targetVariant: c.targetVariant,
    model: c.model,
    plannedMinutes: c.plannedMinutes,
    startedAt: iso(c.startedAt)!,
    endedAt: iso(c.endedAt),
    lastTurnAt: iso(last),
    turnCount: c.turnCount,
    summary: c.summary,
  };
}

/** The conversation a voice turn names, open and this learner's: else the
 *  404 or 409 that sends the Go tab to start a new one. */
export async function openConversation(learnerId: string, id: unknown): Promise<Conversation> {
  if (typeof id !== "string" || !CONVERSATION_ID_RE.test(id)) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  await endIdle(learnerId);
  const conv = await learnerRows(learnerId).get(conversations, eq(conversations.id, id.toLowerCase()));
  if (!conv) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  if (conv.endedAt) throw new HttpError(409, "that conversation has ended", CONVERSATION_ENDED);
  return conv;
}

/**
 * Store a turn that just succeeded, in one transaction: the stored turns are
 * made to match `screen` (the conversation's part of the history the browser
 * sent), then the learner's message and the reply are appended
 * (scripts/conversations.mjs planTurnWrite says how a retry, a stopped turn
 * or a dropped reply come out). The conversation row is held FOR UPDATE, so
 * an End landing meanwhile waits, and a conversation that ended (or was
 * deleted) since the turn began is left alone: false, the turn unsaved.
 */
export async function saveTurn(
  learnerId: string,
  conversationId: string,
  turn: {
    screen: VoiceHistoryItem[];
    message: string;
    master: VoiceHistoryItem & { durationMs: number | null; costUsd: number | null };
    pack: PackInput;
    model: string;
  },
): Promise<boolean> {
  return rawDb().transaction(async (tx) => {
    const mine = forLearner(tx, learnerId);
    const [conv] = await tx.select().from(conversations).where(mine.where(conversations, eq(conversations.id, conversationId))).for("update");
    if (!conv || conv.endedAt) return false;
    const stored = await mine.list(turns, eq(turns.conversationId, conversationId), { orderBy: asc(turns.idx) });
    const { keep, insert } = planTurnWrite({ stored, screen: turn.screen, message: turn.message, master: turn.master });
    if (keep < stored.length) await mine.remove(turns, and(eq(turns.conversationId, conversationId), gte(turns.idx, keep)) as SQL);
    await mine.insert(
      turns,
      insert.map((r) => ({
        ...r,
        conversationId,
        durationMs: r.durationMs == null ? null : Math.round(r.durationMs),
        costUsd: r.costUsd ?? null,
      })),
    );
    // The length and the model as of this turn: +5 min, a length picked
    // mid-session and a model switched in the settings all show in History.
    await mine.update(
      conversations,
      { turnCount: keep + insert.length, plannedMinutes: readMinutes(turn.pack.overrides?.minutes).minutes, model: turn.model },
      eq(conversations.id, conversationId),
    );
    return true;
  });
}

/* --------------------------------- routes ---------------------------------- */

function isPack(v: unknown): v is PackInput {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function create(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const body = await readJsonBody<Partial<ConversationCreateRequest>>(req);
  const mode = learnerMode(req, ctx, body?.mode ?? undefined);
  if (!isPack(body?.pack)) throw new HttpError(400, "body must carry the pack");
  const pack = body.pack;
  await endIdle(ctx.learner.id);
  const scenarioId = typeof pack.scenario === "string" && pack.scenario ? pack.scenario : null;
  const scenarioTitle = scenarioId ? loadContent(modeRoot(mode)).scenarios.find((s) => s.id === scenarioId)?.title : null;
  const variant = typeof pack.overrides?.target_variant === "string" ? pack.overrides.target_variant.trim() : "";
  const [row] = await learnerRows(ctx.learner.id).insert(conversations, {
    // What was played, frozen: the pack changes later, and History shows
    // what this session was.
    packSnapshot: pack as unknown as Record<string, unknown>,
    scenarioId,
    title: conversationTitle({ title: body.title, pack, scenarioTitle }),
    mode,
    targetVariant: variant || ctx.learner.targetVariant,
    model: (await readVoiceSettings(ctx.user.id)).model,
    plannedMinutes: readMinutes(pack.overrides?.minutes).minutes,
  });
  sendJson(res, 201, { conversation: summary(row, null) } satisfies ConversationReply);
}

async function list(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  await endIdle(ctx.learner.id);
  const { limit, start } = readPage(new URL(req.url ?? "/", "http://localhost").searchParams, { size: PAGE_SIZE, max: MAX_PAGE });
  // One more than asked, to know whether there is a next page.
  const rows = await rawDb()
    .select({ c: conversations, lastTurnAt })
    .from(conversations)
    .where(learnerRows(ctx.learner.id).where(conversations))
    .orderBy(desc(conversations.startedAt), desc(conversations.id))
    .limit(limit + 1)
    .offset(start);
  sendJson(res, 200, {
    conversations: rows.slice(0, limit).map((r) => summary(r.c, r.lastTurnAt)),
    nextOffset: rows.length > limit ? start + limit : null,
  } satisfies ConversationsReply);
}

async function get(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx, id: string): Promise<void> {
  await endIdle(ctx.learner.id);
  const mine = learnerRows(ctx.learner.id);
  const conv = await mine.get(conversations, eq(conversations.id, id));
  const head = conv && (await summaryOf(ctx.learner.id, id));
  if (!conv || !head) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  const { limit, start } = readPage(new URL(req.url ?? "/", "http://localhost").searchParams, { size: TURN_PAGE, max: MAX_TURN_PAGE, key: "from" });
  const rows = await mine.list(turns, and(eq(turns.conversationId, id), gte(turns.idx, start)) as SQL, { orderBy: asc(turns.idx), limit: limit + 1 });
  const pack = conv.packSnapshot as unknown as PackInput;
  // The parts as they were for this pack, for "Jumped to …" labels. A pack
  // the library can no longer place (a unit since deleted) has none.
  let plan: VoicePlanItem[] = [];
  try {
    plan = sessionPlan(loadContent(modeRoot(conv.mode)), pack, conv.mode);
  } catch {
    plan = [];
  }
  const target = typeof pack.overrides?.target_language === "string" && pack.overrides.target_language ? pack.overrides.target_language : ctx.learner.targetLanguage;
  const page = rows.slice(0, limit);
  sendJson(res, 200, {
    conversation: head,
    turns: page.map((t) => ({ ...itemFromRow(t), idx: t.idx, at: iso(t.createdAt)!, durationMs: t.durationMs, costUsd: t.costUsd }) as ConversationTurn),
    nextFrom: rows.length > limit ? page[page.length - 1].idx + 1 : null,
    plan,
    locale: localeFor(target, conv.targetVariant),
    nativeLocale: localeFor(ctx.learner.nativeLanguage),
  } satisfies ConversationTurnsReply);
}

async function end(res: ServerResponse, ctx: LearnerCtx, id: string): Promise<void> {
  const learnerId = ctx.learner.id;
  await endIdle(learnerId);
  if (!(await learnerRows(learnerId).get(conversations, eq(conversations.id, id)))) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  await turnSettled(id);
  // Only a still-open row matches, so a second End (or an idle end that got
  // there first) changes nothing and calls no hook: idempotent.
  ended(await learnerRows(learnerId).update(conversations, { endedAt: sql`now()` }, sql`${conversations.id} = ${id} and ${conversations.endedAt} is null`));
  const head = await summaryOf(learnerId, id);
  if (!head) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  sendJson(res, 200, { conversation: head } satisfies ConversationReply);
}

async function remove(res: ServerResponse, ctx: LearnerCtx, id: string): Promise<void> {
  await endIdle(ctx.learner.id);
  // A hard delete; the turns cascade. A turn still running for it finds the
  // row gone when it comes to write, and answers unsaved.
  const gone = await learnerRows(ctx.learner.id).remove(conversations, eq(conversations.id, id));
  if (!gone.length) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  sendJson(res, 200, { deleted: true });
}

/** /api/conversations, mounted with wrap's `learner: true`. */
export async function handleConversations(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const parts = subPath(req).split("/").filter(Boolean);
  if (!parts.length) {
    if (req.method === "GET") return list(req, res, ctx);
    if (req.method === "POST") return create(req, res, ctx);
    return methodNotAllowed(res, "GET, POST");
  }
  const [id, action, ...rest] = parts;
  if (rest.length || (action !== undefined && action !== "end")) return sendJson(res, 404, { error: "no such route" });
  // A malformed id is no conversation of anyone's (and never reaches
  // Postgres, which would answer it with an error).
  if (!CONVERSATION_ID_RE.test(id)) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  if (action === "end") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return end(res, ctx, id.toLowerCase());
  }
  if (req.method === "GET") return get(req, res, ctx, id.toLowerCase());
  if (req.method === "DELETE") return remove(res, ctx, id.toLowerCase());
  methodNotAllowed(res, "GET, DELETE");
}
