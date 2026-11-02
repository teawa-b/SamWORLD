import { describe, expect, it } from 'vitest';
import { fitRoomShell, transformPointRowMajor } from '../src/shared/room-shell.js';

/** A W × D × H box room (floor, walls, optional ceiling) plus a sofa-sized block, with noise. */
function room(W: number, D: number, H: number, opts: { ceiling?: boolean; missingWall?: boolean } = {}) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
  const pts: number[][] = [];
  const s = 0.05;
  for (let x = 0; x <= W; x += s) for (let z = 0; z <= D; z += s) {
    pts.push([x, 0, z]);
    if (opts.ceiling) pts.push([x, H, z]);
  }
  for (let y = 0; y <= H; y += s) {
    for (let x = 0; x <= W; x += s) {
      pts.push([x, y, 0]);
      if (!opts.missingWall) pts.push([x, y, D]);
    }
    for (let z = 0; z <= D; z += s) pts.push([0, y, z], [W, y, z]);
  }
  // Sofa: 2 × 0.9 × 0.8 m block against the x = 0 wall.
  for (let x = 0.5; x <= 2.5; x += s) for (let z = 0.1; z <= 1; z += s) pts.push([x, 0.8, z]);
  return pts.map((p) => [p[0] + rnd(), p[1] + rnd(), p[2] + rnd()]);
}

/** Tilt the cloud (phone not level), spin it and move it, as MapAnything's first-camera frame would. */
function scramble(pts: number[][], tilt: number, yaw: number, off: [number, number, number]) {
  const ct = Math.cos(tilt), st = Math.sin(tilt), cy = Math.cos(yaw), sy = Math.sin(yaw);
  return pts.map(([x, y, z]) => {
    const y1 = y * ct - z * st;
    const z1 = y * st + z * ct;
    return [x * cy + z1 * sy + off[0], y1 + off[1], -x * sy + z1 * cy + off[2]];
  });
}

const flat = (pts: number[][]) => Float32Array.from(pts.flat());

describe('fitRoomShell', () => {
  it('recovers a tilted, rotated, offset 4 × 3 × 2.5 m room with a ceiling', () => {
    const scan = scramble(room(4, 3, 2.5, { ceiling: true }), 0.12, 0.6, [1.3, -1.6, 2.2]);
    const s = fitRoomShell(flat(scan));
    const dims = [s.size.width, s.size.depth].sort((a, b) => a - b);
    expect(dims[0]).toBeCloseTo(3, 1);
    expect(dims[1]).toBeCloseTo(4, 1);
    expect(s.ceilingInferred).toBe(false);
    expect(s.size.height).toBeCloseTo(2.5, 1);
    expect(s.walls).toHaveLength(4);
    expect(s.walls.every((w) => !w.inferred)).toBe(true);
    expect(s.fallback).toBe(false);
    expect(s.confidence).toBe(1);
    // A floor corner of the original room lands on y = 0 at a corner of the fitted floor.
    const corner = transformPointRowMajor(s.alignment, scramble([[0, 0, 0]], 0.12, 0.6, [1.3, -1.6, 2.2])[0]);
    expect(corner[1]).toBeCloseTo(0, 1);
    expect(Math.abs(corner[0])).toBeCloseTo(s.size.width / 2, 1);
    expect(Math.abs(corner[2])).toBeCloseTo(s.size.depth / 2, 1);
  });

  it('infers an unfilmed ceiling and wall, and flags them', () => {
    const s = fitRoomShell(flat(room(5, 3.5, 2.4, { missingWall: true })));
    expect(s.ceilingInferred).toBe(true);
    expect(s.size.height).toBeGreaterThanOrEqual(2.35);
    expect(s.walls.filter((w) => w.inferred)).toHaveLength(1);
    expect(s.fallback).toBe(false);
    expect(s.confidence).toBeCloseTo(0.85, 2);
  });

  it('uses the cameras to find up when the cloud is upside down', () => {
    const pts = room(4, 4, 2.5).map(([x, y, z]) => [x, -y, -z]);
    // Camera rotated 180° about x: its up axis (2nd column) points down in this frame.
    const s = fitRoomShell(flat(pts), { cameras: [{ pose: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1] }] });
    expect(s.fallback).toBe(false);
    expect(s.size.height).toBeCloseTo(2.5, 1);
    const p = transformPointRowMajor(s.alignment, [2, -1, -2]); // 1 m above the floor in the original room
    expect(p[1]).toBeCloseTo(1, 1);
  });

  it('falls back on too few points', () => {
    const s = fitRoomShell(new Float32Array(30));
    expect(s.fallback).toBe(true);
    expect(s.walls).toHaveLength(0);
  });
});

describe('fitRoomShell with cameras', () => {
  // 4 × 3 m room, plus a 1 m wide alcove behind the z = 0 wall (to z = -1), and the x = 0 wall never filmed.
  const pts: number[][] = [];
  const s = 0.05;
  for (let x = 0; x <= 4; x += s) for (let z = 0; z <= 3; z += s) pts.push([x, 0, z]);
  for (let x = 3; x <= 4; x += s) for (let z = -1; z < 0; z += s) pts.push([x, 0, z]);
  for (let y = 0; y <= 2.4; y += s) {
    for (let x = 0; x <= 4; x += s) pts.push([x, y, 3]);
    for (let x = 0; x <= 3; x += s) pts.push([x, y, 0]);
    for (let x = 3; x <= 4; x += s) pts.push([x, y, -1]);
    for (let z = -1; z <= 0; z += s) pts.push([3, y, z]);
    for (let z = -1; z <= 3; z += s) pts.push([4, y, z]);
  }
  const cam = (x: number, z: number) => ({ pose: [1, 0, 0, x, 0, 1, 0, 1.5, 0, 0, 1, z, 0, 0, 0, 1] });
  const cameras = [cam(0.6, 1), cam(0.8, 2), cam(1.5, 1.5)];

  it('keeps the long wall over a short alcove behind it, and never puts a wall between the cameras', () => {
    const sh = fitRoomShell(flat(pts), { cameras });
    expect(sh.fallback).toBe(false);
    const inside = cameras.map((c) => transformPointRowMajor(sh.alignment, [c.pose[3], 1.5, c.pose[11]]));
    for (const p of inside) {
      expect(Math.abs(p[0])).toBeLessThan(sh.size.width / 2);
      expect(Math.abs(p[2])).toBeLessThan(sh.size.depth / 2);
    }
    // Depth along z: the z = 0 wall (3 m long) wins over the alcove's z = -1 wall (1 m long).
    const dims = [sh.size.width, sh.size.depth].sort();
    expect(dims.some((d) => Math.abs(d - 3) < 0.15)).toBe(true);
    expect(sh.walls.filter((w) => w.inferred)).toHaveLength(1);
  });
});

describe('inner walls', () => {
  it('finds the inner corner of an L-shaped room and ignores a bed under a ceiling cove', async () => {
    const { findInnerWalls } = await import('../src/shared/room-shell.js');
    // Room frame: 6 × 4 m box, 2.5 m ceiling. The top-left 2 × 2 m is outside the room, bounded by an inner
    // wall at x = -1 (z -2..0) and one at z = 0 (x -3..-1). A bed foot (0.5 m) at z = 1.2 under a cove (2.3 m+).
    const p: number[] = [];
    const s = 0.01;
    for (let y = 0; y <= 2.5; y += 0.02) {
      for (let z = -2; z <= 0; z += s) p.push(-1, y, z);
      for (let x = -3; x <= -1; x += s) p.push(x, y, 0);
      for (let x = 0.5; x <= 2; x += s) if (y < 0.5 || y > 2.3) p.push(x, y, 1.2);
    }
    const shell = { fallback: false, ceilingY: 2.5, size: { width: 6, depth: 4, height: 2.5 } } as never;
    const walls = findInnerWalls(Float32Array.from(p), shell, { cameras: [[1, 0.5], [0, -1], [1.5, -1.5]] });
    expect(walls).toHaveLength(2);
    const vertical = walls.find((w) => Math.abs(w.a[0] - w.b[0]) < 0.05)!;
    expect(vertical.a[0]).toBeCloseTo(-1, 1);
    expect(Math.abs(vertical.b[1] - vertical.a[1])).toBeGreaterThan(1.5);
  });
});
