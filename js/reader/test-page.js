// reader-test.html: milestone 1 test page for the digit reader (photos, recorded video, live camera + soak test).
import { readDisplay } from './sevenseg.js';
import { createReadingFilter } from './filter.js';
import { createConfirmer } from './confirm.js';
import { createCamera, createFrameLoop, grabCropFrom, expandBoxForDigits, clampBox, DIGIT_EXTENSION } from './camera.js';

const $ = id => document.getElementById(id);
const FPS = 7.5; // as the app: a reflected segment is confirmed from two pictures 133 ms apart (confirm.js)
const DEFAULT_BOX = { x: 0.08, y: 0.08, w: 0.25, h: 0.1 };

// ---------- small helpers ----------

function msg(text, kind) {
  const el = $('msg');
  if (!text) { el.hidden = true; return; }
  el.textContent = text; el.className = 'msg' + (kind === 'error' ? ' error' : ''); el.hidden = false;
}
function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ } }
function load(key, dflt) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const normExpected = t => { t = (t || '').trim().toLowerCase(); if (!t) return null; if (/^-+$/.test(t) || t === 'dashes' || t === 'none') return '---'; const n = parseInt(t, 10); return Number.isFinite(n) ? String(n) : null; };

// ---------- box editor (touch and mouse) ----------

class BoxStage {
  constructor(root, onChange) {
    this.root = root; this.onChange = onChange;
    this.media = root.querySelector('canvas, video');
    this.box = clampBox(load('rt.reader.box', DEFAULT_BOX));
    this.sw = 4; this.sh = 3;
    this.view = null; // zoom window { x, y, s } in normalised source units (square in those units), or null for the whole frame
    this.boxEl = el('div', 'box'); this.extEl = el('div', 'ext'); this.extEl.innerHTML = '<span>room for 3rd digit</span>';
    this.handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => { const d = el('div', 'handle'); d.dataset.h = h; return d; });
    root.append(this.extEl, this.boxEl, ...this.handles);
    this.drag = null;
    root.addEventListener('pointerdown', e => this.down(e));
    root.addEventListener('pointermove', e => this.move(e));
    root.addEventListener('pointerup', e => this.up(e));
    root.addEventListener('pointercancel', e => this.up(e));
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.render()).observe(root);
    this.render();
  }
  setSourceSize(w, h) { this.sw = w; this.sh = h; this.root.style.aspectRatio = `${w} / ${h}`; this.render(); }
  setBox(b, silent) { this.box = clampBox(b); this.render(); if (!silent) this.onChange(this.box); }
  toggleZoom() {
    if (this.view) { this.view = null; } else {
      const b = this.box, ext = DIGIT_EXTENSION * b.h * this.sh / this.sw;
      const s = Math.min(1, Math.max(0.1, 1.7 * (b.w + ext), 3 * b.h));
      const cx = b.x - ext / 2 + b.w / 2, cy = b.y + b.h / 2;
      this.view = { x: Math.min(1 - s, Math.max(0, cx - s / 2)), y: Math.min(1 - s, Math.max(0, cy - s / 2)), s };
    }
    this.render();
    return !!this.view;
  }
  render() {
    const b = this.box, v = this.view || { x: 0, y: 0, s: 1 };
    const px = x => ((x - v.x) / v.s * 100).toFixed(3) + '%', py = y => ((y - v.y) / v.s * 100).toFixed(3) + '%';
    const pw = w => (w / v.s * 100).toFixed(3) + '%';
    if (this.media) Object.assign(this.media.style, { position: 'absolute', width: pw(1), height: pw(1), left: px(0), top: py(0) });
    Object.assign(this.boxEl.style, { left: px(b.x), top: py(b.y), width: pw(b.w), height: pw(b.h) });
    const rb = expandBoxForDigits(b, this.sw, this.sh);
    Object.assign(this.extEl.style, { left: px(rb.x), top: py(b.y), width: pw(b.x - rb.x), height: pw(b.h) });
    const pos = { nw: [b.x, b.y], n: [b.x + b.w / 2, b.y], ne: [b.x + b.w, b.y], e: [b.x + b.w, b.y + b.h / 2], se: [b.x + b.w, b.y + b.h], s: [b.x + b.w / 2, b.y + b.h], sw: [b.x, b.y + b.h], w: [b.x, b.y + b.h / 2] };
    // on a small box the handles would cover it: keep the corners (all four when the box is big enough to grab, one otherwise)
    const r = this.root.getBoundingClientRect(), bwPx = b.w / v.s * r.width, bhPx = b.h / v.s * r.height, small = Math.min(bwPx, bhPx);
    for (const h of this.handles) {
      const p = pos[h.dataset.h], name = h.dataset.h;
      h.style.left = px(p[0]); h.style.top = py(p[1]);
      h.hidden = (small < 90 && name.length === 1) || (small < 44 && name !== 'se') || (r.width === 0);
    }
  }
  pt(e) {
    const r = this.root.getBoundingClientRect(), v = this.view || { x: 0, y: 0, s: 1 };
    return { x: v.x + (e.clientX - r.left) / r.width * v.s, y: v.y + (e.clientY - r.top) / r.height * v.s };
  }
  down(e) {
    if (e.button !== undefined && e.button > 0) return;
    const p = this.pt(e), t = e.target;
    this.root.setPointerCapture(e.pointerId);
    if (t.classList.contains('handle')) this.drag = { mode: 'resize', h: t.dataset.h, start: p, box: { ...this.box } };
    else if (t === this.boxEl) this.drag = { mode: 'move', start: p, box: { ...this.box } };
    else this.drag = { mode: 'draw', start: p, box: { ...this.box } };
    e.preventDefault();
  }
  move(e) {
    const d = this.drag; if (!d) return;
    const p = this.pt(e), dx = p.x - d.start.x, dy = p.y - d.start.y, min = 0.015;
    let b = { ...d.box };
    if (d.mode === 'move') { b.x += dx; b.y += dy; }
    else if (d.mode === 'draw') {
      b = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
      if (b.w < min || b.h < min) return;
    } else {
      let x0 = d.box.x, y0 = d.box.y, x1 = d.box.x + d.box.w, y1 = d.box.y + d.box.h;
      if (d.h.includes('w')) x0 = Math.min(x1 - min, Math.max(0, x0 + dx));
      if (d.h.includes('e')) x1 = Math.max(x0 + min, Math.min(1, x1 + dx));
      if (d.h.includes('n')) y0 = Math.min(y1 - min, Math.max(0, y0 + dy));
      if (d.h.includes('s')) y1 = Math.max(y0 + min, Math.min(1, y1 + dy));
      b = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    this.setBox(b);
  }
  up() { if (this.drag) { store('rt.reader.box', this.box); this.drag = null; } }
}
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

// ---------- reading + drawing ----------

// The reader can start its search from where the digits were last found (hint), which is several times faster. The hint is only a
// starting point; drop it after a run of misses so a changed box or lighting is searched afresh.
function nextHint(tracker, res) {
  if (res.debug.hintOut) { tracker.hint = res.debug.hintOut; tracker.misses = 0; }
  else if (++tracker.misses >= 8) tracker.hint = null;
  return tracker.hint;
}

function readBox(source, sw, sh, box, work, hint) {
  const rb = expandBoxForDigits(box, sw, sh);
  const { imageData } = grabCropFrom(source, sw, sh, rb, work);
  const res = readDisplay(imageData, { hint });
  return { imageData, res, rb };
}

function showResult(prefix, res) {
  const v = $(prefix + '-value'), chip = $(prefix + '-status'), conf = $(prefix + '-conf'), reason = $(prefix + '-reason');
  if (res.status === 'ok') { v.textContent = res.value; v.classList.remove('dim'); }
  else if (res.status === 'dashes') { v.textContent = '---'; v.classList.remove('dim'); }
  else { v.textContent = '–'; v.classList.add('dim'); }
  chip.textContent = res.status === 'ok' ? 'read' : res.status === 'dashes' ? 'dashes: no probe' : 'no reading';
  chip.className = 'chip ' + res.status;
  if (conf) conf.textContent = res.status === 'none' ? '' : `confidence ${Math.round(res.confidence * 100)}%`;
  if (reason) {
    const d = res.debug || {};
    reason.textContent = res.status === 'none'
      ? `Why: ${d.reason || 'unknown'}${d.seg ? ` (cell ${d.cell}, segment ${d.seg})` : ''}`
      : `slant ${d.slantDeg}° · ${d.ms ? d.ms.toFixed(0) + ' ms' : ''}${d.usedHint ? ' · tracked' : ''}`;
  }
}

function drawCrop(canvas, imageData) {
  canvas.width = imageData.width; canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
}

const STATE_COLOR = { on: 'rgba(74,222,128,0.45)', off: 'rgba(154,163,178,0.0)', '?': 'rgba(248,113,113,0.6)' };
function drawDebug(canvas, res) {
  const ov = res.debug && res.debug.overlay;
  const ctx = canvas.getContext('2d');
  if (!ov) { canvas.width = 200; canvas.height = 40; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 200, 40); ctx.fillStyle = '#9aa3b2'; ctx.font = '13px sans-serif'; ctx.fillText('no digits located', 8, 24); return; }
  const k = 3; // upscale so strokes are visible on a phone
  canvas.width = ov.w * k; canvas.height = ov.h * k;
  const img = ctx.createImageData(ov.w, ov.h);
  for (let i = 0; i < ov.ink.length; i++) { const v = 255 - ov.ink[i]; img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  const tmp = el('canvas'); tmp.width = ov.w; tmp.height = ov.h; tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, ov.w * k, ov.h * k);
  for (const c of ov.cells) {
    ctx.strokeStyle = 'rgba(92,200,255,0.7)'; ctx.lineWidth = 1;
    ctx.strokeRect(c.x0 * k, c.y0 * k, (c.x1 - c.x0) * k, (c.y1 - c.y0) * k);
    for (const s of c.segs) {
      ctx.fillStyle = STATE_COLOR[s.state];
      ctx.fillRect(s.x0 * k, s.y0 * k, (s.x1 - s.x0) * k, (s.y1 - s.y0) * k);
      ctx.strokeStyle = s.state === '?' ? '#f87171' : s.state === 'on' ? '#4ade80' : 'rgba(154,163,178,0.5)';
      ctx.strokeRect(s.x0 * k, s.y0 * k, (s.x1 - s.x0) * k, (s.y1 - s.y0) * k);
    }
  }
  ctx.fillStyle = '#ffb454'; ctx.font = '12px sans-serif';
  ctx.fillText(`straightened ${ov.slantDeg}° · cells ones, tens, hundreds from the right`, 4, 12);
}

// ---------- tabs ----------

const modes = ['photos', 'video', 'live'];
function selectMode(name) {
  for (const m of modes) {
    $('mode-' + m).hidden = m !== name;
    $('tab-' + m).setAttribute('aria-selected', String(m === name));
  }
  if (name !== 'live' && liveCam && !soak.running) stopLive();
  if (name !== 'video') stopVideo();
  msg('');
}
modes.forEach(m => $('tab-' + m).addEventListener('click', () => selectMode(m)));

// ============================================================
// PHOTOS
// ============================================================
const photos = [];
let curPhoto = -1;
const photoWork = {};
const photoStage = new BoxStage($('photo-stage'), b => { const p = photos[curPhoto]; if (p) { p.box = { ...b }; p.boxSet = true; scheduleRead(); } });

async function loadPhoto(file) {
  let bmp = null;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall back to <img> below */ }
  let w, h, src;
  if (!bmp) {
    const url = URL.createObjectURL(file);
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('cannot decode ' + file.name)); i.src = url; });
    w = src.naturalWidth; h = src.naturalHeight;
  } else { src = bmp; w = bmp.width; h = bmp.height; }
  // keep a working copy of at most 2200 px so many large photos do not exhaust memory
  const sc = Math.min(1, 2200 / Math.max(w, h));
  const cv = el('canvas'); cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  if (bmp && bmp.close) bmp.close();
  const th = el('canvas'); th.width = 168; th.height = 128;
  const tctx = th.getContext('2d'); const ts = Math.max(168 / cv.width, 128 / cv.height);
  tctx.drawImage(cv, (168 - cv.width * ts) / 2, (128 - cv.height * ts) / 2, cv.width * ts, cv.height * ts);
  return { name: file.name, canvas: cv, thumb: th, w: cv.width, h: cv.height, box: null, boxSet: false, expected: '', result: null };
}

$('photo-file').addEventListener('change', async e => {
  const files = [...e.target.files];
  if (!files.length) return;
  msg('Loading photos…');
  for (const f of files) {
    try {
      const p = await loadPhoto(f);
      p.box = photos.length ? { ...photos[photos.length - 1].box } : { ...photoStage.box };
      photos.push(p);
    } catch (err) { msg(String(err.message || err), 'error'); }
  }
  e.target.value = '';
  msg('');
  renderThumbs();
  $('photo-readall').disabled = !photos.length;
  if (curPhoto < 0 && photos.length) selectPhoto(0);
  else if (photos.length) selectPhoto(photos.length - files.length);
});

function renderThumbs() {
  const box = $('photo-thumbs'); box.textContent = '';
  photos.forEach((p, i) => {
    const b = el('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(i === curPhoto)); b.title = p.name;
    const c = el('canvas'); c.width = 168; c.height = 128; c.getContext('2d').drawImage(p.thumb, 0, 0);
    b.append(c);
    const o = photoOutcome(p);
    if (o) { const bd = el('span', 'badge ' + o); bd.textContent = o === 'pass' ? '✓' : o === 'fail' ? '✗' : 'miss'; b.append(bd); }
    b.addEventListener('click', () => selectPhoto(i));
    box.append(b);
  });
}

function selectPhoto(i) {
  curPhoto = i;
  const p = photos[i]; if (!p) return;
  const sc = $('photo-canvas');
  const dw = Math.min(1000, p.w), dh = Math.round(dw * p.h / p.w);
  sc.width = dw; sc.height = dh; sc.getContext('2d').drawImage(p.canvas, 0, 0, dw, dh);
  $('photo-stage').hidden = false; $('photo-zoom').parentElement.hidden = false; $('photo-card').hidden = false; $('photo-hint').hidden = true;
  photoStage.setSourceSize(p.w, p.h);
  photoStage.setBox(p.box, true);
  $('photo-expected').value = p.expected;
  renderThumbs();
  readPhoto(p);
}

let readTimer = 0;
function scheduleRead() { cancelAnimationFrame(readTimer); readTimer = requestAnimationFrame(() => { const p = photos[curPhoto]; if (p) readPhoto(p); }); }

function readPhoto(p) {
  const { imageData, res } = readBox(p.canvas, p.w, p.h, p.box, photoWork);
  p.result = { status: res.status, value: res.value, confidence: res.confidence, reason: res.debug.reason };
  if (photos[curPhoto] === p) {
    showResult('photo', res);
    drawCrop($('photo-crop'), imageData);
    drawDebug($('photo-debug'), res);
  }
  updateTally();
}

$('photo-expected').addEventListener('input', e => { const p = photos[curPhoto]; if (p) { p.expected = e.target.value; updateTally(); } });
$('photo-readall').addEventListener('click', async () => {
  for (const p of photos) { readPhoto(p); await new Promise(r => setTimeout(r, 0)); }
  renderThumbs();
});
$('photo-copybox').addEventListener('click', () => {
  const b = photos[curPhoto]?.box; if (!b) return;
  photos.forEach(p => { p.box = { ...b }; });
  photos.forEach(p => readPhoto(p));
  msg('Box copied to all photos.'); setTimeout(() => msg(''), 1500);
});

function photoOutcome(p) {
  const exp = normExpected(p.expected);
  if (exp === null || !p.result) return null;
  const r = p.result;
  const got = r.status === 'dashes' ? '---' : r.status === 'ok' ? String(r.value) : null;
  if (got === null) return 'miss';
  return got === exp ? 'pass' : 'fail';
}

function updateTally() {
  let pass = 0, fail = 0, miss = 0, scored = 0;
  const list = $('photo-list'); list.textContent = '';
  for (const p of photos) {
    const o = photoOutcome(p);
    if (!o) continue;
    scored++; if (o === 'pass') pass++; else if (o === 'fail') fail++; else miss++;
    const li = el('li');
    const got = p.result.status === 'dashes' ? '---' : p.result.status === 'ok' ? p.result.value : 'no reading';
    li.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="${o}">expected ${escapeHtml(normExpected(p.expected))} &middot; read ${escapeHtml(String(got))} &middot; ${o === 'pass' ? 'correct' : o === 'fail' ? 'WRONG' : 'missed'}</span>`;
    list.append(li);
  }
  $('photo-tally').hidden = !scored;
  $('photo-stats').innerHTML =
    stat('correct', `${pass}/${scored}`, pass === scored ? 'good' : '') + stat('wrong', fail, fail ? 'bad' : 'good') + stat('missed', miss, miss ? 'warn' : '');
  renderThumbsBadges();
}
function renderThumbsBadges() {
  [...$('photo-thumbs').children].forEach((b, i) => {
    b.querySelector('.badge')?.remove();
    const o = photoOutcome(photos[i]);
    if (o) { const bd = el('span', 'badge ' + o); bd.textContent = o === 'pass' ? '✓' : o === 'fail' ? '✗' : 'miss'; b.append(bd); }
  });
}
const stat = (label, val, cls = '') => `<div class="stat ${cls}"><b>${val}</b><span>${label}</span></div>`;
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ============================================================
// VIDEO
// ============================================================
const vid = $('video-el');
const videoStage = new BoxStage($('video-stage'), () => { video.hint = null; video.confirmer.reset(); if (!video.running) readVideoOnce(); });
const video = { url: null, running: false, loop: null, tiles: [], filter: null, confirmer: createConfirmer(), curSec: -1, secFrames: [], work: {}, hint: null, misses: 0, wrong: new Set() };

$('video-file').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  stopVideo();
  if (video.url) URL.revokeObjectURL(video.url);
  video.url = URL.createObjectURL(f);
  vid.src = video.url; vid.muted = true; vid.playsInline = true; vid.setAttribute('playsinline', '');
  msg('Loading video…');
  vid.onloadedmetadata = () => {
    videoStage.setSourceSize(vid.videoWidth, vid.videoHeight);
    $('video-stage').hidden = false; $('video-zoom').parentElement.hidden = false; $('video-hint').hidden = true; $('video-process').disabled = false;
    try { vid.currentTime = Math.min(0.05, (vid.duration || 1) / 2); } catch (err) { /* ignore */ }
    msg('');
  };
  vid.onseeked = () => { if (!video.running) readVideoOnce(); };
  vid.onerror = () => msg('This browser could not play that video.', 'error');
  e.target.value = '';
  $('video-tiles').textContent = ''; $('video-summary').hidden = true; $('video-live-card').hidden = true;
});

function readVideoOnce() {
  if (!vid.videoWidth || vid.readyState < 2) return;
  const { res } = readBox(vid, vid.videoWidth, vid.videoHeight, videoStage.box, video.work);
  $('video-live-card').hidden = false;
  showResult('video', res);
}

function stopVideo() {
  if (video.loop) { video.loop.stop(); video.loop = null; }
  if (video.running) { video.running = false; vid.pause(); }
  $('video-process').disabled = !vid.src; $('video-stop').disabled = true;
}
$('video-stop').addEventListener('click', () => { finishVideo(false); });

$('video-process').addEventListener('click', async () => {
  if (video.running) return;
  video.running = true; video.filter = createReadingFilter(); video.confirmer.reset(); video.curSec = -1; video.secFrames = []; video.tiles = []; video.hint = null; video.wrong.clear();
  $('video-tiles').textContent = ''; $('video-summary').hidden = false; $('video-progress').hidden = false;
  $('video-process').disabled = true; $('video-stop').disabled = false;
  updateVideoSummary();
  try { vid.currentTime = 0; } catch (e) { /* ignore */ }
  await new Promise(r => { if (vid.seeking) vid.addEventListener('seeked', r, { once: true }); else r(); });
  vid.playbackRate = parseFloat($('video-speed').value) || 1;
  vid.onended = () => finishVideo(true);
  try { await vid.play(); } catch (err) { msg('Could not start playback: ' + (err.message || err), 'error'); finishVideo(false); return; }
  video.loop = createFrameLoop(vid, FPS, (idx, t) => onVideoFrame(t));
});

function onVideoFrame(t) {
  if (!video.running) return;
  const sec = Math.floor(t + 1e-6);
  if (video.curSec < 0) video.curSec = sec;
  while (video.curSec < sec) closeVideoSecond(); // a skipped second closes as missing
  const read = readBox(vid, vid.videoWidth, vid.videoHeight, videoStage.box, video.work, video.hint);
  const imageData = read.imageData;
  nextHint(video, read.res);
  const res = video.confirmer.step(read.res, t * 1000);
  video.filter.addFrame(res);
  video.secFrames.push({ res, imageData });
  showResult('video', res);
  if (vid.duration) $('video-bar').style.width = Math.min(100, (t / vid.duration) * 100) + '%';
}

function closeVideoSecond() {
  const value = video.filter.closeSecond();
  const frames = video.secFrames;
  // thumbnail: a frame that read the accepted value, else the last frame
  let pick = frames.find(f => f.res.status === 'ok' && f.res.value === value) || frames[frames.length - 1];
  const tile = { sec: video.curSec, value, thumb: null };
  if (pick) { const c = el('canvas'); drawCrop(c, pick.imageData); tile.thumb = c; }
  video.tiles.push(tile);
  video.secFrames = []; video.curSec++;
  addTile(tile, video.tiles.length - 1);
  updateVideoSummary();
}

function addTile(tile, idx) {
  const b = el('button', 'tile' + (tile.value === null ? ' missed' : '')); b.type = 'button';
  if (tile.thumb) b.append(tile.thumb);
  const s = el('span', 'sec'); s.textContent = fmtTime(tile.sec); b.append(s);
  const v = el('span', 'val'); v.textContent = tile.value === null ? 'missed' : tile.value; b.append(v);
  b.addEventListener('click', () => {
    if (tile.value === null) return;
    if (video.wrong.has(idx)) video.wrong.delete(idx); else video.wrong.add(idx);
    b.classList.toggle('wrong', video.wrong.has(idx));
    updateVideoSummary();
  });
  $('video-tiles').append(b);
}

function finishVideo(completed) {
  if (!video.running) return;
  if (video.loop) { video.loop.stop(); video.loop = null; }
  vid.pause(); video.running = false;
  if (video.secFrames.length >= 2) closeVideoSecond(); // keep a final partial second only if it has real data
  $('video-process').disabled = false; $('video-stop').disabled = true;
  if (completed) $('video-bar').style.width = '100%';
  updateVideoSummary(true);
}

function updateVideoSummary(final) {
  if (final) video.finished = true; else if (video.running) video.finished = false;
  final = video.finished;
  const total = video.tiles.length, read = video.tiles.filter(t => t.value !== null).length;
  const wrong = video.wrong.size, missed = total - read, correct = read - wrong;
  const pct = total ? (correct / total) * 100 : 0;
  const meets = total > 0 && pct >= 98 && wrong === 0;
  $('video-stats').innerHTML =
    stat('seconds', total) + stat('correct', `${correct} (${pct.toFixed(1)}%)`, meets ? 'good' : '') +
    stat('missed', missed, missed ? 'warn' : '') + stat('wrong', wrong, wrong ? 'bad' : 'good');
  const h = video.filter ? video.filter.health() : null;
  const v = $('video-verdict');
  v.className = 'verdict' + (total ? (meets ? ' pass' : ' fail') : '');
  v.textContent = !total ? 'Waiting for the first second…'
    : `${final ? '' : 'So far: '}${meets ? 'meets' : 'does not meet'} the target (at least 98% of seconds correct and no wrong values)` +
      (h ? ` · filter discarded ${h.rejected}` : '');
}

// ============================================================
// LIVE CAMERA + SOAK
// ============================================================
let liveCam = null;
const liveVideo = $('live-video');
const liveStage = new BoxStage($('live-stage'), b => { if (liveCam) liveCam.setBox(b); live.hint = null; live.confirmer.reset(); });
const live = { hint: null, misses: 0, confirmer: createConfirmer() };

$('live-start').addEventListener('click', async () => {
  if (liveCam) return;
  msg('');
  try {
    liveCam = createCamera({ video: liveVideo, box: liveStage.box, fps: FPS, widenForDigits: true });
    $('live-start').disabled = true;
    const size = await liveCam.start();
    liveStage.setSourceSize(size.width, size.height);
    liveCam.setBox(liveStage.box);
    $('live-stage').hidden = false; $('live-zoom').parentElement.hidden = false; $('live-card').hidden = false; $('soak-card').hidden = false; $('live-hint').hidden = true;
    $('live-stop').disabled = false;
    liveCam.onStall = () => { if (soak.running) soak.events.push({ t: soakElapsed(), what: 'camera stalled' }); };
    liveCam.onEnded = () => { msg('The camera stopped (another app took it, or the page was backgrounded).', 'error'); if (soak.running) soak.events.push({ t: soakElapsed(), what: 'camera track ended' }); };
    liveCam.startLoop(onLiveFrame);
    updateLiveCamInfo();
  } catch (err) {
    liveCam = null; $('live-start').disabled = false;
    msg(`Camera unavailable: ${err.name || ''} ${err.message || err}. The camera needs HTTPS (or localhost) and your permission.`, 'error');
  }
});
$('live-stop').addEventListener('click', () => stopLive());

function stopLive() {
  if (soak.running) stopSoak('camera stopped');
  if (liveCam) { liveCam.stop(); liveCam = null; }
  $('live-start').disabled = false; $('live-stop').disabled = true;
  $('live-stage').hidden = true; $('live-zoom').parentElement.hidden = true; $('live-card').hidden = true; $('soak-card').hidden = true; $('live-hint').hidden = false;
}

function updateLiveCamInfo() {
  if (!liveCam) return;
  const s = liveCam.stats, st = s.settings || {};
  $('live-cam').textContent = `Camera ${st.width || liveVideo.videoWidth}×${st.height || liveVideo.videoHeight}` +
    ` · exposure lock: ${s.lock.exposure} · focus lock: ${s.lock.focus}` + (s.stalls ? ` · stalls: ${s.stalls}` : '');
  setTimeout(updateLiveCamInfo, 1500);
}

let lastLiveDraw = 0;
function onLiveFrame(imageData) {
  const raw = readDisplay(imageData, { hint: live.hint });
  nextHint(live, raw);
  const res = live.confirmer.step(raw, performance.now());
  if (soak.running) soak.filter.addFrame(res);
  const now = performance.now();
  showResult('live', res);
  if (now - lastLiveDraw > 250) { // drawing the overlays is the expensive part; 4 per second is plenty
    lastLiveDraw = now;
    drawCrop($('live-crop'), imageData);
    drawDebug($('live-debug'), res);
  }
}

// ---- soak test ----
const soak = { running: false, filter: null, startMs: 0, durationS: 0, tick: 0, log: [], events: [], wl: null, wlState: 'not requested', wlReleased: 0, hidden: 0, timer: 0, reading: { read: 0, missing: 0 } };
const soakElapsed = () => (performance.now() - soak.startMs) / 1000;

document.addEventListener('visibilitychange', () => {
  if (soak.running && document.hidden) { soak.hidden++; soak.events.push({ t: soakElapsed(), what: 'page hidden' }); }
  if (soak.running && !document.hidden) { soak.events.push({ t: soakElapsed(), what: 'page visible again' }); if (soak.wlState !== 'unsupported') requestWakeLock(true); }
});

async function requestWakeLock(again) {
  if (!('wakeLock' in navigator)) { soak.wlState = 'unsupported'; return; }
  try {
    soak.wl = await navigator.wakeLock.request('screen');
    soak.wlState = again ? 'held (re-acquired)' : 'held';
    soak.wl.addEventListener('release', () => { soak.wlReleased++; soak.wlState = 'released'; if (soak.running) soak.events.push({ t: soakElapsed(), what: 'wake lock released' }); });
  } catch (err) { soak.wlState = `request failed: ${err.name}`; soak.events.push({ t: soakElapsed(), what: `wake lock request failed (${err.name})` }); }
}

$('soak-start').addEventListener('click', async () => {
  if (!liveCam || soak.running) return;
  const minutes = parseFloat($('soak-minutes').value);
  if (!(minutes > 0)) { msg('Enter a duration in minutes.', 'error'); return; }
  msg('');
  Object.assign(soak, { running: true, filter: createReadingFilter(), durationS: Math.round(minutes * 60), tick: 0, log: [], events: [], wl: null, wlState: 'not requested', wlReleased: 0, hidden: 0 });
  soak.stallBase = liveCam.stats.stalls; soak.longestBase = liveCam.stats.longestStallMs;
  soak.startMs = performance.now();
  $('soak-report').hidden = true; $('soak-strip').textContent = ''; $('soak-progress').hidden = false;
  $('soak-start').disabled = true; $('soak-stop').disabled = false;
  const warn = $('soak-wl-warn');
  if (!('wakeLock' in navigator)) {
    soak.wlState = 'unsupported';
    warn.textContent = 'Screen Wake Lock is not supported in this browser. Without it the screen may dim or lock during a roast and the camera will stop. The soak test still runs and records whether the page was hidden. (Safari needs iOS 16.4 or later.)';
    warn.hidden = false;
  } else { warn.hidden = true; await requestWakeLock(false); if (soak.wlState.startsWith('request failed')) { warn.textContent = 'The browser refused the wake lock (' + soak.wlState + '). The test continues without it.'; warn.hidden = false; } }
  soak.timer = setInterval(soakTick, 250);
});
$('soak-stop').addEventListener('click', () => stopSoak('stopped by user'));

function soakTick() {
  const el = soakElapsed();
  const due = Math.floor(el);
  while (soak.tick < due && soak.tick < soak.durationS) { // derive ticks from the clock so a throttled timer catches up
    const v = soak.filter.closeSecond();
    soak.log.push(v);
    soak.tick++;
    const s = $('soak-strip'); const sp = el_('span', v === null ? 'miss' : ''); sp.textContent = v === null ? '–' : v; s.append(sp);
    while (s.children.length > 40) s.firstChild.remove();
  }
  const h = soak.filter.health();
  const stalls = liveCam ? liveCam.stats.stalls - soak.stallBase : 0;
  $('soak-stats').innerHTML = stat('elapsed', `${fmtTime(Math.min(el, soak.durationS))} / ${fmtTime(soak.durationS)}`) + stat('read', h.secondsRead, 'good') + stat('rejected', h.rejected, h.rejected ? 'warn' : '') +
    stat('missing', h.secondsMissing, h.secondsMissing ? 'warn' : '') + stat('wake lock', wlShort(), soak.wlState.startsWith('held') ? 'good' : 'warn') + stat('stalls', stalls, stalls ? 'bad' : 'good');
  $('soak-bar').style.width = Math.min(100, (el / soak.durationS) * 100) + '%';
  if (soak.tick >= soak.durationS) stopSoak('completed');
}
function el_(tag, cls) { return el(tag, cls); }
function wlShort() { const w = soak.wlState; return w.startsWith('held') ? 'held' : w.startsWith('request failed') ? 'refused' : w === 'unsupported' ? 'unsupported' : w; }

async function stopSoak(why) {
  if (!soak.running) return;
  clearInterval(soak.timer); soak.running = false;
  const ranS = Math.round(Math.min(soakElapsed(), soak.durationS));
  const h = soak.filter.health();
  const cs = liveCam ? liveCam.stats : { stalls: 0, longestStallMs: 0, trackEnded: false, lock: {} };
  const stalls = cs.stalls - (soak.stallBase || 0);
  let wlHeldAtEnd = soak.wl && !soak.wl.released;
  try { if (soak.wl) await soak.wl.release(); } catch (e) { /* ignore */ }
  const total = soak.tick || 1;
  const readPct = (h.secondsRead / total) * 100;
  const wlOk = soak.wlState.startsWith('held') && soak.wlReleased === 0 && wlHeldAtEnd;
  const lines = [
    `Soak test ${why}: ${fmtTime(ranS)} of ${fmtTime(soak.durationS)} planned`,
    `Seconds: ${h.secondsRead} read, ${h.rejected} rejected (range ${h.rejectedRange}, jump ${h.rejectedJump}, frames disagreed ${h.rejectedDisagree}, impossible number ${h.rejectedImpossible}), ${h.secondsMissing} missing, of ${soak.tick}`,
    `Read rate: ${readPct.toFixed(1)}% of seconds (a camera pointed at something other than the digits reads nothing)`,
    `Screen wake lock: ${soak.wlState === 'unsupported' ? 'UNSUPPORTED in this browser' : wlOk ? 'held for the whole run' : `NOT held for the whole run (${soak.wlState}; released ${soak.wlReleased} time${soak.wlReleased === 1 ? '' : 's'})`}`,
    `Camera stream: ${stalls || cs.trackEnded ? `${stalls} stall${stalls === 1 ? '' : 's'}, longest ${(cs.longestStallMs / 1000).toFixed(1)} s${cs.trackEnded ? ', track ENDED' : ''}` : 'never stalled'}`,
    `Page hidden: ${soak.hidden} time${soak.hidden === 1 ? '' : 's'}`,
    `Exposure lock: ${cs.lock.exposure || 'n/a'}, focus lock: ${cs.lock.focus || 'n/a'}`,
  ];
  if (soak.events.length) lines.push('Events: ' + soak.events.map(e => `${fmtTime(e.t)} ${e.what}`).join('; '));
  const alive = !cs.trackEnded && stalls === 0 && soak.hidden === 0;
  const verdict = soak.tick < soak.durationS ? `Stopped early (${why})` : (wlOk || soak.wlState === 'unsupported') && alive ? 'Screen and camera stayed alive' : 'Screen or camera did NOT stay alive';
  $('soak-verdict').textContent = verdict;
  $('soak-verdict').className = soak.tick >= soak.durationS && wlOk && alive ? 'pass' : soak.tick >= soak.durationS ? 'fail' : '';
  $('soak-text').textContent = lines.join('\n');
  $('soak-report').hidden = false; $('soak-progress').hidden = true;
  $('soak-start').disabled = false; $('soak-stop').disabled = true;
  soak.lastReport = lines.join('\n');
}

$('soak-copy').addEventListener('click', async () => {
  const text = `${$('soak-verdict').textContent}\n${soak.lastReport || ''}`;
  try { await navigator.clipboard.writeText(text); msg('Report copied.'); }
  catch (e) {
    const ta = el('textarea'); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); msg('Report copied.'); } catch (e2) { msg('Select the report text and copy it by hand.', 'error'); }
    ta.remove();
  }
  setTimeout(() => msg(''), 1500);
});

// zoom buttons
for (const [btn, stg] of [['photo-zoom', photoStage], ['video-zoom', videoStage], ['live-zoom', liveStage]]) {
  $(btn).addEventListener('click', () => { const on = stg.toggleZoom(); $(btn).textContent = on ? 'Show whole picture' : 'Zoom to box'; });
}

// expose for tests and for poking at from the console
window.readerTest = { photos, video, soak, BoxStage, readDisplay };
