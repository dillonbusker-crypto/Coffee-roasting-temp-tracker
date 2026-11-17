# Roast Tracker: build status

Last updated: Nov 17, 2026. This file is the hand-off log. Update it whenever a milestone lands.

## Where things are

- **Live site:** `main`, served by GitHub Pages at `https://dillonbusker-crypto.github.io/Coffee-roasting-temp-tracker/`. Release 1 is live: the full app (Camera, Demo and Manual sources, History, Settings, offline install) and the digit reader test page (Settings → Data and about, or `reader-test.html`). Build steps 1–5 are code-complete. The user has run it on the iPhone and done a first real roast (Nov 17).
- **Work in progress:** branch `claude/wizardly-maxwell-nupf1i`. Everything built so far is there. `main` only moves when a milestone has been reviewed and tested.

| Piece | Spec step | Status |
| --- | --- | --- |
| Roast core: calculations, session, clock, cue engine, simulator, storage, export (`js/core`, `js/sources`, `js/store`) | 2–3 | Done and reviewed. Unit tests pass |
| App screens: Setup, Roast, After, live chart, spoken cues, Reference mode (`index.html`, `js/app.js`, `js/ui`) | 2–3 | Done and reviewed. `test/browser/app-flow.test.cjs` passes on the Demo and Manual sources |
| Digit reader and test page (`js/reader`, `reader-test.html`, `tools/synth-display.js`, `test/browser/reader.test.cjs`) | 1 | Built and reviewed. Meets the accuracy target on the user's 45 s video (44 of 44 seconds, 0 wrong; `test/browser/real-media.test.cjs`); a real roast with the new reader is still to come. `test/browser/reader.test.cjs` passes: 12 of 12 real crops, 0 wrong in 600 jittered real reads, 0 wrong in the synthetic sets, 60 of 60 seconds on the mild synthetic video. Reworked for glare and lighting change (see "Found on the real phone"): 0 wrong in the glare, exposure and lighting sets and in 250 forced mid-change frames at each level |
| History, roast detail, Settings, export/import UI, offline install (`js/ui/history.js`, `detail.js`, `settings-screen.js`, `sw.js`, `manifest.webmanifest`, `icons/`) | 5 | Done and reviewed. `test/browser/history-settings.test.cjs` passes |
| Camera in the roast screen (camera source, Setup preview and box, crop strip on the Roast screen) | 4 | Built and reviewed against a fake camera. `test/browser/camera.test.cjs` passes: 34 of 34 seconds read with 0 wrong on a synthetic climb through 99→100, lost-reading and number-pad fallback, dead-stream recovery. Untested on a real iPhone |
| Roast review: after-roast checks against the roast's own targets (`js/core/review.js`, `js/ui/review.js`) | Added after the spec | Built and reviewed. `test/browser/review.test.cjs` passes. Rate-of-rise shape thresholds are tuned on simulated curves only |
| Field test: three real roasts | 6 | The user's, once the camera works |

## Pending, in order

1. **First run on the iPhone.** Open the live site in Safari, allow the camera, and check the list under "Check on the real phone" below.
2. **Second real roast with the reworked reader** (released Nov 17, see "Found on the real phone"). What to watch: does the reading hold through the fast climb in the first 90 s, does the preview stay smooth at 7.5 pictures a second, and what Camera details says when a reading is lost. Afterwards send Settings → Data → Export all.
3. **Field test and tuning.** Replace the provisional 410°F first-crack reading with the first logged roast. Tune pace-cue timing against real curves. Check the roast review's rate-of-rise findings against real roasts: a normal first-crack bump may read as a "flick", noisy readings may read as a "crash", and a slow first minute may read as a stall. The thresholds are named constants at the top of `js/core/review.js`.

## Found on the real phone

- **Camera stall loop (fixed, awaiting confirmation on the phone).** On the user's iPhone the Setup camera panel looped between "The camera stopped sending pictures" and a one-second reconnect. Cause: `js/reader/camera.js` judged the stream alive only while the video clock advanced, and the stream was reopened every couple of seconds when it didn't. Now a stall needs positive evidence, frames are read on a timer when Safari's frame callback doesn't fire, and reopening is rare with back-off. Whether Safari really freezes that clock is unconfirmed; the "Camera details" section at the bottom of the camera panel (with a Copy button) shows what the phone reports.

- **Reader loses the reading under glare or a slight lighting change (partly fixed, awaiting the phone).** Confirmed by the user on the phone after the stall fix. The rework of `js/reader/sevenseg.js` is released:
  - *Lighting change: fixed in tests.* The reader used to compare a frame's ink darkness with earlier frames, so a change of exposure looked like a digit half way through changing and was thrown away. It now compares lit segments only within the same frame. Exposure drift alone: 98.8% of frames read, and 60 of 60 seconds on a 60 s climb with drifting exposure.
  - *Glare: safer, better, not solved.* The old reader could read a wrong number when glare washed out a lit segment (77 read as 17, 425 as 125 on the real crops with synthetic glare). Each segment is now judged against the local background of its own digit, and a segment that cannot be proven lit or unlit makes the frame a miss. Wrong reads: 0 in every glare, exposure and lighting set. Frames read: faint glare 93%, glare veil 25–60% about 49% (was 30%), heavier glare mostly missed. A fixed glare patch on a digit is not averaged away: one placement of a 40% patch loses about 90% of seconds.
  - *Costs.* About 45–50 ms per read frame and 100–135 ms per unread frame in desktop Chromium (was 31–35 and 60–90). A digit cut by the box edge is now refused with its own reason instead of being read from what is visible.
  - *Next.* Real failing pictures decide the next round: Setup → Camera → Camera details → "Share the last unreadable picture" exports exactly what the reader saw; add them to `test/fixtures/`. Thin bright streaks and spots are the main remaining failure. A looser lit threshold reads more glare frames but let one mid-change frame through (256→257 read as 258), so it was not taken.
- **First real roast and the user's test media (Nov 17, open).** The user ran a first roast ("First batch - esp", saved in the phone's history) and the camera had trouble holding the reading. They sent 8 photos and a 45 s video of the display cooling from 280 to 169; both are now fixtures (`test/fixtures/photos/tp17-*-cooldown.jpg` with `cooldown.json`, `test/fixtures/video-cooldown/` with `truth.json`).
  - *Photos:* 8 of 8 read correctly with the app's widened box. A real 3, 8 and 9 look as expected (the 9 has its bottom bar).
  - *Video:* at the app's 4 frames per second the released reader gets 63% of frames and about 71% of seconds, 0 wrong. Every miss is "ambiguous segment" on the right-hand digit.
  - *Cause 1:* a reddish reflection over the right-hand digit leaves its lit segments at 25–65% of the contrast the reader expects (it demands 62%). Unlit segments in the same frames are at 7% or less, so a person reads them easily.
  - *Cause 2:* the TP17 refreshes every 0.5 s, not every second. A segment turning on takes about 70 ms; one turning off leaves a pale ghost for up to 200 ms. At 4 frames per second too few frames are clean.
  - *Fix (released Nov 17):* a weaker lit segment is accepted only when the picture just before it, 30–400 ms earlier, shows the same pattern at the same contrast (`js/reader/confirm.js`): a reflection holds still, a changing digit does not. The camera is now read 7.5 times a second instead of 4. The synthetic change model in `tools/synth-display.js` follows the measured one.
  - *Result on the video:* 44 of 44 seconds correct at 7.5 fps at every sampling phase, 0 wrong; 84–90% of frames read (was 57–63%). Checked again on all 1,345 raw 30 fps frames, half of which the reader was never tuned on: 0 wrong frames at 30, 15, 10, 7.5, 6 and 5 fps. At 5 fps one second in 44 is missed at some phases. Photos 8 of 8.
  - *Cost:* about 13 ms per frame once the digits are located and 65 ms for a full search, in desktop Chromium; a miss on a single segment no longer triggers a new search. Reading at 7.5 fps costs less than 4 fps did before. Not measured on the phone; if the preview lags there, 5 fps is the lowest rate that still works.
  - *The roast itself* (`test/fixtures/roasts/first-batch-esp-2026-11-17.csv`, 426 s): 61% of seconds read. 40% in the first 100 s, 95% in the last 86 s: the reader holds while the temperature is flat and loses it while it climbs. One 51 s gap (24–74 s) sits on the fastest climb, 3.6–4.5°F/s.
  - *Cause 3 (likely, not proven: the CSV has no rejected counts):* the per-second filter locked itself out. Its jump allowance grew 2°F per second of gap and it re-anchored only on 5 seconds that agreed within 4°F; the Popper climbs up to 4.5°F/s early on, so after a dropout of about 10 s every correct reading looked like a jump. Simulated on a climb shaped like this roast, the old filter threw away up to 22 readable seconds in a row after a 12 s dropout; the new one throws away 1.
  - *Filter rework (released Nov 17, `js/reader/filter.js`):* a reading is accepted if it is near the last one or where the recent trend points; anything else needs two or three agreeing seconds. A second's value is always one that was seen, never an average (the old median invented 18 of this roast's 261 readings, such as 254 and 380). Numbers the thermometer cannot show are dropped as misreads.
  - *The TP17 only shows whole-°C values.* Every reading in the video, photos and CSV is round(1.8 × c + 32) for a whole c, so 4 of every 9 whole °F numbers never appear. The filter rejects those as misreads ("impossible number" in Camera details). The video is real speed (confirmed), so the 0.5 s refresh is real.
  - *First real numbers for tuning:* Yellow 3:16 at 349°F, First crack 5:34 at 396°F (provisional setting is 410), Drop 7:05, development 1:31 (21%). Readings bounce by up to 11°F a second from 5:00 to 5:30, after Heat 4→3; the values are all ones the display can show and do not look like single-segment misreads. Wait for two more roasts before changing defaults.
  - *Still wanted:* the JSON from Settings → Data → Export all, for the roast's `reader.missReasons` and rejected counts (the CSV does not carry them).
- **Kettle test after the Nov 17 release (open).** The user heated water with the probe in a kettle: "worked a lot better", but the reading cut out a couple of times once the display showed three digits. They asked whether their box placement is the cause.
  - *Box placement tested on the real video:* 11 ways of drawing the box (around two digits or three; 6–20 px loose; 6–12 px inside the digits top and bottom; left edge 8 px into the tens digit or 10 px too far left; right edge up to 30 px into the °F), each widened as the app does. Every one reads all 16 seconds at 1xx and 27–28 of 28 at 2xx, 0 wrong. So the box is unlikely to be the cause.
  - *Not covered by any real footage:* the moment the third digit appears (99→100), and steam or condensation between the phone and the display.
  - *Second video (Nov 17, `test/fixtures/video-reflection/`, 34 s, 156 → 90°F, three digits until 24 s):* this reproduces the problem. The released reader gets 3 of 24 three-digit seconds and 4 of 10 two-digit seconds with a tight two-digit box, 11 of 24 and 6 of 10 at best over 12 ways of drawing the box. 0 wrong values in every run.
  - *Cause:* reflections, not the box. A reddish reflection sits still on the upper right segment of the hundreds "1" (it shows 16–40% of normal contrast in a quarter of the frames), and a grey one dims the top half of every digit to 50–80%. Unlit segments read 10–20% in this light; the reader only calls a segment unlit at 10% or less. Lit and unlit are still clearly apart, and a person reads every frame.
  - *Second cause, smaller:* the app widens the user's box to the left by 0.7 of its height. With a box drawn tight around two digits that leaves about 2 px for a full third digit, so many frames are refused as "digit cut off". The widening needs to be about 0.85–0.9.
  - *Round 4 in progress (working branch):* make the unlit side tolerant of a steady reflection using time and the shape of the digit, widen the box more, add this video to `real-media.test.cjs`. Pass mark: 0 wrong, at least 90% of seconds on this video (target 98%), video 1 unchanged.
- **Miss reasons are now shown.** The camera panel says why it can't read, Camera details keeps a 60 s tally, and a saved roast carries `reader.missReasons`.

## Check on the real phone

- The camera preview appears on Setup, and the box lines up with what the reader sees (iOS may deliver the video rotated).
- After Start, the small crop strip on the Roast screen keeps updating. If it freezes or goes black, the cause is the `<video>` element being moved between Setup and Roast (`js/ui/camera-panel.js`); keep it in place instead.
- Speech works after the Start tap, and the screen stays awake for a full roast. The Live mode of the reader test page has an 8-minute soak test that reports both.
- Switching apps mid-roast and coming back: the camera should reconnect and the gap should be logged. If iOS refuses, the strip says the camera stopped and the number pad still works.
- Whether Safari asks for camera permission again on every visit.

## Decisions that differ from the spec

Both are described in `docs/DESIGN.md`.

- **First-crack projection is decay-aware**, not a straight line. A straight line projects about a minute early on an air roaster's flattening curve and would call "Running hot" on a good roast.
- **The reader's jump check follows the trend** instead of a flat 15°F: near the last reading or near where the trend points is accepted at once, anything else needs two or three agreeing seconds. A flat limit locks the reader out after one long dropout on a fast climb.
- **The camera is read 7.5 times a second**, not the spec's 3–5: the TP17 redraws every 0.5 s and a reflected digit is only accepted from two matching pictures.
- **Readings the TP17 cannot show are rejected.** It measures whole °C, so only some °F numbers appear.
- **The end-temperature cue uses the temperature stamped at the First crack tap** plus the cap, and cannot fire before that tap. The expected reading is only a guess until a reference exists.
- **Pace cues start at 2:30** and need the condition to hold for 10 s. The same corrective cue does not repeat within 40 s.

## Open items for the user

- Useful footage for the next reader round, in order: a roast-speed climb with the hundreds digit visible (99→100, 199→200); a reflection that sits still on a digit for 10 s or more; a slow-motion clip of one display change.
- The live-camera soak test on the reader test page answers whether Safari keeps the camera and screen awake for a full roast.

## How to work on it

```
npm test                                  # unit tests
node test/browser/app-flow.test.cjs       # full roast flow in headless Chromium
node test/browser/history-settings.test.cjs   # history, settings, export/import, offline
node test/browser/review.test.cjs         # roast review
node test/browser/real-media.test.cjs     # the user's photos and video through the reader (about 1 minute)
node test/browser/reader.test.cjs         # digit reader, synthetic sets (10 minutes or more)
node test/browser/camera.test.cjs         # camera source against a fake camera (about 3 minutes)
npm run precache                          # regenerate the offline file list in sw.js after changing shipped files
npm run serve                             # http://localhost:8080
```

No build step and no npm dependencies. The browser tests use a globally installed Playwright.
