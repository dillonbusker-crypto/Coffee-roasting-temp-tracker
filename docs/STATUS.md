# Roast Tracker: build status

Last updated: Nov 16, 2026. This file is the hand-off log. Update it whenever a milestone lands.

## Where things are

- **Live site:** `main`, served by GitHub Pages at `https://dillonbusker-crypto.github.io/Coffee-roasting-temp-tracker/`. Release 1 is live: the full app (Camera, Demo and Manual sources, History, Settings, offline install) and the digit reader test page (Settings → Data and about, or `reader-test.html`). Build steps 1–5 are code-complete. Nothing has run on a real iPhone yet.
- **Work in progress:** branch `claude/wizardly-maxwell-nupf1i`. Everything built so far is there. `main` only moves when a milestone has been reviewed and tested.

| Piece | Spec step | Status |
| --- | --- | --- |
| Roast core: calculations, session, clock, cue engine, simulator, storage, export (`js/core`, `js/sources`, `js/store`) | 2–3 | Done and reviewed. Unit tests pass |
| App screens: Setup, Roast, After, live chart, spoken cues, Reference mode (`index.html`, `js/app.js`, `js/ui`) | 2–3 | Done and reviewed. `test/browser/app-flow.test.cjs` passes on the Demo and Manual sources |
| Digit reader and test page (`js/reader`, `reader-test.html`, `tools/synth-display.js`, `test/browser/reader.test.cjs`) | 1 | Built and reviewed, provisional until the user's media has run. `test/browser/reader.test.cjs` passes: 12 of 12 real crops, 0 wrong in 600 jittered real reads, 0 wrong in the synthetic sets, 60 of 60 seconds on the mild synthetic video. Known weak spot: 1 of 250 forced mid-change frames at moderate distortion read wrong (77→78 read as 79); the per-second filter is the backstop |
| History, roast detail, Settings, export/import UI, offline install (`js/ui/history.js`, `detail.js`, `settings-screen.js`, `sw.js`, `manifest.webmanifest`, `icons/`) | 5 | Done and reviewed. `test/browser/history-settings.test.cjs` passes |
| Camera in the roast screen (camera source, Setup preview and box, crop strip on the Roast screen) | 4 | Built and reviewed against a fake camera. `test/browser/camera.test.cjs` passes: 34 of 34 seconds read with 0 wrong on a synthetic climb through 99→100, lost-reading and number-pad fallback, dead-stream recovery. Untested on a real iPhone |
| Roast review: after-roast checks against the roast's own targets (`js/core/review.js`, `js/ui/review.js`) | Added after the spec | Built and reviewed. `test/browser/review.test.cjs` passes. Rate-of-rise shape thresholds are tuned on simulated curves only |
| Field test: three real roasts | 6 | The user's, once the camera works |

## Pending, in order

1. **First run on the iPhone.** Open the live site in Safari, allow the camera, and check the list under "Check on the real phone" below.
2. **Run the user's test media through the reader.** About 10 photos and a 1-minute video, due Nov 16. Step 1 stays provisional until they meet the spec's accuracy target. Add them to `test/fixtures/` as regression cases. The reader has only seen the digits 0, 1, 2, 4, 5, 6, 7 and the dashes on the real display; check how a real 3, 8 and 9 are drawn (a 9 without its bottom bar would be missed, not misread).
3. **Field test and tuning.** Replace the provisional 410°F first-crack reading with the first logged roast. Tune pace-cue timing against real curves. Check the roast review's rate-of-rise findings against real roasts: a normal first-crack bump may read as a "flick", noisy readings may read as a "crash", and a slow first minute may read as a stall. The thresholds are named constants at the top of `js/core/review.js`.

## Found on the real phone

- **Camera stall loop (fixed, awaiting confirmation on the phone).** On the user's iPhone the Setup camera panel looped between "The camera stopped sending pictures" and a one-second reconnect. Cause: `js/reader/camera.js` judged the stream alive only while the video clock advanced, and the stream was reopened every couple of seconds when it didn't. Now a stall needs positive evidence, frames are read on a timer when Safari's frame callback doesn't fire, and reopening is rare with back-off. Whether Safari really freezes that clock is unconfirmed; the "Camera details" section at the bottom of the camera panel (with a Copy button) shows what the phone reports.

## Check on the real phone

- The camera preview appears on Setup, and the box lines up with what the reader sees (iOS may deliver the video rotated).
- After Start, the small crop strip on the Roast screen keeps updating. If it freezes or goes black, the cause is the `<video>` element being moved between Setup and Roast (`js/ui/camera-panel.js`); keep it in place instead.
- Speech works after the Start tap, and the screen stays awake for a full roast. The Live mode of the reader test page has an 8-minute soak test that reports both.
- Switching apps mid-roast and coming back: the camera should reconnect and the gap should be logged. If iOS refuses, the strip says the camera stopped and the number pad still works.
- Whether Safari asks for camera permission again on every visit.

## Decisions that differ from the spec

Both are described in `docs/DESIGN.md`.

- **First-crack projection is decay-aware**, not a straight line. A straight line projects about a minute early on an air roaster's flattening curve and would call "Running hot" on a good roast.
- **The reader's jump limit widens with the gap**: 15°F plus 2°F for each second since the last accepted reading, with re-anchoring after 5 agreeing seconds. A flat limit could lock the reader out after one long dropout.
- **The end-temperature cue uses the temperature stamped at the First crack tap** plus the cap, and cannot fire before that tap. The expected reading is only a guess until a reference exists.
- **Pace cues start at 2:30** and need the condition to hold for 10 s. The same corrective cue does not repeat within 40 s.

## Open items for the user

- Record the photos and video: different temperatures, square-on, backlight off, alert temperature set to 572°F first. A climb through 99 to 100 in the video is the most useful single moment.
- Confirm the TP17 refreshes about once per second.
- The live-camera soak test on the reader test page answers whether Safari keeps the camera and screen awake for a full roast.

## How to work on it

```
npm test                                  # unit tests
node test/browser/app-flow.test.cjs       # full roast flow in headless Chromium
node test/browser/history-settings.test.cjs   # history, settings, export/import, offline
node test/browser/review.test.cjs         # roast review
node test/browser/reader.test.cjs         # digit reader (about 3 minutes)
node test/browser/camera.test.cjs         # camera source against a fake camera (about 3 minutes)
npm run precache                          # regenerate the offline file list in sw.js after changing shipped files
npm run serve                             # http://localhost:8080
```

No build step and no npm dependencies. The browser tests use a globally installed Playwright.
