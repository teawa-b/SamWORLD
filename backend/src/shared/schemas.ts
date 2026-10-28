/**
 * Core data contracts (spec §6). Every record keeps four kinds of information
 * apart: (a) source evidence, (b) plan-derived structure, (c) AI-inferred
 * layout/appearance and (d) runtime interaction transforms — the last lives
 * only in the client and is never persisted here.
 */
import { z } from 'zod';

export const Vec2 = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2>;
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

export const Confidence = z.number().min(0).max(1);

/** Who/what produced a piece of data. Never collapse these into one label. */
export const ProvenanceMethod = z.enum([
  'meta:muse-spark-1.3',
  'meta:muse-wonder-1.0',
  'meta:sam-3.1',
  'meta:muse-image-1.0',
  'modal:sam-3d-objects',
  'fixture:hand-authored',
  'deterministic',
  'admin-correction',
  'listing-provider',
]);
export type ProvenanceMethod = z.infer<typeof ProvenanceMethod>;

export const Provenance = z.object({
  method: ProvenanceMethod,
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  note: z.string().optional(),
  at: z.string(),
});
export type Provenance = z.infer<typeof Provenance>;

// ---------------------------------------------------------------------------
// Property + media (source evidence)
// ---------------------------------------------------------------------------

export const UsageRightsStatus = z.enum([
  'owned-by-project', // created by the project team; free to transform
  'licensed',
  'permission-granted',
  'unverified', // must not be shown publicly or sent to a model
]);

export const Property = z.object({
  id: z.string(),
  sourceProvider: z.string(),
  sourceListingId: z.string(),
  listingUrl: z.string().nullable(),
  address: z.string(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  status: z.string(),
  price: z.object({ amount: z.number(), currency: z.string(), period: z.enum(['pcm', 'pw', 'sale']) }).nullable(),
  bedrooms: z.number().int().nullable(),
  areaSqM: z.number().nullable(),
  areaEvidence: z.string().nullable(),
  sourceInfo: z.object({ attribution: z.string(), rightsNote: z.string() }),
  missingData: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Property = z.infer<typeof Property>;

export const MediaType = z.enum(['photo', 'video', 'floorplan', 'historical']);
export const PropertyMedia = z.object({
  id: z.string(),
  propertyId: z.string(),
  type: MediaType,
  storageKey: z.string(),
  mimeType: z.string(),
  sourceUrl: z.string().nullable(),
  pageOrFrame: z.number().int().nullable(),
  captureDate: z.string().nullable(),
  levelGuess: z.string().nullable(),
  roomGuess: z.string().nullable(),
  usageRightsStatus: UsageRightsStatus,
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type PropertyMedia = z.infer<typeof PropertyMedia>;

// ---------------------------------------------------------------------------
// Floor-plan interpretation (what Muse Spark returns, in PLAN PIXELS)
// ---------------------------------------------------------------------------

export const RoomType = z.enum([
  'living',
  'kitchen',
  'dining',
  'bedroom',
  'bathroom',
  'wc',
  'hall',
  'landing',
  'utility',
  'study',
  'other',
]);
export type RoomType = z.infer<typeof RoomType>;

export const PlanRoom = z.object({
  id: z.string(),
  label: z.string(),
  type: RoomType,
  /** Closed ring, plan-image pixel coordinates, no repeated last point. */
  polygonPx: z.array(Vec2).min(3),
  /** Dimension text printed on the plan, parsed into meters if present. */
  measured: z
    .object({ text: z.string(), widthM: z.number().positive(), depthM: z.number().positive() })
    .nullable(),
  confidence: Confidence,
});
export type PlanRoom = z.infer<typeof PlanRoom>;

export const OpeningType = z.enum(['door', 'window', 'archway', 'stairs']);
export type OpeningType = z.infer<typeof OpeningType>;

export const PlanOpening = z.object({
  id: z.string(),
  type: OpeningType,
  /** Centre point of the opening on its wall, plan pixels. */
  atPx: Vec2,
  widthPx: z.number().positive(),
  roomIds: z.array(z.string()),
  confidence: Confidence,
});
export type PlanOpening = z.infer<typeof PlanOpening>;

export const PlanStair = z.object({
  id: z.string(),
  polygonPx: z.array(Vec2).min(3),
  toLevelId: z.string().nullable(),
  confidence: Confidence,
});

export const PlanLevel = z.object({
  id: z.string(),
  index: z.number().int(),
  name: z.string(),
  planMediaId: z.string(),
  ceilingHeightMeters: z.number().positive().nullable(),
  rooms: z.array(PlanRoom).min(1),
  openings: z.array(PlanOpening),
  stairs: z.array(PlanStair).default([]),
});
export type PlanLevel = z.infer<typeof PlanLevel>;

export const FloorplanInterpretation = z.object({
  /** 'floorplan' = read from a plan; anything else is an estimated layout. */
  layoutSource: z.enum(['floorplan', 'photo-floorplan', 'photos', 'listing-details']).default('floorplan'),
  levels: z.array(PlanLevel).min(1),
  statedTotalAreaSqM: z.number().positive().nullable(),
  uncertainties: z.array(z.string()),
  provenance: Provenance,
});
export type FloorplanInterpretation = z.infer<typeof FloorplanInterpretation>;

// ---------------------------------------------------------------------------
// Plan-derived structure (meters, X/Z horizontal, Y up)
// ---------------------------------------------------------------------------

export const ScaleEstimate = z.object({
  metersPerPx: z.number().positive(),
  method: z.enum(['dimension-labels', 'stated-area', 'user-reference', 'unknown-default', 'estimated-layout']),
  samples: z.number().int(),
  spreadPct: z.number(),
  estimated: z.boolean(),
});
export type ScaleEstimate = z.infer<typeof ScaleEstimate>;

export const Opening = z.object({
  id: z.string(),
  levelId: z.string(),
  roomIds: z.array(z.string()),
  type: OpeningType,
  parentWallId: z.string().nullable(),
  /** Distance of the opening centre from wall start, meters. */
  offsetAlongWall: z.number(),
  position: Vec2,
  widthM: z.number(),
  heightM: z.number(),
  sillM: z.number(),
  confidence: Confidence,
});
export type Opening = z.infer<typeof Opening>;

export const Wall = z.object({
  id: z.string(),
  levelId: z.string(),
  a: Vec2,
  b: Vec2,
  exterior: z.boolean(),
  roomIds: z.array(z.string()),
  openingIds: z.array(z.string()),
});
export type Wall = z.infer<typeof Wall>;

export const Room = z.object({
  id: z.string(),
  levelId: z.string(),
  label: z.string(),
  type: RoomType,
  polygonXZMeters: z.array(Vec2),
  areaSqM: z.number(),
  ceilingHeightMeters: z.number(),
  doorIds: z.array(z.string()),
  windowIds: z.array(z.string()),
  linkedMediaIds: z.array(z.string()),
  confidence: Confidence,
  isEstimated: z.boolean(),
  dimensionsMeasured: z.boolean(),
  spawnPoint: Vec2,
});
export type Room = z.infer<typeof Room>;

export const Level = z.object({
  id: z.string(),
  propertyId: z.string(),
  index: z.number().int(),
  name: z.string(),
  elevationMeters: z.number(),
  heightMeters: z.number(),
  heightEstimated: z.boolean(),
  originalPlanMediaId: z.string(),
  stairVoids: z.array(z.array(Vec2)),
  confidence: Confidence,
});
export type Level = z.infer<typeof Level>;

export const Structure = z.object({
  scale: ScaleEstimate,
  levels: z.array(Level),
  rooms: z.array(Room),
  walls: z.array(Wall),
  openings: z.array(Opening),
  footprintBounds: z.object({ min: Vec2, max: Vec2 }),
});
export type Structure = z.infer<typeof Structure>;

// ---------------------------------------------------------------------------
// Photo/video matching and segmentation (AI-inferred)
// ---------------------------------------------------------------------------

export const MediaRoomMatch = z.object({
  mediaId: z.string(),
  roomId: z.string().nullable(),
  confidence: Confidence,
  evidence: z.array(z.string()),
  provenance: Provenance,
});
export type MediaRoomMatch = z.infer<typeof MediaRoomMatch>;

export const Detection = z.object({
  id: z.string(),
  mediaId: z.string(),
  concept: z.string(),
  /** Normalised [x0,y0,x1,y1] in 0..1 image space. */
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  score: Confidence,
  maskKey: z.string().nullable(),
  provenance: Provenance,
});
export type Detection = z.infer<typeof Detection>;

export const WallSide = z.enum(['north', 'south', 'east', 'west']);
export type WallSide = z.infer<typeof WallSide>;

/** A placement *suggestion* — never executed blindly; see placement.ts. */
export const PlacementCandidate = z.object({
  id: z.string(),
  roomId: z.string(),
  kind: z.string(),
  anchor: z.discriminatedUnion('type', [
    z.object({ type: z.literal('against-wall'), side: WallSide, along: z.number().min(0).max(1) }),
    z.object({ type: z.literal('centre') }),
    z.object({ type: z.literal('corner'), sides: z.tuple([WallSide, WallSide]) }),
  ]),
  /** Estimated footprint (width along wall, depth into room, height). */
  sizeM: Vec3,
  sourceDetectionIds: z.array(z.string()),
  sourceMediaIds: z.array(z.string()),
  confidence: Confidence,
  rationale: z.string(),
  provenance: Provenance,
});
export type PlacementCandidate = z.infer<typeof PlacementCandidate>;

export const ReconstructionMethod = z.enum(['sam3d', 'library', 'primitive']);

export const SceneObject = z.object({
  id: z.string(),
  roomId: z.string(),
  levelId: z.string(),
  kind: z.string(),
  modelUrl: z.string().nullable(),
  sourceMediaIds: z.array(z.string()),
  positionXYZ: Vec3,
  rotationY: z.number(),
  sizeM: Vec3,
  reconstructionMethod: ReconstructionMethod,
  placementConfidence: Confidence,
  dimensionsEstimated: z.boolean(),
  isMovable: z.boolean(),
  placementNotes: z.array(z.string()),
  provenance: Provenance,
});
export type SceneObject = z.infer<typeof SceneObject>;

// ---------------------------------------------------------------------------
// Surface appearance (AI-inferred from listing photos)
// ---------------------------------------------------------------------------

export const SurfaceMaterial = z.enum(['paint', 'wallpaper', 'tile', 'wood', 'laminate', 'carpet', 'stone', 'concrete', 'other']);
export type SurfaceMaterial = z.infer<typeof SurfaceMaterial>;

/** One surface's look. `texture` points at a patch of a real listing photo. */
export const SurfaceSpec = z.object({
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  material: SurfaceMaterial,
  texture: z
    .object({
      mediaId: z.string(),
      /** Normalised [x0,y0,x1,y1] of a flat, unobstructed patch in the photo. */
      box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      /** Real-world width the patch covers, meters (sets tiling scale). */
      patchSizeM: z.number().positive().max(5),
    })
    .nullable(),
  confidence: Confidence,
});
export type SurfaceSpec = z.infer<typeof SurfaceSpec>;

export const RoomSurfaces = z.object({
  roomId: z.string(),
  wall: SurfaceSpec,
  floor: SurfaceSpec,
  provenance: Provenance,
});
export type RoomSurfaces = z.infer<typeof RoomSurfaces>;

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export const CheckResult = z.object({
  id: z.string(),
  severity: z.enum(['pass', 'info', 'warn', 'fail']),
  message: z.string(),
  subjectIds: z.array(z.string()).default([]),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const VerificationReport = z.object({
  geometry: z.array(CheckResult),
  visualReview: z.object({
    status: z.enum(['completed', 'skipped', 'failed']),
    reason: z.string(),
    findings: z.array(CheckResult),
    provenance: Provenance.nullable(),
  }),
});
export type VerificationReport = z.infer<typeof VerificationReport>;

// ---------------------------------------------------------------------------
// Reconstruction run (job table) + scene manifest
// ---------------------------------------------------------------------------

export const RunState = z.enum([
  'QUEUED',
  'INGESTED',
  'STRUCTURE_PARSED',
  'SHELL_BUILT',
  'MEDIA_MATCHED',
  'SEGMENTED',
  'PLACED',
  'VERIFIED',
  'READY',
  'FAILED',
]);
export type RunState = z.infer<typeof RunState>;

export const StepLog = z.object({
  at: z.string(),
  step: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
});
export type StepLog = z.infer<typeof StepLog>;

export const ReconstructionRun = z.object({
  id: z.string(),
  propertyId: z.string(),
  state: RunState,
  step: z.string(),
  progress: z.number().min(0).max(1),
  attempts: z.number().int(),
  options: z.object({ forceReparse: z.boolean(), sam3dApproved: z.boolean() }),
  heartbeatAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  modelVersions: z.record(z.string(), z.string()),
  promptVersions: z.record(z.string(), z.string()),
  aiCalls: z.number().int(),
  totalCostEstimate: z.string(),
  outputSceneVersion: z.number().int().nullable(),
  logs: z.array(StepLog),
});
export type ReconstructionRun = z.infer<typeof ReconstructionRun>;

export const LayoutSource = z.enum(['floorplan', 'photo-floorplan', 'photos', 'listing-details']);
export type LayoutSource = z.infer<typeof LayoutSource>;

export const EvidenceFlags = z.object({
  liveMetaInference: z.boolean(),
  /** Where the room layout came from; anything but 'floorplan' is an estimate. */
  layoutSource: LayoutSource.default('floorplan'),
  floorplanInterpretedBy: ProvenanceMethod,
  photoEvidence: z.enum(['none', 'partial', 'all-rooms']),
  segmentationBy: ProvenanceMethod.nullable(),
  sam3d: z.enum(['disabled', 'failed', 'used']),
  surfacesFromPhotos: z.number().int().default(0),
  ceilingHeightEstimated: z.boolean(),
  scaleEstimated: z.boolean(),
  notes: z.array(z.string()),
});
export type EvidenceFlags = z.infer<typeof EvidenceFlags>;

export const SceneManifest = z.object({
  schemaVersion: z.literal(1),
  sceneVersion: z.number().int(),
  /** false while later pipeline steps are still running (shell-only preview). */
  complete: z.boolean(),
  propertyId: z.string(),
  generatedAt: z.string(),
  units: z.literal('meters'),
  coordinateSystem: z.literal('x-right,y-up,z-plan-down;origin=plan-top-left-at-ground'),
  property: Property,
  media: z.array(PropertyMedia),
  structure: Structure,
  objects: z.array(SceneObject),
  mediaMatches: z.array(MediaRoomMatch),
  detections: z.array(Detection),
  /** Rooms whose wall/floor look was read from listing photos. Others use defaults. */
  roomSurfaces: z.array(RoomSurfaces).default([]),
  verification: VerificationReport,
  evidenceFlags: EvidenceFlags,
  previewCamera: z.object({ position: Vec3, target: Vec3 }),
});
export type SceneManifest = z.infer<typeof SceneManifest>;

// ---------------------------------------------------------------------------
// Admin corrections (persisted overrides layered on top of AI output)
// ---------------------------------------------------------------------------

export const RoomMappingPatch = z.object({
  mappings: z.array(z.object({ mediaId: z.string(), roomId: z.string().nullable() })).default([]),
  roomLabels: z.array(z.object({ roomId: z.string(), label: z.string().min(1).max(60) })).default([]),
  uncertainRoomIds: z.array(z.string()).default([]),
  referenceMeasurement: z
    .object({ roomId: z.string(), widthM: z.number().positive().max(50) })
    .nullable()
    .default(null),
});
export type RoomMappingPatch = z.infer<typeof RoomMappingPatch>;

export const SceneCorrectionPatch = z.object({
  objects: z
    .array(
      z.object({
        id: z.string(),
        positionXZ: Vec2.optional(),
        rotationY: z.number().optional(),
        removed: z.boolean().optional(),
      }),
    )
    .max(200),
});
export type SceneCorrectionPatch = z.infer<typeof SceneCorrectionPatch>;
