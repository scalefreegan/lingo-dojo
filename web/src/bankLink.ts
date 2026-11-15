// "Show it in the phrase bank" from outside the Library (the session recap
// under a transcript on the Go tab): the app switches to the Library tab and
// the Library to its Phrase bank view, searching for the words. A window
// event carries the request, and the words wait here until the Library,
// mounted or about to mount, takes them.

const EVENT = "lingo-dojo:open-bank";
let pending: string | null = null;

/** Open the phrase bank searching for `q`. */
export function openBank(q: string): void {
  pending = q;
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** The search asked for and not yet taken, without taking it (safe in a
 *  state initializer, which React may run twice). */
export const peekBankRequest = (): string | null => pending;

/** Mark the request taken. */
export function clearBankRequest(): void {
  pending = null;
}

/** Call `fn` on each request; returns the unsubscribe. */
export function onOpenBank(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
