// Which public hostnames the dev server answers to besides localhost.
// Pure ESM with no server imports so vite.config.ts and `node --test` share it.

import fs from "node:fs";
import { envFile, parseEnv } from "./voice.mjs";

// A plain DNS name: dot-separated labels of letters, digits and hyphens, none
// starting or ending with a hyphen. No scheme, port, path, wildcard or space:
// Vite reads a leading dot as "this domain and its subdomains", and a typo
// here would silently widen or break what the server answers to.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** True when `h` (already lowercase) is a plain hostname. */
export function isPlainHostname(h) {
  return h.length <= 253 && h.split(".").every((l) => LABEL.test(l));
}

/**
 * Parse LINGO_PUBLIC_HOST: a comma-separated list, trimmed and lowercased,
 * empty entries ignored. Anything that is not a plain hostname goes into
 * `rejected` (for a startup warning) and never reaches Vite.
 */
export function parsePublicHosts(value) {
  const hosts = [];
  const rejected = [];
  for (const raw of String(value ?? "").split(",")) {
    const h = raw.trim().toLowerCase();
    if (!h) continue;
    if (isPlainHostname(h)) {
      if (!hosts.includes(h)) hosts.push(h);
    } else rejected.push(raw.trim());
  }
  return { hosts, rejected };
}

/** LINGO_PUBLIC_HOST from the shell, else the checkout's .env.local (the same
 *  file the voice keys and DATABASE_URL come from, so the Dock app sees it). */
export function publicHosts(env = process.env, file = envFile()) {
  let value = env.LINGO_PUBLIC_HOST;
  if (!value?.trim()) {
    try {
      value = parseEnv(fs.readFileSync(file, "utf8")).LINGO_PUBLIC_HOST;
    } catch {
      /* no file: no public host */
    }
  }
  return parsePublicHosts(value);
}
