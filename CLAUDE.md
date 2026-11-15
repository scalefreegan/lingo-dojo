# Lingo Dojo — agent instructions

Composable prompt-pack builder for language-practice sessions with a voice "dojo
master". A few people with logins on one Mac (localhost; the tailnet later). The
library is markdown and YAML under `content/`, tracked by git. Read `docs/PRD.md`
first, then `docs/CONTENT.md` (the file-format contract) before touching content
or the loader.

Personal data is moving to Postgres (logins, learners, packs, conversations,
the phrase bank); `docs/DATA.md` is its contract. Built so far: the foundation
(phase 0), logins + learners (phase 1): users, sessions, learners (the
profile the app uses), per-user voice settings, model and agent chat;
saved packs (phase 2): each learner's own rows, with revisions and soft
deletes instead of git commits (`scripts/db/packs.ts`); saved
conversations (phase 3: every voice session's turns, the Library's
History; `web/server/conversations.ts`); the phrase bank (phase 4: one
per language profile, filled by each turn's glosses, the scene's lists and
☆ Star, shown in the Library's Phrase bank; `scripts/db/phrases.ts`,
`web/server/phrases.ts`, pure rules in `scripts/phrases.mjs`); and the
Practice tab's flashcards (phase 7a, hidden for kids: queue and grading
rules in `scripts/practice.mjs`, queries in `scripts/db/practice.ts`, the
routes and the tool-less Haiku grader in `web/server/practice.ts`, the page
`web/src/components/PracticeView.tsx`). A practice answer locks its phrase
then its card; it names the card's version, the phrase's revision and a
submit id (a resend replays, anything else stale is a 409).

## Patterns to copy, not reinvent
- Sibling apps: `../travel-guide` (Atlas, closest: `web/server/api.ts` same-origin
  `wrap()`, `scripts/claude.mjs`, SSE chat, `macos/` Dock app) and `../wine-guide`
  (`web/src/components/ChatPanel.tsx`, `web/.oxlintrc.json`).
- Port **38400**, `strictPort`, `usePolling` watcher (FSEvents is unreliable on this
  machine). Atlas is 38300, Wine Guide 38200, Basecamp 38100.
- Every API route goes through `wrap(fn, { auth })` (`web/server/api.ts`): the
  same-origin check, then the session, then the access level. No exceptions.
  `auth` is `"public"` (only `/api/auth/login`, `/me`, `/first-run` and the
  `/api` 404), `"user"` (the default: no session → 401) or `"admin"` (the
  content agent and its settings, and adding a Voice Library voice to the
  owner's ElevenLabs account: non-admin → 403). A route that acts for the active learner also takes `learner: true`: the
  client's `X-Learner-Id` and `X-Language-Profile-Id` must be the session's
  learner and language, else 409 `stale_learner`.
  The handler gets `ctx = { user, learner, language, sessionId }` (`language`
  is the active language profile: a learner practises one or more); take the
  mode from `learnerMode(req, ctx)`, never from the request alone. Only an
  `HttpError`'s message reaches the client; anything else is a generic 500.
  Accounts come from `npm run user -- add <name> [--admin] | passwd | list |
  disable | enable`; the app's only sign-up is the first-run screen while
  there are no users.
- The embedded agent spawns headless `claude -p` with your Claude Code login (no
  API key). It may Read the repo and Write/Edit **only under `content/`**. After
  every agent turn the server commits any `content/` change (`agent: <summary>`)
  so it can be reverted with git. Agents never touch `web/`, `scripts/`, or `.beads/`.
- Voice practice (Go tab) is a push-to-talk loop: `/api/voice/*` in
  `web/server/voice.ts`, pure helpers in `scripts/voice.mjs`; see `docs/VOICE.md`.
  Provider keys live only in the gitignored repo-root `.env.local` and never
  reach the browser. Voice turns spawn `claude -p` with **no tools**.
- Database (docs/DATA.md): Drizzle schema in `scripts/db/schema.ts`, generated
  SQL in `scripts/db/migrations/` (commit it; edit the schema, then
  `npm run db:generate`). Never hand-edit a migration except through
  `scripts/db/hand-edits.mjs`; a test checks the SQL against the schema.
  Migrations are applied and checked by hash (`scripts/db/migrations.mjs`).
  `web/server/db.ts` holds the one lazy pg Pool; `DATABASE_URL` comes from
  `.env.local`, default `postgres://localhost/lingo_dojo`. Personal rows go
  through `forLearner()` / `forUser()` / `forLanguageProfile()`
  (`scripts/db/owned.ts`), never a bare query; account queries live in
  `scripts/db/accounts.ts`. The dev server
  refuses to start until `npm run db:setup` has run.
- **Branches and worktrees never point at the real database.** Set
  `DATABASE_URL` to a scratch database (a linked worktree with none set
  refuses to start or migrate). Add new migrations one branch at a time, never
  in parallel branches. Migration SQL must run on PostgreSQL 17 (the app's
  Homebrew server) even though the tests run on PGlite (PostgreSQL 18).
- Per-user state (agent chat history, model setting, voice settings) is in the
  database (`user_settings`, `agent_messages`; `web/server/store.ts`). The old
  `data/voice.json`, `data/settings.json` and `data/chat.jsonl` (gitignored)
  only seed the first admin, once, as do `content/profile.yaml` and
  `content/kids/profile.yaml` for their learners and `content/**/packs/` for
  their packs; the running app never reads or writes them after that.
  `npm run db:import` copies pack files added later into each learner's oldest
  language (idempotent per learner: a pack imported into any of its languages
  is never imported again). Saved packs
  are per language profile (a learner's language) in the database: no pack route writes YAML or commits;
  undo is `pack_revisions` (`/api/pack-revisions`). `loadContent` no longer
  reads pack files; `loadPackFiles` does (import, first run, export CLI).
  Owner scoping for packs lives only in `scripts/db/packs.ts`, through
  `forLanguageProfile` (`forLearner` refuses tables with `language_profile_id`). Exports go to `exports/`
  (gitignored). The phrase bank is per language profile too; its queries
  live only in `scripts/db/phrases.ts` (migration 0003, docs/DATA.md
  §Phrase bank).
- Loader and assembler (`scripts/content.mjs`, `scripts/assemble.mjs`) are pure ESM
  with no server imports, so `node --test` covers them directly.
- Two content trees, same format: `content/` (adult mode) and `content/kids/`
  (kids mode: own `schema.yaml`, `frame.md`, `profile.yaml`, `units/`,
  `scenarios/`, `packs/`; shares `languages.yaml`). `modeRoot(mode)` in
  `scripts/content.mjs` is the one place that maps a mode to a root. The mode
  is the active learner's (a learner is adult or kids; switching learner
  switches mode): the pack/folder/assemble/export/profile/voice routes use it
  and answer 400 to a `?mode=` (or body `mode`) that disagrees, 409
  `stale_learner` with no learner picked or a page showing another. `GET /api/content?mode=` still takes either (admins browse
  both libraries). Kids exports go to `exports/kids/`. The adult loader never descends into `kids/`.

## Work tracking
Beads: `bd ready` for unblocked work, `bd show <id>` for context, `bd close <id>`
when done. Prefix `ld`. File new work as beads, not TODO comments.

## Build & test
```sh
npm install && npm --prefix web install
npm run db:setup               # create the database if missing, apply migrations (idempotent)
npm run db:migrate             # apply pending migrations only
npm run db:generate            # after editing scripts/db/schema.ts: write the next migration
npm run dev                    # http://localhost:38400 (needs a current database)
npm test                       # node --test scripts/tests/*.test.mjs
npm --prefix web run lint      # oxlint
(cd web && npx tsc -b)
npm run export -- content/packs/<id>.yaml
npm run export -- content/kids/packs/<id>.yaml   # kids library → exports/kids/
npm run user -- add <name> [--admin]   # a login (also passwd | list | disable | enable); password prompted, or on stdin
npm run db:backup                # pg_dump -Fc of DATABASE_URL → backups/ (gitignored, 0600, newest 14 kept; LINGO_BACKUPS_DIR overrides); restore and the optional launchd job (npm run db:backup:plist -- <path>): docs/DATA.md §Backups
npm run db:import [-- --user <name>]   # pack files → that account's (default: first admin's) learners' oldest language; safe to re-run
```
Tests point the loader at fixtures via `LINGO_CONTENT_DIR` and `LINGO_EXPORTS_DIR`;
never write to the real `content/` or `exports/` from a test. Database tests use
`freshDb()` from `scripts/tests/testdb.mjs` (in-process PGlite with the real
migrations); a test never connects to the dev database or any Postgres server,
except the `*.pg.test.mjs` files when `LINGO_TEST_PG_URL` is set (each makes and
drops a throwaway database on that server; point it at a scratch one). A new
one makes it with `scripts/tests/pg-scratch.mjs` (the process id in the
name) and closes its pools before the drop, which is `WITH (FORCE)`.
HTTP tests mount the real plugin on one: `serveApi(apiPlugins, { db })`, then
log in with `scripts/tests/http-session.mjs` (`addUser`, `client().login()`,
`.pick()`); every route but the three public ones needs a session.

## Conventions
- TypeScript strict; `oxlint` (config copied from wine-guide).
- Comments explain *why*, at the density of wine-guide's server code.
- Secrets never in the repo. There are none expected in v1.
- Verify UI in the real app (Playwright MCP or Claude-in-Chrome) before claiming a
  feature works.
- Content files are the product. Keep unit bodies self-contained and written as
  instructions to the dojo master; see `docs/CONTENT.md`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
