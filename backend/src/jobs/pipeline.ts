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
  layoutFromRoomList,
  roomListFromEvidence,
  typicalFurniture,
  objectFootprint,
  objectSpan,
  placeObjects,
  validateFootprint,
  verifyGeometry,
  type Detection,
  type EvidenceFlags,
  type MediaRoomMatch,
  type PropertyMedia,
  type ReconstructionRun,
  type RoomSurfaces,
  type SceneObject,
  type StepLog,
  type Structure,
  type VerificationReport,
  type Vec2,
} from '../shared/index.js';
import { config, metaConfigured } from '../config.js';
import { flattenTransparentPng, imageSize, MODEL_IMAGE_TYPES, toDataUrl } from '../lib/image.js';
import { AiBudget } from '../meta/client.js';
import { resolveModels } from '../meta/models.js';
import { assembleInterpretation, FloorplanUnreadableError, layoutFromPhotos, matchPhotosToRooms, parseFloorplanLevel, PROMPT_VERSIONS, furnishRooms, readRoomSurfaces, reviewAgainstPlan, suggestPlacements } from '../meta/muse.js';
import { segmentConcept } from '../meta/sam.js';
import { SURVEY_PROMPT_VERSION, surveyRoom } from '../meta/survey.js';
import { FIXTURE_PROVIDER, fixtureFile, resolveStorageKey } from '../providers/fixture.js';
import { store } from '../store.js';
import { requestSam3d } from './sam3d.js';
import { fetchFootprint } from '../providers/footprint.js';
import { geocode } from '../providers/geo.js';

export class PipelineError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Things SAM shouldn't be asked about: structure and fittings, not furniture. */
const NOT_FURNITURE = /\b(wall|floor|ceiling|window|door|curtain|blind|socket|switch|light|lamp shade|skirting|radiator|carpet|tile|stair|banister|rail|frame|picture|plant|ceiling light)s?\b/i;
const FALLBACK_CONCEPTS = ['sofa', 'bed', 'table', 'chair', 'cabinet', 'wardrobe'];

/** Noun phrases to ask SAM about for one photo: what Muse saw there, cleaned up. */
function samConcepts(seen: string[], max: number): string[] {
  const out = new Set<string>();
  for (const raw of seen) {
    const c = raw.toLowerCase().replace(/[^a-z\s-]/g, '').replace(/\s+/g, ' ').trim();
    if (c && c.split(' ').length <= 3 && !NOT_FURNITURE.test(c)) out.add(c);
  }
  return [...(out.size ? out : FALLBACK_CONCEPTS)].slice(0, max);
}

interface Ctx {
  run: ReconstructionRun;
  budget: AiBudget;
  save: () => Promise<void>;
  log: (step: string, message: string, level?: StepLog['level']) => Promise<void>;
  setState: (state: ReconstructionRun['state'], step: string, progress: number) => Promise<void>;
}

const now = () => new Date().toISOString();

export async function runPipeline(runId: string, opts: { forceReparse?: boolean; sam3dApproved?: boolean; sam3dMaxObjects?: number } = {}): Promise<void> {
  const run = store.get('runs', runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const budget = new AiBudget();
  let saving: Promise<void> = Promise.resolve();
  const ctx: Ctx = {
    run,
    budget,
    save: () => {
      // Serialised: parallel steps must not interleave writes of the run file.
      saving = saving.catch(() => undefined).then(async () => {
        run.heartbeatAt = now();
        run.aiCalls = budget.usage.calls;
        run.totalCostEstimate = budget.summary();
        await store.put('runs', run.id, run);
      });
      return saving;
    },
    log: async (step, message, level = 'info') => {
      run.logs.push({ at: now(), step, level, message });
      console.log(`[job ${run.id}] ${level === 'info' ? '' : `${level.toUpperCase()} `}${step}: ${message}`);
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
  // Media the user switched off on the review screen is not used; order follows the review screen.
  const allMedia = Object.values(store.all('media')).filter((m) => m.propertyId === property.id);
  const media = allMedia.filter((m) => m.metadata.excluded !== true).sort((a, b) => Number(a.metadata.order ?? 0) - Number(b.metadata.order ?? 0));
  const plans = media.filter((m) => m.type === 'floorplan');
  const photos = media.filter((m) => m.type === 'photo' && m.usageRightsStatus !== 'unverified' && MODEL_IMAGE_TYPES.has(m.mimeType));
  const skippedRights = media.filter((m) => m.usageRightsStatus === 'unverified');
  await ctx.setState('INGESTED', 'ingest', 0.05);
  await ctx.log('ingest', `${plans.length} floor plan(s), ${photos.length} usable photo(s); live Meta inference ${metaConfigured() ? 'ON' : 'OFF (MODEL_API_KEY not set)'}`);
  if (skippedRights.length) await ctx.log('ingest', `${skippedRights.length} media item(s) skipped: usage rights unverified`, 'warn');
  if (allMedia.length > media.length) await ctx.log('ingest', `${allMedia.length - media.length} image(s) left out on the review screen`);
  const corrections = store.get('roomMappings', property.id);
  const isFixture = property.sourceProvider === FIXTURE_PROVIDER;
  const live = metaConfigured();
  if (live) {
    const r = await resolveModels();
    if (r.changed.length) await ctx.log('ingest', `Using the models this API key offers: ${r.changed.join('; ')}`);
    if (r.probes && !r.changed.length && !Object.values(r.probes).includes('ok')) {
      throw new PipelineError('NO_MUSE_MODEL', `Meta rejected every Muse model for this API key (${config.meta.museModel}: ${r.probes[config.meta.museModel] ?? 'no answer'}). Check model access and billing on dev.meta.ai.`);
    }
    if (r.available && !r.available.includes(config.meta.museModel)) {
      throw new PipelineError('NO_MUSE_MODEL', `This Meta API key has no Muse model. Available: ${r.available.join(', ') || 'none'}`);
    }
  }
  run.modelVersions = live ? { muse: config.meta.museModel, sam: config.meta.samModel } : {};
  run.promptVersions = live ? { ...PROMPT_VERSIONS, roomSurvey: SURVEY_PROMPT_VERSION } : {};

  // ---- 2. Layout: floor plan → plan among the photos → photos → listing facts ----
  let planImages = await loadPlanRasters(plans);
  const photoData = await Promise.all(photos.slice(0, 50).map(async (m) => ({ media: m, buf: flattenTransparentPng(await readMedia(m)) })));
  let interp = opts.forceReparse ? undefined : store.get('interpretations', property.id);
  // Estimated layouts are cheap to redo: drop ones made by an older prompt, or without AI now that it's on.
  // Layouts estimated without AI are always redone (cheap, and the person's room hints may have changed).
  if (interp && ((interp.layoutSource === 'photos' && interp.provenance.promptVersion !== PROMPT_VERSIONS.layoutFromPhotos) || (interp.layoutSource === 'listing-details' && live) || (interp.layoutSource !== 'floorplan' && interp.layoutSource !== 'photo-floorplan' && interp.provenance.method === 'deterministic'))) interp = undefined;
  if (interp) {
    await ctx.log('parse', `Reusing cached layout (${interp.layoutSource}, ${interp.provenance.method}); no AI call`);
  } else if (live && planImages.length) {
    interp = await parseWithMuse(ctx, planImages, property.areaSqM, config.meta.museModel);
  } else if (isFixture) {
    interp = FloorplanInterpretation.parse(fixtureFile(property.sourceListingId, 'interpretation.fixture.json'));
    await ctx.log('parse', live ? 'No raster plan available for Muse; using the fixture reference interpretation' : 'Using the fixture reference interpretation (hand-authored stand-in for Muse Spark)', 'warn');
  } else {
    const hints = property.roomHints ?? [];
    const footprint = await buildingOutline(ctx, property);
    const facts = { bedrooms: property.bedrooms, bathrooms: property.bathrooms ?? null, floors: property.floors ?? null, areaSqM: property.areaSqM, propertyType: property.status, description: property.description ?? null, address: property.address };
    if (plans.length && !live) await ctx.log('parse', 'The floor plan can’t be read automatically without MODEL_API_KEY. Trace it in the plan editor (free, no AI) for a plan-accurate model; estimating the layout for now', 'warn');
    else if (!plans.length) await ctx.log('parse', 'No floor plan in this listing; estimating the layout', 'warn');
    if (live && photoData.length) {
      const sample = photoData.slice(0, 20);
      const r = await layoutFromPhotos({ budget, photos: sample.map((p) => toDataUrl(p.buf, p.media.mimeType)), facts });
      if (r.floorplanPhotoIndex != null) {
        // A floor plan was hiding among the photos: read it properly.
        const m = sample[r.floorplanPhotoIndex].media;
        await ctx.log('parse', `Found a floor plan among the listing photos (${m.id}); reading it`);
        planImages = await loadPlanRasters([{ ...m, type: 'floorplan' }]);
        interp = { ...(await parseWithMuse(ctx, planImages, property.areaSqM, config.meta.museModel)), layoutSource: 'photo-floorplan' };
      } else if (r.rooms.length) {
        // The person's own room hints override Muse's reading of the same room.
        // The person (or the listing) said one floor: keep every room on it whatever Muse guessed.
        if (property.floors === 1) r.rooms.forEach((room) => (room.level = 0));
        const rooms = r.rooms.map((room) => {
          const h = hints.find((x) => x.label.trim().toLowerCase() === room.label.trim().toLowerCase());
          return h ? { ...room, ...Object.fromEntries(Object.entries(h).filter(([k, v]) => k !== 'label' && v != null && !(Array.isArray(v) && !v.length))) } : room;
        });
        const links = rooms.reduce((a, x) => a + (x.connectsTo?.length ?? 0), 0);
        await ctx.log('parse', `Muse read ${rooms.length} rooms and ${links} room connections from ${sample.length} photos; arranging them to fit`);
        interp = layoutFromRoomList({ rooms, footprint, hints: { hallway: property.hallway ?? r.hallway, aspect: r.aspect }, statedTotalAreaSqM: property.areaSqM, provenance: r.provenance, uncertainties: r.notes, confidence: 0.45, layoutSource: 'photos' });
      }
    }
    if (!interp) {
      // Rooms the person labelled on the review screen + rooms the facts imply, arranged to fit their hints.
      const labels = [...new Set(photos.map((m) => m.roomGuess?.trim()).filter((l): l is string => !!l))];
      const fromEvidence = labels.length || hints.length;
      const links = hints.reduce((a, h) => a + (h.connectsTo?.length ?? 0), 0);
      interp = layoutFromRoomList({
        rooms: roomListFromEvidence(facts, labels, hints),
        footprint,
        hints: { hallway: property.hallway ?? null },
        statedTotalAreaSqM: property.areaSqM,
        provenance: {
          method: 'deterministic',
          note: fromEvidence ? 'Arranged from the room labels and room relationships entered on the review screen, plus the listing details; no floor plan' : 'Estimated from listing details (bedrooms, area); no floor plan or AI room reading',
          at: now(),
        },
        confidence: fromEvidence ? 0.4 : 0.3,
        layoutSource: fromEvidence ? 'photos' : 'listing-details',
      });
      await ctx.log(
        'parse',
        fromEvidence
          ? `Arranged ${interp.levels[0].rooms.length} rooms from your ${labels.length} photo labels and ${links} room connection(s) (no floor plan, no AI)`
          : `Estimated a layout from the listing details (${property.bedrooms ?? '?'} bedrooms, ${property.areaSqM ? `${property.areaSqM} m²` : 'area unknown'})`,
        'warn',
      );
    }
  }
  // Remap fixture plan media ids onto this property's media ids.
  for (const lvl of interp.levels) {
    const m = plans.find((p) => p.metadata.fixtureMediaId === lvl.planMediaId || p.id === lvl.planMediaId);
    if (m) lvl.planMediaId = m.id;
  }

  let structure = buildFromInterp(interp, property.id, corrections);
  let geomChecks = verifyGeometry(structure, interp, [], [], property.areaSqM);
  if (live && config.meta.escalationEnabled && interp.layoutSource === 'floorplan' && interp.provenance.method === 'meta:muse-spark-1.3' && geomChecks.some((c) => c.severity === 'fail')) {
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
    layoutSource: interp.layoutSource,
    floorplanInterpretedBy: interp.provenance.method,
    photoEvidence: 'none',
    segmentationBy: null,
    sam3d: 'disabled',
    surfacesFromPhotos: 0,
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
      userLabels: Object.fromEntries(photoData.map((p, i) => [i, p.media.roomGuess]).filter(([, l]) => l && !structure.rooms.some((r) => r.id === l))),
    });
    matches = r.matches;
    visibleObjects = r.visibleObjects;
    await ctx.log('match', `Muse matched ${matches.filter((m) => m.roomId).length}/${photos.length} photos to rooms`);
  }
  // Admin corrections and filename pre-assignments override AI matches.
  const manual = new Map<string, string | null>();
  for (const p of photos) {
    const roomId = p.roomGuess ? roomForLabel(structure, p.roomGuess) : null;
    if (roomId) manual.set(p.id, roomId);
    else if (p.roomGuess && !live) await ctx.log('match', `Photo labelled “${p.roomGuess}” matches no room on the plan; assign it on the Rooms tab`, 'warn');
  }
  for (const m of corrections?.mappings ?? []) manual.set(m.mediaId, m.roomId);
  for (const [mediaId, roomId] of manual) {
    matches = matches.filter((m) => m.mediaId !== mediaId);
    matches.push({ mediaId, roomId, confidence: 1, evidence: ['Assigned manually'], provenance: { method: 'admin-correction', at: now() } });
  }
  for (const room of structure.rooms) room.linkedMediaIds = matches.filter((m) => m.roomId === room.id).map((m) => m.mediaId);
  const roomsWithPhotos = structure.rooms.filter((r) => r.linkedMediaIds.length).length;

  // Wall/floor appearance from photos, used to texture the model.
  const roomSurfaces: RoomSurfaces[] = [];
  if (live) {
    await pool(structure.rooms.filter((r) => r.linkedMediaIds.length), 4, async (room) => {
      const roomPhotos = photoData.filter((p) => room.linkedMediaIds.includes(p.media.id)).slice(0, 3);
      try {
        roomSurfaces.push(
          await readRoomSurfaces({ budget, roomId: room.id, roomLabel: room.label, photos: roomPhotos.map((p) => ({ mediaId: p.media.id, dataUrl: toDataUrl(p.buf, p.media.mimeType) })) }),
        );
      } catch (e) {
        await ctx.log('match', `Reading finishes for ${room.label} failed: ${(e as Error).message}`, 'warn');
      }
    });
    if (roomSurfaces.length) await ctx.log('match', `Wall and floor finishes read from photos for ${roomSurfaces.length} room(s)`);
  }
  await ctx.setState('MEDIA_MATCHED', 'match', 0.5);

  // ---- 5. Segmentation -----------------------------------------------------------
  const detections: Detection[] = [];
  if (live && photoData.length) {
    const targets = photoData.filter((p) => matches.some((m) => m.mediaId === p.media.id && m.roomId)).slice(0, config.meta.maxSamImagesPerRun);
    const jobs: { p: (typeof photoData)[number]; size: { width: number; height: number }; concept: string }[] = [];
    for (const p of targets) {
      const size = imageSize(p.buf);
      if (!size) {
        await ctx.log('segment', `Could not read image size for ${p.media.id}; skipped`, 'warn');
        continue;
      }
      for (const concept of samConcepts(visibleObjects[p.media.id] ?? [], config.meta.maxSamConceptsPerImage)) jobs.push({ p, size, concept });
    }
    await ctx.log('segment', `Asking SAM 3.1 for ${jobs.length} object types across ${targets.length} photo(s)…`);
    await mkdir(join(config.dataDir, 'masks'), { recursive: true });
    await pool(jobs, 6, async ({ p, size, concept }) => {
      try {
        const res = await segmentConcept({ budget, mediaId: p.media.id, dataUrl: toDataUrl(p.buf, p.media.mimeType), imageSize: size, concept });
        detections.push(...res.detections);
        for (const m of res.masks) await writeFile(join(config.dataDir, 'masks', `${m.detectionId}.svg`), m.svg);
      } catch (e) {
        await ctx.log('segment', `SAM "${concept}" on ${p.media.id} failed: ${(e as Error).message}`, 'warn');
      }
    });
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
    // Rooms in parallel (3 at a time): each call carries several photos and can take ~30-60 s.
    const rooms = structure.rooms.filter((r) => r.linkedMediaIds.length);
    let done = 0;
    if (rooms.length) await ctx.log('place', `Asking Muse where the furniture goes in ${rooms.length} photographed room(s)…`);
    await pool(rooms, 3, async (room) => {
      const roomPhotos = photoData.filter((p) => room.linkedMediaIds.includes(p.media.id)).slice(0, 3);
      const roomDets = detections.filter((d) => room.linkedMediaIds.includes(d.mediaId));
      const photosIn = roomPhotos.map((p) => ({ mediaId: p.media.id, dataUrl: toDataUrl(p.buf, p.media.mimeType) }));
      // Survey (positions from the photos, checked and corrected in rounds) when SAM outlined things in this room.
      if (roomDets.length) {
        try {
          const level = structure.levels.find((l) => l.id === room.levelId);
          const plan = planImages.find((pi) => pi.media.id === level?.originalPlanMediaId) ?? planImages[0];
          const r = await surveyRoom({
            budget,
            structure,
            roomId: room.id,
            photos: photosIn,
            detections: roomDets,
            planImage: plan?.dataUrl ?? null,
            maxRounds: 3,
            onRound: (round, issues) => ctx.log('place', `${room.label}: survey round ${round}: ${issues.length ? `${issues.length} disagreement(s) with the photos, e.g. ${issues[0]}` : 'positions agree with every photo'}`, issues.length ? 'warn' : 'info'),
          });
          candidates.push(...r.candidates);
          aiRooms.add(room.id);
          await ctx.log('place', `${room.label}: ${r.candidates.length} item(s) placed from the photos after ${r.rounds} round(s)${r.issuesLeft.length ? `, ${r.issuesLeft.length} disagreement(s) left` : ''} (${++done}/${rooms.length})`);
          run.progress = 0.6 + 0.15 * (done / rooms.length);
          await ctx.save();
          return;
        } catch (e) {
          await ctx.log('place', `Survey of ${room.label} failed (${(e as Error).message}); falling back to simple suggestions`, 'warn');
        }
      }
      try {
        const c = await suggestPlacements({ budget, structure, roomId: room.id, photos: photosIn, detections: roomDets });
        candidates.push(...c);
        aiRooms.add(room.id);
        await ctx.log('place', `${room.label}: ${c.length} item(s) suggested (${++done}/${rooms.length})`);
      } catch (e) {
        await ctx.log('place', `Placement suggestions for ${room.label} failed: ${(e as Error).message} (${++done}/${rooms.length})`, 'warn');
      }
      run.progress = 0.6 + 0.15 * (done / rooms.length);
      await ctx.save();
    });
  }
  if (isFixture) {
    const fx = PlacementCandidate.array().parse((fixtureFile(property.sourceListingId, 'placements.fixture.json') as { candidates: unknown }).candidates);
    const extra = fx.filter((c) => !aiRooms.has(c.roomId));
    if (extra.length) await ctx.log('place', `${extra.length} hand-authored placement suggestions used for rooms without AI evidence (labelled as such)`, 'warn');
    candidates = [...candidates, ...extra];
  }
  if (!isFixture) {
    // Rooms with no photo-based suggestions get typical furniture, labelled as such:
    // proposed by Muse when live, otherwise from a fixed table by room type.
    const covered = new Set(candidates.map((c) => c.roomId));
    const empty = structure.rooms.filter((r) => !covered.has(r.id) && r.type !== 'hall' && r.type !== 'landing');
    let typical: PlacementCandidate[] = [];
    if (live && empty.length) {
      try {
        typical = await furnishRooms({ budget, structure, roomIds: empty.map((r) => r.id) });
        await ctx.log('place', `Muse furnished ${new Set(typical.map((c) => c.roomId)).size} room(s) without photos (${typical.length} typical items, not observed)`);
      } catch (e) {
        await ctx.log('place', `Muse furnishing failed, using typical furniture by room type: ${(e as Error).message}`, 'warn');
      }
    }
    const museRooms = new Set(typical.map((c) => c.roomId));
    const table = empty.filter((r) => !museRooms.has(r.id)).flatMap((r) => typicalFurniture(r, now(), structure));
    if (table.length) await ctx.log('place', `${table.length} typical furniture items added by room type (labelled as typical, not observed)`);
    candidates = [...candidates, ...typical, ...table];
  }
  const placed = placeObjects(structure, candidates, { method: 'deterministic', note: 'placement engine', at: now() });
  let objects = applySceneCorrections(placed.objects, structure, property.id);
  await ctx.log('place', `${objects.length} furnishings placed, ${placed.rejected.length} suggestion(s) rejected by constraints`, placed.rejected.length ? 'warn' : 'info');

  // SAM 3D furniture is built AFTER the scene is published (see the end), so it never holds the model back.
  const sam3dState: EvidenceFlags['sam3d'] = 'disabled';
  let sam3dMax = 0;
  if (config.sam3d.enabled) {
    if (config.sam3d.requireManualApproval && !opts.sam3dApproved) await ctx.log('place', 'SAM 3D enabled but this run was not manually approved; proxies kept');
    else if (opts.sam3dMaxObjects === 0) await ctx.log('place', 'SAM 3D skipped for this build (switched off on the review screen); stand-in shapes kept');
    else sam3dMax = opts.sam3dMaxObjects ?? config.sam3d.maxObjectsPerRun;
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
    surfacesFromPhotos: roomSurfaces.length,
    notes: [
      ...(roomSurfaces.length < structure.rooms.length ? [`${structure.rooms.length - roomSurfaces.length} room(s) use default finishes for their room type (no photo to sample).`] : []),
      ...(interp.provenance.method === 'fixture:hand-authored' ? ['Floor plan geometry comes from a hand-authored reference reading, not live Muse inference.'] : []),
      ...(objects.some((o) => o.provenance.note?.includes('fixture')) ? ['Some furniture positions come from hand-authored suggestions, not photo evidence.'] : []),
      ...(objects.some((o) => o.placementNotes.some((n) => n.startsWith('Typical '))) ? ['Furniture in rooms without photos is typical for the room type, not what is actually there.'] : []),
      ...(interp.layoutSource !== 'floorplan' && interp.layoutSource !== 'photo-floorplan'
        ? [interp.layoutSource === 'photos' ? 'No floor plan: the room list was read from the photos and arranged into an estimated layout.' : 'No floor plan or usable photos: the layout is estimated from the listing details.']
        : []),
      objects.some((o) => o.reconstructionMethod === 'sam3d')
        ? 'Most furniture is represented by proxy shapes sized from estimates; items marked SAM 3D were reconstructed from a photo (position and scale still estimated).'
        : 'Furniture is represented by proxy shapes sized from estimates.',
      ...interp.uncertainties,
    ],
  };
  const final = manifest(property.id, prevVersion + 1, true, structure, objects, matches, detections, { geometry, visualReview }, flags, media, roomSurfaces);
  await store.put('scenes', property.id, final);
  run.outputSceneVersion = final.sceneVersion;
  run.finishedAt = now();
  await ctx.setState('READY', 'done', 1);
  await ctx.log('done', `Scene v${final.sceneVersion} ready. ${budget.summary()}`);

  // ---- 9. Real furniture (SAM 3D), after the scene is out ---------------------------
  if (sam3dMax > 0) await buildFurniture3d(ctx, property.id, objects, detections, sam3dMax);
}

/** Rebuild photographed furniture with SAM 3D and swap each model into the published scene as it lands. */
async function buildFurniture3d(ctx: Ctx, propertyId: string, objects: SceneObject[], detections: Detection[], max: number) {
  const update = async (fn: (s: SceneManifest) => void) => {
    const cur = store.get('scenes', propertyId);
    if (!cur) return;
    fn(cur);
    cur.sceneVersion += 1;
    cur.generatedAt = now();
    await store.put('scenes', propertyId, cur);
  };
  let done = 0;
  let failed = 0;
  const r = await requestSam3d({
    objects,
    detections,
    max,
    log: (m, l) => ctx.log('furniture-3d', m, l),
    onStart: (total) => update((s) => (s.furniture3d = { total, done: 0, failed: 0, running: total > 0 })),
    onResult: (obj) =>
      update((s) => {
        if (obj) {
          done++;
          s.objects = s.objects.map((o) => (o.id === obj.id ? { ...obj, positionXYZ: o.positionXYZ, rotationY: o.rotationY } : o));
          s.evidenceFlags = { ...s.evidenceFlags, sam3d: 'used' };
        } else failed++;
        s.furniture3d = { total: s.furniture3d?.total ?? 0, done, failed, running: true };
      }),
  });
  await update((s) => {
    s.furniture3d = { total: s.furniture3d?.total ?? 0, done, failed, running: false };
    if (r.state === 'used') s.evidenceFlags = { ...s.evidenceFlags, sam3d: 'used', notes: s.evidenceFlags.notes.map((n) => (n.startsWith('Furniture is represented by proxy') ? `${done} piece(s) of furniture were reconstructed from the photos with SAM 3D; the rest are stand-in shapes.` : n)) };
  });
}

// ---------------------------------------------------------------------------

/**
 * The building's real outline from OpenStreetMap, fetched once per property and cached on it.
 * Coordinates come from the listing, else from geocoding the address. Never fatal.
 */
async function buildingOutline(ctx: Ctx, property: NonNullable<ReturnType<typeof store.get<'properties'>>>): Promise<Vec2[] | null> {
  if (property.useFootprint === false) {
    await ctx.log('parse', 'Building outline switched off for this property; using an estimated rectangle');
    return null;
  }
  if (property.footprint !== undefined) {
    if (property.footprint) await ctx.log('parse', `Using the building outline from OpenStreetMap (${property.footprint.osmId}, ${property.footprint.areaSqM} m² footprint)`);
    return property.footprint?.polygonM ?? null;
  }
  let loc = property.location;
  try {
    if (!loc && property.address && !/^(uploaded property|imported images|untitled)/i.test(property.address)) {
      const g = await geocode(property.address);
      if (g) loc = { lat: g.lat, lng: g.lng };
    }
    if (!loc) {
      await ctx.log('parse', 'No location for this property (add the full address on the review screen) — the building outline can’t be looked up', 'warn');
      return null;
    }
    const fp = await fetchFootprint(loc.lat, loc.lng);
    const next = { ...property, location: loc, footprint: fp ? { ...fp, fetchedAt: now() } : null };
    await store.put('properties', property.id, next);
    if (!fp) {
      await ctx.log('parse', 'OpenStreetMap has no building outline at this address; using an estimated rectangle', 'warn');
      return null;
    }
    await ctx.log('parse', `Building outline from OpenStreetMap: ${fp.osmId}, ${fp.polygonM.length} corners, ${fp.areaSqM} m² footprint${property.areaSqM ? ` (listing says ${property.areaSqM} m² living area)` : ''}; front chosen by ${fp.front === 'nearest-road' ? 'the nearest street' : 'the longest side'}`);
    return fp.polygonM;
  } catch (e) {
    await ctx.log('parse', `Building outline lookup failed (${(e as Error).message}); using an estimated rectangle`, 'warn');
    return null;
  }
}

/**
 * Room for a user-supplied label: a room id, an exact label ("Bedroom 2"), or a
 * room type that only one room has ("Kitchen"). Ambiguous labels return null.
 */
export function roomForLabel(structure: Structure, label: string): string | null {
  const l = label.trim().toLowerCase();
  if (!l) return null;
  const byId = structure.rooms.find((r) => r.id === label);
  if (byId) return byId.id;
  const exact = structure.rooms.filter((r) => r.label.trim().toLowerCase() === l);
  if (exact.length === 1) return exact[0].id;
  const TYPES: [RegExp, Structure['rooms'][number]['type']][] = [
    [/kitchen/, 'kitchen'],
    [/living|lounge|sitting|reception/, 'living'],
    [/dining/, 'dining'],
    [/bed/, 'bedroom'],
    [/bath|shower|en-?suite/, 'bathroom'],
    [/\bwc\b|toilet|cloak/, 'wc'],
    [/hall|entrance/, 'hall'],
    [/landing/, 'landing'],
    [/study|office/, 'study'],
    [/utility|laundry/, 'utility'],
  ];
  const type = TYPES.find(([re]) => re.test(l))?.[1];
  if (!type) return null;
  const ofType = structure.rooms.filter((r) => r.type === type || r.label.toLowerCase().includes(l));
  return ofType.length === 1 ? ofType[0].id : null;
}

async function parseWithMuse(ctx: Ctx, planImages: PlanRaster[], areaSqM: number | null, model: string): Promise<FloorplanInterpretation> {
  await ctx.log('parse', `Reading ${planImages.length} plan image(s) with ${model}`);
  const parts = [];
  for (const [i, p] of planImages.entries()) {
    try {
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
          onEmpty: (note) => ctx.log('parse', `Muse returned no rooms for plan ${i + 1} (${note}); retrying with more effort`, 'warn'),
        }),
      );
    } catch (e) {
      if (e instanceof FloorplanUnreadableError) throw new PipelineError('FLOORPLAN_UNREADABLE', e.message);
      throw e;
    }
    await ctx.save();
  }
  return assembleInterpretation(parts, areaSqM);
}

function buildFromInterp(interp: FloorplanInterpretation, propertyId: string, corrections: ReturnType<typeof store.get<'roomMappings'>>): Structure {
  let scaleOverride: { metersPerPx: number; method: 'user-reference' | 'estimated-layout' } | undefined =
    interp.layoutSource === 'photos' || interp.layoutSource === 'listing-details' ? { metersPerPx: 0.01, method: 'estimated-layout' } : undefined;
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
    const issues = validateFootprint(objectFootprint(next), room.polygonXZMeters, [], out.filter((p) => p.roomId === o.roomId).map((p) => ({ id: p.id, fp: objectFootprint(p), ...objectSpan(p) })), objectSpan(next));
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
    const buf = flattenTransparentPng(await readFile(path));
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
  roomSurfaces: RoomSurfaces[] = [],
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
    roomSurfaces,
    verification,
    evidenceFlags,
    previewCamera: { position: [cx + span * 0.9, span * 1.1, cz + span * 1.3], target: [cx, 1.2, cz] },
  });
}

/** Run fn over items with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
