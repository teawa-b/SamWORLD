import { describe, expect, it } from 'vitest';
import { slots } from '../src/restyle.js';

describe('slots', () => {
  it('runs at most n jobs at once and all of them in the end', async () => {
    const run = slots(3);
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5 + (i % 3) * 5));
          active--;
          done.push(i);
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('frees the slot when a job fails', async () => {
    const run = slots(1);
    await expect(run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await run(async () => 42)).toBe(42);
  });
});
