// The roast summary block: key times and temperatures, phase shares, average rate of rise,
// reader health, and the full chart with its heat/fan strip and cue markers. Built from a
// saved roast record, so the After screen and the History detail screen share it.
//
//   const view = renderRoastSummary(container, record, { units, reference, slot });
//   view.setReference(referenceSeries)   // optionally add the reference curve later
//   view.destroy();

import { h, clear } from './dom.js';
import { createChart } from './chart.js';
import { modelFromRecord } from './chart-model.js';
import { formatTemp, formatRate, formatClock } from '../core/units.js';

const pctText = (p) => (p == null ? '—' : `${Math.round(p.pct)}%`);

function stamp(ev, units) {
  return ev ? `${formatClock(ev.t)} · ${formatTemp(ev.f, units)}` : 'Not tapped';
}

function phaseText(p) {
  return p ? `${formatClock(p.sec)} · ${pctText(p)}` : '—';
}

function controlLog(controls) {
  const parts = [];
  for (const c of controls || []) {
    const what = c.kind === 'heat' ? `heat ${c.value}` : `fan ${c.value === 'high' ? 'High' : 'Low'}`;
    parts.push(`${formatClock(c.t)} ${what}`);
  }
  return parts.join(', ');
}

// "Missed: 9 unclear digit, 3 jump too big", from reader.missReasons (camera roasts only, and only when there were misses).
function missedLine(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const parts = Object.entries(m).filter(([, n]) => Number.isFinite(n) && n > 0).sort((a, b) => b[1] - a[1]).map(([label, n]) => `${n} ${label}`);
  return parts.length ? h('p', { class: 'muted small', id: 'sum-missed' }, `Missed: ${parts.join(', ')}`) : null;
}

// logLine: false leaves out the plain-text heat and fan log (screens with a log editor show it themselves).
// slot: an element to place between the chart and the event/phase/reader details (the Roast review card).
// It is moved, not copied, so it survives a re-render.
export function renderRoastSummary(container, record, { units = 'F', reference = null, logLine = true, slot = null } = {}) {
  const r = record.results || {};
  const ev = record.events || {};
  const phases = r.phases || {};
  const rd = record.reader || {};

  const tile = (label, value, id) => h('div', { class: 'tile', id }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value));
  const row = (label, value, id) => h('div', { class: 'sum-row', id }, h('span', null, label), h('b', null, value));

  const tiles = h('div', { class: 'tiles' },
    tile('Development', phaseText(phases.development), 'sum-dev'),
    tile('Total time', formatClock(r.totalSec), 'sum-total'),
    tile('Average rate of rise', formatRate(r.avgRor, units), 'sum-ror'),
    tile('Heat and fan', (() => { const n = Math.max(0, (record.controls || []).length - 2); return `${n} ${n === 1 ? 'change' : 'changes'}`; })(), 'sum-changes'));

  const events = h('div', { class: 'sum-group' },
    h('h3', null, 'Events'),
    row('Yellow', stamp(ev.yellow, units), 'sum-yellow'),
    row('First crack', stamp(ev.firstCrack, units), 'sum-fc'),
    row('Drop', stamp(ev.drop, units), 'sum-drop'));

  const phaseRows = ev.yellow
    ? [row('Drying', phaseText(phases.drying), 'sum-drying'), row('Browning', phaseText(phases.browning), 'sum-browning')]
    : [row('Drying + browning', phaseText(phases.browning), 'sum-browning')];
  const phaseGroup = h('div', { class: 'sum-group' },
    h('h3', null, 'Phases'), ...phaseRows,
    row('Development', phaseText(phases.development), 'sum-development'));

  const log = controlLog(record.controls);
  const health = h('div', { class: 'sum-group' },
    h('h3', null, 'Reader'),
    row('Read', `${rd.secondsRead ?? 0} s`, 'sum-read'),
    row('Rejected', String(rd.rejected ?? 0), 'sum-rejected'),
    row('Missing', `${rd.secondsMissing ?? 0} s`, 'sum-missing'),
    missedLine(rd.missReasons),
    logLine ? h('p', { class: 'muted small' }, log ? `Heat and fan log: ${log}.` : '') : null);

  const canvas = h('canvas', { id: 'summary-chart', 'aria-label': 'Roast chart' });
  const wrap = h('div', { class: 'chart-wrap summary-chart' }, canvas);

  clear(container);
  container.append(h('div', { class: 'summary' }, tiles, wrap, slot, events, phaseGroup, health));

  const chart = createChart(canvas);
  let refSeries = reference;
  const draw = () => chart.draw(modelFromRecord(record, { units, reference: refSeries }));
  draw();

  return {
    chart,
    setReference(series) { refSeries = series; draw(); },
    destroy() { chart.destroy(); },
  };
}
