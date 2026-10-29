/**
 * Deterministic geometry verification (spec §4 step 8.1). Runs before, and
 * independently of, any AI visual review.
 */
import { polygonOverlapArea, polygonSelfIntersects, bounds } from './geometry.js';
import { canShare, objectFootprint, objectSpan } from './placement.js';
import type { CheckResult, FloorplanInterpretation, PlacementCandidate, SceneObject, Structure } from './schemas.js';

export const MEASUREMENT_TOLERANCE_PCT = 5;
export const AREA_TOLERANCE_PCT = 10;

export function verifyGeometry(
  structure: Structure,
  interp: FloorplanInterpretation,
  objects: SceneObject[],
  rejected: { candidate: PlacementCandidate; reasons: string[] }[],
  listingAreaSqM: number | null,
): CheckResult[] {
  const out: CheckResult[] = [];
  const push = (id: string, severity: CheckResult['severity'], message: string, subjectIds: string[] = []) =>
    out.push({ id, severity, message, subjectIds });

  // Scale
  const s = structure.scale;
  push(
    'scale',
    s.estimated ? 'warn' : 'pass',
    s.method === 'dimension-labels'
      ? `Scale from ${s.samples} printed dimensions, spread ${s.spreadPct}%`
      : `Scale method "${s.method}" — dimensions are estimates`,
  );

  // Rooms: validity + overlaps
  for (const room of structure.rooms) {
    if (room.polygonXZMeters.length < 3 || polygonSelfIntersects(room.polygonXZMeters)) {
      push(`room-ring-${room.id}`, 'fail', `${room.label}: broken or self-intersecting polygon`, [room.id]);
    } else if (room.areaSqM < 1) {
      push(`room-area-${room.id}`, 'warn', `${room.label}: implausibly small (${room.areaSqM} m²)`, [room.id]);
    }
  }
  for (const level of structure.levels) {
    const rs = structure.rooms.filter((r) => r.levelId === level.id);
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const ov = polygonOverlapArea(rs[i].polygonXZMeters, rs[j].polygonXZMeters);
        if (ov > 0.2) push(`overlap-${rs[i].id}-${rs[j].id}`, 'fail', `${rs[i].label} overlaps ${rs[j].label} by ~${ov.toFixed(1)} m²`, [rs[i].id, rs[j].id]);
      }
    }
  }
  if (!out.some((c) => c.id.startsWith('overlap-') || c.id.startsWith('room-ring-'))) {
    push('rooms-valid', 'pass', `${structure.rooms.length} rooms form closed, non-overlapping polygons`);
  }

  // Measured dimensions vs reconstructed geometry
  for (const level of interp.levels) {
    for (const pr of level.rooms) {
      if (!pr.measured) {
        push(`dims-${pr.id}`, 'info', `${pr.label}: no printed dimensions — size inferred from plan scale`, [pr.id]);
        continue;
      }
      const room = structure.rooms.find((r) => r.id === pr.id);
      if (!room) continue;
      const b = bounds(room.polygonXZMeters);
      const got = [b.max[0] - b.min[0], b.max[1] - b.min[1]].sort((x, y) => y - x);
      const want = [pr.measured.widthM, pr.measured.depthM].sort((x, y) => y - x);
      const err = Math.max(...got.map((g, i) => (Math.abs(g - want[i]) / want[i]) * 100));
      push(
        `dims-${pr.id}`,
        err <= MEASUREMENT_TOLERANCE_PCT ? 'pass' : 'warn',
        `${pr.label}: reconstructed ${got.map((g) => g.toFixed(2)).join(' × ')} m vs printed ${pr.measured.text} (max error ${err.toFixed(1)}%)`,
        [pr.id],
      );
    }
  }

  // Area vs listing
  const total = structure.rooms.reduce((a, r) => a + r.areaSqM, 0);
  if (listingAreaSqM) {
    const diff = (Math.abs(total - listingAreaSqM) / listingAreaSqM) * 100;
    push(
      'total-area',
      diff <= AREA_TOLERANCE_PCT ? 'pass' : 'warn',
      `Interpreted room area ${total.toFixed(1)} m² vs listing ${listingAreaSqM} m² (${diff.toFixed(1)}% difference; listing figures often include walls)`,
    );
  } else {
    push('total-area', 'info', `Interpreted room area ${total.toFixed(1)} m²; listing gives no area to compare`);
  }

  // Wall graph closure
  for (const level of structure.levels) {
    const deg = new Map<string, number>();
    const k = (p: [number, number]) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
    for (const w of structure.walls.filter((w) => w.levelId === level.id)) {
      deg.set(k(w.a), (deg.get(k(w.a)) ?? 0) + 1);
      deg.set(k(w.b), (deg.get(k(w.b)) ?? 0) + 1);
    }
    const dangling = [...deg.entries()].filter(([, d]) => d < 2);
    push(
      `walls-closed-${level.id}`,
      dangling.length ? 'fail' : 'pass',
      dangling.length ? `${level.name}: ${dangling.length} dangling wall ends` : `${level.name}: wall network is closed`,
    );
  }

  // Openings attached
  for (const o of structure.openings.filter((o) => !o.parentWallId)) {
    push(`opening-${o.id}`, 'warn', `Opening ${o.id} (${o.type}) is not on any wall — ignored in geometry`, [o.id]);
  }

  // Connectivity via doors/archways (+ stairs between levels)
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const o of structure.openings) {
    if ((o.type === 'door' || o.type === 'archway') && o.roomIds.length === 2) link(o.roomIds[0], o.roomIds[1]);
  }
  for (const pl of interp.levels) {
    for (const st of pl.stairs) {
      if (!st.toLevelId) continue;
      const fromRoom = structure.rooms.find((r) => r.levelId === pl.id && st.polygonPx && r.type === 'hall');
      const toRoom = structure.rooms.find((r) => r.levelId === st.toLevelId && r.type === 'landing');
      if (fromRoom && toRoom) link(fromRoom.id, toRoom.id);
    }
  }
  const entrance = structure.openings.find((o) => o.type === 'door' && o.roomIds.length === 1);
  if (entrance) {
    const seen = new Set<string>([entrance.roomIds[0]]);
    const queue = [entrance.roomIds[0]];
    while (queue.length) for (const n of adj.get(queue.shift()!) ?? []) if (!seen.has(n)) seen.add(n), queue.push(n);
    const unreachable = structure.rooms.filter((r) => !seen.has(r.id));
    push(
      'connectivity',
      unreachable.length ? 'warn' : 'pass',
      unreachable.length
        ? `Not reachable from entrance via known doors: ${unreachable.map((r) => r.label).join(', ')}`
        : 'Every room is reachable from the entrance through doors/stairs',
      unreachable.map((r) => r.id),
    );
  } else {
    push('connectivity', 'warn', 'No exterior entrance door identified');
  }

  // Ceiling heights
  for (const l of structure.levels.filter((l) => l.heightEstimated)) {
    push(`ceiling-${l.id}`, 'info', `${l.name}: ceiling height ${l.heightMeters} m is an estimate (not on plan)`, [l.id]);
  }

  // Objects
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      if (objects[i].roomId !== objects[j].roomId) continue;
      if (canShare(objectSpan(objects[i]), objectSpan(objects[j]))) continue; // e.g. a mirror above a basin
      if (polygonOverlapArea(objectFootprint(objects[i]), objectFootprint(objects[j]), 0.05) > 0.03) {
        push(`collide-${objects[i].id}-${objects[j].id}`, 'warn', `${objects[i].kind} collides with ${objects[j].kind}`, [objects[i].id, objects[j].id]);
      }
    }
  }
  for (const r of rejected) {
    push(`rejected-${r.candidate.id}`, 'warn', `Could not place ${r.candidate.kind} in ${r.candidate.roomId}: ${r.reasons.join('; ')}`, [r.candidate.id]);
  }
  push('objects', 'info', `${objects.length} furnishings placed as estimated proxies; ${rejected.length} suggestions rejected`);

  return out;
}
