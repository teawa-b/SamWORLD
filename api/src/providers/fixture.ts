/**
 * The project-owned demo listing in test-fixtures/. Behaves like a provider
 * adapter: search → import → normalised Property + PropertyMedia records.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Property, PropertyMedia } from '@propertyxr/shared';
import { config } from '../config.js';
import { mimeFromName } from '../lib/image.js';
import type { SearchResult } from './types.js';

export const FIXTURE_PROVIDER = 'fixture';

interface FixtureListing {
  sourceProvider: string;
  sourceListingId: string;
  listingUrl: string | null;
  address: string;
  location: Property['location'];
  status: string;
  price: Property['price'];
  bedrooms: number | null;
  areaSqM: number | null;
  areaEvidence: string | null;
  sourceInfo: Property['sourceInfo'];
  missingData: string[];
  media: { id: string; type: 'floorplan'; file: string; mimeType: string; levelGuess: string }[];
}

const fixtures = () =>
  readdirSync(config.fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(config.fixturesDir, d.name, 'listing.json')))
    .map((d) => ({ dir: join(config.fixturesDir, d.name), listing: JSON.parse(readFileSync(join(config.fixturesDir, d.name, 'listing.json'), 'utf8')) as FixtureListing }));

export function fixtureDir(listingId: string): string | null {
  return fixtures().find((f) => f.listing.sourceListingId === listingId)?.dir ?? null;
}

export function searchFixtures(q: string): (Omit<SearchResult, 'importedPropertyId'>)[] {
  const needle = q.trim().toLowerCase();
  return fixtures()
    .filter(({ listing }) => !needle || `${listing.address} ${listing.sourceListingId} demo`.toLowerCase().includes(needle))
    .map(({ dir, listing }) => ({
      provider: FIXTURE_PROVIDER,
      listingId: listing.sourceListingId,
      address: listing.address,
      price: listing.price,
      bedrooms: listing.bedrooms,
      areaSqM: listing.areaSqM,
      hasFloorplan: listing.media.some((m) => m.type === 'floorplan'),
      photoCount: listPhotos(dir).length,
      thumbnailUrl: null,
      attribution: listing.sourceInfo.attribution,
    }));
}

function listPhotos(dir: string): string[] {
  const p = join(dir, 'photos');
  if (!existsSync(p)) return [];
  return readdirSync(p)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort();
}

/** Resolve a storage key to an absolute path, refusing anything outside fixtures/data. */
export function resolveStorageKey(key: string): string | null {
  for (const base of [config.fixturesDir, config.dataDir]) {
    const abs = resolve(base, key);
    if (!relative(base, abs).startsWith('..') && existsSync(abs)) return abs;
  }
  return null;
}

export function importFixture(listingId: string, propertyId: string, now: string): { property: Property; media: PropertyMedia[] } | null {
  const f = fixtures().find((x) => x.listing.sourceListingId === listingId);
  if (!f) return null;
  const { listing, dir } = f;
  const keyOf = (file: string) => relative(config.fixturesDir, join(dir, file));
  const photos = listPhotos(dir);
  const media: PropertyMedia[] = [
    ...listing.media.map((m) => {
      const png = m.file.replace(/\.svg$/, '.png');
      const hasPng = existsSync(join(dir, png));
      return {
        id: `${propertyId}-${m.id}`,
        propertyId,
        type: m.type,
        storageKey: keyOf(m.file),
        mimeType: m.mimeType,
        sourceUrl: null,
        pageOrFrame: null,
        captureDate: null,
        levelGuess: m.levelGuess,
        roomGuess: null,
        usageRightsStatus: 'owned-by-project' as const,
        // A raster copy is what we send to Muse (SVG is not an accepted input type).
        metadata: { fixtureMediaId: m.id, ...(hasPng ? { rasterKey: keyOf(png) } : {}) },
      };
    }),
    ...photos.map((file, i) => {
      const roomHint = file.includes('__') ? file.split('__')[0] : null;
      return {
        id: `${propertyId}-photo-${i}`,
        propertyId,
        type: 'photo' as const,
        storageKey: keyOf(join('photos', file)),
        mimeType: mimeFromName(file) ?? 'application/octet-stream',
        sourceUrl: null,
        pageOrFrame: null,
        captureDate: null,
        levelGuess: null,
        roomGuess: roomHint,
        usageRightsStatus: 'permission-granted' as const,
        metadata: { originalFilename: file },
      };
    }),
  ];
  const missingData = photos.length ? listing.missingData.filter((m) => !m.startsWith('No listing photos')) : listing.missingData;
  const property: Property = {
    id: propertyId,
    sourceProvider: listing.sourceProvider,
    sourceListingId: listing.sourceListingId,
    listingUrl: listing.listingUrl,
    address: listing.address,
    location: listing.location,
    status: listing.status,
    price: listing.price,
    bedrooms: listing.bedrooms,
    areaSqM: listing.areaSqM,
    areaEvidence: listing.areaEvidence,
    sourceInfo: listing.sourceInfo,
    missingData,
    createdAt: now,
    updatedAt: now,
  };
  return { property, media };
}

export function fixtureFile(listingId: string, name: string): unknown | null {
  const dir = fixtureDir(listingId);
  if (!dir || !existsSync(join(dir, name))) return null;
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}
