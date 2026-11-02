/**
 * Roomshift step 2 (DETAIL.md): fit the room's shell (floor, ceiling, walls) to a metric point cloud.
 * Deterministic, no AI. Assumes a roughly rectangular ("Manhattan") room, which covers most rooms; when a
 * wall or the ceiling was never filmed it is inferred from the extent of the points and flagged.
 *
 * Output frame ("room frame"): metres, y-up, floor at y = 0, walls parallel to the x and z axes, the room's
 * centre at x = z = 0. `alignment` maps scan coordinates into it (row-major 4×4, same layout as camera poses,
 * so three.js can use `new Matrix4().set(...alignment)`).
 */

type V3 = [number, number, number];

export interface ShellWall {
  /** Ends of the wall on the floor, [x, z] in the room frame. */
  a: [number, number];
  b: [number, number];
  /** Unit normal pointing into the room, [x, z]. */
  normal: [number, number];
  /** True when no wall was seen there and its position comes from the extent of the points. */
  inferred: boolean;
  /** Points within 5 cm of the wall's plane (from the fitting sample). */
  support: number;
}

export interface RoomShell {
  /** Row-major 4×4: scan coordinates → room frame. */
  alignment: number[];
  floorY: 0;
  ceilingY: number;
  ceilingInferred: boolean;
  /** Floor polygon, [x, z] in the room frame, counter-clockwise seen from above. */
  floor: [number, number][];
  walls: ShellWall[];
  size: { width: number; depth: number; height: number };
  /** 0..1: 0.4 for a fitted floor + 0.15 per observed wall. */
  confidence: number;
  /** Fitting went badly (no floor, or fewer than two walls seen): show the raw points instead of the shell. */
  fallback: boolean;
  diagnostics: string[];
}

export interface FitShellOptions {
  /** Camera poses (row-major world-from-camera, y-up) used to guess "up" before the floor is found. */
  cameras?: { pose: number[] }[];
  /** Points used for fitting (the cloud is thinned evenly to this many). Default 60 000. */
  maxSamples?: number;
}

const FLOOR_TOL = 0.03;
const WALL_TOL = 0.05;
const COS_30 = Math.cos(Math.PI / 6);

export function fitRoomShell(positions: Float32Array | number[], opts: FitShellOptions = {}): RoomShell {
  const diagnostics: string[] = [];
  const total = Math.floor(positions.length / 3);
  const maxS = opts.maxSamples ?? 60_000;
  const m = Math.min(total, maxS);
  const step = total > maxS ? total / maxS : 1;
  const P = new Float64Array(m * 3);
  for (let k = 0; k < m; k++) {
    const i = Math.floor(k * step) * 3;
    P[k * 3] = positions[i];
    P[k * 3 + 1] = positions[i + 1];
    P[k * 3 + 2] = positions[i + 2];
  }
  if (m < 300) return emptyShell([`only ${m} points: too few to fit a room`]);

  // ---- 1. Up guess: phones are held upright, so the cameras' mean up axis is close to gravity.
  let up: V3 = [0, 1, 0];
  if (opts.cameras?.length) {
    const s: V3 = [0, 0, 0];
    for (const c of opts.cameras) if (c.pose?.length === 16) add(s, [c.pose[1], c.pose[5], c.pose[9]]);
    if (len(s) > 1e-6) up = norm(s);
  }

  // ---- 2. Floor: RANSAC for the best near-horizontal plane among the lowest points.
  const h = new Float64Array(m);
  for (let k = 0; k < m; k++) h[k] = dotAt(P, k, up);
  const hs = sorted(h);
  const hLo = pct(hs, 0.02);
  const hHi = pct(hs, 0.98);
  const band: number[] = [];
  for (let k = 0; k < m; k++) if (h[k] <= hLo + 0.3 * (hHi - hLo)) band.push(k);
  const rnd = mulberry32(1);
  let best: { n: V3; d: number; count: number } | null = null;
  for (let it = 0; it < 500 && band.length >= 3; it++) {
    const a = at(P, band[Math.floor(rnd() * band.length)]);
    const b = at(P, band[Math.floor(rnd() * band.length)]);
    const c = at(P, band[Math.floor(rnd() * band.length)]);
    let n = cross(sub(b, a), sub(c, a));
    if (len(n) < 1e-9) continue;
    n = norm(n);
    if (dot(n, up) < 0) n = scale(n, -1);
    if (dot(n, up) < COS_30) continue;
    const d = -dot(n, a);
    let count = 0;
    for (const k of band) if (Math.abs(dotAt(P, k, n) + d) < FLOOR_TOL) count++;
    if (!best || count > best.count) best = { n, d, count };
  }

  let floorN: V3 = up;
  let floorD = -hLo;
  let floorFound = false;
  if (best) {
    // Refine with a least-squares plane through every inlier.
    const idx: number[] = [];
    for (let k = 0; k < m; k++) if (Math.abs(dotAt(P, k, best.n) + best.d) < FLOOR_TOL * 1.5) idx.push(k);
    if (idx.length >= Math.max(200, 0.02 * m)) {
      const { normal, centroid } = fitPlane(P, idx);
      floorN = dot(normal, best.n) < 0 ? scale(normal, -1) : normal;
      floorD = -dot(floorN, centroid);
      let below = 0;
      for (let k = 0; k < m; k++) if (dotAt(P, k, floorN) + floorD < -0.1) below++;
      if (below / m > 0.1) diagnostics.push(`${Math.round((100 * below) / m)}% of points lie below the fitted floor`);
      floorFound = true;
      diagnostics.push(`floor: ${idx.length} points, tilt ${deg(Math.acos(clamp(dot(floorN, up), -1, 1)))}° from the cameras' up`);
    }
  }
  if (!floorFound) diagnostics.push('no floor plane found; using the lowest points and the cameras’ up');

  const F = floorAlign(floorN, floorD);
  const Q = new Float64Array(m * 3);
  for (let k = 0; k < m; k++) {
    const p = apply(F, at(P, k));
    Q[k * 3] = p[0];
    Q[k * 3 + 1] = p[1];
    Q[k * 3 + 2] = p[2];
  }

  // ---- 3. Ceiling: the strongest horizontal layer of points above 1.8 m, if it was filmed at all.
  const ys = sorted(Float64Array.from({ length: m }, (_, k) => Q[k * 3 + 1]));
  const yTop = pct(ys, 0.999);
  let ceilingY = Math.max(pct(ys, 0.995), 2.4);
  let ceilingInferred = true;
  if (yTop > 1.85) {
    const BIN = 0.02;
    const y0 = 1.8;
    const bins = new Float64Array(Math.ceil((yTop + 0.05 - y0) / BIN) + 1);
    for (let k = 0; k < m; k++) {
      const y = Q[k * 3 + 1];
      if (y >= y0 && y <= yTop + 0.05) bins[Math.floor((y - y0) / BIN)]++;
    }
    const sm = smooth(bins);
    let bi = 0;
    for (let i = 1; i < sm.length; i++) if (sm[i] > sm[bi]) bi = i;
    // A ceiling is a dense layer: well above the density of the wall points around it.
    const typical = pct(sorted(Float64Array.from(sm)), 0.5);
    if (sm[bi] >= Math.max(0.004 * m, 40, 4 * typical)) {
      const c = y0 + (bi + 0.5) * BIN;
      let s = 0;
      let n = 0;
      for (let k = 0; k < m; k++) {
        const y = Q[k * 3 + 1];
        if (Math.abs(y - c) < 0.04) (s += y), n++;
      }
      ceilingY = s / n;
      ceilingInferred = false;
    }
  }
  ceilingY = clamp(ceilingY, 1.9, 6);
  diagnostics.push(ceilingInferred ? `ceiling not seen; assumed ${ceilingY.toFixed(2)} m` : `ceiling at ${ceilingY.toFixed(2)} m`);

  // ---- 4. Wall orientation: the yaw at which the wall-height points line up into the sharpest histograms.
  const yMin = 0.3;
  const yMax = ceilingY - 0.3 > yMin + 0.3 ? ceilingY - 0.3 : 2;
  const wx: number[] = [];
  const wz: number[] = [];
  for (let k = 0; k < m; k++) {
    const y = Q[k * 3 + 1];
    if (y > yMin && y < yMax) wx.push(Q[k * 3]), wz.push(Q[k * 3 + 2]);
  }
  if (wx.length < 200) {
    diagnostics.push(`only ${wx.length} points at wall height`);
    return finish(F, 0, 0, 0, [], ceilingY, ceilingInferred, floorFound, diagnostics, true);
  }
  const cx = median(wx);
  const cz = median(wz);
  const rr = sorted(Float64Array.from(wx, (x, i) => Math.hypot(x - cx, wz[i] - cz)));
  const R = Math.min(pct(rr, 0.99) + 0.2, 30);
  const sampleStep = Math.max(1, wx.length / 20_000);
  const sx: number[] = [];
  const sz: number[] = [];
  for (let k = 0; k < wx.length; k += sampleStep) {
    const i = Math.floor(k);
    if (Math.hypot(wx[i] - cx, wz[i] - cz) <= R) sx.push(wx[i] - cx), sz.push(wz[i] - cz);
  }
  const nb = Math.ceil((2 * R) / 0.05) + 2;
  const hu = new Float64Array(nb);
  const hv = new Float64Array(nb);
  const score = (th: number) => {
    hu.fill(0);
    hv.fill(0);
    const c = Math.cos(th);
    const s = Math.sin(th);
    for (let i = 0; i < sx.length; i++) {
      hu[Math.floor((sx[i] * c + sz[i] * s + R) / 0.05)]++;
      hv[Math.floor((-sx[i] * s + sz[i] * c + R) / 0.05)]++;
    }
    let t = 0;
    for (let i = 0; i < nb; i++) t += hu[i] * hu[i] + hv[i] * hv[i];
    return t;
  };
  let yaw = 0;
  let bestScore = -1;
  for (let d = 0; d < 90; d++) {
    const s = score((d * Math.PI) / 180);
    if (s > bestScore) (bestScore = s), (yaw = d);
  }
  let fine = yaw;
  for (let d = yaw - 1; d <= yaw + 1; d += 0.1) {
    const s = score((d * Math.PI) / 180);
    if (s > bestScore) (bestScore = s), (fine = d);
  }
  yaw = (fine * Math.PI) / 180;

  // ---- 5. Walls: on each axis, the outermost strong layer of points on either side of the room's middle.
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const U = wx.map((x, i) => x * cosY + wz[i] * sinY);
  const Vv = wx.map((x, i) => -x * sinY + wz[i] * cosY);
  // Where the phone was: the room must contain every camera, so a wall can't sit between them.
  const camU: number[] = [];
  const camV: number[] = [];
  for (const c of opts.cameras ?? []) {
    if (c.pose?.length !== 16) continue;
    const p = apply(F, [c.pose[3], c.pose[7], c.pose[11]]);
    camU.push(p[0] * cosY + p[2] * sinY);
    camV.push(-p[0] * sinY + p[2] * cosY);
  }
  const wu = findWalls(U, camU);
  const wv = findWalls(Vv, camV);
  const walls = { u: wu, v: wv };
  const cu = (wu.lo.at + wu.hi.at) / 2;
  const cv = (wv.lo.at + wv.hi.at) / 2;
  // Yaw + recentre: x' = u - cu, z' = v - cv.
  const Y = [cosY, 0, sinY, -cu, 0, 1, 0, 0, -sinY, 0, cosY, -cv, 0, 0, 0, 1];
  const width = wu.hi.at - wu.lo.at;
  const depth = wv.hi.at - wv.lo.at;
  return finish(mul(Y, F), width, depth, yaw, [walls.v.lo, walls.u.hi, walls.v.hi, walls.u.lo], ceilingY, ceilingInferred, floorFound, diagnostics, false);
}

/** Apply a row-major 4×4 to a point. */
export function transformPointRowMajor(m: number[], p: readonly number[]): [number, number, number] {
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
}

/** Row-major 4×4 product a·b. */
export function multiplyRowMajor(a: number[], b: number[]): number[] {
  return mul(a, b);
}

// ---------------------------------------------------------------------------------------------- internals

interface WallHit {
  at: number;
  support: number;
  inferred: boolean;
}

/**
 * The two walls along one axis. Candidates are the strong layers of points beyond where the cameras stood
 * (or beyond the middle when there are no cameras). On each side the outermost layer at least 40% as strong
 * as that side's strongest wins: outermost so furniture fronts don't pass for walls, but not a short alcove
 * wall when a long one stands in front of it. No layer beyond the cameras → the wall is inferred from the
 * extent of the points.
 */
function findWalls(vals: number[], cams: number[] = []): { lo: WallHit; hi: WallHit } {
  const s = sorted(Float64Array.from(vals));
  const lo0 = pct(s, 0.005) - 0.15;
  const hi0 = pct(s, 0.995) + 0.15;
  const mid = pct(s, 0.5);
  const BIN = 0.02;
  const bins = new Float64Array(Math.max(1, Math.ceil((hi0 - lo0) / BIN)));
  for (const v of vals) if (v >= lo0 && v < hi0) bins[Math.floor((v - lo0) / BIN)]++;
  const sm = smooth(bins);
  let max = 0;
  for (const c of sm) max = Math.max(max, c);
  const thr = Math.max(0.12 * max, 20);
  const peaks: { at: number; w: number }[] = [];
  for (let i = 0; i < sm.length; i++) if (sm[i] >= thr && sm[i] >= (sm[i - 1] ?? 0) && sm[i] >= (sm[i + 1] ?? 0)) peaks.push({ at: lo0 + (i + 0.5) * BIN, w: sm[i] });
  const refine = (c: number): WallHit => {
    let t = 0;
    let n = 0;
    for (const v of vals) if (Math.abs(v - c) < WALL_TOL) (t += v), n++;
    return { at: n ? t / n : c, support: n, inferred: false };
  };
  const CAM_GAP = 0.15;
  const camLo = cams.length ? Math.min(...cams) - CAM_GAP : mid;
  const camHi = cams.length ? Math.max(...cams) + CAM_GAP : mid;
  const pick = (cands: { at: number; w: number }[], outermostFirst: boolean) => {
    const strongest = Math.max(...cands.map((p) => p.w));
    const ordered = outermostFirst ? cands : [...cands].reverse();
    return ordered.find((p) => p.w >= 0.4 * strongest)!;
  };
  const low = peaks.filter((p) => p.at < Math.min(mid, camLo));
  const high = peaks.filter((p) => p.at > Math.max(mid, camHi));
  return {
    lo: low.length ? refine(pick(low, true).at) : { at: Math.min(pct(s, 0.01), camLo - 0.15), support: 0, inferred: true },
    hi: high.length ? refine(pick(high, false).at) : { at: Math.max(pct(s, 0.99), camHi + 0.15), support: 0, inferred: true },
  };
}

function finish(
  alignment: number[],
  width: number,
  depth: number,
  yaw: number,
  hits: WallHit[],
  ceilingY: number,
  ceilingInferred: boolean,
  floorFound: boolean,
  diagnostics: string[],
  forceFallback: boolean,
): RoomShell {
  const x0 = -width / 2;
  const x1 = width / 2;
  const z0 = -depth / 2;
  const z1 = depth / 2;
  const ends: [[number, number], [number, number], [number, number]][] = [
    [[x0, z0], [x1, z0], [0, 1]], // far (−z) wall
    [[x1, z0], [x1, z1], [-1, 0]], // +x wall
    [[x1, z1], [x0, z1], [0, -1]], // near (+z) wall
    [[x0, z1], [x0, z0], [1, 0]], // −x wall
  ];
  const walls: ShellWall[] = hits.map((w, i) => ({ a: r2(ends[i][0]), b: r2(ends[i][1]), normal: ends[i][2], inferred: w.inferred, support: w.support }));
  const seen = walls.filter((w) => !w.inferred).length;
  if (walls.length) diagnostics.push(`walls: ${seen}/4 seen, yaw ${deg(yaw)}°, room ${width.toFixed(2)} × ${depth.toFixed(2)} m`);
  let fallback = forceFallback || !floorFound || seen < 2;
  if (!forceFallback && (width < 1 || depth < 1 || width > 25 || depth > 25)) {
    diagnostics.push(`implausible room size ${width.toFixed(1)} × ${depth.toFixed(1)} m`);
    fallback = true;
  }
  return {
    alignment: alignment.map((v) => Math.round(v * 1e6) / 1e6),
    floorY: 0,
    ceilingY: round(ceilingY),
    ceilingInferred,
    floor: walls.length ? [r2([x0, z0]), r2([x1, z0]), r2([x1, z1]), r2([x0, z1])] : [],
    walls,
    size: { width: round(width), depth: round(depth), height: round(ceilingY) },
    confidence: Math.round(((floorFound ? 0.4 : 0) + 0.15 * seen) * 100) / 100,
    fallback,
    diagnostics,
  };
}

function emptyShell(diagnostics: string[]): RoomShell {
  return finish([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0, 0, 0, [], 2.4, true, false, diagnostics, true);
}

/** Rotation taking the floor normal to +y, then a lift putting the floor at y = 0. */
function floorAlign(n: V3, d: number): number[] {
  const yv: V3 = [0, 1, 0];
  const c = dot(n, yv);
  let Rm: number[];
  if (c < -0.9999) Rm = [1, 0, 0, 0, -1, 0, 0, 0, -1];
  else {
    const v = cross(n, yv);
    const k = 1 / (1 + c);
    // R = I + [v]× + [v]×² / (1 + c)
    Rm = [
      1 - k * (v[1] * v[1] + v[2] * v[2]), k * v[0] * v[1] - v[2], k * v[0] * v[2] + v[1],
      k * v[0] * v[1] + v[2], 1 - k * (v[0] * v[0] + v[2] * v[2]), k * v[1] * v[2] - v[0],
      k * v[0] * v[2] - v[1], k * v[1] * v[2] + v[0], 1 - k * (v[0] * v[0] + v[1] * v[1]),
    ];
  }
  // After rotating, a point's height is n·p; the floor sits at n·p = −d, so lift by d.
  return [Rm[0], Rm[1], Rm[2], 0, Rm[3], Rm[4], Rm[5], d, Rm[6], Rm[7], Rm[8], 0, 0, 0, 0, 1];
}

function fitPlane(P: Float64Array, idx: number[]): { normal: V3; centroid: V3 } {
  const c: V3 = [0, 0, 0];
  for (const k of idx) add(c, at(P, k));
  const centroid = scale(c, 1 / idx.length);
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const k of idx) {
    const d = sub(at(P, k), centroid);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += d[i] * d[j];
  }
  return { normal: smallestEigenvector(C), centroid };
}

/** Jacobi eigen-decomposition of a symmetric 3×3; returns the eigenvector of the smallest eigenvalue. */
function smallestEigenvector(A0: number[]): V3 {
  const A = A0.slice();
  const Vm = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) off += A[p * 3 + q] ** 2;
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = A[p * 3 + q];
      if (Math.abs(apq) < 1e-30) continue;
      const theta = (A[q * 3 + q] - A[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A[k * 3 + p];
        const akq = A[k * 3 + q];
        A[k * 3 + p] = c * akp - s * akq;
        A[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p * 3 + k];
        const aqk = A[q * 3 + k];
        A[p * 3 + k] = c * apk - s * aqk;
        A[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = Vm[k * 3 + p];
        const vkq = Vm[k * 3 + q];
        Vm[k * 3 + p] = c * vkp - s * vkq;
        Vm[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  let i = 0;
  if (A[4] < A[i * 4]) i = 1;
  if (A[8] < A[i * 4]) i = 2;
  return norm([Vm[i], Vm[3 + i], Vm[6 + i]]);
}

function mul(a: number[], b: number[]): number[] {
  const o = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return o;
}
const apply = (m: number[], p: V3): V3 => transformPointRowMajor(m, p);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smooth(b: Float64Array): Float64Array {
  const o = new Float64Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = ((b[i - 1] ?? 0) + 2 * b[i] + (b[i + 1] ?? 0)) / 4;
  return o;
}

const sorted = (a: Float64Array) => Float64Array.from(a).sort();
const pct = (s: Float64Array, q: number) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))] : 0);
const median = (a: number[]) => pct(sorted(Float64Array.from(a)), 0.5);
const at = (P: Float64Array, k: number): V3 => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
const dotAt = (P: Float64Array, k: number, n: V3) => P[k * 3] * n[0] + P[k * 3 + 1] * n[1] + P[k * 3 + 2] * n[2];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));
function add(a: V3, b: V3) {
  a[0] += b[0];
  a[1] += b[1];
  a[2] += b[2];
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (p: [number, number]): [number, number] => [round(p[0]), round(p[1])];
const deg = (r: number) => Math.round((r * 1800) / Math.PI) / 10;
