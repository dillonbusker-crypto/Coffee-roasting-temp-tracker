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
  let busy = false;
  let monitor = null;
  let badSince = null, retryDelay = RETRY_BASE_MS, nextRetryAt = 0, liveAt = 0, goodSince = 0, visRetry = false, reopens = 0;
  let visHandler = null;
  const stateListeners = new Set();
  const frameListeners = new Set();
  const perf = { frames: 0, dropped: 0, errors: 0, msLast: 0, msAvg: 0, msMax: 0 };
  let last = null;                // latest frame: { imageData, result, crop, at }

  function setState(next, msg = '') {
    if (state === next && message === msg) return;
    state = next; message = msg;
    for (const fn of [...stateListeners]) { try { fn({ state, message }); } catch { /* a listener must not break the source */ } }
  }

  // ---- frames ----

  function onFrame(img, info) {
    if (state === 'stopped' || state === 'idle') return;
    if (info && info.stalled) return;               // a repeated, stale picture: never reads
    if (busy) { perf.dropped++; return; }           // never queue frames
    busy = true;
    const t0 = now();
    let res;
    try {
      res = readDisplay(img, { hint });
    } catch {
      perf.errors++;
      res = { status: 'none', value: null, digits: [], confidence: 0, debug: { reason: 'reader error' } };
    }
    const at = now();
    perf.frames++;
    perf.msLast = at - t0;
    perf.msAvg = perf.frames === 1 ? perf.msLast : perf.msAvg * 0.9 + perf.msLast * 0.1;
    perf.msMax = Math.max(perf.msMax, perf.msLast);
    // The reader can start its search where the digits were last found. Drop the hint after a run of misses.
    const hintOut = res && res.debug && res.debug.hintOut;
    if (hintOut) { hint = hintOut; misses = 0; } else if (++misses >= 8) hint = null;
    frames.push({ at, res });
    while (frames.length && frames[0].at < at - FRAME_KEEP_MS) frames.shift();
    last = { imageData: img, result: res, crop: (info && info.crop) || cam.lastCrop || null, at };
    busy = false;
    for (const fn of [...frameListeners]) { try { fn(last); } catch { /* ignore */ } }
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
      return {
        ...base, state, message, reopens,
        readerOk: count('ok'), readerDashes: count('dashes'), readerNone: recent.length - count('ok') - count('dashes'),
        readerSeconds: FRAME_KEEP_MS / 1000,
        readMsAvg: perf.msAvg, framesDropped: perf.dropped,
      };
    },
    onState(fn) { stateListeners.add(fn); return () => stateListeners.delete(fn); },
    onFrame(fn) { frameListeners.add(fn); return () => frameListeners.delete(fn); },
    checkNow,

    /** Open the camera. Idempotent: with the stream already up it only resets the per-roast state. */
    async start() {
      if (opening) { await opening; }
      if (everLive && state !== 'stopped') {
        // Called again for the roast: keep the stream, start the roast's filter and health counters from zero.
        filter = createFilter(filterCfg);
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
      frames = []; last = null; hint = null; badSince = null;
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
        filter.closeSecond();                       // counts one missing second; nothing was added to it
        takenAt = at;
        return null;
      }
      const from = Math.max(takenAt, at - SECOND_MS);
      if (GOOD.has(state)) {
        for (const f of frames) if (f.at > from && !f.stale) filter.addFrame(f.res);
      }
      takenAt = at;
      return filter.closeSecond();
    },

    /** A typed reading: the filter trusts it as the last accepted value. */
    reanchor(value) {
      filter.reanchor(value);
    },

    health() {
      const h = filter.health();
      return { secondsRead: h.secondsRead, rejected: h.rejected, secondsMissing: h.secondsMissing, ...detail(h) };
    },

    setBox(b) { cam.setBox(b); frames = []; hint = null; misses = 0; },
    readerBox() { return cam.readerBox(); },
    setControl() {},
  };

  const detail = (h) => ({ rejectedRange: h.rejectedRange, rejectedJump: h.rejectedJump, dashSeconds: h.dashSeconds, reanchors: h.reanchors, lastAccepted: h.lastAccepted });

  return api;
}
