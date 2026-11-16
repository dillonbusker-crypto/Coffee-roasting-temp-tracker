// Owns one roast. No DOM, so it runs from Node with an injected clock.
//
//   clock tick t -> source.sample(t) (or a typed reading) -> session.addReading
//                -> engine.tick(snapshot) -> for each cue: session.logCue, speak, banner
//                -> emit a view to the screen
//
// Events (Yellow, First crack, Drop) get a real-time Undo window. Drop is special: when its
// window ends the roast is finished with finish({ dropT }); readings keep being logged
// during the window so an Undo costs nothing.

import { createClock } from '../core/clock.js';
import { createSession } from '../core/session.js';
import { createCueEngine, projectedFirstCrack } from '../core/cues.js';

const SEVERITY = { critical: 3, corrective: 2, info: 1 };
const EVENT_NAMES = ['yellow', 'firstCrack', 'drop'];

export function createRoastController({
  source,
  settings,
  coffee = '',
  greenWeightG = 90,
  heat = 2,
  fan = 'high',
  mode = 'starter',
  reference = null,
  speed = 1,
  clock = null,                      // injectable; default is a real 1 Hz clock at `speed`
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  timers = { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (id) => globalThis.clearTimeout(id) },
  speech = null,                     // { say(text, { priority, silent }) }
  saveDraft = null,                  // (record) => void | Promise
  undoMs = 5000,
  draftMs = 10000,
  bannerMs = 6000,
  initialReading = null,             // typed value that becomes second 0 (manual source)
  startedAt = new Date().toISOString(),
}) {
  const manual = source.kind === 'manual';
  // A typed-reading roast has a gap almost every second; "lost the reading" would never stop.
  const engineSettings = manual
    ? { ...settings, mute: { ...(settings.mute || {}), lost: true } }
    : settings;
  const session = createSession({ coffee, greenWeightG, heat, fan, settings, mode, reference, source, startedAt });
  const engine = createCueEngine({ settings: engineSettings, mode, reference });
  const clk = clock || createClock({ speed });
  const minF = settings.reader?.minF ?? 50;
  const maxF = settings.reader?.maxF ?? 550;

  const listeners = new Set();
  const doneListeners = new Set();
  const undo = {};              // name -> { until, timer }
  const fired = [];             // every cue so far, with kind
  let phase = 'idle';           // idle | running | done | aborted
  let banner = null;            // { id, text, kind, at }
  let typed = null;             // typed reading waiting for the next second
  let lastDraftAt = now();
  let record = null;
  let off = null;

  const snap = () => session.snapshot();

  // A camera source tallies why seconds were not read; the saved record's reader health carries it as reader.missReasons.
  function finish(args) {
    const rec = session.finish(args);
    try {
      const m = source.health && source.health().missReasons;
      if (m && rec.reader && Object.keys(m).length) rec.reader.missReasons = { ...m };
    } catch { /* the tally is a bonus */ }
    return rec;
  }

  function draftNow(rec) {
    if (!saveDraft) return;
    try {
      const p = saveDraft(rec);
      if (p && p.catch) p.catch(() => {});
    } catch { /* a failed draft must never stop the roast */ }
  }

  function view() {
    const s = snap();
    const t = now();
    const remaining = {};
    for (const n of EVENT_NAMES) remaining[n] = undo[n] ? Math.max(0, undo[n].until - t) : null;
    let projectedFc = null;
    if (phase === 'running' && !s.events.firstCrack) {
      try { projectedFc = projectedFirstCrack(s, settings); } catch { projectedFc = null; }
    }
    const lostCueOn = !(engineSettings.mute && engineSettings.mute.lost);
    return {
      phase,
      snapshot: s,
      speed: clk.speed,
      sourceKind: source.kind,
      mode: s.mode,
      banner: banner && t - banner.at < bannerMs ? banner : null,
      lost: phase === 'running' && lostCueOn && s.t > 0 && s.secondsSinceReading >= (settings.lostSec ?? 5),
      undoMs: remaining,
      dropPending: !!(s.events.drop && undo.drop),
      projectedFc,
      cues: fired,
      record,
    };
  }

  function emit() {
    const v = view();
    for (const fn of [...listeners]) fn(v);
  }

  // ---- the loop ----

  function onTick(t, { missed } = {}) {
    if (phase !== 'running') return;
    let v = source.sample(t, { missed: !!missed });
    if (typed !== null) { v = typed; typed = null; }
    session.addReading(v);
    const s = snap();
    const cues = engine.tick(s);
    if (cues.length) handleCues(cues);
    if (now() - lastDraftAt >= draftMs) {
      lastDraftAt = now();
      draftNow(finish({ dropT: s.t }));
    }
    emit();
  }

  function handleCues(cues) {
    for (const c of cues) {
      session.logCue(c);
      fired.push({ t: c.t, id: c.id, text: c.text, kind: c.kind });
    }
    const top = cues.reduce((a, b) => (SEVERITY[b.kind] > SEVERITY[a.kind] ? b : a));
    const text = cues.map((c) => c.text).join(' ');
    banner = { id: top.id, text, kind: top.kind, at: now() };
    if (speech) {
      try { speech.say(text, { priority: top.kind === 'critical' ? 'critical' : 'normal', silent: clk.speed > 1 }); } catch { /* banner still shows */ }
    }
  }

  // ---- public controls ----

  async function start() {
    if (phase !== 'idle') return;
    await source.start();
    phase = 'running';
    if (initialReading != null) typeReading(initialReading);
    off = clk.onTick(onTick);
    clk.start();
  }

  // A typed value becomes the next second's reading, for any source.
  function typeReading(f) {
    const v = Math.round(Number(f));
    if (!Number.isFinite(v) || v < minF || v > maxF) return { ok: false, reason: `outside ${minF}-${maxF}` };
    if (manual) return source.enter(v);
    typed = v;
    if (source.reanchor) source.reanchor(v);   // a camera source re-anchors its filter here
    return { ok: true, value: v };
  }

  function armUndo(name) {
    cancelUndo(name);
    undo[name] = { until: now() + undoMs, timer: timers.setTimeout(() => lock(name), undoMs) };
  }

  function cancelUndo(name) {
    if (undo[name]) { timers.clearTimeout(undo[name].timer); delete undo[name]; }
  }

  function lock(name) {
    delete undo[name];
    if (phase !== 'running') return;
    if (name === 'drop') finalize(snap().events.drop.t);
    else emit();
  }

  function mark(name) {
    if (phase !== 'running' || !EVENT_NAMES.includes(name)) return null;
    if (snap().events[name]) return null;     // already stamped: undo it first, or it is locked
    const ev = session.mark(name);
    armUndo(name);
    emit();
    return ev;
  }

  function unmark(name) {
    if (phase !== 'running' || !undo[name]) return false;
    cancelUndo(name);
    session.unmark(name);
    emit();
    return true;
  }

  function setControl(kind, value) {
    if (phase !== 'running') return null;
    const entry = session.setControl(kind, value);
    emit();
    return entry;
  }

  function stopAll() {
    for (const n of EVENT_NAMES) cancelUndo(n);
    clk.stop();
    if (off) { off(); off = null; }
    try { source.stop && source.stop(); } catch { /* ignore */ }
  }

  function finalize(dropT) {
    stopAll();
    record = finish({ dropT });
    phase = 'done';
    draftNow(record);
    emit();
    for (const fn of [...doneListeners]) fn(record);
    return record;
  }

  // End now with whatever is logged (End roast, Save what's logged).
  function end() {
    if (phase === 'done') return record;
    if (phase !== 'running') return null;
    const s = snap();
    return finalize(s.events.drop ? s.events.drop.t : s.t);
  }

  function abort() {
    if (phase === 'done' || phase === 'aborted') return;
    stopAll();
    phase = 'aborted';
    emit();
  }

  return {
    start, mark, unmark, setControl, typeReading, end, abort,
    poll: () => clk.poll(),                 // call when the page becomes visible again
    setSpeed: (n) => clk.setSpeed(n),
    view,
    snapshot: snap,
    get phase() { return phase; },
    get record() { return record; },
    get session() { return session; },
    source,
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onDone(fn) { doneListeners.add(fn); return () => doneListeners.delete(fn); },
  };
}
