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
  session history every turn (the server keeps none). The reply comes back as
  `NARRATOR-F:` / `CHARACTER-M:` / `SIDEKICK-F:` lines: speaker plus gender,
  taken from the units and the scenario's roles (Doña Carmen is `-F`, a Don
  `-M`). Each line is spoken by the voice in that speaker's slot for that
  gender, so a woman vendor gets a woman's voice. A tool-less turn takes
  about 4 s.
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
  for a pause). Spellings vary: `<pause1.5>`, `<pause 2s>`, `<pause .5>`,
  `<pause (1.5)>`, `<overlap -0.4>`, `<pause for 2 seconds>`, `<pausa de 1,5>`,
  `<pause 800ms>`, `<pausa 500 milisegundos>`, or a note after the number.
  The length is the number at the start of the mark, else one with a unit,
  else the one that ends it; "<pause while she counts 20 pesos>" is an
  ordinary pause, not 20 s. The server resolves each line's `pauseMs`
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
  backwards). The timeline marks done, here and
  ahead; tapping a part sends `[jump] <id>`, and the dojo master goes
  straight there, skipping what's in between (the frame's "every warm-up
  first" rule gives way to the learner asking). It collapses to a rail of dots (remembered per browser).
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
  and Copy transcript includes them.

## Settings

Saved in `data/voice.json` (gitignored): voice provider, speech-to-text
provider, ElevenLabs model (Eleven v4 by default; Flash v2.5 is fastest and
cheapest), Claude model for the dojo master, turn-taking, and a voice per
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

**Ages.** The dojo master writes a `CAST:` line (shown, never spoken;
`parseCast`) whenever someone speaks for the first time or a different
person takes over a voice tag: `CAST: CHARACTER-F old, Doña Carmen, the
fruit vendor`. The age is one of child, young, middle-aged or old right
after the tag; looser wordings are read too ("an elderly woman", "a little
girl", "a seven-year-old", "aged 22": under 13 a child, under 30 young,
under 60 middle-aged), but an age on someone else ("the old man's
daughter") or a name ("Mr Young") is not the character's. The turn reply carries these as `castNotes`, and they go back
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
- Nothing is saved; Copy transcript is the way to keep a session.
