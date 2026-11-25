/* The Go tab's session, kept so a reload brings it back (docs/VOICE.md
 * §Reload). What is on screen is this browser's, so it is kept here, under
 * the language profile's own key: written as the session goes, dropped when
 * it is over (New session, Close, a switch of learner or language, two idle
 * hours), read once when the Go tab is drawn.
 *
 * Pure but for the storage and the lock at the end, so `node --test` covers
 * the rest (scripts/tests/live-session.test.mjs). */

import type { PageLearner } from "./api";
import type { ConversationSummary, VoiceCastReply, VoiceHistoryItem, VoicePlanItem } from "./types";
import { languageKey } from "./draft.ts";

/** A session left this long is over: the server ends its conversation then
 *  too (scripts/conversations.mjs IDLE_END_MS; a test holds them equal). */
export const LIVE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const KEY = "lingo-dojo.live-session.v1";
const VERSION = 1;

/** The saved conversation a session writes to (VoicePanel). */
export interface LiveConversation {
  id: string;
  start: number;
  page: PageLearner;
}

/** Everything on screen that a reload would lose. `held` and `holder` are
 *  who has which voice, `tones` the learner lines' marks (without their
 *  recordings, which are only ever in the page's memory); all three are
 *  VoicePanel's own shapes, opaque here. */
export interface LiveSession {
  v: typeof VERSION;
  /** The last time anything was said. */
  at: number;
  entries: VoiceHistoryItem[];
  plan: VoicePlanItem[];
  conversation: LiveConversation | null;
  /** Where saving stopped, if it did (VoicePanel unsavedFrom). */
  unsavedFrom: number | null;
  startedAt: number | null;
  /** The pack's minutes as the clock was counting them, and the +5s. */
  baseMinutes: number | null;
  extraMinutes: number;
  drawn: string | null;
  buildsOn: ConversationSummary["buildsOn"];
  cast: VoiceCastReply | null;
  held: [string, unknown][];
  holder: [string, string][];
  tones: [number, unknown][];
  composer: string;
  /** 💬: what's in the box is for the dojo master. */
  direct: boolean;
  /** Words for the dojo master waiting above the box. */
  heldRequest: string | null;
  chars: number;
  ended: boolean;
  recapId: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pairs = (v: unknown, key: "string" | "number") => (Array.isArray(v) ? v.filter((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === key) : []);

function isEntry(v: unknown): v is VoiceHistoryItem {
  if (!isObj(v)) return false;
  if (v.role === "learner") return typeof v.text === "string";
  return v.role === "master" && Array.isArray(v.lines) && v.lines.every((l) => isObj(l) && typeof l.text === "string" && typeof l.speaker === "string");
}

/** What storage held as a session, or null: nothing kept, another version,
 *  or not one (hand-edited, cut off). `fresh` is false once it is too old to
 *  go on with; its conversation, if any, is then the caller's to end. */
export function parseLive(raw: string | null, languageId: string, now: number): { session: LiveSession; fresh: boolean } | null {
  let d: unknown;
  try {
    d = raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!isObj(d) || d.v !== VERSION) return null;
  const at = num(d.at);
  if (at === null || !Array.isArray(d.entries) || !d.entries.length || !d.entries.every(isEntry)) return null;
  const c = isObj(d.conversation) && isObj(d.conversation.page) ? d.conversation : null;
  const page = c?.page as Record<string, unknown> | undefined;
  const conversation =
    c && typeof c.id === "string" && num(c.start) !== null && page && typeof page.learnerId === "string" && page.languageId === languageId
      ? { id: c.id, start: num(c.start)!, page: { learnerId: page.learnerId, languageId } }
      : null;
  const cast = isObj(d.cast) && isObj(d.cast.cast) ? (d.cast as unknown as VoiceCastReply) : null;
  const buildsOn = isObj(d.buildsOn) && typeof d.buildsOn.startedAt === "string" ? (d.buildsOn as ConversationSummary["buildsOn"]) : null;
  return {
    session: {
      v: VERSION,
      at,
      entries: d.entries,
      plan: Array.isArray(d.plan) ? (d.plan.filter((p) => isObj(p) && typeof p.id === "string") as VoicePlanItem[]) : [],
      conversation,
      unsavedFrom: num(d.unsavedFrom),
      startedAt: num(d.startedAt),
      baseMinutes: num(d.baseMinutes),
      extraMinutes: num(d.extraMinutes) ?? 0,
      drawn: str(d.drawn),
      buildsOn,
      cast,
      held: pairs(d.held, "string"),
      holder: pairs(d.holder, "string").filter((p) => typeof p[1] === "string"),
      tones: pairs(d.tones, "number"),
      composer: str(d.composer) ?? "",
      direct: d.direct === true,
      heldRequest: str(d.heldRequest),
      chars: num(d.chars) ?? 0,
      ended: d.ended === true,
      recapId: str(d.recapId),
    },
    // A clock set back leaves it in the future: that is fresh, not over.
    fresh: now - at < LIVE_MAX_AGE_MS,
  };
}

const words = (s: string) => s.replace(/\s+/g, " ").trim();
function same(a: VoiceHistoryItem, b: VoiceHistoryItem): boolean {
  if (a.role === "learner") return b.role === "learner" && words(a.text) === words(b.text);
  return b.role === "master" && a.lines.length === b.lines.length && a.lines.every((l, i) => words(l.text) === words(b.lines[i].text));
}

/** The session with what the server finished storing as the page went: the
 *  stored turns run on from the ones on screen (a reply that was on its way),
 *  so they are the session's. Null when there is nothing to add, or the two
 *  differ anywhere: the screen then stands, and the next turn settles it
 *  (planTurnWrite). */
export function withStored(entries: VoiceHistoryItem[], start: number, stored: VoiceHistoryItem[]): VoiceHistoryItem[] | null {
  const shown = entries.slice(start);
  if (stored.length <= shown.length || !shown.every((e, i) => same(e, stored[i]))) return null;
  return [...entries, ...stored.slice(shown.length)];
}

/* ------------------------------ in the browser ------------------------------ */

const keyFor = (languageId: string) => languageKey(KEY, languageId);

/** Logging out: no session of any language stays in this browser. */
export function dropLiveSessions(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(`${KEY}.`)) localStorage.removeItem(k);
  } catch {
    /* blocked storage keeps none */
  }
}

function read(languageId: string): ReturnType<typeof parseLive> {
  try {
    return parseLive(localStorage.getItem(keyFor(languageId)), languageId, Date.now());
  } catch {
    return null;
  }
}

function write(languageId: string, s: LiveSession): void {
  try {
    localStorage.setItem(keyFor(languageId), JSON.stringify(s));
  } catch {
    /* blocked or full storage: a reload here loses the session */
  }
}

function clear(languageId: string): void {
  try {
    localStorage.removeItem(keyFor(languageId));
  } catch {
    /* blocked storage holds none */
  }
}

// A reloading page's lock can outlive it by a moment.
const LOCK_TRIES = 8;
const LOCK_EVERY_MS = 150;

async function hold(languageId: string, tries: number): Promise<(() => void) | null> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return () => {};
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, LOCK_EVERY_MS));
    const release = await new Promise<(() => void) | null>((got) => {
      locks
        .request(keyFor(languageId), { ifAvailable: true }, (lock) => {
          if (!lock) return got(null);
          return new Promise<void>((done) => got(() => done()));
        })
        .catch(() => got(() => {}));
    });
    if (release) return release;
  }
  return null;
}

/** A language's kept session as one tab sees it. One tab at a time holds it
 *  (a Web Lock; where the browser has none, every tab may): only the holder
 *  reads or writes, or two tabs would go on with one conversation side by
 *  side, each overwriting the other. */
export interface LiveKeeper {
  readonly held: boolean;
  /** Called as the page goes, before this tab lets go (the session's last
   *  write). */
  leaving: (() => void) | null;
  /** Something is kept (whoever holds it): worth waiting for `take`. */
  some(): boolean;
  /** Hold it, waiting a moment for a page just reloaded to let go. */
  take(): Promise<boolean>;
  read(): { session: LiveSession; fresh: boolean } | null;
  /** Keep `s`, once this tab holds the language (it asks, if it doesn't). */
  write(s: LiveSession): void;
  /** The session is over: forget it, and let another tab have the language. */
  drop(): void;
  /** Let go without forgetting (the panel is going). */
  close(): void;
}

export function liveKeeper(languageId: string): LiveKeeper {
  let release: (() => void) | null = null;
  let asking: Promise<boolean> | null = null;
  // Moves on when the tab lets go: a lock that comes after that is let go.
  let term = 0;
  let next: LiveSession | null = null;
  const ask = (tries: number): Promise<boolean> => {
    if (release) return Promise.resolve(true);
    asking ??= (async () => {
      const mine = term;
      const got = await hold(languageId, tries);
      if (mine !== term) {
        got?.();
        return false;
      }
      asking = null;
      release = got;
      return !!got;
    })();
    return asking;
  };
  const letGo = () => {
    term += 1;
    asking = null;
    next = null;
    release?.();
    release = null;
  };
  return {
    leaving: null,
    get held() {
      return !!release;
    },
    some: () => read(languageId) !== null,
    take: () => ask(LOCK_TRIES),
    read: () => (release ? read(languageId) : null),
    write(s) {
      if (release) return write(languageId, s);
      next = s;
      void ask(1).then((ok) => {
        if (ok && next) write(languageId, next);
        next = null;
      });
    },
    drop() {
      if (release) clear(languageId);
      letGo();
    },
    close: letGo,
  };
}
