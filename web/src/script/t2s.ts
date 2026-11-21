/* Traditional → simplified for the Mandarin reader (zh.ts), from OpenCC's
 * tables (opencc-js, its data Apache-2.0: OPENCC-LICENSE.txt). Only
 * the two tables of OpenCC's t2s conversion are imported, never its
 * converter presets, so the other directions stay out of the bundle; this
 * module is reached only through zh.ts, which ruby.tsx loads on demand.
 *
 * OpenCC's t2s: its phrases first, longest match, then single characters.
 * Phrases are what the old one-character table (Unihan's, which kept a
 * character only when it had one simplified form) could not do: 蘋 has two
 * simplified forms (苹, 𬞟), 徵 two (征 in 徵求, itself in 宮商角徵羽), 乾
 * two (干 in 乾淨, itself in 乾隆), and only the word around one says which.
 * Not OpenCC's tw2s, whose first stage turns Taiwan's forms into OpenCC's
 * own traditional ones: it also turns a simplified text's 么 into 幺 (read
 * yāo) and 原著 into 原着, and TSCharacters already takes Taiwan's forms
 * (為, 裡, 眾, 汙) straight to simplified. The one Taiwan form it leaves is
 * 著, whose zhe / zháo / zhù is decided here by its neighbours (zheForm).
 *
 * Run here, not through opencc-js's converter, so every character keeps
 * its place: the reader gives one reading per code point of the text the
 * learner sees, so its simplified spelling must have exactly as many code
 * points, each standing for the one at the same index. Every entry in
 * today's tables maps one for one; an entry that ever doesn't is taken
 * character by character through the same table's single-character
 * entries (and a character with no one-character form stays as it is), so
 * no reading can shift onto a neighbour (t2s.test.mjs: alignedStage).
 *
 * OpenCC's t2s assumes its input is traditional; run over simplified text
 * it re-maps valid simplified characters (打坏 → 打坯 pī, 沈默 → 沉默, 徵 →
 * 征). So the reader converts a zh-CN text only when it holds a
 * traditional-only character (looksTraditional), and never applies a
 * phrase whose key is already simplified text (PHRASE_SIMPLIFIED). */

import TSPhrases from "opencc-js/dict/TSPhrases";
import TSCharacters from "opencc-js/dict/TSCharacters";

export interface Stage {
  map: Map<string, string>;
  /** Code points in the longest key, so a match never looks further. */
  longest: number;
  /** The first code point of every key: most characters start none. */
  starts: Set<string>;
}

/** One stage from OpenCC dictionaries ("萬 万|與 与", a phrase table
 *  first): an earlier table's entry wins over a later one's for the same
 *  key, as in OpenCC's own loading. The first of several candidates is
 *  OpenCC's choice, and ours. `skip` leaves an entry out. */
export function makeStage(dicts: string[], skip: (from: string, to: string) => boolean = () => false): Stage {
  const map = new Map<string, string>();
  let longest = 1;
  const starts = new Set<string>();
  for (const d of dicts) {
    for (const line of d.split("|")) {
      const [from, to] = line.split(" ");
      if (!from || !to || map.has(from) || skip(from, to)) continue;
      map.set(from, to);
      const cps = [...from];
      longest = Math.max(longest, cps.length);
      starts.add(cps[0]);
    }
  }
  return { map, longest, starts };
}

/** `cps` (code points) through one stage: longest match first, the
 *  output exactly as long as the input, index for index. */
export function alignedStage(stage: Stage, cps: readonly string[]): string[] {
  const out = cps.slice();
  for (let i = 0; i < cps.length; ) {
    let used = 1;
    if (stage.starts.has(cps[i])) {
      for (let n = Math.min(stage.longest, cps.length - i); n >= 1; n--) {
        const to = stage.map.get(n === 1 ? cps[i] : cps.slice(i, i + n).join(""));
        if (to === undefined) continue;
        const parts = [...to];
        if (parts.length === n) for (let k = 0; k < n; k++) out[i + k] = parts[k];
        else {
          // Not one for one: each character on its own, in place.
          for (let k = 0; k < n; k++) {
            const one = stage.map.get(cps[i + k]);
            if (one !== undefined && [...one].length === 1) out[i + k] = one;
          }
        }
        used = n;
        break;
      }
    }
    i += used;
  }
  return out;
}

/** Characters simplified text writes for another traditional one
 *  (STCharacters keys: 坏 for 壞, 么 for 麼, 岩 for 巖) that some
 *  converting TSPhrases key holds. Such a key is already simplified text,
 *  and OpenCC's reading of it as traditional misfires: 打坏 → 打坯 (pī),
 *  拉坏 → 拉坯. Those 23 entries are never applied. t2s.test.mjs derives
 *  this list from the tables, so the STCharacters table needn't ship. */
export const PHRASE_SIMPLIFIED = "坏么麽丑郁岩于";
/** Characters that are traditional and never simplified: keys of
 *  TSCharacters or in a TSPhrases key, that are neither a TSCharacters
 *  candidate, nor in a TSPhrases value, nor a STCharacters key (all
 *  three are characters simplified text writes: 乾 of 乾隆, 徵 of
 *  宫商角徵羽, 沈, 瞭 of 瞭望 are). The last set's share here is
 *  ALSO_SIMPLIFIED, so STCharacters needn't ship (t2s.test.mjs derives
 *  both). Some 3,200 characters: 見 這 裡 為 們 蘋 …. */
export const ALSO_SIMPLIFIED = "緼藴輼醖";

const entries = (d: string) =>
  d.split("|").flatMap((line) => {
    const [from, ...to] = line.split(" ");
    return from && to.length ? [[from, to] as const] : [];
  });

let tradOnly: Set<string> | null = null;
/** The traditional-only characters (see ALSO_SIMPLIFIED). */
export function tradOnlyChars(): ReadonlySet<string> {
  if (!tradOnly) {
    const simp = new Set<string>(ALSO_SIMPLIFIED);
    const keys = new Set<string>();
    for (const [from, to] of entries(TSCharacters)) {
      keys.add(from);
      for (const t of to) simp.add(t);
    }
    for (const [from, to] of entries(TSPhrases)) {
      for (const c of from) keys.add(c);
      for (const t of to) for (const c of t) simp.add(c);
    }
    tradOnly = new Set([...keys].filter((c) => !simp.has(c)));
  }
  return tradOnly;
}

/** Whether `text` holds a traditional-only character, so it is
 *  traditional text (or mixed) and is read through its simplified
 *  spelling. */
export function looksTraditional(text: string): boolean {
  const set = tradOnlyChars();
  for (const c of text) if (set.has(c) || set.has(c.normalize("NFC"))) return true;
  return false;
}

let simpOnly: Set<string> | null = null;
/** The simplified-only characters: TSCharacters candidates that are no
 *  key of either table (so not a traditional character too) and not a
 *  SHARED_FORMS one: 们 这 发 干 台 后 里, some 2,900. From the t→s tables
 *  alone, so STCharacters needn't ship: every one is a STCharacters key
 *  that lists only other characters (t2s.test.mjs), a subset of those
 *  (the rest, ~940 rare ones such as 馀 锺, never occur as a TSCharacters
 *  candidate; a text holding only those reads as script-neutral). */
export function simplifiedOnlyChars(): ReadonlySet<string> {
  if (!simpOnly) {
    const trad = new Set<string>();
    const cand = new Set<string>();
    for (const [from, to] of entries(TSCharacters)) {
      trad.add(from);
      for (const t of to) cand.add(t);
    }
    for (const [from] of entries(TSPhrases)) for (const c of from) trad.add(c);
    simpOnly = new Set([...cand].filter((c) => !trad.has(c) && !SHARED_FORMS.includes(c)));
  }
  return simpOnly;
}

/** How a zh-CN text is read. "traditional": it holds a traditional-only
 *  character, so it is converted (a mixed line too: no phrase whose key
 *  is simplified text is applied, PHRASE_SIMPLIFIED). "simplified": no
 *  traditional-only character but a simplified-only one, so read as it
 *  is. "neutral": neither (乾杯, 看著, 著名, 於是, 瞭解): converted too, but
 *  著 is zhù unless its neighbours say otherwise (zheNeutral), since
 *  simplified text writes 著 only for zhù. */
export type Script = "traditional" | "simplified" | "neutral";
export function scriptOf(text: string): Script {
  if (looksTraditional(text)) return "traditional";
  const set = simplifiedOnlyChars();
  for (const c of text) if (set.has(c)) return "simplified";
  return "neutral";
}

// A word OpenCC's tables lack, ahead of them: 乾安 (a county, qián) would
// otherwise take TSCharacters' 乾 → 干.
const EXTRA_PHRASES = "乾安 乾安";
let ts: Stage | null = null;
const tsStage = () =>
  (ts ??= makeStage([EXTRA_PHRASES, TSPhrases, TSCharacters], (from, to) => [...from].length > 1 && from !== to && [...from].some((c) => PHRASE_SIMPLIFIED.includes(c))));

/** In script-neutral text (scriptOf), the characters that are simplified
 *  ones too keep that reading where it is the likelier: 麽 mó after 幺
 *  (幺麽小丑; 什麽 is 什么), 徵 zhǐ (the note) alone or beside another note
 *  or 咀 (含商咀徵); 徵求, 特徵 still read zhēng. */
function neutralForm(cps: readonly string[], i: number, out: string): string {
  const near = `${cps[i - 1] ?? ""}${cps[i + 1] ?? ""}`;
  if (cps[i] === "麽" && /[幺么]/.test(cps[i - 1] ?? "")) return "麽";
  if (cps[i] === "徵" && (!/\p{Script=Han}/u.test(near) || /[宫宮商角羽咀]/.test(near))) return "徵";
  return out;
}

// 著 is zhù (write; notable) in these words, else 着 (看著 zhe, 睡著 zháo,
// 著急 zháo, 著陸 zhuó): Taiwan writes all of them with 著. From CC-CEDICT's
// zhù words: 著名 著作 著稱 著述 著書 著錄 著者; 顯著 名著 土著 原著 巨著 專著 編著
// 論著 譯著 遺著 拙著 卓著 昭著 炳著 較著 知著. Simplified forms too, so a
// mainland text's 著 (always zhù there) stays 著 in these words.
const ZHU_NEXT = "名作稱称述書书錄录者";
const ZHU_PREV = "顯显名土編编原巨論论專专譯译遺遗拙卓昭炳較较知";
/** 著 at `i` of `cps` as the form that reads it in context: 着 or itself. */
function zheForm(cps: readonly string[], i: number): string {
  // "\0" for no neighbour: "".includes would find it in any list.
  return ZHU_NEXT.includes(cps[i + 1] ?? "\0") || ZHU_PREV.includes(cps[i - 1] ?? "\0") ? "著" : "着";
}

// In script-neutral text 著 is zhù (all simplified text has) unless it
// follows a verb as the aspect particle or the complement (看著 zhe, 睡著,
// 睡不著 zháo) or begins a zháo / zhuó word (著急 著手 著想 著陸 著涼).
const ZHE_PREV = "看睡等坐站躺拿聽听想笑哭唱跟帶带穿戴開开關关走跑寫写讀读用找吃喝說说望忙接拉抱背扶藏留守聊陪叫問问不得";
const ZHE_NEXT = "急手想陸陆涼凉迷火眼力落地實实重色裝装墨";
function zheNeutral(cps: readonly string[], i: number): string {
  return ZHE_PREV.includes(cps[i - 1] ?? "\0") || ZHE_NEXT.includes(cps[i + 1] ?? "\0") ? "着" : "著";
}

/** The simplified characters (BMP) that are also traditional characters
 *  in their own right: targets of OpenCC's TSCharacters that its
 *  STCharacters leaves as they are. 只 is a word of its own (zhǐ) as well
 *  as 隻's form (zhī), 症 (zhèng) as well as 癥's (zhēng). t2s.test.mjs
 *  derives this list from the tables, so an OpenCC upgrade that changes it
 *  fails there. */
export const SHARED_FORMS =
  "佛俊修僵克冢冬凌出刮制千升卜即卷只合吊同向呆周咽哄喂噪回困埼奸姜娘家局巨布席幸庵弦彩御志念恤愈戚扇才扎托扣折抬抵拐拼挨挲挽捆捍搜教旋旗既昆暗曲札朱杆杯松板查栗核梁棋棱欲污沈沾泄泛注溪溯漓狸玩璇症真矩私秋糊糖系累胄胡致舍芸苔蒙蓑蔑表谷踊逾酸雕面飧";

let sources: Map<string, string[]> | null = null;
/** The other characters that `simp` spells besides `ch`: the traditional
 *  ones OpenCC simplifies to it, and `simp` itself where it is a
 *  character of its own (SHARED_FORMS). 发 spells 發 and 髮; 干 spells
 *  乾, 幹 and 榦; 只 spells 隻 and 只. The reader keeps a reading in
 *  context unless it belongs to one of these and not to `ch`. */
export function mergedWith(ch: string, simp: string): string[] {
  if (!sources) {
    sources = new Map();
    for (const line of TSCharacters.split("|")) {
      const [from, to] = line.split(" ");
      if (!from || !to) continue;
      const list = sources.get(to) ?? [];
      list.push(from);
      sources.set(to, list);
    }
  }
  const all = [...(sources.get(simp) ?? []), ...(SHARED_FORMS.includes(simp) ? [simp] : [])];
  return all.filter((c) => c !== ch);
}

/** `text` in simplified characters, one per code point of `text` (a
 *  character with no simplified form, or not Chinese, as itself). A CJK
 *  compatibility ideograph (U+F900…) is first read as the unified one it
 *  stands for, as OpenCC normalises it. */
export function simplifyAligned(text: string, { neutral = false }: { neutral?: boolean } = {}): string[] {
  const cps = [...text].map((c) => {
    const n = c.normalize("NFC");
    return [...n].length === 1 ? n : c;
  });
  const out = alignedStage(tsStage(), cps);
  for (let i = 0; i < cps.length; i++) {
    if (cps[i] === "著") out[i] = neutral ? zheNeutral(cps, i) : zheForm(cps, i);
    else if (neutral) out[i] = neutralForm(cps, i, out[i]);
  }
  return out;
}
