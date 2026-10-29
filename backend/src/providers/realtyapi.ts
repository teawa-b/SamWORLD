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
    const d = await call<Json>('rightmove', '/search/bycoordinates', { ...coords, searchType: mode === 'rent' ? 'RENT' : 'BUY', resultCount: '40' }, ttl);
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
    const photos = (imgs.originalPhotos ?? [])
      .map((p: Json) => {
        const jpeg: Json[] = p.mixedSources?.jpeg ?? [];
        return jpeg.sort((x, y) => (num(y.width) ?? 0) - (num(x.width) ?? 0))[0]?.url ?? firstUrl(p);
      })
      .filter(Boolean);
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
      floorPlans: [], // not exposed by this endpoint
      status: 'listing',
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
  await Promise.all(d.floorPlans.slice(0, 4).map((u, i) => add(u, 'floorplan', i)));
  // Photos: cap to keep downloads and later AI calls bounded.
  await Promise.all(d.photos.slice(0, 20).map((u, i) => add(u, 'photo', i)));
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
