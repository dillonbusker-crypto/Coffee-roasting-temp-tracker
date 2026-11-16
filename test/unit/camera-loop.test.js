import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCamera, createFrameLoop } from '../../js/reader/camera.js';

// A virtual world: one millisecond clock, timers, and a fake <video> that presents frames at 30 per second.
// Options say what the browser does: whether rVFC exists and calls back, and whether mediaTime and currentTime move.
function world(opts = {}) {
  const o = { rvfc: 'fires', mediaTime: 'zero', currentTime: 'const', ...opts };
  let ms = 1000, nextId = 1;
  const timers = new Map();
  const listeners = {};
  const track = {
    readyState: 'live', muted: false,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    stop() { this.readyState = 'ended'; },
    getSettings: () => ({}), getCapabilities: () => ({}),
  };
  const w = { track, video: null, flowing: true, deliveries: [], infos: [], stalls: 0 };
  let pending = null, frameNo = 0, nextFrame = ms + 33;
  const video = {
    videoWidth: 1280, videoHeight: 720, readyState: 4, paused: false, ended: false, srcObject: null,
    muted: true, defaultMuted: true, playsInline: true, autoplay: true,
    setAttribute() {}, addEventListener() {},
    play() { this.paused = false; return Promise.resolve(); },
    get currentTime() { return o.currentTime === 'advance' ? frameNo / 30 : 0; },
  };
  if (o.rvfc !== 'absent') {
    video.requestVideoFrameCallback = (fn) => { pending = fn; return 1; };
    video.cancelVideoFrameCallback = () => { pending = null; };
  }
  w.video = video;
  w.dispatch = (type) => (listeners[type] || []).forEach((fn) => fn({ type }));
  w.env = {
    now: () => ms,
    setTimeout: (fn, d) => { const id = nextId++; timers.set(id, { at: ms + d, fn, every: null }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, d) => { const id = nextId++; timers.set(id, { at: ms + d, fn, every: d }); return id; },
    clearInterval: (id) => timers.delete(id),
  };
  w.setRvfc = (mode) => { o.rvfc = mode; };
  w.advance = (sec) => {
    const end = ms + sec * 1000;
    for (;;) {
      let due = null, dueId = null;
      for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due.at)) { due = t; dueId = id; }
      const frameDue = nextFrame <= end && (!due || nextFrame <= due.at);
      if (!due && nextFrame > end) break;
      if (frameDue) {
        ms = nextFrame; nextFrame += 1000 / 30;
        if (w.flowing) {
          frameNo++;
          if (pending && o.rvfc === 'fires') {
            const fn = pending; pending = null;
            fn(ms, { mediaTime: o.mediaTime === 'advance' ? frameNo / 30 : 0, presentedFrames: frameNo });
          }
        }
      } else {
        ms = due.at;
        if (due.every) due.at += due.every; else timers.delete(dueId);
        due.fn();
      }
    }
    ms = end;
  };
  return w;
}

// Node has no document or navigator.mediaDevices: give createCamera just enough of both.
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) }),
  }),
};

async function camera(w, fps = 4) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getVideoTracks: () => [w.track], getTracks: () => [w.track] }) } },
  });
  const cam = createCamera({ video: w.video, fps, env: w.env });
  cam.onStall = () => { w.stalls++; };
  await cam.start({ lock: false });
  cam.startLoop((img, info) => { w.deliveries.push(w.env.now()); w.infos.push(info); });
  return cam;
}

const gaps = (a) => a.slice(1).map((t, i) => t - a[i]);

test('rVFC firing with mediaTime stuck at 0 and a fixed currentTime is never a stall (the iPhone case)', async () => {
  const w = world({ rvfc: 'fires', mediaTime: 'zero', currentTime: 'const' });
  const cam = await camera(w);
  w.advance(30);
  assert.equal(w.stalls, 0);
  assert.equal(cam.stats.stalledNow, false);
  assert.ok(w.infos.every((i) => i.stalled === false));
  const perSec = w.deliveries.length / 30;
  assert.ok(perSec > 3.5 && perSec <= 4.05, `${perSec} frames a second`);
  assert.ok(w.infos.every((i) => i.via === 'rvfc'));
  assert.ok(Math.min(...gaps(w.deliveries)) >= 245, 'never faster than the target rate');
  const d = cam.diagnostics();
  assert.equal(d.delivery, 'rvfc');
  assert.equal(d.mediaTime, 'not moving');
  assert.equal(d.currentTime, 'not moving');
  assert.ok(d.rvfcCallbacks > 800);
});

test('rVFC that never calls back, with the clock frozen and the video playing: the timer delivers and it is never a stall', async () => {
  for (const rvfc of ['silent', 'absent']) {
    const w = world({ rvfc, mediaTime: 'zero', currentTime: 'const' });
    const cam = await camera(w);
    w.advance(30);
    assert.equal(w.stalls, 0, rvfc);
    assert.equal(cam.stats.stalledNow, false, rvfc);
    const perSec = w.deliveries.length / 30;
    assert.ok(perSec > 3.6 && perSec <= 4.05, `${rvfc}: ${perSec} frames a second`);
    assert.ok(w.infos.every((i) => i.via === 'timer' && i.stalled === false));
    assert.equal(cam.diagnostics().delivery, 'timer');
  }
});

test('rVFC firing and then stopping with the track muted is a stall', async () => {
  const w = world({ rvfc: 'fires' });
  const cam = await camera(w);
  w.advance(5);
  assert.equal(cam.stats.stalledNow, false);
  w.flowing = false; w.track.muted = true; w.dispatch('mute');
  w.advance(1.4);
  assert.equal(cam.stats.stalledNow, false, 'not yet: the stall period has not passed');
  w.advance(2);
  assert.equal(cam.stats.stalledNow, true);
  assert.equal(w.stalls, 1);
  assert.equal(cam.stats.trackMuted, true);
  assert.ok(w.infos.slice(-2).every((i) => i.stalled === true), 'frames from a stalled stream are flagged');
  // it comes back
  w.flowing = true; w.track.muted = false; w.dispatch('unmute');
  w.advance(1);
  assert.equal(cam.stats.stalledNow, false);
});

test('a clock that moved and then froze, with no rVFC, is a stall after the stall period', async () => {
  const w = world({ rvfc: 'absent', currentTime: 'advance' });
  const cam = await camera(w);
  w.advance(5);
  assert.equal(cam.stats.stalledNow, false);
  assert.equal(cam.diagnostics().currentTime, 'advancing');
  w.flowing = false;
  w.advance(1.5);
  assert.equal(cam.stats.stalledNow, false);
  w.advance(1.6);
  assert.equal(cam.stats.stalledNow, true);
  assert.equal(cam.diagnostics().currentTime, 'frozen');
  w.flowing = true;
  w.advance(1);
  assert.equal(cam.stats.stalledNow, false);
});

test('a track that ended is reported at once, with or without the event', async () => {
  const w = world({ rvfc: 'fires' });
  const cam = await camera(w);
  w.advance(3);
  w.track.readyState = 'ended';                      // track.stop(): no 'ended' event
  w.advance(1);
  assert.equal(cam.stats.trackEnded, true);
  assert.equal(cam.stats.stalledNow, true);
  const w2 = world({ rvfc: 'fires' });
  const cam2 = await camera(w2);
  w2.advance(3);
  w2.track.readyState = 'ended'; w2.dispatch('ended');
  assert.equal(cam2.stats.trackEnded, true);
});

test('a paused video is a stall only after the stall period, and only when nothing else shows frames', async () => {
  const w = world({ rvfc: 'absent', mediaTime: 'zero', currentTime: 'const' });
  const cam = await camera(w);
  w.advance(4);
  assert.equal(cam.stats.stalledNow, false);
  w.video.paused = true;
  w.advance(1.5);
  assert.equal(cam.stats.stalledNow, false);
  w.advance(1.6);
  assert.equal(cam.stats.stalledNow, true);
  w.video.paused = false;
  w.advance(1);
  assert.equal(cam.stats.stalledNow, false);
});

test('rVFC and the timer never deliver twice: gaps stay at the target period while rVFC comes and goes', async () => {
  const w = world({ rvfc: 'fires' });
  const cam = await camera(w, 4);
  w.advance(6);
  w.setRvfc('silent'); w.advance(3);                  // rVFC stops: the timer takes over
  w.setRvfc('fires'); w.advance(6);                   // and back (the pending callback is re-armed by the loop)
  const g = gaps(w.deliveries);
  assert.ok(Math.min(...g) >= 245, `shortest gap ${Math.min(...g)} ms`);
  assert.equal(new Set(w.deliveries).size, w.deliveries.length, 'never the same instant twice');
  const vias = w.infos.map((i) => i.via);
  assert.ok(vias.includes('timer') && vias.slice(-10).every((v) => v === 'rvfc'), 'timer filled the gap, rVFC took over again');
  assert.equal(w.stalls, 0);
  cam.stopLoop();
});

test('createFrameLoop on its own: live mode respects the rate with a 60 fps rVFC', () => {
  const w = world({ rvfc: 'fires' });
  const got = [];
  const loop = createFrameLoop(w.video, 5, (i, t, m) => got.push(w.env.now()), { live: true, env: w.env });
  w.advance(10);
  loop.stop();
  assert.ok(got.length >= 45 && got.length <= 51, `${got.length} frames in 10 s at 5 fps`);
  const n = got.length;
  w.advance(2);
  assert.equal(got.length, n, 'stop() stops delivery');
});
