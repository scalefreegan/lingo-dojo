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
  elevenTranscribeRequest, keytermsFrom, SKIP, HELP, DIRECT, linePauseMs, LINE_PAUSE, pickCast, pinnedNarratorGender, narratorDirective, elevenVoices, localeFor, normalizeVoiceSettings, parseEnv, parseVoiceReply, SESSION_START, SILENCE_MS,
  speakable, systemVoices, transcriptText, voiceAdapter, voiceKeys, voiceSystemPrompt, voiceTurnPrompt,
  voiceFor, voiceSlots, splitLong, elevenLibraryRequest, elevenLibrary, elevenAddRequest,
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
  assert.match(sys, /NARRATOR-F:, CHARACTER-F:/);
  assert.match(sys, /-F for a woman, -M for a man/);
  assert.ok(sys.includes(`"${SKIP}"`), "the adapter explains the Skip button's message");
  assert.ok(sys.includes(`"${HELP}"`), "and the Help button's");
  assert.ok(sys.includes(`"${DIRECT}"`), "and a direct request's prefix");
  assert.doesNotMatch(sys, /SIDEKICK/);
  assert.match(voiceAdapter("kids"), /NARRATOR-F:, SIDEKICK-F:, CHARACTER-F:/);
  assert.match(sys, /normal script/, "asks for characters, not pinyin");
  assert.match(sys, /<t>…<\/t>/, "asks for target-language marks");
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

const plain = (lines) => lines.map(({ speaker, text }) => ({ speaker, text }));

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
  assert.deepEqual(plain(lines), [
    { speaker: "narrator", text: "Let's begin. We're at the market." },
    { speaker: "character", text: "¡Buenos días! ¿Qué le doy?" },
    { speaker: "narrator", text: "(not in adult mode) Plain line after." },
  ]);
  assert.deepEqual(plain(parseVoiceReply("Hello there", "adult")), [{ speaker: "narrator", text: "Hello there" }]);
  assert.deepEqual(plain(parseVoiceReply("HELPER: Boing!", "kids")), [{ speaker: "sidekick", text: "Boing!" }]);
  assert.deepEqual(parseVoiceReply("\n\n", "adult"), []);
});

test("parseVoiceReply: <t> marks split a line into target and native segments", () => {
  const [narrator, character] = parseVoiceReply(
    `NARRATOR: The word for tomato is <t>jitomate</t>. Try: <t>un kilo, por favor</t>
CHARACTER: <t>¡Claro! ¿Algo más?`,
    "adult",
  );
  assert.deepEqual(narrator.segments, [
    { lang: "native", text: "The word for tomato is" },
    { lang: "target", text: "jitomate." },
    { lang: "native", text: "Try:" },
    { lang: "target", text: "un kilo, por favor" },
  ]);
  assert.equal(narrator.text, "The word for tomato is jitomate. Try: un kilo, por favor");
  assert.deepEqual(character.segments, [{ lang: "target", text: "¡Claro! ¿Algo más?" }], "an unclosed <t> runs to the end of the line");
  // Same-speaker lines merge, and so do touching same-language segments.
  const [merged] = parseVoiceReply("CHARACTER: <t>Hola.</t>\n<t>¿Qué tal?</t>", "adult");
  assert.deepEqual(merged.segments, [{ lang: "target", text: "Hola. ¿Qué tal?" }]);
  // Replayed history puts the marks back.
  assert.match(voiceTurnPrompt([{ role: "master", lines: [narrator] }], "x"), /NARRATOR: The word for tomato is <t>jitomate\.<\/t> Try: <t>un kilo, por favor<\/t>/);
});

test("parseVoiceReply: gender tags in any punctuation; a gender change starts a new line", () => {
  const lines = parseVoiceReply(
    `NARRATOR-F: Welcome.
**Character (M):** <t>¡Pásele!</t>
CHARACTER/woman: <t>¿Y usted?</t>
CHARACTER-F: <t>Bienvenida.</t>
CHARACTER: untagged gender`,
    "adult",
  );
  assert.deepEqual(lines.map((l) => [l.speaker, l.gender, l.text]), [
    ["narrator", "female", "Welcome."],
    ["character", "male", "¡Pásele!"],
    ["character", "female", "¿Y usted? Bienvenida."],
    ["character", null, "untagged gender"],
  ]);
  // The replay keeps the gender in the tag.
  assert.match(voiceTurnPrompt([{ role: "master", lines }], "x"), /NARRATOR-F: Welcome\.\nCHARACTER-M: <t>¡Pásele!<\/t>\nCHARACTER-F:/);
});

test("parseVoiceReply: a <t> wrap may span lines, but never crosses into a new speaker", () => {
  const segs = (t) => parseVoiceReply(t, "adult").map((l) => l.segments);
  assert.deepEqual(segs("CHARACTER-M: <t>¡Hola!\n¿Qué te doy?</t>\nOkay."), [
    [{ lang: "target", text: "¡Hola! ¿Qué te doy?" }, { lang: "native", text: "Okay." }],
  ]);
  assert.deepEqual(segs("CHARACTER-F: <t>¡Pásele!\nNARRATOR-F: Now you answer."), [
    [{ lang: "target", text: "¡Pásele!" }],
    [{ lang: "native", text: "Now you answer." }],
  ]);
});

test("parseVoiceReply: punctuation after a target phrase stays with it, never a call of its own", () => {
  const [line] = parseVoiceReply(
    "NARRATOR-F: The word for tomato here is <t>jitomate</t>. Try asking for a kilo: <t>un kilo de jitomates, por favor</t>.",
    "adult",
  );
  assert.deepEqual(line.segments, [
    { lang: "native", text: "The word for tomato here is" },
    { lang: "target", text: "jitomate." },
    { lang: "native", text: "Try asking for a kilo:" },
    { lang: "target", text: "un kilo de jitomates, por favor." },
  ]);
  assert.equal(line.text, "The word for tomato here is jitomate. Try asking for a kilo: un kilo de jitomates, por favor.");
  assert.deepEqual(parseVoiceReply("CHARACTER-F: <t>你好</t>。", "adult")[0].segments, [{ lang: "target", text: "你好。" }]);
});

test("timing: <pause>/<overlap> marks set the gap; the narrator handover always pauses", () => {
  const lines = parseVoiceReply(
    `NARRATOR-F: Here we go.
CHARACTER-M: <t>¡Buenas!</t>
<pause 1.2> CHARACTER-M: <t>A ver, déjeme pesarlos.</t>
<overlap 0.4>
CHARACTER-F: <t>¡Oiga, yo estaba primero!</t>
CHARACTER-F: <t>¿Me atiende?</t>
<overlap 0.5> NARRATOR-F: Your turn.`,
    "adult",
  );
  assert.deepEqual(lines.map((l) => [l.speaker, l.gap ?? null, l.pauseMs]), [
    ["narrator", null, 0],
    ["character", null, LINE_PAUSE.narratorSwitch],
    ["character", 1.2, 1200], // a timed line from the same speaker stays its own line
    ["character", -0.4, -400], // a mark on its own line applies to the next
    ["narrator", -0.5, LINE_PAUSE.narratorSwitchMin], // never overlap the narrator
  ]);
  assert.equal(lines[3].text, "¡Oiga, yo estaba primero! ¿Me atiende?", "an untimed line by the same speaker merges");
  assert.ok(lines.every((l) => !/pause|overlap/.test(l.text)), "marks are never spoken");
  // The replayed history keeps the marks, so the model sees its own format.
  const replay = voiceTurnPrompt([{ role: "master", lines }], "x");
  assert.match(replay, /<pause 1\.2> CHARACTER-M: <t>A ver/);
  assert.match(replay, /<overlap 0\.4> CHARACTER-F:/);
});

test("timing: a misplaced mark is still a timing mark, never spoken", () => {
  const one = (t) => parseVoiceReply(t, "adult").map((l) => [l.speaker, l.gap ?? null, l.text]);
  assert.deepEqual(one("CHARACTER-M: <pause 1.2> <t>Mmm a ver</t>"), [["character", 1.2, "Mmm a ver"]]);
  assert.deepEqual(one("**<pause 1.2> CHARACTER-M:** <t>Mmm a ver</t>"), [["character", 1.2, "Mmm a ver"]]);
  assert.deepEqual(one("<pause 1,5> CHARACTER-M: <t>Hola</t>"), [["character", 1.5, "Hola"]]);
  assert.deepEqual(one("CHARACTER-F: <t>Sí</t> <pause> claro"), [["character", null, "Sí claro"]]);
});

test("linePauseMs: defaults by who speaks, clamps what the model asks for", () => {
  const n = { speaker: "narrator", gender: "female" };
  const cm = { speaker: "character", gender: "male" };
  assert.equal(linePauseMs(null, n), 0);
  assert.equal(linePauseMs(n, cm), LINE_PAUSE.narratorSwitch);
  assert.equal(linePauseMs(cm, { ...cm }), LINE_PAUSE.sameSpeaker);
  assert.equal(linePauseMs(cm, { speaker: "character", gender: "female" }), LINE_PAUSE.newSpeaker);
  assert.equal(linePauseMs(cm, { ...cm, gap: 0 }), 0, "back to back when asked");
  assert.equal(linePauseMs(cm, { ...cm, gap: 30 }), LINE_PAUSE.max);
  assert.equal(linePauseMs(cm, { ...cm, gap: -9 }), -LINE_PAUSE.maxOverlap);
  assert.equal(linePauseMs(cm, { ...n, gap: 0.1 }), LINE_PAUSE.narratorSwitchMin);
});

test("splitLong: long segments break at sentence ends, under the cap", () => {
  const sentence = "Esta es una oración bastante larga para la prueba. ";
  const parts = splitLong(sentence.repeat(60).trim(), 300);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 300 && p.endsWith(".")));
  assert.equal(parts.join(" "), sentence.repeat(60).trim());
  assert.deepEqual(splitLong("x".repeat(25), 10), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  const [line] = parseVoiceReply(`NARRATOR-F: ${sentence.repeat(60)}`, "adult");
  assert.ok(line.segments.length > 1 && line.segments.every((g) => g.text.length <= 1200));
});

test("normalizeVoiceSettings: older ungendered choices fill only the empty gendered slots", () => {
  const s = normalizeVoiceSettings({
    voices: { system: { "es-MX": { narrator: "Eddy", character: "Flo", "character:male": "Reed" }, "zh-TW": { sidekick: "Flo" } } },
  });
  assert.deepEqual(s.voices.system["es-MX"], { "narrator:female": "Eddy", "narrator:male": "Eddy", "character:female": "Flo", "character:male": "Reed" });
  assert.deepEqual(s.voices.system["zh-TW"], { "sidekick:female": "Flo", "sidekick:male": "Flo" });
  // Idempotent: a second pass changes nothing.
  assert.deepEqual(normalizeVoiceSettings(s).voices, s.voices);
});

test("splitLong: Chinese and Japanese break at their full stops, with nothing added or lost", () => {
  const zh = "我想買一公斤番茄。".repeat(40);
  const parts = splitLong(zh, 100);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 100 && p.endsWith("。")));
  assert.equal(parts.join(""), zh);
  assert.deepEqual(splitLong("Cuesta 3.5 pesos. ".repeat(3).trim(), 20), ["Cuesta 3.5 pesos.", "Cuesta 3.5 pesos.", "Cuesta 3.5 pesos."]);
});

test("voiceSlots and voiceFor: gender beats role, older ungendered choices still work", () => {
  assert.deepEqual(voiceSlots("adult"), ["narrator:female", "narrator:male", "character:female", "character:male"]);
  assert.equal(voiceSlots("kids").length, 6);
  const set = { "narrator:female": "NF", "narrator:male": "NM", "character:female": "CF" };
  assert.equal(voiceFor(set, "character", "female"), "CF");
  assert.equal(voiceFor(set, "character", "male"), "NM", "a man's voice from the narrator beats the character's woman's voice");
  assert.equal(voiceFor({ "character:female": "CF" }, "character", "male"), "CF", "the other gender only when no man's voice exists");
  assert.equal(voiceFor(set, "sidekick", null), "NF");
  assert.equal(voiceFor({ narrator: "old" }, "character", "male"), "old");
  assert.equal(voiceFor({}, "narrator", "female"), "");
});

test("library requests: native-locale search, sorting, and a guarded add", () => {
  const { url, init } = elevenLibraryRequest({ key: "K", locale: "es-MX", gender: "female", search: "cálida", sort: "trending", page: 2 });
  const u = new URL(url);
  assert.equal(u.pathname, "/v1/shared-voices");
  assert.equal(u.searchParams.get("language"), "es");
  assert.equal(u.searchParams.get("locale"), "es-MX");
  assert.equal(u.searchParams.get("gender"), "female");
  assert.equal(u.searchParams.get("search"), "cálida");
  assert.equal(u.searchParams.get("sort"), "trending");
  assert.equal(u.searchParams.get("page"), "2");
  assert.equal(init.headers["xi-api-key"], "K");
  assert.equal(new URL(elevenLibraryRequest({ key: "K", sort: "bogus", gender: "x" }).url).searchParams.get("sort"), "usage_character_count_1y");
  assert.equal(new URL(elevenLibraryRequest({ key: "K", gender: "x" }).url).searchParams.get("gender"), null);

  const lib = elevenLibrary({
    has_more: true,
    total_count: 412,
    voices: [
      { voice_id: "JYyJjNPfmNJdaby8LdZs", public_owner_id: "owner123abc", name: "Marlene ", gender: "female", age: "young", accent: "mexican", use_case: "narrative_story",
        description: " Bright. ", preview_url: "https://storage.example/p.mp3", usage_character_count_1y: 2062010298, cloned_by_count: 36944, is_added_by_user: false },
      { voice_id: "x", public_owner_id: "y", preview_url: "javascript:alert(1)" },
      { name: "no ids" },
    ],
  });
  assert.equal(lib.hasMore, true);
  assert.equal(lib.total, 412);
  assert.equal(lib.voices.length, 2);
  assert.deepEqual(
    { ...lib.voices[0] },
    { id: "JYyJjNPfmNJdaby8LdZs", ownerId: "owner123abc", name: "Marlene", description: "Bright.", accent: "mexican", gender: "female", age: "young",
      useCase: "narrative story", locale: "", previewUrl: "https://storage.example/p.mp3", usage1y: 2062010298, usage7d: 0, clonedBy: 36944, added: false },
  );
  assert.equal(lib.voices[1].previewUrl, "", "only an https preview is played");

  const add = elevenAddRequest({ key: "K", ownerId: "owner123abc", voiceId: "JYyJjNPfmNJdaby8LdZs", name: "Marlene" });
  assert.equal(add.url, "https://api.elevenlabs.io/v1/voices/add/owner123abc/JYyJjNPfmNJdaby8LdZs");
  assert.deepEqual(JSON.parse(add.init.body), { new_name: "Marlene" });
  assert.throws(() => elevenAddRequest({ key: "K", ownerId: "../../x", voiceId: "JYyJjNPfmNJdaby8LdZs" }), /not an ElevenLabs voice id/);
});

test("keytermsFrom: target phrases cut to Scribe's limits, deduplicated, capped", () => {
  assert.deepEqual(
    keytermsFrom(["¡Buenas! ¿A cómo el kilo de jitomate?", "un kilo de jitomates, por favor", "A cómo el kilo de jitomate", "esta frase tiene muchas más de cinco palabras en total"]),
    ["Buenas", "A cómo el kilo de", "jitomate", "un kilo de jitomates", "por favor", "esta frase tiene muchas más", "de cinco palabras en total"],
  );
  assert.deepEqual(keytermsFrom(["我要一公斤。謝謝！"]), ["我要一公斤", "謝謝"]);
  assert.equal(keytermsFrom(Array.from({ length: 300 }, (_, i) => `palabra${i}`)).length, 100);
  assert.deepEqual(keytermsFrom("nope"), []);
});

test("cast: chosen voices stay, Random slots draw distinct voices of their gender", () => {
  const slots = ["narrator:female", "narrator:male", "character:female", "character:male"];
  const pools = { female: [{ id: "F1", name: "Ana" }, { id: "F2", name: "Bea" }], male: [{ id: "M1", name: "Ciro" }] };
  const first = () => 0;
  const cast = pickCast({ slots, set: { "narrator:female": "MINE" }, pools, names: { MINE: "Mía" }, rand: first });
  assert.deepEqual(cast, {
    "narrator:female": { id: "MINE", name: "Mía" },
    "narrator:male": { id: "M1", name: "Ciro" },
    "character:female": { id: "F1", name: "Ana" },
    "character:male": { id: "M1", name: "Ciro" }, // only one man: repeats rather than switching gender
  });
  // Distinct where the pool allows; the draw depends on rand.
  const last = () => 0.999;
  assert.equal(pickCast({ slots: ["narrator:female", "character:female"], pools, rand: last })["character:female"].id, "F1");
  // No pool for a gender: the other gender rather than silence.
  assert.equal(pickCast({ slots: ["character:male"], pools: { female: pools.female }, rand: first })["character:male"].id, "F1");
  assert.deepEqual(pickCast({ slots, pools: {} }), {});
});

test("narrator gender: a pinned unit wins, otherwise the app's draw is stated to the model", () => {
  assert.equal(pinnedNarratorGender(["frame", "narrator-male", "x"]), "male");
  assert.equal(pinnedNarratorGender(["narrator-kids-female"]), "female");
  assert.equal(pinnedNarratorGender(["narrator-native-rotating"]), null);
  assert.equal(pinnedNarratorGender(undefined), null);
  assert.match(narratorDirective("male"), /narrator is a man: tag every narrator line NARRATOR-M/);
  assert.equal(narratorDirective(null), "");
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
  assert.equal(el.init.body.get("language_code"), null, "no language: Scribe detects it");
  const hinted = elevenTranscribeRequest({ key: "K", audio, language: "es-MX", keyterms: ["un kilo", "jitomate"] });
  assert.equal(hinted.init.body.get("language_code"), "es");
  assert.deepEqual(hinted.init.body.getAll("keyterms"), ["un kilo", "jitomate"]);
  assert.equal(elevenTranscribeRequest({ key: "K", audio, language: "not a locale" }).init.body.get("language_code"), null);
  const az = azureTranscribeRequest({ key: "K", region: "eastus", audio, locales: ["es-MX", "en-US", "es-MX", "bogus"] });
  assert.match(az.url, /^https:\/\/eastus\.api\.cognitive\.microsoft\.com\/speechtotext\/transcriptions:transcribe\?api-version=/);
  assert.deepEqual(JSON.parse(az.init.body.get("definition")), { locales: ["es-MX", "en-US"] });
  assert.equal(az.init.headers["Ocp-Apim-Subscription-Key"], "K");
  assert.throws(() => azureTranscribeRequest({ key: "K", region: "evil.com/x", audio, locales: [] }), /region/);
});

test("azureSsml: escapes the text, switches language only on multilingual voices, refuses a bad voice name", () => {
  const ssml = azureSsml({ voice: "zh-CN-XiaoxiaoNeural", text: `<b>"5 & 6"</b>`, locale: "zh-CN" });
  assert.match(ssml, /xml:lang="zh-CN"><voice name="zh-CN-XiaoxiaoNeural">&lt;b&gt;&quot;5 &amp; 6&quot;&lt;\/b&gt;<\/voice>/);
  const multi = azureSsml({ voice: "es-MX-DaliaMultilingualNeural", text: "the market", locale: "en-US" });
  assert.match(multi, /xml:lang="es-MX"><voice name="es-MX-DaliaMultilingualNeural"><lang xml:lang="en-US">the market<\/lang>/);
  assert.doesNotMatch(azureSsml({ voice: "es-MX-JorgeNeural", text: "hi", locale: "en-US" }), /<lang/, "a single-language voice gets no <lang>");
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
    voices: {
      elevenlabs: { "es-MX": { narrator: " v1 ", "character:female": "v3", "character:robot": "v4", wizard: "v2", character: 7 }, "not a locale": { narrator: "x" } },
      bogus: {},
    },
  });
  assert.equal(s.tts, "elevenlabs");
  assert.equal(s.silenceMs, SILENCE_MS.max);
  assert.equal(s.model, "claude-haiku-5-5");
  // The ungendered (pre-gender) narrator choice becomes both narrator slots.
  assert.deepEqual(s.voices, { elevenlabs: { "es-MX": { "narrator:female": "v1", "narrator:male": "v1", "character:female": "v3" } } });
});
