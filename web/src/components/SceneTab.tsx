import { useMemo, useState } from "react";
import type { ContentReply, Scenario } from "../types";
import { draftPool, foreignLanguage, fold, languageKey, sessionValues, togglePoolCollection, type Draft } from "../draft";
import { collectionKey, emptyPoolMessage, missingCollections, randomPool, scenesWord } from "../../shared/scenes.ts";
import { Button, Chevron, inputClass } from "./ui";

const FILTER_KEY = "lingo-dojo.scene-filter.v1";
/** Chip order (the adult library's categories); any other category a
 *  scenario uses, the kids library's included, follows alphabetically. */
const CATEGORY_ORDER = ["Food & drink", "Getting around", "Shopping", "Outdoors & sport", "Culture & guides", "Lodging & logistics", "Health & help", "Emergencies", "People & social", "Errands & admin"];
const OTHER_SCENES = "Other scenes";

/** A collection of nothing but drills (First steps, `format: drill`): the
 *  place a beginner starts, so it is listed first, with a hint, whenever it
 *  fits the target language. */
const drillsOnly = (items: readonly Scenario[]) => items.length > 0 && items.every((s) => s.format === "drill");
const FOLDERS_KEY = "lingo-dojo.scene-folders.v1";

/** Open/closed per collection, as the user last left it. A collection absent
 *  from the map has never been toggled and takes its default. */
function loadFolders(languageId: string): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(languageKey(FOLDERS_KEY, languageId)) ?? "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

interface Filter {
  query: string;
  /** "" = All. */
  category: string;
}

function loadFilter(languageId: string): Filter {
  try {
    const f = JSON.parse(localStorage.getItem(languageKey(FILTER_KEY, languageId)) ?? "null") as Partial<Filter> | null;
    return { query: typeof f?.query === "string" ? f.query : "", category: typeof f?.category === "string" ? f.category : "" };
  } catch {
    return { query: "", category: "" };
  }
}

/* Scene tab: what the session is about — a library scenario or a quick one.
 * Library scenes sit in collapsible collection folders under search and
 * category chips; who the session is for lives in the top bar's Profile
 * control, and the note for the dojo master on the Go tab. Filters and
 * folder state are remembered per language profile (the search box is that
 * learner's typing in that language); App remounts on a learner or language
 * switch, so the initial-state readers run again. */
export default function SceneTab({
  languageId,
  content,
  draft,
  onChange,
  onNext,
}: {
  /** Which language profile's filters and folder state to remember (draft.ts languageKey). */
  languageId: string;
  content: ContentReply;
  draft: Draft;
  onChange: (d: Draft) => void;
  onNext: () => void;
}) {
  const quick = draft.scenarioMode === "quick";
  const random = draft.scenarioMode === "random";
  const library = draft.scenarioMode === "library";
  const { scenarios } = content;
  const [filter, setFilterState] = useState<Filter>(() => loadFilter(languageId));
  const setFilter = (f: Filter) => {
    setFilterState(f);
    setTransient({});
    try {
      localStorage.setItem(languageKey(FILTER_KEY, languageId), JSON.stringify(f));
    } catch {
      /* blocked storage: the filter just won't survive a refresh */
    }
  };
  const clear = () => setFilter({ query: "", category: "" });

  const [stored, setStored] = useState<Record<string, boolean>>(() => loadFolders(languageId));
  // While a search or chip is active, folders with matches open on their own;
  // clicking one then is a this-filter-only choice, forgotten when the filter
  // changes, and never written to storage.
  const [transient, setTransient] = useState<Record<string, boolean>>({});

  const categories = useMemo(() => {
    const present = new Set(scenarios.map((s) => s.category).filter((c): c is string => !!c));
    const known = CATEGORY_ORDER.filter((c) => present.has(c));
    return [...known, ...[...present].filter((c) => !CATEGORY_ORDER.includes(c)).sort((a, b) => a.localeCompare(b))];
  }, [scenarios]);
  // A remembered chip for a category that no longer exists must not hide everything.
  const category = categories.includes(filter.category) ? filter.category : "";
  const needle = fold(filter.query.trim());

  // Chip counts follow the search text, so they say what clicking would show.
  const searched = useMemo(
    () => scenarios.filter((s) => !needle || fold([s.title, s.summary, s.category ?? "", ...s.tags].join(" ")).includes(needle)),
    [scenarios, needle],
  );
  const visible = category ? searched.filter((s) => s.category === category) : searched;
  // Every collection gets a folder, matches or not: a folder with nothing
  // under the current filter says so rather than vanishing.
  // A collection written for another language than the session's target
  // (the Oaxaca trip while practising Japanese) is dimmed and sorted after
  // the rest; it stays selectable, since the dojo master would run the
  // scene in the target language anyway.
  const target = sessionValues(draft, content.profile).target_language;
  const groups = useMemo(() => {
    const all = new Map<string, Scenario[]>();
    for (const s of scenarios) all.set(s.collection ?? "", [...(all.get(s.collection ?? "") ?? []), s]);
    const by = new Map<string, typeof visible>([...all.keys()].map((k) => [k, []]));
    for (const s of visible) by.get(s.collection ?? "")?.push(s);
    return [...by.entries()]
      .map(([key, items]) => {
        const foreign = foreignLanguage(all.get(key) ?? [], content.languages, target);
        return { key, name: key || OTHER_SCENES, items, foreign, starter: !foreign && drillsOnly(all.get(key) ?? []) };
      })
      .sort((a, b) => Number(b.starter) - Number(a.starter) || Number(!!a.foreign) - Number(!!b.foreign) || (a.key === "" ? 1 : b.key === "" ? -1 : a.key.localeCompare(b.key)));
  }, [scenarios, visible, content.languages, target]);

  // The Random card's pool: one chip per collection, with how many of its
  // scenes fit the target (a collection written for another language has
  // none, and is dimmed as its folder is).
  const pool = useMemo(() => draftPool(content, draft), [content, draft]);
  const poolChoices = useMemo(() => {
    const by = new Map<string, Scenario[]>();
    for (const s of scenarios) by.set(collectionKey(s), [...(by.get(collectionKey(s)) ?? []), s]);
    return [...by.entries()]
      .map(([key, items]) => ({
        key,
        name: key || OTHER_SCENES,
        // What the collection alone would draw from, by randomPool's own rule,
        // so a First steps folder counts its drills and a mixed one doesn't.
        fit: randomPool(items, content.languages, target, { collections: [] }).length,
        foreign: foreignLanguage(items, content.languages, target),
      }))
      .sort((a, b) => Number(!!a.foreign) - Number(!!b.foreign) || (a.key === "" ? 1 : b.key === "" ? -1 : a.key.localeCompare(b.key)));
  }, [scenarios, content.languages, target]);
  // "Every scene that fits" is the whole library's pool, drills left out
  // as the draw leaves them out.
  const poolAll = useMemo(() => randomPool(scenarios, content.languages, target, { collections: [] }).length, [scenarios, content.languages, target]);
  const missing = random ? missingCollections(scenarios, { collections: draft.randomCollections }) : [];

  const filtering = needle !== "" || category !== "";
  const selected = library ? scenarios.find((s) => s.id === draft.scenario) : undefined;
  const hiddenSelected = selected && !visible.some((s) => s.id === selected.id) ? selected : undefined;
  const selectedKey = selected ? (selected.collection ?? "") : undefined;
  // Default: everything open when there is one folder, else just the one
  // holding the selected scene.
  const isOpen = (g: { key: string; items: unknown[] }) => {
    if (filtering) return g.items.length > 0 && (transient[g.key] ?? true);
    return stored[g.key] ?? (groups.length === 1 || g.key === selectedKey);
  };
  const toggle = (g: { key: string; items: unknown[] }) => {
    const next = !isOpen(g);
    if (filtering) {
      setTransient({ ...transient, [g.key]: next });
      return;
    }
    const map = { ...stored, [g.key]: next };
    setStored(map);
    try {
      localStorage.setItem(languageKey(FOLDERS_KEY, languageId), JSON.stringify(map));
    } catch {
      /* blocked storage: folders just reopen to their defaults next visit */
    }
  };
  const pick = (id: string) => onChange({ ...draft, scenarioMode: "library", scenario: id });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-4">
          {scenarios.length === 0 ? (
            <p className="text-sm text-fg-3">No scenarios in content/scenarios yet.</p>
          ) : (
            <>
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center gap-3">
                  <input
                    type="search"
                    aria-label="Search scenes"
                    className={`${inputClass} sm:max-w-sm`}
                    placeholder="Search scenes…"
                    value={filter.query}
                    onChange={(e) => setFilter({ ...filter, query: e.target.value })}
                  />
                  {filtering && (
                    <button type="button" className="text-sm text-fg-3 hover:text-fg-2 hover:underline" onClick={clear}>
                      Clear
                    </button>
                  )}
                </div>
                {categories.length > 0 && (
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category">
                    <Chip label="All" count={searched.length} active={category === ""} onClick={() => setFilter({ ...filter, category: "" })} />
                    {categories.map((c) => (
                      <Chip
                        key={c}
                        label={c}
                        count={searched.filter((s) => s.category === c).length}
                        active={category === c}
                        onClick={() => setFilter({ ...filter, category: c })}
                      />
                    ))}
                  </div>
                )}
              </div>
              {hiddenSelected && (
                <p className="text-sm text-fg-2" data-testid="hidden-selected">
                  Selected: <span className="font-medium text-fg">{hiddenSelected.title}</span> (hidden by filter) ·{" "}
                  <button type="button" className="text-accent hover:underline" onClick={clear}>
                    Clear filters
                  </button>
                </p>
              )}
            </>
          )}

          <div className={GRID}>
            <QuickSceneCard
              selected={quick}
              value={draft.quickScenario}
              onSelect={() => onChange({ ...draft, scenarioMode: "quick" })}
              onChangeText={(text) => onChange({ ...draft, quickScenario: text, scenarioMode: "quick" })}
              className={quick ? "col-span-full" : ""}
            />
            {scenarios.length > 0 && (
              <RandomSceneCard
                selected={random}
                choices={poolChoices}
                allSize={poolAll}
                chosen={draft.randomCollections}
                poolSize={pool.length}
                missing={missing}
                emptyMessage={emptyPoolMessage({ collections: draft.randomCollections }, target)}
                onSelect={() => onChange({ ...draft, scenarioMode: "random" })}
                onToggle={(key) => onChange(togglePoolCollection(draft, key))}
                onAll={() => onChange({ ...draft, scenarioMode: "random", randomCollections: [] })}
                className={random ? "col-span-full" : ""}
              />
            )}
          </div>

          {scenarios.length > 0 && visible.length === 0 && (
            <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-fg-2">
              <p className="font-medium text-fg">No scenes match</p>
              <button type="button" className="mt-1 text-accent hover:underline" onClick={clear}>
                Clear filters
              </button>
            </div>
          )}

          {groups.map((g) => {
            const open = isOpen(g);
            const empty = filtering && g.items.length === 0;
            const bodyId = `folder-${g.key || "other"}`.replace(/\s+/g, "-");
            return (
              <section key={g.key} aria-label={g.name} className="flex flex-col gap-2">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={bodyId}
                  disabled={empty}
                  onClick={() => toggle(g)}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-raised disabled:cursor-default disabled:hover:bg-transparent ${g.foreign ? "opacity-60" : ""}`}
                >
                  <span className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}>
                    <Chevron open={false} />
                  </span>
                  <FolderGlyph open={open} />
                  <span className="min-w-0 truncate text-sm font-medium text-fg">{g.name}</span>
                  <span className="shrink-0 text-sm text-fg-3">· {filtering ? `${g.items.length} of ${scenarios.filter((s) => (s.collection ?? "") === g.key).length}` : g.items.length}</span>
                  {g.foreign && (
                    <span className="shrink-0 rounded-full border border-line px-2 text-xs text-fg-3" data-testid="folder-foreign">
                      written for {g.foreign}
                    </span>
                  )}
                  {g.starter && !empty && (
                    <span className="min-w-0 truncate text-sm text-accent sm:text-xs" data-testid="folder-starter">
                      New to the language? Start here
                    </span>
                  )}
                  {empty && <span className="shrink-0 text-sm text-fg-3">no matches</span>}
                  {!open && !empty && selected && selectedKey === g.key && (
                    <span className="min-w-0 truncate text-sm text-fg-3" data-testid="folder-selected">
                      · {selected.title}
                    </span>
                  )}
                </button>
                {open && !empty && (
                  <div id={bodyId} className={`${GRID} ${g.foreign ? "opacity-75" : ""}`}>
                    {g.items.map((s) => (
                      <ScenarioCard
                        key={s.id}
                        title={s.title}
                        summary={s.summary}
                        category={s.category}
                        drill={s.format === "drill"}
                        selected={library && draft.scenario === s.id}
                        onClick={() => pick(s.id)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
      </div>

      {/* A random scene may draw one set wherever the session says: the
          Location then applies to it exactly as to a picked one. */}
      {(selected?.uses_location || (random && pool.some((s) => s.uses_location))) && (
        <LocationField
          value={draft.location}
          variant={sessionValues(draft, content.profile).target_variant || target}
          onChange={(location) => onChange({ ...draft, location })}
          note={random ? "Used when the drawn scene is one set wherever you say; a scene with its own setting keeps it." : undefined}
        />
      )}

      <div className="flex justify-end">
        <Button variant="primary" onClick={onNext}>
          Next: Customize →
        </Button>
      </div>
    </div>
  );
}

/** 1 column on a phone, 2 from `sm`, 3 from `lg` (1024), 4 from `xl`. Named breakpoints only: Tailwind v4 emits
 *  arbitrary `min-[…]:` variants *before* the named ones, so a
 *  `min-[1000px]:grid-cols-3` here lost to `sm:grid-cols-2` at every width. */
const GRID = "grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

function Chip({
  label,
  count,
  active,
  onClick,
  disabled = false,
  title,
  testId,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={`rounded-full border px-3 py-1 text-sm transition-colors disabled:cursor-default disabled:opacity-50 sm:px-2.5 sm:text-xs ${
        active ? "border-accent bg-accent-soft text-accent" : "border-line bg-panel text-fg-2 hover:border-line-strong disabled:hover:border-line"
      }`}
    >
      {label} <span className={active ? "" : "text-fg-3"}>{count}</span>
    </button>
  );
}

function ScenarioCard({
  title,
  summary,
  category,
  drill = false,
  selected,
  onClick,
}: {
  title: string;
  summary: string;
  category: string | null;
  /** A drill (First steps): the narrator drills words, no conversation. */
  drill?: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`flex min-w-0 flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
        selected ? "border-accent bg-accent-soft" : "border-line bg-panel hover:border-line-strong"
      }`}
    >
      <span className="line-clamp-2 text-sm leading-snug font-medium text-fg">{title}</span>
      <p className="w-full truncate text-sm text-fg-2 sm:text-xs">{summary}</p>
      {(category || drill) && (
        <span className="mt-0.5 flex items-center gap-1.5 text-sm text-fg-3 sm:text-[11px]">
          {drill && (
            <span className="rounded-full border border-accent/60 px-1.5 text-accent" title="A drill: the narrator teaches words one at a time, no conversation" data-testid="drill-badge">
              Drill
            </span>
          )}
          {category}
        </span>
      )}
    </button>
  );
}

/** Where the selected scene is set. Only shown for a scenario that uses
 *  {{location}}; a fixed-setting one (the Oaxaca trip) has nowhere to put
 *  it. Blank leaves the choice to the dojo master, who names the city at
 *  the start of the session. */
function LocationField({ value, variant, onChange, note }: { value: string; variant: string; onChange: (v: string) => void; note?: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel p-3" data-testid="location-field">
      <label htmlFor="scene-location" className="text-sm font-medium text-fg">
        Location
      </label>
      <input
        id="scene-location"
        type="text"
        className={`${inputClass} sm:max-w-sm`}
        placeholder="Surprise me"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-sm text-fg-3 sm:text-xs">
        {value.trim()
          ? `The scene is set in ${value.trim()}. Voices stay in ${variant || "your target language"}.`
          : `Leave blank and the dojo master picks a city where ${variant || "your target language"} is spoken.`}
        {note && ` ${note}`}
      </p>
    </div>
  );
}

/** The third way to pick a scene: keep the configuration, and let the
 *  scene be drawn from a pool when the session starts (never before: the
 *  server draws it, steering clear of the last few played). Collapsed, a
 *  card like Quick scene; selected, it spans the row and shows the pool's
 *  collections as chips (none chosen = every scene that fits the target
 *  language) and how many scenes that makes. An empty pool is an error
 *  here, and Start refuses it too. */
function RandomSceneCard({
  selected,
  choices,
  allSize,
  chosen,
  poolSize,
  missing,
  emptyMessage,
  onSelect,
  onToggle,
  onAll,
  className = "",
}: {
  selected: boolean;
  choices: { key: string; name: string; fit: number; foreign: string | null }[];
  /** The whole library's pool size (randomPool with no collections). */
  allSize: number;
  chosen: string[];
  poolSize: number;
  missing: string[];
  emptyMessage: string;
  onSelect: () => void;
  onToggle: (key: string) => void;
  onAll: () => void;
  className?: string;
}) {
  const empty = selected && poolSize === 0;
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border p-3 transition-colors ${
        empty ? "border-err bg-err-soft" : selected ? "border-accent bg-accent-soft" : "border-line bg-panel hover:border-line-strong"
      } ${className}`}
      data-testid="random-scene-card"
    >
      <button type="button" aria-pressed={selected} onClick={onSelect} className="flex flex-col items-start gap-1 text-left" data-testid="random-scene-select">
        <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
          <DiceGlyph /> Random scene
        </span>
        {!selected && <span className="truncate text-sm text-fg-2 sm:text-xs">Keep your setup; the scene is drawn when you start.</span>}
      </button>
      {selected && (
        <>
          <p className="text-sm text-fg-2 sm:text-xs">
            Your units, length and notes stay as they are; a scene from the pool is drawn when the session starts, not one of your last few.
          </p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Random scene pool" data-testid="random-pool">
            <Chip label="Every scene that fits" count={allSize} active={chosen.length === 0} onClick={onAll} testId="random-pool-all" />
            {choices.map((c) => {
              const on = chosen.includes(c.key);
              return (
                <Chip
                  key={c.key}
                  label={c.name}
                  count={c.fit}
                  active={on}
                  // A collection with no scene for this language adds nothing;
                  // still removable when a saved pool has it.
                  disabled={!on && c.fit === 0}
                  title={c.foreign ? `Written for ${c.foreign}` : undefined}
                  onClick={() => onToggle(c.key)}
                  testId="random-pool-chip"
                />
              );
            })}
          </div>
          {missing.length > 0 && (
            <p className="text-sm text-fg-3 sm:text-xs" data-testid="random-pool-missing">
              Ignored (no longer in the library): {missing.join(", ")}
            </p>
          )}
          {empty ? (
            <p role="alert" className="text-sm text-err" data-testid="random-pool-empty">
              {emptyMessage}
            </p>
          ) : (
            <p className="text-sm text-fg-2 tabular-nums sm:text-xs" data-testid="random-pool-count" aria-live="polite">
              {scenesWord(poolSize)} in the pool{chosen.length ? "" : " (every collection)"}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Two dice pips on a rounded square — inline, like the folder glyph. */
function DiceGlyph() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-4 shrink-0 text-fg-3">
      <rect x="3" y="3" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="12.5" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="7.5" r="1.2" fill="currentColor" />
      <circle cx="7.5" cy="12.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

/** Collapsed, it's just a card inviting a free-text scene; selecting it (or
 *  typing) expands the same card to hold the textarea. */
function QuickSceneCard({
  selected,
  value,
  onSelect,
  onChangeText,
  className = "",
}: {
  selected: boolean;
  value: string;
  onSelect: () => void;
  onChangeText: (value: string) => void;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border p-3 transition-colors ${
        selected ? "border-accent bg-accent-soft" : "border-line bg-panel hover:border-line-strong"
      } ${className}`}
    >
      <button type="button" aria-pressed={selected} onClick={onSelect} className="text-left text-sm font-medium text-fg">
        Quick scene
      </button>
      {selected ? (
        <textarea
          autoFocus
          aria-label="Quick scene"
          className={`${inputClass} min-h-24`}
          placeholder="Ordering tacos al pastor at a street stand at 1 a.m.…"
          value={value}
          onChange={(e) => onChangeText(e.target.value)}
        />
      ) : (
        <p className="truncate text-sm text-fg-2 sm:text-xs">Describe a scene in your own words.</p>
      )}
    </div>
  );
}

/** A folder, open or closed — inline so the page needs no icon library. */
function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-4 shrink-0 text-fg-3">
      {open ? (
        <path d="M2.5 6.2c0-.9.7-1.6 1.6-1.6h3.2l1.6 1.8h5c.9 0 1.6.7 1.6 1.6v.6H5.6L2.5 15V6.2Zm3.1 3.4h12l-2.4 5.6c-.2.4-.6.7-1.1.7H3.8l1.8-6.3Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      ) : (
        <path d="M2.5 6.2c0-.9.7-1.6 1.6-1.6h3.2l1.6 1.8h7c.9 0 1.6.7 1.6 1.6v6.4c0 .9-.7 1.6-1.6 1.6H4.1c-.9 0-1.6-.7-1.6-1.6V6.2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      )}
    </svg>
  );
}
