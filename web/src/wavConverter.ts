/* The recorder's 16 kHz conversion off the main thread (ld-lvk).
 *
 * resampleTo16k costs about 8.5 ms per second of 48 kHz audio under V8:
 * 40–130 ms for a voice turn, about half a second at a 60 s cap, all of it
 * a frozen page if run where React runs. So it runs in a Worker
 * (wav16k.worker.ts), started on the first recording and kept for the page
 * (its kernel table is then built once). When no Worker can start, or one
 * fails, the same function runs here, as it did before: a slower page, never
 * a lost recording.
 *
 * Kept free of browser globals (the Worker comes from `spawn`) so node can
 * test the fallback with a stand-in. */

import { downmix, encodeWav16k, resampleTo16k, type WavReply, type WavRequest } from "./wav16k.ts";

/** The part of a Worker this uses. */
export interface WorkerLike {
  postMessage(message: WavRequest, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<WavReply>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

/** Decoded channels at `rate` → a 16 kHz mono WAV, on this thread. */
export function wavOnThisThread(channels: readonly Float32Array[], rate: number): ArrayBuffer {
  return encodeWav16k(resampleTo16k(downmix(channels), rate));
}

/** A converter that uses the Worker `spawn` makes (null or a throw: none
 *  available) and falls back to this thread whenever it can't. */
export function makeWavConverter(spawn: () => WorkerLike | null) {
  let worker: WorkerLike | null = null;
  // Once a Worker has failed to start or died, later recordings don't try
  // again: whatever stopped it (a browser without module Workers, a CSP)
  // will stop the next one too.
  let unavailable = false;
  let nextId = 0;
  const pending = new Map<number, { resolve: (wav: ArrayBuffer) => void; reject: (e: Error) => void }>();

  function giveUp() {
    unavailable = true;
    worker?.terminate();
    worker = null;
    for (const p of pending.values()) p.reject(new Error("conversion worker failed"));
    pending.clear();
  }

  function current(): WorkerLike | null {
    if (worker || unavailable) return worker;
    try {
      worker = spawn();
    } catch {
      worker = null;
    }
    if (!worker) {
      unavailable = true;
      return null;
    }
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if ("wav" in data) p.resolve(data.wav);
      else p.reject(new Error(data.error));
    };
    // A module Worker that can't load (an older browser, a blocked script)
    // says so only here, after postMessage: the pending conversions then
    // run on this thread from their own copies.
    worker.onerror = (e) => {
      e.preventDefault();
      giveUp();
    };
    return worker;
  }

  return async function toWav16k(channels: readonly Float32Array[], rate: number): Promise<ArrayBuffer> {
    const w = current();
    if (w) {
      // The Worker gets a buffer of its own, transferred, not copied again:
      // one channel is the decoded AudioBuffer's own data, which must not be
      // detached (the fallback below reads it), so it is copied once here;
      // several are averaged into a new array anyway.
      const pcm = channels.length === 1 ? channels[0].slice() : downmix(channels);
      try {
        return await new Promise<ArrayBuffer>((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          w.postMessage({ id, pcm, rate }, [pcm.buffer]);
        });
      } catch {
        // The Worker failed or refused it: do it here. A request that is
        // simply bad (a 0 Hz rate) throws again below, as it always has.
      }
    }
    return wavOnThisThread(channels, rate);
  };
}

