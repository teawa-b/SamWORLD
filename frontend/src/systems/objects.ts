/**
 * Furniture interaction on desktop: click to select, then move / turn / hide /
 * remove from the panel or keyboard. Edits change the 3D object at once and
 * are saved through the scene-corrections API (no rebuild, no AI).
 *
 * Also swaps SAM 3D output into the scene: GLB as a mesh; a Gaussian-splat PLY
 * as a point cloud (it is not a mesh, and the UI says so).
 */
import type { World } from '@iwsdk/core';
import { Box3, Box3Helper, BufferGeometry, Color, Float32BufferAttribute, Group, Object3D, Points, PointsMaterial, Raycaster, Vector2, Vector3 } from 'three';
import { AssetManager } from '@iwsdk/core';
import { parsePly, type SceneManifest, type SceneObject } from '../shared/index.js';
import { absoluteApiUrl } from '../api.js';
import { app } from '../state.js';
import { mounted } from './dollhouse.js';

const ray = new Raycaster();
const ndc = new Vector2();
let helper: Box3Helper | null = null;

export function objectGroup(world: World, id: string): Group | null {
  const m = mounted(world);
  if (!m) return null;
  for (const lb of m.build.levels) for (const c of lb.furniture.children) if (c.userData.objectId === id) return c as Group;
  return null;
}

export function sceneObject(id: string | null): SceneObject | null {
  return (id && app.scene.value?.objects.find((o) => o.id === id)) || null;
}

/** Click (not drag) on the canvas → select the nearest piece of furniture under the pointer. */
export function installObjectPicking(world: World) {
  const el = world.renderer.domElement;
  let down: { x: number; y: number } | null = null;
  el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  el.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || app.inXR.value) return;
    down = null;
    const m = mounted(world);
    if (!m || app.furnitureHidden.value) return;
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, world.camera);
    const targets = m.build.levels.flatMap((l) => l.furniture.children.filter((c) => c.visible));
    const hit = ray.intersectObjects(targets, true)[0];
    let o: Object3D | null = hit?.object ?? null;
    while (o && !o.userData.objectId) o = o.parent;
    if (o) app.selectedObjectId.value = o.userData.objectId as string;
    else if (app.mode.value === 'dollhouse') app.selectedObjectId.value = null;
  });

  // Keep the selection outline and hidden set in sync.
  app.selectedObjectId.subscribe(() => outline(world));
  app.hiddenObjectIds.subscribe((ids) => {
    const m = mounted(world);
    if (!m) return;
    for (const lb of m.build.levels) for (const c of lb.furniture.children) c.visible = !ids.includes(c.userData.objectId);
    outline(world);
  });
  app.scene.subscribe(() => {
    app.selectedObjectId.value = null;
    app.objectEdits.value = {};
  });
}

function outline(world: World) {
  helper?.removeFromParent();
  helper?.dispose();
  helper = null;
  const g = app.selectedObjectId.value ? objectGroup(world, app.selectedObjectId.value) : null;
  if (!g || !g.visible || !g.parent) return;
  // Box in the furniture group's own frame so it follows moves and floor lifts.
  const inv = g.parent.matrixWorld.clone().invert();
  g.updateMatrixWorld(true);
  const box = new Box3().setFromObject(g).applyMatrix4(inv);
  box.expandByScalar(0.04);
  helper = new Box3Helper(box, new Color(0x2f6fed));
  helper.name = 'SelectionOutline';
  g.parent.add(helper);
}

/** Move (plan metres) and/or turn (radians) the selected object, locally. Saved by saveObjectEdits. */
export function nudgeObject(world: World, id: string, dx: number, dz: number, dRot = 0) {
  const g = objectGroup(world, id);
  if (!g) return;
  g.position.x += dx;
  g.position.z += dz;
  g.rotation.y += dRot;
  app.objectEdits.value = { ...app.objectEdits.value, [id]: { x: round(g.position.x), z: round(g.position.z), rotationY: round(g.rotation.y) } };
  outline(world);
}

export function resetObject(world: World, id: string) {
  const o = sceneObject(id);
  const g = objectGroup(world, id);
  if (!o || !g) return;
  g.position.x = o.positionXYZ[0];
  g.position.z = o.positionXYZ[2];
  g.rotation.y = o.rotationY;
  const { [id]: _drop, ...rest } = app.objectEdits.value;
  app.objectEdits.value = rest;
  outline(world);
}

export function removeObjectLocally(world: World, id: string) {
  objectGroup(world, id)?.removeFromParent();
  if (app.selectedObjectId.value === id) app.selectedObjectId.value = null;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// SAM 3D assets
// ---------------------------------------------------------------------------

/** Replace proxies with SAM 3D output, fitted into the estimated footprint. Failures keep the proxy. */
export async function swapInReconstructedObjects(scene: SceneManifest, groups: Object3D[]) {
  for (const obj of scene.objects.filter((o) => o.reconstructionMethod === 'sam3d' && o.modelUrl)) {
    const proxy = groups.find((c) => c.userData.objectId === obj.id);
    if (!proxy) continue;
    try {
      const url = absoluteApiUrl(obj.modelUrl!);
      const splat = obj.modelFormat === 'ply-splat' || (!obj.modelFormat && /\.ply$/i.test(obj.modelUrl!));
      let model: Object3D;
      if (splat || obj.modelFormat === 'ply-mesh') {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const pc = parsePly(await res.arrayBuffer());
        if (!pc.count) throw new Error('PLY has no visible points');
        const geo = new BufferGeometry();
        geo.setAttribute('position', new Float32BufferAttribute(pc.positions, 3));
        geo.setAttribute('color', new Float32BufferAttribute(pc.colors, 3));
        model = new Points(geo, new PointsMaterial({ size: 2.5, sizeAttenuation: false, vertexColors: true }));
        model.userData.splat = true;
      } else {
        model = (await AssetManager.loadGLTF(url, `sam3d-${obj.id}`)).scene.clone(true);
      }
      const holder = new Group();
      holder.add(model);
      const size = new Box3().setFromObject(holder).getSize(new Vector3());
      const [w, h, d] = obj.sizeM;
      const s = Math.min(w / (size.x || 1), h / (size.y || 1), d / (size.z || 1));
      model.scale.setScalar(s);
      const box = new Box3().setFromObject(holder);
      // Proxies are positioned at their footprint centre with y at the floor.
      model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      proxy.clear();
      proxy.add(holder);
    } catch (e) {
      console.warn(`SAM 3D asset for ${obj.id} failed to load; keeping the proxy`, e);
      proxy.userData.sam3dLoadError = (e as Error).message;
    }
  }
}
