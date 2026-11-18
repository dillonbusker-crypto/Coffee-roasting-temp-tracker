// A draggable, resizable box laid over a camera preview. Touch and mouse (pointer events).
//
//   const cb = createCropBox({ stage, box, onChange, onCommit });
//   cb.setBox(b); cb.getBox(); cb.render(); cb.destroy();
//
// `stage` is a positioned element exactly the size of the picture; the box is in coordinates normalised to it (0..1).
// The box IS the area the reader looks at: nothing is added to it out of sight. Two faint vertical lines split it into three
// digit slots (hundreds, tens, ones; the hundreds slot is the wider one, see DIVIDERS). They are drawn here, in the overlay, and never in the pixels the reader gets.
// onChange fires on every move; onCommit once when the finger lifts.
//
// Gestures: drag inside the box to move it, drag a corner or an edge to resize it, drag on the empty picture to draw a
// new box. The grab areas of the handles sit just outside the box so a small box can still be moved with a thumb. The
// stage has touch-action: none, so the page does not scroll while you drag.
//
// This is the same approach as the box on the reader test page (js/reader/test-page.js), rewritten here because that
// widget is private to the test page.

import { h } from './dom.js';
import { clampBox, DIGIT_EXTENSION } from '../reader/camera.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
// Smallest box, as a fraction of the picture. The box holds three digit slots, so it cannot be a speck: at 1920 by 1080 this
// is 154 by 43 pixels, enough for the reader (it refuses crops under 24 by 16 pixels) and still easy to place with a thumb.
const MIN_W = 0.08, MIN_H = 0.04;

// The three digit slots are not equal. The reader's validated geometry is a box tight around two digits plus DIGIT_EXTENSION box
// heights on the left (reader/camera.js). One digit position is 0.72 digit heights, so, in box heights, the two right-hand slots
// are one pitch each and the left (hundreds) slot is the extension: 0.85 + 2 * 0.72 = 2.29 wide. The left slot is the wider one
// on purpose: the lattice needs room beyond the hundreds cell, and a box whose left edge sits exactly on the pitch cuts that digit off.
export const DIGIT_PITCH = 0.72;
const SLOT_WIDTHS = [DIGIT_EXTENSION, DIGIT_PITCH, DIGIT_PITCH];
const SLOT_TOTAL = SLOT_WIDTHS.reduce((a, b) => a + b, 0);
/** The two dividers as fractions of the box width, from the left: [0.371, 0.686]. */
export const DIVIDERS = [SLOT_WIDTHS[0] / SLOT_TOTAL, (SLOT_WIDTHS[0] + SLOT_WIDTHS[1]) / SLOT_TOTAL];

export function createCropBox({ stage, box, onChange = () => {}, onCommit = () => {} }) {
  let cur = clampBox(box);
  let drag = null;

  const dividers = DIVIDERS.map((f) => {
    const d = h('div', { class: 'cb-div', 'aria-hidden': 'true' });
    d.style.left = `${(f * 100).toFixed(3)}%`;
    return d;
  });
  const handles = HANDLES.map((n) => h('div', { class: 'cb-h', 'data-h': n }, h('i')));
  const boxEl = h('div', { class: 'cb-box', 'data-h': 'move', role: 'group', 'aria-label': 'Reading box. Drag to move, drag a corner to resize.' }, ...dividers, ...handles);
  const layer = h('div', { class: 'cb-layer' }, boxEl);
  stage.append(layer);

  const pct = (v) => `${(v * 100).toFixed(3)}%`;

  function render() {
    boxEl.style.left = pct(cur.x); boxEl.style.top = pct(cur.y);
    boxEl.style.width = pct(cur.w); boxEl.style.height = pct(cur.h);
  }

  function pt(e) {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left) / (r.width || 1), y: (e.clientY - r.top) / (r.height || 1) };
  }

  function set(b, silent) {
    cur = clampBox(b);
    render();
    if (!silent) onChange({ ...cur });
  }

  function down(e) {
    if (e.button !== undefined && e.button > 0) return;
    const p = pt(e);
    const t = e.target;
    const hn = t.closest && t.closest('.cb-h');
    if (hn) drag = { mode: 'resize', h: hn.dataset.h, start: p, box: { ...cur } };
    else if (t.closest && t.closest('.cb-box')) drag = { mode: 'move', start: p, box: { ...cur } };
    else drag = { mode: 'draw', start: p, box: { ...cur } };
    try { stage.setPointerCapture(e.pointerId); } catch { /* not every browser lets a synthetic pointer be captured */ }
    layer.dataset.drag = drag.mode;
    e.preventDefault();
  }

  function move(e) {
    if (!drag) return;
    const p = pt(e);
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    let b;
    if (drag.mode === 'move') {
      b = { ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy };
    } else if (drag.mode === 'draw') {
      b = { x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
      if (b.w < MIN_W || b.h < MIN_H) { e.preventDefault(); return; }
    } else {
      let x0 = drag.box.x, y0 = drag.box.y, x1 = x0 + drag.box.w, y1 = y0 + drag.box.h;
      if (drag.h.includes('w')) x0 = Math.min(x1 - MIN_W, Math.max(0, x0 + dx));
      if (drag.h.includes('e')) x1 = Math.max(x0 + MIN_W, Math.min(1, x1 + dx));
      if (drag.h.includes('n')) y0 = Math.min(y1 - MIN_H, Math.max(0, y0 + dy));
      if (drag.h.includes('s')) y1 = Math.max(y0 + MIN_H, Math.min(1, y1 + dy));
      b = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    set(b);
    e.preventDefault();
  }

  function up() {
    if (!drag) return;
    drag = null;
    delete layer.dataset.drag;
    onCommit({ ...cur });
  }

  stage.addEventListener('pointerdown', down);
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  render();

  return {
    getBox: () => ({ ...cur }),
    setBox: (b, silent = true) => set(b, silent),
    render,
    destroy() {
      stage.removeEventListener('pointerdown', down);
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', up);
      layer.remove();
    },
  };
}
