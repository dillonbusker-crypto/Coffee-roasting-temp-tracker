# Roast Tracker: build status

Last updated: Nov 15, 2026, 05:05 UTC. This file is the hand-off log. Update it whenever a milestone lands.

## Where things are

- **Live site:** `main`, served by GitHub Pages at `https://dillonbusker-crypto.github.io/Coffee-roasting-temp-tracker/`. It still shows the placeholder page.
- **Work in progress:** branch `claude/wizardly-maxwell-nupf1i`. Everything built so far is there. `main` only moves when a milestone has been reviewed and tested.

| Piece | Spec step | Status |
| --- | --- | --- |
| Roast core: calculations, session, clock, cue engine, simulator, storage, export (`js/core`, `js/sources`, `js/store`) | 2–3 | Done and reviewed. Unit tests pass |
| App screens: Setup, Roast, After, live chart, spoken cues, Reference mode (`index.html`, `js/app.js`, `js/ui`) | 2–3 | Done and reviewed. `test/browser/app-flow.test.cjs` passes on the Demo and Manual sources |
| Digit reader and test page (`js/reader`, `reader-test.html`, `tools/synth-display.js`, `test/browser/reader.test.cjs`) | 1 | In progress, not reviewed. Reads all 12 real crops; one wrong read left in the moderate-distortion synthetic set (a 77→78 mid-change frame read as 79) |
| History, roast detail, Settings, export/import UI, offline install (`js/ui/history.js`, `detail.js`, `settings-screen.js`, `sw.js`, `manifest.webmanifest`, `icons/`) | 5 | Done and reviewed. `test/browser/history-settings.test.cjs` passes |
| Camera in the roast screen (camera source, Setup preview and box, crop strip on the Roast screen) | 4 | In progress, not reviewed. Builds on the reader's fixed API (`readDisplay`, `createCamera`, `createReadingFilter`) |
| Field test: three real roasts | 6 | The user's, once the camera works |

## Pending, in order

1. **Review the digit reader.** Run `node test/browser/reader.test.cjs`. It must read every real crop in `test/fixtures/crops/` (77, 425, 160, dashes) with no wrong value, and meet the spec target on the synthetic set. Check the test page screenshots at 390×844.
2. **First release to `main`.** Run `npm run precache`, then fast-forward `main` to the working branch. Settings → Data and about links to `reader-test.html`.
3. **Finish and review the camera source (step 4).** Run `node test/browser/camera.test.cjs`. It registers it in `js/ui/sources.js` with `id: 'camera'`, `keepAlive: true`, an idempotent `start()`, `reanchor(value)`, `renderSetupPanel` (live preview, draggable box, glare tip) and `renderRoastStatus` (crop strip). Reuse `js/reader/camera.js`, `sevenseg.js` and `filter.js`. Turn clock ticks flagged `missed` into gaps. Put its CSS in its own file. Re-run `npm run precache`.
4. **Run the user's test media through the reader.** About 10 photos and a 1-minute video, due Nov 16. Step 1 stays provisional until they meet the spec's accuracy target. Add them to `test/fixtures/` as regression cases.
5. **Field test and tuning.** Replace the provisional 410°F first-crack reading with the first logged roast. Tune pace-cue timing against real curves.

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
node test/browser/reader.test.cjs         # digit reader
npm run precache                          # regenerate the offline file list in sw.js after changing shipped files
npm run serve                             # http://localhost:8080
```

No build step and no npm dependencies. The browser tests use a globally installed Playwright.
