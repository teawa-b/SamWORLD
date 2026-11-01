/**
 * Listing-URL importer: pulls the public listing page, then extracts the title,
 * description, basic facts and every candidate photo/floor-plan URL.
 *
 * One generic extractor (JSON-LD, OpenGraph, <img>/<source> incl. lazy-load
 * attributes and srcset, image URLs embedded in page JSON) plus small
 * site-specific adapters that can be added without touching the rest. No
 * adapter logs in, solves challenges or bypasses access controls: a blocked
 * page is reported as blocked and the user is offered upload instead.
 *
 * The same `extractListing` entry point is what a future browser extension
 * would call with HTML it already has (see `extractFromHtml`).
 */
import { assertPublicUrl, FetchFailedError, robotsPermit, safeFetch, type Fetcher } from '../lib/safe-fetch.js';

export interface CandidateImage {
  url: string;
  kind: 'photo' | 'floorplan';
  /** Why we think it is a floor plan / photo, and where we found it. */
  evidence: string;
  alt: string | null;
}

export interface ExtractedListing {
  sourceUrl: string;
  adapter: string;
  title: string | null;
  description: string | null;
  address: string | null;
  price: { amount: number; currency: string; period: 'pcm' | 'pw' | 'sale' } | null;
  bedrooms: number | null;
  bathrooms: number | null;
  areaSqM: number | null;
  images: CandidateImage[];
  notes: string[];
}

export class ExtractionError extends Error {
  constructor(
    public code: 'BLOCKED_BY_ROBOTS' | 'ACCESS_DENIED' | 'NOT_HTML' | 'NO_IMAGES' | 'FETCH_FAILED',
    message: string,
  ) {
    super(message);
  }
}

export interface ListingAdapter {
  id: string;
  matches(url: URL): boolean;
  /** Return whatever this site exposes; the generic extractor fills the gaps. */
  extract(page: { url: URL; html: string }): Partial<ExtractedListing>;
}

// ---------------------------------------------------------------------------
// Small HTML helpers (no DOM dependency; good enough for meta/img/script tags)
// ---------------------------------------------------------------------------
const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;|&#47;/gi, '/')
    .replace(/&nbsp;/g, ' ');

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => attrs(m[0]));

function meta(html: string, key: string): string | null {
  const t = tags(html, 'meta').find((a) => (a.property ?? a.name ?? '').toLowerCase() === key);
  return t?.content?.trim() || null;
}

/** Largest candidate from a srcset ("a.jpg 320w, b.jpg 1280w"). */
export function bestFromSrcset(srcset: string): string | null {
  let best: { url: string; w: number } | null = null;
  for (const part of srcset.split(/,\s+(?=\S)/)) {
    const [url, d] = part.trim().split(/\s+/);
    if (!url) continue;
    const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 1;
    if (!best || w > best.w) best = { url, w };
  }
  return best?.url ?? null;
}

const FLOORPLAN_RE = /floor[\s_-]?plan|floorplan|(^|[^a-z])flp([^a-z]|$)|grundriss|plan[_-]?de[_-]?masse/i;
const JUNK_RE = /(logo|icon|sprite|favicon|avatar|badge|placeholder|blank|pixel|spacer|tracking|loader|spinner|agent[-_]?photo|branch|map[-_]?static|staticmap|captcha|banner|advert)/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp)(\?|#|$)/i;

function classify(url: string, context: string): CandidateImage['kind'] {
  return FLOORPLAN_RE.test(url) || FLOORPLAN_RE.test(context) ? 'floorplan' : 'photo';
}

/** Absolute image URLs embedded in script/JSON text (escaped slashes handled). */
function urlsInText(text: string): string[] {
  const unescaped = text.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/');
  return [...unescaped.matchAll(/https?:\/\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>\\)]*)?/gi)].map((m) => m[0]);
}

/** Walk JSON-LD for images, with the key path as context (finds floor plans). */
function jsonLdImages(node: unknown, path: string, out: { url: string; ctx: string }[], depth = 0) {
  if (depth > 8 || node == null) return;
  if (typeof node === 'string') {
    if (/^https?:\/\//.test(node) && (IMAGE_EXT_RE.test(node) || /image|photo|plan|layout/i.test(path))) out.push({ url: node, ctx: path });
    return;
  }
  if (Array.isArray(node)) return node.forEach((n) => jsonLdImages(n, path, out, depth + 1));
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (/^(url|contentUrl|image|photo|photos|images|layoutImage|accommodationFloorPlan|floorPlan|floorplans?|thumbnailUrl|@graph|mainEntity|itemOffered|containsPlace)$/i.test(k) || typeof v === 'object') {
        jsonLdImages(v, `${path}.${k}`, out, depth + 1);
      }
    }
  }
}

function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      /* malformed block: skip */
    }
  }
  return out;
}

function findKey(node: unknown, re: RegExp, depth = 0): unknown {
  if (depth > 8 || node == null || typeof node !== 'object') return undefined;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (re.test(k) && v != null && typeof v !== 'object') return v;
    if (re.test(k) && typeof v === 'object' && v && 'value' in (v as object)) return (v as { value: unknown }).value;
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    const r = findKey(v, re, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

const toNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Generic extractor
// ---------------------------------------------------------------------------
export function extractFromHtml(html: string, pageUrl: URL, adapterId = 'generic'): ExtractedListing {
  const found: { url: string; ctx: string; alt: string | null; where: string }[] = [];
  const add = (raw: string | null | undefined, where: string, ctx = '', alt: string | null = null) => {
    if (!raw) return;
    const s = raw.trim();
    if (!s || s.startsWith('data:') || s.startsWith('blob:')) return;
    try {
      found.push({ url: new URL(s, pageUrl).toString(), ctx, alt, where });
    } catch {
      /* not a URL */
    }
  };

  // JSON-LD (schema.org Residence/Accommodation/Product/Offer ...)
  const ld = jsonLdBlocks(html);
  const ldImgs: { url: string; ctx: string }[] = [];
  ld.forEach((b) => jsonLdImages(b, 'ld', ldImgs));
  ldImgs.forEach((i) => add(i.url, 'structured data', i.ctx));

  // OpenGraph / Twitter cards
  for (const k of ['og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image']) add(meta(html, k), 'page preview image');

  // <img>, lazy-load attributes, srcset; <source srcset> in <picture>
  for (const a of tags(html, 'img')) {
    const ctx = `${a.alt ?? ''} ${a.title ?? ''} ${a.class ?? ''} ${a['data-testid'] ?? ''}`;
    const width = Number(a.width ?? 0);
    const height = Number(a.height ?? 0);
    if ((width && width < 120) || (height && height < 90)) continue;
    const srcset = a['data-srcset'] ?? a.srcset;
    add(srcset ? bestFromSrcset(srcset) : null, 'image srcset', ctx, a.alt ?? null);
    for (const k of ['data-src', 'data-lazy-src', 'data-original', 'data-full', 'data-zoom-image', 'data-large', 'src']) add(a[k], 'image tag', ctx, a.alt ?? null);
  }
  for (const a of tags(html, 'source')) {
    const s = a['data-srcset'] ?? a.srcset;
    if (s) add(bestFromSrcset(s), 'picture source');
  }
  // Links straight to images (galleries often link the full-size file)
  for (const a of tags(html, 'a')) if (a.href && IMAGE_EXT_RE.test(a.href)) add(a.href, 'image link', `${a.title ?? ''} ${a['aria-label'] ?? ''} ${a.class ?? ''}`);

  // Image URLs inside inline scripts (Next.js data, window.__STATE__ etc.)
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const text = m[1];
    if (text.length > 4_000_000) continue;
    for (const u of urlsInText(text)) {
      // The 200 characters before the URL usually hold its key ("floorplans": [...]).
      const at = text.indexOf(u.replace(/\//g, '\\/')) >= 0 ? text.indexOf(u.replace(/\//g, '\\/')) : text.indexOf(u);
      add(u, 'page data', at >= 0 ? text.slice(Math.max(0, at - 200), at) : '');
    }
  }

  // Normalise, filter and de-duplicate.
  const images: CandidateImage[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    const u = f.url;
    if (!/^https?:/.test(u) || JUNK_RE.test(u) || /\.(svg|gif|ico)(\?|$)/i.test(u)) continue;
    if (!IMAGE_EXT_RE.test(u) && !/image|img|photo|media|cdn|pic/i.test(u)) continue;
    const key = u.replace(/[?#].*$/, '').toLowerCase();
    if (seen.has(key)) {
      // Upgrade to floor plan if a later sighting says so.
      const prev = images.find((i) => i.url.replace(/[?#].*$/, '').toLowerCase() === key);
      if (prev && prev.kind === 'photo' && classify(u, f.ctx) === 'floorplan') prev.kind = 'floorplan';
      continue;
    }
    seen.add(key);
    const kind = classify(u, `${f.ctx} ${f.alt ?? ''}`);
    images.push({ url: u, kind, alt: f.alt, evidence: `${f.where}${kind === 'floorplan' ? ' · named as a floor plan' : ''}` });
  }

  // Facts
  const ldName = ld.map((b) => findKey(b, /^name$/)).find((v) => typeof v === 'string') as string | undefined;
  const ldDesc = ld.map((b) => findKey(b, /^description$/)).find((v) => typeof v === 'string') as string | undefined;
  const ldPrice = toNum(ld.map((b) => findKey(b, /^price$/)).find((v) => v != null));
  const ldCurrency = ld.map((b) => findKey(b, /^priceCurrency$/)).find((v) => typeof v === 'string') as string | undefined;
  const beds = toNum(ld.map((b) => findKey(b, /^(numberOfBedrooms|numberOfRooms)$/)).find((v) => v != null));
  const baths = toNum(ld.map((b) => findKey(b, /^(numberOfBathroomsTotal|numberOfFullBathrooms|numberOfBathrooms)$/)).find((v) => v != null));
  const ldAddress = ld.map((b) => findKey(b, /^streetAddress$/)).find((v) => typeof v === 'string') as string | undefined;
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = meta(html, 'og:title') ?? ldName ?? (titleTag ? decodeEntities(titleTag).trim() : null);
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const bedText = toNum(text.match(/(\d{1,2})\s*(?:bed(?:room)?s?)\b/i)?.[1]);
  const sqm = toNum(text.match(/(\d[\d,.]*)\s*(?:sq\.?\s*m|m²|m2|square met)/i)?.[1]);
  const sqft = toNum(text.match(/(\d[\d,.]*)\s*(?:sq\.?\s*ft|square f)/i)?.[1]);

  return {
    sourceUrl: pageUrl.toString(),
    adapter: adapterId,
    title: title?.slice(0, 200) ?? null,
    description: (meta(html, 'og:description') ?? meta(html, 'description') ?? ldDesc ?? null)?.slice(0, 4000) ?? null,
    address: ldAddress ?? null,
    price: ldPrice != null ? { amount: ldPrice, currency: ldCurrency ?? 'GBP', period: /rent|let|pcm|per month/i.test(text.slice(0, 20000)) ? 'pcm' : 'sale' } : null,
    bedrooms: beds ?? bedText ?? null,
    bathrooms: baths,
    areaSqM: sqm && sqm > 10 && sqm < 5000 ? sqm : sqft && sqft > 100 ? Math.round(sqft * 0.0929) : null,
    images,
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// Site adapters. Each only reads data the public page already contains.
// ---------------------------------------------------------------------------

/** JSON assigned to a global in an inline script, e.g. `window.PAGE_MODEL = {...}`. */
export function assignedJson(html: string, name: string): unknown {
  const i = html.indexOf(`${name} = `) >= 0 ? html.indexOf(`${name} = `) + name.length + 3 : html.indexOf(`${name}=`) >= 0 ? html.indexOf(`${name}=`) + name.length + 1 : -1;
  if (i < 0 || html[i] !== '{') return undefined;
  let depth = 0;
  let inStr = false;
  for (let j = i; j < html.length && j < i + 5_000_000; j++) {
    const c = html[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(i, j + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

type J = Record<string, any>;
const rightmove: ListingAdapter = {
  id: 'rightmove-page',
  matches: (u) => /(^|\.)rightmove\.co\.uk$/.test(u.hostname),
  extract: ({ html }) => {
    const model = assignedJson(html, 'window.PAGE_MODEL') as J | undefined;
    const d = model?.propertyData as J | undefined;
    if (!d) return { notes: ['Rightmove page data not found; used the generic extractor.'] };
    const imgs: CandidateImage[] = [
      ...((d.images ?? []) as J[]).map((i) => ({ url: String(i.url ?? i.srcUrl ?? ''), kind: 'photo' as const, alt: i.caption ?? null, evidence: 'Rightmove page data · photo' })),
      ...((d.floorplans ?? []) as J[]).map((i) => ({ url: String(i.url ?? ''), kind: 'floorplan' as const, alt: i.caption ?? null, evidence: 'Rightmove page data · floor plan' })),
    ].filter((i) => /^https?:/.test(i.url));
    return {
      title: d.text?.pageTitle ?? null,
      address: d.address?.displayAddress ?? null,
      description: typeof d.text?.description === 'string' ? d.text.description.replace(/<[^>]+>/g, ' ').trim() : null,
      bedrooms: toNum(d.bedrooms),
      bathrooms: toNum(d.bathrooms),
      images: imgs,
    };
  },
};

/** Next.js sites (many portals): look for images in __NEXT_DATA__ with key context. */
const nextData: ListingAdapter = {
  id: 'next-data',
  matches: () => true,
  extract: ({ html }) => {
    const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return {};
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      return {};
    }
    const out: CandidateImage[] = [];
    const walk = (n: unknown, path: string, depth: number) => {
      if (depth > 14 || n == null) return;
      if (typeof n === 'string') {
        if (/^https?:\/\//.test(n) && IMAGE_EXT_RE.test(n)) out.push({ url: n, kind: classify(n, path), alt: null, evidence: `page data (${path.split('.').slice(-2).join('.')})` });
        return;
      }
      if (Array.isArray(n)) return n.forEach((x) => walk(x, path, depth + 1));
      if (typeof n === 'object') for (const [k, v] of Object.entries(n as J)) walk(v, `${path}.${k}`, depth + 1);
    };
    walk(data, 'next', 0);
    return { images: out };
  },
};

export const ADAPTERS: ListingAdapter[] = [rightmove, nextData];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function extractListing(rawUrl: string, fetcher: Fetcher = safeFetch): Promise<ExtractedListing> {
  const url = assertPublicUrl(rawUrl);
  if (!(await robotsPermit(url, fetcher))) {
    throw new ExtractionError('BLOCKED_BY_ROBOTS', `${url.hostname} asks automated tools not to read this page (robots.txt). Upload the photos and floor plan instead, or paste direct image links.`);
  }
  let res;
  try {
    res = await fetcher(url.toString(), { maxBytes: 8 * 1024 * 1024, timeoutMs: 20000, accept: 'text/html,application/xhtml+xml' });
  } catch (e) {
    throw new ExtractionError('FETCH_FAILED', (e as Error).message);
  }
  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status === 451) {
    throw new ExtractionError('ACCESS_DENIED', `${url.hostname} refused the request (HTTP ${res.status}). WalkIn doesn’t get around logins or bot checks — upload the photos and floor plan instead.`);
  }
  if (res.status < 200 || res.status >= 300) throw new ExtractionError('FETCH_FAILED', `${url.hostname} answered HTTP ${res.status}.`);
  if (!/html|xml/.test(res.contentType)) throw new ExtractionError('NOT_HTML', `That link is not a web page (${res.contentType || 'unknown type'}). For an image, use “Add image links”.`);
  const html = res.body.toString('utf8');
  if (/captcha|cf-challenge|are you a robot|access denied/i.test(html.slice(0, 20000)) && html.length < 60000) {
    throw new ExtractionError('ACCESS_DENIED', `${url.hostname} showed a bot check instead of the listing. Upload the photos and floor plan instead.`);
  }
  const finalUrl = new URL(res.url);
  const generic = extractFromHtml(html, finalUrl);
  const used: string[] = [];
  const merged = { ...generic };
  for (const a of ADAPTERS.filter((x) => x.matches(finalUrl))) {
    const r = a.extract({ url: finalUrl, html });
    if (r.images?.length) {
      used.push(a.id);
      const known = new Set(merged.images.map((i) => i.url.replace(/[?#].*$/, '')));
      // Adapter results come first: they are the listing's own gallery, in order.
      merged.images = [...r.images.filter((i) => !known.has(i.url.replace(/[?#].*$/, ''))), ...merged.images];
      for (const i of r.images) {
        const g = merged.images.find((x) => x.url.replace(/[?#].*$/, '') === i.url.replace(/[?#].*$/, ''));
        if (g && i.kind === 'floorplan') g.kind = 'floorplan';
      }
    }
    for (const k of ['title', 'description', 'address', 'bedrooms', 'bathrooms', 'areaSqM', 'price'] as const) if (r[k] != null) (merged as J)[k] = r[k];
    merged.notes.push(...(r.notes ?? []));
  }
  merged.adapter = used.length ? `${used.join('+')}+generic` : 'generic';
  if (!merged.images.length) throw new ExtractionError('NO_IMAGES', 'No listing photos were found on that page. It may load them with scripts WalkIn can’t run. Upload the photos instead.');
  return merged;
}

export { FetchFailedError };
