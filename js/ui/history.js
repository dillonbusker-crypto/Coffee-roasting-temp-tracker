// History (#history): a backup reminder, then the saved roasts, newest first. Tap a row for
// the roast detail (#history/<id>).

import { h, clear, fmtDate } from './dom.js';
import { listRoasts } from '../store/db.js';
import { formatClock } from '../core/units.js';
import { referenceTags, lossBand, fmtDateAndTime } from './controls.js';
import { createBackupActions, getLastExport } from './backup.js';
import { updateNotice } from './pwa.js';

function stat(label, value, { flag = null, id } = {}) {
  return h('div', { class: 'stat', 'data-flag': flag, id },
    h('span', { class: 'stat-label' }, label),
    h('b', { class: 'stat-value' }, value));
}

export function roastRow(r, settings) {
  const fc = r.events?.firstCrack?.t;
  const dev = r.results?.devSec;
  const band = lossBand(r.weightLossPct, settings);
  const flagged = band.band === 'under' || band.band === 'over';
  const lossLabel = flagged ? `Loss · ${band.band}` : 'Loss';
  const lossValue = band.band === 'none' ? '—' : `${band.shown.toFixed(1)}%`;
  return h('a', { class: 'hist-row', href: `#history/${encodeURIComponent(r.id)}`, 'data-id': r.id },
    h('div', { class: 'hist-top' },
      h('b', { class: 'hist-coffee' }, r.coffee || 'Untitled'),
      h('span', { class: 'tags' }, ...referenceTags(r))),
    h('div', { class: 'muted small hist-date' }, fmtDateAndTime(r.startedAt)),
    h('div', { class: 'hist-stats' },
      stat('First crack', fc == null ? '—' : formatClock(fc)),
      stat('Development', dev == null ? '—' : formatClock(dev)),
      stat(lossLabel, lossValue, { flag: flagged ? band.band : null }),
      stat('Score', r.score == null ? '—' : String(r.score))));
}

export function mountHistory(root, app) {
  const settings = app.settings;
  let disposed = false;

  const el = {};
  el.backup = h('section', { class: 'card backup-card', id: 'backup-card' });
  el.list = h('div', { class: 'hist-list', id: 'history-list' });
  const notice = updateNotice(app);

  const backup = createBackupActions(app, {
    onExported: () => load(),
    onImported: () => load(),
  });

  root.append(h('div', { class: 'screen history' },
    h('header', { class: 'topbar' },
      h('h1', null, 'History'),
      h('nav', { class: 'topnav' },
        h('a', { class: 'navlink', href: '#setup', id: 'nav-setup' }, 'Setup'),
        h('a', { class: 'navlink', href: '#settings', id: 'nav-settings' }, 'Settings'))),
    notice.el,
    el.backup,
    el.list));

  function renderBackup(last, roasts) {
    clear(el.backup);
    const since = last ? roasts.filter((r) => String(r.startedAt) > String(last)).length : roasts.length;
    el.backup.append(
      h('h2', null, 'Backup'),
      h('p', { class: 'backup-last', id: 'last-export', 'data-state': last ? 'done' : 'never' },
        last ? `Last export: ${fmtDate(last)}` : 'Never exported'),
      h('p', { class: 'muted small' },
        'Your roasts live only in this browser. Clearing browser data deletes them, so export a backup now and then.',
        roasts.length && since ? ` ${since} ${since === 1 ? 'roast has' : 'roasts have'} not been exported yet.` : ''),
      backup.el);
  }

  function renderList(roasts) {
    clear(el.list);
    if (!roasts.length) {
      el.list.append(h('section', { class: 'card empty', id: 'history-empty' },
        h('h2', null, 'No roasts yet'),
        h('p', { class: 'muted' }, 'Run a roast from Setup and save it. It will show up here, newest first.'),
        h('a', { class: 'btn primary', href: '#setup', id: 'empty-setup', style: 'margin-top:14px' }, 'Go to Setup')));
      return;
    }
    el.list.append(h('p', { class: 'muted small list-count', id: 'history-count' }, `${roasts.length} ${roasts.length === 1 ? 'roast' : 'roasts'}`));
    for (const r of roasts) el.list.append(roastRow(r, settings));
  }

  async function load() {
    let roasts = [];
    let last = null;
    try { roasts = await listRoasts(); } catch (err) {
      if (!disposed) { clear(el.list); el.list.append(h('p', { class: 'error-line' }, `Could not read the roasts: ${err.message || err}`)); }
      return;
    }
    last = await getLastExport();
    if (disposed) return;
    renderBackup(last, roasts);
    renderList(roasts);
  }

  load();

  return function unmount() {
    disposed = true;
    notice.dispose();
  };
}
