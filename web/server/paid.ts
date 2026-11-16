import { HttpError } from "./sse.ts";

// The per-user bounds on the Practice tab's paid calls (docs/DATA.md §As
// built (phase 7b), "Paid calls"; §As built (phase 7c)). Two budgets, kept
// apart so background work never takes what a learner is waiting on:
//  - interactive (paidSlot): a phrase audio miss and a speak-it
//    transcription, the calls a card waits for;
//  - background (backgroundSlot): writing cloze sentences, which nothing
//    waits for.

/** Interactive paid calls the practice routes may run at once per user:
 *  enough for a replay racing the next card, not a loop spending the
 *  owner's credits in parallel. The Go tab's voice routes don't share it
 *  yet (bead ld-e6q: a common limit). */
export const PAID_PER_USER = 2;
/** Background paid calls at once per user, whatever the language. */
export const BACKGROUND_PER_USER = 1;
const paidRunning = new Map<string, number>();
const backgroundRunning = new Map<string, number>();

async function slot<T>(running: Map<string, number>, max: number, userId: string, busy: () => Error, fn: () => Promise<T>): Promise<T> {
  const n = running.get(userId) ?? 0;
  if (n >= max) throw busy();
  running.set(userId, n + 1);
  try {
    return await fn();
  } finally {
    const left = (running.get(userId) ?? 1) - 1;
    if (left > 0) running.set(userId, left);
    else running.delete(userId);
  }
}

/** Run `fn` in one of the user's interactive paid slots, or 429 (saying
 *  `what` is busy: "audio requests", "transcriptions") when they are all
 *  taken. */
export function paidSlot<T>(userId: string, fn: () => Promise<T>, what = "audio requests"): Promise<T> {
  return slot(paidRunning, PAID_PER_USER, userId, () => new HttpError(429, `too many ${what} at once; try again in a moment`), fn);
}

/** Thrown when the user's background slot is taken: the caller skips the
 *  work (the next session started tries again). */
export class BackgroundBusy extends Error {}

/** Run `fn` in the user's background slot, or throw BackgroundBusy. */
export function backgroundSlot<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return slot(backgroundRunning, BACKGROUND_PER_USER, userId, () => new BackgroundBusy("a background call is already running"), fn);
}
