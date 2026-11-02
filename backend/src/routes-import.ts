/**
 * Import → review → (optional) plan tracing → per-object SAM 3D.
 *
 * These endpoints are deliberately independent of the browser UI so a future
 * browser extension can post the same payloads (listing URL, image URLs or
 * image bytes) and open the result in WalkIn.
 */
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { geocode } from './providers/geo.js';
import { FloorplanInterpretation, type Property, PlanLevel, polygonArea, polygonSelfIntersects, RoomHint, ExteriorFinish } from './shared/index.js';
import { config, metaConfigured } from './config.js';
import { HttpError, Id, now, parse, rateLimit, requireProperty } from './http.js';
import { flattenTransparentPng, toDataUrl } from './lib/image.js';
import { FetchBlockedError } from './lib/safe-fetch.js';
import { AiBudget } from './meta/client.js';
import { classifyImages } from './meta/muse.js';
import { resolveModels } from './meta/models.js';
import { resolveStorageKey } from './providers/fixture.js';
import { addImage, addImageUrls, createUploadProperty, importFromListingUrl, IngestError, MAX_IMAGE_BYTES, realtyIdFromUrl } from './providers/ingest.js';
import { ExtractionError } from './providers/listing-url.js';
import { attachFloorPlans, floorPlansElsewhere, importRealty, realtyStatus } from './providers/realtyapi.js';
import { detectionFor, reconstructObject, sam3dReady, Sam3dUnavailableError } from './jobs/sam3d.js';
import { store } from './store.js';

const RightsConfirmed = z.literal(true, { message: 'Confirm that you own these images or have permission to use them.' });

const mapErrors = (e: unknown): never => {
  if (e instanceof HttpError) throw e;
  if (e instanceof IngestError) throw new HttpError(e.status, e.code, e.message);
  if (e instanceof FetchBlockedError) throw new HttpError(400, e.code, e.message);
  if (e instanceof ExtractionError) throw new HttpError(422, e.code, e.message);
  throw e;
};

function requireMedia(id: string) {
  const m = store.get('media', parse(Id, id));
  if (!m) throw new HttpError(404, 'NOT_FOUND', 'Media not found');
  return m;
}

const mediaFor = (propertyId: string) =>
  Object.values(store.all('media'))
    .filter((m) => m.propertyId === propertyId)
    .sort((a, b) => Number(a.metadata.order ?? 0) - Number(b.metadata.order ?? 0));

export async function registerImportRoutes(app: FastifyInstance) {
  // Raw image bodies (one image per request keeps memory and limits simple).
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) => done(null, body));

  /** Empty property for uploads / image links. */
  app.post('/api/properties', async (req) => {
    rateLimit(req, 30);
    const body = parse(
      z.object({
        title: z.string().max(200).optional(),
        address: z.string().max(200).optional(),
        listingUrl: z.string().url().max(2000).optional(),
        bedrooms: z.number().int().min(0).max(30).optional(),
        areaSqM: z.number().positive().max(5000).optional(),
        rightsConfirmed: RightsConfirmed,
      }),
      req.body,
    );
    const property = createUploadProperty(body, 'Uploaded by the user');
    await store.put('properties', property.id, property);
    return { property, media: [] };
  });

  /** Listing URL → property + downloaded images. Portals the RealtyAPI adapter knows go through it when a key is set. */
  app.post('/api/imports/listing', async (req) => {
    rateLimit(req, 10);
    const body = parse(z.object({ url: z.string().min(8).max(2000), rightsConfirmed: RightsConfirmed }), req.body);
    const known = realtyIdFromUrl(body.url);
    if (known && realtyStatus().available) {
      const id = `prop-${known.provider}-${known.listingId}`;
      const existing = store.get('properties', id);
      try {
        const imported = await importRealty(known.provider, known.listingId, id, existing?.createdAt ?? now());
        imported.property.updatedAt = now();
        await store.put('properties', id, imported.property);
        for (const m of mediaFor(id)) await store.del('media', m.id);
        for (const [i, m] of imported.media.entries()) await store.put('media', m.id, { ...m, metadata: { ...m.metadata, order: i, importedVia: 'listing-api' } });
        const notes: string[] = [];
        // No floor plan on this portal? The same home's listing elsewhere often has one.
        if (!imported.media.some((m) => m.type === 'floorplan') && imported.property.location) {
          const r = await findAndAttachPlans(imported.property).catch((e) => ({ added: 0, note: `Floor plan search elsewhere failed: ${(e as Error).message}` }));
          notes.push(r.note);
        }
        const media = mediaFor(id);
        return { property: store.get('properties', id)!, media, extraction: { adapter: `realtyapi:${known.provider}`, found: media.length, floorplans: media.filter((m) => m.type === 'floorplan').length, downloaded: media.length, failed: [], notes } };
      } catch (e) {
        req.log.warn({ err: (e as Error).message }, 'RealtyAPI import failed; trying the public page');
      }
    }
    try {
      return await importFromListingUrl(body.url);
    } catch (e) {
      return mapErrors(e);
    }
  });

  /**
   * What the "Send to WalkIn" button collected from a listing page open in the person's own browser
   * (the same payload a future browser extension will post). Images are downloaded and checked here;
   * anything that looks like a drawing becomes a floor plan.
   */
  app.post('/api/imports/collected', async (req) => {
    rateLimit(req, 10);
    const body = parse(
      z.object({
        title: z.string().max(300).optional(),
        pageUrl: z.string().max(2000).optional(),
        images: z.array(z.object({ url: z.string().max(2000), plan: z.boolean().optional() })).min(1).max(120),
        rightsConfirmed: RightsConfirmed,
      }),
      req.body,
    );
    const host = (() => {
      try {
        return new URL(body.pageUrl ?? '').hostname.replace(/^www\./, '');
      } catch {
        return 'a listing page';
      }
    })();
    const property = createUploadProperty({ title: body.title?.split(/\s[|\-–]\s/)[0], listingUrl: body.pageUrl ?? null }, `Collected from ${host} in the user’s browser`);
    property.sourceProvider = 'browser';
    await store.put('properties', property.id, property);
    // Plans first so the cap never drops them; then photos.
    const items = [...body.images.filter((i) => i.plan), ...body.images.filter((i) => !i.plan)].slice(0, 60).map((i) => ({ url: i.url, type: i.plan ? ('floorplan' as const) : undefined }));
    const results = await addImageUrls(property, items, 'image-url');
    const media = mediaFor(property.id);
    return { property, media, results: { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, floorplans: media.filter((m) => m.type === 'floorplan').length } };
  });

  /** One raw image (JPG/PNG/WebP) per request. Query: type, filename, room. Header x-rights-confirmed: true. */
  app.post('/api/properties/:propertyId/media', { bodyLimit: MAX_IMAGE_BYTES }, async (req) => {
    rateLimit(req, 240);
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    if (req.headers['x-rights-confirmed'] !== 'true') throw new HttpError(400, 'RIGHTS_NOT_CONFIRMED', 'Confirm that you own these images or have permission to use them.');
    const q = parse(z.object({ type: z.enum(['photo', 'floorplan']).optional(), filename: z.string().max(200).optional(), room: z.string().max(60).optional() }), req.query);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'UNSUPPORTED_IMAGE', 'Send the image bytes with an image/jpeg, image/png or image/webp content type.');
    try {
      const { media, duplicate } = await addImage(property, req.body, { type: q.type, filename: q.filename, roomLabel: q.room, via: 'upload' });
      return { media, duplicate };
    } catch (e) {
      return mapErrors(e);
    }
  });

  app.post('/api/properties/:propertyId/media/urls', async (req) => {
    rateLimit(req, 20);
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    const body = parse(
      z.object({
        urls: z.array(z.union([z.string().max(2000), z.object({ url: z.string().max(2000), type: z.enum(['photo', 'floorplan']).optional(), roomLabel: z.string().max(60).optional() })])).min(1).max(30),
        rightsConfirmed: RightsConfirmed,
      }),
      req.body,
    );
    const items = body.urls.map((u) => (typeof u === 'string' ? { url: u.trim() } : u));
    const results = await addImageUrls(property, items, 'image-url');
    return { results, media: mediaFor(property.id) };
  });

  /** Review-screen edits: type, room label, included, level. */
  app.patch('/api/media/:mediaId', async (req) => {
    const m = requireMedia((req.params as { mediaId: string }).mediaId);
    const p = parse(
      z.object({ type: z.enum(['photo', 'floorplan']).optional(), roomGuess: z.string().max(60).nullable().optional(), excluded: z.boolean().optional(), levelGuess: z.string().max(40).nullable().optional() }),
      req.body,
    );
    const next = { ...m, metadata: { ...m.metadata } };
    if (p.type) {
      next.type = p.type;
      next.metadata.typeSource = 'user';
    }
    if (p.roomGuess !== undefined) next.roomGuess = p.roomGuess?.trim() || null;
    if (p.levelGuess !== undefined) next.levelGuess = p.levelGuess;
    if (p.excluded !== undefined) next.metadata.excluded = p.excluded;
    await store.put('media', m.id, next);
    return { media: next };
  });

  app.delete('/api/media/:mediaId', async (req) => {
    const m = requireMedia((req.params as { mediaId: string }).mediaId);
    await store.del('media', m.id);
    if (m.storageKey.startsWith('uploads/')) {
      const abs = resolveStorageKey(m.storageKey);
      if (abs) await unlink(abs).catch(() => undefined);
    }
    return { deleted: m.id };
  });

  app.put('/api/properties/:propertyId/media-order', async (req) => {
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    const { mediaIds } = parse(z.object({ mediaIds: z.array(Id).max(200) }), req.body);
    const own = mediaFor(property.id);
    const ordered = [...mediaIds.map((id) => own.find((m) => m.id === id)).filter((m) => !!m), ...own.filter((m) => !mediaIds.includes(m.id))];
    for (const [i, m] of ordered.entries()) if (m.metadata.order !== i) await store.put('media', m.id, { ...m, metadata: { ...m.metadata, order: i } });
    return { media: mediaFor(property.id) };
  });

  app.patch('/api/properties/:propertyId', async (req) => {
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    const p = parse(z.object({ address: z.string().min(1).max(200).optional(), bedrooms: z.number().int().min(0).max(30).nullable().optional(), bathrooms: z.number().min(0).max(20).nullable().optional(), floors: z.number().int().min(1).max(6).nullable().optional(), roomHints: z.array(RoomHint).max(30).optional(), hallway: z.boolean().nullable().optional(), exterior: ExteriorFinish.optional(), useFootprint: z.boolean().optional(), areaSqM: z.number().positive().max(5000).nullable().optional() }), req.body);
    const next = { ...property, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)), updatedAt: now() };
    // A new address on an uploaded property means a new location: look the building outline up again.
    if (p.address && p.address !== property.address && (property.sourceProvider === 'upload' || property.sourceProvider === 'listing-url')) {
      next.location = null;
      delete next.footprint;
    }
    await store.put('properties', property.id, next);
    return { property: next };
  });

  /** Muse looks at every included image once: floor plan or photo, which room, same-room groups. Suggestions only. */
  app.post('/api/properties/:propertyId/media/suggest', async (req) => {
    rateLimit(req, 4);
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    if (!metaConfigured()) throw new HttpError(503, 'META_NOT_CONFIGURED', 'Automatic room suggestions need MODEL_API_KEY on the server. You can label the images yourself.');
    await resolveModels();
    const media = mediaFor(property.id).filter((m) => m.metadata.excluded !== true && m.usageRightsStatus !== 'unverified').slice(0, 24);
    if (!media.length) throw new HttpError(400, 'NO_MEDIA', 'Add some images first.');
    const images = await Promise.all(media.map(async (m) => toDataUrl(flattenTransparentPng(await readFile(resolveStorageKey(m.storageKey)!)), m.mimeType)));
    const budget = new AiBudget(1);
    const r = await classifyImages({ budget, images });
    const out = [];
    for (const c of r.images) {
      const m = media[c.index];
      const suggestion = {
        kind: c.kind,
        roomLabel: c.kind === 'photo' ? c.roomLabel : null,
        roomType: c.roomType,
        sameRoomAs: c.sameRoomAs.map((j) => media[j]?.id).filter(Boolean),
        objects: c.objects,
        materials: c.materials,
        confidence: c.confidence,
        source: config.meta.museModel,
        promptVersion: r.provenance.promptVersion,
        at: r.provenance.at,
      };
      const next = { ...m, metadata: { ...m.metadata, suggestion } };
      await store.put('media', m.id, next);
      out.push(next);
    }
    return { media: mediaFor(property.id), aiCalls: budget.usage.calls, model: r.provenance.model };
  });

  /** Look for this home's floor plan on another portal (Realtor.com via RealtyAPI). */
  app.post('/api/properties/:propertyId/find-floorplan', async (req) => {
    rateLimit(req, 6);
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    if (!realtyStatus().available) throw new HttpError(503, 'REALTY_NOT_CONFIGURED', 'Looking up other listings needs REALTYAPI_KEY on the server.');
    if (!property.location && !/^\d/.test(property.address)) throw new HttpError(400, 'NO_ADDRESS', 'Enter the full street address (e.g. 201 NW 61st Ave, Miami, FL 33126) first.');
    const r = await findAndAttachPlans(property);
    return { ...r, media: mediaFor(property.id) };
  });

  // ---------------------------------------------------------------- plan editor
  app.get('/api/properties/:propertyId/interpretation', async (req) => {
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    return { interpretation: store.get('interpretations', property.id) ?? null };
  });

  /** Save a traced / corrected floor plan. It becomes the layout for every later rebuild (no AI needed). */
  app.put('/api/properties/:propertyId/interpretation', async (req) => {
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    const body = parse(z.object({ levels: z.array(PlanLevel).min(1).max(6), statedTotalAreaSqM: z.number().positive().nullable().default(null), uncertainties: z.array(z.string().max(300)).max(30).default([]) }), req.body);
    const problems: string[] = [];
    const ids = new Set<string>();
    for (const l of body.levels) {
      if (!store.get('media', l.planMediaId) || store.get('media', l.planMediaId)!.propertyId !== property.id) problems.push(`Level ${l.name}: unknown floor plan image`);
      for (const r of l.rooms) {
        if (ids.has(r.id)) problems.push(`Duplicate room id ${r.id}`);
        ids.add(r.id);
        if (polygonArea(r.polygonPx) < 25) problems.push(`${r.label}: room outline is too small`);
        if (polygonSelfIntersects(r.polygonPx)) problems.push(`${r.label}: room outline crosses itself`);
      }
      for (const o of l.openings) if (o.roomIds.some((id) => !l.rooms.some((r) => r.id === id))) problems.push(`Opening ${o.id} refers to a room that isn’t on ${l.name}`);
    }
    if (problems.length) throw new HttpError(400, 'INVALID_PLAN', problems.slice(0, 6).join('; '));
    const prev = store.get('interpretations', property.id);
    const interp = FloorplanInterpretation.parse({
      layoutSource: 'floorplan',
      levels: body.levels,
      statedTotalAreaSqM: body.statedTotalAreaSqM,
      uncertainties: body.uncertainties,
      provenance: {
        method: 'admin-correction',
        note: prev && prev.provenance.method !== 'admin-correction' ? `Edited by hand in the plan editor (started from ${prev.provenance.method})` : 'Traced by hand in the plan editor',
        at: now(),
      },
    });
    await store.put('interpretations', property.id, interp);
    return { interpretation: interp, note: 'Saved. Rebuild to see it in 3D; the traced plan is used instead of an AI reading.' };
  });

  // ---------------------------------------------------------------- SAM 3D per object
  app.get('/api/sam3d/status', async () => sam3dReady());

  /** Reconstruct one selected object from one SAM 3.1 mask. Paid GPU: needs explicit approval in the body. */
  app.post('/api/properties/:propertyId/objects/:objectId/reconstruct-3d', async (req, reply) => {
    rateLimit(req, 6);
    const { propertyId, objectId } = req.params as { propertyId: string; objectId: string };
    const property = requireProperty(propertyId);
    const body = parse(z.object({ detectionId: z.string().max(200).optional(), approveGpuCost: z.literal(true, { message: 'SAM 3D uses paid GPU time; approve it explicitly.' }) }), req.body);
    const ready = sam3dReady();
    if (!ready.ok) throw new HttpError(503, 'SAM3D_NOT_CONFIGURED', ready.reason);
    const scene = store.get('scenes', property.id);
    const obj = scene?.objects.find((o) => o.id === objectId);
    if (!scene || !obj) throw new HttpError(404, 'NOT_FOUND', 'Object not found in the current scene');
    const det = body.detectionId ? scene.detections.find((d) => d.id === body.detectionId) : detectionFor(obj, scene.detections);
    if (!det) throw new HttpError(400, 'NO_MASK', 'This object has no SAM 3.1 mask from a photo yet. Segmentation runs during a live rebuild (needs MODEL_API_KEY).');
    const running = Object.values(store.all('objectJobs')).find((j) => j.propertyId === property.id && j.state === 'running');
    if (running) return reply.status(202).send({ job: running, reused: true });
    const job = { id: `obj-${Date.now()}-${randomUUID().slice(0, 6)}`, propertyId: property.id, objectId, detectionId: det.id, state: 'running' as const, message: 'Sent to SAM 3D', startedAt: now(), finishedAt: null };
    await store.put('objectJobs', job.id, job);
    void (async () => {
      const log = async (m: string) => void req.log.info(`[sam3d ${job.id}] ${m}`);
      try {
        const r = await reconstructObject(obj, det, log);
        if (r.ok) {
          const cur = store.get('scenes', property.id)!;
          cur.objects = cur.objects.map((o) => (o.id === objectId ? { ...r.object, positionXYZ: o.positionXYZ, rotationY: o.rotationY } : o));
          cur.evidenceFlags = { ...cur.evidenceFlags, sam3d: 'used' };
          cur.sceneVersion += 1;
          cur.generatedAt = now();
          await store.put('scenes', property.id, cur);
        }
        await store.put('objectJobs', job.id, { ...job, state: r.ok ? 'done' : 'failed', message: r.message, finishedAt: now() });
      } catch (e) {
        await store.put('objectJobs', job.id, { ...job, state: 'failed', message: e instanceof Sam3dUnavailableError ? e.message : `SAM 3D request failed: ${(e as Error).message}`, finishedAt: now() });
      }
    })();
    return reply.status(202).send({ job, reused: false });
  });

  app.get('/api/object-jobs/:jobId', async (req) => {
    const job = store.get('objectJobs', parse(Id, (req.params as { jobId: string }).jobId));
    if (!job) throw new HttpError(404, 'NOT_FOUND', 'Job not found');
    return job;
  });
}

/** Find the same home's floor plans on another portal and attach them as floor-plan media. */
async function findAndAttachPlans(property: Property): Promise<{ added: number; foundOn: string | null; note: string }> {
  let loc = property.location;
  if (!loc) {
    const g = await geocode(property.address);
    if (g) loc = { lat: g.lat, lng: g.lng };
  }
  if (!loc) return { added: 0, foundOn: null, note: 'Couldn’t locate this address to look for its floor plan elsewhere.' };
  const r = await floorPlansElsewhere(property.address, loc.lat, loc.lng);
  if (!r.urls.length) return { added: 0, foundOn: null, note: `No floor plan found for this address on other sites (tried ${r.tried.join(', ') || 'none'}). You can add one yourself: screenshot it and drop it in.` };
  const existing = Object.values(store.all('media')).filter((m) => m.propertyId === property.id && m.type === 'floorplan').length;
  const added = await attachFloorPlans(property.id, r.urls, r.foundOn!, existing);
  for (const m of added) await store.put('media', m.id, m);
  if (!property.location) await store.put('properties', property.id, { ...property, location: loc });
  return { added: added.length, foundOn: r.foundOn, note: added.length ? `Found ${added.length} floor plan(s) on the same home's ${r.foundOn} listing.` : `A floor plan exists on ${r.foundOn} but couldn’t be downloaded.` };
}
