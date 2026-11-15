// Settings (#settings). Every target and threshold in DEFAULTS is editable here.
//
// Each change is checked (range, and a few cross-checks such as "window start before window
// end"), saved to localStorage straight away, and applies to the next roast. A value that
// fails its check shows a plain error line under the field and is not saved.
//
// Settings are stored in °F (temperatures, temperature differences) and °F per minute (rates).
// With units set to °C the screen shows and accepts °C and converts: absolute temperatures
// with the 32° offset, differences and rates by 5/9 alone. The stored value is always °F.

import { h, segmented, setText, confirmSheet } from './dom.js';
import { CUE_LABELS, ROR_WINDOW_OPTIONS, saveSettings, resetSettings } from '../core/settings.js';
import { fToC, cToF, formatClock } from '../core/units.js';
import { parseClockText } from './control-log-editor.js';
import { switchRow, createToast } from './controls.js';
import { createBackupActions } from './backup.js';

// ---- Conversion and formatting (pure; exported for tests) ----

const round2 = (v) => Math.round(v * 100) / 100;
const trim1 = (v) => String(Number(v.toFixed(1)));

// Stored value (°F, °F/min, s, %, g) -> number in the display unit.
export function toDisplay(kind, v, units) {
  if (units === 'C') {
    if (kind === 'temp') return fToC(v);
    if (kind === 'delta' || kind === 'rate') return v * 5 / 9;
  }
  return v;
}

// Number typed in the display unit -> stored value.
export function fromDisplay(kind, d, units) {
  if (units === 'C') {
    if (kind === 'temp') return round2(cToF(d));
    if (kind === 'delta' || kind === 'rate') return round2(d * 9 / 5);
  }
  return round2(d);
}

export function unitSuffix(kind, units) {
  const deg = units === 'C' ? '°C' : '°F';
  switch (kind) {
    case 'temp': case 'delta': return deg;
    case 'rate': return `${deg} per minute`;
    case 'clock': return 'm:ss';
    case 'sec': return 's';
    case 'pct': return '%';
    case 'g': return 'g';
    default: return '';
  }
}

export function formatValue(kind, v, units) {
  if (kind === 'clock') return formatClock(v);
  return trim1(toDisplay(kind, v, units));
}

// Text typed by the user -> { ok, value } with the stored value, or { ok: false, error }.
export function parseValue(kind, text, units) {
  const s = String(text ?? '').trim();
  if (kind === 'clock') {
    const t = parseClockText(s);
    return t == null ? { ok: false, error: 'Type a time like 5:30, minutes and seconds.' } : { ok: true, value: t };
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s.replace(',', '.'))) return { ok: false, error: 'Type a number.' };
  const n = Number(s.replace(',', '.'));
  if (kind === 'sec' && !Number.isInteger(n)) return { ok: false, error: 'Type whole seconds.' };
  return { ok: true, value: fromDisplay(kind, n, units) };
}

// ---- Field definitions ----
// min and max are stored values (or functions of the settings). step is in the display unit.

const STEP = { temp: [5, 5], delta: [1, 0.5], rate: [1, 0.5], clock: [5, 5], sec: [1, 1], pct: [0.5, 0.5], g: [5, 5] };

const f = (key, label, kind, min, max, extra = {}) => ({ key, label, kind, min, max, ...extra });

export const GROUPS = {
  targets: [
    f('greenWeightG', 'Default green weight', 'g', 1, 1000, { hint: 'Setup starts with this weight.' }),
    f('devTargetSec', 'Development target', 'sec', (s) => s.devMinSec, (s) => s.devMaxSec, { step: [5, 5], hint: 'Seconds from first crack to Drop. Setup starts with this.' }),
    f('expectedFcF', 'Expected first-crack reading', 'temp', 200, 520, { hint: 'Used until a reference roast gives a real one.' }),
    f('fcWindowStartSec', 'First-crack window starts', 'clock', 60, 900, {
      hint: 'Time after Start.', check: (v, s) => (v > s.fcWindowEndSec ? 'Must not be later than the end of the window.' : null),
    }),
    f('fcWindowEndSec', 'First-crack window ends', 'clock', 60, 900, {
      hint: 'Time after Start.', check: (v, s) => (v < s.fcWindowStartSec ? 'Must not be earlier than the start of the window.' : null),
    }),
    f('paceEarlySec', 'Running hot if first crack is projected before', 'clock', 60, 900, {
      check: (v, s) => (v >= s.paceLateSec ? 'Must be earlier than the running-slow limit.' : null),
    }),
    f('paceLateSec', 'Running slow if first crack is projected after', 'clock', 60, 1200, {
      check: (v, s) => (v <= s.paceEarlySec ? 'Must be later than the running-hot limit.' : null),
    }),
    f('totalTargetSec', 'Total roast time', 'clock', 180, 1200),
    f('endTempCapF', 'End temperature cap above first crack', 'delta', 0, 100, { hint: 'The drop warning fires at the first-crack reading plus this.' }),
    f('weightLossMinPct', 'Weight loss band, low', 'pct', 0, 40, {
      check: (v, s) => (v > s.weightLossMaxPct ? 'Must not be above the high end.' : null),
    }),
    f('weightLossMaxPct', 'Weight loss band, high', 'pct', 0, 40, {
      check: (v, s) => (v < s.weightLossMinPct ? 'Must not be below the low end.' : null),
    }),
    f('devMinSec', 'Shortest development allowed', 'sec', 10, 300, {
      check: (v, s) => (v > s.devTargetSec ? 'Must not be above the development target.' : null),
    }),
    f('devMaxSec', 'Longest development allowed', 'sec', 10, 300, {
      check: (v, s) => (v < s.devTargetSec ? 'Must not be below the development target.' : null),
    }),
  ],
  calc: [
    f('projectionLagSec', 'Pace projection looks back', 'sec', 15, 120, { step: [5, 5], hint: 'Compares the rate of rise now with this long ago.' }),
  ],
  thresholds: [
    f('stallRorFPerMin', 'Stall: rate of rise below', 'rate', 0, 60),
    f('climbRorFPerMin', 'Climbing: rate of rise above its recent low by', 'rate', 1, 60),
    f('climbAfterSec', 'Climbing check starts at', 'clock', 30, 600),
    f('climbLookbackSec', 'Climbing: recent low looks back', 'sec', 15, 300, { step: [5, 5] }),
    f('climbHoldoffSec', 'Climbing: wait after you raise the heat', 'sec', 0, 300, { step: [5, 5] }),
    f('fcSoonF', 'First crack soon: within', 'delta', 2, 60),
    f('referenceBandF', 'Reference band: off the reference by', 'delta', 2, 60),
    f('persistSec', 'Hold time before a pace cue', 'sec', 3, 60),
    f('correctiveCooldownSec', 'Gap between corrective cues', 'sec', 5, 180, { step: [5, 5] }),
    f('sameCueRepeatSec', 'Same cue can repeat after', 'sec', 10, 600, { step: [5, 5] }),
    f('replayUndoWindowSec', 'Skip a replay that undoes a cue from the last', 'sec', 0, 180, { step: [5, 5] }),
    f('lostSec', 'Lost reading after', 'sec', 2, 60),
  ],
  reader: [
    f('reader.minF', 'Accepted range, lowest reading', 'temp', 14, 400, {
      check: (v, s) => (v >= s.reader.maxF ? 'Must be below the highest reading.' : null),
    }),
    f('reader.maxF', 'Accepted range, highest reading', 'temp', 200, 572, {
      check: (v, s) => (v <= s.reader.minF ? 'Must be above the lowest reading.' : null),
    }),
    f('reader.maxJumpF', 'Jump limit between readings', 'delta', 3, 100, { hint: 'A reading that jumps further than this is rejected.' }),
  ],
};

const getPath = (obj, path) => path.split('.').reduce((o, k) => o[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}
const idOf = (key) => key.replace(/\./g, '-');
const lim = (x, s) => (typeof x === 'function' ? x(s) : x);

// ---- The screen ----

export function mountSettings(root, app) {
  const settings = app.settings;
  const units = () => settings.units;
  const toast = createToast('Saved');
  const fields = [];       // { refresh() }
  let disposed = false;

  const status = h('p', { class: 'error-line', id: 'settings-error', role: 'alert' }, '');

  function persist(keys) {
    if (!saveSettings(settings)) {
      setText(status, 'Could not save: this browser is blocking storage. Changes last until you close the app.');
      return false;
    }
    setText(status, '');
    app.settingsChanged(keys);
    toast.show();
    return true;
  }

  function refreshAll(except = null) {
    for (const fld of fields) if (fld !== except) fld.refresh();
  }

  // ---- A number field with − and + ----

  function numberField(spec) {
    const id = `set-${idOf(spec.key)}`;
    let invalid = false;
    const kind = spec.kind;
    const stepOf = () => (spec.step || STEP[kind])[units() === 'C' ? 1 : 0];

    const label = h('label', { class: 'field-label', for: id }, '');
    const input = h('input', {
      id, class: 'field-input step-input', type: 'text', inputmode: kind === 'clock' ? 'text' : 'decimal',
      autocomplete: 'off', autocapitalize: 'off', enterkeyhint: 'done',
      onChange: () => commitText(),
      onKeydown: (e) => { if (e.key === 'Enter') input.blur(); },
    });
    const minus = h('button', { type: 'button', class: 'step-btn', id: `${id}-minus`, 'aria-label': `Decrease ${spec.label}`, onClick: () => nudge(-1) }, '−');
    const plus = h('button', { type: 'button', class: 'step-btn', id: `${id}-plus`, 'aria-label': `Increase ${spec.label}`, onClick: () => nudge(1) }, '+');
    const hint = h('p', { class: 'muted small set-hint', id: `${id}-hint` }, '');
    const error = h('p', { class: 'error-line', id: `err-${idOf(spec.key)}`, role: 'alert' }, '');
    const el = h('div', { class: 'set-field', id: `field-${idOf(spec.key)}` }, label, h('div', { class: 'stepper' }, minus, input, plus), hint, error);

    const current = () => getPath(settings, spec.key);
    const range = () => [lim(spec.min, settings), lim(spec.max, settings)];

    function rangeText() {
      const [lo, hi] = range();
      const u = unitSuffix(kind, units());
      const a = formatValue(kind, lo, units());
      const b = formatValue(kind, hi, units());
      return kind === 'clock' ? `${a} to ${b}` : `${a} to ${b} ${u}`.trim();
    }

    function refresh() {
      setText(label, `${spec.label} (${unitSuffix(kind, units())})`);
      input.value = formatValue(kind, current(), units());
      setText(hint, `${spec.hint ? `${spec.hint} ` : ''}Allowed: ${rangeText()}.`);
      const [lo, hi] = range();
      minus.disabled = current() <= lo + 0.005;
      plus.disabled = current() >= hi - 0.005;
      setError('');
    }

    function setError(msg) {
      invalid = !!msg;
      setText(error, msg);
      input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
      input.classList.toggle('invalid', invalid);
    }

    function tryCommit(value) {
      const [lo, hi] = range();
      if (value < lo - 0.005 || value > hi + 0.005) {
        setError(`Enter ${kind === 'clock' ? 'a time' : 'a value'} from ${rangeText()}.`);
        return false;
      }
      const problem = spec.check ? spec.check(value, settings) : null;
      if (problem) { setError(problem); return false; }
      setPath(settings, spec.key, value);
      setError('');
      if (persist([spec.key])) { refresh(); refreshAll(fld); }
      return true;
    }

    function commitText() {
      const parsed = parseValue(kind, input.value, units());
      if (!parsed.ok) { setError(parsed.error); return; }
      tryCommit(parsed.value);
    }

    function nudge(dir) {
      const shown = Number(toDisplay(kind, current(), units()).toFixed(kind === 'clock' || kind === 'sec' ? 0 : 1));
      const [lo, hi] = range();
      let value = fromDisplay(kind, shown + dir * stepOf(), units());
      value = Math.max(lo, Math.min(hi, value));
      tryCommit(value);
    }

    const fld = { refresh };
    fields.push(fld);
    refresh();
    return el;
  }

  // ---- Group frame ----

  function group({ id, title, sub, open = false }, ...children) {
    return h('details', { class: 'card group', id: `group-${id}`, open },
      h('summary', { class: 'group-sum' },
        h('span', null, h('b', null, title), sub ? h('small', null, sub) : null)),
      h('div', { class: 'group-body' }, ...children));
  }

  // ---- Units ----

  const unitSeg = segmented({
    label: 'Units', cls: 'two', value: settings.units,
    options: [{ value: 'F', label: '°F' }, { value: 'C', label: '°C' }],
    onChange: (v) => {
      settings.units = v;
      if (persist(['units'])) refreshAll();
    },
  });
  unitSeg.id = 'units-seg';

  // ---- Start heat and fan ----

  const heatBtns = [1, 2, 3, 4, 5, 6, 7].map((n) => h('button', {
    type: 'button', class: 'heat-btn', role: 'radio', 'data-heat': n,
    onClick: () => { settings.startHeat = n; if (persist(['startHeat'])) renderHeat(); },
  }, String(n)));
  function renderHeat() {
    for (const b of heatBtns) {
      const on = Number(b.dataset.heat) === settings.startHeat;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    }
  }
  renderHeat();
  const fanSeg = segmented({
    label: 'Starting fan', cls: 'two', value: settings.startFan,
    options: [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }],
    onChange: (v) => { settings.startFan = v; persist(['startFan']); },
  });
  fanSeg.id = 'start-fan-seg';

  // ---- Rate-of-rise window ----

  const rorSeg = segmented({
    label: 'Rate-of-rise window', cls: 'three', value: settings.rorWindowSec,
    options: ROR_WINDOW_OPTIONS.map((n) => ({ value: n, label: `${n} s` })),
    onChange: (v) => { settings.rorWindowSec = v; persist(['rorWindowSec']); },
  });
  rorSeg.id = 'ror-seg';

  // ---- Cue switches ----

  const spoken = (id) => !settings.mute[id];
  const cueRows = Object.entries(CUE_LABELS).map(([id, name]) => {
    const row = switchRow({
      id: `cue-${id}`, title: name, on: spoken(id), hint: spoken(id) ? 'Spoken' : 'Muted',
      onChange: (on) => {
        settings.mute[id] = !on;
        row.setHint(on ? 'Spoken' : 'Muted');
        persist([`mute.${id}`]);
      },
    });
    row.dataset.cue = id;
    return row;
  });
  const fanPrompt = switchRow({
    id: 'fan-prompt', title: 'Fan prompt', on: settings.fanPrompt,
    hint: 'Say “Fan to Low” along with “First crack soon”.',
    onChange: (on) => { settings.fanPrompt = on; persist(['fanPrompt']); },
  });

  // ---- Data and about ----

  const backup = createBackupActions(app, { onImported: () => syncAll() });
  const about = h('p', { class: 'muted small', id: 'about-version' }, 'Checking the installed version…');
  const resetMsg = h('p', { class: 'muted small', id: 'reset-msg', role: 'status' }, '');

  async function onReset() {
    const choice = await confirmSheet({
      title: 'Reset all settings?',
      text: 'Every setting goes back to its default. Your saved roasts are not touched.',
      actions: [
        { label: 'Reset settings', value: 'reset', kind: 'danger' },
        { label: 'Keep my settings', value: 'keep', kind: 'plain' },
      ],
    });
    if (choice !== 'reset') return;
    app.replaceSettings(resetSettings());
    app.settingsChanged();
    syncAll();
    setText(resetMsg, 'Settings are back to their defaults.');
    toast.show('Reset');
  }

  // Redraws every control from the current settings (after Reset or Import).
  function syncAll() {
    unitSeg.set(settings.units);
    renderHeat();
    fanSeg.set(settings.startFan);
    rorSeg.set(settings.rorWindowSec);
    cueRows.forEach((r) => { const id = r.dataset.cue; r.set(spoken(id)); r.setHint(spoken(id) ? 'Spoken' : 'Muted'); });
    fanPrompt.set(settings.fanPrompt);
    refreshAll();
  }

  function showVersion() {
    app.pwa.version().then((v) => {
      if (disposed) return;
      const where = { off: 'Not installed on this page', installing: 'Installing…', ready: 'Works offline', update: 'Works offline, update ready' }[app.pwa.state] || '';
      setText(about, v
        ? `Version ${v.version}. Cache ${v.cache}. ${where}.`
        : 'No offline copy on this page, so there is no version to show. The app still works while you are online.');
    });
  }

  const list = (specs) => specs.map(numberField);

  root.append(h('div', { class: 'screen settings' },
    h('header', { class: 'topbar' },
      h('h1', null, 'Settings'),
      h('nav', { class: 'topnav' },
        h('a', { class: 'navlink', href: '#setup', id: 'nav-setup' }, 'Setup'),
        h('a', { class: 'navlink', href: '#history', id: 'nav-history' }, 'History'))),
    h('p', { class: 'muted small', id: 'settings-intro' }, 'Changes save as you make them and apply to the next roast.'),
    status,
    h('section', { class: 'card', id: 'units-card' },
      h('h2', null, 'Units'),
      unitSeg,
      h('p', { class: 'muted small' }, 'Temperatures are stored in °F. This only changes what you see and type.')),

    group({ id: 'targets', title: 'Roast targets', sub: 'Setup defaults, first crack, pace, weight loss', open: true },
      h('h3', null, 'Starting settings'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Starting heat'), h('div', { class: 'heat-pick', role: 'radiogroup', 'aria-label': 'Starting heat' }, ...heatBtns)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Starting fan'), fanSeg),
      ...list(GROUPS.targets)),

    group({ id: 'calc', title: 'Calculations', sub: 'Rate of rise and projection' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Rate-of-rise window'), rorSeg,
        h('p', { class: 'muted small set-hint' }, 'The slope is fitted over this many seconds. A shorter window reacts faster and jumps more.')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Smoothing window'),
        h('div', { class: 'readonly-row', id: 'smooth-readonly' }, `${settings.smoothSec} s`),
        h('p', { class: 'muted small set-hint' }, 'Fixed. The displayed temperature is the average of the last 10 seconds.')),
      ...list(GROUPS.calc)),

    group({ id: 'cues', title: 'Cues', sub: 'Which cues speak, and when they fire' },
      h('h3', null, 'Spoken cues'),
      h('p', { class: 'muted small' }, 'Switch a cue off to mute it. A muted cue is still logged.'),
      ...cueRows, fanPrompt,
      h('h3', { style: 'margin-top:18px' }, 'Cue thresholds'),
      ...list(GROUPS.thresholds)),

    group({ id: 'reader', title: 'Reader', sub: 'What readings the app accepts' },
      ...list(GROUPS.reader)),

    group({ id: 'data', title: 'Data and about', sub: 'Backup, reset, version' },
      h('h3', null, 'Backup'),
      h('p', { class: 'muted small' }, 'Export all saves every roast and these settings in one file. Import restores them.'),
      backup.el,
      h('h3', { style: 'margin-top:18px' }, 'Reset'),
      h('button', { type: 'button', class: 'btn danger', id: 'reset-settings', onClick: onReset, style: 'width:100%' }, 'Reset to defaults'),
      resetMsg,
      h('h3', { style: 'margin-top:18px' }, 'About'),
      h('a', { class: 'btn', href: 'reader-test.html', id: 'reader-test-link', style: 'width:100%' }, 'Digit reader test page'),
      about)));

  showVersion();
  const offState = app.pwa.subscribe(showVersion);

  return function unmount() {
    disposed = true;
    offState();
    toast.dispose();
  };
}
