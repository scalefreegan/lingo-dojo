// Saying the settled reading (ld-0mn, docs/VOICE.md §Saying the settled
// reading): the stand-in table (web/src/script/zh-homophones.ts) checked
// against the reader as it is, and spokenText (zh-speech.ts), which swaps
// only the words a person or a checked answer settled, as whole words.
//   node --test scripts/tests/zh-speech.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { gbLevel1, big5Common, MIN_FREQ, onlyReading } from "../gen-zh-homophones.mjs";

const zh = await import("../../web/src/script/zh.ts");
const sp = await import("../../web/src/script/zh-speech.ts");
const { HOMOPHONES_CN, HOMOPHONES_TW } = await import("../../web/src/script/zh-homophones.ts");

const entries = (s) => s.split("|").map((e) => e.split("="));

test("every stand-in is a common character of its script whose one ordinary reading is its syllable, tone included (never a neutral tone)", () => {
  void MIN_FREQ;
  for (const [table, locale, common] of [[HOMOPHONES_CN, "zh-CN", gbLevel1()], [HOMOPHONES_TW, "zh-TW", big5Common()]]) {
    const list = entries(table);
    assert.ok(list.length > 400, `${locale}: ${list.length}`);
    const seen = new Set();
    for (const [reading, ch] of list) {
      assert.ok(common.has(ch), `${locale} ${ch} is common`);
      assert.equal(onlyReading(zh, ch, [locale]), reading, `${locale} ${ch} is read only ${reading}`);
      assert.notEqual(reading, reading.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC"), `${reading} carries a tone`);
      assert.ok(!seen.has(reading));
      seen.add(reading);
    }
  }
  // The ones the measurement used.
  for (const [r, ch] of [["hái", "孩"], ["huán", "环"], ["zhǎng", "掌"], ["cháng", "常"], ["dé", "德"], ["háng", "航"], ["xíng", "形"]]) assert.equal(sp.standIn(r, "zh-CN"), ch, r);
  assert.equal(sp.standIn("děi", "zh-CN"), null, "得 is the only character read děi: left to the voice");
  assert.equal(sp.standIn("zhe", "zh-CN"), null, "no neutral tone");
});

const fixes = (lists) => zh.makeCorrections(lists);

test("a word a person settled is said through stand-ins; the text shown and its readings are untouched", () => {
  const c = fixes({ mine: [{ word: "还钱", reading: "hái qián" }] });
  const text = "我明天还钱。";
  const before = zh.readCodePoints(text, "zh-CN", { cache: false, corrections: c });
  const out = sp.spokenText(text, "zh-CN", c);
  assert.equal(out.text, "我明天孩钱。");
  assert.deepEqual(out.swaps, [{ at: 3, from: "还", reading: "hái", to: "孩" }]);
  assert.equal(text, "我明天还钱。");
  assert.deepEqual(zh.readCodePoints(text, "zh-CN", { cache: false, corrections: c }), before);
});

test("only settled kinds are swapped: mine, shared, checked; a recap's suggestion and the reader's own guess never", () => {
  const w = [{ word: "长着", reading: "zhǎng zhe" }];
  const text = "小狗长着大耳朵。";
  for (const kind of ["mine", "shared", "checked"]) assert.equal(sp.spokenText(text, "zh-CN", fixes({ [kind]: w })).text, "小狗掌着大耳朵。", kind);
  assert.equal(sp.spokenText(text, "zh-CN", fixes({ suggested: w })).text, text, "a suggestion still waiting for a person");
  assert.equal(sp.spokenText(text, "zh-CN", null).text, text);
  assert.equal(sp.spokenText(text, "zh-CN", fixes({})).text, text, "the reader's own reading (cháng) is never forced on the voice");
  // A voice said 你得去 děi on its own where the prior reads dé: nothing
  // unsettled is touched, and děi has no stand-in anyway.
  assert.equal(sp.spokenText("你得去。", "zh-CN", fixes({ mine: [{ word: "得去", reading: "děi qù" }] })).text, "你得去。");
});

test("whole words only: never inside a longer word, and a character the voice can't misread is left as written", () => {
  const c = fixes({ mine: [{ word: "还书", reading: "huán shū" }] });
  assert.equal(sp.spokenText("我去还书。", "zh-CN", c).text, "我去环书。");
  assert.equal(sp.spokenText("他还书包里放了笔。", "zh-CN", c).text, "他还书包里放了笔。", "书包 is a word: no 还书 here");
  // 同 tóng is its usual reading and the reader's: only 行 is swapped.
  const t = sp.spokenText("我们一起同行。", "zh-CN", fixes({ shared: [{ word: "同行", reading: "tóng háng" }] }));
  assert.equal(t.text, "我们一起同航。");
  assert.deepEqual(t.swaps.map((s) => s.from), ["行"]);
});

test("a zh-TW text takes the traditional table", () => {
  const c = fixes({ mine: [{ word: "還錢", reading: "hái qián" }] });
  assert.equal(sp.spokenText("我明天還錢。", "zh-TW", c).text, "我明天孩錢。");
});
