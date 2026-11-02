import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// FAKE MapAnything worker: answers like worker-3d/mapanything_app.py with a synthetic 4 × 3 m room (floor + 4 walls).
let calls = 0;
let lastFrames = 0;
const fake = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    calls++;
    if (req.headers.authorization !== 'Bearer t0k') return res.writeHead(401).end('{}');
    lastFrames = JSON.parse(b).frames.length;
    const pts: number[][] = [];
    for (let x = 0; x <= 4; x += 0.1) for (let z = 0; z <= 3; z += 0.1) pts.push([x, 0, z, 150, 120, 90]);
    for (let y = 0; y <= 2.4; y += 0.1) {
      for (let x = 0; x <= 4; x += 0.1) pts.push([x, y, 0, 230, 230, 220], [x, y, 3, 230, 230, 220]);
      for (let z = 0; z <= 3; z += 0.1) pts.push([0, y, z, 230, 230, 220], [4, y, z, 230, 230, 220]);
    }
    const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${pts.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`);
    const body = Buffer.alloc(pts.length * 15);
    pts.forEach((p, i) => {
      body.writeFloatLE(p[0], i * 15);
      body.writeFloatLE(p[1], i * 15 + 4);
      body.writeFloatLE(p[2], i * 15 + 8);
      body.writeUInt8(p[3], i * 15 + 12);
      body.writeUInt8(p[4], i * 15 + 13);
      body.writeUInt8(p[5], i * 15 + 14);
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', model: 'FAKE mapanything', plyBase64: Buffer.concat([head, body]).toString('base64'), points: pts.length, cameras: [{ pose: [1, 0, 0, 2, 0, 1, 0, 1.5, 0, 0, 1, 1.5, 0, 0, 0, 1], intrinsics: [500, 500, 256, 192], width: 512, height: 384 }], timings: { inferSeconds: 1.2 } }));
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'walkin-scan-'));
process.env.MODEL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
process.env.MAPANYTHING_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/reconstruct`;
process.env.MAPANYTHING_TOKEN = 't0k';

const { store } = await import('../src/store.js');
const { buildApp } = await import('../src/server.js');
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  await store.load();
  app = await buildApp();
});
afterAll(() => {
  fake.close();
  return app.close();
});

const frame = (shade: number) => {
  const p = new PNG({ width: 128, height: 96 });
  for (let i = 0; i < 128 * 96; i++) p.data.set([shade, 100, 200 - shade, 255], i * 4);
  return PNG.sync.write(p);
};

describe('Roomshift scans', () => {
  it('uploads frames, reconstructs through the worker, serves the point cloud, and caches', async () => {
    const { scan } = (await app.inject({ method: 'POST', url: '/api/scans', payload: { title: 'Test room' } })).json();
    expect((await app.inject({ method: 'POST', url: `/api/scans/${scan.id}/reconstruct`, payload: {} })).json().error.code).toBe('TOO_FEW_FRAMES');
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: 'POST', url: `/api/scans/${scan.id}/frames`, headers: { 'content-type': 'image/png' }, payload: frame(i * 30) });
      expect(r.statusCode).toBe(200);
    }
    const bad = await app.inject({ method: 'POST', url: `/api/scans/${scan.id}/frames`, headers: { 'content-type': 'image/png' }, payload: Buffer.from('nope') });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/scans/${scan.id}/reconstruct`, payload: {} })).statusCode).toBe(202);
    let s = scan;
    for (let i = 0; i < 100 && s.state !== 'ready' && s.state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      s = (await app.inject({ url: `/api/scans/${scan.id}` })).json().scan;
    }
    expect(s.state).toBe('ready');
    expect(lastFrames).toBe(6);
    expect(s.cloud.points).toBeGreaterThan(1000);
    expect(s.bounds.max[0]).toBeCloseTo(4, 0);
    expect(s.bounds.max[1]).toBeCloseTo(2.4, 0);
    expect(s.cameras).toHaveLength(1);
    expect(s.model).toBe('FAKE mapanything');
    const ply = await app.inject({ url: `/api/scans/${scan.id}/cloud.ply` });
    expect(ply.statusCode).toBe(200);
    expect(ply.rawPayload.subarray(0, 3).toString()).toBe('ply');
    // Same frames again: cached, no second GPU call.
    const before = calls;
    await app.inject({ method: 'POST', url: `/api/scans/${scan.id}/reconstruct`, payload: {} });
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if ((await app.inject({ url: `/api/scans/${scan.id}` })).json().scan.state === 'ready') break;
    }
    expect(calls).toBe(before);
  });

  it('explains when the GPU worker is not connected or Muse is not configured', async () => {
    const page = await app.inject({ url: '/api/selftest/muse-image' });
    expect(page.body).toMatch(/MODEL_API_KEY is not set/);
  });
});
