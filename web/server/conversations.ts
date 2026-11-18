import type { IncomingMessage, ServerResponse } from "node:http";
import { and, asc, desc, eq, gte, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { RANDOM_SCENE_TITLE, effectiveProfile } from "../../scripts/assemble.mjs";
import { loadContent, modeRoot, normalizePack } from "../../scripts/content.mjs";
import {
  CONVERSATION_ID_RE, IDLE_END_MS, MAX_PAGE, MAX_TURN_PAGE, PAGE_SIZE, TURN_PAGE, conversationTitle, itemFromRow, planTurnWrite, readPage,
} from "../../scripts/conversations.mjs";
import { languageProfileRefsOfUser, type LanguageProfile } from "../../scripts/db/accounts.ts";
import { hiddenSet } from "../../scripts/db/hidden.ts";
import { forLanguageProfile, type LanguageProfileRef } from "../../scripts/db/owned.ts";
import { addScenarioPhrases, forgetUnused, lockTurnWrite, recordGlosses, unrecordGlosses } from "../../scripts/db/phrases.ts";
import { bankLocale as sessionBankLocale, glossCaptures, scenarioEntries } from "../../scripts/phrases.mjs";
import { readMinutes } from "../../scripts/plan.mjs";
import { storedReviewIds } from "../../scripts/recall.mjs";
import { carryFrom, linkable, sceneKey, storedRevisit } from "../../scripts/revisit.mjs";
import { randomUUID } from "node:crypto";
import { localeFor, sessionPlan } from "../../scripts/voice.mjs";
import type {
  ConversationCreateRequest, ConversationReply, ConversationSummary, ConversationTurn, ConversationTurnsReply, ConversationsReply, ErrorCode,
  PackInput, ScenesReply, VoiceHistoryItem, VoicePlanItem,
} from "../shared/wire.ts";
import { learnerMode, learnerProfile, type LearnerCtx } from "./auth.ts";
import { withDrawnScene } from "../shared/scenes.ts";
import { profileRows, rawDb, schema } from "./db.ts";
import { drawOrRefuse, randomSceneOf } from "./randomScene.ts";
import { extractAfterEnd, handleRecap, recapStatus } from "./extraction.ts";
import { handleOverview, lostPrevious, previousAttempt } from "./revisit.ts";
import { sessionReview } from "./recall.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";
import { readVoiceSettings } from "./store.ts";

// Saved conversations (docs/DATA.md §Conversations): every voice session is
// stored for its learner's language, turn by turn, and listed in the
// Library's History (each language has its own).
//
//   POST   /api/conversations             {mode, pack, title?, drawn?} → {conversation}  (201); a random scene is drawn here
//   GET    /api/conversations             ?offset=&limit=&scene= → {conversations, nextOffset}, newest first (one scene's with `scene`)
//   GET    /api/conversations/scenes      ?offset=&limit= → {scenes, nextOffset}: History by scene (revisit)
//   GET    /api/conversations/overview    → {stats, digest}: the 7-day card and the daily digest (revisit.ts)
//   GET    /api/conversations/:id         ?from=&limit= → {conversation, turns, nextFrom, plan, locale}
//   POST   /api/conversations/:id/end     → {conversation}; idempotent
//   GET    /api/conversations/:id/recap   → {recap}  (extraction.ts)
//   POST   /api/conversations/:id/recap   → 202 {recap}: make it again (Retry recap)
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
 * never gets here either. The post-session extraction (DATA.md §Post-session
 * extraction, extraction.ts) starts here, in the background: it must not
 * throw into the request that ended the conversation or hold it up (the
 * End request is often a page-unload beacon). Its own claim makes it run
 * once even if this were ever called twice.
 */
export function onConversationEnded(conversation: Conversation): void {
  endObserver?.(conversation);
  extractAfterEnd(conversation);
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
    randomScene: drawnScenario(c) != null,
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
    recapStatus: recapStatus(c),
    sceneKey: keyOf(c),
    buildsOn: buildsOn(c),
  };
}

/** A row's scene key; a row written without one (none should be: the
 *  migration filled the old ones) is a scene of its own. */
const keyOf = (c: Pick<Conversation, "id" | "sceneKey">) => c.sceneKey ?? `c:${c.id}`;

/** The attempt a session built on, from its frozen carry-over (the link
 *  column is null once that session is deleted; the date stays). */
function buildsOn(c: Conversation): ConversationSummary["buildsOn"] {
  const r = storedRevisit(c.packSnapshot);
  return r ? { id: c.previousConversationId, startedAt: r.startedAt } : null;
}

/** The scene key as SQL, the same fallback as keyOf. */
const SCENE = sql<string>`coalesce(${conversations.sceneKey}, 'c:' || ${conversations.id}::text)`;

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

/** The session's target locale when it practises `profile`'s language,
 *  else null (scripts/phrases.mjs bankLocale). */
const bankLocale = (profile: Pick<LanguageProfile, "targetLanguage">, conv: Pick<Conversation, "targetLanguage" | "targetVariant">) =>
  sessionBankLocale(profile.targetLanguage, conv);

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
    /** What a LOOKUP in this turn asked and found (scripts/recall.mjs
     *  lookupRecord), kept on the reply's row; absent for most turns. */
    lookup?: Record<string, unknown> | null;
    /** The review this turn chose for a conversation that had none stored
     *  (one started before reviews were stored: web/server/recall.ts
     *  turnRecall), kept so its later turns and recap offer the same. */
    review?: { phraseIds: string[] } | null;
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
    // The reply this write will capture, known before anything is written
    // (the last master row it inserts that the server wrote).
    const replyRow = insert.findLast((t) => t.role === "master" && !t.fromClient);
    const items = replyRow && lang != null && turn.master.role === "master" ? glossCaptures(turn.master.glosses, turn.master.lines, lang || null) : [];
    const dropped = stored.slice(keep).map((t) => t.id);
    // Dropping replies and capturing the new one: both jobs' phrases locked
    // in one norm-ordered pass first (the bank's lock order; two ordered
    // passes one after the other deadlock with a recap or capture between).
    const made = await lockTurnWrite(tx, profile, { turnIds: dropped, lang: lang ?? "", items });
    if (keep < stored.length) {
      // Undo what these turns' captures did (recordGlosses below, when they
      // were the reply) before they go, while their sightings and examples
      // still name them: only what was recorded, so a turn never captured
      // (a copy from the browser, a failed capture) changes nothing.
      await unrecordGlosses(tx, profile, { turnIds: dropped });
      await mine.remove(turns, and(eq(turns.conversationId, conversationId), gte(turns.idx, keep)) as SQL);
    }
    const written = await mine.insert(
      turns,
      insert.map((r) => ({
        ...r,
        ...(r === replyRow && turn.lookup ? { lookup: turn.lookup } : {}),
        conversationId,
        durationMs: r.durationMs == null ? null : Math.round(r.durationMs),
        costUsd: r.costUsd ?? null,
      })),
    );
    const reply = written.findLast((t) => t.role === "master" && !t.fromClient);
    if (reply && lang != null && turn.master.role === "master") {
      const n = await recordGlosses(tx, profile, { lang, conversationId, turnId: reply.id, items });
      if (n == null) await forgetUnused(tx, profile, made);
    }
    // The length and the model as of this turn: +5 min, a length picked
    // mid-session and a model switched in the settings all show in History.
    // A review chosen by this turn is kept only if none is stored yet
    // (checked under the row's lock): the first one chosen stands.
    const review = turn.review && storedReviewIds(conv.packSnapshot) == null ? { packSnapshot: { ...conv.packSnapshot, review: turn.review } } : {};
    await mine.update(
      conversations,
      { turnCount: keep + insert.length, plannedMinutes: readMinutes(turn.pack.overrides?.minutes).minutes, model: turn.model, ...review },
      eq(conversations.id, conversationId),
    );
    return true;
  });
}

/* --------------------------------- routes ---------------------------------- */

function isPack(v: unknown): v is PackInput {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** How many of the language's latest conversations a random draw looks at
 *  for scenes to steer clear of; scenes.ts drawScene keeps the first few
 *  distinct ones in the pool (at most RECENT_SCENES). Quick scenes have no
 *  scenario, so this looks past them. */
const RECENT_LOOKBACK = 20;

/** The scenario ids of the language's latest conversations, newest first
 *  (null for a quick scene). */
async function recentScenes(profile: LanguageProfileRef): Promise<(string | null)[]> {
  const rows = await rawDb()
    .select({ scenarioId: conversations.scenarioId })
    .from(conversations)
    .where(profileRows(profile).where(conversations))
    .orderBy(desc(conversations.startedAt), desc(conversations.id))
    .limit(RECENT_LOOKBACK);
  return rows.map((r) => r.scenarioId);
}

/** The scenario a conversation's random scene drew (its snapshot's
 *  `random_draw`), or null when it wasn't a random scene. */
export function drawnScenario(conv: Pick<Conversation, "packSnapshot">): string | null {
  const draw = (conv.packSnapshot as { random_draw?: { drawn?: unknown } } | null)?.random_draw;
  return typeof draw?.drawn === "string" ? draw.drawn : null;
}

/**
 * The pack a voice turn plays. A random scene's pack (the Go tab sends the
 * draft as it is) plays the scenario its conversation drew when it was
 * created, every turn, so nothing redraws; a turn may not play a random
 * scene with no conversation to hold its draw (the conversation couldn't be
 * made, or the session started with another scene), since drawing happens
 * only when a conversation is made. (The client sends an unsaved turn with
 * its session's drawn scene in place, scenes.ts unsavedTurnPack, so this
 * refuses only a session that never drew one.) Any other pack is played
 * as sent.
 */
export function playedPack(pack: PackInput, conv: Pick<Conversation, "packSnapshot"> | null): PackInput {
  if (!randomSceneOf(pack)) return pack;
  const drawn = conv ? drawnScenario(conv) : null;
  if (!drawn) {
    throw new HttpError(
      409,
      conv
        ? "This session started with another scene, so it has no random scene drawn. Restart to draw one."
        : "No scene has been drawn for this random scene yet: one is drawn when the session is saved, and saving it failed. Try again, or Restart.",
    );
  }
  return withDrawnScene(pack, drawn);
}

async function create(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const body = await readJsonBody<Partial<ConversationCreateRequest>>(req);
  const mode = learnerMode(req, ctx, body?.mode ?? undefined);
  if (!isPack(body?.pack)) throw new HttpError(400, "body must carry the pack");
  // `review`, `random_draw` and `revisit` in a snapshot are the server's
  // (below), never the client's: Practice again sends a snapshot back.
  const { review: _ignored, random_draw: _alsoIgnored, revisit: _andThis, ...sent } = body.pack as PackInput & { review?: unknown; random_draw?: unknown; revisit?: unknown };
  const random = randomSceneOf(sent);
  await endIdle(ctx.user.id);
  const library = loadContent(modeRoot(mode));
  // A random scene is drawn here, once, as the conversation is made: every
  // later turn plays the scenario this snapshot records (voice.ts
  // playedPack), so a resume, a reload or a retried turn never redraws.
  // From here on the pack is exactly as if the learner had picked the scene.
  let pack: PackInput = sent;
  let randomDraw: Record<string, unknown> | null = null;
  if (random) {
    const target = str(effectiveProfile(learnerProfile(ctx.learner, ctx.language), normalizePack(sent).overrides).target_language);
    const keep = typeof body.drawn === "string" && body.drawn.length <= 200 ? body.drawn : null;
    // Recent scenes always go in: a kept scene ignores them, but one no
    // longer in the pool falls through to a fresh draw that must avoid them.
    // The language's hidden scenes and collections are never drawn.
    const draw = drawOrRefuse(library, target, random, { recent: await recentScenes(ctx.language), keep, hidden: await hiddenSet(rawDb(), ctx.language) });
    pack = withDrawnScene(sent, draw.scene.id);
    randomDraw = { collections: random.collections, pool: draw.pool.map((s) => s.id), drawn: draw.scene.id, ...(draw.kept ? { kept: true } : {}) };
  }
  const scenarioId = typeof pack.scenario === "string" && pack.scenario ? pack.scenario : null;
  const scenario = scenarioId ? library.scenarios.find((s) => s.id === scenarioId) : undefined;
  // Revisit (docs/DATA.md §Revisit): a scene played before builds on its
  // last attempt with a finished recap (Practice again: the session it was
  // pressed on, when that is this scene and has one). What it carries is
  // frozen into the snapshot now, like the review: the briefing, the review
  // and the recap's comparison never change under a later edit or delete.
  const id = randomUUID();
  const key = sceneKey(pack, id) as string;
  const previous = typeof body.previous === "string" && CONVERSATION_ID_RE.test(body.previous) ? body.previous.toLowerCase() : null;
  // The session's languages, as the prompt sees them (the profile under the
  // pack's overrides, a moved target language dropping the profile's
  // variant), kept so History's locales never follow a later profile edit.
  const langs = effectiveProfile(learnerProfile(ctx.learner, ctx.language), normalizePack(pack).overrides);
  const prev = linkable(key) ? await previousAttempt(ctx.language, key, previous, str(langs.target_language)).catch((e) => {
    // The session goes on without it, as with an unreadable bank.
    console.error("[lingo-dojo] revisit: reading the last attempt failed; starting fresh:", e);
    return null;
  }) : null;
  const revisit = prev ? carryFrom(prev, mode) : null;
  const keptIds = (revisit?.kept ?? []).map((k: { phraseId: string | null }) => k.phraseId).filter((x: string | null): x is string => !!x);
  // The review block's phrases, chosen once for the whole session
  // (docs/DATA.md §Recall): every turn, the Go tab and the recap read these
  // ids back, so a star or a review mid-session doesn't change the list.
  // Not stored when the bank couldn't be read: the first turn chooses. The
  // last attempt's kept phrases come first.
  const review = await sessionReview(ctx.language, { ...library, profile: learnerProfile(ctx.learner, ctx.language) }, pack, mode, keptIds);
  const scenarioTitle = scenario?.title ?? null;
  const values = {
    id,
    // What was played, frozen: the pack changes later, and History shows
    // what this session was. With the review it was given (`review`), which
    // is as much a part of what was played as the units, for a random
    // scene the draw (`random_draw`: the pool's collections and scenario ids,
    // and the one drawn), the pack itself naming the drawn scenario, and
    // what it carried from its last attempt (`revisit`).
    packSnapshot: {
      ...(pack as unknown as Record<string, unknown>),
      ...(randomDraw ? { random_draw: randomDraw } : {}),
      ...(review ? { review } : {}),
      ...(revisit ? { revisit } : {}),
    },
    scenarioId,
    sceneKey: key,
    previousConversationId: prev?.id ?? null,
    // The Go tab names a random scene "Random scene" until it is drawn; the
    // conversation is named after the scene it got.
    title: conversationTitle({ title: random && body.title === RANDOM_SCENE_TITLE ? "" : body.title, pack, scenarioTitle }),
    mode,
    nativeLanguage: str(langs.native_language),
    targetLanguage: str(langs.target_language),
    targetVariant: str(langs.target_variant),
    model: (await readVoiceSettings(ctx.user.id)).model,
    plannedMinutes: readMinutes(pack.overrides?.minutes).minutes,
  };
  // The earlier attempt deleted since it was chosen (another tab): made
  // without the link, as the delete would have left it (revisit.ts lostPrevious).
  const [row] = await profileRows(ctx.language)
    .insert(conversations, values)
    .catch((e) => {
      if (!values.previousConversationId || !lostPrevious(e)) throw e;
      return profileRows(ctx.language).insert(conversations, { ...values, previousConversationId: null });
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
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const { limit, start } = readPage(params, { size: PAGE_SIZE, max: MAX_PAGE });
  // `scene`: one scene's sessions (History's expanded group).
  const scene = params.get("scene");
  if (scene != null && (!scene || scene.length > 200)) throw new HttpError(400, "scene must be a scene key");
  // One more than asked, to know whether there is a next page.
  const rows = await rawDb()
    .select({ c: conversations, lastTurnAt })
    .from(conversations)
    // Every row has its key (written at creation; 0008 filled the old ones),
    // so the plain column is compared and the scene index serves it.
    .where(profileRows(ctx.language).where(conversations, scene ? eq(conversations.sceneKey, scene) : undefined))
    .orderBy(desc(conversations.startedAt), desc(conversations.id))
    .limit(limit + 1)
    .offset(start);
  sendJson(res, 200, {
    conversations: rows.slice(0, limit).map((r) => summary(r.c, r.lastTurnAt)),
    nextOffset: rows.length > limit ? start + limit : null,
  } satisfies ConversationsReply);
}

/** History by scene: each scene once, the one played most recently first,
 *  with how many sessions it has and the latest of them. */
async function scenes(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const { limit, start } = readPage(new URL(req.url ?? "/", "http://localhost").searchParams, { size: PAGE_SIZE, max: MAX_PAGE });
  const mine = profileRows(ctx.language);
  const last = sql<Date>`max(${conversations.startedAt})`;
  const groups = await rawDb()
    .select({ key: SCENE, attempts: sql<number>`count(*)::int`, last })
    .from(conversations)
    .where(mine.where(conversations))
    .groupBy(SCENE)
    .orderBy(desc(last), SCENE)
    .limit(limit + 1)
    .offset(start);
  const page = groups.slice(0, limit);
  const keys = page.map((g) => g.key);
  // The latest session of each scene on the page, in one read.
  const latest = keys.length
    ? await rawDb()
        .selectDistinctOn([SCENE], { c: conversations, lastTurnAt })
        .from(conversations)
        .where(mine.where(conversations, inArray(conversations.sceneKey, keys)))
        .orderBy(SCENE, desc(conversations.startedAt), desc(conversations.id))
    : [];
  const byKey = new Map(latest.map((r) => [keyOf(r.c), r]));
  sendJson(res, 200, {
    scenes: page.flatMap((g) => {
      const r = byKey.get(g.key);
      return r ? [{ sceneKey: g.key, attempts: Number(g.attempts), latest: summary(r.c, r.lastTurnAt) }] : [];
    }),
    nextOffset: groups.length > limit ? start + limit : null,
  } satisfies ScenesReply);
}

/** A snapshot as a pack to play again: the server's own keys left out. */
function playablePack(snapshot: Record<string, unknown>): PackInput {
  const { review: _r, random_draw: _d, revisit: _v, ...pack } = snapshot ?? {};
  return pack as unknown as PackInput;
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
    pack: playablePack(conv.packSnapshot),
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
  if (parts.length === 1 && (parts[0] === "scenes" || parts[0] === "overview")) {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    await endIdle(ctx.user.id);
    return parts[0] === "scenes" ? scenes(req, res, ctx) : handleOverview(res, ctx);
  }
  const [id, action, ...rest] = parts;
  if (rest.length || (action !== undefined && action !== "end" && action !== "recap")) return sendJson(res, 404, { error: "no such route" });
  // A malformed id is no conversation of anyone's (and never reaches
  // Postgres, which would answer it with an error).
  if (!CONVERSATION_ID_RE.test(id)) throw new HttpError(404, "no such conversation", NO_CONVERSATION);
  if (action === "end") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return end(res, ctx, id.toLowerCase());
  }
  if (action === "recap") {
    await endIdle(ctx.user.id);
    return handleRecap(req, res, ctx, id.toLowerCase());
  }
  if (req.method === "GET") return get(req, res, ctx, id.toLowerCase());
  if (req.method === "DELETE") return remove(res, ctx, id.toLowerCase());
  methodNotAllowed(res, "GET, DELETE");
}
