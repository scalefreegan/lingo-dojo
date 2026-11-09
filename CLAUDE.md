# Lingo Dojo — agent instructions

Composable prompt-pack builder for language-practice sessions with a voice "dojo
master". Single user, localhost, no auth, **no database**: all content is markdown
and YAML under `content/`, tracked by git. Read `docs/PRD.md` first, then
`docs/CONTENT.md` (the file-format contract) before touching content or the loader.

## Patterns to copy, not reinvent
- Sibling apps: `../travel-guide` (Atlas, closest: `web/server/api.ts` same-origin
  `wrap()`, `scripts/claude.mjs`, SSE chat, `macos/` Dock app) and `../wine-guide`
  (`web/src/components/ChatPanel.tsx`, `web/.oxlintrc.json`).
- Port **38400**, `strictPort`, `usePolling` watcher (FSEvents is unreliable on this
  machine). Atlas is 38300, Wine Guide 38200, Basecamp 38100.
- Every API route goes through `wrap()` with the same-origin check. No exceptions.
- The embedded agent spawns headless `claude -p` with your Claude Code login (no
  API key). It may Read the repo and Write/Edit **only under `content/`**. After
  every agent turn the server commits any `content/` change (`agent: <summary>`)
  so it can be reverted with git. Agents never touch `web/`, `scripts/`, or `.beads/`.
- Voice practice (Go tab) is a push-to-talk loop: `/api/voice/*` in
  `web/server/voice.ts`, pure helpers in `scripts/voice.mjs`; see `docs/VOICE.md`.
  Provider keys live only in the gitignored repo-root `.env.local` and never
  reach the browser. Voice turns spawn `claude -p` with **no tools**.
- Runtime state (chat history, model setting, voice settings) is JSON under `data/` (gitignored).
  Exports go to `exports/` (gitignored).
- Loader and assembler (`scripts/content.mjs`, `scripts/assemble.mjs`) are pure ESM
  with no server imports, so `node --test` covers them directly.
- Two content trees, same format: `content/` (adult mode) and `content/kids/`
  (kids mode: own `schema.yaml`, `frame.md`, `profile.yaml`, `units/`,
  `scenarios/`, `packs/`; shares `languages.yaml`). `modeRoot(mode)` in
  `scripts/content.mjs` is the one place that maps a mode to a root. Every
  content/pack/folder/assemble/export/profile route takes `?mode=adult|kids`
  (adult when absent, 400 otherwise); kids pack writes commit as
  `packs(kids): …` and kids exports go to `exports/kids/`. The adult loader
  never descends into `kids/`.

## Work tracking
Beads: `bd ready` for unblocked work, `bd show <id>` for context, `bd close <id>`
when done. Prefix `ld`. File new work as beads, not TODO comments.

## Build & test
```sh
npm install && npm --prefix web install
npm run dev                    # http://localhost:38400
npm test                       # node --test scripts/tests/*.test.mjs
npm --prefix web run lint      # oxlint
(cd web && npx tsc -b)
npm run export -- content/packs/<id>.yaml
npm run export -- content/kids/packs/<id>.yaml   # kids library → exports/kids/
```
Tests point the loader at fixtures via `LINGO_CONTENT_DIR` and `LINGO_EXPORTS_DIR`;
never write to the real `content/` or `exports/` from a test.

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
