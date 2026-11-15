// The assembler against the "Assembly algorithm" section of docs/CONTENT.md.
//   node --test scripts/tests/assemble.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadContent } from "../content.mjs";
import { assemble, CHOSEN_CITY, MISSING_UNIT_LINE, QUICK_SCENARIO_TITLE } from "../assemble.mjs";
import { FIXTURE, copyFixture, write } from "./helpers.mjs";

const content = loadContent(FIXTURE);
const base = {
  title: "t",
  scenario: "market",
  units: ["intro-native", "warmup-vocab", "correct-gently", "debrief-top-three"],
};
const run = (over = {}, c = content) => assemble(c, { ...base, ...over });
/** `## ` headings in output order. */
const h2 = (md) => md.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3));

test("renders the contract's sections in order", () => {
  const { markdown, warnings } = run({ notes: "More numbers." });
  assert.deepEqual(warnings, []);
  assert.ok(markdown.startsWith("# Lingo Dojo session: Buying fruit at the market\n\nYou are the dojo master"));
  assert.deepEqual(h2(markdown), ["Learner", "Scenario", "Introduction", "Warm-up", "Corrections", "Debrief", "Notes from the learner"]);
  assert.ok(markdown.endsWith("## Notes from the learner\n\nMore numbers.\n"));
});

test("the fixture pack file assembles cleanly", () => {
  const { markdown, warnings } = assemble(content, content.packs[0]);
  assert.deepEqual(warnings, []);
  assert.match(markdown, /- \*\*Level:\*\* B1/);
});

test("slot order follows the schema, not the pack", () => {
  const { markdown } = run({ units: ["debrief-top-three", "correct-gently", "warmup-vocab", "intro-native"] });
  assert.deepEqual(h2(markdown).slice(2), ["Introduction", "Warm-up", "Corrections", "Debrief"]);
});

test("within a pick:any slot, units follow pack order", () => {
  const a = run({ units: ["intro-native", "warmup-vocab", "warmup-odd"] }).markdown;
  const b = run({ units: ["intro-native", "warmup-odd", "warmup-vocab"] }).markdown;
  assert.ok(a.indexOf("### Vocabulary warm-up") < a.indexOf("### Odd placeholder warm-up"));
  assert.ok(b.indexOf("### Odd placeholder warm-up") < b.indexOf("### Vocabulary warm-up"));
});

test("pick:one with two units warns and keeps the first", () => {
  const { markdown, warnings } = run({ units: ["intro-native", "correct-strict", "correct-gently"] });
  assert.deepEqual(warnings, [
    'Slot "Corrections" takes one unit but the pack has 2 (correct-strict, correct-gently); kept "correct-strict".',
  ]);
  assert.match(markdown, /### Strict corrections/);
  assert.doesNotMatch(markdown, /### Gentle in-line corrections/);
});

test("a required slot with no unit warns and renders a placeholder line", () => {
  const { markdown, warnings } = run({ units: ["warmup-vocab"] });
  assert.deepEqual(warnings, ['Required slot "Introduction" has no unit selected.']);
  assert.ok(markdown.includes(`## Introduction\n\n${MISSING_UNIT_LINE}\n\n## Warm-up`));
});

test("empty optional slots are omitted", () => {
  const { markdown } = run({ units: ["intro-native"] });
  assert.deepEqual(h2(markdown), ["Learner", "Scenario", "Introduction"]);
});

test("placeholders are substituted in frame and unit bodies", () => {
  const { markdown } = run();
  assert.match(markdown, /practice session with Sam\.\nStay inside the scene "Buying fruit at the market"\./);
  assert.match(markdown, /Greet Sam in English, set the scene in one sentence,\nthen switch to Mexican Spanish/);
  assert.doesNotMatch(markdown, /\{\{(learner_name|native_language|target_language|target_variant|scenario_title)\}\}/);
});

test("an unknown placeholder is left as-is and warned about once", () => {
  const { markdown, warnings } = run({ units: ["intro-native", "warmup-odd"] });
  assert.match(markdown, /Ask about the learner's \{\{favorite_color\}\} in Spanish\./);
  assert.deepEqual(warnings, ['Unknown placeholder {{favorite_color}} in unit "warmup-odd"; left as-is.']);
});

test("a known placeholder with no value is left as-is and warned about", () => {
  const c = { ...content, profile: { ...content.profile, level: "" } };
  const { markdown, warnings } = run({ units: ["intro-target"] }, c);
  assert.match(markdown, /at level \{\{level\}\}\./);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Placeholder \{\{level\}\} in unit "intro-target" has no value/);
});

test("overrides merge over the profile; blank overrides are ignored", () => {
  const { markdown } = run({
    units: ["intro-target"],
    overrides: {
      level: "C1", target_language: "Portuguese", target_variant: "European Portuguese", goals: "", learner_name: null, interests: ["mezcal", "music"],
    },
  });
  assert.match(markdown, /- \*\*Target language:\*\* Portuguese/);
  assert.match(markdown, /- \*\*Variant:\*\* European Portuguese/);
  assert.match(markdown, /- \*\*Goals:\*\* Order food and chat with vendors\./, "blank override keeps the profile value");
  assert.match(markdown, /- \*\*Name:\*\* Sam/, "null override keeps the profile value");
  assert.match(markdown, /- \*\*Level:\*\* C1/);
  assert.match(markdown, /- \*\*Interests:\*\* mezcal, music/, "a key the profile lacks is added");
  assert.match(markdown, /Open the session in Portuguese from the first word, at level C1\./);
  assert.match(markdown, /practice session with Sam/);
});

test("a native_language override reaches the Learner block and {{native_language}}", () => {
  const { markdown, warnings } = run({ units: ["intro-native"], overrides: { native_language: "German" } });
  assert.deepEqual(warnings, []);
  assert.match(markdown, /- \*\*Native language:\*\* German/);
  assert.match(markdown, /Greet Sam in German, set the scene/);
});

test("a target_language override to another language drops the profile's variant unless the pack sets one", () => {
  const moved = run({ overrides: { target_language: "Japanese" } });
  assert.match(moved.markdown, /- \*\*Target language:\*\* Japanese/);
  assert.doesNotMatch(moved.markdown, /\*\*Variant:\*\*/, "Mexican Spanish is not a variant of Japanese");
  assert.deepEqual(moved.warnings, [], "no variant is not a problem: {{target_variant}} reads as the language");
  assert.match(moved.markdown, /then switch to Japanese for the rest of the session/);
  const own = run({ overrides: { target_language: "Japanese", target_variant: "Kansai dialect" } });
  assert.match(own.markdown, /- \*\*Variant:\*\* Kansai dialect/);
  const same = run({ overrides: { target_language: "Spanish" } });
  assert.match(same.markdown, /- \*\*Variant:\*\* Mexican Spanish/, "the profile's own target keeps its variant");
  const blank = run({ overrides: { target_variant: "" } });
  assert.match(blank.markdown, /- \*\*Variant:\*\* Mexican Spanish/, "a blank variant alone is still no override");
});

test("quick_scenario stands in for a scenario file, titled Quick scenario", () => {
  const { markdown, warnings } = run({ scenario: "", quick_scenario: "Ordering tacos at 1 a.m.\n\n" });
  assert.deepEqual(warnings, []);
  assert.ok(markdown.startsWith(`# Lingo Dojo session: ${QUICK_SCENARIO_TITLE}\n`));
  assert.ok(markdown.includes(`## Scenario\n\n### ${QUICK_SCENARIO_TITLE}\n\nOrdering tacos at 1 a.m.\n\n## Introduction`));
  assert.match(markdown, /Stay inside the scene "Quick scenario"\./);
});

test("scenario id wins over quick_scenario, with a warning", () => {
  const { markdown, warnings } = run({ quick_scenario: "Something else" });
  assert.match(markdown, /^# Lingo Dojo session: Buying fruit at the market/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /quick scenario is ignored/);
});

test("unknown scenario or none at all warns and renders a placeholder", () => {
  const unknown = run({ scenario: "nowhere" });
  assert.ok(unknown.warnings.includes('Unknown scenario "nowhere" (no content/scenarios/nowhere.md).'));
  assert.match(unknown.markdown, /## Scenario\n\n_\(No scenario selected\./);
  const none = run({ scenario: "" });
  assert.deepEqual(none.warnings, ["No scenario selected."]);
});

test("unknown, duplicate and unslotted units are skipped with warnings", () => {
  const { markdown, warnings } = run({ units: ["intro-native", "ghost", "intro-native", "orphan-unit"] });
  assert.deepEqual(warnings, [
    'Unknown unit "ghost" (no content/units/ghost.md); skipped.',
    'Unit "intro-native" is listed twice in the pack; included once.',
    'Unit "orphan-unit" is in slot "interrupts", which is not in schema.yaml; skipped.',
  ]);
  assert.equal(markdown.split("### Open in the learner's language").length, 2);
  assert.doesNotMatch(markdown, /Interrupt politely/);
});

test("scenario block: roles, beats, vocab table with escaped pipes, body", () => {
  const { markdown } = run();
  assert.ok(markdown.includes("- **You (dojo master):** Doña Rosa, the fruit vendor, quick and friendly\n- **Learner:** a visitor buying breakfast"));
  assert.ok(markdown.includes("1. Greeting at the stall\n2. Asking prices\n3. Paying and saying goodbye"));
  assert.ok(markdown.includes("| Term | Gloss |\n| --- | --- |\n| ¿Cuánto cuesta? | How much is it? |\n| kilo \\| medio | a kilo \\| a half |"));
  assert.ok(markdown.includes("**Possible twists** (use only if a Variation unit below asks for one)\n\n- The stall is out of quesillo\n- A second customer cuts in line\n\nThe market is loud and crowded."));
});

test("a scenario without twists renders no twists block", () => {
  const { markdown } = run({ scenario: "", quick_scenario: "At a bus stop." });
  assert.ok(!markdown.includes("Possible twists"));
});

test("unit bodies are verbatim apart from placeholders and trimmed trailing whitespace", () => {
  const { markdown } = run();
  assert.ok(markdown.includes("### Gentle in-line corrections\n\nWhen the learner makes an error, finish the beat, then offer a more natural\nphrasing in Spanish once and continue.\n\n## Debrief"));
});

test("notes are omitted when blank", () => {
  assert.ok(!h2(run({ notes: "  \n " }).markdown).includes("Notes from the learner"));
});

test("stats: words and ~tokens (words × 1.3)", () => {
  const { markdown, stats } = run();
  assert.equal(stats.words, markdown.split(/\s+/).filter(Boolean).length);
  assert.equal(stats.tokens, Math.round(stats.words * 1.3));
  assert.ok(stats.words > 100);
});

test("deterministic: same inputs, byte-identical output, inputs untouched", () => {
  const pack = { ...base, units: [...base.units, "warmup-odd", "ghost"], overrides: { level: "B2" }, notes: "n" };
  const snapshot = JSON.stringify([content, pack]);
  const a = assemble(content, pack);
  const b = assemble(loadContent(FIXTURE), structuredClone(pack));
  assert.equal(a.markdown, b.markdown);
  assert.deepEqual(a.warnings, b.warnings);
  assert.deepEqual(a.stats, b.stats);
  assert.equal(JSON.stringify([content, pack]), snapshot, "assemble must not mutate its inputs");
});

test("a malformed pack body never throws", () => {
  for (const bad of [null, undefined, 42, "x", [], { units: "intro-native", overrides: [1], notes: 7 }]) {
    const r = assemble(content, bad);
    assert.equal(typeof r.markdown, "string");
    assert.ok(r.warnings.includes("No scenario selected."));
  }
});

test("{{target_variant}} falls back to the target language when no variant applies", async () => {
  const { loadContent } = await import("../content.mjs");
  const { assemble } = await import("../assemble.mjs");
  const content = await loadContent();
  const out = assemble(content, { title: "t", scenario: "", quick_scenario: "x", units: [], overrides: { target_language: "Japanese" }, notes: "" });
  assert.ok(!out.markdown.includes("{{target_variant}}"), "placeholder must not leak");
  assert.ok(!out.warnings.some((w) => w.includes("target_variant")), out.warnings.join("\n"));
});

test("scenario bodies get placeholders too; an unknown one is warned about naming the scenario", () => {
  const scenarios = content.scenarios.map((s) => (s.id === "market" ? { ...s, body: "{{learner_name}} wants {{fruit}} in {{target_language}}." } : s));
  const { markdown, warnings } = run({ scenario: "market", quick_scenario: "" }, { ...content, scenarios });
  assert.match(markdown, /Sam wants \{\{fruit\}\} in Spanish\./);
  assert.ok(warnings.includes('Unknown placeholder {{fruit}} in scenario "market"; left as-is.'), warnings.join("\n"));
  const quick = run({ scenario: "", quick_scenario: "Help {{learner_name}} buy {{fruit}}." });
  assert.match(quick.markdown, /Help Sam buy \{\{fruit\}\}\./);
  assert.ok(quick.warnings.includes("Unknown placeholder {{fruit}} in the quick scenario; left as-is."), quick.warnings.join("\n"));
});

/* ------------------------------- location -------------------------------- */

function anywhereContent() {
  const root = copyFixture();
  write(root, "scenarios/anywhere.md", [
    "---",
    "id: anywhere",
    "title: Taxi across town",
    "summary: A ride.",
    "roles:",
    "  dojo_master: a driver who knows {{location}} well",
    "twists: ['Roadworks all over {{location}}']",
    "phrases: [Take me downtown, How much is it?]",
    "---",
    "{{learner_name}} hails a taxi in {{location}}.",
  ].join("\n"));
  return loadContent(root);
}

test("location set: fills {{location}} in roles, twists and body; Setting line; never in the Learner block", () => {
  const c = anywhereContent();
  const { markdown, warnings } = run({ scenario: "anywhere", overrides: { location: " Lyon " } }, c);
  assert.deepEqual(warnings, []);
  assert.match(markdown, /\*\*Setting:\*\* Lyon\. The place sets the scene/);
  assert.match(markdown, /- \*\*You \(dojo master\):\*\* a driver who knows Lyon well/);
  assert.match(markdown, /- Roadworks all over Lyon/);
  assert.match(markdown, /hails a taxi in Lyon\./);
  const learner = markdown.slice(markdown.indexOf("## Learner"), markdown.indexOf("## Scenario"));
  assert.doesNotMatch(learner, /Lyon|Location/);
});

test("location blank: the dojo master chooses, and {{location}} refers back to that choice", () => {
  const c = anywhereContent();
  const { markdown, warnings } = run({ scenario: "anywhere" }, c);
  assert.deepEqual(warnings, []);
  assert.match(markdown, /\*\*Setting:\*\* You choose the city\. Pick a real city where /);
  assert.ok(markdown.includes(`hails a taxi in ${CHOSEN_CITY}.`));
  assert.equal(run({ scenario: "anywhere" }, c).markdown, markdown, "deterministic");
});

test("phrases render as a list of meanings for the target variant", () => {
  const { markdown } = run({ scenario: "anywhere" }, anywhereContent());
  assert.match(markdown, /\*\*Phrases to work in\*\* \(English meanings; use the natural [^)]+ for each\)\n\n- Take me downtown\n- How much is it\?/);
});

test("a fixed-setting scenario ignores a leftover location", () => {
  const { markdown, warnings } = run({ overrides: { location: "Lyon" } });
  assert.deepEqual(warnings, []);
  assert.doesNotMatch(markdown, /Lyon|Setting:/);
});

test("a quick scene never takes a leftover location; {{location}} there is left as-is with a specific warning", () => {
  const { markdown, warnings } = run({ scenario: "", quick_scenario: "A cafe in {{location}}.", overrides: { location: "Lyon" } });
  assert.doesNotMatch(markdown, /Lyon|Setting:/);
  assert.match(markdown, /A cafe in \{\{location\}\}\./);
  assert.deepEqual(warnings, [
    "Placeholder {{location}} in the quick scenario is only filled when the scenario uses {{location}} (a fixed-setting or quick scenario doesn't); left as-is.",
  ]);
});

test("location comes from the pack only, never from profile.yaml", () => {
  const c = anywhereContent();
  const withProfileLocation = { ...c, profile: { ...c.profile, location: "Lyon" } };
  const { markdown } = run({ scenario: "anywhere" }, withProfileLocation);
  assert.doesNotMatch(markdown, /Lyon/);
  assert.match(markdown, /You choose the city/);
});

/* ------------------------------- time budget ------------------------------ */

/** The Time budget section's body, or undefined. */
const budgetOf = (md) => md.split("## Time budget\n\n")[1]?.split("\n\n## ")[0];

test("minutes set: a Time budget section after the slots and before the notes, with the split and how to shrink", () => {
  const { markdown, warnings } = run({ overrides: { minutes: 10 }, notes: "More numbers." });
  assert.deepEqual(warnings, []);
  assert.deepEqual(h2(markdown), ["Learner", "Scenario", "Introduction", "Warm-up", "Corrections", "Debrief", "Time budget", "Notes from the learner"]);
  const section = budgetOf(markdown);
  assert.match(section, /^The learner has \*\*10 minutes\*\* for this whole session\./);
  // The voice timeline's parts: intro, each warm-up, the scene with its
  // beats folded in, the debrief.
  assert.ok(
    section.includes(
      "- Introduction: about 1 minute\n- Warm-up: Vocabulary warm-up: about 2 minutes\n- Scene: Buying fruit at the market: about 5½ minutes, all 3 beats\n- Debrief: Top three takeaways: about 1½ minutes",
    ),
    section,
  );
  assert.match(section, /Play fewer beats[^\n]*A 5-minute session plays one or two\./);
  assert.match(section, /Keep the warm-up short/);
  assert.match(section, /Keep the debrief to one or two points\./);
  assert.match(section, /clock line/);
});

test("a short budget plays fewer beats; the split adds up to the total; output is byte-identical run to run", () => {
  const { markdown } = run({ overrides: { minutes: 5 } });
  assert.equal(run({ overrides: { minutes: 5 } }).markdown, markdown);
  const split = markdown.split("**Rough split**\n\n")[1].split("\n\n")[0];
  assert.match(split, /Scene: Buying fruit at the market: about 3 minutes, about [12] of its 3 beats/);
  const total = [...split.matchAll(/about (\d+)?(½)? minutes?/g)].reduce((s, m) => s + Number(m[1] ?? 0) + (m[2] ? 0.5 : 0), 0);
  assert.equal(total, 5);
});

test("no minutes (No limit) renders exactly what it did before: no Time budget", () => {
  const without = run().markdown;
  assert.doesNotMatch(without, /Time budget|clock line/);
  assert.equal(run({ overrides: { minutes: null } }).markdown, without);
  assert.equal(run({ overrides: { minutes: "" } }).markdown, without);
});

test("minutes never appear in the Learner block, and profile.yaml can't set a budget", () => {
  const { markdown } = run({ overrides: { minutes: 10 } }, { ...content, profile: { ...content.profile, minutes: 99 } });
  const learner = markdown.split("## Learner\n\n")[1].split("\n\n")[0];
  assert.doesNotMatch(learner, /Minutes|10|99/);
  assert.match(budgetOf(markdown), /\*\*10 minutes\*\*/);
  assert.doesNotMatch(run({}, { ...content, profile: { ...content.profile, minutes: 10 } }).markdown, /Time budget|Minutes/);
});

test("an invalid minutes value is ignored with a warning", () => {
  for (const bad of ["ten", "10", 0, -3, 100000]) {
    const { markdown, warnings } = run({ overrides: { minutes: bad } });
    assert.doesNotMatch(markdown, /Time budget/, JSON.stringify(bad));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^Pack override "minutes" must be a number of minutes above 0 and at most 240, not .+; ignored \(no time budget\)\.$/);
  }
});

test("kids mode splits its own parts and says story, not scene", () => {
  const kids = loadContent(`${FIXTURE}/kids`);
  const { markdown, warnings } = assemble(kids, { ...kids.packs[0], overrides: { minutes: 3 } }, "kids");
  assert.deepEqual(warnings, []);
  const section = budgetOf(markdown);
  assert.match(section, /^The learner has \*\*3 minutes\*\*/);
  assert.match(section, /- Introduction: about/);
  assert.match(section, /- Story: /);
});
