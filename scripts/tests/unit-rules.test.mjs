// Unit `conflicts:` / `requires:` (docs/CONTENT.md "Conflicts and
// requirements"): the pure rules, the loader's validation, assemble()'s
// warnings, and that the shipped libraries stay clean.
//   node --test scripts/tests/unit-rules.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadContent, modeRoot, loadPackFiles } from "../content.mjs";
import { assemble } from "../assemble.mjs";
import { parseRef, unitIssues, issuesByUnit } from "../../web/shared/unit-rules.ts";
import { copyFixture, write } from "./helpers.mjs";

const unit = (id, slot, over = {}) => ({ id, slot, title: id.toUpperCase(), tags: [], conflicts: [], requires: [], ...over });
const schema = { slots: [{ id: "a", title: "Slot A" }, { id: "b", title: "Slot B" }, { id: "s", title: "Scene bit", scene_only: true }] };
const lib = (...units) => ({ schema, units });

test("parseRef: unit ids, slot: and tag:, nothing else", () => {
  assert.deepEqual(parseRef("x-1"), { kind: "unit", value: "x-1" });
  assert.deepEqual(parseRef(" slot: a "), { kind: "slot", value: "a" });
  assert.deepEqual(parseRef("tag:calm"), { kind: "tag", value: "calm" });
  for (const bad of ["", "slot:", "tag: ", "Not An Id", "x y", 3, null, {}]) assert.equal(parseRef(bad), null, String(bad));
});

test("a conflict declared on one side warns both, by id, slot or tag, in pick order", () => {
  const c = lib(unit("x", "a", { conflicts: ["y"] }), unit("y", "a"), unit("z", "b", { tags: ["loud"] }), unit("w", "b", { conflicts: ["tag:loud", "slot:a"] }));
  assert.deepEqual(unitIssues(c, ["y", "x"]).conflicts.map((k) => [k.a, k.b]), [["y", "x"]]);
  assert.deepEqual(unitIssues(c, ["z", "w"]).conflicts.map((k) => [k.a, k.b]), [["z", "w"]]);
  assert.deepEqual(unitIssues(c, ["x", "w"]).conflicts.map((k) => [k.a, k.b]), [["x", "w"]], "w names slot:a, x is in it");
  const both = unitIssues(c, ["x", "y"]);
  assert.match(both.conflicts[0].message, /"X" and "Y" can contradict each other/);
  assert.deepEqual(both.messages, [both.conflicts[0].message]);
  assert.deepEqual([...issuesByUnit(both)].map(([id]) => id), ["x", "y"]);
});

test("nothing is flagged for a lone unit, a unit naming its own slot, an unpicked partner, unknown or duplicate ids", () => {
  const c = lib(unit("x", "a", { conflicts: ["slot:a", "x"] }), unit("y", "b"));
  assert.deepEqual(unitIssues(c, ["x"]).messages, []);
  assert.deepEqual(unitIssues(c, ["x", "x", "nope", "y"]).messages, []);
});

test("requires: met by a different picked unit by id or slot; message names what is missing", () => {
  const c = lib(unit("x", "a", { requires: ["y", "slot:b"] }), unit("y", "b"), unit("q", "b"));
  assert.deepEqual(unitIssues(c, ["x", "y"]).unmet, []);
  assert.deepEqual(unitIssues(c, ["x", "q"]).unmet.map((r) => r.need), ["y"]);
  const none = unitIssues(c, ["x"]);
  assert.deepEqual(none.unmet.map((r) => r.need), ["y", "slot:b"]);
  assert.equal(none.unmet[0].message, '"X" needs "Y", which is not picked.');
  assert.equal(none.unmet[1].message, '"X" needs a unit in the Slot B slot, which is not picked.');
  assert.deepEqual(unitIssues(c, ["y"]).messages, [], "an unpicked unit asks for nothing");
});

test("a drill leaves scene-only units out: they neither clash nor satisfy", () => {
  const c = lib(unit("x", "a", { conflicts: ["m"], requires: ["m"] }), unit("m", "s"));
  assert.equal(unitIssues(c, ["x", "m"]).conflicts.length, 1);
  assert.equal(unitIssues(c, ["x", "m"], { drill: true }).conflicts.length, 0);
  assert.equal(unitIssues(c, ["x", "m"], { drill: true }).unmet.length, 1);
});

test("loader: valid entries load, bad ones are warnings and skipped, a bare string is a list", () => {
  const root = copyFixture();
  write(root, "units/warmup-vocab.md", `---
id: warmup-vocab
slot: warmup
title: Vocab
summary: s
tags: [loud]
conflicts: [warmup-odd, "slot:corrections", "tag:loud", "tag:", nope-unit, "slot:nowhere", "tag:ghost", warmup-vocab, warmup-odd, {a: 1}]
requires: intro-native
---
body
`);
  write(root, "units/correct-strict.md", `---
id: correct-strict
slot: corrections
title: Strict
summary: s
requires: ["tag:loud", "slot:debrief"]
---
body
`);
  const c = loadContent(root);
  const v = c.units.find((u) => u.id === "warmup-vocab");
  assert.deepEqual(v.conflicts, ["warmup-odd", "slot:corrections", "tag:loud"]);
  assert.deepEqual(v.requires, ["intro-native"]);
  const msgs = c.problems.filter((p) => p.file.endsWith("warmup-vocab.md")).map((p) => p.message);
  for (const re of [/conflicts\[3\] "tag:" is not a unit id/, /conflicts\[9\] .* is not a unit id/, /"nope-unit" is not a unit; skipped/, /"slot:nowhere" is not a slot in schema.yaml/, /"tag:ghost" is a tag no unit has/, /"warmup-vocab" is the unit itself/]) {
    assert.ok(msgs.some((m) => re.test(m)), String(re));
  }
  assert.equal(msgs.length, 6, "the duplicate warmup-odd is dropped quietly");
  assert.ok(c.problems.every((p) => p.level === "warning" || !p.file.endsWith("warmup-vocab.md")));
  const s = c.units.find((u) => u.id === "correct-strict");
  assert.deepEqual(s.requires, ["slot:debrief"]);
  assert.ok(c.problems.some((p) => p.file.endsWith("correct-strict.md") && /requires\[0\] "tag:loud": requires takes a unit id or slot:<slot>, not tag:/.test(p.message)));
});

test("a unit with neither key loads with empty lists", () => {
  const c = loadContent(copyFixture());
  assert.deepEqual(c.units.map((u) => [u.conflicts, u.requires]).flat(2), []);
});

test("assemble(): clashes and unmet requirements are warnings; every unit still renders", () => {
  const root = copyFixture();
  write(root, "units/warmup-vocab.md", "---\nid: warmup-vocab\nslot: warmup\ntitle: Vocab\nsummary: s\nconflicts: [correct-gently]\nrequires: [debrief-top-three]\n---\nVOCABBODY\n");
  const c = loadContent(root);
  const title = (id) => c.units.find((u) => u.id === id).title;
  const pack = { title: "t", scenario: "market", units: ["intro-native", "warmup-vocab", "correct-gently"] };
  const { markdown, warnings } = assemble(c, pack);
  assert.deepEqual(warnings, [
    `"Vocab" and "${title("correct-gently")}" can contradict each other in the prompt; pick one of them.`,
    `"Vocab" needs "${title("debrief-top-three")}", which is not picked.`,
  ]);
  assert.match(markdown, /VOCABBODY/);
  assert.ok(markdown.includes(`### ${title("correct-gently")}`));
  assert.deepEqual(assemble(c, { ...pack, units: ["intro-native", "warmup-vocab", "debrief-top-three"] }).warnings, []);
});

for (const mode of ["adult", "kids"]) {
  test(`the real ${mode} library loads with no unit-reference problems, and its packs assemble with no unit warnings`, () => {
    const c = loadContent(modeRoot(mode));
    assert.deepEqual(c.problems.filter((p) => /conflicts|requires/.test(p.message)), []);
    for (const p of loadPackFiles(modeRoot(mode)).packs) {
      assert.deepEqual(assemble(c, p, mode).warnings.filter((w) => /contradict|needs /.test(w)), [], p.id);
    }
  });
}

test("the shipped declarations: the kids endings and the adult closing debriefs clash; the defaults do not", () => {
  const kids = loadContent(modeRoot("kids"));
  assert.equal(unitIssues(kids, ["ending-celebration", "ending-goodnight"]).conflicts.length, 1);
  assert.deepEqual(unitIssues(kids, ["ending-celebration"]).messages, []);
  // Bedtime against both bouncy units (by tag) and the cheerful ending; calm picks are fine.
  const clash = (ids) => unitIssues(kids, ids).conflicts.map((k) => [k.a, k.b].sort().join("+"));
  assert.deepEqual(clash(["story-bedtime", "energy-bouncy-5"]), ["energy-bouncy-5+story-bedtime"]);
  assert.deepEqual(clash(["story-bedtime", "energy-bouncy-10"]), ["energy-bouncy-10+story-bedtime"]);
  assert.deepEqual(clash(["story-bedtime", "ending-celebration"]), ["ending-celebration+story-bedtime"]);
  assert.deepEqual(clash(["story-bedtime", "energy-calm-5", "ending-goodnight"]), []);
  // A pack-level warning only: the library itself loads without a problem.
  assert.deepEqual(kids.problems.filter((p) => /conflicts|requires/.test(p.message)), []);
  const w = assemble(kids, { title: "t", units: ["story-bedtime", "energy-bouncy-5"] }, "kids").warnings;
  assert.ok(w.some((m) => /Bedtime story.*contradict/.test(m)), w.join("|"));
  const adult = loadContent(modeRoot("adult"));
  assert.equal(unitIssues(adult, ["debrief-top-three", "debrief-first-steps"]).conflicts.length, 1);
  assert.deepEqual(unitIssues(adult, ["debrief-top-three", "debrief-vocab-list"]).messages, []);
});
