/** Standalone worker: `WORKER_INLINE=false` on the API, then run this. */
import { recoverStaleRuns, startRunner } from './jobs/runner.js';
import { store } from './store.js';

await store.load();
await recoverStaleRuns();
startRunner();
console.log('[worker] polling for reconstruction jobs');
