#!/usr/bin/env node
// npm run user -- add <name> [--admin]   new account (prompts for a password)
// npm run user -- passwd <name>          new password; signs that user out everywhere
// npm run user -- list                   every account, admin flag, learners, disabled
// npm run user -- disable <name>         no more logins; signs them out (rows are kept)
// npm run user -- enable <name>          undo disable: logins work again, same password
//
// Accounts are made here, not in the app (docs/DATA.md §Auth). The one
// exception is the very first account, which the app's "Create the first
// account" screen makes while there are none. A user added here starts with
// no learners; the app asks them to add one after their first login.
//
// The password is prompted for without echo when stdin is a terminal, and
// read from stdin otherwise (its first line), for scripting:
//   printf '%s\n' "$PW" | npm run user -- add sam
//
// DATABASE_URL comes from the shell or the checkout's .env.local, like
// db:setup (scripts/db/config.mjs; a linked worktree must set one).

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { hashPassword, normalizeUsername, passwordProblem, usernameProblem } from "./auth.mjs";
import { databaseUrl, redact } from "./db/config.mjs";
import { createUser, disableUser, enableUser, listUsers, setPassword } from "./db/accounts.ts";
import * as schema from "./db/schema.ts";

const USAGE = `usage: npm run user -- add <name> [--admin] | passwd <name> | list | disable <name> | enable <name>`;

/** Read a line from a terminal without echoing it. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled")); // Ctrl-C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** All of stdin, for a piped password. */
async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** A new password: twice at a terminal, the first line of stdin otherwise. */
async function newPassword() {
  let password;
  if (process.stdin.isTTY) {
    password = await promptHidden("Password: ");
    const again = await promptHidden("Again: ");
    if (again !== password) throw new Error("the passwords don't match");
  } else {
    password = (await readStdin()).split(/\r?\n/)[0] ?? "";
  }
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  return password;
}

function nameArg(args) {
  const name = normalizeUsername(args.find((a) => !a.startsWith("--")));
  const problem = usernameProblem(name);
  if (problem) throw new Error(`${problem}\n${USAGE}`);
  return name;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "passwd", "list", "disable", "enable"].includes(command)) {
    console.error(USAGE);
    process.exit(2);
  }
  const url = databaseUrl();
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool, { schema });
  try {
    if (command === "list") {
      const users = await listUsers(db);
      if (!users.length) console.log(`no accounts yet in ${redact(url)} (the app's first-run screen makes the first admin)`);
      for (const u of users) {
        const flags = [u.isAdmin && "admin", u.disabledAt && "disabled"].filter(Boolean).join(", ");
        console.log(`${u.username}${flags ? ` (${flags})` : ""}: ${u.learners} learner${u.learners === 1 ? "" : "s"}`);
      }
      return;
    }
    const name = nameArg(args);
    if (command === "add") {
      const isAdmin = args.includes("--admin");
      const passwordHash = await hashPassword(await newPassword());
      try {
        await createUser(db, { username: name, passwordHash, isAdmin });
      } catch (e) {
        if ((e?.code ?? e?.cause?.code) === "23505") throw new Error(`there is already an account named ${name}`);
        throw e;
      }
      console.log(`added ${name}${isAdmin ? " (admin)" : ""}; they add a learner after their first login`);
    } else if (command === "passwd") {
      const passwordHash = await hashPassword(await newPassword());
      if (!(await setPassword(db, name, passwordHash))) throw new Error(`no account named ${name}`);
      console.log(`changed ${name}'s password; their sessions were signed out`);
    } else if (command === "disable") {
      if (!(await disableUser(db, name))) throw new Error(`no account named ${name}`);
      console.log(`disabled ${name}; their sessions were signed out`);
    } else {
      if (!(await enableUser(db, name))) throw new Error(`no account named ${name}`);
      console.log(`enabled ${name}; they can log in again`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  const hint =
    e?.code === "ECONNREFUSED" ? " (is Postgres running? brew services start postgresql@17)"
    : e?.code === "3D000" || e?.code === "42P01" ? " (run `npm run db:setup` first)"
    : "";
  console.error(`user: ${e?.message || e}${hint}`);
  process.exit(1);
});
