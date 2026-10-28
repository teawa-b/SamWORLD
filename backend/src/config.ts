/**
 * All configuration comes from environment variables. Secrets are read here
 * and never serialised into responses, logs or scene manifests.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// backend/ — everything the server needs lives inside this folder.
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

// Load backend/.env if present. Existing environment variables take precedence.
try {
  process.loadEnvFile(resolve(root, '.env'));
} catch {
  /* no .env file */
}

const bool = (v: string | undefined, d: boolean) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => (v ? Number.parseInt(v, 10) : d);

export const config = {
  port: int(process.env.PORT, 8787),
  host: process.env.HOST ?? '0.0.0.0',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:8081,https://localhost:8081').split(',').map((s) => s.trim()),
  backendRoot: root,
  dataDir: resolve(process.env.DATA_DIR ?? `${root}/data`),
  fixturesDir: resolve(process.env.FIXTURES_DIR ?? `${root}/fixtures`),
  // `npm run bake` writes static scenes here; defaults to the sibling
  // frontend checkout so a local bake lands in frontend/public/cached.
  bakeOutDir: resolve(process.env.BAKE_OUT_DIR ?? `${root}/../frontend/public/cached`),

  // Run the job worker inside the API process (fine for one-box deploys).
  // Set to false and run `npm run worker` for a separate worker process.
  workerInline: bool(process.env.WORKER_INLINE, true),

  meta: {
    apiKey: process.env.MODEL_API_KEY ?? '',
    baseUrl: process.env.META_BASE_URL ?? 'https://api.meta.ai/v1',
    museModel: process.env.MUSE_MODEL ?? 'muse-spark-1.3',
    escalationModel: process.env.MUSE_ESCALATION_MODEL ?? 'muse-wonder-1.0',
    escalationEnabled: bool(process.env.MUSE_ESCALATION_ENABLED, false),
    samModel: process.env.SAM_MODEL ?? 'sam-3.1',
    imageModel: process.env.MUSE_IMAGE_MODEL ?? 'muse-image-1.0',
    redesignEnabled: bool(process.env.REDESIGN_ENABLED, false),
    timeoutMs: int(process.env.AI_TIMEOUT_MS, 120_000),
    maxCallsPerRun: int(process.env.AI_MAX_CALLS_PER_RUN, 40),
    maxSamImagesPerRun: int(process.env.SAM_MAX_IMAGES_PER_RUN, 8),
    maxSamConceptsPerImage: int(process.env.SAM_MAX_CONCEPTS_PER_IMAGE, 4),
    maxRedesignsPerDay: int(process.env.REDESIGN_MAX_PER_DAY, 10),
  },

  realty: {
    apiKey: process.env.REALTYAPI_KEY ?? '',
    provider: process.env.REALTYAPI_PROVIDER ?? '',
  },

  sam3d: {
    enabled: bool(process.env.SAM3D_ENABLED, false),
    endpointUrl: process.env.MODAL_ENDPOINT_URL ?? '',
    authSecret: process.env.MODAL_AUTH_SECRET ?? '',
    maxObjectsPerRun: int(process.env.SAM3D_MAX_OBJECTS_PER_RUN, 1),
    timeoutSeconds: int(process.env.SAM3D_JOB_TIMEOUT_SECONDS, 600),
    requireManualApproval: bool(process.env.SAM3D_REQUIRE_MANUAL_APPROVAL, true),
  },

  jobs: {
    maxAttempts: int(process.env.JOB_MAX_ATTEMPTS, 2),
    staleAfterMs: int(process.env.JOB_STALE_AFTER_MS, 5 * 60_000),
    pollMs: int(process.env.JOB_POLL_MS, 1000),
  },
};

export const metaConfigured = () => config.meta.apiKey.length > 0;

/** Safe-to-expose capability summary for /health and the UI. */
export function capabilities() {
  return {
    liveMeta: metaConfigured(),
    museModel: config.meta.museModel,
    escalation: config.meta.escalationEnabled ? config.meta.escalationModel : null,
    samModel: config.meta.samModel,
    redesign: metaConfigured() && config.meta.redesignEnabled,
    realtyApi: config.realty.apiKey.length > 0,
    sam3d: config.sam3d.enabled && !!config.sam3d.endpointUrl,
  };
}
