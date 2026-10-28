/**
 * RealtyAPI adapter (https://www.realtyapi.io/docs).
 *
 * Deliberately NOT implemented against guessed endpoints. Endpoints differ per
 * underlying provider and must be read from
 * https://{provider}.realtyapi.io/openapi.json once a key is available.
 * Until then this adapter reports exactly what is missing.
 */
import { config } from '../config.js';
import { ProviderUnavailableError, type SearchResult } from './types.js';

export function realtyStatus(): { available: boolean; reason: string } {
  if (!config.realty.apiKey) return { available: false, reason: 'REALTYAPI_KEY is not set.' };
  if (!config.realty.provider) return { available: false, reason: 'REALTYAPI_PROVIDER is not set (e.g. the provider subdomain listed in https://www.realtyapi.io/llms.txt).' };
  return {
    available: false,
    reason: `Search/listing endpoints for "${config.realty.provider}" have not been verified against https://${config.realty.provider}.realtyapi.io/openapi.json yet. See docs/realtyapi.md.`,
  };
}

export async function searchRealty(_q: string): Promise<SearchResult[]> {
  const s = realtyStatus();
  if (!s.available) throw new ProviderUnavailableError(s.reason);
  return [];
}
