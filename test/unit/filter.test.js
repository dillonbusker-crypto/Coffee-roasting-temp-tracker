import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingFilter } from '../../js/reader/filter.js';

const ok = value => ({ status: 'ok', value });
const none = { status: 'none', value: null };
const dashes = { status: 'dashes', value: null };

// feed one second of frames and close it
function second(f, ...frames) {
  for (const fr of frames) f.addFrame(typeof fr === 'number' ? ok(fr) : fr);
  return f.closeSecond();
}

test('median of the ok frames in a second', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 77, 77, 77, 77), 77);
  assert.equal(second(f, 78, 77, 78, 78), 78);
  assert.equal(second(f, 79, 79, 78), 79);
});

test('even split between neighbouring values rounds to the nearer whole degree', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 100, 101), 101); // transition second: either is a true reading
});

test('none frames are ignored when other frames read', () => {
  const f = createReadingFilter();
  assert.equal(second(f, none, 120, none, 120), 120);
  assert.equal(f.health().framesNone, 2);
});

test('a second with no ok frame is missing, not a value', () => {
  const f = createReadingFilter();
  assert.equal(second(f, none, none, none, none), null);
  assert.equal(second(f), null);
  const h = f.health();
  assert.equal(h.secondsMissing, 2);
  assert.equal(h.secondsRead, 0);
  assert.equal(h.rejected, 0);
});

test('frames that contradict each other reject the second', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 200, 200), 200);
  assert.equal(second(f, 201, 150), null);          // two frames, no majority
  assert.equal(second(f, 202, 160, 170), null);     // three frames, no majority
  assert.equal(second(f, 203, 203, 160), 203);      // majority wins, the outlier is dropped
  const h = f.health();
  assert.equal(h.rejectedDisagree, 2);
  assert.equal(h.secondsRead, 2);
});

test('range check: below 50 and above 550 are discarded and counted', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 49, 49), null);
  assert.equal(second(f, 50, 50), 50);
  assert.equal(second(f, 551), null);
  const f2 = createReadingFilter();
  assert.equal(second(f2, 550), 550);
  assert.equal(f2.health().rejectedRange, 0);
  assert.equal(f.health().rejectedRange, 2);
  assert.equal(f.health().rejected, 2);
});

test('jump check: more than 15 F from the last accepted value is discarded', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 200), 200);
  assert.equal(second(f, 217), 217);                // 15 + 2 allowed one second later
  assert.equal(second(f, 250), null);               // +33
  assert.equal(second(f, 218), 218);                // back near the anchor: the discarded second does not move it
  assert.equal(f.health().rejectedJump, 1);
});

test('jump allowance grows by 2 F per second since the last accepted value', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 200), 200);
  for (let i = 0; i < 9; i++) assert.equal(second(f, none), null); // nine missing seconds
  // allowed = 15 + 2 * 10 = 35
  assert.equal(second(f, 235), 235);
  const g = createReadingFilter();
  assert.equal(second(g, 200), 200);
  for (let i = 0; i < 9; i++) second(g, none);
  assert.equal(second(g, 236), null);               // 36 > 35
});

test('re-anchors after 5 consecutive jump-rejected seconds that agree', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 100), 100);
  for (let i = 0; i < 12; i++) second(f, none);     // a long dropout during a fast climb ...
  const got = [];
  for (const v of [300, 301, 303, 304, 306, 307]) got.push(second(f, v));
  // ... the allowance (15 + 2*13 = 41) is exceeded by 300, so the first seconds are discarded
  assert.deepEqual(got.slice(0, 4), [null, null, null, null]);
  assert.equal(got[4], 306);                        // fifth agreeing second re-anchors
  assert.equal(got[5], 307);
  assert.equal(f.health().reanchors, 1);
});

test('does not re-anchor when the discarded seconds disagree', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 100), 100);
  for (const v of [300, 330, 300, 340, 300, 350]) assert.equal(second(f, v), null);
  assert.equal(f.health().reanchors, 0);
  assert.equal(second(f, 102), 102);
});

test('a missing second breaks the streak of jump rejections', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 100), 100);
  for (const v of [300, 301, 302, 303]) assert.equal(second(f, v), null);
  assert.equal(second(f, none), null);
  assert.equal(second(f, 304), null);               // streak restarted: this is the first again
  assert.equal(f.health().reanchors, 0);
});

test('dashes are missing seconds, not values and not discards', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 150), 150);
  assert.equal(second(f, dashes, dashes, dashes, dashes), null);
  assert.equal(second(f, dashes, dashes, none, none), null);
  const h = f.health();
  assert.equal(h.secondsMissing, 2);
  assert.equal(h.dashSeconds, 2);
  assert.equal(h.rejected, 0);
  assert.equal(h.secondsRead, 1);
  // and the filter still compares against the last real value
  assert.equal(second(f, 152), 152);
});

test('ok frames outvote a stray dashes frame; dashes outvote a stray ok frame', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 90, dashes, 90, 90), 90);
  assert.equal(second(f, 90, dashes, dashes, dashes), null);
});

test('reanchor() sets the trusted value, e.g. after manual entry', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 100), 100);
  f.reanchor(300);
  assert.equal(second(f, 305), 305);
  assert.equal(f.health().lastAccepted, 305);
});

test('first reading has nothing to be compared with', () => {
  const f = createReadingFilter();
  assert.equal(second(f, none), null);
  assert.equal(second(f, 400), 400);
});

test('health counters and seconds since the last accepted reading', () => {
  const f = createReadingFilter();
  second(f, 100); second(f, none); second(f, none); second(f, 999);
  const h = f.health();
  assert.equal(h.secondsRead, 1);
  assert.equal(h.secondsMissing, 2);
  assert.equal(h.rejectedRange, 1);
  assert.equal(h.secondsSinceAccepted, 3);
  assert.equal(h.secondsClosed, 4);
  assert.equal(h.lastAccepted, 100);
});

test('custom limits are honoured', () => {
  const f = createReadingFilter({ minF: 14, maxF: 572, maxJumpF: 5, jumpPerSecF: 0 });
  assert.equal(second(f, 14), 14);
  assert.equal(second(f, 19), 19);
  assert.equal(second(f, 25), null);
});

test('a 60 s climb at 4 fps through 99 to 100 with transition frames yields one correct value per second', () => {
  const f = createReadingFilter();
  const out = [];
  let t = 0;
  for (let s = 0; s < 60; s++) {
    const truth = Math.round(80 + s * 0.8);          // 80 .. 127 F
    const frames = [];
    for (let k = 0; k < 4; k++) {
      // the first frame of some seconds catches the display mid-change and fails to read
      frames.push(k === 0 && s % 7 === 0 ? none : ok(truth));
    }
    for (const fr of frames) f.addFrame(fr);
    out.push([truth, f.closeSecond()]);
    t++;
  }
  assert.ok(out.every(([truth, v]) => v === truth));
  assert.equal(f.health().secondsRead, 60);
});
