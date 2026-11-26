import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api";
import { addStockConcept, changeStockPicture, drawMissingStock, pictureReports, resolvePictureReport, setStockAdults, setStockGroup, pictureBlob, stockPictureBlob, stockPictures, wordPictures } from "../gameApi";
import type { PictureReportView, RedrawReason, StockConceptView, StockListReply, WordPictureItem, WordPicturesReply } from "../types";
import { PictureSection, PicturesBar } from "./WordPictures";
import { Badge, Button, Card, inputClass } from "./ui";

/* The picture library (bead ld-318; docs/DATA.md §Stock pictures): a page
 * of its own, reached from the ⋯ menu (adult learners only: a kids
 * learner's menu doesn't offer it, though its routes answer the session
 * like the rest of the kids Library). Two sections:
 *  - My word pictures: every word of the active language with a picture or
 *    a verdict, filterable by status, each with the Phrase bank's own
 *    actions (Draw it anyway, Draw again, Remove picture: WordPictures'
 *    PictureSection), the status line with Draw pictures and Redraw all in
 *    the current style (PicturesBar), and today's pictures against the cap.
 *  - Shared library: the whole stock set by category, drawn or "not drawn
 *    yet". Everyone browses it; an admin also draws a missing one, redraws
 *    one, deletes one added here, draws every missing one (the count and
 *    the estimated cost shown before confirming), and adds a concept. The
 *    server enforces all of that (403 for anyone else); the page only
 *    hides what the server would refuse.
 * The page polls only reads (the counts, the list) and only while
 * something is being drawn. */

const fine = "text-sm sm:text-xs";
const small = "px-2 py-1 text-sm sm:text-xs";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error)?.message || e));
const POLL_MS = 3000;

export default function PictureLibraryView() {
  return (
    <div className="flex flex-col gap-6" data-testid="picture-library">
      <div className="flex flex-col gap-1">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-fg">Picture library</h2>
        <p className={`${fine} text-fg-3`}>The pictures of the word game: your own words' and the shared set everyone's words can use.</p>
      </div>
      <MyWordPictures />
      <SharedLibrary />
    </div>
  );
}

/* ------------------------------- my word pictures ----------------------------- */

type Filter = "all" | "ready" | "stock" | "none" | "failed" | "drawing" | "removed";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ready", label: "Ready" },
  { value: "stock", label: "Shared picture" },
  { value: "drawing", label: "Being drawn" },
  { value: "none", label: "No picture" },
  { value: "failed", label: "Failed" },
  { value: "removed", label: "Removed" },
];

/** Which filter a word falls under (one each, so the counts add up). */
function filterOf(w: WordPictureItem): Exclude<Filter, "all"> {
  const p = w.picture;
  if (p.status === "pending" || p.restyling) return "drawing";
  if (p.status === "ready") return p.stock ? "stock" : "ready";
  return p.status;
}

const STATUS_BADGE: Record<Exclude<Filter, "all">, { label: string; tone: "accent" | "neutral" | "warn" | "err" }> = {
  ready: { label: "Ready", tone: "accent" },
  stock: { label: "Shared", tone: "accent" },
  drawing: { label: "Being drawn", tone: "warn" },
  none: { label: "No picture", tone: "neutral" },
  failed: { label: "Failed", tone: "err" },
  removed: { label: "Removed", tone: "neutral" },
};

function MyWordPictures() {
  const [reply, setReply] = useState<WordPicturesReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  // Bumped after any picture action, and when a drawing run ends: the list
  // and the status line read again.
  const [changes, setChanges] = useState(0);
  const [drawn, setDrawn] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    wordPictures(ctrl.signal).then(
      (r) => {
        setReply(r);
        setError(null);
      },
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => ctrl.abort();
  }, [changes, drawn]);

  const counts = useMemo(() => {
    const out: Record<Filter, number> = { all: 0, ready: 0, stock: 0, none: 0, failed: 0, drawing: 0, removed: 0 };
    for (const w of reply?.words ?? []) {
      out.all++;
      out[filterOf(w)]++;
    }
    return out;
  }, [reply]);
  const shown = (reply?.words ?? []).filter((w) => filter === "all" || filterOf(w) === filter);
  const status = reply?.status;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="my-pictures" data-testid="my-word-pictures">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id="my-pictures" className="font-[family-name:var(--font-display)] text-base font-semibold text-fg">
          My word pictures
        </h3>
        {status && (
          <span className={`${fine} text-fg-3`} data-testid="my-pictures-usage">
            {status.imagesToday} of {status.imagesCap} pictures drawn for this language in the last 24 hours
          </span>
        )}
      </div>
      <PicturesBar refresh={changes} onDrawn={() => setDrawn((n) => n + 1)} />
      <Card className="flex flex-col gap-3">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          {FILTERS.filter((f) => f.value === "all" || f.value === filter || counts[f.value] > 0).map((f) => (
            <Chip key={f.value} on={filter === f.value} onClick={() => setFilter(f.value)}>
              {f.label} <span className="tabular-nums text-fg-3">{counts[f.value]}</span>
            </Chip>
          ))}
        </div>
        {!reply ? (
          error ? <p className={`${fine} text-err`}>{error}</p> : <p className={`${fine} text-fg-3`}>Loading…</p>
        ) : shown.length === 0 ? (
          <p className={`${fine} text-fg-3`}>
            {counts.all === 0
              ? "No word has been looked at for a picture yet. Words from your sessions are, after each session; or press Draw pictures above."
              : "No word in this group."}
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="my-pictures-grid">
            {shown.map((w) => {
              const isOpen = open === w.phraseId;
              const kind = filterOf(w);
              return (
                <WordTile key={w.phraseId} w={w} kind={kind} open={isOpen} onToggle={() => setOpen(isOpen ? null : w.phraseId)}>
                  {isOpen && (
                    <li className="col-span-full rounded-xl border border-line bg-raised/40 p-3" data-testid="my-picture-detail">
                      <PictureSection phraseId={w.phraseId} reload={drawn} onChanged={() => setChanges((n) => n + 1)} />
                    </li>
                  )}
                </WordTile>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}

/** One word's tile, and (after it, across the row) its detail when open. */
function WordTile({ w, kind, open, onToggle, children }: { w: WordPictureItem; kind: Exclude<Filter, "all">; open: boolean; onToggle: () => void; children: ReactNode }) {
  const url = useBlobUrl(w.picture.file ? `${w.picture.id}/${w.picture.file}` : null, (signal) => pictureBlob(w.picture.id, w.picture.file!, signal));
  const badge = STATUS_BADGE[kind];
  return (
    <>
      <li>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={`flex w-full flex-col gap-1.5 rounded-xl border p-2 text-left transition-colors hover:bg-raised ${open ? "border-accent" : "border-line"}`}
          data-testid="my-picture-tile"
        >
          <div className="grid aspect-square w-full place-items-center overflow-hidden rounded-lg bg-raised">
            {url ? <img src={url} alt="" className="size-full object-cover" /> : <span className={`${fine} px-2 text-center text-fg-3`}>{kind === "drawing" ? "Waiting…" : "No picture"}</span>}
          </div>
          <span className="truncate font-medium text-fg">{w.text}</span>
          <span className={`${fine} truncate text-fg-2`}>{w.meaning}</span>
          <span>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </span>
        </button>
      </li>
      {children}
    </>
  );
}

/* -------------------------------- shared library ------------------------------ */

function SharedLibrary() {
  const [list, setList] = useState<StockListReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    stockPictures(ctrl.signal).then(
      (r) => {
        setList(r);
        if (r.drawing) timer = setTimeout(() => setTick((n) => n + 1), POLL_MS);
      },
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [tick]);

  async function act(fn: () => Promise<StockListReply>) {
    setBusy(true);
    setError(null);
    try {
      setList(await fn());
      setTick((n) => n + 1);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const byCategory = useMemo(() => {
    const out = new Map<string, StockConceptView[]>();
    for (const c of list?.concepts ?? []) out.set(c.category, [...(out.get(c.category) ?? []), c]);
    return out;
  }, [list]);
  // Every look-alike group in use (the file's and the added ones'), offered
  // by the Add form and each card's group field: joining an existing group
  // is the usual case (a new drink beside the file's drinks).
  const groups = useMemo(() => [...new Set((list?.concepts ?? []).map((c) => c.group).filter((g): g is string => !!g))].sort(), [list]);

  if (!list) {
    return (
      <section className="flex flex-col gap-3" aria-labelledby="shared-pictures">
        <h3 id="shared-pictures" className="font-[family-name:var(--font-display)] text-base font-semibold text-fg">
          Shared library
        </h3>
        <p className={`${fine} ${error ? "text-err" : "text-fg-3"}`}>{error ?? "Loading…"}</p>
      </section>
    );
  }

  const drawnCount = list.concepts.filter((c) => c.version).length;
  const missing = list.concepts.filter((c) => !c.version && !c.queued).length;
  const left = Math.max(0, list.cap - list.usedToday);
  const drawMissing = () => {
    const n = Math.min(missing, left);
    const cost = (n * list.costEach).toFixed(2);
    const ask = `Draw ${n} missing shared picture${n === 1 ? "" : "s"}${n < missing ? ` (of ${missing}; today's cap leaves room for ${n})` : ""}? At about $${list.costEach.toFixed(3)} each, that is about $${cost}.`;
    if (!window.confirm(ask)) return;
    void act(() => drawMissingStock(missing));
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="shared-pictures" data-testid="shared-library">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id="shared-pictures" className="font-[family-name:var(--font-display)] text-base font-semibold text-fg">
          Shared library
        </h3>
        <span className={`${fine} text-fg-3`} data-testid="shared-counts">
          {drawnCount} of {list.concepts.length} drawn · style {list.theme}
          {list.canEdit ? ` · ${list.usedToday} of ${list.cap} shared pictures drawn in the last 24 hours` : ""}
        </span>
      </div>
      <p className={`${fine} text-fg-2`}>
        Pictures everyone's words can use: a word that means one of these gets its picture at once, with nothing to draw.
        {list.canEdit ? "" : " Only an admin can change this set."}
      </p>
      {list.canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          {missing > 0 && (
            <Button onClick={drawMissing} disabled={busy || !!list.problem || left === 0} data-testid="stock-draw-missing">
              Draw all missing ({missing})
            </Button>
          )}
          <Button variant="ghost" onClick={() => setAdding((a) => !a)} aria-expanded={adding} data-testid="stock-add-toggle">
            {adding ? "Close" : "Add a picture"}
          </Button>
          {list.drawing && (
            <span className={`${fine} text-fg-2`} role="status">
              Drawing…
            </span>
          )}
        </div>
      )}
      {list.canEdit && list.problem && <p className={`${fine} text-warn`}>{list.problem}</p>}
      {list.canEdit && list.stopped && <p className={`${fine} text-warn`} data-testid="stock-stopped">{list.stopped}</p>}
      {error && <p className={`${fine} text-err`} role="alert">{error}</p>}
      {list.canEdit && <Reported concepts={list.concepts} tick={tick} onResolved={() => setTick((n) => n + 1)} />}
      {list.canEdit && (
        <datalist id="stock-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      )}
      {list.canEdit && adding && (
        <AddConcept
          categories={[...byCategory.keys()]}
          busy={busy}
          onAdd={async (body) => {
            const ok = await act(() => addStockConcept(body));
            if (ok) setAdding(false);
            return ok;
          }}
        />
      )}
      {list.canEdit && list.shadowed.length > 0 && (
        <Card className="flex flex-col gap-2" data-testid="stock-shadowed">
          <h4 className={`${fine} font-medium text-warn`}>Shadowed by the app's own list</h4>
          <p className={`${fine} text-fg-2`}>
            The app's list (content/pictures.yaml) now has a picture with the same name as one added here; the app's is used, and the
            added one does nothing. Delete it to tidy up: the picture stays with the app's.
          </p>
          <ul className="flex flex-col gap-1">
            {list.shadowed.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm text-fg" data-shadowed={c.id}>
                <span className="font-medium">{label(c.id)}</span>
                <span className={`${fine} text-fg-3`}>
                  {c.category} · {c.description}
                </span>
                <Button
                  variant="ghost"
                  className={`${small} text-err`}
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Delete the added "${label(c.id)}"? The app's own picture of that name stays.`)) return;
                    void act(() => changeStockPicture(c.id, "remove"));
                  }}
                  data-testid="stock-shadowed-remove"
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {[...byCategory.entries()].map(([category, concepts]) => (
        <Card key={category} className="flex flex-col gap-2">
          <h4 className={`${fine} font-medium text-fg-2`}>
            {category} <span className="text-fg-3 tabular-nums">· {concepts.filter((c) => c.version).length} of {concepts.length}</span>
          </h4>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6" data-testid="stock-grid">
            {concepts.map((c) => (
              <StockTile key={c.id} c={c} canEdit={list.canEdit} busy={busy} blocked={!!list.problem || left === 0} onGroup={(group) => act(() => setStockGroup(c.id, group))} onAct={(action) => {
                if (action === "remove" && !window.confirm(`Delete the shared picture "${label(c.id)}"? Words that use it leave the word game until each is drawn again.`)) return;
                if (action === "draw" && c.version && !window.confirm(`Draw "${label(c.id)}" again, in the current style? About $${list.costEach.toFixed(3)}.`)) return;
                if (action === "adults") {
                  // Setting it is the safe direction (kids lose it at once);
                  // clearing it lets kids' words be matched to it, so ask.
                  if (c.adults && !window.confirm(`Let kids learners see "${label(c.id)}"? Their words can be matched to it from the next picture check.`)) return;
                  void act(() => setStockAdults(c.id, !c.adults));
                  return;
                }
                void act(() => changeStockPicture(c.id, action));
              }} />
            ))}
          </ul>
        </Card>
      ))}
    </section>
  );
}

const label = (id: string) => id.replace(/-/g, " ");

function StockTile({ c, canEdit, busy, blocked, onAct, onGroup }: {
  c: StockConceptView;
  canEdit: boolean;
  busy: boolean;
  blocked: boolean;
  onAct: (action: "draw" | "remove" | "adults") => void;
  onGroup: (group: string | null) => Promise<boolean>;
}) {
  const url = useBlobUrl(c.version ? `${c.id}/${c.version}` : null, (signal) => stockPictureBlob(c.id, c.version!, signal));
  // The group's field, open while an admin edits an added concept's group
  // (the file's are set in content/pictures.yaml, shown only).
  const [editing, setEditing] = useState<string | null>(null);
  async function saveGroup(e: FormEvent) {
    e.preventDefault();
    if (editing !== null && (await onGroup(editing.trim() || null))) setEditing(null);
  }
  return (
    <li className="flex flex-col gap-1" data-testid="stock-tile" data-concept={c.id}>
      <div className="grid aspect-square w-full place-items-center overflow-hidden rounded-lg border border-line bg-raised" title={c.description}>
        {url ? (
          <img src={url} alt={c.description} className="size-full object-cover" />
        ) : (
          <span className={`${fine} px-1 text-center text-fg-3`}>{c.queued ? "Drawing…" : c.refused ? "Refused" : "Not drawn yet"}</span>
        )}
      </div>
      <span className="truncate text-sm font-medium text-fg" title={c.words.join(", ")}>
        {label(c.id)}
      </span>
      {(c.custom || c.adults || canEdit) && (
        <span className="flex flex-wrap items-center gap-1">
          {c.custom && <Badge title="Added from this page">Added</Badge>}
          {canEdit && c.group && editing === null && (
            <span data-testid="stock-group">
              <Badge title={`Look-alike group "${c.group}": never two of one group in a round`}>≈ {c.group}</Badge>
            </span>
          )}
          {c.adults && (
            <span data-testid="stock-adults">
              <Badge tone="warn" title="Adults only: never shown to kids learners">
                Adults only
              </Badge>
            </span>
          )}
          {canEdit && (
            <Button
              variant="ghost"
              className={`${small} -ml-1`}
              disabled={busy}
              aria-pressed={c.adults}
              aria-label={c.adults ? `Let kids see ${label(c.id)}` : `Make ${label(c.id)} adults only`}
              title={c.adults ? "Clear Adults only: kids learners can have this picture" : "Adults only: never shown to kids learners"}
              onClick={() => onAct("adults")}
              data-testid="stock-adults-toggle"
            >
              {c.adults ? "Allow kids" : "Set adults only"}
            </Button>
          )}
        </span>
      )}
      {canEdit && (
        <span className="-ml-2 flex flex-wrap">
          <Button variant="ghost" className={small} disabled={busy || blocked || c.queued} onClick={() => onAct("draw")} data-testid="stock-draw">
            {c.version ? "Redraw" : "Draw"}
          </Button>
          {c.custom && editing === null && (
            <Button
              variant="ghost"
              className={small}
              disabled={busy}
              aria-label={`Look-alike group of ${label(c.id)}`}
              title="Pictures of one look-alike group are never offered together in a round"
              onClick={() => setEditing(c.group ?? "")}
              data-testid="stock-group-edit"
            >
              Group
            </Button>
          )}
          {c.custom && (
            <Button variant="ghost" className={`${small} text-err`} disabled={busy} onClick={() => onAct("remove")} data-testid="stock-remove">
              Delete
            </Button>
          )}
        </span>
      )}
      {canEdit && c.custom && editing !== null && (
        <form className="flex flex-col gap-1" onSubmit={(e) => void saveGroup(e)} data-testid="stock-group-form">
          <label className={`flex flex-col gap-1 ${fine} text-fg-2`}>
            Look-alike group
            <input
              className={inputClass}
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              list="stock-groups"
              placeholder="none"
              maxLength={48}
              autoFocus
              data-testid="stock-group-input"
            />
          </label>
          <span className="-ml-2 flex flex-wrap">
            <Button type="submit" variant="ghost" className={small} disabled={busy} data-testid="stock-group-save">
              Save
            </Button>
            <Button variant="ghost" className={small} disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </span>
        </form>
      )}
    </li>
  );
}

/** An admin's new concept: a name, a category, the English words it stands
 *  for, and what the picture shows (the server checks it like a word's). */
function AddConcept({ categories, busy, onAdd }: { categories: string[]; busy: boolean; onAdd: (body: { name: string; category: string; words: string; description: string; adults: boolean; group: string | null }) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [words, setWords] = useState("");
  const [description, setDescription] = useState("");
  const [adults, setAdults] = useState(false);
  const [group, setGroup] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await onAdd({ name, category, words, description, adults, group: group.trim() || null })) {
      setName("");
      setWords("");
      setDescription("");
      setAdults(false);
      setGroup("");
    }
  }
  return (
    <Card className="flex flex-col gap-3">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => void submit(e)} data-testid="stock-add-form">
        <label className={`flex flex-col gap-1 ${fine} text-fg-2`}>
          Name
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="ice cream" required maxLength={48} />
        </label>
        <label className={`flex flex-col gap-1 ${fine} text-fg-2`}>
          Category
          <input className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)} list="stock-categories" placeholder="Food" required maxLength={40} />
          <datalist id="stock-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className={`flex flex-col gap-1 ${fine} text-fg-2`}>
          English words it stands for (comma-separated)
          <input className={inputClass} value={words} onChange={(e) => setWords(e.target.value)} placeholder="ice cream, ice-cream cone" required />
        </label>
        <label className={`flex flex-col gap-1 ${fine} text-fg-2`}>
          What the picture shows (a few plain words)
          <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="a cone of strawberry ice cream" required maxLength={80} />
        </label>
        <label className={`flex flex-col gap-1 ${fine} text-fg-2`}>
          Look-alike group (optional: never two of one group in a round)
          <input className={inputClass} value={group} onChange={(e) => setGroup(e.target.value)} list="stock-groups" placeholder="boy" maxLength={48} data-testid="stock-add-group" />
        </label>
        <label className={`flex items-center gap-2 ${fine} text-fg-2 sm:col-span-2`}>
          <input type="checkbox" checked={adults} onChange={(e) => setAdults(e.target.checked)} data-testid="stock-add-adults" />
          Adults only (never shown to kids learners)
        </label>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" disabled={busy} data-testid="stock-add-submit">
            Add and draw
          </Button>
          <span className={`${fine} text-fg-3`}>Drawn at once in the current style (one picture, about a cent). No names of people.</span>
        </div>
      </form>
    </Card>
  );
}

/* ---------------------------------- helpers ---------------------------------- */

/** A blob URL for a picture fetched with the page's headers (an <img src>
 *  can't send them), made again when `key` changes, released after. */
const REASON_TEXT: Record<RedrawReason, string> = {
  wrong: "Wrong thing",
  lookalike: "Looks like another picture",
  kids: "Not right for kids",
  style: "Style is off",
};

/** Learners' reports of shared pictures (ld-ur3), for an admin: by picture,
 *  each reason and "should show" note, and Resolve (every open report of
 *  that picture). The tile's own buttons below redraw it or set Adults only;
 *  an open "not right for kids" report keeps it from kids until resolved. */
function Reported({ concepts, tick, onResolved }: { concepts: StockConceptView[]; tick: number; onResolved: () => void }) {
  const [reports, setReports] = useState<PictureReportView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    pictureReports(ctrl.signal).then(
      (r) => setReports(r.reports),
      (e) => {
        if (!ctrl.signal.aborted) setError(errText(e));
      },
    );
    return () => ctrl.abort();
  }, [tick]);
  const byConcept = useMemo(() => {
    const out = new Map<string, PictureReportView[]>();
    for (const r of reports ?? []) out.set(r.conceptId, [...(out.get(r.conceptId) ?? []), r]);
    return [...out.entries()];
  }, [reports]);
  if (error) return <p className={`${fine} text-err`}>{error}</p>;
  if (!byConcept.length) return null;
  const resolve = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await resolvePictureReport(id);
      onResolved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="stock-reported">
      <h4 className="text-sm font-semibold text-fg">Reported ({byConcept.length})</h4>
      <p className={`${fine} text-fg-3`}>Learners drew these again with a reason. Their word has its own drawing now; redraw or change the shared picture below, then Resolve. A picture reported as not right for kids is kept from kids until resolved.</p>
      <ul className="mt-2 flex flex-col gap-3">
        {byConcept.map(([id, rs]) => (
          <ReportedItem key={id} c={concepts.find((c) => c.id === id) ?? null} id={id} reports={rs} busy={busy} onResolve={() => void resolve(rs[0].id)} />
        ))}
      </ul>
    </Card>
  );
}

function ReportedItem({ c, id, reports, busy, onResolve }: { c: StockConceptView | null; id: string; reports: PictureReportView[]; busy: boolean; onResolve: () => void }) {
  const url = useBlobUrl(c?.version ? `${c.id}/${c.version}` : null, (signal) => stockPictureBlob(c!.id, c!.version!, signal));
  return (
    <li className="flex flex-wrap items-start gap-3" data-testid="stock-reported-item" data-concept={id}>
      {url ? <img src={url} alt={c?.description ?? ""} className="size-20 rounded-lg border border-line object-cover" /> : <div className="size-20 rounded-lg border border-dashed border-line" />}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm text-fg">{c ? c.description : `${id} (no longer in the set)`}</p>
        <ul className={`${fine} flex flex-col gap-0.5 text-fg-2`}>
          {reports.map((r) => (
            <li key={r.id}>
              {REASON_TEXT[r.reason]}
              {r.note ? `: should show "${r.note}"` : ""} <span className="text-fg-3">· {new Date(r.at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
        <div>
          <Button variant="ghost" onClick={onResolve} disabled={busy} data-testid="stock-report-resolve">
            Resolve
          </Button>
        </div>
      </div>
    </li>
  );
}

function useBlobUrl(key: string | null, fetchBlob: (signal: AbortSignal) => Promise<Blob>): string | null {
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    let made: string | null = null;
    fetchBlob(ctrl.signal).then(
      (b) => {
        if (ctrl.signal.aborted) return;
        made = URL.createObjectURL(b);
        setShown({ key, url: made });
      },
      () => {
        /* a missing file shows as no picture */
      },
    );
    return () => {
      ctrl.abort();
      if (made) URL.revokeObjectURL(made);
    };
    // fetchBlob is made from the key's parts each render: the key decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return shown && shown.key === key ? shown.url : null;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-sm ${on ? "border-accent bg-accent-soft text-accent" : "border-line text-fg-2 hover:bg-raised"}`}
    >
      {children}
    </button>
  );
}
