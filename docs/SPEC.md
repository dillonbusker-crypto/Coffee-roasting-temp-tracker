# Roast Tracker: build spec

Nov 14, 2026 · @Dillon Busker

## Summary

Roast Tracker is a phone web app, hosted on GitHub Pages, that reads a thermometer's display through the phone camera during a roast on a Popper air roaster. It plots temperature and rate of rise live and gives spoken cues when the roast drifts off target.

One roast goes like this:

1. Aim the phone at the thermometer and confirm the app reads the digits.
2. Tap Start when the beans go in. The app logs one reading per second.
3. Tap First crack when it starts. The app counts down development time and calls the drop.
4. Enter the roasted weight. The app saves the roast with its weight loss.

The goal is repeatable Nordic-style light roasts at 11–12% weight loss.

## Setup and constraints

Every target in the app must be relative to this probe on this roaster, never a textbook bean temperature.

- **Roaster:** Sweet Maria's Popper, the gray 2025 production run. It is an air roaster with a numbered heat knob of 7 stepped levels and a High/Low fan knob. Batches are 90 g and roasts run about 6–7 minutes.
- **Probe:** the thermometer's stainless meat probe (4 mm thick, 2.5 mm tip, thermistor sensor), held by a clamp from above with the tip at the center of the chamber, low in the bean bed. It is thicker and slower than a roasting thermocouple, so readings lag the roast. It reads hot air mixed with bean contact, so it runs above true bean temperature.
- **Thermometer:** a ThermoPro TP17 dual-probe meat thermometer. It reads 14–572°F in whole degrees and refreshes about once per second. Only probe 1 is used.
- **Phone:** an iPhone running Safari, on a stand, rear camera aimed at the display, screen facing the user.
- **Hosting:** a static site on GitHub Pages. No backend and no accounts.
- **Users:** one person on one phone.
- **Units:** °F by default, with a °C setting.

Thermometer details come from the maker's [TP17 family specifications](https://temppro.com/products/tp17h-leave-in-meat-thermometer-4-probes) and the [AmazingRibs TP-17 review](https://amazingribs.com/thermometers/thermopro-tp-17-dual-probe-thermometer-review/). The one-second refresh is listed for the TP17 family and should be confirmed on this unit.

## Screens and flow

The app has three screens, used in order.

1. **Setup**
   - A live camera preview. The user drags a box around the digits and the app shows the value it reads, updating live.
   - Fields: coffee name, green weight (default 90 g), development target (default 55 s), and the starting heat and fan settings.
   - The current mode is shown: Starter guardrails, or Reference if a reference roast is saved for this coffee or as the general fallback.
   - Start stays disabled until the app has read 5 plausible values in a row.
2. **Roast**
   - Current temperature, rate of rise and elapsed time, large enough to read from 3 feet away.
   - A chart of temperature and rate of rise against time, with phase bands and a heat and fan strip under it. In Reference mode the reference curve sits behind the live one.
   - Three large buttons: Yellow (optional), First crack, Drop. Each stamps the time and temperature, with a 5-second Undo. Heat and fan controls always show the current settings. One tap on either logs the change with its time, and the log can be corrected after the roast.
   - After First crack: a development countdown and the running development percentage.
   - A small strip of the cropped camera view stays visible, so the user can see the reader is working.
3. **After**
   - The user enters the roasted weight and the app shows weight loss.
   - Notes and a 1–5 taste score, both editable later.
   - Save, with an option to set the roast as the reference.
   - A history list: date, coffee, time to first crack, development time, weight loss, score.

## What the app tracks and shows

The roast screen shows the same data as Roast-Tech, the app for the Fresh Roast SR900, adapted for a roaster the app can neither read nor control.

| Roast-Tech shows | This app |
| --- | --- |
| Live bean-temperature graph | A live temperature curve from the probe, labelled Probe temp because it is not true bean temperature |
| Roast time | An elapsed timer |
| Rate-of-rise data | Rate of rise as a number and as a second curve on the same chart |
| Heat and fan settings | Logged by tap, since the Popper has no data link: seven heat buttons numbered like the knob and a High/Low fan toggle, drawn as a step strip under the chart |
| Roast stages | Three phase bands on the chart: Drying (Start to Yellow), Browning (Yellow to First crack), Development (First crack to Drop). Each shows its time and share of the roast. If Yellow is not tapped, the first two merge |
| Profile changes | The reference curve behind the live one, with a marker wherever a cue fired |
| Development time ratio | Live development % after First crack |

The Roast-Tech list comes from [Home Roasting Supplies](https://homeroastingsupplies.com/products/fresh-roast-sr900-coffee-roaster-with-roast-tech-app-copy) and [Sweet Maria's](https://www.sweetmarias.com/products/fresh-roast-sr900). Neither page describes the screen layout, so the layout below is this spec's own arrangement of the same data.

Roast-Tech leaves weight to a separate scale. This app adds green and roasted weight, weight loss, notes and a taste score, so each roast record is complete.

- **Roast screen, top to bottom:** readouts (probe temp, rate of rise, elapsed time, development %), the chart with phase bands, the heat and fan strip, then the event buttons.
- **After-roast summary:** time and temperature at Yellow, First crack and Drop; time and % in each phase; development time and %; average rate of rise; weight loss; the full chart with its heat and fan strip.

## Reading the display by camera

This is the riskiest part of the build, so it is built and tested first. The display is a gray-green LCD with dark, slanted seven-segment digits and no decimal place.

- **Capture:** the rear camera, cropped to the user's box, processed at 3–5 frames per second. The box covers only the top-right number, labelled THERMO TEMP on the probe 1 row. The alert temperature beside it, the probe 2 row and the °F symbol stay outside the box.
- **Recognition:** correct the slant of the digits, threshold the crop, and sample each segment's position. That is more reliable on seven-segment digits than general-purpose text recognition.
- **One value per second:** the median of the frames read in that second.
- **Rejecting bad reads:** discard a value outside 50–550°F, or one more than 15°F from the last accepted value. Count the discards.
- **Dropouts:** hold the last value and keep the clock running. After 5 seconds with no accepted reading, say "lost the reading" and show a banner. Store gaps as gaps, not as filled-in values.
- **Display changes:** handle a third digit appearing (99 to 100). Digits are right-aligned and a leading 1 is narrow. Three dashes mean no probe reading.
- **Lighting:** lock exposure and focus where the browser allows, and show a setup tip about glare. The backlight turns off 10 seconds after the last button press, so the reader must work in room light. The phone should face the display square-on, because this LCD shows a faint double image at an angle.
- **Manual fallback:** a number pad for typing a reading if the camera fails mid-roast.
- **Accuracy target:** on a recorded test video in steady light, at least 98% of seconds produce a correct value, and fewer than 1 wrong value per roast is accepted. A missed reading is acceptable; a wrong one is not.

**Thermometer setup:** set the alert temperature to its maximum, 572°F. At a lower setting the unit beeps and flashes its backlight when the reading reaches it. That would happen near the end of a roast and disturb both the reader and the user. The Setup screen shows this as a reminder.

## Calculations

The app works from one accepted reading per second.

- **Smoothed temperature:** the average of the last 10 seconds of accepted readings. This is the number displayed and charted.
- **Rate of rise:** the slope of a best-fit line through the last 30 seconds of smoothed temperature, in °F per minute, updated every second. The window is a setting (15, 30 or 45 seconds). Nothing is shown for the first 30 seconds.
- **Events:** Start, Yellow, First crack and Drop, each stored with its time and temperature.
- **Development time:** Drop minus First crack. Development percentage is development time divided by total roast time.
- **Weight loss:** green weight minus roasted weight, divided by green weight.
- **Expected first-crack reading:** taken from the reference roast. Before one exists, a provisional setting of 410°F is used. That number is a guess for this probe and should be replaced by the first logged roast.
- **Projected first crack:** the time at which temperature reaches the expected first-crack reading at the current rate of rise. It is a rough pacing estimate, used only for cues.

## Baseline targets

The baseline is a curve shape and a set of targets, not a temperature curve copied from another roaster. Prodigal, Sey and Tim Wendelboe roast on production machines with bean probes, so their temperatures would be wrong on this probe. How they shape and judge a roast does carry over.

### Mode 1: Starter guardrails

Used until a reference roast is saved. Every default is a setting.

| Target | Default | Basis |
| --- | --- | --- |
| First crack | 5:00–5:30 after Start | Sweet Maria's best Popper roasts reach first crack near 5:30 ([Popper guide](https://library.sweetmarias.com/having-an-issue-popper-troubleshooting-tips/)) |
| Pace limits | Warn if first crack is projected before 4:00 or after 7:00 | Same guide: 4:00 at the soonest, over 7:00 too slow |
| Rate of rise | Falls steadily from its peak to the drop | Scott Rao's rule in The Coffee Roaster's Companion |
| Development time | 55 s, adjustable from 45 to 65 s | Tim Wendelboe's usual range on his sample roaster ([ROEST interview](https://www.roestcoffee.com/blog/tims-roesting-tips)) |
| Total time | About 6:30 | Wendelboe's sample roasts usually run no longer than 6.5 minutes (same interview) |
| End temperature cap | First-crack reading + 15°F | Starting assumption, to tune |
| Weight loss | 11–12%; flag a roast outside it | The user's target. Prodigal judges batches by weight loss and accepts 0.25% either side of target ([Rao on consistency](https://scottrao.com/blog/2023/9/20/consistency-in-roasting)) |

Rao's separate guideline puts development at 20–25% of total roast time ([Daily Coffee News](https://dailycoffeenews.com/2014/08/12/roast-development-time-and-the-prerequisite-for-any-successful-roast)). On a 6:30 roast that is 80–100 seconds, longer than the default. The app shows development percentage so the two can be compared by taste.

**Starting settings:** Sweet Maria's light profile for this Popper is fan High and heat 2 for the whole roast, with first crack at 5:00–5:30 ([Popper roast profiles](https://library.sweetmarias.com/roast-profiles-in-popper-coffee-roaster/)). The Setup screen pre-fills these. That profile runs about 1:30 of development, so this spec's 55-second default ends the roast sooner. The same article says to go one heat level higher on low voltage or in a cool room.

### Mode 2: Reference roast

After any roast, the user can mark it as the reference for that coffee. A coffee with no reference of its own falls back to a general one. From then on:

- The live curve is compared with the reference at the same elapsed time.
- The expected first-crack reading and the development target come from the reference.
- Mode 1's pace limits and weight-loss flag still apply.

**Replay prompts:** in Mode 2 the app also speaks the reference roast's logged heat and fan changes at the same elapsed times, for example "heat to 3 now". The user still taps the control to log the change.

The intended path is to roast in Mode 1 until one roast lands at 11–12% weight loss and tastes right, then set it as the reference.

## Live cues

Cues are spoken, with a beep as fallback, so the user can keep watching the roast.

| Cue | Trigger | The app says |
| --- | --- | --- |
| Running hot | Mode 1: first crack projected before 4:00. Mode 2: 10°F above the reference for 10 s | "Running hot. Lower the heat one step." |
| Running slow | Mode 1: first crack projected after 7:00. Mode 2: 10°F below the reference for 10 s | "Running slow. Raise the heat one step." |
| Stall | Rate of rise below 5°F per minute for 10 s before first crack | "Stalling. Raise the heat one step." |
| Rate of rise climbing | After 2:00, rate of rise is 5°F per minute above its recent low for 10 s | "Rate of rise is climbing." |
| First crack soon | Within 10°F of the expected first-crack reading | "First crack soon." |
| Development countdown | 15 s before the development target, then at the target | "Fifteen seconds." then "Drop now." |
| End temperature | The end temperature cap is reached before the countdown ends | "At end temperature. Drop now." |
| Lost reading | 5 s with no accepted reading | "Lost the reading." |

Two prompts sit outside that table:

- **Replay prompts (Mode 2):** each heat or fan change logged in the reference roast is spoken at the same elapsed time. A replay prompt is skipped if it would undo a corrective cue fired in the last 20 seconds.
- **Fan prompt (a setting, off by default):** when turned on, the app says "Fan to Low" along with "First crack soon".

Rules for all cues:

- At most one corrective cue every 20 seconds, because the roaster responds slowly and the rate-of-rise window lags. A logged heat or fan change restarts that 20 seconds, so the app waits to see its effect. "Drop now" and "Lost the reading" ignore this limit.
- Corrective cues ask for one step on the 7-step heat knob. At heat 1 or heat 7 the app says the knob is at its limit instead.
- Each cue can be muted, and every threshold is a setting.
- Every cue fired is logged with its time, so the user can later judge which ones helped.

## Data and storage

Roasts are stored on the phone only, in the browser's database (IndexedDB).

| Field | Contents |
| --- | --- |
| Identity | Roast id, start date and time, coffee name |
| Weights | Green weight, roasted weight, weight loss % |
| Readings | One entry per second: elapsed seconds and °F, with gaps kept as empty |
| Events | Yellow, First crack, Drop: time and temperature for each. Heat and fan changes: setting and time for each |
| Results | Total time, time and % in each phase, development time and %, average rate of rise |
| Settings in effect | Mode, rate-of-rise window, targets and thresholds |
| Cues | Each cue fired, with its time |
| Reader health | Seconds read, values rejected, seconds missing |
| Review | Notes, taste score, reference flag |

- **Export:** all roasts as one JSON file, and any single roast as CSV (time, temperature, rate of rise, event).
- **Import:** a JSON export restores the history.
- **Backup reminder:** the history screen shows the date of the last export, because clearing browser data deletes the roasts.

## Technical requirements

The app is static files only: no server code, no API keys, and nothing leaves the phone. The target is Safari on an iPhone.

- **Hosting:** GitHub Pages, which serves over HTTPS. Browsers require HTTPS for camera access.
- **Camera:** the rear camera through the browser's camera API, shown inline so an iPhone does not force fullscreen video.
- **Screen:** stays awake for the whole roast (Screen Wake Lock). If the browser does not support it, warn on the Setup screen.
- **Sound:** speech and beeps are unlocked by the Start tap, because phone browsers block audio until the user touches the page.
- **Offline:** installable to the home screen and usable with no connection after the first load.
- **Layout:** portrait, one-handed, with buttons at least 64 px tall.
- **Performance:** the chart redraws every second without stutter while the camera is running.
- **Temperature source:** built as a swappable part with three versions at launch: camera, simulator and manual entry. This leaves room for a Bluetooth probe later.
- **Stack:** Claude Code's choice. Prefer the fewest dependencies that meet the above.

## Build order and tests

Build in this order, and do not start a step until the one before it passes.

1. **Digit reader proof.** A test page that reads the display from still photos and a recorded video of the thermometer. It passes when it meets the accuracy target above. The user supplies about 10 photos and a 1-minute video at different temperatures.
2. **Roast logging on a simulator.** A simulated temperature source replays a synthetic or saved roast at 1x and 10x speed. Chart, rate of rise, events, saving and history are built and tested against it.
3. **Cues and Reference mode.** Each cue is tested with a simulator curve built to trigger it: fast, slow, stall, climbing rate of rise, dropout.
4. **Camera in the roast screen.** Add wake lock, audio unlock and the manual fallback.
5. **Finish.** Offline install, export and import, settings.
6. **Field test.** Three real roasts. Logged first crack and drop match a handwritten log, and rate of rise matches a hand calculation at two points within 2°F per minute.

The simulator stays in the shipped app as a demo mode.

## Out of scope for version 1

- Bluetooth or wired probes
- Controlling the roaster
- Cloud sync, accounts or sharing
- Detecting first crack by sound
- Importing or exporting Artisan files
- Measuring roast color

## Open questions

- [ ] Confirm that the TP17's display updates about once per second during a roast.
- [ ] Test media for the digit reader: about 10 photos and a 1-minute video of the display, taken on the iPhone.
- [ ] The starting heat level for a Nordic-style roast. The spec pre-fills heat 2 on High fan, from Sweet Maria's light profile, until real roasts say otherwise.
- [ ] Where the probe tip finally sits. It is being moved to the center of the chamber, low in the bean bed, which will change the first-crack reading.
- [ ] Whether Safari keeps the screen awake and the camera running for a full roast. Test this in the first build step.
- [ ] A new repo, or a folder in an existing one?
