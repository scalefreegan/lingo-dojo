import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { scorePronunciation } from "../pronunciationApi";
import type { PronunciationScoreReply } from "../types";

/** Scoring one recording: nothing to score, waiting on the server, its
 *  reply, or why not. A `null` reply: the language isn't scored, and
 *  nothing is shown. */
export type ScoreState =
  | { step: "idle" }
  | { step: "scoring" }
  | { step: "done"; reply: PronunciationScoreReply | null; take: Blob }
  | { step: "failed"; message: string };

/** Score `take` against `text`, once per take (ToneCheck.tsx). Each answer
 *  says which take and text it is for, so a new take shows "scoring" until
 *  its own reply, never the last one's marks. Leaving drops the request. */
export function useToneScore(take: Blob | null, text: string, enabled: boolean, allReadings = false, reading?: string | null): ScoreState {
  const [got, setGot] = useState<{ take: Blob; text: string; reply: PronunciationScoreReply | null; message: string | null } | null>(null);
  useEffect(() => {
    if (!enabled || !take) return;
    const ctrl = new AbortController();
    scorePronunciation(take, text, ctrl.signal, { allReadings, reading }).then(
      (reply) => !ctrl.signal.aborted && setGot({ take, text, reply, message: null }),
      (e: unknown) => !ctrl.signal.aborted && setGot({ take, text, reply: null, message: e instanceof ApiError ? e.message : String((e as Error)?.message || e) }),
    );
    return () => ctrl.abort();
  }, [take, text, enabled, allReadings, reading]);
  if (!enabled || !take) return { step: "idle" };
  if (!got || got.take !== take || got.text !== text) return { step: "scoring" };
  return got.message !== null ? { step: "failed", message: got.message } : { step: "done", reply: got.reply, take };
}
