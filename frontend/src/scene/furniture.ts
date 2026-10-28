/**
 * Low-poly proxy furniture built from primitives, sized to the estimated
 * footprint. These are explicitly proxies (reconstructionMethod "primitive")
 * and are labelled as such everywhere in the UI.
 *
 * Local frame: width along X, depth along Z with the front facing +Z, origin
 * at the centre of the footprint on the floor.
 */
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from '@iwsdk/core';
import type { SceneObject } from '../shared/index.js';

const M = {
  fabric: new MeshStandardMaterial({ color: 0x5b6b7d, roughness: 0.95 }),
  fabricLight: new MeshStandardMaterial({ color: 0xd8d2c8, roughness: 0.95 }),
  wood: new MeshStandardMaterial({ color: 0x8a6544, roughness: 0.7 }),
  woodLight: new MeshStandardMaterial({ color: 0xc19a6b, roughness: 0.7 }),
  white: new MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.4 }),
  steel: new MeshStandardMaterial({ color: 0xbfc4c8, roughness: 0.3, metalness: 0.6 }),
  dark: new MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.5 }),
  counter: new MeshStandardMaterial({ color: 0x3d3f42, roughness: 0.4 }),
  generic: new MeshStandardMaterial({ color: 0x9a8f80, roughness: 0.8 }),
};

type Builder = (g: Group, w: number, h: number, d: number) => void;

function box(g: Group, mat: MeshStandardMaterial, w: number, h: number, d: number, x: number, y: number, z: number) {
  const m = new Mesh(new BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z);
  g.add(m);
  return m;
}
function cyl(g: Group, mat: MeshStandardMaterial, r: number, h: number, x: number, y: number, z: number) {
  const m = new Mesh(new CylinderGeometry(r, r, h, 16), mat);
  m.position.set(x, y + h / 2, z);
  g.add(m);
}
function legs(g: Group, w: number, d: number, h: number, mat: MeshStandardMaterial, inset = 0.05, r = 0.025) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(g, mat, r, h, sx * (w / 2 - inset), 0, sz * (d / 2 - inset));
}

const BUILDERS: Record<string, Builder> = {
  sofa: (g, w, h, d) => {
    box(g, M.fabric, w, h * 0.45, d, 0, 0, 0);
    box(g, M.fabric, w, h * 0.55, d * 0.25, 0, h * 0.45, -d * 0.375);
    for (const s of [-1, 1]) box(g, M.fabric, w * 0.08, h * 0.25, d * 0.75, s * (w / 2 - w * 0.04), h * 0.45, d * 0.125);
  },
  armchair: (g, w, h, d) => BUILDERS.sofa(g, w, h, d),
  bed: (g, w, h, d) => {
    box(g, M.wood, w, h * 0.5, d, 0, 0, 0);
    box(g, M.fabricLight, w * 0.96, h * 0.4, d * 0.96, 0, h * 0.5, 0);
    box(g, M.wood, w, h * 1.6, 0.06, 0, 0, -d / 2 + 0.03);
    for (const s of w > 1.2 ? [-1, 1] : [0]) box(g, M.white, w * (w > 1.2 ? 0.4 : 0.7), 0.12, 0.35, s * w * 0.24, h * 0.9, -d / 2 + 0.3);
  },
  'tv-unit': (g, w, h, d) => {
    box(g, M.wood, w, h, d, 0, 0, 0);
    box(g, M.dark, w * 0.75, w * 0.42, 0.05, 0, h, -d * 0.2);
  },
  'coffee-table': (g, w, h, d) => {
    box(g, M.woodLight, w, 0.05, d, 0, h - 0.05, 0);
    legs(g, w, d, h - 0.05, M.woodLight);
  },
  'dining-table': (g, w, h, d) => {
    box(g, M.woodLight, w, 0.05, d, 0, h - 0.05, 0);
    legs(g, w, d, h - 0.05, M.woodLight);
    const chairs = Math.max(1, Math.floor(w / 0.6));
    for (const side of [-1, 1]) {
      for (let i = 0; i < chairs; i++) {
        const x = -w / 2 + (w / chairs) * (i + 0.5);
        const z = side * (d / 2 + 0.25);
        box(g, M.wood, 0.42, 0.45, 0.42, x, 0, z);
        box(g, M.wood, 0.42, 0.45, 0.05, x, 0.45, z + side * 0.19);
      }
    }
  },
  desk: (g, w, h, d) => {
    box(g, M.woodLight, w, 0.04, d, 0, h - 0.04, 0);
    legs(g, w, d, h - 0.04, M.steel, 0.04, 0.02);
  },
  'kitchen-units': (g, w, h, d) => {
    box(g, M.white, w, h - 0.04, d, 0, 0, 0);
    box(g, M.counter, w + 0.02, 0.04, d + 0.02, 0, h - 0.04, 0);
    box(g, M.white, w, 0.7, 0.35, 0, 1.45, -d / 2 + 0.175);
  },
  fridge: (g, w, h, d) => box(g, M.steel, w, h, d, 0, 0, 0),
  'washing-machine': (g, w, h, d) => {
    box(g, M.white, w, h, d, 0, 0, 0);
    const door = new Mesh(new CylinderGeometry(w * 0.3, w * 0.3, 0.03, 20), M.dark);
    door.rotation.x = Math.PI / 2;
    door.position.set(0, h * 0.45, d / 2);
    g.add(door);
  },
  toilet: (g, w, h, d) => {
    box(g, M.white, w, h, d * 0.25, 0, 0, -d / 2 + d * 0.125);
    cyl(g, M.white, w * 0.5, h * 0.5, 0, 0, d * 0.1);
  },
  bathtub: (g, w, h, d) => {
    box(g, M.white, w, h, d, 0, 0, 0);
    box(g, M.steel, w * 0.85, 0.02, d * 0.7, 0, h, 0);
  },
  basin: (g, w, h, d) => {
    cyl(g, M.white, 0.08, h - 0.15, 0, 0, -d * 0.1);
    box(g, M.white, w, 0.15, d, 0, h - 0.15, 0);
  },
  wardrobe: (g, w, h, d) => {
    box(g, M.wood, w, h, d, 0, 0, 0);
    box(g, M.dark, 0.01, h * 0.9, 0.01, 0, h * 0.05, d / 2 + 0.005);
  },
};

export function buildFurniture(obj: SceneObject): Group {
  const g = new Group();
  g.name = `Object_${obj.id}`;
  g.userData = { kind: 'object', objectId: obj.id, roomId: obj.roomId, method: obj.reconstructionMethod };
  const [w, h, d] = obj.sizeM;
  (BUILDERS[obj.kind] ?? ((gg, ww, hh, dd) => box(gg, M.generic, ww, hh, dd, 0, 0, 0)))(g, w, h, d);
  g.position.set(obj.positionXYZ[0], obj.positionXYZ[1] - h / 2, obj.positionXYZ[2]);
  g.rotation.y = obj.rotationY;
  return g;
}
