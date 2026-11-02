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
