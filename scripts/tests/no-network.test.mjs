// The guard every test runs under (scripts/tests/no-network.mjs): no
// provider key, no env file, no fetch off this machine, and a refused fetch
// fails the file even when the code under test swallows it. The inner runs
// use a fake key and a host that can't exist (RFC 6761 .invalid).
//   node --test scripts/tests/no-network.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROVIDER_KEYS } from "./no-network.mjs";
import { voiceKeys } from "../voice.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const guard = pathToFileURL(path.join(here, "no-network.mjs")).href;
const FAKE = Object.fromEntries(PROVIDER_KEYS.map((k) => [k, "not-a-real-key"]));

/** Run `code` as a module of its own with every provider key set to a fake. */
function run(code, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-guard-"));
  const file = path.join(dir, "inner.mjs");
  fs.writeFileSync(file, code);
  const { NODE_TEST_CONTEXT: _c, ...env } = process.env;
  try {
    return spawnSync(process.execPath, [...args, file], { encoding: "utf8", env: { ...env, ...FAKE, LINGO_ENV_FILE: "" } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("no provider key reaches a test, from the shell or an env file", () => {
  assert.deepEqual(Object.values(voiceKeys()).filter(Boolean), []);
  const r = run(`import ${JSON.stringify(guard)};
    const { voiceKeys, envFile } = await import(${JSON.stringify(pathToFileURL(path.join(repo, "scripts/voice.mjs")).href)});
    const fs = await import("node:fs");
    console.log(JSON.stringify([Object.values(voiceKeys()).filter(Boolean).length, fs.existsSync(envFile())]));`);
  assert.equal(r.stdout.trim(), "[0,false]", r.stderr);
});

test("every key voiceKeys reads is one the guard clears", () => {
  const read = [];
  voiceKeys(new Proxy({}, { get: (_t, k) => (read.push(k), undefined) }), path.join(os.tmpdir(), "no-such.env"));
  assert.deepEqual(read.filter((k) => !PROVIDER_KEYS.includes(k)), []);
  assert.equal(new Set(read).size, PROVIDER_KEYS.length);
});

test("a fetch off this machine is refused and fails the process, even when it is swallowed; the host only is named", () => {
  for (const arg of [`"https://api.example.invalid/x?key=secret"`, `new URL("https://api.example.invalid/x?key=secret")`, `new Request("https://api.example.invalid/x?key=secret")`]) {
    const r = run(`import ${JSON.stringify(guard)};
      await fetch(${arg}).catch(() => {});`);
    assert.equal(r.status, 1, arg);
    assert.match(r.stderr, /refused a fetch to api\.example\.invalid/);
    assert.doesNotMatch(r.stderr, /secret/);
  }
});

test("this machine's own server is reached", () => {
  const r = run(`import ${JSON.stringify(guard)};
    import http from "node:http";
    const s = http.createServer((_q, a) => a.end("ok")).listen(0, "127.0.0.1", async () => {
      console.log(await (await fetch("http://127.0.0.1:" + s.address().port)).text());
      s.close();
    });`);
  assert.deepEqual([r.status, r.stdout.trim()], [0, "ok"], r.stderr);
});

test("npm test preloads the guard into each test process, and the shared helpers import it", () => {
  const script = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).scripts.test;
  const args = /^node (--import \S+ --test) /.exec(script)?.[1].split(" ");
  assert.ok(args, script);
  const r = run(`import { test } from "node:test";
    test("inner", () => fetch("https://api.example.invalid/").catch(() => {}));`, [...args.map((a) => (a.startsWith("./") ? path.join(repo, a) : a))]);
  assert.equal(r.status, 1, r.stdout);
  for (const f of ["connect-stack.mjs", "testdb.mjs", "helpers.mjs"]) assert.match(fs.readFileSync(path.join(here, f), "utf8"), /^import "\.\/no-network\.mjs";$/m, f);
});
