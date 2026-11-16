// Camera temperature source: the phone's rear camera reads the thermometer's LCD.
//
//   const src = createCameraSource({ settings, video, box });
//   await src.start();                 // opens the camera (or waits for a tap, see requireTap) and starts the frame loop
//   src.peek()                         // -> { value, status } from the latest frames, for Setup. Does not consume anything
//   src.sample(t, { missed })          // -> accepted °F for roast second t, or null
//   src.reanchor(f)                    // a typed reading: the filter trusts it as the last accepted value
//   src.health()                       // -> { secondsRead, rejected, secondsMissing, ... } from the filter
//   src.stop()
//
// How a second is made. Every decoded frame is read by readDisplay() and the result is kept for about two seconds
// (`frames`). Nothing goes to the reading filter until the roast clock asks for a second: sample() takes the frames
// of the last second, feeds them to the filter, closes the second and returns what it accepted. So
//   * the work per frame (about 30 ms) happens in the frame loop, never on the tick path, and sample() is cheap;
//   * Setup's peek() reads the same recent frames without touching the filter's per-second state or health counters;
//   * a tick flagged `missed` (the page was throttled or hidden and the clock is catching up) closes an empty second:
//     a gap, counted as missing, and it never reuses frames from before the stall.
//
// start() is idempotent. The first call opens the stream; later calls (the roast controller calls it again after
// Setup's preview did) keep the stream and only reset the per-roast state: a fresh filter, so seconds seen before
// Start do not count towards the roast's health numbers.
//
// Camera trouble is reported through `state` (see STATES) and onState(). The source watches the track and the video
// and tries to bring the stream back by itself: on a timer with back-off while the page is visible, and at once when
// the page becomes visible again (iOS ends or mutes the track whenever the page is backgrounded or another app takes
// the camera). A dead camera simply yields gaps; the roast carries on.

import { createCamera as realCreateCamera } from '../reader/camera.js';
import { readDisplay as realReadDisplay } from '../reader/sevenseg.js';
import { createReadingFilter as realCreateFilter } from '../reader/filter.js';
import { explainMiss, explainRejection, NO_PICTURE, NO_PROBE } from './camera-reasons.js';

export const STATES = {
  idle: 'Not started',
  'needs-tap': 'Waiting for permission',
  requesting: 'Opening the camera',
  live: 'Camera on',
  stalled: 'No new pictures from the camera',
  muted: 'Camera paused',
  ended: 'Camera stopped',
  recovering: 'Reconnecting the camera',
  denied: 'Camera blocked',
  'no-camera': 'No camera found',
  insecure: 'Camera needs HTTPS',
  unsupported: 'This browser has no camera access',
  error: 'Camera problem',
  stopped: 'Stopped',
};

// States in which the camera is delivering good frames.
const GOOD = new Set(['live']);

const FRAME_KEEP_MS = 5000;     // how long frame results are kept (peek and sample use the last second or so; details show 5 s)
const SECOND_MS = 1000;         // sample() uses frames from the last second
const PEEK_MS = 1200;           // peek() looks at the last 1.2 s
const AGREE_F = 2;              // frames that disagree by more than this are not a value

// Reopening the stream is rare. On iOS a reopen can re-prompt for permission or flash the preview, and a stream that
// looks dead for a moment is usually just starting.
const GRACE_MS = 5000;          // a freshly opened stream is not judged (a dead track still counts)
const STALL_REOPEN_MS = 6000;   // a stall (already 2 s of positive evidence) must last this much longer before a reopen
const MUTED_REOPEN_MS = 5000;   // a muted track is reopened only if it is still muted this long after the page became visible
const RETRY_BASE_MS = 3000;     // wait between reopen attempts, doubling up to RETRY_MAX_MS
const RETRY_MAX_MS = 30000;
const OUTCOME_KEEP_MS = 60000;  // the per-second outcome list and tally on the details panel cover the last minute
const WHY_MS = 2000;            // the reason shown for "can't read" is the most common one over this long
const GOOD_RESET_MS = 20000;    // the wait goes back to the base only after the stream has stayed good this long

export function classifyError(err) {
  const name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no-camera';
  return 'error';
}

export function createCameraSource({
  settings = {},
  video = null,
  box = undefined,
  requireTap = false,            // true: start() waits in 'needs-tap' until requestAccess() (a button press) is called
  createCamera = realCreateCamera,
  readDisplay = realReadDisplay,
  createFilter = realCreateFilter,
  now = () => performance.now(),
  secureContext = () => (typeof isSecureContext === 'boolean' ? isSecureContext : true),
  mediaDevices = () => (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined),
  doc = typeof document !== 'undefined' ? document : null,
  timers = { setInterval: (f, ms) => globalThis.setInterval(f, ms), clearInterval: (id) => globalThis.clearInterval(id) },
  defer = (fn) => globalThis.setTimeout(fn, 0),   // lets the page paint between grabbing a picture and reading it
  monitorMs = 500,
} = {}) {
  const readerCfg = settings.reader || {};
  const fps = readerCfg.fps ?? 4;
  const filterCfg = { minF: readerCfg.minF ?? 50, maxF: readerCfg.maxF ?? 550, maxJumpF: readerCfg.maxJumpF ?? 15 };

  let el = video;
  if (!el && doc) el = doc.createElement('video');
  const cam = createCamera({ video: el, ...(box ? { box } : {}), fps });

  let state = 'idle';
  let message = '';
  let gen = 0;                    // bumped by stop() and every open attempt, so a stale attempt can tell
  let opening = null;             // the promise of an open attempt in flight
  let everLive = false;           // the stream has been up at least once since the last stop()
  let filter = createFilter(filterCfg);
  let frames = [];                // [{ at, res }]
  let takenAt = -Infinity;        // frames at or before this time went into an earlier second
  let hint = null, misses = 0;
  let reading = false;            // readDisplay is running
  let pending = null;             // the newest picture waiting for its read: { img, at, crop }
  let cooldownUntil = 0;          // after a read slower than a frame period, skip pictures until then
  let monitor = null;
  let badSince = null, retryDelay = RETRY_BASE_MS, nextRetryAt = 0, liveAt = 0, goodSince = 0, visRetry = false, reopens = 0;
  let visHandler = null;
  const stateListeners = new Set();
  const frameListeners = new Set();   // called for every grabbed picture, before it is read (the magnifier draws here)
  const readListeners = new Set();    // called after each read, with the latest result
  const perf = { frames: 0, dropped: 0, errors: 0, msLast: 0, msAvg: 0, msMax: 0 };
  let last = null;                // latest grabbed picture: { imageData, result, crop, at }; result is the latest read, maybe of an earlier picture
  let lastResult = null;
  const outcomes = [];            // one entry per second, last 60 s: { at, kind: value|dashes|miss|rejected|gap, label?, text?, value?, last? }
  let roastTally = {};            // seconds that were not read, by label, since the roast started (goes into the saved record)
  let inRoast = false;            // true once the roast controller has called start() a second time
  let shadow = createFilter(filterCfg);   // before the roast it closes a second every second, so Setup can say what the filter thinks
  let shadowTakenAt = -Infinity;
  let diagTimer = null;
  const captured = { ok: null, miss: null };   // newest readable and unreadable picture, exactly as the reader got them
  let lastOk = null;              // newest readable picture: { value, digits, at }
  let geom = null;                // { cropW, cropH, digitH } from the newest read that located digits
  const reads = [];               // [{ at, ms, readable }] last 5 s
  const drops = [];               // times pictures were skipped, last 5 s
  const shown = [];               // times the picture listeners were called, last 5 s
  const trim = (arr, t) => { while (arr.length && (arr[0].at ?? arr[0]) < t - FRAME_KEEP_MS) arr.shift(); };

  function setState(next, msg = '') {
    if (state === next && message === msg) return;
    state = next; message = msg;
    for (const fn of [...stateListeners]) { try { fn({ state, message }); } catch { /* a listener must not break the source */ } }
  }

  // ---- frames ----

  // Draw first, read after. A grabbed picture goes to the listeners at once, so the magnifier follows the camera however
  // slow the reader is. Reading happens on the next turn of the event loop and only for the newest picture: one that is
  // still waiting when a newer one arrives is replaced, and after a read slower than a frame period the pictures are
  // skipped for as long again, so a slow phone spends at most half its time reading.
  function onFrame(img, info) {
    if (state === 'stopped' || state === 'idle') return;
    if (info && info.stalled) return;               // a repeated, stale picture: never reads
    const at = now();
    last = { imageData: img, result: lastResult, crop: (info && info.crop) || cam.lastCrop || null, at };
    if (frameListeners.size) { shown.push(at); trim(shown, at); }
    for (const fn of [...frameListeners]) { try { fn(last); } catch { /* ignore */ } }
    if (reading || at < cooldownUntil) { perf.dropped++; drops.push(at); trim(drops, at); return; }
    if (pending) { perf.dropped++; drops.push(at); trim(drops, at); }   // an older picture never got read
    const queued = !!pending;
    pending = { img, at, crop: last.crop };
    if (!queued) defer(runRead);
  }

  function runRead() {
    const f = pending;
    pending = null;
    if (!f || state === 'stopped' || state === 'idle') return;
    reading = true;
    const t0 = now();
    let res;
    try {
      res = readDisplay(f.img, { hint });
    } catch {
      perf.errors++;
      res = { status: 'none', value: null, digits: [], confidence: 0, debug: { reason: 'reader error' } };
    }
    const t1 = now();
    reading = false;
    const ms = t1 - t0;
    perf.frames++;
    perf.msLast = ms;
    perf.msAvg = perf.frames === 1 ? ms : perf.msAvg * 0.9 + ms * 0.1;
    perf.msMax = Math.max(perf.msMax, ms);
    reads.push({ at: t1, ms, readable: !!res && (res.status === 'ok' || res.status === 'dashes') });
    trim(reads, t1);
    if (ms > 1000 / fps) cooldownUntil = t1 + ms;
    // The reader can start its search where the digits were last found. Drop the hint after a run of misses.
    const hintOut = res && res.debug && res.debug.hintOut;
    if (hintOut) { hint = hintOut; misses = 0; } else if (++misses >= 8) hint = null;
    frames.push({ at: f.at, res });
    while (frames.length && frames[0].at < t1 - FRAME_KEEP_MS) frames.shift();
    lastResult = res;
    if (last && last.at === f.at) last.result = res;
    // Keep the newest readable and unreadable pictures in memory: the same pixels the reader saw, for sharing as test samples.
    const dbg = (res && res.debug) || {};
    const g = dbg.geometry || (dbg.hintOut && dbg.hintOut.geometry);
    geom = { cropW: f.img.width, cropH: f.img.height, digitH: g && g.H && dbg.scale ? g.H / dbg.scale : (geom ? geom.digitH : null) };
    if (res && res.status === 'ok') {
      captured.ok = { imageData: f.img, status: 'ok', value: res.value, digits: res.digits, reason: null, label: null, at: f.at, w: f.img.width, h: f.img.height };
      lastOk = { value: res.value, digits: res.digits, at: f.at };
    } else if (res && res.status === 'none') {
      const why = explainMiss(dbg.reason);
      captured.miss = { imageData: f.img, status: 'none', value: null, digits: dbg.digits || null, reason: dbg.reason || 'unknown', label: why.label, at: f.at, w: f.img.width, h: f.img.height };
    }
    for (const fn of [...readListeners]) { try { fn(last); } catch { /* ignore */ } }
  }

  function startLoop() {
    cam.stopLoop();
    cam.startLoop(onFrame, { fps });
  }

  // ---- opening and recovering the stream ----

  // A page that can never open the camera says so up front, with no permission step.
  function cannotOpen() {
    if (!secureContext()) { setState('insecure'); return true; }
    const md = mediaDevices();
    if (!md || !md.getUserMedia) { setState('unsupported'); return true; }
    return false;
  }

  function open(why) {
    if (opening) return opening;
    const myGen = ++gen;
    opening = (async () => {
      if (cannotOpen()) return false;
      setState(why === 'recover' ? 'recovering' : 'requesting');
      try {
        await cam.start();
      } catch (err) {
        try { cam.stop(); } catch { /* ignore */ }
        if (myGen !== gen) return false;
        const text = (err && (err.message || err.name)) || '';
        // A failed reconnect mid-roast is not "blocked": the permission was granted once. Keep trying, slowly.
        if (why === 'recover' && everLive) setState('ended', text);
        else setState(classifyError(err), text);
        return false;
      }
      if (myGen !== gen) { try { cam.stop(); } catch { /* ignore */ } return false; }   // stop() came while we waited
      everLive = true;
      badSince = null; liveAt = goodSince = now();
      frames = []; hint = null; misses = 0;
      startLoop();
      startMonitor();
      setState('live');
      return true;
    })().finally(() => { opening = null; });
    return opening;
  }

  async function restart() {
    reopens++;
    cam.stopLoop();
    try { cam.stop(); } catch { /* ignore */ }
    return open('recover');
  }

  function startMonitor() {
    if (monitor) return;
    monitor = timers.setInterval(checkNow, monitorMs);
    diagTimer = timers.setInterval(diagTick, 1000);
    if (doc && !visHandler) {
      visHandler = () => {
        if (doc.visibilityState !== 'visible') return;
        badSince = null; visRetry = true;
        if (state === 'ended') { nextRetryAt = 0; retryDelay = RETRY_BASE_MS; }   // back from the background: try at once
        const v = cam.video || el;
        if (v && v.paused && state !== 'ended') { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ } }
        checkNow();
      };
      doc.addEventListener('visibilitychange', visHandler);
    }
  }

  function stopMonitor() {
    if (monitor) { timers.clearInterval(monitor); monitor = null; }
    if (diagTimer) { timers.clearInterval(diagTimer); diagTimer = null; }
    if (doc && visHandler) { doc.removeEventListener('visibilitychange', visHandler); visHandler = null; }
  }

  const pageVisible = () => !doc || doc.visibilityState !== 'hidden';

  /** Looks at the track and the video, updates `state`, and starts a recovery when it is due. Runs twice a second. */
  function checkNow() {
    if (!everLive || state === 'stopped' || state === 'idle' || opening) return;
    if (state === 'denied' || state === 'no-camera' || state === 'insecure' || state === 'unsupported' || state === 'needs-tap') return;
    let track = null;
    try { track = cam.stream && cam.stream.getVideoTracks && cam.stream.getVideoTracks()[0]; } catch { /* ignore */ }
    const stats = cam.stats || {};
    const t = now();
    const inGrace = t - liveAt < GRACE_MS;
    let s = 'live';
    if (!track || track.readyState === 'ended' || stats.trackEnded) s = 'ended';
    else if (!inGrace) {
      if (track.muted || stats.trackMuted) s = 'muted';
      else if (stats.stalledNow) s = 'stalled';     // camera.js only says so on positive evidence
    }
    if (s === 'live') {
      badSince = null;
      if (!GOOD.has(state)) { goodSince = t; setState('live'); }
      if (t - goodSince >= GOOD_RESET_MS) retryDelay = RETRY_BASE_MS;
      return;
    }
    if (badSince === null) badSince = t;
    if (state !== s) setState(s, state === s ? message : '');
    // A hidden page cannot reopen the camera: wait for it to become visible (visHandler restarts the clock).
    if (!pageVisible()) return;
    const age = t - badSince;
    const due = s === 'ended' ? true : s === 'stalled' ? age >= STALL_REOPEN_MS : visRetry && age >= MUTED_REOPEN_MS;
    if (due && t >= nextRetryAt) {
      nextRetryAt = t + retryDelay;
      retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
      visRetry = false;
      restart();
    }
  }

  // ---- reading the recent frames ----

  const median = (vals) => {
    const a = [...vals].sort((x, y) => x - y), n = a.length;
    return n % 2 ? a[(n - 1) / 2] : Math.round((a[n / 2 - 1] + a[n / 2]) / 2);
  };

  // ---- closing a second, and saying why it did not give a value ----

  function dominantMiss(list) {
    const counts = new Map();
    for (const f of list) {
      if (!f.res || f.res.status !== 'none') continue;
      const why = explainMiss(f.res.debug && f.res.debug.reason);
      const c = counts.get(why.label) || { n: 0, at: 0, why };
      c.n++; c.at = Math.max(c.at, f.at);
      counts.set(why.label, c);
    }
    let best = null;
    for (const c of counts.values()) if (!best || c.n > best.n || (c.n === best.n && c.at > best.at)) best = c;
    return best ? best.why : null;
  }

  // Feeds `list` (the frames of one second) to `flt`, closes the second, and records what happened. `real` is the roast's
  // own filter; the other call is the shadow filter that runs before the roast.
  function closeInto(flt, list, at, real) {
    for (const f of list) flt.addFrame(f.res);
    const v = flt.closeSecond();
    let o;
    if (v !== null) o = { kind: 'value', value: v };
    else if (!list.length) o = { kind: 'gap', label: NO_PICTURE.label, text: NO_PICTURE.text };
    else {
      const out = flt.lastOutcome ? flt.lastOutcome() : null;
      const rej = out && explainRejection(out);
      if (rej) o = { kind: 'rejected', label: rej.label, text: rej.text, value: out.value, last: out.last };
      else if (out && out.kind === 'missing' && out.dashes) o = { kind: 'dashes', label: NO_PROBE.label, text: NO_PROBE.text };
      else {
        const why = dominantMiss(list) || explainMiss('');
        o = { kind: 'miss', label: why.label, text: why.text };
      }
    }
    o.at = at;
    outcomes.push(o);
    while (outcomes.length && outcomes[0].at < at - OUTCOME_KEEP_MS) outcomes.shift();
    if (real && o.kind !== 'value') roastTally[o.label] = (roastTally[o.label] || 0) + 1;
    return v;
  }

  const describeOutcome = (o) => {
    if (o.kind === 'value') return String(o.value);
    if (o.kind === 'dashes') return 'dashes';
    if (o.kind === 'rejected') {
      if (o.label === 'jump too big') return `jump too big (${o.last} to ${o.value})`;
      if (o.label === 'out of range') return `out of range (${o.value})`;
      return o.label;
    }
    return o.label;
  };

  function outcomeDetails(t) {
    while (outcomes.length && outcomes[0].at < t - OUTCOME_KEEP_MS) outcomes.shift();
    const tally = {};
    let read = 0;
    for (const o of outcomes) { if (o.kind === 'value') read++; else tally[o.label] = (tally[o.label] || 0) + 1; }
    const cap = (c) => (c ? { label: c.label, reason: c.reason, digits: c.digits, value: c.value, w: c.w, h: c.h, agoMs: t - c.at } : null);
    return {
      tallySeconds: outcomes.length, tallyRead: read, tally,
      lastOutcomes: outcomes.slice(-10).map(describeOutcome),
      lastOkValue: lastOk ? lastOk.value : null, lastOkDigits: lastOk ? lastOk.digits : null, lastOkAgoMs: lastOk ? t - lastOk.at : null,
      cropW: geom ? geom.cropW : null, cropH: geom ? geom.cropH : null, digitH: geom && geom.digitH ? Math.round(geom.digitH) : null,
      capturedOk: cap(captured.ok), capturedMiss: cap(captured.miss),
      roastMisses: { ...roastTally },
    };
  }

  const secondFrames = (from) => frames.filter((f) => f.at > from && !f.stale);

  // Once a second before the roast: what the filter would make of the last second. Not used for anything but the details.
  function diagTick() {
    if (inRoast || state !== 'live') return;
    const at = now();
    const from = Math.max(shadowTakenAt, at - SECOND_MS);
    shadowTakenAt = at;
    closeInto(shadow, secondFrames(from), at, false);
  }

  const api = {
    kind: 'camera',
    get video() { return cam.video || el; },
    get camera() { return cam; },
    get state() { return state; },
    get message() { return message; },
    get statusText() { return STATES[state] || state; },
    /** True while frames are coming in. */
    get ok() { return GOOD.has(state); },
    get lastFrame() { return last; },
    get fps() { return fps; },
    get perf() { return { ...perf }; },
    get box() { return cam.box; },
    /** Plain facts for the "Camera details" panel: the stream (from camera.js) plus the source's own counters. */
    diagnostics() {
      const t = now();
      const recent = frames.filter((f) => f.at >= t - FRAME_KEEP_MS);
      const count = (st) => recent.filter((f) => f.res && f.res.status === st).length;
      const base = cam.diagnostics ? cam.diagnostics() : {};
      trim(reads, t); trim(drops, t); trim(shown, t);
      const win = Math.max(1, Math.min(FRAME_KEEP_MS / 1000, (t - liveAt) / 1000));
      const avg = (a) => (a.length ? a.reduce((x, r) => x + r.ms, 0) / a.length : null);
      const okReads = reads.filter((r) => r.readable), badReads = reads.filter((r) => !r.readable);
      return {
        ...base, state, message, reopens,
        readerOk: count('ok'), readerDashes: count('dashes'), readerNone: recent.length - count('ok') - count('dashes'),
        readerSeconds: FRAME_KEEP_MS / 1000,
        readMsAvg: avg(reads), readMsMax: reads.length ? Math.max(...reads.map((r) => r.ms)) : null,
        readMsAvgReadable: avg(okReads), readMsAvgUnreadable: avg(badReads),
        readsPerSecond: Math.round((reads.length / win) * 10) / 10,
        magnifierPerSecond: Math.round((shown.length / win) * 10) / 10,
        skipped5s: drops.length, framesDropped: perf.dropped,
        ...outcomeDetails(t),
      };
    },

    /** One tick of the before-roast diagnostics (the details tally). The source calls this itself every second. */
    diagTick,

    /** The newest readable and unreadable pictures, as the reader got them: { ok, miss } each { imageData, reason, label, digits, value, at, w, h } or null. */
    captured() { return { ok: captured.ok, miss: captured.miss }; },

    /**
     * Why Setup cannot read, in plain words, or null when nothing is wrong. Only for "can't read": the most common miss
     * over the last 2 s, so it does not flicker. Also says when a value read fine but would be rejected (out of range, a
     * big jump). Returns { kind, label, text, hint }.
     */
    explain() {
      if (!GOOD.has(state)) return null;
      const t = now();
      const p = api.peek();
      if (p.status === 'dashes') return null;
      if (p.status === 'none') {
        const recent = frames.filter((f) => f.at >= t - WHY_MS);
        if (!recent.length) return { kind: 'miss', label: NO_PICTURE.label, text: 'No pictures from the camera yet.', hint: '' };
        const why = dominantMiss(recent);
        if (why) return { kind: 'miss', ...why };
        const vals = recent.filter((f) => f.res.status === 'ok').map((f) => f.res.value);
        if (vals.length) return { kind: 'disagree', label: 'frames disagreed', text: `The readings differ from picture to picture (${[...new Set(vals)].join(', ')}).`, hint: 'Hold the phone steady and check for glare.' };
        return null;
      }
      if (p.value < filterCfg.minF || p.value > filterCfg.maxF) {
        return { kind: 'range', label: 'out of range', text: `The reading ${p.value}°F is outside the accepted range of ${filterCfg.minF} to ${filterCfg.maxF}°F.`, hint: 'Check that the box covers only the top-right number.' };
      }
      const lastO = outcomes[outcomes.length - 1];
      if (lastO && lastO.kind === 'rejected' && t - lastO.at <= 2500) return { kind: lastO.label === 'jump too big' ? 'jump' : 'disagree', label: lastO.label, text: lastO.text, hint: '' };
      return null;
    },
    onState(fn) { stateListeners.add(fn); return () => stateListeners.delete(fn); },
    onFrame(fn) { frameListeners.add(fn); return () => frameListeners.delete(fn); },
    onRead(fn) { readListeners.add(fn); return () => readListeners.delete(fn); },
    checkNow,

    /** Open the camera. Idempotent: with the stream already up it only resets the per-roast state. */
    async start() {
      if (opening) { await opening; }
      if (everLive && state !== 'stopped') {
        // Called again for the roast: keep the stream, start the roast's filter and health counters from zero.
        filter = createFilter(filterCfg);
        inRoast = true; roastTally = {}; outcomes.length = 0;
        takenAt = -Infinity;                        // frames from the last second still belong to second 0
        for (const f of frames) f.stale = false;
        return;
      }
      if (state === 'stopped') { state = 'idle'; }
      if (requireTap && state === 'idle') { if (!cannotOpen()) setState('needs-tap'); return; }
      if (state === 'needs-tap') return;
      await open('start');
    },

    /** The Allow camera button: opens the camera now, from inside a tap (iOS wants that in some cases). */
    async requestAccess() {
      if (opening) return opening;
      if (everLive && state !== 'stopped') return true;
      if (state === 'stopped') state = 'idle';
      return open('start');
    },

    /** Try again after a failure (the panel's Try again button). */
    async retry() {
      if (opening) return opening;
      cam.stopLoop();
      try { cam.stop(); } catch { /* ignore */ }
      return open('start');
    },

    stop() {
      gen++;
      opening = null;
      stopMonitor();
      cam.stopLoop();
      try { cam.stop(); } catch { /* ignore */ }
      everLive = false;
      frames = []; last = null; pending = null; hint = null; badSince = null;
      setState('stopped');
    },

    /**
     * The latest instantaneous read, for Setup. Looks at the last 1.2 s of frames; it never consumes them.
     *   ok      most of the recent frames read, and they agree: value is their median
     *   dashes  the display shows three dashes (no probe reading)
     *   none    nothing readable
     */
    peek() {
      const t = now();
      const recent = frames.filter((f) => f.at >= t - PEEK_MS && GOOD.has(state));
      if (!recent.length) return { value: null, status: 'none' };
      const oks = recent.filter((f) => f.res.status === 'ok' && Number.isFinite(f.res.value)).map((f) => f.res.value);
      const dashes = recent.filter((f) => f.res.status === 'dashes').length;
      if (oks.length && oks.length >= dashes && oks.length * 2 >= recent.length) {
        const m = median(oks);
        const agree = oks.filter((v) => Math.abs(v - m) <= AGREE_F);
        if (agree.length * 2 > oks.length) return { value: median(agree), status: 'ok' };
        return { value: null, status: 'none' };
      }
      if (dashes && dashes > oks.length && dashes * 2 >= recent.length) return { value: null, status: 'dashes' };
      return { value: null, status: 'none' };
    },

    /**
     * Closes roast second t. Takes the frames of the last second (and only those not used by an earlier second),
     * runs them through the filter and returns the accepted °F or null. A tick flagged `missed` is a gap.
     */
    sample(t, { missed = false } = {}) {
      const at = now();
      if (missed) {
        for (const f of frames) f.stale = true;
        takenAt = at;
        return closeInto(filter, [], at, true);     // counts one missing second; nothing was added to it
      }
      const from = Math.max(takenAt, at - SECOND_MS);
      const list = GOOD.has(state) ? secondFrames(from) : [];
      takenAt = at;
      return closeInto(filter, list, at, true);
    },

    /** A typed reading: the filter trusts it as the last accepted value. */
    reanchor(value) {
      filter.reanchor(value);
    },

    health() {
      const h = filter.health();
      return { secondsRead: h.secondsRead, rejected: h.rejected, secondsMissing: h.secondsMissing, missReasons: { ...roastTally }, ...detail(h) };
    },

    setBox(b) { cam.setBox(b); frames = []; pending = null; hint = null; misses = 0; },
    readerBox() { return cam.readerBox(); },
    setControl() {},
  };

  const detail = (h) => ({ rejectedRange: h.rejectedRange, rejectedJump: h.rejectedJump, dashSeconds: h.dashSeconds, reanchors: h.reanchors, lastAccepted: h.lastAccepted });

  return api;
}
