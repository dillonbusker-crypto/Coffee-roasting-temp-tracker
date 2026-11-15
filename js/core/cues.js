// The cue engine. Pure: tick(snapshot) returns the cues that fire this second.
// It does not speak or log; the caller does that (and calls session.logCue).
//
// Rules on top of the spec's table (see DESIGN.md):
// - Corrective cues are hot, slow, stall and rorClimb. At most one per correctiveCooldownSec,
//   and a logged heat or fan change restarts that wait. The same cue never repeats within
//   sameCueRepeatSec.
// - hot, slow, stall and rorClimb only run before First crack is tapped.
// - hot and slow need their condition to hold for persistSec. In Reference mode they compare
//   with the reference curve (+/- referenceBandF); the Starter pace limits still apply too.
// - slow is not raised while stall is (a stall already asks for more heat).
// - rorClimb is held back after a logged heat increase or fan decrease: the user caused it.
// - dropNow, endTemp and lost are critical and ignore the corrective limits.

import { projectFirstCrack, smoothSeries } from './calc.js';
import { DEFAULTS } from './settings.js';

const TEXT = {
  hot: 'Running hot. Lower the heat one step.',
  hotAtLimit: 'Running hot. Heat is already at its lowest.',
  slow: 'Running slow. Raise the heat one step.',
  slowAtLimit: 'Running slow. Heat is already at its highest.',
  stall: 'Stalling. Raise the heat one step.',
  stallAtLimit: 'Stalling. Heat is already at its highest.',
  rorClimb: 'Rate of rise is climbing.',
  fcSoon: 'First crack soon.',
  fanPrompt: 'Fan to Low.',
  dev15: 'Fifteen seconds.',
  dropNow: 'Drop now.',
  endTemp: 'At end temperature. Drop now.',
  lost: 'Lost the reading.',
};

const KIND = {
  hot: 'corrective', slow: 'corrective', stall: 'corrective', rorClimb: 'corrective',
  fcSoon: 'info', fanPrompt: 'info', dev15: 'info', replay: 'info',
  dropNow: 'critical', endTemp: 'critical', lost: 'critical',
};

// Direction a corrective cue (or replay prompt) pushes the roast, for the replay skip rule.
// Closest the two rates in a projection may be.
const MIN_SEPARATION_SEC = 15;

const CUE_DIR = { hot: 'down', slow: 'up', stall: 'up' };

// The rate about lagSec ago, for projectFirstCrack. It must come from after the last
// logged heat or fan change has worked through the rate window (a change makes the rate
// jump, and a fit across the jump gives nonsense). If that second has no rate (a dropout),
// take a later one and report how far back it really is. Null if there is none.
function earlierRor(ror, t, lagSec, notBefore) {
  const start = Math.max(t - lagSec, notBefore);
  for (let i = start; i <= start + 10 && t - i >= MIN_SEPARATION_SEC; i++) {
    if (ror[i] != null) return { ror: ror[i], lagSec: t - i };
  }
  return null;
}

// Projected elapsed second of first crack from a session snapshot, using the current
// settings; null when it cannot be computed (no rate yet, or too soon after a logged
// change), Infinity if the roast will never get there. The cue engine uses this too.
export function projectedFirstCrack(snap, settings = DEFAULTS) {
  const S = { ...DEFAULTS, ...settings };
  const t = snap.t;
  const temp = snap.smooth[t] ?? null;
  if (temp === null) return null;
  // After a logged change the rate is not trustworthy until the window has cleared it
  // (plus enough time for a second rate to compare with): wait and see its effect.
  const settledFrom = snap.lastControlT > 0 ? snap.lastControlT + S.rorWindowSec : 0;
  if (settledFrom > 0 && t - settledFrom < MIN_SEPARATION_SEC) return null;
  const earlier = earlierRor(snap.ror, t, S.projectionLagSec, settledFrom);
  return projectFirstCrack({
    t,
    temp,
    ror: snap.ror[t] ?? null,
    rorEarlier: earlier?.ror ?? null,
    lagSec: earlier?.lagSec ?? S.projectionLagSec,
    rorLagSec: (S.rorWindowSec - 1) / 2,
    targetF: snap.expectedFcF,
  });
}

export const replayText = (control) =>
  control.kind === 'heat'
    ? `Heat to ${control.value} now.`
    : `Fan to ${control.value === 'low' ? 'Low' : 'High'} now.`;

export function createCueEngine({ settings = DEFAULTS, mode = 'starter', reference = null } = {}) {
  const S = { ...DEFAULTS, ...settings };
  const mute = { ...DEFAULTS.mute, ...(settings.mute || {}) };
  const refMode = mode === 'reference' && !!reference;
  const refSmooth = refMode ? smoothSeries(reference.readings || [], S.smoothSec) : [];
  const replayList = refMode ? (reference.controls || []).filter((c) => c.t > 0) : [];

  const since = { hot: null, slow: null, stall: null, rorClimb: null };
  const lastFired = {};
  let lastCorrective = null;     // { t } of the last corrective cue
  let lastStep = null;           // { t, dir } of the last cue that asked for a heat step
  let lostArmed = true;
  let fcSoonDone = false;
  let dev15Done = false;
  let dropNowDone = false;
  let endTempDone = false;
  let replayIdx = 0;

  // True once cond has held for persistSec in a row.
  function held(key, cond, t) {
    if (!cond) { since[key] = null; return false; }
    if (since[key] === null) since[key] = t;
    return t - since[key] >= S.persistSec;
  }

  function lastClimbCauseT(controls) {
    let heat = null;
    let fan = null;
    let cause = null;
    for (const c of controls) {
      if (c.kind === 'heat') {
        if (heat !== null && c.value > heat) cause = c.t;
        heat = c.value;
      } else if (c.kind === 'fan') {
        if (fan !== null && c.value === 'low' && fan === 'high') cause = c.t;
        fan = c.value;
      }
    }
    return cause;
  }

  function make(id, t, text) {
    return { id, t, text, kind: KIND[id] };
  }

  function tick(snap) {
    const out = [];
    const { t, events } = snap;
    if (events.drop) return out;
    const emit = (id, text) => { if (!mute[id]) out.push(make(id, t, text)); };

    // Lost reading: once per gap, re-armed by the next accepted reading.
    if (snap.secondsSinceReading === 0) lostArmed = true;
    else if (lostArmed && snap.secondsSinceReading >= S.lostSec) {
      lostArmed = false;
      emit('lost', TEXT.lost);
    }

    const fc = events.firstCrack;
    const temp = snap.temp;

    if (!fc) {
      // Corrective cues.
      const r = snap.ror[t] ?? null;
      const s = snap.smooth[t] ?? null;

      const stallCond = r !== null && r < S.stallRorFPerMin;

      let hotCond = false;
      let slowCond = false;
      if (t >= S.paceStartSec && s !== null) {
        const projected = projectedFirstCrack(snap, S);
        if (projected !== null) {
          hotCond = projected < S.paceEarlySec;
          slowCond = projected > S.paceLateSec;
        }
        if (refMode && refSmooth[t] != null) {
          hotCond = hotCond || s - refSmooth[t] >= S.referenceBandF;
          slowCond = slowCond || refSmooth[t] - s >= S.referenceBandF;
        }
      }
      slowCond = slowCond && !stallCond;

      let climbCond = false;
      if (t >= S.climbAfterSec && r !== null) {
        let low = r;
        for (let i = Math.max(0, t - S.climbLookbackSec); i < t; i++) {
          if (snap.ror[i] != null && snap.ror[i] < low) low = snap.ror[i];
        }
        const cause = lastClimbCauseT(snap.controls);
        const heldBack = cause !== null && t - cause < S.climbHoldoffSec;
        climbCond = r - low >= S.climbRorFPerMin && !heldBack;
      }

      const ready = {
        stall: held('stall', stallCond, t),
        hot: held('hot', hotCond, t),
        slow: held('slow', slowCond, t),
        rorClimb: held('rorClimb', climbCond, t),
      };

      const cooledDown =
        (lastCorrective === null || t - lastCorrective.t >= S.correctiveCooldownSec) &&
        t - snap.lastControlT >= S.correctiveCooldownSec;

      if (cooledDown) {
        for (const id of ['stall', 'hot', 'slow', 'rorClimb']) {
          if (!ready[id] || mute[id]) continue;
          if (lastFired[id] !== undefined && t - lastFired[id] < S.sameCueRepeatSec) continue;
          let text = TEXT[id];
          if (id === 'hot' && snap.heat <= 1) text = TEXT.hotAtLimit;
          if ((id === 'slow' || id === 'stall') && snap.heat >= 7) text = TEXT[id + 'AtLimit'];
          lastFired[id] = t;
          lastCorrective = { t };
          if (CUE_DIR[id]) lastStep = { t, dir: CUE_DIR[id] };
          out.push(make(id, t, text));
          break;
        }
      }

      // First crack soon, with the optional fan prompt alongside.
      if (!fcSoonDone && temp !== null && temp >= snap.expectedFcF - S.fcSoonF) {
        fcSoonDone = true;
        emit('fcSoon', TEXT.fcSoon);
        if (S.fanPrompt && snap.fan !== 'low') emit('fanPrompt', TEXT.fanPrompt);
      }
    } else {
      // Development countdown.
      const devSec = snap.devSec ?? t - fc.t;
      const target = snap.devTargetSec;
      if (!dev15Done && devSec >= target - 15 && devSec < target) {
        dev15Done = true;
        emit('dev15', TEXT.dev15);
      }
      if (!dropNowDone && devSec >= target) {
        dropNowDone = true;
        dev15Done = true;
        emit('dropNow', TEXT.dropNow);
      }
    }

    // End temperature: the cap is reached before the countdown has called the drop.
    if (!endTempDone && !dropNowDone && temp !== null && temp >= snap.expectedFcF + S.endTempCapF) {
      endTempDone = true;
      emit('endTemp', TEXT.endTemp);
    }

    // Replay prompts (Reference mode): the reference roast's logged changes, at the same times.
    while (replayIdx < replayList.length && replayList[replayIdx].t <= t) {
      const c = replayList[replayIdx++];
      if (t - c.t > 10) continue; // too late to be useful (the engine started late)
      let dir = null;
      if (c.kind === 'heat' && c.value !== snap.heat) dir = c.value > snap.heat ? 'up' : 'down';
      if (c.kind === 'fan' && c.value !== snap.fan) dir = c.value === 'low' ? 'up' : 'down'; // less air runs hotter
      if (dir === null) continue; // already there
      const undoes =
        lastStep && lastStep.dir !== dir && t - lastStep.t < S.replayUndoWindowSec;
      if (undoes) continue;
      emit('replay', replayText(c));
    }

    return out;
  }

  return { tick };
}
