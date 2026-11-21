// The word game's pictures with Black Forest Labs, the shared stock set and
// the one picture theme (ld-6k7; docs/DATA.md §Kids word game): which
// provider the keys pick; BFL's submit, poll, download, timeout,
// moderation, 402 and a polling address off bfl.ai; a word the check
// matches to a stock picture made ready with no image call and no ledger
// row; a made-up stock id ignored; stock files never deleted by a word's
// remove, redraw or delete, and fetched like any picture (own learner
// only); the game with no image key; Redraw all in the current style.
// The real plugin on an in-process PGlite with a stand-in `claude` and
// both image APIs stubbed in fetch: nothing here reaches a model or a
// provider. Every name and key here is made up.
//   node --test scripts/tests/pictures-bfl-stock.http.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serveApi } from "./connect-stack.mjs";
import { fakeClaude } from "./fake-claude.mjs";
import { copyFixture } from "./helpers.mjs";
import { KID, addUser, client } from "./http-session.mjs";
import { freshDb } from "./testdb.mjs";

const root = copyFixture();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-data-"));
const imagesDir = path.join(dataDir, "images");
process.env.LINGO_CONTENT_DIR = root;
process.env.LINGO_DATA_DIR = dataDir;
process.env.LINGO_ENV_FILE = path.join(dataDir, "test.env");
const BFL_KEY = "bfl-test-not-a-real-key";
const OPENAI_KEY = "sk-test-not-a-real-key";
const BFL_ONLY = `BFL_API_KEY=${BFL_KEY}\n`;
const BOTH = `BFL_API_KEY=${BFL_KEY}\nOPENAI_API_KEY=${OPENAI_KEY}\n`;
const OPENAI_ONLY = `OPENAI_API_KEY=${OPENAI_KEY}\n`;
fs.writeFileSync(process.env.LINGO_ENV_FILE, BFL_ONLY);
for (const k of ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "OPENAI_API_KEY", "BFL_API_KEY", "LINGO_IMAGE_PROVIDER", "LINGO_IMAGES_DIR"]) delete process.env[k];

const { apiPlugins } = await import("../../web/server/api.ts");
const { resetPictureMemory, settlePictureFills } = await import("../../web/server/pictures.ts");
const { settleExtractions } = await import("../../web/server/extraction.ts");
const { placeholderPng, imageProvider, bflFetch, BFL_IMAGE, BFL_TIMING, OPENAI_IMAGE } = await import("../../web/server/imageProvider.ts");
const { PICTURE_THEME, stockKey } = await import("../pictures.mjs");
const { writeStockPicture } = await import("../picture-store.mjs");

const fake = fakeClaude();

/* Both image APIs, stubbed. BFL: the submit, the polling URL it hands
 * back, and the signed download. `bfl.mode`: "ok", "slow" (Pending
 * forever), "moderated" (Content Moderated), "credits" (402 on submit),
 * "offhost" (a polling address off bfl.ai). Every request is recorded with
 * the key it carried. */
const POLL = "https://api.us1.bfl.ai/v1/get_result?id=";
const SAMPLE = "https://delivery-us1.bfl.ai/results/";
const realFetch = globalThis.fetch;
// `sample`: a Ready reply's picture address instead of the usual one;
// `fail`: a submit whose prompt matches ends with status Error.
const bfl = { mode: "ok", submits: [], polls: [], downloads: [], offhost: [], pending: 2, sample: null, fail: null, failing: new Set() };
// `fail`: a request whose prompt matches answers 500.
const openai = { calls: [], fail: null };
// Addresses no BFL request may reach (a sample off bfl.ai, or over http).
const OFF_BFL = ["https://evil.example.com", "https://localhost", "https://other.example.com", "http://delivery-us1.bfl.ai"];
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpeg ${n}`)]);
const state = new Map();
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const key = init.headers?.["x-key"] ?? null;
  if (u === BFL_IMAGE.url) {
    const body = JSON.parse(init.body);
    bfl.submits.push({ body, key, redirect: init.redirect });
    if (bfl.mode === "credits") return new Response(JSON.stringify({ detail: `Insufficient credits for ${body.prompt}` }), { status: 402 });
    const id = `task${bfl.submits.length}`;
    state.set(id, 0);
    if (bfl.fail?.test(body.prompt)) bfl.failing.add(id);
    const polling_url = bfl.mode === "offhost" ? `https://evil.example.com/get_result?id=${id}` : POLL + id;
    return new Response(JSON.stringify({ id, polling_url, cost: 0.8 }), { status: 200 });
  }
  if (u.startsWith(POLL)) {
    const id = u.slice(POLL.length);
    bfl.polls.push({ id, key, redirect: init.redirect });
    const n = state.get(id) + 1;
    state.set(id, n);
    if (bfl.mode === "slow" || n <= bfl.pending) return new Response(JSON.stringify({ id, status: n === 1 ? "Pending" : "Generating" }), { status: 200 });
    if (bfl.mode === "moderated") return new Response(JSON.stringify({ id, status: "Content Moderated" }), { status: 200 });
    if (bfl.failing.has(id)) return new Response(JSON.stringify({ id, status: "Error" }), { status: 200 });
    return new Response(JSON.stringify({ id, status: "Ready", result: { sample: bfl.sample ?? SAMPLE + id + ".jpeg?sig=x" } }), { status: 200 });
  }
  if (u.startsWith(SAMPLE)) {
    bfl.downloads.push({ url: u, key: init.headers?.["x-key"] ?? null, redirect: init.redirect });
    return new Response(jpeg(bfl.downloads.length), { status: 200, headers: { "content-type": "image/jpeg" } });
  }
  if (OFF_BFL.some((h) => u.startsWith(h))) {
    bfl.offhost.push({ url: u, key });
    return new Response(jpeg(0), { status: 200 });
  }
  if (u === OPENAI_IMAGE.url) {
    openai.calls.push(JSON.parse(init.body));
    if (openai.fail?.test(JSON.parse(init.body).prompt)) return new Response(JSON.stringify({ error: { type: "server_error" } }), { status: 500 });
    return new Response(JSON.stringify({ data: [{ b64_json: placeholderPng([10, 90, 150]).toString("base64") }] }), { status: 200 });
  }
  return realFetch(url, init);
};

const testDb = await freshDb();
const q = testDb.query;
let base, close;
before(async () => {
  fake.install();
  ({ base, close } = await serveApi(apiPlugins, { db: testDb.db }));
});
after(async () => {
  await settlePictureFills();
  await settleExtractions();
  globalThis.fetch = realFetch;
  fake.restore();
  await close();
  await testDb.close();
});
const REAL_TIMING = { ...BFL_TIMING };
beforeEach(async () => {
  await settlePictureFills();
  resetPictureMemory();
  Object.assign(BFL_TIMING, REAL_TIMING, { pollMs: 5 });
  Object.assign(bfl, { mode: "ok", submits: [], polls: [], downloads: [], offhost: [], pending: 2, sample: null, fail: null, failing: new Set() });
  Object.assign(openai, { calls: [], fail: null });
  fake.picture("!auto");
  fs.writeFileSync(process.env.LINGO_ENV_FILE, BFL_ONLY);
  fs.rmSync(path.join(root, "pictures.yaml"), { force: true });
  fs.rmSync(path.join(imagesDir, "stock"), { recursive: true, force: true });
});

let n = 0;
async function someone(learners = [KID]) {
  const name = `user${++n}`;
  await addUser(testDb.db, name, undefined, { learners });
  const c = client(base);
  await c.login(name);
  await c.pick(learners[0].name);
  return c;
}
async function add(who, pairs) {
  const out = {};
  for (const [text, meaning] of pairs) {
    const r = await who.call("POST", "/api/phrases", { text, meaning, starred: false });
    assert.equal(r.status, 201, r.text);
    out[text] = r.body.phrase;
  }
  return out;
}
async function drawAll(who) {
  const r = await who.call("POST", "/api/pictures/fill");
  await settlePictureFills();
  return r;
}
const rowsOf = (who) =>
  q("select p.text, x.status, x.file, x.content_type, x.theme, x.stock_id, x.restyle from phrase_pictures x join phrases p on p.id = x.phrase_id where x.language_profile_id = $1 order by p.text", [who.languageId]);
const ledger = (who, kind) => q("select outcome from picture_calls where language_profile_id = $1 and kind = $2", [who.languageId, kind]);
const status = async (who) => (await who.call("GET", "/api/pictures")).body.status;
const ownFiles = () => (fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir).filter((f) => !f.startsWith(".") && f !== "stock") : []);
const stockFile = (id, theme = PICTURE_THEME.id) => path.join(imagesDir, "stock", theme, `${id}.jpg`);

/** A stock list with dog, cat and ball (and any `extra` concept lines, in
 *  a Drinks category), and the files drawn for those in `drawn`. */
function stock(drawn = ["dog", "cat", "ball"], extra = []) {
  fs.writeFileSync(
    path.join(root, "pictures.yaml"),
    [
      "categories:",
      "  Animals:",
      "    - { id: dog, description: a friendly brown dog, words: [dog, puppy] }",
      "    - { id: cat, description: a fluffy orange cat, words: [cat, kitten] }",
      "  Toys:",
      "    - { id: ball, description: a colourful ball, words: [ball] }",
      ...(extra.length ? ["  Drinks:", ...extra.map((l) => `    - ${l}`)] : []),
      "",
    ].join("\n"),
  );
  for (const id of drawn) writeStockPicture(PICTURE_THEME.id, id, jpeg(`stock ${id}`), "image/jpeg", { dir: imagesDir });
}

const WORDS = [["der Hund", "dog"], ["die Katze", "cat"], ["der Ball", "ball"], ["hallo", "hello"], ["der Baum", "tree"]];

/* --------------------------------- the provider --------------------------------- */

test("the keys pick the provider: Black Forest Labs first, OpenAI when only its key is set, else a problem naming both", async () => {
  fs.writeFileSync(process.env.LINGO_ENV_FILE, BOTH);
  assert.equal(imageProvider().key, "bfl");
  fs.writeFileSync(process.env.LINGO_ENV_FILE, OPENAI_ONLY);
  assert.equal(imageProvider().key, "openai");
  fs.writeFileSync(process.env.LINGO_ENV_FILE, "");
  assert.equal(imageProvider().key, "none");
  assert.match(imageProvider().problem(), /BFL_API_KEY[\s\S]*OPENAI_API_KEY/);

  // End to end: with both keys, the picture comes from BFL and nothing goes to OpenAI.
  fs.writeFileSync(process.env.LINGO_ENV_FILE, BOTH);
  const pip = await someone();
  await add(pip, WORDS.slice(0, 1));
  await drawAll(pip);
  assert.equal(bfl.submits.length, 1);
  assert.equal(openai.calls.length, 0);
  // With only OpenAI's, OpenAI draws, recorded as not the theme's own look.
  fs.writeFileSync(process.env.LINGO_ENV_FILE, OPENAI_ONLY);
  const kim = await someone();
  await add(kim, WORDS.slice(0, 1));
  await drawAll(kim);
  assert.equal(openai.calls.length, 1);
  assert.equal((await rowsOf(kim))[0].theme, "cream-outline-1+openai");
});

test("BFL: one submit with the theme's seed and strict safety, polled with the key until Ready, the picture downloaded without it", async () => {
  const pip = await someone();
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await add(pip, WORDS.slice(0, 1));
    await drawAll(pip);
  } finally {
    console.log = log;
  }
  assert.equal(bfl.submits.length, 1);
  const { body, key } = bfl.submits[0];
  assert.equal(key, BFL_KEY);
  assert.deepEqual([body.resolution, body.output_format, body.safety_tolerance, body.seed], ["768sq", "jpeg", 0, PICTURE_THEME.seed]);
  assert.deepEqual(Object.keys(body).sort(), ["output_format", "prompt", "resolution", "safety_tolerance", "seed"], "only fields the endpoint takes");
  assert.ok(body.prompt.startsWith(PICTURE_THEME.style.join("\n")), "the theme's lines open the prompt");
  assert.match(body.prompt, /\nSubject: "a picture of dog"$/);
  assert.equal(bfl.polls.length, 3, "Pending, Generating, Ready");
  assert.ok(bfl.polls.every((p) => p.key === BFL_KEY));
  assert.equal(bfl.downloads.length, 1);
  assert.equal(bfl.downloads[0].key, null, "the key never goes to the download");
  const [row] = await rowsOf(pip);
  assert.deepEqual([row.status, row.content_type, row.theme, row.stock_id], ["ready", "image/jpeg", "cream-outline-1", null]);
  assert.ok(ownFiles().includes(`${row.file}.jpg`));
  // The log names the model and the credits, never the key or the prompt.
  const line = logs.find((l) => l.includes("flux-3-image-klein"));
  assert.match(line, /0\.8 credits/);
  assert.ok(!logs.some((l) => l.includes(BFL_KEY) || l.includes("a picture of dog")));
});

test("BFL: no picture within the time budget is a failure (the word waits); a moderation refusal leaves it out, never retried", async () => {
  Object.assign(BFL_TIMING, { totalMs: 150, pollMs: 10 });
  bfl.mode = "slow";
  const pip = await someone();
  await add(pip, WORDS.slice(0, 1));
  const t0 = Date.now();
  await drawAll(pip);
  assert.ok(Date.now() - t0 < 1500, "it gave up at the budget, not later");
  assert.ok(bfl.polls.length >= 2, "it polled");
  assert.deepEqual((await rowsOf(pip)).map((r) => r.status), ["pending"]);
  assert.deepEqual((await ledger(pip, "image")).map((r) => r.outcome), ["failed"]);

  Object.assign(BFL_TIMING, REAL_TIMING, { pollMs: 5 });
  bfl.mode = "moderated";
  const kim = await someone();
  await add(kim, WORDS.slice(0, 2));
  await drawAll(kim);
  assert.deepEqual((await rowsOf(kim)).map((r) => r.status), ["failed", "failed"], "both tried once, the run goes on after a refusal");
  assert.deepEqual((await ledger(kim, "image")).map((r) => r.outcome), ["refused", "refused"]);
  bfl.mode = "ok";
  resetPictureMemory();
  const before = bfl.submits.length;
  await drawAll(kim);
  assert.equal(bfl.submits.length, before, "a refused picture isn't drawn again by itself");
});

test("BFL: the key is never sent to a polling address off bfl.ai; out of credits (402) is a plain log line and the word waits", async () => {
  bfl.mode = "offhost";
  const pip = await someone();
  await add(pip, WORDS.slice(0, 1));
  const errors = [];
  const err = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    await drawAll(pip);
    assert.equal(bfl.offhost.length, 0, "nothing was sent there at all");
    assert.deepEqual((await rowsOf(pip)).map((r) => r.status), ["pending"]);
    assert.match(errors.join("\n"), /isn't https on bfl\.ai/);

    bfl.mode = "credits";
    resetPictureMemory();
    errors.length = 0;
    await drawAll(pip);
  } finally {
    console.error = err;
  }
  assert.match(errors.join("\n"), /402 .*out of credits/);
  assert.ok(!errors.join("\n").includes("a picture of dog"), "the reply's body (which quotes the prompt) isn't logged");
  assert.deepEqual((await rowsOf(pip)).map((r) => r.status), ["pending"]);
});

/* ---------------------------------- the stock ---------------------------------- */

test("a word the check matches to a drawn stock picture is ready at once: no image call, no image in the ledger", async () => {
  stock();
  const pip = await someone();
  await add(pip, WORDS);
  await drawAll(pip);
  const args = fake.pictureArgs();
  assert.match(args.find((a) => a.startsWith("Words:")), /\n\nStock pictures:\ndog: dog, puppy\ncat: cat, kitten\nball: ball$/);
  const rows = await rowsOf(pip);
  const by = Object.fromEntries(rows.map((r) => [r.text, r]));
  for (const [text, id] of [["der Hund", "dog"], ["die Katze", "cat"], ["der Ball", "ball"]]) {
    assert.deepEqual([by[text].status, by[text].stock_id, by[text].theme, by[text].file], ["ready", id, PICTURE_THEME.id, stockKey(PICTURE_THEME.id, id)], text);
  }
  assert.equal(by.hallo.status, "none");
  assert.equal(by["der Baum"].status, "ready", "a word with no stock picture is drawn");
  assert.equal(bfl.submits.length, 1, "only the tree was drawn");
  assert.equal((await ledger(pip, "image")).length, 1);
  assert.equal((await status(pip)).pictured, 4);

  // The game serves the stock file through the picture route, like any picture.
  const { rounds } = (await pip.call("POST", "/api/game/start")).body;
  const [dogRow] = await q("select id, phrase_id from phrase_pictures where language_profile_id = $1 and stock_id = 'dog'", [pip.languageId]);
  const view = (await pip.call("GET", `/api/pictures/phrase/${dogRow.phrase_id}`)).body.picture;
  assert.deepEqual([view.stock, view.inTheme], [true, true]);
  // The URL's file is the stock key and the file's version (a stock
  // picture drawn again gets a new URL).
  assert.match(view.file, new RegExp(`^${stockKey(PICTURE_THEME.id, "dog")}\\.[0-9a-z]+$`));
  const r = await pip.call("GET", `/api/game/pictures/${dogRow.id}/${view.file}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  assert.equal(r.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.ok(rounds.length >= 3);
  const dogChoice = rounds.flatMap((x) => x.choices).find((c) => c.id === dogRow.id);
  assert.equal(dogChoice?.file, view.file, "the game's URL is the same one");
});

test("a made-up stock id, or one whose file isn't drawn, is ignored: the word is drawn as usual", async () => {
  stock(["cat"]);
  fake.picture("!auto-stock=unicorn");
  const pip = await someone();
  await add(pip, WORDS.slice(0, 1));
  await drawAll(pip);
  assert.deepEqual((await rowsOf(pip)).map((r) => [r.status, r.stock_id]), [["ready", null]]);
  assert.equal(bfl.submits.length, 1);
  // dog is listed but not drawn: not offered, so drawn for the word.
  fake.picture("!auto");
  const kim = await someone();
  await add(kim, WORDS.slice(0, 2));
  await drawAll(kim);
  assert.doesNotMatch(fake.pictureArgs().find((a) => a.startsWith("Words:")), /^dog:/m);
  assert.deepEqual((await rowsOf(kim)).map((r) => [r.text, r.stock_id]), [["der Hund", null], ["die Katze", "cat"]]);
});

test("a stock file is never deleted by a word's remove, redraw or delete; Draw again gives the word a picture of its own", async () => {
  stock();
  const pip = await someone();
  const p = await add(pip, WORDS.slice(0, 3));
  await drawAll(pip);
  assert.equal(bfl.submits.length, 0);
  // Redraw: a private picture, paid and in the ledger; the stock file stays.
  const redraw = await pip.call("POST", `/api/pictures/phrase/${p["der Hund"].id}/redraw`);
  assert.equal(redraw.status, 200, redraw.text);
  await settlePictureFills();
  assert.equal(bfl.submits.length, 1);
  assert.equal((await ledger(pip, "image")).length, 1);
  const dog = (await rowsOf(pip)).find((r) => r.text === "der Hund");
  assert.deepEqual([dog.status, dog.stock_id], ["ready", null]);
  assert.ok(fs.existsSync(stockFile("dog")));
  // Remove and delete: the stock pictures stay.
  assert.equal((await pip.call("POST", `/api/pictures/phrase/${p["die Katze"].id}/remove`)).status, 200);
  assert.equal((await pip.call("DELETE", `/api/phrases/${p["der Ball"].id}`)).status, 200);
  for (const id of ["dog", "cat", "ball"]) assert.ok(fs.existsSync(stockFile(id)), id);
});

test("a stock picture is fetched like any picture: never by another learner, nor logged out", async () => {
  stock();
  const pip = await someone([KID, { ...KID, name: "Mo" }]);
  await add(pip, WORDS.slice(0, 3));
  await drawAll(pip);
  const [row] = await q("select id, phrase_id from phrase_pictures where language_profile_id = $1 and stock_id = 'dog'", [pip.languageId]);
  const url = `/api/game/pictures/${row.id}/${(await pip.call("GET", `/api/pictures/phrase/${row.phrase_id}`)).body.picture.file}`;
  assert.equal((await pip.call("GET", url)).status, 200);
  assert.equal((await client(base).call("GET", url)).status, 401, "logged out");
  const kim = await someone();
  assert.equal((await kim.call("GET", url)).status, 404, "another account");
  await pip.pick("Mo");
  assert.equal((await pip.call("GET", url)).status, 404, "another kid of the same account");
});

test("with no image key, stock matches still make pictures; the key message shows only once a word needs a real drawing", async () => {
  fs.writeFileSync(process.env.LINGO_ENV_FILE, "");
  stock();
  const pip = await someone();
  await add(pip, WORDS.slice(0, 4));
  const fill = await drawAll(pip);
  assert.equal(fill.status, 202, fill.text);
  let s = await status(pip);
  assert.deepEqual([s.pictured, s.ready, s.problem], [3, true, null]);
  assert.equal((await pip.call("POST", "/api/game/start")).body.rounds.length, 3);
  // A word no stock picture fits: it waits for a key, and the grown-up is told.
  await add(pip, [["der Baum", "tree"]]);
  await drawAll(pip);
  s = await status(pip);
  assert.equal(s.waiting, 1);
  assert.match(s.problem, /BFL_API_KEY/);
  assert.equal(bfl.submits.length + openai.calls.length, 0);
});

/* ------------------------------ Redraw all (the theme) ------------------------------ */

test("Redraw all in the current style: a stock picture where one fits, else a new drawing; old pictures stay until replaced", async () => {
  // Three pictures drawn before themes (theme null), as OpenAI drew them.
  fs.writeFileSync(process.env.LINGO_ENV_FILE, OPENAI_ONLY);
  const pip = await someone();
  await add(pip, [["der Hund", "dog"], ["der Baum", "tree"], ["das Haus", "house"]]);
  await drawAll(pip);
  await q("update phrase_pictures set theme = null where language_profile_id = $1", [pip.languageId]);
  const old = await rowsOf(pip);
  assert.equal(old.filter((r) => r.status === "ready").length, 3);
  for (const r of old) assert.ok(ownFiles().includes(`${r.file}.png`));

  // Now with BFL and a stock dog.
  fs.writeFileSync(process.env.LINGO_ENV_FILE, BFL_ONLY);
  stock(["dog"]);
  let s = await status(pip);
  assert.equal(s.outOfTheme, 3);
  // The restyle waits on the background run: hold the run back to see the
  // pictures still in place meanwhile.
  fake.picture("!auto", 300);
  const r = await pip.call("POST", "/api/pictures/restyle");
  assert.equal(r.status, 202, r.text);
  assert.equal(r.body.restyled, 3);
  const during = await rowsOf(pip);
  assert.ok(during.every((x) => x.status === "ready" && x.restyle === "check"), "every old picture stays ready while it waits");
  assert.equal((await pip.call("POST", "/api/game/start")).body.rounds.length, 3, "the child still has a full game");
  await settlePictureFills();

  const after = Object.fromEntries((await rowsOf(pip)).map((x) => [x.text, x]));
  assert.deepEqual([after["der Hund"].stock_id, after["der Hund"].theme, after["der Hund"].restyle], ["dog", PICTURE_THEME.id, null], "the dog now points at the stock picture");
  for (const t of ["der Baum", "das Haus"]) assert.deepEqual([after[t].status, after[t].theme, after[t].stock_id, after[t].content_type], ["ready", PICTURE_THEME.id, null, "image/jpeg"], t);
  assert.equal(bfl.submits.length, 2, "only the words with no stock picture were drawn");
  assert.equal((await ledger(pip, "image")).length, 3 + 2, "the redraws count toward the day's cap");
  for (const x of old) assert.ok(!ownFiles().includes(`${x.file}.png`), "each old file deleted once replaced");
  s = await status(pip);
  assert.deepEqual([s.outOfTheme, s.restyling], [0, 0]);
  // Again: nothing left out of the theme, nothing drawn.
  assert.equal((await pip.call("POST", "/api/pictures/restyle")).body.restyled, 0);
  await settlePictureFills();
  assert.equal(bfl.submits.length, 2);
});

test("a theme change leaves the old theme's stock pictures unused: words pointing there leave the game until Redraw all re-points them", async () => {
  stock(["dog"]);
  const pip = await someone();
  await add(pip, [["der Hund", "dog"], ["der Baum", "tree"], ["das Haus", "house"]]);
  await drawAll(pip);
  // As if the dog had been matched under an older theme, whose file this
  // install no longer has.
  await q("update phrase_pictures set theme = 'cream-outline-0', file = $1 where language_profile_id = $2 and stock_id = 'dog'", [stockKey("cream-outline-0", "dog"), pip.languageId]);
  let s = await status(pip);
  assert.equal(s.pictured, 2, "a stock picture of another theme with no file isn't shown");
  assert.equal(s.outOfTheme, 1);
  const r = await pip.call("POST", "/api/pictures/restyle");
  assert.equal(r.body.restyled, 1);
  await settlePictureFills();
  const [dog] = (await rowsOf(pip)).filter((x) => x.text === "der Hund");
  assert.deepEqual([dog.theme, dog.file, dog.restyle], [PICTURE_THEME.id, stockKey(PICTURE_THEME.id, "dog"), null], "re-pointed at this theme's file, with no call");
  assert.equal(bfl.submits.length, 2, "only the first two drawings");
  s = await status(pip);
  assert.equal(s.pictured, 3);
});

/* ------------------------------ PR #60 review ------------------------------ */

test("BFL: no redirect is ever followed: every submit, poll and download says so, and a 3xx never takes the key to another server", async () => {
  const pip = await someone();
  await add(pip, WORDS.slice(0, 1));
  await drawAll(pip);
  const all = [...bfl.submits, ...bfl.polls, ...bfl.downloads];
  assert.ok(bfl.submits.length && bfl.polls.length && bfl.downloads.length);
  assert.ok(all.every((x) => x.redirect === "error"), "redirect: error on every BFL request");

  // Two real local servers: the first redirects, the second records what
  // reaches it. fetch keeps a custom header like x-key across a cross-site
  // redirect, so only refusing the redirect keeps the key home.
  const seen = [];
  const second = http.createServer((req, res) => {
    seen.push(req.headers["x-key"] ?? null);
    res.end("{}");
  });
  await new Promise((r) => second.listen(0, "127.0.0.1", r));
  const first = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://localhost:${second.address().port}/steal` });
    res.end();
  });
  await new Promise((r) => first.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(bflFetch(`http://127.0.0.1:${first.address().port}/v1/get_result`, { headers: { "x-key": "k-redirect-test" } }));
    assert.deepEqual(seen, [], "the second server never heard from it");
  } finally {
    first.close();
    second.close();
  }
});

test("BFL: a picture address not https on bfl.ai (an internal host, another host, plain http) is a failure with nothing fetched", async () => {
  for (const sample of ["https://localhost/results/x.jpeg", "https://other.example.com/x.jpeg", "http://delivery-us1.bfl.ai/results/x.jpeg"]) {
    resetPictureMemory();
    bfl.sample = sample;
    const pip = await someone();
    await add(pip, WORDS.slice(0, 1));
    await drawAll(pip);
    assert.deepEqual((await rowsOf(pip)).map((r) => r.status), ["pending"], sample);
    assert.deepEqual((await ledger(pip, "image")).map((r) => r.outcome), ["failed"], sample);
  }
  assert.deepEqual(bfl.offhost, [], "no request reached any of them");
  assert.equal(bfl.downloads.length, 0);
});

test("a word whose drawing fails twice in a row (its own fault) is left out like a refusal, so the others are drawn; a service failure never counts", async () => {
  bfl.fail = /picture of tree/;
  const pip = await someone();
  const p = await add(pip, [["der Hund", "dog"], ["der Baum", "tree"]]);
  // The dog is drawn; the tree's task ends with Error: the run stops and waits.
  await drawAll(pip);
  let by = Object.fromEntries((await rowsOf(pip)).map((r) => [r.text, r.status]));
  assert.deepEqual(by, { "der Baum": "pending", "der Hund": "ready" });
  // A word added meanwhile, then again (the wait over): the tree's second
  // failure in a row leaves it out, and the run goes on to the house.
  await add(pip, [["das Haus", "house"]]);
  resetPictureMemory("backoff");
  await drawAll(pip);
  by = Object.fromEntries((await rowsOf(pip)).map((r) => [r.text, r.status]));
  assert.deepEqual(by, { "das Haus": "ready", "der Baum": "failed", "der Hund": "ready" });
  assert.deepEqual((await ledger(pip, "image")).map((r) => r.outcome).sort(), ["failed", "failed", "ok", "ok"]);
  // Draw again by hand still works.
  bfl.fail = null;
  assert.equal((await pip.call("POST", `/api/pictures/phrase/${p["der Baum"].id}/redraw`)).status, 200);
  await settlePictureFills();
  assert.equal((await rowsOf(pip)).find((r) => r.text === "der Baum").status, "ready");

  // Out of credits again and again: the account's problem, not the word's.
  bfl.mode = "credits";
  const kim = await someone();
  await add(kim, WORDS.slice(0, 1));
  for (let i = 0; i < 3; i++) {
    resetPictureMemory("backoff");
    await drawAll(kim);
  }
  assert.deepEqual((await rowsOf(kim)).map((r) => r.status), ["pending"]);
});

test("OpenAI too: a word it answers 500 for twice in a row is left out and the run goes on", async () => {
  fs.writeFileSync(process.env.LINGO_ENV_FILE, OPENAI_ONLY);
  openai.fail = /picture of tree/;
  const pip = await someone();
  await add(pip, [["der Hund", "dog"], ["der Baum", "tree"]]);
  await drawAll(pip);
  await add(pip, [["das Haus", "house"]]);
  resetPictureMemory("backoff");
  await drawAll(pip);
  const by = Object.fromEntries((await rowsOf(pip)).map((r) => [r.text, r.status]));
  assert.deepEqual(by, { "das Haus": "ready", "der Baum": "failed", "der Hund": "ready" });
});

test("a stock picture drawn again in the same theme gets a new URL; the old one is gone", async () => {
  stock(["dog"]);
  const pip = await someone();
  const p = await add(pip, WORDS.slice(0, 1));
  await drawAll(pip);
  const [row] = await q("select id from phrase_pictures where language_profile_id = $1", [pip.languageId]);
  const view = async () => (await pip.call("GET", `/api/pictures/phrase/${p["der Hund"].id}`)).body.picture.file;
  const before = await view();
  assert.equal((await pip.call("GET", `/api/game/pictures/${row.id}/${before}`)).status, 200);
  // Removed and drawn again (as removeStockPicture, then the stock CLI).
  writeStockPicture(PICTURE_THEME.id, "dog", jpeg("a new dog, drawn again"), "image/jpeg", { dir: imagesDir });
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(stockFile("dog"), later, later);
  const after = await view();
  assert.notEqual(after, before, "a new URL");
  assert.equal((await pip.call("GET", `/api/game/pictures/${row.id}/${before}`)).status, 404, "the old URL no longer answers");
  const r = await pip.call("GET", `/api/game/pictures/${row.id}/${after}`);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes("a new dog"));
});

test("Redraw all with no image key: a picture no stock picture fits isn't left waiting for ever; the status says how many need a key", async () => {
  stock(["cat"]);
  const pip = await someone();
  await add(pip, [["der Hund", "dog"], ["die Katze", "cat"]]);
  await drawAll(pip);
  await q("update phrase_pictures set theme = null where language_profile_id = $1 and stock_id is null", [pip.languageId]);
  fs.writeFileSync(process.env.LINGO_ENV_FILE, "");
  assert.equal((await status(pip)).needKey, 1);
  const r = await pip.call("POST", "/api/pictures/restyle");
  assert.equal(r.status, 202, r.text);
  await settlePictureFills();
  const [dog] = (await rowsOf(pip)).filter((x) => x.text === "der Hund");
  assert.deepEqual([dog.status, dog.restyle, dog.theme], ["ready", null, null], "keeps its picture, not marked to draw");
  const s = await status(pip);
  assert.deepEqual([s.outOfTheme, s.restyling, s.needKey], [1, 0, 1]);
});

test("adults-only stock concepts never reach a kids learner: not offered to the check, never matched, never in the game", async () => {
  stock(["dog", "cat", "ball", "beer"], ["{ id: beer, description: a glass of beer, words: [beer], adults: true }"]);
  const pip = await someone();
  await add(pip, [["das Bier", "beer"], ["der Hund", "dog"], ["die Katze", "cat"], ["der Ball", "ball"]]);
  await drawAll(pip);
  assert.doesNotMatch(fake.pictureArgs().find((a) => a.startsWith("Words:")), /^beer:/m, "not offered");
  assert.equal((await rowsOf(pip)).find((r) => r.text === "das Bier").stock_id, null);
  // Even when the check names it anyway, it isn't taken.
  fake.picture("!auto-stock=beer");
  const kim = await someone();
  await add(kim, [["das Bier", "beer"]]);
  await drawAll(kim);
  assert.deepEqual((await rowsOf(kim)).map((r) => r.stock_id), [null]);
  // A word matched before the flag was set leaves the game.
  const before = (await status(pip)).pictured;
  await q("update phrase_pictures set stock_id = 'beer', file = $1 where language_profile_id = $2 and stock_id = 'dog'", [stockKey(PICTURE_THEME.id, "beer"), pip.languageId]);
  assert.equal((await status(pip)).pictured, before - 1);
  const { rounds } = (await pip.call("POST", "/api/game/start")).body;
  const [beerRow] = await q("select id from phrase_pictures where language_profile_id = $1 and stock_id = 'beer'", [pip.languageId]);
  assert.ok(!rounds.some((x) => x.choices.some((c) => c.id === beerRow.id)), "never on a round's buttons");
});
