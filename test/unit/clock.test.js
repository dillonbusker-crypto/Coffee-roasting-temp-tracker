import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../../js/core/clock.js';

// A fake time source: advance() runs timers as time passes; jump() moves time without
// running any timer, like a page that was frozen in the background.
function fakeTime() {
  let ms = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => ms,
    setInterval(fn, period) {
      const id = nextId++;
      timers.set(id, { fn, period, due: ms + period });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    advance(dt) {
      const end = ms + dt;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.due <= end && (!next || t.due < next.t.due)) next = { id, t };
        if (!next) break;
        ms = Math.max(ms, next.t.due);     // a frozen page fires its late timer once, not once per missed period
        next.t.due = ms + next.t.period;
        next.t.fn();
      }
      ms = end;
    },
    jump(dt) { ms += dt; },
    get timerCount() { return timers.size; },
  };
}

function setup(opts = {}) {
  const time = fakeTime();
  const clock = createClock({ now: time.now, setInterval: time.setInterval, clearInterval: time.clearInterval, ...opts });
  const ticks = [];
  clock.onTick((t, info) => ticks.push({ t, ...info }));
  return { time, clock, ticks };
}

test('start emits tick 0 and then one tick per second', () => {
  const { time, clock, ticks } = setup();
  clock.start();
  assert.deepEqual(ticks.map((x) => x.t), [0]);
  time.advance(5000);
  assert.deepEqual(ticks.map((x) => x.t), [0, 1, 2, 3, 4, 5]);
  assert.ok(ticks.every((x) => !x.missed));
});

test('catch-up: a stall emits every missed tick, flagged missed, the last one live', () => {
  const { time, clock, ticks } = setup();
  clock.start();
  time.advance(2000);
  ticks.length = 0;
  time.jump(7300);        // the page was frozen for 7.3 s
  time.advance(100);      // the next poll fires
  assert.deepEqual(ticks.map((x) => x.t), [3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(ticks.map((x) => x.missed), [true, true, true, true, true, true, false]);
  time.advance(1000);
  assert.equal(ticks.at(-1).t, 10);
  assert.equal(ticks.at(-1).missed, false);
});

test('no tick is emitted twice or skipped', () => {
  const { time, clock, ticks } = setup();
  clock.start();
  for (let i = 0; i < 60; i++) time.advance(i % 7 === 0 ? 3100 : 130);
  const seen = ticks.map((x) => x.t);
  assert.deepEqual(seen, seen.map((_, i) => i));
});

test('10x speed: ten ticks per real second', () => {
  const { time, clock, ticks } = setup({ speed: 10 });
  clock.start();
  time.advance(1000);
  assert.equal(ticks.at(-1).t, 10);
  time.advance(35000);
  assert.equal(ticks.at(-1).t, 360);
  assert.ok(ticks.every((x) => !x.missed), 'a fast-forward is not a stall');
});

test('changing speed does not jump elapsed time', () => {
  const { time, clock, ticks } = setup();
  clock.start();
  time.advance(4000);
  clock.setSpeed(10);
  assert.ok(Math.abs(clock.elapsed() - 4) < 1e-9);
  time.advance(1000);
  assert.equal(ticks.at(-1).t, 14);
});

test('stop holds elapsed time, start continues from it, and no timers leak', () => {
  const { time, clock, ticks } = setup();
  clock.start();
  time.advance(3000);
  clock.stop();
  assert.equal(time.timerCount, 0);
  time.advance(10000);
  assert.equal(ticks.at(-1).t, 3);
  clock.start();
  time.advance(2000);
  assert.equal(ticks.at(-1).t, 5);
});

test('onTick returns an unsubscribe function', () => {
  const { time, clock, ticks } = setup();
  const extra = [];
  const off = clock.onTick((t) => extra.push(t));
  clock.start();
  time.advance(2000);
  off();
  time.advance(2000);
  assert.deepEqual(extra, [0, 1, 2]);
  assert.equal(ticks.at(-1).t, 4);
});
