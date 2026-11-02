import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'walkin-photo-'));
process.env.LOG_LEVEL = 'silent';
const { photoWalls } = await import('../src/photo-walls.js');
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
    const walls = await photoWalls(scan);

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
