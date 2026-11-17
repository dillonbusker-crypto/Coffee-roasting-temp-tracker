// Per-second filter for the digit reader. Pure: no DOM, no timers.
//
//   const f = createReadingFilter({ minF: 50, maxF: 550, maxJumpF: 15 });
//   f.addFrame(frameResult);   // frameResult: { status: 'ok'|'dashes'|'none', value } from readDisplay()
//   f.closeSecond();           // -> accepted value (whole degrees F) or null for this second
//   f.reanchor(value);         // trust `value` as the last accepted reading (manual entry)
//   f.health();                // counters, see below
//   f.lastOutcome();           // what the last closeSecond() did, for diagnostics (see below)
//
// Rules (docs/SPEC.md, docs/DESIGN.md):
//  * a value the thermometer cannot show is a misread (see `wholeCelsius`) and does not count as a frame;
//  * one value per second, and always one that was actually seen (never an average): the latest value that at least two frames
//    read, or the latest value when none has two (a display that changes twice a second legitimately holds two values in one
//    second, and the later one is the better reading of that second). Frames that disagree wildly (further apart than
//    `frameSpreadF`) with no majority end the second as a disagreement;
//  * a value outside minF..maxF is discarded and counted;
//  * a value that does not fit the recent readings is not accepted at once (see "Jumps" below);
//  * a second whose frames show dashes (no probe) is a missing second, not a value, and is not a discard.
//
// Whole-degree Celsius. The real TP17 only ever shows °F values that are round(1.8 * c + 32) for a whole number c (every value in
// the user's first video, 9 photos and 426 s roast), so 4 of every 9 whole °F numbers (254, 263, 265 ...) cannot appear. A frame
// that reads one of them is a misread. This rests on one unit; `wholeCelsius: false` switches the check off.
//
// Jumps. A reading is accepted at once when it lies within a soft bound of what the last accepted readings predict: the last
// value plus the recent trend (up to `trendSeconds` ahead), plus or minus `trendTolF` (+ `trendTolPerSecF` per second since); with
// no usable trend, `maxJumpF` + `jumpPerSecF` per second since, about the last value; never more than `maxSoftF`. Anything else is
// a candidate. A candidate becomes the new anchor only when later seconds back it up: `reanchorSeconds` candidates in a row that
// agree with each other (`reanchorStaleSeconds` when the last accepted reading is old, `staleAfterSeconds`), however many seconds in
// between were missing. An isolated wrong second is never accepted; a real change costs a few seconds, not the rest of the roast.

export function createReadingFilter(opts = {}) {
  const cfg = Object.assign({
    minF: 50, maxF: 550,
    maxJumpF: 15,            // soft bound about the last value when there is no usable trend
    jumpPerSecF: 5,          //   and per second since it (the roaster climbs up to 5 °F/s)
    maxSoftF: 40,            //   but never above this
    trendTolF: 7,            // soft bound about the predicted value when the recent trend is known
    trendTolPerSecF: 1,      //   and per second since the last accepted reading
    nearF: 9,                // a value within this of the last accepted one (plus nearPerSecF per second beyond the first) is also fine,
    nearPerSecF: 2,          //   whatever the trend says: a trend extrapolated over a swing of the display must not lock the filter out
    trendSeconds: 6,         // the trend is extrapolated at most this far, and only while the last reading is this recent
    maxRateF: 6,             // trend clamp, °F per second
    reanchorSeconds: 3,      // candidates in a row that must agree before they become the anchor ...
    reanchorStaleSeconds: 2, //   ... or this many when the last accepted reading is older than staleAfterSeconds
    staleAfterSeconds: 6,
    agreeStepF: 5,           // two candidates agree when they differ by at most this plus agreePerSecF per second apart
    agreePerSecF: 5,
    candidateWindowSeconds: 12,
    frameSpreadF: 12,        // frames further apart than this, with no clear majority, are a disagreement
    wholeCelsius: true,      // only values round(1.8 c + 32) for whole c can be shown (see above)
  }, opts);

  let frames = [];           // ok values of this second, in the order they were read
  let dashFrames = 0, noneFrames = 0, impossibleFrames = [];
  let last = null, lastT = 0;  // last accepted value and the second it was accepted in
  let history = [];          // accepted [t, value], newest last
  let cands = [];            // jump candidates [t, value], newest last
  let t = 0;                 // seconds closed
  // Why the last second ended as it did:
  //   { kind: 'read'|'missing'|'disagree'|'range'|'impossible'|'jump', value?, last?, allowed?, dashes?, values? }
  let outcome = { kind: 'missing' };
  const h = {
    secondsRead: 0, rejected: 0, rejectedRange: 0, rejectedJump: 0, rejectedDisagree: 0, rejectedImpossible: 0,
    secondsMissing: 0, dashSeconds: 0, reanchors: 0,
    framesOk: 0, framesDashes: 0, framesNone: 0, framesImpossible: 0, secondsClosed: 0,
  };

  const possible = v => !cfg.wholeCelsius || isWholeCelsiusF(v);

  function trend() {
    // least-squares slope over the last few accepted readings, which must span at least two seconds
    const pts = history.filter(p => p[0] >= t - 8).slice(-6);
    if (pts.length < 2 || pts[pts.length - 1][0] - pts[0][0] < 2) return null;
    const n = pts.length;
    const mt = pts.reduce((a, p) => a + p[0], 0) / n, mv = pts.reduce((a, p) => a + p[1], 0) / n;
    let num = 0, den = 0;
    for (const [pt, pv] of pts) { num += (pt - mt) * (pv - mv); den += (pt - mt) ** 2; }
    if (!den) return null;
    return Math.max(-cfg.maxRateF, Math.min(cfg.maxRateF, num / den));
  }

  // The soft bound for a value now: { expected, allowed }.
  function bound() {
    const g = t - lastT;
    const slope = g <= cfg.trendSeconds ? trend() : null;
    if (slope !== null) return { expected: last + slope * Math.min(g, cfg.trendSeconds), allowed: Math.min(cfg.maxSoftF, cfg.trendTolF + cfg.trendTolPerSecF * g), trend: true };
    return { expected: last, allowed: Math.min(cfg.maxSoftF, cfg.maxJumpF + cfg.jumpPerSecF * g), trend: false };
  }

  return {
    addFrame(res) {
      if (res && res.status === 'ok' && Number.isFinite(res.value)) {
        if (possible(res.value)) { frames.push(res.value); h.framesOk++; }
        else { impossibleFrames.push(res.value); h.framesImpossible++; }
      } else if (res && res.status === 'dashes') { dashFrames++; h.framesDashes++; }
      else { noneFrames++; h.framesNone++; }
    },

    closeSecond() {
      h.secondsClosed++; t++;
      const okVals = frames, dashes = dashFrames, imp = impossibleFrames;
      frames = []; dashFrames = 0; noneFrames = 0; impossibleFrames = [];
      cands = cands.filter(c => c[0] >= t - cfg.candidateWindowSeconds);

      if (!okVals.length || dashes >= okVals.length) {
        if (!okVals.length && imp.length > dashes) { // the only readings were numbers the thermometer cannot show
          h.rejected++; h.rejectedImpossible++;
          outcome = { kind: 'impossible', value: imp[imp.length - 1], values: imp.slice() };
          return null;
        }
        h.secondsMissing++;
        if (dashes) h.dashSeconds++;
        outcome = { kind: 'missing', dashes: dashes > 0 };
        return null;
      }

      // The second's value is one that was seen: the latest one that at least two frames agree on; if no value has two frames, the
      // latest. A display that changes twice a second (270 -> 264) so gives the value it ended on, while one odd frame at the end
      // (a picture caught mid-change, a misread) does not outvote what the rest of the second saw.
      const count = new Map(), lastAt = new Map();
      okVals.forEach((x, i) => { count.set(x, (count.get(x) || 0) + 1); lastAt.set(x, i); });
      let v = null;
      for (const [val, n] of count) {
        if (v === null) { v = val; continue; }
        const twoNow = n >= 2, twoBest = count.get(v) >= 2;
        if (twoNow !== twoBest ? twoNow : lastAt.get(val) > lastAt.get(v)) v = val;
      }
      const lo = Math.min(...okVals), hi = Math.max(...okVals);
      if (hi - lo > cfg.frameSpreadF && count.get(v) * 2 <= okVals.length) { // contradictory frames, no clear majority
        h.rejected++; h.rejectedDisagree++;
        outcome = { kind: 'disagree', values: okVals.slice().sort((a, b) => a - b) };
        return null;
      }

      if (v < cfg.minF || v > cfg.maxF) { h.rejected++; h.rejectedRange++; outcome = { kind: 'range', value: v }; return null; }

      if (last !== null) {
        const b = bound();
        const near = Math.min(cfg.maxSoftF, Math.min(cfg.nearF, cfg.maxJumpF) + cfg.nearPerSecF * Math.max(0, t - lastT - 1));
        if (Math.abs(v - b.expected) > b.allowed && Math.abs(v - last) > near) {
          h.rejected++; h.rejectedJump++;
          outcome = { kind: 'jump', value: v, last, allowed: Math.round(b.allowed), expected: Math.round(b.expected) };
          cands.push([t, v]);
          const need = (t - lastT) > cfg.staleAfterSeconds ? cfg.reanchorStaleSeconds : cfg.reanchorSeconds;
          if (consistent(cands, need)) {
            h.reanchors++;
            return accept(v);
          }
          return null;
        }
      }
      return accept(v);
    },

    reanchor(value) {
      last = value; lastT = t; history = [[t, value]]; cands = [];
    },

    lastOutcome() { return outcome; },

    health() {
      return Object.assign({}, h, { lastAccepted: last, secondsSinceAccepted: last === null ? null : t - lastT });
    },
  };

  // the newest `need` candidates agree with each other (each with the one before it)
  function consistent(list, need) {
    if (list.length < need) return false;
    const tail = list.slice(-need);
    for (let i = 1; i < tail.length; i++) {
      const dt = tail[i][0] - tail[i - 1][0];
      if (Math.abs(tail[i][1] - tail[i - 1][1]) > cfg.agreeStepF + cfg.agreePerSecF * dt) return false;
    }
    return true;
  }

  function accept(v) {
    last = v; lastT = t; cands = [];
    history.push([t, v]);
    if (history.length > 12) history.shift();
    outcome = { kind: 'read', value: v };
    h.secondsRead++;
    return v;
  }
}

/** True for the °F values a thermometer that converts a whole °C reading can show: round(1.8 c + 32). */
export function isWholeCelsiusF(f) {
  if (!Number.isInteger(f)) return false;
  const c = Math.round((f - 32) / 1.8); // the nearest whole °C ...
  return Math.round(1.8 * c + 32) === f; // ... must convert back to exactly this value
}
