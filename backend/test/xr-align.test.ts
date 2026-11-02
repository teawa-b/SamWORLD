import { describe, expect, it } from 'vitest';
import { applyRig, filmingStart, rigForAlignment } from '../src/shared/index.js';

describe('1:1 headset alignment', () => {
  it('moves the rig so the head lands exactly on the filming start', () => {
    const target = { x: 1.2, z: -0.7, yaw: 2.1 };
    for (const head of [{ x: 0, z: 0, yaw: 0 }, { x: 0.4, z: -1.3, yaw: -0.8 }, { x: -2, z: 0.5, yaw: 3 }]) {
      const rig = rigForAlignment(head, target);
      const got = applyRig(rig, head);
      expect(got.x).toBeCloseTo(target.x, 6);
      expect(got.z).toBeCloseTo(target.z, 6);
      expect(Math.cos(got.yaw - target.yaw)).toBeCloseTo(1, 6);
    }
  });

  it('reads where filming began from the first camera, in the room frame', () => {
    // Camera at (2, 1.4, 1) in scan space looking down −x (turned +90° about y); room frame = scan shifted by (−2, 0, −1).
    const pose = [0, 0, 1, 2, 0, 1, 0, 1.4, -1, 0, 0, 1, 0, 0, 0, 1];
    const alignment = [1, 0, 0, -2, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 1];
    const s = filmingStart([{ pose, intrinsics: [500, 500, 256, 192], height: 384 }], alignment)!;
    expect(s.x).toBeCloseTo(0);
    expect(s.z).toBeCloseTo(0);
    expect(s.eye).toBeCloseTo(1.4);
    // Forward (−x) → yaw with (−sin, −cos) = (−1, 0) → yaw = π/2.
    expect(s.yaw).toBeCloseTo(Math.PI / 2);
    expect(s.vfov).toBeCloseTo((2 * Math.atan(192 / 500) * 180) / Math.PI, 3);
  });
});
