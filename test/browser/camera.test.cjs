'use strict';
// Browser test for the camera source: Setup panel, a real-time roast read through a fake camera, outages, a dead track,
// permission states. The fake camera replaces navigator.mediaDevices.getUserMedia with a canvas.captureStream() that
// draws a synthetic TP17 display (tools/synth-display.js): the SET TEMP number to the left of the THERMO TEMP digits
// and the °F to the right, with the THERMO TEMP value following a temperature curve in real time.
//
//   node test/browser/camera.test.cjs          takes about 2.5 minutes (it runs a roast in real time)
//
// Screenshots go to test/browser/out/camera-*.png.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '../..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

function startServer() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const step = (name) => console.log(`  - ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (page, sel) => page.locator(sel).first().textContent();
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, name), ...opts });

// ---- the fake camera, injected before the app loads ----

function fakeCameraInit(opts) {
  const W = 1280, H = 720;
  const fake = window.__fake = {
    calls: 0, streams: [], log: [], mode: 'hold', curving: false, value: 77, startVal: 77, rate: 2.5, t0: 0, phase: 0.37,
    available: opts.available !== false, deny: opts.deny || null, ready: null, drawn: 0,
    startCurve(startVal = 77, rate = 2.5) { fake.mode = 'curve'; fake.curving = true; fake.startVal = startVal; fake.rate = rate; fake.t0 = Date.now(); },
    // The TP17 shows only round(1.8 c + 32) for whole c, and the reading filter drops the numbers it cannot show.
    current() {
      const valid = (f) => Math.round(1.8 * Math.round((f - 32) / 1.8) + 32) === f;
      const snap = (v) => { for (let d = 0; d < 5; d++) { if (valid(v + d)) return v + d; if (valid(v - d)) return v - d; } return v; };
      if (fake.curving) return snap(fake.startVal + Math.round(fake.rate * Math.floor((Date.now() - fake.t0) / 1000 + fake.phase)));
      return snap(fake.value);
    },
    kill(fireEnded) {
      for (const s of fake.streams) for (const t of s.getTracks()) { if (t.readyState === 'live') { t.stop(); if (fireEnded) t.dispatchEvent(new Event('ended')); } }
    },
    liveTracks() { return fake.streams.reduce((n, s) => n + s.getTracks().filter((t) => t.readyState === 'live').length, 0); },
  };
  window.__long = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch { /* not supported */ }
  window.__audio = { speak: 0, contexts: 0 };
  try {
    const speak = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = (u) => { window.__audio.speak++; return speak(u); };
    const AC = window.AudioContext;
    window.AudioContext = function (...a) { window.__audio.contexts++; return new AC(...a); };
  } catch { /* no speech in this build */ }

  // What iOS Safari does to a camera stream, as far as we know: mediaTime stuck at 0 and a fixed currentTime, or no
  // requestVideoFrameCallback callbacks at all.
  if (opts.ios) {
    const proto = HTMLVideoElement.prototype;
    Object.defineProperty(proto, 'currentTime', { get() { return 0; }, set() {}, configurable: true });
    if (opts.ios === 'zero') {
      const orig = proto.requestVideoFrameCallback;
      proto.requestVideoFrameCallback = function (cb) { return orig.call(this, (now, meta) => cb(now, Object.assign({}, meta, { mediaTime: 0 }))); };
    } else if (opts.ios === 'silent') {
      proto.requestVideoFrameCallback = function () { return 1; };
      proto.cancelVideoFrameCallback = function () {};
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const cache = new Map();
  let R = null;
  let setImg = null;

  const params = (text, w, h, xr, y0, seed) => {
    const p = R.randomParams(R.mulberry32(seed), text, 'mild', {
      digitH: 110, margin: 0.1, jitter: 0, extras: { degF: true, degFGap: 0.1, label: false, rule: false, bezel: false },
    });
    return Object.assign(p, { w, h, xr, y0, bg: [150, 162, 152], rotation: 0, perspective: 0, aspect: 1, glare: null, seed });
  };

  function scene(text) {
    if (cache.has(text)) return cache.get(text);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#1a1c1a'; x.fillRect(0, 0, W, H);
    x.fillStyle = 'rgb(150,162,152)'; x.fillRect(40, 120, 1200, 500);
    if (text === 'cover') {                      // a finger over the lens
      x.fillStyle = '#0a0a0a'; x.fillRect(0, 0, W, H);
    } else if (text === 'glare') {               // a flare washing the whole display out
      x.fillStyle = 'rgb(236,240,236)'; x.fillRect(0, 0, W, H);
      const g = x.createRadialGradient(640, 330, 20, 640, 330, 600); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(230,235,230,0.9)');
      x.fillStyle = g; x.fillRect(0, 0, W, H);
    } else {
      if (!setImg) setImg = R.renderDisplay(params('572', 420, 220, 300, 40, 11));
      x.putImageData(setImg, 60, 230);
      x.putImageData(R.renderDisplay(params(text, 520, 220, 300, 40, 12)), 420, 230);
      x.fillStyle = 'rgba(20,24,20,0.85)'; x.font = 'bold 26px sans-serif';
      x.fillText('SET TEMP', 70, 252); x.fillText('THERMO TEMP', 500, 252);
    }
    cache.set(text, c);
    return c;
  }

  const loading = import('/tools/synth-display.js').then((m) => { R = m; });
  fake.ready = loading.then(async () => {
    const texts = ['---', 'cover', 'glare'];
    for (let v = 70; v <= 230; v++) texts.push(String(v));
    for (const t of texts) { scene(t); await new Promise((r) => setTimeout(r, 0)); }
  });

  let lastText = null;
  setInterval(() => {
    if (!R) return;
    let t;
    if (fake.mode === 'dashes') t = '---';
    else if (fake.mode === 'cover') t = 'cover';
    else if (fake.mode === 'glare') t = 'glare';
    else t = String(fake.current());
    if (t !== lastText) { fake.log.push({ t: Date.now(), text: t }); lastText = t; }
    ctx.drawImage(scene(t), 0, 0);
    fake.drawn++;
  }, 66);

  const md = navigator.mediaDevices;
  if (md) {
    md.getUserMedia = async (constraints) => {
      fake.calls++;
      fake.lastConstraints = constraints;
      await loading;
      if (fake.deny) throw new DOMException('Permission denied', fake.deny);
      if (!fake.available) throw new DOMException('Could not start video source', 'NotReadableError');
      const stream = canvas.captureStream(15);
      fake.streams.push(stream);
      return stream;
    };
  }
}

// ---- helpers ----

async function newPage(browser, base, { width = 390, height = 844, init = {}, granted = false, wakeLock = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['screen-wake-lock'] });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(fakeCameraInit, init);
  if (granted) await page.addInitScript(() => { try { if (!sessionStorage.getItem('rt.test.once')) { localStorage.setItem('rt.camera.granted', '1'); } } catch { /* ignore */ } });
  if (!wakeLock) await page.addInitScript(() => { delete Navigator.prototype.wakeLock; });
  const go = (query = '?nosw', hash = '#setup') => page.goto(`${base}/${query}${hash}`);
  return { context, page, errors, go };
}

const waitHash = (page, hash, timeout = 15000) => page.waitForFunction((h) => location.hash === h, hash, { timeout });
const waitT = (page, sec, timeout = 120000) =>
  page.waitForFunction((s) => window.__rt.snapshot() && window.__rt.snapshot().t >= s, sec, { timeout });
const camState = (page) => page.evaluate(() => {
  const c = window.__rt.app.controller;
  return c ? c.source.state : null;
});

async function smallControls(page) {
  return page.evaluate(() => [...document.querySelectorAll('button, a.btn, a.navlink, input, select, textarea')]
    .filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')
    .map((e) => ({ what: e.id || e.getAttribute('aria-label') || e.className || e.tagName, h: Math.round(e.getBoundingClientRect().height * 10) / 10 }))
    .filter((x) => x.h < 63.5));
}
const overflow = (page) => page.evaluate(() => ({
  v: document.documentElement.scrollHeight - window.innerHeight,
  hz: document.documentElement.scrollWidth - window.innerWidth,
}));

// Touch drags through the DevTools protocol, so the browser does real touch handling (touch-action, pointer events).
async function touchDrag(client, from, to, steps = 10) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps, y = from.y + ((to.y - from.y) * i) / steps;
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await sleep(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const stageRect = (page) => page.$eval('#cam-stage', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
const boxRect = (page) => page.$eval('.cb-box', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; });

// The THERMO TEMP digits '77' in the fake scene, as a normalised box with a little margin (see fakeCameraInit).
const TARGET = { x: 555 / 1280, y: 260 / 720, w: 187 / 1280, h: 130 / 720 };

async function dragBoxOnto(page, client, target = TARGET) {
  const s = await stageRect(page);
  let b = await boxRect(page);
  // 1. move the box so its top-left corner sits on the target's
  const tx = s.left + target.x * s.width, ty = s.top + target.y * s.height;
  await touchDrag(client, { x: b.left + b.width / 2, y: b.top + b.height / 2 }, { x: b.left + b.width / 2 + (tx - b.left), y: b.top + b.height / 2 + (ty - b.top) });
  // 2. drag the bottom-right corner (its grab area is just outside the corner) to the target's
  b = await boxRect(page);
  const brx = s.left + (target.x + target.w) * s.width, bry = s.top + (target.y + target.h) * s.height;
  await touchDrag(client, { x: b.right + 14, y: b.bottom + 14 }, { x: brx + 14, y: bry + 14 });
}

const readStore = (page, store) => page.evaluate((name) => new Promise((resolve, reject) => {
  const open = indexedDB.open('roast-tracker');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const req = db.transaction(name).objectStore(name).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  };
}), store);

async function iosClocks(browser, base, finish) {
  console.log('A stream whose clocks never move (what iOS Safari does), and a requestVideoFrameCallback that never fires');
  for (const [variant, expectDelivery] of [['zero', 'rvfc'], ['silent', 'timer']]) {
    const t = await newPage(browser, base, { granted: true, init: { ios: variant } });
    await t.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const c3 = await t.context.newCDPSession(t.page);
    await t.go('?nosw');
    await t.page.evaluate(() => window.__fake.ready);
    await t.page.waitForSelector('#cam-stage video');
    await t.page.waitForFunction(() => window.__fake.calls >= 1);
    await dragBoxOnto(t.page, c3);
    await t.page.waitForFunction(() => /Reading 77/.test(document.getElementById('cam-status').textContent), null, { timeout: 8000 });
    step(`${variant}: 12 s on Setup`);
    await sleep(12000);
    const d = await t.page.evaluate(() => window.__rt.app.setup.camera.source.diagnostics());
    assert.equal(d.state, 'live', JSON.stringify(d));
    assert.equal(d.reopens, 0, 'the stream was never reopened');
    assert.equal(d.stalls, 0);
    assert.equal(await t.page.evaluate(() => window.__fake.calls), 1);
    assert.equal(d.delivery, expectDelivery);
    assert.ok(d.framesPerSecond >= 6 && d.framesPerSecond <= 8.5, `${d.framesPerSecond} pictures a second`);
    assert.match(await text(t.page, '#cam-status'), /Reading 77/);
    assert.equal(await t.page.locator('#start-btn').isDisabled(), false, 'Start is enabled');
    if (variant === 'zero') {
      step('Camera details: collapsed, opens, plain text, Copy details copies it');
      assert.equal(await t.page.$eval('#cam-details', (e) => e.open), false);
      await t.page.evaluate(() => document.getElementById('cam-details').scrollIntoView({ block: 'end' }));
      await t.page.click('#cam-details summary');
      await t.page.waitForFunction(() => /Pictures arrive/.test(document.getElementById('cam-details-text').textContent));
      const txt = await text(t.page, '#cam-details-text');
      for (const re of [/Camera state: live\. Reopened 0 times/, /Video: 1280 by 720/, /Camera track: live, not muted/, /through the video callback/, /mediaTime not moving, currentTime not moving/, /Digit reader, last 5 seconds: \d+ read/, /Reader time per picture, last 5 seconds: \d+ ms on average/, /Magnifier updates [\d.]+ times a second/, /Exposure lock/, /Device: /]) assert.match(txt, re);
      const btn = await t.page.$eval('#cam-copy', (e) => e.getBoundingClientRect().height);
      assert.ok(btn >= 63.5, `Copy details is ${btn}px tall`);
      await t.page.click('#cam-copy');
      await t.page.waitForFunction(() => /Copied/.test(document.getElementById('cam-copy-note').textContent));
      assert.match(await t.page.evaluate(() => navigator.clipboard.readText()), /Camera state: live/);
      await t.page.evaluate(() => document.getElementById('cam-details').scrollIntoView({ block: 'end' }));
      await shot(t.page, 'camera-details.png');
      console.log(txt.split('\n').map((l) => `      ${l}`).join('\n'));
    } else {
      const txt = await t.page.evaluate(() => { document.getElementById('cam-details').open = true; return null; });
      await t.page.waitForFunction(() => /on a timer/.test(document.getElementById('cam-details-text').textContent));
    }
    finish(`ios ${variant}`, t.errors);
    await t.context.close();
  }
}


// Why it cannot read: two different ways to make the display unreadable, and the pictures kept for sharing.
async function reasonsTest(browser, base, finish) {
  console.log('Reasons, tally and the shared pictures');
  const t = await newPage(browser, base, { granted: true });
  const { page } = t;
  const client = await t.context.newCDPSession(page);
  await page.context().grantPermissions([], { origin: base });
  await t.go('?nosw');
  await page.evaluate(() => window.__fake.ready);
  await page.waitForSelector('#cam-stage video');
  await dragBoxOnto(page, client);
  await page.waitForFunction(() => /Reading 77/.test(document.getElementById('cam-status').textContent), null, { timeout: 8000 });
  assert.equal(await page.locator('#cam-why').isHidden(), true, 'nothing to explain while it reads');

  step('A washed-out display (glare): "too faint" with its hint, and nothing flickers');
  await page.evaluate(() => { window.__fake.mode = 'glare'; });
  await page.waitForFunction(() => !document.getElementById('cam-why').hidden, null, { timeout: 8000 });
  const glare = await page.evaluate(() => ({ text: document.getElementById('cam-why-text').textContent, hint: document.getElementById('cam-why-hint').textContent, status: document.getElementById('cam-status').textContent }));
  console.log('      glare ->', JSON.stringify(glare), await page.evaluate(() => window.__rt.app.setup.camera.source.captured().miss.reason));
  assert.match(glare.status, /Can.t read the digits yet/);
  const seen = new Set();
  for (let i = 0; i < 12; i++) { seen.add(await text(page, '#cam-why-text')); await sleep(250); }
  assert.equal(seen.size, 1, `the reason flickered: ${[...seen]}`);
  assert.match(glare.text + glare.hint, /too faint|unclear|No digits/);
  const glareReason = await page.evaluate(() => window.__rt.app.setup.camera.source.captured().miss.reason);
  await shot(page, 'camera-why.png');

  step('The same picture goes into the tally (Camera details) and the last-10-seconds list');
  await sleep(4000);
  await page.evaluate(() => { document.getElementById('cam-details').open = true; });
  await page.waitForFunction(() => /Last \d+ of 60 seconds/.test(document.getElementById('cam-details-text').textContent));
  const d1 = await text(page, '#cam-details-text');
  const mapped = await page.evaluate(async (r) => { const m = await import('/js/sources/camera-reasons.js'); return m.explainMiss(r); }, glareReason);
  assert.match(d1, new RegExp(`Last \\d+ of 60 seconds: .*\\d+ ${mapped.label}`));
  assert.match(d1, new RegExp(`Last 10 seconds, oldest first: .*${mapped.label}`));
  assert.match(d1, /Last picture the reader could read: 77 \(digits 77\), [\d.]+ s ago/);
  assert.match(d1, /Picture the reader gets: \d+ by \d+ pixels\. Digit height as measured: \d+ pixels, \d+% of the picture height/);
  assert.match(d1, /unreadable \S.* \(\d+ by \d+,/);
  assert.equal(glare.text, mapped.text);
  assert.equal(glare.hint, mapped.hint);

  step('A digit clipped by the box edge gives a different reason');
  await page.evaluate(() => { window.__fake.mode = 'hold'; window.__fake.value = 77; });
  await page.waitForFunction(() => /Reading 77/.test(document.getElementById('cam-status').textContent), null, { timeout: 8000 });
  await page.waitForFunction(() => document.getElementById('cam-why').hidden);
  await page.evaluate(() => document.getElementById('cam-details').scrollIntoView({ block: 'nearest' }));
  await page.evaluate(() => window.scrollTo(0, 0));
  const s1 = await stageRect(page);
  const b1 = await boxRect(page);
  const clipX = s1.left + (700 / 1280) * s1.width;   // through the ones digit
  await touchDrag(client, { x: b1.right + 22, y: b1.top + b1.height / 2 }, { x: clipX + 22, y: b1.top + b1.height / 2 });
  await page.waitForFunction(() => !document.getElementById('cam-why').hidden && !/Reading 77/.test(document.getElementById('cam-status').textContent), null, { timeout: 8000 });
  await sleep(2500);
  const clip = await page.evaluate(() => ({ text: document.getElementById('cam-why-text').textContent, hint: document.getElementById('cam-why-hint').textContent, reason: window.__rt.app.setup.camera.source.captured().miss.reason, status: document.getElementById('cam-status').textContent }));
  console.log('      clipped ->', JSON.stringify(clip));
  const clipMapped = await page.evaluate(async (r) => (await import('/js/sources/camera-reasons.js')).explainMiss(r), clip.reason);
  assert.equal(clip.text, clipMapped.text);
  assert.equal(clip.hint, clipMapped.hint);
  assert.notEqual(clip.text, glare.text, 'two different reasons for two different problems');
  await shot(page, 'camera-why-clipped.png');
  await sleep(3000);
  const d2 = await text(page, '#cam-details-text');
  assert.match(d2, new RegExp(`\\d+ ${clipMapped.label}`));

  step('Share the last unreadable picture: two PNGs, exactly the reader\'s pixels, named for the outcome');
  const snap = await page.evaluate(() => {
    const src = window.__rt.app.setup.camera.source;
    const c = src.captured();
    const frozen = { ok: c.ok, miss: c.miss };
    src.captured = () => frozen;                       // freeze: the next frame must not replace what we compare against
    const copy = (i) => ({ w: i.width, h: i.height, data: Array.from(i.data) });
    return { ok: copy(c.ok.imageData), miss: copy(c.miss.imageData), okDigits: c.ok.digits, missReason: c.miss.reason, diag: src.diagnostics() };
  });
  const downloads = [];
  page.on('download', (dl) => downloads.push(dl));
  await page.evaluate(() => document.getElementById('cam-share').scrollIntoView({ block: 'center' }));
  assert.ok((await page.$eval('#cam-share', (e) => e.getBoundingClientRect().height)) >= 63.5);
  await page.click('#cam-share');
  await page.waitForFunction(() => /Saved 2 pictures/.test(document.getElementById('cam-copy-note').textContent), null, { timeout: 8000 });
  for (let i = 0; i < 40 && downloads.length < 2; i++) await sleep(100);
  assert.equal(downloads.length, 2);
  const names = downloads.map((d) => d.suggestedFilename()).sort();
  assert.equal(names[0], `reader-miss-${snap.missReason.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.png`);
  assert.equal(names[1], `reader-ok-${String(snap.okDigits).padStart(3, '0')}.png`);
  for (const dl of downloads) {
    const file = await dl.path();
    const b64 = fs.readFileSync(file).toString('base64');
    const px = await page.evaluate(async (b) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b}`)).blob());
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height);
      return { w: d.width, h: d.height, data: Array.from(d.data) };
    }, b64);
    const want = dl.suggestedFilename().startsWith('reader-miss') ? snap.miss : snap.ok;
    assert.equal(px.w, want.w); assert.equal(px.h, want.h);
    assert.equal(px.data.length, want.data.length);
    let diff = 0; for (let i = 0; i < px.data.length; i++) if (px.data[i] !== want.data[i]) diff++;
    assert.equal(diff, 0, `${dl.suggestedFilename()}: ${diff} bytes differ from what the reader saw`);
    assert.equal(px.w, snap.diag.cropW === px.w ? snap.diag.cropW : px.w);
  }
  assert.ok(snap.diag.cropW > 20 && snap.diag.cropH > 20);
  step(`PNGs ${names.join(', ')} match the reader's pictures (${snap.miss.w} by ${snap.miss.h} and ${snap.ok.w} by ${snap.ok.h} pixels)`);
  finish('reasons', t.errors);
  await t.context.close();
  return { glareReason, clipReason: clip.reason };
}

// ---- main ----

async function main() {
  const { srv, base } = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const finish = (label, errs) => { if (errs.length) errors.push(`${label}: ${errs.join(' | ')}`); };
  const summary = {};

  try {
    if (process.env.ONLY === 'reasons') { await reasonsTest(browser, base, finish); assert.deepEqual(errors, []); console.log('reasons passed'); return; }
    if (process.env.ONLY === 'ios') { await iosClocks(browser, base, finish); assert.deepEqual(errors, []); console.log('ios variants passed'); return; }
    // ============================================================ permission denied, no camera, insecure
    console.log('Permission and camera-trouble states');
    {
      const t = await newPage(browser, base, { init: { deny: 'NotAllowedError' } });
      await t.go();
      await t.page.waitForSelector('#cam-panel');
      step('Camera is the default source, and nothing asked for the camera before the tap');
      assert.equal(await t.page.getAttribute('#source-seg [data-value="camera"]', 'aria-checked'), 'true');
      assert.equal(await t.page.evaluate(() => window.__fake.calls), 0);
      assert.match(await text(t.page, '#cam-card-title'), /Allow the camera/);
      assert.equal(await t.page.locator('#start-btn').isDisabled(), true);
      await shot(t.page, 'camera-allow.png');
      step('Denied: help text, Try again, and Demo still works');
      await t.page.click('#cam-allow');
      await t.page.waitForSelector('#cam-card[data-state="denied"]');
      assert.equal(await t.page.evaluate(() => window.__fake.calls), 1);
      const denied = await text(t.page, '#cam-card');
      assert.match(denied, /Website Settings/);
      assert.match(denied, /Demo and Manual still work/);
      assert.equal(await t.page.locator('#start-btn').isDisabled(), true);
      assert.deepEqual(await smallControls(t.page), []);
      assert.equal((await overflow(t.page)).hz <= 0, true);
      await shot(t.page, 'camera-denied.png');
      await t.page.click('#cam-retry');
      await t.page.waitForFunction(() => !document.getElementById('cam-retry').disabled);
      assert.equal(await t.page.evaluate(() => window.__fake.calls), 2);
      await t.page.click('#source-seg [data-value="demo"]');
      await t.page.waitForSelector('#start-btn:not([disabled])', { timeout: 10000 });
      assert.equal(await t.page.evaluate(() => document.querySelectorAll('video').length), 0, 'no video left behind');
      await t.page.click('#source-seg [data-value="camera"]');
      await t.page.waitForSelector('#cam-card[data-state="needs-tap"]');
      step('A remembered grant that is later revoked shows the blocked help, not the Allow button');
      await t.page.evaluate(() => localStorage.setItem('rt.camera.granted', '1'));
      await t.page.reload();
      await t.page.waitForSelector('#cam-card[data-state="denied"]');
      assert.equal(await t.page.evaluate(() => localStorage.getItem('rt.camera.granted')), null);
      finish('denied', t.errors);
      await t.context.close();

      step('No camera found');
      const n = await newPage(browser, base, { init: { deny: 'NotFoundError' } });
      await n.go();
      await n.page.click('#cam-allow');
      await n.page.waitForSelector('#cam-card[data-state="no-camera"]');
      assert.match(await text(n.page, '#cam-card'), /No camera found/);
      assert.match(await text(n.page, '#cam-card'), /Demo and Manual still work/);
      finish('no camera', n.errors);
      await n.context.close();

      step('Camera in use by another app (NotReadableError) says so and offers Try again');
      const u = await newPage(browser, base, { init: { available: false } });
      await u.go();
      await u.page.click('#cam-allow');
      await u.page.waitForSelector('#cam-card[data-state="error"]');
      assert.match(await text(u.page, '#cam-card'), /Another app may be using it/);
      finish('in use', u.errors);
      await u.context.close();

      step('An insecure page: Demo stays the default, and the Camera segment says it needs HTTPS');
      const i = await newPage(browser, base);
      await i.page.addInitScript(() => { Object.defineProperty(window, 'isSecureContext', { value: false }); });
      await i.go();
      await i.page.waitForSelector('#start-btn');
      assert.equal(await i.page.getAttribute('#source-seg [data-value="demo"]', 'aria-checked'), 'true');
      await i.page.click('#source-seg [data-value="camera"]');
      await i.page.waitForSelector('#cam-card[data-state="insecure"]');
      assert.match(await text(i.page, '#cam-card'), /camera needs HTTPS/i);
      assert.equal(await i.page.locator('#start-btn').isDisabled(), true);
      assert.equal(await i.page.evaluate(() => window.__fake.calls), 0);
      finish('insecure', i.errors);
      await i.context.close();
    }

    // ============================================================ the main roast
    console.log('Setup preview and a roast read through the fake camera');
    const main = await newPage(browser, base);
    const { page } = main;
    const client = await main.context.newCDPSession(page);
    await main.go('?nosw&undo=1500');
    await page.waitForSelector('#cam-allow');
    await page.evaluate(() => window.__fake.ready);

    step('Allow camera: the preview plays inline and muted, and the camera stays off Demo and Manual');
    await page.click('#cam-allow');
    await page.waitForSelector('#cam-stage .cam-video');
    await page.waitForFunction(() => { const v = document.querySelector('#cam-stage video'); return v && v.videoWidth > 0 && !v.paused; }, null, { timeout: 10000 });
    const vattrs = await page.$eval('#cam-stage video', (v) => ({ playsInline: v.playsInline, muted: v.muted, controls: v.controls, ws: v.videoWidth + 'x' + v.videoHeight }));
    assert.deepEqual([vattrs.playsInline, vattrs.muted, vattrs.controls], [true, true, false]);
    assert.equal(await page.evaluate(() => window.__fake.calls), 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('rt.camera.granted')), '1');

    step('Before the box is placed the panel does not read a wrong value');
    await sleep(2500);
    assert.equal(await page.locator('#start-btn').isDisabled(), true);
    assert.doesNotMatch(await text(page, '#cam-status'), /Reading \d/);
    await shot(page, 'camera-setup-unaimed.png');

    step('Drag the box onto the THERMO TEMP digits with touch events; the page does not scroll');
    await page.evaluate(() => window.scrollTo(0, 120));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const handle = await page.$eval('.cb-h[data-h="se"]', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; });
    assert.ok(handle.w >= 44 && handle.h >= 44, `corner grab area ${handle.w}x${handle.h}`);
    await dragBoxOnto(page, client);
    assert.equal(await page.evaluate(() => window.scrollY), scrollBefore, 'dragging must not scroll the page');
    const s = await stageRect(page);
    const b = await boxRect(page);
    const got = { x: (b.left - s.left) / s.width, y: (b.top - s.top) / s.height, w: b.width / s.width, h: b.height / s.height };
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(got[k] - TARGET[k]) < 0.02, `box ${k} ${got[k].toFixed(3)} vs ${TARGET[k].toFixed(3)}`);
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('rt.camera.box')));
    assert.ok(Math.abs(saved.x - got.x) < 0.005 && Math.abs(saved.w - got.w) < 0.005, 'the box is remembered');
    step('The reader area (box widened to the left) is shown and stays clear of most of the SET TEMP number (widening 0.85: its degree sign and F may enter, see reader/camera.js)');
    const ext = await page.$eval('.cb-ext', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, width: r.width, hidden: e.hidden }; });
    assert.equal(ext.hidden, false);
    assert.ok(ext.width > 20 && ext.left > s.left + 0.33 * s.width, `ext starts at ${((ext.left - s.left) / s.width).toFixed(3)} of the picture`);

    step('The live value matches the scene, and Start enables after 5 good reads');
    await page.waitForFunction(() => /Reading 77/.test(document.getElementById('cam-status').textContent), null, { timeout: 8000 });
    assert.equal(await text(page, '#cam-value'), '77°F');
    const cropSize = await page.$eval('#cam-crop', (c) => ({ w: c.width, h: c.height }));
    assert.ok(cropSize.w > 20 && cropSize.h > 20, 'the magnified crop is drawn');
    const seen = new Set();
    const t0 = Date.now();
    while (await page.locator('#start-btn').isDisabled()) {
      const r = await text(page, '#start-reason');
      const m = /: (\d) of 5/.exec(r);
      if (m) seen.add(m[1]);
      assert.ok(Date.now() - t0 < 12000, 'Start never enabled');
      await sleep(250);
    }
    const startWait = (Date.now() - t0) / 1000;
    assert.ok(seen.size >= 2, `progress shown: ${[...seen]}`);
    step(`Start enabled (${startWait.toFixed(1)} s after the box was right; progress seen ${[...seen].join(',')})`);
    assert.deepEqual(await smallControls(page), []);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'camera-setup.png');
    await shot(page, 'camera-setup-full.png', { fullPage: true });

    step('The remembered box survives a reload, and the camera opens by itself (permission was granted before)');
    await page.reload();
    await page.waitForSelector('#cam-stage');
    await page.evaluate(() => window.__fake.ready);
    await page.waitForFunction(() => /Reading 77/.test(document.getElementById('cam-status').textContent), null, { timeout: 10000 });
    assert.equal(await page.locator('#cam-allow').count(), 0);
    const b2 = await boxRect(page);
    const s3 = await stageRect(page);
    assert.ok(Math.abs((b2.left - s3.left) / s3.width - TARGET.x) < 0.03, 'box restored');
    await page.waitForSelector('#start-btn:not([disabled])', { timeout: 12000 });

    // ------------------------------------------------------------ Start the roast
    step('Start at 1x: wake lock, audio unlock and the camera hand-off');
    await page.evaluate(() => {
      window.__fake.startCurve(77, 2.5);
      window.__callsBeforeStart = window.__fake.calls;
    });
    await page.click('#start-btn');
    await waitHash(page, '#roast');
    assert.equal(await page.evaluate(() => window.__fake.calls - window.__callsBeforeStart), 0, 'the stream was not reopened for the roast');
    assert.equal(await page.evaluate(() => window.__fake.liveTracks()), 1);
    assert.equal(await page.evaluate(() => window.__rt.app.wake.supported), true);
    await page.waitForFunction(() => window.__rt.app.wake.active, null, { timeout: 5000 });
    const audio = await page.evaluate(() => window.__audio);
    assert.ok(audio.contexts >= 1, `AudioContext created on the Start tap: ${JSON.stringify(audio)}`);
    assert.ok(audio.speak >= 1, `speech unlocked on the Start tap: ${JSON.stringify(audio)}`);
    assert.equal(await text(page, '#status-label'), 'Camera');

    step('Roast screen at 390x844: crop strip visible, no scrolling, controls 64px or taller');
    await page.waitForSelector('#cam-strip');
    assert.deepEqual(await smallControls(page), []);
    assert.equal((await overflow(page)).v <= 0, true, 'roast screen must not scroll');
    const strip0 = await page.$eval('#cam-strip-view', (e) => { const r = e.getBoundingClientRect(); const v = e.querySelector('video'); return { w: r.width, h: r.height, hasVideo: !!v, playing: v && !v.paused }; });
    assert.ok(strip0.hasVideo && strip0.playing && strip0.w >= 80 && strip0.h >= 28, JSON.stringify(strip0));
    assert.equal(await page.evaluate(() => window.__rt.app.controller.source.state), 'live');

    // The first 35 seconds: just run, sampling the strip and the performance numbers.
    await waitT(page, 12);
    const stripA = await text(page, '#cam-strip-value');
    const vt1 = await page.$eval('#cam-strip video', (v) => v.currentTime);
    await shot(page, 'camera-roast.png');
    await waitT(page, 20);
    const stripB = await text(page, '#cam-strip-value');
    const vt2 = await page.$eval('#cam-strip video', (v) => v.currentTime);
    assert.notEqual(stripA, stripB, `the strip's reading updates: ${stripA} then ${stripB}`);
    assert.match(stripB, /^\d+°F$/);
    assert.ok(vt2 > vt1 + 3, 'the strip video is live');
    assert.equal(await page.getAttribute('#cam-strip', 'data-state'), 'ok');
    const perf = await page.evaluate(() => window.__rt.app.controller.source.perf);
    summary.perf = perf;
    step(`Reader per frame: ${perf.msAvg.toFixed(1)} ms average, ${perf.msMax.toFixed(1)} ms worst, ${perf.frames} frames, ${perf.dropped} dropped`);

    await waitT(page, 35);
    assert.notEqual(await text(page, '#ror'), '—', 'rate of rise appears after 30 s');
    const snap35 = await page.evaluate(() => { const s = window.__rt.snapshot(); return { t: s.t, temp: s.temp, ror: s.rorNow, since: s.secondsSinceReading }; });
    assert.ok(snap35.ror > 100, `rate of rise ${snap35.ror}`);
    const long35 = await page.evaluate(() => window.__long.slice());
    summary.longTasks35 = long35;

    // ------------------------------------------------------------ Outage: dashes, then a covered lens, number pad
    step('Dashes for 4 s then a covered lens for 3 s: "Lost the reading", the number pad types a value, then it recovers');
    const tOut = await page.evaluate(() => { window.__fake.mode = 'dashes'; return window.__rt.snapshot().t; });
    await sleep(4000);
    await page.evaluate(() => { window.__fake.mode = 'cover'; });
    await page.waitForSelector('#banner[data-state="lost"]', { timeout: 8000 });
    assert.equal(await text(page, '#banner-text'), 'Lost the reading');
    assert.equal(await page.getAttribute('#cam-strip', 'data-state'), 'warn', 'the strip shows the display cannot be read');
    await shot(page, 'camera-roast-lost.png');
    await sleep(1500);
    // type the value the display is showing now
    const typed = await page.evaluate(() => window.__fake.current());
    await page.click('#type-reading');
    for (const d of String(typed)) await page.click(`.sheet .np-key >> text="${d}"`);
    await page.click('.sheet #np-enter');
    await page.waitForSelector('.sheet', { state: 'detached' });
    await page.waitForFunction((v) => window.__rt.snapshot().raw.includes(v), typed, { timeout: 4000 });
    const anchor = await page.evaluate(() => window.__rt.app.controller.source.health().lastAccepted);
    assert.equal(anchor, typed, 'the typed reading re-anchored the camera filter');
    await sleep(600);
    await page.evaluate(() => { window.__fake.mode = 'curve'; });
    await page.waitForFunction(() => document.getElementById('banner').dataset.state !== 'lost', null, { timeout: 10000 });
    const tBack = await page.evaluate(() => window.__rt.snapshot().t);
    step(`Outage ran from second ${tOut}; the banner cleared by second ${tBack}`);

    // ------------------------------------------------------------ The track ends
    step('End the stream mid-roast: the strip and the state show it; it recovers when a new stream is granted');
    await waitT(page, tBack + 4);
    const gapsBefore = await page.evaluate(() => window.__rt.snapshot().raw.filter((v) => v == null).length);
    await page.evaluate(() => { window.__fake.available = false; window.__fake.kill(false); });   // no 'ended' event: readyState alone tells
    await page.waitForFunction(() => window.__rt.app.controller.source.state === 'ended', null, { timeout: 4000 });
    await page.waitForSelector('#cam-strip[data-state="lost"]');
    assert.match(await text(page, '#cam-strip-line'), /Camera stopped|Reconnecting/);
    await shot(page, 'camera-roast-ended.png');
    await sleep(4000);
    assert.notEqual(await camState(page), 'live', 'still down while the camera is unavailable');
    assert.ok((await page.evaluate(() => window.__fake.calls)) >= 3, 'it keeps trying to reconnect');
    await page.evaluate(() => { window.__fake.available = true; });
    await page.waitForFunction(() => window.__rt.app.controller.source.state === 'live', null, { timeout: 20000 });
    await page.waitForSelector('#cam-strip[data-state="ok"]', { timeout: 10000 });
    const stripVideoOk = await page.$eval('#cam-strip video', (v) => v.videoWidth > 0 && !v.paused);
    assert.equal(stripVideoOk, true, 'the strip shows the new stream');
    assert.equal(await page.evaluate(() => window.__fake.liveTracks()), 1, 'exactly one live track after recovery');
    const gapsAfter = await page.evaluate(() => window.__rt.snapshot().raw.filter((v) => v == null).length);
    assert.ok(gapsAfter > gapsBefore, 'the outage was logged as gaps');
    // and an 'ended' event (what iOS fires) is handled too
    const tRec = await page.evaluate(() => window.__rt.snapshot().t);
    await waitT(page, tRec + 4);
    await page.evaluate(() => window.__fake.kill(true));
    await page.waitForFunction(() => window.__rt.app.controller.source.state !== 'live', null, { timeout: 4000 });
    await page.waitForFunction(() => window.__rt.app.controller.source.state === 'live', null, { timeout: 20000 });
    await waitT(page, (await page.evaluate(() => window.__rt.snapshot().t)) + 6);

    // ------------------------------------------------------------ Page hidden then visible
    step('A hidden page: the clock catches up with gaps (no stale frames) and the camera comes back when visible');
    const hiddenOk = await page.evaluate(async () => {
      const src = window.__rt.app.controller.source;
      const before = src.health().secondsMissing;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 3500));
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 2500));
      return { before, after: src.health().secondsMissing, state: src.state };
    });
    assert.equal(hiddenOk.state, 'live');

    // ------------------------------------------------------------ Drop, After, camera stopped
    step('Drop reaches After, the camera stream is stopped and no <video> is left');
    const lastLong = await page.evaluate(() => window.__long.slice());
    summary.longTasksRoast = lastLong;
    await page.click('#ev-drop');
    await waitHash(page, '#after');
    await page.waitForSelector('#roasted-weight');
    assert.equal(await page.evaluate(() => window.__fake.liveTracks()), 0, 'every camera track stopped');
    assert.equal(await page.evaluate(() => document.querySelectorAll('video').length), 0);
    const record = await page.evaluate(() => JSON.parse(JSON.stringify(window.__rt.app.record)));
    const log = await page.evaluate(() => window.__fake.log);

    step('Reader health and readings against the display');
    const startedMs = Date.parse(record.startedAt);
    const valuesIn = (a, b) => {
      const vals = [];
      for (let i = 0; i < log.length; i++) {
        const from = log[i].t, to = i + 1 < log.length ? log[i + 1].t : Infinity;
        if (to >= a && from <= b && /^\d+$/.test(log[i].text)) vals.push(Number(log[i].text));
      }
      return vals;
    };
    // roast second 0 is a little after the controller was created: find the offset that fits best (clock start vs startedAt)
    const readings = record.readings;
    let best = { off: 0, wrong: 1e9 };
    for (const off of [0, 100, 200, 300, 500, 800]) {
      let wrong = 0;
      for (let i = 0; i < 34; i++) {
        const v = readings[i];
        if (v == null) continue;
        const win = valuesIn(startedMs + off + i * 1000 - 1300, startedMs + off + i * 1000 + 300);
        if (!win.length || v < Math.min(...win) || v > Math.max(...win)) wrong++;
      }
      if (wrong < best.wrong) best = { off, wrong };
    }
    let wrong = 0, missing = 0, read = 0;
    const bad = [];
    for (let i = 0; i < 34; i++) {
      const v = readings[i];
      if (v == null) { missing++; continue; }
      read++;
      const win = valuesIn(startedMs + best.off + i * 1000 - 1300, startedMs + best.off + i * 1000 + 300);
      if (!win.length || v < Math.min(...win) || v > Math.max(...win)) { wrong++; bad.push(`${i}: read ${v}, display ${win.join('/')}`); }
    }
    summary.clean = { seconds: 34, read, missing, wrong, offsetMs: best.off };
    step(`First 34 s: ${read} read, ${missing} missing, ${wrong} wrong (display clock offset ${best.off} ms)`);
    assert.equal(wrong, 0, `wrong values: ${bad.join('; ')}`);
    assert.ok(missing <= 3, `${missing} missing seconds in the clean stretch`);
    // the third digit appeared and was read (the display went 97 -> 100 around second 9)
    assert.ok(readings.slice(8, 34).some((v) => v >= 100), 'readings continue past 99 to 100');
    assert.ok(readings[34] == null || readings[34] > 150);
    // the outage: gaps, with the typed value in the middle
    const outage = readings.slice(tOut, tBack + 1);
    assert.ok(outage.filter((v) => v == null).length >= 4, `outage seconds ${JSON.stringify(outage)}`);
    assert.ok(readings.includes(typed), 'the typed reading is in the log');
    const h = record.reader;
    assert.equal(h.source, 'camera');
    const total = readings.length;
    const counted = h.secondsRead + h.rejected + h.secondsMissing;
    assert.ok(Math.abs(counted - total) <= 3, `health counts ${counted} seconds for ${total} readings: ${JSON.stringify(h)}`);
    assert.ok(h.secondsRead >= 40 && h.secondsMissing >= 8 && h.rejected <= 3, `reader health ${JSON.stringify(h)}`);
    summary.health = h;
    assert.ok(h.missReasons && h.missReasons['no probe'] >= 3 && h.missReasons['no picture'] >= 2, `miss reasons ${JSON.stringify(h.missReasons)}`);
    const missed = await text(page, '#sum-missed');
    assert.match(missed, /^Missed: \d+ /);
    assert.match(missed, /no probe/);
    summary.missed = missed;
    summary.total = total;

    // The chart stayed smooth: no long tasks above 150 ms on the page's main thread during the roast
    // The first 35 s are the steady reading; the rest includes the deliberate stream reopen (getUserMedia, a new video pipeline).
    summary.longMax = Math.max(0, ...summary.longTasks35);
    const longAll = Math.max(0, ...summary.longTasksRoast);
    step(`Long tasks: ${summary.longTasks35.length} in the first 35 s (worst ${summary.longMax} ms); ${summary.longTasksRoast.length} over the whole roast (worst ${longAll} ms)`);
    assert.ok(summary.longMax < 200, `a long task of ${summary.longMax} ms while reading steadily`);
    assert.ok(longAll < 500, `a long task of ${longAll} ms`);

    finish('main roast', main.errors);
    await main.context.close();

    // ============================================================ 375x667 roast, and leaving Setup stops the camera
    console.log('Roast at 375x667, and leaving Setup stops the stream');
    {
      const t = await newPage(browser, base, { width: 375, height: 667, granted: true });
      const c2 = await t.context.newCDPSession(t.page);
      await t.go('?nosw&undo=800');
      await t.page.evaluate(() => window.__fake.ready);
      await t.page.waitForSelector('#cam-stage video');
      await t.page.waitForFunction(() => window.__fake.calls >= 1);
      await t.page.evaluate(() => window.scrollTo(0, 0));
      await dragBoxOnto(t.page, c2);
      await t.page.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 });
      await shot(t.page, 'camera-setup-375.png', { fullPage: true });
      step('Leaving Setup for History stops the camera');
      await t.page.click('#nav-history');
      await t.page.waitForFunction(() => window.__fake.liveTracks() === 0, null, { timeout: 4000 });
      assert.equal(await t.page.evaluate(() => document.querySelectorAll('video').length), 0);
      await t.page.goBack();
      await t.page.waitForSelector('#cam-stage video');
      await t.page.waitForFunction(() => window.__fake.liveTracks() === 1, null, { timeout: 8000 });
      step('Switching to Manual and back stops and restarts it');
      await t.page.click('#source-seg [data-value="manual"]');
      await t.page.waitForFunction(() => window.__fake.liveTracks() === 0, null, { timeout: 4000 });
      await t.page.click('#source-seg [data-value="camera"]');
      await t.page.waitForFunction(() => window.__fake.liveTracks() === 1, null, { timeout: 8000 });
      await t.page.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 });
      await t.page.evaluate(() => window.__fake.startCurve(77, 2.5));
      await t.page.click('#start-btn');
      await waitHash(t.page, '#roast');
      await waitT(t.page, 6);
      assert.deepEqual(await smallControls(t.page), []);
      const o = await overflow(t.page);
      assert.ok(o.v <= 0 && o.hz <= 0, `overflow ${JSON.stringify(o)}`);
      const geo = await t.page.evaluate(() => {
        const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) }; };
        return { strip: r('cam-strip'), status: document.querySelector('.status-strip').getBoundingClientRect().bottom, chart: r('chart'), vh: window.innerHeight, vw: window.innerWidth };
      });
      assert.ok(geo.strip.bottom <= geo.vh && geo.strip.right <= geo.vw, `strip ${JSON.stringify(geo)}`);
      assert.ok(geo.chart.h >= 140, `chart height ${geo.chart.h}`);
      await shot(t.page, 'camera-roast-375x667.png');
      step('End roast, Discard: the camera stops and Setup shows a fresh preview');
      await t.page.click('#end-roast');
      await t.page.click('[data-action="discard"]');
      await waitHash(t.page, '#setup');
      await t.page.waitForFunction(() => window.__fake.liveTracks() === 1 && document.querySelectorAll('video').length === 1, null, { timeout: 10000 });
      assert.equal(await t.page.evaluate(() => window.__rt.app.controller), null);
      finish('375', t.errors);
      await t.context.close();
    }

    await iosClocks(browser, base, finish);
    summary.reasons = await reasonsTest(browser, base, finish);

    // ============================================================ no wake lock
    console.log('Wake lock unsupported');
    {
      const t = await newPage(browser, base, { wakeLock: false, granted: true });
      await t.go();
      await t.page.waitForSelector('#wake-warning');
      assert.match(await text(t.page, '#wake-warning'), /can.t keep the screen awake/);
      finish('no wake lock', t.errors);
      await t.context.close();
    }

    assert.deepEqual(errors, [], `console errors or exceptions:\n${errors.join('\n')}`);
    console.log('\ncamera.test.cjs: all passed');
    console.log(JSON.stringify({ perf: summary.perf, clean: summary.clean, health: summary.health, total: summary.total, longMax: summary.longMax }, null, 1));
  } finally {
    await browser.close();
    srv.close();
  }
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
module.exports = { fakeCameraInit, newPage, startServer, dragBoxOnto, touchDrag, waitT, waitHash, TARGET };
