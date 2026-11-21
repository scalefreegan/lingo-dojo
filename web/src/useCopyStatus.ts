import { useEffect, useRef, useState } from "react";

export type CopyStatus = "idle" | "copied" | "failed";

/** Copies text to the clipboard and reports a transient status (back to
 *  "idle" after 2s) — shared by the summary bar's and the Go tab's Copy
 *  buttons, each with its own status so they can show independent feedback.
 *  `copyLater` is for text that has to be fetched first: the clipboard write
 *  starts inside the click (a ClipboardItem takes the promise), because
 *  Safari rejects a write that begins after the gesture has gone. */
export function useCopyStatus(): [CopyStatus, (text: string) => void, (text: Promise<string>) => void] {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function settle(done: Promise<void>) {
    window.clearTimeout(timer.current);
    void done
      .then(
        () => setStatus("copied"),
        () => setStatus("failed"),
      )
      .finally(() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setStatus("idle"), 2000);
      });
  }

  function copy(text: string) {
    settle(navigator.clipboard.writeText(text));
  }

  function copyLater(text: Promise<string>) {
    if (typeof window.ClipboardItem === "function" && navigator.clipboard.write) {
      const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
      settle(navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]));
    } else {
      settle(text.then((t) => navigator.clipboard.writeText(t)));
    }
  }

  return [status, copy, copyLater];
}
