/**
 * Scene manifest → Three.js object graph. Pure geometry: no ECS, no input.
 * Every mesh carries `userData` linking it back to the plan evidence it came
 * from (room/wall/opening/object id), so the UI can always explain a surface.
 *
 * Coordinates are meters; X/Z horizontal (Z = plan "down"), Y up. The house is
 * built around its footprint centre so it rotates/scales about its middle.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  ShapeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Path,
  Shape,
  Vector2,
  Vector3,
} from '@iwsdk/core';
import {
  SLAB_THICKNESS_M,
  WALL_THICKNESS_M,
  pointInPolygon,
  wallPieces,
  type Room,
  type SceneManifest,
  type Vec2,
  type Wall,
} from '../shared/index.js';
import { buildFurniture } from './furniture.js';
import { makeLabel } from './labels.js';

export interface LevelBuild {
  levelId: string;
  index: number;
  group: Group; // moved when floors are separated
  walls: { wall: Wall; group: Group; outward: Vector3 }[];
  rooms: { room: Room; floor: Mesh }[];
  furniture: Group;
  labels: Group;
}

export interface HouseBuild {
  root: Group; // property root; centred on footprint, ground at y=0
  levels: LevelBuild[];
  roof: Group | null;
  centre: Vec2;
  size: Vector3;
  topElevation: number;
}

const mats = {
  wallExt: new MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.9 }),
  wallInt: new MeshStandardMaterial({ color: 0xf6f3ee, roughness: 0.95 }),
  slabEdge: new MeshStandardMaterial({ color: 0xb9b2a6, roughness: 1 }),
  glass: new MeshStandardMaterial({ color: 0x9fc6e0, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35 }),
  roof: new MeshStandardMaterial({ color: 0x7a4b3a, roughness: 0.8, side: DoubleSide }),
  stair: new MeshStandardMaterial({ color: 0xa9845c, roughness: 0.7 }),
  ceiling: new MeshStandardMaterial({ color: 0xfbfaf7, roughness: 1 }),
};

/** Floor finish per room type; evidence mode recolours these. */
const FLOOR_COLORS: Record<string, number> = {
  living: 0xc8a27a,
  bedroom: 0xcaa883,
  dining: 0xc8a27a,
  study: 0xc8a27a,
  kitchen: 0xd9d4cb,
  bathroom: 0xdfe5e8,
  wc: 0xdfe5e8,
  utility: 0xd9d4cb,
  hall: 0xb79168,
  landing: 0xbfa080,
  other: 0xcfc6b8,
};

export const EVIDENCE_COLORS = {
  photoAndMeasured: new Color(0x4caf7a),
  measuredOnly: new Color(0xe0b24a),
  estimated: new Color(0xd9645a),
};

export function evidenceColor(room: Room): Color {
  if (room.linkedMediaIds.length && room.dimensionsMeasured && !room.isEstimated) return EVIDENCE_COLORS.photoAndMeasured;
  if (room.dimensionsMeasured && !room.isEstimated) return EVIDENCE_COLORS.measuredOnly;
  return EVIDENCE_COLORS.estimated;
}

export function buildHouse(scene: SceneManifest): HouseBuild {
  const s = scene.structure;
  const b = s.footprintBounds;
  const centre: Vec2 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
  const root = new Group();
  root.name = 'PropertyRoot';
  const shell = new Group();
  shell.name = 'BuildingShell';
  shell.position.set(-centre[0], 0, -centre[1]);
  root.add(shell);

  const levels: LevelBuild[] = [];
  for (const level of [...s.levels].sort((a, b) => a.index - b.index)) {
    const group = new Group();
    group.name = `Floor_${level.index}`;
    group.userData = { kind: 'level', levelId: level.id };
    shell.add(group);
    const lb: LevelBuild = { levelId: level.id, index: level.index, group, walls: [], rooms: [], furniture: new Group(), labels: new Group() };
    lb.furniture.name = `Furnishings_${level.index}`;
    lb.labels.name = `Labels_${level.index}`;
    group.add(lb.furniture, lb.labels);
    const elev = level.elevationMeters;

    // Floor slabs, one per room so each can be selected and recoloured.
    for (const room of s.rooms.filter((r) => r.levelId === level.id)) {
      const shape = new Shape(room.polygonXZMeters.map(([x, z]) => new Vector2(x, -z)));
      for (const v of level.stairVoids) {
        const c = centroid(v);
        if (pointInPolygon(c, room.polygonXZMeters)) shape.holes.push(new Path(v.map(([x, z]) => new Vector2(x, -z))));
      }
      const geo = new ExtrudeGeometry(shape, { depth: SLAB_THICKNESS_M, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); // shape XY → XZ, extrude along +Y
      geo.translate(0, elev - SLAB_THICKNESS_M, 0);
      const mat = new MeshStandardMaterial({ color: FLOOR_COLORS[room.type] ?? FLOOR_COLORS.other, roughness: 0.8 });
      mat.userData.baseColor = mat.color.clone();
      const floor = new Mesh(geo, [mat, mats.slabEdge]);
      floor.name = `Room_${room.id}`;
      floor.userData = { kind: 'room', roomId: room.id, levelId: level.id };
      group.add(floor);
      lb.rooms.push({ room, floor });

      // Ceiling: faces down, so it is back-face culled (invisible) from above
      // in dollhouse view but closes the room when walking through it.
      {
        // Shape in (x, +z): ShapeGeometry faces +Z, and rotating +90° about X
        // maps that to -Y (down) while placing points at (x, 0, z).
        const cgeo = new ShapeGeometry(new Shape(room.polygonXZMeters.map(([x, z]) => new Vector2(x, z))));
        cgeo.rotateX(Math.PI / 2);
        cgeo.translate(0, elev + level.heightMeters - 0.002, 0);
        const ceiling = new Mesh(cgeo, mats.ceiling);
        ceiling.userData = { kind: 'ceiling', roomId: room.id };
        group.add(ceiling);
      }

      const label = makeLabel(room.label, room.isEstimated ? 'estimated' : room.linkedMediaIds.length ? 'photo' : 'plan');
      label.position.set(room.spawnPoint[0], elev + 1.4, room.spawnPoint[1]);
      lb.labels.add(label);
    }

    // Walls with real openings.
    for (const wall of s.walls.filter((w) => w.levelId === level.id)) {
      const wg = new Group();
      wg.name = `Wall_${wall.id}`;
      wg.userData = { kind: 'wall', wallId: wall.id, levelId: level.id };
      const angle = Math.atan2(-(wall.b[1] - wall.a[1]), wall.b[0] - wall.a[0]);
      wg.position.set(wall.a[0], elev, wall.a[1]);
      wg.rotation.y = angle;
      const mat = wall.exterior ? mats.wallExt : mats.wallInt;
      for (const p of wallPieces(wall, s.openings, level.heightMeters)) {
        const geo = new BoxGeometry(p.s1 - p.s0, p.y1 - p.y0, WALL_THICKNESS_M);
        const m = new Mesh(geo, mat);
        m.position.set((p.s0 + p.s1) / 2, (p.y0 + p.y1) / 2, 0);
        m.userData = { kind: 'wall', wallId: wall.id };
        wg.add(m);
      }
      for (const o of s.openings.filter((o) => o.parentWallId === wall.id && o.type === 'window')) {
        const pane = new Mesh(new BoxGeometry(o.widthM, o.heightM, 0.02), mats.glass);
        pane.position.set(o.offsetAlongWall, o.sillM + o.heightM / 2, 0);
        pane.userData = { kind: 'window', openingId: o.id };
        wg.add(pane);
      }
      group.add(wg);
      // Outward = away from the footprint centre, perpendicular to the wall.
      const mid = new Vector3((wall.a[0] + wall.b[0]) / 2 - centre[0], 0, (wall.a[1] + wall.b[1]) / 2 - centre[1]);
      const nrm = new Vector3(-(wall.b[1] - wall.a[1]), 0, wall.b[0] - wall.a[0]).normalize();
      if (nrm.dot(mid) < 0) nrm.negate();
      lb.walls.push({ wall, group: wg, outward: nrm });
    }

    // Stairs (placeholder geometry: straight flight along the longer axis).
    for (const upper of s.levels.filter((l) => l.index === level.index + 1)) {
      for (const v of upper.stairVoids) group.add(buildStairs(v, elev, upper.elevationMeters));
    }

    // Furniture proxies (or SAM 3D meshes, swapped in later by the loader).
    for (const obj of scene.objects.filter((o) => o.levelId === level.id)) {
      const f = buildFurniture(obj);
      lb.furniture.add(f);
    }

    levels.push(lb);
  }

  // Gable roof over the top level's footprint.
  let roof: Group | null = null;
  const top = [...s.levels].sort((a, b) => b.index - a.index)[0];
  const topElevation = top.elevationMeters + top.heightMeters;
  const topRooms = s.rooms.filter((r) => r.levelId === top.id).flatMap((r) => r.polygonXZMeters);
  if (topRooms.length) {
    roof = buildRoof(topRooms, topElevation);
    shell.add(roof);
  }

  const size = new Vector3(b.max[0] - b.min[0], topElevation + 2, b.max[1] - b.min[1]);
  return { root, levels, roof, centre, size, topElevation };
}

function centroid(poly: Vec2[]): Vec2 {
  const n = poly.length;
  return [poly.reduce((a, p) => a + p[0], 0) / n, poly.reduce((a, p) => a + p[1], 0) / n];
}

function buildStairs(poly: Vec2[], fromY: number, toY: number): Group {
  const g = new Group();
  g.name = 'Stairs';
  g.userData = { kind: 'stairs', estimated: true };
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const alongZ = z1 - z0 >= x1 - x0;
  const run = alongZ ? z1 - z0 : x1 - x0;
  const rise = toY - fromY;
  const steps = Math.max(8, Math.round(rise / 0.19));
  const tread = run / steps;
  for (let i = 0; i < steps; i++) {
    const h = (rise * (i + 1)) / steps;
    const geo = alongZ ? new BoxGeometry(x1 - x0, h, tread) : new BoxGeometry(tread, h, z1 - z0);
    const m = new Mesh(geo, mats.stair);
    // Rises from the high-coordinate end toward the low end.
    if (alongZ) m.position.set((x0 + x1) / 2, fromY + h / 2, z1 - tread * (i + 0.5));
    else m.position.set(x1 - tread * (i + 0.5), fromY + h / 2, (z0 + z1) / 2);
    g.add(m);
  }
  return g;
}

function buildRoof(points: Vec2[], eaveY: number): Group {
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  const o = 0.25; // overhang
  const [x0, x1, z0, z1] = [Math.min(...xs) - o, Math.max(...xs) + o, Math.min(...zs) - o, Math.max(...zs) + o];
  const ridgeAlongX = x1 - x0 >= z1 - z0;
  const halfSpan = ridgeAlongX ? (z1 - z0) / 2 : (x1 - x0) / 2;
  const ridgeH = Math.tan((35 * Math.PI) / 180) * halfSpan;
  const y0 = eaveY;
  const y1 = eaveY + ridgeH;
  const v: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => v.push(...a, ...b, ...c);
  if (ridgeAlongX) {
    const zm = (z0 + z1) / 2;
    const A = [x0, y0, z0], B = [x1, y0, z0], C = [x1, y0, z1], D = [x0, y0, z1], E = [x0, y1, zm], F = [x1, y1, zm];
    tri(A, E, F); tri(A, F, B); tri(D, C, F); tri(D, F, E); tri(A, D, E); tri(B, F, C);
  } else {
    const xm = (x0 + x1) / 2;
    const A = [x0, y0, z0], B = [x1, y0, z0], C = [x1, y0, z1], D = [x0, y0, z1], E = [xm, y1, z0], F = [xm, y1, z1];
    tri(A, E, F); tri(A, F, D); tri(B, C, F); tri(B, F, E); tri(A, B, E); tri(D, F, C);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  const g = new Group();
  g.name = 'Roof';
  g.userData = { kind: 'roof', estimated: true };
  g.add(new Mesh(geo, mats.roof));
  return g;
}

/** Simple ground + table so the dollhouse sits somewhere sensible in VR. */
export function buildRoom(): Group {
  const g = new Group();
  g.name = 'ViewingRoom';
  const floor = new Mesh(new CylinderGeometry(6, 6, 0.02, 48), new MeshStandardMaterial({ color: 0x6f7378, roughness: 1 }));
  floor.position.y = -0.01;
  const table = new Mesh(new CylinderGeometry(0.45, 0.5, 0.97, 40), new MeshStandardMaterial({ color: 0x3e3a36, roughness: 0.6 }));
  table.position.set(0, 0.485, -0.8);
  g.add(floor, table);
  return g;
}
