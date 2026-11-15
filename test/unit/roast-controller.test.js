import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoastController } from '../../js/ui/roast-controller.js';
import { createClock } from '../../js/core/clock.js';
import { createSimulatorSource } from '../../js/sources/simulator-source.js';
import { createManualSource } from '../../js/sources/manual-source.js';
import { DEFAULTS } from '../../js/core/settings.js';

// A fake world: one millisecond counter drives the clock, the undo timers and the banner.
function world(speed = 1) {
  let ms = 0;
  const pending = [];
  let nextId = 1;
  const timers = {
    setTimeout: (fn, delay) => { const id = nextId++; pending.push({ id, at: ms + delay, fn }); return id; },
    clearTimeout: (id) => { const i = pending.findIndex((p) => p.id === id); if (i >= 0) pending.splice(i, 1); },
  };
  const now = () => ms;
  const clock = createClock({ now, setInterval: () => 1, clearInterval: () => {}, speed });
  // Steps in 0.5 s slices so undo timers, banners and drafts see time pass like a real page.
  const advance = (sec) => {
    const end = ms + sec * 1000;
    while (ms < end) {
      const slice = Math.min(end, ms + 500);
      for (;;) {
        const due = pending.filter((p) => p.at <= slice).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        ms = due.at;
        pending.splice(pending.indexOf(due), 1);
        clock.poll();
        due.fn();
      }
      ms = slice;
      clock.poll();
    }
  };
  return { now, timers, clock, advance };
}

function make(opts = {}) {
  const w = world();
  const said = [];
  const drafts = [];
  const ctl = createRoastController({
    source: opts.source || createSimulatorSource({ preset: 'on-target' }),
    settings: { ...DEFAULTS, ...(opts.settings || {}) },
    clock: w.clock, now: w.now, timers: w.timers,
    speech: { say: (text, o) => said.push({ text, ...o }) },
    saveDraft: (r) => drafts.push(r),
    ...opts.ctl,
  });
  return { w, ctl, said, drafts };
}

test('logs one reading per second and emits updates', async () => {
  const { w, ctl } = make();
  const views = [];
  ctl.onUpdate((v) => views.push(v));
  await ctl.start();
  w.advance(30);
  const s = ctl.snapshot();
  assert.equal(s.t, 30);
  assert.equal(s.raw.length, 31);
  assert.ok(views.length >= 31);
  assert.equal(views.at(-1).phase, 'running');
});

test('Yellow and First crack: stamp, Undo within the window, lock after it', async () => {
  const { w, ctl } = make();
  await ctl.start();
  w.advance(100);
  ctl.mark('yellow');
  assert.equal(ctl.snapshot().events.yellow.t, 100);
  assert.equal(ctl.view().undoMs.yellow, 5000);
  w.advance(2);
  assert.ok(ctl.unmark('yellow'));
  assert.equal(ctl.snapshot().events.yellow, null);
  ctl.mark('yellow');
  w.advance(6);
  assert.equal(ctl.view().undoMs.yellow, null);
  assert.equal(ctl.unmark('yellow'), false, 'locked once the window is over');
  assert.equal(ctl.mark('yellow'), null, 'cannot stamp twice');
  assert.equal(ctl.snapshot().events.yellow.t, 102);
});

test('Drop: keeps logging in the Undo window, then finishes at the stamped second', async () => {
  const { w, ctl, drafts } = make();
  await ctl.start();
  w.advance(300);
  ctl.mark('firstCrack');
  w.advance(55);
  const drop = ctl.mark('drop');
  assert.equal(drop.t, 355);
  w.advance(3);
  assert.equal(ctl.snapshot().t, 358, 'still logging');
  assert.equal(ctl.phase, 'running');
  // Undo cancels the finish.
  assert.ok(ctl.unmark('drop'));
  w.advance(10);
  assert.equal(ctl.phase, 'running');
  const drop2 = ctl.mark('drop');
  let done = null;
  ctl.onDone((r) => { done = r; });
  w.advance(6);
  assert.equal(ctl.phase, 'done');
  assert.ok(done);
  assert.equal(done.readings.length, drop2.t + 1);
  assert.equal(done.events.drop.t, drop2.t);
  assert.equal(done.events.firstCrack.t, 300);
  assert.equal(done.reader.source, 'simulator');
  assert.ok(drafts.length >= 1 && drafts.at(-1).id === done.id, 'final record is kept as a draft until saved');
  const t = ctl.snapshot().t;
  w.advance(10);
  assert.equal(ctl.snapshot().t, t, 'clock stopped');
});

test('heat taps are logged, and the same level logs nothing', async () => {
  const { w, ctl } = make();
  await ctl.start();
  w.advance(60);
  assert.equal(ctl.setControl('heat', 2), null);
  assert.deepEqual(ctl.setControl('heat', 3), { t: 60, kind: 'heat', value: 3 });
  assert.equal(ctl.snapshot().heat, 3);
});

test('cues are logged, spoken and shown; at fast demo speed they only beep', async () => {
  const slow = make({ source: createSimulatorSource({ preset: 'fast' }) });
  await slow.ctl.start();
  slow.w.advance(200);
  const hot = slow.said.find((s) => s.text.includes('Running hot'));
  assert.ok(hot, `said: ${JSON.stringify(slow.said)}`);
  assert.equal(hot.silent, false);
  assert.ok(slow.ctl.view().cues.some((c) => c.id === 'hot'));
  const rec = slow.ctl.end();
  assert.ok(rec.cues.some((c) => c.id === 'hot'), 'cue is in the saved record');

  const w = world(10);
  const said = [];
  const ctl = createRoastController({
    source: createSimulatorSource({ preset: 'fast' }), settings: DEFAULTS, clock: w.clock, now: w.now, timers: w.timers,
    speech: { say: (text, o) => said.push({ text, ...o }) },
  });
  await ctl.start();
  w.advance(25);   // 250 roast seconds
  assert.ok(said.length > 0);
  assert.ok(said.every((s) => s.silent === true));
});

test('banner expires after bannerMs; lost state lasts until readings resume', async () => {
  const { w, ctl } = make({ source: createSimulatorSource({ preset: 'dropout' }) });
  await ctl.start();
  w.advance(126);   // 6 s into the 2:00-2:12 gap
  assert.equal(ctl.view().lost, true);
  assert.equal(ctl.view().banner.id, 'lost');
  w.advance(5);
  assert.equal(ctl.view().banner, null, 'banner timed out');
  assert.equal(ctl.view().lost, true, 'still lost');
  w.advance(10);
  assert.equal(ctl.view().lost, false, 'readings are back');
});

test('manual source: typed readings are the readings, and lost is muted', async () => {
  const { w, ctl } = make({ source: createManualSource() });
  await ctl.start();
  assert.deepEqual(ctl.typeReading(20), { ok: false, reason: 'outside 50-550' });
  assert.equal(ctl.typeReading(120).ok, true);
  w.advance(3);
  assert.equal(ctl.snapshot().raw[1], 120);
  assert.equal(ctl.snapshot().raw[2], null);
  w.advance(20);
  assert.equal(ctl.view().lost, false);
  assert.ok(!ctl.view().cues.some((c) => c.id === 'lost'));
});

test('a typed reading overrides any source for that second', async () => {
  const { w, ctl } = make();
  await ctl.start();
  w.advance(10);
  ctl.typeReading(333);
  w.advance(1);
  assert.equal(ctl.snapshot().raw[11], 333);
  assert.notEqual(ctl.snapshot().raw[12], 333);
});

test('End roast saves what is logged; abort leaves no record', async () => {
  const a = make();
  await a.ctl.start();
  a.w.advance(90);
  const rec = a.ctl.end();
  assert.equal(rec.readings.length, 91);
  assert.equal(rec.events.drop.t, 90);
  assert.equal(a.ctl.phase, 'done');

  const b = make();
  await b.ctl.start();
  b.w.advance(10);
  b.ctl.abort();
  assert.equal(b.ctl.phase, 'aborted');
  assert.equal(b.ctl.record, null);
});

test('a draft is written about every draftMs of real time', async () => {
  const { w, ctl, drafts } = make({ ctl: { draftMs: 10000 } });
  await ctl.start();
  w.advance(35);
  assert.equal(drafts.length, 3);
  assert.equal(drafts.at(-1).readings.length, 31);
});
