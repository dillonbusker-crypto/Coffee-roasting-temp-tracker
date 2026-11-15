// Export and import. These build strings and objects; saving the file and picking one
// belong to the UI. The store is injectable (default: db.js) so the logic runs in Node.

import * as db from './db.js';
import { applyReferenceFlags } from './db.js';
import { analyzeSeries } from '../core/calc.js';
import { DEFAULTS, loadSettings, saveSettings, mergeSettings } from '../core/settings.js';

export const EXPORT_FORMAT = 'roast-tracker-export';
export const EXPORT_VERSION = 1;
export const ROAST_SCHEMA = 1;

export class ImportError extends Error {}

// ---- JSON export ----

export function buildExport({ roasts, settings, exportedAt = new Date() }) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(exportedAt).toISOString(),
    settings,
    roasts,
  };
}

export function exportFilename(exportedAt = new Date()) {
  return `roast-tracker-${new Date(exportedAt).toISOString().slice(0, 10)}.json`;
}

// Reads every roast and the settings, records lastExportAt, and returns the file contents.
export async function exportAll({ store = db, settings = loadSettings(), now = () => new Date() } = {}) {
  const exportedAt = now();
  const data = buildExport({ roasts: await store.listRoasts(), settings, exportedAt });
  await store.setMeta('lastExportAt', data.exportedAt);
  return { data, json: JSON.stringify(data, null, 2), filename: exportFilename(exportedAt) };
}

// ---- JSON import ----

// Returns a problem description, or null if the roast is usable.
export function validateRoast(r) {
  if (r === null || typeof r !== 'object') return 'not an object';
  if (typeof r.id !== 'string' || !r.id) return 'missing id';
  if (r.schema !== undefined && !(r.schema >= 1 && r.schema <= ROAST_SCHEMA)) return `unsupported schema ${r.schema}`;
  if (typeof r.startedAt !== 'string' || Number.isNaN(Date.parse(r.startedAt))) return 'bad startedAt';
  if (!Array.isArray(r.readings) || r.readings.some((v) => v !== null && !Number.isFinite(v))) return 'bad readings';
  if (r.events === null || typeof r.events !== 'object') return 'bad events';
  for (const name of ['yellow', 'firstCrack', 'drop']) {
    const e = r.events[name];
    if (e != null && !(Number.isFinite(e.t) && (e.f === null || Number.isFinite(e.f)))) return `bad ${name} event`;
  }
  if (r.controls !== undefined && !Array.isArray(r.controls)) return 'bad controls';
  if (r.cues !== undefined && !Array.isArray(r.cues)) return 'bad cues';
  return null;
}

// Fills in optional fields so older or hand-edited files still load.
export function normalizeRoast(r) {
  return {
    coffee: '',
    greenWeightG: null,
    roastedWeightG: null,
    weightLossPct: null,
    controls: [],
    cues: [],
    results: null,
    settings: {},
    reader: { source: 'unknown', secondsRead: 0, rejected: 0, secondsMissing: 0 },
    notes: '',
    score: null,
    ...r,
    schema: ROAST_SCHEMA,
    events: { yellow: null, firstCrack: null, drop: null, ...r.events },
    reference: { coffee: false, general: false, ...r.reference },
  };
}

// Text or object -> { roasts, settings }. Throws ImportError if this is not a usable export.
export function parseExport(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      throw new ImportError('This file is not valid JSON.');
    }
  }
  if (!data || data.format !== EXPORT_FORMAT) throw new ImportError('This is not a Roast Tracker export.');
  if (!(data.version >= 1) || data.version > EXPORT_VERSION) {
    throw new ImportError(`This export is version ${data.version}; this app reads up to version ${EXPORT_VERSION}.`);
  }
  if (!Array.isArray(data.roasts)) throw new ImportError('The export has no roasts list.');
  return { roasts: data.roasts, settings: data.settings ?? null, exportedAt: data.exportedAt ?? null };
}

// Key order does not matter.
const canonical = (v) =>
  v !== null && typeof v === 'object'
    ? Array.isArray(v)
      ? v.map(canonical)
      : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
    : v;
const sameJson = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Pure merge by id. Incoming roasts replace stored ones with the same id; roasts that are
// not in the file are kept. Returns what to save and the counts.
export function planImport(existing, incoming) {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const counts = { added: 0, updated: 0, unchanged: 0, invalid: 0 };
  const problems = [];
  const touched = new Set();
  const flagged = [];

  incoming.forEach((raw, index) => {
    const problem = validateRoast(raw);
    if (problem) {
      counts.invalid++;
      problems.push({ index, id: raw && raw.id, problem });
      return;
    }
    const roast = normalizeRoast(raw);
    const old = byId.get(roast.id);
    if (old && sameJson(old, roast)) { counts.unchanged++; return; }
    counts[old ? 'updated' : 'added']++;
    byId.set(roast.id, roast);
    touched.add(roast.id);
    if (roast.reference.coffee || roast.reference.general) flagged.push(roast.id);
  });

  // An imported reference flag may collide with one already on this phone: the import wins.
  for (const id of flagged) {
    const changed = applyReferenceFlags([...byId.values()], id, {});
    for (const c of changed) { byId.set(c.id, c); touched.add(c.id); }
  }

  return { toSave: [...touched].map((id) => byId.get(id)), counts, problems };
}

// Validates and merges an export into the store. Returns the counts and any problems.
export async function importAll(input, { store = db, restoreSettings = true, saveSettingsFn = saveSettings } = {}) {
  const { roasts, settings } = parseExport(input);
  const plan = planImport(await store.listRoasts(), roasts);
  for (const r of plan.toSave) await store.saveRoast(r);
  let settingsRestored = false;
  if (restoreSettings && settings && typeof settings === 'object') {
    settingsRestored = saveSettingsFn(mergeSettings(settings, DEFAULTS));
  }
  return { ...plan.counts, problems: plan.problems, settingsRestored };
}

// ---- CSV export (one roast) ----

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const num1 = (v) => (v == null ? '' : (Math.round(v * 10) / 10).toFixed(1));

export const CSV_HEADER = ['time (s)', 'temperature (°F)', 'smoothed temperature (°F)', 'rate of rise (°F/min)', 'event'];

// One row per elapsed second. Raw reading is the whole-°F value from the thermometer;
// smoothed and rate of rise are recomputed from it with the settings the roast used.
export function roastToCsv(roast) {
  const smoothSec = roast.settings?.smoothSec ?? DEFAULTS.smoothSec;
  const rorWindowSec = roast.settings?.rorWindowSec ?? DEFAULTS.rorWindowSec;
  const { smooth, ror } = analyzeSeries(roast.readings, smoothSec, rorWindowSec);

  const labels = new Map();
  const add = (t, label) => {
    if (!labels.has(t)) labels.set(t, []);
    labels.get(t).push(label);
  };
  add(0, 'Start');
  if (roast.events?.yellow) add(roast.events.yellow.t, 'Yellow');
  if (roast.events?.firstCrack) add(roast.events.firstCrack.t, 'First crack');
  if (roast.events?.drop) add(roast.events.drop.t, 'Drop');
  for (const c of roast.controls || []) {
    add(c.t, c.kind === 'heat' ? `Heat ${c.value}` : `Fan ${c.value}`);
  }

  const lines = [CSV_HEADER.join(',')];
  roast.readings.forEach((raw, t) => {
    lines.push([t, raw ?? '', num1(smooth[t]), num1(ror[t]), (labels.get(t) || []).join('; ')].map(csvCell).join(','));
  });
  return lines.join('\n') + '\n';
}

export function csvFilename(roast) {
  const slug = String(roast.coffee || 'roast').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'roast';
  return `${slug}-${String(roast.startedAt).slice(0, 10)}.csv`;
}
