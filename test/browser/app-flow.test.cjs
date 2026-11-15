'use strict';
// End-to-end test of the roast flow in headless Chromium: Setup -> Roast -> After -> saved,
// Reference mode, the number pad, cues, dropouts, draft recovery. Screenshots go to ./out.
//
//   node test/browser/app-flow.test.cjs
//
// Uses the test-only URL parameters ?speed=N (demo clock multiplier), ?undo=ms and ?draft=ms.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const step = (name) => console.log(`  - ${name}`);

async function newPage(browser, base, { width = 390, height = 844 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  const go = (query = '', hash = '#setup') => page.goto(`${base}/${query}${hash}`);
  return { context, page, errors, go };
}

const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, name), ...opts });
const waitT = (page, sec, timeout = 40000) =>
  page.waitForFunction((s) => window.__rt.snapshot() && window.__rt.snapshot().t >= s, sec, { timeout });
const waitHash = (page, hash, timeout = 15000) =>
  page.waitForFunction((h) => location.hash === h, hash, { timeout });
const text = (page, sel) => page.locator(sel).first().textContent();

const readStore = (page, store) => page.evaluate((name) => new Promise((resolve, reject) => {
  const open = indexedDB.open('roast-tracker');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(name)) { resolve([]); return; }
    const req = db.transaction(name).objectStore(name).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  };
}), store);

const readDraft = async (page) => {
  const row = (await readStore(page, 'meta')).find((r) => r.key === 'draft');
  return row ? row.value : null;
};

// Every visible control must be at least 64px tall.
async function smallControls(page) {
  return page.evaluate(() => [...document.querySelectorAll('button, a.btn, a.navlink, input, select, textarea')]
    .filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')
    .map((e) => ({ what: e.id || e.getAttribute('aria-label') || e.className || e.tagName, h: Math.round(e.getBoundingClientRect().height * 10) / 10 }))
    .filter((x) => x.h < 63.5));
}

const noOverflow = (page) => page.evaluate(() => ({
  v: document.documentElement.scrollHeight - window.innerHeight,
  hz: document.documentElement.scrollWidth - window.innerWidth,
}));

async function startDemo(page, { preset, coffee }) {
  await page.selectOption('#preset', preset);
  if (coffee) await page.fill('#coffee', coffee);
  await page.waitForSelector('#start-btn:not([disabled])', { timeout: 10000 });
  await page.click('#start-btn');
  await waitHash(page, '#roast');
}

async function endAndDiscard(page) {
  await page.click('#end-roast');
  await page.click('[data-action="discard"]');
  await waitHash(page, '#setup');
}

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const allErrors = [];
  const finish = (label, errors) => { if (errors.length) allErrors.push(`${label}: ${errors.join(' | ')}`); };

  try {
    // ------------------------------------------------------------------ Setup behaviours
    console.log('Setup');
    {
      const { page, errors, go, context } = await newPage(browser, base);
      await go();
      await page.waitForSelector('#start-btn');
      step('Start is disabled until 5 good readings, and says why');
      assert.equal(await page.locator('#start-btn').isDisabled(), true);
      assert.match(await text(page, '#start-reason'), /Waiting for 5 good readings: \d of 5/);
      await page.waitForSelector('#start-btn:not([disabled])', { timeout: 10000 });
      assert.equal(await text(page, '#read-state'), 'Ready');
      assert.equal(await text(page, '#read-value'), '75°F');
      assert.equal(await text(page, '#mode-line'), 'Starter guardrails');
      step('Reminder card and wake-lock warning logic');
      assert.match(await text(page, '#reminder'), /alert temperature to its maximum, 572°F/);
      step('Camera shows a placeholder and cannot start');
      await page.click('[data-value="camera"]');
      assert.equal(await page.locator('#start-btn').isDisabled(), true);
      assert.match(await text(page, '#source-panel'), /Camera reading is coming/);
      step('Manual: one typed plausible value enables Start');
      await page.click('[data-value="manual"]');
      assert.equal(await page.locator('#start-btn').isDisabled(), true);
      assert.match(await text(page, '#start-reason'), /Type the current reading/);
      await page.click('#source-panel .np-key >> text="9"');
      await page.click('#source-panel #np-enter');
      assert.match(await text(page, '#source-panel .np-error'), /Type a reading from 50 to 550°F/);   // 9 is out of range
      assert.match(await text(page, '#start-reason'), /Type the current reading/);
      await page.click('#source-panel [aria-label="Delete"]');
      await page.click('#source-panel .np-key >> text="7"');
      await page.click('#source-panel .np-key >> text="5"');
      await page.click('#source-panel #np-enter');
      await page.waitForSelector('#start-btn:not([disabled])');
      assert.equal(await text(page, '#read-value'), '75°F');
      step('Setup controls are at least 64px tall, and nothing overflows sideways');
      assert.deepEqual(await smallControls(page), []);
      assert.equal((await noOverflow(page)).hz <= 0, true);
      await page.click('[data-value="demo"]');
      await page.waitForSelector('#start-btn:not([disabled])', { timeout: 10000 });
      await shot(page, 'setup.png');
      await shot(page, 'setup-full.png', { fullPage: true });
      finish('setup', errors);
      await context.close();
    }

    // ------------------------------------------------------------------ Main flow: roast 1
    console.log('Roast 1: full flow');
    const main = await newPage(browser, base);
    const { page } = main;
    {
      await main.go('?speed=30&undo=1500&draft=2000');
      await page.click('#source-seg [data-value="demo"]');
      await startDemo(page, { preset: 'on-target', coffee: 'Test Ethiopia' });

      step('Roast layout at 390x844');
      assert.equal(await page.locator('#probe-cell').isVisible(), true);
      assert.deepEqual(await smallControls(page), []);
      const probeFont = await page.$eval('#probe-temp', (e) => parseFloat(getComputedStyle(e.parentElement).fontSize));
      const rorFont = await page.$eval('#ror', (e) => parseFloat(getComputedStyle(e).fontSize));
      assert.ok(probeFont >= 72 && rorFont >= 40, `fonts ${probeFont} ${rorFont}`);
      assert.equal((await noOverflow(page)).v <= 0, true, 'roast screen must not scroll');
      assert.equal(await text(page, '#status-label'), 'Demo: On target, 30x');

      step('Yellow: stamp, Undo, stamp again');
      await waitT(page, 50);
      await page.click('#ev-yellow');
      await page.waitForSelector('#ev-yellow[data-state="undo"]');
      assert.match(await text(page, '#ev-yellow'), /Undo/);
      await page.click('#ev-yellow');
      await page.waitForSelector('#ev-yellow[data-state="ready"]');
      assert.equal(await page.evaluate(() => window.__rt.snapshot().events.yellow), null);

      step('Heat change is logged');
      await waitT(page, 100);
      await page.click('[data-heat="3"]');
      await page.waitForSelector('[data-heat="3"][aria-pressed="true"]');
      assert.equal(await page.evaluate(() => window.__rt.snapshot().heat), 3);

      await waitT(page, 140);
      await page.click('#ev-yellow');
      const yellowT = await page.evaluate(() => window.__rt.snapshot().events.yellow.t);
      assert.ok(yellowT >= 140 && yellowT < 200, `yellow at ${yellowT}`);
      await page.waitForFunction(() => document.getElementById('ev-yellow').dataset.state === 'stamped');
      assert.match(await text(page, '#ev-yellow'), /\d:\d\d · \d+°F/);

      step('First crack when the probe reaches the first-crack reading');
      await page.waitForFunction(() => window.__rt.snapshot().temp >= 395, null, { timeout: 40000 });
      await page.click('#ev-firstCrack');
      const fc = await page.evaluate(() => window.__rt.snapshot().events.firstCrack);
      assert.ok(fc && fc.f >= 380, `first crack ${JSON.stringify(fc)}`);
      await page.waitForFunction(() => document.getElementById('dev-label').textContent === 'Development');
      assert.equal(await page.getAttribute('#ev-drop', 'class').then((c) => c.includes('primary')), true, 'Drop becomes primary');

      step('Drop near the development target');
      await page.waitForFunction(() => window.__rt.snapshot().devSec >= 48, null, { timeout: 20000 });
      await page.click('#ev-drop');
      await waitHash(page, '#after');
    }

    step('After screen: summary, weight loss 11.2% in band, score, note, reference, save');
    {
      await page.waitForSelector('#roasted-weight');
      assert.match(await text(page, '#sum-fc'), /\d:\d\d · \d+°F/);
      assert.match(await text(page, '#sum-dev'), /\d:\d\d · \d+%/);
      await page.fill('#roasted-weight', '79.9');
      assert.match(await text(page, '#loss-text'), /11\.2%/);
      assert.equal(await page.getAttribute('#loss-text', 'data-band'), 'in');
      assert.equal(await text(page, '#loss-big'), '11.2%');
      await page.click('[data-score="4"]');
      await page.fill('#notes', 'Sweet, floral, light body.');
      await page.click('#ref-coffee');
      assert.equal(await page.getAttribute('#ref-coffee', 'aria-checked'), 'true');
      assert.deepEqual(await smallControls(page), []);
      const model = await page.evaluate(() => window.__rt.chartModel());
      assert.ok(model && model.smooth.length > 200, 'the After chart has the roast');
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, 'after.png');
      await shot(page, 'after-full.png', { fullPage: true });
      await page.click('#save-btn');
      await waitHash(page, '#history');
      assert.match(await text(page, '.screen.history'), /History/);
    }

    step('Saved record in IndexedDB');
    {
      const roasts = await readStore(page, 'roasts');
      assert.equal(roasts.length, 1);
      const r = roasts[0];
      assert.equal(r.coffee, 'Test Ethiopia');
      assert.equal(r.greenWeightG, 90);
      assert.equal(r.roastedWeightG, 79.9);
      assert.ok(Math.abs(r.weightLossPct - 11.22) < 0.01, String(r.weightLossPct));
      assert.equal(r.score, 4);
      assert.equal(r.notes, 'Sweet, floral, light body.');
      assert.deepEqual(r.reference, { coffee: true, general: false });
      assert.ok(r.events.yellow && r.events.firstCrack && r.events.drop, 'three events');
      assert.ok(r.events.yellow.t < r.events.firstCrack.t && r.events.firstCrack.t < r.events.drop.t);
      assert.ok(r.controls.length >= 3 && r.controls.some((c) => c.kind === 'heat' && c.value === 3), 'controls include the heat change');
      assert.ok(r.cues.length >= 1, 'cues were logged');
      assert.ok(r.cues.every((c) => typeof c.t === 'number' && c.id && c.text));
      assert.equal(r.readings.length, r.events.drop.t + 1);
      assert.equal(r.results.totalSec, r.events.drop.t);
      assert.ok(r.results.phases.development.sec > 40 && r.results.devPct > 5);
      assert.equal(r.reader.source, 'simulator');
      assert.equal(r.settings.mode, 'starter');
      assert.equal(await readDraft(page), null, 'draft cleared on save');
    }

    // ------------------------------------------------------------------ Roast 2: Reference mode
    console.log('Roast 2: Reference mode');
    {
      await main.go('?speed=20&undo=900');
      await page.waitForSelector('#coffee');
      await page.fill('#coffee', 'Test Ethiopia');
      await page.waitForFunction(() => /Reference: Test Ethiopia/.test(document.getElementById('mode-line').textContent));
      assert.equal(await page.getAttribute('#mode-line', 'data-mode'), 'reference');
      const refDev = (await readStore(page, 'roasts'))[0].results.devSec;
      assert.equal(await text(page, '#dev-value'), `${refDev} s`, 'development target comes from the reference');
      assert.equal(await page.locator('#dev-plus').isDisabled(), true);
      await page.fill('#coffee', 'Some other coffee');
      await page.waitForFunction(() => /Reference: general fallback|Starter guardrails/.test(document.getElementById('mode-line').textContent));
      assert.equal(await text(page, '#mode-line'), 'Starter guardrails', 'a coffee with no reference and no general one');
      await page.fill('#coffee', 'test ethiopia');
      await page.waitForFunction(() => /Reference: Test Ethiopia/.test(document.getElementById('mode-line').textContent));
      await page.waitForSelector('#start-btn:not([disabled])');
      await page.click('#start-btn');
      await waitHash(page, '#roast');
      await waitT(page, 30);

      step('The chart has the reference curve (model hook)');
      const ref = await page.evaluate(() => { const m = window.__rt.chartModel(); return m && m.reference ? { n: m.reference.smooth.length, label: m.reference.label } : null; });
      assert.ok(ref && ref.n > 200, `reference series ${JSON.stringify(ref)}`);
      assert.match(await text(page, '#banner'), /Reference: Test Ethiopia/);

      step('Mid-roast, after First crack, with a cue showing');
      await page.waitForFunction(() => window.__rt.snapshot().temp >= 395, null, { timeout: 40000 });
      await page.click('#ev-firstCrack');
      await page.waitForSelector('#banner[data-state="cue"]', { timeout: 20000 });
      await page.waitForTimeout(150);
      const cueText = await text(page, '#banner');
      assert.ok(/First crack soon|Fifteen seconds|Drop now|Running|Heat|Heat to/.test(cueText), cueText);
      await shot(page, 'roast-mid.png');

      step('Roast screen at 375x667: no scroll, all controls 64px or taller');
      await page.setViewportSize({ width: 375, height: 667 });
      await page.waitForTimeout(500);
      assert.deepEqual(await smallControls(page), []);
      const o = await noOverflow(page);
      assert.ok(o.v <= 0 && o.hz <= 0, `overflow ${JSON.stringify(o)}`);
      const chartSize = await page.evaluate(() => { const c = document.getElementById('chart').parentElement.getBoundingClientRect(); return { w: c.width, h: c.height }; });
      assert.ok(chartSize.h >= 140, `chart height ${chartSize.h}`);
      await shot(page, 'roast-375x667.png');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);

      step('Number pad types a reading into the roast');
      await page.click('#type-reading');
      await page.click('.sheet .np-key >> text="5"');
      await page.click('.sheet .np-key >> text="2"');
      await page.click('.sheet .np-key >> text="0"');
      assert.equal(await text(page, '#np-display'), '520°F');
      assert.deepEqual(await smallControls(page), []);
      await shot(page, 'numpad.png');
      await page.click('.sheet #np-enter');
      await page.waitForSelector('.sheet', { state: 'detached' });
      await page.waitForFunction(() => window.__rt.snapshot().raw.includes(520), null, { timeout: 5000 });

      step('Drop, then After shows the reference curve behind the roast');
      await page.waitForFunction(() => window.__rt.snapshot().devSec >= 45, null, { timeout: 30000 });
      await page.click('#ev-drop');
      await waitHash(page, '#after');
      await page.waitForFunction(() => { const m = window.__rt.chartModel(); return m && m.reference && m.reference.smooth.length > 100; }, null, { timeout: 5000 });
      await page.fill('#roasted-weight', '80');
      assert.equal(await page.getAttribute('#loss-text', 'data-band'), 'in');
      await page.fill('#roasted-weight', '82');
      assert.equal(await page.getAttribute('#loss-text', 'data-band'), 'under');
      assert.match(await text(page, '#loss-text'), /Under the 11–12% band/);
      await page.fill('#roasted-weight', '78');
      assert.equal(await page.getAttribute('#loss-text', 'data-band'), 'over');
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, 'after-ref.png');
      step('Discard asks first, then clears');
      await page.click('#discard-btn');
      await page.click('[data-action="keep"]');
      assert.equal(await page.evaluate(() => location.hash), '#after');
      await page.click('#discard-btn');
      await page.click('[data-action="discard"]');
      await waitHash(page, '#setup');
      assert.equal((await readStore(page, 'roasts')).length, 1, 'discarded roast is not saved');
      assert.equal(await readDraft(page), null);
    }
    finish('main', main.errors);
    await main.context.close();

    // ------------------------------------------------------------------ Cues: fast
    console.log('Cue: running hot');
    {
      const t = await newPage(browser, base);
      await t.go('?speed=30&undo=900');
      await t.page.click('#source-seg [data-value="demo"]');
      await startDemo(t.page, { preset: 'fast', coffee: 'Fast test' });
      await t.page.evaluate(() => {
        window.__banners = [];
        new MutationObserver(() => {
          const el = document.getElementById('banner-text');
          const s = el && el.textContent;
          if (s && !window.__banners.includes(s)) window.__banners.push(s);
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      await t.page.waitForFunction(() => window.__banners.some((b) => b.includes('Running hot')), null, { timeout: 25000 });
      const spoken = await t.page.evaluate(() => window.__rt.speechLog().filter((s) => s.text.includes('Running hot')));
      assert.ok(spoken.length >= 1 && spoken[0].how === 'beep', 'at fast demo speed a cue is a beep plus banner');
      const markers = await t.page.evaluate(() => window.__rt.chartModel().cues.map((c) => c.id));
      assert.ok(markers.includes('hot'), 'the cue is on the chart model');
      await endAndDiscard(t.page);
      finish('fast', t.errors);
      await t.context.close();
    }

    // ------------------------------------------------------------------ Cues: dropout
    console.log('Cue: lost reading');
    {
      const t = await newPage(browser, base);
      await t.go('?speed=30&undo=900');
      await t.page.click('#source-seg [data-value="demo"]');
      await startDemo(t.page, { preset: 'dropout', coffee: 'Dropout test' });
      await t.page.waitForSelector('#banner[data-state="lost"]', { timeout: 20000 });
      assert.match(await text(t.page, '#banner'), /Lost the reading/);
      assert.equal(await t.page.locator('#probe-cell.stale').count(), 1, 'temperature is dimmed while stale');
      await t.page.waitForFunction(() => document.getElementById('banner').dataset.state !== 'lost', null, { timeout: 10000 });
      const gaps = await t.page.evaluate(() => window.__rt.snapshot().raw.filter((v) => v === null).length);
      assert.ok(gaps >= 8, `gaps are stored as gaps: ${gaps}`);
      await endAndDiscard(t.page);
      finish('dropout', t.errors);
      await t.context.close();
    }

    // ------------------------------------------------------------------ Manual roast
    console.log('Manual source');
    {
      const t = await newPage(browser, base);
      await t.go('?undo=900');
      await t.page.click('[data-value="manual"]');
      for (const k of ['1', '2', '0']) await t.page.click(`#source-panel .np-key >> text="${k}"`);
      await t.page.click('#source-panel #np-enter');
      await t.page.waitForSelector('#start-btn:not([disabled])');
      await t.page.click('#start-btn');
      await waitHash(t.page, '#roast');
      assert.equal(await text(t.page, '#status-label'), 'Manual');
      await waitT(t.page, 2);
      assert.equal(await t.page.evaluate(() => window.__rt.snapshot().raw[0]), 120, 'the typed value became second 0');
      await t.page.click('#type-reading');
      for (const k of ['1', '2', '5']) await t.page.click(`.sheet .np-key >> text="${k}"`);
      await t.page.click('.sheet #np-enter');
      await waitT(t.page, 8, 20000);
      assert.notEqual(await t.page.getAttribute('#banner', 'data-state'), 'lost', 'lost cue is muted for a manual source');
      assert.ok(await t.page.evaluate(() => window.__rt.snapshot().raw.includes(125)));
      await t.page.click('#end-roast');
      await t.page.click('[data-action="save"]');
      await waitHash(t.page, '#after');
      assert.equal(await t.page.evaluate(() => window.__rt.chartModel().bridgeSec > 0), true);
      await t.page.click('#discard-btn');
      await t.page.click('[data-action="discard"]');
      await waitHash(t.page, '#setup');
      finish('manual', t.errors);
      await t.context.close();
    }

    // ------------------------------------------------------------------ Draft recovery
    console.log('Draft recovery');
    {
      const t = await newPage(browser, base);
      await t.go('?speed=30&draft=1000');
      await t.page.click('#source-seg [data-value="demo"]');
      await startDemo(t.page, { preset: 'on-target', coffee: 'Draft coffee' });
      await waitT(t.page, 90);
      await t.page.waitForFunction(() => true);
      let draft = null;
      for (let i = 0; i < 20 && !draft; i++) { draft = await readDraft(t.page); if (!draft) await t.page.waitForTimeout(200); }
      assert.ok(draft && draft.record.readings.length > 20, 'a draft is written during the roast');
      assert.equal(draft.record.coffee, 'Draft coffee');
      // The phone is killed mid-roast: reload.
      await t.go('?draft=1000');
      await t.page.waitForSelector('#draft-card:not([hidden])');
      assert.match(await text(t.page, '#draft-card'), /An interrupted roast was found/);
      await t.page.click('#draft-save');
      await waitHash(t.page, '#after');
      assert.match(await text(t.page, '.after'), /Draft coffee/);
      await t.page.fill('#roasted-weight', '80');
      await t.page.click('#save-btn');
      await waitHash(t.page, '#history');
      const saved = (await readStore(t.page, 'roasts'))[0];
      assert.equal(saved.coffee, 'Draft coffee');
      assert.ok(saved.readings.length > 20);
      assert.equal(await readDraft(t.page), null);
      await t.go('?draft=1000');
      await t.page.waitForSelector('#start-btn');
      await t.page.waitForTimeout(400);
      assert.equal(await t.page.locator('#draft-card:not([hidden])').count(), 0, 'no prompt once saved');
      finish('draft', t.errors);
      await t.context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (allErrors.length) {
    console.error('Console errors or uncaught exceptions:\n' + allErrors.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('app-flow: all checks passed. Screenshots in', OUT);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
