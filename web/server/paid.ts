import { HttpError } from "./sse.ts";

// The per-user bound on the Practice tab's paid calls (docs/DATA.md §As
// built (phase 7b), "Paid calls"): a phrase audio miss, a speak-it
// transcription and a cloze generation call share it.

/** Paid provider calls the practice routes may run at once per user: enough
 *  for a replay racing the next card, not a loop spending the owner's
 *  credits in parallel. The Go tab's voice routes don't share it yet (bead
 *  ld-e6q: a common limit). */
export const PAID_PER_USER = 2;
const paidRunning = new Map<string, number>();

/** Run `fn` in one of the user's paid slots, or 429 when they are all busy. */
export async function paidSlot<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const n = paidRunning.get(userId) ?? 0;
  if (n >= PAID_PER_USER) throw new HttpError(429, "too many audio requests at once; try again in a moment");
  paidRunning.set(userId, n + 1);
  try {
    return await fn();
  } finally {
    const left = (paidRunning.get(userId) ?? 1) - 1;
    if (left > 0) paidRunning.set(userId, left);
    else paidRunning.delete(userId);
  }
}
