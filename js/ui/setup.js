// Setup screen: pick the temperature source, confirm good readings, fill in the roast, Start.

import { h, clear, segmented, setText, confirmSheet, fmtDate, fmtDateTime } from './dom.js';
import { listSources, getSource } from './sources.js';
import { listRoasts, findReference, normalizeName } from '../store/db.js';
import { referenceTargets } from '../core/session.js';
import { formatTemp, formatClock } from '../core/units.js';
import { loadDraft, clearDraft } from './draft.js';
import { updateNotice } from './pwa.js';

const DEBOUNCE_MS = 150;

export function mountSetup(root, app) {
  const S = app.setup;               // form state, kept between visits
  const settings = app.settings;
  const units = settings.units;
  const minF = settings.reader?.minF ?? 50;
  const maxF = settings.reader?.maxF ?? 550;

  let source = null;                 // the preview source for the selected entry
  let panelCleanup = null;           // what the selected entry's setup panel returned
  let handedOff = false;
  let good = 0;
  let reading = { value: null, status: 'none' };
  let pollTimer = null;
  let refTimer = null;
  let refSeq = 0;
  let reference = null;              // the record Reference mode will use, or null
  let referenceFor = null;           // the coffee name `reference` was looked up for
  let starting = false;
  let disposed = false;

  const ctx = {
    state: S,
    units,
    settings,
    getSource: () => source,
    changed: () => { rebuildSource(); },
    enterReading(f) {
      if (!source || !source.enter) return { ok: false, reason: 'not a number' };
      const res = source.enter(f);
      if (res.ok) { S.manualValue = res.value; poll(); }
      return res;
    },
  };

  // ---- Elements ----

  const el = {};
  el.draft = h('section', { class: 'card draft-card', hidden: true, id: 'draft-card' });
  el.sourceSeg = segmented({
    label: 'Temperature source', cls: 'three', value: S.sourceId,
    options: listSources().map((e) => ({ value: e.id, label: e.label })),
    onChange: (id) => selectSource(id),
  });
  el.sourceSeg.id = 'source-seg';
  el.panel = h('div', { class: 'source-panel', id: 'source-panel' });
  el.readValue = h('div', { class: 'read-value', id: 'read-value' }, '—');
  el.readState = h('div', { class: 'read-state', id: 'read-state' }, '');
  el.readCard = h('div', { class: 'reading' },
    h('div', null, h('div', { class: 'field-label' }, 'Reading now'), el.readValue),
    el.readState);

  el.coffee = h('input', {
    id: 'coffee', class: 'field-input', type: 'text', autocomplete: 'off', autocapitalize: 'words',
    placeholder: 'For example, Ethiopia Guji', list: 'coffee-names', value: S.coffee, 'aria-label': 'Coffee name',
    onInput: (e) => { S.coffee = e.target.value; scheduleRef(); updateStart(); },
  });
  el.names = h('datalist', { id: 'coffee-names' });
  el.mode = h('div', { class: 'mode-line', id: 'mode-line', 'data-mode': 'starter' }, 'Starter guardrails');
  el.weight = h('input', {
    id: 'green-weight', class: 'field-input', type: 'number', inputmode: 'decimal', min: '1', step: '0.1',
    value: String(S.greenWeightG), 'aria-label': 'Green weight in grams',
    onInput: (e) => { S.greenWeightG = parseFloat(e.target.value); updateStart(); },
  });
  el.devValue = h('div', { class: 'step-value', id: 'dev-value' }, '');
  el.devNote = h('div', { class: 'muted small', id: 'dev-note' }, '');
  el.devMinus = h('button', { type: 'button', class: 'step-btn', id: 'dev-minus', 'aria-label': 'Shorter development', onClick: () => stepDev(-1) }, '−');
  el.devPlus = h('button', { type: 'button', class: 'step-btn', id: 'dev-plus', 'aria-label': 'Longer development', onClick: () => stepDev(1) }, '+');
  el.heat = h('div', { class: 'heat-pick', role: 'radiogroup', 'aria-label': 'Starting heat' },
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => h('button', {
      type: 'button', class: 'heat-btn', role: 'radio', 'data-heat': n,
      onClick: () => { S.heat = n; renderHeat(); },
    }, String(n))));
  el.fan = segmented({
    label: 'Fan', cls: 'two', value: S.fan,
    options: [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }],
    onChange: (v) => { S.fan = v; },
  });
  el.fan.id = 'fan-seg';
  el.reason = h('p', { class: 'start-reason', id: 'start-reason', 'aria-live': 'polite' }, '');
  el.start = h('button', { type: 'button', class: 'btn primary start-btn', id: 'start-btn', onClick: onStart }, 'Start roast');
  el.error = h('p', { class: 'error-line', id: 'start-error', role: 'alert' }, '');

  const notice = updateNotice(app);

  const wakeWarn = app.wake.supported ? null : h('div', { class: 'card warn-card', id: 'wake-warning' },
    h('strong', null, 'This browser can’t keep the screen awake.'),
    h('p', null, 'Turn Auto-Lock off in Settings, Display & Brightness before the roast, or the phone may lock mid-roast.'));

  root.append(
    h('div', { class: 'screen setup' },
      h('header', { class: 'topbar' },
        h('h1', null, 'Roast Tracker'),
        h('nav', { class: 'topnav' },
          h('a', { class: 'navlink', href: '#history', id: 'nav-history' }, 'History'),
          h('a', { class: 'navlink', href: '#settings', id: 'nav-settings' }, 'Settings'))),
      notice.el,
      el.draft,
      h('section', { class: 'card' },
        h('h2', null, 'Temperature source'),
        el.sourceSeg, el.panel, el.readCard),
      h('section', { class: 'card' },
        h('h2', null, 'This roast'),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Coffee name'), el.coffee, el.names),
        el.mode,
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Green weight (g)'), el.weight),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, 'Development target'),
          h('div', { class: 'stepper' }, el.devMinus, el.devValue, el.devPlus),
          el.devNote),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Starting heat'), el.heat),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Fan'), el.fan)),
      h('section', { class: 'card reminder', id: 'reminder' },
        h('h2', null, 'Before you start'),
        h('p', null, 'Set the thermometer’s alert temperature to its maximum, 572°F, so it doesn’t beep and flash during the roast.')),
      wakeWarn,
      h('div', { class: 'startbar' }, el.reason, el.error, el.start)));

  // ---- Source handling ----

  function entry() { return getSource(S.sourceId); }

  async function rebuildSource() {
    stopPreview();
    good = 0;
    reading = { value: null, status: 'none' };
    S.manualValue = null;   // every new preview source starts with nothing typed
    const e = entry();
    if (e && e.available !== false) {
      try {
        const next = e.createSource(ctx);
        source = next;
        await next.start();
      } catch (err) {
        source = null;
        setText(el.error, `Could not start the source: ${err.message || err}`);
      }
    }
    poll();
    schedulePoll();
  }

  function stopPreview() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (source && !handedOff) { try { source.stop && source.stop(); } catch { /* ignore */ } }
    source = null;
  }

  function mountPanel() {
    if (panelCleanup) { try { panelCleanup(); } catch { /* ignore */ } panelCleanup = null; }
    clear(el.panel);
    panelCleanup = entry().renderSetupPanel(el.panel, ctx) || null;
  }

  function selectSource(id) {
    S.sourceId = id;
    mountPanel();
    rebuildSource();
  }

  function schedulePoll() {
    clearInterval(pollTimer);
    const base = entry().pollMs || 1000;
    const ms = app.test.speed ? Math.max(50, Math.min(base, 1000 / app.test.speed)) : base;
    pollTimer = setInterval(poll, ms);
  }

  function poll() {
    if (disposed) return;
    const e = entry();
    if (source && e.available !== false) {
      let p;
      try { p = source.peek(); } catch { p = { value: null, status: 'none' }; }
      reading = p || { value: null, status: 'none' };
      const plausible = reading.status === 'ok' && reading.value != null && reading.value >= minF && reading.value <= maxF;
      good = plausible ? good + 1 : 0;
    } else {
      reading = { value: null, status: 'none' };
      good = 0;
    }
    renderReading();
    updateStart();
  }

  const needGood = () => entry().goodReadingsNeeded ?? 5;
  const isReady = () => entry().available !== false && good >= needGood();

  function renderReading() {
    const e = entry();
    const unavailable = e.available === false;
    el.readCard.hidden = unavailable;
    if (unavailable) return;
    setText(el.readValue, reading.value == null ? '—' : formatTemp(reading.value, units));
    const need = needGood();
    let text;
    let state;
    if (good >= need) { text = 'Ready'; state = 'ready'; }
    else if (reading.status === 'dashes') { text = 'Thermometer shows dashes'; state = 'wait'; }
    else if (need === 1) { text = 'Type the current reading'; state = 'wait'; }
    else { text = `Reading ${good} of ${need}`; state = 'wait'; }
    setText(el.readState, text);
    el.readState.dataset.state = state;
  }

  // ---- Form ----

  function stepDev(dir) {
    if (reference) return;
    const next = S.devTargetSec + dir * 5;
    S.devTargetSec = Math.max(settings.devMinSec, Math.min(settings.devMaxSec, next));
    renderDev();
  }

  function effectiveDev() {
    if (reference) {
      const t = referenceTargets(reference).devTargetSec;
      if (t != null) return t;
    }
    return S.devTargetSec;
  }

  function renderDev() {
    const fromRef = !!reference && referenceTargets(reference).devTargetSec != null;
    setText(el.devValue, `${effectiveDev()} s`);
    el.devMinus.disabled = fromRef || S.devTargetSec <= settings.devMinSec;
    el.devPlus.disabled = fromRef || S.devTargetSec >= settings.devMaxSec;
    setText(el.devNote, fromRef
      ? `From the reference roast. Allowed range when set by hand: ${settings.devMinSec} to ${settings.devMaxSec} s.`
      : `Allowed range ${settings.devMinSec} to ${settings.devMaxSec} s.`);
  }

  function renderHeat() {
    for (const b of el.heat.children) {
      const on = Number(b.dataset.heat) === S.heat;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    }
  }

  function scheduleRef() {
    clearTimeout(refTimer);
    refTimer = setTimeout(refreshReference, DEBOUNCE_MS);
  }

  async function refreshReference() {
    const seq = ++refSeq;
    const name = S.coffee;
    let ref = null;
    try { ref = await findReference(name); } catch { ref = null; }
    if (disposed || seq !== refSeq) return;
    reference = ref;
    referenceFor = name;
    if (ref) {
      const own = ref.reference?.coffee && normalizeName(ref.coffee) === normalizeName(name);
      setText(el.mode, own
        ? `Reference: ${ref.coffee}, ${fmtDate(ref.startedAt)}`
        : `Reference: general fallback, ${ref.coffee}, ${fmtDate(ref.startedAt)}`);
      el.mode.dataset.mode = 'reference';
    } else {
      setText(el.mode, 'Starter guardrails');
      el.mode.dataset.mode = 'starter';
    }
    renderDev();
  }

  function weightOk() { return Number.isFinite(S.greenWeightG) && S.greenWeightG > 0; }

  function updateStart() {
    const e = entry();
    let reason;
    let ok = false;
    if (starting) reason = 'Starting…';
    else if (e.available === false) reason = e.unavailableReason || 'This source is not available yet.';
    else if (!isReady()) {
      reason = needGood() === 1
        ? 'Type the current reading to start.'
        : `Waiting for ${needGood()} good readings: ${good} of ${needGood()}`;
    } else if (!weightOk()) reason = 'Enter the green weight.';
    else { reason = 'Ready to start. Tap Start when the beans go in.'; ok = true; }
    setText(el.reason, reason);
    el.reason.dataset.ready = ok ? 'true' : 'false';
    el.start.disabled = !ok;
  }

  // ---- Start ----

  async function onStart() {
    if (starting || el.start.disabled) return;
    // Audio and wake lock must be requested inside this tap.
    app.speech.unlock();
    app.wake.acquire();
    starting = true;
    setText(el.error, '');
    updateStart();
    try {
      const e = entry();
      let src = source;
      if (!e.keepAlive) {
        stopPreview();
        src = e.createSource(ctx);
      } else {
        handedOff = true;
        clearInterval(pollTimer);
      }
      // Use the freshest reference for this coffee name.
      if (referenceFor !== S.coffee) await refreshReference();
      await app.beginRoast({
        entry: e,
        source: src,
        coffee: S.coffee.trim() || 'Untitled',
        greenWeightG: S.greenWeightG,
        devTargetSec: S.devTargetSec,
        heat: S.heat,
        fan: S.fan,
        reference,
        initialReading: e.id === 'manual' ? S.manualValue ?? null : null,
        state: S,
      });
    } catch (err) {
      starting = false;
      handedOff = false;
      app.wake.release();
      setText(el.error, `Could not start: ${err && err.message ? err.message : err}`);
      await rebuildSource();
    }
  }

  // ---- Draft recovery ----

  async function showDraft() {
    const d = await loadDraft();
    if (!d || disposed) return;
    const rec = d.record;
    const secs = Math.max(0, (rec.readings || []).length - 1);
    clear(el.draft);
    el.draft.hidden = false;
    el.draft.append(
      h('h2', null, 'An interrupted roast was found'),
      h('p', null, `${rec.coffee || 'Untitled'}, started ${fmtDateTime(rec.startedAt)}. ${formatClock(secs)} of readings were logged.`),
      h('div', { class: 'row-2' },
        h('button', { type: 'button', class: 'btn primary', id: 'draft-save', onClick: () => app.openDraft(rec) }, 'Save as is'),
        h('button', {
          type: 'button', class: 'btn danger', id: 'draft-discard',
          onClick: async () => {
            const choice = await confirmSheet({
              title: 'Discard the interrupted roast?',
              text: 'Its readings will be deleted.',
              actions: [{ label: 'Discard roast', value: 'discard', kind: 'danger' }, { label: 'Keep it', value: 'keep', kind: 'plain' }],
            });
            if (choice === 'discard') { await clearDraft(); el.draft.hidden = true; }
          },
        }, 'Discard')));
  }

  async function fillNames() {
    try {
      const names = [...new Set((await listRoasts()).map((r) => r.coffee).filter(Boolean))];
      if (disposed) return;
      clear(el.names);
      for (const n of names) el.names.append(h('option', { value: n }));
    } catch { /* no history yet */ }
  }

  // ---- Boot ----
  renderHeat();
  renderDev();
  mountPanel();
  rebuildSource();
  refreshReference();
  fillNames();
  showDraft();
  updateStart();

  return function unmount() {
    disposed = true;
    notice.dispose();
    clearInterval(pollTimer);
    clearTimeout(refTimer);
    stopPreview();
    if (panelCleanup) { try { panelCleanup(); } catch { /* ignore */ } panelCleanup = null; }
  };
}
