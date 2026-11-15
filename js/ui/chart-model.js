// Builders for the plain-data model that chart.js draws. The chart itself never touches a
// session, so the live Roast screen, the After screen and the History detail all feed it
// the same shape:
//
//   { units, smooth[], ror[], events{yellow,firstCrack,drop}, controls[], cues[],
//     reference: { smooth[], label } | null, endT, live, fit, bridgeSec }

import { analyzeSeries } from '../core/calc.js';

// Typed readings are sparse; bridge up to this many seconds between them so the curve is a line.
export const MANUAL_BRIDGE_SEC = 30;

export function referenceFromRecord(record, settings = {}) {
  if (!record || !record.readings) return null;
  const { smooth } = analyzeSeries(record.readings, settings.smoothSec ?? 10, settings.rorWindowSec ?? 30);
  return { smooth, label: 'Reference', id: record.id ?? null };
}

// Live model: arrays are the session's own (read only).
export function modelFromSnapshot(snap, { units = 'F', cues = [], reference = null, sourceKind = null } = {}) {
  return {
    units,
    smooth: snap.smooth,
    ror: snap.ror,
    events: snap.events,
    controls: snap.controls,
    cues,
    reference,
    endT: snap.t,
    live: true,
    fit: false,
    bridgeSec: sourceKind === 'manual' ? MANUAL_BRIDGE_SEC : 0,
  };
}

// Saved roast model (After screen, History detail).
export function modelFromRecord(record, { units = 'F', reference = null } = {}) {
  const s = record.settings || {};
  const { smooth, ror } = analyzeSeries(record.readings || [], s.smoothSec ?? 10, s.rorWindowSec ?? 30);
  return {
    units,
    smooth,
    ror,
    events: record.events || { yellow: null, firstCrack: null, drop: null },
    controls: record.controls || [],
    cues: record.cues || [],
    reference,
    endT: record.results?.totalSec ?? Math.max(0, (record.readings || []).length - 1),
    live: false,
    fit: true,
    bridgeSec: record.reader?.source === 'manual' ? MANUAL_BRIDGE_SEC : 0,
  };
}
