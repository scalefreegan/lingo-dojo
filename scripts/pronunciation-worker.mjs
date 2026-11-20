// One pronunciation score, off the server's event loop: a worker thread
// started per recording by web/server/pronunciation.ts. The pitch track and
// the readings take from a few tens of milliseconds to over a second on a
// long recording (docs/VOICE.md §Pronunciation, "Speed"), all synchronous.
//
// workerData: { wav (Uint8Array), syllables (expectedSyllables), azure (an
// azurePronunciationResult, or null for the local scorer alone), timings
// (with no azure: syllable spans to score on, as the timings path does, or
// null to cut by energy; the model route's older record's Azure spans) }.
// Posts { result, frames } (the engine's result, and the recording's frames
// for the compare picture: scripts/pronunciation-compare.mjs takeFrames) or
// { error }. The model route (compare mode) runs the same worker on the
// model's clip. The recording lives
// only in this thread's memory and the request's, and goes with them.

import { parentPort, workerData } from "node:worker_threads";
import { mergeAzure, parseWav, pitchCurve, scoreTones, trackPitch } from "./pronunciation.mjs";
import { takeFrames } from "./pronunciation-compare.mjs";

try {
  const { wav, syllables, azure, timings } = workerData;
  const { samples, sampleRate } = parseWav(wav);
  // Tracked once: mergeAzure cuts a word Azure timed whole on the same
  // track, and scoreTones reads its raw pitch span by span.
  const track = trackPitch(samples, sampleRate);
  const local = (cuts) => scoreTones({ samples, sampleRate, syllables, timings: cuts, track });
  const result = azure ? mergeAzure({ azure, syllables, local, track }) : local(timings ?? null);
  // For drawing only, never for a verdict: on the timings path a short
  // recording (one syllable) has too few frames for a range of its own,
  // and the engine then draws no curve (`pitch: []`) even for a syllable
  // it judged. The page centres each curve on its own mean, so any
  // reference pitch draws the same shape: the whole track's f0 (the one
  // trackPitch finishes for drawing) over the syllable's span. Only for a
  // syllable it judged: a "not sure" (too short, unvoiced, …) gets no line
  // that would look like a measurement.
  for (const s of result.syllables) {
    if ((s.verdict === "ok" || s.verdict === "off") && !s.pitch?.length && Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs) s.pitch = pitchCurve(track, s.startMs, s.endMs, 100);
  }
  // The compare picture's frames: pitch about the speaker's own centre
  // inside the syllables' spans, loudness everywhere.
  const frames = takeFrames(track, result.syllables);
  parentPort.postMessage({ result, frames, durationMs: (samples.length / sampleRate) * 1000 });
} catch (e) {
  parentPort.postMessage({ error: String(e?.message || e) });
}
