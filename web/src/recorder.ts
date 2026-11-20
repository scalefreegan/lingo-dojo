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
 * floor measured in the first moments of the recording — because the point
 * is the learner's control, not cleverness: it only arms once they have
 * actually spoken, and then waits the full silence they chose. A long think
 * before the first word never ends the turn. */

import { noiseFloor, pauseThreshold } from "../shared/pause-threshold.ts";
import { downmix, encodeWav16k, resampleTo16k } from "./wav16k";

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

const TICK_MS = 50;
/** Floor-measuring window at the start of a recording. */
const CALIBRATE_MS = 350;
/** Speech must stay above the threshold this long to count as speech (a
 *  cough or a click does not arm the pause detector). */
const SPEECH_MIN_MS = 200;
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
  const floorLevels: number[] = [];
  let calibrated = false;
  let threshold = 0.02;
  let loudMs = 0;
  let spoke = false;
  let lastLoud = started;
  let fired = false;

  const fire = (why: "pause" | "max" | "idle") => {
    if (fired) return;
    fired = true;
    onAutoStop?.(why);
  };

  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    const rms = Math.sqrt(sum / samples.length);
    const now = performance.now();
    const elapsed = now - started;
    onLevel?.(Math.min(1, rms / 0.2));
    if (elapsed < CALIBRATE_MS) {
      floorLevels.push(rms);
      return;
    }
    if (!calibrated) {
      // Three times the room's own level (its quietest tick, so speech in the
      // window doesn't count), but never so low that hiss counts (the minimum
      // is lower for "pitch": no auto gain, see pause-threshold.ts).
      threshold = pauseThreshold(noiseFloor(floorLevels), processing);
      calibrated = true;
    }
    if (rms > threshold) {
      loudMs += TICK_MS;
      lastLoud = now;
      if (loudMs >= SPEECH_MIN_MS) spoke = true;
    } else {
      loudMs = Math.max(0, loudMs - TICK_MS / 2);
    }
    if (elapsed >= maxMs) fire("max");
    else if (silenceMs != null && spoke && now - lastLoud >= silenceMs) fire("pause");
    else if (silenceMs != null && !spoke && elapsed >= idleMs) fire("idle");
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
            (wav) => resolve({ wav, spoke, ms }),
            (e) => (!spoke && ms < 1500 ? resolve({ wav: null, spoke, ms }) : reject(e)),
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
 *  resampled to 16 kHz in JS (wav16k.ts).
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
  const pcm = resampleTo16k(downmix(channels), decoded.sampleRate);
  return new Blob([encodeWav16k(pcm)], { type: "audio/wav" });
}
