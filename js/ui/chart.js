// One canvas chart for a roast: smoothed temperature (left axis), rate of rise (right
// axis), phase bands, event markers, cue markers, an optional reference curve, and the
// heat and fan step strip directly under the plot on the same time axis.
//
//   const chart = createChart(canvas);
//   chart.draw(model);          // model: see chart-model.js; plain data, no session access
//
// The canvas fills its parent. It redraws on resize and on devicePixelRatio changes.
// Gaps in readings (null) break the lines; they are never bridged unless model.bridgeSec
// asks for it (typed readings, which are sparse by nature).

import { tempToUnit, tempFromUnit, rateToUnit, unitLabel, formatClock } from '../core/units.js';

export const COLORS = {
  bg: '#0f1115', surface: '#191c22', raised: '#232730', hair: '#2e333d',
  text: '#f2f4f7', muted: '#9aa3b2',
  temp: '#ffb454', ror: '#5cc8ff', ref: '#6b7280',
  good: '#4ade80', warn: '#fbbf24', alert: '#f87171',
};
const FONT = '-apple-system, system-ui, "Segoe UI", Roboto, sans-serif';
const CRITICAL_IDS = new Set(['dropNow', 'endTemp', 'lost']);
const CORRECTIVE_IDS = new Set(['hot', 'slow', 'stall', 'rorClimb']);

// ---- Pure helpers (exported for tests and for the History screen) ----

export function xMaxOf(model, refLen = 0) {
  const end = Math.max(model.endT || 0, refLen > 0 ? refLen - 1 : 0);
  return model.fit
    ? Math.max(300, Math.ceil((end + 15) / 60) * 60)
    : Math.max(480, Math.ceil((end + 20) / 60) * 60);
}

// Phase bands from the events. Each band is { key, full, short, from, to, sec, pct, ended }.
export function phaseBands(model) {
  const ev = model.events || {};
  const y = ev.yellow ? ev.yellow.t : null;
  const fc = ev.firstCrack ? ev.firstCrack.t : null;
  const drop = ev.drop ? ev.drop.t : null;
  const end = drop ?? model.endT ?? 0;
  const bands = [];
  const add = (key, full, short, from, to, ended) => {
    if (to < from) return;
    const sec = to - from;
    bands.push({ key, full, short, from, to, sec, pct: end > 0 ? (sec / end) * 100 : 0, ended });
  };
  const over = !model.live || drop !== null;   // nothing is still running
  if (y !== null) {
    add('drying', 'Drying', 'Dry', 0, Math.min(y, end), true);
    if (fc !== null) add('browning', 'Browning', 'Brown', y, fc, true);
    else if (y < end) add('browning', 'Browning', 'Brown', y, end, over);
  } else if (fc !== null) {
    add('browning', 'Drying + browning', 'Dry + brown', 0, fc, true);
  } else if (end > 0 || over) {
    add(over ? 'browning' : 'drying', over ? 'Drying + browning' : 'Drying', over ? 'Dry + brown' : 'Dry', 0, end, over);
  }
  if (fc !== null) add('development', 'Development', 'Dev', fc, Math.max(fc, end), over);
  return bands;
}

function niceStep(range, n) {
  const raw = Math.max(range, 1e-9) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * mag;
}

export function niceTicks(lo, hi, n) {
  const step = niceStep(hi - lo, n);
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

export function domains(model) {
  let tMin = Infinity;
  let tMax = -Infinity;
  let rMin = 0;
  let rMax = 0;
  const scanT = (arr) => { for (const v of arr || []) if (v != null) { if (v < tMin) tMin = v; if (v > tMax) tMax = v; } };
  scanT(model.smooth);
  scanT(model.reference && model.reference.smooth);
  for (const v of model.ror || []) if (v != null) { if (v < rMin) rMin = v; if (v > rMax) rMax = v; }
  const tLo = Number.isFinite(tMin) ? Math.min(50, Math.floor(tMin / 50) * 50) : 50;
  const tHi = Number.isFinite(tMax) ? Math.max(450, Math.ceil((tMax + 80) / 50) * 50) : 450;
  const rLo = rMin < 0 ? Math.floor(rMin / 10) * 10 : 0;
  const rHi = Math.max(60, Math.ceil(rMax / 20) * 20);
  return { tLo, tHi, rLo, rHi };
}

function cueColor(c) {
  const kind = c.kind || (CRITICAL_IDS.has(c.id) ? 'critical' : CORRECTIVE_IDS.has(c.id) ? 'corrective' : 'info');
  return kind === 'critical' ? COLORS.alert : kind === 'corrective' ? COLORS.warn : COLORS.text;
}

// Runs of consecutive (or bridgeable) non-null samples.
function runs(series, maxT, bridge) {
  const out = [];
  let cur = null;
  let last = -Infinity;
  const n = Math.min(series.length - 1, maxT);
  for (let t = 0; t <= n; t++) {
    const v = series[t];
    if (v == null) continue;
    if (cur && (t - last === 1 || (bridge > 0 && t - last <= bridge))) cur.push(t);
    else { cur = [t]; out.push(cur); }
    last = t;
  }
  return out;
}

function controlSegments(controls, kind, endT) {
  const list = (controls || []).filter((c) => c.kind === kind).sort((a, b) => a.t - b.t);
  return list.map((c, i) => ({ from: c.t, to: i + 1 < list.length ? list[i + 1].t : Math.max(endT, c.t), value: c.value }));
}

// ---- The chart ----

export function createChart(canvas) {
  const ctx = canvas.getContext('2d');
  let model = null;
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let ro = null;

  const api = {
    draw(m) { model = m; api.lastModel = m; render(); },
    resize,
    destroy() { if (ro) ro.disconnect(); window.removeEventListener('resize', resize); },
    lastModel: null,
    get size() { return { w: cssW, h: cssH }; },
  };

  function resize() {
    const parent = canvas.parentElement || canvas;
    const w = Math.floor(parent.clientWidth);
    const h = Math.floor(parent.clientHeight);
    const ratio = window.devicePixelRatio || 1;
    if (!w || !h) return;
    if (w === cssW && h === cssH && ratio === dpr) return;
    cssW = w; cssH = h; dpr = ratio;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    render();
  }

  if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
    ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);
  }
  window.addEventListener('resize', resize);
  resize();

  function rrect(x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); } else { ctx.beginPath(); ctx.rect(x, y, w, h); }
  }

  // Text that fits in maxW, trying each candidate in turn; null if none does.
  function fit(candidates, maxW) {
    for (const c of candidates) if (c && ctx.measureText(c).width <= maxW) return c;
    return null;
  }

  function render() {
    if (!model || !cssW || !cssH) return;
    const m = model;
    const W = cssW;
    const H = cssH;
    const units = m.units || 'F';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';

    // Layout: title row, phase header, plot, heat and fan strip, time axis labels.
    const padL = 36;
    const padR = 36;
    const titleH = 16;
    const headY0 = titleH + 2;
    const headH = 28;
    const stripH = 38;
    const tickH = 16;
    const x0 = padL;
    const x1 = W - padR;
    const y0 = headY0 + headH + 3;
    const y1 = Math.max(y0 + 40, H - stripH - tickH - 16);
    const stripY = y1 + 4;
    const axisY = stripY + stripH + 10;   // 9px of room above the axis for cue markers
    const plotW = x1 - x0;

    const refSmooth = m.reference && m.reference.smooth ? m.reference.smooth : null;
    const xMax = xMaxOf(m, refSmooth ? refSmooth.length : 0);
    const xOf = (t) => x0 + (t / xMax) * plotW;
    const d = domains(m);
    const yT = (f) => y1 - ((f - d.tLo) / (d.tHi - d.tLo)) * (y1 - y0);
    const yR = (r) => y1 - ((r - d.rLo) / (d.rHi - d.rLo)) * (y1 - y0);
    const endT = m.endT || 0;

    // Phase bands: faint fill behind the plot, a labelled tab above it.
    const bands = phaseBands(m);
    const bandFill = { drying: 'rgba(255,255,255,0.025)', browning: 'rgba(255,255,255,0.055)', development: 'rgba(255,180,84,0.10)' };
    const tabFill = { drying: '#20242c', browning: '#272c35', development: '#3a2f1f' };
    for (const b of bands) {
      const bx0 = xOf(b.from);
      const bx1 = Math.max(xOf(b.to), bx0 + 1);
      ctx.fillStyle = bandFill[b.key];
      ctx.fillRect(bx0, y0, bx1 - bx0, y1 - y0);
      // tab
      const tw = bx1 - bx0 - 2;
      if (tw > 4) {
        ctx.fillStyle = tabFill[b.key];
        rrect(bx0 + 1, headY0, tw, headH, 4);
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx0 + 1, headY0, tw, headH);
        ctx.clip();
        ctx.textAlign = 'center';
        ctx.fillStyle = COLORS.text;
        ctx.font = `600 11px ${FONT}`;
        const name = fit([b.full, b.short, b.full[0]], tw - 6);
        ctx.font = `500 10.5px ${FONT}`;
        const stat = fit([`${formatClock(b.sec)} · ${Math.round(b.pct)}%`, formatClock(b.sec)], tw - 6);
        const cx = bx0 + 1 + tw / 2;
        if (name && stat) {
          ctx.font = `600 11px ${FONT}`;
          ctx.fillStyle = COLORS.text;
          ctx.fillText(name, cx, headY0 + 12);
          ctx.font = `500 10.5px ${FONT}`;
          ctx.fillStyle = COLORS.muted;
          ctx.fillText(stat, cx, headY0 + 24);
        } else if (stat) {
          ctx.font = `500 10.5px ${FONT}`;
          ctx.fillStyle = COLORS.muted;
          ctx.fillText(stat, cx, headY0 + 18);
        } else if (name) {
          ctx.font = `600 11px ${FONT}`;
          ctx.fillStyle = COLORS.text;
          ctx.fillText(name, cx, headY0 + 18);
        }
        ctx.restore();
      }
    }

    // Grid: horizontal at temperature ticks, vertical at minutes. Quiet hairlines.
    const nT = Math.max(3, Math.min(6, Math.floor((y1 - y0) / 30)));
    const tTicks = niceTicks(tempToUnit(d.tLo, units), tempToUnit(d.tHi, units), nT);
    const rTicks = niceTicks(rateToUnit(d.rLo, units), rateToUnit(d.rHi, units), nT);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(154,163,178,0.14)';
    ctx.beginPath();
    for (const v of tTicks) {
      const y = Math.round(yT(tempFromUnit(v, units))) + 0.5;
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    const pxPerMin = plotW / (xMax / 60);
    const xStep = pxPerMin >= 34 ? 60 : 120;
    for (let t = 0; t <= xMax; t += xStep) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.moveTo(x, y0);
      ctx.lineTo(x, axisY);
    }
    ctx.stroke();
    if (d.rLo < 0) {
      ctx.strokeStyle = 'rgba(92,200,255,0.35)';
      ctx.beginPath();
      const y = Math.round(yR(0)) + 0.5;
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    }

    // Axes: muted numbers, a short tick in the series colour so each scale reads as its curve's.
    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const v of tTicks) {
      const y = yT(tempFromUnit(v, units));
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(String(Math.round(v)), x0 - 7, y);
      ctx.fillStyle = COLORS.temp;
      ctx.fillRect(x0 - 4, Math.round(y) - 0.5, 4, 1.5);
    }
    ctx.textAlign = 'left';
    for (const v of rTicks) {
      const y = yR(units === 'C' ? v * 9 / 5 : v);
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(String(Math.round(v)), x1 + 7, y);
      ctx.fillStyle = COLORS.ror;
      ctx.fillRect(x1, Math.round(y) - 0.5, 4, 1.5);
    }

    // Plot contents, clipped to the plot area.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0 - 1, plotW + 1, y1 - y0 + 2);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const bridge = m.bridgeSec || 0;
    const drawSeries = (series, yOf, color, width) => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width;
      for (const run of runs(series, Math.ceil(xMax), bridge)) {
        if (run.length === 1) {
          ctx.beginPath();
          ctx.arc(xOf(run[0]), yOf(series[run[0]]), 2.5, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.beginPath();
        run.forEach((t, i) => {
          const x = xOf(t);
          const y = yOf(series[t]);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    };

    if (refSmooth) drawSeries(refSmooth, yT, COLORS.ref, 2);
    drawSeries(m.ror || [], yR, COLORS.ror, 2);
    drawSeries(m.smooth || [], yT, COLORS.temp, 2);

    // Event markers.
    const markers = [
      { ev: m.events && m.events.yellow, label: 'Yellow', dash: true },
      { ev: m.events && m.events.firstCrack, label: 'First crack', dash: true },
      { ev: m.events && m.events.drop, label: 'Drop', dash: false },
    ];
    ctx.strokeStyle = 'rgba(242,244,247,0.55)';
    ctx.lineWidth = 1;
    for (const mk of markers) {
      if (!mk.ev) continue;
      const x = Math.round(xOf(mk.ev.t)) + 0.5;
      ctx.setLineDash(mk.dash ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Live end-dot with a surface ring.
    if (m.live) {
      const lastT = (() => { for (let t = Math.min((m.smooth || []).length - 1, endT); t >= 0; t--) if (m.smooth[t] != null) return t; return -1; })();
      if (lastT >= 0) {
        const x = xOf(lastT);
        const y = yT(m.smooth[lastT]);
        ctx.fillStyle = COLORS.surface;
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = COLORS.temp;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    // Event labels at the top of the plot, left of their line, on a small surface pill.
    // A label that would collide with another, or leave the plot, moves to the other side
    // of its line, then to a second row.
    ctx.font = `600 10.5px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const placed = [];
    const clash = (r) => placed.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);
    for (const mk of markers) {
      if (!mk.ev) continue;
      const x = xOf(mk.ev.t);
      const tw = Math.ceil(ctx.measureText(mk.label).width) + 6;
      const tries = [];
      for (const row of [0, 1]) {
        const y = y0 + 2 + row * 16;
        tries.push({ x: x - 3 - tw, y, w: tw, h: 14 }, { x: x + 3, y, w: tw, h: 14 });
      }
      const spot = tries.find((r) => r.x >= x0 && r.x + r.w <= x1 && !clash(r)) || tries[1];
      placed.push(spot);
      ctx.fillStyle = 'rgba(25,28,34,0.85)';
      ctx.fillRect(spot.x, spot.y, spot.w, spot.h);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(mk.label, spot.x + 3, spot.y + 7.5);
    }

    // Heat and fan strip.
    const heatY = stripY;
    const heatH = 22;
    const fanY = stripY + heatH + 2;
    const fanH = stripH - heatH - 2;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = `10.5px ${FONT}`;
    ctx.fillStyle = COLORS.muted;
    ctx.fillText('Heat', x0 - 6, heatY + heatH / 2);
    ctx.fillText('Fan', x0 - 6, fanY + fanH / 2);
    const segEnd = Math.max(endT, 1);
    for (const s of controlSegments(m.controls, 'heat', segEnd)) {
      const sx0 = xOf(s.from) + 0.5;
      const sx1 = xOf(Math.min(s.to, xMax)) - 0.5;
      if (sx1 - sx0 < 1) continue;
      ctx.fillStyle = '#2d3340';
      rrect(sx0, heatY, sx1 - sx0, heatH, 3);
      ctx.fill();
      if (sx1 - sx0 >= 14) {
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = 'center';
        ctx.font = `600 13px ${FONT}`;
        ctx.fillText(String(s.value), (sx0 + sx1) / 2, heatY + heatH / 2 + 0.5);
      }
    }
    for (const s of controlSegments(m.controls, 'fan', segEnd)) {
      const sx0 = xOf(s.from) + 0.5;
      const sx1 = xOf(Math.min(s.to, xMax)) - 0.5;
      if (sx1 - sx0 < 1) continue;
      const high = s.value === 'high';
      ctx.fillStyle = high ? '#3b4658' : '#1d2129';
      rrect(sx0, fanY, sx1 - sx0, fanH, 3);
      ctx.fill();
      if (!high) {
        ctx.strokeStyle = '#4a5263';
        ctx.lineWidth = 1;
        rrect(sx0 + 0.5, fanY + 0.5, sx1 - sx0 - 1, fanH - 1, 3);
        ctx.stroke();
      }
      const label = high ? 'High' : 'Low';
      ctx.font = `600 10px ${FONT}`;
      if (sx1 - sx0 >= ctx.measureText(label).width + 8) {
        ctx.fillStyle = high ? COLORS.text : COLORS.muted;
        ctx.textAlign = 'center';
        ctx.fillText(label, (sx0 + sx1) / 2, fanY + fanH / 2 + 0.5);
      }
    }

    // Time axis under the strip: minute labels, and a triangle wherever a cue fired.
    ctx.strokeStyle = COLORS.hair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(axisY) + 0.5);
    ctx.lineTo(x1, Math.round(axisY) + 0.5);
    ctx.stroke();
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = 0; t <= xMax; t += xStep) ctx.fillText(formatClock(t), xOf(t), axisY + 4);
    for (const c of m.cues || []) {
      if (c.t > xMax) continue;
      const x = xOf(c.t);
      ctx.fillStyle = cueColor(c);
      ctx.beginPath();
      ctx.moveTo(x - 4, axisY - 1);
      ctx.lineTo(x + 4, axisY - 1);
      ctx.lineTo(x, axisY - 8);
      ctx.closePath();
      ctx.fill();
    }

    // Direct labels for the curves, in the title row: a swatch of the line, then plain text.
    const items = [
      { color: COLORS.temp, text: `Probe temp ${unitLabel(units)}`, align: 'left' },
      { color: COLORS.ror, text: `Rate of rise ${unitLabel(units)}/min`, align: 'right' },
    ];
    if (refSmooth) items.splice(1, 0, { color: COLORS.ref, text: 'Reference', align: 'center' });
    ctx.font = `600 11px ${FONT}`;
    ctx.textBaseline = 'middle';
    const widths = items.map((it) => ctx.measureText(it.text).width + 20);
    const roomy = widths.reduce((a, b) => a + b, 0) + 16 <= W - 8;
    const shown = roomy ? items : items.filter((it) => it.align !== 'center');
    shown.forEach((it) => {
      const w = ctx.measureText(it.text).width + 20;
      const x = it.align === 'left' ? 4 : it.align === 'right' ? W - 4 - w : (W - w) / 2;
      ctx.strokeStyle = it.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, titleH / 2 + 0.5);
      ctx.lineTo(x + 14, titleH / 2 + 0.5);
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      ctx.fillText(it.text, x + 19, titleH / 2 + 1);
    });
  }

  return api;
}
