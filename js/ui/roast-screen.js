// Roast screen: fixed layout, no scrolling. Readouts, cue banner, chart with heat/fan strip,
// heat and fan controls, event buttons, and a status strip.

import { h, setText, setAttr, confirmSheet } from './dom.js';
import { createChart } from './chart.js';
import { modelFromSnapshot } from './chart-model.js';
import { openNumpadSheet } from './numpad.js';
import { clearDraft } from './draft.js';
import { formatTemp, formatRate, formatClock, unitLabel } from '../core/units.js';

const EVENTS = [
  { name: 'yellow', label: 'Yellow', hint: 'optional' },
  { name: 'firstCrack', label: 'First crack', hint: 'starts countdown' },
  { name: 'drop', label: 'Drop', hint: 'ends roast' },
];

export function mountRoast(root, app) {
  const ctl = app.controller;
  const info = app.roastInfo;                    // { label, entry, referenceSeries, referenceName }
  const units = app.settings.units;
  const minF = app.settings.reader?.minF ?? 50;
  const maxF = app.settings.reader?.maxF ?? 550;
  const staleAfterSec = ctl.source.kind === 'manual' ? 20 : 0;   // typed readings are sparse by nature
  let latest = null;
  let rafId = 0;
  let cleanupStatus = null;
  const disposers = [];

  // ---- Elements ----
  const e = {};
  e.temp = h('span', { id: 'probe-temp', class: 'r-num' }, '—');
  e.ror = h('div', { id: 'ror', class: 'r-mid' }, '—');
  e.elapsed = h('div', { id: 'elapsed', class: 'r-mid' }, '0:00');
  e.devLabel = h('div', { class: 'r-label', id: 'dev-label' }, 'First crack est.');
  e.devValue = h('b', { id: 'dev-value' }, '—');
  e.devSub = h('small', { id: 'dev-sub' }, '');
  e.probeCell = h('div', { class: 'r-probe', id: 'probe-cell' },
    h('div', { class: 'r-label' }, 'Probe temp'),
    h('div', { class: 'r-big' }, e.temp, h('span', { class: 'r-unit' }, unitLabel(units))));
  e.devCell = h('div', { class: 'r-dev', id: 'dev-cell' }, e.devLabel, h('div', { class: 'r-dev-val' }, e.devValue, e.devSub));

  e.banner = h('div', { class: 'banner', id: 'banner', role: 'status', 'aria-live': 'polite', 'data-state': 'idle' },
    h('span', { class: 'banner-text', id: 'banner-text' }, ''));
  e.bannerText = e.banner.firstChild;

  e.canvas = h('canvas', { id: 'chart', 'aria-label': 'Roast chart: probe temperature, rate of rise, heat and fan' });
  e.chartWrap = h('div', { class: 'chart-wrap' }, e.canvas);

  e.heatBtns = [1, 2, 3, 4, 5, 6, 7].map((n) => h('button', {
    type: 'button', class: 'heat-btn', 'data-heat': n, 'aria-label': `Heat ${n}`,
    onClick: () => ctl.setControl('heat', n),
  }, String(n)));
  e.fanLabel = h('b', null, 'High');
  e.fan = h('button', {
    type: 'button', class: 'fan-btn', id: 'fan-toggle', 'aria-label': 'Fan',
    onClick: () => ctl.setControl('fan', ctl.snapshot().fan === 'high' ? 'low' : 'high'),
  }, h('span', null, 'Fan'), e.fanLabel);
  e.controlRow = h('div', { class: 'control-row' }, ...e.heatBtns, e.fan);

  e.evBtns = {};
  for (const ev of EVENTS) {
    const name = h('span', { class: 'ev-name' }, ev.label);
    const sub = h('span', { class: 'ev-sub' }, ev.hint);
    const btn = h('button', {
      type: 'button', class: 'ev-btn', id: `ev-${ev.name}`, 'data-event': ev.name,
      onClick: () => {
        const s = ctl.snapshot();
        if (s.events[ev.name]) ctl.unmark(ev.name);
        else ctl.mark(ev.name);
      },
    }, name, sub);
    e.evBtns[ev.name] = { btn, name, sub, ev };
  }
  e.eventRow = h('div', { class: 'event-row' }, ...EVENTS.map((ev) => e.evBtns[ev.name].btn));

  e.statusLabel = h('div', { class: 'status-label', id: 'status-label' }, info.label);
  e.statusSlot = h('div', { class: 'status-slot' });
  e.type = h('button', { type: 'button', class: 'btn plain status-btn', id: 'type-reading', onClick: openType }, 'Type reading');
  e.end = h('button', { type: 'button', class: 'btn plain status-btn', id: 'end-roast', onClick: onEnd }, 'End roast');
  e.status = h('div', { class: 'status-strip' }, h('div', { class: 'status-main' }, e.statusLabel, e.statusSlot), e.type, e.end);

  root.append(h('div', { class: 'screen roast' },
    h('section', { class: 'readouts' },
      h('div', { class: 'r-left' }, e.probeCell, e.devCell),
      h('div', { class: 'r-right' },
        h('div', { class: 'r-cell' }, h('div', { class: 'r-label' }, 'Elapsed'), e.elapsed),
        h('div', { class: 'r-cell' }, h('div', { class: 'r-label' }, 'Rate of rise ', h('span', { class: 'r-label-unit' }, `${unitLabel(units)}/min`)), e.ror))),
    e.banner, e.chartWrap, e.controlRow, e.eventRow, e.status));

  const chart = createChart(e.canvas);
  app.activeChart = chart;
  if (info.entry && info.entry.renderRoastStatus) {
    cleanupStatus = info.entry.renderRoastStatus(e.statusSlot, ctl.source, { units }) || null;
  }

  // ---- Actions ----

  function openType() {
    openNumpadSheet({ units, minF, maxF, onEnter: (f) => ctl.typeReading(f) });
  }

  async function onEnd() {
    const choice = await confirmSheet({
      title: 'End the roast?',
      text: 'Save keeps every reading logged so far and goes to the summary.',
      actions: [
        { label: 'Save what’s logged', value: 'save', kind: 'primary' },
        { label: 'Discard roast', value: 'discard', kind: 'danger' },
        { label: 'Keep roasting', value: 'keep', kind: 'plain' },
      ],
    });
    if (choice === 'save') ctl.end();
    else if (choice === 'discard') {
      ctl.abort();
      await clearDraft();
      app.finishRoastSession();
      app.go('setup');
    }
  }

  // ---- Rendering ----

  function renderBanner(v) {
    const b = v.banner;
    let state = 'idle';
    let kind = '';
    let text;
    if (v.dropPending) { state = 'drop'; text = 'Drop stamped. Tap Undo to keep roasting.'; }
    else if (v.lost) { state = 'lost'; kind = 'critical'; text = 'Lost the reading'; }
    else if (b) { state = 'cue'; kind = b.kind; text = b.text; }
    else text = v.mode === 'reference' ? `Reference: ${info.referenceName || 'saved roast'}` : 'Starter guardrails';
    setAttr(e.banner, 'data-state', state);
    setAttr(e.banner, 'data-kind', kind || null);
    setText(e.bannerText, text);
  }

  function renderDev(v) {
    const s = v.snapshot;
    if (s.events.firstCrack) {
      const remaining = s.devTargetSec - (s.devSec ?? 0);
      const pct = s.devPct == null ? '—' : `${Math.round(s.devPct)}%`;
      setText(e.devLabel, 'Development');
      if (s.events.drop) {
        setText(e.devValue, formatClock(s.devSec));
        setText(e.devSub, ` · ${pct}`);
        setAttr(e.devCell, 'data-state', 'done');
      } else if (remaining >= 0) {
        setText(e.devValue, formatClock(remaining));
        setText(e.devSub, ` left · ${pct}`);
        setAttr(e.devCell, 'data-state', remaining <= 15 ? 'soon' : 'run');
      } else {
        setText(e.devValue, `+${formatClock(-remaining)}`);
        setText(e.devSub, ` over · ${pct}`);
        setAttr(e.devCell, 'data-state', 'over');
      }
    } else {
      setText(e.devLabel, 'First crack est.');
      const p = v.projectedFc;
      setText(e.devValue, p != null && Number.isFinite(p) ? formatClock(Math.max(p, s.t)) : '—');
      setText(e.devSub, ` at ${formatTemp(s.expectedFcF, units)}`);
      setAttr(e.devCell, 'data-state', 'est');
    }
  }

  function renderEvents(v) {
    const s = v.snapshot;
    const primaryDrop = !!s.events.firstCrack && !s.events.drop;
    for (const { btn, name, sub, ev } of Object.values(e.evBtns)) {
      const stamped = s.events[ev.name];
      const remaining = v.undoMs[ev.name];
      let state = 'ready';
      if (stamped && remaining != null) {
        state = 'undo';
        setText(name, `Undo ${Math.ceil(remaining / 1000)}`);
        setText(sub, `${formatClock(stamped.t)} · ${formatTemp(stamped.f, units)}`);
      } else if (stamped) {
        state = 'stamped';
        setText(name, ev.label);
        setText(sub, `${formatClock(stamped.t)} · ${formatTemp(stamped.f, units)}`);
      } else {
        setText(name, ev.label);
        setText(sub, ev.hint);
      }
      setAttr(btn, 'data-state', state);
      btn.disabled = state === 'stamped';
      btn.classList.toggle('primary', ev.name === 'drop' && primaryDrop);
    }
  }

  function render(v, { withChart = true } = {}) {
    const s = v.snapshot;
    setText(e.temp, s.temp == null ? '—' : formatTemp(s.temp, units, { digits: 0, unit: false }));
    e.probeCell.classList.toggle('stale', s.secondsSinceReading > staleAfterSec);
    setText(e.ror, s.rorNow == null ? '—' : formatRate(s.rorNow, units, { unit: false }));
    setText(e.elapsed, formatClock(s.t));
    renderDev(v);
    renderBanner(v);
    for (const b of e.heatBtns) {
      const on = Number(b.dataset.heat) === s.heat;
      setAttr(b, 'aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    }
    setText(e.fanLabel, s.fan === 'high' ? 'High' : 'Low');
    setAttr(e.fan, 'data-fan', s.fan);
    renderEvents(v);
    if (withChart) {
      chart.draw(modelFromSnapshot(s, {
        units, cues: v.cues, reference: info.referenceSeries || null, sourceKind: v.sourceKind,
      }));
    }
  }

  function schedule(v) {
    latest = v;
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; if (latest) render(latest); });
  }

  const offUpdate = ctl.onUpdate(schedule);
  disposers.push(offUpdate);

  // Undo countdown and banner expiry move on real time, between roast seconds.
  const tick = setInterval(() => { if (ctl.phase === 'running') render(ctl.view(), { withChart: false }); }, 250);
  disposers.push(() => clearInterval(tick));

  const onVisible = () => { if (document.visibilityState === 'visible') ctl.poll(); };
  document.addEventListener('visibilitychange', onVisible);
  disposers.push(() => document.removeEventListener('visibilitychange', onVisible));

  render(ctl.view());

  return function unmount() {
    for (const d of disposers) d();
    if (rafId) cancelAnimationFrame(rafId);
    if (cleanupStatus) cleanupStatus();
    chart.destroy();
    app.activeChart = null;
  };
}
