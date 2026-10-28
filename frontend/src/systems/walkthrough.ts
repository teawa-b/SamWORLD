/**
 * Camera + locomotion.
 * - Dollhouse, desktop: orbit camera around the plinth.
 * - Walk, desktop: drag to look, WASD/arrows to move.
 * - Walk, XR: left stick moves (head-relative), right stick snap-turns.
 * Walking collides with plan walls; doorways are open gaps.
 */
import { InputComponent, Vector3, createSystem, type World } from '@iwsdk/core';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { blockingSegments, distPointSegment, pointInPolygon, type Vec2 } from '../shared/index.js';
import { app } from '../state.js';
import { mounted } from './dollhouse.js';

const EYE_HEIGHT = 1.6;
const SPEED = 1.4;
const RADIUS = 0.22;
const SNAP_TURN = Math.PI / 6;

let segments: [Vec2, Vec2][] = [];

export function enterRoom(world: World, roomId: string): boolean {
  const scene = app.scene.value;
  const m = mounted(world);
  const room = scene?.structure.rooms.find((r) => r.id === roomId);
  if (!scene || !m || !room) return false;
  const level = scene.structure.levels.find((l) => l.id === room.levelId)!;
  const [cx, cz] = m.build.centre;
  app.mode.value = 'walk';
  app.walkLevelId.value = level.id;
  segments = blockingSegments(scene.structure, level.id).map(([a, b]) => [
    [a[0] - cx, a[1] - cz],
    [b[0] - cx, b[1] - cz],
  ]);
  world.player.position.set(room.spawnPoint[0] - cx, level.elevationMeters, room.spawnPoint[1] - cz);
  world.player.rotation.set(0, 0, 0);
  if (!app.inXR.value) {
    world.camera.position.set(0, EYE_HEIGHT, 0);
    // Face the room's longer dimension.
    const xs = room.polygonXZMeters.map((p) => p[0]);
    const zs = room.polygonXZMeters.map((p) => p[1]);
    look.yaw = Math.max(...xs) - Math.min(...xs) > Math.max(...zs) - Math.min(...zs) ? -Math.PI / 2 : Math.PI;
    look.pitch = 0;
  }
  return true;
}

/** Move to the room above/below that contains the stair opening. */
export function changeLevel(world: World, dir: 1 | -1): boolean {
  const scene = app.scene.value;
  if (!scene || !app.walkLevelId.value) return false;
  const cur = scene.structure.levels.find((l) => l.id === app.walkLevelId.value)!;
  const target = scene.structure.levels.find((l) => l.index === cur.index + dir);
  if (!target) return false;
  const upper = dir === 1 ? target : cur;
  const voids = upper.stairVoids;
  const rooms = scene.structure.rooms.filter((r) => r.levelId === target.id);
  const c: Vec2 | null = voids[0] ? [voids[0].reduce((a, p) => a + p[0], 0) / voids[0].length, voids[0].reduce((a, p) => a + p[1], 0) / voids[0].length] : null;
  const room = (c && rooms.find((r) => pointInPolygon(c, r.polygonXZMeters))) || rooms[0];
  return enterRoom(world, room.id);
}

export function exitRoom(world: World) {
  app.mode.value = 'dollhouse';
  app.walkLevelId.value = null;
  world.player.position.set(0, 0, 0);
  world.player.rotation.set(0, 0, 0);
  if (!app.inXR.value) resetOrbit(world);
}

const look = { yaw: 0, pitch: 0, dragging: false, lastX: 0, lastY: 0 };
const keys = new Set<string>();
let orbit: OrbitControls | null = null;

export function resetOrbit(world: World) {
  // Portrait screens need the camera further back to fit the house.
  const el = world.renderer.domElement;
  const k = el.clientWidth && el.clientHeight < el.clientWidth ? 1 : 1.7;
  world.camera.position.set(0.45 * k, 1.12 + 0.88 * k, -0.8 + 0.85 * k);
  world.camera.rotation.set(0, 0, 0);
  orbit?.target.set(0, 1.12, -0.8);
  orbit?.update();
}

export class WalkthroughSystem extends createSystem({}) {
  private v = new Vector3();
  private head = new Vector3();

  init() {
    const el = this.renderer.domElement;
    orbit = new OrbitControls(this.camera, el);
    orbit.enableDamping = true;
    orbit.minDistance = 0.25;
    orbit.maxDistance = 4;
    resetOrbit(this.world);

    const down = (e: PointerEvent) => {
      look.dragging = true;
      look.lastX = e.clientX;
      look.lastY = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (!look.dragging || app.mode.value !== 'walk') return;
      look.yaw -= (e.clientX - look.lastX) * 0.004;
      look.pitch = Math.max(-1.2, Math.min(1.2, look.pitch - (e.clientY - look.lastY) * 0.004));
      look.lastX = e.clientX;
      look.lastY = e.clientY;
    };
    const up = () => (look.dragging = false);
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
      keys.add(e.key.toLowerCase());
    };
    const ku = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => keys.clear());
    this.cleanupFuncs.push(() => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      orbit?.dispose();
    });
  }

  update(delta: number) {
    const walking = app.mode.value === 'walk';
    const xr = app.inXR.value;
    if (orbit) orbit.enabled = !walking && !xr;
    if (!walking) {
      if (!xr) orbit?.update();
      return;
    }

    let fwd = 0;
    let strafe = 0;
    let yaw = look.yaw;
    if (xr) {
      const left = this.input.xr.gamepads.left;
      const right = this.input.xr.gamepads.right;
      const a = left?.getAxesValues(InputComponent.Thumbstick);
      if (a) {
        fwd = -a.y;
        strafe = a.x;
      }
      this.player.head.getWorldPosition(this.head);
      const dir = this.player.head.getWorldDirection(this.v);
      // Head is a Group: getWorldDirection returns its +Z (backwards) axis.
      yaw = Math.atan2(dir.x, dir.z);
      const turn = right?.getAxesEnteringLeft(InputComponent.Thumbstick) ? 1 : right?.getAxesEnteringRight(InputComponent.Thumbstick) ? -1 : 0;
      if (turn) {
        // Rotate the rig about the head so the view pivots in place.
        const p = this.player.position;
        const dx = p.x - this.head.x;
        const dz = p.z - this.head.z;
        const c = Math.cos(turn * SNAP_TURN);
        const s = Math.sin(turn * SNAP_TURN);
        p.x = this.head.x + dx * c + dz * s;
        p.z = this.head.z - dx * s + dz * c;
        this.player.rotation.y += turn * SNAP_TURN;
      }
    } else {
      this.camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
      if (keys.has('w') || keys.has('arrowup')) fwd += 1;
      if (keys.has('s') || keys.has('arrowdown')) fwd -= 1;
      if (keys.has('d') || keys.has('arrowright')) strafe += 1;
      if (keys.has('a') || keys.has('arrowleft')) strafe -= 1;
      this.head.set(this.player.position.x, 0, this.player.position.z);
    }
    if (!fwd && !strafe) return;
    const len = Math.hypot(fwd, strafe);
    const step = (SPEED * delta) / Math.max(1, len);
    const dx = (-Math.sin(yaw) * fwd + Math.cos(yaw) * strafe) * step;
    const dz = (-Math.cos(yaw) * fwd - Math.sin(yaw) * strafe) * step;
    const from: Vec2 = [this.head.x, this.head.z];
    const to = resolveCollisions([from[0] + dx, from[1] + dz]);
    this.player.position.x += to[0] - from[0];
    this.player.position.z += to[1] - from[1];
  }
}

/** Push a circle out of every wall segment it overlaps (two passes). */
function resolveCollisions(p: Vec2): Vec2 {
  const q: Vec2 = [p[0], p[1]];
  for (let pass = 0; pass < 2; pass++) {
    for (const [a, b] of segments) {
      const { dist, t } = distPointSegment(q, a, b);
      if (dist >= RADIUS) continue;
      const cx = a[0] + (b[0] - a[0]) * t;
      const cz = a[1] + (b[1] - a[1]) * t;
      const nx = dist > 1e-6 ? (q[0] - cx) / dist : 0;
      const nz = dist > 1e-6 ? (q[1] - cz) / dist : 1;
      q[0] = cx + nx * RADIUS;
      q[1] = cz + nz * RADIUS;
    }
  }
  return q;
}
