// Which words a Go-tab transcription tells Scribe to expect (ld-7q4): the
// pure half. The server reads the scenario and the phrase bank itself (web/
// server/voice.ts); nothing here touches either, so node --test covers it.
// Practice's speak-it never calls this: hinting the expected answer would
// hear it into the transcript.

import { scenarioEntries } from "./phrases.mjs";
import { MAX_KEYTERMS, keytermsFrom } from "./voice.mjs";

/** How many of the 100 each source may take, so one can't crowd out the
 *  rest: what the dojo master just asked for first, then the scene's own
 *  vocab, then the learner's recent phrases. */
export const KEYTERM_SHARE = { heard: 30, scenario: 50, bank: 20 };

/** The scenario's `vocab` terms, as Scribe keyterms; none for a scenario
 *  written for another language than the session's (those words aren't
 *  what the learner will say). Reuses the bank's own reading of a scenario
 *  (scenarioEntries) so the two can't disagree on what vocab is. */
export function scenarioKeyterms(scenario, sessionLocale) {
  return keytermsFrom(scenarioEntries(scenario, sessionLocale || null).complete.map((e) => e.text));
}

/** The learner's most recently seen complete phrases (newest first), up to
 *  `max`: a bank row is `{ text, suspended, lastSeenAt, createdAt }`. */
export function recentBankPhrases(rows, max = KEYTERM_SHARE.bank) {
  const when = (r) => Date.parse(r.lastSeenAt ?? r.createdAt ?? "") || 0;
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => typeof r?.text === "string" && r.text && !r.suspended)
    .sort((a, b) => when(b) - when(a))
    .slice(0, max)
    .map((r) => r.text);
}

/** The terms of one transcription: `heard` (the client's target phrases from
 *  the master's last turns, already bounded), `scenario` (terms) and `bank`
 *  (phrases), each under its share, deduplicated across, at most 100. */
export function sessionKeyterms({ heard = [], scenario = [], bank = [] }) {
  const out = [];
  const seen = new Set();
  for (const [list, share] of [[heard, KEYTERM_SHARE.heard], [scenario, KEYTERM_SHARE.scenario], [bank, KEYTERM_SHARE.bank]]) {
    let taken = 0;
    for (const t of keytermsFrom(list)) {
      if (taken >= share || out.length >= MAX_KEYTERMS) break;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      taken++;
    }
  }
  return out;
}
