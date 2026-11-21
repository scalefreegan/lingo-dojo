// Which recordings the tone check can score (web/src/pronunciationApi.ts
// uses these to skip a request the server would refuse; PracticeView to
// choose the microphone's processing). Pure and import-free so `node --test`
// runs it directly.

/** Locales the server scores (Mandarin, either script; scripts/
 *  pronunciation.mjs scoresTones is the rule, this only saves a request
 *  the server would refuse). Cantonese is another language with other
 *  tones. */
export function scoresTonesHere(locale: string | null | undefined): boolean {
  return /^(zh|cmn)(-(hans|hant))?(-(cn|tw|sg|my))?$/i.test(String(locale ?? ""));
}

const HAN = /\p{Script=Han}/u;
/** Text the route takes (pronunciation-app.mjs readScoreText): 1 to 24 Han
 *  characters with punctuation and spaces, nothing else. */
export function scorableText(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  const han = [...t].filter((c) => HAN.test(c)).length;
  return han > 0 && han <= 24 && [...t].length <= 64 && /^[\p{Script=Han}\p{P}\s]+$/u.test(t);
}

/** The microphone processing for a speak-it take (web/src/recorder.ts
 *  MicProcessing; docs/VOICE.md §The recorder): raw ("pitch") only when its
 *  recording will be tone-checked, i.e. a Mandarin locale and a phrase the
 *  route takes. A phrase too long or mixed with Latin letters is only
 *  transcribed, so it gets what a voice turn gets: noise suppression and
 *  auto gain help a quiet speaker be heard, and nothing measures pitch. */
export function speakItProcessing(locale: string | null | undefined, text: string | null | undefined): "pitch" | "conversation" {
  return scoresTonesHere(locale) && scorableText(text) ? "pitch" : "conversation";
}
