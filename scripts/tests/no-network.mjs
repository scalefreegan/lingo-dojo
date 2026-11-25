// No test may reach a provider (ld-byg). Not a test itself (the npm glob is
// *.test.mjs). `npm test` preloads this into every test process (--import),
// and connect-stack.mjs, testdb.mjs and helpers.mjs import it, so a server
// test run on its own is covered too:
//
//  - the provider keys the server reads (scripts/voice.mjs voiceKeys) are
//    taken out of this process's environment, and LINGO_ENV_FILE points at
//    no file, so neither the shell nor the checkout's .env.local gives a
//    test a real key. A test that wants a key sets its own made-up one;
//  - a fetch to anything but this machine is refused, and fails the test
//    file even when the server swallows the refusal (background work does:
//    a session's end draws pictures). A test that stubs globalThis.fetch is
//    its own guard; one that hands a call on to the real fetch comes here.
//
// Before this, OPENAI_API_KEY in the shell made each `npm test` send real,
// billable image requests.

import os from "node:os";
import path from "node:path";

export const PROVIDER_KEYS = ["ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "BFL_API_KEY", "OPENAI_API_KEY"];
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DONE = Symbol.for("lingo-dojo.tests.no-network");

if (!globalThis[DONE]) {
  globalThis[DONE] = true;
  for (const k of [...PROVIDER_KEYS, "LINGO_IMAGE_PROVIDER"]) delete process.env[k];
  process.env.LINGO_ENV_FILE = path.join(os.tmpdir(), "lingo-dojo-tests-no-such.env");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (LOCAL.has(url.hostname)) return realFetch(input, init);
    // The host only: a provider's URL or headers may carry a key or a
    // learner's words.
    console.error(`[tests] refused a fetch to ${url.hostname}: stub globalThis.fetch (scripts/tests/no-network.mjs)`);
    process.exitCode = 1;
    throw new Error(`no network in tests: ${url.hostname}`);
  };
}
