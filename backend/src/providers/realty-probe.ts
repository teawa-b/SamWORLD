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
    ['rightmove', '/search/bycoordinates?latitude=51.5074&longitude=-0.1278&radius=1&searchType=RENT&resultCount=5', (f) => [`/details/byid?propertyId=${f?.id ?? f?.propertyId ?? ''}`]],
  ];
  const only = process.env.REALTYAPI_PROBE_PROVIDERS?.split(',');
  if (only) samples.splice(0, samples.length, ...samples.filter(([p]) => only.includes(p)));
  for (const [p, search, next] of samples) {
    const res: any = await getJson(`https://${p}.realtyapi.io${search}`);
    log(`[realty-sample] ${p} search shape`, keysOf(res));
    if (p === 'rightmove') {
      // Values (not just types) of the fields that matter for parsing; listing data is public.
      const r = Object.values(res ?? {}).find((v) => Array.isArray(v))?.[0] as any;
      log(`[realty-sample] rightmove first result`, JSON.stringify(r ?? null).slice(0, 2500));
    }
    const list = Array.isArray(res) ? res : Object.values(res ?? {}).find((v) => Array.isArray(v)) ?? res?.data?.results ?? res?.data?.home_search?.results ?? [];
    const first = (list as any[])[0];
    for (const path of next(first)) {
      const d = await getJson(`https://${p}.realtyapi.io${path}`);
      log(`[realty-sample] ${p} ${path.split('?')[0]} shape`, keysOf(d));
      if (p === 'rightmove') {
        log(`[realty-sample] rightmove detail`, JSON.stringify(d ?? null).slice(0, 6000));
        log(`[realty-sample] rightmove floorplans`, JSON.stringify(findKey(d, /^floor_?plans?$/i) ?? null).slice(0, 1500));
      }
    }
  }
  log('[realty-sample] done');
}

/** First value anywhere in `v` whose key matches `re` (depth-limited). */
function findKey(v: unknown, re: RegExp, depth = 0): unknown {
  if (!v || typeof v !== 'object' || depth > 6) return undefined;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (re.test(k) && x != null && x !== '') return x;
    const hit = findKey(x, re, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Floor-plan entries anywhere in `v`, under any key spelled like "floorplan(s)". */
function planCount(v: unknown): number {
  const p = findKey(v, /^floor_?plans?$/i);
  return Array.isArray(p) ? p.length : p ? 1 : 0;
}

const outcode = (s: string) => s.match(/\b([A-Z]{1,2}\d[A-Z\d]?)(\s*\d[A-Z]{2})?\b/)?.[0] ?? null;

/**
 * REALTYAPI_PROBE=3: for Zoopla listings, can a floor plan be found elsewhere? Checks Rightmove's address match
 * and Zoopla's own listing history for the same property. Logs counts and field names only, no addresses.
 * Spends about 4 calls per listing plus the searches (~30 in all).
 */
export async function checkPlanSources(log: Log) {
  const n = Number(process.env.REALTYAPI_PROBE_LISTINGS ?? 6);
  const picked: { id: string; channel: string }[] = [];
  for (const searchType of ['For_Sale', 'To_Rent']) {
    const res: any = await getJson(`https://zoopla.realtyapi.io/search/bycoordinates?latitude=51.5074&longitude=-0.1278&radius=3&searchType=${searchType}`);
    const list = (res?.searchResults ?? []) as any[];
    for (const r of list.slice(0, Math.ceil(n / 2))) picked.push({ id: String(r.listingId ?? r.id), channel: searchType });
  }
  let firstHistoryLogged = false;
  for (const [i, { id, channel }] of picked.entries()) {
    const tag = `[plan-sources] #${i + 1} ${channel}`;
    const det: any = await getJson(`https://zoopla.realtyapi.io/details/byid?listingId=${id}`);
    const d = det?.detail ?? {};
    const address = String(d.displayAddress ?? '');
    const postcode = findKey(d, /^post_?code$/i);
    const uprn = findKey(d, /^uprn$/i);
    const query = postcode && !address.includes(String(postcode)) ? `${address}, ${postcode}` : address;
    log(`${tag} zoopla`, { plans: planCount(d), beds: d.beds ?? null, hasOutcode: !!outcode(query), hasPostcode: !!postcode, hasUprn: !!uprn });

    const rm: any = await getJson(`https://rightmove.realtyapi.io/details/byaddress?address=${encodeURIComponent(query)}`);
    log(`${tag} rightmove`, typeof rm === 'string' ? { error: rm.slice(0, 120) } : {
      matchConfidence: findKey(rm, /^matchConfidence$/) ?? null,
      plans: planCount(rm),
      beds: findKey(rm, /^bedrooms$/i) ?? null,
      alternatives: (findKey(rm, /^alternatives$/) as unknown[] | undefined)?.length ?? 0,
      keys: Object.keys(rm ?? {}).slice(0, 30),
    });

    const hq = uprn ? `uprn=${uprn}` : `address=${encodeURIComponent(query)}`;
    const hist: any = await getJson(`https://zoopla.realtyapi.io/history?${hq}`);
    const past = (findKey(hist, /^historicListings$/) ?? []) as any[];
    if (!firstHistoryLogged && past.length) {
      log(`${tag} history listing shape`, keysOf(past[0]));
      firstHistoryLogged = true;
    }
    log(`${tag} history`, typeof hist === 'string' ? { error: hist.slice(0, 120) } : {
      historicListings: Array.isArray(past) ? past.length : 0,
      withPlans: Array.isArray(past) ? past.filter((p) => planCount(p) > 0).length : 0,
      keys: Object.keys(hist ?? {}).slice(0, 30),
    });
  }
  log('[plan-sources] done');
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
