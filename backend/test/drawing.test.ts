import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { drawingScore } from '../src/lib/drawing.js';

/** A noisy, colourful "photo" (gradient + noise), like a real room shot. */
function photoLike(): Buffer {
  const p = new PNG({ width: 320, height: 240 });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < 240; y++)
    for (let x = 0; x < 320; x++) {
      const i = (y * 320 + x) * 4;
      p.data[i] = 150 + (x / 320) * 80 + rnd() * 30;
      p.data[i + 1] = 110 + (y / 240) * 60 + rnd() * 30;
      p.data[i + 2] = 70 + rnd() * 40;
      p.data[i + 3] = 255;
    }
  return PNG.sync.write(p);
}

describe('floor-plan drawing detection', () => {
  it('recognises the demo floor plans as drawings', () => {
    for (const f of ['plan-ground.png', 'plan-first.png']) expect(drawingScore(readFileSync(new URL(`../fixtures/demo-house/${f}`, import.meta.url)))?.plan).toBe(true);
  });
  it('does not mistake a textured, colourful photo for a plan', () => {
    expect(drawingScore(photoLike())?.plan).toBe(false);
  });
  it('returns null for something that is not an image', () => {
    expect(drawingScore(Buffer.from('not an image at all'))).toBeNull();
  });
});
