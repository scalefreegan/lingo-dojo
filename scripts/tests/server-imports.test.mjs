// The server takes the page's Mandarin reader from web/src
// (web/server/pronunciation.ts imports web/src/script/zh.ts, which brings
// script.ts, sounds.ts, pinyin-pro and the JSON tables). That chain was
// written for the browser; this loads it under plain node, with no browser
// globals, so a top-level `window`, `document` or `localStorage` added to
// any of those modules fails here rather than at the dev server's start.
//   node --test scripts/tests/server-imports.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

test("the pronunciation route's module chain loads under plain node", async () => {
  for (const g of ["window", "document", "localStorage"]) assert.equal(typeof globalThis[g], "undefined", `no ${g} under node`);
  const route = await import("../../web/server/pronunciation.ts");
  assert.equal(typeof route.handlePronunciation, "function");
  const zh = await import("../../web/src/script/zh.ts");
  assert.deepEqual(zh.readCodePoints("你好！", "zh-CN", { cache: false }), ["nǐ", "hǎo", null]);
  assert.deepEqual(zh.charReadings("长", "zh-CN"), ["cháng", "zhǎng"]);
});
