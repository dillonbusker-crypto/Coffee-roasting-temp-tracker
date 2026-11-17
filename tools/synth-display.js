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

// How the real LCD changes a segment, measured on the user's 15 fps cooldown video (400x170 crops, relative contrast of one
// segment against a fully lit one, picture by picture): a segment switching on goes 0.13, 0.59, 0.73, 0.9, 1.0 in 33 ms steps; one
// switching off goes 0.34, 0.15, 0.07, then leaves a faint ghost for up to ~200 ms. The two curves cross near 0.3, about 17 ms
// after the change starts, which is why a picture taken in the middle of a change shows the superset of the old and new segments
// (both the one going out and the one coming in look half lit). Times are ms since the change began.
const ON_CURVE = [[0, 0], [17, 0.3], [33, 0.52], [50, 0.62], [83, 0.74], [117, 0.9], [160, 1]];
const OFF_CURVE = [[0, 1], [17, 0.3], [50, 0.15], [83, 0.08], [120, 0.07], [200, 0.04], [270, 0]];
function curveAt(curve, t) {
  if (t <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i][0]) { const [t0, a0] = curve[i - 1], [t1, a1] = curve[i]; return a0 + (a1 - a0) * (t - t0) / (t1 - t0); }
  }
  return curve[curve.length - 1][1];
}
/** Ink alpha (0..1) of a segment `tMs` after it started switching on (rising) or off. */
export function changeAlpha(rising, tMs) { return curveAt(rising ? ON_CURVE : OFF_CURVE, tMs); }

// Per-segment ink alpha for a cell, with an optional change from another character: fade = { from, p (linear mix, 0..1) | tMs (the
// LCD's own dynamics, see above), jitter }.
function segAlphas(ch, fromCh, fade, rng) {
  const out = {};
  for (const s of SEGS) {
    const now = PAT[ch].includes(s) ? 1 : 0;
    if (fromCh === undefined) { out[s] = now; continue; }
    const was = PAT[fromCh].includes(s) ? 1 : 0;
    if (was === now) { out[s] = now; continue; }
    let a;
    if (fade.tMs !== undefined) a = changeAlpha(now === 1, Math.max(0, fade.tMs + (rng ? gauss(rng) * (fade.jitterMs ?? 3) : 0)));
    else a = Math.min(1, Math.max(0, was + (now - was) * (fade.p ?? 0) + (rng ? gauss(rng) * (fade.jitter ?? 0) : 0)));
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
 *  text            '77' | '425' | '---' (what is shown); fade: { from: '76', p: 0.5, jitter: 0.1 } or { from: '76', tMs: 40 } optional
 *                  (p mixes old and new linearly; tMs follows the LCD's measured dynamics, ms since the change began)
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
  const alphas = cells.map((ch, i) => segAlphas(ch, fromCells ? fromCells[i] : undefined, p.fade || {}, rng));
  if (p.dim) for (const d of p.dim) for (const ch of d.segs) if (alphas[d.cell] && alphas[d.cell][ch] > 0) alphas[d.cell][ch] *= d.factor; // a reflection that lightens the ink of some segments
  if (p.offAlpha) alphas.forEach((a, ci) => { for (const k of SEGS) if (a[k] < p.offAlpha) a[k] = Math.max(a[k], p.offAlpha); }); // unlit segments faintly visible (see CONDITIONS.still)
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

  // pixel pass 1: keystone perspective and aspect (geometry only)
  const src = octx.getImageData(0, 0, w, h);
  const dst = octx.createImageData(w, h);
  const sd = src.data, dd = dst.data;
  const k = p.perspective || 0;
  for (let y = 0; y < h; y++) {
    const s = (p.aspect || 1) * (1 + k * (y / h - 0.5) * 2); // horizontal scale about the centre
    for (let x = 0; x < w; x++) {
      const sx = w / 2 + (x - w / 2) / s;
      const o = (y * w + x) * 4;
      if (sx < 0 || sx > w - 1) { dd[o] = bgR; dd[o + 1] = bgG; dd[o + 2] = bgB; } else {
        const i0 = Math.floor(sx), f = sx - i0, a = (y * w + i0) * 4, b2 = (y * w + Math.min(w - 1, i0 + 1)) * 4;
        dd[o] = sd[a] * (1 - f) + sd[b2] * f; dd[o + 1] = sd[a + 1] * (1 - f) + sd[b2 + 1] * f; dd[o + 2] = sd[a + 2] * (1 - f) + sd[b2 + 2] * f;
      }
      dd[o + 3] = 255;
    }
  }
  // pixel pass 2: lighting, glare, sensor noise, exposure
  applyPhotometric(dst, p, rng);
  return dst;
}

/**
 * The photometric part of what a phone camera does to a picture of the display, applied in place to any ImageData (so the same
 * distortions can be put on the real photo crops):
 *   gradient {amp, angle}          brightness ramp across the crop
 *   vignette                       radial darkening towards the corners (0..1)
 *   glare | glares [{x, y, rx, ry, angle, amp, pw}]   specular veil: out = in + (255 - in) * a, a = amp * exp(-d^(2*pw)); amp 1 is
 *                                  pure white, 0.5 leaves half of the contrast; pw > 1 gives a flatter top and a firmer edge
 *   noise, grain                   sensor noise (per pixel) and row-correlated grain (brushed metal)
 *   exposure {gain, gamma, cast}   auto-exposure and white-balance state of this frame, applied after the sensor with clipping
 *   blockNoise                     8x8 block offsets (video compression)
 * x, y, rx, ry are in pixels of the crop.
 */
export function applyPhotometric(img, p, rng) {
  const w = img.width, h = img.height, d = img.data;
  const gr = p.gradient || { amp: 0, angle: 0 };
  const ca = Math.cos(gr.angle || 0), sa = Math.sin(gr.angle || 0);
  const glares = (p.glares || (p.glare ? [Object.assign({ pw: 1 }, p.glare.rx ? p.glare : { rx: p.glare.r, ry: p.glare.r, angle: 0 })] : [])).map(g => ({
    x: g.x, y: g.y, ix: Math.cos(g.angle || 0) / g.rx, iy: Math.sin(g.angle || 0) / g.rx, jx: -Math.sin(g.angle || 0) / g.ry, jy: Math.cos(g.angle || 0) / g.ry, amp: g.amp, pw: g.pw || 1,
  }));
  const ex = p.exposure, vig = p.vignette || 0;
  const grainRows = new Float32Array(h);
  for (let y = 0; y < h; y++) grainRows[y] = gauss(rng);
  const cx = w / 2, cy = h / 2, rmax2 = cx * cx + cy * cy;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r = d[o], g2 = d[o + 1], b = d[o + 2];
      let m = 1 + (gr.amp || 0) * ((x / w - 0.5) * ca + (y / h - 0.5) * sa);
      if (vig) m *= 1 - vig * (((x - cx) ** 2 + (y - cy) ** 2) / rmax2);
      r *= m; g2 *= m; b *= m;
      let keep = 1;
      for (const gl of glares) {
        const dx = x - gl.x, dy = y - gl.y, u = dx * gl.ix + dy * gl.iy, v = dx * gl.jx + dy * gl.jy;
        keep *= 1 - gl.amp * Math.exp(-Math.pow(u * u + v * v, gl.pw));
      }
      if (keep < 1) { const a = 1 - keep; r += (255 - r) * a; g2 += (255 - g2) * a; b += (255 - b) * a; }
      const n = gauss(rng) * (p.noise || 0) + grainRows[y] * (p.grain || 0);
      r += n; g2 += n; b += n;
      if (ex) {
        const c = ex.cast || [1, 1, 1];
        r = 255 * Math.pow(Math.max(0, Math.min(1, r * ex.gain * c[0] / 255)), ex.gamma);
        g2 = 255 * Math.pow(Math.max(0, Math.min(1, g2 * ex.gain * c[1] / 255)), ex.gamma);
        b = 255 * Math.pow(Math.max(0, Math.min(1, b * ex.gain * c[2] / 255)), ex.gamma);
      }
      d[o] = r < 0 ? 0 : r > 255 ? 255 : r; d[o + 1] = g2 < 0 ? 0 : g2 > 255 ? 255 : g2; d[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b; d[o + 3] = 255;
    }
  }
  if (p.blockNoise) { // 8x8 block offsets and a little ringing, as from a hardware video encoder
    for (let by = 0; by < h; by += 8) for (let bx = 0; bx < w; bx += 8) {
      const off = gauss(rng) * p.blockNoise;
      for (let y = by; y < Math.min(h, by + 8); y++) for (let x = bx; x < Math.min(w, bx + 8); x++) {
        const o = (y * w + x) * 4;
        d[o] = Math.max(0, Math.min(255, d[o] + off)); d[o + 1] = Math.max(0, Math.min(255, d[o + 1] + off)); d[o + 2] = Math.max(0, Math.min(255, d[o + 2] + off));
      }
    }
  }
  return img;
}

/** Render, then pass through a real JPEG round trip (p.jpeg = quality 0..1) the way a camera's video encoder would. Async. */
export async function renderFrame(p) {
  const img = renderDisplay(p);
  if (!p.jpeg) return img;
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.putImageData(img, 0, 0);
  const im = new Image(); im.src = c.toDataURL('image/jpeg', p.jpeg);
  await im.decode();
  ctx.drawImage(im, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

/** Apply the photometric distortions of `p` to an existing ImageData (a real crop), returning a copy. */
export function distortCopy(img, p, rng) {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  return applyPhotometric(out, p, rng);
}

// ---------- parameter generation ----------

// Distortion levels. Ranges are [min, max] of what is drawn at random for each frame.
export const LEVELS = {
  clean:    { aspect: [0.98, 1.02], blur: [0, 0.3], noise: [0, 2], grain: [0, 1], grad: [0, 0.05], glare: 0, rot: [-0.5, 0.5], persp: [0, 0.01], inkAlpha: [0.88, 0.95], contrast: [0.9, 1] },
  mild:     { aspect: [0.94, 1.06], blur: [0.3, 1.0], noise: [2, 6], grain: [1, 3], grad: [0.05, 0.2], glare: 0, rot: [-2, 2], persp: [0, 0.03], inkAlpha: [0.8, 0.92], contrast: [0.8, 0.95] },
  moderate: { aspect: [0.88, 1.12], blur: [0.8, 1.7], noise: [5, 11], grain: [2, 5], grad: [0.15, 0.35], glare: 0.3, rot: [-4, 4], persp: [0.02, 0.06], inkAlpha: [0.65, 0.88], contrast: [0.6, 0.85] },
  severe:   { aspect: [0.8, 1.2], blur: [1.5, 2.6], noise: [9, 18], grain: [4, 8], grad: [0.3, 0.55], glare: 0.7, rot: [-7, 7], persp: [0.05, 0.12], inkAlpha: [0.45, 0.8], contrast: [0.4, 0.7] },
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
    bodyW: rr(rng, 0.64, 0.68), tv: rr(rng, 0.15, 0.19), th: rr(rng, 0.125, 0.15), gap: rr(rng, 0.012, 0.03), bevel: rr(rng, 0.25, 0.5),
    slant: rr(rng, 4, 8), midY: rr(rng, 0.475, 0.495), ghostDx: rr(rng, 0.015, 0.03), ghostDy: rr(rng, 0.02, 0.035), ghostAlpha: rr(rng, 0.1, 0.22),
    inkAlpha: 1, dash: false,
  };
  const contrast = rr(rng, ...L.contrast);
  geometry.inkAlpha = rr(rng, ...L.inkAlpha) * Math.min(1, contrast / 0.9);
  const pitch = rr(rng, 0.70, 0.73);
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
    aspect: rr(rng, ...L.aspect),
    rotation: rr(rng, ...L.rot), perspective: rr(rng, ...L.persp) * (rng() < 0.5 ? -1 : 1), blur: rr(rng, ...L.blur) * Math.max(0.6, H / 140),
    noise: rr(rng, ...L.noise), grain: rr(rng, ...L.grain),
    gradient: { amp: rr(rng, ...L.grad), angle: grAng },
    glare: L.glare && rng() < 0.6 ? { x: rng() * w, y: rng() * h, r: rr(rng, 0.2, 0.5) * w, amp: rr(rng, 0.1, 1) * L.glare } : null,
    bg: [rr(rng, 125, 160), rr(rng, 140, 172), rr(rng, 125, 160)],
    ink: Math.round(rr(rng, 8, 40) + (1 - contrast) * 80),
    extras: ex, fade: opts.fade, seed: Math.floor(rng() * 1e9),
  };
  return p;
}


// ---------- phone-camera conditions: glare, exposure drift, shadows, vignetting, compression ----------

/** One frame's auto-exposure / white-balance state. jump: draw anew (independent of the last frame). */
export function randomExposure(rng, prev, spec = {}) {
  const gl = spec.gain || [0.6, 1.5], gm = spec.gamma || [0.7, 1.4], cs = spec.cast || 0.1;
  const draw = () => ({ gain: Math.exp(rr(rng, Math.log(gl[0]), Math.log(gl[1]))), gamma: rr(rng, gm[0], gm[1]), cast: [1 + rr(rng, -cs, cs), 1 + rr(rng, -cs / 2, cs / 2), 1 + rr(rng, -cs, cs)] });
  if (!prev || spec.independent) return draw();
  const n = draw(); // random walk with the occasional jump, as auto-exposure behaves
  if (rng() < 0.2) return n;
  const mix = (a, b, t) => a + (b - a) * t;
  return { gain: mix(prev.gain, n.gain, 0.25), gamma: mix(prev.gamma, n.gamma, 0.25), cast: prev.cast.map((c, i) => mix(c, n.cast[i], 0.25)) };
}

/**
 * Add phone-camera conditions to params from randomParams. spec: { glare: [minAmp, maxAmp] | null, glareCount, exposure: spec | true,
 * shadow: true, vignette: [min, max], jpeg: [qmin, qmax] }. Draws from rng after randomParams, so the older levels are unchanged.
 */
export function addConditions(rng, p, spec) {
  const w = p.w, h = p.h;
  if (spec.glare) {
    const n = spec.glareCount ?? (rng() < 0.4 ? 2 : 1);
    p.glares = [];
    for (let i = 0; i < n; i++) {
      const kind = rng();
      let rx, ry;
      if (kind < 0.3) { rx = rr(rng, 0.5, 1.4) * w; ry = rr(rng, 0.5, 1.4) * h; }     // covers a whole digit or more
      else if (kind < 0.65) { rx = rr(rng, 0.12, 0.35) * w; ry = rr(rng, 0.25, 0.8) * h; } // covers part of a digit
      else { rx = rr(rng, 0.6, 1.5) * w; ry = rr(rng, 0.06, 0.2) * h; }                // a streak
      p.glares.push({ x: rng() * w, y: rng() * h, rx, ry, angle: rng() < 0.5 ? rr(rng, -0.6, 0.6) : rr(rng, 0, 3.14), amp: rr(rng, spec.glare[0], spec.glare[1]), pw: rr(rng, 1, 2.2) });
    }
    p.glare = null;
  }
  if (spec.still) { // the second real video: a reflection that stays put. It lightens the ink of the upper segments (a, b, f) of every
    // digit, a red patch nearly hides the b segment of the hundreds digit, and the unlit segments show faintly (0.10-0.20 of a lit one).
    // spec.still = true is the measured strength; { hard: true } adds a brighter band and patch (the background goes up as well).
    const hard = spec.still && spec.still.hard, P = p.pitch * p.H;
    p.dim = [{ cell: 0, segs: 'abf', factor: rr(rng, 0.55, 0.9) }, { cell: 1, segs: 'abf', factor: rr(rng, 0.55, 0.9) }, { cell: 2, segs: 'abf', factor: rr(rng, 0.55, 0.9) },
      { cell: 2, segs: 'b', factor: rr(rng, 0.2, 0.9) }];
    p.glares = (p.glares || []).concat([{ x: p.xr - P, y: p.y0 + rr(rng, 0.05, 0.25) * p.H, rx: 2.5 * P, ry: rr(rng, 0.22, 0.34) * p.H, angle: 0, amp: hard ? rr(rng, 0.3, 0.5) : rr(rng, 0.05, 0.2), pw: 1.6 }]);
    if (hard) p.glares.push({ x: p.xr - 2 * P - rr(rng, 0.0, 0.12) * P, y: p.y0 + rr(rng, 0.15, 0.3) * p.H, rx: rr(rng, 0.25, 0.4) * P, ry: rr(rng, 0.25, 0.4) * p.H, angle: 0, amp: rr(rng, 0.5, 0.78), pw: 1.4 });
    p.glare = null;
    p.offAlpha = rr(rng, 0.1, 0.2) / Math.max(0.3, p.geometry.inkAlpha);
  }
  if (spec.exposure) p.exposure = randomExposure(rng, null, spec.exposure === true ? {} : spec.exposure);
  if (spec.shadow) { // segment shadows off the reflective backing: any direction, varied strength and softness
    const g = p.geometry, ang = rng() * 6.28, dist = rr(rng, 0.015, 0.05);
    g.ghostDx = Math.cos(ang) * dist; g.ghostDy = Math.sin(ang) * dist; g.ghostAlpha = rr(rng, 0.12, 0.45);
  }
  if (spec.vignette) p.vignette = rr(rng, ...spec.vignette);
  if (spec.gradient) p.gradient = { amp: rr(rng, ...spec.gradient), angle: rng() * 6.28 };
  if (spec.jpeg) { p.jpeg = rr(rng, ...spec.jpeg); p.blockNoise = rr(rng, 0.5, 2); p.blur = Math.max(p.blur, rr(rng, 0.4, 1.0)); }
  return p;
}

/** Named condition sets used by the tests. */
export const CONDITIONS = {
  exposure: { exposure: { independent: true } },
  glareLight: { glare: [0.08, 0.25] },           // faint veil
  glareMid: { glare: [0.25, 0.42] },
  glare: { glare: [0.25, 0.6] },                 // a person still reads every segment comfortably
  glareHard: { glare: [0.6, 0.85] },             // contrast mostly gone under the glare
  glareGone: { glare: [0.92, 1.0], glareCount: 1 },
  still: { still: true, exposure: { independent: true } }, // the second real video: a reflection that stays put, unlit segments faintly visible
  stillStatic: { still: true },
  stillHard: { still: { hard: true } },  // the same with a bright band and patch: the background goes up too, q falls to 0.3-0.6 (harsher than the video)
  lighting: { shadow: true, vignette: [0.2, 0.5], gradient: [0.2, 0.5], jpeg: [0.5, 0.85], exposure: { independent: true }, glare: [0.15, 0.45], glareCount: 1 },
};
