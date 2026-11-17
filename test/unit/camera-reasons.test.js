import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainMiss, explainRejection, slug } from '../../js/sources/camera-reasons.js';

test('every reason the reader gives maps to a plain label, text and hint', () => {
  const cases = [
    ['digit cut off at the right edge of the crop', 'digit cut off', 'A digit is cut off at the right edge.', 'Move the box right.'],
    ['digit cut off at the edge of the crop', 'digit cut off', 'A digit is cut off at the edge of the box.', 'Make the box bigger, with room on the left for a third digit.'],
    ['segment washed out by glare', 'glare', 'Glare is hiding part of a digit.', 'Tilt the thermometer or the phone a little, or shade the display.'],
    ['low contrast', 'too faint', 'The digits are too faint.', 'Add light or reduce glare.'],
    ['ambiguous segment', 'unclear digit', 'Part of a digit is unclear.', 'Check for glare, focus and that the phone is square-on.'],
    ['segments mid-fade', 'unclear digit'],
    ['unconfirmed reading', 'unsteady digit', 'A segment of the number is changing or flickering from picture to picture.', 'Check for a moving reflection on the display; hold the phone steady.'],
    ['invalid pattern', 'unclear digit'],
    ['bad hundreds digit', 'unclear digit'],
    ['no digit found', 'no digits found', 'No digits found in the box.'],
    ['too few digits', 'no digits found'],
    ['ones digit blank', 'no digits found'],
    ['gap in digits', 'no digits found'],
    ['ink right of the ones digit', 'ink beside number', 'Something is inside the box to the right of the number.', 'Leave out the °F.'],
    ['crop too small', 'box too small'],
    ['out of display range', 'impossible number'],
    ['reader error', 'reader error'],
  ];
  for (const [reason, label, text, hint] of cases) {
    const e = explainMiss(reason);
    assert.equal(e.label, label, reason);
    if (text) assert.equal(e.text, text, reason);
    if (hint) assert.equal(e.hint, hint, reason);
  }
  assert.equal(explainMiss('something new').label, 'unreadable');
  assert.equal(explainMiss(undefined).label, 'unreadable');
});

test('filter outcomes: range, jump and disagreement are named; reads and gaps are not rejections', () => {
  assert.equal(explainRejection({ kind: 'jump', value: 300, last: 100 }).text, 'The reading jumped from 100 to 300, too big a jump, so it was not accepted.');
  assert.equal(explainRejection({ kind: 'range', value: 20 }).label, 'out of range');
  assert.match(explainRejection({ kind: 'disagree', values: [60, 90] }).text, /60, 90/);
  const imp = explainRejection({ kind: 'impossible', value: 254 });
  assert.equal(imp.label, 'impossible number');   // the same label as the reader's own "number the thermometer cannot show"
  assert.match(imp.text, /254/);
  assert.equal(explainRejection({ kind: 'read', value: 80 }), null);
  assert.equal(explainRejection({ kind: 'missing' }), null);
  assert.equal(explainRejection(null), null);
});

test('slug makes a file-name piece', () => {
  assert.equal(slug('ambiguous segment'), 'ambiguous-segment');
  assert.equal(slug('digit cut off at the right edge of the crop'), 'digit-cut-off-at-the-right-edge-of-the-c');
  assert.equal(slug(''), 'unknown');
});

test('a saved record with reader.missReasons survives export normalising and import', async () => {
  const { normalizeRoast } = await import('../../js/store/transfer.js');
  const rec = { id: 'x', startedAt: '2026-11-16T10:00:00Z', readings: [1], reader: { source: 'camera', secondsRead: 5, rejected: 1, secondsMissing: 3, missReasons: { 'unclear digit': 2 } } };
  const back = normalizeRoast(JSON.parse(JSON.stringify(rec)));
  assert.deepEqual(back.reader.missReasons, { 'unclear digit': 2 });
  assert.deepEqual(normalizeRoast({ id: 'y', startedAt: 'z', readings: [] }).reader.missReasons, undefined);
});
