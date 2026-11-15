'use strict';
// End-to-end test of History, roast detail, the heat and fan log editor, Settings, export and
// import, and the offline install, in headless Chromium at 390x844 (and a few checks at 375x667).
// Screenshots go to ./out.
//
//   node test/browser/history-settings.test.cjs
//
// Roasts are seeded by running real demo roasts with ?speed=60. Pages other than the offline and
// update checks load with ?nosw so the service worker cannot get in the way.

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

// A static server. `sw` lets a test change what /sw.js serves, to simulate a new release.
function serve() {
  const state = { swTransform: null };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      if (p === '/sw.js' && state.swTransform) data = Buffer.from(state.swTransform(data.toString('utf8')));
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

const step = (name) => console.log(`  - ${name}`);
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, name), ...opts });
const text = (page, sel) => page.locator(sel).first().textContent();
const waitHash = (page, hash, timeout = 15000) => page.waitForFunction((h) => location.hash === h, hash, { timeout });
const waitT = (page, sec, timeout = 40000) =>
  page.waitForFunction((s) => window.__rt.snapshot() && window.__rt.snapshot().t >= s, sec, { timeout });

async function newPage(browser, base, { width = 390, height = 844, context = null } = {}) {
  const ctx = context || await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage();
  // These tests run the Demo and Manual sources; camera behaviour is in camera.test.cjs. With no camera API the app defaults to Demo.
  await page.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  const go = (query = '?nosw', hash = '#setup') => page.goto(`${base}/${query}${hash}`);
  return { context: ctx, page, errors, go };
}

const readStore = (page, store) => page.evaluate((name) => new Promise((resolve, reject) => {
  const open = indexedDB.open('roast-tracker');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(name)) { resolve([]); return; }
    const req = db.transaction(name).objectStore(name).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  };
}), store);

const roasts = async (page) => (await readStore(page, 'roasts')).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const storedSettings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('rt.settings') || 'null'));

async function pollRoast(page, id, pred, what, timeout = 6000) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    last = (await readStore(page, 'roasts')).find((r) => r.id === id);
    if (last && pred(last)) return last;
    await page.waitForTimeout(80);
  }
  assert.fail(`Timed out waiting for ${what}. Last stored: ${JSON.stringify(last && { notes: last.notes, score: last.score, w: last.roastedWeightG, c: last.controls })}`);
}

async function smallControls(page) {
  return page.evaluate(() => [...document.querySelectorAll('button, a.btn, a.navlink, input, select, textarea, summary')]
    .filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')
    .map((e) => ({ what: e.id || e.getAttribute('aria-label') || e.className || e.tagName, h: Math.round(e.getBoundingClientRect().height * 10) / 10 }))
    .filter((x) => x.h < 63.5));
}
const hOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// Runs a demo roast to the After screen, then saves it with the given weight and score.
async function demoRoast(page, base, { coffee, weight, score = null, heatAt = null }) {
  await page.goto(`${base}/?nosw&speed=60&undo=500#setup`);
  await page.waitForSelector('#preset');
  await page.fill('#coffee', coffee);
  await page.waitForSelector('#start-btn:not([disabled])', { timeout: 10000 });
  await page.click('#start-btn');
  await waitHash(page, '#roast');
  if (heatAt) { await waitT(page, heatAt.t); await page.click(`[data-heat="${heatAt.heat}"]`); }
  await page.waitForFunction(() => window.__rt.snapshot().temp >= 395, null, { timeout: 40000 });
  await page.click('#ev-firstCrack');
  await page.waitForFunction(() => window.__rt.snapshot().devSec >= 48, null, { timeout: 20000 });
  await page.click('#ev-drop');
  await waitHash(page, '#after');
  await page.fill('#roasted-weight', String(weight));
  if (score) await page.click(`[data-score="${score}"]`);
  await page.click('#save-btn');
  await waitHash(page, '#history');
}

async function openGroup(page, id) {
  const open = await page.$eval(`#group-${id}`, (d) => d.open);
  if (!open) await page.click(`#group-${id} > summary`);
}

async function setField(page, id, value) {
  await page.fill(`#${id}`, value);
  await page.locator(`#${id}`).blur();
}

async function main() {
  const { server, state } = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const allErrors = [];
  const finish = (label, errors) => { if (errors.length) allErrors.push(`${label}: ${errors.join(' | ')}`); };

  try {
    const main = await newPage(browser, base);
    const { page } = main;

    // ------------------------------------------------------------------ History: empty
    console.log('History: empty');
    {
      await main.go('?nosw', '#history');
      await page.waitForSelector('#history-empty');
      step('Empty state points to Setup, and the backup reminder says Never exported');
      assert.match(await text(page, '#history-empty'), /No roasts yet/);
      assert.equal(await page.getAttribute('#empty-setup', 'href'), '#setup');
      assert.equal(await text(page, '#last-export'), 'Never exported');
      assert.match(await text(page, '#backup-card'), /Clearing browser data deletes/);
      assert.equal(await page.locator('#export-all').isVisible(), true);
      assert.equal(await page.locator('#import-btn').isVisible(), true);
      assert.deepEqual(await smallControls(page), []);
      assert.ok((await hOverflow(page)) <= 0);
      await shot(page, 'history-empty.png');
      step('Settings and detail routes are not stubs; an unknown detail id says so');
      await page.goto(`${base}/?nosw#history/nope`);
      await page.waitForSelector('#detail-title');
      assert.equal(await text(page, '#detail-title'), 'Roast not found');
    }

    // ------------------------------------------------------------------ Seed three roasts
    console.log('Seeding three demo roasts');
    await demoRoast(page, base, { coffee: 'Ethiopia Guji', weight: 79.9, score: 4, heatAt: { t: 60, heat: 3 } });
    await demoRoast(page, base, { coffee: 'Colombia Huila', weight: 84 });
    await demoRoast(page, base, { coffee: 'Ethiopia Guji', weight: 76, score: 2 });
    const seeded = await roasts(page);
    assert.equal(seeded.length, 3);
    const [A, B, C] = seeded;     // oldest first
    assert.ok(A.controls.length >= 3, 'roast A has a logged heat change');

    // ------------------------------------------------------------------ History list
    console.log('History: list');
    {
      await main.go('?nosw', '#history');
      await page.waitForSelector('.hist-row');
      step('Three rows, newest first, with the right columns');
      const rows = page.locator('.hist-row');
      assert.equal(await rows.count(), 3);
      const expected = [C, B, A];
      for (let i = 0; i < 3; i++) {
        const r = expected[i];
        const row = rows.nth(i);
        assert.equal(await row.getAttribute('data-id'), r.id);
        assert.equal(await row.locator('.hist-coffee').textContent(), r.coffee);
        assert.match(await row.locator('.hist-date').textContent(), /2026/);
        const vals = await row.locator('.stat-value').allTextContents();
        assert.deepEqual(vals, [
          clock(r.events.firstCrack.t), clock(r.results.devSec),
          `${Number(r.weightLossPct.toFixed(1)).toFixed(1)}%`, r.score == null ? '—' : String(r.score),
        ], `row ${i} values`);
      }
      step('Weight loss outside the band is flagged with a word and a colour');
      assert.equal(await rows.nth(0).locator('.stat[data-flag="over"]').count(), 1);
      assert.match(await rows.nth(0).locator('.stat[data-flag] .stat-label').textContent(), /over/i);
      assert.equal(await rows.nth(1).locator('.stat[data-flag="under"]').count(), 1);
      assert.match(await rows.nth(1).locator('.stat[data-flag] .stat-label').textContent(), /under/i);
      assert.equal(await rows.nth(2).locator('.stat[data-flag]').count(), 0, 'in the band: no flag');
      const warnColor = await rows.nth(0).locator('.stat[data-flag] .stat-value').evaluate((e) => getComputedStyle(e).color);
      assert.equal(warnColor, 'rgb(251, 191, 36)');
      step('Layout: controls 64px or taller, no sideways overflow, 390 and 375 wide');
      assert.deepEqual(await smallControls(page), []);
      assert.ok((await hOverflow(page)) <= 0);
      await shot(page, 'history.png');
      await page.setViewportSize({ width: 375, height: 667 });
      assert.deepEqual(await smallControls(page), []);
      assert.ok((await hOverflow(page)) <= 0, 'no overflow at 375');
      await shot(page, 'history-375x667.png');
      await page.setViewportSize({ width: 390, height: 844 });
    }

    // ------------------------------------------------------------------ Detail: review edits
    console.log('Detail: edit review fields');
    {
      await page.locator('.hist-row').nth(2).click();     // roast A
      await waitHash(page, `#history/${encodeURIComponent(A.id)}`);
      await page.waitForSelector('#sum-fc');
      step('Summary and chart are shown; the log line is replaced by the editor');
      assert.match(await text(page, '#sum-fc'), /\d:\d\d · \d+°F/);
      assert.equal(await page.locator('#summary-chart').count(), 1);
      let model = await page.evaluate(() => window.__rt.chartModel());
      assert.ok(model && model.smooth.length > 200 && model.units === 'F');
      assert.equal(await page.locator('#summary-host :text("Heat and fan log:")').count(), 0);
      assert.equal(await page.locator('#log-editor').count(), 1);
      assert.equal(await text(page, '#detail-title'), 'Ethiopia Guji');
      assert.match(await text(page, '#save-status'), /save as you make them/);
      assert.deepEqual(await smallControls(page), []);
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, 'detail.png');
      await shot(page, 'detail-full.png', { fullPage: true });

      step('Score, notes and roasted weight save on change and survive a reload');
      await page.click('[data-score="5"]');
      await pollRoast(page, A.id, (r) => r.score === 5, 'score 5');
      await page.fill('#notes', 'Jasmine, peach, tea-like finish.');
      await page.locator('#notes').blur();
      await pollRoast(page, A.id, (r) => r.notes === 'Jasmine, peach, tea-like finish.', 'notes');
      await page.fill('#roasted-weight', '80.5');
      assert.equal(await text(page, '#loss-big'), '10.6%', 'loss recomputes as you type');
      assert.equal(await page.getAttribute('#loss-text', 'data-band'), 'under');
      await page.locator('#roasted-weight').blur();
      const saved = await pollRoast(page, A.id, (r) => r.roastedWeightG === 80.5, 'roasted weight');
      assert.ok(Math.abs(saved.weightLossPct - 10.56) < 0.01, String(saved.weightLossPct));
      assert.match(await text(page, '#save-status'), /^Saved at/);
      await page.fill('#roasted-weight', '0');
      await page.locator('#roasted-weight').blur();
      assert.match(await text(page, '#weight-error'), /above 0 g/);
      assert.equal((await pollRoast(page, A.id, () => true, 'unchanged')).roastedWeightG, 80.5, 'a bad weight is not saved');
      await page.reload();
      await page.waitForSelector('#sum-fc');
      assert.equal(await page.inputValue('#roasted-weight'), '80.5');
      assert.equal(await page.inputValue('#notes'), 'Jasmine, peach, tea-like finish.');
      assert.equal(await page.getAttribute('[data-score="5"]', 'aria-checked'), 'true');
      assert.equal(await text(page, '#loss-big'), '10.6%');
      await page.click('[data-score="5"]');      // tapping again clears
      await pollRoast(page, A.id, (r) => r.score === null, 'score cleared');
      await page.click('[data-score="5"]');
      await pollRoast(page, A.id, (r) => r.score === 5, 'score back to 5');
      step('Notes typed and left without a blur are still saved (debounce, and flush on leaving)');
      await page.fill('#notes', 'Typed, then left.');
      await page.click('#back-history');
      await waitHash(page, '#history');
      await pollRoast(page, A.id, (r) => r.notes === 'Typed, then left.', 'notes flushed on unmount');
      step('The History row follows the edit');
      await page.waitForSelector('.hist-row');
      const row = page.locator(`.hist-row[data-id="${A.id}"]`);
      assert.deepEqual(await row.locator('.stat-value').allTextContents().then((v) => v.slice(2)), ['10.6%', '5']);
    }

    // ------------------------------------------------------------------ Detail: log editor
    console.log('Detail: heat and fan log editor');
    {
      await page.click(`.hist-row[data-id="${A.id}"]`);
      await page.waitForSelector('#log-editor .log-row');
      const total = (await pollRoast(page, A.id, () => true, 'A')).results.totalSec;
      const ctl = () => page.evaluate(() => window.__rt.chartModel().controls);
      const stored = async () => (await pollRoast(page, A.id, () => true, 'A')).controls;
      const before = await ctl();
      assert.deepEqual(before, A.controls);
      step('Rows: two t=0 entries (no delete, value editable), then the logged change');
      const rows = page.locator('#log-list .log-row');
      assert.equal(await rows.count(), A.controls.length);
      assert.equal(await rows.nth(0).locator('.log-del').count(), 0);
      assert.equal(await rows.nth(1).locator('.log-del').count(), 0);
      assert.equal(await rows.nth(0).locator('input.log-time').count(), 0, 'the start time is fixed');
      assert.equal(await rows.nth(2).locator('.log-del').count(), 1);
      const idx = A.controls.findIndex((c) => c.t > 0);
      const changed = A.controls[idx];

      step('Edit the time of a change: re-sorts, chart model and storage follow');
      await rows.nth(idx).locator('.log-time').fill('2:30');
      await rows.nth(idx).locator('.log-time').blur();
      await pollRoast(page, A.id, (r) => r.controls.some((c) => c.t === 150 && c.kind === changed.kind), 'time edit');
      let c = await ctl();
      assert.ok(c.some((e) => e.t === 150 && e.kind === changed.kind && e.value === changed.value));
      assert.equal(c.length, before.length);
      assert.deepEqual(c, [...c].sort((a, b) => a.t - b.t), 'stays sorted');

      step('Edit a value');
      const rowAt = async (t) => {
        const i = await page.evaluate((txt) => [...document.querySelectorAll('#log-list .log-row')].findIndex((r) => r.querySelector('input.log-time') && r.querySelector('input.log-time').value === txt), clock(t));
        assert.ok(i >= 0, `a row at ${clock(t)}`);
        return rows.nth(i);
      };
      await (await rowAt(150)).locator('select.log-value').selectOption(changed.kind === 'heat' ? '5' : 'low');
      await pollRoast(page, A.id, (r) => r.controls.some((e) => e.t === 150 && String(e.value) === (changed.kind === 'heat' ? '5' : 'low')), 'value edit');
      assert.ok((await ctl()).some((e) => e.t === 150 && String(e.value) === (changed.kind === 'heat' ? '5' : 'low')));

      step('Start values are editable but never deletable');
      await rows.nth(0).locator('select.log-value').selectOption('4');
      await pollRoast(page, A.id, (r) => r.controls[0].t === 0 && r.controls[0].value === 4, 'start heat');
      assert.equal((await ctl())[0].value, 4);

      step('Add a change (fan to Low at 3:00)');
      await page.click('#log-add-kind [data-value="fan"]');
      await page.fill('#log-add-time', '3:00');
      await page.selectOption('#log-add-value', 'low');
      await shot(page, 'log-editor.png');      // mid-edit: the add form is filled in
      await page.click('#log-add-btn');
      await pollRoast(page, A.id, (r) => r.controls.some((e) => e.t === 180 && e.kind === 'fan' && e.value === 'low'), 'added entry');
      c = await ctl();
      assert.equal(c.length, before.length + 1);
      assert.deepEqual(c, [...c].sort((a, b) => a.t - b.t));
      assert.equal(await page.inputValue('#log-add-time'), '', 'the form clears');
      assert.match(await text(page, '#sum-changes'), new RegExp(`${before.length - 1} changes`), 'summary count follows');

      step('Times clamp to the roast length, and bad times explain themselves');
      await page.fill('#log-add-time', '99:00');
      await page.click('#log-add-btn');
      await pollRoast(page, A.id, (r) => r.controls.some((e) => e.t === total && e.kind === 'fan'), 'clamped entry');
      assert.match(await text(page, '#log-error'), new RegExp(`set to ${clock(total)}`));
      await page.fill('#log-add-time', 'soon');
      await page.click('#log-add-btn');
      assert.match(await text(page, '#log-error'), /Type a time like 1:30/);
      assert.equal((await stored()).length, before.length + 2, 'a bad time adds nothing');

      step('Delete entries');
      const del = async (t) => (await rowAt(t)).locator('.log-del');
      await (await del(total)).click();
      await pollRoast(page, A.id, (r) => r.controls.length === before.length + 1, 'delete clamped');
      await (await del(180)).click();
      await pollRoast(page, A.id, (r) => r.controls.length === before.length, 'delete added');
      assert.equal((await ctl()).length, before.length);
      assert.equal((await ctl())[0].t, 0);
      await page.fill('#log-add-time', 'x');
      assert.deepEqual(await smallControls(page), []);
      await page.locator('#log-card').scrollIntoViewIfNeeded();
      await shot(page, 'log-editor-error.png');
    }

    // ------------------------------------------------------------------ References
    console.log('References: tag moves');
    {
      const tagsOn = async () => page.evaluate(() => [...document.querySelectorAll('.hist-row')].map((r) => ({ id: r.dataset.id, tags: [...r.querySelectorAll('.tag')].map((t) => t.textContent) })));
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.click('#ref-coffee');
      await page.waitForSelector('#detail-tags [data-tag="reference"]');
      assert.equal(await page.getAttribute('#ref-coffee', 'aria-checked'), 'true');
      assert.equal((await roasts(page)).find((r) => r.id === A.id).reference.coffee, true);
      step('Setting the same coffee on a newer roast moves the tag off the older one');
      await page.goto(`${base}/?nosw#history/${encodeURIComponent(C.id)}`);
      await page.waitForSelector('#ref-coffee');
      assert.equal(await page.getAttribute('#ref-coffee', 'aria-checked'), 'false');
      await page.click('#ref-coffee');
      await page.waitForSelector('#detail-tags [data-tag="reference"]');
      const after = await roasts(page);
      assert.equal(after.find((r) => r.id === A.id).reference.coffee, false);
      assert.equal(after.find((r) => r.id === C.id).reference.coffee, true);
      step('General fallback on another roast');
      await page.goto(`${base}/?nosw#history/${encodeURIComponent(B.id)}`);
      await page.waitForSelector('#ref-general');
      await page.click('#ref-general');
      await page.waitForSelector('#detail-tags [data-tag="general"]');
      await page.goto(`${base}/?nosw#history`);
      await page.waitForSelector('.hist-row');
      const tags = await tagsOn();
      assert.deepEqual(tags.find((t) => t.id === C.id).tags, ['Reference']);
      assert.deepEqual(tags.find((t) => t.id === B.id).tags, ['General fallback']);
      assert.deepEqual(tags.find((t) => t.id === A.id).tags, []);
      await shot(page, 'history-tags.png');
      step('A roast run against a reference that still exists shows that curve behind it');
      await page.evaluate(async ({ id, refId }) => {
        const db = await import('./js/store/db.js');
        const r = await db.getRoast(id);
        await db.updateRoast(id, { settings: { ...r.settings, mode: 'reference', referenceId: refId } });
      }, { id: A.id, refId: C.id });
      await page.goto(`${base}/?nosw#history/${encodeURIComponent(A.id)}`);
      await page.waitForFunction(() => { const m = window.__rt.chartModel(); return m && m.reference && m.reference.smooth.length > 100; }, null, { timeout: 5000 });
      await page.goto(`${base}/?nosw#history/${encodeURIComponent(B.id)}`);
      await page.waitForSelector('#sum-fc');
      assert.equal(await page.evaluate(() => window.__rt.chartModel().reference), null, 'no reference curve when there was none');
    }

    // ------------------------------------------------------------------ CSV
    console.log('CSV export');
    {
      await page.goto(`${base}/?nosw#history/${encodeURIComponent(A.id)}`);
      await page.waitForSelector('#export-csv');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
      assert.match(dl.suggestedFilename(), /^ethiopia-guji-\d{4}-\d{2}-\d{2}\.csv$/);
      const csv = fs.readFileSync(await dl.path(), 'utf8');
      const lines = csv.trimEnd().split('\n');
      const rec = (await roasts(page)).find((r) => r.id === A.id);
      assert.equal(lines[0], 'time (s),temperature (°F),smoothed temperature (°F),rate of rise (°F/min),event');
      assert.equal(lines.length, rec.readings.length + 1, 'one row per second plus the header');
      assert.match(lines[1], /^0,\d+,.*Start/);
      assert.ok(lines.some((l) => /First crack/.test(l)) && lines.some((l) => /Drop/.test(l)));
      step(`CSV has ${lines.length - 1} rows; header matches`);
      assert.match(await text(page, '#export-status'), /Exported ethiopia-guji/);
    }

    // ------------------------------------------------------------------ Settings
    console.log('Settings');
    {
      // A general reference would override Setup's development target, so set it aside for this section.
      const setGeneral = (on) => page.evaluate(async ({ id, on }) => (await import('./js/store/db.js')).setReference(id, { general: on }), { id: B.id, on });
      await setGeneral(false);
      await main.go('?nosw', '#setup');
      await page.waitForSelector('#green-weight');
      assert.equal(await page.inputValue('#green-weight'), '90');
      assert.equal(await text(page, '#dev-value'), '55 s');
      step('Setup links to Settings; the screen opens with the first group');
      await page.click('#nav-settings');
      await waitHash(page, '#settings');
      await page.waitForSelector('#units-seg');
      assert.equal(await page.$eval('#group-targets', (d) => d.open), true);
      assert.equal(await page.$eval('#group-cues', (d) => d.open), false);
      await shot(page, 'settings-top.png');

      step('Changing the defaults reaches Setup without a reload');
      await setField(page, 'set-greenWeightG', '85');
      await setField(page, 'set-devTargetSec', '60');
      await page.click('#group-targets .heat-btn[data-heat="4"]');
      await page.click('#start-fan-seg [data-value="low"]');
      let s = await storedSettings(page);
      assert.equal(s.greenWeightG, 85);
      assert.equal(s.devTargetSec, 60);
      assert.equal(s.startHeat, 4);
      assert.equal(s.startFan, 'low');
      await page.click('#nav-setup');
      await waitHash(page, '#setup');
      await page.waitForSelector('#green-weight');
      assert.equal(await page.inputValue('#green-weight'), '85');
      assert.equal(await text(page, '#dev-value'), '60 s');
      assert.equal(await page.getAttribute('.heat-btn[data-heat="4"]', 'aria-checked'), 'true');
      assert.equal(await page.getAttribute('#fan-seg [data-value="low"]', 'aria-checked'), 'true');

      step('Steppers move by their step and stop at the limits');
      await page.click('#nav-settings');
      await page.waitForSelector('#set-devTargetSec');
      await page.click('#set-devTargetSec-plus');
      assert.equal(await page.inputValue('#set-devTargetSec'), '65');
      assert.equal(await page.locator('#set-devTargetSec-plus').isDisabled(), true);
      await page.click('#set-devTargetSec-minus');
      assert.equal(await page.inputValue('#set-devTargetSec'), '60');
      assert.equal((await storedSettings(page)).devTargetSec, 60);

      step('Out of range, wrong format and cross-check errors show a message and are not saved');
      await setField(page, 'set-devTargetSec', '90');
      assert.match(await text(page, '#err-devTargetSec'), /Enter a value from 45 to 65 s\./);
      assert.equal(await page.getAttribute('#set-devTargetSec', 'aria-invalid'), 'true');
      assert.equal((await storedSettings(page)).devTargetSec, 60);
      await setField(page, 'set-devTargetSec', 'abc');
      assert.match(await text(page, '#err-devTargetSec'), /Type a number/);
      await setField(page, 'set-devTargetSec', '50');
      assert.equal(await text(page, '#err-devTargetSec'), '');
      assert.equal((await storedSettings(page)).devTargetSec, 50);
      await setField(page, 'set-fcWindowStartSec', '6:00');
      assert.match(await text(page, '#err-fcWindowStartSec'), /later than the end of the window/);
      assert.equal((await storedSettings(page)).fcWindowStartSec, 300);
      await setField(page, 'set-fcWindowStartSec', 'later');
      assert.match(await text(page, '#err-fcWindowStartSec'), /Type a time like 5:30/);
      await setField(page, 'set-fcWindowEndSec', '5:45');
      assert.equal((await storedSettings(page)).fcWindowEndSec, 345, 'times are typed as m:ss');
      assert.equal(await page.inputValue('#set-fcWindowEndSec'), '5:45');
      await setField(page, 'set-weightLossMinPct', '13');
      assert.match(await text(page, '#err-weightLossMinPct'), /above the high end/);
      await setField(page, 'set-devTargetSec', '55');
      await setField(page, 'set-fcWindowEndSec', '5:30');
      await setField(page, 'set-fcWindowStartSec', '5:00');

      step('Calculations, cues and reader groups');
      await openGroup(page, 'calc');
      await page.click('#ror-seg [data-value="45"]');
      assert.equal((await storedSettings(page)).rorWindowSec, 45);
      await page.click('#ror-seg [data-value="30"]');
      assert.equal(await text(page, '#smooth-readonly'), '10 s');
      await openGroup(page, 'cues');
      await page.click('#cue-hot');
      assert.equal(await page.getAttribute('#cue-hot', 'aria-checked'), 'false');
      assert.match(await text(page, '#cue-hot'), /Muted/);
      assert.equal((await storedSettings(page)).mute.hot, true);
      await page.click('#fan-prompt');
      assert.equal((await storedSettings(page)).fanPrompt, true);
      await setField(page, 'set-stallRorFPerMin', '8');
      assert.equal((await storedSettings(page)).stallRorFPerMin, 8);
      await openGroup(page, 'reader');
      await setField(page, 'set-reader-maxF', '560');
      assert.equal((await storedSettings(page)).reader.maxF, 560);
      await setField(page, 'set-reader-minF', '600');
      assert.match(await text(page, '#err-reader-minF'), /Enter a value from/);
      assert.equal((await storedSettings(page)).reader.minF, 50);
      for (const key of Object.keys(await storedSettings(page))) assert.ok(key in (await page.evaluate(() => window.__rt.app.settings)), key);
      step('Every control is 64px or taller with all groups open; nothing overflows');
      await openGroup(page, 'data');
      assert.deepEqual(await smallControls(page), []);
      assert.ok((await hOverflow(page)) <= 0);
      await page.evaluate(() => document.getElementById('group-cues').scrollIntoView());
      await shot(page, 'settings-scrolled.png');
      await page.evaluate(() => document.getElementById('group-data').scrollIntoView());
      await shot(page, 'settings-data.png');
      await page.setViewportSize({ width: 375, height: 667 });
      assert.deepEqual(await smallControls(page), []);
      assert.ok((await hOverflow(page)) <= 0, 'no overflow at 375');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.getAttribute('#reader-test-link', 'href'), 'reader-test.html');
      assert.match(await text(page, '#reader-test-link'), /Digit reader test page/);
      assert.match(await text(page, '#about-version'), /No offline copy on this page/, 'with ?nosw there is no worker');

      step('Units: °C shows converted values, stored values stay °F');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.click('#units-seg [data-value="C"]');
      s = await storedSettings(page);
      assert.equal(s.units, 'C');
      assert.equal(s.expectedFcF, 410, 'stored in °F');
      assert.equal(await page.inputValue('#set-expectedFcF'), '210');
      assert.match(await text(page, '#field-expectedFcF .field-label'), /°C/);
      assert.equal(await page.inputValue('#set-fcSoonF'), '5.6', 'a difference converts by 5/9 with no offset');
      assert.equal(await page.inputValue('#set-stallRorFPerMin'), '4.4', 'a rate converts by 5/9 with no offset');
      assert.match(await text(page, '#set-stallRorFPerMin-hint'), /Allowed: 0 to 33\.3 °C per minute/);
      assert.equal(await page.inputValue('#set-reader-maxF'), '293.3');
      await setField(page, 'set-expectedFcF', '205');
      assert.equal((await storedSettings(page)).expectedFcF, 401, '205°C is stored as 401°F');
      await page.click('#set-expectedFcF-plus');
      assert.equal(await page.inputValue('#set-expectedFcF'), '210');
      assert.equal((await storedSettings(page)).expectedFcF, 410);
      await setField(page, 'set-fcSoonF', '5');
      assert.equal((await storedSettings(page)).fcSoonF, 9, '5°C difference is 9°F');
      await setField(page, 'set-fcSoonF', '5.6');
      await shot(page, 'settings-celsius.png');
      step('Setup and the detail page render °C');
      await page.click('#nav-setup');
      await page.waitForSelector('#read-value');
      await page.waitForFunction(() => /°C/.test(document.getElementById('read-value').textContent), null, { timeout: 8000 });
      assert.match(await text(page, '#read-value'), /^\d+\.\d°C$/);
      assert.match(await text(page, '#reminder'), /572°F/);
      await page.goto(`${base}/?nosw#history/${encodeURIComponent(A.id)}`);
      await page.waitForSelector('#sum-fc');
      assert.match(await text(page, '#sum-fc'), /\d:\d\d · \d+\.\d°C/);
      assert.equal(await page.evaluate(() => window.__rt.chartModel().units), 'C');
      assert.equal((await roasts(page)).find((r) => r.id === A.id).events.firstCrack.f > 300, true, 'stored roast data is still °F');
      await page.goto(`${base}/?nosw#history`);
      await page.waitForSelector('.hist-row');

      step('Reset to defaults asks first, then restores everything');
      await page.goto(`${base}/?nosw#settings`);
      await page.waitForSelector('#units-seg');
      await openGroup(page, 'data');
      await page.click('#reset-settings');
      await page.click('.sheet [data-action="keep"]');
      assert.equal((await storedSettings(page)).units, 'C', 'Keep leaves the settings alone');
      await page.click('#reset-settings');
      await page.click('.sheet [data-action="reset"]');
      assert.equal(await storedSettings(page), null);
      assert.equal(await page.inputValue('#set-greenWeightG'), '90');
      assert.equal(await page.inputValue('#set-devTargetSec'), '55');
      assert.equal(await page.inputValue('#set-expectedFcF'), '410');
      assert.equal(await page.getAttribute('#units-seg [data-value="F"]', 'aria-checked'), 'true');
      assert.equal(await page.getAttribute('#cue-hot', 'aria-checked'), 'true');
      assert.equal((await roasts(page)).length, 3, 'Reset leaves the roasts alone');
      await page.click('#nav-setup');
      await page.waitForSelector('#green-weight');
      assert.equal(await page.inputValue('#green-weight'), '90');
      assert.equal(await text(page, '#dev-value'), '55 s');
    }

    // ------------------------------------------------------------------ Export and import
    console.log('Export, delete everything, import');
    let exportPath;
    let exported;
    {
      await page.evaluate(async (id) => (await import('./js/store/db.js')).setReference(id, { general: true }), B.id);
      step('Set two non-default settings so the round trip can prove they come back');
      await page.goto(`${base}/?nosw#settings`);
      await page.waitForSelector('#set-greenWeightG');
      await setField(page, 'set-greenWeightG', '95');
      await page.click('#units-seg [data-value="C"]');
      await page.goto(`${base}/?nosw#history`);
      await page.waitForSelector('.hist-row');
      assert.equal(await text(page, '#last-export'), 'Never exported');
      step('Export all downloads one JSON file and Last export shows a date');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-all')]);
      assert.match(dl.suggestedFilename(), /^roast-tracker-\d{4}-\d{2}-\d{2}\.json$/);
      exportPath = path.join(OUT, 'export-test.json');
      await dl.saveAs(exportPath);
      exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
      assert.equal(exported.format, 'roast-tracker-export');
      assert.equal(exported.roasts.length, 3);
      assert.equal(exported.settings.greenWeightG, 95);
      assert.match(await text(page, '#transfer-result'), /Exported 3 roasts and your settings/);
      await page.waitForFunction(() => /^Last export: [A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(document.getElementById('last-export').textContent));
      assert.equal(await page.getAttribute('#last-export', 'data-state'), 'done');
      assert.match(await text(page, '#backup-card'), /^(?![\s\S]*have not been exported)/);

      step('Share sheet where the browser offers one; cancelling it does not count as an export');
      const share = await newPage(browser, base, { context: main.context });
      await share.page.addInitScript(() => {
        navigator.canShare = (d) => !!(d && d.files && d.files.length);
        window.__shareMode = 'ok';
        navigator.share = async (d) => {
          if (window.__shareMode === 'cancel') throw new DOMException('cancelled', 'AbortError');
          window.__shared = { name: d.files[0].name, type: d.files[0].type, text: await d.files[0].text() };
        };
      });
      await share.go('?nosw', '#history');
      await share.page.waitForSelector('#export-download:not([hidden])');
      const lastBefore = await text(share.page, '#last-export');
      await share.page.evaluate(() => { window.__shareMode = 'cancel'; });
      await share.page.click('#export-all');
      await share.page.waitForFunction(() => /cancelled/.test(document.getElementById('transfer-result').textContent));
      assert.equal(await share.page.evaluate(() => window.__shared || null), null);
      assert.equal(await text(share.page, '#last-export'), lastBefore);
      await share.page.evaluate(() => { window.__shareMode = 'ok'; });
      await share.page.click('#export-all');
      await share.page.waitForFunction(() => window.__shared);
      const shared = await share.page.evaluate(() => window.__shared);
      assert.match(shared.name, /^roast-tracker-.*\.json$/);
      assert.equal(shared.type, 'application/json');
      assert.equal(JSON.parse(shared.text).roasts.length, 3);
      assert.match(await text(share.page, '#transfer-result'), /with the share sheet/);
      finish('share', share.errors);
      await share.page.close();

      step('Delete the database and the settings, as clearing site data would');
      await page.goto(`${base}/css/app.css`);
      await page.evaluate(() => new Promise((resolve, reject) => {
        localStorage.clear();
        const req = indexedDB.deleteDatabase('roast-tracker');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('delete blocked'));
      }));
      await page.goto(`${base}/?nosw#history`);
      await page.waitForSelector('#history-empty');
      assert.equal(await text(page, '#last-export'), 'Never exported');
      assert.equal((await readStore(page, 'roasts')).length, 0);

      step('Import asks first and says it replaces settings');
      await page.click('#import-btn');
      const sheetText = await text(page, '.sheet');
      assert.match(sheetText, /also replaces your settings/);
      await page.click('.sheet [data-action="cancel"]');
      assert.equal((await readStore(page, 'roasts')).length, 0, 'Cancel imports nothing');

      step('Import restores roasts and settings, with a counts line');
      await page.click('#import-btn');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#import-choose')]);
      await chooser.setFiles(exportPath);
      await page.waitForSelector('.hist-row');
      assert.match(await text(page, '#transfer-result'), /Imported: 3 added, 0 updated, 0 unchanged, 0 invalid\. Settings restored from the file\./);
      assert.equal(await page.locator('.hist-row').count(), 3);
      const back = await roasts(page);
      assert.deepEqual(back.map((r) => r.id), seeded.map((r) => r.id));
      // The stored roasts equal what was exported (A had its reference-run setting edited before the export).
      const byId = Object.fromEntries(exported.roasts.map((r) => [r.id, r]));
      for (const r of back) assert.deepEqual(r, byId[r.id], `roast ${r.id} restored exactly`);
      assert.equal((await storedSettings(page)).greenWeightG, 95);
      assert.equal((await storedSettings(page)).units, 'C');
      await page.waitForFunction(() => /^Last export: /.test(document.getElementById('last-export').textContent));
      assert.equal(await page.getAttribute('#last-export', 'data-state'), 'done', 'Last export comes back from the file');
      const tags = await page.evaluate(() => [...document.querySelectorAll('.hist-row .tag')].map((t) => t.textContent).sort());
      assert.deepEqual(tags, ['General fallback', 'Reference']);
      step('The restored settings reach Setup without a reload');
      await page.click('#nav-setup');
      await page.waitForSelector('#green-weight');
      assert.equal(await page.inputValue('#green-weight'), '95');
      await page.waitForFunction(() => /°C/.test(document.getElementById('read-value').textContent), null, { timeout: 8000 });

      step('Importing the same file again changes nothing; bad files say what is wrong');
      await page.goto(`${base}/?nosw#history`);
      await page.waitForSelector('.hist-row');
      const importFile = async (file) => {
        await page.click('#import-btn');
        const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#import-choose')]);
        await fc.setFiles(file);
      };
      await importFile(exportPath);
      await page.waitForFunction(() => /0 added, 0 updated, 3 unchanged/.test(document.getElementById('transfer-result').textContent));
      const junk = path.join(OUT, 'junk-test.json');
      fs.writeFileSync(junk, '{"hello": 1}');
      await importFile(junk);
      await page.waitForFunction(() => /not a Roast Tracker export/.test(document.getElementById('transfer-result').textContent));
      assert.equal(await page.getAttribute('#transfer-result', 'data-kind'), 'bad');
      const partial = path.join(OUT, 'partial-test.json');
      fs.writeFileSync(partial, JSON.stringify({ ...exported, roasts: [...exported.roasts.slice(0, 1), { id: '', readings: [] }, { id: 'x1', startedAt: 'nope' }] }));
      await importFile(partial);
      await page.waitForFunction(() => /0 added, 0 updated, 1 unchanged, 2 invalid/.test(document.getElementById('transfer-result').textContent));
      assert.equal(await page.locator('#transfer-result .problems li').count(), 2);
      assert.equal(await page.getAttribute('#transfer-result', 'data-kind'), 'warn');
      await shot(page, 'history-import-result.png');
      for (const f of [junk, partial, exportPath]) fs.rmSync(f, { force: true });

      step('Delete a roast from its detail page, with a confirm');
      await page.goto(`${base}/?nosw#history/${encodeURIComponent(B.id)}`);
      await page.waitForSelector('#delete-roast');
      await page.click('#delete-roast');
      assert.match(await text(page, '.sheet'), /cannot be undone/);
      await page.click('.sheet [data-action="keep"]');
      assert.equal((await roasts(page)).length, 3);
      await page.click('#delete-roast');
      await page.click('.sheet [data-action="delete"]');
      await waitHash(page, '#history');
      await page.waitForSelector('.hist-row');
      assert.equal(await page.locator('.hist-row').count(), 2);
      assert.equal((await roasts(page)).length, 2);
      assert.match(await text(page, '#history-count'), /^2 roasts$/);
    }
    finish('main', main.errors);
    await main.context.close();

    // ------------------------------------------------------------------ After screen has the editor
    console.log('After screen: log editor');
    {
      const t = await newPage(browser, base);
      await t.go('?nosw&speed=60&undo=500', '#setup');
      await t.page.waitForSelector('#preset');
      await t.page.waitForSelector('#start-btn:not([disabled])', { timeout: 10000 });
      await t.page.click('#start-btn');
      await waitHash(t.page, '#roast');
      await t.page.waitForFunction(() => window.__rt.snapshot().temp >= 395, null, { timeout: 40000 });
      await t.page.click('#ev-firstCrack');
      await t.page.waitForFunction(() => window.__rt.snapshot().devSec >= 48, null, { timeout: 20000 });
      await t.page.click('#ev-drop');
      await waitHash(t.page, '#after');
      step('The plain-text log line is gone; the editor sits under the summary');
      await t.page.waitForSelector('#log-editor');
      assert.equal(await t.page.locator('.summary :text("Heat and fan log:")').count(), 0);
      const order = await t.page.evaluate(() => {
        const a = document.getElementById('summary-host').getBoundingClientRect().top;
        const b = document.getElementById('log-card').getBoundingClientRect().top;
        const c = document.getElementById('roasted-weight').getBoundingClientRect().top;
        return a < b && b < c;
      });
      assert.ok(order, 'summary, then log, then weight');
      step('An added change shows in the chart model and is saved with the roast');
      await t.page.fill('#log-add-time', '2:00');
      await t.page.click('#log-add-btn');
      await t.page.waitForFunction(() => window.__rt.chartModel().controls.some((c) => c.t === 120 && c.kind === 'heat'));
      assert.match(await text(t.page, '#sum-changes'), /1 change$/);
      await t.page.fill('#roasted-weight', '80');
      await t.page.click('#save-btn');
      await waitHash(t.page, '#history');
      const rec = (await roasts(t.page))[0];
      assert.ok(rec.controls.some((c) => c.t === 120 && c.kind === 'heat' && c.value === 3));
      assert.deepEqual(await smallControls(t.page), []);
      finish('after', t.errors);
      await t.context.close();
    }

    // ------------------------------------------------------------------ Offline
    console.log('Offline install');
    {
      const t = await newPage(browser, base);
      const manifestUrl = `${base}/manifest.webmanifest`;
      step('Manifest and icons are served and valid');
      const manifest = await (await t.context.request.get(manifestUrl)).json();
      assert.equal(manifest.name, 'Roast Tracker');
      assert.equal(manifest.display, 'standalone');
      assert.equal(manifest.orientation, 'portrait');
      assert.equal(manifest.theme_color, '#0f1115');
      assert.equal(manifest.background_color, '#0f1115');
      assert.equal(manifest.start_url, './');
      assert.equal(manifest.scope, './');
      const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
      assert.ok(sizes.includes('192x192:any') && sizes.includes('512x512:any') && sizes.includes('512x512:maskable'));
      for (const icon of [...manifest.icons.map((i) => i.src), 'icons/apple-touch-icon.png']) {
        const res = await t.context.request.get(`${base}/${icon}`);
        assert.equal(res.status(), 200, icon);
        assert.equal(res.headers()['content-type'], 'image/png');
      }
      for (const pageName of ['index.html', 'reader-test.html']) {
        const html = await (await t.context.request.get(`${base}/${pageName}`)).text();
        assert.match(html, /rel="manifest" href="manifest\.webmanifest"/, pageName);
        assert.match(html, /rel="apple-touch-icon" href="icons\/apple-touch-icon\.png"/, pageName);
        assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/, pageName);
      }

      step('First load installs the worker and fills the cache');
      await t.go('?speed=60&undo=500', '#setup');
      await t.page.waitForSelector('#start-btn');
      await t.page.evaluate(() => navigator.serviceWorker.ready);
      await t.page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 });
      const info = await t.page.evaluate(async () => {
        const keys = await caches.keys();
        const cache = await caches.open(keys[0]);
        return { keys, n: (await cache.keys()).length, scope: (await navigator.serviceWorker.getRegistration()).scope };
      });
      const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
      const version = /CACHE_VERSION = '([^']+)'/.exec(swSrc)[1];
      assert.deepEqual(info.keys, [`rt-precache-${version}`]);
      assert.equal(info.n, (swSrc.match(/^ {2}'[^']+',$/gm) || []).length, 'every listed URL is cached');
      assert.equal(info.scope, `${base}/`);
      await t.page.goto(`${base}/?speed=60&undo=500#settings`);
      await openGroup(t.page, 'data');
      await t.page.waitForFunction((v) => document.getElementById('about-version').textContent.includes(v), version);
      assert.match(await text(t.page, '#about-version'), new RegExp(`Version ${version}\\. Cache rt-precache-${version}\\. Works offline\\.`));

      step('Offline: Setup, History, Settings render, and a demo roast runs and saves');
      await t.context.setOffline(true);
      await t.page.goto(`${base}/?speed=60&undo=500#setup`);
      await t.page.waitForSelector('#start-btn');
      await t.page.reload();
      await t.page.waitForSelector('#start-btn');
      assert.match(await text(t.page, '.setup h1'), /Roast Tracker/);
      await t.page.click('#nav-history');
      await t.page.waitForSelector('#history-empty');
      await t.page.click('#nav-settings');
      await t.page.waitForSelector('#units-seg');
      await t.page.goto(`${base}/?speed=60&undo=500#setup`);
      await t.page.waitForSelector('#preset');
      await t.page.fill('#coffee', 'Offline test');
      await t.page.waitForSelector('#start-btn:not([disabled])', { timeout: 10000 });
      await t.page.click('#start-btn');
      await waitHash(t.page, '#roast');
      await t.page.waitForFunction(() => window.__rt.snapshot().temp >= 395, null, { timeout: 40000 });
      await t.page.click('#ev-firstCrack');
      await t.page.waitForFunction(() => window.__rt.snapshot().devSec >= 48, null, { timeout: 20000 });
      await t.page.click('#ev-drop');
      await waitHash(t.page, '#after');
      await t.page.fill('#roasted-weight', '80');
      await t.page.click('#save-btn');
      await waitHash(t.page, '#history');
      await t.page.waitForSelector('.hist-row');
      assert.equal(await t.page.locator('.hist-row').count(), 1);
      step('Offline: the digit reader test page loads too');
      await t.page.goto(`${base}/reader-test.html`);
      await t.page.waitForSelector('#tab-photos');
      assert.equal(await t.page.title(), 'Reader test');
      assert.equal(await t.page.evaluate(() => document.styleSheets.length > 0 && [...document.styleSheets].every((s) => { try { return s.cssRules.length > 0; } catch { return true; } })), true, 'reader-test.css loaded');
      const missing = await t.page.evaluate(async () => {
        const urls = [...document.querySelectorAll('script[src], link[href]')].map((e) => e.src || e.href);
        const out = [];
        for (const u of urls) { try { const r = await fetch(u); if (!r.ok) out.push(u); } catch { out.push(u); } }
        return out;
      });
      assert.deepEqual(missing, []);
      await t.context.setOffline(false);
      // The browser may log one failed update check for sw.js while offline; that is not an app error.
      const ignored = t.errors.filter((e) => /ERR_INTERNET_DISCONNECTED|sw\.js/.test(e));
      if (ignored.length) console.log(`  (ignored ${ignored.length} offline update-check message(s): ${ignored[0]})`);
      finish('offline', t.errors.filter((e) => !ignored.includes(e)));
      await t.context.close();
    }

    // ------------------------------------------------------------------ Update ready
    console.log('Update ready');
    {
      const t = await newPage(browser, base);
      await t.go('?speed=1', '#setup');
      await t.page.waitForSelector('#start-btn');
      await t.page.evaluate(() => navigator.serviceWorker.ready);
      await t.page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 });
      assert.equal(await t.page.locator('#update-card').isVisible(), false, 'no update notice on a fresh install');
      const v1 = /CACHE_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'))[1];
      step('A new release installs in the background; Setup and History say Update ready');
      state.swTransform = (src) => src.replace(/CACHE_VERSION = '[^']+'/, "CACHE_VERSION = 'v2-test'");
      await t.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
      await t.page.waitForSelector('#update-card:not([hidden])', { timeout: 10000 });
      assert.match(await text(t.page, '#update-card'), /Update ready/);
      assert.equal(await t.page.locator('#update-reload').isVisible(), true);
      assert.deepEqual(await smallControls(t.page), []);
      await shot(t.page, 'setup-update-ready.png');
      const keys1 = await t.page.evaluate(() => caches.keys());
      assert.deepEqual(keys1.sort(), [`rt-precache-${v1}`, 'rt-precache-v2-test'].sort(), 'both caches exist while the new worker waits');
      await t.page.click('#nav-history');
      await t.page.waitForSelector('#update-card:not([hidden])');
      await t.page.click('#nav-setup');

      step('Mid-roast: no Reload button, the worker is not swapped, the caches are untouched');
      await t.page.waitForSelector('#start-btn:not([disabled])', { timeout: 10000 });
      await t.page.click('#start-btn');
      await waitHash(t.page, '#roast');
      await t.page.waitForSelector('#probe-cell');
      assert.equal(await t.page.locator('#update-card, #update-reload').count(), 0);
      assert.equal(await t.page.evaluate(() => window.__rt.app.pwa.applyUpdate()), false, 'applyUpdate refuses mid-roast');
      await t.page.waitForTimeout(500);
      assert.deepEqual((await t.page.evaluate(() => caches.keys())).sort(), keys1.sort());
      assert.equal((await t.page.evaluate(() => window.__rt.app.pwa.version())).version, v1, 'the old worker is still in charge');
      await t.page.evaluate(() => { location.hash = '#settings'; });
      await t.page.waitForTimeout(200);
      assert.equal(await t.page.evaluate(() => location.hash), '#roast', 'Settings stays unreachable mid-roast');
      await t.page.click('#end-roast');
      await t.page.click('[data-action="discard"]');
      await waitHash(t.page, '#setup');

      step('Reload swaps to the new worker and deletes the old cache');
      await t.page.waitForSelector('#update-card:not([hidden])');
      await Promise.all([t.page.waitForEvent('load'), t.page.click('#update-reload')]);
      await t.page.waitForSelector('#start-btn');
      await t.page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 });
      await t.page.waitForFunction(async () => (await caches.keys()).join() === 'rt-precache-v2-test', null, { timeout: 10000 });
      assert.equal((await t.page.evaluate(() => window.__rt.app.pwa.version())).version, 'v2-test');
      assert.equal(await t.page.locator('#update-card').isVisible(), false);
      state.swTransform = null;
      finish('update', t.errors);
      await t.context.close();
    }

    // ------------------------------------------------------------------ Icon
    fs.copyFileSync(path.join(ROOT, 'icons', 'apple-touch-icon.png'), path.join(OUT, 'icon-180.png'));
  } finally {
    await browser.close();
    server.close();
  }

  if (allErrors.length) {
    console.error('Console errors or uncaught exceptions:\n' + allErrors.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('history-settings: all checks passed. Screenshots in', OUT);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
