/** Adapter mapping tests with payloads shaped like sampled RealtyAPI responses (network mocked). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'walkin-realty-'));
process.env.REALTYAPI_KEY = 'test-key';
const { importRealty, providersFor, searchNearby } = await import('../src/providers/realtyapi.js');

const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
function mockFetch(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const u = new URL(String(input));
    if (/zoocdn|zillowstatic|rdcpix/.test(u.hostname)) return new Response(png, { headers: { 'content-type': 'image/png' } });
    const body = routes[`${u.hostname.split('.')[0]}${u.pathname}`];
    return body ? new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) : new Response('nope', { status: 404 });
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe('RealtyAPI adapter', () => {
  it('routes countries to providers', () => {
    expect(providersFor('gb')).toEqual(['zoopla']);
    expect(providersFor('us')).toEqual(['zillow', 'realtor']);
    expect(providersFor('fr')).toEqual([]);
  });

  it('maps Zoopla search results', async () => {
    mockFetch({ 'zoopla/search/bycoordinates': { searchResults: [{ listingId: '7001', address: 'Flat 2, Example St', price: '£1,950 pcm', features: { beds: 2, baths: 1 }, photos: ['https://lid.zoocdn.com/a.jpg'], latitude: 51.5, longitude: -0.12 }] } });
    const [l] = await searchNearby('zoopla', 51.5, -0.12, 'rent');
    expect(l).toMatchObject({ listingId: '7001', priceText: '£1,950 pcm', bedrooms: 2, photoUrl: 'https://lid.zoocdn.com/a.jpg', lat: 51.5 });
  });

  it('imports a Zoopla listing with floor plans and photos downloaded locally', async () => {
    mockFetch({
      'zoopla/details/byid': { detail: { listingId: 9, displayAddress: '1 Test Road', priceValue: 2100, rentFrequency: 'pcm', currency: 'GBP', beds: 2, sizeSqft: 700, photos: ['https://lc.zoocdn.com/p1.jpg'], floorPlans: ['https://lc.zoocdn.com/fp.png'], latitude: 51.5, longitude: -0.1, section: 'to-rent' } },
      'zoopla/images': { detail: { photos: ['https://lc.zoocdn.com/p2.jpg', 'https://evil.example/x.jpg'], floorPlans: [] } },
    });
    const { property, media } = await importRealty('zoopla', '9', 'prop-zoopla-9', 'now');
    expect(property.price).toEqual({ amount: 2100, currency: 'GBP', period: 'pcm' });
    expect(property.areaSqM).toBe(65);
    expect(media.filter((m) => m.type === 'floorplan')).toHaveLength(1);
    expect(media.filter((m) => m.type === 'photo')).toHaveLength(2); // non-allowlisted host skipped
    expect(media[0].storageKey).toMatch(/^media\/prop-zoopla-9\/floorplan-0-/);
  });

  it('treats Realtor.com photos tagged as floor plans as plans', async () => {
    mockFetch({ 'realtor/details/byid': { detail: { property_id: '1', status: 'for_rent', list_price: 3000, details: { beds: 1, sqft: 600 }, address: { line: '5 Main St', city: 'NYC', state_code: 'NY', latitude: 40.7, longitude: -74 }, photos: [{ href: 'https://ar.rdcpix.com/a.jpg', tags: ['kitchen'] }, { href: 'https://ar.rdcpix.com/fp.jpg', tags: [{ label: 'floor_plan' }] }] } } });
    const { media, property } = await importRealty('realtor', '1:2', 'prop-realtor-1', 'now');
    expect(media.map((m) => m.type).sort()).toEqual(['floorplan', 'photo']);
    expect(property.price?.period).toBe('pcm');
  });
});
