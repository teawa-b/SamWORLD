/**
 * Deterministic placement engine. Turns AI placement *suggestions*
 * ("sofa against the north wall, 40% along") into world coordinates inside the
 * room polygon, then checks containment, doorway clearance and collisions.
 * Walls never move to make furniture fit; failing objects are rejected and
 * reported instead.
 */
import { bounds, distPointSegment, interiorPoint, pointInPolygon, polygonOverlapArea, segLength } from './geometry.js';
import type { PlacementCandidate, Provenance, SceneObject, Structure, Vec2, WallSide } from './schemas.js';

const SIDE_NORMALS: Record<WallSide, Vec2> = {
  // Outward normal of a wall on that side, in plan X/Z (z grows "south").
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
};

const FALLBACK_SIDES: Record<WallSide, WallSide[]> = {
  north: ['east', 'west', 'south'],
  south: ['west', 'east', 'north'],
  east: ['north', 'south', 'west'],
  west: ['south', 'north', 'east'],
};

const OPPOSITE: Record<WallSide, WallSide> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/** The asked corner along either wall, then the neighbouring corners, then the opposite one. */
function cornersFrom(a: WallSide, b: WallSide): { side: WallSide; along: WallSide }[] {
  const corners: [WallSide, WallSide][] = [[a, b], [a, OPPOSITE[b]], [OPPOSITE[a], b], [OPPOSITE[a], OPPOSITE[b]]];
  return corners.flatMap(([x, y]) => [{ side: x, along: y }, { side: y, along: x }]);
}

const DOOR_CLEARANCE_M = 0.8;
const WALL_GAP_M = 0.03;

/**
 * How an object relates to the floor and to other objects. Only objects whose height ranges overlap can collide,
 * so a mirror hangs above a basin and a lamp stands on a bedside table.
 * - wall: hung on the wall, above whatever stands below it
 * - surface: stands on a table or counter when it overlaps one, else on the floor (a floor lamp)
 * - built-in: part of a kitchen run (oven, sink, hob…); may share space with the units
 */
type Mount = 'floor' | 'wall' | 'surface' | 'built-in';
const WALL_MOUNTED = new Set(['mirror', 'picture', 'painting', 'artwork', 'frame', 'clock', 'wall-cabinet', 'bathroom-cabinet', 'towel-rail', 'wall-light']);
const ON_SURFACES = new Set(['lamp', 'table-lamp', 'kettle', 'toaster', 'microwave', 'coffee-machine', 'vase', 'speaker', 'radio', 'books', 'fruit-bowl']);
const BUILT_IN = new Set(['oven', 'cooker', 'hob', 'stove', 'sink', 'dishwasher', 'washing-machine', 'extractor-hood']);
/** Built-ins set into the worktop rather than the front of the run. */
const IN_WORKTOP = new Set(['sink', 'hob']);
const SURFACES = new Set(['table', 'side-table', 'bedside-table', 'nightstand', 'desk', 'dresser', 'chest-of-drawers', 'sideboard', 'console-table', 'tv-unit', 'coffee-table', 'dining-table', 'cabinet', 'kitchen-units', 'counter', 'island', 'shelf', 'bookcase']);
const KITCHEN_RUN = new Set(['kitchen-units', 'counter', 'island']);
/** Kinds Muse uses for kitchen units; in a kitchen they're drawn as units with a worktop. */
const KITCHEN_CABINETS = new Set(['cabinet', 'cupboard', 'counter', 'worktop', 'countertop', 'base-cabinet', 'base-unit', 'kitchen-cabinet', 'kitchen-unit', 'kitchen-units']);

const mountOf = (kind: string): Mount => (WALL_MOUNTED.has(kind) ? 'wall' : ON_SURFACES.has(kind) ? 'surface' : BUILT_IN.has(kind) ? 'built-in' : 'floor');

interface Placed {
  id: string;
  kind: string;
  fp: Vec2[];
  /** Bottom and top above the floor, metres. */
  y0: number;
  y1: number;
  depth: number;
}

export interface PlacementResult {
  objects: SceneObject[];
  rejected: { candidate: PlacementCandidate; reasons: string[] }[];
}

/** Rectangle footprint corners for an object centred at c, rotated by rotY. */
export function footprint(c: Vec2, sizeW: number, sizeD: number, rotY: number): Vec2[] {
  const hw = sizeW / 2;
  const hd = sizeD / 2;
  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  // Local X = width, local Z = depth; three.js rotation about +Y maps
  // (x, z) → (x cos + z sin, -x sin + z cos).
  return (
    [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ] as Vec2[]
  ).map(([x, z]) => [c[0] + x * cos + z * sin, c[1] - x * sin + z * cos]);
}

interface Edge {
  a: Vec2;
  b: Vec2;
  inward: Vec2;
  len: number;
}

function roomEdges(poly: Vec2[]): Edge[] {
  // Signed area tells winding; inward normal is to the left for CCW in a
  // y-down plane, so compute and correct using a test point instead.
  const edges: Edge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = segLength(a, b);
    if (len < 1e-6) continue;
    let n: Vec2 = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    const mid: Vec2 = [(a[0] + b[0]) / 2 + n[0] * 0.05, (a[1] + b[1]) / 2 + n[1] * 0.05];
    if (!pointInPolygon(mid, poly)) n = [-n[0], -n[1]];
    edges.push({ a, b, inward: n, len });
  }
  return edges;
}

function edgesForSide(poly: Vec2[], side: WallSide): Edge[] {
  const out = SIDE_NORMALS[side];
  return roomEdges(poly)
    .filter((e) => e.inward[0] * -out[0] + e.inward[1] * -out[1] > 0.7)
    // `along` is defined west→east (north/south walls) and north→south
    // (east/west walls), independent of polygon winding.
    .map((e) => {
      const dx = e.b[0] - e.a[0];
      const dz = e.b[1] - e.a[1];
      return dx < -1e-6 || (Math.abs(dx) <= 1e-6 && dz < 0) ? { ...e, a: e.b, b: e.a } : e;
    })
    .sort((x, y) => {
      // Prefer the outermost edge on that side, then the longest.
      const px = (e: Edge) => ((e.a[0] + e.b[0]) / 2) * out[0] + ((e.a[1] + e.b[1]) / 2) * out[1];
      return px(y) - px(x) || y.len - x.len;
    });
}

function rotationFacing(inward: Vec2): number {
  // Object front is local +Z; rotate so it faces into the room.
  return Math.atan2(inward[0], inward[1]);
}

/**
 * Space to keep clear in front of each door or archway of one room, on that room's side of the wall only:
 * a door into the hall must not stop a bath going against the other side of the same wall.
 */
function doorZones(structure: Structure, room: { id: string; levelId: string; polygonXZMeters: Vec2[] }): Vec2[][] {
  const zones: Vec2[][] = [];
  for (const o of structure.openings) {
    if (o.levelId !== room.levelId || (o.type !== 'door' && o.type !== 'archway')) continue;
    if (o.roomIds.length && !o.roomIds.includes(room.id)) continue;
    const wall = structure.walls.find((w) => w.id === o.parentWallId);
    if (!wall) continue;
    const len = segLength(wall.a, wall.b);
    const dir: Vec2 = [(wall.b[0] - wall.a[0]) / len, (wall.b[1] - wall.a[1]) / len];
    const c: Vec2 = [wall.a[0] + dir[0] * o.offsetAlongWall, wall.a[1] + dir[1] * o.offsetAlongWall];
    const hw = o.widthM / 2 + 0.1;
    const d = DOOR_CLEARANCE_M;
    let nrm: Vec2 = [-dir[1], dir[0]];
    const probe = (n: Vec2): Vec2 => [c[0] + n[0] * 0.2, c[1] + n[1] * 0.2];
    if (!pointInPolygon(probe(nrm), room.polygonXZMeters)) nrm = [-nrm[0], -nrm[1]];
    if (!pointInPolygon(probe(nrm), room.polygonXZMeters)) continue; // the door isn't on this room's walls
    zones.push([
      [c[0] - dir[0] * hw, c[1] - dir[1] * hw],
      [c[0] + dir[0] * hw, c[1] + dir[1] * hw],
      [c[0] + dir[0] * hw + nrm[0] * d, c[1] + dir[1] * hw + nrm[1] * d],
      [c[0] - dir[0] * hw + nrm[0] * d, c[1] - dir[1] * hw + nrm[1] * d],
    ]);
  }
  return zones;
}

/** Objects share space when their height ranges don't meet, or when a built-in sits in a kitchen run. */
export function canShare(a: { kind: string; y0: number; y1: number }, b: { kind: string; y0: number; y1: number }): boolean {
  if (Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) <= 0.02) return true;
  const builtIn = (x: string) => BUILT_IN.has(x);
  return (builtIn(a.kind) && KITCHEN_RUN.has(b.kind)) || (builtIn(b.kind) && KITCHEN_RUN.has(a.kind));
}

/**
 * Where an object sits vertically at a candidate footprint: on the floor, hung on the wall above what stands
 * below, on a surface it overlaps, or in a kitchen run.
 */
function verticalFit(kind: string, h: number, fp: Vec2[], placed: Placed[], ceilingM: number): { y0: number; h: number; run: Placed | null } {
  const mount = mountOf(kind);
  const under = placed.filter((p) => polygonOverlapArea(fp, p.fp, 0.05) > 0.01);
  if (mount === 'wall') {
    const below = Math.max(0, ...under.filter((p) => mountOf(p.kind) !== 'wall').map((p) => p.y1));
    const y0 = Math.min(Math.max(kind === 'mirror' ? 1.05 : 1.2, below + 0.1), ceilingM - h - 0.05);
    return { y0: Math.max(0, y0), h, run: null };
  }
  if (mount === 'surface') {
    const c: Vec2 = [fp.reduce((s, p) => s + p[0], 0) / fp.length, fp.reduce((s, p) => s + p[1], 0) / fp.length];
    const support = under.filter((p) => SURFACES.has(p.kind) && pointInPolygon(c, p.fp)).sort((a, b) => b.y1 - a.y1)[0];
    return { y0: support ? support.y1 : 0, h, run: null };
  }
  if (mount === 'built-in') {
    const run = under.find((p) => KITCHEN_RUN.has(p.kind)) ?? null;
    if (run && IN_WORKTOP.has(kind)) return { y0: run.y1 - 0.03, h: 0.06, run }; // set into the worktop
    if (run) return { y0: 0, h: Math.min(h, run.y1 - 0.04), run }; // under the worktop
  }
  return { y0: 0, h, run: null };
}

export function validateFootprint(
  fp: Vec2[],
  roomPoly: Vec2[],
  doors: Vec2[][],
  placed: { id: string; fp: Vec2[]; kind?: string; y0?: number; y1?: number }[],
  self?: { kind: string; y0: number; y1: number },
): string[] {
  const reasons: string[] = [];
  // Containment: every corner inside (allowing ~1 cm numeric slack).
  for (const p of fp) {
    if (pointInPolygon(p, roomPoly)) continue;
    let near = Infinity;
    for (let i = 0; i < roomPoly.length; i++) near = Math.min(near, distPointSegment(p, roomPoly[i], roomPoly[(i + 1) % roomPoly.length]).dist);
    if (near > 0.01) {
      reasons.push('outside room boundary');
      break;
    }
  }
  if (doors.some((z) => polygonOverlapArea(fp, z, 0.05) > 0.02)) reasons.push('blocks a doorway');
  for (const other of placed) {
    if (self && other.kind != null && other.y0 != null && other.y1 != null && canShare(self, { kind: other.kind, y0: other.y0, y1: other.y1 })) continue;
    if (polygonOverlapArea(fp, other.fp, 0.05) > 0.03) reasons.push(`overlaps ${other.id}`);
  }
  return reasons;
}

export function placeObjects(
  structure: Structure,
  candidates: PlacementCandidate[],
  placementProvenance: Provenance,
): PlacementResult {
  const objects: SceneObject[] = [];
  const rejected: PlacementResult['rejected'] = [];
  const placedByRoom = new Map<string, Placed[]>();
  const roomOf = new Map(structure.rooms.map((r) => [r.id, r]));
  /** In a kitchen, Muse's "cabinet" is a unit with a worktop, or a wall cupboard when it's shallow. */
  const kindFor = (cand: PlacementCandidate) => {
    if (roomOf.get(cand.roomId)?.type !== 'kitchen' || !KITCHEN_CABINETS.has(cand.kind)) return cand.kind;
    return cand.sizeM[2] <= 0.4 && cand.sizeM[1] <= 0.95 ? 'wall-cabinet' : 'kitchen-units';
  };

  // Floor-standing objects before what goes on or above them, larger first: they have fewer valid positions.
  const stage = (c: PlacementCandidate) => ({ floor: 0, 'built-in': 1, surface: 2, wall: 3 })[mountOf(kindFor(c))];
  const ordered = [...candidates].sort((a, b) => stage(a) - stage(b) || b.sizeM[0] * b.sizeM[2] - a.sizeM[0] * a.sizeM[2]);

  for (const cand of ordered) {
    const room = roomOf.get(cand.roomId);
    if (!room) {
      rejected.push({ candidate: cand, reasons: [`unknown room ${cand.roomId}`] });
      continue;
    }
    const level = structure.levels.find((l) => l.id === room.levelId)!;
    const doors = doorZones(structure, room);
    const placed = placedByRoom.get(room.id) ?? [];
    const kind = kindFor(cand);
    const [w, h, d] = cand.sizeM;
    const notes: string[] = kind !== cand.kind ? [`${cand.kind} drawn as ${kind.replace('-', ' ')}`] : [];

    const attempts: { c: Vec2; rot: number; note: string }[] = [];
    if (cand.anchor.type === 'centre') {
      const c = interiorPoint(room.polygonXZMeters);
      const longest = roomEdges(room.polygonXZMeters).sort((x, y) => y.len - x.len)[0];
      const rot = rotationFacing(longest.inward);
      attempts.push({ c, rot, note: 'centre of room' });
      for (const dx of [-0.4, 0.4]) for (const dz of [-0.4, 0.4]) attempts.push({ c: [c[0] + dx, c[1] + dz], rot, note: 'nudged from centre' });
    } else {
      // The suggested wall first; if nothing fits there (Muse can misjudge the side from a photo), the
      // neighbouring walls and then the opposite one, so a bath isn't lost because its wall was misread.
      // A corner is tried along either of its walls, then the other corners.
      const asked: WallSide = cand.anchor.type === 'against-wall' ? cand.anchor.side : cand.anchor.sides[0];
      const plan: { side: WallSide; along: number | WallSide }[] =
        cand.anchor.type === 'against-wall'
          ? [asked, ...FALLBACK_SIDES[asked]].map((side) => ({ side, along: (cand.anchor as { along: number }).along }))
          : cornersFrom(cand.anchor.sides[0], cand.anchor.sides[1]);
      for (const { side, along: want } of plan) {
        const edges = edgesForSide(room.polygonXZMeters, side);
        let along = typeof want === 'number' ? want : 0.5;
        if (typeof want !== 'number' && edges[0]) {
          // The end of the wall nearest the corner's other side.
          const second = SIDE_NORMALS[want];
          const proj = (p: Vec2) => p[0] * second[0] + p[1] * second[1];
          along = proj(edges[0].a) > proj(edges[0].b) ? 0 : 1;
        }
        for (const [ei, e] of edges.entries()) {
          const offsets = [0, -0.1, 0.1, -0.2, 0.2, -0.35, 0.35, -0.5, 0.5];
          for (const off of offsets) {
            const t = Math.min(1, Math.max(0, along + off));
            const usable = e.len - w;
            if (usable < 0) continue;
            const s = w / 2 + usable * t;
            const dir: Vec2 = [(e.b[0] - e.a[0]) / e.len, (e.b[1] - e.a[1]) / e.len];
            const c: Vec2 = [
              e.a[0] + dir[0] * s + e.inward[0] * (d / 2 + WALL_GAP_M),
              e.a[1] + dir[1] * s + e.inward[1] * (d / 2 + WALL_GAP_M),
            ];
            const instead = side !== asked ? ` instead of the ${asked} wall` : '';
            attempts.push({ c, rot: rotationFacing(e.inward), note: `against ${side} wall${ei ? ` (segment ${ei + 1})` : ''}${instead}${off ? `, slid ${off > 0 ? '+' : ''}${off}` : ''}` });
          }
        }
      }
    }

    let success: { c: Vec2; rot: number; fp: Vec2[]; note: string; y0: number; h: number; run: Placed | null } | null = null;
    const lastReasons = new Set<string>();
    for (const at of attempts) {
      const fp = footprint(at.c, w, d, at.rot);
      const v = verticalFit(kind, h, fp, placed, level.heightMeters);
      const reasons = validateFootprint(fp, room.polygonXZMeters, doors, placed, { kind, y0: v.y0, y1: v.y0 + v.h });
      if (!reasons.length) {
        success = { ...at, fp, ...v };
        break;
      }
      reasons.forEach((r) => lastReasons.add(r));
    }

    if (!success) {
      rejected.push({ candidate: cand, reasons: attempts.length ? [...lastReasons] : ['no wall on requested side is long enough'] });
      continue;
    }
    notes.push(success.note);
    if (attempts[0] && success.note !== attempts[0].note) notes.push('moved from AI-suggested position to satisfy constraints');

    let { c, fp } = success;
    let depth = d;
    const mount = mountOf(kind);
    if (success.run && !IN_WORKTOP.has(kind)) {
      // An oven or dishwasher in a run: as deep as the units plus 2 cm, so its front shows.
      const runDepth = success.run.depth;
      const front: Vec2 = [Math.sin(success.rot), Math.cos(success.rot)];
      const shift = (runDepth + 0.02 - d) / 2;
      depth = runDepth + 0.02;
      c = [c[0] + front[0] * shift, c[1] + front[1] * shift];
      fp = footprint(c, w, depth, success.rot);
      notes.push('fitted into the kitchen units');
    } else if (success.run) notes.push('set into the worktop');
    else if (mount === 'surface' && success.y0 > 0) notes.push(`standing on a surface ${success.y0.toFixed(2)} m up`);
    else if (mount === 'wall') notes.push(`hung ${success.y0.toFixed(2)} m above the floor`);
    placed.push({ id: cand.id, kind, fp, y0: success.y0, y1: success.y0 + success.h, depth });
    placedByRoom.set(room.id, placed);

    const slid = success.note.includes('slid') || success.note.includes('nudged') || success.note.includes('instead of');
    objects.push({
      id: cand.id,
      roomId: room.id,
      levelId: room.levelId,
      kind,
      modelUrl: null,
      sourceMediaIds: cand.sourceMediaIds,
      positionXYZ: [round(c[0]), round(level.elevationMeters + success.y0 + success.h / 2), round(c[1])],
      rotationY: round(success.rot, 1e-4),
      sizeM: [w, round(success.h), round(depth)],
      reconstructionMethod: 'primitive',
      placementConfidence: round(cand.confidence * (slid ? 0.8 : 1) * room.confidence, 1e-3),
      dimensionsEstimated: true,
      isMovable: !['kitchen-units', 'wall-cabinet', 'bathtub', 'toilet', 'basin', 'shower', ...BUILT_IN].includes(kind),
      placementNotes: [...notes, cand.rationale],
      provenance: { ...placementProvenance, note: `suggested by ${cand.provenance.method}; placed deterministically` },
    });
  }

  return { objects, rejected };
}

const round = (v: number, step = 0.001) => Math.round(v / step) * step;

export function objectFootprint(o: SceneObject): Vec2[] {
  return footprint([o.positionXYZ[0], o.positionXYZ[2]], o.sizeM[0], o.sizeM[2], o.rotationY);
}

/** Kind and height range of a placed object, for {@link canShare}. */
export const objectSpan = (o: SceneObject) => ({ kind: o.kind, y0: o.positionXYZ[1] - o.sizeM[1] / 2, y1: o.positionXYZ[1] + o.sizeM[1] / 2 });

export { bounds };
