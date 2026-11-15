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
- **Camera:** `camera.js` grabs the crop at 4 fps, `sevenseg.js` reads each frame, `filter.js` closes each second.

### `js/reader/sevenseg.js` (pure, no DOM beyond ImageData)

```js
readDisplay(imageData, opts?) ->
  { status: 'ok' | 'dashes' | 'none', value, digits, confidence, debug }
```

- Input is the user's crop. It contains the THERMO TEMP digits of probe 1 with some margin and nothing else that is digit-sized.
- A frame is `ok` only if every segment of every digit is clearly on or clearly off and each pattern is a real digit. Anything doubtful is `none`. A missed frame is fine; a wrong value is not.

### `js/reader/filter.js` (pure)

```js
const f = createReadingFilter({ minF: 50, maxF: 550, maxJumpF: 15 })
f.addFrame(frameResult); f.closeSecond() -> value | null; f.reanchor(value); f.health()
```

- Per second: median of that second's `ok` frames, then the range and jump checks.
- **Jump check is gap-aware (a refinement of the spec's flat 15°F).** The allowed jump is 15°F plus 2°F for each second since the last accepted value. If 5 consecutive seconds are rejected for jump but agree with each other, the filter re-anchors to them. Without this, one long dropout during a fast climb would lock the reader out for the rest of the roast.

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
