import { apply, deviceLabel, detectQuad, documentFilter, homography, Img, otsu, outputSize, Quad, toGray, warp } from "./scanMath";

/** A dark "table" with a bright, rotated "page" polygon drawn on it. */
function photo(w: number, h: number, quad: Quad, shade = (x: number, y: number) => 0): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  const inside = (x: number, y: number) => {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      s += c > 0 ? 1 : c < 0 ? -1 : 0;
    }
    return Math.abs(s) === 4;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = (inside(x, y) ? 230 : 50) - shade(x, y);
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  return { data, width: w, height: h };
}
const near = (a: { x: number; y: number }, b: { x: number; y: number }, tol: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

test("otsu splits two populations", () => {
  const g = new Float32Array([...Array(100).fill(40), ...Array(100).fill(220)]);
  const t = otsu(g);
  expect(t).toBeGreaterThanOrEqual(40);
  expect(t).toBeLessThan(220);
});

test("detects the corners of a tilted page", () => {
  const page: Quad = [
    { x: 40, y: 30 },
    { x: 150, y: 45 },
    { x: 140, y: 190 },
    { x: 25, y: 175 },
  ];
  const q = detectQuad(photo(180, 220, page))!;
  expect(q).not.toBeNull();
  q.forEach((p, i) => expect(near(p, page[i], 3)).toBe(true));
});

test("no page found → null (the user drags the corners)", () => {
  const blank = photo(100, 100, [
    { x: -5, y: -5 },
    { x: 105, y: -5 },
    { x: 105, y: 105 },
    { x: -5, y: 105 },
  ]);
  expect(detectQuad(blank)).toBeNull();
});

test("homography maps the corners exactly; warp flattens the page", () => {
  const from: Quad = [
    { x: 10, y: 20 },
    { x: 90, y: 10 },
    { x: 100, y: 80 },
    { x: 0, y: 90 },
  ];
  const to: Quad = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 50, y: 70 },
    { x: 0, y: 70 },
  ];
  const H = homography(from, to);
  from.forEach((p, i) => expect(near(apply(H, p), to[i], 1e-6)).toBe(true));

  const page: Quad = [
    { x: 40, y: 30 },
    { x: 150, y: 45 },
    { x: 140, y: 190 },
    { x: 25, y: 175 },
  ];
  const img = photo(180, 220, page);
  const size = outputSize(page);
  expect(size.height).toBeGreaterThan(size.width); // portrait page stays portrait
  const flat = warp(img, page, size.width, size.height);
  // the whole output is paper (bright), apart from a 1–2 px edge
  const g = toGray(flat);
  let bright = 0;
  for (let i = 0; i < g.length; i++) if (g[i] > 150) bright++;
  expect(bright / g.length).toBeGreaterThan(0.95);
});

test("document filter removes a shadow: paper → white, ink → black", () => {
  const w = 120;
  const h = 120;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const shadow = x * 1.2; // left bright, right dark (uneven light)
      const ink = y > 55 && y < 60 && x > 10 && x < 110;
      const v = (ink ? 60 : 225) - shadow * 0.8;
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  const out = documentFilter({ data, width: w, height: h }, "document");
  const at = (x: number, y: number) => out.data[(y * w + x) * 4];
  expect(at(10, 20)).toBe(255); // bright paper
  expect(at(110, 20)).toBe(255); // shadowed paper is white too
  expect(at(100, 57)).toBeLessThan(60); // ink stays dark even in the shadow
});

test("device label", () => {
  expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("iPhone · Safari");
  expect(deviceLabel("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36")).toBe("Android · Chrome");
});
