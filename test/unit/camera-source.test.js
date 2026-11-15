import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCameraSource, classifyError } from '../../js/sources/camera-source.js';
import { createReadingFilter } from '../../js/reader/filter.js';

// A fake camera and reader. A "frame" is just { status, value }; the fake reader returns it unchanged.
function world(opts = {}) {
  let ms = 1000;
  const track = { readyState: 'live', muted: false };
  const cam = {
    video: { paused: false, play() { return Promise.resolve(); } },
    box: { x: 0.5, y: 0.4, w: 0.3, h: 0.15 },
    lastCrop: null,
    stats: { trackEnded: false, trackMuted: false, stalledNow: false },
    stream: null,
    starts: 0, stops: 0, loopStarts: 0,
    cb: null,
    failWith: null,
    gate: null,                                   // a promise start() waits for
    async start() {
      this.starts++;
      if (this.gate) await this.gate;
      if (this.failWith) throw this.failWith;
      track.readyState = 'live'; track.muted = false;
      this.stats.trackEnded = false; this.stats.stalledNow = false;
      this.stream = { getVideoTracks: () => [track] };
    },
    stop() { this.stops++; this.stream = null; track.readyState = 'ended'; },
    startLoop(cb) { this.loopStarts++; this.cb = cb; },
    stopLoop() { this.cb = null; },
    setBox(b) { this.box = b; },
    readerBox() { return this.box; },
    // push one frame into the source
    frame(res, info = {}) { if (this.cb) this.cb(res, { index: 0, time: ms, crop: null, stalled: false, ...info }); },
  };
  const w = {
    cam, track,
    get ms() { return ms; },
    advance(d) { ms += d; },
    // Frames at 4 per second for `sec` seconds, all reading `value`; returns once the time has passed
    feed(value, sec = 1, status = 'ok') {
      for (let i = 0; i < sec * 4; i++) { ms += 250; cam.frame({ status, value: status === 'ok' ? value : null }); }
    },
    source: null,
  };
  w.source = createCameraSource({
    settings: { reader: { fps: 4, minF: 50, maxF: 550, maxJumpF: 15 } },
    video: cam.video,
    createCamera: () => cam,
    readDisplay: (img) => ({ ...img, debug: {} }),
    createFilter: opts.createFilter || createReadingFilter,
    now: () => ms,
    secureContext: () => opts.secure !== false,
    mediaDevices: () => (opts.noMedia ? undefined : { getUserMedia() {} }),
    doc: null,
    timers: { setInterval: () => 1, clearInterval() {} },
    requireTap: !!opts.requireTap,
  });
  return w;
}

test('start() is idempotent: the stream opens once, a second start keeps it', async () => {
  const w = world();
  await w.source.start();
  assert.equal(w.source.state, 'live');
  await w.source.start();
  await w.source.start();
  assert.equal(w.cam.starts, 1);
  assert.equal(w.cam.loopStarts, 1);
  assert.equal(w.cam.stops, 0);
});

test('two start() calls at once open the camera once', async () => {
  const w = world();
  await Promise.all([w.source.start(), w.source.start()]);
  assert.equal(w.cam.starts, 1);
  assert.equal(w.source.state, 'live');
});

test('sample() closes a second: median of its frames, then frames are not reused', async () => {
  const w = world();
  await w.source.start();
  w.feed(77, 1);
  assert.equal(w.source.sample(0), 77);
  assert.equal(w.source.sample(1), null);       // no new frames since: a gap, not 77 again
  w.feed(79, 1);
  assert.equal(w.source.sample(2), 79);
  const h = w.source.health();
  assert.deepEqual([h.secondsRead, h.rejected, h.secondsMissing], [2, 0, 1]);
});

test('a second with disagreeing or unreadable frames is a gap; a bad jump is rejected and counted', async () => {
  const w = world();
  await w.source.start();
  w.feed(80, 1);
  assert.equal(w.source.sample(0), 80);
  w.feed(null, 1, 'none');
  assert.equal(w.source.sample(1), null);
  w.feed(200, 1);                                // 120 degrees in 2 seconds
  assert.equal(w.source.sample(2), null);
  assert.deepEqual([w.source.health().rejected, w.source.health().secondsMissing], [1, 1]);
});

test('a missed tick is a gap, counts as missing and never reuses stale frames', async () => {
  const w = world();
  await w.source.start();
  w.feed(100, 1);
  assert.equal(w.source.sample(0), 100);
  // the page is throttled: frames from before the stall are sitting in the buffer, then the clock catches up
  w.feed(110, 1);
  w.advance(5000);
  assert.equal(w.source.sample(1, { missed: true }), null);
  assert.equal(w.source.sample(2, { missed: true }), null);
  assert.equal(w.source.sample(3, { missed: true }), null);
  // the last tick of the batch is not flagged, but the frames from before the stall are too old to use
  assert.equal(w.source.sample(4, { missed: false }), null);
  w.feed(112, 1);
  assert.equal(w.source.sample(5), 112);
  const h = w.source.health();
  assert.equal(h.secondsRead, 2);
  assert.equal(h.secondsMissing, 4);
});

test('a missed tick right after frames came in does not let the next tick reuse them', async () => {
  const w = world();
  await w.source.start();
  w.feed(90, 1);
  assert.equal(w.source.sample(0, { missed: true }), null);
  assert.equal(w.source.sample(1), null);        // those frames were already "spent" by the missed tick
  w.feed(91, 1);
  assert.equal(w.source.sample(2), 91);
});

test('peek() reads the recent frames and never consumes the per-second state', async () => {
  const w = world();
  await w.source.start();
  assert.deepEqual(w.source.peek(), { value: null, status: 'none' });
  w.feed(77, 1);
  assert.deepEqual(w.source.peek(), { value: 77, status: 'ok' });
  assert.deepEqual(w.source.peek(), { value: 77, status: 'ok' });
  const h = w.source.health();
  assert.deepEqual([h.secondsRead, h.rejected, h.secondsMissing], [0, 0, 0]);
  assert.equal(w.source.sample(0), 77);          // the frames are all still there for the roast
  assert.equal(w.source.peek().value, 77);       // and peek still sees them
});

test('peek() tells a good read, dashes and nothing readable apart, and ignores a lone odd frame', async () => {
  const w = world();
  await w.source.start();
  w.feed(0, 1, 'dashes');
  assert.deepEqual(w.source.peek(), { value: null, status: 'dashes' });
  w.feed(null, 1, 'none');
  assert.deepEqual(w.source.peek(), { value: null, status: 'none' });
  // three agreeing frames and one that is off: the value is the agreeing one
  w.advance(2000);
  for (const v of [88, 88, 91, 88]) { w.advance(250); w.cam.frame({ status: 'ok', value: v }); }
  assert.deepEqual(w.source.peek(), { value: 88, status: 'ok' });
  // frames that contradict each other are not a value
  w.advance(2000);
  for (const v of [60, 90, 120, 150]) { w.advance(250); w.cam.frame({ status: 'ok', value: v }); }
  assert.deepEqual(w.source.peek(), { value: null, status: 'none' });
  // a stale peek: nothing for two seconds
  w.advance(2000);
  assert.deepEqual(w.source.peek(), { value: null, status: 'none' });
});

test('starting the roast resets the filter and the health counters; the stream stays up', async () => {
  const w = world();
  await w.source.start();                        // Setup's preview
  w.feed(300, 1);
  w.source.sample(0);                            // anything counted before the roast...
  w.feed(null, 1, 'none');
  w.source.sample(1);
  assert.equal(w.source.health().secondsRead, 1);
  await w.source.start();                        // the roast controller
  assert.deepEqual(w.source.health().secondsRead + w.source.health().secondsMissing + w.source.health().rejected, 0);
  assert.equal(w.cam.starts, 1);
  // the old anchor (300) is gone: 80 is accepted as the first value
  w.feed(80, 1);
  assert.equal(w.source.sample(0), 80);
});

test('frames from the last second before Start count for second 0', async () => {
  const w = world();
  await w.source.start();
  w.feed(77, 2);
  await w.source.start();
  assert.equal(w.source.sample(0), 77);
});

test('reanchor() hands a typed reading to the filter', async () => {
  const w = world();
  await w.source.start();
  w.feed(80, 1);
  assert.equal(w.source.sample(0), 80);
  w.source.reanchor(200);                        // the user typed 200
  w.feed(82, 1);
  assert.equal(w.source.sample(1), null);        // 82 is now a 118 degree jump from what the filter trusts
  assert.equal(w.source.health().rejected, 1);
  w.feed(201, 1);
  assert.equal(w.source.sample(2), 201);
});

test('frames flagged stalled are never read, and a frame is dropped while the previous one is still being read', async () => {
  const w = world();
  let inner = null;
  w.source = createCameraSource({
    settings: {}, video: w.cam.video, createCamera: () => w.cam, now: () => w.ms, doc: null, mediaDevices: () => ({ getUserMedia() {} }),
    timers: { setInterval: () => 1, clearInterval() {} },
    readDisplay: (img) => { if (inner) { const f = inner; inner = null; f(); } return { ...img, debug: {} }; },
  });
  await w.source.start();
  w.advance(250); w.cam.frame({ status: 'ok', value: 77 }, { stalled: true });
  assert.equal(w.source.peek().status, 'none');
  inner = () => w.cam.frame({ status: 'ok', value: 99 });   // a second frame arrives while the first is in the reader
  w.advance(250); w.cam.frame({ status: 'ok', value: 77 });
  assert.equal(w.source.perf.dropped, 1);
  assert.equal(w.source.perf.frames, 1);
});

test('a reader that throws gives an unreadable frame, not a dead loop', async () => {
  const w = world();
  w.source = createCameraSource({
    settings: {}, video: w.cam.video, createCamera: () => w.cam, now: () => w.ms, doc: null, mediaDevices: () => ({ getUserMedia() {} }),
    timers: { setInterval: () => 1, clearInterval() {} },
    readDisplay: () => { throw new Error('boom'); },
  });
  await w.source.start();
  w.feed(77, 1);
  assert.equal(w.source.sample(0), null);
  assert.equal(w.source.perf.errors, 4);
});

test('permission denied, no camera, insecure page and other errors each get their own state', async () => {
  for (const [name, state] of [['NotAllowedError', 'denied'], ['PermissionDeniedError', 'denied'], ['NotFoundError', 'no-camera'], ['NotReadableError', 'error']]) {
    const w = world();
    w.cam.failWith = Object.assign(new Error('x'), { name });
    await w.source.start();                      // never throws: Setup shows the state instead
    assert.equal(w.source.state, state, name);
    assert.equal(w.source.peek().status, 'none');
  }
  const i = world({ secure: false });
  await i.source.start();
  assert.equal(i.source.state, 'insecure');
  assert.equal(i.cam.starts, 0);
  const n = world({ noMedia: true });
  await n.source.start();
  assert.equal(n.source.state, 'unsupported');
  assert.equal(classifyError({ name: 'SecurityError' }), 'denied');
});

test('retry() after a denial opens the camera', async () => {
  const w = world();
  w.cam.failWith = Object.assign(new Error('x'), { name: 'NotAllowedError' });
  await w.source.start();
  assert.equal(w.source.state, 'denied');
  w.cam.failWith = null;
  await w.source.retry();
  assert.equal(w.source.state, 'live');
});

test('requireTap: start() waits for requestAccess()', async () => {
  const w = world({ requireTap: true });
  const seen = [];
  w.source.onState((s) => seen.push(s.state));
  await w.source.start();
  assert.equal(w.source.state, 'needs-tap');
  assert.equal(w.cam.starts, 0);
  await w.source.requestAccess();
  assert.equal(w.source.state, 'live');
  assert.deepEqual(seen, ['needs-tap', 'requesting', 'live']);
});

test('stop() while the camera is still opening shuts the stream as soon as it arrives', async () => {
  const w = world();
  let release;
  w.cam.gate = new Promise((r) => { release = r; });
  const p = w.source.start();
  w.source.stop();
  release();
  await p;
  assert.equal(w.source.state, 'stopped');
  assert.ok(w.cam.stops >= 2);
  assert.equal(w.cam.stream, null);
});

test('a dead track is reported, gaps are logged meanwhile, and the stream comes back', async () => {
  const w = world();
  await w.source.start();
  w.feed(120, 1);
  assert.equal(w.source.sample(0), 120);
  // the page is backgrounded and iOS ends the track
  w.track.readyState = 'ended';
  w.source.checkNow();
  assert.equal(w.source.state, 'recovering' === w.source.state ? 'recovering' : 'ended');
  await new Promise((r) => setImmediate(r));
  // restart() ran: the fake camera opened a new stream
  assert.equal(w.cam.starts, 2);
  assert.equal(w.source.state, 'live');
  w.feed(123, 1);
  assert.equal(w.source.sample(1), 123);
});

test('while the camera cannot come back, state says so and sample() yields gaps', async () => {
  const w = world();
  await w.source.start();
  w.feed(120, 1);
  assert.equal(w.source.sample(0), 120);
  w.cam.failWith = Object.assign(new Error('Camera in use'), { name: 'NotReadableError' });
  w.track.readyState = 'ended';
  w.source.checkNow();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.source.state, 'ended');
  assert.match(w.source.message, /in use/);
  w.feed(121, 1);                                // late frames from a dead stream are not used
  assert.equal(w.source.sample(1), null);
  assert.equal(w.source.health().secondsMissing, 1);
  // retries are backed off, then succeed once the camera is free again
  w.cam.failWith = null;
  w.advance(1600);
  w.source.checkNow();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.source.state, 'live');
});

test('a muted track and a stalled video are reported; a stall right after a restart is not', async () => {
  const w = world();
  await w.source.start();
  w.track.muted = true;
  w.source.checkNow();
  assert.equal(w.source.state, 'muted');
  assert.equal(w.source.peek().status, 'none');
  w.track.muted = false;
  w.source.checkNow();
  assert.equal(w.source.state, 'live');
  w.cam.stats.stalledNow = true;
  w.source.checkNow();
  assert.equal(w.source.state, 'live');          // within 2.5 s of opening
  w.advance(3000);
  w.source.checkNow();
  assert.equal(w.source.state, 'stalled');
  w.cam.stats.stalledNow = false;
  w.source.checkNow();
  assert.equal(w.source.state, 'live');
});

test('setBox() moves the box and forgets frames read from the old one', async () => {
  const w = world();
  await w.source.start();
  w.feed(77, 1);
  w.source.setBox({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
  assert.equal(w.cam.box.x, 0.1);
  assert.equal(w.source.peek().status, 'none');
});

test('health() has the three numbers a roast record stores', async () => {
  const w = world();
  await w.source.start();
  const h = w.source.health();
  for (const k of ['secondsRead', 'rejected', 'secondsMissing']) assert.equal(typeof h[k], 'number');
  assert.equal(w.source.kind, 'camera');
});
