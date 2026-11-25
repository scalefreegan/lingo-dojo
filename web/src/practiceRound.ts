/* A practice round in progress, kept so a reload goes on from the card it
 * was at (docs/DATA.md §Practice modes). Each answer is the server's as soon
 * as it is given; this is only which cards are still to come. One per
 * language profile and browser tab (a second tab starts its own), for as long
 * as the cards are still worth asking: a card that has moved on since (another device, an edited
 * phrase) is refused by its version, as it is on any stale page. */

import { languageKey } from "./draft.ts";
import type { PracticeAnswerReply, PracticeItem, PracticeRating } from "./types";

export const ROUND_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const KEY = "lingo-dojo.practice-round.v1";

/** One answered card, for the round's summary: the words and meaning from
 *  the answer's reply (a listening card's item carries neither). */
export interface DoneCard {
  key: string;
  text: string;
  meaning: string;
  lang: string;
  rating: PracticeRating;
}

export const doneCard = (item: PracticeItem, answered: PracticeAnswerReply): DoneCard => ({
  key: `${item.phraseId}:${item.skill}`,
  text: answered.expected.text,
  meaning: answered.expected.meaning,
  lang: item.lang,
  rating: answered.review.rating,
});

export interface PracticeRound {
  items: PracticeItem[];
  /** The card to show; one past the last when only the summary is left. */
  index: number;
  done: DoneCard[];
}

const DRILLS = ["flashcard", "listening", "speak", "cloze"];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/** What storage held as a round, or null: none, too old, or not one. */
export function parseRound(raw: string | null, now: number): PracticeRound | null {
  try {
    const d: unknown = raw ? JSON.parse(raw) : null;
    if (!isObj(d) || typeof d.at !== "number" || now - d.at >= ROUND_MAX_AGE_MS) return null;
    const { items, index, done } = d;
    if (!Array.isArray(items) || !items.length || !items.every((i) => isObj(i) && typeof i.phraseId === "string" && DRILLS.includes(i.drill as string))) return null;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > items.length) return null;
    if (!Array.isArray(done) || !done.every((c) => isObj(c) && typeof c.key === "string" && typeof c.text === "string" && typeof c.rating === "number")) return null;
    return { items, index, done };
  } catch {
    return null;
  }
}

export function readRound(languageId: string): PracticeRound | null {
  try {
    return parseRound(sessionStorage.getItem(languageKey(KEY, languageId)), Date.now());
  } catch {
    return null;
  }
}

export function writeRound(languageId: string, round: PracticeRound): void {
  try {
    sessionStorage.setItem(languageKey(KEY, languageId), JSON.stringify({ at: Date.now(), ...round }));
  } catch {
    /* blocked or full storage: a reload starts a new round */
  }
}

export function clearRound(languageId: string): void {
  try {
    sessionStorage.removeItem(languageKey(KEY, languageId));
  } catch {
    /* blocked storage holds none */
  }
}
