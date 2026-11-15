import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, loadSettings, saveSettings, resetSettings, STORAGE_KEY } from '../../js/core/settings.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

test('defaults carry every spec target', () => {
  assert.equal(DEFAULTS.devTargetSec, 55);
  assert.equal(DEFAULTS.devMinSec, 45);
  assert.equal(DEFAULTS.devMaxSec, 65);
  assert.equal(DEFAULTS.greenWeightG, 90);
  assert.equal(DEFAULTS.startHeat, 2);
  assert.equal(DEFAULTS.startFan, 'high');
  assert.equal(DEFAULTS.expectedFcF, 410);
  assert.equal(DEFAULTS.fcWindowStartSec, 300);
  assert.equal(DEFAULTS.fcWindowEndSec, 330);
  assert.equal(DEFAULTS.paceEarlySec, 240);
  assert.equal(DEFAULTS.paceLateSec, 420);
  assert.equal(DEFAULTS.paceStartSec, 150);
  assert.equal(DEFAULTS.totalTargetSec, 390);
  assert.equal(DEFAULTS.endTempCapF, 15);
  assert.equal(DEFAULTS.weightLossMinPct, 11);
  assert.equal(DEFAULTS.weightLossMaxPct, 12);
  assert.equal(DEFAULTS.rorWindowSec, 30);
  assert.equal(DEFAULTS.smoothSec, 10);
  assert.equal(DEFAULTS.referenceBandF, 10);
  assert.equal(DEFAULTS.persistSec, 10);
  assert.equal(DEFAULTS.stallRorFPerMin, 5);
  assert.equal(DEFAULTS.climbRorFPerMin, 5);
  assert.equal(DEFAULTS.climbAfterSec, 120);
  assert.equal(DEFAULTS.climbLookbackSec, 60);
  assert.equal(DEFAULTS.fcSoonF, 10);
  assert.equal(DEFAULTS.lostSec, 5);
  assert.equal(DEFAULTS.correctiveCooldownSec, 20);
  assert.equal(DEFAULTS.sameCueRepeatSec, 40);
  assert.equal(DEFAULTS.climbHoldoffSec, 45);
  assert.equal(DEFAULTS.replayUndoWindowSec, 20);
  assert.equal(DEFAULTS.fanPrompt, false);
  assert.equal(DEFAULTS.units, 'F');
  assert.deepEqual(DEFAULTS.reader, { minF: 50, maxF: 550, maxJumpF: 15, fps: 4 });
  assert.ok(Object.values(DEFAULTS.mute).every((v) => v === false));
});

test('load merges stored values over defaults, including new keys and nested objects', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ devTargetSec: 60, mute: { hot: true } }) });
  const s = loadSettings(storage);
  assert.equal(s.devTargetSec, 60);
  assert.equal(s.mute.hot, true);
  assert.equal(s.mute.slow, false);       // default kept
  assert.equal(s.expectedFcF, 410);       // key absent from storage
  assert.equal(s.reader.fps, 4);
});

test('save, load and reset round-trip; defaults are never mutated', () => {
  const storage = fakeStorage();
  const s = loadSettings(storage);
  s.units = 'C';
  s.mute.lost = true;
  assert.equal(saveSettings(s, storage), true);
  assert.equal(loadSettings(storage).units, 'C');
  assert.equal(DEFAULTS.units, 'F');
  assert.equal(DEFAULTS.mute.lost, false);
  const r = resetSettings(storage);
  assert.equal(r.units, 'F');
  assert.equal(loadSettings(storage).units, 'F');
});

test('does not throw without localStorage, or with corrupt or wrong-typed data', () => {
  assert.equal(typeof localStorage, 'undefined');
  assert.equal(loadSettings().devTargetSec, 55);
  assert.equal(saveSettings({ a: 1 }), false);
  assert.equal(resetSettings().devTargetSec, 55);
  assert.equal(loadSettings(fakeStorage({ [STORAGE_KEY]: '{not json' })).devTargetSec, 55);
  assert.equal(loadSettings(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ devTargetSec: 'x', units: 5 }) })).devTargetSec, 55);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(loadSettings(throwing).units, 'F');
  assert.equal(saveSettings({}, throwing), false);
  assert.doesNotThrow(() => resetSettings(throwing));
});
