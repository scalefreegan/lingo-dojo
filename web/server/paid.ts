import { HttpError } from "./sse.ts";

// The per-user bounds on paid provider calls (docs/DATA.md §As built (phase
// 7b), "Paid calls"; §As built (phase 7c); docs/VOICE.md). Two budgets, kept
// apart so background work never takes what a learner is waiting on:
//  - interactive (paidSlot): one budget shared by every route a learner
//    waits on, so no mix of tabs and windows runs more at once: the Go
//    tab's speech, transcription and voice draws (/api/voice/speak,
//    /transcribe, /cast), the character card's sounds (/sound), the
//    Practice tab's phrase audio and speak-it transcription, and Azure
//    pronunciation scoring (which scores locally when it's busy);
//  - background (backgroundSlot): writing cloze sentences and the word
//    game's pictures, which nothing waits for. A picture run that finds it
//    taken waits its turn (backgroundSlotWhenFree); cloze skips.
// The Go tab's turn is not here: it runs `claude -p` on the owner's login,
// one at a time per conversation already (conversations.ts takeTurnLock).

/** Interactive paid calls at once per user, across every route above:
 *  the Go tab fetches one part of a line at a time (the next only once the
 *  current one has arrived) and draws voices one at a time per session
 *  (web/src/drawQueue.ts, however many new people a streamed reply brings
 *  in), so two is one speech fetch plus one draw (or a replay racing the
 *  next card), not a loop spending the owner's credits in parallel. The Go tab retries a 429 after a moment (web/src/api.ts
 *  whenFree), so a race at the edge (an aborted fetch not yet released)
 *  costs a short wait, not a lost line. */
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

/** Run `fn` in one of the user's interactive paid slots, or 429 at once
 *  (saying `what` is busy: "audio requests", "transcriptions", "voice
 *  draws", "pronunciation checks") when they are all taken. Never queues:
 *  a caller that can do without (pronunciation) falls back instead. */
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

/** How long a background caller waits for the user's slot, and how often
 *  it looks. */
export interface SlotWait {
  maxMs: number;
  everyMs: number;
}

/**
 * Run `fn` in the user's background slot, waiting while it is taken: asked
 * again every `everyMs` (the server's side of web/src/api.ts whenFree),
 * for at most `maxMs`, then BackgroundBusy like backgroundSlot. Nothing is
 * held while it waits: the slot is only ever taken by the try that runs
 * `fn`, so a waiter never blocks whoever has it or anyone else, and `fn`
 * runs at most once. What `fn` checks (a daily cap) it must check inside:
 * the wait may have been long. The timer is unref'd: a wait never keeps a
 * stopping server alive.
 */
export async function backgroundSlotWhenFree<T>(userId: string, fn: () => Promise<T>, wait: SlotWait): Promise<T> {
  const until = Date.now() + wait.maxMs;
  for (;;) {
    // BackgroundBusy from the slot itself, before `fn` started: `started`
    // tells it from one `fn` threw (a nested call), which is never retried.
    let started = false;
    try {
      return await backgroundSlot(userId, () => {
        started = true;
        return fn();
      });
    } catch (e) {
      if (started || !(e instanceof BackgroundBusy) || Date.now() + wait.everyMs > until) throw e;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, wait.everyMs).unref());
  }
}
