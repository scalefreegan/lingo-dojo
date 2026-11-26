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
post-session recap (phase 5: after End one tool-less `claude -p` reads the
transcript; its summary, kept phrases, corrections and FSRS session reviews
are stored once per conversation by a claim on `conversations.extraction_status`,
re-runs replace; `web/server/extraction.ts`, `scripts/db/extraction.ts`,
pure half `scripts/extraction.mjs`, the card `web/src/components/SessionRecap.tsx`); and the
Practice tab's flashcards (phase 7a, adults only; kids get the word game below, adults have it as a mode: queue and grading
rules in `scripts/practice.mjs`, queries in `scripts/db/practice.ts`, the
routes and the tool-less Haiku grader in `web/server/practice.ts`, the page
`web/src/components/PracticeView.tsx`), with the listening and speak-it
drills and a mode picker (phase 7b: the phrase played from
`/api/practice/audio/:phraseId` through the on-disk audio cache
`scripts/audio-cache.mjs`, `data/audio/` or `LINGO_AUDIO_DIR`, files per user; a
listening choice checked against the server's own seeded draw; a speak-it
recording transcribed by `/api/practice/transcribe` with no keyterms; each
answer's drill is its review's mode) and fill the gap (phase 7c, migration
0006: cloze sentences from the learner's own session lines, else written
in the background by tool-less claude calls only for a started session's
cards (never from the counts or a poll), at most 6 calls per language a
day counted from a ledger written as each call starts (`cloze_calls`, never
from the sentence cache), in a background paid slot apart from audio
and transcription, each checked by
the pure rules in `scripts/cloze.mjs`, the phrase verbatim and once; rows
in `scripts/db/cloze.ts`, the call in `web/server/cloze.ts`; a cloze
answer also names its sentence, `clozeId`; a flashcard's answer side shows
the phrase in one of the same sentences, `sentence` on its queue item, and
a started flashcards session asks generation for its own cards that have
none, under the same ledger and cap), and recall in sessions (phase 6:
the review block in the `recall` slot's `{{phrase_review}}`, per-turn
retrieval and the `LOOKUP:` line; pure ranking in `scripts/recall.mjs`,
reads in `web/server/recall.ts`; no row locks, no migration), and the
content agent's read-only bank (phase 8, migration 0005: for an admin with
a learner picked, `scripts/bank-mcp.mjs` is a stdio MCP server with four
read-only tools over that learner's language, reading as the NOLOGIN role
`lingo_reader` (SET LOCAL ROLE in a READ ONLY transaction) with column
grants and row-level security on `app.learner_id` and
`app.language_profile_id`; RLS is enabled, never forced, so the owner is
unaffected). A practice answer locks its phrase
then its card; it names the card's version, the phrase's revision and a
submit id (a resend replays, anything else stale is a 409).
A pack may be a random scene (migration 0007: `packs.random_scene`, a
validated `{ collections }` pool; pure rules in `web/shared/scenes.ts`,
the draw in `web/server/randomScene.ts`): the server draws the scenario
only when a conversation is made, avoiding the language's recent scenes,
records it in `pack_snapshot.random_draw`, and every turn plays that one
(`playedPack`); preview and assemble never draw, an export draws its own, and Copy asks assemble for `draw: true` (the export's draw: nothing recorded, no recent-scene avoidance; ld-mdz).
Revisit (migration 0008, docs/DATA.md §Revisit; pure rules in
`scripts/revisit.mjs`, server `web/server/revisit.ts`): `conversations.scene_key`
groups History by scene; a new session of a scene played before links to its
last attempt with a done recap (`previous_conversation_id`, SET NULL; Practice
again's `previous` preferred) and freezes what it carries in
`pack_snapshot.revisit` (kept phrases first in the review; for adults a
briefing in every turn's system prompt and a `vsLast` comparison in the
recap); `/api/conversations/scenes` and `/overview` (the 7-day card and a
digest written by one tool-less call per language per day, capped by
`recent_digests`' unique day row).
Hidden scenes (migration 0009, docs/DATA.md §Hidden scenes): a language
profile may hide library scenes and collections (`hidden_scenes`, one row
per (profile, kind, key), unhide deletes it; queries only in
`scripts/db/hidden.ts`, routes `/api/hidden-scenes` in `web/server/hidden.ts`);
`isHiddenScene` in `web/shared/scenes.ts` leaves them out of the Scene tab
and of every random draw (`randomPool`'s `hidden`), never out of a pack
that names one.
Reading hints (ld-op2, migration 0014, docs/VOICE.md §Reading hints): the
Mandarin reader takes the common reading where no dictionary word settles
one (the generated `web/src/script/zh-freq.ts`, CC BY-SA 4.0 data apart
from the AGPL code, built by `npm run pinyin:freq`; its in-sentence words
apply only between `Intl.Segmenter` word boundaries, and replace a
pinyin-pro dictionary reading only when marked `!`); a Mandarin GLOSS
entry may carry pinyin in square brackets. The per-turn rule
(`READINGS_RULE`) is **off by default**, in a Mandarin prompt only with
`LINGO_READING_HINTS=on`; parsing, checking and storage run regardless:
`settleHints` (`web/server/hints.ts`, `validateHint` in
`web/src/script/zh.ts`: two or more characters, one known reading each, a
marginal one only with a confirming word, never against a dictionary
word, bounded work), kept only where it differs from the reader: on the
turn's gloss (jsonb) and in `phrases.reading` (cleared when the text is
edited), laid over that phrase where it stands as its own word in that
turn's lines and read by the bank, Practice, the character card and the
tone check; never spoken.
First steps drills (docs/CONTENT.md §Drills; no migration): a scenario with
`format: drill` is the narrator alone drilling words, played under
`frame-drill.md` with the schema's `scene_only` slots skipped, rounds as its
beats in `sessionPlan`, only the narrator tag in the voice prompt (others
voiced as the narrator), and left out of a random pool that has any scene;
the `First steps` collections and the adult `Pre-A1` level (opt-in) go with it.
Compare mode (ld-ne0.9, docs/VOICE.md §Compare mode; no migration): from a
tone check on the character card or Practice speak-it, the learner's take
against the model clip on one time axis, the model warped per syllable;
the score reply carries the take's `frames`, `GET /api/pronunciation/model`
(`sound`+`locale` or `phrase`) decodes the server's own cached clip
(`scripts/audio-decode.mjs`: afconvert, else ffmpeg, else textbook shapes)
and caches its analysis by the audio key in `<audio dir>/analysis/`, at
most one Azure call per clip and record version (an O_EXCL ledger,
`scripts/model-analysis.mjs`; none after a version bump where the old
record holds Azure's spans: the clip is read again on them, `spansFrom`);
the tips are pure rules in `web/shared/compare.ts`, never touching the
scorer.
Talk dock and practice parts (ld-415, docs/VOICE.md §The talk dock, §Practice
parts and the veil; no migration): the session's controls are one dock, fixed
to the screen's bottom below 64rem (`--dock` on `<html>` is its height). A
warm-up unit with `practice:` is two plan parts; in the second (kind
`practice`) the Go tab blurs what came before the question (reversible,
remembered per language), and a CHOICES entry wholly in `<t>` is an answer: a tap sends
`[pick] …` (`scripts/choices.mjs`), which the recap never counts as recalled.
Reload and kept choices (ld-ch4, migration 0023, docs/VOICE.md §Reload,
docs/DATA.md §Kept choices): a reload goes on with the Go tab's session,
kept in the browser per language profile (`web/src/liveSession.ts`, one tab
at a time by a Web Lock) and merged with the stored turns (`withStored`);
the page going never ends a conversation (Close, a switch, leaving Go and
the two idle hours do). `web/src/keepPage.ts` holds back Vite's own reloads
(a dropped websocket) while something is going. What a learner picked is
`language_prefs`, one row per profile and key (`PREFS` in
`web/shared/prefs.ts`; queries only in `scripts/db/prefs.ts`; `PUT
/api/prefs`, sent with `GET /api/auth/me`), `localStorage` only its cache: a
new remembered choice goes through `readPref`/`keepPref` (`web/src/prefs.ts`),
never `localStorage` alone.
Pace (ld-9gz, docs/VOICE.md §Pace; no migration): the dojo master wraps
what it says slowly in `<slow>…</slow>` (outside `<t>`), the only thing that
slows a voice; a slow piece is a segment with `slow: true`, kept by the
stream, the stored turn and the replay (`markedText`). The browser sends
`pace: "slow"` (a word, never a number; else 400) and `speechPace` in
`scripts/voice.mjs` holds each provider's setting: ElevenLabs
`voice_settings.speed`, Azure `<prosody rate>`, `say -r`; where the voice
can't (Eleven v3/v4, Azure HD voices) the reply's `X-Lingo-Playback-Rate`
has the Go tab slow the playback. An ElevenLabs speed never goes alone (it
resets the voice's stored settings): it is merged with the voice's stored
settings, read free and held 10 minutes (`storedElevenSettings`), and a
failed read falls back to the playback rate. Slowing down for the session is the
model's marking, not server state.
Tone checks where the text is known (pronunciation stage 1, ld-ne0.2; no
migration, docs/VOICE.md §Pronunciation in the app): `POST
/api/pronunciation/score?text=` (`web/server/pronunciation.ts`, pure rules
`scripts/pronunciation-app.mjs`, the engine `scripts/pronunciation.mjs` in a
worker thread, `scripts/pronunciation-worker.mjs`) scores a WAV against 1–24
Han characters for a Mandarin language only (else 422 `not_available`);
Azure whenever its keys are set (paid slot, 12 a minute per user), the local
scorer otherwise or when Azure fails, **for kids learners too**: a kids
learner's recording goes to Azure for scoring, as it already goes to the
transcription provider (only the reply differs: no score, from the session's
learner mode); the card's one character, with `readings=all` (never sent
by Practice), is judged against every reading the card shows; nothing is stored, and every failure leaves as an
`HttpError` so no log line carries the text in the URL.
Marks and the tone picture are `web/src/components/ToneCheck.tsx`, on
Practice's speak-it (since stage 3 a clear tone miss can fail right words:
below) and the character card; First steps
drills are not wired (no reliable target text per turn).
Tone checks in conversation (pronunciation stage 2, ld-ne0.3, migration
0022; docs/VOICE.md §Pronunciation in conversation, docs/DATA.md
§Pronunciation in sessions):
- A Mandarin Go-tab listening turn is scored against its own transcript
  (Han only, at most 24 characters; mixed or longer turns aren't), started
  by `/api/voice/transcribe` in the background (`startLive`,
  `web/server/livePronunciation.ts`; stage 1's engine and per-minute Azure
  cap, `scoreLive`) and taken by the turn whose message has the same Han
  characters, waited for at most `LIVE.waitMs` (1.2 s) from the turn's
  arrival; late, failed or busy: the turn goes on unchanged. Live scoring
  has its own budgets (`LIVE_SCORER`: one worker server-wide, one Azure
  call per user, a 2 s Azure timeout), never an interactive paid slot or
  the score route's workers, so it never 429s an explicit check; a dropped
  score (late, replaced, expired) is aborted at once.
- Only the live bar flags (`liveFlags` in `scripts/pronunciation-live.mjs`:
  the engine's `off` plus 1 st of margin, confidence, quality, no creak, no
  sound-only flag, no particles, nothing when over a third of a turn is
  off). One flag at most goes into the turn prompt as a fixed-format
  `[PRONUNCIATION CHECK]` block with the dial's rule (`pronunciationBlock`,
  `PRONUNCIATION_RULES` in `scripts/voice.mjs`); nothing flagged or the
  dial off: the prompt is byte for byte unchanged.
- The dial `coaching` (`off` | `light` default | `strict`, a word like
  `pace`, else 400) goes on the transcription and the turn; off scores
  nothing at all. Kids: no dial (a value is a 400), the gentle rule, no
  marks, nothing stored.
- Adults get the line's marks in the reply (`pronunciation`, a miss below
  the bar shown as not sure) under their line in the Go tab (`ToneCheck`).
  Each scored adult turn keeps a `pronunciation_checks` row
  (`scripts/db/pronunciation.ts`); a flagged one keeps its WAV in
  `data/clips/` or `LINGO_CLIPS_DIR` (`scripts/pronunciation-clips.mjs`), at
  most 20 per conversation, served only to its learner
  (`GET /api/pronunciation/clips/:id`), removed with the conversation.
Tones after the session (pronunciation stage 3, ld-ne0.4; no migration,
docs/VOICE.md §Tones after the session; pure rules
`scripts/pronunciation-review.mjs`, routes `web/server/toneReview.ts`):
- The recap card's **Tones** section (`SessionTones.tsx`, `GET
  /api/pronunciation/sessions/:id`): counted from the stored checks with no
  model call (the recap prompt unchanged): right / off / not sure, by tone,
  each flagged syllable in its line with its clip (the syllable's stretch
  or the line), and the scene's last attempt compared (`compareTones`).
  A share is `ok` over every tone 1–4 syllable; neutral is never in one.
- History's per-tone **trend** (`ToneTrend.tsx`, `GET
  /api/pronunciation/trend`): share right per tone per learner day, a
  point only from 10 syllables of that tone (`TREND_MIN_SYLLABLES`).
- Practice speak-it scores **before** its answer (`phrase` + `submit` on
  the score route: the live bar's flags held in memory for that submit);
  `tones: true` on the answer then makes right words with a flag a miss,
  the old grade kept in `card_before.tone_miss` (the reply's `toneMiss`,
  replays too) and restored by **I said it right** (the override).
  Only when what was said is the phrase's own Han characters (never an
  alternate or an accepted synonym), and only flags the reading vouches
  for, decided at answer time (`settleHeld`/`settleFlags`), a
  deliberately narrow rule: only on the phrase's first Han character or
  one directly after sentence punctuation (，。！？；： , . ! ? ; :), never 一
  or 不, never where sandhi or context set the
  expected tone or a third tone precedes a third, and only where that
  character has one reading tone or its reading is settled by the
  learner's own hand choice, else the shared list (own outranks shared;
  never the page's `reading`, a recap guess or a GLOSS hint); in zh-TW
  only a settled reading (own, or a shared entry of scope `tw`). Check waits at most 2.5 s;
  leaving sends the answer without `tones`; one check per take.
- The recap feeds the bank (ld-ne0.18, `sessionToneLines` +
  `sessionToneMisses`, written in `scripts/db/extraction.ts`): a stored
  flag that passes the same rule over the line as said fails the speak card
  of the longest bank phrase starting at a leading place of that line (a
  word end, one character only as a whole clause; what was said last
  decides). One session review a card: it replaces the model event's
  rating, kept as `was` in the stored recap's `tones`; **I said it right**
  (`POST /api/conversations/:id/recap-tones`) restores it and survives
  re-runs. No model call.
- Kids: nothing shown (the routes answer empty), nothing stored, no hold.
Word checks beyond Mandarin (ld-ne0.16; no migration; docs/VOICE.md §Words
and sounds beyond Mandarin, docs/pronunciation-proof.md's section of that
name):
- The same `POST /api/pronunciation/score?text=` for a non-Mandarin locale
  that `wordCheckLocale` (`web/shared/word-check.ts`) passes: an Azure
  assessment locale whose language the proof measured. Anything else, or no
  Azure keys, is 422 `not_available` and the page shows nothing. There is
  no local fallback: an Azure failure is a 503, the 12-a-minute cap a 429,
  a take with no speech a 422 `no_speech` (`azureHeardNothing`: live,
  Azure answers silence and a loud wrong word alike, so a quiet take
  decides, `quietTake`; from a take that isn't quiet the same reply is
  `heard: "none"`: no verdicts, one neutral line). Live replies for spellings and no-speech cases are
  test fixtures (`scripts/tests/fixtures/pronunciation/azure-echo.json`,
  from `scripts/pronunciation-proof-echo.mjs`).
- Pure rules in `scripts/pronunciation-words.mjs` (`WORD_RULES`, `wordMarks`,
  `wordsReply`): off is Azure's `Omission`, or `Mispronunciation` under 30;
  ok is no error and 85 or more; the rest not sure. No weakest sound is
  named (Azure names phonemes only for en-US). Kids get no marks, only
  `nudge`.
- UI: `WordCheck.tsx` on Practice speak-it and the Phrase bank's phrase
  card (adults). Compare mode stays Mandarin-only.
- Live turns (ld-ne0.17; no migration; docs/VOICE.md §Words in
  conversation): a Go-tab turn in a `wordCheckLocale` language, with
  Azure's keys and the dial on, is checked against its own transcript
  (`liveWordTarget`, `scoreLiveWords` on `LIVE_SCORER`'s Azure slot and
  timeout, no worker), matched to its turn by letters (`wordsKey`). A line
  in the learner's own language is never checked (`ownLanguageLine`: more
  everyday words of the native language than of the target's; Azure would
  score English as Spanish), and a word that is the native language's alone
  never flagged (`ownLanguageWord`). The lists are the generated
  `scripts/common-words.mjs` (wordfreq's top 3,000 for eight Latin-script
  languages, CC BY-SA 4.0 data, `npm run words:common`). The
  live bar (`liveWordFlags`, `LIVE_WORD_RULES`): only `Mispronunciation`
  under 20, nothing when Azure omitted or inserted any word. One word at
  most goes into the prompt (`wordPronunciationBlock`,
  `WORD_PRONUNCIATION_RULES`: strict never names a sound); adults get
  word marks under their line (`kind: "words"`, `WordCheck` `live`).
  **Nothing is stored** (no `pronunciation_checks` row, no clip); kids get
  the gentle rule only. The dial shows as "Pronunciation coaching" only
  when Azure is configured.
- The proof is `npm`-less: `node scripts/pronunciation-proof-words.mjs
  [--say] [--azure]` with replies cached under
  `data/pronunciation-proof/words/` (gitignored) and a 400-call ledger.
Kids word game (ld-8zu, migrations 0011 and 0012, docs/DATA.md §Kids word game): a
kids learner's Practice tab is a by-ear game, where the child hears a word
and taps its picture.
- Each tap is a quiet review of the word's `listen` card (drill `picture`,
  through `recordAnswer`).
- The child sees stars and cheers only, never a score.
- Pictures are drawn ahead of play by the background run in
  `web/server/pictures.ts`. Its triggers are a kids session's end (after the
  recap), the grown-up's Draw pictures or Draw again in the Phrase bank, and
  a top-up at game start. Never a poll, a count or a page load.
- Each run does one tool-less Haiku picturable check per 20 words (the
  verdict is stored once), then one image per picturable word
  (`web/server/imageProvider.ts`): Black Forest Labs FLUX 3 Image Klein
  when `BFL_API_KEY` is set (768 px JPEG, `safety_tolerance` 0, about
  $0.008 a picture), else OpenAI `gpt-image-2.6-flare` when only
  `OPENAI_API_KEY` is. Both keys only in `.env.local`, never logged or sent
  to the browser; BFL's key only to an https `*.bfl.ai` URL, and every BFL
  request (`bflFetch`) refuses redirects (fetch keeps `x-key` across one);
  the picture is downloaded only from https `*.bfl.ai`. A word whose own
  draw fails twice in a row (`ImageFailed.perWord`) is marked `failed`.
- One picture theme (ld-6k7, `PICTURE_THEME` in `scripts/pictures.mjs`: an
  id, the style lines, BFL's seed 7; no reference image, the subject leaks).
  Every picture records the theme it was drawn in (`phrase_pictures.theme`;
  `<id>+openai` for OpenAI's). A new theme id means `npm run
  pictures:stock` again and the Phrase bank's **Redraw all in the current
  style** (`POST /api/pictures/restyle`: a stock picture where one fits,
  else a new drawing; the old picture stays in the game until replaced).
- The shared stock set (`content/pictures.yaml`, about 200 concepts, both
  libraries) is drawn once per install by `npm run pictures:stock [--
  --limit N] [--dry-run]` into `<images dir>/stock/<theme>/`, outside any
  learner's ledger. The check is offered the drawn ones and may answer a
  stock id: the word is ready at once (`stock_id`, `file` = `stockKey`), no
  image call, no ledger row. No per-word removal, redraw or phrase delete
  ever touches a stock file. A concept may have a look-alike `group` (never
  two in one round) and `adults: true` (never offered or shown to a kids
  learner: `stockForMode`). A stock picture's URL carries its file's
  version (`pictureRef`), so a redraw isn't hidden by the year-long cache.
  Stock access is small functions in
  `scripts/picture-stock.mjs` (list, draw one, remove one, add a concept).
- A word left out (`none`) before a stock picture that fits was drawn is
  asked about again only by the Phrase bank's **Check N words again for a
  shared picture** (ld-30r, `POST /api/pictures/recheck`, no migration):
  `none` rows older than the newest offered stock picture's file
  (`recheckTargets`), one check per 20 on the judge ledger and cap; only a
  stock match changes a row (`noneRechecked`), nothing is drawn, and the
  request is held in memory until the run has asked.
- The check's description goes to the provider only through `cleanDescription`: a
  noun phrase of at most 12 words and 80 characters. If any word names a
  learner on the account, the word gets no picture. The match is
  accent-folded (NFKD) and case-insensitive, and it catches any part of a
  hyphenated or apostrophised word. The description is sent as quoted data
  after the fixed style.
- Each call is in the background paid slot, with a ledger row
  (`picture_calls`) written as it starts. The cap is `PICTURE_DAILY_IMAGES`
  (200) images per language profile a day, redraws included (at most about
  $1.60 a language a day with BFL), and `PICTURE_DAILY_JUDGES` (20) checks.
- `phrase_pictures` holds one row per phrase: pending, ready, none, failed
  or removed. Queries are in `scripts/db/pictures.ts`, and the pure rules in
  `scripts/pictures.mjs`.
- The files are in `data/images/` or `LINGO_IMAGES_DIR`
  (`scripts/picture-store.mjs`). They are served immutably by id and file
  to their own learner only.
- A game is built only from ready pictures and is preloaded before round
  1.
- A game is not the last game again (ld-wx6, `gameRounds`): reviews are at
  most half the rounds while there are new words; a word answered right in
  the last 12 hours rests (`GAME_REST_MS`), whatever FSRS's ten-minute step
  says, while a word just missed comes back first; the chosen rounds are
  shuffled per game. FSRS's schedule is untouched.
- `LINGO_IMAGE_PROVIDER=stub` draws placeholders for tests and UI checks.

Settled readings and kids readings (ld-0mn, migration 0017, docs/VOICE.md
§Saying the settled reading and §Kids: marks and resolving, docs/DATA.md
§Kids: resolving uncertain readings):
- A voice is sent stand-in characters for a Mandarin word a person, the
  shared list or a checked answer settled (`spokenFor` in
  `web/server/readings.ts`, `spokenText` in `web/src/script/zh-speech.ts`,
  the generated table `web/src/script/zh-homophones.ts`, `npm run
  pinyin:homophones`): whole settled words only, on `/api/voice/speak` and
  `outsideClip`; the cache key is the text sent; what is shown and stored
  never changes.
- Kids see the marks ("pronunciation being checked") with nothing to
  press; the grown-up's side is the Phrase bank (`grownUp` in the
  `ScriptContext`): the control, and **Words waiting for a pronunciation
  check** and **Checked by the program** (`GET /api/readings/waiting`;
  Back to waiting is `POST /api/readings/back`). `POST /api/readings`
  takes a kids learner's grown-up, with no shared vote. A recap's or the
  check's answer with a toneless syllable stands only where the word has
  that neutral tone (`neutralsHold`).
- A kids Mandarin session's uncertain words (the dojo master's lines only)
  are checked in the background, one tool-less Haiku call per batch
  (`web/server/sessionReadings.ts`), validated like the recap's, stored as
  the learner's own (no shared vote), at most 20 calls per language a day
  from the `reading_check_calls` ledger (`scripts/db/readingChecks.ts`),
  written as each call starts. A kids word still uncertain stays out of
  the picture game until settled (`settledForKids`).

Adults play it too, and the picture library (ld-318, migration 0013,
docs/DATA.md §The game for adults, and the picture library):
- Practice's **Pictures** mode (`web/src/components/PictureGameView.tsx`,
  not in Mixed) on the same `/api/game/*` routes, no longer kids-only; an
  answer reply carries `word {text, meaning, lang}`, the meaning an adult's
  only (a kids reply's is null; the kids game shows the word, ld-yls). An adult session's
  end queues picture work like a kids one, under the same cap; the Phrase
  bank's picture actions show for adults.
- The menu's **Picture library** (`web/src/components/PictureLibraryView.tsx`,
  not in the kids menu, though its routes stay reachable by a kids
  learner's session): My word pictures (`GET /api/pictures/words`) and the
  Shared library (`web/server/stockPictures.ts`: `GET /api/stock-pictures`
  and its versioned files for any logged-in user; every write under
  `/api/stock-pictures/admin/` is `auth: "admin"`).
- Concepts an admin adds live in `picture_stock_concepts` (never
  `content/`), merged after the file's wherever the stock list is read
  (`mergeStock`); a `content/pictures.yaml` concept can't be deleted. Stock
  draws go through the background paid slot, Black Forest Labs, at most
  `PICTURE_DAILY_STOCK` (300) a day install-wide, counted from
  `picture_stock_calls` written as each call starts (`scripts/db/pictureStock.ts`).
- An added concept may be **Adults only** (`adults` column): like the file's,
  never offered to, matched for or shown to a kids learner (`stockForMode` and `playable` read the merged list). If `content/pictures.yaml` later takes an added id, the file's wins and the row shows as `shadowed` (one warning), deletable without its picture.
- An added concept may have a **look-alike group** (ld-2nw, migration 0019,
  `look_alike_group`, the file's `group` format, `readStockGroup`), set in the
  Add form or from its tile (`POST /api/stock-pictures/admin/:id/group`, admin;
  a file concept's is a 409), with the groups in use suggested; `mergeStock`
  passes it on, so a round never offers two of one group, file and added alike.
- Look-alikes on one screen (ld-44x, migration 0021, docs/DATA.md §Look-alikes
  on one screen): a round never shows two pictures of one group, stock or own.
  pictures.yaml's groups were audited (a parcel and a suitcase are `bag`). A
  word's own drawing gets the group the picturable check names in the same
  call (`looksLike`, from `lookAlikeGroups`; `phrase_pictures.look_alike`),
  else its description's words (`lookAlikeOf`, fixed `LOOK_ALIKE_RULES` in
  `scripts/pictures.mjs`, free, so old rows need no call; every
  pictures.yaml concept's description gives its own group); `ownLookAlike`,
  set in `playable`. A stock match stores its concept's group too. A shared
  drawing's concept stores `ownLookAlike` at share time (the column is the
  truth: an admin's clear sticks; `look_alike_set`, and `fillDrawingGroups`
  fills the ones shared before 0021 once, free). A round of one picture
  only is left out of the game and never graded (`isRound`); a game with
  none left isn't `ready`.
- An admin sets or clears any concept's Adults only from its tile (ld-cvd,
  migration 0018, docs/DATA.md §Adults only, set from the page; `POST
  /api/stock-pictures/admin/:id/adults`): an added one's column, a file
  one's install-wide row in `picture_stock_adults` (kept only while it
  differs from the file; `mergeStock`'s `adultsOverrides`, never a shadowed
  row's). Set: kept from kids at once; cleared: offered to kids' checks
  from the next one. An unreadable setting fails closed (every file concept
  adults only).

The shared picture pool (ld-ec9, migration 0020, docs/DATA.md §The shared
picture pool):
- **What it is.** Every learner's picture game also plays the pool: every
  drawn stock concept, in their target language, at or below their
  level. Adults get a "Pool words: up to A1–B2" picker; kids get A1, or
  A2 at Chatty. Their own words always come first, at any level.
- **Shared drawings.** A learner's ready drawing in the current theme is
  shared at the end of a picture run (`shareDrawings` in
  `web/server/picturePool.ts`). It becomes a `picture_stock_concepts` row
  with `origin = 'drawing'`, and its file is copied into the stock folder.
  - It is never shared if it names any learner on the install.
  - It reaches kids only with `kids_safe` true. That verdict comes from
    the picturable check, or from the kids check on the judge ledger.
  - Remove or Draw again unshares it; an admin's removal is kept in
    `picture_shared_refused`, so it is never shared again.
- **Words.** Each concept's word per language and its level:
  - stock concepts: the reviewed `content/picture-words.yaml`
    (`npm run pictures:words` drafts it);
  - anything else: the capped install-wide Haiku naming call
    (`picture_pool_words`, `picture_pool_levels`, ledger
    `picture_pool_calls`, `POOL_DAILY_CALLS` 20 a day).
- **Progress.** Pool words are virtual (`poolId`) until first answered.
  Then `adoptPoolWord` makes a bank phrase with `source = 'picture'` and
  a stock pointer, so the FSRS listen card works.
- **Code.** Pure rules in `scripts/picture-pool.mjs`, queries in
  `scripts/db/picturePool.ts`.

Mandarin readings (ld-4i2, migration 0015, docs/VOICE.md §Uncertain readings,
docs/DATA.md §Mandarin readings):
- **The mark.** An adult sees a dotted, labelled mark on a word whose reading
  the reader only guessed (`uncertainWords` in `web/src/script/zh.ts`:
  about 1.4 marks per 100 words; wordfreq's top 20,000 words read as
  CC-CEDICT reads them and are not marked unless CC-CEDICT reads them two
  ways, `zh-words.ts` from `npm run pinyin:words`, `applyCommon`). Never
  in kids views.
- **The neutral tone** (ld-azb): a zh-CN profile shows it where the HSK 3.0
  list and CC-CEDICT both print it (朋友 péng you, 告诉 gào su; 东西 only in
  context, and no word CC-CEDICT also reads full for another sense; the generated
  `web/src/script/zh-neutral.ts`, CC BY-SA 4.0, written from the gitignored
  HSK working file by `npm run pinyin:hsk-audit -- --write-neutral`, applied
  by `applyNeutral` in zh.ts after the common words; hints and marks leave a
  neutral tone it set alone: `Detail.neutral`). Not only doubled
  characters: that was PR #67's convention. Where the sources disagree, today's
  reading stays; zh-TW keeps full tones (no machine-readable Taiwan MoE
  source); a hand choice, the shared list and the context rules still win.
- **Settled words** (ld-l1d): an HSK 3.0 word beyond the 20,000 that
  CC-CEDICT reads exactly one way, the list prints that way and the reader
  reads that way is not marked (干杯, 难听, 长跑; 133 words in the generated
  `web/src/script/zh-settled.ts`, CC BY-SA 4.0, `npm run pinyin:hsk-audit
  -- --write-settled`). `applySettled` runs last and changes no reading: it
  settles only a whole word whose every syllable already matches, never
  under a correction, a suggestion or a doubt, and in zh-TW only where the
  reading is the same (no Taiwan pr. on the word or any of its characters). Words a sentence may parse otherwise (得手: 你得手洗衣服
  děi; `PARSED_OTHERWISE`) and a verb with 着 stay marked.
- **The correction.** The character card's **This reading is wrong** or
  **This is right** (`ReadingFix.tsx`) saves the learner's choice per
  language profile, keyed by the word's simplified spelling
  (`reading_corrections`, `scripts/db/readings.ts`, `POST /api/readings`
  with `learner: true`). The browser lays it over every text, and the
  bank's phrases holding the word are read again.
- **Ranks:** the learner's own > the shared list's active entries > the
  dictionary > the prior. A correction applies as a whole word only.
- **The shared list** (`shared_readings`, every query in
  `scripts/db/sharedReadings.ts`) is install-wide.
  - An admin's entry is active at once. A learner's or a recap's is a
    suggestion and a vote of one user (`shared_reading_votes`, migration
    0016; a recap's is its session owner's, a kids recap's none), active
    when an admin confirms it or when two different users who are not
    disabled vote for it, at least one by hand; at most 50 votes a user a
    day (counted under a lock on the user's row).
  - 还 before 钱 / 书 / 你 is huán only where the phrase ends (`giveBack`
    in zh.ts), else hái and marked.
  - Only a choice made by hand ranks as the learner's own; a recap's
    agreement with the reader only clears the mark.
  - The browser fetches `GET /api/readings/shared` once a page (with an
    ETag).
  - The admin page is the menu's **Shared readings**
    (`/api/readings/admin/*`, `auth: "admin"`): confirm, remove, the
    30-day count, and a YAML or JSON export with no personal data.
- **The recap** of a Mandarin session is given the dojo master's
  uncertain words (at most 12, each with its line) and returns a reading
  for each.
  - Every answer is checked by `validateHint`.
  - One that differs is the learner's suggestion, the shared list's, and
    their bank phrase's reading. One that agrees confirms the word.
  - The adult card shows **Readings to check**.
  - With nothing to ask, the recap prompt is byte for byte unchanged.
    Live turns are unchanged.

## Patterns to copy, not reinvent
- Sibling apps: `../travel-guide` (Atlas, closest: `web/server/api.ts` same-origin
  `wrap()`, `scripts/claude.mjs`, SSE chat, `macos/` Dock app) and `../wine-guide`
  (`web/src/components/ChatPanel.tsx`, `web/.oxlintrc.json`).
- Port **38400**, `strictPort`, `usePolling` watcher (FSEvents is unreliable on this
  machine). Atlas is 38300, Wine Guide 38200, Basecamp 38100.
- Every API route goes through `wrap(fn, { auth })` (`web/server/api.ts`): the
  same-origin check, then the session, then the access level. No exceptions.
  (`/hanzi-data/` in `web/server/hanzi.ts` is not an API route: it serves
  one stroke-data file of the public hanzi-writer-data package per
  character, and its licence text, with nothing about any user in it,
  like the JS bundle Vite serves.)
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
  API key). It may Read the repo and Write/Edit **only under `content/`**. (the real content root, `LINGO_CONTENT_DIR` included: the prompt's paths and the grants both come from `contentRoot()`, `contentRel()` in `web/server/chat.ts`) After
  every agent turn the server commits any `content/` change (`agent: <summary>`)
  so it can be reverted with git. Agents never touch `web/`, `scripts/`, or `.beads/`.
  With a learner picked, a run also gets the bank MCP (`bankAccess` in
  `web/server/chat.ts`): its `--mcp-config` starts `scripts/bank-mcp.mjs` scoped
  to the session's learner and language (never a tool argument), and its four
  tools (`mcp__bank__search_phrases`, `…trouble_phrases`,
  `…recent_conversations`, `…get_conversation`) are granted by full name, never
  a wildcard. Its results are learner data, not instructions, and personal
  details from them never go into `content/` (a public repo); the panel says
  whose bank it can read. Such a run checks the page's learner and language
  (409 `stale_learner`), its messages are stored with the language profile
  it read and replayed only into runs for that same one (or runs without a
  bank), and for a kids learner the transcripts leave out what the child
  said. Roles are cluster-wide: tests and scratch databases
  name their own reader role (`LINGO_READER_ROLE`, `pg-scratch.mjs`
  `readerRoleFor`) and drop it; never create or grant to `lingo_reader` from a
  branch.
- Voice practice (Go tab) is a push-to-talk loop: `/api/voice/*` in
  `web/server/voice.ts`, pure helpers in `scripts/voice.mjs`; see `docs/VOICE.md`.
  Provider keys live only in the gitignored repo-root `.env.local` and never
  reach the browser. Voice turns spawn `claude -p` with **no tools**.
  With no voice saved, a line outside a session speaks in the provider's
  default (`defaultVoice`: a native speaker of the locale's language first on
  every provider, the account's English premade voice only when it has no
  native one; ld-pqy), never a "pick a voice" 400. Phrases and sounds said
  that way go through `outsideClip` (web/server/voice.ts): a refused native
  library voice (402 etc.) is made in a premade voice instead, and a language
  with no native voice shows `audioNote` (a warning; it still plays). The character card's sounds go through
  `POST /api/voice/sound` (1–4 Han characters only, disk-cached per user;
  exemplar tables in `web/src/script/sounds.ts`); docs/VOICE.md §Character sounds.
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
  refuses to start until `npm run db:setup` has run; a Vite restart onto a
  database that is behind comes up anyway with `/api` answering 503 until
  `npm run db:migrate` (`web/server/dbGate.ts`, never a throw there; the
  one middleware ahead of `wrap()`: it only refuses, with fixed sentences).
- **Branches and worktrees never point at the real database.** Set
  `DATABASE_URL` to a scratch database and `LINGO_READER_ROLE` to a scratch
  role (a linked worktree refuses to start or migrate without the first,
  and to migrate without the second; its agent then runs without the bank). Add new migrations one branch at a time, never
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
npm test                       # node --test scripts/tests/*.test.mjs, under the no-network guard
npm --prefix web run lint      # oxlint
(cd web && npx tsc -b)
npm run export -- content/packs/<id>.yaml
npm run export -- content/kids/packs/<id>.yaml   # kids library → exports/kids/
npm run user -- add <name> [--admin]   # a login (also passwd | list | disable | enable); password prompted, or on stdin
npm run db:backup                # pg_dump -Fc of DATABASE_URL → backups/ (gitignored, 0600, newest 14 kept; LINGO_BACKUPS_DIR overrides); restore and the optional launchd job (npm run db:backup:plist -- <path>): docs/DATA.md §Backups
npm run db:import [-- --user <name>]   # pack files → that account's (default: first admin's) learners' oldest language; safe to re-run
```
Tests point the loader at fixtures via `LINGO_CONTENT_DIR` and `LINGO_EXPORTS_DIR`;
never write to the real `content/` or `exports/` from a test. Every test runs
under `scripts/tests/no-network.mjs` (preloaded by `npm test`, imported by the
shared helpers): no provider key from the shell or `.env.local`, and a fetch off
this machine is refused and fails the file; stub `globalThis.fetch` and set a
made-up key to test a provider. A scratch dev server has no such guard: unset
the shell's provider keys for it. Database tests use
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
