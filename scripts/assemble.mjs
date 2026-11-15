// The assembler: loaded content + one pack -> one markdown prompt for the dojo
// master. Implements the "Assembly algorithm" section of docs/CONTENT.md; read
// that first, this file follows its numbered steps.
//
// Pure and deterministic: no fs, no clock, no randomness, no Map/Set iteration
// over anything whose order isn't fixed by the inputs. Same content and pack
// in, byte-identical markdown out — the test assembles twice and compares, and
// exports are diffable in git because of it.
//
// Nothing here throws on a bad pack. Every problem is a warning string and the
// markdown is still produced, with a visible placeholder where a required
// piece is missing, so an export is never silently incomplete.

import { PLACEHOLDERS, normalizePack } from "./content.mjs";
import { MAX_MINUTES, budgetSplit, formatMinutes, readMinutes, sessionPlan } from "./plan.mjs";

/** Profile keys rendered in the Learner block, in this order, with labels.
 *  Any other key in the effective profile follows in its own order. */
const PROFILE_LABELS = [
  ["learner_name", "Name"],
  ["native_language", "Native language"],
  ["target_language", "Target language"],
  ["target_variant", "Variant"],
  ["level", "Level"],
  ["goals", "Goals"],
  ["notes", "Notes"],
];

const ROLE_LABELS = { dojo_master: "You (dojo master)", learner: "Learner" };

export const QUICK_SCENARIO_TITLE = "Quick scenario";
const NO_SCENARIO_TITLE = "No scenario";

/** Shown under a required slot the pack left empty. */
export const MISSING_UNIT_LINE = "_(No unit selected for this required slot. Choose one before using this prompt.)_";
/** What {{location}} reads as when the session left the location blank. */
export const CHOSEN_CITY = "the city you chose";

/** The Setting paragraph for a scenario set wherever the session says. The
 *  variant wins over the place (docs/CONTENT.md): the learner practises the
 *  variant they picked, so the place never changes the accent. */
function settingLine(location, variant) {
  const speech = variant || "the target language";
  if (location) return `**Setting:** ${location}. The place sets the scene; everyone still speaks ${speech}, as the voice rule says, even if people there usually speak another variety.`;
  return `**Setting:** You choose the city. Pick a real city where ${speech} is spoken that suits this scene, a different one from session to session. Name it to the learner in your first narration and keep it for the whole session. Wherever this scenario says "${CHOSEN_CITY}", it means that city.`;
}

const MISSING_SCENARIO_LINE = "_(No scenario selected. Pick a scenario or write a quick scenario before using this prompt.)_";

/**
 * The session's effective profile: the learner's profile with the pack's
 * overrides (normalizePack's) on top. A blank override (an emptied form
 * field) means "no override", not "erase". The prompt is built from it, and
 * a saved conversation keeps its languages (web/server/conversations.ts).
 */
export function effectiveProfile(baseProfile, overrides = {}) {
  const profile = { ...(baseProfile ?? {}) };
  const overridden = new Set();
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v == null || (typeof v === "string" && v.trim() === "")) continue;
    profile[k] = v;
    overridden.add(k);
  }
  // The one key that doesn't survive a merge on its own: a variant belongs
  // to its language, so a pack that moves target_language to a different
  // language drops the profile's target_variant unless it sets its own.
  // Without this, "target Japanese" would still carry "Mexican Spanish
  // (Oaxaca)" into the prompt, and no pack could say "no variant".
  const baseTarget = baseProfile?.target_language;
  if (overridden.has("target_language") && !overridden.has("target_variant") && String(profile.target_language) !== String(baseTarget ?? "")) {
    delete profile.target_variant;
  }
  return profile;
}

/**
 * @param {{schema, frame, profile, units, scenarios}} content  loadContent()'s result
 * @param {object} rawPack  a pack (file or UI body); normalized here
 * @param {"adult"|"kids"} [mode]  which tree `content` is: the Time budget
 *   splits the session into that mode's parts, as the voice timeline does
 * @returns {{ markdown: string, warnings: string[], stats: { words: number, tokens: number, chars: number } }}
 */
export function assemble(content, rawPack, mode = "adult") {
  const pack = normalizePack(rawPack);
  const warnings = [];
  const warn = (msg) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  // 1. Effective profile (effectiveProfile above).
  const profile = effectiveProfile(content.profile, pack.overrides);

  // 2. Scenario: by id, or the quick-scenario text as an ad hoc one.
  const scenario = resolveScenario(content, pack, warn);

  // The session's location is a setting for the scene, not a fact about the
  // learner: it never shows in the Learner block, and only a scenario that
  // uses {{location}} reads it (a stale value left over from another scene
  // on a fixed-setting scenario like Oaxaca is ignored, not rendered). It is
  // read from the pack alone: the Scene tab is the only place it is set, so a
  // `location` key in profile.yaml would steer the scene invisibly.
  const rawLocation = pack.overrides.location;
  const location = typeof rawLocation === "string" ? rawLocation.trim() : "";
  delete profile.location;

  // The time budget is about this session, not the learner: like the
  // location it stays out of the Learner block and is read from the pack
  // only (the Go tab's picker is the one place it is set).
  const budget = readMinutes(pack.overrides.minutes);
  if (budget.invalid) {
    warn(`Pack override "minutes" must be a number of minutes above 0 and at most ${MAX_MINUTES}, not ${JSON.stringify(pack.overrides.minutes)}; ignored (no time budget).`);
  }
  if (budget.rounded) warn(`Pack override "minutes" is ${pack.overrides.minutes}; rounded to ${budget.minutes} (whole minutes only).`);
  delete profile.minutes;

  const values = {};
  for (const key of PLACEHOLDERS) {
    const v = key === "scenario_title" ? scenario.title : profile[key];
    if (v != null && String(v).trim() !== "") values[key] = String(v);
  }
  // A learner with no regional variant is still learning a language: let
  // "{{target_variant}}" read as the language name so frame.md and units can
  // use it unconditionally without printing a bare placeholder.
  if (!values.target_variant && values.target_language) values.target_variant = values.target_language;
  // Blank location: the dojo master picks the city (the Setting line says
  // how), and every {{location}} reads as a reference back to that choice.
  // Deterministic on purpose: the randomness happens in the session, not here.
  if (scenario.uses_location) values.location = location || CHOSEN_CITY;
  else delete values.location;
  const fill = (text, source) => substitute(text, values, source, warn, scenario.uses_location);

  // 3. Slots in schema order; each slot's units in pack order.
  const unitsById = new Map((content.units ?? []).map((u) => [u.id, u]));
  const slots = content.schema?.slots ?? [];
  const slotIds = new Set(slots.map((s) => s.id));
  const picked = []; // unit ids in pack order, unknown/duplicate/unslotted ones dropped
  for (const id of pack.units) {
    if (picked.includes(id)) {
      warn(`Unit "${id}" is listed twice in the pack; included once.`);
      continue;
    }
    const unit = unitsById.get(id);
    if (!unit) {
      warn(`Unknown unit "${id}" (no content/units/${id}.md); skipped.`);
      continue;
    }
    if (!slotIds.has(unit.slot)) {
      warn(`Unit "${id}" is in slot "${unit.slot}", which is not in schema.yaml; skipped.`);
      continue;
    }
    picked.push(id);
  }

  const slotSections = [];
  for (const slot of slots) {
    let chosen = picked.filter((id) => unitsById.get(id).slot === slot.id).map((id) => unitsById.get(id));
    if (slot.pick === "one" && chosen.length > 1) {
      warn(
        `Slot "${slot.title}" takes one unit but the pack has ${chosen.length} (${chosen.map((u) => u.id).join(", ")}); kept "${chosen[0].id}".`,
      );
      chosen = chosen.slice(0, 1);
    }
    if (chosen.length === 0) {
      if (!slot.required) continue; // empty optional slot: omitted
      warn(`Required slot "${slot.title}" has no unit selected.`);
      slotSections.push(`## ${slot.title}\n\n${MISSING_UNIT_LINE}`);
      continue;
    }
    const parts = [`## ${slot.title}`];
    for (const unit of chosen) {
      parts.push(`### ${unit.title}`);
      const body = fill(unit.body ?? "", `unit "${unit.id}"`).trimEnd();
      if (body) parts.push(body);
    }
    slotSections.push(parts.join("\n\n"));
  }

  // 4. Render, in the contract's order.
  const sections = [`# Lingo Dojo session: ${scenario.title}`];
  const frame = fill(content.frame ?? "", "frame.md").trim();
  if (frame) sections.push(frame);
  sections.push(renderLearner(profile));
  sections.push(renderScenario(scenario, fill, scenario.uses_location ? settingLine(location, values.target_variant) : ""));
  sections.push(...slotSections);
  // After the slots, so it can name the warm-ups and debrief described above.
  if (budget.minutes != null) sections.push(renderTimeBudget(budgetSplit(sessionPlan(content, pack, mode), budget.minutes), budget.minutes, mode));
  const notes = pack.notes.trim();
  if (notes) sections.push(`## Notes from the learner\n\n${notes}`);

  const markdown = `${sections.join("\n\n")}\n`;

  // 5. Stats.
  return { markdown, warnings, stats: countStats(markdown) };
}

/** Words are whitespace-separated runs; tokens are the contract's words × 1.3
 *  estimate, rounded (a readout for the voice tool's context limit, not a
 *  tokenizer). */
export function countStats(markdown) {
  const words = markdown.split(/\s+/).filter(Boolean).length;
  return { words, tokens: Math.round(words * 1.3), chars: markdown.length };
}

function resolveScenario(content, pack, warn) {
  const quick = pack.quick_scenario.trim();
  if (pack.scenario) {
    const found = (content.scenarios ?? []).find((s) => s.id === pack.scenario);
    if (found) {
      if (quick) warn(`The pack has both a scenario ("${pack.scenario}") and a quick scenario; the quick scenario is ignored.`);
      return found;
    }
    warn(`Unknown scenario "${pack.scenario}" (no content/scenarios/${pack.scenario}.md).`);
  }
  if (quick) {
    // A quick scene is the learner's own text: they write the place into it.
    // No {{location}} here, so a Location typed for an earlier library scene
    // (and no longer on screen) can't leak into it.
    return { id: null, title: QUICK_SCENARIO_TITLE, summary: "", roles: {}, beats: [], vocab: [], phrases: [], twists: [], body: quick, uses_location: false };
  }
  warn("No scenario selected.");
  return { id: null, title: NO_SCENARIO_TITLE, summary: "", roles: {}, beats: [], vocab: [], twists: [], body: "", missing: true };
}

/**
 * Replace {{name}} with the effective value. Unknown names, and known names
 * the profile has no value for, are left as-is and warned about once per
 * source: a literal "{{level}}" in the export is visible, an empty string
 * would read as a sentence with a hole in it.
 */
function substitute(text, values, source, warn, scenarioUsesLocation) {
  return text.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (match, name) => {
    if (Object.hasOwn(values, name)) return values[name];
    // Setting an override would not help here: {{location}} only has a value
    // when the scenario itself is set wherever the session says.
    if (name === "location" && !scenarioUsesLocation) {
      warn(`Placeholder {{location}} in ${source} is only filled when the scenario uses {{location}} (a fixed-setting or quick scenario doesn't); left as-is.`);
      return match;
    }
    if (PLACEHOLDERS.includes(name)) warn(`Placeholder {{${name}}} in ${source} has no value (set it in profile.yaml or the pack's overrides); left as-is.`);
    else warn(`Unknown placeholder {{${name}}} in ${source}; left as-is.`);
    return match;
  });
}

function scalar(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(scalar).filter(Boolean).join(", ");
  if (typeof v === "object") return Object.entries(v).map(([k, x]) => `${k}: ${scalar(x)}`).join("; ");
  return String(v).trim().replace(/\s*\n\s*/g, " ");
}

function humanize(key) {
  const s = String(key).replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderLearner(profile) {
  const lines = [];
  const known = new Set();
  for (const [key, label] of PROFILE_LABELS) {
    known.add(key);
    const v = scalar(profile[key]);
    if (v) lines.push(`- **${label}:** ${v}`);
  }
  for (const [key, raw] of Object.entries(profile)) {
    if (known.has(key)) continue;
    const v = scalar(raw);
    if (v) lines.push(`- **${humanize(key)}:** ${v}`);
  }
  return lines.length ? `## Learner\n\n${lines.join("\n")}` : "## Learner\n\n_(No learner profile.)_";
}

/** A table cell: one line, pipes escaped so they don't split the column. */
function cell(s) {
  return String(s).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

/** `fill` substitutes placeholders in the body: scenarios are written to the
 *  learner by name ("{{learner_name}} arrives at the gate"), like units. */
function renderScenario(s, fill, setting) {
  if (s.missing) return `## Scenario\n\n${MISSING_SCENARIO_LINE}`;
  const where = s.id ? `scenario "${s.id}"` : "the quick scenario";
  const parts = ["## Scenario", `### ${s.title}`];
  if (s.summary) parts.push(s.summary);
  if (setting) parts.push(setting);
  const roles = Object.entries(s.roles ?? {});
  if (roles.length) {
    parts.push("**Roles**");
    parts.push(roles.map(([k, v]) => `- **${ROLE_LABELS[k] ?? humanize(k)}:** ${fill(v, where)}`).join("\n"));
  }
  if (s.beats?.length) {
    parts.push("**Beats**");
    parts.push(s.beats.map((b, i) => `${i + 1}. ${b}`).join("\n"));
  }
  if (s.vocab?.length) {
    parts.push("**Vocabulary**");
    parts.push(["| Term | Gloss |", "| --- | --- |", ...s.vocab.map((v) => `| ${cell(v.term)} | ${cell(v.gloss)} |`)].join("\n"));
  }
  // A scenario written for every language lists meanings, not words: the
  // dojo master supplies the words in the learner's variant.
  if (s.phrases?.length) {
    parts.push(fill("**Phrases to work in** (English meanings; use the natural {{target_variant}} for each)", where));
    parts.push(s.phrases.map((p) => `- ${p}`).join("\n"));
  }
  // Twists are raw material for the Variation slot, not a script: the
  // dojo master must only reach for them when a variation unit says so.
  if (s.twists?.length) {
    parts.push("**Possible twists** (use only if a Variation unit below asks for one)");
    parts.push(s.twists.map((t) => `- ${fill(t, where)}`).join("\n"));
  }
  const body = fill(s.body ?? "", where).trimEnd();
  if (body) parts.push(body);
  return parts.join("\n\n");
}

/** How a part is labelled in the Time budget's split ("" = its title alone). */
const PART_LABELS = { warmup: "Warm-up", games: "Game", debrief: "Debrief", ending: "Ending" };

/** "½ minute", "1 minute", "2½ minutes". */
function minutesWord(m) {
  return `${formatMinutes(m)} minute${m > 0 && m <= 1 ? "" : "s"}`;
}

/** The Time budget section: the total, a rough split across the session's
 *  parts (the voice timeline's parts, beats folded into the scene) and how
 *  to shrink to fit. Built from numbers alone, so it is deterministic, and
 *  it travels with an export: pasted into another voice tool, the model
 *  there can only count exchanges, so the section says how. */
function renderTimeBudget(rows, minutes, mode) {
  const has = (g) => rows.some((r) => r.group === g);
  const kids = mode === "kids";
  const closing = kids ? "the goodbye" : "the short debrief";
  const split = rows.map((r) => {
    const kind = r.kind === "scene" ? (kids ? "Story" : "Scene") : PART_LABELS[r.kind];
    const label = kind ? `${kind}: ${r.title}` : r.title;
    const time = r.minutes > 0 ? `about ${minutesWord(r.minutes)}` : "skip it unless there is time to spare";
    let more = "";
    if (r.kind === "scene" && r.beats) more = r.play < r.beats ? `, about ${r.play} of its ${r.beats} beats` : `, all ${r.beats} beats`;
    if (r.kind === "scene" && r.games?.length) more += ` (with ${r.games.join(", ")} during it)`;
    return `- ${label}: ${time}${more}`;
  });
  const scene = rows.find((r) => r.kind === "scene");
  const shrink = [];
  if (scene?.beats > 1) shrink.push("- Play fewer beats: the ones that matter most, in order, and skip the rest. A 5-minute session plays one or two.");
  if (has("before")) shrink.push(kids ? "- Keep the opening game short: a few words, or skip it when time is short." : "- Keep the warm-up short: a few items per drill, or skip a drill when time is short.");
  if (has("after")) shrink.push(kids ? "- Keep the goodbye to a word of praise and one word to remember." : "- Keep the debrief to one or two points.");
  shrink.push("- Keep your own turns short, so the learner does most of the talking.");
  return [
    "## Time budget",
    `The learner has **${minutesWord(minutes)}** for this whole session. Pace it to finish on time with ${closing} included: the session ends on its closing part, not cut off in the middle of the scene.`,
    "**Rough split**",
    split.join("\n"),
    "**To fit the time**",
    shrink.join("\n"),
    `**Keeping time:** when a turn comes with a clock line (minutes used, minutes left, the current part), follow it: it is the real time. Without one, estimate from the number of exchanges, about two a minute. From about four fifths of the time, start closing the scene; once the time is up, end the scene and give ${closing} within a turn or two. If the learner then wants to keep going, go along with it.`,
  ].join("\n\n");
}
