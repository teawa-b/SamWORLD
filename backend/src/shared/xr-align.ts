/**
 * Roomshift 1:1 in a headset: line the virtual room up with the real one. The scan knows where the phone
 * was when filming began; standing on that spot facing the same way, the headset's head pose is mapped onto
 * it by moving the XR origin (the player rig), so every real wall, floor and piece of furniture sits where its
 * virtual twin is. Floor height needs nothing: the room frame's floor is y = 0, as is WebXR's local-floor.
 *
 * Poses on the floor plane use three.js conventions: `yaw` is rotation.y, so forward is (-sin yaw, -cos yaw).
 */
import { transformPointRowMajor } from './room-shell.js';

export interface FloorPose {
  x: number;
  z: number;
  yaw: number;
}

/**
 * The rig (XR origin) pose that puts a head seen at `head` in the rig's own space onto `target` in the room:
 * world = rig · head, so rig.yaw = target.yaw − head.yaw and rig.position = target − R(rig.yaw)·head.
 */
export function rigForAlignment(head: FloorPose, target: FloorPose): FloorPose {
  const yaw = target.yaw - head.yaw;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // three.js rotation.y: x' = x·cos + z·sin, z' = −x·sin + z·cos.
  return { x: target.x - (head.x * c + head.z * s), z: target.z - (-head.x * s + head.z * c), yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)) };
}

/** Where a head at `head` in rig space ends up in the room for a rig at `rig` (the inverse check). */
export function applyRig(rig: FloorPose, head: FloorPose): FloorPose {
  const c = Math.cos(rig.yaw), s = Math.sin(rig.yaw);
  const yaw = rig.yaw + head.yaw;
  return { x: rig.x + head.x * c + head.z * s, z: rig.z - head.x * s + head.z * c, yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)) };
}

/**
 * Where filming began, in the room frame: the first camera's position on the floor, its heading, its height
 * (≈ the phone's height, a stand-in for eye height) and its vertical field of view in degrees.
 */
export function filmingStart(
  cameras: { pose: number[]; intrinsics: [number, number, number, number]; height: number }[],
  alignment: number[],
): (FloorPose & { eye: number; vfov: number }) | null {
  const cam = cameras[0];
  if (!cam || cam.pose.length !== 16) return null;
  const p = transformPointRowMajor(alignment, [cam.pose[3], cam.pose[7], cam.pose[11]]);
  // Camera forward is its −z column; rotate it (no translation) into the room frame.
  const f = [-cam.pose[2], -cam.pose[6], -cam.pose[10]];
  const fr = [0, 1, 2].map((r) => alignment[r * 4] * f[0] + alignment[r * 4 + 1] * f[1] + alignment[r * 4 + 2] * f[2]);
  if (Math.hypot(fr[0], fr[2]) < 1e-6) return null;
  const vfov = (2 * Math.atan(cam.height / 2 / cam.intrinsics[1]) * 180) / Math.PI;
  return { x: p[0], z: p[2], yaw: Math.atan2(-fr[0], -fr[2]), eye: Math.min(2, Math.max(1.1, p[1])), vfov };
}
