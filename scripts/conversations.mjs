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
//   - the same turn sent twice: the second replaces the first's reply;
//   - "check what it heard": only the words finally sent ever reach a turn.
//
// A turn's `idx` is its position on screen counted from the entry the
// conversation started at, so the stored rows stay gap-free and in order:
// rows are only ever removed from some idx to the end, then appended from
// there.

/** A conversation left this long since its last turn is ended by the next
 *  request that touches its learner's conversations (never by a timer). */
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
 *  glosses or timing, which the browser's copy may carry less precisely. */
export function turnKey(t) {
  if (t?.role === "learner") return `learner\u0000${space(t.text)}`;
  const lines = Array.isArray(t?.lines) ? t.lines.map((l) => space(l?.text)) : [];
  return `master\u0000${lines.join("\u0001")}`;
}

/** A transcript entry (VoiceHistoryItem) as turn-row columns. */
export function rowFromItem(item) {
  if (item.role === "learner") return { role: "learner", text: item.text, lines: null, glosses: null, choices: null, stage: null, castNotes: null };
  return {
    role: "master",
    text: null,
    lines: item.lines ?? [],
    glosses: item.glosses?.length ? item.glosses : null,
    choices: item.choices?.length ? item.choices : null,
    stage: item.stage || null,
    castNotes: item.castNotes?.length ? item.castNotes : null,
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
 * Returns `keep` (rows from that idx on are deleted) and the rows to insert,
 * each with its idx, starting at `keep`. Stored rows that agree with the
 * screen are kept with their metadata; from the first disagreement on, the
 * screen wins.
 */
export function planTurnWrite({ stored, screen, message, master }) {
  let keep = 0;
  const both = Math.min(stored.length, screen.length);
  while (keep < both && turnKey(stored[keep]) === turnKey(screen[keep])) keep++;
  const rows = screen.slice(keep).map((item) => rowFromItem(item));
  if (message) rows.push(rowFromItem({ role: "learner", text: message }));
  rows.push({ ...rowFromItem(master), durationMs: master.durationMs ?? null, costUsd: master.costUsd ?? null });
  return { keep, insert: rows.map((r, k) => ({ ...r, idx: keep + k })) };
}

/** A conversation's title: what the browser showed as the scene, else the
 *  pack's title, the scenario's, or the first line of a quick scenario. */
export function conversationTitle({ title, pack, scenarioTitle }) {
  const first = [title, pack?.title, scenarioTitle, String(pack?.quick_scenario ?? "").split("\n")[0]]
    .map(space)
    .find(Boolean);
  return (first || "Practice session").slice(0, 200);
}

/** `?limit=&offset=` (History) or `?from=&limit=` (a conversation's turns)
 *  as numbers, clamped: a bad value is the default, never an error. */
export function readPage(params, { size, max, key = "offset" }) {
  const int = (v, d) => {
    const n = Number(v);
    return v != null && v !== "" && Number.isInteger(n) && n >= 0 ? n : d;
  };
  return { limit: Math.max(1, Math.min(max, int(params.get("limit"), size))), start: int(params.get(key), 0) };
}
