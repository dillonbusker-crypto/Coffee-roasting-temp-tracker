# Roast Tracker: design and module contracts

This is the engineering design for `docs/SPEC.md`. The spec says what the app does. This file says how the code is split and what each module promises the others. If code and this file disagree, fix one of them in the same commit.

## Stack

- Plain HTML, CSS and JavaScript ES modules. No build step, no framework, no runtime dependencies. GitHub Pages serves the repo root of `main` as is.
- The site lives under a sub-path (`/Coffee-roasting-temp-tracker/`), so every URL in HTML, CSS, JS, the manifest and the service worker is relative. Never start a path with `/`.
- Target browser: Safari on iPhone (iOS 17+). Must also run in desktop Chromium, which is what the tests use.
- Tests: `node --test test/unit` for pure logic (no DOM). Browser tests are Node scripts in `test/browser/` that drive the pre-installed global Playwright Chromium against a local static server. Nothing is installed from npm.
- All temperatures are stored and computed in °F. °C is a display conversion only (`units.js`).

## Layout

```
index.html                 app shell: Setup, Roast, After (+ History, Settings)
reader-test.html           milestone 1 digit reader test page
manifest.webmanifest, sw.js, icons/
css/app.css
js/app.js                  boot, screen routing
js/core/calc.js            pure maths
js/core/session.js         one roast in progress
js/core/clock.js           1 Hz tick with catch-up and speed
js/core/cues.js            cue engine (pure)
js/core/review.js          after-roast review (pure)
js/core/settings.js        defaults, load, save
js/core/units.js           °F/°C formatting
js/reader/sevenseg.js      ImageData -> digits (pure)
js/reader/confirm.js       tentative frame + the frame before it -> ok or miss (pure)
js/reader/filter.js        frames -> one accepted value per second (pure)
js/reader/camera.js        getUserMedia, crop box, frame grabbing
js/sources/camera-source.js, simulator-source.js, manual-source.js
js/store/db.js             IndexedDB
js/store/transfer.js       JSON export/import, CSV export
js/ui/*.js                 screens, chart, speech, wake lock
test/unit, test/browser, test/fixtures, tools/
```

## Time model

- Start tap is `t = 0`. One reading is logged at `t = 0` and one per elapsed second after it. `readings[i]` is the reading at second `i`. A gap is `null`.
- `clock.js` owns elapsed time. It derives the tick count from a monotonic clock, not from counting timer callbacks, so a throttled or briefly hidden page catches up by emitting the missed ticks (their readings are gaps). `speed` multiplies time for the simulator (1x, 10x).

## Contracts

### `js/core/calc.js` (pure)

```js
smoothAt(raw, t, windowSec = 10)        // mean of non-null raw[t-w+1..t]; null if none
rorAt(smooth, t, windowSec = 30)        // least-squares slope over smooth[t-w+1..t], °F/min.
                                        // null when t < windowSec, or fewer than half the points exist
projectFirstCrack({ t, temp, ror, rorEarlier, lagSec, targetF })
                                        // -> elapsed seconds at which temp is projected to reach targetF,
                                        //    Infinity if it never will, null if not computable
phaseSummary(events, totalSec)          // { drying, browning, development }, each { sec, pct } or null;
                                        // no Yellow: drying is null and browning covers Start..First crack
weightLossPct(greenG, roastedG)
averageRor(startF, endF, totalSec)      // °F/min, Start to Drop
summarize(roast)                        // -> the `results` object of a roast record
```

**Projection is decay-aware (a deliberate change from the spec's straight line).** An air roaster's curve flattens as it climbs, so a straight-line projection at 2:30–3:00 lands about a minute early and would fire a false "Running hot" on a good roast. `projectFirstCrack` compares the current rate of rise with the rate `lagSec` (45 s) earlier. If the rate is falling it fits an exponential approach (`tau = lagSec / ln(rorEarlier / ror)`, asymptote `temp + ror * tau / 60`) and solves for the target; an asymptote below the target returns `Infinity`. If the rate is flat or rising, or the fit is unusable, it falls back to the spec's straight line.

### `js/core/session.js`

```js
const s = createSession({ coffee, greenWeightG, heat, fan, settings, mode, reference, source, startedAt })
s.addReading(fOrNull)          // appends second t = readings.length; updates smooth[] and ror[]
s.mark(name)                   // 'yellow' | 'firstCrack' | 'drop' -> { t, f } (f = smoothed temp then)
s.unmark(name)                 // Undo
s.setControl(kind, value)      // kind 'heat' (1..7) or 'fan' ('high'|'low'); logs { t, kind, value }
s.logCue(cue)
s.snapshot()                   // see below; cheap, called every second
s.finish({ dropT })            // -> roast record, readings truncated at Drop, results computed
```

`snapshot()` returns:

```js
{ t, raw, smooth, ror,                 // arrays indexed by second (live references, do not mutate)
  temp, rorNow,                        // latest smoothed temp and rate of rise (null when unknown)
  events: { yellow, firstCrack, drop },// each { t, f } or null
  controls, heat, fan, lastControlT,   // log, current settings, time of last logged change
  secondsSinceReading,                 // 0 when this second had an accepted reading
  devSec, devPct,                      // null before First crack
  mode, expectedFcF, devTargetSec }
```

### Roast record (what IndexedDB stores, what export writes)

```js
{ id, schema: 1, startedAt,            // ISO string
  coffee, greenWeightG, roastedWeightG, weightLossPct,
  readings: [f | null, ...],           // index = elapsed second, °F
  events: { yellow, firstCrack, drop },// { t, f } | null
  controls: [{ t, kind, value }],      // first two entries are the t = 0 heat and fan
  results: { totalSec, phases, devSec, devPct, avgRor },
  settings: { ...snapshot of settings in effect, mode, referenceId },
  cues: [{ t, id, text }],
  reader: { source, secondsRead, rejected, secondsMissing },
  notes, score,                        // score 1..5 or null
  reference: { coffee: bool, general: bool } }
```

At most one roast per coffee name has `reference.coffee`, and at most one roast overall has `reference.general`. `db.js` enforces that when a flag is set. Reference lookup for a coffee: its own, else the general one, else none (Starter guardrails).

### Temperature source (`js/sources/*`)

```js
{ kind,                        // 'camera' | 'simulator' | 'manual'
  async start(), stop(),
  peek(),                      // -> { value, status } latest instantaneous read, for Setup
  sample(t),                   // -> °F or null: the accepted reading for elapsed second t
  setControl(kind, value),     // optional; the simulator reacts to heat and fan
  health() }                   // -> { secondsRead, rejected, secondsMissing }
```

- **Simulator:** a first-order model, `dT/dt = (Tenv(heat, fan) - T) / tau`, output rounded to whole °F like the TP17. Presets: `on-target`, `fast`, `slow`, `stall`, `ror-climb`, `dropout`, plus replay of a saved roast. Presets are parameter sets and scripted disturbances, so tapping heat in demo mode changes the curve.
- **Manual:** sparse typed readings; every other second is a gap. A typed value during a camera roast is injected for that second and re-anchors the camera filter.
- **Camera:** `camera.js` grabs the crop at 7.5 fps (`settings.reader.fps`), `sevenseg.js` reads each frame, `confirm.js` checks a tentative frame against the one before it, `filter.js` closes each second. The rate is set by the display: the TP17 redraws every 0.5 s, and a confirmation needs two pictures of the same redraw, at most 400 ms apart. 5 fps is the lowest rate that still works. The crop is the user's box widened to the left by 0.85 of its height (`DIGIT_EXTENSION`): one digit position is 0.70–0.72 digit heights, and the slanted lattice needs about 0.14 more.

### `js/reader/sevenseg.js` (pure, no DOM beyond ImageData)

```js
readDisplay(imageData, opts?) ->
  { status: 'ok' | 'dashes' | 'none', value, digits, confidence, debug }
```

- Input is the user's crop. It contains the THERMO TEMP digits of probe 1 with some margin and nothing else that is digit-sized.
- A frame is `ok` only if every segment of every digit is clearly on or clearly off and each pattern is a real digit. Anything doubtful is `none`. A missed frame is fine; a wrong value is not.
- Each segment is judged against the local background of its own digit (a plane fitted to the digit's cell, ignoring ink), and the contrast a lit segment should show is scaled by the headroom to white, because glare adds light. A segment that cannot be proven lit or unlit is doubtful. A lattice window outside the crop is doubtful too.
- Lit segments must look alike within a digit and across the three digits; a lighter one means the display is half way through a change. This is checked inside one frame only, never against earlier frames, so a change of camera exposure between frames cannot cause a miss. `opts.hint` carries geometry only.
- **Tentative tier.** A reflection can leave lit segments at a third to two thirds of their normal contrast and show unlit ones at a tenth to a fifth, which is too little to decide from one picture. When that is all that keeps a frame from reading, `readDisplay` still returns `none` but adds `debug.tentative { value, digits, confidence }` and `debug.seg7 { masks, c, strict }` (the lit pattern and each segment's contrast as a share of the expected one). The tentative value comes from the shape of each doubtful digit (`shapeDecode`): every digit pattern is priced, a lit segment costing what it falls short of 0.55 and an unlit one what it exceeds 0.22 by, and the digit reads as the cheapest pattern only if that costs at most 0.45 and the runner-up is dearer by at least 0.25. A faint segment with ink in the ink map costs nothing either way, so it cannot tip the choice. No tentative reading is offered if a segment judged strictly unlit shows contrast above 0.3 or ink in the map.
- **Known limit of the tentative tier.** A lit segment that a reflection washes down to 0.1–0.25 with no trace in the ink map looks the same as a faintly visible unlit one. On the user's two videos the lowest lit segment is 0.16–0.27 and the highest unlit one 0.21. Random synthetic glare sweeps give a confirmed wrong value in about 0.3% of six-frame sequences (0.1% before the shape rule); the real media give none. A glare spot that never moves would be confirmed as a steady wrong digit; the filter then only catches numbers the display cannot show and jumps.
- `debug.reason` says why a frame is `none`. `js/sources/camera-reasons.js` turns each reason into the wording shown to the user; a new reason needs an entry there.

### `js/reader/confirm.js` (pure)

```js
const c = createConfirmer()
c.step(readResult, atMs) -> the same result, an upgraded `ok` one, or a miss with reason 'unconfirmed reading'; c.reset()
```

- A tentative frame becomes `ok` only if the frame just before it, 30 to 400 ms earlier, shows the same lit pattern with every segment's contrast within 0.15. A reflection holds still between two pictures; a segment that is switching does not (measured on the TP17: on in about 100 ms, off in about 70 ms with a faint ghost for 200 ms more).
- Only the frame immediately before counts. A strictly read frame can serve as that earlier frame.
- The caller owns the confirmer and resets it when the camera restarts or the box moves. `readDisplay` stays pure.

### `js/reader/filter.js` (pure)

```js
const f = createReadingFilter({ minF: 50, maxF: 550, maxJumpF: 15 })
f.addFrame(frameResult); f.closeSecond() -> value | null; f.reanchor(value); f.health()
```

- **Only values the thermometer can show.** The TP17 measures whole °C and shows the °F conversion, so every displayed value is `round(1.8 × c + 32)`; 4 of every 9 whole °F numbers never appear. A frame that reads one of those is a misread and is not counted (`wholeCelsius: true`; outcome kind `impossible`). This rests on one unit and the user's first roast, photos and video.
- **Per second: a value that was seen, never an average.** The second's value is the latest one that at least two frames read, or the latest frame's value when none has two. The display redraws twice a second, so a second can hold two real values and the later one is the better reading. Frames more than 12°F apart with no majority end the second as `disagree`.
- **Jump check follows the trend (a refinement of the spec's flat 15°F).** A value is accepted at once if it is within 9°F of the last accepted one (plus 2°F per second beyond the first), or within 7°F (plus 1°F per second) of where the recent trend points; with no trend, within `maxJumpF` plus 5°F per second, 40°F at most. Anything else is a candidate. Three candidates in a row that agree with each other become the new anchor, or two when the last accepted reading is more than 6 s old. So one wrong second is never accepted, and a real change after a dropout costs one or two seconds. The old rule (15°F + 2°F/s, re-anchor after 5 agreeing seconds) could lock the reader out for up to 30 s on the Popper's early climb.
- `health()` counts seconds read, missing and rejected by cause (`rejectedRange`, `rejectedJump`, `rejectedDisagree`, `rejectedImpossible`); `lastOutcome()` says what the last second did.

### `js/core/cues.js` (pure)

```js
const engine = createCueEngine({ settings, mode, reference })
engine.tick(snapshot) -> [{ id, t, text, kind }]   // kind: 'corrective' | 'info' | 'critical'
```

Ids: `hot`, `slow`, `stall`, `rorClimb`, `fcSoon`, `fanPrompt`, `dev15`, `dropNow`, `endTemp`, `lost`, `replay`. Triggers and wording follow the spec's Live cues table. Design decisions on top of it:

- Pace cues (`hot`, `slow` in Starter mode) are evaluated only from `paceStartSec` (2:30) to First crack, and need the condition to hold for `persistSec` (10 s).
- `rorClimb` is held back for 45 s after a logged heat increase or fan decrease, since the user caused that climb.
- The same corrective cue does not repeat within 40 s. The spec's 20 s limit between any two corrective cues still applies, and a logged heat or fan change restarts it.
- `dropNow`, `endTemp` and `lost` are `critical` and ignore the limit. `lost` re-arms once a reading is accepted.

### `js/core/review.js` (pure)

```js
reviewRoast(roast, { reference, units, settings }) ->
  { headline, counts: { good, close, off }, items: [{ id, status, title, text, t? }] }
```

An addition to the spec: a review of a finished roast, shown on the After screen and the roast detail page. It is computed from the saved record each time and never stored. Item ids, in order: `weightLoss`, `firstCrack`, `development`, `totalTime`, `endTemp`, `rorShape`, `reference`, `reader`, `cues`. Status is `good`, `close`, `off` or `info` (a fact, not judged).

- Targets come from the settings saved with the roast, so the review judges a roast against what was in effect when it ran.
- `rorShape` looks for a stall, a climb (called a flick after First crack) and a crash near First crack, and credits a finding to a heat or fan change logged in the 45 s before it. It declines to judge manual roasts, roasts with more than 15% gaps and roasts under 90 s.
- `endTemp` uses the whole-degree temperatures shown on screen, and allows 2°F over the cap as on target, because the live cue fires at the cap and the user needs a moment to react.
- Tolerances that are not settings are named constants at the top of the module.

### `js/store/db.js`

```js
openDb(); saveRoast(r); getRoast(id); listRoasts(); deleteRoast(id)
setReference(id, { coffee, general }); findReference(coffeeName)
getMeta(key); setMeta(key, value)          // e.g. 'lastExportAt'
```

Database `roast-tracker`, version 1, stores `roasts` (key `id`) and `meta` (key `key`). Settings live in `localStorage` under `rt.settings` and are included in the JSON export.

## Visual design

- Dark theme only. The phone sits on a stand in a kitchen and is read from 3 feet.
- Tokens: background `#0f1115`, surface `#191c22`, raised `#232730`, hairline `#2e333d`, text `#f2f4f7`, muted text `#9aa3b2`, temperature `#ffb454`, rate of rise `#5cc8ff`, reference curve `#6b7280`, good `#4ade80`, warn `#fbbf24`, alert `#f87171`.
- Type: the system font stack. Numbers use `font-variant-numeric: tabular-nums`. Probe temperature is at least 72 px; rate of rise and elapsed time at least 40 px.
- Portrait, one-handed. Every tappable control is at least 64 px tall. Event buttons sit at the bottom edge, above the home-indicator safe area.
- The chart is a single canvas: temperature on the left axis, rate of rise on the right, phase bands behind, the heat and fan step strip directly under it on the same time axis.

## Milestones

| # | Milestone | Passes when |
| --- | --- | --- |
| 1 | Digit reader proof | `reader-test.html` meets the spec's accuracy target on the user's photos and video. Provisional until that media exists; until then it must read every real crop from the fixture photo and a synthetic set |
| 2 | Roast logging on the simulator | A simulated roast at 1x and 10x logs, charts, saves and shows in history; unit tests for the maths pass |
| 3 | Cues and Reference mode | Each cue fires on its simulator preset and stays silent on `on-target` |
| 4 | Camera in the roast screen | Camera source, wake lock, audio unlock and the number pad work in the roast screen |
| 5 | Finish | Offline install, export and import, settings |
| 6 | Field test | Three real roasts match a handwritten log (the user runs this) |
