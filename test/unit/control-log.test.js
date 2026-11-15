// The pure rules behind the heat and fan log editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClockText, clampTime, sortControls, upsertControl, removeControl } from '../../js/ui/control-log-editor.js';

const base = [
  { t: 0, kind: 'heat', value: 2 },
  { t: 0, kind: 'fan', value: 'high' },
  { t: 90, kind: 'heat', value: 3 },
  { t: 200, kind: 'fan', value: 'low' },
];

test('clock text accepts m:ss and plain seconds', () => {
  assert.equal(parseClockText('1:30'), 90);
  assert.equal(parseClockText(' 0:05 '), 5);
  assert.equal(parseClockText('90'), 90);
  assert.equal(parseClockText('1:75'), null);
  assert.equal(parseClockText('abc'), null);
  assert.equal(parseClockText(''), null);
});

test('times clamp to 1 s .. the roast length', () => {
  assert.equal(clampTime(0, 390), 1);
  assert.equal(clampTime(-5, 390), 1);
  assert.equal(clampTime(999, 390), 390);
  assert.equal(clampTime(42.4, 390), 42);
  assert.equal(clampTime(10, 0), 1);
});

test('sorting orders by time and keeps equal times in their order', () => {
  const out = sortControls([base[3], base[2], base[0], base[1]]);
  assert.deepEqual(out.map((c) => `${c.t}${c.kind}`), ['0heat', '0fan', '90heat', '200fan']);
});

test('editing a time re-sorts and clamps; the start entries never move', () => {
  let out = upsertControl(base, 2, { ...base[2], t: 250 }, 390);
  assert.deepEqual(out.map((c) => c.t), [0, 0, 200, 250]);
  out = upsertControl(base, 2, { ...base[2], t: 9999 }, 390);
  assert.equal(out[out.length - 1].t, 390);
  out = upsertControl(base, 0, { ...base[0], t: 50, value: 4 }, 390);
  assert.deepEqual(out.slice(0, 2).map((c) => [c.t, c.kind]), [[0, 'heat'], [0, 'fan']]);
  assert.equal(out[0].value, 4, 'the start value is editable');
});

test('adding inserts in order; a same-kind change at the same second replaces the old one', () => {
  let out = upsertControl(base, -1, { t: 150, kind: 'heat', value: 5 }, 390);
  assert.deepEqual(out.map((c) => c.t), [0, 0, 90, 150, 200]);
  out = upsertControl(base, -1, { t: 90, kind: 'heat', value: 6 }, 390);
  assert.equal(out.length, base.length);
  assert.equal(out.find((c) => c.t === 90).value, 6);
  out = upsertControl(base, -1, { t: 90, kind: 'fan', value: 'low' }, 390);
  assert.equal(out.length, base.length + 1, 'a different kind at the same second is kept');
});

test('the two t = 0 entries cannot be deleted; others can', () => {
  assert.equal(removeControl(base, 0).length, 4);
  assert.equal(removeControl(base, 1).length, 4);
  const out = removeControl(base, 2);
  assert.deepEqual(out.map((c) => c.t), [0, 0, 200]);
});

test('the input is never modified', () => {
  const copy = JSON.parse(JSON.stringify(base));
  upsertControl(base, 2, { ...base[2], t: 5 }, 390);
  removeControl(base, 3);
  sortControls(base);
  assert.deepEqual(base, copy);
});
