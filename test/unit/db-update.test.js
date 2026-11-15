// updateRoast is IndexedDB glue; the merge rule it applies is pure and tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRoastPatch } from '../../js/store/db.js';

const stored = {
  id: 'a', coffee: 'Guji', notes: '', score: null, roastedWeightG: null,
  reference: { coffee: true, general: false },
  controls: [{ t: 0, kind: 'heat', value: 2 }],
};

test('a patch replaces only the fields it names', () => {
  const next = mergeRoastPatch(stored, { notes: 'Sweet', score: 4 });
  assert.equal(next.notes, 'Sweet');
  assert.equal(next.score, 4);
  assert.equal(next.coffee, 'Guji');
  assert.deepEqual(next.controls, stored.controls);
  assert.equal(stored.notes, '', 'the stored object is not modified');
});

test('a patch cannot change the id or the reference flags', () => {
  const next = mergeRoastPatch(stored, { id: 'zzz', reference: { coffee: false, general: true }, notes: 'x' });
  assert.equal(next.id, 'a');
  assert.deepEqual(next.reference, { coffee: true, general: false });
  assert.equal(next.notes, 'x');
});

test('an empty or missing patch changes nothing', () => {
  assert.deepEqual(mergeRoastPatch(stored, {}), stored);
  assert.deepEqual(mergeRoastPatch(stored, undefined), stored);
});
