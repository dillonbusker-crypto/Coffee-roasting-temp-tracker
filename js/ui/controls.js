// Small controls shared by the Detail and Settings screens.

import { h } from './dom.js';

// A switch row like the one on the After screen. `on` is the starting state.
// Returns the button; .set(v) changes it without calling onChange; .on reads it.
export function switchRow({ id, title, hint, on = false, onChange }) {
  let state = !!on;
  const hintEl = h('small', null, hint || '');
  const btn = h('button', {
    type: 'button', role: 'switch', id, class: 'switch-row', 'aria-checked': String(state),
    onClick: () => { set(!state); onChange && onChange(state); },
  },
  h('span', { class: 'sw-text' }, h('b', null, title), hint === undefined ? null : hintEl),
  h('span', { class: 'sw-track' }, h('i', null)));
  function set(v) { state = !!v; btn.setAttribute('aria-checked', String(state)); }
  btn.set = set;
  btn.setHint = (t) => { hintEl.textContent = t; };
  Object.defineProperty(btn, 'on', { get: () => state });
  return btn;
}

// The 1 to 5 taste score buttons. Tapping the chosen score again clears it.
export function scoreRow({ value = null, onChange }) {
  let current = value;
  const btns = [1, 2, 3, 4, 5].map((n) => h('button', {
    type: 'button', class: 'score-btn', 'data-score': n, role: 'radio', 'aria-checked': 'false', 'aria-label': `Taste score ${n}`,
    onClick: () => { set(current === n ? null : n); onChange && onChange(current); },
  }, String(n)));
  const el = h('div', { class: 'score-row', role: 'radiogroup', 'aria-label': 'Taste score' }, ...btns);
  function set(v) {
    current = v;
    for (const b of btns) {
      const on = Number(b.dataset.score) === current;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('on', on);
    }
  }
  set(current);
  el.set = set;
  return el;
}

// "Reference" / "General fallback" tags for a roast record (empty array when it is neither).
export function referenceTags(record) {
  const tags = [];
  if (record?.reference?.coffee) tags.push(h('span', { class: 'tag ref', 'data-tag': 'reference' }, 'Reference'));
  if (record?.reference?.general) tags.push(h('span', { class: 'tag ref', 'data-tag': 'general' }, 'General fallback'));
  return tags;
}

// Weight-loss status against the settings band: 'none' | 'in' | 'under' | 'over', and the words for it.
export function lossBand(lossPct, settings) {
  if (lossPct == null || Number.isNaN(lossPct)) return { band: 'none', shown: null, words: '' };
  const shown = Number(lossPct.toFixed(1));
  const lo = settings.weightLossMinPct;
  const hi = settings.weightLossMaxPct;
  if (shown < lo) return { band: 'under', shown, words: `Under the ${lo}–${hi}% band. Roasted lighter than the target.` };
  if (shown > hi) return { band: 'over', shown, words: `Over the ${lo}–${hi}% band. Roasted darker than the target.` };
  return { band: 'in', shown, words: `In the ${lo}–${hi}% band.` };
}

export function fmtDateAndTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

// A small "Saved" pill at the bottom of the screen. Remove it with dispose().
export function createToast(text = 'Saved') {
  const el = h('div', { class: 'toast', id: 'toast', role: 'status', hidden: true }, text);
  document.body.append(el);
  let timer = null;
  return {
    el,
    show(msg) {
      if (msg) el.textContent = msg;
      el.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => { el.hidden = true; }, 1400);
    },
    dispose() { clearTimeout(timer); el.remove(); },
  };
}
