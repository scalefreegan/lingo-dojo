// The pause detector (web/src/recorder.ts; docs/VOICE.md §The recorder).
// Pure and import-free so `node --test` runs it directly on synthetic level
// sequences: the recorder only measures each tick's RMS and acts on what
// `tick` answers.
//
// The threshold is a multiple of the room's own level measured at the start
// of a recording, never below an absolute minimum that keeps hiss from
// counting as speech. The minimum depends on what the browser did to the
// signal: with auto gain on ("conversation") speech arrives loud, so 0.015
// (about -36 dBFS) is safe; with it off ("pitch") a quiet speaker measured
// -45 dBFS (RMS 0.0056) and never armed the detector (ld-5cj). For "pitch"
// the minimum is 0.004 (about -48 dBFS) and the floor term does the work.
//
// After calibration a pitch take's floor follows a steady room up slowly
// (ld-efi): a noise that starts later and holds steady (a fan, an air
// conditioner) would otherwise stay above the threshold, keep the take from
// ending on a pause and, after 200 ms, count as speech. A conversation take
// (noise suppression and auto gain on) keeps the fixed threshold. See
// `createPauseDetector`.

export const FLOOR_MULTIPLE = 3;
export const MIN_THRESHOLD = { conversation: 0.015, pitch: 0.004 } as const;
export type Processing = keyof typeof MIN_THRESHOLD;

/** The recorder measures the level this often. */
export const TICK_MS = 50;
/** Floor-measuring window at the start of a recording. */
export const CALIBRATE_MS = 350;
/** Speech must stay above the threshold this long to count as speech (a
 *  cough or a click does not arm the pause detector). */
export const SPEECH_MIN_MS = 200;

/** The floor follower (ld-efi), pitch takes only. It rises only while the
 *  last FOLLOW_MS of ticks all sit within FOLLOW_SPREAD of each other, and
 *  then at most FOLLOW_RISE_DB per second, never above the quietest of
 *  those ticks. It comes back down only after FALL_MS of ticks all under
 *  it, to the loudest of them, and never below the calibration floor: one
 *  quiet tick in a fluctuating room (a TV, a café) must not ratchet the
 *  threshold down for the rest of the take (PR #53 review).
 *
 *  Why these numbers (chosen without a real microphone: see docs/VOICE.md,
 *  a real-mic check is owed):
 *  - Steady noise is steady: a 21 ms RMS of broadband noise varies by
 *    about ±0.2 dB (1/√(2·1024) relative), a fan or air conditioner by a dB
 *    or so. Speech is not: syllables come 4–6 a second with gaps and
 *    consonants 10–30 dB under the vowels, so a whole second inside 3 dB
 *    happens only on one held vowel. Bursty noise (typing) never passes the
 *    gate either; the caller's maxMs is what ends a take under typing.
 *  - The slowest rate that still matters: the tightest margin is the quiet
 *    speaker of ld-5cj, -45 dBFS against the pitch minimum of -48 dBFS
 *    (3 dB). At 1 dB/s, after the 1 s gate, a vowel held perfectly steady
 *    for 4 s would be the first to be cut; a 3 s one is not (tested).
 *    Louder speech has 10 dB and more. A conversation take never climbs:
 *    with auto gain a drawn-out note at -30 dBFS is steady enough to pass
 *    the gate and was cut at about 9.5 s (PR #53 review), and noise
 *    suppression already removes the steady noise this is for.
 *  - What it buys: a steady -38 dBFS fan that starts mid-take, in a quiet
 *    room, is under the threshold about 11 s after it starts (10 dB from
 *    the minimum's own floor at 1 dB/s, plus the gate), then the take ends
 *    after the chosen silence. Practice speak-it caps at 20 s, so this is
 *    the difference between a pause and the cap there; the character card
 *    (8 s cap) mostly still ends on its cap. */
export const FOLLOW_MS = 1_000;
export const FOLLOW_SPREAD_DB = 3;
export const FOLLOW_RISE_DB = 1;
export const FALL_MS = 300;

/** The room's level from the calibration window's per-tick RMS values: the
 *  quietest tick, not the mean. A learner who starts talking inside the
 *  window (push-to-talk, a click then a word) would otherwise lift the
 *  floor, and with a low minimum the floor sets the threshold: a quiet
 *  voice heard during calibration would then never cross its own 3x
 *  (PR #40 review). A tick is ~21 ms of steady noise, whose RMS barely
 *  varies, so the quietest is still the room. No ticks: 0. */
export function noiseFloor(levels: readonly number[]): number {
  return levels.length ? Math.min(...levels) : 0;
}

export function pauseThreshold(floorRms: number, processing: Processing): number {
  return Math.max(MIN_THRESHOLD[processing], floorRms * FLOOR_MULTIPLE);
}

export interface PauseDetectorOptions {
  processing: Processing;
  /** End the take after this much quiet once speech has started; null =
   *  only the learner ends it. */
  silenceMs: number | null;
  /** Hard cap on a take. */
  maxMs: number;
  /** End a hands-free take that never heard anything. */
  idleMs: number;
}

export type AutoStop = "pause" | "max" | "idle";

export interface PauseDetector {
  /** One tick's RMS (0–1) at `elapsedMs` since the recording started: why
   *  the take should end now, or null. Ticks come every TICK_MS. */
  tick(rms: number, elapsedMs: number): AutoStop | null;
  /** Speech (SPEECH_MIN_MS above the threshold) has been heard. */
  readonly spoke: boolean;
  /** The threshold in force (calibration's until then). */
  readonly threshold: number;
}

/** The detector: calibrate on the first CALIBRATE_MS, then count speech
 *  against the threshold; on a pitch take the floor also follows a steady
 *  room up slowly (FOLLOW_*) and back down to no lower than calibration. */
export function createPauseDetector({ processing, silenceMs, maxMs, idleMs }: PauseDetectorOptions): PauseDetector {
  const calibration: number[] = [];
  const window: number[] = [];
  const windowTicks = Math.round(FOLLOW_MS / TICK_MS);
  const fallTicks = Math.round(FALL_MS / TICK_MS);
  const steadyRatio = 10 ** (FOLLOW_SPREAD_DB / 20);
  const risePerTick = 10 ** ((FOLLOW_RISE_DB * TICK_MS) / 1000 / 20);
  // Below this the floor does not move the threshold (the minimum rules),
  // so a climb starts here, not from a very quiet room's -80 dBFS.
  const floorAtMinimum = MIN_THRESHOLD[processing] / FLOOR_MULTIPLE;
  const follows = processing === "pitch";
  let calibrated = false;
  let calibratedFloor = 0;
  let floor = 0;
  let threshold = 0.02;
  let loudMs = 0;
  let spoke = false;
  let lastLoud = 0;

  function follow(rms: number) {
    // A 0 (or NaN, made 0 in tick) is a dropped read, not the room.
    if (!(rms > 0)) return;
    window.push(rms);
    if (window.length > windowTicks) window.shift();
    const recent = window.slice(-fallTicks);
    if (recent.length === fallTicks && Math.max(...recent) < floor) {
      // The noise stopped: back down, but never under the room calibration heard.
      floor = Math.max(calibratedFloor, Math.max(...recent));
    } else if (window.length === windowTicks) {
      const lo = Math.min(...window);
      if (Math.max(...window) <= lo * steadyRatio) floor = Math.max(floor, Math.min(lo, Math.max(floor, floorAtMinimum) * risePerTick));
    }
    threshold = pauseThreshold(floor, processing);
  }

  return {
    get spoke() {
      return spoke;
    },
    get threshold() {
      return threshold;
    },
    tick(rms, elapsed) {
      // NaN (a broken analyser read) is silence, not a level.
      if (!(rms >= 0)) rms = 0;
      if (elapsed < CALIBRATE_MS) {
        calibration.push(rms);
        return null;
      }
      if (!calibrated) {
        // Three times the room's own level (its quietest tick, so speech in
        // the window doesn't count), but never so low that hiss counts.
        calibratedFloor = noiseFloor(calibration);
        floor = calibratedFloor;
        threshold = pauseThreshold(floor, processing);
        calibrated = true;
      }
      if (rms > threshold) {
        loudMs += TICK_MS;
        lastLoud = elapsed;
        if (loudMs >= SPEECH_MIN_MS) spoke = true;
      } else {
        loudMs = Math.max(0, loudMs - TICK_MS / 2);
      }
      // After the decision: this tick is judged by the threshold it met.
      if (follows) follow(rms);
      if (elapsed >= maxMs) return "max";
      if (silenceMs != null && spoke && elapsed - lastLoud >= silenceMs) return "pause";
      if (silenceMs != null && !spoke && elapsed >= idleMs) return "idle";
      return null;
    },
  };
}
