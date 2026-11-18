// The light/dark switch's rules (web/src/theme.ts) and the inline script in
// web/index.html that applies the remembered choice before the first paint:
// the two must agree on the storage key and on what an unknown value means,
// or a dark page would flash light (or the wrong way) on every load.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { THEME_KEY, readChoice, resolveTheme, toggled } from "../../web/src/theme.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("a stored choice: light and dark as chosen, anything else follows the system", () => {
  assert.equal(readChoice("light"), "light");
  assert.equal(readChoice("dark"), "dark");
  assert.equal(readChoice("auto"), "auto");
  for (const junk of [null, undefined, "", "Dark", "night", 1, {}]) assert.equal(readChoice(junk), "auto", String(junk));
});

test("auto resolves to the system's scheme; an explicit choice ignores it", () => {
  assert.equal(resolveTheme("auto", true), "dark");
  assert.equal(resolveTheme("auto", false), "light");
  for (const sys of [true, false]) {
    assert.equal(resolveTheme("light", sys), "light");
    assert.equal(resolveTheme("dark", sys), "dark");
  }
});

test("the one-tap toggle always goes to the other scheme than the one showing", () => {
  assert.equal(toggled("light"), "dark");
  assert.equal(toggled("dark"), "light");
});

test("index.html's pre-paint script reads the same key, by the same rule", () => {
  const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "an inline script in <head>");
  // Run it against a fake page for each stored value and system scheme.
  for (const stored of [null, "light", "dark", "auto", "junk"]) {
    for (const sysDark of [true, false]) {
      const documentElement = { dataset: {} };
      const store = { getItem: (k) => (k === THEME_KEY ? stored : null) };
      const mm = () => ({ matches: sysDark });
      new Function("localStorage", "document", "window", "matchMedia", script)(store, { documentElement }, { matchMedia: mm }, mm);
      assert.equal(documentElement.dataset.theme, resolveTheme(readChoice(stored), sysDark), `${stored} / system ${sysDark ? "dark" : "light"}`);
    }
  }
});
