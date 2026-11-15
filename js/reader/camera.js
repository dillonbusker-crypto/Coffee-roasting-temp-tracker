// Camera access, crop box and frame loop for the digit reader. UI-free: it takes a <video> element and a box and builds no DOM
// (apart from one off-screen canvas for cropping).
//
//   const cam = createCamera({ video, box: { x, y, w, h }, fps: 4 });
//   await cam.start();                      // rear camera into `video` (inline, muted), tries to lock exposure and focus
//   cam.setBox({ x, y, w, h });             // the user's box, normalised 0..1 in video coordinates
//   const img = cam.grabCrop();             // ImageData of the reader's crop, or null when the video has no frame yet
//   cam.startLoop((img, info) => { ... });  // calls back at cam.fps (default 4) with each crop
//   cam.stopLoop(); cam.stop();
//
// The reader's crop is the user's box widened to the left by one digit position (see expandBoxForDigits) so a third digit
// has room when the reading rolls over from 99 to 100, even if the box was drawn tight around two digits.

export const DIGIT_EXTENSION = 0.7; // widening to the left, as a multiple of the box height (one cell pitch is about 0.7 digit heights)
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
 * Calls cb(frameIndex, timeSec) about `fps` times a second while `video` plays, using requestVideoFrameCallback when the
 * browser has it (so each callback sees a new decoded frame) and a drift-corrected timer otherwise. Returns { stop() }.
 */
export function createFrameLoop(video, fps, cb, opts = {}) {
  let stopped = false, idx = 0, lastT = -Infinity, timer = null, handle = null;
  const period = 1 / fps;
  const useRvfc = opts.timer !== true && typeof video.requestVideoFrameCallback === 'function';
  if (useRvfc) {
    const onFrame = (now, meta) => {
      if (stopped) return;
      const t = meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : video.currentTime;
      // live streams report mediaTime in an arbitrary clock; use wall time for them
      const clock = opts.live ? now / 1000 : t;
      if (clock - lastT >= period - 0.5 / 60) { lastT = clock; cb(idx++, t); }
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

export function createCamera({ video, box = { x: 0.55, y: 0.4, w: 0.3, h: 0.15 }, fps = 4, settleMs = 1200, maxCropHeight = MAX_CROP_HEIGHT } = {}) {
  let watchdog = null, stream = null, track = null, userBox = clampBox(box), loop = null, lockTimer = null, work = { maxHeight: maxCropHeight };
  const stats = {
    framesGrabbed: 0, stalls: 0, longestStallMs: 0, stalledNow: false, trackEnded: false, trackMuted: false,
    lastFrameAt: 0, startedAt: 0, lock: { exposure: 'not tried', focus: 'not tried' }, settings: null, capabilities: null,
  };
  const api = {
    fps,
    video,
    get stream() { return stream; },
    get box() { return userBox; },
    get stats() { return Object.assign({}, stats, { lastFrameAgeMs: stats.lastFrameAt ? performance.now() - stats.lastFrameAt : null }); },
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
      stats.trackEnded = false; stats.trackMuted = false; stats.startedAt = performance.now();
      track.addEventListener('ended', () => { stats.trackEnded = true; stats.stalledNow = true; api.onEnded && api.onEnded(); });
      track.addEventListener('mute', () => { stats.trackMuted = true; });
      track.addEventListener('unmute', () => { stats.trackMuted = false; });
      video.srcObject = stream;
      await video.play();
      if (!video.videoWidth) await new Promise(res => video.addEventListener('loadedmetadata', res, { once: true }));
      try { stats.capabilities = track.getCapabilities ? track.getCapabilities() : null; stats.settings = track.getSettings(); } catch (e) { /* ignore */ }
      if (lock) lockTimer = setTimeout(() => api.lock(), settleMs);
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

    /** The box the reader actually crops: the user's box widened for a third digit. */
    readerBox() {
      const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
      return expandBoxForDigits(userBox, vw, vh);
    },

    /** ImageData of the reader's crop, or null if no frame is available yet. */
    grabCrop() {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh || video.readyState < 2) return null;
      const rb = expandBoxForDigits(userBox, vw, vh);
      const out = grabCropFrom(video, vw, vh, rb, work);
      api.lastCrop = Object.assign({ videoW: vw, videoH: vh, clipped: rb.clipped }, out.rect, { scale: out.scale });
      stats.framesGrabbed++;
      return out.imageData;
    },

    /** Call cb(imageData, info) at `fps` with each crop. Also watches for a stalled stream (no new video frame for 2 s). */
    startLoop(cb, { fps: f = fps } = {}) {
      api.stopLoop();
      api.fps = f;
      let lastTime = NaN, lastChange = performance.now();
      const markStall = () => {
        stats.stalledNow = true; stats.stalls++; api.onStall && api.onStall();
      };
      watchdog = setInterval(() => {
        const age = performance.now() - lastChange;
        if (age > 2000 && !stats.stalledNow) markStall();
        if (stats.stalledNow) stats.longestStallMs = Math.max(stats.longestStallMs, age);
      }, 500);
      loop = createFrameLoop(video, f, (idx, t) => {
        const now = performance.now();
        if (t !== lastTime) { lastTime = t; lastChange = now; stats.lastFrameAt = now; if (stats.stalledNow && !stats.trackEnded) stats.stalledNow = false; }
        const img = api.grabCrop();
        if (img) cb(img, { index: idx, time: t, crop: api.lastCrop, stalled: stats.stalledNow });
      }, { live: true });
      return loop;
    },
    stopLoop() { if (loop) { loop.stop(); loop = null; } if (watchdog) { clearInterval(watchdog); watchdog = null; } },

    stop() {
      api.stopLoop();
      if (lockTimer) clearTimeout(lockTimer);
      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = null; track = null;
      video.srcObject = null;
    },
  };
  return api;
}
