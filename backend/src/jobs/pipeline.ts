/**
 * Reconstruction pipeline (spec §4). Each step persists its state so the
 * client sees real progress, and a crashed run can be retried from scratch
 * without re-billing AI work that was cached (interpretations, masks).
 *
 * Live Meta inference is used whenever MODEL_API_KEY is set. Without it, each
 * AI step either uses clearly labelled fixture data (demo property only) or is
 * skipped with an explicit reason — never silently faked.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FloorplanInterpretation,
  PlacementCandidate,
  SceneManifest,
  bounds,
  buildStructure,
  objectFootprint,
  placeObjects,
  validateFootprint,
  verifyGeometry,
  type Detection,
  type EvidenceFlags,
  type MediaRoomMatch,
  type PropertyMedia,
  type ReconstructionRun,
  type SceneObject,
  type StepLog,
  type Structure,
  type VerificationReport,
} from '../shared/index.js';
import { config, metaConfigured } from '../config.js';
import { imageSize, MODEL_IMAGE_TYPES, toDataUrl } from '../lib/image.js';
import { AiBudget } from '../meta/client.js';
import { assembleInterpretation, matchPhotosToRooms, parseFloorplanLevel, PROMPT_VERSIONS, reviewAgainstPlan, suggestPlacements } from '../meta/muse.js';
import { segmentConcept } from '../meta/sam.js';
import { FIXTURE_PROVIDER, fixtureFile, resolveStorageKey } from '../providers/fixture.js';
import { store } from '../store.js';
import { requestSam3d } from './sam3d.js';

export class PipelineError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Noun phrases SAM is asked about; Muse's visible-object list is intersected with this. */
const SAM_CONCEPTS = ['sofa', 'armchair', 'bed', 'dining table', 'coffee table', 'chair', 'desk', 'wardrobe', 'tv', 'refrigerator', 'kitchen cabinets', 'bathtub', 'toilet', 'lamp', 'rug'];

interface Ctx {
  run: ReconstructionRun;
  budget: AiBudget;
  save: () => Promise<void>;
  log: (step: string, message: string, level?: StepLog['level']) => Promise<void>;
  setState: (state: ReconstructionRun['state'], step: string, progress: number) => Promise<void>;
}

const now = () => new Date().toISOString();

export async function runPipeline(runId: string, opts: { forceReparse?: boolean; sam3dApproved?: boolean } = {}): Promise<void> {
  const run = store.get('runs', runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const budget = new AiBudget();
  const ctx: Ctx = {
    run,
    budget,
    save: async () => {
      run.heartbeatAt = now();
      run.aiCalls = budget.usage.calls;
      run.totalCostEstimate = budget.summary();
      await store.put('runs', run.id, run);
    },
    log: async (step, message, level = 'info') => {
      run.logs.push({ at: now(), step, level, message });
      await ctx.save();
    },
    setState: async (state, step, progress) => {
      run.state = state;
      run.step = step;
      run.progress = progress;
      await ctx.save();
    },
  };

  // ---- 1. Ingest ---------------------------------------------------------
  const property = store.get('properties', run.propertyId);
  if (!property) throw new PipelineError('PROPERTY_NOT_FOUND', `Property ${run.propertyId} not found`);
  const media = Object.values(store.all('media')).filter((m) => m.propertyId === property.id);
  const plans = media.filter((m) => m.type === 'floorplan');
  const photos = media.filter((m) => m.type === 'photo' && m.usageRightsStatus !== 'unverified' && MODEL_IMAGE_TYPES.has(m.mimeType));
  const skippedRights = media.filter((m) => m.usageRightsStatus === 'unverified');
  await ctx.setState('INGESTED', 'ingest', 0.05);
  await ctx.log('ingest', `${plans.length} floor plan(s), ${photos.length} usable photo(s); live Meta inference ${metaConfigured() ? 'ON' : 'OFF (MODEL_API_KEY not set)'}`);
  if (skippedRights.length) await ctx.log('ingest', `${skippedRights.length} media item(s) skipped: usage rights unverified`, 'warn');
  if (!plans.length) {
    throw new PipelineError('NO_FLOORPLAN', 'This listing has no floor plan. Upload a plan you have rights to use; a layout will not be invented.');
  }
  const corrections = store.get('roomMappings', property.id);
  const isFixture = property.sourceProvider === FIXTURE_PROVIDER;
  const live = metaConfigured();
  run.modelVersions = live ? { muse: config.meta.museModel, sam: config.meta.samModel } : {};
  run.promptVersions = live ? PROMPT_VERSIONS : {};

  // ---- 2. Parse floor plan ---------------------------------------------------
  const planImages = await loadPlanRasters(plans);
  let interp = opts.forceReparse ? undefined : store.get('interpretations', property.id);
  if (interp) {
    await ctx.log('parse', `Reusing cached floor-plan interpretation (${interp.provenance.method}); no AI call`);
  } else if (live && planImages.length) {
    interp = await parseWithMuse(ctx, planImages, property.areaSqM, config.meta.museModel);
  } else if (isFixture) {
    interp = FloorplanInterpretation.parse(fixtureFile(property.sourceListingId, 'interpretation.fixture.json'));
    await ctx.log('parse', live ? 'No raster plan available for Muse; using the fixture reference interpretation' : 'Using the fixture reference interpretation (hand-authored stand-in for Muse Spark)', 'warn');
  } else {
    throw new PipelineError('NO_PARSER', live ? 'Floor plans are not in a model-readable raster format (jpeg/png/webp).' : 'MODEL_API_KEY is not set, so this floor plan cannot be read.');
  }
  // Remap fixture plan media ids onto this property's media ids.
  for (const lvl of interp.levels) {
    const m = plans.find((p) => p.metadata.fixtureMediaId === lvl.planMediaId || p.id === lvl.planMediaId);
    if (m) lvl.planMediaId = m.id;
  }

  let structure = buildFromInterp(interp, property.id, corrections);
  let geomChecks = verifyGeometry(structure, interp, [], [], property.areaSqM);
  if (live && config.meta.escalationEnabled && interp.provenance.method === 'meta:muse-spark-1.3' && geomChecks.some((c) => c.severity === 'fail')) {
    await ctx.log('parse', `Geometry checks failed on the Muse Spark reading; escalating to ${config.meta.escalationModel}`, 'warn');
    interp = await parseWithMuse(ctx, planImages, property.areaSqM, config.meta.escalationModel);
    structure = buildFromInterp(interp, property.id, corrections);
    geomChecks = verifyGeometry(structure, interp, [], [], property.areaSqM);
  }
  await store.put('interpretations', property.id, interp);
  const failures = geomChecks.filter((c) => c.severity === 'fail');
  await ctx.setState('STRUCTURE_PARSED', 'parse', 0.3);
  await ctx.log(
    'parse',
    `${structure.levels.length} level(s), ${structure.rooms.length} rooms, ${structure.walls.length} walls, ${structure.openings.length} openings; scale ${(1 / structure.scale.metersPerPx).toFixed(1)} px/m via ${structure.scale.method}${failures.length ? `; ${failures.length} geometry failure(s)` : ''}`,
    failures.length ? 'warn' : 'info',
  );

  // ---- 3. Shell (publish a structure-only preview) ------------------------------
  const prevVersion = store.get('scenes', property.id)?.sceneVersion ?? 0;
  const baseFlags: EvidenceFlags = {
    liveMetaInference: false,
    floorplanInterpretedBy: interp.provenance.method,
    photoEvidence: 'none',
    segmentationBy: null,
    sam3d: 'disabled',
    ceilingHeightEstimated: structure.levels.some((l) => l.heightEstimated),
    scaleEstimated: structure.scale.estimated,
    notes: [],
  };
  const shell = manifest(property.id, prevVersion + 1, false, structure, [], [], [], { geometry: geomChecks, visualReview: { status: 'skipped', reason: 'Pipeline still running', findings: [], provenance: null } }, baseFlags, media);
  await store.put('scenes', property.id, shell);
  await ctx.setState('SHELL_BUILT', 'shell', 0.4);
  await ctx.log('shell', 'Structural shell published — viewable now while media steps continue');

  // ---- 4. Photo → room matching ---------------------------------------------------
  let matches: MediaRoomMatch[] = [];
  let visibleObjects: Record<string, string[]> = {};
  const photoData = await Promise.all(photos.slice(0, 50).map(async (m) => ({ media: m, buf: await readMedia(m) })));
  if (!photos.length) {
    await ctx.log('match', 'No photos supplied — every room is marked "no photo evidence"', 'warn');
  } else if (!live) {
    await ctx.log('match', 'Photo matching skipped: MODEL_API_KEY not set', 'warn');
  } else {
    const r = await matchPhotosToRooms({
      budget,
      photos: photoData.map((p) => ({ mediaId: p.media.id, dataUrl: toDataUrl(p.buf, p.media.mimeType) })),
      structure,
      planImages: planImages.map((p) => p.dataUrl),
    });
    matches = r.matches;
    visibleObjects = r.visibleObjects;
    await ctx.log('match', `Muse matched ${matches.filter((m) => m.roomId).length}/${photos.length} photos to rooms`);
  }
  // Admin corrections and filename pre-assignments override AI matches.
  const manual = new Map<string, string | null>();
  for (const p of photos) if (p.roomGuess && structure.rooms.some((r) => r.id === p.roomGuess)) manual.set(p.id, p.roomGuess);
  for (const m of corrections?.mappings ?? []) manual.set(m.mediaId, m.roomId);
  for (const [mediaId, roomId] of manual) {
    matches = matches.filter((m) => m.mediaId !== mediaId);
    matches.push({ mediaId, roomId, confidence: 1, evidence: ['Assigned manually'], provenance: { method: 'admin-correction', at: now() } });
  }
  for (const room of structure.rooms) room.linkedMediaIds = matches.filter((m) => m.roomId === room.id).map((m) => m.mediaId);
  const roomsWithPhotos = structure.rooms.filter((r) => r.linkedMediaIds.length).length;
  await ctx.setState('MEDIA_MATCHED', 'match', 0.5);

  // ---- 5. Segmentation -----------------------------------------------------------
  const detections: Detection[] = [];
  if (live && photoData.length) {
    const targets = photoData.filter((p) => matches.some((m) => m.mediaId === p.media.id && m.roomId)).slice(0, config.meta.maxSamImagesPerRun);
    for (const p of targets) {
      const size = imageSize(p.buf);
      if (!size) {
        await ctx.log('segment', `Could not read image size for ${p.media.id}; skipped`, 'warn');
        continue;
      }
      const seen = visibleObjects[p.media.id] ?? [];
      const concepts = SAM_CONCEPTS.filter((c) => seen.some((s) => s.includes(c) || c.includes(s))).slice(0, config.meta.maxSamConceptsPerImage);
      for (const concept of concepts.length ? concepts : ['sofa', 'bed', 'table'].slice(0, config.meta.maxSamConceptsPerImage)) {
        try {
          const res = await segmentConcept({ budget, mediaId: p.media.id, dataUrl: toDataUrl(p.buf, p.media.mimeType), imageSize: size, concept });
          detections.push(...res.detections);
          await mkdir(join(config.dataDir, 'masks'), { recursive: true });
          for (const m of res.masks) await writeFile(join(config.dataDir, 'masks', `${m.detectionId}.svg`), m.svg);
        } catch (e) {
          await ctx.log('segment', `SAM "${concept}" on ${p.media.id} failed: ${(e as Error).message}`, 'warn');
          if ((e as { code?: string }).code === 'AI_BUDGET_EXCEEDED') break;
        }
      }
    }
    const kinds = new Set(detections.map((d) => d.concept));
    await ctx.log('segment', `SAM 3.1 returned ${detections.length} detections across ${kinds.size} categories (${[...kinds].join(', ') || 'none'})`);
  } else {
    await ctx.log('segment', live ? 'Segmentation skipped: no matched photos' : 'Segmentation skipped: MODEL_API_KEY not set', 'warn');
  }
  await ctx.setState('SEGMENTED', 'segment', 0.6);

  // ---- 6. Placement ---------------------------------------------------------------
  let candidates: PlacementCandidate[] = [];
  const aiRooms = new Set<string>();
  if (live) {
    for (const room of structure.rooms.filter((r) => r.linkedMediaIds.length)) {
      const roomPhotos = photoData.filter((p) => room.linkedMediaIds.includes(p.media.id)).slice(0, 6);
      try {
        const c = await suggestPlacements({
          budget,
          structure,
          roomId: room.id,
          photos: roomPhotos.map((p) => ({ mediaId: p.media.id, dataUrl: toDataUrl(p.buf, p.media.mimeType) })),
          detections: detections.filter((d) => room.linkedMediaIds.includes(d.mediaId)),
        });
        candidates.push(...c);
        aiRooms.add(room.id);
      } catch (e) {
        await ctx.log('place', `Placement suggestions for ${room.label} failed: ${(e as Error).message}`, 'warn');
      }
    }
  }
  if (isFixture) {
    const fx = PlacementCandidate.array().parse((fixtureFile(property.sourceListingId, 'placements.fixture.json') as { candidates: unknown }).candidates);
    const extra = fx.filter((c) => !aiRooms.has(c.roomId));
    if (extra.length) await ctx.log('place', `${extra.length} hand-authored placement suggestions used for rooms without AI evidence (labelled as such)`, 'warn');
    candidates = [...candidates, ...extra];
  }
  const placed = placeObjects(structure, candidates, { method: 'deterministic', note: 'placement engine', at: now() });
  let objects = applySceneCorrections(placed.objects, structure, property.id);
  await ctx.log('place', `${objects.length} furnishings placed, ${placed.rejected.length} suggestion(s) rejected by constraints`, placed.rejected.length ? 'warn' : 'info');

  // Optional SAM 3D hero object (Modal). Off by default; never blocks the scene.
  let sam3dState: EvidenceFlags['sam3d'] = 'disabled';
  if (config.sam3d.enabled) {
    if (config.sam3d.requireManualApproval && !opts.sam3dApproved) {
      await ctx.log('place', 'SAM 3D enabled but this run was not manually approved; proxies kept');
    } else {
      const r = await requestSam3d({ objects, detections, log: (m, l) => ctx.log('place', m, l) });
      objects = r.objects;
      sam3dState = r.state;
    }
  }
  await ctx.setState('PLACED', 'place', 0.75);

  // ---- 7. Verification -------------------------------------------------------------
  const geometry = verifyGeometry(structure, interp, objects, placed.rejected, property.areaSqM);
  let visualReview: VerificationReport['visualReview'] = {
    status: 'skipped',
    reason: live ? 'No raster plan to review against' : 'MODEL_API_KEY not set — Meta verification pass not run',
    findings: [],
    provenance: null,
  };
  if (live && planImages.length) {
    try {
      const r = await reviewAgainstPlan({
        budget,
        model: config.meta.escalationEnabled ? config.meta.escalationModel : undefined,
        structure,
        planImages: planImages.map((p) => p.dataUrl),
        objectsSummary: objects.map((o) => `${o.kind} in ${o.roomId}`).join(', ') || 'none',
      });
      visualReview = { status: 'completed', reason: 'Muse compared the reconstruction with the source floor plans', findings: r.findings, provenance: r.provenance };
    } catch (e) {
      visualReview = { status: 'failed', reason: (e as Error).message, findings: [], provenance: null };
    }
  }
  await ctx.setState('VERIFIED', 'verify', 0.9);
  await ctx.log('verify', `Geometry: ${count(geometry, 'fail')} fail / ${count(geometry, 'warn')} warn / ${count(geometry, 'pass')} pass. Meta review: ${visualReview.status}`);

  // ---- 8. Export -------------------------------------------------------------------
  const flags: EvidenceFlags = {
    ...baseFlags,
    liveMetaInference: budget.usage.calls > 0,
    photoEvidence: roomsWithPhotos === 0 ? 'none' : roomsWithPhotos === structure.rooms.length ? 'all-rooms' : 'partial',
    segmentationBy: detections.length ? 'meta:sam-3.1' : null,
    sam3d: sam3dState,
    notes: [
      ...(interp.provenance.method === 'fixture:hand-authored' ? ['Floor plan geometry comes from a hand-authored reference reading, not live Muse inference.'] : []),
      ...(objects.some((o) => o.provenance.note?.includes('fixture')) ? ['Some furniture positions come from hand-authored suggestions, not photo evidence.'] : []),
      'Furniture is represented by proxy shapes sized from estimates.',
      ...interp.uncertainties,
    ],
  };
  const final = manifest(property.id, prevVersion + 1, true, structure, objects, matches, detections, { geometry, visualReview }, flags, media);
  await store.put('scenes', property.id, final);
  run.outputSceneVersion = final.sceneVersion;
  run.finishedAt = now();
  await ctx.setState('READY', 'done', 1);
  await ctx.log('done', `Scene v${final.sceneVersion} ready. ${budget.summary()}`);
}

// ---------------------------------------------------------------------------

async function parseWithMuse(ctx: Ctx, planImages: PlanRaster[], areaSqM: number | null, model: string): Promise<FloorplanInterpretation> {
  await ctx.log('parse', `Reading ${planImages.length} plan image(s) with ${model}`);
  const parts = [];
  for (const [i, p] of planImages.entries()) {
    parts.push(
      await parseFloorplanLevel({
        budget: ctx.budget,
        model,
        imageDataUrl: p.dataUrl,
        imageSize: p.size,
        levelId: `L${i}`,
        levelIndex: i,
        levelHint: p.media.levelGuess,
        planMediaId: p.media.id,
      }),
    );
    await ctx.save();
  }
  return assembleInterpretation(parts, areaSqM);
}

function buildFromInterp(interp: FloorplanInterpretation, propertyId: string, corrections: ReturnType<typeof store.get<'roomMappings'>>): Structure {
  let scaleOverride: { metersPerPx: number; method: 'user-reference' } | undefined;
  const ref = corrections?.referenceMeasurement;
  if (ref) {
    const room = interp.levels.flatMap((l) => l.rooms).find((r) => r.id === ref.roomId);
    if (room) {
      const b = bounds(room.polygonPx);
      scaleOverride = { metersPerPx: ref.widthM / (b.max[0] - b.min[0]), method: 'user-reference' };
    }
  }
  return buildStructure(interp, {
    propertyId,
    scaleOverride,
    roomLabelOverrides: Object.fromEntries((corrections?.roomLabels ?? []).map((l) => [l.roomId, l.label])),
    uncertainRoomIds: corrections?.uncertainRoomIds,
  });
}

function applySceneCorrections(objects: SceneObject[], structure: Structure, propertyId: string): SceneObject[] {
  const patch = store.get('sceneCorrections', propertyId);
  if (!patch) return objects;
  const out: SceneObject[] = [];
  for (const o of objects) {
    const c = patch.objects.find((x) => x.id === o.id);
    if (!c) {
      out.push(o);
      continue;
    }
    if (c.removed) continue;
    const next = { ...o, positionXYZ: [...o.positionXYZ] as SceneObject['positionXYZ'], placementNotes: [...o.placementNotes] };
    if (c.positionXZ) [next.positionXYZ[0], next.positionXYZ[2]] = c.positionXZ;
    if (c.rotationY != null) next.rotationY = c.rotationY;
    const room = structure.rooms.find((r) => r.id === o.roomId)!;
    const issues = validateFootprint(objectFootprint(next), room.polygonXZMeters, [], out.filter((p) => p.roomId === o.roomId).map((p) => ({ id: p.id, fp: objectFootprint(p) })));
    next.placementNotes.push(`Adjusted by admin${issues.length ? ` (warning: ${issues.join(', ')})` : ''}`);
    next.provenance = { method: 'admin-correction', at: now() };
    out.push(next);
  }
  return out;
}

interface PlanRaster {
  media: PropertyMedia;
  dataUrl: string;
  size: { width: number; height: number };
}

async function loadPlanRasters(plans: PropertyMedia[]): Promise<PlanRaster[]> {
  const out: PlanRaster[] = [];
  for (const m of plans) {
    const key = MODEL_IMAGE_TYPES.has(m.mimeType) ? m.storageKey : (m.metadata.rasterKey as string | undefined);
    if (!key) continue;
    const path = resolveStorageKey(key);
    if (!path) continue;
    const buf = await readFile(path);
    const size = imageSize(buf);
    if (!size) continue;
    const mime = MODEL_IMAGE_TYPES.has(m.mimeType) ? m.mimeType : 'image/png';
    out.push({ media: m, dataUrl: toDataUrl(buf, mime), size });
  }
  return out;
}

async function readMedia(m: PropertyMedia): Promise<Buffer> {
  const path = resolveStorageKey(m.storageKey);
  if (!path) throw new PipelineError('MEDIA_MISSING', `Media file for ${m.id} is missing`);
  return readFile(path);
}

const count = (c: { severity: string }[], s: string) => c.filter((x) => x.severity === s).length;

function manifest(
  propertyId: string,
  version: number,
  complete: boolean,
  structure: Structure,
  objects: SceneObject[],
  mediaMatches: MediaRoomMatch[],
  detections: Detection[],
  verification: VerificationReport,
  evidenceFlags: EvidenceFlags,
  media: PropertyMedia[],
): SceneManifest {
  const b = structure.footprintBounds;
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[1] + b.max[1]) / 2;
  const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
  return SceneManifest.parse({
    schemaVersion: 1,
    sceneVersion: version,
    complete,
    propertyId,
    generatedAt: now(),
    units: 'meters',
    coordinateSystem: 'x-right,y-up,z-plan-down;origin=plan-top-left-at-ground',
    property: store.get('properties', propertyId),
    media,
    structure,
    objects,
    mediaMatches,
    detections,
    verification,
    evidenceFlags,
    previewCamera: { position: [cx + span * 0.9, span * 1.1, cz + span * 1.3], target: [cx, 1.2, cz] },
  });
}
