/**
 * Roomshift viewer scene (DETAIL.md step 6): the scanned room in the room frame (floor y = 0, centred, walls on
 * the x/z axes, metres), so the viewer's origin is the middle of the real room, 1:1 for VR.
 *
 *  - The point cloud is split into floor / ceiling / walls / "stuff" (furniture) buckets.
 *  - The fitted shell (floor, ceiling, four walls) is built as planes facing into the room, so from outside
 *    the near walls cull away (dollhouse view) and from inside you see every surface.
 *  - Before any paint, each shell plane wears a "base coat": the video projected onto it (photo walls, made
 *    by the backend) or, until those exist, its own scan points rasterised with the holes filled, so the room
 *    reads as solid surfaces in their real colours, not floating dots.
 *  - Clean view (always in a headset): no scan points at all, only surfaces, pictures and 3D models.
 *  - When a surface's new texture arrives, the paint spreads across it from where you are (a growing sphere
 *    in the shader with a glowing edge), then that surface's scan points fade away.
 *  - Objects found by SAM 3.1 are shown as outlined boxes with their names. When a world restyles one, its
 *    SAM 3D model grows into that box (turned to face the way the real piece faced the camera) and the
 *    piece's scan points inside the box disappear.
 */
import {
  AssetManager,
  Box3,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Color,
  EdgesGeometry,
  Float32BufferAttribute,
  FogExp2,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  MeshStandardMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  TextureLoader,
  Vector3,
  createSystem,
  type Entity,
  type Texture,
  type World,
} from '@iwsdk/core';
import { decodeCloud, frontFace, innerWallId, insideBox, isEncodedCloud, parsePly, transformPointRowMajor, type ObjectBox, type RoomShell } from '../shared/index.js';

export type SurfaceId = 'walls' | 'floor' | 'ceiling';
type Bucket = SurfaceId | 'stuff';

export interface PaintSpec {
  id: SurfaceId;
  url: string;
  tileMetres: number;
  colorHex: string;
}

interface Surface {
  meshes: Mesh[];
  mat: MeshStandardMaterial;
  reveal: { value: number };
  origin: { value: Vector3 };
  /** Animation: reveal radius target and speed (m/s); points fade once it's done. */
  target: number;
  painted: string | null;
}

/** An object found in the scan (backend ScanObject). */
export interface RoomObject {
  id: string;
  name: string;
  box: ObjectBox;
  /** rotation.y that turns a model's front (+z) towards where the real piece was photographed from. */
  facing?: number;
  /** 'surface': flat on a wall, shown as a picture laid on it. */
  kind?: 'furniture' | 'surface';
}

const TOL = 0.1;
/** Base-coat texel size (metres) and how far behind the paint planes it sits. */
const BASE_TEXEL = 0.02;
const BASE_OFFSET = 0.012;
const OBJ_COLOR = 0x7fd4ff;
const OBJ_HIGHLIGHT = 0xffc857;

const live = new Set<RoomScene>();

/** Advances every room's paint animation (also runs inside XR, where window rAF does not). */
export class RoomshiftSystem extends createSystem({}) {
  update(delta: number) {
    for (const r of live) r.tick(delta);
  }
}

export class RoomScene {
  private group = new Group();
  private entity: Entity | null = null;
  private points = new Map<Bucket, Points>();
  private surfaces = new Map<SurfaceId, Surface>();
  private outline: LineSegments | null = null;
  private base: Mesh[] = [];
  /** Surfaces whose base coat stands in for their scan points (the points fade; furniture points stay). */
  private coated = new Set<SurfaceId>();
  private hemi = new HemisphereLight(0xffffff, 0x444444, 0);
  private loader = new TextureLoader();
  private textures = new Map<string, Promise<Texture>>();
  private prevFog: unknown = undefined;
  private objects = new Map<string, { root: Group; lines: LineSegments; label: Sprite }>();
  private objectKey = '';
  /** SAM 3D models placed in object boxes, by object id, with the model URL they show. */
  private models = new Map<string, { root: Group; url: string; grow: number }>();
  /** Scan points of the furniture, kept so pieces can be cut out when their model arrives. */
  private stuff: { p: Float32Array; c: Float32Array } | null = null;
  /** Points that belong to no found object (clutter, inner walls): fade out once a world is painted. */
  private loose: Points | null = null;
  private roomObjects: RoomObject[] = [];
  private objectsShown = true;
  /** Plane id → URL of its photo texture. */
  private photoWalls: Record<string, string> = {};
  private clean = false;
  private cleanNow = false;
  private passthrough = false;
  private savedBackground: { bg: unknown; fog: unknown } | null = null;
  shell: RoomShell | null = null;

  constructor(private world: World) {
    live.add(this);
  }

  /** Build the room from the scan's cloud (compact RSC1 or PLY) and fitted shell. */
  load(cloud: ArrayBuffer, shell: RoomShell | null | undefined, photoWalls: Record<string, string> = {}) {
    this.photoWalls = photoWalls;
    this.clear();
    this.group = new Group();
    this.group.name = 'RoomshiftRoom';
    this.group.add(this.hemi);
    this.shell = shell ?? null;
    const usable = !!shell && !shell.fallback && shell.walls.length === 4;
    const pc = isEncodedCloud(cloud) ? decodeCloud(cloud) : parsePly(cloud, { maxPoints: 1_200_000 });
    const A = shell?.alignment ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const W = shell?.size.width ?? 0;
    const D = shell?.size.depth ?? 0;
    const H = shell?.ceilingY ?? 0;
    const buckets: Record<Bucket, { p: number[]; c: number[] }> = { floor: { p: [], c: [] }, ceiling: { p: [], c: [] }, walls: { p: [], c: [] }, stuff: { p: [], c: [] } };
    for (let i = 0; i < pc.count; i++) {
      const q = transformPointRowMajor(A, [pc.positions[i * 3], pc.positions[i * 3 + 1], pc.positions[i * 3 + 2]]);
      let b: Bucket = 'stuff';
      if (usable) {
        const dx = W / 2 - Math.abs(q[0]);
        const dz = D / 2 - Math.abs(q[2]);
        if (q[1] < TOL) b = 'floor';
        else if (q[1] > H - TOL) b = 'ceiling';
        else if (dx < TOL || dz < TOL || nearInner(shell!, q)) b = 'walls';
      }
      buckets[b].p.push(q[0], q[1], q[2]);
      buckets[b].c.push(pc.colors[i * 3], pc.colors[i * 3 + 1], pc.colors[i * 3 + 2]);
    }
    this.stuff = { p: Float32Array.from(buckets.stuff.p), c: Float32Array.from(buckets.stuff.c) };
    for (const [k, v] of Object.entries(buckets) as [Bucket, { p: number[]; c: number[] }][]) {
      if (!v.p.length) continue;
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(v.p, 3));
      geo.setAttribute('color', new Float32BufferAttribute(v.c, 3));
      const pts = new Points(geo, new PointsMaterial({ size: 0.02, vertexColors: true, transparent: true, opacity: 1, depthWrite: true }));
      pts.name = `ScanPoints_${k}`;
      this.points.set(k, pts);
      this.group.add(pts);
    }
    if (usable) {
      this.buildShell(W, D, H);
      this.buildBaseCoat(buckets);
    }
    this.entity = this.world.createTransformEntity(this.group);
  }

  /** Paint a surface with a new texture (no-op if it already shows this one). */
  async paint(spec: PaintSpec, from: Vector3) {
    const s = this.surfaces.get(spec.id);
    if (!s || s.painted === spec.url) return;
    s.painted = spec.url;
    let tex = this.textures.get(spec.url);
    if (!tex) {
      tex = this.loader.loadAsync(spec.url).then((t) => {
        t.wrapS = t.wrapT = RepeatWrapping;
        t.colorSpace = SRGBColorSpace;
        t.anisotropy = 8;
        return t;
      });
      this.textures.set(spec.url, tex);
    }
    const t = (await tex).clone();
    if (s.painted !== spec.url) return; // superseded while loading
    t.needsUpdate = true;
    // Planes have 0..1 UVs; repeat the texture once per `tileMetres` of real surface.
    const sz = this.surfaceSize(spec.id);
    t.repeat.set(Math.max(1, sz[0] / spec.tileMetres), Math.max(1, sz[1] / spec.tileMetres));
    if (spec.id === 'walls') {
      // Walls differ in length: give each its own repeat via a per-mesh texture clone.
      for (const m of s.meshes) {
        const mt = t.clone();
        mt.needsUpdate = true;
        mt.repeat.set(Math.max(1, (m.userData.length as number) / spec.tileMetres), Math.max(1, sz[1] / spec.tileMetres));
        (m.material as MeshStandardMaterial).map = mt;
        (m.material as MeshStandardMaterial).color.set(0xffffff);
        (m.material as MeshStandardMaterial).needsUpdate = true;
      }
    } else {
      s.mat.map = t;
      s.mat.color.set(0xffffff);
      s.mat.needsUpdate = true;
    }
    s.origin.value.copy(from);
    s.reveal.value = 0;
    s.target = this.maxDistance(from) + 0.5;
  }

  /** Colour wash before the texture lands (instant feedback once the plan is ready). */
  mood(light: { colorHex: string; intensity: number } | null, fogHex: string | null) {
    if (!light) {
      this.hemi.intensity = 0;
      if (this.prevFog !== undefined) this.world.scene.fog = this.prevFog as never;
      return;
    }
    this.hemi.color.set(light.colorHex);
    this.hemi.groundColor.set(new Color(light.colorHex).multiplyScalar(0.35));
    this.hemi.intensity = 0.6 * light.intensity;
    if (fogHex) {
      if (this.prevFog === undefined) this.prevFog = this.world.scene.fog;
      this.world.scene.fog = new FogExp2(fogHex, 0.035);
    }
  }

  /** Back to the scan as filmed. */
  reset() {
    for (const s of this.surfaces.values()) {
      s.painted = null;
      s.reveal.value = 0;
      s.target = 0;
    }
    for (const [k, p] of this.points) {
      const on = !this.coated.has(k as SurfaceId);
      (p.material as PointsMaterial).opacity = on ? 1 : 0;
      p.visible = on;
    }
    if (this.outline) this.outline.visible = true;
    this.mood(null, null);
  }

  /** Called every frame. */
  tick(dt: number) {
    for (const m of this.models.values()) {
      if (m.grow >= 1 || !m.root.parent) continue;
      m.grow = Math.min(1, m.grow + dt * 1.4);
      m.root.scale.setScalar(Math.max(0.001, 1 - Math.pow(1 - m.grow, 3)));
    }
    for (const [id, s] of this.surfaces) {
      if (s.reveal.value < s.target) {
        s.reveal.value = Math.min(s.target, s.reveal.value + dt * Math.max(1.6, s.target / 2.2));
      }
      // Fade this surface's scan points once its paint has spread.
      const pts = this.points.get(id);
      if (pts) {
        const m = pts.material as PointsMaterial;
        const goal = this.coated.has(id) || (s.painted && s.reveal.value >= s.target * 0.6) ? 0 : 1;
        m.opacity += (goal - m.opacity) * Math.min(1, dt * 3);
        pts.visible = m.opacity > 0.02 && !this.cleanNow;
      }
    }
    const anyPaint = [...this.surfaces.values()].some((s) => s.painted);
    if (this.outline) this.outline.visible = !anyPaint;
    if (this.loose && !this.passthrough) {
      const m = this.loose.material as PointsMaterial;
      m.transparent = true;
      m.opacity += ((anyPaint ? 0 : 1) - m.opacity) * Math.min(1, dt * 2);
      this.loose.visible = m.opacity > 0.02 && !this.cleanNow;
    }
  }

  /** Show the scan's objects as outlined boxes (no-op when the list hasn't changed). */
  setObjects(list: RoomObject[]) {
    const key = JSON.stringify(list.map((o) => [o.id, o.name, o.box]));
    if (key === this.objectKey) return;
    // Different objects: models placed for the old ones may sit in the wrong slots.
    if (this.objectKey) this.clearModels();
    this.objectKey = key;
    this.clearObjects();
    this.roomObjects = list;
    this.cutStuff();
    for (const o of list) {
      const root = new Group();
      root.name = `Object_${o.id}`;
      root.position.set(...o.box.centre);
      root.rotation.y = o.box.yaw;
      const lines = new LineSegments(new EdgesGeometry(new BoxGeometry(...o.box.size)), new LineBasicMaterial({ color: OBJ_COLOR, transparent: true, opacity: 0.85, depthTest: false }));
      lines.renderOrder = 10;
      const label = nameSprite(o.name);
      label.position.y = o.box.size[1] / 2 + 0.14;
      root.add(lines, label);
      this.group.add(root);
      this.objects.set(o.id, { root, lines, label });
    }
  }

  /**
   * Show a SAM 3D model in place of a scanned object: fitted inside its measured box (uniform scale), its
   * front turned to the real piece's facing (snapped to the box's sides), standing on the box's floor.
   */
  async placeModel(id: string, url: string) {
    const o = this.roomObjects.find((x) => x.id === id);
    if (!o || this.models.get(id)?.url === url) return;
    this.removeModel(id);
    const slot = { root: new Group(), url, grow: 0 };
    this.models.set(id, slot);
    const gltf = await AssetManager.loadGLTF(url, `roomshift-${id}-${url}`);
    if (this.models.get(id) !== slot) return; // replaced or cleared while loading
    const model: Object3D = gltf.scene.clone(true);
    // Turn the model inside the box frame: its front towards the camera, to the nearest side of the box.
    const turn = Math.round(((o.facing ?? o.box.yaw) - o.box.yaw) / (Math.PI / 2)) * (Math.PI / 2);
    const inner = new Group();
    inner.rotation.y = turn;
    inner.add(model);
    const fit = new Group();
    fit.add(inner);
    const size = new Box3().setFromObject(fit).getSize(new Vector3());
    const [w, h, d] = o.box.size;
    const s = Math.min(w / (size.x || 1), h / (size.y || 1), d / (size.z || 1));
    inner.scale.setScalar(s);
    const b = new Box3().setFromObject(fit);
    inner.position.set(-(b.min.x + b.max.x) / 2, -h / 2 - b.min.y, -(b.min.z + b.max.z) / 2);
    slot.root.add(fit);
    slot.root.position.set(...o.box.centre);
    slot.root.rotation.y = o.box.yaw;
    slot.root.scale.setScalar(0.001);
    slot.root.name = `Model_${id}`;
    this.group.add(slot.root);
    this.cutStuff();
  }

  /** Show a flat thing (door, window, picture) as an image laid on its wall, exactly over the real one. */
  async placeSurface(id: string, url: string) {
    const o = this.roomObjects.find((x) => x.id === id);
    if (!o || this.models.get(id)?.url === url) return;
    const dir = o.facing ?? 0;
    const face = frontFace(o.box, [o.box.centre[0] + Math.sin(dir), o.box.centre[2] + Math.cos(dir)]);
    if (!face) return;
    this.removeModel(id);
    const slot = { root: new Group(), url, grow: 0 };
    this.models.set(id, slot);
    let tex = this.textures.get(url);
    if (!tex) {
      tex = this.loader.loadAsync(url).then((t) => ((t.colorSpace = SRGBColorSpace), t));
      this.textures.set(url, tex);
    }
    const t = await tex;
    if (this.models.get(id) !== slot) return;
    const m = new Mesh(new PlaneGeometry(face.width, face.height), new MeshStandardMaterial({ map: t, roughness: 0.75, metalness: 0 }));
    m.rotation.y = Math.atan2(face.normal[0], face.normal[1]);
    const thin = Math.min(o.box.size[0], o.box.size[2]);
    slot.root.position.set(o.box.centre[0] + face.normal[0] * (thin / 2 + 0.008), o.box.centre[1], o.box.centre[2] + face.normal[1] * (thin / 2 + 0.008));
    slot.root.add(m);
    slot.root.scale.setScalar(0.001);
    slot.root.name = `Surface_${id}`;
    this.group.add(slot.root);
    this.cutStuff();
  }

  /** Back to the scanned piece. */
  removeModel(id: string) {
    const m = this.models.get(id);
    if (!m) return;
    m.root.removeFromParent();
    this.models.delete(id);
    this.cutStuff();
  }

  clearModels() {
    for (const id of [...this.models.keys()]) this.removeModel(id);
  }

  /**
   * Split the furniture points: inside a box that now shows a model → dropped; inside another found object →
   * kept; in no object at all → `loose` (clutter, inner walls), which fades out in a painted world.
   */
  private cutStuff() {
    const pts = this.points.get('stuff');
    if (!pts || !this.stuff) return;
    const shown = this.roomObjects.filter((o) => this.models.get(o.id)?.root.parent).map((o) => o.box);
    const found = this.roomObjects.map((o) => o.box);
    const { p, c } = this.stuff;
    const keep: number[][] = [[], []];
    const loose: number[][] = [[], []];
    for (let i = 0; i < p.length; i += 3) {
      const q = [p[i], p[i + 1], p[i + 2]];
      if (shown.some((b) => insideBox(b, q, 0.03))) continue;
      const to = !found.length || found.some((b) => insideBox(b, q, 0.05)) ? keep : loose;
      to[0].push(q[0], q[1], q[2]);
      to[1].push(c[i], c[i + 1], c[i + 2]);
    }
    pts.geometry.setAttribute('position', new Float32BufferAttribute(keep[0], 3));
    pts.geometry.setAttribute('color', new Float32BufferAttribute(keep[1], 3));
    pts.geometry.computeBoundingSphere();
    if (!this.loose) {
      this.loose = new Points(new BufferGeometry(), (pts.material as PointsMaterial).clone());
      this.loose.name = 'ScanPoints_loose';
      this.group.add(this.loose);
    }
    this.loose.geometry.setAttribute('position', new Float32BufferAttribute(loose[0], 3));
    this.loose.geometry.setAttribute('color', new Float32BufferAttribute(loose[1], 3));
    this.loose.geometry.computeBoundingSphere();
  }

  /**
   * AR passthrough: the real room shows through, so hide everything that stands in for it (scan points, the
   * base coat, outlines, labels, fog and the sky): only the painted walls and new furniture are drawn over it.
   */
  setPassthrough(on: boolean) {
    for (const p of this.points.values()) p.visible = on ? false : true;
    if (this.loose) this.loose.visible = !on;
    for (const b of this.base) b.visible = !on;
    if (this.outline) this.outline.visible = !on;
    for (const o of this.objects.values()) o.root.visible = !on && this.objectsShown;
    this.passthrough = on;
    // Transparent where nothing is drawn, so the headset's camera view shows through.
    this.world.renderer.setClearAlpha(on ? 0 : 1);
    if (on) {
      this.savedBackground ??= { bg: this.world.scene.background, fog: this.world.scene.fog };
      this.world.scene.background = null;
      this.world.scene.fog = null;
    } else if (this.savedBackground) {
      this.world.scene.background = this.savedBackground.bg as never;
      this.world.scene.fog = this.savedBackground.fog as never;
      this.savedBackground = null;
    }
  }

  /** In a headset the outlined boxes, labels and scan points are clutter; they come back on leaving. */
  setHeadset(on: boolean) {
    for (const o of this.objects.values()) o.root.visible = !on && this.objectsShown;
    this.setClean(on || this.clean, false);
  }

  /** Clean view: no scan points, only the surfaces, pictures on the walls and 3D furniture. */
  setClean(on: boolean, remember = true) {
    if (remember) this.clean = on;
    for (const [k, p] of this.points) p.visible = !on && !this.coated.has(k as SurfaceId);
    if (this.loose) this.loose.visible = !on;
    this.cleanNow = on;
  }

  /** Emphasise one object (or none). */
  highlight(id: string | null) {
    for (const [k, o] of this.objects) {
      const on = k === id;
      (o.lines.material as LineBasicMaterial).color.setHex(on ? OBJ_HIGHLIGHT : OBJ_COLOR);
      o.label.scale.setScalar(on ? 1.3 : 1).multiply(o.label.userData.aspect);
    }
  }

  showObjects(visible: boolean) {
    this.objectsShown = visible;
    for (const o of this.objects.values()) o.root.visible = visible;
  }

  private clearObjects() {
    for (const o of this.objects.values()) {
      o.lines.geometry.dispose();
      (o.lines.material as LineBasicMaterial).dispose();
      (o.label.material as SpriteMaterial).map?.dispose();
      (o.label.material as SpriteMaterial).dispose();
      o.root.removeFromParent();
    }
    this.objects.clear();
  }

  /** Collision segments for walking ([x, z] pairs), or [] without a shell. */
  wallSegments(): [[number, number], [number, number]][] {
    return this.shell && !this.shell.fallback ? [...this.shell.walls, ...(this.shell.inner ?? [])].map((w) => [w.a, w.b]) : [];
  }

  /** Centre and span for framing the orbit camera. */
  frame(): { target: [number, number, number]; span: number } {
    if (this.shell && !this.shell.fallback) return { target: [0, this.shell.ceilingY / 2, 0], span: Math.max(this.shell.size.width, this.shell.size.depth, 2) };
    const all = [...this.points.values()];
    if (!all.length) return { target: [0, 1, 0], span: 4 };
    const c = new Vector3();
    let r = 1;
    for (const p of all) {
      p.geometry.computeBoundingSphere();
      c.add(p.geometry.boundingSphere!.center);
      r = Math.max(r, p.geometry.boundingSphere!.radius);
    }
    c.divideScalar(all.length);
    return { target: [c.x, c.y, c.z], span: r * 1.5 };
  }

  clear() {
    this.clearModels();
    this.stuff = null;
    if (this.loose) {
      this.loose.geometry.dispose();
      (this.loose.material as PointsMaterial).dispose();
      this.loose.removeFromParent();
      this.loose = null;
    }
    this.clearObjects();
    this.objectKey = '';
    this.entity?.dispose();
    this.entity = null;
    for (const p of this.points.values()) {
      p.geometry.dispose();
      (p.material as PointsMaterial).dispose();
      p.removeFromParent();
    }
    this.points.clear();
    for (const s of this.surfaces.values())
      for (const m of s.meshes) {
        m.geometry.dispose();
        (m.material as MeshStandardMaterial).map?.dispose();
        (m.material as MeshStandardMaterial).dispose();
        m.removeFromParent();
      }
    this.surfaces.clear();
    for (const m of this.base) {
      (m.material as MeshBasicMaterial).map?.dispose();
      (m.material as MeshBasicMaterial).dispose();
      m.removeFromParent();
    }
    this.base = [];
    this.coated.clear();
    this.outline?.geometry.dispose();
    this.outline?.removeFromParent();
    this.outline = null;
    this.group.removeFromParent();
    this.mood(null, null);
    this.shell = null;
  }

  // ------------------------------------------------------------------------------------------------

  /** Rasterise each surface's scan points onto its plane, fill the gaps, and show that behind the paint. */
  private buildBaseCoat(buckets: Record<Bucket, { p: number[]; c: number[] }>) {
    const v = new Vector3();
    for (const [id, s] of this.surfaces) {
      const src = buckets[id];
      for (const m of s.meshes) {
        const { width: w, height: h } = (m.geometry as PlaneGeometry).parameters;
        const tw = Math.min(512, Math.max(8, Math.round(w / BASE_TEXEL)));
        const th = Math.min(512, Math.max(8, Math.round(h / BASE_TEXEL)));
        m.updateMatrix();
        const inv = new Matrix4().copy(m.matrix).invert();
        const sum = new Float32Array(tw * th * 3);
        const cnt = new Float32Array(tw * th);
        for (let i = 0; i < src.p.length; i += 3) {
          v.set(src.p[i], src.p[i + 1], src.p[i + 2]).applyMatrix4(inv);
          if (Math.abs(v.z) > TOL * 1.5) continue;
          const x = Math.floor((v.x / w + 0.5) * tw);
          const y = Math.floor((0.5 - v.y / h) * th); // canvas row 0 is the plane's top edge
          if (x < 0 || y < 0 || x >= tw || y >= th) continue;
          const k = y * tw + x;
          cnt[k]++;
          for (let c = 0; c < 3; c++) sum[k * 3 + c] += src.c[i + c];
        }
        const photo = this.photoWalls[m.userData.planeId as string];
        const tex = fillHoles(sum, cnt, tw, th);
        if (!tex && !photo) continue;
        const inner = !!m.userData.inner;
        const mat = new MeshBasicMaterial({ map: tex, side: inner ? DoubleSide : undefined });
        if (photo)
          // The video projected onto this plane: sharper than the points; swap it in once it's loaded.
          void this.loader.loadAsync(photo).then((t) => {
            t.colorSpace = SRGBColorSpace;
            t.anisotropy = 8;
            mat.map?.dispose();
            mat.map = t;
            mat.needsUpdate = true;
          }).catch(() => undefined);
        const b = new Mesh(m.geometry, mat);
        b.position.copy(m.position);
        b.rotation.copy(m.rotation);
        // Push it slightly behind the paint plane (planes face +z locally, into the room); inner walls are seen
        // from both sides, so theirs stays in the plane and the paint's polygon offset puts the paint in front.
        if (!inner) b.position.add(new Vector3(0, 0, -BASE_OFFSET).applyEuler(m.rotation));
        b.name = `BaseCoat_${m.name}`;
        this.coated.add(id);
        this.base.push(b);
        this.group.add(b);
      }
    }
  }

  private buildShell(W: number, D: number, H: number) {
    const mk = (id: SurfaceId) => {
      const reveal = { value: 0 };
      const origin = { value: new Vector3() };
      const mat = revealMaterial(reveal, origin);
      const s: Surface = { meshes: [], mat, reveal, origin, target: 0, painted: null };
      this.surfaces.set(id, s);
      return s;
    };
    const floor = mk('floor');
    const fm = new Mesh(new PlaneGeometry(W, D), floor.mat);
    fm.rotation.x = -Math.PI / 2; // faces up
    fm.name = 'Shell_floor';
    fm.userData.planeId = 'floor';
    floor.meshes.push(fm);

    const ceil = mk('ceiling');
    const cm = new Mesh(new PlaneGeometry(W, D), ceil.mat);
    cm.rotation.x = Math.PI / 2; // faces down
    cm.position.y = H;
    cm.name = 'Shell_ceiling';
    cm.userData.planeId = 'ceiling';
    ceil.meshes.push(cm);

    const walls = mk('walls');
    for (const [i, w] of this.shell!.walls.entries()) {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const m = new Mesh(new PlaneGeometry(len, H), i === 0 ? walls.mat : cloneReveal(walls));
      m.position.set((w.a[0] + w.b[0]) / 2, H / 2, (w.a[1] + w.b[1]) / 2);
      // PlaneGeometry faces +z; turn it to face the wall's inward normal.
      m.rotation.y = Math.atan2(w.normal[0], w.normal[1]);
      m.userData.length = len;
      m.name = `Shell_wall_${i}`;
      m.userData.planeId = `wall-${i}`;
      walls.meshes.push(m);
    }
    // Inner walls (an L-shaped room's inner corner): seen from both sides; the paint wins over the base coat.
    for (const [i, w] of (this.shell!.inner ?? []).entries()) {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const mat = cloneReveal(walls);
      mat.side = DoubleSide;
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -2;
      mat.polygonOffsetUnits = -2;
      const m = new Mesh(new PlaneGeometry(len, H), mat);
      m.position.set((w.a[0] + w.b[0]) / 2, H / 2, (w.a[1] + w.b[1]) / 2);
      m.rotation.y = Math.atan2(-(w.b[1] - w.a[1]), w.b[0] - w.a[0]);
      m.userData.length = len;
      m.userData.inner = true;
      m.name = `Shell_inner_${i}`;
      m.userData.planeId = innerWallId(w);
      walls.meshes.push(m);
    }
    for (const s of this.surfaces.values()) for (const m of s.meshes) this.group.add(m);

    // A thin outline of the fitted room: "we found your walls".
    const x = W / 2;
    const z = D / 2;
    const c = [[-x, -z], [x, -z], [x, z], [-x, z]];
    const v: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [a, b] = [c[i], c[(i + 1) % 4]];
      v.push(a[0], 0.005, a[1], b[0], 0.005, b[1], a[0], H, a[1], b[0], H, b[1], a[0], 0, a[1], a[0], H, a[1]);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(v, 3));
    this.outline = new LineSegments(g, new LineBasicMaterial({ color: 0x9fd2ff, transparent: true, opacity: 0.7 }));
    this.outline.name = 'ShellOutline';
    this.group.add(this.outline);
  }

  private surfaceSize(id: SurfaceId): [number, number] {
    const s = this.shell!;
    return id === 'walls' ? [Math.max(s.size.width, s.size.depth), s.ceilingY] : [s.size.width, s.size.depth];
  }

  private maxDistance(from: Vector3): number {
    const s = this.shell!;
    let d = 0;
    for (const x of [-s.size.width / 2, s.size.width / 2])
      for (const y of [0, s.ceilingY])
        for (const z of [-s.size.depth / 2, s.size.depth / 2]) d = Math.max(d, from.distanceTo(new Vector3(x, y, z)));
    return d;
  }
}

/** Where paint should spread from: the viewer's position, pulled inside the room. */
export function paintOrigin(world: World, shell: RoomShell | null): Vector3 {
  const p = new Vector3();
  world.camera.getWorldPosition(p);
  if (!shell) return p;
  p.x = Math.max(-shell.size.width / 2, Math.min(shell.size.width / 2, p.x));
  p.z = Math.max(-shell.size.depth / 2, Math.min(shell.size.depth / 2, p.z));
  p.y = Math.max(0, Math.min(shell.ceilingY, p.y));
  return p;
}

function revealMaterial(reveal: { value: number }, origin: { value: Vector3 }): MeshStandardMaterial {
  // Front faces only: the planes face into the room, so near walls vanish when you orbit outside.
  const mat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uReveal = reveal;
    shader.uniforms.uOrigin = origin;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRsWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvRsWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRsWorld;\nuniform float uReveal;\nuniform vec3 uOrigin;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nfloat rsD = distance(vRsWorld, uOrigin);\nif (rsD > uReveal) discard;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.8, 0.45) * 2.5 * smoothstep(uReveal - 0.35, uReveal, rsD);');
  };
  mat.customProgramCacheKey = () => 'roomshift-reveal';
  return mat;
}

/** True when a room-frame point lies on one of the shell's inner walls. */
function nearInner(shell: RoomShell, q: readonly number[]): boolean {
  for (const w of shell.inner ?? []) {
    const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
    const len = Math.hypot(dx, dz) || 1;
    const t = ((q[0] - w.a[0]) * dx + (q[2] - w.a[1]) * dz) / (len * len);
    if (t < -0.02 || t > 1.02) continue;
    if (Math.abs((q[0] - w.a[0]) * dz - (q[2] - w.a[1]) * dx) / len < TOL) return true;
  }
  return false;
}

/**
 * Turn per-texel colour sums into a texture: average, then grow colour into empty texels from their
 * neighbours (a few passes cover the gaps between scan points), and give anything still empty the
 * surface's mean colour. Returns null when the surface has no points at all.
 */
function fillHoles(sum: Float32Array, cnt: Float32Array, w: number, h: number): CanvasTexture | null {
  const n = w * h;
  const col = new Float32Array(n * 3);
  const has = new Uint8Array(n);
  const mean = [0, 0, 0];
  let seen = 0;
  for (let k = 0; k < n; k++) {
    if (!cnt[k]) continue;
    has[k] = 1;
    seen++;
    for (let c = 0; c < 3; c++) {
      col[k * 3 + c] = sum[k * 3 + c] / cnt[k];
      mean[c] += col[k * 3 + c];
    }
  }
  if (seen < 20) return null;
  for (let c = 0; c < 3; c++) mean[c] /= seen;
  for (let pass = 0; pass < 24; pass++) {
    const grow: [number, number, number, number][] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (has[k]) continue;
        let r = 0, g = 0, b = 0, m = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const q = yy * w + xx;
            if (!has[q]) continue;
            r += col[q * 3];
            g += col[q * 3 + 1];
            b += col[q * 3 + 2];
            m++;
          }
        if (m) grow.push([k, r / m, g / m, b / m]);
      }
    if (!grow.length) break;
    for (const [k, r, g, b] of grow) {
      col[k * 3] = r;
      col[k * 3 + 1] = g;
      col[k * 3 + 2] = b;
      has[k] = 1;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let k = 0; k < n; k++) {
    for (let c = 0; c < 3; c++) img.data[k * 4 + c] = Math.round(255 * Math.min(1, has[k] ? col[k * 3 + c] : mean[c]));
    img.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Soften the texel grid a little.
  ctx.filter = 'blur(1px)';
  ctx.drawImage(canvas, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Another wall material sharing the walls' reveal uniforms (each wall gets its own texture repeat). */
function cloneReveal(s: Surface): MeshStandardMaterial {
  return revealMaterial(s.reveal, s.origin);
}

/** Small name tag for an object, about 4 cm tall per line of text. */
function nameSprite(text: string): Sprite {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  g.font = '600 44px system-ui, sans-serif';
  c.width = Math.min(1024, Math.ceil(g.measureText(text).width) + 48);
  c.height = 72;
  g.fillStyle = 'rgba(12,16,22,0.78)';
  g.beginPath();
  g.roundRect(0, 0, c.width, c.height, 36);
  g.fill();
  g.font = '600 44px system-ui, sans-serif';
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const s = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.renderOrder = 11;
  const aspect = new Vector3((0.1 * c.width) / c.height, 0.1, 1);
  s.userData.aspect = aspect;
  s.scale.copy(aspect);
  return s;
}
