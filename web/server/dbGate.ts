// The database gate in front of /api (bead ld-tdd).
//
// A first `npm run dev` still refuses to start on a database that isn't
// current (api.ts throws the boot check's message). A Vite *restart* must
// not: Vite restarts the server whenever a file the config imports changes
// (all of web/server/), so a `git pull` that brings server code and a
// migration restarts it before anyone has run `npm run db:migrate`. If
// configureServer throws then, Vite logs "server restart failed" and keeps
// the OLD server, serving the old code; and the half-built new server's file
// watcher is never closed, so the next change restarts that orphan too,
// which tries to listen on the port the live server still holds ("Port
// 38400 is already in use") and can leave nothing restartable.
//
// So after a restart the server always comes up with the new code, and
// while the database is not current every /api request gets a 503 naming
// what to run. Each such request re-checks (at most once per `retryMs`, one
// check at a time); the first that finds the database current opens the
// gate for good, so `npm run db:migrate` alone brings the API back. The
// server never migrates by itself: migrations are an explicit step, often
// irreversible, and a branch's must never reach the real database by
// accident (docs/DATA.md, Rules for branches and migrations).
//
// The page is served throughout (only /api is gated), so a reload shows the
// app with the 503's message in place of data.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ErrorReply } from "../shared/wire.ts";

/** Throws while the database is not current (db.ts checkDatabase). */
export type DatabaseCheck = () => Promise<unknown>;

export interface GateLog {
  info(msg: string): void;
  error(msg: string): void;
}

export interface DatabaseGate {
  /** The last check's failure; null once the database has been current. */
  readonly error: Error | null;
  /** Mount on "/api", ahead of every route. */
  middleware(req: IncomingMessage, res: ServerResponse, next: () => void): void;
}

/** The sentence for the page and the log line: the error's own split when
 *  it is checkDatabase's DatabaseNotReady, else its message. No URL. */
export function notReadyMessage(e: Error): string {
  const { problem, liveFix } = e as Error & { problem?: string; liveFix?: string };
  if (problem && liveFix) return `The server's database ${problem}. ${liveFix}`;
  return `The server's database is not ready: ${e.message}`;
}

/**
 * Run `check` once and return a gate that is open if it passed. A closed gate
 * re-runs `check` on a request at most every `retryMs` (requests in between,
 * or during a check, wait for that check or get the last answer).
 */
export async function openDatabaseGate(
  check: DatabaseCheck,
  { log, retryMs = 2000, now = Date.now }: { log: GateLog; retryMs?: number; now?: () => number },
): Promise<DatabaseGate> {
  let error: Error | null = null;
  let checkedAt = 0;
  let checking: Promise<void> | null = null;

  const run = async () => {
    checkedAt = now();
    try {
      await check();
      error = null;
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
  };
  await run();

  const recheck = (): Promise<void> => {
    if (!checking) {
      checking = run().finally(() => {
        checking = null;
        if (!error) log.info("  database ready: the API is serving again");
      });
    }
    return checking;
  };

  return {
    get error() {
      return error;
    },
    middleware(_req, res, next) {
      if (!error) return next();
      const due = checking || now() - checkedAt >= retryMs ? recheck() : Promise.resolve();
      void due.then(() => {
        if (!error) return next();
        const reply: ErrorReply = { error: notReadyMessage(error) };
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Retry-After", String(Math.ceil(retryMs / 1000)));
        res.end(JSON.stringify(reply));
      });
    },
  };
}
