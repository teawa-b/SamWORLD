/**
 * Estimated layouts for listings without a floor plan.
 *
 * Input is a room list (types, rough areas, which floor) from Muse reading
 * the photos, or derived from listing facts. Output is a FloorplanInterpretation
 * in the same format the plan parser produces (1 px = 1 cm), so the rest of
 * the pipeline is unchanged. Arrangement is a simple, believable "corridor"
 * plan: day rooms on one side of a hall, night rooms on the other, stairs at
 * the end of the hall. Positions are NOT the real layout and are flagged as
 * estimated everywhere downstream.
 */
import type { FloorplanInterpretation, PlanLevel, PlanOpening, PlanRoom, Provenance, RoomType, Vec2 } from './schemas.js';
import { solveSingleStoreyLayout } from './solver.js';

export interface RoomSpec {
  label: string;
  type: RoomType;
  areaM2: number;
  level: number;
  /** Which side of the home the room is on, when photos, labels or description say so. */
  side?: 'front' | 'rear' | 'left' | 'right' | 'unknown';
  /** Rough interior size seen in the photos (shape matters more than exact metres). */
  widthM?: number | null;
  depthM?: number | null;
  /** The main entrance (front door) opens into this room. */
  entrance?: boolean;
  /** How many outside walls with windows the photos show (2 = corner room). */
  exteriorWalls?: number | null;
  /** Rooms this one opens into: through a door, or open-plan with no wall. */
  connectsTo?: { label: string; kind: 'door' | 'open' }[];
}

export interface LayoutHints {
  /** False when the photos show rooms opening off each other with no hallway. */
  hallway?: boolean | null;
  /** Footprint width / depth (front edge is the width). */
  aspect?: number | null;
}

export interface ListingFacts {
  bedrooms: number | null;
  bathrooms: number | null;
  areaSqM: number | null;
  propertyType?: string | null;
  description?: string | null;
  /** Storeys, when known; otherwise guessed from the property type. */
  floors?: number | null;
}

const CORRIDOR_M = 1.2;
const ASPECT = 1.4;
const PX = 100; // 1 px = 1 cm
const DAY: RoomType[] = ['living', 'kitchen', 'dining', 'study'];
const CORRIDOR: RoomType[] = ['hall', 'landing'];

const isHouse = (f: ListingFacts) => /house|terrace|semi|detached|cottage|townhouse|end of terrace|mews/i.test(`${f.propertyType ?? ''} ${f.description ?? ''}`) && !/flat|apartment|maisonette|studio|condo/i.test(f.propertyType ?? '');

/** A plausible room list from listing facts alone (no photos, no AI). */
export function roomListFromFacts(f: ListingFacts): RoomSpec[] {
  const beds = Math.max(0, Math.min(6, f.bedrooms ?? (f.areaSqM ? Math.round(f.areaSqM / 30) : 2)));
  const baths = Math.max(1, Math.min(4, f.bathrooms ?? Math.max(1, Math.round(beds / 2))));
  const twoFloors = f.floors != null ? f.floors >= 2 && beds >= 1 : isHouse(f) && beds >= 2;
  const rooms: RoomSpec[] = [];
  const up = twoFloors ? 1 : 0;
  if (beds === 0) rooms.push({ label: 'Studio', type: 'living', areaM2: 20, level: 0 });
  else if (twoFloors) {
    rooms.push({ label: 'Living Room', type: 'living', areaM2: 18, level: 0 }, { label: 'Kitchen / Diner', type: 'kitchen', areaM2: 14, level: 0 });
    if (baths >= 2) rooms.push({ label: 'WC', type: 'wc', areaM2: 2.5, level: 0 });
  } else if (beds >= 2 && !/flat|apartment|condo|studio|maisonette/i.test(f.propertyType ?? '')) {
    // Single-storey houses (bungalows, US single-family homes) usually have a separate kitchen; flats are often open-plan.
    rooms.push({ label: 'Living Room', type: 'living', areaM2: 18, level: 0 }, { label: 'Kitchen', type: 'kitchen', areaM2: 10, level: 0 });
  } else {
    rooms.push({ label: 'Living / Kitchen', type: 'living', areaM2: 24, level: 0 });
  }
  for (let i = 0; i < beds; i++) rooms.push({ label: `Bedroom ${i + 1}`, type: 'bedroom', areaM2: i === 0 ? 13 : 10, level: up });
  const upperBaths = twoFloors && baths >= 2 ? baths - 1 : baths;
  for (let i = 0; i < upperBaths; i++) rooms.push({ label: upperBaths > 1 ? `Bathroom ${i + 1}` : 'Bathroom', type: 'bathroom', areaM2: 5, level: up });
  // Scale to the stated area (minus ~12 % for halls and walls) when known.
  if (f.areaSqM) {
    const sum = rooms.reduce((a, r) => a + r.areaM2, 0);
    const k = (f.areaSqM * 0.88) / sum;
    if (k > 0.5 && k < 3) rooms.forEach((r) => (r.areaM2 = Math.round(r.areaM2 * k * 10) / 10));
  }
  return rooms;
}

interface Rect {
  spec: RoomSpec;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  row: 'top' | 'bottom' | 'corridor';
}

const sideOf = (r: RoomSpec): 'front' | 'rear' | null =>
  r.side === 'front' || r.side === 'rear' ? r.side : /\bfront\b/i.test(r.label) ? 'front' : /\b(rear|back)\b/i.test(r.label) ? 'rear' : null;

/** [top row = rear, bottom row = front]. */
function splitRows(rooms: RoomSpec[]): [RoomSpec[], RoomSpec[]] {
  const area = (l: RoomSpec[]) => l.reduce((a, r) => a + r.areaM2, 0);
  if (rooms.some((r) => sideOf(r))) {
    // Known front/rear rooms go on their side; the rest balance the rows by area.
    const top = rooms.filter((r) => sideOf(r) === 'rear');
    const bottom = rooms.filter((r) => sideOf(r) === 'front');
    for (const r of rooms.filter((x) => !sideOf(x)).sort((a, b) => b.areaM2 - a.areaM2)) (area(top) <= area(bottom) ? top : bottom).push(r);
    if (top.length && bottom.length) return [top, bottom];
  }
  let top = rooms.filter((r) => DAY.includes(r.type));
  let bottom = rooms.filter((r) => !DAY.includes(r.type));
  if (!top.length || !bottom.length) {
    const all = [...rooms].sort((a, b) => b.areaM2 - a.areaM2);
    top = [];
    bottom = [];
    for (const r of all) (area(top) <= area(bottom) ? top : bottom).push(r);
    return [top, bottom];
  }
  // Rebalance by moving the smallest room from the heavier row while it helps.
  for (let i = 0; i < rooms.length; i++) {
    const [heavy, light] = area(top) > area(bottom) ? [top, bottom] : [bottom, top];
    if (heavy.length < 2) break;
    const smallest = [...heavy].sort((a, b) => a.areaM2 - b.areaM2)[0];
    const gap = area(heavy) - area(light);
    if (smallest.areaM2 * 2 > gap) break;
    heavy.splice(heavy.indexOf(smallest), 1);
    light.push(smallest);
  }
  return [top, bottom];
}

/** Arrange a room list into an estimated plan. */
export function layoutFromRoomList(input: {
  rooms: RoomSpec[];
  statedTotalAreaSqM: number | null;
  provenance: Provenance;
  uncertainties?: string[];
  confidence: number;
  layoutSource?: 'photos' | 'listing-details';
  hints?: LayoutHints;
  /** Real building outline in metres (front at max z), used for single-storey homes. */
  footprint?: Vec2[] | null;
}): FloorplanInterpretation {
  // Single storey: arrange by the photo evidence (see solver.ts). Multi-storey keeps the corridor plan below.
  if (input.rooms.length && input.rooms.every((r) => r.level === 0)) {
    const { score: _score, ...interp } = solveSingleStoreyLayout(input);
    return interp;
  }
  const byLevel = new Map<number, RoomSpec[]>();
  for (const r of input.rooms.filter((r) => r.areaM2 > 0.5)) {
    if (!byLevel.has(r.level)) byLevel.set(r.level, []);
    byLevel.get(r.level)!.push(r);
  }
  if (!byLevel.size) byLevel.set(0, roomListFromFacts({ bedrooms: 1, bathrooms: 1, areaSqM: null }));
  const levelIdx = [...byLevel.keys()].sort((a, b) => a - b);
  const multi = levelIdx.length > 1;

  // One footprint for every floor, sized for the largest floor.
  const rowsArea = Math.max(...levelIdx.map((l) => byLevel.get(l)!.filter((r) => !CORRIDOR.includes(r.type)).reduce((a, r) => a + r.areaM2, 0)));
  const c = CORRIDOR_M;
  let d = (-2 * ASPECT * c + Math.sqrt((2 * ASPECT * c) ** 2 + 8 * ASPECT * rowsArea)) / (4 * ASPECT);
  d = Math.max(2.6, d);
  const W = Math.max(5, rowsArea / (2 * d));
  const D = 2 * d + c;
  const stair = { x0: 0.15, x1: 3.0, z0: d + 0.15, z1: d + c - 0.15 };
  const round = (v: number) => Math.round(v * 100) / 100;

  const levels: PlanLevel[] = levelIdx.map((lv, li) => {
    const id = `L${li}`;
    const specs = byLevel.get(lv)!;
    const corridorSpec = specs.find((r) => CORRIDOR.includes(r.type)) ?? { label: li === 0 ? 'Hallway' : 'Landing', type: (li === 0 ? 'hall' : 'landing') as RoomType, areaM2: W * c, level: lv };
    const [top, bottom] = splitRows(specs.filter((r) => r !== corridorSpec && !CORRIDOR.includes(r.type)));
    const hallType: RoomType = li === 0 ? 'hall' : 'landing';
    const rects: Rect[] = [{ spec: { ...corridorSpec, type: hallType }, x0: 0, z0: d, x1: W, z1: d + c, row: 'corridor' }];
    const lay = (row: RoomSpec[], z0: number, z1: number, name: 'top' | 'bottom') => {
      const sum = row.reduce((a, r) => a + r.areaM2, 0) || 1;
      let x = 0;
      row.forEach((r, i) => {
        const w = i === row.length - 1 ? W - x : (W * r.areaM2) / sum;
        rects.push({ spec: r, x0: round(x), z0, x1: round(x + w), z1, row: name });
        x += w;
      });
    };
    lay(top, 0, round(d), 'top');
    lay(bottom, round(d + c), round(D), 'bottom');

    const roomId = (r: Rect, i: number) => `${id}-r${i}`;
    const rooms: PlanRoom[] = rects.map((r, i) => ({
      id: roomId(r, i),
      label: r.spec.label,
      type: r.spec.type,
      polygonPx: [
        [r.x0 * PX, r.z0 * PX],
        [r.x1 * PX, r.z0 * PX],
        [r.x1 * PX, r.z1 * PX],
        [r.x0 * PX, r.z1 * PX],
      ],
      measured: null,
      confidence: input.confidence,
    }));
    const corridorId = rooms[0].id;
    const openings: PlanOpening[] = [];
    const hasStairs = multi;
    rects.forEach((r, i) => {
      if (r.row === 'corridor') return;
      const rid = roomId(r, i);
      const w = r.x1 - r.x0;
      // Door onto the hall, kept clear of the stair flight.
      let dx = (r.x0 + r.x1) / 2;
      if (hasStairs && dx < stair.x1 + 0.6) dx = Math.min(r.x1 - 0.5, Math.max(dx, stair.x1 + 0.6));
      const dz = r.row === 'top' ? d : d + c;
      openings.push({ id: `${rid}-door`, type: 'door', atPx: [round(dx) * PX, round(dz) * PX], widthPx: Math.min(0.8, w - 0.3) * PX, roomIds: [corridorId, rid], confidence: input.confidence });
      // One window on the outside wall.
      const ww = ['bathroom', 'wc', 'utility'].includes(r.spec.type) ? 0.6 : Math.min(1.6, w * 0.45);
      openings.push({ id: `${rid}-win`, type: 'window', atPx: [round((r.x0 + r.x1) / 2) * PX, (r.row === 'top' ? 0 : round(D)) * PX], widthPx: ww * PX, roomIds: [rid], confidence: input.confidence });
    });
    // Open-plan: archway between neighbouring day rooms.
    const tops = rects.filter((r) => r.row === 'top');
    for (let k = 0; k + 1 < tops.length; k++) {
      const a = tops[k];
      const b = tops[k + 1];
      if (DAY.includes(a.spec.type) && DAY.includes(b.spec.type)) {
        openings.push({ id: `${id}-arch-${k}`, type: 'archway', atPx: [a.x1 * PX, round(d / 2) * PX], widthPx: Math.min(1.4, d - 0.6) * PX, roomIds: [roomId(a, rects.indexOf(a)), roomId(b, rects.indexOf(b))], confidence: input.confidence });
      }
    }
    if (li === 0) openings.push({ id: `${id}-front-door`, type: 'door', atPx: [round(W) * PX, round(d + c / 2) * PX], widthPx: 0.9 * PX, roomIds: [corridorId], confidence: input.confidence });
    const stairs =
      hasStairs && li < levelIdx.length - 1
        ? [{ id: `${id}-stairs`, polygonPx: [[stair.x0 * PX, stair.z0 * PX], [stair.x1 * PX, stair.z0 * PX], [stair.x1 * PX, stair.z1 * PX], [stair.x0 * PX, stair.z1 * PX]] as [number, number][], toLevelId: `L${li + 1}`, confidence: input.confidence }]
        : [];
    return { id, index: li, name: li === 0 ? 'Ground Floor' : li === 1 ? 'First Floor' : `Floor ${li}`, planMediaId: '', ceilingHeightMeters: null, rooms, openings, stairs };
  });

  return {
    layoutSource: input.layoutSource ?? 'listing-details',
    levels,
    statedTotalAreaSqM: input.statedTotalAreaSqM,
    uncertainties: [
      'No floor plan: room positions, sizes and door locations are estimated, not measured.',
      ...(input.uncertainties ?? []),
    ],
    provenance: input.provenance,
  };
}

/** Room type from a free-text label ("Bedroom 2", "Lounge", "En-suite"). */
export function typeFromLabel(label: string): RoomType | null {
  const l = label.toLowerCase();
  const T: [RegExp, RoomType][] = [
    [/kitchen/, 'kitchen'],
    [/en-?suite|bath|shower/, 'bathroom'],
    [/\bwc\b|toilet|cloak/, 'wc'],
    [/bed/, 'bedroom'],
    [/dining/, 'dining'],
    [/living|lounge|sitting|reception|family/, 'living'],
    [/hall|entrance|foyer/, 'hall'],
    [/landing/, 'landing'],
    [/study|office/, 'study'],
    [/utility|laundry/, 'utility'],
  ];
  return T.find(([re]) => re.test(l))?.[1] ?? null;
}

const DEFAULT_AREA: Record<RoomType, number> = { living: 18, kitchen: 10, dining: 11, bedroom: 11, bathroom: 5, wc: 2.5, hall: 5, landing: 5, utility: 4, study: 8, other: 8 };

/**
 * The room list for an estimated layout: rooms the person labelled (or Muse
 * named) come first, the listing facts fill in rooms nobody photographed, and
 * the layout hints are attached by label.
 */
export function roomListFromEvidence(facts: ListingFacts, labels: string[], hints: {
  label: string;
  side?: RoomSpec['side'];
  entrance?: boolean;
  exteriorWalls?: number | null;
  widthM?: number | null;
  depthM?: number | null;
  connectsTo?: { label: string; kind: 'door' | 'open' }[];
}[] = []): RoomSpec[] {
  const base = roomListFromFacts(facts);
  const out: RoomSpec[] = [];
  const used = new Set<RoomSpec>();
  const names = [...new Set([...labels, ...hints.map((h) => h.label)].map((l) => l.trim()).filter(Boolean))];
  for (const name of names) {
    const type = typeFromLabel(name);
    if (!type) continue; // "Exterior", "Garden": not a room of the house
    // Reuse a facts room of the same type (keeps sizes sensible), renamed to the person's label.
    const exact = base.find((r) => !used.has(r) && r.label.toLowerCase() === name.toLowerCase());
    const same = exact ?? base.find((r) => !used.has(r) && (r.type === type || (type === 'dining' && r.type === 'living')));
    if (same) used.add(same);
    out.push({ ...(same ?? { areaM2: DEFAULT_AREA[type], level: 0 }), label: name, type });
  }
  for (const r of base) if (!used.has(r) && !out.some((o) => o.label.toLowerCase() === r.label.toLowerCase())) out.push(r);
  // Keep the total close to the stated area.
  if (facts.areaSqM) {
    const sum = out.reduce((a, r) => a + r.areaM2, 0);
    const k = (facts.areaSqM * 0.88) / sum;
    if (k > 0.5 && k < 3) out.forEach((r) => (r.areaM2 = Math.round(r.areaM2 * k * 10) / 10));
  }
  for (const h of hints) {
    const r = out.find((o) => o.label.toLowerCase() === h.label.trim().toLowerCase());
    if (!r) continue;
    Object.assign(r, {
      ...(h.side ? { side: h.side } : {}),
      ...(h.entrance ? { entrance: true } : {}),
      ...(h.exteriorWalls != null ? { exteriorWalls: h.exteriorWalls } : {}),
      ...(h.widthM && h.depthM ? { widthM: h.widthM, depthM: h.depthM } : {}),
      ...(h.connectsTo?.length ? { connectsTo: h.connectsTo } : {}),
    });
  }
  return out;
}
