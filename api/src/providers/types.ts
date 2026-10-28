export interface SearchResult {
  provider: string;
  listingId: string;
  address: string;
  price: { amount: number; currency: string; period: 'pcm' | 'pw' | 'sale' } | null;
  bedrooms: number | null;
  areaSqM: number | null;
  hasFloorplan: boolean;
  photoCount: number;
  thumbnailUrl: string | null;
  attribution: string;
  importedPropertyId: string | null;
}

export class ProviderUnavailableError extends Error {
  code = 'PROVIDER_UNAVAILABLE';
}
