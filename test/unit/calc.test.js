import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  smoothAt, rorAt, smoothSeries, rorSeries, trustedSmoothAt, analyzeSeries,
  projectFirstCrack, phaseSummary, weightLossPct, developmentPct, averageRor, summarize,
} from '../../js/core/calc.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} +/- ${tol}, got ${a}`);

test('smoothAt: mean of the last 10 seconds, skipping gaps', () => {
  const raw = [100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122];
  assert.equal(smoothAt(raw, 0), 100);
  assert.equal(smoothAt(raw, 1), 101);                       // fewer than 10 points yet
  assert.equal(smoothAt(raw, 11), (104 + 122) / 2);          // indices 2..11
  const gappy = [100, null, null, 106, null, 110];
  assert.equal(smoothAt(gappy, 5), (100 + 106 + 110) / 3);   // nulls are not counted as zero
  assert.equal(smoothAt([null, null, null], 2), null);
  assert.equal(smoothAt([100, null, null, null, null, null, null, null, null, null, null, null], 11, 10), null); // 10 s window is empty
});

test('smoothSeries keeps gaps as gaps', () => {
  const out = smoothSeries([100, null, 104]);
  assert.deepEqual(out, [100, null, 102]);
});

test('rorAt: equals the known slope on a straight line, null before the window', () => {
  const raw = Array.from({ length: 120 }, (_, t) => 100 + 0.5 * t);   // 30 F/min
  const smooth = smoothSeries(raw);
  for (let t = 0; t < 30; t++) assert.equal(rorAt(smooth, t), null, `t=${t}`);
  // After the first 10 s the smoothed line is the raw line shifted, so the slope is exact.
  for (const t of [45, 60, 90, 119]) close(rorAt(smooth, t), 30, 1e-9, `t=${t}`);
  // Window options
  close(rorAt(smooth, 60, 15), 30, 1e-9);
  close(rorAt(smooth, 60, 45), 30, 1e-9);
  assert.equal(rorAt(smooth, 14, 15), null);
  assert.notEqual(rorAt(smooth, 15, 15), null);
});

test('rorAt: null when fewer than half the window has data, correct with a few holes', () => {
  const smooth = Array.from({ length: 100 }, (_, t) => 100 + 0.5 * t);
  const holes = smooth.map((v, t) => (t % 3 === 0 ? null : v));   // a third missing
  close(rorAt(holes, 80), 30, 1e-9);
  const mostlyMissing = smooth.map((v, t) => (t > 60 && t < 78 ? null : v));
  assert.equal(rorAt(mostlyMissing, 80), null);                     // 18 of 30 missing
});

// The thermometer shows whole degrees, so rate of rise has to work from rounded input.
test('rorAt: close to the true slope on a whole-degree-rounded exponential', () => {
  const T = (t) => 75 + 382 * (1 - Math.exp(-t / 150));
  const dT = (t) => ((382 / 150) * Math.exp(-t / 150)) * 60;
  const raw = Array.from({ length: 400 }, (_, t) => Math.round(T(t)));
  const { ror } = analyzeSeries(raw);
  let worst = 0;
  for (let t = 40; t < 400; t++) {
    // smoothing lags 4.5 s and the fit window centre lags 14.5 s
    worst = Math.max(worst, Math.abs(ror[t] - dT(t - 19)));
  }
  assert.ok(worst < 2.5, `worst error ${worst.toFixed(2)} F/min`);
});

test('a dropout does not bend the rate of rise: seconds with a mostly empty window are skipped', () => {
  const raw = Array.from({ length: 200 }, (_, t) => Math.round(100 + 0.8 * t));   // 48 F/min
  for (let t = 100; t < 112; t++) raw[t] = null;
  assert.equal(trustedSmoothAt(raw, 112), null);          // 1 reading in the window
  assert.notEqual(trustedSmoothAt(raw, 125), null);
  const { ror } = analyzeSeries(raw);
  for (let t = 150; t < 200; t++) close(ror[t], 48, 1.5, `t=${t}`);
  assert.equal(ror[105], null);                           // no reading, no rate
});

test('projectFirstCrack: straight line when the rate is flat or rising', () => {
  // 300 F now, +30 F/min: 110 F to go is 220 s.
  assert.equal(projectFirstCrack({ t: 100, temp: 300, ror: 30, rorEarlier: 30, targetF: 410 }), 320);
  assert.equal(projectFirstCrack({ t: 100, temp: 300, ror: 30, rorEarlier: 20, targetF: 410 }), 320);
  assert.equal(projectFirstCrack({ t: 100, temp: 300, ror: 30, rorEarlier: null, targetF: 410 }), 320);
});

test('projectFirstCrack: decay-aware when the rate is falling', () => {
  // Exact exponential: T = 75 + 382 (1 - exp(-t/150)).
  const tau = 150;
  const T = (t) => 75 + 382 * (1 - Math.exp(-t / tau));
  const rate = (t) => ((382 / tau) * Math.exp(-t / tau)) * 60;
  const t = 180;
  const p = projectFirstCrack({ t, temp: T(t), ror: rate(t), rorEarlier: rate(t - 45), lagSec: 45, targetF: 410 });
  close(p, -tau * Math.log(1 - 335 / 382), 1e-6);   // the exact crossing, 314.3 s
  const straight = t + ((410 - T(t)) / rate(t)) * 60;
  assert.ok(straight < 275, `a straight line lands far too early: ${straight.toFixed(0)}`);
});

test('projectFirstCrack: Infinity when the asymptote is below the target, null when not computable', () => {
  const t = 200;
  // Rate halving every 45 s from 20 F/min: remaining rise is small, never reaches 410.
  assert.equal(projectFirstCrack({ t, temp: 380, ror: 10, rorEarlier: 20, lagSec: 45, targetF: 410 }), Infinity);
  assert.equal(projectFirstCrack({ t, temp: 380, ror: 0, rorEarlier: 20, targetF: 410 }), Infinity);
  assert.equal(projectFirstCrack({ t, temp: 380, ror: -4, rorEarlier: null, targetF: 410 }), Infinity);
  assert.equal(projectFirstCrack({ t, temp: 380, ror: null, rorEarlier: null, targetF: 410 }), null);
  assert.equal(projectFirstCrack({ t, temp: null, ror: 10, rorEarlier: null, targetF: 410 }), null);
  assert.equal(projectFirstCrack({ t, temp: 412, ror: 10, rorEarlier: 20, targetF: 410 }), t); // already there
});

test('phaseSummary with Yellow', () => {
  const p = phaseSummary({ yellow: { t: 120, f: 300 }, firstCrack: { t: 300, f: 410 }, drop: { t: 360, f: 420 } }, 360);
  assert.deepEqual(p.drying, { sec: 120, pct: (120 / 360) * 100 });
  assert.deepEqual(p.browning, { sec: 180, pct: 50 });
  assert.deepEqual(p.development, { sec: 60, pct: (60 / 360) * 100 });
});

test('phaseSummary without Yellow: drying is null and browning covers Start to First crack', () => {
  const p = phaseSummary({ yellow: null, firstCrack: { t: 300, f: 410 }, drop: { t: 355, f: 420 } }, 355);
  assert.equal(p.drying, null);
  assert.equal(p.browning.sec, 300);
  assert.equal(p.development.sec, 55);
  close(p.browning.pct + p.development.pct, 100, 1e-9);
});

test('phaseSummary with missing events', () => {
  const p = phaseSummary({ yellow: null, firstCrack: null, drop: { t: 200, f: 380 } }, 200);
  assert.equal(p.drying, null);
  assert.equal(p.browning, null);
  assert.equal(p.development, null);
  assert.deepEqual(phaseSummary({}, 0), { drying: null, browning: null, development: null });
});

test('weight loss and development percentage', () => {
  close(weightLossPct(90, 79.65), 11.5, 1e-9);
  assert.equal(weightLossPct(90, 90), 0);
  assert.equal(weightLossPct(90, null), null);
  assert.equal(weightLossPct(0, 80), null);
  close(developmentPct(55, 390), 14.1025641, 1e-6);
  assert.equal(developmentPct(null, 390), null);
  assert.equal(developmentPct(55, 0), null);
});

test('averageRor and summarize', () => {
  close(averageRor(75, 420, 360), 57.5, 1e-9);
  assert.equal(averageRor(null, 420, 360), null);
  const readings = [75, ...Array.from({ length: 360 }, (_, i) => 80 + i)];
  const r = summarize({
    readings,
    events: { yellow: null, firstCrack: { t: 300, f: 400 }, drop: { t: 360, f: 420 } },
  });
  assert.equal(r.totalSec, 360);
  assert.equal(r.devSec, 60);
  close(r.devPct, (60 / 360) * 100, 1e-9);
  close(r.avgRor, ((420 - 75) / 360) * 60, 1e-9);
  assert.equal(r.phases.drying, null);
});
