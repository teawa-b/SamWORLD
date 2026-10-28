/**
 * Resolves the model IDs this API key can actually use. Asks GET /models once,
 * logs what is available and, when a configured ID is missing, switches to the
 * closest one from the same family (e.g. another muse-spark version). Explicit
 * env overrides are kept if they exist in the list.
 */
import { config, metaConfigured } from '../config.js';
import { metaClient } from './client.js';

type Role = 'museModel' | 'escalationModel' | 'samModel' | 'imageModel';
const FAMILY: Record<Role, RegExp[]> = {
  museModel: [/^muse-spark/i, /^muse-(?!image|wonder)/i],
  escalationModel: [/^muse-wonder/i, /^muse-spark/i],
  samModel: [/^sam-?3/i, /^sam/i],
  imageModel: [/^muse-image/i, /image/i],
};

export interface ModelResolution {
  available: string[] | null;
  chosen: Record<Role, string>;
  changed: string[];
  error?: string;
}

/** Newest first: compare the numeric parts of the ID, then prefer plain IDs over variants. */
function rank(ids: string[]): string[] {
  const nums = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  return [...ids].sort((a, b) => {
    const [x, y] = [nums(a), nums(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return a.split('-').length - b.split('-').length;
  });
}

export function pickModels(available: string[], current: Record<Role, string>): { chosen: Record<Role, string>; changed: string[] } {
  const chosen = { ...current };
  const changed: string[] = [];
  for (const role of Object.keys(FAMILY) as Role[]) {
    if (available.includes(current[role])) continue;
    for (const re of FAMILY[role]) {
      const match = rank(available.filter((id) => re.test(id)))[0];
      if (match) {
        chosen[role] = match;
        changed.push(`${role}: ${current[role]} → ${match}`);
        break;
      }
    }
  }
  return { chosen, changed };
}

let pending: Promise<ModelResolution> | null = null;
export let lastResolution: ModelResolution | null = null;

export function resolveModels(): Promise<ModelResolution> {
  const current = () => ({ museModel: config.meta.museModel, escalationModel: config.meta.escalationModel, samModel: config.meta.samModel, imageModel: config.meta.imageModel });
  if (!metaConfigured()) return Promise.resolve({ available: null, chosen: current(), changed: [] });
  pending ??= (async () => {
    try {
      const ids: string[] = [];
      for await (const m of metaClient().models.list()) ids.push(m.id);
      if (!ids.length) throw new Error('model list was empty');
      const { chosen, changed } = pickModels(ids, current());
      Object.assign(config.meta, chosen);
      return (lastResolution = { available: ids.sort(), chosen, changed });
    } catch (e) {
      pending = null; // try again on the next job
      return (lastResolution = { available: null, chosen: current(), changed: [], error: (e as Error).message });
    }
  })();
  return pending;
}
