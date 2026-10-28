/**
 * Look-around points for tap-to-move navigation (phones, desktop and XR).
 * Deterministic: a few points per room, one in every internal doorway, and a
 * pair of stair points that move you between floors.
 */
import { bounds, distPointSegment, pointInPolygon } from './geometry.js';
import type { Structure, Vec2 } from './schemas.js';

export interface Viewpoint {
  id: string;
  levelId: string;
  roomId: string | null;
  position: Vec2;
  kind: 'room' | 'door' | 'stairs';
  /** For stair points: where tapping takes you. */
  target?: { levelId: string; position: Vec2 };
}

const SPACING_M = 2.4;
const EDGE_CLEAR_M = 0.6;

function edgeDistance(p: Vec2, poly: Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distPointSegment(p, poly[i], poly[(i + 1) % poly.length]).dist);
  return d;
}

/** Closest point to `target` inside `poly`, clear of edges and of `avoid` areas. */
function nearestFree(poly: Vec2[], target: Vec2, avoid: Vec2[][], clear = 0.35): Vec2 | null {
  const b = bounds(poly);
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (let x = b.min[0] + 0.1; x < b.max[0]; x += 0.2) {
    for (let z = b.min[1] + 0.1; z < b.max[1]; z += 0.2) {
      const p: Vec2 = [x, z];
      if (!pointInPolygon(p, poly) || edgeDistance(p, poly) < clear) continue;
      if (avoid.some((a) => pointInPolygon(p, a) || edgeDistance(p, a) < 0.25)) continue;
      const d = Math.hypot(x - target[0], z - target[1]);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}

const round = (p: Vec2): Vec2 => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];

export function computeViewpoints(structure: Structure): Viewpoint[] {
  const out: Viewpoint[] = [];
  const voidsOn = (levelId: string) => structure.levels.find((l) => l.id === levelId)?.stairVoids ?? [];

  for (const room of structure.rooms) {
    // Avoid the stair opening on this floor and the stair flight below the next one.
    const lvl = structure.levels.find((l) => l.id === room.levelId)!;
    const above = structure.levels.find((l) => l.index === lvl.index + 1);
    const avoid = [...voidsOn(room.levelId), ...(above ? above.stairVoids : [])];
    const pts: Vec2[] = [];
    const add = (p: Vec2) => {
      if (avoid.some((a) => pointInPolygon(p, a))) return;
      if (pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < SPACING_M * 0.7)) return;
      pts.push(p);
    };
    add(room.spawnPoint);
    const b = bounds(room.polygonXZMeters);
    const nx = Math.max(1, Math.round((b.max[0] - b.min[0]) / SPACING_M));
    const nz = Math.max(1, Math.round((b.max[1] - b.min[1]) / SPACING_M));
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const p: Vec2 = [b.min[0] + ((i + 0.5) * (b.max[0] - b.min[0])) / nx, b.min[1] + ((j + 0.5) * (b.max[1] - b.min[1])) / nz];
        if (pointInPolygon(p, room.polygonXZMeters) && edgeDistance(p, room.polygonXZMeters) >= EDGE_CLEAR_M) add(p);
      }
    }
    if (!pts.length) {
      const p = nearestFree(room.polygonXZMeters, room.spawnPoint, avoid);
      if (p) pts.push(p);
    }
    pts.forEach((p, i) => out.push({ id: `vp-${room.id}-${i}`, levelId: room.levelId, roomId: room.id, position: round(p), kind: 'room' }));
  }

  // Doorways between two rooms: stand in the opening.
  for (const o of structure.openings) {
    if ((o.type !== 'door' && o.type !== 'archway') || o.roomIds.length !== 2 || !o.parentWallId) continue;
    out.push({ id: `vp-${o.id}`, levelId: o.levelId, roomId: null, position: round(o.position), kind: 'door' });
  }

  // Stairs: a point beside the stair opening on each floor, linked together.
  const levels = [...structure.levels].sort((a, b) => a.index - b.index);
  for (let i = 1; i < levels.length; i++) {
    const upper = levels[i];
    const lower = levels[i - 1];
    for (const [k, v] of upper.stairVoids.entries()) {
      const c: Vec2 = [v.reduce((a, p) => a + p[0], 0) / v.length, v.reduce((a, p) => a + p[1], 0) / v.length];
      const lowerRoom = structure.rooms.find((r) => r.levelId === lower.id && pointInPolygon(c, r.polygonXZMeters));
      const upperRoom = structure.rooms.find((r) => r.levelId === upper.id && pointInPolygon(c, r.polygonXZMeters));
      if (!lowerRoom || !upperRoom) continue;
      const lp = nearestFree(lowerRoom.polygonXZMeters, c, [v]);
      const up = nearestFree(upperRoom.polygonXZMeters, c, [v]);
      if (!lp || !up) continue;
      out.push({ id: `vp-stairs-${upper.id}-${k}-up`, levelId: lower.id, roomId: lowerRoom.id, position: round(lp), kind: 'stairs', target: { levelId: upper.id, position: round(up) } });
      out.push({ id: `vp-stairs-${upper.id}-${k}-down`, levelId: upper.id, roomId: upperRoom.id, position: round(up), kind: 'stairs', target: { levelId: lower.id, position: round(lp) } });
    }
  }
  return out;
}
