// The phrase audio cache (scripts/audio-cache.mjs): what the key covers,
// where files go (never the real data/), atomic writes, the size bound
// (least recently used first) and one synthesis for concurrent misses.
//   node --test scripts/tests/audio-cache.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../content.mjs";
import { audioDir, audioKey, cacheLimitBytes, cachedAudio, evict, readCached, writeCached } from "../audio-cache.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-audio-"));
const BASE = { provider: "elevenlabs", voice: "v1", model: "eleven_flash_v2_5", format: "mp3_44100_128", locale: "es-MX", speed: 1, text: "¿Cuánto cuesta?" };

test("audioKey: 64 hex, stable, and changed by every input that changes the audio", () => {
  const k = audioKey(BASE);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(audioKey({ ...BASE }), k);
  for (const [field, value] of [["provider", "azure"], ["voice", "v2"], ["model", "eleven_v3"], ["format", "wav"], ["locale", "es-ES"], ["speed", 1.25], ["text", "¿Cuánto cuesta? "]]) {
    assert.notEqual(audioKey({ ...BASE, [field]: value }), k, field);
  }
  // No concatenation ambiguity: ("ab","c") is not ("a","bc").
  assert.notEqual(audioKey({ ...BASE, voice: "ab", text: "c" }), audioKey({ ...BASE, voice: "a", text: "bc" }));
});

test("audioDir and the size bound come from the environment; the default is data/audio", () => {
  assert.equal(audioDir({}), path.join(REPO_ROOT, "data", "audio"));
  assert.equal(audioDir({ LINGO_DATA_DIR: "/tmp/x" }), "/tmp/x/audio");
  assert.equal(audioDir({ LINGO_DATA_DIR: "/tmp/x", LINGO_AUDIO_DIR: "/tmp/y" }), "/tmp/y");
  assert.equal(cacheLimitBytes({}), 256 * 1024 * 1024);
  assert.equal(cacheLimitBytes({ LINGO_AUDIO_CACHE_MB: "1" }), 1024 * 1024);
  assert.equal(cacheLimitBytes({ LINGO_AUDIO_CACHE_MB: "-3" }), 256 * 1024 * 1024);
});

test("write then read: <key>.mp3 or .wav, no temp file left, an unknown type or a bad key never written", () => {
  const dir = tmp();
  const k = audioKey(BASE);
  assert.equal(readCached(k, { dir }), null);
  assert.equal(writeCached(k, Buffer.from("MP3"), "audio/mpeg", { dir }), true);
  assert.deepEqual(fs.readdirSync(dir), [`${k}.mp3`]);
  const hit = readCached(k, { dir });
  assert.deepEqual([hit.audio.toString(), hit.type], ["MP3", "audio/mpeg"]);
  const w = audioKey({ ...BASE, provider: "system" });
  writeCached(w, Buffer.from("WAV"), "audio/wav", { dir });
  assert.equal(readCached(w, { dir }).type, "audio/wav");
  assert.equal(writeCached(audioKey({ ...BASE, text: "x" }), Buffer.from("?"), "text/html", { dir }), false);
  assert.throws(() => writeCached("../../etc/passwd", Buffer.from("x"), "audio/mpeg", { dir }), /key/);
  assert.throws(() => readCached("../x", { dir }), /key/);
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith(".tmp")));
});

test("evict: over the bound, the least recently used go until under 90%; a hit counts as use; the new file stays", () => {
  const dir = tmp();
  const keys = [1, 2, 3, 4].map((i) => audioKey({ ...BASE, text: `t${i}` }));
  const t0 = Date.now() / 1000 - 1000;
  keys.forEach((k, i) => {
    writeCached(k, Buffer.alloc(100), "audio/mpeg", { dir, limit: 10_000 });
    fs.utimesSync(path.join(dir, `${k}.mp3`), t0 + i, t0 + i);
  });
  // Read the oldest: now the most recently used.
  readCached(keys[0], { dir });
  const fifth = audioKey({ ...BASE, text: "t5" });
  writeCached(fifth, Buffer.alloc(100), "audio/mpeg", { dir, limit: 350 });
  const left = fs.readdirSync(dir).sort();
  // 500 bytes over a 350 bound: down to ≤ 315, so two go, the least
  // recently used: keys 1 and 2 (key 0 was just read).
  assert.deepEqual(left, [`${keys[0]}.mp3`, `${keys[3]}.mp3`, `${fifth}.mp3`].sort());
  // A stale temp file goes, a fresh one stays; other files are never touched.
  fs.writeFileSync(path.join(dir, ".old.tmp"), "x");
  fs.utimesSync(path.join(dir, ".old.tmp"), t0 - 7200, t0 - 7200);
  fs.writeFileSync(path.join(dir, ".new.tmp"), "x");
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
  evict({ dir, limit: 10 });
  assert.ok(!fs.existsSync(path.join(dir, ".old.tmp")));
  assert.ok(fs.existsSync(path.join(dir, ".new.tmp")));
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")));
});

test("cachedAudio: one synthesis for a miss, even two at once; the next is a hit; a failure stores nothing", async () => {
  const dir = tmp();
  let made = 0;
  const make = async () => {
    made++;
    await new Promise((r) => setTimeout(r, 30));
    return { audio: Buffer.from("SPEECH"), type: "audio/mpeg" };
  };
  const k = audioKey(BASE);
  const [a, b] = await Promise.all([cachedAudio(k, make, { dir }), cachedAudio(k, make, { dir })]);
  assert.equal(made, 1);
  assert.deepEqual([a.audio.toString(), b.audio.toString()], ["SPEECH", "SPEECH"]);
  assert.deepEqual([a.cached, b.cached].sort(), [false, true]);
  const c = await cachedAudio(k, make, { dir });
  assert.deepEqual([c.cached, made], [true, 1]);
  // A waiter whose first request is cancelled makes its own.
  const shared = audioKey({ ...BASE, text: "cancelled first" });
  const cancelled = cachedAudio(shared, async () => {
    await new Promise((r) => setTimeout(r, 20));
    throw new Error("cancelled");
  }, { dir });
  const waiter = cachedAudio(shared, async () => ({ audio: Buffer.from("OWN"), type: "audio/mpeg" }), { dir });
  await assert.rejects(cancelled, /cancelled/);
  const own = await waiter;
  assert.deepEqual([own.audio.toString(), own.cached], ["OWN", false]);
  const bad = audioKey({ ...BASE, text: "fails" });
  await assert.rejects(cachedAudio(bad, async () => { throw new Error("provider down"); }, { dir }), /provider down/);
  assert.equal(readCached(bad, { dir }), null);
});
