// The pure half of voice practice (scripts/voice.mjs): locales, the key file,
// the prompt and reply format, and exactly what goes over the wire to each
// provider — all without a network. The routes are in voice.http.test.mjs.
//   node --test scripts/tests/voice.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  azureSpeechRequest, azureSsml, azureTranscribeRequest, azureVoices, configuredProviders, DEFAULT_ELEVEN_MODEL, elevenSpeechRequest,
  elevenTranscribeRequest, elevenVoices, localeFor, normalizeVoiceSettings, parseEnv, parseVoiceReply, SESSION_START, SILENCE_MS,
  speakable, systemVoices, transcriptText, voiceAdapter, voiceKeys, voiceSystemPrompt, voiceTurnPrompt,
} from "../voice.mjs";
import { REPO_ROOT } from "../content.mjs";

/* --------------------------------- locales -------------------------------- */

test("localeFor: language defaults, variant keywords, and BCP-47 passthrough", () => {
  assert.equal(localeFor("Spanish", "Mexican Spanish (Oaxaca)"), "es-MX");
  assert.equal(localeFor("Spanish", "Castilian Spanish (Spain)"), "es-ES");
  assert.equal(localeFor("Spanish", "Argentine Spanish"), "es-AR");
  assert.equal(localeFor("Mandarin Chinese", "Mainland Mandarin (Putonghua)"), "zh-CN");
  assert.equal(localeFor("Mandarin Chinese", "Taiwanese Mandarin"), "zh-TW");
  assert.equal(localeFor("French", "Québécois French"), "fr-CA");
  assert.equal(localeFor("German", "Swiss German"), "de-CH");
  assert.equal(localeFor("English"), "en-US");
  assert.equal(localeFor("English", "British English"), "en-GB");
  assert.equal(localeFor("Spanish", "es-CO"), "es-CO", "a variant that is already a locale wins");
  assert.equal(localeFor("Klingon"), null);
  assert.equal(localeFor(""), null);
});

test("localeFor: every language and variant in content/languages.yaml resolves", () => {
  // Reads the real library (never writes it): a language added there without
  // a locale here should fail this, not speak with the wrong accent.
  const doc = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "content", "languages.yaml"), "utf8"));
  for (const lang of doc.languages) {
    assert.match(localeFor(lang.name) ?? "", /^[a-z]{2}-[A-Z]{2}$/, lang.name);
    for (const v of lang.variants ?? []) assert.match(localeFor(lang.name, v) ?? "", /^[a-z]{2}-[A-Z]{2}$/, `${lang.name} / ${v}`);
  }
});

/* ----------------------------------- keys ---------------------------------- */

test("parseEnv: comments, export, quotes, trailing comments", () => {
  const env = parseEnv(`# keys
export ELEVENLABS_API_KEY="sk_abc"
AZURE_SPEECH_KEY='k#1'
AZURE_SPEECH_REGION=eastus # the region
not a line
`);
  assert.deepEqual(env, { ELEVENLABS_API_KEY: "sk_abc", AZURE_SPEECH_KEY: "k#1", AZURE_SPEECH_REGION: "eastus" });
});

test("voiceKeys: the file fills in, the environment wins; configuredProviders needs both Azure halves", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-env-"));
  const file = path.join(dir, ".env.local");
  fs.writeFileSync(file, "ELEVENLABS_API_KEY=from-file\nAZURE_SPEECH_KEY=az\n");
  const keys = voiceKeys({ ELEVENLABS_API_KEY: "from-env" }, file);
  assert.deepEqual(keys, { elevenlabs: "from-env", azureKey: "az", azureRegion: "" });
  assert.deepEqual(configuredProviders(keys, "darwin"), { elevenlabs: true, azure: false, system: true });
  assert.deepEqual(configuredProviders(voiceKeys({}, path.join(dir, "missing")), "linux"), { elevenlabs: false, azure: false, system: false });
});

/* --------------------------------- prompt ---------------------------------- */

test("voiceSystemPrompt: the pack first, then the adapter naming this mode's speakers", () => {
  const sys = voiceSystemPrompt("# Pack\nBe kind.", "adult");
  assert.ok(sys.startsWith("# Pack\nBe kind."));
  assert.match(sys, /NARRATOR:, CHARACTER:/);
  assert.doesNotMatch(sys, /SIDEKICK/);
  assert.match(voiceAdapter("kids"), /NARRATOR:, SIDEKICK:, CHARACTER:/);
  assert.match(sys, /normal script/, "asks for characters, not pinyin");
});

test("voiceTurnPrompt: replays the session and opens with the start marker", () => {
  assert.match(voiceTurnPrompt([], ""), new RegExp(`\\[LEARNER\\]\\n\\${SESSION_START.slice(0, -1)}\\]`));
  const p = voiceTurnPrompt(
    [{ role: "master", lines: [{ speaker: "character", text: "¡Hola!" }] }, { role: "learner", text: "hola" }],
    "¿cuánto cuesta?",
  );
  assert.match(p, /\[DOJO MASTER\]\nCHARACTER: ¡Hola!/);
  assert.match(p, /\[LEARNER\]\nhola/);
  assert.ok(p.trimEnd().endsWith("Reply as the dojo master, in tagged lines only."));
  assert.match(p, /\[LEARNER\]\n¿cuánto cuesta\?\n\n\[DOJO MASTER\]/);
});

/* ---------------------------------- reply ---------------------------------- */

test("parseVoiceReply: tags, continuation, merging, and unknown speakers", () => {
  const lines = parseVoiceReply(
    `NARRATOR: Let's begin.
We're at the market.
CHARACTER: ¡Buenos días!
**Character:** ¿Qué le doy?
SIDEKICK: (not in adult mode)
Plain line after.`,
    "adult",
  );
  assert.deepEqual(lines, [
    { speaker: "narrator", text: "Let's begin. We're at the market." },
    { speaker: "character", text: "¡Buenos días! ¿Qué le doy?" },
    { speaker: "narrator", text: "(not in adult mode) Plain line after." },
  ]);
  assert.deepEqual(parseVoiceReply("Hello there", "adult"), [{ speaker: "narrator", text: "Hello there" }]);
  assert.deepEqual(parseVoiceReply("HELPER: Boing!", "kids"), [{ speaker: "sidekick", text: "Boing!" }]);
  assert.deepEqual(parseVoiceReply("\n\n", "adult"), []);
});

test("speakable: drops stage directions and markdown, keeps the words", () => {
  assert.equal(speakable("*smiles warmly* **¡Hola!** [pause] ¿Cómo estás?"), "¡Hola! ¿Cómo estás?");
  assert.equal(speakable("- # Say `gracias`"), "Say gracias");
});

/* ------------------------------ request shapes ----------------------------- */

test("elevenSpeechRequest: key only in the header, v4 default with language_code", () => {
  const { url, init } = elevenSpeechRequest({ key: "SECRET", voice: "abc/123", text: "Hola", locale: "es-MX" });
  assert.equal(url, "https://api.elevenlabs.io/v1/text-to-speech/abc%2F123?output_format=mp3_44100_128");
  assert.equal(init.headers["xi-api-key"], "SECRET");
  assert.doesNotMatch(url, /SECRET/);
  assert.deepEqual(JSON.parse(init.body), { text: "Hola", model_id: DEFAULT_ELEVEN_MODEL, language_code: "es" });
  const v2 = elevenSpeechRequest({ key: "k", voice: "v", text: "x", model: "eleven_multilingual_v2", locale: "es-MX" });
  assert.equal(JSON.parse(v2.init.body).language_code, undefined, "multilingual v2 rejects language_code");
});

test("transcribe requests: Scribe v2 for ElevenLabs, both locales as Azure candidates", async () => {
  const audio = new Uint8Array([1, 2, 3]);
  const el = elevenTranscribeRequest({ key: "K", audio });
  assert.equal(el.url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(el.init.body.get("model_id"), "scribe_v2");
  assert.equal((await el.init.body.get("file").arrayBuffer()).byteLength, 3);
  const az = azureTranscribeRequest({ key: "K", region: "eastus", audio, locales: ["es-MX", "en-US", "es-MX", "bogus"] });
  assert.match(az.url, /^https:\/\/eastus\.api\.cognitive\.microsoft\.com\/speechtotext\/transcriptions:transcribe\?api-version=/);
  assert.deepEqual(JSON.parse(az.init.body.get("definition")), { locales: ["es-MX", "en-US"] });
  assert.equal(az.init.headers["Ocp-Apim-Subscription-Key"], "K");
  assert.throws(() => azureTranscribeRequest({ key: "K", region: "evil.com/x", audio, locales: [] }), /region/);
});

test("azureSsml: escapes the text and refuses a voice name that could break out", () => {
  const ssml = azureSsml({ voice: "zh-CN-XiaoxiaoMultilingualNeural", text: `<b>"5 & 6"</b>`, locale: "zh-CN" });
  assert.match(ssml, /xml:lang="zh-CN"><voice name="zh-CN-XiaoxiaoMultilingualNeural">&lt;b&gt;&quot;5 &amp; 6&quot;&lt;\/b&gt;<\/voice>/);
  assert.doesNotThrow(() => azureSsml({ voice: "en-US-Ava:DragonHDLatestNeural", text: "hi" }));
  assert.throws(() => azureSsml({ voice: `x"><audio src="y`, text: "hi" }), /not an Azure voice/);
  const req = azureSpeechRequest({ key: "K", region: "westeurope", voice: "es-MX-DaliaNeural", text: "Hola" });
  assert.equal(req.url, "https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1");
  assert.equal(req.init.headers["Content-Type"], "application/ssml+xml");
});

/* ------------------------------ reply parsing ------------------------------ */

test("voice lists: natives first, in the picker's shape", () => {
  const el = elevenVoices(
    {
      voices: [
        // Multilingual premade: verified in Spanish, but an American voice.
        { voice_id: "a", name: "Roger", labels: { accent: "american", language: "en" }, verified_languages: [{ language: "es", locale: "es-ES" }] },
        { voice_id: "b", name: "Lucía", labels: { gender: "female", language: "es", accent: "castilian" }, verified_languages: [{ language: "es", locale: "es-ES" }] },
        { voice_id: "c", name: "Silverio", labels: { language: "es", accent: "mexican" }, verified_languages: [{ language: "es", locale: "es-MX" }] },
      ],
    },
    "es-MX",
  );
  assert.deepEqual(el.map((v) => [v.id, v.match]), [["c", true], ["b", true], ["a", false]]);
  assert.equal(el[0].note, "mexican");

  const az = azureVoices(
    [
      { ShortName: "es-MX-JorgeNeural", DisplayName: "Jorge", Locale: "es-MX", Gender: "Male", VoiceType: "Neural" },
      { ShortName: "es-MX-DaliaMultilingualNeural", DisplayName: "Dalia", Locale: "es-MX", Gender: "Female", VoiceType: "Neural" },
      { ShortName: "en-US-AvaNeural", DisplayName: "Ava", Locale: "en-US" },
      { ShortName: "en-US-AndrewMultilingualNeural", DisplayName: "Andrew", Locale: "en-US", SecondaryLocaleList: ["es-MX"] },
    ],
    "es-MX",
  );
  assert.deepEqual(az.map((v) => v.id), ["es-MX-DaliaMultilingualNeural", "es-MX-JorgeNeural", "en-US-AndrewMultilingualNeural"]);

  const say = systemVoices("Tingting             zh_CN    # 你好！我叫婷婷。\nEddy (Chinese (China mainland)) zh_CN    # 你好\nAlex                en_US    # Hi", "zh-CN");
  assert.deepEqual(say.map((v) => v.id), ["Tingting", "Eddy (Chinese (China mainland))"]);
});

test("transcriptText: each provider's reply shape", () => {
  assert.equal(transcriptText("elevenlabs", { text: " hola qué tal " }), "hola qué tal");
  assert.equal(transcriptText("azure", { combinedPhrases: [{ text: "hola" }, { text: "qué tal" }] }), "hola qué tal");
  assert.equal(transcriptText("azure", {}), "");
});

/* --------------------------------- settings -------------------------------- */

test("normalizeVoiceSettings: defaults, clamping, and junk in the voice map dropped", () => {
  const d = normalizeVoiceSettings(null);
  assert.equal(d.tts, "elevenlabs");
  assert.equal(d.turn, "tap");
  assert.equal(d.silenceMs, SILENCE_MS.default);
  assert.equal(d.review, true);
  const s = normalizeVoiceSettings({
    tts: "nope",
    silenceMs: 99_999,
    model: "claude-haiku-5-5",
    voices: { elevenlabs: { "es-MX": { narrator: " v1 ", wizard: "v2", character: 7 }, "not a locale": { narrator: "x" } }, bogus: {} },
  });
  assert.equal(s.tts, "elevenlabs");
  assert.equal(s.silenceMs, SILENCE_MS.max);
  assert.equal(s.model, "claude-haiku-5-5");
  assert.deepEqual(s.voices, { elevenlabs: { "es-MX": { narrator: "v1" } } });
});
