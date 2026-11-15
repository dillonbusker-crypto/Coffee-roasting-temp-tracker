// Simulated thermometer. A first-order model of the roaster:
//   dT/dt = (Tenv - T) / tau,  Tenv = ambient + excess * heatFactor * fanFactor * disturbance(t)
// with whole-°F output like the TP17. Presets are parameter sets plus scripted
// disturbances, so changing heat or fan during a demo changes the curve.

const AMBIENT_F = 75;
const REFERENCE_FC_F = 410;   // the provisional first-crack reading the presets are tuned to
const HEAT_STEP = 0.15;       // each heat step changes the heating power by 15% of heat 2
const FAN_LOW_FACTOR = 1.06;  // less air flow, hotter chamber

// Excess over ambient (at heat 2, fan high, no disturbance) for a curve that
// reaches REFERENCE_FC_F at reachSec.
const excessFor = (reachSec, tau) => (REFERENCE_FC_F - AMBIENT_F) / (1 - Math.exp(-reachSec / tau));

// Piecewise-linear power multiplier: [[t, m], ...] sorted by t, held flat outside.
const ramp = (points) => (t) => {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, m1] = points[i];
    if (t <= t1) {
      const [t0, m0] = points[i - 1];
      return m0 + ((m1 - m0) * (t - t0)) / (t1 - t0);
    }
  }
  return points[points.length - 1][1];
};

export const PRESETS = [
  { id: 'on-target', label: 'On target', description: 'First crack reading at about 5:15, rate of rise falling steadily.' },
  { id: 'fast', label: 'Fast', description: 'Reaches the first-crack reading at about 3:30.' },
  { id: 'slow', label: 'Slow', description: 'Reaches the first-crack reading at about 7:45.' },
  { id: 'stall', label: 'Stall', description: 'Rate of rise flattens near 3:00 until the heat is raised.' },
  { id: 'ror-climb', label: 'Rate of rise climbing', description: 'Rate of rise turns upward around 3:00 to 3:30.' },
  { id: 'dropout', label: 'Dropouts', description: 'On target, with the reading missing at 2:00-2:12 and 3:30-3:38.' },
];

const MODELS = {
  'on-target': { tau: 150, excess: excessFor(315, 150) },
  fast: { tau: 150, excess: excessFor(210, 150) },
  slow: { tau: 250, excess: excessFor(465, 250) },
  stall: { tau: 150, excess: excessFor(315, 150), power: ramp([[130, 1], [155, 0.65]]) },
  'ror-climb': { tau: 150, excess: excessFor(315, 150), power: ramp([[165, 1], [200, 1.3]]) },
  dropout: { tau: 150, excess: excessFor(315, 150), gaps: [[120, 132], [210, 218]] },
};

// Small deterministic PRNG so a seed reproduces a roast exactly.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function heatFactor(heat) {
  return 1 + HEAT_STEP * (heat - 2);
}

// Options: preset, seed, noise (°F standard deviation before rounding),
// heat, fan (initial settings), replay (a saved roast record to play back).
export function createSimulatorSource({
  preset = 'on-target', seed = 1, noise = 0.3, heat = 2, fan = 'high', replay = null,
} = {}) {
  const model = replay ? null : MODELS[preset];
  if (!replay && !model) throw new Error(`Unknown simulator preset: ${preset}`);

  let rand = mulberry32(seed);
  let T = AMBIENT_F;
  let simT = 0;                 // the second T belongs to
  let curHeat = heat;
  let curFan = fan;
  let series = [];              // output per second, cached so sample(t) is repeatable
  let last = null;              // latest sampled value
  let running = false;
  let secondsRead = 0;
  let secondsMissing = 0;

  const gauss = () => {
    const u = 1 - rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  function reset() {
    rand = mulberry32(seed);
    T = AMBIENT_F;
    simT = 0;
    series = [];
    last = null;
    secondsRead = 0;
    secondsMissing = 0;
  }

  function step() {
    const power = model.power ? model.power(simT) : 1;
    const env = AMBIENT_F + model.excess * heatFactor(curHeat) * (curFan === 'low' ? FAN_LOW_FACTOR : 1) * power;
    T = env + (T - env) * Math.exp(-1 / model.tau);
    simT += 1;
  }

  function generate(t) {
    if (replay) {
      const v = replay.readings[t];
      return v === undefined ? null : v;
    }
    while (simT < t) step();
    const inGap = (model.gaps || []).some(([a, b]) => t >= a && t < b);
    const value = Math.round(T + noise * gauss());
    return inGap ? null : value;
  }

  return {
    kind: 'simulator',
    preset: replay ? 'replay' : preset,

    async start() {
      reset();
      running = true;
    },
    stop() {
      running = false;
    },
    get running() {
      return running;
    },

    // Instantaneous read for the Setup screen: the latest sample, or room temperature before Start.
    peek() {
      if (last === null && series.length === 0) {
        return { value: replay ? (replay.readings.find((v) => v != null) ?? null) : Math.round(AMBIENT_F), status: 'ok' };
      }
      return last === null ? { value: null, status: 'none' } : { value: last, status: 'ok' };
    },

    // The reading for elapsed second t. Call with t = 0, 1, 2, ... (repeat calls are fine).
    sample(t) {
      if (t < series.length) return series[t];
      for (let i = series.length; i <= t; i++) {
        const v = generate(i);
        series.push(v);
        if (v == null) secondsMissing++; else secondsRead++;
      }
      last = series[t];
      return last;
    },

    // Applies from the next second the model steps through.
    setControl(kind, value) {
      if (kind === 'heat') curHeat = value;
      else if (kind === 'fan') curFan = value;
    },

    health() {
      return { secondsRead, rejected: 0, secondsMissing };
    },
  };
}
