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

const DOOR_CLEARANCE_M = 0.8;
const WALL_GAP_M = 0.03;

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

function doorZones(structure: Structure, levelId: string): Vec2[][] {
  const zones: Vec2[][] = [];
  for (const o of structure.openings) {
    if (o.levelId !== levelId || (o.type !== 'door' && o.type !== 'archway')) continue;
    const wall = structure.walls.find((w) => w.id === o.parentWallId);
    if (!wall) continue;
    const len = segLength(wall.a, wall.b);
    const dir: Vec2 = [(wall.b[0] - wall.a[0]) / len, (wall.b[1] - wall.a[1]) / len];
    const nrm: Vec2 = [-dir[1], dir[0]];
    const c: Vec2 = [wall.a[0] + dir[0] * o.offsetAlongWall, wall.a[1] + dir[1] * o.offsetAlongWall];
    const hw = o.widthM / 2 + 0.1;
    const d = DOOR_CLEARANCE_M;
    zones.push([
      [c[0] - dir[0] * hw - nrm[0] * d, c[1] - dir[1] * hw - nrm[1] * d],
      [c[0] + dir[0] * hw - nrm[0] * d, c[1] + dir[1] * hw - nrm[1] * d],
      [c[0] + dir[0] * hw + nrm[0] * d, c[1] + dir[1] * hw + nrm[1] * d],
      [c[0] - dir[0] * hw + nrm[0] * d, c[1] - dir[1] * hw + nrm[1] * d],
    ]);
  }
  return zones;
}

export function validateFootprint(
  fp: Vec2[],
  roomPoly: Vec2[],
  doors: Vec2[][],
  placed: { id: string; fp: Vec2[] }[],
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
  const placedByRoom = new Map<string, { id: string; fp: Vec2[] }[]>();

  // Larger objects first: they have fewer valid positions.
  const ordered = [...candidates].sort((a, b) => b.sizeM[0] * b.sizeM[2] - a.sizeM[0] * a.sizeM[2]);

  for (const cand of ordered) {
    const room = structure.rooms.find((r) => r.id === cand.roomId);
    if (!room) {
      rejected.push({ candidate: cand, reasons: [`unknown room ${cand.roomId}`] });
      continue;
    }
    const level = structure.levels.find((l) => l.id === room.levelId)!;
    const doors = doorZones(structure, room.levelId);
    const placed = placedByRoom.get(room.id) ?? [];
    const [w, h, d] = cand.sizeM;
    const notes: string[] = [];

    const attempts: { c: Vec2; rot: number; note: string }[] = [];
    if (cand.anchor.type === 'centre') {
      const c = interiorPoint(room.polygonXZMeters);
      const longest = roomEdges(room.polygonXZMeters).sort((x, y) => y.len - x.len)[0];
      const rot = rotationFacing(longest.inward);
      attempts.push({ c, rot, note: 'centre of room' });
      for (const dx of [-0.4, 0.4]) for (const dz of [-0.4, 0.4]) attempts.push({ c: [c[0] + dx, c[1] + dz], rot, note: 'nudged from centre' });
    } else {
      const sides: WallSide[] = cand.anchor.type === 'against-wall' ? [cand.anchor.side] : [cand.anchor.sides[0]];
      let along = cand.anchor.type === 'against-wall' ? cand.anchor.along : 0.5;
      for (const side of sides) {
        const edges = edgesForSide(room.polygonXZMeters, side);
        if (cand.anchor.type === 'corner' && edges[0]) {
          // Choose the end of the first wall nearest the second side.
          const second = SIDE_NORMALS[cand.anchor.sides[1]];
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
            attempts.push({ c, rot: rotationFacing(e.inward), note: `against ${side} wall${ei ? ` (segment ${ei + 1})` : ''}${off ? `, slid ${off > 0 ? '+' : ''}${off}` : ''}` });
          }
        }
      }
    }

    let success: { c: Vec2; rot: number; fp: Vec2[]; note: string } | null = null;
    const lastReasons = new Set<string>();
    for (const at of attempts) {
      const fp = footprint(at.c, w, d, at.rot);
      const reasons = validateFootprint(fp, room.polygonXZMeters, doors, placed);
      if (!reasons.length) {
        success = { ...at, fp };
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
    placed.push({ id: cand.id, fp: success.fp });
    placedByRoom.set(room.id, placed);

    const slid = success.note.includes('slid') || success.note.includes('nudged');
    objects.push({
      id: cand.id,
      roomId: room.id,
      levelId: room.levelId,
      kind: cand.kind,
      modelUrl: null,
      sourceMediaIds: cand.sourceMediaIds,
      positionXYZ: [round(success.c[0]), round(level.elevationMeters + h / 2), round(success.c[1])],
      rotationY: round(success.rot, 1e-4),
      sizeM: cand.sizeM,
      reconstructionMethod: 'primitive',
      placementConfidence: round(cand.confidence * (slid ? 0.8 : 1) * room.confidence, 1e-3),
      dimensionsEstimated: true,
      isMovable: !['kitchen-units', 'bathtub', 'toilet', 'basin', 'shower'].includes(cand.kind),
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

export { bounds };
