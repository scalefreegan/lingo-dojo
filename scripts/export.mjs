#!/usr/bin/env node
// CLI: render a saved pack to exports/<id>.md, the same file the app's Export
// button writes.
//   node scripts/export.mjs content/packs/<id>.yaml
//   npm run export -- content/packs/<id>.yaml
//   npm run export -- content/kids/packs/<id>.yaml        (kids library, exports/kids/)
//   npm run export -- --mode kids some/other/pack.yaml
// The library comes from content/ (or LINGO_CONTENT_DIR) for adult mode and
// content/kids/ for kids mode; a pack path inside content/kids/ picks kids
// mode by itself. The pack can be any path, and its id is its filename stem.
// Warnings go to stderr and do not fail the run, matching the app; an
// unreadable or invalid pack exits 1, and so does a random scene whose pool
// is empty. A random scene's pack has its scene drawn here, and the first
// line of output names it.

import path from "node:path";
import { MODES, exportsDirFor, isMode, loadContent, loadPackFile, modeRoot, writeExport, ID_RE } from "./content.mjs";
import { assemble, effectiveProfile } from "./assemble.mjs";
import { drawRandomScene, emptyPoolMessage, scenesWord, withDrawnScene } from "../web/shared/scenes.ts";

const USAGE = "usage: node scripts/export.mjs [--mode adult|kids] content/packs/<id>.yaml";

/** `--mode <m>` anywhere in argv; the rest is the positional file. */
function parseArgs(argv) {
  let mode = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode") {
      mode = argv[++i];
      if (!isMode(mode)) return { error: `--mode must be one of ${MODES.join(", ")}` };
    } else if (argv[i].startsWith("--mode=")) {
      mode = argv[i].slice("--mode=".length);
      if (!isMode(mode)) return { error: `--mode must be one of ${MODES.join(", ")}` };
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1) return { error: USAGE };
  return { mode, file: rest[0] };
}

/** Kids mode when the pack lives inside the kids tree, else adult. */
function inferMode(abs) {
  const kids = path.resolve(modeRoot("kids"));
  const rel = path.relative(kids, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? "kids" : "adult";
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    return 2;
  }
  const abs = path.resolve(args.file);
  const mode = args.mode ?? inferMode(abs);
  const { pack, problems } = loadPackFile(abs);
  for (const p of problems) console.error(`${p.level}: ${p.file}: ${p.message}`);
  if (!pack) return 1;
  if (!ID_RE.test(pack.id)) {
    console.error(`error: "${pack.id}" is not a valid export id (lowercase letters, digits, hyphens); rename the pack file`);
    return 1;
  }

  const content = loadContent(modeRoot(mode));
  // Content problems elsewhere in the library don't stop an export, but say
  // how many so a unit missing from the output is explainable.
  const errors = content.problems.filter((p) => p.level === "error");
  if (errors.length) console.error(`note: ${errors.length} content file(s) failed to load; run the app to see them`);

  // A random scene is drawn here, once per export, from the same pool a
  // session would draw from (no recent-session history offline), and the
  // output says which one it was.
  let played = pack;
  let drew = null;
  if (pack.random_scene) {
    const target = String(effectiveProfile(content.profile, pack.overrides).target_language ?? "").trim();
    const draw = drawRandomScene(content.scenarios, content.languages, target, pack.random_scene, { rand: Math.random });
    if (!draw) {
      console.error(`error: ${emptyPoolMessage(pack.random_scene, target)}`);
      return 1;
    }
    played = withDrawnScene(pack, draw.scene.id);
    drew = `Random scene: drew "${draw.scene.title}" (${draw.scene.id}) from ${scenesWord(draw.pool.length)}`;
  }

  const { markdown, warnings, stats } = assemble(content, played, mode);
  for (const w of warnings) console.error(`warning: ${w}`);
  const out = writeExport(pack.id, markdown, exportsDirFor(mode));
  if (drew) console.log(drew);
  console.log(out);
  console.log(`${stats.words} words, ~${stats.tokens} tokens`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
