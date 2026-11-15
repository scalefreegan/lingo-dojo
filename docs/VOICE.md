# Voice practice

The Go tab can run a pack as a spoken session in the app, instead of pasting
the prompt into ChatGPT or Claude voice mode. Each speaker the frame names
(narrator, character, and in kids mode the sidekick) gets their own
native-speaker voice, and **you** decide when your turn is over.

## Set up

Keys live in `.env.local` at the repo root. It is gitignored (`.env.*` and
`*.local`), read on every request (no restart needed), and never sent to the
browser.

```sh
# ElevenLabs: voices and speech to text
ELEVENLABS_API_KEY=...
# Azure Speech: voices and speech to text (both lines needed)
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=eastus
```

`npx -y @elevenlabs/cli@latest onboard connect --env-path .env.local` writes the
ElevenLabs key for you. With no key at all, **macOS voices** (free, offline)
still work for listening, and you can type your answers.

ElevenLabs speaks only with voices in your account, and a new account has
few native speakers. Under Voice settings, **Browse the Voice Library** lists
the shared library's native speakers of the pack's locale (e.g. 305 for
es-MX), with each voice's description, accent, age, use, and popularity
(characters spoken this year, times added). Filter by gender, search
("warm", "older", "storyteller"), sort by use, trend, adds, or newest, and ▶ a
sample (the sharer's preview file; it costs nothing). **Use as…** adds the
voice to your ElevenLabs account (`POST /v1/voices/add`, a library add, not a
clone) and puts it in that slot. Remove voices you no longer want on
elevenlabs.io.

## How a turn works

```
browser mic ─▶ 16 kHz WAV ─▶ POST /api/voice/transcribe ─▶ ElevenLabs Scribe v2 / Azure fast transcription
                                                              │
         ◀── audio per line ◀─ POST /api/voice/speak ◀─ lines ◀─ POST /api/voice/turn (claude -p, no tools)
```

- **Turn**: the assembled pack plus a short delivery adapter
  (`scripts/voice.mjs` `voiceAdapter`) is the system prompt; the client sends the
  session history every turn, and the prompt replays its last 60 entries. The
  server also saves each turn (Saved conversations, below), but the
  browser's copy is what a turn is answered from. The reply comes back as
  `NARRATOR-F:` / `CHARACTER-M:` / `SIDEKICK-F:` lines: speaker plus gender,
  taken from the units and the scenario's roles (Doña Carmen is `-F`, a Don
  `-M`). Each line is spoken by the voice in that speaker's slot for that
  gender, so a woman vendor gets a woman's voice. Every tagged line is its
  own row in the transcript, even when the speaker repeats (a dictated
  vocabulary list is term, pause, meaning, one line each); only an untagged
  line continues the row before it. A tool-less turn takes about 4 s.
- **Language marks**: the dojo master wraps every target-language word or
  phrase in `<t>…</t>` (a whole in-scene line included). Each line is split into
  target and native segments, and every segment is spoken by the **same
  speaker's voice** with that language's pronunciation: ElevenLabs gets
  `language_code` per segment, a multilingual Azure voice gets an SSML
  `<lang xml:lang>`. The voice never changes mid-line: native-language text is
  read by the same native target-language speaker (with their accent, as the
  frame asks). macOS voices take no language hint, so there the marks only
  highlight target words in the transcript.
- **Listen**: speech is transcribed as the **target language** (Scribe's
  `language_code`), not guessed per clip: accented Spanish was otherwise
  heard as English. English can always be typed. The target phrases from the
  dojo master's last two turns, the thing you were just asked to say, go
  along as Scribe `keyterms` (at most 100, each up to 5 words), so "¿a
  cómo?" isn't heard as "ah, ¿cómo?". Azure gets both locales as candidates.
- **Timing**: lines are separated by a short pause, 0.4 s between people in
  the scene, 0.2 s for the same speaker, and 0.8 s whenever the narrator and
  the scene hand over (never less than 0.6 s there, and never an overlap).
  The dojo master can set its own: `<pause 1.2>` before a line waits first
  (a vendor weighing tomatoes), and `<overlap 0.4>` starts it before the
  previous line ends (people cutting each other off; at most 1.5 s, up to 4 s
  for a pause). The length is the number the mark starts with: `<pause 1.5>`,
  `<pause1.5>`, `<pause: 1.5>`, `<overlap -0.4>`, with an optional unit
  (`2s`, `800ms`, `500 milisegundos`) and any note after it, of any length,
  `<t>` marks included. A mark that
  doesn't start with a number ("<pause while she counts 20 pesos>") is an
  ordinary pause; either way it is never spoken, bold or not. The server resolves each line's `pauseMs`
  (`scripts/voice.mjs` `linePauseMs`), and the player waits, or starts the
  next clip early with both playing. Segments within a line run back to back.
- **Speak**: one call per segment; the browser plays one while the next is
  being made. Segments are cached for ▶ replay.
- **Your turn ends** when you tap Done (the default, best for thinking out loud
  and for kids) or after a pause you choose (0.5–5 s). The pause only counts
  once you've started talking, so a long think before the first word is fine.
  "Check what it heard before sending" puts the transcript in the box to fix
  first. Talking or sending while the dojo master speaks cuts them off.
  Space toggles the mic.
- **Help 💡 and Skip ⏭**: Help sends `[help]`. The dojo master steps out
  as the narrator, says in one sentence what you're being asked, and gives a
  hint, not the answer. Pressing it again gives a bigger hint, and the third
  time the full answer to repeat. Skip sends `[skip]`, and the dojo master
  moves on to the next step. Both cut off speech like Talk does, and show as
  "Asked for help" / "Skipped" in the transcript. The adapter in
  `scripts/voice.mjs` defines both messages (`HELP`, `SKIP`).
- **The composer**: a text box that grows with its text, then the Talk
  button (a sound wave, ■ while recording) and ▶ Send. A spoken answer is
  sent when you tap ■, unless "let me check what it heard" is on, when it
  lands in the box for ▶. Above it are quick requests: Dojo master, Help,
  Explain, Skip (and Stop while the dojo master talks).
- **🔎 Explain** sends `[explain]`: the narrator explains what was just said
  (meaning, key word or structure, any local note) and hands back.
- **Check-in choices.** When the dojo master asks how the session should go,
  it ends the turn with a `CHOICES:` line (shown, never spoken;
  `parseChoices`). The latest turn's choices show as buttons, plus "🎙 I'll
  tell you". A tapped choice goes as `[direct] <choice>`.
- **The session timeline** beside the transcript lists the session's parts
  (`sessionPlan` in `scripts/voice.mjs`): the introduction, each warm-up, the
  scene and its scenario beats, then the debrief (kids: a game tagged
  `opener`, like the echo game, before the story; the other games at the
  story's start, since they come back throughout; then the ending). A unit
  listed twice is one part. The turn route names them to the dojo master (`planDirective`),
  which ends every turn with a `STAGE: <id>` line (shown, never spoken;
  `parseStage` keeps only a known id; a game that comes back inside the
  story is reported as the beat it happens in, so the timeline never runs
  backwards). A part that asks nothing of the learner (a debrief, the
  vocabulary list) runs straight into the next one in the same turn, so the
  learner never has to ask for it; only the last part closes the session.
  The timeline marks done, here and
  ahead; tapping a part sends `[jump] <id>`, and the dojo master goes
  straight there, skipping what's in between (the frame's "every warm-up
  first" rule gives way to the learner asking). It collapses to a rail of dots (remembered per browser).
  The parts live in `scripts/plan.mjs` (no imports), so the assembler's Time
  budget splits the same parts; `scripts/voice.mjs` re-exports `sessionPlan`.
- **Session length.** The Go tab asks **How long do you have?** before the
  session: 5 · 10 · 15 · 20 · 30 min · No limit (kids: 3 · 5 · 10 · No
  limit). The choice is the pack's `overrides.minutes`, so the prompt shown,
  copied and exported has a **Time budget** section (docs/CONTENT.md). A pack
  without `minutes` starts the picker at the last choice, kept per mode as
  `sessionMinutes` in the user's voice settings (`user_settings.voice` in the
  database; a PUT merges it per mode); what the
  picker shows is what the session, Copy and the export use. Save writes only
  a length that is the pack's own: one it had, or one picked for it
  (docs/CONTENT.md). The clock starts with the first
  turn, and every `/api/voice/turn` sends `elapsedMs`, the time since then.
  The browser keeps this clock even though the session is saved: its origin
  moves with every mid-session pick (below), which only the browser sees, so
  a server clock would need the pick's time from the browser anyway, and a
  reload loses the session it would outlive (Saved conversations).
  With a budget the server adds one **clock line** after the learner's words
  (`clockLine`, given the mode): minutes used, minutes left, the current part (the last
  `STAGE`), and "behind the plan" when the split has moved on. From 80% used
  it says to start closing the scene; from 100% to finish within this turn
  and the next with the short debrief, and to go along if the learner wants
  to keep going (kids: bring the story to its end and say goodbye, with a
  word of praise and one word to remember). The app never ends the session. The timeline shows the time
  left (rounded up; "Time's up, N min over" after) and **+5 min**, which adds
  five minutes to this session only: the turn's pack carries the extended
  minutes, so the Time budget and the clock agree, but the saved pack and
  the picker keep their length. Before the session the picker sets the
  total; **picked mid-session** (every pick, the length already shown again
  included), a length means that many minutes from now:
  the pacing clock starts again at the pick, the budget is exactly the length
  picked (any +5 min is dropped; +5 min then extends from there), and
  `elapsedMs` counts from the pick. Picking 3 at minute 12 reads "3 min left
  of 3" and the clock line says 0 of 3 used, not 12 of 15. The turn's Time
  budget section still splits the whole session's parts; a session already
  past the early ones is ahead of that split, which the clock line calls on
  pace, never behind.
  Each turn reads the budget and the pack at request time (refs, not the
  closure of the render that started it), so a +5 min or a new length counts
  from the next turn even in a hands-free chain. Restart resets the clock
  and the extra minutes. No limit is the old behaviour exactly: no
  Time budget, no clock line.
- **Shown-not-spoken lines** (`GLOSS:`, `CHOICES:`, `STAGE:`) are matched by
  their exact upper-case label (`OPTIONS:` is an older name for
  `CHOICES:`), with or without a speaker tag (any case) or a timing mark in
  front, so a spoken "Options: …" stays speech.
- **Dojo master** (formerly 💬 English) is a direct line to the dojo master,
  outside the practice. The narrator first says a fixed "Yes? I'm
  listening." (English learners only; a cached clip, not a model turn), then
  the mic opens: "switch the scene to a taco stand", "redo that one",
  "slower please". It records in your native language with no target hints,
  and the message goes as `[direct] …`, which the adapter says is a request
  to act on, not an answer to grade. With "check what it heard" on, the
  words wait in the text box under a small **💬 To the dojo master** tag;
  Send sends them, and the tag's × turns them into a practice answer.
- **Definitions.** Each turn ends with a `GLOSS:` line the app shows but
  never speaks: `term = meaning` entries split by ` | `, a translation of
  each whole target-language sentence plus up to six key words or set
  phrases. `parseGlosses` reads it (capped at `MAX_GLOSSES`), and the
  transcript makes each term tappable. Words and short phrases are
  underlined, and a whole line opens its translation. A word glossed in an
  earlier turn stays tappable later, because the dojo master doesn't gloss
  it twice. Glosses go back in the replay, so the model keeps the format,
  and Copy transcript includes them. The turn also puts its glosses of up
  to three words in the language's phrase bank, and a tapped word's card
  has ☆ Star to keep it there starred (docs/DATA.md §Phrase capture).
- **Pinyin and zhuyin.** For a Mandarin target (`zh-*` / `cmn-*`, but not
  zh-HK / zh-MO, which the app uses for Cantonese) the target-language
  segments, and only those, carry their reading over each character in a
  `<ruby>`: pinyin with tone marks, or zhuyin (bopomofo) for learners who
  read it. A switch above the transcript (Readings: Off / Pinyin / Zhuyin)
  is remembered per language profile in the browser (`lingo-dojo.ruby.v1`)
  and defaults to Pinyin; the same switch is on a History transcript and
  the phrase bank, and nothing shows for a language without a reading aid.
  The readings come from the browser, not the dojo master or a model:
  `web/src/script/zh.ts` runs pinyin-pro word by word (so 銀行 reads yín
  háng, 長大 zhǎng dà) over the text spelled in simplified characters one
  for one (its word list is simplified; the table is Unihan's), then
  applies Taiwan's standard readings for a zh-TW profile (星期 xīng qí,
  垃圾 lè sè) and a few particle fixes (慢慢地 de, 跑得快 de). Tone marks are
  each character's own tone (no sandhi), as dictionaries print them. The
  reading is drawn by CSS from the `rt`'s attribute and the `rt` is
  aria-hidden, so copying a line copies its characters only and a screen
  reader reads them once. The reader is its own chunk, fetched only for a
  Mandarin profile with readings on. `web/src/script/script.ts` holds the
  pure helpers (which locales, the stored choice, splitting text, pinyin →
  zhuyin); Japanese furigana or Korean would be another entry there and
  another reader beside zh.ts.
- **Character card.** A tapped word's definition shows its term with each
  Chinese character as a tile; so does an opened phrase in the bank (and
  the card's own list). Tapping one opens the character card (a modal:
  Escape or Close returns focus): the character large with its stroke order
  animated by Hanzi Writer (▶ Replay, ✎ Trace it to draw it stroke by
  stroke, 🔊 Hear it through `/api/voice/speak`), its readings in pinyin and
  zhuyin, meaning, radical, stroke count, its simplified or traditional
  counterpart, and the phrases in this language's bank that contain it or
  its counterpart (the bank's own search). Transcript lines keep their one
  tap (a glossed word's meaning); characters are reached through the
  definition, so the two never compete. Kids mode makes the glyph bigger,
  plays the strokes first and slower, and words it for a child. Everything
  is served by this app: stroke data from the hanzi-writer-data package at
  `/hanzi-data/<character>.json` (`web/server/hanzi.ts`, one small file per
  tap; Hanzi Writer's own default would fetch a CDN), meanings, radicals,
  stroke counts and counterparts from `web/src/script/zh-chars.json`
  (generated from the Unicode Unihan database by
  `scripts/gen-zh-chars.mjs`, its own chunk, fetched on the first tap).
  Licences: pinyin-pro and Hanzi Writer are MIT; the stroke data is from
  Make Me a Hanzi under the Arphic Public License (its text ships in the
  package; the card credits it); Unihan is under the Unicode License v3,
  whose notice is in the generated files and
  `web/src/script/UNICODE-LICENSE.txt`. Unihan's meanings are terse
  dictionary glosses ("love, be fond of, like"), not lessons; the card
  puts the learner's own bank meaning first when the character is a phrase
  there.

## Saved conversations

Every session is saved for the active learner's current language, turn by turn, and listed in
the Library tab's **History** (docs/DATA.md §Conversations has the tables).

- **Start.** The session's first turn makes a conversation
  (`POST /api/conversations`) with the pack as played, the scene's title,
  the target variant, the model and the session length. Each turn then
  names it (`conversationId`), and once the dojo master has answered, the
  server stores the learner's words and the reply in one transaction, in
  the shapes the transcript uses (lines with segments, gender and timing,
  glosses, choices, stage, cast notes), with the turn's duration and cost.
  If the conversation can't be made, the session goes on unsaved and says
  so; the next turn tries again, and the conversation it makes starts where
  saving stopped, so the turns in between are stored too. The conversation
  keeps the session's languages (the profile under the pack's overrides),
  and History shows its glosses and translations in those, whatever the
  profile says later.
- **What is stored is what the screen shows.** The browser still sends the
  whole history every turn, and the server makes the stored turns match it
  before appending (`scripts/conversations.mjs` `planTurnWrite`; the exact
  rule is in DATA.md §Conversations, "Reconciling"): stored turns that agree
  with the screen stay untouched, and the history may replace only the
  final reply. So a turn that failed or was stopped (its words stay on
  screen with no reply) is stored reply-less by the next turn, and a reply
  the server finished but the browser dropped (Stop just as it landed) is
  deleted by the next turn. A history that doesn't cover what is stored
  (shorter, or different earlier on) rewrites nothing: the turn is only
  appended. A dojo master turn stored from the browser's history rather
  than from the server's own reply is marked `from_client`. "Check what it
  heard" never shows: only the words finally sent reach a turn. A recast
  changes voices, not words; the turn's `CAST` notes are stored as the
  reply had them. Turns are numbered by their place on screen, so `idx`
  stays gap-free and in order. A session is capped at 2000 history entries
  (a 413 past that; Restart starts a new one).
- **End.** End (beside Restart) finishes the session: the transcript stays
  to read and copy, and New session starts the next. Restart, Close,
  leaving the Go tab and leaving the page (a reload, closing the tab; a
  `keepalive` request that outlives the page) end the conversation too.
  Leaving Go keeps the session on screen: carrying on when you come back
  saves into a new conversation from that turn on (until then the header
  no longer says "saving to History": nothing is). A turn that was still
  getting ready when Go was left (drawing the cast, creating its
  conversation) is stored in a conversation that is never kept open: it
  ends once that turn has its answer (`web/src/conversationLife.ts`). A turn still on its way
  when the conversation ends is stored in it first: the browser sends End
  once that turn has its answer (except when the page is going away), and
  on the server End waits for a turn it already holds and refuses, before
  anything runs, a turn that arrives while it is ending. A
  conversation nobody ended is ended two hours after its last turn, by the
  next request that touches that learner's conversations (not while a turn
  for it is running), and its end is that last turn. A turn on an ended conversation (another device, two idle
  hours) or a deleted one is refused before anything runs, and the Go tab
  starts a new conversation with that turn and sends it again.
- **Reload.** A reload ends the conversation (it is in History) and the Go
  tab starts fresh: the history lives in the browser, and reading it back
  from the database is a later step.
- **History** lists past sessions, newest first, 20 at a time, with the
  date, length (start to end, or to the last turn while open), turns and
  summary (empty until the post-session recap exists). Opening one shows the
  transcript read-only, glosses tappable as in the session, without audio.
  Delete removes it and its turns for good, after a confirm.

## Settings

Saved **per user**, in the database (`user_settings.voice`, docs/DATA.md;
before logins this was `data/voice.json`, which now only seeds the first
admin): two people sharing the app keep their own voices. Every voice route
needs a login, and a turn or cast runs in the active learner's mode (a body
`mode` that disagrees is a 400). One turn at a time per conversation (a turn
that isn't being saved: per login session), so two people, or two devices,
practising never block each other, and one session can't race itself (a
second turn while one runs is a 409). The settings are: voice provider, speech-to-text
provider, ElevenLabs model (Eleven v4 by default; Flash v2.5 is fastest and
cheapest), Claude model for the dojo master, turn-taking, the last session
length per mode (`sessionMinutes`, set from the Go tab's picker), and a voice per
**slot per locale**. A slot is a speaker and a gender (Narrator · woman,
Character · man, …). Each slot is **🎲 Random** (the default) or a voice you
chose. Voices are kept per locale, so a Mandarin voice choice survives a switch to a
Spanish pack and back. Languages map to locales in `scripts/voice.mjs`
`localeFor`; a test fails if a language in `content/languages.yaml` has no
locale.

## The cast: new voices every session

At Start, `POST /api/voice/cast` draws the session's voices
(`scripts/voice.mjs` `pickCast`). A slot you set keeps its voice. A Random
slot draws a native speaker of its gender, distinct from the others where it
can: for ElevenLabs, from the 40 most-used Voice Library voices for the locale
(a paid plan can use library voices by id, so nothing is added to the
account), and for Azure and macOS, from their own voices for the locale:
native voices of that gender, then native voices with no gender label, and
only then other locales' voices; macOS sound-effect voices (Albert,
Bubbles, …) are labelled "novelty" and never drawn. If ElevenLabs refuses a
drawn library voice (400, 402, 403, 404 or 422: statuses that mean this
voice can't be used, not a bad key, spent credits, a rate limit or a
transient error), the line is retried in your voice for that exact slot,
else in the slot's fallback, else in a voice borrowed from another slot
(`speechVoices`). For ElevenLabs `/cast` names a distinct account voice of
the slot's gender as each slot's fallback, premade voices first, since any
plan can speak with those (`castFallbacks`). Once a retry works the library
voice counts as refused: later lines go straight to the retry voice, and
later casts skip it, for the rest of the server's run.

**One language's voices only.** A voice native to a third language reads the
target words in its own (a German voice says 一 as "Ich"), so a draw never
leaves the session's two languages. The library search is for the target
language, narrowed to the locale in the library's own spelling
(`elevenLibraryLocale`: Mandarin is `cmn-TW` / `cmn-CN` there, not `zh-TW` /
`zh-CN`, and a locale it doesn't know is a 400). With fewer than four voices
for the exact locale, or a locale the library refuses, the search widens to
every voice of the language (another Mandarin for Taiwanese Mandarin); the
exact-locale voices are still drawn first (`exact`, in `pickCast`), so the
others only fill the parts left over. A locale the library doesn't list
(de-CH) is searched by language from the start. Cantonese (`zh-HK`) is not
searched at all: the library files it under `zh`, which returns Mandarin. A
timeout, rate limit or bad key is not retried wider, and every failed search
is logged (`[voice] library search …`).

With no library voice, the account's voices native to the target are used,
then those native to the learner's own language (from the learner on the
session; `nativeLocale` in the `/cast` body only when the learner has none),
then ElevenLabs' premade voices, which any plan can speak with: an accent
beats silence, and that is the one case a voice of another language speaks.
The fallbacks follow the same rule. Gender gives way before language: an
account whose only English voices are women's has a woman read a man's
part rather than hand it to a German man.

**Ages.** The dojo master writes a `CAST:` line (shown, never spoken;
`parseCast`) whenever someone speaks for the first time or a different
person takes over a voice tag: `CAST: CHARACTER-F old, Doña Carmen, the
fruit vendor`. The age is one of child, young, middle-aged or old right
after the tag, followed by a comma (or other punctuation, or the line's end) (also read: "elderly", "middle age", "aged 70", "7-year-old";
under 13 a child, under 30 young, under 60 middle-aged). Only that place is
read: a free description ("an elderly woman", "the old man's daughter")
was misread too often, so a line without the word there is ignored and the
slot keeps its voice. Who they are is what follows, after a comma, dash or
semicolon. The turn reply carries these as `castNotes`, and they go back
in the replay. When a Random slot's voice is the wrong age, the browser
recasts just that slot (`/cast` with `ages`, `slots` and `avoid`) before the
turn plays: for ElevenLabs a library search filtered by age (young, middle
aged, old; a child takes the youngest), else the locale's library voices of
that gender nearest the age, else the provider's own voices nearest it
(`castPools`, `poolFor`). If the library can't be reached during a recast,
the slot keeps the voice it has (never an English account voice), and the
next turn tries again. The slot's fallback is recomputed against the other
slots' (sent in `avoid`, which also keeps the drawn voice off the other
slots' voices) and nearest the age, so a character never falls
back to the narrator's voice. A character who comes back keeps the voice
they had. Voice lists carry ages where the provider
labels them (ElevenLabs; macOS Grandma and Grandpa). A slot you set keeps
its voice. The
cast holds for the whole session, so each character keeps one voice. Restart
draws again, and the header lists who is playing whom.

The narrator's gender is drawn too, unless the pack's narrator unit fixes it
(`narrator-female`, `narrator-kids-male`, …). The default
`narrator-native-rotating` asks the model to "pick at random", but a model
picks the same gender every time, so the app makes the draw and states it in
the system prompt (`narratorDirective`).

## Cost (rough, Nov 2026)

The header shows characters spoken this session. ElevenLabs Eleven v4 runs about
$0.10 per 1,000 characters (Flash about half); Azure neural voices about $15 per
million. A 20-minute session is roughly 9,000 characters. Claude turns run on
your Claude Code login.

## Limits

- Speech-to-text tends to quietly correct mispronunciations, so the dojo
  master can't judge *how* something sounded (the adapter tells it so).
  Pronunciation scoring (Azure pronunciation assessment) is a follow-up.
- Not streaming: each reply arrives whole, then plays line by line.
- Only text is saved (no audio), and a saved session can be read in
  History but not picked up again: after a reload the Go tab starts fresh.
