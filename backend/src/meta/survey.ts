/**
 * Furniture placement by surveying each room from its photos, in rounds:
 *
 *   1. Surveyor (Muse): given the MEASURED room (walls with lengths, doors and
 *      windows with positions — from the floor plan when there is one), the
 *      floor plan image, the room's photos and every object SAM 3.1 outlined in
 *      them, Muse first works out where each photo was taken from and which way
 *      the camera faced, then places every object at plan coordinates (metres)
 *      with a size estimated from known references.
 *   2. Check (deterministic, no AI): each object is projected into every photo
 *      it was seen in, using the camera Muse estimated, and compared with where
 *      SAM actually found it. Objects outside the room, overlapping, or behind
 *      the camera are flagged too.
 *   3. Reviewer (Muse): gets its previous layout plus the concrete
 *      disagreements and returns a corrected layout. Repeats until the check
 *      passes or the round limit is reached.
 *
 * The final positions still go through the placement engine (inside the room,
 * doors kept clear, no overlaps).
 */
import { PlacementCandidate, type Detection, type Provenance, type Structure, type Vec2 } from '../shared/index.js';
import { AiBudget, museJson, type JsonSchema } from './client.js';

export const SURVEY_PROMPT_VERSION = 'room-survey-v1';

const num = { type: 'number' };
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const surveySchema = obj({
  cameras: { type: 'array', items: obj({ photo: { type: 'integer' }, x: num, z: num, headingDeg: num, hfovDeg: num, reasoning: { type: 'string' } }) },
  objects: {
    type: 'array',
    items: obj({
      kind: { type: 'string' },
      detectionIds: { type: 'array', items: { type: 'string' } },
      x: num,
      z: num,
      facingDeg: num,
      widthM: num,
      depthM: num,
      heightM: num,
      againstWall: { type: ['string', 'null'] },
      evidence: { type: 'string' },
      confidence: num,
    }),
  },
  notes: { type: 'array', items: { type: 'string' } },
});

export interface Camera {
  photo: number;
  x: number;
  z: number;
  headingDeg: number;
  hfovDeg: number;
}
export interface SurveyObject {
  kind: string;
  detectionIds: string[];
  x: number;
  z: number;
  facingDeg: number;
  widthM: number;
  depthM: number;
  heightM: number;
  againstWall: string | null;
  evidence: string;
  confidence: number;
}
interface Survey {
  cameras: (Camera & { reasoning: string })[];
  objects: SurveyObject[];
  notes: string[];
}

const SYSTEM = `You are a careful interior surveyor rebuilding one room of a real home in 3D, from its measured plan and its listing photos.
Coordinates are plan metres: x increases to the EAST (right on the plan), z increases to the SOUTH (down the plan). North is the top of the plan.
Headings and facings are compass degrees: 0 = north (−z), 90 = east (+x), 180 = south (+z), 270 = west (−x).
Work in this order:
1. For each photo, find where the photographer stood (x, z inside the room or in a doorway) and the heading the camera faced, using the walls, doors and windows you can see and their known positions. Estimate the horizontal field of view (listing photos are usually wide: 70–100°).
2. For every object in the SAM detection list (and any other major furniture you can see), give its centre position (x, z) in the room, the direction its FRONT faces (a sofa faces the room/TV, a bed's foot faces away from its headboard wall, a wardrobe faces the room), and its real size (widthM across its front, depthM front-to-back, heightM). Use references to judge size and distance: interior doors are ~0.8 × 2.0 m, double beds ~1.4–1.6 × 2.0 m, dining chairs ~0.45 m wide, kitchen worktops 0.9 m high and 0.6 m deep, floor tiles 0.3–0.45 m.
3. The same physical object seen in two photos is ONE object: list all its detection ids together.
Rules: everything must be inside the room polygon; objects against a wall touch it (say which wall in againstWall: north/east/south/west); nothing overlaps unless one is on top of the other. Only describe what the photos show.`;

/** Walls of a room as text: each edge with its compass side, length and the doors/windows on it. */
export function describeRoom(structure: Structure, roomId: string): string {
  const room = structure.rooms.find((r) => r.id === roomId)!;
  const p = room.polygonXZMeters;
  const name = (id: string) => structure.rooms.find((r) => r.id === id)?.label ?? 'outside';
  const lines: string[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.2) continue;
    // Which side of the room is this wall on? Outward normal relative to the room centre.
    const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const horizontal = Math.abs(b[1] - a[1]) < Math.abs(b[0] - a[0]);
    const cx = p.reduce((s, q) => s + q[0], 0) / p.length;
    const cz = p.reduce((s, q) => s + q[1], 0) / p.length;
    const side = horizontal ? (m[1] < cz ? 'north' : 'south') : m[0] < cx ? 'west' : 'east';
    const ops = structure.openings
      .filter((o) => o.roomIds.includes(roomId))
      .filter((o) => {
        const t = ((o.position[0] - a[0]) * (b[0] - a[0]) + (o.position[1] - a[1]) * (b[1] - a[1])) / (len * len);
        const qx = a[0] + t * (b[0] - a[0]);
        const qz = a[1] + t * (b[1] - a[1]);
        return t >= -0.02 && t <= 1.02 && Math.hypot(o.position[0] - qx, o.position[1] - qz) < 0.15;
      })
      .map((o) => {
        const other = o.roomIds.filter((id) => id !== roomId);
        const to = o.type === 'window' ? 'window' : `${o.type} to ${other.length ? other.map(name).join('/') : 'outside'}`;
        return `${to} ${o.widthM.toFixed(2)} m wide centred at (${o.position[0].toFixed(2)}, ${o.position[1].toFixed(2)})`;
      });
    lines.push(`- ${side} wall from (${a[0].toFixed(2)}, ${a[1].toFixed(2)}) to (${b[0].toFixed(2)}, ${b[1].toFixed(2)}), ${len.toFixed(2)} m${ops.length ? `: ${ops.join('; ')}` : ''}`);
  }
  const level = structure.levels.find((l) => l.id === room.levelId);
  return `Room "${room.label}" (${room.type}), ${room.areaSqM.toFixed(1)} m², ceiling ${room.ceilingHeightMeters} m${level?.heightEstimated ? ' (estimated)' : ''}. Dimensions ${room.dimensionsMeasured ? 'are from the floor plan’s printed measurements' : 'are estimated'}.
Polygon (x, z): ${JSON.stringify(p.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100]))}
Walls:
${lines.join('\n')}`;
}

function inPoly(pt: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Where an object's centre should appear across a photo (0 = left edge, 1 = right edge), or null if behind the camera. */
export function projectU(cam: Camera, x: number, z: number): number | null {
  const t = (cam.headingDeg * Math.PI) / 180;
  const fx = Math.sin(t);
  const fz = -Math.cos(t);
  const rx = Math.cos(t);
  const rz = Math.sin(t);
  const vx = x - cam.x;
  const vz = z - cam.z;
  const depth = vx * fx + vz * fz;
  if (depth < 0.2) return null;
  const lateral = vx * rx + vz * rz;
  const half = Math.tan((Math.max(40, Math.min(120, cam.hfovDeg)) * Math.PI) / 360);
  return 0.5 + lateral / depth / (2 * half);
}

/** Disagreements between a survey and the evidence. Empty = consistent. */
export function checkSurvey(s: Survey, room: Vec2[], detections: Detection[], photoIndex: (mediaId: string) => number): string[] {
  const issues: string[] = [];
  const cams = new Map(s.cameras.map((c) => [c.photo, c]));
  for (const c of s.cameras) if (!inPoly([c.x, c.z], room)) issues.push(`Camera for photo ${c.photo} is outside the room at (${c.x.toFixed(2)}, ${c.z.toFixed(2)}).`);
  for (const o of s.objects) {
    const label = `${o.kind} [${o.detectionIds.join(', ') || 'no detection'}]`;
    if (!inPoly([o.x, o.z], room)) issues.push(`${label} centre (${o.x.toFixed(2)}, ${o.z.toFixed(2)}) is outside the room.`);
    for (const id of o.detectionIds) {
      const d = detections.find((x) => x.id === id);
      if (!d) continue;
      const cam = cams.get(photoIndex(d.mediaId));
      if (!cam) continue;
      const seen = (d.box[0] + d.box[2]) / 2;
      const u = projectU(cam, o.x, o.z);
      if (u == null) issues.push(`${label}: with your camera for photo ${cam.photo} it would be BEHIND the camera, but SAM sees it in that photo at ${Math.round(seen * 100)}% across.`);
      else if (Math.abs(u - seen) > 0.15) issues.push(`${label}: from your camera for photo ${cam.photo} at (${cam.x.toFixed(2)}, ${cam.z.toFixed(2)}) heading ${Math.round(cam.headingDeg)}°, it would appear ${Math.round(u * 100)}% across the image, but SAM found it at ${Math.round(seen * 100)}% (box ${Math.round(d.box[0] * 100)}–${Math.round(d.box[2] * 100)}%). Move the object or correct the camera.`);
    }
  }
  // Overlaps between big floor objects (rough: discs of their half-size).
  for (let i = 0; i < s.objects.length; i++)
    for (let j = i + 1; j < s.objects.length; j++) {
      const a = s.objects[i];
      const b = s.objects[j];
      const r = (Math.min(a.widthM, a.depthM) + Math.min(b.widthM, b.depthM)) / 2.4;
      if (Math.hypot(a.x - b.x, a.z - b.z) < r && a.heightM > 0.3 && b.heightM > 0.3) issues.push(`${a.kind} and ${b.kind} overlap (centres ${Math.hypot(a.x - b.x, a.z - b.z).toFixed(2)} m apart).`);
    }
  return issues.slice(0, 25);
}

export async function surveyRoom(opts: {
  budget: AiBudget;
  structure: Structure;
  roomId: string;
  photos: { mediaId: string; dataUrl: string }[];
  detections: Detection[];
  planImage?: string | null;
  maxRounds?: number;
  onRound?: (round: number, issues: string[]) => Promise<void> | void;
}): Promise<{ candidates: PlacementCandidate[]; rounds: number; issuesLeft: string[]; cameras: Camera[]; provenance: Provenance }> {
  const room = opts.structure.rooms.find((r) => r.id === opts.roomId)!;
  const photoIndex = (mediaId: string) => opts.photos.findIndex((p) => p.mediaId === mediaId);
  const dets = opts.detections.filter((d) => photoIndex(d.mediaId) >= 0);
  const detText = dets.map((d) => `${d.id}: "${d.concept}" in photo ${photoIndex(d.mediaId)}, box x ${Math.round(d.box[0] * 100)}–${Math.round(d.box[2] * 100)}%, y ${Math.round(d.box[1] * 100)}–${Math.round(d.box[3] * 100)}%`).join('\n');
  const images = [...(opts.planImage ? [opts.planImage] : []), ...opts.photos.map((p) => p.dataUrl)];
  const header = `${describeRoom(opts.structure, opts.roomId)}

SAM 3.1 found these objects (box positions are fractions of the image width/height, 0% = left/top):
${detText || 'none'}

${opts.planImage ? 'The first image is the floor plan of the home. ' : ''}The ${opts.photos.length} photos of this room follow${opts.planImage ? ' after it' : ''}, numbered from 0.`;

  let survey: Survey | null = null;
  let issues: string[] = [];
  let model = '';
  const maxRounds = opts.maxRounds ?? 3;
  let round = 0;
  for (round = 1; round <= maxRounds; round++) {
    const text: string =
      round === 1
        ? `${header}\nSurvey the room: cameras first, then every object.`
        : `${header}\n\nYour previous survey:\n${JSON.stringify({ cameras: survey!.cameras.map(({ reasoning: _r, ...c }) => c), objects: survey!.objects.map(({ evidence: _e, ...o }) => o) })}\n\nChecking it against the photos found these problems:\n${issues.map((i) => `- ${i}`).join('\n')}\n\nLook at the photos again and return a corrected full survey (cameras and every object). Keep what was right.`;
    const r: { data: Survey; model: string } = await museJson<Survey>({ budget: opts.budget, system: SYSTEM, text, images, schemaName: 'room_survey', schema: surveySchema, effort: round === 1 ? 'medium' : 'low' });
    model = r.model;
    const next: Survey = { ...r.data, objects: r.data.objects.filter((o) => o.widthM > 0.05 && o.depthM > 0.05 && o.heightM > 0.02) };
    survey = next;
    issues = checkSurvey(next, room.polygonXZMeters, dets, photoIndex);
    await opts.onRound?.(round, issues);
    if (!issues.length) break;
  }
  const prov: Provenance = { method: model.startsWith('muse-wonder') ? 'meta:muse-wonder-1.0' : 'meta:muse-spark-1.3', model, promptVersion: SURVEY_PROMPT_VERSION, at: new Date().toISOString() };
  const facing = (deg: number): Vec2 => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)];
  const candidates = (survey?.objects ?? []).map((o, i) =>
    PlacementCandidate.parse({
      id: `${opts.roomId}-sv-${i}-${o.kind.toLowerCase().replace(/\W+/g, '-')}`,
      roomId: opts.roomId,
      kind: o.kind.toLowerCase().trim().replace(/\s+/g, '-'),
      anchor: { type: 'at', x: o.x, z: o.z, facing: facing(o.facingDeg) },
      sizeM: [Math.min(6, o.widthM), Math.min(3, o.heightM), Math.min(4, o.depthM)],
      sourceDetectionIds: o.detectionIds.filter((id) => dets.some((d) => d.id === id)),
      sourceMediaIds: [...new Set(o.detectionIds.map((id) => dets.find((d) => d.id === id)?.mediaId).filter((m): m is string => !!m))].concat(o.detectionIds.length ? [] : opts.photos.map((p) => p.mediaId).slice(0, 1)),
      confidence: Math.max(0, Math.min(1, o.confidence)) * (issues.length ? 0.8 : 1),
      rationale: `${o.evidence}${o.againstWall ? ` (against the ${o.againstWall} wall)` : ''}`.slice(0, 400),
      provenance: prov,
    }),
  );
  return { candidates, rounds: Math.min(round, maxRounds), issuesLeft: issues, cameras: (survey?.cameras ?? []).map(({ reasoning: _r, ...c }) => c), provenance: prov };
}
