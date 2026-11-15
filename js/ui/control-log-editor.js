// Heat and fan log editor. Lists the logged changes with their time and value; each can be
// edited or deleted, and new ones added. Used on the After screen and on the roast detail.
//
//   const ed = createControlLogEditor({ controls, endT, onChange(controls) });
//   container.append(ed.el);
//   ed.set({ controls, endT })      // replace the list from outside (no onChange call)
//
// Rules: the list stays sorted by time. The two entries at t = 0 (the starting heat and fan)
// keep their time and cannot be deleted, but their value can change. Every other time is
// clamped to 1 s .. the roast length. Two changes of the same kind at the same second
// collapse into one (the one just edited wins).
//
// The pure rules are exported for tests.

import { h, clear, segmented } from './dom.js';
import { formatClock } from '../core/units.js';

export const HEAT_LEVELS = [1, 2, 3, 4, 5, 6, 7];

// "1:30" -> 90, "90" -> 90, "0:05" -> 5. Anything else -> null.
export function parseClockText(text) {
  const s = String(text ?? '').trim();
  let m = /^(\d{1,3}):([0-5]?\d)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{1,5})$/.exec(s);
  return m ? Number(m[1]) : null;
}

// Whole seconds from 1 to the roast length (at least 1).
export function clampTime(t, endT) {
  const hi = Math.max(1, Math.floor(endT || 0));
  return Math.max(1, Math.min(hi, Math.round(t)));
}

// Copies the list and sorts it by time. Equal times keep their order, so the starting heat stays above the starting fan.
export function sortControls(list) {
  return list.map((c, i) => ({ c: { t: c.t, kind: c.kind, value: c.value }, i }))
    .sort((a, b) => a.c.t - b.c.t || a.i - b.i)
    .map((x) => x.c);
}

export const isStart = (c) => c.t === 0;

// Adds or moves an entry; returns a new sorted list. `index` is the entry being edited (or -1 to add).
export function upsertControl(list, index, entry, endT) {
  const next = list.map((c) => ({ ...c }));
  const clean = { kind: entry.kind, value: entry.value, t: isStart(next[index] || { t: -1 }) ? 0 : clampTime(entry.t, endT) };
  let keep;
  if (index >= 0 && index < next.length) { next[index] = clean; keep = clean; } else { next.push(clean); keep = clean; }
  const out = next.filter((c) => c === keep || isStart(c) || !(c.kind === keep.kind && c.t === keep.t));
  return sortControls(out);
}

export function removeControl(list, index) {
  if (index < 0 || index >= list.length || isStart(list[index])) return sortControls(list);
  return sortControls(list.filter((_, i) => i !== index));
}

const valueText = (kind, v) => (kind === 'heat' ? String(v) : (v === 'high' ? 'High' : 'Low'));
const kindName = (kind) => (kind === 'heat' ? 'Heat' : 'Fan');

function valueSelect(kind, value, props) {
  const opts = kind === 'heat'
    ? HEAT_LEVELS.map((n) => [n, String(n)])
    : [['high', 'High'], ['low', 'Low']];
  const sel = h('select', { class: 'field-input log-value', ...props },
    ...opts.map(([v, label]) => h('option', { value: String(v), selected: String(v) === String(value) }, label)));
  return sel;
}

const readValue = (kind, raw) => (kind === 'heat' ? Number(raw) : raw);

export function createControlLogEditor({ controls = [], endT = 0, onChange } = {}) {
  let list = sortControls(controls);
  let end = endT;

  const listEl = h('ul', { class: 'log-list', id: 'log-list' });
  const error = h('p', { class: 'error-line', id: 'log-error', role: 'alert' }, '');
  const note = h('p', { class: 'muted small', id: 'log-note' }, '');

  let addKind = 'heat';
  const addTime = h('input', {
    id: 'log-add-time', class: 'field-input', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'off',
    placeholder: 'm:ss', 'aria-label': 'Time of the new change, minutes and seconds',
  });
  const addValueHost = h('div', { class: 'log-add-value' });
  const addKindSeg = segmented({
    label: 'Kind of change', cls: 'two', value: addKind,
    options: [{ value: 'heat', label: 'Heat' }, { value: 'fan', label: 'Fan' }],
    onChange: (v) => { addKind = v; buildAddValue(); },
  });
  addKindSeg.id = 'log-add-kind';
  let addValue = null;
  function buildAddValue() {
    clear(addValueHost);
    addValue = valueSelect(addKind, addKind === 'heat' ? 3 : 'low', { id: 'log-add-value', 'aria-label': `New ${addKind} setting` });
    addValueHost.append(addValue);
  }
  buildAddValue();

  const addBtn = h('button', { type: 'button', class: 'btn', id: 'log-add-btn', onClick: onAdd }, 'Add change');

  function say(text, kind = 'error') {
    error.textContent = text || '';
    error.dataset.kind = kind;
  }

  function commit(next) {
    list = next;
    render();
    onChange && onChange(list.map((c) => ({ ...c })));
  }

  function timeFromInput(inputEl) {
    const t = parseClockText(inputEl.value);
    if (t == null) { say('Type a time like 1:30, minutes and seconds from Start.'); return null; }
    const c = clampTime(t, end);
    if (c !== t) say(`The roast was ${formatClock(end)} long, so the time was set to ${formatClock(c)}.`, 'note');
    else say('');
    return c;
  }

  function onAdd() {
    const t = timeFromInput(addTime);
    if (t == null) return;
    addTime.value = '';
    commit(upsertControl(list, -1, { t, kind: addKind, value: readValue(addKind, addValue.value) }, end));
  }

  function row(c, i) {
    const start = isStart(c);
    const name = `${kindName(c.kind)} at ${formatClock(c.t)}`;
    const timeCell = start
      ? h('div', { class: 'field-input static log-time-static', 'aria-label': 'Time: Start' }, '0:00')
      : h('input', {
        class: 'field-input log-time', type: 'text', inputmode: 'text', autocomplete: 'off', value: formatClock(c.t),
        'aria-label': `Time of ${name}`,
        onChange: (e) => {
          const t = timeFromInput(e.target);
          if (t == null) { e.target.value = formatClock(c.t); return; }
          commit(upsertControl(list, i, { ...c, t }, end));
        },
      });
    const sel = valueSelect(c.kind, c.value, {
      'aria-label': `${kindName(c.kind)} setting at ${formatClock(c.t)}`,
      onChange: (e) => { say(''); commit(upsertControl(list, i, { ...c, value: readValue(c.kind, e.target.value) }, end)); },
    });
    const last = start
      ? h('span', { class: 'log-start' }, 'Start')
      : h('button', {
        type: 'button', class: 'btn danger log-del', 'aria-label': `Delete ${name}`,
        onClick: () => { say(''); commit(removeControl(list, i)); },
      }, 'Delete');
    return h('li', { class: 'log-row', 'data-index': i, 'data-kind': c.kind, 'data-start': start ? 'true' : null },
      h('div', { class: 'log-cell' }, h('span', { class: 'log-cap' }, 'Time'), timeCell),
      h('div', { class: 'log-cell' }, h('span', { class: 'log-cap' }, kindName(c.kind)), sel),
      last);
  }

  function render() {
    clear(listEl);
    list.forEach((c, i) => listEl.append(row(c, i)));
    const n = list.filter((c) => !isStart(c)).length;
    note.textContent = `${n} ${n === 1 ? 'change' : 'changes'} after Start. The settings at 0:00 stay; you can change their value.`;
  }

  render();

  const el = h('div', { class: 'log-editor', id: 'log-editor' },
    h('p', { class: 'muted small' }, 'Times run from Start, as m:ss. Edit a time or value, delete a change, or add one you forgot to tap.'),
    listEl, note,
    h('div', { class: 'log-add' },
      h('h3', null, 'Add a change'),
      addKindSeg,
      h('div', { class: 'row-2' },
        h('label', { class: 'log-cell' }, h('span', { class: 'log-cap' }, 'Time'), addTime),
        h('div', { class: 'log-cell' }, h('span', { class: 'log-cap' }, 'Setting'), addValueHost)),
      addBtn),
    error);

  return {
    el,
    set(next) {
      list = sortControls(next.controls || []);
      if (next.endT != null) end = next.endT;
      render();
    },
    get: () => list.map((c) => ({ ...c })),
  };
}
