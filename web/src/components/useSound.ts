import { useCallback, useEffect, useRef, useState } from "react";
import { soundAudio } from "../api";

/* The character card's and sound chart's player: one short sound at a time
 * through /api/voice/sound (cached on disk on the server, per user), and
 * kept here for the page's life too, so tapping ㄅ five times is one
 * request, not five. A new tap stops the sound still playing. */

const BLOBS_MAX = 120;
const blobs = new Map<string, Blob>();
let playing: { audio: HTMLAudioElement; url: string } | null = null;

function stop(): void {
  if (!playing) return;
  playing.audio.pause();
  URL.revokeObjectURL(playing.url);
  playing = null;
}

async function blobFor(text: string, locale: string): Promise<Blob> {
  const key = `${locale}\u0001${text}`;
  const hit = blobs.get(key);
  if (hit) return hit;
  const blob = await soundAudio({ text, locale });
  if (blobs.size >= BLOBS_MAX) blobs.delete(blobs.keys().next().value!);
  blobs.set(key, blob);
  return blob;
}

export interface SoundPlayer {
  play: (text: string) => Promise<void>;
  /** The text being fetched or played. */
  busy: string | null;
  /** The last failure (cleared by the next tap): which text, and why. */
  error: { text: string; message: string } | null;
}

export function useSound(locale: string): SoundPlayer {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<SoundPlayer["error"]>(null);
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      stop();
    };
  }, []);

  const play = useCallback(
    async (text: string) => {
      stop();
      setError(null);
      setBusy(text);
      try {
        const blob = await blobFor(text, locale);
        if (gone.current) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        const mine = { audio, url };
        playing = mine;
        const done = () => {
          if (playing === mine) playing = null;
          URL.revokeObjectURL(url);
          if (!gone.current) setBusy((b) => (b === text ? null : b));
        };
        audio.onended = done;
        // A play() refused (autoplay rules, no audio device) never ends.
        await audio.play().catch((e: unknown) => {
          done();
          throw e;
        });
      } catch (e) {
        if (!gone.current) {
          setError({ text, message: String((e as Error)?.message || e) });
          setBusy(null);
        }
      }
    },
    [locale],
  );
  return { play, busy, error };
}
