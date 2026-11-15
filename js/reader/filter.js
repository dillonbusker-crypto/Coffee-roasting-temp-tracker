// Per-second filter for the digit reader. Pure: no DOM, no timers.
//
//   const f = createReadingFilter({ minF: 50, maxF: 550, maxJumpF: 15 });
//   f.addFrame(frameResult);   // frameResult: { status: 'ok'|'dashes'|'none', value } from readDisplay()
//   f.closeSecond();           // -> accepted value (whole degrees F) or null for this second
//   f.reanchor(value);         // trust `value` as the last accepted reading (manual entry)
//   f.health();                // counters, see below
//
// Rules (docs/SPEC.md, docs/DESIGN.md):
//  * one value per second: the median of that second's `ok` frames, provided most of them agree;
//  * a value outside minF..maxF is discarded and counted;
//  * a value further from the last accepted one than maxJumpF + jumpPerSecF * (seconds since it) is discarded and counted;
//  * `jumpResetSeconds` consecutive seconds discarded for jump that agree with each other re-anchor the filter to them;
//  * a second whose frames show dashes (no probe) is a missing second, not a value, and is not a discard.

export function createReadingFilter(opts = {}) {
  const cfg = Object.assign({
    minF: 50, maxF: 550, maxJumpF: 15,
    jumpPerSecF: 2,          // extra allowance per second since the last accepted value
    jumpResetSeconds: 5,     // consecutive jump-rejected seconds that re-anchor if they agree
    agreeStepF: 4,           // those seconds must move no more than this between neighbours
    agreeSpanF: 15,          //   and no more than this overall
    frameAgreeF: 2,          // frames of one second must lie within this of their median to count as agreeing
  }, opts);

  let frames = [];           // ok values this second
  let dashFrames = 0, noneFrames = 0;
  let last = null;           // last accepted value
  let sinceAccepted = 0;     // seconds closed since `last` was accepted (1 = the previous second)
  let streak = [];           // consecutive jump-rejected second values
  const h = {
    secondsRead: 0, rejected: 0, rejectedRange: 0, rejectedJump: 0, rejectedDisagree: 0,
    secondsMissing: 0, dashSeconds: 0, reanchors: 0,
    framesOk: 0, framesDashes: 0, framesNone: 0, secondsClosed: 0,
  };

  function median(sorted) {
    const n = sorted.length;
    return n % 2 ? sorted[(n - 1) / 2] : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
  }

  return {
    addFrame(res) {
      if (res && res.status === 'ok' && Number.isFinite(res.value)) { frames.push(res.value); h.framesOk++; }
      else if (res && res.status === 'dashes') { dashFrames++; h.framesDashes++; }
      else { noneFrames++; h.framesNone++; }
    },

    closeSecond() {
      h.secondsClosed++;
      if (last !== null) sinceAccepted++;
      const okVals = frames, dashes = dashFrames;
      frames = []; dashFrames = 0; noneFrames = 0;

      if (!okVals.length || dashes >= okVals.length) {
        h.secondsMissing++;
        if (dashes) h.dashSeconds++;
        streak = [];
        return null;
      }
      okVals.sort((a, b) => a - b);
      const m = median(okVals);
      const near = okVals.filter(v => Math.abs(v - m) <= cfg.frameAgreeF);
      if (okVals.length > 1 && near.length * 2 <= okVals.length) { // no clear majority: frames contradict each other
        h.rejected++; h.rejectedDisagree++; streak = [];
        return null;
      }
      const v = median(near);

      if (v < cfg.minF || v > cfg.maxF) { h.rejected++; h.rejectedRange++; streak = []; return null; }

      if (last !== null) {
        const allowed = cfg.maxJumpF + cfg.jumpPerSecF * sinceAccepted;
        if (Math.abs(v - last) > allowed) {
          h.rejected++; h.rejectedJump++;
          streak.push(v);
          if (streak.length > cfg.jumpResetSeconds) streak.shift();
          if (streak.length === cfg.jumpResetSeconds && agrees(streak, cfg)) {
            h.reanchors++;
            streak = [];
            return accept(v);
          }
          return null;
        }
      }
      return accept(v);
    },

    reanchor(value) {
      last = value; sinceAccepted = 0; streak = [];
    },

    health() {
      return Object.assign({}, h, { lastAccepted: last, secondsSinceAccepted: last === null ? null : sinceAccepted });
    },
  };

  function accept(v) {
    last = v; sinceAccepted = 0; streak = [];
    h.secondsRead++;
    return v;
  }
}

function agrees(vals, cfg) {
  let lo = vals[0], hi = vals[0];
  for (let i = 1; i < vals.length; i++) {
    if (Math.abs(vals[i] - vals[i - 1]) > cfg.agreeStepF) return false;
    lo = Math.min(lo, vals[i]); hi = Math.max(hi, vals[i]);
  }
  return hi - lo <= cfg.agreeSpanF;
}
