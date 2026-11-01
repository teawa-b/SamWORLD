/**
 * Outbound HTTP for user-supplied URLs (listing pages, image URLs).
 *
 * SSRF guard: only http(s) on the default ports, every DNS answer is checked
 * against private/loopback/link-local/reserved ranges at connect time (so DNS
 * rebinding can't swap in an internal address after validation), redirects are
 * followed manually and re-validated, and bodies are size- and time-capped.
 * No cookies or credentials are ever sent.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export class FetchBlockedError extends Error {
  code = 'URL_NOT_ALLOWED';
}
export class FetchFailedError extends Error {
  constructor(
    message: string,
    public status: number | null = null,
  ) {
    super(message);
  }
  code = 'FETCH_FAILED';
}

export const USER_AGENT = 'WalkIn-Importer/0.2 (+property reconstruction prototype; respects robots.txt)';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

/** True when an address must never be contacted on behalf of a user. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true; // mapped v4 in hex form: refuse rather than decode
    return /^(fc|fd|fe8|fe9|fea|feb|ff|2001:db8|64:ff9b)/.test(s);
  }
  return true;
}

/** Throws unless the URL is a plain public http(s) URL. Returns the parsed URL. */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError('That is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchBlockedError('Only http and https URLs can be imported.');
  if (url.username || url.password) throw new FetchBlockedError('URLs with credentials are not accepted.');
  if (url.port && !['80', '443'].includes(url.port)) throw new FetchBlockedError('Only the standard web ports (80/443) are allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedAddress(host)) throw new FetchBlockedError('Private and local network addresses are not allowed.');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) throw new FetchBlockedError('Local host names are not allowed.');
  return url;
}

/** DNS lookup that refuses to hand a blocked address to the socket. */
function guardedLookup(hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '', 4);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (!list.length || bad) {
      const e = new FetchBlockedError(`${hostname} resolves to a private or reserved address.`) as unknown as NodeJS.ErrnoException;
      return cb(e, '', 4);
    }
    if ((options as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

export interface SafeResponse {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  accept?: string;
  maxRedirects?: number;
}

export type Fetcher = (url: string, opts: SafeFetchOptions) => Promise<SafeResponse>;

function once(url: URL, opts: SafeFetchOptions): Promise<SafeResponse & { location?: string }> {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup as never,
        headers: { 'user-agent': USER_AGENT, accept: opts.accept ?? '*/*', 'accept-encoding': 'identity' },
        timeout: opts.timeoutMs ?? 15000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ url: url.toString(), status, contentType: '', body: Buffer.alloc(0), location: res.headers.location });
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          return reject(new FetchFailedError(`File is too large (${Math.round(declared / 1e6)} MB; limit ${Math.round(opts.maxBytes / 1e6)} MB).`, status));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            res.destroy();
            reject(new FetchFailedError(`File is too large (limit ${Math.round(opts.maxBytes / 1e6)} MB).`, status));
          } else chunks.push(c);
        });
        res.on('end', () => resolve({ url: url.toString(), status, contentType: String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new FetchFailedError('The site took too long to answer.')));
    req.on('error', (e) => reject(e instanceof FetchBlockedError || e instanceof FetchFailedError ? e : new FetchFailedError(`Could not reach ${url.hostname}: ${(e as Error).message}`)));
    req.end();
  });
}

/** GET a user-supplied URL safely. Non-2xx answers resolve with their status; callers decide. */
export const safeFetch: Fetcher = async (raw, opts) => {
  let url = assertPublicUrl(raw);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const r = await once(url, opts);
    if (!r.location) return r;
    url = assertPublicUrl(new URL(r.location, url).toString());
  }
  throw new FetchFailedError('Too many redirects.');
};

// ---------------------------------------------------------------------------
// robots.txt (we honour Disallow rules for our user agent and for *)
// ---------------------------------------------------------------------------
const robotsCache = new Map<string, { at: number; rules: { allow: boolean; path: string }[] }>();

export function parseRobots(text: string, agent = 'walkin-importer'): { allow: boolean; path: string }[] {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if ((key === 'disallow' || key === 'allow') && val) cur.rules.push({ allow: key === 'allow', path: val });
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  return (mine ?? groups.find((g) => g.agents.includes('*')))?.rules ?? [];
}

export function robotsAllows(rules: { allow: boolean; path: string }[], path: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const pattern = new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
    if (pattern.test(path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

/** Whether robots.txt lets us fetch this page. Unreachable/absent robots.txt counts as allowed. */
export async function robotsPermit(url: URL, fetcher: Fetcher = safeFetch): Promise<boolean> {
  const origin = url.origin;
  let entry = robotsCache.get(origin);
  if (!entry || Date.now() - entry.at > 6 * 3600e3) {
    let rules: { allow: boolean; path: string }[] = [];
    try {
      const r = await fetcher(`${origin}/robots.txt`, { maxBytes: 512 * 1024, timeoutMs: 8000, accept: 'text/plain' });
      if (r.status >= 200 && r.status < 300) rules = parseRobots(r.body.toString('utf8'));
    } catch {
      /* treat as no rules */
    }
    entry = { at: Date.now(), rules };
    robotsCache.set(origin, entry);
  }
  return robotsAllows(entry.rules, url.pathname + url.search);
}
