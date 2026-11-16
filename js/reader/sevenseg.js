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
  const n = w * h;
  const ratio = new Float32Array(n);
  for (let i = 0; i < n; i++) ratio[i] = g[i] / (bg[i] + 1);
  // Which pixels are ink at all: Otsu on the background-normalised ratio (only used to find the ink's own contrast level)
  const NB = 64, hist = new Float64Array(NB);
  for (let i = 0; i < n; i++) { const v = Math.min(1.3, Math.max(0, ratio[i])); hist[Math.min(NB - 1, Math.floor(v / 1.3 * NB))]++; }
  let sumAll = 0;
  for (let i = 0; i < NB; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, bestVar = -1, bestT = NB / 2;
  for (let t = 0; t < NB; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; bestT = t; }
  }
  const thr = (bestT + 1) / NB * 1.3;
  const d = new Float32Array(n); // darkness in grey levels: how far a pixel lies below its local background
  for (let i = 0; i < n; i++) d[i] = bg[i] - g[i];
  // The ink's own contrast, measured where it is strongest (the upper quartile of the ink pixels), and the background level there.
  const inkD = [], inkIdx = [];
  for (let i = 0; i < n; i++) if (ratio[i] < thr) { inkD.push(d[i]); inkIdx.push(i); }
  const inkFrac = inkD.length / n;
  let dRef = 0, bRef = 255, contrast = 0;
  if (inkD.length >= 8) {
    const sorted = Float32Array.from(inkD).sort();
    dRef = sorted[Math.floor(sorted.length * 0.75)];
    const top = []; for (let k = 0; k < inkD.length; k++) if (inkD[k] >= dRef) top.push(bg[inkIdx[k]]);
    top.sort((x, y) => x - y); bRef = top[Math.floor(top.length / 2)] || 255;
    contrast = dRef / (bRef + 1);
  }
  // Sensor/texture noise in grey levels: the residual of a 3x3 mean over background pixels away from any ink
  let rs = 0, rn = 0;
  for (let y = 1; y < h - 1; y += 1) for (let x = 1; x < w - 1; x += 1) {
    const i = y * w + x;
    if (ratio[i] < 0.9) continue;
    let m = 0, ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) { const j = i + dy * w + dx; if (ratio[j] < 0.9) { ok = false; break; } m += g[j]; }
    if (!ok) continue;
    const r = g[i] - m / 9; rs += r * r; rn++;
  }
  const sigma = Math.max(0.5, rn > 20 ? Math.sqrt(rs / rn * 9 / 8) : 2);
  // A glare veil adds light, so ink and background both rise towards white and the difference between them shrinks in proportion
  // to the headroom (255 - background). Expected ink contrast at each pixel follows from that, measured from the best-contrast ink.
  const WHITE = 255;
  const delta = new Float32Array(n), vis = new Float32Array(n), ink = new Float32Array(n);
  const headRef = Math.max(8, WHITE - bRef);
  for (let i = 0; i < n; i++) {
    let dl = dRef * Math.min(1, Math.max(0, (WHITE - Math.max(bRef, bg[i] - 0.2 * bRef)) / headRef)); // 20% brightness variation is lighting, not veil
    if (bRef > 245) dl = dRef * (bg[i] > 250 ? 0 : 1); // saturated reference: no veil model, only reject clipped pixels
    delta[i] = dl;
    const snr = dl / sigma;
    const v = (snr - 2.5) / 3.5; // not visible below 2.5 sigma, fully visible above 6
    vis[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    if (vis[i] > 0) {
      const half = Math.max(0.12 * dl, 1.5 * sigma);
      const t = (d[i] - (0.5 * dl - half)) / (2 * half);
      ink[i] = t < 0 ? 0 : t > 1 ? 1 : t;
    }
  }
  const thick = open2d(ink, w, h, Math.max(1, Math.round(h / 36)));
  removeBands(thick, w, h);
  return { w, h, scale, ink, thick, ratio, contrast, inkFrac, thr, gray: g, d, delta, vis, sigma, dRef, bRef };
}

// Erase thin tall bands that run the whole height of the crop (the bezel of the display window, the edge of the unit):
// they are far taller than any digit, so they can never be digits, and a box drawn a little wide would otherwise include them.
export function removeBands(thick, w, h) {
  const lab = new Int32Array(w * h), stack = [];
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (thick[i] < 0.3 || lab[i]) continue;
    n++;
    let x0 = w, x1 = 0, y0 = h, y1 = 0;
    stack.push(i); lab[i] = n;
    while (stack.length) {
      const j = stack.pop(), x = j % w, y = (j - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (!lab[k] && thick[k] >= 0.3) { lab[k] = n; stack.push(k); }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bh >= 0.9 * h && bw <= 0.3 * bh) { // remove this component (and its soft edge)
      for (let y = Math.max(0, y0 - 2); y <= Math.min(h - 1, y1 + 2); y++) for (let x = Math.max(0, x0 - 2); x <= Math.min(w - 1, x1 + 2); x++) {
        if (lab[y * w + x] === n || thick[y * w + x] < 0.3) thick[y * w + x] = 0;
      }
      stack.length = 0;
    }
  }
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

// ---------- lattice search ----------

const THETAS_DEG = [-2.5, 0, 2.5, 5, 7.5, 10, 12.5];
const LAMBDA = 3.0;   // weight of ink the lattice cannot explain, relative to ink it explains
const ON_T = 0.8, OFF_T = 0.12; // a segment is clearly on above ON_T, clearly off below OFF_T, otherwise the frame is doubtful
const FADE_T = 0.6;   // a lit segment must be at least this dark relative to the typical lit segment (frame, or previous frames)
const VIS_ON = 0.5, VIS_OFF = 0.9; // share of a segment's window that must show enough local contrast to be judged
// The two hollow centres of a digit (between the left and right strokes, above and below the middle bar) are always background, so
// they give the local background level right next to each segment, whatever a glare patch is doing to the picture there.
const HOLLOW_U = [-0.60, -0.34, 0.22, 0.38], HOLLOW_L = [-0.60, -0.34, 0.62, 0.78];
const SEG_HOLLOW = [[0], [0], [1], [1], [1], [0], [0, 1]]; // which hollow(s) border segment a..g (0 upper, 1 lower)
const ON_CONTRAST = 0.55, OFF_CONTRAST = 0.3; // lit: dark by at least this share of the contrast a lit segment should show here; unlit: at most
const NEIGHBOUR_T = 0.3; // ink this dark (relative to the lit segments) right of the ones cell means a digit was left out
const ON_LOOSE = 0.5; // registration only: a segment counts as lit above this

const tmpF = new Float64Array(21);

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
  let sc = 0, bodyInk = 0, inner = 0;
  for (let i = 0; i < 3; i++) {
    const xr = xr0 - i * P;
    let nOn = 0, explained = 0;
    for (let s = 0; s < 7; s++) {
      const g = SEG[s];
      const x0 = xr + g[0] * P, x1 = xr + g[1] * P, ya = y0 + g[2] * H, yb = y0 + g[3] * H;
      const f = rectSum(I, w, h, x0, ya, x1, yb) / rectArea(x0, ya, x1, yb);
      tmpF[i * 7 + s] = f;
      if (f >= ON_LOOSE) {
        nOn++;
        const t = TILE[s];
        // a segment explains its tile's ink in proportion to how convincingly it is lit
        const wgt = f >= 0.9 ? 1 : (f - 0.45) / 0.45;
        const ink = wgt * rectSum(I, w, h, xr + t[0] * P, y0 + t[2] * H, xr + t[1] * P, y0 + t[3] * H);
        explained += ink;
        sc += ink;
      }
    }
    if (i === 0 && !nOn) return -Infinity;
    const bi = rectSum(I, w, h, xr + (BODY_L - 0.03) * P, y0 - 0.03 * H, xr + 0.03 * P, y0 + 1.03 * H);
    bodyInk += bi;
    inner += Math.max(0, bi - explained);
  }
  const zInk = rectSum(I, w, h, xr2 + (BODY_L - 0.02) * P, y0 - 0.3 * H, xr0 + 1.06 * P, y0 + 1.3 * H);
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

// Hill-climb a starting geometry { pi, xr0, y0, H, rho } to a local optimum of the lattice score.
function refine(planes, start) {
  let cur = Object.assign({}, start);
  cur.score = latticeScore(planes[cur.pi], cur.xr0, cur.y0, cur.H, cur.rho * cur.H, null);
  for (let iter = 0; iter < 14; iter++) {
    let move = null;
    const tryMove = (pi, xr0, y0, H, rho) => {
      if (pi < 0 || pi >= planes.length || rho < 0.55 || rho > 0.92) return;
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
  cur.P = cur.rho * cur.H;
  return cur;
}

function findGeometry(planes, h, opts) {
  const cands = [];
  const stage1 = opts.stage1Planes || [1, 3, 5];
  const Hmin = Math.max(16, Math.round(h * (opts.hminFrac || 0.4))), Hmax = h + 1;
  const step = Math.max(2, Math.round(2 * h / 72));
  const ox0 = new Int32Array(7), ox1 = new Int32Array(7), oy0 = new Int32Array(7), oy1 = new Int32Array(7), area = new Float64Array(7), Aw = new Float64Array(7);
  for (const pi of stage1) {
    const pl = planes[pi], I = pl.I, W1 = pl.w + 1, w = pl.w, hh = pl.h;
    for (let H = Hmin; H <= Hmax; H += step) {
      const P = RHO * H;
      for (let s = 0; s < 7; s++) {
        const g = SEG[s];
        ox0[s] = Math.round(g[0] * P); ox1[s] = Math.max(ox0[s] + 1, Math.round(g[1] * P));
        oy0[s] = Math.round(g[2] * H); oy1[s] = Math.max(oy0[s] + 1, Math.round(g[3] * H));
        area[s] = (ox1[s] - ox0[s]) * (oy1[s] - oy0[s]);
        Aw[s] = area[s];
      }
      const xmin = Math.round(0.9 * P);
      for (let y0 = -1; y0 + H <= h + 1; y0 += step) {
        if (y0 + oy0[0] < 0) continue;
        for (let xr = xmin; xr <= w + 1; xr += step) {
          let nOn = 0, gain = 0, pen = 0;
          for (let s = 0; s < 7; s++) {
            const xa = xr + ox0[s], xb = xr + ox1[s], ya = y0 + oy0[s], yb = y0 + oy1[s];
            if (xa < 0 || xb > w || yb > hh) { nOn = 0; break; }
            const f = (I[yb * W1 + xb] - I[ya * W1 + xb] - I[yb * W1 + xa] + I[ya * W1 + xa]) / area[s];
            if (f >= 0.6) { nOn++; gain += f * Aw[s]; } else if (f > 0.15) pen += f * Aw[s];
          }
          if (!nOn || pen > 0.35 * gain) continue;
          const lsc = latticeScore(pl, xr, y0, H, P, null);
          if (lsc > -Infinity) cands.push({ sc: lsc, pi, xr, y0, H });
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
    const cur = refine(planes, { pi: c.pi, xr0: c.xr, y0: c.y0, H: c.H, rho: RHO });
    if (cur.score > (best ? best.score : -Infinity)) best = cur;
  }
  return { best, picked };
}

// Share of the pixels in a rectangle (plane coordinates) darker than thr
function darkShare(data, w, h, x0, y0, x1, y1, thr) {
  let a = Math.round(x0), b = Math.round(x1), c = Math.round(y0), d = Math.round(y1);
  if (b <= a) b = a + 1;
  if (d <= c) d = c + 1;
  if (a < 0) a = 0; if (c < 0) c = 0; if (b > w) b = w; if (d > h) d = h;
  let n = 0, tot = 0;
  for (let y = c; y < d; y++) for (let x = a; x < b; x++) { tot++; if (data[y * w + x] < thr) n++; }
  return tot ? n / tot : 0;
}

// ---------- decoding ----------

function none(reason, debug) {
  return { status: 'none', value: null, digits: null, confidence: 0, debug: Object.assign({ reason }, debug) };
}

// Strict classification of every segment at a fixed geometry. A segment is lit only if a core-sized patch (allowed to slide a
// little) is solidly inked, and unlit only if its whole (slightly dilated) window is clean; anything between is doubtful.
function classify(pl, g, ev) {
  const { I, w, h } = pl;
  const H = g.H, P = g.P;
  const dx = Math.max(1, Math.round(0.035 * H)), dy = Math.max(1, Math.round(0.025 * H));
  const cells = [];
  const mean = (itg, x0, y0, x1, y1) => rectSum(itg, ev.w, ev.h, x0, y0, x1, y1) / rectArea(x0, y0, x1, y1);
  for (let i = 0; i < 3; i++) {
    const xr = g.xr0 - i * P;
    const segs = [];
    const hol = [HOLLOW_U, HOLLOW_L].map(q => mean(ev.g, xr + q[0] * P, g.y0 + q[2] * H, xr + q[1] * P, g.y0 + q[3] * H));
    for (let s = 0; s < 7; s++) {
      const q = SEG[s];
      const bar = s === 0 || s === 3 || s === 6;
      const x0 = xr + q[0] * P, x1 = xr + q[1] * P, ya = g.y0 + q[2] * H, yb = g.y0 + q[3] * H;
      const area = rectArea(x0, ya, x1, yb);
      // Local background (from the hollows next to this segment) and the contrast a lit segment should show here
      const bseg = Math.max(...SEG_HOLLOW[s].map(k => hol[k]));
      const headRef = Math.max(8, 255 - ev.bRef);
      const dExp = ev.bRef > 245 ? ev.dRef : ev.dRef * Math.min(1, Math.max(0, (255 - Math.max(ev.bRef, bseg - 0.2 * ev.bRef)) / headRef));
      const thrPix = bseg - 0.5 * dExp; // a pixel darker than this is ink-like here
      const ex = bar ? 0 : dx, ey = bar ? dy : 0;
      // Share of the segment's core that is ink-like, with the core allowed to slide a little; and of its whole (dilated) window
      let fOn = 0, bsx = 0, bsy = 0, cOn = 0, cMax = -1e9;
      for (const k of [-1, 0, 1]) {
        const sx = bar ? 0 : k * dx, sy = bar ? k * dy : 0;
        const f = darkShare(ev.gd, ev.w, ev.h, x0 + sx, ya + sy, x1 + sx, yb + sy, thrPix);
        if (f > fOn) { fOn = f; bsx = sx; bsy = sy; }
        const c = bseg - mean(ev.g, x0 + sx, ya + sy, x1 + sx, yb + sy);
        if (k === 0) cOn = c;
        if (c > cMax) cMax = c;
      }
      const fOff = darkShare(ev.gd, ev.w, ev.h, x0 - ex, ya - ey, x1 + ex, yb + ey, thrPix);
      // The global ink map's opinion (kept for the overlay and the registration)
      const fMap = rectSum(I, w, h, x0, ya, x1, yb) / area;
      const visWin = 1, visCore = 1;
      const seen = dExp >= ev.minDelta; // the contrast a lit segment would show here clears the noise
      const litByGrey = seen && cMax >= ON_CONTRAST * dExp, unlitByGrey = seen && cOn <= OFF_CONTRAST * dExp;
      let state = '?';
      if (fOn >= ON_T && litByGrey) state = 'on';
      else if (fOff <= OFF_T && unlitByGrey) state = 'off';
      const hidden = state === '?' && !seen;
      let dn = 0;
      if (state === 'on') { // darkness relative to the contrast this spot should show if lit
        dn = dExp > 0 ? Math.min(1.5, cMax / dExp) : 0;
      }
      segs.push({ name: SEG_NAMES[s], x0, y0: ya, x1, y1: yb, fOn, fOff, fMap, visWin, visCore, state, hidden, dark: dn, cRel: dExp > 0 ? cMax / dExp : 0 });
    }
    cells.push({ index: i, x0: xr + BODY_L * P, x1: xr, y0: g.y0, y1: g.y0 + H, segs });
  }
  return cells;
}

// Two attempts: the normal one (digits fill most of the crop), then a finer one for loosely drawn boxes (digits less than
// half the crop height), which are too small at the normal working size.
const ATTEMPTS = [{ workHeight: 72, hminFrac: 0.4 }, { workHeight: 128, hminFrac: 0.26 }];

export function readDisplay(img, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  if (!img || img.width < 24 || img.height < 16) return none('crop too small');
  const attempts = opts.workHeight ? [{ workHeight: opts.workHeight, hminFrac: opts.hminFrac || 0.4 }] : ATTEMPTS;
  let res = null;
  for (let i = 0; i < attempts.length; i++) {
    if (i > 0 && attempts[i].workHeight > img.height * 1.3) break; // no point upscaling a small crop much
    const r = readAt(img, Object.assign({}, opts, attempts[i]));
    r.debug.attempt = i;
    if (!res || r.status !== 'none') res = r;
    if (r.status !== 'none') break;
    if (r.debug.reason === 'low contrast') break;
  }
  res.debug.ms = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
  return res;
}

function readAt(img, o) {
  const pre = preprocess(img, o);
  const base = { w: pre.w, h: pre.h, scale: pre.scale, contrast: pre.contrast, inkFrac: pre.inkFrac };
  if (pre.contrast < 0.2 || pre.inkFrac < 0.005) return none('low contrast', base);
  const planes = buildPlanes(pre.thick, pre.w, pre.h, THETAS_DEG);

  let best = null, usedHint = false, picked = [];
  let res = null;
  const hint = o.hint;
  if (hint && hint.w === pre.w && hint.h === pre.h && hint.geometry && planes[hint.geometry.pi]) {
    best = refine(planes, hint.geometry);
    res = decodeAt(planes, best, base, pre, hint.ink);
    usedHint = true;
  }
  if (!res || res.status === 'none') {
    const f = findGeometry(planes, pre.h, o);
    picked = f.picked;
    if (f.best) { best = f.best; res = decodeAt(planes, best, base, pre, hint && hint.ink); }
    else res = none('no digit found', base);
    usedHint = false;
  }
  res.debug.usedHint = usedHint;
  res.debug.picked = picked;
  res.debug.hintOut = best && res.status !== 'none' ? { w: pre.w, h: pre.h, geometry: { pi: best.pi, xr0: best.xr0, y0: best.y0, H: best.H, rho: best.rho }, ink: res.debug.inkLevel } : null;
  return res;
}

function decodeAt(planes, best, base, pre, ref) {
  const pl = planes[best.pi];
  const info = {};
  latticeScore(pl, best.xr0, best.y0, best.H, best.P, info);
  // The evidence planes (visibility, darkness, expected ink contrast) in the same straightened frame as the ink map.
  const mk = arr => { const sh = shear(arr, pre.w, pre.h, pl.t); return { I: integral(sh.data, sh.w, sh.h), w: sh.w, h: sh.h }; };
  const gsh = shear(pre.gray, pre.w, pre.h, pl.t);
  const ev = { gd: gsh.data, vis: mk(pre.vis).I, d: mk(pre.d).I, delta: mk(pre.delta).I, g: mk(pre.gray).I, w: pl.w, h: pl.h, dRef: pre.dRef, bRef: pre.bRef, minDelta: 3.5 * pre.sigma };
  const cells = classify(pl, best, ev);
  const debug = Object.assign({}, base, {
    geometry: best, slantDeg: pl.deg, U: info.U, zInk: info.zInk, bodyInk: info.bodyInk,
    overlay: { w: pl.w, h: pl.h, slantDeg: pl.deg, cells, ink: inkBytes(pl.data) },
  });
  const masks = [0, 0, 0];
  let minMargin = 1, doubt = null, hiddenSeg = null;
  cells.forEach((c, i) => c.segs.forEach((sg, s) => {
    if (sg.state === 'on') { masks[i] |= 1 << s; minMargin = Math.min(minMargin, (sg.fOn - ON_T) / (1 - ON_T)); }
    else if (sg.state === 'off') minMargin = Math.min(minMargin, (OFF_T - sg.fOff) / OFF_T);
    else {
      if (sg.hidden) hiddenSeg = hiddenSeg || { cell: i, seg: sg.name, visWin: sg.visWin };
      if (!doubt) doubt = { cell: i, seg: sg.name, fOn: sg.fOn, fOff: sg.fOff };
    }
  }));
  debug.masks = masks;
  debug.fills = cells.flatMap(c => c.segs.map(sg => sg.fOn));
  if (hiddenSeg) return none('segment washed out by glare', Object.assign(debug, hiddenSeg));
  if (doubt) return none('ambiguous segment', Object.assign(debug, doubt));
  const lit = cells.flatMap(c => c.segs.filter(sg => sg.state === 'on').map(sg => sg.dark)).sort((a, b) => a - b);
  const level = lit.length ? lit[Math.floor(lit.length / 2)] : 0;
  debug.inkLevel = level;
  if (lit.length && lit[0] < FADE_T * level) {
    return none('segments mid-fade', Object.assign(debug, { minDark: lit[0] }));
  }
  // A 7 whose top bar runs off the right edge of the crop looks like a 1. If the ones digit reads as 1 and thick ink runs from inside
  // that digit to the last column of the crop, the digit may continue beyond the crop, so the frame is doubtful. Ink at the edge
  // that starts beyond the digit (the bezel, other labels) is not a cut digit.
  if (masks[0] === 0b0000110) { // only a lone 1 can hide a cut: a 7 with its bar clipped away reads as 1
    const T = pre.thick, W = pre.w, cy = (pre.h - 1) / 2;
    const ya = Math.max(0, Math.round(best.y0 + 0.05 * best.H)), yb = Math.min(pre.h, Math.round(best.y0 + 0.95 * best.H));
    let n = 0;
    for (let y = ya; y < yb; y++) {
      if (!(T[y * W + W - 1] > 0.5 || T[y * W + W - 2] > 0.5)) continue;
      let x = W - 1; while (x > 0 && T[y * W + x] > 0.3) x--;
      const bodyRight = best.xr0 + 0.03 * best.P - pl.pad - (y - cy) * pl.t; // ones-digit body edge in crop coordinates
      if (x + 1 <= bodyRight - 1) n++;
    }
    debug.edgeInk = n / best.H;
    if (n > 0.1 * best.H) return none('digit cut off at the right edge of the crop', debug);
  }
  // The lattice must not have dropped the last digit: one cell to the right of the ones cell there must be no ink at the
  // positions of the right-hand segments (every digit lights b or c). A narrow 1 or a faint, half-faded digit is easy to miss
  // otherwise. Skipped when that cell lies outside the crop.
  {
    const P = best.P, xr = best.xr0 + P, rhs = [1, 2];
    if (xr <= pl.w) {
      const dx = Math.max(1, Math.round(0.035 * best.H));
      let nd = 0, vmin = 1;
      for (const sI of rhs) {
        const q = SEG[sI];
        for (const k of [-1, 0, 1]) {
          const x0 = xr + q[0] * P + k * dx, x1 = xr + q[1] * P + k * dx, ya = best.y0 + q[2] * best.H, yb = best.y0 + q[3] * best.H;
          if (x1 > pl.w) continue;
          const ar = rectArea(x0, ya, x1, yb);
          const de = rectSum(ev.delta, ev.w, ev.h, x0, ya, x1, yb);
          nd = Math.max(nd, de > 0 ? rectSum(ev.d, ev.w, ev.h, x0, ya, x1, yb) / de : 0);
          vmin = Math.min(vmin, rectSum(ev.vis, ev.w, ev.h, x0, ya, x1, yb) / ar);
        }
      }
      debug.neighbourDark = nd;
      if (vmin < VIS_OFF) return none('segment washed out by glare', Object.assign(debug, { cell: -1, seg: 'b/c right of the ones digit', visWin: vmin }));
      if (nd >= NEIGHBOUR_T) return none('ink right of the ones digit', debug);
    }
  }
  if (masks[0] === DASH_MASK && masks[1] === DASH_MASK && masks[2] === DASH_MASK) {
    return { status: 'dashes', value: null, digits: '---', confidence: minMargin, debug };
  }
  // three bars on one row and nothing else cannot be a number (and the dash row may sit at the a, g or d position when the
  // digit height is not pinned by other ink)
  const sameBar = [1, 8, 64].some(m => masks[0] === m && masks[1] === m && masks[2] === m);
  if (sameBar) return { status: 'dashes', value: null, digits: '---', confidence: minMargin, debug };
  const ds = masks.map(m => (m === 0 ? ' ' : PATTERN_TO_DIGIT[m] ?? '?'));
  debug.digits = ds;
  if (ds.includes('?')) return none('invalid pattern', debug);
  const [d0, d1, d2] = ds;
  let str;
  if (d0 === ' ') return none('ones digit blank', debug);
  if (d2 === ' ') { if (d1 === ' ' || d1 === '0') return none('too few digits', debug); str = d1 + d0; }
  else { if (!'12345'.includes(d2)) return none('bad hundreds digit', debug); if (d1 === ' ') return none('gap in digits', debug); str = d2 + d1 + d0; }
  const value = parseInt(str, 10);
  if (value < 14 || value > 572) return none('out of display range', debug);
  return { status: 'ok', value, digits: str, confidence: minMargin, debug };
}

function inkBytes(data) {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * 255;
  return out;
}

export const _internals = { latticeScore, buildPlanes, findGeometry, refine, tmpF, THETAS_DEG, classify };
