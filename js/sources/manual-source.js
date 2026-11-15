// Manual entry: the user types a reading on a number pad. Typed readings are sparse, so
// every second without one is a gap. During a camera roast the same object holds a
// typed value for the camera source to inject (takePending) and re-anchor its filter.
//
// Typed values are °F. Convert from °C before calling enter().

export function createManualSource({ minF = 50, maxF = 550 } = {}) {
  let pending = null;       // typed since the last sample()
  let last = null;          // most recent accepted value, for peek()
  let running = false;
  let secondsRead = 0;
  let secondsMissing = 0;
  let rejected = 0;

  return {
    kind: 'manual',

    async start() {
      running = true;
      pending = null;
      secondsRead = 0;
      secondsMissing = 0;
      rejected = 0;
    },
    stop() {
      running = false;
    },
    get running() {
      return running;
    },

    // Accepts a number or numeric text. Returns { ok: true, value } or { ok: false, reason }.
    enter(input) {
      const text = typeof input === 'string' ? input.trim() : input;
      const v = typeof text === 'string' && text === '' ? NaN : Number(text);
      if (!Number.isFinite(v)) { rejected++; return { ok: false, reason: 'not a number' }; }
      const value = Math.round(v);
      if (value < minF || value > maxF) { rejected++; return { ok: false, reason: `outside ${minF}-${maxF}` }; }
      pending = value;
      last = value;
      return { ok: true, value };
    },

    // The typed value waiting for its second, if any; clears it.
    takePending() {
      const v = pending;
      pending = null;
      return v;
    },

    peek() {
      return last === null ? { value: null, status: 'none' } : { value: last, status: 'ok' };
    },

    // The reading for elapsed second t: whatever was typed since the last call, else a gap.
    sample() {
      const v = pending;
      pending = null;
      if (v === null) secondsMissing++; else secondsRead++;
      return v;
    },

    setControl() {},

    health() {
      return { secondsRead, rejected, secondsMissing };
    },
  };
}
