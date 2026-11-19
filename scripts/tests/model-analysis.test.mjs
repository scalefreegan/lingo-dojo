// The model clip's analysis cache (scripts/model-analysis.mjs, ld-ne0.9)
// and its decoder (scripts/audio-decode.mjs): one Azure call per clip,
// ever, whatever happens to the call, the record or the timing of two
// requests; a clip re-made under the same key is other audio; records go
// with their audio; a machine without a converter caches nothing. All in a
// temp dir, no network, no converter run (the decoder is passed in).
//   node --test scripts/tests/model-analysis.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeTo16k, isScoreWav, pickConverter } from "../audio-decode.mjs";
import { analysisId, azureClaimed, claimAzure, modelAnalysis, prune, readAnalysis, writeAnalysis } from "../model-analysis.mjs";
import { encodeWav } from "../pronunciation.mjs";

const KEY = "a".repeat(64);
const KEY2 = "b".repeat(64);
const AUDIO = Buffer.from("MP3 bytes of the narrator saying 大");

function setup() {
  const audio = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-model-"));
  fs.writeFileSync(path.join(audio, `${KEY}.mp3`), AUDIO);
  return { audio, dir: path.join(audio, "analysis") };
}

/** A stand-in for the route's pieces: counts Azure calls and analyses. */
function harness({ azureAnswers = true, azureReady = true, decodes = true } = {}) {
  const counts = { decode: 0, azure: 0, analyse: 0 };
  return {
    counts,
    decode: async () => {
      counts.decode++;
      return decodes ? new Uint8Array([1, 2, 3]) : null;
    },
    azureReady,
    assess: async (_wav, claim) => {
      if (!claim()) return {};
      counts.azure++;
      await new Promise((r) => setTimeout(r, 5));
      return azureAnswers ? { azure: { status: "Success", words: [{}] } } : {};
    },
    analyse: async (_wav, azure) => {
      counts.analyse++;
      return { v: 1, engine: azure ? "azure" : "local", durationMs: 900, frames: { frameMs: 10, pitch: [null, 1], level: [-48, 0] }, syllables: [] };
    },
  };
}

test("one Azure call per clip: the first request makes it, later ones read the record", async () => {
  const { audio, dir } = setup();
  const h = harness();
  const a = await modelAnalysis({ key: KEY, audio: AUDIO, type: "audio/mpeg", dir, ...h });
  assert.deepEqual([a.cached, a.record.engine, a.record.azure], [false, "azure", "used"]);
  const b = await modelAnalysis({ key: KEY, audio: AUDIO, type: "audio/mpeg", dir, ...h });
  assert.deepEqual([b.cached, b.record.engine], [true, "azure"]);
  assert.deepEqual(h.counts, { decode: 1, azure: 1, analyse: 1 });
  // The record deleted (a wiped cache): analysed again, but no second call.
  fs.rmSync(path.join(dir, `${analysisId(KEY, AUDIO)}.json`));
  const c = await modelAnalysis({ key: KEY, audio: AUDIO, type: "audio/mpeg", dir, ...h });
  assert.deepEqual([c.cached, c.record.engine, c.record.azure], [false, "local", "spent"]);
  assert.equal(h.counts.azure, 1);
  fs.rmSync(audio, { recursive: true, force: true });
});

test("a failed call is spent too; requests at the same time share one analysis and one call", async () => {
  const { audio, dir } = setup();
  const failing = harness({ azureAnswers: false });
  const a = await modelAnalysis({ key: KEY, audio: AUDIO, type: "audio/mpeg", dir, ...failing });
  assert.deepEqual([a.record.engine, a.record.azure], ["local", "spent"]);
  const b = await modelAnalysis({ key: KEY, audio: AUDIO, type: "audio/mpeg", dir, ...harness() });
  assert.deepEqual([b.cached, b.record.azure], [true, "spent"], "a spent clip is never sent again");
  assert.equal(failing.counts.azure, 1);

  const other = Buffer.from("another clip");
  fs.writeFileSync(path.join(audio, `${KEY2}.mp3`), other);
  const h = harness();
  const all = await Promise.all([1, 2, 3, 4].map(() => modelAnalysis({ key: KEY2, audio: other, type: "audio/mpeg", dir, ...h })));
  assert.ok(all.every((r) => r.record.engine === "azure"));
  assert.deepEqual(h.counts, { decode: 1, azure: 1, analyse: 1 });
  // Two processes racing: the ledger is an exclusive create, so one wins.
  const id = analysisId(KEY2, Buffer.from("third"));
  const wins = [claimAzure(id, { dir }), claimAzure(id, { dir }), claimAzure(id, { dir })];
  assert.deepEqual(wins, [true, false, false]);
  fs.rmSync(audio, { recursive: true, force: true });
});

test("no call made (no keys, the cap, busy): 'skipped', and a later request may make the one call", async () => {
  const { audio, dir } = setup();
  const off = harness({ azureReady: false });
  const a = await modelAnalysis({ key: KEY, audio: AUDIO, type: "audio/mpeg", dir, ...off });
  assert.deepEqual([a.record.engine, a.record.azure], ["local", "skipped"]);
  assert.equal(azureClaimed(analysisId(KEY, AUDIO), { dir }), false);
  // Still no keys: the record is read as it is.
  assert.equal((await modelAnalysis({ key: KEY, audio: AUDIO, type: "audio/mpeg", dir, ...off })).cached, true);
  // A request that was refused before the call (assess returns without
  // claiming): still skipped, no ledger.
  const capped = { ...harness(), assess: async () => ({}) };
  const b = await modelAnalysis({ key: KEY, audio: AUDIO, type: "audio/mpeg", dir, ...capped });
  assert.equal(b.record.azure, "skipped");
  // Keys now: one call, the record replaced; then never again.
  const on = harness();
  const c = await modelAnalysis({ key: KEY, audio: AUDIO, type: "audio/mpeg", dir, ...on });
  assert.deepEqual([c.cached, c.record.engine, c.record.azure], [false, "azure", "used"]);
  await modelAnalysis({ key: KEY, audio: AUDIO, type: "audio/mpeg", dir, ...on });
  assert.equal(on.counts.azure, 1);
  fs.rmSync(audio, { recursive: true, force: true });
});

test("other audio under the same key is another clip; no decoder or an unreadable clip is not cached", async () => {
  const { audio, dir } = setup();
  const h = harness();
  await modelAnalysis({ key: KEY, audio: AUDIO, type: "audio/mpeg", dir, ...h });
  const remade = Buffer.from("the same text said again, other bytes");
  const r = await modelAnalysis({ key: KEY, audio: remade, type: "audio/mpeg", dir, ...h });
  assert.equal(r.cached, false);
  assert.notEqual(analysisId(KEY, remade), analysisId(KEY, AUDIO));
  assert.equal(h.counts.azure, 2, "a new clip has its own one call");

  const none = harness({ decodes: false });
  const x = await modelAnalysis({ key: KEY, audio: Buffer.from("new"), type: "audio/mpeg", dir, ...none });
  assert.deepEqual(x, { unavailable: "no_decoder" });
  const broken = { ...harness(), decode: async () => Promise.reject(new Error("afconvert failed")) };
  assert.deepEqual(await modelAnalysis({ key: KEY, audio: Buffer.from("new"), type: "audio/mpeg", dir, ...broken }), { unavailable: "unreadable" });
  assert.equal(readAnalysis(analysisId(KEY, Buffer.from("new")), { dir }), null);
  assert.equal(none.counts.azure + broken.counts.azure, 0, "nothing is sent without PCM");
  fs.rmSync(audio, { recursive: true, force: true });
});

test("records and ledgers go when the audio cache drops their clip; ids are never paths", () => {
  const { audio, dir } = setup();
  const keep = analysisId(KEY, AUDIO);
  const gone = analysisId(KEY2, AUDIO);
  const record = { v: 1, engine: "local", azure: "skipped", durationMs: 1, frames: { frameMs: 10, pitch: [], level: [] }, syllables: [] };
  writeAnalysis(keep, record, { dir });
  writeAnalysis(gone, record, { dir });
  claimAzure(gone, { dir });
  fs.writeFileSync(path.join(dir, "notes.txt"), "not ours");
  const removed = prune({ dir });
  assert.deepEqual(removed.sort(), [`${gone}.azure`, `${gone}.json`]);
  assert.ok(readAnalysis(keep, { dir }));
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")), "only this module's own files are touched");
  assert.throws(() => analysisId("../../etc", AUDIO), /not an audio cache key/);
  assert.throws(() => readAnalysis("../x", { dir }) ?? claimAzure("../x", { dir }), /not an analysis id/);
  fs.rmSync(audio, { recursive: true, force: true });
});

test("the decoder: a 16 kHz mono WAV passes as it is; the converter is picked by what the machine has", async () => {
  const wav = new Uint8Array(encodeWav(new Float32Array(1600), 16_000));
  assert.equal(isScoreWav(wav), true);
  assert.equal(isScoreWav(new Uint8Array(encodeWav(new Float32Array(1600), 24_000))), false);
  assert.equal(await decodeTo16k(wav, "audio/wav", { converter: null }), wav);
  assert.equal(await decodeTo16k(Buffer.from("MP3"), "audio/mpeg", { converter: null }), null, "no converter: null, not a throw");
  assert.equal(pickConverter({ platform: "darwin", has: (f) => f === "/usr/bin/afconvert" }).name, "afconvert");
  assert.equal(pickConverter({ platform: "linux", has: (f) => f.endsWith("/ffmpeg") })?.name ?? "none", process.env.PATH ? "ffmpeg" : "none");
  assert.equal(pickConverter({ platform: "linux", has: () => false }), null);
  // A converter that writes no WAV: a throw (the route says "unreadable").
  const fake = { name: "fake", bin: process.execPath, args: (_in, out) => ["-e", `require("fs").writeFileSync(${JSON.stringify(out)}, "nope")`] };
  await assert.rejects(decodeTo16k(Buffer.from("MP3"), "audio/mpeg", { converter: fake }), /gave no 16 kHz mono WAV/);
  // One that does: its output is read back.
  const good = { name: "fake", bin: process.execPath, args: (_in, out) => ["-e", `require("fs").writeFileSync(${JSON.stringify(out)}, Buffer.from(${JSON.stringify(Buffer.from(wav).toString("base64"))}, "base64"))`] };
  assert.deepEqual(await decodeTo16k(Buffer.from("MP3"), "audio/mpeg", { converter: good }), wav);
});
