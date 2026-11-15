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
 * reads nothing but a single-character file name in that one directory.
 *
 * The one other file it serves is that licence's text, at a fixed path
 * (ARPHIC_LICENSE_PATH, linked from the card): the licence asks that
 * whoever receives the data gets a copy. Not a general file route. */

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "hanzi-writer-data");
const PREFIX = "/hanzi-data/";
/** The Arphic Public License text that ships in the package. The card's
 *  link (script.ts ARPHIC_LICENSE_URL) names the same path. */
export const ARPHIC_LICENSE_PATH = "/hanzi-data/ARPHICPL.txt";
const LICENSE_FILE = path.join(DIR, "ARPHICPL.TXT");
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
  const license = req.url.split(/[?#]/)[0] === ARPHIC_LICENSE_PATH;
  const file = license ? LICENSE_FILE : strokeFile(req.url);
  const miss = () => {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end('{"error":"no stroke data for that character"}');
  };
  if (!file || (req.method !== "GET" && req.method !== "HEAD")) return miss();
  fs.readFile(file, (err, buf) => {
    if (err) return miss();
    res.setHeader("Content-Type", license ? "text/plain; charset=utf-8" : "application/json");
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
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
