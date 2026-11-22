// Image maths for camera scanning, on plain RGBA buffers (no canvas needed, unit-tested):
//   detectQuad()  — find the page in a photo (bright paper against a darker background)
//   homography()  — the projective transform between two quadrilaterals
//   warp()        — perspective correction: the page becomes a flat rectangle
//   documentFilter() — even out lighting / shadows, optional black-and-white
export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
export type Pt = { x: number; y: number };
export type Quad = [Pt, Pt, Pt, Pt]; // top-left, top-right, bottom-right, bottom-left

export function toGray(img: Img): Float32Array {
  const g = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2];
  return g;
}

/** Box blur via an integral image (O(n) for any radius). */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
      out[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Otsu's threshold of a grayscale image (0–255). */
export function otsu(g: Float32Array): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, Math.round(g[i])))]++;
  const total = g.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

const area = (q: Quad) => {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
};

/**
 * Find the page: threshold (Otsu), keep the largest bright region, take its four extreme
 * corners. Returns the corners in pixels, or null when no clear page is found (the caller
 * then uses the whole photo and lets the user drag the corners).
 */
export function detectQuad(img: Img, { minAreaRatio = 0.15 } = {}): Quad | null {
  const { width: w, height: h } = img;
  const g = boxBlur(toGray(img), w, h, 2);
  const t = otsu(g);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = g[i] > t ? 1 : 0;
  // largest 4-connected bright component
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  let bestId = -1;
  let bestSize = 0;
  let id = 0;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s] !== -1) continue;
    let top = 0;
    let size = 0;
    stack[top++] = s;
    label[s] = id;
    while (top) {
      const p = stack[--top];
      size++;
      const x = p % w;
      const y = (p - x) / w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && mask[q] && label[q] === -1) {
          label[q] = id;
          stack[top++] = q;
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestId = id;
    }
    id++;
  }
  if (bestId < 0 || bestSize < w * h * minAreaRatio) return null;
  // the region filling (almost) the whole frame means no page edge is visible
  if (bestSize > w * h * 0.97) return null;
  let tl = { x: 0, y: 0, v: Infinity };
  let br = { x: 0, y: 0, v: -Infinity };
  let tr = { x: 0, y: 0, v: -Infinity };
  let bl = { x: 0, y: 0, v: Infinity };
  for (let p = 0; p < label.length; p++) {
    if (label[p] !== bestId) continue;
    const x = p % w;
    const y = (p - x) / w;
    const s = x + y;
    const d = x - y;
    if (s < tl.v) tl = { x, y, v: s };
    if (s > br.v) br = { x, y, v: s };
    if (d > tr.v) tr = { x, y, v: d };
    if (d < bl.v) bl = { x, y, v: d };
  }
  const q: Quad = [
    { x: tl.x, y: tl.y },
    { x: tr.x, y: tr.y },
    { x: br.x, y: br.y },
    { x: bl.x, y: bl.y },
  ];
  return area(q) >= w * h * minAreaRatio ? q : null;
}

/** Solve A·x = b (Gaussian elimination with partial pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) throw new Error("degenerate quadrilateral");
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** 3×3 homography H (row-major, h33 = 1) mapping `from[i]` → `to[i]`. */
export function homography(from: Quad, to: Quad): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return [...solve(A, b), 1];
}

export function apply(H: number[], p: Pt): Pt {
  const d = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / d, y: (H[3] * p.x + H[4] * p.y + H[5]) / d };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Output size for a page quad: its longest opposite edges, scaled so the long side ≤ maxSide. */
export function outputSize(q: Quad, maxSide = 2400): { width: number; height: number } {
  const w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  const h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Perspective-correct the quad of `src` into a width×height rectangle (bilinear sampling). */
export function warp(src: Img, q: Quad, width: number, height: number): Img {
  const rect: Quad = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const H = homography(rect, q); // output pixel → source pixel
  const out = new Uint8ClampedArray(width * height * 4);
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = H[6] * x + H[7] * y + H[8];
      const fx = Math.min(sw - 1.001, Math.max(0, (H[0] * x + H[1] * y + H[2]) / d));
      const fy = Math.min(sh - 1.001, Math.max(0, (H[3] * x + H[4] * y + H[5]) / d));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = fx - x0;
      const ay = fy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] * (1 - ax) + sd[i10 + c] * ax;
        const bot = sd[i01 + c] * (1 - ax) + sd[i11 + c] * ax;
        out[o + c] = top * (1 - ay) + bot * ay;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}

export type FilterMode = "document" | "gray" | "color";

/**
 * "document": divide by the blurred background (removes shadows and uneven light) and
 * push paper to white / ink to black — like a black-and-white scanner setting.
 * "gray": the same lighting fix, keeping greys. "color": a gentle contrast stretch only.
 */
export function documentFilter(img: Img, mode: FilterMode): Img {
  const { width: w, height: h } = img;
  const out = new Uint8ClampedArray(img.data.length);
  if (mode === "color") {
    let lo = 255;
    let hi = 0;
    const g = toGray(img);
    const sorted = Float32Array.from(g).sort();
    lo = sorted[Math.floor(sorted.length * 0.02)];
    hi = sorted[Math.floor(sorted.length * 0.98)];
    const k = 255 / Math.max(1, hi - lo);
    for (let i = 0; i < img.data.length; i += 4) {
      for (let c = 0; c < 3; c++) out[i + c] = (img.data[i + c] - lo) * k;
      out[i + 3] = 255;
    }
    return { data: out, width: w, height: h };
  }
  const g = toGray(img);
  const bg = boxBlur(g, w, h, Math.max(8, Math.round(Math.max(w, h) / 30)));
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    let v = Math.min(255, (g[i] / Math.max(1, bg[i])) * 235); // background → ~white
    if (mode === "document") v = v > 200 ? 255 : v < 110 ? 0 : ((v - 110) / 90) * 255;
    out[j] = out[j + 1] = out[j + 2] = v;
    out[j + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

/** Short device label for the audit trail, e.g. "iPhone · Safari". */
export function deviceLabel(ua: string): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${os} · ${br}`;
}
