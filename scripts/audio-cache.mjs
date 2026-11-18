// The phrase audio cache (docs/DATA.md §Practice modes, docs/VOICE.md
// §Phrase audio): synthesized audio of a phrase, kept on disk so a listening
// drill that plays the same phrase again (a replay, the next session, the
// next day) doesn't pay the text-to-speech provider again.
//
//   <dir>/<sha256 of everything that changes the audio>.<mp3|wav>
//
// The key covers the user it was made for, the provider, the voice, the
// model, the output format, the locale the text is said in, the speed and
// the text itself: change any of them and it is another file, never a stale
// one. The directory is LINGO_AUDIO_DIR, else <LINGO_DATA_DIR or
// data/>/audio (data/ is gitignored), read per call so a test can point it
// at a temp dir.
//
// Safety. A file name is only ever a 64-hex key this module computed plus
// an extension from a fixed list: nothing a client sends becomes a path.
// The routes that serve it take a phrase id the active language profile
// owns (web/server/practice.ts) or 1–4 Han characters (web/server/voice.ts,
// the character card's sounds), never a hash, and files are per user (the
// owner is in the key), so the cache can't be used to read, or time,
// another account's audio. Writes are atomic (a
// temp file in the same directory, then rename), so a reader never sees a
// half-written file. Two requests for the same missing key share one
// synthesis (in this process).
//
// Size. Bounded at LINGO_AUDIO_CACHE_MB (default 256 MB): after a write
// that takes it over, the least recently used files go (a hit touches its
// file's mtime) until it is under 90% of the bound. A phrase is a few
// seconds of audio (~50 KB as MP3), so the default holds thousands.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./content.mjs";

/** Bumped when what a key means changes, so old files are simply missed. */
const KEY_VERSION = 2;
const KEY_RE = /^[0-9a-f]{64}$/;
/** writeCached's temp files: .<key>.<pid>.<random>.tmp */
const TMP_RE = /^\.[0-9a-f]{64}\.\d+\.[0-9a-z]+\.tmp$/;
/** Content types the cache stores, and the extension each is kept under. */
const EXT_BY_TYPE = { "audio/mpeg": "mp3", "audio/wav": "wav" };
const TYPE_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_TYPE).map(([t, e]) => [e, t]));
export const DEFAULT_CACHE_MB = 256;
/** Temp files older than this are leftovers of a crashed write. */
const STALE_TMP_MS = 60 * 60_000;

/** The cache directory: LINGO_AUDIO_DIR, else <data dir>/audio, where the
 *  data dir is LINGO_DATA_DIR (resolved against the repo) or data/. */
export function audioDir(env = process.env) {
  if (env.LINGO_AUDIO_DIR) return path.resolve(REPO_ROOT, env.LINGO_AUDIO_DIR);
  const data = env.LINGO_DATA_DIR ? path.resolve(REPO_ROOT, env.LINGO_DATA_DIR) : path.join(REPO_ROOT, "data");
  return path.join(data, "audio");
}

/** The size bound in bytes: LINGO_AUDIO_CACHE_MB (a positive number), else
 *  the default. */
export function cacheLimitBytes(env = process.env) {
  const mb = Number(env.LINGO_AUDIO_CACHE_MB);
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_CACHE_MB) * 1024 * 1024);
}

/**
 * The cache key: sha256 over every input that changes the audio, and the
 * `owner` (the user it was made for): a file is never shared between
 * accounts, so neither a reply nor its timing can tell one account that
 * another has had the same text said. `speed` is 1 until the app has a
 * speed setting; it is in the key already so adding one never serves audio
 * made at another speed.
 */
export function audioKey({ owner = "", provider, voice, model = "", format = "", locale = "", speed = 1, text }) {
  const parts = [KEY_VERSION, String(owner ?? ""), String(provider ?? ""), String(voice ?? ""), String(model ?? ""), String(format ?? ""), String(locale ?? ""), Number(speed) || 1, String(text ?? "")];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function fileFor(dir, key, ext) {
  if (!KEY_RE.test(key)) throw new Error("not an audio cache key");
  if (!TYPE_BY_EXT[ext]) throw new Error("not an audio cache extension");
  return path.join(dir, `${key}.${ext}`);
}

/** A cached file for `key`, whichever extension it was stored under:
 *  `{ audio, type }`, or null. A hit touches the file (least recently used
 *  goes first). */
export function readCached(key, { dir = audioDir() } = {}) {
  for (const ext of Object.keys(TYPE_BY_EXT)) {
    const file = fileFor(dir, key, ext);
    let audio;
    try {
      audio = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (!audio.length) continue;
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch {
      /* evicted meanwhile: the bytes are already read */
    }
    return { audio, type: TYPE_BY_EXT[ext] };
  }
  return null;
}

/** Store `audio` of `type` under `key`: a temp file, then rename (atomic on
 *  one filesystem). A type the cache doesn't keep is skipped. Then the
 *  size bound. Errors are the caller's to log: a cache that can't write
 *  must not fail the request that made the audio. */
export function writeCached(key, audio, type, { dir = audioDir(), limit = cacheLimitBytes() } = {}) {
  const ext = EXT_BY_TYPE[type];
  if (!ext || !audio?.length) return false;
  const file = fileFor(dir, key, ext);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${key}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, audio, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  evict({ dir, limit, keep: file });
  return true;
}

/**
 * Keep the directory under `limit` bytes: when it is over, delete the
 * least recently used files (oldest mtime) until it is under 90% of it.
 * `keep` (the file just written) goes last. Temp files from a crashed
 * write are removed once they are an hour old. Returns what was removed.
 */
export function evict({ dir = audioDir(), limit = cacheLimitBytes(), keep = null, now = Date.now() } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  let total = 0;
  const removed = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (name.endsWith(".tmp")) {
      // Only this module's own temp files (writeCached's name), never any other .tmp.
      if (!TMP_RE.test(name)) continue;
      if (now - st.mtimeMs > STALE_TMP_MS) {
        fs.rmSync(file, { force: true });
        removed.push(name);
      }
      continue;
    }
    if (!/^[0-9a-f]{64}\.(mp3|wav)$/.test(name)) continue;
    files.push({ file, name, size: st.size, mtime: st.mtimeMs });
    total += st.size;
  }
  if (total <= limit) return removed;
  files.sort((a, b) => Number(a.file === keep) - Number(b.file === keep) || a.mtime - b.mtime || (a.name < b.name ? -1 : 1));
  const target = Math.floor(limit * 0.9);
  for (const f of files) {
    if (total <= target) break;
    // The file just written stays even when it alone is over the bound:
    // it is about to be served.
    if (f.file === keep) break;
    fs.rmSync(f.file, { force: true });
    total -= f.size;
    removed.push(f.name);
  }
  return removed;
}

/** Syntheses running now, by key: a second request for the same missing
 *  audio waits for the first instead of paying for it again. */
const inflight = new Map();

/** A synthesis stopped because its requester went away: the server's 499
 *  (web/server/voice.ts call/sayToWav) or a bare AbortError. */
const isCancelled = (e) => e?.status === 499 || e?.name === "AbortError";

/**
 * The audio for `key`: from the cache (`cached: true`), else `make()`
 * (which returns `{ audio, type }`), stored, then returned. A failed
 * write is logged and the audio still returned.
 */
export async function cachedAudio(key, make, opts = {}) {
  const hit = readCached(key, opts);
  if (hit) return { ...hit, cached: true };
  const running = inflight.get(key);
  if (running) {
    try {
      return { ...(await running), cached: true };
    } catch (e) {
      // The first request was cancelled (its browser gave up, which aborts
      // its synthesis): this one makes its own. Any other failure (the
      // provider down, a bad key) is this request's answer too: retrying
      // would pay, or wait out a timeout, once per waiter.
      if (!isCancelled(e)) throw e;
      if (inflight.get(key) === running) inflight.delete(key);
      return cachedAudio(key, make, opts);
    }
  }
  const p = (async () => {
    const made = await make();
    try {
      writeCached(key, made.audio, made.type, opts);
    } catch (e) {
      console.error(`[lingo-dojo] audio cache: couldn't store a sound's audio (${String(e?.message || e)})`);
    }
    return made;
  })();
  inflight.set(key, p);
  try {
    return { ...(await p), cached: false };
  } finally {
    inflight.delete(key);
  }
}
