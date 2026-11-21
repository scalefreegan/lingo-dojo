// The content loader: reads content/ from disk and validates it against
// docs/CONTENT.md, the contract shared with the assembler, the UI and the
// embedded agent. Pure ESM with no server imports, so `node --test` drives it
// directly and the Vite middleware imports it as-is.
//
// The loader never throws on a bad file. The agent edits these files while the
// app is running, and one half-written unit must not take the whole library
// down: each problem is reported with its file path and the rest still loads.
// A file with an `error` (unparseable YAML, a missing required key) is left
// out of the result, so everything the loader does return honours the
// contract's shape; a `warning` (a unit whose slot is not in the schema)
// leaves the file in.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
// Erasable TypeScript, shared with the Scene tab and the server; Node strips
// the types (the same as scripts/db/*.ts).
import { readRandomScene } from "../web/shared/scenes.ts";
import { parseRef } from "../web/shared/unit-rules.ts";

// Paths derive from import.meta.url, never process.cwd(): `npm run dev` runs
// Vite with cwd web/, the CLI and the tests run from the repo root.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The content root: LINGO_CONTENT_DIR when set (resolved against the repo
 *  root, so a relative path means the same thing from web/ and from the CLI),
 *  else <repo>/content. Read per call rather than at module load, so a test
 *  can point it somewhere else without re-importing. */
export function contentRoot() {
  const override = process.env.LINGO_CONTENT_DIR;
  return override ? path.resolve(REPO_ROOT, override) : path.join(REPO_ROOT, "content");
}

/** Rendered prompts land here (gitignored): LINGO_EXPORTS_DIR when set (so
 *  the tests never write into the real exports/), else <repo>/exports. */
export function exportsDir() {
  const override = process.env.LINGO_EXPORTS_DIR;
  return override ? path.resolve(REPO_ROOT, override) : path.join(REPO_ROOT, "exports");
}

/* --------------------------------- modes --------------------------------- */

/** The app's two libraries. "adult" is the content root itself; "kids" is
 *  the self-contained tree under content/kids (its own schema, frame,
 *  profile, units, scenarios and packs; docs/CONTENT.md "Modes"). */
export const MODES = ["adult", "kids"];

export function isMode(v) {
  return typeof v === "string" && MODES.includes(v);
}

/** The content root of a mode. Throws on an unknown mode: a route turns that
 *  into a 400 before any read. */
export function modeRoot(mode = "adult") {
  if (!isMode(mode)) throw fail("EINVAL", `unknown mode ${JSON.stringify(mode)} (one of ${MODES.join(", ")})`);
  return mode === "adult" ? contentRoot() : path.join(contentRoot(), "kids");
}

/** Where a mode's exports go: exports/ for adult, exports/kids/ for kids. */
export function exportsDirFor(mode = "adult") {
  if (!isMode(mode)) throw fail("EINVAL", `unknown mode ${JSON.stringify(mode)} (one of ${MODES.join(", ")})`);
  return mode === "adult" ? exportsDir() : path.join(exportsDir(), "kids");
}

/** The level picker's options per mode. Adult is CEFR; kids is a child-sized
 *  scale. A profile level outside the list is still shown by the UI. */
export const LEVELS_BY_MODE = {
  // Pre-A1 is the First steps drills' level (docs/CONTENT.md "Drills"): a
  // learner picks it; a new learner still starts at A1.
  adult: ["Pre-A1", "A1", "A2", "B1", "B2", "C1", "C2"],
  kids: ["First words", "Getting going", "Chatty"],
};

/** The level a new learner or language starts at. Not the scale's first
 *  for adults: Pre-A1 is opt-in, so a new adult starts at A1 as before. */
export const DEFAULT_LEVEL_BY_MODE = { adult: "A1", kids: "First words" };

/** A scenario's `format`: a scene (the default: a character in a setting)
 *  or a drill (First steps: the narrator alone drills words, no character;
 *  frame-drill.md instead of frame.md, and the scene-only slots skipped). */
export const SCENARIO_FORMATS = ["scene", "drill"];

/** Whether a scenario (loaded, or anything carrying `format`) is a drill. */
export const isDrill = (s) => s?.format === "drill";

/** One path segment — an export id, a pack folder name, a pack file stem:
 *  kebab-case, no dots or slashes. The one check that keeps a
 *  request-supplied name inside its directory. */
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** A pack id: `<stem>` or `<folder>/<stem>`, each segment an ID_RE. One
 *  level of folders and no more (docs/CONTENT.md). */
export const PACK_ID_RE = /^(?:[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/;

/** `oaxaca/2026-10-19-x` → { folder: "oaxaca", stem: "2026-10-19-x" };
 *  a top-level id has folder "". Pure string work, no validation. */
export function splitPackId(id) {
  const i = id.indexOf("/");
  return i === -1 ? { folder: "", stem: id } : { folder: id.slice(0, i), stem: id.slice(i + 1) };
}

/** An error the API can turn into a status: `code` is a Node errno name
 *  (ENOENT → 404, EEXIST and ENOTEMPTY → 409, EINVAL → 400), so a fs error
 *  and a check made here read the same way to the caller. */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export const PICKS = ["one", "any"];

/** The placeholders units and frame.md may use (docs/CONTENT.md). Anything
 *  else in {{ }} is left as-is and reported by the assembler. */
export const PLACEHOLDERS = [
  "learner_name",
  "native_language",
  "target_language",
  "target_variant",
  "level",
  "scenario_title",
  "location",
  "phrase_review",
];

/** A scenario that uses {{location}} anywhere is set wherever the session
 *  says (the Scene tab's Location, `overrides.location`), or in a city the
 *  dojo master picks when that is blank. One regex so the loader, the
 *  assembler and the UI agree on what "uses it" means. */
export const LOCATION_RE = /\{\{\s*location\s*\}\}/;

/* ------------------------------ frontmatter ------------------------------ */

/**
 * Split a markdown file into its YAML frontmatter and body. The frontmatter is
 * the lines between a first line of `---` and the next line of `---`; the
 * contract asks for this split rather than gray-matter so `yaml` stays the one
 * dependency. Returns `{ data, body }` or `{ error }` — never throws.
 */
export function parseFrontmatter(text) {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trimEnd() !== "---") return { error: "missing frontmatter (the file must start with a --- line)" };
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (close === -1) return { error: "frontmatter is not closed (no second --- line)" };
  let data;
  try {
    data = YAML.parse(lines.slice(1, close).join("\n"));
  } catch (e) {
    return { error: `frontmatter is not valid YAML: ${firstLine(e)}` };
  }
  if (data == null) data = {};
  if (typeof data !== "object" || Array.isArray(data)) return { error: "frontmatter must be a YAML mapping" };
  return { data, body: cleanBody(lines.slice(close + 1).join("\n")) };
}

/** Leading blank lines (the gap after the closing ---) and trailing whitespace
 *  go; everything else is the author's, verbatim. */
function cleanBody(s) {
  return s.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

function firstLine(e) {
  return String(e?.message ?? e).split("\n")[0];
}

/* -------------------------------- loading -------------------------------- */

/** Repo-relative when the file is inside the repo (what a person or the agent
 *  would type), absolute otherwise (a test fixture in a temp dir). */
function displayPath(abs) {
  const rel = path.relative(REPO_ROOT, abs);
  return rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel;
}

function readText(abs) {
  try {
    return { text: fs.readFileSync(abs, "utf8") };
  } catch (e) {
    return { error: e?.code === "ENOENT" ? "file is missing" : `cannot read: ${firstLine(e)}` };
  }
}

/** Sorted so the library order — and so the UI and any export — never depends
 *  on the filesystem's directory order. A missing directory is an empty one. */
function listDir(abs, ext) {
  let names;
  try {
    names = fs.readdirSync(abs);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(ext) && !n.startsWith(".")).sort();
}

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** A list of strings from a YAML value: an array of scalars, a lone scalar,
 *  or nothing. `level: B1` and `level: [B1]` mean the same thing. */
/**
 * A list of prose lines (beats, twists). An unquoted line with ": " in it
 * ("Checkout: bags and payment") parses as a one-key mapping, which strList
 * would drop without a word; read it back as the line it was meant to be and
 * say so, so the author quotes it.
 */
function proseList(v, field, abs, report) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  arr.forEach((x, i) => {
    if (x == null) return;
    if (isObj(x) && Object.keys(x).length === 1 && typeof Object.values(x)[0] !== "object") {
      const [[k, val]] = Object.entries(x);
      out.push(`${k}: ${val}`);
      report(abs, "warning", `${field}[${i}] parsed as a mapping (an unquoted ": "); read as "${k}: ${val}" — quote the line`);
    } else if (typeof x === "object") {
      report(abs, "warning", `${field}[${i}] should be a string; skipped`);
    } else {
      out.push(String(x));
    }
  });
  return out;
}

function strList(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x) => x != null && typeof x !== "object").map(String);
}

/**
 * Load and validate everything under the content root.
 * Returns `{ root, schema, frame, frameDrill, profile, languages, units, scenarios, problems }`
 * (`frameDrill`: frame-drill.md, "" when the library has none);
 * `problems` is `[{ file, level: "error"|"warning", message }]`. Pack files
 * are not part of the library any more (saved packs live in the database):
 * loadPackFiles reads them, for the import and the export CLI, so the
 * running app never parses them or reports their problems.
 */
export function loadContent(root = contentRoot()) {
  const problems = [];
  const report = (abs, level, message) => problems.push({ file: displayPath(abs), level, message });

  const schema = loadSchema(path.join(root, "schema.yaml"), report);
  const slotIds = new Set(schema.slots.map((s) => s.id));

  const framePath = path.join(root, "frame.md");
  const frameRead = readText(framePath);
  if (frameRead.error) report(framePath, "error", frameRead.error);
  const frame = frameRead.text ? cleanBody(frameRead.text.replace(/\r\n?/g, "\n")) : "";
  // The drill frame (First steps) replaces frame.md for a drill scenario.
  // Optional: a library without one plays its drills under frame.md, and
  // the assembler warns. "" when absent.
  const frameDrillPath = path.join(root, "frame-drill.md");
  let frameDrill = "";
  if (fs.existsSync(frameDrillPath)) {
    const read = readText(frameDrillPath);
    if (read.error) report(frameDrillPath, "error", read.error);
    else frameDrill = cleanBody(read.text.replace(/\r\n?/g, "\n"));
  }

  const profile = loadProfile(path.join(root, "profile.yaml"), report);
  // A mode tree inside the content root (content/kids) without its own
  // languages.yaml shares the root's: kids offers the same languages as
  // adult. Only when neither exists is the missing file reported. A root
  // elsewhere (a test fixture, LINGO_CONTENT_DIR) gets no such fallback.
  const ownLanguages = path.join(root, "languages.yaml");
  const sharedLanguages = path.join(contentRoot(), "languages.yaml");
  const rel = path.relative(contentRoot(), path.resolve(root));
  const nested = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  const languagesPath = nested && !fs.existsSync(ownLanguages) && fs.existsSync(sharedLanguages) ? sharedLanguages : ownLanguages;
  const languages = loadLanguages(languagesPath, report);

  const units = [];
  const unitsDir = path.join(root, "units");
  for (const name of listDir(unitsDir, ".md")) {
    const unit = loadUnit(path.join(unitsDir, name), report);
    if (!unit) continue;
    if (!slotIds.has(unit.slot)) {
      report(unit.path, "warning", `slot "${unit.slot}" is not in schema.yaml; the unit is shown as unslotted and never assembled`);
    }
    units.push(unit);
  }
  checkUnitRefs(units, slotIds, problems);

  const scenarios = [];
  const scenariosDir = path.join(root, "scenarios");
  for (const name of listDir(scenariosDir, ".md")) {
    const scenario = loadScenario(path.join(scenariosDir, name), report);
    if (scenario) scenarios.push(scenario);
  }

  return { root, schema, frame, frameDrill, profile, languages, units, scenarios, problems };
}

function loadYamlFile(abs, report) {
  const read = readText(abs);
  if (read.error) {
    report(abs, "error", read.error);
    return undefined;
  }
  try {
    return YAML.parse(read.text);
  } catch (e) {
    report(abs, "error", `not valid YAML: ${firstLine(e)}`);
    return undefined;
  }
}

function loadSchema(abs, report) {
  const raw = loadYamlFile(abs, report);
  const schema = { version: 1, slots: [] };
  if (raw === undefined) return schema;
  if (!isObj(raw)) {
    report(abs, "error", "schema.yaml must be a YAML mapping with a `slots` list");
    return schema;
  }
  Object.assign(schema, raw, { slots: [] });
  if (!Array.isArray(raw.slots)) {
    report(abs, "error", "missing required key `slots` (a list)");
    return schema;
  }
  const seen = new Set();
  raw.slots.forEach((s, i) => {
    const where = `slots[${i}]`;
    if (!isObj(s)) return report(abs, "error", `${where} must be a mapping`);
    const missing = ["id", "title", "pick"].filter((k) => !isStr(s[k]));
    if (missing.length) return report(abs, "error", `${where} is missing required key(s): ${missing.join(", ")}`);
    if (!PICKS.includes(s.pick)) return report(abs, "error", `${where} (${s.id}): pick must be "one" or "any", not "${s.pick}"`);
    if (seen.has(s.id)) return report(abs, "error", `${where}: duplicate slot id "${s.id}"`);
    seen.add(s.id);
    schema.slots.push({
      ...s,
      id: s.id,
      title: s.title,
      pick: s.pick,
      required: s.required === true,
      backfill: s.backfill === true,
      // A slot that only makes sense around a scene (its character, a
      // warm-up before it, twists in it): a drill skips it.
      scene_only: s.scene_only === true,
      description: typeof s.description === "string" ? s.description.trim() : "",
    });
  });
  return schema;
}

/** A pack's `units` entry saying a `backfill` slot was left empty on
 *  purpose ("-recall"). Never a unit id: unit ids are kebab-case words. */
export const slotOptOut = (slotId) => `-${slotId}`;

/**
 * The units a pack plays: its own, opt-out entries dropped, plus, for each
 * slot marked `backfill: true` in schema.yaml that the pack has no unit of
 * and doesn't opt out of, the slot's default unit(s). A pack saved before
 * such a slot existed has no entry for it at all, so it gets the default
 * a new pack would; a learner who empties the slot (Customize's None) saves
 * the opt-out instead, which is respected. Saved packs are never rewritten
 * for this: it is decided each time the pack is played. The Customize tab
 * mirrors it (web/src/draft.ts withBackfill).
 */
export function packUnits(content, units) {
  const list = Array.isArray(units) ? units.filter((u) => typeof u === "string") : [];
  const own = list.filter((id) => !id.startsWith("-"));
  const out = [...own];
  for (const slot of content?.schema?.slots ?? []) {
    if (!slot.backfill || list.includes(slotOptOut(slot.id))) continue;
    const inSlot = (content.units ?? []).filter((u) => u.slot === slot.id);
    if (own.some((id) => inSlot.some((u) => u.id === id))) continue;
    const defaults = inSlot.filter((u) => u.default);
    out.push(...(slot.pick === "one" ? defaults.slice(0, 1) : defaults).map((u) => u.id));
  }
  return out;
}

function loadProfile(abs, report) {
  const raw = loadYamlFile(abs, report);
  if (raw === undefined) return {};
  if (!isObj(raw)) {
    report(abs, "error", "profile.yaml must be a YAML mapping");
    return {};
  }
  return raw;
}

/**
 * languages.yaml → `[{ name, variants }]` for the language pickers. The file
 * is optional (without it the UI falls back to free-text fields), so a
 * missing file is a warning rather than an error; a file that is there but
 * off-contract is an error, and a bad entry is skipped so the rest still
 * load. Names are deduplicated: the UI keys its options by name.
 */
function loadLanguages(abs, report) {
  const read = readText(abs);
  if (read.error) {
    const missing = !fs.existsSync(abs);
    report(abs, missing ? "warning" : "error", missing ? "file is missing; the language pickers fall back to free text" : read.error);
    return [];
  }
  let raw;
  try {
    raw = YAML.parse(read.text);
  } catch (e) {
    report(abs, "error", `not valid YAML: ${firstLine(e)}`);
    return [];
  }
  if (!isObj(raw) || !Array.isArray(raw.languages)) {
    report(abs, "error", "languages.yaml must be a YAML mapping with a `languages` list");
    return [];
  }
  const languages = [];
  const seen = new Set();
  raw.languages.forEach((l, i) => {
    const where = `languages[${i}]`;
    if (!isObj(l) || !isStr(l.name)) return report(abs, "error", `${where} needs a non-empty \`name\`; skipped`);
    const name = l.name.trim();
    if (l.variants != null && !Array.isArray(l.variants)) {
      return report(abs, "error", `${where} (${name}): \`variants\` must be a list of strings; skipped`);
    }
    if (seen.has(name)) return report(abs, "warning", `${where}: duplicate language "${name}"; kept the first`);
    seen.add(name);
    const variants = [];
    (l.variants ?? []).forEach((v, j) => {
      if (isStr(v)) variants.push(v.trim());
      else report(abs, "warning", `${where} (${name}): variants[${j}] is not a string; skipped`);
    });
    // code: the language's ISO 639 code ("es"), matched against the prefix of
    // a scenario's `language` ("es-MX") to tell which collections were
    // written for another language. Optional; a language without one never
    // dims anything.
    const code = isStr(l.code) ? l.code.trim().toLowerCase() : null;
    if (l.code != null && !code) report(abs, "warning", `${where} (${name}): \`code\` should be a string like "es"; ignored`);
    languages.push({ name, variants, code });
  });
  return languages;
}

/** Shared by units and scenarios: read, split, check required keys and that
 *  `id` matches the filename (packs refer to units by id, so a mismatch would
 *  leave the file unreachable under the name a person sees on disk). */
function loadMarkdownEntry(abs, required, report) {
  const read = readText(abs);
  if (read.error) return void report(abs, "error", read.error);
  const parsed = parseFrontmatter(read.text);
  if (parsed.error) return void report(abs, "error", parsed.error);
  const fm = parsed.data;
  const missing = required.filter((k) => !isStr(fm[k]));
  if (missing.length) return void report(abs, "error", `missing required key(s): ${missing.join(", ")}`);
  const stem = path.basename(abs, ".md");
  if (fm.id !== stem) return void report(abs, "error", `id "${fm.id}" must equal the filename stem "${stem}"`);
  return { fm, body: parsed.body };
}

function loadUnit(abs, report) {
  const entry = loadMarkdownEntry(abs, ["id", "slot", "title", "summary"], report);
  if (!entry) return null;
  const { fm, body } = entry;
  // Unknown keys are preserved (the spread) and ignored — the contract lets
  // the agent add metadata without a loader change.
  return {
    ...fm,
    id: fm.id,
    slot: fm.slot,
    title: fm.title.trim(),
    summary: fm.summary.trim(),
    tags: strList(fm.tags),
    default: fm.default === true,
    level: strList(fm.level),
    body,
    // Rendered at the very end of the assembled prompt (docs/CONTENT.md).
    closing: closingText(fm.closing, abs, report),
    // Valid entries only; unknown targets are checked once every unit is
    // loaded (checkUnitRefs).
    conflicts: refList(fm.conflicts, "conflicts", abs, report, ["unit", "slot", "tag"]),
    requires: refList(fm.requires, "requires", abs, report, ["unit", "slot"]),
    path: displayPath(abs),
  };
}

/** `conflicts:` / `requires:` (docs/CONTENT.md): a list of `unit-id`,
 *  `slot:<slot>` or (conflicts only) `tag:<tag>`. A bad entry is a warning
 *  and skipped, never an error; a bare string is a one-entry list. */
function refList(v, field, abs, report, kinds) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  arr.forEach((x, i) => {
    const ref = parseRef(x);
    if (!ref) return void report(abs, "warning", `${field}[${i}] ${JSON.stringify(x)} is not a unit id, slot:<slot>${kinds.includes("tag") ? " or tag:<tag>" : ""}; skipped`);
    if (!kinds.includes(ref.kind)) return void report(abs, "warning", `${field}[${i}] "${x}": ${field} takes ${kinds.includes("slot") ? "a unit id or slot:<slot>" : "a unit id"}, not ${ref.kind}:; skipped`);
    const text = ref.kind === "unit" ? ref.value : `${ref.kind}:${ref.value}`;
    if (!out.includes(text)) out.push(text);
  });
  return out;
}

/** The half of `conflicts`/`requires` validation that needs the whole library:
 *  a target that names no unit, slot or tag is a typo that would never fire;
 *  a unit naming itself does nothing. Removes the entry, with a warning. */
function checkUnitRefs(units, slotIds, problems) {
  const ids = new Set(units.map((u) => u.id));
  const tags = new Set(units.flatMap((u) => u.tags));
  for (const u of units) {
    for (const field of ["conflicts", "requires"]) {
      u[field] = u[field].filter((entry) => {
        const ref = parseRef(entry);
        const bad =
          ref.kind === "unit" ? (ref.value === u.id ? "is the unit itself" : !ids.has(ref.value) && "is not a unit")
          : ref.kind === "slot" ? !slotIds.has(ref.value) && "is not a slot in schema.yaml"
          : !tags.has(ref.value) && "is a tag no unit has";
        if (bad) problems.push({ file: u.path, level: "warning", message: `${field} "${entry}" ${bad}; skipped` });
        return !bad;
      });
    }
  }
}

function closingText(v, abs, report) {
  if (v == null) return "";
  if (typeof v === "string") {
    // A unit is dropped when there is no review by testing its body alone,
    // so the review block belongs in the body, never here.
    if (!/\{\{\s*phrase_review\s*\}\}/.test(v)) return v.trim();
    report(abs, "warning", "closing cannot use {{phrase_review}} (use it in the body); ignored");
    return "";
  }
  report(abs, "warning", "closing must be text; ignored");
  return "";
}

function loadScenario(abs, report) {
  const entry = loadMarkdownEntry(abs, ["id", "title", "summary"], report);
  if (!entry) return null;
  const { fm, body } = entry;
  const roles = {};
  if (isObj(fm.roles)) {
    for (const [k, v] of Object.entries(fm.roles)) if (isStr(v)) roles[k] = v.trim();
  } else if (fm.roles != null) {
    report(abs, "warning", "roles should be a mapping (role: description); ignored");
  }
  const vocab = [];
  if (Array.isArray(fm.vocab)) {
    fm.vocab.forEach((v, i) => {
      if (isObj(v) && isStr(v.term)) vocab.push({ term: String(v.term), gloss: v.gloss == null ? "" : String(v.gloss) });
      else report(abs, "warning", `vocab[${i}] needs a term (and usually a gloss); skipped`);
    });
  } else if (fm.vocab != null) {
    report(abs, "warning", "vocab should be a list of { term, gloss }; ignored");
  }
  // phrases: English meanings for a scenario written for every language; the
  // dojo master supplies the words in the learner's variant.
  const phrases = [];
  if (Array.isArray(fm.phrases)) {
    fm.phrases.forEach((p, i) => {
      if (isStr(p)) phrases.push(p.trim());
      else report(abs, "warning", `phrases[${i}] should be a non-empty string; skipped`);
    });
  } else if (fm.phrases != null) {
    report(abs, "warning", "phrases should be a list of strings; ignored");
  }
  const beats = proseList(fm.beats, "beats", abs, report);
  const twists = proseList(fm.twists, "twists", abs, report);
  // Title, summary, beats and phrases are shown as-is (Scene tab, voice
  // timeline, the phrase list), where a raw {{location}} would leak; the
  // assembler only fills roles, twists and the body.
  for (const [field, text] of [
    ["title", fm.title],
    ["summary", fm.summary],
    ...beats.map((b, i) => [`beats[${i}]`, b]),
    ...phrases.map((p, i) => [`phrases[${i}]`, p]),
  ]) {
    if (LOCATION_RE.test(String(text))) report(abs, "warning", `${field} uses {{location}}, which is only filled in roles, twists and the body; it will show as-is`);
  }
  // `language` drives the Scene tab's dimming (a string split on "-"), so
  // anything else is dropped here rather than crashing the tab.
  let language = null;
  if (isStr(fm.language)) language = fm.language.trim();
  else if (fm.language != null) report(abs, "warning", 'language should be a code like "es-MX"; ignored');
  // `format`: a scene unless it says drill; anything else is a scene, with
  // a warning, so a typo is seen rather than silently changing the session.
  let format = "scene";
  if (SCENARIO_FORMATS.includes(fm.format)) format = fm.format;
  else if (fm.format != null) report(abs, "warning", `format should be one of ${SCENARIO_FORMATS.join(", ")}, not ${JSON.stringify(fm.format)}; read as "scene"`);
  const usesLocation = [body, ...Object.values(roles), ...twists].some((t) => LOCATION_RE.test(t));
  return {
    ...fm,
    id: fm.id,
    title: fm.title.trim(),
    summary: fm.summary.trim(),
    tags: strList(fm.tags),
    language,
    collection: typeof fm.collection === "string" && fm.collection.trim() ? fm.collection.trim() : null,
    category: typeof fm.category === "string" && fm.category.trim() ? fm.category.trim() : null,
    format,
    roles,
    beats,
    vocab,
    phrases,
    twists,
    uses_location: usesLocation,
    body,
    path: displayPath(abs),
  };
}

/**
 * Read one pack file (used by the loader for content/packs and by the CLI for
 * whatever path it is given). The pack's id is the filename stem unless the
 * caller says otherwise (the loader passes `<folder>/<stem>` for a pack in a
 * folder). Returns `{ pack, problems }`, with `pack` null when the file is
 * unusable. Unknown unit or scenario ids are not checked here: that is the
 * assembler's warning, since it depends on the library, not on the file.
 */
export function loadPackFile(abs, id = path.basename(abs).replace(/\.ya?ml$/, "")) {
  const problems = [];
  const report = (level, message) => problems.push({ file: displayPath(abs), level, message });
  const raw = loadYamlFile(abs, (_f, level, message) => report(level, message));
  if (raw === undefined) return { pack: null, problems };
  if (!isObj(raw)) {
    report("error", "a pack must be a YAML mapping");
    return { pack: null, problems };
  }
  if (!isStr(raw.title)) {
    report("error", "missing required key(s): title");
    return { pack: null, problems };
  }
  if (!PACK_ID_RE.test(id)) report("warning", `"${id}" is not a valid pack id (lowercase letters, digits, hyphens; at most one folder); the app cannot save over, move, rename or delete it`);
  if (raw.units != null && !Array.isArray(raw.units)) report("warning", "units should be a list of unit ids; ignored");
  if (raw.overrides != null && !isObj(raw.overrides)) report("warning", "overrides should be a mapping of profile keys; ignored");
  const random = readRandomScene(raw.random_scene);
  if ("error" in random) report("warning", `${random.error}; ignored (not a random scene)`);
  const pack = normalizePack(raw, id);
  pack.folder = splitPackId(id).folder;
  return { pack, problems };
}

/**
 * Coerce a pack-shaped value (a parsed file, or a JSON body from the UI) into
 * the shape the assembler reads. Lenient by design: a missing field is its
 * empty value, never an error; the assembler warns about what it can't use.
 * A malformed `random_scene` reads as none (not random): the routes refuse
 * one before they get here, and loadPackFile warns about a file's.
 */
export function normalizePack(raw, id) {
  const p = isObj(raw) ? raw : {};
  const random = readRandomScene(p.random_scene);
  const pack = {
    ...p,
    title: typeof p.title === "string" ? p.title : "",
    created: p.created == null ? "" : p.created instanceof Date ? p.created.toISOString() : String(p.created),
    scenario: typeof p.scenario === "string" ? p.scenario : "",
    quick_scenario: typeof p.quick_scenario === "string" ? p.quick_scenario : "",
    random_scene: "error" in random ? null : random.value,
    units: Array.isArray(p.units) ? p.units.filter((u) => typeof u === "string") : [],
    overrides: isObj(p.overrides) ? p.overrides : {},
    notes: typeof p.notes === "string" ? p.notes : "",
  };
  if (id !== undefined) pack.id = id;
  return pack;
}

/* ------------------------------ pack files ------------------------------- */

/** Resolve `<dir>/<id><ext>` (one segment, for exports) and prove it stays
 *  inside `dir`. The id regex already rules out `/` and `..`; this is the
 *  second lock, so a future loosening of ID_RE cannot turn into a write
 *  outside the directory. */
export function safeJoin(dir, id, ext) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw fail("EINVAL", `invalid id: ${JSON.stringify(id)}`);
  const base = path.resolve(dir);
  const abs = path.resolve(base, `${id}${ext}`);
  if (path.dirname(abs) !== base) throw fail("EINVAL", `path escapes ${base}: ${abs}`);
  return abs;
}

export function packsDir(root = contentRoot()) {
  return path.join(root, "packs");
}

/* ------------------------------- folders --------------------------------- */

/** The folders under content/packs, sorted: every directory that is not a
 *  dot-directory, whether or not it holds a pack yet (an empty one keeps a
 *  `.keep` so git tracks it). A missing packs/ is no folders. */
export function listFolders(root = contentRoot()) {
  let entries;
  try {
    entries = fs.readdirSync(packsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort();
}

/**
 * A tree's pack files, for the import into the database (the `db:import`
 * CLI and the first run's seed; scripts/db/packs.ts importPacks): the packs
 * that load, every folder (an empty one included), and the problems of the
 * pack files that did not load. The running app keeps saved packs in the
 * database and never lists these: they are seed content and the export
 * CLI's input (docs/DATA.md §Packs).
 */
export function loadPackFiles(root = contentRoot()) {
  // Packs sit at the top of packs/ or one folder down; anything deeper is
  // ignored, like a dot-directory. Sorted by id so the list is stable
  // whatever order the folders were read in.
  const packs = [];
  const problems = [];
  const dir = packsDir(root);
  const folders = listFolders(root);
  const loadPacksIn = (folder) => {
    const sub = folder ? path.join(dir, folder) : dir;
    for (const name of listDir(sub, ".yaml")) {
      const stem = name.slice(0, -".yaml".length);
      const { pack, problems: packProblems } = loadPackFile(path.join(sub, name), folder ? `${folder}/${stem}` : stem);
      problems.push(...packProblems);
      if (pack) packs.push(pack);
    }
  };
  loadPacksIn("");
  for (const folder of folders) loadPacksIn(folder);
  packs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { packs, folders, problems };
}

/** Lowercase ASCII kebab-case, accents folded ("Café en Oaxaca" →
 *  "cafe-en-oaxaca"). The same rule as the UI's slugify in web/src/draft.ts,
 *  which names a new pack; this one renames an existing one. */
export function slugify(s) {
  const slug = s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "pack";
}

const pad = (n) => String(n).padStart(2, "0");
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The stem a pack takes when it is renamed to `title`: `<date>-<slug of
 * title>`, keeping the date the stem already had (a pack stays sorted where
 * it was), else the date in `created`, else today. Pure: the rename itself
 * is the database's (scripts/db/packs.ts renamePack).
 */
export function renamedStem(stem, created, title) {
  const date = String(stem).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? String(created ?? "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? localDate();
  return `${date}-${slugify(title)}`;
}

/* -------------------------------- profile -------------------------------- */

/**
 * Merge `patch` (profile key → string) into content/profile.yaml and write it
 * back: the UI's "Save as my defaults". The file is edited as a parsed YAML
 * document rather than re-serialised from a plain object, so the keys the
 * patch doesn't name keep their order, comments and block style (a long
 * folded block may be re-wrapped to yaml's line width; its text is unchanged). A blank
 * value removes the key: the assembler already reads a blank as absent, and
 * saving "no variant" should not leave `target_variant: ""` behind. Throws
 * when the existing file is not a YAML mapping — overwriting a file the
 * loader is already reporting as broken would destroy what a person could
 * still fix by hand. Returns the absolute path.
 */
export function saveProfile(patch, root = contentRoot()) {
  const abs = path.join(root, "profile.yaml");
  const read = readText(abs);
  if (read.error && fs.existsSync(abs)) throw new Error(`${displayPath(abs)}: ${read.error}`);
  const doc = read.text === undefined ? new YAML.Document({}) : YAML.parseDocument(read.text);
  if (doc.errors.length) throw new Error(`${displayPath(abs)} is not valid YAML; fix it before saving defaults`);
  if (doc.contents == null) doc.contents = doc.createNode({});
  if (!YAML.isMap(doc.contents)) throw new Error(`${displayPath(abs)} must be a YAML mapping`);
  for (const [key, value] of Object.entries(patch)) {
    const s = value == null ? "" : String(value).trim();
    if (s) doc.set(key, s);
    else doc.delete(key);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, doc.toString());
  return abs;
}

/** Write exports/<id>.md (mkdir -p). Returns the absolute path. */
export function writeExport(id, markdown, dir = exportsDir()) {
  const abs = safeJoin(dir, id, ".md");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, markdown);
  return abs;
}
