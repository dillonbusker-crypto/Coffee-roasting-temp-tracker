// Camera access, crop box and frame loop for the digit reader. UI-free: it takes a <video> element and a box and builds no DOM
// (apart from one off-screen canvas for cropping).
//
//   const cam = createCamera({ video, box: { x, y, w, h }, fps: 4 });
//   await cam.start();                      // rear camera into `video` (inline, muted), tries to lock exposure and focus
//   cam.setBox({ x, y, w, h });             // the user's box, normalised 0..1 in video coordinates
//   const img = cam.grabCrop();             // ImageData of the reader's crop, or null when the video has no frame yet
//   cam.startLoop((img, info) => { ... });  // calls back at cam.fps (default 4) with each crop
//   cam.stopLoop(); cam.stop();
//   cam.diagnostics();                      // plain object: what the stream is doing (for a "Camera details" panel)
//
// Is the stream alive? Only positive evidence says it is not (see startLoop). A clock that has never been seen to move
// (iOS Safari reports mediaTime 0 and a fixed currentTime for camera streams) is not evidence of anything.
//
// The reader's crop IS the box the user sees and drags in Setup: nothing is added to it. The box holds three digit slots, and the
// hundreds slot stays empty until the reading passes 99 (see ui/crop-box.js). expandBoxForDigits is what the app used to apply
// on top of a tight box; it is kept for converting a box saved before that change (ui/camera-panel.js) and for the reader test
// page and the real-media test, which still widen a tight box themselves (createCamera's `widenForDigits` option).

// The widening the app used to apply to the user's tight box, as a multiple of the box height. One cell pitch is 0.70-0.72 digit heights (measured on 9 photos and both videos),
// and the lattice needs about 0.14 more on the left (the slant, the segment windows and the fit around the cell): a full hundreds digit
// next to a box drawn tight around two digits needs 0.85. At 0.7 the hundreds cell touched the crop's edge on the second video
// ("digit cut off at the edge of the crop" on 313 of 512 frames).
export const DIGIT_EXTENSION = 0.85;
export const MAX_CROP_HEIGHT = 240; // crops are scaled down to at most this many pixels high; the reader works on less

export function clampBox(b) {
  let { x, y, w, h } = b;
  w = Math.min(1, Math.max(0.01, w)); h = Math.min(1, Math.max(0.01, h));
  x = Math.min(1 - w, Math.max(0, x)); y = Math.min(1 - h, Math.max(0, y));
  return { x, y, w, h };
}

/**
 * The user's box widened to the left by one digit position. Boxes are normalised to the video size; videoW/videoH give the
 * aspect needed to measure the widening in digit heights. Returns { x, y, w, h, clipped } where clipped is true if the video's
 * left edge cut the widening short.
 */
export function expandBoxForDigits(box, videoW, videoH) {
  const ext = DIGIT_EXTENSION * box.h * videoH / videoW; // normalised width of the widening
  const x = box.x - ext;
  const clipped = x < 0;
  const nx = Math.max(0, x);
  return { x: nx, y: box.y, w: box.w + (box.x - nx), h: box.h, clipped };
}

/** Draw a normalised box of `source` (video, canvas or image) into a canvas and return its ImageData. */
export function grabCropFrom(source, sw, sh, box, work = {}) {
  const px = {
    x: Math.round(box.x * sw), y: Math.round(box.y * sh),
    w: Math.max(2, Math.round(box.w * sw)), h: Math.max(2, Math.round(box.h * sh)),
  };
  const scale = Math.min(1, (work.maxHeight || MAX_CROP_HEIGHT) / px.h);
  const cw = Math.max(2, Math.round(px.w * scale)), ch = Math.max(2, Math.round(px.h * scale));
  let canvas = work.canvas;
  if (!canvas) canvas = work.canvas = document.createElement('canvas');
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; work.ctx = null; }
  const ctx = work.ctx || (work.ctx = canvas.getContext('2d', { willReadFrequently: true }));
  ctx.drawImage(source, px.x, px.y, px.w, px.h, 0, 0, cw, ch);
  return { imageData: ctx.getImageData(0, 0, cw, ch), rect: px, scale };
}

/**
 * Calls cb(frameIndex, timeSec, { via }) about `fps` times a second while `video` plays. Returns { stop(), usesRvfc, via, rvfcCount }.
 *
 * Recorded video (default): requestVideoFrameCallback when the browser has it, paced by the media clock, else a
 * drift-corrected timer.
 *
 * Live stream (opts.live): hybrid. Each requestVideoFrameCallback is a newly presented frame, whatever mediaTime says, and
 * delivers a frame when the target period has passed. A timer at the target rate takes over whenever no callback has
 * arrived for about one period plus a margin (iOS may not run rVFC for a video that is hidden, off-screen or parked), and
 * stands down again when callbacks resume. Frames are never delivered faster than `fps`, so the two paths cannot double up.
 * opts.onRvfc(meta) is called for every rVFC callback, delivered or not. opts.env = { now, setTimeout, clearTimeout } is for tests.
 */
export function createFrameLoop(video, fps, cb, opts = {}) {
  if (opts.live) return createLiveLoop(video, fps, cb, opts);
  let stopped = false, idx = 0, lastT = -Infinity, timer = null, handle = null;
  const period = 1 / fps;
  const useRvfc = opts.timer !== true && typeof video.requestVideoFrameCallback === 'function';
  if (useRvfc) {
    const onFrame = (now, meta) => {
      if (stopped) return;
      const t = meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : video.currentTime;
      if (t - lastT >= period - 0.5 / 60) { lastT = t; cb(idx++, t); }
      handle = video.requestVideoFrameCallback(onFrame);
    };
    handle = video.requestVideoFrameCallback(onFrame);
  } else {
    let next = performance.now();
    const tick = () => {
      if (stopped) return;
      cb(idx++, video.currentTime);
      next += period * 1000;
      const now = performance.now();
      if (next < now - 1000) next = now; // fell far behind (tab was hidden): do not burst
      timer = setTimeout(tick, Math.max(0, next - now));
    };
    timer = setTimeout(tick, 0);
  }
  return {
    usesRvfc: useRvfc,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (handle !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
    },
  };
}

function createLiveLoop(video, fps, cb, opts) {
  const env = Object.assign({
    now: () => performance.now(),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (id) => clearTimeout(id),
  }, opts.env);
  const periodMs = 1000 / fps;
  const minGap = periodMs - 5;           // never faster than the target rate (a little slack for frame granularity)
  const staleMs = periodMs + 120;        // no rVFC callback for this long: the timer delivers frames instead
  const useRvfc = opts.timer !== true && typeof video.requestVideoFrameCallback === 'function';
  let stopped = false, idx = 0, timer = null, handle = null;
  let lastDeliver = -Infinity, lastRvfc = env.now(), rvfcCount = 0, via = 'none';

  const deliver = (kind, t) => {
    const n = env.now();
    if (n - lastDeliver < minGap) return;
    lastDeliver = n; via = kind;
    cb(idx++, t, { via: kind });
  };

  if (useRvfc) {
    const onFrame = (now, meta) => {
      if (stopped) return;
      handle = video.requestVideoFrameCallback(onFrame);
      lastRvfc = env.now(); rvfcCount++;
      if (opts.onRvfc) opts.onRvfc(meta || {});
      deliver('rvfc', meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : video.currentTime);
    };
    handle = video.requestVideoFrameCallback(onFrame);
  }

  let next = env.now() + periodMs;
  const tick = () => {
    if (stopped) return;
    const n = env.now();
    next += periodMs;
    if (next < n - 1000) next = n;       // fell far behind (page was hidden): do not burst
    timer = env.setTimeout(tick, Math.max(0, next - n));
    if (!useRvfc || n - lastRvfc > staleMs) deliver('timer', video.currentTime);
  };
  timer = env.setTimeout(tick, periodMs);

  return {
    usesRvfc: useRvfc,
    get via() { return via; },
    get rvfcCount() { return rvfcCount; },
    stop() {
      stopped = true;
      if (timer !== null) env.clearTimeout(timer);
      if (handle !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
    },
  };
}

export function createCamera({ video, box = { x: 0.45, y: 0.4, w: 0.4, h: 0.15 }, fps = 4, widenForDigits = false, settleMs = 1200, maxCropHeight = MAX_CROP_HEIGHT, env: envOpts = {} } = {}) {
  const env = Object.assign({
    now: () => performance.now(),
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
    setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id),
  }, envOpts);
  let watchdog = null, stream = null, track = null, userBox = clampBox(box), loop = null, lockTimer = null, work = { maxHeight: maxCropHeight };
  let sig = null, rvfcAt = -Infinity, rvfcN = 0, grabTimes = [], loopT0 = 0;
  const stats = {
    framesGrabbed: 0, stalls: 0, longestStallMs: 0, stalledNow: false, trackEnded: false, trackMuted: false,
    lastFrameAt: 0, startedAt: 0, lock: { exposure: 'not tried', focus: 'not tried' }, settings: null, capabilities: null,
  };
  const api = {
    fps,
    video,
    get stream() { return stream; },
    get box() { return userBox; },
    get stats() { return Object.assign({}, stats, { lastFrameAgeMs: stats.lastFrameAt ? env.now() - stats.lastFrameAt : null }); },
    lastCrop: null,
    onStall: null, onEnded: null,

    /** Open the rear camera into the video element. Resolves with { width, height }. */
    async start({ facingMode = 'environment', width = 1920, height = 1080, lock = true } = {}) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser has no camera access (needs HTTPS or localhost).');
      video.muted = true; video.defaultMuted = true; video.playsInline = true; video.autoplay = true;
      video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.setAttribute('webkit-playsinline', '');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
      });
      track = stream.getVideoTracks()[0];
      stats.trackEnded = false; stats.trackMuted = false; stats.startedAt = env.now();
      track.addEventListener('ended', () => { stats.trackEnded = true; stats.stalledNow = true; api.onEnded && api.onEnded(); });
      track.addEventListener('mute', () => { stats.trackMuted = true; });
      track.addEventListener('unmute', () => { stats.trackMuted = false; });
      video.srcObject = stream;
      await video.play();
      if (!video.videoWidth) await new Promise(res => video.addEventListener('loadedmetadata', res, { once: true }));
      try { stats.capabilities = track.getCapabilities ? track.getCapabilities() : null; stats.settings = track.getSettings(); } catch (e) { /* ignore */ }
      if (lock) lockTimer = env.setTimeout(() => api.lock(), settleMs);
      return { width: video.videoWidth, height: video.videoHeight };
    },

    /** Try to freeze exposure and focus at their current (auto) values. Failure is normal on iOS; it is reported, never thrown. */
    async lock() {
      if (!track) return stats.lock;
      let caps = {}, settings = {};
      try { caps = track.getCapabilities ? track.getCapabilities() : {}; settings = track.getSettings(); } catch (e) { /* ignore */ }
      const tryApply = async adv => {
        try { await track.applyConstraints({ advanced: [adv] }); return true; } catch (e) { return false; }
      };
      const has = (key, val) => Array.isArray(caps[key]) && caps[key].includes(val);
      // exposure
      if (has('exposureMode', 'manual') && settings.exposureTime) {
        stats.lock.exposure = (await tryApply({ exposureMode: 'manual', exposureTime: settings.exposureTime })) ? 'locked' : 'failed';
      } else if (has('exposureMode', 'locked')) {
        stats.lock.exposure = (await tryApply({ exposureMode: 'locked' })) ? 'locked' : 'failed';
      } else stats.lock.exposure = 'unsupported';
      // focus
      if (has('focusMode', 'manual') && settings.focusDistance !== undefined) {
        stats.lock.focus = (await tryApply({ focusMode: 'manual', focusDistance: settings.focusDistance })) ? 'locked' : 'failed';
      } else if (has('focusMode', 'single-shot')) {
        stats.lock.focus = (await tryApply({ focusMode: 'single-shot' })) ? 'locked' : 'failed';
      } else stats.lock.focus = 'unsupported';
      try { stats.settings = track.getSettings(); } catch (e) { /* ignore */ }
      return stats.lock;
    },

    setBox(b) { userBox = clampBox(b); },

    /**
     * The box the reader actually crops: the box itself, as drawn. `clipped` is kept for callers that read it; it is only ever
     * true with widenForDigits (the reader test page), when the video's left edge cut the widening short.
     */
    readerBox() {
      if (widenForDigits) return expandBoxForDigits(userBox, video.videoWidth || 1, video.videoHeight || 1);
      return { x: userBox.x, y: userBox.y, w: userBox.w, h: userBox.h, clipped: false };
    },

    /** ImageData of the reader's crop, or null if no frame is available yet. */
    grabCrop() {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh || video.readyState < 2) return null;
      const rb = api.readerBox();
      const out = grabCropFrom(video, vw, vh, rb, work);
      api.lastCrop = Object.assign({ videoW: vw, videoH: vh, clipped: rb.clipped }, out.rect, { scale: out.scale });
      stats.framesGrabbed++;
      return out.imageData;
    },

    /**
     * Call cb(imageData, info) at `fps` with each crop, and watch the stream. info.stalled is true while the stream is
     * judged stalled, and such frames should be ignored.
     *
     * A stall needs positive evidence; a clock that never moved says nothing. The stream is stalled (stats.stalledNow) when
     *   * its track has ended, or
     *   * no requestVideoFrameCallback has arrived for `stallMs` (an rVFC callback is a new frame, whatever mediaTime says)
     *     AND either a clock signal that has been seen moving on this stream (currentTime, mediaTime, decoded-frame
     *     counts) has stopped for `stallMs`, or the video has been paused, ended, below readyState 2 or its track muted
     *     for `stallMs`.
     * If none of that applies the stream is treated as alive, including when rVFC never fires and no clock ever moved.
     */
    startLoop(cb, { fps: f = fps, stallMs = 2000 } = {}) {
      api.stopLoop();
      api.fps = f;
      const t0 = loopT0 = env.now();
      const mk = () => ({ last: undefined, changed: false, changedAt: t0 });
      sig = { mediaTime: mk(), currentTime: mk(), decodedFrames: mk() };
      rvfcAt = -Infinity; rvfcN = 0; grabTimes = [];
      let badSince = null, stallStart = 0;
      if (!stats.trackEnded) stats.stalledNow = false;

      const feed = (s, v, n) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return;
        if (s.last !== undefined && v !== s.last) { s.changed = true; s.changedAt = n; }
        s.last = v;
      };
      const readClocks = (n) => {
        feed(sig.currentTime, video.currentTime, n);
        let decoded;
        try { const q = video.getVideoPlaybackQuality && video.getVideoPlaybackQuality(); decoded = q ? q.totalVideoFrames : video.webkitDecodedFrameCount; } catch (e) { decoded = undefined; }
        feed(sig.decodedFrames, decoded, n);
      };
      const setStalled = (v, n) => {
        if (v && !stats.stalledNow) { stats.stalledNow = true; stats.stalls++; stallStart = n; api.onStall && api.onStall(); }
        else if (!v && stats.stalledNow && !stats.trackEnded) stats.stalledNow = false;
        if (stats.stalledNow) stats.longestStallMs = Math.max(stats.longestStallMs, n - stallStart);
      };
      const evaluate = () => {
        const n = env.now();
        readClocks(n);
        try {
          if (track && track.readyState === 'ended') stats.trackEnded = true;
          if (track && typeof track.muted === 'boolean') stats.trackMuted = track.muted;
        } catch (e) { /* ignore */ }
        if (stats.trackEnded) { setStalled(true, n); return; }
        const rvfcAlive = n - rvfcAt <= stallMs;
        const moving = Object.values(sig).filter(s => s.changed);
        const clockFrozen = moving.length > 0 && moving.every(s => n - s.changedAt > stallMs);
        const mediaBad = !!(video.paused || video.ended || video.readyState < 2 || stats.trackMuted);
        if (mediaBad) { if (badSince === null) badSince = n; } else badSince = null;
        const mediaBadLong = badSince !== null && n - badSince > stallMs;
        setStalled(!rvfcAlive && (clockFrozen || mediaBadLong), n);
      };
      watchdog = env.setInterval(evaluate, 500);
      loop = createFrameLoop(video, f, (idx, t, meta) => {
        const n = env.now();
        const img = api.grabCrop();
        if (img) {
          stats.lastFrameAt = n;
          grabTimes.push(n);
          while (grabTimes.length && grabTimes[0] < n - 5000) grabTimes.shift();
          cb(img, { index: idx, time: t, via: meta && meta.via, crop: api.lastCrop, stalled: stats.stalledNow });
        }
      }, {
        live: true, env,
        onRvfc: (meta) => {
          const n = env.now();
          rvfcAt = n; rvfcN++;
          feed(sig.mediaTime, meta.mediaTime, n);
          if (stats.stalledNow && !stats.trackEnded) setStalled(false, n);   // a new frame arrived
        },
      });
      return loop;
    },

    /** Plain facts about the stream for a details panel. Nothing here changes behaviour. */
    diagnostics() {
      const n = env.now();
      const q = (() => { try { return video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null; } catch (e) { return null; } })();
      const clock = (s) => {
        if (!s || s.last === undefined) return 'not available';
        if (!s.changed) return 'not moving';
        return n - s.changedAt <= 2000 ? 'advancing' : 'frozen';
      };
      let trackState = 'none', muted = null;
      try { if (track) { trackState = track.readyState; muted = !!track.muted; } } catch (e) { /* ignore */ }
      const recent = grabTimes.filter(t => t >= n - 3000);
      return {
        videoWidth: video.videoWidth || 0, videoHeight: video.videoHeight || 0,
        readyState: video.readyState, paused: !!video.paused, ended: !!video.ended,
        trackState, trackMuted: muted, trackEnded: stats.trackEnded,
        delivery: loop ? (loop.via === 'none' ? 'waiting' : loop.via) : 'stopped',
        rvfcSupported: typeof video.requestVideoFrameCallback === 'function',
        rvfcCallbacks: rvfcN, rvfcDelivering: n - rvfcAt <= 2000,
        framesPerSecond: recent.length ? Math.round((recent.length / Math.max(0.5, Math.min(3, (n - loopT0) / 1000))) * 10) / 10 : 0,
        mediaTime: clock(sig && sig.mediaTime), currentTime: clock(sig && sig.currentTime), decodedFrames: clock(sig && sig.decodedFrames),
        totalVideoFrames: q ? q.totalVideoFrames : null,
        stalledNow: stats.stalledNow, stalls: stats.stalls,
        exposureLock: stats.lock.exposure, focusLock: stats.lock.focus,
      };
    },
    stopLoop() { if (loop) { loop.stop(); loop = null; } if (watchdog) { env.clearInterval(watchdog); watchdog = null; } },

    stop() {
      api.stopLoop();
      if (lockTimer) env.clearTimeout(lockTimer);
      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = null; track = null;
      video.srcObject = null;
    },
  };
  return api;
}
