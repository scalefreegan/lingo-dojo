# Lingo Dojo — PRD

Personal, localhost, built for one person at first; since 2026-11-15 a few
people share it with logins, each with one or more learners (docs/DATA.md
§Auth). A **composable prompt-pack builder** for
language-practice sessions run elsewhere as a real-time voice conversation with an
AI "dojo master". It organizes the instruction material, lets you pick and
combine it, and hands you one markdown prompt to paste into whatever voice tool
you use — or, since 2026-11-09, runs the session itself by voice on the Go tab
with native-speaker voices per speaker (docs/VOICE.md).

Decided 2026-10-19 in the intake interview (all answers below are final for v1):

| Decision | Choice |
|---|---|
| Content store | Markdown + YAML frontmatter files under `content/`; git is the history; **no database** (v1). Superseded in part on 2026-11-15: personal data (logins, learners, packs, conversations, phrase bank) moves to Postgres per docs/DATA.md, while the library stays in files. Built so far: the foundation, logins + learners (users, sessions, learners, per-user settings and agent chat), saved packs (per learner, with revisions and soft deletes instead of git commits; the pack files are seeds) and saved conversations (every voice session's turns, listed in the Library's History) |
| Embedded agent | Headless `claude -p` subprocess (sibling pattern) with Read on the repo and **Write/Edit scoped to `content/`**; every agent change is auto-committed so it can be reverted |
| Export | One self-contained markdown prompt; Copy button and a file written to `exports/` |
| Stack | Match Atlas (`../travel-guide`): React 19 + Vite + TS strict, Vite middleware API, Tailwind 4, oxlint, `node --test`; Dock app from `macos/`; **port 38400** |
| Unit model | **Slots with cardinality** declared in `content/schema.yaml`; units declare their slot; assembly walks slots in schema order |
| Learner profile | Global `content/profile.yaml` with per-pack overrides. Since 2026-11-15 the profile is the active learner (a database row, edited from the Profile popover); the file seeds the first admin's learner and serves the offline export CLI |
| Modes | Two libraries with the same file format: `content/` (adult) and `content/kids/` (kids: its own schema, frame, profile, units, scenarios, packs). A learner is adult or kids, and switching learner switches mode; the tree-scoped API routes use the active learner's mode (a disagreeing `?mode=` is a 400); kids exports go to `exports/kids/` |
| Packs | Saved per learner in the database (since 2026-11-15; id `<folder>/<date>-<slug>`, undo by revisions and Recently deleted); `content/packs/<date>-<slug>.yaml` files are seed packs and the export CLI's input; seed library in Spanish (Oaxaca scenarios) |
| Voice target | ChatGPT voice mode and Claude voice in practice (2026-10-19); export stays tool-agnostic markdown with a length readout. The frame fixes the voice: every speaker is a native speaker of the target variant, in both languages |
| In-app voice (2026-11-09) | Push-to-talk loop on the Go tab: speech to text (ElevenLabs Scribe or Azure) → one tool-less `claude -p` turn → text to speech per speaker (ElevenLabs, Azure, or free macOS voices). The learner ends each turn (tap, or a pause length they set). Keys in gitignored `.env.local`. See docs/VOICE.md |

## Vocabulary

- **Unit** — one composable instruction block (a `.md` file). Example: "Gentle in-line
  corrections", "Warm-up: ten useful phrases", "Guidance in the target language".
- **Slot** — a named position in the assembled prompt with a cardinality (`one` or
  `any`). Example slots: intro, warmup, difficulty, guidance-language, corrections,
  interrupts, debrief.
- **Scenario** — the setting and story for the session (a `.md` file). Example:
  "A palenque outside Santiago Matatlán: tasting mezcal with the maestro".
- **Profile** — who the learner is: native language, target language and variant,
  level, goals.
- **Pack** — one concrete selection: a scenario (or a free-text quick scenario),
  one or more units per slot, profile overrides, free notes. Saved as YAML.
- **Export** — the assembled markdown prompt rendered from a pack.
- **Dojo master** — the voice agent that receives the prompt. Lingo Dojo never
  talks to it.

## User flow (v1)

1. Open the app (Dock icon or `npm run dev`, http://localhost:38400), log in,
   and pick who's practicing (the first visit creates the admin account).
2. Pick a scenario from the library, or type a quick scenario in a text box.
3. For each slot, choose units (radio for `one`, checkboxes for `any`). Defaults
   come pre-selected from each unit's `default: true`.
4. Optionally override target language / level for this pack and add free notes.
5. Watch the assembled prompt update live in the preview pane, with a word count.
6. Copy to clipboard, or Export to `exports/<date>-<slug>.md`, or Save the pack
   to reopen later. Saved packs appear in a list and can be loaded and cloned.
7. Ask the embedded agent to add or revise units/scenarios ("add a corrections
   unit that only flags gender agreement"). The agent edits files under `content/`;
   the app reloads content on the next request; the change is a git commit.

## Non-goals (v1)

- A feedback loop from the session (debrief saved, progress tracked). The
  in-app voice session itself landed 2026-11-09. Its transcript has been
  saved since 2026-11-15 (a conversation per session, listed in the
  Library's History, docs/DATA.md §Conversations); the recap, the phrase
  bank and progress tracking built on it are still to come.
- In-app rich editing of unit bodies (agent or editor does that; follow-up bead).
- JSON bundle export for a programmatic voice pipeline (follow-up bead).
- Mimir/Obsidian export (follow-up bead).
- Deployment beyond this Mac (a production server, another host, public internet). Logins for a few people landed 2026-11-15 (docs/DATA.md §Auth): accounts from `npm run user`, the first one from the first-run screen.

## Architecture

```
content/               the product: schema, units, scenarios, profile, seed packs (git-tracked)
scripts/
  content.mjs          load + validate content from disk (pure, no server deps)
  assemble.mjs         pack + content -> markdown (pure, tested)
  claude.mjs           spawn headless claude for the embedded agent (sibling pattern)
  export.mjs           CLI: node scripts/export.mjs content/packs/x.yaml
  auth.mjs             passwords, session cookie, login throttle (pure)
  user.mjs             CLI: npm run user -- add | passwd | list | disable | enable
  import.mjs           CLI: npm run db:import, pack files → a learner's packs (idempotent)
  db/                  Postgres schema, migrations, accounts, packs (docs/DATA.md)
  tests/*.test.mjs     node --test
web/                   Vite app; API is Vite serve-middleware in web/server/*.ts
  server/api.ts        plugins + wrap(fn, {auth}): same-origin, session, access level
  server/auth.ts       login, logout, me, first run, learners
  server/content.ts    GET /api/content, packs CRUD + revisions (database), POST /api/assemble, POST /api/export
  server/chat.ts       SSE chat with the embedded agent, auto-commit after edits
  shared/wire.ts       types shared by server and client
  src/                 React UI
exports/               rendered prompts (gitignored)
data/                  pre-login runtime state, now only the first admin's seed (gitignored)
macos/                 Dock app (Lingo Dojo.app), copied from Atlas, port 38400
docs/                  this PRD, CONTENT.md (file format contract), DATA.md (database), VOICE.md
```

See `docs/CONTENT.md` for the exact file formats and the assembly algorithm. That
document is the contract between the content library, the loader, and the UI.
