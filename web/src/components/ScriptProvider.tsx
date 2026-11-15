import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScriptContext, type ScriptState } from "../script/ruby.tsx";
import { rubyStorageKey, type RubyMode } from "../script/script.ts";

// The card brings Hanzi Writer and the character data: its own chunk,
// fetched the first time a character is tapped.
const CharCard = lazy(() => import("./CharCard.tsx"));

function loadStored(languageId: string): string | null {
  try {
    return localStorage.getItem(rubyStorageKey(languageId));
  } catch {
    return null;
  }
}

/** Reading aids for one language profile (App keys it by the profile, so
 *  a switch starts from that profile's own choice): the Off / Pinyin /
 *  Zhuyin choice, remembered in this browser, and the one character card. */
export default function ScriptProvider({ languageId, kids, children }: { languageId: string; kids: boolean; children: ReactNode }) {
  const [stored, setStored] = useState<string | null>(() => loadStored(languageId));
  const [card, setCard] = useState<{ ch: string; locale: string } | null>(null);
  // Where focus was when the card opened: it goes back there on close.
  const opener = useRef<HTMLElement | null>(null);

  const setMode = useCallback(
    (mode: RubyMode) => {
      setStored(mode);
      try {
        localStorage.setItem(rubyStorageKey(languageId), mode);
      } catch {
        /* private window or blocked storage: the choice lasts this visit */
      }
    },
    [languageId],
  );
  // Stable, so opening the card doesn't re-render every transcript line
  // that reads the context. A character tapped inside the open card keeps
  // the first opener.
  const openChar = useCallback((ch: string, locale: string) => {
    const active = document.activeElement;
    if (!opener.current && active instanceof HTMLElement && !active.closest("dialog")) opener.current = active;
    setCard({ ch, locale });
  }, []);
  const close = useCallback(() => setCard(null), []);
  // Focus goes back once the dialog is gone: while it is still open (modal)
  // the page behind it is inert and can't take focus.
  useEffect(() => {
    if (card || !opener.current) return;
    opener.current.focus();
    opener.current = null;
  }, [card]);

  const value = useMemo<ScriptState>(() => ({ stored, setMode, kids, openChar }), [stored, setMode, kids, openChar]);
  return (
    <ScriptContext.Provider value={value}>
      {children}
      {card && (
        <Suspense fallback={null}>
          <CharCard ch={card.ch} locale={card.locale} onClose={close} />
        </Suspense>
      )}
    </ScriptContext.Provider>
  );
}
