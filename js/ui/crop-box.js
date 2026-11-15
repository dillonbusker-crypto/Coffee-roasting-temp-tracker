// A draggable, resizable box laid over a camera preview. Touch and mouse (pointer events).
//
//   const cb = createCropBox({ stage, box, expand, onChange, onCommit });
//   cb.setBox(b); cb.getBox(); cb.render(); cb.destroy();
//
// `stage` is a positioned element exactly the size of the picture; the box is in coordinates normalised to it (0..1).
// `expand(box)` returns the area the reader actually looks at (the box widened to the left for a third digit), drawn as a
// dashed region beside the box. onChange fires on every move; onCommit once when the finger lifts.
//
// Gestures: drag inside the box to move it, drag a corner or an edge to resize it, drag on the empty picture to draw a
// new box. The grab areas of the handles sit just outside the box so a small box can still be moved with a thumb. The
// stage has touch-action: none, so the page does not scroll while you drag.
//
// This is the same approach as the box on the reader test page (js/reader/test-page.js), rewritten here because that
// widget is private to the test page.

import { h } from './dom.js';
import { clampBox } from '../reader/camera.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN = 0.02;     // smallest box side, as a fraction of the picture

export function createCropBox({ stage, box, expand = null, onChange = () => {}, onCommit = () => {} }) {
  let cur = clampBox(box);
  let drag = null;

  const ext = h('div', { class: 'cb-ext', 'aria-hidden': 'true' });
  const handles = HANDLES.map((n) => h('div', { class: 'cb-h', 'data-h': n }, h('i')));
  const boxEl = h('div', { class: 'cb-box', 'data-h': 'move', role: 'group', 'aria-label': 'Reading box. Drag to move, drag a corner to resize.' }, ...handles);
  const layer = h('div', { class: 'cb-layer' }, ext, boxEl);
  stage.append(layer);

  const pct = (v) => `${(v * 100).toFixed(3)}%`;

  function render() {
    boxEl.style.left = pct(cur.x); boxEl.style.top = pct(cur.y);
    boxEl.style.width = pct(cur.w); boxEl.style.height = pct(cur.h);
    const rb = expand ? expand(cur) : null;
    if (rb && rb.x < cur.x - 1e-4) {
      ext.hidden = false;
      ext.style.left = pct(rb.x); ext.style.top = pct(cur.y);
      ext.style.width = pct(cur.x - rb.x); ext.style.height = pct(cur.h);
      ext.dataset.clipped = rb.clipped ? 'true' : 'false';
    } else ext.hidden = true;
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
      if (b.w < MIN || b.h < MIN) { e.preventDefault(); return; }
    } else {
      let x0 = drag.box.x, y0 = drag.box.y, x1 = x0 + drag.box.w, y1 = y0 + drag.box.h;
      if (drag.h.includes('w')) x0 = Math.min(x1 - MIN, Math.max(0, x0 + dx));
      if (drag.h.includes('e')) x1 = Math.max(x0 + MIN, Math.min(1, x1 + dx));
      if (drag.h.includes('n')) y0 = Math.min(y1 - MIN, Math.max(0, y0 + dy));
      if (drag.h.includes('s')) y1 = Math.max(y0 + MIN, Math.min(1, y1 + dy));
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
