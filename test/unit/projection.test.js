// Accuracy of the projected first-crack time on the on-target curve, evaluated at
// 2:30, 3:00, 3:30 and 4:00 against the actual crossing. Target: within 30 s.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulatorSource } from '../../js/sources/simulator-source.js';
import { createSession } from '../../js/core/session.js';
import { projectedFirstCrack } from '../../js/core/cues.js';
import { DEFAULTS } from '../../js/core/settings.js';
import { projectFirstCrack, smoothSeries, rorSeries } from '../../js/core/calc.js';

const TIMES = [150, 180, 210, 240];
const TARGET = DEFAULTS.expectedFcF;
const crossing = (series, f = TARGET) => series.findIndex((v) => v != null && v >= f);

// Through a real session, the way the app computes it.
function projectionsFor(raw) {
  const session = createSession();
  const out = {};
  raw.forEach((v, t) => {
    session.addReading(v);
    if (TIMES.includes(t)) out[t] = projectedFirstCrack(session.snapshot(), DEFAULTS);
  });
  return { out, smooth: session.snapshot().smooth };
}

test('noiseless curve (no rounding): projection is within 30 s at every checkpoint', (t) => {
  const E = (TARGET - 75) / (1 - Math.exp(-315 / 150));
  const raw = Array.from({ length: 400 }, (_, s) => 75 + E * (1 - Math.exp(-s / 150)));
  const smooth = smoothSeries(raw);
  const ror = rorSeries(smooth);
  const actual = crossing(smooth);       // the smoothed series is what the projection targets
  const rows = [];
  for (const at of TIMES) {
    const p = projectFirstCrack({ t: at, temp: smooth[at], ror: ror[at], rorEarlier: ror[at - 45], lagSec: 45, rorLagSec: 14.5, targetF: TARGET });
    rows.push(`${at}s: ${p.toFixed(1)} (error ${(p - actual).toFixed(1)} s)`);
    assert.ok(Math.abs(p - actual) <= 30, `${at}s projected ${p}, actual ${actual}`);
  }
  t.diagnostic(`noiseless, actual crossing ${actual} s: ${rows.join('; ')}`);
});

test('rounded on-target simulator curve: projection is within 30 s at every checkpoint', (t) => {
  const worst = { err: 0 };
  const lines = [];
  for (const noise of [0, 0.3]) {
    const errs = TIMES.map(() => []);
    for (let seed = 1; seed <= 20; seed++) {
      const src = createSimulatorSource({ preset: 'on-target', seed, noise });
      const raw = Array.from({ length: 400 }, (_, s) => src.sample(s));
      const { out, smooth } = projectionsFor(raw);
      const actualRaw = crossing(raw);
      const actualSmooth = crossing(smooth);
      TIMES.forEach((at, i) => {
        const err = out[at] - actualSmooth;
        errs[i].push(err);
        assert.ok(Number.isFinite(out[at]), `no projection at ${at}`);
        assert.ok(Math.abs(err) <= 30, `noise ${noise} seed ${seed} at ${at}s: projected ${out[at].toFixed(1)}, smoothed crossing ${actualSmooth}`);
        assert.ok(Math.abs(out[at] - actualRaw) <= 30, `against the raw crossing ${actualRaw}`);
        worst.err = Math.max(worst.err, Math.abs(err));
      });
    }
    lines.push(`noise ${noise}: ` + TIMES.map((at, i) => {
      const e = errs[i];
      return `${at}s mean ${(e.reduce((a, b) => a + b, 0) / e.length).toFixed(1)} range ${Math.min(...e).toFixed(1)}..${Math.max(...e).toFixed(1)}`;
    }).join('; '));
  }
  t.diagnostic(`rounded sim, 20 seeds each, error vs smoothed crossing (s): ${lines.join(' | ')}; worst ${worst.err.toFixed(1)} s`);
});

test('projection is not fooled into "hot" or "slow" on the on-target curve at any second from 2:30', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const src = createSimulatorSource({ preset: 'on-target', seed });
    const session = createSession();
    for (let s = 0; s <= 300; s++) {
      session.addReading(src.sample(s));
      if (s >= 150) {
        const p = projectedFirstCrack(session.snapshot(), DEFAULTS);
        assert.ok(p > 240 && p < 420, `seed ${seed} t=${s}: projected ${p}`);
      }
    }
  }
});
