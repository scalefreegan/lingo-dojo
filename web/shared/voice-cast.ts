// Pure rule for a voice drawn by a retry (VoicePanel's applyDeferred). Import-
// free so `node --test` runs it directly.

/** Whether a retry's voice must not be taken up for `key`: another person
 *  already holds it on this tag (`held`: every person's voice by key,
 *  "character:female|doña carmen"), or another slot's cast voice or
 *  fallback is it (`others`). A first draw that went ahead without waiting
 *  for the retry (it avoided only what it knew) may have got the same voice
 *  from a small pool; the person then keeps the voice they have. */
export function deferredVoiceTaken(o: { key: string; slot: string; voiceId: string; held: Iterable<[string, string | undefined]>; others: Iterable<string | undefined> }): boolean {
  for (const [k, id] of o.held) if (k !== o.key && k.startsWith(`${o.slot}|`) && id === o.voiceId) return true;
  for (const id of o.others) if (id === o.voiceId) return true;
  return false;
}
