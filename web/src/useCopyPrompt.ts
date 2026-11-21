import { useEffect, useRef, useState } from "react";
import { assemblePack } from "./api";
import type { Mode, PackInput } from "./types";
import { useCopyStatus, type CopyStatus } from "./useCopyStatus";

/** Copy prompt for the summary bar and the Go tab (ld-mdz). A picked scene
 *  copies the preview's markdown as is. A random scene has none until one is
 *  drawn, so Copy asks the server for one (`draw: true`, as an export does;
 *  nothing is recorded) and copies that prompt, and `note` says which scene
 *  it was (or why it failed, e.g. an empty pool) for a few seconds. */
export function useCopyPrompt(mode: Mode, pack: PackInput, markdown: string, random: boolean): { status: CopyStatus; copy: () => void; note: string | null; busy: boolean } {
  const [status, copyText, copyLater] = useCopyStatus();
  const [saidAbout, setNote] = useState<{ text: string; pack: PackInput } | null>(null);
  // A note belongs to the pack it was said about: another pack, no note.
  const note = saidAbout && saidAbout.pack === pack ? saidAbout.text : null;
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function say(text: string | null) {
    setNote(text ? { text, pack } : null);
    window.clearTimeout(timer.current);
    if (text) timer.current = window.setTimeout(() => setNote(null), 8000);
  }

  function copy() {
    if (!random) return copyText(markdown);
    setBusy(true);
    // One fetch feeds both the clipboard (started now, inside the click)
    // and the note. A reply with no `drawn` for a random pack is a failure:
    // it would paste a sceneless prompt. Any error rejects the clipboard
    // promise too, so the status goes to "failed".
    const fetched = assemblePack(mode, pack, undefined, true).then((r) => {
      if (!r.drawn) throw new Error("The server drew no scene, so nothing was copied");
      return r;
    });
    fetched.then(
      (r) => {
        setBusy(false);
        say(`Copied with the scene “${r.drawn?.title}”, drawn from ${r.drawn?.pool} in the pool`);
      },
      (e: Error) => {
        setBusy(false);
        say(e.message);
      },
    );
    copyLater(fetched.then((r) => r.markdown));
  }
  return { status, copy, note, busy };
}
