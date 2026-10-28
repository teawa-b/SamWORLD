/**
 * Imports every fixture listing, runs the full pipeline, and writes the scene
 * manifests (plus plan images) to app-web/public/cached/ so the viewer can be
 * hosted statically — e.g. for Quest testing — with no API running.
 * Uses live Meta inference if MODEL_API_KEY is set; otherwise fixture data.
 */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { drain } from './jobs/runner.js';
import { importFixture, resolveStorageKey, searchFixtures } from './providers/fixture.js';
import { store } from './store.js';

await store.load();
await mkdir(config.bakeOutDir, { recursive: true });
const index: { propertyId: string; address: string; file: string; liveMeta: boolean }[] = [];
for (const r of searchFixtures('')) {
  const id = `prop-${r.listingId}`;
  const imported = importFixture(r.listingId, id, new Date().toISOString())!;
  await store.put('properties', id, imported.property);
  for (const m of imported.media) await store.put('media', m.id, m);
  const runId = `run-bake-${Date.now()}`;
  await store.put('runs', runId, {
    id: runId, propertyId: id, state: 'QUEUED', step: 'queued', progress: 0, attempts: 0,
    options: { forceReparse: process.argv.includes('--reparse'), sam3dApproved: false },
    heartbeatAt: null, errorCode: null, errorMessage: null, startedAt: null, finishedAt: null,
    modelVersions: {}, promptVersions: {}, aiCalls: 0, totalCostEstimate: '', outputSceneVersion: null, logs: [],
  });
  await drain();
  const run = store.get('runs', runId)!;
  for (const l of run.logs) console.log(`[${l.level}] ${l.step}: ${l.message}`);
  if (run.state !== 'READY') throw new Error(`${r.listingId}: ${run.errorCode} ${run.errorMessage}`);
  const scene = structuredClone(store.get('scenes', id)!);
  // Point media at static copies instead of the API.
  for (const m of scene.media) {
    const abs = resolveStorageKey(m.storageKey);
    const name = `${m.id}.${m.storageKey.split('.').pop()}`;
    if (abs) await copyFile(abs, join(config.bakeOutDir, name));
    m.metadata = { ...m.metadata, staticUrl: `cached/${name}` };
  }
  const file = `${id}.json`;
  await writeFile(join(config.bakeOutDir, file), JSON.stringify(scene));
  index.push({ propertyId: id, address: scene.property.address, file, liveMeta: scene.evidenceFlags.liveMetaInference });
  console.log(`baked ${file}`);
}
await writeFile(join(config.bakeOutDir, 'index.json'), JSON.stringify(index, null, 2));
