import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, deleteConversation, getConversation, getOverview, listConversations, listScenes } from "../api";
import { sessionGlosses, useLineTranslations } from "../transcript";
import type { ConversationSummary, ConversationTurnsReply, OverviewReply, SceneGroup, VoiceGloss, VoiceHistoryItem } from "../types";
import { inBankLanguage } from "./shared";
import { RubyToggle } from "./Ruby";
import { SessionRecap } from "./SessionRecap";
import { ToneTrendCard } from "./ToneTrend";
import { Transcript } from "./Transcript";
import { Badge, Button, Card, TrashGlyph } from "./ui";

/* History, in the Library tab: the active learner's saved voice sessions
 * (docs/DATA.md §Conversations), grouped by scene (§Revisit): each scene
 * once, the one played most recently first, a page at a time, with how many
 * times it was played; expanding a scene lists its sessions. Practice again
 * loads a session's pack, exactly as played, into the Go tab, and the next
 * session builds on that attempt. Above the list (adults), a card for the
 * last 7 days and the digest written once a day. Opening a session shows its
 * transcript read-only in the live session's own components, with its
 * glosses tappable as they were; there is no audio to replay. Delete (the
 * trash button on every row) is for good, so it asks first: the transcript
 * and recap go, while the phrases a session put in the bank stay (a
 * conversation's delete never erases memory, docs/DATA.md §Schema). A scene
 * played more than once deletes all its sessions from its row, or one at a
 * time from its expanded list. */

/** What a delete asks, in the same words wherever it is offered. */
const forGood = "Its transcript and recap are gone for good; the phrases it added stay in your phrase bank.";

const PAGE = 20;
/** While today's digest is being written, ask again this often, this long. */
const DIGEST_POLL_MS = 5000;
const DIGEST_POLL_FOR_MS = 3 * 60_000;
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
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Props = {
  /** The active language's target language, so a saved session's ☆ Star
   *  is offered only when it was in that language. */
  bankLanguage?: unknown;
  /** A kids learner: no week card, no digest. */
  kids?: boolean;
  /** Practice again: the session's pack into the Go tab (App). */
  onPracticeAgain?: (c: ConversationSummary) => Promise<void>;
};

export default function HistoryView({ bankLanguage, kids = false, onPracticeAgain }: Props = {}) {
  const [groups, setGroups] = useState<SceneGroup[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ConversationSummary | null>(null);
  // Bumped to list again from the top (after a delete).
  const [round, setRound] = useState(0);
  const [loaded, setLoaded] = useState(PAGE);

  // The first page(s) on opening, and again after a delete; state is only
  // set from the reply.
  useEffect(() => {
    let live = true;
    listScenes(0, loaded).then(
      (r) => {
        if (!live) return;
        setGroups(r.scenes);
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
    // `loaded` is read as of the round: Show older doesn't list again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round]);

  /** "Show older": the next page of scenes, after what is listed. */
  async function more(offset: number) {
    setLoading(true);
    setError(null);
    try {
      const r = await listScenes(offset, PAGE);
      setGroups((was) => [...was, ...r.scenes.filter((g) => !was.some((x) => x.sceneKey === g.sceneKey))]);
      setNext(r.nextOffset);
      setLoaded(offset + PAGE);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  async function remove(c: ConversationSummary): Promise<boolean> {
    if (!window.confirm(`Delete "${c.title}" (${when(c.startedAt)}) from your History?\n${forGood}`)) return false;
    try {
      await deleteConversation(c.id);
    } catch (e) {
      setError(`Could not delete it: ${errText(e)}`);
      return false;
    }
    // A scene's count and latest session may both change: list again.
    setRound((n) => n + 1);
    return true;
  }

  /** Every session of a scene played more than once: read its list a page
   *  at a time, then delete each (one route, as the rows do). Stops at the
   *  first failure and says how far it got; the list is read again either
   *  way. */
  async function removeScene(g: SceneGroup): Promise<boolean> {
    const title = g.latest.title;
    if (!window.confirm(`Delete all ${g.attempts} sessions of "${title}" from your History?\nTheir transcripts and recaps are gone for good; the phrases they added stay in your phrase bank.`)) return false;
    setError(null);
    let done = 0;
    try {
      const ids: string[] = [];
      for (let offset: number | null = 0; offset != null; ) {
        const r = await listConversations(offset, 100, g.sceneKey);
        ids.push(...r.conversations.map((c) => c.id));
        offset = r.nextOffset;
      }
      for (const id of ids) {
        // Already gone (another tab, a row's own delete) is as good as done.
        await deleteConversation(id).catch((e) => {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        });
        done++;
      }
      return true;
    } catch (e) {
      setError(`Could not delete every session of "${title}" (${done} deleted): ${errText(e)}`);
      return false;
    } finally {
      setRound((n) => n + 1);
    }
  }

  if (open) {
    return (
      <ConversationView
        id={open.id}
        bankLanguage={bankLanguage}
        onBack={() => setOpen(null)}
        onPracticeAgain={onPracticeAgain}
        onDelete={async () => {
          if (await remove(open)) setOpen(null);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="history">
      {!kids && <WeekCard />}
      {!kids && <ToneTrendCard />}
      <h2 className="text-sm font-medium text-fg">Past sessions</h2>
      {error && <p className="rounded-md bg-err-soft p-3 text-sm text-err">{error}</p>}
      {!loading && !error && groups.length === 0 ? (
        <p className="text-sm text-fg-3">None yet. A voice session on the Go tab is saved here as you practise.</p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-line" aria-label="Past sessions">
          {groups.map((g) => (
            // Keyed by what it shows too: after a delete (a partial one
            // included) a changed scene remounts, so its expanded list is read
            // again instead of offering sessions that are gone.
            <SceneRow key={`${g.sceneKey}:${g.attempts}:${g.latest.id}`} group={g} onOpen={setOpen} onDelete={remove} onDeleteScene={removeScene} onPracticeAgain={onPracticeAgain} />
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

/** Practice again, with its own busy and error state (the pack is fetched
 *  first). */
function PracticeAgainButton({ c, onPracticeAgain }: { c: ConversationSummary; onPracticeAgain?: (c: ConversationSummary) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!onPracticeAgain) return null;
  return (
    <>
      <Button
        variant="ghost"
        className={`${small} text-accent`}
        disabled={busy}
        title="Load this session's scene into Go; the next session builds on how this one went"
        data-testid={`practice-again-${c.id}`}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onPracticeAgain(c);
          } catch (e) {
            setError(errText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Loading…" : "Practice again"}
      </Button>
      {error && <span className={`${fine} text-err`}>Couldn't load it: {error}</span>}
    </>
  );
}

function Badges({ c }: { c: ConversationSummary }) {
  return (
    <>
      {c.randomScene && <Badge tone="accent" title="The scene was drawn at random when the session started">random</Badge>}
      {!c.endedAt && <Badge tone="accent" title="Still open: it ends with End, leaving Go, or two hours after its last turn">open</Badge>}
      {c.recapStatus === "failed" && <Badge tone="warn" title="Open it to retry the recap">no recap</Badge>}
      {c.buildsOn && <Badge title={`Built on the session of ${when(c.buildsOn.startedAt)}`}>again</Badge>}
    </>
  );
}

/** A row's trash button: the icon, its name as the label and tooltip. */
function DeleteButton({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  return (
    <Button variant="ghost" className={`${small} min-w-10 justify-center text-fg-3 hover:text-err`} aria-label={label} title={label} onClick={onClick} data-testid={testId}>
      <TrashGlyph />
    </Button>
  );
}

/** One scene: its latest session, how many it has, and (expanded) all of
 *  them. A scene played once is just that session. */
function SceneRow({ group, onOpen, onDelete, onDeleteScene, onPracticeAgain }: {
  group: SceneGroup;
  onOpen: (c: ConversationSummary) => void;
  onDelete: (c: ConversationSummary) => Promise<boolean>;
  onDeleteScene: (g: SceneGroup) => Promise<boolean>;
  onPracticeAgain?: (c: ConversationSummary) => Promise<void>;
}) {
  const c = group.latest;
  const many = group.attempts > 1;
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function page(offset: number) {
    setError(null);
    try {
      const r = await listConversations(offset, PAGE, group.sceneKey);
      setItems((was) => [...(offset ? (was ?? []) : []), ...r.conversations]);
      setNext(r.nextOffset);
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <li className="flex flex-col border-b border-line last:border-b-0" data-testid={`scene-${group.sceneKey}`}>
      <div className="flex flex-col gap-1 px-4 py-2 sm:flex-row sm:items-center sm:gap-3" data-testid={`conversation-${c.id}`}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm text-fg">{c.title}</span>
            <Badges c={c} />
          </div>
          <div className={`truncate ${fine} text-fg-3`}>
            {many ? `${plural(group.attempts, "session")} · last ${when(c.startedAt)}` : `${when(c.startedAt)} · ${length(c)} · ${turnsLabel(c.turnCount)}`}
          </div>
          {c.summary && <p className={`mt-0.5 ${fine} text-fg-2`}>{c.summary}</p>}
        </div>
        <div className="-ml-2 flex shrink-0 flex-wrap items-center gap-1 sm:ml-0">
          <PracticeAgainButton c={c} onPracticeAgain={onPracticeAgain} />
          <Button variant="ghost" className={small} onClick={() => onOpen(c)}>
            {many ? "Open latest" : "Open"}
          </Button>
          {many && (
            <Button
              variant="ghost"
              className={small}
              aria-expanded={expanded}
              data-testid={`scene-toggle-${group.sceneKey}`}
              onClick={() => {
                const was = expanded;
                setExpanded(!was);
                if (!was && items == null) void page(0);
              }}
            >
              {expanded ? "Hide" : `All ${group.attempts}`}
            </Button>
          )}
          <DeleteButton
            label={many ? `Delete all ${group.attempts} sessions of ${c.title}` : `Delete ${c.title}`}
            onClick={() => void (many ? onDeleteScene(group) : onDelete(c))}
            testId="history-delete"
          />
        </div>
      </div>
      {many && expanded && (
        <div className="border-t border-line bg-raised/40 pl-4">
          {error && <p className={`${fine} p-2 text-err`}>{error}</p>}
          {items == null && !error && <p className={`${fine} p-2 text-fg-3`}>Loading…</p>}
          <ul aria-label={`Sessions of ${c.title}`}>
            {(items ?? []).map((x) => (
              <li key={x.id} className="flex flex-col gap-1 border-b border-line py-2 pr-4 pl-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-3" data-testid={`conversation-${x.id}`}>
                <div className="min-w-0 flex-1">
                  <div className={`flex items-center gap-2 ${fine} text-fg-2`}>
                    <span className="truncate">{when(x.startedAt)} · {length(x)} · {turnsLabel(x.turnCount)}</span>
                    <Badges c={x} />
                  </div>
                  {x.summary && <p className={`mt-0.5 ${fine} text-fg-3`}>{x.summary}</p>}
                </div>
                <div className="-ml-2 flex shrink-0 flex-wrap items-center gap-1 sm:ml-0">
                  <PracticeAgainButton c={x} onPracticeAgain={onPracticeAgain} />
                  <Button variant="ghost" className={small} onClick={() => onOpen(x)}>
                    Open
                  </Button>
                  <DeleteButton
                    label={`Delete ${x.title} of ${when(x.startedAt)}`}
                    // The scene's header is listed again by the parent; this
                    // list is the row's own, so it drops the session itself.
                    onClick={async () => {
                      if (await onDelete(x)) setItems((was) => (was ?? []).filter((y) => y.id !== x.id));
                    }}
                    testId="history-delete-one"
                  />
                </div>
              </li>
            ))}
          </ul>
          {next != null && (
            <Button variant="ghost" className={`${small} my-1`} onClick={() => void page(next)}>
              Show older
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** The last 7 days, counted, and the digest written once a day (the server
 *  starts today's when the card asks and it is due; the card asks again
 *  while it is being written). */
function WeekCard() {
  const [data, setData] = useState<OverviewReply | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const began = Date.now();
    const ask = () =>
      getOverview().then(
        (r) => {
          if (!live) return;
          setData(r);
          if (r.digest?.status === "pending" && Date.now() - began < DIGEST_POLL_FOR_MS) timer = setTimeout(ask, DIGEST_POLL_MS);
        },
        (e) => {
          if (live) setError(errText(e));
        },
      );
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  if (error) return <p className={`${fine} text-fg-3`}>The week's summary couldn't be loaded: {error}</p>;
  const stats = data?.stats;
  const digest = data?.digest;
  if (!stats) return null;
  if (!stats.sessions && !digest?.text) return null;
  return (
    <Card className="flex flex-col gap-2" data-testid="week-card">
      <h2 className="text-sm font-medium text-fg">Your last 7 days</h2>
      <p className="text-sm text-fg-2 tabular-nums" data-testid="week-stats">
        {plural(stats.sessions, "session")} · {stats.minutes} min · {plural(stats.scenes, "scene")} · {plural(stats.kept, "phrase")} kept
      </p>
      {stats.recurring.length > 0 && (
        <div className={`${fine} text-fg-2`} data-testid="week-recurring">
          <span className="text-fg-3">Keeps coming back: </span>
          {stats.recurring.map((r, i) => (
            <span key={r.better}>
              {i > 0 && "; "}
              <span className="text-fg">{r.better}</span> <span className="text-fg-3">(×{r.count})</span>
            </span>
          ))}
        </div>
      )}
      {digest && (digest.text || digest.status === "pending") && (
        <div className="flex flex-col gap-1 border-t border-line pt-2" data-testid="week-digest">
          {digest.text && <p className="text-sm text-fg">{digest.text}</p>}
          <p className={`${fine} text-fg-3`}>
            {digest.status === "pending"
              ? digest.text
                ? "A newer note is being written…"
                : "Writing your note for the week…"
              : `Written ${digest.writtenAt ? when(digest.writtenAt) : ""} from ${plural(digest.sessions, "session")}${
                  digest.status === "failed" ? " · today's update couldn't be written" : digest.status === "stale" ? " · newer sessions since; it is rewritten once a day" : ""
                }`}
          </p>
        </div>
      )}
    </Card>
  );
}

/** One saved conversation, read-only: every page of its turns, then the
 *  transcript as the session showed it. */
function ConversationView({ id, bankLanguage, onBack, onDelete, onPracticeAgain }: {
  id: string;
  bankLanguage?: unknown;
  onBack: () => void;
  onDelete: () => void;
  onPracticeAgain?: (c: ConversationSummary) => Promise<void>;
}) {
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
        {c && <PracticeAgainButton c={c} onPracticeAgain={onPracticeAgain} />}
        <Button variant="ghost" className={`${small} text-err`} onClick={onDelete} disabled={!c}>
          <TrashGlyph /> Delete
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
              {c.randomScene && " · random scene"}
              {c.buildsOn && ` · built on the session of ${when(c.buildsOn.startedAt)}`}
              {!c.endedAt && " · still open"}
            </p>
          </div>
          {entries.length > 0 && <RubyToggle locale={locale} className="self-end" />}
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
              canStar={inBankLanguage(bankLanguage, c.targetLanguage)}
            />
          )}
          {glosses.length > 0 && <p className="text-xs text-fg-3">Tap an underlined word for its meaning.</p>}
          {c.endedAt && <SessionRecap id={c.id} locale={locale} />}
        </>
      )}
    </div>
  );
}
