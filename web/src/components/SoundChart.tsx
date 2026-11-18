import { TONE_SOUNDS, ZHUYIN_SOUNDS, type SoundGroup } from "../script/sounds.ts";
import type { SoundPlayer } from "./useSound.ts";

/* The sound chart, opened from the character card (its own chunk): the 37
 * zhuyin symbols as initials, medials and finals, each with its pinyin and
 * a tap to hear it, and the five tones on ma. Every sound is the fixed
 * exemplar of sounds.ts, said by the card's player (useSound: the cached
 * /api/voice/sound), so a chart played through twice costs the provider
 * once. `toScript` puts an exemplar in the learner's script (simplified
 * for a mainland learner). */

const GROUPS: { group: SoundGroup; title: string; kidsTitle: string; note: string }[] = [
  { group: "initial", title: "Initials", kidsTitle: "Starting sounds", note: "The consonant a syllable starts with." },
  { group: "medial", title: "Medials", kidsTitle: "Glide sounds", note: "ㄧ ㄨ ㄩ: alone, or gliding into a final (ㄧㄚ ya)." },
  { group: "final", title: "Finals", kidsTitle: "Ending sounds", note: "The vowel part. ㄝ, ㄟ and ㄥ are heard in a syllable that has them." },
];

export default function SoundChart({ locale, kids, sound, toScript }: { locale: string; kids: boolean; sound: SoundPlayer; toScript: (t: string) => string }) {
  const tile = `flex flex-col items-center gap-0.5 rounded-lg border border-line bg-ground px-1 py-1.5 leading-tight hover:bg-accent-soft data-[playing]:bg-accent-soft`;
  const grid = `grid gap-1.5 ${kids ? "grid-cols-[repeat(auto-fill,minmax(4.75rem,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(4rem,1fr))]"}`;
  const playing = (t: string) => (sound.busy === t ? "" : undefined);
  return (
    <section aria-labelledby="sound-chart-title" className="flex flex-col gap-3 rounded-xl border border-line p-3" data-testid="sound-chart">
      <div className="flex flex-col gap-0.5">
        <h3 id="sound-chart-title" className="text-sm font-medium text-fg-2">
          {kids ? "All the sounds" : "Sound chart: zhuyin, pinyin and tones"}
        </h3>
        <p className="text-sm text-fg-3 sm:text-xs">
          {kids ? "Tap a sound to hear it." : "Tap one to hear it. Each is said through a character that is read only that way, shown under it."}
        </p>
      </div>
      {GROUPS.map(({ group, title, kidsTitle, note }) => (
        <div key={group} className="flex flex-col gap-1.5">
          <h4 className="text-sm font-medium text-fg-2">
            {kids ? kidsTitle : title}
            {!kids && <span className="ml-2 font-normal text-fg-3">{note}</span>}
          </h4>
          <ul className={grid}>
            {ZHUYIN_SOUNDS.filter((s) => s.group === group).map((s) => {
              const text = toScript(s.char);
              // ㄝ ㄟ ㄥ are said in a syllable that has them (sounds.ts).
              const heard = s.sound.startsWith(s.symbol) ? "" : ` (heard in ${s.sound})`;
              return (
                <li key={s.symbol}>
                  <button
                    type="button"
                    className={`${tile} w-full`}
                    data-playing={playing(text)}
                    aria-label={`${s.symbol}, pinyin ${s.pinyin}: hear it, as in ${text}${heard}`}
                    title={`${s.symbol} = ${s.pinyin}, as in ${text}${heard}`}
                    onClick={() => void sound.play(text)}
                  >
                    <span className={`${kids ? "text-3xl" : "text-2xl"} text-fg`} lang="zh-TW">
                      {s.symbol}
                    </span>
                    <span className={`${kids ? "text-base" : "text-sm"} text-accent`}>{s.pinyin}</span>
                    <span className="text-xs text-fg-3" lang={locale}>
                      {text}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="flex flex-col gap-1.5">
        <h4 className="text-sm font-medium text-fg-2">
          Tones
          {!kids && <span className="ml-2 font-normal text-fg-3">The same ma, five ways. The neutral tone is the second ma of 媽媽.</span>}
        </h4>
        <ul className={grid}>
          {TONE_SOUNDS.map((t) => {
            const text = toScript(t.text);
            return (
              <li key={t.tone}>
                <button
                  type="button"
                  className={`${tile} w-full`}
                  data-playing={playing(text)}
                  aria-label={`${t.name}, ${t.pinyin}: hear ${text}`}
                  title={`${t.name}: ${t.pinyin} (${text})`}
                  onClick={() => void sound.play(text)}
                >
                  <span className={`${kids ? "text-3xl" : "text-2xl"} text-fg`} lang="zh-TW">
                    {t.mark}
                  </span>
                  <span className={`${kids ? "text-base" : "text-sm"} text-accent`}>{t.pinyin}</span>
                  <span className="text-xs text-fg-3" lang={locale}>
                    {text}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
