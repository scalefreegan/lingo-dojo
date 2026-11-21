/* The microphone half of voice practice: record one learner turn, watch the
 * level to find the end of it (when the learner chose "stop after a pause"),
 * and hand back a 16 kHz mono WAV.
 *
 * Why WAV and not the MediaRecorder blob as-is: Chrome records webm/opus and
 * Safari mp4/aac, and the two speech-to-text providers do not accept the
 * same containers. Decoding in the browser and re-encoding as plain PCM is
 * ~40 lines and makes every provider happy; at 16 kHz a minute is ~1.9 MB.
 *
 * The pause detector is deliberately simple — an RMS level against a noise
 * floor measured in the first moments of the recording, which then follows
 * a steady room up slowly — because the point is the learner's control, not
 * cleverness: it only arms once they have actually spoken, and then waits
 * the full silence they chose. A long think before the first word never
 * ends the turn. */

import { TICK_MS, createPauseDetector } from "../shared/pause-threshold.ts";
import { makeWavConverter } from "./wavConverter.ts";

/** The conversion's Worker, started on the first recording (wavConverter.ts:
 *  on this thread instead when it can't start). */
const convert = makeWavConverter(() => (typeof Worker === "undefined" ? null : new Worker(new URL("./wav16k.worker.ts", import.meta.url), { type: "module" })));

export interface Recording {
  /** Stop and return the WAV, plus whether any speech was heard. `wav` is
   *  null when there is nothing to send: a tap too short to hold audio. */
  stop(): Promise<{ wav: Blob | null; spoke: boolean; ms: number }>;
  /** Stop and throw the audio away. */
  cancel(): void;
}

/** What the browser may do to the microphone before the recorder gets it,
 *  chosen per use (docs/VOICE.md §The recorder):
 *  - "conversation" (a voice turn): echo cancellation, noise suppression
 *    and automatic gain, all on. Only the words matter, and gain helps a
 *    quiet speaker be transcribed.
 *  - "pitch" (Practice speak-it, the character card's tone check): noise
 *    suppression and automatic gain off, since both reshape the signal the
 *    tone scorer measures (gain that moves within a syllable is a contour
 *    of its own). Echo cancellation stays on: the model clip may still be
 *    playing when the learner presses record, and on speakers it would be
 *    heard, and transcribed, as their answer. */
export type MicProcessing = "conversation" | "pitch";

const PROCESSING: Record<MicProcessing, MediaTrackConstraints> = {
  conversation: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  pitch: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
};

export interface RecordOptions {
  /** What the browser may do to the signal first (MicProcessing). */
  processing: MicProcessing;
  /** End the turn after this much quiet once speech has started; null =
   *  only the learner ends it. */
  silenceMs: number | null;
  /** Hard cap on a turn. */
  maxMs?: number;
  /** End a hands-free listen that never heard anything. */
  idleMs?: number;
  /** 0–1, about 20 times a second, for a level meter. */
  onLevel?: (level: number) => void;
  /** The detector (or a cap) decided the turn is over; call stop(). */
  onAutoStop?: (why: "pause" | "max" | "idle") => void;
}

/** Shorter than this is a slip of the finger, not a turn: MediaRecorder may
 *  not even have written an audio frame yet. */
const MIN_TURN_MS = 400;

export async function startRecording(opts: RecordOptions): Promise<Recording> {
  const { processing, silenceMs, maxMs = 60_000, idleMs = 20_000, onLevel, onAutoStop } = opts;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: PROCESSING[processing] });
  // The mic is live from here: if any setup step throws, release it rather
  // than leave the browser's recording indicator on with nothing behind it.
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode;
  let recorder: MediaRecorder;
  const chunks: Blob[] = [];
  try {
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.start(250);
  } catch (e) {
    for (const t of stream.getTracks()) t.stop();
    void ctx?.close();
    throw e;
  }
  const audio = ctx;

  const started = performance.now();
  const samples = new Float32Array(analyser.fftSize);
  // Calibration, the threshold, the floor that follows a steady room and
  // the caps: all in the pure detector (pause-threshold.ts), tested there.
  const detector = createPauseDetector({ processing, silenceMs, maxMs, idleMs });
  let fired = false;

  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    const rms = Math.sqrt(sum / samples.length);
    onLevel?.(Math.min(1, rms / 0.2));
    const why = detector.tick(rms, performance.now() - started);
    if (why && !fired) {
      fired = true;
      onAutoStop?.(why);
    }
  }, TICK_MS);

  let done = false;
  const teardown = () => {
    if (done) return;
    done = true;
    window.clearInterval(timer);
    for (const t of stream.getTracks()) t.stop();
    void audio.close();
  };

  return {
    stop() {
      const ms = performance.now() - started;
      return new Promise((resolve, reject) => {
        recorder.onstop = () => {
          teardown();
          if (ms < MIN_TURN_MS) return resolve({ wav: null, spoke: false, ms });
          const raw = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          // A short silent clip can be a container with no audio frames,
          // which won't decode: that is "nothing heard", not an error. A
          // decode failure on real speech still surfaces.
          toWav(raw).then(
            (wav) => resolve({ wav, spoke: detector.spoke, ms }),
            (e) => (!detector.spoke && ms < 1500 ? resolve({ wav: null, spoke: detector.spoke, ms }) : reject(e)),
          );
        };
        if (recorder.state === "inactive") recorder.onstop(new Event("stop"));
        else recorder.stop();
      });
    },
    cancel() {
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
      teardown();
    },
  };
}

/** Any browser-decodable recording → 16 kHz mono 16-bit PCM WAV. Decoded
 *  at the rate the browser's own context runs (44.1 or 48 kHz: its decoder
 *  loses nothing a microphone gives), then downmixed, low-passed and
 *  resampled to 16 kHz in JS (wav16k.ts), in a Worker so a long take
 *  doesn't freeze the page (wavConverter.ts).
 *
 *  Not by playing the buffer through a 16 kHz OfflineAudioContext, as this
 *  did until 2026-11: Chromium plays a buffer of another rate by
 *  interpolating with no low-pass, so a 10 or 13 kHz tone came out at full
 *  level, folded to 6 or 3 kHz. Nor by decoding straight into a 16 kHz
 *  context, as the recording page does: the decoder then filters, but
 *  loosely (in Chromium 7 kHz down 5 dB and 9 kHz only 20 dB down). The
 *  numbers are in docs/VOICE.md §The recorder. */
export async function toWav(blob: Blob): Promise<Blob> {
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void decodeCtx.close();
  }
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  return new Blob([await convert(channels, decoded.sampleRate)], { type: "audio/wav" });
}
