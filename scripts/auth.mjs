// Pure helpers for logins (docs/DATA.md §Auth): password hashing, session
// tokens, the session cookie, and the login throttle. No server imports and
// no database, so `node --test` covers them directly; web/server/auth.ts and
// the user CLI (scripts/user.mjs) are the callers.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/* -------------------------------- passwords ------------------------------- */

// scrypt from node:crypto: no native dependency (argon2 would need one).
// N = 2^15 costs ~50 ms and 32 MB here, a login's worth of work that makes a
// stolen hash expensive to guess at. The parameters are stored in the hash,
// so raising them later leaves existing hashes verifiable.
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const KEY_LEN = 32;
const SALT_LEN = 16;
// Node refuses N*r*128 above maxmem (32 MB by default), which N = 2^15 sits
// exactly at; the headroom also covers a hash made with a larger N.
const MAX_MEM = 256 * 1024 * 1024;

/** Shortest password the CLI and the first-run screen accept. */
export const MIN_PASSWORD = 8;
/** Longest: scrypt takes any length, but a megabyte of "password" is a
 *  denial of service, not a password. */
export const MAX_PASSWORD = 1024;

function derive(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    scrypt(String(password).normalize("NFC"), salt, KEY_LEN, { N, r, p, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$salt$hash`, salt and hash in base64url. */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** True when `password` matches `stored`. A malformed or foreign hash is
 *  false, never a throw: a login answers "wrong password", not a 500. */
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 1 << 20) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const want = Buffer.from(parts[5], "base64url");
  if (!salt.length || want.length !== KEY_LEN) return false;
  let got;
  try {
    got = await derive(password, salt, { N, r, p });
  } catch {
    return false;
  }
  return timingSafeEqual(got, want);
}

/** Why a new password is refused, or null when it is fine. */
export function passwordProblem(password) {
  if (typeof password !== "string") return "a password is required";
  if (password.length < MIN_PASSWORD) return `a password needs at least ${MIN_PASSWORD} characters`;
  if (password.length > MAX_PASSWORD) return `a password is at most ${MAX_PASSWORD} characters`;
  return null;
}

/* -------------------------------- usernames ------------------------------- */

/** Stored lowercased (the users table checks it); 1–32 of a-z 0-9 . _ -,
 *  starting with a letter or digit. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** The stored form of a typed username: trimmed and lowercased. */
export function normalizeUsername(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

/** Why a username is refused (after normalizing), or null. */
export function usernameProblem(name) {
  const n = normalizeUsername(name);
  if (!n) return "a username is required";
  if (!USERNAME_RE.test(n)) return "a username is 1–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit";
  return null;
}

/* --------------------------------- tokens --------------------------------- */

/** A new session token: 32 random bytes, base64url. Only the browser holds it. */
export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

/** What the database stores for a token: its SHA-256, hex. A leaked
 *  auth_sessions table therefore holds no usable cookie. */
export function tokenHash(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/* --------------------------------- cookies -------------------------------- */

export const SESSION_COOKIE = "ld_session";
export const SESSION_DAYS = 30;
export const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
/** A session's expiry slides forward at most this often: once a minute is
 *  plenty for a 30-day window, and spares a write on every request. */
export const SLIDE_EVERY_MS = 60 * 1000;

/** `Cookie:` header → {name: value}. The first of a repeated name wins (the
 *  most specific path comes first, RFC 6265 §5.4); a value that is not valid
 *  percent-encoding is kept as sent. */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== "string" || !header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep it raw */
    }
    out[name] = value;
  }
  return out;
}

/** One `Set-Cookie` value. `maxAge` in seconds (0 deletes the cookie). */
export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
    if (opts.maxAge <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * The request came in over HTTPS. `tailscale serve` terminates TLS and
 * forwards plain HTTP to localhost with `X-Forwarded-Proto: https`; on
 * http://localhost there is no such header and a `Secure` cookie would never
 * come back, so the flag follows the header. The first value counts when a
 * chain of proxies appended theirs.
 */
export function isSecureRequest(headers) {
  const raw = headers?.["x-forwarded-proto"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.split(",")[0].trim().toLowerCase() === "https";
}

/** The session cookie: httpOnly (no script reads it), SameSite=Lax (sent on
 *  a top-level navigation to the app, not on a cross-site POST), Secure over
 *  HTTPS. */
export function sessionCookie(token, { secure = false } = {}) {
  return serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_MS / 1000, httpOnly: true, sameSite: "Lax", secure });
}

/** Deletes the session cookie (logout, a dead session). */
export function clearSessionCookie({ secure = false } = {}) {
  return serializeCookie(SESSION_COOKIE, "", { maxAge: 0, httpOnly: true, sameSite: "Lax", secure });
}

/* -------------------------------- throttle -------------------------------- */

/**
 * The login throttle: after `max` attempts that did not succeed for one key
 * within `windowMs`, attempts for that key wait `waitMs` from the last one.
 * An attempt after the wait (still `max` in the window) starts another wait;
 * a success clears the key. In memory: one Mac, one process.
 *
 * `attempt()` counts the try as a failure up front, synchronously, before
 * the caller's first await (the user lookup, the scrypt); `succeed()` takes
 * it back. Counting only after a wrong password, as this did first, let a
 * burst of parallel guesses all pass the check before any of them failed.
 *
 * The key is the caller's (auth.ts: the normalized username plus the client
 * address, throttleKey), so an unknown username is throttled the same as a
 * real one and one client's guesses don't hold up another's logins. `now` is
 * injectable for tests.
 */
export function createLoginThrottle({ max = 5, windowMs = 15 * 60 * 1000, waitMs = 30 * 1000, now = () => Date.now() } = {}) {
  /** key → attempt times, oldest first */
  const failures = new Map();
  const recent = (key) => {
    const t = now();
    const list = (failures.get(key) ?? []).filter((at) => t - at < windowMs);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  };
  const wait = (key) => {
    const list = recent(key);
    if (list.length < max) return 0;
    return Math.max(0, list[list.length - 1] + waitMs - now());
  };
  return {
    /** Milliseconds this key must still wait; 0 when it may try. */
    wait,
    /** The wait (> 0: refused, nothing recorded), or 0 with the attempt
     *  recorded as a failure until `succeed()`. */
    attempt(key) {
      const w = wait(key);
      if (w > 0) return w;
      const list = recent(key);
      list.push(now());
      // Only the last `max` matter for the rule; cap the memory a flood of
      // guesses can take.
      failures.set(key, list.slice(-max));
      // A burst of distinct keys should not grow the map without bound
      // (keys are short: auth.ts checks the username before it gets here).
      if (failures.size > 10_000) failures.delete(failures.keys().next().value);
      return 0;
    },
    succeed(key) {
      failures.delete(key);
    },
    clear() {
      failures.clear();
    },
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Who is logging in, for the throttle key. A request from loopback with an
 * X-Forwarded-For came through the local proxy (Tailscale Serve in front of
 * the dev server, DATA.md §Hosting): the client is the address that proxy
 * appended, the list's LAST entry. Earlier entries are whatever the client
 * sent and can be anything, so keying on them would let a guesser pick a
 * fresh key per try. Anything else is the socket's address. Capped, since
 * it ends up in a map key.
 */
export function clientAddress(headers, remoteAddress) {
  const socket = String(remoteAddress ?? "");
  const xff = headers?.["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : xff;
  if (LOOPBACK.has(socket) && typeof raw === "string" && raw.trim()) {
    const hops = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1].slice(0, 64);
  }
  return socket.slice(0, 64);
}

/** The throttle key: a username and a client address. */
export function throttleKey(username, address) {
  return `${username}\n${address}`;
}

/* --------------------------------- learners ------------------------------- */

/** The profile keys a learner row holds, profile.yaml key → column key. */
export const PROFILE_COLUMNS = {
  learner_name: "name",
  native_language: "nativeLanguage",
  target_language: "targetLanguage",
  target_variant: "targetVariant",
  level: "level",
  goals: "goals",
  notes: "notes",
};

/** A learner's values from a profile.yaml mapping (the first-run seed).
 *  Folded YAML blocks keep their text; anything not a string becomes "". */
export function learnerFromProfile(profile, mode, fallbackName) {
  const p = profile && typeof profile === "object" ? profile : {};
  const out = { mode };
  for (const [key, col] of Object.entries(PROFILE_COLUMNS)) {
    const v = p[key];
    out[col] = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  }
  if (!out.name) out.name = fallbackName;
  return out;
}

/** A learner row as the assembler's profile: the profile.yaml keys, blanks
 *  left out (the assembler reads a blank as absent, as it did a missing key). */
export function profileFromLearner(learner) {
  const out = {};
  if (!learner) return out;
  for (const [key, col] of Object.entries(PROFILE_COLUMNS)) {
    const v = learner[col];
    if (typeof v === "string" && v.trim()) out[key] = v;
  }
  return out;
}
