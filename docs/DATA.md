# Learners, memory and practice: the database design

Status: **phase 0 (foundation) and phase 1 (logins and learners) built**;
phases 2–11 are plan, not built (2026-11-15). Epic `ld-gf9`,
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
                     ├─ db.ts             one pg Pool, Drizzle (setDb: the tests' PGlite)
                     ├─ auth.ts           /api/auth/*  login, logout, me, first run, learner pick;
                     │                    /api/learners  (built, phase 1)
                     ├─ seed.ts           the first admin's seed from the old files (built, phase 1)
                     ├─ store.ts          per-user settings and agent chat (built, phase 1)
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
  db/migrations.mjs   by-hash migrator and migration state (built, phase 0)
  db/hand-edits.mjs   the documented hand edits to 0000_init.sql (built, phase 0)
  db/setup.mjs        CLI: db:setup / db:migrate (built, phase 0)
  db/accounts.ts      users, sessions, learners, settings, agent messages (built, phase 1)
  auth.mjs            pure: scrypt, tokens, the cookie, the login throttle (built, phase 1)
  fsrs.mjs            pure: rating mapping, mastery bands (wraps ts-fsrs)
  match.mjs           pure: answer normalization and lenient match
  recall.mjs          pure: review-block selection and retrieval ranking
  bank-mcp.mjs        stdio MCP server for the content agent (read-only role)
  user.mjs            CLI: add [--admin] / passwd / list / disable / enable (built, phase 1)
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
`apiPlugins({ checkDatabase: false, db })`, `db` being a `freshDb()` PGlite
that every route then uses (`setDb` in `web/server/db.ts`), so they run the
real routes and need no Postgres.

**Migrations are tracked by hash** (`scripts/db/migrations.mjs`), in
drizzle's own `drizzle.__drizzle_migrations` table. We don't use drizzle's
migrator. It treats a migration as applied when its timestamp is at or below
the newest recorded one, so two branches that each generate a migration and
merge in the other order leave one silently unapplied. The database is
current only when the recorded hashes and the files on disk match exactly.
Otherwise it is one of these:

- *behind*: newer files not yet applied
- *skipped*: an older file never ran
- *ahead*: the database has migrations this checkout doesn't
- *diverged*: both ahead and missing files

The boot check refuses all four. `db:setup` / `db:migrate` apply every
missing file by hash in one transaction (which repairs *skipped*), and refuse
*ahead* and *diverged* without changing anything.

**Rules for branches and migrations:**

- **Never the real database from a branch.** A branch or worktree never
  points at the real database. In a linked git worktree (its `.git` is a file)
  with no `DATABASE_URL` in the shell or its own `.env.local`, the server,
  `db:setup` and `db:migrate` refuse to default to `lingo_dojo` and ask for a
  scratch database.
- **One branch at a time.** New migrations are added one branch at a time,
  never in parallel branches.
- **Write for PostgreSQL 17.** Migration SQL must run on PostgreSQL 17
  (Homebrew), even though the tests run on PGlite (PostgreSQL 18).

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
rows, a conversation's turns, a phrase's cards and reviews).

Links that are only provenance are composite too, so they can't point at
another owner's row:

| Link | References |
|---|---|
| `reviews.conversation_id` | `conversations (id, learner_id)` |
| `phrase_examples.conversation_id` | `conversations (id, learner_id)` |
| `phrase_examples.turn_id` | `turns (id, learner_id)` |
| `auth_sessions.learner_id` | `learners (id, user_id)` |

On delete they null only the link column: `ON DELETE SET NULL (col)`, which
needs PostgreSQL 15+. Deleting a conversation never erases memory, and
deleting a learner sends its sessions back to the picker.

drizzle-kit can't write the column list, so `0000_init.sql` is drizzle-kit's
output plus exactly two documented hand edits:

1. `CREATE EXTENSION pg_trgm`.
2. The four `SET NULL (col)` clauses.

Both live in `scripts/db/hand-edits.mjs`. `scripts/tests/db-migrations.test.mjs`
regenerates the SQL from `schema.ts`, checks that the committed file is
exactly that output with the hand edits applied, checks that `schema.ts` has
no change missing from the snapshot, and checks the delete columns in the
catalog.

**The owned-row helper** is `scripts/db/owned.ts`:
`forLearner(db, learnerId)` and `forUser(db, userId)` return a scope with
`list`, `get`, `insert`, `upsert`, `update`, `remove`, `removeAllOwned` and
`where`. Each one adds `owner = id and (cond)`, or stamps the owner on insert.
The caller's condition is always parenthesized, so a raw `a or b` can't
escape the filter.

- **Types.** The owner can't be set or changed through a scope, and a table
  without that owner column doesn't type-check (`scripts/db/owned.typecheck.ts`
  pins this).
- **Runtime.** For untyped callers, a table without the owner column, an owner
  in the values, or an `update`/`remove`/`get` without a condition throws.
  Removing all of an owner's rows is the separate `removeAllOwned`.
- **`upsert`.** `INSERT … ON CONFLICT (owner, …target) [WHERE targetWhere] DO
  UPDATE SET … WHERE owner = id`. The owner is always part of the conflict
  target.
- **`where(table, cond)`** is for joins and aggregates.

The server's raw handle is `rawDb()` in `web/server/db.ts`, and it's only for
owner-less lookups (a login by username, a session by token hash, the
zero-users check of the first run). As built, every account query is in
`scripts/db/accounts.ts`, so the raw uses are in one file.

### Accounts

```
users           id, username (unique, lowercased), password_hash, is_admin,
                created_at, disabled_at
auth_sessions   id (sha256 of the cookie token), user_id, learner_id (active;
                one of user_id's learners, composite key), created_at,
                expires_at, last_seen_at
learners        id, user_id, name, mode (adult|kids), native_language,
                target_language, target_variant, level, goals, notes,
                created_at, archived_at; unique (id, user_id)
user_settings   user_id (pk), model, voice jsonb (today's data/voice.json shape)
agent_messages  id, user_id, seq (bigserial: order by it), role
                (user|assistant|commit), text, ts    (was data/chat.jsonl)
```

`learners` holds exactly the profile keys `profile.yaml` has today, so
`assemble()` takes a learner row where it took `content.profile`. The
`profile.yaml` files stay as seeds for a fresh install and for the offline
`npm run export` CLI. As built, `assemble()`'s signature is unchanged: the
server hands it the library with `profile` replaced by the learner as
profile keys (`profileFromLearner`, blanks left out), so the export CLI and
the app share one assembler.

### Packs

```
packs           id, learner_id, folder ('' or one kebab segment), slug,
                title, created, scenario, quick_scenario, units jsonb,
                overrides jsonb, notes, updated_at, deleted_at
                unique (learner_id, folder, slug) where deleted_at is null
pack_folders    learner_id, name, created_at; pk (learner_id, name)
pack_revisions  id, pack_id, learner_id, seq (bigserial: order by it),
                snapshot jsonb, action, at
```

As built: `created` is `text`, the wire value verbatim (ISO with its offset).
`timestamptz` would drop the offset, and the pack's date stem is the
learner's local date. `pack_folders` was added because the Library lists
empty folders, which `packs.folder` alone can't express. `seq` on
`pack_revisions` and `agent_messages` gives the true order: `at`/`ts` is
`now()`, the transaction's start, so rows written in one transaction tie.

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
                unique (conversation_id, idx); unique (id, learner_id)
```

`pack_snapshot` freezes what was played, since packs change later. `turns`
stores the same shapes `VoiceHistoryItem` already has, so a stored conversation
can be shown with the existing transcript components.

### Phrase bank

```
phrases         id, learner_id, lang (BCP-47 of the target variant, e.g. es-MX),
                text (target form; null while pending), norm (match key of
                text; null while pending), meaning (native language),
                meaning_norm (a pending row's key), note, source
                (gloss|extraction|manual|scenario), alternates jsonb
                (accepted other forms, default []), starred, suspended,
                first_seen_at, last_seen_at, seen_count,
                last_practiced_at, created_at
                unique (learner_id, lang, norm) where text is not null
                unique (learner_id, lang, meaning_norm) where text is null
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
                grader_note, duration_ms, reviewed_at, conversation_id,
                card_before jsonb (the card's FSRS state before this review)
                unique (card_id, conversation_id) where mode = 'session'
cloze_items     id, phrase_id, learner_id, sentence, blank_start, blank_end,
                hint, origin (example|generated), created_at
```

As built, the `cards` columns follow ts-fsrs 6.0.0. Its `Card` type is due,
stability, difficulty, scheduled_days, learning_steps, reps, lapses, state
and last_review. It has no `elapsed_days` (that is now − last_review). Its
default FSRS-7 scheduler adds `stabilityFast` and schedules fractional days,
so `stability_fast` is a nullable column and `scheduled_days` is a double.
FSRS-7's `scheduleStatus` (new|learning|review) is derived from `state`, not
stored. In Drizzle, the FSRS columns keep ts-fsrs's snake_case
names as their JS keys, so `scripts/fsrs.mjs` `toRow()` spreads straight into
an insert or update, and a selected row goes straight into `fromRow()`. A test
round-trips a card through two reviews. `reviews.id` is a `bigserial`: the table is append-only and the
busiest one.

The trigram GIN indexes serve the **LOOKUP** direction: a short query found
inside phrases (`query <% text`). Per-turn retrieval runs the other way, a
phrase found inside the learner's message (`word_similarity(text, message)`),
and these indexes can't serve it. That query scans the learner's own rows,
which is fine at the size of one learner's bank.

- **Identity.** `norm` is NFC, case-folded, outer punctuation (including ¿ ¡ 「 」)
  and repeated spaces removed. Accents are kept: *papa* and *papá* are different
  phrases. Same `(learner, lang, norm)` means the same complete phrase, so a gloss
  of "¿A cómo?" in two sessions bumps one row. The gloss write is the scope's
  `upsert` on that partial index (`target: [lang, norm]`, `targetWhere: text is
  not null`).
- **Pending phrases.** A scenario's `phrases:` list is English meanings. Those
  enter as rows with `meaning` and `meaning_norm` set and `text`/`norm` null
  (a check enforces complete-or-pending). They have their own identity,
  `(learner, lang, meaning_norm)`, so a pending "taxi" (English) never
  captures the later gloss of the target word "taxi". **Merge rule:** when a
  gloss or extraction pairs a target form with a pending row's meaning, the
  pending row is filled in (text, norm, `meaning_norm` cleared) if no complete
  phrase has that norm. Otherwise the pending row is deleted and the complete
  one kept. Scenario `vocab:` entries (target term + gloss) enter complete.
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

Built in phase 1 (bead `ld-b88`). Code: `scripts/auth.mjs` (pure helpers),
`scripts/db/accounts.ts` (queries), `web/server/auth.ts` (routes and the
session), `wrap()` in `web/server/api.ts`, `scripts/user.mjs` (CLI).

- **Passwords:** `scrypt` from `node:crypto` (proposed: no native dependency; argon2
  would need `@node-rs/argon2`). Stored as `scrypt$N$r$p$salt$hash`; checked with
  `timingSafeEqual`. As built: N = 2^15, r = 8, p = 1, a 16-byte salt and a
  32-byte key, base64url; the password is NFC-normalized first, and the
  parameters are read back from the hash, so they can be raised later.
  At least 8 characters. A login for an unknown username still runs one scrypt,
  so the reply time doesn't reveal which usernames exist.
- **Sessions:** a random 32-byte token in an `httpOnly`, `SameSite=Lax` cookie
  `ld_session`. It is also `Secure` whenever the request came in over HTTPS
  (`X-Forwarded-Proto: https`, which `tailscale serve` sets), and plain on
  `http://localhost`. Only its SHA-256 is stored. They expire after 30 days,
  sliding. Logout deletes the row. As built: the expiry slides at most once
  a minute (`last_seen_at`), and the cookie is re-sent when it does; a cookie
  whose session is gone is cleared; each login deletes that user's expired
  rows; `passwd` and `disable` delete all of a user's sessions.
- **`wrap()`:** it keeps the same-origin check and gains an access level:
  `wrap(fn, { auth: "public" | "user" | "admin" })`. The default is `"user"`, so a
  new route is protected unless it says otherwise. Only `/api/auth/login`,
  `/api/auth/me` and `/api/auth/first-run` are public (and the `/api` 404).
  No session is a 401, a non-admin on an admin route a 403. The handler
  receives `ctx = { user: { id, username, isAdmin }, learner, sessionId }`;
  `learner` is the session's active learner row (null until picked, or once
  archived), re-read on every request. Only an `HttpError`'s sentence reaches
  the client; any other error (a database error carries the failed query and
  its parameters) is logged and answered with a generic 500.
- **The page's learner:** the session cookie is shared by every tab of a
  browser, so a tab can be out of date: tab 1 shows Sam, tab 2 picks Ana (or
  another account logs in on the same browser), and tab 1's "Save as my
  defaults" or voice turn would act on Ana. So every call from the client
  carries the learner its page shows in an `X-Learner-Id` header (set in one
  place, `web/src/api.ts`), and a learner-scoped route (`wrap(fn, { learner:
  true })`: profile, packs, folders, assemble, export, voice turn and cast)
  answers **409 with `code: "stale_learner"`** when that header is missing or
  isn't the session's active learner, or when no learner is picked. On that
  code the client re-reads `/api/auth/me`, which shows the right learner or
  the picker; any other 409 (the turn lock, a non-empty folder) is an
  ordinary error.
- **Admin-only routes:** the content agent (`/api/chat`, its history), its
  model setting (`/api/settings`), and `POST /api/voice/library/add`, which
  adds a voice to the owner's ElevenLabs account. Library reloads are a plain
  `GET /api/content`, so any user may do them. The UI hides the agent drawer
  and the Voice Library's "Use as" for voices not yet added from non-admins.
- **Saved packs in this phase:** still files under `content/*/packs/`, and
  shared: any logged-in user can write, move, rename and delete any pack (and
  folder) in the mode of the learner they picked. This ends in phase 2, when
  packs move to the database, each owned by a learner.
- **Login throttling:** after 5 attempts that don't succeed for one username
  from one client in 15 minutes, that client's logins for that username wait
  30 seconds. This is in memory, which is enough for one Mac. As built: the
  username is normalized first; a username no account could have (it fails
  the username rule) is the same 401 and never reaches the throttle, and a
  login body is capped at 8 KB, so the throttle's map holds only short keys.
  Unknown usernames count the same as real ones. An attempt is counted when
  it starts, before the lookup and the scrypt, and taken back on success, so
  parallel guesses can't all get in ahead of the first failure. An attempt
  after the wait (still 5 in the window) starts another wait, and the reply
  is a 429 with `Retry-After`. The client is the socket address, except
  behind the local proxy (a loopback socket with `X-Forwarded-For`), where it
  is the last `X-Forwarded-For` entry: the one the proxy added. Earlier
  entries are whatever the client sent, so keying on them would let a
  guesser make up a new client per try. Remaining risk: a guesser at the
  same address as the owner (anyone using this Mac's own browser, or a
  process on the Mac, which can also set the header freely) can still keep
  that username's logins waiting, and someone guessing from many tailnet
  devices gets 5 tries per device per window.
- **Accounts:** `npm run user -- add <name> [--admin]`, `passwd`, `list`,
  `disable`, `enable` (undoes `disable`; the password is unchanged). The
  password is prompted for without echo, or read from stdin's first line
  when it is piped. A user the CLI adds has no learners; the
  picker opens on Add. There is no sign-up page, with one exception:
- **First run:** while the `users` table is empty, `/api/auth/me` answers
  `firstRun: true` and the UI shows **Create the first account** instead of
  the login form. `POST /api/auth/first-run` creates that account as an admin
  and logs it in. It works only while there are no users: the check and the
  insert run in one transaction holding `LOCK TABLE users IN SHARE ROW
  EXCLUSIVE MODE`, so of two at once one gets a 409. It seeds the admin from
  the files that held the data before logins, each skipped quietly when
  missing: `content/profile.yaml` → an adult learner,
  `content/kids/profile.yaml` → a kids learner, `data/voice.json` →
  `user_settings.voice` (normalized), `data/settings.json` → the model,
  `data/chat.jsonl` → `agent_messages`. After that the running app reads and
  writes none of those files; the profiles stay as seeds and for the export
  CLI. This does the learner and settings half of the one-time import below.
- **Learners:** after login, a "Who's practicing?" picker lists the account's
  learners (with Add). The choice is stored on the auth session (`learner_id`).
  The top bar shows the learner and switches between them. Switching to a kids
  learner switches to kids mode, so the mode now comes from the learner. As
  built: the Profile popover lists the learners as the switch (and links to
  the picker); its pickers and "Save as my defaults" write the active
  learner's row. Routes: `GET/POST /api/learners`, `GET/PATCH
  /api/learners/:id` (the mode can't change), `POST /api/learners/:id/archive`
  (kept, out of the picker; sessions that had it go back to the picker) and
  `PUT /api/auth/learner {learnerId}` (null clears it). Every learner id is
  looked up through the user's own scope, so another account's id is a 404,
  the same as a missing one.
- **Per-user settings:** voice settings and casting (`user_settings.voice`),
  the agent's model (`user_settings.model`) and its chat (`agent_messages`,
  ordered by `seq`), all through `forUser`. The voice turn lock is per login
  session until conversations key it, so a parent and a child on two devices
  under one account don't block each other (two tabs of one browser share a
  session, and its lock).
- **Browser storage:** the remembered draft, tab, Scene filter and folder
  state are kept per learner (`<key>.learner.<id>`), so the next learner or
  account on the same browser never sees the last one's unsaved name, level,
  language or quick-scenario text. The per-mode keys they had before logins
  are dropped on the first page load, not adopted: there is no telling whose
  they were. The voice timeline's open/closed state stays per browser.

Routes that took `?mode=` change as follows:

- Pack, profile, assemble, export and voice routes use the active learner's
  mode, and answer 400 if a `?mode` they're sent disagrees (for the voice
  turn and cast, the body's `mode`). Before that, the learner check above
  answers 409 `stale_learner` when the page's learner isn't the session's
  active one or none is picked; the client re-reads `/api/auth/me` on it,
  which shows the right learner or the picker.
- `GET /api/content?mode=` keeps the parameter, because an admin browses and
  edits both libraries. Its `profile` is the active learner's in that
  learner's mode and `{}` in the other; `assemble()` gets the learner's
  profile in place of `content.profile`.

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
account. A phrase gets at most one session review per card per conversation
(a partial unique index on `reviews (card_id, conversation_id)` where
`mode = 'session'` enforces it).

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
on Japanese and Mandarin. The direction is "phrase found in the message"
(`word_similarity(text, message)`), which the trigram GIN indexes don't serve,
so this scans the learner's own rows. That's fine at the size of one bank (see
Phrase bank). The top 6 hits above a threshold are appended to the turn
prompt as:

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
  `verdict=self`. The review row keeps `card_before`, the card's full FSRS
  state before it was graded. An override restores the card from it, then
  reviews again with the new rating.
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

Deployment notes (as of phase 1):

- Until `server.allowedHosts` includes the tailnet name (bead 10 below), Vite
  answers 403 to every request that comes in under that name.
- The `ld_session` cookie is not port-scoped (cookies never are), so it is
  also sent to any other app served on the same hostname, on any port or
  path (the sibling apps on 38100–38300, if they are served under the same
  `<mac>.<tailnet>.ts.net`). Those apps could read it from their requests.
  Serve Lingo Dojo under its own hostname, or keep the others off this one.

Not now (no beads filed; revisit when someone besides the owner uses it
regularly, or when the need shows up):

- A production server in place of the Vite dev server.
- Per-user daily caps on Claude and voice-provider usage (every user's turns run
  on the owner's Claude login and keys).
- Signing in by tailnet identity (`Tailscale-User-Login`) without a password.
- Tailscale Funnel (public internet), which would need a hardened login first.
- Hosting on another machine.

## Import (one time, idempotent)

Phase 1's first-run screen (see Auth) already does steps 1, 2 and 4 for the
first admin. What is left for phase 2 is step 3, the packs, and the
"already imported" check for them.

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
  server uses. It migrates once per process (with the same by-hash migrator
  `db:setup` uses) and boots each database from that image, about 0.1 s each.
  PGlite is PostgreSQL 18 and the app runs on 17, so migration SQL must stay
  valid on 17. The phase 0 migration was also applied and its cross-owner and
  `SET NULL (col)` behaviour checked on a scratch PostgreSQL 17 database.
- **Isolation:** routes are tested with a seeded user and learner, including a
  second user whose rows must never appear (a cross-tenant test for every
  list route). As built (phase 1): the HTTP tests mount the real plugin on a
  `freshDb()` (`serveApi(apiPlugins, { db })`) and log in through
  `scripts/tests/http-session.mjs`; `auth.http.test.mjs` covers first run
  (including two at once), login, logout, expiry and sliding, the throttle
  (parallel guesses, per client, malformed usernames, the body cap), the
  Secure rule, every access level, learner CRUD and picking, and a second
  user against the first's learners, settings and agent chat; the API and
  voice tests cover the stale-page 409 from a second tab and a second login
  on the same browser. PGlite runs one transaction at a time, so the
  first-run race itself is `first-run.pg.test.mjs`, which runs only with
  `LINGO_TEST_PG_URL` set: it makes a throwaway database on that server,
  races 12 first runs five times, and drops it (it fails with the lock
  removed).
- **UI:** login, the learner picker, a voice session that persists and
  recaps, and each practice mode are verified in the real app with Playwright
  before a bead closes (CLAUDE.md).

## Docs to update as phases land

- `PRD.md`: the "no database" decision, the non-goals (feedback loop; multi-user
  done in phase 1)
  and the architecture tree.
- `CLAUDE.md`: the no-database line; the `data/` description, the auth rule in
  `wrap()` and the test database rule (done in phase 1).
- `CONTENT.md`: the `recall` slot, `{{phrase_review}}`, and packs living in the DB.
- `VOICE.md`: "Nothing is saved", `LOOKUP:`, per-turn retrieval; per-user
  settings (done in phase 1).

## Phases

| # | Phase | Needs |
|---|---|---|
| 0 | Postgres + Drizzle foundation: setup scripts, schema v1 (every table above), migrations, PGlite test harness, boot check. **Built** | none |
| 1 | Auth + learners: login, sessions, `wrap` auth levels, user CLI, learner picker, profile on DB, admin-only agent, per-user settings, first-run screen. **Built** | 0 |
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
