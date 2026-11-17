// Time confirmation for tentative readings. Pure: no DOM, no timers. The caller passes the time of each frame.
//
//   const c = createConfirmer();
//   res = c.step(res, at);     // res = readDisplay(...) result, at = ms when the picture was taken -> the same result, or an upgraded one
//   c.reset();
//
// Why. A reflection that veils a lit segment lowers its contrast to a quarter or half of what it should be, which is too faint to
// call lit from one picture. But a veil holds still, and a real change does not: when the LCD switches a segment it goes from
// 0.13 to 0.59 to 0.73 of its full contrast in 33 ms steps (off: 0.34, 0.15, 0.07, then a ghost for ~200 ms), so a segment that is
// changing moves by more than 0.2 between two pictures taken 60 ms apart. readDisplay() therefore reports, besides its strict
// answer, a tentative one (`debug.tentative`: every segment that might be lit counts as lit) and the evidence behind every
// segment (`debug.seg7`: the lit/unlit pattern and each segment's contrast relative to what a lit one should show).
//
// Rule. A frame whose strict answer is "none" but which has a tentative reading becomes an ok reading when an earlier frame, between
// `minGapMs` and `maxGapMs` before it, shows the same segment pattern with every segment's contrast within `tol`. Both frames
// then say the same thing about all 21 segments, and nothing was changing between them. A frame caught in the middle of a change
// has a different pattern from its neighbour, or segments that moved by far more than `tol`, and stays a miss; so does a
// reflection that is moving across the digits. A strictly read frame also serves as the earlier frame.
//
// A confirmed frame is a good frame for the filter, like any other: the filter still applies its range, jump and per-second rules.
// The upgraded result keeps the strict reading's fields and adds `debug.confirmed = { gapMs, maxDelta }`. A tentative frame that is
// not confirmed is returned as a miss with the reason 'unconfirmed reading' (the strict reason stays in `debug.strictReason`).

export const CONFIRM_DEFAULTS = {
  tol: 0.15,        // every segment's relative contrast must agree to this much
  minGapMs: 30,     // the earlier frame must be at least this much older (two reads of the same picture prove nothing)
  maxGapMs: 400,    // ... and at most this old (a slow phone may skip a picture or two)
  keep: 1,          // how many earlier frames are compared: only the one just before, so a reflection that sways back and forth cannot match
                    //   a picture from two steps ago while the one in between disagrees
};

/** Do two segment evidences agree: the same lit/unlit pattern, every contrast within tol? Returns the largest difference or null. */
export function seg7Agree(a, b, tol = CONFIRM_DEFAULTS.tol) {
  if (!a || !b || !a.masks || !b.masks || !a.c || !b.c) return null;
  if (a.masks.length !== b.masks.length || a.c.length !== b.c.length) return null;
  for (let i = 0; i < a.masks.length; i++) if (a.masks[i] !== b.masks[i]) return null;
  let worst = 0;
  for (let i = 0; i < a.c.length; i++) {
    if (a.c[i].length !== b.c[i].length) return null;
    for (let k = 0; k < a.c[i].length; k++) {
      const d = Math.abs(a.c[i][k] - b.c[i][k]);
      if (!(d <= tol)) return null;
      if (d > worst) worst = d;
    }
  }
  return worst;
}

export function createConfirmer(opts = {}) {
  const cfg = Object.assign({}, CONFIRM_DEFAULTS, opts);
  let prev = []; // [{ at, seg7 }], newest first

  return {
    step(res, at) {
      const seg7 = res && res.debug && res.debug.seg7;
      let out = res;
      const tent = res && res.status === 'none' && res.debug && res.debug.tentative;
      if (tent && seg7) {
        let hit = null;
        for (const p of prev) {
          const gap = at - p.at;
          if (gap < cfg.minGapMs || gap > cfg.maxGapMs) continue;
          const worst = seg7Agree(p.seg7, seg7, cfg.tol);
          if (worst !== null) { hit = { gapMs: Math.round(gap), maxDelta: +worst.toFixed(3) }; break; }
        }
        if (hit) {
          out = Object.assign({}, res, {
            status: 'ok', value: tent.value, digits: tent.digits, confidence: tent.confidence,
            debug: Object.assign({}, res.debug, { confirmed: hit, strictReason: res.debug.reason, reason: undefined }),
          });
        } else {
          out = Object.assign({}, res, { debug: Object.assign({}, res.debug, { strictReason: res.debug.reason, reason: 'unconfirmed reading' }) });
        }
      }
      if (seg7) { prev.unshift({ at, seg7 }); if (prev.length > cfg.keep) prev.length = cfg.keep; }
      return out;
    },
    reset() { prev = []; },
  };
}
