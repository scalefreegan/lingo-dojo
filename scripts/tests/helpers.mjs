// Shared by the *.test.mjs files; not a test itself (the npm glob is
// *.test.mjs). Every test that mutates content works on a temp copy of the
// fixture tree, so the fixtures stay pristine and the real content/ is never
// touched.

import "./no-network.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "content");

/** A fresh temp copy of the fixture content tree; returns its path. */
export function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-"));
  const root = path.join(dir, "content");
  fs.cpSync(FIXTURE, root, { recursive: true });
  return root;
}

export function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}
