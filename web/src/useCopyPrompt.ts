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
  const [status, copyText] = useCopyStatus();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function say(text: string | null) {
    setNote(text);
    window.clearTimeout(timer.current);
    if (text) timer.current = window.setTimeout(() => setNote(null), 8000);
  }

  function copy() {
    if (!random) return copyText(markdown);
    setBusy(true);
    assemblePack(mode, pack, undefined, true).then(
      (r) => {
        setBusy(false);
        copyText(r.markdown);
        say(r.drawn ? `Copied with the scene “${r.drawn.title}”, drawn from ${r.drawn.pool} in the pool` : null);
      },
      (e: Error) => {
        setBusy(false);
        say(e.message);
      },
    );
  }
  return { status, copy, note, busy };
}
