// The scoring worker (scripts/pronunciation-worker.mjs, ld-ne0.2) run as
// the route runs it: a thread per recording. On Azure's timings a short
// single syllable has too few frames for a range of its own and the engine
// draws no curve; the worker draws one from the whole track, but only for a
// syllable it judged (ok or off), never for a "not sure" (too short, …),
// where a line would look like a measurement.
//   node --test scripts/tests/pronunciation-worker.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { azurePronunciationResult, encodeWav, expectedSyllables, mergeAzure, parseWav, scoreTones, trackPitch } from "../pronunciation.mjs";
import { speak } from "../pronunciation-synth.mjs";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pronunciation-worker.mjs");

/** A generated 大 said with `tone` for `ms`, and Azure's reply timing it. */
function take(tone, ms) {
  const { samples, timings } = speak([tone], { ms, gaps: [300, 300] });
  const ticks = (x) => Math.round(x * 10_000);
  const [t] = timings;
  const word = { Word: "大", Offset: ticks(t.startMs), Duration: ticks(t.endMs - t.startMs), AccuracyScore: 90, ErrorType: "None", Phonemes: [{ Phoneme: "x 1", Offset: ticks(t.startMs), Duration: ticks(t.endMs - t.startMs), AccuracyScore: 90 }] };
  const azure = azurePronunciationResult({ RecognitionStatus: "Success", DisplayText: "大", NBest: [{ Display: "大", PronScore: 90, AccuracyScore: 90, Words: [word] }] });
  return { wav: new Uint8Array(encodeWav(samples, 16_000)), azure };
}

const syllables = expectedSyllables("大", ["dà"]);

/** What the engine alone says, in this thread. */
function engine({ wav, azure }) {
  const { samples, sampleRate } = parseWav(wav);
  const track = trackPitch(samples, sampleRate);
  return mergeAzure({ azure, syllables, local: (timings) => scoreTones({ samples, sampleRate, syllables, timings, track }), track }).syllables[0];
}

function inWorker({ wav, azure }) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { wav, syllables, azure } });
    w.once("message", (m) => (m.result ? resolve(m.result.syllables[0]) : reject(new Error(m.error))));
    w.once("error", reject);
  });
}

test("the worker draws a missing curve for a judged syllable", async () => {
  const judged = take(1, 200);
  const alone = engine(judged);
  assert.deepEqual([alone.verdict, alone.pitch.length], ["off", 0], "the engine judged it and drew nothing (the case the worker covers)");
  const s = await inWorker(judged);
  assert.equal(s.verdict, "off");
  assert.ok(s.pitch.filter((v) => typeof v === "number").length >= 2, JSON.stringify(s.pitch));
});

test("the worker draws nothing for a syllable it couldn't judge", async () => {
  const short = take(1, 60);
  const alone = engine(short);
  assert.deepEqual([alone.verdict, alone.reason, alone.pitch.length], ["unsure", "short", 0]);
  assert.ok(Number.isFinite(alone.startMs) && alone.endMs > alone.startMs, "it has a span the worker could have drawn over");
  const s = await inWorker(short);
  assert.deepEqual([s.verdict, s.pitch], ["unsure", []]);
});
