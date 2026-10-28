/**
 * OpenStreetMap Nominatim geocoding (free; max 1 request/second; needs a
 * descriptive User-Agent). Results are cached so map browsing stays polite.
 */
const UA = 'WalkIn/0.1 (property reconstruction demo; https://github.com/teawa-b/ViewIn)';
let last = 0;
const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 24 * 3600e3;

async function nominatim<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const res = await fetch(`https://nominatim.openstreetmap.org${path}`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Geocoder error ${res.status}`);
  const value = (await res.json()) as T;
  cache.set(path, { at: Date.now(), value });
  return value;
}

export interface Place {
  lat: number;
  lng: number;
  label: string;
  countryCode: string; // ISO-3166 alpha-2, lower case
}

interface NomHit {
  lat: string;
  lon: string;
  display_name?: string;
  address?: Record<string, string>;
}

const labelOf = (a: Record<string, string> = {}, fallback = '') =>
  [a.neighbourhood || a.suburb || a.quarter || a.city_district, a.city || a.town || a.village || a.county].filter(Boolean).join(', ') || fallback;

export async function geocode(q: string): Promise<Place | null> {
  const [hit] = await nominatim<NomHit[]>(`/search?format=jsonv2&addressdetails=1&limit=1&q=${encodeURIComponent(q)}`);
  if (!hit) return null;
  return { lat: Number(hit.lat), lng: Number(hit.lon), label: labelOf(hit.address, hit.display_name), countryCode: hit.address?.country_code ?? '' };
}

export async function reverseGeocode(lat: number, lng: number): Promise<Place> {
  // Round to ~100 m so nearby clicks share a cache entry.
  const hit = await nominatim<NomHit>(`/reverse?format=jsonv2&zoom=14&lat=${lat.toFixed(3)}&lon=${lng.toFixed(3)}`);
  return { lat, lng, label: labelOf(hit.address, hit.display_name ?? ''), countryCode: hit.address?.country_code ?? '' };
}
