import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExport, exportAll, importAll, parseExport, planImport, roastToCsv, csvFilename,
  validateRoast, ImportError, EXPORT_FORMAT, CSV_HEADER,
} from '../../js/store/transfer.js';
import { applyReferenceFlags, pickReference } from '../../js/store/db.js';
import { DEFAULTS, mergeSettings } from '../../js/core/settings.js';
import { runRoast } from './harness.js';

// An in-memory store with the same surface as db.js.
function memoryStore(initial = []) {
  const roasts = new Map(initial.map((r) => [r.id, r]));
  const meta = new Map();
  return {
    roasts, meta,
    async listRoasts() { return [...roasts.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); },
    async saveRoast(r) { roasts.set(r.id, JSON.parse(JSON.stringify(r))); },
    async getRoast(id) { return roasts.get(id) ?? null; },
    async setMeta(k, v) { meta.set(k, v); },
    async getMeta(k) { return meta.get(k) ?? null; },
  };
}

function makeRoast(id, { coffee = 'Test', startedAt = '2026-11-14T10:00:00.000Z', preset = 'on-target', seed = 1 } = {}) {
  const run = runRoast({ preset, seed });
  // Heat and fan changes at known seconds (the harness user made none).
  const r = run.session.finish({ dropT: run.ctx.dropT });
  r.id = id;
  r.coffee = coffee;
  r.startedAt = startedAt;
  r.roastedWeightG = 79.8;
  r.weightLossPct = 11.33;
  r.notes = 'Bright, floral';
  r.score = 4;
  return r;
}

test('export -> import round-trip preserves roasts and settings', async () => {
  const a = makeRoast('a', { startedAt: '2026-11-10T10:00:00.000Z', seed: 1 });
  const b = makeRoast('b', { coffee: 'Colombia', startedAt: '2026-11-12T10:00:00.000Z', seed: 2 });
  b.reference = { coffee: true, general: false };
  const source = memoryStore([a, b]);
  const settings = mergeSettings({ units: 'C', devTargetSec: 60 });
  const { data, json, filename } = await exportAll({ store: source, settings, now: () => new Date('2026-11-15T08:00:00Z') });

  assert.equal(data.format, EXPORT_FORMAT);
  assert.equal(data.version, 1);
  assert.equal(data.exportedAt, '2026-11-15T08:00:00.000Z');
  assert.equal(data.roasts.length, 2);
  assert.equal(filename, 'roast-tracker-2026-11-15.json');
  assert.equal(await source.getMeta('lastExportAt'), '2026-11-15T08:00:00.000Z');

  const fresh = memoryStore();
  let saved = null;
  const result = await importAll(json, { store: fresh, saveSettingsFn: (s) => { saved = s; return true; } });
  assert.deepEqual({ added: result.added, updated: result.updated, unchanged: result.unchanged, invalid: result.invalid }, { added: 2, updated: 0, unchanged: 0, invalid: 0 });
  assert.equal(result.settingsRestored, true);
  assert.equal(saved.units, 'C');
  assert.equal(saved.devTargetSec, 60);
  assert.equal(saved.mute.hot, false);

  assert.deepEqual(await fresh.getRoast('a'), a);
  assert.deepEqual(await fresh.getRoast('b'), b);
  assert.deepEqual(await fresh.getRoast('a').then((r) => r.readings), a.readings);
});

test('import merges by id and reports counts', async () => {
  const a = makeRoast('a');
  const b = makeRoast('b', { coffee: 'Other', startedAt: '2026-11-12T10:00:00.000Z' });
  const store = memoryStore([a]);
  const edited = { ...a, notes: 'edited after export' };
  const file = buildExport({ roasts: [edited, b], settings: DEFAULTS, exportedAt: new Date('2026-11-15T00:00:00Z') });
  const res = await importAll(file, { store, restoreSettings: false });
  assert.equal(res.settingsRestored, false);
  assert.deepEqual([res.added, res.updated, res.unchanged, res.invalid], [1, 1, 0, 0]);
  assert.equal(store.roasts.size, 2);
  assert.equal(store.roasts.get('a').notes, 'edited after export');   // the file wins for a matching id

  // importing the same file again changes nothing
  const again = await importAll(JSON.stringify(file), { store, restoreSettings: false });
  assert.deepEqual([again.added, again.updated, again.unchanged, again.invalid], [0, 0, 2, 0]);
});

test('roasts already on the phone but not in the file are kept', async () => {
  const keep = makeRoast('keep');
  const incoming = makeRoast('new', { startedAt: '2026-11-13T10:00:00.000Z' });
  const store = memoryStore([keep]);
  await importAll(buildExport({ roasts: [incoming], settings: null }), { store });
  assert.deepEqual([...store.roasts.keys()].sort(), ['keep', 'new']);
});

test('an imported reference flag replaces the one already on the phone', async () => {
  const mine = makeRoast('mine', { coffee: 'Guji' });
  mine.reference = { coffee: true, general: true };
  const theirs = makeRoast('theirs', { coffee: ' guji', startedAt: '2026-11-13T10:00:00.000Z' });
  theirs.reference = { coffee: true, general: true };
  const store = memoryStore([mine]);
  await importAll(buildExport({ roasts: [theirs], settings: null }), { store });
  const all = await store.listRoasts();
  assert.deepEqual(all.filter((r) => r.reference.coffee).map((r) => r.id), ['theirs']);
  assert.deepEqual(all.filter((r) => r.reference.general).map((r) => r.id), ['theirs']);
  assert.equal(pickReference(all, 'Guji').id, 'theirs');
});

test('import validates: bad roasts are counted and skipped, bad files are refused', async () => {
  const good = makeRoast('good');
  const broken = [
    { ...makeRoast('x1'), readings: 'nope' },
    { ...makeRoast('x2'), readings: [1, 2, 'three'] },
    { ...makeRoast('x3'), startedAt: 'yesterday' },
    { ...makeRoast('x4'), id: '' },
    { ...makeRoast('x5'), events: null },
    { ...makeRoast('x6'), schema: 99 },
    null,
    'text',
  ];
  const store = memoryStore();
  const res = await importAll(buildExport({ roasts: [good, ...broken], settings: null }), { store });
  assert.equal(res.added, 1);
  assert.equal(res.invalid, broken.length);
  assert.equal(res.problems.length, broken.length);
  assert.deepEqual([...store.roasts.keys()], ['good']);

  await assert.rejects(importAll('not json', { store }), ImportError);
  await assert.rejects(importAll('{"hello":1}', { store }), /not a Roast Tracker export/);
  await assert.rejects(importAll({ format: EXPORT_FORMAT, version: 2, roasts: [] }, { store }), /version 2/);
  await assert.rejects(importAll({ format: EXPORT_FORMAT, version: 1 }, { store }), /roasts list/);
  assert.equal(validateRoast(makeRoast('ok')), null);
});

test('older files are filled in with defaults', () => {
  const minimal = { id: 'm', startedAt: '2026-11-01T00:00:00Z', readings: [75, 80, null], events: { drop: { t: 2, f: 80 } } };
  const plan = planImport([], [minimal]);
  const r = plan.toSave[0];
  assert.equal(plan.counts.added, 1);
  assert.deepEqual(r.controls, []);
  assert.deepEqual(r.reference, { coffee: false, general: false });
  assert.equal(r.events.firstCrack, null);
  assert.equal(r.score, null);
});

test('parseExport accepts text or an object', () => {
  const file = buildExport({ roasts: [], settings: { units: 'C' } });
  assert.deepEqual(parseExport(file).settings, { units: 'C' });
  assert.deepEqual(parseExport(JSON.stringify(file)).roasts, []);
});

// ---------- CSV ----------

test('CSV: one row per second, with events on the second they happened', () => {
  const run = runRoast({
    preset: 'on-target',
    user: (a) => {
      if (a.snapshot.t === 100) a.session.mark('yellow');
      if (a.snapshot.t === 150) a.session.setControl('heat', 3);
      if (a.snapshot.t === 200) a.session.setControl('fan', 'low');
      if (a.snapshot.t === 220) a.session.setControl('fan', 'high');
      if (!a.snapshot.events.firstCrack && a.snapshot.raw[a.snapshot.t] >= 410) a.session.mark('firstCrack');
      if (a.cues.some((c) => c.id === 'dropNow')) a.ctx.dropT = a.session.mark('drop').t;
    },
  });
  const roast = run.session.finish({ dropT: run.ctx.dropT });
  const csv = roastToCsv(roast);
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], CSV_HEADER.join(','));
  assert.deepEqual(CSV_HEADER, ['time (s)', 'temperature (°F)', 'smoothed temperature (°F)', 'rate of rise (°F/min)', 'event']);
  assert.equal(lines.length, roast.readings.length + 1);

  const rows = lines.slice(1).map((l) => l.split(','));
  rows.forEach((row, t) => {
    assert.equal(Number(row[0]), t);
    assert.equal(row[1], String(roast.readings[t]));
  });
  const eventsAt = (t) => rows[t][4];
  assert.equal(eventsAt(0), 'Start; Heat 2; Fan high');
  assert.equal(eventsAt(100), 'Yellow');
  assert.equal(eventsAt(150), 'Heat 3');
  assert.equal(eventsAt(200), 'Fan low');
  assert.equal(eventsAt(220), 'Fan high');
  assert.equal(eventsAt(roast.events.firstCrack.t), 'First crack');
  assert.equal(eventsAt(roast.events.drop.t), 'Drop');
  const labelled = rows.filter((r) => r[4]).map((r) => Number(r[0]));
  assert.deepEqual(labelled, [0, 100, 150, 200, 220, roast.events.firstCrack.t, roast.events.drop.t]);

  // smoothed and rate of rise: blank where unknown, numbers after that
  assert.equal(rows[3][3], '');                       // no rate in the first 30 s
  assert.ok(Number(rows[60][2]) > 0 && Number(rows[60][3]) > 0);
  assert.ok(Math.abs(Number(rows[60][2]) - roast.readings.slice(51, 61).reduce((a, b) => a + b, 0) / 10) < 0.06);
});

test('CSV: gaps are empty cells, and the filename is tidy', () => {
  const run = runRoast({ preset: 'dropout' });
  const roast = run.session.finish({ dropT: run.ctx.dropT });
  const rows = roastToCsv(roast).trimEnd().split('\n').slice(1).map((l) => l.split(','));
  assert.deepEqual(rows[125].slice(1, 4), ['', '', '']);
  assert.notEqual(rows[140][1], '');
  roast.coffee = 'Ethiopia, Guji "Natural"';
  roast.startedAt = '2026-11-14T10:00:00.000Z';
  assert.equal(csvFilename(roast), 'ethiopia-guji-natural-2026-11-14.csv');
  assert.equal(csvFilename({ coffee: '', startedAt: '2026-01-02T00:00:00Z' }), 'roast-2026-01-02.csv');
});
