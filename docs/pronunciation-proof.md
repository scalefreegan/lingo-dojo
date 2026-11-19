# Pronunciation scoring: proof of the local tone scorer

Written by `node scripts/pronunciation-proof.mjs` on 2026-11-19. Rerun it to refresh; the clips are cached, so a rerun is free. Stage 0 of the pronunciation feature (bead ld-ne0.1); the engine is `scripts/pronunciation.mjs`, described in [VOICE.md](VOICE.md#pronunciation).

## What was tested

124 synthesized clips from 4 voices: Tingting (macOS), female, median 217 Hz; Reed (macOS), male, median 102 Hz; Rachel (ElevenLabs premade: an English voice speaking Mandarin), female, median 161 Hz; Adam (ElevenLabs premade: an English voice speaking Mandarin), male, median 137 Hz. Each voice says 16 single syllables (ma, shi, yi, ba in each of the four tones: 妈 麻 马 骂 诗 十 使 是 衣 姨 椅 意 八 拔 把 爸) and 15 phrases (你好、不是、一个、很好、谢谢、我很好、不客气、一起去、你叫什么、我想喝水、明天见、今天很热、我是学生、他不来、再见).

There are no learner recordings, so every clip is used twice over. Scored against its own text it is a **right** answer: an "off" there is a false alarm. Scored against the same syllables with one tone changed it is a **wrong** answer: 妈 labelled 马 is a learner who said mā for mǎ, and an "off" on that syllable is a catch. The connected-speech rules are applied to each label first, so a relabelling that the rules make equivalent (你 as ní before 好) is not counted as wrong. Syllables whose true or labelled tone is neutral are left out: the scorer does not judge them.

The number that matters is how many "off" flags are false: a learner told a right tone was wrong stops believing the marks. A miss costs less. The set holds about three wrong labels for each right one, which flatters raw precision, so each table also restates it for a learner who gets one tone in five wrong.

## Headline: held out by voice

The numbers to quote. Thresholds chosen on two voices, measured on the other two, both directions added up (details under "Held out by voice" below). Speaker's range known (from the voice's other clips), cuts by energy.

| | Stage 0, same clips | Wrong tones caught | Right syllables flagged (false alarms) | 95% upper bound on the false-alarm rate | Precision of a flag at that bound, one tone in five wrong |
| --- | --- | --- | --- | --- | --- |
| Single syllables | 81 of 192 (42.2%), 1 of 64 false alarms | **114 of 192 (59.4%)** | **1 of 64 (1.6%)** | under 7.2% | at least 67% |
| Phrases | 145 of 576 (25.2%), 0 of 168 false alarms | **276 of 576 (47.9%)** | **2 of 168 (1.2%)** | under 3.7% | at least 76% |

The phrase false alarms by half: Reed + Rachel: 1 of 84; Tingting + Adam: 1 of 84. Every other table in this report except "Held out by voice" is **in-sample**: it runs the engine's defaults, which were chosen with all four voices in view, on those same four voices, and reads better than the table above for that reason alone.

What "held out" covers and what it doesn't: only the 8 thresholds in the search (`moveSt`, `offMarginSt`, `phraseMarginSt`, `flatSt`, `offQuality`, `offMinMs`, `highStart`, `lowLevel`) were chosen without the test voices. The shape of every rule, the tone templates, and the other constants (`dipShare`, `riseShare`, `riseStart`, `stillSt`, `highLevel`, `lowTop`, `lateFrom`, `scaleRange`, `creakFlags`) were written while looking at all four voices, and `phraseMarginSt` was set just above the phrase false alarms seen on them (see "Azure, live"). So even the held-out numbers are optimistic for a new voice.

## Results (in-sample)

The engine's defaults on the four voices they were tuned on.

| | Singles, speaker unknown | Singles, range known | Phrases, speaker unknown | Phrases, range known | Phrases, Scribe anchors, range known | Phrases, Scribe times as cuts, range known |
| --- | --- | --- | --- | --- | --- | --- |
| Right syllables scored | 64 | 64 | 168 | 168 | 168 | 168 |
| Wrong syllables scored | 192 | 192 | 576 | 576 | 576 | 576 |
| **False alarms** (right, flagged off) | 1 of 64 (1.6%) | 1 of 64 (1.6%) | 0 of 168 (0.0%) | 0 of 168 (0.0%) | 0 of 168 (0.0%) | 0 of 168 (0.0%) |
| **Precision of an off flag**, as measured | 98.9% | 99.1% | 100.0% | 100.0% | 100.0% | 100.0% |
| Precision at one wrong tone in five | 88.1% | 90.2% | 100.0% | 100.0% | 100.0% | 100.0% |
| Wrong tones caught (flagged off) | 89 of 192 (46.4%) | 111 of 192 (57.8%) | 156 of 576 (27.1%) | 201 of 576 (34.9%) | 201 of 576 (34.9%) | 111 of 576 (19.3%) |
| Wrong tones passed as ok | 12.5% | 4.7% | 11.1% | 10.1% | 10.1% | 10.9% |
| Right tones marked ok | 84.4% | 89.1% | 79.2% | 70.8% | 70.2% | 48.2% |
| Right tones marked unsure | 14.1% | 9.4% | 20.8% | 29.2% | 29.8% | 51.8% |
| Marked unsure, all | 34.4% | 30.5% | 52.6% | 49.2% | 49.3% | 65.7% |

These are small counts. A false-alarm rate measured on a few dozen or a couple of hundred syllables is only bounded, not known: with 95% confidence, single syllables, nothing known about the speaker: 1 of 64, so under 7.2%; single syllables, speaker's range known: 1 of 64, so under 7.2%; phrases, cut by energy, nothing known about the speaker: 0 of 168, so under 1.8%; phrases, cut by energy, speaker's range known: 0 of 168, so under 1.8%; phrases, cut by energy around scribe's character times, speaker's range known: 0 of 168, so under 1.8%; phrases, scribe's character times taken as the cuts, speaker's range known: 0 of 168, so under 1.8%. And that bound is for voices like these, on the set the thresholds were tuned on.

So "a flag can be trusted" is not established by these counts, only not contradicted. With the false-alarm rate at that upper bound and the catch rate as measured, the precision of a flag for a learner who gets one tone in five wrong is only known to be (in-sample; the held-out figures in the headline are lower): single syllables, nothing known about the speaker: at least 62%; single syllables, speaker's range known: at least 67%; phrases, cut by energy, nothing known about the speaker: at least 79%; phrases, cut by energy, speaker's range known: at least 83%; phrases, cut by energy around scribe's character times, speaker's range known: at least 83%; phrases, scribe's character times taken as the cuts, speaker's range known: at least 73%. Narrowing that takes more right syllables, from real people.

"Range known" gives the scorer the voice's pitch range measured over that voice's other clips (never the one being scored), which is what a session would know after a few turns. "Speaker unknown" is a first recording: only the shape of the contour counts, plus the recording's own range once it holds four syllables.

## The classifier before any gate

What tone the classifier names for each single syllable (speaker's range known), whatever it then decides to say about it. This is the question "is it misreading the pitch, or just not daring to flag?".

| Voice | Named the labelled tone | tone 1 heard as 1/2/3/4 | tone 2 | tone 3 | tone 4 |
| --- | --- | --- | --- | --- | --- |
| Tingting | 13 of 16 | 4/0/0/0 | 0/2/2/0 | 0/0/4/0 | 0/0/1/3 |
| Reed | 14 of 16 | 4/0/0/0 | 0/4/0/0 | 0/2/2/0 | 0/0/0/4 |
| Rachel | 13 of 16 | 2/0/0/2 | 0/3/1/0 | 0/0/4/0 | 0/0/0/4 |
| Adam | 16 of 16 | 4/0/0/0 | 0/4/0/0 | 0/0/4/0 | 0/0/0/4 |
| **All** | **56 of 64** | | | | |

So the classifier mostly reads the pitch right (stage 0's named 53 of 64); the catch rate is lower than this because a flag asks for more than a best guess. What the contours of the misread and unflagged clips showed when looked at one by one: two of Rachel's first tones (妈, 八) fall by 9 and 14 semitones, a fourth tone's contour whatever the label says (Azure scores that 八 at 90 against 爸 and 61 against 八), so those two "errors" are probably the clips; the macOS voices say some second tones as a dip that comes back up and some third tones as a shallow dip that rises, which are each other's shapes; one fourth tone starts in the middle of the range and reads as a low third; and Adam's voice creaks, leaving a hole in the middle of several pitch tracks, which costs flags, not readings. No miss on these clips came from an octave error, from the consonant at the start, or from the range used to normalise. The misses came from the gate: stage 0 never flagged third against second or fourth in either direction (a third of all wrong labels), asked for four semitones of movement, and let a second tone's first dip or a fourth tone's first rise count as "it climbs" or "it drops".

Where the catches are and aren't, by which tone was said for which (range known; caught / marked ok / all):

| Said → labelled | Singles | Phrases |
| --- | --- | --- |
| 1→2 | 12 / 0 / 16 | 21 / 0 / 32 |
| 1→3 | 12 / 0 / 16 | 7 / 1 / 16 |
| 1→4 | 11 / 2 / 16 | 14 / 0 / 24 |
| 2→1 | 11 / 0 / 16 | 14 / 10 / 44 |
| 2→3 | 1 / 4 / 16 | 22 / 14 / 76 |
| 2→4 | 11 / 0 / 16 | 17 / 2 / 76 |
| 3→1 | 10 / 0 / 16 | 13 / 3 / 36 |
| 3→2 | 7 / 2 / 16 | 10 / 2 / 52 |
| 3→4 | 2 / 0 / 16 | 0 / 4 / 36 |
| 4→1 | 12 / 0 / 16 | 26 / 5 / 56 |
| 4→2 | 12 / 0 / 16 | 41 / 0 / 72 |
| 4→3 | 10 / 1 / 16 | 16 / 17 / 56 |

Three pairs stay close to uncatchable by design: a third tone said for a fourth (3→4: a low fall is both), a fourth that starts low said for a third, and second against third when the second dips or the third comes back up. These voices disagree with each other about exactly those shapes, so a flag there would be a guess.

## Held out by voice

The thresholds a flag rests on were chosen on two voices and measured on the other two, which had no say in them, then the other way round. "Chosen" means: of 864 settings (`moveSt` 3/3.5/4, `offMarginSt` 0/0.5/1, `phraseMarginSt` 0/0.5/1, `flatSt` 1/1.5, `offQuality` 0.6/0.75, `offMinMs` 80/110, `highStart` 3.7/4.2, `lowLevel` 2.2/2.6), the one that catches the most wrong tones on the tuning voices while flagging at most one of their right syllables. Range known, cuts by energy, each clip read against the range of the voice's other clips.

| Tuned on | Measured on | | Stage 0 (before) | Tuned on the other two (held out) | The engine's defaults (in-sample) |
| --- | --- | --- | --- | --- | --- |
| Tingting + Adam | Reed + Rachel | Singles | 39 of 96 (40.6%) caught, 1 false alarms | 63 of 96 (65.6%) caught, 1 of 32 false alarms | 60 of 96 (62.5%) caught, 1 of 32 false alarms |
| Tingting + Adam | Reed + Rachel | Phrases | 63 of 288 (21.9%) caught, 0 false alarms | 142 of 288 (49.3%) caught, 1 of 84 false alarms | 86 of 288 (29.9%) caught, 0 of 84 false alarms |
| Reed + Rachel | Tingting + Adam | Singles | 42 of 96 (43.8%) caught, 0 false alarms | 51 of 96 (53.1%) caught, 0 of 32 false alarms | 51 of 96 (53.1%) caught, 0 of 32 false alarms |
| Reed + Rachel | Tingting + Adam | Phrases | 82 of 288 (28.5%) caught, 0 false alarms | 134 of 288 (46.5%) caught, 1 of 84 false alarms | 115 of 288 (39.9%) caught, 0 of 84 false alarms |

Settings chosen: on Tingting + Adam `{"moveSt":3,"offMarginSt":0,"phraseMarginSt":0,"flatSt":1.5,"offQuality":0.6,"offMinMs":80,"highStart":3.7,"lowLevel":2.2}`; on Reed + Rachel `{"moveSt":3,"offMarginSt":0,"phraseMarginSt":0,"flatSt":1.5,"offQuality":0.6,"offMinMs":110,"highStart":3.7,"lowLevel":2.2}`. The engine's defaults are the setting chosen on all four voices where the two halves agree, and the more cautious value where they don't; the defaults column is therefore not held out, and the held-out column is the honest one. The stage 0 numbers are from that commit's report (same clips; its range included the clip being scored).

Held-out false alarms: Rachel (ElevenLabs premade: an English voice speaking Mandarin) 妈[1] 妈 expected 1 heard 4; Reed (macOS) 我是学生[4] 生 expected 1 heard 3; Adam (ElevenLabs premade: an English voice speaking Mandarin) 很好[1] 很 expected 2 heard 4.

## The trade-off (in-sample)

The same clips (all four voices, range known) at several values of `offMarginSt`: how many semitones past its bar the evidence must be before a syllable is flagged. Negative values flag contours that only nearly rule the label out.

| `offMarginSt` | Singles: false alarms | Singles: caught | Phrases: false alarms | Phrases: caught |
| --- | --- | --- | --- | --- |
| -1 | 1 of 64 | 137 of 192 (71.4%) | 5 of 168 | 310 of 576 (53.8%) |
| -0.5 | 1 of 64 | 129 of 192 (67.2%) | 2 of 168 | 265 of 576 (46.0%) |
| 0 (default) | 1 of 64 | 111 of 192 (57.8%) | 0 of 168 | 201 of 576 (34.9%) |
| 0.5 | 1 of 64 | 105 of 192 (54.7%) | 0 of 168 | 148 of 576 (25.7%) |
| 1 | 1 of 64 | 65 of 192 (33.9%) | 0 of 168 | 110 of 576 (19.1%) |
| 1.5 | 1 of 64 | 55 of 192 (28.6%) | 0 of 168 | 88 of 576 (15.3%) |
| 2 | 1 of 64 | 50 of 192 (26.0%) | 0 of 168 | 71 of 576 (12.3%) |
| 3 | 1 of 64 | 34 of 192 (17.7%) | 0 of 168 | 48 of 576 (8.3%) |
| default, and creaky syllables flagged too (`creakFlags`) | 2 of 64 | 122 of 192 (63.5%) | 0 of 168 | 210 of 576 (36.5%) |

`creakFlags` is off by default. Turning it on catches more in a creaky voice, and its one extra false alarm here is Rachel's 八, the clip that falls 14 semitones; but a pitch track with a hole in it is where octave errors hide, and nothing here can tell those from a real fall, so it stays off until real recordings say otherwise.

## With lead-in noise

The clips above start and end with the speech. A push-to-talk recording doesn't: there is room noise, a key press, a knock, a murmur before or after the words, and the scorer first has to decide what the speech is (`trimToSpeech`). This section puts those surroundings around every cached clip and scores them again, speaker's range known and cuts by energy as in the in-sample table (its numbers are the first row). The measure of the trim is that the rows stay close to the first one: a disturbance may cost catches (more "unsure"), it must not add false alarms or wrong tones passed as ok. The same disturbances, on generated audio, are in `npm test`.

| | Singles: wrong tones caught | Singles: false alarms | Singles: wrong tones passed as ok | Phrases: wrong tones caught | Phrases: false alarms | Phrases: wrong tones passed as ok |
| --- | --- | --- | --- | --- | --- | --- |
| The clips as they are (no lead-in) | 111 of 192 | 1 of 64 | 9 of 192 | 201 of 576 | 0 of 168 | 58 of 576 |
| Half a second of plain silence before and after | 111 of 192 | 1 of 64 | 9 of 192 | 201 of 576 | 0 of 168 | 58 of 576 |
| Room noise at −50 dB before, under and after | 111 of 192 | 1 of 64 | 9 of 192 | 201 of 576 | 0 of 168 | 58 of 576 |
| …and a 40 ms pitched blip at −20 dB, 300 ms before the speech | 111 of 192 | 1 of 64 | 9 of 192 | 176 of 576 | 0 of 168 | 50 of 576 |
| …and a pitched knock at −10 dB, 450 ms before the speech | 111 of 192 | 1 of 64 | 9 of 192 | 177 of 576 | 0 of 168 | 53 of 576 |
| …and a pitched knock at −10 dB, 300 ms after the speech | 111 of 192 | 1 of 64 | 9 of 192 | 184 of 576 | 0 of 168 | 50 of 576 |
| …and a voiced 120 ms murmur at −27 dB, 300 ms before the speech | 111 of 192 | 1 of 64 | 10 of 192 | 205 of 576 | 0 of 168 | 58 of 576 |

| Generated three-syllable phrases, in room noise | Wrong tones caught | False alarms | Wrong tones passed as ok | Right syllables ok |
| --- | --- | --- | --- | --- |
| Three syllables 70 ms apart, all alike | 297 of 324 | 0 of 108 | 0 of 324 | 108 of 108 |
| A 300 ms pause, then a 70 ms last syllable | 144 of 324 | 0 of 108 | 0 of 324 | 60 of 108 |
| The last syllable 27 dB under the others | 179 of 324 | 0 of 108 | 0 of 324 | 60 of 108 |

Levels are dB against the clip's loudest 10 ms; every added sound is a buzz at 220 Hz. The generated phrases (three voices, twelve tone patterns each, every syllable also relabelled with each other tone) are the cases the cached clips can't express: a last syllable short enough, far enough or soft enough that a trim could take it for noise. When the scorer can't tell whether a run is speech, it reads the recording both ways and keeps only the verdicts that come out the same; the rest are "unsure" (reason "trimmed"), which is what the last two rows cost.

## Real recordings

Everything above is synthesized speech. Real recordings are the next step: `npm run pron:record` collects them and `npm run pron:proof` scores them, per speaker, into `data/pronunciation-proof/recordings/report.md` and the terminal. That folder is gitignored and its results are deliberately left out of this report.

### How to record your clips

1. In a terminal, in the repository: `npm run pron:record`.
2. Open <http://127.0.0.1:38410> in Chrome or Safari on the same computer, and allow the microphone when the browser asks.
3. Type a first name or nickname, pick Adult or Child, press **Start**.
4. For each word: press **Listen** to hear it, press **Record** (or the space bar), say it, press **Stop** (or space again). The page plays your clip back.
5. Press **Keep** (or Enter) if it is what you meant to say, or **Redo** (space) to try again. If you doubt you said it right, tick **Not sure I said it right** before keeping: that is useful, not a failure.
6. Part 1 is 31 words and phrases said as shown. Part 2 is 12 words said in the *wrong* tone on purpose, each with a model to copy; the page explains it when you get there.
7. Stop whenever you like (**Stop for now**, or just close the tab). Every kept clip is already saved; next time, pick your name on the first screen and it carries on where you stopped.
8. When you have some clips, press Ctrl-C in the terminal and run `npm run pron:proof`. It prints how the scorer did for each speaker and writes the detail to `data/pronunciation-proof/recordings/report.md`.

After each kept clip the page shows a "test readout": what the scorer made of it. It is there to show the thing working and is not a grade; it is often unsure and sometimes wrong, which is what these recordings are for.

The recorder is a local tool, not part of the app: it listens on 127.0.0.1 only, uses no login or database, plays the proof's cached model clips and makes no request to anywhere else. Recordings and their results stay under `data/` (gitignored): this report never includes them.

### What a label means

A label records what the speaker was **aiming for**, not what came out. A beginner's "said as shown" clips will hold real mistakes, so a flag on one may be a true catch that the tally counts as a false alarm. That is why the speaker's own "not sure" clips are counted apart, and why the false-alarm rate from a beginner's clips is an upper bound until someone who knows the language has listened to the flagged ones.

### The labels file

`data/pronunciation-proof/recordings/labels.tsv` (with `LINGO_PROOF_DIR` set, its `recordings/` folder): one recording per line, tab-separated; the recorder writes it, and it can be written by hand:

```
# file<TAB>text<TAB>said<TAB>speaker<TAB>group<TAB>unsure<TAB>processing
nihao-1.wav	你好
rec-20261118-153012-ab12cd34.wav	妈	ma2	sam	adult		raw
rec-20261118-153140-0f3e9a71.wav	我是学生		sam	adult	unsure	raw
```

- `file`: WAV, M4A, MP3 or WebM in that folder; anything that isn't 16 kHz mono WAV is converted with ffmpeg (or macOS's afconvert) into `recordings/.wav16k/`. The recorder's files are already the right format.
- `text`: the characters the speaker was shown.
- `said`: empty when they were asked to say it as shown. Otherwise what they were asked to say instead: one pinyin syllable per character with the tone as a digit (5 or 0 for neutral). `ma2` against 妈 is a deliberate má for mā.
- `speaker`: a name; recordings with the same name share a pitch range, each read against the range of that speaker's other recordings.
- `group`: `adult` or `child` (optional).
- `unsure`: `unsure` when the speaker ticked "not sure I said it right" (optional).
- `processing`: `raw` when the microphone was recorded with the browser's echo cancellation, noise suppression and automatic gain off (what the recorder does now), `processed` with them on. A line without it is read as `processed`: the first recordings were made that way. When the labels hold both, the recordings report has each speaker once per setting, so a few prompts recorded again are a direct comparison.

A syllable whose `said` tone is one the text accepts counts as said as shown (a flag on it is a false alarm); any other counts as wrong on purpose (a flag is a catch). Nothing is uploaded: the local scorer runs on this machine.

### Single syllables, nothing known about the speaker

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 14 | 0 | 0 | 2 | 0 | 87.5% |
| tone 2 | 0 | 14 | 2 | 0 | 0 | 87.5% |
| tone 3 | 1 | 3 | 11 | 1 | 0 | 68.8% |
| tone 4 | 0 | 0 | 0 | 16 | 0 | 100.0% |

Why syllables were unsure (all labels): unclear 70, creaky 14, octave 4.

False alarms: Rachel (ElevenLabs premade: an English voice speaking Mandarin) 妈[1] 妈 expected 1 heard 4.

### Single syllables, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 14 | 0 | 0 | 2 | 0 | 87.5% |
| tone 2 | 0 | 13 | 3 | 0 | 0 | 81.3% |
| tone 3 | 0 | 2 | 14 | 0 | 0 | 87.5% |
| tone 4 | 0 | 0 | 1 | 15 | 0 | 93.8% |

Why syllables were unsure (all labels): unclear 57, creaky 17, octave 4.

False alarms: Rachel (ElevenLabs premade: an English voice speaking Mandarin) 妈[1] 妈 expected 1 heard 4.

### Phrases, cut by energy, nothing known about the speaker

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 20 | 1 | 1 | 2 | 0 | 83.3% |
| tone 2 | 2 | 34 | 7 | 2 | 3 | 70.8% |
| tone 3 | 1 | 1 | 28 | 4 | 2 | 77.8% |
| tone 4 | 2 | 0 | 13 | 40 | 5 | 66.7% |

Why syllables were unsure (all labels): unclear 332, unvoiced 24, creaky 19, short 16.

### Phrases, cut by energy, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 23 | 0 | 1 | 0 | 0 | 95.8% |
| tone 2 | 5 | 27 | 11 | 2 | 3 | 56.3% |
| tone 3 | 2 | 1 | 27 | 4 | 2 | 75.0% |
| tone 4 | 5 | 0 | 16 | 34 | 5 | 56.7% |

Why syllables were unsure (all labels): unclear 301, creaky 25, unvoiced 24, short 16.

### Phrases, cut by energy around Scribe's character times, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 23 | 0 | 1 | 0 | 0 | 95.8% |
| tone 2 | 5 | 28 | 11 | 1 | 3 | 58.3% |
| tone 3 | 2 | 1 | 26 | 5 | 2 | 72.2% |
| tone 4 | 5 | 0 | 16 | 34 | 5 | 56.7% |

Why syllables were unsure (all labels): unclear 298, creaky 28, unvoiced 25, short 16.

### Phrases, Scribe's character times taken as the cuts, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 19 | 0 | 1 | 0 | 4 | 79.2% |
| tone 2 | 14 | 9 | 8 | 6 | 11 | 18.8% |
| tone 3 | 2 | 0 | 18 | 2 | 14 | 50.0% |
| tone 4 | 3 | 0 | 12 | 31 | 14 | 51.7% |

Why syllables were unsure (all labels): unclear 250, short 157, creaky 56, unvoiced 22, untimed 4.

### By voice (range known, cut by energy)

| Voice | Singles: false alarms | Singles: caught | Phrases: false alarms | Phrases: caught |
| --- | --- | --- | --- | --- |
| Tingting (macOS) | 0 of 16 (0.0%) | 32 of 48 (66.7%) | 0 of 42 (0.0%) | 69 of 144 (47.9%) |
| Reed (macOS) | 0 of 16 (0.0%) | 29 of 48 (60.4%) | 0 of 42 (0.0%) | 23 of 144 (16.0%) |
| Rachel (ElevenLabs premade: an English voice speaking Mandarin) | 1 of 16 (6.3%) | 31 of 48 (64.6%) | 0 of 42 (0.0%) | 63 of 144 (43.8%) |
| Adam (ElevenLabs premade: an English voice speaking Mandarin) | 0 of 16 (0.0%) | 19 of 48 (39.6%) | 0 of 42 (0.0%) | 46 of 144 (31.9%) |

## Azure, live

316 live replies from Azure Pronunciation Assessment (`zh-CN`, the REST short-audio endpoint in `<region>.stt.speech.microsoft.com`, free F0 tier, one request at a time). Every clip was assessed against its own text; each single syllable also against the other three tones of the same syllable, which is the wrong-tone sample: the audio of 妈 with 马 as the reference text. There are no wrong-tone phrase samples for Azure (it needs real characters as the reference, and the proof's phrase relabellings are pinyin only).

| | Syllables | Azure's median score | Azure marks the word `Mispronunciation` | Azure score under 40 | Local scorer alone flags | Merged result flags | which are | Merged result says ok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Singles, right reference | 64 | 82 | 1 (1.6%) | 0 (0.0%) | 1 (1.6%) | 1 (1.6%): 1 tone, 0 sound | false alarms | 58 (90.6%) |
| Singles, wrong-tone reference | 192 | 61 | 55 (28.6%) | 21 (10.9%) | 111 (57.8%) | 109 (56.8%): 102 tone, 7 sound | caught | 11 (5.7%) |
| Phrases, right reference | 168 | 100 | 4 (2.4%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%): 0 tone, 0 sound | false alarms | 116 (69.0%) |

Where Azure's syllable score separates right from wrong, and where it doesn't. Syllables scoring under each bar (in brackets: those on a word Azure also marks `Mispronunciation`):

| Score under | Singles, right | Singles, wrong tone | Phrases, right |
| --- | --- | --- | --- |
| 30 | 0 (0) of 64 | 8 (8) of 192 | 0 (0) of 168 |
| 40 | 0 (0) of 64 | 21 (21) of 192 | 0 (0) of 168 |
| 50 | 0 (0) of 64 | 54 (39) of 192 | 5 (2) of 168 |
| 60 | 0 (0) of 64 | 93 (52) of 192 | 7 (3) of 168 |
| 70 | 7 (1) of 64 | 132 (55) of 192 | 10 (4) of 168 |

`phraseMarginSt` (the extra margin a flag needs inside a phrase, 0.5 semitones) was set after looking at these very syllables, above every phrase false alarm on Azure's timings: correctly said phrase syllables flagged with it at 0, 0.25 and 0.5 are 2, 1 and 0 of 168, and the cleanly measured right syllable that comes closest sits at 0.325. So phrase flags rest on a thin margin that these clips chose.

The merged result's false alarms: Rachel 妈[1] 妈 expected 1 heard 4, margin 4.959, Azure 80, 40–720 ms.

A high Azure score is not evidence of a right tone (the median wrong-tone syllable scores above 60), so the merged result never turns an unclear pitch reading into "ok" on Azure's word.

On the single syllables, precision of a flag as measured (three wrong for each right): Azure's own `Mispronunciation` mark 98.2%, the local scorer 99.1%, the merged result 99.1%. The merged result flags on the local pitch check, or on Azure's `Mispronunciation` mark with a score under 40.

What the replies look like for Mandarin (316 flat, 0 with a nested `PronunciationAssessment` object): scores sit directly on the `NBest` entry, the word and the phoneme. 48 of 381 words are longer than one character (你好, 学生: Azure segments into words). In 381 of 381 words the `Phonemes` array has exactly one entry per character: a "phoneme" is a whole syllable with its tone as a digit (`ni 3`, `hao 3`; 5 is neutral), with its own offset, duration and score. That digit is the tone of the **reference** reading (the dictionary tone, before sandhi; for a character with several readings, one of them), not the tone that was heard: Azure does not report a heard tone. `DisplayText` echoes the reference too. What a wrong tone changes is the score.

A wrong-tone sample, verbatim (Tingting's 妈, mā, assessed against 马, mǎ):

```json
{"RecognitionStatus":"Success","Offset":400000,"Duration":2400000,"DisplayText":"马。","SNR":19.011362,"NBest":[{"Confidence":0.78632134,"Lexical":"马","ITN":"马","MaskedITN":"马","Display":"马。","AccuracyScore":54,"FluencyScore":0,"CompletenessScore":0,"PronScore":10.8,"Words":[{"Word":"马","Offset":400000,"Duration":2400000,"Confidence":0,"AccuracyScore":54,"ErrorType":"Mispronunciation","Syllables":[{"Syllable":"","Grapheme":"马","Offset":400000,"Duration":2400000,"AccuracyScore":50}],"Phonemes":[{"Phoneme":"ma 3","Offset":400000,"Duration":2400000,"AccuracyScore":50}]}]}]}
```

## Scribe's timings

60 phrase clips were transcribed by Scribe v2 with `timestamps_granularity=character` (the app sends no such field today, and `transcriptText` keeps only `text`). For Chinese the reply has one `words` entry per character: 175 entries, 0 longer than one character, 175 carrying a `characters` array. 168 of 172 expected syllables found their character in the transcript.

The times are not syllable boundaries. The median character span is 140 ms and 17 of 168 are 40 ms or shorter, in clips whose syllables last 150 to 300 ms: Scribe reports roughly when it recognized each character. Taken as cuts they leave most syllables too short to score (the last column of the table above). But 137 of 168 character start times fall inside the stretch the energy cuts give that syllable, so they work as anchors: `scoreTones({ anchors })` cuts by energy and keeps each piece on its character's time. On these short, pause-free clips that changes little; its use is longer speech with pauses, which this set does not contain.

## Speed

Scoring a 3-second, 16 kHz recording on this machine (arm64, Node v26.4.0): 37 ms (median of 12; slowest 40 ms). Nearly all of it is the pitch track.

## Settings this ran with

`TONE_RULES` = `{"stepSt":2.5,"minRangeSt":7,"maxRangeSt":12,"sigmaSt":1,"levelWeight":0.3,"minFrames":6,"okBelief":0.34,"moveSt":3,"stillSt":1,"flatSt":1.5,"highLevel":3.8,"highStart":3.7,"lowLevel":2.2,"lowTop":2.2,"dipShare":0.25,"riseStart":2.5,"lateFrom":2,"scaleRange":true,"riseShare":0.5,"offMarginSt":0,"offQuality":0.75,"offMinMs":80,"phraseMarginSt":0.5,"creakFlags":false,"creakTrust":0.85}`; cuts made by energy are trusted at 0.85. Before anything is cut or measured the recording is trimmed to its speech (`TRIM_RULES` = `{"runMs":80,"sureDb":-12,"floorDb":-26,"nearMs":200,"beforeMs":250,"afterMs":120,"loudShare":0.15,"bridgeMs":100}`). On these 124 clips it removes a voiced frame from 0, and in 4 of Adam's it silences unvoiced frames within 22 dB of the loudest voiced frame (the breathy end of a last syllable, past the 120 ms kept after the voicing). It is for real recordings, which have seconds of room and key noise around the speech.



**What these clips cannot measure.** Every number in `TRIM_RULES`, and the half weight a creaky syllable's "ok" carries, was set on 43 real recordings from one speaker, one microphone, one room; none of them is held out, and synthesized voices barely creak. What is measured instead is what the trim does when it is wrong: "With lead-in noise" above, and its small copy in `npm test`.



**Creaky syllables.** A creaky syllable may be "ok" when its voiced part fits (it is never "off"), is marked `creaky`, and is left out of `overall`. That rule let more wrong tones pass as ok when it was introduced: phrases on Scribe's cuts went from 52 to 58 of 576, single syllables with nothing known about the speaker from 24 to 25 of 192 (the commit before against the commit with it, same clips). In this run: 63 of 576 (phrases, scribe's character times taken as the cuts, speaker's range known) and 24 of 192 (single syllables, nothing known about the speaker).

## Before wiring this to a route

- **Start with single syllables and drills.** Their flags have room to spare; phrase flags rest on a half-semitone margin chosen on these clips, and the held-out phrase false alarms are the highest number in this report.
- **Build the speaker's range only from the learner's other recordings**, never from the one being scored, and not at all until there are a few: without a range the height rules are silent, which is the safe side.
- **Run it off the request thread, or pass timings.** The scorer is synchronous and refuses more than 30 seconds or 60 syllables; cutting syllables itself is the slow part.
- **Show unsure as nothing**, not as a soft warning: a third to a half of right syllables are unsure.
- **Collect real recordings first** (the section above) and rerun this report: every number here is from four synthesizers.

## Limitations

- **Synthesized speech is not a learner.** These voices hit their tones cleanly, in quiet, at an even pace. A learner's wrong tone is rarely a clean other tone: it is a flat second tone, a fourth that barely falls, a third with no dip. Those land in "unsure" by design, so on real learners expect fewer catches than here, and treat the false-alarm rate as a floor until real recordings are scored.
- **The wrong answers are other syllables' right answers**, not mistakes: they are well-formed tones, the easiest kind of wrong to spot.
- **The thresholds were tuned on these voices.** The held-out table tunes on two voices and measures on the other two, which is the fairest number here, but all four are synthesizers and two of them are the same engine. It shows the setting is not fitted to one voice; it does not show it fits a person.
- **Nobody has tested a child's voice.** The pitch tracker searches 60–800 Hz and tones are read against the speaker's own range, so nothing in the design excludes one, but no child (and no synthesized child) is in the set.
- **The labels are trusted, not checked.** A synthesizer can misread a lone character, or say it with a sentence's falling intonation; nobody listened to these clips. A clip said in the wrong tone shows up as a miss or a false alarm that isn't the scorer's fault. Scribe is no second opinion here: of 64 single-syllable clips it wrote one character in the labelled tone for 18, and for the rest the commonest word that fits or nothing at all (Tingting 妈 (mā) → ""; Tingting 麻 (má) → ""; Tingting 马 (mǎ) → ""; Tingting 骂 (mà) → ""; Tingting 诗 (shī) → "She"; Tingting 十 (shí) → "She"; Tingting 使 (shǐ) → "是" (shì); Tingting 衣 (yī) → ""; …). That is the generosity this feature exists to get around, and it means the labels stay unchecked.
- **4 voices, none of them a person.** No microphone, no room, no background noise. The ElevenLabs voices are premade English voices speaking Mandarin through the app's default model, not native Mandarin voices: the account's voice list and the Voice Library search did not answer when the clips were bought, so the script fell back to two public voice ids. Their lone syllables are the least textbook clips in the set: Rachel's 妈 holds level and then drops nine semitones, which the scorer hears as a fourth tone and which may well be one.
- **Free conversation is harder than these phrases**: faster, with tones squeezed by their neighbours, focus and sentence intonation on top, and cuts that depend on the transcript being right. The phrase numbers are an upper bound for it.
- **Neutral tones are not judged**, and sandhi across word groups is taken leniently (both readings accepted), so some real mistakes can never be flagged.
- **Azure is verified live for zh-CN only, on these same synthesized clips.** Not run: zh-TW, Spanish, a recording near the 30-second limit, a learner's voice. `AZURE_RULES` were set from these replies, so the same caveat about tuning applies.
