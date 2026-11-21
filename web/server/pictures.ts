import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { failureHint, startClaude } from "../../scripts/claude.mjs";
import { languageProfileOwner } from "../../scripts/db/accounts.ts";
import type { LanguageProfileRef } from "../../scripts/db/owned.ts";
import {
  changePicture, markFailed, markReady, pictureById, pictureCallDone, pictureCallStarted, pictureCallsSince, pictureOf, pictureRows, storeVerdict, type PictureRow,
} from "../../scripts/db/pictures.ts";
import { EDITED, PracticeError, practiceCandidates, practiceCard, recordAnswer } from "../../scripts/db/practice.ts";
import { isUuid } from "../../scripts/phrases.mjs";
import { deletePicture, newPictureKey, readPicture, writePicture } from "../../scripts/picture-store.mjs";
import {
  JUDGE_BATCH, MIN_PICTURED, PICTURE_DAILY_IMAGES, PICTURE_DAILY_JUDGES, gameRounds, isCurrent, judgePrompt, parseJudgeReply, pictureBank, pictureKey, picturePrompt,
  pictureWork, readGameAnswer, roundChoices,
} from "../../scripts/pictures.mjs";
import { cardVersion, phraseRevision } from "../../scripts/practice.mjs";
import type { GameAnswerReply, GameStartReply, GameStatusReply, PhrasePicture, PhrasePictureReply, PictureStatus } from "../shared/game.ts";
import type { LearnerCtx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { ImageFailed, ImageRefused, imageProvider } from "./imageProvider.ts";
import { BackgroundBusy, backgroundSlot } from "./paid.ts";
import { audioProblem, phraseClip } from "./practice.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";

// The kids word game and its pictures (docs/DATA.md §Kids word game). A
// kids learner hears a word of the language they learn and taps the
// matching picture; each tap is a quiet review of the word's `listen` card
// (the same FSRS write adult Practice makes). The child sees stars and
// cheers, never a score.
//
//   GET  /api/game                          the pictures' status (no call starts)
//   POST /api/game/start                    a game's rounds from ready pictures; tops up missing ones in the background
//   POST /api/game/answer                   {phraseId, version, revision, submitId, pictureId, durationMs?, tz?} → {right, pictureId, replayed}
//   GET  /api/game/audio/:phraseId          the word said (Practice's phrase audio and its cache)
//   GET  /api/game/pictures/:id/:file       a picture (immutable: a redraw is a new file, so a new URL)
//
// The grown-up's side, from the Library's Phrase bank (never inside the
// game, where a child could press it):
//
//   GET  /api/pictures                      the status
//   POST /api/pictures/fill                 draw pictures for the words waiting (the backlog)
//   GET  /api/pictures/phrase/:id           a word's picture
//   POST /api/pictures/phrase/:id/remove    out of the game, file deleted
//   POST /api/pictures/phrase/:id/redraw    drawn again (same description)
//
// All mounted with wrap's `learner: true`, and for kids learners only: an
// adult learner's Practice is unchanged and has no game (a 403 here), and
// a kids learner's Practice routes stay a 403 (practice.ts).
//
// Pictures are made ahead of play, in the background, by one run per
// language profile at a time:
//  - triggers: a kids session's end (after its recap, extraction.ts, so its
//    words are in the bank), the grown-up's Draw pictures or Redraw, and a
//    game's start (a top-up: the game is built from ready pictures only and
//    never waits). Never a poll, a count or a page load;
//  - first the picturable check: one tool-less claude call (Haiku, the
//    graders' model) per JUDGE_BATCH words with no verdict for their words
//    and meaning as they are; the verdict is stored once (`none` words are
//    left out of the game);
//  - then one image per picturable word, newest words first, through the
//    image provider (imageProvider.ts) with a fixed style prompt and the
//    description as cleaned data; kept on disk (picture-store.mjs) and
//    never drawn again unless a grown-up asks;
//  - each call in the user's background paid slot (paid.ts, apart from
//    audio and transcription), entered in the ledger (picture_calls) as it
//    starts; at most PICTURE_DAILY_IMAGES images and PICTURE_DAILY_JUDGES
//    checks per language in any 24 hours, counted from the ledger (a
//    failure counts, a restart doesn't reset it). Words past the cap wait
//    for the next trigger after the window frees up;
//  - a refusal (the provider's moderation) is `failed`, never retried by
//    itself; any other failure (network, a limit, a bad key, the CLI)
//    stops the run, leaves the word pending and waits RETRY_AFTER_MS.

/** The picturable check: a yes/no and a short description per word. */
const JUDGE_MODEL = "claude-haiku-5-5";
const JUDGE_TIMEOUT_SEC = 90;
export const RETRY_AFTER_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** The run going on per language profile. */
const filling = new Map<string, Promise<void>>();
/** Per language profile: when a run may start again after a failure. */
const retryAt = new Map<string, number>();

/** Resolves when every run started so far has finished (the tests). */
export async function settlePictureFills(): Promise<void> {
  while (filling.size) await Promise.allSettled([...filling.values()]);
}

/** Forget the in-memory backoff (the tests: a restart). */
export function resetPictureMemory(): void {
  retryAt.clear();
}

const profileOf = (ctx: LearnerCtx): LanguageProfileRef => ({ id: ctx.language.id, learnerId: ctx.language.learnerId });
const since = () => new Date(Date.now() - DAY_MS);

/** What a run needs to know about the language it fills. */
interface FillTarget {
  profile: LanguageProfileRef;
  userId: string;
  targetLanguage: string;
  nativeLanguage: string;
}

const targetOf = (ctx: LearnerCtx): FillTarget => ({
  profile: profileOf(ctx),
  userId: ctx.user.id,
  targetLanguage: ctx.language.targetVariant || ctx.language.targetLanguage || "the target language",
  nativeLanguage: ctx.learner.nativeLanguage || "English",
});

/**
 * Start a background run that judges and draws this language's waiting
 * words, while today's caps last; unless one is already going, the last
 * one failed less than RETRY_AFTER_MS ago, or the provider can't draw (no
 * key: nothing is judged either, so no call is spent on words that can't
 * get a picture). Returns at once; whether a run started.
 */
export function fillPictures(t: FillTarget): boolean {
  const id = t.profile.id;
  if (filling.has(id) || (retryAt.get(id) ?? 0) > Date.now() || imageProvider().problem()) return false;
  const run = (async () => {
    // Each pass is one call: re-reading between them picks up an edit, a
    // removal or a redraw made meanwhile.
    for (;;) {
      const [phrases, rows] = await Promise.all([practiceCandidates(rawDb(), t.profile), pictureRows(rawDb(), t.profile)]);
      const work = pictureWork(phrases, rows);
      if (work.judge.length && (await pictureCallsSince(rawDb(), t.profile, "judge", since())) < PICTURE_DAILY_JUDGES) {
        if (!(await judge(t, work.judge.slice(0, JUDGE_BATCH)))) return;
        continue;
      }
      if (work.draw.length && (await pictureCallsSince(rawDb(), t.profile, "image", since())) < PICTURE_DAILY_IMAGES) {
        const p = work.draw[0];
        if (!(await draw(t, p.id, pictureKey(p), rows.get(p.id)!.description!))) return;
        continue;
      }
      if (work.judge.length || work.draw.length) console.log(`[lingo-dojo] pictures: today's calls for this language are used up; ${work.judge.length + work.draw.length} word(s) wait`);
      return;
    }
  })()
    .catch((e) => {
      retryAt.set(id, Date.now() + RETRY_AFTER_MS);
      console.error("[lingo-dojo] pictures: drawing stopped:", String((e as Error)?.message || e));
    })
    .finally(() => {
      if (filling.get(id) === run) filling.delete(id);
    });
  filling.set(id, run);
  return true;
}

/** One picturable check for `words`; false when the background slot was
 *  busy (the run stops; nothing was paid). Throws on a failed call. */
async function judge(t: FillTarget, words: { id: string; text: string | null; meaning: string | null }[]): Promise<boolean> {
  const sent = words.map((w) => ({ id: w.id, text: w.text ?? "", meaning: w.meaning, key: pictureKey(w) }));
  const { system, user } = judgePrompt({ words: sent, targetLanguage: t.targetLanguage, nativeLanguage: t.nativeLanguage });
  let callId = "";
  let text: string;
  try {
    text = await backgroundSlot(t.userId, async () => {
      // In the ledger before the model is asked: a call that then fails
      // was (or may have been) paid all the same.
      callId = await pictureCallStarted(rawDb(), t.profile, "judge", sent.length, since());
      const { result } = startClaude({ prompt: user, systemPrompt: system, model: JUDGE_MODEL, cwd: os.tmpdir(), tools: "none", maxTurns: 1, timeoutSec: JUDGE_TIMEOUT_SEC });
      return (await result).text;
    });
  } catch (e) {
    if (e instanceof BackgroundBusy) return false;
    if (callId) await pictureCallDone(rawDb(), t.profile, callId, "failed").catch(() => {});
    const msg = String((e as Error)?.message || e);
    throw new Error(`the picturable check failed: ${failureHint(msg) || msg}`);
  }
  const parsed = parseJudgeReply(text, sent.length);
  if (!parsed.ok) {
    await pictureCallDone(rawDb(), t.profile, callId, "failed").catch(() => {});
    throw new Error(`the picturable check's reply wasn't usable (${parsed.error})`);
  }
  let judged = 0;
  for (const [i, v] of parsed.verdicts.entries()) {
    // A word the reply left out stays unjudged: a later call asks again.
    if (!v) continue;
    const { oldFile } = await storeVerdict(rawDb(), t.profile, {
      phraseId: sent[i].id, phraseKey: sent[i].key, status: v.picturable ? "pending" : "none", description: v.description,
    });
    if (oldFile) deletePicture(oldFile);
    judged++;
  }
  await pictureCallDone(rawDb(), t.profile, callId, "ok").catch(() => {});
  console.log(`[lingo-dojo] pictures: ${judged} of ${sent.length} word(s) judged`);
  // Every word left out again would loop: the cap bounds it, but a reply
  // that judged nothing ends this run.
  return judged > 0;
}

/** One picture for a pending word; false when the slot was busy. A
 *  refusal marks the word failed and the run goes on; any other failure
 *  throws (the run stops and waits). */
async function draw(t: FillTarget, phraseId: string, phraseKey: string, description: string): Promise<boolean> {
  const provider = imageProvider();
  const prompt = picturePrompt(description);
  let callId = "";
  let got: { bytes: Buffer; type: string };
  try {
    got = await backgroundSlot(t.userId, async () => {
      callId = await pictureCallStarted(rawDb(), t.profile, "image", 1, since());
      return provider.draw(prompt);
    });
  } catch (e) {
    if (e instanceof BackgroundBusy) return false;
    if (e instanceof ImageRefused) {
      await markFailed(rawDb(), t.profile, phraseId, phraseKey);
      await pictureCallDone(rawDb(), t.profile, callId, "refused").catch(() => {});
      console.warn(`[lingo-dojo] pictures: ${provider.name} drew nothing for a word (${e.message}); it is left out`);
      return true;
    }
    if (callId) await pictureCallDone(rawDb(), t.profile, callId, "failed").catch(() => {});
    throw e instanceof ImageFailed ? e : new Error(String((e as Error)?.message || e));
  }
  const file = newPictureKey();
  writePicture(file, got.bytes, got.type);
  const row = await markReady(rawDb(), t.profile, phraseId, phraseKey, file, got.type);
  // Edited or removed while it was drawn: the picture is for nothing now.
  if (!row) deletePicture(file);
  await pictureCallDone(rawDb(), t.profile, callId, "ok").catch(() => {});
  return true;
}

/**
 * The end of a kids session (extraction.ts, after its recap: the session's
 * words are in the bank by then): draw pictures for that language's new
 * words in the background. Adults' sessions start nothing.
 */
export async function picturesAfterSession(profile: LanguageProfileRef): Promise<boolean> {
  const owner = await languageProfileOwner(rawDb(), profile);
  if (!owner || owner.mode !== "kids") return false;
  return fillPictures({ profile, userId: owner.userId, targetLanguage: owner.targetLanguage || "the target language", nativeLanguage: owner.nativeLanguage || "English" });
}

/** The status: counts from the rows and the ledger; starts nothing. */
async function statusOf(ctx: LearnerCtx): Promise<PictureStatus> {
  const profile = profileOf(ctx);
  const [phrases, rows, images, audio] = await Promise.all([
    practiceCandidates(rawDb(), profile),
    pictureRows(rawDb(), profile),
    pictureCallsSince(rawDb(), profile, "image", since()),
    audioProblem(ctx),
  ]);
  const pictured = pictureBank(phrases, rows).length;
  const work = pictureWork(phrases, rows);
  return {
    pictured,
    ready: pictured >= MIN_PICTURED,
    drawing: filling.has(profile.id),
    waiting: work.judge.length + work.draw.length,
    limited: images >= PICTURE_DAILY_IMAGES,
    problem: imageProvider().problem(),
    audio,
  };
}

/* ---------------------------------- the game --------------------------------- */

const op = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PracticeError) throw new HttpError(e.code === "ENOENT" ? 404 : 409, e.message);
    throw e;
  }
};

/** A game's rounds from the ready pictures only; a top-up of missing ones
 *  starts in the background (never waited for). */
async function start(ctx: LearnerCtx): Promise<GameStartReply> {
  const profile = profileOf(ctx);
  const [phrases, rows] = await Promise.all([practiceCandidates(rawDb(), profile), pictureRows(rawDb(), profile)]);
  const game = gameRounds(phrases, rows, { now: new Date() });
  fillPictures(targetOf(ctx));
  const byId = new Map([...rows.values()].map((r) => [r.id, r]));
  return {
    rounds: game.rounds.map((r) => ({
      phraseId: r.phraseId, version: r.version, revision: r.revision,
      choices: (r.choices ?? []).map((id) => ({ id, file: byId.get(id)!.file! })),
    })),
    status: await statusOf(ctx),
  };
}

const RIGHT = { rating: 3, verdict: "exact", note: null } as const;
const WRONG = { rating: 1, verdict: "wrong", note: null } as const;

/**
 * One tap: graded by the server against the round's own draw (made again
 * from the same seed and the pictures as they are), recorded as a review of
 * the word's listen card (mode `picture`) with the lock order, versions and
 * replay rules every practice answer has (scripts/db/practice.ts
 * recordAnswer). A tap on a picture the round never offered is a 409, as is
 * a stale card, an edited word or a picture changed since.
 */
async function answer(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const r = readGameAnswer(await readJsonBody(req));
  if (r.error !== undefined) throw new HttpError(400, r.error);
  const a = r.value;
  const profile = profileOf(ctx);
  const { phrase, card } = await op(() => practiceCard(rawDb(), profile, a.phraseId, "listen"));
  const stale = cardVersion(card ? { reps: card.reps, last_review: card.last_review } : null) !== a.version;
  if (!stale && phraseRevision(phrase) !== a.revision) throw new HttpError(409, EDITED);
  const [phrases, rows] = await Promise.all([practiceCandidates(rawDb(), profile), pictureRows(rawDb(), profile)]);
  const bank = pictureBank(phrases, rows);
  const own = bank.find((x) => x.phrase.id === phrase.id)?.picture ?? rows.get(phrase.id);
  let outcome: typeof RIGHT | typeof WRONG | null = null;
  let tappedText: string | null = null;
  if (!stale) {
    const self = phrases.find((p) => p.id === phrase.id);
    const offered = self ? roundChoices(self, bank, a.version) : null;
    if (!offered) throw new HttpError(409, "this word's picture changed since the round was shown; skip it");
    // The bank may have grown since the round was drawn (a picture made
    // meanwhile reshuffles it): a tap on any ready picture of this
    // language is graded (the right one is always offered); anything else
    // was never on offer.
    const tapped = bank.find((x) => x.picture.id === a.pictureId);
    if (!offered.includes(a.pictureId) && !tapped) throw new HttpError(409, "that picture isn't one this round offered; skip it");
    const right = a.pictureId === own!.id;
    outcome = right ? RIGHT : WRONG;
    tappedText = tapped?.phrase.text ?? null;
  }
  const out = await op(() =>
    recordAnswer(rawDb(), profile, {
      phraseId: a.phraseId, skill: "listen", drill: "picture", version: a.version, revision: a.revision, submitId: a.submitId,
      outcome: outcome as Parameters<typeof recordAnswer>[2]["outcome"], answer: tappedText, durationMs: a.durationMs, utcOffsetMinutes: a.utcOffsetMinutes,
      keepAlternate: false, targetLocale: "", cloze: null, now: new Date(),
    }),
  );
  if (!own) throw new HttpError(409, "this word has no picture now; skip it");
  sendJson(res, 200, { right: out.review.rating >= 3, pictureId: own.id, replayed: out.replayed } satisfies GameAnswerReply);
}

/** A picture's bytes, by its id and file: only this language's, only while
 *  ready with that file. Cached by the browser for a year (a redraw is a
 *  new file, so a new URL); Vary on the page's learner and language, which
 *  the fetch carries, so another learner on this browser never reads it
 *  from the cache. */
async function servePicture(res: ServerResponse, ctx: LearnerCtx, id: string, file: string): Promise<void> {
  const row = isUuid(id) ? await pictureById(rawDb(), profileOf(ctx), id.toLowerCase()) : undefined;
  if (!row || row.status !== "ready" || row.file !== file || !row.contentType) throw new HttpError(404, "no such picture");
  const bytes = readPicture(row.file, row.contentType);
  if (!bytes) throw new HttpError(404, "no such picture");
  res.writeHead(200, {
    "Content-Type": row.contentType,
    "Content-Length": bytes.length,
    "Cache-Control": "private, max-age=31536000, immutable",
    Vary: "Cookie, X-Learner-Id, X-Language-Profile-Id",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(bytes);
}

function kidsOnly(ctx: LearnerCtx): void {
  if (ctx.learner.mode !== "kids") throw new HttpError(403, "the word game is for kids learners");
}

/** /api/game, mounted with wrap's `learner: true`. */
export async function handleGame(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  kidsOnly(ctx);
  const parts = subPath(req).split("/").filter(Boolean);
  if (parts.length === 0) {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    return sendJson(res, 200, { status: await statusOf(ctx) } satisfies GameStatusReply);
  }
  if (parts.length === 1 && parts[0] === "start") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return sendJson(res, 200, (await start(ctx)) satisfies GameStartReply);
  }
  if (parts.length === 1 && parts[0] === "answer") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return answer(req, res, ctx);
  }
  if (parts.length === 2 && parts[0] === "audio") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const ctrl = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) ctrl.abort();
    };
    res.on("close", onClose);
    try {
      // Practice's phrase audio, its checks and its cache (404 for a
      // phrase this language can't practise).
      const out = await phraseClip(ctx, parts[1], ctrl.signal);
      res.writeHead(200, { "Content-Type": out.type, "Content-Length": out.audio.length, "Cache-Control": "private, no-store" });
      res.end(out.audio);
      return;
    } finally {
      res.off("close", onClose);
    }
  }
  if (parts.length === 3 && parts[0] === "pictures") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    return servePicture(res, ctx, parts[1], parts[2]);
  }
  sendJson(res, 404, { error: "no such route" });
}

/* ------------------------------- the grown-up ------------------------------- */

const pictureView = (row: PictureRow): PhrasePicture => ({ id: row.id, status: row.status, description: row.description, file: row.status === "ready" ? row.file : null });

/** /api/pictures, mounted with wrap's `learner: true`: the grown-up's
 *  side, from the Phrase bank of a kids learner. */
export async function handlePictures(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  kidsOnly(ctx);
  const parts = subPath(req).split("/").filter(Boolean);
  const profile = profileOf(ctx);
  if (parts.length === 0) {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    return sendJson(res, 200, { status: await statusOf(ctx) } satisfies GameStatusReply);
  }
  if (parts.length === 1 && parts[0] === "fill") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    const problem = imageProvider().problem();
    if (problem) throw new HttpError(400, problem);
    fillPictures(targetOf(ctx));
    return sendJson(res, 202, { status: await statusOf(ctx) } satisfies GameStatusReply);
  }
  if (parts[0] === "phrase" && (parts.length === 2 || parts.length === 3)) {
    if (!isUuid(parts[1])) throw new HttpError(404, "no such phrase");
    const phraseId = parts[1].toLowerCase();
    const { phrase } = await op(() => practiceCard(rawDb(), profile, phraseId, "listen"));
    if (parts.length === 2) {
      if (req.method !== "GET") return methodNotAllowed(res, "GET");
      const row = await pictureOf(rawDb(), profile, phraseId);
      return sendJson(res, 200, { picture: row && isCurrent(row, phrase) ? pictureView(row) : null, status: await statusOf(ctx) } satisfies PhrasePictureReply);
    }
    const action = parts[2];
    if (action !== "remove" && action !== "redraw") return sendJson(res, 404, { error: "no such route" });
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    if (action === "redraw") {
      const problem = imageProvider().problem();
      if (problem) throw new HttpError(400, problem);
    }
    const changed = await changePicture(rawDb(), profile, phraseId, pictureKey(phrase), action);
    if ("problem" in changed) {
      throw new HttpError(409, changed.problem === "state" ? `this picture can't be ${action === "remove" ? "removed" : "drawn again"} now` : "this word hasn't been judged for a picture yet");
    }
    if (changed.oldFile) deletePicture(changed.oldFile);
    // A grown-up's explicit redraw is a trigger (the same caps and ledger).
    if (action === "redraw") fillPictures(targetOf(ctx));
    return sendJson(res, 200, { picture: pictureView(changed.row), status: await statusOf(ctx) } satisfies PhrasePictureReply);
  }
  sendJson(res, 404, { error: "no such route" });
}
