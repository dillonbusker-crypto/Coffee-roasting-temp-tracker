import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DIVIDERS, DIGIT_PITCH } from '../../js/ui/crop-box.js';
import { createCamera, expandBoxForDigits, DIGIT_EXTENSION } from '../../js/reader/camera.js';
import {
  BOX_VERSION, readStoredBox, loadBox, saveBox, convertLegacyBox, migrateStoredBox,
} from '../../js/ui/camera-panel.js';

// The box the user sees IS the reader's crop; an old saved box (no version) is converted once to the area the reader used to crop.

const KEY = 'rt.camera.box';
const mem = {};
globalThis.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const sameBox = (a, b) => { for (const k of ['x', 'y', 'w', 'h']) near(a[k], b[k], k); };

test('a new user gets a default box wide enough for three digit slots, saved boxes carry a version', () => {
  const { box, legacy } = readStoredBox();
  assert.equal(legacy, false);
  // The old default box widened for a 16:9 picture (0.85 of its height to the left).
  const widened = expandBoxForDigits({ x: 0.52, y: 0.3, w: 0.3, h: 0.22 }, 1280, 720);
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(box[k] - widened[k]) < 0.002, `${k}: ${box[k]} vs ${widened[k]}`);
  saveBox(box);
  assert.equal(JSON.parse(mem[KEY]).v, BOX_VERSION);
  assert.equal(readStoredBox().legacy, false);
});

test('a saved box without a version is old; one with the current version is not', () => {
  mem[KEY] = JSON.stringify({ x: 0.55, y: 0.36, w: 0.15, h: 0.18 });
  assert.equal(readStoredBox().legacy, true);
  mem[KEY] = JSON.stringify({ x: 0.55, y: 0.36, w: 0.15, h: 0.18, v: BOX_VERSION });
  assert.equal(readStoredBox().legacy, false);
  mem[KEY] = JSON.stringify({ x: 0.55, y: 0.36, w: 0.15, h: 0.18, v: 1 });
  assert.equal(readStoredBox().legacy, true, 'an unknown older version counts as old');
  mem[KEY] = 'not json';
  assert.equal(readStoredBox().legacy, false);
  assert.equal(readStoredBox().box.w > 0.3, true, 'garbage gives the default');
});

test('converting an old box gives exactly the area the reader used to crop', () => {
  for (const [vw, vh] of [[1280, 720], [1920, 1080], [1280, 960]]) {
    const old = { x: 0.43, y: 0.36, w: 0.146, h: 0.18 };
    const was = expandBoxForDigits(old, vw, vh);
    const now = convertLegacyBox(old, vw, vh);
    sameBox(now, was);
    near(now.x, old.x - DIGIT_EXTENSION * old.h * vh / vw, 'widened to the left by 0.85 of the box height');
    near(now.x + now.w, old.x + old.w, 'right edge unchanged');
  }
});

test('an old box near the left edge converts to the same clipped area', () => {
  const old = { x: 0.05, y: 0.3, w: 0.2, h: 0.3 };
  const was = expandBoxForDigits(old, 1280, 720);
  assert.equal(was.clipped, true);
  const now = convertLegacyBox(old, 1280, 720);
  sameBox(now, was);
  assert.equal(now.x, 0);
});

test('migrateStoredBox converts and saves once, and does nothing without a video size or for a new box', () => {
  const old = { x: 0.43, y: 0.36, w: 0.146, h: 0.18 };
  mem[KEY] = JSON.stringify(old);
  assert.equal(migrateStoredBox(0, 0), null, 'the video size is not known yet');
  assert.equal(JSON.parse(mem[KEY]).v, undefined, 'still the old box in storage');
  const next = migrateStoredBox(1280, 720);
  sameBox(next, convertLegacyBox(old, 1280, 720));
  assert.equal(JSON.parse(mem[KEY]).v, BOX_VERSION);
  sameBox(loadBox(), next);
  assert.equal(migrateStoredBox(1280, 720), null, 'already converted: the box is not widened a second time');
  sameBox(loadBox(), next);
});

function fakeVideo(vw, vh, draws) {
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ drawImage: (...a) => draws.push(a), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) }),
    }),
  };
  return { videoWidth: vw, videoHeight: vh, readyState: 4 };
}

test('the camera crops exactly the box: readerBox() and grabCrop() add nothing', () => {
  const draws = [];
  const video = fakeVideo(1280, 720, draws);
  const box = { x: 0.35, y: 0.36, w: 0.4, h: 0.18 };
  const cam = createCamera({ video, box });
  assert.deepEqual(cam.readerBox(), { ...box, clipped: false });
  const img = cam.grabCrop();
  const [, sx, sy, sw, sh] = draws[0];
  assert.deepEqual([sx, sy, sw, sh], [Math.round(0.35 * 1280), Math.round(0.36 * 720), Math.round(0.4 * 1280), Math.round(0.18 * 720)]);
  assert.equal(img.width, sw);
  assert.equal(cam.lastCrop.x, sx);
  assert.equal(cam.lastCrop.w, sw);
  assert.equal(cam.lastCrop.clipped, false);
});

test('the reader test page can still ask the camera for the widened crop', () => {
  const draws = [];
  const video = fakeVideo(1280, 720, draws);
  const box = { x: 0.5, y: 0.36, w: 0.15, h: 0.18 };
  const cam = createCamera({ video, box, widenForDigits: true });
  const rb = expandBoxForDigits(box, 1280, 720);
  assert.deepEqual(cam.readerBox(), rb);
  cam.grabCrop();
  assert.equal(draws[0][1], Math.round(rb.x * 1280));
  assert.equal(draws[0][3], Math.round(rb.w * 1280));
});

test('the dividers split the box into a wide hundreds slot and two digit slots of one pitch each', () => {
  const total = DIGIT_EXTENSION + 2 * DIGIT_PITCH;
  assert.equal(DIGIT_PITCH, 0.72);
  near(total, 2.29, 'total width in box heights');
  near(DIVIDERS[0], 0.85 / 2.29, 'first divider');
  near(DIVIDERS[1], 1.57 / 2.29, 'second divider');
  near(DIVIDERS[1] - DIVIDERS[0], DIGIT_PITCH / total, 'tens slot');
  near(1 - DIVIDERS[1], DIGIT_PITCH / total, 'ones slot');
  // A box converted from a tight two-digit box (1.44 heights wide) puts the dividers on the digit gaps.
  const h = 0.2, vw = 1280, vh = 720, tight = { x: 0.5, y: 0.3, w: 2 * DIGIT_PITCH * h * vh / vw, h };
  const box = convertLegacyBox(tight, vw, vh);
  near(box.x + box.w * DIVIDERS[0], tight.x, 'first divider at the left edge of the tens digit');
  near(box.x + box.w * DIVIDERS[1], tight.x + tight.w / 2, 'second divider between the two digits');
});
