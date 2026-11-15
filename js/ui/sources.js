// The temperature source registry. Setup and the Roast screen know nothing about any one
// source: they look an entry up here. To add a source, call registerSource() with an entry;
// nothing in Setup needs to change.
//
// entry = {
//   id, label,
//   available: true,            // false: shown in the selector, but Start stays disabled with `unavailableReason`
//   unavailableReason,
//   keepAlive: false,           // true: the instance made for the Setup preview is the one used for the roast
//                               //   (a camera stream must not be torn down between Setup and Start).
//                               //   false: Start asks createSource() for a fresh one.
//   goodReadingsNeeded: 5,      // plausible values in a row before Start enables (manual: 1)
//   pollMs: 1000,               // how often Setup polls source.peek()
//   renderSetupPanel(container, ctx) -> cleanup | void   // Setup calls cleanup when the panel goes away
//   createSource(ctx) -> source (see DESIGN.md "Temperature source")
//   describe(ctx) -> 'Demo: On target, 10x'     // label for the Roast status strip
//   roastSpeed(ctx) -> 1                         // clock speed (the simulator can be 10)
//   renderRoastStatus?(container, source, { units }) -> cleanup | void   // optional element in the status strip (camera crop strip)
// }
//
// ctx = { state, units, settings, getSource(), changed(), enterReading(f) }
//   state: the Setup form state (state.preset, state.speed, state.manualValue, ...). A source panel may
//          keep its own settings on state.<id>.
//   changed(): call after a panel changes something that needs a new preview source.
//   getSource(): the current preview source.
//   enterReading(f): manual panels pass a typed °F value through here.

import { h, segmented } from './dom.js';
import { createNumpad } from './numpad.js';
import { PRESETS, createSimulatorSource } from '../sources/simulator-source.js';
import { createManualSource } from '../sources/manual-source.js';
import { cameraEntry, cameraSupported } from './camera-panel.js';
import { tempToUnit, unitLabel } from '../core/units.js';

const registry = new Map();
const order = [];

export function registerSource(entry) {
  if (!registry.has(entry.id)) order.push(entry.id);
  registry.set(entry.id, { available: true, keepAlive: false, goodReadingsNeeded: 5, pollMs: 1000, roastSpeed: () => 1, ...entry });
}

export const listSources = () => order.map((id) => registry.get(id));
export const getSource = (id) => registry.get(id) || null;

// ---- Camera: js/ui/camera-panel.js ----

registerSource(cameraEntry);

// The source Setup selects first: Camera when this page can open one, else Demo.
export const defaultSourceId = () => (cameraSupported() ? 'camera' : 'demo');

// ---- Demo: the simulator ----

registerSource({
  id: 'demo',
  label: 'Demo',
  pollMs: 400,
  renderSetupPanel(container, ctx) {
    const s = ctx.state;
    const current = () => PRESETS.find((p) => p.id === s.preset) || PRESETS[0];
    const desc = h('p', { class: 'muted small', id: 'preset-desc', style: 'margin-top:8px' }, current().description);
    const select = h('select', {
      id: 'preset', class: 'field-input', 'aria-label': 'Demo roast',
      onChange: (e) => { s.preset = e.target.value; desc.textContent = current().description; ctx.changed(); },
    }, ...PRESETS.map((p) => h('option', { value: p.id, selected: p.id === s.preset }, p.label)));
    const speed = segmented({
      label: 'Demo speed', cls: 'two', value: s.speed,
      options: [{ value: 1, label: '1x' }, { value: 10, label: '10x' }],
      onChange: (v) => { s.speed = v; ctx.changed(); },
    });
    speed.id = 'speed';
    container.append(
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Demo roast'), select),
      desc,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Speed'), speed));
  },
  createSource: (ctx) => createSimulatorSource({ preset: ctx.state.preset, seed: Math.floor(Math.random() * 1e6) + 1, heat: ctx.state.heat, fan: ctx.state.fan }),
  describe: (ctx) => `Demo: ${(PRESETS.find((p) => p.id === ctx.state.preset) || PRESETS[0]).label}, ${ctx.speed ?? ctx.state.speed}x`,
  roastSpeed: (ctx) => ctx.state.speed,
});

// ---- Manual ----

registerSource({
  id: 'manual',
  label: 'Manual',
  keepAlive: true,
  goodReadingsNeeded: 1,
  pollMs: 300,
  renderSetupPanel(container, ctx) {
    const units = ctx.units;
    const pad = createNumpad({
      units, enterLabel: 'Enter',
      onEnter: (f) => ctx.enterReading(f),
    });
    container.append(
      h('p', { class: 'muted' }, `Read the thermometer yourself and type the number. During the roast, tap Type reading to log a new value; the app logs a gap for every second without one. Type the current ${unitLabel(units)} reading to begin.`),
      pad);
  },
  createSource: () => createManualSource(),
  describe: () => 'Manual',
  tempLabel: (f, units) => `${Math.round(tempToUnit(f, units))}${unitLabel(units)}`,
});
