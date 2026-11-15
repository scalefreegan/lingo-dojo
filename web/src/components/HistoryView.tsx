import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, deleteConversation, getConversation, listConversations } from "../api";
import { sessionGlosses, useLineTranslations } from "../transcript";
import type { ConversationSummary, ConversationTurnsReply, VoiceGloss, VoiceHistoryItem } from "../types";
import { Transcript } from "./Transcript";
import { Badge, Button } from "./ui";

/* History, in the Library tab: the active learner's saved voice sessions
 * (docs/DATA.md §Conversations), newest first, a page at a time. Opening one
 * shows its transcript read-only in the live session's own components, with
 * its glosses tappable as they were; there is no audio to replay. Delete is
 * for good (it asks first). */

const PAGE = 20;
const small = "px-2 py-1 text-sm sm:text-xs";
const fine = "text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));

/** "Nov 15, 2026, 9:30 AM", in the browser's own locale and zone. */
function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** How long it ran: from its start to its end (an idle-ended one ends at its
 *  last turn), or to its last turn while still open. */
function length(c: ConversationSummary): string {
  const end = c.endedAt ?? c.lastTurnAt ?? c.startedAt;
  const min = Math.round((new Date(end).getTime() - new Date(c.startedAt).getTime()) / 60_000);
  return min < 1 ? "under a minute" : `${min} min`;
}

const turnsLabel = (n: number) => `${n} turn${n === 1 ? "" : "s"}`;

export default function HistoryView() {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // The first page on opening; state is only set from the reply.
  useEffect(() => {
    let live = true;
    listConversations(0, PAGE).then(
      (r) => {
        if (!live) return;
        setItems(r.conversations);
        setNext(r.nextOffset);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        setError(errText(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  /** "Show older": the next page, after what is listed. */
  async function more(offset: number) {
    setLoading(true);
    setError(null);
    try {
      const r = await listConversations(offset, PAGE);
      setItems((was) => [...was, ...r.conversations.filter((c) => !was.some((x) => x.id === c.id))]);
      setNext(r.nextOffset);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  async function remove(c: ConversationSummary): Promise<boolean> {
    if (!window.confirm(`Delete "${c.title}" (${when(c.startedAt)}) from your History?\nIts transcript is gone for good.`)) return false;
    try {
      await deleteConversation(c.id);
    } catch (e) {
      setError(`Could not delete it: ${errText(e)}`);
      return false;
    }
    setItems((was) => was.filter((x) => x.id !== c.id));
    // The list moved up by one: the next page starts one earlier.
    setNext((n) => (n == null ? n : n - 1));
    return true;
  }

  const opened = openId ? items.find((c) => c.id === openId) : undefined;
  if (openId) {
    return (
      <ConversationView
        id={openId}
        onBack={() => setOpenId(null)}
        onDelete={async () => {
          if (opened && (await remove(opened))) setOpenId(null);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="history">
      <h2 className="text-sm font-medium text-fg">Past sessions</h2>
      {error && <p className="rounded-md bg-err-soft p-3 text-sm text-err">{error}</p>}
      {!loading && !error && items.length === 0 ? (
        <p className="text-sm text-fg-3">None yet. A voice session on the Go tab is saved here as you practise.</p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-line" aria-label="Past sessions">
          {items.map((c) => (
            <li key={c.id} className="flex flex-col gap-1 border-b border-line px-4 py-2 last:border-b-0 sm:flex-row sm:items-center sm:gap-3" data-testid={`conversation-${c.id}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-fg">{c.title}</span>
                  {!c.endedAt && <Badge tone="accent" title="Still open: it ends with End, leaving Go, or two hours after its last turn">open</Badge>}
                </div>
                <div className={`truncate ${fine} text-fg-3`}>
                  {when(c.startedAt)} · {length(c)} · {turnsLabel(c.turnCount)}
                </div>
                {c.summary && <p className={`mt-0.5 ${fine} text-fg-2`}>{c.summary}</p>}
              </div>
              <div className="-ml-2 flex shrink-0 items-center gap-1 sm:ml-0">
                <Button variant="ghost" className={small} onClick={() => setOpenId(c.id)}>
                  Open
                </Button>
                <Button variant="ghost" className={`${small} text-err`} onClick={() => void remove(c)} aria-label={`Delete ${c.title}`}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {loading && <p className="text-sm text-fg-3">Loading…</p>}
      {!loading && next != null && (
        <Button variant="ghost" className={`${small} self-start`} onClick={() => void more(next)}>
          Show older
        </Button>
      )}
    </div>
  );
}

/** One saved conversation, read-only: every page of its turns, then the
 *  transcript as the session showed it. */
function ConversationView({ id, onBack, onDelete }: { id: string; onBack: () => void; onDelete: () => void }) {
  const [data, setData] = useState<{ head: ConversationTurnsReply; entries: VoiceHistoryItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ at: string; gloss: VoiceGloss } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      let head: ConversationTurnsReply | null = null;
      const entries: VoiceHistoryItem[] = [];
      for (let from: number | null = 0; from != null; ) {
        const r: ConversationTurnsReply = await getConversation(id, from, ctrl.signal);
        head ??= r;
        entries.push(...r.turns);
        from = r.nextFrom;
      }
      if (head) setData({ head, entries });
    })().catch((e) => {
      if (!ctrl.signal.aborted) setError(errText(e));
    });
    return () => ctrl.abort();
  }, [id]);

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const glosses = useMemo(() => sessionGlosses(entries), [entries]);
  const locale = data?.head.locale ?? null;
  const translations = useLineTranslations(entries, glosses, locale);
  const pick = useCallback((at: string, gloss: VoiceGloss) => setPicked((p) => (p?.at === at && p.gloss.term === gloss.term ? null : { at, gloss })), []);
  const closePick = useCallback(() => setPicked(null), []);
  const c = data?.head.conversation;
  const trLabel = data?.head.nativeLocale?.split(/[-_]/)[0]?.toUpperCase() || "Tr";

  return (
    <div className="flex flex-col gap-3" data-testid="history-conversation">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" className={small} onClick={onBack}>
          ← History
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" className={`${small} text-err`} onClick={onDelete} disabled={!c}>
          Delete
        </Button>
      </div>
      {error && <p className="rounded-md bg-err-soft p-3 text-sm text-err">Could not open it: {error}</p>}
      {!c && !error && <p className="text-sm text-fg-3">Loading…</p>}
      {c && (
        <>
          <div>
            <h2 className="text-base font-medium text-fg">{c.title}</h2>
            <p className={`${fine} text-fg-3`}>
              {when(c.startedAt)} · {length(c)} · {turnsLabel(c.turnCount)}
              {c.plannedMinutes != null && ` · planned ${c.plannedMinutes} min`}
              {(c.targetVariant || c.targetLanguage) && ` · ${c.targetVariant || c.targetLanguage}`}
              {!c.endedAt && " · still open"}
            </p>
            {c.summary && <p className="mt-1 text-sm text-fg-2">{c.summary}</p>}
          </div>
          {entries.length === 0 ? (
            <p className="text-sm text-fg-3">No turns were saved in this one.</p>
          ) : (
            <Transcript
              entries={entries}
              plan={data?.head.plan ?? []}
              playing={null}
              picked={picked}
              translations={translations}
              glosses={glosses}
              locale={locale}
              trLabel={trLabel}
              showTr={translations.some((ls) => ls.some(Boolean))}
              onPick={pick}
              onClosePick={closePick}
              className="max-h-[70dvh] min-h-48"
              follow={false}
            />
          )}
          {glosses.length > 0 && <p className="text-xs text-fg-3">Tap an underlined word for its meaning.</p>}
        </>
      )}
    </div>
  );
}
