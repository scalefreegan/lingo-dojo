// The streamed voice turn's pure halves (docs/VOICE.md §Streaming the
// reply): reading `claude -p --output-format stream-json` as it arrives
// (scripts/claude.mjs streamJsonReader, buildArgs' stream flags), and handing
// out a reply's spoken lines as each becomes final (scripts/voice.mjs
// replyStream). The rule that matters: a line handed out early is exactly
// the line the whole reply parses to, so what the learner hears first is
// what is stored.
//   node --test scripts/tests/voice-stream.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgs, streamJsonReader } from "../claude.mjs";
import { parseVoiceReply, replyStream } from "../voice.mjs";

/* --------------------------------- argv ---------------------------------- */

test("argv: a streamed run asks for stream-json with the flags the CLI needs for it; a plain run is unchanged", () => {
  const plain = buildArgs({ prompt: "hi", tools: "none" });
  assert.deepEqual(plain.slice(plain.indexOf("--output-format"), plain.indexOf("--output-format") + 2), ["--output-format", "json"]);
  assert.ok(!plain.includes("--verbose") && !plain.includes("--include-partial-messages"));
  const streamed = buildArgs({ prompt: "hi", tools: "none", stream: true });
  const at = streamed.indexOf("--output-format");
  assert.equal(streamed[at + 1], "stream-json");
  // -p refuses stream-json without --verbose; text deltas need the partials.
  assert.ok(streamed.includes("--verbose"));
  assert.ok(streamed.includes("--include-partial-messages"));
  // Still no tools at all for a voice turn.
  assert.equal(streamed[streamed.indexOf("--tools") + 1], "");
  assert.ok(!streamed.includes("--allowedTools"));
});

/* ------------------------------ the reader ------------------------------- */

const ev = (o) => `${JSON.stringify(o)}\n`;
const delta = (text, extra = {}) => ev({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }, parent_tool_use_id: null, ...extra });
const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "NARRATOR-F: Hola.\nCHARACTER-M: ¿Qué tal?", total_cost_usd: 0.01, duration_ms: 900 });

test("reader: text deltas in order, split anywhere (mid-line, mid-character), thinking and subagents left out, the result kept for classifyExit", () => {
  const stream =
    ev({ type: "system", subtype: "init", tools: [] }) +
    ev({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } }) +
    delta("NARRATOR-F: Ho") +
    delta("la.\nCHARACTER-M: ¿Qué") +
    delta(" (a subagent)", { parent_tool_use_id: "toolu_1" }) +
    delta(" tal?") +
    ev({ type: "assistant", message: { content: [{ type: "text", text: "NARRATOR-F: Hola.\nCHARACTER-M: ¿Qué tal?" }] } }) +
    RESULT; // the last line, with no newline after it
  // Chunk boundaries every 7 characters of the decoded text (the server
  // decodes the pipe as utf8, so a chunk never splits a character's bytes).
  const r = streamJsonReader();
  let text = "";
  const chunks = [];
  for (let i = 0; i < stream.length; i += 7) {
    chunks.push(stream.slice(i, i + 7));
    text += r.push(stream.slice(i, i + 7));
  }
  assert.ok(chunks.length > 20);
  assert.equal(text, "NARRATOR-F: Hola.\nCHARACTER-M: ¿Qué tal?", "the result line has no newline yet");
  assert.equal(r.end(), "");
  assert.equal(r.stdout(), RESULT, "classifyExit gets the envelope, as with --output-format json");
});

test("reader: with no result line, stdout is whatever wasn't JSON (an error printed raw), so a failure reads as it did", () => {
  const r = streamJsonReader();
  r.push(delta("NARRATOR-F: Hi"));
  r.push("Error: something broke\n");
  r.end();
  assert.equal(r.stdout(), "Error: something broke\n");
  // A plain `json` envelope (an old CLI, or the tests' fakes) still works.
  const old = streamJsonReader();
  assert.equal(old.push(RESULT), "");
  old.end();
  assert.equal(old.stdout(), RESULT);
});

/* ------------------------------ the lines -------------------------------- */

/** Feed `text` in pieces of `size` characters; every batch handed out, with
 *  how much text had arrived when it was. */
function feed(text, size, mode = "adult", opts = {}) {
  const s = replyStream(mode, opts);
  const out = [];
  for (let i = 0; i < text.length; i += size) {
    const got = s.push(text.slice(i, i + size));
    for (const line of got.lines) out.push({ line, at: Math.min(text.length, i + size), castNotes: got.castNotes });
  }
  return { out, sent: s.sent };
}

const REPLIES = [
  // A narrator line, a CAST, a character, glosses and the rest.
  "NARRATOR-F: Welcome to the market. Try asking for <t>jitomates</t>.\nCAST: CHARACTER-M old, Don Pepe, the vendor\n<pause 1.2> CHARACTER-M: <t>¡Buenos días, güera!\n¿Qué le damos?</t>\nNARRATOR-F: Answer him.\nGLOSS: ¡Buenos días, güera! = Good morning! | güera = blondie\nCHOICES: Keep going | Slow down\nSTAGE: scene:market",
  // An untagged line continues the one before it; a timed line starts its own.
  "NARRATOR-M: First line\nstill the first line\n<overlap 0.4> CHARACTER-F: <t>¡Oiga!</t>\nCHARACTER-F: Second row, same speaker\nand its continuation",
  // A single spoken line, then the glosses: the line is final at the GLOSS.
  "NARRATOR-F: <t>Hola</t>, one line only.\nGLOSS: Hola = Hello",
  // Bold, bullets and a tag split oddly by the model.
  "**NARRATOR-F:** Hola **amigo**\n- CHARACTER-M: <t>Bien</t>.\n\n\nNARRATOR-F: <t>Muy bien</t>.",
];

test("every line handed out early is the whole reply's line at that place, whatever the chunking", () => {
  for (const reply of REPLIES) {
    const whole = parseVoiceReply(reply, "adult");
    for (const size of [1, 2, 3, 5, 8, 13, 50, reply.length]) {
      const { out } = feed(reply, size);
      assert.deepEqual(out.map((o) => o.line), whole.slice(0, out.length), `${JSON.stringify(reply.slice(0, 30))} in ${size}s`);
    }
  }
});

test("the first line goes out as soon as the next has started, long before the reply ends; a lone line at its GLOSS", () => {
  const [market, , single] = REPLIES;
  const { out } = feed(market, 1);
  assert.ok(out.length >= 3, "every spoken line before GLOSS is out by the time GLOSS is");
  // Line 1 is out once the CAST line and the character's line have come in,
  // not at the end.
  assert.ok(out[0].at <= market.indexOf("¿Qué le damos"), `first line at ${out[0].at}`);
  assert.equal(out[0].line.text, "Welcome to the market. Try asking for jitomates.");
  // The character's line carries the CAST note that came before it.
  const pepe = out.find((o) => o.line.speaker === "character");
  assert.deepEqual(pepe.castNotes.map((n) => [n.slot, n.age]), [["character:male", "old"]]);
  // Its <t> wrap spans two text lines: handed out whole.
  assert.equal(pepe.line.text, "¡Buenos días, güera! ¿Qué le damos?");
  const lone = feed(single, 1);
  assert.equal(lone.out.length, 1);
  assert.ok(lone.out[0].at < single.length, "out at the GLOSS line's end, not the reply's");
});

test("a line that may still be continued waits: the last spoken line without a GLOSS after it is the route's, at the end", () => {
  const { out, sent } = feed("NARRATOR-F: Hola.\nmore of it\n", 1);
  assert.equal(out.length, 0);
  assert.equal(sent, 0);
});

test("a LOOKUP before anything went out holds everything back (the route reruns); one after lines went out stops nothing", () => {
  const asking = feed("LOOKUP: market phrases from last week\nNARRATOR-F: One.\nNARRATOR-M: Two.\nNARRATOR-F: Three.\n", 1);
  assert.equal(asking.out.length, 0);
  // Spoken first, then LOOKUP after the first line: the first line was
  // never out (not yet final when the LOOKUP came), so nothing goes.
  assert.equal(feed("NARRATOR-F: One.\nLOOKUP: market\nNARRATOR-M: Two.\nNARRATOR-F: Three.\n", 1).out.length, 0);
  // Lines already out, then a late LOOKUP: the rest still goes.
  const late = feed("NARRATOR-F: One.\nNARRATOR-M: Two.\nLOOKUP: market\nNARRATOR-F: Three.\nGLOSS: x = y\n", 1);
  assert.deepEqual(late.out.map((o) => o.line.text), ["One.", "Two.", "Three."]);
});

test("kids and drill rules are parseVoiceReply's: the sidekick in kids mode, only the narrator in a drill", () => {
  const kids = "NARRATOR-F: Hallo!\nSIDEKICK-M: <t>Hallo, Pip!</t>\nCHARACTER-F: <t>Muh!</t>\nGLOSS: Muh = Moo";
  const k = feed(kids, 2, "kids");
  assert.deepEqual(k.out.map((o) => o.line), parseVoiceReply(kids, "kids"));
  assert.equal(k.out[1].line.speaker, "sidekick");
  const drill = "NARRATOR-F: Say <t>gracias</t>.\nCHARACTER-M: <t>gracias</t>\nGLOSS: gracias = thank you";
  const d = feed(drill, 3, "adult", { drill: true });
  assert.deepEqual(d.out.map((o) => o.line), parseVoiceReply(drill, "adult", { drill: true }));
  assert.ok(d.out.every((o) => o.line.speaker === "narrator"));
  assert.ok(d.out.every((o) => o.castNotes.length === 0), "a drill casts nobody");
});
