import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createReadingFilter, isWholeCelsiusF } from '../../js/reader/filter.js';

const ok = value => ({ status: 'ok', value });
const none = { status: 'none', value: null };
const dashes = { status: 'dashes', value: null };

// feed one second of frames and close it
function second(f, ...frames) {
  for (const fr of frames) f.addFrame(typeof fr === 'number' ? ok(fr) : fr);
  return f.closeSecond();
}

// NOTE on the numbers: the TP17 shows only round(1.8 c + 32) for whole c, so most tests use values it can show
// (50 52 54 55 57 59 61 63 64 66 ... 199 201 203 205 207 208 210 ...); the ones it cannot show are tested on purpose below.

test('whole-degree Celsius: which Fahrenheit numbers the thermometer can show', () => {
  for (const v of [50, 77, 100, 199, 255, 264, 266, 300, 550]) assert.equal(isWholeCelsiusF(v), true, String(v));
  for (const v of [254, 263, 265, 380, 49, 80, 112, 200, 202]) assert.equal(isWholeCelsiusF(v), false, String(v));
  assert.equal(isWholeCelsiusF(77.5), false);
  assert.equal(isWholeCelsiusF(NaN), false);
  let n = 0; for (let v = 50; v < 50 + 180; v++) if (isWholeCelsiusF(v)) n++;
  assert.equal(n, 100, 'every 9 °F is 5 °C: 5 of 9 numbers can appear');
});

test('the real roast (first-batch CSV) shows what the old median did: a few readings the thermometer cannot show', () => {
  const rows = fs.readFileSync(new URL('../fixtures/roasts/first-batch-esp-2026-11-17.csv', import.meta.url), 'utf8').split('\n').slice(1).filter(Boolean).map(l => l.split(','));
  const vals = rows.map(r => r[1]).filter(v => v !== '').map(Number);
  const bad = vals.filter(v => !isWholeCelsiusF(v));
  assert.ok(vals.length > 200);
  assert.ok(bad.length > 0 && bad.length < vals.length * 0.15, `${bad.length} of ${vals.length}: ${bad}`);   // 254, 263, 265, 380 ... are in it
  assert.ok(bad.includes(254) && bad.includes(380));
});

test('a second takes the latest value that at least two frames read (the latest, when none has two)', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 77, 77, 77, 77), 77);
  assert.equal(second(f, 79, 77, 79, 79), 79);
  assert.equal(second(f, 79, 79, 77), 79);          // one odd frame at the end does not outvote the rest of the second
  assert.equal(second(f, 77, 79), 79);              // nobody has two frames: the latest
  assert.equal(second(f, 77, 77, 79, 79), 79);      // a change in the middle of the second: where it ended
  assert.equal(second(f, 79, 77, 77, 77), 77);
});

test('a second always holds a value that was seen: never an average of two readings', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 253, 255), 255);           // level: the later one, not 254 (which the display cannot show)
  assert.equal(second(f, 255, 253), 253);
  assert.equal(second(f, 253, 253, 255, 255), 255);
  assert.equal(second(f, 253, 255, 255, 253), 253);
  assert.equal(second(f, 255, 255, 255, 253), 255); // a lone frame at the end does not outvote three
  const g = createReadingFilter();
  assert.equal(second(g, 378, 381), 381);           // not 380
});

test('a display that changes twice a second (270 -> 264) gives its later value, not a mix', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 271, 271, 271, 271), 271);
  assert.equal(second(f, 270, 270, 264, 264), 264);  // changed half way through the second: the one it ended on
  assert.equal(second(f, 264, 264, 264, 266), 264);  // one frame of something else does not decide
  assert.equal(second(f, 264, 266, 266, 266), 266);
  assert.equal(f.health().rejectedDisagree, 0, 'frames 6 F apart are a real change, not a disagreement');
});

test('frames wildly apart with no clear majority end the second as a disagreement (frameSpreadF)', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 199, 199), 199);
  assert.equal(second(f, 201, 151), null);          // two frames, no majority
  assert.equal(second(f, 203, 160, 162), null);     // three frames, no majority
  assert.equal(f.lastOutcome().kind, 'disagree');
  assert.deepEqual(f.lastOutcome().values, [160, 162, 203]);
  assert.equal(second(f, 203, 203, 160), 203);      // majority wins, the outlier is dropped
  const h = f.health();
  assert.equal(h.rejectedDisagree, 2);
  assert.equal(h.secondsRead, 2);
  // the spread is configurable
  const g = createReadingFilter({ frameSpreadF: 30 });
  assert.equal(second(g, 199, 217), 217);
});

test('none frames are ignored when other frames read', () => {
  const f = createReadingFilter();
  assert.equal(second(f, none, 120, none, 120), 120);
  assert.equal(f.health().framesNone, 2);
});

test('a second with no ok frame is missing, not a value', () => {
  const f = createReadingFilter();
  assert.equal(second(f, none, none, none, none), null);
  assert.equal(second(f), null);
  const h = f.health();
  assert.equal(h.secondsMissing, 2);
  assert.equal(h.secondsRead, 0);
  assert.equal(h.rejected, 0);
});

test('range check: below 50 and above 550 are discarded and counted', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 46, 46), null);
  assert.equal(second(f, 50, 50), 50);
  assert.equal(second(f, 552), null);
  const f2 = createReadingFilter();
  assert.equal(second(f2, 550), 550);
  assert.equal(f2.health().rejectedRange, 0);
  assert.equal(f.health().rejectedRange, 2);
  assert.equal(f.health().rejected, 2);
  assert.equal(f.lastOutcome().kind, 'range');
});

// ---- numbers the thermometer cannot show ----

test('a number the thermometer cannot show is a misread: not a frame, its own outcome and counter', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 253), 253);
  assert.equal(second(f, 254, 254, 254, 254), null);
  assert.deepEqual(f.lastOutcome(), { kind: 'impossible', value: 254, values: [254, 254, 254, 254] });
  let h = f.health();
  assert.equal(h.rejectedImpossible, 1);
  assert.equal(h.rejected, 1);
  assert.equal(h.framesImpossible, 4);
  assert.equal(h.framesOk, 1);
  assert.equal(h.secondsMissing, 0, 'it is a rejection, not a missing second');
  // among good frames it does not count, even as a majority
  assert.equal(second(f, 254, 254, 255), 255);
  h = f.health();
  assert.equal(h.framesImpossible, 6);
  assert.equal(h.rejectedImpossible, 1);
  // dashes outvoting it are still a missing second
  assert.equal(second(f, 254, dashes, dashes), null);
  assert.equal(f.lastOutcome().kind, 'missing');
});

test('wholeCelsius: false switches the check off', () => {
  const f = createReadingFilter({ wholeCelsius: false });
  assert.equal(second(f, 254, 254), 254);
  assert.equal(f.health().framesImpossible, 0);
});

test('a misread that is a valid number is not caught by this check (it is the job of the jump rule)', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 255), 255);
  assert.equal(second(f, 253), 253);
});

// ---- jumps ----

test('jump check: a value far from the last accepted one is discarded and does not move the anchor', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 199), 199);
  assert.equal(second(f, 217), 217);                // 18 F in one second: inside 15 + 5
  assert.equal(second(f, 252), null);               // +35
  assert.deepEqual(f.lastOutcome(), { kind: 'jump', value: 252, last: 217, allowed: 20, expected: 217 });
  assert.equal(second(f, 219), 219);                // back near the anchor
  assert.equal(f.health().rejectedJump, 1);
});

test('the allowance grows by 5 F per second since the last accepted value, up to 40', () => {
  const g = (gap, v) => { const f = createReadingFilter(); second(f, 199); for (let i = 0; i < gap; i++) second(f, none); return second(f, v); };
  assert.equal(g(2, 228), 228);                     // 29 within 15 + 5 * 3
  assert.equal(g(2, 232), null);                    // 33 over it
  assert.equal(g(9, 239), 239);                     // 40: the cap
  assert.equal(g(9, 241), null);                    // 42
  assert.equal(g(30, 241), null);                   // the cap holds for any gap: it is a candidate, see below
});

test('with a trend the bound follows the trend: a steady 4 F/s climb through gaps is accepted', () => {
  const f = createReadingFilter();
  const at = {}; for (let t = 0; t <= 40; t++) at[t] = nearestValid(100 + 4 * t);
  const got = [];
  for (let t = 0; t <= 40; t++) got.push(t % 3 === 2 ? second(f, none) : second(f, at[t]));
  assert.deepEqual(got.filter((v, t) => t % 3 !== 2 && v === null), []);
  assert.equal(f.health().rejectedJump, 0);
});

test('an isolated wrong second 10 F or more off is rejected while the last reading is recent', () => {
  const f = createReadingFilter();
  for (const v of [199, 201, 203, 205]) assert.equal(second(f, v), v);
  assert.equal(second(f, 217), null);               // +12 from 205 (a tens digit one segment off)
  assert.equal(second(f, 207), 207);                // and the filter is not stuck
  assert.equal(second(f, 307), null);               // a hundreds digit
  assert.equal(second(f, 208), 208);
  assert.equal(f.health().rejectedJump, 2);
});

test('a real change is not locked out for long: the new level is taken after a few seconds', () => {
  const f = createReadingFilter();
  second(f, 199);
  // the probe is moved and the reading jumps to 300 and stays there
  assert.equal(second(f, 300), null);
  assert.equal(second(f, 302), null);
  assert.equal(second(f, 304), 304);                // third agreeing second
  assert.equal(second(f, 306), 306);
  assert.equal(f.health().reanchors, 1);
});

test('after a long gap the first two agreeing readings are taken (the last accepted reading is stale)', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 111), 111);
  for (let i = 0; i < 51; i++) second(f, none);     // the real roast: 51 s without a reading
  assert.equal(second(f, 241), null);               // could still be a wrong second
  assert.equal(second(f, 243), 243);                // but two in a row agree
  assert.equal(f.health().reanchors, 1);
});

test('candidates that disagree with each other never become the anchor', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 100), 100);
  for (const v of [300, 333, 300, 342, 300, 351]) assert.equal(second(f, v), null);
  assert.equal(f.health().reanchors, 0);
  assert.equal(second(f, 102), 102);
});

test('missing seconds between agreeing candidates do not reset them', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 199), 199);
  assert.equal(second(f, 300), null);
  assert.equal(second(f, 302), null);
  assert.equal(second(f, none), null);
  assert.equal(second(f, 304), 304);
  assert.equal(f.health().reanchors, 1);
});

test('a swing of 11 F up and 7 F down in a second (seen in the real roast) is followed', () => {
  const f = createReadingFilter();
  const seq = [370, 372, 376, 387, 380, 378, 381, 383, 385, 376, 381, 387, 388, 390];
  const got = seq.map(v => second(f, v));
  const lost = got.filter(v => v === null).length;
  assert.ok(lost <= 1, `lost ${lost}: ${JSON.stringify(got)}`);
});

test('dashes are missing seconds, not values and not discards', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 151), 151);
  assert.equal(second(f, dashes, dashes, dashes, dashes), null);
  assert.equal(second(f, dashes, dashes, none, none), null);
  const h = f.health();
  assert.equal(h.secondsMissing, 2);
  assert.equal(h.dashSeconds, 2);
  assert.equal(h.rejected, 0);
  assert.equal(h.secondsRead, 1);
  assert.equal(second(f, 153), 153);                // and the filter still compares against the last real value
});

test('ok frames outvote a stray dashes frame; dashes outvote a stray ok frame', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 91, dashes, 91, 91), 91);
  assert.equal(second(f, 91, dashes, dashes, dashes), null);
});

test('reanchor() sets the trusted value, e.g. after manual entry', () => {
  const f = createReadingFilter();
  assert.equal(second(f, 100), 100);
  f.reanchor(300);
  assert.equal(second(f, 302), 302);
  assert.equal(f.health().lastAccepted, 302);
});

test('first reading has nothing to be compared with', () => {
  const f = createReadingFilter();
  assert.equal(second(f, none), null);
  assert.equal(second(f, 399), 399);
});

test('health counters and seconds since the last accepted reading', () => {
  const f = createReadingFilter();
  second(f, 100); second(f, none); second(f, none); second(f, 559);
  const h = f.health();
  assert.equal(h.secondsRead, 1);
  assert.equal(h.secondsMissing, 2);
  assert.equal(h.rejectedRange, 1);
  assert.equal(h.secondsSinceAccepted, 3);
  assert.equal(h.secondsClosed, 4);
  assert.equal(h.lastAccepted, 100);
});

test('custom limits are honoured', () => {
  const f = createReadingFilter({ minF: 14, maxF: 572, maxJumpF: 5, jumpPerSecF: 0 });
  assert.equal(second(f, 14), 14);
  assert.equal(second(f, 19), 19);
  assert.equal(second(f, 25), null);
});

test('a 60 s climb at 4 fps through 99 to 100 with transition frames yields one correct value per second', () => {
  const f = createReadingFilter();
  const out = [];
  for (let s = 0; s < 60; s++) {
    const truth = nearestValid(80 + s * 0.8);       // 80 .. 127 F
    for (let k = 0; k < 4; k++) f.addFrame(k === 0 && s % 7 === 0 ? none : ok(truth)); // some seconds lose a frame
    out.push([truth, f.closeSecond()]);
  }
  assert.ok(out.every(([truth, v]) => v === truth));
  assert.equal(f.health().secondsRead, 60);
});

test('lastOutcome() says why the last second ended as it did', () => {
  const f = createReadingFilter();
  const sec = (vals, status = 'ok') => { for (const v of vals) f.addFrame({ status, value: v }); return f.closeSecond(); };
  assert.equal(f.lastOutcome().kind, 'missing');
  assert.equal(sec([100, 100]), 100);
  assert.deepEqual(f.lastOutcome(), { kind: 'read', value: 100 });
  assert.equal(sec([300, 300]), null);
  assert.deepEqual(f.lastOutcome(), { kind: 'jump', value: 300, last: 100, allowed: 20, expected: 100 });
  assert.equal(sec([46, 46]), null);
  assert.deepEqual(f.lastOutcome(), { kind: 'range', value: 46 });
  assert.equal(sec([100, 129, 100, 129]), null);
  assert.equal(f.lastOutcome().kind, 'disagree');
  assert.equal(sec([254, 254]), null);
  assert.equal(f.lastOutcome().kind, 'impossible');
  assert.equal(sec([], 'dashes'), null);
  assert.equal(f.lastOutcome().kind, 'missing');
});

// ---- the real roast: lockout and wrong seconds, by simulation ----

function nearestValid(v) { let b = Math.round(v); for (let d = 0; d < 5; d++) { if (isWholeCelsiusF(b + d)) return b + d; if (isWholeCelsiusF(b - d)) return b - d; } return b; }
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// the readings of the real roast; the few the thermometer cannot show (averages made by the old filter) count as unread seconds
const ROAST = fs.readFileSync(new URL('../fixtures/roasts/first-batch-esp-2026-11-17.csv', import.meta.url), 'utf8').split('\n').slice(1).filter(Boolean).map(l => l.split(',')).map(r => (r[1] === '' || !isWholeCelsiusF(+r[1]) ? null : +r[1]));

// The seconds the reader did not read are filled in with a concave curve (fast rise first, as a heating roast does), so the
// simulated climb is as steep as the real one can have been; then each run drops a share of the seconds and may replace some
// by a misread (one segment off in one digit that still looks like a digit).
function filledRoast() {
  const pts = ROAST.map((v, i) => [i, v]).filter(p => p[1] !== null);
  return ROAST.map((_, i) => {
    let a = pts.filter(p => p[0] <= i).pop() || pts[0], b = pts.find(p => p[0] >= i) || a;
    if (a[0] === b[0]) return a[1];
    const u = (i - a[0]) / (b[0] - a[0]), k = b[1] > a[1] ? 1.5 : 0;
    return nearestValid(a[1] + (b[1] - a[1]) * (k ? (1 - Math.exp(-k * u)) / (1 - Math.exp(-k)) : u));
  });
}
const SEGS = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
const DIGIT_OF = Object.fromEntries(Object.entries(SEGS).map(([d, s]) => [[...s].sort().join(''), d]));
function oneSegmentOff(v, rng) {
  const s = String(v);
  for (let tries = 0; tries < 50; tries++) {
    const pos = Math.floor(rng() * s.length), seg = 'abcdefg'[Math.floor(rng() * 7)];
    const set = new Set(SEGS[s[pos]]); set.has(seg) ? set.delete(seg) : set.add(seg);
    const d = DIGIT_OF[[...set].sort().join('')];
    if (d === undefined) continue;
    const w = s.slice(0, pos) + d + s.slice(pos + 1);
    if (+w !== v && +w >= 14 && +w <= 572 && !(w.length === 3 && !'12345'.includes(w[0]))) return +w;
  }
  return null;
}
function simulate(drop, wrongRate, seed, opts) {
  const truth = filledRoast(), rng = mulberry(seed), f = createReadingFilter(opts);
  let read = 0, lost = 0, run = 0, longest = 0, big = 0, bigAccepted = 0;
  for (let t = 0; t < truth.length; t++) {
    let shown = null, wrong = false;
    if (rng() >= drop) {
      shown = truth[t];
      if (rng() < wrongRate) { const w = oneSegmentOff(truth[t], rng); if (w !== null) { shown = w; wrong = true; } }
    }
    if (shown !== null) for (let k = 0; k < 4; k++) f.addFrame(ok(shown));
    const v = f.closeSecond();
    if (wrong) { if (isWholeCelsiusF(shown) && Math.abs(shown - truth[t]) >= 20) { big++; if (v !== null && Math.abs(v - truth[t]) >= 20) bigAccepted++; } }
    else if (shown !== null) { read++; if (v === null) { lost++; run++; longest = Math.max(longest, run); } else run = 0; }
  }
  return { read, lost, longest, big, bigAccepted };
}

test('real roast, readings as the reader gave them: only the seconds that really jumped are lost', () => {
  const f = createReadingFilter();
  let read = 0, lost = [];
  ROAST.forEach((v, t) => {
    if (v !== null) { read++; for (let k = 0; k < 4; k++) f.addFrame(ok(v)); }
    const got = f.closeSecond();
    if (v !== null && got === null) lost.push(t);
    if (got !== null) assert.equal(got, v, `second ${t}`);
  });
  assert.ok(read > 200);
  assert.ok(lost.length <= 3, `lost seconds ${lost}`);   // the first 241 after 51 s without a reading, and a swing of 11 F
  assert.ok(lost.includes(75) && !lost.includes(76), 'the 51 s gap ends with at most one lost second');
});

test('lockout simulation on the real roast: 10, 40 and 70% of the seconds missing, 3% misreads', () => {
  for (const drop of [0.1, 0.4, 0.7]) {
    let read = 0, lost = 0, longest = 0, big = 0, bigAccepted = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = simulate(drop, 0.03, seed * 7919);
      read += r.read; lost += r.lost; longest = Math.max(longest, r.longest); big += r.big; bigAccepted += r.bigAccepted;
    }
    assert.ok(lost / read <= 0.02, `drop ${drop}: lost ${lost} of ${read} read seconds to the filter`);
    assert.ok(longest <= 4, `drop ${drop}: longest lockout ${longest} s`);
    assert.ok(big >= 5, 'the run has misreads to catch');
    // with most seconds missing the allowance has grown to 30-40 F by the time a reading arrives: some misreads then cannot be told from a real climb
    assert.ok(bigAccepted / big <= (drop > 0.5 ? 0.5 : 0.03), `drop ${drop}: ${bigAccepted} of ${big} misreads 20 F or more off were accepted`);
  }
});
