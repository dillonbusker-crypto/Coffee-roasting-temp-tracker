import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulatorSource, PRESETS } from '../../js/sources/simulator-source.js';
import { analyzeSeries } from '../../js/core/calc.js';

function curve(preset, { seconds = 520, ...opts } = {}) {
  const src = createSimulatorSource({ preset, ...opts });
  return Array.from({ length: seconds + 1 }, (_, t) => src.sample(t));
}
const firstAtOrAbove = (raw, f) => raw.findIndex((v) => v != null && v >= f);

test('presets are listed with labels for a picker', () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ['on-target', 'fast', 'slow', 'stall', 'ror-climb', 'dropout']);
  assert.ok(PRESETS.every((p) => p.label && p.description));
  assert.throws(() => createSimulatorSource({ preset: 'nope' }));
});

test('output is whole degrees, starts near room temperature, and is reproducible by seed', () => {
  const a = curve('on-target', { seed: 7 });
  const b = curve('on-target', { seed: 7 });
  const c = curve('on-target', { seed: 8 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.every((v) => Number.isInteger(v)));
  assert.ok(Math.abs(a[0] - 75) <= 2);
  // sample(t) is repeatable
  const src = createSimulatorSource({ seed: 7 });
  assert.equal(src.sample(5), src.sample(5));
});

test('on-target reaches 410 F at about 5:15 with a steadily falling rate of rise', () => {
  const raw = curve('on-target');
  const t = firstAtOrAbove(raw, 410);
  assert.ok(t >= 310 && t <= 320, `crossed at ${t}`);
  const { ror } = analyzeSeries(raw);
  for (let s = 60; s <= 300; s += 20) assert.ok(ror[s + 20] < ror[s], `ror falls ${s}`);
  assert.ok(ror[310] > 10, 'still above a stall at first crack');
});

test('fast about 3:30, slow about 7:45', () => {
  const fast = firstAtOrAbove(curve('fast'), 410);
  const slow = firstAtOrAbove(curve('slow'), 410);
  assert.ok(fast >= 205 && fast <= 215, `fast ${fast}`);
  assert.ok(slow >= 460 && slow <= 470, `slow ${slow}`);
});

test('stall: rate of rise under 5 F/min around 3:00-3:30, until heat is raised', () => {
  const raw = curve('stall', { seconds: 400 });
  const { ror } = analyzeSeries(raw);
  const low = ror.findIndex((v, t) => t > 120 && v != null && v < 5);
  assert.ok(low >= 170 && low <= 215, `ror under 5 from ${low}`);
  for (let t = low; t <= 330; t++) assert.ok(ror[t] < 8, `still flat at ${t}`);
  assert.equal(firstAtOrAbove(raw, 410), -1, 'never reaches first crack on its own');

  // Raising the heat brings it back.
  const src = createSimulatorSource({ preset: 'stall' });
  const out = [];
  for (let t = 0; t <= 330; t++) {
    if (t === 220) src.setControl('heat', 3);
    out.push(src.sample(t));
  }
  const after = analyzeSeries(out).ror;
  assert.ok(after[320] > 8, `ror after raising heat ${after[320]}`);
});

test('ror-climb: rate of rise turns upward by more than 5 F/min around 3:00-3:30', () => {
  const raw = curve('ror-climb', { seconds: 300 });
  const { ror } = analyzeSeries(raw);
  let best = 0;
  for (let t = 150; t <= 260; t++) {
    const low = Math.min(...ror.slice(t - 60, t + 1).filter((v) => v != null));
    best = Math.max(best, ror[t] - low);
  }
  assert.ok(best > 10, `ror rose ${best.toFixed(1)} above its recent low`);
  // the climb starts in the 3:00-3:30 window: the low sits there
  const lowAt = ror.indexOf(Math.min(...ror.slice(150, 240)));
  assert.ok(lowAt >= 170 && lowAt <= 235, `low at ${lowAt}`);
});

test('dropout: gaps at 2:00-2:12 and 3:30-3:38, otherwise on target', () => {
  const raw = curve('dropout');
  const nulls = raw.map((v, t) => (v == null ? t : -1)).filter((t) => t >= 0);
  assert.deepEqual(nulls, [...Array(12).keys()].map((i) => 120 + i).concat([...Array(8).keys()].map((i) => 210 + i)));
  const t = firstAtOrAbove(raw, 410);
  assert.ok(t >= 310 && t <= 320);
});

test('the model reacts to setControl: lowering heat slows the climb, raising it speeds it up', () => {
  const run = (heat) => {
    const src = createSimulatorSource({ preset: 'on-target', noise: 0 });
    return Array.from({ length: 400 }, (_, t) => {
      if (t === 100) src.setControl('heat', heat);
      return src.sample(t);
    });
  };
  const base = run(2);
  assert.ok(run(3)[250] > base[250] + 10);
  assert.ok(run(1)[250] < base[250] - 10);
  const fanLow = createSimulatorSource({ preset: 'on-target', noise: 0 });
  const v = Array.from({ length: 300 }, (_, t) => { if (t === 100) fanLow.setControl('fan', 'low'); return fanLow.sample(t); });
  assert.ok(v[250] > base[250]);
});

test('replay plays back a saved roast, gaps included', () => {
  const src = createSimulatorSource({ replay: { readings: [75, 80, null, 90] } });
  assert.deepEqual([0, 1, 2, 3, 4].map((t) => src.sample(t)), [75, 80, null, 90, null]);
  assert.equal(src.preset, 'replay');
});

test('source contract: kind, start/stop, peek, health', async () => {
  const src = createSimulatorSource({ preset: 'dropout' });
  assert.equal(src.kind, 'simulator');
  assert.deepEqual(src.peek(), { value: 75, status: 'ok' });
  await src.start();
  for (let t = 0; t <= 125; t++) src.sample(t);
  assert.deepEqual(src.peek(), { value: null, status: 'none' });     // inside the first gap
  src.stop();
  assert.deepEqual(src.health(), { secondsRead: 120, rejected: 0, secondsMissing: 6 });
  await src.start();                                                  // start resets the run
  assert.equal(src.sample(0) <= 80, true);
  assert.deepEqual(src.health(), { secondsRead: 1, rejected: 0, secondsMissing: 0 });
});
