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
- **Recall** (docs/DATA.md §Recall in sessions, "As built (phase 6)").
  The pack's recall unit puts a few bank phrases (due, in trouble, starred)
  in the system prompt, chosen once when the session's conversation is
  created and stored with it, so every turn and the recap see the same
  list; the Go tab shows it under "How long do you
  have?", closed ("Revisiting 4 phrases from your bank"). Each turn also
  appends bank phrases matching the learner's words or the dojo master's
  last line, with how well they're known, after the learner's message.
  The dojo master may answer a question about past practice with one
  `LOOKUP: <query>` line: the server searches the bank and past sessions'
  recaps, asks once more with the results, discards the first reply and
  records the lookup on the turn. The LOOKUP line is never spoken. If the
  second call fails or times out (45 s), the first reply's spoken lines
  stand, or the narrator says "I couldn't look that up just now. Let's
  carry on." (English, fixed). The bank is read once per turn with no
  locks (words only; about 5 ms at 600 phrases, 50 ms at 6,000);
  `LINGO_DEBUG_RECALL=1` logs each turn's timing to the server console.
- **Shown-not-spoken lines** (`GLOSS:`, `CHOICES:`, `STAGE:`) are matched by
  their exact upper-case label (`OPTIONS:` is an older name for
  `CHOICES:`), with or without a speaker tag (any case) or a timing mark in
  front, so a spoken "Options: …" stays speech. `LOOKUP` is matched in any
  case with a colon or a dash ("Lookup -", "lookup:"), since a spoken
  lookup would leak the query; "Look up at the sky" stays speech.
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
  and defaults to Pinyin; the same switch is on a History transcript,
  the phrase bank and Practice (over the target words only where a card
  already shows them: a recognize prompt, the answer once it is out), and
  nothing shows for a language without a reading aid.
  The readings come from the browser, not the dojo master or a model:
  `web/src/script/zh.ts` runs pinyin-pro word by word (so 銀行 reads yín
  háng, 長大 zhǎng dà) over the text spelled in simplified characters one
  for one (its word list is simplified; the table is Unihan's), then
  applies Taiwan's standard readings for a zh-TW profile (星期 xīng qí,
  垃圾 lè sè). A traditional character that shares its simplified form
  with another keeps a reading of its own (髮 fà, never 發's fā; 幹 gàn,
  not 乾's gān). The library reads every 地 dì, 得 dé and 儿 ér, so a few
  narrow rules fix the particles: 地 is de only after listed adverbs (慢慢地,
  開心地) and never where it starts a word (看看地圖); 得 is de only after
  a listed verb and before a degree word (跑得很快), never after a pronoun
  (我得走 děi, 他得滿分 dé); 儿 / 兒 is the r of erhua closing listed words
  (這兒, 一點兒, 小孩兒) and stays ér in 兒子, 女兒, 兒童. Anything the rules
  don't list keeps the library's reading. Tone marks are each character's
  own tone (no sandhi), as dictionaries print them. The
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
  stroke, 🔊 Hear it), its readings in pinyin and zhuyin, each with a
  speaker button and every part tappable, a sound chart (all of these
  through the cached `/api/voice/sound`: §Character sounds), meaning, radical, stroke count, its simplified or traditional
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
  there. The licence text itself is served at `/hanzi-data/ARPHICPL.txt`
  (one fixed path, not a file route) and linked from the card's footer.
- **Readings can be wrong.** They are generated, not checked by a teacher,
  and the card's footer says so (and the switch's tooltip). Known gaps:
  readings follow the library's (mainland) norms apart from the small
  Taiwan table, so a zh-TW text can show a neutral tone where Taiwan says a
  full one (頭髮 is fixed; most such words are not); a word the library
  doesn't know is read character by character, each with its usual
  reading; 得 meaning "must" (děi) or "get" (dé) is left
  to the library, which reads dé for both; erhua is only fixed for the
  listed words; 著 reads zhe or zháo by context and 著名 zhù only for the
  listed neighbours. The fix for one is a test in
  `scripts/tests/script.test.mjs` and an entry in the tables in
  `web/src/script/script.ts`.

## Saved conversations

Every session is saved for the active learner's current language, turn by turn, and listed in
the Library tab's **History** (docs/DATA.md §Conversations has the tables).

A scene played before builds on its last attempt (docs/DATA.md §Revisit):
for adults, every turn's system prompt ends with a **Building on last time**
section (the earlier recap's summary, corrections and kept phrases, between
`[LAST TIME IN THIS SCENE]` and `[END OF LAST TIME]`), and the Go tab says
which session it builds on. History's **Practice again** loads a session's
pack, as played, into the Go tab.

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
  the recap's summary. Opening one shows the transcript read-only, glosses
  tappable as in the session, without audio, with its session recap below.
  Delete removes it and its turns for good, after a confirm.
- **Session recap.** After End, a card under the transcript waits quietly
  while one model call reads the session (in the background; End never
  waits for it), then shows a summary, the phrases kept (☆ Star, a link to
  the bank), what went well and what to work on. How you did on each phrase
  becomes a review in the bank's schedule. If it fails twice the card
  offers Retry recap. docs/DATA.md §Post-session extraction has the rest.

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

## Practice drills: phrase audio and speak-it

The Practice tab's listening and speak-it drills (docs/DATA.md §As built
(phase 7b)) use the same providers and keys, server-side only:

- **Phrase audio.** `GET /api/practice/audio/:phraseId` says one of the
  active language's phrases with your TTS provider in your voice for that
  language (the narrator's slot first; with none picked, the default voice:
  see §Default voice). The synthesis is
  `/api/voice/speak`'s (`synthesize()` in `web/server/voice.ts`), with no
  cast and no retry in another voice. The audio is cached on disk
  (`scripts/audio-cache.mjs`): `data/audio/<sha256>.mp3` (`.wav` for macOS
  voices), keyed on the user, provider, voice, model, output format,
  locale, speed and text, so a replay and the next session never pay
  again; changing any of them is a new file. `LINGO_AUDIO_DIR` moves it (else `<LINGO_DATA_DIR or data/>/audio`)
  and `LINGO_AUDIO_CACHE_MB` bounds it (default 256 MB, least recently used
  first). Writes are atomic; the route takes a phrase id, never a hash or
  text, and files are per user, so the cache can't be used to hear or
  time another account's phrases. Hit or miss is logged, never sent. A
  macOS voice setup with no voice installed for the locale is a 400, not
  the Mac's own-language voice. Paid calls from these routes (an audio
  miss, a transcription) run at most two at once per user (429 beyond).
- **Speak-it.** `POST /api/practice/transcribe` takes the recording (the
  same 16 kHz WAV as a turn) and answers `{text}` with your STT provider
  in the language's locale. Unlike a turn it sends **no keyterms**: the
  expected answer would be heard into the transcript. Only a WAV
  (`audio/wav`, `audio/wave`, `audio/x-wav`; else 415), at most 8 MiB. It
  records nothing; the answer is sent after you see what was heard. The
  card lets go of the microphone, and cancels the transcription, when it
  goes, even while the microphone is still opening.

## Default voice

Every slot may stay Random: a session's cast draws voices for them. A line
said outside a session has no cast, so when no voice is saved for the
locale (`voiceFor` finds nothing, borrowing included) the server picks one
(`defaultVoice` in `scripts/voice.mjs`, used by `/api/voice/speak`, the
phrase audio and `/api/voice/sound`):

- **ElevenLabs:** a premade voice of your account (any plan can speak with
  them; voices added from the library can be refused), a native speaker of
  the locale's language first, of the narrator's gender when the line
  names one. With no premade voice at all, a native voice of the account.
- **Azure:** the locale's first voice of that gender, else its first voice
  (a voice that only lists the locale as a secondary one, only when there
  is no other).
- **macOS:** the locale's first installed voice. With none installed, the
  Go tab still speaks with the Mac's own voice, as before; a phrase or a
  sound is a 400 (that audio would be cached).

The provider's voice list is read once per server process (an hour at most
for the paid ones, keyed by provider and a hash of its key; a failed read
is kept for 30 seconds), never once per line. The default only stands in for "no voice saved": a provider
without its keys is still the 400 that says which keys to add. The Practice
tab's setup check (`voiceReady`) asks no provider: it reports a missing key
or a missing macOS voice, never "no voice picked".

## Character sounds

The character card (`web/src/components/CharCard.tsx`) plays sounds through
`POST /api/voice/sound {text, locale}` (`handleVoiceSound` in
`web/server/voice.ts`, mounted with `learner: true`): Hear it, a speaker
button per reading, each pinyin initial and final, each zhuyin symbol and
tone mark, and the sound chart (`SoundChart.tsx`: the 37 zhuyin symbols as
initials, medials and finals, and the five tones). The route only takes 1
to 4 Han characters (400 otherwise, before any provider call; zhuyin and
tone marks are heard through exemplar characters, never sent), so it can't serve as a general text-to-speech cache on
the owner's credits. It speaks in the narrator's voice for the locale as
above, through the phrase audio's disk cache (`audioKey`/`cachedAudio`,
keyed per user; `paidSlot`; `Cache-Control: private, no-store`): the same
text, voice and locale is synthesized once. The page also keeps each
sound's audio for its own life (`useSound.ts`).

A voice given a lone character says its usual reading, so every sound is an
exemplar character (`web/src/script/sounds.ts`, checked against pinyin-pro
in `scripts/tests/sounds.test.mjs`):

- **A reading:** the first is the character itself. Another reading of a
  character with several is said by a common character read *only* that
  way (行 háng: "as in 杭"), found by `zh.ts` `exemplars()`: pinyin-pro has
  no reading → character lookup, so the first time a card needs one it
  reads every common character of the learner's script (Big5's 5,401
  for zh-TW, GB 2312's 3,755 otherwise, both from the browser's own
  `TextDecoder`) and indexes the ones with a single reading. A reading
  with no such character has its button disabled, saying why.
- **A zhuyin symbol** (and the pinyin initial or one-symbol final that
  matches it): a fixed table of the classroom names (ㄅ 玻, ㄆ 坡 …), with
  the ones whose character had another reading replaced (ㄉ 德, ㄌ 叻, ㄏ 河,
  ㄙ 絲, ㄛ 噢). ㄝ, ㄟ and ㄥ have no character of their own: they are heard
  in 耶, 黑 and 燈. ㄈ keeps 佛 (no character is read only fo; its usual
  reading is fó). A final of several symbols (ㄧㄤ) is its syllable with no
  initial, from the same index. The i of zhi chi shi ri zi ci si plays
  nothing: the initial is the whole syllable.
- **Tones:** 媽 麻 馬 罵, and the neutral tone as the second syllable of
  媽媽 (嗎 alone may be said má).

A mainland learner sees and hears the simplified forms (`inScript`).

## Pronunciation

Speech-to-text is generous: a wrong tone still transcribes as the right
word, so the dojo master never hears about it. `scripts/pronunciation.mjs`
scores a recording against the text it was meant to be. Stage 0 (bead
ld-ne0.1) is the engine described here; stage 1 (ld-ne0.2) calls it where
the text is known, Practice's speak-it and the character card (§Pronunciation
in the app, below). Nothing is stored. v1 scores Mandarin tones (zh-CN and
zh-TW; `scoresTones(locale)`).

One result whichever engine ran:

```
{ provider: "azure" | "local",
  syllables: [{ char, pinyin, baseTone, expectedTone, accept, heardTone,
                verdict: "ok" | "off" | "unsure", confidence, reason?,
                margin?, score?, startMs, endMs, pitch }],
  overall? }
```

`verdict` is `off` only when the engine is confident; whatever it can't
vouch for is `unsure`, with a `reason` (`short`, `unvoiced`, `creaky`,
`neutral`, `untimed`, `octave`, `apart`, `soft`, `clipped`, `timings`,
`edges`, `lopsided`, `trimmed`, `scattered`, `background`, `track`,
`unclear`, `omitted`). A syllable read through creak also carries
`creaky: true`; a creaky `ok` is half a measurement and is left out of
`overall`. A false alarm costs more than a
miss. `margin` is how far the contour is from the nearest right answer, in
semitones (0 or more: every accepted tone is ruled out). `pitch` is the syllable's curve for drawing: 16 points in semitones
above or below the speaker's median, `null` where unvoiced;
`referenceCurves()` makes the same from the narrator's clip.

**Which engine** is a pure function of the keys, `pronunciationProvider(keys)`
over `voiceKeys()`: Azure when `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION`
are both set, else local. No other paid service.

**What should have been said.** `expectedSyllables(text, readings)` takes
each character's dictionary reading (`readCodePoints` in
`web/src/script/zh.ts`: pinyin-pro with the Taiwan readings and particle
fixes, so 星期 expects qí for zh-TW and qī for zh-CN) and applies the
connected-speech rules before anything is compared:

- third-tone sandhi: the third tone before the last of a run rises (你好
  ní hǎo); further back both readings are accepted (我很好), since the
  grouping needs word boundaries;
- 不 is bú before a fourth tone; 一 is yí before a fourth tone and yì before
  the others, yī at the end and in numbers (第一, 十一, 一九九八), with both
  accepted where only a word list could tell (一月, and any 一 after another
  syllable, which may be the end of a word: 统一了, 唯一的); A不A and 看一看
  accept the neutral reading too;
- a third tone doubled into a neutral one (姐姐, 奶奶, 宝宝) may rise
  (jiéjie) or stay low: both are accepted;
- the half third: a third tone before another tone is low without the rise,
  and counts as a third tone;
- the neutral tone is not judged.

Each syllable carries `accept`, every tone that counts as right, which is
deliberately wider than `expectedTone` wherever the rule is uncertain. Not
handled: sandhi that depends on word grouping beyond the above, 儿 endings,
and Taiwan's fuller (less neutral) second syllables, where a zh-TW learner
saying a full tone on a syllable the reader marks neutral is simply not
judged.

**The local scorer** (`scoreTones`) is pure JS on the 16 kHz mono WAV the
browser already sends, with no dependency:

1. `trackPitch`: YIN (de Cheveigné & Kawahara 2002) every 10 ms over
   60–800 Hz, written out in the module (sixty lines, nothing native).
   Octave slips are undone per voiced run (a short piece an octave from
   the rest of its run), never across a silence. Each frame also carries
   its zero-crossing rate, which tells creak from the hiss of s or sh.
   The track carries its pitch twice: `f0`, finished on the whole
   recording (silence floor, octave repairs, range gate), for drawing;
   and `rawF0`, from before those steps, which is what `scoreTones`
   reads. It is a plain field, so a track survives a structured copy (a
   worker's `postMessage`, a cache that keeps typed arrays). It does not
   survive JSON, which turns a typed array into an object with no
   length: such a track is not used at all. A track without a usable
   `rawF0` is tracked again from the samples, and with no samples
   nothing is judged (`track`). The recording's length (the 30-second
   limit, "inside the recording") is taken from the samples when they
   are passed, else from a usable track; never from a copy's arrays.
2. Where the speech is. A push-to-talk recording has a second of room
   before and after the words, with key presses, knocks, coughs, another
   voice, a hum. There are two ways of knowing where the syllables are,
   and they are not equals.

   **With `timings`** (one `{ startMs, endMs }` per syllable from a
   recogniser whose extents can be trusted: Azure's per-syllable
   `Phonemes`, through `mergeAzure`). This is the way to score a real
   microphone. Pitch is measured inside each span and nowhere else: the
   silence floor, the octave repairs, the range gate and the recording's
   own range are all redone on the spans' frames alone (from `rawF0`),
   so nothing outside the spans it is given can change a verdict.

   That is true by construction and only as good as the spans. **It
   assumes the recogniser draws the same spans on a noisy recording as
   on a clean one, and that has not been measured**: the proof's noise
   rows on timings reuse Azure's spans for the clean clips. So the spans
   are doubted too (`TIMING_RULES`):
   - Checked first (`timingsProblem`): one per syllable, in order, each
     40 to 1500 ms, inside the recording. If not, every syllable is
     `unsure`, reason `timings`, and the result's `timingsProblem` says
     why: never a guess from energy.
   - `edges`: the recording is read again with all spans 40 ms earlier
     and later and with each boundary between neighbours 40 ms either
     way (`jitteredTimings`, at most 2n more readings), and a verdict
     stands only where every reading gives it for the same tone. (A
     reading where the moved span merely takes in a separate sound,
     `apart`, is not held against it.) A span that a move would leave
     under 40 ms (a short one at the end of the recording) stays put in
     that reading while the others move; a syllable whose own span moved
     in no reading at all is `edges` too, since no readings agreeing is
     not agreement. The result's `readings` says how many were made.
   - `lopsided`: of two neighbouring spans, one with hardly any voice in
     it, or one under 100 ms beside one three times its length. One span
     has the other's sound; neither is judged.
   - A word Azure times as a whole is cut by energy inside that word's
     span only, and those cuts are marked `rough`: they count for what a
     fallback cut does (`FALLBACK_TRUST`).
   What the guards cost and what wrong spans still get through is the
   proof's "When the spans are wrong" (and in small in `npm test`).
   **The jitter, sliver and lopsided values were chosen on the same
   clips and the same span errors that table measures: it is in-sample.**
   What it supports: spans 50 ms off, or with one boundary 50 ms off,
   are mostly withheld (2 to 6 wrong tones still pass as ok in some 750
   to 1500 phrase syllables). A span that swallowed its neighbour is
   withheld when the neighbour is left a sliver (60 ms: 0 and 1 wrong
   ok), which is the case the sliver bar was set for; leave the
   neighbour 110, 130 or 160 ms and 14, 9 and 8 wrong tones pass as ok,
   with one false alarm. Spans 100 ms off and more pass some wrong tones
   as ok as well. On generated syllables run together (20 ms apart,
   `npm test`) the off-design rows and the 100 ms rows also produce
   false alarms.

   Scribe's character times are where the
   recogniser emitted a character, not a syllable's extent: they are
   `anchors` for the energy cuts at most, never `timings`.

   **Without** (the fallback). The speech has to be found by energy
   (`TRIM_RULES`: voiced runs of 80 ms or more within 12 dB of the loudest
   voiced frame are speech by any measure; 250 ms is kept before the
   first and 120 ms after the last). Five rounds of review each found a
   sound that the bars took for speech or speech they took for noise, so
   the bars are not believed. The rule: any doubt about where the speech
   is ends in `unsure`, for an `ok` as much as for an `off`.
   - A run that may or may not be speech (anything else within 200 ms of
     the sure runs; in a phrase, any run within 26 dB wherever it is) is
     read both ways, in every combination with the other doubted runs (up
     to three: eight readings), and a verdict stands only where all
     readings give the same verdict and the same tone. The rest is
     `trimmed`.
   - Sounds long enough to be a syllable that lie more than 200 ms
     apart leave the whole recording unjudged, `scattered`: one may be a
     cough, another voice, a chair, or the speaker paused, and reading
     them all as speech puts the cuts on the wrong characters. "Long
     enough" is 60 ms of sound, which is a voiced run of 90 ms in the
     track (a frame's analysis window reaches some 15 ms past each end of
     a sound): a 40 ms knock is a 70 ms run and is not one. It is
     doubted instead, like any other stray run.
   - More than three doubted runs: not read at all (`trimmed`).
   Every number in `TRIM_RULES` was chosen on 43 real clips from ONE
   speaker (as was the half weight of a creaky `ok`); none is held out.
   `trimToSpeech` is the bars' opinion alone, for drawing and the proof.

   **Either way**, a pitched background (a voiced stretch of 300 ms or
   more, softer than the speech, holding its pitch within half a
   semitone: mains hum, a fan) leaves everything unjudged, `background`:
   it is under the syllables too. It is the one thing outside the timed
   spans that is looked at, and it can only withhold verdicts.

   What this costs and what it still lets through is measured, per
   syllable against the clean clip: the proof's "With lead-in noise"
   (`scripts/pronunciation-synth.mjs` makes the disturbances), and in
   small in `npm test`. On timings nothing outside the given spans moves
   a verdict (with the assumption above). By energy, a stray sound costs
   most of a phrase's verdicts and makes none: under noise the fallback
   is safe, not useful, and its caution costs right answers on clean
   clips as well (the rework took right syllables marked `ok` from 89.1%
   to 85.9% for single syllables and from 70.8% to 66.1% in phrases).

   A recording that is loud in its first 20 ms started inside a
   syllable: the syllable whose span begins there (it starts under 20 ms
   in, `clippedMs`) is not judged (`clipped`), on either path. A route should ask for such a recording
   again. (The proof scores its synthesized clips, which begin with
   their first sound, behind 200 ms of silence for this reason.)

   **Not made safe on either path**, because the disturbance is inside
   the syllable: a pitched knock on top of the first sound, and a room
   that echoes.
3. Cuts: the `timings`, or else `segmentSyllables`, which cuts the speech
   at its quietest, least voiced frames given the syllable count, kept on
   Scribe's character times when those are passed as `anchors` (below);
   no piece may be longer than three even shares, which bounds the search.
   Its cuts scale the reported confidence (`FALLBACK_TRUST`), and a flag
   on any syllable of a phrase needs a little more margin
   (`phraseMarginSt`), whoever made the cuts; neither is mixed into
   `quality`, which is only how clean the pitch measurement was. A span
   that holds two voiced sounds with 50 ms or more of silence between
   them is not one syllable (`apart`: the span is wrong, or a knock is in
   it), and a syllable whose loudest frame is 20 dB under the loudest
   syllable's is too soft to judge (`soft`).
4. `classifyContour`: five points of each syllable's voiced part against
   tone templates on Chao's five-level scale, scaled to the speaker's own
   range (`speakerRange`: pass one learnt from earlier turns as `speaker`;
   without it only the shape counts, each template stretched to the
   contour, plus the recording's own range from four syllables up). So a
   child's voice, a low adult voice and a narrow one are read the same way.
5. The verdict. `ok` when an accepted tone is the best match or holds a
   third of the belief. `off` only when the contour *rules out* every
   accepted tone, the measurement is clean, and the syllable is long
   enough. `ruleMargins` says by how many semitones each tone is ruled
   out, from features of the shape (the span, the dip before the lowest
   point, the rise from it to the end, the fall from the highest point to
   the end) and, in a voice whose range is known, of the height (where it
   starts, how high or low it sits):
   - tone 1 by three semitones of movement, or by sitting low (only in
     the first two syllables of a phrase: sentences drift down, and "low"
     is read against the whole voice);
   - tone 2 by not coming up at the end while falling or level, or by a
     deep dip that barely comes back;
   - tone 4 by not coming down at the end while level or rising, or by
     ending on a rise;
   - tone 3 by a high level pitch, by a fall that starts high in the range
     (so a fourth tone said for a third is caught), or by a plain rise
     with no dip that starts at mid-range or above. All three need the
     range, and the last is silent when the start of the syllable is
     hidden (creak or a burst before the first voiced frame): a third tone
     that starts at the floor has no fall to show.

   With a known range the semitone bars scale with it (`scaleRange`; the
   range counts between 7 and 12 semitones, so a very wide voice, a small
   child's, is still held to a 12-semitone voice's bars).

   Still never flagged: a low fall said for a fourth tone, and second
   against third when the second dips or the third comes back up. A level
   pitch in the middle of a known range rules nothing out (a syllable
   squeezed flat by its neighbours). Creak in the vowel can confirm
   but never flag: it supports an expected third tone, any other tone is
   `ok` when its voiced part fits and nothing rules it out (at half
   confidence: a low voice creaks wherever a tone touches the bottom of
   its range, the end of a fourth tone as much as a third), and otherwise
   the syllable is `unsure` (`creakFlags` lets creaky syllables be
   flagged; off). A pitch track that jumps seven semitones or more
   between neighbouring frames is cut there; a piece of three frames or
   fewer is a glitch (at the edge of a voiced run, in the middle of a
   vowel, or the neighbouring syllable's pitch where two meet without a
   gap) and is dropped. A jump that remains between the pieces that stay
   is an octave slip the tracker didn't mend (it mends 80 ms or less), and
   so is a contour with no piece longer than a glitch, or a third of it
   and more in glitches, or a glitch taken out of the middle of a vowel
   that is creaky as well: `unsure`, reason `octave`, whatever the label,
   and checked before the creaky-third rule (a slipped stretch reads low,
   which is what that rule looks for).
   The thresholds are `TONE_RULES`; `offMarginSt` is the one knob that
   trades catches for false alarms.

How well that does on synthesized speech, and what it has not been tested
on, is in [pronunciation-proof.md](pronunciation-proof.md), written by
`node scripts/pronunciation-proof.mjs` (not part of `npm test`; `--fetch`,
`--scribe` and `--azure` are the only steps that call a provider and must
be asked for). The thresholds were chosen on two voices and measured on the
other two; the report leads with those held-out numbers and labels
everything else in-sample, and has the trade-off at several margins and the
classifier's raw accuracy before any gate.

**Before wiring it to a route:**

- Start with single syllables and drills. Phrase flags rest on a
  half-semitone margin (`phraseMarginSt`) that the proof clips chose.
- Pass `speaker` only as a range built from the learner's *other*
  recordings (`speakerRange` over earlier turns), never one that includes
  the recording being scored.
- Pass `timings` (Azure's, through `mergeAzure`). Without them the
  scorer has to find the speech by energy, and in a room with any stray
  sound it will mostly say `unsure`. `timings` that are not a list are a
  timings problem (`timings`), never a quiet fall back to energy.
- Before trusting the timings path in a real room, check the
  recogniser's spans there: the same speech clean and with a knock, a
  cough, another voice, and compare the spans that come back. The proof
  does not measure this.
- `scoreTones` is synchronous and refuses more than 30 seconds
  (`LOCAL_MAX_SECONDS`) or 60 syllables (`LOCAL_MAX_SYLLABLES`). That
  much takes about a third of a second, most of it the pitch track (the
  proof's "Speed"); the energy path reads the recording up to eight
  times, the timings path once and then up to 2n times with the spans
  moved (under 100 ms in all for 60 syllables). Run it off the request
  thread (a worker, or the paid-slot queue); a track made on one thread
  can be scored on another, since `rawF0` travels with it.
- Treat `unsure` as silence.

**Real recordings are the next step**, and there is a tool for making
them: `npm run pron:record` (`scripts/pronunciation-record.mjs`, pure half
`scripts/pronunciation-recordings.mjs`, page `scripts/pronunciation-record.html`)
serves one self-contained page on `http://127.0.0.1:38410`. It is not part
of the app: no app route, no database, no login; loopback only, requests
for any other Host refused, POSTs taken only from its own Origin, and a
Content-Security-Policy that lets the page load and send nothing
elsewhere. It walks a speaker (a nickname, adult or child) through the
proof's 31 syllables and phrases said as shown, then 12 syllables said in
another tone on purpose, each with the proof's cached clip as the model
(a prompt with no cached clip is left out; no new paid calls). The page
records with MediaRecorder and writes 16 kHz mono PCM WAV in the browser,
as the app does, with three differences: the browser's echo cancellation,
noise suppression and automatic gain are asked off (raw audio can be
degraded later, processed audio can't be undone; each clip's label says
what the microphone track reports it applied, `getSettings()`, not what
was asked: `raw` only when all three are reported off, so a browser that
doesn't report them all, as Safari probably doesn't (not tested), labels
every clip `processed` even when it did record raw); the recording is decoded
straight at 16 kHz, so the browser's decoder does the resampling (band-limited,
though loosely in Chromium: see §The recorder, whose JS filter the app's
recorder now uses instead); and it keeps recording 250 ms past Stop, for the end of a third
tone's rise. Clips go to
`data/pronunciation-proof/recordings/` (gitignored; the tool refuses to
start, and the proof to write its report, where git would track them or
already tracks a file) under generated names, with one line each in
`labels.tsv`: file, text, what they were asked to say when not the text,
speaker, group, the speaker's own "not sure I said it right", and
`processing` (`raw` or `processed`; a line without it, as in the first
recordings, is read as `processed`). A clip is kept only once its line
reads back from the file. The page names a prompt by its text and what was
asked, so a tab left open across a restart is told to reload rather than
filing a clip under another text. A name is one person whatever its
capitals, in the group first given; a typed name that already exists is
asked about ("Carry on as …"), never merged silently. What a key does
is one pure function (`keyAction`, whose source the recorder puts into
the page, so `npm test` runs the page's own code): space records and
stops even over a focused button, only the checkbox keeps it, and the
model clip never plays while the microphone is recording.
What is done is derived from that file, so a session resumes. After each
kept clip the page prints the local scorer's verdict as a test readout,
not a grade. `npm run pron:proof` (`pronunciation-proof.mjs --recordings`)
scores them per speaker: catches on the deliberately wrong clips, false
alarms on the rest, the "not sure" clips counted apart, and each speaker
once per recording setting when the labels hold both. Those results are
a person's: they go to the terminal and to `recordings/report.md`, never
into the tracked report. A label is what the speaker aimed for, not what
came out, so a beginner's false-alarm count is an upper bound until
someone fluent has listened to the flagged clips. The steps for the
person recording are in the report's "Real recordings".

Real recordings are scored by energy unless their speaker decides
otherwise: nothing sends a person's voice to Azure or any other provider
by default, and in a real room the energy path mostly answers `unsure`
(above). The timings path needs per-syllable timings. The proof has one
opt-in step for that, `--recordings --azure-recordings` with
`LINGO_PROOF_AZURE_SPEAKER` naming the one speaker whose own clips may
go to Azure Pronunciation Assessment. Clips go only when that name is
labelled adult on some line and nothing else on any (`azureSendable`: a
child labelled once and left blank afterwards has nothing sent). One
clip each, sent again only after a rate-limit refusal; the reply is kept
in the gitignored `recordings/.azure/`, 0600, and a clip with a reply is
never sent again. The clips that have a reply are then reported both
ways, with every clip's verdicts on the timings path in the gitignored
report. Only the speaker can decide to run it.

**The Azure adapter** (`azurePronunciationRequest`,
`azurePronunciationResult`, `mergeAzure`) was built from Microsoft's
documentation and then **run live for zh-CN** (2026-11-18, eastus, free F0
tier, 316 requests over the proof's synthesized clips; numbers in the
proof's "Azure, live"). It posts the same WAV to the speech-to-text REST API
for short audio (`<region>.stt.speech.microsoft.com`, key and region only)
with a `Pronunciation-Assessment` header (base64 JSON: `ReferenceText`,
`GradingSystem: HundredMark`, `Granularity: Phoneme`,
`Dimension: Comprehensive`, `EnableMiscue`).

From the docs: zh-CN, zh-TW, es-MX and es-ES are all supported locales;
audio is WAV PCM 16 kHz mono, at most 30 seconds with assessment; over REST
a reference text is required (unscripted assessment is an SDK feature, and
the docs themselves recommend transcribing first and assessing against
that), so for free speech the transcript is the reference text with miscue
detection off.

From the live service, which the docs don't say for Mandarin:

- Words are Azure's own segmentation (你好 is one word), but `Phonemes`
  holds one entry **per syllable**, named with a tone digit (`ni 3`,
  `hao 3`; 5 is neutral), each with its own offset, duration and score. So
  Azure gives per-syllable cuts, and `mergeAzure` uses them.
- The digit is the **reference** reading's dictionary tone, not the tone
  heard: 妈 assessed against 马 comes back `ma 3`, `DisplayText` "马。".
  Azure never says which tone was said.
- A wrong tone lowers the score, with wide overlap: on single syllables the
  median is 61 against 82 for the right tone, and Azure's own
  `Mispronunciation` mark caught 29% of wrong tones while also marking 4
  of 168 correctly said phrase syllables (the proof prints the counts
  under each score).

That is why `mergeAzure` always runs the local tone check as well, on
Azure's syllable timings: a tone flag comes from the pitch
(`reason: "tone"`); Azure adds a flag only where it marks the word
`Mispronunciation` and the syllable scores under 40 (`AZURE_RULES`: no
false alarm in the run at that bar; `reason: "sound"`). A high Azure score
never turns an unclear pitch reading into `ok`: wrong tones often score
above 80. The builder refuses audio that is not 16 kHz or is over 30
seconds. `scoresTones` and `azureLocale` read a locale through one parser,
so they cannot disagree: Mandarin is `zh` or `cmn` with no region or CN, TW,
SG or MY (`zh_TW`, `zh-Hant-TW`, `cmn-Hans-CN`), sent to Azure as zh-TW
(Taiwan, or Traditional with no region) or zh-CN; Cantonese (`zh-HK`,
`zh-yue`) and anything that isn't a plain tag are not scored and are
refused. Not yet run live:
zh-TW, Spanish, a recording near 30 seconds, a per-resource `endpoint`, a
real learner.

**Scribe's timings.** `transcriptText` keeps only `text` today. Scribe also
returns `words[]` with `start`/`end` in seconds and, when asked with
`timestamps_granularity=character`, a `characters[]` per word; for Chinese
it gives one `words` entry per character (measured, see the proof). The
times are roughly when the recognizer emitted each character, not where the
syllable starts and ends (好 timed 460–480 ms in a clip where it sounds
from 270 to 510), so they are useless as cuts and useful as anchors:
`scoreTones({ anchors })` cuts by energy and keeps each piece on its
character's time. A later stage adds the field to `elevenTranscribeRequest`
and keeps the words beside the text; `scribeCharTimings` and `alignTimings`
already read them. Only Azure's word timings go in as `timings`.

**Later stages** (beads ld-ne0.3, ld-ne0.4): live turns with a coaching
dial and a per-session `speaker` range; keeping flagged clips; the
transcript's per-syllable marks; the recap's tone score and the Practice
feed (speak-it failing a wrong tone).

### Pronunciation in the app (stage 1, ld-ne0.2)

```
POST /api/pronunciation/score?text=<Han text>[&readings=all]     body: the WAV (audio/wav)
→ { engine: "azure" | "local",
    fallback: null | "no_keys" | "failed" | "busy" | "limit",
    text, locale,
    syllables: [{ char, pinyin, expectedTone, accept, verdict,
                  usual?      (readings=all: the usual reading, when another was heard),
                  heardTone?  (only on "off"),
                  why?        ("tone" | "sound", on "off"),
                  reason?     (the engine's, on "unsure"; or "every_tone"),
                  startMs, endMs,
                  heard:      16 points, semitones about their own mean, null unvoiced,
                  reference:  16 points, the tone's textbook shape (null: neutral) }],
    overall: number | null   (null for kids),
    retry: "clipped" | null }
```

`web/server/pronunciation.ts`, mounted with wrap's `learner: true`; the
pure rules are `scripts/pronunciation-app.mjs`, the scoring runs in a
worker thread (`scripts/pronunciation-worker.mjs`).

- **Mandarin only.** The language's locale must pass `scoresTones`; any
  other language is a 422 with code `not_available` and the page shows
  nothing.
- **Validated before any provider call.** The text is 1 to 24 Han
  characters, with punctuation and spaces (which end a tone group and are
  never scored), nothing else, and every character must have a reading
  (`readCodePoints`, the page's own reader, for the language's locale). The
  audio is a 16 kHz mono 16-bit PCM WAV of 0.25 to 30 seconds (415, 400,
  413 otherwise; the body is capped while it is read, and one that takes
  over 20 s to arrive is a 408). The per-user and server limits are
  checked before the body is read.
- **`readings=all`: the character card only.** The card sends it (and
  Practice never does) for its one character, which is then judged against
  every reading the card shows for it (`charReadings`, its usual one
  first): 长 accepts cháng's second tone and zhǎng's third, 行 xíng's second
  and háng's or hàng's, 好 hǎo and hào, 为 wèi and wéi. An ok names the
  reading heard (`pinyin`, `expectedTone` and `reference` are that
  reading's) and, when it isn't the usual one, `usual` names that, so the
  page says "That's zhǎng, another reading of 长 (usually cháng)" rather
  than just "right"; a miss is shown against the usual one. A neutral usual
  reading stays neutral and unjudged (了 alone is le, as the card lists it,
  not liǎo). A character whose readings take all four tones (拉, 叉, 揣, 呵)
  can't be checked alone: "not sure" with reason `every_tone` and no score
  (著 has no third-tone reading, so it is checked). The flag on more than
  one character, or with any value but `all`, is a 400. Without it, a
  single character keeps its one reading like any phrase (Practice's 好 is
  hǎo only, 不！ bù only), and two or more characters keep their reading in
  context (长大 zhǎng dà).
- **Engine** (`scoringEngine`): Azure when `AZURE_SPEECH_KEY` and
  `AZURE_SPEECH_REGION` are set, merged with the local tone check on
  Azure's syllable timings (`mergeAzure`); the local scorer alone
  otherwise. **The same for kids learners** (the owner's decision,
  2026-11-19): a kids learner's recording goes to Azure for scoring, as it
  already goes to the transcription provider in a voice session. Only the
  reply differs (`overall` null), from the learner's mode as the session
  holds it (`learnerMode`; a `?mode=` that disagrees is a 400). Azure
  missing, failing (an error status, no answer in 15 s, a reply that isn't
  JSON or has nothing recognised, a malformed `AZURE_SPEECH_REGION`, which
  spends none of the per-minute calls), busy
  (the user's paid slots, `paidSlot`) or past the user's
  `AZURE_PER_MINUTE` (12 calls in a sliding minute) is never an error: the
  local scorer answers, which mostly means more "not sure" (`fallback` says
  why). One score at a time per user and two on the server (429 beyond).
- **Nothing is stored.** The recording is read into memory, scored in a
  worker thread (started per recording, stopped after 15 s), and dropped
  with the request; the text is read with the reader's cache off
  (`readCodePoints(text, locale, { cache: false })`), so it doesn't stay in
  the server's memory either. No migration; log lines name the engine, the
  syllable count and the kind of failure, never the text, the audio or
  anything Azure replied. Every failure leaves the route as an `HttpError`
  with a fixed message: a worker that hangs, crashes or answers something
  unusable is a 503 (logged "scoring failed (timeout|crash|error)"), a body
  slower than 20 s a 408, and a browser that drops the upload or the
  connection (before or while the body is read, or under the reply) a 499
  "cancelled", logged "the browser went away", its slots freed at once.
  `wrap` itself logs only the path of any other error, never the query
  string (it would hold the text). The reader's library, pinyin-pro 3.29,
  keeps no cache of its inputs (its maps hold dictionaries only).
- **The picture.** `heard` is the engine's `pitch` for the syllable,
  centred on its own mean, and `reference` the tone's Chao shape (the half
  third low without the rise) on the same scale (`stepSt`), so the page
  compares shapes only: without the learner's range, height means little,
  and the scorer then reads only the shape too. On the timings path a short
  recording (one syllable) has too few frames for a range of its own and the
  engine draws no curve for a syllable it did judge; the worker then draws
  it from the whole track's `f0` over the span (drawing only, never a
  verdict). The narrator's own curve is drawn only in compare mode
  (§Compare mode), which decodes the cached clip on the server.

The page (`web/src/components/ToneCheck.tsx`): one mark per character,
read in the profile's aid (pinyin, zhuyin or none). Adults: the accent
colour for ok, the error colour for a confident miss, a dotted underline in
the text colour for not sure, never a warning; a line "2 right · 1 not
sure". Kids: no score and no red (an error line too); ok in the accent
colour, a miss warm (`kiai`), whether the tone or (from Azure) the sound,
with "Let's listen and try that one again!" and a Listen button, not sure
shown as plain text and not tappable; a check that fails (busy, 503) shows
"Couldn't listen that time. Try once more!" (adults see the reason, in the
quiet text colour). Live regions (`role="status"`), each with its own
message: the check's progress and outcome ("Checking the tones…", then the
summary or why it failed: `tone-status`, one region that stays mounted);
"the recording started mid-word" on a clipped take; a take or model that
couldn't play; and on the card, a microphone problem. A tap opens the
syllable's picture: the textbook shape dashed against what was heard, the
learner's own take (the blob in memory) and the model sound.

- **Practice speak-it**: once a spoken answer is graded, its recording is
  scored against the phrase's words, only when the grade is not "wrong" (a
  wrong answer said other words) and the phrase is scorable. The grade
  never changes (stage 3 fails a wrong tone). Model: the phrase's audio
  (`/api/practice/audio/:id`), fetched on the first tap.
- **Character card**: "Say it, check the tone" ("Your turn to say it" for
  kids) records the character (stopping after a second's pause) and shows
  its mark. Model: `/api/voice/sound`.
- **First steps drills: not wired.** A drill's data names English meanings
  (`phrases`) and the narrator chooses the words; no structured field says
  which text a turn asks the learner to repeat, and the reference is never
  guessed from the transcript or the narrator's last line. Wiring it needs a
  marker the dojo master writes (a later bead).

How each "Before wiring" point above was handled:

- Single syllables and short phrases only (24 characters at most; the
  card is one character, Practice phrases are short). Phrase flags still
  rest on `phraseMarginSt`.
- `speaker` is never passed: nothing is kept between recordings in stage
  1, so there is no range from the learner's other recordings.
- `timings` are Azure's through `mergeAzure` when Azure answers. The
  local path, and any fallback, finds the speech by energy and says "not sure"
  more often in a real room, by design.
- Azure's spans in a real room are still unmeasured. One small check on a
  synthesized 谢谢 (2026-11-19, three requests): the spans with half a
  second of silence around it, with a knock 450 ms before, and with a cough
  300 ms after, moved by 20 ms at most. Three clips of one voice, not a
  room.
- Off the request thread: a worker thread per recording.
- `unsure` is shown quietly, never as a mistake (and not at all to kids).

### Compare mode (ld-ne0.9)

After a tone check, "⇄ Compare with the model" ("👀 You and the model" for
kids) opens one view, the same on the character card and in Practice
speak-it (`web/src/components/CompareView.tsx`, opened from
`ToneCheck.tsx`): the learner's take laid against the model clip the page
already plays, with plain-word differences and playback.

**What the page draws.** One time axis, the learner's take. Above, both
pitch curves in semitones about each speaker's own median (a man and a
woman then sit on one scale and only the shapes compare); beneath, both
loudness envelopes (dB under each take's loudest frame, floored at −48),
the model's above the line and the learner's below. Each syllable is a
band labelled with its character and its reading in the profile's aid,
and is a button. The model is time-warped per syllable onto the learner's
spans (a piecewise-linear map through every syllable's start and end, slope
1 outside), and the caption says so: "Aligned by syllable: the model is
stretched to your timing". "Real lengths" turns the warp off: the model is
only shifted so the first syllables start together, its own syllables
marked along the top. Where the model clip couldn't be read with
confidence, that syllable's band shows the dashed textbook (Chao) shape
instead, and a line says which characters. The picture is SVG (no chart
library), `vector-effect: non-scaling-stroke`, theme tokens only.

**Where the learner's frames come from.** The score reply now carries
`frames` (`{ frameMs: 10, pitch, level }`, from the worker's own pitch
track: `takeFrames` in `scripts/pronunciation-compare.mjs`), pitch kept
only inside the scored syllables' spans. Nothing is re-uploaded and nothing
is stored: the page holds the take, the reply and the model's analysis in
memory, as before. Each syllable also gains `soundScore` (adults, Azure
only), `half` (a half third) and, on an ok where several tones count,
`saidTone` (the one heard).

**The model's real curve: `GET /api/pronunciation/model`.**
`?sound=好&locale=zh-CN` (the card: 1–4 Han characters, `isSoundText`) or
`?phrase=<phrase id>` (Practice). `wrap(…, { learner: true })`, Mandarin
only (422 otherwise), exactly one of the two (400), GET only (405); a
`phrase` for a kids learner is a 403, as Practice's own routes are. Two
analyses per user at a time (429), checked before any provider call. The
scoring workers shared with the score route are taken only around the
worker run itself, and the converter has its own limit of two: an analysis
waits for either (up to 15 s, then a 503) rather than holding a slot while
its speech is synthesized or Azure answers, so Compare never turns another
learner's score away. The server fetches the clip as the
play route would (`soundClip` in `voice.ts`, `phraseClip` in
`practice.ts`: the audio cache, a TTS call on a miss), reads its expected
syllables from the text, then `modelAnalysis` (`scripts/model-analysis.mjs`).
Reply: `{ available: true, engine, text, locale, durationMs, frames,
syllables: [{ char, pinyin, expectedTone, startMs, endMs, real, saidTone? }] }`, or
`{ available: false, why: "no_decoder" | "unreadable" }` (the page then uses
the textbook shapes). The log says only the engine, hit or made, and the
syllable count, never the text.

- **PCM: decoded on the server from its own cached clip.** The cached audio
  is MP3 (ElevenLabs) or WAV (macOS voices, Azure).
  `scripts/audio-decode.mjs` passes a 16 kHz mono 16-bit WAV through and
  converts anything else with macOS `afconvert` (`-f WAVE -d LEI16@16000
  -c 1`, its best sample-rate converter), else `ffmpeg` on the PATH, else
  none: an argument list, never a shell, 8 MiB in, and at most the longest
  clip the scorer reads out (`MAX_OUTPUT_BYTES`), checked like a recording
  (`readScoreAudio`). Its 10 s timeout is our own timer: the converter is
  sent SIGKILL and the request fails at once (execFile's own timeout sends
  SIGTERM and waits, so a converter ignoring it would hold a slot for
  ever); the temp dir goes on every path, and dirs a crash left are swept
  on the first decode after a start. Why this and not the alternatives:
  the browser could decode the MP3, but then the model WAV would come from
  the client and could not be trusted or cached for everyone; asking the
  TTS provider for PCM would be a second paid call per clip and a second
  cache entry; a JS MP3 decoder would be a new dependency. The app runs on
  one Mac, which always has `afconvert`. With no decoder the view quietly
  uses the textbook shapes.
- **Padding.** A voice's clip starts on its first sound, and a lone
  character from a macOS voice can be under the scorer's 250 ms. The
  decoded clip gets 250 ms of silence each side before it is read
  (`padSamples`) and the record is shifted back (`unpadRecord`), so its
  times are the clip's own, as the page plays it.
- **Analysis**: the same worker and engine as a learner's take, Azure's
  timings when available (`assessWithAzure`, the per-minute cap, the paid
  slot), else local. A syllable is `real` (its own curve drawn) when its
  verdict is ok, or unsure/neutral with at least 6 voiced frames;
  otherwise the textbook shape stands in.
- **The cache** (`<audio dir>/analysis/`, `LINGO_AUDIO_DIR` or `data/audio/`):
  `<audio key>-<24 hex of the audio's sha256>.json`, written atomically.
  The audio key is the audio cache's (per user, voice, text…), so a record
  is per user like the clip; the hash means a clip synthesized again is
  analysed again. Records whose clip the audio cache has evicted are
  removed after each write.
- **One Azure call per clip, ever.** A ledger file `<id>.azure` is created
  exclusively (`O_EXCL`) inside the paid slot, just before the request, and
  never removed while its clip is kept: a failure, a crash mid-call, a
  second request at once (here or in another process) and a deleted record
  all find it and analyse locally. A record made without a call says
  `azure: "skipped"` and is served from the cache like any other. It is
  made again (to try the one call) only when Azure can be asked: with no
  keys or a malformed region, not until the setup is fixed; with the call
  refused by the per-minute cap or a busy paid slot, not before its
  `retryAt`, 15 minutes on (`RETRY_MS`), so a clip is re-analysed at most
  once in that time. Concurrent requests for one clip share one analysis.
- **No poisoning.** The route takes a phrase id or a few characters, never
  audio; the server reads the clip from its own cache, decodes and analyses
  it itself. A client can choose which of its own clips is analysed, and
  nothing else.

**Tips** (`compareTips` in `web/shared/compare.ts`, pure, run by the page;
thresholds `COMPARE_RULES`). The tone scorer and its thresholds are
untouched: tips only explain what the scorer already said, and the
sentence names the syllable, which highlights on hover or focus.

- An **off** syllable gets the rule that fits: tone 4 falling too little
  (the model falls ≥ 5 st; yours under 60 % of that and ≥ 3 st short, "start
  higher" when your start sits ≥ 2 st lower), tone 1 moving (the model
  within 2.5 st of level, yours moving ≥ 3, the scorer's own bound) or sitting
  low in a phrase (≥ 3.5 st under the model's), tone 2 rising too little
  (model ≥ 4, yours under half and ≥ 3 short) or late (your climb after 65 %
  of the syllable, the model's before 45 %), tone 3 dipping too little (model
  ≥ 2.5, yours under half and ≥ 2.5 short), a half third sitting too high
  (read by how low it sits, never by how far it moves: the model's mean
  ≥ 2 st under its own centre, yours ≥ 3 st higher than the model's against
  your own; a learner low and level against a model falling into the low is
  right), too short or long (as a share of the take against the model's:
  under 0.55 or over 1.8; a lone syllable under 0.45 or over 2.2 of the
  model's length, and only on a miss: a lone character held long to hear
  it, and said right, gets none), and carried over (heard as
  the previous syllable's tone, starting within 1.5 st of where it ended,
  while the model jumps ≥ 2.5). If none fits, one plain sentence of what
  the tone should do.
- An **ok** syllable gets a tip only when every gap is 1.6 times larger
  (`okFactor`). An **unsure** one never gets one.
- A syllable's curve is read only with ≥ 6 voiced frames covering half its
  span, 8 % trimmed at each edge; and only against the model's real curve
  (never against a textbook stand-in, except the plain tone sentence).
  Lengths likewise use only spans the model was read with confidence in.
- **Several accepted tones** (我 before 很 takes 2 or 3; 一 and 不; a card
  character's readings): the learner and the model may each have said a
  right one, and not the same. The curve is compared only on an ok whose
  score reply names the tone heard (`saidTone`) when the model was heard
  saying that same tone (its record's `saidTone`); a miss there gets only
  the plain sentence.
- **Sound** (Azure's score under the scorer's own bar): Azure's zh-CN
  "phonemes" are whole syllables, so the tip never says consonant or vowel:
  it says Azure scores the whole syllable and offers the model's sound to
  copy.
- One tip per syllable; offs weigh double; at most three, the most useful
  first.

How the thresholds were chosen: from the scorer's own bounds where it has
one (a first tone rules out at 3 st), then checked on generated voices
(the engine tests' `speak()`: four learner voices × three speeds, single
syllables and the test phrases, against one model voice). On 144 right
takes no tip; every one of 369 confident misses got a tip on its own
syllable and none elsewhere; 711 of 1,080 wrong takes the scorer marked
unsure, and got none. **Synthesized voices only**: real learners, real rooms
and real model voices are unmeasured, so the bars sit on the cautious side
and the plain sentence is the fallback.

**Playback** (Web Audio, the blob in memory and the model clip): my take,
the model, both in turn (model, a short pause, mine), and, with a syllable
picked, loop that syllable of either (its span from the reply or the
model's analysis), and stop. Each button shows `aria-pressed` while it
plays.

**Kids**: no scores, no red (the kids accent and `kiai`), simpler words
("it goes down, like a slide"), at most one tip and only for a miss, the
pitch lane only (no loudness lane, no "real lengths", no loop): a young
child reads one line against another, not two lanes and a toggle.

**Accessibility**: every syllable, tip and control is a button or checkbox
in tab order; the heading takes focus on open; "The picture in words"
(adults, a `<details>`) says each syllable's shape for both voices, and for
kids the same list is screen-reader only; status lines are live regions.

## The recorder

`web/src/recorder.ts` is the app's one microphone recorder: voice turns,
Practice speak-it and a said cloze, and the character card's tone check.
It records with MediaRecorder (webm/opus in Chromium, mp4 in Safari) and
hands back a 16 kHz mono 16-bit PCM WAV, the one format transcription and
the tone check take.

**The conversion** (`toWav`; the pure half is `web/src/wav16k.ts`, tested
in `scripts/tests/wav16k.test.mjs`): decode at the browser context's own
rate, average the channels, then low-pass and resample to 16 kHz in JS with
a Kaiser-windowed sinc (flat to 7.2 kHz, over 80 dB down from 8.5 kHz;
about 10 ms of work per second of audio). Until 2026-11 it played the
decoded buffer through a 16 kHz OfflineAudioContext, which interpolates
with no low-pass. Measured in headless Chromium 153 (ld-axq), a 48 kHz
sine at −9 dBFS, output level against input:

| tone | old (playback) | decode at 16 kHz | JS filter (now) |
|---|---|---|---|
| 1 kHz | 0.0 dB | 0.0 dB | 0.0 dB |
| 4 kHz | 0.0 | −0.1 | 0.0 |
| 6 kHz | 0.0 | −1.9 | 0.0 |
| 7 kHz | 0.0 | −5.1 | 0.0 |
| 7.5 kHz | 0.0 | −7.6 | −2.4 |
| 9 kHz | 0.0 (folded to 7 kHz) | −20.3 | −96.6 |
| 10 kHz | 0.0 (to 6 kHz) | −35.3 | −92.2 |
| 13 kHz | 0.0 (to 3 kHz) | −76.2 | −95.5 |
| sweep 8.5–23 kHz | 0.0 | −51.8 | −92.7 |

The same through MediaRecorder (webm/opus) first, as a real turn is: within
0.6 dB of the rows above, the JS filter at −82 dB or lower from 9 kHz (the
codec's own floor). So the old path folded everything a microphone gives
above 8 kHz into the band at full level: on synthesized speech with white
room noise the in-band noise floor was 4.4 dB higher (8–24 kHz folding
onto 0–8), and with strong noise above 8 kHz (a fan, hiss at −15 dB
against the speech) 32 dB higher. The recording page
(`scripts/pronunciation-record.html`) decodes straight at 16 kHz instead;
that removes most of the aliasing but cuts 7 kHz by 5 dB and leaves 9 kHz
only 20 dB down, so the app does its own filtering, the same in every
browser. Safari and WebKit were not measured (ld-axq could not install
Playwright's WebKit); WebKit's AudioBufferSourceNode also resamples a
buffer of another rate by interpolation, so the old path most likely
aliased there too, and the JS filter does not depend on it.

What the change does, on 24 synthesized Mandarin clips (12 phrases from
妈 to 我们走吧, macOS Tingting and Reed at 48 kHz), each clean, with white
noise at −30 dB and with noise above 8 kHz at −15 dB against the speech
(72 recordings), through MediaRecorder: the local tone scorer
(`scoreTones`, no timings) gave the same verdict on 589 of 600 syllable
verdicts (the clip's own reading and every one-syllable relabelling, as
the proof scores them). The 11 that changed were borderline both ways
(right "ok" 123 → 122; wrong tones passed 46 → 50 and caught 106 → 104 of
450); decoding at 16 kHz gave exactly the same 11 changes, so they are
the aliasing's, not the filter's. The scorer's rules were set on
band-limited audio (the proof converts with ffmpeg), which the recorder
now matches. Six Scribe v2 transcriptions, old against new (two Spanish
clips with noise, one Mandarin with noise above 8 kHz), were word for
word the same.

**Browser processing** (`processing` in `startRecording`, `MicProcessing`):

| use | echo cancellation | noise suppression | auto gain |
|---|---|---|---|
| voice turn (`conversation`) | on | on | on |
| speak-it in a language with a tone check (Mandarin; `pitch`) | on | off | off |
| character card's tone check (`pitch`) | on | off | off |
| speak-it elsewhere, a said cloze (`conversation`) | on | on | on |

Measured with Chromium's fake capture device
(`--use-file-for-fake-audio-capture`), which, unlike a stubbed
getUserMedia stream, runs the browser's own processing (the track's
`getSettings()` reported each setting as asked, and the output shows it:
auto gain raised a clip's speech 8 to 17 dB, noise suppression lowered the
floor about 9 dB). On the same 24 clips, clean and with white noise (48
recordings, 400 verdicts), each setting captured twice:

| setting | right ok (of 100) | wrong caught (of 300) | wrong passed |
|---|---|---|---|
| all on | 74 | 73 | 37 |
| echo cancellation only | 79 | 82 | 35 |
| all off | 78–79 | 67–70 | 33–34 |

Repeats of "all on" and "echo cancellation only" were identical; "all
off" (captured at 44.1 kHz, the device's own rate, since Chromium opens
it differently with no processing) moved 5 verdicts between runs, against
37 to 44 between settings. So noise suppression and auto gain cost the
tone check right answers, and echo cancellation alone did not. Auto gain
did not change a quiet speaker's transcript (a Spanish clip at about −45
dBFS, two calls) or a quiet clip's tone verdicts (1 of 23 changed).

Echo cancellation stays on everywhere: Practice and the character card
can be playing the model clip when Record is pressed, and on speakers,
with it off, the model's voice would be transcribed (or scored) as the
learner's answer. With nothing playing it has no far-end signal to remove.
A voice turn keeps all three: the narrator stops when Talk is pressed,
but other audio, the room's echo and a quiet speaker are what noise
suppression and gain are for, and only the words matter there.

Not measured: real microphones and rooms (the fake device has no room
and no speaker output, so echo cancellation's effect with the narrator
actually playing is reasoned, not measured); Safari's processing, where
echo cancellation is Apple's voice-processing unit, which brings its own
gain and noise reduction and may not let them be turned off separately
(the recording page labels such clips `processed`); Firefox. With auto
gain off a very quiet microphone may stay under the pause detector's
floor (RMS 0.015), so a take ends on Stop or the idle cap rather than on
the pause (ld-5cj).

## Cost (rough, Nov 2026)

The header shows characters spoken this session. ElevenLabs Eleven v4 runs about
$0.10 per 1,000 characters (Flash about half); Azure neural voices about $15 per
million. A 20-minute session is roughly 9,000 characters. Claude turns run on
your Claude Code login.

## Limits

- Speech-to-text tends to quietly correct mispronunciations, so the dojo
  master can't judge *how* something sounded (the adapter tells it so).
  Tones are scored only where the text is known (Practice speak-it, the
  character card; §Pronunciation in the app), not in live turns yet.
- Not streaming: each reply arrives whole, then plays line by line.
- Only text is saved (no audio), and a saved session can be read in
  History but not picked up again: after a reload the Go tab starts fresh.
