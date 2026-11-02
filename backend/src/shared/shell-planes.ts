/**
 * The room shell's flat surfaces (floor, ceiling, every wall and inner wall) as planes with a texture layout,
 * matching how the viewer builds them: a three.js PlaneGeometry whose texture runs along `right` (u, left to
 * right as seen from inside the room) and `up` (v, bottom to top). The backend paints photos into exactly
 * these rectangles, so a texture made for `wall-2` lands on the viewer's wall 2 the right way up.
 */
import type { RoomShell } from './room-shell.js';

type V3 = [number, number, number];

export interface ShellPlane {
  /** 'floor', 'ceiling', 'wall-<i>' (outer walls in shell order) or an inner wall's id. */
  id: string;
  surface: 'floor' | 'ceiling' | 'walls';
  centre: V3;
  /** Unit vectors of the texture's u (right) and v (up) axes, and the side the plane faces. */
  right: V3;
  up: V3;
  normal: V3;
  width: number;
  height: number;
  /** Inner walls are seen from both sides. */
  twoSided: boolean;
}

/** Stable id for an inner wall: its axis and position. */
export const innerWallId = (w: { a: [number, number]; b: [number, number] }) =>
  Math.abs(w.a[0] - w.b[0]) < Math.abs(w.a[1] - w.b[1]) ? `inner-x${w.a[0].toFixed(2)}` : `inner-z${w.a[1].toFixed(2)}`;

export function shellPlanes(shell: RoomShell): ShellPlane[] {
  if (shell.fallback) return [];
  const W = shell.size.width, D = shell.size.depth, H = shell.ceilingY;
  const out: ShellPlane[] = [
    // PlaneGeometry turned −90° about x: local +y → world −z.
    { id: 'floor', surface: 'floor', centre: [0, 0, 0], right: [1, 0, 0], up: [0, 0, -1], normal: [0, 1, 0], width: W, height: D, twoSided: false },
    // Turned +90° about x: local +y → world +z.
    { id: 'ceiling', surface: 'ceiling', centre: [0, H, 0], right: [1, 0, 0], up: [0, 0, 1], normal: [0, -1, 0], width: W, height: D, twoSided: false },
  ];
  const wall = (id: string, a: [number, number], b: [number, number], theta: number, twoSided: boolean): ShellPlane => ({
    id,
    surface: 'walls',
    centre: [(a[0] + b[0]) / 2, H / 2, (a[1] + b[1]) / 2],
    // rotation.y = θ turns local +x to (cos θ, 0, −sin θ) and local +z (the face) to (sin θ, 0, cos θ).
    right: [Math.cos(theta), 0, -Math.sin(theta)],
    up: [0, 1, 0],
    normal: [Math.sin(theta), 0, Math.cos(theta)],
    width: Math.hypot(b[0] - a[0], b[1] - a[1]),
    height: H,
    twoSided,
  });
  shell.walls.forEach((w, i) => out.push(wall(`wall-${i}`, w.a, w.b, Math.atan2(w.normal[0], w.normal[1]), false)));
  for (const w of shell.inner ?? []) out.push(wall(innerWallId(w), w.a, w.b, Math.atan2(-(w.b[1] - w.a[1]), w.b[0] - w.a[0]), true));
  return out;
}

/** Room-frame point of texel (u, v) ∈ [0, 1]² of a plane. */
export function planePoint(p: ShellPlane, u: number, v: number): V3 {
  const du = (u - 0.5) * p.width, dv = (v - 0.5) * p.height;
  return [p.centre[0] + p.right[0] * du + p.up[0] * dv, p.centre[1] + p.right[1] * du + p.up[1] * dv, p.centre[2] + p.right[2] * du + p.up[2] * dv];
}
