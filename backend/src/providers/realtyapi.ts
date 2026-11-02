/**
 * RealtyAPI adapter (https://www.realtyapi.io): Rightmove for the UK (searched,
 * because its results say whether a floor plan exists) and Zoopla (import only),
 * Zillow and Realtor.com for the US. Endpoints and parameters come from each provider's
 * published OpenAPI spec; field names from sampled responses (see
 * docs/realtyapi.md). Parsing is defensive because responses vary by listing.
 *
 * Every call spends from the account allowance, so searches and details are
 * cached in memory and searches are capped per call.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Property, PropertyMedia } from '../shared/index.js';
import { config } from '../config.js';
import { mimeFromName } from '../lib/image.js';
import { drawingScore } from '../lib/drawing.js';
import { ProviderUnavailableError } from './types.js';

export type RealtyProvider = 'rightmove' | 'zoopla' | 'zillow' | 'realtor';
export const REALTY_PROVIDERS: RealtyProvider[] = ['rightmove', 'zoopla', 'zillow', 'realtor'];
export type ListingMode = 'rent' | 'buy';

const PROVIDER_LABEL: Record<RealtyProvider, string> = { rightmove: 'Rightmove', zoopla: 'Zoopla', zillow: 'Zillow', realtor: 'Realtor.com' };

/** Which providers are searched for a country (ISO alpha-2, lower case). Zoopla listings stay importable. */
export function providersFor(countryCode: string): RealtyProvider[] {
  if (countryCode === 'gb') return ['rightmove'];
  if (countryCode === 'us') return ['realtor']; // Zillow exposes no floor plans; its listings stay importable
  return [];
}

export interface NearbyListing {
  provider: RealtyProvider;
  providerLabel: string;
  listingId: string;
  address: string;
  lat: number;
  lng: number;
  priceText: string;
  bedrooms: number | null;
  bathrooms: number | null;
  photoUrl: string | null;
  url: string | null;
  /** Whether the listing has a floor plan; null when the provider's search doesn't say. */
  hasFloorPlan: boolean | null;
}

// Image hosts we will download listing media from (SSRF guard).
const MEDIA_HOSTS = [/^media\.rightmove\.co\.uk$/, /\.zoocdn\.com$/, /^photos\.zillowstatic\.com$/, /\.rdcpix\.com$/];

export function realtyStatus(): { available: boolean; reason: string } {
  if (!config.realty.apiKey) return { available: false, reason: 'REALTYAPI_KEY is not set.' };
  return { available: true, reason: 'Rightmove (UK), Zillow and Realtor.com (US)' };
}

const cache = new Map<string, { at: number; value: unknown }>();
async function call<T>(provider: RealtyProvider, path: string, params: Record<string, string>, ttlMs: number): Promise<T> {
  if (!config.realty.apiKey) throw new ProviderUnavailableError('REALTYAPI_KEY is not set.');
  const url = new URL(path, `https://${provider}.realtyapi.io`);
  url.search = new URLSearchParams(params).toString();
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const res = await fetch(url, { headers: { 'x-realtyapi-key': config.realty.apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
  const text = await res.text();
  if (!res.ok) throw new ProviderUnavailableError(`${PROVIDER_LABEL[provider]} lookup failed (HTTP ${res.status}).`);
  let value: T;
  try {
    value = JSON.parse(text) as T;
  } catch {
    throw new ProviderUnavailableError(`${PROVIDER_LABEL[provider]} returned an unreadable response.`);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------------------
// Small helpers for loosely typed payloads
// ---------------------------------------------------------------------------
type Json = Record<string, any>;
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  if (v && typeof v === 'object' && 'value' in (v as Json)) return num((v as Json).value);
  return null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** First http(s) URL found in a value (string, array or nested object). */
function firstUrl(v: unknown, depth = 0): string | null {
  if (depth > 4 || v == null) return null;
  if (typeof v === 'string') return /^https?:\/\//.test(v) ? v : null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const u = firstUrl(x, depth + 1);
      if (u) return u;
    }
    return null;
  }
  if (typeof v === 'object') {
    const o = v as Json;
    for (const k of ['url', 'href', 'highResolutionLink', 'hiResImageLink', 'original', 'large', 'src']) {
      const u = firstUrl(o[k], depth + 1);
      if (u) return u;
    }
    for (const x of Object.values(o)) {
      const u = firstUrl(x, depth + 1);
      if (u) return u;
    }
  }
  return null;
}
const urls = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => firstUrl(x)).filter((u): u is string => !!u) : []);
const money = (amount: number | null, currency: string, suffix = '') =>
  amount == null ? 'Price on request' : `${currency === 'GBP' ? '£' : currency === 'USD' ? '$' : `${currency} `}${Math.round(amount).toLocaleString('en-GB')}${suffix}`;

// ---------------------------------------------------------------------------
// Search near a point
// ---------------------------------------------------------------------------
export async function searchNearby(provider: RealtyProvider, lat: number, lng: number, mode: ListingMode, radiusMiles = 1): Promise<NearbyListing[]> {
  const coords = { latitude: lat.toFixed(5), longitude: lng.toFixed(5), radius: String(radiusMiles) };
  const ttl = 6 * 3600e3;
  if (provider === 'rightmove') {
    const d = await call<Json>('rightmove', '/search/bycoordinates', { ...coords, searchType: mode === 'rent' ? 'RENT' : 'BUY', resultCount: '40', sortOrder: 'newest' }, ttl); // default is most expensive first
    const seen = new Set<string>();
    return [...(d.searchResults ?? []), ...(d.featured ?? [])]
      .filter((r: Json) => r.id && r.latitude != null && !seen.has(String(r.id)) && seen.add(String(r.id)))
      .map((r: Json) => ({
        provider,
        providerLabel: PROVIDER_LABEL[provider],
        listingId: String(r.id),
        address: str(r.address) ?? 'Rightmove listing',
        lat: Number(r.latitude),
        lng: Number(r.longitude),
        priceText: str(r.displayPrice) ?? money(num(r.price), 'GBP'),
        bedrooms: num(r.bedrooms),
        bathrooms: null,
        photoUrl: urls(r.photos)[0] ?? null,
        url: str(r.url),
        hasFloorPlan: r.floorplanCount == null ? null : num(r.floorplanCount)! > 0,
      }));
  }
  if (provider === 'zoopla') {
    const d = await call<Json>('zoopla', '/search/bycoordinates', { ...coords, searchType: mode === 'rent' ? 'To_Rent' : 'For_Sale' }, ttl);
    return (d.searchResults ?? [])
      .filter((r: Json) => r.listingId && r.latitude != null)
      .slice(0, 25)
      .map((r: Json) => ({
        provider,
        providerLabel: PROVIDER_LABEL[provider],
        listingId: String(r.listingId),
        address: str(r.address) ?? str(r.title) ?? 'Zoopla listing',
        lat: Number(r.latitude),
        lng: Number(r.longitude),
        priceText: str(r.price) ?? str(r.shortPrice) ?? 'Price on request',
        bedrooms: num(r.features?.beds),
        bathrooms: num(r.features?.baths),
        photoUrl: urls(r.photos)[0] ?? null,
        url: null,
        hasFloorPlan: null,
      }));
  }
  if (provider === 'zillow') {
    const d = await call<Json>('zillow', '/search/bycoordinates', { ...coords, listingStatus: mode === 'rent' ? 'For_Rent' : 'For_Sale' }, ttl);
    return (d.searchResults ?? [])
      .map((r: Json) => r.property ?? r)
      .filter((p: Json) => p.zpid && p.location?.latitude != null)
      .slice(0, 25)
      .map((p: Json) => {
        const a = p.address ?? {};
        const lo = num(p.price?.value ?? p.price ?? p.minPrice);
        const hi = num(p.maxPrice);
        const per = mode === 'rent' ? '/mo' : '';
        return {
          provider,
          providerLabel: PROVIDER_LABEL[provider],
          listingId: String(p.zpid),
          address: [a.streetAddress, a.city, a.state].filter(Boolean).join(', ') || str(p.title) || 'Zillow listing',
          lat: Number(p.location.latitude),
          lng: Number(p.location.longitude),
          priceText: hi && lo && hi > lo ? `${money(lo, 'USD')}–${money(hi, 'USD', per).slice(1)}` : money(lo, 'USD', per),
          bedrooms: num(p.bedrooms),
          bathrooms: num(p.bathrooms),
          photoUrl: firstUrl(p.media?.propertyPhotoLinks) ?? firstUrl(p.media?.allPropertyPhotos),
          url: null,
          hasFloorPlan: false, // Zillow's endpoints expose no floor plans
        };
      });
  }
  const d = await call<Json>('realtor', '/search/bycoordinates', { ...coords, searchType: mode === 'rent' ? 'For_Rent' : 'For_Sale', resultCount: '25', hasPhotos: 'true' }, ttl);
  return (d.searchResults ?? [])
    .filter((r: Json) => r.property_id && r.address?.latitude != null)
    .slice(0, 25)
    .map((r: Json) => {
      const a = r.address ?? {};
      const price = num(r.list_price) ?? num(r.list_price_min);
      return {
        provider: 'realtor' as const,
        providerLabel: PROVIDER_LABEL.realtor,
        listingId: r.listing_id ? `${r.property_id}:${r.listing_id}` : String(r.property_id),
        address: [a.line, a.city, a.state_code].filter(Boolean).join(', ') || 'Realtor.com listing',
        lat: Number(a.latitude),
        lng: Number(a.longitude),
        priceText: money(price, 'USD', mode === 'rent' ? '/mo' : ''),
        bedrooms: num(r.beds) ?? num(r.beds_min),
        bathrooms: num(r.baths) ?? num(r.baths_min),
        photoUrl: str(r.primary_photo) ?? urls(r.photos)[0] ?? null,
        url: str(r.href),
        hasFloorPlan: null,
      };
    });
}

// ---------------------------------------------------------------------------
// Import one listing (details + media downloaded to our storage)
// ---------------------------------------------------------------------------
interface Details {
  address: string;
  lat: number | null;
  lng: number | null;
  price: Property['price'];
  bedrooms: number | null;
  areaSqM: number | null;
  url: string | null;
  description: string;
  photos: string[];
  floorPlans: string[];
  status: string;
  /** Every gallery image (small thumbnail + full size), for finding plans hidden among the photos. */
  gallery?: { thumb: string; full: string }[];
}

async function details(provider: RealtyProvider, listingId: string): Promise<Details> {
  const ttl = 24 * 3600e3;
  if (provider === 'rightmove') {
    const { detail: d = {} } = await call<Json>('rightmove', '/details/byid', { propertyId: listingId }, ttl);
    const priceText = String(d.price?.primary ?? '').toLowerCase();
    const rent = d.transactionType === 'RENT' || /pcm|pw/.test(priceText);
    const sqm = /sq\.?\s*m/i.test(String(d.size?.secondary ?? '')) ? num(d.size.secondary) : null;
    const sqft = /sq\.?\s*ft/i.test(String(d.size?.primary ?? '')) ? num(d.size.primary) : null;
    const address = str(d.address) ?? 'Rightmove listing';
    const postcode = str(d.postcode);
    const outcode = postcode?.split(' ')[0];
    return {
      // "Clarges Street, London, W1J" + "W1J 8AS" → "Clarges Street, London, W1J 8AS"
      address: !postcode || address.includes(postcode) ? address : outcode && address.endsWith(outcode) ? `${address.slice(0, -outcode.length)}${postcode}` : `${address}, ${postcode}`,
      lat: num(d.location?.latitude),
      lng: num(d.location?.longitude),
      price: num(d.price?.numericValue) != null ? { amount: num(d.price.numericValue)!, currency: 'GBP', period: !rent ? 'sale' : priceText.includes('pw') && !priceText.includes('pcm') ? 'pw' : 'pcm' } : null,
      bedrooms: num(d.bedrooms),
      areaSqM: sqm ?? (sqft ? Math.round(sqft * 0.0929) : null),
      url: str(d.propertyUrl) ?? `https://www.rightmove.co.uk/properties/${listingId}`,
      description: String(d.fullDescription ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim(),
      photos: (Array.isArray(d.photos) ? d.photos : []).map((p: Json) => str(p.maxSizeUrl) ?? firstUrl(p)).filter((u: string | null): u is string => !!u),
      floorPlans: urls(d.floorplans),
      status: d.status?.available === false ? str(d.status?.label) ?? 'unavailable' : rent ? 'to-rent' : 'for-sale',
    };
  }
  if (provider === 'zoopla') {
    const [{ detail: d = {} }, imgs] = await Promise.all([
      call<Json>('zoopla', '/details/byid', { listingId }, ttl),
      call<Json>('zoopla', '/images', { listingId }, ttl).catch((): Json => ({ detail: {} })),
    ]);
    const freq = String(d.rentFrequency ?? '').toLowerCase();
    const sqft = num(d.sizeSqft) ?? (d.floorArea?.units === 'sq_feet' ? num(d.floorArea?.value) : null);
    const sqm = d.floorArea?.units === 'sq_metres' ? num(d.floorArea?.value) : null;
    return {
      address: str(d.displayAddress) ?? str(d.title) ?? 'Zoopla listing',
      lat: num(d.latitude ?? d.location?.latitude),
      lng: num(d.longitude ?? d.location?.longitude),
      price: num(d.priceValue) != null ? { amount: num(d.priceValue)!, currency: str(d.currency) ?? 'GBP', period: freq.includes('w') ? 'pw' : freq ? 'pcm' : 'sale' } : null,
      bedrooms: num(d.beds),
      areaSqM: sqm ?? (sqft ? Math.round(sqft * 0.0929) : null),
      url: d.url ? (String(d.url).startsWith('http') ? d.url : `https://www.zoopla.co.uk${d.url}`) : null,
      description: str(d.description) ?? '',
      photos: [...new Set([...urls(d.photos), ...urls(imgs.detail?.photos)])],
      floorPlans: [...new Set([...urls(d.floorPlans), ...urls(imgs.detail?.floorPlans)])],
      status: str(d.section) ?? 'listing',
    };
  }
  if (provider === 'zillow') {
    const [d, imgs] = await Promise.all([
      call<Json>('zillow', '/byzpid', { zpid: listingId }, ttl),
      call<Json>('zillow', '/propimages', { byzpid: listingId }, ttl).catch((): Json => ({})),
    ]);
    const a = d.PropertyAddress ?? {};
    const best = (p: Json) => {
      const jpeg: Json[] = p.mixedSources?.jpeg ?? [];
      return jpeg.sort((x, y) => (num(y.width) ?? 0) - (num(x.width) ?? 0))[0]?.url ?? firstUrl(p);
    };
    // Some listings caption the plan among the photos; others keep it in a separate floor-plan field.
    const isPlanPhoto = (p: Json) => /floor.?plan|floorplan/i.test(`${p.caption ?? ''} ${p.subjectType ?? ''} ${p.title ?? ''}`);
    const all: Json[] = imgs.originalPhotos ?? [];
    // Smallest jpeg at least ~300 px wide: enough to tell a drawing from a photo.
    const thumb = (p: Json) => {
      const jpeg: Json[] = [...(p.mixedSources?.jpeg ?? [])].sort((x, y) => (num(x.width) ?? 0) - (num(y.width) ?? 0));
      return (jpeg.find((j) => (num(j.width) ?? 0) >= 300) ?? jpeg[jpeg.length - 1])?.url ?? best(p);
    };
    const photos = all.filter((p) => !isPlanPhoto(p)).map(best).filter(Boolean);
    let planFields = [...findFloorPlanUrls(d, 'byzpid'), ...findFloorPlanUrls(imgs, 'propimages')];
    if (!planFields.length && !all.some(isPlanPhoto)) {
      // The basic record has no plan field; RealtyAPI's richer endpoint returns Zillow's fuller data.
      const pro = await call<Json>('zillow', '/pro/byzpid', { zpid: listingId }, ttl).catch((e: Error) => ({ __error: e.message }) as Json);
      planFields = findFloorPlanUrls(pro, 'pro');
      const captioned = findCaptionedPlans(pro);
      planFields.push(...captioned.map((url) => ({ url, path: 'pro.photos(caption)' })));
      console.log(`[realty] zillow ${listingId} /pro/byzpid: ${pro.__error ? `failed (${pro.__error})` : `keys ${Object.keys(pro).slice(0, 40).join(',')}`}; floor-plan images there: ${planFields.length}`);
    }
    const floorPlans = [...new Set([...all.filter(isPlanPhoto).map(best).filter(Boolean), ...planFields.map((h) => h.url)])];
    console.log(
      `[realty] zillow ${listingId}: ${photos.length} photos, ${floorPlans.length} floor plan(s)` +
        `; fields mentioning floor plans: ${[...new Set(planFields.map((h) => h.path))].join(', ') || 'none'}` +
        `; top-level keys: ${Object.keys(d).slice(0, 60).join(',')}`,
    );
    const sqft = num(d['Area(sqft)']);
    return {
      address: [a.streetAddress, a.city, a.state, a.zipcode].filter(Boolean).join(', ') || 'Zillow listing',
      lat: num(d.latitude),
      lng: num(d.longitude),
      price: num(d.Price) != null ? { amount: num(d.Price)!, currency: 'USD', period: num(d.Price)! < 30000 ? 'pcm' : 'sale' } : null,
      bedrooms: num(d.Bedrooms),
      areaSqM: sqft ? Math.round(sqft * 0.0929) : null,
      url: str(d.PropertyZillowURL),
      description: '',
      photos: photos.length ? photos : urls([imgs.hiResImageLink]),
      floorPlans,
      status: 'listing',
      gallery: all.filter((p) => !isPlanPhoto(p)).map((p) => ({ thumb: thumb(p), full: best(p) })).filter((g) => g.thumb && g.full),
    };
  }
  const [propertyId, lid] = listingId.split(':');
  const { detail: d = {} } = await call<Json>('realtor', '/details/byid', { property_id: propertyId, ...(lid ? { listing_id: lid } : {}) }, ttl);
  const photoObjs: Json[] = Array.isArray(d.photos) ? d.photos : [];
  const isPlan = (p: Json) => (p.tags ?? []).some((t: unknown) => /floor.?plan/i.test(String(typeof t === 'object' ? (t as Json).label : t)));
  const sqft = num(d.details?.sqft) ?? num(d.details?.sqft_min);
  const price = num(d.list_price) ?? num(d.list_price_min);
  return {
    address: [d.address?.line, d.address?.city, d.address?.state_code, d.address?.postal_code].filter(Boolean).join(', ') || 'Realtor.com listing',
    lat: num(d.address?.latitude),
    lng: num(d.address?.longitude),
    price: price != null ? { amount: price, currency: 'USD', period: String(d.status ?? '').includes('rent') ? 'pcm' : 'sale' } : null,
    bedrooms: num(d.details?.beds) ?? num(d.details?.beds_min),
    areaSqM: sqft ? Math.round(sqft * 0.0929) : null,
    url: str(d.href),
    description: str(d.details?.text) ?? '',
    photos: photoObjs.filter((p) => !isPlan(p)).map((p) => firstUrl(p)).filter((u): u is string => !!u),
    floorPlans: [...photoObjs.filter(isPlan).map((p) => firstUrl(p)), ...urls(d.floorplans)].filter((u): u is string => !!u),
    status: str(d.status) ?? 'listing',
  };
}

/** Image URLs anywhere under a key that names a floor plan (Zillow's field names vary by listing). */
export function findFloorPlanUrls(node: unknown, path = '', depth = 0, under = false): { url: string; path: string }[] {
  if (depth > 10 || node == null) return [];
  if (typeof node === 'string') return under && /^https?:\/\/.+\.(jpe?g|png|webp)(\?|$)/i.test(node) ? [{ url: node, path }] : [];
  if (Array.isArray(node)) return node.flatMap((n) => findFloorPlanUrls(n, path, depth + 1, under));
  if (typeof node !== 'object') return [];
  const o = node as Json;
  // An object with responsive sources: take only its widest jpeg.
  if (under && Array.isArray(o.mixedSources?.jpeg)) {
    const u = [...o.mixedSources.jpeg].sort((x: Json, y: Json) => (num(y.width) ?? 0) - (num(x.width) ?? 0))[0]?.url;
    if (u) return [{ url: u, path }];
  }
  return Object.entries(o).flatMap(([k, v]) => findFloorPlanUrls(v, path ? `${path}.${k}` : k, depth + 1, under || /floor.?plan/i.test(k)));
}

/** Photos captioned as floor plans anywhere in a payload (e.g. photos[].caption). */
function findCaptionedPlans(node: unknown, depth = 0): string[] {
  if (depth > 8 || node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((n) => findCaptionedPlans(n, depth + 1));
  const o = node as Json;
  const text = `${o.caption ?? ''} ${o.title ?? ''} ${o.subjectType ?? ''} ${o.label ?? ''}`;
  if (/floor.?plan/i.test(text)) {
    const jpeg: Json[] = o.mixedSources?.jpeg ?? [];
    const u = [...jpeg].sort((x, y) => (num(y.width) ?? 0) - (num(x.width) ?? 0))[0]?.url ?? firstUrl(o);
    if (u) return [u];
  }
  return Object.values(o).flatMap((v) => findCaptionedPlans(v, depth + 1));
}

/** Gallery images that look like floor-plan drawings (pixel analysis of small thumbnails, 6 at a time). */
async function findDrawings(gallery: { thumb: string; full: string }[]): Promise<{ thumb: string; full: string }[]> {
  const hits: { g: { thumb: string; full: string }; i: number }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < gallery.length && next < 120) {
      const i = next++;
      const g = gallery[i];
      try {
        const u = new URL(g.thumb);
        if (u.protocol !== 'https:' || !MEDIA_HOSTS.some((re) => re.test(u.hostname))) continue;
        const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const s = drawingScore(Buffer.from(await res.arrayBuffer()));
        if (s?.plan) hits.push({ g, i });
      } catch {
        /* skip this one */
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return hits.sort((a, b) => a.i - b.i).slice(0, 4).map((h) => h.g);
}

async function download(url: string, propertyId: string, name: string): Promise<{ key: string; mime: string } | null> {
  const dir = join(config.dataDir, 'media', propertyId);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !MEDIA_HOSTS.some((re) => re.test(u.hostname))) return null;
  const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim() || mimeFromName(u.pathname) || '';
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) return null;
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  await mkdir(dir, { recursive: true });
  const file = `${name}.${ext}`;
  await writeFile(join(dir, file), buf);
  return { key: `media/${propertyId}/${file}`, mime }; // forward slashes on every OS, like other storage keys
}

export async function importRealty(provider: RealtyProvider, listingId: string, propertyId: string, now: string): Promise<{ property: Property; media: PropertyMedia[] }> {
  const d = await details(provider, listingId);
  const media: PropertyMedia[] = [];
  const rights = 'licensed' as const; // supplied through the owner's RealtyAPI account; see docs/data-and-rights.md
  const add = async (url: string, type: 'photo' | 'floorplan', i: number) => {
    const name = `${type}-${i}-${createHash('sha1').update(url).digest('hex').slice(0, 8)}`;
    const saved = await download(url, propertyId, name).catch(() => null);
    if (!saved) return;
    media.push({
      id: `${propertyId}-${type}-${i}`,
      propertyId,
      type,
      storageKey: saved.key,
      mimeType: saved.mime,
      sourceUrl: url,
      pageOrFrame: null,
      captureDate: null,
      levelGuess: type === 'floorplan' ? `L${i}` : null,
      roomGuess: null,
      usageRightsStatus: rights,
      metadata: { provider },
    });
  };
  let floorPlans = d.floorPlans;
  let photos = d.photos;
  if (!floorPlans.length && d.gallery?.length) {
    // No labelled plan: look at every gallery image (thumbnails) for drawings. Plans are often near the end.
    const found = await findDrawings(d.gallery);
    console.log(`[realty] ${provider} ${listingId}: scanned ${d.gallery.length} gallery images for floor-plan drawings; found ${found.length}`);
    if (found.length) {
      floorPlans = found.map((g) => g.full);
      photos = photos.filter((u) => !floorPlans.includes(u));
    }
  }
  await Promise.all(floorPlans.slice(0, 4).map((u, i) => add(u, 'floorplan', i)));
  // Photos: cap to keep downloads and later AI calls bounded.
  await Promise.all(photos.slice(0, 24).map((u, i) => add(u, 'photo', i)));
  media.sort((a, b) => (a.type === b.type ? a.id.localeCompare(b.id, undefined, { numeric: true }) : a.type === 'floorplan' ? -1 : 1));

  const missing: string[] = [];
  if (!media.some((m) => m.type === 'floorplan')) missing.push(`No floor plan in this ${PROVIDER_LABEL[provider]} listing, so the layout will be estimated from the photos and listing details.`);
  if (!media.some((m) => m.type === 'photo')) missing.push('No photos available.');
  missing.push('Ceiling heights not stated.');
  const property: Property = {
    id: propertyId,
    sourceProvider: provider,
    sourceListingId: listingId,
    listingUrl: d.url,
    address: d.address,
    location: d.lat != null && d.lng != null ? { lat: d.lat, lng: d.lng } : null,
    status: d.status,
    price: d.price,
    bedrooms: d.bedrooms,
    areaSqM: d.areaSqM,
    areaEvidence: d.areaSqM ? `From the ${PROVIDER_LABEL[provider]} listing` : null,
    sourceInfo: {
      attribution: `Listing data and media from ${PROVIDER_LABEL[provider]} via RealtyAPI`,
      rightsNote: 'Shown for evaluation through the owner’s RealtyAPI account. Check provider terms before public redistribution.',
    },
    missingData: missing,
    createdAt: now,
    updatedAt: now,
  };
  return { property, media };
}

export const isRealtyProvider = (p: string): p is RealtyProvider => (REALTY_PROVIDERS as string[]).includes(p);

// ---------------------------------------------------------------------------
// Floor plans from the same home's listing on another portal
// ---------------------------------------------------------------------------

/** "201 NW 61st Ave, Miami, FL 33126" → { num: "201", street: "nw 61st" } (suffixes like Ave/Street ignored). */
export function addressKey(a: string): { num: string; street: string } | null {
  const first = a.toLowerCase().split(',')[0].replace(/[.#]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = first.match(/^(\d+[a-z]?)\s+(.+)$/);
  if (!m) return null;
  const SUFFIX = /\b(avenue|ave|street|st|road|rd|drive|dr|court|ct|lane|ln|place|pl|boulevard|blvd|terrace|ter|way|circle|cir|parkway|pkwy|highway|hwy)\b/g;
  const street = m[2].replace(/\b(apt|unit|ste|suite)\b.*$/, '').replace(SUFFIX, '').replace(/\s+/g, ' ').trim();
  return { num: m[1], street };
}

/**
 * Look for the same home on Realtor.com (MLS listings there usually tag the floor plan) and return its
 * floor-plan image URLs. Matching is by house number + street name near the given coordinates.
 */
export async function floorPlansElsewhere(address: string, lat: number, lng: number): Promise<{ urls: string[]; foundOn: string | null; listingId: string | null; tried: string[] }> {
  const want = addressKey(address);
  const tried: string[] = [];
  if (!want || !config.realty.apiKey) return { urls: [], foundOn: null, listingId: null, tried };
  for (const mode of ['buy', 'rent'] as ListingMode[]) {
    tried.push(`Realtor.com (${mode === 'buy' ? 'for sale' : 'for rent'})`);
    const hits = await searchNearby('realtor', lat, lng, mode, 0.25).catch(() => []);
    const same = hits.find((h) => {
      const k = addressKey(h.address);
      return k && k.num === want.num && (k.street === want.street || k.street.includes(want.street) || want.street.includes(k.street));
    });
    if (!same) continue;
    const d = await details('realtor', same.listingId).catch(() => null);
    let plans = d?.floorPlans ?? [];
    // Not tagged? Agents often upload the plan as an ordinary photo: check every photo for a drawing.
    if (!plans.length && d?.photos.length) plans = (await findDrawings(d.photos.map((u) => ({ thumb: u, full: u })))).map((g) => g.full);
    console.log(`[realty] floor-plan lookup: ${address} matched Realtor.com ${same.listingId} (${same.address}); ${d?.floorPlans.length ?? 0} tagged floor plan(s), ${plans.length} in total after scanning ${d?.photos.length ?? 0} photos`);
    if (plans.length) return { urls: plans.slice(0, 4), foundOn: 'Realtor.com', listingId: same.listingId, tried };
  }
  console.log(`[realty] floor-plan lookup: no floor plan found elsewhere for ${address} (tried ${tried.join(', ')})`);
  return { urls: [], foundOn: null, listingId: null, tried };
}

/** Download floor plans found elsewhere and attach them to a property. */
export async function attachFloorPlans(propertyId: string, urls: string[], foundOn: string, offset = 0): Promise<PropertyMedia[]> {
  const out: PropertyMedia[] = [];
  for (const [i, url] of urls.entries()) {
    const name = `floorplan-x${offset + i}-${createHash('sha1').update(url).digest('hex').slice(0, 8)}`;
    const saved = await download(url, propertyId, name).catch(() => null);
    if (!saved) continue;
    out.push({
      id: `${propertyId}-floorplan-x${offset + i}`,
      propertyId,
      type: 'floorplan',
      storageKey: saved.key,
      mimeType: saved.mime,
      sourceUrl: url,
      pageOrFrame: null,
      captureDate: null,
      levelGuess: `L${offset + i}`,
      roomGuess: null,
      usageRightsStatus: 'licensed',
      metadata: { provider: 'realtor', foundOn, order: -10 + i, importEvidence: `Floor plan from the same home's ${foundOn} listing` },
    });
  }
  return out;
}
