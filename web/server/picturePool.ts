import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { failureHint, startClaude } from "../../scripts/claude.mjs";
import { allLearnerNames } from "../../scripts/db/accounts.ts";
import type { LanguageProfileRef } from "../../scripts/db/owned.ts";
import {
  ownPoolIds, poolCallDone, poolCallStarted, poolCallsSince, setDrawingKidsSafe, shareDrawing, sharedFiles, storePoolWords, storedPool, takenNorms, uncheckedDrawings, unshareDrawing,
  type StoredPool,
} from "../../scripts/db/picturePool.ts";
import { pictureCallDone, pictureCallStarted, pictureCallsSince, type PictureRow } from "../../scripts/db/pictures.ts";
import { POOL_WORDS_FILE, contentRoot, loadPoolWords } from "../../scripts/content.mjs";
import {
  KIDS_CHECK_BATCH, POOL_DAILY_CALLS, POOL_LANGS, POOL_WORDS_BATCH, SHARED_CATEGORY, checkPoolWord, kidsCheckPrompt, parseKidsCheckReply, parsePoolWordsReply, poolId, poolKey,
  poolWords, poolWordsPrompt, shareable, sharedConceptId, sharedWords,
} from "../../scripts/picture-pool.mjs";
import { PICTURE_DAILY_JUDGES, PICTURE_THEME, currentThemes, stockForMode } from "../../scripts/pictures.mjs";
import { deleteStockPicture, readPicture, writeStockPicture } from "../../scripts/picture-store.mjs";
import type { CandidatePhrase } from "../../scripts/practice.mjs";
import { rawDb } from "./db.ts";
import { imageProvider } from "./imageProvider.ts";
import { BackgroundBusy, backgroundSlotWhenFree, type SlotWait } from "./paid.ts";
import { stockList } from "./stockPictures.ts";

// The shared picture pool (docs/DATA.md §The shared picture pool, bead
// ld-ec9): every picture the install has, in every learner's picture game,
// in every target language. The pool is the stock set (content/
// pictures.yaml, the concepts an admin added from the picture library) and
// every learner's own drawing shared into it; each concept's word per
// language and its CEFR level come from content/picture-words.yaml (the
// reviewed table), else from the rows the naming call below stored. A
// learner's game plays their own pictured words first and the pool's
// after them (pictures.ts gameWords), up to a level.
//
// Background work, never started by a poll, a count or a page load:
//  - sharing (shareDrawings): at the end of a language's picture run
//    (pictures.ts fillPictures: a session's end, Draw pictures, a game's
//    start), that language's own drawings in the current theme join the
//    stock set as `drawing` concepts, the file copied into the stock
//    folder. Nothing that names a learner anywhere on the install (its
//    description, its words, its meaning) is shared. A kids learner's
//    drawing reaches kids at once (unless its check said no); an adult's
//    only after its kids check said yes: the picturable check asks since
//    0020 (phrase_pictures.kids_safe), and a drawing judged before that is
//    asked by one kids check call per KIDS_CHECK_BATCH, on that language's
//    judge ledger and cap (PICTURE_DAILY_JUDGES);
//  - naming (fillPoolWords): one install-wide run at a time names the drawn
//    concepts the table lacks a word or level for, POOL_WORDS_BATCH a call,
//    one tool-less Haiku call each in the triggering user's background
//    slot, entered in picture_pool_calls as it starts, at most
//    POOL_DAILY_CALLS in any 24 hours install-wide. Every word is checked
//    to be in its language's script and to name no learner on the
//    install, and stored once per concept and key.

const NAMING_MODEL = "claude-haiku-5-5";
const NAMING_TIMEOUT_SEC = 120;
const DAY_MS = 86_400_000;
const since = () => new Date(Date.now() - DAY_MS);
/** After a failed naming call, how long before a run may start again. */
export const POOL_RETRY_AFTER_MS = 10 * 60_000;
/** How long a naming call waits for the user's background slot. Mutable for the tests. */
export const POOL_SLOT_WAIT: SlotWait = { maxMs: 120_000, everyMs: 2_000 };
/** A concept asked about this many times with its gaps still open is left
 *  alone until a restart: a word the model can't give in a script doesn't
 *  spend the day's calls. */
const NAMING_TRIES = 2;

/* --------------------------------- the words -------------------------------- */

let tableCache: { key: string; entries: Map<string, { level: string; words: Record<string, string> }> } | null = null;

/** content/picture-words.yaml, read again only when the file changes. */
function table(): Map<string, { level: string; words: Record<string, string> }> {
  const abs = path.join(contentRoot(), POOL_WORDS_FILE);
  let key = `${abs}:none`;
  try {
    const st = fs.statSync(abs);
    key = `${abs}:${st.mtimeMs}:${st.size}`;
  } catch {
    /* no file: no words from it */
  }
  if (tableCache?.key !== key) {
    try {
      tableCache = { key, entries: loadPoolWords().entries };
    } catch (e) {
      console.warn("[lingo-dojo] picture pool: picture-words.yaml couldn't be read:", String((e as Error)?.message || e));
      tableCache = { key, entries: new Map() };
    }
  }
  return tableCache.entries;
}

/** A concept's level and words: the table's, over what the rows hold. */
function entryOf(stored: StoredPool, id: string): { level: string; words: Record<string, string> } | null {
  const t = table().get(id);
  const level = t?.level ?? stored.levels.get(id);
  if (!level) return null;
  return { level, words: { ...(stored.words.get(id) ?? {}), ...(t?.words ?? {}) } };
}

/** The drawn stock list (merged, with each file's type), or none when it
 *  can't be read (logged): a broken list is an empty pool, not a 500. */
async function drawnConcepts() {
  try {
    return (await stockList()).filter((c) => c.drawn);
  } catch (e) {
    console.warn("[lingo-dojo] picture pool: the stock list couldn't be read:", String((e as Error)?.message || e));
    return [];
  }
}

/** Whether `id` is this language profile's pool id of some drawn concept,
 *  whatever the learner's mode, level or bank: a round's word the pool no
 *  longer offers (added to the bank meanwhile, the concept removed) is a
 *  stale round, not an unknown word. */
export async function isPoolPhraseId(profileId: string, id: string): Promise<boolean> {
  return (await drawnConcepts()).some((c) => poolId("phrase", profileId, c.id) === id);
}

/** One learner's pool words (picture-pool.mjs poolWords): the drawn
 *  concepts a learner of `mode` may see (stockForMode: no adults-only
 *  concept, and no drawing whose kids check hasn't said yes, for a kids
 *  learner), with a word for `locale`, up to `cap`. */
export async function poolFor(input: { profile: LanguageProfileRef; mode: string; locale: string; nativeLocale: string; cap: string; ownRows: Map<string, PictureRow> }) {
  const drawn = stockForMode(await drawnConcepts(), input.mode);
  const types = new Map(drawn.map((c) => [c.id, c.drawn!.type]));
  const [stored, taken, ownIds] = await Promise.all([
    storedPool(rawDb()),
    takenNorms(rawDb(), input.profile),
    ownPoolIds(rawDb(), input.profile, drawn.map((c) => poolId("phrase", input.profile.id, c.id))),
  ]);
  return poolWords({
    concepts: drawn,
    entry: (id: string) => entryOf(stored, id),
    locale: input.locale,
    nativeLocale: input.nativeLocale || "en-US",
    taken,
    ownIds,
    ownRows: input.ownRows,
    cap: input.cap,
    profileId: input.profile.id,
    theme: PICTURE_THEME.id,
    contentTypeOf: (id: string) => types.get(id) ?? "image/png",
  });
}

/* --------------------------------- naming ---------------------------------- */

let naming: Promise<void> | null = null;
let namingRetryAt = 0;
const namingTries = new Map<string, number>();

/** Resolves when the naming run (if any) has finished (the tests). */
export async function settlePoolWords(): Promise<void> {
  while (naming) await naming.catch(() => {});
}

/** Forget the naming run's memory (the tests: a restart). */
export function resetPoolMemory(): void {
  namingRetryAt = 0;
  namingTries.clear();
}

/** The drawn concepts with a word or the level missing, not given up on. */
async function unnamed() {
  const stored = await storedPool(rawDb());
  return (await drawnConcepts()).filter((c) => {
    if ((namingTries.get(c.id) ?? 0) >= NAMING_TRIES) return false;
    const e = entryOf(stored, c.id);
    return !e || POOL_LANGS.some((k: string) => !e.words[k]);
  });
}

const CAPPED = Symbol("capped");

/**
 * Start the install-wide naming run if none is going and the last didn't
 * fail less than POOL_RETRY_AFTER_MS ago; it names what the table lacks
 * while today's calls last, in `userId`'s background slot. Returns at
 * once; whether a run started.
 */
export function fillPoolWords(userId: string): boolean {
  if (naming || namingRetryAt > Date.now()) return false;
  const run = (async () => {
    let names: string[] | null = null;
    for (;;) {
      const todo = await unnamed();
      if (!todo.length) return;
      if ((await poolCallsSince(rawDb(), since())) >= POOL_DAILY_CALLS) {
        console.log(`[lingo-dojo] picture pool: today's naming calls are used up; ${todo.length} picture(s) wait for their words`);
        return;
      }
      names ??= await allLearnerNames(rawDb());
      const batch = todo.slice(0, POOL_WORDS_BATCH);
      for (const c of batch) namingTries.set(c.id, (namingTries.get(c.id) ?? 0) + 1);
      const { system, user } = poolWordsPrompt(batch);
      let callId = "";
      let text: string | typeof CAPPED;
      try {
        text = await backgroundSlotWhenFree(userId, async () => {
          if ((await poolCallsSince(rawDb(), since())) >= POOL_DAILY_CALLS) return CAPPED;
          // In the ledger before the model is asked: a call that then fails counts.
          callId = await poolCallStarted(rawDb(), userId, batch.length, since());
          const { result } = startClaude({ prompt: user, systemPrompt: system, model: NAMING_MODEL, cwd: os.tmpdir(), tools: "none", maxTurns: 1, timeoutSec: NAMING_TIMEOUT_SEC });
          return (await result).text;
        }, POOL_SLOT_WAIT);
      } catch (e) {
        if (e instanceof BackgroundBusy) return;
        if (callId) await poolCallDone(rawDb(), callId, "failed").catch(() => {});
        const msg = String((e as Error)?.message || e);
        throw new Error(`the naming call failed: ${failureHint(msg) || msg}`);
      }
      if (text === CAPPED) return;
      const parsed = parsePoolWordsReply(text, batch, names);
      if (!parsed.ok) {
        await poolCallDone(rawDb(), callId, "failed").catch(() => {});
        throw new Error(`the naming call's reply wasn't usable (${parsed.error})`);
      }
      await storePoolWords(rawDb(), parsed.items);
      await poolCallDone(rawDb(), callId, "ok").catch(() => {});
      console.log(`[lingo-dojo] picture pool: named ${parsed.items.length} of ${batch.length} picture(s)`);
    }
  })()
    .catch((e) => {
      namingRetryAt = Date.now() + POOL_RETRY_AFTER_MS;
      console.error("[lingo-dojo] picture pool: naming stopped:", String((e as Error)?.message || e));
    })
    .finally(() => {
      if (naming === run) naming = null;
    });
  naming = run;
  return true;
}

/* --------------------------------- sharing --------------------------------- */

/** What the share step needs to know about the language it shares from. */
export interface ShareFrom {
  profile: LanguageProfileRef;
  userId: string;
  mode: string;
  locale: string;
}

/**
 * Share this language's own drawings into the pool (pictures.mjs runs this
 * at the end of a picture run, with the words and rows it read), then ask
 * the kids check about its shared drawings whose picturable check didn't
 * say (a judge call, on this language's ledger and cap, in the user's
 * background slot). Returns how many drawings it shared. Never throws
 * (logged): sharing is a by-product of a run, never its failure.
 */
export async function shareDrawings(t: ShareFrom, phrases: CandidatePhrase[], rows: Map<string, PictureRow>, slot: SlotWait): Promise<number> {
  let shared = 0;
  try {
    const names = await allLearnerNames(rawDb());
    const list = shareable(phrases, rows, { shared: await sharedFiles(rawDb()), themes: currentThemes(imageProvider().key), names });
    const key = poolKey(t.locale);
    for (const { phrase, row } of list) {
      const bytes = readPicture(row.file!, row.contentType!);
      if (!bytes) continue;
      const id = sharedConceptId(row.file!);
      // The file first: a concept row never points at a missing picture.
      writeStockPicture(PICTURE_THEME.id, id, bytes, row.contentType!);
      const ok = await shareDrawing(rawDb(), {
        id, category: SHARED_CATEGORY, description: row.description!, words: sharedWords(phrase.meaning, row.description), sourceFile: row.file!,
        // A kids learner's own word reaches kids unless its check said no;
        // an adult's only once a check said yes.
        kidsSafe: t.mode === "kids" ? (row.kidsSafe ?? true) : (row.kidsSafe ?? null),
        createdBy: t.userId,
        key, text: key ? checkPoolWord(key, phrase.text ?? "", names) : null,
      });
      if (ok) shared++;
    }
    if (shared) console.log(`[lingo-dojo] picture pool: ${shared} drawing(s) shared`);
    await kidsCheck(t, rows, slot);
  } catch (e) {
    console.warn("[lingo-dojo] picture pool: sharing stopped:", String((e as Error)?.message || e));
  }
  return shared;
}

/** One kids check call for this language's shared drawings not yet
 *  checked, if any wait and the judge cap allows. */
async function kidsCheck(t: ShareFrom, rows: Map<string, PictureRow>, slot: SlotWait): Promise<void> {
  const files = [...rows.values()].map((r) => r.file).filter((f): f is string => !!f);
  const waiting = (await uncheckedDrawings(rawDb(), files)).slice(0, KIDS_CHECK_BATCH);
  if (!waiting.length) return;
  if ((await pictureCallsSince(rawDb(), t.profile, "judge", since())) >= PICTURE_DAILY_JUDGES) return;
  const { system, user } = kidsCheckPrompt(waiting);
  let callId = "";
  let text: string | typeof CAPPED;
  try {
    text = await backgroundSlotWhenFree(t.userId, async () => {
      if ((await pictureCallsSince(rawDb(), t.profile, "judge", since())) >= PICTURE_DAILY_JUDGES) return CAPPED;
      callId = await pictureCallStarted(rawDb(), t.profile, "judge", waiting.length, since());
      const { result } = startClaude({ prompt: user, systemPrompt: system, model: NAMING_MODEL, cwd: os.tmpdir(), tools: "none", maxTurns: 1, timeoutSec: NAMING_TIMEOUT_SEC });
      return (await result).text;
    }, slot);
  } catch (e) {
    if (e instanceof BackgroundBusy) return;
    if (callId) await pictureCallDone(rawDb(), t.profile, callId, "failed").catch(() => {});
    throw e;
  }
  if (text === CAPPED) return;
  const parsed = parseKidsCheckReply(text, waiting.length);
  await pictureCallDone(rawDb(), t.profile, callId, parsed.ok ? "ok" : "failed").catch(() => {});
  if (!parsed.ok) return;
  for (const [i, v] of parsed.verdicts.entries()) if (typeof v === "boolean") await setDrawingKidsSafe(rawDb(), waiting[i].id, v);
}

/**
 * A learner removed or redrew a picture of theirs: if it was shared, it
 * leaves the pool (the concept, its words, its stock file), so a picture a
 * grown-up took away isn't still shown to everyone else. Never throws.
 */
export async function unshareFile(file: string | null | undefined): Promise<void> {
  if (!file) return;
  try {
    const id = await unshareDrawing(rawDb(), file);
    if (id) deleteStockPicture(PICTURE_THEME.id, id);
  } catch (e) {
    console.warn("[lingo-dojo] picture pool: a shared drawing wasn't unshared:", String((e as Error)?.message || e));
  }
}
