// The pause detector's loudness threshold (web/src/recorder.ts; docs/VOICE.md
// §The recorder). Pure and import-free so `node --test` runs it directly.
//
// The threshold is a multiple of the room's own level measured at the start
// of a recording, never below an absolute minimum that keeps hiss from
// counting as speech. The minimum depends on what the browser did to the
// signal: with auto gain on ("conversation") speech arrives loud, so 0.015
// (about -36 dBFS) is safe; with it off ("pitch") a quiet speaker measured
// -45 dBFS (RMS 0.0056) and never armed the detector (ld-5cj). For "pitch"
// the minimum is 0.004 (about -48 dBFS) and the floor term does the work.

export const FLOOR_MULTIPLE = 3;
export const MIN_THRESHOLD = { conversation: 0.015, pitch: 0.004 } as const;

export function pauseThreshold(floorRms: number, processing: keyof typeof MIN_THRESHOLD): number {
  return Math.max(MIN_THRESHOLD[processing], floorRms * FLOOR_MULTIPLE);
}
