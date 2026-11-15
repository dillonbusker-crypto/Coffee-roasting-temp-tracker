// After screen: summary, roasted weight and weight loss, notes, score, reference flags, Save.

import { h, setText, setAttr, confirmSheet, fmtDateTime } from './dom.js';
import { renderRoastSummary } from './summary.js';
import { referenceFromRecord } from './chart-model.js';
import { weightLossPct } from '../core/calc.js';
import { saveRoast, setReference, getRoast } from '../store/db.js';
import { clearDraft } from './draft.js';
import { createControlLogEditor } from './control-log-editor.js';

function switchRow({ id, title, hint, onChange }) {
  let on = false;
  const btn = h('button', {
    type: 'button', role: 'switch', id, class: 'switch-row', 'aria-checked': 'false',
    onClick: () => { on = !on; btn.setAttribute('aria-checked', String(on)); onChange(on); },
  },
  h('span', { class: 'sw-text' }, h('b', null, title), h('small', null, hint)),
  h('span', { class: 'sw-track' }, h('i', null)));
  return btn;
}

export function mountAfter(root, app) {
  let record = app.record;
  const settings = app.settings;
  const units = settings.units;
  const lo = settings.weightLossMinPct;
  const hi = settings.weightLossMaxPct;
  const form = { weight: null, notes: '', score: null, refCoffee: false, refGeneral: false };
  let summary = null;
  let saving = false;
  let disposed = false;

  const summaryHost = h('div', { id: 'summary-host' });

  const weight = h('input', {
    id: 'roasted-weight', class: 'field-input', type: 'number', inputmode: 'decimal', min: '0', step: '0.1',
    'aria-label': 'Roasted weight in grams', placeholder: 'For example, 79.9',
    onInput: (ev) => { form.weight = ev.target.value === '' ? null : parseFloat(ev.target.value); renderLoss(); },
  });
  const lossBig = h('div', { class: 'loss-big', id: 'loss-big' }, '—');
  const lossNote = h('div', { class: 'loss-note', id: 'loss-text', 'data-band': 'none' }, 'Enter the roasted weight to see weight loss.');

  function renderLoss() {
    const loss = form.weight != null && form.weight > 0 ? weightLossPct(record.greenWeightG, form.weight) : null;
    if (loss == null) {
      setText(lossBig, '—');
      setText(lossNote, 'Enter the roasted weight to see weight loss.');
      setAttr(lossNote, 'data-band', 'none');
      return;
    }
    const shown = Number(loss.toFixed(1));
    setText(lossBig, `${shown.toFixed(1)}%`);
    let band = 'in';
    let words = `In the ${lo}–${hi}% band.`;
    if (shown < lo) { band = 'under'; words = `Under the ${lo}–${hi}% band. Roasted lighter than the target.`; }
    else if (shown > hi) { band = 'over'; words = `Over the ${lo}–${hi}% band. Roasted darker than the target.`; }
    setText(lossNote, `${shown.toFixed(1)}% weight loss. ${words}`);
    setAttr(lossNote, 'data-band', band);
  }

  const notes = h('textarea', {
    id: 'notes', class: 'field-input notes', rows: '3', 'aria-label': 'Notes', placeholder: 'Aroma, taste, what to change next time',
    onInput: (ev) => { form.notes = ev.target.value; },
  });

  const scoreBtns = [1, 2, 3, 4, 5].map((n) => h('button', {
    type: 'button', class: 'score-btn', 'data-score': n, role: 'radio', 'aria-checked': 'false', 'aria-label': `Taste score ${n}`,
    onClick: () => {
      form.score = form.score === n ? null : n;
      scoreBtns.forEach((b) => {
        const on = Number(b.dataset.score) === form.score;
        b.setAttribute('aria-checked', String(on));
        b.classList.toggle('on', on);
      });
    },
  }, String(n)));

  const refCoffee = switchRow({
    id: 'ref-coffee', title: 'Use as reference for this coffee',
    hint: `Later roasts of ${record.coffee || 'this coffee'} follow this curve.`,
    onChange: (v) => { form.refCoffee = v; },
  });
  const refGeneral = switchRow({
    id: 'ref-general', title: 'Use as the general fallback',
    hint: 'Used for any coffee that has no reference of its own.',
    onChange: (v) => { form.refGeneral = v; },
  });

  // The log can be corrected before saving. The chart and the change count follow each edit.
  const logEditor = createControlLogEditor({
    controls: record.controls || [],
    endT: record.results?.totalSec ?? Math.max(0, (record.readings || []).length - 1),
    onChange: (controls) => {
      record = { ...record, controls };
      app.record = record;
      drawSummary();
    },
  });

  const error = h('p', { class: 'error-line', id: 'save-error', role: 'alert' }, '');
  const saveBtn = h('button', { type: 'button', class: 'btn primary', id: 'save-btn', onClick: onSave }, 'Save roast');
  const discardBtn = h('button', { type: 'button', class: 'btn danger', id: 'discard-btn', onClick: onDiscard }, 'Discard');

  root.append(h('div', { class: 'screen after' },
    h('header', { class: 'topbar' },
      h('div', null,
        h('h1', null, 'Roast done'),
        h('p', { class: 'muted small' }, `${record.coffee || 'Untitled'} · ${fmtDateTime(record.startedAt)} · ${record.greenWeightG} g green`))),
    summaryHost,
    h('section', { class: 'card', id: 'log-card' },
      h('h2', null, 'Heat and fan log'),
      logEditor.el),
    h('section', { class: 'card' },
      h('h2', null, 'Weight loss'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Roasted weight (g)'), weight),
      h('div', { class: 'loss-row' }, lossBig, lossNote)),
    h('section', { class: 'card' },
      h('h2', null, 'Notes'),
      notes,
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Taste score, 1 to 5 (optional)'),
        h('div', { class: 'score-row', role: 'radiogroup', 'aria-label': 'Taste score' }, ...scoreBtns))),
    h('section', { class: 'card' },
      h('h2', null, 'Reference'),
      refCoffee, refGeneral),
    h('div', { class: 'after-actions' }, error, saveBtn, discardBtn)));

  let refSeries = null;
  function drawSummary() {
    if (summary) summary.destroy();
    summary = renderRoastSummary(summaryHost, record, { units, reference: refSeries, logLine: false });
    app.activeChart = summary.chart;   // test hook: the chart model is readable
  }
  drawSummary();

  // If this roast followed a reference, draw that curve behind it too.
  const refId = record.settings && record.settings.referenceId;
  if (refId) {
    getRoast(refId).then((ref) => {
      if (ref && !disposed) { refSeries = referenceFromRecord(ref, settings); summary.setReference(refSeries); }
    }).catch(() => {});
  }

  async function onSave() {
    if (saving) return;
    saving = true;
    saveBtn.disabled = true;
    setText(error, '');
    try {
      const loss = form.weight != null && form.weight > 0 ? weightLossPct(record.greenWeightG, form.weight) : null;
      const final = {
        ...record,
        roastedWeightG: form.weight != null && form.weight > 0 ? form.weight : null,
        weightLossPct: loss == null ? null : Math.round(loss * 100) / 100,
        notes: form.notes,
        score: form.score,
        reference: { coffee: false, general: false },
      };
      await saveRoast(final);
      if (form.refCoffee || form.refGeneral) {
        await setReference(final.id, { coffee: form.refCoffee, general: form.refGeneral });
      }
      await clearDraft();
      app.record = null;
      app.go('history');
    } catch (err) {
      saving = false;
      saveBtn.disabled = false;
      setText(error, `Could not save: ${err && err.message ? err.message : err}`);
    }
  }

  async function onDiscard() {
    const choice = await confirmSheet({
      title: 'Discard this roast?',
      text: 'The readings and events from this roast will be deleted.',
      actions: [
        { label: 'Discard roast', value: 'discard', kind: 'danger' },
        { label: 'Keep it', value: 'keep', kind: 'plain' },
      ],
    });
    if (choice !== 'discard') return;
    await clearDraft();
    app.record = null;
    app.go('setup');
  }

  renderLoss();
  return function unmount() {
    disposed = true;
    if (app.activeChart === summary.chart) app.activeChart = null;
    summary && summary.destroy();
  };
}
