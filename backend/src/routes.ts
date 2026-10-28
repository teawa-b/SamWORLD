import { createReadStream } from 'node:fs';
import { lastResolution } from './meta/models.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RoomMappingPatch, SceneCorrectionPatch, type ReconstructionRun } from './shared/index.js';
import { capabilities, config, metaConfigured } from './config.js';
import { AiBudget } from './meta/client.js';
import { redesignRoom, REDESIGN_PROMPT_VERSION } from './meta/image.js';
import { FIXTURE_PROVIDER, fixtureThumbnail, importFixture, resolveStorageKey, searchFixtures } from './providers/fixture.js';
import { importRealty, isRealtyProvider, providersFor, realtyStatus, searchNearby, type NearbyListing } from './providers/realtyapi.js';
import { geocode, reverseGeocode } from './providers/geo.js';
import { store } from './store.js';
import { MODEL_IMAGE_TYPES, toDataUrl } from './lib/image.js';
import { readFile } from 'node:fs/promises';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, 'BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

// Per-IP token bucket for endpoints that can spend money.
const buckets = new Map<string, { tokens: number; at: number }>();
function rateLimit(req: FastifyRequest, perMinute: number) {
  const key = `${req.ip}:${req.routeOptions.url}`;
  const b = buckets.get(key) ?? { tokens: perMinute, at: Date.now() };
  b.tokens = Math.min(perMinute, b.tokens + ((Date.now() - b.at) / 60_000) * perMinute);
  b.at = Date.now();
  if (b.tokens < 1) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests; try again shortly.');
  b.tokens -= 1;
  buckets.set(key, b);
}

function requireProperty(id: string) {
  const p = store.get('properties', parse(Id, id));
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  return p;
}

function sendFile(reply: FastifyReply, abs: string, mime: string) {
  reply.header('content-type', mime).header('cache-control', 'public, max-age=300').header('x-content-type-options', 'nosniff');
  if (mime === 'image/svg+xml') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
  return reply.send(createReadStream(abs));
}

export async function registerRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { status?: number; statusCode?: number; code?: string };
    const status = e instanceof HttpError ? e.status : (e.statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: { code: e.code ?? 'INTERNAL', message: status >= 500 && !(e instanceof HttpError) ? 'Internal error' : e.message } });
  });

  app.get('/health', async () => ({ ok: true, time: now(), capabilities: capabilities(), realtyApi: realtyStatus(), metaModels: lastResolution && { available: lastResolution.available, changed: lastResolution.changed, error: lastResolution.error ?? null } }));

  app.get('/api/properties/search', async (req) => {
    const { q } = parse(z.object({ q: z.string().max(200).default('') }), req.query);
    const imported = Object.values(store.all('properties'));
    const results = searchFixtures(q).map((r) => ({ ...r, importedPropertyId: imported.find((p) => p.sourceProvider === r.provider && p.sourceListingId === r.listingId)?.id ?? null }));
    return { results, providerNotice: null };
  });

  app.get('/api/geocode', async (req) => {
    rateLimit(req, 30);
    const { q } = parse(z.object({ q: z.string().min(2).max(200) }), req.query);
    const place = await geocode(q);
    if (!place) throw new HttpError(404, 'NOT_FOUND', 'No place matches that search.');
    return { place };
  });

  // Listings near a point: Zoopla in the UK, Zillow + Realtor.com in the US.
  app.get('/api/listings/nearby', async (req) => {
    rateLimit(req, 20);
    const q = parse(
      z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), mode: z.enum(['rent', 'buy']).default('rent') }),
      req.query,
    );
    const place = await reverseGeocode(q.lat, q.lng).catch(() => ({ lat: q.lat, lng: q.lng, label: '', countryCode: '' }));
    const providers = providersFor(place.countryCode);
    if (!providers.length) return { place, providers, listings: [], notice: 'Listings are available in the UK (Zoopla) and the US (Zillow, Realtor.com). Try somewhere there.' };
    const status = realtyStatus();
    if (!status.available) return { place, providers, listings: [], notice: `Live listings unavailable: ${status.reason}` };
    const results = await Promise.allSettled(providers.map((p) => searchNearby(p, q.lat, q.lng, q.mode)));
    const listings: NearbyListing[] = [];
    const failures: string[] = [];
    results.forEach((r, i) => (r.status === 'fulfilled' ? listings.push(...r.value) : failures.push(`${providers[i]}: ${(r.reason as Error).message}`)));
    // Nearest first.
    const d = (l: NearbyListing) => (l.lat - q.lat) ** 2 + ((l.lng - q.lng) * Math.cos((q.lat * Math.PI) / 180)) ** 2;
    listings.sort((a, b) => d(a) - d(b));
    const imported = Object.values(store.all('properties'));
    return {
      place,
      providers,
      listings: listings.slice(0, 40).map((l) => ({ ...l, importedPropertyId: imported.find((p) => p.sourceProvider === l.provider && p.sourceListingId === l.listingId)?.id ?? null })),
      notice: failures.length ? `Some providers didn’t answer: ${failures.join('; ')}` : listings.length ? null : 'No listings found right here. Try a busier area or switch between rent and buy.',
    };
  });

  app.get('/api/listings/fixture/:listingId/thumbnail', async (req, reply) => {
    const t = fixtureThumbnail(parse(Id, (req.params as { listingId: string }).listingId));
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'No thumbnail');
    return sendFile(reply, t.path, t.mime);
  });

  app.post('/api/properties/import', async (req) => {
    rateLimit(req, 20);
    const body = parse(z.object({ provider: z.string(), listingId: z.string().regex(/^[A-Za-z0-9_:-]{1,100}$/) }), req.body);
    const isFixture = body.provider === FIXTURE_PROVIDER;
    if (!isFixture && !isRealtyProvider(body.provider)) throw new HttpError(400, 'PROVIDER_NOT_ALLOWED', 'Only allow-listed providers can be imported.');
    const existing = Object.values(store.all('properties')).find((p) => p.sourceProvider === body.provider && p.sourceListingId === body.listingId);
    const id = existing?.id ?? (isFixture ? `prop-${body.listingId}` : `prop-${body.provider}-${body.listingId.replace(/:/g, '-')}`);
    const imported = isFixture ? importFixture(body.listingId, id, existing?.createdAt ?? now()) : await importRealty(body.provider as 'zoopla', body.listingId, id, existing?.createdAt ?? now());
    if (!imported) throw new HttpError(404, 'NOT_FOUND', 'Listing not found');
    imported.property.updatedAt = now();
    await store.put('properties', id, imported.property);
    for (const m of Object.values(store.all('media')).filter((m) => m.propertyId === id)) await store.del('media', m.id);
    for (const m of imported.media) await store.put('media', m.id, m);
    return { property: imported.property, media: imported.media };
  });

  app.get('/api/properties/:propertyId', async (req) => {
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    const runs = Object.values(store.all('runs')).filter((r) => r.propertyId === property.id).sort((a, b) => b.id.localeCompare(a.id));
    return { property, latestRun: runs[0] ?? null, hasScene: !!store.get('scenes', property.id) };
  });

  app.get('/api/properties/:propertyId/media', async (req) => {
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    return { media: Object.values(store.all('media')).filter((m) => m.propertyId === property.id) };
  });

  app.get('/api/media/:mediaId', async (req, reply) => {
    const m = store.get('media', parse(Id, (req.params as { mediaId: string }).mediaId));
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'Media not found');
    const abs = resolveStorageKey(m.storageKey);
    if (!abs) throw new HttpError(404, 'NOT_FOUND', 'Media file missing');
    return sendFile(reply, abs, m.mimeType);
  });

  app.get('/api/masks/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    parse(Id, file.replace(/\.svg$/, ''));
    const abs = resolve(config.dataDir, 'masks', file);
    if (relative(join(config.dataDir, 'masks'), abs).startsWith('..') || !abs.endsWith('.svg')) throw new HttpError(400, 'BAD_REQUEST', 'Invalid mask');
    if (!resolveStorageKey(relative(config.dataDir, abs))) throw new HttpError(404, 'NOT_FOUND', 'Mask not found');
    return sendFile(reply, abs, 'image/svg+xml');
  });

  app.post('/api/properties/:propertyId/reconstruct', async (req, reply) => {
    rateLimit(req, 6);
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    const opts = parse(z.object({ forceReparse: z.boolean().default(false), sam3dApproved: z.boolean().default(false) }).default({ forceReparse: false, sam3dApproved: false }), req.body ?? {});
    const active = Object.values(store.all('runs')).find((r) => r.propertyId === property.id && !['READY', 'FAILED'].includes(r.state));
    if (active) return reply.status(202).send({ jobId: active.id, reused: true });
    const run: ReconstructionRun = {
      id: `run-${Date.now()}-${randomUUID().slice(0, 6)}`,
      propertyId: property.id,
      state: 'QUEUED',
      step: 'queued',
      progress: 0,
      attempts: 0,
      options: opts,
      heartbeatAt: null,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      modelVersions: {},
      promptVersions: {},
      aiCalls: 0,
      totalCostEstimate: '',
      outputSceneVersion: null,
      logs: [{ at: now(), step: 'queued', level: 'info', message: 'Reconstruction queued' }],
    };
    await store.put('runs', run.id, run);
    return reply.status(202).send({ jobId: run.id, reused: false });
  });

  app.get('/api/reconstruction-jobs/:jobId', async (req) => {
    if (!config.workerInline) await store.refresh('runs');
    const run = store.get('runs', parse(Id, (req.params as { jobId: string }).jobId));
    if (!run) throw new HttpError(404, 'NOT_FOUND', 'Job not found');
    return run;
  });

  app.get('/api/properties/:propertyId/scene', async (req) => {
    if (!config.workerInline) await store.refresh('scenes');
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    const scene = store.get('scenes', property.id);
    if (!scene) throw new HttpError(404, 'NO_SCENE', 'No reconstruction yet');
    return scene;
  });

  app.patch('/api/properties/:propertyId/room-mappings', async (req) => {
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    const patch = parse(RoomMappingPatch, req.body);
    const prev = store.get('roomMappings', property.id);
    const merged: RoomMappingPatch = {
      mappings: [...(prev?.mappings ?? []).filter((m) => !patch.mappings.some((n) => n.mediaId === m.mediaId)), ...patch.mappings],
      roomLabels: [...(prev?.roomLabels ?? []).filter((m) => !patch.roomLabels.some((n) => n.roomId === m.roomId)), ...patch.roomLabels],
      uncertainRoomIds: patch.uncertainRoomIds.length ? patch.uncertainRoomIds : (prev?.uncertainRoomIds ?? []),
      referenceMeasurement: patch.referenceMeasurement ?? prev?.referenceMeasurement ?? null,
    };
    await store.put('roomMappings', property.id, merged);
    return { saved: merged, note: 'Re-run reconstruction to apply. The cached plan interpretation is reused, so no new floor-plan AI call is made.' };
  });

  app.patch('/api/properties/:propertyId/scene-corrections', async (req) => {
    const property = requireProperty((req.params as { propertyId: string }).propertyId);
    const patch = parse(SceneCorrectionPatch, req.body);
    const prev = store.get('sceneCorrections', property.id);
    const merged = { objects: [...(prev?.objects ?? []).filter((o) => !patch.objects.some((n) => n.id === o.id)), ...patch.objects] };
    await store.put('sceneCorrections', property.id, merged);
    return { saved: merged };
  });

  app.post('/api/properties/:propertyId/rooms/:roomId/visualise', async (req) => {
    rateLimit(req, 3);
    const { propertyId, roomId } = req.params as { propertyId: string; roomId: string };
    const property = requireProperty(propertyId);
    const body = parse(z.object({ mediaId: Id, instruction: z.string().min(3).max(300) }), req.body);
    if (!metaConfigured()) throw new HttpError(503, 'META_NOT_CONFIGURED', 'Redesign needs MODEL_API_KEY on the server.');
    if (!config.meta.redesignEnabled) throw new HttpError(503, 'REDESIGN_DISABLED', 'Redesign is disabled (set REDESIGN_ENABLED=true).');
    const scene = store.get('scenes', property.id);
    const room = scene?.structure.rooms.find((r) => r.id === parse(Id, roomId));
    if (!room) throw new HttpError(404, 'NOT_FOUND', 'Room not found');
    const media = store.get('media', body.mediaId);
    if (!media || media.propertyId !== property.id || media.usageRightsStatus === 'unverified' || !MODEL_IMAGE_TYPES.has(media.mimeType)) throw new HttpError(400, 'BAD_MEDIA', 'Choose a permitted photo of this room');
    const day = now().slice(0, 10);
    const usage = store.get('usage', 'redesign');
    const used = usage?.day === day ? usage.redesigns : 0;
    if (used >= config.meta.maxRedesignsPerDay) throw new HttpError(429, 'DAILY_CAP', 'Daily redesign cap reached.');
    await store.put('usage', 'redesign', { day, redesigns: used + 1 });
    const abs = resolveStorageKey(media.storageKey)!;
    const r = await redesignRoom({ budget: new AiBudget(1), photoDataUrl: toDataUrl(await readFile(abs), media.mimeType), instruction: body.instruction, roomLabel: room.label });
    const file = `${property.id}-${room.id}-${Date.now()}.png`;
    await mkdir(join(config.dataDir, 'visualisations'), { recursive: true });
    await writeFile(join(config.dataDir, 'visualisations', file), Buffer.from(r.imageBase64, 'base64'));
    return {
      url: `/api/visualisations/${file}`,
      label: 'AI visualisation (Muse Image) — conceptual 2D image; the 3D scene is unchanged',
      model: r.model,
      promptVersion: REDESIGN_PROMPT_VERSION,
      sourceMediaId: media.id,
    };
  });

  app.get('/api/sam3d/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[a-f0-9]{24}\.(glb|ply)$/.test(file)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid file');
    const abs = resolveStorageKey(`sam3d/${file}`);
    if (!abs) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    return sendFile(reply, abs, file.endsWith('.glb') ? 'model/gltf-binary' : 'application/octet-stream');
  });

  app.get('/api/visualisations/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[A-Za-z0-9_-]+\.png$/.test(file)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid file');
    const abs = resolveStorageKey(`visualisations/${file}`);
    if (!abs) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    return sendFile(reply, abs, 'image/png');
  });
}
