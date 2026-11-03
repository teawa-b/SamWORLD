/**
 * Dollhouse interactions: the house follows a grabbable plinth (two-hand
 * rotate/scale in XR), floors lift via one-hand handles or buttons, walls pull
 * out non-destructively, and every change animates back on reset.
 */
import {
  AssetManager,
  Box3,
  CylinderGeometry,
  Group,
  IBLGradient,
  DomeGradient,
  Mesh,
  MeshStandardMaterial,
  OneHandGrabbable,
  PointLight,
  Pressed,
  RayInteractable,
  SphereGeometry,
  TwoHandsGrabbable,
  Vector3,
  Grabbed,
  createSystem,
  type Entity,
  type World,
} from '@iwsdk/core';
import type { SceneManifest } from '../shared/index.js';
import { Hotspot, LevelHandle, Plinth, PropertyRoot, RoomFloor, WallPanel } from '../components.js';
import { buildHouse, buildRoom, evidenceColor, type HouseBuild } from '../scene/build.js';
import { app, EXPLODE_LIFT_M, toggleWall } from '../state.js';
import { mediaUrl } from '../api.js';
import { swapInReconstructedObjects } from './objects.js';

export const HOUSE_SCALE = 0.06;
const PLINTH_HOME = new Vector3(0, 0.98, -0.8);
const WALL_PULL_M = 1.6;
const ROOF_LIFT_M = 2.5;

export interface Mounted {
  build: HouseBuild;
  rootEntity: Entity;
  plinth: Entity;
  handles: Entity[];
  roofHandle: Entity | null;
  viewingRoom: Entity;
  lights: PointLight[];
  wallHome: Map<string, Vector3>;
  /** Every entity created for this house, children after parents. */
  entities: Entity[];
}

const g = (world: World) => world.globals as { mounted?: Mounted };
export const mounted = (world: World) => g(world).mounted;

export function mountHouse(world: World, scene: SceneManifest) {
  unmountHouse(world);
  const entities: Entity[] = [];
  const track = (e: Entity) => (entities.push(e), e);
  const build = buildHouse(scene, {
    mediaUrl: (id) => {
      const m = scene.media.find((x) => x.id === id);
      return m ? mediaUrl(m) : null;
    },
  });

  const viewingRoom = track(world.createTransformEntity(buildRoom()));

  const plinthMesh = new Mesh(new CylinderGeometry(0.36, 0.36, 0.025, 48), new MeshStandardMaterial({ color: 0xd9d4cc, roughness: 0.6 }));
  plinthMesh.position.y = 0.0125;
  const plinthGroup = new Group();
  plinthGroup.name = 'Plinth';
  plinthGroup.add(plinthMesh);
  plinthGroup.position.copy(PLINTH_HOME);
  const plinth = track(world.createTransformEntity(plinthGroup));
  plinth.addComponent(Plinth);
  plinth.addComponent(TwoHandsGrabbable, { rotate: true, translate: true, scale: true, scaleMin: [0.4, 0.4, 0.4], scaleMax: [4, 4, 4] });

  // Start on the plinth so the first frame never shows the house full size.
  build.root.position.copy(PLINTH_HOME).y += 0.026;
  build.root.scale.setScalar(HOUSE_SCALE);

  // Entity hierarchy mirrors the spec: PropertyRoot > BuildingShell > Floor_n > walls/rooms.
  const rootEntity = track(world.createTransformEntity(build.root));
  rootEntity.addComponent(PropertyRoot);
  const shell = build.root.children[0];
  const shellEntity = track(world.createTransformEntity(shell, rootEntity));
  for (const lb of build.levels) {
    const levelEntity = track(world.createTransformEntity(lb.group, shellEntity));
    for (const r of lb.rooms) {
      const e = track(world.createTransformEntity(r.floor, levelEntity));
      e.addComponent(RoomFloor, { roomId: r.room.id });
      e.addComponent(RayInteractable);
    }
    for (const w of lb.walls) {
      const e = track(world.createTransformEntity(w.group, levelEntity));
      e.addComponent(WallPanel, { wallId: w.wall.id });
      e.addComponent(RayInteractable);
    }
    for (const h of lb.hotspots) {
      const e = track(world.createTransformEntity(h.marker, levelEntity));
      e.addComponent(Hotspot, { viewpointId: h.viewpoint.id });
      e.addComponent(RayInteractable);
    }
  }
  if (build.roof) track(world.createTransformEntity(build.roof, shellEntity));

  // Lift handles to the side of the house (house-local meters).
  const handles: Entity[] = [];
  const knobMat = new MeshStandardMaterial({ color: 0x2f7de1, roughness: 0.4, emissive: 0x0b2a55 });
  const sideX = build.size.x / 2 + 1.2;
  for (const lb of build.levels.filter((l) => l.index > 0)) {
    const level = scene.structure.levels.find((l) => l.id === lb.levelId)!;
    const knob = new Mesh(new SphereGeometry(0.55, 20, 14), knobMat);
    knob.name = `LiftHandle_${lb.index}`;
    const y = level.elevationMeters + 0.6;
    knob.position.set(sideX, y, 0);
    const e = track(world.createTransformEntity(knob, rootEntity));
    e.addComponent(LevelHandle, { levelIndex: lb.index, baseY: y });
    e.addComponent(OneHandGrabbable, { rotate: false, translate: true, translateMin: [sideX, y, 0], translateMax: [sideX, y + 8, 0] });
    handles.push(e);
  }
  let roofHandle: Entity | null = null;
  if (build.roof) {
    const knob = new Mesh(new SphereGeometry(0.55, 20, 14), new MeshStandardMaterial({ color: 0xc0573e, roughness: 0.4 }));
    knob.name = 'RoofHandle';
    const y = build.topElevation + 0.6;
    knob.position.set(sideX, y, 0);
    roofHandle = track(world.createTransformEntity(knob, rootEntity));
    roofHandle.addComponent(LevelHandle, { levelIndex: 999, baseY: y });
    roofHandle.addComponent(OneHandGrabbable, { rotate: false, translate: true, translateMin: [sideX, y, 0], translateMax: [sideX, y + 10, 0] });
  }

  // Night lights: one warm light per room near the ceiling (off by day).
  const lights: PointLight[] = [];
  for (const lb of build.levels) {
    for (const r of lb.rooms) {
      const l = new PointLight(0xffd7a0, 0, 0, 2);
      const elev = scene.structure.levels.find((x) => x.id === lb.levelId)!.elevationMeters;
      l.position.set(r.room.spawnPoint[0], elev + r.room.ceilingHeightMeters - 0.35, r.room.spawnPoint[1]);
      l.userData = { levelId: lb.levelId };
      lb.group.add(l);
      lights.push(l);
    }
  }

  const wallHome = new Map<string, Vector3>();
  for (const lb of build.levels) for (const w of lb.walls) wallHome.set(w.wall.id, w.group.position.clone());

  g(world).mounted = { build, rootEntity, plinth, handles, roofHandle, viewingRoom, lights, wallHome, entities };
  void swapInReconstructedObjects(scene, build.levels.flatMap((l) => l.furniture.children));
  app.levelLift.value = scene.structure.levels.map(() => 0);
}

export function unmountHouse(world: World) {
  const m = mounted(world);
  if (!m) return;
  // Children first: disposing a parent entity would re-attach its child
  // entities to the scene root and leave a full-size copy of the house behind.
  for (const e of [...m.entities].reverse()) e.dispose();
  g(world).mounted = undefined;
}

export class DollhouseSystem extends createSystem({
  roomPressed: { required: [RoomFloor, Pressed] },
  wallPressed: { required: [WallPanel, Pressed] },
  grabbedHandles: { required: [LevelHandle, Grabbed] },
}) {
  private lift: number[] = [];
  private roofLift = 0;
  private tmp = new Vector3();

  init() {
    this.queries.roomPressed.subscribe('qualify', (e) => {
      app.selectedRoomId.value = e.getValue(RoomFloor, 'roomId') as string;
    });
    this.queries.wallPressed.subscribe('qualify', (e) => {
      if (app.mode.value !== 'dollhouse') return;
      if (app.wallMode.value || app.inXR.value) toggleWall(e.getValue(WallPanel, 'wallId') as string);
    });
    // Release a lift handle → snap to "home" or "lifted".
    this.queries.grabbedHandles.subscribe('disqualify', (e) => {
      const idx = e.getValue(LevelHandle, 'levelIndex') as number;
      const base = e.getValue(LevelHandle, 'baseY') as number;
      const raised = (e.object3D!.position.y - base) - this.cumulativeBelow(idx);
      if (idx === 999) {
        app.roofHidden.value = false;
        this.roofTarget = raised > ROOF_LIFT_M / 2 ? ROOF_LIFT_M : 0;
        return;
      }
      const lifts = [...app.levelLift.value];
      lifts[idx] = raised > EXPLODE_LIFT_M / 2 ? EXPLODE_LIFT_M : 0;
      app.levelLift.value = lifts;
    });
    this.cleanupFuncs.push(app.resetTick.subscribe(() => (this.roofTarget = 0)));
    this.cleanupFuncs.push(
      app.evidenceView.subscribe((on) => {
        const m = mounted(this.world);
        if (!m) return;
        for (const lb of m.build.levels) {
          for (const r of lb.rooms) {
            const mat = (r.floor.material as MeshStandardMaterial[])[0];
            mat.color.copy(on ? evidenceColor(r.room) : mat.userData.baseColor);
          }
        }
      }),
    );
    this.cleanupFuncs.push(app.night.subscribe((night) => this.applyLighting(night)));
  }

  private roofTarget = 0;

  /** Sum of lifts applied to levels strictly below `idx` (they carry idx up). */
  private cumulativeBelow(idx: number): number {
    let s = 0;
    for (let i = 1; i < Math.min(idx, this.lift.length); i++) s += this.lift[i] ?? 0;
    return s;
  }

  private applyLighting(night: boolean) {
    const root = this.world.activeLevel.value;
    if (root.hasComponent(IBLGradient)) {
      root.setValue(IBLGradient, 'intensity', night ? 0.12 : 1);
      root.setValue(IBLGradient, '_needsUpdate', true);
    }
    if (root.hasComponent(DomeGradient)) {
      root.getVectorView(DomeGradient, 'sky').set(night ? [0.02, 0.03, 0.08, 1] : [0.29, 0.25, 0.22, 1]);
      root.getVectorView(DomeGradient, 'equator').set(night ? [0.06, 0.07, 0.12, 1] : [0.62, 0.56, 0.5, 1]);
      root.getVectorView(DomeGradient, 'ground').set(night ? [0.03, 0.03, 0.04, 1] : [0.8, 0.75, 0.69, 1]);
      root.setValue(DomeGradient, '_needsUpdate', true);
    }
  }

  update(delta: number) {
    const m = mounted(this.world);
    if (!m) return;
    const k = 1 - Math.exp(-delta * 8); // frame-rate independent easing
    const root = m.build.root;
    const walking = app.mode.value === 'walk';

    // House follows the plinth in dollhouse mode; 1:1 at the origin when walking.
    m.plinth.object3D!.visible = !walking;
    m.viewingRoom.object3D!.visible = !walking;
    if (!walking) {
      const p = m.plinth.object3D!;
      root.position.copy(p.position).add(this.tmp.set(0, 0.026 * p.scale.y, 0));
      root.quaternion.copy(p.quaternion);
      root.scale.copy(p.scale).multiplyScalar(HOUSE_SCALE);
    } else {
      root.position.set(0, 0, 0);
      root.quaternion.identity();
      root.scale.setScalar(1);
    }

    // Level lifts: grabbed handles drive their level directly.
    const targets = walking ? app.levelLift.value.map(() => 0) : app.levelLift.value;
    if (this.lift.length !== targets.length) this.lift = targets.map(() => 0);
    const grabbed = new Map<number, Entity>();
    for (const e of this.queries.grabbedHandles.entities) grabbed.set(e.getValue(LevelHandle, 'levelIndex') as number, e);
    for (let i = 1; i < this.lift.length; i++) {
      const h = grabbed.get(i);
      if (h) {
        const base = h.getValue(LevelHandle, 'baseY') as number;
        this.lift[i] = Math.max(0, h.object3D!.position.y - base - this.cumulativeBelow(i));
      } else {
        this.lift[i] += ((targets[i] ?? 0) - this.lift[i]) * k;
      }
    }
    let acc = 0;
    for (const lb of m.build.levels) {
      if (lb.index > 0) acc += this.lift[lb.index] ?? 0;
      lb.group.position.y = acc;
      lb.furniture.visible = !app.furnitureHidden.value;
      lb.labels.visible = !walking;
    }
    for (const h of m.handles) {
      const idx = h.getValue(LevelHandle, 'levelIndex') as number;
      h.object3D!.visible = !walking;
      if (!grabbed.has(idx)) h.object3D!.position.y = (h.getValue(LevelHandle, 'baseY') as number) + this.cumulativeBelow(idx) + (this.lift[idx] ?? 0);
    }
    if (m.build.roof) {
      const rh = grabbed.get(999);
      if (rh) this.roofLift = Math.max(0, rh.object3D!.position.y - (rh.getValue(LevelHandle, 'baseY') as number) - acc);
      else this.roofLift += ((walking ? 0 : this.roofTarget) - this.roofLift) * k;
      m.build.roof.position.y = acc + this.roofLift;
      m.build.roof.visible = walking || !app.roofHidden.value;
      if (m.roofHandle) {
        m.roofHandle.object3D!.visible = !walking && !app.roofHidden.value;
        if (!rh) m.roofHandle.object3D!.position.y = (m.roofHandle.getValue(LevelHandle, 'baseY') as number) + acc + this.roofLift;
      }
    }

    // Walls: pulled walls slide outward; "hide walls" hides all of them.
    const pulled = new Set(app.pulledWalls.value);
    for (const lb of m.build.levels) {
      for (const w of lb.walls) {
        const home = m.wallHome.get(w.wall.id)!;
        const out = !walking && pulled.has(w.wall.id) ? WALL_PULL_M : 0;
        const target = this.tmp.copy(w.outward).multiplyScalar(out).add(home);
        w.group.position.lerp(target, k);
        w.group.visible = walking || !app.wallsHidden.value;
      }
    }

    // Look-around markers: only while walking, only on the current floor, and
    // not the one you are standing on.
    const walkLevel = app.walkLevelId.peek();
    const px = this.world.player.position.x + m.build.centre[0];
    const pz = this.world.player.position.z + m.build.centre[1];
    for (const lb of m.build.levels) {
      for (const h of lb.hotspots) {
        const here = Math.hypot(h.viewpoint.position[0] - px, h.viewpoint.position[1] - pz) < 0.45;
        h.marker.visible = walking && lb.levelId === walkLevel && !here;
      }
    }

    // Night lights scale with the dollhouse so brightness looks consistent.
    const s = root.scale.x;
    const night = app.night.value;
    for (const l of m.lights) {
      const levelOk = !walking || l.userData.levelId === app.walkLevelId.value;
      l.intensity = night && levelOk ? 4 * s * s : 0;
      l.distance = 7 * s;
    }
  }
}
