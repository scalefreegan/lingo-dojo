// The model clip's analysis, cached on disk next to the audio it was made
// from (compare mode, ld-ne0.9; docs/VOICE.md §Compare mode):
//
//   <audio dir>/analysis/<audio key>-<sha256 of the audio, 24 hex>.json   the record
//   <audio dir>/analysis/<audio key>-<sha256 of the audio, 24 hex>.azure-v<N>  the Azure ledger
//
// The audio key is scripts/audio-cache.mjs's (the user, provider, voice,
// model, format, locale, speed and text), so a record is per user like the
// audio itself. The audio's own hash is in the name too: a clip evicted
// and synthesized again under the same key is other audio (a voice is
// never said twice the same), and gets its own analysis.
//
// What is in a record is not personal: the narrator's pitch, loudness and
// syllable timings. Nothing a client sends goes into one: the server reads
// the clip from its own cache (the route takes a phrase id or a few
// characters, never audio), decodes it itself (scripts/audio-decode.mjs)
// and analyses it in a worker. So a client can't poison a record.
//
// One Azure call per clip and record version (MODEL_RECORD_VERSION, the N
// in the ledger's name): a version bump means the old records are wrong, so
// starting fresh must be able to ask Azure again, once; an older version's
// ledger (`.azure` was version 2's) no longer counts and is pruned with its
// clip like any other file. The ledger file is created exclusively
// (O_EXCL) at the moment the call is about to go, before the request, and
// never removed while its audio is kept: a crash mid-call, a failure, a
// second request at the same time (in this process or another) and a
// deleted record all find it and analyse locally. A request that makes no
// call writes no ledger and its record says "skipped", and is served from
// the cache like any other. It is made again (to try the one call) only
// when Azure can be asked: with no keys, or a malformed region, never
// (until the setup is fixed: then on the next request); with Azure set up
// but the call refused (the per-minute cap, the paid slot busy), not before
// the record's `retryAt`, RETRY_MS after it was made, so a clip is
// re-analysed at most once in that time.
//
// Size: a record is a few KB (a 3-second clip is 300 frames). Records and
// ledgers whose audio file the audio cache has evicted are removed after
// each write (`prune`), so this directory never outgrows the cache.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { audioDir } from "./audio-cache.mjs";
import { MODEL_RECORD_VERSION, isModelRecord } from "./pronunciation-compare.mjs";

const KEY_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^([0-9a-f]{64})-[0-9a-f]{24}$/;
const FILE_RE = /^([0-9a-f]{64})-[0-9a-f]{24}\.(json|azure(?:-v\d+)?)$/;

/** This version's ledger extension. */
const LEDGER = `azure-v${MODEL_RECORD_VERSION}`;

/** Where records live: `analysis/` inside the audio cache's directory. */
export function analysisDir(env = process.env) {
  return path.join(audioDir(env), "analysis");
}

/** A record's id: the audio key and the audio's own hash. */
export function analysisId(key, audio) {
  if (!KEY_RE.test(key)) throw new Error("not an audio cache key");
  return `${key}-${createHash("sha256").update(audio).digest("hex").slice(0, 24)}`;
}

function fileOf(dir, id, ext) {
  if (!ID_RE.test(id)) throw new Error("not an analysis id");
  return path.join(dir, `${id}.${ext}`);
}

/** The record for `id`, or null (none, unreadable, or another version's). */
export function readAnalysis(id, { dir = analysisDir() } = {}) {
  try {
    const r = JSON.parse(fs.readFileSync(fileOf(dir, id, "json"), "utf8"));
    return isModelRecord(r) ? r : null;
  } catch {
    return null;
  }
}

/** Store a record: a temp file, then rename. */
export function writeAnalysis(id, record, { dir = analysisDir() } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileOf(dir, id, "json");
  const tmp = path.join(dir, `.${id}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Whether the one Azure call for this clip was ever claimed. */
export function azureClaimed(id, { dir = analysisDir() } = {}) {
  return fs.existsSync(fileOf(dir, id, LEDGER));
}

/** Claim the clip's one Azure call: true when this caller created the
 *  ledger now (it may call), false when it already existed. Exclusive
 *  create, so two requests, even in two processes, can't both win. */
export function claimAzure(id, { dir = analysisDir(), now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(fileOf(dir, id, LEDGER), `${now.toISOString()}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (e) {
    if (e?.code === "EEXIST") return false;
    throw e;
  }
}

/** Remove records and ledgers whose audio the audio cache no longer has
 *  (and this module's own stale temp files). Returns the names removed. */
export function prune({ dir = analysisDir(), audio = path.dirname(dir), now = Date.now() } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (/^\.[0-9a-f]{64}-[0-9a-f]{24}\.\d+\.[0-9a-z]+\.tmp$/.test(name)) {
      try {
        if (now - fs.statSync(file).mtimeMs > 60 * 60_000) {
          fs.rmSync(file, { force: true });
          removed.push(name);
        }
      } catch {
        /* gone meanwhile */
      }
      continue;
    }
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const key = m[1];
    if (fs.existsSync(path.join(audio, `${key}.mp3`)) || fs.existsSync(path.join(audio, `${key}.wav`))) continue;
    fs.rmSync(file, { force: true });
    removed.push(name);
  }
  return removed;
}

/** How long a "skipped" record whose Azure call was refused (the cap, the
 *  paid slot busy) is served as it is before one request tries again. */
export const RETRY_MS = 15 * 60_000;

/** Analyses running now, by id: a second request for the same clip waits
 *  for the first (and so never makes a second Azure call either). */
const inflight = new Map();

/**
 * The model clip's record, from the cache or made now.
 *
 * - `key`, `audio`, `type`: the clip as the audio cache holds it (the
 *   caller has just read or made it through cachedAudio).
 * - `decode(audio, type)` → a 16 kHz mono WAV, or null when this machine
 *   can't decode (the result is then `{ unavailable: "no_decoder" }`,
 *   not cached: a converter may be installed later). A throw is
 *   `{ unavailable: "unreadable" }`, not cached either.
 * - `azureReady`: whether an Azure call could be made now (keys set).
 * - `assess(wav, claim)` → `{ azure }` (a usable reply), `{ spent: true }`
 *   (a call was made and failed, or `claim()` said no) or `{ skipped:
 *   true }` (no call was made). It must call `claim()` immediately before
 *   the request goes, and not make it when `claim()` is false.
 * - `analyse(wav, azure)` → `record` (pronunciation-compare.mjs
 *   modelRecord, with `azure` set by this function).
 *
 * → `{ record, cached }` or `{ unavailable }`.
 */
export async function modelAnalysis({ key, audio, type, decode, azureReady, assess, analyse, dir = analysisDir(), now = Date.now() }) {
  const id = analysisId(key, audio);
  const hit = readAnalysis(id, { dir });
  // A record made without Azure, while Azure can be asked now, its one call
  // never claimed, and its retry time (if any) come: worth making again.
  const retry = hit && hit.azure === "skipped" && azureReady && !azureClaimed(id, { dir }) && !(Number.isFinite(hit.retryAt) && hit.retryAt > now);
  if (hit && !retry) return { record: hit, cached: true };
  const running = inflight.get(id);
  if (running) return running;
  const p = (async () => {
    let wav;
    try {
      wav = await decode(audio, type);
    } catch (e) {
      // An error carrying an HTTP status (the route's: busy, cancelled) is
      // not about the clip: it passes through, and nothing is cached.
      if (e && typeof e === "object" && Number.isInteger(e.status)) throw e;
      return { unavailable: "unreadable" };
    }
    if (!wav) return { unavailable: "no_decoder" };
    let azure = null;
    let state = "skipped";
    if (azureReady) {
      if (azureClaimed(id, { dir })) state = "spent";
      else {
        const out = await assess(wav, () => claimAzure(id, { dir }));
        if (out?.azure) {
          azure = out.azure;
          state = "used";
        } else if (out?.spent || azureClaimed(id, { dir })) state = "spent";
      }
    }
    // Azure was asked and refused without a call (the cap, busy): try it
    // again only after RETRY_MS. Skipped for want of a setup: no retry time,
    // the next request after the setup is fixed tries.
    const record = { ...(await analyse(wav, azure)), azure: state, ...(state === "skipped" && azureReady ? { retryAt: now + RETRY_MS } : {}) };
    try {
      writeAnalysis(id, record, { dir });
      prune({ dir });
    } catch (e) {
      console.error(`[lingo-dojo] model analysis: couldn't store a clip's analysis (${String(e?.code || "error")})`);
    }
    return { record, cached: false };
  })();
  inflight.set(id, p);
  try {
    return await p;
  } finally {
    inflight.delete(id);
  }
}
