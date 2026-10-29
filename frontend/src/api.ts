/**
 * Browser API client. Talks to the backend (never to Meta directly — no keys
 * in the browser). If the backend is unreachable it falls back to scenes
 * baked into /cached by the backend's `npm run bake`, read-only.
 */
import type { Property, PropertyMedia, ReconstructionRun, RoomMappingPatch, SceneManifest } from './shared/index.js';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';
const STATIC = `${import.meta.env.BASE_URL}cached/`;

export interface Capabilities {
  liveMeta: boolean;
  museModel: string;
  escalation: string | null;
  samModel: string;
  redesign: boolean;
  realtyApi: boolean;
  sam3d: boolean;
}

export interface SearchResult {
  provider: string;
  listingId: string;
  address: string;
  price: Property['price'];
  bedrooms: number | null;
  areaSqM: number | null;
  hasFloorplan: boolean;
  photoCount: number;
  attribution: string;
  importedPropertyId: string | null;
  thumbnailUrl?: string | null;
}

export interface NearbyListing {
  provider: 'rightmove' | 'zoopla' | 'zillow' | 'realtor';
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
  /** null when the provider's search doesn't say (the plan is checked on import). */
  hasFloorPlan: boolean | null;
  importedPropertyId: string | null;
}

export interface Place {
  lat: number;
  lng: number;
  label: string;
  countryCode: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'HTTP', body?.error?.message ?? res.statusText);
  return body as T;
}

export let staticMode = false;

export const api = {
  async health(): Promise<{ capabilities: Capabilities; realtyApi: { available: boolean; reason: string } } | null> {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error();
      return await res.json();
    } catch {
      staticMode = true;
      return null;
    }
  },
  async search(q: string): Promise<{ results: SearchResult[]; providerNotice: string | null }> {
    if (staticMode) {
      const idx: { propertyId: string; address: string; file: string; thumbnail?: string | null; bedrooms?: number | null; areaSqM?: number | null; price?: Property['price'] }[] = await (await fetch(`${STATIC}index.json`)).json();
      return {
        results: idx
          .filter((i) => i.address.toLowerCase().includes(q.toLowerCase()))
          .map((i) => ({ provider: 'cached', listingId: i.propertyId, address: i.address, price: i.price ?? null, bedrooms: i.bedrooms ?? null, areaSqM: i.areaSqM ?? null, hasFloorplan: true, photoCount: 0, attribution: 'Baked scene', importedPropertyId: i.propertyId, thumbnailUrl: i.thumbnail ? `${import.meta.env.BASE_URL}${i.thumbnail}` : null })),
        providerNotice: 'Static demo: the API is not running, showing pre-baked scenes only.',
      };
    }
    return call(`/api/properties/search?q=${encodeURIComponent(q)}`);
  },
  geocode: (q: string) => call<{ place: Place }>(`/api/geocode?q=${encodeURIComponent(q)}`),
  nearby: (lat: number, lng: number, mode: 'rent' | 'buy') =>
    call<{ place: Place; providers: string[]; listings: NearbyListing[]; notice: string | null }>(`/api/listings/nearby?lat=${lat}&lng=${lng}&mode=${mode}`),
  importListing: (provider: string, listingId: string) => call<{ property: Property; media: PropertyMedia[] }>('/api/properties/import', { method: 'POST', body: JSON.stringify({ provider, listingId }) }),
  property: (id: string) => call<{ property: Property; latestRun: ReconstructionRun | null; hasScene: boolean }>(`/api/properties/${id}`),
  media: (id: string) => call<{ media: PropertyMedia[] }>(`/api/properties/${id}/media`),
  reconstruct: (id: string, opts: { forceReparse?: boolean } = {}) => call<{ jobId: string }>(`/api/properties/${id}/reconstruct`, { method: 'POST', body: JSON.stringify(opts) }),
  job: (id: string) => call<ReconstructionRun>(`/api/reconstruction-jobs/${id}`),
  async scene(id: string): Promise<SceneManifest> {
    if (staticMode) return (await fetch(`${STATIC}${id}.json`)).json();
    return call(`/api/properties/${id}/scene`);
  },
  saveMappings: (id: string, patch: Partial<RoomMappingPatch>) => call(`/api/properties/${id}/room-mappings`, { method: 'PATCH', body: JSON.stringify(patch) }),
  visualise: (id: string, roomId: string, mediaId: string, instruction: string) =>
    call<{ url: string; label: string }>(`/api/properties/${id}/rooms/${roomId}/visualise`, { method: 'POST', body: JSON.stringify({ mediaId, instruction }) }),
};

export function mediaUrl(m: PropertyMedia): string {
  const s = m.metadata?.staticUrl as string | undefined;
  if (staticMode && s) return `${import.meta.env.BASE_URL}${s}`;
  return `${BASE}/api/media/${m.id}`;
}

export const absoluteApiUrl = (path: string) => `${BASE}${path}`;
