// db.js is a thin IndexedDB wrapper; the rules that matter are pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReferenceFlags, pickReference, normalizeName, openDb } from '../../js/store/db.js';

const roast = (id, coffee, startedAt, reference = {}) => ({
  id, coffee, startedAt, readings: [], reference: { coffee: false, general: false, ...reference },
});

const apply = (roasts, changed) => roasts.map((r) => changed.find((c) => c.id === r.id) ?? r);

test('name matching ignores case and surrounding spaces', () => {
  assert.equal(normalizeName('  Ethiopia Guji '), 'ethiopia guji');
  assert.equal(normalizeName(null), '');
});

test('setting a coffee reference clears the old one for the same coffee only', () => {
  const roasts = [
    roast('a', 'Ethiopia Guji', '2026-01-01T00:00:00Z', { coffee: true }),
    roast('b', 'ethiopia guji ', '2026-02-01T00:00:00Z'),
    roast('c', 'Colombia', '2026-03-01T00:00:00Z', { coffee: true }),
  ];
  const changed = applyReferenceFlags(roasts, 'b', { coffee: true });
  const next = apply(roasts, changed);
  assert.equal(next.find((r) => r.id === 'a').reference.coffee, false);
  assert.equal(next.find((r) => r.id === 'b').reference.coffee, true);
  assert.equal(next.find((r) => r.id === 'c').reference.coffee, true);
  assert.equal(next.filter((r) => r.reference.coffee && normalizeName(r.coffee) === 'ethiopia guji').length, 1);
  assert.deepEqual(changed.map((r) => r.id).sort(), ['a', 'b']);   // only what changed is rewritten
});

test('there is at most one general reference overall', () => {
  const roasts = [
    roast('a', 'X', '2026-01-01T00:00:00Z', { general: true }),
    roast('b', 'Y', '2026-02-01T00:00:00Z', { coffee: true }),
    roast('c', 'Z', '2026-03-01T00:00:00Z'),
  ];
  const next = apply(roasts, applyReferenceFlags(roasts, 'c', { general: true }));
  assert.deepEqual(next.filter((r) => r.reference.general).map((r) => r.id), ['c']);
  assert.equal(next.find((r) => r.id === 'b').reference.coffee, true);   // the coffee flag is untouched
});

test('one roast can be both the coffee and the general reference; flags can be cleared', () => {
  const roasts = [roast('a', 'X', '2026-01-01T00:00:00Z')];
  let next = apply(roasts, applyReferenceFlags(roasts, 'a', { coffee: true, general: true }));
  assert.deepEqual(next[0].reference, { coffee: true, general: true });
  next = apply(next, applyReferenceFlags(next, 'a', { general: false }));      // coffee flag is kept
  assert.deepEqual(next[0].reference, { coffee: true, general: false });
  next = apply(next, applyReferenceFlags(next, 'a', { coffee: false }));
  assert.deepEqual(next[0].reference, { coffee: false, general: false });
  assert.deepEqual(applyReferenceFlags(next, 'a', { coffee: false }), []);     // nothing to write
});

test('the input is not mutated, and an unknown id throws', () => {
  const roasts = [roast('a', 'X', '2026-01-01T00:00:00Z', { coffee: true }), roast('b', 'X', '2026-02-01T00:00:00Z')];
  const copy = JSON.parse(JSON.stringify(roasts));
  applyReferenceFlags(roasts, 'b', { coffee: true });
  assert.deepEqual(roasts, copy);
  assert.throws(() => applyReferenceFlags(roasts, 'nope', { coffee: true }));
});

test('reference lookup: own coffee, else the general one, else none', () => {
  const roasts = [
    roast('own', 'Ethiopia Guji', '2026-01-01T00:00:00Z', { coffee: true }),
    roast('gen', 'Colombia', '2026-02-01T00:00:00Z', { general: true }),
    roast('plain', 'Kenya', '2026-03-01T00:00:00Z'),
  ];
  assert.equal(pickReference(roasts, 'ETHIOPIA GUJI ').id, 'own');
  assert.equal(pickReference(roasts, 'Kenya').id, 'gen');
  assert.equal(pickReference(roasts, '').id, 'gen');
  assert.equal(pickReference(roasts.filter((r) => r.id !== 'gen'), 'Kenya'), null);
  assert.equal(pickReference([], 'Anything'), null);
});

test('with no IndexedDB, openDb rejects instead of throwing synchronously', async () => {
  await assert.rejects(openDb());
});
