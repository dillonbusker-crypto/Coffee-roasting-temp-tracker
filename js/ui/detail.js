// Roast detail (#history/<id>): the saved roast's summary and chart, plus everything that can
// still be corrected: roasted weight, notes, taste score, the two reference switches and the
// heat and fan log. Every change saves as it is made (the status line under the title says so);
// there is no Save button. Also exports this roast as CSV and deletes it.

import { h, clear, setText, setAttr, confirmSheet } from './dom.js';
import { renderRoastSummary } from './summary.js';
import { renderRoastReview, resolveReviewReference } from './review.js';
import { referenceFromRecord } from './chart-model.js';
import { createControlLogEditor } from './control-log-editor.js';
import { switchRow, scoreRow, referenceTags, lossBand, fmtDateAndTime, createToast } from './controls.js';
import { saveFile } from './files.js';
import { getRoast, updateRoast, setReference, deleteRoast } from '../store/db.js';
import { roastToCsv, csvFilename } from '../store/transfer.js';
import { weightLossPct } from '../core/calc.js';

const NOTES_DELAY_MS = 700;

export function mountDetail(root, app, id) {
  const settings = app.settings;
  const units = settings.units;

  let record = null;
  let refSeries = null;
  let summary = null;
  let review = null;
  let reviewHost = null;
  let editor = null;
  let disposed = false;
  let deleted = false;
  let queue = Promise.resolve();
  let notesTimer = null;
  let pendingNotes = null;

  const el = {};
  el.title = h('h1', { id: 'detail-title' }, '');
  el.sub = h('p', { class: 'muted small', id: 'detail-sub' }, '');
  el.tags = h('div', { class: 'tags', id: 'detail-tags' });
  el.status = h('p', { class: 'save-status', id: 'save-status', role: 'status', 'aria-live': 'polite', 'data-kind': 'info' }, 'Changes save as you make them.');
  el.body = h('div', { id: 'detail-body' });

  root.append(h('div', { class: 'screen detail' },
    h('header', { class: 'topbar' },
      h('a', { class: 'navlink back', href: '#history', id: 'back-history' }, '‹ History'),
      h('nav', { class: 'topnav' }, h('a', { class: 'navlink', href: '#settings', id: 'nav-settings' }, 'Settings'))),
    h('div', { class: 'detail-head' }, el.title, el.sub, el.tags, el.status),
    el.body));
  const toast = createToast('Saved');

  // ---- Saving ----

  function setStatus(text, kind = 'info') {
    setText(el.status, text);
    el.status.dataset.kind = kind;
  }

  const flash = () => toast.show();

  function persist(patch) {
    if (deleted) return Promise.resolve(null);
    setStatus('Saving…');
    const p = queue.then(() => updateRoast(id, patch)).then((next) => {
      record = next;
      if (review && !disposed) review.update(record);
      if (!disposed) {
        setStatus(`Saved at ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`, 'good');
        flash();
      }
      return next;
    }).catch((err) => {
      if (!disposed) setStatus(`Could not save: ${err && err.message ? err.message : err}`, 'bad');
      return null;
    });
    queue = p;
    return p;
  }

  // ---- Header and summary ----

  // Redraws the Roast review from the current record. With `again`, looks the comparison roast up
  // afresh first (the reference flags changed, so this roast may now be, or no longer be, it).
  async function refreshReview(again = false) {
    if (!review) return;
    review.update(record);
    if (!again) return;
    const ref = await resolveReviewReference(record);
    if (!disposed) review.setReference(ref);
  }

  function renderHead() {
    setText(el.title, record.coffee || 'Untitled');
    setText(el.sub, `${fmtDateAndTime(record.startedAt)} · ${record.greenWeightG ?? '—'} g green`);
    clear(el.tags);
    for (const t of referenceTags(record)) el.tags.append(t);
  }

  function renderSummary(host) {
    if (summary) summary.destroy();
    summary = renderRoastSummary(host, record, { units, reference: refSeries, logLine: false, slot: reviewHost });
    app.activeChart = summary.chart;   // test hook: the chart model is readable
  }

  // ---- Review: weight, notes, score ----

  function buildReview() {
    const lossBig = h('div', { class: 'loss-big', id: 'loss-big' }, '—');
    const lossNote = h('div', { class: 'loss-note', id: 'loss-text', 'data-band': 'none' }, '');
    const weightError = h('p', { class: 'error-line', id: 'weight-error', role: 'alert' }, '');

    function showLoss(loss) {
      const b = lossBand(loss, settings);
      if (b.band === 'none') {
        setText(lossBig, '—');
        setText(lossNote, 'Enter the roasted weight to see weight loss.');
      } else {
        setText(lossBig, `${b.shown.toFixed(1)}%`);
        setText(lossNote, `${b.shown.toFixed(1)}% weight loss. ${b.words}`);
      }
      setAttr(lossNote, 'data-band', b.band);
    }

    const parse = (v) => (String(v).trim() === '' ? null : Number(v));
    const weight = h('input', {
      id: 'roasted-weight', class: 'field-input', type: 'number', inputmode: 'decimal', min: '0', step: '0.1',
      value: record.roastedWeightG == null ? '' : String(record.roastedWeightG), 'aria-label': 'Roasted weight in grams',
      placeholder: 'For example, 79.9',
      onInput: (e) => {
        const w = parse(e.target.value);
        const loss = w != null && w > 0 ? weightLossPct(record.greenWeightG, w) : null;
        showLoss(loss);
        if (review) review.update({ ...record, roastedWeightG: loss == null ? null : w, weightLossPct: loss });
      },
      onChange: (e) => {
        const w = parse(e.target.value);
        if (w === null) {
          setText(weightError, '');
          showLoss(null);
          persist({ roastedWeightG: null, weightLossPct: null });
          return;
        }
        if (!(w > 0) || !Number.isFinite(w)) {
          setText(weightError, 'Enter a weight above 0 g, or leave it empty.');
          return;
        }
        const loss = weightLossPct(record.greenWeightG, w);
        setText(weightError, '');
        showLoss(loss);
        persist({ roastedWeightG: w, weightLossPct: loss == null ? null : Math.round(loss * 100) / 100 });
      },
    });
    showLoss(record.weightLossPct);

    const notes = h('textarea', {
      id: 'notes', class: 'field-input notes', rows: '3', 'aria-label': 'Notes', placeholder: 'Aroma, taste, what to change next time',
      value: record.notes || '',
      onInput: (e) => {
        pendingNotes = e.target.value;
        clearTimeout(notesTimer);
        notesTimer = setTimeout(flushNotes, NOTES_DELAY_MS);
      },
      onChange: flushNotes,
    });

    const score = scoreRow({
      value: record.score ?? null,
      onChange: (v) => persist({ score: v }),
    });

    return h('section', { class: 'card', id: 'review-card' },
      h('h2', null, 'Review'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Roasted weight (g)'), weight),
      weightError,
      h('div', { class: 'loss-row' }, lossBig, lossNote),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Notes'), notes),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Taste score, 1 to 5 (tap again to clear)'), score));
  }

  function flushNotes() {
    clearTimeout(notesTimer);
    notesTimer = null;
    if (pendingNotes === null) return;
    const notes = pendingNotes;
    pendingNotes = null;
    persist({ notes });
  }

  // ---- Reference ----

  function buildReference() {
    const coffee = switchRow({
      id: 'ref-coffee', title: 'Use as reference for this coffee', on: !!record.reference?.coffee,
      hint: `Later roasts of ${record.coffee || 'this coffee'} follow this curve.`,
      onChange: (v) => changeReference({ coffee: v }),
    });
    const general = switchRow({
      id: 'ref-general', title: 'Use as the general fallback', on: !!record.reference?.general,
      hint: 'Used for any coffee that has no reference of its own.',
      onChange: (v) => changeReference({ general: v }),
    });
    async function changeReference(flags) {
      setStatus('Saving…');
      try {
        queue = queue.then(() => setReference(id, flags));
        await queue;
        record = await getRoast(id);
        coffee.set(!!record.reference?.coffee);
        general.set(!!record.reference?.general);
        renderHead();
        refreshReview(true);
        setStatus('Saved', 'good');
        flash();
      } catch (err) {
        setStatus(`Could not save: ${err && err.message ? err.message : err}`, 'bad');
      }
    }
    return h('section', { class: 'card', id: 'reference-card' }, h('h2', null, 'Reference'), coffee, general);
  }

  // ---- Heat and fan log ----

  function buildLog(summaryHost) {
    editor = createControlLogEditor({
      controls: record.controls || [],
      endT: record.results?.totalSec ?? Math.max(0, (record.readings || []).length - 1),
      onChange: async (controls) => {
        record = { ...record, controls };
        renderSummary(summaryHost);
        refreshReview();
        await persist({ controls });
      },
    });
    return h('section', { class: 'card', id: 'log-card' }, h('h2', null, 'Heat and fan log'), editor.el);
  }

  // ---- Actions ----

  function buildActions() {
    const status = h('p', { class: 'muted small', id: 'export-status', role: 'status' }, '');
    const csv = h('button', {
      type: 'button', class: 'btn', id: 'export-csv',
      onClick: async () => {
        try {
          const how = await saveFile({ filename: csvFilename(record), text: roastToCsv(record), mime: 'text/csv' });
          setText(status, how === 'cancelled' ? 'Export cancelled.' : `Exported ${csvFilename(record)}.`);
        } catch (err) {
          setText(status, `Could not export: ${err && err.message ? err.message : err}`);
        }
      },
    }, 'Export this roast as CSV');
    const del = h('button', {
      type: 'button', class: 'btn danger', id: 'delete-roast',
      onClick: async () => {
        const choice = await confirmSheet({
          title: 'Delete this roast?',
          text: `${record.coffee || 'This roast'}, ${fmtDateAndTime(record.startedAt)}. Its readings, notes and log are deleted from this phone. This cannot be undone.`,
          actions: [
            { label: 'Delete roast', value: 'delete', kind: 'danger' },
            { label: 'Keep it', value: 'keep', kind: 'plain' },
          ],
        });
        if (choice !== 'delete') return;
        try {
          await queue;
          deleted = true;
          clearTimeout(notesTimer);
          pendingNotes = null;
          await deleteRoast(id);
          app.go('history');
        } catch (err) {
          deleted = false;
          setStatus(`Could not delete: ${err && err.message ? err.message : err}`, 'bad');
        }
      },
    }, 'Delete roast');
    return h('div', { class: 'after-actions' }, csv, status, del);
  }

  // ---- Load ----

  async function load() {
    let rec = null;
    try { rec = await getRoast(id); } catch (err) { rec = null; }
    if (disposed) return;
    if (!rec) {
      setText(el.title, 'Roast not found');
      setText(el.status, '');
      el.body.append(h('section', { class: 'card' },
        h('p', null, 'This roast is not on this phone. It may have been deleted.'),
        h('a', { class: 'btn primary', href: '#history', style: 'margin-top:12px' }, 'Back to History')));
      return;
    }
    record = rec;
    const refId = record.settings && record.settings.referenceId;
    if (refId) {
      try {
        const ref = await getRoast(refId);
        if (ref) refSeries = referenceFromRecord(ref, settings);
      } catch { /* the reference is optional */ }
      if (disposed) return;
    }
    renderHead();
    const summaryHost = h('div', { id: 'summary-host' });
    reviewHost = h('div', { id: 'review-host' });
    review = renderRoastReview(reviewHost, record, { units, settings });
    el.body.append(summaryHost, buildReview(), buildReference(), buildLog(summaryHost), buildActions());
    renderSummary(summaryHost);
    refreshReview(true);
  }

  load();

  return function unmount() {
    disposed = true;
    if (pendingNotes !== null && !deleted) persist({ notes: pendingNotes });
    clearTimeout(notesTimer);
    toast.dispose();
    if (summary) {
      if (app.activeChart === summary.chart) app.activeChart = null;
      summary.destroy();
    }
  };
}
