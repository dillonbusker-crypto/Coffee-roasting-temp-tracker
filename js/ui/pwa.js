// Service worker registration and the "Update ready" notice.
//
//   registerServiceWorker(app)   -> sets app.pwa; call once at boot
//   updateNotice(app)            -> { el, dispose } a card for Setup and History; hidden until an update is waiting
//   app.pwa = { state, version(), applyUpdate(), subscribe(fn) }
//     state: 'off' | 'installing' | 'ready' | 'update'
//
// A new worker installs in the background and then waits. It takes over only after the user
// taps Reload on Setup or History, and never while a roast is running, so the cache is never
// swapped under a roast. The worker does not call skipWaiting() by itself.

import { h } from './dom.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function swEnabled(loc = location, nav = navigator) {
  if (!nav || !('serviceWorker' in nav)) return false;
  if (LOCAL_HOSTS.has(loc.hostname) && new URLSearchParams(loc.search).has('nosw')) return false;
  return true;
}

export function registerServiceWorker(app) {
  const listeners = new Set();
  const pwa = {
    state: 'off',
    registration: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    version: () => Promise.resolve(null),
    applyUpdate: () => false,
  };
  app.pwa = pwa;
  if (!swEnabled()) return pwa;

  const set = (state) => { if (pwa.state !== state) { pwa.state = state; listeners.forEach((fn) => fn(state)); } };
  const rolling = () => !!app.controller && app.controller.phase === 'running';
  let userAsked = false;

  pwa.applyUpdate = () => {
    const waiting = pwa.registration && pwa.registration.waiting;
    if (!waiting || rolling()) return false;
    userAsked = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
    return true;
  };

  pwa.version = () => new Promise((resolve) => {
    const worker = pwa.registration && (pwa.registration.active || navigator.serviceWorker.controller);
    if (!worker) { resolve(null); return; }
    const chan = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1500);
    chan.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data || null); };
    worker.postMessage({ type: 'GET_VERSION' }, [chan.port2]);
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userAsked && !rolling()) location.reload();
  });

  const watch = (reg) => {
    const worker = reg.installing;
    if (!worker) return;
    set('installing');
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') set(navigator.serviceWorker.controller ? 'update' : 'ready');
      else if (worker.state === 'activated' && pwa.state === 'installing') set('ready');
      else if (worker.state === 'redundant' && pwa.state === 'installing') set(reg.active ? 'ready' : 'off');
    });
  };

  navigator.serviceWorker.register('sw.js').then((reg) => {
    pwa.registration = reg;
    if (reg.waiting && navigator.serviceWorker.controller) set('update');
    else if (reg.active) set('ready');
    else watch(reg);
    reg.addEventListener('updatefound', () => watch(reg));
    // Look for a new version when the app comes back to the front.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
    reg.update().catch(() => {});
  }).catch((err) => {
    console.warn('Service worker registration failed', err);
  });

  return pwa;
}

export function updateNotice(app) {
  const reload = h('button', { type: 'button', class: 'btn primary', id: 'update-reload', onClick: () => { reload.disabled = true; if (!app.pwa.applyUpdate()) reload.disabled = false; } }, 'Reload');
  const el = h('section', { class: 'card draft-card update-card', id: 'update-card', hidden: true },
    h('h2', null, 'Update ready'),
    h('p', null, 'A new version of Roast Tracker has been downloaded. Reload to use it. Your roasts and settings are kept.'),
    reload);
  const sync = () => { el.hidden = !(app.pwa && app.pwa.state === 'update'); };
  const off = app.pwa ? app.pwa.subscribe(sync) : () => {};
  sync();
  return { el, dispose: off };
}
