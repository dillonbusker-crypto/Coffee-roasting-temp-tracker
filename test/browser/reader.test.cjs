#!/usr/bin/env node
// Browser tests for the digit reader (milestone 1). Drives the pre-installed global Playwright Chromium against a local static server.
//
//   node test/browser/reader.test.cjs [--full] [--shots DIR] [--skip-pages | --only-pages]
//
// Sections
//   1. real crops cut from test/fixtures/photos/tp17-077-set425.jpg (must all read correctly)
//   2. the same photo with the crop box jittered +-10% (never wrong; correct rate reported)
//   3. synthetic displays at four distortion levels (zero wrong; correct rate at mild)
//   4. synthetic transition frames (a segment mid-fade)
//   5. a synthetic 60 s climb at 4 fps through filter.js (the spec's accuracy target)
//   6. the test page itself on a phone-sized viewport: photos, recorded video, live fake camera + soak test
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, startServer, launch } = require('./lib.cjs');

const args = process.argv.slice(2);
const FULL = args.includes('--full');
const SKIP_PAGES = args.includes('--skip-pages');
const ONLY_PAGES = args.includes('--only-pages');
const shotsIdx = args.indexOf('--shots');
const SHOTS = shotsIdx >= 0 ? args[shotsIdx + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : 'n/a');

async function main() {
  const { srv, base } = await startServer();
  const browser = await launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const results = {};
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('[pageerror]', e.message); failures++; });
    await page.goto(base + '/test/browser/harness.html');

    if (!ONLY_PAGES) {
      // ---------------- 1. real crops ----------------
      {
        const files = fs.readdirSync(path.join(ROOT, 'test/fixtures/crops')).filter(f => f.endsWith('.png')).sort();
        const out = await page.evaluate(async files => {
          const S = await import('../../js/reader/sevenseg.js');
          const rows = [];
          for (const f of files) {
            const bmp = await createImageBitmap(await (await fetch('../fixtures/crops/' + f)).blob());
            const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
            const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
            const t = performance.now();
            const r = S.readDisplay(ctx.getImageData(0, 0, c.width, c.height));
            rows.push({ f, status: r.status, value: r.value, conf: r.confidence, ms: performance.now() - t, reason: r.debug.reason });
          }
          return rows;
        }, files);
        const expect = f => f.startsWith('v077') ? 77 : f.startsWith('v425') ? 425 : f.startsWith('v160') ? 160 : 'dashes';
        let good = 0;
        for (const r of out) {
          const e = expect(r.f), got = r.status === 'dashes' ? 'dashes' : r.value;
          const ok = got === e; if (ok) good++;
          check(ok, `real crop ${r.f}`, `read ${got ?? 'none (' + r.reason + ')'} confidence ${(r.conf * 100).toFixed(0)}% ${r.ms.toFixed(0)} ms`);
        }
        results.realCrops = `${good}/${out.length}`;
      }

      // ---------------- 2. real photo, jittered boxes ----------------
      {
        const N = FULL ? 400 : 150;
        const out = await page.evaluate(async N => {
          const S = await import('../../js/reader/sevenseg.js'), C = await import('../../js/reader/camera.js'), R = await import('../../tools/synth-display.js');
          const img = new Image(); img.src = '../fixtures/photos/tp17-077-set425.jpg'; await img.decode();
          const W = img.naturalWidth, H = img.naturalHeight;
          // digit boxes in photo pixels (see tools/make-real-crops.py)
          const targets = { '77': [856, 816, 1048, 957], '425': [371, 827, 655, 970], '160': [437, 1045, 665, 1192], '---': [759, 1045, 1045, 1192] };
          const rng = R.mulberry32(99), work = {}, res = {};
          for (const [exp, [x0, y0, x1, y1]] of Object.entries(targets)) {
            const r = res[exp] = { n: 0, ok: 0, wrong: 0, none: 0, wrongs: [], whyNone: {}, byMargin: { 0.03: [0, 0], 0.08: [0, 0], 0.15: [0, 0] } };
            for (let i = 0; i < N; i++) {
              const m = [0.03, 0.08, 0.15][i % 3] * (y1 - y0); // user margin around the digits: tight, normal, loose
              let bx0 = x0 - m, by0 = y0 - m, bx1 = x1 + m, by1 = y1 + m;
              const bw = bx1 - bx0, bh = by1 - by0, j = () => (rng() * 2 - 1) * 0.10;
              bx0 += j() * bw; bx1 += j() * bw; by0 += j() * bh; by1 += j() * bh;
              const box = { x: bx0 / W, y: by0 / H, w: (bx1 - bx0) / W, h: (by1 - by0) / H };
              const { imageData } = C.grabCropFrom(img, W, H, C.expandBoxForDigits(box, W, H), work);
              const q = S.readDisplay(imageData);
              const got = q.status === 'dashes' ? '---' : q.status === 'ok' ? String(q.value) : null;
              r.n++; const mk = [0.03, 0.08, 0.15][i % 3]; r.byMargin[mk][1]++; if (got === exp) r.byMargin[mk][0]++;
              if (got === null) { r.none++; const k = q.debug.reason + (q.debug.seg ? ' ' + q.debug.seg : ''); r.whyNone[k] = (r.whyNone[k] || 0) + 1; }
              else if (got === exp) r.ok++;
              else { r.wrong++; r.wrongs.push({ got, box }); }
            }
          }
          return res;
        }, N);
        let wrong = 0;
        for (const [exp, r] of Object.entries(out)) {
          wrong += r.wrong;
          console.log(`      jitter ${exp.padEnd(4)}: ${r.ok}/${r.n} correct (${pct(r.ok, r.n)}), ${r.none} missed, ${r.wrong} wrong; by margin around the digits: ` + Object.entries(r.byMargin).map(([m, [a, b]]) => `${m * 100}% ${pct(a, b)}`).join(', ') + `  ${JSON.stringify(r.whyNone)}`);
        }
        const tot = Object.values(out).reduce((a, r) => a + r.n, 0), okTot = Object.values(out).reduce((a, r) => a + r.ok, 0);
        check(wrong === 0, 'real photo, box jittered +-10%: no wrong reads', `${wrong} wrong of ${tot}`);
        const loose = Object.values(out).reduce((a, r) => [a[0] + r.byMargin[0.08][0] + r.byMargin[0.15][0], a[1] + r.byMargin[0.08][1] + r.byMargin[0.15][1]], [0, 0]);
      check(loose[0] / loose[1] >= 0.9, 'real photo, box jittered +-10%, margin 8-15% around the digits: at least 90% correct', `${pct(loose[0], loose[1])} (all margins incl. 3%, where the jitter often cuts a digit: ${pct(okTot, tot)})`);
        results.realJitter = { correct: pct(okTot, tot), wrong };
      }

      // ---------------- 3. synthetic displays ----------------
      {
        const per = FULL ? { clean: 2, mild: 3, moderate: 3, severe: 1 } : { clean: 1, mild: 1, moderate: 1, severe: 1 };
        const out = await page.evaluate(async per => {
          const S = await import('../../js/reader/sevenseg.js'), R = await import('../../tools/synth-display.js');
          const rng = R.mulberry32(2026);
          const all = []; for (let v = 50; v <= 550; v++) all.push(String(v));
          const specials = ['99', '100', '199', '200', '111', '117', '211', '411', '101', '110', '119', '191', '171', '177', '117', '141', '114', '511', '115', '151', '311', '131', '14', '15', '17', '71', '77', '41', '47', '74', '499', '399', '299', '572', '569', '555', '550', '501', '505', '507', '517', '570'];
          const out = { levels: {}, confusions: {}, buckets: {}, ms: 0, n: 0 };
          const bucket = (name, v, edges) => { let k = edges.findIndex(e => v < e); if (k < 0) k = edges.length; return name + ' ' + (k ? edges[k - 1] : '<' + edges[0]) + (k < edges.length ? '-' + edges[k] : '+'); };
          for (const level of ['clean', 'mild', 'moderate', 'severe']) {
            const L = out.levels[level] = { n: 0, ok: 0, wrong: 0, none: 0, why: {}, ones: { n: 0, ok: 0 }, dashes: { n: 0, ok: 0 } };
            for (let rep = 0; rep < per[level]; rep++) {
              const list = [...all.map(v => [v, 1]), ...specials.map(v => [v, 4]), ['---', 30]].flatMap(([v, k]) => Array(k).fill(v));
              const use = level === 'severe' ? list.filter(() => rng() < 0.4) : level === 'clean' ? list.filter(() => rng() < 0.5) : list;
              for (const text of use) {
                const p = R.randomParams(rng, text, level);
                const img = R.renderDisplay(p);
                const t = performance.now(); const r = S.readDisplay(img); out.ms += performance.now() - t; out.n++;
                const exp = text === '---' ? 'dashes' : text;
                const got = r.status === 'dashes' ? 'dashes' : r.status === 'ok' ? String(r.value) : null;
                L.n++;
                const hasOne = text.includes('1');
                if (text === '---') L.dashes.n++; else if (hasOne) L.ones.n++;
                if (got === null) { L.none++; const k = r.debug.reason; L.why[k] = (L.why[k] || 0) + 1; }
                else if (got === exp) { L.ok++; if (text === '---') L.dashes.ok++; else if (hasOne) L.ones.ok++; }
                else { L.wrong++; const k = exp + '->' + got; out.confusions[level + ' ' + k] = (out.confusions[level + ' ' + k] || 0) + 1; }
                if (level === 'moderate' || level === 'severe') {
                  const miss = got === null ? 1 : 0;
                  for (const [name, v, edges] of [['blur', p.blur / Math.max(0.6, p.H / 140), [1, 1.5, 2, 2.5]], ['ink contrast', p.geometry.inkAlpha, [0.5, 0.65, 0.8]], ['noise', p.noise, [6, 10, 14]], ['rotation deg', Math.abs(p.rotation), [2, 4, 6]], ['glare', p.glare ? 1 : 0, [1]], ['aspect off', Math.abs(p.aspect - 1), [0.05, 0.1, 0.15]]]) {
                    const k = level + ' ' + bucket(name, v, edges);
                    const b = out.buckets[k] || (out.buckets[k] = { n: 0, miss: 0 });
                    b.n++; b.miss += miss;
                  }
                }
              }
            }
          }
          return out;
        }, per);
        for (const level of ['clean', 'mild', 'moderate', 'severe']) {
          const L = out.levels[level];
          console.log(`      ${level.padEnd(8)}: ${L.ok}/${L.n} correct (${pct(L.ok, L.n)}), ${L.none} missed, ${L.wrong} wrong   values with a 1: ${pct(L.ones.ok, L.ones.n)}, dashes: ${pct(L.dashes.ok, L.dashes.n)}   missed because: ${JSON.stringify(L.why)}`);
        }
        console.log(`      speed: ${(out.ms / out.n).toFixed(1)} ms per frame over ${out.n} frames (this machine, desktop Chromium)`);
        if (Object.keys(out.confusions).length) console.log('      confusions:', JSON.stringify(out.confusions));
        const bk = Object.entries(out.buckets).filter(([, b]) => b.n >= 30).sort().map(([k, b]) => `${k}: ${pct(b.miss, b.n)} missed`);
        console.log('      where moderate/severe frames are missed (share of frames missed per bucket):\n        ' + bk.join('\n        '));
        for (const lv of ['clean', 'mild', 'moderate']) check(out.levels[lv].wrong === 0, `synthetic ${lv}: zero wrong reads`, `${out.levels[lv].wrong} wrong of ${out.levels[lv].n}`);
        check(out.levels.severe.wrong === 0, 'synthetic severe: zero wrong reads (reported, not required by the brief)', `${out.levels.severe.wrong} wrong of ${out.levels.severe.n}`);
        check(out.levels.clean.ok / out.levels.clean.n >= 0.99, 'synthetic clean: at least 99% correct', pct(out.levels.clean.ok, out.levels.clean.n));
        check(out.levels.mild.ok / out.levels.mild.n >= 0.98, 'synthetic mild: at least 98% correct', pct(out.levels.mild.ok, out.levels.mild.n));
        results.synthetic = Object.fromEntries(Object.entries(out.levels).map(([k, v]) => [k, `${pct(v.ok, v.n)} correct, ${v.wrong} wrong, ${v.none} missed of ${v.n}`]));
        results.msPerFrame = +(out.ms / out.n).toFixed(1);
      }

      // ---------------- 4. transition frames ----------------
      {
        const out = await page.evaluate(async FULL => {
          const S = await import('../../js/reader/sevenseg.js'), R = await import('../../tools/synth-display.js');
          const rng = R.mulberry32(4242);
          const pairs = [['99', '100'], ['199', '200'], ['109', '110'], ['119', '120'], ['89', '90'], ['77', '78'], ['111', '112'], ['168', '169'], ['256', '257'], ['300', '301'], ['499', '500'], ['58', '59'], ['40', '41'], ['157', '158'], ['316', '317'], ['188', '189'], ['569', '570'], ['400', '399']];
          const res = {};
          for (const level of ['mild', 'moderate']) {
            const r = res[level] = { n: 0, either: 0, wrong: 0, none: 0, wrongs: [] };
            for (let i = 0; i < (FULL ? 600 : 250); i++) {
              const [a, b] = pairs[i % pairs.length];
              const p = R.randomParams(rng, b, level, { fade: { from: a, p: 0.15 + rng() * 0.7, jitter: 0.12 } });
              const q = S.readDisplay(R.renderDisplay(p));
              r.n++;
              if (q.status !== 'ok') r.none++;
              else if (String(q.value) === a || String(q.value) === b) r.either++;
              else { r.wrong++; r.wrongs.push(`${a}->${b} read ${q.value}`); }
            }
          }
          return res;
        }, FULL);
        for (const [lv, r] of Object.entries(out)) {
          console.log(`      mid-fade ${lv}: ${r.either} read as old or new value, ${r.none} rejected, ${r.wrong} wrong ${r.wrongs.slice(0, 6).join('; ')}`);
        }
        check(out.mild.wrong === 0, 'mid-fade frames at mild: no value that is neither the old nor the new reading', `${out.mild.wrong} of ${out.mild.n}`);
        results.transitions = out;
      }

      // ---------------- 5. synthetic 60 s climb through filter.js ----------------
      {
        const out = await page.evaluate(async () => {
          const S = await import('../../js/reader/sevenseg.js'), R = await import('../../tools/synth-display.js'), F = await import('../../js/reader/filter.js');
          const res = {};
          for (const level of ['mild', 'moderate']) {
            const rng = R.mulberry32(777 + level.length);
            const base = R.randomParams(rng, '99', level, { margin: 0.1, jitter: 0, digitH: 140, extras: { degF: true, label: true, rule: false } });
            const f = F.createReadingFilter();
            let hint = null, correct = 0, wrong = 0, missed = 0, rows = [];
            const FPS = 4, SECS = 60;
            let truth = 84;
            for (let s = 0; s < SECS; s++) {
              truth = Math.min(199, Math.round(84 + s * 1.9 + Math.sin(s / 4) * 0.8)); // about 114 F/min climb: 84 .. 198, crossing 99->100 near 8 s
              const next = Math.round(84 + (s + 1) * 1.9 + Math.sin((s + 1) / 4) * 0.8);
              for (let k = 0; k < FPS; k++) {
                // the display refreshes once a second; the last frame of a second sometimes catches the change half way
                const mid = k === FPS - 1 && next !== truth && rng() < 0.7;
                const p = Object.assign({}, base, { text: String(truth), seed: Math.floor(rng() * 1e9), noise: base.noise * (0.8 + 0.4 * rng()) });
                if (mid) p.fade = { from: String(truth), p: 0.25 + 0.5 * rng(), jitter: 0.1 }, p.text = String(next);
                const r = S.readDisplay(R.renderDisplay(p), { hint });
                hint = r.debug.hintOut || hint;
                f.addFrame(r);
              }
              const v = f.closeSecond();
              if (v === null) missed++; else if (v === truth || v === next && false) correct++; else if (Math.abs(v - truth) <= 1 && v === next) correct++; else { wrong++; rows.push(`t=${s}s read ${v} truth ${truth}`); }
            }
            res[level] = { correct, wrong, missed, secs: SECS, health: f.health(), rows };
          }
          return res;
        });
        for (const [lv, r] of Object.entries(out)) {
          const share = r.correct / r.secs;
          console.log(`      60 s climb at ${lv}: ${r.correct}/${r.secs} seconds correct (${pct(r.correct, r.secs)}), ${r.missed} missed, ${r.wrong} wrong; filter discarded ${r.health.rejected} ${r.rows.join('; ')}`);
          if (lv === 'mild') {
            check(share >= 0.98 && r.wrong === 0, 'synthetic 60 s video at mild meets the spec target (>=98% seconds correct, 0 wrong)', `${pct(r.correct, r.secs)}, ${r.wrong} wrong`);
          } else check(r.wrong === 0, `synthetic 60 s video at ${lv}: no wrong seconds`, `${pct(r.correct, r.secs)} correct, ${r.wrong} wrong`);
        }
        results.climb = Object.fromEntries(Object.entries(out).map(([k, r]) => [k, `${pct(r.correct, r.secs)} correct, ${r.wrong} wrong, ${r.missed} missed`]));
      }


    }
    await page.close();
    if (!SKIP_PAGES) await pageTests(browser, base, results);
  } finally {
    await browser.close();
    srv.close();
  }
  console.log('\nsummary ' + JSON.stringify(results));
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// the test page on a phone-sized viewport
// ---------------------------------------------------------------------------------------------------------------------
async function pageTests(browser, base, results) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, permissions: ['camera'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('[pageerror]', e.message); failures++; });
  page.on('console', m => { if (m.type() === 'error') console.log('[page console error]', m.text()); });
  const shot = async name => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };
  await page.goto(base + '/reader-test.html');
  check(await page.locator('.tabs button').count() === 3, 'test page loads with three modes');
  // no horizontal scroll on a phone
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll at 390 px');

  // ---- photos ----
  await page.setInputFiles('#photo-file', path.join(ROOT, 'test/fixtures/photos/tp17-077-set425.jpg'));
  await page.waitForSelector('#photo-card:not([hidden])');
  await page.locator('#photo-stage').scrollIntoViewIfNeeded();
  const r = await page.locator('#photo-stage').boundingBox();
  const Q = (nx, ny) => [r.x + nx * r.width, r.y + ny * r.height];
  // draw a box around the 77 with the mouse (photo: x 856..1048 of 1512, y 816..957 of 2016)
  await page.mouse.move(...Q(0.55, 0.395)); await page.mouse.down(); await page.mouse.move(...Q(0.62, 0.43), { steps: 4 }); await page.mouse.move(...Q(0.70, 0.485), { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(400);
  check((await page.textContent('#photo-value')).trim() === '77', 'photos: box drawn with the mouse reads 77', await page.textContent('#photo-status'));
  // move the box with a touch drag (CDP), the reading must survive
  const cdp = await ctx.newCDPSession(page);
  const boxRect = await page.locator('#photo-stage .box').boundingBox();
  const cx = boxRect.x + boxRect.width / 2, cy = boxRect.y + boxRect.height / 2;
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', cx, cy);
  for (let i = 1; i <= 6; i++) await touch('touchMove', cx + i * 0.5, cy + i * 0.3);
  await touch('touchEnd');
  await page.waitForTimeout(400);
  const moved = await page.locator('#photo-stage .box').boundingBox();
  check(Math.abs(moved.x - boxRect.x) > 1.5, 'photos: touch drag moves the box', `dx ${(moved.x - boxRect.x).toFixed(1)} px`);
  check((await page.textContent('#photo-value')).trim() === '77', 'photos: still reads 77 after the touch drag', (await page.textContent('#photo-reason')).trim());
  // resize with a handle (mouse)
  const h = await page.locator('#photo-stage .handle[data-h="se"]').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down(); await page.mouse.move(h.x + h.width / 2 + 2, h.y + h.height / 2 + 1, { steps: 3 }); await page.mouse.up();
  await page.fill('#photo-expected', '77');
  await page.waitForTimeout(300);
  check((await page.textContent('#photo-stats')).includes('1/1'), 'photos: tally shows 1/1 correct with expected 77');
  await page.fill('#photo-expected', '78');
  await page.waitForTimeout(200);
  check((await page.textContent('#photo-stats')).includes('0/1') && (await page.textContent('#photo-list')).includes('WRONG'), 'photos: tally flags a wrong expectation');
  await page.fill('#photo-expected', '77');
  await page.click('#photo-zoom');
  await page.waitForTimeout(200);
  await page.locator('#photo-card').scrollIntoViewIfNeeded();
  await shot('photos.png');
  await page.evaluate(() => window.scrollTo(0, 0));

  // ---- video ----
  const vid = await makeSyntheticVideo(browser, base);
  if (!vid) console.log('SKIP  video mode (ffmpeg not available)');
  else {
    await page.click('#tab-video');
    await page.setInputFiles('#video-file', vid.file);
    await page.waitForSelector('#video-stage:not([hidden])');
    await page.waitForFunction(() => document.getElementById('video-process') && !document.getElementById('video-process').disabled);
    // the synthetic frame is 640x360 with a two-digit reading at x 353..560, y 105..255: draw the box around it
    await page.locator('#video-stage').scrollIntoViewIfNeeded();
    const vr2 = await page.locator('#video-stage').boundingBox();
    const V2 = (nx, ny) => [vr2.x + nx * vr2.width, vr2.y + ny * vr2.height];
    await page.mouse.move(...V2(0.53, 0.26)); await page.mouse.down(); await page.mouse.move(...V2(0.7, 0.5), { steps: 4 }); await page.mouse.move(...V2(0.9, 0.76), { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(300);
    check((await page.textContent('#video-value')).trim() === String(vid.firstValue), `video: first frame reads ${vid.firstValue}`, (await page.textContent('#video-status')).trim() + ' ' + (await page.textContent('#video-reason').catch(() => '')));
    await page.selectOption('#video-speed', '1');
    await page.click('#video-process');
    await page.waitForFunction(() => !document.getElementById('video-stop') || document.getElementById('video-stop').disabled, null, { timeout: 90000 });
    await page.waitForTimeout(300);
    const tiles = await page.locator('#video-tiles .tile').count();
    const missed = await page.locator('#video-tiles .tile.missed').count();
    const read = tiles - missed;
    check(tiles >= vid.seconds - 1 && tiles <= vid.seconds + 1, `video: one tile per second (${tiles} tiles for a ${vid.seconds} s video)`);
    check(read / tiles >= 0.9, 'video: most seconds were read', `${read}/${tiles} read`);
    const texts = await page.locator('#video-tiles .tile .val').allTextContents();
    let wrongReads = 0; const truth = vid.truthBySecond;
    texts.forEach((t, i) => { if (t !== 'missed' && Math.abs(parseInt(t, 10) - truth[Math.min(i, truth.length - 1)]) > 1) wrongReads++; });
    check(wrongReads === 0, 'video: no tile shows a value that differs from the truth by more than 1 (display change inside the second)', `${wrongReads} wrong`);
    // tap a tile to mark it wrong, summary must change
    const before = await page.textContent('#video-stats');
    await page.locator('#video-tiles .tile:not(.missed)').nth(2).click();
    const after = await page.textContent('#video-stats');
    check(before !== after && (await page.locator('#video-tiles .tile.wrong').count()) === 1, 'video: tapping a tile marks it wrong and updates the summary');
    check((await page.textContent('#video-verdict')).length > 10, 'video: verdict shown', (await page.textContent('#video-verdict')).trim());
    await page.locator('#video-summary').scrollIntoViewIfNeeded();
    await shot('video.png');
    await page.locator('#video-tiles .tile.wrong').click(); // unmark
    results.video = { tiles, read, wrongReads, seconds: vid.seconds };
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  // ---- live camera (Chromium fake device) + soak ----
  await page.click('#tab-live');
  await page.click('#live-start');
  await page.waitForSelector('#live-stage:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(1500);
  const playing = await page.evaluate(() => { const v = document.getElementById('live-video'); return v.videoWidth > 0 && !v.paused; });
  check(playing, 'live: fake camera stream is playing inline (muted video, playsinline)');
  check(await page.evaluate(() => { const v = document.getElementById('live-video'); return v.muted && v.hasAttribute('playsinline'); }), 'live: video element is muted and playsinline');
  const camInfo = await page.textContent('#live-cam');
  check(/exposure lock/.test(camInfo), 'live: camera info shows exposure and focus lock status', camInfo.trim());
  await page.fill('#soak-minutes', '0.1');
  await page.click('#soak-start');
  await page.waitForSelector('#soak-report:not([hidden])', { timeout: 30000 });
  const report = await page.textContent('#soak-text');
  check(/Seconds: \d+ read/.test(report) && /wake lock/i.test(report) && /Camera stream/.test(report), 'live: soak report lists seconds, wake lock and camera stream', report.split('\n').slice(0, 1).join(''));
  console.log('      soak report from the fake camera:\n        ' + report.split('\n').join('\n        '));
  await page.locator('#soak-card').scrollIntoViewIfNeeded();
  await shot('live.png');
  results.soak = report.split('\n')[3];
  await ctx.close();
}

// A short synthetic video (a display on a dark frame, digits climbing) encoded with ffmpeg. Returns null if ffmpeg is missing.
async function makeSyntheticVideo(browser, base) {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-video-'));
  const page = await browser.newPage();
  await page.goto(base + '/test/browser/harness.html');
  const SECS = 12, FPS = 10;
  const meta = await page.evaluate(async ({ SECS, FPS }) => {
    const R = await import('../../tools/synth-display.js');
    const rng = R.mulberry32(31337);
    const base = R.randomParams(rng, '90', 'mild', { margin: 0.1, jitter: 0, digitH: 150, extras: { degF: false, label: false, rule: false } });
    Object.assign(base, { w: 640, h: 360, H: 150, xr: 560, y0: 105, rotation: 0.5 });
    const truth = [], frames = [];
    for (let f = 0; f < SECS * FPS; f++) {
      const t = f / FPS, v = Math.round(92 + t * 1.6); // 92 .. 111: crosses 99 -> 100 near 4.4 s
      if (f % FPS === 0) truth.push(v);
      const p = Object.assign({}, base, { text: String(v), seed: f * 7 + 1 });
      const img = R.renderDisplay(p);
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0);
      frames.push(c.toDataURL('image/png').split(',')[1]);
    }
    return { truth, frames };
  }, { SECS, FPS });
  await page.close();
  meta.frames.forEach((b64, i) => fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.png`), Buffer.from(b64, 'base64')));
  const out = path.join(dir, 'synthetic.webm');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%04d.png'), '-c:v', 'libvpx', '-b:v', '3M', '-pix_fmt', 'yuv420p', out]);
  if (r.status !== 0) { console.log('SKIP  video mode (ffmpeg failed: ' + r.stderr + ')'); return null; }
  return { file: out, seconds: SECS, firstValue: meta.truth[0], truthBySecond: meta.truth };
}

main().catch(e => { console.error(e); process.exit(2); });
