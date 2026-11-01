import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'walkin-import-'));
process.env.MODEL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
process.env.SAM3D_ENABLED = 'true';
process.env.SAM3D_PROVIDER = 'modal';
process.env.MODAL_AUTH_SECRET = 'test-secret';

// Fake SAM 3D worker: answers like worker-3d/app.py with a tiny splat PLY. No GPU, no network.
let workerCalls = 0;
const worker = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    workerCalls++;
    const ok = req.headers.authorization === 'Bearer test-secret' && JSON.parse(body).image?.startsWith('data:image/png');
    const ply = Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex 0\nproperty float x\nend_header\n');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(ok ? { status: 'ok', objectId: 'x', format: 'ply-splat', assetBase64: ply.toString('base64'), modelVersion: 'fake-test-worker', durationSeconds: 0.1 } : { status: 'error', objectId: 'x', diagnostics: ['bad request'] }));
  });
});
await new Promise<void>((r) => worker.listen(0, '127.0.0.1', r));
process.env.MODAL_ENDPOINT_URL = `http://127.0.0.1:${(worker.address() as AddressInfo).port}/reconstruct`;

const { store } = await import('../src/store.js');
const { buildApp } = await import('../src/server.js');
const { drain } = await import('../src/jobs/runner.js');
const { isBlockedAddress, assertPublicUrl, parseRobots, robotsAllows } = await import('../src/lib/safe-fetch.js');
const { extractFromHtml, extractListing, bestFromSrcset } = await import('../src/providers/listing-url.js');
const { hintFromName, sniffImage } = await import('../src/providers/ingest.js');
const { pickFalAsset } = await import('../src/jobs/sam3d.js');
const { roomForLabel } = await import('../src/jobs/pipeline.js');

/** A real (synthetic, solid-colour) PNG. */
function png(w: number, h: number, rgb = [200, 180, 150]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) p.data.set([...rgb, 255], i * 4);
  return PNG.sync.write(p);
}

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  await store.load();
  app = await buildApp();
});
afterAll(() => {
  worker.close();
  return app.close();
});

describe('SSRF guard and robots.txt', () => {
  it('blocks private, loopback, link-local and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '151.101.1.1', '2606:4700::1111']) expect(isBlockedAddress(ip), ip).toBe(false);
  });
  it('rejects non-http schemes, odd ports, credentials and local names', () => {
    for (const u of ['file:///etc/passwd', 'ftp://x.com/a', 'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'https://a.com:8443/', 'https://u:p@a.com/', 'http://metadata.google.internal/']) expect(() => assertPublicUrl(u), u).toThrow();
    expect(assertPublicUrl('https://example.com/listing/1').hostname).toBe('example.com');
  });
  it('honours robots.txt Disallow with Allow overrides', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /property/\nAllow: /property/public\n');
    expect(robotsAllows(rules, '/property/123')).toBe(false);
    expect(robotsAllows(rules, '/property/public-1')).toBe(true);
    expect(robotsAllows(rules, '/about')).toBe(true);
  });
});

describe('listing extraction', () => {
  const page = `<!doctype html><html><head><title>3 bed house, Example Road</title>
    <meta property="og:image" content="https://cdn.example.com/p/1-large.jpg">
    <script type="application/ld+json">{"@type":"Residence","name":"3 bed house","numberOfRooms":3,"image":["https://cdn.example.com/p/2.jpg"],"accommodationFloorPlan":{"layoutImage":"https://cdn.example.com/p/plan.png"}}</script>
    </head><body>
    <img src="https://cdn.example.com/logo.png" alt="logo">
    <img data-src="https://cdn.example.com/p/3.webp" alt="Kitchen">
    <img srcset="https://cdn.example.com/p/4-320.jpg 320w, https://cdn.example.com/p/4-1280.jpg 1280w" alt="Lounge">
    <img src="https://cdn.example.com/p/FLP_00.jpg" alt="Floor plan">
    <script>window.__STATE__={"gallery":["https:\\/\\/cdn.example.com\\/p\\/5.jpg"]}</script>
    <p>3 bedrooms · 95 sq m</p></body></html>`;

  it('finds photos and floor plans from JSON-LD, og, lazy images, srcset and page data', () => {
    const r = extractFromHtml(page, new URL('https://listings.example.com/h/1'));
    const urls = r.images.map((i) => i.url);
    expect(urls).toContain('https://cdn.example.com/p/1-large.jpg');
    expect(urls).toContain('https://cdn.example.com/p/3.webp');
    expect(urls).toContain('https://cdn.example.com/p/4-1280.jpg');
    expect(urls).not.toContain('https://cdn.example.com/p/4-320.jpg');
    expect(urls).toContain('https://cdn.example.com/p/5.jpg');
    expect(urls.some((u) => u.includes('logo'))).toBe(false);
    const plans = r.images.filter((i) => i.kind === 'floorplan').map((i) => i.url);
    expect(plans).toEqual(expect.arrayContaining(['https://cdn.example.com/p/plan.png', 'https://cdn.example.com/p/FLP_00.jpg']));
    expect(r.bedrooms).toBe(3);
    expect(r.areaSqM).toBe(95);
    expect(bestFromSrcset('a.jpg 1x, b.jpg 2x')).toBe('b.jpg');
  });

  it('refuses pages that robots.txt or the site blocks, without retrying around it', async () => {
    const robotsBlock = async (u: string) => ({ url: u, status: 200, contentType: u.endsWith('robots.txt') ? 'text/plain' : 'text/html', body: Buffer.from(u.endsWith('robots.txt') ? 'User-agent: *\nDisallow: /' : page) });
    await expect(extractListing('https://blocked.example.com/h/1', robotsBlock)).rejects.toMatchObject({ code: 'BLOCKED_BY_ROBOTS' });
    const forbidden = async (u: string) => ({ url: u, status: u.endsWith('robots.txt') ? 404 : 403, contentType: 'text/html', body: Buffer.from('') });
    await expect(extractListing('https://denied.example.com/h/1', forbidden)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('API refuses private URLs and requires a rights confirmation', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/imports/listing', payload: { url: 'http://169.254.169.254/latest/meta-data', rightsConfirmed: true } });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({ method: 'POST', url: '/api/imports/listing', payload: { url: 'https://example.com/x' } });
    expect(r2.statusCode).toBe(400);
  });
});

describe('uploads → review → traced plan → 3D, no AI', () => {
  let pid = '';
  const ids: Record<string, string> = {};

  it('creates a property and stores validated uploads', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/properties', payload: { title: 'Test flat', rightsConfirmed: true } });
    expect(c.statusCode).toBe(200);
    pid = c.json().property.id;
    const up = (name: string, buf: Buffer, type?: string) =>
      app.inject({ method: 'POST', url: `/api/properties/${pid}/media?filename=${name}${type ? `&type=${type}` : ''}`, headers: { 'content-type': 'image/png', 'x-rights-confirmed': 'true' }, payload: buf });
    const plan = await up('floorplan.png', png(400, 300, [255, 255, 255]));
    expect(plan.statusCode).toBe(200);
    expect(plan.json().media.type).toBe('floorplan'); // from the file name
    ids.plan = plan.json().media.id;
    const kitchen = await up('kitchen-1.png', png(320, 240));
    expect(kitchen.json().media.metadata.suggestion.roomLabel).toBe('Kitchen');
    ids.kitchen = kitchen.json().media.id;
    ids.other = (await up('IMG_2.png', png(320, 240, [10, 20, 30]))).json().media.id;
    // Duplicate bytes are not stored twice
    expect((await up('copy.png', png(320, 240))).json().duplicate).toBe(true);
  });

  it('rejects fake, tiny and unconfirmed images', async () => {
    const bad = await app.inject({ method: 'POST', url: `/api/properties/${pid}/media`, headers: { 'content-type': 'image/png', 'x-rights-confirmed': 'true' }, payload: Buffer.from('<svg onload=alert(1)>') });
    expect(bad.json().error.code).toBe('UNSUPPORTED_IMAGE');
    const tiny = await app.inject({ method: 'POST', url: `/api/properties/${pid}/media`, headers: { 'content-type': 'image/png', 'x-rights-confirmed': 'true' }, payload: png(10, 10) });
    expect(tiny.json().error.code).toBe('IMAGE_TOO_SMALL');
    const noRights = await app.inject({ method: 'POST', url: `/api/properties/${pid}/media`, headers: { 'content-type': 'image/png' }, payload: png(100, 100) });
    expect(noRights.statusCode).toBe(400);
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
  });

  it('edits media on the review screen: label, exclude, order', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/api/media/${ids.kitchen}`, payload: { roomGuess: 'Kitchen' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/media/${ids.other}`, payload: { excluded: true } })).json().media.metadata.excluded).toBe(true);
    const o = await app.inject({ method: 'PUT', url: `/api/properties/${pid}/media-order`, payload: { mediaIds: [ids.kitchen, ids.plan] } });
    expect(o.json().media.map((m: { id: string }) => m.id).slice(0, 2)).toEqual([ids.kitchen, ids.plan]);
    const s = await app.inject({ method: 'POST', url: `/api/properties/${pid}/media/suggest` });
    expect(s.statusCode).toBe(503); // honest: no key, no fake suggestions
  });

  it('builds connected 3D rooms from a hand-traced plan without any AI call', async () => {
    const level = {
      id: 'L0',
      index: 0,
      name: 'Ground floor',
      planMediaId: ids.plan,
      ceilingHeightMeters: null,
      rooms: [
        { id: 'r1', label: 'Kitchen', type: 'kitchen', polygonPx: [[20, 20], [200, 20], [200, 160], [20, 160]], measured: { text: '4.5 x 3.5', widthM: 4.5, depthM: 3.5 }, confidence: 1 },
        { id: 'r2', label: 'Living room', type: 'living', polygonPx: [[200, 20], [380, 20], [380, 160], [200, 160]], measured: null, confidence: 1 },
        { id: 'r3', label: 'Hall', type: 'hall', polygonPx: [[20, 160], [380, 160], [380, 230], [20, 230]], measured: null, confidence: 1 },
      ],
      openings: [
        { id: 'd1', type: 'door', atPx: [200, 90], widthPx: 32, roomIds: ['r1', 'r2'], confidence: 1 },
        { id: 'd2', type: 'door', atPx: [110, 160], widthPx: 32, roomIds: ['r1', 'r3'], confidence: 1 },
      ],
      stairs: [],
    };
    const bad = await app.inject({ method: 'PUT', url: `/api/properties/${pid}/interpretation`, payload: { levels: [{ ...level, rooms: [{ ...level.rooms[0], polygonPx: [[0, 0], [10, 10], [10, 0], [0, 10]] }], openings: [] }] } });
    expect(bad.statusCode).toBe(400);
    const put = await app.inject({ method: 'PUT', url: `/api/properties/${pid}/interpretation`, payload: { levels: [level] } });
    expect(put.statusCode).toBe(200);
    expect(put.json().interpretation.provenance.method).toBe('admin-correction');

    const r = await app.inject({ method: 'POST', url: `/api/properties/${pid}/reconstruct`, payload: {} });
    await drain();
    const job = (await app.inject({ url: `/api/reconstruction-jobs/${r.json().jobId}` })).json();
    expect(job.state).toBe('READY');
    expect(job.aiCalls).toBe(0);
    expect(job.logs.some((l: { message: string }) => /left out on the review screen/.test(l.message))).toBe(true);
    const scene = (await app.inject({ url: `/api/properties/${pid}/scene` })).json();
    expect(scene.evidenceFlags.layoutSource).toBe('floorplan');
    expect(scene.evidenceFlags.floorplanInterpretedBy).toBe('admin-correction');
    expect(scene.structure.rooms).toHaveLength(3);
    expect(scene.structure.scale.method).toBe('dimension-labels');
    const kitchen = scene.structure.rooms.find((x: { id: string }) => x.id === 'r1');
    expect(kitchen.areaSqM).toBeGreaterThan(14);
    expect(kitchen.areaSqM).toBeLessThan(17);
    // User label "Kitchen" assigned the photo to the kitchen; the excluded photo is not used.
    expect(kitchen.linkedMediaIds).toEqual([ids.kitchen]);
    expect(scene.structure.openings.filter((o: { parentWallId: string | null }) => o.parentWallId)).toHaveLength(2);
    expect(scene.verification.geometry.find((c: { id: string }) => c.id === 'connectivity')?.severity ?? 'pass').not.toBe('fail');
    expect(scene.objects.length).toBeGreaterThan(0); // typical furniture, labelled as such
  });

  it('applies object moves/removals to the stored scene immediately', async () => {
    const scene = (await app.inject({ url: `/api/properties/${pid}/scene` })).json();
    const [a, b] = scene.objects;
    const r = await app.inject({ method: 'PATCH', url: `/api/properties/${pid}/scene-corrections`, payload: { objects: [{ id: a.id, positionXZ: [1, 1], rotationY: 1.57 }, { id: b.id, removed: true }] } });
    expect(r.json().sceneVersion).toBe(scene.sceneVersion + 1);
    const next = (await app.inject({ url: `/api/properties/${pid}/scene` })).json();
    const moved = next.objects.find((o: { id: string }) => o.id === a.id);
    expect([moved.positionXYZ[0], moved.positionXYZ[2], moved.rotationY]).toEqual([1, 1, 1.57]);
    expect(moved.provenance.method).toBe('admin-correction');
    expect(next.objects.some((o: { id: string }) => o.id === b.id)).toBe(false);
  });

  it('SAM 3D per object: needs approval and a mask; stores splat output labelled as a splat', async () => {
    const scene = (await app.inject({ url: `/api/properties/${pid}/scene` })).json();
    const obj = scene.objects[0];
    const noApproval = await app.inject({ method: 'POST', url: `/api/properties/${pid}/objects/${obj.id}/reconstruct-3d`, payload: {} });
    expect(noApproval.statusCode).toBe(400);
    const noMask = await app.inject({ method: 'POST', url: `/api/properties/${pid}/objects/${obj.id}/reconstruct-3d`, payload: { approveGpuCost: true } });
    expect(noMask.json().error.code).toBe('NO_MASK');
    expect(workerCalls).toBe(0);

    // Give the scene a detection on the kitchen photo (as SAM 3.1 would) and try again against the fake worker.
    const s = store.get('scenes', pid)!;
    s.detections.push({ id: 'det-1', mediaId: ids.kitchen, concept: obj.kind, box: [0.1, 0.1, 0.6, 0.7], score: 0.9, maskKey: null, provenance: { method: 'meta:sam-3.1', at: new Date().toISOString() } });
    s.objects[0] = { ...s.objects[0], sourceMediaIds: [ids.kitchen] };
    await store.put('scenes', pid, s);
    const go = await app.inject({ method: 'POST', url: `/api/properties/${pid}/objects/${obj.id}/reconstruct-3d`, payload: { approveGpuCost: true, detectionId: 'det-1' } });
    expect(go.statusCode).toBe(202);
    let job = go.json().job;
    for (let i = 0; i < 50 && job.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = (await app.inject({ url: `/api/object-jobs/${job.id}` })).json();
    }
    expect(job.state).toBe('done');
    const after = (await app.inject({ url: `/api/properties/${pid}/scene` })).json();
    const rebuilt = after.objects.find((o: { id: string }) => o.id === obj.id);
    expect(rebuilt.reconstructionMethod).toBe('sam3d');
    expect(rebuilt.modelFormat).toBe('ply-splat');
    expect(rebuilt.placementNotes.join(' ')).toMatch(/not an editable mesh/);
    expect((await app.inject({ url: rebuilt.modelUrl })).statusCode).toBe(200);
    // Cached: the same request again makes no new worker call.
    const calls = workerCalls;
    const again = await app.inject({ method: 'POST', url: `/api/properties/${pid}/objects/${obj.id}/reconstruct-3d`, payload: { approveGpuCost: true, detectionId: 'det-1' } });
    let j2 = again.json().job;
    for (let i = 0; i < 50 && j2.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      j2 = (await app.inject({ url: `/api/object-jobs/${j2.id}` })).json();
    }
    expect(workerCalls).toBe(calls);
  });
});

describe('helpers', () => {
  it('reads room hints from file names', () => {
    expect(hintFromName('Bedroom_2.jpg').roomLabel).toBe('Bedroom 2');
    expect(hintFromName('https://x.com/a/FLP_01.png').floorplan).toBe(true);
    expect(hintFromName('IMG_0001.jpg').roomLabel).toBeNull();
  });
  it('maps user room labels to rooms only when unambiguous', () => {
    const rooms = [
      { id: 'a', label: 'Kitchen', type: 'kitchen' },
      { id: 'b', label: 'Bedroom 1', type: 'bedroom' },
      { id: 'c', label: 'Bedroom 2', type: 'bedroom' },
    ];
    const s = { rooms } as never;
    expect(roomForLabel(s, 'kitchen')).toBe('a');
    expect(roomForLabel(s, 'Bedroom 2')).toBe('c');
    expect(roomForLabel(s, 'Bedroom')).toBeNull();
  });
  it('picks a GLB over a splat from a fal result', () => {
    expect(pickFalAsset({ individual_glbs: [{ url: 'https://v3.fal.media/files/a/obj.glb' }], gaussian_splat: { url: 'https://v3.fal.media/files/a/s.ply' } })?.format).toBe('glb');
    expect(pickFalAsset({ gaussian_splat: { url: 'https://v3.fal.media/files/a/s.ply' } })?.format).toBe('ply-splat');
    expect(pickFalAsset({ nothing: 1 })).toBeNull();
  });
});
