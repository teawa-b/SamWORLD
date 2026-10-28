import Fastify from 'fastify';
import cors from '@fastify/cors';
import { capabilities, config } from './config.js';
import { recoverStaleRuns, startRunner } from './jobs/runner.js';
import { registerRoutes } from './routes.js';
import { store } from './store.js';
import { probeRealty, sampleRealty } from './providers/realty-probe.js';
import { resolveModels } from './meta/models.js';

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 256 * 1024 });
  await app.register(cors, { origin: config.corsOrigins, methods: ['GET', 'POST', 'PATCH'] });
  await registerRoutes(app);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await store.load();
  const app = await buildApp();
  if (config.workerInline) {
    await recoverStaleRuns({ all: true }); // inline worker: nothing can still be running after a restart
    startRunner();
  }
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ capabilities: capabilities(), workerInline: config.workerInline }, 'WalkIn API ready');
  void resolveModels().then((r) => app.log.info(r, r.error ? 'Meta model list unavailable' : 'Meta models resolved'));
  if (process.env.REALTYAPI_PROBE === '1') void probeRealty((msg, obj) => app.log.info({ probe: obj }, msg));
  if (process.env.REALTYAPI_PROBE === '2') void sampleRealty((msg, obj) => app.log.info({ probe: obj }, msg));
}
