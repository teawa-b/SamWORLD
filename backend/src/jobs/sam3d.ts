/**
 * SAM 3D Objects reconstruction: the owner's Modal GPU worker (worker-3d/) or
 * fal.ai's hosted fal-ai/sam-3/3d-objects (SAM3D_PROVIDER=fal, FAL_KEY).
 *
 * Cost guards: disabled unless SAM3D_ENABLED=true and an endpoint is set;
 * every request needs explicit approval (a run option or a per-object click);
 * capped at SAM3D_MAX_OBJECTS_PER_RUN per pipeline run; results — including
 * failures — are cached by content hash so the same input is never billed
 * twice; any failure keeps the proxy shape.
 *
 * Output formats are kept honest: GLB is a mesh; 'ply-splat' is a Gaussian
 * splat and is rendered as a splat/point cloud, never described as a mesh.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Detection, EvidenceFlags, SceneObject, StepLog } from '../shared/index.js';
import { config } from '../config.js';
import { store } from '../store.js';
import { resolveStorageKey } from '../providers/fixture.js';
import { imageSize, toDataUrl } from '../lib/image.js';

interface WorkerReply {
  status: 'ok' | 'error';
  objectId: string;
  format?: 'glb' | 'ply-splat' | 'ply-mesh';
  assetUrl?: string;
  /** Inline asset (the worker in worker-3d/ returns this); stored by us. */
  assetBase64?: string;
  modelVersion?: string;
  durationSeconds?: number;
  diagnostics?: string[];
}

export class Sam3dUnavailableError extends Error {
  code = 'SAM3D_NOT_CONFIGURED';
}

const cacheFile = () => join(config.dataDir, 'sam3d-cache.json');

export function sam3dReady(): { ok: boolean; reason: string; provider: 'modal' | 'fal' } {
  const provider = config.sam3d.provider;
  if (!config.sam3d.enabled) return { ok: false, provider, reason: 'SAM 3D is switched off on the server (SAM3D_ENABLED=false). See docs/modal-sam3d.md before enabling it: it is paid inference.' };
  if (provider === 'fal') {
    if (!config.sam3d.falKey) return { ok: false, provider, reason: 'SAM 3D provider is fal but FAL_KEY is not set.' };
    return { ok: true, provider, reason: `fal.ai ${config.sam3d.falEndpoint}` };
  }
  if (!config.sam3d.endpointUrl || !config.sam3d.authSecret) return { ok: false, provider, reason: 'SAM 3D is enabled but MODAL_ENDPOINT_URL / MODAL_AUTH_SECRET are not set.' };
  return { ok: true, provider, reason: 'Modal endpoint configured' };
}

// ---------------------------------------------------------------------------
// Providers. Both return the same WorkerReply shape.
// ---------------------------------------------------------------------------
interface ProviderInput {
  objectId: string;
  category: string;
  mediaId: string;
  imageDataUrl: string;
  box: Detection['box'];
  maskSvg: string | null;
}

async function callModal(i: ProviderInput): Promise<WorkerReply> {
  const res = await fetch(config.sam3d.endpointUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.sam3d.authSecret}` },
    body: JSON.stringify({ objectId: i.objectId, sourceImageId: i.mediaId, image: i.imageDataUrl, box: i.box, maskSvg: i.maskSvg, category: i.category }),
    signal: AbortSignal.timeout(config.sam3d.timeoutSeconds * 1000),
  });
  const text = await res.text();
  let reply: WorkerReply;
  try {
    reply = JSON.parse(text) as WorkerReply;
  } catch {
    return { status: 'error', objectId: i.objectId, diagnostics: [`Unreadable reply (HTTP ${res.status}): ${text.slice(0, 200)}`] };
  }
  return res.ok ? reply : { status: 'error', objectId: i.objectId, diagnostics: [`HTTP ${res.status}`, ...(reply.diagnostics ?? [])] };
}

/** Every https URL in a fal result, with the key path it was found under. */
function falFiles(node: unknown, path = '', out: { url: string; path: string }[] = []): { url: string; path: string }[] {
  if (typeof node === 'string') {
    if (/^https:\/\//.test(node)) out.push({ url: node, path });
  } else if (Array.isArray(node)) node.forEach((n, k) => falFiles(n, `${path}[${k}]`, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) falFiles(v, path ? `${path}.${k}` : k, out);
  return out;
}

/** Pick the asset to show: a GLB mesh when there is one, otherwise a PLY (Gaussian splat). Exported for tests. */
export function pickFalAsset(result: unknown): { url: string; format: 'glb' | 'ply-splat'; path: string } | null {
  const files = falFiles(result);
  const glb = files.find((f) => /^individual_glbs/.test(f.path)) ?? files.find((f) => /\.glb(\?|$)/i.test(f.url) || /glb/i.test(f.path));
  if (glb) return { url: glb.url, format: 'glb', path: glb.path };
  const ply = files.find((f) => /\.ply(\?|$)/i.test(f.url) || /splat|ply|gaussian/i.test(f.path));
  return ply ? { url: ply.url, format: 'ply-splat', path: ply.path } : null;
}

const FAL_ASSET_HOSTS = /(^|\.)(fal\.media|fal\.run|fal\.ai|fal-cdn\.batch\.fal\.ai)$/;

/**
 * fal.ai SAM 3D Objects, called the way the working formbar project does
 * (teawa-b/fal-hack-formbar, src/lib/scene-lift/sam3-lift.ts):
 *  - the photo is uploaded to fal storage first (fal workers can't fetch data: URIs or private hosts)
 *  - the object is picked by `prompt` (the SAM 3.1 concept) + `box_prompts` (its box in pixels)
 *  - `export_textured_glb: true` so the mesh carries the photo's colours
 *  - the result is a GLB mesh (`individual_glbs[0]`, else `model_glb`); its OpenCV-space
 *    translation/rotation are ignored — WalkIn places the object by the room layout.
 */
async function callFal(i: ProviderInput): Promise<WorkerReply> {
  const started = Date.now();
  const { fal } = await import('@fal-ai/client');
  fal.config({ credentials: config.sam3d.falKey });
  const [meta, b64] = i.imageDataUrl.split(',', 2);
  const mime = meta.match(/data:([^;]+)/)?.[1] ?? 'image/jpeg';
  const buf = Buffer.from(b64, 'base64');
  const imageUrl = await fal.storage.upload(new Blob([buf], { type: mime }));
  const size = imageSize(buf);
  const [x0, y0, x1, y1] = i.box;
  const input: Record<string, unknown> = { image_url: imageUrl, prompt: i.category, export_textured_glb: true };
  if (size) {
    const W = size.width;
    const H = size.height;
    const xm = Math.max(0, Math.min(W - 2, Math.round(x0 * W)));
    const ym = Math.max(0, Math.min(H - 2, Math.round(y0 * H)));
    input.box_prompts = [{ x_min: xm, y_min: ym, x_max: Math.max(xm + 1, Math.min(W - 1, Math.round(x1 * W))), y_max: Math.max(ym + 1, Math.min(H - 1, Math.round(y1 * H))) }];
  }
  let data: Record<string, unknown>;
  try {
    const r = await Promise.race([
      fal.subscribe(config.sam3d.falEndpoint, { input }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${config.sam3d.timeoutSeconds}s`)), config.sam3d.timeoutSeconds * 1000)),
    ]);
    data = r.data as Record<string, unknown>;
  } catch (e) {
    const err = e as { message?: string; body?: unknown; status?: number };
    return { status: 'error', objectId: i.objectId, diagnostics: [`fal ${err.status ?? ''} ${err.message ?? e}: ${JSON.stringify(err.body ?? '').slice(0, 300)}`] };
  }
  const asset = pickFalAsset(data);
  if (!asset) return { status: 'error', objectId: i.objectId, diagnostics: [`fal returned no GLB or PLY file. Keys: ${falFiles(data).map((f) => f.path).join(', ') || 'none'}`] };
  const host = new URL(asset.url).hostname;
  if (!FAL_ASSET_HOSTS.test(host)) return { status: 'error', objectId: i.objectId, diagnostics: [`fal asset on unexpected host ${host}; not downloaded`] };
  const file = await fetch(asset.url, { signal: AbortSignal.timeout(120000) });
  const out = Buffer.from(await file.arrayBuffer());
  if (!file.ok || out.length > 200 * 1024 * 1024) return { status: 'error', objectId: i.objectId, diagnostics: [`fal asset download failed (HTTP ${file.status}, ${out.length} bytes)`] };
  return {
    status: 'ok',
    objectId: i.objectId,
    format: asset.format,
    assetBase64: out.toString('base64'),
    modelVersion: `fal:${config.sam3d.falEndpoint}`,
    durationSeconds: Math.round((Date.now() - started) / 100) / 10,
    diagnostics: [`asset from ${asset.path}`],
  };
}

/** Pick the detection a proxy object should be rebuilt from (same photo + similar concept). */
export function detectionFor(o: SceneObject, detections: Detection[]): Detection | undefined {
  const head = o.kind.split(/[-\s]/)[0];
  const pool = detections.filter((d) => o.sourceMediaIds.includes(d.mediaId));
  return pool.find((d) => d.id === o.sourceDetectionId) ?? pool.find((d) => d.concept.includes(head) || o.kind.includes(d.concept.split(' ')[0]));
}

/** Reconstruct one object from one detection. Returns the updated object or a reason it stayed a proxy. */
export async function reconstructObject(o: SceneObject, det: Detection, log: (msg: string, level?: StepLog['level']) => Promise<void>): Promise<{ object: SceneObject; ok: boolean; message: string }> {
  const ready = sam3dReady();
  if (!ready.ok) throw new Sam3dUnavailableError(ready.reason);
  const media = store.get('media', det.mediaId);
  const path = media && resolveStorageKey(media.storageKey);
  if (!media || !path) return { object: o, ok: false, message: 'Source photo is missing' };
  const img = await readFile(path);
  const mask = det.maskKey ? await readFile(join(config.dataDir, det.maskKey), 'utf8').catch(() => null) : null;
  const hash = createHash('sha256').update(ready.provider).update(img).update(JSON.stringify(det.box)).update(mask ?? '').update(o.kind).digest('hex');
  const cache: Record<string, WorkerReply> = existsSync(cacheFile()) ? JSON.parse(await readFile(cacheFile(), 'utf8')) : {};
  let reply = cache[hash];
  if (reply) {
    await log(`SAM 3D: cache hit for ${o.kind} (no GPU call)`);
  } else {
    await log(`SAM 3D (${ready.provider}): submitting ${o.kind} (detection ${det.id}), timeout ${config.sam3d.timeoutSeconds}s`);
    const input = { objectId: o.id, category: det.concept || o.kind, mediaId: det.mediaId, imageDataUrl: toDataUrl(img, media.mimeType), box: det.box, maskSvg: mask };
    try {
      reply = ready.provider === 'fal' ? await callFal(input) : await callModal(input);
    } catch (e) {
      reply = { status: 'error', objectId: o.id, diagnostics: [(e as Error).message] };
    }
    if (reply.status === 'ok' && reply.assetBase64) {
      const file = `${hash.slice(0, 24)}.${reply.format === 'glb' ? 'glb' : 'ply'}`;
      await mkdir(join(config.dataDir, 'sam3d'), { recursive: true });
      await writeFile(join(config.dataDir, 'sam3d', file), Buffer.from(reply.assetBase64, 'base64'));
      reply = { ...reply, assetBase64: undefined, assetUrl: `/api/sam3d/${file}` };
    }
    // Network errors are not cached (the endpoint may just be cold/offline); model errors are.
    const transient = reply.status === 'error' && (reply.diagnostics ?? []).some((d) => /fetch failed|ECONN|timeout|aborted|HTTP 5\d\d/i.test(d));
    if (!transient) {
      cache[hash] = reply;
      await writeFile(cacheFile(), JSON.stringify(cache, null, 1));
    }
  }
  if (reply.status !== 'ok' || !reply.assetUrl) {
    const msg = `SAM 3D failed for ${o.kind}: ${(reply.diagnostics ?? []).join('; ') || 'no asset returned'} — proxy kept`;
    await log(msg, 'warn');
    return { object: o, ok: false, message: msg };
  }
  const format = reply.format ?? 'ply-splat';
  return {
    ok: true,
    message: `SAM 3D returned a ${format === 'glb' ? 'mesh (GLB)' : format === 'ply-splat' ? 'Gaussian splat (PLY)' : 'mesh (PLY)'} for ${o.kind}`,
    object: {
      ...o,
      modelUrl: reply.assetUrl,
      modelFormat: format,
      sourceDetectionId: det.id,
      reconstructionMethod: 'sam3d',
      placementNotes: [
        ...o.placementNotes.filter((n) => !n.startsWith('SAM 3D')),
        `SAM 3D Objects ${reply.modelVersion ?? ''} in ${reply.durationSeconds ?? '?'}s from photo ${det.mediaId}; ${format === 'ply-splat' ? 'Gaussian splat, shown as a point cloud (not an editable mesh)' : 'mesh'}; scaled to the estimated footprint, position still estimated`,
      ],
      provenance: { method: 'modal:sam-3d-objects', model: reply.modelVersion, at: new Date().toISOString() },
    },
  };
}

/** Pipeline hook: rebuild up to SAM3D_MAX_OBJECTS_PER_RUN of the largest objects that have a SAM 3.1 detection. */
export async function requestSam3d(opts: {
  objects: SceneObject[];
  detections: Detection[];
  log: (msg: string, level?: StepLog['level']) => Promise<void>;
}): Promise<{ objects: SceneObject[]; state: EvidenceFlags['sam3d'] }> {
  const ready = sam3dReady();
  if (!ready.ok) {
    await opts.log(`${ready.reason} Proxies kept.`, 'warn');
    return { objects: opts.objects, state: 'failed' };
  }
  const heroes = opts.objects
    .filter((o) => o.isMovable && o.sourceMediaIds.length)
    .map((o) => ({ o, det: detectionFor(o, opts.detections) }))
    .filter((x): x is { o: SceneObject; det: Detection } => !!x.det)
    .sort((a, b) => b.o.sizeM[0] * b.o.sizeM[2] - a.o.sizeM[0] * a.o.sizeM[2])
    .slice(0, config.sam3d.maxObjectsPerRun);
  if (!heroes.length) {
    await opts.log('SAM 3D: no object has a SAM 3.1 detection to reconstruct from; proxies kept');
    return { objects: opts.objects, state: 'failed' };
  }
  let used = false;
  const out = [...opts.objects];
  for (const { o, det } of heroes) {
    const r = await reconstructObject(o, det, opts.log);
    if (r.ok) {
      out[out.findIndex((x) => x.id === o.id)] = r.object;
      used = true;
    }
  }
  return { objects: out, state: used ? 'used' : 'failed' };
}
