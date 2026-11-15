// Synthetic ThermoPro TP17 display renderer for tests. Runs in a browser (needs canvas).
//
//   renderDisplay(params) -> ImageData   one crop of the display as the reader receives it
//   randomParams(rng, text, level, opts) -> params for a value / '---' at a distortion level
//   mulberry32(seed) -> rng()
//
// It is built to resemble tp17-077-set425.jpg (gray-green LCD, dark segments with bevelled ends, italic
// slant, a faint ghost image offset down-right, brushed-metal grain) but every dimension is drawn from a range, so
// the reader cannot be tuned to one exact font. Where this renderer and the real photo disagree, the photo wins.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = rng => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
const rr = (rng, a, b) => a + (b - a) * rng();

const PAT = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '' };
const SEGS = 'abcdefg';

// text: up to three characters, right-aligned ("77", "425", "---"). Returns [ones, tens, hundreds] characters.
export function cellsOf(text) {
  const c = text.split('').reverse();
  while (c.length < 3) c.push(' ');
  return c;
}

// Per-segment ink alpha for a cell, with an optional fade from another character.
function segAlphas(ch, fromCh, p, rng, jitter) {
  const out = {};
  for (const s of SEGS) {
    const now = PAT[ch].includes(s) ? 1 : 0;
    if (fromCh === undefined) { out[s] = now; continue; }
    const was = PAT[fromCh].includes(s) ? 1 : 0;
    let a = was + (now - was) * p;
    if (was !== now) a = Math.min(1, Math.max(0, a + (rng ? gauss(rng) * jitter : 0)));
    out[s] = a;
  }
  return out;
}

function poly(ctx, pts, fn) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => { const q = fn(x, y); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
  ctx.closePath();
  ctx.fill();
}

// Draw one digit cell. (xr, y0): right edge and top of the cell body; H digit height.
function drawCell(ctx, alphas, xr, y0, H, g, ink, ghost) {
  const Wd = g.bodyW * H, Tv = g.tv * H, Th = g.th * H, gap = g.gap * H, bv = g.bevel;
  const xl = xr - Wd;
  const tan = Math.tan(g.slant * Math.PI / 180);
  const fn = (x, y) => [x + (0.5 * H - (y - y0)) * tan + (ghost ? g.ghostDx * H : 0), y + (ghost ? g.ghostDy * H : 0)];
  const ym = y0 + g.midY * H; // centre of the middle bar
  const bar = (x0, x1, yc, th, alpha, wide) => {
    if (alpha <= 0.002) return;
    ctx.fillStyle = `rgba(${ink},${ink + 4},${ink},${alpha * (ghost ? g.ghostAlpha : g.inkAlpha)})`;
    const e = th * bv * (wide ? 1.4 : 1);
    poly(ctx, [[x0, yc], [x0 + e, yc - th / 2], [x1 - e, yc - th / 2], [x1, yc], [x1 - e, yc + th / 2], [x0 + e, yc + th / 2]], fn);
  };
  const vert = (xc, y1, y2, alpha) => {
    if (alpha <= 0.002) return;
    ctx.fillStyle = `rgba(${ink},${ink + 4},${ink},${alpha * (ghost ? g.ghostAlpha : g.inkAlpha)})`;
    const e = Tv * bv;
    poly(ctx, [[xc - Tv / 2, y1 + e], [xc, y1], [xc + Tv / 2, y1 + e], [xc + Tv / 2, y2 - e], [xc, y2], [xc - Tv / 2, y2 - e]], fn);
  };
  const xA0 = xl + Tv * 0.35, xA1 = xr - Tv * 0.35;
  bar(xA0, xA1, y0 + Th / 2, Th, alphas.a);
  bar(xA0, xA1, ym, Th, alphas.g, g.dash);
  bar(xA0, xA1, y0 + H - Th / 2, Th, alphas.d);
  const upTop = y0 + Th / 2 + gap, upBot = ym - Th / 2 - gap, loTop = ym + Th / 2 + gap, loBot = y0 + H - Th / 2 - gap;
  vert(xl + Tv / 2, upTop - Th * 0.3, upBot + Th * 0.3, alphas.f);
  vert(xr - Tv / 2, upTop - Th * 0.3, upBot + Th * 0.3, alphas.b);
  vert(xl + Tv / 2, loTop - Th * 0.3, loBot + Th * 0.3, alphas.e);
  vert(xr - Tv / 2, loTop - Th * 0.3, loBot + Th * 0.3, alphas.c);
}

/**
 * params:
 *  w, h            crop size in px
 *  text            '77' | '425' | '---' (what is shown); fade: { from: '76', p: 0.5, jitter: 0.1 } optional
 *  H, xr, y0       digit height, right edge of the ones cell, top of digits (px)
 *  pitch           cell pitch / H
 *  geometry        { bodyW, tv, th, gap, bevel, slant, midY, ghostDx, ghostDy, ghostAlpha, inkAlpha, dash }
 *  rotation        degrees (whole image), perspective (keystone, fraction), blur (px), noise (sigma, 0-255), grain
 *  gradient        { amp, angle }, glare { x, y, r, amp }
 *  bg              base gray-green level; ink level
 *  extras          { degF, label, rule, neighbour, bezel } booleans
 *  seed            rng seed for noise
 */
export function renderDisplay(p) {
  const rng = mulberry32(p.seed ?? 1);
  const w = p.w, h = p.h;
  const scene = document.createElement('canvas');
  scene.width = w; scene.height = h;
  const ctx = scene.getContext('2d', { willReadFrequently: true });
  const [bgR, bgG, bgB] = p.bg || [150, 162, 152];
  ctx.fillStyle = `rgb(${bgR},${bgG},${bgB})`;
  ctx.fillRect(0, 0, w, h);
  const g = p.geometry;
  const ink = p.ink ?? 14;
  const cells = cellsOf(p.text);
  const fromCells = p.fade ? cellsOf(p.fade.from) : null;
  const P = p.pitch * p.H;
  const alphas = cells.map((ch, i) => segAlphas(ch, fromCells ? fromCells[i] : undefined, p.fade?.p ?? 0, rng, p.fade?.jitter ?? 0));
  if (p.text === '---') alphas.forEach(a => { a.g = 1; });
  const gDash = Object.assign({}, g, { dash: p.text === '---' });

  const ex = p.extras || {};
  ctx.save();
  // optional clutter drawn behind/around the digits
  if (ex.rule) {
    ctx.fillStyle = 'rgba(15,18,15,0.9)';
    ctx.fillRect(0, p.y0 + p.H * (1.08 + (ex.ruleOff || 0)), w, Math.max(2, p.H * 0.035));
  }
  if (ex.label) {
    ctx.fillStyle = 'rgba(20,24,20,0.85)';
    ctx.font = `bold ${Math.round(p.H * 0.2)}px sans-serif`;
    ctx.fillText('THERMO TEMP', p.xr - 2.3 * P, p.y0 - p.H * 0.06);
  }
  if (ex.bezel) {
    ctx.fillStyle = 'rgba(95,40,40,0.95)';
    ctx.fillRect(0, 0, Math.max(3, p.H * 0.08), h);
  }
  for (let i = 0; i < 3; i++) {
    const xr = p.xr - i * P;
    drawCell(ctx, alphas[i], xr, p.y0, p.H, gDash, ink, true);
  }
  for (let i = 0; i < 3; i++) {
    const xr = p.xr - i * P;
    drawCell(ctx, alphas[i], xr, p.y0, p.H, gDash, ink, false);
  }
  if (ex.neighbour) { // a full-size digit in the fourth cell (what the SET TEMP number would look like)
    drawCell(ctx, segAlphas(ex.neighbour, undefined, 0), p.xr - 3 * P - P * (ex.neighbourGap ?? 0.35), p.y0, p.H, g, ink, false);
  }
  if (ex.degF) {
    const x = p.xr + p.H * (ex.degFGap ?? 0.07), y = p.y0 + p.H * 0.62;
    ctx.fillStyle = 'rgba(15,18,15,0.9)';
    ctx.beginPath(); ctx.arc(x + p.H * 0.04, y - p.H * 0.1, p.H * 0.035, 0, 7); ctx.lineWidth = Math.max(1, p.H * 0.015); ctx.strokeStyle = ctx.fillStyle; ctx.stroke();
    ctx.fillRect(x + p.H * 0.04, y, Math.max(2, p.H * 0.04), p.H * 0.28);
    ctx.fillRect(x + p.H * 0.04, y, p.H * 0.13, Math.max(2, p.H * 0.03));
    ctx.fillRect(x + p.H * 0.04, y + p.H * 0.12, p.H * 0.1, Math.max(2, p.H * 0.03));
  }
  ctx.restore();

  // global geometry: rotation about the centre, then blur
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.fillStyle = `rgb(${bgR},${bgG},${bgB})`;
  octx.fillRect(0, 0, w, h);
  octx.save();
  octx.translate(w / 2, h / 2);
  octx.rotate((p.rotation || 0) * Math.PI / 180);
  octx.translate(-w / 2, -h / 2);
  if (p.blur > 0.05) octx.filter = `blur(${p.blur}px)`;
  octx.drawImage(scene, 0, 0);
  octx.restore();

  // pixel pass: keystone perspective, lighting gradient, glare, grain and sensor noise
  const src = octx.getImageData(0, 0, w, h);
  const dst = octx.createImageData(w, h);
  const sd = src.data, dd = dst.data;
  const k = p.perspective || 0, gr = p.gradient || { amp: 0, angle: 0 }, gl = p.glare;
  const ca = Math.cos(gr.angle || 0), sa = Math.sin(gr.angle || 0);
  // brushed grain: row-correlated noise
  const grainRows = new Float32Array(h);
  for (let y = 0; y < h; y++) grainRows[y] = gauss(rng);
  for (let y = 0; y < h; y++) {
    const s = 1 + k * (y / h - 0.5) * 2; // horizontal scale about the centre
    for (let x = 0; x < w; x++) {
      let sx = w / 2 + (x - w / 2) / s;
      let r, g2, b;
      if (sx < 0 || sx > w - 1) { r = bgR; g2 = bgG; b = bgB; } else {
        const i0 = Math.floor(sx), f = sx - i0, a = (y * w + i0) * 4, b2 = (y * w + Math.min(w - 1, i0 + 1)) * 4;
        r = sd[a] * (1 - f) + sd[b2] * f; g2 = sd[a + 1] * (1 - f) + sd[b2 + 1] * f; b = sd[a + 2] * (1 - f) + sd[b2 + 2] * f;
      }
      let m = 1 + (gr.amp || 0) * (((x / w - 0.5) * ca + (y / h - 0.5) * sa));
      r *= m; g2 *= m; b *= m;
      if (gl) {
        const d2 = ((x - gl.x) ** 2 + (y - gl.y) ** 2) / (gl.r * gl.r);
        const a = gl.amp * Math.exp(-d2);
        r += (255 - r) * a; g2 += (255 - g2) * a; b += (255 - b) * a;
      }
      const n = gauss(rng) * (p.noise || 0) + grainRows[y] * (p.grain || 0);
      const o = (y * w + x) * 4;
      dd[o] = Math.max(0, Math.min(255, r + n));
      dd[o + 1] = Math.max(0, Math.min(255, g2 + n));
      dd[o + 2] = Math.max(0, Math.min(255, b + n));
      dd[o + 3] = 255;
    }
  }
  return dst;
}

// ---------- parameter generation ----------

// Distortion levels. Ranges are [min, max] of what is drawn at random for each frame.
export const LEVELS = {
  clean:    { blur: [0, 0.3], noise: [0, 2], grain: [0, 1], grad: [0, 0.05], glare: 0, rot: [-0.5, 0.5], persp: [0, 0.01], inkAlpha: [0.88, 0.95], contrast: [0.9, 1] },
  mild:     { blur: [0.3, 1.0], noise: [2, 6], grain: [1, 3], grad: [0.05, 0.2], glare: 0, rot: [-2, 2], persp: [0, 0.03], inkAlpha: [0.8, 0.92], contrast: [0.8, 0.95] },
  moderate: { blur: [0.8, 1.7], noise: [5, 11], grain: [2, 5], grad: [0.15, 0.35], glare: 0.3, rot: [-4, 4], persp: [0.02, 0.06], inkAlpha: [0.65, 0.88], contrast: [0.6, 0.85] },
  severe:   { blur: [1.5, 2.6], noise: [9, 18], grain: [4, 8], grad: [0.3, 0.55], glare: 0.7, rot: [-7, 7], persp: [0.05, 0.12], inkAlpha: [0.45, 0.8], contrast: [0.4, 0.7] },
};

/**
 * opts: { digitH (px, default random 90-190), margin (fraction of H, default random .05-.2), jitter (fraction, box jitter),
 *         extras (override), fade, seed }
 */
export function randomParams(rng, text, level = 'mild', opts = {}) {
  const L = LEVELS[level];
  const H = opts.digitH ?? Math.round(rr(rng, 90, 190));
  const margin = opts.margin ?? rr(rng, 0.05, 0.2);
  const jit = opts.jitter ?? 0.05;
  const m = margin * H;
  const geometry = {
    bodyW: rr(rng, 0.6, 0.68), tv: rr(rng, 0.14, 0.2), th: rr(rng, 0.12, 0.16), gap: rr(rng, 0.012, 0.03), bevel: rr(rng, 0.25, 0.5),
    slant: rr(rng, 3.5, 9), midY: rr(rng, 0.47, 0.5), ghostDx: rr(rng, 0.015, 0.03), ghostDy: rr(rng, 0.02, 0.035), ghostAlpha: rr(rng, 0.1, 0.22),
    inkAlpha: 1, dash: false,
  };
  const contrast = rr(rng, ...L.contrast);
  geometry.inkAlpha = rr(rng, ...L.inkAlpha) * Math.min(1, contrast / 0.9);
  const pitch = rr(rng, 0.68, 0.74);
  const bodyW = geometry.bodyW * H;
  // The reader's crop: user box (digits of a 2-digit display plus margin) widened left by 0.7 of the box height.
  const boxH = H + 2 * m;
  const ext = 0.7 * boxH;
  const jx = () => (rng() - 0.5) * 2 * jit * boxH, jy = () => (rng() - 0.5) * 2 * jit * boxH;
  const boxW = pitch * H + bodyW + 2 * m;
  const w = Math.round(boxW + ext + jx() * 0.5);
  const h = Math.round(boxH + jy() * 0.5);
  const xr = w - m - jx() * 0.5 - H * 0.02; // ones cell right edge
  const y0 = m + jy();
  const ex = opts.extras ?? {
    degF: rng() < 0.35, degFGap: rr(rng, 0.05, 0.12), label: rng() < 0.35, rule: rng() < 0.3, ruleOff: rr(rng, 0, 0.1), bezel: false,
  };
  const grAng = rng() * 6.28;
  const p = {
    w, h, text, H, xr, y0, pitch, geometry,
    rotation: rr(rng, ...L.rot), perspective: rr(rng, ...L.persp) * (rng() < 0.5 ? -1 : 1), blur: rr(rng, ...L.blur) * Math.max(0.6, H / 140),
    noise: rr(rng, ...L.noise), grain: rr(rng, ...L.grain),
    gradient: { amp: rr(rng, ...L.grad), angle: grAng },
    glare: L.glare && rng() < 0.6 ? { x: rng() * w, y: rng() * h, r: rr(rng, 0.2, 0.5) * w, amp: rr(rng, 0.1, 1) * L.glare } : null,
    bg: [rr(rng, 120, 170), rr(rng, 130, 180), rr(rng, 120, 170)],
    ink: Math.round(rr(rng, 8, 40) + (1 - contrast) * 80),
    extras: ex, fade: opts.fade, seed: Math.floor(rng() * 1e9),
  };
  return p;
}
