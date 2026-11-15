'use strict';
// End-to-end test of the Roast review card on the After screen and the roast detail page, in
// headless Chromium at 390x844 (and 375x667). Screenshots go to ./out.
//
//   node test/browser/review.test.cjs
//
// Roasts are demo roasts run with ?speed. The on-target roast runs at 30x so that First crack and
// Drop land within a second of the intended times and every check can read on target.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startServer, launch } = require('./lib.cjs');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const step = (name) => console.log(`  - ${name}`);
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, name), ...opts });
const text = (page, sel) => page.locator(sel).first().textContent();
const waitHash = (page, hash, timeout = 20000) => page.waitForFunction((h) => location.hash === h, hash, { timeout });
const hOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const showReview = (page) => page.evaluate(() => document.getElementById('roast-review').scrollIntoView({ block: 'start' }));

async function newPage(browser, { width = 390, height = 844 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  // Demo source only: with no camera API the app defaults to it.
  await page.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  return { context, page, errors };
}

async function startRoast(page, base, { preset, coffee, speed }) {
  await page.goto(`${base}/index.html?nosw&speed=${speed}&undo=500#setup`);
  await page.waitForSelector('#preset');
  await page.selectOption('#preset', preset);
  await page.fill('#coffee', coffee);
  await page.waitForSelector('#start-btn:not([disabled])', { timeout: 10000 });
  await page.click('#start-btn');
  await waitHash(page, '#roast');
}

// First crack as the reading crosses 410°F, Drop when the 55 s countdown ends.
async function onTargetRoast(page, base, coffee) {
  await startRoast(page, base, { preset: 'on-target', coffee, speed: 30 });
  await page.waitForFunction(() => { const s = window.__rt.snapshot(); return s && s.raw[s.t] >= 410; }, null, { timeout: 60000 });
  await page.click('#ev-firstCrack');
  await page.waitForFunction(() => window.__rt.snapshot().devSec >= 55, null, { timeout: 30000 });
  await page.click('#ev-drop');
  await waitHash(page, '#after');
  await page.waitForSelector('#roast-review');
}

// The stall demo with the heat left alone, ended by hand once it has stalled.
async function stallRoast(page, base, coffee) {
  await startRoast(page, base, { preset: 'stall', coffee, speed: 60 });
  await page.waitForFunction(() => window.__rt.snapshot() && window.__rt.snapshot().t >= 330, null, { timeout: 40000 });
  await page.click('#end-roast');
  await page.click('[data-action="save"]');
  await waitHash(page, '#after');
  await page.waitForSelector('#roast-review');
}

// What the review card says: headline, and { id, status, chip, title, text } per row.
const readReview = (page) => page.evaluate(() => ({
  headline: document.getElementById('review-headline').textContent,
  kind: document.getElementById('review-headline').dataset.kind,
  rows: [...document.querySelectorAll('#review-list .review-item')].map((li) => ({
    id: li.dataset.id,
    status: li.dataset.status,
    chip: li.querySelector('.rv-chip') ? li.querySelector('.rv-chip').textContent : null,
    title: li.querySelector('.review-title').textContent,
    text: li.querySelector('.review-text').textContent,
  })),
}));
const row = (rv, id) => rv.rows.find((r) => r.id === id);

const unwrapped = (page) => page.evaluate(() => [...document.querySelectorAll('#roast-review .review-text, #roast-review .review-head, #review-headline')]
  .filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.id || e.className));

const roasts = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('roast-tracker');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const req = db.transaction('roasts').objectStore('roasts').getAll();
    req.onsuccess = () => { db.close(); resolve(req.result.sort((a, b) => a.startedAt.localeCompare(b.startedAt))); };
    req.onerror = () => reject(req.error);
  };
}));

async function waitStoredWeight(page, id, want) {
  for (let i = 0; i < 60; i++) {
    const r = (await roasts(page)).find((x) => x.id === id);
    if (r && r.roastedWeightG === want) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`roasted weight did not become ${want}`);
}

async function main() {
  const { srv, base } = await startServer();
  const browser = await launch();
  const allErrors = [];
  const finish = (label, errors) => { if (errors.length) allErrors.push(`${label}: ${errors.join(' | ')}`); };

  try {
    const A = await newPage(browser);
    const { page } = A;

    // ------------------------------------------------------------------ After: an on-target roast
    console.log('After: on-target roast');
    await onTargetRoast(page, base, 'Review Ethiopia');
    {
      step('The card is titled Roast review, sits after the chart and before the event details');
      assert.equal(await text(page, '#roast-review h2'), 'Roast review');
      const order = await page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return {
          afterChart: before(q('#summary-chart'), q('#roast-review')),
          afterTiles: before(q('#sum-dev'), q('#roast-review')),
          beforeEvents: before(q('#roast-review'), q('#sum-fc')),
          beforeLog: before(q('#roast-review'), q('#log-card')),
          oneCard: document.querySelectorAll('#roast-review').length,
        };
      });
      assert.deepEqual(order, { afterChart: true, afterTiles: true, beforeEvents: true, beforeLog: true, oneCard: 1 });

      step('First crack reads on target, with a word chip, and there is no weight-loss row before a weight');
      let rv = await readReview(page);
      assert.equal(row(rv, 'firstCrack').status, 'good');
      assert.equal(row(rv, 'firstCrack').chip, 'On target');
      assert.match(row(rv, 'firstCrack').text, /^First crack at 5:\d\d, inside the 5:00–5:30 window\.$/);
      assert.equal(row(rv, 'development').status, 'good');
      assert.match(row(rv, 'development').text, /^Development 0:5\d, .*Rao's guideline is 20–25%\.$/);
      assert.equal(row(rv, 'weightLoss'), undefined);
      assert.deepEqual(rv.rows.map((r) => r.id).slice(0, 5), ['firstCrack', 'development', 'totalTime', 'endTemp', 'rorShape']);
      assert.equal(row(rv, 'rorShape').status, 'good', row(rv, 'rorShape').text);
      assert.match(row(rv, 'rorShape').text, /^Rate of rise fell steadily from its peak of \d+°F\/min at 0:\d\d to \d+°F\/min at the drop\.$/);
      assert.match(rv.headline, /^On target: all 5 checks passed\.$/, rv.headline);
      assert.equal(rv.kind, 'good');
      assert.ok(!rv.rows.some((r) => r.status === 'info' && r.chip), 'info rows have no chip');

      step('Typing the roasted weight adds the weight-loss row and changes the headline, live');
      await page.fill('#roasted-weight', '79.9');
      await page.waitForSelector('#review-weightLoss');
      rv = await readReview(page);
      assert.equal(rv.rows[0].id, 'weightLoss');
      assert.equal(row(rv, 'weightLoss').status, 'good');
      assert.equal(row(rv, 'weightLoss').text, 'Weight loss 11.2%, inside the 11–12% band.');
      assert.match(rv.headline, /^On target: all 6 checks passed\.$/);
      await page.fill('#roasted-weight', '84');
      rv = await readReview(page);
      assert.equal(row(rv, 'weightLoss').status, 'off');
      assert.equal(row(rv, 'weightLoss').chip, 'Off target');
      assert.equal(row(rv, 'weightLoss').text, 'Weight loss 6.7%, 4.3 points under the 11–12% band.');
      assert.equal(rv.headline, '5 of 6 checks on target. Off target: weight loss.');
      assert.equal(rv.kind, 'bad');
      await page.fill('#roasted-weight', '80.5');
      rv = await readReview(page);
      assert.equal(row(rv, 'weightLoss').status, 'close');
      assert.equal(row(rv, 'weightLoss').chip, 'Close');
      assert.equal(row(rv, 'weightLoss').text, 'Weight loss 10.6%, 0.4 points under the 11–12% band.');
      assert.equal(rv.headline, '5 of 6 checks on target. Close: weight loss.');
      assert.equal(rv.kind, 'warn');
    }
    await page.fill('#roasted-weight', '79.9');
    {
      const rv = await readReview(page);
      assert.equal(row(rv, 'weightLoss').status, 'good');
      assert.match(rv.headline, /^On target: all 6 checks passed\.$/);
    }

    // ------------------------------------------------------------------ chip colors and layout
    {
      step('Chip colours: good green, off red; layout has no sideways overflow and nothing small to tap in the card');
      assert.equal(await page.locator('#review-firstCrack .rv-chip').evaluate((e) => getComputedStyle(e).color), 'rgb(74, 222, 128)');
      assert.equal(await page.locator('#roast-review button, #roast-review a, #roast-review input').count(), 0, 'rows are not tappable');
      assert.ok((await hOverflow(page)) <= 0);
      assert.deepEqual(await unwrapped(page), []);
      await showReview(page);
      await shot(page, 'review-after-all-good-390x844.png');
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, 'review-after-all-good-full.png', { fullPage: true });
    }

    step('Save, marking this roast as the reference for its coffee');
    await page.click('#ref-coffee');
    await page.click('#save-btn');
    await waitHash(page, '#history');

    // ------------------------------------------------------------------ After: a stalled roast
    console.log('After: stall roast, with the saved roast as its reference');
    // a second page in the same context, so the saved roast is there
    const page2 = await A.context.newPage();
    await page2.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); });
    const errors2 = [];
    page2.on('console', (m) => { if (m.type() === 'error') errors2.push(`console: ${m.text()}`); });
    page2.on('pageerror', (e) => errors2.push(`pageerror: ${e.message}`));
    page2.on('dialog', (d) => d.accept());
    await stallRoast(page2, base, 'Review Ethiopia');
    let stallReview;
    {
      step('A rate-of-rise row is flagged off target with the stall and its time');
      stallReview = await readReview(page2);
      const ror = row(stallReview, 'rorShape');
      assert.equal(ror.status, 'off');
      assert.equal(ror.chip, 'Off target');
      assert.match(ror.text, /^At \d:\d\d the rate of rise fell under 5°F\/min and stayed there for \d+ s/);
      const [, m, s] = /^At (\d+):(\d\d)/.exec(ror.text);
      const at = Number(m) * 60 + Number(s);
      assert.ok(at >= 150 && at <= 240, `stall at ${at}`);
      assert.ok(!/after (heat|fan)/.test(ror.text), 'no heat change logged yet');
      await page2.fill('#log-add-time', `${Math.floor((at - 12) / 60)}:${String((at - 12) % 60).padStart(2, '0')}`);
      await page2.click('#log-add-btn');
      await page2.waitForFunction(() => /after heat went from 2 to 3/.test(document.getElementById('review-rorShape').textContent));
      assert.match(row(await readReview(page2), 'rorShape').text, /That was 12 s after heat went from 2 to 3\./);
      assert.equal(row(stallReview, 'firstCrack').status, 'info', 'First crack was never marked');
      assert.equal(row(stallReview, 'development'), undefined);
      assert.equal(row(stallReview, 'endTemp'), undefined);
      assert.match(stallReview.headline, /Off target: .*rate of rise/);
      assert.equal(stallReview.kind, 'bad');
      const refRow = row(stallReview, 'reference');
      assert.ok(refRow, 'the saved roast of this coffee is the reference');
      assert.match(refRow.text, /^Biggest gap from the reference: \d+°F (above|below) at \d:\d\d\./);
      assert.match(row(stallReview, 'cues').text, /Stalling \d:\d\d/);
      assert.equal(row(stallReview, 'cues').chip, null);

      assert.ok((await hOverflow(page2)) <= 0);
      assert.deepEqual(await unwrapped(page2), []);
      await showReview(page2);
      await shot(page2, 'review-after-off-target-390x844.png');
      await page2.evaluate(() => window.scrollTo(0, 0));
      await shot(page2, 'review-after-off-target-full.png', { fullPage: true });
      await page2.setViewportSize({ width: 375, height: 667 });
      assert.ok((await hOverflow(page2)) <= 0, 'no overflow at 375');
      assert.deepEqual(await unwrapped(page2), []);
      await showReview(page2);
      await shot(page2, 'review-after-off-target-375x667.png');
      await page2.evaluate(() => window.scrollTo(0, 0));
      await shot(page2, 'review-after-off-target-375x667-full.png', { fullPage: true });
      await page2.setViewportSize({ width: 390, height: 844 });
    }
    step('Save with a weight');
    await page2.fill('#roasted-weight', '84');
    stallReview = await readReview(page2);
    await page2.click('#save-btn');
    await waitHash(page2, '#history');
    finish('stall roast', errors2);

    // ------------------------------------------------------------------ Detail pages
    console.log('Detail pages');
    const saved = await roasts(page2);
    assert.equal(saved.length, 2);
    const [rA, rB] = saved;
    assert.equal(rB.settings.referenceId, rA.id);
    {
      step('The stalled roast: the detail page shows the same review as the After screen');
      await page2.goto(`${base}/index.html?nosw#history/${encodeURIComponent(rB.id)}`);
      await page2.waitForSelector('#roast-review');
      await page2.waitForSelector('#review-reference');
      const rv = await readReview(page2);
      assert.deepEqual(rv, stallReview);
      const order = await page2.evaluate(() => {
        const q = (s) => document.querySelector(s);
        const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return before(q('#summary-chart'), q('#roast-review')) && before(q('#roast-review'), q('#sum-fc')) && before(q('#roast-review'), q('#review-card'));
      });
      assert.equal(order, true, 'after the chart, before the event details');
      assert.ok((await hOverflow(page2)) <= 0);
      assert.deepEqual(await unwrapped(page2), []);
      await showReview(page2);
      await shot(page2, 'review-detail-off-target-390x844.png');
      await page2.setViewportSize({ width: 375, height: 667 });
      assert.ok((await hOverflow(page2)) <= 0);
      assert.deepEqual(await unwrapped(page2), []);
      await showReview(page2);
      await shot(page2, 'review-detail-off-target-375x667.png');
      await page2.setViewportSize({ width: 390, height: 844 });

      step('Changing the roasted weight on the detail page updates the review as it is typed, and it stays after a reload');
      await page2.fill('#roasted-weight', '79.9');
      await page2.waitForFunction(() => /Weight loss 11\.2%/.test(document.getElementById('review-weightLoss').textContent));
      assert.equal(row(await readReview(page2), 'weightLoss').status, 'good');
      await page2.locator('#roasted-weight').blur();
      await page2.waitForFunction(() => /Saved at/.test(document.getElementById('save-status').textContent));
      await page2.reload();
      await page2.waitForSelector('#review-weightLoss');
      assert.equal(row(await readReview(page2), 'weightLoss').text, 'Weight loss 11.2%, inside the 11–12% band.');
      await page2.fill('#roasted-weight', '');
      await page2.waitForFunction(() => !document.getElementById('review-weightLoss'));
      await page2.locator('#roasted-weight').blur();
      await waitStoredWeight(page2, rB.id, null);
      await page2.fill('#roasted-weight', '79.9');
      await page2.locator('#roasted-weight').blur();
      await waitStoredWeight(page2, rB.id, 79.9);

      step('Reference flags: the roast that is its own coffee reference is not compared with itself');
      await page2.goto(`${base}/index.html?nosw#history/${encodeURIComponent(rA.id)}`);
      await page2.waitForSelector('#roast-review');
      assert.equal(await page2.getAttribute('#ref-coffee', 'aria-checked'), 'true');
      assert.equal(await page2.locator('#review-reference').count(), 0);
      await page2.click('#ref-coffee');          // off
      await page2.waitForFunction(() => document.getElementById('ref-coffee').getAttribute('aria-checked') === 'false');
      await page2.click('#ref-coffee');          // on again
      await page2.waitForFunction(() => document.getElementById('ref-coffee').getAttribute('aria-checked') === 'true');
      assert.equal(await page2.locator('#review-reference').count(), 0);
      const rvA = await readReview(page2);
      assert.equal(rvA.kind, 'good');
      assert.match(rvA.headline, /^On target: all 6 checks passed\.$/, rvA.headline);
      await page2.waitForFunction(() => document.getElementById('toast').hidden);
      await showReview(page2);
      await shot(page2, 'review-detail-all-good-390x844.png');
      await page2.setViewportSize({ width: 375, height: 667 });
      assert.ok((await hOverflow(page2)) <= 0);
      await showReview(page2);
      await shot(page2, 'review-detail-all-good-375x667.png');
      await page2.setViewportSize({ width: 390, height: 844 });
    }

    // ------------------------------------------------------------------ Units
    console.log('Units');
    {
      step('Switching to °C in Settings shows the review in °C, with no °F in the card');
      await page2.goto(`${base}/index.html?nosw#settings`);
      await page2.waitForSelector('#units-seg');
      await page2.click('#units-seg [data-value="C"]');
      await page2.goto(`${base}/index.html?nosw#history/${encodeURIComponent(rB.id)}`);
      await page2.waitForSelector('#review-reference');
      const rv = await readReview(page2);
      const all = [rv.headline, ...rv.rows.flatMap((r) => [r.title, r.text])].join(' ');
      assert.ok(!/°F/.test(all), `°F in the review: ${all}`);
      assert.match(row(rv, 'rorShape').text, /fell under 3°C\/min/);
      assert.match(row(rv, 'reference').text, /^Biggest gap from the reference: \d+°C (above|below) at \d:\d\d\./);
      assert.equal(row(rv, 'rorShape').status, 'off', 'verdicts do not depend on the unit');
      await showReview(page2);
      await shot(page2, 'review-detail-celsius-390x844.png');

      await page2.goto(`${base}/index.html?nosw#history/${encodeURIComponent(rA.id)}`);
      await page2.waitForSelector('#review-endTemp');
      assert.match(row(await readReview(page2), 'endTemp').text, /^Dropped \d+°C above the first-crack reading, inside the 8°C cap\.$/);
    }
    finish('detail', errors2);
    finish('first page', A.errors);

    assert.deepEqual(allErrors, [], `console errors or exceptions:\n${allErrors.join('\n')}`);
    console.log('\nreview.test.cjs: all checks passed');
  } finally {
    await browser.close();
    srv.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
