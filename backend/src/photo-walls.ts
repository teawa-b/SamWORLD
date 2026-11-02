/**
 * Photo walls: the room's floor, ceiling and walls textured with the video itself instead of the scan's
 * points (which look coarse up close and in a headset). Every texel of every shell plane (1 cm) is projected
 * into each frame through its camera; frames that see it unobstructed (depth-tested against the point cloud,
 * so the bed isn't painted onto the wall behind it) contribute its colour, weighted towards head-on, close
 * views. Found furniture blocks the view too (its box is drawn into each frame's depth buffer), so a bed
 * whose points are sparse still isn't smeared onto the wall behind it. Texels no frame saw are filled
 * smoothly from their surroundings, then, where a surface has real gaps, by Muse Image: it gets the photo
 * with the gaps painted magenta and paints them in; only those gaps are taken from its answer (feathered
 * into the smooth fill at their edges), so everything the video saw stays exactly as filmed.
 *
 * Runs after the objects are found (a few seconds); the images are cached next to the scan.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { config, metaConfigured } from './config.js';
import { AiBudget } from './meta/client.js';
import { inpaintSurface } from './meta/image.js';
import { invertRigid, parsePly, planePoint, shellPlanes, transformPointRowMajor } from './shared/index.js';
import type { Scan } from './store.js';

const TEXEL = 0.01; // metres
const MAX_SIDE = 2048;
const ZCELL = 2; // camera pixels per depth-buffer cell
const OCCLUSION = 0.12; // metres in front of the surface that count as something blocking it
export const PHOTO_WALLS_VERSION = 'photo-walls-v2';
/** Surfaces with at least this share unseen get Muse Image's fill. */
const INPAINT_FROM = 0.08;

/** Paint the unseen (magenta) parts of a surface photo; returns the painted image, or null. Swappable in tests. */
export type Inpaint = (png: Buffer, surface: 'wall' | 'floor' | 'ceiling') => Promise<Buffer | null>;

const museInpaint = (budget: AiBudget): Inpaint => async (png, surface) => {
  const r = await inpaintSurface({ budget, imageDataUrl: `data:image/png;base64,${png.toString('base64')}`, surface });
  return Buffer.from(r.imageBase64, 'base64');
};

export interface PhotoWall {
  id: string;
  file: string;
  width: number;
  height: number;
  /** Share of texels some frame saw (the rest is filled in). */
  seen: number;
  /** How the unseen part was filled. */
  filled: 'muse-image' | 'smooth' | 'none';
}

const scanDir = (id: string) => join(config.dataDir, 'scans', id);

export async function photoWalls(scan: Scan, opts: { inpaint?: Inpaint | null } = {}): Promise<PhotoWall[]> {
  const inpaint = opts.inpaint !== undefined ? opts.inpaint : metaConfigured() ? museInpaint(new AiBudget(12)) : null;
  const shell = scan.shell;
  if (!shell || shell.fallback || !scan.cloud || !scan.cameras.length) return [];
  const planes = shellPlanes(shell);
  const toScan = invertRigid(shell.alignment);
  const ply = await readFile(join(scanDir(scan.id), scan.cloud.file));
  const pc = parsePly(ply.buffer.slice(ply.byteOffset, ply.byteOffset + ply.byteLength) as ArrayBuffer, { maxPoints: 2_000_000 });

  // Texels of every plane, as scan-frame points, plus the plane normal (scan frame) for view weighting.
  const grids = planes.map((p) => {
    const tw = Math.max(4, Math.min(MAX_SIDE, Math.round(p.width / TEXEL)));
    const th = Math.max(4, Math.min(MAX_SIDE, Math.round(p.height / TEXEL)));
    const pts = new Float32Array(tw * th * 3);
    for (let r = 0; r < th; r++)
      for (let c = 0; c < tw; c++) {
        // Image row 0 is the top of the plane (v = 1).
        const q = transformPointRowMajor(toScan, planePoint(p, (c + 0.5) / tw, 1 - (r + 0.5) / th));
        pts.set(q, (r * tw + c) * 3);
      }
    const n = p.normal;
    const nScan = [0, 1, 2].map((k) => toScan[k * 4] * n[0] + toScan[k * 4 + 1] * n[1] + toScan[k * 4 + 2] * n[2]);
    return { plane: p, tw, th, pts, n: nScan, sum: new Float32Array(tw * th * 3), wsum: new Float32Array(tw * th) };
  });

  const nFrames = Math.min(scan.frames.length, scan.cameras.length);
  for (let f = 0; f < nFrames; f++) {
    const cam = scan.cameras[f];
    const buf = await readFile(join(scanDir(scan.id), scan.frames[f].file));
    const img = buf[0] === 0x89 ? PNG.sync.read(buf) : jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    const V = invertRigid(cam.pose);
    const [fx, fy, cx, cy] = cam.intrinsics;
    const s = img.width / cam.width;
    const oy = (img.height - cam.height * s) / 2;
    const eye = [cam.pose[3], cam.pose[7], cam.pose[11]];
    // Depth buffer from the cloud: the nearest surface along each ray.
    const gw = Math.ceil(cam.width / ZCELL), gh = Math.ceil(cam.height / ZCELL);
    const zb = new Float32Array(gw * gh).fill(Infinity);
    for (let i = 0; i < pc.count; i++) {
      const x = pc.positions[i * 3], y = pc.positions[i * 3 + 1], z = pc.positions[i * 3 + 2];
      const d = -(V[8] * x + V[9] * y + V[10] * z + V[11]);
      if (d < 0.05) continue;
      const u = (fx * (V[0] * x + V[1] * y + V[2] * z + V[3])) / d + cx;
      const v = cy - (fy * (V[4] * x + V[5] * y + V[6] * z + V[7])) / d;
      if (u < 0 || v < 0 || u >= cam.width || v >= cam.height) continue;
      const g = Math.floor(v / ZCELL) * gw + Math.floor(u / ZCELL);
      if (d < zb[g]) zb[g] = d;
    }
    // Furniture boxes block like solid objects: their projected corners' bounding rectangle at their nearest depth.
    for (const o of scan.objects ?? []) {
      if (o.kind === 'surface') continue;
      const [w, h, dd] = o.box.size;
      const c = Math.cos(o.box.yaw), sn = Math.sin(o.box.yaw);
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity, dmin = Infinity;
      let behind = false;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const lx = (sx * w) / 2, lz = (sz * dd) / 2;
        const room = [o.box.centre[0] + lx * c + lz * sn, o.box.centre[1] + (sy * h) / 2, o.box.centre[2] - lx * sn + lz * c];
        const [x, y, z] = transformPointRowMajor(toScan, room);
        const d = -(V[8] * x + V[9] * y + V[10] * z + V[11]);
        if (d < 0.05) {
          behind = true;
          break;
        }
        const u = (fx * (V[0] * x + V[1] * y + V[2] * z + V[3])) / d + cx;
        const v = cy - (fy * (V[4] * x + V[5] * y + V[6] * z + V[7])) / d;
        u0 = Math.min(u0, u), u1 = Math.max(u1, u), v0 = Math.min(v0, v), v1 = Math.max(v1, v), dmin = Math.min(dmin, d);
      }
      if (behind) continue;
      // Shrink the rectangle a little: a box's silhouette is smaller than its corners' bounding rectangle.
      const mu = (u1 - u0) * 0.1, mv = (v1 - v0) * 0.1;
      for (let gy = Math.max(0, Math.floor((v0 + mv) / ZCELL)); gy <= Math.min(gh - 1, Math.floor((v1 - mv) / ZCELL)); gy++)
        for (let gx = Math.max(0, Math.floor((u0 + mu) / ZCELL)); gx <= Math.min(gw - 1, Math.floor((u1 - mu) / ZCELL)); gx++) {
          const g = gy * gw + gx;
          if (dmin < zb[g]) zb[g] = dmin;
        }
    }
    for (const G of grids) {
      const { pts, n, sum, wsum } = G;
      for (let t = 0; t < wsum.length; t++) {
        const x = pts[t * 3], y = pts[t * 3 + 1], z = pts[t * 3 + 2];
        const d = -(V[8] * x + V[9] * y + V[10] * z + V[11]);
        if (d < 0.2) continue;
        const u = (fx * (V[0] * x + V[1] * y + V[2] * z + V[3])) / d + cx;
        const v = cy - (fy * (V[4] * x + V[5] * y + V[6] * z + V[7])) / d;
        if (u < 1 || v < 1 || u >= cam.width - 1 || v >= cam.height - 1) continue;
        // Seen from the side it faces (inner walls: either side), and not too obliquely.
        const rx = eye[0] - x, ry = eye[1] - y, rz = eye[2] - z;
        const rl = Math.hypot(rx, ry, rz);
        let cos = (rx * n[0] + ry * n[1] + rz * n[2]) / rl;
        if (G.plane.twoSided) cos = Math.abs(cos);
        if (cos < 0.2) continue;
        if (zb[Math.floor(v / ZCELL) * gw + Math.floor(u / ZCELL)] < d - OCCLUSION) continue; // something in front
        const w = (cos * cos * cos * cos) / (rl * rl);
        // Bilinear sample of the frame.
        const px = u * s, py = v * s + oy;
        const x0 = Math.floor(px), y0 = Math.floor(py);
        if (x0 < 0 || y0 < 0 || x0 >= img.width - 1 || y0 >= img.height - 1) continue;
        const ax = px - x0, ay = py - y0;
        for (let c = 0; c < 3; c++) {
          const at = (yy: number, xx: number) => img.data[(yy * img.width + xx) * 4 + c];
          const val = at(y0, x0) * (1 - ax) * (1 - ay) + at(y0, x0 + 1) * ax * (1 - ay) + at(y0 + 1, x0) * (1 - ax) * ay + at(y0 + 1, x0 + 1) * ax * ay;
          sum[t * 3 + c] += val * w;
        }
        wsum[t] += w;
      }
    }
  }

  await mkdir(join(scanDir(scan.id), 'walls'), { recursive: true });
  const out: PhotoWall[] = [];
  const jobs: (() => Promise<void>)[] = [];
  for (const G of grids) {
    const { tw, th, sum, wsum } = G;
    const col = new Float32Array(tw * th * 3);
    const has = new Uint8Array(tw * th);
    let seen = 0;
    for (let t = 0; t < wsum.length; t++) {
      if (!wsum[t]) continue;
      has[t] = 1;
      seen++;
      for (let c = 0; c < 3; c++) col[t * 3 + c] = sum[t * 3 + c] / wsum[t];
    }
    if (seen < 0.05 * wsum.length) continue; // hardly seen: the viewer keeps its point-based coat
    // Isolated seen texels at the edge of what the frames covered read as speckle: keep a texel only when most
    // of its 5 × 5 neighbourhood was seen too; the fill smooths over the rest.
    const keep = new Uint8Array(has.length);
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++) {
        if (!has[y * tw + x]) continue;
        let n = 0, all = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= tw || yy >= th) continue;
            all++;
            n += has[yy * tw + xx];
          }
        keep[y * tw + x] = n >= 0.6 * all ? 1 : 0;
      }
    has.set(keep);
    const seenMask = Uint8Array.from(has);
    let kept = 0;
    for (const v of seenMask) kept += v;
    fill(col, has, tw, th);
    const unseen = 1 - kept / seenMask.length;
    const plane = G.plane;
    jobs.push(async () => {
      let filled: PhotoWall['filled'] = unseen > 0 ? 'smooth' : 'none';
      if (inpaint && unseen >= INPAINT_FROM) {
        try {
          const gen = await museFill(scan.id, plane.id, col, seenMask, tw, th, plane.surface === 'walls' ? 'wall' : plane.surface, inpaint);
          if (gen) {
            composite(col, gen, seenMask, tw, th);
            filled = 'muse-image';
          }
        } catch {
          // Keep the smooth fill.
        }
      }
      const data = Buffer.alloc(tw * th * 4);
      for (let t = 0; t < tw * th; t++) {
        for (let c = 0; c < 3; c++) data[t * 4 + c] = Math.max(0, Math.min(255, Math.round(col[t * 3 + c])));
        data[t * 4 + 3] = 255;
      }
      const file = `${plane.id}.jpg`;
      await writeFile(join(scanDir(scan.id), 'walls', file), jpeg.encode({ data, width: tw, height: th }, 85).data);
      out.push({ id: plane.id, file, width: tw, height: th, seen: Math.round((100 * seen) / wsum.length) / 100, filled });
    });
  }
  // Muse Image calls in parallel, four at a time.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]();
    }),
  );
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Ask for the unseen texels (magenta in the image sent) to be painted; the answer is resized to the surface
 * and returned as RGB floats. Cached per input image, so rebuilding a room never pays twice.
 */
async function museFill(scanId: string, planeId: string, col: Float32Array, seen: Uint8Array, w: number, h: number, surface: 'wall' | 'floor' | 'ceiling', inpaint: Inpaint): Promise<Float32Array | null> {
  const png = new PNG({ width: w, height: h });
  for (let t = 0; t < w * h; t++) {
    const rgb = seen[t] ? [col[t * 3], col[t * 3 + 1], col[t * 3 + 2]] : [255, 0, 255];
    for (let c = 0; c < 3; c++) png.data[t * 4 + c] = Math.max(0, Math.min(255, Math.round(rgb[c])));
    png.data[t * 4 + 3] = 255;
  }
  const marked = PNG.sync.write(png);
  const key = createHash('sha256').update(config.meta.imageModel).update(marked).digest('hex').slice(0, 20);
  const cacheFile = join(scanDir(scanId), 'walls', `fill-${planeId}-${key}.img`);
  const answer = existsSync(cacheFile) ? await readFile(cacheFile) : await inpaint(marked, surface);
  if (!answer) return null;
  if (!existsSync(cacheFile)) await writeFile(cacheFile, answer);
  const img = answer[0] === 0x89 ? PNG.sync.read(answer) : jpeg.decode(answer, { useTArray: true, formatAsRGBA: true });
  // Resize to the surface (bilinear).
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.width - 1.001, Math.max(0, ((x + 0.5) * img.width) / w - 0.5));
      const fy = Math.min(img.height - 1.001, Math.max(0, ((y + 0.5) * img.height) / h - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      for (let c = 0; c < 3; c++) {
        const at = (yy: number, xx: number) => img.data[(yy * img.width + xx) * 4 + c];
        out[(y * w + x) * 3 + c] = at(y0, x0) * (1 - ax) * (1 - ay) + at(y0, x0 + 1) * ax * (1 - ay) + at(y0 + 1, x0) * (1 - ax) * ay + at(y0 + 1, x0 + 1) * ax * ay;
      }
    }
  return out;
}

/**
 * Take the generated colour only where nothing was seen, easing in over FEATHER texels from the edge of
 * what was seen (the smooth fill bridges the seam). Leftover magenta in the answer is ignored.
 */
export function composite(col: Float32Array, gen: Float32Array, seen: Uint8Array, w: number, h: number) {
  const FEATHER = 6;
  const dist = new Float32Array(w * h).fill(Infinity);
  let frontier: number[] = [];
  for (let t = 0; t < w * h; t++) if (seen[t]) (dist[t] = 0), frontier.push(t);
  for (let d = 1; d <= FEATHER && frontier.length; d++) {
    const next: number[] = [];
    for (const t of frontier) {
      const x = t % w, y = (t - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (dist[q] > d) (dist[q] = d), next.push(q);
      }
    }
    frontier = next;
  }
  for (let t = 0; t < w * h; t++) {
    if (seen[t]) continue;
    const r = gen[t * 3], g = gen[t * 3 + 1], b = gen[t * 3 + 2];
    if (r > 200 && b > 200 && g < 80) continue; // magenta left in: keep the smooth fill there
    const a = Math.min(1, dist[t] / FEATHER);
    for (let c = 0; c < 3; c++) col[t * 3 + c] = col[t * 3 + c] * (1 - a) + gen[t * 3 + c] * a;
  }
}

/**
 * Fill unseen texels smoothly (push-pull): average the seen texels down a pyramid of halving resolutions,
 * then fill each level's gaps from the level above, bilinearly, back up to full size.
 */
function fill(col: Float32Array, has: Uint8Array, w: number, h: number) {
  const levels: { c: Float32Array; m: Float32Array; w: number; h: number }[] = [];
  let c = Float32Array.from(col);
  let m = Float32Array.from(has);
  let lw = w, lh = h;
  levels.push({ c, m, w: lw, h: lh });
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, Math.ceil(lw / 2)), nh = Math.max(1, Math.ceil(lh / 2));
    const nc = new Float32Array(nw * nh * 3), nm = new Float32Array(nw * nh);
    for (let y = 0; y < lh; y++)
      for (let x = 0; x < lw; x++) {
        const k = y * lw + x;
        if (!m[k]) continue;
        const q = (y >> 1) * nw + (x >> 1);
        nm[q] += m[k];
        for (let i = 0; i < 3; i++) nc[q * 3 + i] += c[k * 3 + i] * m[k];
      }
    for (let q = 0; q < nw * nh; q++) if (nm[q]) for (let i = 0; i < 3; i++) nc[q * 3 + i] /= nm[q];
    for (let q = 0; q < nw * nh; q++) nm[q] = Math.min(1, nm[q]);
    c = nc;
    m = nm;
    lw = nw;
    lh = nh;
    levels.push({ c, m, w: lw, h: lh });
  }
  for (let L = levels.length - 2; L >= 0; L--) {
    const cur = levels[L], up = levels[L + 1];
    for (let y = 0; y < cur.h; y++)
      for (let x = 0; x < cur.w; x++) {
        const k = y * cur.w + x;
        if (cur.m[k]) continue;
        // Bilinear sample of the coarser level at this texel's centre.
        const fx = Math.min(up.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), fy = Math.min(up.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(up.w - 1, x0 + 1), y1 = Math.min(up.h - 1, y0 + 1);
        const ax = fx - x0, ay = fy - y0;
        for (let i = 0; i < 3; i++) {
          const at = (yy: number, xx: number) => up.c[(yy * up.w + xx) * 3 + i];
          cur.c[k * 3 + i] = at(y0, x0) * (1 - ax) * (1 - ay) + at(y0, x1) * ax * (1 - ay) + at(y1, x0) * (1 - ax) * ay + at(y1, x1) * ax * ay;
        }
        cur.m[k] = 1;
      }
  }
  col.set(levels[0].c);
}
