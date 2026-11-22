import { useEffect, useId, useState } from "react";
import { ApiError, saveReading } from "../api";
import { loadZh, noteMyReading, useScript } from "../script/ruby.tsx";
import { readingIn, resolveMode } from "../script/script.ts";
import { Button } from "./ui";

/* "This reading is wrong" (ld-4i2, docs/VOICE.md §Uncertain readings): one
 * word's reading, and a choice per syllable among the readings each of its
 * characters really has (the reader's own tables: zh.ts charReadings), so
 * nobody can teach a sound a character doesn't have. Saved as the active
 * language's own reading (POST /api/readings), which outranks everything
 * the reader does, and laid over every text on the page at once
 * (ruby.tsx noteMyReading); the server also rereads the bank phrases with
 * the word, and offers it to the shared list (an admin's goes in active).
 * "This is right" confirms the reading shown: the mark goes.
 *
 * Used on the character card (the word the tapped character is in) and
 * the recap's "Readings to check". For a kids learner, only on the
 * grown-up's side (ld-0mn): never in the child's own views. */

export interface ReadingFixProps {
  word: string;
  /** The reading shown over the word now, one syllable per character. */
  reading: string[];
  locale: string;
  /** Marked uncertain (offers "This is right"). */
  unsure: boolean;
  /** Read by the recap's suggestion, still to check. */
  suggested?: boolean;
  /** Start with the choices open. */
  open?: boolean;
  onSaved?: (reading: string[]) => void;
  /** Shown on a kids learner's grown-up side (the Phrase bank, or the card
   *  opened from it: ld-0mn). A child's own views never show it. */
  grownUp?: boolean;
}

export function ReadingFix({ word, reading, locale, unsure, suggested = false, open = false, onSaved, grownUp = false }: ReadingFixProps) {
  const { kids, languageId, stored, grownUp: grownUpSide } = useScript();
  const id = useId();
  const chars = [...word];
  const [choosing, setChoosing] = useState(open);
  const [pick, setPick] = useState<string[]>(reading);
  const [options, setOptions] = useState<string[][] | null>(null);
  const [state, setState] = useState<{ busy: boolean; note: string | null; error: string | null }>({ busy: false, note: null, error: null });
  const mode = resolveMode(stored, locale);
  const show = (r: string) => (mode === "zhuyin" ? readingIn("zhuyin", r) : r);
  const key = reading.join(" ");

  useEffect(() => setPick(key.split(" ")), [key]);
  useEffect(() => {
    let gone = false;
    loadZh().then(
      (zh) => !gone && setOptions(chars.map((c, k) => zh.charReadings(c, locale, reading[k]))),
      () => !gone && setOptions(null),
    );
    return () => {
      gone = true;
    };
    // `key` and `word` stand for `reading` and `chars`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word, key, locale]);

  if ((kids && !grownUp && !grownUpSide) || chars.length < 2) return null;

  async function save(kind: "corrected" | "confirmed", syllables: string[]) {
    setState({ busy: true, note: null, error: null });
    try {
      const r = await saveReading({ word, reading: syllables.join(" "), kind });
      if (languageId) noteMyReading(languageId, r.reading);
      const shared =
        r.shared === "active"
          ? " It is on the shared list for everyone."
          : r.shared === "suggested"
            ? " It is suggested for the shared list."
            : r.shared === "limited"
              ? " Your suggestions for the shared list are used up for today, so it wasn't sent to others."
              : "";
      setState({ busy: false, error: null, note: kind === "confirmed" ? `Thanks: marked as right.${shared}` : `Saved: ${word} now reads ${syllables.map(show).join(" ")} for you.${shared}` });
      setChoosing(false);
      onSaved?.(syllables);
    } catch (e) {
      setState({ busy: false, note: null, error: e instanceof ApiError ? e.message : "Couldn't save it. Is the dev server still running?" });
    }
  }

  const changed = pick.some((r, k) => r !== reading[k]);
  return (
    <div className="flex flex-col gap-2" data-testid="reading-fix">
      <p className="text-sm text-fg-2">
        <span lang={locale} className="text-fg">
          {word}
        </span>{" "}
        reads <span className="font-medium text-fg">{reading.map(show).join(" ")}</span>
        {unsure && (suggested ? " (suggested after your session: please check it)" : kids ? " (the program isn't sure: please check it before your child learns it)" : " (the program isn't sure)")}
      </p>
      {!choosing && (
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" className="px-2 py-1 text-sm" onClick={() => setChoosing(true)} disabled={state.busy} aria-expanded={false} aria-controls={id}>
            This reading is wrong
          </Button>
          {unsure && (
            <Button variant="ghost" className="px-2 py-1 text-sm" onClick={() => void save("confirmed", reading)} disabled={state.busy}>
              This is right
            </Button>
          )}
        </div>
      )}
      {choosing && (
        <fieldset id={id} className="flex flex-col gap-2 rounded-lg border border-line p-2">
          <legend className="px-1 text-sm text-fg-2">Choose each syllable</legend>
          {!options && <p className="text-sm text-fg-3">Loading the readings…</p>}
          {options &&
            chars.map((c, k) => (
              <div key={k} role="radiogroup" aria-label={`${c}, syllable ${k + 1}`} className="flex flex-wrap items-center gap-1">
                <span lang={locale} className="w-8 text-center text-lg">
                  {c}
                </span>
                {options[k].map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={pick[k] === r}
                    className={`rounded-full border px-2.5 py-0.5 text-sm ${pick[k] === r ? "border-accent bg-accent-soft text-accent" : "border-line text-fg-2 hover:bg-raised"}`}
                    onClick={() => setPick((p) => p.map((x, n) => (n === k ? r : x)))}
                  >
                    {show(r)}
                  </button>
                ))}
              </div>
            ))}
          <div className="flex flex-wrap gap-2">
            <Button className="px-3 py-1 text-sm" onClick={() => void save(changed ? "corrected" : "confirmed", pick)} disabled={state.busy || !options}>
              {changed ? "Save this reading" : "Keep this reading"}
            </Button>
            <Button variant="ghost" className="px-2 py-1 text-sm" onClick={() => setChoosing(false)} disabled={state.busy}>
              Cancel
            </Button>
          </div>
        </fieldset>
      )}
      <p role="status" className={`text-sm ${state.error ? "text-err" : "text-fg-3"}`}>
        {state.error ?? state.note ?? ""}
      </p>
    </div>
  );
}
