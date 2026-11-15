// The pure auth helpers (scripts/auth.mjs): password hashing, usernames,
// tokens, the session cookie, and the login throttle. The routes that use
// them are auth.http.test.mjs.
//   node --test scripts/tests/auth.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_COOKIE, SESSION_MS, clearSessionCookie, createLoginThrottle, hashPassword, isSecureRequest, learnerFromProfile, newSessionToken,
  normalizeUsername, parseCookies, passwordProblem, profileFromLearner, serializeCookie, sessionCookie, tokenHash, usernameProblem,
  verifyPassword,
} from "../auth.mjs";

/* -------------------------------- passwords ------------------------------- */

test("hashPassword: scrypt$N$r$p$salt$hash, salted, and verifyPassword checks it", async () => {
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.match(a, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b, "a fresh salt each time");
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("correct horse battery", b), true);
  assert.equal(await verifyPassword("correct horse batterY", a), false);
  assert.equal(await verifyPassword("", a), false);
});

test("verifyPassword: the parameters come from the hash, and NFC is applied to both sides", async () => {
  // A hash made with other (cheaper) parameters still verifies.
  const { scryptSync } = await import("node:crypto");
  const salt = Buffer.from("0123456789abcdef");
  const key = scryptSync("café au lait", salt, 32, { N: 1024, r: 8, p: 1 });
  const stored = `scrypt$1024$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
  assert.equal(await verifyPassword("café au lait", stored), true);
  assert.equal(await verifyPassword("café au lait", stored), true, "decomposed é types the same password");
});

test("verifyPassword: malformed or foreign hashes are false, never a throw", async () => {
  for (const stored of [
    "", "scrypt$test", "bcrypt$2b$10$abc", "scrypt$x$8$1$c2FsdA$aGFzaA", "scrypt$1024$8$1$$aGFzaA", "scrypt$1024$8$1$c2FsdA$c2hvcnQ",
    `scrypt$${2 ** 22}$8$1$c2FsdA$${"A".repeat(43)}`, "scrypt$1000$8$1$c2FsdA$" + "A".repeat(43), null, 42,
  ]) {
    assert.equal(await verifyPassword("anything", stored), false, String(stored));
  }
  assert.equal(await verifyPassword(undefined, await hashPassword("x".repeat(8))), false);
});

test("passwordProblem and usernameProblem say what is wrong; normalizeUsername trims and lowercases", () => {
  assert.equal(passwordProblem("12345678"), null);
  assert.match(passwordProblem("1234567"), /at least 8/);
  assert.match(passwordProblem("x".repeat(1025)), /at most 1024/);
  assert.match(passwordProblem(undefined), /required/);
  assert.equal(normalizeUsername("  Robin.K "), "robin.k");
  assert.equal(normalizeUsername(42), "");
  assert.equal(usernameProblem("Robin"), null, "checked after normalizing");
  for (const bad of ["", " ", "-robin", "rob in", "robin/x", "a".repeat(33), "röbin"]) assert.match(usernameProblem(bad), /username/, bad);
});

/* --------------------------------- tokens --------------------------------- */

test("session tokens: 32 random bytes; only their SHA-256 is stored", () => {
  const t = newSessionToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newSessionToken(), t);
  assert.match(tokenHash(t), /^[0-9a-f]{64}$/);
  assert.equal(tokenHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

/* --------------------------------- cookies -------------------------------- */

test("parseCookies: pairs split on ;, first of a name wins, values decoded, junk tolerated", () => {
  assert.deepEqual(parseCookies("ld_session=abc; theme=dark"), { ld_session: "abc", theme: "dark" });
  assert.deepEqual(parseCookies("a=1; a=2"), { a: "1" });
  assert.deepEqual(parseCookies('q="quoted"; e=caf%C3%A9; bad=%E0%A4%A; flag; =x'), { q: "quoted", e: "café", bad: "%E0%A4%A" });
  assert.deepEqual(parseCookies("k=a=b"), { k: "a=b" }, "only the first = splits");
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(Object.getPrototypeOf(parseCookies("__proto__=x")), Object.prototype, "a hostile name can't replace the prototype");
});

test("serializeCookie: name=value with Path, Max-Age, HttpOnly, SameSite, Secure", () => {
  assert.equal(serializeCookie("a", "b c"), "a=b%20c; Path=/");
  assert.equal(
    serializeCookie("a", "b", { maxAge: 60, httpOnly: true, sameSite: "Lax", secure: true }),
    "a=b; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure",
  );
  assert.equal(serializeCookie("a", "", { maxAge: 0 }), "a=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
});

test("the session cookie: ld_session, httpOnly, SameSite=Lax, 30 days; Secure only when asked", () => {
  const plain = sessionCookie("tok");
  assert.equal(plain, `${SESSION_COOKIE}=tok; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Lax`);
  assert.equal(SESSION_MS / 1000, 30 * 24 * 3600);
  assert.match(sessionCookie("tok", { secure: true }), /; Secure$/);
  assert.match(clearSessionCookie(), /^ld_session=; Path=\/; Max-Age=0; .*HttpOnly; SameSite=Lax$/);
  assert.match(clearSessionCookie({ secure: true }), /; Secure$/);
});

test("isSecureRequest: X-Forwarded-Proto https (first hop, any case) and nothing else", () => {
  assert.equal(isSecureRequest({ "x-forwarded-proto": "https" }), true);
  assert.equal(isSecureRequest({ "x-forwarded-proto": "HTTPS" }), true);
  assert.equal(isSecureRequest({ "x-forwarded-proto": "https, http" }), true);
  assert.equal(isSecureRequest({ "x-forwarded-proto": ["https"] }), true);
  assert.equal(isSecureRequest({ "x-forwarded-proto": "http" }), false);
  assert.equal(isSecureRequest({ "x-forwarded-proto": "http, https" }), false);
  assert.equal(isSecureRequest({}), false);
  assert.equal(isSecureRequest(undefined), false);
});

/* -------------------------------- throttle -------------------------------- */

test("the login throttle: 5 failures in 15 minutes → a 30 s wait; per username; success clears", () => {
  let t = 1_000_000;
  const th = createLoginThrottle({ now: () => t });
  for (let i = 0; i < 4; i++) {
    th.fail("robin");
    t += 1000;
  }
  assert.equal(th.wait("robin"), 0, "four failures: no wait");
  th.fail("robin");
  assert.equal(th.wait("robin"), 30_000, "the fifth starts the wait");
  assert.equal(th.wait("lee"), 0, "another username is not affected");
  t += 29_000;
  assert.equal(th.wait("robin"), 1000);
  t += 1000;
  assert.equal(th.wait("robin"), 0, "the wait is over");
  th.fail("robin");
  assert.equal(th.wait("robin"), 30_000, "still five in the window: another wait");
  t += 30_000;
  th.succeed("robin");
  th.fail("robin");
  assert.equal(th.wait("robin"), 0, "a success started the count over");
});

test("the login throttle: failures older than the window drop out", () => {
  let t = 0;
  const th = createLoginThrottle({ now: () => t });
  for (let i = 0; i < 4; i++) th.fail("robin");
  t += 15 * 60 * 1000; // those four are now outside the window
  th.fail("robin");
  assert.equal(th.wait("robin"), 0);
  for (let i = 0; i < 4; i++) th.fail("robin");
  assert.equal(th.wait("robin"), 30_000);
  th.clear();
  assert.equal(th.wait("robin"), 0);
});

/* --------------------------------- learners ------------------------------- */

test("learnerFromProfile / profileFromLearner: profile.yaml keys ↔ learner columns, blanks left out", () => {
  const row = learnerFromProfile(
    { learner_name: " Sam ", native_language: "English", target_language: "Spanish", level: "A2", goals: "Order food.\n", extra: "ignored", notes: 7 },
    "adult",
    "Me",
  );
  assert.deepEqual(row, {
    mode: "adult", name: "Sam", nativeLanguage: "English", targetLanguage: "Spanish", targetVariant: "", level: "A2", goals: "Order food.", notes: "7",
  });
  assert.equal(learnerFromProfile({}, "kids", "Kid").name, "Kid", "no learner_name: the fallback");
  assert.equal(learnerFromProfile(null, "kids", "Kid").name, "Kid");
  assert.deepEqual(profileFromLearner({ ...row, id: "x" }), {
    learner_name: "Sam", native_language: "English", target_language: "Spanish", level: "A2", goals: "Order food.", notes: "7",
  });
  assert.deepEqual(profileFromLearner(null), {});
});
