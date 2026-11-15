// Pure maths. Temperatures °F, times in elapsed seconds, rates °F/min.
// raw[i] is the reading at second i (a number or null for a gap).

// Mean of the accepted readings in the last windowSec seconds (indices t-w+1..t).
export function smoothAt(raw, t, windowSec = 10) {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, t - windowSec + 1); i <= t; i++) {
    const v = raw[i];
    if (v != null) { sum += v; n++; }
  }
  return n ? sum / n : null;
}

// Least-squares slope through smooth[t-w+1..t], in °F/min. Null before one full
// window of time has passed, or if fewer than half the points in the window exist.
export function rorAt(smooth, t, windowSec = 30) {
  if (t < windowSec) return null;
  const from = t - windowSec + 1;
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = from; i <= t; i++) {
    const v = smooth[i];
    if (v != null) { n++; sx += i; sy += v; }
  }
  if (n < 2 || n < windowSec / 2) return null;
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = from; i <= t; i++) {
    const v = smooth[i];
    if (v != null) { sxy += (i - mx) * (v - my); sxx += (i - mx) * (i - mx); }
  }
  return (sxy / sxx) * 60;
}

// Whole-series helpers. A second with no reading has no smoothed value either, so
// gaps stay gaps on the chart.
export function smoothSeries(raw, windowSec = 10) {
  return raw.map((v, t) => (v == null ? null : smoothAt(raw, t, windowSec)));
}

export function rorSeries(smooth, windowSec = 30) {
  return smooth.map((v, t) => (v == null ? null : rorAt(smooth, t, windowSec)));
}

// Smoothed value only when its window is complete: at least 80% of the last windowSec
// seconds hold a reading. A window that is mostly empty (the seconds after a dropout, or
// the first seconds of a roast) averages older points than usual, so it sits above the
// true curve by a few degrees and would bend the rate of rise. Such seconds are skipped
// when fitting the rate.
export function trustedSmoothAt(raw, t, windowSec = 10, minFrac = 0.8) {
  if (t < windowSec - 1) return null;
  let n = 0;
  for (let i = t - windowSec + 1; i <= t; i++) if (raw[i] != null) n++;
  return n >= minFrac * windowSec ? smoothAt(raw, t, windowSec) : null;
}

// The smoothed and rate-of-rise series for a whole roast, computed exactly as a live
// session computes them second by second.
export function analyzeSeries(raw, smoothSec = 10, rorWindowSec = 30) {
  const smooth = [];
  const trusted = [];
  const ror = [];
  for (let t = 0; t < raw.length; t++) {
    smooth.push(raw[t] == null ? null : smoothAt(raw, t, smoothSec));
    trusted.push(raw[t] == null ? null : trustedSmoothAt(raw, t, smoothSec));
    ror.push(raw[t] == null ? null : rorAt(trusted, t, rorWindowSec));
  }
  return { smooth, ror };
}

// Elapsed second at which temp is projected to reach targetF.
// Infinity if it never will; null if it cannot be computed.
//
// An air roaster's curve flattens as it climbs, so a straight line projected at
// 2:30 lands far too early. Compare the rate now with the rate lagSec ago; if it is
// falling, fit an exponential approach to an asymptote and solve for the target.
//
// rorLagSec is how stale the rate is compared with temp: a least-squares slope
// describes the middle of its window, (windowSec - 1) / 2 seconds back. The fit
// decays the rate forward over that gap, which removes a bias of 20-30 s at 2:30.
export function projectFirstCrack({ t, temp, ror, rorEarlier, lagSec = 45, rorLagSec = 0, targetF }) {
  if (t == null || temp == null || targetF == null) return null;
  if (temp >= targetF) return t;
  if (ror == null) return null;
  if (ror <= 0) return Infinity;
  if (rorEarlier != null && rorEarlier > ror) {
    const tau = lagSec / Math.log(rorEarlier / ror);
    const rorNow = ror * Math.exp(-rorLagSec / tau);
    const asymptote = temp + (rorNow * tau) / 60;
    if (asymptote <= targetF) return Infinity;
    return t - tau * Math.log((asymptote - targetF) / (asymptote - temp));
  }
  return t + ((targetF - temp) / ror) * 60;
}

// events: { yellow, firstCrack, drop }, each { t, f } or null.
// Returns { drying, browning, development }, each { sec, pct } or null.
// Without Yellow, drying is null and browning covers Start..First crack.
export function phaseSummary(events, totalSec) {
  const out = { drying: null, browning: null, development: null };
  if (!(totalSec > 0)) return out;
  const yellow = events?.yellow?.t ?? null;
  const fc = events?.firstCrack?.t ?? null;
  const drop = events?.drop?.t ?? totalSec;
  const seg = (a, b) => {
    if (a == null || b == null || b < a) return null;
    return { sec: b - a, pct: ((b - a) / totalSec) * 100 };
  };
  if (yellow != null) {
    out.drying = seg(0, yellow);
    out.browning = seg(yellow, fc);
  } else {
    out.browning = seg(0, fc);
  }
  out.development = seg(fc, fc == null ? null : drop);
  return out;
}

// Percent, e.g. 11.5. Null if either weight is missing or the green weight is not positive.
export function weightLossPct(greenG, roastedG) {
  if (!(greenG > 0) || roastedG == null || Number.isNaN(roastedG)) return null;
  return ((greenG - roastedG) / greenG) * 100;
}

export function developmentPct(devSec, totalSec) {
  if (devSec == null || !(totalSec > 0)) return null;
  return (devSec / totalSec) * 100;
}

// °F/min from Start to Drop.
export function averageRor(startF, endF, totalSec) {
  if (startF == null || endF == null || !(totalSec > 0)) return null;
  return ((endF - startF) / totalSec) * 60;
}

// roast: a roast record with readings already truncated at Drop. Returns its `results`.
export function summarize(roast) {
  const readings = roast.readings || [];
  const drop = roast.events?.drop ?? null;
  const totalSec = drop ? drop.t : Math.max(0, readings.length - 1);
  const phases = phaseSummary(roast.events, totalSec);
  const devSec = phases.development ? phases.development.sec : null;
  const startF = readings.find((v) => v != null) ?? null;
  let endF = drop ? drop.f : null;
  if (endF == null) {
    for (let i = readings.length - 1; i >= 0 && endF == null; i--) endF = readings[i];
  }
  return {
    totalSec,
    phases,
    devSec,
    devPct: developmentPct(devSec, totalSec),
    avgRor: averageRor(startF, endF ?? null, totalSec),
  };
}
