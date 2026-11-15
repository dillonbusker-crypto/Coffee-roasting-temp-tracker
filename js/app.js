// App shell: hash router, shared services, and the roast lifecycle.
//
//   #setup  #roast  #after   the roast flow
//   #history #settings        stubs until their screens exist (register them in ROUTES)
//
// Test-only URL parameters (never shown in the UI):
//   ?speed=60   demo clock speed multiplier        ?undo=800   Undo window in ms
//   ?draft=1500 draft write interval in ms

import { loadSettings } from './core/settings.js';
import { createRoastController } from './ui/roast-controller.js';
import { createSpeech } from './ui/speech.js';
import { createWakeLock } from './ui/wakelock.js';
import { referenceFromRecord } from './ui/chart-model.js';
import { saveDraft, clearDraft } from './ui/draft.js';
import { mountSetup } from './ui/setup.js';
import { mountRoast } from './ui/roast-screen.js';
import { mountAfter } from './ui/after.js';
import { h, clear } from './ui/dom.js';

const params = new URLSearchParams(location.search);
const num = (k) => { const v = Number(params.get(k)); return Number.isFinite(v) && v > 0 ? v : null; };
const test = { speed: num('speed'), undoMs: num('undo'), draftMs: num('draft') };

const settings = loadSettings();

const app = {
  settings,
  test,
  speech: createSpeech(),
  wake: createWakeLock(),
  controller: null,        // the roast in progress
  roastInfo: null,         // what the Roast screen needs besides the controller
  record: null,            // a finished roast waiting on the After screen
  activeChart: null,       // the chart on screen (test hook)
  setup: {
    sourceId: 'demo',
    preset: 'on-target',
    speed: 1,
    coffee: '',
    greenWeightG: settings.greenWeightG,
    devTargetSec: settings.devTargetSec,
    heat: settings.startHeat,
    fan: settings.startFan,
    manualValue: null,
  },
  go, beginRoast, openDraft, finishRoastSession,
};

// ---- Routing ----

function stub(title) {
  return (root) => {
    root.append(h('div', { class: 'screen stub' },
      h('header', { class: 'topbar' }, h('h1', null, title)),
      h('section', { class: 'card' },
        h('h2', null, 'Coming soon'),
        h('p', { class: 'muted' }, `${title} is not built yet. Your roasts are saved on this phone.`)),
      h('div', { class: 'stub-actions' },
        h('a', { class: 'btn primary', href: '#setup', id: 'stub-back' }, 'Back'))));
    return () => {};
  };
}

// Other agents replace these entries (History list and detail, Settings).
export const ROUTES = {
  setup: mountSetup,
  roast: mountRoast,
  after: mountAfter,
  history: stub('History'),
  settings: stub('Settings'),
};

const root = document.getElementById('app');
let unmount = null;

function route() {
  const asked = (location.hash || '#setup').slice(1).split('?')[0] || 'setup';
  let target = asked in ROUTES ? asked : 'setup';
  const running = !!app.controller && app.controller.phase === 'running';
  if (running) target = 'roast';                       // a roast in progress owns the screen
  else if (target === 'roast') target = 'setup';
  if (target === 'after' && !app.record) target = 'setup';
  if (target !== asked) history.replaceState(null, '', `#${target}`);
  if (unmount) { try { unmount(); } catch (e) { console.warn(e); } unmount = null; }
  clear(root);
  window.scrollTo(0, 0);
  document.body.dataset.screen = target;
  unmount = ROUTES[target](root, app) || null;
}

function go(name) {
  if (location.hash === `#${name}`) route();
  else location.hash = name;
}

window.addEventListener('hashchange', route);

// ---- Roast lifecycle ----

function finishRoastSession() {
  app.controller = null;
  app.roastInfo = null;
  app.wake.release();
  app.speech.stop();
}

async function beginRoast(o) {
  const entry = o.entry;
  const roastSettings = { ...settings, devTargetSec: o.devTargetSec };
  const speed = entry.id === 'demo' ? (test.speed || entry.roastSpeed({ state: o.state })) : 1;
  const controller = createRoastController({
    source: o.source,
    settings: roastSettings,
    coffee: o.coffee,
    greenWeightG: o.greenWeightG,
    heat: o.heat,
    fan: o.fan,
    mode: o.reference ? 'reference' : 'starter',
    reference: o.reference || null,
    speed,
    speech: app.speech,
    saveDraft,
    undoMs: test.undoMs ?? 5000,
    draftMs: test.draftMs ?? 10000,
    initialReading: o.initialReading ?? null,
  });
  app.controller = controller;
  app.roastInfo = {
    label: entry.describe({ state: o.state, speed }),
    entry,
    referenceName: o.reference ? o.reference.coffee : null,
    referenceSeries: o.reference ? referenceFromRecord(o.reference, settings) : null,
  };
  controller.onDone((record) => {
    app.record = record;
    finishRoastSession();
    go('after');
  });
  try {
    await controller.start();
  } catch (err) {
    finishRoastSession();
    throw err;
  }
  go('roast');
}

// Interrupted-roast recovery: the draft record goes straight to the After screen.
function openDraft(record) {
  app.record = record;
  go('after');
}

window.addEventListener('beforeunload', (e) => {
  if (app.controller && app.controller.phase === 'running') { e.preventDefault(); e.returnValue = ''; }
});

// Debug and test hooks.
window.__rt = {
  app,
  snapshot: () => (app.controller ? app.controller.snapshot() : null),
  view: () => (app.controller ? app.controller.view() : null),
  chartModel: () => (app.activeChart ? app.activeChart.lastModel : null),
  speechLog: () => app.speech.log,
  clearDraft,
};

route();
