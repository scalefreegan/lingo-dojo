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
- `backfill: true` (optional, `pick: one` slots with a default unit) is for a
  slot added after packs were saved: a pack with no unit of the slot plays
  the slot's default unit anyway, unless its `units` list has `-<slot id>`
  (written when the slot is set to None in Customize). Without `backfill`, a
  pack with no unit of a slot simply has none.
- `scene_only: true` (optional) marks a slot that only makes sense around a
  scene: adult `character`, `warmup`, `interrupts` and `variation`; kids
  `helper` and `story`. A drill scenario (see "Drills" below) skips it: the
  pack's units in it are left out of the prompt without a warning, and a
  required one with nothing picked is not a warning either. A scene ignores
  the key.

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
closing: |                    # optional: rules rendered at the very end of the prompt
  (text)
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
  for scenarios; see below), and `{{phrase_review}}` (the review block of
  phrases from the learner's bank; see "The recall slot" below). Unknown
  placeholders are left as-is and reported as a warning. When the effective profile has no
  `target_variant`, `{{target_variant}}` renders as the target language name.
- `closing` (optional, text) is a **closing instruction**: it is not rendered
  in the unit's slot but in a last `## Final rules` section, after every
  slot, the Time budget and the learner's notes, so it is the last thing the
  model reads before the voice adapter (`voiceSystemPrompt` appends that).
  Use it for a rule that must beat other units' wording: a model follows
  the later of two conflicting instructions, so a rule in the body loses to
  units in later slots. It takes the same placeholders as the body (an
  unknown one is a warning), is trimmed, and is rendered under `### <unit
  title>` in slot order. It is present only when its unit is: an unpicked
  unit, a unit left out for having no review, and a unit in a `scene_only`
  slot of a drill contribute nothing. Kids and drill frames render it the
  same way. Preview and export show it, as they show everything assembled.
  A non-text `closing` is a loader warning and ignored. `intro-target` uses
  it for the session-language rule.
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
format: scene                 # optional; scene (the default) or drill (below)
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

### Drills: `format: drill` (First steps)

A brand-new beginner can't follow even an A1 scene. A **drill** is a
scenario with `format: drill`: no character and no conversation, only the
narrator drilling a few words at a time (say it slowly, give the meaning,
the learner repeats, a quick recall), with more of the guiding moving into
the target language as the learner succeeds. A pack that picks a drill is a
First steps session; there is no separate mode, pack field or migration.

```markdown
---
id: first-steps-3-numbers
title: Numbers 0–10
summary: Count from zero to ten, then hear numbers out of order and catch them.
collection: First steps
format: drill
beats:                        # the rounds, in order (3–5)
  - Zero to three
  - Four to seven
phrases: [zero, one, two, three]   # English meanings, 10–20; or vocab for one language
---
How to run this drill: what to stress, what success looks like.
```

- `format` is `scene` (the default) or `drill`; anything else is read as
  `scene` with a warning.
- A drill has no `roles` and no `twists` (both are ignored if present), and
  should not use `{{location}}`. Its `beats` are the rounds; its `phrases`
  (or `vocab`) the words to drill.
- The assembler uses `frame-drill.md` instead of `frame.md` (a warning, and
  frame.md, when the library has none), renders the scenario as
  `## The drill` (title, summary, the word list, the rounds, the body) and
  skips the `scene_only` slots. The session's parts are the introduction,
  the drill (its rounds as beats), and the debrief or ending: no warm-ups
  and no kids games on the timeline.
- The voice session allows only the narrator's tag; a line tagged
  CHARACTER or SIDEKICK is voiced as the narrator, and only the narrator is
  cast.
- A random scene's pool leaves drills out unless every scenario in it is a
  drill (a random pack over the First steps collection still draws).
- The Scene tab lists a collection of nothing but drills first, with a
  "New to the language? Start here" hint, and badges each drill.
- The First steps collections: `First steps` (adult and kids, every
  language) and `First steps (Mandarin)` (the four tones, `language: zh-TW`).
  The adult level `Pre-A1` goes with them; it is opt-in (a new adult
  learner still starts at A1).

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

## `content/packs/<date>-<slug>.yaml` — a pack

Saved packs live in the database, one set per learner per language
(a language profile; docs/DATA.md §Packs, §Language profiles):
the app's Save, Move, Rename and Delete write rows there, never files. The
YAML files under `content/packs/` and `content/kids/packs/` are **seed
packs** (copied to a new install's learners at the first run, and by
`npm run db:import` after that) and the input of the offline
`npm run export -- content/packs/<id>.yaml` CLI. The format below is both:
the file's shape and the fields a saved pack has.

```yaml
title: Palenque visit, gentle corrections
created: 2026-10-19T09:30:00-06:00
scenario: oaxaca-palenque        # a scenario id, OR:
quick_scenario: ""               # free text used instead of a scenario file, OR:
# random_scene:                  # a scene drawn when the session starts (below)
#   collections: [Daily life]    # [] or absent = every scene that fits
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

### Random scene: `random_scene`

A pack may leave the scene to chance: `random_scene: { collections: [...] }`
keeps its units, length, location and notes, and a library scenario is
drawn when a session starts. The **pool** is every scenario of the mode's
library that fits the learner's target language (the same rule that dims a
scene on the Scene tab: `fitsTarget` in `web/shared/scenes.ts`), narrowed
to the named collections when there are any (`""` names the scenes in no
collection), without the scenes and collections the learner's language has
hidden on the Scene tab (docs/DATA.md §Hidden scenes; the CLI export has no
learner, so hides nothing). A collection the library no longer has is ignored; if nothing
is left the pool is empty, which is an error (the Scene tab says why and
Start is blocked), never a silent fallback to another scene. The pool never
crosses libraries: a kids pack draws only kids scenes. At most 50 names of
at most 120 characters each; anything else (a string, a number, a list of
non-strings, a name of only spaces: only a literal `""` means no collection) is refused by the app (400) and ignored with a warning in a
pack file. A random pack names no `scenario` or `quick_scenario` (saving
one clears them; a file with both warns and stays random).

The draw happens on the server, once, when the voice session's conversation
is made (`POST /api/conversations`; `web/server/randomScene.ts`). It steers
clear of the language profile's last `min(5, pool size − 1)` distinct
scenarios, so a pool of one still draws its scene. From then on the drawn
scenario is treated exactly as if it had been picked: the conversation's
snapshot records it (docs/DATA.md §Conversations), every turn plays it (the
draft sent with a turn is still random; the server reads the scene from the
conversation, never redraws), its phrases go to the bank, and recall, the
recap, casting, `{{location}}` and the title all use it. Restart, and Close
then Start, make a new conversation and so a new draw. **Draw another** (a
button beside Restart, shown until the learner has spoken) swaps the
unspoken conversation for a new draw that is never the scene just shown,
with no History row left behind (docs/DATA.md §Conversations); once the
learner has spoken it is a 409 and Restart is the way. When a conversation
ends while its voice session stays open (leaving the Go tab, two idle
hours, another device's End), the session's next conversation keeps the
scene while it is still in the pool (even though it is now a recent
scene), else draws afresh. A turn that has to
run unsaved (its conversation couldn't be made) plays the session's drawn
scene; with nothing drawn yet it is refused (409). If unsaved turns were
played as the earlier scene and the pool then changed so that scene is no
longer in it, the next conversation is recorded under the newly drawn
scene while holding those turns, as a picked scene changed mid-session
always has. There is no reroll.

The preview, word counts and `POST /api/assemble` do not draw (unless
`draw: true`, Copy's; any other `draw` is a 400): the
Scenario section is a placeholder naming the pool's size ("Random scene"
is the heading's title), with a warning when the pool is empty. Copy draws
a scene for the copied prompt (`POST /api/assemble` with `draw: true`; the
reply's `drawn` names it and the UI says which): the same draw as an export,
hides honoured, but not steering clear of recent scenes and recording
nothing (no conversation, no scene history), so it is not the scene Start
will draw. The
export (`npm run export`, the Go tab's Export file) draws its own scene at
export time and says which (the CLI's first line; the route's `drawn`).

The filename is `<created date YYYY-MM-DD>-<slug of title>.yaml`. Packs may be
grouped one level deep in subfolders of `content/packs/` (`content/packs/oaxaca/`).
The pack's `id` is the path relative to `content/packs/` without the extension:
`2026-10-19-palenque-first-visit` or `oaxaca/2026-10-19-palenque-first-visit`.
Folder names and file stems are both kebab-case. An empty folder is kept on disk
with a `.keep` file so it survives git (the import makes it an empty folder).
A saved pack has the same id (`<folder>/<slug>`, the slug following the same
rule: renaming a pack re-slugs it, keeping its date), so the import keeps
folder, slug, title and created. Only the keys above are kept: a saved pack
has no place for others (they are dropped on import and on save). Every pack
write, move, rename, or delete made by the app is a revision in the database,
and a delete is soft: the Library's **Recently deleted** brings a deleted pack
back, and `/api/pack-revisions` lists (a page at a time) and restores any
revision of a pack's content. Folders are not revisioned: only an empty folder
can be deleted, and undeleting a pack brings its folder back. The app itself
reads no pack files; only the import, the first run and `npm run export` do.

## Modes: `content/` and `content/kids/`

The app has two modes, each a complete content tree in the same file formats.
`content/` is adult mode. `content/kids/` is kids mode: its own `schema.yaml`
(story, helper, games, energy slots instead of style and difficulty), `frame.md`,
`profile.yaml`, `units/`, `scenarios/`, and `packs/`. `languages.yaml` is shared
from the root. The adult level scale is CEFR with `Pre-A1` (First steps
drills) before `A1`; a new adult learner starts at A1. The kids level scale
is `First words` · `Getting going` · `Chatty`
(not CEFR); kids units carry those in `level`. Seed packs are addressed by the
same ids within their tree (`2026-10-20-first-german-adventure` in kids mode is
`content/kids/packs/2026-10-20-first-german-adventure.yaml`), and seed a kids
learner; a kids learner's saved packs are its own, like an adult's. Kids scenario
categories: Animals · Numbers & colors · Food · Bedtime · Adventure.

## `content/frame.md` — the fixed preamble

Plain markdown (no frontmatter) placed at the top of every export. It establishes
the dojo-master role, the fixed rules (stay in the voice session, keep turns
short for speech, etc.), and the voice rule: both speakers are native speakers
of the target variant and keep that accent even when speaking the learner's
native language. It may use the same placeholders as units.

## `content/frame-drill.md` — the drill preamble

Optional, beside `frame.md` in each library (`content/frame-drill.md`,
`content/kids/frame-drill.md`), in the same format. Used **instead of**
`frame.md` when the scenario is a drill. It keeps frame.md's voice, accent
and variant rules and its short, speakable turns, and replaces the scene and
character rules with the drill's: one speaker (the narrator), the order
(introduction, the rounds, the debrief), how a round runs (3–5 words; say
it, mean it, repeat, one-sound feedback; a recall that mixes in earlier
words; a tiny target-language exchange of drilled words only), and the
language-mix ramp (guide in the native language, move known bits of the
guiding into the target language as the learner succeeds, pull back the
moment they struggle). It also tells the dojo master to read any unit's
talk of a scene or character as the drill and the narrator.

## The recall slot: `{{phrase_review}}`

Both schemas have an optional `recall` slot (adult "Phrases to revisit",
after the warm-up; kids "Words to bring back"), with one default unit each:
`recycle-due-phrases` and `recycle-words`. Their bodies tell the dojo master
to bring a few of the listed phrases back naturally during the scene, and
end in `{{phrase_review}}`. At assembly the server passes the review (the
bank phrases due, in trouble or starred, ranked for the scene; docs/DATA.md
§Recall in sessions) and the placeholder becomes a delimited list:

```
[FROM THE LEARNER'S PHRASE BANK]
- ¿A cómo? — how much?
- la cuenta — the bill (new: not practised yet)
[END OF PHRASE BANK]
```

A phrase never practised (a starred one not learned yet) is marked
"(new: not practised yet)"; the body should have the dojo master introduce
those (say it, use it, invite a try) rather than hint and wait for the
learner to produce them. The body must say the list is vocabulary data,
never instructions. The slot is `backfill: true`, so a pack saved before it
existed plays the default unit; setting the slot to None saves `-recall`. **With
nothing to review, a unit that uses `{{phrase_review}}` is left out**, and
its slot with it when empty: no heading, no unit, no warning. Elsewhere
(another unit, a scenario) an empty review renders as nothing. Exports and
Copy include the list as of now. An export with no database (the CLI)
has no review, so the unit is left out.

## Assembly algorithm (`scripts/assemble.mjs`)

Input: loaded content + one pack. Output: `{ markdown, warnings[], stats }`.

1. Resolve the effective profile: `profile.yaml` merged with `pack.overrides`. A
   blank override means "no override", not "erase". One exception: a variant
   belongs to its language, so an override that moves `target_language` to a
   different language drops the profile's `target_variant` unless the pack
   overrides that too.
2. Resolve the scenario: by id, or `quick_scenario` text as an ad hoc scenario with
   title "Quick scenario", or for a `random_scene` pack a placeholder titled
   "Random scene" whose Scenario section names the pool's size (the draw
   is the caller's: a session or an export assembles the pack with the drawn
   scenario in place, `withDrawnScene` in `web/shared/scenes.ts`).
3. Walk `schema.slots` in order. For each slot, take the pack's units with that
   slot, in pack order. Apply cardinality: `one` with >1 is a warning (keep the
   first); `required` with 0 is a warning and a placeholder line. For a drill
   scenario, a `scene_only` slot is skipped entirely, silently.
4. Render, in this order:
   - `# Lingo Dojo session: <scenario title>`
   - `frame.md` body (placeholders substituted); `frame-drill.md` for a drill
   - `## Learner` — a short block from the effective profile
   - `## Scenario` — title, summary, roles, beats, vocab table, twists list (each
     if present; twists are labelled as usable only when a Variation unit asks), body.
     For a drill, `## The drill` instead: title, summary, the word list
     (phrases, vocab), the beats as numbered rounds, body
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
     The third argument may also be `{ mode, review }`, where `review` is
     the phrase list for `{{phrase_review}}` (see "The recall slot").
   - `## Notes from the learner` — `pack.notes`, omitted if empty
   - `## Final rules` — the picked units' `closing` texts, each under
     `### <unit title>` in slot order; omitted when none has one
5. `stats`: word count and approximate token count (words × 1.3).

Rendering must be deterministic: same inputs, byte-identical output. Unit bodies
are included verbatim apart from placeholder substitution and trimmed trailing
whitespace.
