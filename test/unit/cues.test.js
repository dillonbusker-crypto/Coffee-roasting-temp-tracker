import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCueEngine, projectedFirstCrack, replayText } from '../../js/core/cues.js';
import { createSession } from '../../js/core/session.js';
import { createSimulatorSource } from '../../js/sources/simulator-source.js';
import { DEFAULTS } from '../../js/core/settings.js';
import { runRoast, autoUser, seriesSource, snapAt } from './harness.js';

const CORRECTIVE = ['hot', 'slow', 'stall'];
const times = (r, id) => r.fired.filter((c) => c.id === id).map((c) => c.t);
const FIRST_CRACK_READING = DEFAULTS.expectedFcF;
const smoothedRef = (ref, i) => {
  let sum = 0;
  let n = 0;
  for (let k = Math.max(0, i - 9); k <= i; k++) if (ref[k] != null) { sum += ref[k]; n++; }
  return sum / n;
};

// ---------- each preset through a real session and the engine ----------

test('on-target fires no corrective cue and no rorClimb, and does fire fcSoon', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const r = runRoast({ preset: 'on-target', seed });
    for (const id of [...CORRECTIVE, 'rorClimb', 'lost']) assert.ok(!r.ids.includes(id), `seed ${seed} fired ${id} at ${times(r, id)}`);
    assert.equal(times(r, 'fcSoon').length, 1, `seed ${seed}`);
  }
});

test('on-target: fcSoon at 400 F, then the development countdown after First crack', () => {
  const r = runRoast({ preset: 'on-target' });
  const soon = r.fired.find((c) => c.id === 'fcSoon');
  assert.equal(soon.text, 'First crack soon.');
  assert.equal(soon.kind, 'info');
  assert.ok(soon.t >= 280 && soon.t <= 300, `fcSoon at ${soon.t}`);
  const fc = r.session.snapshot().events.firstCrack.t;
  assert.deepEqual(times(r, 'dev15'), [fc + 40]);
  assert.deepEqual(times(r, 'dropNow'), [fc + 55]);
  assert.equal(r.fired.find((c) => c.id === 'dev15').text, 'Fifteen seconds.');
  const drop = r.fired.find((c) => c.id === 'dropNow');
  assert.equal(drop.text, 'Drop now.');
  assert.equal(drop.kind, 'critical');
  assert.equal(r.ctx.dropT, fc + 55);
});

test('fast fires hot', () => {
  const r = runRoast({ preset: 'fast' });
  const hot = r.fired.find((c) => c.id === 'hot');
  assert.ok(hot, `fired: ${r.ids}`);
  assert.equal(hot.text, 'Running hot. Lower the heat one step.');
  assert.equal(hot.kind, 'corrective');
  assert.ok(hot.t >= 160 && hot.t <= 180, `hot at ${hot.t}`);   // from 2:30, after 10 s
  assert.ok(!r.ids.includes('slow'));
});

test('slow fires slow', () => {
  const r = runRoast({ preset: 'slow' });
  const slow = r.fired.find((c) => c.id === 'slow');
  assert.ok(slow, `fired: ${r.ids}`);
  assert.equal(slow.text, 'Running slow. Raise the heat one step.');
  assert.ok(slow.t >= 160 && slow.t <= 200, `slow at ${slow.t}`);
  assert.ok(!r.ids.includes('hot'));
});

test('stall fires stall', () => {
  const r = runRoast({ preset: 'stall' });
  const stall = r.fired.find((c) => c.id === 'stall');
  assert.ok(stall, `fired: ${r.ids}`);
  assert.equal(stall.text, 'Stalling. Raise the heat one step.');
  assert.ok(stall.t >= 180 && stall.t <= 240, `stall at ${stall.t}`);
  assert.ok(!r.ids.includes('hot'));
});

test('ror-climb fires rorClimb', () => {
  const r = runRoast({ preset: 'ror-climb' });
  const climb = r.fired.find((c) => c.id === 'rorClimb');
  assert.ok(climb, `fired: ${r.ids}`);
  assert.equal(climb.text, 'Rate of rise is climbing.');
  assert.ok(climb.t > 120 && climb.t < 260, `rorClimb at ${climb.t}`);
  assert.ok(!r.ids.includes('stall') && !r.ids.includes('slow'));
});

test('dropout fires lost once per gap, and re-arms for the next one', () => {
  const r = runRoast({ preset: 'dropout' });
  const lost = r.fired.filter((c) => c.id === 'lost');
  assert.equal(lost.length, 2);
  assert.ok(lost[0].t >= 124 && lost[0].t < 132, `first at ${lost[0].t}`);   // 5 s into 2:00-2:12
  assert.ok(lost[1].t >= 214 && lost[1].t < 218, `second at ${lost[1].t}`);  // 5 s into 3:30-3:38
  assert.equal(lost[0].text, 'Lost the reading.');
  assert.equal(lost[0].kind, 'critical');
  for (const id of [...CORRECTIVE, 'rorClimb']) assert.ok(!r.ids.includes(id), `${id} fired after a dropout`);
});

test('a gap shorter than 5 s does not fire lost', () => {
  const r = runRoast({ source: seriesSource((t) => (t >= 60 && t < 64 ? null : 100 + t * 0.5)), maxSec: 100, user: null });
  assert.ok(!r.ids.includes('lost'));
});

test('lost fires at the start if no reading was ever accepted', () => {
  const r = runRoast({ source: seriesSource(() => null), maxSec: 20, user: null });
  assert.deepEqual(times(r, 'lost'), [4]);
});

// ---------- development countdown and end temperature ----------

test('development countdown: dev15 at target-15, dropNow at target, for other targets too', () => {
  for (const devTargetSec of [45, 55, 65]) {
    const r = runRoast({ preset: 'on-target', settings: { devTargetSec } });
    const fc = r.session.snapshot().events.firstCrack.t;
    assert.deepEqual(times(r, 'dev15'), [fc + devTargetSec - 15], `target ${devTargetSec}`);
    assert.deepEqual(times(r, 'dropNow'), [fc + devTargetSec], `target ${devTargetSec}`);
  }
});

test('nothing about development fires before First crack is marked, or after Drop', () => {
  const r = runRoast({ preset: 'on-target', user: null, maxSec: 420 });
  assert.ok(!r.ids.includes('dev15') && !r.ids.includes('dropNow'));
  const post = runRoast({ preset: 'on-target', maxSec: 420, user: (a) => { autoUser(a); a.ctx.dropT = null; if (a.snapshot.events.drop === null && a.cues.some((c) => c.id === 'dropNow')) a.session.mark('drop'); } });
  assert.deepEqual(post.fired.filter((c) => c.t > post.session.snapshot().events.drop.t), []);
});

test('endTemp fires when the cap is hit before the countdown ends', () => {
  const r = runRoast({ preset: 'on-target', settings: { endTempCapF: 5 }, user: (a) => {
    if (!a.snapshot.events.firstCrack && a.snapshot.raw[a.snapshot.t] >= 410) a.session.mark('firstCrack');
    if (a.cues.some((c) => c.id === 'endTemp')) a.ctx.dropT = a.session.mark('drop').t;   // the user obeys
  } });
  const end = r.fired.find((c) => c.id === 'endTemp');
  assert.ok(end, `fired: ${r.ids}`);
  assert.equal(end.text, 'At end temperature. Drop now.');
  assert.equal(end.kind, 'critical');
  assert.ok(!r.ids.includes('dropNow'), 'the countdown had not finished');
  const snap = r.session.snapshot();
  assert.ok(snap.smooth[end.t] >= FIRST_CRACK_READING + 5);
  assert.ok(snap.smooth[end.t - 1] < FIRST_CRACK_READING + 5);
  assert.equal(times(r, 'endTemp').length, 1);
});

test('endTemp does not fire if the countdown already called the drop', () => {
  // Drop is not tapped, so the roast climbs past the cap after "Drop now".
  const r = runRoast({ preset: 'on-target', maxSec: 420, user: ({ session, snapshot }) => {
    if (!snapshot.events.firstCrack && snapshot.raw[snapshot.t] >= 410) session.mark('firstCrack');
  } });
  assert.ok(r.ids.includes('dropNow'));
  assert.ok(!r.ids.includes('endTemp'));
});

// ---------- corrective rate limits (hand-built snapshots) ----------

// Stall condition every second from `from`: rate of rise 2 F/min.
const stalling = { ror: () => 2, smooth: (i) => 320 + i * 0.03 };

function runSnaps(engine, from, to, make) {
  const fired = [];
  for (let t = from; t <= to; t++) for (const c of engine.tick(make(t))) fired.push(c);
  return fired;
}

test('same cue does not repeat within 40 s', () => {
  const engine = createCueEngine({ settings: DEFAULTS });
  const fired = runSnaps(engine, 100, 300, (t) => snapAt(t, stalling));
  assert.deepEqual(fired.map((c) => c.id), ['stall', 'stall', 'stall', 'stall', 'stall']);
  const ts = fired.map((c) => c.t);
  assert.equal(ts[0], 110);                                   // 10 s persistence
  ts.slice(1).forEach((t, i) => assert.equal(t - ts[i], 40));
});

test('corrective cooldown: with the 40 s repeat out of the way, 20 s still separates cues', () => {
  const engine = createCueEngine({ settings: { ...DEFAULTS, sameCueRepeatSec: 0 } });
  const fired = runSnaps(engine, 100, 200, (t) => snapAt(t, stalling));
  const ts = fired.map((c) => c.t);
  assert.deepEqual(ts, [110, 130, 150, 170, 190]);
});

test('a logged control change restarts the 20 s', () => {
  const engine = createCueEngine({ settings: { ...DEFAULTS, sameCueRepeatSec: 0 } });
  const fired = runSnaps(engine, 100, 200, (t) => snapAt(t, {
    ...stalling,
    heat: t >= 120 ? 3 : 2,
    controls: t >= 120 ? [{ t: 120, kind: 'heat', value: 3 }] : [],
    lastControlT: t >= 120 ? 120 : 0,
  }));
  // 110 fires; the change at 120 holds the next one until 140 (not 130)
  assert.deepEqual(fired.map((c) => c.t), [110, 140, 160, 180, 200]);
});

test('two different corrective cues are still 20 s apart', () => {
  // Reference mode: +12 F above the reference (hot) while the rate of rise also climbs.
  const reference = { readings: Array.from({ length: 400 }, (_, i) => 100 + i), events: {}, controls: [] };
  const engine = createCueEngine({ settings: DEFAULTS, mode: 'reference', reference });
  const fired = runSnaps(engine, 100, 220, (t) => snapAt(t, {
    smooth: (i) => 112 + i,
    ror: (i) => (i < 150 ? 30 : 50),            // climbs from 30 to 50 at t = 150
    mode: 'reference',
  }));
  const ids = fired.map((c) => `${c.id}@${c.t}`);
  const hot = fired.find((c) => c.id === 'hot');
  const climb = fired.find((c) => c.id === 'rorClimb');
  assert.ok(hot && climb, ids.join(' '));
  assert.ok(Math.abs(climb.t - hot.t) >= 20, ids.join(' '));
  // both are ready at 160 (hot is first in priority); the climb waits out the 20 s
  assert.equal(hot.t, 160);
  assert.equal(climb.t, 180);
});

test('critical cues ignore the corrective limits', () => {
  const engine = createCueEngine({ settings: DEFAULTS });
  engine.tick(snapAt(100, stalling)); // start the stall streak
  const fired = runSnaps(engine, 101, 111, (t) => snapAt(t, { ...stalling, lastControlT: t, secondsSinceReading: t >= 108 ? 6 : 0 }));
  // a control change every second blocks the stall cue, but lost still fires
  assert.deepEqual(fired.map((c) => c.id), ['lost']);
});

// ---------- knob limits ----------

test('knob limits: the wording changes at heat 1 and heat 7', () => {
  const reference = { readings: Array.from({ length: 400 }, (_, i) => 100 + i), events: {}, controls: [] };
  const hotAt = (heat) => {
    const e = createCueEngine({ settings: DEFAULTS, mode: 'reference', reference });
    return runSnaps(e, 140, 170, (t) => snapAt(t, { smooth: (i) => 112 + i, heat, mode: 'reference' })).find((c) => c.id === 'hot');
  };
  const slowAt = (heat) => {
    const e = createCueEngine({ settings: DEFAULTS, mode: 'reference', reference });
    return runSnaps(e, 140, 170, (t) => snapAt(t, { smooth: (i) => 80 + i, heat, mode: 'reference' })).find((c) => c.id === 'slow');
  };
  const stallAt = (heat) => {
    const e = createCueEngine({ settings: DEFAULTS });
    return runSnaps(e, 140, 170, (t) => snapAt(t, { ...stalling, heat })).find((c) => c.id === 'stall');
  };
  assert.equal(hotAt(1).text, 'Running hot. Heat is already at its lowest.');
  assert.equal(hotAt(2).text, 'Running hot. Lower the heat one step.');
  assert.equal(hotAt(7).text, 'Running hot. Lower the heat one step.');
  assert.equal(slowAt(7).text, 'Running slow. Heat is already at its highest.');
  assert.equal(slowAt(6).text, 'Running slow. Raise the heat one step.');
  assert.equal(slowAt(1).text, 'Running slow. Raise the heat one step.');
  assert.equal(stallAt(7).text, 'Stalling. Heat is already at its highest.');
  assert.equal(stallAt(1).text, 'Stalling. Raise the heat one step.');
});

// ---------- mute ----------

test('a muted cue is not returned at all', () => {
  const mute = (id) => ({ mute: { ...DEFAULTS.mute, [id]: true } });
  assert.ok(!runRoast({ preset: 'fast', settings: mute('hot') }).ids.includes('hot'));
  assert.ok(!runRoast({ preset: 'slow', settings: mute('slow') }).ids.includes('slow'));
  assert.ok(!runRoast({ preset: 'stall', settings: mute('stall') }).ids.includes('stall'));
  assert.ok(!runRoast({ preset: 'ror-climb', settings: mute('rorClimb') }).ids.includes('rorClimb'));
  assert.ok(!runRoast({ preset: 'dropout', settings: mute('lost') }).ids.includes('lost'));
  const quiet = runRoast({ preset: 'on-target', settings: { mute: { ...DEFAULTS.mute, fcSoon: true, dev15: true, dropNow: true } } });
  assert.deepEqual(quiet.ids, []);
  assert.equal(quiet.ctx.dropT, null, 'with Drop now muted the harness user never gets the prompt');
  // other cues still fire when one is muted
  const some = runRoast({ preset: 'fast', settings: mute('hot') });
  assert.ok(some.ids.includes('fcSoon'));
});

test('muting a corrective cue does not start its cooldown', () => {
  const r = runRoast({ preset: 'fast', settings: { mute: { ...DEFAULTS.mute, hot: true } } });
  assert.ok(!r.ids.includes('hot'));
});

// ---------- fan prompt ----------

test('fan prompt: off by default, "Fan to Low." with First crack soon when on', () => {
  assert.ok(!runRoast({ preset: 'on-target' }).ids.includes('fanPrompt'));
  const r = runRoast({ preset: 'on-target', settings: { fanPrompt: true } });
  const soon = r.fired.find((c) => c.id === 'fcSoon');
  const fan = r.fired.find((c) => c.id === 'fanPrompt');
  assert.equal(fan.text, 'Fan to Low.');
  assert.equal(fan.t, soon.t);
  const already = runRoast({ preset: 'on-target', fan: 'low', settings: { fanPrompt: true } });
  assert.ok(!already.ids.includes('fanPrompt'), 'fan is already Low');
});

// ---------- rate-of-rise hold-off ----------

test('rorClimb is held back 45 s after a logged heat increase', () => {
  const base = runRoast({ preset: 'ror-climb' });
  const t0 = times(base, 'rorClimb')[0];
  const held = runRoast({ preset: 'ror-climb', user: (a) => { if (a.snapshot.t === 190) a.session.setControl('heat', 3); autoUser(a); } });
  const t1 = times(held, 'rorClimb')[0];
  assert.ok(t0 < 235, `without the change: ${t0}`);
  assert.ok(t1 === undefined || t1 >= 190 + 45, `with a heat increase at 190: ${t1}`);
});

test('rorClimb hold-off: a heat increase or a fan decrease holds it back, a heat decrease does not', () => {
  const climbing = { ror: (i) => (i < 150 ? 30 : 50), smooth: (i) => 100 + i };
  const firstClimb = (controls, heat = 2, fan = 'high') => {
    const engine = createCueEngine({ settings: DEFAULTS });
    const out = runSnaps(engine, 130, 260, (t) => snapAt(t, {
      ...climbing, heat, fan,
      controls: controls.filter((c) => c.t <= t), lastControlT: Math.max(0, ...controls.filter((c) => c.t <= t).map((c) => c.t)),
    }));
    return out.find((c) => c.id === 'rorClimb')?.t;
  };
  assert.equal(firstClimb([]), 160);
  // change at 140: the climb is held back until 140 + 45 = 185, then needs its 10 s
  assert.equal(firstClimb([{ t: 140, kind: 'heat', value: 3 }], 3), 195);
  assert.equal(firstClimb([{ t: 140, kind: 'fan', value: 'low' }], 2, 'low'), 195);
  // a decrease does not hold it back (the 20 s corrective wait still applies after a change)
  assert.equal(firstClimb([{ t: 140, kind: 'heat', value: 1 }], 1), 160);   // startHeat 2 -> 1
  assert.equal(firstClimb([{ t: 140, kind: 'fan', value: 'high' }]), 160);
});

test('rorClimb needs 2:00 first and stops after First crack', () => {
  const engine = createCueEngine({ settings: DEFAULTS });
  const climbing = { ror: (i) => (i < 90 ? 30 : 60), smooth: (i) => 100 + i };
  const early = runSnaps(engine, 60, 118, (t) => snapAt(t, climbing));
  assert.deepEqual(early, []);
  const e2 = createCueEngine({ settings: DEFAULTS });
  const late = runSnaps(e2, 60, 200, (t) => snapAt(t, { ...climbing, events: t >= 130 ? { firstCrack: { t: 130, f: 300 } } : {} }));
  assert.ok(late.every((c) => c.id !== 'rorClimb' || c.t < 130));
});

// ---------- Reference mode ----------

// A finished reference roast from the on-target preset, with logged heat and fan changes.
function makeReference(extraControls = []) {
  const r = runRoast({ preset: 'on-target', seed: 5, noise: 0 });
  const record = r.session.finish({ dropT: r.ctx.dropT });
  record.id = 'ref-1';
  record.controls.push(...extraControls);
  return record;
}

// A live roast whose readings follow the reference with an offset.
function liveAgainst(reference, offsetF, { maxSec = 330, heat = 2, settings = {}, user = null } = {}) {
  const readings = reference.readings;
  return runRoast({
    mode: 'reference', reference, heat, settings, maxSec, user,
    source: seriesSource((t) => (t < readings.length ? readings[t] + offsetF : null)),
  });
}

test('reference mode takes first-crack reading and development target from the reference roast', () => {
  const reference = makeReference();
  const snap = createSession({ mode: 'reference', reference }).snapshot();
  assert.equal(snap.mode, 'reference');
  assert.equal(snap.expectedFcF, reference.events.firstCrack.f);
  assert.equal(snap.devTargetSec, reference.results.devSec);
});

test('reference mode: following the reference curve fires no corrective cue', () => {
  const reference = makeReference();
  const r = liveAgainst(reference, 0);
  for (const id of [...CORRECTIVE, 'rorClimb']) assert.ok(!r.ids.includes(id), `${id} fired`);
});

test('reference mode: 10+ F above the reference for 10 s fires hot, below fires slow', () => {
  const reference = makeReference();
  const hot = liveAgainst(reference, 12);
  assert.deepEqual(times(hot, 'hot').slice(0, 1), [160]);          // 2:30 start + 10 s
  assert.ok(!hot.ids.includes('slow'));
  const slow = liveAgainst(reference, -12);
  assert.deepEqual(times(slow, 'slow').slice(0, 1), [160]);
  assert.ok(!slow.ids.includes('hot'));
});

test('reference mode: a 9 F offset is inside the band; exactly the band counts', () => {
  const reference = makeReference();
  assert.ok(!liveAgainst(reference, 9).ids.some((id) => CORRECTIVE.includes(id)));
  // exactly 10 F: constant offset on the smoothed series
  const exact = liveAgainst(reference, 10);
  assert.ok(exact.ids.includes('hot'));
});

test('reference mode: the offset must last 10 s', () => {
  const reference = makeReference();
  const ref = reference.readings;
  // 12 F too hot for 8 s from 2:30, on the smoothed curve (so no smoothing blur)
  const run = (seconds) => {
    const engine = createCueEngine({ settings: DEFAULTS, mode: 'reference', reference });
    return runSnaps(engine, 100, 200, (t) => snapAt(t, {
      mode: 'reference',
      smooth: (i) => smoothedRef(ref, i) + (i >= 150 && i < 150 + seconds ? 12 : 0),
    }));
  };
  assert.deepEqual(run(8).filter((c) => c.id === 'hot'), []);
  assert.deepEqual(run(11).filter((c) => c.id === 'hot').map((c) => c.t), [160]);
});

test('replay prompts fire at the logged times with the right wording', () => {
  const reference = makeReference([
    { t: 150, kind: 'heat', value: 3 },
    { t: 200, kind: 'fan', value: 'low' },
    { t: 260, kind: 'heat', value: 2 },
  ]);
  const r = liveAgainst(reference, 0);
  const replay = r.fired.filter((c) => c.id === 'replay');
  assert.deepEqual(replay.map((c) => [c.t, c.text]), [[150, 'Heat to 3 now.'], [200, 'Fan to Low now.']]);
  // The user has not logged a change, so the app is still at heat 2: "Heat to 2" is not said.
  assert.equal(replay[0].kind, 'info');
  assert.equal(replayText({ kind: 'fan', value: 'high' }), 'Fan to High now.');
});

test('replay prompts follow the user when they have already made the change', () => {
  const reference = makeReference([{ t: 150, kind: 'heat', value: 3 }, { t: 180, kind: 'heat', value: 2 }]);
  const r = liveAgainst(reference, 0, { user: (a) => { if (a.snapshot.t === 152) a.session.setControl('heat', 3); } });
  assert.deepEqual(r.fired.filter((c) => c.id === 'replay').map((c) => [c.t, c.text]), [[150, 'Heat to 3 now.'], [180, 'Heat to 2 now.']]);
});

test('replay skip rule: not if it would undo a corrective cue fired in the last 20 s', () => {
  // hot fires at 160 (asking for a lower heat). A replay "Heat to 3" at 170 would undo it: skipped.
  // "Fan to Low" at 175 would also raise the heat: skipped. "Heat to 1" at 178 agrees with hot: spoken.
  // 185 is 25 s after the cue: outside the window, so "Heat to 3" is spoken.
  const reference = makeReference([
    { t: 170, kind: 'heat', value: 3 },
    { t: 175, kind: 'fan', value: 'low' },
    { t: 178, kind: 'heat', value: 1 },
    { t: 185, kind: 'heat', value: 3 },
  ]);
  const r = liveAgainst(reference, 12);
  assert.deepEqual(times(r, 'hot').slice(0, 1), [160]);
  assert.deepEqual(r.fired.filter((c) => c.id === 'replay').map((c) => [c.t, c.text]), [[178, 'Heat to 1 now.'], [185, 'Heat to 3 now.']]);
});

test('replay skip rule also protects a raise-heat cue from a lower-heat replay', () => {
  const reference = makeReference([{ t: 170, kind: 'heat', value: 1 }, { t: 172, kind: 'fan', value: 'high' }]);
  const r = liveAgainst(reference, -12, { heat: 3 });
  assert.deepEqual(times(r, 'slow').slice(0, 1), [160]);
  // "Heat to 1" undoes "raise the heat"; "Fan to High" cools the roast too (more air): both skipped
  // (the live fan is already high, so that one is skipped as already there)
  assert.deepEqual(r.fired.filter((c) => c.id === 'replay'), []);
});

test('replay prompts can be muted, and do not appear in Starter mode', () => {
  const reference = makeReference([{ t: 150, kind: 'heat', value: 3 }]);
  const muted = liveAgainst(reference, 0, { settings: { mute: { ...DEFAULTS.mute, replay: true } } });
  assert.ok(!muted.ids.includes('replay'));
  const starter = runRoast({ preset: 'on-target' });
  assert.ok(!starter.ids.includes('replay'));
});

// ---------- the closed loop ----------

test('closed loop on fast: obeying "lower the heat one step" leaves a roast that no longer projects before 4:00', () => {
  const open = runRoast({ preset: 'fast' });
  const openFc = open.session.snapshot().events.firstCrack.t;
  assert.ok(openFc < 240, `open loop first crack at ${openFc}`);

  const projections = [];
  const closed = runRoast({
    preset: 'fast',
    user: (a) => {
      const { snapshot, cues, session } = a;
      for (const c of cues) if (c.id === 'hot' && snapshot.heat > 1) session.setControl('heat', snapshot.heat - 1);
      projections.push([snapshot.t, projectedFirstCrack(snapshot, DEFAULTS), snapshot.events.firstCrack]);
      autoUser(a);
    },
  });
  const hot = closed.fired.find((c) => c.id === 'hot');
  assert.ok(hot, 'the cue fired');
  const control = closed.session.snapshot().controls.filter((c) => c.t > 0);
  assert.deepEqual(control.map((c) => [c.t, c.kind, c.value]), [[hot.t, 'heat', 1]]);

  // once the change has worked through the rate window, the projection is no longer early
  const after = projections.filter(([t, p, fc]) => t >= hot.t + 45 && !fc && p !== null);
  assert.ok(after.length > 20, 'projections exist after the change');
  for (const [t, p] of after) assert.ok(p >= DEFAULTS.paceEarlySec, `t=${t}: projected ${p}`);
  const fc = closed.session.snapshot().events.firstCrack.t;
  assert.ok(fc >= DEFAULTS.paceEarlySec, `first crack at ${fc}`);
  assert.equal(closed.ids.filter((id) => id === 'hot').length, 1, 'hot does not fire again');
  assert.ok(!closed.ids.includes('slow'), 'and it did not over-correct into slow');
});

test('closed loop on slow and stall: raising the heat fixes them', () => {
  const raise = () => (a) => {
    for (const c of a.cues) if ((c.id === 'slow' || c.id === 'stall') && a.snapshot.heat < 7) a.session.setControl('heat', a.snapshot.heat + 1);
    autoUser(a);
  };
  const slow = runRoast({ preset: 'slow', user: raise(), maxSec: 600 });
  const fcSlow = slow.session.snapshot().events.firstCrack.t;
  assert.ok(fcSlow <= 420, `slow roast first crack at ${fcSlow}`);
  const stall = runRoast({ preset: 'stall', user: raise(), maxSec: 600 });
  assert.ok(stall.session.snapshot().events.firstCrack, 'the stalled roast reaches first crack');
});

// ---------- projectedFirstCrack guard ----------

test('projectedFirstCrack waits for a rate that is clear of a logged change', () => {
  const src = createSimulatorSource({ preset: 'fast', seed: 1 });
  const s = createSession({ source: src });
  for (let t = 0; t <= 175; t++) {
    s.addReading(src.sample(t));
    if (t === 170) s.setControl('heat', 1);
  }
  assert.equal(projectedFirstCrack(s.snapshot(), DEFAULTS), null);   // 5 s after the change
  for (let t = 176; t <= 230; t++) s.addReading(src.sample(t));
  assert.notEqual(projectedFirstCrack(s.snapshot(), DEFAULTS), null);
});
