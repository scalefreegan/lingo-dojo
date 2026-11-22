import fs from "node:fs";
import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { failureHint, startClaude } from "../../scripts/claude.mjs";
import { languageProfileOwner, listLearners } from "../../scripts/db/accounts.ts";
import type { LanguageProfileRef } from "../../scripts/db/owned.ts";
import {
  changePicture, drawAnyway, markFailed, markNone, markReady, pictureById, pictureCallDone, pictureCallStarted, pictureCallsSince, pictureFileInUse, pictureOf, pictureRows, requestRestyle,
  restyleDone, restyleDropped, restyleToDraw, restyleToStock, storeVerdict,
  type PictureRow, type StockPointer,
} from "../../scripts/db/pictures.ts";
import { EDITED, PracticeError, practiceCandidates, practiceCard, recordAnswer } from "../../scripts/db/practice.ts";
import { isUuid } from "../../scripts/phrases.mjs";
import { loadPictureStock } from "../../scripts/content.mjs";
import { deletePicture, newPictureKey, readPicture, readStockPicture, stockDir, stockPicture, stockVersion, writePicture } from "../../scripts/picture-store.mjs";
import { adultsOverrides, stockList } from "./stockPictures.ts";
import {
  JUDGE_BATCH, MIN_PICTURED, PICTURE_DAILY_IMAGES, PICTURE_DAILY_JUDGES, PICTURE_THEME, currentThemes, drawnTheme, gameRounds, grownUpDescription, isCurrent, judgePrompt, parseJudgeReply,
  pictureBank, pictureKey, picturePrompt, pictureWork, readGameAnswer, restyleTargets, roundChoices, mergeStock, stockForMode, stockKey,
} from "../../scripts/pictures.mjs";
import { cardVersion, phraseRevision } from "../../scripts/practice.mjs";
import type { GameAnswerReply, GameStartReply, GameStatusReply, PhrasePicture, PhrasePictureReply, PictureStatus, RestyleReply, WordPictureItem, WordPicturesReply } from "../shared/game.ts";
import { learnerMode, type LearnerCtx } from "./auth.ts";
import { rawDb } from "./db.ts";
import { ImageFailed, ImageRefused, imageProvider, type DrawnImage } from "./imageProvider.ts";
import { BackgroundBusy, backgroundSlotWhenFree, type SlotWait } from "./paid.ts";
import { audioNote, audioProblem, phraseClip } from "./practice.ts";
import { mandarinLocale, settledForKids } from "./readings.ts";
import { HttpError, methodNotAllowed, readJsonBody, sendJson, subPath } from "./sse.ts";

// The word game and its pictures (docs/DATA.md §Kids word game). A learner
// hears a word of the language they learn and taps the matching picture;
// each tap is a quiet review of the word's `listen` card (the same FSRS
// write adult Practice makes). A child sees stars and cheers, never a
// score; an adult plays it as Practice's Pictures mode (ld-318), and only
// an adult's answer reply names the word and its meaning.
//
//   GET  /api/game                          the pictures' status (no call starts)
//   POST /api/game/start                    a game's rounds from ready pictures; tops up missing ones in the background
//   POST /api/game/answer                   {phraseId, version, revision, submitId, pictureId, durationMs?, tz?} → {right, pictureId, replayed}
//   GET  /api/game/audio/:phraseId          the word said (Practice's phrase audio and its cache)
//   GET  /api/game/pictures/:id/:file       a picture (immutable: a redraw is a new file, so a new URL)
//
// The grown-up's side, from the Library's Phrase bank and the menu's
// Picture library (never inside the game, where a child could press it):
//
//   GET  /api/pictures                      the status
//   GET  /api/pictures/words                every current word picture of the language, newest first
//   POST /api/pictures/fill                 draw pictures for the words waiting (the backlog)
//   GET  /api/pictures/phrase/:id           a word's picture
//   POST /api/pictures/phrase/:id/remove    out of the game, file deleted
//   POST /api/pictures/phrase/:id/redraw    drawn again (same description)
//   POST /api/pictures/phrase/:id/draw      {description?}: a word judged "no clear picture" drawn anyway
//   POST /api/pictures/restyle              Redraw all in the current style (every picture not in PICTURE_THEME)
//
// All mounted with wrap's `learner: true`, for kids and adult learners
// alike; a kids learner's Practice routes stay a 403 (practice.ts). The
// kids menu has no Picture library, but these routes stay reachable by a
// kids learner's session (the Phrase bank uses them).
//
// Pictures are made ahead of play, in the background, by one run per
// language profile at a time:
//  - triggers: a session's end, kids or adult (after its recap, extraction.ts, so its
//    words are in the bank), the grown-up's Draw pictures or Redraw, and a
//    game's start (a top-up: the game is built from ready pictures only and
//    never waits). Never a poll, a count or a page load;
//  - first the picturable check: one tool-less claude call (Haiku, the
//    graders' model) per JUDGE_BATCH words with no verdict for their words
//    and meaning as they are; the verdict is stored once (`none` words are
//    left out of the game);
//    The check is offered the shared stock pictures drawn in the current
//    theme (content/pictures.yaml, picture-stock.mjs): a word it matches to
//    one is ready at once, pointing at that file, with no image call and
//    nothing in the image ledger;
//  - then one image per picturable word, newest words first, through the
//    image provider (imageProvider.ts) with the theme's style prompt and
//    the description as cleaned data; kept on disk (picture-store.mjs),
//    recorded with the theme it was drawn in, and never drawn again unless
//    a grown-up asks;
//  - then a grown-up's Redraw all in the current style, if one waits: each
//    picture not in the theme is matched to a stock picture if one fits
//    (one check per batch), else drawn again; its old picture stays in the
//    game until the new one is stored;
//  - each call in the user's background paid slot (paid.ts, apart from
//    audio and transcription), waited for while something else has it
//    (SLOT_WAIT, holding nothing meanwhile; past that the run stops and the
//    next trigger carries on), entered in the ledger (picture_calls) as it
//    starts, the cap counted again just before; at most PICTURE_DAILY_IMAGES images and PICTURE_DAILY_JUDGES
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
/** How long a call waits for the user's background slot (cloze writing has
 *  it, or another language's pictures) before the run stops: a couple of
 *  cloze calls' worth. Mutable for the tests. */
export const SLOT_WAIT: SlotWait = { maxMs: 120_000, everyMs: 2_000 };

/** The run going on per language profile. */
const filling = new Map<string, Promise<void>>();
/** Per language profile: when a run may start again after a failure. */
const retryAt = new Map<string, number>();
/** Per word (picture row and words): its failed draws in a row whose fault
 *  was the word's own (ImageFailed.perWord). In memory, not in the row or
 *  the ledger (no migration for it): a restart gives a word two more
 *  tries, which the daily cap still bounds. */
const wordFailures = new Map<string, number>();
/** After this many in a row, a word is given up like a refusal (`failed`;
 *  Draw again by hand still works), so one bad word doesn't stay first in
 *  the work list spending a ledger row every retry. */
export const PICTURE_WORD_FAILURES = 2;

/** Resolves when every run started so far has finished (the tests). */
export async function settlePictureFills(): Promise<void> {
  while (filling.size) await Promise.allSettled([...filling.values()]);
}

/** Forget the in-memory backoff (the tests: a restart). */
export function resetPictureMemory(what: "all" | "backoff" = "all"): void {
  retryAt.clear();
  // "backoff": only the 10-minute wait, as if it had passed (the tests of
  // a word failing twice in a row).
  if (what === "all") wordFailures.clear();
}

const profileOf = (ctx: LearnerCtx): LanguageProfileRef => ({ id: ctx.language.id, learnerId: ctx.language.learnerId });
const since = () => new Date(Date.now() - DAY_MS);

/** The words the game may play for this learner: the language's practice
 *  candidates, and for a kids learner of Mandarin only those whose every
 *  reading is settled (readings.ts settledForKids, ld-0mn): a word the
 *  reader is still guessing waits for the in-session check, the recap, the
 *  grown-up or an admin before a child hears and learns it. Pictures are
 *  still drawn for it meanwhile (the background work reads every word). */
async function gameCandidates(profile: LanguageProfileRef, mode: string, language: { targetLanguage: string; targetVariant: string }) {
  return settledForKids(profile, mode === "kids", mandarinLocale(language), await practiceCandidates(rawDb(), profile));
}

/** What a run needs to know about the language it fills. */
interface FillTarget {
  profile: LanguageProfileRef;
  userId: string;
  targetLanguage: string;
  nativeLanguage: string;
  /** The learner's mode: a kids learner is never offered an `adults` stock
   *  concept (pictures.mjs stockForMode). */
  mode: string;
}

const targetOf = (ctx: LearnerCtx): FillTarget => ({
  mode: ctx.learner.mode,
  profile: profileOf(ctx),
  userId: ctx.user.id,
  targetLanguage: ctx.language.targetVariant || ctx.language.targetLanguage || "the target language",
  nativeLanguage: ctx.learner.nativeLanguage || "English",
});

/* ---------------------------------- stock ---------------------------------- */

/** A stock concept as the check is offered it. */
type StockConcept = { id: string; description: string; words: string[]; group?: string; adults?: true };

/** The stock concepts drawn in the current theme that a learner of `mode`
 *  may be offered: the only ones the check sees (a concept with no file
 *  yet gets a drawing of its own; an `adults` one never reaches a kids
 *  learner, so it is never matched for one). The list is
 *  content/pictures.yaml's merged with the ones an admin added from the
 *  picture library page (stockPictures.ts, pictures.mjs mergeStock). Never
 *  throws: a broken list is no stock (logged), not a failed run. */
async function stockOffer(mode: string): Promise<StockConcept[]> {
  try {
    return stockForMode((await stockList()).filter((c) => c.drawn), mode);
  } catch (e) {
    console.warn("[lingo-dojo] pictures: the stock list couldn't be read:", String((e as Error)?.message || e));
    return [];
  }
}

/** Whether any stock picture is drawn in the current theme, read from the
 *  folder alone (no list, no database): the quick, synchronous guard that
 *  lets a run start with no image key. The run itself is offered only the
 *  listed concepts a learner of its mode may have (stockOffer). */
function anyStockDrawn(): boolean {
  try {
    return fs.readdirSync(stockDir(PICTURE_THEME.id)).some((f) => !f.startsWith("."));
  } catch {
    return false;
  }
}

/** Every stock concept by id (drawn or not), from the merged list
 *  (content/pictures.yaml and the ones added from the picture library), for
 *  the game's rules: its look-alike group and its adults flag. Never throws:
 *  a list that can't be read is the file's alone, and if that fails too,
 *  null (playable then shows a kids learner no stock picture at all). */
async function stockById(): Promise<Map<string, StockConcept> | null> {
  try {
    return new Map((await stockList()).map((c) => [c.id, c as StockConcept]));
  } catch {
    try {
      // With the admin's Adults only settings still laid over the file's.
      return new Map(mergeStock(loadPictureStock().concepts, [], await adultsOverrides()).concepts.map((c) => [c.id, c as StockConcept]));
    } catch {
      return null;
    }
  }
}

/** Where a word matched to stock concept `id` points, if its file is
 *  drawn in the current theme; null otherwise (the word is drawn instead). */
function stockPointer(id: string): StockPointer | null {
  const at = stockPicture(PICTURE_THEME.id, id);
  return at ? { stockId: id, theme: PICTURE_THEME.id, file: stockKey(PICTURE_THEME.id, id), contentType: at.type } : null;
}

/** The rows as the game sees them for a learner of `mode`:
 *  - a word pointing at a stock picture whose file isn't on disk (removed,
 *    or another theme's never drawn here) has no picture to show, so it
 *    leaves the game (and the round's draw) until the file is there;
 *  - for a kids learner, a word pointing at an `adults` concept leaves it
 *    too (one matched before the flag was set), whether the concept is
 *    pictures.yaml's or added from the picture library; and so does one
 *    whose concept is gone or unknown (deleted, or the list unreadable):
 *    for a child, a stock picture nobody can vouch for isn't shown;
 *  - a stock row carries its concept's look-alike `group`, so a round
 *    never offers two of one (pictures.mjs roundChoices).
 *  The background work reads the rows as they are. */
async function playable(rows: Map<string, PictureRow>, mode: string): Promise<Map<string, PictureRow & { group?: string | null }>> {
  const concepts = await stockById();
  const out = new Map<string, PictureRow & { group?: string | null }>();
  for (const [k, r] of rows) {
    if (r.status === "ready" && r.stockId) {
      const c = concepts?.get(r.stockId);
      if (!r.theme || !stockPicture(r.theme, r.stockId)) continue;
      if (mode === "kids" && (!c || c.adults)) continue;
      out.set(k, c?.group ? { ...r, group: c.group } : r);
    } else out.set(k, r);
  }
  return out;
}

/** A ready picture's file as its URL names it: a word's own file key, or
 *  for a stock picture the stock key and the file's version (picture-store
 *  stockVersion), so a stock picture drawn again in the same theme gets a
 *  new URL instead of the browser's year-old cached copy. */
function pictureRef(row: PictureRow): string | null {
  if (row.status !== "ready" || !row.file) return null;
  if (!row.stockId || !row.theme) return row.file;
  const v = stockVersion(row.theme, row.stockId);
  return v ? `${row.file}.${v}` : row.file;
}

/* ---------------------------------- the run --------------------------------- */

/**
 * Start a background run that judges and draws this language's waiting
 * words, while today's caps last; unless one is already going, the last
 * one failed less than RETRY_AFTER_MS ago, or nothing can come of it: no
 * image key and no stock picture drawn (nothing is judged then, so no call
 * is spent on words that can't get a picture). With no key but some stock,
 * the check runs and only stock matches get pictures; the rest wait for a
 * key. Returns at once; whether a run started.
 */
export function fillPictures(t: FillTarget): boolean {
  const id = t.profile.id;
  if (filling.has(id) || (retryAt.get(id) ?? 0) > Date.now()) return false;
  if (imageProvider().problem() && !anyStockDrawn()) return false;
  const run = (async () => {
    // Every learner name on the account (archived ones too), read once a
    // run: no word of one goes to the check's description or the image
    // provider (pictures.mjs cleanDescription).
    const names = (await listLearners(rawDb(), t.userId, { archived: true })).map((l) => l.name);
    // Each pass is one call: re-reading between them picks up an edit, a
    // removal, a redraw or a key added meanwhile.
    for (;;) {
      const [phrases, rows] = await Promise.all([practiceCandidates(rawDb(), t.profile), pictureRows(rawDb(), t.profile)]);
      const work = pictureWork(phrases, rows);
      const canDraw = !imageProvider().problem();
      const offer = await stockOffer(t.mode);
      const judgeRoom = (await pictureCallsSince(rawDb(), t.profile, "judge", since())) < PICTURE_DAILY_JUDGES;
      if (work.judge.length && judgeRoom && (canDraw || offer.length)) {
        if (!(await judge(t, work.judge.slice(0, JUDGE_BATCH), names, offer))) return;
        continue;
      }
      if (work.restyleCheck.length && (judgeRoom || !offer.length)) {
        if (!(await restyleCheck(t, work.restyleCheck.slice(0, JUDGE_BATCH), names, offer, canDraw))) return;
        continue;
      }
      const imageRoom = (await pictureCallsSince(rawDb(), t.profile, "image", since())) < PICTURE_DAILY_IMAGES;
      if (canDraw && imageRoom && work.draw.length) {
        const p = work.draw[0];
        if (!(await draw(t, p.id, pictureKey(p), rows.get(p.id)!.description!, names))) return;
        continue;
      }
      if (canDraw && imageRoom && work.restyleDraw.length) {
        const p = work.restyleDraw[0];
        if (!(await draw(t, p.id, pictureKey(p), rows.get(p.id)!.description!, names, true))) return;
        continue;
      }
      const left = work.judge.length + work.draw.length + work.restyleCheck.length + work.restyleDraw.length;
      if (left) console.log(`[lingo-dojo] pictures: ${canDraw ? "today's calls for this language are used up" : "no image key"}; ${left} word(s) wait`);
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

/** Told apart from a call's own reply: the day's cap was reached while the
 *  call waited for its slot, so it wasn't made (nothing paid, no ledger
 *  row). The run's next pass sees the cap and ends. */
const CAPPED = Symbol("capped");

/**
 * Delete a picture's file from disk once no row names it (ld-0dl): after a
 * removal, a redraw, a new verdict for edited words, or its phrase's
 * delete. Kept while any row still uses the key, or when that can't be
 * asked (a file left behind is a small leak; a picture deleted under a
 * live row is a paid image lost). Never throws: no caller should fail over
 * a file. A missing file is fine, and nothing outside the pictures
 * directory is ever touched (picture-store.mjs deletePicture), nor any
 * stock picture: the callers pass only a word's own file, and a stock
 * picture is never a file named by a key (picture-store.mjs).
 */
export async function dropPictureFile(file: string | null | undefined): Promise<void> {
  if (!file) return;
  try {
    if (await pictureFileInUse(rawDb(), file)) return;
    deletePicture(file);
  } catch (e) {
    console.warn("[lingo-dojo] pictures: a picture file wasn't deleted:", String((e as Error)?.message || e));
  }
}

type Word = { id: string; text: string | null; meaning: string | null };

/**
 * One picturable check call for `words` in the background slot, with the
 * ledger and the cap: the verdicts, or false when the slot stayed busy past
 * SLOT_WAIT (nothing paid), or CAPPED. Throws on a failed call or an
 * unusable reply (the ledger row says so).
 */
async function askCheck(t: FillTarget, sent: (Word & { key: string })[], names: string[], offer: StockConcept[]) {
  const { system, user } = judgePrompt({ words: sent.map((w) => ({ text: w.text ?? "", meaning: w.meaning })), targetLanguage: t.targetLanguage, nativeLanguage: t.nativeLanguage, stock: offer });
  let callId = "";
  let text: string | typeof CAPPED;
  try {
    text = await backgroundSlotWhenFree(t.userId, async () => {
      // Counted again here: the wait for the slot may have been long.
      if ((await pictureCallsSince(rawDb(), t.profile, "judge", since())) >= PICTURE_DAILY_JUDGES) return CAPPED;
      // In the ledger before the model is asked: a call that then fails
      // was (or may have been) paid all the same.
      callId = await pictureCallStarted(rawDb(), t.profile, "judge", sent.length, since());
      const { result } = startClaude({ prompt: user, systemPrompt: system, model: JUDGE_MODEL, cwd: os.tmpdir(), tools: "none", maxTurns: 1, timeoutSec: JUDGE_TIMEOUT_SEC });
      return (await result).text;
    }, SLOT_WAIT);
  } catch (e) {
    if (e instanceof BackgroundBusy) return false;
    if (callId) await pictureCallDone(rawDb(), t.profile, callId, "failed").catch(() => {});
    const msg = String((e as Error)?.message || e);
    throw new Error(`the picturable check failed: ${failureHint(msg) || msg}`);
  }
  if (text === CAPPED) return CAPPED;
  const parsed = parseJudgeReply(text, sent.length, names, offer);
  if (!parsed.ok) {
    await pictureCallDone(rawDb(), t.profile, callId, "failed").catch(() => {});
    throw new Error(`the picturable check's reply wasn't usable (${parsed.error})`);
  }
  await pictureCallDone(rawDb(), t.profile, callId, "ok").catch(() => {});
  return parsed.verdicts as ({ picturable: boolean; description: string | null; stock: string | null } | undefined)[];
}

/** One picturable check for words with no verdict; false when the
 *  background slot stayed busy past SLOT_WAIT (the run stops; nothing was
 *  paid). A word matched to a drawn stock picture is ready at once (no
 *  image call, no image in the ledger). Throws on a failed call. */
async function judge(t: FillTarget, words: Word[], names: string[], offer: StockConcept[]): Promise<boolean> {
  const sent = words.map((w) => ({ ...w, key: pictureKey(w) }));
  const verdicts = await askCheck(t, sent, names, offer);
  if (verdicts === false) return false;
  if (verdicts === CAPPED) return true;
  let judged = 0;
  let stocked = 0;
  for (const [i, v] of verdicts.entries()) {
    // A word the reply left out stays unjudged: a later call asks again.
    if (!v) continue;
    // A stock match whose file has gone since the offer is drawn instead.
    const stock = v.stock ? stockPointer(v.stock) : null;
    const { oldFile } = await storeVerdict(rawDb(), t.profile, {
      phraseId: sent[i].id, phraseKey: sent[i].key, status: stock ? "ready" : v.picturable ? "pending" : "none", description: v.description, ...(stock ? { stock } : {}),
    });
    await dropPictureFile(oldFile);
    judged++;
    if (stock) stocked++;
  }
  console.log(`[lingo-dojo] pictures: ${judged} of ${sent.length} word(s) judged, ${stocked} from the stock pictures`);
  // Every word left out again would loop: the cap bounds it, but a reply
  // that judged nothing ends this run.
  return judged > 0;
}

/**
 * Redraw all in the current style, first step: words waiting with
 * `restyle: check` are asked about against the stock pictures drawn now (one
 * check call, on the judge ledger). A match points the word at the stock
 * picture (no image call; its own old file is deleted); anything else is
 * drawn again (`restyle: draw`). With no stock drawn there is nothing to
 * ask: all go to drawing, with no call.
 */
async function restyleCheck(t: FillTarget, words: Word[], names: string[], offer: StockConcept[], canDraw: boolean): Promise<boolean> {
  const sent = words.map((w) => ({ ...w, key: pictureKey(w) }));
  const verdicts = offer.length ? await askCheck(t, sent, names, offer) : sent.map(() => undefined);
  if (verdicts === false) return false;
  if (verdicts === CAPPED) return true;
  let answered = 0;
  for (const [i, v] of verdicts.entries()) {
    if (offer.length && !v) continue;
    answered++;
    const stock = v?.stock ? stockPointer(v.stock) : null;
    if (stock) {
      const done = await restyleToStock(rawDb(), t.profile, sent[i].id, sent[i].key, stock);
      await dropPictureFile(done?.oldFile);
    } else if (canDraw) {
      await restyleToDraw(rawDb(), t.profile, sent[i].id, sent[i].key);
    } else {
      // No stock picture fits and nothing can draw one: not left waiting
      // for ever. It keeps its picture, stays counted as out of the theme,
      // and the status says how many need a key (needKey).
      await restyleDropped(rawDb(), t.profile, sent[i].id, sent[i].key, "check");
    }
  }
  return answered > 0;
}

/**
 * One picture for a word: a pending one (`restyle` false), or a ready one
 * waiting to be drawn again in the theme (`restyle` true: its old picture
 * stays in the game until the new one is stored). False when the slot
 * stayed busy. A refusal leaves a pending word failed (a restyled one keeps
 * its picture) and the run goes on; any other failure throws (the run
 * stops and waits).
 */
async function draw(t: FillTarget, phraseId: string, phraseKey: string, description: string, names: string[], restyle = false): Promise<boolean> {
  const provider = imageProvider();
  const prompt = picturePrompt(description, names);
  if (!prompt) {
    // Nothing left once the names are out (a learner added since the
    // check, say): no call, and the word gets no picture.
    if (restyle) await restyleDropped(rawDb(), t.profile, phraseId, phraseKey);
    else await markNone(rawDb(), t.profile, phraseId, phraseKey);
    console.log("[lingo-dojo] pictures: a word's description had nothing left to draw; it is left out");
    return true;
  }
  let callId = "";
  const failKey = `${phraseId}:${phraseKey}:${restyle ? "restyle" : "draw"}`;
  let got: DrawnImage | typeof CAPPED;
  try {
    got = await backgroundSlotWhenFree(t.userId, async () => {
      // Counted again here: the wait for the slot may have been long, and
      // the cap is never passed.
      if ((await pictureCallsSince(rawDb(), t.profile, "image", since())) >= PICTURE_DAILY_IMAGES) return CAPPED;
      callId = await pictureCallStarted(rawDb(), t.profile, "image", 1, since());
      return provider.draw(prompt);
    }, SLOT_WAIT);
  } catch (e) {
    if (e instanceof BackgroundBusy) return false;
    if (e instanceof ImageRefused) {
      if (restyle) await restyleDropped(rawDb(), t.profile, phraseId, phraseKey);
      else await markFailed(rawDb(), t.profile, phraseId, phraseKey);
      await pictureCallDone(rawDb(), t.profile, callId, "refused").catch(() => {});
      console.warn(`[lingo-dojo] pictures: ${provider.name} drew nothing for a word (${e.message}); ${restyle ? "it keeps its old picture" : "it is left out"}`);
      return true;
    }
    if (callId) await pictureCallDone(rawDb(), t.profile, callId, "failed").catch(() => {});
    if (e instanceof ImageFailed && e.perWord) {
      // The word's own failure (a task that ended with no picture): after
      // PICTURE_WORD_FAILURES in a row it is given up like a refusal and
      // the run goes on; before that, the run stops and waits as usual.
      const n = (wordFailures.get(failKey) ?? 0) + 1;
      if (n >= PICTURE_WORD_FAILURES) {
        wordFailures.delete(failKey);
        if (restyle) await restyleDropped(rawDb(), t.profile, phraseId, phraseKey);
        else await markFailed(rawDb(), t.profile, phraseId, phraseKey);
        console.warn(`[lingo-dojo] pictures: ${provider.name} failed ${n} times in a row on a word (${e.message}); ${restyle ? "it keeps its old picture" : "it is left out"}`);
        return true;
      }
      wordFailures.set(failKey, n);
    }
    throw e instanceof ImageFailed ? e : new Error(String((e as Error)?.message || e));
  }
  wordFailures.delete(failKey);
  if (got === CAPPED) return true;
  const file = newPictureKey();
  writePicture(file, got.bytes, got.type);
  const theme = drawnTheme(provider.key);
  if (restyle) {
    const done = await restyleDone(rawDb(), t.profile, phraseId, phraseKey, { file, contentType: got.type, theme });
    // Edited or removed while it was drawn: the new picture is for nothing.
    if (!done) await dropPictureFile(file);
    else await dropPictureFile(done.oldFile);
  } else {
    const row = await markReady(rawDb(), t.profile, phraseId, phraseKey, file, got.type, theme);
    // Edited or removed while it was drawn: the picture is for nothing now.
    if (!row) await dropPictureFile(file);
  }
  await pictureCallDone(rawDb(), t.profile, callId, "ok").catch(() => {});
  return true;
}

/**
 * The end of a session (extraction.ts, after its recap: the session's
 * words are in the bank by then): draw pictures for that language's new
 * words in the background. Kids and adults alike (ld-318: adults have the
 * picture game too), under the same per-language ledger and cap.
 */
export async function picturesAfterSession(profile: LanguageProfileRef): Promise<boolean> {
  const owner = await languageProfileOwner(rawDb(), profile);
  if (!owner) return false;
  return fillPictures({ mode: owner.mode, profile, userId: owner.userId, targetLanguage: owner.targetLanguage || "the target language", nativeLanguage: owner.nativeLanguage || "English" });
}

/** Ids of the words the game has a picture for, for a learner of `mode`:
 *  exactly what the status line counts (`pictured`), so the Phrase bank's
 *  With picture chip and the line always agree. Reads the rows once and
 *  stats one stock file per stock-picture row (playable), the same as the
 *  status line does on every poll. */
export async function pictureWordIds(profile: LanguageProfileRef, mode: string, language: { targetLanguage: string; targetVariant: string }): Promise<Set<string>> {
  const [phrases, rows] = await Promise.all([gameCandidates(profile, mode, language), pictureRows(rawDb(), profile)]);
  return new Set(pictureBank(phrases, await playable(rows, mode)).map((x: { phrase: { id: string } }) => x.phrase.id));
}

/** The status: counts from the rows and the ledger; starts nothing. The
 *  key problem is shown only when a word needs a real drawing (one to
 *  draw, or words to judge with no stock picture to match them to). */
async function statusOf(ctx: LearnerCtx): Promise<PictureStatus> {
  const profile = profileOf(ctx);
  const [all, rows, images, audio] = await Promise.all([
    practiceCandidates(rawDb(), profile),
    pictureRows(rawDb(), profile),
    pictureCallsSince(rawDb(), profile, "image", since()),
    audioProblem(ctx),
  ]);
  // As gameCandidates: a kids word still uncertain is held back (counted, so
  // the grown-up is told why the game may be short of words).
  const phrases = await settledForKids(profile, ctx.learner.mode === "kids", mandarinLocale(ctx.language), all);
  const note = audio ? null : await audioNote(ctx);
  const pictured = pictureBank(phrases, await playable(rows, ctx.learner.mode)).length;
  const work = pictureWork(phrases, rows);
  const provider = imageProvider();
  const stock = (await stockOffer(ctx.learner.mode)).length;
  const outOfTheme = restyleTargets(phrases, rows, currentThemes(provider.key)).length;
  const restyling = work.restyleCheck.length + work.restyleDraw.length;
  const needsDraw = work.draw.length > 0 || work.restyleDraw.length > 0 || (work.judge.length > 0 && !stock);
  return {
    pictured,
    ready: pictured >= MIN_PICTURED,
    drawing: filling.has(profile.id),
    waiting: work.judge.length + work.draw.length,
    limited: images >= PICTURE_DAILY_IMAGES,
    problem: needsDraw ? provider.problem() : null,
    audio,
    audioNote: note,
    theme: PICTURE_THEME.id,
    stock,
    outOfTheme,
    restyling,
    // Out of the theme, with no stock picture fitting (or none asked yet)
    // and no image key to redraw them: Redraw all can't finish these.
    needKey: provider.problem() && !restyling ? outOfTheme : 0,
    imagesToday: images,
    imagesCap: PICTURE_DAILY_IMAGES,
    heldForReading: all.length - phrases.length,
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
  const [phrases, all] = await Promise.all([gameCandidates(profile, ctx.learner.mode, ctx.language), pictureRows(rawDb(), profile)]);
  const rows = await playable(all, ctx.learner.mode);
  const game = gameRounds(phrases, rows, { now: new Date() });
  fillPictures(targetOf(ctx));
  const byId = new Map([...rows.values()].map((r) => [r.id, r]));
  return {
    rounds: game.rounds.map((r) => ({
      phraseId: r.phraseId, version: r.version, revision: r.revision,
      choices: (r.choices ?? []).map((id) => ({ id, file: pictureRef(byId.get(id)!)! })),
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
  const [phrases, all] = await Promise.all([gameCandidates(profile, ctx.learner.mode, ctx.language), pictureRows(rawDb(), profile)]);
  const rows = await playable(all, ctx.learner.mode);
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
  // An adult sees the word and its meaning after the tap, like the other
  // adult drills' answers; a child's game never shows text (ld-318).
  const word = learnerMode(req, ctx) === "adult" ? { word: { text: phrase.text ?? "", meaning: phrase.meaning ?? null, ...(phrase.reading ? { reading: phrase.reading } : {}) } } : {};
  sendJson(res, 200, { right: out.review.rating >= 3, pictureId: own.id, replayed: out.replayed, ...word } satisfies GameAnswerReply);
}

/** A picture's bytes, by its id and file: only this language's, only while
 *  ready with that file. Cached by the browser for a year (a redraw is a
 *  new file, so a new URL); Vary on the page's learner and language, which
 *  the fetch carries, so another learner on this browser never reads it
 *  from the cache. */
async function servePicture(res: ServerResponse, ctx: LearnerCtx, id: string, file: string): Promise<void> {
  const row = isUuid(id) ? await pictureById(rawDb(), profileOf(ctx), id.toLowerCase()) : undefined;
  if (!row || row.status !== "ready" || pictureRef(row) !== file || !row.contentType) throw new HttpError(404, "no such picture");
  // A word's own file, or the shared stock picture it points at (by the
  // row: the same owner check, the same headers; the URL's file is the
  // stock key and the file's version, so another theme's picture, or one
  // drawn again, is another URL).
  const pic = row.stockId && row.theme ? readStockPicture(row.theme, row.stockId) : (() => {
    const bytes = readPicture(row.file!, row.contentType!);
    return bytes ? { bytes, type: row.contentType! } : null;
  })();
  if (!pic) throw new HttpError(404, "no such picture");
  // Immutable for a stock picture too: a stock redraw from the picture
  // library (ld-318) changes the file's version, so the URL (pictureRef).
  res.writeHead(200, {
    "Content-Type": pic.type,
    "Content-Length": pic.bytes.length,
    "Cache-Control": "private, max-age=31536000, immutable",
    Vary: "Cookie, X-Learner-Id, X-Language-Profile-Id",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(pic.bytes);
}

/** /api/game, mounted with wrap's `learner: true`: kids and adult learners
 *  alike (ld-318; a kids learner's adult drills stay a 403 in practice.ts). */
export async function handleGame(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
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

/**
 * Redraw all in the current style: every ready picture of this language not
 * in PICTURE_THEME (a word's own drawn before themes or by another
 * provider, or another theme's stock picture) is brought into it. A word
 * already pointing at a stock concept drawn in the theme is re-pointed at
 * once (no call); the rest wait for the background run: `check` when stock
 * pictures exist (the check may match one: no image call), else `draw`.
 * The old pictures stay in the game until each new one is stored, so a
 * child never meets a gap. Drawing counts against the daily ledger and
 * cap; what is past the cap waits for the next trigger.
 */
async function restyleAll(ctx: LearnerCtx): Promise<RestyleReply> {
  const profile = profileOf(ctx);
  const provider = imageProvider();
  const offer = await stockOffer(ctx.learner.mode);
  if (provider.problem() && !offer.length) throw new HttpError(400, provider.problem()!);
  const [phrases, rows] = await Promise.all([practiceCandidates(rawDb(), profile), pictureRows(rawDb(), profile)]);
  const targets = restyleTargets(phrases, rows, currentThemes(provider.key));
  let moved = 0;
  const check: string[] = [];
  for (const row of targets) {
    const pointer = row.stockId ? stockPointer(row.stockId) : null;
    if (pointer) {
      // Another theme's stock picture of a concept drawn in this one.
      await requestRestyle(rawDb(), profile, [row.id], "check");
      const done = await restyleToStock(rawDb(), profile, row.phraseId, row.phraseKey, pointer);
      if (done) moved++;
    } else check.push(row.id);
  }
  const waiting = await requestRestyle(rawDb(), profile, check, offer.length ? "check" : "draw");
  if (waiting) fillPictures(targetOf(ctx));
  return { restyled: moved + waiting, status: await statusOf(ctx) };
}

const pictureView = (row: PictureRow): PhrasePicture => ({
  id: row.id, status: row.status, description: row.description, file: pictureRef(row),
  stock: !!row.stockId, inTheme: row.status === "ready" && currentThemes(imageProvider().key).has(row.theme ?? ""), restyling: !!row.restyle,
});

/** /api/pictures, mounted with wrap's `learner: true`: the managing side,
 *  from the Phrase bank (a kids learner's grown-up, or an adult learner
 *  for their own words) and the picture library page's "My word
 *  pictures". Kids and adult learners alike (ld-318). */
export async function handlePictures(req: IncomingMessage, res: ServerResponse, ctx: LearnerCtx): Promise<void> {
  const parts = subPath(req).split("/").filter(Boolean);
  const profile = profileOf(ctx);
  if (parts.length === 0) {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    return sendJson(res, 200, { status: await statusOf(ctx) } satisfies GameStatusReply);
  }
  if (parts.length === 1 && parts[0] === "words") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    // Every word of this language (practisable: with words and a meaning,
    // not suspended) with a verdict or a picture for its words as they are
    // now; newest first. Reads only.
    const [phrases, rows] = await Promise.all([practiceCandidates(rawDb(), profile), pictureRows(rawDb(), profile)]);
    const words: WordPictureItem[] = [];
    for (const p of [...phrases].sort((a, b) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0))) {
      const row = rows.get(p.id);
      if (row && isCurrent(row, p)) words.push({ phraseId: p.id, text: p.text, meaning: p.meaning, ...(p.reading ? { reading: p.reading } : {}), picture: pictureView(row) });
    }
    return sendJson(res, 200, { words, status: await statusOf(ctx) } satisfies WordPicturesReply);
  }
  if (parts.length === 1 && parts[0] === "fill") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    // With no key, only the stock pictures can be had: a 400 when there
    // are none either.
    const problem = imageProvider().problem();
    if (problem && !(await stockOffer(ctx.learner.mode)).length) throw new HttpError(400, problem);
    fillPictures(targetOf(ctx));
    return sendJson(res, 202, { status: await statusOf(ctx) } satisfies GameStatusReply);
  }
  if (parts.length === 1 && parts[0] === "restyle") {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    return sendJson(res, 202, (await restyleAll(ctx)) satisfies RestyleReply);
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
    if (action !== "remove" && action !== "redraw" && action !== "draw") return sendJson(res, 404, { error: "no such route" });
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    if (action !== "remove") {
      const problem = imageProvider().problem();
      if (problem) throw new HttpError(400, problem);
    }
    if (action === "draw") {
      // A grown-up's override of "no clear picture" (ld-of0): what they
      // typed, else the word's meaning, by the check's own rules; a name
      // or nothing to draw is said plainly and nothing is stored or sent.
      const body = (await readJsonBody(req)) as { description?: unknown } | null;
      const typed = body?.description;
      if (typed != null && typeof typed !== "string") throw new HttpError(400, "description must be text");
      const own = typeof typed === "string" && typed.trim() !== "";
      const names = (await listLearners(rawDb(), ctx.user.id, { archived: true })).map((l) => l.name);
      const d = grownUpDescription(own ? typed : (phrase.meaning ?? ""), names);
      if (d.error !== undefined) {
        throw new HttpError(
          400,
          d.error === "name"
            ? own
              ? "A picture's description can't have a learner's name in it. Say what to draw without the name."
              : "This word's meaning has a learner's name in it. Type what the picture should show, without the name."
            : own
              ? "That description doesn't say what to draw. Use a few plain words, like \"a waving hand\"."
              : "Type what the picture should show, in a few plain words, like \"a waving hand\".",
        );
      }
      const drawn = await drawAnyway(rawDb(), profile, phraseId, pictureKey(phrase), d.description);
      if ("problem" in drawn) {
        throw new HttpError(409, drawn.problem === "state" ? "this word isn't one left out for having no clear picture now" : "this word hasn't been judged for a picture yet");
      }
      // A trigger like Draw again: the same run, slot, ledger and caps.
      fillPictures(targetOf(ctx));
      return sendJson(res, 200, { picture: pictureView(drawn.row), status: await statusOf(ctx) } satisfies PhrasePictureReply);
    }
    const changed = await changePicture(rawDb(), profile, phraseId, pictureKey(phrase), action);
    if ("problem" in changed) {
      throw new HttpError(409, changed.problem === "state" ? `this picture can't be ${action === "remove" ? "removed" : "drawn again"} now` : "this word hasn't been judged for a picture yet");
    }
    await dropPictureFile(changed.oldFile);
    // A grown-up's explicit redraw is a trigger (the same caps and ledger).
    if (action === "redraw") fillPictures(targetOf(ctx));
    return sendJson(res, 200, { picture: pictureView(changed.row), status: await statusOf(ctx) } satisfies PhrasePictureReply);
  }
  sendJson(res, 404, { error: "no such route" });
}
