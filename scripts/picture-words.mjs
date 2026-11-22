// Drafts content/picture-words.yaml, the shared picture pool's reviewed
// translation table (docs/DATA.md §The shared picture pool, bead ld-ec9):
// for every concept of content/pictures.yaml, its CEFR level and its word
// in every POOL_LANGS language (picture-pool.mjs), with a regional variant
// only where the everyday word differs.
//
//   npm run pictures:words [-- --limit N] [--batch N] [--model M] [--dry-run]
//
// Asks a tool-less `claude -p` (your Claude Code login; no API key) about
// the concepts the file has no complete entry for, a batch at a time, and
// merges every word that passes picture-pool.mjs checkPoolWord into the
// file; an entry already there keeps its words (delete a line to have it
// drafted again). Idempotent: with nothing missing it calls nothing.
// The result is a draft: read it (one line per concept) and fix what a
// teacher would print otherwise before committing. The running app never
// calls this; concepts the file lacks (an admin's, a learner's drawing)
// are named by the server's own capped background call.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { startClaude } from "./claude.mjs";
import { POOL_WORDS_FILE, contentRoot, loadPictureStock } from "./content.mjs";
import { POOL_LANGS, parsePoolWordsReply, poolWordsPrompt, poolWordsYaml, readPoolWords } from "./picture-pool.mjs";

const HEADER = `# The shared picture pool's words (docs/DATA.md §The shared picture pool):
# for every concept of pictures.yaml, the CEFR level its word is met at
# (A1-B2; the game offers a learner the pool's words up to their level) and
# the word a teacher would print under its picture, per language key:
#   en es fr de it pt nl sv ru el ar hi ja ko   one per language (its
#                default variety: Latin American Spanish, Brazilian
#                Portuguese, American English, Modern Standard Arabic)
#   zh-CN zh-TW  Mandarin, simplified / traditional (Taiwan usage)
#   zh-HK        Cantonese, traditional characters
#   es-ES pt-PT en-GB …  a regional variant, only where its word differs
# Gendered nouns carry their article. Drafted by \`npm run pictures:words\`
# (a tool-less claude call per batch), then reviewed by hand; every word is
# checked to be in its language's script when the library loads.
`;

/** `--limit N` (concepts at most), `--batch N`, `--model M`, `--dry-run`, or `{ error }`. */
export function parseArgs(argv) {
  const out = { limit: Infinity, batch: 12, model: "claude-opus-5-5", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.split("=")[1] : argv[++i]);
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--limit") || a.startsWith("--batch")) {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 1) return { error: `${a.split("=")[0]} needs a whole number` };
      out[a.startsWith("--limit") ? "limit" : "batch"] = n;
    } else if (a.startsWith("--model")) out.model = String(val() ?? "");
    else return { error: `unknown option ${a}` };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\nusage: npm run pictures:words [-- --limit N] [--batch N] [--model M] [--dry-run]`);
    process.exit(2);
  }
  const root = contentRoot();
  const file = path.join(root, POOL_WORDS_FILE);
  const { concepts } = loadPictureStock(root);
  const order = concepts.map((c) => c.id);
  const entries = fs.existsSync(file) ? readPoolWords(YAML.parse(fs.readFileSync(file, "utf8"))).entries : new Map();
  const todo = concepts.filter((c) => !entries.has(c.id) || POOL_LANGS.some((k) => !entries.get(c.id).words[k])).slice(0, args.limit);
  console.log(`${todo.length} concept(s) to name, ${Math.ceil(todo.length / args.batch)} call(s) with ${args.model}.`);
  if (args.dryRun || !todo.length) return;
  let named = 0;
  for (let i = 0; i < todo.length; i += args.batch) {
    const batch = todo.slice(i, i + args.batch);
    const { system, user } = poolWordsPrompt(batch);
    let text;
    try {
      ({ text } = await startClaude({ prompt: user, systemPrompt: system, model: args.model, cwd: os.tmpdir(), tools: "none", maxTurns: 1, timeoutSec: 600 }).result);
    } catch (e) {
      console.error(`A call failed (${String(e?.message || e).split("\n")[0]}); the file keeps what was named so far.`);
      break;
    }
    const parsed = parsePoolWordsReply(text, batch);
    if (!parsed.ok) {
      console.error(`A reply wasn't usable (${parsed.error}); skipped.`);
      continue;
    }
    for (const it of parsed.items) {
      const before = entries.get(it.id);
      // Words already in the file (reviewed) win; the draft fills gaps.
      entries.set(it.id, { level: before?.level ?? it.level, words: { ...it.words, ...(before?.words ?? {}) } });
      named++;
    }
    fs.writeFileSync(file, poolWordsYaml(entries, order, HEADER));
    console.log(`  ${Math.min(i + args.batch, todo.length)} / ${todo.length}`);
  }
  const left = concepts.filter((c) => POOL_LANGS.some((k) => !entries.get(c.id)?.words[k])).length;
  console.log(`Named ${named} concept(s); ${left} still lack a word somewhere. Review ${path.relative(process.cwd(), file)} before committing.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
