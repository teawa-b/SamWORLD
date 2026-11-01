/**
 * One import pipeline for every source: listing URL, direct image URLs,
 * uploads and (later) a browser extension posting what it collected. Each
 * source ends up as a Property plus PropertyMedia records whose files have
 * been type-checked, size-checked and decoded far enough to prove they are
 * real images. The review screen then edits those records.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Property, PropertyMedia } from '../shared/index.js';
import { config } from '../config.js';
import { imageSize } from '../lib/image.js';
import { safeFetch, type Fetcher } from '../lib/safe-fetch.js';
import { store } from '../store.js';
import { extractListing, type CandidateImage, type ExtractedListing } from './listing-url.js';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_MEDIA_PER_PROPERTY = 60;
export const UPLOAD_PROVIDER = 'upload';

export class IngestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Real type from the file's first bytes; the declared content type is not trusted. */
export function sniffImage(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function validateImage(buf: Buffer): { mime: 'image/jpeg' | 'image/png' | 'image/webp'; width: number; height: number } {
  if (buf.length > MAX_IMAGE_BYTES) throw new IngestError('IMAGE_TOO_LARGE', `Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  const mime = sniffImage(buf);
  if (!mime) throw new IngestError('UNSUPPORTED_IMAGE', 'Only JPG, PNG and WebP images are supported.');
  const size = imageSize(buf);
  if (!size || !size.width || !size.height) throw new IngestError('CORRUPT_IMAGE', 'The image could not be read (damaged or truncated file).');
  if (size.width < 64 || size.height < 64) throw new IngestError('IMAGE_TOO_SMALL', `Image is only ${size.width}×${size.height} px; at least 64×64 is needed.`);
  if (size.width > 16000 || size.height > 16000) throw new IngestError('IMAGE_TOO_LARGE', 'Image dimensions are too large.');
  return { mime, ...size };
}

const ROOM_WORDS: [RegExp, string][] = [
  [/kitchen/i, 'Kitchen'],
  [/living|lounge|sitting|reception|family[-_ ]?room/i, 'Living room'],
  [/dining/i, 'Dining room'],
  [/en[-_ ]?suite/i, 'En-suite'],
  [/bath|shower/i, 'Bathroom'],
  [/\bwc\b|toilet|cloak/i, 'WC'],
  [/bed(room)?[-_ ]?(\d)/i, 'Bedroom $2'],
  [/bed(room)?/i, 'Bedroom'],
  [/hall|entrance|foyer/i, 'Hallway'],
  [/landing/i, 'Landing'],
  [/study|office/i, 'Study'],
  [/utility|laundry/i, 'Utility'],
  [/garden|exterior|front|outside|facade|street/i, 'Exterior'],
];

/** Cheap, offline hint from a file name or URL. Always labelled as a guess from the name. */
export function hintFromName(name: string): { roomLabel: string | null; floorplan: boolean } {
  const base = decodeURIComponent(name.split(/[?#]/)[0].split('/').pop() ?? '').replace(/\.[a-z]+$/i, '');
  if (/floor[\s_-]?plan|floorplan|(^|[^a-z])flp([^a-z]|$)/i.test(base)) return { roomLabel: null, floorplan: true };
  for (const [re, label] of ROOM_WORDS) {
    const m = base.match(re);
    if (m) return { roomLabel: label.replace('$2', m[2] ?? '').trim(), floorplan: false };
  }
  return { roomLabel: null, floorplan: false };
}

export function createUploadProperty(input: { title?: string | null; address?: string | null; listingUrl?: string | null; description?: string | null; bedrooms?: number | null; bathrooms?: number | null; areaSqM?: number | null; price?: Property['price'] }, attribution: string): Property {
  const now = new Date().toISOString();
  const id = `prop-u-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  return {
    id,
    sourceProvider: UPLOAD_PROVIDER,
    sourceListingId: id.slice(5),
    listingUrl: input.listingUrl ?? null,
    address: (input.address || input.title || 'Untitled property').slice(0, 200),
    location: null,
    status: 'imported',
    price: input.price ?? null,
    bedrooms: input.bedrooms != null ? Math.round(input.bedrooms) : null,
    bathrooms: input.bathrooms ?? null,
    areaSqM: input.areaSqM ?? null,
    areaEvidence: input.areaSqM ? 'Stated on the source page' : null,
    description: input.description ?? null,
    sourceInfo: {
      attribution,
      rightsNote: 'The person importing confirmed they own these images or have permission to use them. They are processed only to build this model.',
    },
    missingData: [],
    createdAt: now,
    updatedAt: now,
  };
}

const mediaOf = (propertyId: string) => Object.values(store.all('media')).filter((m) => m.propertyId === propertyId);

/** Store one validated image for a property. Duplicate files (same bytes) return the existing record. */
export async function addImage(
  property: Property,
  buf: Buffer,
  opts: { type?: 'photo' | 'floorplan'; filename?: string | null; sourceUrl?: string | null; roomLabel?: string | null; via: 'upload' | 'image-url' | 'listing-url'; evidence?: string | null },
): Promise<{ media: PropertyMedia; duplicate: boolean }> {
  const info = validateImage(buf);
  const hash = createHash('sha256').update(buf).digest('hex');
  const id = `${property.id}-m-${hash.slice(0, 12)}`;
  const existing = store.get('media', id);
  if (existing) return { media: existing, duplicate: true };
  const all = mediaOf(property.id);
  if (all.length >= MAX_MEDIA_PER_PROPERTY) throw new IngestError('TOO_MANY_IMAGES', `A property can hold at most ${MAX_MEDIA_PER_PROPERTY} images.`);
  const ext = info.mime.split('/')[1].replace('jpeg', 'jpg');
  const dir = join(config.dataDir, 'uploads', property.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${hash.slice(0, 24)}.${ext}`), buf);
  const hint = hintFromName(opts.filename ?? opts.sourceUrl ?? '');
  const type = opts.type ?? (hint.floorplan ? 'floorplan' : 'photo');
  const media: PropertyMedia = {
    id,
    propertyId: property.id,
    type,
    storageKey: `uploads/${property.id}/${hash.slice(0, 24)}.${ext}`,
    mimeType: info.mime,
    sourceUrl: opts.sourceUrl ?? null,
    pageOrFrame: null,
    captureDate: null,
    levelGuess: null,
    roomGuess: opts.roomLabel?.trim() || null,
    usageRightsStatus: 'permission-granted',
    metadata: {
      width: info.width,
      height: info.height,
      bytes: buf.length,
      sha256: hash,
      order: all.length ? Math.max(...all.map((m) => Number(m.metadata.order ?? 0))) + 1 : 0,
      importedVia: opts.via,
      rightsBasis: 'user-confirmed',
      ...(opts.filename ? { originalFilename: opts.filename.slice(0, 200) } : {}),
      ...(opts.evidence ? { importEvidence: opts.evidence } : {}),
      ...(!opts.type && hint.floorplan ? { typeSource: 'name-heuristic' } : opts.type ? { typeSource: opts.via === 'listing-url' ? 'listing-page' : 'user' } : {}),
      ...(hint.roomLabel && !opts.roomLabel ? { suggestion: { roomLabel: hint.roomLabel, source: 'file name', confidence: 0.4 } } : {}),
    },
  };
  await store.put('media', id, media);
  return { media, duplicate: false };
}

export interface UrlResult {
  url: string;
  ok: boolean;
  mediaId?: string;
  duplicate?: boolean;
  error?: string;
}

/** Download user-supplied image URLs through the SSRF guard, 4 at a time. */
export async function addImageUrls(
  property: Property,
  items: { url: string; type?: 'photo' | 'floorplan'; roomLabel?: string | null; evidence?: string | null }[],
  via: 'image-url' | 'listing-url',
  fetcher: Fetcher = safeFetch,
): Promise<UrlResult[]> {
  const results: UrlResult[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      try {
        const r = await fetcher(it.url, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 20000, accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8' });
        if (r.status < 200 || r.status >= 300) throw new IngestError('FETCH_FAILED', `HTTP ${r.status}`);
        const { media, duplicate } = await addImage(property, r.body, { type: it.type, sourceUrl: it.url, roomLabel: it.roomLabel, via, evidence: it.evidence, filename: null });
        results[i] = { url: it.url, ok: true, mediaId: media.id, duplicate };
      } catch (e) {
        results[i] = { url: it.url, ok: false, error: (e as Error).message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  return results;
}

/** Listing URL → property with every image we could download, for the review screen. */
export async function importFromListingUrl(
  url: string,
  fetcher: Fetcher = safeFetch,
  maxImages = 40,
): Promise<{ property: Property; media: PropertyMedia[]; extraction: { adapter: string; found: number; floorplans: number; downloaded: number; failed: { url: string; error: string }[]; notes: string[] } }> {
  const ex: ExtractedListing = await extractListing(url, fetcher);
  // Floor plans first so a long gallery can't push them past the cap.
  const ordered: CandidateImage[] = [...ex.images.filter((i) => i.kind === 'floorplan'), ...ex.images.filter((i) => i.kind === 'photo')].slice(0, maxImages);
  const host = new URL(ex.sourceUrl).hostname.replace(/^www\./, '');
  const property = createUploadProperty(
    { title: ex.title, address: ex.address ?? ex.title, listingUrl: ex.sourceUrl, description: ex.description, bedrooms: ex.bedrooms, bathrooms: ex.bathrooms, areaSqM: ex.areaSqM, price: ex.price },
    `Imported from ${host} (public listing page)`,
  );
  property.sourceProvider = 'listing-url';
  property.missingData = [...(ex.images.some((i) => i.kind === 'floorplan') ? [] : ['No floor plan was found on the page — add one if you have it']), ...(ex.images.length > maxImages ? [`Only the first ${maxImages} of ${ex.images.length} images were imported`] : [])];
  await store.put('properties', property.id, property);
  const results = await addImageUrls(
    property,
    ordered.map((c) => ({ url: c.url, type: c.kind === 'floorplan' ? 'floorplan' : undefined, evidence: c.evidence })),
    'listing-url',
    fetcher,
  );
  const media = mediaOf(property.id);
  // Pages often include tiny thumbnails of the same picture; keep everything but say what failed.
  return {
    property,
    media,
    extraction: {
      adapter: ex.adapter,
      found: ex.images.length,
      floorplans: ex.images.filter((i) => i.kind === 'floorplan').length,
      downloaded: results.filter((r) => r.ok && !r.duplicate).length,
      failed: results.filter((r) => !r.ok).map((r) => ({ url: r.url, error: r.error ?? 'failed' })),
      notes: ex.notes,
    },
  };
}

/** Listing id when a URL belongs to a portal the RealtyAPI adapter already supports. */
export function realtyIdFromUrl(raw: string): { provider: 'rightmove' | 'zoopla' | 'zillow'; listingId: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const h = u.hostname;
  let m: RegExpMatchArray | null;
  if (/(^|\.)rightmove\.co\.uk$/.test(h) && (m = u.pathname.match(/\/properties\/(\d+)/))) return { provider: 'rightmove', listingId: m[1] };
  if (/(^|\.)zoopla\.co\.uk$/.test(h) && (m = u.pathname.match(/\/details\/(\d+)/))) return { provider: 'zoopla', listingId: m[1] };
  if (/(^|\.)zillow\.com$/.test(h) && (m = u.pathname.match(/\/(\d+)_zpid/))) return { provider: 'zillow', listingId: m[1] };
  return null;
}
