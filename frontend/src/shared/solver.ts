/**
 * Evidence-driven layout for a single-storey home without a floor plan.
 *
 * The footprint is the real building outline when we have one (OpenStreetMap,
 * see providers/footprint.ts), otherwise a rectangle sized from the stated
 * area. Front (street side) is the bottom of the plan (largest z).
 *
 * Rooms are placed by searching thousands of "slicing" arrangements: the
 * outline's bounding box is cut recursively, each cut positioned so that each
 * side gets its rooms' share of the REAL floor area inside the outline, and
 * each room is its cell clipped to the outline (so L-shaped houses get
 * L-shaped or notched rooms where the outline demands). The arrangement that
 * best fits what the photos show wins:
 *   - rooms that open into each other share a wall (open-plan: a wide one)
 *   - the entrance room is on the front
 *   - rooms seen on the front/rear/left/right sit on that side
 *   - corner rooms (windows on two walls) have two outside walls
 *   - bedrooms, living rooms and kitchens have an outside wall (windows)
 *   - every room is reachable, not only through a bedroom or the kitchen
 *   - room shapes and sizes match what the photos suggest
 * Doors come from the stated connections first, then the most natural
 * neighbour (hall, then living spaces) for anything still unreachable.
 *
 * Deterministic (seeded by the room list). The result is still an ESTIMATE
 * and is flagged as such downstream.
 */
import type { FloorplanInterpretation, PlanOpening, PlanRoom, Provenance, RoomType, Vec2 } from './schemas.js';
import type { LayoutHints, RoomSpec } from './layout.js';

interface Cell {
  i: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}
interface R extends Cell {
  spec: RoomSpec;
  poly: Vec2[];
  area: number;
}

const PX = 100;
const EPS = 0.02;
const HABITABLE: RoomType[] = ['living', 'kitchen', 'dining', 'bedroom', 'study'];
const HUB: RoomType[] = ['hall', 'landing', 'living', 'dining', 'kitchen'];
const MIN_SIDE: Partial<Record<RoomType, number>> = { bedroom: 2.4, living: 3.0, kitchen: 2.1, dining: 2.4, bathroom: 1.5, wc: 0.9, hall: 0.9, landing: 0.9, study: 1.8, utility: 1.2 };

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
const norm = (s: string) => s.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Polygon helpers
// ---------------------------------------------------------------------------
export function ringArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return Math.abs(a) / 2;
}

/** Sutherland–Hodgman: subject polygon (may be concave) clipped to an axis-aligned rectangle. */
export function clipToRect(poly: Vec2[], x0: number, z0: number, x1: number, z1: number): Vec2[] {
  const edges: [(p: Vec2) => boolean, (a: Vec2, b: Vec2) => Vec2][] = [
    [(p) => p[0] >= x0 - 1e-9, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1 + 1e-9, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= z0 - 1e-9, (a, b) => [a[0] + ((b[0] - a[0]) * (z0 - a[1])) / (b[1] - a[1]), z0]],
    [(p) => p[1] <= z1 + 1e-9, (a, b) => [a[0] + ((b[0] - a[0]) * (z1 - a[1])) / (b[1] - a[1]), z1]],
  ];
  let out = poly;
  for (const [ins, cut] of edges) {
    if (!out.length) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i - 1 + input.length) % input.length];
      if (ins(cur)) {
        if (!ins(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (ins(prev)) out.push(cut(prev, cur));
    }
  }
  // Tidy: drop repeated and collinear points.
  const r = out.map(([x, z]) => [Math.round(x * 1000) / 1000, Math.round(z * 1000) / 1000] as Vec2).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  return r.filter((p, i) => {
    const a = r[(i - 1 + r.length) % r.length];
    const c = r[(i + 1) % r.length];
    return Math.abs((p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1])) > 1e-6;
  });
}

function pointIn(p: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Shared wall between two rooms (from their cells), only the part inside the outline. */
function sharedEdge(a: R, b: R, outline: Vec2[] | null): { len: number; at: [number, number] } | null {
  let seg: [Vec2, Vec2] | null = null;
  if (Math.abs(a.x1 - b.x0) < EPS || Math.abs(b.x1 - a.x0) < EPS) {
    const x = Math.abs(a.x1 - b.x0) < EPS ? a.x1 : a.x0;
    const lo = Math.max(a.z0, b.z0);
    const hi = Math.min(a.z1, b.z1);
    if (hi - lo > EPS) seg = [[x, lo], [x, hi]];
  } else if (Math.abs(a.z1 - b.z0) < EPS || Math.abs(b.z1 - a.z0) < EPS) {
    const z = Math.abs(a.z1 - b.z0) < EPS ? a.z1 : a.z0;
    const lo = Math.max(a.x0, b.x0);
    const hi = Math.min(a.x1, b.x1);
    if (hi - lo > EPS) seg = [[lo, z], [hi, z]];
  }
  if (!seg) return null;
  const L = Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]);
  if (!outline) return { len: L, at: [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2] };
  // Keep the longest run of the segment that lies inside the outline.
  const N = 24;
  let best: [number, number] | null = null;
  let runStart = -1;
  for (let k = 0; k <= N; k++) {
    const t = (k + 0.5) / (N + 1);
    const p: Vec2 = [seg[0][0] + (seg[1][0] - seg[0][0]) * t, seg[0][1] + (seg[1][1] - seg[0][1]) * t];
    const ok = k < N && pointIn(p, outline);
    if (ok && runStart < 0) runStart = k;
    if (!ok && runStart >= 0) {
      if (!best || k - runStart > best[1] - best[0]) best = [runStart, k];
      runStart = -1;
    }
  }
  if (!best) return null;
  const t0 = best[0] / N;
  const t1 = best[1] / N;
  const len = L * (t1 - t0);
  if (len < EPS) return null;
  const tm = (t0 + t1) / 2;
  return { len, at: [seg[0][0] + (seg[1][0] - seg[0][0]) * tm, seg[0][1] + (seg[1][1] - seg[0][1]) * tm] };
}

type Side = 'front' | 'rear' | 'left' | 'right';
interface ExtEdge {
  side: Side;
  a: Vec2;
  b: Vec2;
  len: number;
}

/** A room's outside walls: its edges that lie on the outline, with the side they face. */
function outsideEdges(r: R, outline: Vec2[]): ExtEdge[] {
  const out: ExtEdge[] = [];
  const onOutline = (p: Vec2) => outline.some((q, i) => {
    const s = outline[(i + 1) % outline.length];
    const dx = s[0] - q[0];
    const dz = s[1] - q[1];
    const L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dz) / L2));
    return Math.hypot(p[0] - (q[0] + t * dx), p[1] - (q[1] + t * dz)) < 0.03;
  });
  const c: Vec2 = [r.poly.reduce((a, p) => a + p[0], 0) / r.poly.length, r.poly.reduce((a, p) => a + p[1], 0) / r.poly.length];
  for (let i = 0; i < r.poly.length; i++) {
    const a = r.poly[i];
    const b = r.poly[(i + 1) % r.poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.3) continue;
    const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!onOutline(m)) continue;
    // Outward normal: away from the room's centre.
    const nx = m[0] - c[0];
    const nz = m[1] - c[1];
    const horizontal = Math.abs(b[1] - a[1]) < Math.abs(b[0] - a[0]);
    const side: Side = horizontal ? (nz > 0 ? 'front' : 'rear') : nx > 0 ? 'right' : 'left';
    out.push({ side, a, b, len });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Cut the box recursively into one cell per room; each cut balances the real (in-outline) area. */
function slice(items: { i: number; area: number }[], x0: number, z0: number, x1: number, z1: number, rand: () => number, outline: Vec2[] | null, out: Cell[]) {
  if (items.length === 1) return void out.push({ i: items[0].i, x0, z0, x1, z1 });
  const order = [...items];
  for (let k = order.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [order[k], order[j]] = [order[j], order[k]];
  }
  const total = order.reduce((s, r) => s + r.area, 0);
  let k = 1;
  let acc = order[0].area;
  const want = total * (0.3 + rand() * 0.4);
  while (k < order.length - 1 && acc + order[k].area / 2 < want) acc += order[k++].area;
  const a = order.slice(0, k);
  const b = order.slice(k);
  const fa = a.reduce((s, r) => s + r.area, 0) / total;
  const w = x1 - x0;
  const d = z1 - z0;
  const vertical = rand() < (w >= d ? 0.78 : 0.22); // usually cut across the long side
  // Where to cut so side A holds fraction fa of the floor actually inside the outline.
  const cutAt = (lo: number, hi: number, part: (m: number) => number, whole: number) => {
    if (!outline) return lo + (hi - lo) * fa;
    let l = lo;
    let h = hi;
    for (let it = 0; it < 18; it++) {
      const m = (l + h) / 2;
      if (part(m) / (whole || 1) < fa) l = m;
      else h = m;
    }
    return (l + h) / 2;
  };
  const inArea = (ax0: number, az0: number, ax1: number, az1: number) => (outline ? ringArea(clipToRect(outline, ax0, az0, ax1, az1)) : (ax1 - ax0) * (az1 - az0));
  const whole = inArea(x0, z0, x1, z1);
  if (vertical) {
    const xm = cutAt(x0, x1, (m) => inArea(x0, z0, m, z1), whole);
    slice(a, x0, z0, xm, z1, rand, outline, out);
    slice(b, xm, z0, x1, z1, rand, outline, out);
  } else {
    const zm = cutAt(z0, z1, (m) => inArea(x0, z0, x1, m), whole);
    slice(a, x0, z0, x1, zm, rand, outline, out);
    slice(b, x0, zm, x1, z1, rand, outline, out);
  }
}

interface Door {
  a: number;
  b: number;
  kind: 'door' | 'open';
  at: [number, number];
  len: number;
  stated: boolean;
}

/** Doors for an arrangement + a penalty for poor access. */
function connect(rs: R[], specs: RoomSpec[], entrance: number, outline: Vec2[] | null): { doors: Door[]; penalty: number; unmet: number } {
  const byLabel = new Map(specs.map((s, i) => [norm(s.label), i]));
  const doors: Door[] = [];
  let unmet = 0;
  const has = (a: number, b: number) => doors.some((d) => (d.a === a && d.b === b) || (d.a === b && d.b === a));
  for (const [i, s] of specs.entries()) {
    for (const c of s.connectsTo ?? []) {
      const j = byLabel.get(norm(c.label));
      if (j == null || j === i || has(i, j)) continue;
      const e = sharedEdge(rs[i], rs[j], outline);
      const need = c.kind === 'open' ? 1.4 : 0.9;
      if (!e || e.len < need) {
        unmet++;
        continue;
      }
      doors.push({ a: i, b: j, kind: c.kind, at: e.at, len: e.len, stated: true });
    }
  }
  let penalty = 0;
  for (let guard = 0; guard < rs.length; guard++) {
    const seen = new Set([entrance]);
    const q = [entrance];
    while (q.length) {
      const c = q.shift()!;
      for (const d of doors) {
        const n = d.a === c ? d.b : d.b === c ? d.a : -1;
        if (n >= 0 && !seen.has(n)) {
          seen.add(n);
          q.push(n);
        }
      }
    }
    const missing = rs.map((_, i) => i).filter((i) => !seen.has(i));
    if (!missing.length) break;
    let best: { i: number; j: number; e: { len: number; at: [number, number] }; score: number } | null = null;
    for (const i of missing) {
      for (const j of seen) {
        const e = sharedEdge(rs[i], rs[j], outline);
        if (!e || e.len < 0.9) continue;
        const t = specs[j].type;
        const ensuite = specs[i].type === 'bathroom' && /en-?suite/i.test(specs[i].label);
        const privateRoom = ['bedroom', 'bathroom', 'wc'].includes(specs[i].type);
        // Bedrooms and bathrooms open off a hall or living space, not the kitchen, when there is a choice.
        const score = (t === 'hall' || t === 'landing' ? 3 : t === 'kitchen' && privateRoom ? 0.5 : HUB.includes(t) ? 2 : t === 'bedroom' && ensuite ? 2 : 0) + Math.min(e.len, 3) / 10;
        if (!best || score > best.score) best = { i, j, e, score };
      }
    }
    if (!best) {
      penalty += 60 * missing.length; // cannot be reached at all
      break;
    }
    const viaPrivate = !HUB.includes(specs[best.j].type) && !(specs[best.i].type === 'bathroom' && /en-?suite/i.test(specs[best.i].label));
    if (viaPrivate) penalty += 18;
    else if (specs[best.j].type === 'kitchen' && ['bedroom', 'bathroom', 'wc'].includes(specs[best.i].type)) penalty += 10;
    doors.push({ a: best.i, b: best.j, kind: 'door', at: best.e.at, len: best.e.len, stated: false });
  }
  return { doors, penalty, unmet };
}

function score(rs: R[], specs: RoomSpec[], outline: Vec2[], hasOutline: boolean, entrance: number): number {
  let cost = 0;
  for (const r of rs) {
    const s = r.spec;
    if (r.poly.length < 3 || r.area < 1) return 1e6; // a room squeezed out of the outline
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    const asp = Math.max(w / d, d / w);
    const target = s.widthM && s.depthM ? Math.max(s.widthM / s.depthM, s.depthM / s.widthM) : s.type === 'hall' || s.type === 'landing' ? 3.5 : s.type === 'living' ? 1.5 : 1.3;
    cost += 4 * Math.abs(Math.log(asp / target));
    const min = MIN_SIDE[s.type] ?? 1.5;
    if (Math.min(w, d) < min) cost += 25 * (min - Math.min(w, d));
    if (hasOutline) {
      // The real outline can carve a room: penalise rooms that lost much of their area or became ragged.
      cost += 10 * Math.abs(Math.log(r.area / s.areaM2));
      if (r.poly.length > 6) cost += 3 * (r.poly.length - 6);
    }
    const ext = outsideEdges(r, outline);
    const sides = new Set(ext.map((e) => e.side));
    if (s.side && s.side !== 'unknown' && !sides.has(s.side)) cost += 30;
    if (s.entrance && !sides.has('front')) cost += 45;
    if (s.exteriorWalls && sides.size < s.exteriorWalls) cost += 18 * (s.exteriorWalls - sides.size);
    if (HABITABLE.includes(s.type) && !ext.length) cost += 35;
    if ((s.type === 'bathroom' || s.type === 'wc') && sides.has('front') && s.side !== 'front') cost += 5;
  }
  const { penalty, unmet } = connect(rs, specs, entrance, hasOutline ? outline : null);
  return cost + penalty + 40 * unmet;
}

/** Solve one floor. Returns an interpretation in plan pixels (1 px = 1 cm) like the plan reader's. */
export function solveSingleStoreyLayout(input: {
  rooms: RoomSpec[];
  hints?: LayoutHints;
  /** The real building outline (metres, front at max z), e.g. from OpenStreetMap. */
  footprint?: Vec2[] | null;
  statedTotalAreaSqM: number | null;
  provenance: Provenance;
  uncertainties?: string[];
  confidence: number;
  layoutSource?: 'photos' | 'listing-details';
  iterations?: number;
}): FloorplanInterpretation & { score: number } {
  let specs = input.rooms.filter((r) => r.areaM2 > 0.5).map((r) => ({ ...r, level: 0 }));
  const hasHall = specs.some((r) => r.type === 'hall' || r.type === 'landing');
  const wantHall = input.hints?.hallway ?? (specs.filter((r) => r.type === 'bedroom' || r.type === 'bathroom').length >= 3 && !specs.some((r) => r.connectsTo?.length));
  if (!hasHall && wantHall) specs.push({ label: 'Hallway', type: 'hall', areaM2: Math.max(3.5, specs.reduce((a, r) => a + r.areaM2, 0) * 0.06), level: 0 });
  specs = specs.map((r) => (r.widthM && r.depthM ? { ...r, areaM2: r.widthM * r.depthM } : r));

  // Footprint: the real outline if given, else a rectangle sized from the room areas.
  const fp = input.footprint && input.footprint.length >= 4 && ringArea(input.footprint) > 15 ? input.footprint : null;
  let outline: Vec2[];
  if (fp) {
    outline = fp;
    // Rooms share the real floor area (minus ~8% for walls) in proportion to their estimated sizes.
    const k = (ringArea(fp) * 0.92) / specs.reduce((a, r) => a + r.areaM2, 0);
    specs = specs.map((r) => ({ ...r, areaM2: r.areaM2 * k }));
  } else {
    const total = specs.reduce((a, r) => a + r.areaM2, 0);
    const aspect = Math.min(2.5, Math.max(0.6, input.hints?.aspect ?? 1.3));
    const W = Math.sqrt(total * aspect);
    const D = total / W;
    outline = [[0, 0], [W, 0], [W, D], [0, D]];
  }
  const W = Math.max(...outline.map((p) => p[0]));
  const D = Math.max(...outline.map((p) => p[1]));
  const entrance = Math.max(
    0,
    specs.findIndex((r) => r.entrance) >= 0 ? specs.findIndex((r) => r.entrance) : specs.findIndex((r) => r.type === 'hall') >= 0 ? specs.findIndex((r) => r.type === 'hall') : specs.findIndex((r) => r.type === 'living'),
  );
  const rand = rng(hash(specs.map((s) => `${s.label}:${Math.round(s.areaM2 * 10)}`).join('|') + (fp ? `|${fp.length}` : '')));
  const items = specs.map((s, i) => ({ i, area: s.areaM2 }));
  const build = (cells: Cell[]): R[] =>
    cells
      .sort((a, b) => a.i - b.i)
      .map((c) => {
        const poly = fp ? clipToRect(fp, c.x0, c.z0, c.x1, c.z1) : [[c.x0, c.z0], [c.x1, c.z0], [c.x1, c.z1], [c.x0, c.z1]] as Vec2[];
        return { ...c, spec: specs[c.i], poly, area: ringArea(poly) };
      });
  let best: { rs: R[]; cost: number } | null = null;
  for (let it = 0; it < (input.iterations ?? (fp ? 2500 : 6000)); it++) {
    const cells: Cell[] = [];
    slice(items, 0, 0, W, D, rand, fp, cells);
    const rs = build(cells);
    const cost = score(rs, specs, outline, !!fp, entrance);
    if (!best || cost < best.cost) best = { rs, cost };
  }
  const rs = best!.rs;
  const round = (v: number) => Math.round(v * 100) / 100;
  const id = 'L0';
  const rid = (i: number) => `${id}-r${i}`;
  const rooms: PlanRoom[] = rs.map((r) => ({
    id: rid(r.i),
    label: r.spec.label,
    type: r.spec.type,
    polygonPx: r.poly.map(([x, z]) => [round(x) * PX, round(z) * PX] as Vec2),
    measured: null,
    confidence: input.confidence,
  }));
  const { doors, unmet } = connect(rs, specs, entrance, fp);
  const openings: PlanOpening[] = doors.map((d, k) => ({
    id: `${id}-${d.kind === 'open' ? 'open' : 'door'}-${k}`,
    type: d.kind === 'open' ? 'archway' : 'door',
    atPx: [round(d.at[0]) * PX, round(d.at[1]) * PX],
    widthPx: (d.kind === 'open' ? Math.min(d.len - 0.2, 2.6) : 0.8) * PX,
    roomIds: [rid(d.a), rid(d.b)],
    confidence: d.stated ? input.confidence : input.confidence * 0.7,
  }));
  const at = (e: ExtEdge, f = 0.5): Vec2 => [round(e.a[0] + (e.b[0] - e.a[0]) * f) * PX, round(e.a[1] + (e.b[1] - e.a[1]) * f) * PX];
  // Front door on the entrance room's longest front wall (or its longest outside wall).
  const er = rs[entrance];
  const eExt = outsideEdges(er, outline).sort((a, b) => b.len - a.len);
  const fe = eExt.find((e) => e.side === 'front') ?? eExt[0];
  if (fe) openings.push({ id: `${id}-front-door`, type: 'door', atPx: at(fe, 0.7), widthPx: 0.9 * PX, roomIds: [rid(entrance)], confidence: input.confidence });
  // Windows: habitable rooms on as many outside sides as the photos show (default 1); wet rooms one small one.
  for (const r of rs) {
    if (r.spec.type === 'hall' || r.spec.type === 'landing') continue;
    const wet = ['bathroom', 'wc', 'utility'].includes(r.spec.type);
    const bySide = new Map<Side, ExtEdge>();
    for (const e of outsideEdges(r, outline)) if (!bySide.has(e.side) || bySide.get(e.side)!.len < e.len) bySide.set(e.side, e);
    const n = wet ? 1 : Math.min(bySide.size, Math.max(1, r.spec.exteriorWalls ?? 1));
    [...bySide.values()]
      .sort((a, b) => b.len - a.len)
      .slice(0, n)
      .forEach((e, k) => {
        if (e.len < 0.8) return;
        const f = r.i === entrance && fe && e.side === fe.side ? 0.3 : 0.5; // keep clear of the front door
        openings.push({ id: `${rid(r.i)}-win-${k}`, type: 'window', atPx: at(e, f), widthPx: (wet ? 0.6 : Math.min(1.5, e.len * 0.4)) * PX, roomIds: [rid(r.i)], confidence: input.confidence });
      });
  }
  const statedAll = specs.flatMap((s) => s.connectsTo ?? []).length;
  return {
    layoutSource: input.layoutSource ?? 'listing-details',
    levels: [{ id, index: 0, name: 'Ground Floor', planMediaId: '', ceilingHeightMeters: null, rooms, openings, stairs: [] }],
    statedTotalAreaSqM: input.statedTotalAreaSqM,
    uncertainties: [
      'No floor plan: room positions, sizes and door locations are estimated, not measured.',
      ...(fp ? ['The outside shape and size of the building come from its OpenStreetMap outline; the rooms inside are arranged to fit it.'] : []),
      ...(statedAll ? [`Arranged to fit what the photos show (${statedAll - unmet} of ${statedAll} room connections satisfied).`] : []),
      ...(input.uncertainties ?? []),
    ],
    provenance: input.provenance,
    score: Math.round(best!.cost * 10) / 10,
  };
}
