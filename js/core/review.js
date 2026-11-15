// Roast review. Pure: judges a finished roast record against the targets in settings (and
// optionally a reference roast) and says, in plain statements with the numbers, what was on
// target and what was not. It is computed from the record every time and never stored, so it
// follows edits and later rule changes. It judges the curve against targets; it does not say
// whether the coffee is good.
//
//   reviewRoast(roast, { reference, units, settings })
//     -> { headline, counts: { good, close, off }, items: [{ id, status, title, text, t? }] }
//
// status: 'good' | 'close' | 'off' (judged) or 'info' (a fact, not judged).
// Items come in a fixed order: weightLoss, firstCrack, development, totalTime, endTemp,
// rorShape, reference, reader, cues.

import { analyzeSeries, smoothSeries, weightLossPct } from './calc.js';
import { DEFAULTS } from './settings.js';
import { formatClock, formatDelta, formatRate } from './units.js';

// ---- Thresholds that are not settings ----
const DEV_GOOD_SEC = 5;          // development within this of the target is on target
const DEV_CLOSE_SEC = 10;        // ... and within this is close
const TOTAL_GOOD_SEC = 30;       // total time within this of the target is on target
const TOTAL_CLOSE_SEC = 60;      // ... and within this is close
const LOSS_CLOSE_POINTS = 0.5;   // weight loss this many points outside the band is close
const END_TEMP_CLOSE_F = 5;      // end temperature this many °F over the cap is close
const CRASH_SPAN_SEC = 30;       // a crash is a fall of the rate of rise over this long ...
const CRASH_FRACTION = 0.35;     // ... by more than this share of its earlier value ...
const CRASH_MIN_FALL = 8;        // ... and by more than this many °F/min (a normal curve loses ~18% per 30 s)
const CRASH_LEAD_SEC = 60;       // crashes are looked for from this long before First crack to Drop
const ATTRIBUTION_SEC = 45;      // a heat or fan change this soon before a finding is named as its likely cause
const MAX_GAP_FRACTION = 0.15;   // more than this share of seconds missing: the shape can't be judged
const MIN_SHAPE_SEC = 90;        // a roast shorter than this is too short to judge the shape
const CLIMB_CLOSE_FACTOR = 2;    // a climb under this many times the threshold is close, beyond is off
const MERGE_SEC = 10;            // findings of one kind closer together than this count as one
const REFERENCE_FROM_SEC = 60;   // the reference comparison starts here
const READER_NOTABLE_FRACTION = 0.05; // more than this share of seconds missing is worth a note
const RAO_DEV_PCT = '20–25%';    // Rao's development guideline, shown next to the percentage

const TITLES = {
  weightLoss: 'Weight loss',
  firstCrack: 'First crack',
  development: 'Development',
  totalTime: 'Total time',
  endTemp: 'End temperature',
  rorShape: 'Rate of rise',
  reference: 'Reference',
  reader: 'Reader',
  cues: 'Cues',
};

const CUE_NAMES = {
  hot: 'Running hot',
  slow: 'Running slow',
  stall: 'Stalling',
  rorClimb: 'Rate of rise climbing',
  endTemp: 'End temperature',
  lost: 'Lost reading',
};

const RANK = { good: 0, close: 1, off: 2 };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const secs = (n) => `${Math.round(n)} s`;
const upFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Targets in effect: DEFAULTS, then the settings passed in, then the roast's own saved settings.
// A value of the wrong type or a non-finite number is ignored.
function resolveSettings(roast, fallback) {
  const out = { ...DEFAULTS };
  for (const src of [fallback, roast && roast.settings]) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (v === null || v === undefined) continue;
      const d = DEFAULTS[k];
      if (typeof d === 'number' && !isNum(v)) continue;
      if (typeof d === 'string' && typeof v !== 'string') continue;
      out[k] = v;
    }
  }
  return out;
}

const cleanReadings = (r) => (Array.isArray(r) ? r.map((v) => (isNum(v) ? v : null)) : []);

function item(id, status, text, extra) {
  return { id, status, title: TITLES[id], text, ...(extra || {}) };
}

// ---- 1-5: numbers against targets ----

function weightLossItem(roast, S) {
  const roasted = roast.roastedWeightG;
  if (!isNum(roasted) || !(roasted > 0)) return null;
  let loss = weightLossPct(roast.greenWeightG, roasted);
  if (loss == null && isNum(roast.weightLossPct)) loss = roast.weightLossPct;
  if (loss == null) {
    return item('weightLoss', 'info', 'The green weight is missing, so weight loss can\'t be worked out.');
  }
  const lo = S.weightLossMinPct;
  const hi = S.weightLossMaxPct;
  const band = `${lo}–${hi}%`;
  // Work in tenths of a point, the precision shown, so the text and the verdict agree.
  const tenths = Math.round(loss * 10);
  const loT = Math.round(lo * 10);
  const hiT = Math.round(hi * 10);
  const shown = (tenths / 10).toFixed(1);
  if (tenths >= loT && tenths <= hiT) {
    return item('weightLoss', 'good', `Weight loss ${shown}%, inside the ${band} band.`);
  }
  const over = tenths > hiT;
  const away = over ? tenths - hiT : loT - tenths;
  const status = away <= Math.round(LOSS_CLOSE_POINTS * 10) ? 'close' : 'off';
  return item('weightLoss', status, `Weight loss ${shown}%, ${(away / 10).toFixed(1)} points ${over ? 'over' : 'under'} the ${band} band.`);
}

function firstCrackItem(fcT, S) {
  const win = `${formatClock(S.fcWindowStartSec)}–${formatClock(S.fcWindowEndSec)}`;
  if (fcT === null) {
    return item('firstCrack', 'info', 'First crack was not marked, so development and end temperature can\'t be judged.');
  }
  const at = `First crack at ${formatClock(fcT)}`;
  if (fcT >= S.fcWindowStartSec && fcT <= S.fcWindowEndSec) {
    return item('firstCrack', 'good', `${at}, inside the ${win} window.`, { t: fcT });
  }
  const early = fcT < S.fcWindowStartSec;
  const away = early ? S.fcWindowStartSec - fcT : fcT - S.fcWindowEndSec;
  const inPace = fcT >= S.paceEarlySec && fcT <= S.paceLateSec;
  const text = `${at}, ${secs(away)} ${early ? 'before' : 'after'} the ${win} window`;
  if (inPace) return item('firstCrack', 'close', `${text}.`, { t: fcT });
  const pace = `${formatClock(S.paceEarlySec)}–${formatClock(S.paceLateSec)}`;
  return item('firstCrack', 'off', `${text} and outside the ${pace} pace limits.`, { t: fcT });
}

function developmentItem(devSec, totalSec, S) {
  const target = S.devTargetSec;
  const diff = devSec - target;
  const a = Math.abs(diff);
  const status = a <= DEV_GOOD_SEC ? 'good' : a <= DEV_CLOSE_SEC ? 'close' : 'off';
  const rel = diff === 0 ? 'on the' : `${secs(a)} ${diff < 0 ? 'short of' : 'over'} the`;
  let text = `Development ${formatClock(devSec)}, ${rel} ${secs(target)} target.`;
  if (totalSec > 0) text += ` That is ${Math.round((devSec / totalSec) * 100)}% of the roast; Rao's guideline is ${RAO_DEV_PCT}.`;
  return item('development', status, text);
}

function totalTimeItem(totalSec, S) {
  const target = S.totalTargetSec;
  if (!(totalSec > 0)) return item('totalTime', 'info', 'No roast time was recorded, so total time can\'t be judged.');
  const diff = totalSec - target;
  const a = Math.abs(diff);
  const status = a <= TOTAL_GOOD_SEC ? 'good' : a <= TOTAL_CLOSE_SEC ? 'close' : 'off';
  const rel = diff === 0 ? 'on the' : `${secs(a)} ${diff < 0 ? 'short of' : 'over'} the`;
  return item('totalTime', status, `Total time ${formatClock(totalSec)}, ${rel} ${formatClock(target)} target.`);
}

function endTempItem(fcF, dropF, S, units) {
  if (!isNum(fcF) || !isNum(dropF)) {
    return item('endTemp', 'info', 'The First crack or Drop temperature is missing, so end temperature can\'t be judged.');
  }
  // The probe reads whole degrees, so judge the rise to the nearest degree: a rise of 15.3 against
  // a 15 cap shows as 15 and should not read as over.
  const rise = Math.round(dropF - fcF);
  const cap = S.endTempCapF;
  const capText = formatDelta(cap, units);
  const status = rise <= cap ? 'good' : rise <= cap + END_TEMP_CLOSE_F ? 'close' : 'off';
  const amount = formatDelta(Math.abs(rise), units);
  const dir = rise < 0 ? 'below' : 'above';
  const text = status === 'good'
    ? `Dropped ${amount} ${dir} the first-crack reading, inside the ${capText} cap.`
    : `Dropped ${amount} ${dir} the first-crack reading; the cap is ${capText}.`;
  return item('endTemp', status, text);
}

// ---- 6: shape of the rate of rise ----

// Heat and fan changes from the control log: { t, kind, from, to }. The first entry of each kind
// is the starting setting, not a change.
function controlChanges(controls) {
  const last = { heat: null, fan: null };
  const out = [];
  for (const c of Array.isArray(controls) ? controls : []) {
    if (!c || (c.kind !== 'heat' && c.kind !== 'fan') || !isNum(c.t)) continue;
    if (last[c.kind] !== null && last[c.kind] !== c.value) out.push({ t: c.t, kind: c.kind, from: last[c.kind], to: c.value });
    last[c.kind] = c.value;
  }
  return out;
}

const fanWord = (v) => (v === 'low' ? 'Low' : v === 'high' ? 'High' : String(v));

// " That was 12 s after heat went from 3 to 2." for changes in the ATTRIBUTION_SEC before t.
function attribution(changes, t) {
  const near = changes.filter((c) => c.t <= t && t - c.t <= ATTRIBUTION_SEC).slice(-2);
  if (!near.length) return '';
  const parts = near.map((c) => {
    const what = c.kind === 'heat' ? `heat went from ${c.from} to ${c.to}` : `fan went from ${fanWord(c.from)} to ${fanWord(c.to)}`;
    const d = t - c.t;
    return d === 0 ? `at the same second as ${what}` : `${secs(d)} after ${what}`;
  });
  return ` That was ${parts.join(' and ')}.`;
}

// Runs of consecutive seconds in [from, to] where cond(t) holds, as { start, end } (end inclusive).
// Runs with end - start < minLen are dropped; runs closer than mergeGap are joined.
function findRuns(cond, from, to, minLen, mergeGap = 0) {
  const runs = [];
  let start = -1;
  let last = -1;
  const close = () => {
    if (start >= 0 && last - start >= minLen) runs.push({ start, end: last });
    start = -1;
  };
  for (let t = from; t <= to; t++) {
    if (cond(t)) {
      if (start < 0) start = t;
      last = t;
    } else close();
  }
  close();
  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && r.start - prev.end <= mergeGap) prev.end = r.end;
    else merged.push({ ...r });
  }
  return merged;
}

function shapeItem(roast, readings, S, totalSec, fcT, units) {
  const span = readings.slice(0, totalSec + 1);
  const sorry = (why) => item('rorShape', 'info', `There aren't enough readings to judge the rate-of-rise shape (${why}).`);
  if (roast.reader && roast.reader.source === 'manual') return sorry('readings were typed by hand');
  if (totalSec < MIN_SHAPE_SEC) return sorry(`the roast is shorter than ${formatClock(MIN_SHAPE_SEC)}`);
  const gaps = span.filter((v) => v === null).length;
  if (span.length === 0 || gaps / span.length > MAX_GAP_FRACTION) {
    return sorry(`${Math.round((gaps / Math.max(1, span.length)) * 100)}% of seconds have no reading`);
  }
  const { ror } = analyzeSeries(span, S.smoothSec, S.rorWindowSec);
  const end = span.length - 1;

  let peak = null;
  let peakT = null;
  let endRor = null;
  for (let t = 0; t <= end; t++) {
    if (ror[t] === null) continue;
    if (peak === null || ror[t] > peak) { peak = ror[t]; peakT = t; }
    endRor = ror[t];
  }
  if (peak === null) return sorry('no rate of rise could be worked out');

  const changes = controlChanges(roast.controls);
  const rate = (v) => formatRate(v, units, { sign: false });
  const found = []; // { t, rank, text }
  const phase = (t) => (fcT === null ? '' : t >= fcT ? 'after first crack' : 'before first crack');

  // Stall: below the stall rate for persistSec, before First crack (or before Drop).
  const stallLimit = fcT !== null ? Math.min(fcT, end + 1) : end + 1;
  const stalls = findRuns((t) => ror[t] !== null && ror[t] < S.stallRorFPerMin, 0, stallLimit - 1, S.persistSec, MERGE_SEC);
  for (const r of stalls) {
    found.push({
      t: r.start,
      rank: RANK.off,
      text: `At ${formatClock(r.start)} the rate of rise fell under ${rate(S.stallRorFPerMin)} and stayed there for ${secs(r.end - r.start)}${fcT === null ? '' : ', before first crack'}.${attribution(changes, r.start)}`,
    });
  }

  // Climb: after the peak and climbAfterSec, rising climbRorFPerMin above the low of the lookback.
  const riseAt = (t) => {
    if (ror[t] === null) return null;
    let low = ror[t];
    for (let i = Math.max(0, t - S.climbLookbackSec); i < t; i++) if (ror[i] !== null && ror[i] < low) low = ror[i];
    return ror[t] - low;
  };
  const climbFrom = Math.max(S.climbAfterSec, peakT + 1);
  const rises = [];
  for (let t = 0; t <= end; t++) rises[t] = t >= climbFrom ? riseAt(t) : null;
  const climbs = findRuns((t) => rises[t] !== null && rises[t] >= S.climbRorFPerMin, climbFrom, end, S.persistSec, MERGE_SEC);
  for (const r of climbs) {
    let rise = 0;
    for (let t = r.start; t <= r.end; t++) if (rises[t] !== null && rises[t] > rise) rise = rises[t];
    const where = phase(r.start);
    const flick = where === 'after first crack' ? ' (a flick)' : '';
    found.push({
      t: r.start,
      rank: rise < CLIMB_CLOSE_FACTOR * S.climbRorFPerMin ? RANK.close : RANK.off,
      text: `At ${formatClock(r.start)} the rate of rise began climbing, up to ${rate(rise)} above its recent low${where ? `, ${where}${flick}` : ''}.${attribution(changes, r.start)}`,
    });
  }

  // Crash: a fall of more than CRASH_FRACTION and CRASH_MIN_FALL over CRASH_SPAN_SEC, from
  // CRASH_LEAD_SEC before First crack to Drop. Needs First crack to anchor the span.
  if (fcT !== null) {
    const fall = (t) => {
      const p = ror[t - CRASH_SPAN_SEC];
      const r = ror[t];
      if (p == null || r === null || !(p > 0)) return null;
      const d = p - r;
      return d > CRASH_FRACTION * p && d > CRASH_MIN_FALL ? { p, r } : null;
    };
    const crashes = findRuns((t) => fall(t) !== null, Math.max(CRASH_SPAN_SEC, fcT - CRASH_LEAD_SEC), end, 0, MERGE_SEC);
    for (const r of crashes) {
      const f = fall(r.start);
      found.push({
        t: r.start,
        rank: RANK.close,
        text: `At ${formatClock(r.start)} the rate of rise had fallen from ${rate(f.p)} to ${rate(f.r)} in ${CRASH_SPAN_SEC} s.${attribution(changes, r.start)}`,
      });
    }
  }

  if (!found.length) {
    return item('rorShape', 'good', `Rate of rise fell steadily from its peak of ${rate(peak)} at ${formatClock(peakT)} to ${rate(endRor)} at the drop.`, { t: peakT });
  }
  found.sort((a, b) => a.t - b.t);
  const worst = Math.max(...found.map((f) => f.rank));
  return item('rorShape', worst === RANK.off ? 'off' : 'close', found.map((f) => f.text).join(' '), { t: found[0].t });
}

// ---- 7: against the reference roast ----

function referenceItem(roast, readings, reference, S, totalSec, fcT, devSec, units) {
  if (!reference || reference === roast) return null;
  if (reference.id != null && reference.id === roast.id) return null;
  const refReadings = cleanReadings(reference.readings);
  const refDrop = reference.events && reference.events.drop;
  const refTotal = refDrop && isNum(refDrop.t) ? refDrop.t : Math.max(0, refReadings.length - 1);
  const last = Math.min(totalSec, refTotal, readings.length - 1, refReadings.length - 1);
  if (last < REFERENCE_FROM_SEC) return null;
  const mine = smoothSeries(readings, S.smoothSec);
  const theirs = smoothSeries(refReadings, S.smoothSec);
  let bestAbs = -1;
  let best = 0;
  let bestT = null;
  for (let t = REFERENCE_FROM_SEC; t <= last; t++) {
    if (mine[t] == null || theirs[t] == null) continue;
    const gap = mine[t] - theirs[t];
    if (Math.abs(gap) > bestAbs + 1e-9) { bestAbs = Math.abs(gap); best = gap; bestT = t; }
  }
  if (bestT === null) return null;
  const band = S.referenceBandF;
  const status = bestAbs < band ? 'good' : bestAbs <= 2 * band ? 'close' : 'off';
  const size = formatDelta(bestAbs, units);
  const flat = Number.parseFloat(size) === 0;
  let text = flat
    ? `Biggest gap from the reference: ${size}.`
    : `Biggest gap from the reference: ${size} ${best < 0 ? 'below' : 'above'} at ${formatClock(bestT)}.`;

  const refFc = reference.events && reference.events.firstCrack;
  const refFcT = refFc && isNum(refFc.t) ? refFc.t : null;
  const refDev = refFcT !== null ? refTotal - refFcT : null;
  const parts = [];
  if (fcT !== null && refFcT !== null) {
    const d = fcT - refFcT;
    parts.push(d === 0 ? 'First crack at the same time as the reference' : `First crack ${secs(Math.abs(d))} ${d > 0 ? 'later' : 'earlier'} than the reference`);
  }
  if (devSec !== null && refDev !== null) {
    const d = devSec - refDev;
    parts.push(d === 0 ? 'development the same length' : `development ${secs(Math.abs(d))} ${d > 0 ? 'longer' : 'shorter'}`);
  }
  if (parts.length) text += ` ${upFirst(parts.join('; '))}.`;
  return item('reference', status, text, { t: bestT });
}

// ---- 8, 9: facts ----

function readerItem(roast, readings) {
  const rd = roast.reader;
  if (!rd || rd.source === 'manual') return null;
  const total = readings.length;
  const missing = isNum(rd.secondsMissing) ? rd.secondsMissing : readings.filter((v) => v === null).length;
  const rejected = isNum(rd.rejected) ? rd.rejected : 0;
  const manyMissing = total > 0 && missing / total > READER_NOTABLE_FRACTION;
  if (!manyMissing && rejected <= 0) return null;
  const parts = [];
  if (manyMissing) parts.push(`missed ${missing} of ${total} seconds`);
  if (rejected > 0) parts.push(`rejected ${rejected} ${rejected === 1 ? 'value' : 'values'}`);
  return item('reader', 'info', `The reader ${parts.join(' and ')}; treat the rate of rise with care.`);
}

function cuesItem(roast) {
  const list = (Array.isArray(roast.cues) ? roast.cues : [])
    .filter((c) => c && CUE_NAMES[c.id] && isNum(c.t))
    .sort((a, b) => a.t - b.t);
  if (!list.length) return null;
  return item('cues', 'info', `Cues during the roast: ${list.map((c) => `${CUE_NAMES[c.id]} ${formatClock(c.t)}`).join(', ')}.`);
}

// ---- Headline ----

function headlineFor(items) {
  const judged = items.filter((i) => i.status !== 'info');
  const n = judged.length;
  if (n === 0) return 'Not enough data to judge this roast.';
  const good = judged.filter((i) => i.status === 'good').length;
  const noun = (k) => (k === 1 ? 'check' : 'checks');
  if (good === n) return n === 1 ? 'On target: the 1 check passed.' : `On target: all ${n} checks passed.`;
  const names = (s) => judged.filter((i) => i.status === s).map((i) => i.title.toLowerCase()).join(', ');
  let out = `${good} of ${n} ${noun(n)} on target.`;
  const off = names('off');
  const close = names('close');
  if (off) out += ` Off target: ${off}.`;
  if (close) out += ` Close: ${close}.`;
  return out;
}

export function reviewRoast(roast, { reference = null, units = 'F', settings = null } = {}) {
  const rec = roast && typeof roast === 'object' ? roast : {};
  const u = units === 'C' ? 'C' : 'F';
  const S = resolveSettings(rec, settings);
  const readings = cleanReadings(rec.readings);
  const ev = rec.events || {};
  const dropT = ev.drop && isNum(ev.drop.t) ? ev.drop.t : null;
  const totalSec = dropT !== null ? dropT
    : rec.results && isNum(rec.results.totalSec) ? rec.results.totalSec
      : Math.max(0, readings.length - 1);
  const fcT = ev.firstCrack && isNum(ev.firstCrack.t) && ev.firstCrack.t <= totalSec ? ev.firstCrack.t : null;
  const devSec = fcT !== null ? totalSec - fcT : null;

  const items = [];
  const add = (it) => { if (it) items.push(it); };

  add(weightLossItem(rec, S));
  add(firstCrackItem(fcT, S));
  if (fcT !== null) add(developmentItem(devSec, totalSec, S));
  add(totalTimeItem(totalSec, S));
  if (fcT !== null) add(endTempItem(ev.firstCrack.f, ev.drop && ev.drop.f, S, u));
  add(shapeItem(rec, readings, S, totalSec, fcT, u));
  add(referenceItem(rec, readings, reference, S, totalSec, fcT, devSec, u));
  add(readerItem(rec, readings));
  add(cuesItem(rec));

  const counts = { good: 0, close: 0, off: 0 };
  for (const i of items) if (i.status in counts) counts[i.status]++;
  return { headline: headlineFor(items), counts, items };
}
