/* A Go session's mid-session voice draws (/api/voice/cast), one at a time.
 * Pure (no React, no fetch), so `node --test` covers it
 * (scripts/tests/draw-queue.test.mjs); VoicePanel's recast asks, and its
 * runDraw is `start`.
 *
 * Why one at a time: the Go tab's paid calls share the user's two slots
 * (web/server/paid.ts), and the speech fetch of the line playing holds one.
 * A streamed turn (docs/VOICE.md §Streaming the reply) asks for a draw each
 * time its CAST notes change, so two new people in one reply were two draws
 * at once beside the speech: a third call, a 429 that whenFree gives up on
 * while a library search holds its slot, and a voice of the wrong age. So:
 * one draw in flight per session; what is asked meanwhile waits, merged
 * into one next draw per kind (first draws, then retries: a retry must not
 * turn someone's first draw into a retry, docs/VOICE.md §The cast), rather
 * than one draw per change. Each ask gets a promise at once, settled when
 * the draw that covers it ends, so the person's lines wait for their draw
 * whether it is out or still queued. A first draw never waits out a retry
 * (drawQueue below). */

export interface DrawBatch {
  /** The tags (cast slots) to draw for, in order. */
  slots: string[];
  /** A retry: this person's draw failed before (it doesn't hold their lines). */
  retry: boolean;
  /** Per slot: the age asked for. */
  ages: Record<string, string>;
  /** Per slot: who it is for (VoicePanel's whoKey). */
  keys: Record<string, string>;
}


/** Two asks as one draw: every slot of both, the later ask's person and age
 *  for a slot both name (the tag is someone else's now). */
export function mergeBatch(a: DrawBatch, b: DrawBatch): DrawBatch {
  return {
    slots: [...a.slots, ...b.slots.filter((s) => !a.slots.includes(s))],
    retry: a.retry,
    ages: { ...a.ages, ...b.ages },
    keys: { ...a.keys, ...b.keys },
  };
}

export interface DrawQueue {
  /** Draw for `batch` as soon as no other draw is out; settles when the draw
   *  that covers it ends (it never rejects: `start`'s failures are its own).
   *  A first draw asked while a retry is out cuts that retry short (below). */
  request(batch: DrawBatch): Promise<void>;
  /** Forget the waiting asks (Restart, Draw another, a new cast): their
   *  promises settle at once, and the draw out, if any, finishes on its own. */
  reset(): void;
  /** Whether a draw is out. */
  busy(): boolean;
}

interface Waiting {
  batch: DrawBatch;
  done: Promise<void>;
  resolve: () => void;
}

function waiting(batch: DrawBatch): Waiting {
  let resolve = () => {};
  const done = new Promise<void>((r) => (resolve = r));
  return { batch, done, resolve };
}

/** Two waiting asks as one: one draw, and everyone who asked hears when it ends. */
function join(a: Waiting, b: Waiting): Waiting {
  return { batch: mergeBatch(a.batch, b.batch), done: a.done, resolve: () => (a.resolve(), b.resolve()) };
}

/**
 * `start(batch, signal)` makes the draw; `signal` aborts when the queue cuts
 * it short. That happens to a retry only: a first draw holds its person's
 * lines, a retry holds nothing (the person speaks in the voice in use), so a
 * first draw asked while a retry is out doesn't wait out the retry's 10 s.
 * The retry is aborted (its /cast frees its paid slot as the request
 * closes, web/server/paid.ts), the first draw goes out once it has stopped
 * (still one at a time), and the retry is asked again after it, its
 * promise still open. An aborted draw is no failure: `start` returns
 * quietly on its signal (VoicePanel's runDraw treats it as Stop).
 */
export function drawQueue(start: (batch: DrawBatch, signal: AbortSignal) => Promise<void>): DrawQueue {
  let current: { w: Waiting; ctrl: AbortController; cut: boolean } | null = null;
  let fresh: Waiting | null = null;
  let again: Waiting | null = null;
  // Bumped by reset: a retry cut short before it doesn't come back.
  let epoch = 0;

  const launch = (w: Waiting) => {
    const ctrl = new AbortController();
    const me = { w, ctrl, cut: false };
    const at = epoch;
    current = me;
    let run: Promise<void>;
    try {
      run = Promise.resolve(start(w.batch, ctrl.signal)).catch(() => {});
    } catch {
      run = Promise.resolve();
    }
    void run.then(() => {
      current = null;
      if (me.cut && at === epoch) {
        // Asked again, behind the first draw that cut it short.
        again = again ? join(w, again) : w;
      } else w.resolve();
      // First draws before retries: a first draw holds someone's lines.
      const next = fresh ?? again;
      if (!next) return;
      if (next === fresh) fresh = null;
      else again = null;
      launch(next);
    });
  };

  return {
    request(batch) {
      if (!batch.slots.length) return Promise.resolve();
      const w = waiting(batch);
      if (!current) {
        launch(w);
        return w.done;
      }
      if (!batch.retry && current.w.batch.retry && !current.cut) {
        current.cut = true;
        current.ctrl.abort();
      }
      // Merged into the one waiting ask of its kind.
      const kind = batch.retry ? again : fresh;
      const merged = kind ? join(kind, w) : w;
      if (batch.retry) again = merged;
      else fresh = merged;
      return w.done;
    },
    reset() {
      epoch++;
      fresh?.resolve();
      again?.resolve();
      fresh = null;
      again = null;
    },
    busy: () => current != null,
  };
}
