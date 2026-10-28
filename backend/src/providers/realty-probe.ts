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
