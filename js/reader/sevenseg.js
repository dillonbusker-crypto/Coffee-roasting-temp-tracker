// Seven-segment reader for the ThermoPro TP17 LCD. Pure: works on any {data, width, height}
// RGBA object (browser ImageData or a plain object in Node).
//
// readDisplay(imageData, opts?) -> { status: 'ok'|'dashes'|'none', value, digits, confidence, debug }

// ---------- preprocessing ----------

export function toGray(img) {
  const { data, width: w, height: h } = img;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return g;
}

// Area-average (down) / bilinear (up) resample of a float plane to (dw, dh).
export function resample(src, sw, sh, dw, dh) {
  const tmp = new Float32Array(dw * sh);
  const sx = sw / dw;
  for (let x = 0; x < dw; x++) {
    let a = x * sx, b = (x + 1) * sx;
    if (sx <= 1) { // upsample: linear between centres
      const c = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const i0 = Math.floor(c), i1 = Math.min(sw - 1, i0 + 1), f = c - i0;
      for (let y = 0; y < sh; y++) tmp[y * dw + x] = src[y * sw + i0] * (1 - f) + src[y * sw + i1] * f;
    } else {
      const i0 = Math.floor(a), i1 = Math.min(sw - 1, Math.ceil(b) - 1);
      for (let y = 0; y < sh; y++) {
        let s = 0, wsum = 0;
        for (let i = i0; i <= i1; i++) { const wt = Math.min(b, i + 1) - Math.max(a, i); s += src[y * sw + i] * wt; wsum += wt; }
        tmp[y * dw + x] = s / wsum;
      }
    }
  }
  const out = new Float32Array(dw * dh);
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    let a = y * sy, b = (y + 1) * sy;
    if (sy <= 1) {
      const c = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const i0 = Math.floor(c), i1 = Math.min(sh - 1, i0 + 1), f = c - i0;
      for (let x = 0; x < dw; x++) out[y * dw + x] = tmp[i0 * dw + x] * (1 - f) + tmp[i1 * dw + x] * f;
    } else {
      const i0 = Math.floor(a), i1 = Math.min(sh - 1, Math.ceil(b) - 1);
      for (let x = 0; x < dw; x++) {
        let s = 0, wsum = 0;
        for (let i = i0; i <= i1; i++) { const wt = Math.min(b, i + 1) - Math.max(a, i); s += tmp[i * dw + x] * wt; wsum += wt; }
        out[y * dw + x] = s / wsum;
      }
    }
  }
  return out;
}

// Background (paper) level: high percentile per block, bilinear between block centres.
export function estimateBackground(g, w, h, block) {
  const bx = Math.max(2, Math.round(w / block)), by = Math.max(2, Math.round(h / block));
  const grid = new Float32Array(bx * by);
  const tmp = [];
  for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
    const x0 = Math.floor(i * w / bx), x1 = Math.floor((i + 1) * w / bx);
    const y0 = Math.floor(j * h / by), y1 = Math.floor((j + 1) * h / by);
    tmp.length = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) tmp.push(g[y * w + x]);
    tmp.sort((a, b) => a - b);
    grid[j * bx + i] = tmp[Math.min(tmp.length - 1, Math.floor(tmp.length * 0.8))];
  }
  const bg = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(by - 1, Math.max(0, (y + 0.5) * by / h - 0.5));
    const j0 = Math.floor(fy), j1 = Math.min(by - 1, j0 + 1), wy = fy - j0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bx - 1, Math.max(0, (x + 0.5) * bx / w - 0.5));
      const i0 = Math.floor(fx), i1 = Math.min(bx - 1, i0 + 1), wx = fx - i0;
      bg[y * w + x] = (grid[j0 * bx + i0] * (1 - wx) + grid[j0 * bx + i1] * wx) * (1 - wy) + (grid[j1 * bx + i0] * (1 - wx) + grid[j1 * bx + i1] * wx) * wy;
    }
  }
  return bg;
}

export function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
}

// Returns { w, h, scale, ink (0..1 darkness), ratio, contrast }
export function preprocess(img, opts = {}) {
  const workH = opts.workHeight || 96;
  const gray = toGray(img);
  let scale = workH / img.height;
  scale = Math.min(scale, 2);
  let w = Math.max(8, Math.round(img.width * scale)), h = Math.max(8, Math.round(img.height * scale));
  if (w > 480) { const s2 = 480 / w; w = 480; h = Math.max(8, Math.round(h * s2)); scale *= s2; }
  const g = resample(gray, img.width, img.height, w, h);
  const bg = estimateBackground(g, w, h, Math.max(8, h / 4));
  const ratio = new Float32Array(w * h);
  for (let i = 0; i < ratio.length; i++) ratio[i] = g[i] / (bg[i] + 1);
  const p2 = percentile(ratio, 0.02);
  const contrast = 1 - p2;
  const lo = 1 - 0.65 * contrast, hi = 1 - 0.35 * contrast;
  const ink = new Float32Array(w * h);
  for (let i = 0; i < ink.length; i++) { const v = (hi - ratio[i]) / (hi - lo); ink[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  const thick = open2d(ink, w, h, Math.max(1, Math.round(h / 36)));
  return { w, h, scale, ink, thick, ratio, contrast, gray: g };
}

// Morphological opening (erode then dilate) with a (2r+1) square: removes strokes thinner than the digit segments
// (labels, the degree sign, rules) and keeps the thick segments.
export function open2d(src, w, h, r) {
  const a = minMax(src, w, h, r, true);
  return minMax(a, w, h, r, false);
}
function minMax(src, w, h, r, isMin) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = isMin ? Infinity : -Infinity;
    for (let k = -r; k <= r; k++) {
      const xx = x + k; if (xx < 0 || xx >= w) { if (isMin) v = 0; continue; }
      const t = src[y * w + xx]; if (isMin ? t < v : t > v) v = t;
    }
    tmp[y * w + x] = v === Infinity || v === -Infinity ? 0 : v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = isMin ? Infinity : -Infinity;
    for (let k = -r; k <= r; k++) {
      const yy = y + k; if (yy < 0 || yy >= h) { if (isMin) v = 0; continue; }
      const t = tmp[yy * w + x]; if (isMin ? t < v : t > v) v = t;
    }
    out[y * w + x] = v === Infinity || v === -Infinity ? 0 : v;
  }
  return out;
}

// ---------- slant ----------

// Shear a plane horizontally: row y moves right by (y - h/2) * t (+ pad). t > 0 straightens right-leaning italics.
export function shear(src, w, h, t) {
  const pad = Math.ceil(Math.abs(t) * h / 2) + 1;
  const dw = w + 2 * pad;
  const out = new Float32Array(dw * h);
  const cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    const s = (y - cy) * t + pad; // dst x' = src x + s
    for (let x = 0; x < dw; x++) {
      const sx = x - s; // source coordinate
      if (sx <= -1 || sx >= w) continue;
      const i0 = Math.floor(sx), f = sx - i0;
      const a = i0 >= 0 ? src[y * w + i0] : 0, b = i0 + 1 < w ? src[y * w + i0 + 1] : 0;
      out[y * dw + x] = a * (1 - f) + b * f;
    }
  }
  return { data: out, w: dw, h, pad };
}

// ---------- integral images ----------

export function integral(data, w, h) {
  const I = new Float64Array((w + 1) * (h + 1));
  const W1 = w + 1;
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      run += data[y * w + x];
      I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + run;
    }
  }
  return I;
}

// Mean of a rectangle (float bounds, rounded to pixels, clamped). Returns the mean and, via out[0], the fraction inside.
function rectSum(I, w, h, x0, y0, x1, y1) {
  let a = Math.round(x0), b = Math.round(x1), c = Math.round(y0), d = Math.round(y1);
  if (b <= a) b = a + 1;
  if (d <= c) d = c + 1;
  if (a < 0) a = 0; if (c < 0) c = 0; if (b > w) b = w; if (d > h) d = h;
  if (b <= a || d <= c) return 0;
  const W1 = w + 1;
  return I[d * W1 + b] - I[c * W1 + b] - I[d * W1 + a] + I[c * W1 + a];
}
function rectArea(x0, y0, x1, y1) {
  const a = Math.round(x0), b = Math.max(a + 1, Math.round(x1)), c = Math.round(y0), d = Math.max(c + 1, Math.round(y1));
  return (b - a) * (d - c);
}

// ---------- the digit model ----------
// Units: x in cell pitches P, measured from the cell's right edge (negative = left); y in digit heights H from the top.
// Measured on the real TP17 photo after straightening the slant.
export const SEG_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const SEG = [
  /* a */ [-0.635, -0.295, 0.035, 0.105],
  /* b */ [-0.205, -0.065, 0.20, 0.38],
  /* c */ [-0.205, -0.065, 0.62, 0.80],
  /* d */ [-0.635, -0.295, 0.895, 0.965],
  /* e */ [-0.86, -0.72, 0.62, 0.80],
  /* f */ [-0.86, -0.72, 0.20, 0.38],
  /* g */ [-0.635, -0.295, 0.455, 0.515],
];
export const DIGIT_PATTERNS = {
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg',
  '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};
const PATTERN_TO_DIGIT = {};
for (const [d, segs] of Object.entries(DIGIT_PATTERNS)) {
  let m = 0;
  for (const ch of segs) m |= 1 << SEG_NAMES.indexOf(ch);
  PATTERN_TO_DIGIT[m] = d;
}
const DASH_MASK = 1 << 6;
const RHO = 0.715;      // pitch / height
const BODY_L = -0.93;   // left edge of the digit body from the right edge, in P

function cellFills(I, w, h, xr, y0, H, P, out, o) {
  for (let s = 0; s < 7; s++) {
    const g = SEG[s];
    const x0 = xr + g[0] * P, x1 = xr + g[1] * P, ya = y0 + g[2] * H, yb = y0 + g[3] * H;
    out[o + s] = rectSum(I, w, h, x0, ya, x1, yb) / rectArea(x0, ya, x1, yb);
  }
}

// ---------- lattice search ----------

const THETAS_DEG = [-2.5, 0, 2.5, 5, 7.5, 10, 12.5];
const KAPPA = 1.5;   // cost of stray ink in an off segment, relative to a hole in an on segment
const LAMBDA = 3.0;
const ON_T = 0.8, OFF_T = 0.12; // a segment is clearly on above ON_T, clearly off below OFF_T, otherwise the frame is doubtful
const AMBIG = 3;      // penalty (in segment areas) for a doubtful segment  // cost of ink outside the digit bodies

function cellScore(f, A) {
  // best of (segment on, segment off) in area-weighted units
  const on = (2 * f - 1) * A, off = -KAPPA * f * A;
  return on > off ? on : off;
}

const tmpF = new Float64Array(21);

function segAreas(P, H) {
  const A = new Float64Array(7);
  for (let s = 0; s < 7; s++) {
    const g = SEG[s];
    A[s] = rectArea(0, 0, (g[1] - g[0]) * P, (g[3] - g[2]) * H);
  }
  return A;
}

// Score of one cell on its own (stage 1).
function singleCellScore(I, w, h, xr, y0, H, P, A) {
  let sc = 0, nOn = 0;
  for (let s = 0; s < 7; s++) {
    const g = SEG[s];
    const x0 = xr + g[0] * P, x1 = xr + g[1] * P, ya = y0 + g[2] * H, yb = y0 + g[3] * H;
    const f = rectSum(I, w, h, x0, ya, x1, yb) / rectArea(x0, ya, x1, yb);
    sc += cellScore(f, A[s]);
    if (f >= 0.5) nOn++;
  }
  return nOn ? sc : -1e9;
}

// Disjoint tiles that tile the digit body; ink inside a lit segment's tile is explained, other ink in the body is not.
const TILE = [
  /* a */ [-0.96, 0.03, -0.03, 0.15],
  /* b */ [-0.32, 0.03, 0.15, 0.42],
  /* c */ [-0.32, 0.03, 0.57, 0.85],
  /* d */ [-0.96, 0.03, 0.85, 1.03],
  /* e */ [-0.96, -0.60, 0.57, 0.85],
  /* f */ [-0.96, -0.60, 0.15, 0.42],
  /* g */ [-0.96, 0.03, 0.42, 0.57],
];

// Score of the three-cell lattice. Returns -Infinity when the lattice does not fit the image.
function latticeScore(pl, xr0, y0, H, P, info) {
  const { I, w, h } = pl;
  const xr2 = xr0 - 2 * P;
  if (xr0 > w + 1 || xr2 + BODY_L * P < -1 || y0 < -1 || y0 + H > h + 1) return -Infinity;
  const A = segAreas(P, H);
  let sc = 0, bodyInk = 0, inner = 0;
  for (let i = 0; i < 3; i++) {
    const xr = xr0 - i * P;
    let nOn = 0, explained = 0;
    for (let s = 0; s < 7; s++) {
      const g = SEG[s];
      const x0 = xr + g[0] * P, x1 = xr + g[1] * P, ya = y0 + g[2] * H, yb = y0 + g[3] * H;
      const f = rectSum(I, w, h, x0, ya, x1, yb) / rectArea(x0, ya, x1, yb);
      tmpF[i * 7 + s] = f;
      if (f >= ON_T) {
        nOn++;
        const t = TILE[s];
        const ink = rectSum(I, w, h, xr + t[0] * P, y0 + t[2] * H, xr + t[1] * P, y0 + t[3] * H);
        explained += ink;
        sc += ink - (1 - f) * A[s];
      } else if (f > OFF_T) sc -= AMBIG * A[s];
    }
    if (i === 0 && !nOn) return -Infinity;
    const bi = rectSum(I, w, h, xr + (BODY_L - 0.03) * P, y0 - 0.03 * H, xr + 0.03 * P, y0 + 1.03 * H);
    bodyInk += bi;
    inner += Math.max(0, bi - explained);
  }
  const zInk = rectSum(I, w, h, xr2 + (BODY_L - 0.02) * P, y0 - 0.3 * H, xr0 + 1.1 * P, y0 + 1.3 * H);
  const outer = Math.max(0, zInk - bodyInk);
  if (info) { info.U = outer + inner; info.outer = outer; info.inner = inner; info.zInk = zInk; info.bodyInk = bodyInk; }
  return sc - LAMBDA * (outer + inner);
}

function buildPlanes(ink, w, h, thetasDeg) {
  return thetasDeg.map(deg => {
    const t = Math.tan(deg * Math.PI / 180);
    const s = shear(ink, w, h, t);
    return { deg, t, w: s.w, h: s.h, pad: s.pad, data: s.data, I: integral(s.data, s.w, s.h) };
  });
}

let _cnt = 0;
export const _stats = () => _cnt;
function findGeometry(planes, h, opts) {
  const cands = [];
  const stage1 = opts.stage1Planes || [1, 3, 5];
  const Hmin = Math.max(16, Math.round(h * 0.34)), Hmax = h + 1;
  const ox0 = new Int32Array(7), ox1 = new Int32Array(7), oy0 = new Int32Array(7), oy1 = new Int32Array(7), area = new Float64Array(7), Aw = new Float64Array(7);
  for (const pi of stage1) {
    const pl = planes[pi], I = pl.I, W1 = pl.w + 1, w = pl.w, hh = pl.h;
    for (let H = Hmin; H <= Hmax; H += 2) {
      const P = RHO * H;
      for (let s = 0; s < 7; s++) {
        const g = SEG[s];
        ox0[s] = Math.round(g[0] * P); ox1[s] = Math.max(ox0[s] + 1, Math.round(g[1] * P));
        oy0[s] = Math.round(g[2] * H); oy1[s] = Math.max(oy0[s] + 1, Math.round(g[3] * H));
        area[s] = (ox1[s] - ox0[s]) * (oy1[s] - oy0[s]);
        Aw[s] = area[s];
      }
      const xmin = Math.round(0.9 * P);
      for (let y0 = -1; y0 + H <= h + 1; y0 += 2) {
        if (y0 + oy0[0] < 0) continue;
        for (let xr = xmin; xr <= w + 1; xr += 2) {
          let nOn = 0, gain = 0, pen = 0;
          for (let s = 0; s < 7; s++) {
            const xa = xr + ox0[s], xb = xr + ox1[s], ya = y0 + oy0[s], yb = y0 + oy1[s];
            if (xa < 0 || xb > w || yb > hh) { nOn = 0; break; }
            const f = (I[yb * W1 + xb] - I[ya * W1 + xb] - I[yb * W1 + xa] + I[ya * W1 + xa]) / area[s];
            if (f >= 0.6) { nOn++; gain += f * Aw[s]; } else if (f > 0.15) pen += f * Aw[s];
          }
          if (!nOn || pen > 0.35 * gain) continue;
          _cnt++;
          const lsc = latticeScore(pl, xr, y0, H, P, null);
          if (lsc > 0) cands.push({ sc: lsc, pi, xr, y0, H });
        }
      }
    }
  }
  cands.sort((a, b) => b.sc - a.sc);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= (opts.topK || 10)) break;
    if (picked.some(p => Math.abs(p.xr - c.xr) <= 5 && Math.abs(p.y0 - c.y0) <= 5 && Math.abs(p.H - c.H) <= 7)) continue;
    picked.push(c);
  }
  // stage 2: hill-climb each candidate on the full lattice
  let best = null;
  for (const c of picked) {
    let cur = { pi: c.pi, xr0: c.xr, y0: c.y0, H: c.H, rho: RHO };
    cur.score = latticeScore(planes[cur.pi], cur.xr0, cur.y0, cur.H, cur.rho * cur.H, null);
    for (let iter = 0; iter < 14; iter++) {
      let move = null;
      const tryMove = (pi, xr0, y0, H, rho) => {
        if (pi < 0 || pi >= planes.length || rho < 0.6 || rho > 0.8) return;
        const sc = latticeScore(planes[pi], xr0, y0, H, rho * H, null);
        if (sc > (move ? move.score : cur.score) + 1e-6) move = { pi, xr0, y0, H, rho, score: sc };
      };
      for (const d of [-2, -1, 1, 2]) {
        tryMove(cur.pi, cur.xr0 + d, cur.y0, cur.H, cur.rho);
        tryMove(cur.pi, cur.xr0, cur.y0 + d, cur.H, cur.rho);
        tryMove(cur.pi, cur.xr0, cur.y0, cur.H + d, cur.rho);
        tryMove(cur.pi, cur.xr0 + d, cur.y0 + d, cur.H, cur.rho);
        tryMove(cur.pi, cur.xr0, cur.y0 + d, cur.H + d, cur.rho);
        tryMove(cur.pi, cur.xr0, cur.y0, cur.H, cur.rho + 0.02 * d);
      }
      tryMove(cur.pi - 1, cur.xr0, cur.y0, cur.H, cur.rho);
      tryMove(cur.pi + 1, cur.xr0, cur.y0, cur.H, cur.rho);
      if (!move) break;
      cur = move;
    }
    if (cur.score > (best ? best.score : -Infinity)) best = Object.assign({}, cur, { P: cur.rho * cur.H });
  }
  return { best, picked };
}

// ---------- decoding ----------

function none(reason, debug) {
  return { status: 'none', value: null, digits: null, confidence: 0, debug: Object.assign({ reason }, debug) };
}

export function readDisplay(img, opts = {}) {
  const o = Object.assign({ workHeight: 72 }, opts);
  if (!img || img.width < 24 || img.height < 16) return none('crop too small');
  const pre = preprocess(img, o);
  if (pre.contrast < 0.25) return none('low contrast', { contrast: pre.contrast });
  const planes = buildPlanes(pre.thick, pre.w, pre.h, THETAS_DEG);
  const { best, picked } = findGeometry(planes, pre.h, o);
  const debug = { w: pre.w, h: pre.h, scale: pre.scale, contrast: pre.contrast, picked, geometry: best };
  if (!best) return none('no digit found', debug);
  const pl = planes[best.pi];
  const info = {};
  latticeScore(pl, best.xr0, best.y0, best.H, best.P, info);
  const fills = Array.from(tmpF);
  Object.assign(debug, { slantDeg: pl.deg, fills, U: info.U, zInk: info.zInk, bodyInk: info.bodyInk, plane: pl });
  // classify segments
  const masks = [0, 0, 0];
  let minMargin = 1;
  for (let i = 0; i < 3; i++) for (let s = 0; s < 7; s++) {
    const f = fills[i * 7 + s];
    if (f >= ON_T) { masks[i] |= 1 << s; minMargin = Math.min(minMargin, (f - ON_T) / (1 - ON_T)); }
    else if (f <= OFF_T) minMargin = Math.min(minMargin, (OFF_T - f) / OFF_T);
    else return none('ambiguous segment', Object.assign(debug, { masks, cell: i, seg: SEG_NAMES[s], f }));
  }
  debug.masks = masks;
  if (masks[0] === DASH_MASK && masks[1] === DASH_MASK && masks[2] === DASH_MASK) {
    return { status: 'dashes', value: null, digits: '---', confidence: minMargin, debug };
  }
  const ds = masks.map(m => (m === 0 ? ' ' : PATTERN_TO_DIGIT[m] ?? '?'));
  debug.digits = ds;
  if (ds.includes('?')) return none('invalid pattern', debug);
  const [d0, d1, d2] = ds;
  let str;
  if (d2 === ' ') { if (d1 === ' ' || d1 === '0') return none('too few digits', debug); str = d1 + d0; }
  else { if (!'12345'.includes(d2)) return none('bad hundreds digit', debug); str = d2 + d1 + d0; }
  if (d0 === ' ' || str.includes(' ')) return none('gap in digits', debug);
  const value = parseInt(str, 10);
  if (value < 14 || value > 572) return none('out of display range', debug);
  return { status: 'ok', value, digits: str, confidence: minMargin, debug };
}

export const _internals = { latticeScore, buildPlanes, findGeometry, tmpF, THETAS_DEG, singleCellScore, segAreas };
