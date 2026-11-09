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

export interface Recording {
  /** Stop and return the WAV, plus whether any speech was heard. */
  stop(): Promise<{ wav: Blob; spoke: boolean; ms: number }>;
  /** Stop and throw the audio away. */
  cancel(): void;
}

export interface RecordOptions {
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

export async function startRecording(opts: RecordOptions): Promise<Recording> {
  const { silenceMs, maxMs = 60_000, idleMs = 20_000, onLevel, onAutoStop } = opts;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  recorder.start(250);

  const started = performance.now();
  const samples = new Float32Array(analyser.fftSize);
  let floorSum = 0;
  let floorN = 0;
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
      floorSum += rms;
      floorN += 1;
      return;
    }
    if (floorN) {
      // Three times the room's own level, but never so low that hiss counts.
      threshold = Math.max(0.015, (floorSum / floorN) * 3);
      floorN = 0;
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
    void ctx.close();
  };

  return {
    stop() {
      const ms = performance.now() - started;
      return new Promise((resolve, reject) => {
        recorder.onstop = () => {
          teardown();
          const raw = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          toWav(raw).then((wav) => resolve({ wav, spoke, ms }), reject);
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

const RATE = 16_000;

/** Any browser-decodable recording → 16 kHz mono 16-bit PCM WAV. The
 *  OfflineAudioContext does the resampling and the downmix. */
export async function toWav(blob: Blob): Promise<Blob> {
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void decodeCtx.close();
  }
  const length = Math.max(1, Math.ceil(decoded.duration * RATE));
  const offline = new OfflineAudioContext(1, length, RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);

  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  out.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  out.setUint32(16, 16, true); // fmt chunk size
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * 2, true); // byte rate
  out.setUint16(32, 2, true); // block align
  out.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([out], { type: "audio/wav" });
}
