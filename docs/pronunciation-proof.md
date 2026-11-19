# Pronunciation scoring: proof of the local tone scorer

Written by `node scripts/pronunciation-proof.mjs` on 2026-11-19. Rerun it to refresh; the clips are cached, so a rerun is free. Stage 0 of the pronunciation feature (bead ld-ne0.1); the engine is `scripts/pronunciation.mjs`, described in [VOICE.md](VOICE.md#pronunciation).

## What was tested

124 synthesized clips from 4 voices: Tingting (macOS), female, median 215 Hz; Reed (macOS), male, median 102 Hz; Rachel (ElevenLabs premade: an English voice speaking Mandarin), female, median 161 Hz; Adam (ElevenLabs premade: an English voice speaking Mandarin), male, median 137 Hz. Each voice says 16 single syllables (ma, shi, yi, ba in each of the four tones: 妈 麻 马 骂 诗 十 使 是 衣 姨 椅 意 八 拔 把 爸) and 15 phrases (你好、不是、一个、很好、谢谢、我很好、不客气、一起去、你叫什么、我想喝水、明天见、今天很热、我是学生、他不来、再见).

The clips begin with their first sound. No microphone recording does, and the scorer takes a recording that is loud from its first frame for one that started mid-word (its first syllable is "unsure", reason "clipped"). So every clip is scored with 200 ms of silence put before it, and the recognisers' cached times are moved by as much.

There are no learner recordings, so every clip is used twice over. Scored against its own text it is a **right** answer: an "off" there is a false alarm. Scored against the same syllables with one tone changed it is a **wrong** answer: 妈 labelled 马 is a learner who said mā for mǎ, and an "off" on that syllable is a catch. The connected-speech rules are applied to each label first, so a relabelling that the rules make equivalent (你 as ní before 好) is not counted as wrong. Syllables whose true or labelled tone is neutral are left out: the scorer does not judge them.

The number that matters is how many "off" flags are false: a learner told a right tone was wrong stops believing the marks. A miss costs less. The set holds about three wrong labels for each right one, which flatters raw precision, so each table also restates it for a learner who gets one tone in five wrong.

## Headline: held out by voice

The numbers to quote. Thresholds chosen on two voices, measured on the other two, both directions added up (details under "Held out by voice" below). Speaker's range known (from the voice's other clips), cuts by energy.

| | Stage 0, same clips | Wrong tones caught | Right syllables flagged (false alarms) | 95% upper bound on the false-alarm rate | Precision of a flag at that bound, one tone in five wrong |
| --- | --- | --- | --- | --- | --- |
| Single syllables | 81 of 192 (42.2%), 1 of 64 false alarms | **111 of 192 (57.8%)** | **1 of 64 (1.6%)** | under 7.2% | at least 67% |
| Phrases | 145 of 576 (25.2%), 0 of 168 false alarms | **268 of 576 (46.5%)** | **2 of 168 (1.2%)** | under 3.7% | at least 76% |

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
| Wrong tones caught (flagged off) | 89 of 192 (46.4%) | 111 of 192 (57.8%) | 152 of 576 (26.4%) | 201 of 576 (34.9%) | 201 of 576 (34.9%) | 17 of 576 (3.0%) |
| Wrong tones passed as ok | 12.5% | 4.7% | 9.4% | 9.9% | 9.7% | 2.8% |
| Right tones marked ok | 81.3% | 87.5% | 73.8% | 64.9% | 64.9% | 16.1% |
| Right tones marked unsure | 17.2% | 10.9% | 26.2% | 35.1% | 35.1% | 83.9% |
| Marked unsure, all | 35.2% | 30.9% | 55.6% | 50.7% | 50.8% | 91.9% |

These are small counts. A false-alarm rate measured on a few dozen or a couple of hundred syllables is only bounded, not known: with 95% confidence, single syllables, nothing known about the speaker: 1 of 64, so under 7.2%; single syllables, speaker's range known: 1 of 64, so under 7.2%; phrases, cut by energy, nothing known about the speaker: 0 of 168, so under 1.8%; phrases, cut by energy, speaker's range known: 0 of 168, so under 1.8%; phrases, cut by energy around scribe's character times, speaker's range known: 0 of 168, so under 1.8%; phrases, scribe's character times taken as the cuts, speaker's range known: 0 of 168, so under 1.8%. And that bound is for voices like these, on the set the thresholds were tuned on.

So "a flag can be trusted" is not established by these counts, only not contradicted. With the false-alarm rate at that upper bound and the catch rate as measured, the precision of a flag for a learner who gets one tone in five wrong is only known to be (in-sample; the held-out figures in the headline are lower): single syllables, nothing known about the speaker: at least 62%; single syllables, speaker's range known: at least 67%; phrases, cut by energy, nothing known about the speaker: at least 79%; phrases, cut by energy, speaker's range known: at least 83%; phrases, cut by energy around scribe's character times, speaker's range known: at least 83%; phrases, scribe's character times taken as the cuts, speaker's range known: at least 29%. Narrowing that takes more right syllables, from real people.

"Range known" gives the scorer the voice's pitch range measured over that voice's other clips (never the one being scored), which is what a session would know after a few turns. "Speaker unknown" is a first recording: only the shape of the contour counts, plus the recording's own range once it holds four syllables.

## The classifier before any gate

What tone the classifier names for each single syllable (speaker's range known), whatever it then decides to say about it. This is the question "is it misreading the pitch, or just not daring to flag?".

| Voice | Named the labelled tone | tone 1 heard as 1/2/3/4 | tone 2 | tone 3 | tone 4 |
| --- | --- | --- | --- | --- | --- |
| Tingting | 14 of 16 | 4/0/0/0 | 0/3/1/0 | 0/0/4/0 | 0/0/1/3 |
| Reed | 14 of 16 | 4/0/0/0 | 0/4/0/0 | 0/2/2/0 | 0/0/0/4 |
| Rachel | 13 of 16 | 2/0/0/2 | 0/3/1/0 | 0/0/4/0 | 0/0/0/4 |
| Adam | 14 of 16 | 4/0/0/0 | 0/4/0/0 | 0/0/4/0 | 1/0/1/2 |
| **All** | **55 of 64** | | | | |

So the classifier mostly reads the pitch right (stage 0's named 53 of 64); the catch rate is lower than this because a flag asks for more than a best guess. What the contours of the misread and unflagged clips showed when looked at one by one: two of Rachel's first tones (妈, 八) fall by 9 and 14 semitones, a fourth tone's contour whatever the label says (Azure scores that 八 at 90 against 爸 and 61 against 八), so those two "errors" are probably the clips; the macOS voices say some second tones as a dip that comes back up and some third tones as a shallow dip that rises, which are each other's shapes; one fourth tone starts in the middle of the range and reads as a low third; and Adam's voice creaks, leaving a hole in the middle of several pitch tracks, which costs flags, not readings. No miss on these clips came from an octave error, from the consonant at the start, or from the range used to normalise. The misses came from the gate: stage 0 never flagged third against second or fourth in either direction (a third of all wrong labels), asked for four semitones of movement, and let a second tone's first dip or a fourth tone's first rise count as "it climbs" or "it drops".

Where the catches are and aren't, by which tone was said for which (range known; caught / marked ok / all):

| Said → labelled | Singles | Phrases |
| --- | --- | --- |
| 1→2 | 12 / 0 / 16 | 21 / 0 / 32 |
| 1→3 | 12 / 0 / 16 | 7 / 1 / 16 |
| 1→4 | 11 / 2 / 16 | 14 / 0 / 24 |
| 2→1 | 11 / 0 / 16 | 14 / 11 / 44 |
| 2→3 | 1 / 3 / 16 | 22 / 14 / 76 |
| 2→4 | 11 / 0 / 16 | 17 / 2 / 76 |
| 3→1 | 10 / 0 / 16 | 13 / 3 / 36 |
| 3→2 | 7 / 3 / 16 | 10 / 2 / 52 |
| 3→4 | 2 / 0 / 16 | 0 / 4 / 36 |
| 4→1 | 12 / 0 / 16 | 26 / 3 / 56 |
| 4→2 | 12 / 0 / 16 | 41 / 0 / 72 |
| 4→3 | 10 / 1 / 16 | 16 / 17 / 56 |

Three pairs stay close to uncatchable by design: a third tone said for a fourth (3→4: a low fall is both), a fourth that starts low said for a third, and second against third when the second dips or the third comes back up. These voices disagree with each other about exactly those shapes, so a flag there would be a guess.

## Held out by voice

The thresholds a flag rests on were chosen on two voices and measured on the other two, which had no say in them, then the other way round. "Chosen" means: of 864 settings (`moveSt` 3/3.5/4, `offMarginSt` 0/0.5/1, `phraseMarginSt` 0/0.5/1, `flatSt` 1/1.5, `offQuality` 0.6/0.75, `offMinMs` 80/110, `highStart` 3.7/4.2, `lowLevel` 2.2/2.6), the one that catches the most wrong tones on the tuning voices while flagging at most one of their right syllables. Range known, cuts by energy, each clip read against the range of the voice's other clips.

| Tuned on | Measured on | | Stage 0 (before) | Tuned on the other two (held out) | The engine's defaults (in-sample) |
| --- | --- | --- | --- | --- | --- |
| Tingting + Adam | Reed + Rachel | Singles | 39 of 96 (40.6%) caught, 1 false alarms | 63 of 96 (65.6%) caught, 1 of 32 false alarms | 60 of 96 (62.5%) caught, 1 of 32 false alarms |
| Tingting + Adam | Reed + Rachel | Phrases | 63 of 288 (21.9%) caught, 0 false alarms | 137 of 288 (47.6%) caught, 1 of 84 false alarms | 86 of 288 (29.9%) caught, 0 of 84 false alarms |
| Reed + Rachel | Tingting + Adam | Singles | 42 of 96 (43.8%) caught, 0 false alarms | 48 of 96 (50.0%) caught, 0 of 32 false alarms | 51 of 96 (53.1%) caught, 0 of 32 false alarms |
| Reed + Rachel | Tingting + Adam | Phrases | 82 of 288 (28.5%) caught, 0 false alarms | 131 of 288 (45.5%) caught, 1 of 84 false alarms | 115 of 288 (39.9%) caught, 0 of 84 false alarms |

Settings chosen: on Tingting + Adam `{"moveSt":3,"offMarginSt":0,"phraseMarginSt":0,"flatSt":1.5,"offQuality":0.6,"offMinMs":80,"highStart":3.7,"lowLevel":2.2}`; on Reed + Rachel `{"moveSt":3.5,"offMarginSt":0,"phraseMarginSt":0,"flatSt":1.5,"offQuality":0.6,"offMinMs":80,"highStart":3.7,"lowLevel":2.2}`. The engine's defaults are the setting chosen on all four voices where the two halves agree, and the more cautious value where they don't; the defaults column is therefore not held out, and the held-out column is the honest one. The stage 0 numbers are from that commit's report (same clips; its range included the clip being scored).

Held-out false alarms: Rachel (ElevenLabs premade: an English voice speaking Mandarin) 妈[1] 妈 expected 1 heard 4; Reed (macOS) 我是学生[4] 生 expected 1 heard 3; Adam (ElevenLabs premade: an English voice speaking Mandarin) 很好[1] 很 expected 2 heard 4.

## The trade-off (in-sample)

The same clips (all four voices, range known) at several values of `offMarginSt`: how many semitones past its bar the evidence must be before a syllable is flagged. Negative values flag contours that only nearly rule the label out.

| `offMarginSt` | Singles: false alarms | Singles: caught | Phrases: false alarms | Phrases: caught |
| --- | --- | --- | --- | --- |
| -1 | 1 of 64 | 137 of 192 (71.4%) | 5 of 168 | 310 of 576 (53.8%) |
| -0.5 | 1 of 64 | 129 of 192 (67.2%) | 2 of 168 | 254 of 576 (44.1%) |
| 0 (default) | 1 of 64 | 111 of 192 (57.8%) | 0 of 168 | 201 of 576 (34.9%) |
| 0.5 | 1 of 64 | 105 of 192 (54.7%) | 0 of 168 | 148 of 576 (25.7%) |
| 1 | 1 of 64 | 71 of 192 (37.0%) | 0 of 168 | 110 of 576 (19.1%) |
| 1.5 | 1 of 64 | 54 of 192 (28.1%) | 0 of 168 | 85 of 576 (14.8%) |
| 2 | 1 of 64 | 48 of 192 (25.0%) | 0 of 168 | 71 of 576 (12.3%) |
| 3 | 1 of 64 | 33 of 192 (17.2%) | 0 of 168 | 48 of 576 (8.3%) |
| default, and creaky syllables flagged too (`creakFlags`) | 2 of 64 | 119 of 192 (62.0%) | 0 of 168 | 202 of 576 (35.1%) |

`creakFlags` is off by default. Turning it on catches more in a creaky voice, and its one extra false alarm here is Rachel's 八, the clip that falls 14 semitones; but a pitch track with a hole in it is where octave errors hide, and nothing here can tell those from a real fall, so it stays off until real recordings say otherwise.

## With lead-in noise

The clips above start and end with the speech. A push-to-talk recording doesn't: there is room noise, a key press, a knock, a cough, another voice, a hum, and the scorer has to know where the speech is before it can read a tone. This section puts those surroundings around every cached clip and scores it again, the speaker's range known, two ways: **cut by energy** (no timings: the fallback, which has to find the speech itself) and **on syllable timings** (Azure's cached reply for the CLEAN clip, each syllable's start and end moved by the lead-in; no new call was made, so Azure never heard the noisy audio). Every syllable's verdict is compared with the same syllable's verdict on the clean clip, scored the same way, because totals hide a verdict lost here and another gained there. The rule: a disturbance may cost verdicts (the third number of "changes"); it must not add a false alarm or a wrong tone passed as ok (the first two). The same disturbances, in small and on generated audio, are in `npm test`.

**Cut by energy (no timings).** Totals are wrong tones caught / false alarms / wrong tones passed as ok; changes are, against the clean clip syllable by syllable, new false alarms / new wrong tones passed as ok / right verdicts lost.

| | Singles: totals | Singles: changes | Phrases: totals | Phrases: changes |
| --- | --- | --- | --- | --- |
| The clips as they are | 111 of 192 / 1 of 64 / 9 | 0 / 0 / 0 | 201 of 576 / 0 of 168 / 57 | 0 / 0 / 0 |
| Half a second of plain silence before and after | 111 of 192 / 1 of 64 / 9 | 0 / 0 / 0 | 201 of 576 / 0 of 168 / 57 | 0 / 0 / 0 |
| Room noise at −50 dB before, under and after | 111 of 192 / 1 of 64 / 9 | 0 / 0 / 0 | 201 of 576 / 0 of 168 / 57 | 0 / 0 / 0 |
| …and a 40 ms pitched blip at −20 dB, 300 ms before the speech | 111 of 192 / 1 of 64 / 9 | 0 / 0 / 0 | 0 of 576 / 0 of 168 / 13 | 0 / 0 / 303 |
| …and a pitched knock at −10 dB, 450 ms before the speech | 111 of 192 / 1 of 64 / 9 | 0 / 0 / 0 | 0 of 576 / 0 of 168 / 12 | 0 / 0 / 303 |
| …and a pitched knock at −10 dB, 300 ms after the speech | 111 of 192 / 1 of 64 / 9 | 0 / 0 / 0 | 26 of 576 / 0 of 168 / 9 | 0 / 0 / 257 |
| …and a voiced 120 ms murmur at −27 dB, 300 ms before the speech | 89 of 192 / 1 of 64 / 7 | 0 / 0 / 34 | 165 of 576 / 0 of 168 / 46 | 0 / 0 / 64 |
| …and a knock at −10 dB ending 100 ms before the first sound | 29 of 192 / 0 of 64 / 5 | 0 / 0 / 122 | 89 of 576 / 0 of 168 / 30 | 0 / 0 / 167 |
| …and a knock at −10 dB 100 ms after the last sound | 4 of 192 / 0 of 64 / 3 | 0 / 0 / 157 | 93 of 576 / 0 of 168 / 25 | 0 / 0 / 151 |
| …and a knock at −10 dB over the first 20 ms of the speech | 80 of 192 / 1 of 64 / 10 | 0 / 1 / 36 | 183 of 576 / 3 of 168 / 58 | 3 / 7 / 30 |
| …and a cough 6 dB louder than the speech, 300 ms before it | 0 of 192 / 0 of 64 / 0 | 0 / 0 / 167 | 0 of 576 / 0 of 168 / 0 | 0 / 0 / 310 |
| …and a cough 6 dB louder than the speech, 300 ms after it | 0 of 192 / 0 of 64 / 0 | 0 / 0 / 167 | 0 of 576 / 0 of 168 / 0 | 0 / 0 / 310 |
| …and a child's voice at −10 dB in the lead-in, ending 300 ms before the speech | 0 of 192 / 0 of 64 / 0 | 0 / 0 / 167 | 0 of 576 / 0 of 168 / 0 | 0 / 0 / 310 |
| …and a 100 Hz hum at −20 dB throughout | 0 of 192 / 0 of 64 / 0 | 0 / 0 / 167 | 0 of 576 / 0 of 168 / 0 | 0 / 0 / 310 |
| …and a 60 Hz hum at −20 dB throughout | 0 of 192 / 0 of 64 / 0 | 0 / 0 / 167 | 0 of 576 / 0 of 168 / 0 | 0 / 0 / 310 |
| Room noise, and the recording starts 60 ms into the first sound (no lead-in) | 8 of 192 / 0 of 64 / 1 | 0 / 0 / 155 | 103 of 576 / 0 of 168 / 28 | 0 / 0 / 152 |
| …in a room with echo (reflections for 600 ms, decaying over 150 ms) | 35 of 192 / 4 of 64 / 20 | 4 / 17 / 112 | 16 of 576 / 3 of 168 / 32 | 3 / 12 / 281 |

**On Azure's syllable times.** Totals are wrong tones caught / false alarms / wrong tones passed as ok; changes are, against the clean clip syllable by syllable, new false alarms / new wrong tones passed as ok / right verdicts lost.

| | Singles: totals | Singles: changes | Phrases: totals | Phrases: changes |
| --- | --- | --- | --- | --- |
| The clips as they are | 101 of 192 / 1 of 64 / 8 | 0 / 0 / 0 | 153 of 576 / 0 of 168 / 40 | 0 / 0 / 0 |
| Half a second of plain silence before and after | 101 of 192 / 1 of 64 / 8 | 0 / 0 / 0 | 153 of 576 / 0 of 168 / 40 | 0 / 0 / 0 |
| Room noise at −50 dB before, under and after | 101 of 192 / 1 of 64 / 8 | 0 / 0 / 0 | 153 of 576 / 0 of 168 / 40 | 0 / 0 / 2 |
| …and a 40 ms pitched blip at −20 dB, 300 ms before the speech | 101 of 192 / 1 of 64 / 8 | 0 / 0 / 0 | 153 of 576 / 0 of 168 / 40 | 0 / 0 / 2 |
| …and a pitched knock at −10 dB, 450 ms before the speech | 101 of 192 / 1 of 64 / 8 | 0 / 0 / 0 | 153 of 576 / 0 of 168 / 40 | 0 / 0 / 2 |
| …and a pitched knock at −10 dB, 300 ms after the speech | 101 of 192 / 1 of 64 / 8 | 0 / 0 / 0 | 153 of 576 / 0 of 168 / 40 | 0 / 0 / 2 |
| …and a voiced 120 ms murmur at −27 dB, 300 ms before the speech | 101 of 192 / 1 of 64 / 8 | 0 / 0 / 0 | 153 of 576 / 0 of 168 / 40 | 0 / 0 / 2 |
| …and a knock at −10 dB ending 100 ms before the first sound | 101 of 192 / 1 of 64 / 8 | 0 / 0 / 0 | 153 of 576 / 0 of 168 / 40 | 0 / 0 / 2 |
| …and a knock at −10 dB 100 ms after the last sound | 27 of 192 / 0 of 64 / 4 | 0 / 0 / 111 | 134 of 576 / 0 of 168 / 31 | 0 / 0 / 37 |
| …and a knock at −10 dB over the first 20 ms of the speech | 65 of 192 / 1 of 64 / 8 | 0 / 0 / 38 | 120 of 576 / 0 of 168 / 39 | 0 / 3 / 45 |
| …and a cough 6 dB louder than the speech, 300 ms before it | 101 of 192 / 1 of 64 / 8 | 0 / 0 / 0 | 153 of 576 / 0 of 168 / 40 | 0 / 0 / 2 |
| …and a cough 6 dB louder than the speech, 300 ms after it | 95 of 192 / 1 of 64 / 8 | 0 / 0 / 14 | 156 of 576 / 0 of 168 / 39 | 0 / 1 / 1 |
| …and a child's voice at −10 dB in the lead-in, ending 300 ms before the speech | 101 of 192 / 1 of 64 / 8 | 0 / 0 / 0 | 153 of 576 / 0 of 168 / 40 | 0 / 0 / 0 |
| …and a 100 Hz hum at −20 dB throughout | 0 of 192 / 0 of 64 / 0 | 0 / 0 / 151 | 0 of 576 / 0 of 168 / 0 | 0 / 0 / 249 |
| …and a 60 Hz hum at −20 dB throughout | 0 of 192 / 0 of 64 / 0 | 0 / 0 / 151 | 0 of 576 / 0 of 168 / 0 | 0 / 0 / 249 |
| Room noise, and the recording starts 60 ms into the first sound (no lead-in) | 8 of 192 / 0 of 64 / 1 | 0 / 0 / 139 | 87 of 576 / 0 of 168 / 26 | 0 / 0 / 103 |
| …in a room with echo (reflections for 600 ms, decaying over 150 ms) | 38 of 192 / 4 of 64 / 17 | 4 / 13 / 96 | 28 of 576 / 2 of 168 / 24 | 2 / 7 / 220 |

**Cut by energy, before the rework** (commit e75a163; not rerun. Measured without the lead-in the clips now get, and its mid-word row had half a second of room noise before the cut, which is not a recording that starts mid-word).

| | Singles: totals | Singles: changes | Phrases: totals | Phrases: changes |
| --- | --- | --- | --- | --- |
| The clips as they are | 111 of 192 / 1 of 64 / 9 | 0 / 0 / 0 | 201 of 576 / 0 of 168 / 58 | 0 / 0 / 0 |
| Half a second of plain silence before and after | 111 of 192 / 1 of 64 / 9 | 0 / 1 / 0 | 201 of 576 / 0 of 168 / 58 | 0 / 1 / 1 |
| Room noise at −50 dB before, under and after | 111 of 192 / 1 of 64 / 9 | 0 / 1 / 0 | 201 of 576 / 0 of 168 / 58 | 0 / 1 / 1 |
| …and a 40 ms pitched blip at −20 dB, 300 ms before the speech | 111 of 192 / 1 of 64 / 9 | 0 / 1 / 0 | 176 of 576 / 0 of 168 / 50 | 0 / 1 / 41 |
| …and a pitched knock at −10 dB, 450 ms before the speech | 111 of 192 / 1 of 64 / 9 | 0 / 1 / 0 | 177 of 576 / 0 of 168 / 53 | 0 / 1 / 42 |
| …and a pitched knock at −10 dB, 300 ms after the speech | 111 of 192 / 1 of 64 / 9 | 0 / 1 / 0 | 184 of 576 / 0 of 168 / 50 | 0 / 1 / 27 |
| …and a voiced 120 ms murmur at −27 dB, 300 ms before the speech | 111 of 192 / 1 of 64 / 10 | 0 / 2 / 0 | 205 of 576 / 0 of 168 / 58 | 0 / 1 / 1 |
| …and a knock at −10 dB ending 100 ms before the first sound | 29 of 192 / 0 of 64 / 16 | 0 / 8 / 86 | 117 of 576 / 10 of 168 / 92 | 10 / 55 / 144 |
| …and a knock at −10 dB 100 ms after the last sound | 4 of 192 / 0 of 64 / 29 | 0 / 21 / 124 | 112 of 576 / 2 of 168 / 90 | 2 / 60 / 141 |
| …and a knock at −10 dB over the first 20 ms of the speech | 80 of 192 / 1 of 64 / 14 | 0 / 5 / 36 | 183 of 576 / 3 of 168 / 63 | 3 / 9 / 30 |
| …and a cough 6 dB louder than the speech, 300 ms before it | 0 of 192 / 0 of 64 / 49 | 0 / 43 / 141 | 76 of 576 / 20 of 168 / 146 | 20 / 121 / 248 |
| …and a cough 6 dB louder than the speech, 300 ms after it | 0 of 192 / 0 of 64 / 54 | 0 / 47 / 138 | 71 of 576 / 11 of 168 / 149 | 11 / 124 / 222 |
| …and a child's voice at −10 dB in the lead-in, ending 300 ms before the speech | 0 of 192 / 0 of 64 / 50 | 0 / 46 / 156 | 149 of 576 / 44 of 168 / 155 | 44 / 141 / 243 |
| …and a 100 Hz hum at −20 dB throughout | 11 of 192 / 5 of 64 / 37 | 5 / 33 / 142 | 104 of 576 / 21 of 168 / 139 | 21 / 114 / 248 |
| …and a 60 Hz hum at −20 dB throughout | 2 of 192 / 0 of 64 / 38 | 0 / 33 / 157 | 135 of 576 / 35 of 168 / 100 | 35 / 74 / 252 |
| Room noise, and the recording starts 60 ms into the first sound (no lead-in) | 110 of 192 / 1 of 64 / 13 | 0 / 5 / 6 | 147 of 576 / 2 of 168 / 65 | 2 / 15 / 79 |
| …in a room with echo (reflections for 600 ms, decaying over 150 ms) | 44 of 192 / 4 of 64 / 23 | 4 / 17 / 94 | 47 of 576 / 6 of 168 / 74 | 6 / 42 / 258 |

| Generated three-syllable phrases, in room noise | Energy before: totals | Energy before: changes | Energy: totals | Energy: changes | Timings: totals | Timings: changes | compared with |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Three syllables 70 ms apart, all alike | 297 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | 297 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | 207 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | itself |
| A 300 ms pause, then a 70 ms last syllable | 144 of 324 / 0 of 108 / 0 | 0 / 0 / 201 | 144 of 324 / 0 of 108 / 0 | 0 / 0 / 201 | 144 of 324 / 0 of 108 / 0 | 0 / 0 / 99 | three syllables 70 ms apart, all alike |
| The last syllable 27 dB under the others | 179 of 324 / 0 of 108 / 0 | 0 / 0 / 166 | 144 of 324 / 0 of 108 / 0 | 0 / 0 / 201 | 144 of 324 / 0 of 108 / 0 | 0 / 0 / 99 | three syllables 70 ms apart, all alike |
| Three syllables 150 ms apart | 297 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | 297 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | 207 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | itself |
| …and a 40 ms pitched click at −10 dB in each gap | 108 of 324 / 0 of 108 / 20 | 0 / 20 / 209 | 108 of 324 / 0 of 108 / 0 | 0 / 0 / 225 | 207 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | three syllables 150 ms apart |
| …and a voiced 60 ms "uh" at −20 dB in each gap | 157 of 324 / 12 of 108 / 32 | 12 / 32 / 175 | 134 of 324 / 0 of 108 / 0 | 0 / 0 / 203 | 207 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | three syllables 150 ms apart |
| …and a 100 ms breath at −20 dB in each gap | 297 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | 297 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | 207 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | three syllables 150 ms apart |
| The first syllable broken in two by a 40 ms creak gap | 285 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | 285 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | 135 of 324 / 0 of 108 / 0 | 0 / 0 / 0 | itself |
| …and a 300 ms pause, then a 70 ms last syllable | 162 of 324 / 57 of 108 / 80 | 57 / 80 / 207 | 51 of 324 / 0 of 108 / 0 | 0 / 0 / 303 | 72 of 324 / 0 of 108 / 0 | 0 / 0 / 99 | the first syllable broken in two by a 40 ms creak gap |

Levels are dB against the clip's loudest 10 ms; knocks, blips and the murmur are a buzz at 220 Hz, the cough a noise burst over a falling 180 Hz buzz, the child three syllables at 300 to 380 Hz. The generated phrases (three voices, twelve tone patterns each, every syllable also relabelled with each other tone) are the cases the cached clips can't express; their timings are where the generator put each syllable. The new wrong tone passed as ok that plain silence adds on the energy path is not noise: padding moves the 20 ms analysis frames, and a syllable on the edge of a bar falls the other way.

What the tables say:

- **On timings, nothing outside the spans it is given changes a verdict**: blips, knocks, a cough or a child's voice in the lead-in leave every row as the clean one. The scorer measures pitch inside the spans only and takes the silence floor, the octave repairs, the range gate and the recording's own range from inside them. **This is true by construction, and the rows assume what was not measured: that a recogniser draws the same spans on the noisy recording as on the clean one.** Azure was sent the clean clips only. A recogniser that stretches a span over a knock, or moves every span when there is a cough, gives the scorer wrong spans, and what happens then is the next section.
- **Cut by energy, every doubt is "unsure".** A sound the bars can't place is read both as speech and as noise, in every combination, and a verdict stands only where all readings agree on the verdict and the tone ("trimmed"); sounds long enough to be a syllable (60 ms of sound, which is a 90 ms voiced run in the track: a 40 ms knock is not one) that lie apart leave the whole recording unjudged ("scattered"), since one may be a cough or another voice. That is why a single stray blip costs most of a phrase's verdicts. **Under noise the fallback is safe, not useful**: with a cough, another voice or a hum it says nothing at all.
- **The caution costs right answers on clean clips too.** Before the rework (commit e75a163) the energy path marked 89.1% of correctly said single syllables and 70.8% of correctly said phrase syllables "ok"; the rework took that to 85.9% and 66.1% (an independent review's count); in this run, with the lead-in, it is 87.5% and 64.9%. Wrong tones caught did not fall.
- **A hum** leaves everything unjudged on both paths ("background"): it is under the syllables too.
- **A recording that starts mid-word** is loud from its first frame: the syllable it starts in is not judged ("clipped"), on either path. The other syllables of a phrase are still cut by energy from a first syllable that is partly missing, and that row's phrase numbers show what is left.
- **Not made safe, on either path**: a pitched knock on top of the first sound, and a room that echoes. Each puts the disturbance inside the syllable, where no way of locating the speech can take it out; the rows show the false alarms and wrong oks that remain. A sound inside a timed span (a knock or cough within the last syllable's span, which Azure draws past the end of the sound) is mostly caught as two sounds in one span ("apart"), not always.

## When the spans are wrong

The timings path believes its spans. This section gives it wrong ones: Azure's spans for each clean clip, moved or redrawn in ways that still pass the checks on their shape (in order, plausible lengths), and each syllable's verdict compared with its verdict on the spans as Azure gave them. Columns are new false alarms / new wrong tones passed as ok / right verdicts lost; "no guards" is the scorer reading each span as given, "guarded" is the scorer as it ships. Whether and how often Azure's spans are wrong like this on a real microphone is not known: these are the errors a reviewer thought of, not errors observed.

| The spans given | Singles: no guards | Singles: guarded | Phrases: no guards | Phrases: guarded | Phrase syllables read |
| --- | --- | --- | --- | --- | --- |
| All spans 150 ms early | 1 / 7 / 34 | 0 / 1 / 42 | 15 / 73 / 272 | 0 / 14 / 245 | 744 |
| All spans 100 ms early | 1 / 7 / 19 | 0 / 3 / 27 | 2 / 63 / 261 | 0 / 6 / 240 | 744 |
| All spans 50 ms early | 1 / 3 / 7 | 0 / 1 / 16 | 0 / 11 / 69 | 0 / 2 / 185 | 744 |
| All spans 50 ms late | 0 / 4 / 8 | 0 / 0 / 28 | 0 / 29 / 66 | 0 / 2 / 133 | 744 |
| All spans 100 ms late | 0 / 12 / 44 | 0 / 2 / 79 | 3 / 48 / 208 | 0 / 9 / 208 | 744 |
| All spans 150 ms late | 1 / 10 / 87 | 0 / 2 / 96 | 7 / 85 / 244 | 0 / 7 / 233 | 744 |
| One boundary 100 ms early | – | – | 1 / 65 / 315 | 0 / 2 / 348 | 1338 |
| One boundary 50 ms early | – | – | 0 / 10 / 74 | 0 / 4 / 239 | 1524 |
| One boundary 50 ms late | – | – | 0 / 17 / 30 | 0 / 6 / 117 | 1514 |
| One boundary 100 ms late | – | – | 6 / 40 / 189 | 0 / 9 / 253 | 1428 |
| One span takes all of the next syllable but its last 60 ms | – | – | 3 / 57 / 358 | 0 / 0 / 390 | 1524 |
| One span takes all of the syllable before but its first 60 ms | – | – | 5 / 64 / 386 | 0 / 1 / 411 | 1524 |

The guards (`TIMING_RULES`):

- **Edges.** Every recording is read again with all its spans 40 ms earlier and later, and with each boundary between two neighbours 40 ms either way; a verdict stands only where every reading gives it, for the same tone ("edges" otherwise). A reading in which the moved span merely takes in a separate sound ("apart") is not held against the verdict.
- **Lopsided.** Of two neighbouring spans, one with hardly any voice in it, or one under 100 ms beside one 3 times its length: neither is judged where the other took its sound.
- **What they cost on the spans as Azure gave them**: 14 single and 65 phrase verdicts, and no new false alarm or wrong ok. Singles: 107 of 192 caught / 1 of 64 false alarms / 11 passed as ok without the guards; 101 of 192 caught / 1 of 64 false alarms / 8 passed as ok with. Phrases: 196 of 576 caught / 0 of 168 false alarms / 59 passed as ok without; 153 of 576 caught / 0 of 168 false alarms / 40 passed as ok with. The timings tables in the section above are the guarded scorer.
- **What they don't stop**: spans wrong by much more than the jitter in a way that still looks like syllables. The rows for 100 and 150 ms keep wrong tones passed as ok. A wrong span costs most of its clip's verdicts either way, which is the right price.
- **A word Azure times as a whole** (no per-syllable times) is cut by energy inside that word's span only, on pitch finished on that span alone, and those cuts count for what any fallback cut does (`rough`).

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
| tone 4 | 0 | 1 | 1 | 14 | 0 | 87.5% |

Why syllables were unsure (all labels): unclear 72, creaky 10, octave 4, trimmed 4.

False alarms: Rachel (ElevenLabs premade: an English voice speaking Mandarin) 妈[1] 妈 expected 1 heard 4.

### Single syllables, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 14 | 0 | 0 | 2 | 0 | 87.5% |
| tone 2 | 0 | 14 | 2 | 0 | 0 | 87.5% |
| tone 3 | 0 | 2 | 14 | 0 | 0 | 87.5% |
| tone 4 | 1 | 0 | 2 | 13 | 0 | 81.3% |

Why syllables were unsure (all labels): unclear 61, creaky 11, octave 4, trimmed 3.

False alarms: Rachel (ElevenLabs premade: an English voice speaking Mandarin) 妈[1] 妈 expected 1 heard 4.

### Phrases, cut by energy, nothing known about the speaker

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 20 | 0 | 0 | 3 | 1 | 83.3% |
| tone 2 | 2 | 34 | 7 | 2 | 3 | 70.8% |
| tone 3 | 2 | 1 | 25 | 5 | 3 | 69.4% |
| tone 4 | 0 | 0 | 13 | 36 | 11 | 60.0% |

Why syllables were unsure (all labels): unclear 327, unvoiced 72, creaky 9, trimmed 6.

### Phrases, cut by energy, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 22 | 0 | 1 | 0 | 1 | 91.7% |
| tone 2 | 6 | 26 | 11 | 2 | 3 | 54.2% |
| tone 3 | 2 | 1 | 26 | 4 | 3 | 72.2% |
| tone 4 | 3 | 0 | 17 | 29 | 11 | 48.3% |

Why syllables were unsure (all labels): unclear 293, unvoiced 72, creaky 10, trimmed 2.

### Phrases, cut by energy around Scribe's character times, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 22 | 0 | 1 | 0 | 1 | 91.7% |
| tone 2 | 6 | 27 | 11 | 1 | 3 | 56.3% |
| tone 3 | 2 | 1 | 25 | 5 | 3 | 69.4% |
| tone 4 | 3 | 0 | 17 | 29 | 11 | 48.3% |

Why syllables were unsure (all labels): unclear 290, unvoiced 73, creaky 10, apart 4, trimmed 1.

### Phrases, Scribe's character times taken as the cuts, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 14 | 0 | 1 | 0 | 9 | 58.3% |
| tone 2 | 9 | 7 | 7 | 3 | 22 | 14.6% |
| tone 3 | 1 | 0 | 16 | 2 | 17 | 44.4% |
| tone 4 | 3 | 0 | 11 | 25 | 21 | 41.7% |

Why syllables were unsure (all labels): unclear 198, timings 191, edges 93, short 84, creaky 42, lopsided 34, unvoiced 20, untimed 12, apart 10.

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
| Singles, right reference | 64 | 82 | 1 (1.6%) | 0 (0.0%) | 1 (1.6%) | 1 (1.6%): 1 tone, 0 sound | false alarms | 50 (78.1%) |
| Singles, wrong-tone reference | 192 | 61 | 55 (28.6%) | 21 (10.9%) | 111 (57.8%) | 107 (55.7%): 99 tone, 8 sound | caught | 8 (4.2%) |
| Phrases, right reference | 168 | 100 | 4 (2.4%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%): 0 tone, 0 sound | false alarms | 96 (57.1%) |

Where Azure's syllable score separates right from wrong, and where it doesn't. Syllables scoring under each bar (in brackets: those on a word Azure also marks `Mispronunciation`):

| Score under | Singles, right | Singles, wrong tone | Phrases, right |
| --- | --- | --- | --- |
| 30 | 0 (0) of 64 | 8 (8) of 192 | 0 (0) of 168 |
| 40 | 0 (0) of 64 | 21 (21) of 192 | 0 (0) of 168 |
| 50 | 0 (0) of 64 | 54 (39) of 192 | 5 (2) of 168 |
| 60 | 0 (0) of 64 | 93 (52) of 192 | 7 (3) of 168 |
| 70 | 7 (1) of 64 | 132 (55) of 192 | 10 (4) of 168 |

`phraseMarginSt` (the extra margin a flag needs inside a phrase, 0.5 semitones) was set after looking at these very syllables, above every phrase false alarm on Azure's timings: correctly said phrase syllables flagged with it at 0, 0.25 and 0.5 are 0, 0 and 0 of 168, and the cleanly measured right syllable that comes closest sits at 0.283. So phrase flags rest on a thin margin that these clips chose.

The merged result's false alarms: Rachel 妈[1] 妈 expected 1 heard 4, margin 4.959, Azure 80, 240–920 ms.

A high Azure score is not evidence of a right tone (the median wrong-tone syllable scores above 60), so the merged result never turns an unclear pitch reading into "ok" on Azure's word.

On the single syllables, precision of a flag as measured (three wrong for each right): Azure's own `Mispronunciation` mark 98.2%, the local scorer 99.1%, the merged result 99.1%. The merged result flags on the local pitch check, or on Azure's `Mispronunciation` mark with a score under 40.

What the replies look like for Mandarin (316 flat, 0 with a nested `PronunciationAssessment` object): scores sit directly on the `NBest` entry, the word and the phoneme. 48 of 381 words are longer than one character (你好, 学生: Azure segments into words). In 381 of 381 words the `Phonemes` array has exactly one entry per character: a "phoneme" is a whole syllable with its tone as a digit (`ni 3`, `hao 3`; 5 is neutral), with its own offset, duration and score. That digit is the tone of the **reference** reading (the dictionary tone, before sandhi; for a character with several readings, one of them), not the tone that was heard: Azure does not report a heard tone. `DisplayText` echoes the reference too. What a wrong tone changes is the score.

A wrong-tone sample, verbatim (Tingting's 妈, mā, assessed against 马, mǎ):

```json
{"RecognitionStatus":"Success","Offset":400000,"Duration":2400000,"DisplayText":"马。","SNR":19.011362,"NBest":[{"Confidence":0.78632134,"Lexical":"马","ITN":"马","MaskedITN":"马","Display":"马。","AccuracyScore":54,"FluencyScore":0,"CompletenessScore":0,"PronScore":10.8,"Words":[{"Word":"马","Offset":400000,"Duration":2400000,"Confidence":0,"AccuracyScore":54,"ErrorType":"Mispronunciation","Syllables":[{"Syllable":"","Grapheme":"马","Offset":400000,"Duration":2400000,"AccuracyScore":50}],"Phonemes":[{"Phoneme":"ma 3","Offset":400000,"Duration":2400000,"AccuracyScore":50}]}]}]}
```

## Scribe's timings

60 phrase clips were transcribed by Scribe v2 with `timestamps_granularity=character` (the app sends no such field today, and `transcriptText` keeps only `text`). For Chinese the reply has one `words` entry per character: 175 entries, 0 longer than one character, 175 carrying a `characters` array. 168 of 172 expected syllables found their character in the transcript.

The times are not syllable boundaries. The median character span is 140 ms and 17 of 168 are 40 ms or shorter, in clips whose syllables last 150 to 300 ms: Scribe reports roughly when it recognized each character. Taken as cuts they leave most syllables too short to score (the last column of the table above). But 136 of 168 character start times fall inside the stretch the energy cuts give that syllable, so they work as anchors: `scoreTones({ anchors })` cuts by energy and keeps each piece on its character's time. On these short, pause-free clips that changes little; its use is longer speech with pauses, which this set does not contain.

## Speed

Scoring a 3-second, 16 kHz recording on this machine (arm64, Node v26.4.0): 24 ms (median of 12; slowest 24 ms). The most it takes, 27 seconds and 60 syllables (the clip looped; median of 5): 215 ms cut by energy, 304 ms on timings; the pitch track is the same work in both, and with the track already in hand the rest is 0 ms and 90 ms. Nearly all of it is the pitch track.

## Settings this ran with

`TONE_RULES` = `{"stepSt":2.5,"minRangeSt":7,"maxRangeSt":12,"sigmaSt":1,"levelWeight":0.3,"minFrames":6,"okBelief":0.34,"moveSt":3,"stillSt":1,"flatSt":1.5,"highLevel":3.8,"highStart":3.7,"lowLevel":2.2,"lowTop":2.2,"dipShare":0.25,"riseStart":2.5,"lateFrom":2,"scaleRange":true,"riseShare":0.5,"offMarginSt":0,"offQuality":0.75,"offMinMs":80,"phraseMarginSt":0.5,"creakFlags":false,"creakTrust":0.85,"apartMs":50,"softShare":0.1,"clippedMs":30,"clippedShare":0.15}`; cuts made by energy are trusted at 0.85. With timings they are checked first (`TIMING_RULES` = `{"minMs":40,"maxMs":1500,"slackMs":20,"jitterMs":40,"neighbourMs":100,"sliverMs":100,"lopsided":3}`); without, the speech is found by energy (`TRIM_RULES` = `{"runMs":80,"sureDb":-12,"joinMs":20,"floorDb":-26,"nearMs":200,"beforeMs":250,"afterMs":120,"loudShare":0.15,"bridgeMs":100,"stillMs":300,"stillSt":0.5,"judgeMs":60,"windowMs":30,"maxDoubts":3}`). On these 124 clips the bars alone (`trimToSpeech`, one opinion of where the speech is) remove a voiced frame from 0, and in 4 of Adam's it silences unvoiced frames within 22 dB of the loudest voiced frame (the breathy end of a last syllable, past the 120 ms kept after the voicing). It is for real recordings, which have seconds of room and key noise around the speech.



**What these clips cannot measure.** Every number in `TRIM_RULES`, and the half weight a creaky syllable's "ok" carries, was set on 43 real recordings from one speaker, one microphone, one room; none of them is held out, and synthesized voices barely creak. So the energy path doesn't rest a verdict on them: where the bars can't place a sound, the result is "unsure". What that costs and what it lets through is "With lead-in noise" above, and its small copy in `npm test`.



**Creaky syllables.** A creaky syllable may be "ok" when its voiced part fits (it is never "off"), is marked `creaky`, and is left out of `overall`. That rule let more wrong tones pass as ok when it was introduced: phrases on Scribe's cuts went from 52 to 58 of 576, single syllables with nothing known about the speaker from 24 to 25 of 192 (the commit before against the commit with it, same clips). In this run: 16 of 576 (phrases, scribe's character times taken as the cuts, speaker's range known) and 24 of 192 (single syllables, nothing known about the speaker).

## Before wiring this to a route

- **Start with single syllables and drills.** Their flags have room to spare; phrase flags rest on a half-semitone margin chosen on these clips, and the held-out phrase false alarms are the highest number in this report.
- **Build the speaker's range only from the learner's other recordings**, never from the one being scored, and not at all until there are a few: without a range the height rules are silent, which is the safe side.
- **Run it off the request thread.** The scorer is synchronous and refuses more than 30 seconds or 60 syllables. A pitch track made on one thread and scored on another is fine: the raw pitch is a field of the track (`rawF0`) and survives the copy; a track without it is tracked again from the samples, or nothing is judged.
- **Check the recogniser's spans on real noisy recordings before trusting the timings path there**: send the same speech clean and with a knock, a cough, another voice, and compare the spans that come back. Nothing in this report measures that.
- **Refuse or re-ask a recording that starts loud.** The scorer leaves its first syllable unjudged; the learner pressed the button late.
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
