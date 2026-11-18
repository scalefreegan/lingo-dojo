// The character card's sounds (web/src/script/sounds.ts, zh.ts exemplars):
// every zhuyin and tone exemplar is read the way the table says, by
// pinyin-pro, in both scripts; a reading splits into its tappable parts;
// and the exemplar index finds a character read only a given way.
//   node --test scripts/tests/sounds.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pinyinToZhuyin } from "../../web/src/script/script.ts";
import { TONE_SOUNDS, ZHUYIN_SOUNDS, buildExemplarIndex, commonChars, syllableParts, untoned, zhuyinSound } from "../../web/src/script/sounds.ts";
import { charReadings, exemplars, inScript, readCodePoints } from "../../web/src/script/zh.ts";

const LOCALES = ["zh-TW", "zh-CN"];
const sounds = (ch, locale) => charReadings(ch, locale).map((r) => untoned(pinyinToZhuyin(r) ?? "?"));

test("the zhuyin chart: all 37 symbols, once each, 21 initials, 3 medials, 13 finals", () => {
  assert.equal(ZHUYIN_SOUNDS.length, 37);
  assert.equal(new Set(ZHUYIN_SOUNDS.map((s) => s.symbol)).size, 37);
  const count = (g) => ZHUYIN_SOUNDS.filter((s) => s.group === g).length;
  assert.deepEqual([count("initial"), count("medial"), count("final")], [21, 3, 13]);
  // Every symbol of the Bopomofo block a Mandarin syllable uses (ㄅ U+3105 … ㄩ U+3129).
  for (let cp = 0x3105; cp <= 0x3129; cp++) assert.ok(zhuyinSound(String.fromCodePoint(cp)), String.fromCodePoint(cp));
});

test("each symbol's exemplar sounds like it: every reading is its sound, tone aside, in both scripts (佛 the one exception)", () => {
  for (const s of ZHUYIN_SOUNDS) {
    assert.ok(s.sound.includes(s.symbol), `${s.symbol}: its sound has it`);
    for (const locale of LOCALES) {
      const ch = inScript(s.char, locale);
      assert.equal([...ch].length, 1, `${s.symbol} ${ch}`);
      const heard = sounds(ch, locale);
      assert.ok(heard.length > 0, `${s.symbol} ${ch} ${locale}: read at all`);
      if (s.symbol === "ㄈ") {
        // No character is read only fo; 佛's usual reading (what a voice says alone) is fó.
        assert.equal(charReadings(ch, locale)[0], "fó");
        continue;
      }
      assert.ok(heard.every((z) => z === s.sound), `${s.symbol} ${ch} ${locale}: ${charReadings(ch, locale).join(", ")}`);
    }
  }
});

test("the tones: 媽 麻 馬 罵 read only that way, and 媽媽's second syllable is the neutral tone", () => {
  for (const t of TONE_SOUNDS) {
    for (const locale of LOCALES) {
      const text = inScript(t.text, locale);
      if (t.tone === 5) {
        assert.deepEqual(readCodePoints(text, locale), ["mā", "ma"], locale);
        continue;
      }
      assert.deepEqual(charReadings(text, locale), [t.pinyin], `${t.text} ${locale}`);
    }
  }
  assert.deepEqual(TONE_SOUNDS.map((t) => t.tone), [1, 2, 3, 4, 5]);
});

test("every sound the card can send fits /api/voice/sound: 1 to 4 Han characters", () => {
  const han = /^\p{Script=Han}{1,4}$/u;
  for (const locale of LOCALES) {
    for (const s of ZHUYIN_SOUNDS) assert.match(inScript(s.char, locale), han);
    for (const t of TONE_SOUNDS) assert.match(inScript(t.text, locale), han);
  }
});

test("syllableParts: the initial, the final as written, the zhuyin symbols and the tone", () => {
  assert.deepEqual(syllableParts("háng"), { zhuyin: "ㄏㄤˊ", symbols: ["ㄏ", "ㄤ"], tone: 2, initial: { pinyin: "h", zhuyin: "ㄏ" }, final: { pinyin: "áng", zhuyin: "ㄤ" } });
  assert.deepEqual(syllableParts("zhuàng"), { zhuyin: "ㄓㄨㄤˋ", symbols: ["ㄓ", "ㄨ", "ㄤ"], tone: 4, initial: { pinyin: "zh", zhuyin: "ㄓ" }, final: { pinyin: "uàng", zhuyin: "ㄨㄤ" } });
  // y and w are spelling: the whole syllable is the final.
  assert.deepEqual(syllableParts("yī")?.initial, null);
  assert.deepEqual(syllableParts("yī")?.final, { pinyin: "yī", zhuyin: "ㄧ" });
  assert.equal(syllableParts("wǒ")?.final.zhuyin, "ㄨㄛ");
  // zhi … si: the i is no sound of its own.
  assert.deepEqual(syllableParts("shì")?.final, { pinyin: "ì", zhuyin: "" });
  // The neutral tone, its dot printed first.
  const de = syllableParts("de");
  assert.deepEqual([de?.zhuyin, de?.tone, de?.symbols], ["˙ㄉㄜ", 5, ["ㄉ", "ㄜ"]]);
  assert.equal(syllableParts("mā")?.tone, 1);
  assert.equal(syllableParts("lǜ")?.final.zhuyin, "ㄩ");
  assert.equal(syllableParts("not a syllable"), null);
});

test("buildExemplarIndex: a character read only that way; the first found wins; a sound takes a one-reading character first", () => {
  const readings = { 行: ["xíng", "háng"], 杭: ["háng"], 航: ["háng"], 啊: ["a", "ā"], 阿: ["ā", "ē"], 吖: ["ā"] };
  const index = buildExemplarIndex(Object.keys(readings), (ch) => readings[ch] ?? []);
  assert.equal(index.exact("háng"), "杭");
  assert.equal(index.exact("xíng"), null, "行 has another reading");
  assert.equal(index.exact("ā"), "吖");
  assert.equal(index.sound("ㄚ"), "吖", "the one-reading character before 啊, whose readings are all ㄚ too");
  assert.equal(index.sound("ㄏㄤ"), "杭");
  assert.equal(index.sound("ㄒㄧㄥ"), null);
});

test("the common characters come from the runtime's own decoders: Big5's 5,401 and GB 2312's 3,755", () => {
  const tw = commonChars(true);
  const cn = commonChars(false);
  assert.equal(tw.length, 5401);
  assert.equal(cn.length, 3755);
  assert.ok(tw.includes("媽") && cn.includes("妈"));
});

test("exemplars: a polyphonic character's other reading is voiced by a common character read only that way", () => {
  for (const locale of LOCALES) {
    const ex = exemplars(locale);
    const [, hang] = charReadings("行", locale);
    assert.equal(hang, "háng");
    const ch = ex.exact(hang);
    assert.ok(ch, locale);
    assert.notEqual(ch, "行");
    assert.deepEqual(charReadings(ch, locale), ["háng"], `${ch} ${locale}`);
    // A final with a medial (no single zhuyin symbol): its zero-initial syllable.
    const yang = ex.sound("ㄧㄤ");
    assert.ok(yang && sounds(yang, locale).every((z) => z === "ㄧㄤ"), `${yang} ${locale}`);
  }
  // In the learner's script.
  assert.equal(exemplars("zh-TW").exact("mā"), "媽");
  assert.equal(exemplars("zh-CN").exact("mā"), "妈");
});
