/**
 * Roomshift API: room captures → MapAnything reconstruction, plus a live Muse Image self-test.
 * See DETAIL.md for the full pipeline.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, metaConfigured } from './config.js';
import { HttpError, Id, now, parse, rateLimit } from './http.js';
import { AiBudget } from './meta/client.js';
import { restyleImage, surfaceTexture } from './meta/image.js';
import { understandScan } from './objects.js';
import { photoWalls } from './photo-walls.js';
import { validateImage } from './providers/ingest.js';
import { startRestyle, textureDir } from './restyle.js';
import { encodeCloud, findInnerWalls, fitRoomShell, parsePly, strayFilter, transformPointRowMajor } from './shared/index.js';
import { store, type Restyle, type Scan, type ScanCamera } from './store.js';

const scanDir = (id: string) => join(config.dataDir, 'scans', id);
const CLOUD_FORMAT = 'voxel-1cm-1m';

/**
 * The cloud in the compact RSC1 format, gzipped (about a quarter of the PLY's size), written once next to the
 * PLY. The viewer downloads this; the PLY stays the source of truth.
 */
async function compactCloud(scan: Scan): Promise<string> {
  const file = join(scanDir(scan.id), `${scan.cloud!.file}.rsc2.gz`);
  if (!existsSync(file)) {
    const ply = await readFile(join(scanDir(scan.id), scan.cloud!.file));
    const pc = parsePly(ply.buffer.slice(ply.byteOffset, ply.byteOffset + ply.byteLength) as ArrayBuffer, { maxPoints: 2_000_000 });
    // Drop floaters (isolated points) before sending: they read as dust in the viewer. A sparse cloud (where
    // the filter would remove more than a fifth) is sent as it is.
    let keep = strayFilter(pc.positions);
    if (keep.length < 0.8 * pc.count) keep = Uint32Array.from({ length: pc.count }, (_, i) => i);
    const pos = new Float32Array(keep.length * 3);
    const col = new Float32Array(keep.length * 3);
    keep.forEach((i, j) => {
      pos.set(pc.positions.subarray(i * 3, i * 3 + 3), j * 3);
      col.set(pc.colors.subarray(i * 3, i * 3 + 3), j * 3);
    });
    await writeFile(file, await promisify(gzip)(encodeCloud(pos, col), { level: 6 }));
  }
  return file;
}

/** Project the video onto the shell (after objects, which block the view); failures leave the point-based coat. */
async function paintPhotoWalls(scan: Scan) {
  try {
    const walls = await photoWalls(scan);
    await store.put('scans', scan.id, Object.assign(scan, { photoWalls: walls, updatedAt: now() }));
  } catch {
    // The viewer falls back to the point-based coat.
  }
}

function requireScan(id: string): Scan {
  const s = store.get('scans', parse(Id, id));
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'Scan not found');
  return s;
}

/** Reply from the MapAnything worker (worker-3d/mapanything_app.py). */
interface WorkerReply {
  status: 'ok' | 'error';
  model?: string;
  plyBase64?: string;
  points?: number;
  cameras?: ScanCamera[];
  timings?: Record<string, number>;
  diagnostics?: string[];
}

async function reconstruct(scan: Scan): Promise<void> {
  const save = (patch: Partial<Scan>) => store.put('scans', scan.id, Object.assign(scan, patch, { updatedAt: now() }));
  const t0 = Date.now();
  try {
    const frames = await Promise.all(scan.frames.map(async (f) => (await readFile(join(scanDir(scan.id), f.file))).toString('base64')));
    // Bump CLOUD_FORMAT when the worker's output changes so existing scans can be rebuilt.
    const hash = createHash('sha256').update(CLOUD_FORMAT);
    for (const f of frames) hash.update(f);
    const key = hash.digest('hex').slice(0, 24);
    const cached = join(scanDir(scan.id), `${key}.json`);
    let reply: WorkerReply;
    if (existsSync(cached)) {
      reply = JSON.parse(await readFile(cached, 'utf8'));
    } else {
      await save({ message: `Sending ${frames.length} frames to MapAnything (a cold GPU can take a minute to start)…` });
      const res = await fetch(config.mapanything.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.mapanything.token}` },
        body: JSON.stringify({ frames }),
        signal: AbortSignal.timeout(config.mapanything.timeoutSeconds * 1000),
      });
      const text = await res.text();
      try {
        reply = JSON.parse(text);
      } catch {
        throw new Error(`MapAnything worker answered HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.ok || reply.status !== 'ok') throw new Error(`MapAnything failed: ${(reply.diagnostics ?? [`HTTP ${res.status}`]).join('; ')}`);
      await writeFile(cached, JSON.stringify({ ...reply, plyBase64: undefined }));
      await writeFile(join(scanDir(scan.id), `${key}.ply`), Buffer.from(reply.plyBase64!, 'base64'));
    }
    const plyFile = `${key}.ply`;
    const ply = await readFile(join(scanDir(scan.id), plyFile));
    const pc = parsePly(ply.buffer.slice(ply.byteOffset, ply.byteOffset + ply.byteLength) as ArrayBuffer, { maxPoints: 2_000_000 });
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pc.count; i++)
      for (let k = 0; k < 3; k++) {
        const v = pc.positions[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    await save({ message: 'Finding the floor, ceiling and walls…' });
    const shell = fitRoomShell(pc.positions, { cameras: reply.cameras ?? [] });
    if (!shell.fallback) {
      // Walls inside the box (an L-shaped room's inner corner), on the full cloud in the room frame.
      const room = new Float32Array(pc.count * 3);
      for (let i = 0; i < pc.count; i++) room.set(transformPointRowMajor(shell.alignment, [pc.positions[i * 3], pc.positions[i * 3 + 1], pc.positions[i * 3 + 2]]), i * 3);
      const cams = (reply.cameras ?? []).map((c) => {
        const p = transformPointRowMajor(shell.alignment, [c.pose[3], c.pose[7], c.pose[11]]);
        return [p[0], p[2]] as [number, number];
      });
      shell.inner = findInnerWalls(room, shell, { cameras: cams });
      if (shell.inner.length) shell.diagnostics.push(`${shell.inner.length} inner wall${shell.inner.length > 1 ? 's' : ''} (room isn't a plain rectangle)`);
    }
    const shape = shell.fallback ? 'room shape not measured; showing the raw scan' : `room ${shell.size.width.toFixed(1)} × ${shell.size.depth.toFixed(1)} × ${shell.size.height.toFixed(1)} m`;
    await save({
      state: 'ready',
      shell,
      message: `Reconstructed ${pc.count.toLocaleString()} points from ${frames.length} frames · ${shape}`,
      cloud: { file: plyFile, points: pc.count },
      cameras: reply.cameras ?? [],
      bounds: { min, max },
      model: reply.model ?? 'mapanything',
      timings: { ...(reply.timings ?? {}), totalSeconds: Math.round((Date.now() - t0) / 100) / 10 },
      objects: [],
      objectsStatus: { state: 'running', message: 'Looking for furniture…', usage: '' },
    });
    await compactCloud(scan).catch(() => undefined);
    await understandScan(scan);
    await paintPhotoWalls(scan);
  } catch (e) {
    await save({ state: 'failed', message: (e as Error).message });
  }
}

export async function registerRoomshiftRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ scans
  app.post('/api/scans', async (req) => {
    rateLimit(req, 20);
    const body = parse(z.object({ title: z.string().max(120).optional() }), req.body ?? {});
    const id = `scan-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const scan: Scan = { id, title: body.title || 'My room', createdAt: now(), updatedAt: now(), frames: [], state: 'collecting', message: 'Waiting for frames', cloud: null, cameras: [], bounds: null, model: null, timings: {} };
    await mkdir(scanDir(id), { recursive: true });
    await store.put('scans', id, scan);
    return { scan };
  });

  /** One frame per request (raw JPEG/PNG/WebP body), in capture order. */
  app.post('/api/scans/:scanId/frames', { bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    rateLimit(req, 600);
    const scan = requireScan((req.params as { scanId: string }).scanId);
    if (scan.state === 'reconstructing') throw new HttpError(409, 'BUSY', 'This scan is being reconstructed');
    if (scan.frames.length >= config.mapanything.maxFrames) throw new HttpError(400, 'TOO_MANY_FRAMES', `At most ${config.mapanything.maxFrames} frames per scan`);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'UNSUPPORTED_IMAGE', 'Send the frame as image/jpeg, image/png or image/webp');
    const info = validateImage(req.body);
    const file = `frame-${String(scan.frames.length).padStart(3, '0')}.${info.mime.split('/')[1].replace('jpeg', 'jpg')}`;
    await writeFile(join(scanDir(scan.id), file), req.body);
    scan.frames.push({ file, bytes: req.body.length, width: info.width, height: info.height });
    scan.updatedAt = now();
    await store.put('scans', scan.id, scan);
    return { frames: scan.frames.length };
  });

  app.post('/api/scans/:scanId/reconstruct', async (req, reply) => {
    rateLimit(req, 6);
    const scan = requireScan((req.params as { scanId: string }).scanId);
    if (scan.frames.length < 4) throw new HttpError(400, 'TOO_FEW_FRAMES', 'Add at least 4 frames (20–40 works best).');
    if (!config.mapanything.url || !config.mapanything.token) throw new HttpError(503, 'SCAN_NOT_CONFIGURED', 'The MapAnything GPU worker isn’t connected yet: deploy worker-3d/mapanything_app.py on Modal and set MAPANYTHING_URL and MAPANYTHING_TOKEN on the backend (see DETAIL.md).');
    if (scan.state === 'reconstructing') return reply.status(202).send({ scan });
    scan.state = 'reconstructing';
    scan.message = 'Starting reconstruction';
    await store.put('scans', scan.id, scan);
    void reconstruct(scan);
    return reply.status(202).send({ scan });
  });

  app.get('/api/scans/:scanId', async (req) => ({ scan: requireScan((req.params as { scanId: string }).scanId) }));

  /** Find the room's objects again (Muse Spark + SAM 3.1), e.g. after a failed run. */
  app.post('/api/scans/:scanId/objects', async (req, reply) => {
    rateLimit(req, 6);
    const scan = requireScan((req.params as { scanId: string }).scanId);
    if (scan.state !== 'ready') throw new HttpError(409, 'SCAN_NOT_READY', 'Reconstruct the room first');
    if (scan.objectsStatus?.state !== 'running') {
      scan.objectsStatus = { state: 'running', message: 'Starting…', usage: '' };
      await store.put('scans', scan.id, scan);
      void understandScan(scan).then(() => paintPhotoWalls(scan));
    }
    return reply.status(202).send({ scan });
  });

  app.get('/api/scans/:scanId/objects/:objectId/crop.jpg', async (req, reply) => {
    const { scanId, objectId } = req.params as { scanId: string; objectId: string };
    const o = requireScan(scanId).objects?.find((x) => x.id === objectId);
    if (!o?.crop || !existsSync(join(scanDir(scanId), o.crop))) throw new HttpError(404, 'NOT_FOUND', 'No crop for this object');
    reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=3600');
    return reply.send(createReadStream(join(scanDir(scanId), o.crop)));
  });

  /** Same points as cloud.ply in the compact format, sent gzip-encoded (the browser unpacks it). */
  app.get('/api/scans/:scanId/cloud.rsc', async (req, reply) => {
    const scan = requireScan((req.params as { scanId: string }).scanId);
    if (!scan.cloud) throw new HttpError(404, 'NOT_READY', 'No reconstruction yet');
    const file = await compactCloud(scan);
    reply.header('content-type', 'application/octet-stream').header('content-encoding', 'gzip').header('cache-control', 'public, max-age=3600');
    return reply.send(createReadStream(file));
  });

  app.get('/api/scans/:scanId/walls/:file', async (req, reply) => {
    const { scanId, file } = req.params as { scanId: string; file: string };
    const scan = requireScan(scanId);
    if (!/^[a-z0-9.-]+\.jpg$/.test(file) || !scan.photoWalls?.some((w) => w.file === file)) throw new HttpError(404, 'NOT_FOUND', 'No such wall');
    reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=300');
    return reply.send(createReadStream(join(scanDir(scan.id), 'walls', file)));
  });

  app.get('/api/scans/:scanId/cloud.ply', async (req, reply) => {
    const scan = requireScan((req.params as { scanId: string }).scanId);
    if (!scan.cloud) throw new HttpError(404, 'NOT_READY', 'No reconstruction yet');
    reply.header('content-type', 'application/octet-stream').header('cache-control', 'public, max-age=3600');
    return reply.send(createReadStream(join(scanDir(scan.id), scan.cloud.file)));
  });

  // ------------------------------------------------------------------ restyles ("type a world")
  app.post('/api/scans/:scanId/restyles', async (req, reply) => {
    rateLimit(req, 20);
    const scan = requireScan((req.params as { scanId: string }).scanId);
    if (scan.state !== 'ready') throw new HttpError(409, 'SCAN_NOT_READY', 'Reconstruct the room first');
    const body = parse(z.object({ prompt: z.string().trim().min(2).max(300) }), req.body ?? {});
    return reply.status(202).send({ restyle: await startRestyle(scan, body.prompt) });
  });

  app.get('/api/scans/:scanId/restyles', async (req) => {
    const scan = requireScan((req.params as { scanId: string }).scanId);
    const list = Object.values(store.all('restyles')).filter((r: Restyle) => r.scanId === scan.id);
    return { restyles: list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  });

  app.get('/api/restyles/:restyleId', async (req) => {
    const r = store.get('restyles', parse(Id, (req.params as { restyleId: string }).restyleId));
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Restyle not found');
    return { restyle: r };
  });

  app.get('/api/textures/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const m = /^[0-9a-f]{24}\.(png|jpg|webp)$/.exec(name);
    if (!m || !existsSync(join(textureDir(), name))) throw new HttpError(404, 'NOT_FOUND', 'Texture not found');
    reply.header('content-type', `image/${m[1] === 'jpg' ? 'jpeg' : m[1]}`).header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(createReadStream(join(textureDir(), name)));
  });

  // ------------------------------------------------------------------ Muse Image self-test
  /** Open in a browser: generates one seamless texture live and shows it, plus a form to test restyling a photo. */
  app.get('/api/selftest/muse-image', async (req, reply) => {
    const q = parse(z.object({ prompt: z.string().max(200).optional(), run: z.string().optional() }), req.query);
    const page = (body: string) => reply.header('content-type', 'text/html; charset=utf-8').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Muse Image self-test</title><body style="font:15px system-ui;max-width:760px;margin:24px auto;padding:0 16px">${body}</body>`);
    if (!metaConfigured()) return page('<h2>Muse Image self-test</h2><p><b>MODEL_API_KEY is not set on this server.</b></p>');
    const form = `<h3>2. Restyle a photo (image → image)</h3><form id=f><input type=file id=img accept="image/*" required> <input id=ins value="a medieval wizard's version, carved oak and brass" size=40> <button>Restyle</button></form><div id=out></div>
<script>f.onsubmit=async e=>{e.preventDefault();out.textContent='Generating… (can take ~30 s)';const t=Date.now();const r=await fetch('/api/selftest/muse-image/restyle?instruction='+encodeURIComponent(ins.value),{method:'POST',headers:{'content-type':img.files[0].type||'image/jpeg'},body:img.files[0]});const j=await r.json();out.innerHTML=r.ok?'<p>✅ '+((Date.now()-t)/1000).toFixed(1)+' s, model '+j.model+'</p><img style="max-width:100%" src="data:image/png;base64,'+j.imageBase64+'">':'<p>❌ '+(j.error?.message||r.status)+'</p>'}</script>`;
    if (!q.run) return page(`<h2>Muse Image self-test</h2><p>Each test makes one live Muse Image call on your Meta API key.</p><h3>1. Generate a seamless wall texture (text → image)</h3><form><input name=prompt value="${(q.prompt ?? 'mossy ancient stone blocks with tiny glowing mushrooms').replace(/"/g, '&quot;')}" size=50><input type=hidden name=run value=1> <button>Generate</button></form>${form}`);
    rateLimit(req, 6);
    const t = Date.now();
    try {
      const r = await surfaceTexture({ budget: new AiBudget(1), description: q.prompt ?? 'mossy ancient stone blocks with tiny glowing mushrooms', surface: 'wall' });
      return page(`<h2>Muse Image self-test</h2><p>✅ Texture in ${((Date.now() - t) / 1000).toFixed(1)} s · model ${r.model}</p><p>Tiled 2×2 to check it’s seamless:</p><div style="width:512px;max-width:100%;aspect-ratio:1;background:url(data:image/png;base64,${r.imageBase64}) 0 0/50% 50% repeat"></div><p><a href="?">Back</a></p>${form}`);
    } catch (e) {
      return page(`<h2>Muse Image self-test</h2><p>❌ ${String((e as Error).message).replace(/</g, '&lt;')}</p><p><a href="?">Back</a></p>`);
    }
  });

  app.post('/api/selftest/muse-image/restyle', { bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    rateLimit(req, 6);
    if (!metaConfigured()) throw new HttpError(503, 'META_NOT_CONFIGURED', 'MODEL_API_KEY is not set');
    const q = parse(z.object({ instruction: z.string().min(3).max(300) }), req.query);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'UNSUPPORTED_IMAGE', 'Send an image body');
    const info = validateImage(req.body);
    const r = await restyleImage({ budget: new AiBudget(1), imageDataUrl: `data:${info.mime};base64,${req.body.toString('base64')}`, instruction: q.instruction, subject: 'scene' });
    return { imageBase64: r.imageBase64, model: r.model, prompt: r.prompt };
  });
}
