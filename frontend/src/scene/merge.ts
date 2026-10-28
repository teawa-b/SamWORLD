/**
 * Draw-call reduction: merge many small meshes into one mesh per material.
 * Standalone VR headsets are draw-call bound long before they are triangle
 * bound, so walls, furniture and stairs are merged at build time.
 */
import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, type Material } from '@iwsdk/core';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Copy of an indexed geometry keeping only the triangles of the given groups. */
export function subsetByGroups(geo: BufferGeometry, groups: number[]): BufferGeometry {
  const index = geo.index!;
  const keep: number[] = [];
  for (const [gi, g] of geo.groups.entries()) {
    if (!groups.includes(g.materialIndex ?? gi)) continue;
    for (let i = g.start; i < g.start + g.count; i++) keep.push(index.getX(i));
  }
  const out = new BufferGeometry();
  for (const name of Object.keys(geo.attributes)) out.setAttribute(name, geo.attributes[name]);
  out.setIndex(new BufferAttribute(new Uint32Array(keep), 1));
  return out;
}

/** Merge geometries (already in a common space); returns null for an empty list. */
export function mergeAll(geos: BufferGeometry[]): BufferGeometry | null {
  if (!geos.length) return null;
  const prepared = geos.map((g) => (g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()])));
  return mergeGeometries(prepared, false);
}

/**
 * Replace every mesh under `group` with one mesh per material, keeping the
 * group's own transform. Meshes with array materials are left alone.
 */
export function mergeByMaterial(group: Group): void {
  group.updateMatrixWorld(true);
  const inv = new Matrix4().copy(group.matrixWorld).invert();
  const byMat = new Map<Material, BufferGeometry[]>();
  const meshes: Mesh[] = [];
  group.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    const g = m.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inv, m.matrixWorld));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!byMat.has(m.material)) byMat.set(m.material, []);
    byMat.get(m.material)!.push(g);
    meshes.push(m);
  });
  for (const m of meshes) {
    m.parent?.remove(m);
    m.geometry.dispose();
  }
  for (const [mat, geos] of byMat) {
    const merged = mergeAll(geos);
    if (merged) group.add(new Mesh(merged, mat));
  }
}
