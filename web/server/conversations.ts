import type { IncomingMessage, ServerResponse } from "node:http";
import { and, asc, desc, eq, gte, notInArray, sql, type SQL } from "drizzle-orm";
import { effectiveProfile } from "../../scripts/assemble.mjs";
import { loadContent, modeRoot, normalizePack } from "../../scripts/content.mjs";
import {
  CONVERSATION_ID_RE, IDLE_END_MS, MAX_PAGE, MAX_TURN_PAGE, PAGE_SIZE, TURN_PAGE, conversationTitle, itemFromRow, planTurnWrite, readPage,
} from "../../scripts/conversations.mjs";
import { languageProfileRefsOfUser, type LanguageProfile } from "../../scripts/db/accounts.ts";
import { forLanguageProfile, type LanguageProfileRef } from "../../scripts/db/owned.ts";
import { addScenarioPhrases, recordGlosses, unrecordGlosses } from "../../scripts/db/phrases.ts";
import { glossCaptures, sameLanguage, scenarioEntries } from "../../scripts/phrases.mjs";
import { readMinutes } from "../../scripts/plan.mjs";
import { localeFor, sessionPlan } from "../../scripts/voice.mjs";
import type {
  ConversationCreateRequest, ConversationReply, ConversationSummary, ConversationTurn, ConversationTurnsReply, ConversationsReply, ErrorCode,
  PackInput, VoiceHistoryItem, VoicePlanItem,
} from "../shared/wire.ts";
import { learnerMode, learnerProfile, type LearnerCtx } from "./auth.ts";
import { profileRows, rawDb, schema } from "./db.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";
import { readVoiceSettings } from "./store.ts";

// Saved conversations (docs/DATA.md §Conversations): every voice session is
// stored for its learner's language, turn by turn, and listed in the
// Library's History (each language has its own).
//
//   POST   /api/conversations             {mode, pack, title?} → {conversation}  (201)
//   GET    /api/conversations             ?offset=&limit= → {conversations, nextOffset}, newest first
//   GET    /api/conversations/:id         ?from=&limit= → {conversation, turns, nextFrom, plan, locale}
//   POST   /api/conversations/:id/end     → {conversation}; idempotent
//   DELETE /api/conversations/:id         → {deleted: true}; the turns go with it
//
// All of them act for the active learner and its active language (wrap's
// `learner: true`), and every row is read and written through that
// language's scope (profileRows), so another language's conversation id, of
// the same learner or any other, guessed or not, is the same 404 as one that
// doesn't exist. The turns themselves are written by the voice turn
// route (voice.ts) through saveTurn below, after the dojo master answered.
//
// Ending: End, leaving the Go tab, closing the panel, Restart and page
// unload all call /end (and the page sends End before it switches learner
// or language, while its headers still name the conversation's). A
// conversation nobody ended is ended lazily, two hours after its last turn,
// by the next conversation request or voice turn of any of its account's
// learners, in any language (endIdle; there is no timer). Whichever way, the one write
// that sets ended_at calls onConversationEnded, exactly once. Deleting an
// open conversation doesn't: it never ended.
//
// The phrase bank (scripts/db/phrases.ts) is fed from here too: a new
// conversation's scenario lists at its start (create), and each saved
// reply's glosses inside the turn's own transaction (saveTurn). Both only
// when the session practises the profile's language: a pack that moves the
// target language (a German scene from the Spanish profile) leaves the
// Spanish bank alone.

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
 * Called exactly once for each conversation that ends, right after the write
 * that set its ended_at (End, Restart, leaving Go, closing the panel, page
 * unload, or the two-hour idle end) — that write only matches a row whose
 * ended_at is still null, so a second End or a racing idle end finds nothing
 * and never gets here. A conversation deleted while open is never ended, so
 * never gets here either. The post-session extraction (DATA.md §Post-session extraction,
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
// by learner and conversation, so two learners, or two devices, never block
// each other, and naming someone else's conversation id touches nothing of
// theirs. A turn with no conversation falls back to its login session, the
// lock this replaced: two tabs of one browser share it.
//
// End holds the same key while it writes ended_at. Both sides take it
// synchronously (no await between checking and setting), and the turn takes
// it as soon as its body names the conversation, before any query: so either
// the turn holds it first and End waits for the whole turn, its write
// included, or End holds it first and the turn is refused with
// conversation_ended before anything runs. A turn can never pass the "still
// open?" check and then find the conversation ended under it.
type Hold = { kind: "turn" | "end"; learnerId: string | null; conversationId: string | null; done: Promise<void> };
const holds = new Map<string, Hold>();

export function turnLockKey(learnerId: string, conversationId: string | null, sessionId: string): string {
  return conversationId ? `conversation:${learnerId}:${conversationId}` : `session:${sessionId}`;
}

function hold(key: string, h: Omit<Hold, "done">): () => void {
  let release!: () => void;
  holds.set(key, { ...h, done: new Promise<void>((resolve) => (release = resolve)) });
  return () => {
    holds.delete(key);
    release();
  };
}

/** Take the turn lock for a conversation (or, with none, the login
 *  session), or a 409: conversation_ended while End holds it, an ordinary
 *  409 while another turn does. Returns the release, to call on every way
 *  out of the turn, refusals included. Synchronous on purpose. */
export function takeTurnLock(learnerId: string, conversationId: string | null, sessionId: string): () => void {
  const key = turnLockKey(learnerId, conversationId, sessionId);
  const held = holds.get(key);
  if (held?.kind === "end") throw new HttpError(409, "that conversation has ended", CONVERSATION_ENDED);
  if (held) throw new HttpError(409, "the dojo master is still answering the last turn");
  return hold(key, { kind: "turn", learnerId: conversationId ? learnerId : null, conversationId });
}

/** End's hold: waits out whatever holds the key (a turn on its way is
 *  stored in the conversation it belongs to, not refused), then takes it. */
async function holdForEnd(learnerId: string, conversationId: string): Promise<() => void> {
  const key = turnLockKey(learnerId, conversationId, "");
  for (let h = holds.get(key); h; h = holds.get(key)) await h.done;
  return hold(key, { kind: "end", learnerId, conversationId });
}

/** This learner's conversations with a turn running now. */
function turningFor(learnerId: string): string[] {
  const ids: string[] = [];
  for (const h of holds.values()) if (h.kind === "turn" && h.learnerId === learnerId && h.conversationId) ids.push(h.conversationId);
  return ids;
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

/** End the account's conversations that have been idle for two hours, in
 *  every language of every learner (archived ones too), at their last
 *  activity (so History's length isn't two idle hours longer), and run the
 *  hook for each. Called by every route that touches conversations, the
 *  voice turn included. All of the account's, not only the active
 *  language's: a session left open in German when the page switched to
 *  Chinese (its End lost) still ends, and its hook still runs, on the next
 *  request in any language. Each language is updated through its own scope.
 *  A conversation with a turn running is skipped (its last turn is about to
 *  be now), except `own`: the conversation the calling turn holds, which it
 *  checks itself. */
export async function endIdle(userId: string, own?: string): Promise<void> {
  for (const profile of await languageProfileRefsOfUser(rawDb(), userId)) {
    const busy = turningFor(profile.learnerId).filter((id) => id !== own);
    const rows = await profileRows(profile).update(
      conversations,
      { endedAt: sql`${lastActivity}` },
      sql`${conversations.endedAt} is null and ${lastActivity} < now() - ${sql.raw(`interval '${IDLE_END_MS} milliseconds'`)}${
        busy.length ? sql` and ${notInArray(conversations.id, busy)}` : sql``
      }`,
    );
    ended(rows);
  }
}

async function summaryOf(profile: LanguageProfileRef, id: string): Promise<ConversationSummary | null> {
  const [row] = await rawDb()
    .select({ c: conversations, lastTurnAt })
    .from(conversations)
    .where(profileRows(profile).where(conversations, eq(conversations.id, id)));
  return row ? summary(row.c, row.lastTurnAt) : null;
}

const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

function summary(c: Conversation, last: Date | string | null): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    mode: c.mode,
    scenarioId: c.scenarioId,
    nativeLanguage: c.nativeLanguage,
    targetLanguage: c.targetLanguage,
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

/** A voice turn's conversationId as a lowercase uuid, or the 404 that sends
 *  the Go tab to start a new conversation; null when the turn names none. */
export function conversationIdOf(id: unknown): string | null {
  if (id == null) return null;
  if (typeof id !== "string" || !CONVERSATION_ID_RE.test(id)) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  return id.toLowerCase();
}

/** The conversation a voice turn names, open and this language's: else the
 *  404 or 409 that sends the Go tab to start a new one. The turn holds its
 *  lock (takeTurnLock) before calling this. */
export async function openConversation(userId: string, profile: LanguageProfileRef, id: string): Promise<Conversation> {
  await endIdle(userId, id);
  const conv = await profileRows(profile).get(conversations, eq(conversations.id, id));
  if (!conv) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  if (conv.endedAt) throw new HttpError(409, "that conversation has ended", CONVERSATION_ENDED);
  return conv;
}

/** The session's target locale (es-MX), as the conversation saved it, when
 *  it practises `profile`'s language; null when a pack moved it to another
 *  (nothing goes into this profile's bank then). "" for a language with no
 *  known locale. */
function bankLocale(profile: Pick<LanguageProfile, "targetLanguage">, conv: Pick<Conversation, "targetLanguage" | "targetVariant">): string | null {
  if (!sameLanguage(profile.targetLanguage, { language: conv.targetLanguage, variant: conv.targetVariant })) return null;
  return localeFor(conv.targetLanguage, conv.targetVariant) ?? "";
}

/**
 * Store a turn that just succeeded, in one transaction: the stored turns are
 * made to match `screen` (the conversation's part of the history the browser
 * sent), then the learner's message and the reply are appended
 * (scripts/conversations.mjs planTurnWrite says how a retry, a stopped turn
 * or a dropped reply come out). The conversation row is held FOR UPDATE, so
 * an End landing meanwhile waits, and a conversation that ended (or was
 * deleted) since the turn began is left alone: false, the turn unsaved.
 *
 * The reply's glosses go into the phrase bank in the same transaction, as
 * seen (scripts/db/phrases.ts recordGlosses, in a savepoint: a capture that
 * fails costs the bank that turn, never the turn). Only the reply the
 * server just produced is captured: master turns reinserted from the
 * browser's history are its copy (from_client), and were captured, if at
 * all, when they were the reply. A stored reply the write deletes (the
 * browser dropped it) takes its sightings with it (unrecordGlosses), so a
 * phrase isn't counted for a reply the transcript no longer has.
 */
export async function saveTurn(
  profile: LanguageProfileRef & Pick<LanguageProfile, "targetLanguage">,
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
    const mine = forLanguageProfile(tx, profile);
    const [conv] = await tx.select().from(conversations).where(mine.where(conversations, eq(conversations.id, conversationId))).for("update");
    if (!conv || conv.endedAt) return false;
    const stored = await mine.list(turns, eq(turns.conversationId, conversationId), { orderBy: asc(turns.idx) });
    const { keep, insert, covered } = planTurnWrite({ stored, screen: turn.screen, message: turn.message, master: turn.master });
    // Not an error: a history that doesn't cover what is stored rewrites
    // nothing (DATA.md §Conversations), but a working browser never sends one.
    if (!covered) console.warn(`[lingo-dojo] conversation ${conversationId}: the turn's history doesn't cover the ${stored.length} stored turns; appended only`);
    const lang = bankLocale(profile, conv);
    if (keep < stored.length) {
      // Undo what these turns' captures did (recordGlosses below, when they
      // were the reply) before they go, while their sightings and examples
      // still name them: only what was recorded, so a turn never captured
      // (a copy from the browser, a failed capture) changes nothing.
      await unrecordGlosses(tx, profile, { turnIds: stored.slice(keep).map((t) => t.id) });
      await mine.remove(turns, and(eq(turns.conversationId, conversationId), gte(turns.idx, keep)) as SQL);
    }
    const written = await mine.insert(
      turns,
      insert.map((r) => ({
        ...r,
        conversationId,
        durationMs: r.durationMs == null ? null : Math.round(r.durationMs),
        costUsd: r.costUsd ?? null,
      })),
    );
    const reply = written.findLast((t) => t.role === "master" && !t.fromClient);
    if (reply && lang != null && turn.master.role === "master") {
      const items = glossCaptures(turn.master.glosses, turn.master.lines, lang || null);
      await recordGlosses(tx, profile, { lang, conversationId, turnId: reply.id, items });
    }
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
  await endIdle(ctx.user.id);
  const scenarioId = typeof pack.scenario === "string" && pack.scenario ? pack.scenario : null;
  const scenario = scenarioId ? loadContent(modeRoot(mode)).scenarios.find((s) => s.id === scenarioId) : undefined;
  const scenarioTitle = scenario?.title ?? null;
  // The session's languages, as the prompt sees them (the profile under the
  // pack's overrides, a moved target language dropping the profile's
  // variant), kept so History's locales never follow a later profile edit.
  const langs = effectiveProfile(learnerProfile(ctx.learner, ctx.language), normalizePack(pack).overrides);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
  const [row] = await profileRows(ctx.language).insert(conversations, {
    // What was played, frozen: the pack changes later, and History shows
    // what this session was.
    packSnapshot: pack as unknown as Record<string, unknown>,
    scenarioId,
    title: conversationTitle({ title: body.title, pack, scenarioTitle }),
    mode,
    nativeLanguage: str(langs.native_language),
    targetLanguage: str(langs.target_language),
    targetVariant: str(langs.target_variant),
    model: (await readVoiceSettings(ctx.user.id)).model,
    plannedMinutes: readMinutes(pack.overrides?.minutes).minutes,
  });
  // The scenario's lists into the bank (DATA.md §Phrase capture): its
  // vocab as phrases, its English `phrases:` as pending ones. Not part of
  // the conversation's creation: a failure here is logged, and the session
  // goes on.
  const lang = bankLocale(ctx.language, row);
  if (scenario && lang != null) {
    const entries = scenarioEntries(scenario, lang || null);
    await addScenarioPhrases(rawDb(), ctx.language, { lang, ...entries }).catch((e) => {
      console.error(`[lingo-dojo] phrase bank: scenario ${scenarioId}'s lists weren't added:`, e);
    });
  }
  sendJson(res, 201, { conversation: summary(row, null) } satisfies ConversationReply);
}

async function list(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  await endIdle(ctx.user.id);
  const { limit, start } = readPage(new URL(req.url ?? "/", "http://localhost").searchParams, { size: PAGE_SIZE, max: MAX_PAGE });
  // One more than asked, to know whether there is a next page.
  const rows = await rawDb()
    .select({ c: conversations, lastTurnAt })
    .from(conversations)
    .where(profileRows(ctx.language).where(conversations))
    .orderBy(desc(conversations.startedAt), desc(conversations.id))
    .limit(limit + 1)
    .offset(start);
  sendJson(res, 200, {
    conversations: rows.slice(0, limit).map((r) => summary(r.c, r.lastTurnAt)),
    nextOffset: rows.length > limit ? start + limit : null,
  } satisfies ConversationsReply);
}

async function get(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx, id: string): Promise<void> {
  await endIdle(ctx.user.id);
  const mine = profileRows(ctx.language);
  const conv = await mine.get(conversations, eq(conversations.id, id));
  const head = conv && (await summaryOf(ctx.language, id));
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
  const page = rows.slice(0, limit);
  sendJson(res, 200, {
    conversation: head,
    turns: page.map((t) => ({ ...itemFromRow(t), idx: t.idx, at: iso(t.createdAt)!, durationMs: t.durationMs, costUsd: t.costUsd }) as ConversationTurn),
    nextFrom: rows.length > limit ? page[page.length - 1].idx + 1 : null,
    plan,
    // The session's own languages, saved when it started; never the profile
    // as it is now.
    locale: localeFor(conv.targetLanguage, conv.targetVariant),
    nativeLocale: localeFor(conv.nativeLanguage),
  } satisfies ConversationTurnsReply);
}

async function end(res: ServerResponse, ctx: LearnerCtx, id: string): Promise<void> {
  const learnerId = ctx.learner.id;
  await endIdle(ctx.user.id);
  if (!(await profileRows(ctx.language).get(conversations, eq(conversations.id, id)))) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  // Waits for a turn holding the conversation (stored first), and refuses
  // any turn that arrives while ending (the lock, above).
  const release = await holdForEnd(learnerId, id);
  try {
    // Only a still-open row matches, so a second End (or an idle end that
    // got there first) changes nothing and calls no hook: idempotent.
    ended(await profileRows(ctx.language).update(conversations, { endedAt: sql`now()` }, sql`${conversations.id} = ${id} and ${conversations.endedAt} is null`));
  } finally {
    release();
  }
  const head = await summaryOf(ctx.language, id);
  if (!head) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  sendJson(res, 200, { conversation: head } satisfies ConversationReply);
}

async function remove(res: ServerResponse, ctx: LearnerCtx, id: string): Promise<void> {
  await endIdle(ctx.user.id);
  // A hard delete; the turns cascade. A turn still running for it finds the
  // row gone when it comes to write, and answers unsaved.
  const gone = await profileRows(ctx.language).remove(conversations, eq(conversations.id, id));
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
