// The camera source's screens: the Setup panel (live preview, reading box, magnified crop with the value read, tips and
// the permission states) and the small crop strip on the Roast screen. Exports a registry entry (see sources.js).
//
// Setup flow. renderSetupPanel() builds the panel, including the <video> element, and keeps a handle on ctx.state.camera.
// Setup then calls createSource(ctx), which builds the camera source around that same <video> and attaches it to the
// panel. Nothing asks for the camera until Setup has the Camera segment on screen: the source is only created then. The
// first time ever (no earlier grant on this phone) the panel shows an "Allow camera" button and waits for the tap;
// afterwards it opens the camera by itself.
//
// Handing over to the roast. The same source and <video> element go to the Roast screen (keepAlive). Removing a playing
// video from the page pauses it, so the panel's cleanup moves it into a holder on <body> instead and the crop strip
// takes it from there, all within one route change. The strip shows the live video cropped to the reader's region.

import { h, clear, setText, setAttr } from './dom.js';
import { createCameraSource } from '../sources/camera-source.js';
import { createCropBox } from './crop-box.js';
import { expandBoxForDigits, clampBox } from '../reader/camera.js';
import { formatTemp } from '../core/units.js';

const BOX_KEY = 'rt.camera.box';
const GRANTED_KEY = 'rt.camera.granted';
const DEFAULT_BOX = { x: 0.52, y: 0.3, w: 0.3, h: 0.22 };

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, v) { try { localStorage.setItem(key, v); } catch { /* private mode: the box is just not remembered */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

export function loadBox() {
  try {
    const b = JSON.parse(store.get(BOX_KEY));
    if (b && [b.x, b.y, b.w, b.h].every(Number.isFinite)) return clampBox(b);
  } catch { /* nothing saved, or not valid */ }
  return { ...DEFAULT_BOX };
}
export const saveBox = (b) => store.set(BOX_KEY, JSON.stringify({ x: b.x, y: b.y, w: b.w, h: b.h }));
export const wasGranted = () => store.get(GRANTED_KEY) === '1';

/** True when this page could open a camera: the API exists and the page is a secure context. */
export function cameraSupported() {
  try {
    return typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext !== false;
  } catch { return false; }
}

function holder() {
  let el = document.getElementById('cam-holder');
  if (!el) { el = h('div', { id: 'cam-holder', 'aria-hidden': 'true' }); document.body.append(el); }
  return el;
}

function resume(video) {
  try { const p = video.play(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
}

// ---- the text for each state ----

const PROBLEM_CARDS = {
  'needs-tap': {
    title: 'Allow the camera',
    body: ['Roast Tracker reads the thermometer through the rear camera. Pictures stay on this phone and are never saved or sent anywhere.'],
    button: { id: 'cam-allow', label: 'Allow camera', primary: true, action: 'request' },
  },
  denied: {
    title: 'The camera is blocked',
    body: [
      'To allow it, tap the aA button in Safari’s address bar, choose Website Settings, set Camera to Allow, then tap Try again. From the Home Screen, check Settings, Safari, Camera instead.',
      'Demo and Manual still work without the camera.',
    ],
    button: { id: 'cam-retry', label: 'Try again', action: 'retry' },
  },
  'no-camera': {
    title: 'No camera found',
    body: ['This phone or browser has no camera the page can use. Demo and Manual still work.'],
    button: { id: 'cam-retry', label: 'Try again', action: 'retry' },
  },
  insecure: {
    title: 'The camera needs HTTPS',
    body: ['Browsers only allow the camera on secure pages. Open the app from its https:// address. Demo and Manual still work.'],
  },
  unsupported: {
    title: 'This browser can’t use the camera',
    body: ['Try Safari on an iPhone. Demo and Manual still work.'],
  },
  error: {
    title: 'The camera didn’t start',
    body: ['Another app may be using it. Close the other app, then try again.'],
    button: { id: 'cam-retry', label: 'Try again', action: 'retry' },
    showMessage: true,
  },
};

// What the stream is doing, for the line under the preview and the message over it.
const TROUBLE_TEXT = {
  requesting: 'Opening the camera…',
  recovering: 'Reconnecting the camera…',
  ended: 'The camera stopped. Reconnecting…',
  muted: 'The camera is paused. Waiting for it to come back…',
  stalled: 'The camera stopped sending pictures. Waiting for it…',
};

const SHORT = {
  requesting: 'Opening camera', recovering: 'Reconnecting', ended: 'Camera stopped', muted: 'Camera paused', stalled: 'No pictures',
  denied: 'Camera blocked', 'no-camera': 'No camera', stopped: 'Camera off',
};

export function describeRead(p, units) {
  if (p && p.status === 'ok' && p.value != null) return { kind: 'ok', value: formatTemp(p.value, units), text: `Reading ${formatTemp(p.value, units)}` };
  if (p && p.status === 'dashes') return { kind: 'dashes', value: '---', text: 'No probe: the display shows dashes' };
  return { kind: 'none', value: '—', text: 'Can’t read the digits yet' };
}

// ---- Setup panel ----

export function createCameraPanel({ units = 'F', settings = {} } = {}) {
  const video = h('video', {
    class: 'cam-video', playsinline: true, muted: true, autoplay: true, 'webkit-playsinline': true, disablepictureinpicture: true,
    'aria-label': 'Live camera view',
  });
  video.muted = true; video.defaultMuted = true; video.playsInline = true;

  let source = null;
  let offs = [];
  let box = loadBox();
  let cropBox = null;
  let ro = null;

  const overlay = h('div', { class: 'cam-overlay', id: 'cam-overlay', role: 'status' });
  const stage = h('div', { class: 'cam-stage', id: 'cam-stage' }, video, overlay);
  const stageWrap = h('div', { class: 'cam-stage-wrap' }, stage);

  const card = h('div', { class: 'cam-card', id: 'cam-card' });
  const crop = h('canvas', { class: 'cam-crop', id: 'cam-crop', 'aria-label': 'What the reader sees', width: 120, height: 40 });
  const cropCtx = crop.getContext('2d');
  const value = h('div', { class: 'cam-value', id: 'cam-value' }, '—');
  const status = h('div', { class: 'cam-status', id: 'cam-status', role: 'status', 'aria-live': 'polite' }, '');
  const readRow = h('div', { class: 'cam-read' },
    h('div', { class: 'cam-mag' }, h('span', { class: 'cam-cap' }, 'What the reader sees'), crop),
    h('div', { class: 'cam-val' }, h('span', { class: 'cam-cap' }, 'Reads'), value));
  const live = h('div', { class: 'cam-live' },
    h('p', { class: 'cam-hint' }, 'Drag the box over the top-right number. Drag a corner or edge to resize it.'),
    stageWrap,
    h('p', { class: 'cam-legend' },
      h('span', { class: 'cam-key cam-key-box' }), 'Reading box ',
      h('span', { class: 'cam-key cam-key-ext' }), 'Also searched, for a third digit'),
    readRow, status);

  const tips = h('div', { class: 'cam-tips', id: 'cam-tips' },
    h('h3', null, 'Aiming tips'),
    h('ul', null,
      h('li', null, 'Box only the top-right number, THERMO TEMP for probe 1. Leave out the °F and the number to its left.'),
      h('li', null, 'Keep the SET TEMP number out of the dashed area too: the reader looks there for a third digit.'),
      h('li', null, 'Face the display square-on, and move the phone to avoid glare. The backlight goes off after 10 seconds, and that’s fine.')));

  const root = h('div', { class: 'cam-panel', id: 'cam-panel', 'data-cam': 'idle' }, card, live, tips);

  // ---- layout: the picture is as wide as the card allows and no taller than about 40% of the screen ----

  function layout() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const aspect = vw && vh ? vw / vh : 16 / 9;
    const cw = stageWrap.clientWidth;
    if (!cw) return;
    const maxH = Math.max(170, Math.min(window.innerHeight * 0.4, 400));
    const w = Math.min(cw, maxH * aspect);
    stage.style.width = `${Math.round(w)}px`;
    stage.style.height = `${Math.round(w / aspect)}px`;
    if (cropBox) cropBox.render();
  }

  const expand = (b) => expandBoxForDigits(b, video.videoWidth || 16, video.videoHeight || 9);

  cropBox = createCropBox({
    stage, box, expand,
    onChange: (b) => { box = b; if (source) source.setBox(b); },
    onCommit: (b) => { box = b; saveBox(b); },
  });

  video.addEventListener('loadedmetadata', layout);
  video.addEventListener('resize', layout);
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(layout); ro.observe(stageWrap); }
  window.addEventListener('resize', layout);

  // ---- rendering ----

  function showCard(state, message) {
    const c = PROBLEM_CARDS[state];
    clear(card);
    if (!c) { card.hidden = true; return; }
    card.hidden = false;
    card.dataset.state = state;
    card.append(h('h3', { class: 'cam-card-title', id: 'cam-card-title' }, c.title), ...c.body.map((t) => h('p', null, t)));
    if (c.showMessage && message) card.append(h('p', { class: 'muted small', id: 'cam-card-detail' }, message));
    if (c.button) {
      card.append(h('button', {
        type: 'button', class: `btn ${c.button.primary ? 'primary' : ''} cam-card-btn`, id: c.button.id,
        onClick: async (ev) => {
          const btn = ev.currentTarget;
          if (!source) return;
          btn.disabled = true;
          try { await (c.button.action === 'request' ? source.requestAccess() : source.retry()); } finally { btn.disabled = false; }
        },
      }, c.button.label));
    }
  }

  function renderState() {
    const st = source ? source.state : 'idle';
    root.dataset.cam = st;
    const problem = !!PROBLEM_CARDS[st];
    live.hidden = problem;
    tips.hidden = problem;
    if (problem) showCard(st, source && source.message); else card.hidden = true;
    const trouble = TROUBLE_TEXT[st];
    overlay.hidden = !trouble || st === 'live';
    if (trouble) setText(overlay, trouble);
    stage.dataset.state = st;
    layout();
    renderRead();
  }

  function renderRead() {
    if (!source || source.state !== 'live') {
      const t = source && TROUBLE_TEXT[source.state];
      setText(value, '—');
      setText(status, t || '');
      status.dataset.kind = 'wait';
      return;
    }
    const d = describeRead(source.peek(), units);
    setText(value, d.value);
    setText(status, d.text);
    status.dataset.kind = d.kind;
    value.dataset.kind = d.kind;
  }

  function onFrame(f) {
    const img = f.imageData;
    if (crop.width !== img.width || crop.height !== img.height) { crop.width = img.width; crop.height = img.height; }
    cropCtx.putImageData(img, 0, 0);
    renderRead();
  }

  function attach(src) {
    detach();
    source = src;
    offs = [
      src.onState(() => renderState()),
      src.onFrame(onFrame),
    ];
    renderState();
  }

  function detach() { for (const off of offs) off(); offs = []; }

  renderState();

  return {
    el: root,
    video,
    get box() { return box; },
    attach,
    layout,
    dispose() {
      detach();
      if (cropBox) cropBox.destroy();
      if (ro) ro.disconnect();
      window.removeEventListener('resize', layout);
      source = null;
      // Handed over to the roast: keep the stream's <video> in the page so it does not pause.
      if (video.srcObject) { video.dataset.parked = '1'; holder().append(video); resume(video); }
    },
  };
}

// ---- Roast status strip ----

export function renderRoastStatus(container, source, { units = 'F' } = {}) {
  const view = h('div', { class: 'cam-strip-view', id: 'cam-strip-view', 'aria-hidden': 'true' });
  const line1 = h('span', { class: 'cam-strip-line', id: 'cam-strip-line' }, '');
  const line2 = h('b', { class: 'cam-strip-value', id: 'cam-strip-value' }, '');
  const strip = h('div', { class: 'cam-strip', id: 'cam-strip', role: 'img', 'aria-label': 'Camera view', 'data-state': 'ok' },
    view, h('div', { class: 'cam-strip-text' }, line1, line2));
  container.append(strip);
  const video = source.video;

  // Show the live video cropped to the reader's region: scale it so the crop fills the view, and slide it into place.
  function fit() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const rb = source.readerBox();
    const aspect = (rb.w * vw) / (rb.h * vh);
    let sh = 40, sw = sh * aspect;
    if (sw > 104) { sw = 104; sh = sw / aspect; }
    const vidW = sw / rb.w, vidH = (vidW * vh) / vw;
    view.style.width = `${Math.round(sw)}px`; view.style.height = `${Math.round(sh)}px`;
    Object.assign(video.style, {
      position: 'absolute', width: `${vidW}px`, height: `${vidH}px`, maxWidth: 'none', left: `${-rb.x * vidW}px`, top: `${-rb.y * vidH}px`,
    });
  }

  if (video) {
    delete video.dataset.parked;
    video.className = 'cam-video cam-video-strip';
    view.append(video);
    fit();
    resume(video);
    video.addEventListener('loadedmetadata', fit);
  }

  function render() {
    const bad = source.state !== 'live';
    const d = describeRead(source.peek(), units);
    let state = 'ok', l1, l2;
    if (bad) {
      state = 'lost';
      l1 = SHORT[source.state] || 'Camera problem';
      l2 = '—';
    } else if (d.kind === 'ok') { l1 = 'Reading'; l2 = d.value; }
    else if (d.kind === 'dashes') { state = 'warn'; l1 = 'No probe'; l2 = '---'; }
    else { state = 'warn'; l1 = 'Can’t read'; l2 = '—'; }
    setAttr(strip, 'data-state', state);
    setText(line1, l1); setText(line2, l2);
    strip.setAttribute('aria-label', `Camera view. ${l1} ${l2}`);
  }

  render();
  const timer = setInterval(render, 1000);
  const off = source.onState(render);
  return function cleanup() {
    clearInterval(timer);
    off();
    if (video) video.removeEventListener('loadedmetadata', fit);
  };
}

// ---- Registry entry ----

export const cameraEntry = {
  id: 'camera',
  label: 'Camera',
  keepAlive: true,             // the roast uses the preview's stream; it must not be opened twice
  goodReadingsNeeded: 5,
  pollMs: 1000,
  renderSetupPanel(container, ctx) {
    const panel = createCameraPanel({ units: ctx.units, settings: ctx.settings });
    ctx.state.camera = panel;
    container.append(panel.el);
    panel.layout();
    return () => { if (ctx.state.camera === panel) ctx.state.camera = null; panel.dispose(); };
  },
  createSource(ctx) {
    const panel = ctx.state.camera || null;
    const src = createCameraSource({
      settings: ctx.settings,
      video: panel ? panel.video : null,
      box: panel ? panel.box : loadBox(),
      requireTap: !wasGranted(),
    });
    src.onState(({ state }) => {
      if (state === 'live') store.set(GRANTED_KEY, '1');
      else if (state === 'denied') store.remove(GRANTED_KEY);
      else if (state === 'stopped') { const v = src.video; if (v && v.dataset.parked) v.remove(); }
    });
    if (panel) panel.attach(src);
    return src;
  },
  describe: () => 'Camera',
  roastSpeed: () => 1,
  renderRoastStatus: (container, source, opts) => renderRoastStatus(container, source, opts),
  tempLabel: (f, units) => formatTemp(f, units),
};
