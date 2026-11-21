// Which takes the tone check scores, and so which speak-it takes record raw
// (web/shared/tone-text.ts; ld-lvk). node --test scripts/tests/tone-text.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { scorableText, scoresTonesHere, speakItProcessing } from "../../web/shared/tone-text.ts";
import { readScoreText } from "../pronunciation-app.mjs";

test("speak-it records raw ('pitch') only for a Mandarin phrase the tone check will score", () => {
  assert.equal(speakItProcessing("zh-CN", "你好"), "pitch");
  assert.equal(speakItProcessing("zh-Hant-TW", "我們走吧！"), "pitch");
  // Mandarin, but the check would refuse it: only the words matter.
  assert.equal(speakItProcessing("zh-CN", "我有一个iPhone"), "conversation", "mixed with Latin letters");
  assert.equal(speakItProcessing("zh-CN", "这".repeat(25)), "conversation", "over 24 characters");
  assert.equal(speakItProcessing("zh-CN", ""), "conversation");
  // Not a tone language the server scores.
  assert.equal(speakItProcessing("es-ES", "hola"), "conversation");
  assert.equal(speakItProcessing("yue-HK", "你好"), "conversation");
  assert.equal(speakItProcessing(null, "你好"), "conversation");
});

test("scorableText agrees with the route's own rule on the edges", () => {
  for (const text of ["你好", "你好，世界！", "这".repeat(24), "这".repeat(25), "我有一个iPhone", "abc", "", "  ", "你 好"]) {
    assert.equal(scorableText(text), !readScoreText(text).error, JSON.stringify(text));
  }
  assert.ok(scoresTonesHere("cmn-Hans-CN"));
  assert.ok(!scoresTonesHere("ja-JP"));
});
