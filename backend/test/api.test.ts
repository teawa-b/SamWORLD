import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'walkin-'));
process.env.MODEL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';

const { store } = await import('../src/store.js');
const { buildApp } = await import('../src/server.js');
const { drain } = await import('../src/jobs/runner.js');

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  await store.load();
  app = await buildApp();
});
afterAll(() => app.close());

describe('API vertical slice (offline fixture)', () => {
  let propertyId = '';

  it('reports capabilities without leaking secrets', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().capabilities.liveMeta).toBe(false);
    expect(res.body).not.toMatch(/MODEL_API_KEY=|Bearer/);
  });

  it('searches and imports the demo listing', async () => {
    const s = await app.inject({ url: '/api/properties/search?q=example' });
    const hit = s.json().results[0];
    expect(hit.hasFloorplan).toBe(true);
    const imp = await app.inject({ method: 'POST', url: '/api/properties/import', payload: { provider: hit.provider, listingId: hit.listingId } });
    expect(imp.statusCode).toBe(200);
    propertyId = imp.json().property.id;
    expect(imp.json().media.filter((m: { type: string }) => m.type === 'floorplan')).toHaveLength(2);
  });

  it('rejects non-allow-listed providers and bad ids', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/properties/import', payload: { provider: 'http://evil', listingId: 'x' } });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({ url: '/api/properties/..%2F..%2Fetc' });
    expect([400, 404]).toContain(r2.statusCode);
  });

  it('runs a reconstruction job to READY and serves the cached scene', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/properties/${propertyId}/reconstruct`, payload: {} });
    expect(r.statusCode).toBe(202);
    const { jobId } = r.json();
    await drain();
    const job = (await app.inject({ url: `/api/reconstruction-jobs/${jobId}` })).json();
    expect(job.state).toBe('READY');
    expect(job.aiCalls).toBe(0);
    const scene = (await app.inject({ url: `/api/properties/${propertyId}/scene` })).json();
    expect(scene.complete).toBe(true);
    expect(scene.evidenceFlags.liveMetaInference).toBe(false);
    expect(scene.evidenceFlags.floorplanInterpretedBy).toBe('fixture:hand-authored');
    expect(scene.structure.rooms).toHaveLength(9);
    expect(scene.objects.length).toBeGreaterThan(10);
    expect(scene.objects.every((o: { reconstructionMethod: string }) => o.reconstructionMethod === 'primitive')).toBe(true);
    expect(scene.verification.geometry.filter((c: { severity: string }) => c.severity === 'fail')).toEqual([]);
  });

  it('applies room corrections on rebuild without re-parsing', async () => {
    await app.inject({ method: 'PATCH', url: `/api/properties/${propertyId}/room-mappings`, payload: { roomLabels: [{ roomId: 'L0-living', label: 'Lounge' }] } });
    const { jobId } = (await app.inject({ method: 'POST', url: `/api/properties/${propertyId}/reconstruct`, payload: {} })).json();
    await drain();
    const job = (await app.inject({ url: `/api/reconstruction-jobs/${jobId}` })).json();
    expect(job.logs.some((l: { message: string }) => l.message.includes('Reusing cached layout'))).toBe(true);
    const scene = (await app.inject({ url: `/api/properties/${propertyId}/scene` })).json();
    expect(scene.structure.rooms.find((r: { id: string }) => r.id === 'L0-living').label).toBe('Lounge');
    expect(scene.sceneVersion).toBe(2);
  });

  it('refuses redesign without a key', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/properties/${propertyId}/rooms/L0-living/visualise`, payload: { mediaId: 'x', instruction: 'Scandinavian' } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('META_NOT_CONFIGURED');
  });
});
