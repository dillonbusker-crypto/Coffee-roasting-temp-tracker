// App shell: hash router, shared services, and the roast lifecycle.
//
//   #setup  #roast  #after   the roast flow
//   #history  #history/<id>   saved roasts, and one roast's detail
//   #settings                 targets, thresholds, units, backup
//
// A route may carry one path parameter (#history/<id>); the mount function gets it as its third argument.
//
// Test-only URL parameters (never shown in the UI):
//   ?speed=60   demo clock speed multiplier        ?undo=800   Undo window in ms
//   ?draft=1500 draft write interval in ms
//   ?nosw       do not register the service worker (only honoured on localhost)

import { loadSettings } from './core/settings.js';
import { createRoastController } from './ui/roast-controller.js';
import { createSpeech } from './ui/speech.js';
import { createWakeLock } from './ui/wakelock.js';
import { referenceFromRecord } from './ui/chart-model.js';
import { saveDraft, clearDraft } from './ui/draft.js';
import { mountSetup } from './ui/setup.js';
import { defaultSourceId } from './ui/sources.js';
import { mountRoast } from './ui/roast-screen.js';
import { mountAfter } from './ui/after.js';
import { mountHistory } from './ui/history.js';
import { mountDetail } from './ui/detail.js';
import { mountSettings } from './ui/settings-screen.js';
import { registerServiceWorker } from './ui/pwa.js';
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
    sourceId: defaultSourceId(),   // Camera when this page can open one, else Demo
    preset: 'on-target',
    speed: 1,
    coffee: '',
    greenWeightG: settings.greenWeightG,
    devTargetSec: settings.devTargetSec,
    heat: settings.startHeat,
    fan: settings.startFan,
    manualValue: null,
  },
  pwa: null,               // service worker state, set by registerServiceWorker below
  go, beginRoast, openDraft, finishRoastSession,
  refreshSettings, replaceSettings, settingsChanged,
};

// ---- Settings ----
// app.settings is one object for the life of the page: screens and the roast lifecycle hold
// on to it, so changes are made in place rather than by swapping in a new object.

// Settings that Setup copies into its form as starting values.
const SETUP_DEFAULTS = { greenWeightG: 'greenWeightG', devTargetSec: 'devTargetSec', startHeat: 'heat', startFan: 'fan' };

function replaceSettings(next) {
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, JSON.parse(JSON.stringify(next)));
}

// Re-read localStorage (after an import, which writes settings behind the screen's back).
function refreshSettings() {
  replaceSettings(loadSettings());
  settingsChanged();
}

// Called after a setting changed. A changed default shows on Setup without a reload;
// with no keys given, every default is copied.
function settingsChanged(keys) {
  const which = keys && keys.length ? keys : Object.keys(SETUP_DEFAULTS);
  for (const k of which) if (SETUP_DEFAULTS[k]) app.setup[SETUP_DEFAULTS[k]] = settings[k];
}

// ---- Routing ----

// Each mount function takes (root, app, param) and returns an unmount function.
export const ROUTES = {
  setup: mountSetup,
  roast: mountRoast,
  after: mountAfter,
  history: (root, app, id) => (id ? mountDetail(root, app, id) : mountHistory(root, app)),
  settings: mountSettings,
};

const root = document.getElementById('app');
let unmount = null;

function route() {
  const [asked = 'setup', ...rest] = ((location.hash || '#setup').slice(1).split('?')[0] || 'setup').split('/');
  let param = null;
  try { param = rest.length ? decodeURIComponent(rest.join('/')) : null; } catch { param = null; }
  let target = asked in ROUTES ? asked : 'setup';
  const running = !!app.controller && app.controller.phase === 'running';
  if (running) target = 'roast';                       // a roast in progress owns the screen
  else if (target === 'roast') target = 'setup';
  if (target === 'after' && !app.record) target = 'setup';
  if (target !== asked) { history.replaceState(null, '', `#${target}`); param = null; }
  if (unmount) { try { unmount(); } catch (e) { console.warn(e); } unmount = null; }
  clear(root);
  window.scrollTo(0, 0);
  document.body.dataset.screen = target;
  unmount = ROUTES[target](root, app, param) || null;
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

registerServiceWorker(app);
route();
