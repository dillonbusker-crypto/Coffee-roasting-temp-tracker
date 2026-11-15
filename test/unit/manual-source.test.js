import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createManualSource } from '../../js/sources/manual-source.js';
import { createSession } from '../../js/core/session.js';

test('typed readings land on the next second; every other second is a gap', async () => {
  const src = createManualSource();
  await src.start();
  assert.deepEqual(src.peek(), { value: null, status: 'none' });
  assert.equal(src.sample(0), null);
  assert.deepEqual(src.enter('212'), { ok: true, value: 212 });
  assert.deepEqual(src.peek(), { value: 212, status: 'ok' });
  assert.equal(src.sample(1), 212);
  assert.equal(src.sample(2), null);          // not repeated
  assert.deepEqual(src.health(), { secondsRead: 1, rejected: 0, secondsMissing: 2 });
});

test('bad entries are refused and counted; a later typed value replaces an unsampled one', () => {
  const src = createManualSource();
  assert.equal(src.enter('').ok, false);
  assert.equal(src.enter('abc').ok, false);
  assert.equal(src.enter(10).ok, false);
  assert.equal(src.enter(900).ok, false);
  assert.equal(src.enter(NaN).ok, false);
  assert.equal(src.enter(300.4).value, 300);
  src.enter(305);
  assert.equal(src.takePending(), 305);       // what a camera source would inject
  assert.equal(src.takePending(), null);
  assert.equal(src.health().rejected, 5);
});

test('a manual roast logs through a session', () => {
  const src = createManualSource();
  const s = createSession({ source: src });
  for (let t = 0; t <= 20; t++) {
    if (t % 10 === 0) src.enter(100 + t);
    s.addReading(src.sample(t));
  }
  const r = s.finish();
  assert.deepEqual([r.readings[0], r.readings[10], r.readings[20], r.readings[5]], [100, 110, 120, null]);
  assert.equal(r.reader.source, 'manual');
  assert.equal(r.reader.secondsRead, 3);
  assert.equal(r.reader.secondsMissing, 18);
});
