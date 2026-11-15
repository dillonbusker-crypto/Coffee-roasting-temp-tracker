'use strict';
// Renders the PNG icons from icons/icon.svg with the global Playwright Chromium.
//   node tools/render-icons.cjs
// The maskable icon shrinks the mark to the safe zone so Android's mask never clips it.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const DIR = path.resolve(__dirname, '..', 'icons');
const svg = fs.readFileSync(path.join(DIR, 'icon.svg'), 'utf8');
const maskable = svg.replace('<g id="mark"', '<g id="mark" transform="translate(256 256) scale(0.72) translate(-256 -256)"');

const JOBS = [
  ['icon-192.png', 192, svg],
  ['icon-512.png', 512, svg],
  ['icon-maskable-512.png', 512, maskable],
  ['apple-touch-icon.png', 180, svg],
];

(async () => {
  const browser = await chromium.launch();
  for (const [file, size, source] of JOBS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const sized = source.replace('width="512" height="512"', `width="${size}" height="${size}"`);
    await page.setContent(`<!doctype html><body style="margin:0;background:#0f1115">${sized}</body>`);
    await page.screenshot({ path: path.join(DIR, file), clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log('wrote', file);
  }
  await browser.close();
})();
