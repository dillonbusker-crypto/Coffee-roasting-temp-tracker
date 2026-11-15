// Temperatures are stored in °F everywhere. These helpers only convert for display.

export const fToC = (f) => (f - 32) * 5 / 9;
export const cToF = (c) => c * 9 / 5 + 32;

// A rate (°F/min) converts by the scale factor alone: there is no offset.
export const rateFToC = (r) => r * 5 / 9;
export const rateCToF = (r) => r * 9 / 5;

export const unitLabel = (units = 'F') => (units === 'C' ? '°C' : '°F');

// °F value -> number in the display unit (unrounded). null stays null.
export function tempToUnit(f, units = 'F') {
  if (f == null || Number.isNaN(f)) return null;
  return units === 'C' ? fToC(f) : f;
}

// number typed in the display unit -> °F
export function tempFromUnit(v, units = 'F') {
  if (v == null || Number.isNaN(v)) return null;
  return units === 'C' ? cToF(v) : v;
}

export function rateToUnit(r, units = 'F') {
  if (r == null || Number.isNaN(r)) return null;
  return units === 'C' ? rateFToC(r) : r;
}

// formatTemp(410) -> "410°F"; formatTemp(410, 'C') -> "210.0°C"; null -> "—"
export function formatTemp(f, units = 'F', { digits, unit = true } = {}) {
  const v = tempToUnit(f, units);
  if (v === null) return '—';
  const d = digits ?? (units === 'C' ? 1 : 0);
  return v.toFixed(d) + (unit ? unitLabel(units) : '');
}

// formatRate(35.2) -> "+35°F/min"
export function formatRate(r, units = 'F', { digits = 0, unit = true, sign = true } = {}) {
  const v = rateToUnit(r, units);
  if (v === null) return '—';
  const s = v.toFixed(digits);
  const signed = sign && v > 0 && Number(s) !== 0 ? '+' + s : s;
  return signed + (unit ? unitLabel(units) + '/min' : '');
}

// 395 -> "6:35"; null -> "—"
export function formatClock(sec) {
  if (sec == null || Number.isNaN(sec)) return '—';
  const neg = sec < 0;
  const s = Math.round(Math.abs(sec));
  return (neg ? '-' : '') + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
