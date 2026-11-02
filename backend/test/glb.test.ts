import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { shrinkGlb } from '../src/lib/glb.js';

/** A one-mesh GLB: positions, uint32 indices, and a 2048² PNG texture padded after IEND (as SAM 3D's are). */
function sampleGlb(): Buffer {
  const pos = Buffer.alloc(4 * 3 * 4);
  [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0].forEach((v, i) => pos.writeFloatLE(v, i * 4));
  const idx = Buffer.alloc(6 * 4);
  [0, 1, 2, 0, 2, 3].forEach((v, i) => idx.writeUInt32LE(v, i * 4));
  const img = new PNG({ width: 2048, height: 2048 });
  // Photo-like noise (a smooth gradient is smaller as PNG, and is rightly kept as PNG).
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) % 256);
  for (let i = 0; i < 2048 * 2048; i++) img.data.set([rnd(), rnd(), rnd(), 255], i * 4);
  const png = Buffer.concat([PNG.sync.write(img), Buffer.alloc(3)]);
  const views = [pos, idx, png];
  let at = 0;
  const bufferViews = views.map((v) => {
    const o = at;
    at += v.length + ((4 - (v.length % 4)) % 4);
    return { buffer: 0, byteOffset: o, byteLength: v.length };
  });
  const bin = Buffer.concat(views.flatMap((v) => [v, Buffer.alloc((4 - (v.length % 4)) % 4)]));
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5125, count: 6, type: 'SCALAR' },
    ],
    images: [{ bufferView: 2, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const chunk = (t: number, b: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(b.length, 0);
    h.writeUInt32LE(t, 4);
    return Buffer.concat([h, b]);
  };
  return Buffer.concat([head, chunk(0x4e4f534a, j), chunk(0x004e4942, bin)]);
}

function parse(glb: Buffer) {
  const jl = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jl).toString());
  const bin = glb.subarray(20 + jl + 8, 20 + jl + 8 + glb.readUInt32LE(20 + jl));
  const view = (i: number) => bin.subarray(json.bufferViews[i].byteOffset, json.bufferViews[i].byteOffset + json.bufferViews[i].byteLength);
  return { json, view, length: glb.readUInt32LE(8) };
}

describe('shrinkGlb', () => {
  it('shrinks the texture to JPEG and the indices to 16 bits, leaving the geometry untouched', () => {
    const before = sampleGlb();
    const after = shrinkGlb(before);
    const a = parse(after);
    const b = parse(before);
    expect(a.length).toBe(after.length);
    expect(after.length).toBeLessThan(before.length / 2);
    expect(a.json.images[0].mimeType).toBe('image/jpeg');
    expect(a.json.accessors[1].componentType).toBe(5123);
    expect([0, 1, 2, 3, 4, 5].map((i) => a.view(1).readUInt16LE(i * 2))).toEqual([0, 1, 2, 0, 2, 3]);
    expect(a.view(0).equals(b.view(0))).toBe(true);
    for (const v of a.json.bufferViews) expect(v.byteOffset % 4).toBe(0);
  });

  it('returns anything it does not understand unchanged', () => {
    const junk = Buffer.from('not a glb at all');
    expect(shrinkGlb(junk)).toBe(junk);
  });
});
