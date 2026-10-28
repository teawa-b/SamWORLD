/**
 * Persistent job runner over the runs table. Picks QUEUED runs one at a time
 * (concurrency 1 keeps AI/GPU spend predictable), heartbeats while working,
 * and on start-up re-queues runs whose worker died (stale heartbeat) until
 * JOB_MAX_ATTEMPTS is reached.
 */
import type { ReconstructionRun } from '../shared/index.js';
import { config } from '../config.js';
import { store } from '../store.js';
import { PipelineError, runPipeline } from './pipeline.js';

const ACTIVE: ReconstructionRun['state'][] = ['INGESTED', 'STRUCTURE_PARSED', 'SHELL_BUILT', 'MEDIA_MATCHED', 'SEGMENTED', 'PLACED', 'VERIFIED'];

let busy = false;
let timer: NodeJS.Timeout | null = null;

/** `all`: re-queue every unfinished run (safe when this process is the only worker and has just started). */
export async function recoverStaleRuns(opts: { all?: boolean } = {}): Promise<void> {
  const cutoff = opts.all ? Infinity : Date.now() - config.jobs.staleAfterMs;
  for (const run of Object.values(store.all('runs'))) {
    if (!ACTIVE.includes(run.state)) continue;
    if (run.heartbeatAt && Date.parse(run.heartbeatAt) > cutoff) continue;
    if (run.attempts >= config.jobs.maxAttempts) {
      Object.assign(run, { state: 'FAILED', errorCode: 'WORKER_LOST', errorMessage: 'Worker stopped mid-run and the retry limit was reached.', finishedAt: new Date().toISOString() });
    } else {
      run.state = 'QUEUED';
      run.logs.push({ at: new Date().toISOString(), step: run.step, level: 'warn', message: 'Worker stopped mid-run; re-queued' });
    }
    await store.put('runs', run.id, run);
  }
}

async function tick(): Promise<void> {
  if (busy) return;
  if (!config.workerInline) await store.refresh('runs');
  const next = Object.values(store.all('runs'))
    .filter((r) => r.state === 'QUEUED')
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!next) return;
  busy = true;
  next.attempts++;
  next.startedAt = new Date().toISOString();
  next.heartbeatAt = next.startedAt;
  next.errorCode = null;
  next.errorMessage = null;
  await store.put('runs', next.id, next);
  try {
    await runPipeline(next.id, next.options);
  } catch (e) {
    const run = store.get('runs', next.id)!;
    const err = e as Error & { code?: string };
    run.state = 'FAILED';
    run.errorCode = err instanceof PipelineError ? err.code : (err.code ?? 'PIPELINE_ERROR');
    run.errorMessage = err.message;
    run.finishedAt = new Date().toISOString();
    run.logs.push({ at: run.finishedAt, step: run.step, level: 'error', message: err.message });
    await store.put('runs', run.id, run);
    console.error(`[runner] ${run.id} failed:`, err);
  } finally {
    busy = false;
  }
}

export function startRunner(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), config.jobs.pollMs);
}

export function stopRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Run every queued job to completion (used by the bake script and tests). */
export async function drain(): Promise<void> {
  for (;;) {
    const pending = Object.values(store.all('runs')).some((r) => r.state === 'QUEUED');
    if (!pending) return;
    await tick();
  }
}
