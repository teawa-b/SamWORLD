/**
 * One-off discovery for RealtyAPI providers. With REALTYAPI_PROBE=1 the server
 * fetches the public catalogue and each provider's OpenAPI spec at start-up and
 * logs a compact summary (paths, parameters, response fields). It never calls
 * a search endpoint, so it does not spend the listing quota.
 */
import { config } from '../config.js';

type Log = (msg: string, obj?: unknown) => void;

const PROVIDERS = (process.env.REALTYAPI_PROBE_PROVIDERS ?? 'zoopla,zillow,realtor,realtor-com,redfin,rightmove').split(',');

async function getText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json,text/plain', 'x-realtyapi-key': config.realty.apiKey }, signal: AbortSignal.timeout(20000) });
    return r.ok ? await r.text() : `HTTP ${r.status}`;
  } catch (e) {
    return `ERR ${(e as Error).message}`;
  }
}

function deref(spec: any, node: any, depth = 0): any {
  if (!node || depth > 6) return node;
  if (node.$ref) {
    const path = String(node.$ref).replace(/^#\//, '').split('/');
    return deref(spec, path.reduce((o: any, k: string) => o?.[k], spec), depth + 1);
  }
  return node;
}

function shape(spec: any, schema: any, depth = 0): unknown {
  const s = deref(spec, schema);
  if (!s || depth > 3) return s?.type ?? '?';
  if (s.type === 'array') return [shape(spec, s.items, depth + 1)];
  if (s.properties) return Object.fromEntries(Object.entries(s.properties).slice(0, 40).map(([k, v]) => [k, shape(spec, v, depth + 1)]));
  return s.type ?? (s.oneOf || s.anyOf ? 'union' : '?');
}

/** Field names and value types only (strings truncated), so logs carry structure, not data. */
function keysOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [keysOf(v[0], depth + 1), `…${v.length}`] : [];
  if (v && typeof v === 'object') {
    if (depth > 4) return '{…}';
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 60).map(([k, x]) => [k, keysOf(x, depth + 1)]));
  }
  if (typeof v === 'string') return /^https?:/.test(v) ? `url(${v.split('/')[2]})` : `str(${v.length})`;
  return typeof v;
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { accept: 'application/json', 'x-realtyapi-key': config.realty.apiKey }, signal: AbortSignal.timeout(45000) });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return `HTTP ${r.status} ${t.slice(0, 120)}`;
  }
}

/** REALTYAPI_PROBE=2: one sample search + details per provider (spends ~7 calls). */
export async function sampleRealty(log: Log) {
  const samples: [string, string, (first: any) => string[]][] = [
    ['zoopla', '/search/bycoordinates?latitude=51.5074&longitude=-0.1278&radius=1&searchType=To_Rent', (f) => [`/details/byid?listingId=${f?.listingId ?? f?.id ?? ''}`, `/images?listingId=${f?.listingId ?? f?.id ?? ''}`]],
    ['zillow', '/search/bycoordinates?latitude=40.7128&longitude=-74.0060&radius=1&listingStatus=For_Rent', (f) => [`/byzpid?zpid=${f?.zpid ?? f?.property?.zpid ?? ''}`, `/propimages?byzpid=${f?.zpid ?? f?.property?.zpid ?? ''}`]],
    ['realtor', '/search/bycoordinates?latitude=40.7128&longitude=-74.0060&radius=1&searchType=For_Rent&resultCount=5', (f) => [`/details/byid?property_id=${f?.property_id ?? f?.propertyId ?? ''}${f?.listing_id ? `&listing_id=${f.listing_id}` : ''}`]],
  ];
  for (const [p, search, next] of samples) {
    const res: any = await getJson(`https://${p}.realtyapi.io${search}`);
    log(`[realty-sample] ${p} search shape`, keysOf(res));
    const list = Array.isArray(res) ? res : Object.values(res ?? {}).find((v) => Array.isArray(v)) ?? res?.data?.results ?? res?.data?.home_search?.results ?? [];
    const first = (list as any[])[0];
    for (const path of next(first)) {
      const d = await getJson(`https://${p}.realtyapi.io${path}`);
      log(`[realty-sample] ${p} ${path.split('?')[0]} shape`, keysOf(d));
    }
  }
  log('[realty-sample] done');
}

export async function probeRealty(log: Log) {
  const llms = await getText('https://www.realtyapi.io/llms.txt');
  log('[realty-probe] llms.txt lines', (llms ?? '').split('\n').filter((l) => /realtyapi\.io|provider|zoopla|zillow|realtor|redfin|rightmove/i.test(l)).slice(0, 80));
  for (const p of PROVIDERS) {
    const raw = await getText(`https://${p}.realtyapi.io/openapi.json`);
    if (!raw || !raw.trim().startsWith('{')) {
      log(`[realty-probe] ${p}: ${raw?.slice(0, 120)}`);
      continue;
    }
    const spec = JSON.parse(raw);
    const paths = Object.entries(spec.paths ?? {}).map(([path, ops]: [string, any]) =>
      Object.entries(ops).map(([method, op]: [string, any]) => ({
        method,
        path,
        summary: op.summary,
        params: (op.parameters ?? []).map((x: any) => deref(spec, x)).map((x: any) => `${x.name}${x.required ? '*' : ''}:${x.schema?.type ?? ''}${x.schema?.enum ? `[${x.schema.enum.slice(0, 12).join('|')}]` : ''}`),
        response: shape(spec, op.responses?.['200']?.content?.['application/json']?.schema),
      })),
    );
    log(`[realty-probe] ${p} ${spec.info?.title ?? ''} servers=${JSON.stringify(spec.servers ?? [])} security=${JSON.stringify(spec.components?.securitySchemes ?? {})}`);
    for (const op of paths.flat()) log(`[realty-probe] ${p} ${op.method.toUpperCase()} ${op.path}`, op);
  }
  log('[realty-probe] done');
}
