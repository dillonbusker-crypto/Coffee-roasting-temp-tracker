// Test harness: runs a simulator preset through a real session and cue engine,
// second by second, the way the app does (no UI).

import { createSimulatorSource } from '../../js/sources/simulator-source.js';
import { createSession } from '../../js/core/session.js';
import { createCueEngine } from '../../js/core/cues.js';
import { DEFAULTS } from '../../js/core/settings.js';

// Default "user": taps First crack when the reading reaches the expected first-crack
// temperature, and Drop when the countdown ends. Pass user: null to tap nothing.
export function autoUser({ session, snapshot, cues, ctx }) {
  const raw = snapshot.raw[snapshot.t];
  if (!snapshot.events.firstCrack && raw != null && raw >= snapshot.expectedFcF) session.mark('firstCrack');
  if (snapshot.events.firstCrack && cues.some((c) => c.id === 'dropNow')) {
    ctx.dropT = session.mark('drop').t;
  }
}

export function runRoast({
  preset = 'on-target',
  seed = 1,
  noise,
  settings = {},
  mode = 'starter',
  reference = null,
  heat = 2,
  fan = 'high',
  maxSec = 480,
  user = autoUser,
  source = createSimulatorSource({ preset, seed, heat, fan, ...(noise === undefined ? {} : { noise }) }),
} = {}) {
  const merged = { ...DEFAULTS, ...settings };
  const session = createSession({ coffee: 'Test', heat, fan, settings: merged, mode, reference, source });
  const engine = createCueEngine({ settings: merged, mode, reference });
  const ctx = { dropT: null };
  const fired = [];      // every cue, in order
  for (let t = 0; t <= maxSec; t++) {
    session.addReading(source.sample(t));
    const snapshot = session.snapshot();
    const cues = engine.tick(snapshot);
    for (const c of cues) { session.logCue(c); fired.push(c); }
    if (user) user({ session, snapshot, cues, ctx, source });
    if (ctx.dropT !== null) break;
  }
  return { session, source, fired, ctx, ids: fired.map((c) => c.id) };
}

// A source that plays back a function of t (number or null), for hand-built scenarios.
export function seriesSource(fn, kind = 'simulator') {
  return { kind, sample: fn, setControl() {}, health: () => ({ rejected: 0 }) };
}

// A snapshot built by hand, for engine tests that need to control every field.
// o: { ror(t), smooth(t), heat, fan (current), startHeat, startFan (default 2, high), controls, lastControlT, events, expectedFcF, devTargetSec, secondsSinceReading }
export function snapAt(t, o = {}) {
  const smooth = Array.from({ length: t + 1 }, (_, i) => (o.smooth ? o.smooth(i) : 300 + i * 0.1));
  const ror = Array.from({ length: t + 1 }, (_, i) => (o.ror ? o.ror(i) : 40));
  const controls = [{ t: 0, kind: 'heat', value: o.startHeat ?? 2 }, { t: 0, kind: 'fan', value: o.startFan ?? 'high' }, ...(o.controls || [])];
  return {
    t, raw: smooth, smooth, ror,
    temp: smooth[t], rorNow: ror[t],
    events: { yellow: null, firstCrack: null, drop: null, ...(o.events || {}) },
    controls,
    heat: o.heat ?? 2,
    fan: o.fan ?? 'high',
    lastControlT: o.lastControlT ?? controls[controls.length - 1].t,
    secondsSinceReading: o.secondsSinceReading ?? 0,
    devSec: o.devSec ?? null,
    devPct: null,
    mode: o.mode ?? 'starter',
    expectedFcF: o.expectedFcF ?? 410,
    devTargetSec: o.devTargetSec ?? 55,
  };
}
