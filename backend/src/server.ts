import Fastify from 'fastify';
import cors from '@fastify/cors';
import { capabilities, config } from './config.js';
import { recoverStaleRuns, startRunner } from './jobs/runner.js';
import { registerRoutes } from './routes.js';
import { store } from './store.js';
import { probeRealty } from './providers/realty-probe.js';

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
    await recoverStaleRuns();
    startRunner();
  }
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ capabilities: capabilities(), workerInline: config.workerInline }, 'WalkIn API ready');
  if (process.env.REALTYAPI_PROBE === '1') void probeRealty((msg, obj) => app.log.info({ probe: obj }, msg));
}
