// A logged-in HTTP client for the route tests, and the accounts they log in
// as. Not a test itself (the npm glob is *.test.mjs).
//
//   const db = (await freshDb()).db;
//   const { base } = await serveApi(apiPlugins, { db });
//   await addUser(db, "robin", PASSWORD, { admin: true, learners: [ADULT] });
//   const robin = client(base);
//   await robin.login("robin", PASSWORD);
//   await robin.call("GET", "/api/packs");   // carries robin's cookie
//
// Every name here is made up.

import { hashPassword } from "../auth.mjs";
import { createLearner, createUser } from "../db/accounts.ts";

export const PASSWORD = "correct horse battery";

/** An adult learner like the fixture profile.yaml. */
export const ADULT = {
  name: "Sam", mode: "adult", nativeLanguage: "English", targetLanguage: "Spanish", targetVariant: "Mexican Spanish", level: "A2",
  goals: "Order food and chat with vendors.", notes: "Likes direct corrections.",
};
/** A kids learner like the fixture kids/profile.yaml. */
export const KID = {
  name: "Pip", mode: "kids", nativeLanguage: "English", targetLanguage: "German", targetVariant: "Standard German (Germany)", level: "First words",
};

/** A user straight into the database, with learners (each with its first
 *  language: the target keys of the values); returns the user and the
 *  learner rows, each with its `language` row. */
export async function addUser(db, username, password = PASSWORD, { admin = false, learners = [] } = {}) {
  const user = await createUser(db, { username, passwordHash: await hashPassword(password), isAdmin: admin });
  const rows = [];
  for (const l of learners) rows.push(await createLearner(db, user.id, l));
  return { user, learners: rows };
}

/** A fetch client with its own cookie jar (one cookie: ld_session), or the
 *  jar of another client (`tab(other)`: a second tab of the same browser).
 *  Like the app's api.ts, it sends X-Learner-Id and X-Language-Profile-Id —
 *  the learner and language this "page" shows, set by pick() and
 *  pickLanguage() — on every call; set `learnerId` / `languageId` to change
 *  them. */
export function client(base, jar = { cookie: "" }) {
  const self = {
    jar,
    /** The learner this client's page shows (pick() sets it), or null. */
    learnerId: null,
    /** The language this client's page shows (pick() and pickLanguage() set it), or null. */
    languageId: null,
    /** The last Set-Cookie headers seen, raw. */
    setCookies: [],
    async call(method, url, body, headers = {}) {
      const res = await fetch(base + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(jar.cookie ? { Cookie: jar.cookie } : {}),
          ...(self.learnerId ? { "X-Learner-Id": self.learnerId } : {}),
          ...(self.languageId ? { "X-Language-Profile-Id": self.languageId } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
      });
      self.setCookies = res.headers.getSetCookie();
      for (const c of self.setCookies) {
        const [pair] = c.split(";");
        const value = pair.slice(pair.indexOf("=") + 1);
        // Max-Age=0 is the server clearing it.
        jar.cookie = /Max-Age=0\b/.test(c) ? "" : `ld_session=${value}`;
      }
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* audio or empty */
      }
      return { status: res.status, body: json, text, headers: res.headers };
    },
    async login(username, password = PASSWORD) {
      const r = await self.call("POST", "/api/auth/login", { username, password });
      if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
    /** Make the learner with this name (or id) the session's active one,
     *  on the language it lands on. */
    async pick(nameOrId) {
      const me = (await self.call("GET", "/api/auth/me")).body;
      const l = me.learners.find((x) => x.id === nameOrId || x.name === nameOrId);
      if (!l) throw new Error(`no learner ${nameOrId}`);
      const r = await self.call("PUT", "/api/auth/learner", { learnerId: l.id });
      if (r.status !== 200) throw new Error(`pick ${nameOrId}: ${r.status} ${JSON.stringify(r.body)}`);
      self.learnerId = l.id;
      self.languageId = r.body.language.id;
      return r.body;
    },
    /** Make the active learner's language with this target language (or id)
     *  the session's active one. */
    async pickLanguage(nameOrId) {
      const me = (await self.call("GET", "/api/auth/me")).body;
      const l = me.learner?.languages.find((x) => x.id === nameOrId || x.target_language === nameOrId);
      if (!l) throw new Error(`no language ${nameOrId}`);
      const r = await self.call("PUT", "/api/auth/language", { languageId: l.id });
      if (r.status !== 200) throw new Error(`pick language ${nameOrId}: ${r.status} ${JSON.stringify(r.body)}`);
      self.languageId = l.id;
      return r.body;
    },
    /** Add a language to the active learner and switch to it. */
    async addLanguage(values) {
      const r = await self.call("POST", `/api/learners/${self.learnerId}/languages`, values);
      if (r.status !== 200) throw new Error(`add language: ${r.status} ${JSON.stringify(r.body)}`);
      await self.pickLanguage(r.body.language.id);
      return r.body.language;
    },
  };
  return self;
}

/** A second tab of `other`'s browser: the same cookie jar, its own page. */
export function tab(base, other) {
  const t = client(base, other.jar);
  t.learnerId = other.learnerId;
  t.languageId = other.languageId;
  return t;
}
