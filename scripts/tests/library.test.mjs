// The real libraries, both modes: content/ and content/kids/ as shipped in
// git must be internally consistent — every unit in a schema slot, every
// pack pointing at things that exist, one default per required pick:one
// slot, and a fresh pack assembling without a warning. The other tests work
// on fixtures; this one is the guard on what is actually committed. No unit
// or scenario id is named here, so adding content never breaks it.
//   node --test scripts/tests/library.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { MODES, loadContent, loadPackFiles, modeRoot } from "../content.mjs";
import { assemble } from "../assemble.mjs";

for (const mode of MODES) {
  test(`${mode}: the shipped library loads clean and its default pack assembles without warnings`, () => {
    const c = loadContent(modeRoot(mode));
    const errors = c.problems.filter((p) => p.level === "error");
    assert.deepEqual(errors, [], "no file fails to load");
    const slotIds = new Set(c.schema.slots.map((s) => s.id));
    assert.ok(c.schema.slots.length > 0, "schema has slots");
    assert.ok(c.units.length > 0, "has units");
    assert.ok(c.scenarios.length > 0, "has scenarios");
    assert.ok(c.frame.length > 0, "has a frame");

    for (const u of c.units) {
      assert.ok(slotIds.has(u.slot), `unit ${u.id} is in slot "${u.slot}", which the ${mode} schema does not have`);
      assert.ok(u.summary && u.body.trim(), `unit ${u.id} has a summary and a body`);
    }
    // The loader reports a unit in no slot as a warning; none expected here.
    assert.deepEqual(c.problems.filter((p) => /not in schema/.test(p.message)), []);

    for (const slot of c.schema.slots) {
      const defaults = c.units.filter((u) => u.slot === slot.id && u.default);
      if (slot.required && slot.pick === "one") {
        assert.equal(defaults.length, 1, `required pick:one slot "${slot.id}" needs exactly one default unit, has ${defaults.map((u) => u.id).join(", ") || "none"}`);
      } else if (slot.pick === "one") {
        assert.ok(defaults.length <= 1, `pick:one slot "${slot.id}" has more than one default`);
      }
    }

    const unitIds = new Set(c.units.map((u) => u.id));
    const scenarioIds = new Set(c.scenarios.map((s) => s.id));
    for (const p of loadPackFiles(modeRoot(mode)).packs) {
      if (p.scenario) assert.ok(scenarioIds.has(p.scenario), `pack ${p.id} names scenario "${p.scenario}", which ${mode} does not have`);
      for (const id of p.units) assert.ok(unitIds.has(id), `pack ${p.id} names unit "${id}", which ${mode} does not have`);
      const { warnings } = assemble(c, p, mode);
      assert.deepEqual(warnings, [], `pack ${p.id} assembles with warnings`);
    }

    // A fresh pack: the defaults, first scenario. What "New pack" gives.
    const units = [];
    for (const slot of c.schema.slots) {
      const defaults = c.units.filter((u) => u.slot === slot.id && u.default).map((u) => u.id);
      units.push(...(slot.pick === "one" ? defaults.slice(0, 1) : defaults));
    }
    const fresh = { title: "fresh", created: "", scenario: c.scenarios[0].id, quick_scenario: "", units, overrides: {}, notes: "" };
    const { warnings, markdown } = assemble(c, fresh, mode);
    assert.deepEqual(warnings, [], "the default pack assembles clean");
    assert.ok(!/\{\{\s*\w+\s*\}\}/.test(markdown), "no placeholder leaks into the prompt");

    // First steps drills (docs/CONTENT.md "Drills"): the library has its
    // drill frame, every drill has rounds and words, and the defaults
    // assemble around each one without a warning (the scene-only slots go
    // quietly) under frame-drill.md.
    const drills = c.scenarios.filter((s) => s.format === "drill");
    assert.ok(drills.length > 0, "has First steps drills");
    assert.ok(c.frameDrill.length > 0, "has frame-drill.md");
    assert.deepEqual(c.problems.filter((p) => p.level === "warning" && /scenarios\/|frame-drill|schema/.test(p.file)), [], "scenarios, the schema and the drill frame load without warnings");
    for (const d of drills) {
      assert.ok(d.beats.length >= 3 && d.beats.length <= 5, `drill ${d.id} has 3–5 rounds`);
      assert.ok(d.phrases.length + d.vocab.length >= 10, `drill ${d.id} has at least 10 words to drill`);
      const r = assemble(c, { ...fresh, scenario: d.id, overrides: { minutes: 10 } }, mode);
      assert.deepEqual(r.warnings, [], `drill ${d.id} assembles with the defaults without warnings`);
      assert.ok(r.markdown.includes("## The drill"), `drill ${d.id} renders as a drill`);
      assert.ok(!/\{\{\s*\w+\s*\}\}/.test(r.markdown), `no placeholder leaks into drill ${d.id}`);
    }
  });
}
