import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Fake Muse: round 1 puts the sofa on the wrong side of the room; round 2 (after being told) fixes it.
const bodies: any[] = [];
let calls = 0;
const fake = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = JSON.parse(b);
    bodies.push(body);
    calls++;
    const camera = { photo: 0, x: 2, z: 3.8, headingDeg: 0, hfovDeg: 90, reasoning: 'standing by the south wall looking north' };
    const sofa = (x: number) => ({ kind: 'sofa', detectionIds: ['det-sofa'], x, z: 0.6, facingDeg: 180, widthM: 2, depthM: 0.9, heightM: 0.8, againstWall: 'north', evidence: 'fake', confidence: 0.8 });
    const content = { cameras: [camera], objects: [sofa(calls === 1 ? 3.4 : 1.0)], notes: [] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
});

let mod: typeof import('../src/meta/survey.js');
let AiBudget: typeof import('../src/meta/client.js').AiBudget;
beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  process.env.META_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  process.env.MODEL_API_KEY = 'test-key-not-real';
  mod = await import('../src/meta/survey.js');
  AiBudget = (await import('../src/meta/client.js')).AiBudget;
});
afterAll(() => fake.close());

// A 4 m × 4 m room (x 0–4, z 0–4). Camera at the south looking north: x = 1 is left of centre.
const structure: any = {
  scale: { metersPerPx: 0.01, method: 'dimension-labels', samples: 2, spreadPct: 0, estimated: false },
  levels: [{ id: 'L0', propertyId: 'p', index: 0, name: 'Ground', elevationMeters: 0, heightMeters: 2.4, heightEstimated: true, originalPlanMediaId: 'plan', stairVoids: [], confidence: 1 }],
  rooms: [{ id: 'r1', levelId: 'L0', label: 'Living room', type: 'living', polygonXZMeters: [[0, 0], [4, 0], [4, 4], [0, 4]], areaSqM: 16, ceilingHeightMeters: 2.4, doorIds: [], windowIds: [], linkedMediaIds: ['m0'], confidence: 1, isEstimated: false, dimensionsMeasured: true, spawnPoint: [2, 2] }],
  walls: [],
  openings: [{ id: 'w1', levelId: 'L0', roomIds: ['r1'], type: 'window', parentWallId: null, offsetAlongWall: 2, position: [2, 0], widthM: 1.2, heightM: 1.2, sillM: 0.9, confidence: 1 }],
  footprintBounds: { min: [0, 0], max: [4, 4] },
};
// SAM saw the sofa on the LEFT of the photo (box 10–45% across).
const detections: any[] = [{ id: 'det-sofa', mediaId: 'm0', concept: 'sofa', box: [0.1, 0.5, 0.45, 0.8], score: 0.9, maskKey: null, provenance: { method: 'meta:sam-3.1', at: 'x' } }];

describe('room survey (multi-round, checked against SAM)', () => {
  it('projects objects into a photo from the estimated camera', () => {
    const cam = { photo: 0, x: 2, z: 3.8, headingDeg: 0, hfovDeg: 90 };
    expect(mod.projectU(cam, 2, 0.6)).toBeCloseTo(0.5);
    expect(mod.projectU(cam, 1, 0.6)!).toBeLessThan(0.4);
    expect(mod.projectU(cam, 3.4, 0.6)!).toBeGreaterThan(0.6);
    expect(mod.projectU(cam, 2, 3.95)).toBeNull(); // behind the camera
  });

  it('describes walls with lengths and openings for the surveyor', () => {
    const t = mod.describeRoom(structure, 'r1');
    expect(t).toMatch(/north wall from \(0\.00, 0\.00\) to \(4\.00, 0\.00\), 4\.00 m: window 1\.20 m wide/);
    expect(t).toMatch(/printed measurements/);
  });

  it('sends the disagreement back to Muse and keeps the corrected position', async () => {
    const rounds: number[] = [];
    const r = await mod.surveyRoom({ budget: new AiBudget(10), structure, roomId: 'r1', photos: [{ mediaId: 'm0', dataUrl: 'data:image/png;base64,AAAA' }], detections, maxRounds: 3, onRound: (n, issues) => void rounds.push(issues.length) });
    expect(calls).toBe(2);
    expect(rounds[0]).toBeGreaterThan(0); // round 1 disagreed with SAM
    expect(rounds[1]).toBe(0); // round 2 agrees
    const second = JSON.stringify(bodies[1].messages);
    expect(second).toMatch(/would appear 72% across the image, but SAM found it at 28%/);
    expect(r.rounds).toBe(2);
    const c = r.candidates[0];
    expect(c.anchor).toMatchObject({ type: 'at', x: 1, z: 0.6 });
    expect(c.sourceDetectionIds).toEqual(['det-sofa']);
    expect(c.sourceMediaIds).toEqual(['m0']);
  });
});
