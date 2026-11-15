// Saved conversations: the pure half (docs/DATA.md §Conversations). No
// server or database imports, so `node --test` covers it directly; the
// routes and queries are web/server/conversations.ts.
//
// The browser still owns the session: it holds the transcript and sends the
// whole of it with every turn (reading it back from the database is a later
// bead). So the stored turns are kept as a copy of what the learner's screen
// shows, and each saved turn reconciles the two (planTurnWrite) instead of
// only appending. That one rule covers every way the screen and the store
// can part:
//
//   - a turn that failed or was stopped: its learner message stays on screen
//     with no reply, and is stored, reply-less, by the next turn;
//   - a reply the server finished but the browser dropped (Stop raced the
//     answer): stored, not shown, so the next turn deletes it;
//   - a conversation made after earlier turns went unsaved (creating it
//     failed): its first turn stores the screen from where saving stopped;
//   - "check what it heard": only the words finally sent ever reach a turn.
//
// A turn's `idx` is its position on screen counted from the entry the
// conversation started at, so the stored rows stay gap-free and in order:
// rows are only ever removed from some idx to the end, then appended from
// there.
//
// The history is the client's, so it is not trusted to rewrite what is
// stored: it may remove at most the conversation's final reply (the one a
// browser can have dropped), never more, and a master row whose words came
// from that history rather than from a reply the server produced in that
// request is marked `fromClient` (planTurnWrite says exactly how).

import { REPLAY_MAX_CHARS, replayLine } from "./voice.mjs";

/** A conversation left this long since its last turn is ended by the next
 *  request that touches its learner's conversations (never by a timer),
 *  unless a turn for it is running then. */
export const IDLE_END_MS = 2 * 60 * 60 * 1000;

/** A conversation id: a uuid. Anything else is "no such conversation" before
 *  it reaches Postgres (which would answer a malformed uuid with an error). */
export const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** History rows per page, and the most one page may ask for. */
export const PAGE_SIZE = 20;
export const MAX_PAGE = 100;
/** Turns per page of one conversation. */
export const TURN_PAGE = 200;
export const MAX_TURN_PAGE = 500;

const space = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** What decides whether a stored turn is the same entry as one on screen: the
 *  role, and the words (a learner's message; a master turn's lines). Not the
 *  glosses or timing, which the browser's copy may carry less precisely.
 *  Both sides go through the turn route's own normalisation (replayLine),
 *  so a stored line always matches its replay. */
export function turnKey(t) {
  if (t?.role === "learner") return `learner\u0000${space(String(t.text ?? "").slice(0, REPLAY_MAX_CHARS))}`;
  const lines = Array.isArray(t?.lines) ? t.lines.map((l) => space(replayLine(l?.text ?? ""))) : [];
  return `master\u0000${lines.join("\u0001")}`;
}

/** A transcript entry (VoiceHistoryItem) as turn-row columns. `fromClient`
 *  is for a master entry whose words came from the browser's history, not
 *  from a reply the server produced (DATA.md §Conversations). */
export function rowFromItem(item, fromClient = false) {
  if (item.role === "learner") return { role: "learner", text: item.text, lines: null, glosses: null, choices: null, stage: null, castNotes: null, fromClient: false };
  return {
    role: "master",
    text: null,
    lines: item.lines ?? [],
    glosses: item.glosses?.length ? item.glosses : null,
    choices: item.choices?.length ? item.choices : null,
    stage: item.stage || null,
    castNotes: item.castNotes?.length ? item.castNotes : null,
    fromClient,
  };
}

/** A stored turn row back as the transcript entry it was. */
export function itemFromRow(row) {
  if (row.role === "learner") return { role: "learner", text: row.text ?? "" };
  return {
    role: "master",
    lines: row.lines ?? [],
    ...(row.glosses?.length ? { glosses: row.glosses } : {}),
    ...(row.choices?.length ? { choices: row.choices } : {}),
    ...(row.stage ? { stage: row.stage } : {}),
    ...(row.castNotes?.length ? { castNotes: row.castNotes } : {}),
  };
}

/**
 * The write that makes a conversation's stored turns match the screen after
 * a successful turn.
 *
 *   stored  the conversation's rows, in idx order (role, text, lines)
 *   screen  the conversation's entries as the browser showed them before
 *           this turn (its history from the conversation's first entry on)
 *   message what the learner sent ("" opens the session: no learner row)
 *   master  the reply as a transcript entry, plus its duration and cost
 *
 * Returns `keep` (rows from that idx on are deleted), the rows to insert,
 * each with its idx, starting at `keep`, and whether the screen `covered`
 * what was stored. The rule (DATA.md §Conversations, "Reconciling"):
 *
 *   Let k be how many stored rows agree with the screen, entry by entry from
 *   the start (turnKey). The screen covers the store when k is all of them,
 *   or all but the last and that last one is a master reply: the reply a
 *   browser can have dropped (Stop raced it), so the screen may lack it or
 *   show something else in its place.
 *     - covered: rows from k on are deleted (that reply, or nothing), and
 *       the screen's entries from k on are inserted, then the message and
 *       the reply. A row that agreed is never rewritten.
 *     - not covered (a shorter history than what is stored, or one that
 *       differs before the final reply): nothing is deleted or rewritten;
 *       only the message and the reply are appended.
 *
 * Master entries inserted from the screen are `fromClient`; the reply the
 * server just produced and every learner row are not.
 */
export function planTurnWrite({ stored, screen, message, master }) {
  let k = 0;
  const both = Math.min(stored.length, screen.length);
  while (k < both && turnKey(stored[k]) === turnKey(screen[k])) k++;
  const covered = k === stored.length || (k === stored.length - 1 && stored[k].role === "master");
  const keep = covered ? k : stored.length;
  const rows = covered ? screen.slice(k).map((item) => rowFromItem(item, true)) : [];
  if (message) rows.push(rowFromItem({ role: "learner", text: message }));
  rows.push({ ...rowFromItem(master), durationMs: master.durationMs ?? null, costUsd: master.costUsd ?? null });
  return { keep, covered, insert: rows.map((r, i) => ({ ...r, idx: keep + i })) };
}

/** A conversation's title: what the browser showed as the scene, else the
 *  pack's title, the scenario's, or the first line of a quick scenario. */
export function conversationTitle({ title, pack, scenarioTitle }) {
  const first = [title, pack?.title, scenarioTitle, String(pack?.quick_scenario ?? "").split("\n")[0]]
    .map(space)
    .find(Boolean);
  return (first || "Practice session").slice(0, 200);
}

/** The largest start a page may name: Postgres's integer, which `turns.idx`
 *  is and an OFFSET comfortably takes. Past it there is nothing to list. */
export const MAX_START = 2 ** 31 - 1;

/** `?limit=&offset=` (History) or `?from=&limit=` (a conversation's turns)
 *  as numbers, clamped: a bad value is the default, never an error, and a
 *  huge one is MAX_START (an empty page), never a query Postgres refuses. */
export function readPage(params, { size, max, key = "offset" }) {
  const int = (v, d) => {
    const n = Number(v);
    return v != null && v !== "" && Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_START) : d;
  };
  return { limit: Math.max(1, Math.min(max, int(params.get("limit"), size))), start: int(params.get(key), 0) };
}
