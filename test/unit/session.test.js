import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../../js/core/session.js';
import { DEFAULTS } from '../../js/core/settings.js';
import { smoothAt } from '../../js/core/calc.js';

const line = (t) => 100 + 0.5 * t;   // 30 F/min

function feed(session, from, to, fn = line) {
  for (let t = from; t <= to; t++) session.addReading(fn(t));
}

test('readings are logged one per second with smoothed temp and rate of rise', () => {
  const s = createSession({ coffee: 'Test' });
  feed(s, 0, 60);
  const snap = s.snapshot();
  assert.equal(snap.t, 60);
  assert.equal(snap.raw.length, 61);
  assert.equal(snap.smooth.length, 61);
  assert.equal(snap.ror.length, 61);
  assert.equal(snap.raw[10], 105);
  assert.equal(snap.smooth[10], smoothAt(snap.raw, 10));
  assert.equal(snap.ror[29], null);                     // nothing for the first 30 s
  assert.ok(Math.abs(snap.ror[60] - 30) < 1e-9);
  assert.equal(snap.temp, snap.smooth[60]);
  assert.equal(snap.rorNow, snap.ror[60]);
  assert.equal(snap.secondsSinceReading, 0);
});

test('gaps are stored as null and the display holds the last value', () => {
  const s = createSession();
  feed(s, 0, 40);
  const held = s.snapshot().temp;
  s.addReading(null);
  s.addReading(NaN);
  const snap = s.snapshot();
  assert.equal(snap.raw[41], null);
  assert.equal(snap.raw[42], null);
  assert.equal(snap.smooth[41], null);
  assert.equal(snap.ror[42], null);
  assert.equal(snap.temp, held);
  assert.equal(snap.secondsSinceReading, 2);
  s.addReading(121);
  assert.equal(s.snapshot().secondsSinceReading, 0);
});

test('secondsSinceReading counts from Start when nothing has been read', () => {
  const s = createSession();
  s.addReading(null);
  s.addReading(null);
  assert.equal(s.snapshot().secondsSinceReading, 2);
  assert.equal(s.snapshot().temp, null);
});

test('mark stamps the second and the smoothed temperature; unmark undoes it', () => {
  const s = createSession();
  feed(s, 0, 100);
  const e = s.mark('firstCrack');
  assert.equal(e.t, 100);
  assert.ok(Math.abs(e.f - Math.round(smoothAt(s.snapshot().raw, 100) * 10) / 10) < 1e-9);
  assert.deepEqual(s.snapshot().events.firstCrack, e);
  s.unmark('firstCrack');
  assert.equal(s.snapshot().events.firstCrack, null);
  assert.throws(() => s.mark('nope'), RangeError);
});

test('an event during a gap takes the latest known smoothed temperature', () => {
  const s = createSession();
  feed(s, 0, 50);
  const before = s.snapshot().smooth[50];
  feed(s, 51, 58, () => null);
  const e = s.mark('yellow');
  assert.equal(e.t, 58);
  assert.ok(Math.abs(e.f - before) < 0.06);
});

test('setControl logs heat and fan changes, ignores repeats, validates, and drives the source', () => {
  const calls = [];
  const source = { kind: 'simulator', setControl: (k, v) => calls.push([k, v]), health: () => ({ rejected: 3 }) };
  const s = createSession({ heat: 2, fan: 'high', source });
  assert.deepEqual(calls, [['heat', 2], ['fan', 'high']]);   // source starts in sync
  feed(s, 0, 20);
  assert.deepEqual(s.setControl('heat', 3), { t: 20, kind: 'heat', value: 3 });
  assert.equal(s.setControl('heat', 3), null);
  feed(s, 21, 30);
  s.setControl('fan', 'low');
  const snap = s.snapshot();
  assert.deepEqual(snap.controls, [
    { t: 0, kind: 'heat', value: 2 },
    { t: 0, kind: 'fan', value: 'high' },
    { t: 20, kind: 'heat', value: 3 },
    { t: 30, kind: 'fan', value: 'low' },
  ]);
  assert.equal(snap.heat, 3);
  assert.equal(snap.fan, 'low');
  assert.equal(snap.lastControlT, 30);
  assert.deepEqual(calls.slice(2), [['heat', 3], ['fan', 'low']]);
  assert.throws(() => s.setControl('heat', 8), RangeError);
  assert.throws(() => s.setControl('heat', 0), RangeError);
  assert.throws(() => s.setControl('fan', 'medium'), RangeError);
  assert.throws(() => s.setControl('color', 1), RangeError);
});

test('development time and percentage appear after First crack', () => {
  const s = createSession();
  feed(s, 0, 300);
  assert.equal(s.snapshot().devSec, null);
  assert.equal(s.snapshot().devPct, null);
  s.mark('firstCrack');
  feed(s, 301, 330);
  const snap = s.snapshot();
  assert.equal(snap.devSec, 30);
  assert.ok(Math.abs(snap.devPct - (30 / 330) * 100) < 1e-9);
});

test('mode, expected first-crack reading and development target', () => {
  const settings = { ...DEFAULTS, expectedFcF: 410, devTargetSec: 55 };
  const starter = createSession({ settings }).snapshot();
  assert.equal(starter.mode, 'starter');
  assert.equal(starter.expectedFcF, 410);
  assert.equal(starter.devTargetSec, 55);

  const reference = {
    id: 'ref1',
    events: { yellow: null, firstCrack: { t: 320, f: 402.5 }, drop: { t: 380, f: 421 } },
    results: { devSec: 60 },
  };
  const ref = createSession({ settings, mode: 'reference', reference }).snapshot();
  assert.equal(ref.mode, 'reference');
  assert.equal(ref.expectedFcF, 402.5);
  assert.equal(ref.devTargetSec, 60);

  // a reference with no First crack falls back to the settings
  const bare = createSession({ settings, mode: 'reference', reference: { id: 'x', events: {} } }).snapshot();
  assert.equal(bare.expectedFcF, 410);
  assert.equal(bare.devTargetSec, 55);

  // Reference mode without a reference roast is Starter mode
  assert.equal(createSession({ settings, mode: 'reference' }).snapshot().mode, 'starter');
});

test('finish truncates readings at Drop and computes results', () => {
  const s = createSession({ coffee: 'Ethiopia', greenWeightG: 90, heat: 2, fan: 'high', startedAt: '2026-11-14T10:00:00.000Z', id: 'r1' });
  feed(s, 0, 120);
  s.mark('yellow');
  feed(s, 121, 300);
  s.mark('firstCrack');
  s.setControl('heat', 3);
  s.logCue({ t: 300, id: 'fcSoon', text: 'First crack soon.', kind: 'info' });
  feed(s, 301, 355);
  const drop = s.mark('drop');
  assert.equal(drop.t, 355);
  // The UI keeps the clock running during the 5 s Undo window, then finishes.
  feed(s, 356, 360);
  s.setControl('heat', 1);
  s.logCue({ t: 359, id: 'late', text: 'late', kind: 'info' });
  const r = s.finish({ dropT: 355 });

  assert.equal(r.id, 'r1');
  assert.equal(r.schema, 1);
  assert.equal(r.coffee, 'Ethiopia');
  assert.equal(r.startedAt, '2026-11-14T10:00:00.000Z');
  assert.equal(r.readings.length, 356);
  assert.equal(r.readings[355], line(355));
  assert.deepEqual(r.events.drop, drop);
  assert.deepEqual(r.controls.map((c) => [c.t, c.kind, c.value]), [[0, 'heat', 2], [0, 'fan', 'high'], [300, 'heat', 3]]);
  assert.deepEqual(r.cues.map((c) => c.id), ['fcSoon']);
  assert.equal(r.results.totalSec, 355);
  assert.equal(r.results.devSec, 55);
  assert.ok(Math.abs(r.results.devPct - (55 / 355) * 100) < 1e-9);
  assert.equal(r.results.phases.drying.sec, 120);
  assert.equal(r.results.phases.browning.sec, 180);
  assert.equal(r.results.phases.development.sec, 55);
  const expectedAvg = ((r.events.drop.f - 100) / 355) * 60;
  assert.ok(Math.abs(r.results.avgRor - expectedAvg) < 1e-9);
  assert.equal(r.roastedWeightG, null);
  assert.equal(r.weightLossPct, null);
  assert.deepEqual(r.reference, { coffee: false, general: false });
  assert.equal(r.notes, '');
  assert.equal(r.score, null);
});

test('finish records settings in effect, reader health, and survives a JSON round-trip', () => {
  const source = { kind: 'simulator', setControl() {}, health: () => ({ secondsRead: 99, rejected: 4, secondsMissing: 99 }) };
  const reference = { id: 'ref9', events: { firstCrack: { t: 300, f: 405 }, drop: { t: 350, f: 415 } }, results: { devSec: 50 } };
  const s = createSession({ settings: { ...DEFAULTS, rorWindowSec: 45 }, mode: 'reference', reference, source });
  feed(s, 0, 20);
  s.addReading(null);
  feed(s, 22, 40);
  const r = s.finish({ dropT: 40 });
  assert.equal(r.settings.mode, 'reference');
  assert.equal(r.settings.referenceId, 'ref9');
  assert.equal(r.settings.rorWindowSec, 45);
  assert.equal(r.settings.expectedFcF, 405);
  assert.equal(r.settings.devTargetSec, 50);
  assert.equal(r.settings.paceLateSec, 420);
  assert.deepEqual(r.reader, { source: 'simulator', secondsRead: 40, rejected: 4, secondsMissing: 1 });
  assert.equal(r.events.drop.t, 40);                           // no Drop was tapped: finish stamps one
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('finish with no drop time ends at the last second', () => {
  const s = createSession();
  feed(s, 0, 50);
  const r = s.finish();
  assert.equal(r.readings.length, 51);
  assert.equal(r.results.totalSec, 50);
});
