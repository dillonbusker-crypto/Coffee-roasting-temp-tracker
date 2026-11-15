// One roast in progress. The caller feeds it one reading per second (a number or
// null for a gap), taps events and controls, and finally asks for the roast record.
// Second t = 0 is the Start tap; readings[i] is the reading at second i.

import { smoothAt, trustedSmoothAt, rorAt, summarize } from './calc.js';
import { DEFAULTS } from './settings.js';

const EVENT_NAMES = ['yellow', 'firstCrack', 'drop'];

function newId(startedAt) {
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `r-${startedAt.replace(/\D/g, '').slice(0, 14)}-${rand}`;
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// First-crack reading and development time of a saved reference roast, or null.
export function referenceTargets(reference) {
  const fc = reference?.events?.firstCrack;
  const drop = reference?.events?.drop;
  const devSec = reference?.results?.devSec ?? (fc && drop ? drop.t - fc.t : null);
  return { expectedFcF: fc?.f ?? null, devTargetSec: devSec ?? null };
}

export function createSession({
  coffee = '',
  greenWeightG = DEFAULTS.greenWeightG,
  heat = DEFAULTS.startHeat,
  fan = DEFAULTS.startFan,
  settings = DEFAULTS,
  mode = 'starter',
  reference = null,
  source = null,
  startedAt = new Date().toISOString(),
  id = newId(startedAt),
} = {}) {
  const effectiveMode = mode === 'reference' && reference ? 'reference' : 'starter';
  const refTargets = effectiveMode === 'reference' ? referenceTargets(reference) : {};
  const expectedFcF = refTargets.expectedFcF ?? settings.expectedFcF;
  const devTargetSec = refTargets.devTargetSec ?? settings.devTargetSec;

  const raw = [];
  const smooth = [];
  const trusted = [];   // smooth[] without the seconds whose window is mostly empty; the rate is fitted to this
  const ror = [];
  const events = { yellow: null, firstCrack: null, drop: null };
  const controls = [
    { t: 0, kind: 'heat', value: heat },
    { t: 0, kind: 'fan', value: fan },
  ];
  const cues = [];
  let curHeat = heat;
  let curFan = fan;
  let lastReadingT = -1;
  let lastSmooth = null;   // latest known smoothed temp, held through a gap
  let lastRor = null;

  if (source && source.setControl) {
    source.setControl('heat', heat);
    source.setControl('fan', fan);
  }

  const now = () => Math.max(0, raw.length - 1);

  function addReading(f) {
    const t = raw.length;
    const v = f == null || Number.isNaN(f) ? null : f;
    raw.push(v);
    // A second with no reading has no smoothed value or rate either: gaps stay gaps.
    const s = v == null ? null : smoothAt(raw, t, settings.smoothSec);
    smooth.push(s);
    trusted.push(v == null ? null : trustedSmoothAt(raw, t, settings.smoothSec));
    const r = s == null ? null : rorAt(trusted, t, settings.rorWindowSec);
    ror.push(r);
    if (v != null) lastReadingT = t;
    if (s != null) lastSmooth = s;
    if (r != null) lastRor = r;
  }

  function mark(name) {
    if (!EVENT_NAMES.includes(name)) throw new RangeError(`Unknown event: ${name}`);
    const event = { t: now(), f: round1(lastSmooth) };
    events[name] = event;
    return event;
  }

  function unmark(name) {
    if (!EVENT_NAMES.includes(name)) throw new RangeError(`Unknown event: ${name}`);
    events[name] = null;
  }

  // Logs a change at the current second. Tapping the setting already in effect logs nothing.
  function setControl(kind, value) {
    if (kind === 'heat') {
      if (!Number.isInteger(value) || value < 1 || value > 7) throw new RangeError('heat must be 1..7');
      if (value === curHeat) return null;
      curHeat = value;
    } else if (kind === 'fan') {
      if (value !== 'high' && value !== 'low') throw new RangeError("fan must be 'high' or 'low'");
      if (value === curFan) return null;
      curFan = value;
    } else {
      throw new RangeError(`Unknown control: ${kind}`);
    }
    const entry = { t: now(), kind, value };
    controls.push(entry);
    if (source && source.setControl) source.setControl(kind, value);
    return entry;
  }

  function logCue(cue) {
    cues.push({ t: cue.t, id: cue.id, text: cue.text });
  }

  function snapshot() {
    const t = now();
    const fc = events.firstCrack;
    const drop = events.drop;
    let devSec = null;
    let devPct = null;
    if (fc) {
      devSec = (drop ? drop.t : t) - fc.t;
      const total = drop ? drop.t : t;
      devPct = total > 0 ? (devSec / total) * 100 : null;
    }
    return {
      t, raw, smooth, ror,
      temp: lastSmooth,
      rorNow: lastRor,
      events,
      controls,
      heat: curHeat,
      fan: curFan,
      lastControlT: controls[controls.length - 1].t,
      secondsSinceReading: raw.length === 0 ? 0 : (lastReadingT < 0 ? t + 1 : t - lastReadingT),
      devSec,
      devPct,
      mode: effectiveMode,
      expectedFcF,
      devTargetSec,
    };
  }

  // Builds the roast record. Everything after dropT is cut off.
  function finish({ dropT } = {}) {
    const end = dropT ?? events.drop?.t ?? now();
    const readings = raw.slice(0, end + 1);
    const cut = (e) => (e && e.t <= end ? { ...e } : null);
    const finalEvents = { yellow: cut(events.yellow), firstCrack: cut(events.firstCrack), drop: cut(events.drop) };
    if (!finalEvents.drop) {
      const f = smooth[end] ?? smooth.slice(0, end + 1).reverse().find((v) => v != null) ?? null;
      finalEvents.drop = { t: end, f: round1(f) };
    }
    const secondsRead = readings.filter((v) => v != null).length;
    const health = source && source.health ? source.health() : {};
    const record = {
      id,
      schema: 1,
      startedAt,
      coffee,
      greenWeightG,
      roastedWeightG: null,
      weightLossPct: null,
      readings,
      events: finalEvents,
      controls: controls.filter((c) => c.t <= end).map((c) => ({ ...c })),
      results: null,
      settings: {
        ...JSON.parse(JSON.stringify(settings)),
        expectedFcF,
        devTargetSec,
        mode: effectiveMode,
        referenceId: effectiveMode === 'reference' ? reference.id ?? null : null,
      },
      cues: cues.filter((c) => c.t <= end).map((c) => ({ ...c })),
      reader: {
        source: source?.kind ?? 'unknown',
        secondsRead,
        rejected: health.rejected ?? 0,
        secondsMissing: readings.length - secondsRead,
      },
      notes: '',
      score: null,
      reference: { coffee: false, general: false },
    };
    record.results = summarize(record);
    return record;
  }

  return { id, addReading, mark, unmark, setControl, logCue, snapshot, finish };
}
