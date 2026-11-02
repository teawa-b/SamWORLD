/**
 * Roomshift step 3 (DETAIL.md): lift 2D SAM masks into 3D objects. Deterministic, no AI.
 *
 * The scan has no per-frame depth maps, so visibility comes from the fused cloud itself: every point is
 * projected into the keyframe, a coarse z-buffer keeps the nearest surface per cell, and the visible points
 * that land inside the mask belong to the object. Points on the fitted shell (floor, walls, ceiling) are
 * dropped, the rest give a robust oriented box in the room frame. Detections of the same label whose point
 * sets overlap in 3D are merged into one object.
 */
import { transformPointRowMajor, type RoomShell } from './room-shell.js';

export interface LiftCamera {
  /** 4×4 world-from-camera, row-major, y-up, camera looks down -z (as ScanCamera). */
  pose: number[];
  /** fx, fy, cx, cy in pixels of the camera image (width × height). */
  intrinsics: [number, number, number, number];
  width: number;
  height: number;
}

export interface LiftMask {
  /** Row-major 0/1 raster covering the whole frame. */
  raster: Uint8Array;
  width: number;
  height: number;
}

export interface ObjectBox {
  /** Centre, metres, room frame. */
  centre: [number, number, number];
  /** Width (along the box's local x), height, depth (local z), metres. */
  size: [number, number, number];
  /** Rotation about +y, radians, as three.js applies it (`object.rotation.y = yaw`). */
  yaw: number;
}

export interface LiftedDetection {
  label: string;
  score: number;
  /** Indices into the cloud of the points this detection covers (after shell removal). */
  points: Uint32Array;
  /** Frame it came from, and the share of its mask that touched the frame edge (0 = fully inside). */
  frame: number;
  edge: number;
  /** Mask area as a share of the frame. */
  area: number;
  /** Pixel box in the frame, [left, top, right, bottom]. */
  bbox: [number, number, number, number];
}

const ZBUF_CELL = 4; // camera pixels per z-buffer cell
const Z_SLACK = 0.06; // metres behind the nearest surface still counted as visible
const SHELL_TOL = 0.06;

/** Inverse of a rigid row-major 4×4 (rotation + translation). */
function invertRigid(m: number[]): number[] {
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const t = [m[3], m[7], m[11]];
  return [
    r[0], r[1], r[2], -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]),
    r[3], r[4], r[5], -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]),
    r[6], r[7], r[8], -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]),
    0, 0, 0, 1,
  ];
}

/**
 * Project the cloud into one camera. Returns, per point, the camera pixel index (or -1 when behind the
 * camera, outside the image or hidden behind a nearer surface).
 */
export function visiblePixels(positions: Float32Array, cam: LiftCamera): Int32Array {
  const n = positions.length / 3;
  const V = invertRigid(cam.pose);
  const [fx, fy, cx, cy] = cam.intrinsics;
  const gw = Math.ceil(cam.width / ZBUF_CELL);
  const gh = Math.ceil(cam.height / ZBUF_CELL);
  const zbuf = new Float32Array(gw * gh).fill(Infinity);
  const pix = new Int32Array(n).fill(-1);
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const d = -(V[8] * x + V[9] * y + V[10] * z + V[11]);
    if (d < 0.05) continue;
    const xc = V[0] * x + V[1] * y + V[2] * z + V[3];
    const yc = V[4] * x + V[5] * y + V[6] * z + V[7];
    const u = Math.floor((fx * xc) / d + cx);
    const v = Math.floor(cy - (fy * yc) / d);
    if (u < 0 || v < 0 || u >= cam.width || v >= cam.height) continue;
    pix[i] = v * cam.width + u;
    depth[i] = d;
    const g = Math.floor(v / ZBUF_CELL) * gw + Math.floor(u / ZBUF_CELL);
    if (d < zbuf[g]) zbuf[g] = d;
  }
  for (let i = 0; i < n; i++) {
    if (pix[i] < 0) continue;
    const u = pix[i] % cam.width, v = Math.floor(pix[i] / cam.width);
    const g = Math.floor(v / ZBUF_CELL) * gw + Math.floor(u / ZBUF_CELL);
    if (depth[i] > zbuf[g] * 1.03 + Z_SLACK) pix[i] = -1;
  }
  return pix;
}

/** True for points (room frame) lying on the shell: the floor, the ceiling or a wall plane. */
export function onShell(p: readonly number[], shell: RoomShell): boolean {
  if (p[1] < SHELL_TOL || p[1] > shell.ceilingY - SHELL_TOL) return true;
  for (const w of shell.walls) {
    const dist = (p[0] - w.a[0]) * w.normal[0] + (p[2] - w.a[1]) * w.normal[1];
    if (dist < SHELL_TOL) return true;
  }
  return false;
}

/**
 * Points of the cloud covered by a mask in one frame. `pix` comes from visiblePixels for the same camera; the
 * mask may be at a different resolution than the camera (frames are uploaded larger than MapAnything's input)
 * and is mapped by scaling widths and centring heights, matching MapAnything's resize-then-centre-crop.
 */
export function maskPoints(pix: Int32Array, cam: LiftCamera, mask: LiftMask, keep?: (i: number) => boolean): number[] {
  const s = mask.width / cam.width;
  const oy = (mask.height - cam.height * s) / 2;
  const out: number[] = [];
  for (let i = 0; i < pix.length; i++) {
    if (pix[i] < 0) continue;
    const u = pix[i] % cam.width, v = Math.floor(pix[i] / cam.width);
    const mu = Math.floor((u + 0.5) * s), mv = Math.floor((v + 0.5) * s + oy);
    if (mu < 0 || mv < 0 || mu >= mask.width || mv >= mask.height) continue;
    if (mask.raster[mv * mask.width + mu] && (!keep || keep(i))) out.push(i);
  }
  return out;
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

/**
 * Robust oriented box around room-frame points. Yaw is the angle whose bounding rectangle on the floor is
 * smallest (a scan usually sees only one or two sides of an object, so a principal-axis fit leans); the
 * room's own axes win unless a turned rectangle is clearly tighter. Extents come from the 2nd–98th
 * percentiles, and objects that come within 15 cm of the floor are grounded on it.
 */
export function boxOfPoints(pts: [number, number, number][]): ObjectBox | null {
  if (pts.length < 12) return null;
  const extents = (a: number, list: [number, number, number][]) => {
    const c = Math.cos(a), s = Math.sin(a);
    const us: number[] = [], vs: number[] = [];
    for (const p of list) {
      us.push(p[0] * c + p[2] * s);
      vs.push(-p[0] * s + p[2] * c);
    }
    us.sort((x, y) => x - y);
    vs.sort((x, y) => x - y);
    return { u0: quantile(us, 0.02), u1: quantile(us, 0.98), v0: quantile(vs, 0.02), v1: quantile(vs, 0.98) };
  };
  const area = (e: ReturnType<typeof extents>) => (e.u1 - e.u0) * (e.v1 - e.v0);
  const sample = pts.length > 4000 ? pts.filter((_, i) => i % Math.ceil(pts.length / 4000) === 0) : pts;
  let yaw = 0;
  const axis = area(extents(0, sample));
  let best = axis * 0.85;
  for (let deg = 3; deg < 90; deg += 3) {
    const a = area(extents((deg * Math.PI) / 180, sample));
    if (a < best) (best = a), (yaw = (deg * Math.PI) / 180);
  }
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const e = extents(yaw, pts);
  const ys = pts.map((p) => p[1]).sort((x, y) => x - y);
  let [y0, y1] = [quantile(ys, 0.02), quantile(ys, 0.98)];
  if (y0 < 0.15) y0 = 0;
  const cu = (e.u0 + e.u1) / 2, cv = (e.v0 + e.v1) / 2;
  const w = Math.max(0.05, e.u1 - e.u0), d = Math.max(0.05, e.v1 - e.v0), h = Math.max(0.05, y1 - y0);
  // Local axis u = (c, 0, s); three.js rotation.y = θ turns local +x to (cos θ, 0, -sin θ), so θ = -yaw.
  return {
    centre: [cu * c - cv * s, (y0 + y1) / 2, cu * s + cv * c],
    size: [w, h, d],
    yaw: -yaw,
  };
}

export interface MergedObject {
  label: string;
  points: number[];
  detections: LiftedDetection[];
}

/** Merge detections of the same label that share at least `minShare` of the smaller point set. */
export function mergeDetections(dets: LiftedDetection[], minShare = 0.25): MergedObject[] {
  const groups: { label: string; set: Set<number>; detections: LiftedDetection[] }[] = [];
  const norm = (l: string) => l.trim().toLowerCase();
  for (const d of [...dets].sort((a, b) => b.points.length - a.points.length)) {
    let best: (typeof groups)[number] | null = null;
    let bestShare = minShare;
    for (const g of groups) {
      if (norm(g.label) !== norm(d.label)) continue;
      let shared = 0;
      for (const i of d.points) if (g.set.has(i)) shared++;
      const share = shared / Math.max(1, Math.min(d.points.length, g.set.size));
      if (share >= bestShare) (best = g), (bestShare = share);
    }
    if (best) {
      for (const i of d.points) best.set.add(i);
      best.detections.push(d);
    } else groups.push({ label: d.label, set: new Set(d.points), detections: [d] });
  }
  return groups.map((g) => ({ label: g.label, points: [...g.set], detections: g.detections }));
}

/** Local coordinates of a room-frame point in a box's frame (three.js yaw). */
function toLocal(box: ObjectBox, p: readonly number[]): [number, number, number] {
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
  const dx = p[0] - box.centre[0], dz = p[2] - box.centre[2];
  return [dx * c - dz * s, p[1] - box.centre[1], dx * s + dz * c];
}

/** True when `p` lies inside `box` grown by `margin` metres on every side. */
export function insideBox(box: ObjectBox, p: readonly number[], margin = 0): boolean {
  const l = toLocal(box, p);
  return Math.abs(l[0]) <= box.size[0] / 2 + margin && Math.abs(l[1]) <= box.size[1] / 2 + margin && Math.abs(l[2]) <= box.size[2] / 2 + margin;
}

export type BoxedObject = MergedObject & { box: ObjectBox };

/**
 * Second pass over merged objects, largest first. A smaller object is folded into a larger one when
 *  - most of its points are the larger one's, whatever the label (SAM found one thing as "nightstand" and
 *    "side table"; the larger object's label wins), or
 *  - it has the same label and sits inside the larger one's box (a pillow found as a second "bed").
 * Then objects with fewer than `minPoints` points are dropped as noise.
 */
export function consolidateObjects(objs: MergedObject[], boxOf: (points: number[]) => ObjectBox | null, opts: { share?: number; margin?: number; minPoints?: number } = {}): BoxedObject[] {
  const share = opts.share ?? 0.5, margin = opts.margin ?? 0.25, minPoints = opts.minPoints ?? 120;
  const norm = (l: string) => l.trim().toLowerCase();
  const kept: (BoxedObject & { set: Set<number> })[] = [];
  for (const o of [...objs].sort((a, b) => b.points.length - a.points.length)) {
    const box = boxOf(o.points);
    if (!box) continue;
    const host = kept.find((k) => {
      let n = 0;
      for (const i of o.points) if (k.set.has(i)) n++;
      if (n / Math.max(1, Math.min(o.points.length, k.set.size)) >= share) return true;
      return norm(k.label) === norm(o.label) && insideBox(k.box, box.centre, margin);
    });
    if (!host) {
      kept.push({ ...o, box, set: new Set(o.points) });
      continue;
    }
    for (const i of o.points) host.set.add(i);
    host.points = [...host.set];
    host.detections = [...host.detections, ...o.detections];
    host.box = boxOf(host.points) ?? host.box;
  }
  return kept.filter((k) => k.points.length >= minPoints).map(({ set: _set, ...k }) => k);
}

/**
 * A scan often sees tall furniture (a wardrobe, a bookcase) only from the front, so its box comes out as
 * thin as card. For grounded objects taller than 40 cm with one floor side under `thin`, push the back
 * face away from the camera that saw it: to the wall behind when one is within `maxDepth`, otherwise to
 * `fallback` metres deep.
 */
export function thickenFlatBox(box: ObjectBox, shell: RoomShell | null, viewFrom: readonly [number, number], opts: { thin?: number; fallback?: number; maxDepth?: number } = {}): ObjectBox {
  const thin = opts.thin ?? 0.15, fallback = opts.fallback ?? 0.45, maxDepth = opts.maxDepth ?? 1;
  const [w, h, d] = box.size;
  const grounded = box.centre[1] - h / 2 < 0.02;
  const axis = w < d ? 0 : 2;
  const t = Math.min(w, d), other = Math.max(w, d);
  if (!grounded || h < 0.4 || t >= thin || other < 2 * thin) return box;
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
  // Room-frame [x, z] of the thin local axis: local x → (cos, -sin), local z → (sin, cos).
  let n: [number, number] = axis === 0 ? [c, -s] : [s, c];
  if ((box.centre[0] - viewFrom[0]) * n[0] + (box.centre[2] - viewFrom[1]) * n[1] < 0) n = [-n[0], -n[1]];
  const front: [number, number] = [box.centre[0] - (n[0] * t) / 2, box.centre[2] - (n[1] * t) / 2];
  let toWall = Infinity;
  for (const wall of shell?.walls ?? []) {
    const facing = n[0] * wall.normal[0] + n[1] * wall.normal[1];
    if (facing > -0.9) continue; // only walls roughly square to the object, behind it
    const dist = ((front[0] - wall.a[0]) * wall.normal[0] + (front[1] - wall.a[1]) * wall.normal[1]) / -facing;
    if (dist > t) toWall = Math.min(toWall, dist);
  }
  const depth = toWall <= maxDepth ? toWall : fallback;
  const size: [number, number, number] = [...box.size];
  size[axis] = depth;
  return { ...box, size, centre: [front[0] + (n[0] * depth) / 2, box.centre[1], front[1] + (n[1] * depth) / 2] };
}

/** The detection whose crop shows the object best: big, confident and not cut off by the frame edge. */
export function bestView(dets: LiftedDetection[]): LiftedDetection {
  const score = (d: LiftedDetection) => Math.sqrt(d.area) * (0.5 + 0.5 * d.score) * (1 - 0.8 * d.edge);
  return dets.reduce((a, b) => (score(b) > score(a) ? b : a));
}

/** Points of the cloud (scan frame) in the room frame, as an accessor. */
export function roomPoint(positions: Float32Array, alignment: number[], i: number): [number, number, number] {
  return transformPointRowMajor(alignment, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
}
