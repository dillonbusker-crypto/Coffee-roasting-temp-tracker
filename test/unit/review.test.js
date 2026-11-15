import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewRoast } from '../../js/core/review.js';
import { DEFAULTS } from '../../js/core/settings.js';
import { formatDelta, formatRate } from '../../js/core/units.js';
import { runRoast } from './harness.js';

// ---------- helpers ----------

const find = (rv, id) => rv.items.find((i) => i.id === id);
const ids = (rv) => rv.items.map((i) => i.id);

// A roast record from a simulator preset run through a real session. The default user marks
// First crack at the 410°F crossing and Drop when the 55 s countdown ends.
function presetRecord(preset, seed = 1, opts = {}) {
  const r = runRoast({ preset, seed, ...opts });
  const rec = r.session.finish();
  rec.roastedWeightG = 79.9;
  rec.weightLossPct = 11.22;
  return rec;
}

// A record built by hand. readings default to empty.
function make({
  readings = [], fc = null, drop = null, fcF = 410, dropF = 425, settings, controls, cues = [],
  source = 'simulator', rejected = 0, green = 90, roasted = null, id = 'r-test',
} = {}) {
  const secondsRead = readings.filter((v) => v != null).length;
  const rec = {
    id,
    schema: 1,
    coffee: 'Test',
    greenWeightG: green,
    roastedWeightG: roasted,
    readings,
    events: {
      yellow: null,
      firstCrack: fc === null ? null : { t: fc, f: fcF },
      drop: drop === null ? null : { t: drop, f: dropF },
    },
    controls: controls || [{ t: 0, kind: 'heat', value: 2 }, { t: 0, kind: 'fan', value: 'high' }],
    cues,
    reader: { source, secondsRead, rejected, secondsMissing: readings.length - secondsRead },
  };
  if (settings !== undefined) rec.settings = settings;
  return rec;
}

// Readings from a rate-of-rise profile: rateFn(t) is °F/min at second t. Whole degrees, like the TP17.
function curve(rateFn, total) {
  let T = 75;
  const out = [];
  for (let t = 0; t <= total; t++) {
    out.push(Math.round(T));
    T += rateFn(t) / 60;
  }
  return out;
}

const base = (t) => 220 * Math.exp(-t / 120) + 10;   // a normal falling curve, 33 °F/min at 4:30
const FC = 300;
const DROP = 355;

// ---------- thresholds that need no readings: items 1 to 5 ----------

test('weightLoss: inside the band is good, 0.5 points outside is close, beyond is off (exact boundaries)', () => {
  const at = (roasted) => find(reviewRoast(make({ green: 100, roasted })), 'weightLoss');
  assert.equal(at(89).status, 'good');          // 11.0
  assert.equal(at(88).status, 'good');          // 12.0
  assert.equal(at(88.8).status, 'good');        // 11.2
  assert.equal(at(87.5).status, 'close');       // 12.5
  assert.equal(at(87.4).status, 'off');         // 12.6
  assert.equal(at(89.5).status, 'close');       // 10.5
  assert.equal(at(89.6).status, 'off');         // 10.4
  assert.equal(at(88.8).text, 'Weight loss 11.2%, inside the 11–12% band.');
  assert.equal(at(86.9).text, 'Weight loss 13.1%, 1.1 points over the 11–12% band.');
  assert.equal(at(89.6).text, 'Weight loss 10.4%, 0.6 points under the 11–12% band.');
});

test('weightLoss: omitted without a roasted weight; follows the band in the settings', () => {
  assert.ok(!ids(reviewRoast(make({ green: 100, roasted: null }))).includes('weightLoss'));
  assert.ok(!ids(reviewRoast(make({ green: 100, roasted: 0 }))).includes('weightLoss'));
  const wide = reviewRoast(make({ green: 100, roasted: 85, settings: { weightLossMinPct: 14, weightLossMaxPct: 16 } }));
  assert.equal(find(wide, 'weightLoss').status, 'good');
  assert.match(find(wide, 'weightLoss').text, /14–16% band/);
});

test('firstCrack: inside the window good, inside the pace limits close, beyond off', () => {
  const at = (fc) => find(reviewRoast(make({ fc, drop: fc + 55 })), 'firstCrack');
  for (const t of [300, 315, 330]) assert.equal(at(t).status, 'good', `t ${t}`);
  for (const t of [299, 331, 240, 420]) assert.equal(at(t).status, 'close', `t ${t}`);
  for (const t of [239, 421]) assert.equal(at(t).status, 'off', `t ${t}`);
  assert.equal(at(275).text, 'First crack at 4:35, 25 s before the 5:00–5:30 window.');
  assert.equal(at(345).text, 'First crack at 5:45, 15 s after the 5:00–5:30 window.');
  assert.equal(at(315).text, 'First crack at 5:15, inside the 5:00–5:30 window.');
  assert.equal(at(200).text, 'First crack at 3:20, 100 s before the 5:00–5:30 window and outside the 4:00–7:00 pace limits.');
  assert.equal(at(275).t, 275);
});

test('development: within 5 s good, within 10 s close, beyond off; percentage and Rao shown but not judged', () => {
  const at = (dev) => find(reviewRoast(make({ fc: 300, drop: 300 + dev })), 'development');
  for (const d of [50, 55, 60]) assert.equal(at(d).status, 'good', `dev ${d}`);
  for (const d of [49, 45, 61, 65]) assert.equal(at(d).status, 'close', `dev ${d}`);
  for (const d of [44, 66]) assert.equal(at(d).status, 'off', `dev ${d}`);
  const it = find(reviewRoast(make({ fc: 300, drop: 349 })), 'development');
  assert.equal(it.text, "Development 0:49, 6 s short of the 55 s target. That is 14% of the roast; Rao's guideline is 20–25%.");
  assert.equal(at(55).text.startsWith('Development 0:55, on the 55 s target.'), true);
  assert.match(at(62).text, /7 s over the 55 s target/);
});

test('development: uses the target in effect for that roast (roast.settings, then the argument, then defaults)', () => {
  const rec = (settings) => make({ fc: 300, drop: 345, settings });   // 45 s
  assert.equal(find(reviewRoast(rec({ devTargetSec: 45 })), 'development').status, 'good');
  assert.equal(find(reviewRoast(rec({ devTargetSec: 65 })), 'development').status, 'off');
  // the roast's own value beats the argument; the argument beats the default
  assert.equal(find(reviewRoast(rec({ devTargetSec: 65 }), { settings: { devTargetSec: 45 } }), 'development').status, 'off');
  assert.equal(find(reviewRoast(rec(undefined), { settings: { devTargetSec: 45 } }), 'development').status, 'good');
  assert.equal(find(reviewRoast(rec(undefined)), 'development').status, 'close');   // default 55: 10 s short
});

test('totalTime: within 30 s good, within 60 s close, beyond off', () => {
  const at = (total) => find(reviewRoast(make({ fc: 300, drop: total })), 'totalTime');
  for (const t of [360, 390, 420]) assert.equal(at(t).status, 'good', `total ${t}`);
  for (const t of [359, 330, 421, 450]) assert.equal(at(t).status, 'close', `total ${t}`);
  for (const t of [329, 451]) assert.equal(at(t).status, 'off', `total ${t}`);
  assert.equal(at(370).text, 'Total time 6:10, 20 s short of the 6:30 target.');
  assert.equal(at(390).text, 'Total time 6:30, on the 6:30 target.');
});

test('endTemp: at the cap or up to 2°F over good, up to 5°F over close, beyond off', () => {
  const at = (dropF, fcF = 410, units = 'F') => find(reviewRoast(make({ fc: 300, drop: 355, fcF, dropF }), { units }), 'endTemp');
  for (const f of [400, 415, 424]) assert.equal(at(f).status, 'good', `rise ${f - 410}`);
  assert.equal(at(425).status, 'good');                // cap
  assert.equal(at(427).status, 'good');                // cap + 2
  assert.equal(at(428).status, 'close');               // cap + 3
  assert.equal(at(430).status, 'close');               // cap + 5
  assert.equal(at(431).status, 'off');                 // cap + 6
  assert.equal(at(450).status, 'off');
  assert.equal(at(424).text, 'Dropped 14°F above the first-crack reading, inside the 15°F cap.');
  assert.equal(at(425).text, 'Dropped 15°F above the first-crack reading, inside the 15°F cap.');
  assert.equal(at(426).text, 'Dropped 16°F above the first-crack reading, at the 15°F cap.');
  assert.equal(at(427).text, 'Dropped 17°F above the first-crack reading, at the 15°F cap.');
  assert.equal(at(443).text, 'Dropped 33°F above the first-crack reading; the cap is 15°F.');
  assert.equal(at(400).text, 'Dropped 10°F below the first-crack reading, inside the 15°F cap.');
  // The arithmetic uses the whole degrees the app shows: 408.4 and 423.6 are shown as 408 and 424, a rise of 16 (not 15.2).
  assert.equal(at(423.6, 408.4).text, 'Dropped 16°F above the first-crack reading, at the 15°F cap.');
  // and 409.6 / 424.4 show as 410 and 424, a rise of 14 (not 14.8 rounded to 15)
  assert.equal(at(424.4, 409.6).text, 'Dropped 14°F above the first-crack reading, inside the 15°F cap.');
});

test('endTemp in °C: the rise comes from the °C values shown, against limits converted and rounded as shown', () => {
  const at = (fcF, dropF) => find(reviewRoast(make({ fc: 300, drop: 355, fcF, dropF }), { units: 'C' }), 'endTemp');
  // 410°F = 210.0°C; 425°F = 218.3°C: rise 8 against a cap of 8
  assert.equal(at(410, 425).text, 'Dropped 8°C above the first-crack reading, inside the 8°C cap.');
  assert.equal(at(410, 425).status, 'good');
  assert.equal(at(410, 427).status, 'good');           // 219.4 - 210.0 = 9.4 -> 9, grace limit 9
  assert.match(at(410, 427).text, /at the 8°C cap\.$/);
  assert.equal(at(410, 430).status, 'close');          // 221.1 - 210 = 11.1 -> 11, close limit 11
  assert.equal(at(410, 431).status, 'off');            // 12
  assert.equal(at(410, 443).text, 'Dropped 18°C above the first-crack reading; the cap is 8°C.');
});

test('items 1 to 5 come in the fixed order, then shape, reference, reader, cues', () => {
  const ref = make({ id: 'ref', readings: curve(base, 355), fc: 300, drop: 355 });
  const rec = make({
    readings: curve(base, 355), fc: 300, drop: 355, roasted: 80, rejected: 2,
    cues: [{ t: 100, id: 'hot', text: 'x' }],
  });
  assert.deepEqual(ids(reviewRoast(rec, { reference: ref })),
    ['weightLoss', 'firstCrack', 'development', 'totalTime', 'endTemp', 'rorShape', 'reference', 'reader', 'cues']);
});

// ---------- no First crack, and records that cannot be judged ----------

test('no First crack: one info item, and development and end temperature are skipped', () => {
  const rv = reviewRoast(make({ fc: null, drop: 355, readings: curve(base, 355) }));
  const fc = find(rv, 'firstCrack');
  assert.equal(fc.status, 'info');
  assert.match(fc.text, /not marked/);
  assert.match(fc.text, /development and end temperature can't be judged/);
  assert.ok(!ids(rv).includes('development'));
  assert.ok(!ids(rv).includes('endTemp'));
  assert.ok(ids(rv).includes('totalTime'));
  assert.ok(ids(rv).includes('rorShape'));
});

test('shape is not judged for a manual source, more than 15% gaps, or a roast under 90 s', () => {
  const full = curve(base, 355);
  const shape = (rec) => find(reviewRoast(rec), 'rorShape');

  const manual = shape(make({ readings: full, fc: 300, drop: 355, source: 'manual' }));
  assert.equal(manual.status, 'info');
  assert.match(manual.text, /aren't enough readings to judge the rate-of-rise shape/);

  const gappy = full.map((v, i) => (i % 5 === 0 || i % 5 === 1 ? null : v));   // 40% gaps
  const g = shape(make({ readings: gappy, fc: 300, drop: 355 }));
  assert.equal(g.status, 'info');
  assert.match(g.text, /aren't enough readings/);

  const sixteen = full.map((v, i) => (i < 57 ? null : v));                      // 16% gaps
  assert.equal(shape(make({ readings: sixteen, fc: 300, drop: 355 })).status, 'info');
  const fourteen = full.map((v, i) => (i >= 10 && i < 59 ? null : v));         // 49 gaps of 356 is 13.8%
  assert.notEqual(shape(make({ readings: fourteen, fc: 300, drop: 355 })).status, 'info');

  const short = shape(make({ readings: curve(base, 80), fc: null, drop: 80 }));
  assert.equal(short.status, 'info');
  assert.match(short.text, /aren't enough readings/);
});

test('nothing throws on old or partial records, and they degrade to info items or omissions', () => {
  const odd = [
    undefined, null, {}, { readings: [] }, { readings: [null, null, null] },
    { readings: 'abc', events: 7, controls: 'x', cues: {}, results: 3, settings: 9, reader: 'r' },
    { events: { firstCrack: { t: 'x' }, drop: { t: NaN } }, readings: [1, 2, 3] },
    { events: { firstCrack: { t: 100 }, drop: { t: 150 } }, readings: curve(base, 150) },
    make({ readings: curve(base, 355), fc: 300, drop: 355, settings: undefined }),
    make({ readings: curve(base, 355), fc: 300, drop: 355, settings: null }),
    make({ readings: curve(base, 355), fc: 300, drop: 355, settings: { devTargetSec: 'long', rorWindowSec: null } }),
    make({ readings: curve(base, 355), fc: 300, drop: 355, controls: [null, { kind: 'heat' }, 5] }),
  ];
  for (const rec of odd) {
    const rv = reviewRoast(rec, { reference: { readings: 'bad', events: 3 } });
    assert.equal(typeof rv.headline, 'string');
    assert.ok(Array.isArray(rv.items));
    for (const i of rv.items) assert.ok(['good', 'close', 'off', 'info'].includes(i.status), `${i.id}: ${i.status}`);
  }
});

test('empty and missing readings give info items, and nothing judged reads as such', () => {
  for (const rec of [undefined, {}, { readings: [] }, make({})]) {
    const rv = reviewRoast(rec);
    assert.deepEqual(rv.counts, { good: 0, close: 0, off: 0 });
    assert.equal(rv.headline, 'Not enough data to judge this roast.');
    assert.equal(find(rv, 'firstCrack').status, 'info');
    assert.equal(find(rv, 'rorShape').status, 'info');
    assert.equal(find(rv, 'totalTime').status, 'info');
  }
});

test('a record with no settings is judged against the defaults', () => {
  const rec = presetRecord('on-target', 1);
  delete rec.settings;
  const rv = reviewRoast(rec);
  assert.equal(find(rv, 'firstCrack').status, 'good');
  assert.equal(find(rv, 'development').status, 'good');
  assert.equal(find(rv, 'rorShape').status, 'good');
});

// ---------- rate-of-rise shape ----------

test('on-target across 20 seeds: rorShape, firstCrack and development are good every time', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const rec = presetRecord('on-target', seed);
    const rv = reviewRoast(rec);
    for (const id of ['rorShape', 'firstCrack', 'development']) {
      assert.equal(find(rv, id).status, 'good', `seed ${seed} ${id}: ${find(rv, id).text}`);
    }
    assert.match(find(rv, 'rorShape').text, /^Rate of rise fell steadily from its peak of \d+°F\/min at \d:\d\d to \d+°F\/min at the drop\.$/);
  }
});

test('on-target: no false stall, climb or crash in 300 seeds (and none at three times the noise in all but a few)', () => {
  let bad = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const rec = presetRecord('on-target', seed);
    if (find(reviewRoast(rec), 'rorShape').status !== 'good') bad++;
  }
  assert.equal(bad, 0);
  let noisy = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const rec = presetRecord('on-target', seed, { noise: 1 });
    if (find(reviewRoast(rec), 'rorShape').status !== 'good') noisy++;
  }
  assert.ok(noisy <= 6, `${noisy} of 100 noisy roasts flagged`);
});

test('the dropout preset (two gaps) still reads as on-target', () => {
  const rv = reviewRoast(presetRecord('dropout', 2));
  assert.equal(find(rv, 'rorShape').status, 'good');
  assert.equal(find(rv, 'reader').status, 'info');
  assert.match(find(rv, 'cues').text, /Lost reading/);
});

test('stall preset: a stall finding with a sensible time', () => {
  const rv = reviewRoast(presetRecord('stall', 1));
  const it = find(rv, 'rorShape');
  assert.equal(it.status, 'off');
  assert.ok(it.t >= 150 && it.t <= 240, `stall at ${it.t}`);
  assert.match(it.text, /^At \d:\d\d the rate of rise fell under 5°F\/min and stayed there for \d+ s\./);
  assert.ok(it.text.startsWith(`At ${Math.floor(it.t / 60)}:${String(it.t % 60).padStart(2, '0')}`));
  assert.equal(find(rv, 'firstCrack').status, 'info');   // the roast never reached the first-crack reading
});

test('ror-climb preset: a climb finding before first crack', () => {
  for (const seed of [1, 2, 3]) {
    const it = find(reviewRoast(presetRecord('ror-climb', seed)), 'rorShape');
    assert.notEqual(it.status, 'good', `seed ${seed}`);
    assert.ok(it.t > 120 && it.t < 260, `climb at ${it.t}`);
    assert.match(it.text, /began climbing, up to \d+°F\/min above its recent low, before first crack\./);
  }
});

test('a climb of under twice the threshold is close, beyond that off', () => {
  // A bump of +20 (close) or +30 (off) °F/min over 20 s starting at 200 s, no first crack marked.
  const bump = (h) => (t) => base(t) + (t >= 200 ? Math.min(1, (t - 200) / 20) * h : 0);
  const mild = reviewRoast(make({ readings: curve(bump(20), 300), drop: 300 }));
  assert.equal(find(mild, 'rorShape').status, 'close');
  const hard = reviewRoast(make({ readings: curve(bump(30), 300), drop: 300 }));
  assert.equal(find(hard, 'rorShape').status, 'off');
});

test('a crash near first crack is a close finding; a normal exponential decay is not', () => {
  const crash = (t) => base(t) * (t >= 270 ? Math.max(0.35, 1 - (0.65 * (t - 270)) / 20) : 1);
  const bad = reviewRoast(make({ readings: curve(crash, DROP), fc: FC, drop: DROP }));
  const it = find(bad, 'rorShape');
  assert.equal(it.status, 'close');
  assert.match(it.text, /^At \d:\d\d the rate of rise had fallen from \d+°F\/min to \d+°F\/min in 30 s\./);
  assert.ok(it.t > 270 && it.t < 340, `crash at ${it.t}`);
  const fine = reviewRoast(make({ readings: curve(base, DROP), fc: FC, drop: DROP }));
  assert.equal(find(fine, 'rorShape').status, 'good');
});

test('a rise after first crack is a flick', () => {
  const flick = (t) => base(t) + (t >= 315 ? Math.min(1, (t - 315) / 15) * 18 : 0);
  const it = find(reviewRoast(make({ readings: curve(flick, DROP + 10), fc: FC, drop: DROP + 10 })), 'rorShape');
  assert.notEqual(it.status, 'good');
  assert.match(it.text, /began climbing/);
  assert.match(it.text, /after first crack \(a flick\)\./);
  assert.ok(it.t >= FC, `flick at ${it.t}`);
});

test('several findings: one item, the worst status, in time order, t of the first', () => {
  // a stall from 2:30 to 3:30, then the rate recovers (a climb), and a flick after first crack
  const shape = (t) => (t >= 150 && t < 210 ? 0 : base(t)) + (t >= 330 ? Math.min(1, (t - 330) / 15) * 30 : 0);
  const rv = reviewRoast(make({ readings: curve(shape, 370), fc: FC, drop: 370 }));
  const it = find(rv, 'rorShape');
  assert.equal(it.status, 'off');
  const stall = it.text.indexOf('fell under');
  const climbs = [...it.text.matchAll(/began climbing/g)].map((m) => m.index);
  assert.ok(stall >= 0 && climbs.length >= 1, it.text);
  assert.ok(stall < climbs[0]);
  assert.ok(it.text.startsWith('At 2:') || it.text.startsWith('At 3:'), it.text);
  assert.ok(it.t >= 150 && it.t < 230, `first at ${it.t}`);
  assert.equal(rv.items.filter((i) => i.id === 'rorShape').length, 1);
});

test('attribution: a finding within 45 s of a heat change names it; one without does not', () => {
  const plain = presetRecord('ror-climb', 3);
  const t = find(reviewRoast(plain), 'rorShape').t;
  assert.ok(!/after (heat|fan)/.test(find(reviewRoast(plain), 'rorShape').text));

  const near = { ...plain, controls: [...plain.controls, { t: t - 12, kind: 'heat', value: 3 }] };
  assert.match(find(reviewRoast(near), 'rorShape').text, /That was 12 s after heat went from 2 to 3\./);

  const far = { ...plain, controls: [...plain.controls, { t: t - 60, kind: 'heat', value: 3 }] };
  assert.ok(!/after heat/.test(find(reviewRoast(far), 'rorShape').text));

  const edge = { ...plain, controls: [...plain.controls, { t: t - 45, kind: 'heat', value: 3 }] };
  assert.match(find(reviewRoast(edge), 'rorShape').text, /45 s after heat went from 2 to 3/);

  const fan = { ...plain, controls: [...plain.controls, { t: t - 20, kind: 'fan', value: 'low' }] };
  assert.match(find(reviewRoast(fan), 'rorShape').text, /20 s after fan went from High to Low/);

  // the starting settings are not changes
  const startOnly = { ...plain, controls: [{ t: 0, kind: 'heat', value: 2 }, { t: 0, kind: 'fan', value: 'high' }] };
  assert.ok(!/after (heat|fan)/.test(find(reviewRoast(startOnly), 'rorShape').text));

  // a change after the finding is not its cause
  const later = { ...plain, controls: [...plain.controls, { t: t + 5, kind: 'heat', value: 1 }] };
  assert.ok(!/after heat/.test(find(reviewRoast(later), 'rorShape').text));
});

test('attribution works for a stall too', () => {
  const plain = presetRecord('stall', 1);
  const t = find(reviewRoast(plain), 'rorShape').t;
  const rec = { ...plain, controls: [...plain.controls, { t: t - 8, kind: 'heat', value: 1 }] };
  assert.match(find(reviewRoast(rec), 'rorShape').text, /That was 8 s after heat went from 2 to 1\./);
});

// ---------- reference ----------

test('reference: an identical roast has a gap of 0 and is good', () => {
  const readings = curve(base, DROP);
  const rec = make({ readings, fc: FC, drop: DROP, id: 'a' });
  const ref = make({ readings: [...readings], fc: FC, drop: DROP, id: 'b' });
  const it = find(reviewRoast(rec, { reference: ref }), 'reference');
  assert.equal(it.status, 'good');
  assert.match(it.text, /^Biggest gap from the reference: 0°F\./);
  assert.match(it.text, /First crack at the same time as the reference; development the same length\.$/);
});

test('reference: a curve shifted by +14°F is close, above, at the right time', () => {
  const readings = curve(base, DROP);
  const ref = make({ readings, fc: FC, drop: DROP, id: 'ref' });
  const all = make({ readings: readings.map((v) => v + 14), fc: FC, drop: DROP, id: 'a' });
  const itAll = find(reviewRoast(all, { reference: ref }), 'reference');
  assert.equal(itAll.status, 'close');
  assert.match(itAll.text, /^Biggest gap from the reference: 14°F above at 1:00\./);

  const late = make({ readings: readings.map((v, i) => (i >= 200 ? v + 14 : v)), fc: FC, drop: DROP, id: 'b' });
  const itLate = find(reviewRoast(late, { reference: ref }), 'reference');
  assert.equal(itLate.status, 'close');
  assert.match(itLate.text, /^Biggest gap from the reference: 14°F above at 3:29\./);
  assert.equal(itLate.t, 209);

  const below = make({ readings: readings.map((v, i) => (i >= 200 ? v - 14 : v)), fc: FC, drop: DROP, id: 'c' });
  assert.match(find(reviewRoast(below, { reference: ref }), 'reference').text, /14°F below at 3:29\./);
});

test('reference: good under the band, close up to twice it, off beyond', () => {
  const readings = curve(base, DROP);
  const ref = make({ readings, fc: FC, drop: DROP, id: 'ref' });
  const shifted = (d) => find(reviewRoast(make({ readings: readings.map((v) => v + d), fc: FC, drop: DROP }), { reference: ref }), 'reference').status;
  assert.equal(shifted(9), 'good');
  assert.equal(shifted(10), 'close');
  assert.equal(shifted(20), 'close');
  assert.equal(shifted(21), 'off');
  assert.equal(shifted(-21), 'off');
});

test('reference: first crack and development differences are worded in both directions', () => {
  const readings = curve(base, 400);
  const ref = make({ readings, fc: 300, drop: 355, id: 'ref' });
  const rec = make({ readings, fc: 312, drop: 363, id: 'a' });
  assert.match(find(reviewRoast(rec, { reference: ref }), 'reference').text, /First crack 12 s later than the reference; development 4 s shorter\.$/);
  const rec2 = make({ readings, fc: 290, drop: 355, id: 'b' });
  assert.match(find(reviewRoast(rec2, { reference: ref }), 'reference').text, /First crack 10 s earlier than the reference; development 10 s longer\.$/);
  const noFc = make({ readings, fc: null, drop: 355, id: 'c' });
  assert.ok(!/First crack/.test(find(reviewRoast(noFc, { reference: ref }), 'reference').text));
});

test('reference: omitted when it is the same roast, or missing, or cannot be compared', () => {
  const readings = curve(base, DROP);
  const rec = make({ readings, fc: FC, drop: DROP, id: 'same' });
  assert.ok(!ids(reviewRoast(rec, { reference: rec })).includes('reference'));
  assert.ok(!ids(reviewRoast(rec, { reference: { ...rec } })).includes('reference'));          // same id
  assert.ok(!ids(reviewRoast(rec, { reference: null })).includes('reference'));
  assert.ok(!ids(reviewRoast(rec, { reference: make({ readings: [], id: 'e' }) })).includes('reference'));
  assert.ok(!ids(reviewRoast(make({ readings: readings.slice(0, 40), drop: 39 }), { reference: make({ readings, id: 'o' }) })).includes('reference'));
});

test('reference: compares up to the shorter roast only', () => {
  const readings = curve(base, DROP);
  const ref = make({ readings: readings.slice(0, 200), drop: 199, id: 'short' });
  // beyond the reference's drop the roasts differ wildly; that must not count
  const rec = make({ readings: readings.map((v, i) => (i > 200 ? v + 100 : v)), fc: FC, drop: DROP, id: 'long' });
  assert.equal(find(reviewRoast(rec, { reference: ref }), 'reference').status, 'good');
});

// ---------- reader and cues ----------

test('reader: only when notable, with the wording of the brief', () => {
  const readings = curve(base, 269);   // 270 seconds
  const withGaps = readings.map((v, i) => (i >= 100 && i < 123 ? null : v));
  const rec = make({ readings: withGaps, fc: 215, drop: 269, rejected: 2 });
  const it = find(reviewRoast(rec), 'reader');
  assert.equal(it.status, 'info');
  assert.equal(it.text, 'The reader missed 23 of 270 seconds and rejected 2 values; treat the rate of rise with care.');
  assert.equal(find(reviewRoast(make({ readings: withGaps, fc: 215, drop: 269, rejected: 0 })), 'reader').text,
    'The reader missed 23 of 270 seconds; treat the rate of rise with care.');
  assert.equal(find(reviewRoast(make({ readings, fc: 215, drop: 269, rejected: 1 })), 'reader').text,
    'The reader rejected 1 value; treat the rate of rise with care.');
  // 5% or fewer missing and nothing rejected: not mentioned
  const few = readings.map((v, i) => (i >= 100 && i < 113 ? null : v));     // 13 of 270
  assert.ok(!ids(reviewRoast(make({ readings: few, fc: 215, drop: 269 }))).includes('reader'));
  // manual roasts are all gaps by design
  assert.ok(!ids(reviewRoast(make({ readings: withGaps, source: 'manual', rejected: 3 }))).includes('reader'));
});

test('cues: corrective and critical cues with times; fcSoon, dev15, dropNow and replay left out', () => {
  const cues = [
    { t: 120, id: 'fcSoon', text: 'x' }, { t: 160, id: 'hot', text: 'x' }, { t: 196, id: 'stall', text: 'x' },
    { t: 250, id: 'dev15', text: 'x' }, { t: 260, id: 'dropNow', text: 'x' }, { t: 262, id: 'replay', text: 'x' },
    { t: 263, id: 'fanPrompt', text: 'x' },
  ];
  const it = find(reviewRoast(make({ cues })), 'cues');
  assert.equal(it.status, 'info');
  assert.equal(it.text, 'Cues during the roast: Running hot 2:40, Stalling 3:16.');
  assert.ok(!ids(reviewRoast(make({ cues: [{ t: 5, id: 'fcSoon', text: 'x' }, { t: 9, id: 'dropNow', text: 'x' }] }))).includes('cues'));
  assert.ok(!ids(reviewRoast(make({ cues: [] }))).includes('cues'));
});

// ---------- units ----------

test('units: a 15°F delta is 8°C and a 45°F/min rate is 25°C/min', () => {
  assert.equal(formatDelta(15), '15°F');
  assert.equal(formatDelta(15, 'C'), '8°C');
  assert.equal(formatDelta(33, 'C'), '18°C');
  assert.equal(formatDelta(15, 'C', { digits: 1 }), '8.3°C');
  assert.equal(formatDelta(15, 'C', { unit: false }), '8');
  assert.equal(formatDelta(-9, 'C', { sign: true }), '-5°C');
  assert.equal(formatDelta(9, 'C', { sign: true }), '+5°C');
  assert.equal(formatDelta(null), '—');
  assert.equal(formatRate(45, 'C', { sign: false }), '25°C/min');
});

test('units: °C text has no °F anywhere, with temperature differences and rates converted', () => {
  const rec = make({ fc: 300, drop: 355, fcF: 410, dropF: 443, readings: curve(base, 355), rejected: 1, roasted: 80, cues: [{ t: 100, id: 'hot', text: 'x' }] });
  const ref = make({ id: 'ref', fc: 290, drop: 350, readings: curve((t) => base(t) * 1.02, 355) });
  const rv = reviewRoast(rec, { units: 'C', reference: ref });
  assert.match(find(rv, 'endTemp').text, /^Dropped 18°C above the first-crack reading; the cap is 8°C\.$/);
  for (const i of rv.items) assert.ok(!/°F/.test(i.text) && !/°F/.test(i.title), `${i.id}: ${i.text}`);
  assert.ok(!/°F/.test(rv.headline));
  assert.match(find(rv, 'rorShape').text, /°C\/min/);

  // 45 °F/min straight line: the peak reads 25°C/min
  const line = make({ readings: Array.from({ length: 121 }, (_, t) => 100 + 0.75 * t), drop: 120 });
  assert.match(find(reviewRoast(line, { units: 'C' }), 'rorShape').text, /peak of 25°C\/min/);
  assert.match(find(reviewRoast(line, { units: 'F' }), 'rorShape').text, /peak of 45°F\/min/);

  // the stall threshold in the text
  const stall = reviewRoast(presetRecord('stall', 1), { units: 'C' });
  assert.match(find(stall, 'rorShape').text, /fell under 3°C\/min/);

  // verdicts do not depend on the display unit
  const f = reviewRoast(rec, { units: 'F', reference: ref });
  assert.deepEqual(f.items.map((i) => i.status), rv.items.map((i) => i.status));
});

// ---------- headline ----------

test('headline: all good, mixed and nothing judged', () => {
  const good = reviewRoast(presetRecord('on-target', 4));
  assert.equal(good.headline, 'On target: all 6 checks passed.');
  assert.deepEqual(good.counts, { good: 6, close: 0, off: 0 });

  const mixed = reviewRoast(presetRecord('fast', 1));
  assert.equal(mixed.headline, '3 of 6 checks on target. Off target: first crack, total time, end temperature.');
  assert.deepEqual(mixed.counts, { good: 3, close: 0, off: 3 });

  const closeOnly = reviewRoast(make({ fc: 296, drop: 351, fcF: 410, dropF: 420, green: 100, roasted: 87.5, readings: curve(base, 351) }));
  assert.equal(closeOnly.headline, '3 of 6 checks on target. Close: weight loss, first crack, total time.');
  assert.ok(!closeOnly.headline.includes('Off target'));

  const none = reviewRoast({});
  assert.equal(none.headline, 'Not enough data to judge this roast.');
  assert.deepEqual(none.counts, { good: 0, close: 0, off: 0 });

  // info items are never counted
  const one = reviewRoast(make({ green: 100, roasted: 88.8 }));
  assert.equal(one.headline, 'On target: the 1 check passed.');
});

test('headline: off-target titles come first, then close', () => {
  const rec = make({ green: 100, roasted: 87.5, fc: 275, drop: 330, fcF: 410, dropF: 450, readings: curve(base, 330) });
  const rv = reviewRoast(rec);
  assert.match(rv.headline, /Off target: .*Close: /);
  assert.equal(rv.counts.good + rv.counts.close + rv.counts.off, rv.items.filter((i) => i.status !== 'info').length);
});

test('reviewRoast does not modify the record or the reference', () => {
  const rec = presetRecord('ror-climb', 2);
  const ref = presetRecord('on-target', 2);
  const a = JSON.stringify(rec);
  const b = JSON.stringify(ref);
  reviewRoast(rec, { reference: ref, units: 'C', settings: { ...DEFAULTS } });
  assert.equal(JSON.stringify(rec), a);
  assert.equal(JSON.stringify(ref), b);
});
