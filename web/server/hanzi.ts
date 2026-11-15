import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/* Stroke-order data for the character card (src/components/CharCard.tsx),
 * served from this app's own origin: GET /hanzi-data/<character>.json is
 * that character's file in the hanzi-writer-data package (9,580 simplified
 * and traditional characters, about 3 KB each, from Make Me a Hanzi under
 * the Arphic Public License, whose text ships in the package). Hanzi
 * Writer's default loader would fetch them from a CDN; the app must work
 * offline, and bundling ~30 MB of JSON would be absurd, so one file is read
 * per tap.
 *
 * Not an /api route and not behind wrap(): like the JS bundle Vite serves,
 * it is public package data with nothing about any user in it, and it
 * reads nothing but a single-character file name in that one directory. */

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "hanzi-writer-data");
const PREFIX = "/hanzi-data/";
// One Han character, nothing else: no path can reach outside DIR.
const NAME = /^\p{Script=Han}\.json$/u;

/** The path's character file, or null for anything that isn't one. Pure,
 *  for the test. */
export function strokeFile(url: string | undefined): string | null {
  if (!url?.startsWith(PREFIX)) return null;
  let name: string;
  try {
    name = decodeURIComponent(url.slice(PREFIX.length).split(/[?#]/)[0]);
  } catch {
    return null;
  }
  return NAME.test(name) ? path.join(DIR, name) : null;
}

function serve(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (!req.url?.startsWith(PREFIX)) return next();
  const file = strokeFile(req.url);
  const miss = () => {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end('{"error":"no stroke data for that character"}');
  };
  if (!file || (req.method !== "GET" && req.method !== "HEAD")) return miss();
  fs.readFile(file, (err, buf) => {
    if (err) return miss();
    res.setHeader("Content-Type", "application/json");
    // The data is fixed for a package version: a week in the browser cache.
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.end(req.method === "HEAD" ? undefined : buf);
  });
}

export function hanziDataPlugin(): Plugin {
  return {
    name: "lingo-dojo-hanzi-data",
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
  };
}
