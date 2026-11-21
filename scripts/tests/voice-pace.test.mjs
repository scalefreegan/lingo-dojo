// The pace mark's pure halves (ld-9gz, docs/VOICE.md §Pace): the dojo
// master wraps what it says slowly in <slow>…</slow>, the parse carries it
// on the line's segments, the streamed parse hands out the same lines, the
// replay puts the mark back, and each provider's request is asked for its
// own slow setting, inside its documented range. Before this, "slowly" was
// only a word: the text reached the provider with no pace at all.
//   node --test scripts/tests/voice-pace.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { audioKey } from "../audio-cache.mjs";
import {
  AZURE_RATE_RANGE, ELEVEN_SPEED_MODELS, ELEVEN_SPEED_RANGE, SLOW_RATE, azureSpeechRequest, azureSsml, elevenSpeechRequest, markedText, paceOf, parseChoices, parseGlosses,
  parseVoiceReply, replyStream, speechPace, voiceAdapter, voiceTurnPrompt,
} from "../voice.mjs";

const segs = (reply, mode = "adult", opts = {}) => parseVoiceReply(reply, mode, opts).map((l) => l.segments);

/* -------------------------------- the parse ------------------------------- */

test("parse: <slow> marks only the words inside it; the mark is never text; a normal piece has no slow key", () => {
  const [line] = parseVoiceReply("NARRATOR-F: <t>¡Muy bien!</t> One more time, slowly: <slow><t>por favor</t></slow>. Now you.");
  assert.deepEqual(line.segments, [
    { lang: "target", text: "¡Muy bien!" },
    { lang: "native", text: "One more time, slowly:" },
    // The period after the span ends it, as it does after a </t>.
    { lang: "target", text: "por favor.", slow: true },
    { lang: "native", text: "Now you." },
  ]);
  assert.equal(line.text, "¡Muy bien! One more time, slowly: por favor. Now you.");
  assert.ok(!/slow>|<|>/.test(line.text.replace("slowly", "")), "no mark left in the shown text");
});

test("parse: the two marks nest either way round, and a slow span may hold both languages", () => {
  const outside = segs("NARRATOR-F: <slow><t>buenos días</t></slow>");
  const inside = segs("NARRATOR-F: <t><slow>buenos días</slow></t>");
  assert.deepEqual(outside, [[{ lang: "target", text: "buenos días", slow: true }]]);
  assert.deepEqual(inside, outside);
  // Part of a <t> wrap slow: the wrap splits at the change of pace (one
  // synthesis call has one pace).
  assert.deepEqual(segs("CHARACTER-M: <t>Son <slow>veinte pesos</slow>, joven</t>"), [[
    { lang: "target", text: "Son" },
    { lang: "target", text: "veinte pesos,", slow: true },
    { lang: "target", text: "joven" },
  ]]);
  // A whole line, both languages.
  assert.deepEqual(segs("NARRATOR-F: <slow>Listen: <t>gracias</t></slow>"), [[
    { lang: "native", text: "Listen:", slow: true },
    { lang: "target", text: "gracias", slow: true },
  ]]);
  // Same language and pace still merge into one call.
  assert.deepEqual(segs("NARRATOR-F: <slow>uno</slow> <slow>dos</slow> tres"), [[{ lang: "native", text: "uno dos", slow: true }, { lang: "native", text: "tres" }]]);
});

test("parse: spellings a model drifts to are the same mark; an unclosed one runs to the end of its speaker's line, never into the next speaker", () => {
  assert.deepEqual(segs("NARRATOR-F: < slow >hola</ SLOW > and <slowly>adiós</slowly>"), [[
    { lang: "native", text: "hola", slow: true },
    { lang: "native", text: "and" },
    { lang: "native", text: "adiós", slow: true },
  ]]);
  const lines = parseVoiceReply("CHARACTER-F: <slow><t>Despacio\nmuy despacio</t>\nNARRATOR-M: Back to normal.");
  assert.deepEqual(lines.map((l) => l.segments), [
    [{ lang: "target", text: "Despacio muy despacio", slow: true }],
    [{ lang: "native", text: "Back to normal." }],
  ]);
});

test("parse: kids mode and a drill (the narrator alone) carry the mark the same", () => {
  assert.deepEqual(segs("SIDEKICK-F: <slow><t>gato</t></slow>!", "kids"), [[{ lang: "target", text: "gato!", slow: true }]]);
  const drill = parseVoiceReply("CHARACTER-M: Listen: <slow><t>gracias</t></slow>", "adult", { drill: true });
  assert.equal(drill[0].speaker, "narrator");
  assert.deepEqual(drill[0].segments, [{ lang: "native", text: "Listen:" }, { lang: "target", text: "gracias", slow: true }]);
});

test("parse: the mark is dropped from the shown-not-spoken lines", () => {
  const reply = "NARRATOR-F: <slow><t>hola</t></slow>\nGLOSS: <slow>hola</slow> = hello\nCHOICES: <slow>Slow down</slow> | Keep going";
  assert.deepEqual(parseGlosses(reply), [{ term: "hola", meaning: "hello" }]);
  assert.deepEqual(parseChoices(reply), ["Slow down", "Keep going"]);
});

/* ------------------------------- streaming -------------------------------- */

const SLOW_REPLIES = [
  "NARRATOR-F: Listen: <slow><t>gracias</t></slow>. And at normal speed: <t>gracias</t>.\n<pause 1.2> NARRATOR-F: Now you: <slow><t>gracias</t></slow>\nGLOSS: gracias = thank you",
  // A slow wrap that spans two text lines of one speaker, then a new speaker.
  "CHARACTER-M: <slow><t>Son veinte pesos,\njoven.</t></slow>\nNARRATOR-F: He said it slowly for you.\nCHARACTER-M: <t>¿Algo más?</t>\nSTAGE: scene:market",
  "SIDEKICK-F: <t><slow>gato</slow></t>!\nNARRATOR-M: Your turn.\nGLOSS: gato = cat",
];

test("streaming: a line handed out early is the whole reply's line, slow parts included, whatever the chunking", () => {
  for (const reply of SLOW_REPLIES) {
    const mode = reply.startsWith("SIDEKICK") ? "kids" : "adult";
    const whole = parseVoiceReply(reply, mode);
    assert.ok(whole.some((l) => l.segments.some((g) => g.slow)), "the reply has a slow part");
    for (const size of [1, 2, 3, 5, 8, 13, 50, reply.length]) {
      const s = replyStream(mode);
      const out = [];
      for (let i = 0; i < reply.length; i += size) out.push(...s.push(reply.slice(i, i + size)).lines);
      assert.deepEqual(out, whole.slice(0, out.length), `${JSON.stringify(reply.slice(0, 30))} in ${size}s`);
      assert.ok(out.length >= 1 && out.some((l) => l.segments.some((g) => g.slow === true)), "a slow part went out early, marked");
    }
  }
});

/* --------------------------------- replay --------------------------------- */

test("replay: markedText puts the mark back (outside <t>, one per run), and the replayed line parses to the same segments", () => {
  const replies = [
    "NARRATOR-F: <t>¡Muy bien!</t> One more time, slowly: <slow><t>por favor</t></slow>. Now you.",
    "NARRATOR-F: <slow>Listen: <t>gracias</t></slow>",
    "CHARACTER-M: <t>Son <slow>veinte pesos</slow>, joven</t>",
    "NARRATOR-F: no pace here, <t>nada</t>.",
  ];
  for (const reply of replies) {
    const [line] = parseVoiceReply(reply);
    const marked = markedText(line);
    assert.deepEqual(parseVoiceReply(`NARRATOR-F: ${marked}`)[0].segments, line.segments, marked);
  }
  assert.equal(markedText(parseVoiceReply(replies[0])[0]), "<t>¡Muy bien!</t> One more time, slowly: <slow><t>por favor.</t></slow> Now you.");
  assert.equal(markedText(parseVoiceReply(replies[1])[0]), "<slow>Listen: <t>gracias</t></slow>");
  assert.ok(!markedText(parseVoiceReply(replies[3])[0]).includes("slow"));
  // The turn prompt is where the model sees it again.
  const prompt = voiceTurnPrompt([{ role: "master", lines: parseVoiceReply(replies[0]) }], "[direct] slow down");
  assert.match(prompt, /NARRATOR-F: <t>¡Muy bien!<\/t> One more time, slowly: <slow><t>por favor\.<\/t><\/slow> Now you\./);
});

/* -------------------------------- the rules -------------------------------- */

test("rules: every adapter says only <slow> text is slower, to mark whenever it says slowly, and to keep marking after a slow-down request; no example claims a pace it didn't mark", () => {
  for (const [mode, opts] of [["adult", {}], ["adult", { drill: true }], ["kids", {}], ["kids", { drill: true }]]) {
    const text = voiceAdapter(mode, opts);
    assert.match(text, /only the text inside it is spoken slower/);
    assert.match(text, /Never say that something is, was or will be said slowly unless it is inside <slow>/);
    assert.match(text, /Put <slow> outside <t>/);
    assert.match(text, /asks you to slow down[^\n]*from then on, in every turn/);
    // An example line (two spaces, then a tag) that says "slowly" marks it.
    for (const line of text.split("\n").filter((l) => /^ {2}(?:<pause[^>]*> )?[A-Z]+-[FM]:/.test(l) && /slowly/i.test(l))) {
      assert.match(line, /<slow>.+<\/slow>/, line);
    }
  }
  assert.match(voiceAdapter("adult", { drill: true }), /One more time, slowly: <slow><t>por favor<\/t><\/slow>/);
});

/* ------------------------------ the providers ------------------------------ */

test("pace: a word from the client, never a number", () => {
  assert.equal(paceOf(undefined), "normal");
  assert.equal(paceOf("normal"), "normal");
  assert.equal(paceOf("slow"), "slow");
  for (const junk of [0.1, 0.8, "0.8", "fast", "SLOW", "x-slow", true, {}, ["slow"]]) assert.equal(paceOf(junk), null, JSON.stringify(junk));
});

test("speechPace: the provider slows where it can, else the browser does; never both, never for a normal piece", () => {
  assert.ok(SLOW_RATE >= 0.75 && SLOW_RATE <= 0.8);
  for (const p of ["elevenlabs", "azure", "system"]) assert.deepEqual(speechPace(p, "normal", { model: "eleven_flash_v2_5", voice: "es-MX-DaliaNeural" }), { speed: 1, playbackRate: 1 });
  const native = { speed: SLOW_RATE, playbackRate: 1 };
  const browser = { speed: 1, playbackRate: SLOW_RATE };
  assert.deepEqual(speechPace("elevenlabs", "slow", { model: "eleven_flash_v2_5" }), native);
  assert.deepEqual(speechPace("elevenlabs", "slow", { model: "eleven_multilingual_v2" }), native);
  // ElevenLabs: no speed control on v3 or v4 (the app's default model).
  assert.deepEqual(speechPace("elevenlabs", "slow", { model: "eleven_v4" }), browser);
  assert.deepEqual(speechPace("elevenlabs", "slow", { model: "eleven_v3" }), browser);
  assert.deepEqual(speechPace("azure", "slow", { voice: "es-MX-DaliaNeural" }), native);
  // Azure: HD voices have no <prosody>.
  assert.deepEqual(speechPace("azure", "slow", { voice: "en-US-Ava:DragonHDLatestNeural" }), browser);
  assert.deepEqual(speechPace("system", "slow", { voice: "Paulina" }), native);
});

test("cache key: a clip slowed by the provider is its own file; one the browser slows is the normal clip", () => {
  const key = (provider, pace, o) => audioKey({ owner: "u1", provider, voice: o.voice ?? "v", model: o.model ?? "", format: "f", locale: "es-MX", speed: speechPace(provider, pace, o).speed, text: "por favor" });
  const flash = { model: "eleven_flash_v2_5" };
  assert.notEqual(key("elevenlabs", "slow", flash), key("elevenlabs", "normal", flash));
  assert.notEqual(key("azure", "slow", { voice: "es-MX-DaliaNeural" }), key("azure", "normal", { voice: "es-MX-DaliaNeural" }));
  assert.notEqual(key("system", "slow", {}), key("system", "normal", {}));
  assert.equal(key("elevenlabs", "slow", { model: "eleven_v4" }), key("elevenlabs", "normal", { model: "eleven_v4" }));
});

test("ElevenLabs: voice_settings.speed only for a slow piece on a model that takes it, clamped to 0.7–1.2; a normal request is byte for byte the old one", () => {
  const base = { key: "k", voice: "v1", text: "por favor", locale: "es-MX" };
  const body = (o) => JSON.parse(elevenSpeechRequest({ ...base, ...o }).init.body);
  assert.deepEqual(ELEVEN_SPEED_RANGE, [0.7, 1.2]);
  assert.deepEqual(body({ model: "eleven_flash_v2_5", speed: SLOW_RATE }).voice_settings, { speed: SLOW_RATE });
  assert.deepEqual(body({ model: "eleven_multilingual_v2", speed: SLOW_RATE }).voice_settings, { speed: SLOW_RATE });
  assert.equal(body({ model: "eleven_flash_v2_5" }).voice_settings, undefined);
  assert.equal(body({ model: "eleven_flash_v2_5", speed: 1 }).voice_settings, undefined);
  assert.equal(elevenSpeechRequest({ ...base, model: "eleven_flash_v2_5", speed: 1 }).init.body, JSON.stringify({ text: "por favor", model_id: "eleven_flash_v2_5", language_code: "es" }));
  // Out of range is clamped, junk is no speed at all.
  assert.equal(body({ model: "eleven_flash_v2_5", speed: 0.1 }).voice_settings.speed, 0.7);
  assert.equal(body({ model: "eleven_flash_v2_5", speed: 9 }).voice_settings.speed, 1.2);
  assert.equal(body({ model: "eleven_flash_v2_5", speed: "slow" }).voice_settings, undefined);
  assert.equal(body({ model: "eleven_flash_v2_5", speed: Number.NaN }).voice_settings, undefined);
  // Never to a model without speed control.
  for (const model of ["eleven_v4", "eleven_v3"]) {
    assert.ok(!ELEVEN_SPEED_MODELS.includes(model));
    assert.equal(body({ model, speed: SLOW_RATE }).voice_settings, undefined, model);
  }
});

test("Azure: <prosody rate> around the text alone (inside <lang>), clamped to 0.5–2, never for an HD voice or a normal piece", () => {
  assert.deepEqual(AZURE_RATE_RANGE, [0.5, 2]);
  const plain = azureSsml({ voice: "es-MX-DaliaNeural", text: "por favor", locale: "es-MX" });
  assert.ok(!plain.includes("prosody"));
  assert.equal(azureSsml({ voice: "es-MX-DaliaNeural", text: "por favor", locale: "es-MX", speed: 1 }), plain);
  assert.match(azureSsml({ voice: "es-MX-DaliaNeural", text: "a < b", locale: "es-MX", speed: SLOW_RATE }), /<voice name="es-MX-DaliaNeural"><prosody rate="0\.8">a &lt; b<\/prosody><\/voice>/);
  assert.match(
    azureSsml({ voice: "en-US-AvaMultilingualNeural", text: "por favor", locale: "es-MX", speed: SLOW_RATE }),
    /<lang xml:lang="es-MX"><prosody rate="0\.8">por favor<\/prosody><\/lang>/,
  );
  assert.match(azureSsml({ voice: "es-MX-DaliaNeural", text: "x", speed: 0.01 }), /rate="0\.5"/);
  assert.match(azureSsml({ voice: "es-MX-DaliaNeural", text: "x", speed: 50 }), /rate="2"/);
  assert.ok(!azureSsml({ voice: "es-MX-DaliaNeural", text: "x", speed: "junk" }).includes("prosody"));
  assert.ok(!azureSsml({ voice: "en-US-Ava:DragonHDLatestNeural", text: "x", speed: SLOW_RATE }).includes("prosody"));
  assert.match(azureSpeechRequest({ key: "k", region: "eastus", voice: "es-MX-DaliaNeural", text: "x", speed: SLOW_RATE }).init.body, /<prosody rate="0\.8">x<\/prosody>/);
});
