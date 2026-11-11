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
import { oneLine, poolFor, replayStage, retryInOtherVoice, parseChoices, parseGlosses, parseStage, planDirective, sessionPlan, MAX_CHOICES, MAX_GLOSSES, EXPLAIN, JUMP } from "../voice.mjs";
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
  assert.ok(p.trimEnd().endsWith("Reply as the dojo master: tagged lines first (a CAST line just before anyone's first line), then any GLOSS, CHOICES and STAGE lines, in that order."));
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
  assert.equal(d.review, false, "a spoken answer sends itself unless the learner asks to check it");
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

test("GLOSS lines become definitions and are never spoken", () => {
  const reply = [
    "CHARACTER-F: <t>¡Pásele, güero! ¿Qué le doy?</t>",
    "GLOSS: <t>¡Pásele, güero! ¿Qué le doy?</t> = Come on in! What can I get you? | güero = blondie, a friendly nickname | no equals sign | Güero = a duplicate",
  ].join("\n");
  const lines = parseVoiceReply(reply);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "¡Pásele, güero! ¿Qué le doy?");
  assert.deepEqual(parseGlosses(reply), [
    { term: "¡Pásele, güero! ¿Qué le doy?", meaning: "Come on in! What can I get you?" },
    { term: "güero", meaning: "blondie, a friendly nickname" },
  ]);
  // A bold or plural label is still a gloss line, not a narrator line, and
  // so is one with a speaker tag in front.
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\n**GLOSSES:** hola = hi").map((l) => l.text), ["Hi"]);
  // The tag in any case (as TAG_RE takes it), and a timing mark in front.
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\nNarrator-F: GLOSS: hola = hi").map((l) => l.text), ["Hi"]);
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\n**Narrator (F):** GLOSS: hola = hi").map((l) => l.text), ["Hi"]);
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\n<pause 1> STAGE: scene").map((l) => l.text), ["Hi"]);
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\nCHARACTER-F: <pause 1> CHOICES: a | b").map((l) => l.text), ["Hi"]);
  assert.equal(parseGlosses("narrator-f: GLOSS: hola = hi")[0].term, "hola");
  // A bold timing mark inside the tag, and a bulleted label.
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\n**<pause 1> CHARACTER-M:** GLOSS: hola = hi").map((l) => l.text), ["Hi"]);
  assert.equal(parseGlosses("**<pause 1> CHARACTER-M:** GLOSS: hola = hi")[0].term, "hola");
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\n- GLOSS: hola = hi").map((l) => l.text), ["Hi"]);
  assert.equal(parseGlosses("  - GLOSS: hola = hi")[0].term, "hola");
  // The label itself stays upper case: a spoken "Gloss:" is speech.
  assert.deepEqual(parseVoiceReply("Narrator-F: Gloss: that's a word").map((l) => l.text), ["Gloss: that's a word"]);
  assert.equal(parseGlosses("**GLOSSES:** hola = hi")[0].term, "hola");
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\nNARRATOR-M: GLOSS: hola = hi").map((l) => l.text), ["Hi"]);
  assert.equal(parseGlosses("NARRATOR-M: GLOSS: hola = hi")[0].term, "hola");
  // Spoken words that merely start like a label stay speech.
  assert.deepEqual(parseVoiceReply("NARRATOR-F: Two ways to answer.\nOptions: <t>sí</t> or <t>no</t>.\nGloss: that one means yes.").map((l) => l.text), ["Two ways to answer. Options: sí or no. Gloss: that one means yes."]);
  assert.deepEqual(parseGlosses("Gloss: that = this"), []);
  assert.deepEqual(parseGlosses("NARRATOR-M: x = y"), []);
  const many = `GLOSS: ${Array.from({ length: 40 }, (_, i) => `w${i} = m${i}`).join(" | ")}`;
  assert.equal(parseGlosses(many).length, MAX_GLOSSES);
});

test("a turn's glosses go back into the replay", () => {
  const prompt = voiceTurnPrompt(
    [{ role: "master", lines: parseVoiceReply("CHARACTER-F: <t>¿Algo más?</t>"), glosses: [{ term: "¿Algo más?", meaning: "Anything else?" }] }],
    "No, gracias",
  );
  assert.match(prompt, /CHARACTER-F: <t>¿Algo más\?<\/t>\nGLOSS: ¿Algo más\? = Anything else\?/);
  assert.doesNotMatch(voiceTurnPrompt([{ role: "master", lines: parseVoiceReply("NARRATOR-M: Hi") }], "x"), /GLOSS:/);
});

test("CHOICES lines become buttons, are never spoken, and replay", () => {
  const reply = "NARRATOR-M: Nice work. Shall we keep going?\nCHOICES: Keep going | Slow down | keep going | Something harder | One more | Too many";
  assert.deepEqual(parseVoiceReply(reply).map((l) => l.text), ["Nice work. Shall we keep going?"]);
  assert.deepEqual(parseChoices(reply), ["Keep going", "Slow down", "Something harder", "One more"]);
  assert.equal(parseChoices(reply).length, MAX_CHOICES);
  assert.deepEqual(parseChoices("NARRATOR-M: no choices here"), []);
  assert.deepEqual(parseChoices("OPTIONS: Yes | No"), ["Yes", "No"], "the older OPTIONS label still counts");
  const prompt = voiceTurnPrompt([{ role: "master", lines: parseVoiceReply(reply), choices: ["Keep going", "Slow down"] }], "[direct] Keep going");
  assert.match(prompt, /\nCHOICES: Keep going \| Slow down\n/);
});

test("the adapter explains Explain and choices", () => {
  const a = voiceAdapter("adult");
  assert.ok(a.includes(`"${EXPLAIN}"`));
  assert.match(a, /CHOICES: Keep going \| Slow down/);
});

test("sessionPlan: intro, warm-ups, the scene and its beats, then the debrief", () => {
  const content = {
    units: [
      { id: "intro-native", slot: "intro", title: "Open in the native language" },
      { id: "warmup-phrases", slot: "warmup", title: "Phrase warm-up" },
      { id: "warmup-greetings", slot: "warmup", title: "Greetings warm-up" },
      { id: "correct-gently", slot: "corrections", title: "Gentle" },
      { id: "debrief-top-three", slot: "debrief", title: "Top three" },
    ],
    scenarios: [{ id: "market", title: "The market", beats: ["Arriving at the stall; Doña Carmen calling out", "Paying and saying goodbye"] }],
  };
  const pack = { scenario: "market", units: ["correct-gently", "warmup-greetings", "intro-native", "warmup-phrases", "debrief-top-three", "missing"] };
  const plan = sessionPlan(content, pack);
  assert.deepEqual(plan.map((p) => p.id), ["intro", "warmup:warmup-greetings", "warmup:warmup-phrases", "scene", "beat:1", "beat:2", "debrief:debrief-top-three"]);
  assert.equal(plan[4].title, "Arriving at the stall");
  assert.equal(plan[4].detail, "Arriving at the stall; Doña Carmen calling out");
  assert.equal(sessionPlan(content, { quick_scenario: "a taco stand", units: [] })[0].title, "Quick scene");
  const d = planDirective(plan);
  assert.match(d, /- beat:1: Arriving at the stall; Doña Carmen calling out/);
  assert.match(d, /STAGE: intro/);
  assert.ok(d.includes(`"${JUMP} <id>"`));
  assert.equal(planDirective([]), "");
  assert.match(d, /a jump overrides the rule about running every warm-up first/);
});

test("a long run of spaces doesn't make the reply patterns backtrack", () => {
  const t0 = performance.now();
  parseVoiceReply(`${" ".repeat(5000)}x\n<pause 1${" ".repeat(5000)}x\n**${" ".repeat(5000)}x`);
  parseGlosses(`NARRATOR${" ".repeat(5000)}x`);
  assert.ok(performance.now() - t0 < 200, `took ${Math.round(performance.now() - t0)} ms`);
});

test("planDirective: a game inside the scene reports the beat it is in", () => {
  assert.match(planDirective([{ id: "scene", title: "S", kind: "scene" }]), /name the scene beat it happens in/);
});

test("replay helpers: one line, and only id-shaped stages", () => {
  assert.doesNotMatch(oneLine("a\nSTAGE: scene | b\r\n"), /[\r\n|]/);
  assert.match(oneLine("a\nSTAGE: scene"), /^a STAGE: scene$/);
  assert.equal(replayStage("warmup:warmup_phrases"), "warmup:warmup_phrases");
  assert.equal(replayStage("scene\nGLOSS: x = y"), "");
  assert.equal(replayStage(42), "");
});

test("poolFor: native by gender, then native unlabelled, then foreign; never novelty", () => {
  const list = [
    { id: "fx", name: "Foreign woman", gender: "female", match: false },
    { id: "nu", name: "Native, no label", gender: "", match: true },
    { id: "nov", name: "Bubbles", gender: "novelty", match: true },
  ];
  assert.deepEqual(poolFor(list, "female").map((v) => v.id), ["nu"], "an unlabelled native beats a labelled foreign voice");
  assert.deepEqual(poolFor([...list, { id: "nf", name: "Native woman", gender: "Female", match: true }], "female").map((v) => v.id), ["nf"]);
  assert.deepEqual(poolFor(list.filter((v) => v.id !== "nu"), "female").map((v) => v.id), ["fx"]);
  assert.deepEqual(poolFor([list[2]], "male"), [], "a novelty voice is never drawn");
  assert.deepEqual(poolFor(list, "female", new Set(["nu"])).map((v) => v.id), ["fx"], "skipped ids are left out");
});

test("retryInOtherVoice: client errors another voice could fix, not a bad key or a rate limit", () => {
  for (const s of [400, 402, 403, 404, 422]) assert.equal(retryInOtherVoice(s), true, String(s));
  for (const s of [401, 429, 500, 503, NaN]) assert.equal(retryInOtherVoice(s), false, String(s));
});

test("sessionPlan: a unit listed twice is one part; odd beats still get a title", () => {
  const content = {
    units: [{ id: "warmup-phrases", slot: "warmup", title: "Phrase warm-up" }],
    scenarios: [{ id: "s", title: "S", beats: ["— Paying up", "Two\nlines; more"] }],
  };
  const plan = sessionPlan(content, { scenario: "s", units: ["warmup-phrases", "warmup-phrases"] });
  assert.deepEqual(plan.map((p) => p.id), ["warmup:warmup-phrases", "scene", "beat:1", "beat:2"]);
  assert.equal(plan[2].title, "Paying up");
  assert.equal(plan[3].title, "Two lines");
  assert.equal(plan[3].detail, "Two lines; more");
});

test("sessionPlan (kids): the opener game before the story, the others at its start", () => {
  const content = {
    units: [
      { id: "intro-game", slot: "intro", title: "Intro" },
      { id: "game-echo", slot: "games", title: "Echo game", tags: ["games", "opener"] },
      { id: "game-counting", slot: "games", title: "Counting game", tags: ["games"] },
      { id: "ending-sleepy", slot: "ending", title: "Sleepy ending" },
    ],
    scenarios: [{ id: "farm", title: "The farm", beats: ["Meeting the cow"] }],
  };
  const plan = sessionPlan(content, { scenario: "farm", units: ["game-counting", "game-echo", "intro-game", "ending-sleepy"] }, "kids");
  assert.deepEqual(plan.map((p) => p.id), ["intro", "games:game-echo", "scene", "games:game-counting", "beat:1", "ending:ending-sleepy"]);
});

test("parseStage: only a known part id counts, the last one wins", () => {
  const ids = ["intro", "warmup:warmup-phrases", "scene"];
  assert.equal(parseStage("NARRATOR-F: Hi\nSTAGE: warmup:warmup-phrases", ids), "warmup:warmup-phrases");
  assert.equal(parseStage("STAGE: intro\nSTAGE: **scene**", ids), "scene");
  assert.equal(parseStage("STAGE: beat:9", ids), null);
  assert.equal(parseStage("Stage: scene", ids), null, "a spoken 'Stage:' is not a stage line");
  assert.equal(parseStage("STAGE: scene.", ids), "scene");
  assert.equal(parseStage("STAGE: `scene`", ids), "scene");
  assert.deepEqual(parseVoiceReply("NARRATOR-F: Hi\nSTAGE: scene").map((l) => l.text), ["Hi"]);
  assert.match(voiceTurnPrompt([{ role: "master", lines: parseVoiceReply("NARRATOR-F: Hi"), stage: "scene" }], "x"), /NARRATOR-F: Hi\nSTAGE: scene/);
});

test("pinnedNarratorGender: a user-made narrator unit naming a gender counts", () => {
  assert.equal(pinnedNarratorGender(["narrator-female-slow"]), "female");
  assert.equal(pinnedNarratorGender(["narrator-kids-male"]), "male");
  assert.equal(pinnedNarratorGender(["narrator-native-rotating"]), null);
});

test("systemVoices: known macOS voices carry their gender", () => {
  const list = "Paulina             es_MX    # Hola\nEddy (Spanish (Mexico)) es_MX    # Hola\nNovelty             es_MX    # Hola";
  assert.deepEqual(systemVoices(list, "es-MX").map((v) => [v.name, v.gender]), [["Paulina", "female"], ["Eddy (Spanish (Mexico))", "male"], ["Novelty", ""]]);
  assert.equal(systemVoices("Albert              en_US    # Hello", "en-US")[0].gender, "novelty", "a sound-effect voice is never a man's or woman's voice");
});

/* ------------------------- round 7: written first -------------------------- */

import { ageOf, castFallbacks, parseCast, speechVoices } from "../voice.mjs";

const fast = (fn, ms = 250) => {
  const t0 = performance.now();
  fn();
  const took = performance.now() - t0;
  assert.ok(took < ms, `took ${Math.round(took)} ms`);
};

test("reply parsing stays fast on lines padded with spaces (the costly shapes)", () => {
  const sp = (n) => " ".repeat(n);
  const reply = Array.from({ length: 10 }, () => `<pause 1>${sp(190)}x`).join("\n");
  fast(() => {
    parseVoiceReply(reply);
    parseGlosses(reply);
    parseChoices(reply);
    parseStage(reply, ["scene"]);
    parseCast(reply);
  });
  fast(() => parseVoiceReply(`NARRATOR-F${sp(5000)}x`));
  fast(() => parseVoiceReply(`**<pause 1>${sp(300)}**${sp(300)}NARRATOR${sp(300)}x`));
});

test("hidden lines: wider timing marks before the label are still hidden", () => {
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\n<  pause 1> GLOSS: hola = hi").map((l) => l.text), ["Hi"]);
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\n<pause 1.5 while she weighs them> STAGE: scene").map((l) => l.text), ["Hi"]);
});

test("a bulleted speaker tag is still a tag, before or after a timing mark", () => {
  const a = parseVoiceReply("CHARACTER-M: <t>Hola</t>\n- NARRATOR-F: Now you try.");
  assert.deepEqual(a.map((l) => [l.speaker, l.gender, l.text]), [["character", "male", "Hola"], ["narrator", "female", "Now you try."]]);
  const b = parseVoiceReply("NARRATOR-F: Hi\n- <pause 1.5> CHARACTER-M: <t>Hola</t>");
  assert.deepEqual(b.map((l) => [l.speaker, l.text]), [["narrator", "Hi"], ["character", "Hola"]]);
});

test("timing marks in other spellings are never read out", () => {
  for (const mark of ["<pause 1.5 seconds>", "<pause: 1.5>", "<pause=1.5>"]) {
    const [, line] = parseVoiceReply(`NARRATOR-F: Hi\n${mark} CHARACTER-F: <t>Hola</t>`);
    assert.equal(line.text, "Hola", mark);
    assert.equal(line.gap, 1.5, mark);
  }
});

test("retryInOtherVoice: only the statuses that mean this voice can't be used", () => {
  for (const s of [408, 409, 413]) assert.equal(retryInOtherVoice(s), false, String(s));
});

test("planDirective: a scene with no beats is reported as the scene", () => {
  assert.match(planDirective([{ id: "scene", title: "S", kind: "scene" }]), /or scene/);
});

test("speechVoices: a refused cast voice falls back to the exact saved slot, then the cast fallback, then a borrowed voice", () => {
  const refused = new Set();
  // Only a narrator woman saved: a male vendor's refused line goes to the
  // man's account fallback, not the narrator's voice.
  const set = { "narrator:female": "NARR_F" };
  assert.deepEqual(speechVoices({ set, speaker: "character", gender: "male", cast: "LIB_M", fallback: "ACC_M", refused }), { first: "LIB_M", retry: "ACC_M" });
  // The exact slot saved wins over the fallback.
  assert.deepEqual(speechVoices({ set: { "character:male": "MINE" }, speaker: "character", gender: "male", cast: "LIB_M", fallback: "ACC_M", refused }), { first: "LIB_M", retry: "MINE" });
  // Nothing exact and no fallback: borrow, as before.
  assert.deepEqual(speechVoices({ set, speaker: "character", gender: "male", cast: "LIB_M", fallback: "", refused }), { first: "LIB_M", retry: "NARR_F" });
  // Once refused, straight to the retry voice, with no second retry.
  assert.deepEqual(speechVoices({ set, speaker: "character", gender: "male", cast: "LIB_M", fallback: "ACC_M", refused: new Set(["LIB_M"]) }), { first: "ACC_M", retry: "" });
  // No cast: the saved voice (borrowing), else the fallback; nothing to retry.
  assert.deepEqual(speechVoices({ set, speaker: "character", gender: "male", cast: null, fallback: "ACC_M", refused }), { first: "NARR_F", retry: "" });
  assert.deepEqual(speechVoices({ set: {}, speaker: "character", gender: "male", cast: null, fallback: "ACC_M", refused }), { first: "ACC_M", retry: "" });
});

test("castFallbacks: a distinct account voice per slot, premade first, set voices kept out", () => {
  const own = [
    { id: "lib_f", name: "Added Carmen", gender: "female", match: true, premade: false, age: "" },
    { id: "pre_f1", name: "Sarah", gender: "female", match: false, premade: true, age: "young" },
    { id: "pre_f2", name: "Lily", gender: "female", match: false, premade: true, age: "middle" },
    { id: "pre_m", name: "George", gender: "male", match: false, premade: true, age: "middle" },
  ];
  const fb = castFallbacks(own, ["narrator:female", "character:female", "narrator:male", "character:male"], {});
  assert.ok(["pre_f1", "pre_f2"].includes(fb["narrator:female"]));
  assert.ok(["pre_f1", "pre_f2"].includes(fb["character:female"]));
  assert.notEqual(fb["narrator:female"], fb["character:female"], "two women never share a fallback when the account has two");
  assert.equal(fb["narrator:male"], "pre_m");
  const kept = castFallbacks(own, ["character:female"], { "narrator:female": "pre_f1" });
  assert.equal(kept["character:female"], "pre_f2", "a voice the learner set for another slot isn't reused");
});

test("ageOf: provider labels to the four ages", () => {
  assert.equal(ageOf("young"), "young");
  assert.equal(ageOf("middle aged"), "middle");
  assert.equal(ageOf("middle_aged"), "middle");
  assert.equal(ageOf("Old"), "old");
  assert.equal(ageOf("child"), "child");
  assert.equal(ageOf("elderly"), "old");
  assert.equal(ageOf(""), "");
  assert.equal(ageOf("whatever"), "");
});

test("poolFor with an age: that age first, then the nearest, never dropping the gender rule", () => {
  const list = [
    { id: "y", name: "Y", gender: "female", match: true, age: "young" },
    { id: "m", name: "M", gender: "female", match: true, age: "middle" },
    { id: "o", name: "O", gender: "female", match: true, age: "old" },
    { id: "om", name: "OM", gender: "male", match: true, age: "old" },
  ];
  assert.deepEqual(poolFor(list, "female", new Set(), "old").map((v) => v.id), ["o"]);
  assert.deepEqual(poolFor(list.filter((v) => v.id !== "o"), "female", new Set(), "old").map((v) => v.id), ["m"], "nearest age when none is old");
  assert.deepEqual(poolFor(list, "female", new Set(), "child").map((v) => v.id), ["y"], "a child is matched by the youngest voices");
  assert.equal(poolFor(list, "female", new Set(), "old")[0].age, "old", "the pool keeps the age");
});

test("parseCast: CAST lines say who each tag now is; never spoken", () => {
  const reply = [
    "NARRATOR-F: Let's go to the market.",
    "CAST: CHARACTER-F old, Doña Carmen, the fruit vendor",
    "**CAST:** character-m | young | Beto, her grandson",
    "CAST: SIDEKICK-F middle-aged, a neighbour",
    "CAST: CHARACTER teenager, no gender so ignored",
    "CHARACTER-F: <t>¡Pásele!</t>",
  ].join("\n");
  assert.deepEqual(parseCast(reply, "adult"), [
    { slot: "character:female", age: "old", who: "Doña Carmen, the fruit vendor" },
    { slot: "character:male", age: "young", who: "Beto, her grandson" },
  ], "a sidekick doesn't exist in adult mode; a tag without a gender is dropped");
  assert.equal(parseCast(reply, "kids").find((n) => n.slot === "sidekick:female").age, "middle");
  assert.deepEqual(parseVoiceReply(reply).map((l) => l.text), ["Let's go to the market.", "¡Pásele!"]);
  // A later note for the same slot wins; ages in words map too.
  assert.deepEqual(parseCast("CAST: CHARACTER-F young, A\nCAST: CHARACTER-F elderly, B"), [{ slot: "character:female", age: "old", who: "B" }]);
});

test("the CAST line goes back in the replay, and the adapter asks for it", () => {
  const prompt = voiceTurnPrompt([{ role: "master", lines: parseVoiceReply("CHARACTER-F: <t>Hola</t>"), castNotes: [{ slot: "character:female", age: "old", who: "Doña Carmen" }] }], "x");
  assert.match(prompt, /\nCAST: CHARACTER-F old, Doña Carmen\n/);
  assert.match(voiceAdapter("adult"), /CAST: CHARACTER-F old, Doña Carmen/);
});

test("voice lists carry ages where the provider says", () => {
  const json = { voices: [{ voice_id: "a1", name: "Rosa", category: "premade", labels: { gender: "female", age: "old", language: "es" } }] };
  const [row] = elevenVoices(json, "es-MX");
  assert.equal(row.age, "old");
  assert.equal(row.premade, true);
  assert.equal(systemVoices("Grandma (Spanish (Mexico)) es_MX    # Hola", "es-MX")[0].age, "old");
  assert.equal(elevenLibraryRequest({ key: "k", locale: "es-MX", age: "old" }).url.includes("age=old"), true);
  assert.equal(elevenLibraryRequest({ key: "k", locale: "es-MX", age: "middle" }).url.includes("age=middle_aged"), true);
});

test("pickCast for a recast: the slot's own aged pool, avoiding voices playing other slots", () => {
  const pools = {
    female: [{ id: "F1", name: "Ana" }],
    "character:female": [{ id: "OLD1", name: "Doña", age: "old" }, { id: "OLD2", name: "Abuela", age: "old" }],
  };
  const first = () => 0;
  assert.deepEqual(pickCast({ slots: ["character:female"], pools, avoid: ["OLD1"], rand: first }), { "character:female": { id: "OLD2", name: "Abuela", age: "old" } });
  // A voice the learner set keeps it, with its age when the list knows it.
  assert.deepEqual(pickCast({ slots: ["character:female"], set: { "character:female": "MINE" }, pools, names: { MINE: "Mía" }, ages: { MINE: "young" } }), { "character:female": { id: "MINE", name: "Mía", age: "young" } });
});

/* ------------------------- round 8: written first -------------------------- */

import { castPools, replayCastNotes } from "../voice.mjs";

test("timing marks run together with their number still time the line, never spoken", () => {
  const gaps = (s) => parseVoiceReply(s).map((l) => [l.text, l.gap ?? null]);
  assert.deepEqual(gaps("NARRATOR-F: Hi\n<pause1.5> CHARACTER-F: <t>Hola</t>"), [["Hi", null], ["Hola", 1.5]]);
  assert.deepEqual(gaps("NARRATOR-F: Hi\n<overlap0.4>CHARACTER-F: <t>Hola</t>"), [["Hi", null], ["Hola", -0.4]]);
  assert.deepEqual(gaps("NARRATOR-F: Hi\n<pause2s> CHARACTER-F: <t>Hola</t>"), [["Hi", null], ["Hola", 2]]);
  assert.deepEqual(gaps("NARRATOR-F: Hi\n<pause .5> CHARACTER-F: <t>Hola</t>"), [["Hi", null], ["Hola", 0.5]]);
  assert.deepEqual(gaps("NARRATOR-F: Hi\n<pause 800ms> CHARACTER-F: <t>Hola</t>"), [["Hi", null], ["Hola", 0.8]]);
  assert.deepEqual(gaps("NARRATOR-F: Hi\n<pause 1,5> CHARACTER-F: <t>Hola</t>"), [["Hi", null], ["Hola", 1.5]]);
  // A word that only starts like one isn't a mark.
  assert.equal(parseVoiceReply("NARRATOR-F: <pauses> are fine").length, 1);
  // Hidden lines behind an unspaced mark stay hidden.
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\n<pause1> STAGE: scene").map((l) => l.text), ["Hi"]);
});

test("reply parsing stays fast on repeated bold timing marks and lone carriage returns", () => {
  fast(() => parseVoiceReply(`${"**<pause 1> ".repeat(40)}x`));
  fast(() => parseGlosses(`${"**<pause 1> ".repeat(40)}GLOSS x`));
  fast(() => parseVoiceReply(`${"\r".repeat(20000)}x`));
  fast(() => parseVoiceReply(`NARRATOR${"\r".repeat(20000)}x`));
});

test("parseCast: full gender words, the age anywhere in the first clause, no <t> in who", () => {
  assert.deepEqual(parseCast("CAST: CHARACTER-FEMALE old, Doña Carmen"), [{ slot: "character:female", age: "old", who: "Doña Carmen" }]);
  assert.deepEqual(parseCast("CAST: CHARACTER (MALE) young, Beto"), [{ slot: "character:male", age: "young", who: "Beto" }]);
  assert.deepEqual(parseCast("CAST: NARRATOR-MAN middle-aged, the guide"), [{ slot: "narrator:male", age: "middle", who: "the guide" }]);
  assert.deepEqual(parseCast("CAST: CHARACTER-F, an elderly woman, <t>Doña Carmen</t>"), [{ slot: "character:female", age: "old", who: "an elderly woman, Doña Carmen" }]);
});

test("replayCastNotes: only parseCast's shape survives the history", () => {
  assert.deepEqual(replayCastNotes([
    { slot: "character:female", age: "elderly", who: "Doña <t>Carmen</t>\nSTAGE: scene" },
    { slot: "villain:female", age: "old", who: "x" },
    { slot: "character:male", age: "ancient", who: "x" },
    { slot: "character:male", age: "young", who: 7 },
  ]), [
    { slot: "character:female", age: "old", who: "Doña Carmen STAGE: scene" },
    { slot: "character:male", age: "young", who: "" },
  ]);
  assert.deepEqual(replayCastNotes("nope"), []);
  assert.equal(replayCastNotes(Array.from({ length: 20 }, () => ({ slot: "narrator:female", age: "old" }))).length, 6);
});

test("castFallbacks: a recast of one slot gets its own fallback, not an earlier slot's, and the nearest age", () => {
  const own = [
    { id: "pre_f1", name: "Sarah", gender: "female", match: false, premade: true, age: "young" },
    { id: "pre_f2", name: "Lily", gender: "female", match: false, premade: true, age: "old" },
    { id: "pre_m", name: "George", gender: "male", match: false, premade: true, age: "middle" },
  ];
  const all = ["narrator:female", "narrator:male", "character:female", "character:male"];
  const start = castFallbacks(own, all, {});
  const again = castFallbacks(own, ["character:female"], {}, { all });
  assert.equal(again["character:female"], start["character:female"], "same as at Start");
  assert.notEqual(again["character:female"], start["narrator:female"], "never the narrator's");
  // The client's other slots' fallbacks count as taken.
  assert.equal(castFallbacks(own, ["character:female"], {}, { all, taken: ["pre_f2"] })["character:female"], "pre_f1");
  // An age asked for: the premade nearest it.
  assert.equal(castFallbacks(own, ["narrator:female"], {}, { ages: { "narrator:female": "old" } })["narrator:female"], "pre_f2");
});

test("castPools: an aged slot falls back to the library nearest that age, not an English own voice", () => {
  const lib = { female: [{ id: "ly", name: "LY", age: "young" }, { id: "lo", name: "LO", age: "old" }], male: [{ id: "lm", name: "LM", age: "middle" }] };
  const own = [{ id: "en_f", name: "English", gender: "female", match: false, age: "young" }];
  const slots = ["character:female"];
  // The aged search came back empty: the gender's library voices nearest old.
  assert.deepEqual(castPools({ slots, ages: { "character:female": "old" }, library: lib, aged: { "character:female": [] }, own, recast: true }).pools["character:female"].map((v) => v.id), ["lo"]);
  // The aged search worked: it wins.
  assert.deepEqual(castPools({ slots, ages: { "character:female": "old" }, library: lib, aged: { "character:female": [{ id: "a1", name: "A1", age: "old" }] }, own }).pools["character:female"].map((v) => v.id), ["a1"]);
  // Both searches failed in a recast: the slot is left out, the client keeps its voice.
  const failed = castPools({ slots, ages: { "character:female": "old" }, library: { female: null }, aged: { "character:female": null }, own, recast: true });
  assert.deepEqual(failed.omitted, ["character:female"]);
  // ...but a full draw still gets a voice.
  assert.deepEqual(castPools({ slots, ages: { "character:female": "old" }, library: { female: null }, aged: { "character:female": null }, own }).pools["character:female"].map((v) => v.id), ["en_f"]);
  // Azure / macOS: no library at all, own voices nearest the age.
  assert.deepEqual(castPools({ slots, ages: { "character:female": "old" }, own, recast: true }).omitted, []);
  // A set slot is never drawn or omitted.
  assert.deepEqual(castPools({ slots, set: { "character:female": "mine" }, ages: { "character:female": "old" }, library: { female: null }, aged: {}, own, recast: true }).omitted, []);
});

test("the [direct] reply follows the guidance language, as help and explain do", () => {
  assert.match(voiceAdapter("adult"), /\[direct\][^\n]*Reply as the narrator, in the language your instructions say to guide in/);
});

/* ------------------------- round 9: written first -------------------------- */

test("castFallbacks as the server calls a recast (all + taken): the slot's own fallback, never another slot's", () => {
  const own = [
    { id: "f1", name: "F1", gender: "female", match: false, premade: true, age: "young" },
    { id: "f2", name: "F2", gender: "female", match: false, premade: true, age: "old" },
    { id: "m1", name: "M1", gender: "male", match: false, premade: true, age: "middle" },
    { id: "m2", name: "M2", gender: "male", match: false, premade: true, age: "old" },
  ];
  const all = ["narrator:female", "narrator:male", "character:female", "character:male"];
  const start = castFallbacks(own, all, {});
  assert.equal(start["narrator:female"], "f1");
  assert.equal(start["character:female"], "f2");
  for (const age of ["young", "middle", "old"]) {
    const fb = castFallbacks(own, ["character:female"], {}, { all, ages: { "character:female": age }, taken: ["f1"] });
    assert.equal(fb["character:female"], "f2", `a ${age} recast keeps off the narrator's f1`);
  }
  // The only old man keeps the old character, as at Start.
  const startOld = castFallbacks(own, all, {}, { ages: { "character:male": "old" } });
  assert.equal(castFallbacks(own, ["character:male"], {}, { all, ages: { "character:male": "old" }, taken: [startOld["narrator:male"]] })["character:male"], "m2");
});

test("castPools: voices playing other slots are left out before narrowing by age", () => {
  const library = { female: [{ id: "N", name: "N", age: "old" }, { id: "M", name: "M", age: "middle" }, { id: "Y", name: "Y", age: "young" }] };
  const { pools } = castPools({ slots: ["character:female"], ages: { "character:female": "old" }, library, aged: { "character:female": [] }, own: [], recast: true, avoid: ["N"] });
  assert.deepEqual(pools["character:female"].map((v) => v.id), ["M"], "the next-nearest free voice, not the narrator's");
  const aged = castPools({ slots: ["character:female"], ages: { "character:female": "old" }, library, aged: { "character:female": [{ id: "N", name: "N", age: "old" }, { id: "O2", name: "O2", age: "old" }] }, own: [], avoid: ["N"] });
  assert.deepEqual(aged.pools["character:female"].map((v) => v.id), ["O2"]);
  const pick = pickCast({ slots: ["character:female"], pools, avoid: ["N"], rand: () => 0 });
  assert.equal(pick["character:female"].id, "M");
});

test("parseCast: the age is the person's, not a word inside someone else's", () => {
  const age = (s) => parseCast(`CAST: CHARACTER-F ${s}`)[0]?.age ?? "";
  assert.equal(age("the girl's mother, Doña Ana"), "");
  assert.equal(age("the boy's grandfather"), "");
  assert.equal(age("Mr Young, the baker"), "");
  assert.equal(age("an elderly woman, Doña Carmen"), "old");
  assert.equal(age("a little girl, Sofía"), "child");
  assert.equal(age("middle aged, the guide"), "middle");
  assert.equal(age("old, Doña Carmen"), "old");
  assert.deepEqual(parseCast("CAST: CHARACTER-F Little Red, a girl"), []);
});

test("parseCast stays fast on a long line with no commas", () => {
  fast(() => parseCast(`CAST: CHARACTER-F ${"word ".repeat(16000)}`));
});

test("timing marks: milliseconds spelled out, thousands separators, long marks, pausa", () => {
  const gap = (mark) => parseVoiceReply(`NARRATOR-F: Hi\n${mark} CHARACTER-F: <t>Hola</t>`).map((l) => [l.speaker, l.text, l.gap ?? null])[1];
  assert.deepEqual(gap("<pause 500 milliseconds>"), ["character", "Hola", 0.5]);
  assert.deepEqual(gap("<pause 500 msec>"), ["character", "Hola", 0.5]);
  assert.deepEqual(gap("<pause 1,500ms>"), ["character", "Hola", 1.5]);
  assert.deepEqual(gap("<pause 1.5 seconds while she weighs the tomatoes slowly>"), ["character", "Hola", 1.5]);
  assert.deepEqual(gap("<pausa 1>"), ["character", "Hola", 1]);
  assert.deepEqual(parseVoiceReply("NARRATOR-M: Hi\n<pausa 1> STAGE: scene").map((l) => l.text), ["Hi"]);
});
