// Every target and threshold in the spec lives here, so each one is a setting.
// Temperatures are °F, times are seconds, rates are °F/min.

export const STORAGE_KEY = 'rt.settings';

// Cues the user can mute (fanPrompt has its own on/off switch).
export const CUE_LABELS = {
  hot: 'Running hot',
  slow: 'Running slow',
  stall: 'Stall',
  rorClimb: 'Rate of rise climbing',
  fcSoon: 'First crack soon',
  dev15: 'Fifteen seconds',
  dropNow: 'Drop now',
  endTemp: 'End temperature',
  lost: 'Lost reading',
  replay: 'Replay prompts',
};

export const DEFAULTS = {
  units: 'F',

  // Setup
  greenWeightG: 90,
  startHeat: 2,
  startFan: 'high',

  // Starter guardrails (Mode 1)
  devTargetSec: 55,
  devMinSec: 45,
  devMaxSec: 65,
  expectedFcF: 410,            // provisional first-crack reading for this probe
  fcWindowStartSec: 300,       // first crack expected 5:00-5:30
  fcWindowEndSec: 330,
  paceEarlySec: 240,           // first crack projected before this: running hot
  paceLateSec: 420,            // projected after this: running slow
  paceStartSec: 150,           // pace cues start here (2:30) and run to first crack
  totalTargetSec: 390,
  endTempCapF: 15,             // end temperature = expected first-crack reading + this
  weightLossMinPct: 11,
  weightLossMaxPct: 12,

  // Maths
  rorWindowSec: 30,            // 15, 30 or 45
  smoothSec: 10,
  projectionLagSec: 45,        // how far back projectFirstCrack looks for the earlier rate

  // Cue thresholds
  referenceBandF: 10,
  persistSec: 10,
  stallRorFPerMin: 5,
  climbRorFPerMin: 5,
  climbAfterSec: 120,
  climbLookbackSec: 60,
  fcSoonF: 10,
  lostSec: 5,
  correctiveCooldownSec: 20,
  sameCueRepeatSec: 40,
  climbHoldoffSec: 45,
  replayUndoWindowSec: 20,

  fanPrompt: false,
  mute: {
    hot: false, slow: false, stall: false, rorClimb: false, fcSoon: false,
    dev15: false, dropNow: false, endTemp: false, lost: false, replay: false,
  },

  // Reading filter and camera
  reader: { minF: 50, maxF: 550, maxJumpF: 15, fps: 7.5 },
};

export const ROR_WINDOW_OPTIONS = [15, 30, 45];

const clone = (o) => JSON.parse(JSON.stringify(o));
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Stored values win over defaults. Keys missing from storage take their default,
// so settings added in an update appear. A stored value of the wrong type is ignored.
export function mergeSettings(stored, defaults = DEFAULTS) {
  const out = clone(defaults);
  if (!isPlain(stored)) return out;
  for (const key of Object.keys(stored)) {
    const d = defaults[key];
    const v = stored[key];
    if (d === undefined) { out[key] = v; continue; }
    if (isPlain(d)) {
      if (isPlain(v)) out[key] = mergeSettings(v, d);
    } else if (typeof d === typeof v && (typeof v !== 'number' || Number.isFinite(v))) {
      out[key] = v;
    }
  }
  return out;
}

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // Safari can throw when site data is blocked
  }
}

export function loadSettings(storage = defaultStorage()) {
  try {
    const raw = storage && storage.getItem(STORAGE_KEY);
    const out = mergeSettings(raw ? JSON.parse(raw) : null);
    // 4 was the old default frame rate, saved along with everything else. The reader now needs 7.5 (reader/confirm.js).
    if (out.reader.fps === 4) out.reader.fps = DEFAULTS.reader.fps;
    return out;
  } catch {
    return clone(DEFAULTS);
  }
}

// Returns true if the write went through.
export function saveSettings(settings, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function resetSettings(storage = defaultStorage()) {
  try {
    if (storage) storage.removeItem(STORAGE_KEY);
  } catch { /* nothing to clear */ }
  return clone(DEFAULTS);
}
