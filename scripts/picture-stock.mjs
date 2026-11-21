// The word game's shared stock pictures (docs/DATA.md §Stock pictures):
// about 200 concepts in content/pictures.yaml, each drawn once per install
// in the current picture theme and kept under <images dir>/stock/<theme>/
// (scripts/picture-store.mjs). A word the picturable check matches to a
// concept points at its file: ready at once, with no image call.
//
// Small functions, so the CLI below and, later, a settings route share one
// path: list the concepts with their file state, draw one, remove one file,
// add a concept. None of them touches a word's own picture or the daily
// ledger (a stock picture is the grown-up's explicit one-off, not a
// learner's draw).
//
//   npm run pictures:stock [-- --limit N] [--dry-run]
//
// draws every concept with no file yet in the current theme (sequentially,
// at most --limit), with Black Forest Labs (BFL_API_KEY): the theme's own
// provider, whose seed keeps the set in one look. Idempotent: a concept
// with a file is skipped. Prints the count and the credits each submit
// billed; stops cleanly on a 402 (out of credits) or 429 (too many
// requests). --dry-run lists what it would draw and the estimated cost,
// and needs no key. The key is never printed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { PICTURE_STOCK_FILE, contentRoot, loadPictureStock } from "./content.mjs";
import { deleteStockPicture, imagesDir, sniffPicture, stockPicture, writeStockPicture, MAX_PICTURE_BYTES } from "./picture-store.mjs";
import { PICTURE_THEME, STOCK_ID_RE, cleanDescription, mergeStock, picturePrompt, readStockList } from "./pictures.mjs";

/** The concepts (content/pictures.yaml, merged with the admin's own from
 *  the database, `custom`: pictures.mjs mergeStock) with their file in
 *  `theme`: `{ id, category, description, words, custom, drawn: { type } |
 *  null }`. */
export function listStock({ root = contentRoot(), theme = PICTURE_THEME.id, dir = imagesDir(), custom = [] } = {}) {
  return mergeStock(loadPictureStock(root).concepts, custom).concepts.map((c) => {
    const at = stockPicture(theme, c.id, { dir });
    return { ...c, drawn: at ? { type: at.type } : null };
  });
}

/** The concepts whose file is drawn in `theme`: what the picturable check
 *  may offer. */
export function drawnStock(opts = {}) {
  return listStock(opts).filter((c) => c.drawn);
}

/**
 * Draw one concept's stock picture with `provider` (imageProvider.ts's
 * shape: draw(prompt) → { bytes, type, credits }) and store it in `theme`,
 * replacing any file it had. Returns `{ credits }`. Throws what the
 * provider throws (ImageRefused, ImageFailed with its status).
 */
export async function drawStockPicture(concept, provider, { theme = PICTURE_THEME, dir = imagesDir(), signal } = {}) {
  const prompt = picturePrompt(concept.description, [], theme);
  if (!prompt) throw new Error(`stock concept ${concept.id} has nothing to draw`);
  const got = await provider.draw(prompt, signal);
  if (!got?.bytes || sniffPicture(got.bytes) !== got.type || got.bytes.length > MAX_PICTURE_BYTES) throw new Error(`the picture for ${concept.id} wasn't one the app keeps`);
  writeStockPicture(theme.id, concept.id, got.bytes, got.type, { dir });
  return { credits: typeof got.credits === "number" ? got.credits : null };
}

/** Remove one concept's stock file in `theme` (words pointing at it leave
 *  the game until it is drawn again). Never a word's own picture. */
export function removeStockPicture(id, { theme = PICTURE_THEME.id, dir = imagesDir() } = {}) {
  if (!STOCK_ID_RE.test(String(id))) throw new Error("not a stock id");
  deleteStockPicture(theme, id, { dir });
}

/**
 * Add a concept to content/pictures.yaml under `category` (made if new),
 * keeping the file's comments: `{ concept }` or `{ error }` (the list's own
 * rules: a new id, a description that passes cleanDescription, at least
 * one word). Its picture is drawn separately (drawStockPicture).
 */
export function addStockConcept({ id, category, description, words }, { root = contentRoot() } = {}) {
  const file = path.join(root, PICTURE_STOCK_FILE);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "categories: {}\n";
  const doc = YAML.parseDocument(text);
  const cat = typeof category === "string" && category.trim() ? category.trim() : "";
  if (!cat) return { error: "a concept needs a category" };
  const entry = { id, description: cleanDescription(description) ?? description, words };
  // Checked by the same rules the loader uses, on the list with it added.
  const raw = doc.toJS() ?? {};
  raw.categories = raw.categories ?? {};
  const before = readStockList(raw).concepts.length;
  (raw.categories[cat] ??= []).push(entry);
  const after = readStockList(raw);
  const added = after.concepts.find((c) => c.id === id);
  if (after.concepts.length !== before + 1 || !added) {
    return { error: after.problems.at(-1)?.message ?? "that concept isn't valid" };
  }
  if (!doc.has("categories")) doc.set("categories", doc.createNode({}));
  const cats = doc.get("categories");
  if (!cats.has(cat)) cats.set(cat, doc.createNode([]));
  const node = doc.createNode(entry);
  node.flow = true;
  cats.get(cat).add(node);
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  return { concept: added };
}

/**
 * The CLI's work: draw the concepts with no file in `theme`, one at a
 * time, at most `limit`. `log` gets each line. Returns `{ drawn, refused,
 * credits, stopped, missing }` (`stopped`: why it ended early, a 402 or
 * 429; `missing`: concepts left to draw). With `dryRun`, draws nothing and
 * lists what it would.
 */
export async function runStock({ provider, root = contentRoot(), theme = PICTURE_THEME, dir = imagesDir(), custom = [], limit = Infinity, dryRun = false, creditsEach = 0.8, log = console.log } = {}) {
  const all = listStock({ root, theme: theme.id, dir, custom });
  const todo = all.filter((c) => !c.drawn);
  const batch = todo.slice(0, Math.max(0, limit));
  log(`Picture theme ${theme.id} (seed ${theme.seed}): ${all.length} stock concepts, ${all.length - todo.length} drawn, ${todo.length} to draw.`);
  if (dryRun) {
    for (const c of batch) log(`  would draw ${c.id} (${c.category}): ${c.description}`);
    const est = batch.length * creditsEach;
    const whole = todo.length * creditsEach;
    log(`Would draw ${batch.length} picture(s): about ${round(est)} credits ($${(est / 100).toFixed(2)}). All ${todo.length} left: about ${round(whole)} credits ($${(whole / 100).toFixed(2)}), at ${creditsEach} credits a picture.`);
    return { drawn: 0, refused: 0, credits: 0, stopped: null, missing: todo.length };
  }
  let drawn = 0;
  let refused = 0;
  let credits = 0;
  let stopped = null;
  for (const c of batch) {
    try {
      const out = await drawStockPicture(c, provider, { theme, dir });
      drawn++;
      credits += out.credits ?? 0;
      log(`  drew ${c.id}${out.credits != null ? ` (${out.credits} credits)` : ""}`);
    } catch (e) {
      const status = e?.status ?? null;
      if (e?.constructor?.name === "ImageRefused") {
        refused++;
        log(`  ${c.id}: refused by the provider's moderation; skipped (edit its description to try again)`);
        continue;
      }
      if (status === 402 || status === 429) {
        stopped = status;
        log(`  stopped at ${c.id}: ${String(e.message)}`);
        break;
      }
      stopped = "error";
      log(`  stopped at ${c.id}: ${String(e?.message || e)}`);
      break;
    }
  }
  const missing = todo.length - drawn;
  log(`Drew ${drawn} picture(s) for ${round(credits)} credits ($${(credits / 100).toFixed(3)})${refused ? `; ${refused} refused` : ""}; ${missing} left to draw.`);
  return { drawn, refused, credits, stopped, missing };
}

const round = (n) => Math.round(n * 100) / 100;

/** `--limit N` and `--dry-run`, or `{ error }`. */
export function parseArgs(argv) {
  const out = { limit: Infinity, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--limit" || a.startsWith("--limit=")) {
      const v = a.includes("=") ? a.split("=")[1] : argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return { error: "--limit needs a whole number" };
      out.limit = n;
    } else return { error: `unknown option ${a}` };
  }
  return out;
}

/** The admin's own stock concepts (picture_stock_concepts, added from the
 *  picture library page), read once from DATABASE_URL (the shell's or
 *  .env.local's, like db:setup), so the CLI draws them too. With no
 *  database to read, pictures.yaml's alone, said once. */
async function customFromDatabase() {
  const [{ default: pg }, { drizzle }, { databaseUrl }, { customStockConcepts }, schema] = await Promise.all([
    import("pg"), import("drizzle-orm/node-postgres"), import("./db/config.mjs"), import("./db/pictureStock.ts"), import("./db/schema.ts"),
  ]);
  let pool = null;
  try {
    pool = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
    return await customStockConcepts(drizzle(pool, { schema }));
  } catch (e) {
    console.warn(`The added stock concepts couldn't be read from the database (${String(e?.message || e).split("\n")[0]}); drawing pictures.yaml's only.`);
    return [];
  } finally {
    await pool?.end().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\nusage: npm run pictures:stock [-- --limit N] [--dry-run]`);
    process.exit(2);
  }
  const { bflProvider, BFL_CREDITS_PER_IMAGE } = await import("../web/server/imageProvider.ts");
  const provider = bflProvider();
  if (!args.dryRun && provider.problem()) {
    console.error("The stock set is drawn with Black Forest Labs: add BFL_API_KEY to .env.local in the app's folder.");
    process.exit(1);
  }
  const out = await runStock({ provider, custom: await customFromDatabase(), limit: args.limit, dryRun: args.dryRun, creditsEach: BFL_CREDITS_PER_IMAGE });
  process.exit(out.stopped ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
