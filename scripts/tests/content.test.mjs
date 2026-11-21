// The loader against docs/CONTENT.md: what loads, what is reported, and that
// a bad file is reported rather than thrown.
//   node --test scripts/tests/content.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  loadContent, loadPackFile, loadPackFiles, parseFrontmatter, saveProfile, writeExport, safeJoin, contentRoot,
  listFolders, splitPackId, slugify, renamedStem, PACK_ID_RE,
} from "../content.mjs";
import { FIXTURE, copyFixture, write } from "./helpers.mjs";

const problemFor = (content, suffix) => content.problems.filter((p) => p.file.endsWith(suffix));

test("loads the fixture tree: schema order, units, scenarios, profile, frame; pack files are not the library's", () => {
  const c = loadContent(FIXTURE);
  assert.deepEqual(c.schema.slots.map((s) => s.id), ["intro", "warmup", "corrections", "debrief"]);
  assert.equal(c.schema.slots[0].required, true);
  assert.equal(c.schema.slots[1].required, false);
  // sorted by filename, broken-unit.md left out
  assert.deepEqual(c.units.map((u) => u.id), [
    "correct-gently", "correct-strict", "debrief-top-three", "intro-native", "intro-target",
    "orphan-unit", "warmup-odd", "warmup-vocab",
  ]);
  assert.deepEqual(c.scenarios.map((s) => s.id), ["market", "plaza"]);
  assert.equal(c.packs, undefined, "pack files are read by loadPackFiles only");
  assert.deepEqual(loadPackFiles(FIXTURE).packs.map((p) => p.id), ["2026-10-19-market-gentle"]);
  assert.equal(c.profile.learner_name, "Sam");
  assert.match(c.frame, /^You are the dojo master/);
  // languages.yaml: file order, variants [] when the key is absent
  assert.deepEqual(c.languages.map((l) => l.name), ["English", "Spanish", "Japanese", "Italian", "Korean"]);
  assert.deepEqual(c.languages[2].variants, ["Standard Japanese (Tokyo)", "Kansai dialect"]);
  assert.deepEqual(c.languages[4], { name: "Korean", variants: [], code: null });
});

test("languages.yaml: missing is a warning and an empty list; off-contract is an error; bad entries are skipped", () => {
  const root = copyFixture();
  const file = path.join(root, "languages.yaml");
  fs.rmSync(file);
  let c = loadContent(root);
  assert.deepEqual(c.languages, []);
  assert.deepEqual(problemFor(c, "languages.yaml").map((p) => p.level), ["warning"]);
  assert.match(problemFor(c, "languages.yaml")[0].message, /file is missing; the language pickers fall back to free text/);

  write(root, "languages.yaml", "languages: {name: nope}\n");
  c = loadContent(root);
  assert.deepEqual(c.languages, []);
  assert.match(problemFor(c, "languages.yaml").map((p) => `${p.level}: ${p.message}`).join(), /^error: languages\.yaml must be a YAML mapping with a `languages` list$/);

  write(root, "languages.yaml", "languages: [unclosed\n");
  c = loadContent(root);
  assert.deepEqual(c.languages, []);
  assert.match(problemFor(c, "languages.yaml")[0].message, /^not valid YAML/);

  write(root, "languages.yaml", [
    "languages:",
    "  - name: Ok",
    "    variants: [A, 3]",
    "  - variants: [X]",
    "  - name: Bad",
    "    variants: Nope",
    "  - name: Ok",
    "  - name: '  '",
  ].join("\n"));
  c = loadContent(root);
  assert.deepEqual(c.languages, [{ name: "Ok", variants: ["A"], code: null }]);
  assert.deepEqual(problemFor(c, "languages.yaml").map((p) => `${p.level}: ${p.message}`), [
    "warning: languages[0] (Ok): variants[1] is not a string; skipped",
    "error: languages[1] needs a non-empty `name`; skipped",
    "error: languages[2] (Bad): `variants` must be a list of strings; skipped",
    'warning: languages[3]: duplicate language "Ok"; kept the first',
    "error: languages[4] needs a non-empty `name`; skipped",
  ]);
});

test("unit fields are normalized; unknown frontmatter keys are preserved", () => {
  const c = loadContent(FIXTURE);
  const vocab = c.units.find((u) => u.id === "warmup-vocab");
  assert.equal(vocab.default, true);
  assert.deepEqual(vocab.tags, ["warmup", "vocab"]);
  assert.equal(vocab.source, "fixture");
  const target = c.units.find((u) => u.id === "intro-target");
  assert.equal(target.default, false, "default is optional and false when absent");
  assert.deepEqual(target.level, ["B1"], "a scalar level becomes a one-item list");
  const native = c.units.find((u) => u.id === "intro-native");
  assert.ok(native.body.startsWith("Greet {{learner_name}}"), "leading blank lines after --- are dropped");
  const gently = c.units.find((u) => u.id === "correct-gently");
  assert.ok(gently.body.endsWith("continue."), "trailing whitespace is trimmed");
});

test("scenario fields: roles, beats, vocab; only id/title/summary required", () => {
  const c = loadContent(FIXTURE);
  const market = c.scenarios.find((s) => s.id === "market");
  assert.equal(market.roles.dojo_master, "Doña Rosa, the fruit vendor, quick and friendly");
  assert.equal(market.beats.length, 3);
  assert.deepEqual(market.vocab[0], { term: "¿Cuánto cuesta?", gloss: "How much is it?" });
  assert.equal(market.language, "es-MX");
  const plaza = c.scenarios.find((s) => s.id === "plaza");
  assert.deepEqual([plaza.roles, plaza.beats, plaza.vocab, plaza.body], [{}, [], [], ""]);
});

test("a unit missing a required key is an error with its file path, and is not loaded", () => {
  const c = loadContent(FIXTURE);
  const [p, ...rest] = problemFor(c, "units/broken-unit.md");
  assert.equal(rest.length, 0);
  assert.equal(p.level, "error");
  assert.match(p.message, /missing required key\(s\): title/);
  assert.ok(!c.units.some((u) => u.id === "broken-unit"));
});

test("a unit whose slot is not in the schema loads with a warning", () => {
  const c = loadContent(FIXTURE);
  const [p] = problemFor(c, "units/orphan-unit.md");
  assert.equal(p.level, "warning");
  assert.match(p.message, /slot "interrupts" is not in schema\.yaml/);
  assert.ok(c.units.some((u) => u.id === "orphan-unit"));
});

test("the fixture has exactly the two deliberate problems", () => {
  // Pins the fixture itself: a new problem here means a test's premise moved.
  const c = loadContent(FIXTURE);
  assert.deepEqual(c.problems.map((p) => [path.basename(p.file), p.level]), [
    ["broken-unit.md", "error"],
    ["orphan-unit.md", "warning"],
  ]);
});

test("bad files are reported, never thrown: bad YAML, no frontmatter, id/filename mismatch, missing scenario keys", () => {
  const root = copyFixture();
  write(root, "units/bad-yaml.md", "---\nid: bad-yaml\nslot: [unclosed\n---\nbody\n");
  write(root, "units/no-fm.md", "Just a body, no frontmatter.\n");
  write(root, "units/unclosed.md", "---\nid: unclosed\nslot: warmup\n");
  write(root, "units/renamed.md", "---\nid: something-else\nslot: warmup\ntitle: T\nsummary: S\n---\nbody\n");
  write(root, "scenarios/no-summary.md", "---\nid: no-summary\ntitle: T\n---\n");
  write(root, "packs/2026-01-01-bad.yaml", "title: [unclosed\n");
  write(root, "packs/2026-01-02-untitled.yaml", "units: [intro-native]\n");
  let c;
  assert.doesNotThrow(() => { c = loadContent(root); });
  const msg = (suffix) => problemFor(c, suffix).map((p) => `${p.level}: ${p.message}`).join(" | ");
  assert.match(msg("units/bad-yaml.md"), /^error: frontmatter is not valid YAML/);
  assert.match(msg("units/no-fm.md"), /^error: missing frontmatter/);
  assert.match(msg("units/unclosed.md"), /^error: frontmatter is not closed/);
  assert.match(msg("units/renamed.md"), /^error: id "something-else" must equal the filename stem "renamed"/);
  assert.match(msg("scenarios/no-summary.md"), /^error: missing required key\(s\): summary/);
  // Broken pack files are no problem of the library's (the app never reads
  // them); loadPackFiles reports them, for the import and the export CLI.
  assert.equal(msg("packs/2026-01-01-bad.yaml"), "");
  const files = loadPackFiles(root);
  const fileMsg = (suffix) => files.problems.filter((p) => p.file.endsWith(suffix)).map((p) => `${p.level}: ${p.message}`).join(" | ");
  assert.match(fileMsg("packs/2026-01-01-bad.yaml"), /^error: not valid YAML/);
  assert.match(fileMsg("packs/2026-01-02-untitled.yaml"), /^error: missing required key\(s\): title/);
  // every rejected file is absent; the good ones still load
  for (const id of ["bad-yaml", "no-fm", "unclosed", "renamed"]) assert.ok(!c.units.some((u) => u.id === id), id);
  assert.ok(c.units.some((u) => u.id === "intro-native"));
  assert.deepEqual(files.packs.map((p) => p.id), ["2026-10-19-market-gentle"]);
});

test("missing files and a bad schema are problems, not crashes", () => {
  const root = copyFixture();
  fs.rmSync(path.join(root, "frame.md"));
  fs.rmSync(path.join(root, "profile.yaml"));
  write(root, "schema.yaml", [
    "version: 1",
    "slots:",
    "  - { id: intro, title: Introduction, pick: one, required: true }",
    "  - { id: warmup, title: Warm-up, pick: some }",
    "  - { id: intro, title: Again, pick: any }",
    "  - { title: No id, pick: any }",
  ].join("\n"));
  const c = loadContent(root);
  assert.equal(c.frame, "");
  assert.deepEqual(c.profile, {});
  assert.deepEqual(c.schema.slots.map((s) => s.id), ["intro"]);
  const messages = c.problems.map((p) => `${path.basename(p.file)}: ${p.message}`);
  assert.ok(messages.includes("frame.md: file is missing"), messages.join("\n"));
  assert.ok(messages.includes("profile.yaml: file is missing"));
  assert.ok(messages.some((m) => /schema\.yaml: slots\[1\] \(warmup\): pick must be "one" or "any"/.test(m)));
  assert.ok(messages.some((m) => /schema\.yaml: slots\[2\]: duplicate slot id "intro"/.test(m)));
  assert.ok(messages.some((m) => /schema\.yaml: slots\[3\] is missing required key\(s\): id/.test(m)));
});

test("an empty content root loads as an empty library with problems", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-empty-"));
  try {
    const c = loadContent(root);
    assert.deepEqual([c.units, c.scenarios, loadPackFiles(root).packs, c.schema.slots, c.languages], [[], [], [], [], []]);
    assert.ok(c.problems.some((p) => p.file.endsWith("schema.yaml") && p.level === "error"));
    assert.ok(c.problems.some((p) => p.file.endsWith("languages.yaml") && p.level === "warning"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parseFrontmatter tolerates CRLF and an empty frontmatter block", () => {
  assert.deepEqual(parseFrontmatter("---\r\nid: x\r\n---\r\n\r\nbody\r\n"), { data: { id: "x" }, body: "body" });
  assert.deepEqual(parseFrontmatter("---\n---\nbody"), { data: {}, body: "body" });
  assert.ok(parseFrontmatter("---\n- a\n- b\n---\n").error.includes("mapping"));
});

test("LINGO_CONTENT_DIR moves the content root, resolved against the repo root", () => {
  const before = process.env.LINGO_CONTENT_DIR;
  try {
    process.env.LINGO_CONTENT_DIR = "scripts/tests/fixtures/content";
    assert.equal(contentRoot(), FIXTURE);
    assert.equal(loadContent().profile.learner_name, "Sam");
  } finally {
    if (before === undefined) delete process.env.LINGO_CONTENT_DIR;
    else process.env.LINGO_CONTENT_DIR = before;
  }
});

test("saveProfile merges in place: other keys keep their order, comments and block style; blank removes a key", () => {
  const root = copyFixture();
  const abs = path.join(root, "profile.yaml");
  fs.writeFileSync(abs, [
    "# who is practising",
    "learner_name: Sam # not Samantha",
    "native_language: English",
    "target_language: Spanish",
    "target_variant: Mexican Spanish",
    "level: A2",
    "goals: >",
    "  Order food and chat",
    "  with vendors.",
    "notes: Likes direct corrections.",
    "",
  ].join("\n"));
  assert.equal(saveProfile({ target_language: "Japanese", target_variant: "", level: " B1 " }, root), abs);
  const text = fs.readFileSync(abs, "utf8");
  assert.deepEqual(Object.keys(YAML.parse(text)), ["learner_name", "native_language", "target_language", "level", "goals", "notes"]);
  assert.ok(text.startsWith("# who is practising\nlearner_name: Sam # not Samantha\n"), text);
  // yaml keeps the block style and the value but re-flows a folded scalar's
  // line breaks to its line width; that is the "as best yaml allows" caveat.
  assert.match(text, /\ngoals: >\n  Order food/, "the folded block style is kept");
  assert.equal(YAML.parse(text).goals, "Order food and chat with vendors.\n");
  const profile = loadContent(root).profile;
  assert.equal(profile.target_language, "Japanese");
  assert.equal(profile.level, "B1", "values are trimmed");
  assert.ok(!("target_variant" in profile), "a blank value removes the key rather than writing an empty string");
  // a key the profile never had is appended
  saveProfile({ target_variant: "Kansai dialect" }, root);
  assert.ok(fs.readFileSync(abs, "utf8").endsWith("notes: Likes direct corrections.\ntarget_variant: Kansai dialect\n"));
});

test("saveProfile creates a missing profile.yaml and refuses to overwrite a broken one", () => {
  const root = copyFixture();
  const abs = path.join(root, "profile.yaml");
  fs.rmSync(abs);
  saveProfile({ level: "A1" }, root);
  assert.equal(fs.readFileSync(abs, "utf8"), "level: A1\n");
  for (const broken of ["a: [unclosed\n", "just a scalar\n", "- a list\n"]) {
    fs.writeFileSync(abs, broken);
    assert.throws(() => saveProfile({ level: "A1" }, root), /not valid YAML|must be a YAML mapping/, JSON.stringify(broken));
    assert.equal(fs.readFileSync(abs, "utf8"), broken, "the broken file is left for a person to fix");
  }
});

test("ids that could escape their directory are refused before any write", () => {
  const root = copyFixture();
  // a pack id may have one folder; an export id may not
  for (const id of ["../evil", "a/b/c", "a/../b", "/a", "a/", "a//b", "./a", ".keep/x", "A-Upper", "-leading", "", "x.yaml", "..", "a\\b"]) {
    assert.equal(PACK_ID_RE.test(id), false, id);
  }
  for (const id of ["2026-10-19-x", "oaxaca/2026-10-19-x"]) assert.equal(PACK_ID_RE.test(id), true, id);
  for (const id of ["../evil", "a/b", "A-Upper", "-leading", "", "x.yaml", "..", "a\\b"]) {
    assert.throws(() => writeExport(id, "x", path.join(root, "exports")), /invalid id/, id);
  }
  assert.throws(() => safeJoin(root, "ok", "/../../x"), /escapes/);
  assert.ok(!fs.existsSync(path.join(root, "evil.yaml")));
  assert.deepEqual(splitPackId("oaxaca/2026-10-19-x"), { folder: "oaxaca", stem: "2026-10-19-x" });
  assert.deepEqual(splitPackId("2026-10-19-x"), { folder: "", stem: "2026-10-19-x" });
});

/* ------------------------------- folders --------------------------------- */

test("packs load one folder deep with folder ids; deeper and dot-directories are ignored", () => {
  const root = copyFixture();
  write(root, "packs/oaxaca/2026-10-20-mezcal.yaml", "title: Mezcal\n");
  write(root, "packs/oaxaca/.keep", "");
  write(root, "packs/empty/.keep", "");
  write(root, "packs/deep/deeper/2026-10-21-nope.yaml", "title: Nope\n");
  write(root, "packs/.hidden/2026-10-22-nope.yaml", "title: Nope\n");
  write(root, "packs/Bad Name/2026-10-23-x.yaml", "title: Bad\n");
  const c = loadPackFiles(root);
  assert.deepEqual(c.packs.map((p) => [p.id, p.folder]), [
    ["2026-10-19-market-gentle", ""],
    ["Bad Name/2026-10-23-x", "Bad Name"],
    ["oaxaca/2026-10-20-mezcal", "oaxaca"],
  ]);
  const bad = problemFor(c, "Bad Name/2026-10-23-x.yaml");
  assert.equal(bad.length, 1);
  assert.equal(bad[0].level, "warning");
  assert.match(bad[0].message, /"Bad Name\/2026-10-23-x" is not a valid pack id/);
  assert.equal(problemFor(c, "mezcal.yaml").length, 0);
  assert.deepEqual(listFolders(root), ["Bad Name", "deep", "empty", "oaxaca"]);
  assert.deepEqual(listFolders(path.join(root, "nowhere")), []);
});

test("loadPackFiles: the packs that load, every folder (an empty one too), and only the pack files' problems", () => {
  const root = copyFixture();
  write(root, "packs/oaxaca/2026-10-20-mezcal.yaml", "title: Mezcal\ncreated: 2026-10-20T10:00:00-06:00\n");
  write(root, "packs/empty/.keep", "");
  write(root, "packs/2026-10-21-broken.yaml", "title: [unclosed\n");
  const files = loadPackFiles(root);
  assert.deepEqual(files.packs.map((p) => p.id), ["2026-10-19-market-gentle", "oaxaca/2026-10-20-mezcal"]);
  assert.equal(files.packs[1].folder, "oaxaca");
  assert.deepEqual(files.folders, ["empty", "oaxaca"]);
  assert.deepEqual(files.problems.map((p) => p.file.split("/").slice(-2).join("/")), ["packs/2026-10-21-broken.yaml"]);
  assert.deepEqual(loadPackFiles(path.join(root, "nowhere")).packs, []);
});

test("renamedStem keeps the stem's date, else the created date, else today; slugify folds accents", () => {
  assert.equal(renamedStem("2026-10-20-mezcal", "2025-01-01T00:00:00Z", "  Café en Oaxaca "), "2026-10-20-cafe-en-oaxaca");
  assert.equal(renamedStem("undated", "2025-01-02T00:00:00Z", "Now dated"), "2025-01-02-now-dated");
  assert.match(renamedStem("nodate", "", "Today"), /^\d{4}-\d{2}-\d{2}-today$/);
  assert.equal(slugify("Café en Oaxaca"), "cafe-en-oaxaca");
  assert.equal(slugify("!!!"), "pack");
});

/* ---------------------------------- modes --------------------------------- */

test("modeRoot: adult is the content root, kids is content/kids; anything else is EINVAL", async () => {
  const { MODES, isMode, modeRoot, exportsDirFor, LEVELS_BY_MODE } = await import("../content.mjs");
  assert.deepEqual(MODES, ["adult", "kids"]);
  assert.equal(isMode("kids"), true);
  assert.equal(isMode("teen"), false);
  assert.equal(isMode(undefined), false);
  assert.equal(modeRoot(), contentRoot());
  assert.equal(modeRoot("adult"), contentRoot());
  assert.equal(modeRoot("kids"), path.join(contentRoot(), "kids"));
  assert.throws(() => modeRoot("teen"), { code: "EINVAL" });
  assert.equal(exportsDirFor("kids"), path.join(exportsDirFor("adult"), "kids"));
  assert.throws(() => exportsDirFor("x"), { code: "EINVAL" });
  // Levels are the picker's options, so each mode must name at least one and
  // the two lists must not overlap: a level says which library it belongs to.
  for (const m of MODES) assert.ok(LEVELS_BY_MODE[m].length > 0, m);
  assert.deepEqual(LEVELS_BY_MODE.adult.filter((l) => LEVELS_BY_MODE.kids.includes(l)), []);
});

test("the kids tree loads on its own and shares the content root's languages.yaml", async () => {
  const { modeRoot } = await import("../content.mjs");
  const root = copyFixture();
  const was = process.env.LINGO_CONTENT_DIR;
  process.env.LINGO_CONTENT_DIR = root;
  try {
    const kids = loadContent(modeRoot("kids"));
    assert.deepEqual(kids.schema.slots.map((s) => s.id), ["intro", "story", "games"]);
    assert.deepEqual(kids.units.map((u) => u.id).sort(), ["game-echo", "intro-game", "story-quest"]);
    assert.deepEqual(kids.scenarios.map((s) => s.id), ["farm"]);
    assert.deepEqual(loadPackFiles(modeRoot("kids")).packs.map((p) => p.id), ["2026-10-20-farm-first"]);
    assert.equal(kids.profile.learner_name, "Pip");
    assert.match(kids.frame, /^You are the dojo master running a short play session/);
    // No languages.yaml of its own: the root's list, and no problem about it.
    assert.ok(kids.languages.some((l) => l.name === "Spanish"), "root languages");
    assert.deepEqual(problemFor(kids, "languages.yaml"), []);
    // The adult tree knows nothing of kids/: no kids unit, scenario or pack leaks up.
    const adult = loadContent(modeRoot("adult"));
    assert.ok(!adult.units.some((u) => u.id === "intro-game"));
    assert.ok(!adult.scenarios.some((s) => s.id === "farm"));
    assert.ok(!loadPackFiles(modeRoot("adult")).packs.some((p) => p.id.includes("farm")));
    assert.ok(!listFolders(root).includes("kids"));
    // Its own languages.yaml wins when present; neither file is a warning.
    write(root, "kids/languages.yaml", "version: 1\nlanguages:\n  - name: Klingon\n    variants: []\n");
    assert.deepEqual(loadContent(modeRoot("kids")).languages.map((l) => l.name), ["Klingon"]);
    fs.rmSync(path.join(root, "kids", "languages.yaml"));
    fs.rmSync(path.join(root, "languages.yaml"));
    const none = loadContent(modeRoot("kids"));
    assert.deepEqual(none.languages, []);
    assert.equal(problemFor(none, "languages.yaml").length, 1, "missing everywhere is reported once");
  } finally {
    if (was === undefined) delete process.env.LINGO_CONTENT_DIR;
    else process.env.LINGO_CONTENT_DIR = was;
  }
});

test("languages.yaml: an optional ISO code, lowercased", () => {
  const root = copyFixture();
  write(root, "languages.yaml", ["languages:", "  - name: Spanish", "    code: ES", "  - name: Odd", "    code: 3"].join("\n"));
  const c = loadContent(root);
  assert.deepEqual(c.languages, [{ name: "Spanish", variants: [], code: "es" }, { name: "Odd", variants: [], code: null }]);
  assert.match(problemFor(c, "languages.yaml")[0].message, /`code` should be a string/);
});

test("scenarios: phrases, uses_location, and {{location}} where it can't be filled", () => {
  const root = copyFixture();
  write(root, "scenarios/anywhere.md", [
    "---",
    "id: anywhere",
    "title: 'A taxi in {{location}}'",
    "summary: Across town.",
    "roles:",
    "  dojo_master: a driver from {{location}}",
    "beats: [Getting in, 'Paying in {{location}}']",
    "phrases: [Take me downtown, '', 4]",
    "---",
    "Body without the placeholder.",
  ].join("\n"));
  const c = loadContent(root);
  const s = c.scenarios.find((x) => x.id === "anywhere");
  assert.deepEqual(s.phrases, ["Take me downtown"]);
  assert.equal(s.uses_location, true);
  assert.equal(c.scenarios.find((x) => x.id === "market").uses_location, false);
  assert.deepEqual(problemFor(c, "anywhere.md").map((p) => p.message), [
    "phrases[1] should be a non-empty string; skipped",
    "phrases[2] should be a non-empty string; skipped",
    "title uses {{location}}, which is only filled in roles, twists and the body; it will show as-is",
    "beats[1] uses {{location}}, which is only filled in roles, twists and the body; it will show as-is",
  ]);
});

test("scenarios: an unquoted ': ' line is read back with a warning; a non-string language is dropped", () => {
  const root = copyFixture();
  write(root, "scenarios/colon.md", [
    "---",
    "id: colon",
    "title: Colon",
    "summary: S.",
    "language: [es]",
    "beats:",
    "  - Arriving",
    "  - Checkout: bags and payment",
    "phrases: ['In {{location}}']",
    "---",
    "Body.",
  ].join("\n"));
  const c = loadContent(root);
  const s = c.scenarios.find((x) => x.id === "colon");
  assert.deepEqual(s.beats, ["Arriving", "Checkout: bags and payment"]);
  assert.equal(s.language, null);
  assert.deepEqual(problemFor(c, "colon.md").map((p) => p.message), [
    'beats[1] parsed as a mapping (an unquoted ": "); read as "Checkout: bags and payment" — quote the line',
    "phrases[0] uses {{location}}, which is only filled in roles, twists and the body; it will show as-is",
    'language should be a code like "es-MX"; ignored',
  ]);
});

test("a unit's closing is loaded as trimmed text, '' when absent, and a non-text one is ignored", () => {
  const root = copyFixture();
  write(root, "units/with-closing.md", "---\nid: with-closing\nslot: intro\ntitle: C\nsummary: s\nclosing: |\n  Last words.\n---\nbody\n");
  write(root, "units/bad-closing.md", "---\nid: bad-closing\nslot: intro\ntitle: B\nsummary: s\nclosing: [a, b]\n---\nbody\n");
  const c = loadContent(root);
  assert.equal(c.units.find((u) => u.id === "with-closing").closing, "Last words.");
  assert.equal(c.units.find((u) => u.id === "bad-closing").closing, "");
  assert.equal(c.units.find((u) => u.id === "correct-gently").closing, "");
  assert.ok(JSON.stringify(c.problems).includes("closing must be text"), JSON.stringify(c.problems));
});
