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
    readDisplay: (img) => ({ ...img, debug: img.debug || {} }),
    createFilter: opts.createFilter || createReadingFilter,
    now: () => ms,
    secureContext: () => opts.secure !== false,
    mediaDevices: () => (opts.noMedia ? undefined : { getUserMedia() {} }),
    doc: opts.doc || null,
    timers: { setInterval: () => 1, clearInterval() {} },
    requireTap: !!opts.requireTap,
    defer: opts.defer || ((fn) => fn()),
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

test('sample() closes a second: the value its frames agree on, then frames are not reused', async () => {
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
  w.feed(81, 1);
  assert.equal(w.source.sample(0), 81);
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
  w.feed(113, 1);
  assert.equal(w.source.sample(5), 113);
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
  // the old anchor (300) is gone: 81 is accepted as the first value
  w.feed(81, 1);
  assert.equal(w.source.sample(0), 81);
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
  w.feed(81, 1);
  assert.equal(w.source.sample(0), 81);
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
    settings: {}, video: w.cam.video, createCamera: () => w.cam, now: () => w.ms, doc: null, mediaDevices: () => ({ getUserMedia() {} }), defer: (fn) => fn(),
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
    settings: {}, video: w.cam.video, createCamera: () => w.cam, now: () => w.ms, doc: null, mediaDevices: () => ({ getUserMedia() {} }), defer: (fn) => fn(),
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
  w.feed(124, 1);
  assert.equal(w.source.sample(1), 124);
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
  // retries are backed off (3 s), then succeed once the camera is free again
  w.cam.failWith = null;
  w.advance(1600);
  w.source.checkNow();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.source.state, 'ended', 'too soon for another try');
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
  assert.equal(w.source.state, 'live', 'a new stream is not judged for the first 5 s');
  w.advance(5100);
  w.source.checkNow();
  assert.equal(w.source.state, 'muted');
  assert.equal(w.source.peek().status, 'none');
  w.track.muted = false;
  w.source.checkNow();
  assert.equal(w.source.state, 'live');
  w.cam.stats.stalledNow = true;
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

test('a stall is reopened only after it has lasted several seconds, and a muted track is not reopened at all while hidden or untouched', async () => {
  const w = world();
  await w.source.start();
  w.advance(6000);
  w.cam.stats.stalledNow = true;
  w.source.checkNow();
  assert.equal(w.source.state, 'stalled');
  w.advance(5000);
  w.source.checkNow();
  assert.equal(w.cam.starts, 1, 'not yet');
  w.advance(1500);
  w.source.checkNow();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.cam.starts, 2, 'reopened once the stall had lasted 6 s');
  assert.equal(w.source.diagnostics().reopens, 1);
  // a muted track waits for unmute: no reopen however long it lasts
  const m = world();
  await m.source.start();
  m.advance(6000);
  m.track.muted = true;
  for (let i = 0; i < 40; i++) { m.advance(1000); m.source.checkNow(); }
  assert.equal(m.source.state, 'muted');
  assert.equal(m.cam.starts, 1);
});

test('a muted track is reopened once, 5 s after the page became visible, if it is still muted', async () => {
  const listeners = [];
  const doc = { visibilityState: 'visible', addEventListener: (t, f) => listeners.push(f), removeEventListener() {} };
  const w = world({ doc });
  await w.source.start();
  w.advance(6000);
  w.track.muted = true;
  w.source.checkNow();
  w.advance(20000);
  w.source.checkNow();
  assert.equal(w.cam.starts, 1);
  listeners.forEach((f) => f());                  // the page comes back to the foreground
  w.advance(3000);
  w.source.checkNow();
  assert.equal(w.cam.starts, 1);
  w.advance(2500);
  w.source.checkNow();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.cam.starts, 2);
});

test('a reopen that does not help backs off instead of looping', async () => {
  const w = world();
  await w.source.start();
  w.advance(6000);
  for (let i = 0; i < 120; i++) {                 // two minutes: every new stream is dead on arrival
    w.advance(1000);
    w.track.readyState = 'ended';
    w.source.checkNow();
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(w.cam.starts <= 8, `${w.cam.starts} stream openings in 2 minutes`);
  assert.ok(w.cam.starts >= 4);
});

test('diagnostics() reports reader frame counts and passes the camera facts through', async () => {
  const w = world();
  w.cam.diagnostics = () => ({ delivery: 'rvfc' });
  await w.source.start();
  w.feed(77, 1);
  w.feed(0, 1, 'dashes');
  const d = w.source.diagnostics();
  assert.equal(d.delivery, 'rvfc');
  assert.deepEqual([d.readerOk, d.readerDashes, d.readerNone, d.reopens, d.state], [4, 4, 0, 0, 'live']);
});

// A source with a deferred reader: grabbing and reading are separate turns, and the reader can be slow.
function slowWorld(readMs) {
  const queue = [];
  const w = world({ defer: (fn) => queue.push(fn) });
  const reads = [];
  w.source = createCameraSource({
    settings: { reader: { fps: 4 } }, video: w.cam.video, createCamera: () => w.cam, now: () => w.ms, doc: null,
    mediaDevices: () => ({ getUserMedia() {} }), timers: { setInterval: () => 1, clearInterval() {} },
    defer: (fn) => queue.push(fn),
    readDisplay: (img) => { reads.push(img.value); w.advance(typeof readMs === 'function' ? readMs(img) : readMs); return { ...img, debug: {} }; },
  });
  w.flush = () => { while (queue.length) queue.shift()(); };
  w.reads = reads;
  return w;
}

test('a grabbed picture reaches the listeners before it is read, and only the newest waiting picture is read', async () => {
  const w = slowWorld(5);
  await w.source.start();
  const drawn = [];
  w.source.onFrame((f) => drawn.push(f.imageData.value));
  w.advance(250); w.cam.frame({ status: 'ok', value: 70 });
  assert.deepEqual(drawn, [70]);
  assert.deepEqual(w.reads, [], 'not read yet: the page can paint first');
  w.advance(250); w.cam.frame({ status: 'ok', value: 71 });      // a newer picture arrives before the read ran
  assert.deepEqual(drawn, [70, 71]);
  w.flush();
  assert.deepEqual(w.reads, [71], 'the stale picture was replaced');
  assert.equal(w.source.perf.dropped, 1);
  assert.equal(w.source.peek().value, 71);
});

test('after a read slower than the frame period the pictures are skipped for as long again, yet the listeners still see every one', async () => {
  const w = slowWorld((img) => (img.value === 90 ? 700 : 5));
  await w.source.start();
  const drawn = [];
  w.source.onFrame((f) => drawn.push(f.imageData.value));
  w.advance(250); w.cam.frame({ status: 'ok', value: 90 }); w.flush();   // takes 700 ms
  for (const v of [91, 92, 93]) { w.advance(250); w.cam.frame({ status: 'ok', value: v }); w.flush(); }   // inside the cooldown
  assert.deepEqual(drawn, [90, 91, 92, 93], 'the magnifier is never starved');
  assert.deepEqual(w.reads, [90, 93], 'the 700 ms read was followed by 700 ms of skipping: 91 and 92 were not read');
});

test('diagnostics() separates the cost of readable and unreadable pictures and counts the magnifier updates', async () => {
  const w = slowWorld((img) => (img.status === 'none' ? 40 : 6));
  await w.source.start();
  w.source.onFrame(() => {});
  for (let i = 0; i < 8; i++) { w.advance(1000); w.cam.frame(i % 2 ? { status: 'none', value: null } : { status: 'ok', value: 81 }); w.flush(); }
  const d = w.source.diagnostics();
  assert.equal(Math.round(d.readMsAvgReadable), 6);
  assert.equal(Math.round(d.readMsAvgUnreadable), 40);
  assert.equal(d.readMsMax, 40);
  assert.ok(d.magnifierPerSecond > 0.5 && d.readsPerSecond > 0.5);
});

// ---- why a second was not read ----

const miss = (reason, extra = {}) => ({ status: 'none', value: null, width: 100, height: 40, debug: { reason, ...extra } });

test('a second with no reading is tallied under its most common reason, and the roast tally goes into health().missReasons', async () => {
  const w = world();
  await w.source.start();
  await w.source.start();                                   // the roast starts
  for (const [reason, n] of [['ambiguous segment', 3], ['segments mid-fade', 2], ['low contrast', 1]]) {
    for (let i = 0; i < n; i++) { w.advance(250); w.cam.frame(miss(reason)); }
  }
  assert.equal(w.source.sample(0), null);                   // 5 unclear digit frames beat 1 faint
  w.feed(0, 1, 'dashes');
  assert.equal(w.source.sample(1), null);
  w.advance(1500);                                          // no pictures at all
  assert.equal(w.source.sample(2), null);
  w.advance(250); w.cam.frame(miss('digit cut off at the right edge of the crop'));
  w.source.sample(3);
  w.feed(81, 1);
  assert.equal(w.source.sample(4), 81);
  assert.deepEqual(w.source.health().missReasons, { 'unclear digit': 1, 'no probe': 1, 'no picture': 1, 'digit cut off': 1 });
  const d = w.source.diagnostics();
  assert.equal(d.tallyRead, 1);
  assert.equal(d.tally['unclear digit'], 1);
  assert.deepEqual(d.lastOutcomes, ['unclear digit', 'dashes', 'no picture', 'digit cut off', '81']);
  // a fresh roast starts the tally again
  await w.source.start();
  assert.deepEqual(w.source.health().missReasons, {});
});

test('filter rejections are named with both values: out of range, jump too big, frames disagreed', async () => {
  const w = world();
  await w.source.start();
  await w.source.start();
  w.feed(100, 1); assert.equal(w.source.sample(0), 100);
  w.feed(300, 1); assert.equal(w.source.sample(1), null);
  w.advance(1000); for (const v of [46, 46, 46, 46]) { w.advance(250); w.cam.frame({ status: 'ok', value: v, debug: {} }); }
  assert.equal(w.source.sample(2), null);
  w.advance(1000); for (const v of [100, 129, 100, 129]) { w.advance(250); w.cam.frame({ status: 'ok', value: v, debug: {} }); }
  assert.equal(w.source.sample(3), null);
  const d = w.source.diagnostics();
  assert.deepEqual(d.lastOutcomes, ['100', 'jump too big (100 to 300)', 'out of range (46)', 'frames disagreed']);
  assert.deepEqual(w.source.health().missReasons, { 'jump too big': 1, 'out of range': 1, 'frames disagreed': 1 });
});

test('before the roast the diagnostics tick closes a shadow second without touching the roast filter', async () => {
  const w = world();
  await w.source.start();
  w.feed(90, 1); w.source.diagTick();
  w.feed(0, 1, 'none'); w.source.diagTick();
  assert.deepEqual(w.source.diagnostics().lastOutcomes, ['90', 'unreadable']);
  const h = w.source.health();
  assert.deepEqual([h.secondsRead, h.rejected, h.secondsMissing], [0, 0, 0]);
  assert.deepEqual(h.missReasons, {});
});

test('explain(): the most common reason over 2 s, only when it cannot read, with out-of-range and jump notes', async () => {
  const w = world();
  await w.source.start();
  assert.equal(w.source.explain().label, 'no picture');
  for (const r of ['digit cut off at the right edge of the crop', 'ambiguous segment', 'digit cut off at the right edge of the crop', 'digit cut off at the right edge of the crop']) { w.advance(250); w.cam.frame(miss(r)); }
  const e = w.source.explain();
  assert.equal(e.label, 'digit cut off');
  assert.equal(e.text, 'A digit is cut off at the right edge.');
  assert.equal(e.hint, 'Move the box right.');
  w.feed(77, 1);
  assert.equal(w.source.explain(), null, 'readable again: nothing to explain');
  w.advance(3000); w.feed(23, 1);
  assert.match(w.source.explain().text, /23°F is outside the accepted range of 50 to 550/);
  w.advance(3000); w.feed(0, 1, 'dashes');
  assert.equal(w.source.explain(), null, 'dashes have their own status line');
  // frames that read but disagree
  w.advance(3000);
  for (const v of [60, 90, 120, 150]) { w.advance(250); w.cam.frame({ status: 'ok', value: v, debug: {} }); }
  assert.equal(w.source.explain().kind, 'disagree');
});

test('the newest readable and unreadable pictures are kept exactly as the reader got them', async () => {
  const w = world();
  await w.source.start();
  const ok1 = { status: 'ok', value: 77, digits: '77', width: 100, height: 40, debug: { scale: 2, geometry: { H: 60 } } };
  const miss1 = miss('ambiguous segment', { digits: '7?' });
  const ok2 = { status: 'ok', value: 81, digits: '81', width: 120, height: 48, debug: { scale: 2, geometry: { H: 80 } } };
  w.advance(250); w.cam.frame(ok1);
  w.advance(250); w.cam.frame(miss1);
  let c = w.source.captured();
  assert.equal(c.ok.imageData, ok1);
  assert.equal(c.miss.imageData, miss1, 'the same object the reader read');
  assert.equal(c.miss.reason, 'ambiguous segment');
  assert.equal(c.miss.label, 'unclear digit');
  w.advance(250); w.cam.frame(ok2);
  c = w.source.captured();
  assert.equal(c.ok.imageData, ok2, 'the newest readable one');
  assert.equal(c.miss.imageData, miss1, 'the unreadable one stays until a newer miss');
  const d = w.source.diagnostics();
  assert.deepEqual([d.cropW, d.cropH, d.digitH], [120, 48, 40]);
  assert.equal(d.lastOkValue, 81);
  assert.equal(d.capturedMiss.reason, 'ambiguous segment');
  assert.equal(d.capturedOk.w, 120);
});

// ---- time confirmation of tentative readings (reader/confirm.js) and the observed-value rule ----

const seg = (v) => ({ masks: [0, 7, 7], c: [Array(7).fill(0.02), [v, v, v, 0, 0, 0, 0], [v, v, v, 0, 0, 0, 0]] });
const veiledFrame = (v, value = 77) => ({ status: 'none', value: null, digits: [], confidence: 0,
  debug: { reason: 'ambiguous segment', seg7: seg(v), tentative: { value, digits: [null, 7, 7], confidence: 0.6 } } });

test('a veiled reading that holds still is accepted from the second picture on; a lone one is not', async () => {
  const w = world();
  await w.source.start();
  w.advance(250); w.cam.frame(veiledFrame(0.40));
  assert.equal(w.source.sample(0), null, 'one tentative picture is not a reading');
  assert.equal(w.source.diagnostics().lastOutcomes.pop(), 'unsteady digit');
  for (const v of [0.41, 0.40, 0.42, 0.41]) { w.advance(250); w.cam.frame(veiledFrame(v)); }
  assert.equal(w.source.sample(1), 77);
});

test('a veil that is moving, or a segment changing, never becomes a value', async () => {
  const w = world();
  await w.source.start();
  for (const v of [0.25, 0.45, 0.65, 0.4]) { w.advance(250); w.cam.frame(veiledFrame(v)); }
  assert.equal(w.source.sample(0), null);
  assert.equal(w.source.health().secondsRead, 0);
});

test('the pictures after a box change are not confirmed against pictures of the old box', async () => {
  const w = world();
  await w.source.start();
  w.advance(250); w.cam.frame(veiledFrame(0.40));
  w.source.setBox({ x: 0.1, y: 0.1, w: 0.3, h: 0.15 });
  w.advance(250); w.cam.frame(veiledFrame(0.40));
  assert.equal(w.source.sample(0), null);
});

test('a number the thermometer cannot show is not a reading and is named as such', async () => {
  const w = world();
  await w.source.start();
  await w.source.start();
  w.feed(254, 1);                                  // 254 is not round(1.8 c + 32) for a whole c
  assert.equal(w.source.sample(0), null);
  const d = w.source.diagnostics();
  assert.deepEqual(d.lastOutcomes, ['impossible number']);
  assert.deepEqual(w.source.health().missReasons, { 'impossible number': 1 });
  w.feed(253, 1);
  assert.equal(w.source.sample(1), 253);
});

test('peek() shows a value that was actually seen, never an average of two', async () => {
  const w = world();
  await w.source.start();
  for (const v of [253, 255, 253, 255]) { w.advance(250); w.cam.frame({ status: 'ok', value: v }); }
  assert.equal(w.source.peek().value, 255, 'level: the later one, not 254');
});
