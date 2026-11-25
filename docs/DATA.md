# Learners, memory and practice: the database design

Status: **phase 0 (foundation), phase 1 (logins and learners), phase 2
(packs in the database, and their import), phase 3 (conversations),
language profiles (bead `ld-gf9.2`: one learner, several languages) and
phase 4 (the phrase bank, bead `ld-5p2`), phase 5 (post-session
extraction, bead `ld-aeu`), phase 6 (recall in sessions, bead `ld-mey`)
phase 7's flashcards (bead `ld-7p1`) and phase 8 (the content agent's
read-only bank MCP, bead `ld-t5f`, migration 0005) built**; the rest of phases 7–11
is plan, not built (2026-11-15). Epic `ld-gf9`,
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
   mode), Netflix-style, and under a learner one or more languages (German at
   B1, Chinese at A1), each with its own level, packs and History.
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
                     ├─ seed.ts           the first admin's seed from the old files (built, phase 1; packs, phase 2)
                     ├─ store.ts          per-user settings and agent chat (built, phase 1)
                     ├─ content.ts        library (files, as now); packs, folders, revisions → DB (built, phase 2)
                     ├─ voice.ts          turns persist to conversations (built, phase 3); retrieval; LOOKUP (built, phase 6)
                     ├─ recall.ts         the bank reads behind the review block, retrieval and LOOKUP (built, phase 6)
                     ├─ conversations.ts  /api/conversations: create, list, get, end, delete; the turn lock (built, phase 3)
                     ├─ bank.ts           /api/phrases/*  bank CRUD, metrics
                     ├─ practice.ts       /api/practice/* queue, grade, review
                     └─ chat.ts           content agent (admin) + bank MCP (read-only; built, phase 8)
scripts/
  db/schema.ts        Drizzle tables (shared by server, CLI, tests)
  db/migrations/      generated SQL, committed
  db/owned.ts         owned-row scopes: forLearner / forUser (built, phase 0); forLanguageProfile (language profiles)
  db/config.mjs       DATABASE_URL, migrations dir (built, phase 0)
  db/migrations.mjs   by-hash migrator and migration state (built, phase 0)
  db/hand-edits.mjs   the documented hand edits to 0000_init.sql (built, phase 0) and 0002_language_profiles.sql
  db/setup.mjs        CLI: db:setup / db:migrate (built, phase 0)
  db/accounts.ts      users, sessions, learners, language profiles, settings, agent messages (built, phase 1)
  db/packs.ts         packs, folders, revisions, restore, the pack import (built, phase 2)
  db/import.ts        the import's account and learner choice, and its report (built, phase 2)
  auth.mjs            pure: scrypt, tokens, the cookie, the login throttle (built, phase 1)
  conversations.mjs   pure: the turn write's reconciliation, titles, paging (built, phase 3)
  fsrs.mjs            pure: rating mapping, mastery bands (wraps ts-fsrs)
  match.mjs           pure: answer normalization and lenient match
  recall.mjs          pure: review-block selection, retrieval ranking, LOOKUP search (built, phase 6)
  bank-mcp.mjs        stdio MCP server for the content agent (read-only role; built, phase 8)
  user.mjs            CLI: add [--admin] / passwd / list / disable / enable (built, phase 1)
  import.mjs          CLI: npm run db:import, pack files → DB (idempotent; built, phase 2)
```

The pure modules (`fsrs`, `match`, `recall`, the extraction parser) follow the
existing rule: no server imports, covered by `node --test` directly.

`DATABASE_URL` lives in `.env.local` (default `postgres://localhost/lingo_dojo`),
read the same way as the voice keys (a `DATABASE_URL` in the shell wins).
`npm run db:setup` creates the database if it is missing and runs the
migrations; it is idempotent. `npm run db:migrate` only migrates. Migration
0005 (bead `ld-t5f`, phase 8) also makes the read-only `lingo_reader` role
and its row-level security, so the role running `db:setup` must be a
superuser or have CREATEROLE (see "As built (phase 8)" under Recall in
sessions, §4); the import came with phase 2. The dev
server checks on boot that the database answers and migrations are current,
and refuses to start with a message naming `npm run db:setup` if not (a
half-migrated schema fails in confusing ways later). The check only reads; it
never migrates on its own. A Vite *restart* (a server file changed, as a
`git pull` does) never refuses: a throw there would leave the old code
serving and a half-built server whose watcher later fights the live one for
the port. It comes up with the new code, and while the database is not
current every `/api` request gets a 503 naming what to run, re-checking at
most every 2 s; the first request after `npm run db:migrate` (and at least 2 s after the
last check) finds it current and the API is back, no restart (`web/server/dbGate.ts`, bead
ld-tdd). Migrating stays an explicit step even then: a pulled migration may
be irreversible, and a branch's must never reach the real database by
accident. The HTTP tests mount the plugin with
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
carries `learner_id` (or `user_id` for account-level rows), the tables that
belong to one language (packs, folders, revisions, conversations, turns,
and the phrase bank: phrases, examples, cards, reviews, cloze items)
`language_profile_id` too, and every query goes through a helper that
requires them, so a forgotten `where` is a type error, not a leak.

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
| `reviews.conversation_id` | `conversations (id, learner_id)`, and `(id, language_profile_id)` (migration 0003) |
| `phrase_examples.conversation_id` | `conversations (id, learner_id)`, and `(id, language_profile_id)` (migration 0003) |
| `phrase_examples.turn_id` | `turns (id, learner_id)`, and `(id, language_profile_id)` (migration 0003) |
| `auth_sessions.learner_id` | `learners (id, user_id)` |
| `auth_sessions.language_profile_id` | `language_profiles (id, learner_id)` (migration 0002) |

On delete they null only the link column: `ON DELETE SET NULL (col)`, which
needs PostgreSQL 15+. Deleting a conversation never erases memory, and
deleting a learner sends its sessions back to the picker.

drizzle-kit can't write the column list, so `0000_init.sql` is drizzle-kit's
output plus exactly two documented hand edits:

1. `CREATE EXTENSION pg_trgm`.
2. The four `SET NULL (col)` clauses.

Both live in `scripts/db/hand-edits.mjs`, beside those of
`0002_language_profiles.sql` (see Language profiles). `scripts/tests/db-migrations.test.mjs`
regenerates the latest migration's SQL from `schema.ts`, checks that the committed file is
exactly that output with its hand edits applied, checks that `schema.ts` has
no change missing from the snapshot, and checks the delete columns in the
catalog.

**The owned-row helper** is `scripts/db/owned.ts`:
`forLearner(db, learnerId)`, `forUser(db, userId)` and
`forLanguageProfile(db, { id, learnerId })` return a scope with
`list`, `get`, `insert`, `insertOrIgnore` (added in phase 2), `upsert`, `update`, `remove`, `removeAllOwned` and
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
- **Language profiles.** `forLanguageProfile(db, { id, learnerId })` filters
  on and stamps both `language_profile_id` and `learner_id` (an upsert's
  conflict target gets both), so a row can't be written under one learner's
  language and another learner. A table with `language_profile_id` (packs,
  pack folders, revisions, conversations, turns, and since migration 0003
  the phrase bank's five tables) is refused by `forLearner`, as a type error
  and at runtime: a learner scope would see every language's rows.

The server's raw handle is `rawDb()` in `web/server/db.ts`, and it's only for
owner-less lookups (a login by username, a session by token hash, the
zero-users check of the first run). As built, every account query is in
`scripts/db/accounts.ts`, so the raw uses are in one file.

### Accounts

```
users           id, username (unique, lowercased), password_hash, is_admin,
                created_at, disabled_at
auth_sessions   id (sha256 of the cookie token), user_id, learner_id (active;
                one of user_id's learners, composite key),
                language_profile_id (active; one of learner_id's languages,
                composite key), created_at, expires_at, last_seen_at
learners        id, user_id, name, mode (adult|kids), native_language,
                created_at, archived_at; unique (id, user_id)
language_profiles id, learner_id, target_language, target_variant, level,
                goals, notes, created_at, last_used_at, archived_at;
                unique (id, learner_id); index (learner_id)
user_settings   user_id (pk), model, voice jsonb (today's data/voice.json shape)
agent_messages  id, user_id, seq (bigserial: order by it), role
                (user|assistant|commit), text, ts    (was data/chat.jsonl)
```

A learner and its active language profile hold between them exactly the
profile keys `profile.yaml` has: the learner the person's (`learner_name`,
`native_language`), the language the rest (`target_language`,
`target_variant`, `level`, `goals`, `notes`). The `profile.yaml` files stay
as seeds for a fresh install and for the offline `npm run export` CLI. As
built, `assemble()`'s signature is unchanged: the server hands it the
library with `profile` replaced by the learner and its language as profile
keys (`profileFromLearner(learner, language)`, blanks left out, each row
giving only its own keys), so the export CLI and the app share one
assembler.

### Language profiles

Built with bead `ld-gf9.2`, migration `0002_language_profiles`. A learner
(the person: name, native language, mode) practises one or more languages,
each a **language profile** with its own target language and variant,
level, goals and notes, and its own packs, folders, pack history and
conversations, and (phase 4, migration 0003) its own phrase bank.

- **One per language.** A profile's target language is its identity: its
  packs and History are in that language. So a learner has at most one live
  profile per target language (compared ignoring case and space; a second
  `POST …/languages` for it is a 409 that says to switch to it), and a
  profile's target language never changes: `PUT /api/profile` and `PATCH
  …/languages/:languageId` take the same language (a no-op) but refuse
  another with a 400. The variant (Mexican or Castilian Spanish) is a
  setting inside the one profile, like the level. The one exception is a
  profile with no target language yet (a library with no `languages.yaml`),
  which may be given one the learner doesn't already have. The check runs
  under a lock on the learner's row rather than a unique index, so it
  needed no migration: every write that can give a live profile a target
  language (`createLanguageProfile`, and `updateLanguageProfile` naming a
  blank profile) takes it first (`lockLearner`), then the profile row. There
  is no unarchive, a new learner's first profile can't clash, and the import
  and first run make no profile of their own. **Lock order:** every
  transaction that writes learners, language profiles or a session's
  learner and language locks learners first (two in id order, as a switch
  from one learner to another does), then language profiles, then session
  rows, so no two of them can deadlock. `setSessionLearner` (the learner
  pick, `PUT /api/auth/language`, the session's fallback to the default
  language) reads the destination under the learner's lock, so a language
  or learner archived meanwhile is the usual 404, never a session left on
  it; an archived profile doesn't count, so a language
  archived and added again is a fresh profile. In the Profile popover,
  picking another target language is this pack's override, as before; to
  make it the default the popover offers **Switch to German** (when the
  learner has a German profile) or **Add German**, never a rewrite of the
  current profile. Goals and notes of the active language are edited at the
  bottom of the popover (`PATCH …/languages/:languageId`).
- **Keep one.** A learner always has at least one live language: a new
  learner is created with its first (`POST /api/learners` takes the
  language keys too), and archiving the last one is a 409. Archiving keeps
  the row and everything under it; it leaves the switcher.
- **Last used.** Picking a learner lands the session on its most recently
  used language: `language_profiles.last_used_at`, set whenever a session
  picks it (`setSessionLearner`), newest first, then the oldest created.
  It is a column on the profile, not a `learners.last_language_profile_id`,
  which would make the two tables reference each other.
- **The session.** `auth_sessions.language_profile_id` is the active
  language, one of the active learner's (composite key to
  `language_profiles (id, learner_id)`, `ON DELETE SET NULL
  (language_profile_id)`). A session with a learner but no language (a
  session from before 0002, or its language archived elsewhere) is healed on
  the next request to the learner's default language (`sessionFor` in
  `web/server/auth.ts`), and archiving a language moves every session on it
  to the learner's default. One gap, left as is: hard-deleting a learner
  (no app path does; learners are archived) nulls `learner_id` first, and
  with it null the composite key (MATCH SIMPLE) no longer applies, so
  `language_profile_id` is left naming the deleted profile. Nothing reads
  it without a learner and the next pick sets both; closing it would take
  a migration making the learner key `SET NULL (learner_id,
  language_profile_id)`.
- **Ownership.** Packs, pack folders, pack revisions, conversations and
  turns carry `language_profile_id` (not null) beside `learner_id`, with
  composite keys: `(language_profile_id, learner_id)` → `language_profiles
  (id, learner_id)` on packs, folders and conversations (cascade), and the
  children to their parent's `(id, language_profile_id)` (`pack_revisions
  (pack_id, language_profile_id)` → `packs`, `turns (conversation_id,
  language_profile_id)` → `conversations`). The live-pack slug index and the
  folder key are per language: `packs_profile_folder_slug_live` on
  `(language_profile_id, folder, slug) where deleted_at is null`, and
  `pack_folders` keyed `(language_profile_id, name)`. The learner keys stay,
  so a row still can't name a language of another learner.
- **Routes.** `GET /api/learners/:id/languages` (`?archived=1` adds archived
  ones), `POST` (a new one; level defaults to the mode's first), `GET` and
  `PATCH /api/learners/:id/languages/:languageId`, `POST
  …/:languageId/archive` (409 for the last), and `PUT /api/auth/language
  {languageId}` (one of the active learner's; anything else is a 404).
  `/api/auth/me` and `GET /api/learners` list each learner's languages
  (`LearnerInfo.languages`), and `/api/auth/me` the session's
  (`MeReply.language`). `PATCH /api/learners/:id` takes only `name` and
  `native_language`; a language key there is a 400 naming the language
  route. `PUT /api/profile` ("Save as my defaults") writes the learner's keys
  to the learner and the rest to the active language, in one transaction:
  a language archived meanwhile throws inside it (409 `stale_learner`), so
  the learner's half rolls back too.
- **The UI.** The top bar's language pill ("German · B1") switches between
  the learner's languages, adds one ("Add and switch") and archives the
  active one. The learner picker lists each learner's languages, and its Add
  form asks for the first (a free-text field when the library has no
  `languages.yaml`). A switch remounts the app like a learner switch. Before
  any switch (and before logging out) the page ends its open voice session's
  conversation and waits for the answer, at most 1.5 s (`onBeforeSwitch` /
  `settleBeforeSwitch` in `web/src/api.ts`), while its headers still name
  that conversation's learner and language. A switch the server refuses
  (one another tab just archived) is said under the top bar, and the lists
  are re-read.

**Migration `0002_language_profiles`** is drizzle-kit's output plus hand
edits (`EDITS["0002_language_profiles"]` in `scripts/db/hand-edits.mjs`):
drizzle-kit wrote the new primary key and foreign keys before the columns
and unique keys they need and added the new columns `NOT NULL` with no
default, which no populated table accepts. The edits put the statements in
a runnable order and backfill existing rows before the constraints: the new
columns are added nullable; one `language_profiles` row is inserted per
learner (archived ones too) from its `target_language`, `target_variant`,
`level`, `goals` and `notes`, with the learner's `created_at` and
`last_used_at = now()`; every pack, folder, revision, conversation and turn
gets its learner's profile, and every auth session with a learner that
learner's profile; then the columns become `NOT NULL`, the old pack index and
folder key are replaced by the per-language ones, the keys and indexes are
added, and last the five columns are dropped from `learners`. Nothing is
deleted and no row changes owner. `scripts/tests/db-migration-0002.test.mjs`
(PGlite) and `migration-0002.pg.test.mjs` (PostgreSQL 17, with
`LINGO_TEST_PG_URL`) build a database at 0001, fill it the way the code
before 0002 wrote rows (two accounts, adult, kids and archived learners,
live and deleted packs, folders, revisions, conversations and turns,
sessions with and without a learner, phrase-bank rows), migrate, and check
every row.

### Packs

```
packs           id, learner_id, language_profile_id, folder ('' or one
                kebab segment), slug, title, created, scenario,
                quick_scenario, random_scene jsonb, units jsonb,
                overrides jsonb, notes,
                updated_at, deleted_at
                unique (language_profile_id, folder, slug) where deleted_at is null
pack_folders    learner_id, language_profile_id, name, created_at;
                pk (language_profile_id, name)
pack_revisions  id, pack_id, learner_id, language_profile_id, seq
                (bigserial: order by it), snapshot jsonb, action, at
```

As built: `created` is `text`, the wire value verbatim (ISO with its offset).
`timestamptz` would drop the offset, and the pack's date stem is the
learner's local date. `pack_folders` was added because the Library lists
empty folders, which `packs.folder` alone can't express. `seq` on
`pack_revisions` and `agent_messages` gives the true order: `at`/`ts` is
`now()`, the transaction's start, so rows written in one transaction tie.

`random_scene` (migration `0007_random_scene`, nullable, old rows null) is a
pack that draws its scene when a session starts: `{ collections: string[] }`,
`[]` for every scene that fits (docs/CONTENT.md "Random scene"). It is its
own column rather than a key of `overrides`, which feed the Learner block.
`contentOf` in `scripts/db/packs.ts` validates it (`readRandomScene` in
`web/shared/scenes.ts`: an object, at most 50 trimmed, de-duplicated names
of at most 120 characters, none only spaces; anything else is a 400) and clears `scenario`
and `quick_scenario` when it is set. Revisions snapshot it with the rest,
so restore and undelete bring it back; the wire `Pack.random_scene` is
always present (`null` when not random).

The wire `Pack.id` stays `folder/slug`, so the Library and Scene tabs keep
working unchanged. Git used to make every pack change undoable. Here
`pack_revisions` does that job (a snapshot per write, move, rename or delete),
and deletes are soft.

As built (phase 2; `scripts/db/packs.ts`, routes in `web/server/content.ts`):

- **Per language profile.** Every pack and folder route works on the active
  language's rows (`learner: true`, so a stale page is a 409
  `stale_learner`), through `forLanguageProfile(tx, profile)` inside each
  write's transaction (the scope `profileRows()` is, on the transaction
  rather than the pool). Another language's pack, folder or revision id, of
  the same learner, another learner or another account, is a 404 like a
  missing one. A kids learner's packs are kids packs because the
  learner is; there is no per-mode tree any more.
- **Ids.** `Pack.id` is `<slug>` or `<folder>/<slug>`, checked with the
  loader's `PACK_ID_RE` (one folder deep, kebab segments); a rename re-slugs
  to `<date>-<slug of title>`, keeping the slug's date (`renamedStem` in
  `scripts/content.mjs`). PUT on an id writes the pack there: it creates it,
  or replaces a live pack's content (as the file write did). `id`/`folder` in
  the body are ignored; keys outside the pack contract are dropped (a row has
  no column for them; the file write kept them). A missing `created` is now.
  A NUL character (`\u0000`) anywhere in a pack, object keys included, or in
  a new title is a 400: Postgres can't store it in text or jsonb, so it would
  otherwise be a 500.
- **Revisions.** Every pack write records a snapshot (the wire `Pack`) in the
  same transaction: `create`, `update`, `move`, `rename`, `delete` (the
  content that was deleted), `restore`, `import`. A move to the folder the
  pack is already in changes nothing and records nothing. **Folder create and
  delete record no revision:** `pack_revisions.pack_id` is required and a
  folder has no content of its own (only an empty folder can be deleted, and
  a restored pack brings its folder back), so there is nothing to snapshot
  without a schema change.
- **Undo routes.** `GET /api/pack-revisions?id=<pack id>` lists a pack's
  revisions, newest first (renames and moves keep the history, being the same
  row): the live pack at that id, else the most recently deleted one that
  had it; `?revision=<revision id>` instead names the pack a revision belongs
  to, which reaches an older deleted pack whose id has been reused. `GET
  /api/pack-revisions/deleted` lists the deleted packs, newest first, each
  with its delete revision. Both page: 100 revisions or 50 deleted packs a
  page, `?offset=`, and the reply's `next` is the next page's offset (null
  after the last), so nothing kept is out of reach. Two separate actions,
  so a stale click can't do the other one: `POST
  /api/pack-revisions/:revision/restore` puts a revision's content (title,
  created, scenario, units, overrides, notes) onto its **live** pack, which
  keeps its id (409 when the pack is deleted); `POST
  /api/pack-revisions/:revision/undelete` brings a **deleted** pack back as
  it was deleted, at the id it had, with its folder (409 when it is not
  deleted, e.g. a second click or another device's stale list, which changes
  nothing; 409 too when a live pack has taken the id since: move or rename it
  first). Either is a `restore` revision. The Library shows **Recently
  deleted** (paged with More) using undelete; on a 409 it re-reads its lists.
  Listing and restoring older revisions of a live pack has no UI yet.
- **Concurrency.** Each write is one transaction that locks the live row it
  changes (`SELECT … FOR UPDATE`), so a move and a delete of one pack at once
  do exactly one thing (the second finds nothing at the old id). Two creates
  of one id: the insert is `ON CONFLICT DO NOTHING` on the partial unique
  index, and the loser updates the winner's row, so both writes are
  revisions and neither errors. A move or rename into a taken id is a 409,
  whether the clash was there first or arrived meanwhile (the unique
  violation is mapped). Folders: a write into a folder takes the folder row's
  lock (an upsert) before the pack's, and a folder delete locks the folder
  row before it counts the live packs in it, so a pack never lands in a
  deleted folder; the folder list is also the union of folder rows and live
  packs' folders. An undelete takes its folder's lock, then the pack row's;
  of two undeletes at once the second finds the pack live (409), and a
  restore racing an undelete either waits for it or is refused, never landing
  on a deleted pack. `scripts/tests/packs.pg.test.mjs` races each of these on
  a real Postgres.
- **Owner scoping in one place.** Every query in `packs.ts` goes through
  `forLanguageProfile(tx, profile)` (inserts that may conflict through its
  `insertOrIgnore`, which puts both owners in the conflict target), and the
  routes only pass the session's active language (`ctx.language`).
- **No files, no commits.** No pack route reads or writes `content/**/packs`
  or calls git; `commitPacks` is gone (the agent's `content/` commit stays),
  and so are the file write functions in `scripts/content.mjs` (savePack,
  movePack, renamePack, deletePack, createFolder, deleteFolder). Only
  `loadPackFiles` reads pack files, for the import, the first run and the
  export CLI: `loadContent` (the app's library: units, scenarios, frame,
  schema) no longer parses `packs/` at all, so a broken or large pack file
  can't slow or clutter the app's content load or its problems list. The wire replies lost their `commit`/`error` fields
  (`Committed`): the Library's status line was their only reader.

### Conversations

```
conversations   id, learner_id, language_profile_id, pack_snapshot jsonb, scenario_id, title,
                mode, native_language, target_language, target_variant,
                model, planned_minutes, started_at, ended_at, turn_count,
                summary, extraction jsonb, extracted_at,
                extraction_status (none|running|done|failed|skipped),
                extraction_claim, extraction_started_at,
                extraction_attempts, extraction_error,
                scene_key, previous_conversation_id   (0008, §Revisit)
turns           id, conversation_id, learner_id, language_profile_id, idx, role (learner|master),
                text, lines jsonb, glosses jsonb, choices jsonb, stage,
                cast_notes jsonb, from_client boolean, duration_ms, cost_usd,
                lookup jsonb, created_at
                unique (conversation_id, idx); unique (id, learner_id)
```

`pack_snapshot` freezes what was played, since packs change later. `turns`
stores the same shapes `VoiceHistoryItem` already has, so a stored conversation
can be shown with the existing transcript components.

A random scene is drawn when its conversation is made, so the snapshot is
the drawn pack (`scenario` set, `random_scene` null) plus
`random_draw: { collections, pool: [scenario ids], drawn, kept? }` (`kept`
when the conversation kept the scene an earlier one of the same live voice
session drew, that one having ended while the session stayed open: leaving
Go, two idle hours, another device's End. Restart and Close forget the
scene. The client's `drawn` is honoured while it is in the pool, even when
it is the most recent scene; otherwise the draw is fresh and still avoids
recent scenes, and if unsaved turns were played as the earlier scene, the
new conversation is recorded under the newly drawn scene while holding
those turns, as a picked scene changed mid-session always has). The server writes `random_draw` and `review`; a client's own are
dropped. `scenario_id` and the title are the drawn scenario's; the wire
`ConversationSummary.randomScene` is true for such a row. A turn whose pack
is still random reads its scene from this snapshot (`playedPack` in
`web/server/conversations.ts`) and never redraws; with no conversation, or
one that wasn't random, it is a 409. (A turn the client must run unsaved
sends the pack with the session's drawn scene already in place, so it is
not random and runs as any picked scene does.) Avoiding recent scenes reads the
language profile's last 20 conversations' `scenario_id`. No migration: the
snapshot is jsonb.

**Draw another** (ld-k23): `POST /api/conversations/:id/redraw`, with the same
body as a create (the random pack, mode, title), replaces a random scene's
conversation the learner hasn't spoken in (no `role = 'learner'` turn; the
dojo master's opening may be stored). The draw is never in place: the
replacement is made by the same code as a create (`makeConversation`), with
the scene just drawn passed as an extra most-recent scene to avoid, so its
`scene_key`, `scenario_id`, title, snapshot (`random_draw`, `review`,
`revisit`) and `previous_conversation_id` (the new scene's last attempt with a
done recap) are all the new scene's; then the old conversation is deleted as
Delete does (its turns cascade, no recap, no History row). It holds End's
lock while it checks and deletes, so a turn racing it either stores first
(and a learner turn makes it a 409) or is refused `conversation_ended`.
Refusals change nothing: 409 `already_spoken`, 409 `no_other_scene` (a pool
of one, or the draw landed on the same scene), 409 `conversation_ended`, 409
for a conversation with no draw, 400 for a pack that isn't random, 404. The
phrases the discarded scene's lists and its opening's glosses added to the
bank stay there, as after a Restart.

Added by migration `0001_conversation_languages_from_client` (phase 3 review):
`native_language`, `target_language` (with `target_variant`, the session's
languages when it started; `''` for none) and `turns.from_client` (not null,
default false; see Conversations, "Reconciling"). Migration 0002 moved
conversations under the learner's language profile (`language_profile_id`);
these columns stay the session's own languages, which a pack's overrides can
make differ from its profile's.

### Phrase bank

```
phrases         id, learner_id, language_profile_id, lang (BCP-47 of the
                variant it was first met in, e.g. es-MX; provenance only),
                text (target form; null while pending), norm (match key of
                text; null while pending), meaning (native language),
                meaning_norm (a pending row's key), note, reading
                (Mandarin: the dojo master's checked reading where the
                reader's differs, "nǐ děi qù"; null for almost every
                phrase; cleared when the text is edited, checked
                against the text again wherever it is shown; migration
                0014, docs/VOICE.md §Reading hints),
                source
                (gloss|extraction|manual|scenario), alternates jsonb
                (accepted other forms, default []), starred, suspended,
                first_seen_at, last_seen_at, seen_count,
                last_practiced_at, edited_at (the learner's last change
                by hand; null if never), created_at
                unique (language_profile_id, norm) where text is not null
                unique (language_profile_id, meaning_norm) where text is null
                trigram GIN indexes on text and meaning
phrase_examples id, phrase_id, learner_id, language_profile_id,
                conversation_id, turn_id, sentence, speaker, created_at
phrase_sightings id, phrase_id, learner_id, language_profile_id,
                conversation_id, turn_id (both SET NULL on delete),
                seen_at, source (gloss|extraction; migration 0004);
                unique (conversation_id, phrase_id) where source =
                'extraction'; unique (turn_id, phrase_id): one row per reply
                that saw the phrase; seen_count, first_seen_at and
                last_seen_at are always its count, min and max
cards           id, phrase_id, learner_id, language_profile_id,
                skill (recognize|listen|produce),
                fsrs state: due, stability, stability_fast, difficulty,
                scheduled_days, learning_steps, reps, lapses, state,
                last_review
                unique (phrase_id, skill); index (language_profile_id, due)
reviews         id (bigserial), card_id, learner_id, language_profile_id, mode
                (flashcard|cloze|listening|speak|session), rating (1-4),
                answer, verdict (exact|close|accepted|wrong|self),
                grader_note, duration_ms, reviewed_at, conversation_id,
                card_before jsonb (the card's FSRS state before this review)
                unique (card_id, conversation_id) where mode = 'session'
cloze_items     id, phrase_id, learner_id, language_profile_id, phrase_key,
                sentence, blank_start, blank_end (all three null: a
                generated "nothing usable" mark), hint (unused),
                translation (the sentence's meaning, null for none;
                only with a sentence; migration 0010),
                origin (example|generated), example_id, flagged_at,
                created_at
                fk (example_id, phrase_id) → phrase_examples, cascade;
                unique (example_id, phrase_key) where example_id is set;
                unique (phrase_id, phrase_key, sentence) where generated;
                unique (language_profile_id, phrase_id, phrase_key) where
                no sentence
                (migration 0006; see "As built (phase 7c)")
cloze_calls     id, learner_id, language_profile_id, phrases (asked, > 0),
                kept (sentences kept; null while running or after a
                failure), created_at
                fk (language_profile_id, learner_id) → language_profiles,
                cascade; index (language_profile_id, created_at)
                (migration 0006: the generation calls' ledger, which the
                daily cap counts)
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
which is fine at the size of one learner's bank. (As built in phase 6,
recall ranks in JS over one read of the bank instead, for languages
written without spaces; the indexes are unused by it: see "As built
(phase 6)" under Recall in sessions.)

- **Identity.** `norm` is NFC, case-folded, outer punctuation (including ¿ ¡ 「 」)
  and repeated spaces removed. Accents are kept: *papa* and *papá* are different
  phrases. Same `(language profile, norm)` means the same complete phrase, so a
  gloss of "¿A cómo?" in two sessions bumps one row, whichever variant each
  session was in. The gloss write is the profile scope's `upsert` on that
  partial index (`target: [norm]`, `targetWhere: text is not null`).
- **Pending phrases.** A scenario's `phrases:` list is English meanings. Those
  enter as rows with `meaning` and `meaning_norm` set and `text`/`norm` null
  (a check enforces complete-or-pending). They have their own identity,
  `(language profile, meaning_norm)`, so a pending "taxi" (English) never
  captures the later gloss of the target word "taxi". **Merge rule:** when a
  gloss or extraction pairs a target form with a pending row's meaning, the
  pending row is folded into the complete phrase for that form (made if
  there is none) and deleted. (The plan filled the pending row in instead;
  as built it is folded, for one lock order: see "As built (phase 4)".) Scenario `vocab:` entries (target term + gloss) enter complete.
- **Language.** A phrase belongs to a language profile (built in phase 4,
  migration 0003; before it, the plan keyed the bank by learner and `lang`).
  A profile is one target language, so changing its variant from Mexican to
  Castilian Spanish keeps the bank, and a Japanese profile has its own.
  `lang` records the variant a phrase was first met in, for display only.
- **Three cards per phrase (proposed).** Recognize (read → meaning), listen
  (hear → meaning), produce (meaning → target, typed or spoken). These are
  separate memories, as in Anki's two-sided cards. Cards are created lazily: a
  phrase gets `recognize` when first seen, and `listen`/`produce` the first time a
  mode or session exercises them. The phrase's shown **mastery** is the weakest of
  its cards that exist, so a phrase you understand but can't say is not "mastered".
  It is **New** only while none of its cards has been reviewed; once one has, a
  card not yet reviewed counts as Learning.

### Metrics the bank shows

| Metric | Source |
|---|---|
| Last seen | `last_seen_at`: glossed or used in a session (as built, practice doesn't set it: see "As built (phase 7a)") |
| Times seen | `seen_count` |
| Last practiced | `last_practiced_at`: any review, practice or session |
| Mastery | band from the weakest card: **New** (no card reviewed: never practised), **Learning** (stability < 3 days), **Familiar** (< 21 days), **Mastered** (≥ 21 days, Anki's "mature" line) |
| Due | earliest `cards.due` |
| Trouble | lapses in the last 30 days |

### As built (phase 4)

Bead `ld-5p2`, migration `0003_phrase_bank_per_language`. The phase 0
tables were keyed by learner and `lang`; the language profiles of
`ld-gf9.2` made a learner's languages separate, so the bank now is too.

- **Migration 0003.** Adds `language_profile_id` (not null) to the five
  tables, with composite keys: `phrases (language_profile_id, learner_id)` →
  `language_profiles`, cascading, and each child to its parent's
  `(id, language_profile_id)`. The identity indexes move to
  `(language_profile_id, norm)` and `(language_profile_id, meaning_norm)`,
  the due and review indexes to the profile. Provenance stays in the row's
  language too: `phrase_examples (conversation_id, language_profile_id)` and
  `(turn_id, language_profile_id)`, and `reviews (conversation_id,
  language_profile_id)`, reference the conversation's or turn's
  `(id, language_profile_id)` (a new unique key on `turns`), with `ON DELETE
  SET NULL (col)` like the learner-level keys beside them, so deleting a
  conversation keeps the example or review and clears only the link. It also
  adds `phrase_dismissals` (below).
  **It moves no bank row.** Nothing wrote the bank before this phase (the
  real database had none), and no rule can say which of a learner's
  languages an old phrase belongs to (`lang` is a variant; a learner may
  have several profiles, or none). So the migration starts with a guard that
  refuses to run, with a message saying so, while any of `phrases`,
  `phrase_examples`, `cards`, `cloze_items` or `reviews` has a row; the
  migration is one transaction, so a refusal leaves the 0002 schema and
  every row as they were. The SQL is drizzle-kit's plus the hand edits in
  `scripts/db/hand-edits.mjs` (the guard, the order, SET NULL (col)).
  `db-migration-0003.test.mjs` (PGlite) and `migration-0003.pg.test.mjs`
  (PostgreSQL 17) check both cases on a 0002 database with accounts,
  learners, languages, conversations and turns: an empty bank migrates,
  those rows unchanged and the schema identical to a fresh build; a row in
  any bank table is refused with nothing changed.
- **Dismissed.** Deleting a phrase records its words (`kind` text, its
  norm) and its meaning (`kind` meaning) in `phrase_dismissals`
  (`language_profile_id, kind, key`), and a scene's lists skip those at the
  scene's next start: a deleted phrase stays deleted. A session that glosses
  it again brings it back (that is meeting it again), and adding it by hand
  clears the mark.
- **Owner scoping** is `forLanguageProfile` (`scripts/db/owned.ts`); every bank
  query is in `scripts/db/phrases.ts`, the routes in `web/server/phrases.ts`,
  and the pure rules (capture lists, input checks, metrics, the list page) in
  `scripts/phrases.mjs`.
- **Routes** (all `learner: true`, the active language's bank):
  `GET /api/phrases?q=&show=&band=&sort=&offset=&limit=` (a page, the total,
  and the count behind each filter), `POST /api/phrases` (add or star:
  201 new, 200 already there, starred either way), `GET
  /api/phrases/lookup?text=` (the ☆'s state), `GET`, `PATCH` (text,
  meaning, note, starred, suspended) and `DELETE /api/phrases/:id`. Another
  language's phrase, of the same learner or not, is a 404.
- **New and due.** A phrase is **new** when it has never been practised: no
  card of it reviewed, whether its recognize card is waiting (met in a
  session) or it has no card yet (from a scene's list, or added by hand).
  That is the same thing as mastery band New, so the "new" filter, its count,
  the Mastery list's New and the row's "new, ready to learn" always give the
  same number. A card never reviewed (FSRS state New, no reps) is not due:
  `due` is the earliest due of the cards that have been reviewed, so the
  bank isn't all due at once. Due stays a reviewed card whose time has come.
- **Filters and sorts.** Show: all, starred, new, due, trouble, pending (no
  words yet), suspended, with picture (a ready picture, drawn or shared stock; new and due leave out pending and suspended
  phrases). Band: one
  mastery band, also leaving out pending and suspended phrases (so New
  matches the new filter; a suspended phrase is found under Suspended). Sort: recently seen, due first, weakest first, A to Z,
  newest added. The page is filtered and sorted in memory after one read of
  the profile's rows, fine at one learner's bank size; a large bank would
  move it into SQL.
- **Trouble** is 2 or more lapses in 30 days, a lapse being an Again
  (rating 1) given to a card that was in review (`card_before.state` 2).
- **Pending pairing.** A gloss pairs a pending phrase only by the meaning
  the dojo master gave (normalised). The complete phrase for the words is
  made or found first, then the pending row is folded into it and deleted,
  keeping what the learner set on either (starred or suspended if either
  was, both notes joined when they differ, the later `edited_at`, and the
  pending row's meaning when it was edited and the complete one's wasn't,
  or the complete one has none): a change
  from the merge rule above, which filled the pending row in, so that every
  write takes its rows in one order (complete rows by norm, then pending
  rows by meaning) and two conversations capturing at once wait for each
  other instead of deadlocking or colliding on the words. One pass per
  transaction: two ordered passes one after the other are not in order
  together, so a write with two jobs takes the complete rows of both in
  one norm-ordered pass first (`lockInNormOrder`): the turn write that
  drops a reply and captures the next (`lockTurnWrite`: the dropped
  replies' sighted phrases by id, the new capture's upserted) and a recap
  re-run (the last run's phrases by id, beside the new reply's). A row
  found by id is placed at the norm it had when read, so a rename at that
  moment can still misplace it. A write that still
  collides (an edit giving a pending phrase words while a capture adds
  them) is retried once (unique violation or deadlock), then reported:
  `phrases.pg.test.mjs` races captures, an add and crossing meanings on
  PostgreSQL 17. A pending phrase is not created when a complete phrase
  already has that meaning. Giving a pending phrase words in the bank's
  Edit completes it (or is 409 if those words are already a phrase).
- **Capture limits.** A gloss of more than 3 words is a sentence's
  translation and isn't captured; in a language written without spaces
  (Japanese, Chinese, Thai, Lao, Khmer, Burmese, Tibetan) the limit is 12
  characters (letters and digits) instead, since a word segmenter splits
  particles and endings off as words. The example is a line holding the
  term as whole words (as text in those languages), never a line that is
  only the term. Control characters (C0 but a note's line breaks, DEL, the
  bidi overrides and isolates) are dropped from words, meanings, notes and
  gloss terms, and lengths are those of what is stored.
- **Sightings.** A capture writes one `phrase_sightings` row per phrase
  it saw, in its own savepoint with everything else it writes (so a
  capture that failed, or was retried, leaves exactly what succeeded).
  `seen_count`, `first_seen_at` and `last_seen_at` are recounted from those
  rows whenever they change, never incremented, so they always agree.
- **A dropped reply.** When a turn's write deletes stored turns the browser
  no longer shows, what those turns' captures recorded is undone in the
  same transaction, by their sighting rows alone (never by re-reading the
  reply's glosses): the rows and the turns' examples go, and each phrase
  they named is recounted, its first and last seen from the sightings
  left. A turn with no rows (a capture that failed, a copy from the
  browser) changes nothing. A phrase left with no sighting at all is
  deleted only if it existed for those replies alone: provenance gloss, no
  `edited_at`, not starred, suspended or noted, no card reviewed. Any other
  stays, unseen, without its unreviewed cards. Deleting a conversation in
  History keeps its sightings (turn and conversation set null): the phrases
  were still met. If the undo itself fails it is logged and the turns
  still go; their sightings stay, counted, with no turn.
- **Provenance only strengthens**: manual > scenario > gloss (> extraction).
  A scene's list naming words a reply glossed, an add of them, or a
  complete phrase absorbing a scene's pending one keeps the stronger
  `source`, so a scene's phrase that a gloss gave words to stays in the
  bank when that reply is dropped (with the words: the pending row isn't
  brought back, the words are what the learner met).
- **Learner edits.** Every change by hand (any `PATCH`, even one that
  changes only the meaning, and an add or ☆ Star of words already in the
  bank) sets `phrases.edited_at`. That is the one marker the automatic
  paths respect: undoing a dropped reply never deletes such a phrase, and
  no gloss, scene list, pending absorption or retry overwrites a meaning,
  note, star or suspension the learner set. A gloss or a scene's list only
  fills a meaning that is blank (they never replace one, whoever set it);
  scene lists skip dismissed keys and never delete; a retried write reruns
  from the start on fresh rows, so it writes nothing stale. A phrase still
  seen elsewhere keeps its last-seen time (sightings aren't stored one by
  one, so the one before can't be known).
- **UI.** The Library tab's third view, **Phrase bank**: add (starred),
  search, the show chips with counts (a Show more page that arrives after
  the filters changed is dropped), band and sort, a row per phrase with
  its band, ★, the pending, suspended and trouble badges, seen / last seen
  / last practiced / due, and, opened, its examples, Edit, Suspend and
  Delete. The transcript's definition card (Go tab and History) has ☆ Star
  when the session is in the active language. Practice (phase 7) can move
  or reuse it.

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
  receives `ctx = { user: { id, username, isAdmin }, learner, language, sessionId }`;
  `learner` is the session's active learner row and `language` its active
  language profile row (both null until picked, or once the learner is
  archived), re-read on every request. Only an `HttpError`'s sentence reaches
  the client; any other error (a database error carries the failed query and
  its parameters) is logged and answered with a generic 500.
- **The page's learner:** the session cookie is shared by every tab of a
  browser, so a tab can be out of date: tab 1 shows Sam, tab 2 picks Ana (or
  Sam's other language, or another account logs in on the same browser), and
  tab 1's "Save as my defaults" or voice turn would act on Ana. So every
  call from the client carries the learner its page shows in an
  `X-Learner-Id` header and the language in `X-Language-Profile-Id` (both
  set in one place, `web/src/api.ts`), and a learner-scoped route
  (`wrap(fn, { learner: true })`: profile, packs, folders, assemble, export,
  voice turn and cast, conversations) answers **409 with `code:
  "stale_learner"`** when either header is missing or isn't the session's
  active one, or when no learner is picked. On that
  code the client re-reads `/api/auth/me`, which shows the right learner or
  the picker; any other 409 (the turn lock, a non-empty folder) is an
  ordinary error.
- **Admin-only routes:** the content agent (`/api/chat`, its history), its
  model setting (`/api/settings`), and `POST /api/voice/library/add`, which
  adds a voice to the owner's ElevenLabs account. Library reloads are a plain
  `GET /api/content`, so any user may do them. The UI hides the agent drawer
  and the Voice Library's "Use as" for voices not yet added from non-admins.
- **Saved packs:** until phase 2 they were files under `content/*/packs/`,
  shared by every account. Since phase 2 each learner owns its packs in the
  database (see Packs).
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
  `content/kids/profile.yaml` → a kids learner (each with its mode's pack
  files, imported as in Import below, since phase 2), `data/voice.json` →
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
  `PUT /api/auth/learner {learnerId}` (null clears it; a learner lands on
  its last-used language). Every learner id is looked up through the user's
  own scope, so another account's id is a 404, the same as a missing one.
  A learner's languages: see Language profiles.
- **Per-user settings:** voice settings and casting (`user_settings.voice`),
  the agent's model (`user_settings.model`) and its chat (`agent_messages`,
  ordered by `seq`), all through `forUser`. A voice-settings save is a merge
  into what is stored (`sessionMinutes` per mode too), done in one
  transaction that makes the row if missing and holds it `FOR UPDATE`
  (`updateVoiceSettings`), so two saves at once both land; the model is a
  one-column upsert with no read. The voice turn lock is per conversation
  (Conversations), so a parent and a child on two devices under one account
  don't block each other; a turn that isn't being saved falls back to its
  login session (two tabs of one browser share a session, and its lock).
- **Browser storage:** the remembered draft, tab, Scene filter and folder
  state are kept per language profile (`<key>.language.<id>`), so German and
  Chinese keep their own unsaved picks, and the next learner or account on
  the same browser never sees the last one's unsaved name, level, language
  or quick-scenario text. The per-learner keys of before language profiles
  (`<key>.learner.<id>`) move to that learner's oldest language, the profile
  migration 0002 made from the learner's columns, whichever language this
  browser opens first (`adoptLearnerKeys` in `web/src/draft.ts`); the per-mode
  keys they had before logins are dropped on the first page load, not
  adopted: there is no telling whose they were. The voice timeline's open/closed state stays per browser.

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

Built in phase 3 (bead `ld-ioq`). Code: `web/server/conversations.ts`
(routes, the turn lock, the end hook), `scripts/conversations.mjs` (pure:
the turn write's reconciliation, titles, paging), the turn route in
`web/server/voice.ts`, and in the browser `VoicePanel.tsx` (the session),
`HistoryView.tsx` (History) and `Transcript.tsx` (the transcript both show).
docs/VOICE.md §Saved conversations is the user's side.

1. On the first turn of a session, the client calls `POST /api/conversations`
   with the pack. The server stores a conversation with the pack snapshot and
   returns its `id`. Restart starts a new conversation. As built: the row
   also gets the scene's title, the scenario id, the mode, the voice model,
   `planned_minutes` (the pack's minutes; null is no limit), and the
   session's languages: `native_language`, `target_language` and
   `target_variant` from the effective profile (the learner's profile under
   the pack's overrides, `assemble.mjs` `effectiveProfile`, the same merge
   the prompt uses, so a pack that moves the target language drops the
   profile's variant). History's locales come from these saved values only,
   never from the profile as it is later. If creating it fails, the session
   goes on unsaved (and says so), and the next turn tries again: the
   conversation it makes starts where saving stopped
   (`conversationStart`), so the unsaved turns before it are stored too.
2. `POST /api/voice/turn` carries `conversationId`. After a successful turn,
   the server appends the learner turn and the master turn in one transaction.
   The client still sends the history (VoicePanel's retry, recast and "check
   what it heard" flows stay as they are). Reading the history from the DB
   instead is a later simplification. As built:
   - The turn is refused before anything runs when the conversation is
     another learner's or gone (404, `code: "no_conversation"`) or ended
     (409, `conversation_ended`); the client then makes a new conversation
     starting at that turn and sends it again.
   - **The stored turns mirror the screen, as far as the server trusts
     it.** The write holds the conversation row `FOR UPDATE`, reads its
     turns, and compares them with the history the turn was sent with, from
     `conversationStart` on (`planTurnWrite`).
   - **Reconciling, the exact rule.** Two entries agree when they have the
     same role and the same words: a learner's text, or a master turn's
     lines, each through the turn route's own normalisation (`replayLine`:
     one line, `|` and newlines as spaces, at most 4000 characters) and
     with whitespace runs collapsed. Glosses and timing don't count. Let `k`
     be the number of stored turns that agree with the history entry by
     entry from the start. The history **covers** the store when `k` is all
     of them, or all but the last and that last one is a master turn.
     - Covered: the stored turns from `k` on (none, or that one final
       reply) are deleted; the history's entries from `k` on are inserted;
       then the learner's message and the reply. A turn that agreed is
       never deleted or rewritten, so it keeps its timing and cost.
     - Not covered (a history shorter than what is stored by two or more
       turns, `history: []` included, or one that differs anywhere before
       the final reply): nothing is deleted or rewritten. Only the message
       and the reply are appended, after the stored turns, and the server
       logs a warning. A working browser never sends such a history.
     The final reply is the one exception because it is the one a browser
     can legitimately not show: Stop raced the answer, which the server had
     already stored. Everything before it was on screen when a later turn
     was sent.
   - That settles every way the screen and the store part: a failed or
     stopped turn's message (on screen, no reply) is stored reply-less by
     the next turn; a reply stored but dropped by the browser is deleted by
     the next turn; turns that went unsaved (creating the conversation
     failed) are stored by the first turn of the conversation made after;
     an edited "check what it heard" message only ever reaches the server
     as sent; a recast changes no words. `idx` is the entry's place on
     screen counted from the conversation's first entry (`conversationStart`:
     0, unless the conversation began mid-session), so it is gap-free and
     ordered by construction, and `unique (conversation_id, idx)` backs it.
   - **`from_client`.** A master turn inserted from the history is marked
     `from_client = true`: its words are the browser's copy, not a reply the
     server produced in that request, so a client could have written them.
     The reply the server just produced and every learner turn are `false`.
     The UI shows no difference. Anything that later reads stored master
     turns as the dojo master's own words (extraction, recall) checks it.
   - The history a turn may send is capped at 2000 entries (`HISTORY_MAX`),
     whole: a longer one is a 413 before anything runs, never trimmed, since
     `conversationStart` indexes the history as sent. Short entries fit far
     more than that in the 1 MB body cap, so this is the limit that binds.
   - Rows inserted from the history have no duration or cost; the history
     doesn't carry them. A write that fails leaves the turn standing (the
     reply is paid for) with `saved: false`, and the panel says the session
     isn't being saved; the next turn stores it.
   - `turns` has no model column: `conversations.model` and
     `planned_minutes` are updated by each saved turn (the model and length
     as of the last turn, so +5 min and a mid-session pick show).
     `turn_count` is the number of stored turns (learner and master each
     count one).
3. **End** (a new button, or closing or leaving the Go tab with a conversation
   open) sets `ended_at` and queues the extraction. A conversation left open for
   2 hours is ended on the next server request. As built:
   - `POST /api/conversations/:id/end` is idempotent: only a row whose
     `ended_at` is null is updated. End, Restart, Close, leaving Go and
     page unload all call it; unload uses a `keepalive` fetch (not
     `sendBeacon`, which can't send the `X-Learner-Id` header `wrap` checks).
   - End and a turn share the conversation's lock (point 4). A turn takes it
     as soon as its body names the conversation, before any query; End, after
     checking the conversation is the learner's, waits until no turn holds
     it, then holds it itself while it writes `ended_at`. So a turn the
     server has already received is stored before the end, and a turn that
     arrives while End holds the lock is refused with `conversation_ended`
     before the dojo master runs. A turn is never answered and then left
     unsaved because End came in between (checked on a real Postgres by
     `conversations.pg.test.mjs`). The browser covers the turn the server
     hasn't received yet: when ending (End, Restart, leaving Go) it sends End
     once the open conversation's turn on the way has its answer. Only
     pagehide and unmounting send it at once (the turn dies with the page).
     A turn may not have made its conversation yet when the session closes
     (it is still drawing its cast, or creating it), so the check sits
     where a conversation comes into being, not at each await: every close
     bumps a counter each turn compares with the value it began with, and a
     conversation whose creation answers after a close, or while Go is
     hidden, is never adopted. It holds that one turn and is ended once the
     turn has its answer, or at once if the session is gone (End, Restart,
     the panel closed; `web/src/conversationLife.ts`). The next turn starts
     a new conversation.
   - Leaving Go keeps the session on screen; a turn after coming back
     starts a new conversation (from that turn on). Reload ends the
     conversation and the session; it can't be resumed until the history is
     read back from the database.
   - The idle end is lazy: every conversation route and the voice turn first
     end the account's open conversations, in every language of every
     learner (so one left open in another language still ends and its hook
     still runs), whose last turn (or start, with
     none) is two hours old or more, with `ended_at` set to that last
     activity rather than now, so History's length isn't two idle hours
     longer. A conversation with a turn running is skipped (its last turn is
     about to be now); the turn's own request checks its conversation.
   - The extraction attaches to `onConversationEnded(conversation)` in
     `web/server/conversations.ts`, called at most once per conversation:
     exactly once for every conversation that ends, after the one write that
     set `ended_at` (whichever way it ended). Deleting a conversation that
     is still open does not call it; it never ends, it is gone (tested). It
     does nothing yet.
   - The page sends End before it switches learner or language (see
     Language profiles). An End that still arrives after the switch is a
     `stale_learner` and is ignored; that conversation ends by the idle rule,
     on the account's next conversation request in any language.
4. **One turn at a time per conversation.** Today a single global flag refuses
   a second voice turn while any turn is running. With more than one person
   practicing, that flag becomes a lock keyed by conversation id, so two
   learners never block each other and one conversation still can't race itself.
   As built: an in-memory lock keyed by learner and conversation id (by login
   session for a turn with no conversation), so another learner naming the
   id touches nothing; a second turn is a plain 409, and a turn while End
   holds it is 409 `conversation_ended`. One server process, so in memory is
   enough; it would not hold across processes.
5. A **History** view (Library tab) lists past conversations with
   their summaries and opens one read-only in the transcript components. As
   built: a second view of the Library tab beside Saved packs, newest first,
   20 a page (`GET /api/conversations?offset=&limit=`), each with date,
   length, turn count and summary (null until extraction); opening one pages
   through its turns (`GET /api/conversations/:id?from=&limit=`) and shows
   them with glosses tappable and no audio. Delete is a hard delete with a
   confirm (`DELETE /api/conversations/:id`); the turns cascade. A page's
   start (`offset`, `from`) past 2^31 − 1 is clamped there: an empty page,
   never a query Postgres refuses.
6. **Routes** (`wrap(…, { learner: true })`, every row through
   `profileRows(ctx.language)`): another language's or learner's conversation, guessed id or not, is
   the same 404 as a missing one, and an id that isn't a uuid never reaches
   Postgres.

## Phrase capture

| Source | When | What it writes |
|---|---|---|
| Glosses | each turn, in the turn transaction | upsert phrase (`source=gloss`); `seen_count`+1; `last_seen_at`; example = the line holding the term; `recognize` card if none. No FSRS review: seeing is not recalling |
| Scenario lists | conversation start | `vocab:` → complete phrases; `phrases:` → pending phrases (meaning only) |
| Manual | tapping a glossed word → ☆ Star; Add in the bank | upsert, `starred=true`; no card (practice makes one) |

As built (phase 4): a turn captures the glosses of the server's own reply
(not a `from_client` one), only those of at most 3 words (a sentence's
translation is not a phrase), and only when the session's target language is
the profile's (a pack can override it; then nothing is captured). An example
is the line that holds the term, at most 10 per phrase, deduped by sentence.
The capture runs in a savepoint of the turn's transaction: if it fails, the
turn is saved without it and the server logs it. A scenario's `vocab:` is
taken only when the scenario's `language:` is the profile's (or it has
none); its `phrases:` always. Scenario phrases are unseen (seen count 0, no
card) until a session glosses them.
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

#### As built (phase 5)

Bead `ld-aeu`, migration `0004_session_recap`. Code: `web/server/extraction.ts`
(the run, the model call, the routes), `scripts/db/extraction.ts` (the
claim and the one write; the bank's only writes outside
`scripts/db/phrases.ts`, reusing its upsert identity, pending merge,
recount and retry), `scripts/extraction.mjs` (pure: prompt, parser,
transcript, the plan of what a reply may do, examples), and in the
browser `SessionRecap.tsx` (the card) and `bankLink.ts`.

- **When.** `onConversationEnded` (End, Restart, leaving Go, Close, unload,
  the idle end) starts the run in the background (`setImmediate`, never
  awaited by the request). The run reads the stored turns; a conversation
  in which the learner said nothing is `skipped` with no model call. The
  call is `claude -p` with no tools, one turn, an empty temp cwd, the
  user's agent model (`getModel`), 180 s; the transcript is the stored
  turns as "Learner: …" / "Dojo master: …" lines (at most 60 000
  characters, the oldest turns dropped and said so), plus the phrases due
  when the session started (a reviewed card due by then, at most 20). A
  failed call or a reply `parseExtraction` rejects is tried once more;
  after the second the conversation is `failed` with the reason in
  `extraction_error`: fixed wording only ("the model call didn't work",
  "the reply wasn't a recap", "the recap couldn't be saved", "no reply",
  "its learner or language is gone", or the CLI's own sign-in, limit or
  overload hint), never a CLI's output or a database error (which hold
  SQL, the recap's JSON and ids); those go to the server log with their
  cause. A stored reason that is none of these reads as "the recap
  couldn't be made". Model text is made well-formed before it is stored
  (lone surrogates, zero-width space, word joiner and BOM removed, as well
  as the control characters), so a reply can't fail the jsonb write.
  `extractJsonObject` reads at most 200 000 characters and tries at most
  64 opening braces, so a reply of unbalanced braces can't stall the
  server.
- **Migration 0004** adds to `conversations` `extraction_status` (not
  null, default `none`; check in none|running|done|failed|skipped),
  `extraction_claim` (uuid; a check makes it set exactly while running),
  `extraction_started_at`, `extraction_attempts` (default 0; counted only
  by the run holding the claim) and
  `extraction_error`; and to `phrase_sightings` `source` (not null,
  default `gloss`; check gloss|extraction) with a partial unique index
  `(conversation_id, phrase_id) where source = 'extraction'`. Plain
  additive SQL, no hand edits: existing conversations read `none` (an
  ended one offers "Make a recap" in History), existing sightings
  `gloss` (they all are). `db-migration-0004.test.mjs` (PGlite) and
  `migration-0004.pg.test.mjs` (PostgreSQL 17) migrate a 0003 database
  with open and ended conversations, turns, phrases, an example, a
  sighting, a card and a review: every old row unchanged, the defaults
  filled, the schema a fresh build's, the checks enforced.
- **The claim.** One conditional UPDATE sets `running` and a fresh token
  where the row is ended and its status is one the caller may take over:
  `none` for the end hook; none, failed, done or skipped for a Retry. So
  two Ends, End racing the idle end, or a Retry while it runs make one
  run; the loser matches nothing (a Retry then answers 202 with the
  pending recap). A `running` row whose token no run of this server
  holds (in-memory `live` set; one server process, as for the turn lock)
  died with an earlier server: the recap reads `failed` ("interrupted")
  and can be claimed again. Claims of one conversation are serialised in
  the server so `live` is never stale while one is decided. The final
  write locks the conversation row and goes ahead only while it still
  holds its token.
- **The write**, one transaction (retried once on a unique violation or
  deadlock), in the bank's lock order: the conversation, then one
  norm-ordered pass over every complete phrase it touches (the kept
  phrases upserted, the ones events name, and the last run's phrases by
  id, so one renamed since is still locked, restored and recounted), then
  pending rows, then cards. Only when the session
  was in the profile's language (`bankLocale`, as the turn capture);
  otherwise the recap is stored and the bank left alone (`inBank`
  false).
  - Model output is untrusted. The parser strips control characters
    (`phrases.mjs clean`) and caps every field; ids are never read:
    phrases are matched by `normKey` within the conversation's profile.
    A kept phrase longer than 6 words (20 characters in a language
    without spaces) is a sentence and isn't kept (`MAX_KEEP_WORDS`).
    One the learner deleted isn't brought back: a phrase not already in
    the bank is skipped when its text (`phrase_dismissals` kind `text`)
    or its meaning (kind `meaning`, as a deleted scene phrase leaves) was
    dismissed.
    The model's `example` isn't stored: a kept phrase's example is a
    line of the dojo master's own replies (not `from_client`, not the
    learner's) that holds it, as for a gloss.
  - `keep` upserts complete phrases with `source = 'extraction'`: the
    weakest provenance, so an existing phrase keeps its own; a meaning is
    only filled when blank, so a learner's edit is never overwritten. A
    pending scene phrase with the kept meaning is folded in (the merge
    rule).
  - `events` name a phrase the bank has, or one `keep` makes; others
    are dropped. One per (phrase, skill), the lowest rating winning. The
    card is made if missing, reviewed with `ratingForSessionEvent`'s
    rating at the conversation's `ended_at` (server time zone for FSRS's
    day boundary), and a `reviews` row written (`mode` session, `answer`
    the `said`, `grader_note` the note, `card_before`). A suspended
    phrase gets no review, nor does a card whose `last_review` is after
    `ended_at` (practised, or reviewed by a later session's recap, before
    this recap was made or retried): reviews only go forward. Mode
    `session` keeps these out of Practice's daily limits, and Practice's
    override only regrades `flashcard` rows, so the two never restore a
    card over each other; the undo below reads only the FSRS fields of
    `card_before`, never Practice's extra keys.
  - Tone misses (ld-ne0.18, adult Mandarin sessions; which flags and
    which phrase: docs/VOICE.md §Tones after the session): a bank phrase
    the session's stored tone flags fail has its produce card reviewed
    with Again, as the one session review of that card: in place of the
    rating of the model's own event, or alone when there is none (`answer`
    is then the line). The phrase joins the norm-ordered lock pass, and
    the same skips hold (suspended, reviewed later). Kept in the stored
    recap's `tones` [{phraseId, phrase, line, syllables, flags, was,
    reviewed, dismissed, idle?}], never in `events`, so a revisit carries none.
    `dismissToneMiss` ("I said it right") locks the conversation, the
    phrase and the card, restores `card_before`, grades it `was` (null:
    deletes the review, and a card it made) and sets `dismissed`, which
    re-runs carry on (`idle` while a run has no such miss).
  - Seen: a phrase the recap names (or a tone miss fails) that none of the
    session's replies glossed gets one `extraction` sighting at `ended_at`; counts and
    times are recounted from sightings, `last_practiced_at` from the
    phrase's reviews.
  - **Idempotent re-run.** First the last run is undone: its
    `extraction` sightings deleted; each of its session reviews, if no
    later review of that card exists, deleted with the card restored
    from `card_before` (a listen/produce card that goes back to never
    reviewed and isn't reviewed again is deleted). A card reviewed
    since (practice) keeps the old session review and isn't reviewed
    again. A phrase the re-run leaves with no sighting is settled by the
    one rule a dropped reply's undo uses too (`settleUnseen`), whichever
    of the two comes last: deleted, with its unreviewed cards, when only
    automatic paths held it (`source` gloss or extraction, nothing the
    learner set, no reviewed card); otherwise kept, unseen, without its
    unreviewed cards. The same reply twice leaves cards, reviews, phrases,
    sightings and examples identical (tested).
- **Stored**: `summary`, `extraction` (`{v: 1, summary, keep[{text,
  meaning, why, phraseId}], events[{phrase, kind, said, note, phraseId,
  reviewed}], corrections, dropped, inBank,
  tones?}`), `extracted_at`, status
  `done`.
- **Routes** (with the conversation routes' `learner: true` scope):
  `GET /api/conversations/:id/recap` → `{recap}` (status open, none,
  pending, done, failed or skipped; the kept phrases with their star and
  mastery now), `POST` → 202 `{recap}` (make it again; 409 while the
  conversation is open). Another language's or learner's is a 404.
  `POST …/recap-tones {phraseId}` → `{recap}`: "I said it right" (404 no
  such miss, 409 while the recap is made or once the card was reviewed
  later).
  `ConversationSummary.recapStatus` gives History its "no recap" badge.
- **UI.** `SessionRecap.tsx` under the transcript: on the Go tab after
  End (it waits quietly through `open`/`none` for 30 s while End and the
  claim land, then says what is up and offers Make a recap or Check
  again, still asking) and in History. It asks every 2 s while the
  recap is on its way, for up to 10 min (then "Still being written" and
  Check again); a failed request shows its error and is asked again
  every 5 s; a tab shown again asks at once. Summary;
  phrases kept with their band, ☆ Star and "In the bank" (switches to
  Library → Phrase bank searching for it, `bankLink.ts`); what went
  well; what to work on (corrections and corrected/confused events);
  "Retry recap" when failed, "Make a recap" for one never made.
  Its target-language text (kept phrases, events, corrections) takes the
  transcript's readings (`RubyText`, the transcript's Readings switch:
  no switch of its own).
- **Kids** (DATA.md is silent beyond "session capture" for kids): the
  same pass and bank writes for a kids learner; the prompt adds a line
  asking for a child's summary in simple words, and the card's wording
  is simpler ("What you did today", "New words", "Try saying it like
  this"; no mastery bands, no event list).
- **Not built here:** the review block and `LOOKUP` (phase 6) and
  Practice (phase 7). The due phrases passed to the prompt are those due
  at the session's start, since no review block chose any yet. (Phase 6:
  a session whose pack has a recall unit passes the phrases its review
  block offered instead; see "As built (phase 6)" under Recall in
  sessions.)

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
LOOKUP: market phrases | since=7d
```

The window is a fixed machine form, so it does not depend on the language the
dojo master writes the words in (`since=<N>d`, or `since=YYYY-MM-DD` with an
optional `until=YYYY-MM-DD`, exclusive; the voice rules in `scripts/voice.mjs`
say so). English date words still work as before (below).

The server runs that query against the phrases and the conversation summaries
(trigram, plus a date window when the query names one). It then reruns the
turn once, with the results under `[LOOKUP RESULTS]`, and a second `LOOKUP`
in the rerun is ignored. Only those turns pay a second model call. The turn
row records the lookup. `parseVoiceReply` ignores `LOOKUP:` lines, so they are
never spoken.

### As built (phase 6)

Bead `ld-mey`. **No migration.** Code: `scripts/recall.mjs` (pure: the
grams and similarity, the review's choice and rendering, the retrieval,
the LOOKUP search and blocks), `web/server/recall.ts` (the reads, the
session's review, a turn's recall, the assemble and export routes, the
recap's offered list, LOOKUP), the turn route in `web/server/voice.ts`,
`parseLookup` and the adapter in `scripts/voice.mjs`, `packUnits` in
`scripts/content.mjs`, the bank reads `recallBank`, `recallPhrases` and
`recallDetails` in `scripts/db/phrases.ts`, the units
`content/units/recycle-due-phrases.md` and
`content/kids/units/recycle-words.md`, and the Go tab's line (`GoTab.tsx`
`RevisitLine`). Where it differs from the plan above:

- **Similarity is computed in JS, not with `pg_trgm`.** Word trigrams
  behave poorly for a language written without spaces: a run of Chinese
  characters is one "word" to `pg_trgm`, so a two-character phrase inside
  a sentence shares almost no trigram with it. Here a spaced word gives
  `pg_trgm`'s padded trigrams (accents and case folded for Latin, Greek
  and Cyrillic letters), and a run of an unspaced script (Han, kana, Thai,
  Lao, Khmer, Burmese, Tibetan) its character bigrams, every character too
  where the text is searched in, so 多少钱 is found in 这个多少钱？. A
  phrase's score is the share of its grams found in the text
  (`containment`, `word_similarity`'s direction without its window). Each
  distinct phrase or meaning text is turned into grams once and kept
  (`needle`, a cache keyed by the text, cleared whole at 50,000 entries),
  so a turn's ranking is lookups, not string work. The trigram GIN indexes
  stay unused by recall (made in phase 0, kept).
- **The review block.** A `recall` slot (adult: "Phrases to revisit",
  kids: "Words to bring back"; `pick: one`, optional) with the default
  units `recycle-due-phrases` and `recycle-words`, whose bodies end in
  `{{phrase_review}}`. `assemble(content, pack, { mode, review })` (a
  bare mode string still works) renders `review` as a delimited list
  (`[FROM THE LEARNER'S PHRASE BANK]` … `[END OF PHRASE BANK]`, one
  "target — meaning" line each; a phrase never practised, such as a
  starred one not learned yet, ends "(new: not practised yet)", and the
  units tell the dojo master to introduce those rather than hint at them).
  **With nothing to review the unit is left out**, and the slot with it
  when it is empty, so the prompt has no heading, unit or placeholder for
  it (the plan's single "No phrases due yet." line is not built: a line
  that asks for nothing is noise in every prompt of a new learner).
- **Packs saved before the slot.** The slot is `backfill: true` in both
  schemas: a pack with no unit of it and no `-recall` entry in its
  `units` (one saved before the slot existed) plays the slot's default
  unit (`packUnits`, at assemble time and in `picksRecall`); setting the
  slot to None in Customize saves `-recall` in the pack's units, which is
  respected. No saved pack is rewritten: the Customize tab shows such a
  pack with the default ticked (`withBackfill` in `web/src/draft.ts`,
  when a pack or the remembered draft is loaded), and only a save writes
  it. Per-turn retrieval and LOOKUP don't need the unit.
- **What the review chooses** (`selectReview`): a phrase with words, not
  suspended, that is due (a reviewed card of any skill due), in trouble
  (2+ lapses in 30 days, due or not), or starred and never practised.
  Score: due 2 + log2(1 + days overdue), trouble +1.5, a star +0.75,
  starred-new +1, and relevance to the scene (its words or meaning found
  in the scenario's title, summary, tags, beats, vocabulary, phrases
  list, or a quick scenario's text) up to +4 when at least half of it is
  found. Ties by due, then first seen, then id. At most 10 (kids 3).
  **Kids** also bring back a word met in an earlier session and never
  reviewed (+0.5): a child has no Practice tab, so a recap is a word's
  only review, and bringing it back is how it gets one.
- **Fixed for a session.** The review is chosen once, when the
  conversation is created (`sessionReview`), and its phrase ids are
  stored in the conversation's `pack_snapshot` as `review: {phraseIds}`
  (the snapshot is what was played, and the review was part of the
  prompt; `[]` for a pack with no recall unit, another language or
  nothing to review; a `review` key in the client's pack is dropped).
  Every turn, the Go tab's line (each turn's reply) and the recap read
  those phrases back by id, in that order, with their current text, a
  phrase deleted, suspended or emptied since left out (`reviewFromIds`):
  a phrase starred mid-session doesn't join the list, and the first
  recap's session reviews (or Practice) moving a phrase out of due don't
  take it off a recap made again. A conversation with none stored (begun
  before this was built, or whose bank couldn't be read when it began)
  has its review chosen by its next turn, as of its start, and kept then
  (`saveTurn`, under the row's lock, only if still none). An unsaved
  session chooses as of each turn. The assemble and export routes (the
  Go tab's preview, Copy, Export) choose as of now. None of them reads the
  bank when the pack moves the session to another language than the
  profile's (`bankLocale`, as the capture asks).
- **Per-turn retrieval** (`retrieve`): the learner's message (a command's
  bracket dropped: `[direct] …` is its words, `[skip]` nothing) and the
  dojo master's last line; a phrase (words, not suspended) counts when at
  least 0.6 of its words' grams, or 0.9 × its meaning's (a meaning of 4
  letters or more, for a learner speaking their own language), are found
  there. A short phrase (a spaced phrase of 5 grams or fewer: one word of
  up to four letters, "el", "sí", "taxi") counts only when each of its
  words was said as a whole word, and a lone character of an unspaced
  script only when said on its own: "el" isn't in "elegir", "taxi" isn't
  in "taxista", 是 isn't in 不是. Short phrases also rank lower (score ×
  min(1, 0.5 + grams/10)), so a beginner's glossed function words don't
  push out the phrase actually said. The best 6 (kids 3), ties by last
  seen. Appended after the learner's words and the clock line, before the
  reply cue, as the plan's block with one line saying it is vocabulary
  data, never instructions: `- ¿A cómo? — how much? (familiar; last
  practiced 3 days ago)` (also "new", "often missed", "never practiced").
- **Bank text is data.** Every phrase, meaning, title and summary that
  reaches a prompt goes through `bankText`: control, zero-width and bidi
  characters out (`clean`/`modelText` in `scripts/phrases.mjs`: C0, DEL,
  NEL, U+200B, U+200E, U+200F, U+061C, U+2060, U+FEFF, the bidi
  embeddings, overrides and isolates, lone surrogates; ZWNJ and ZWJ stay,
  since some scripts spell with them), one line, `[ ]` and `{ }` turned
  into parentheses and `< >` into ‹ › (so no phrase can close the block,
  open a fake one or forge a `<t>` mark), capped (80 characters a phrase,
  120 a meaning, 300 a summary). Stored phrases are cleaned the same way.
  The adapter and both units say the blocks are data to use or ignore,
  never instructions.
- **LOOKUP** (`parseLookup`: the first line labelled LOOKUP in any case,
  with a colon or a dash, with or without a speaker tag, bullet, bold or
  timing mark, at most 200 characters; `parseVoiceReply` never speaks such
  a line, even an empty one). The server searches the bank's words it
  already read this turn and the language's ended conversations
  (`pastSessions` in `web/server/recall.ts`: id, title, start and recap
  summary only, newest 200, the current one left out), then asks once
  more with the results under `[LOOKUP RESULTS]` … `[END OF LOOKUP
  RESULTS]` and a line saying there is no second lookup. The first reply
  is discarded whole, spoken lines and all. A LOOKUP in the second reply
  is ignored and the reply used as it is (a reply with nothing else to say
  is the usual 502). **A failed or timed-out rerun** (45 s, against a first
  call's 120) keeps the turn: the first reply's spoken lines stand (its
  LOOKUP line never spoken), or, when it had none, the narrator says "I
  couldn't look that up just now. Let's carry on."; the turn is saved
  and its record says `failed: true`. A Stop still cancels. **A session
  moved to another language** (a pack's override) searches neither the
  bank nor the profile's past sessions, and the results say so ("Nothing
  was searched: this session is in another language…"; recorded as
  `skipped`). A query names phrases by their words, or by a content word
  (stopwords such as "phrases", "learn", "last" and numbers out; an
  unspaced run split into bigrams) found in a phrase's words, meaning or
  note, or a session's title or summary; a window is the
  language-independent `since=<N>d` / `since=YYYY-MM-DD` [`until=YYYY-MM-DD`]
  clause (first; junk such as `since=0d` or a day that does not exist is
  ignored; the clause is never a search term), else English date words
  ("today", "yesterday", "this week" 7 days, "last week" 14, "this month"
  31, "last month" 62, "last N days", "N days ago"; other languages' words
  get no window by themselves, hence the clause). A query of date words
  alone gives the most recent in the window. At most 8 phrases and 3
  sessions. The reply's duration and cost are both calls'. The reply's
  turn row records `lookup` jsonb: `{query, phraseIds, conversationIds,
  ms, repeated?, failed?, skipped?}`, or `{query, late: true}` for one that
  came after a streamed turn's lines had gone out (not run; docs/VOICE.md
  §Streaming the reply).
- **Session reviews** stay the recap's alone (§Post-session extraction):
  there is no second review path. The recap's prompt lists the phrases
  the session's review offered (its stored ids, as above) under "PHRASES
  OFFERED FOR REVIEW THIS SESSION", so a use of one is judged as the
  recycling it was asked for. A session whose pack had no recall unit
  gets the due phrases as before, labelled as only due.
- **Reads, no locks.** Recall only reads, with plain SELECTs: no row
  lock, so a turn never waits behind a capture, a recap's write or a
  practice answer holding the bank's rows, and never makes them wait
  (the bank's lock order is untouched). A failed read is logged and the
  turn goes on without recall. `recall.pg.test.mjs` holds every phrase
  and card of a 600-phrase bank `FOR UPDATE` while both kinds of read run.
- **What a turn reads.** A turn with its session's review stored reads
  the bank's words only (`recallPhrases`: id, text, meaning, note, flags
  and dates; no cards, lapses or FSRS), ranks the retrieval on them, then
  reads the metrics of just the review's and the hits' phrases
  (`recallDetails`, a dozen rows at most). Choosing a review (a session's
  start, a preview, an old conversation's next turn) reads the whole bank
  with its metrics (`recallBank`: listPhrases without the example
  counts). A LOOKUP reads the metrics of its hits the same way.
- **Latency** (PostgreSQL 17 on this Mac, `recall.pg.test.mjs`, banks
  with a reviewed card on half the phrases, 30 turns each; the ranking is
  synchronous on the server's one thread):

  | Bank | A turn: median (p95) | of which reads | ranking | Choosing a review |
  |---|---|---|---|---|
  | 600 phrases | 3.9 ms (5.8) | 2.7 ms | 1.3 ms | 4.6 ms |
  | 3,000 | 24.3 ms (26.1) | 16.2 ms | 8.1 ms | 32.1 ms |
  | 6,000 | 48.6 ms (51.7) | 29.0 ms | 19.3 ms | 60.0 ms |

  Before (every turn reading the whole bank with its metrics and example
  counts, grams computed afresh, the review chosen again): 68 ms at
  3,000 and 139 ms at 6,000 (the review's measurement, a bank with two
  cards per phrase). A tool-less model turn takes seconds, and a LOOKUP
  turn pays a second model call. `LINGO_DEBUG_RECALL=1` logs each turn's
  time to the server console.
- **The Go tab** shows the review under "How long do you have?", closed
  by default: "Revisiting 4 phrases from your bank" (kids: "3 words from
  before come back today"), opening to the "target — meaning" list, the
  target text with the reading aid where the language has one (`RubyText`,
  the Readings setting). The preview's list is `/api/assemble`'s
  `review`; once a session runs, each turn's reply carries the session's
  list (`VoiceTurnReply.review`) until the preview is assembled again.

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

#### As built (phase 8)

Bead `ld-t5f`, migration `0005_bank_reader`. Code: `scripts/bank-mcp.mjs`
(the server: `bankReader`, the four tools, `fit`, `pgSessions`,
`configFromEnv`), `bankAccess` and `bankPrompt` in `web/server/chat.ts`,
`mcpServers`/`mcpTools` in `scripts/claude.mjs`, the role's grants and
policies in `scripts/db/hand-edits.mjs` (`READER_COLUMNS`, `READER_0005`),
`readerRole` in `scripts/db/config.mjs`, `bankReaderProblem` in
`scripts/db/migrations.mjs`, `agent_messages.bank_language_profile_id`,
and the line in `ChatPanel.tsx`. Where it differs from the plan above:

- **Scope: the learner and the language.** The bank is per language
  profile (migration 0003), so the scope is both: the session's active
  learner and active language, fixed when chat.ts writes the run's MCP
  config (`LINGO_BANK_LEARNER_ID`, `LINGO_BANK_LANGUAGE_PROFILE_ID`,
  `DATABASE_URL`, `LINGO_READER_ROLE` in the server's `env`), never from a
  tool argument. No tool takes a learner or language. An admin with no
  learner picked gets no bank server, no bank tools and no prompt section.
  With a learner picked, `POST /api/chat` checks the page's
  `X-Learner-Id` and `X-Language-Profile-Id` against the session like
  every `learner: true` route (409 `stale_learner`, before anything runs
  or is stored): a tab still showing one learner can't send a run that
  reads another's bank. The panel then re-reads its history and bank line,
  and the auth gate catches the page up. With none picked there is
  nothing to check.
- **The agent's history doesn't cross learners.** The transcript is the
  admin's (`agent_messages`), and each run replays its last 40 messages
  into the prompt. A run with a bank stores its user message, reply and
  commit line with the language profile it read
  (`agent_messages.bank_language_profile_id`, migration 0005; deleted with
  the profile). A run replays only the messages of runs without a bank and
  of runs that read the same language profile, so nothing the agent read
  or wrote about one learner reaches a run for another. The panel still
  shows the whole transcript.
- **Kids.** For a kids learner the server runs with `LINGO_BANK_KIDS=1`,
  and `get_conversation` leaves out what the child said: a learner turn
  is `{ who: "learner", text: null, omitted: true }`, its text never even
  selected, and the result carries a note saying so. The dojo master's
  lines, the glosses, the recap and the phrase bank are unchanged: enough
  to see what the child practised and missed, without their own words (the
  most personal part of a session, and a child's). The prompt's bank
  section says why, and the panel's line adds "(not what they said)".
- **The role is entered, not logged in as.** `lingo_reader` is a NOLOGIN
  role with no password, so there is no new secret. The app's own role is
  granted it `WITH INHERIT FALSE, SET TRUE`: it never has the reader's
  privileges by default, and may switch to it. Each tool call is one
  transaction on the MCP process's own connection (`pgSessions`: one
  pg.Client, held for the whole call; if it is lost mid-call that call
  fails, and only the next call opens a new one). Each connection runs
  `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` as soon as it
  opens, and checks it took, rather than a startup `options=`, which a
  `DATABASE_URL` with its own `options=` would replace. The call:
  `BEGIN … READ ONLY`, `SET LOCAL ROLE lingo_reader`, `set_config('app.learner_id', $1, true)` and
  `app.language_profile_id` (transaction-local, so nothing outlives the
  call), a 5 s statement timeout, then a check that `current_user` is the
  reader, the transaction is read-only and the role is neither superuser
  nor BYPASSRLS; always rolled back.
- **What the database enforces, whatever the MCP's code does.** The
  reader has `SELECT` on exactly these columns (`READER_COLUMNS`) and
  nothing else in the database: `conversations` (id, owner ids, title,
  scenario, languages, dates, turn count, the recap's `summary`, its
  status), `turns` (id, owner and conversation ids, idx, role, text, lines,
  glosses, from_client, created_at), `phrases` (id, owner ids, text,
  meaning, source, starred, suspended, the seen and practised dates and
  counts), `cards` (owner and phrase ids, skill and the FSRS fields) and
  `reviews` (card and owner ids, mode, rating, time, `card_before`). Not
  granted: every account table (users and their password hashes, sessions,
  settings, the agent chat), learners and language profiles, packs,
  examples, sightings, dismissals, cloze items, a phrase's note, a typed
  practice answer, the recap JSON and the pack snapshot. Those five tables
  have RLS **enabled, never forced**, with one policy each,
  `bank_reader_scope`, `FOR SELECT TO lingo_reader` only: `learner_id =
  current_setting('app.learner_id') AND language_profile_id =
  current_setting('app.language_profile_id')` (an unset setting is NULL
  and matches nothing). Every child table carries both ids itself (the
  denormalized keys of phase 0 and 0003), so no policy needs a join to a
  parent. A write fails twice over: the transaction is read-only, and the
  role has no INSERT, UPDATE, DELETE or TRUNCATE anywhere. There is no view
  (a view runs as its owner, past RLS) and no SECURITY DEFINER function in
  `public`; a test keeps it so.
- **The owner is unaffected.** RLS is enabled, not forced, and the policies
  name only the reader, so the table owner (the app's role) and superusers
  read and write exactly as before. The whole `npm test` suite now runs as
  a non-superuser table owner (`testdb.mjs` `APP_OWNER`), so every existing
  query path is exercised with RLS on.
- **What it doesn't stop.** The MCP process's connection is the app's
  role, so SQL it ran could `RESET ROLE`, or set `app.learner_id` to
  someone else (both shown in `bank-mcp.pg.test.mjs`). The guard against
  that is the code: every query is fixed and parameterised, names the
  learner and language in its own WHERE as well, and the model supplies
  only a search string, a limit or a conversation id, as bind parameters.
  The role and RLS are the second layer, against a query of ours that
  forgot its WHERE, joined wrongly or wrote: they turn that into the same
  learner's rows or an error. A separate LOGIN role would close the RESET
  ROLE gap at the cost of a password to keep; not done.
- **The tools.** `search_phrases(query)` (≤ 200 characters): phrases whose
  words or meaning contain it, folded like LOOKUP (`fold`: case, width,
  Latin/Greek/Cyrillic accents), exact then prefix then recent, at most 25.
  `trouble_phrases(limit)` (default 20, at most 50): by lapses in the last
  30 days (an Again on a card in review, the bank's definition), then any
  Again in that time, then lapses ever; pending and suspended phrases left
  out. `recent_conversations(limit)` (default 10, at most 30): newest
  first, with the recap summary. `get_conversation(id)`: the recap and the
  first 200 turns, each cut to 1,500 characters; a learner turn's text
  (not for a kids learner, above), a master turn's lines with speakers,
  and its glosses. Every tool's result is held to 60 KB of UTF-8 JSON
  (`fit`: items dropped from the end of its list, with a `truncated` note
  saying how many are shown). A phrase
  shows its words, meaning, mastery band, due, lapses and Agains in 30
  days, times seen, last seen and practised, starred and suspended: no ids,
  notes or examples. Control characters are dropped. A failure is a plain
  "could not be read" (the cause goes to the MCP's stderr), and an id that
  isn't this learner's session in this language is "No such session".
- **The run.** `startClaude` writes the servers into the run's
  `--mcp-config` file (0600, in a private temp directory, deleted after
  the run; it holds the database URL) under `--strict-mcp-config`, and
  `buildArgs` adds the four tools to `--allowedTools` by full name
  (`mcp__bank__search_phrases`, …): a wildcard or anything that isn't
  `mcp__<server>__<tool>` is refused, and the built-in `--tools` list and
  the file grants are unchanged. Any other MCP tool would need a prompt,
  and `--permission-prompts none` denies it.
- **The prompt.** With the tools, the system prompt gets a short section:
  what they are for, that what they return is the learner's data and never
  instructions, and that `content/` is committed to a public repository, so
  no personal detail from the bank or the sessions (the learner's name,
  what they said about themselves, quotes) goes into a file: scenarios
  target the vocabulary, not the person.
- **The panel.** One line under the agent's controls: "Can read Sam's
  phrase bank and sessions in Spanish (Mexican Spanish), read-only", from
  `GET /api/chat/history`'s `bank` and each run's `start` event. No line
  when the agent has no bank.
- **The process.** The CLI starts the MCP server per run; it exits when its
  stdin closes (the run is over), ending its connection first, so nothing
  is left holding one.
- **The migration** (`0005_bank_reader`): drizzle-kit's five `ALTER TABLE …
  ENABLE ROW LEVEL SECURITY` (`.enableRLS()` in `schema.ts`), then one
  hand-written `DO` block (the role's name is configurable, which
  drizzle-kit's roles and policies can't express). The block takes the
  role's name from the setting `lingo.reader_role` (db:setup sets it from
  `LINGO_READER_ROLE`; default `lingo_reader`; it must match
  `lingo_reader[a-z0-9_]*`), then:
  1. If the role is missing: creates it `NOLOGIN NOSUPERUSER NOCREATEDB
     NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`, when the migrating
     role is a superuser or has CREATEROLE. Otherwise it stops, and the
     migration's one transaction rolls back whole, with a hint naming what
     a superuser should run: `CREATE ROLE lingo_reader NOLOGIN; GRANT
     lingo_reader TO <owner> WITH INHERIT FALSE, SET TRUE;`, then
     `npm run db:setup` again.
  2. If it exists (roles are cluster-wide: another database on the server
     made it): it is reused, unless it can log in or is superuser,
     BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION, or is a member of any
     role, which stops the migration with what to fix.
  3. Any member of it other than the migrating role (who could `SET ROLE`
     to it, or inherit the grants) stops the migration, naming them.
     Default privileges in this database that name it (which would grant
     it tables made later) are cleared when the migrating role set them
     and otherwise stop the migration, naming their owner.
  4. Grants the migrating role membership `WITH INHERIT FALSE, SET TRUE`
     unless a membership with exactly those options is already in
     `pg_auth_members`. It is granted even to a superuser, who could
     `SET ROLE` without it, so the grant is in the catalog: a role that
     later stops being a superuser, or a restore that runs as another
     role, still has it. A role that may not grant it stops with the GRANT
     to run.
  5. `REVOKE ALL` on the schema's tables and sequences from it, `GRANT
     USAGE ON SCHEMA public`, the column grants, and the five policies.
  It also adds `agent_messages.bank_language_profile_id` (the history's
  scope, above). On PostgreSQL 16+ a CREATEROLE role that creates a role
  is given ADMIN on it, which is what lets step 4 grant it SET. On
  Homebrew, where the app's role is the installing user and a superuser,
  it all just runs: the role is created, the membership granted
  explicitly, and the grants and policies made. db:setup and db:migrate
  print a failure's Postgres `detail` and `hint` lines, so the commands to
  run are on screen.
  In a linked git worktree `LINGO_READER_ROLE` must be set (shell or that
  checkout's `.env.local`), as `DATABASE_URL` must: the default is the
  real database's role. Tests on a shared server never touch
  `lingo_reader`: each throwaway database's connection string carries
  `options=-c lingo.reader_role=lingo_reader_test_<tag>_<pid>_<hex>`
  (`pg-scratch.mjs` `readerRoleFor`; any role may set that for its own
  session, where `ALTER DATABASE … SET` of a custom setting needs a
  superuser), and the role is dropped right after the database.
- **Recorded is not in place.** After migrating, db:setup checks that
  0005's RLS, policies and the reader's column grants are really there
  (`bankReaderProblem`, which counts 0005 as run when
  `agent_messages.bank_language_profile_id` exists) and fails, pointing at
  §Backups, when they are not; the dev server's boot check logs a warning
  instead (the bank tools fail closed without them, and the rest of the
  app is unaffected).

## Practice modes

There is a new top-level **Practice** tab and a **Phrase bank** view (built
in phase 4 as the Library tab's third view; Practice may reuse it). Practice builds a queue from due cards, mixed by default
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
  a batch of up to 10 phrases, in the background once the queue is built
  (the queue never waits for it), cached in `cloze_items`. As built: §As
  built (phase 7c).
- **Audio:** the speak path's synthesis with the user's voice for the
  language, cached on disk at `data/audio/<sha256 of provider, voice,
  model, format, locale, speed and text>.mp3` (`.wav` for macOS voices),
  so a card never pays ElevenLabs twice. As built: §As built (phase 7b).
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
  `close` → Hard, with "check the accent" or a highlighted letter. A spoken
  answer is held to the same rule: the recogniser writes the accent it
  heard, so "hablo" for "habló", "papa" for "papá", "esta" for "está",
  Portuguese "avó" for "avô" or Greek "πότε" for "ποτέ" is a stress or vowel
  heard wrong, `close` with `heard as "…": check the accent`. Exact only
  where the marks don't change the sound: those ordinary writing leaves out
  (Arabic tashkeel, Hebrew niqqud, Russian ё) and a short per-language list
  of same-sound words (`SAME_SOUND` in `scripts/match.mjs`: French où/ou,
  à/a, là/la…; Spanish's diacritical accent, qué/que, cuánto/cuanto, tú/tu,
  sí/si…), word for word. Any language not listed is strict. Case,
  punctuation and ¿ ¡ are ignored as for typed answers.
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

### Kids learners

Kids get the phrase bank, session capture and the review block. The practice
modes above assume reading and typing, which conflicts with kids goals
("entirely by ear"), so a kids learner's Practice tab is the word game
instead (§Kids word game). The drills' routes are a 403 for kids. (Adults
also have the word game, as the Pictures mode: §The game for adults, and
the picture library.)

### As built (phase 7a: flashcards)

Bead `ld-7p1`. No migration: `cards`, `reviews` (with `card_before`) and
`phrases.alternates` were already there. Cloze, listening, speak-it and
the audio cache are later beads (`ld-7dr`, `ld-6a0`); the flashcard
modes leave the `listen` skill's cards alone (listening and speak-it:
§As built (phase 7b)).

- **Where.** A **Practice** tab beside Library (in the "…" menu below
  `md`, like Library), hidden for kids learners; its routes answer a kids
  learner with 403. The pure rules (queue, day, limits, input checks, local
  match, verdicts, alternates) are `scripts/practice.mjs`; every query is in
  `scripts/db/practice.ts` (owner scoping through `forLanguageProfile`,
  nowhere else); the routes and the grader call are
  `web/server/practice.ts`; the page is `web/src/components/PracticeView.tsx`
  with its calls in `web/src/practiceApi.ts` and its wire types in
  `web/shared/practice.ts`.
- **Routes** (all `learner: true`, the active language's bank):
  `GET /api/practice?tz=` (what is due and new, today's progress and
  limits), `GET /api/practice/queue?length=5|10|20&direction=mixed|recognize|produce&tz=`
  (a session's cards and the same stats), `POST /api/practice/answer`
  `{phraseId, skill, version, answer? | reveal + rating, durationMs?, tz?}`
  and `POST /api/practice/reviews/:id/override {rating, tz?}`.
- **The day.** No timezone is stored: the page sends `tz`, its UTC offset in
  minutes (local minus UTC, ±14 h, else 0). The learner's day starts at
  4 a.m. there (`dayStart`), the same shift `fsrs.mjs review()` schedules by.
- **The queue.** A phrase can be asked when it has words and a meaning and
  isn't suspended (pending and suspended phrases never enter; a phrase with
  no meaning has nothing to ask either). At most one card per phrase per
  session (the two directions would show each other's answer). A reviewed
  card (reps > 0) whose `due` has come is a review, the most overdue first;
  a card never reviewed, or not made yet, is new: starred first, then most
  recently seen, then the oldest added. In "both ways", produce is new for a
  phrase only once its recognize card has been reviewed (read before you
  are asked to say it); a one-direction session drops that rule. Reviews
  claim the session first, up to the day's review limit; new cards fill the
  rest up to the day's new limit, spread evenly among the reviews.
- **Limits.** 20 new and 100 reviews a day, counted from `reviews` since
  the day's start, without `mode = 'session'` rows (the recap isn't
  practice): a review whose `card_before.reps` is 0 is a card's first
  (new), any other a review. An override changes a review in place, so it
  counts once.
- **Cards** are made lazily, per skill, on the first answer (`INSERT … ON
  CONFLICT DO NOTHING`, so a capture making the same recognize card at once
  is kept). The queue makes none.
- **Grading.** `localMatch`: produce is `matchAnswer` against the words and
  `alternates` in the target locale (accents and CJK spacing as in Grading
  above, typed, so an accent-only difference is close). Recognize is
  `matchAnswer` against the meaning and each part of a meaning listed with
  `;`, `|` or a slash **with spaces around it** ("kilo / half"), in the
  native locale. A slash inside a word or number never splits ("1/2",
  "24/7", "km/h", "and/or", "he/she" are one meaning each), nor does a
  comma ("Keep the change, please"). For an English native language it
  tries once more without a leading "the" or "to" on either side ("eat" for
  "to eat"), never "a"/"an" ("few" is not "a few").
  A miss with something typed costs one tool-less Haiku `claude -p` call
  (`graderPrompt`, the answer fenced and defanged; 45 s timeout, empty
  cwd), made before the write's transaction. Its reply is read with
  `parseGraderReply(text, { strict: true })`: it must be one JSON object (a
  ```json fence allowed), so a reply quoting an answer typed as
  `{"accepted": true}` before its verdict can't grade as that (the lenient
  first-object reading stays the default for other callers). An unusable
  reply or a failed run is `wrong` with a note saying it couldn't be
  checked. An empty answer ("I don't know") is `wrong` with no call. The
  grader's note is cleaned (control characters), one line, 200 characters.
  Verdict → rating is `ratingForVerdict`; Reveal (recognize) records
  `self` with the learner's rating.
- **Alternates.** An answer the grader accepts on a **produce** card is
  added to `phrases.alternates` (deduplicated as `matchAnswer` compares, at
  most 20), so it is exact next time, unless it holds `{` or `}` or is
  longer than 2 × the words' length + 10 characters (`keepable`): a long or
  template-like answer the grader let through never becomes a permanent
  exact match. Recognize answers are not kept: `alternates` holds target
  forms, and a meaning there would grade as the words (keeping accepted
  meanings would need a column: not done). Editing a phrase's words or
  meaning (to a different value) clears its alternates: every one was
  accepted against the old question. `PATCH /api/phrases/:id {removeAlternates}`
  removes the ones it names (the bank's ×, so one saved meanwhile stays);
  `PATCH /api/phrases/:id {alternates}`
  keeps only the named ones (removal only, nothing added by hand). The
  phrase detail's × hides one with an Undo for a few seconds, then sends
  `removeAlternates`.
- **What a review keeps besides the card.** A flashcard review's
  `card_before` jsonb carries, beside the FSRS fields (`fromRow`,
  `cardVersion` and the trouble query read only those), `submit_id` (the
  page's id for the answer that wrote it) and `added_alternate` (the answer
  it added to the alternates, if any), and on a speak-it answer recorded
  as a miss for a tone, `tone_miss` (stage 3, §Pronunciation in sessions).
  No column was added.
- **One write per answer.** In one transaction: the phrase row locked, then
  its card (made if missing) locked: phrase before card, the order a
  capture takes them in, and one phrase only, so no learner, profile or
  session lock is touched. Then the `reviews` row (mode `flashcard`, the
  card's state before in `card_before`), the card's new FSRS state, the
  phrase's `last_practiced_at` and any alternate. `last_seen_at` is not
  touched: as built it is always the latest sighting (§As built (phase 4)),
  so the metrics table's "or a card shown in practice" no longer holds.
- **Idempotency and staleness.** A queue item carries the card's
  **version**, `reps:last_review` ("0:" for a card not made yet), which
  every review changes, and the phrase's **revision**, a 16-hex hash of its
  words, meaning and alternates (`phraseRevision`), which every edit that
  changes the question changes (the version doesn't: an edit touches the
  phrase, not the card). The page makes a **submit id** (a uuid) per card
  shown and sends all three. A revision that no longer matches is a 409
  before any grading (no model call), and again under the lock for an edit
  during grading; the page offers Skip and the next session has the edited
  card. A card still at the version takes the answer. One that moved on is
  a replay only if a review of that card carries this submit id (a double
  click, a retried fetch): the reply is that review with `replayed: true`,
  nothing written, and the page says it was already recorded. Any other
  answer at that version (another tab) is a 409, never another answer's
  review passed off as its own. A submit already stale before grading never
  calls the grader.
- **Override.** Only a card's latest review can be changed (else 409). The
  card is restored from `card_before` and reviewed again with the new
  rating at the review's own time; the review row takes that rating and
  verdict `self` (answer and note kept). The same rating again is a no-op.
  Because the time is the original one, the version doesn't change, so a
  resend of the original submit still replays (now the overridden review)
  and the next card answer isn't refused. An **Again** takes the review's
  `added_alternate` back out of the alternates, whatever the verdict says
  by then (accepted → Hard → Again removes it as surely as accepted →
  Again); a later Good doesn't put it back.
- **The bank.** Its metrics read cards and reviews live, so mastery, due,
  last practised and trouble (lapses: Again on a card whose `card_before`
  was in review) change with the next read of the Phrase bank.
- **Tests.** `practice.test.mjs` (the pure rules), `practice.http.test.mjs`
  (the routes with a stand-in `claude`: the queue, each verdict, the
  grader's prompt and argv, alternates, Reveal, a repeat submit, overrides,
  trouble, the new limit and the day boundary, two languages, another
  account, kids, a suspension or an edit while grading, a stale revision
  before grading, a different answer at the same version, accepted → Hard
  → Again and accepted → Again, alternates dropped on an edit and removed
  by hand, a grader reply quoting the answer's JSON, braced and long
  answers not kept, uuid-shaped ids that aren't uuids), and
  `practice.pg.test.mjs` (with `LINGO_TEST_PG_URL`, PostgreSQL 17): one
  submit sent on six connections (one written, five replayed), six
  different answers at once (one written, five 409, none replayed), an
  answer against a capture making the same card and an edit, an override
  against the next answer (the lock tests fail with the row locks
  removed).

### As built (phase 7b: listening, speak-it, phrase audio)

Bead `ld-6a0`. No migration: the `listen` card skill and the
`listening` / `speak` review modes were in schema v1. Everything in 7a
holds; this adds two drills and a mode picker.

- **Modes.** The Practice tab picks **Flashcards** (both ways or one, as
  in 7a), **Listening**, **Speak it** or **Mixed**. Each queue item names
  its **drill**, which is the review's `mode`: `flashcard` (recognize or
  produce, typed), `listening` (the `listen` card) or `speak` (the
  `produce` card, said aloud). Mixed asks recognize as a flashcard, listen
  by ear and produce aloud (`drillsFor`). `GET /api/practice` and
  `/queue` take `mode=flashcards|listening|speak|mixed` (default
  flashcards, so an older page is unchanged) beside `direction`.
- **Queue rules extended.** Still at most one card per phrase per
  session, the most overdue of the mode's skills when several are due, so
  a phrase with three cards due is one item and counts once in the
  stats' `due`. New cards follow `drillsFor`'s order (recognize, listen,
  produce); when a mode has recognize and something else (flashcards both
  ways, mixed), the phrase's other cards are new only once its recognize
  card has been reviewed (read before you hear or say it). A one-skill
  mode (listening, speak it, one direction) drops that rule. The daily
  limits count every practice review (all modes but `session`), so a mode
  switch never resets them.
- **Listening.** A listening item carries no `text` and no `meaning`
  (both ""): the words come only in the answer's reply, so they are not on
  the page (or in its network log) before the answer, and Mandarin
  readings show only with the result. It carries `choices`: the meaning
  and three others from the same bank (`listenChoices`: practisable
  phrases whose meaning is not too like the right one or another choice:
  no comparable form in common, as `localMatch` compares meanings, neither
  inside the other ("bye" / "goodbye"), not within two edits, no content
  word in common ("thanks" / "thank you"; English stopwords don't count));
  `null` when the bank has fewer than three such meanings, and the page
  asks for a typed answer. The draw is **deterministic**
  (`offeredChoices`): seeded by the phrase id, the card's version and the
  phrase's revision, over the bank in id order, so the same card shows the
  same choices until it is answered or edited. A **choice** (`{choice}`)
  is checked against that draw, made again on the server: a choice on a
  card that offered none is a 400; one that isn't among them (nor, if the
  bank has grown since, any phrase's meaning in it) is a 409; neither is
  recorded. A choice is right only as an exact meaning match
  (`choiceMatch`): Good, or Again, with no model call and no near miss. A **typed** answer (`{answer}`) is checked as the words heard
  (a dictation, against the words and alternates) and as the meaning
  (`listenMatch`), and the better verdict wins: exact on either beats
  close on the other ("university" for French "université" is the right
  meaning, not a typo of the words); of two close ones the nearer (an
  accent before a letter; the words on a tie), its note saying which
  reading it was taken as. A miss on both goes once to the grader with the heard-phrase wording
  (`graderPrompt({heard: true})`: "they were not shown it", any spelling
  or romanization of the words counts). Replay is the page's own copy of
  the audio (no second request).
- **Speak-it.** The meaning is shown; the page records (the Go tab's
  `recorder.ts`, stop on a pause or by hand) and sends the WAV to
  `POST /api/practice/transcribe`, which answers `{text}` and records
  nothing. It transcribes in the language's locale with the user's
  speech-to-text provider and **no keyterms** (nothing about the card
  reaches the recogniser). The page shows what was heard; Check sends it
  as the answer (`drill: speak`), Record again throws it away. So a
  blocked or missing microphone, an empty recording, nothing heard
  (`text: ""`), a provider failure (502) or a mishearing never becomes a
  review, and the server refuses an empty `speak` answer (400). The match
  is `spoken` (§Grading: a heard accent difference is close, a same-sound
  one exact); a miss goes
  to the grader told it is a transcript. An accepted transcript is **not**
  kept as an alternate (its spelling is the recogniser's). "Type it
  instead" (or "I don't know") answers the same produce card as a typed
  flashcard (`drill: flashcard`).
- **Stale answers.** Unchanged for the new drills: every answer names the
  card's version, the phrase's revision and a submit id; a resend replays
  (a review of that card, in any practice mode, with that submit id), any
  other stale answer is a 409; the lock order is the phrase, then the
  card. Overrides take any practice review (`flashcard`, `listening`,
  `speak`).
- **Phrase audio.** `GET /api/practice/audio/:phraseId` (learner: true,
  kids 403) says a practisable phrase of the active language in the
  user's TTS provider and voice for the language's locale (the narrator's
  slot first, as `voiceFor` borrows; macOS voices with none set take the
  locale's first voice; a paid provider with none set is a 400 that says
  where to pick one). Another language's or account's phrase id is a 404
  like any unknown id. The audio goes through `scripts/audio-cache.mjs`:
  - **Key:** sha256 over the user, provider, voice, model (ElevenLabs),
    output format (`SPEECH_FORMATS` in `scripts/voice.mjs`, the one its
    requests use), locale, speed (1: there is no speed setting yet) and
    text. Any change is a new file; editing a phrase's words is new audio.
  - **Where:** `LINGO_AUDIO_DIR`, else `<LINGO_DATA_DIR or data/>/audio`
    (gitignored), files `<key>.mp3` (ElevenLabs, Azure) or `<key>.wav`
    (macOS `say`), mode 0600 in a 0700 directory. A file name is only ever
    a computed key; nothing from the client becomes a path.
  - **Writes** go to a temp file in the same directory, then rename.
    Concurrent misses for one key share one synthesis in the process (a
    waiter whose first request was cancelled makes its own; any other
    failure is every waiter's answer, not a retry each).
  - **Bound:** `LINGO_AUDIO_CACHE_MB` (default 256). After a write that
    takes it over, the least recently used files go (a hit touches the
    mtime) until it is under 90%; the cache's own temp files
    (`.<key>.<pid>.<random>.tmp`) over an hour old go too, and nothing else.
  - **Isolation:** files are per user (the user id is in the key), and
    the route only takes a phrase id the active language owns: nothing in
    a reply, or its timing, tells one account what another has had said.
    Two learners of one login share files, as they share its voices.
  - The reply is `Cache-Control: private, no-store`. Hit or miss is logged
    on the server, never sent.
  - **Paid calls** (an audio miss, a transcription) run at most two at
    once per user; a third is a 429. The bound is shared with the Go tab's
    speech, transcription and voice draws, the character card's sounds and
    pronunciation scoring (bead ld-e6q; docs/VOICE.md §Paid calls at once).
  - **No voice picked:** the provider's default voice (docs/VOICE.md
    §Default voice: a native speaker of the locale's language and region
    first on every provider, a premade ElevenLabs voice only with none); with no macOS voice installed for the locale, a 400
    (rather than `say` reading the words in the Mac's own language, and
    caching that).
  - **Before a session**, `GET /api/practice` answers `setup: { audio,
    speech }`: why phrases can't be played (no key, no macOS voice for the
    locale, no locale; never "no voice picked", and no provider call) or
    answers can't be transcribed (no key), or null each. The
    mode picker says so, and won't start listening or speak-it alone
    that can't run. A listening card whose audio fails anyway shows why
    and where to fix it, with only Skip (nothing recorded); its choices
    wait for the audio.
- **Transcribe input.** Only the recorder's WAV (`audio/wav`,
  `audio/wave`, `audio/x-wav`; anything else is a 415 before any provider
  call), at most 8 MiB (413).
- **Tests.** `practice-drills.test.mjs` (the pure rules: modes and
  drills, one card per phrase, hidden words, choices, the answer body,
  listen and choice matching, the grader's wording), `audio-cache.test.mjs`
  (the key, the directory, atomic writes, eviction, one synthesis),
  `practice-drills.http.test.mjs` (ElevenLabs stubbed in fetch, the cache
  in a temp dir: audio once then a hit, another voice or an edit is a new
  file, another account's or language's id is a 404, choices and typed
  listening answers, replays, 409s and overrides, transcription with no
  keyterms, a spoken answer recorded as `speak`, failures that record
  nothing, mixed, kids) and a `practice.pg.test.mjs` race (a listening
  submit on six connections; three drills answering one phrase's three
  cards at once).

### As built (phase 7c: cloze)

Bead `ld-7dr`, migration `0006_cloze`. Everything in 7a and 7b holds;
this adds **Fill the gap** to the mode picker and to Mixed.

- **The drill.** A sentence with the phrase's words left out, the gap a
  fixed-width line that gives no length away, and the phrase's meaning as
  the hint. The learner types the missing words, says them ("Say it": the
  speak-it recorder and rules, a transcript held until Check, disabled
  without a speech-to-text key), or picks "I don't know" (an empty answer:
  Again). It reviews the `produce` card; the review's `mode` is `cloze`,
  and its `card_before` names the sentence (`cloze_id`). Matched locally
  against the phrase's own words only (exact or close, the usual
  leniency); anything else, a saved alternate included, goes to the
  grader, since an alternate is another way to say the phrase, not always
  a word that fits this sentence (`Wagen` for `Auto` in "Das ___ steht vor
  meinem Haus"). The grader sees the sentence with a neutral `___`, the
  whole sentence as written with the expected answer, and the meaning
  ("Meaning given for the gap"), so it can accept another fit. A cloze
  answer never saves an alternate (a word that fits one sentence isn't
  another way to say the phrase). The result shows the whole
  sentence with the words filled in, readings on all of it for Chinese
  (before the answer, readings only on the context: the gap has none).
- **Where sentences come from.** First the learner's own session lines
  (`phrase_examples`), made into items when the queue is read: only a line
  of the dojo master's reply (`role = master`, not a browser copy), from
  one stretch of target-language segments (two target parts with native
  words between them aren't one sentence), within a length cap. The rest
  are generated: a tool-less `claude -p` call (Sonnet, 120 s) writes two
  sentences each for a batch of up to 10 phrases, at the language's CEFR
  level (the profile's `level`; B1 if it names none), with length caps
  per level.
- **What pays, and when.** Only **starting a session** (the queue route,
  in the cloze, mixed or flashcards mode) writes sentences, and only for
  the phrases that session would show in one (`practice.mjs`
  `clozeWanted`: a gap, or a flashcard's answer side, below). The
  invariant: a started session never asks for more phrases than it has
  unfilled places, nor past today's limits. In the cloze mode that is at
  most its length less every card already in it (due and new alike), due
  first, with due phrases up to the reviews left and new ones up to the
  new cards left, after what the session itself takes. In Mixed it is
  only the session's own produce cards asked aloud for want of a
  sentence; they already hold places in it. In Flashcards it is only the
  session's own cards with no sentence to show, likewise. `cloze.test.mjs`
  checks this over a grid of the three modes, lengths, ready and waiting
  new and due counts, and limits. So a session of N cards makes at most ⌈N/10⌉ calls, one after
  another. The counts the tab shows
  (`GET /api/practice`) never start a call, and neither does the page's
  poll while sentences are written (every 4 s, counts only). The calls run
  **in the background** after the queue answers; the queue shows what
  exists. On top: at most **6 calls per language profile in any 24
  hours** (`CLOZE_DAILY_CALLS`), counted from a ledger, `cloze_calls`: a
  row is written as each call starts (in the background slot, before the
  model is asked), whatever the call then gives, so a failed call counts
  too, and a restart doesn't reset it. The ledger is apart from
  `cloze_items` on purpose: those are a cache that a phrase's edit or
  delete and an expiring or refreshed mark clear, and a paid call must
  not drop out of the count with them (an edit between one-card sessions
  would otherwise buy a call each time). Its rows go only with the
  language profile, and a call prunes the profile's rows older than the
  24 hours. The tab says when today's are used up. One run at a time per language profile, in the
  user's single **background** paid slot (`web/server/paid.ts`
  `backgroundSlot`), apart from the two interactive slots audio and
  transcription use, so writing never makes a card's audio or a speak-it
  answer wait or fail; a busy background slot skips the run. A failed call
  (the CLI, a limit, a timeout) stops the run and waits ten minutes (in
  memory) before the next try. A failure only means no cloze for now.
- **Languages not written for.** Korean, Turkish, Finnish, Hungarian and
  Estonian (`cloze.mjs` `UNWRITTEN`): their words take endings (커피를), so
  a bank phrase as saved rarely stands as a whole word in a sentence and a
  paid call would keep almost nothing. No call is made; the tab says so;
  the learner's own session lines are still used when one holds the
  phrase verbatim. Inflected gaps are bead `ld-cn8`.
- **Checks on every sentence** (`scripts/cloze.mjs`, pure), from a session
  or a model alike: the phrase's words appear **verbatim, exactly once**
  (case-insensitive, any run of spaces, curly or straight apostrophes;
  whole words in spaced languages, by lookarounds on code points so a
  letter outside the BMP is a letter; never inside another word); the
  sentence is in the language's own script (a table by language code;
  any other language, the scripts its phrase uses), judged by
  Script_Extensions so a letter scripts share counts for each of them
  (the prolonged sound mark ー in コーヒー, the iteration mark 々, the
  Arabic tatweel), with fullwidth Latin allowed in Chinese, Japanese and
  Korean text; has context on both sides or at least a few words beside
  the gap, fits the level's length, is one line with control and bidi
  characters cleaned out. For Chinese and Japanese the gap is a run of
  characters, and a sentence where any of its Han characters appears again
  outside the gap is refused (it would give the answer away). A model's
  sentence is also refused when it holds the phrase's meaning as written,
  or, for an English speaker learning another language, when most of its
  words outside the gap are common English words (`wrongLanguage`; real
  language identification is bead `ld-d3j`). The model's reply is read
  strictly as the JSON asked for; a sentence that fails is dropped and
  counted in the log.
- **Inflected forms are not accepted.** A sentence must hold the phrase
  exactly as saved: a conjugated verb or a plural is skipped, not blanked,
  so the expected answer is always the bank's own text. The prompt asks
  the model for the exact form; what it inflects anyway is dropped.
- **Hint level.** The meaning only: no first letter, no length, no word
  count. The fixed-width gap is deliberate.
- **Caching and staleness.** Items are keyed by `phrase_key`, a hash of the
  phrase's text and meaning (`clozeKey`), not `phraseRevision`: a new
  accepted alternate must not make sentences pay again. Rows with another
  key are deleted when the queue reads the phrase (its words or meaning
  changed), and the phrase is asked for again; the delete only runs while
  the phrase still has the words and meaning the request read (it joins
  `phrases`), so a load holding a copy from before an edit can't delete
  the new key's rows, a flag among them. A call that gave a phrase
  nothing usable (or a reply that wasn't the JSON asked for, which was
  paid all the same) leaves one row with no sentence (one per phrase and
  key: `cloze_items_tried_once`, refreshed by a later try), so the same
  words and meaning don't pay again; the mark lapses after 30 days, or
  when the sentence rules change (`CLOZE_RULES_SINCE`: a mark made before
  it no longer counts), so a fixed rule gives old phrases a card. A
  sentence a learner flags is kept
  with `flagged_at` (so it is never written again) and never shown; a
  phrase whose only sentences are flagged gets one generation call if it
  never had one. Deleting a phrase takes its items (cascade); deleting an
  example takes the item made from it (the `(example_id, phrase_id)` key,
  which also keeps an item from pointing at another phrase's line).
- **Picking.** One item per card: the learner's own lines first, then
  generated ones, chosen by a seed of phrase and card version, so the same
  card shows the same sentence (a reload, another tab) and the next review
  often another. A queue item carries the sentence split as
  `cloze: {id, before, after, origin}`; the gap's words and the phrase's
  `text` are not on the wire before the answer (`text` is empty).
- **Answers.** `POST /api/practice/answer` with `drill: "cloze"` needs
  `clozeId`; `spoken: true` marks a transcript (never empty). The item is
  re-read under the card's lock before any grading: another phrase's,
  unknown, flagged, or no longer this phrase's words and meaning is a 409
  with nothing recorded and no model call. Replays and overrides answer
  with the sentence too (`cloze: {before, blank, after}`).
- **Flagging.** `POST /api/practice/cloze/:id/flag` (`learner: true`,
  adults only like every Practice route) → `{flagged: true}`; another
  learner's or language's id is a 404. Before answering, the card is then
  skipped with nothing recorded; after, the grade stands.
- **Mixed.** Read before it is heard or produced, as in 7b; the produce
  card is a gap every other time (its reps even) when the phrase has a
  usable sentence, said aloud otherwise. A phrase asked aloud for want of
  a sentence gets sentences written for next time. The cloze mode alone asks only
  phrases with a sentence and lists the rest as waiting, due first.
- **Flashcards: the phrase in a sentence** (bead `ld-dsh`, added later;
  no migration). A flashcard's answer side (Reveal on a recognize card,
  or the grade on either) shows the phrase used in a sentence under its
  meaning, from the same `cloze_items`, picked by `pickSentence`: when
  the phrase has more than one usable sentence, the flashcard doesn't show
  the one a gap card would use at the produce card's version as it is
  when the queue is built (`pickCloze` at that version, whichever skill
  the flashcard is), so a gap asked before the produce card is next
  reviewed isn't the sentence just read. After that review (in Mixed, a
  produce card with odd reps is said aloud first; in Flashcards, answering
  a produce flashcard is that review) the gap picks afresh and may repeat
  it, about one time in as many sentences as the phrase has.
  Among the others, the learner's own line first, by a salted seed of
  phrase and the flashcard's card version, so the card shows one sentence
  until it is answered; with one sentence, that one. Shown whole, the
  phrase's words marked, readings as the Readings switch says (taken over
  the whole sentence once, `script.ts` `readMarked`, so a character
  beside the phrase keeps its word: 了 in 天黑了 is le; the filled gap
  after a cloze answer is read the same way), "from one of your
  sessions" for a session line, and "Bad sentence?" to flag it (the same
  route; it is then gone from the card and from every later card and gap).
  The queue item carries it as `sentence: {id, before, blank, after,
  origin}` (`cloze.mjs` `sentenceView`), only on a `flashcard` drill (in
  Mixed too, where sentences are read anyway), never on a listening,
  speak-it or cloze item. A flashcard already carries both sides, so the
  sentence holds nothing the item doesn't; the page just never renders it
  before the answer side (on a produce card it holds the words asked
  for). Only a started flashcards session reads the sentences (the counts
  don't need them and don't touch `cloze_items`), and it asks generation
  for its own cards with none that are worth a call (`clozeNeeded`),
  under the same ledger and daily cap; a card without a sentence is asked
  all the same and shows none (no placeholder, no waiting), and the
  sentence appears in a later session once written. Hidden for kids, like
  the tab.
- **The sentence's translation** (bead `ld-r2x`, migration
  `0010_cloze_translation`: a nullable `cloze_items.translation`, and a
  check that only a row with a sentence has one). Shown quietly under the
  flashcard's sentence, smaller and fainter, so only on the answer side
  like the sentence itself; nothing when there is none. Where it comes
  from:
  - a **generated** sentence: the same call writes it. The prompt asks
    for `{"sentence", "translation"}` per sentence, the translation a
    natural one of the whole sentence into the learner's native language,
    on one line; no extra call, so the ledger and the daily cap
    (`CLOZE_DAILY_CALLS`) are as before. `cloze.mjs` `checkTranslation`
    (pure) cleans it like a sentence (one line, control and bidi
    characters gone) and drops it (null) when it isn't a string, has no
    letter, runs past `MAX_TRANSLATION` (300 characters), or is the
    sentence itself; a dropped translation leaves the sentence kept
    without one. A bare string where an object was asked for is still
    read as a sentence with no translation.
  - a **session line**: the turn's own gloss of that line when it has one
    (`glossTranslation`: the dojo master glosses each whole target
    sentence with a natural translation, so a gloss of `turns.glosses`
    whose term is the line, any case and its outer punctuation aside, is
    its meaning), through the same `checkTranslation`; a line glossed
    only word by word has none. It is read when the item is made from the
    example (`checkExample`).
  Rows from before 0010 stay null: no backfill and no call to fill them
  (a generated sentence is never asked for again; an example's item is
  made once). The queue item carries it as `sentence.translation`
  (`sentenceView`; `null` for none). A gap card's `cloze` never does: it
  would give the gap away. The bank reader role is still granted nothing
  on `cloze_items`.
- **Reader role.** `cloze_items` and `cloze_calls` have no grant to the
  content agent's read-only role and no policy: the agent's bank tools
  don't read them (0005 cleared the default privileges that could have
  granted a new table).
  `bankReaderProblem()` is unchanged and passes after 0006.
- **Migration 0006.** Drizzle's output plus one hand edit
  (`scripts/db/hand-edits.mjs`): `DELETE FROM "cloze_items"` first (the
  table existed since 0000 and nothing wrote it; a row would have no
  phrase key), then the statements ordered so a unique key comes before
  the foreign key that needs it. It creates `cloze_calls` (the ledger;
  checked counts, indexed by language profile and `created_at` for the
  daily cap). Runs on PostgreSQL 17 and PGlite.
- **The page.** The gap sentence is `dir="auto"` (a gap at the start of a
  Hebrew or Arabic sentence sits on the right), and the gap has no margin
  of its own, so trailing punctuation follows it directly.
- **Limits, known.** The script check can't tell two languages that share
  a script apart beyond the English check above (a Portuguese sentence
  passes as Spanish); the prompt and the flag are the defence (`ld-d3j`).
  A spoken cloze answer was tested over HTTP, not in a browser with a real
  microphone (`ld-e2d`).
- **Tests.** `cloze.test.mjs` (the pure rules: the blank, scripts, Han
  repeats, session lines, the key, the prompt and reply, picking, the
  queue in cloze, mixed and flashcards (a flashcard's sentence), the
  answer body, the grader's wording),
  `cloze.http.test.mjs` (the real plugin with a stand-in `claude`: items
  from session lines, background generation once, failures, tombstones,
  answers, 409s, flagging, a spoken answer, mixed, Mandarin, deletes,
  kids; the counts never paying, ⌈N/10⌉ calls per session, the daily cap
  across a restart, the cap holding through an edit loop, a phrase's
  delete, expired marks and failed calls, a mark's expiry, an alternate
  sent to the grader,
  Japanese ー, no Korean calls, the separate background slot; a
  flashcard's sentence, its session-only generation, the counts reading
  nothing, a flagged sentence no longer attached),
  `cloze.pg.test.mjs` (stale and fresh loads racing an edit on PostgreSQL
  17: the new key's flagged row survives), `db-migration-0006.test.mjs` and `migration-0006.pg.test.mjs`
  (0005 with data → 0006: rows kept but the cloze one, schema as a fresh
  build, the reader kept out of both tables, the ledger's checks, kept
  when phrases go and gone with the profile), and the 0006 hand-edit pin in
  `db-migrations.test.mjs`.

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
- **Timing source:** elapsed time since the first turn, sent by the client.
  As built (phase 3), it stays the client's even with conversations stored,
  and the conversation records `planned_minutes` as of each turn. The
  clock's origin moves with every mid-session pick and the budget with +5
  min, both state the browser alone sees, so a server clock would need the
  pick time from the browser anyway (no more trustworthy than the elapsed
  time it sends), plus a column for it; and a reload, which a server clock
  could outlive, also loses the session itself, since the history isn't read
  back yet. Revisit when it is.
- **UI:** the timeline shows the time left, and a **+5 min** button extends the
  budget mid-session.

## Hosting on Tailscale

The app is served from this Mac to the tailnet: `tailscale serve` proxies
`https://<mac>.<tailnet>.ts.net:38400` to `http://localhost:38400` (its own
port since 2026-11-24, so the sibling apps can share the name on theirs; it
was the bare name on 443 before, which works the same). That gives other
devices the HTTPS the microphone needs, and only tailnet devices can reach it.
Setup steps for the owner are in the README ("Serving on your tailnet").

Built (bead 10):

- The server keeps listening on localhost only (`server.host` is untouched).
  Tailscale is the one way in, and Postgres stays on localhost.
- The serve target is `tailscale serve --bg --https=38400 http://localhost:38400`,
  with the name and scheme. Vite's default host `localhost` resolves to `::1`
  first on this machine, so the server listens on `[::1]:38400` only and
  `127.0.0.1:38400` does not answer. A bare port (`tailscale serve 38400`)
  becomes `http://127.0.0.1:38400` and would give a 502
  (tailscale/tailscale#12201); a `localhost` target is kept as a name and Go
  dials both address families. The curl checks in this work used `localhost`,
  where curl falls back across families; `127.0.0.1` is not a valid probe.
- First-run is local only. `/api/auth/first-run` has no login in front of it
  and the first account is the admin, so on a fresh install served before any
  account exists any tailnet device could claim it. `isDirectLocalRequest`
  (`scripts/auth.mjs`) allows it only when the socket peer is loopback, the
  request carries no `X-Forwarded-For`/`-Host`/`-Proto`, and `Host` is
  `localhost`, `127.0.0.1` or `[::1]`; otherwise 403 with a message to use the
  Mac itself. `/api/auth/me` still says `firstRun: true` and adds
  `firstRunHere`, so the page shows that message instead of the form.
- Vite refuses hostnames it doesn't know, so the tailnet name goes in
  `server.allowedHosts`, read from `LINGO_PUBLIC_HOST` in the shell or the
  repo-root `.env.local` (`scripts/public-host.mjs`, tested in
  `scripts/tests/tailscale.test.mjs`). Comma-separated, trimmed, lowercased;
  entries that aren't plain hostnames (scheme, port, path, wildcard, spaces)
  are dropped with a startup warning. Unset: only localhost, as before.
- HMR needs no `server.hmr`/`server.ws` options: the Vite client opens its
  websocket on the page's own host and port (wss on an https page), and
  Tailscale Serve proxies websocket upgrades.
- What `tailscale serve` sends the backend. This was taken from Tailscale's
  source (`ipn/ipnlocal/serve.go`), not from its docs: the KB pages don't
  document these headers, so a future Tailscale release could change them:
  `Host` is the public name as the client sent it, `X-Forwarded-Host` the same,
  `X-Forwarded-Proto: https` for TLS requests, `X-Forwarded-For` set to the
  peer's tailnet address (set, not appended to a client-sent value), and `Origin` passes
  through. So the same-origin check (`Origin` host equals `Host`, port
  included on both sides) passes for the tailnet name on any serve port
  (`LINGO_PUBLIC_HOST` stays a bare hostname: Vite's host check ignores the port), the cookie gets `Secure` from `X-Forwarded-Proto`, and the
  login throttle keys on the forwarded address. Tests pin all three.
- The `Secure` cookie rule (Auth) and the per-conversation turn lock
  (Conversations).

Deployment notes:

- The `ld_session` cookie is not port-scoped (cookies never are), so it is
  also sent to any other app served on the same hostname, on any port or
  path (the sibling apps on 38100–38300, if they are served under the same
  `<mac>.<tailnet>.ts.net`). Those apps could read it from their requests.
  Accepted on this install (2026-11-24): the others served there are the
  owner's own apps, each on its own port. Serve nothing there that shouldn't
  see the cookie.
- Known limits, left as they are: a `Host` with a trailing dot (`localhost.`)
  is not treated as local (first-run refuses it, which fails closed), and the
  login throttle trusts `X-Forwarded-For` from any loopback peer, so another
  local process could pick its own throttle key.
- Do not use Funnel. The Mac has to stay awake with the dev server running.

Not yet verified (only the owner can, from a second device on the tailnet):

- Logging in over the HTTPS name and staying logged in (the Secure cookie
  round trip in a real browser).
- A voice turn with the microphone over the HTTPS name.
- HMR over the proxy (the page live-updates after an edit).
- That the real `Host`, `Origin` and forwarded headers match the above; the
  tests and the curl check use the documented shape, not a live proxy.

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
first admin, and since phase 2 step 3 too: a fresh install's first admin
starts with the seed packs. As built, `npm run db:import` is step 3 and 5
only (see below); the plan it replaced follows.

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

As built (phase 2; `scripts/import.mjs`, `scripts/db/import.ts`,
`importPacks` in `scripts/db/packs.ts`):

```
npm run db:import                    # into the first admin's learners
npm run db:import -- --user <name>   # into that account's learners
```

- It creates nothing: no account (steps 1, 2 and 4 are the first run's; with
  no admin it stops and says to use the first-run screen or `npm run user --
  add <name> --admin`) and no learner. The account is `--user`, else the
  oldest admin that isn't disabled. The learner is that account's first
  non-archived learner of each mode (the picker's order); a mode with none is
  skipped, and the output says so. The packs go to that learner's oldest
  live language (for a learner from before 0002, the profile the migration
  made), named in the output; which language the learner used last doesn't
  matter.
- `content/packs/**` goes to the adult learner and `content/kids/packs/**` to
  the kids learner, keeping folder, slug, title and created; every folder
  under `packs/` (an empty one with its `.keep` too) becomes a folder row.
  Each imported pack gets an `import` revision. A file that doesn't load, an
  id that isn't a valid pack id, or a pack with no title or with a NUL
  character is skipped and listed (`invalid`). Each pack is its own savepoint:
  one the database refuses for any other reason is rolled back alone, logged,
  and listed (`failed`), and the rest import. That keeps a bad seed file from
  failing the first run, which imports in the admin's transaction.
- Re-runs: a pack is skipped when the language profile has any row at that
  folder and slug, a soft-deleted one included, or when any of the
  learner's languages has an `import` revision whose snapshot has that id,
  so a pack renamed, moved or deleted in the app since, or imported into a
  language that is no longer the oldest, is not imported again. A folder
  deleted in the app does come back (folders have no deleted state; it
  comes back empty). One transaction per language profile.
- `--user` naming a disabled account is an error (enable it first, or name
  another): its packs would land where nobody can log in to see them.
- It reads `DATABASE_URL` like the other CLIs, and the pack files from
  `content/` (`LINGO_CONTENT_DIR` moves it). It prints one line per mode and
  one per pack:

```
database: postgres://localhost/lingo_dojo
packs → robin (admin)
adult (content/packs/) → Sam (Spanish · A2): 1 imported, 1 already there, 1 folder added
  + oaxaca/2026-10-20-mezcal
  = 2026-10-19-market-gentle (already there)
  + folder oaxaca
kids (content/kids/packs/): skipped, robin has no kids learner (add one in the app, then re-run)
```

The first run (`createFirstAdmin`) runs the same `importPacks` for each
learner it makes, into that learner's one language, in its transaction.

## Backups

Personal data leaves git, so it needs its own safety net. `npm run db:backup`
(`scripts/db/backup-cli.mjs`; the logic, including the dump, rename and prune
run, is in `scripts/db/backup.mjs`) runs `pg_dump -Fc` on the database
`DATABASE_URL` names (resolved like the other db scripts, so a worktree
without one refuses) into `backups/` (gitignored). Files are
`<database>-<UTC stamp>.dump`, mode 0600 (they hold password hashes and
conversations). A `backups/` the script creates is 0700; a directory you point
`LINGO_BACKUPS_DIR` at is left as it is.

- **Safe writes:** the dump goes to a private `.<name>.<pid>.partial` file,
  created exclusively, and is linked to its final name only when `pg_dump`
  exits 0, so a failed dump never looks like a good one, and two runs in the
  same second cannot overwrite each other (the second fails). Partials of that
  database older than a day (crashed runs) are deleted at startup.
- **Retention:** the newest 14 are kept; pruning touches only that database's
  own `<db>-<stamp>.dump` files and never the file just written. A backup with
  a future timestamp (the clock was ahead) produces a warning.
- **The password** never appears in `pg_dump`'s arguments: it is taken out of
  the URL (userinfo or `?password=`) and passed as `PGPASSWORD`, with `-w`.
  The URL printed to the log is redacted the same way.
- **Which `pg_dump`:** found on `PATH`, then in the Homebrew PostgreSQL
  directories (`postgresql@17/bin` and a few others; a launchd job has a
  minimal `PATH`). Of those it uses the one whose major version equals the
  server's, else the lowest newer one, never an older one. It prints the tool
  and version it chose. A missing or failing `pg_dump` exits non-zero with a
  message.
- **Tests** (`backup.test.mjs`, `backup-run.test.mjs`) use a temp directory
  and fake `pg_dump` scripts, never the real `backups/`.

`pack_revisions` and soft deletes cover undoing a single change; the dump
covers losing the database.

There is deliberately no restore script: a restore that picks its own target
is how a real database gets overwritten. Restore by hand, into a database you
name:

```sh
createdb lingo_dojo_restored
pg_restore --no-owner --exit-on-error -d lingo_dojo_restored backups/<file>.dump
# check it, then point DATABASE_URL at it (or rename databases) when you mean to
```

**The read-only role and a restore** (migration 0005). A dump holds the
database's side of the content agent's reader: RLS on the five tables, the
`bank_reader_scope` policies and the reader's column grants. `--no-owner`
drops ownership, not grants, so all of it is restored (checked on
PostgreSQL 17: the five policies, RLS and the 58 column grants came back).
The role itself and the app role's membership in it are cluster-wide, not
in any dump, and the restored database's migrations are recorded as
applied, so `db:setup` won't make them again:

- **Same server** (the usual case): `lingo_reader` and the membership are
  already there; nothing to do. If you restore as a different role than
  the app uses, that role owns the tables; give it the membership too
  (below).
- **A new server, or one where `lingo_reader` was dropped**: the restore
  fails at the first policy (`role "lingo_reader" does not exist`, and
  `--exit-on-error` stops there). By then the tables, their data and the
  recorded migrations are in, but none of the policies and grants after
  that point, so the migration state alone calls the database current.
  `db:setup` notices (it checks 0005's policies, RLS and grants, and fails
  naming what is missing) and the dev server warns at boot. Don't patch
  that database: drop it, make the role first, as a superuser, then
  restore into a fresh one:

  ```sh
  psql -c "CREATE ROLE lingo_reader NOLOGIN" postgres
  psql -c "GRANT lingo_reader TO <app role> WITH INHERIT FALSE, SET TRUE" postgres
  ```

  (`<app role>` is the role in `DATABASE_URL`, on Homebrew your user name.
  `dropdb lingo_dojo_restored && createdb lingo_dojo_restored` first if a
  restore already stopped part-way.)
  Without the GRANT the database restores and the app runs, but the
  agent's bank tools answer "could not be read" (the server log says
  `permission denied to set role`).

### Daily job (optional, not installed by default)

`macos/com.lingodojo.db-backup.plist.template` runs the backup at 03:30 daily
with the logs in `~/Library/Logs/LingoDojoBackup.log`. `npm run
db:backup:plist -- <path>` fills in the placeholders (node, this checkout,
your home; XML-escaped) and writes the result to the path you give. It writes
nothing else and does not call `launchctl`; loading the job is your step:

```sh
npm run db:backup:plist -- ~/Library/LaunchAgents/com.lingodojo.db-backup.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.lingodojo.db-backup.plist
launchctl kickstart "gui/$(id -u)/com.lingodojo.db-backup"   # run once now
```

Uninstall:

```sh
launchctl bootout "gui/$(id -u)/com.lingodojo.db-backup"
rm ~/Library/LaunchAgents/com.lingodojo.db-backup.plist
```

If the repo is under a TCC-protected folder (Documents, Desktop), launchd's
`node` may be denied access to it; the log will say so. Grant it Full Disk
Access in System Settings, or keep the checkout elsewhere.

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
  on the same browser, and overlapping voice-settings saves. PGlite runs one
  transaction at a time, so the races themselves are in
  `first-run.pg.test.mjs`, which runs only with `LINGO_TEST_PG_URL` set: it
  makes a throwaway database on that server, races 12 first runs and 12
  voice-settings saves five times each, and drops it (each fails with its
  lock removed). Phase 2: `packs.http.test.mjs` covers the pack, folder and
  revision routes (CRUD, move, rename, the folder rules, soft delete,
  undelete and restore and their 409s, paging, NUL rejection, a revision per
  write, id collisions, `stale_learner`, and a
  second learner of the same account and a second account that can't see or
  change the first's packs, even by id); `packs.test.mjs` the import (both
  modes, a re-run, a re-run after rename/move/delete, a missing learner, a
  soft-deleted pack, `--user` including a disabled one, NUL and
  database-refused packs during a first run) and the first run's seed packs;
  `packs.pg.test.mjs` (with `LINGO_TEST_PG_URL`) races creates of one id, a
  move against a delete, renames to one title, a folder delete against a
  save into it, two undeletes, and an undelete against a restore.
  `conversations.http.test.mjs` (phase 3, with a stand-in `claude` on PATH)
  covers creation and the saved languages, the stored turn shapes, idx
  under stopped and dropped turns, histories that don't cover the store
  (`history: []`, a forged one), `from_client`, a `|` in a line, the
  2000-entry cap, the per-conversation lock, End (idempotent, waiting for a
  turn, End and a turn at once, one hook call), the two-hour idle end (and
  its skipping a running turn), paging (huge offsets too), delete,
  `stale_learner`, and another learner or user against every route by id;
  `conversations.test.mjs` the pure reconciliation;
  `conversations.pg.test.mjs` (with `LINGO_TEST_PG_URL`) sends End and a
  turn at once on 60 fresh conversations (it fails on the code before the
  phase 3 review's lock fix). `languages.pg.test.mjs` (with
  `LINGO_TEST_PG_URL`) races the naming of a blank profile against an add
  of that language, two namings of one language, and both against an
  archive: one wins, the other is refused, no deadlock (it fails on the
  code before the learner lock in `updateLanguageProfile`); and a session
  switch against an archive, both of the destination language and of the
  language being left, which deadlocked (40P01) before `setSessionLearner`
  took the learner lock. Language
  profiles: `auth.http.test.mjs` covers the lock order and
  language CRUD, picking, the last-used landing, the keep-one rule, and
  another learner's or account's language on every route;
  `packs.http.test.mjs` and `conversations.http.test.mjs` one learner's two
  languages against each other on every pack, folder, revision, conversation
  and voice-turn route, and the `stale_learner` 409 for a tab on the other
  language, and the idle end across languages and learners; the
  identity rule (no rename through either route, no second profile for a
  language) and the all-or-nothing profile save (a trigger archives the
  language inside the transaction); `packs.test.mjs` the import into the
  oldest language and its per-learner idempotence; `draft.test.mjs` the
  browser-key adoption; `db.test.mjs` the scopes and keys; and the
  migration tests above every existing row. Phase 4: `phrases.test.mjs`
  covers the pure rules (capture lists, the limits with and without spaces,
  whole-word examples, control characters, the language match, scenario
  entries, input checks, metrics with new and due, the list page);
  `phrases.http.test.mjs` the scenario lists at a conversation's start, a
  turn's capture (counts, example, card, no review), pending absorption, a
  dropped reply's sightings undone, a deleted scene phrase not coming back,
  a session in another language, a failing capture that keeps the turn,
  add/star/lookup (a NUL too)/edit/suspend/delete, two languages' separate
  banks and the `stale_learner` 409, another learner and account by id, and
  the metrics and filters; `db-migration-0003.test.mjs` (PGlite) and
  `migration-0003.pg.test.mjs` (with `LINGO_TEST_PG_URL`, PostgreSQL 17)
  migrate a 0002 database with data and an empty bank, and refuse one with
  a bank row; `phrases.pg.test.mjs` (with `LINGO_TEST_PG_URL`) races
  captures of one phrase with an add and crossing pending meanings (both
  fail on the code before the lock order); `db.test.mjs` the profile scope
  on the bank tables and the language-level provenance keys. Phase 5:
  `extraction.test.mjs` the pure half (the prompt with kids, control
  characters, the transcript and its cap, the plan, examples);
  `extraction.http.test.mjs` (a stand-in `claude` that answers recap
  calls from their own file, `fake-claude.mjs`) End making the recap and
  what it writes, two Ends and a Retry making one run, the retry and
  "failed" then Retry recap, an idempotent re-run and a different one
  replacing the last, a card practised since, untrusted output (control
  characters, sentences, ids, a learner's meaning, a suspension), the
  pending merge and a dismissed phrase (by text, and a deleted scene
  phrase by meaning), skipped,
  learner-safe failure text (a database failure shows no SQL or JSON) and
  a lone surrogate stored fine, another language's
  session, kids, open/404/405, a run that died with the server (whose late attempt counts nothing), and
  Practice on a recapped card (session reviews outside the daily limits,
  an override and a re-run leaving each other alone, a recap retried after
  a practice review skipping that card); `extraction-undo.test.mjs` the
  one unseen-phrase rule in both orders (dropped reply then re-run, and
  back); `extraction.pg.test.mjs` also holds, each round, the turn write
  that drops a reply and captures the next beside a recap (it deadlocked
  and lost the capture before the single lock pass) and a re-run beside a
  rename of a phrase its last run sighted (left the count stale before
  the by-id lock);
  `db-migration-0004.test.mjs` and `migration-0004.pg.test.mjs` the
  migration; Phase 6: `recall.test.mjs` the pure half (grams with accents
  and unspaced scripts, the review's choice, order, caps and kids rule,
  the bank text cleaned, `{{phrase_review}}` rendered and vanishing with
  no heading or warning, retrieval and its block, `parseLookup`, the
  date windows and terms, the LOOKUP search and block, the recap's
  offered list); `recall.http.test.mjs` (the stand-in `claude` with a
  reply per run and every run's argv) the review in the turn's system
  prompt, `/api/assemble`'s reply and an export, an empty bank and a pack
  without the unit leaving nothing behind, retrieval appended after the
  learner's words, bank text trying to close its block, LOOKUP run once
  with results from the bank and past sessions (recorded on the turn,
  never spoken, both calls' time), a second LOOKUP ignored, another
  language's bank and sessions never reached, a pack in another language
  reading no bank, kids' three words, and the recap told what was
  offered and reviewing a used phrase; `recall.pg.test.mjs` (with
  `LINGO_TEST_PG_URL`) the read running while a writer holds every
  phrase and card `FOR UPDATE` (both the review-choosing read and a later turn's words-then-details reads), and the time a turn adds on banks of 600, 3,000 and 6,000 phrases; `extraction.pg.test.mjs` (with `LINGO_TEST_PG_URL`) races 8
  claims of one recap (one wins) and a recap's write against two gloss
  captures of the same phrases (all land, one row each). The `.pg`
  tests make their throwaway databases through `scripts/tests/pg-scratch.mjs`
  or with the process id in the name, and close their pools before dropping
  them.
- **Phase 8** (the bank MCP): `bank-mcp.test.mjs` (PGlite) drives the
  server through a real MCP client in process: exactly four tools, all
  read-only, none taking a learner or language; each tool's results
  (folded search, trouble ranking, sessions, a transcript and its caps);
  another learner's and another language's rows never reached, by search
  or by id; a hostile search string as plain text; the scope gone after
  each call; a failure without SQL; and, as the reader, a query with no
  WHERE seeing only its scope, every ungranted table and column refused
  (42501), writes refused by the read-only transaction (25006) and by the
  grants alone (42501), no scope seeing nothing, and the catalog (RLS on
  and not forced on exactly five tables, one SELECT policy each for the
  reader only, exactly the granted columns, no view or SECURITY DEFINER
  function, the role's attributes). `bank-mcp.pg.test.mjs` (with
  `LINGO_TEST_PG_URL`, PostgreSQL 17) repeats the role's boundaries
  (INSERT, UPDATE, DELETE, TRUNCATE, CREATE, another learner's and
  language's rows by id), shows what a SET of `app.learner_id` or a RESET
  ROLE mid-transaction does (the MCP never sends either), runs
  `scripts/bank-mcp.mjs` itself over stdio, applies 0005 to a 0004
  database with data, migrates as a non-superuser owner with CREATEROLE
  (whose own queries still see every row), stops an owner without it with
  the hint and then applies once a superuser has run it, refuses an
  existing reader role with BYPASSRLS, with another member (named) or
  named in another role's default privileges (named), clears the
  migrating role's own default privileges for it, checks the superuser's
  explicit membership row, and checks db:setup's printed `hint:` line. It
  also checks that the MCP process exits by itself when its stdin ends
  and its connection goes with it, and that `pgSessions` is read-only by
  default under a URL with its own `options=` and fails a call whose
  connection is terminated mid-call, reconnecting only for the next.
  Every role it makes carries the process id and is dropped.
  `chat.http.test.mjs` (the stand-in `claude`, which now keeps each run's
  `--mcp-config`) checks the run's config, the four grants by name beside
  the unchanged file grants, the prompt's section, the panel's `bank`, the
  scope following a language switch, the config file removed after the
  run, no bank with no learner picked, the 409 `stale_learner` for a page
  on another learner, another language or none (no run, nothing stored),
  the history replayed only within a bank's scope, and the kids flag;
  `bank-mcp.test.mjs` also the kids transcript and the byte cap;
  `claude.test.mjs` the MCP tool-name rule; `db-migrations.test.mjs`
  pins 0005's hand edit and `bankReaderProblem`; `db.test.mjs` the
  worktree rule for `LINGO_READER_ROLE`. The whole suite runs as a non-superuser table
  owner (`testdb.mjs`), with RLS on.
- **UI:** login, the learner picker, a voice session that persists and
  recaps, and each practice mode are verified in the real app with Playwright
  before a bead closes (CLAUDE.md).

## Revisit

Added 2026-11-17 (bead `ld-qxw`, migration `0008_revisit`). The learner can
practise a past scene again from History, and any session of a scene played
before builds on its last attempt. Decisions (interview, 2026-11-17):
Practice again loads the snapshot as played; the last attempt's kept
phrases, corrections and a briefing all carry over; History groups by
scene, with a 7-day card and a model-written digest once a day; the recap
compares with last time; a session links to the last attempt however it
was started; kids get grouping, Practice again and kept words only.

**Same scene** (`scene_key`, `scripts/revisit.mjs` `sceneKey`): `s:<scenario
id>` for a library scene, picked or drawn by a random scene (the drawn one),
whichever pack it came from; `q:<md5>` for a quick scenario, of its text
with whitespace runs made one space, trimmed, lower-cased; `c:<own id>` for
anything else (never linked). Written at creation; 0008's backfill gives the
old rows the same key in SQL (`hand-edits.mjs` 0008, checked against the JS
in `migration-0008.mjs`, its whitespace class spelling out the Unicode
spaces JavaScript's `\s` matches; `lower()` follows the server's
LC_CTYPE, so under a C locale a non-ASCII capital can split an old group). Readers fall back to `c:<id>` for a null.

**The previous attempt** (`web/server/revisit.ts` `previousAttempt`), chosen
once when the conversation is made: the session `ConversationCreateRequest.previous`
names (Practice again's) when it is this language's, this scene's, played
in the same target language (`conversations.target_language`: a pack whose
overrides move it is not a retry), ended, with `extraction_status =
'done'`; else the scene's latest such session.
None for a `c:` key, a scene never played, or one whose recaps all failed,
were skipped or are still being written. `previous_conversation_id` records
it, composite key `(previous_conversation_id, language_profile_id)` to
`conversations (id, language_profile_id)`, `ON DELETE SET NULL
("previous_conversation_id")`: a delete nulls the link only. A failed read
is logged and the session starts fresh; an insert refused because that
session was deleted meanwhile (another tab; `revisit.ts` `lostPrevious`) is
made again without the link, the carry-over kept, as the delete would have
left it.

**What it carries** is frozen into `pack_snapshot.revisit` (`carryFrom`;
the server's key, a client's dropped, like `review` and `random_draw`):
`{from, startedAt, title, kept: [{text, meaning, phraseId}]}`, plus for
adults `summary`, `corrections: [{said, better}]` and `events: [{phrase,
kind}]`, each capped (`CARRY`). Read back through the same caps
(`storedRevisit`), so later edits, a recap made again or a delete of the
earlier session never change a session's briefing or comparison. Three uses:

- **Review.** The kept phrases' bank ids go first in the review block
  (`sessionReview`'s `first`, through `reviewFromIds`, so only phrases the
  bank still has usable), then the usual choice, within `REVIEW_MAX`. Only
  when the pack has a recall unit and is in the bank's language, as before.
- **Briefing** (adults). Every turn of a saved conversation appends
  `revisitBlock` to the system prompt: instructions (mention it once,
  briefly; set up moments to retry each correction; work the kept phrases
  in; vary the details) and the data between `[LAST TIME IN THIS SCENE]`
  and `[END OF LAST TIME]`, every stored string through `recall.mjs`
  `bankText` (no square, curly or angle brackets: a learner's words quoted
  in a correction can't close the block or open a fake one), said to be data. It lists the kept
  phrases too, so a pack with no recall unit still gets them. An unsaved
  turn has no conversation and no briefing.
- **Comparison** (adults). The recap's prompt lists last time's
  corrections, numbered (`lastTimeSection`), and asks for `last_time:
  [{n, result: fixed|repeated|not_tried}]` (read by `parseLastTime`:
  unknown results and out-of-range numbers ignored). `compareAttempts`
  stores `extraction.vsLast = {from, startedAt, fixed, still, untried,
  improved, slipped}`: the corrections by the model's judgement; phrases by
  rule, a phrase both sessions judged on the same skill (`fsrs.mjs`
  `ratingForSessionEvent`) rated higher (improved) or lower (slipped) now.
  `SessionRecap.vsLast` gives `from` as the link column, null once the
  earlier session is gone. The card's "Since last time" shows it.

**History by scene.** `GET /api/conversations/scenes?offset=&limit=` →
`{scenes: [{sceneKey, attempts, latest}], nextOffset}`, the scene played
most recently first; `GET /api/conversations?scene=<key>` lists one
scene's (compared on the column itself, so the index serves it). Index `conversations_profile_scene_idx (language_profile_id,
scene_key, started_at)`. `ConversationSummary` carries `sceneKey` and
`buildsOn: {id | null, startedAt}`. `GET /api/conversations/:id` carries
`pack`, the snapshot without the server's keys, which Practice again loads
into the Go tab as an unsaved draft (App `practiceAgain`); its id rides
along as `previous` until a conversation builds on something.

**Overview** (adults; kids get `{stats: null, digest: null}`). `GET
/api/conversations/overview`:

- `stats` (`weekStats`, no model): sessions started in the last 7 days,
  their minutes (History's length rule), distinct scenes, the recaps' kept
  phrases, and corrections whose `better` (by `normKey`) came up in two
  sessions or more (at most 5).
- `digest`: written once a day per language by one tool-less `claude -p`
  (`digestPrompt`: the week's done recaps, at most 20, newest first, as
  delimited data; `parseDigest`: `{"digest": "…"}`, at most 1200
  characters). Table `recent_digests (id, learner_id, language_profile_id,
  day date, status running|done|failed, claim, text, through, sessions,
  created_at, finished_at)`, unique `(language_profile_id, day)`: the
  request that finds a digest due (a recap finished, `extracted_at`, after
  the last done digest's `through`, the newest recap it read, so a Retry
  that lands late counts; no row today) inserts today's row first, and only the
  insert that lands starts the call, so the unique key is the cap and a
  failed day still counts. Never retried the same day. `status` on the
  wire: `pending` (today's running in this server), `failed` (today's
  failed or was interrupted, and newer sessions wait), `stale` (newer
  sessions since; today's already tried), `current`. The card asks again
  every 5 s for up to 3 min while pending. The reader role (0005) gets
  nothing on `recent_digests`, nor on the two new columns.

Code: pure `scripts/revisit.mjs`; server `web/server/revisit.ts`
(previous attempt, overview, digest run), `conversations.ts` (create,
scenes, `?scene=`), `voice.ts` (briefing), `extraction.ts` (comparison),
`recall.ts` (`sessionReview`'s `first`); client `HistoryView.tsx` (scene
rows, the week card, Practice again), `SessionRecap.tsx` (Since last time),
`GoTab.tsx` (the "Building on your session of …" line). Tests:
`revisit.test.mjs`, `revisit.http.test.mjs`, `db-migration-0008.test.mjs`,
`migration-0008.pg.test.mjs`.

## Hidden scenes

Added 2026-11-18 (bead `ld-ke1`, migration `0009_hidden_scenes`). A learner
practising several languages can hide the library scenes and folders one of
them will never use (First steps (Mandarin) while learning Spanish). The
library is content everyone shares, so a hide is a per-language-profile
preference, never a file delete, and it is soft only in the sense that it
is undone in one tap: unhide deletes the row, hiding again inserts a new one.

Table `hidden_scenes (learner_id, language_profile_id, kind, key,
hidden_at)`, primary key `(language_profile_id, kind, key)` (the unique
key), `kind` checked `in ('scenario', 'collection')`, `key` at most 200
characters (checked), composite key `(language_profile_id, learner_id)` to
`language_profiles (id, learner_id)` `ON DELETE CASCADE`, like
`phrase_dismissals`. `key` is a scenario id, or a collection name exactly as
the library spells it (`""` for the scenes in no collection, as the random
pool names them); it is not checked against the library, which can change
under a stored hide (a hide for a scene gone from it is listed by its id
and can still be restored). The reader role (0005) gets nothing on it.
Queries only in `scripts/db/hidden.ts`, through `forLanguageProfile`.

Routes (`web/server/hidden.ts`, wrap's `learner: true`; the language is the
session's, never one named in the body, so another learner's or language's
hides are neither seen nor removed):

- `GET /api/hidden-scenes` → `{hidden: [{kind, key, hiddenAt}]}`, oldest first.
- `POST /api/hidden-scenes {kind, key}` → `{hidden, created}`: 201 when made,
  200 (its first `hiddenAt` kept) when it was hidden already, 409 when the
  language already holds `MAX_HIDDEN_PER_LANGUAGE` (500) hides
  (`hidden.ts` `HiddenLimitError`; a repeat of one it has is still a 200).
- `DELETE /api/hidden-scenes {kind, key}` → `{unhidden}`, false (still 200)
  when it wasn't hidden.

A malformed body is a 400 (`readHiddenRef` in `web/shared/scenes.ts`: a
known kind, a string key, a scenario's not blank, no leading or trailing
whitespace (the loader trims ids and names, so such a key could match
nothing), at most `MAX_HIDDEN_KEY`, no NUL).

What a hide changes, by one pure rule in `web/shared/scenes.ts`
(`isHiddenScene`: the scenario itself, or its whole collection) used by the
server and the Scene tab alike:

- **The random draw.** `randomPool` takes the hides and leaves those scenes
  out before the drill rule; `drawOrRefuse` gets them from `hiddenSet` at a
  session's start (`conversations.ts`) and for an export (`content.ts`). A
  kept draw (`drawn`) hidden since is drawn afresh. When the hides alone
  empty the pool (`emptiedByHides`), the 400 says so and points at Restore.
  The CLI export has no learner and hides nothing.
- **The Scene tab** (`SceneTab.tsx`, `visibleScenes`): hidden ones leave the
  list, its folders, the category chips' counts and the Random card's
  counts and chips at once (App's `setSceneHidden`: optimistic, each key's
  requests chained so a hide and its Undo reach the server in order, the
  list re-read when one is refused), with a "Hid … Undo" line (focus moves
  to Undo, since the hidden button is gone), and "N hidden · show"
  at the bottom lists each with Restore. No confirm: it is that easily
  undone. The selected scene stays listed even when hidden, marked so, so a
  draft never points at something the tab doesn't show.
- **Nothing else.** A pack, a revisit or Practice again that names a hidden
  scene plays it; preview and assemble never draw unless asked (`draw: true`, Copy: the export's draw, no recent avoidance, nothing stored, reply `drawn`). Hides are not part of a
  pack or its snapshot.

Tests: `hidden.test.mjs` (pure rules, rows, isolation, the table's checks),
`hidden.http.test.mjs` (401, 409 `stale_learner`, 400s, the draw and the
export), `db-migration-0009.test.mjs`.

## Kids word game

Added 2026-11-20 (bead `ld-8zu`, migration `0011_word_pictures`; Black
Forest Labs, the picture theme, the stock set and Redraw all 2026-11-21,
bead `ld-6k7`, migration `0012_picture_themes`; adults and the picture
library 2026-11-21, bead `ld-318`, migration `0013_stock_concepts`). A kids
learner's Practice tab is a by-ear game: the child hears a word of the
language they learn and taps the matching picture. An adult plays the same
game as Practice's **Pictures** mode (§The game for adults). A kids
learner's adult drills stay a 403.

### Tables

`phrase_pictures (id, phrase_id, learner_id, language_profile_id,
phrase_key, status, description, file, content_type, created_at,
updated_at)`:

- There is one row per phrase (unique `(language_profile_id, phrase_id)`).
- Composite foreign keys go to `phrases` and the language profile, both `ON
  DELETE CASCADE`.
- `phrase_key` is `pictureKey(phrase)` (`scripts/pictures.mjs`): a hash of
  the words and meaning the verdict was made for. When either is edited the
  row is stale, so the word is judged again and its old picture leaves the
  game at once.
- `status` is one of:
  - `pending`: picturable and waiting to be drawn.
  - `ready`: it has a `file`.
  - `none`: no clear picture, so it stays out of the game, unless a
    grown-up has it drawn anyway (below).
  - `failed`: the provider refused. It is never retried by itself.
  - `removed`: a grown-up took it out.
- `theme` (0012) is the picture theme the file was drawn in (§The picture
  theme): `PICTURE_THEME`'s id, or `<id>+openai` when OpenAI drew it. Null
  for a picture drawn before 0012, and while there is no file.
- `stock_id` (0012) is set when the word points at a shared stock picture
  (§Stock pictures) instead of a file of its own. `file` is then
  `stockKey(theme, id)` (64 hex, like a drawn key, so the URL changes with
  the theme), which never names a file of its own.
- `restyle` (0012) is a grown-up's Redraw all waiting on a ready row:
  `check` (ask the check for a stock picture first) or `draw`. Null
  otherwise.
- `look_alike` (0021, ld-44x) is the look-alike group the picturable check
  named for a word it will draw (§Look-alikes on one screen). Null: none
  named, a stock match, or judged before 0021; checked null or
  `^[a-z0-9][a-z0-9-]{0,47}$`.
- The checks:
  - `file` (64 hex) and `content_type` (png, webp or jpeg) are present
    exactly when the row is `ready`.
  - `pending` and `ready` rows need a `description`.
  - `theme` matches `^[a-z0-9][a-z0-9.+-]{0,63}$`.
  - `stock_id` only on a `ready` row with a `theme`, and it matches
    `^[a-z0-9][a-z0-9-]{0,47}$`.
  - `restyle` only on a `ready` row, `check` or `draw`.

`picture_calls (id, learner_id, language_profile_id, kind, words, outcome,
created_at)` is the ledger of paid calls:

- `kind` is `judge` or `image`.
- Each row is written as its call starts, so a failure counts too and a
  restart doesn't reset the count.
- `outcome` is filled after the call, for diagnosis only.
- It cascades with the profile only: a deleted phrase's calls still count.
- Each insert prunes that language's rows older than a day.

`reviews.mode` adds `picture`. The reader role (0005) gets nothing on either
table. Queries are only in `scripts/db/pictures.ts`, through
`forLanguageProfile`.

### Pictures, made ahead of play

There is one background run per language profile (`web/server/pictures.ts`
`fillPictures`).

Triggers:
- a kids session's end, after its recap is stored, from `extraction.ts`
  (`picturesAfterSession` checks the learner is kids, so adults start
  nothing);
- the grown-up's **Draw pictures** (Library → Phrase bank), **Draw again**
  or **Draw it anyway**;
- a game's start, as a top-up. The game is built only from ready pictures
  and never waits for it.

Nothing is drawn from a poll, a count or a page load.

Each run, in order:

1. **The picturable check.** One tool-less `claude -p` call (Haiku) per 20
   words that have no current verdict. Its reply is a numbered yes/no with a
   short description (`judgePrompt` / `parseJudgeReply`; a yes with no
   usable description counts as a no). The verdict is stored once per words
   and meaning. The check is told that:
   - the description is a short noun phrase for one object or one simple
     scene;
   - it has no names of people and no instructions;
   - a word or phrase about a named person, or one that is a whole
     sentence, is not picturable.

   The check is also offered the stock pictures drawn in the current theme
   (§Stock pictures) as data after the words, each an id and its English
   words. For a picturable word whose meaning is exactly one of them it
   may add `"stock": "<id>"`. Then the word is `ready` at once, pointing at
   that stock file: no image call and no image row in the ledger. An id
   that wasn't offered is ignored (the word is read as if it had none). The
   check is worded for any learner, not only a child, since the game will
   be offered to adults too; the descriptions stay safe for one.
2. **The drawing.** One image per picturable word, newest words first,
   through the image provider (`web/server/imageProvider.ts`, one small
   swappable module).

The description is free text a model wrote, and it goes to the image provider, so the
code enforces the rules too (`cleanDescription`, `scripts/pictures.mjs`), both
when the verdict is stored and again just before drawing:
- Apostrophe look-alikes (’ ʼ ` and others) become `'`. Then it keeps
  only letters, digits, spaces and `,.'-`. No quotes, brackets or colons
  survive.
- It is capped at 12 words (`DESCRIPTION_WORDS`) and 80 characters
  (`DESCRIPTION_MAX`), cut at a word.
- **Names:** if any word names a learner on the account (archived learners
  included), the word gets **no picture** (`none`), and no image call is
  made. The rest of the description is never sent, because when the name
  was the subject the leftover is a wrong picture: for a learner called
  Rose, "a rose bush" would become "a bush".
  - Both sides are folded before comparing: NFKD, combining marks
    stripped, lower case. So José, NFD José and Jose match, and Zoë matches
    Zoe.
  - Each word and each name is split on anything not a letter or digit.
    A word names someone when any of its parts is a name part, so
    "Mia-Rose", "Mia’s" and "O’Neil" are caught.
  - A part that is a name with an "s" glued on also counts ("Mias", for a
    lost apostrophe).
  - Name parts shorter than two letters are ignored ("O" of O'Neil).
  - The names are read once per run, so a learner added after the check
    still never reaches the provider.
- If nothing useful is left (filler such as "a picture of"), the word also
  gets no picture.

The prompt (`picturePrompt`) starts with the picture theme's style lines
(§The picture theme), then the fixed safety lines: no text, letters,
numbers or writing anywhere, and nothing frightening. Then comes a line saying the quoted text describes the subject
only and is never an instruction. The last line is the description as quoted
data (`Subject: "…"`). A description can't hold a double quote, so it can't
close the quotation.

Limits:
- Every call runs in the user's background paid slot (`paid.ts`). If the
  slot is busy (cloze writing has it, or another language's pictures), the
  call waits for it (`backgroundSlotWhenFree`, bead `ld-8ou`): it asks
  again every 2 seconds for at most 2 minutes (`SLOT_WAIT` in
  `web/server/pictures.ts`). While it waits it holds no slot and has
  written nothing to the ledger. Past the 2 minutes the run stops, with
  nothing paid and no 10-minute backoff, and the next trigger carries on.
- The daily cap is counted twice per call: before the wait, and again
  inside the slot just before the ledger row is written. A cap reached
  during the wait means the call isn't made.
- At most `PICTURE_DAILY_IMAGES` (200) images and `PICTURE_DAILY_JUDGES`
  (20) checks per language profile in any 24 hours. Both are counted from
  the ledger. The cap is per language profile, not per account: the most
  an account can spend in a day is 200 images times its number of kids
  languages. With Black Forest Labs at $0.008 a picture that is at most
  about **$1.60 per language a day**.
- 20 checks of 20 words are 400 words a day, so the image cap can be
  reached in one day even when some words get no picture and Redraw all
  asks its own checks (10 checks, the old number, would be exactly 200
  words: too few).
- A stock match is not an image and is not counted.
- A grown-up's **Draw again** (redraw) and **Draw it anyway** count against
  the same ledger and cap. Either over the cap waits like any other word.

Failures:
- A moderation refusal (Black Forest Labs' `Request Moderated` or `Content
  Moderated`; OpenAI's `moderation_blocked`, or no image in its reply)
  marks the word `failed`, and the run goes on to the next word.
- Any other failure (network, a 402 out of credits, a 429, a bad key, no
  picture within BFL's 60 seconds, the CLI) stops the run and leaves the
  word `pending`. A new run waits 10 minutes.
- **A word that keeps failing is given up** (`PICTURE_WORD_FAILURES`, 2):
  a failure that is the word's own (`ImageFailed.perWord`: a BFL task that
  ended with Error, No Card Generated or Task not found, a download that
  isn't a picture, an OpenAI 5xx) counts against that word. The second in
  a row marks it `failed` like a refusal (a restyled word keeps its old
  picture) and the run goes on, so one bad word can't stay first in the
  work list spending a ledger row every retry. Out of credits, a rate
  limit, a bad key or the network never count. The count is in memory
  (no migration): a restart gives a word two more tries, under the cap.
  Draw again by hand still works.

**How the backlog drains:** every trigger works newest-first until the caps
of the last 24 hours. Older words, and words past the cap, wait for a later
trigger once the window frees up: the next session's end, the grown-up's
Draw pictures, or a game start.

**The cache:**
- A verdict is never made twice for the same words and meaning.
- A drawn picture is never drawn again unless a grown-up asks for a redraw.
  A redraw writes a new file under a new random name and deletes the old
  one.
- **A file goes with its row** (bead `ld-0dl`, `dropPictureFile` in
  `web/server/pictures.ts`). The file is deleted from disk when:
  - its phrase is deleted from the Phrase bank (`DELETE /api/phrases/:id`:
    `deletePhrase` returns the file its picture row named, and the route
    deletes it after the commit);
  - its picture is removed or redrawn;
  - its word is edited and judged again.

  The rules for every one of those:
  - The file is kept while any `phrase_pictures` row still names its key
    (`pictureFileInUse`, the one query across owners: a yes/no about a
    random key). If that can't be asked, the file is kept too.
  - A file already missing is not an error, and a failure to delete never
    fails the request (it is logged).
  - Only a file directly inside the images directory is ever deleted: the
    key must be 64 hex and the path made from it is checked again
    (`deletePicture`, `scripts/picture-store.mjs`).
  - Not covered: phrases that go by other paths (a recap re-run's
    `settleUnseen`, or a deleted learner or language) still leave their
    file behind (bead `ld-co8`).
- Files are in `data/images/` (or `LINGO_IMAGES_DIR`), named by 64 random
  hex characters, with mode 0600 in a 0700 folder
  (`scripts/picture-store.mjs`). They are checked by their magic bytes and
  capped at 4 MB.

**Which provider:** Black Forest Labs when `BFL_API_KEY` is in
`.env.local`, else OpenAI when `OPENAI_API_KEY` is, else none
(`imageProvider()` in `web/server/imageProvider.ts`, read per call, so
adding a key needs no restart). Each key goes only into its provider's
request header (BFL's only to an https URL on `*.bfl.ai`). It never reaches
the browser or a log line.

**No key:** the stock pictures still work. The check runs (it is a Claude
call, not an image) only when some stock picture is drawn; a word it
matches is ready, and the rest wait for a key. The grown-up's `problem`
sentence (naming both keys) shows only when a word needs a real drawing:
one to draw, or words to judge with no stock picture drawn. With no key
and no stock, nothing is judged or drawn, and `POST /api/pictures/fill` is
a 400 with that sentence. Nothing 500s. `LINGO_IMAGE_PROVIDER=stub` draws
coloured placeholder PNGs, for tests and UI checks.

### The picture theme

Every picture is drawn in one look, so a round's pictures sit together:
`PICTURE_THEME` in `scripts/pictures.mjs`, the one place it is defined.

- `id`: `cream-outline-1`.
- The style lines, first in every prompt: a flat vector picture-book
  illustration of one subject filling about two thirds of the square;
  thick, even, dark-brown rounded outlines; flat solid fills with no
  gradients, texture or shading beyond one darker flat tone; a warm,
  limited palette; a small soft oval ground shadow; a plain flat light
  cream background (`#FFF4E0`), empty, with no scenery, pattern or border.
- `seed`: 7, sent to Black Forest Labs with every picture. OpenAI gets the
  same lines but has no seed, so its pictures are recorded as
  `cream-outline-1+openai`, not in the theme's own look.

Why (measured 2026-11-21 with real FLUX 3 Image Klein draws): the earlier
lines ("flat, friendly ... plain soft pastel background") gave visibly
different looks, one textured and shaded, with peach or blue backgrounds,
with and without ground. These lines with seed 7 gave a dog, a hand, a bus
and an apple in one consistent look. **No reference image** (BFL's
`images`) is sent: with the dog as a style reference, "a cat" came back as
the same dog with whiskers. The subject leaks.

**To change it:** give `PICTURE_THEME` a new `id` (and new lines or seed).
Then:
1. run `npm run pictures:stock` (the stock set is kept per theme, so the
   new theme starts with none drawn; the old files are left alone and no
   longer offered);
2. press **Redraw all in the current style** in each kids learner's Phrase
   bank (below).

Nothing old is silently mixed in: a picture's `theme` says what it is.

### Stock pictures

A shared set of about 200 concrete, picturable concepts (`content/pictures.yaml`,
beside `languages.yaml`, so both libraries share it), grouped by category:
animals, colours, the numbers one to five, family and people, body,
health, fruit and vegetables, food, drinks, the table, home, clothes,
toys, school and work, money and shopping, transport and travel, places,
nature and weather, actions. Each is `{ id, description, words, group?,
adults? }`: the id (also the file's name), the short description the
theme's prompt gets, and the English words it stands for; `group` names
look-alike concepts (a boy and a brother, a ball and catching one, a tree
and a forest, a parcel and a suitcase), and a round never offers two of one
group (two right answers, or two a learner can't tell apart; §Look-alikes
on one screen); `adults: true` (none of the file's since 2026-11-21) keeps a concept from kids
learners: it is never offered to their check, so never matched, and a kids
word pointing at one (matched before the flag) leaves the game
(`stockForMode` in `scripts/pictures.mjs`, `playable` in
`web/server/pictures.ts`). Adult learners get them. The numbers one to five
are one object counted ("exactly three smooth round pebbles in a row"): no
printed digit, no colour of their own. The loader checks it with the rest of
the library (`loadPictureStock`, `scripts/content.mjs`; the rules are
`readStockList` in `scripts/pictures.mjs`): unique ids, a description that
passes `cleanDescription` as written, at least one word, and a warning for
a word in two concepts.

The files are drawn once per install by the grown-up:

```sh
npm run pictures:stock                  # every concept with no file yet
npm run pictures:stock -- --limit 20    # at most 20 this time
npm run pictures:stock -- --dry-run     # what it would draw, and the cost
```

- It uses Black Forest Labs (`BFL_API_KEY`) whatever else is set: the
  theme's own provider. `--dry-run` needs no key.
- One draw per concept with no file in the current theme, one at a time.
  Run again, it draws nothing it has.
- It prints the theme, each picture with the credits its submit billed,
  and the total. It stops cleanly at a 402 (out of credits) or a 429, and
  skips a refused concept. The key is never printed.
- It writes `<images dir>/stock/<theme id>/<concept id>.jpg`. Image files
  are never committed.
- It is not in any learner's ledger: it is the grown-up's explicit one-off.
- The whole set of 212 is about 170 credits, **about $1.70** at $0.008 a
  picture.

How a word uses one:
- The check is offered only the concepts drawn in the current theme. A
  match sets the row `ready` with `stock_id`, `theme` and `file =
  stockKey(theme, id)`. A concept whose file isn't drawn yet is never
  offered, so its word gets a drawing of its own as before.
- `GET /api/game/pictures/:id/:file` serves a stock row's file from
  `stock/<theme>/` with the same owner check (the row must be this learner's
  and language's) and the same immutable cache headers. Logged out is a
  401; another learner, even on the same account, a 404. For a stock
  picture the URL's `file` is `<stock key>.<version>`, the version being
  the file's modification time and size (`stockVersion`,
  `scripts/picture-store.mjs`; `pictureRef` in `web/server/pictures.ts`):
  a stock picture removed and drawn again in the same theme gets a new URL
  instead of the browser's year-old cached copy, and the old URL is a 404.
  The row itself is unchanged.
- A word pointing at a stock file whose file isn't on disk (removed, or an
  old theme's never drawn on this install) leaves the game until it is.
- **Draw again** on a stock-matched word draws a picture of its own (paid,
  in the ledger). **Remove** removes only that word's picture.
- No per-word removal, redraw, verdict or phrase delete ever deletes a stock
  file: the row's `file` is a key no file is named by, the callers pass
  only a word's own file (`deletePhrase` returns none for a stock row), and
  `deletePicture` only ever touches `<images dir>/<64 hex>.<ext>`.
- Two words pointing at one stock picture are never in one round (two right
  answers): `roundChoices` skips a picture file already offered, and a
  stock picture of a look-alike group already offered.
- Words judged before 2026-11-21 keep their verdicts. Matching older
  `none` words against the stock is bead `ld-30r`.

Stock access is small functions (`scripts/picture-stock.mjs`: `listStock`
with each concept's file state, `drawStockPicture`, `removeStockPicture`,
`addStockConcept`), which the CLI and the picture library page use.

#### Concepts added from the page, and the stock ledger (ld-318)

Migration `0013_stock_concepts` adds two install-wide tables (nobody's
personal rows, so not through `owned.ts`; queries only in
`scripts/db/pictureStock.ts`):

- `picture_stock_concepts (id, category, description, words text[],
  adults boolean not null default false, look_alike_group text (0019),
  created_by → users ON DELETE SET NULL, created_at)`: a concept an admin
  added from the page. Checks: id `^[a-z0-9][a-z0-9-]{0,47}$`, category
  1–40 characters, description 1–80, 1–20 words, a group null or in the
  id's format (§Look-alike groups, set from the page). Never written to
  `content/` (`content/pictures.yaml` is the content agent's file).
- `picture_stock_calls (id, user_id → users ON DELETE SET NULL,
  concept_id, outcome ok|refused|failed|null, created_at)`, indexed on
  `created_at`: one row per stock draw, written as the call starts (before
  the provider is asked), pruned past a day.

**Merging.** Everywhere the stock list is read (the picturable check's
offer, the page, `npm run pictures:stock`), `mergeStock` in
`scripts/pictures.mjs` puts the file's concepts first and then the
database's; all of them pass `readStockList`'s rules. Each comes back marked
`custom` or not. If the file later gains a concept with an added one's id,
the file's wins (its description, flags and the picture file); the added
row is returned as `shadowed`, with one warning naming them all (the
server logs it once per change, not per read). The list reply gives an
admin `shadowed`, the page shows them under "Shadowed by the app's own
list", and `:id/remove` deletes such a row only, never the picture (the
file's concept owns it now). The CLI reads the database's concepts when it can (a
warning and the file alone when it can't).

**Routes** (`web/server/stockPictures.ts`, all through `wrap()`):

- `GET /api/stock-pictures` (auth `user`): the merged set with each
  concept's state (drawn, version, queued, refused), whether the session
  can edit, the day's stock draws against the cap, the cost each, and any
  problem. It starts nothing; the page polls it every 3 s while drawing.
- `GET /api/stock-pictures/file/:id/:version` (auth `user`): a stock
  picture for any logged-in user (401 logged out). The version is the
  file's type, mtime and size, so a redraw is a new URL; the reply is
  `private, max-age=31536000, immutable`, `Vary: Cookie`, `nosniff`; a
  stale version is a 404.
- `POST /api/stock-pictures/admin/…` (auth `admin`: a 403 for a non-admin
  before anything is read; mounted ahead of the user prefix):
  - `concepts` `{name, category, description, words}` (`readNewConcept`:
    the id is the name's slug, the description passes the same cleaning
    and learner-name check as Draw it anyway, words are a list or a
    comma-separated line): 201 and its draw queued; 400 with a sentence,
    409 for a taken id.
  - `missing` `{count}`: queues every concept with no picture, up to what
    the day's cap leaves. The count is what the page showed (with the cost)
    when the admin confirmed; a different count now is a 409. No key is a
    400, a cap already reached a 429.
  - `:id/draw`: queues a draw (or a redraw) of one; 429 at the cap.
  - `:id/remove`: a file concept is a 409 (it can be drawn again, not
    deleted), unless an added row it shadows exists, which is deleted
    alone (the picture stays); an added one's row and its current-theme
    file are deleted.
  - `concepts` also takes `adults` (true or false; anything else is a 400).
  - `:id/adults` `{adults}` (true or false; anything else is a 400, an
    unknown id a 404): sets or clears the concept's Adults only flag
    (§Adults only, set from the page), and answers the list.
  - `concepts` also takes `group`, and `:id/group` `{group}` sets or
    clears an added concept's look-alike group (§Look-alike groups, set
    from the page).

**Drawing.** Queued draws are drawn by one install-wide run, a picture at
a time, each in the asking admin's background paid slot (the same slot as
word pictures and cloze writing) with Black Forest Labs (the stub with
`LINGO_IMAGE_PROVIDER=stub`), never the OpenAI fallback. At most
`PICTURE_DAILY_STOCK` (300) stock draws start in any 24 hours,
install-wide, counted from `picture_stock_calls` (failures count) before
the slot is waited for and again inside it. A refusal skips that concept;
any other failure, the cap or a busy slot stops the run and empties the
queue, and the page says why. Draws from `npm run pictures:stock` are not
in this ledger (bead filed).

**Caching after a redraw.** A stock redraw keeps the file's name but
changes its version (`stockVersion`: mtime and size), which a word's
stock picture URL carries (`pictureRef`), so the game and the Phrase bank
get a new URL and the old one is a 404; the immutable headers stay.

**Kids and the adults flag.** The Add form has an "Adults only (never
shown to kids learners)" box, stored as `adults`; the file's concepts keep
`adults: true` through `mergeStock`. Either kind flagged is, for a kids
learner:
- never offered to the picturable check (`stockOffer` → `stockForMode`
  over the merged list), so never matched;
- out of the game if a word already points at it (`playable` reads the
  merged list; a kids learner's stock row whose concept isn't in the list
  at all leaves the game too);
- left out of `GET /api/stock-pictures` and a 404 from its file route when
  the session's active learner is a kids learner.
The shared-library grid shows an "Adults only" badge on both kinds.

#### Adults only, set from the page (ld-cvd)

An admin sets or clears any concept's flag from its tile: **Set adults only**
beside the badges, or **Allow kids** beside the Adults only badge (a
confirm first: clearing it lets kids' words be matched to it).
`POST /api/stock-pictures/admin/:id/adults` `{adults}` (auth `admin`):

- An added concept: its own `picture_stock_concepts.adults` is set.
- A concept of `content/pictures.yaml` (the app never writes `content/`):
  migration `0018_stock_adults` adds `picture_stock_adults (concept_id
  text primary key, adults boolean not null, set_by → users ON DELETE SET
  NULL, updated_at)`, install-wide (no owner, not through `owned.ts`;
  queries only in `scripts/db/pictureStock.ts`; the reader role gets
  nothing). A row is kept only while it differs from the file's own flag:
  setting a concept back to the file's value deletes it, so a later edit
  of the file is followed again. `mergeStock(base, custom,
  adultsOverrides)` lays the rows over the file's flags; a row never
  touches an added concept or a shadowed row (on a shadowed id the toggle
  sets the file's concept, which is the one in use, and deleting the
  shadowed row keeps the setting), and a row whose id the file no longer
  has is ignored.
- Every reader goes through the server's `stockList` (`listStock` with
  both), so the effective flag is what `stockForMode` (the check's offer),
  `playable` (the game's rows and rounds), `visibleTo` (the list) and the
  file route read, on the next request:
  - set: a kids session at once gets no listing, a 404 for the file, no
    word pointing at it in the game or a round's choices, and the check
    is not offered it. A kids word matched to it before keeps its row,
    but its picture is withheld (`stockWithheld` in
    `web/server/pictures.ts`, the same rule as `playable`, failing closed
    for a concept not in the list): `GET /api/game/pictures/:id/:file` is
    a 404, and My word pictures (`/api/pictures/words`) and the Phrase
    bank (`/api/pictures/phrase/:id` and its actions) show it with `file:
    null`;
  - cleared: a kids session sees and plays it again, and the check offers
    it from the next picturable check (words already judged keep their
    verdicts).
- Fails closed: if the settings can't be read, every file concept counts
  as Adults only (kids get none of them for that read; an adult's view
  doesn't depend on the flag), logged.

#### Look-alike groups, set from the page (ld-2nw)

An added concept may carry a look-alike `group`, like a file concept's in
`content/pictures.yaml`, so a round never offers it beside a look-alike
(a lad and the file's boy: two right answers). Migration
`0019_stock_group` adds `picture_stock_concepts.look_alike_group text`
(nullable; not `group`, a reserved word in SQL), checked null or
`^[a-z0-9][a-z0-9-]{0,47}$`, the format of the file's group ids. Rows
already there have none.

- **Set** in the Add form's optional **Look-alike group** field, or
  later from the concept's tile (**Group**, then Save; blank clears it).
  Both fields suggest every group in use, the file's and the added ones'
  (a `datalist`), since joining an existing group is the usual case.
- **Checked** by `readStockGroup` in `scripts/pictures.mjs`: trimmed and
  lower-cased, then the file's format (`STOCK_ID_RE`); absent, null or
  blank is none; anything else is a 400 with a sentence.
- `POST /api/stock-pictures/admin/:id/group` `{group}` (auth `admin`: a
  403 for a non-admin, 401 logged out): a body without `group` or a bad
  one is a 400, an unknown id a 404, and a concept of
  `content/pictures.yaml` (or a shadowed id: the file's is the one in
  use) a 409, since its group is set in the file. Answers the list.
- **Read** through `mergeStock`, which passes an added concept's group to
  `readStockList` with the file's (a stored group that no longer passes
  is dropped with a warning). `playable` in `web/server/pictures.ts`
  gives each stock row its concept's group from the merged list, so
  `roundChoices` never offers two concepts of one group, file and added
  alike, from the next round on. The list reply carries each concept's
  `group` (the file's too) and the tile shows it to an admin; only an
  added concept's can be edited.

**Deleting an added concept** deletes its file; words pointing at it leave
the game until each is drawn again (nothing re-points them; bead filed).

#### Look-alikes on one screen (ld-44x, migration 0021)

Pictures that look the same are never on one round's screen, even for
different words (the owner saw a box and a suitcase, 2026-11-22). Other
rounds of the same game may show both. Every picture in a round carries a
look-alike `group`, and `roundChoices` skips a second of one:

- **Stock pictures:** the concept's `group`. The 2026-11-22 audit of the
  drawn stock set added 19 groups and widened five (`bag`: parcel, present,
  suitcase, bag, backpack, shopping bag, basket; `book` + notebook,
  passport, menu; `coins` + banknotes, bill; `tree` + park, climb; `girl` +
  doll; `leg` + hand; and `train`, `shop`, `airplane`, `table`, `car`,
  `water`, `juice`, `cup`, `move`, `sing`, `bear`, `red-fruit`, `shirt`,
  `screen`, `bath`, `cloud`, `head`, `bike`; drink joins `cup`, brush
  teeth `mouth`). Groups are tight: only what a learner could take for the
  other, by look or by one word naming both. A stock match stores its
  concept's group in `look_alike` too: while it points at stock its
  concept's own is read, but it keeps the group if it later becomes a
  drawing of its own (the stock file gone at the match, or Redraw all with
  no stock picture in the new theme).
- **A word's own drawing:** the picturable check is offered the groups in
  use (`lookAlikeGroups`: each id and up to three of its concepts'
  descriptions, file and added, as the learner's mode sees the list) and
  may name one per word it will draw (`looksLike`, only an offered id). It
  is stored with the verdict in `phrase_pictures.look_alike`, once, in the
  same call: no extra call, never re-asked. A grown-up's drawn-anyway
  description and a `none` clear it.
- **Fallback, free:** with no key from the check (judged before 0021, or
  none named), the description's words decide (`lookAlikeOf`, the fixed
  `LOOK_ALIKE_RULES` in `scripts/pictures.mjs`: box, parcel, suitcase, gift
  → `bag`; a glass of milk → `water`; the earliest match wins). Every
  concept's own description in `content/pictures.yaml` gives exactly its
  group (a test holds them to it). Old rows get a key with no call and no
  backfill. `ownLookAlike` is the check's
  key, else this; `playable` in `web/server/pictures.ts` sets it as the
  row's `group`. No key: the picture meets any other, as before.
- **Shared drawings (the pool):** shared with `ownLookAlike` (the check's
  key, else the description's) stored as their concept's
  `look_alike_group`; the column is the truth (`mergeStock` derives
  nothing), so an admin's change or clear on the picture library page
  sticks. `picture_stock_concepts.look_alike_set` (0021, false for the
  rows there) says the group was written on purpose: by sharing, by an
  admin, or by the one-off fill of the drawings shared before 0021
  (`fillDrawingGroups` in `scripts/db/pictureStock.ts`, run on the first
  read of the added concepts in a process: a `drawing` row not yet marked
  that already has a group, an admin's from before 0021, keeps it and is
  only marked; one with none gets `lookAlikeOf` and is marked; free,
  idempotent, every update guarded by the flag).
- **Small banks:** a word whose round could offer only its own picture (a
  bank of only a car, a taxi and a truck) is left out of the game
  (`gameRounds`, `isRound`): one picture to tap is no evidence. A game
  with no round left isn't `ready` (`status.ready` asks `gameRounds` too;
  the game page says the pictures all look alike), and the answer route
  answers a tap on such a round with a 409 and records no review.
  Otherwise nothing is relaxed: a round may offer fewer than four.

### Check again for a shared picture

A grown-up action on the Phrase bank's picture bar (`POST
/api/pictures/recheck`, ld-30r, no migration), shown while
`status.recheckable` is above 0. A verdict is given once, so a word the
check left out (`none`) before a stock picture that fits it was drawn
would stay out for ever. This asks again, about stock pictures only.
- **Which words** (`recheckTargets` in `scripts/pictures.mjs`): practisable
  phrases whose `none` row is current for their words and whose
  `updated_at` is before the newest offered stock picture's file time
  (`stockDrawnAt`). A word already asked with every drawn stock picture on
  offer is never asked twice; a newer stock picture makes it worth one more.
- **The request is in memory** (per language profile, until the run has
  asked): `restyle` can't hold it, being for `ready` rows only by
  constraint. A restart forgets it; the button is still there.
- **The run** asks the picturable check with the drawn stock on offer, 20
  words a call, on the judge ledger and under `PICTURE_DAILY_JUDGES`; past
  the cap the request waits for the next trigger.
- **Only a stock match changes a row**: it becomes `ready` on the stock
  picture (`noneRechecked` in `scripts/db/pictures.ts`), with no image
  call. A word the check now calls picturable with no stock picture stays
  `none` (Draw it anyway is the way to a drawing), and its `updated_at`
  becomes the file time of the newest stock picture it was offered (read
  before the call, not the reply's time): that stops a second ask, and a
  stock picture drawn while the call waited or ran still counts as newer.
- Nothing asks by itself: not a status read, a page load or a run started
  for other work.

### Redraw all in the current style

A grown-up action on the Phrase bank's picture bar (`POST
/api/pictures/restyle`), shown while any ready picture is out of the theme
(`status.outOfTheme`). It brings every ready picture of the active
learner's language that isn't in the current theme into it: drawn before
themes (`theme` null), by another provider, or in an older theme.
- A word pointing at a stock concept that is drawn in the current theme is
  re-pointed at once (no call).
- The rest wait on the row (`restyle`): `check` when stock pictures are
  drawn, else `draw`. The background run asks the check about the `check`
  ones (one call per 20 words, on the judge ledger): a match points the
  word at the stock picture (no image call), anything else becomes `draw`.
  Each `draw` one is drawn again with the current provider and theme (in
  the image ledger, under the cap).
- **The old picture stays in place and in the game until the new one is
  stored**, so a child never meets a gap. Then the old file is deleted.
- A refusal leaves the word with its old picture; nothing retries it.
- **With no image key** (but some stock drawn), the check still runs: a
  word a stock picture fits is re-pointed; the rest are *not* marked to
  draw (they would wait for ever). They keep their pictures, stay counted
  in `outOfTheme`, and the status's `needKey` says how many only an image
  key can redraw; the bar says so.
- A swap during a game can't break a tile on screen: the game loads every
  round's pictures as blobs before the first round
  (`web/src/components/KidsGameView.tsx`), so deleting the old file
  afterwards changes nothing shown. Only a swap in the second or two of
  loading can make a round's picture fail to load; that round is left out
  rather than shown half. No delay before the delete was needed.
- With the fallback provider (OpenAI) in use, its own pictures
  (`<id>+openai`) count as current, so pressing again never loops over
  them.
- With no key and no stock drawn it is a 400 with the key sentence.

### The providers (read 2026-11-20 and 2026-11-21)

**Black Forest Labs, FLUX 3 Image Klein** (the default; `BFL_IMAGE` in
`web/server/imageProvider.ts`):
- `POST https://api.bfl.ai/v1/flux-3-image-klein`, key in the `x-key`
  header, body `{ prompt, resolution: "768sq", output_format: "jpeg",
  safety_tolerance: 0, seed: 7 }`. The body takes nothing else
  (`additionalProperties: false`); the other fields are `images`
  (references, not used), `aspect_ratio`, `width`/`height`, `steps`
  (1-16) and `user`. `output_format` is jpeg or png (no webp).
  `safety_tolerance` is 0-7, 0 the strictest, and stays 0: these are for
  children.
- The reply is `{ id, polling_url, cost }`, `cost` in credits (1 credit =
  $0.01). The `polling_url` is used as given (the docs say it must be), but
  the key is only ever sent to an https URL on `*.bfl.ai`; anything else is
  refused and nothing is sent there.
- **No redirect is ever followed** (`bflFetch`: `redirect: "error"` on the
  submit, every poll and the download). fetch drops `authorization` on a
  cross-site redirect but keeps a custom header like `x-key`, so following
  a 3xx from a bfl.ai host could hand the key to another server (PR #60
  review; a test redirects between two local servers).
- It is polled every 0.5 s with the key. Statuses: Task not found,
  Pending, Reasoning, Generating, Request Moderated, Content Moderated, No
  Card Generated, Ready, Error. Ready carries `result.sample`, a signed URL
  valid for about 10 minutes with no CORS: the server downloads it at once,
  without the key, capped at 4 MB and checked by its magic bytes. Only an
  https URL on `*.bfl.ai` is fetched (BFL's delivery hosts are
  `delivery.*.bfl.ai`; the host of the 2026-11-21 real draws wasn't
  recorded); anything else, an internal address included, is a failure
  with no request made.
- The whole draw (submit, polls, download) has 60 s (`BFL_TIMING`).
- 402 is out of credits, 429 is over the account's limit (24 tasks at once
  on most endpoints). Each gets a plain log line (the status and a fixed
  reason, never the body, which can quote the prompt) and the usual
  10-minute backoff. `GET /v1/credits` returns the balance; the app doesn't
  call it.
- Each picture logs the model and the credits billed, never the prompt or
  the key.
- **Measured 2026-11-21** with real calls: `cost` 0.8 credits, so **$0.008
  a picture**; Ready in 3-6 s; a 768x768 JPEG of 100-190 KB, a clean flat
  cartoon. (OpenAI's gpt-image-2.6-flare measured 824 output tokens, about
  $0.025 a picture.)
- Sources: https://docs.bfl.ml/api-reference/utility/generate-an-image-with-flux-3-klein,
  https://docs.bfl.ml/api-reference/utility/get-result,
  https://docs.bfl.ml/api_integration/integration_guidelines,
  https://docs.bfl.ml/api_integration/errors,
  https://docs.bfl.ml/api-reference/get-the-users-credits,
  https://docs.bfl.ml/quick_start/pricing, https://bfl.ai/pricing.

**OpenAI** (the fallback when only `OPENAI_API_KEY` is set): the OpenAI Images API, `POST https://api.openai.com/v1/images/generations`,
with these settings (`OPENAI_IMAGE` in `web/server/imageProvider.ts`; the
model is the one constant `IMAGE_MODEL`):

| Setting | Value |
|---|---|
| model | `gpt-image-2.6-flare` |
| size | `1024x1024` |
| quality | `low` |
| complexity | `low` |
| output_format | `webp` |
| output_compression | 70 |
| background | `auto` |
| moderation | `auto` |

Why that model:
- OpenAI's deprecations page lists `gpt-image-1-mini`, `gpt-image-1.5` and
  `chatgpt-image-latest` as shutting down on Dec 1, 2026 (announced Jun 2,
  2026), and `gpt-image-2` on Feb 10, 2027. Each names
  `gpt-image-2.6-sunburst` or `gpt-image-2.6-flare` as its replacement.
- `gpt-image-1` was shut down on 2026-10-23.
- The guide describes Flare as the one "for fast, high-quality everyday
  image generation"; Sunburst is for precise edits.
- Both cost the same: $30 per 1M image output tokens and $5 per 1M text
  input tokens.

Why those settings:
- **complexity `low`:** it sets planning compute. The guide's 2.6 section
  takes low, medium or high, with high as the default. A plain cartoon
  doesn't need more. No doc page explicitly confirms it on
  `/v1/images/generations` for gpt-image-2.6-flare; the first real draw
  settles it. A refusal shows in the server log as `OpenAI answered 400
  <type> <code> param=<name>` (never the prompt). If that happens, drop
  `complexity` from `OPENAI_IMAGE`.
- **quality `low`:** the reference lists low/medium/high/auto for GPT image
  models (xhigh and max only for gpt-image-2.5).
- **size:** 1024x1024 is the recommended square. Smaller sizes are below
  the 655,360-pixel minimum.
- **background `auto`:** the reference confirms opaque and transparent only
  for gpt-image-2.5 and gpt-image-2, not 2.6.
- **moderation `auto`:** the stricter of auto and low.

What comes back:
- The reply is always `b64_json`.
- A refusal is `error.code: "moderation_blocked"` (`image_generation_user_error`).
- The tokens billed for each image (`usage.output_tokens`) are logged, with
  no prompt and no key in the line.

**OpenAI's cost.** The estimate before the first real draw was about $0.007
a picture (gpt-image-2's listed $0.006 for a low-quality 1024² image at the
same $30 per 1M output tokens). The first real draw measured 824 output
tokens: about **$0.025 a picture**, three times Black Forest Labs'. At the
cap of 200 that would be about $5 per kids language a day. The Haiku
checks run on the Claude Code login.

Sources:
- https://developers.openai.com/api/docs/deprecations
- https://developers.openai.com/api/reference/resources/images
- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/docs/pricing

### The game

Routes are in `web/server/pictures.ts`, all mounted with wrap's `learner:
true`, for kids and adult learners (before ld-318 adults got a 403):

- `GET /api/game` returns the status (`pictured`, `ready`, `drawing`,
  `waiting`, `limited`, `problem`, `audio`). It starts nothing.
- `POST /api/game/start` returns up to 8 rounds (`gameRounds`):
  - The rounds are built only from `ready` pictures whose key is current.
  - What a game holds (ld-wx6; it used to play every due card first, and
    FSRS makes a word due again ten minutes after its first right answer,
    so each game was the last one over again):
    - reviews, at most half the rounds while there are new words: a word
      just missed first, then due cards, the most overdue first;
    - new words: the learner's own (starred and recent first), then the
      shared pool's;
    - then whatever fills the game: reviews past the half, words
      **resting** (answered right in the last 12 hours, `GAME_REST_MS`,
      due or not), and the rest, soonest due first. A small bank still
      gives a full game.
    - A miss is told from FSRS's own marks (due within 5 minutes of the
      answer, or relearning). FSRS's schedule itself is untouched: the
      listen card is shared with the other drills.
  - The chosen rounds are put in an order new for every game (`shuffle`,
    a random value the server makes at start); which words are chosen
    never depends on it.
  - With fewer than 3 pictured words there is no game. The child sees a
    friendly "pictures are being drawn" state, with nothing to fail at, and
    a note for grown-ups.
  - Each round has 2–4 pictures, with distractors drawn by a seed from the
    phrase and card version (`roundChoices`). Words with the same meaning
    are never distractors.
- `POST /api/game/answer` takes `{phraseId, version, revision, submitId,
  pictureId}`:
  - The server checks the tap against its own seeded draw.
  - The tap is a quiet review of the word's `listen` card through
    `recordAnswer`: drill `picture`, rating 3 when right and 1 when wrong.
  - The lock order is phrase then card. A resend with the same submit id
    replays. A stale version or revision, or a picture not on offer, is a
    409.
- `GET /api/game/audio/:phraseId` is Practice's phrase audio and its cache.
- `GET /api/game/pictures/:id/:file` serves only the session's own learner
  and language. Its headers are `Cache-Control: private, max-age=31536000,
  immutable`, `Vary: Cookie, X-Learner-Id, X-Language-Profile-Id` and
  `nosniff`.

The page (`web/src/components/KidsGameView.tsx`):
- It preloads every round's audio and pictures before round 1, behind
  Mochi's short loading state, so there is no spinner between rounds.
- The word auto-plays, and a big button replays it.
- Right: a cheer and a star, then on to the next round.
- Wrong: gentle. The right picture is shown, the word is replayed, and a
  Next button appears.
- About 8 rounds, then a row of stars.
- There is no score, no wrong count and nothing the child must read.
  `prefers-reduced-motion` switches off the pop and cheer animations.

The grown-up's side (`web/src/components/WordPictures.tsx`, in the
Library's Phrase bank, never in the game):
- a status line with **Draw pictures**, and **Redraw all in the current
  style** while any picture is out of the theme. It reads its counts again after
  any picture action in a word's detail and after a word is deleted;
- in each word's detail, its picture, what it was drawn as, **Remove
  picture** and **Draw again**;
- for a word judged "no clear picture" (`none`), **Draw it anyway** with an
  optional box for what the picture should show.

Routes for it:
- `GET /api/pictures`
- `POST /api/pictures/fill`
- `GET /api/pictures/phrase/:id`
- `POST /api/pictures/phrase/:id/remove|redraw`
- `POST /api/pictures/phrase/:id/draw` with `{description?}`
- `POST /api/pictures/restyle` (Redraw all in the current style)
- `POST /api/pictures/recheck` (Check again for a shared picture)

**Draw it anyway** (bead `ld-of0`, no migration: the row goes from `none`
to `pending` with a description, which the checks already allow):
- It works only on a `none` row for the word as it is now. Anything else is
  a 409 (a failed or removed picture has Draw again).
- The description is what the grown-up typed. With nothing typed, it is
  the word's meaning.
- It goes through `cleanDescription` like the check's own
  (`grownUpDescription`, `scripts/pictures.mjs`): the same characters, the
  same caps of 12 words and 80 characters, cut at a word.
- A description with a learner's name in it is a 400 with a sentence that
  says so. Nothing is stored and nothing is sent. The same goes for one
  with nothing to draw ("a picture of").
- The word is then drawn by the usual run: the same background slot, the
  same ledger and the same daily cap. The names are checked again just
  before drawing.
- A refusal from the provider ends as `failed`, as for any word. Nothing
  retries it; the grown-up can press Draw again.
- If the word is edited later it is judged again from scratch, and may be
  `none` again.
- Pressed during the 10-minute backoff after a failed run, Draw it anyway
  (like Draw again) still answers `pending`, but no run starts. The word is
  drawn by the first trigger after the backoff ends. The word's detail
  re-reads its picture for only 60 seconds, so it goes from "Being drawn…"
  back to "Waiting to be drawn" and shows the picture when reopened later.

**Who can reach them.** "From the adult side" means the Library's Phrase
bank, not a separate login. The child's page shares the grown-up's login
session (one account, with the kids learner picked), so a kids learner's
page can reach the Phrase bank's picture actions (Draw pictures, Remove
picture, Draw again, Draw it anyway) like the rest of the kids Library. The game itself has
no such buttons.

Draw again and Redraw all are held to the daily ledger and cap like any
other drawing, so repeated presses can't spend more than the 200 images a
day.

**No review before showing.** Pictures are shown to the child without a
grown-up's review first; the user chose this. The controls come after the
fact:
- the fixed safe style and the provider's moderation;
- removal from the Phrase bank, which takes a picture out of the game at
  once and deletes its file (a stock picture's file is shared and stays).

A picture the grown-up asked for with Draw it anyway is shown the same way,
with the same controls.

### The game for adults, and the picture library (ld-318)

**Pictures mode.** The adult Practice mode picker has **Pictures** ("Hear
a word, pick its picture"); Mixed never includes it. It is
`web/src/components/PictureGameView.tsx` on the same routes and rules as
the kids game:
- the home shows words with pictures, words waiting, and the day's
  pictures against the cap (`imagesToday`, `imagesCap` in the status);
- with fewer than 3 pictured words, a plain explanation and **Draw
  pictures** (`POST /api/pictures/fill`);
- a round shows progress `n / total` with a bar and End like the other
  adult modes, the word plays, and after the tap Correct / Not quite with
  the word and its meaning: `POST /api/game/answer` adds `word: {text,
  meaning}` only when `learnerMode` is adult (a kids reply never has it, so
  the child's game still shows nothing to read);
- the summary is "X of Y picked right" and the missed words.

An adult session's end queues picture work like a kids one
(`picturesAfterSession`), under the same per-language ledger and the daily
cap of 200 images; stock matches are free. The Phrase bank's picture
actions show for adults too.

**Picture library page** (`web/src/components/PictureLibraryView.tsx`,
the menu's **Picture library**, tab `pictures`):
- **My word pictures**: every current word picture of the active language
  (`GET /api/pictures/words`, newest first, through `forLanguageProfile`),
  filterable by status (ready, stock, being drawn, no picture, failed,
  removed) with counts; each word opens its usual actions (Remove picture,
  Draw again, Draw it anyway); the status line with Draw pictures and
  Redraw all; and the day's usage against the cap.
- **Shared library**: the merged stock set by category, browsed by
  everyone. An admin also gets Draw / Redraw per picture, Delete on an
  added one, **Draw all missing** (a confirm with the count and the
  estimated cost) and **Add a picture**. A non-admin sees "Only an admin
  can change this set" and no buttons (the server is a 403 regardless).

**Kids.** The kids menu has no Picture library, and a kids learner's tab
shows a note pointing at the Library. The routes are not kids-gated: a
kids learner's session (the grown-up's login with the kids learner picked)
still reaches `GET /api/pictures/words` and `GET /api/stock-pictures`, as
it reaches the Phrase bank's picture actions.

Tests:
- `scripts/tests/pictures-library.http.test.mjs`: the adult game, My word
  pictures, the stock routes (admin only writes, the ledger and cap, added
  concepts merged and checked, file concepts not deletable, a redraw's new
  URL, the Adults only toggle both ways on file, added and shadowed
  concepts, its 403 and failing closed).
- `scripts/tests/db-migration-0018.test.mjs`: migration
  `0018_stock_adults` (`picture_stock_adults`; ld-cvd).
- `scripts/tests/db-migration-0013.test.mjs`: the migration.
- `scripts/tests/db-migration-0014.test.mjs`: migration
  `0014_phrase_reading` (`phrases.reading`, one nullable text column, no
  default, no rewrite; ld-op2).
- `scripts/tests/pictures.test.mjs`: the pure rules, the theme, the stock
  list and the stock files.
- `scripts/tests/pictures.http.test.mjs`: the HTTP side, with OpenAI and
  claude stubbed.
- `scripts/tests/pictures-bfl-stock.http.test.mjs`: Black Forest Labs
  (stubbed), stock matching, Redraw all.
- `scripts/tests/picture-stock.test.mjs`: the stock CLI and functions.
- `scripts/tests/db-migration-0011.test.mjs` and
  `scripts/tests/db-migration-0012.test.mjs`: the migrations.

### The shared picture pool (ld-ec9, migration 0020)

Every picture the install has is in every learner's picture game, kids
and adults, in every target language, with the word in that learner's
language. A brand-new learner, or a new language, has a game at once.

**The pool.** The pool is the drawn stock set: `content/pictures.yaml`,
the concepts an admin added, and every learner's own drawing shared into
it. A shared drawing is a `picture_stock_concepts` row with `origin =
'drawing'`, so the stock rules apply unchanged: the serving route, the
look-alike groups, Adults only, the Picture library, and matching
another learner's word to it (no image call). Code: pure rules in
`scripts/picture-pool.mjs`, queries in `scripts/db/picturePool.ts`, the
server in `web/server/picturePool.ts`, the game in
`web/server/pictures.ts` (`gameWords`).

**Sharing** (`shareDrawings`) runs at the end of each language's picture
run: a session's end, Draw pictures, or a game's start. A poll, a count
or a page load never runs it. That language's own ready drawings in the
current theme are shared once per file:
- The file is copied to `<images>/stock/<theme>/drawn-<16 hex>.<ext>`.
  The id is from the file's hash, `sharedConceptId`.
- The concept gets category "Drawn by learners", the cleaned
  description, and the word's meaning as its English word.
- The owner's own word is stored at once under its locale's key.
- A drawing is **never shared** when its description, word or meaning
  names any learner on the install (`allLearnerNames`, the same
  accent-folded match as `cleanDescription`; `namesALearner`).
- A stock pointer is never shared again.
- A learner is never offered their own shared drawing back as stock
  (`stockOffer(mode, rows)`).

**Unsharing.** Remove picture and Draw again unshare a drawing
(`unshareFile`): the concept, its pool words and its stock copy go. This
is so a picture a grown-up took away isn't still shown to everyone else.
Deleting the phrase does not unshare: the copy stays in the pool. An
admin can delete a shared concept from the Shared library like any added
one; its pool words go with it, and its source file is written to
`picture_shared_refused` so it is never shared again (`sharedFiles` and
`shareDrawing` skip it): the owner's picture is still ready, and without
that their next picture run would bring it back under the same id, with
any Adults only flag lost. A redraw is a new file, and may be shared.

**Kids.** A shared drawing reaches kids only when
`picture_stock_concepts.kids_safe` is true. `mergeStock` treats anything
else as Adults only. Where the verdict comes from:
- Since 0020, the picturable check also answers `"kidsSafe"` per word.
  The answer is stored in `phrase_pictures.kids_safe` (`storeVerdict`).
- A kids learner's drawing is shared with its verdict, or true when it
  has none.
- An adult's drawing is shared with its verdict, or null when it has none.
- A null (a drawing judged before 0020) is asked by one **kids check**
  (`kidsCheckPrompt`, tool-less Haiku, `KIDS_CHECK_BATCH` = 20 a call) in
  the owner's background slot. The check is written to the owner
  language's `picture_calls` as a `judge` row when it starts, under
  `PICTURE_DAILY_JUDGES`. Its verdict is stored once, only where it was
  null (`setDrawingKidsSafe`).
- The admin can't clear Adults only on a drawing that hasn't passed the
  check (409).

The rules that already held still hold:
- Adults-only concepts never reach kids (`stockForMode`).
- A round never shows two of one meaning, one file, or one look-alike
  group.

**Words per language.** Each concept has one word per pool key:
- the 17 base keys (`POOL_LANGS`: `en es fr de it pt nl sv ru el ar hi ja
  ko zh-CN zh-TW zh-HK`; zh-CN is simplified Mandarin, zh-TW traditional
  Mandarin, zh-HK Cantonese, kept separate);
- optional regional variants (`POOL_VARIANTS`, e.g. `es-ES`, `pt-PT`,
  `en-GB`), set only where the common word differs.

A locale finds its word through `wordFor`: the variant first, then its
key (`poolKey`; any other `zh-*` reads zh-CN). Cantonese never borrows
the Mandarin word. A word must be plain and in its language's script
(`checkPoolWord`): at most 40 characters, no slash or bracket, no space
in Chinese, and no learner's name.

Where the words come from:
- **Stock concepts:** `content/picture-words.yaml`, the reviewed table
  (docs/CONTENT.md §`content/picture-words.yaml`), one line per concept with its level and
  words. It was drafted by `npm run pictures:words` (a local tool-less
  `claude -p`, Opus, 12 concepts a call; existing words always win; `--dry-run`,
  `--limit`) and reviewed by hand. `loadContent` warns about a concept
  missing a word. The table always wins over a stored word.
- **Drawings and added concepts the table lacks:** the **naming call**
  (`fillPoolWords`). It is one install-wide run at a time, tool-less
  Haiku, `POOL_WORDS_BATCH` = 8 concepts a call, in the triggering
  user's background slot. Each call is written to `picture_pool_calls`
  as it starts. The cap is `POOL_DAILY_CALLS` = 20 calls in any 24 hours,
  install-wide, counted again inside the slot. A failed call counts. A
  concept is tried at most twice a process, and a failed run waits 10
  minutes. The reply is checked like the table (`parsePoolWordsReply`),
  and each word and level is stored once (`picture_pool_words`,
  `picture_pool_levels`, on conflict do nothing).

The pool is triggered by a game's start and by sharing. A concept with no
word for a learner's language is simply not in their pool yet.

**Levels.** Every concept has a CEFR level: A1, A2, B1 or B2. Stock
levels are in the table (per concept), and a drawing's level comes from
the naming call, stored once.
- By default a learner's game offers pool words at or below their level
  (`levelCap`). An adult's Pre-A1 counts as A1, and C1 or C2 as B2. A
  kids learner gets A1 for First words and Getting going, and A2 for
  Chatty.
- The adult Pictures home has **Pool words: up to A1 / A2 / B1 / B2**
  (shown when the pool reaches past the default). It sends `{ level }`
  with `POST /api/game/start`; any other value is a 400.
- The kids game has no picker, and a `level` a kids learner sends is
  ignored: the start, the answer, audio and pictures all use their own
  cap.
- The learner's own words are always in, whatever their level.
- An adult's answers, audio and picture fetches look a pool word up at
  B2, since a round may have been drawn at any level.

**What the game plays** (`gameWords`): the learner's own pictured words,
then the pool's words for their language up to the level.
- A pool word whose text is already a word of theirs (by `normKey`),
  or dismissed, or whose concept one of their words already points at,
  is left out. So is a second concept with the same word, and a concept
  whose pool id is already one of their phrases (a pool word they
  adopted and edited since keeps that id: `ownPoolIds`, `ownIds`).
- Order (`gameRounds`, §Kids word game): reviews (at most half), then
  their own new words, then pool words (the easier level first, in an
  order drawn from a seed of the language and the day), then the fill.
  At most `GAME_ROUNDS` = 8, shuffled per game.
- A kids learner of Mandarin gets a pool word only when its reading is
  settled (`settledForKids`), as for their own words.
- The status adds `pool`, `poolLevel` and `poolByLevel`. The game is
  ready with 3 pictured words, own and pool together.

**Progress.** Pool words are virtual: each has a deterministic id per
language profile (`poolId`, a v5-layout uuid of the profile and the
concept). Nothing is stored for a word that is never played. On the
**first answer** (`adoptPoolWord`), the word becomes a bank phrase with
`source = 'picture'` (unstarred, no target), and its `phrase_pictures`
row points at the stock picture with the same id the round showed. The
answer is then recorded like any other: a quiet `listen` review on the
FSRS card. A resend replays. After that it is the learner's word (counted
as theirs, out of the pool), with its flashcards like any bank word. The
Phrase bank names the source "the picture game's shared pictures". An
adult's bank gets only the words they actually played.
A tap on a pool word the pool no longer gives this learner (they added
the same words themselves since the round was drawn, or it left the
pool) is a stale round, a 409 with nothing recorded, never an answer to
another phrase; so is an adoption that finds the words already in the
bank.

**Audio and pictures.**
- A pool word's sound is `wordClip`: the native default voice, as for
  phrases (`outsideClip`), disk-cached per user. The game preloads its
  rounds as before, so there are at most `GAME_ROUNDS` new clips a game
  and none on a replay.
- A pool picture is served by `GET /api/game/pictures/:id/:file` with
  the learner's own session only: the id must be a pool id of that
  learner's language and mode (a 20-second cache, `poolPicture`). A kids
  learner gets a 404 for an adults-only one, even by a guessed id.

**Tables (migration `0020_picture_pool`).** Plain CREATE TABLE and ALTER
TABLE ADD COLUMN / ADD CONSTRAINT, valid on PostgreSQL 17:
- `phrases_source` adds `'picture'`.
- `phrase_pictures.kids_safe boolean` (null: not asked).
- `picture_stock_concepts` adds:
  - `origin text not null default 'admin'`;
  - `source_file text unique`;
  - `kids_safe boolean`;
  - the check `picture_stock_concepts_origin`: an admin's concept has
    neither a source file nor a kids verdict; a drawing has a 64-hex
    source file.
- `picture_pool_words (concept_id, key, text, created_at)`, primary key
  (concept, key), checked id, key (`xx` or `xx-YY`) and 1–40 characters.
- `picture_pool_levels (concept_id primary key, level in A1–B2)`.
- `picture_pool_calls (id, user_id → users set null, concepts > 0,
  outcome ok | failed | null, created_at indexed)`: the naming ledger.
- `picture_shared_refused (source_file primary key, 64 hex; refused_by
  → users set null; created_at)`: drawings an admin removed from the pool.

Tests:
- `scripts/tests/picture-pool.test.mjs`: the pure rules. Levels and the
  default cap, keys and scripts, the content table complete and clean,
  the naming reply, the pool's level filter (a beginner never gets a B1
  or B2 word; the cap widens it), own words first and in whatever their
  level, round rules with groups, which drawings may be shared, and the
  kids gating.
- `scripts/tests/picture-pool.http.test.mjs`: end to end.
  - A new kids learner's pool is non-empty.
  - Adoption and replay.
  - The level picker and its 400.
  - A user's Spanish drawing reaches another user's German adult with
    the named word, and another user's kid.
  - Kids never get an unchecked or unsafe adult drawing; the check runs
    on the judge ledger and stops at its cap.
  - A name-bearing drawing is never shared.
  - Remove unshares; an admin's removal stays (never re-shared).
  - An adopted word edited and drawn again never comes back into the
    pool under its id; a word added meanwhile is a stale round (409).
  - A kids learner's `level` is ignored.
  - The naming cap and ledger, and a failed call.
- `scripts/tests/db-migration-0020.test.mjs`: the migration.

## Mandarin readings (ld-4i2, migration 0015)

The learner's corrections of the reader and the install-wide shared list
(docs/VOICE.md §Uncertain readings for the behaviour). Migration
`0015_mandarin_readings` was generated, not hand-edited, and runs on
PostgreSQL 17.

```
reading_corrections   one learner's choice per word, per language profile
  learner_id, language_profile_id   (composite FK → language_profiles, cascade)
  key            the word's simplified spelling (zh.ts correctionKey)
  word           as it was written
  reading        space-separated pinyin with tone marks, one per character
  kind           corrected | confirmed | suggested
  source         user | recap
  created_at, updated_at
  PK (language_profile_id, key)
  check by_hand: a correction is a person's (source user), never a recap's
shared_readings       install-wide; no personal data but the two user ids
  id, key, word, reading
  scope          all | tw (a reading only Taiwan uses)
  status         active | suggested
  source         admin | user | recap (who first suggested it)
  by_user, by_recap   a learner, and a recap, suggested this reading
  suggested_by, confirmed_by   users, ON DELETE SET NULL (admin view only;
                 a recap's suggestion names its session's owner)
  created_at, updated_at
  unique (key, scope, reading); one active row per (key, scope)
shared_reading_votes  (migration 0016, PR #67 review) who stands behind it
  shared_reading_id (→ shared_readings, cascade), user_id (→ users, cascade)
  source         user | recap (a recap: its conversation owner's vote)
  created_at     (indexed with user_id: the daily cap)
  PK (shared_reading_id, user_id): one vote per user per entry
shared_reading_uses   the admin view's 30-day count
  conversation_id PK (→ conversations, cascade), changed, counted_at
```

The rules:
- **Who reads and writes what.**
  - `reading_corrections` goes through `forLanguageProfile`
    (`scripts/db/readings.ts`).
  - A recap writes only `suggested` or `confirmed` rows, and only over its
    own (`saveRecapReading`): a person's choice always stands.
  - Every query on the shared list is in `scripts/db/sharedReadings.ts`.
- **When a shared entry is active** (`propose`, `confirm`, `remove`).
  - An admin's correction is active at once, and demotes the active row
    for the same word and scope.
  - A learner's correction or confirmation, and a recap's answer, is a
    vote of one user (the recap's: its conversation owner's; a kids
    session's recap casts none). With votes from two different users who
    are not disabled, at least one by hand (`source` user), and nothing
    active for that word, it becomes active: two recaps alone never do.
    A learner and the recap of their own session are one vote; their hand
    choice after it turns that vote's source to user.
  - An admin's confirm activates it.
  - A user adds at most 50 votes in 24 hours (`MAX_DAILY_VOTES`, counted
    after locking the user's row, so concurrent votes can't pass it;
    `SharedLimitError`: their own correction is kept, nothing shared, the
    reply's `shared` is `limited`).
  - A vote for a row already active changes nothing on it (`updated_at`
    is the active list's version).
  - The list holds at most 20,000 rows (`SharedFullError`).
- **What reaches the browser.**
  - The active list goes to any logged-in user (`activeList`; versioned
    as count.max-updated, with an ETag).
  - The admin view adds usernames.
  - The export (`exportActive`, YAML or JSON) has only word, reading and
    scope.
- **Phrases.** A correction or a recap's suggestion rereads the bank
  phrases of that language profile that hold the word, and sets
  `phrases.reading` where it changed (§Phrase bank, migration 0014).
- **Tests.**
  - `scripts/tests/db-migration-0015.test.mjs` and
    `scripts/tests/db-migration-0016.test.mjs`: the migrations.
  - `scripts/tests/readings.http.test.mjs`: the routes and the shared
    list's paths.
  - `scripts/tests/recap-readings.http.test.mjs`: the recap's writes.

### Kids: resolving uncertain readings (ld-0mn, migration 0017)

A kids learner's uncertain readings are settled, not only marked
(docs/VOICE.md §Kids: marks and resolving). Migration
`0017_kids_reading_checks` was generated, not hand-edited: a plain
CREATE TABLE and its index, and a nullable column with a check on
`reading_corrections`; nothing PostgreSQL 18 only.

```
reading_check_calls   the ledger of a kids session's background reading checks
  id, learner_id, language_profile_id   (composite FK → language_profiles, cascade)
  words          how many words the call asked about (> 0)
  settled        how many answers passed the checks and were stored; null
                 while it runs or when it got no reply
  created_at     (indexed with language_profile_id: the daily cap)
reading_corrections.checked_by   session | recap: which model call settled a
                 `recap` row; null for a hand choice (cleared when one
                 replaces it) and for rows from before 0017
```

The rules:
- A row is written **as each call starts**, so the cap
  (`READING_CHECK_DAILY`, 20 calls per language profile in 24 hours) counts
  every call made, a failed one too, and survives a restart. Rows older
  than two days are pruned as a new one is written. Words and readings are
  never here; queries only in `scripts/db/readingChecks.ts`, through
  `forLanguageProfile`.
- An accepted answer goes to `reading_corrections` as a recap's does
  (`saveRecapReading`: source `recap`, never over a hand choice) and casts
  **no shared vote**. For a kids learner it is stored `confirmed`, agreeing
  or not, so it settles the word, with `checked_by`; for an adult, nothing
  changed. Older kids `suggested` rows stay suggestions (still waiting).
  The grown-up sees these rows (`checked` in `GET /api/readings/waiting`)
  and may remove one (`POST /api/readings/back`, `removeRecapReading`:
  source `recap` only).
- A kids learner's word still uncertain (with that learner's corrections
  and the shared list) is kept out of the picture game's rounds, answers,
  status and the bank's picture filter (`settledForKids`), and listed by
  `GET /api/readings/waiting`. Its `phrase_pictures` row is drawn as
  usual.
- A kids learner's grown-up may write `reading_corrections` by hand
  (`POST /api/readings`, no longer a 403): that learner's own, with no
  shared vote, even on an admin's login.
- Tests: `scripts/tests/db-migration-0017.test.mjs`,
  `scripts/tests/kids-readings.http.test.mjs`.

## Pronunciation in sessions (ld-ne0.3, migration 0022)

Stage 2 of pronunciation feedback (docs/VOICE.md §Pronunciation in
conversation): an adult Mandarin Go-tab turn's tone check is kept with the
turn, and a flagged turn's recording is kept on this Mac.

Only tone checks are kept. A live word check in another language
(ld-ne0.17, docs/VOICE.md §Words in conversation) stores nothing: no row
here, no clip. The table's `syllables` are tone-shaped and feed the recap's
Tones section and the tone trend; word marks would need their own shape.

**`pronunciation_checks`**, one row per scored learner turn:

| column | |
|---|---|
| `id` | uuid; also the clip's file name |
| `learner_id`, `language_profile_id` | owners; (language_profile_id, learner_id) → language_profiles, cascade |
| `conversation_id` | → conversations (id, language_profile_id), cascade |
| `turn_id` | the learner turn scored; → turns (id, language_profile_id), cascade; unique |
| `engine` | `azure` or `local` |
| `coaching` | the dial as the turn was sent: `light` or `strict` (`off` is never scored) |
| `syllables` | jsonb, per syllable: `char`, `pinyin`, `expectedTone`, `accept`, `verdict` (the live bar applied: `ok`, `off`, `unsure`), `heardTone` (on ok and off), `reason` (on unsure, `live_bar` for an engine miss below the bar), `margin`, `confidence`, `startMs`, `endMs` |
| `flagged` | how many syllables passed the live bar |
| `clip_file`, `clip_bytes`, `clip_ms` | the kept clip, all three or none; only with `flagged > 0`; the file name a uuid plus `.wav` (a CHECK) |
| `created_at` | |

Indexes: by conversation (the cap, the delete) and by (language, time)
(stage 3's trend). No row-level security: the content agent's reader never
reads it. Queries only in `scripts/db/pronunciation.ts`, through
`forLanguageProfile`.

- **Written inside the turn's transaction** (`saveTurn`, `recordCheck`),
  on the learner row the write inserted for the message, so a check exists
  only for a stored turn. A learner row is never rewritten (planTurnWrite
  drops at most a final master reply), so a check stays with its turn; the
  cascades cover any later change.
- **Clips**: `<LINGO_CLIPS_DIR or <data dir>/clips>/<conversation>/<check
  id>.wav` (`scripts/pronunciation-clips.mjs`): 0600 files in 0700 folders,
  written atomically before the transaction and kept only if the row keeps
  them. **At most `MAX_CLIPS_PER_CONVERSATION` (20) per conversation**,
  counted under the conversation row's FOR UPDATE lock: each is one turn of
  at most 30 s of 16 kHz mono (under 1 MB), so a session keeps under 20 MB.
  Past the cap a flagged turn keeps its row without audio, and the file
  written for it is removed at once, as it is when the turn isn't saved.
  Only a flagged turn's audio is ever offered; every other recording lives
  only in memory (at most 2 minutes, one per learner) and goes.
- **Served** by `GET /api/pronunciation/clips/:id` (`wrap`, `learner:
  true`): the check must be the active language's (`clipOf`) and keep a
  file; anything else is the same 404. `Cache-Control: private,
  no-store`. The recap's Tones section plays them (stage 3: a flagged
  syllable's stretch, or the whole line); the Go tab plays the take it
  holds in memory.
- **Deleted with the conversation**: the rows by cascade, the folder by
  `DELETE /api/conversations/:id` (a failure to remove it is logged, never
  the learner's). The app has no learner or language delete; a database
  restore without the folder just has rows whose clips 404.
- **Kids: nothing is stored**, no row and no clip, a privacy-conservative
  default for children's voices. Their turns are still scored for the
  dojo master's gentle rule (and may go to Azure, the owner's stage 1
  decision). If the owner wants kids' checks for a grown-up's view later,
  storing the row (not the audio) is a one-line change in
  `web/server/livePronunciation.ts` `takeLive`.
- **Read by stage 3** (ld-ne0.4, docs/VOICE.md §Tones after the session;
  no migration): the recap's Tones section (`sessionChecks`: a
  conversation's rows joined to their learner turns' text, both tables
  through the language's scope, and the previous attempt's through
  `toneConversation`) and the per-tone trend (`trendChecks`: the
  (language, time) index, newest first, at most `TREND_MAX_ROWS`), counted
  in `scripts/pronunciation-review.mjs`. Neither writes anything. The
  recap's tone misses (ld-ne0.18) read the same rows (`sessionChecks`) and
  write only the bank's session reviews (§Post-session extraction).
- **Practice speak-it's tone miss** (stage 3) is kept on its review, not
  here: `reviews.card_before.tone_miss` `{ rating, verdict, syllables }`,
  beside `submit_id` (docs/DATA.md's practice extras), the grade the words
  had before a flag at the live bar made the answer a miss. Read back as
  the reply's `toneMiss`; the override restores `rating`. No column, no
  migration: the verdict stays `wrong` (the CHECK's own word). Settling a
  doubtful flag, at answer time, reads the learner's hand-made
  `reading_corrections` and the active `shared_readings` for words with no
  hand choice (scope `tw` only in a zh-TW language, `all` otherwise) (`settleHeld` in toneReview.ts, through `listCorrections` and
  `activeList`), only when a flag is in doubt; `phrases.reading` (recap or
  GLOSS) settles nothing. The rule is deliberately narrow (docs/VOICE.md
  §Tones after the session): only a leading Han character (first, or after
  sentence punctuation; never 一 or 不), at its own
  citation tone and not before a third tone, with one reading tone or a
  settled reading (zh-TW: settled only), can fail an answer.
  Nothing is written.
- Tests: `scripts/tests/db-migration-0022.test.mjs` (the table, its
  checks, cascades), `scripts/tests/pronunciation-live.http.test.mjs`
  (written with the turn, the cap, served to its learner only, gone with
  the conversation, nothing for kids).
  ld-ne0.18: `scripts/tests/tone-recap.http.test.mjs`.
  Stage 3: `scripts/tests/pronunciation-review.test.mjs` (the counting,
  comparing, trend and tone-miss rules) and
  `scripts/tests/pronunciation-review.http.test.mjs` (the routes, another
  learner's or language's session and clip unreachable, kids nothing, the
  speak-it miss with its replay and override).

## Docs to update as phases land

- `PRD.md`: the "no database" decision, the non-goals (feedback loop; multi-user
  done in phase 1)
  and the architecture tree.
- `CLAUDE.md`: the no-database line; the `data/` description, the auth rule in
  `wrap()` and the test database rule (done in phase 1).
- `CONTENT.md`: the `recall` slot and `{{phrase_review}}` (done in phase 6),
  and packs living in the DB (done in phase 2).
- `VOICE.md`: "Nothing is saved" (done in phase 3), `LOOKUP:`, per-turn
  retrieval (done in phase 6); per-user settings (done in phase 1).

## Phases

| # | Phase | Needs |
|---|---|---|
| 0 | Postgres + Drizzle foundation: setup scripts, schema v1 (every table above), migrations, PGlite test harness, boot check. **Built** | none |
| 1 | Auth + learners: login, sessions, `wrap` auth levels, user CLI, learner picker, profile on DB, admin-only agent, per-user settings, first-run screen. **Built** | 0 |
| 2 | Packs in the DB + import: packs, revisions, folders, import script, drop the pack git commits. **Built** | 1 |
| 3 | Conversations: persist turns, End, the History view. **Built** | 1 |
| 3.5 | Language profiles (`ld-gf9.2`): several languages per learner, each with its own packs and History. **Built** | 2, 3 |
| 4 | Phrase bank (`ld-5p2`): per-language tables (migration 0003), gloss capture, scenario lists, star/add, the bank UI with metrics. **Built** | 3 |
| 5 | Session extraction (`ld-aeu`): claude pass, FSRS from sessions, the recap card. **Built** | 4 |
| 6 | Recall (`ld-mey`): the review block (slot, units, placeholder), per-turn retrieval, `LOOKUP`. **Built** (no migration) | 4 |
| 7 | Practice: tab and queue, the FSRS service, grader, flashcards (**built**: `ld-7p1`, see "As built (phase 7a)"), listening, speak-it, audio cache (**built**: `ld-6a0`, see "As built (phase 7b)"), cloze (**built**: `ld-7dr`, migration 0006, see "As built (phase 7c)"); a flashcard sentence's translation (`ld-r2x`, migration 0010) | 4 |
| 8 | Content agent bank MCP with the read-only role and RLS (`ld-t5f`, migration 0005). **Built** | 4 |
| 9 | Backups | 2 |
| 10 | Tailscale serve: allowed host, origin test (built); verify login and a voice turn from a second device (owner) | 1 |
| 11 | Session length: picker, Time budget section, per-turn clock, +5 min | none (can ship first) |
| 12 | Revisit (`ld-qxw`, migration 0008): History by scene, Practice again, building on the last attempt, the recap's comparison, the week card and daily digest. **Built** (see "Revisit") | 5, 6 |
| 13 | Hidden scenes (`ld-ke1`, migration 0009): hide library scenes and folders per language, left out of the Scene tab and random draws. **Built** (see "Hidden scenes") | 2 |

Phases 5–8 can run in parallel once 4 lands.

## Open questions

These are proposals, made without asking:

- Three cards per phrase, with mastery taken from the weakest card.
- Listening defaults to multiple choice.
- Kids are left out of the practice modes in v1.
- PGlite for tests (built and working; see Testing).
- scrypt over argon2.
- An auto-end after 2 hours (built: lazy, at the last turn).
- Daily limits of 20 new and 100 reviews.
- Practice and History placement in the UI.
