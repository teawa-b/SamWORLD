import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { flattenTransparentPng } from '../src/lib/image.js';

describe('flattenTransparentPng', () => {
  it('puts a transparent floor plan (black lines, clear background) on white', () => {
    const src = new PNG({ width: 2, height: 1 });
    src.data.set([0, 0, 0, 0, /* clear */ 0, 0, 0, 255 /* black line */]);
    const out = PNG.sync.read(flattenTransparentPng(PNG.sync.write(src)));
    expect([...out.data]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });

  it('leaves images without transparency untouched', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(flattenTransparentPng(jpeg)).toBe(jpeg);
    const opaque = PNG.sync.write(new PNG({ width: 1, height: 1 }), { colorType: 2 });
    expect(flattenTransparentPng(opaque)).toBe(opaque);
  });
});
