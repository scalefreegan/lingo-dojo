/* The recorder's conversion (recorder.ts toWav), kept apart from the
 * browser half so node can test it: decoded channels → 16 kHz mono 16-bit
 * PCM WAV.
 *
 * The resampling is done here, not by the browser: playing a 48 kHz buffer
 * through a 16 kHz OfflineAudioContext (what the recorder used to do)
 * interpolates with no low-pass first, so a recording's 8–24 kHz (hiss,
 * the top of s and sh) folds back into the band the transcriber and the
 * tone scorer hear; decoding straight into a 16 kHz context filters, but
 * loosely and differently per browser (docs/VOICE.md §The recorder). Here
 * it is a Kaiser-windowed sinc: flat to 7.2 kHz, over 80 dB down from
 * 8.5 kHz, the same in every browser. */

export const WAV_RATE = 16_000;

/** Average the channels into one. One channel comes back as it is. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** The low-pass: passband to PASS_HZ, stopband from STOP_HZ (the output's
 *  Nyquist, so nothing above it survives to fold). */
const PASS_HZ = 7_200;
const STOP_HZ = WAV_RATE / 2;
/** Kaiser β for about 80 dB of stopband (Kaiser's formula: 0.1102·(A − 8.7)). */
const BETA = 7.857;
/** The kernel is tabulated at this many points per input sample and read
 *  with linear interpolation, so a ratio like 44.1 → 16 kHz, whose phase
 *  differs at every output sample, needs no sin() per tap. */
const OVERSAMPLE = 512;

/** Zeroth-order modified Bessel function of the first kind (the Kaiser
 *  window's shape), by its power series. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 50; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

const kernels = new Map<number, { half: number; table: Float32Array }>();

/** The windowed-sinc kernel for one input rate, in input samples: `half`
 *  taps either side of the centre, tabulated OVERSAMPLE times per tap. */
function kernelFor(fromRate: number) {
  const have = kernels.get(fromRate);
  if (have) return have;
  const cutoff = (PASS_HZ + STOP_HZ) / 2 / fromRate; // cycles per input sample
  const width = (STOP_HZ - PASS_HZ) / fromRate;
  // Kaiser's length estimate for ~80 dB: (A − 8) / (2.285 · 2π · Δf).
  const half = Math.ceil((80 - 8) / (2.285 * 2 * Math.PI * width) / 2) + 1;
  const table = new Float32Array(half * OVERSAMPLE + 2);
  const i0b = besselI0(BETA);
  for (let j = 0; j < table.length; j++) {
    const x = j / OVERSAMPLE; // distance from the centre, in input samples
    const r = x / half;
    const w = r >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - r * r)) / i0b;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    table[j] = sinc * w;
  }
  const k = { half, table };
  kernels.set(fromRate, k);
  return k;
}

/** Mono samples at `fromRate` → 16 kHz, low-passed first. Output length is
 *  ceil(duration × 16 kHz), as the recorder has always written. */
export function resampleTo16k(pcm: Float32Array, fromRate: number): Float32Array {
  if (!(fromRate > 0)) throw new Error(`bad sample rate ${fromRate}`);
  if (fromRate === WAV_RATE) return pcm;
  const length = Math.max(1, Math.ceil((pcm.length / fromRate) * WAV_RATE));
  const out = new Float32Array(length);
  // Upsampling (a 8 kHz source) needs no low-pass below 8 kHz but the same
  // interpolating kernel does no harm: its passband is wider than the input.
  const { half, table } = kernelFor(Math.max(fromRate, WAV_RATE));
  const step = fromRate / WAV_RATE;
  for (let n = 0; n < length; n++) {
    const t = n * step; // where this output sample sits, in input samples
    const first = Math.max(0, Math.ceil(t - half));
    const last = Math.min(pcm.length - 1, Math.floor(t + half));
    let acc = 0;
    for (let k = first; k <= last; k++) {
      const pos = Math.abs(t - k) * OVERSAMPLE;
      const j = Math.floor(pos);
      const f = pos - j;
      acc += pcm[k] * (table[j] + (table[j + 1] - table[j]) * f);
    }
    out[n] = acc;
  }
  return out;
}

/** 16 kHz mono samples → a 16-bit PCM WAV file, clipped to ±1. */
export function encodeWav16k(pcm: Float32Array): ArrayBuffer {
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
  out.setUint32(24, WAV_RATE, true);
  out.setUint32(28, WAV_RATE * 2, true); // byte rate
  out.setUint16(32, 2, true); // block align
  out.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    // NaN (a broken decode) is written as silence, not as -32768.
    const s = Number.isNaN(pcm[i]) ? 0 : Math.max(-1, Math.min(1, pcm[i]));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out.buffer;
}
