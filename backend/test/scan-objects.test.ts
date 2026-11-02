import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'walkin-objects-'));
process.env.MODEL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';

const { store } = await import('../src/store.js');
const { understandScan } = await import('../src/objects.js');
const { fitRoomShell, transformPointRowMajor, boxOfPoints, mergeDetections } = await import('../src/shared/index.js');

/** 4 × 3 × 2.4 m room (floor + walls) with a 1.0 × 0.8 × 0.5 m table block centred at x 1.5, z 1.4. */
function scene() {
  const pts: number[][] = [];
  const s = 0.05;
  for (let x = 0; x <= 4; x += s) for (let z = 0; z <= 3; z += s) pts.push([x, 0, z]);
  for (let y = 0; y <= 2.4; y += s) {
    for (let x = 0; x <= 4; x += s) pts.push([x, y, 0], [x, y, 3]);
    for (let z = 0; z <= 3; z += s) pts.push([0, y, z], [4, y, z]);
  }
  const [x0, x1, z0, z1, h] = [1, 2, 1, 1.8, 0.5];
  const t = 0.025;
  for (let x = x0; x <= x1 + 1e-9; x += t) for (let z = z0; z <= z1 + 1e-9; z += t) pts.push([x, h, z]);
  for (let y = 0; y <= h + 1e-9; y += t) {
    for (let x = x0; x <= x1 + 1e-9; x += t) pts.push([x, y, z0], [x, y, z1]);
    for (let z = z0; z <= z1 + 1e-9; z += t) pts.push([x0, y, z], [x1, y, z]);
  }
  return Float32Array.from(pts.flat());
}

// Camera at (2, 1.5, 2.9), tilted down 30°, looking towards -z (three.js convention).
const tilt = -Math.PI / 6;
const [c, sn] = [Math.cos(tilt), Math.sin(tilt)];
const camera = { pose: [1, 0, 0, 2, 0, c, -sn, 1.5, 0, sn, c, 2.9, 0, 0, 0, 1], intrinsics: [400, 400, 256, 192] as [number, number, number, number], width: 512, height: 384 };

/** Pixel rectangle around the table's projection, as a full-frame mask at twice the camera resolution (as uploaded). */
function tableMask(scale = 2) {
  const P = camera.pose;
  const R = [P[0], P[4], P[8], P[1], P[5], P[9], P[2], P[6], P[10]];
  let [l, t, r, b] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const x of [1, 2]) for (const y of [0, 0.5]) for (const z of [1, 1.8]) {
    const d = [x - P[3], y - P[7], z - P[11]];
    const xc = R[0] * d[0] + R[1] * d[1] + R[2] * d[2];
    const yc = R[3] * d[0] + R[4] * d[1] + R[5] * d[2];
    const zc = R[6] * d[0] + R[7] * d[1] + R[8] * d[2];
    const u = (400 * xc) / -zc + 256, v = 192 - (400 * yc) / -zc;
    [l, t, r, b] = [Math.min(l, u), Math.min(t, v), Math.max(r, u), Math.max(b, v)];
  }
  const W = 512 * scale, H = 384 * scale;
  const raster = new Uint8Array(W * H);
  for (let y = Math.floor(t * scale); y < Math.ceil(b * scale); y++) for (let x = Math.floor(l * scale); x < Math.ceil(r * scale); x++) raster[y * W + x] = 1;
  return { mask: { raster, width: W, height: H }, bbox: [l * scale, t * scale, r * scale, b * scale] as [number, number, number, number] };
}

const positions = scene();
const shell = fitRoomShell(positions, { cameras: [camera] });

describe('lifting SAM masks into 3D', () => {
  beforeAll(async () => {
    await store.load();
  });

  it('turns a table mask into a grounded box of the right size and place, and saves a crop', async () => {
    expect(shell.fallback).toBe(false);
    const id = 'scan-objtest';
    const dir = join(process.env.DATA_DIR!, 'scans', id);
    mkdirSync(dir, { recursive: true });
    const n = positions.length / 3;
    const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`);
    const body = Buffer.alloc(n * 15);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) body.writeFloatLE(positions[i * 3 + k], i * 15 + k * 4);
    writeFileSync(join(dir, 'cloud.ply'), Buffer.concat([head, body]));
    const png = new PNG({ width: 1024, height: 768 });
    png.data.fill(180);
    writeFileSync(join(dir, 'frame-000.png'), PNG.sync.write(png));
    const scan = {
      id, title: 't', createdAt: '', updatedAt: '', state: 'ready' as const, message: '', model: null, timings: {}, bounds: null,
      frames: [{ file: 'frame-000.png', bytes: 1, width: 1024, height: 768 }],
      cloud: { file: 'cloud.ply', points: n }, cameras: [camera], shell,
    };
    await store.put('scans', id, scan);
    const seen: string[] = [];
    await understandScan(scan, {
      listObjects: async () => ({ concepts: ['Coffee table', 'lamp', 'coffee table'], model: 'FAKE muse' }),
      segment: async (_url, size, concept) => {
        seen.push(concept);
        expect(size).toEqual({ width: 1024, height: 768 });
        return concept === 'coffee table' ? [{ score: 0.9, ...tableMask() }] : [];
      },
    });
    const s = store.get('scans', id)!;
    expect(seen.sort()).toEqual(['coffee table', 'lamp']);
    expect(s.objectsStatus?.state).toBe('done');
    expect(s.objects).toHaveLength(1);
    const o = s.objects![0];
    expect(o.name).toBe('coffee table');
    expect(o.crop).toBe('obj-1.jpg');
    // Table in the room frame: the shell centres the room, so compare against the transformed true centre.
    const truth = transformPointRowMajor(shell.alignment, [1.5, 0.25, 1.4]);
    expect(o.box.centre[0]).toBeCloseTo(truth[0], 1);
    expect(o.box.centre[2]).toBeCloseTo(truth[2], 1);
    expect(o.box.centre[1]).toBeCloseTo(0.25, 1);
    expect(o.box.size[1]).toBeCloseTo(0.5, 1);
    expect([o.box.size[0], o.box.size[2]].sort()).toEqual([expect.closeTo(0.8, 1), expect.closeTo(1, 1)]);
  });

  it('merges detections of one object across views and keeps separate copies apart', () => {
    const det = (label: string, pts: number[], frame = 0) => ({ label, score: 0.8, points: Uint32Array.from(pts), frame, edge: 0, area: 0.1, bbox: [0, 0, 1, 1] as [number, number, number, number] });
    const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
    const merged = mergeDetections([det('chair', range(0, 100)), det('Chair', range(60, 160), 1), det('chair', range(500, 600), 1), det('sofa', range(0, 100))]);
    expect(merged.map((m) => [m.label.toLowerCase(), m.points.length]).sort()).toEqual([['chair', 100], ['chair', 160], ['sofa', 100]]);
  });

  it('boxes a rotated object with its yaw', () => {
    const pts: [number, number, number][] = [];
    const a = Math.PI / 5;
    for (let u = -1; u <= 1; u += 0.05) for (let v = -0.3; v <= 0.3; v += 0.05) for (const y of [0, 0.9]) pts.push([u * Math.cos(a) - v * Math.sin(a), y, u * Math.sin(a) + v * Math.cos(a)]);
    const b = boxOfPoints(pts)!;
    expect(b.size[0]).toBeCloseTo(1.95, 1);
    expect(b.size[2]).toBeCloseTo(0.6, 1);
    // three.js: rotation.y = yaw maps local +x to (cos yaw, 0, -sin yaw) = the long axis (cos a, sin a) up to sign.
    expect(Math.abs(Math.cos(b.yaw) * Math.cos(a) - Math.sin(b.yaw) * Math.sin(a))).toBeCloseTo(1, 2);
  });
});
