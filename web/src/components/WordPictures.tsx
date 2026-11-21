import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { changePhrasePicture, drawPhrasePictureAnyway, fillPictures, phrasePicture, pictureBlob, pictureStatus } from "../gameApi";
import type { PhrasePicture, PictureStatus } from "../types";
import { Button, inputClass } from "./ui";

/* The grown-up's side of the kids word game (docs/DATA.md §Kids word
 * game), in a kids learner's Phrase bank, out of the game where a child
 * could press it: the pictures' status with Draw pictures (the backlog:
 * words met before pictures existed, or past a day's cap), and per word
 * its picture with Remove and Draw again, or, for a word left out as
 * having no clear picture, Draw it anyway with the grown-up's own words
 * for what to show. Pictures are otherwise drawn by
 * themselves after each kids session; nothing here is a child's. */

const small = "px-2 py-1 text-sm sm:text-xs";
const fine = "text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));
const POLL_MS = 5000;

/** The status line and Draw pictures, above the bank's list. Polls the
 *  counts (which start nothing) only while a drawing runs. `refresh` is a
 *  counter the bank bumps when a word's picture changed below (Remove,
 *  Draw again, Draw it anyway, a deleted word): the counts are read again,
 *  and if that started a drawing the poll takes over. */
export function PicturesBar({ onDrawn, refresh = 0 }: { onDrawn?: () => void; refresh?: number }) {
  const [status, setStatus] = useState<PictureStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    pictureStatus(ctrl.signal).then(
      (r) => {
        setStatus((was) => {
          if (was?.drawing && !r.status.drawing) onDrawn?.();
          return r.status;
        });
        if (r.status.drawing) timer = setTimeout(() => setTick((n) => n + 1), POLL_MS);
      },
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [tick, refresh, onDrawn]);

  async function draw() {
    setBusy(true);
    setError(null);
    try {
      setStatus((await fillPictures()).status);
      setTick((n) => n + 1);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return error ? <p className={`${fine} text-err`}>{error}</p> : null;
  const parts = [`${status.pictured} word${status.pictured === 1 ? "" : "s"} with pictures for the word game`];
  if (status.drawing) parts.push("drawing now…");
  else if (status.waiting) parts.push(`${status.waiting} waiting`);
  if (status.limited) parts.push("today's pictures are used up (more tomorrow)");
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line bg-raised/40 px-3 py-2" data-testid="pictures-bar">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${fine} text-fg-2`}>{parts.join(" · ")}</span>
        {status.waiting > 0 && !status.drawing && !status.problem && !status.limited && (
          <Button variant="ghost" className={`${small} ml-auto`} onClick={() => void draw()} disabled={busy} data-testid="pictures-fill">
            Draw pictures
          </Button>
        )}
      </div>
      {status.problem && <p className={`${fine} text-warn`}>{status.problem}</p>}
      {error && <p className={`${fine} text-err`}>{error}</p>}
    </div>
  );
}

const STATE_TEXT: Record<PhrasePicture["status"], string> = {
  pending: "Waiting to be drawn (after the next session, or with Draw pictures).",
  ready: "",
  none: "No clear picture for this word, so it stays out of the word game.",
  failed: "The picture couldn't be drawn; it stays out of the word game.",
  removed: "Removed: it stays out of the word game.",
};

/** One word's picture in its detail: the image, and Remove / Draw again. */
const REDRAW_POLL_MS = 3000;
const REDRAW_POLLS = 20;
/** pictures.mjs DESCRIPTION_MAX: the server cuts a longer one at a word. */
const DESCRIPTION_MAX = 80;

export function PictureSection({ phraseId, onChanged }: { phraseId: string; onChanged?: () => void }) {
  const [picture, setPicture] = useState<PhrasePicture | null | undefined>(undefined);
  // The blob URL with the file it was made for: a removed or redrawn
  // picture's old one is never shown.
  const [shown, setShown] = useState<{ file: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Re-reads left after a redraw: the drawing runs in the background, so
  // the row is read again (a plain GET: reading never draws) every few
  // seconds until it is no longer pending, a bounded number of times.
  const [watch, setWatch] = useState(0);
  // What the grown-up wants drawn for a word the check left out.
  const [wanted, setWanted] = useState("");

  useEffect(() => {
    const ctrl = new AbortController();
    phrasePicture(phraseId, ctrl.signal).then(
      (r) => setPicture(r.picture),
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => ctrl.abort();
  }, [phraseId]);

  const pending = picture?.status === "pending";
  useEffect(() => {
    if (!watch || !pending) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      phrasePicture(phraseId, ctrl.signal).then(
        (r) => {
          setPicture(r.picture);
          setWatch((n) => n - 1);
        },
        () => {
          if (!ctrl.signal.aborted) setWatch(0);
        },
      );
    }, REDRAW_POLL_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [watch, pending, phraseId]);

  const pictureId = picture?.id;
  const file = picture?.file;
  useEffect(() => {
    if (!pictureId || !file) return;
    const ctrl = new AbortController();
    let made: string | null = null;
    pictureBlob(pictureId, file, ctrl.signal).then(
      (b) => {
        if (ctrl.signal.aborted) return;
        made = URL.createObjectURL(b);
        setShown({ file, url: made });
      },
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => {
      ctrl.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [pictureId, file]);

  async function change(action: "remove" | "redraw") {
    if (action === "remove" && !window.confirm("Remove this picture? The word leaves the word game until you draw it again.")) return;
    setBusy(true);
    setError(null);
    try {
      setPicture((await changePhrasePicture(phraseId, action)).picture);
      setWatch(action === "redraw" ? REDRAW_POLLS : 0);
      onChanged?.();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  /** A word with "no clear picture", drawn anyway: the server cleans the
   *  description (and refuses a learner's name with a sentence shown here). */
  async function drawAnyway() {
    setBusy(true);
    setError(null);
    try {
      setPicture((await drawPhrasePictureAnyway(phraseId, wanted)).picture);
      setWanted("");
      setWatch(REDRAW_POLLS);
      onChanged?.();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (picture === undefined) return error ? <p className={`${fine} text-err`}>{error}</p> : null;
  return (
    <div className="flex flex-col gap-1" data-testid="phrase-picture">
      <h3 className={`${fine} font-medium text-fg-2`}>Word game picture</h3>
      {!picture ? (
        <p className={`${fine} text-fg-3`}>Not looked at yet: pictures are drawn after each session, or with Draw pictures above.</p>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          {shown && shown.file === picture.file && <img src={shown.url} alt={picture.description ?? ""} className="size-28 rounded-xl border border-line object-cover" />}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {picture.description && <p className={`${fine} text-fg-3`}>Drawn as: {picture.description}</p>}
            {STATE_TEXT[picture.status] && <p className={`${fine} text-fg-3`}>{pending && watch ? "Being drawn…" : STATE_TEXT[picture.status]}</p>}
            <div className="-ml-2 flex flex-wrap gap-1">
              {(picture.status === "ready" || picture.status === "pending" || picture.status === "failed") && (
                <Button variant="ghost" className={`${small} text-err`} onClick={() => void change("remove")} disabled={busy} data-testid="picture-remove">
                  Remove picture
                </Button>
              )}
              {picture.description && picture.status !== "pending" && picture.status !== "none" && (
                <Button variant="ghost" className={small} onClick={() => void change("redraw")} disabled={busy} data-testid="picture-redraw">
                  Draw again
                </Button>
              )}
            </div>
            {picture.status === "none" && (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void drawAnyway();
                }}
              >
                <input
                  type="text"
                  value={wanted}
                  onChange={(e) => setWanted(e.target.value)}
                  maxLength={DESCRIPTION_MAX}
                  placeholder="What should it show? (optional)"
                  aria-label="What the picture should show (optional)"
                  disabled={busy}
                  className={`${inputClass} ${fine} min-w-0 flex-1 sm:max-w-xs`}
                  data-testid="picture-describe"
                />
                <Button type="submit" variant="ghost" className={small} disabled={busy} data-testid="picture-draw-anyway">
                  Draw it anyway
                </Button>
              </form>
            )}
          </div>
        </div>
      )}
      {error && <p className={`${fine} text-err`}>{error}</p>}
    </div>
  );
}
