/* Script helpers by locale: which target languages get a reading aid over
 * their text (pinyin or zhuyin over Chinese characters today), what the
 * learner's choice is stored under, how mixed text splits into characters
 * and the rest, and pinyin → zhuyin. Pure and erasable TypeScript, so
 * `node --test` covers it as is (scripts/tests/script.test.mjs).
 *
 * Only Mandarin is built. Japanese (furigana over kanji) or Korean
 * (romanised hangul) would each be one more entry in SCRIPTS with its own
 * modes and its own lazily loaded reader beside zh.ts; nothing else here
 * assumes Chinese. */

/** What sits over the characters: nothing, pinyin with tone marks, or
 *  zhuyin (bopomofo, what Taiwanese learners read). */
export type RubyMode = "off" | "pinyin" | "zhuyin";

export interface ScriptSupport {
  /** Which reader draws it (zh.ts for "zh"). */
  id: "zh";
  /** The choices offered, in order, with "off" first. */
  modes: readonly { mode: RubyMode; label: string }[];
  /** A profile that never chose: the usual aid for the language. */
  defaultMode: RubyMode;
}

const MANDARIN: ScriptSupport = {
  id: "zh",
  modes: [
    { mode: "off", label: "Off" },
    { mode: "pinyin", label: "Pinyin" },
    { mode: "zhuyin", label: "Zhuyin" },
  ],
  defaultMode: "pinyin",
};

/** The reading aid for a target locale, or null where there is none (a
 *  Spanish session, a native-language line). Mandarin is zh / cmn in any
 *  script or region except Hong Kong and Macau, whose zh-HK / zh-MO the
 *  app uses for Cantonese (scripts/voice.mjs localeFor): pinyin there
 *  would teach the wrong language. yue is Cantonese too. */
export function scriptFor(locale: string | null | undefined): ScriptSupport | null {
  if (!locale) return null;
  const parts = locale.trim().replace(/_/g, "-").split("-");
  const lang = parts[0].toLowerCase();
  if (lang === "cmn") return MANDARIN;
  if (lang !== "zh") return null;
  const region = parts.slice(1).find((p) => /^[A-Za-z]{2}$/.test(p))?.toUpperCase();
  if (region === "HK" || region === "MO") return null;
  return MANDARIN;
}

/** Whether `locale` is Taiwan's Mandarin, whose standard readings differ
 *  from the mainland's for a few characters (TAIWAN_READINGS). */
export function isTaiwan(locale: string | null | undefined): boolean {
  if (!locale) return false;
  const parts = locale.replace(/_/g, "-").split("-").map((p) => p.toUpperCase());
  return parts.includes("TW") || (parts.includes("HANT") && !parts.includes("HK") && !parts.includes("MO"));
}

/** The mode to show for `locale` given what was stored: the stored choice
 *  when it is one this script offers, else its default; "off" where the
 *  locale has no reading aid at all. */
export function resolveMode(stored: string | null | undefined, locale: string | null | undefined): RubyMode {
  const s = scriptFor(locale);
  if (!s) return "off";
  return s.modes.some((m) => m.mode === stored) ? (stored as RubyMode) : s.defaultMode;
}

/** Where the stroke data's licence text is served (server/hanzi.ts
 *  ARPHIC_LICENSE_PATH; a test checks they agree). */
export const ARPHIC_LICENSE_URL = "/hanzi-data/ARPHICPL.txt";

/* ------------------------------- characters ------------------------------ */

const HAN = /\p{Script=Han}/u;
/** One Chinese character (a code point, so a rare one beyond the BMP
 *  counts as one). 〇 and the iteration mark 々 are Han too. */
export const isHan = (ch: string) => HAN.test(ch) && [...ch].length === 1;

export interface Piece {
  text: string;
  /** Where it starts in the string (UTF-16 offset, as String.slice counts). */
  at: number;
  han: boolean;
}

/** `text` cut into single Chinese characters and runs of anything else
 *  (Latin, digits, punctuation, spaces), in order, with their offsets. */
export function splitHan(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const ch of text) {
    if (isHan(ch)) out.push({ text: ch, at, han: true });
    else if (out.length && !out[out.length - 1].han) out[out.length - 1].text += ch;
    else out.push({ text: ch, at, han: false });
    at += ch.length;
  }
  return out;
}

/** Parts of one sentence (the words before a marked phrase, the phrase,
 *  the rest), each with its readings (UTF-16 offsets within the part), or
 *  null for all when `read` is null (no readings shown). `read` runs once,
 *  over the whole sentence: read apart, a character beside the phrase
 *  loses its word (了 after 天黑 is le in 天黑了, liǎo alone; 得 after 跑 is
 *  de, not dé). Ruby.tsx MarkedText draws what this returns. */
export function readMarked(
  parts: string[],
  read: ((text: string) => (string | null)[]) | null,
): { text: string; readings: (string | null)[] | null }[] {
  const text = parts.join("");
  const all = read ? read(text) : null;
  let at = 0;
  return parts.map((p) => {
    const out = { text: p, readings: all ? all.slice(at, at + p.length) : null };
    at += p.length;
    return out;
  });
}

/** A phrase's stored reading as the hint the reader lays over it (zh.ts
 *  ReadingHint), or undefined when there is none. */
export const hintFor = (term: string | null | undefined, reading: string | null | undefined): { term: string; reading: string }[] | undefined =>
  term && reading ? [{ term, reading }] : undefined;

/** The distinct Chinese characters in `text`, in first-seen order. */
export function hanChars(text: string): string[] {
  const seen: string[] = [];
  for (const ch of text) if (isHan(ch) && !seen.includes(ch)) seen.push(ch);
  return seen;
}

/* ----------------------------- Taiwan readings ---------------------------- */

/** Taiwan's standard readings (the Ministry of Education's dictionary)
 *  where they differ from the mainland's, for common characters. Applied
 *  to a zh-TW text only where the reader gave the mainland's usual reading
 *  (`from`), so a reading picked from context is left alone. */
export const TAIWAN_READINGS: Record<string, { from: string; to: string }> = {
  期: { from: "qī", to: "qí" },
  危: { from: "wēi", to: "wéi" },
  微: { from: "wēi", to: "wéi" },
  究: { from: "jiū", to: "jiù" },
  企: { from: "qǐ", to: "qì" },
  綜: { from: "zōng", to: "zòng" },
  综: { from: "zōng", to: "zòng" },
  擁: { from: "yōng", to: "yǒng" },
  拥: { from: "yōng", to: "yǒng" },
  暫: { from: "zàn", to: "zhàn" },
  暂: { from: "zàn", to: "zhàn" },
  誰: { from: "shuí", to: "shéi" },
  谁: { from: "shuí", to: "shéi" },
  髮: { from: "fa", to: "fǎ" },
  質: { from: "zhì", to: "zhí" },
  质: { from: "zhì", to: "zhí" },
  息: { from: "xī", to: "xí" },
  液: { from: "yè", to: "yì" },
};
/** Whole words whose Taiwan reading differs as a word. */
export const TAIWAN_WORDS: Record<string, string[]> = {
  垃圾: ["lè", "sè"],
};

/** Taiwan's readings over `readings` (one per code point of `text`, null
 *  for a non-character), in place, and returned. */
export function taiwanize(text: string, readings: (string | null)[]): (string | null)[] {
  const cps = [...text];
  for (let i = 0; i < cps.length; i++) {
    const r = readings[i];
    if (r == null) continue;
    const word = Object.entries(TAIWAN_WORDS).find(([w]) => cps.slice(i, i + [...w].length).join("") === w);
    if (word) {
      word[1].forEach((p, k) => (readings[i + k] = p));
      i += word[1].length - 1;
      continue;
    }
    const t = TAIWAN_READINGS[cps[i]];
    // 髮 and its like come back as fà or, in 頭髮, the neutral fa: either way the mainland's.
    if (t && (r === t.from || (cps[i] === "髮" && (r === "fà" || r === "fa")))) readings[i] = t.to;
  }
  return readings;
}

/** The particles the word dictionary misreads (it reads every 地 dì, every
 *  得 dé and every 儿 ér), fixed by their neighbours, over `readings` in
 *  place. Deliberately narrow: a wrong reading teaches a wrong sound, so
 *  each rule fires only on listed words and anything else keeps the
 *  library's reading.
 *  - the adverbial 地 (慢慢地走, 開心地笑) is de, not dì (ground), after one
 *    of the listed adverbs and adjectives, or an AABB double (高高興興地),
 *    and never where 地 starts the next word (看看地圖, 安靜地方);
 *  - the complement 得 (跑得很快, 說得太快) is de, not dé (get) or děi
 *    (must), only after a listed verb or adjective and before a degree
 *    word: never after a pronoun (我得很早起 děi, 他得滿分 dé) or before
 *    到 / 不到 (他得不到);
 *  - 長 / 长 before 得 is zhǎng (grow: 長得像媽媽), not cháng (long);
 *  - 儿 / 兒 closing a listed erhua word (這兒, 一點兒, 小孩兒) is the r
 *    of erhua, not the syllable ér, which stays in 兒子, 女兒, 兒童. */
const DE_ADVERBS = [
  "慢慢", "好好", "輕輕", "轻轻", "靜靜", "静静", "悄悄", "偷偷", "漸漸", "渐渐", "默默", "緊緊", "紧紧", "遠遠", "远远",
  "早早", "狠狠", "深深", "乖乖", "穩穩", "稳稳", "牢牢", "暗暗", "匆匆", "微微", "快快", "大大",
  "高興", "高兴", "開心", "开心", "快樂", "快乐", "大聲", "大声", "小聲", "小声", "認真", "认真", "小心", "努力", "安靜", "安静", "不停", "耐心", "仔細", "仔细",
];
// What 地 begins as a word: 地圖 map, 地址 address, 地鐵 subway, 地方 place, 地上, 地點, 地下, 地區, 地球, …
const DI_WORD_NEXT = "圖图址鐵铁方上點点下區区球板毯面震理位主道帶带盤盘基獄狱步段價价勢势形域";
// Verbs and adjectives a degree complement follows (跑得很快, 累得不行).
const DE_HEADS = "跑說说唱寫写做吃睡走來来玩學学講讲洗打看聽听畫画跳飛飞笑哭開开幹干弄搞變变過过活住穿辦办賣卖買买演彈弹踢游遊考念讀读累忙熱热冷餓饿急氣气病醉跳洗修";
const DEGREE = "很太真好非挺多更越不最蠻蛮特有這这那";
const PRONOUN = "我你他她它您們们倆俩咱";
const ERHUA_PREV = "這这那哪點点會会玩塊块事味空畫画字門门份片邊边頭头勁劲準准個个圈伴";
const ER_WORD_NEXT = "子童歌科女媳時时孫孙戲戏";
export function particleDe(text: string, readings: (string | null)[]): (string | null)[] {
  const cps = [...text];
  for (let i = 1; i < cps.length; i++) {
    const prev = cps[i - 1];
    const next = cps[i + 1] ?? "\0";
    if (cps[i] === "地" && readings[i] === "dì" && !DI_WORD_NEXT.includes(next)) {
      const before = cps.slice(0, i).join("");
      const aabb = i >= 4 && cps[i - 4] === cps[i - 3] && cps[i - 2] === cps[i - 1] && cps[i - 3] !== cps[i - 2] && isHan(cps[i - 1]);
      if (aabb || DE_ADVERBS.some((w) => before.endsWith(w))) readings[i] = "de";
    } else if (cps[i] === "得" && (prev === "長" || prev === "长") && readings[i - 1] === "cháng" && next !== "到") {
      readings[i - 1] = "zhǎng";
      readings[i] = "de";
    } else if (
      cps[i] === "得" &&
      readings[i] === "dé" &&
      // A pronoun before 得 makes it the verb (我得走 děi, 他得到 dé); DE_HEADS
      // has none, and this says so should the list grow.
      !PRONOUN.includes(prev) &&
      DE_HEADS.includes(prev) &&
      DEGREE.includes(next) &&
      !(next === "不" && "到了".includes(cps[i + 2] ?? "\0"))
    ) {
      readings[i] = "de";
    } else if ((cps[i] === "儿" || cps[i] === "兒") && (readings[i] === "ér" || readings[i] === "er") && !ER_WORD_NEXT.includes(next)) {
      const smallChild = (prev === "孩") && (cps[i - 2] === "小");
      if (ERHUA_PREV.includes(prev) || smallChild) readings[i] = "r";
    }
  }
  return readings;
}

/** A tone-marked pinyin syllable (or the r of erhua), so a character the
 *  library has no reading for shows none rather than itself. */
export const isPinyin = (s: string | null | undefined): s is string => !!s && /^[a-zêüāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿếề]+$/.test(s.normalize("NFC"));

/* --------------------------------- zhuyin --------------------------------- */

const TONE_MARKS: Record<string, [string, number]> = {};
for (const [base, marks] of [
  ["a", "āáǎà"],
  ["e", "ēéěè"],
  ["i", "īíǐì"],
  ["o", "ōóǒò"],
  ["u", "ūúǔù"],
  ["ü", "ǖǘǚǜ"],
  ["n", "ńňǹ"],
] as const) {
  [...marks].forEach((m, k) => (TONE_MARKS[m] = [base, base === "n" ? [2, 3, 4][k] : k + 1]));
}
// The precomposed ones the interjections use (ḿ, ế, ề); the rest are
// combining marks, which lose their tone below.
TONE_MARKS["ḿ"] = ["m", 2];
TONE_MARKS["ế"] = ["ê", 2];
TONE_MARKS["ề"] = ["ê", 4];

const INITIALS: [string, string][] = [
  ["zh", "ㄓ"], ["ch", "ㄔ"], ["sh", "ㄕ"], ["b", "ㄅ"], ["p", "ㄆ"], ["m", "ㄇ"], ["f", "ㄈ"], ["d", "ㄉ"], ["t", "ㄊ"], ["n", "ㄋ"], ["l", "ㄌ"],
  ["g", "ㄍ"], ["k", "ㄎ"], ["h", "ㄏ"], ["j", "ㄐ"], ["q", "ㄑ"], ["x", "ㄒ"], ["r", "ㄖ"], ["z", "ㄗ"], ["c", "ㄘ"], ["s", "ㄙ"],
];
const FINALS: Record<string, string> = {
  a: "ㄚ", o: "ㄛ", e: "ㄜ", ê: "ㄝ", ai: "ㄞ", ei: "ㄟ", ao: "ㄠ", ou: "ㄡ", an: "ㄢ", en: "ㄣ", ang: "ㄤ", eng: "ㄥ", er: "ㄦ", ong: "ㄨㄥ",
  i: "ㄧ", ia: "ㄧㄚ", io: "ㄧㄛ", ie: "ㄧㄝ", iai: "ㄧㄞ", iao: "ㄧㄠ", iou: "ㄧㄡ", ian: "ㄧㄢ", in: "ㄧㄣ", iang: "ㄧㄤ", ing: "ㄧㄥ", iong: "ㄩㄥ",
  u: "ㄨ", ua: "ㄨㄚ", uo: "ㄨㄛ", uai: "ㄨㄞ", uei: "ㄨㄟ", uan: "ㄨㄢ", uen: "ㄨㄣ", uang: "ㄨㄤ", ueng: "ㄨㄥ",
  ü: "ㄩ", üe: "ㄩㄝ", üan: "ㄩㄢ", ün: "ㄩㄣ",
};
// y- and w- spell a syllable with no initial; these undo the spelling.
const ZERO_INITIAL: [RegExp, string][] = [
  [/^yu/, "ü"], [/^yi/, "i"], [/^y/, "i"], [/^wu/, "u"], [/^w/, "u"],
];
const TONE_SIGN = ["", "", "ˊ", "ˇ", "ˋ"];

/** One pinyin syllable with tone marks (nǐ, lǜ, zhuàng, de) in zhuyin
 *  (ㄋㄧˇ, ㄌㄩˋ, ㄓㄨㄤˋ, ˙ㄉㄜ), or null when it isn't one. The first
 *  tone is unmarked and the neutral tone's dot goes first, as printed. */
export function pinyinToZhuyin(syllable: string): string | null {
  let tone = 5;
  let base = "";
  for (const ch of syllable.normalize("NFC").toLowerCase()) {
    const m = TONE_MARKS[ch];
    if (m) {
      base += m[0];
      tone = m[1];
    } else base += ch === "v" ? "ü" : ch;
  }
  base = base.replace(/̄|́|̌|̀/g, "");
  if (!/^[a-zêü]+$/.test(base)) return null;
  // The r of erhua (這兒 zhè r) is ㄦ with no tone of its own; the nasal
  // interjections (嗯 ńg, 呣 ḿ, 哼 hng) are spelt as the MOE dictionary does.
  if (base === "r") return "ㄦ";
  const nasal: Record<string, string> = { m: "ㄇ", n: "ㄣ", ng: "ㄫ", hm: "ㄏㄇ", hng: "ㄏㄫ" };
  if (nasal[base]) return tone === 5 ? `˙${nasal[base]}` : nasal[base] + TONE_SIGN[tone];
  let initial = "";
  let rest = base;
  for (const [py, zy] of INITIALS) {
    if (base.startsWith(py) && base.length > py.length) {
      initial = zy;
      rest = base.slice(py.length);
      break;
    }
  }
  let final: string | undefined;
  if (!initial) {
    // yu → ü, yi → i, ya → ia, you → iou, wu → u, wei → uei, wen → uen.
    const zero = ZERO_INITIAL.find(([re]) => re.test(rest));
    if (zero) rest = rest.replace(zero[0], zero[1]);
    final = FINALS[rest];
  } else if ("ㄓㄔㄕㄖㄗㄘㄙ".includes(initial) && rest === "i") {
    // zhi chi shi ri zi ci si: the initial alone.
    final = "";
  } else {
    if ("ㄐㄑㄒ".includes(initial) && rest.startsWith("u")) rest = "ü" + rest.slice(1);
    if (rest === "ui") rest = "uei";
    else if (rest === "iu") rest = "iou";
    else if (rest === "un") rest = "uen";
    else if ("ㄋㄌ".includes(initial) && rest === "ue") rest = "üe";
    final = FINALS[rest];
  }
  if (final === undefined) return null;
  const body = initial + final;
  return tone === 5 ? `˙${body}` : body + TONE_SIGN[tone];
}

/** A reading in the chosen aid: pinyin as given, zhuyin converted (the
 *  pinyin itself where it can't be). */
export function readingIn(mode: RubyMode, pinyin: string): string {
  if (mode === "zhuyin") return pinyinToZhuyin(pinyin) ?? pinyin;
  return pinyin;
}

/* -------------------------------- radicals -------------------------------- */

/** The 214 Kangxi radicals in order: radical n is KANGXI_RADICALS[n - 1]
 *  (Unihan's kRSUnicode counts by them). */
export const KANGXI_RADICALS = [
  ..."一丨丶丿乙亅二亠人儿入八冂冖冫几凵刀力勹匕匚匸十卜卩厂厶又口囗土士夂夊夕大女子宀寸小尢尸屮山巛工己巾干幺广廴廾弋弓彐彡彳" +
    "心戈戶手支攴文斗斤方无日曰月木欠止歹殳毋比毛氏气水火爪父爻爿片牙牛犬玄玉瓜瓦甘生用田疋疒癶白皮皿目矛矢石示禸禾穴立" +
    "竹米糸缶网羊羽老而耒耳聿肉臣自至臼舌舛舟艮色艸虍虫血行衣襾見角言谷豆豕豸貝赤走足身車辛辰辵邑酉釆里金長門阜隶隹雨靑非面革韋韭音頁" +
    "風飛食首香馬骨高髟鬥鬯鬲鬼魚鳥鹵鹿麥麻黃黍黑黹黽鼎鼓鼠鼻齊齒龍龜龠",
];

/** Unihan's radical-stroke value ("61.9", "120'.3") as the radical and the
 *  strokes beyond it; null when it can't be read. A ' marks the radical's
 *  simplified form (纟 for 糸), shown as its Kangxi form with the flag. */
export function parseRadical(rs: string | undefined): { radical: string; number: number; simplified: boolean; extra: number } | null {
  const m = /^(\d+)('*)\.(-?\d+)$/.exec(rs ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  const radical = KANGXI_RADICALS[n - 1];
  if (!radical) return null;
  return { radical, number: n, simplified: m[2].length > 0, extra: Number(m[3]) };
}
