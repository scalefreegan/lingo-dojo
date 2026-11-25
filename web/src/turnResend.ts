/* A message sent while the last reply is still on its way (ld-x8l,
 * docs/VOICE.md §Streaming the reply). The page drops that request and sends
 * the new one at once, but the server lets go of the turn only when it has
 * seen the connection close and the run has died, so the new one can get
 * there first and be refused. The page that did the dropping waits and sends
 * it again; any other turn running (another tab's) is refused as ever: it
 * would change the conversation under this one.
 *
 * Pure, so `node --test` covers it (scripts/tests/turn-resend.*.test.mjs). */

/** How long after dropping a turn a refusal may still be that turn's. */
export const RESEND_MS = 3000;
/** Between two tries. */
export const RESEND_EVERY_MS = 150;

const refused = (e: unknown) => (e as { code?: unknown } | null)?.code === "turn_running";

/** `send`, again while it is refused for a turn this page dropped for the
 *  conversation (`droppedAt`, or null). Gives up with the refusal when the
 *  time is over, and with `signal`'s when this turn is dropped too. */
export async function resendTurn<T>(send: () => Promise<T>, droppedAt: number | null, signal: AbortSignal, forMs = RESEND_MS): Promise<T> {
  for (;;) {
    try {
      return await send();
    } catch (e) {
      if (!refused(e) || droppedAt == null || signal.aborted || Date.now() - droppedAt >= forMs) throw e;
    }
    await new Promise((r) => setTimeout(r, RESEND_EVERY_MS));
    signal.throwIfAborted();
  }
}
