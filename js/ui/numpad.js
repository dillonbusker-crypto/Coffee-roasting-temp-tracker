// Number pad for typing a thermometer reading. Used inline on Setup (manual source) and
// as a bottom sheet on the Roast screen ("Type reading").
//
// The user types in their display unit; onEnter receives °F. onEnter returns
// { ok: true } or { ok: false, reason } so the caller's own validation shows up here.

import { h, openSheet, setText } from './dom.js';
import { tempFromUnit, tempToUnit, unitLabel } from '../core/units.js';

export function createNumpad({ units = 'F', minF = 50, maxF = 550, onEnter, enterLabel = 'Enter' }) {
  let digits = '';
  const display = h('div', { class: 'np-display', 'aria-live': 'polite', id: 'np-display' }, '');
  const error = h('div', { class: 'np-error', role: 'alert' }, '');
  const unit = unitLabel(units);
  const lo = Math.ceil(tempToUnit(minF, units));
  const hi = Math.floor(tempToUnit(maxF, units));

  function show() {
    setText(display, digits === '' ? '—' : `${digits}${unit}`);
    display.classList.toggle('empty', digits === '');
  }

  function press(d) {
    if (digits.length >= 3) return;
    digits = digits === '0' ? d : digits + d;
    setText(error, '');
    show();
  }

  function enter() {
    const v = Number(digits);
    if (digits === '' || !Number.isFinite(v)) { setText(error, `Type a reading from ${lo} to ${hi}${unit}`); return; }
    const f = tempFromUnit(v, units);
    if (f < minF || f > maxF) { setText(error, `Type a reading from ${lo} to ${hi}${unit}`); return; }
    const res = onEnter(f);
    if (res && res.ok === false) { setText(error, res.reason === 'not a number' ? 'Not a number' : `Type a reading from ${lo} to ${hi}${unit}`); return; }
    digits = '';
    show();
  }

  const key = (label, fn, cls = '', id = '') =>
    h('button', { type: 'button', class: `np-key ${cls}`, id, onClick: fn, 'aria-label': label === '⌫' ? 'Delete' : label }, label === '⌫' ? 'Delete' : label);

  const keys = h('div', { class: 'np-keys' },
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d, () => press(d))),
    key('⌫', () => { digits = digits.slice(0, -1); setText(error, ''); show(); }, 'np-del'),
    key('0', () => press('0')),
    key(enterLabel, enter, 'np-enter', 'np-enter'));

  show();
  const root = h('div', { class: 'numpad' }, display, error, keys);
  root.clear = () => { digits = ''; setText(error, ''); show(); };
  return root;
}

// Bottom sheet on the Roast screen. Closes itself after a good entry.
export function openNumpadSheet({ units, minF, maxF, onEnter }) {
  return openSheet({
    label: 'Type reading',
    build(sheet, close) {
      const pad = createNumpad({
        units, minF, maxF,
        onEnter: (f) => {
          const res = onEnter(f);
          if (!res || res.ok !== false) close('entered');
          return res;
        },
      });
      sheet.append(
        h('div', { class: 'sheet-head' },
          h('h2', { class: 'sheet-title' }, 'Type reading'),
          h('button', { type: 'button', class: 'btn plain sheet-cancel', id: 'np-cancel', onClick: () => close(null) }, 'Cancel')),
        pad);
    },
  });
}
