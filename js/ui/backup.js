// Export all and Import, shared by the History and Settings screens.
//
//   const backup = createBackupActions(app, { onExported(iso), onImported(result) });
//   container.append(backup.el)
//
// Export builds one JSON file with exportAll(), hands it to the share sheet or a download,
// and only then records "last export", so cancelling the share sheet does not count.
// Import asks first (it also replaces the settings), then reads the chosen file.

import { h, openSheet, clear } from './dom.js';
import { saveFile, canShareFile, makeFile, createFilePicker } from './files.js';
import { exportAll, importAll, parseExport, ImportError } from '../store/transfer.js';
import { listRoasts, setMeta, getMeta } from '../store/db.js';

export async function getLastExport() {
  try { return await getMeta('lastExportAt'); } catch { return null; }
}

export function describeImport(result) {
  const parts = [
    `${result.added} added`, `${result.updated} updated`, `${result.unchanged} unchanged`, `${result.invalid} invalid`,
  ];
  return `Imported: ${parts.join(', ')}.${result.settingsRestored ? ' Settings restored from the file.' : ''}`;
}

export function createBackupActions(app, { onExported, onImported } = {}) {
  const result = h('div', { class: 'result-line', id: 'transfer-result', role: 'status', 'aria-live': 'polite' });

  function say(text, kind = 'info', extra = []) {
    clear(result);
    result.dataset.kind = kind;
    if (!text) return;
    result.append(h('p', null, text));
    if (extra.length) result.append(h('ul', { class: 'problems' }, ...extra.map((t) => h('li', null, t))));
  }

  async function doExport({ preferShare }) {
    say('');
    exportBtn.disabled = true;
    try {
      // The store's setMeta is held back until the file has really been saved or shared.
      const out = await exportAll({
        settings: app.settings,
        store: { listRoasts, setMeta: async () => {} },
      });
      const status = await saveFile({ filename: out.filename, text: out.json, mime: 'application/json', preferShare });
      if (status === 'cancelled') {
        say('Export cancelled. Nothing was saved.', 'warn');
        return;
      }
      await setMeta('lastExportAt', out.data.exportedAt);
      const n = out.data.roasts.length;
      say(`Exported ${n} ${n === 1 ? 'roast' : 'roasts'} and your settings to ${out.filename}${status === 'shared' ? ' with the share sheet' : ''}.`, 'good');
      onExported && onExported(out.data.exportedAt);
    } catch (err) {
      say(`Could not export: ${err && err.message ? err.message : err}`, 'bad');
    } finally {
      exportBtn.disabled = false;
    }
  }

  async function handleText(text) {
    let exportedAt = null;
    try {
      exportedAt = parseExport(text).exportedAt;
      const res = await importAll(text);
      if (exportedAt) {
        // A backup made at that time now exists on this phone's side; keep the later date.
        const have = await getLastExport();
        if (!have || String(exportedAt) > String(have)) await setMeta('lastExportAt', exportedAt);
      }
      app.refreshSettings();
      const problems = (res.problems || []).slice(0, 8).map((p) => `Roast ${p.index + 1}${p.id ? ` (${p.id})` : ''}: ${p.problem}`);
      if ((res.problems || []).length > 8) problems.push(`and ${res.problems.length - 8} more.`);
      say(describeImport(res), res.invalid ? 'warn' : 'good', problems);
      onImported && onImported(res);
    } catch (err) {
      say(err instanceof ImportError ? err.message : `Could not import: ${err && err.message ? err.message : err}`, 'bad');
    }
  }

  const picker = createFilePicker({
    id: 'import-file',
    accept: 'application/json,.json,text/plain',
    onText: handleText,
    onError: (err) => say(`Could not read the file: ${err && err.message ? err.message : err}`, 'bad'),
  });

  function askImport() {
    openSheet({
      title: 'Import a backup?',
      label: 'Import a backup',
      build(sheet, close) {
        sheet.append(
          h('p', { class: 'sheet-text' }, 'Roasts in the file are added to this phone. A roast with the same id is replaced by the one in the file. Roasts that are not in the file stay.'),
          h('p', { class: 'sheet-text strong' }, 'Importing also replaces your settings with the ones saved in the file.'),
          h('div', { class: 'sheet-actions' },
            h('button', { type: 'button', class: 'btn primary', 'data-action': 'choose', id: 'import-choose', onClick: () => { picker.open(); close('choose'); } }, 'Choose file'),
            h('button', { type: 'button', class: 'btn plain', 'data-action': 'cancel', onClick: () => close('cancel') }, 'Cancel')));
      },
    });
  }

  const exportBtn = h('button', { type: 'button', class: 'btn primary', id: 'export-all', onClick: () => doExport({ preferShare: true }) }, 'Export all');
  const downloadBtn = h('button', { type: 'button', class: 'btn', id: 'export-download', onClick: () => doExport({ preferShare: false }) }, 'Download file instead');
  const importBtn = h('button', { type: 'button', class: 'btn', id: 'import-btn', onClick: askImport }, 'Import');
  downloadBtn.hidden = !canShareFile(makeFile('probe.json', '{}', 'application/json'));

  const el = h('div', { class: 'backup-actions' },
    h('div', { class: 'row-2' }, exportBtn, importBtn),
    downloadBtn, picker.input, result);
  return { el, say };
}
