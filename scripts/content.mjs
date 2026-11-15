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
  adult: ["A1", "A2", "B1", "B2", "C1", "C2"],
  kids: ["First words", "Getting going", "Chatty"],
};

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
function strList(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x) => x != null && typeof x !== "object").map(String);
}

/**
 * Load and validate everything under the content root.
 * Returns `{ root, schema, frame, profile, languages, units, scenarios, packs, problems }`;
 * `problems` is `[{ file, level: "error"|"warning", message }]`.
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

  const scenarios = [];
  const scenariosDir = path.join(root, "scenarios");
  for (const name of listDir(scenariosDir, ".md")) {
    const scenario = loadScenario(path.join(scenariosDir, name), report);
    if (scenario) scenarios.push(scenario);
  }

  // Packs sit at the top of content/packs or one folder down; anything
  // deeper is ignored, like a dot-directory. Sorted by id so the list is
  // stable whatever order the folders were read in.
  const packs = [];
  const dir = packsDir(root);
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
  for (const folder of listFolders(root)) loadPacksIn(folder);
  packs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { root, schema, frame, profile, languages, units, scenarios, packs, problems };
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
      description: typeof s.description === "string" ? s.description.trim() : "",
    });
  });
  return schema;
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
    path: displayPath(abs),
  };
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
  const beats = strList(fm.beats);
  const twists = strList(fm.twists);
  // Title, summary and beats are shown as-is on the Scene tab and the voice
  // timeline, where a raw {{location}} would leak; the assembler only fills
  // roles, twists and the body.
  for (const [field, text] of [["title", fm.title], ["summary", fm.summary], ...beats.map((b, i) => [`beats[${i}]`, b])]) {
    if (LOCATION_RE.test(String(text))) report(abs, "warning", `${field} uses {{location}}, which is only filled in roles, twists and the body; it will show as-is`);
  }
  const usesLocation = [body, ...Object.values(roles), ...twists].some((t) => LOCATION_RE.test(t));
  return {
    ...fm,
    id: fm.id,
    title: fm.title.trim(),
    summary: fm.summary.trim(),
    tags: strList(fm.tags),
    language: typeof fm.language === "string" ? fm.language : null,
    collection: typeof fm.collection === "string" && fm.collection.trim() ? fm.collection.trim() : null,
    category: typeof fm.category === "string" && fm.category.trim() ? fm.category.trim() : null,
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
  const pack = normalizePack(raw, id);
  pack.folder = splitPackId(id).folder;
  return { pack, problems };
}

/**
 * Coerce a pack-shaped value (a parsed file, or a JSON body from the UI) into
 * the shape the assembler reads. Lenient by design: a missing field is its
 * empty value, never an error; the assembler warns about what it can't use.
 */
export function normalizePack(raw, id) {
  const p = isObj(raw) ? raw : {};
  const pack = {
    ...p,
    title: typeof p.title === "string" ? p.title : "",
    created: p.created == null ? "" : p.created instanceof Date ? p.created.toISOString() : String(p.created),
    scenario: typeof p.scenario === "string" ? p.scenario : "",
    quick_scenario: typeof p.quick_scenario === "string" ? p.quick_scenario : "",
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

/** Resolve content/packs/<id>.yaml for a pack id (`stem` or `folder/stem`)
 *  and prove it stays inside content/packs, at most one level down. Same
 *  two-lock shape as safeJoin: PACK_ID_RE rules out `..`, a leading slash and
 *  a second folder; the path check is there so a loosening of the regex
 *  cannot become a write outside the directory. */
export function packPath(id, root = contentRoot()) {
  if (typeof id !== "string" || !PACK_ID_RE.test(id)) {
    throw fail("EINVAL", `invalid id ${JSON.stringify(id)}: use lowercase letters, digits and hyphens, with at most one folder`);
  }
  const base = path.resolve(packsDir(root));
  const abs = path.resolve(base, `${id}.yaml`);
  const rel = path.relative(base, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).length > 2) throw fail("EINVAL", `path escapes ${base}: ${abs}`);
  return abs;
}

/** Resolve content/packs/<name> for a folder name and prove it is a direct
 *  child of content/packs. */
function folderPath(name, root) {
  if (typeof name !== "string" || !ID_RE.test(name)) {
    throw fail("EINVAL", `invalid folder name ${JSON.stringify(name)}: use lowercase letters, digits and hyphens`);
  }
  const base = path.resolve(packsDir(root));
  const abs = path.resolve(base, name);
  if (path.dirname(abs) !== base) throw fail("EINVAL", `path escapes ${base}: ${abs}`);
  return abs;
}

/** The keys a pack file carries, in the contract's order; anything else the
 *  caller sent rides along after them (unknown keys are preserved). */
const PACK_KEYS = ["title", "created", "scenario", "quick_scenario", "units", "overrides", "notes"];

/** Serialise a pack-shaped value to `abs` (mkdir -p). The id and folder are
 *  the path on disk; storing them in the file too invites the two to disagree. */
function writePackFile(abs, raw) {
  const pack = normalizePack(raw);
  delete pack.id;
  delete pack.folder;
  const ordered = {};
  for (const k of PACK_KEYS) ordered[k] = pack[k];
  for (const [k, v] of Object.entries(pack)) if (!(k in ordered)) ordered[k] = v;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, YAML.stringify(ordered));
}

/** Write content/packs/<id>.yaml, creating the folder if the id names one
 *  that does not exist yet. Returns the absolute path. */
export function savePack(id, raw, root = contentRoot()) {
  const abs = packPath(id, root);
  writePackFile(abs, raw);
  return abs;
}

/** Delete content/packs/<id>.yaml. Returns false when there was no such pack.
 *  The folder it was in is left alone, even when now empty. */
export function deletePack(id, root = contentRoot()) {
  const abs = packPath(id, root);
  try {
    fs.unlinkSync(abs);
    return true;
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

/* ------------------------------- folders --------------------------------- */

/** The folders under content/packs, sorted: every directory that is not a
 *  dot-directory, whether or not it holds a pack yet. A missing packs/ is no
 *  folders. */
export function listFolders(root = contentRoot()) {
  let entries;
  try {
    entries = fs.readdirSync(packsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort();
}

/** mkdir content/packs/<name> with a `.keep` inside, so the empty folder
 *  survives git. EEXIST when there is already something by that name. */
export function createFolder(name, root = contentRoot()) {
  const abs = folderPath(name, root);
  if (fs.existsSync(abs)) throw fail("EEXIST", `folder "${name}" already exists`);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, ".keep"), "");
  return abs;
}

/** Remove content/packs/<name>, but only when nothing is in it apart from
 *  the `.keep` (ENOTEMPTY otherwise: a pack is never deleted as a side
 *  effect). Returns false when there was no such folder. */
export function deleteFolder(name, root = contentRoot()) {
  const abs = folderPath(name, root);
  let entries;
  try {
    entries = fs.readdirSync(abs);
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
  const rest = entries.filter((n) => n !== ".keep");
  if (rest.length) throw fail("ENOTEMPTY", `folder "${name}" is not empty (${rest.length} item${rest.length === 1 ? "" : "s"}); move or delete its packs first`);
  fs.rmSync(abs, { recursive: true });
  return true;
}

/** Move content/packs/<id>.yaml into `folder` ("" for the top level): a
 *  rename, so the file's text is untouched. Returns the new id. ENOENT when
 *  there is no such pack, EEXIST when the destination already has one with
 *  that stem (nothing is overwritten by a move). Moving a pack to where it
 *  already is returns its id and changes nothing. */
export function movePack(id, folder, root = contentRoot()) {
  const from = packPath(id, root);
  if (typeof folder !== "string") throw fail("EINVAL", "folder must be a string (\"\" for no folder)");
  const target = folder ? `${folder}/${splitPackId(id).stem}` : splitPackId(id).stem;
  const to = packPath(target, root);
  if (to === from) return target;
  if (!fs.existsSync(from)) throw fail("ENOENT", `no pack "${id}"`);
  if (fs.existsSync(to)) throw fail("EEXIST", `a pack "${target}" already exists`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return target;
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
 * Give the pack a new title and the filename that goes with it: the stem
 * becomes `<date>-<slug of title>`, keeping the date the stem already had (a
 * pack stays sorted where it was), else the date in `created`, else today.
 * The folder is kept. Returns the new id. EEXIST when another pack already
 * has the new name; a title whose slug does not change rewrites the file in
 * place. The file is re-serialised the way savePack writes it.
 */
export function renamePack(id, title, root = contentRoot()) {
  const from = packPath(id, root);
  if (typeof title !== "string" || !title.trim()) throw fail("EINVAL", "a pack needs a title");
  const read = readText(from);
  if (read.error) throw fail(read.error === "file is missing" ? "ENOENT" : "EIO", `no pack "${id}": ${read.error}`);
  let raw;
  try {
    raw = YAML.parse(read.text);
  } catch (e) {
    throw fail("EINVAL", `${displayPath(from)} is not valid YAML (${firstLine(e)}); fix it before renaming`);
  }
  if (!isObj(raw)) throw fail("EINVAL", `${displayPath(from)} must be a YAML mapping; fix it before renaming`);
  const { folder, stem } = splitPackId(id);
  const created = typeof raw.created === "string" ? raw.created : raw.created instanceof Date ? raw.created.toISOString() : "";
  const date = stem.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? created.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? localDate();
  const newStem = `${date}-${slugify(title)}`;
  const target = folder ? `${folder}/${newStem}` : newStem;
  const to = packPath(target, root);
  if (to !== from && fs.existsSync(to)) throw fail("EEXIST", `a pack "${target}" already exists`);
  writePackFile(to, { ...raw, title: title.trim() });
  if (to !== from) fs.unlinkSync(from);
  return target;
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
