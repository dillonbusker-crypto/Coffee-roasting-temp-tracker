import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fToC, cToF, rateFToC, rateCToF, formatTemp, formatRate, formatDelta, formatClock, tempFromUnit } from '../../js/core/units.js';

test('temperature conversion', () => {
  assert.equal(fToC(32), 0);
  assert.equal(fToC(212), 100);
  assert.ok(Math.abs(cToF(fToC(410)) - 410) < 1e-9);
});

test('a rate converts by 5/9 with no offset', () => {
  assert.ok(Math.abs(rateFToC(18) - 10) < 1e-12);
  assert.equal(rateFToC(0), 0);
  assert.ok(Math.abs(rateCToF(rateFToC(35)) - 35) < 1e-12);
});

test('formatting', () => {
  assert.equal(formatTemp(410), '410°F');
  assert.equal(formatTemp(410, 'C'), '210.0°C');
  assert.equal(formatTemp(410, 'F', { unit: false }), '410');
  assert.equal(formatTemp(null), '—');
  assert.equal(formatRate(35.2), '+35°F/min');
  assert.equal(formatRate(-3.4), '-3°F/min');
  assert.equal(formatRate(36, 'C'), '+20°C/min');
  assert.equal(formatRate(null, 'C'), '—');
  assert.equal(formatClock(395), '6:35');
  assert.equal(formatClock(9), '0:09');
  assert.equal(formatClock(null), '—');
  assert.ok(Math.abs(tempFromUnit(210, 'C') - 410) < 1e-9);
});

test('a temperature difference converts by 5/9 with no offset', () => {
  assert.equal(formatDelta(15), '15°F');
  assert.equal(formatDelta(15, 'C'), '8°C');
  assert.equal(formatDelta(15, 'C', { digits: 1 }), '8.3°C');
  assert.equal(formatDelta(18, 'C', { unit: false }), '10');
  assert.equal(formatDelta(0, 'C'), '0°C');
  assert.equal(formatDelta(-9, 'C', { sign: true }), '-5°C');
  assert.equal(formatDelta(9, 'F', { sign: true }), '+9°F');
  assert.equal(formatDelta(-0.2, 'F'), '0°F');
  assert.equal(formatDelta(null, 'C'), '—');
});
