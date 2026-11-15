// Serving on the tailnet (docs/DATA.md, Hosting on Tailscale): the
// LINGO_PUBLIC_HOST parser, and the request shape `tailscale serve` produces
// run through the same-origin, Secure-cookie and throttle-address rules.
// Hostnames here are made up, never a real tailnet.
//   node --test scripts/tests/tailscale.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePublicHosts, publicHosts } from "../public-host.mjs";
import { clientAddress, isSecureRequest, sessionCookie } from "../auth.mjs";

const { sameOrigin } = await import("../../web/server/api.ts");

const HOST = "dojo.example-tailnet.ts.net";

test("parsePublicHosts: trims, lowercases, drops empties and duplicates", () => {
  assert.deepEqual(parsePublicHosts(" Dojo.Example-Tailnet.ts.net , ,other.example.ts.net,dojo.example-tailnet.ts.net"), {
    hosts: [HOST, "other.example.ts.net"],
    rejected: [],
  });
  assert.deepEqual(parsePublicHosts(undefined), { hosts: [], rejected: [] });
  assert.deepEqual(parsePublicHosts(""), { hosts: [], rejected: [] });
});

test("parsePublicHosts: rejects anything that is not a plain hostname", () => {
  const bad = ["https://dojo.ts.net", "dojo.ts.net:443", "dojo.ts.net/x", "*.ts.net", ".ts.net", "do jo.ts.net", "-a.ts.net", "a..b", "a_b.ts.net"];
  const r = parsePublicHosts(`${bad.join(",")},good.ts.net`);
  assert.deepEqual(r.hosts, ["good.ts.net"]);
  assert.deepEqual(r.rejected, bad);
});

test("publicHosts: the environment wins, else .env.local, else nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-host-"));
  const file = path.join(dir, ".env.local");
  fs.writeFileSync(file, `LINGO_PUBLIC_HOST=${HOST}\n`);
  assert.deepEqual(publicHosts({}, file).hosts, [HOST]);
  assert.deepEqual(publicHosts({ LINGO_PUBLIC_HOST: "env.example.ts.net" }, file).hosts, ["env.example.ts.net"]);
  assert.deepEqual(publicHosts({}, path.join(dir, "missing")).hosts, []);
  fs.rmSync(dir, { recursive: true });
});

// What Tailscale Serve sends the backend (ipn/ipnlocal/serve.go): Host is the
// public name as the client sent it (no rewrite to localhost), X-Forwarded-Host
// the same, X-Forwarded-Proto https when TLS was terminated, X-Forwarded-For
// SET to the tailnet peer's address (not appended to a client-supplied value),
// and the browser's own Origin passes through untouched.
const served = {
  host: HOST,
  origin: `https://${HOST}`,
  "x-forwarded-host": HOST,
  "x-forwarded-proto": "https",
  "x-forwarded-for": "100.64.0.7",
};

test("same-origin: the tailnet name as Origin and Host passes; a mismatch fails", () => {
  assert.equal(sameOrigin(served.origin, served.host), true);
  assert.equal(sameOrigin("https://evil.example", served.host), false);
  assert.equal(sameOrigin(`https://${HOST}`, "localhost:38400"), false);
  assert.equal(sameOrigin("http://localhost:38400", served.host), false);
});

test("a request through tailscale serve gets a Secure cookie; plain localhost does not", () => {
  assert.equal(isSecureRequest(served), true);
  assert.match(sessionCookie("t", { secure: isSecureRequest(served) }), /; Secure/);
  assert.doesNotMatch(sessionCookie("t", { secure: isSecureRequest({ host: "localhost:38400" }) }), /Secure/);
});

test("throttle address: the proxy's X-Forwarded-For behind loopback, the socket otherwise", () => {
  assert.equal(clientAddress(served, "127.0.0.1"), "100.64.0.7");
  assert.equal(clientAddress(served, "::1"), "100.64.0.7");
  // A client-forged earlier hop is ignored; a header from a non-loopback peer is too.
  assert.equal(clientAddress({ "x-forwarded-for": "6.6.6.6, 100.64.0.7" }, "127.0.0.1"), "100.64.0.7");
  assert.equal(clientAddress(served, "192.168.1.9"), "192.168.1.9");
});
