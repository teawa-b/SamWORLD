/**
 * Optional SAM 3D Objects hero-object reconstruction on a Modal GPU worker
 * (worker-3d/). Disabled unless SAM3D_ENABLED=true, capped at
 * SAM3D_MAX_OBJECTS_PER_RUN, cached by content hash so retries never re-run
 * paid GPU time, and always falls back to the proxy on any failure.
 *
 * Only GLB mesh output is swapped into the scene. Gaussian-splat PLY output is
 * stored but NOT rendered until a Quest-tested splat renderer is validated.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Detection, EvidenceFlags, SceneObject, StepLog } from '@propertyxr/shared';
import { config } from '../config.js';
import { store } from '../store.js';
import { resolveStorageKey } from '../providers/fixture.js';
import { mimeFromName, toDataUrl } from '../lib/image.js';

interface WorkerReply {
  status: 'ok' | 'error';
  objectId: string;
  format?: 'glb' | 'ply-splat' | 'ply-mesh';
  assetUrl?: string;
  modelVersion?: string;
  durationSeconds?: number;
  diagnostics?: string[];
}

const cacheFile = () => join(config.dataDir, 'sam3d-cache.json');

export async function requestSam3d(opts: {
  objects: SceneObject[];
  detections: Detection[];
  log: (msg: string, level?: StepLog['level']) => Promise<void>;
}): Promise<{ objects: SceneObject[]; state: EvidenceFlags['sam3d'] }> {
  if (!config.sam3d.endpointUrl || !config.sam3d.authSecret) {
    await opts.log('SAM 3D enabled but MODAL_ENDPOINT_URL / MODAL_AUTH_SECRET missing; proxies kept', 'warn');
    return { objects: opts.objects, state: 'failed' };
  }
  const heroes = opts.objects
    .filter((o) => o.isMovable && o.sourceMediaIds.length)
    .map((o) => ({ o, det: opts.detections.find((d) => o.sourceMediaIds.includes(d.mediaId) && o.kind.includes(d.concept.split(' ')[0])) }))
    .filter((x): x is { o: SceneObject; det: Detection } => !!x.det)
    .sort((a, b) => b.o.sizeM[0] * b.o.sizeM[2] - a.o.sizeM[0] * a.o.sizeM[2])
    .slice(0, config.sam3d.maxObjectsPerRun);
  if (!heroes.length) {
    await opts.log('SAM 3D: no object has a SAM 3.1 detection to reconstruct from; proxies kept');
    return { objects: opts.objects, state: 'failed' };
  }

  const cache: Record<string, WorkerReply> = existsSync(cacheFile()) ? JSON.parse(await readFile(cacheFile(), 'utf8')) : {};
  let used = false;
  const out = [...opts.objects];
  for (const { o, det } of heroes) {
    const media = store.get('media', det.mediaId);
    const path = media && resolveStorageKey(media.storageKey);
    if (!media || !path) continue;
    const img = await readFile(path);
    const mask = det.maskKey ? await readFile(join(config.dataDir, det.maskKey), 'utf8').catch(() => null) : null;
    const hash = createHash('sha256').update(img).update(JSON.stringify(det.box)).update(mask ?? '').digest('hex');
    let reply = cache[hash];
    if (reply) {
      await opts.log(`SAM 3D: cache hit for ${o.kind} (no GPU call)`);
    } else {
      await opts.log(`SAM 3D: submitting ${o.kind} to Modal (timeout ${config.sam3d.timeoutSeconds}s)`);
      try {
        const res = await fetch(config.sam3d.endpointUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.sam3d.authSecret}` },
          body: JSON.stringify({
            objectId: o.id,
            sourceImageId: det.mediaId,
            image: toDataUrl(img, mimeFromName(path) ?? media.mimeType),
            box: det.box,
            maskSvg: mask,
            category: o.kind,
          }),
          signal: AbortSignal.timeout(config.sam3d.timeoutSeconds * 1000),
        });
        reply = (await res.json()) as WorkerReply;
        if (!res.ok) reply = { status: 'error', objectId: o.id, diagnostics: [`HTTP ${res.status}`, ...(reply.diagnostics ?? [])] };
      } catch (e) {
        reply = { status: 'error', objectId: o.id, diagnostics: [(e as Error).message] };
      }
      // Cache failures too, so a broken input is not retried at GPU cost.
      cache[hash] = reply;
      await writeFile(cacheFile(), JSON.stringify(cache, null, 1));
    }
    if (reply.status !== 'ok' || !reply.assetUrl) {
      await opts.log(`SAM 3D failed for ${o.kind}: ${(reply.diagnostics ?? []).join('; ')} — proxy kept`, 'warn');
      continue;
    }
    if (reply.format !== 'glb') {
      await opts.log(`SAM 3D returned ${reply.format}; not rendered (no validated splat renderer) — proxy kept, asset stored at ${reply.assetUrl}`, 'warn');
      continue;
    }
    const i = out.findIndex((x) => x.id === o.id);
    out[i] = {
      ...o,
      modelUrl: reply.assetUrl,
      reconstructionMethod: 'sam3d',
      placementNotes: [...o.placementNotes, `SAM 3D Objects ${reply.modelVersion ?? ''} in ${reply.durationSeconds ?? '?'}s; scaled to the estimated footprint`],
      provenance: { method: 'modal:sam-3d-objects', model: reply.modelVersion, at: new Date().toISOString() },
    };
    used = true;
  }
  return { objects: out, state: used ? 'used' : 'failed' };
}
