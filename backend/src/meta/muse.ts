/**
 * Muse Spark / Muse Wonder tasks. Each returns structured JSON constrained by
 * a schema, which is then re-validated with Zod and handed to deterministic
 * code. Muse never outputs meshes or final coordinates.
 */
import {
  FloorplanInterpretation,
  PlacementCandidate,
  RoomSurfaces,
  RoomType,
  SurfaceMaterial,
  type CheckResult,
  type Detection,
  type MediaRoomMatch,
  type PlanLevel,
  type Provenance,
  type Structure,
  type WallSide,
} from '../shared/index.js';
import { z } from 'zod';
import { AiBudget, museJson, type JsonSchema } from './client.js';

export const PROMPT_VERSIONS = {
  floorplan: 'floorplan-v1',
  photoMatch: 'photo-match-v1',
  placement: 'placement-v1',
  planReview: 'plan-review-v1',
  surfaces: 'surfaces-v1',
};

const provenance = (model: string, promptVersion: string): Provenance => ({
  method: model.startsWith('muse-wonder') ? 'meta:muse-wonder-1.0' : 'meta:muse-spark-1.3',
  model,
  promptVersion,
  at: new Date().toISOString(),
});

const num = { type: 'number' };
const str = { type: 'string' };
const point = { type: 'array', items: num, minItems: 2, maxItems: 2 };
const obj = (properties: Record<string, unknown>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

// ---------------------------------------------------------------------------
// 1. Floor plan → rooms/openings in plan pixels
// ---------------------------------------------------------------------------

const floorplanSchema = obj({
  levelName: str,
  ceilingHeightMeters: { type: ['number', 'null'] },
  rooms: {
    type: 'array',
    items: obj({
      id: str,
      label: str,
      type: { type: 'string', enum: RoomType.options },
      polygonPx: { type: 'array', items: point },
      dimensionText: { type: ['string', 'null'] },
      widthM: { type: ['number', 'null'] },
      depthM: { type: ['number', 'null'] },
      confidence: num,
    }),
  },
  openings: {
    type: 'array',
    items: obj({
      id: str,
      type: { type: 'string', enum: ['door', 'window', 'archway'] },
      atPx: point,
      widthPx: num,
      roomIds: { type: 'array', items: str },
      confidence: num,
    }),
  },
  stairs: {
    type: 'array',
    items: obj({ id: str, polygonPx: { type: 'array', items: point }, goesUp: { type: 'boolean' }, confidence: num }),
  },
  uncertainties: { type: 'array', items: str },
});

interface FloorplanReply {
  levelName: string;
  ceilingHeightMeters: number | null;
  rooms: { id: string; label: string; type: z.infer<typeof RoomType>; polygonPx: [number, number][]; dimensionText: string | null; widthM: number | null; depthM: number | null; confidence: number }[];
  openings: { id: string; type: 'door' | 'window' | 'archway'; atPx: [number, number]; widthPx: number; roomIds: string[]; confidence: number }[];
  stairs: { id: string; polygonPx: [number, number][]; goesUp: boolean; confidence: number }[];
  uncertainties: string[];
}

const FLOORPLAN_SYSTEM = `You read estate-agent floor plans and return their geometry as data.
Rules:
- Coordinates are PIXELS in the supplied image (origin top-left, x right, y down).
- Each room is a closed polygon tracing the inside line of its walls, vertices in order, no repeated last point. Use rectangles where walls are straight and square; add vertices for L-shapes.
- Rooms that share a wall must share the same edge coordinates.
- Copy printed dimensions exactly into dimensionText and convert them to meters in widthM/depthM (first number = widthM). If a room has no printed dimension, use null — never invent one.
- Doors, archways (openings with no door leaf) and windows: centre point on the wall, width in pixels, and the ids of the rooms they connect (one id for exterior doors/windows).
- Stairs: polygon of the stair run.
- Report anything ambiguous in uncertainties. Do not guess hidden geometry.`;

export async function parseFloorplanLevel(opts: {
  budget: AiBudget;
  model?: string;
  imageDataUrl: string;
  imageSize: { width: number; height: number };
  levelId: string;
  levelIndex: number;
  levelHint: string | null;
  planMediaId: string;
}): Promise<{ level: PlanLevel; uncertainties: string[]; provenance: Provenance }> {
  const { data, model } = await museJson<FloorplanReply>({
    budget: opts.budget,
    model: opts.model,
    system: FLOORPLAN_SYSTEM,
    text: `Floor plan image, ${opts.imageSize.width}×${opts.imageSize.height} px. ${opts.levelHint ? `Expected level: ${opts.levelHint}.` : ''} Return every room, opening and stair on this level.`,
    images: [opts.imageDataUrl],
    schemaName: 'floorplan_level',
    schema: floorplanSchema,
  });
  const pre = (id: string) => `${opts.levelId}-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const level: PlanLevel = {
    id: opts.levelId,
    index: opts.levelIndex,
    name: data.levelName || opts.levelHint || `Level ${opts.levelIndex}`,
    planMediaId: opts.planMediaId,
    ceilingHeightMeters: data.ceilingHeightMeters,
    rooms: data.rooms.map((r) => ({
      id: pre(r.id),
      label: r.label,
      type: r.type,
      polygonPx: r.polygonPx,
      measured: r.dimensionText && r.widthM && r.depthM ? { text: r.dimensionText, widthM: r.widthM, depthM: r.depthM } : null,
      confidence: clamp01(r.confidence),
    })),
    openings: data.openings.map((o) => ({
      id: pre(o.id),
      type: o.type,
      atPx: o.atPx,
      widthPx: Math.max(1, o.widthPx),
      roomIds: o.roomIds.map(pre),
      confidence: clamp01(o.confidence),
    })),
    stairs: data.stairs.map((s) => ({ id: pre(s.id), polygonPx: s.polygonPx, toLevelId: null, confidence: clamp01(s.confidence) })),
  };
  return { level, uncertainties: data.uncertainties, provenance: provenance(model, PROMPT_VERSIONS.floorplan) };
}

export function assembleInterpretation(
  parts: { level: PlanLevel; uncertainties: string[]; provenance: Provenance }[],
  statedTotalAreaSqM: number | null,
): FloorplanInterpretation {
  const levels = parts.map((p) => p.level).sort((a, b) => a.index - b.index);
  // Stairs go up to the next level when one exists.
  levels.forEach((l, i) => l.stairs.forEach((s) => (s.toLevelId = levels[i + 1]?.id ?? null)));
  return FloorplanInterpretation.parse({
    levels,
    statedTotalAreaSqM,
    uncertainties: parts.flatMap((p) => p.uncertainties.map((u) => `${p.level.name}: ${u}`)),
    provenance: parts[0].provenance,
  });
}

// ---------------------------------------------------------------------------
// 2. Photos → rooms
// ---------------------------------------------------------------------------

const matchSchema = obj({
  photos: {
    type: 'array',
    items: obj({
      photoIndex: { type: 'integer' },
      roomId: { type: ['string', 'null'] },
      confidence: num,
      evidence: { type: 'array', items: str },
      visibleObjects: { type: 'array', items: str },
    }),
  },
});

export async function matchPhotosToRooms(opts: {
  budget: AiBudget;
  photos: { mediaId: string; dataUrl: string }[];
  structure: Structure;
  planImages: string[];
}): Promise<{ matches: MediaRoomMatch[]; visibleObjects: Record<string, string[]> }> {
  const roomList = opts.structure.rooms
    .map((r) => {
      const lvl = opts.structure.levels.find((l) => l.id === r.levelId)!;
      return `- ${r.id}: "${r.label}" (${r.type}, ${lvl.name}, ~${r.areaSqM} m², ${r.windowIds.length} windows, ${r.doorIds.length} doors)`;
    })
    .join('\n');
  const { data, model } = await museJson<{ photos: { photoIndex: number; roomId: string | null; confidence: number; evidence: string[]; visibleObjects: string[] }[] }>({
    budget: opts.budget,
    system:
      'You match listing photos to rooms of a floor plan. Use room type, windows, doors, fixtures and visible connections. If a photo fits no room (exterior, street, unclear), return roomId null. Never claim a room was photographed without visual evidence. visibleObjects: short singular noun phrases for movable furniture and appliances you can see (e.g. "sofa", "bed", "dining table").',
    text: `The first ${opts.planImages.length} image(s) are the floor plans. The next ${opts.photos.length} image(s) are listing photos, numbered from 0.\nRooms:\n${roomList}\nReturn one entry per photo.`,
    images: [...opts.planImages, ...opts.photos.map((p) => p.dataUrl)],
    schemaName: 'photo_room_matches',
    schema: matchSchema,
  });
  const prov = provenance(model, PROMPT_VERSIONS.photoMatch);
  const roomIds = new Set(opts.structure.rooms.map((r) => r.id));
  const matches: MediaRoomMatch[] = [];
  const visibleObjects: Record<string, string[]> = {};
  for (const p of data.photos) {
    const photo = opts.photos[p.photoIndex];
    if (!photo) continue;
    matches.push({
      mediaId: photo.mediaId,
      roomId: p.roomId && roomIds.has(p.roomId) ? p.roomId : null,
      confidence: clamp01(p.confidence),
      evidence: p.evidence.slice(0, 6),
      provenance: prov,
    });
    visibleObjects[photo.mediaId] = p.visibleObjects.map((s) => s.toLowerCase().trim()).filter(Boolean);
  }
  return { matches, visibleObjects };
}

// ---------------------------------------------------------------------------
// 3. Placement suggestions for one room
// ---------------------------------------------------------------------------

const placementSchema = obj({
  objects: {
    type: 'array',
    items: obj({
      kind: str,
      anchorType: { type: 'string', enum: ['against-wall', 'centre', 'corner'] },
      side: { type: ['string', 'null'], enum: ['north', 'south', 'east', 'west', null] },
      secondSide: { type: ['string', 'null'], enum: ['north', 'south', 'east', 'west', null] },
      along: num,
      widthM: num,
      heightM: num,
      depthM: num,
      detectionIds: { type: 'array', items: str },
      confidence: num,
      rationale: str,
    }),
  },
});

function describeRoomWalls(structure: Structure, roomId: string): string {
  const room = structure.rooms.find((r) => r.id === roomId)!;
  const xs = room.polygonXZMeters.map((p) => p[0]);
  const zs = room.polygonXZMeters.map((p) => p[1]);
  const w = (Math.max(...xs) - Math.min(...xs)).toFixed(2);
  const d = (Math.max(...zs) - Math.min(...zs)).toFixed(2);
  const ops = structure.openings
    .filter((o) => o.roomIds.includes(roomId))
    .map((o) => `${o.type} ${o.widthM.toFixed(2)} m wide at (${o.position.map((v) => v.toFixed(2)).join(', ')})`);
  return `Room "${room.label}" spans x ${Math.min(...xs).toFixed(2)}–${Math.max(...xs).toFixed(2)} m (${w} m, west→east) and z ${Math.min(...zs).toFixed(2)}–${Math.max(...zs).toFixed(2)} m (${d} m, north→south; north is the top of the plan). Polygon: ${JSON.stringify(room.polygonXZMeters)}. Openings: ${ops.join('; ') || 'none known'}.`;
}

export async function suggestPlacements(opts: {
  budget: AiBudget;
  structure: Structure;
  roomId: string;
  photos: { mediaId: string; dataUrl: string }[];
  detections: Detection[];
}): Promise<PlacementCandidate[]> {
  const dets = opts.detections.map((d) => `${d.id}: "${d.concept}" in photo ${opts.photos.findIndex((p) => p.mediaId === d.mediaId)} box ${d.box.map((v) => v.toFixed(2)).join(',')} score ${d.score.toFixed(2)}`);
  const { data, model } = await museJson<{
    objects: { kind: string; anchorType: 'against-wall' | 'centre' | 'corner'; side: WallSide | null; secondSide: WallSide | null; along: number; widthM: number; heightM: number; depthM: number; detectionIds: string[]; confidence: number; rationale: string }[];
  }>({
    budget: opts.budget,
    system:
      'You propose where furniture seen in listing photos sits in a room, as relationships ("against the north wall, 30% along from its west/north end"), plus realistic size estimates in meters (width along the wall, depth into the room). Only include objects visible in the photos. Do not move walls. along is 0..1 measured from the west end (north/south walls) or north end (east/west walls).',
    text: `${describeRoomWalls(opts.structure, opts.roomId)}\nSAM 3.1 detections:\n${dets.join('\n') || 'none'}\nPhotos follow, numbered from 0.`,
    images: opts.photos.map((p) => p.dataUrl),
    schemaName: 'room_placements',
    schema: placementSchema,
  });
  const prov = provenance(model, PROMPT_VERSIONS.placement);
  return data.objects.map((o, i) =>
    PlacementCandidate.parse({
      id: `${opts.roomId}-ai-${i}-${o.kind.replace(/\W+/g, '-')}`,
      roomId: opts.roomId,
      kind: o.kind.toLowerCase().replace(/\s+/g, '-'),
      anchor:
        o.anchorType === 'centre'
          ? { type: 'centre' }
          : o.anchorType === 'corner' && o.side && o.secondSide
            ? { type: 'corner', sides: [o.side, o.secondSide] }
            : { type: 'against-wall', side: o.side ?? 'north', along: clamp01(o.along) },
      sizeM: [clampSize(o.widthM), clampSize(o.heightM), clampSize(o.depthM)],
      sourceDetectionIds: o.detectionIds.filter((id) => opts.detections.some((d) => d.id === id)),
      sourceMediaIds: opts.photos.map((p) => p.mediaId),
      confidence: clamp01(o.confidence),
      rationale: o.rationale,
      provenance: prov,
    }),
  );
}

// ---------------------------------------------------------------------------
// 3b. Wall and floor appearance for one room (for texturing)
// ---------------------------------------------------------------------------

const surfaceSchema = obj({
  colorHex: str,
  material: { type: 'string', enum: SurfaceMaterial.options },
  photoIndex: { type: ['integer', 'null'] },
  box: { type: ['array', 'null'], items: num, minItems: 4, maxItems: 4 },
  patchSizeM: num,
  confidence: num,
});
const surfacesSchema = obj({ wall: surfaceSchema, floor: surfaceSchema });

interface SurfaceReply {
  colorHex: string;
  material: z.infer<typeof SurfaceMaterial>;
  photoIndex: number | null;
  box: [number, number, number, number] | null;
  patchSizeM: number;
  confidence: number;
}

/**
 * Ask Muse for the room's dominant wall and floor finish, and for a flat,
 * unobstructed, roughly front-on patch of each in one of the photos. The
 * browser crops that patch from the real photo and tiles it. Boxes are
 * validated here; a bad box falls back to colour-only.
 */
export async function readRoomSurfaces(opts: {
  budget: AiBudget;
  roomId: string;
  roomLabel: string;
  photos: { mediaId: string; dataUrl: string }[];
}): Promise<RoomSurfaces> {
  const { data, model } = await museJson<{ wall: SurfaceReply; floor: SurfaceReply }>({
    budget: opts.budget,
    system:
      'You describe interior finishes from listing photos so a 3D model can be textured to match. For the walls and for the floor, give the dominant colour as #rrggbb, the material, and a rectangle (normalised 0..1 [x0,y0,x1,y1]) in one photo covering a flat, evenly lit, unobstructed patch of that surface: no furniture, windows, shadows or edges, as front-on as possible (for floors prefer the area nearest the camera). patchSizeM is your estimate of how many metres wide that patch is in reality (wood boards and tiles help). If no clean patch exists, return null for photoIndex and box.',
    text: `Room: "${opts.roomLabel}". ${opts.photos.length} photo(s) follow, numbered from 0.`,
    images: opts.photos.map((p) => p.dataUrl),
    schemaName: 'room_surfaces',
    schema: surfacesSchema,
  });
  const prov = provenance(model, PROMPT_VERSIONS.surfaces);
  const toSpec = (r: SurfaceReply) => {
    const photo = r.photoIndex != null ? opts.photos[r.photoIndex] : undefined;
    const b = r.box;
    const boxOk = !!b && b.every((v) => v >= 0 && v <= 1) && b[2] - b[0] >= 0.04 && b[3] - b[1] >= 0.04;
    return {
      colorHex: /^#[0-9a-fA-F]{6}$/.test(r.colorHex) ? r.colorHex : '#d8d4cc',
      material: r.material,
      texture: photo && boxOk ? { mediaId: photo.mediaId, box: b!, patchSizeM: Math.min(5, Math.max(0.2, r.patchSizeM || 1)) } : null,
      confidence: clamp01(r.confidence),
    };
  };
  return RoomSurfaces.parse({ roomId: opts.roomId, wall: toSpec(data.wall), floor: toSpec(data.floor), provenance: prov });
}

// ---------------------------------------------------------------------------
// 4. Verification: compare reconstruction against the plan
// ---------------------------------------------------------------------------

const reviewSchema = obj({
  findings: {
    type: 'array',
    items: obj({ severity: { type: 'string', enum: ['pass', 'info', 'warn', 'fail'] }, message: str, roomIds: { type: 'array', items: str } }),
  },
});

export async function reviewAgainstPlan(opts: {
  budget: AiBudget;
  model?: string;
  structure: Structure;
  planImages: string[];
  objectsSummary: string;
}): Promise<{ findings: CheckResult[]; provenance: Provenance }> {
  const summary = opts.structure.levels
    .map((l) => {
      const rooms = opts.structure.rooms.filter((r) => r.levelId === l.id);
      return `${l.name}:\n${rooms.map((r) => `  ${r.id} "${r.label}" ${r.areaSqM} m², polygon ${JSON.stringify(r.polygonXZMeters)}, doors ${r.doorIds.length}, windows ${r.windowIds.length}`).join('\n')}`;
    })
    .join('\n');
  const { data, model } = await museJson<{ findings: { severity: CheckResult['severity']; message: string; roomIds: string[] }[] }>({
    budget: opts.budget,
    model: opts.model,
    system:
      'You verify a 3D reconstruction against its source floor plans. Compare room count, labels, relative positions, adjacency, door/window placement and furniture plausibility. Report concrete discrepancies only; say "pass" findings for things you checked that match. You cannot certify physical accuracy.',
    text: `Reconstruction (meters; x east, z south; origin at plan top-left):\n${summary}\nFurniture: ${opts.objectsSummary}\nThe floor plan image(s) follow.`,
    images: opts.planImages,
    schemaName: 'reconstruction_review',
    schema: reviewSchema,
  });
  return {
    findings: data.findings.slice(0, 30).map((f, i) => ({ id: `review-${i}`, severity: f.severity, message: f.message, subjectIds: f.roomIds })),
    provenance: provenance(model, PROMPT_VERSIONS.planReview),
  };
}

function clamp01(v: number) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}
function clampSize(v: number) {
  return Number.isFinite(v) ? Math.max(0.2, Math.min(4, v)) : 1;
}
