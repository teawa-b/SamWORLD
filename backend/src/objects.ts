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
  frontFace,
  insideBox,
  invertRigid,
  projectToFrame,
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
import { startOriginal } from './restyle.js';
import { store, type Scan, type ScanObject } from './store.js';

export const OBJECTS_PROMPT_VERSION = 'roomshift-objects-v3';
/** Frames SAM looks at (chosen to cover the room's directions) and frames Muse looks at (spread over the video). */
const KEYFRAMES = 10;
const MAX_CONCEPTS = 20;
const MAX_OBJECTS = 24;
/** Always looked for: they shape the room in every world. */
const ALWAYS = ['door', 'window'];
/** Labels of things that sit flat on a wall and are repainted in place rather than rebuilt in 3D. */
const SURFACE_LABEL = /door|window|painting|picture|poster|mirror|frame|\btv\b|television|screen|clock|art|decoration|plate|niche|whiteboard|board/i;
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
  /** What's in the room, and in which of the given images (0-based) each thing can be seen. */
  listObjects(images: string[], budget: AiBudget): Promise<{ items: { concept: string; frames: number[] }[]; model: string }>;
  segment(dataUrl: string, size: { width: number; height: number }, concept: string, budget: AiBudget, frame: number): Promise<FrameDetection[]>;
}

const listSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['objects'],
  properties: {
    objects: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['concept', 'photos'], properties: { concept: { type: 'string' }, photos: { type: 'array', items: { type: 'integer' } } } },
    },
  },
};

export const metaDeps: UnderstandDeps = {
  async listObjects(images, budget) {
    const { data, model } = await museJson<{ objects: { concept: string; photos: number[] }[] }>({
      budget,
      system:
        `You are looking at ${images.length} numbered photos (1–${images.length}) of one real room taken from different spots. List every distinct thing in it worth showing in 3D: ` +
        'furniture (bed, sofa, wardrobe, table, desk, chair, bench, nightstand, cabinet, shelf, TV stand, ...), things on the walls (door, window, painting, mirror, TV, wall lamp, ' +
        'clock, round wall decoration, wall shelf or niche, air conditioner, curtain, ...) and large things on the floor (rug, plant, suitcase, backpack, laundry basket, ...). ' +
        'Always include every door and window you can see. Skip the walls, floor and ceiling themselves, loose clothes and anything smaller than a shoe box. ' +
        '`concept` is a short singular noun phrase an image segmenter can find ("door", "floor lamp", "round wall decoration"); list each kind once even if there are several. ' +
        `\`photos\` are the numbers of the photos where it is clearly visible. At most ${MAX_CONCEPTS}, largest first. Return JSON only.`,
      text: 'The room:',
      images,
      schemaName: 'roomshift_objects_v3',
      schema: listSchema,
    });
    return { items: data.objects.map((o) => ({ concept: o.concept, frames: (o.photos ?? []).map((p) => p - 1) })), model };
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
      const hit = await read<{ items: { concept: string; frames: number[] }[]; model: string }>('list.json');
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
  const budget = new AiBudget(KEYFRAMES * MAX_CONCEPTS + 3);
  const live = deps === metaDeps;
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

    // Muse sees the same keyframes SAM will, and says where each thing is, so SAM is only asked where it can see it.
    await status('running', 'Muse Spark is looking for furniture, doors and windows…');
    let museFrames = frames;
    const listed = await deps.listObjects(frames.map((f) => f.url), budget).catch(() => {
      museFrames = frames.filter((_, k) => k % 2 === 0);
      return deps.listObjects(museFrames.map((f) => f.url), budget);
    });
    const wanted = new Map<string, Set<number>>();
    for (const it of listed.items) {
      const c = it.concept.trim().toLowerCase();
      if (!c || c.length > 40 || (wanted.size >= MAX_CONCEPTS && !wanted.has(c))) continue;
      const set = wanted.get(c) ?? new Set<number>();
      for (const k of it.frames) if (museFrames[k]) set.add(museFrames[k].i);
      wanted.set(c, set);
    }
    for (const c of ALWAYS) if (![...wanted.keys()].some((k) => k.includes(c))) wanted.set(c, new Set());
    // Nothing said about where → look everywhere.
    const jobs = [...wanted].flatMap(([concept, where]) => frames.filter((f) => !where.size || where.has(f.i)).map((f) => ({ f, concept })));
    const concepts = [...wanted.keys()];

    await status('running', `SAM 3.1 is outlining ${concepts.join(', ')} (${jobs.length} looks across ${frames.length} views)…`);
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
        const flat = off.length < 0.25 * all.length && area < (SURFACE_LABEL.test(concept) ? 0.45 : 0.25) * f.size.width * f.size.height;
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
      const thin = Math.min(o.box.size[0], o.box.size[2]) < 0.25;
      const kind = (flat || SURFACE_LABEL.test(o.label)) && thin ? 'surface' : 'furniture';
      const box = kind === 'surface' ? o.box : thickenFlatBox(o.box, shell, [eye[0], eye[2]]);
      const id = `obj-${objects.length + 1}`;
      const frame = frames.find((f) => f.i === view.frame)!;
      let crop: string | null = null;
      try {
        crop = `${id}.jpg`;
        await writeFile(join(scanDir(scan.id), crop), cropFrame(frame.buf, view.bbox));
      } catch {
        crop = null;
      }
      // Surfaces: the face straightened out (as if photographed head-on), for repainting in place.
      let face: string | null = null;
      const ff = kind === 'surface' ? frontFace(box, [eye[0], eye[2]]) : null;
      if (ff) {
        const inv = invertRigid(align);
        const quad = ff.corners.map((p) => projectToFrame(transformPointRowMajor(inv, p), scan.cameras[view.frame], frame.size.width, frame.size.height));
        const ok = quad.every((q) => q && q[0] > -0.2 * frame.size.width && q[0] < 1.2 * frame.size.width && q[1] > -0.2 * frame.size.height && q[1] < 1.2 * frame.size.height);
        if (ok) {
          try {
            face = `${id}-face.jpg`;
            await writeFile(join(scanDir(scan.id), face), warpQuad(frame.buf, quad as [number, number][], ff.width / ff.height));
          } catch {
            face = null;
          }
        }
      }
      const facing = Math.atan2(eye[0] - box.centre[0], eye[2] - box.centre[2]);
      objects.push({ id, label: o.label, name: nth > 1 ? `${o.label} ${nth}` : o.label, box, points: o.points.length, views: o.detections.length, bestFrame: view.frame, facing, kind, face, crop });
    }
    // Number every copy once we know there are several ("chair 1", "chair 2").
    for (const o of objects) if ((counts.get(o.label) ?? 0) > 1 && o.name === o.label) o.name = `${o.label} 1`;

    // An "inner wall" that runs mostly through furniture is really the furniture's flat front (a wardrobe and
    // bench side by side in an alcove): drop it, or it gets painted over them.
    if (scan.shell?.inner?.length) {
      const furniture = objects.filter((o) => o.kind !== 'surface').map((o) => o.box);
      const inner = scan.shell.inner.filter((w) => {
        let covered = 0;
        for (let k = 0; k <= 20; k++) {
          const t = k / 20;
          const p = [w.a[0] + (w.b[0] - w.a[0]) * t, 0, w.a[1] + (w.b[1] - w.a[1]) * t];
          if (furniture.some((b) => insideBox(b, [p[0], b.centre[1], p[2]], 0.2))) covered++;
        }
        return covered / 21 < 0.4;
      });
      if (inner.length !== scan.shell.inner.length) scan.shell = { ...scan.shell, inner, diagnostics: [...scan.shell.diagnostics, `${scan.shell.inner.length - inner.length} inner wall(s) were furniture fronts; dropped`] };
    }

    const summary = objects.length ? `Found ${objects.length} object${objects.length > 1 ? 's' : ''}: ${objects.map((o) => o.name).join(', ')}.` : 'SAM 3.1 outlined nothing that stands out from the walls and floor.';
    await save({
      shell: scan.shell,
      objects,
      objectsStatus: { state: 'done', message: failures.length ? `${summary} (${failures.length} SAM call${failures.length > 1 ? 's' : ''} failed: ${failures[0]})` : summary, usage: budget.summary(), models: [listed.model] },
    });
    // Then the room as filmed, in 3D (SAM 3D on the real photos; cached, so a re-run is free).
    if (live) await startOriginal(scan).catch(() => null);
  } catch (e) {
    await status('failed', (e as Error).message, budget.summary());
  }
}

/**
 * The quadrilateral `quad` (top-left, top-right, bottom-right, bottom-left, in frame pixels) of a frame,
 * resampled into an upright rectangle with the given aspect: the face as if photographed straight-on.
 */
export function warpQuad(buf: Buffer, quad: [number, number][], aspect: number): Buffer {
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const img = isPng ? PNG.sync.read(buf) : jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  const W = img.width, H = img.height;
  const long = 768;
  const ow = Math.max(8, Math.round(aspect >= 1 ? long : long * aspect));
  const oh = Math.max(8, Math.round(aspect >= 1 ? long / aspect : long));
  const h = homography(quad);
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      const u = (x + 0.5) / ow, v = (y + 0.5) / oh;
      const den = h[6] * u + h[7] * v + 1;
      const sx = Math.min(W - 1.001, Math.max(0, (h[0] * u + h[1] * v + h[2]) / den));
      const sy = Math.min(H - 1.001, Math.max(0, (h[3] * u + h[4] * v + h[5]) / den));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const o = (y * ow + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p = (yy: number, xx: number) => img.data[(yy * W + xx) * 4 + c];
        out[o + c] = Math.round(p(y0, x0) * (1 - fx) * (1 - fy) + p(y0, x0 + 1) * fx * (1 - fy) + p(y0 + 1, x0) * (1 - fx) * fy + p(y0 + 1, x0 + 1) * fx * fy);
      }
      out[o + 3] = 255;
    }
  return jpeg.encode({ data: out, width: ow, height: oh }, 88).data;
}

/** 3 × 3 homography (h33 = 1) taking the unit square's corners (0,0) (1,0) (1,1) (0,1) to `quad`. */
function homography(quad: [number, number][]): number[] {
  const src = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const A: number[][] = [];
  const b: number[] = [];
  for (let k = 0; k < 4; k++) {
    const [u, v] = src[k];
    const [x, y] = quad[k];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  // Gaussian elimination with partial pivoting.
  for (let i = 0; i < 8; i++) {
    let p = i;
    for (let r = i + 1; r < 8; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < 8; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < 8; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const h = new Array(8).fill(0);
  for (let i = 7; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < 8; c++) s -= A[i][c] * h[c];
    h[i] = s / A[i][i];
  }
  return h;
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
