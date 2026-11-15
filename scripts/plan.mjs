// A session's parts and its time budget. Pure, with no imports, so the
// assembler (the Time budget section of the prompt) and the voice loop (the
// timeline, and the clock line each turn) read the same parts without the
// assembler pulling in voice.mjs and its provider plumbing.

/** The slots that make up a session's parts, around the scene, by mode. */
// Kids games mostly run during the story, whenever a word needs repeating,
// so they sit at its start; one tagged "opener" (the echo game) runs before
// the story, so it sits before the scene.
const PLAN_SLOTS = {
  adult: { intro: "intro", before: ["warmup"], after: ["debrief"] },
  kids: { intro: "intro", before: [], during: ["games"], after: ["ending"], openerTag: "opener" },
};
const BEAT_CHARS = 70;

/** The session's parts in order, for the timeline and the adapter: the
 *  introduction, each warm-up, the scene and its beats (the scenario's
 *  beats list), then the debrief. `content` is loadContent's result and
 *  `pack` the pack being practised; ids are stable within a session. */
export function sessionPlan(content, pack, mode = "adult") {
  const cfg = PLAN_SLOTS[mode] ?? PLAN_SLOTS.adult;
  const byId = new Map((content?.units ?? []).map((u) => [u.id, u]));
  // Each unit once, as assemble does: a pack listing one twice must not
  // show (or run) it twice, and ids must stay unique.
  const ids = [...new Set(Array.isArray(pack?.units) ? pack.units : [])];
  const units = ids.map((id) => byId.get(id)).filter(Boolean);
  const inSlot = (slot) => units.filter((u) => u.slot === slot);
  const opener = (u) => !!cfg.openerTag && Array.isArray(u.tags) && u.tags.includes(cfg.openerTag);
  const part = (slot, u) => ({ id: `${slot}:${u.id}`, title: u.title, kind: slot });
  const plan = [];
  if (inSlot(cfg.intro).length) plan.push({ id: "intro", title: "Introduction", kind: "intro" });
  for (const slot of cfg.before) for (const u of inSlot(slot)) plan.push(part(slot, u));
  for (const slot of cfg.during ?? []) for (const u of inSlot(slot).filter(opener)) plan.push(part(slot, u));
  const scenario = (content?.scenarios ?? []).find((sc) => sc.id === pack?.scenario);
  const title = scenario?.title || (pack?.quick_scenario ? "Quick scene" : "The scene");
  plan.push({ id: "scene", title, kind: "scene" });
  // Games played during the story sit at its start: they begin with it and
  // come back whenever a word needs repeating.
  for (const slot of cfg.during ?? []) for (const u of inSlot(slot).filter((u) => !opener(u))) plan.push(part(slot, u));
  const beats = Array.isArray(scenario?.beats) ? scenario.beats : [];
  beats.forEach((b, i) => {
    // One line: a beat written over several lines would break the
    // adapter's list of parts.
    const text = String(b).replace(/\s+/g, " ").trim();
    // The beat's first clause is its name: "Arriving at the stall; Doña
    // Carmen calling out…" → "Arriving at the stall". Leading punctuation
    // is not a clause.
    const short = text.replace(/^[\s;:—–-]+/, "").split(/[;:—]/)[0].trim() || text;
    plan.push({ id: `beat:${i + 1}`, title: short.length > BEAT_CHARS ? `${short.slice(0, BEAT_CHARS - 1)}…` : short, kind: "beat", detail: text });
  });
  for (const slot of cfg.after) for (const u of inSlot(slot)) plan.push(part(slot, u));
  return plan;
}

/* ------------------------------- time budget ------------------------------ */

/** The "How long do you have?" picker's choices, by mode, in minutes. No
 *  limit is the absence of a number. */
export const MINUTE_CHOICES = { adult: [5, 10, 15, 20, 30], kids: [3, 5, 10] };
/** Anything above this is a typo, not a session: four hours. */
export const MAX_MINUTES = 240;
/** What the +5 min button adds to a running session's budget. */
export const EXTEND_MINUTES = 5;

/** A pack's `overrides.minutes` read as a time budget: the one place a
 *  budget is read (web/src/draft.ts validMinutes mirrors it for the
 *  browser). Absent (or blank) is no limit; a number in (0, MAX_MINUTES] is
 *  the budget, rounded to whole minutes and at least 1 (`rounded` says it
 *  changed), so the heading, the split, the clock line and the timeline
 *  can never disagree about a hand-written 7.5; anything else is `invalid`,
 *  which the assembler warns about and treats as no limit. Numbers only: a
 *  quoted "10" in YAML is a typo the warning should surface, not a guess. */
export function readMinutes(v) {
  if (v == null || (typeof v === "string" && v.trim() === "")) return { minutes: null, invalid: false, rounded: false };
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_MINUTES) return { minutes: null, invalid: true, rounded: false };
  const minutes = Math.max(1, Math.round(v));
  return { minutes, invalid: false, rounded: minutes !== v };
}

/** Rough shares of the session, by group. The scene is the point of the
 *  session, so a group the pack doesn't have gives its share to the scene. */
const SHARES = { intro: 0.1, before: 0.2, scene: 0.55, after: 0.15 };
/** Parts after the scene that close the session. Any other part listed after
 *  the scene (a kids game played during the story) is the scene's time. */
const CLOSING_KINDS = new Set(["debrief", "ending"]);
/** About how long one scene beat takes, for "about N of its beats". */
const MINUTES_PER_BEAT = 2;

/**
 * The plan's parts with a rough number of minutes each, adding up to the
 * budget (in half minutes). Beats are not rows of their own: the scene row
 * says how many there are (`beats`) and about how many fit (`play`), and
 * lists the games played during it (`games`). A part can get 0 minutes when
 * the budget is short: it is the one to skip.
 * @returns {{ id: string, title: string, kind: string, group: "intro"|"before"|"scene"|"after", minutes: number, beats?: number, play?: number, games?: string[] }[]}
 */
export function budgetSplit(plan, minutes) {
  const list = Array.isArray(plan) ? plan : [];
  const sceneAt = list.findIndex((p) => p.kind === "scene");
  if (sceneAt < 0) return [];
  const rows = [];
  const scene = { id: list[sceneAt].id, title: list[sceneAt].title, kind: "scene", group: "scene", beats: 0, games: [] };
  list.forEach((p, i) => {
    if (i === sceneAt) rows.push(scene);
    else if (p.kind === "beat") scene.beats += 1;
    else if (p.kind === "intro") rows.push({ id: p.id, title: p.title, kind: p.kind, group: "intro" });
    else if (i > sceneAt && !CLOSING_KINDS.has(p.kind)) scene.games.push(p.title);
    else rows.push({ id: p.id, title: p.title, kind: p.kind, group: i > sceneAt ? "after" : "before" });
  });

  // Each present group's share, split evenly among its parts; the scene
  // takes the shares of the groups this session doesn't have.
  const count = (g) => rows.filter((r) => r.group === g).length;
  const spare = Object.keys(SHARES).filter((g) => !count(g)).reduce((s, g) => s + SHARES[g], 0);
  const weight = (g) => SHARES[g] + (g === "scene" ? spare : 0);
  const halves = Math.max(1, Math.round(minutes * 2));
  const exact = rows.map((r) => (weight(r.group) / count(r.group)) * halves);
  // Largest remainder: whole half minutes first, then the leftovers to the
  // biggest fractions, the earlier part first on a tie. Deterministic, and
  // the rows always add up to the budget.
  const got = exact.map(Math.floor);
  let left = halves - got.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    got[i] += 1;
    left -= 1;
  }
  rows.forEach((r, i) => {
    r.minutes = got[i] / 2;
  });
  scene.play = scene.beats ? Math.max(1, Math.min(scene.beats, Math.round(scene.minutes / MINUTES_PER_BEAT))) : 0;
  return rows;
}

/** The row the split would be in after `used` minutes (the last one once the
 *  budget is spent); null for an empty split. */
export function plannedRow(rows, used) {
  let end = 0;
  for (const r of rows) {
    end += r.minutes;
    if (used < end) return r;
  }
  return rows[rows.length - 1] ?? null;
}

/** "½", "1", "2½": minutes as the prompt and the UI say them. */
export function formatMinutes(m) {
  const whole = Math.floor(m);
  const half = m - whole >= 0.5;
  if (!whole) return half ? "½" : "0";
  return `${whole}${half ? "½" : ""}`;
}
