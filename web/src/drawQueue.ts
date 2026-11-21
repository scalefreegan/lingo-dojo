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
 * whether it is out or still queued. */

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
   *  that covers it ends (it never rejects: `start`'s failures are its own). */
  request(batch: DrawBatch): Promise<void>;
  /** Forget the waiting asks (Restart, a new cast): their promises settle at
   *  once, and the draw out, if any, finishes on its own. */
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

export function drawQueue(start: (batch: DrawBatch) => Promise<void>): DrawQueue {
  let out = false;
  let fresh: Waiting | null = null;
  let again: Waiting | null = null;

  const launch = (w: Waiting) => {
    out = true;
    let run: Promise<void>;
    try {
      run = Promise.resolve(start(w.batch)).catch(() => {});
    } catch {
      run = Promise.resolve();
    }
    void run.then(() => {
      out = false;
      w.resolve();
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
      if (!out) {
        const w = waiting(batch);
        launch(w);
        return w.done;
      }
      // Merged into the one waiting ask of its kind; every asker gets the
      // same promise.
      const kind = batch.retry ? again : fresh;
      const w = kind ? { ...kind, batch: mergeBatch(kind.batch, batch) } : waiting(batch);
      if (batch.retry) again = w;
      else fresh = w;
      return w.done;
    },
    reset() {
      fresh?.resolve();
      again?.resolve();
      fresh = null;
      again = null;
    },
    busy: () => out,
  };
}

