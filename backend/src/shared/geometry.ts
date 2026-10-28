/**
 * Deterministic plan → structure conversion. AI output (plan-pixel polygons,
 * dimension labels, openings) goes in; meters, walls with real door gaps and
 * validated rooms come out. Nothing here calls a model.
 */
import type {
  FloorplanInterpretation,
  Level,
  Opening,
  OpeningType,
  Room,
  ScaleEstimate,
  Structure,
  Vec2,
  Wall,
} from './schemas.js';

export const DEFAULT_CEILING_M = 2.4;
export const SLAB_THICKNESS_M = 0.2;
export const WALL_THICKNESS_M = 0.1;

const OPENING_DIMENSIONS: Record<OpeningType, { heightM: number; sillM: number }> = {
  door: { heightM: 2.0, sillM: 0 },
  archway: { heightM: 2.1, sillM: 0 },
  window: { heightM: 1.2, sillM: 0.9 },
  stairs: { heightM: 0, sillM: 0 },
};

// ---------------------------------------------------------------------------
// Polygon helpers
// ---------------------------------------------------------------------------

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

export function bounds(points: Vec2[]): { min: Vec2; max: Vec2 } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function distPointSegment(p: Vec2, a: Vec2, b: Vec2): { dist: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return { dist: Math.hypot(p[0] - cx, p[1] - cy), t };
}

export function segLength(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** True when two segments properly cross (shared endpoints don't count). */
export function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < -1e-9 && d3 * d4 < -1e-9;
}

export function polygonSelfIntersects(poly: Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** Approximate interior overlap of two polygons by grid sampling (meters). */
export function polygonOverlapArea(a: Vec2[], b: Vec2[], step = 0.1): number {
  const ba = bounds(a);
  const bb = bounds(b);
  const minX = Math.max(ba.min[0], bb.min[0]);
  const minY = Math.max(ba.min[1], bb.min[1]);
  const maxX = Math.min(ba.max[0], bb.max[0]);
  const maxY = Math.min(ba.max[1], bb.max[1]);
  if (maxX <= minX || maxY <= minY) return 0;
  let hits = 0;
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      if (pointInPolygon([x, y], a) && pointInPolygon([x, y], b)) hits++;
    }
  }
  return hits * step * step;
}

/** Interior point far from the edges (grid search). Used for safe spawn points. */
export function interiorPoint(poly: Vec2[]): Vec2 {
  const b = bounds(poly);
  let best: Vec2 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
  let bestD = -Infinity;
  const steps = 24;
  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      const p: Vec2 = [
        b.min[0] + ((b.max[0] - b.min[0]) * i) / steps,
        b.min[1] + ((b.max[1] - b.min[1]) * j) / steps,
      ];
      if (!pointInPolygon(p, poly)) continue;
      let d = Infinity;
      for (let k = 0; k < poly.length; k++) d = Math.min(d, distPointSegment(p, poly[k], poly[(k + 1) % poly.length]).dist);
      if (d > bestD + 1e-6) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}

const round = (v: number, step = 0.01) => Math.round(v / step) * step;
const snap = (p: Vec2): Vec2 => [round(p[0]), round(p[1])];

/**
 * Model-read polygons carry a few centimetres of noise, so walls that should
 * be shared don't line up exactly. Cluster X values and Z values separately
 * (within tol) and replace each by its cluster mean. On orthogonal plans this
 * restores shared edges; on angled walls it only merges near-equal values.
 */
export function alignAxes(polys: Vec2[][], tol = 0.08): Vec2[][] {
  const remap = (values: number[]) => {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    const map = new Map<number, number>();
    let cluster: number[] = [];
    const flush = () => {
      const mean = round(cluster.reduce((a, b) => a + b, 0) / cluster.length);
      for (const v of cluster) map.set(v, mean);
      cluster = [];
    };
    for (const v of sorted) {
      if (cluster.length && v - cluster[0] > tol) flush();
      cluster.push(v);
    }
    if (cluster.length) flush();
    return map;
  };
  const xs = remap(polys.flatMap((p) => p.map((v) => v[0])));
  const ys = remap(polys.flatMap((p) => p.map((v) => v[1])));
  return polys.map((p) => p.map((v) => [xs.get(v[0])!, ys.get(v[1])!] as Vec2));
}

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

/**
 * Derive meters-per-pixel from dimension labels printed on the plan. Each
 * measured room contributes two samples (its bbox width and depth). Labels
 * do not say which axis is "width", so pair them in whichever orientation
 * disagrees least.
 */
export function estimateScale(
  interp: FloorplanInterpretation,
  override?: { metersPerPx: number; method: 'user-reference' | 'estimated-layout' },
): ScaleEstimate {
  if (override) {
    return { metersPerPx: override.metersPerPx, method: override.method, samples: 1, spreadPct: 0, estimated: override.method !== 'user-reference' };
  }
  const samples: number[] = [];
  for (const level of interp.levels) {
    for (const room of level.rooms) {
      if (!room.measured) continue;
      const b = bounds(room.polygonPx);
      const w = b.max[0] - b.min[0];
      const h = b.max[1] - b.min[1];
      if (w <= 0 || h <= 0) continue;
      const { widthM, depthM } = room.measured;
      const straight = [widthM / w, depthM / h];
      const swapped = [depthM / w, widthM / h];
      const disagreement = (s: number[]) => Math.abs(s[0] - s[1]) / ((s[0] + s[1]) / 2);
      samples.push(...(disagreement(straight) <= disagreement(swapped) ? straight : swapped));
    }
  }
  if (samples.length >= 2) {
    samples.sort((x, y) => x - y);
    const median = samples[Math.floor(samples.length / 2)];
    const spread = (samples[samples.length - 1] - samples[0]) / median;
    return {
      metersPerPx: median,
      method: 'dimension-labels',
      samples: samples.length,
      spreadPct: Math.round(spread * 1000) / 10,
      estimated: spread > 0.15,
    };
  }
  if (interp.statedTotalAreaSqM) {
    const px2 = interp.levels.reduce((s, l) => s + l.rooms.reduce((r, room) => r + polygonArea(room.polygonPx), 0), 0);
    return {
      metersPerPx: Math.sqrt(interp.statedTotalAreaSqM / px2),
      method: 'stated-area',
      samples: 1,
      spreadPct: 0,
      estimated: true,
    };
  }
  return { metersPerPx: 0.02, method: 'unknown-default', samples: 0, spreadPct: 0, estimated: true };
}

// ---------------------------------------------------------------------------
// Walls from room polygons
// ---------------------------------------------------------------------------

interface RawSeg {
  a: Vec2;
  b: Vec2;
  roomIds: Set<string>;
}

const keyOf = (p: Vec2) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
const segKey = (a: Vec2, b: Vec2) => {
  const ka = keyOf(a);
  const kb = keyOf(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

/**
 * Split every room edge at every vertex of every room on the level that lies
 * on it, so shared walls become identical elementary segments. Segments used
 * by two rooms are interior walls; by one room, exterior walls. Collinear
 * chains with the same rooms are merged back into single walls.
 */
export function deriveWalls(levelId: string, rooms: { id: string; polygon: Vec2[] }[], eps = 0.02): Wall[] {
  const allVerts = rooms.flatMap((r) => r.polygon);
  const segs = new Map<string, RawSeg>();
  for (const room of rooms) {
    const n = room.polygon.length;
    for (let i = 0; i < n; i++) {
      const a = room.polygon[i];
      const b = room.polygon[(i + 1) % n];
      const len = segLength(a, b);
      if (len < eps) continue;
      const ts = new Set<number>([0, 1]);
      for (const v of allVerts) {
        const { dist, t } = distPointSegment(v, a, b);
        if (dist < eps && t > 1e-6 && t < 1 - 1e-6) ts.add(round(t, 1e-6));
      }
      const sorted = [...ts].sort((x, y) => x - y);
      for (let k = 0; k < sorted.length - 1; k++) {
        const p = snap([a[0] + (b[0] - a[0]) * sorted[k], a[1] + (b[1] - a[1]) * sorted[k]]);
        const q = snap([a[0] + (b[0] - a[0]) * sorted[k + 1], a[1] + (b[1] - a[1]) * sorted[k + 1]]);
        if (segLength(p, q) < eps) continue;
        const key = segKey(p, q);
        const existing = segs.get(key);
        if (existing) existing.roomIds.add(room.id);
        else segs.set(key, { a: p, b: q, roomIds: new Set([room.id]) });
      }
    }
  }

  // Merge collinear chains through degree-2 vertices with identical room sets.
  const list = [...segs.values()];
  let merged = true;
  while (merged) {
    merged = false;
    const degree = new Map<string, number>();
    for (const s of list) {
      degree.set(keyOf(s.a), (degree.get(keyOf(s.a)) ?? 0) + 1);
      degree.set(keyOf(s.b), (degree.get(keyOf(s.b)) ?? 0) + 1);
    }
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = list[i];
        const t = list[j];
        if ([...s.roomIds].sort().join() !== [...t.roomIds].sort().join()) continue;
        const ends: [Vec2, Vec2, Vec2][] = [];
        if (keyOf(s.b) === keyOf(t.a)) ends.push([s.a, s.b, t.b]);
        else if (keyOf(s.b) === keyOf(t.b)) ends.push([s.a, s.b, t.a]);
        else if (keyOf(s.a) === keyOf(t.a)) ends.push([s.b, s.a, t.b]);
        else if (keyOf(s.a) === keyOf(t.b)) ends.push([s.b, s.a, t.a]);
        if (!ends.length) continue;
        const [p, mid, q] = ends[0];
        if (degree.get(keyOf(mid)) !== 2) continue;
        if (distPointSegment(mid, p, q).dist > 1e-3) continue;
        list.splice(j, 1);
        list[i] = { a: p, b: q, roomIds: s.roomIds };
        merged = true;
        break outer;
      }
    }
  }

  list.sort((s, t) => keyOf(s.a).localeCompare(keyOf(t.a)) || keyOf(s.b).localeCompare(keyOf(t.b)));
  return list.map((s, i) => ({
    id: `${levelId}-w${i}`,
    levelId,
    a: s.a,
    b: s.b,
    exterior: s.roomIds.size === 1,
    roomIds: [...s.roomIds].sort(),
    openingIds: [],
  }));
}

/** Solid wall pieces along a wall after carving openings (local wall coords). */
export interface WallPiece {
  s0: number;
  s1: number;
  y0: number;
  y1: number;
}

export function wallPieces(wall: Wall, openings: Opening[], height: number): WallPiece[] {
  const len = segLength(wall.a, wall.b);
  const own = openings
    .filter((o) => o.parentWallId === wall.id && o.type !== 'stairs')
    .map((o) => ({
      s0: Math.max(0, o.offsetAlongWall - o.widthM / 2),
      s1: Math.min(len, o.offsetAlongWall + o.widthM / 2),
      sill: o.sillM,
      head: Math.min(height, o.sillM + o.heightM),
    }))
    .sort((x, y) => x.s0 - y.s0);
  const pieces: WallPiece[] = [];
  let cursor = 0;
  for (const o of own) {
    if (o.s0 > cursor + 1e-3) pieces.push({ s0: cursor, s1: o.s0, y0: 0, y1: height });
    if (o.sill > 1e-3) pieces.push({ s0: o.s0, s1: o.s1, y0: 0, y1: o.sill });
    if (o.head < height - 1e-3) pieces.push({ s0: o.s0, s1: o.s1, y0: o.head, y1: height });
    cursor = Math.max(cursor, o.s1);
  }
  if (cursor < len - 1e-3) pieces.push({ s0: cursor, s1: len, y0: 0, y1: height });
  return pieces;
}

/** 2D segments that block a walking person (body spans ~0.3–1.7 m). */
export function blockingSegments(structure: Structure, levelId: string): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  const level = structure.levels.find((l) => l.id === levelId);
  if (!level) return out;
  for (const wall of structure.walls.filter((w) => w.levelId === levelId)) {
    const len = segLength(wall.a, wall.b);
    const dir: Vec2 = [(wall.b[0] - wall.a[0]) / len, (wall.b[1] - wall.a[1]) / len];
    for (const p of wallPieces(wall, structure.openings, level.heightMeters)) {
      if (p.y0 > 1.7 || p.y1 < 0.3) continue;
      out.push([
        [wall.a[0] + dir[0] * p.s0, wall.a[1] + dir[1] * p.s0],
        [wall.a[0] + dir[0] * p.s1, wall.a[1] + dir[1] * p.s1],
      ]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interpretation → Structure
// ---------------------------------------------------------------------------

export interface BuildOptions {
  propertyId: string;
  defaultCeilingM?: number;
  scaleOverride?: { metersPerPx: number; method: 'user-reference' | 'estimated-layout' };
  roomLabelOverrides?: Record<string, string>;
  uncertainRoomIds?: string[];
}

export function buildStructure(interp: FloorplanInterpretation, opts: BuildOptions): Structure {
  const scale = estimateScale(interp, opts.scaleOverride);
  const mpp = scale.metersPerPx;
  const levels: Level[] = [];
  const rooms: Room[] = [];
  const walls: Wall[] = [];
  const openings: Opening[] = [];
  const allPts: Vec2[] = [];

  const sortedLevels = [...interp.levels].sort((a, b) => a.index - b.index);
  let elevation = 0;
  // Each level's plan may be a separate image; align levels by their own
  // footprint top-left. This is an assumption and is reported as such.
  const toMeters = (origin: Vec2) => (p: Vec2): Vec2 => snap([(p[0] - origin[0]) * mpp, (p[1] - origin[1]) * mpp]);
  const levelOrigins = new Map<string, Vec2>();
  for (const pl of sortedLevels) levelOrigins.set(pl.id, bounds(pl.rooms.flatMap((r) => r.polygonPx)).min);

  for (const pl of sortedLevels) {
    const conv = toMeters(levelOrigins.get(pl.id)!);
    const heightEstimated = pl.ceilingHeightMeters == null;
    const height = pl.ceilingHeightMeters ?? opts.defaultCeilingM ?? DEFAULT_CEILING_M;

    const aligned = alignAxes(pl.rooms.map((r) => r.polygonPx.map(conv)));
    const lvlRooms = pl.rooms.map((r, i) => ({ src: r, polygon: aligned[i] }));
    const lvlWalls = deriveWalls(
      pl.id,
      lvlRooms.map((r) => ({ id: r.src.id, polygon: r.polygon })),
    );

    const stairVoids: Vec2[][] = [];
    for (const below of sortedLevels) {
      for (const st of below.stairs) {
        if (st.toLevelId === pl.id) stairVoids.push(st.polygonPx.map(toMeters(levelOrigins.get(below.id)!)));
      }
    }

    levels.push({
      id: pl.id,
      propertyId: opts.propertyId,
      index: pl.index,
      name: pl.name,
      elevationMeters: round(elevation),
      heightMeters: height,
      heightEstimated,
      originalPlanMediaId: pl.planMediaId,
      stairVoids,
      confidence: Math.min(...pl.rooms.map((r) => r.confidence)),
    });
    elevation += height + SLAB_THICKNESS_M;

    for (const op of pl.openings) {
      if (op.type === 'stairs') continue;
      const at = conv(op.atPx);
      const width = op.widthPx * mpp;
      let best: { wall: Wall; dist: number; t: number } | null = null;
      for (const w of lvlWalls) {
        const { dist, t } = distPointSegment(at, w.a, w.b);
        if (!best || dist < best.dist) best = { wall: w, dist, t };
      }
      const dims = OPENING_DIMENSIONS[op.type];
      let parentWallId: string | null = null;
      let offset = 0;
      if (best && best.dist < 0.3) {
        const len = segLength(best.wall.a, best.wall.b);
        const fitWidth = Math.min(width, len - 0.05);
        offset = Math.max(fitWidth / 2, Math.min(len - fitWidth / 2, best.t * len));
        parentWallId = best.wall.id;
        best.wall.openingIds.push(op.id);
      }
      openings.push({
        id: op.id,
        levelId: pl.id,
        roomIds: op.roomIds.length ? op.roomIds : best?.wall.roomIds ?? [],
        type: op.type,
        parentWallId,
        offsetAlongWall: round(offset),
        position: at,
        widthM: round(Math.min(width, best ? segLength(best.wall.a, best.wall.b) - 0.05 : width)),
        heightM: dims.heightM,
        sillM: dims.sillM,
        confidence: op.confidence,
      });
    }

    for (const r of lvlRooms) {
      const roomOpenings = openings.filter((o) => o.levelId === pl.id && o.roomIds.includes(r.src.id));
      const label = opts.roomLabelOverrides?.[r.src.id] ?? r.src.label;
      rooms.push({
        id: r.src.id,
        levelId: pl.id,
        label,
        type: r.src.type,
        polygonXZMeters: r.polygon,
        areaSqM: round(polygonArea(r.polygon)),
        ceilingHeightMeters: height,
        doorIds: roomOpenings.filter((o) => o.type === 'door' || o.type === 'archway').map((o) => o.id),
        windowIds: roomOpenings.filter((o) => o.type === 'window').map((o) => o.id),
        linkedMediaIds: [],
        confidence: r.src.confidence,
        isEstimated: !r.src.measured || scale.estimated || (opts.uncertainRoomIds ?? []).includes(r.src.id),
        dimensionsMeasured: !!r.src.measured,
        spawnPoint: snap(interiorPoint(r.polygon)),
      });
      allPts.push(...r.polygon);
    }
    walls.push(...lvlWalls);
  }

  return { scale, levels, rooms, walls, openings, footprintBounds: bounds(allPts) };
}
