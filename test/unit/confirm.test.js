import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmer, seg7Agree, CONFIRM_DEFAULTS } from '../../js/reader/confirm.js';

// Evidence for a 3-cell display: masks per cell (bit k = segment k lit) and relative contrast per segment.
const ev = (masks, c) => ({ masks, c: c.map((cell) => cell.slice()) });
const flat = (v) => [0, 1, 2].map(() => Array(7).fill(v));
const withC = (base, cell, seg, v) => { const c = base.map((r) => r.slice()); c[cell][seg] = v; return c; };
const strictOk = (seg7, value = 77) => ({ status: 'ok', value, digits: [null, 7, 7], confidence: 0.9, debug: { seg7: { ...seg7, strict: true } } });
const tentative = (seg7, value = 77) => ({ status: 'none', value: null, digits: [], confidence: 0, debug: { reason: 'ambiguous segment', seg7, tentative: { value, digits: [null, 7, 7], confidence: 0.6 } } });

// 77: cell 1 and 2 show segments a,b,c (bits 0,1,2); cell 0 blank
const M77 = [0, 7, 7];
const veiled = (v) => { const c = flat(0.02); for (const cell of [1, 2]) for (const s of [0, 1, 2]) c[cell][s] = v; return c; };

test('a steady veiled segment pattern is accepted on the second picture, not the first', () => {
  const c = createConfirmer();
  const a = c.step(tentative(ev(M77, veiled(0.4))), 1000);
  assert.equal(a.status, 'none');
  assert.equal(a.debug.reason, 'unconfirmed reading');
  assert.equal(a.debug.strictReason, 'ambiguous segment');
  const b = c.step(tentative(ev(M77, veiled(0.42))), 1133);
  assert.equal(b.status, 'ok');
  assert.equal(b.value, 77);
  assert.deepEqual(b.debug.confirmed, { gapMs: 133, maxDelta: 0.02 });
  assert.equal(b.debug.strictReason, 'ambiguous segment');
  const d = c.step(tentative(ev(M77, veiled(0.41))), 1266);
  assert.equal(d.status, 'ok');   // and so on for as long as it holds
});

test('a strict read serves as the earlier picture, and strict reads pass through untouched', () => {
  const c = createConfirmer();
  const s = strictOk(ev(M77, veiled(0.8)));
  assert.equal(c.step(s, 1000), s);
  const t = c.step(tentative(ev(M77, veiled(0.72))), 1133);
  assert.equal(t.status, 'ok');
  assert.equal(t.debug.confirmed.maxDelta, 0.08);
});

test('a one-picture superset from the middle of a change is never accepted', () => {
  // 7 -> 1: segment a is switching off (0.34, 0.15, 0.07), the old 7 and the new 1 differ in a
  // 1 -> 7 would be the other way round; do both, and a switching-on segment while another switches off
  const off = [0.74, 0.34, 0.15, 0.07];
  const on = [0.13, 0.59, 0.73, 0.9];
  for (const gap of [33, 67, 100, 133, 200, 267]) {
    for (let i = 0; i + 1 < off.length; i++) {
      for (let j = i + 1; j < off.length; j++) {
        if ((j - i) * 33 !== gap && gap !== 133) continue;
        const frame = (k) => {
          // cell 2 segments: e (turning on) and a (turning off), b and c steady lit
          let cm = veiled(0.8);
          cm = withC(cm, 2, 0, off[k]); cm = withC(cm, 2, 4, on[k]);
          const mask = 0b0000110 | (off[k] >= 0.14 ? 1 : 0) | (on[k] >= 0.14 ? 1 << 4 : 0);
          return tentative(ev([0, 7, mask], cm), 17);
        };
        const c = createConfirmer();
        c.step(frame(i), 1000);
        const r = c.step(frame(j), 1000 + (j - i) * 33);
        assert.equal(r.status, 'none', `pictures ${i} and ${j} of the change`);
      }
    }
  }
});

test('a reflection that is moving across a segment leads to a miss, not a value', () => {
  const c = createConfirmer();
  const got = [];
  // the veil slides: relative contrast 0.25, 0.45, 0.65, 0.4, 0.2 at 133 ms steps
  [0.25, 0.45, 0.65, 0.4, 0.2].forEach((v, i) => got.push(c.step(tentative(ev(M77, veiled(v))), 1000 + 133 * i).status));
  assert.deepEqual(got, ['none', 'none', 'none', 'none', 'none']);
});

test('a different pattern in the earlier picture does not confirm', () => {
  const c = createConfirmer();
  c.step(tentative(ev([0, 7, 3], veiled(0.4))), 1000);
  assert.equal(c.step(tentative(ev(M77, veiled(0.4))), 1133).status, 'none');
});

test('the earlier picture must be older than minGapMs and no older than maxGapMs', () => {
  assert.ok(CONFIRM_DEFAULTS.minGapMs > 0 && CONFIRM_DEFAULTS.maxGapMs >= 400);
  let c = createConfirmer();
  c.step(tentative(ev(M77, veiled(0.4))), 1000);
  assert.equal(c.step(tentative(ev(M77, veiled(0.4))), 1010).status, 'none');           // the same picture read twice proves nothing
  c = createConfirmer();
  c.step(tentative(ev(M77, veiled(0.4))), 1000);
  assert.equal(c.step(tentative(ev(M77, veiled(0.4))), 1000 + CONFIRM_DEFAULTS.maxGapMs + 50).status, 'none');   // too long ago
  c = createConfirmer();
  c.step(tentative(ev(M77, veiled(0.4))), 1000);
  assert.equal(c.step(tentative(ev(M77, veiled(0.4))), 1000 + CONFIRM_DEFAULTS.maxGapMs).status, 'ok');
});

test('only the picture just before counts: a swaying reflection cannot match one from two steps back', () => {
  const c = createConfirmer();
  c.step(tentative(ev(M77, veiled(0.4))), 1000);
  c.step(tentative(ev(M77, veiled(0.7))), 1133);   // the veil moved
  assert.equal(c.step(tentative(ev(M77, veiled(0.42))), 1266).status, 'none');   // back where it was, but the picture between disagreed
});

test('a picture the reader could not judge at all does not stand in the way of the one before it', () => {
  const c = createConfirmer();
  c.step(tentative(ev(M77, veiled(0.4))), 1000);
  c.step({ status: 'none', value: null, digits: [], confidence: 0, debug: { reason: 'no digit found' } }, 1133);
  assert.equal(c.step(tentative(ev(M77, veiled(0.42))), 1266).status, 'ok');
});

test('every segment must agree, not just the average', () => {
  const c = createConfirmer();
  c.step(tentative(ev(M77, veiled(0.4))), 1000);
  const moved = withC(veiled(0.4), 2, 1, 0.4 + CONFIRM_DEFAULTS.tol + 0.05);
  assert.equal(c.step(tentative(ev(M77, moved)), 1133).status, 'none');
  assert.ok(Math.abs(seg7Agree(ev(M77, veiled(0.4)), ev(M77, withC(veiled(0.4), 0, 6, 0.02 + CONFIRM_DEFAULTS.tol - 0.01))) - 0.14) < 1e-9);
  assert.equal(seg7Agree(ev(M77, veiled(0.4)), ev([0, 7, 3], veiled(0.4))), null);
});

test('frames without evidence neither confirm nor break the chain, and reset forgets', () => {
  const c = createConfirmer();
  const bare = { status: 'none', value: null, digits: [], confidence: 0, debug: { reason: 'no digit found' } };
  c.step(tentative(ev(M77, veiled(0.4))), 1000);
  assert.equal(c.step(bare, 1100), bare);
  assert.equal(c.step(tentative(ev(M77, veiled(0.4))), 1200).status, 'ok');
  c.reset();
  assert.equal(c.step(tentative(ev(M77, veiled(0.4))), 1300).status, 'none');
  assert.equal(c.step(null, 1400), null);
});

test('the upgraded reading carries the tentative value and does not alter the input', () => {
  const c = createConfirmer();
  const first = tentative(ev(M77, veiled(0.4)), 77), second = tentative(ev(M77, veiled(0.4)), 77);
  c.step(first, 1000);
  const out = c.step(second, 1133);
  assert.equal(out.value, 77);
  assert.deepEqual(out.digits, [null, 7, 7]);
  assert.equal(second.status, 'none');
  assert.equal(second.debug.reason, 'ambiguous segment');
});
