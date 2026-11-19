// The model's audio as PCM, on the server (compare mode, ld-ne0.9;
// docs/VOICE.md §Compare mode). The narrator's cached audio is MP3 from
// ElevenLabs and Azure (WAV at 24 kHz from macOS `say`); the pitch tracker
// reads 16 kHz mono 16-bit PCM. Node has no MP3 decoder, so this asks the
// machine's own converter:
//
//  - macOS `afconvert` (in every macOS install; the app's home: one Mac),
//    with its best sample-rate converter;
//  - else `ffmpeg` when it is on PATH (any other machine with it);
//  - else nothing: the caller draws the textbook shapes, as stage 1 did.
//
// Why the server and not the browser: the analysis of a model clip is
// cached and shared by every later request for that clip, so it must be of
// audio the server itself holds. PCM decoded in a page and sent up could
// be anything, and the server could not tell (an MP3 and its decoded PCM
// share no hash). Decoding the bytes from its own audio cache leaves the
// client nothing to forge. A WAV that already is 16 kHz mono 16-bit (the
// tests' stand-in for a clip) is used as it is, with no process.
//
// The converter runs on a temp copy with an argument list (no shell), a
// timeout of our own that kills it outright (SIGKILL: a converter that
// ignored SIGTERM would otherwise hold a scoring slot for ever), an output
// no larger than the longest clip the scorer reads, and its output read
// back and checked like any recording. Temp dirs left by a crash are
// removed the first time a clip is decoded after a start.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCORE_MAX_SECONDS, SCORE_SAMPLE_RATE, wavHeader } from "./pronunciation-app.mjs";

const AFCONVERT = "/usr/bin/afconvert";
const TIMEOUT_MS = 10_000;
/** The largest clip handed to a converter: a model line is a few seconds
 *  (~50 KB as MP3); the cache never holds anything near this. */
const MAX_INPUT_BYTES = 8 << 20;
const EXT_BY_TYPE = { "audio/mpeg": "mp3", "audio/wav": "wav" };
/** The largest WAV a converter may write: the longest clip the scorer
 *  reads, 16 kHz mono 16-bit, plus room for header chunks (afconvert
 *  writes a 4 KB one). Anything larger is refused unread. */
export const MAX_OUTPUT_BYTES = SCORE_MAX_SECONDS * SCORE_SAMPLE_RATE * 2 + (64 << 10);
const TEMP_PREFIX = "lingo-dojo-decode-";
/** A temp dir older than this is a crash's leftover (a decode lasts 10 s). */
const STALE_MS = 10 * 60_000;

/** Whether `u8` is a WAV the scorer reads as it is: 16 kHz, mono, 16-bit PCM. */
export function isScoreWav(u8) {
  const h = wavHeader(u8);
  return !!h && (h.format === 1 || h.format === 0xfffe) && h.bits === 16 && h.channels === 1 && h.sampleRate === 16_000 && h.dataBytes > 0;
}

/** The converter to use on this machine, or null: `{ name, args(in, out) }`.
 *  `has` answers whether a program exists (tests pass their own). */
export function pickConverter({ platform = process.platform, has = defaultHas } = {}) {
  if (platform === "darwin" && has(AFCONVERT)) {
    // WAVE, little-endian 16-bit at 16 kHz, one channel; "bats" is the
    // sample-rate converter's highest complexity (quality 127 by default).
    return { name: "afconvert", bin: AFCONVERT, args: (input, output) => ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", "--src-complexity", "bats", input, output] };
  }
  const ffmpeg = findOnPath("ffmpeg", has);
  if (ffmpeg) return { name: "ffmpeg", bin: ffmpeg, args: (input, output) => ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", output] };
  return null;
}

function defaultHas(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name, has) {
  for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    if (has(file)) return file;
  }
  return null;
}

/**
 * The clip as a 16 kHz mono 16-bit PCM WAV (a Uint8Array), or null when
 * this machine has no converter. Throws when the converter fails or gives
 * something that isn't such a WAV (the caller treats that as "the model
 * couldn't be read"). The temp copy is removed whatever happens.
 */
export async function decodeTo16k(audio, type, { converter = pickConverter(), timeoutMs = TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES, tmp = os.tmpdir() } = {}) {
  const u8 = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
  if (isScoreWav(u8)) return u8;
  if (!converter) return null;
  const ext = EXT_BY_TYPE[type];
  if (!ext) throw new Error("not an audio type the cache keeps");
  if (u8.length > MAX_INPUT_BYTES) throw new Error("the clip is too large to decode");
  if (!swept.has(tmp)) {
    swept.add(tmp);
    sweepStaleDirs({ tmp });
  }
  const dir = fs.mkdtempSync(path.join(tmp, TEMP_PREFIX));
  try {
    const input = path.join(dir, `in.${ext}`);
    const output = path.join(dir, "out.wav");
    fs.writeFileSync(input, u8, { mode: 0o600 });
    await run(converter, input, output, timeoutMs);
    const size = fs.statSync(output, { throwIfNoEntry: false })?.size ?? 0;
    if (size > maxOutputBytes) throw new Error(`${converter.name} wrote more than the longest clip`);
    const wav = new Uint8Array(fs.readFileSync(output));
    if (!isScoreWav(wav)) throw new Error(`${converter.name} gave no 16 kHz mono WAV`);
    return wav;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the converter, settling at once on a timeout: the child is sent
 *  SIGKILL (which it can't ignore) and the promise rejects without waiting
 *  for it to exit, so the caller's slot and temp dir are freed now.
 *  execFile's own `timeout` sends SIGTERM and then waits for the exit. */
function run(converter, input, output, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const child = execFile(converter.bin, converter.args(input, output), { windowsHide: true, maxBuffer: 64 << 10 }, (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (e) reject(new Error(`${converter.name} failed`));
      else resolve();
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      reject(new Error(`${converter.name} timed out`));
    }, timeoutMs);
  });
}

const swept = new Set();

/** Remove decode temp dirs a crashed run left behind (older than
 *  `STALE_MS`; a live decode's own dir is seconds old). */
export function sweepStaleDirs({ tmp = os.tmpdir(), now = Date.now(), staleMs = STALE_MS } = {}) {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(tmp, name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isDirectory() || now - st.mtimeMs < staleMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      // gone already, or not ours to remove
    }
  }
  return removed;
}
