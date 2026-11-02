import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'walkin-photo-'));
process.env.LOG_LEVEL = 'silent';
const { photoWalls, composite, dropSpecks } = await import('../src/photo-walls.js');
const { fitRoomShell, shellPlanes, transformPointRowMajor } = await import('../src/shared/index.js');

describe('photo walls', () => {
  it('projects a frame onto the wall it faces, not mirrored', async () => {
    // 4 × 3 × 2.4 m room; camera at its middle (2, 1.5, 1.5) looking down −z at the z = 0 wall.
    const pts: number[] = [];
    const s = 0.05;
    for (let x = 0; x <= 4; x += s) for (let z = 0; z <= 3; z += s) pts.push(x, 0, z);
    for (let y = 0; y <= 2.4; y += s) {
      for (let x = 0; x <= 4; x += s) pts.push(x, y, 0, x, y, 3);
      for (let z = 0; z <= 3; z += s) pts.push(0, y, z, 4, y, z);
    }
    const positions = Float32Array.from(pts);
    const camera = { pose: [1, 0, 0, 2, 0, 1, 0, 1.5, 0, 0, 1, 1.5, 0, 0, 0, 1], intrinsics: [300, 300, 256, 192] as [number, number, number, number], width: 512, height: 384 };
    const shell = fitRoomShell(positions, { cameras: [camera] });
    expect(shell.fallback).toBe(false);

    const id = 'scan-photo';
    const dir = join(process.env.DATA_DIR!, 'scans', id);
    mkdirSync(dir, { recursive: true });
    const n = positions.length / 3;
    const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`);
    const body = Buffer.alloc(n * 15);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) body.writeFloatLE(positions[i * 3 + k], i * 15 + k * 4);
    writeFileSync(join(dir, 'cloud.ply'), Buffer.concat([head, body]));
    // The frame: left half red, right half blue.
    const data = Buffer.alloc(512 * 384 * 4);
    for (let y = 0; y < 384; y++) for (let x = 0; x < 512; x++) data.set(x < 256 ? [220, 30, 30, 255] : [30, 30, 220, 255], (y * 512 + x) * 4);
    writeFileSync(join(dir, 'frame-000.jpg'), jpeg.encode({ data, width: 512, height: 384 }, 95).data);
    const scan = {
      id, title: 't', createdAt: '', updatedAt: '', state: 'ready' as const, message: '', model: null, timings: {}, bounds: null,
      frames: [{ file: 'frame-000.jpg', bytes: 1, width: 512, height: 384 }], cloud: { file: 'cloud.ply', points: n }, cameras: [camera], shell,
    };
    const walls = await photoWalls(scan, { inpaint: null });

    // The wall the camera faces: the plane whose normal points back at the camera (room frame).
    const eye = transformPointRowMajor(shell.alignment, [2, 1.5, 1.5]);
    const facing = shellPlanes(shell)
      .filter((p) => p.surface === 'walls')
      .map((p) => ({ p, d: (eye[0] - p.centre[0]) * p.normal[0] + (eye[2] - p.centre[2]) * p.normal[2] }))
      .sort((a, b) => a.d - b.d)
      .find((x) => x.d > 0 && Math.abs(Math.abs(x.p.normal[2]) - 1) < 0.01 && x.p.centre[2] < eye[2])!.p;
    const w = walls.find((x) => x.id === facing.id)!;
    expect(w).toBeTruthy();
    const img = jpeg.decode(readFileSync(join(dir, 'walls', w.file)), { useTArray: true });
    const px = (u: number, v: number) => [...img.data.subarray((Math.floor(v * img.height) * img.width + Math.floor(u * img.width)) * 4, (Math.floor(v * img.height) * img.width + Math.floor(u * img.width)) * 4 + 3)];
    // Seen from inside, the wall's left is the frame's left (red), its right the frame's right (blue).
    const left = px(0.35, 0.5), right = px(0.65, 0.5);
    expect(left[0]).toBeGreaterThan(left[2] + 100);
    expect(right[2]).toBeGreaterThan(right[0] + 100);
  });
});

describe('filling the unseen part', () => {
  it('takes generated colour only where nothing was seen, easing in from the edge, and ignores leftover magenta', () => {
    // 20 × 1 strip: texels 0–9 seen (grey 100), 10–19 unseen; the smooth fill left them grey too.
    const w = 20, h = 1;
    const col = new Float32Array(w * 3).fill(100);
    const seen = Uint8Array.from({ length: w }, (_, i) => (i < 10 ? 1 : 0));
    const gen = new Float32Array(w * 3);
    for (let i = 0; i < w; i++) gen.set(i === 19 ? [255, 0, 255] : [0, 200, 0], i * 3);
    composite(col, gen, seen, w, h);
    expect([...col.subarray(0, 30)].every((v) => v === 100)).toBe(true); // seen: untouched
    expect(col[10 * 3 + 1]).toBeGreaterThan(100); // first unseen: partly green
    expect(col[10 * 3 + 1]).toBeLessThan(200);
    expect(col[17 * 3 + 1]).toBeCloseTo(200); // well inside: green
    expect(col[19 * 3]).toBe(100); // magenta answer ignored
  });
});

describe('dark specks', () => {
  it('drops small dark specks on a light wall but keeps a long dark line', () => {
    const w = 60, h = 40;
    const col = new Float32Array(w * h * 3).fill(220);
    const has = new Uint8Array(w * h).fill(1);
    const paint = (x: number, y: number) => col.fill(30, (y * w + x) * 3, (y * w + x) * 3 + 3);
    for (let y = 10; y < 13; y++) for (let x = 10; x < 13; x++) paint(x, y); // 3 × 3 speck
    for (let x = 5; x < 55; x++) paint(x, 30); // a picture frame's edge: 50 texels long
    dropSpecks(col, has, w, h);
    expect(has[11 * w + 11]).toBe(0);
    expect(has[30 * w + 30]).toBe(1);
    expect(has[5 * w + 5]).toBe(1);
  });
});
