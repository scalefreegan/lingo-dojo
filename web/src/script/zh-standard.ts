/* The learner's standard reading of common words CC-CEDICT reads two ways
 * (PR #67, ld-4i2; docs/VOICE.md §Uncertain readings). zh.ts applyCommon
 * writes and settles them like the common words (zh-words.ts), but over
 * the reader's own choice.
 *
 * Our own table: each row is a fact (a word's standard reading) with where
 * it was checked. "HSK 3.0 level N": the reading printed for the word in
 * the official HSK 3.0 word list (GF 0025—2021, 国际中文教育中文水平等级标准,
 * Ministry of Education of the PRC, 2021), looked up by hand, not copied:
 * the list has no stated licence, so nothing else from it is here.
 * "judgement": not in HSK 3.0 (or listed there both ways); the note says
 * why one reading is overwhelmingly the one met.
 *
 * `tw: false`: Taiwan usage differs (or keeps the full tone), so the row
 * applies to zh-CN only and a zh-TW profile keeps the reader's reading.
 * A neutral tone is written bare; "/" separates readings that are both
 * standard (the reader's stands if it gives one). Words CC-CEDICT reads
 * two ways that are not here stay marked:
 *   - 转动: HSK 3.0 lists zhuǎndòng (level 4) and zhuàndòng (level 6);
 *   - 背着, 看好, 同行, 正当: HSK 3.0 lists one reading (bèizhe, kànhǎo,
 *     tóngháng, zhèngdàng, level 6), but the other is as common in running
 *     text (背着书包 bēi, 看好孩子 kān, 与他同行 xíng, 正当…时 dāng), and the
 *     word alone can't tell them apart;
 *   - 所长: HSK 3.0 lists suǒzhǎng (level 3), but the idioms read cháng
 *     (一无所长, 各显所长, 各尽所长) and the segmenter splits them off;
 *   - not in HSK 3.0, both senses common: 不了, 分子, 教会, 明朝, 总长, 重重,
 *     朝阳, 供养, 播种, 外传, 倾倒, 散落, 调配. */

export type StandardReading = {
  word: string;
  reading: string;
  tw: boolean;
  note: string;
  /** Its traditional spelling, where a character has two (尽: 儘 and 盡). */
  trad?: string;
  /** What may follow it in a longer word the segmenter splits (好事|者). */
  notBefore?: string[];
};

export const STANDARD_READINGS: StandardReading[] = [
  { word: "好吃", reading: "hǎo chī", tw: true, note: "HSK 3.0 level 1" },
  { word: "当时", reading: "dāng shí", tw: true, note: "HSK 3.0 level 2" },
  { word: "高中", reading: "gāo zhōng", tw: true, note: "HSK 3.0 level 2" },
  { word: "好事", reading: "hǎo shì", tw: true, note: "HSK 3.0 level 2", notBefore: ["者"] },
  { word: "教学", reading: "jiào xué", tw: true, note: "HSK 3.0 level 2" },
  { word: "便宜", reading: "pián yi", tw: false, note: "HSK 3.0 level 2; Taiwan pián yí", notBefore: ["行事"] },
  { word: "重点", reading: "zhòng diǎn", tw: true, note: "HSK 3.0 level 2" },
  {
    word: "结果",
    reading: "jié guǒ",
    tw: true,
    note: "judgement: HSK 3.0 has jiéguǒ (result) at level 2 and jiē//guǒ (to bear fruit) at levels 7–9; the result sense is overwhelmingly the one met",
  },
  { word: "大夫", reading: "dài fu", tw: false, note: "HSK 3.0 level 3; Taiwan dài fū" },
  { word: "尽量", reading: "jǐn liàng", tw: false, note: "HSK 3.0 level 3; Taiwan jìn liàng", trad: "儘量" },
  { word: "恶心", reading: "ě xin", tw: false, note: "HSK 3.0 level 4; Taiwan ě xīn" },
  { word: "教授", reading: "jiào shòu", tw: true, note: "HSK 3.0 level 4" },
  { word: "大都", reading: "dà dū/dà dōu", tw: true, note: "HSK 3.0 level 5 dàdū; dà dōu is as standard (CC-CEDICT: also pr. dà dū) and Taiwan's" },
  { word: "当年", reading: "dāng nián", tw: true, note: "HSK 3.0 level 5" },
  { word: "温和", reading: "wēn hé", tw: true, note: "HSK 3.0 level 5" },
  { word: "转向", reading: "zhuǎn xiàng", tw: true, note: "HSK 3.0 level 5" },
  { word: "罢了", reading: "bà le", tw: true, note: "HSK 3.0 level 6" },
  { word: "当天", reading: "dàng tiān", tw: false, note: "HSK 3.0 level 6; Taiwan dāng tiān" },
  { word: "本色", reading: "běn sè", tw: true, note: "HSK 3.0 levels 7–9" },
  { word: "澄清", reading: "chéng qīng", tw: true, note: "HSK 3.0 levels 7–9" },
  { word: "当日", reading: "dāng rì", tw: true, note: "HSK 3.0 levels 7–9" },
  { word: "当晚", reading: "dàng wǎn", tw: false, note: "HSK 3.0 levels 7–9; Taiwan dāng wǎn" },
  { word: "倒数", reading: "dào shǔ", tw: true, note: "HSK 3.0 levels 7–9" },
  { word: "分量", reading: "fèn liàng/fèn liang", tw: true, note: "HSK 3.0 levels 7–9 (fèn·liàng: the second syllable usually neutral)" },
  { word: "空地", reading: "kòng dì", tw: true, note: "HSK 3.0 levels 7–9" },
  { word: "笼子", reading: "lóng zi", tw: true, note: "HSK 3.0 levels 7–9" },
  { word: "片子", reading: "piān zi", tw: false, note: "HSK 3.0 levels 7–9; Taiwan piàn zi" },
  { word: "疏散", reading: "shū sàn", tw: true, note: "HSK 3.0 levels 7–9" },
  { word: "下调", reading: "xià tiáo", tw: true, note: "HSK 3.0 levels 7–9" },
  { word: "饮水", reading: "yǐn shuǐ", tw: true, note: "HSK 3.0 levels 7–9" },
  { word: "琢磨", reading: "zuó mo", tw: false, note: "HSK 3.0 levels 7–9; Taiwan zhuó mó" },
  { word: "好玩", reading: "hǎo wán", tw: true, note: "judgement: not in HSK 3.0 (好玩儿); hào wán, to be playful, is rare" },
  { word: "中式", reading: "zhōng shì", tw: true, note: "judgement: not in HSK 3.0; zhòng shì, to pass the imperial exams, is historical" },
  { word: "较差", reading: "jiào chà", tw: true, note: "judgement: not in HSK 3.0; jiào chā, a range of values, is technical" },
  { word: "小儿", reading: "xiǎo ér", tw: true, note: "judgement: not in HSK 3.0; xiǎo r is colloquial erhua" },
  { word: "禁用", reading: "jìn yòng", tw: true, note: "judgement: not in HSK 3.0; jīn yòng, durable, is rare" },
  { word: "失调", reading: "shī tiáo", tw: true, note: "judgement: not in HSK 3.0; shī diào, out of tune, is rare" },
  { word: "大王", reading: "dà wáng", tw: true, note: "judgement: not in HSK 3.0; dài wang is the old stories' robber king" },
];
