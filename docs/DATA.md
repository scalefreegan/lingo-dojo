# Learners, memory and practice: the database design

Status: **phase 0 (foundation) built**; phases 1–11 are plan, not built
(2026-11-15). Epic `ld-gf9`,
"Postgres backend: logins, learners, phrase memory, practice modes". This
document is the contract for that work, the way `CONTENT.md` is for the
library and `VOICE.md` is for the Go tab. Change it here first, then the code.

## Why

Today Lingo Dojo has no memory. A voice session lives in the browser and is
gone after Restart ("Copy transcript" is the only way to keep it), the profile
is one YAML file per mode, and nothing knows which phrases you have met,
used, or keep missing. This design adds:

1. **Logins and learners.** A few people share the app on this Mac, each with a
   password. Under a login are one or more learners (you; your child in kids
   mode), Netflix-style.
2. **Saved conversations.** Every voice session's transcript is stored.
3. **A phrase bank per learner** with metrics: when each phrase was last seen,
   last practiced, and how well it is known (FSRS spaced repetition).
4. **Cross-session recall.** The dojo master recycles due phrases, sees what you
   have learned when it matters, and can ask for more; the content agent can
   read your bank and history.
5. **Practice modes** outside the conversation: flashcards (both directions),
   fill-in-the-blank, listening and speak-it drills. All feed the same memory.

## Decisions (interview, 2026-11-15)

| Question | Decision |
|---|---|
| Where it runs | This Mac, served to the tailnet with `tailscale serve` (added 2026-11-15; see Hosting on Tailscale). Built and verified on localhost first |
| Database | Homebrew Postgres, one database `lingo_dojo`, every personal row owned by a user/learner (not a DB per user) |
| Data access | Drizzle ORM: typed schema in TS, generated SQL migrations in git |
| What moves to the DB | Personal data only: users, learners (profiles), packs, conversations, phrases, reviews, per-user settings. Units, scenarios, schema and frame stay in git as the shared library |
| Kids | Learner profiles under a login; a kids learner needs no password of its own |
| Auth | Username + password, admin flag. Accounts made from a CLI. Only admins use the content agent |
| Existing files | One-time import (profiles → learners, packs → that learner's packs, `data/*` → the admin's settings); then the DB is the source |
| Per-user settings | Voice settings and casting, content-agent chat history, model choice |
| Phrase capture | All four: session glosses, a post-session extraction pass, manual add/star, scenario phrase lists |
| Mastery | FSRS (`ts-fsrs`) |
| Recall | Review block at session start; per-turn retrieval plus an on-demand `LOOKUP:` line; sessions update mastery; content agent can query |
| Transcripts | Text and metadata, no audio |
| Practice modes | Flashcards both ways, cloze, listening, speak-it |
| Grading | Lenient match first; a claude call only when the match fails |
| Deliverable | This doc plus beads; no code before review |

Choices made while writing this doc (not asked; flagged so they can be
overruled) are marked **(proposed)**.

## Architecture changes

```
browser ──cookie──▶ Vite middleware (web/server/*)
                     ├─ wrap(fn, {auth})  same-origin check + session lookup
                     ├─ db.ts             one pg Pool, Drizzle
                     ├─ auth.ts           /api/auth/*  login, logout, me, learner pick
                     ├─ content.ts        library (files, as now); packs → DB
                     ├─ voice.ts          turns persist to conversations; retrieval; LOOKUP
                     ├─ bank.ts           /api/phrases/*  bank CRUD, metrics
                     ├─ practice.ts       /api/practice/* queue, grade, review
                     └─ chat.ts           content agent (admin) + bank MCP (read-only)
scripts/
  db/schema.ts        Drizzle tables (shared by server, CLI, tests)
  db/migrations/      generated SQL, committed
  db/owned.ts         owned-row scopes: forLearner / forUser (built, phase 0)
  db/config.mjs       DATABASE_URL, migrations dir (built, phase 0)
  db/migrations.mjs   migration state for the boot check (built, phase 0)
  db/setup.mjs        CLI: db:setup / db:migrate (built, phase 0)
  fsrs.mjs            pure: rating mapping, mastery bands (wraps ts-fsrs)
  match.mjs           pure: answer normalization and lenient match
  recall.mjs          pure: review-block selection and retrieval ranking
  bank-mcp.mjs        stdio MCP server for the content agent (read-only role)
  user.mjs            CLI: add / passwd / list / admin
  import.mjs          CLI: one-time file → DB import (idempotent)
```

The pure modules (`fsrs`, `match`, `recall`, the extraction parser) follow the
existing rule: no server imports, covered by `node --test` directly.

`DATABASE_URL` lives in `.env.local` (default `postgres://localhost/lingo_dojo`),
read the same way as the voice keys (a `DATABASE_URL` in the shell wins).
`npm run db:setup` creates the database if it is missing and runs the
migrations; it is idempotent. `npm run db:migrate` only migrates. Later phases
extend it: the read-only `lingo_reader` role and its row-level security come
with bead `ld-t5f` (phase 8), and the offer to import with phase 2. The dev
server checks on boot that the database answers and migrations are current,
and refuses to start with a message naming `npm run db:setup` if not (a
half-migrated schema fails in confusing ways later). The check only reads; it
never migrates on its own. The HTTP tests mount the plugin with
`apiPlugins({ checkDatabase: false })`, so they need no Postgres.

## Schema

All ids are `uuid` (`gen_random_uuid()`), timestamps `timestamptz` (two
exceptions below: `packs.created` and `reviews.id`). Every personal table
carries `learner_id` (or `user_id` for account-level rows), and every query
goes through a helper that requires it, so a forgotten `where` is a type
error, not a leak.

As built (phase 0): child tables (`pack_revisions`, `turns`,
`phrase_examples`, `cards`, `reviews`, `cloze_items`) carry `learner_id`
too, denormalized, and reference their parent through a composite foreign
key on `(parent id, learner_id)`. A child can't belong to a different learner
than its parent, every personal table is filtered the same way, and the RLS
for `lingo_reader` can be a single `learner_id` policy per table. Deletes
cascade to children that mean nothing without their parent (a learner's
rows, a conversation's turns, a phrase's cards and reviews). Links that are
only provenance (`reviews.conversation_id`, `phrase_examples.conversation_id`
and `turn_id`, `auth_sessions.learner_id`) are set null instead, so deleting a
conversation never erases memory.

**The owned-row helper** is `scripts/db/owned.ts`:
`forLearner(db, learnerId)` and `forUser(db, userId)` return a scope with
`list`, `get`, `insert`, `update`, `remove` and `where`. Each one adds
`owner = id` (or stamps it on insert), the owner can't be set or changed
through it, and a table without that owner column doesn't type-check
(`scripts/db/owned.typecheck.ts` pins this). `where(table, cond)` is for joins
and aggregates. The server's raw handle is `rawDb()` in `web/server/db.ts`,
and it's only for owner-less lookups (a login by username, a session by token
hash).

### Accounts

```
users           id, username (unique, lowercased), password_hash, is_admin,
                created_at, disabled_at
auth_sessions   id (sha256 of the cookie token), user_id, learner_id (active),
                created_at, expires_at, last_seen_at
                (that learner_id belongs to user_id is checked in code: a
                composite key could not set just learner_id null)
learners        id, user_id, name, mode (adult|kids), native_language,
                target_language, target_variant, level, goals, notes,
                created_at, archived_at
user_settings   user_id (pk), model, voice jsonb (today's data/voice.json shape)
agent_messages  id, user_id, role (user|assistant|commit), text, ts
                                                     (was data/chat.jsonl)
```

`learners` holds exactly the profile keys `profile.yaml` has today, so
`assemble()` takes a learner row where it took `content.profile`. The
`profile.yaml` files stay as seeds for a fresh install and for the offline
`npm run export` CLI.

### Packs

```
packs           id, learner_id, folder ('' or one kebab segment), slug,
                title, created, scenario, quick_scenario, units jsonb,
                overrides jsonb, notes, updated_at, deleted_at
                unique (learner_id, folder, slug) where deleted_at is null
pack_folders    learner_id, name, created_at; pk (learner_id, name)
pack_revisions  id, pack_id, learner_id, snapshot jsonb, action, at
```

As built: `created` is `text`, the wire value verbatim (ISO with its offset).
`timestamptz` would drop the offset, and the pack's date stem is the
learner's local date. `pack_folders` was added because the Library lists
empty folders, which `packs.folder` alone can't express.

The wire `Pack.id` stays `folder/slug`, so the Library and Scene tabs keep
working unchanged. Git used to make every pack change undoable. Here
`pack_revisions` does that job (a snapshot per write, move, rename or delete),
and deletes are soft.

### Conversations

```
conversations   id, learner_id, pack_snapshot jsonb, scenario_id, title,
                mode, target_variant, model, planned_minutes, started_at,
                ended_at, turn_count, summary, extraction jsonb, extracted_at
turns           id, conversation_id, learner_id, idx, role (learner|master),
                text, lines jsonb, glosses jsonb, choices jsonb, stage,
                cast_notes jsonb, duration_ms, cost_usd, lookup jsonb,
                created_at
                unique (conversation_id, idx)
```

`pack_snapshot` freezes what was played, since packs change later. `turns`
stores the same shapes `VoiceHistoryItem` already has, so a stored conversation
can be shown with the existing transcript components.

### Phrase bank

```
phrases         id, learner_id, lang (BCP-47 of the target variant, e.g. es-MX),
                text (target form; null while pending), norm (match key),
                meaning (native language), note, source
                (gloss|extraction|manual|scenario), alternates jsonb
                (accepted other forms, default []), starred, suspended,
                first_seen_at, last_seen_at, seen_count,
                last_practiced_at, created_at
                unique (learner_id, lang, norm)
                trigram GIN indexes on text and meaning
phrase_examples id, phrase_id, learner_id, conversation_id, turn_id,
                sentence, speaker, created_at
cards           id, phrase_id, learner_id, skill (recognize|listen|produce),
                fsrs state: due, stability, stability_fast, difficulty,
                scheduled_days, learning_steps, reps, lapses, state,
                last_review
                unique (phrase_id, skill); index (learner_id, due)
reviews         id (bigserial), card_id, learner_id, mode
                (flashcard|cloze|listening|speak|session), rating (1-4),
                answer, verdict (exact|close|accepted|wrong|self),
                grader_note, duration_ms, reviewed_at, conversation_id
cloze_items     id, phrase_id, learner_id, sentence, blank_start, blank_end,
                hint, origin (example|generated), created_at
```

As built, the `cards` columns follow ts-fsrs 6.0.0. Its `Card` type is due,
stability, difficulty, scheduled_days, learning_steps, reps, lapses, state
and last_review. It has no `elapsed_days` (that is now − last_review). Its
default FSRS-7 scheduler adds `stabilityFast` and schedules fractional days,
so `stability_fast` is a nullable column and `scheduled_days` is a double.
FSRS-7's `scheduleStatus` (new|learning|review) is derived from `state`, not
stored. `reviews.id` is a `bigserial`: the table is append-only and the
busiest one.

- **Identity.** `norm` is NFC, case-folded, outer punctuation (including ¿ ¡ 「 」)
  and repeated spaces removed. Accents are kept: *papa* and *papá* are different
  phrases. Same `(learner, lang, norm)` means the same phrase, so a gloss of
  "¿A cómo?" in two sessions bumps one row.
- **Pending phrases.** A scenario's `phrases:` list is English meanings. Those
  enter as rows with `meaning` set and `text` null. The first gloss or
  extraction that pairs a target form with that meaning fills it in. Scenario
  `vocab:` entries (target term + gloss) enter complete.
- **Language.** A phrase belongs to the variant it was learned in (`es-MX`).
  Recall and practice use the learner's current variant's language prefix, so
  switching to Castilian still shows the Mexican Spanish bank, while Japanese
  never does.
- **Three cards per phrase (proposed).** Recognize (read → meaning), listen
  (hear → meaning), produce (meaning → target, typed or spoken). These are
  separate memories, as in Anki's two-sided cards. Cards are created lazily: a
  phrase gets `recognize` when first seen, and `listen`/`produce` the first time a
  mode or session exercises them. The phrase's shown **mastery** is the weakest of
  its cards that exist, so a phrase you understand but can't say is not "mastered".

### Metrics the bank shows

| Metric | Source |
|---|---|
| Last seen | `last_seen_at`: glossed or used in a session, or a card shown in practice |
| Times seen | `seen_count` |
| Last practiced | `last_practiced_at`: any review, practice or session |
| Mastery | band from the weakest card: **New** (no reviews), **Learning** (stability < 3 days), **Familiar** (< 21 days), **Mastered** (≥ 21 days, Anki's "mature" line) |
| Due | earliest `cards.due` |
| Trouble | lapses in the last 30 days |

## Auth

- **Passwords:** `scrypt` from `node:crypto` (proposed: no native dependency; argon2
  would need `@node-rs/argon2`). Stored as `scrypt$N$r$p$salt$hash`; checked with
  `timingSafeEqual`.
- **Sessions:** a random 32-byte token in an `httpOnly`, `SameSite=Lax` cookie
  `ld_session`. It is also `Secure` whenever the request came in over HTTPS
  (`X-Forwarded-Proto: https`, which `tailscale serve` sets), and plain on
  `http://localhost`. Only its SHA-256 is stored. They expire after 30 days,
  sliding. Logout deletes the row.
- **`wrap()`:** it keeps the same-origin check and gains an access level:
  `wrap(fn, { auth: "public" | "user" | "admin" })`. The default is `"user"`, so a
  new route is protected unless it says otherwise. Only `/api/auth/login` and
  `/api/auth/me` are public. The handler receives `ctx = { user, learner }`.
- **Admin-only routes:** the content agent (`/api/chat`), library reloads and
  anything that writes `content/`.
- **Login throttling:** after 5 failures per username in 15 minutes, logins for
  that username wait 30 seconds. This is in memory, which is enough for one Mac.
- **Accounts:** `npm run user -- add <name> [--admin]`, `passwd`, `list`,
  `disable`. There is no sign-up page.
- **Learners:** after login, a "Who's practicing?" picker lists the account's
  learners (with Add). The choice is stored on the auth session (`learner_id`).
  The top bar shows the learner and switches between them. Switching to a kids
  learner switches to kids mode, so the mode now comes from the learner.

Routes that took `?mode=` change as follows:

- Pack, profile, assemble, export and voice routes use the active learner's
  mode, and answer 400 if a `?mode` they're sent disagrees.
- `GET /api/content?mode=` keeps the parameter, because an admin browses and
  edits both libraries.

## Conversations

1. On the first turn of a session, the client calls `POST /api/conversations`
   with the pack. The server stores a conversation with the pack snapshot and
   returns its `id`. Restart starts a new conversation.
2. `POST /api/voice/turn` carries `conversationId`. After a successful turn,
   the server appends the learner turn and the master turn in one transaction.
   The client still sends the history (proposed for phase 1: VoicePanel's retry,
   recast and "check what it heard" flows stay as they are). Reading the history
   from the DB instead is a later simplification.
3. **End** (a new button, or closing or leaving the Go tab with a conversation
   open) sets `ended_at` and queues the extraction. A conversation left open for
   2 hours is ended on the next server request (proposed).
4. **One turn at a time per conversation.** Today a single global flag refuses
   a second voice turn while any turn is running. With more than one person
   practicing, that flag becomes a lock keyed by conversation id, so two
   learners never block each other and one conversation still can't race itself.
5. A **History** view (Library tab, proposed) lists past conversations with
   their summaries and opens one read-only in the transcript components.

## Phrase capture

| Source | When | What it writes |
|---|---|---|
| Glosses | each turn, in the turn transaction | upsert phrase (`source=gloss`); `seen_count`+1; `last_seen_at`; example = the line holding the term; `recognize` card if none. No FSRS review: seeing is not recalling |
| Scenario lists | conversation start | `vocab:` → complete phrases; `phrases:` → pending phrases (meaning only) |
| Manual | tapping a glossed word → ☆ Star; Add in the bank | upsert, `starred=true` |
| Extraction | after End | see below |

### Post-session extraction

One `claude -p` call (no tools, the agent model), given the transcript, the
learner's target variant and the phrases that were due for this session. It
returns JSON:

```json
{
  "summary": "Two or three sentences: what happened, what went well.",
  "keep": [{ "text": "¿Me lo envuelve?", "meaning": "Could you wrap it for me?", "example": "…", "why": "asked twice" }],
  "events": [
    { "phrase": "¿A cómo?", "kind": "produced" },
    { "phrase": "la vuelta", "kind": "corrected", "said": "el cambio", "note": "change (coins back)" }
  ],
  "corrections": [{ "said": "…", "better": "…", "note": "…" }]
}
```

Event kinds and how they update FSRS (a review with `mode=session`):

| Event | Card | Rating |
|---|---|---|
| `produced`: the learner said it unprompted and correctly | produce | Good |
| `produced_with_help`: after a hint, a repeat or choices | produce | Hard |
| `corrected`: the learner tried and was corrected | produce | Again |
| `understood`: they answered a line using it appropriately | listen | Good |
| `confused`: they asked what it meant or answered off-target | listen | Again |

The parser is pure and strict. An unknown phrase in `events` is matched by
`norm` and otherwise created from `keep`, and anything malformed is dropped
with a logged warning. On invalid JSON there is one retry, after which the
conversation keeps `extracted_at` null and offers "Retry recap". The summary
and corrections show as a **Session recap** card under the transcript after
End: new phrases (with ☆), what you nailed, and what to fix.

Out-of-schedule reviews are fine: FSRS takes the real elapsed time into
account. A phrase gets at most one session review per card per conversation.

## Recall in sessions

### 1. Review block (session start)

There is a new placeholder, `{{phrase_review}}`, used by a new default unit in a
new `recall` slot. The adult unit is `recycle-due-phrases`. The kids unit is a
gentler `recycle-words`: it brings back up to three words, by ear, with no
testing.

`assemble()` stays pure. The server computes the list and passes it in:
`assemble(content, pack, { learner, review })`. `recall.mjs` picks it:

- due or overdue `produce`/`listen` cards in the learner's language,
- ranked by how overdue they are, plus a relevance boost (trigram similarity
  to the scenario's title, summary, tags and phrases), and starred phrases,
- at most 10 (3 for kids).

It renders as a list of "target — meaning" pairs with the instruction to work
them into the scene naturally, not as a quiz. When the bank is empty, the unit
renders a single line instead ("No phrases due yet."), so the prompt stays
deterministic for the same inputs. The export and Copy include the block too,
so a pasted session into ChatGPT voice also recycles phrases.

### 2. Per-turn retrieval (every turn, no model)

Before each turn, the server searches the bank using the learner's message and
the master's last line. The search is `pg_trgm` `word_similarity` on `text` and
`meaning`; trigrams rather than full-text, because full-text tokenizing breaks
on Japanese and Mandarin. The top 6 hits above a threshold are appended to the
turn prompt as:

```
[FROM THE LEARNER'S PHRASE BANK]
¿A cómo? — how much? (familiar; last practiced 3 days ago)
```

This takes milliseconds, and the dojo master can use or ignore it.

### 3. `LOOKUP:` (on demand)

The voice adapter gains one optional line. When the dojo master needs
something it wasn't given, it can reply with a lookup instead of speaking.
Examples: "what did I learn last week about the market?", or wanting to
reference a past session.

```
LOOKUP: market phrases from last week
```

The server runs that query against the phrases and the conversation summaries
(trigram, plus a date window when the query names one). It then reruns the
turn once, with the results under `[LOOKUP RESULTS]`, and a second `LOOKUP`
in the rerun is ignored. Only those turns pay a second model call. The turn
row records the lookup. `parseVoiceReply` ignores `LOOKUP:` lines, so they are
never spoken.

### 4. Content agent

For admins, the chat agent gets a read-only MCP server (`scripts/bank-mcp.mjs`,
stdio), scoped to the active learner. It offers four tools:

- `search_phrases(query)`
- `trouble_phrases(limit)`
- `recent_conversations(limit)`
- `get_conversation(id)`

It connects as the Postgres role `lingo_reader` (SELECT only on the
personal tables, with row-level security on `learner_id` via
`set_config('app.learner_id', …)`), so even a prompt-injected agent can't write
to or read beyond that learner. That makes requests like "write a scenario
that drills what I keep missing" possible. The agent's file permissions are
unchanged.

## Practice modes

There is a new top-level **Practice** tab and a **Phrase bank** view (inside
Practice, proposed). Practice builds a queue from due cards, mixed by default
and filterable by mode, with daily limits (20 new and 100 reviews, proposed) and
a session length picker (5 / 10 / 20 items).

| Mode | Card | Prompt | Answer | Grading |
|---|---|---|---|---|
| Flashcard → | recognize | target text (▶ audio) | type the meaning, or Reveal | lenient match → claude on miss; Reveal = self-grade |
| Flashcard ← | produce | meaning | type the target | lenient match → claude on miss |
| Cloze | produce | a sentence with the phrase blanked + the meaning as a hint | type or say the missing words | lenient match → claude on miss |
| Listening | listen | audio only (the learner's voice settings) | pick 1 of 4 meanings (proposed) or type | choice: instant; typed: as above |
| Speak-it | produce | meaning | say it; Scribe transcribes | lenient match → claude on miss |

- **Cloze sentences** come from `phrase_examples`, real lines from your own
  sessions, when a phrase has any. Otherwise one claude call generates them for
  a batch of up to 10 due phrases when the queue is built, cached in
  `cloze_items`.
- **Audio:** the existing `/api/voice/speak` with the learner's voices, cached
  on disk at `data/audio/<sha256(voice+text)>.mp3`, so a card never pays
  ElevenLabs twice.
- **Speak-it** does not pass the expected answer to Scribe as a keyterm, since
  that would hear the answer into the transcript. Pronunciation scoring stays
  `ld-e80`.

### Grading (`match.mjs`, pure)

- **Normalize.** NFC, case-fold, strip punctuation, collapse whitespace. For CJK
  languages, also drop spaces.
- **Exact.** The answer equals the expected target, or any alternate the bank
  holds. This grades as `exact` → Good.
- **Close.** The answer equals the target once accents are stripped, or is
  within edit distance 1 for answers of at least 6 characters. This grades as
  `close` → Hard, with "check the accent" or a highlighted letter. For spoken
  answers, accent-only differences count as exact, since STT chooses the
  spelling.
- **Miss.** One claude call (Haiku, no tools) gets the question, the expected
  answer and the learner's answer. It returns `{ accepted, rating_hint, note }`:
  `accepted` covers a valid synonym, another correct phrasing or a correct
  meaning in other words. An accepted answer is stored as an alternate for that
  phrase, so the same answer is exact next time.
- **Override.** After any verdict, the learner can change it with
  Again / Hard / Good / Easy. The override is what FSRS records, with
  `verdict=self`.
- **Recognize cards.** Meanings in the native language vary a lot, so these
  lean on the claude check (or self-grade via Reveal). The claude check is told
  to be generous.

### Kids learners (proposed)

Kids get the phrase bank, session capture and the review block in v1. The
practice modes above assume reading and typing, which conflicts with kids
goals ("entirely by ear"), so the Practice tab is hidden for kids learners. A
follow-up bead covers a kids audio game (hear a word, tap a picture).

## Session length (added 2026-11-15; does not need the database)

Sessions run longer than the time available. Before a session starts, the Go
tab asks **"How long do you have?"** and the dojo master paces the whole
session, warm-up, scene and debrief, to finish in that time. Everything below
is proposed; none of it was asked in the interview.

- **Picker:** 5 · 10 · 15 · 20 · 30 minutes · No limit (kids: 3 · 5 · 10 · No
  limit). It defaults to the last choice, which is kept with the voice settings
  (per user once logins land). A pack may carry `overrides.minutes` as its own
  default.
- **In the prompt:** the assembler renders a **Time budget** section when minutes
  are set. It gives the total and a rough split across the session's parts (the
  same parts the timeline shows), and tells the dojo master how to shrink:
  fewer beats (a 5-minute session plays one or two), shorter or skipped warm-up
  drills, a debrief of one or two points. It is deterministic, and it is part of
  the export, so a session pasted into another voice tool is paced too (there
  the model can only estimate the time from the number of turns).
- **A clock each turn (in-app only):** the model has no sense of time, so the
  server adds one line to every turn prompt: minutes used, minutes left, and
  the current part. From about 80% used it says to start closing the scene. At
  100% it says to finish within this turn and the next: end the scene and give
  the short debrief. The session is never cut off; the learner can keep going.
- **Timing source:** elapsed time since the first turn, sent by the client. Once
  conversations are stored, the server uses `conversations.started_at` and
  records `planned_minutes`.
- **UI:** the timeline shows the time left, and a **+5 min** button extends the
  budget mid-session.

## Hosting on Tailscale

The app will be served from this Mac to the tailnet: `tailscale serve` proxies
`https://<mac>.<tailnet>.ts.net` to `http://localhost:38400`. That gives other
devices the HTTPS the microphone needs, and only tailnet devices can reach it.

Needed now:

- The server keeps listening on localhost only. Tailscale is the one way in, and
  Postgres stays on localhost.
- Vite refuses hostnames it doesn't know, so the tailnet name goes in
  `server.allowedHosts`, read from `LINGO_PUBLIC_HOST` in `.env.local` so the
  name isn't committed.
- The same-origin check compares `Origin` with `Host`. `tailscale serve` passes
  the public host through, and a test pins that case.
- The `Secure` cookie rule (Auth) and the per-conversation turn lock
  (Conversations).

Not now (no beads filed; revisit when someone besides the owner uses it
regularly, or when the need shows up):

- A production server in place of the Vite dev server.
- Per-user daily caps on Claude and voice-provider usage (every user's turns run
  on the owner's Claude login and keys).
- Signing in by tailnet identity (`Tailscale-User-Login`) without a password.
- Tailscale Funnel (public internet), which would need a hardened login first.
- Hosting on another machine.

## Import (one time, idempotent)

`npm run db:import` does the following:

1. Creates the admin user if there's none, prompting for a password.
2. Makes `content/profile.yaml` the admin's adult learner and
   `content/kids/profile.yaml` a kids learner. It reads the working tree, so
   local, uncommitted profile edits are what gets imported.
3. Copies every pack under `content/packs/**` and `content/kids/packs/**` to the
   matching learner, keeping folder, slug and created date.
4. Copies `data/voice.json`, `data/settings.json` and `data/chat.jsonl` to the
   admin's settings and agent messages.
5. Skips anything already imported (matched by learner + folder + slug), so
   it's safe to re-run.

After the import, the pack routes stop writing YAML and stop making git
commits. The YAML stays in git as seed content, and `npm run export` keeps
working on files offline.

## Backups (proposed)

Personal data leaves git, so it needs its own safety net. `npm run db:backup`
does a `pg_dump -Fc` to `backups/` (gitignored), keeping the last 14. An
optional launchd plist (in `macos/`) runs it daily. `pack_revisions` and soft
deletes cover undoing a single change.

## Testing

- **Unit tests:** the pure modules (`fsrs`, `match`, `recall`, the extraction
  parser, `LOOKUP` parsing) run under `node --test` as now.
- **Database tests:** they run on **PGlite** (in-process WASM Postgres; Drizzle
  supports it) with the real migrations applied, so `npm test` needs no running
  server and never touches the dev database. Built in phase 0 and confirmed:
  PGlite 0.5 (Postgres 18) loads `pg_trgm` from `@electric-sql/pglite/contrib`,
  the committed migration SQL applies there unchanged, and `word_similarity`
  works, CJK included. The no-server fallback (a throwaway
  `lingo_dojo_test_<pid>` database) is therefore not built. The harness is
  `freshDb()` in `scripts/tests/testdb.mjs`. It returns `{ db, query, client,
  close }`, a fresh migrated database whose `db` is the same Drizzle API the
  server uses. It migrates once per process and boots each database from that
  image, about 0.1 s each.
- **Isolation:** routes are tested with a seeded user and learner, including a
  second user whose rows must never appear (a cross-tenant test for every
  list route).
- **UI:** login, the learner picker, a voice session that persists and
  recaps, and each practice mode are verified in the real app with Playwright
  before a bead closes (CLAUDE.md).

## Docs to update as phases land

- `PRD.md`: the "no database" decision, the non-goals (feedback loop, multi-user)
  and the architecture tree.
- `CLAUDE.md`: the no-database line, the `data/` description, the auth rule in
  `wrap()`, and the test database rule.
- `CONTENT.md`: the `recall` slot, `{{phrase_review}}`, and packs living in the DB.
- `VOICE.md`: "Nothing is saved", `LOOKUP:`, per-turn retrieval, and per-user
  settings.

## Phases

| # | Phase | Needs |
|---|---|---|
| 0 | Postgres + Drizzle foundation: setup scripts, schema v1 (every table above), migrations, PGlite test harness, boot check. **Built** | none |
| 1 | Auth + learners: login, sessions, `wrap` auth levels, user CLI, learner picker, profile on DB, admin-only agent, per-user settings | 0 |
| 2 | Packs in the DB + import: packs, revisions, folders, import script, drop the pack git commits | 1 |
| 3 | Conversations: persist turns, End, the History view | 1 |
| 4 | Phrase bank: tables, gloss capture, scenario lists, star/add, the bank UI with metrics | 3 |
| 5 | Session extraction: claude pass, FSRS from sessions, the recap card | 4 |
| 6 | Recall: the review block (slot, units, placeholder), per-turn retrieval, `LOOKUP` | 4 |
| 7 | Practice: tab and queue, the FSRS service, grader, flashcards, cloze, listening, speak-it, audio cache | 4 |
| 8 | Content agent bank MCP with the read-only role and RLS | 4 |
| 9 | Backups | 2 |
| 10 | Tailscale serve: allowed host, origin test, verify login and a voice turn from a second device | 1 |
| 11 | Session length: picker, Time budget section, per-turn clock, +5 min | none (can ship first) |

Phases 5–8 can run in parallel once 4 lands.

## Open questions

These are proposals, made without asking:

- Three cards per phrase, with mastery taken from the weakest card.
- Listening defaults to multiple choice.
- Kids are left out of the practice modes in v1.
- PGlite for tests (built and working; see Testing).
- scrypt over argon2.
- An auto-end after 2 hours.
- Daily limits of 20 new and 100 reviews.
- Practice and History placement in the UI.
