import { randomInt } from "node:crypto";
import { drawRandomScene, emptyPoolMessage, readRandomScene } from "../shared/scenes.ts";
import type { Language, RandomScene, Scenario } from "../shared/wire.ts";
import { HttpError } from "./sse.ts";

// The server's half of the random scene (docs/CONTENT.md "Random scene"):
// the request check, the random source and the draw. The rules themselves
// (which scenes fit, the pool, steering clear of recent scenes) are the
// pure ones in web/shared/scenes.ts, the Scene tab's too. A scene is drawn
// here and only here: when a conversation is created (conversations.ts,
// the one place a session starts) and for an export (content.ts); never in
// the browser, and never to assemble a preview.

/** A request pack's `random_scene`, checked: null when it is not random, a
 *  400 when it is malformed (normalizePack would read that as not random,
 *  and a session must not quietly play something else). */
export function randomSceneOf(pack: unknown): RandomScene | null {
  const raw = pack && typeof pack === "object" ? (pack as Record<string, unknown>).random_scene : undefined;
  const r = readRandomScene(raw);
  if ("error" in r) throw new HttpError(400, r.error);
  return r.value;
}

let source: (() => number) | null = null;

/** A number in [0, 1) from the crypto generator (32 bits: plenty for a
 *  pool of a few dozen scenes), unless a test put a fixed source in
 *  (useSceneRandom). */
export function sceneRandom(): number {
  return source ? source() : randomInt(2 ** 32) / 2 ** 32;
}

/** The HTTP tests make draws repeatable through this; nothing else sets it.
 *  null puts the crypto source back. */
export function useSceneRandom(fn: (() => number) | null): void {
  source = fn;
}

/** Draw a scene from the pool, or the 400 an empty pool is (the Scene tab
 *  shows the same message before Start). */
export function drawOrRefuse(
  library: { scenarios: Scenario[]; languages: Language[] },
  target: string,
  random: RandomScene,
  opts: { recent?: (string | null)[]; keep?: string | null } = {},
): { scene: Scenario; pool: Scenario[]; kept: boolean } {
  const draw = drawRandomScene(library.scenarios, library.languages, target, random, { ...opts, rand: sceneRandom });
  if (!draw) throw new HttpError(400, emptyPoolMessage(random, target));
  return draw;
}
