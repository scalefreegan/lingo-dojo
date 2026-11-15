/* When the Go tab's saved conversation may stay open (docs/DATA.md
 * §Conversations). Pure, so `node --test` covers it
 * (scripts/tests/conversation-life.test.mjs); VoicePanel holds the refs.
 *
 * A session's conversation is made by a turn, and that turn has awaits
 * before it (the cast draw, the create request) during which the learner can
 * leave Go, press End or Restart, or close the panel. Ending the
 * conversation then can't wait on what doesn't exist yet. So the rule is
 * checked where a conversation comes into being, not at each await: a
 * conversation made while the session can't hold one (Go hidden, or the
 * session already closed) is never adopted, and is ended as soon as the turn
 * that made it has its answer. */

/** What happens to a conversation the moment its creation answers.
 *   adopt          the session is live (Go showing, and not closed since
 *                  the turn that asked for it began): it is the session's.
 *   end-after-turn not live: the turn that asked for it is still stored in
 *                  it, then it is ended; the next turn after coming back
 *                  starts a new one.
 *   drop           the session it was made for is gone (End, Restart, the
 *                  panel closed): no turn will use it; end it now. */
export type ConversationFate = "adopt" | "end-after-turn" | "drop";

export function conversationFate(o: { madeInEpoch: number; epochNow: number; live: boolean }): ConversationFate {
  if (o.madeInEpoch !== o.epochNow) return "drop";
  return o.live ? "adopt" : "end-after-turn";
}

/** Resolves once no turn request is on its way for `id` in `inFlight` (each
 *  one is kept there until it answers or fails; a newer one replacing it is
 *  waited for too). Never rejects. */
export async function turnsSettled(inFlight: Map<string, Promise<unknown>>, id: string): Promise<void> {
  for (let t = inFlight.get(id); t; t = inFlight.get(id)) {
    await t.catch(() => {});
    // The same request still listed (its own cleanup runs after this): stop.
    if (inFlight.get(id) === t) return;
  }
}
