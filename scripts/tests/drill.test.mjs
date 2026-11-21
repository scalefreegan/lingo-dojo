// First steps drills (docs/CONTENT.md "Drills"): a scenario with `format:
// drill` is the narrator alone drilling words. The loader's `format`, the
// assembler (frame-drill.md, scene-only slots skipped, the drill section),
// the session plan, the voice prompt's one speaker, and the random pool.
// Every test works on a temp copy of the fixture tree.
//   node --test scripts/tests/drill.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assemble } from "../assemble.mjs";
import { DEFAULT_LEVEL_BY_MODE, LEVELS_BY_MODE, isDrill, loadContent } from "../content.mjs";
import { budgetSplit, sessionPlan } from "../plan.mjs";
import { parseCast, parseVoiceReply, planDirective, speakersFor, voiceSlots, voiceSystemPrompt } from "../voice.mjs";
import { randomPool } from "../../web/shared/scenes.ts";
import { copyFixture, write } from "./helpers.mjs";

const DRILL = `---
id: hello-drill
title: Hello & goodbye
summary: First words.
collection: First steps
format: drill
beats:
  - Hello and goodbye
  - Please and thank you
phrases:
  - Hello
  - Thank you
---
Assume {{learner_name}} knows no {{target_language}} yet.
`;

const FRAME_DRILL = "You are the narrator of a drill for {{learner_name}}. There is no character.\n";

/** The fixture with a drill: frame-drill.md, a drill scenario, and the
 *  warm-up slot (plus a required character slot) marked scene_only. */
function drillLibrary({ frameDrill = true } = {}) {
  const root = copyFixture();
  const schemaPath = path.join(root, "schema.yaml");
  const schema = fs.readFileSync(schemaPath, "utf8")
    .replace("    title: Warm-up\n    pick: any\n    required: false\n", "    title: Warm-up\n    pick: any\n    required: false\n    scene_only: true\n")
    .concat("  - id: character\n    title: Character\n    pick: one\n    required: true\n    scene_only: true\n");
  fs.writeFileSync(schemaPath, schema);
  write(root, "units/character-plain.md", "---\nid: character-plain\nslot: character\ntitle: Plain character\nsummary: As written.\n---\nPlay the character as written.\n");
  write(root, "scenarios/hello-drill.md", DRILL);
  if (frameDrill) write(root, "frame-drill.md", FRAME_DRILL);
  return root;
}

const pack = (scenario, units = ["intro-native", "warmup-vocab", "correct-gently", "debrief-top-three", "character-plain"], overrides = {}) => ({
  title: "t", created: "", scenario, quick_scenario: "", units, overrides, notes: "",
});

/* --------------------------------- loader --------------------------------- */

test("loader: format is scene by default, drill when it says so, and anything else warns and reads as scene", () => {
  const root = drillLibrary();
  write(root, "scenarios/typo.md", "---\nid: typo\ntitle: Typo\nsummary: s\nformat: dril\n---\nBody.\n");
  const c = loadContent(root);
  const by = Object.fromEntries(c.scenarios.map((s) => [s.id, s]));
  assert.equal(by.market.format, "scene");
  assert.equal(by["hello-drill"].format, "drill");
  assert.ok(isDrill(by["hello-drill"]) && !isDrill(by.market));
  assert.equal(by.typo.format, "scene");
  const typo = c.problems.filter((p) => p.file.endsWith("typo.md"));
  assert.equal(typo.length, 1);
  assert.equal(typo[0].level, "warning");
  assert.match(typo[0].message, /format should be one of scene, drill, not "dril"; read as "scene"/);
  assert.deepEqual(c.problems.filter((p) => p.file.endsWith("hello-drill.md")), []);
});

test("loader: frame-drill.md is read when present, '' when absent; scene_only is read from the schema", () => {
  const c = loadContent(drillLibrary());
  assert.equal(c.frameDrill, FRAME_DRILL.trim());
  assert.equal(c.schema.slots.find((s) => s.id === "warmup").scene_only, true);
  assert.equal(c.schema.slots.find((s) => s.id === "intro").scene_only, false);
  assert.equal(loadContent(drillLibrary({ frameDrill: false })).frameDrill, "");
});

test("levels: Pre-A1 heads the adult scale, but a new adult learner still starts at A1", () => {
  assert.equal(LEVELS_BY_MODE.adult[0], "Pre-A1");
  assert.ok(LEVELS_BY_MODE.adult.includes("A1"));
  assert.equal(DEFAULT_LEVEL_BY_MODE.adult, "A1");
  assert.equal(DEFAULT_LEVEL_BY_MODE.kids, LEVELS_BY_MODE.kids[0]);
});

/* -------------------------------- assembler -------------------------------- */

test("assemble: a drill uses frame-drill.md, renders the drill section and drops the scene-only slots silently", () => {
  const c = loadContent(drillLibrary());
  const { markdown, warnings } = assemble(c, pack("hello-drill"));
  assert.deepEqual(warnings, []);
  assert.ok(markdown.startsWith("# Lingo Dojo session: Hello & goodbye\n\nYou are the narrator of a drill for Sam. There is no character."));
  assert.ok(!markdown.includes("You are the dojo master for a spoken"), "frame.md is not used");
  assert.match(markdown, /## The drill\n\n### Hello & goodbye\n\nFirst words\.\n\n\*\*Words and phrases to drill\*\* \([^)]*\)\n\n- Hello\n- Thank you\n\n\*\*Rounds\*\* \([^)]*\)\n\n1\. Hello and goodbye\n2\. Please and thank you\n\nAssume Sam knows no Spanish yet\./);
  assert.ok(!markdown.includes("## Scenario"));
  assert.ok(!markdown.includes("**Roles**"));
  assert.ok(!markdown.includes("**Setting:**"));
  // The warm-up (picked) and the character (required, picked) are gone,
  // headings and all; the other slots stay.
  assert.ok(!markdown.includes("## Warm-up"));
  assert.ok(!markdown.includes("## Character"));
  assert.ok(markdown.includes("## Introduction") && markdown.includes("## Corrections") && markdown.includes("## Debrief"));
});

test("assemble: a drill with no scene-only unit picked has no warning for the required one", () => {
  const c = loadContent(drillLibrary());
  const { markdown, warnings } = assemble(c, pack("hello-drill", ["intro-native", "debrief-top-three"]));
  assert.deepEqual(warnings, []);
  assert.ok(!markdown.includes("## Character"));
});

test("assemble: a normal scene is unchanged by the drill machinery", () => {
  const plain = loadContent(copyFixture());
  const withDrill = loadContent(drillLibrary());
  const units = ["intro-native", "warmup-vocab", "correct-gently", "debrief-top-three"];
  const before = assemble(plain, pack("market", units, { minutes: 10 }));
  const after = assemble(withDrill, pack("market", [...units, "character-plain"], { minutes: 10 }));
  // The same prompt, plus only the character slot the drill library added.
  assert.equal(after.markdown.replace("\n\n## Character\n\n### Plain character\n\nPlay the character as written.", ""), before.markdown);
  assert.ok(after.markdown.includes("## Scenario") && after.markdown.includes("## Warm-up"));
  assert.ok(after.markdown.startsWith("# Lingo Dojo session: Buying fruit at the market\n\nYou are the dojo master for a spoken Spanish"));
});

test("assemble: a drill in a library with no frame-drill.md falls back to frame.md with a warning", () => {
  const c = loadContent(drillLibrary({ frameDrill: false }));
  const { markdown, warnings } = assemble(c, pack("hello-drill"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /is a drill, but the library has no frame-drill\.md; it uses frame\.md/);
  assert.ok(markdown.includes("You are the dojo master for a spoken Spanish"));
  assert.ok(markdown.includes("## The drill"));
});

test("assemble: a drill's time budget speaks of the drill and its rounds", () => {
  const c = loadContent(drillLibrary());
  const { markdown } = assemble(c, pack("hello-drill", undefined, { minutes: 10 }));
  assert.match(markdown, /- Drill: Hello & goodbye: about \d+½? minutes, all 2 rounds/);
  assert.ok(markdown.includes("Play fewer rounds"));
  assert.ok(markdown.includes("start closing the drill; once the time is up, end the drill"));
  assert.ok(!/Warm-up:/.test(markdown.slice(markdown.indexOf("## Time budget"))));
});

/* ---------------------------------- plan ---------------------------------- */

test("sessionPlan: a drill is intro, the drill and its rounds, then the debrief; no warm-ups", () => {
  const c = loadContent(drillLibrary());
  const plan = sessionPlan(c, pack("hello-drill"));
  assert.deepEqual(plan.map((p) => [p.id, p.kind]), [
    ["intro", "intro"],
    ["scene", "scene"],
    ["beat:1", "beat"],
    ["beat:2", "beat"],
    ["debrief:debrief-top-three", "debrief"],
  ]);
  assert.equal(plan[1].title, "Hello & goodbye");
  const rows = budgetSplit(plan, 10);
  assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 10);
  assert.equal(rows.find((r) => r.kind === "scene").beats, 2);
  // A scene keeps its warm-up.
  assert.ok(sessionPlan(c, pack("market")).some((p) => p.kind === "warmup"));
});

test("sessionPlan (kids): a drill plays no games on the timeline, not even the opener", () => {
  const root = copyFixture();
  const kids = path.join(root, "kids");
  write(kids, "scenarios/count-drill.md", "---\nid: count-drill\ntitle: Numbers\nsummary: s\nformat: drill\nbeats: [One to three, Four to six]\nphrases: [one, two]\n---\nCount.\n");
  const c = loadContent(kids);
  const units = ["intro-game", "game-echo", "story-quest"];
  const scenePlan = sessionPlan(c, { scenario: "farm", units }, "kids");
  assert.ok(scenePlan.some((p) => p.kind === "games"), "the fixture's scene has its game");
  const plan = sessionPlan(c, { scenario: "count-drill", units }, "kids");
  assert.deepEqual(plan.map((p) => p.id), ["intro", "scene", "beat:1", "beat:2"]);
});

/* ---------------------------------- voice --------------------------------- */

test("voice: a drill allows only the narrator's tag", () => {
  assert.deepEqual(speakersFor("adult", { drill: true }), ["narrator"]);
  assert.deepEqual(speakersFor("kids", { drill: true }), ["narrator"]);
  assert.deepEqual(speakersFor("adult"), ["narrator", "character"]);
  assert.deepEqual(voiceSlots("kids", { drill: true }), ["narrator:female", "narrator:male"]);
  const drill = voiceSystemPrompt("# Pack", "adult", { drill: true });
  assert.ok(drill.includes("you, the narrator, are the only speaker"));
  assert.ok(!/CHARACTER-[FM]:/.test(drill), "no example teaches a CHARACTER tag");
  assert.ok(drill.includes("Write no CAST lines"));
  const scene = voiceSystemPrompt("# Pack", "adult");
  assert.ok(scene.includes("CHARACTER-M: <t>¡Claro que sí, güero! ¿Algo más?</t>"));
  assert.ok(scene.includes("CAST: CHARACTER-F old, Doña Carmen, the fruit vendor"));
  assert.equal(voiceSystemPrompt("# Pack", "adult", {}), scene, "no drill flag is the scene prompt");
});

test("voice: in a drill a CHARACTER or SIDEKICK line is voiced as the narrator, not dropped", () => {
  const reply = "NARRATOR-F: Say <t>hola</t>.\nCHARACTER-M: <t>¡Hola!</t>\nSIDEKICK-F: <t>Adiós</t>";
  const lines = parseVoiceReply(reply, "kids", { drill: true });
  assert.deepEqual(lines.map((l) => [l.speaker, l.gender, l.text]), [
    ["narrator", "female", "Say hola."],
    ["narrator", null, "¡Hola!"],
    ["narrator", null, "Adiós"],
  ]);
  // A scene keeps them as they were tagged.
  assert.deepEqual(parseVoiceReply(reply, "kids").map((l) => l.speaker), ["narrator", "character", "sidekick"]);
  // A CAST line for a character casts nobody in a drill.
  assert.deepEqual(parseCast("CAST: CHARACTER-F old, Doña Carmen", "adult", { drill: true }), []);
  assert.equal(parseCast("CAST: CHARACTER-F old, Doña Carmen", "adult").length, 1);
});

test("voice: a drill's plan directive names rounds, not a character's beat", () => {
  const plan = [{ id: "intro", title: "Introduction", kind: "intro" }, { id: "scene", title: "Hello", kind: "scene" }];
  const drill = planDirective(plan, { drill: true });
  assert.ok(drill.includes("the part with id scene is the drill itself"));
  assert.ok(!drill.includes("the character's first line"));
  assert.ok(planDirective(plan).includes("the character's first line"));
});

/* ------------------------------- random pool ------------------------------ */

const sc = (id, collection, format = "scene", language = null) => ({ id, title: id, summary: "", tags: [], language, collection, category: null, format, roles: {}, beats: [], vocab: [], phrases: [], twists: [], body: "", path: "", uses_location: false });
const LANGS = [{ name: "Spanish", variants: [], code: "es" }, { name: "Mandarin Chinese", variants: [], code: "zh" }];
const LIBRARY = [
  sc("hello", "First steps", "drill"),
  sc("numbers", "First steps", "drill"),
  sc("tones", "First steps (Mandarin)", "drill", "zh-TW"),
  sc("taxi", "Travel essentials"),
  sc("cafe", "Daily life"),
];

test("randomPool: drills are left out of a pool that has any scene", () => {
  assert.deepEqual(randomPool(LIBRARY, LANGS, "Spanish", { collections: [] }).map((s) => s.id), ["taxi", "cafe"]);
  assert.deepEqual(randomPool(LIBRARY, LANGS, "Spanish", { collections: ["First steps", "Daily life"] }).map((s) => s.id), ["cafe"]);
});

test("randomPool: a pool of nothing but drills keeps them, so a First steps random pack still draws", () => {
  assert.deepEqual(randomPool(LIBRARY, LANGS, "Spanish", { collections: ["First steps"] }).map((s) => s.id), ["hello", "numbers"]);
  assert.deepEqual(randomPool(LIBRARY, LANGS, "Mandarin Chinese", { collections: ["First steps", "First steps (Mandarin)"] }).map((s) => s.id), ["hello", "numbers", "tones"]);
  // The language rule still comes first: Spanish never draws the tones.
  assert.deepEqual(randomPool(LIBRARY, LANGS, "Spanish", { collections: ["First steps (Mandarin)"] }), []);
});

test("assemble: a random pack's preview counts the pool without drills", () => {
  const c = loadContent(drillLibrary());
  const all = assemble(c, { ...pack(""), random_scene: { collections: [] } });
  const fit = c.scenarios.filter((s) => s.format !== "drill").length;
  assert.ok(all.markdown.includes(`one of the ${fit} scenes in its pool`));
  const firstSteps = assemble(c, { ...pack(""), random_scene: { collections: ["First steps"] } });
  assert.ok(firstSteps.markdown.includes("one of the 1 scene in its pool"));
});

test("a unit's closing renders last under the drill frame, and a scene_only unit's closing is skipped", () => {
  const root = drillLibrary();
  write(root, "units/intro-closing.md", "---\nid: intro-closing\nslot: intro\ntitle: Closing intro\nsummary: s\nclosing: Only {{target_language}} for {{learner_name}}.\n---\nOpen.\n");
  write(root, "units/warmup-closing.md", "---\nid: warmup-closing\nslot: warmup\ntitle: Warm closing\nsummary: s\nclosing: Warm-up rule.\n---\nWarm.\n");
  const c = loadContent(root);
  const { markdown } = assemble(c, pack("hello-drill", ["intro-closing", "warmup-closing", "correct-gently", "character-plain"]), "adult");
  assert.match(markdown, /^You are the narrator of a drill/m, "the drill frame");
  assert.match(markdown, /## Final rules\n\n[^\n]+\n\n### Closing intro\n\nOnly [^\n]+ for [^\n]+\.\n$/);
  assert.ok(!markdown.includes("Warm-up rule."), "a scene-only slot's closing goes with its unit");
});
