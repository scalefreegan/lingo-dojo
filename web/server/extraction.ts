import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { asc, eq } from "drizzle-orm";
import { failureHint, startClaude } from "../../scripts/claude.mjs";
import { extractionPrompt, learnerSpoke, parseExtraction, sessionTranscript } from "../../scripts/extraction.mjs";
import { extractJsonObject } from "../../scripts/json-reply.mjs";
import { compareAttempts, lastTimeSection, parseLastTime, storedRevisit } from "../../scripts/revisit.mjs";
import { bankLocale, isUuid } from "../../scripts/phrases.mjs";
import { languageProfileOwner } from "../../scripts/db/accounts.ts";
import {
  applyExtraction, claimExtraction, countAttempt, dismissToneMiss, duePhrasesAt, finishExtraction, recapPhrases, type ExtractionStatus, type StoredRecap,
} from "../../scripts/db/extraction.ts";
import type { LanguageProfileRef } from "../../scripts/db/owned.ts";
import type { RecapReply, RecapStatus, SessionRecap } from "../shared/wire.ts";
import type { LearnerCtx } from "./auth.ts";
import { profileRows, rawDb, schema } from "./db.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson } from "./sse.ts";
import { getModel } from "./store.ts";
import { loadContent, modeRoot } from "../../scripts/content.mjs";
import { picturesAfterSession } from "./pictures.ts";
import { offeredReview } from "./recall.ts";
import { correctionsFor, judgeRecapReadings, logRecapReadings, settleRecapReadings, uncertainInTranscript } from "./readings.ts";
import { readsHints } from "./hints.ts";
import { sessionToneLines } from "./toneReview.ts";

// The post-session extraction (docs/DATA.md §Post-session extraction): when
// a conversation ends, one tool-less `claude -p` reads its transcript and
// returns a recap (summary, phrases to keep, how the learner did on each
// phrase, corrections); scripts/db/extraction.ts stores it and turns it into
// phrase-bank rows and FSRS session reviews.
//
//   GET  /api/conversations/:id/recap   → {recap}
//   POST /api/conversations/:id/recap   → 202 {recap}: make it (again): Retry recap
//   POST /api/conversations/:id/recap-tones {phraseId} → {recap}: I said it right
//
// Never in the way of End: the hook (conversations.ts onConversationEnded)
// only starts the run, which claims the conversation, calls the model and
// writes, all after End has answered. The model is tried twice; a second
// failure leaves the conversation 'failed', which the recap card offers to
// retry by hand. Nothing waits on a run but the tests (settleExtractions).

const { conversations, turns } = schema;
type Conversation = typeof conversations.$inferSelect;

/** One model call's limit. A recap is one JSON reply; two of these and the
 *  run gives up. */
const CALL_TIMEOUT_SEC = 180;
const TRIES = 2;

/** The claim tokens of the runs going on in this server, so a 'running'
 *  row whose run died with an earlier server can be told from a live one
 *  (one server process: DATA.md §Conversations, point 4). */
const live = new Set<string>();
/** The runs themselves, for the tests to wait on. */
const running = new Set<Promise<void>>();
/** The claim being made for a conversation, by id (start). */
const claiming = new Map<string, Promise<void>>();

/** Resolves when every run started so far has finished (the tests). */
export async function settleExtractions(): Promise<void> {
  while (running.size) await Promise.allSettled([...running]);
}

const refOf = (c: Pick<Conversation, "languageProfileId" | "learnerId">): LanguageProfileRef => ({ id: c.languageProfileId, learnerId: c.learnerId });

function track(p: Promise<void>): void {
  const done = p.catch((e) => console.error("[lingo-dojo] recap:", e)).finally(() => running.delete(done));
  running.add(done);
}

/** Claim the recap and, if this caller got it, run it in the background.
 *  `from`: the statuses the claim may take over. Resolves to whether it
 *  was claimed, once the claim is settled (not the run). */
async function start(profile: LanguageProfileRef, conversationId: string, from: ExtractionStatus[]): Promise<boolean> {
  // One claim at a time per conversation in this server: a claim may take
  // over a 'running' row whose token isn't live, so two claims at once
  // must not each see the other's token as dead. The database decides
  // between the claims; this only keeps `live` true while they do.
  const before = claiming.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const queued = before.then(() => mine);
  claiming.set(conversationId, queued);
  await before;
  const claim = randomUUID();
  live.add(claim);
  try {
    const claimed = await claimExtraction(rawDb(), profile, conversationId, { from, live: [...live], claim });
    if (!claimed) {
      live.delete(claim);
      return false;
    }
    track(
      run(profile, claimed.conversation, claim)
        .finally(() => live.delete(claim))
        // A session's words are in the bank now (its glosses, and the
        // recap's kept words): pictures for the word game are drawn ahead
        // of play, in the background, for kids and adult learners alike
        // (pictures.ts picturesAfterSession; ld-318), under the language's
        // daily cap. Resolves once the drawing run is started (or not),
        // not when it ends.
        .then(() => picturesAfterSession(profile).then(
          () => {},
          (e) => console.error("[lingo-dojo] pictures after a session:", e),
        )),
    );
    return true;
  } catch (e) {
    live.delete(claim);
    throw e;
  } finally {
    release();
    if (claiming.get(conversationId) === queued) claiming.delete(conversationId);
  }
}

/**
 * The end hook's half: a conversation just ended, so its recap is made, if
 * nobody has started one (a second End, a racing idle end or an earlier
 * Retry already did: the claim says so). Returns at once; the run happens
 * after the request that ended it.
 */
export function extractAfterEnd(conversation: Conversation): void {
  track(
    new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      await start(refOf(conversation), conversation.id, ["none"]);
    }),
  );
}

/**
 * Why a recap failed, as the learner reads it (`extraction_error`, the
 * card's text): fixed wording only. What went wrong in detail (a CLI's
 * stderr, a database error with its SQL and the recap's JSON) goes to the
 * server log, never to the row or the page.
 */
const REASON = {
  gone: "its learner or language is gone",
  call: "the model call didn't work",
  reply: "the reply wasn't a recap",
  none: "no reply",
  save: "the recap couldn't be saved",
} as const;
/** The CLI hints (scripts/claude.mjs failureHint) are fixed text too, and
 *  worth showing: a sign-in to renew, a limit to wait out. */
const HINTS = [/^Claude Code sign-in has expired/, /^Claude usage limit reached/, /^Claude API is overloaded/];
/** A stored reason, if it is one of ours (rows written before this rule may hold raw text). */
const shownReason = (s: string | null) => (s && (Object.values(REASON).includes(s as never) || HINTS.some((h) => h.test(s))) ? s : null);
/** The error and its cause (drizzle wraps the driver's), for the log. */
const detail = (e: unknown) => {
  const err = e as Error & { cause?: unknown };
  const cause = err?.cause as (Error & { code?: string }) | undefined;
  return `${String(err?.message || e)}${cause ? ` (cause: ${cause.code ? `${cause.code} ` : ""}${String(cause.message || cause)})` : ""}`;
};

/** One run, holding `claim`: the transcript, the model (twice at most),
 *  then the write; or 'skipped' / 'failed'. */
async function run(profile: LanguageProfileRef, conv: Conversation, claim: string): Promise<void> {
  const db = rawDb();
  const fail = (why: string, logged = why) => {
    console.error(`[lingo-dojo] recap of conversation ${conv.id} failed: ${logged}`);
    return finishExtraction(db, profile, conv.id, claim, "failed", why);
  };
  try {
    const rows = await profileRows(profile).list(turns, eq(turns.conversationId, conv.id), { orderBy: asc(turns.idx) });
    if (!learnerSpoke(rows)) return void (await finishExtraction(db, profile, conv.id, claim, "skipped"));
    const owner = await languageProfileOwner(db, profile);
    if (!owner) return void (await fail(REASON.gone));
    const locale = bankLocale(owner.targetLanguage, conv);
    // The phrases the session's review block offered (stored on the
    // conversation when it began: web/server/recall.ts), so the recap judges
    // the recycling it asked for, however the bank moved since (this
    // recap's own reviews, Practice, a star); the session reviews come from
    // its events as for any phrase. A pack without a recall unit offered
    // none: the phrases due then, as before.
    const offered = locale == null ? null : await offeredFor(profile, conv);
    // Built on an earlier attempt (docs/DATA.md §Revisit): the recap also
    // judges last time's corrections, and compares (adults; a kids revisit
    // carries no corrections, and storedRevisit says so).
    const revisit = storedRevisit(conv.packSnapshot);
    const lastTime = lastTimeSection(revisit);
    // Mandarin (ld-4i2, docs/VOICE.md §Uncertain readings): the dojo
    // master's words the reader couldn't settle for this learner, so the
    // recap reads them in context. None (or another language): the prompt
    // is exactly what it was.
    const zhLocale = locale && readsHints(locale) ? locale : null;
    const toRead = zhLocale ? uncertainInTranscript(rows, zhLocale, await correctionsFor(profile)) : [];
    const { system, user } = extractionPrompt({
      readings: toRead.map((w) => ({ word: w.word, sentence: w.sentence })),
      lastTime,
      transcript: sessionTranscript(rows),
      nativeLanguage: conv.nativeLanguage || owner.nativeLanguage || "English",
      targetVariant: conv.targetVariant || conv.targetLanguage || owner.targetLanguage || "the target language",
      duePhrases: offered ?? (locale == null ? [] : await duePhrasesAt(db, profile, new Date(conv.startedAt))),
      offered: offered != null,
      kids: conv.mode === "kids",
    });
    const model = await getModel(owner.userId);
    let why = "";
    let logged = "";
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      await countAttempt(db, profile, conv.id, claim);
      let text: string;
      try {
        // No tools and an empty temp cwd, like a voice turn: the transcript
        // is the learner's words, and the model needs nothing else.
        const { result } = startClaude({ prompt: user, systemPrompt: system, model, cwd: os.tmpdir(), tools: "none", maxTurns: 1, timeoutSec: CALL_TIMEOUT_SEC });
        text = (await result).text;
      } catch (e) {
        const msg = String((e as Error)?.message || e);
        why = failureHint(msg) || REASON.call;
        logged = msg;
        console.warn(`[lingo-dojo] recap of conversation ${conv.id}, attempt ${attempt}: ${msg}`);
        continue;
      }
      const parsed = parseExtraction(text);
      if (!parsed.ok) {
        why = REASON.reply;
        logged = `${REASON.reply} (${parsed.error})`;
        continue;
      }
      if (parsed.dropped) console.warn(`[lingo-dojo] recap of conversation ${conv.id}: ${parsed.dropped} malformed item(s) dropped`);
      const judged = parseLastTime(extractJsonObject(text)?.last_time, revisit?.corrections?.length ?? 0);
      const vsLast = compareAttempts(revisit, parsed.value.events, judged);
      // The readings it gave, each checked like a hint (nothing is written yet).
      const read = zhLocale ? judgeRecapReadings(toRead, extractJsonObject(text)?.readings, zhLocale) : null;
      // Mandarin, adults (ld-ne0.18): the session's tone flags that may fail
      // a bank phrase. No model call; a failure here costs the tone misses,
      // never the recap.
      const toneLines = zhLocale
        ? await sessionToneLines(profile, conv, zhLocale).catch((e) => {
            console.error(`[lingo-dojo] recap of conversation ${conv.id}: tones: ${detail(e)}`);
            return [];
          })
        : [];
      // null: the claim was taken over (this run was presumed dead); the
      // run that has it now writes.
      const stored = await applyExtraction(db, profile, { conversationId: conv.id, claim, value: parsed.value, dropped: parsed.dropped, bankLocale: locale, turns: rows, vsLast, readings: read?.judged, toneLines });
      if (stored && zhLocale && read) {
        logRecapReadings(conv.id, read.stats);
        // After the recap is stored (its kept phrases are in the bank): a
        // failure here is logged, never the recap's. A kids session's recap
        // settles the child's own marks and votes for nothing shared (a
        // kids learner corrects nothing by hand either).
        await settleRecapReadings(profile, conv.mode === "kids" ? null : owner.userId, conv.id, zhLocale, read.judged, rows, { kids: conv.mode === "kids" }).catch((e) => console.error(`[lingo-dojo] recap of conversation ${conv.id}: readings: ${detail(e)}`));
      }
      return;
    }
    await fail(why || REASON.none, logged || why || REASON.none);
  } catch (e) {
    await fail(REASON.save, `${REASON.save}: ${detail(e)}`).catch((e2) => console.error(`[lingo-dojo] recap of conversation ${conv.id}: the failure couldn't be stored: ${detail(e2)}`));
  }
}

/** The review block the conversation offered (recall.ts offeredReview),
 *  as the prompt lists it. Null when its pack had no recall unit. The
 *  session's own languages decide whether it was in the bank's (the caller
 *  checked bankLocale, as for its captures). */
async function offeredFor(profile: LanguageProfileRef, conv: Conversation): Promise<{ text: string; meaning?: string | null }[] | null> {
  const content = loadContent(modeRoot(conv.mode === "kids" ? "kids" : "adult"));
  const items = await offeredReview(profile, content, conv);
  return items && items.map((p) => ({ text: p.text, meaning: p.meaning }));
}

/* --------------------------------- reading --------------------------------- */

function statusOf(c: Conversation): RecapStatus {
  if (!c.endedAt) return "open";
  if (c.extractionStatus === "running") return c.extractionClaim && live.has(c.extractionClaim) ? "pending" : "failed";
  return c.extractionStatus;
}

/** The status History lists (ConversationSummary.recapStatus). */
export const recapStatus = statusOf;

async function recapOf(profile: LanguageProfileRef, c: Conversation): Promise<SessionRecap> {
  const status = statusOf(c);
  const stored = status === "done" ? (c.extraction as unknown as StoredRecap | null) : null;
  const ids = (stored?.keep ?? []).map((k) => k.phraseId).filter((id): id is string => !!id);
  const now = await recapPhrases(rawDb(), profile, ids);
  return {
    conversationId: c.id,
    status,
    kids: c.mode === "kids",
    summary: status === "done" ? c.summary : null,
    kept: (stored?.keep ?? []).map((k) => {
      const p = k.phraseId ? now.get(k.phraseId) : undefined;
      return { text: k.text, meaning: k.meaning, why: k.why, phraseId: p ? k.phraseId : null, starred: !!p?.starred, mastery: p?.mastery ?? null };
    }),
    events: stored?.events ?? [],
    corrections: stored?.corrections ?? [],
    inBank: !!stored?.inBank,
    error:
      status !== "failed"
        ? null
        : c.extractionStatus === "running"
          ? "the recap was interrupted (the server restarted)"
          : (shownReason(c.extractionError) ?? "the recap couldn't be made"),
    // Phrases a tone flag failed (ld-ne0.18): an adult's only.
    toneMisses:
      c.mode === "kids"
        ? []
        : (stored?.tones ?? [])
            .filter((t) => t.reviewed || (t.dismissed && !t.idle))
            .map(({ phraseId, phrase, line, syllables, dismissed }) => ({ phraseId, phrase, line, syllables, dismissed })),
    extractedAt: c.extractedAt ? new Date(c.extractedAt).toISOString() : null,
    // The earlier session's id only while it still exists (the link
    // column nulls on its delete); the comparison itself stays.
    vsLast: stored?.vsLast ? { ...stored.vsLast, from: c.previousConversationId } : null,
    // The words to check (ld-4i2): an adult's only (nothing of it is shown
    // to a child); the card shows each one the learner hasn't settled since.
    readings: c.mode === "kids" ? [] : (stored?.readings ?? []).filter((r) => r.verdict !== "agrees").map((r) => ({ word: r.word, sentence: r.sentence, at: r.at, suggested: r.verdict === "differs" })),
  };
}

async function find(ctx: LearnerCtx, id: string): Promise<Conversation> {
  const c = await profileRows(ctx.language).get(conversations, eq(conversations.id, id));
  if (!c) throw new HttpError(404, "no such conversation", "no_conversation");
  return c;
}

/** /api/conversations/:id/recap (mounted by conversations.ts, which has
 *  checked the id and the learner). */
export async function handleRecap(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx, id: string): Promise<void> {
  if (req.method === "GET") {
    const c = await find(ctx, id);
    return sendJson(res, 200, { recap: await recapOf(ctx.language, c) } satisfies RecapReply);
  }
  if (req.method !== "POST") return methodNotAllowed(res, "GET, POST");
  const c = await find(ctx, id);
  if (!c.endedAt) throw new HttpError(409, "the session is still going: its recap is made when it ends");
  // Anything but a run going on now: a failed one, one never made, one
  // skipped or made already (made again, replacing the last).
  await start(ctx.language, id, ["none", "failed", "done", "skipped"]);
  // Claimed by this request or by a run already going: either way it is
  // being made (or has just been, by a quick one).
  sendJson(res, 202, { recap: await recapOf(ctx.language, await find(ctx, id)) } satisfies RecapReply);
}

/** /api/conversations/:id/recap-tones: "I said it right" on a phrase the
 *  recap failed for a tone (ld-ne0.18). The grade changes back to what the
 *  recap would have given it; nothing in the request says what that is. */
export async function handleRecapTones(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx, id: string): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const body = await readJsonBody<{ phraseId?: unknown }>(req);
  if (!isUuid(body?.phraseId)) throw new HttpError(400, "phraseId must be a phrase's id");
  await find(ctx, id);
  const out = await dismissToneMiss(rawDb(), ctx.language, id, String(body.phraseId).toLowerCase());
  if (out === "none") throw new HttpError(404, "no tone miss for that phrase in this session");
  if (out === "busy") throw new HttpError(409, "the recap isn't finished; try again when it is");
  if (out === "later") throw new HttpError(409, "this phrase has been practised since, so its grade stays as it is");
  sendJson(res, 200, { recap: await recapOf(ctx.language, await find(ctx, id)) } satisfies RecapReply);
}
