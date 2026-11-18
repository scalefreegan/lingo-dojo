# Pronunciation scoring: proof of the local tone scorer

Written by `node scripts/pronunciation-proof.mjs` on 2026-11-18. Rerun it to refresh; the clips are cached, so a rerun is free. Stage 0 of the pronunciation feature (bead ld-ne0.1); the engine is `scripts/pronunciation.mjs`, described in [VOICE.md](VOICE.md#pronunciation).

## What was tested

124 synthesized clips from 4 voices: Tingting (macOS), female, median 217 Hz; Reed (macOS), male, median 102 Hz; Rachel (ElevenLabs premade: an English voice speaking Mandarin), female, median 161 Hz; Adam (ElevenLabs premade: an English voice speaking Mandarin), male, median 137 Hz. Each voice says 16 single syllables (ma, shi, yi, ba in each of the four tones: 妈 麻 马 骂 诗 十 使 是 衣 姨 椅 意 八 拔 把 爸) and 15 phrases (你好、不是、一个、很好、谢谢、我很好、不客气、一起去、你叫什么、我想喝水、明天见、今天很热、我是学生、他不来、再见).

There are no learner recordings, so every clip is used twice over. Scored against its own text it is a **right** answer: an "off" there is a false alarm. Scored against the same syllables with one tone changed it is a **wrong** answer: 妈 labelled 马 is a learner who said mā for mǎ, and an "off" on that syllable is a catch. The connected-speech rules are applied to each label first, so a relabelling that the rules make equivalent (你 as ní before 好) is not counted as wrong. Syllables whose true or labelled tone is neutral are left out: the scorer does not judge them.

The number that matters is how many "off" flags are false: a learner told a right tone was wrong stops believing the marks. A miss costs less. The set holds about three wrong labels for each right one, which flatters raw precision, so each table also restates it for a learner who gets one tone in five wrong.

## Results

| | Singles, speaker unknown | Singles, range known | Phrases, speaker unknown | Phrases, range known | Phrases, Scribe anchors, range known | Phrases, Scribe times as cuts, range known |
| --- | --- | --- | --- | --- | --- | --- |
| Right syllables scored | 64 | 64 | 168 | 168 | 168 | 168 |
| Wrong syllables scored | 192 | 192 | 576 | 576 | 576 | 576 |
| **False alarms** (right, flagged off) | 1 of 64 (1.6%) | 1 of 64 (1.6%) | 0 of 168 (0.0%) | 0 of 168 (0.0%) | 0 of 168 (0.0%) | 0 of 168 (0.0%) |
| **Precision of an off flag**, as measured | 99.0% | 99.2% | 100.0% | 100.0% | 100.0% | 100.0% |
| Precision at one wrong tone in five | 89.2% | 91.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| Wrong tones caught (flagged off) | 99 of 192 (51.6%) | 121 of 192 (63.0%) | 187 of 576 (32.5%) | 224 of 576 (38.9%) | 222 of 576 (38.5%) | 124 of 576 (21.5%) |
| Wrong tones passed as ok | 10.9% | 3.1% | 10.9% | 9.5% | 9.5% | 8.7% |
| Right tones marked ok | 79.7% | 85.9% | 73.8% | 67.3% | 66.1% | 43.5% |
| Right tones marked unsure | 18.8% | 12.5% | 26.2% | 32.7% | 33.9% | 56.5% |
| Marked unsure, all | 32.8% | 28.5% | 49.7% | 47.3% | 47.8% | 66.8% |

These are small counts. A false-alarm rate measured on a few dozen or a couple of hundred syllables is only bounded, not known: with 95% confidence, single syllables, nothing known about the speaker: 1 of 64, so under 7.2%; single syllables, speaker's range known: 1 of 64, so under 7.2%; phrases, cut by energy, nothing known about the speaker: 0 of 168, so under 1.8%; phrases, cut by energy, speaker's range known: 0 of 168, so under 1.8%; phrases, cut by energy around scribe's character times, speaker's range known: 0 of 168, so under 1.8%; phrases, scribe's character times taken as the cuts, speaker's range known: 0 of 168, so under 1.8%. And that bound is for voices like these, on the set the thresholds were tuned on.

So "a flag can be trusted" is not established by these counts, only not contradicted. With the false-alarm rate at that upper bound and the catch rate as measured, the precision of a flag for a learner who gets one tone in five wrong is only known to be: single syllables, nothing known about the speaker: at least 64%; single syllables, speaker's range known: at least 69%; phrases, cut by energy, nothing known about the speaker: at least 82%; phrases, cut by energy, speaker's range known: at least 85%; phrases, cut by energy around scribe's character times, speaker's range known: at least 85%; phrases, scribe's character times taken as the cuts, speaker's range known: at least 75%. Narrowing that takes more right syllables, from real people.

"Range known" gives the scorer the voice's pitch range measured over that voice's other clips (never the one being scored), which is what a session would know after a few turns. "Speaker unknown" is a first recording: only the shape of the contour counts, plus the recording's own range once it holds four syllables.

## The classifier before any gate

What tone the classifier names for each single syllable (speaker's range known), whatever it then decides to say about it. This is the question "is it misreading the pitch, or just not daring to flag?".

| Voice | Named the labelled tone | tone 1 heard as 1/2/3/4 | tone 2 | tone 3 | tone 4 |
| --- | --- | --- | --- | --- | --- |
| Tingting | 14 of 16 | 4/0/0/0 | 0/3/1/0 | 0/0/4/0 | 0/0/1/3 |
| Reed | 14 of 16 | 4/0/0/0 | 0/4/0/0 | 0/2/2/0 | 0/0/0/4 |
| Rachel | 13 of 16 | 2/0/0/2 | 0/3/1/0 | 0/0/4/0 | 0/0/0/4 |
| Adam | 16 of 16 | 4/0/0/0 | 0/4/0/0 | 0/0/4/0 | 0/0/0/4 |
| **All** | **57 of 64** | | | | |

So the classifier mostly reads the pitch right (stage 0's named 53 of 64); the catch rate is lower than this because a flag asks for more than a best guess. What the contours of the misread and unflagged clips showed when looked at one by one: two of Rachel's first tones (妈, 八) fall by 9 and 14 semitones, a fourth tone's contour whatever the label says (Azure scores that 八 at 90 against 爸 and 61 against 八), so those two "errors" are probably the clips; the macOS voices say some second tones as a dip that comes back up and some third tones as a shallow dip that rises, which are each other's shapes; one fourth tone starts in the middle of the range and reads as a low third; and Adam's voice creaks, leaving a hole in the middle of several pitch tracks, which costs flags, not readings. No miss on these clips came from an octave error, from the consonant at the start, or from the range used to normalise. The misses came from the gate: stage 0 never flagged third against second or fourth in either direction (a third of all wrong labels), asked for four semitones of movement, and let a second tone's first dip or a fourth tone's first rise count as "it climbs" or "it drops".

Where the catches are and aren't, by which tone was said for which (range known; caught / marked ok / all):

| Said → labelled | Singles | Phrases |
| --- | --- | --- |
| 1→2 | 12 / 0 / 16 | 15 / 0 / 32 |
| 1→3 | 12 / 0 / 16 | 5 / 1 / 16 |
| 1→4 | 11 / 1 / 16 | 10 / 2 / 24 |
| 2→1 | 11 / 0 / 16 | 18 / 10 / 44 |
| 2→3 | 10 / 2 / 16 | 34 / 9 / 76 |
| 2→4 | 11 / 0 / 16 | 21 / 2 / 76 |
| 3→1 | 10 / 0 / 16 | 20 / 3 / 36 |
| 3→2 | 8 / 2 / 16 | 11 / 3 / 52 |
| 3→4 | 2 / 0 / 16 | 1 / 4 / 36 |
| 4→1 | 12 / 0 / 16 | 29 / 3 / 56 |
| 4→2 | 12 / 0 / 16 | 43 / 1 / 72 |
| 4→3 | 10 / 1 / 16 | 17 / 17 / 56 |

Three pairs stay close to uncatchable by design: a third tone said for a fourth (3→4: a low fall is both), a fourth that starts low said for a third, and second against third when the second dips or the third comes back up. These voices disagree with each other about exactly those shapes, so a flag there would be a guess.

## Held out by voice

The thresholds a flag rests on were chosen on two voices and measured on the other two, which had no say in them, then the other way round. "Chosen" means: of 864 settings (`moveSt` 3/3.5/4, `offMarginSt` 0/0.5/1, `phraseMarginSt` 0/0.5/1, `flatSt` 1/1.5, `offQuality` 0.6/0.75, `offMinMs` 80/110, `highStart` 3.7/4.2, `lowLevel` 2.2/2.6), the one that catches the most wrong tones on the tuning voices while flagging at most one of their right syllables. Range known, cuts by energy, each clip read against the range of the voice's other clips.

| Tuned on | Measured on | | Stage 0 (before) | Tuned on the other two (held out) | The engine's defaults |
| --- | --- | --- | --- | --- | --- |
| Tingting + Adam | Reed + Rachel | Singles | 39 of 96 (40.6%) caught, 1 false alarms | 70 of 96 (72.9%) caught, 1 of 32 false alarms | 67 of 96 (69.8%) caught, 1 of 32 false alarms |
| Tingting + Adam | Reed + Rachel | Phrases | 63 of 288 (21.9%) caught, 0 false alarms | 144 of 288 (50.0%) caught, 3 of 84 false alarms | 105 of 288 (36.5%) caught, 0 of 84 false alarms |
| Reed + Rachel | Tingting + Adam | Singles | 42 of 96 (43.8%) caught, 0 false alarms | 54 of 96 (56.3%) caught, 0 of 32 false alarms | 54 of 96 (56.3%) caught, 0 of 32 false alarms |
| Reed + Rachel | Tingting + Adam | Phrases | 82 of 288 (28.5%) caught, 0 false alarms | 119 of 288 (41.3%) caught, 0 of 84 false alarms | 119 of 288 (41.3%) caught, 0 of 84 false alarms |

Settings chosen: on Tingting + Adam `{"moveSt":3.5,"offMarginSt":0,"phraseMarginSt":0,"flatSt":1.5,"offQuality":0.6,"offMinMs":80,"highStart":3.7,"lowLevel":2.2}`; on Reed + Rachel `{"moveSt":3,"offMarginSt":0,"phraseMarginSt":0.5,"flatSt":1.5,"offQuality":0.75,"offMinMs":80,"highStart":3.7,"lowLevel":2.2}`. The engine's defaults are the setting chosen on all four voices where the two halves agree, and the more cautious value where they don't; the defaults column is therefore not held out, and the held-out column is the honest one. The stage 0 numbers are from that commit's report (same clips; its range included the clip being scored).

Held-out false alarms: Rachel (ElevenLabs premade: an English voice speaking Mandarin) 妈[1] 妈 expected 1 heard 4; Reed (macOS) 不客气[2] 客 expected 4 heard 2; Reed (macOS) 我是学生[4] 生 expected 1 heard 3; Rachel (ElevenLabs premade: an English voice speaking Mandarin) 我想喝水[4] 水 expected 3 heard 2.

## The trade-off

The same clips (all four voices, range known) at several values of `offMarginSt`: how many semitones past its bar the evidence must be before a syllable is flagged. Negative values flag contours that only nearly rule the label out.

| `offMarginSt` | Singles: false alarms | Singles: caught | Phrases: false alarms | Phrases: caught |
| --- | --- | --- | --- | --- |
| -1 | 2 of 64 | 145 of 192 (75.5%) | 10 of 168 | 346 of 576 (60.1%) |
| -0.5 | 1 of 64 | 132 of 192 (68.8%) | 6 of 168 | 298 of 576 (51.7%) |
| 0 (default) | 1 of 64 | 121 of 192 (63.0%) | 0 of 168 | 224 of 576 (38.9%) |
| 0.5 | 1 of 64 | 113 of 192 (58.9%) | 0 of 168 | 184 of 576 (31.9%) |
| 1 | 1 of 64 | 76 of 192 (39.6%) | 0 of 168 | 142 of 576 (24.7%) |
| 1.5 | 1 of 64 | 61 of 192 (31.8%) | 0 of 168 | 105 of 576 (18.2%) |
| 2 | 1 of 64 | 53 of 192 (27.6%) | 0 of 168 | 85 of 576 (14.8%) |
| 3 | 1 of 64 | 41 of 192 (21.4%) | 0 of 168 | 55 of 576 (9.5%) |
| default, and creaky syllables flagged too (`creakFlags`) | 2 of 64 | 136 of 192 (70.8%) | 0 of 168 | 234 of 576 (40.6%) |

`creakFlags` is off by default. Turning it on catches more in a creaky voice, and its one extra false alarm here is Rachel's 八, the clip that falls 14 semitones; but a pitch track with a hole in it is where octave errors hide, and nothing here can tell those from a real fall, so it stays off until real recordings say otherwise.

## Real recordings

None yet: everything above is synthesized speech. This is the next step, and the harness is ready for it.

Put recordings in `data/pronunciation-proof/recordings/` (gitignored; with `LINGO_PROOF_DIR` set, its `recordings/` folder) and list them in a `labels.tsv` beside them, one recording per line, tab-separated:

```
# file<TAB>text<TAB>said (optional)<TAB>speaker (optional)
nihao-1.wav	你好
ma-wrong.wav	妈	ma3
wo-shi-xuesheng.m4a	我是学生	wo3 shi4 xue2 sheng2	sam
```

- `file`: WAV, M4A, MP3 or WebM; anything that isn't 16 kHz mono WAV is converted with ffmpeg (or macOS's afconvert) into `recordings/.wav16k/`. The app's own recordings are already the right format.
- `text`: the characters the learner was asked to say.
- `said`: only when the learner said something else on purpose, to test the flags: one pinyin syllable per character with the tone as a digit (5 or 0 for neutral), as actually said. `ma3` against 妈 is a deliberate mǎ for mā. Leave it out when the recording is a good-faith attempt you have listened to and judged right.
- `speaker`: any name; recordings with the same name share a pitch range, each read against the range of that speaker's other recordings (leave it out for one speaker).

Then run `node scripts/pronunciation-proof.mjs --quick`. Nothing is uploaded: the local scorer runs on this machine. A syllable whose `said` tone is one the text accepts counts as right (a flag on it is a false alarm); any other counts as wrong (a flag is a catch). Twenty or thirty phrases from each of two or three people, a third of them with one deliberate wrong tone, would say more than everything above.

### Single syllables, nothing known about the speaker

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 14 | 0 | 0 | 2 | 0 | 87.5% |
| tone 2 | 0 | 14 | 2 | 0 | 0 | 87.5% |
| tone 3 | 1 | 3 | 11 | 1 | 0 | 68.8% |
| tone 4 | 0 | 0 | 0 | 16 | 0 | 100.0% |

Why syllables were unsure (all labels): unclear 61, creaky 23.

False alarms: Rachel (ElevenLabs premade: an English voice speaking Mandarin) 妈[1] 妈 expected 1 heard 4.

### Single syllables, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 14 | 0 | 0 | 2 | 0 | 87.5% |
| tone 2 | 0 | 14 | 2 | 0 | 0 | 87.5% |
| tone 3 | 0 | 2 | 14 | 0 | 0 | 87.5% |
| tone 4 | 0 | 0 | 1 | 15 | 0 | 93.8% |

Why syllables were unsure (all labels): unclear 47, creaky 26.

False alarms: Rachel (ElevenLabs premade: an English voice speaking Mandarin) 妈[1] 妈 expected 1 heard 4.

### Phrases, cut by energy, nothing known about the speaker

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 20 | 1 | 1 | 2 | 0 | 83.3% |
| tone 2 | 2 | 34 | 7 | 2 | 3 | 70.8% |
| tone 3 | 1 | 2 | 27 | 4 | 2 | 75.0% |
| tone 4 | 2 | 0 | 13 | 40 | 5 | 66.7% |

Why syllables were unsure (all labels): unclear 302, creaky 28, unvoiced 20, short 20.

### Phrases, cut by energy, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 21 | 0 | 1 | 2 | 0 | 87.5% |
| tone 2 | 4 | 31 | 8 | 2 | 3 | 64.6% |
| tone 3 | 2 | 2 | 26 | 4 | 2 | 72.2% |
| tone 4 | 4 | 1 | 16 | 34 | 5 | 56.7% |

Why syllables were unsure (all labels): unclear 279, creaky 33, unvoiced 20, short 20.

### Phrases, cut by energy around Scribe's character times, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 21 | 0 | 1 | 2 | 0 | 87.5% |
| tone 2 | 4 | 31 | 9 | 1 | 3 | 64.6% |
| tone 3 | 2 | 2 | 25 | 5 | 2 | 69.4% |
| tone 4 | 4 | 1 | 16 | 34 | 5 | 56.7% |

Why syllables were unsure (all labels): unclear 275, creaky 40, unvoiced 25, short 16.

### Phrases, Scribe's character times taken as the cuts, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 17 | 0 | 1 | 2 | 4 | 70.8% |
| tone 2 | 12 | 12 | 8 | 5 | 11 | 25.0% |
| tone 3 | 2 | 2 | 16 | 2 | 14 | 44.4% |
| tone 4 | 2 | 1 | 11 | 33 | 13 | 55.0% |

Why syllables were unsure (all labels): unclear 238, short 153, creaky 80, unvoiced 22, untimed 4.

### By voice (range known, cut by energy)

| Voice | Singles: false alarms | Singles: caught | Phrases: false alarms | Phrases: caught |
| --- | --- | --- | --- | --- |
| Tingting (macOS) | 0 of 16 (0.0%) | 33 of 48 (68.8%) | 0 of 42 (0.0%) | 69 of 144 (47.9%) |
| Reed (macOS) | 0 of 16 (0.0%) | 33 of 48 (68.8%) | 0 of 42 (0.0%) | 26 of 144 (18.1%) |
| Rachel (ElevenLabs premade: an English voice speaking Mandarin) | 1 of 16 (6.3%) | 34 of 48 (70.8%) | 0 of 42 (0.0%) | 79 of 144 (54.9%) |
| Adam (ElevenLabs premade: an English voice speaking Mandarin) | 0 of 16 (0.0%) | 21 of 48 (43.8%) | 0 of 42 (0.0%) | 50 of 144 (34.7%) |

## Azure, live

316 live replies from Azure Pronunciation Assessment (`zh-CN`, the REST short-audio endpoint in `<region>.stt.speech.microsoft.com`, free F0 tier, one request at a time). Every clip was assessed against its own text; each single syllable also against the other three tones of the same syllable, which is the wrong-tone sample: the audio of 妈 with 马 as the reference text. There are no wrong-tone phrase samples for Azure (it needs real characters as the reference, and the proof's phrase relabellings are pinyin only).

| | Syllables | Azure's median score | Azure marks the word `Mispronunciation` | Azure score under 40 | Local scorer alone flags | Merged result flags | which are | Merged result says ok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Singles, right reference | 64 | 82 | 1 (1.6%) | 0 (0.0%) | 1 (1.6%) | 1 (1.6%): 1 tone, 0 sound | false alarms | 55 (85.9%) |
| Singles, wrong-tone reference | 192 | 61 | 55 (28.6%) | 21 (10.9%) | 121 (63.0%) | 120 (62.5%): 113 tone, 7 sound | caught | 9 (4.7%) |
| Phrases, right reference | 168 | 100 | 4 (2.4%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%): 0 tone, 0 sound | false alarms | 109 (64.9%) |

Where Azure's syllable score separates right from wrong, and where it doesn't. Syllables scoring under each bar (in brackets: those on a word Azure also marks `Mispronunciation`):

| Score under | Singles, right | Singles, wrong tone | Phrases, right |
| --- | --- | --- | --- |
| 30 | 0 (0) of 64 | 8 (8) of 192 | 0 (0) of 168 |
| 40 | 0 (0) of 64 | 21 (21) of 192 | 0 (0) of 168 |
| 50 | 0 (0) of 64 | 54 (39) of 192 | 5 (2) of 168 |
| 60 | 0 (0) of 64 | 93 (52) of 192 | 7 (3) of 168 |
| 70 | 7 (1) of 64 | 132 (55) of 192 | 10 (4) of 168 |

The merged result's false alarms: Rachel 妈[1] 妈 expected 1 heard 4, margin 5.559, Azure 80, 40–720 ms.

A high Azure score is not evidence of a right tone (the median wrong-tone syllable scores above 60), so the merged result never turns an unclear pitch reading into "ok" on Azure's word.

On the single syllables, precision of a flag as measured (three wrong for each right): Azure's own `Mispronunciation` mark 98.2%, the local scorer 99.2%, the merged result 99.2%. The merged result flags on the local pitch check, or on Azure's `Mispronunciation` mark with a score under 40.

What the replies look like for Mandarin (316 flat, 0 with a nested `PronunciationAssessment` object): scores sit directly on the `NBest` entry, the word and the phoneme. 48 of 381 words are longer than one character (你好, 学生: Azure segments into words). In 381 of 381 words the `Phonemes` array has exactly one entry per character: a "phoneme" is a whole syllable with its tone as a digit (`ni 3`, `hao 3`; 5 is neutral), with its own offset, duration and score. That digit is the tone of the **reference** reading (the dictionary tone, before sandhi; for a character with several readings, one of them), not the tone that was heard: Azure does not report a heard tone. `DisplayText` echoes the reference too. What a wrong tone changes is the score.

A wrong-tone sample, verbatim (Tingting's 妈, mā, assessed against 马, mǎ):

```json
{"RecognitionStatus":"Success","Offset":400000,"Duration":2400000,"DisplayText":"马。","SNR":19.011362,"NBest":[{"Confidence":0.78632134,"Lexical":"马","ITN":"马","MaskedITN":"马","Display":"马。","AccuracyScore":54,"FluencyScore":0,"CompletenessScore":0,"PronScore":10.8,"Words":[{"Word":"马","Offset":400000,"Duration":2400000,"Confidence":0,"AccuracyScore":54,"ErrorType":"Mispronunciation","Syllables":[{"Syllable":"","Grapheme":"马","Offset":400000,"Duration":2400000,"AccuracyScore":50}],"Phonemes":[{"Phoneme":"ma 3","Offset":400000,"Duration":2400000,"AccuracyScore":50}]}]}]}
```

## Scribe's timings

60 phrase clips were transcribed by Scribe v2 with `timestamps_granularity=character` (the app sends no such field today, and `transcriptText` keeps only `text`). For Chinese the reply has one `words` entry per character: 175 entries, 0 longer than one character, 175 carrying a `characters` array. 168 of 172 expected syllables found their character in the transcript.

The times are not syllable boundaries. The median character span is 140 ms and 17 of 168 are 40 ms or shorter, in clips whose syllables last 150 to 300 ms: Scribe reports roughly when it recognized each character. Taken as cuts they leave most syllables too short to score (the last column of the table above). But 137 of 168 character start times fall inside the stretch the energy cuts give that syllable, so they work as anchors: `scoreTones({ anchors })` cuts by energy and keeps each piece on its character's time. On these short, pause-free clips that changes little; its use is longer speech with pauses, which this set does not contain.

## Speed

Scoring a 3-second, 16 kHz recording on this machine (arm64, Node v26.4.0): 24 ms (median of 12; slowest 24 ms). Nearly all of it is the pitch track.

## Settings this ran with

`TONE_RULES` = `{"stepSt":2.5,"minRangeSt":7,"maxRangeSt":12,"sigmaSt":1,"levelWeight":0.3,"minFrames":6,"okBelief":0.34,"moveSt":3,"stillSt":1,"flatSt":1.5,"highLevel":3.8,"highStart":3.7,"lowLevel":2.2,"lowTop":2.2,"dipShare":0.25,"riseShare":0.5,"offMarginSt":0,"offQuality":0.75,"offMinMs":80,"phraseMarginSt":0.5,"creakFlags":false,"creakTrust":0.85}`; cuts made by energy are trusted at 0.85.

## Limitations

- **Synthesized speech is not a learner.** These voices hit their tones cleanly, in quiet, at an even pace. A learner's wrong tone is rarely a clean other tone: it is a flat second tone, a fourth that barely falls, a third with no dip. Those land in "unsure" by design, so on real learners expect fewer catches than here, and treat the false-alarm rate as a floor until real recordings are scored.
- **The wrong answers are other syllables' right answers**, not mistakes: they are well-formed tones, the easiest kind of wrong to spot.
- **The thresholds were tuned on these voices.** The held-out table tunes on two voices and measures on the other two, which is the fairest number here, but all four are synthesizers and two of them are the same engine. It shows the setting is not fitted to one voice; it does not show it fits a person.
- **Nobody has tested a child's voice.** The pitch tracker searches 60–600 Hz and tones are read against the speaker's own range, so nothing in the design excludes one, but no child (and no synthesized child) is in the set.
- **The labels are trusted, not checked.** A synthesizer can misread a lone character, or say it with a sentence's falling intonation; nobody listened to these clips. A clip said in the wrong tone shows up as a miss or a false alarm that isn't the scorer's fault. Scribe is no second opinion here: of 64 single-syllable clips it wrote one character in the labelled tone for 18, and for the rest the commonest word that fits or nothing at all (Tingting 妈 (mā) → ""; Tingting 麻 (má) → ""; Tingting 马 (mǎ) → ""; Tingting 骂 (mà) → ""; Tingting 诗 (shī) → "She"; Tingting 十 (shí) → "She"; Tingting 使 (shǐ) → "是" (shì); Tingting 衣 (yī) → ""; …). That is the generosity this feature exists to get around, and it means the labels stay unchecked.
- **4 voices, none of them a person.** No microphone, no room, no background noise. The ElevenLabs voices are premade English voices speaking Mandarin through the app's default model, not native Mandarin voices: the account's voice list and the Voice Library search did not answer when the clips were bought, so the script fell back to two public voice ids. Their lone syllables are the least textbook clips in the set: Rachel's 妈 holds level and then drops nine semitones, which the scorer hears as a fourth tone and which may well be one.
- **Free conversation is harder than these phrases**: faster, with tones squeezed by their neighbours, focus and sentence intonation on top, and cuts that depend on the transcript being right. The phrase numbers are an upper bound for it.
- **Neutral tones are not judged**, and sandhi across word groups is taken leniently (both readings accepted), so some real mistakes can never be flagged.
- **Azure is verified live for zh-CN only, on these same synthesized clips.** Not run: zh-TW, Spanish, a recording near the 30-second limit, a learner's voice. `AZURE_RULES` were set from these replies, so the same caveat about tuning applies.
