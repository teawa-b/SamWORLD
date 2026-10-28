/**
 * Exercises the live Meta code path against a LOCAL FAKE of the Meta Model
 * API. This checks request shapes and pipeline wiring only — it is not real
 * inference and proves nothing about model quality.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/demo-house/interpretation.fixture.json', import.meta.url), 'utf8'));
const requests: { path: string; body: any }[] = [];
let levelCalls = 0;

const read = (req: IncomingMessage) => new Promise<string>((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });
const fake = createServer(async (req, res) => {
  const body = JSON.parse(await read(req));
  requests.push({ path: req.url!, body });
  const name = body.response_format?.json_schema?.name;
  let content: unknown = {};
  if (name === 'floorplan_level') {
    const lvl = fixture.levels[levelCalls++];
    const strip = (id: string) => id.replace(`${lvl.id}-`, '');
    content = {
      levelName: lvl.name,
      ceilingHeightMeters: null,
      rooms: lvl.rooms.map((r: any) => ({ id: strip(r.id), label: r.label, type: r.type, polygonPx: r.polygonPx, dimensionText: r.measured?.text ?? null, widthM: r.measured?.widthM ?? null, depthM: r.measured?.depthM ?? null, confidence: r.confidence })),
      openings: lvl.openings.map((o: any) => ({ id: strip(o.id), type: o.type, atPx: o.atPx, widthPx: o.widthPx, roomIds: o.roomIds.map(strip), confidence: o.confidence })),
      stairs: lvl.stairs.map((s: any) => ({ id: strip(s.id), polygonPx: s.polygonPx, goesUp: true, confidence: s.confidence })),
      uncertainties: ['fake'],
    };
  } else if (name === 'reconstruction_review') {
    content = { findings: [{ severity: 'pass', message: 'Room count matches the plan (fake reviewer)', roomIds: [] }] };
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
});

let app: any;
let drain: () => Promise<void>;
beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  process.env.META_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  process.env.MODEL_API_KEY = 'test-key-not-real';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'walkin-live-'));
  process.env.LOG_LEVEL = 'silent';
  const { store } = await import('../src/store.js');
  await store.load();
  app = await (await import('../src/server.js')).buildApp();
  drain = (await import('../src/jobs/runner.js')).drain;
});
afterAll(async () => {
  await app.close();
  fake.close();
});

describe('live Meta path (against a fake endpoint)', () => {
  it('parses plans with Muse-shaped requests and records provenance', async () => {
    const imp = (await app.inject({ method: 'POST', url: '/api/properties/import', payload: { provider: 'fixture', listingId: 'demo-house-001' } })).json();
    const { jobId } = (await app.inject({ method: 'POST', url: `/api/properties/${imp.property.id}/reconstruct`, payload: {} })).json();
    await drain();
    const job = (await app.inject({ url: `/api/reconstruction-jobs/${jobId}` })).json();
    expect(job.state, JSON.stringify(job.logs)).toBe('READY');
    expect(job.aiCalls).toBe(3); // 2 plan levels + 1 verification pass

    const planReq = requests.find((r) => r.body.response_format?.json_schema?.name === 'floorplan_level')!;
    expect(planReq.path).toBe('/v1/chat/completions');
    expect(planReq.body.model).toBe('muse-spark-1.3');
    expect(planReq.body.response_format.json_schema.strict).toBe(true);
    const user = planReq.body.messages.find((m: any) => m.role === 'user');
    expect(user.content.some((c: any) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png;base64,'))).toBe(true);
    expect(planReq.body.messages.find((m: any) => m.role === 'system').content).toEqual(expect.any(String)); // no images outside user role

    const scene = (await app.inject({ url: `/api/properties/${imp.property.id}/scene` })).json();
    expect(scene.evidenceFlags.floorplanInterpretedBy).toBe('meta:muse-spark-1.3');
    expect(scene.evidenceFlags.liveMetaInference).toBe(true);
    expect(scene.verification.visualReview.status).toBe('completed');
    expect(scene.structure.rooms.map((r: any) => r.id)).toContain('L0-living');
    expect(scene.verification.geometry.filter((c: any) => c.severity === 'fail')).toEqual([]);
  });
});
