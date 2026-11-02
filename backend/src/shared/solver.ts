/**
 * Evidence-driven layout for a single-storey home without a floor plan.
 *
 * The footprint is a rectangle sized from the stated area (front edge = the
 * street side, at the bottom of the plan, z = depth). Rooms are placed by
 * searching thousands of "slicing" arrangements (the footprint cut recursively
 * into rectangles sized by room area) and keeping the one that best fits what
 * the photos show:
 *   - rooms that open into each other share a wall (open-plan: a wide one)
 *   - the entrance room touches the front
 *   - rooms seen on the front/rear/left/right sit on that edge
 *   - corner rooms (windows on two walls) touch two outside edges
 *   - bedrooms, living rooms and kitchens have an outside wall (windows)
 *   - every room is reachable, and not only through someone's bedroom
 *   - room shapes match what the photos suggest
 * Doors come from the stated connections first, then the most natural
 * neighbour (hall, then living spaces) for anything still unreachable.
 *
 * Deterministic (seeded by the room list). The result is still an ESTIMATE
 * and is flagged as such downstream; it is just a far better-informed one.
 */
import type { FloorplanInterpretation, PlanOpening, PlanRoom, Provenance, RoomType } from './schemas.js';
import type { LayoutHints, RoomSpec } from './layout.js';

interface R {
  i: number;
  spec: RoomSpec;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
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

/** Shared wall between two rectangles: length and midpoint (or null). */
export function sharedEdge(a: { x0: number; z0: number; x1: number; z1: number }, b: { x0: number; z0: number; x1: number; z1: number }): { len: number; at: [number, number] } | null {
  if (Math.abs(a.x1 - b.x0) < EPS || Math.abs(b.x1 - a.x0) < EPS) {
    const x = Math.abs(a.x1 - b.x0) < EPS ? a.x1 : a.x0;
    const lo = Math.max(a.z0, b.z0);
    const hi = Math.min(a.z1, b.z1);
    return hi - lo > EPS ? { len: hi - lo, at: [x, (lo + hi) / 2] } : null;
  }
  if (Math.abs(a.z1 - b.z0) < EPS || Math.abs(b.z1 - a.z0) < EPS) {
    const z = Math.abs(a.z1 - b.z0) < EPS ? a.z1 : a.z0;
    const lo = Math.max(a.x0, b.x0);
    const hi = Math.min(a.x1, b.x1);
    return hi - lo > EPS ? { len: hi - lo, at: [(lo + hi) / 2, z] } : null;
  }
  return null;
}

type Edge = 'front' | 'rear' | 'left' | 'right';
function edges(r: R, W: number, D: number): Edge[] {
  const out: Edge[] = [];
  if (r.z1 > D - EPS) out.push('front');
  if (r.z0 < EPS) out.push('rear');
  if (r.x0 < EPS) out.push('left');
  if (r.x1 > W - EPS) out.push('right');
  return out;
}

/** Cut the rectangle recursively into one rectangle per room, sized by area. */
function slice(items: { i: number; area: number }[], x0: number, z0: number, x1: number, z1: number, rand: () => number, out: Omit<R, 'spec'>[]) {
  if (items.length === 1) return void out.push({ i: items[0].i, x0, z0, x1, z1 });
  const order = [...items];
  for (let k = order.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [order[k], order[j]] = [order[j], order[k]];
  }
  const total = order.reduce((s, r) => s + r.area, 0);
  // Split near the area middle, with some randomness.
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
  if (vertical) {
    const xm = x0 + w * fa;
    slice(a, x0, z0, xm, z1, rand, out);
    slice(b, xm, z0, x1, z1, rand, out);
  } else {
    const zm = z0 + d * fa;
    slice(a, x0, z0, x1, zm, rand, out);
    slice(b, x0, zm, x1, z1, rand, out);
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
function connect(rs: R[], specs: RoomSpec[], entrance: number): { doors: Door[]; penalty: number; unmet: number } {
  const byLabel = new Map(specs.map((s, i) => [norm(s.label), i]));
  const doors: Door[] = [];
  let unmet = 0;
  const has = (a: number, b: number) => doors.some((d) => (d.a === a && d.b === b) || (d.a === b && d.b === a));
  for (const [i, s] of specs.entries()) {
    for (const c of s.connectsTo ?? []) {
      const j = byLabel.get(norm(c.label));
      if (j == null || j === i || has(i, j)) continue;
      const e = sharedEdge(rs[i], rs[j]);
      const need = c.kind === 'open' ? 1.4 : 0.9;
      if (!e || e.len < need) {
        unmet++;
        continue;
      }
      doors.push({ a: i, b: j, kind: c.kind, at: e.at, len: e.len, stated: true });
    }
  }
  // Reachability from the entrance; add the most natural door for each unreachable room.
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
        const e = sharedEdge(rs[i], rs[j]);
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

function score(rs: R[], specs: RoomSpec[], W: number, D: number, entrance: number): number {
  let cost = 0;
  for (const r of rs) {
    const s = r.spec;
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    const asp = Math.max(w / d, d / w);
    const target = s.widthM && s.depthM ? Math.max(s.widthM / s.depthM, s.depthM / s.widthM) : s.type === 'hall' || s.type === 'landing' ? 3.5 : s.type === 'living' ? 1.5 : 1.3;
    cost += 4 * Math.abs(Math.log(asp / target));
    const min = MIN_SIDE[s.type] ?? 1.5;
    if (Math.min(w, d) < min) cost += 25 * (min - Math.min(w, d));
    const e = edges(r, W, D);
    if (s.side && s.side !== 'unknown' && !e.includes(s.side)) cost += 30;
    if (s.entrance && !e.includes('front')) cost += 45;
    if (s.exteriorWalls && e.length < s.exteriorWalls) cost += 18 * (s.exteriorWalls - e.length);
    if (HABITABLE.includes(s.type) && !e.length) cost += 35;
    if ((s.type === 'bathroom' || s.type === 'wc') && e.includes('front') && s.side !== 'front') cost += 5;
    if (s.type === 'hall' && !e.length && entrance !== r.i) cost += 0; // an inner hall is normal
  }
  const { penalty, unmet } = connect(rs, specs, entrance);
  return cost + penalty + 40 * unmet;
}

/** Solve one floor. Returns an interpretation in plan pixels (1 px = 1 cm) like the plan reader's. */
export function solveSingleStoreyLayout(input: {
  rooms: RoomSpec[];
  hints?: LayoutHints;
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
  // Sizes from the photos override generic areas where given.
  specs = specs.map((r) => (r.widthM && r.depthM ? { ...r, areaM2: r.widthM * r.depthM } : r));
  const total = specs.reduce((a, r) => a + r.areaM2, 0);
  const aspect = Math.min(2.5, Math.max(0.6, input.hints?.aspect ?? 1.3));
  const W = Math.sqrt(total * aspect);
  const D = total / W;
  const entrance = Math.max(
    0,
    specs.findIndex((r) => r.entrance) >= 0 ? specs.findIndex((r) => r.entrance) : specs.findIndex((r) => r.type === 'hall') >= 0 ? specs.findIndex((r) => r.type === 'hall') : specs.findIndex((r) => r.type === 'living'),
  );
  const rand = rng(hash(specs.map((s) => `${s.label}:${s.areaM2}`).join('|')));
  const items = specs.map((s, i) => ({ i, area: s.areaM2 }));
  let best: { rs: R[]; cost: number } | null = null;
  for (let it = 0; it < (input.iterations ?? 6000); it++) {
    const raw: Omit<R, 'spec'>[] = [];
    slice(items, 0, 0, W, D, rand, raw);
    const rs = raw.sort((a, b) => a.i - b.i).map((r) => ({ ...r, spec: specs[r.i] }));
    const cost = score(rs, specs, W, D, entrance);
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
    polygonPx: [
      [round(r.x0) * PX, round(r.z0) * PX],
      [round(r.x1) * PX, round(r.z0) * PX],
      [round(r.x1) * PX, round(r.z1) * PX],
      [round(r.x0) * PX, round(r.z1) * PX],
    ],
    measured: null,
    confidence: input.confidence,
  }));
  const { doors, unmet } = connect(rs, specs, entrance);
  const openings: PlanOpening[] = doors.map((d, k) => ({
    id: `${id}-${d.kind === 'open' ? 'open' : 'door'}-${k}`,
    type: d.kind === 'open' ? 'archway' : 'door',
    atPx: [round(d.at[0]) * PX, round(d.at[1]) * PX],
    widthPx: (d.kind === 'open' ? Math.min(d.len - 0.2, 2.6) : 0.8) * PX,
    roomIds: [rid(d.a), rid(d.b)],
    confidence: d.stated ? input.confidence : input.confidence * 0.7,
  }));
  // Front door on the entrance room's front wall (or its first outside wall).
  const er = rs[entrance];
  const eEdges = edges(er, W, D);
  const fe = eEdges.includes('front') ? 'front' : eEdges[0];
  const mid = (e: Edge, r: R, f = 0.5): [number, number] =>
    e === 'front' ? [r.x0 + (r.x1 - r.x0) * f, D] : e === 'rear' ? [r.x0 + (r.x1 - r.x0) * f, 0] : e === 'left' ? [0, r.z0 + (r.z1 - r.z0) * f] : [W, r.z0 + (r.z1 - r.z0) * f];
  if (fe) openings.push({ id: `${id}-front-door`, type: 'door', atPx: mid(fe, er, 0.7).map((v) => round(v) * PX) as [number, number], widthPx: 0.9 * PX, roomIds: [rid(entrance)], confidence: input.confidence });
  // Windows: habitable rooms on as many outside walls as the photos show (default 1); wet rooms one small one.
  for (const r of rs) {
    const e = edges(r, W, D);
    const wet = ['bathroom', 'wc', 'utility'].includes(r.spec.type);
    if (!e.length || r.spec.type === 'hall' || r.spec.type === 'landing') continue;
    const n = wet ? 1 : Math.min(e.length, Math.max(1, r.spec.exteriorWalls ?? 1));
    e.slice(0, n).forEach((edge, k) => {
      const len = edge === 'front' || edge === 'rear' ? r.x1 - r.x0 : r.z1 - r.z0;
      const f = r.i === entrance && edge === fe ? 0.3 : 0.5; // keep clear of the front door
      openings.push({ id: `${rid(r.i)}-win-${k}`, type: 'window', atPx: mid(edge, r, f).map((v) => round(v) * PX) as [number, number], widthPx: (wet ? 0.6 : Math.min(1.5, len * 0.4)) * PX, roomIds: [rid(r.i)], confidence: input.confidence });
    });
  }
  const statedAll = specs.flatMap((s) => s.connectsTo ?? []).length;
  return {
    layoutSource: input.layoutSource ?? 'listing-details',
    levels: [{ id, index: 0, name: 'Ground Floor', planMediaId: '', ceilingHeightMeters: null, rooms, openings, stairs: [] }],
    statedTotalAreaSqM: input.statedTotalAreaSqM,
    uncertainties: [
      'No floor plan: room positions, sizes and door locations are estimated, not measured.',
      ...(statedAll ? [`Arranged to fit what the photos show (${statedAll - unmet} of ${statedAll} room connections satisfied).`] : []),
      ...(input.uncertainties ?? []),
    ],
    provenance: input.provenance,
    score: Math.round(best!.cost * 10) / 10,
  };
}
