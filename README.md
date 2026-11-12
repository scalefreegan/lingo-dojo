# Lingo Dojo

![Lingo Dojo demo](screenshots/demo.gif)

A composable prompt-pack builder for spoken language practice. You pick a scenario
("tasting mezcal at a palenque outside Santiago Matatlán"), choose the lesson units
you want (how the session opens, warm-up drills, how hard it pushes you, which
language the guidance comes in, how mistakes are corrected, how it closes), and get
one markdown prompt. Then practise right in the app: the **dojo master** speaks in
native voices and you answer by talking (push-to-talk) or typing. Or copy the prompt
into whatever voice agent you already use.

Three ideas, one app:

1. **Everything is a text file.** Units, scenarios, your learner profile, and saved
   packs are markdown and YAML under `content/`. Git is the history. There is no
   database.
2. **Slots, not a pile of toggles.** `content/schema.yaml` names the slots in prompt
   order and says whether each is pick-one or pick-any. The UI is one card per slot.
3. **An agent that edits the library.** The chat drawer runs a headless Claude that
   may read the repo but can only write under `content/`. Every edit it makes is a
   git commit, so you can always revert.

## Running

```sh
npm install && npm --prefix web install   # once
npm run dev                               # http://localhost:38400
```

Or build the Dock app once and launch it by icon (see `macos/README.md`; the first
launch asks for Documents access for "Lingo Dojo Server"):

```sh
./macos/build-app.sh
open -a "Lingo Dojo"
```

The embedded agent uses your Claude Code login. No API key is involved.

## Using it

- **Scene** tab: pick a scenario (search, category filters, collapsible collections)
  or write a quick one. The top bar's profile pill sets the target language, variant,
  and level.
- **Customize** tab: one expandable card per slot. Radios for pick-one slots,
  checkboxes for pick-any. Units marked `default: true` start selected.
- **Go** tab: **Practice** runs the pack as a spoken session in the app. The dojo
  master and each character speak in their own native voice, you answer with
  push-to-talk or by typing, and a session timeline tracks the parts (setup and keys:
  [`docs/VOICE.md`](docs/VOICE.md)). The same tab shows the assembled prompt with a
  word/token readout and a note box for the dojo master. **Copy** puts it on the
  clipboard for any other voice agent. **Export file** writes `exports/<id>.md`.
  **Save pack** stores it as `content/packs/<date>-<slug>.yaml`; saved packs can be
  loaded or cloned from the Library.
- **Agent drawer** (right edge): ask for new or revised units and scenarios in plain
  language ("add a corrections unit that only flags gender agreement"). New files
  appear in the slots as soon as the commit lands.

Command line export of a saved pack:

```sh
npm run export -- content/packs/2026-10-19-palenque-first-visit.yaml
```

## Modes

There are two libraries, switched from the Profile pill in the top bar. **Adult**
is `content/`: conversation practice at a CEFR level. **Kids** is `content/kids/`:
story, play and short sessions for a child who does not read yet, with its own
slots (opening, helper character, story shape, repetition games, energy and
length), its own frame, profile, scenarios and packs, and a child-sized level
scale. The two never mix: a kids pack lives in `content/kids/packs/`, a kids
export in `exports/kids/`, and the agent is told which library you are looking
at. Each mode remembers its own draft, tab and filters in the browser.

## Authoring content

`docs/CONTENT.md` is the contract: file layout, required frontmatter, placeholders
(`{{learner_name}}`, `{{target_language}}`, ...), and the assembly algorithm. Unit
bodies are written as second-person instructions to the dojo master and must be
self-contained. The seed library is Mexican Spanish with Oaxaca scenarios; add a
scenario file for any other setting or language, and change `content/profile.yaml`
for a different target language.

## Architecture

```
content/        the product: schema, frame, profile, units, scenarios, packs
scripts/        content.mjs (loader), assemble.mjs (pack -> markdown), export.mjs (CLI),
                claude.mjs (headless agent spawn), tests/ (node --test)
web/server/     Vite serve-middleware API behind a same-origin wrap():
                /api/content, /api/packs[/:id], /api/assemble, /api/export,
                /api/chat (SSE), /api/chat/history, /api/settings
web/src/        React UI: ScenarioColumn, SlotsColumn, PreviewColumn, AgentDrawer/ChatPanel
data/           runtime state (chat history, model setting), gitignored
exports/        rendered prompts, gitignored
macos/          Dock app (stay-open applet + server helper), port 38400
docs/           PRD.md (decisions), CONTENT.md (format contract)
```

Stack: React 19, Vite, TypeScript strict, Tailwind 4, oxlint, Node's built-in test
runner. Same conventions as the sibling apps Atlas, Wine Guide, and Basecamp.

## Checks

```sh
npm test                       # loader, assembler, export CLI, API, agent argv
npm --prefix web run lint      # oxlint
(cd web && npx tsc -b)         # types
```

Work is tracked with beads (`bd ready`, prefix `ld`).
