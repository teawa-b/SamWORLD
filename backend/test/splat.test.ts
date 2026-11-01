import { describe, expect, it } from 'vitest';
import { parsePly } from '../src/shared/splat.js';

/** Build a binary Gaussian-splat PLY the way 3DGS / SAM 3D write it (subset of properties). */
function splatPly(points: { p: [number, number, number]; dc: [number, number, number]; opacityLogit: number }[]): ArrayBuffer {
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${points.length}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const h = new TextEncoder().encode(header);
  const out = new Uint8Array(h.length + points.length * props.length * 4);
  out.set(h);
  const dv = new DataView(out.buffer, h.length);
  points.forEach((pt, i) => {
    const vals = [...pt.p, 0, 0, 0, ...pt.dc, pt.opacityLogit, -4, -4, -4, 1, 0, 0, 0];
    vals.forEach((v, j) => dv.setFloat32((i * props.length + j) * 4, v, true));
  });
  return out.buffer;
}

describe('PLY reader', () => {
  it('reads splat centres and DC colours, dropping transparent splats', () => {
    const buf = splatPly([
      { p: [0, 1, 2], dc: [0, 0, 0], opacityLogit: 5 },
      { p: [3, 4, 5], dc: [1.7724, -1.7724, 0], opacityLogit: 5 },
      { p: [9, 9, 9], dc: [0, 0, 0], opacityLogit: -8 }, // ~0 opacity
    ]);
    const pc = parsePly(buf);
    expect(pc.isGaussianSplat).toBe(true);
    expect(pc.count).toBe(2);
    expect([...pc.positions]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pc.colors[0]).toBeCloseTo(0.5);
    expect(pc.colors[3]).toBeCloseTo(1, 2);
    expect(pc.colors[4]).toBeCloseTo(0, 2);
  });
  it('reads plain coloured point clouds and rejects junk', () => {
    const txt = 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n1 2 3 255 0 0\n';
    const pc = parsePly(new TextEncoder().encode(txt).buffer as ArrayBuffer);
    expect(pc.isGaussianSplat).toBe(false);
    expect([...pc.colors]).toEqual([1, 0, 0]);
    expect(() => parsePly(new TextEncoder().encode('hello').buffer as ArrayBuffer)).toThrow();
  });
});
