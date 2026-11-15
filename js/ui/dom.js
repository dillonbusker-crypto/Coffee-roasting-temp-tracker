// Tiny DOM helpers shared by the screens. No framework.

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'textContent', 'innerHTML']);

// h('button', { class: 'btn', onClick: fn, 'aria-pressed': true }, 'Label', childEl)
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// Sets text only when it changed, so frequent updates do not churn the DOM.
export function setText(el, text) {
  const s = String(text);
  if (el.textContent !== s) el.textContent = s;
}

export function setAttr(el, name, value) {
  if (value == null || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else {
    const s = value === true ? '' : String(value);
    if (el.getAttribute(name) !== s) el.setAttribute(name, s);
  }
}

// ---- Controls ----

// Segmented control: options [{ value, label, disabled?, hint? }]. Returns the element with .set(value).
export function segmented({ options, value, onChange, label, cls = '' }) {
  let current = value;
  const root = h('div', { class: `segmented ${cls}`, role: 'radiogroup', 'aria-label': label });
  const buttons = new Map();
  for (const o of options) {
    const b = h('button', {
      type: 'button', role: 'radio', class: 'seg-btn', dataset: undefined, 'data-value': o.value,
      disabled: !!o.disabled,
      onClick: () => { if (o.disabled) return; set(o.value); onChange && onChange(o.value); },
    }, o.label);
    buttons.set(o.value, b);
    root.append(b);
  }
  function set(v) {
    current = v;
    for (const [val, b] of buttons) {
      const on = val === v;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    }
  }
  set(current);
  root.set = set;
  Object.defineProperty(root, 'value', { get: () => current });
  return root;
}

// ---- Sheets and dialogs ----

// A bottom sheet over the screen. build(sheetEl, close) fills it. Returns { close }.
export function openSheet({ title, build, onClose, label }) {
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label || title || 'Dialog' });
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    onClose && onClose(result);
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
  if (title) sheet.append(h('h2', { class: 'sheet-title' }, title));
  build(sheet, close);
  backdrop.append(sheet);
  document.body.append(backdrop);
  return { close, el: sheet };
}

// actions: [{ label, value, kind: 'primary' | 'danger' | 'plain' }]. Resolves with the chosen value (null if dismissed).
export function confirmSheet({ title, text, actions }) {
  return new Promise((resolve) => {
    openSheet({
      title,
      onClose: (r) => resolve(r ?? null),
      build(sheet, close) {
        if (text) sheet.append(h('p', { class: 'sheet-text' }, text));
        const row = h('div', { class: 'sheet-actions' });
        for (const a of actions) {
          row.append(h('button', {
            type: 'button', class: `btn ${a.kind || 'plain'}`, 'data-action': a.value,
            onClick: () => close(a.value),
          }, a.label));
        }
        sheet.append(row);
      },
    });
  });
}

// ---- Formatting ----

export function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const pct = (v, digits = 0) => (v == null || Number.isNaN(v) ? '—' : `${v.toFixed(digits)}%`);
