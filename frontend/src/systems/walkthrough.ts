/**
 * Camera + locomotion.
 * - Dollhouse, desktop: orbit camera around the plinth.
 * - Walk, desktop: drag to look, WASD/arrows to move.
 * - Walk, XR: left stick moves (head-relative), right stick snap-turns.
 * Walking collides with plan walls; doorways are open gaps.
 */
import { InputComponent, Pressed, Vector3, createSystem, type World } from '@iwsdk/core';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { blockingSegments, computeViewpoints, distPointSegment, pointInPolygon, type Vec2 } from '../shared/index.js';
import { Hotspot } from '../components.js';
import { app } from '../state.js';
import { HOUSE_SCALE, mounted } from './dollhouse.js';

const EYE_HEIGHT = 1.6;
const SPEED = 1.4;
const RADIUS = 0.22;
const SNAP_TURN = Math.PI / 6;

let segments: [Vec2, Vec2][] = [];

/** In-flight glide to a look-around point (house-centred world coordinates). */
const glide = { active: false, t: 0, from: { x: 0, z: 0 }, to: { x: 0, z: 0 } };

export function enterRoom(world: World, roomId: string): boolean {
  const scene = app.scene.value;
  const m = mounted(world);
  const room = scene?.structure.rooms.find((r) => r.id === roomId);
  if (!scene || !m || !room) return false;
  const level = scene.structure.levels.find((l) => l.id === room.levelId)!;
  // Look slightly down so the floor markers (where you can go next) are in view.
  look.pitch = matchMedia('(max-width: 899px)').matches ? -0.38 : -0.22;
  placeOnLevel(world, level.id, room.spawnPoint);
  world.player.rotation.set(0, 0, 0);
  return true;
}

/** Put the player on a floor at a plan position (meters, plan coordinates). */
function placeOnLevel(world: World, levelId: string, at: Vec2) {
  const scene = app.scene.value!;
  const m = mounted(world)!;
  const level = scene.structure.levels.find((l) => l.id === levelId)!;
  const [cx, cz] = m.build.centre;
  glide.active = false;
  app.mode.value = 'walk';
  app.walkLevelId.value = level.id;
  segments = blockingSegments(scene.structure, level.id).map(([a, b]) => [
    [a[0] - cx, a[1] - cz],
    [b[0] - cx, b[1] - cz],
  ]);
  world.player.position.set(at[0] - cx, level.elevationMeters, at[1] - cz);
  if (!app.inXR.value) {
    // Face the middle of the room you arrive in (or the floor's centre).
    const room = scene.structure.rooms.find((r) => r.levelId === level.id && pointInPolygon(at, r.polygonXZMeters));
    const fb = scene.structure.footprintBounds;
    let tgt: Vec2 = room ? room.spawnPoint : [(fb.min[0] + fb.max[0]) / 2, (fb.min[1] + fb.max[1]) / 2];
    if (Math.hypot(tgt[0] - at[0], tgt[1] - at[1]) < 0.8) tgt = [(fb.min[0] + fb.max[0]) / 2, (fb.min[1] + fb.max[1]) / 2];
    if (Math.hypot(tgt[0] - at[0], tgt[1] - at[1]) > 0.3) look.yaw = Math.atan2(-(tgt[0] - at[0]), -(tgt[1] - at[1]));
    world.camera.position.set(0, EYE_HEIGHT, 0);
    world.camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
    setWalkFov(world, true);
  }
}

/** Phones in portrait see very little side to side; widen the view while walking. */
const DEFAULT_FOV = { value: 0 };
function setWalkFov(world: World, walking: boolean) {
  const cam = world.camera;
  if (!DEFAULT_FOV.value) DEFAULT_FOV.value = cam.fov;
  const portrait = window.innerHeight > window.innerWidth;
  cam.fov = walking && portrait ? 82 : DEFAULT_FOV.value;
  cam.updateProjectionMatrix();
}

/** Glide to a look-around point; stair points change floor. */
export function goToViewpoint(world: World, viewpointId: string) {
  const scene = app.scene.value;
  const m = mounted(world);
  if (!scene || !m || app.mode.value !== 'walk') return;
  const vp = computeViewpoints(scene.structure).find((v) => v.id === viewpointId);
  if (!vp) return;
  if (vp.kind === 'stairs' && vp.target) {
    placeOnLevel(world, vp.target.levelId, vp.target.position);
    return;
  }
  // In XR the head is offset from the rig; move the rig so the head lands on the point.
  const head = new Vector3();
  world.player.head.getWorldPosition(head);
  const offX = app.inXR.value ? head.x - world.player.position.x : 0;
  const offZ = app.inXR.value ? head.z - world.player.position.z : 0;
  glide.from = { x: world.player.position.x, z: world.player.position.z };
  glide.to = { x: vp.position[0] - m.build.centre[0] - offX, z: vp.position[1] - m.build.centre[1] - offZ };
  glide.t = 0;
  glide.active = true;
}

/** Move to the room above/below that contains the stair opening. */
export function changeLevel(world: World, dir: 1 | -1): boolean {
  const scene = app.scene.value;
  if (!scene || !app.walkLevelId.value) return false;
  const cur = scene.structure.levels.find((l) => l.id === app.walkLevelId.value)!;
  const target = scene.structure.levels.find((l) => l.index === cur.index + dir);
  if (!target) return false;
  const stair = computeViewpoints(scene.structure).find((v) => v.kind === 'stairs' && v.levelId === cur.id && v.target?.levelId === target.id);
  if (stair?.target) {
    placeOnLevel(world, target.id, stair.target.position);
    return true;
  }
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
  if (!app.inXR.value) {
    setWalkFov(world, false);
    resetOrbit(world);
  }
}

const look = { yaw: 0, pitch: 0, dragging: false, lastX: 0, lastY: 0, dragDist: 0 };
const keys = new Set<string>();
let orbit: OrbitControls | null = null;

export function resetOrbit(world: World) {
  // Portrait screens need the camera further back to fit the house.
  const el = world.renderer.domElement;
  const k = el.clientWidth && el.clientWidth / el.clientHeight > 0.85 ? 1 : 2.1;
  const m = mounted(world);
  // Fit the dollhouse: distance from its size on the plinth, seen from ~40° above at an angle.
  const span = m ? Math.max(m.build.size.x, m.build.size.z) * HOUSE_SCALE : 0.8;
  const d = Math.max(0.7, span * 1.45) * k;
  world.camera.position.set(d * 0.42, 1.05 + d * 0.62, -0.8 + d * 0.68);
  world.camera.rotation.set(0, 0, 0);
  orbit?.target.set(0, 1.05, -0.8);
  orbit?.update();
}

export class WalkthroughSystem extends createSystem({
  pressedHotspots: { required: [Hotspot, Pressed] },
}) {
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
      look.dragDist = 0;
      look.lastX = e.clientX;
      look.lastY = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (!look.dragging) return;
      look.dragDist += Math.abs(e.clientX - look.lastX) + Math.abs(e.clientY - look.lastY);
      if (app.mode.value !== 'walk') {
        look.lastX = e.clientX;
        look.lastY = e.clientY;
        return;
      }
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
    // A tap (not a drag) on a marker moves you there. Release fires when the
    // Pressed tag is removed; drags are for looking around.
    this.queries.pressedHotspots.subscribe('disqualify', (e) => {
      if (app.inXR.value || look.dragDist < 12) goToViewpoint(this.world, e.getValue(Hotspot, 'viewpointId') as string);
    });
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

    if (glide.active) {
      glide.t = Math.min(1, glide.t + delta / 0.6);
      const k = glide.t < 0.5 ? 2 * glide.t * glide.t : 1 - Math.pow(-2 * glide.t + 2, 2) / 2; // ease in-out
      this.player.position.x = glide.from.x + (glide.to.x - glide.from.x) * k;
      this.player.position.z = glide.from.z + (glide.to.z - glide.from.z) * k;
      if (glide.t >= 1) glide.active = false;
      if (!xr) this.camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
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
    // Sub-step so a slow frame (large delta) can't carry the walker through a wall.
    const from: Vec2 = [this.head.x, this.head.z];
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (RADIUS * 0.5)));
    let to: Vec2 = from;
    for (let i = 0; i < n; i++) to = resolveCollisions([to[0] + dx / n, to[1] + dz / n]);
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
