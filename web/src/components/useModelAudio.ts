import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { phraseAudio } from "../practiceApi";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));

/** The phrase's audio (/api/practice/audio/:id, the listening drill's,
 *  cached on the server), fetched on the first play and kept for the card.
 *  Practice's cards and the Phrase bank's say-it check share it. */
export function useModelAudio(phraseId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const el = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  // Bumped when the card goes: audio that arrives after that is for a card
  // no longer shown, so it is neither kept nor played over the next one.
  const gen = useRef(0);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      gen.current++;
      ctrl.current?.abort();
      el.current?.audio.pause();
      if (el.current) URL.revokeObjectURL(el.current.url);
      el.current = null;
    },
    [phraseId],
  );
  async function play() {
    setError(null);
    const mine = gen.current;
    try {
      if (!el.current) {
        if (ctrl.current) return; // already fetching: the first tap plays it
        setBusy(true);
        const c = new AbortController();
        ctrl.current = c;
        let blob: Blob;
        try {
          ({ blob } = await phraseAudio(phraseId, c.signal));
        } finally {
          if (ctrl.current === c) ctrl.current = null;
        }
        if (mine !== gen.current) return;
        const url = URL.createObjectURL(blob);
        el.current = { audio: new Audio(url), url };
      }
      const a = el.current.audio;
      a.currentTime = 0;
      await a.play();
    } catch (e) {
      if (mine === gen.current) setError(errText(e));
    } finally {
      if (mine === gen.current) setBusy(false);
    }
  }
  return { play: () => void play(), busy, error, phraseId };
}
export type ModelAudio = ReturnType<typeof useModelAudio>;
