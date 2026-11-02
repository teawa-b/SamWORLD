/**
 * Roomshift step 3 (DETAIL.md): what's in the room. Muse Spark names the objects it sees in a few keyframes,
 * SAM 3.1 outlines each one in every keyframe, and the masks are lifted into 3D boxes through the scan's
 * cameras and point cloud (shared/scan-objects.ts). The clearest view of each object is saved as a crop for
 * restyling later. Needs MODEL_API_KEY; without it the step is skipped and the room still works.
 * Muse's list and every SAM answer are cached per scan, so running the step again costs no Meta calls.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { config, metaConfigured } from './config.js';
import { now } from './http.js';
import { imageSize } from './lib/image.js';
import { AiBudget, museJson } from './meta/client.js';
import { segmentConcept } from './meta/sam.js';
import {
  bestView,
  boxOfPoints,
  consolidateObjects,
  maskPoints,
  mergeDetections,
  onShell,
  parsePly,
  pickKeyframes,
  roomPoint,
  thickenFlatBox,
  transformPointRowMajor,
  visiblePixels,
  type LiftedDetection,
  type LiftMask,
} from './shared/index.js';
import { store, type Scan, type ScanObject } from './store.js';

export const OBJECTS_PROMPT_VERSION = 'roomshift-objects-v2';
/** Frames SAM looks at (chosen to cover the room's directions) and frames Muse looks at (spread over the video). */
const KEYFRAMES = 10;
const MUSE_FRAMES = 8;
const MAX_CONCEPTS = 12;
const MAX_OBJECTS = 16;
const MIN_DETECTION_POINTS = 30;
const MIN_OBJECT_POINTS = 120;

/** One SAM detection, mask as a full-frame raster. */
export interface FrameDetection {
  score: number;
  mask: LiftMask;
  bbox: [number, number, number, number];
}

/** The two Meta calls, swappable in tests. */
export interface UnderstandDeps {
  listObjects(images: string[], budget: AiBudget): Promise<{ concepts: string[]; model: string }>;
  segment(dataUrl: string, size: { width: number; height: number }, concept: string, budget: AiBudget, frame: number): Promise<FrameDetection[]>;
}

const listSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['objects'],
  properties: { objects: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['concept'], properties: { concept: { type: 'string' } } } } },
};

export const metaDeps: UnderstandDeps = {
  async listObjects(images, budget) {
    const { data, model } = await museJson<{ objects: { concept: string }[] }>({
      budget,
      system:
        'You are looking at photos of one real room taken from different spots. List the distinct pieces of furniture and large objects in it, ' +
        'including things on the walls or floor: sofa, bed, table, chair, wardrobe, bookshelf, cabinet, desk, bench, nightstand, lamp, TV, mirror, painting, ' +
        'rug, curtain, plant, air conditioner, suitcase, ... Skip the walls, floor and ceiling themselves, windows, doors, loose clothes, small clutter and anything smaller than a shoe box. ' +
        `Each \`concept\` is a short singular noun phrase an image segmenter can find, e.g. "sofa", "floor lamp", "coffee table". At most ${MAX_CONCEPTS}, largest first, no duplicates. Return JSON only.`,
      text: 'The room:',
      images,
      schemaName: 'roomshift_objects',
      schema: listSchema,
    });
    return { concepts: data.objects.map((o) => o.concept), model };
  },
  async segment(dataUrl, size, concept, budget, frame) {
    const r = await segmentConcept({ budget, mediaId: `f${frame}`, dataUrl, imageSize: size, concept });
    return r.detections.flatMap((d) => {
      const m = r.rasters.find((x) => x.detectionId === d.id);
      if (!m) return [];
      return [{ score: d.score ?? 0.5, mask: fullFrame(m, size), bbox: [d.box[0] * size.width, d.box[1] * size.height, d.box[2] * size.width, d.box[3] * size.height] as [number, number, number, number] }];
    });
  },
};

/** Place a SAM mask (raster over `bounds`) into a frame-sized raster. */
function fullFrame(m: { bounds: { left: number; top: number; right: number; bottom: number }; raster: Uint8Array; width: number; height: number }, size: { width: number; height: number }): LiftMask {
  const out = new Uint8Array(size.width * size.height);
  const sx = m.width / Math.max(1, m.bounds.right - m.bounds.left);
  const sy = m.height / Math.max(1, m.bounds.bottom - m.bounds.top);
  const x0 = Math.max(0, Math.floor(m.bounds.left)), x1 = Math.min(size.width, Math.ceil(m.bounds.right));
  const y0 = Math.max(0, Math.floor(m.bounds.top)), y1 = Math.min(size.height, Math.ceil(m.bounds.bottom));
  for (let y = y0; y < y1; y++) {
    const my = Math.min(m.height - 1, Math.floor((y + 0.5 - m.bounds.top) * sy));
    for (let x = x0; x < x1; x++) {
      const mx = Math.min(m.width - 1, Math.floor((x + 0.5 - m.bounds.left) * sx));
      if (mx >= 0 && my >= 0 && m.raster[my * m.width + mx]) out[y * size.width + x] = 1;
    }
  }
  return { raster: out, width: size.width, height: size.height };
}

const scanDir = (id: string) => join(config.dataDir, 'scans', id);

/** Run-length code for 0/1 rasters: alternating run lengths, starting with zeros. */
export function encodeRuns(r: Uint8Array): number[] {
  const out: number[] = [];
  let cur = 0, n = 0;
  for (const v of r) {
    if (v === cur) n++;
    else {
      out.push(n);
      cur = v;
      n = 1;
    }
  }
  out.push(n);
  return out;
}

export function decodeRuns(runs: number[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  runs.forEach((n, k) => {
    if (k % 2) out.fill(1, at, at + n);
    at += n;
  });
  return out;
}

/** Wrap the Meta calls with a per-scan disk cache (successes only). */
function cached(scan: Scan, deps: UnderstandDeps): UnderstandDeps {
  // Muse's list depends on the prompt version; a SAM mask only on the frame and the concept, so it's shared.
  const base = join(scanDir(scan.id), 'objects-cache');
  const at = (f: string) => join(base, f.startsWith('sam-') ? 'sam' : OBJECTS_PROMPT_VERSION, f);
  const read = async <T>(f: string): Promise<T | null> => {
    // SAM masks from before the split lived under the v1 folder.
    const p = [at(f), ...(f.startsWith('sam-') ? [join(base, 'roomshift-objects-v1', f)] : [])].find((x) => existsSync(x));
    return p ? JSON.parse(await readFile(p, 'utf8')) : null;
  };
  const write = async (f: string, v: unknown) => {
    await mkdir(join(at(f), '..'), { recursive: true });
    await writeFile(at(f), JSON.stringify(v));
  };
  return {
    async listObjects(images, budget) {
      const hit = await read<{ concepts: string[]; model: string }>('list.json');
      if (hit) return { ...hit, model: `${hit.model} (cached)` };
      const r = await deps.listObjects(images, budget);
      await write('list.json', r);
      return r;
    },
    async segment(url, size, concept, budget, frame) {
      const f = `sam-${frame}-${concept.replace(/\W+/g, '-')}.json`;
      type Row = { score: number; bbox: FrameDetection['bbox']; width: number; height: number; runs: number[] };
      const hit = await read<Row[]>(f);
      if (hit) return hit.map((d) => ({ score: d.score, bbox: d.bbox, mask: { raster: decodeRuns(d.runs, d.width * d.height), width: d.width, height: d.height } }));
      const r = await deps.segment(url, size, concept, budget, frame);
      await write(f, r.map((d): Row => ({ score: d.score, bbox: d.bbox, width: d.mask.width, height: d.mask.height, runs: encodeRuns(d.mask.raster) })));
      return r;
    },
  };
}
const dataUrl = (buf: Buffer, file: string) => `data:image/${file.endsWith('.png') ? 'png' : file.endsWith('.webp') ? 'webp' : 'jpeg'};base64,${buf.toString('base64')}`;

/** Find, lift and save the scan's objects. Progress and the result are saved on the scan record. */
export async function understandScan(scan: Scan, deps: UnderstandDeps = metaDeps): Promise<void> {
  const save = (patch: Partial<Scan>) => store.put('scans', scan.id, Object.assign(scan, patch, { updatedAt: now() }));
  const status = (state: NonNullable<Scan['objectsStatus']>['state'], message: string, usage = '') => save({ objectsStatus: { state, message, usage } });
  if (deps === metaDeps && !metaConfigured()) return status('skipped', 'Objects need MODEL_API_KEY (SAM 3.1 + Muse Spark); the room works without them.');
  if (!scan.cloud || !scan.cameras.length) return status('skipped', 'No reconstruction to find objects in.');
  const budget = new AiBudget(KEYFRAMES * MAX_CONCEPTS + 2);
  deps = cached(scan, deps);
  try {
    const n = Math.min(scan.frames.length, scan.cameras.length);
    const picks = pickKeyframes(scan.cameras.slice(0, n), KEYFRAMES);
    const frames = await Promise.all(
      picks.map(async (i) => {
        const buf = await readFile(join(scanDir(scan.id), scan.frames[i].file));
        return { i, buf, url: dataUrl(buf, scan.frames[i].file), size: imageSize(buf) ?? { width: scan.frames[i].width, height: scan.frames[i].height } };
      }),
    );

    await status('running', 'Muse Spark is looking for furniture…');
    const museIdx = [...new Set(Array.from({ length: Math.min(MUSE_FRAMES, scan.frames.length) }, (_, i) => Math.floor(((i + 0.5) / Math.min(MUSE_FRAMES, scan.frames.length)) * scan.frames.length)))];
    const museUrls = await Promise.all(museIdx.map(async (i) => dataUrl(await readFile(join(scanDir(scan.id), scan.frames[i].file)), scan.frames[i].file)));
    const listed = await deps.listObjects(museUrls, budget).catch(() => deps.listObjects(museUrls.filter((_, k) => k % 2 === 0), budget));
    const concepts = [...new Set(listed.concepts.map((c) => c.trim().toLowerCase()).filter((c) => c && c.length <= 40))].slice(0, MAX_CONCEPTS);
    if (!concepts.length) return status('done', 'Muse Spark found no furniture to outline.', budget.summary());

    await status('running', `SAM 3.1 is outlining ${concepts.join(', ')} in ${frames.length} views…`);
    const ply = await readFile(join(scanDir(scan.id), scan.cloud.file));
    const pc = parsePly(ply.buffer.slice(ply.byteOffset, ply.byteOffset + ply.byteLength) as ArrayBuffer, { maxPoints: 2_000_000 });
    const shell = scan.shell && !scan.shell.fallback ? scan.shell : null;
    const align = scan.shell?.alignment ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const room = new Float32Array(pc.count * 3);
    const free = new Uint8Array(pc.count);
    for (let i = 0; i < pc.count; i++) {
      const p = roomPoint(pc.positions, align, i);
      room.set(p, i * 3);
      free[i] = shell && onShell(p, shell) ? 0 : 1;
    }

    const lifted: LiftedDetection[] = [];
    const failures: string[] = [];
    const jobs = frames.flatMap((f) => concepts.map((concept) => ({ f, concept })));
    const pix = new Map<number, Int32Array>();
    await pool(jobs, 4, async ({ f, concept }) => {
      let dets: FrameDetection[];
      try {
        dets = await deps.segment(f.url, f.size, concept, budget, f.i);
      } catch (e) {
        failures.push(`${concept} in view ${f.i + 1}: ${(e as Error).message}`);
        return;
      }
      const cam = scan.cameras[f.i];
      if (!pix.has(f.i)) pix.set(f.i, visiblePixels(pc.positions, cam));
      for (const d of dets) {
        let area = 0;
        for (const v of d.mask.raster) area += v;
        // Off-shell points by default; but a picture, mirror or rug lies on the shell itself, so when most of a
        // small mask's points are shell points, keep them all.
        const all = maskPoints(pix.get(f.i)!, cam, d.mask);
        const off = all.filter((k) => free[k] === 1);
        const flat = off.length < 0.25 * all.length && area < 0.25 * f.size.width * f.size.height;
        const pts = flat ? all : off;
        const [l, t, r, b] = d.bbox;
        const m = 0.01 * Math.max(f.size.width, f.size.height);
        const edge = [l < m, t < m, r > f.size.width - m, b > f.size.height - m].filter(Boolean).length / 4;
        lifted.push({ label: concept, score: d.score, points: Uint32Array.from(pts), frame: f.i, edge, area: area / (f.size.width * f.size.height), bbox: d.bbox, flat });
      }
    });

    const boxOf = (pts: number[]) => boxOfPoints(pts.map((k) => [room[k * 3], room[k * 3 + 1], room[k * 3 + 2]]));
    const merged = consolidateObjects(mergeDetections(lifted.filter((d) => d.points.length >= MIN_DETECTION_POINTS)), boxOf, { minPoints: MIN_OBJECT_POINTS }).slice(0, MAX_OBJECTS);
    const objects: ScanObject[] = [];
    const counts = new Map<string, number>();
    for (const o of merged) {
      const nth = (counts.get(o.label) ?? 0) + 1;
      counts.set(o.label, nth);
      const view = bestView(o.detections);
      const eye = transformPointRowMajor(align, [scan.cameras[view.frame].pose[3], scan.cameras[view.frame].pose[7], scan.cameras[view.frame].pose[11]]);
      const flat = o.detections.filter((d) => d.flat).length * 2 > o.detections.length;
      const box = flat ? o.box : thickenFlatBox(o.box, shell, [eye[0], eye[2]]);
      const id = `obj-${objects.length + 1}`;
      const frame = frames.find((f) => f.i === view.frame)!;
      let crop: string | null = null;
      try {
        crop = `${id}.jpg`;
        await writeFile(join(scanDir(scan.id), crop), cropFrame(frame.buf, view.bbox));
      } catch {
        crop = null;
      }
      objects.push({ id, label: o.label, name: nth > 1 ? `${o.label} ${nth}` : o.label, box, points: o.points.length, views: o.detections.length, bestFrame: view.frame, crop });
    }
    // Number every copy once we know there are several ("chair 1", "chair 2").
    for (const o of objects) if ((counts.get(o.label) ?? 0) > 1 && o.name === o.label) o.name = `${o.label} 1`;

    const summary = objects.length ? `Found ${objects.length} object${objects.length > 1 ? 's' : ''}: ${objects.map((o) => o.name).join(', ')}.` : 'SAM 3.1 outlined nothing that stands out from the walls and floor.';
    await save({
      objects,
      objectsStatus: { state: 'done', message: failures.length ? `${summary} (${failures.length} SAM call${failures.length > 1 ? 's' : ''} failed: ${failures[0]})` : summary, usage: budget.summary(), models: [listed.model] },
    });
  } catch (e) {
    await status('failed', (e as Error).message, budget.summary());
  }
}

/** JPEG crop of a frame around a pixel box, padded by 8%. */
export function cropFrame(buf: Buffer, bbox: [number, number, number, number]): Buffer {
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const img = isPng ? PNG.sync.read(buf) : jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  const W = img.width, H = img.height;
  const pw = (bbox[2] - bbox[0]) * 0.08, ph = (bbox[3] - bbox[1]) * 0.08;
  const x0 = Math.max(0, Math.floor(bbox[0] - pw)), y0 = Math.max(0, Math.floor(bbox[1] - ph));
  const x1 = Math.min(W, Math.ceil(bbox[2] + pw)), y1 = Math.min(H, Math.ceil(bbox[3] + ph));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) Buffer.from(img.data.buffer, img.data.byteOffset + ((y0 + y) * W + x0) * 4, w * 4).copy(out, y * w * 4);
  return jpeg.encode({ data: out, width: w, height: h }, 88).data;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}
