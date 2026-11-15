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
  return { w, h, scale, ink, ratio, contrast, gray: g };
}

// ---------- slant ----------

// Shear a plane horizontally: row y moves right by (y - h/2) * t (+ pad). t > 0 straightens right-leaning italics.
export function shear(src, w, h, t) {
  const pad = Math.ceil(Math.abs(t) * h / 2) + 1;
  const dw = w + 2 * pad;
  const out = new Float32Array(dw * h);
  const cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    const s = (y - cy) * t - pad; // dst x' samples src x = x' + s ... (x' = x - s)
    for (let x = 0; x < dw; x++) {
      const sx = x + s; // source coordinate
      if (sx <= -1 || sx >= w) continue;
      const i0 = Math.floor(sx), f = sx - i0;
      const a = i0 >= 0 ? src[y * w + i0] : 0, b = i0 + 1 < w ? src[y * w + i0 + 1] : 0;
      out[y * dw + x] = a * (1 - f) + b * f;
    }
  }
  return { data: out, w: dw, h, pad };
}

export function slantScore(ink, w, h, t) {
  const s = shear(ink, w, h, t);
  const cols = new Float32Array(s.w);
  for (let y = 0; y < h; y++) for (let x = 0; x < s.w; x++) cols[x] += s.data[y * s.w + x];
  let sc = 0;
  for (let x = 0; x < s.w; x++) sc += cols[x] * cols[x];
  return sc;
}
