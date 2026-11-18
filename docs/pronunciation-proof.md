# Pronunciation scoring: proof of the local tone scorer

Written by `node scripts/pronunciation-proof.mjs` on 2026-11-18. Rerun it to refresh; the clips are cached, so a rerun is free. Stage 0 of the pronunciation feature (bead ld-ne0.1); the engine is `scripts/pronunciation.mjs`, described in [VOICE.md](VOICE.md#pronunciation).

## What was tested

124 synthesized clips from 4 voices: Tingting (macOS), female, median 217 Hz; Reed (macOS), male, median 102 Hz; Rachel (ElevenLabs premade: an English voice speaking Mandarin), female, median 161 Hz; Adam (ElevenLabs premade: an English voice speaking Mandarin), male, median 139 Hz. Each voice says 16 single syllables (ma, shi, yi, ba in each of the four tones: 妈 麻 马 骂 诗 十 使 是 衣 姨 椅 意 八 拔 把 爸) and 15 phrases (你好、不是、一个、很好、谢谢、我很好、不客气、一起去、你叫什么、我想喝水、明天见、今天很热、我是学生、他不来、再见).

There are no learner recordings, so every clip is used twice over. Scored against its own text it is a **right** answer: an "off" there is a false alarm. Scored against the same syllables with one tone changed it is a **wrong** answer: 妈 labelled 马 is a learner who said mā for mǎ, and an "off" on that syllable is a catch. The connected-speech rules are applied to each label first, so a relabelling that the rules make equivalent (你 as ní before 好) is not counted as wrong. Syllables whose true or labelled tone is neutral are left out: the scorer does not judge them.

The number that matters is how many "off" flags are false: a learner told a right tone was wrong stops believing the marks. A miss costs less. The set holds about three wrong labels for each right one, which flatters raw precision, so each table also restates it for a learner who gets one tone in five wrong.

## Results

| | Singles, speaker unknown | Singles, range known | Phrases, speaker unknown | Phrases, range known | Phrases, Scribe anchors, range known | Phrases, Scribe times as cuts, range known |
| --- | --- | --- | --- | --- | --- | --- |
| Right syllables scored | 64 | 64 | 168 | 168 | 168 | 168 |
| Wrong syllables scored | 192 | 192 | 576 | 576 | 576 | 576 |
| **False alarms** (right, flagged off) | 1 of 64 (1.6%) | 1 of 64 (1.6%) | 0 of 168 (0.0%) | 0 of 168 (0.0%) | 0 of 168 (0.0%) | 0 of 168 (0.0%) |
| **Precision of an off flag**, as measured | 98.5% | 98.8% | 100.0% | 100.0% | 100.0% | 100.0% |
| Precision at one wrong tone in five | 84.6% | 87.1% | 100.0% | 100.0% | 100.0% | 100.0% |
| Wrong tones caught (flagged off) | 66 of 192 (34.4%) | 81 of 192 (42.2%) | 121 of 576 (21.0%) | 145 of 576 (25.2%) | 144 of 576 (25.0%) | 77 of 576 (13.4%) |
| Wrong tones passed as ok | 16.1% | 7.3% | 13.5% | 12.2% | 12.3% | 13.0% |
| Right tones marked ok | 73.4% | 81.3% | 73.8% | 64.9% | 64.9% | 42.9% |
| Right tones marked unsure | 25.0% | 17.2% | 26.2% | 35.1% | 35.1% | 57.1% |
| Marked unsure, all | 43.4% | 42.2% | 56.6% | 56.5% | 56.5% | 69.9% |

These are small counts. A false-alarm rate measured on a few dozen or a couple of hundred syllables is only bounded, not known: with 95% confidence, single syllables, nothing known about the speaker: 1 of 64, so under 7.2%; single syllables, speaker's range known: 1 of 64, so under 7.2%; phrases, cut by energy, nothing known about the speaker: 0 of 168, so under 1.8%; phrases, cut by energy, speaker's range known: 0 of 168, so under 1.8%; phrases, cut by energy around scribe's character times, speaker's range known: 0 of 168, so under 1.8%; phrases, scribe's character times taken as the cuts, speaker's range known: 0 of 168, so under 1.8%. And that bound is for voices like these, on the set the thresholds were tuned on.

"Range known" gives the scorer the voice's pitch range measured over all of that voice's clips, which is what a session would know after a few turns. "Speaker unknown" is a first recording: only the shape of the contour counts, plus the recording's own range once it holds four syllables.

### Single syllables, nothing known about the speaker

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 14 | 0 | 0 | 2 | 0 | 87.5% |
| tone 2 | 3 | 10 | 2 | 1 | 0 | 62.5% |
| tone 3 | 5 | 1 | 8 | 2 | 0 | 50.0% |
| tone 4 | 0 | 0 | 1 | 15 | 0 | 93.8% |

Why syllables were unsure (all labels): unclear 90, creaky 21.

False alarms: Rachel (ElevenLabs premade: an English voice speaking Mandarin) 妈[1] 妈 expected 1 heard 4.

### Single syllables, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 14 | 0 | 0 | 2 | 0 | 87.5% |
| tone 2 | 1 | 11 | 4 | 0 | 0 | 68.8% |
| tone 3 | 0 | 2 | 14 | 0 | 0 | 87.5% |
| tone 4 | 1 | 0 | 1 | 14 | 0 | 87.5% |

Why syllables were unsure (all labels): unclear 87, creaky 21.

False alarms: Rachel (ElevenLabs premade: an English voice speaking Mandarin) 妈[1] 妈 expected 1 heard 4.

### Phrases, cut by energy, nothing known about the speaker

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 23 | 0 | 1 | 0 | 0 | 95.8% |
| tone 2 | 12 | 28 | 5 | 0 | 3 | 58.3% |
| tone 3 | 6 | 1 | 24 | 3 | 2 | 66.7% |
| tone 4 | 5 | 0 | 8 | 42 | 5 | 70.0% |

Why syllables were unsure (all labels): unclear 357, creaky 24, unvoiced 20, short 20.

### Phrases, cut by energy, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 23 | 0 | 1 | 0 | 0 | 95.8% |
| tone 2 | 8 | 25 | 11 | 1 | 3 | 52.1% |
| tone 3 | 2 | 0 | 28 | 4 | 2 | 77.8% |
| tone 4 | 12 | 0 | 17 | 26 | 5 | 43.3% |

Why syllables were unsure (all labels): unclear 356, creaky 24, unvoiced 20, short 20.

### Phrases, cut by energy around Scribe's character times, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 23 | 0 | 1 | 0 | 0 | 95.8% |
| tone 2 | 8 | 25 | 11 | 1 | 3 | 52.1% |
| tone 3 | 2 | 0 | 28 | 4 | 2 | 77.8% |
| tone 4 | 12 | 0 | 17 | 26 | 5 | 43.3% |

Why syllables were unsure (all labels): unclear 349, creaky 30, unvoiced 25, short 16.

### Phrases, Scribe's character times taken as the cuts, speaker's range known

Tone the clip was said in (after the connected-speech rules) against the tone the scorer heard, right labels only:

| said \ heard | 1 | 2 | 3 | 4 | nothing | right |
| --- | --- | --- | --- | --- | --- | --- |
| tone 1 | 19 | 0 | 1 | 0 | 4 | 79.2% |
| tone 2 | 18 | 6 | 8 | 5 | 11 | 12.5% |
| tone 3 | 1 | 0 | 19 | 2 | 14 | 52.8% |
| tone 4 | 11 | 0 | 11 | 25 | 13 | 41.7% |

Why syllables were unsure (all labels): unclear 284, short 153, creaky 57, unvoiced 22, untimed 4.

### By voice (range known, cut by energy)

| Voice | Singles: false alarms | Singles: caught | Phrases: false alarms | Phrases: caught |
| --- | --- | --- | --- | --- |
| Tingting (macOS) | 0 of 16 (0.0%) | 23 of 48 (47.9%) | 0 of 42 (0.0%) | 59 of 144 (41.0%) |
| Reed (macOS) | 0 of 16 (0.0%) | 18 of 48 (37.5%) | 0 of 42 (0.0%) | 25 of 144 (17.4%) |
| Rachel (ElevenLabs premade: an English voice speaking Mandarin) | 1 of 16 (6.3%) | 21 of 48 (43.8%) | 0 of 42 (0.0%) | 38 of 144 (26.4%) |
| Adam (ElevenLabs premade: an English voice speaking Mandarin) | 0 of 16 (0.0%) | 19 of 48 (39.6%) | 0 of 42 (0.0%) | 23 of 144 (16.0%) |

## Azure, live

316 live replies from Azure Pronunciation Assessment (`zh-CN`, the REST short-audio endpoint in `<region>.stt.speech.microsoft.com`, free F0 tier, one request at a time). Every clip was assessed against its own text; each single syllable also against the other three tones of the same syllable, which is the wrong-tone sample: the audio of 妈 with 马 as the reference text. There are no wrong-tone phrase samples for Azure (it needs real characters as the reference, and the proof's phrase relabellings are pinyin only).

| | Syllables | Azure's median score | Azure marks the word `Mispronunciation` | Azure score under 40 | Local scorer alone flags | Merged result flags | which are |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Singles, right reference | 64 | 82 | 1 (1.6%) | 0 (0.0%) | 1 (1.6%) | 1 (1.6%): 1 tone, 0 sound | false alarms |
| Singles, wrong-tone reference | 192 | 61 | 55 (28.6%) | 21 (10.9%) | 81 (42.2%) | 82 (42.7%): 74 tone, 8 sound | caught |
| Phrases, right reference | 168 | 100 | 4 (2.4%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%): 0 tone, 0 sound | false alarms |

On the single syllables, precision of a flag as measured (three wrong for each right): Azure's own `Mispronunciation` mark 98.2%, the local scorer 98.8%, the merged result 98.8%. The merged result flags on the local pitch check, or on Azure's `Mispronunciation` mark with a score under 40.

What the replies look like for Mandarin (316 flat, 0 with a nested `PronunciationAssessment` object): scores sit directly on the `NBest` entry, the word and the phoneme. 48 of 381 words are longer than one character (你好, 学生: Azure segments into words). In 381 of 381 words the `Phonemes` array has exactly one entry per character: a "phoneme" is a whole syllable with its tone as a digit (`ni 3`, `hao 3`; 5 is neutral), with its own offset, duration and score. That digit is the tone of the **reference** reading (the dictionary tone, before sandhi; for a character with several readings, one of them), not the tone that was heard: Azure does not report a heard tone. `DisplayText` echoes the reference too. What a wrong tone changes is the score.

A wrong-tone sample, verbatim (Tingting's 妈, mā, assessed against 马, mǎ):

```json
{"RecognitionStatus":"Success","Offset":400000,"Duration":2400000,"DisplayText":"马。","SNR":19.011362,"NBest":[{"Confidence":0.78632134,"Lexical":"马","ITN":"马","MaskedITN":"马","Display":"马。","AccuracyScore":54,"FluencyScore":0,"CompletenessScore":0,"PronScore":10.8,"Words":[{"Word":"马","Offset":400000,"Duration":2400000,"Confidence":0,"AccuracyScore":54,"ErrorType":"Mispronunciation","Syllables":[{"Syllable":"","Grapheme":"马","Offset":400000,"Duration":2400000,"AccuracyScore":50}],"Phonemes":[{"Phoneme":"ma 3","Offset":400000,"Duration":2400000,"AccuracyScore":50}]}]}]}
```

## Scribe's timings

60 phrase clips were transcribed by Scribe v2 with `timestamps_granularity=character` (the app sends no such field today, and `transcriptText` keeps only `text`). For Chinese the reply has one `words` entry per character: 175 entries, 0 longer than one character, 175 carrying a `characters` array. 168 of 172 expected syllables found their character in the transcript.

The times are not syllable boundaries. The median character span is 140 ms and 17 of 168 are 40 ms or shorter, in clips whose syllables last 150 to 300 ms: Scribe reports roughly when it recognized each character. Taken as cuts they leave most syllables too short to score (the last column of the table above). But 137 of 168 character start times fall inside the stretch the energy cuts give that syllable, so they work as anchors: `scoreTones({ anchors })` cuts by energy and keeps each piece on its character's time. On these short, pause-free clips that changes little; its use is longer speech with pauses, which this set does not contain.

## Speed

Scoring a 3-second, 16 kHz recording on this machine (arm64, Node v26.4.0): 30 ms (median of 12; slowest 32 ms). Nearly all of it is the pitch track.

## Settings this ran with

`TONE_RULES` = `{"stepSt":2.5,"minRangeSt":7,"maxRangeSt":12,"sigmaSt":1,"levelWeight":0.3,"minFrames":6,"okBelief":0.34,"moveSt":4,"stillSt":1,"flatSt":1.5,"highLevel":3.8,"offBelief":0.5,"offQuality":0.7,"offMinMs":110}`; cuts made by energy are trusted at 0.85.

## Limitations

- **Synthesized speech is not a learner.** These voices hit their tones cleanly, in quiet, at an even pace. A learner's wrong tone is rarely a clean other tone: it is a flat second tone, a fourth that barely falls, a third with no dip. Those land in "unsure" by design, so on real learners expect fewer catches than here, and treat the false-alarm rate as a floor until real recordings are scored.
- **The wrong answers are other syllables' right answers**, not mistakes: they are well-formed tones, the easiest kind of wrong to spot.
- **The thresholds were tuned on this same set.** There is no held-out data. The by-voice table shows the spread, not generalisation.
- **Nobody has tested a child's voice.** The pitch tracker searches 60–600 Hz and tones are read against the speaker's own range, so nothing in the design excludes one, but no child (and no synthesized child) is in the set.
- **The labels are trusted, not checked.** A synthesizer can misread a lone character, or say it with a sentence's falling intonation; nobody listened to these clips. A clip said in the wrong tone shows up as a miss or a false alarm that isn't the scorer's fault. Scribe is no second opinion here: of 64 single-syllable clips it wrote one character in the labelled tone for 18, and for the rest the commonest word that fits or nothing at all (Tingting 妈 (mā) → ""; Tingting 麻 (má) → ""; Tingting 马 (mǎ) → ""; Tingting 骂 (mà) → ""; Tingting 诗 (shī) → "She"; Tingting 十 (shí) → "She"; Tingting 使 (shǐ) → "是" (shì); Tingting 衣 (yī) → ""; …). That is the generosity this feature exists to get around, and it means the labels stay unchecked.
- **4 voices, none of them a person.** No microphone, no room, no background noise. The ElevenLabs voices are premade English voices speaking Mandarin through the app's default model, not native Mandarin voices: the account's voice list and the Voice Library search did not answer when the clips were bought, so the script fell back to two public voice ids. Their lone syllables are the least textbook clips in the set: Rachel's 妈 holds level and then drops nine semitones, which the scorer hears as a fourth tone and which may well be one.
- **Free conversation is harder than these phrases**: faster, with tones squeezed by their neighbours, focus and sentence intonation on top, and cuts that depend on the transcript being right. The phrase numbers are an upper bound for it.
- **Neutral tones are not judged**, and sandhi across word groups is taken leniently (both readings accepted), so some real mistakes can never be flagged.
- **Azure is verified live for zh-CN only, on these same synthesized clips.** Not run: zh-TW, Spanish, a recording near the 30-second limit, a learner's voice. `AZURE_RULES` were set from these replies, so the same caveat about tuning applies.
