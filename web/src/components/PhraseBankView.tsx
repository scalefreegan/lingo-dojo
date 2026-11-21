import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, addPhrase, deletePhrase, getPhrase, listPhrases, updatePhrase, type PhraseQuery } from "../api";
import type { MasteryBand, PhraseDetail, PhraseShow, PhraseSort, PhraseSummary, PhrasesReply } from "../types";
import { hanChars, scriptFor } from "../script/script.ts";
import { CharTerm, RubyText, RubyToggle } from "./Ruby";
import { Badge, Button, inputClass } from "./ui";
import { PictureSection, PicturesBar } from "./WordPictures";

/* Phrase bank, in the Library tab: the active language's phrases
 * (docs/DATA.md §Phrase bank), what the dojo master glossed, the scenes'
 * lists and what the learner starred or added, each with how well it is
 * known (the weakest card's band), when it was last seen and practised,
 * when it is due, and a trouble marker. Search, filter and sort happen on
 * the server (GET /api/phrases), a page at a time. Opening a phrase shows
 * its examples and lets it be edited, suspended or deleted. Practising
 * (flashcards, reviews) is a later phase: until then every band is New. */

const PAGE = 50;
const small = "px-2 py-1 text-sm sm:text-xs";
const fine = "text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));

const SHOWS: [PhraseShow, string][] = [
  ["all", "All"],
  ["starred", "Starred"],
  ["new", "New"],
  ["due", "Due"],
  ["trouble", "Trouble"],
  ["pending", "No words yet"],
  ["suspended", "Suspended"],
  ["pictures", "With picture"],
];
const SORTS: [PhraseSort, string][] = [
  ["recent", "Recently seen"],
  ["due", "Due first"],
  ["weakest", "Weakest first"],
  ["alpha", "A to Z"],
  ["added", "Newest added"],
];
const BANDS: MasteryBand[] = ["New", "Learning", "Familiar", "Mastered"];
const BAND_TONE: Record<MasteryBand, "neutral" | "warn" | "accent"> = { New: "neutral", Learning: "warn", Familiar: "accent", Mastered: "accent" };
const BAND_HINT: Record<MasteryBand, string> = {
  New: "Not practised yet",
  Learning: "Remembered for less than 3 days",
  Familiar: "Remembered for 3 to 21 days",
  Mastered: "Remembered for 21 days or more",
};

const DAY = 86_400_000;

/** "today", "yesterday", "5 days ago", else the date. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** "due now", "due within a day", "due in 4 days"; "new, ready to learn"
 *  for a phrase never practised (mastery New, the "new" filter); "" for a
 *  pending or suspended one. */
function dueLabel(p: PhraseSummary): string {
  if (p.pending || p.suspended) return "";
  if (p.mastery === "New") return "new, ready to learn";
  if (!p.due) return "";
  const ms = new Date(p.due).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const days = Math.ceil(ms / DAY);
  return days <= 1 ? "due within a day" : `due in ${days} days`;
}

/** `initialQuery`: a search to open with (a session recap's "In the bank"). */
export default function PhraseBankView({ initialQuery = "" }: { initialQuery?: string } = {}) {
  const [q, setQ] = useState(initialQuery);
  // Bumped when a word's picture changed in its detail (or the word was
  // deleted): the pictures' status line above reads its counts again.
  const [pictureChanges, setPictureChanges] = useState(0);
  // Bumped when a drawing run the status line watched has ended (Draw
  // pictures, Redraw all in the current style): an open word's picture is
  // read again, so it never shows the picture a run replaced.
  const [picturesDrawn, setPicturesDrawn] = useState(0);
  const onDrawn = useCallback(() => setPicturesDrawn((n) => n + 1), []);
  const [query, setQuery] = useState<Required<Pick<PhraseQuery, "q" | "show" | "band" | "sort">>>({ q: initialQuery.trim(), show: "all", band: "", sort: "recent" });
  const [data, setData] = useState<PhrasesReply | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped to re-read what is listed (after a write).
  const [reload, setReload] = useState(0);
  const shown = useRef(PAGE);
  // Which list a reply belongs to: bumped whenever the list is read afresh
  // (new filters, a write), so a Show more page still on its way for the
  // old one is dropped instead of appended to the new one (and its counts
  // and offsets kept). The in-flight Show more is aborted too.
  const generation = useRef(0);
  const moreCtrl = useRef<AbortController | null>(null);

  // The search box settles for a moment before it asks.
  useEffect(() => {
    const t = setTimeout(() => setQuery((was) => (was.q === q.trim() ? was : { ...was, q: q.trim() })), 250);
    return () => clearTimeout(t);
  }, [q]);

  // The first page for these filters, or, after a write, as many as were
  // listed (so a page loaded with More doesn't collapse). State is only set
  // from the reply.
  useEffect(() => {
    const ctrl = new AbortController();
    generation.current++;
    moreCtrl.current?.abort();
    listPhrases({ ...query, offset: 0, limit: Math.min(200, Math.max(PAGE, shown.current)) }, ctrl.signal).then(
      (r) => {
        shown.current = r.phrases.length;
        setData(r);
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (ctrl.signal.aborted) return;
        setError(errText(e));
        setLoading(false);
      },
    );
    return () => ctrl.abort();
  }, [query, reload, pictureChanges, picturesDrawn]); // a picture drawn, redrawn or removed moves the "With picture" count

  function setFilter(patch: Partial<typeof query>) {
    shown.current = PAGE;
    setLoading(true);
    setQuery((was) => ({ ...was, ...patch }));
  }

  async function more(offset: number) {
    const mine = generation.current;
    moreCtrl.current?.abort();
    const ctrl = (moreCtrl.current = new AbortController());
    setLoading(true);
    try {
      const r = await listPhrases({ ...query, offset, limit: PAGE }, ctrl.signal);
      if (mine !== generation.current) return; // a page of a list no longer shown
      setData((was) => (was ? { ...r, phrases: [...was.phrases, ...r.phrases.filter((p) => !was.phrases.some((x) => x.id === p.id))] } : r));
      shown.current += r.phrases.length;
      setLoading(false);
    } catch (e) {
      if (ctrl.signal.aborted || mine !== generation.current) return;
      setError(errText(e));
      setLoading(false);
    }
  }

  /** After a write: re-read the list (its filters and counts may have moved). */
  const refresh = () => setReload((n) => n + 1);

  const lang = data?.language;
  const languageName = lang ? lang.targetVariant || lang.targetLanguage : "";
  const counts = data?.counts;

  return (
    <div className="flex flex-col gap-3" data-testid="phrase-bank">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium text-fg">Phrase bank{languageName ? ` · ${languageName}` : ""}</h2>
        {counts && <span className={`${fine} text-fg-3`}>{counts.all === 1 ? "1 phrase" : `${counts.all} phrases`}</span>}
        <RubyToggle locale={lang?.locale} className="ml-auto" />
      </div>
      <AddForm
        onAdded={(created, p) => {
          setNotice(created ? `Added “${p.text}”.` : `“${p.text}” was already in your bank; it is starred now.`);
          refresh();
        }}
      />
      {/* The word game's pictures: a kids learner's grown-up's side, or an adult's own (ld-318). */}
      <PicturesBar refresh={pictureChanges} onDrawn={onDrawn} />
      {notice && (
        <p className={`${fine} text-fg-2`} role="status">
          {notice}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            className={`${inputClass} min-w-0 flex-1 sm:max-w-xs`}
            placeholder="Search words, meanings, notes"
            aria-label="Search the phrase bank"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select aria-label="Mastery" className={`${inputClass} w-auto`} value={query.band} onChange={(e) => setFilter({ band: e.target.value as MasteryBand | "" })}>
            <option value="">Any mastery</option>
            {BANDS.map((b) => (
              <option key={b} value={b}>
                {b}
                {counts ? ` (${counts.bands[b]})` : ""}
              </option>
            ))}
          </select>
          <select aria-label="Sort" className={`${inputClass} w-auto`} value={query.sort} onChange={(e) => setFilter({ sort: e.target.value as PhraseSort })}>
            {SORTS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          {SHOWS.map(([v, label]) => {
            const n = counts ? (v === "all" ? counts.all : counts[v]) : null;
            const on = query.show === v;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={on}
                className={`rounded-full border px-2.5 py-0.5 ${fine} ${on ? "border-accent bg-accent-soft text-accent" : "border-line text-fg-2 hover:bg-raised"}`}
                onClick={() => setFilter({ show: v })}
              >
                {label}
                {n != null && <span className="ml-1 text-fg-3">{n}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {error && <p className="rounded-md bg-err-soft p-3 text-sm text-err">{error}</p>}
      {data && !error && data.phrases.length === 0 && !loading && (
        <p className="text-sm text-fg-3">
          {counts?.all
            ? "Nothing matches."
            : "Empty so far. Words the dojo master explains in a session land here, and so does anything you star (☆ under a tapped word) or add above."}
        </p>
      )}
      {data && data.phrases.length > 0 && (
        <ul className="overflow-hidden rounded-lg border border-line" aria-label="Phrases">
          {data.phrases.map((p) => (
            <PhraseRow
              key={p.id}
              p={p}
              locale={lang?.locale ?? undefined}
              open={openId === p.id}
              onToggle={() => setOpenId((id) => (id === p.id ? null : p.id))}
              onChanged={refresh}
              onPictureChanged={() => setPictureChanges((n) => n + 1)}
              picturesDrawn={picturesDrawn}
              onDeleted={() => {
                setOpenId(null);
                setPictureChanges((n) => n + 1);
                setNotice(`Deleted “${p.text ?? p.meaning}”.`);
                refresh();
              }}
            />
          ))}
        </ul>
      )}
      {loading && <p className="text-sm text-fg-3">Loading…</p>}
      {!loading && data?.nextOffset != null && (
        <Button variant="ghost" className={`${small} self-start`} onClick={() => void more(data.nextOffset!)}>
          Show more ({data.total - data.phrases.length} left)
        </Button>
      )}
    </div>
  );
}

function AddForm({ onAdded }: { onAdded: (created: boolean, p: PhraseDetail) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [meaning, setMeaning] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await addPhrase({ text, meaning: meaning || null, note: note || null });
      setText("");
      setMeaning("");
      setNote("");
      onAdded(!!r.created, r.phrase);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="ghost" className={`${small} self-start`} onClick={() => setOpen(true)} data-testid="phrase-add-open">
        + Add a phrase
      </Button>
    );
  }
  return (
    <form className="flex flex-col gap-2 rounded-lg border border-line p-3" onSubmit={(e) => void submit(e)} aria-label="Add a phrase">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className={inputClass} placeholder="Words (in the language you're learning)" aria-label="Words" value={text} onChange={(e) => setText(e.target.value)} maxLength={200} autoFocus />
        <input className={inputClass} placeholder="Meaning (optional)" aria-label="Meaning" value={meaning} onChange={(e) => setMeaning(e.target.value)} maxLength={300} />
      </div>
      <input className={inputClass} placeholder="Note (optional)" aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      {error && <p className="text-sm text-err">{error}</p>}
      <div className="flex gap-2">
        <Button variant="primary" type="submit" className={small} disabled={!text.trim() || busy}>
          Add, starred
        </Button>
        <Button variant="ghost" className={small} onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}

function PhraseRow({
  p,
  locale,
  open,
  onToggle,
  onChanged,
  onPictureChanged,
  picturesDrawn = 0,
  onDeleted,
}: {
  p: PhraseSummary;
  locale?: string;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onPictureChanged?: () => void;
  picturesDrawn?: number;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Parameters<typeof updatePhrase>[1]) {
    setBusy(true);
    setError(null);
    try {
      await updatePhrase(p.id, body);
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const meta = [
    p.seenCount ? `seen ${p.seenCount}×, last ${ago(p.lastSeenAt)}` : "not met in a session yet",
    `practised ${ago(p.lastPracticedAt)}`,
    dueLabel(p),
  ].filter(Boolean);

  return (
    <li className={`border-b border-line px-4 py-2 last:border-b-0 ${p.suspended ? "opacity-70" : ""}`} data-testid={`phrase-${p.id}`}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          className={`-ml-1 grid size-7 shrink-0 place-items-center rounded text-base ${p.starred ? "text-accent" : "text-fg-3 hover:text-fg"}`}
          aria-pressed={p.starred}
          aria-label={p.starred ? `Unstar ${p.text ?? p.meaning}` : `Star ${p.text ?? p.meaning}`}
          title={p.starred ? "Starred: tap to unstar" : "Star"}
          disabled={busy}
          onClick={() => void patch({ starred: !p.starred })}
        >
          {p.starred ? "★" : "☆"}
        </button>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onToggle} aria-expanded={open}>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {p.text ? (
              <span className="font-medium text-accent" lang={locale}>
                <RubyText text={p.text} locale={locale} reading={p.reading} />
              </span>
            ) : (
              <span className="text-fg-3 italic">no words yet</span>
            )}
            {p.meaning && <span className="text-sm text-fg-2">{p.meaning}</span>}
            {!p.pending && (
              <Badge tone={BAND_TONE[p.mastery]} title={BAND_HINT[p.mastery]}>
                {p.mastery}
              </Badge>
            )}
            {p.trouble && (
              <Badge tone="err" title={`${p.lapses} lapses in the last 30 days`}>
                ⚠ trouble
              </Badge>
            )}
            {p.pending && <Badge title="From a scene's list: the dojo master hasn't given its words yet">no words yet</Badge>}
            {p.suspended && <Badge title="Left out of practice and recall">suspended</Badge>}
          </span>
          <span className={`mt-0.5 block ${fine} text-fg-3`}>{meta.join(" · ")}</span>
        </button>
      </div>
      {error && <p className="mt-1 text-sm text-err">{error}</p>}
      {open && <PhraseDetailView id={p.id} locale={locale} summary={p} onChanged={onChanged} onPictureChanged={onPictureChanged} picturesDrawn={picturesDrawn} onDeleted={onDeleted} />}
    </li>
  );
}

// How long a removed alternate can be put back before it is removed.
const ALT_UNDO_MS = 5000;

function PhraseDetailView({
  id,
  locale,
  summary,
  onChanged,
  onPictureChanged,
  picturesDrawn = 0,
  onDeleted,
}: {
  id: string;
  locale?: string;
  summary: PhraseSummary;
  onChanged: () => void;
  onPictureChanged?: () => void;
  picturesDrawn?: number;
  onDeleted: () => void;
}) {
  const [detail, setDetail] = useState<PhraseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ text: "", meaning: "", note: "" });

  // Removing an alternate (×), in three steps, each shown as it is:
  //  - undoable: hidden at once, "Removed … Undo" for ALT_UNDO_MS. Only this
  //    one, in `pendingAlt` (a ref, so the timer, a second × and Undo all
  //    see the same one on the same tick);
  //  - sending: the moment the window closes (the timer, a second ×, the
  //    panel closing) it leaves `pendingAlt` and Undo goes with it, so Undo
  //    is never offered for a removal that can no longer be stopped:
  //    "Removing …" until the reply;
  //  - done: kept hidden until the phrase is read again without it; on an
  //    error the chip comes back with the message.
  // Each removal carries the phrase id it was made on and is sent once.
  const [undoable, setUndoable] = useState<string | null>(null);
  const [sending, setSending] = useState<string[]>([]);
  const [gone, setGone] = useState<string[]>([]);
  const pendingAlt = useRef<{ alt: string; phraseId: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  /** Close the Undo window on the pending removal, if any, and send it. */
  function commitAlt() {
    const p = pendingAlt.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingAlt.current = null;
    setUndoable((cur) => (cur === p.alt ? null : cur));
    setSending((s) => [...s, p.alt]);
    updatePhrase(p.phraseId, { removeAlternates: [p.alt] }).then(
      () => {
        setGone((g) => [...g, p.alt]);
        setSending((s) => s.filter((a) => a !== p.alt));
        // The list re-reads, and so this phrase (no setDetail from the
        // reply: two removals' replies can arrive in either order).
        onChanged();
      },
      (e: unknown) => {
        setSending((s) => s.filter((a) => a !== p.alt));
        setError(`Couldn't remove “${p.alt}”: ${errText(e)}`);
      },
    );
  }

  function removeAlt(alt: string) {
    commitAlt(); // one already waiting is sent now, not lost
    setError(null);
    pendingAlt.current = { alt, phraseId: id, timer: setTimeout(commitAlt, ALT_UNDO_MS) };
    setUndoable(alt);
  }

  function undoRemoveAlt(alt: string) {
    // Only the removal still waiting, and only if it is this one: had the
    // timer fired first on this tick, it is already being sent and stays so.
    const p = pendingAlt.current;
    if (!p || p.alt !== alt) return;
    clearTimeout(p.timer);
    pendingAlt.current = null;
    setUndoable(null);
  }

  // Closing the panel (or moving to another phrase) inside the Undo window
  // still removes it, as shown, from the phrase it was made on. Nothing is
  // left to report to then: if it fails, the alternate stays, which only
  // means it is still accepted.
  useEffect(
    () => () => {
      const p = pendingAlt.current;
      if (!p) return;
      clearTimeout(p.timer);
      pendingAlt.current = null;
      updatePhrase(p.phraseId, { removeAlternates: [p.alt] }).catch(() => {});
    },
    [id],
  );

  const hiddenAlts = [...(undoable ? [undoable] : []), ...sending, ...gone];

  // Re-read whenever the list row changes (an edit, a star).
  useEffect(() => {
    const ctrl = new AbortController();
    getPhrase(id, ctrl.signal).then(
      (r) => {
        setDetail(r.phrase);
        // A removed one stays hidden only while the phrase still has it
        // (a read from before the removal landed); once it is read without
        // it, forget it, so one the grader saves again later shows.
        setGone((g) => (g.every((a) => r.phrase.alternates.includes(a)) ? g : g.filter((a) => r.phrase.alternates.includes(a))));
      },
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => ctrl.abort();
  }, [id, summary]);

  async function run(fn: () => Promise<unknown>, after: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    if (!detail) return;
    setForm({ text: detail.text ?? "", meaning: detail.meaning ?? "", note: detail.note ?? "" });
    setEditing(true);
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    // Only what changed: words left blank on a phrase with none stay none.
    const body: Parameters<typeof updatePhrase>[1] = {};
    if (form.text.trim() && form.text.trim() !== (detail.text ?? "")) body.text = form.text;
    if (form.meaning.trim() !== (detail.meaning ?? "")) body.meaning = form.meaning.trim() || null;
    if (form.note.trim() !== (detail.note ?? "")) body.note = form.note.trim() || null;
    if (!Object.keys(body).length) return setEditing(false);
    void run(() => updatePhrase(id, body), () => {
      setEditing(false);
      onChanged();
    });
  }

  function remove() {
    const label = detail?.text ?? detail?.meaning ?? "this phrase";
    if (!window.confirm(`Delete “${label}” from your phrase bank?\nIts examples and practice history go with it. A scene's word list won't add it back; if a session explains it again, it comes back then.`)) return;
    void run(() => deletePhrase(id), onDeleted);
  }

  if (!detail) return <p className={`mt-2 ${fine} ${error ? "text-err" : "text-fg-3"}`}>{error ?? "Loading…"}</p>;
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg bg-raised/60 p-3 text-sm" data-testid="phrase-detail">
      {editing ? (
        <form className="flex flex-col gap-2" onSubmit={save} aria-label="Edit phrase">
          <input className={inputClass} aria-label="Words" placeholder={detail.pending ? "Words (none yet)" : "Words"} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} maxLength={200} lang={locale} />
          <input className={inputClass} aria-label="Meaning" placeholder="Meaning" value={form.meaning} onChange={(e) => setForm({ ...form, meaning: e.target.value })} maxLength={300} />
          <textarea className={inputClass} aria-label="Note" placeholder="Note" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={1000} />
          <div className="flex gap-2">
            <Button variant="primary" type="submit" className={small} disabled={busy}>
              Save
            </Button>
            <Button variant="ghost" className={small} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {detail.note && <p className="whitespace-pre-wrap text-fg-2">{detail.note}</p>}
          {/* Mandarin: each character opens the character card (not for Japanese or Cantonese, where CharTerm draws no tiles). */}
          {detail.text && scriptFor(locale) && hanChars(detail.text).length > 0 && (
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className={`${fine} text-fg-3`}>Characters</span>
              <CharTerm text={detail.text} locale={locale} reading={detail.reading} className="text-lg font-medium text-accent" />
            </p>
          )}
          <dl className={`grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 ${fine} text-fg-3`}>
            <dt>First met</dt>
            <dd>
              {detail.firstSeenAt ? ago(detail.firstSeenAt) : "not yet"}
              {detail.lang ? ` (${detail.lang})` : ""} · from {SOURCE[detail.source]}
            </dd>
            <dt>Cards</dt>
            <dd>{detail.cardCount ? `${detail.cardCount} (${detail.mastery}${dueLabel(detail) ? `, ${dueLabel(detail)}` : ""})` : "none yet"}</dd>
            {detail.lapses > 0 && (
              <>
                <dt>Lapses</dt>
                <dd>{detail.lapses} in the last 30 days</dd>
              </>
            )}
            {(detail.alternates.length > 0 || undoable || sending.length > 0) && (
              <>
                <dt>Also accepted</dt>
                <dd className="flex flex-col gap-1">
                  {/* Other wordings the practice grader accepted and saved.
                      Removal only: × hides one, and only after a few
                      seconds without Undo is it removed (by name, so one
                      the grader saved meanwhile stays; see commitAlt). A
                      right one comes back the next time the grader
                      accepts it. */}
                  <ul className="flex flex-wrap gap-1.5" aria-label="Also accepted">
                    {detail.alternates
                      .filter((a) => !hiddenAlts.includes(a))
                      .map((alt) => (
                        <li key={alt} className="inline-flex items-center gap-0.5 rounded-full bg-raised py-0.5 pr-0.5 pl-2.5">
                          <RubyText text={alt} locale={locale} />
                          <button
                            type="button"
                            className="inline-grid min-w-10 place-items-center rounded-full text-base text-fg-3 hover:bg-line hover:text-fg disabled:opacity-50 sm:min-h-7 sm:min-w-7"
                            aria-label={`Remove “${alt}” from also accepted`}
                            title="Remove"
                            onClick={() => removeAlt(alt)}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                  </ul>
                  <div role="status" className="flex flex-col gap-0.5">
                    {sending.map((alt) => (
                      <p key={alt}>
                        Removing “<RubyText text={alt} locale={locale} />”…
                      </p>
                    ))}
                    {undoable && (
                      <p className="flex flex-wrap items-center gap-2">
                        <span>
                          Removed “<RubyText text={undoable} locale={locale} />”.
                        </span>
                        <Button variant="ghost" className={small} onClick={() => undoRemoveAlt(undoable)}>
                          Undo
                        </Button>
                      </p>
                    )}
                  </div>
                </dd>
              </>
            )}
          </dl>
          {detail.examples.length > 0 ? (
            <div>
              <h3 className={`${fine} font-medium text-fg-2`}>Heard in</h3>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {detail.examples.map((ex) => (
                  <li key={ex.id} className="text-fg" lang={locale}>
                    “<RubyText text={ex.sentence} locale={locale} />”<span className={`${fine} text-fg-3`}> · {ago(ex.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className={`${fine} text-fg-3`}>No examples yet: they come from the lines the dojo master glosses it in.</p>
          )}
          {!detail.pending && <PictureSection phraseId={id} onChanged={onPictureChanged} reload={picturesDrawn} />}
          <div className="-ml-2 flex flex-wrap gap-1">
            <Button variant="ghost" className={small} onClick={startEdit} disabled={busy}>
              Edit
            </Button>
            <Button variant="ghost" className={small} onClick={() => void run(() => updatePhrase(id, { suspended: !detail.suspended }), onChanged)} disabled={busy}>
              {detail.suspended ? "Unsuspend" : "Suspend"}
            </Button>
            <Button variant="ghost" className={`${small} text-err`} onClick={remove} disabled={busy}>
              Delete
            </Button>
          </div>
        </>
      )}
      {error && <p className="text-sm text-err">{error}</p>}
    </div>
  );
}

const SOURCE: Record<PhraseDetail["source"], string> = {
  gloss: "a gloss in a session",
  extraction: "a session recap",
  manual: "you",
  scenario: "a scene's list",
};
