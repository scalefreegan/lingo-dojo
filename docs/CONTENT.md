# Content format contract

Everything the app composes lives under `content/` as plain text. This file is the
contract shared by the loader (`scripts/content.mjs`), the assembler
(`scripts/assemble.mjs`), the seed library, the UI, and the embedded agent. Change
the format here first, then the code.

Frontmatter is YAML between `---` lines. Parse with the `yaml` npm package (not
gray-matter; the split is trivial and we want one YAML dependency). Unknown
frontmatter keys are preserved and ignored, never an error. Missing required keys
are a validation error reported with the file path.

## `content/schema.yaml` — the slots

```yaml
version: 1
slots:
  - id: intro
    title: Introduction
    pick: one          # exactly one unit (if required) or at most one
    required: true
    description: How the session opens and in which language.
  - id: warmup
    title: Warm-up
    pick: any          # zero or more units
    required: false
    description: Optional drills before the scenario starts.
  # ... in prompt order
```

- Slot order in this list **is** the order sections appear in the export.
- `group` (optional) is a display heading the UI uses to cluster slots on the
  Customize step (e.g. Voices, Teaching style, Session flow, Variation). It has
  no effect on the export. Slots without a group are shown under "Other".
- `pick: one` renders as radio buttons; `pick: any` as checkboxes.
- `required: true` with `pick: one` means the pack must select one unit for the
  slot; the assembler returns a warning (not an error) when it is missing and
  renders the section with a placeholder line so the export is never silently
  incomplete.
- The agent may add a slot by editing this file. A unit whose `slot` is not in the
  schema is loaded with a validation warning and shown in an "Unslotted" group.

## `content/units/<id>.md` — a unit

```markdown
---
id: correct-gently            # must equal the filename stem
slot: corrections             # a slot id from schema.yaml
title: Gentle in-line corrections
summary: Finish the beat, then offer a more natural phrasing once.
tags: [corrections, beginner-friendly]
default: true                 # preselected in a new pack (optional, default false)
level: [A1, A2, B1]           # optional hint; UI shows a badge, never filters
---
When the learner makes an error, do not interrupt mid-sentence. Finish the
beat of the conversation, then briefly offer a more natural phrasing in
{{target_language}}, say it once, and continue the scene. Do not explain
grammar unless the learner asks.
```

- The body is written as **instructions to the dojo master**, in English, second
  person ("you"). Keep each unit self-contained: no references to other units.
- Body may use these placeholders, substituted at assembly time:
  `{{learner_name}}`, `{{native_language}}`, `{{target_language}}`,
  `{{target_variant}}`, `{{level}}`, `{{scenario_title}}`, `{{location}}` (meant
  for scenarios; see below). Unknown placeholders
  are left as-is and reported as a warning. When the effective profile has no
  `target_variant`, `{{target_variant}}` renders as the target language name.
- `id` is kebab-case and unique across units. Filename is `<id>.md`.
- Tags are free-form labels, with one that the app reads: in kids mode, a
  `games` unit tagged `opener` (the echo game) is placed **before** the story
  on the session timeline; other games sit at the story's start, since they
  come back throughout. Dropping the tag moves the game into the story.

## `content/scenarios/<id>.md` — a scenario

```markdown
---
id: oaxaca-palenque
title: Mezcal tasting at a palenque
summary: Visiting a small family palenque near Santiago Matatlán.
tags: [oaxaca, mezcal, travel]
language: es-MX               # suggested target variant; profile can override
collection: Oaxaca trip       # optional; Scene tab groups cards under this heading
category: Food & drink        # optional; Scene tab filter chip. Use one of:
                              #   Food & drink · Getting around · Shopping ·
                              #   Outdoors & sport · Culture & guides ·
                              #   Lodging & logistics · Health & help ·
                              #   Emergencies · People & social ·
                              #   Errands & admin
roles:
  dojo_master: the maestro mezcalero, Don Eulogio, 60s, warm, proud of his craft
  learner: a curious visitor on a first trip to Oaxaca
beats:                        # optional ordered scene sections the dojo master may use
  - Arrival and greeting at the gate
  - Walking past the horno and tahona; how the agave is cooked and crushed
  - Tasting three mezcales; describing flavor
  - Asking about buying a bottle; prices; saying goodbye
twists:                       # optional; variation units pick one at random
  - The tobalá is sold out; the maestro offers a madrecuixe instead
vocab:                        # optional; warm-up units draw from this
  - { term: "palenque", gloss: "mezcal distillery" }
  - { term: "¿Me permite probar?", gloss: "May I try it?" }
---
The learner arrives at the palenque in the late morning... (free prose for the
dojo master: setting, mood, what the learner is trying to accomplish, what
success looks like.)
```

Only `id`, `title`, `summary` are required. Everything else is optional. The body,
`roles` and `twists` may use the same placeholders as units; they are substituted
at assembly time. `title`, `summary` and `beats` are shown as-is on the Scene tab
and the voice timeline, so they must not use placeholders (the loader warns when
they use `{{location}}`).

### Scenarios for every language: `phrases` and `{{location}}`

A trip collection (Oaxaca) is written for one language and one place. A generic
collection (Travel essentials, Daily life, Social & small talk, Health &
emergencies, Work & errands; kids: Playtime) works in any target language and city:

```markdown
---
id: travel-taxi-rideshare
title: Taxi or rideshare across town
summary: Telling the driver where to go, small talk, and the fare.
collection: Travel essentials
category: Getting around
roles:
  dojo_master: a driver who has lived in {{location}} all their life
  learner: a visitor heading across town
beats: [Getting in, Small talk, Paying]
phrases:                      # English meanings; no target-language words
  - To this address, please
  - How long will it take?
twists:
  - "A road is closed somewhere in {{location}}"
---
{{learner_name}} climbs into a taxi in {{location}}...
```

- **No `language:`.** Its absence marks the scenario as fitting every language. A
  scenario with `language` ("es-MX") is written for that language; the Scene tab
  dims a collection whose scenarios are all written for a language other than the
  session's target (matched by the `code` in `languages.yaml`) and sorts it last.
  It stays selectable.
- **`phrases`** is a list of English meanings. The assembler renders them as
  "Phrases to work in" and the dojo master says each in the learner's variant.
  `vocab` (target-language term + gloss) remains for language-specific scenarios.
- **`{{location}}`** in roles, twists or the body makes the scenario take its place
  from the session (`uses_location: true` on the loaded scenario). The Scene tab
  then shows a Location field, saved as the pack's `overrides.location`:
  - set: `{{location}}` is that place, and a **Setting** line says so. The variant
    still wins: the voices keep the learner's variant even when people in that
    place speak another one.
  - blank: `{{location}}` reads "the city you chose", and the Setting line tells
    the dojo master to pick a real city where the variant is spoken and name it
    at the start. The export stays deterministic; the choice happens in session.
  - A scenario without `{{location}}` ignores `overrides.location`, and the
    location never appears in the Learner block. A quick scenario never uses
    it (the learner writes the place into their own text), and the location is
    read from the pack only, not from `profile.yaml`. `{{location}}` anywhere
    else (a unit, frame.md, a quick scenario) is left as-is with a warning.
- Quote any list line containing `: ` (`- "Checkout: bags and payment"`);
  unquoted, YAML reads it as a mapping. The loader recovers the line but warns.
- Make no culture-specific assumptions (tipping, currency, haggling, names):
  defer to "whatever is customary in {{location}}". Kids scenarios don't use
  `{{location}}`; they ask for a light touch of a culture where the target
  variant is spoken.

## `content/profile.yaml` — the learner

```yaml
learner_name: Aaron
native_language: English
target_language: Spanish
target_variant: Mexican Spanish (Oaxaca)
level: A2            # CEFR; free text accepted
goals: Hold a relaxed conversation while traveling; understand fast replies.
notes: Prefers to be corrected, not coddled.
```

## `content/languages.yaml` — the language pickers

```yaml
version: 1
languages:
  - name: Spanish
    variants: [Mexican Spanish (Oaxaca), Castilian Spanish (Spain)]
  - name: Japanese
    code: ja            # optional ISO 639; matched against scenario `language` prefixes
    variants: []
```

Feeds the native-language and target-language dropdowns and the variant
dropdown that depends on the chosen target. `name` is the string the prompt
uses. The file is optional: if it is missing the loader reports a problem and
the UI falls back to free-text fields. The native language defaults to the
profile's `native_language`, or English when the profile has none.

## `content/packs/<date>-<slug>.yaml` — a saved pack

```yaml
title: Palenque visit, gentle corrections
created: 2026-10-19T09:30:00-06:00
scenario: oaxaca-palenque        # a scenario id, OR:
quick_scenario: ""               # free text used instead of a scenario file
units:                           # unit ids; order within a slot follows the pack
  - intro-native
  - warmup-vocab
  - whole-sentences
  - guidance-target
  - correct-gently
  - debrief-top-three
overrides:                       # optional, any profile key (native_language too)
  level: B1
  location: Lyon                 # only read by a scenario that uses {{location}}
  minutes: 10                    # optional time budget; absent = no limit
notes: |
  Today I'd like extra practice with prices and numbers.
```

`minutes` is the session's length, set by the Go tab's "How long do you
have?" picker (5 · 10 · 15 · 20 · 30 · No limit; kids 3 · 5 · 10 · No limit).
It must be a number above 0 and at most 240; anything else (a string, 0, a
typo like 1000) is ignored with a warning, as if it were absent (in the app,
where the remembered length then stands in, the Go tab gives that warning,
since the assembler only sees the length standing in). A fraction is rounded
to whole minutes, at least 1, with a warning (`7.5` is 8), when it is read
(`readMinutes` in `scripts/plan.mjs`), so the heading, the split, the clock
line and the timeline all say the same number. The file keeps what was
written.

A pack's `minutes` is its own only when it was loaded with one or the learner
picked a length in the picker for it (re-picking the length already shown
counts). A pack without one shows the last length picked, remembered in the
voice settings; that length paces the session, Copy and the export, but Save
never writes it into the pack. Like
`location`, it describes the session, not the learner: it is read from the
pack only (a `minutes` key in `profile.yaml` does nothing) and never appears
in the Learner block. Absent means no limit, and the export is exactly what
it would be without the feature. With it, the assembler adds a Time budget
section (see the algorithm below).

The filename is `<created date YYYY-MM-DD>-<slug of title>.yaml`. Packs may be
grouped one level deep in subfolders of `content/packs/` (`content/packs/oaxaca/`).
The pack's `id` is the path relative to `content/packs/` without the extension:
`2026-10-19-palenque-first-visit` or `oaxaca/2026-10-19-palenque-first-visit`.
Folder names and file stems are both kebab-case. An empty folder is kept on disk
with a `.keep` file so it survives git. Every pack write, move, or delete made by
the app is a git commit (`packs: <what>`), so nothing is lost: `git log -- content/packs`.

## Modes: `content/` and `content/kids/`

The app has two modes, each a complete content tree in the same file formats.
`content/` is adult mode. `content/kids/` is kids mode: its own `schema.yaml`
(story, helper, games, energy slots instead of style and difficulty), `frame.md`,
`profile.yaml`, `units/`, `scenarios/`, and `packs/`. `languages.yaml` is shared
from the root. The kids level scale is `First words` · `Getting going` · `Chatty`
(not CEFR); kids units carry those in `level`. Packs are addressed by the same
ids within their tree (`2026-10-20-first-german-adventure` in kids mode is
`content/kids/packs/2026-10-20-first-german-adventure.yaml`). Kids scenario
categories: Animals · Numbers & colors · Food · Bedtime · Adventure.

## `content/frame.md` — the fixed preamble

Plain markdown (no frontmatter) placed at the top of every export. It establishes
the dojo-master role, the fixed rules (stay in the voice session, keep turns
short for speech, etc.), and the voice rule: both speakers are native speakers
of the target variant and keep that accent even when speaking the learner's
native language. It may use the same placeholders as units.

## Assembly algorithm (`scripts/assemble.mjs`)

Input: loaded content + one pack. Output: `{ markdown, warnings[], stats }`.

1. Resolve the effective profile: `profile.yaml` merged with `pack.overrides`. A
   blank override means "no override", not "erase". One exception: a variant
   belongs to its language, so an override that moves `target_language` to a
   different language drops the profile's `target_variant` unless the pack
   overrides that too.
2. Resolve the scenario: by id, or `quick_scenario` text as an ad hoc scenario with
   title "Quick scenario".
3. Walk `schema.slots` in order. For each slot, take the pack's units with that
   slot, in pack order. Apply cardinality: `one` with >1 is a warning (keep the
   first); `required` with 0 is a warning and a placeholder line.
4. Render, in this order:
   - `# Lingo Dojo session: <scenario title>`
   - `frame.md` body (placeholders substituted)
   - `## Learner` — a short block from the effective profile
   - `## Scenario` — title, summary, roles, beats, vocab table, twists list (each
     if present; twists are labelled as usable only when a Variation unit asks), body
   - One `## <slot title>` per slot that has units, each unit rendered as
     `### <unit title>` + body (placeholders substituted). Slots with no units are
     omitted unless required.
   - `## Time budget` — only when `overrides.minutes` is a valid number. The
     total; a rough split across the session's parts, the same parts the
     voice timeline shows (`sessionPlan` in `scripts/plan.mjs`: introduction
     10%, warm-ups 20%, scene 55%, debrief 15%, a missing group's share going
     to the scene; beats are folded into the scene with "about N of its M
     beats", at about two minutes a beat; kids games played during the story
     count as story time), in half minutes that add up to the total, a part
     left at 0 marked "skip it unless there is time to spare"; how to shrink
     (fewer beats, a 5-minute session plays one or two; shorter or skipped
     warm-up drills; a debrief of one or two points; short turns); and how
     to keep time: follow the in-app clock line when there is one, else
     about two exchanges a minute. `assemble(content, pack, mode)` takes the
     mode for this (adult when omitted); kids wording says story and goodbye.
   - `## Notes from the learner` — `pack.notes`, omitted if empty
5. `stats`: word count and approximate token count (words × 1.3).

Rendering must be deterministic: same inputs, byte-identical output. Unit bodies
are included verbatim apart from placeholder substitution and trimmed trailing
whitespace.
