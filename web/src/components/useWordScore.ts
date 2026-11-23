import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { scoreWords } from "../pronunciationApi";
import type { PronunciationWordsReply } from "../types";

/** Checking one recording's words (WordCheck.tsx), as useToneScore does
 *  for tones: nothing to check, waiting, the reply, or why not. A `null`
 *  reply: this language isn't checked here, and nothing is shown. */
export type WordScoreState =
  | { step: "idle" }
  | { step: "scoring" }
  | { step: "done"; reply: PronunciationWordsReply | null; take: Blob }
  | { step: "failed"; message: string };

/** Check `take` against `text`, once per take. Each answer says which take
 *  and text it is for, so a new take shows "scoring" until its own reply.
 *  Leaving drops the request. */
export function useWordScore(take: Blob | null, text: string, enabled: boolean): WordScoreState {
  const [got, setGot] = useState<{ take: Blob; text: string; reply: PronunciationWordsReply | null; message: string | null } | null>(null);
  useEffect(() => {
    if (!enabled || !take) return;
    const ctrl = new AbortController();
    scoreWords(take, text, ctrl.signal).then(
      (reply) => !ctrl.signal.aborted && setGot({ take, text, reply, message: null }),
      (e: unknown) => !ctrl.signal.aborted && setGot({ take, text, reply: null, message: e instanceof ApiError ? e.message : String((e as Error)?.message || e) }),
    );
    return () => ctrl.abort();
  }, [take, text, enabled]);
  if (!enabled || !take) return { step: "idle" };
  if (!got || got.take !== take || got.text !== text) return { step: "scoring" };
  return got.message !== null ? { step: "failed", message: got.message } : { step: "done", reply: got.reply, take };
}
