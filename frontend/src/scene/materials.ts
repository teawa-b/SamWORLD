/**
 * Surface materials. Walls and floors are textured either from a patch of a
 * real listing photo (when the pipeline read the room's finishes) or from a
 * procedural default chosen by room type. Textures are world-scaled: UVs are
 * in meters and `repeat = 1 / sizeM`, so one texture can be shared by many
 * meshes without stretching.
 */
import { CanvasTexture, Color, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, type Texture } from '@iwsdk/core';
import type { ExteriorFinish, RoomSurfaces, RoomType, SurfaceMaterial, SurfaceSpec } from '../shared/index.js';

const SIZE = 512;

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  return [c, c.getContext('2d')!];
}

function shade(hex: string, f: number): string {
  const c = new Color(hex);
  c.offsetHSL(0, 0, f);
  return `#${c.getHexString()}`;
}

function noise(g: CanvasRenderingContext2D, amount: number, seed: number, size = 2) {
  const r = rng(seed);
  for (let i = 0; i < (SIZE * SIZE) / (size * size * 3); i++) {
    const v = r() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${amount * r()})`;
    g.fillRect(r() * SIZE, r() * SIZE, size, size);
  }
}

/** Procedural texture covering `sizeM` × `sizeM` meters. */
function procedural(material: SurfaceMaterial | 'brick', color: string): { tex: Texture; sizeM: number } {
  const [c, g] = canvas();
  const r = rng(Math.abs([...color, ...material].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7)) % 2147483646 || 1);
  let sizeM = 1.2;
  g.fillStyle = color;
  g.fillRect(0, 0, SIZE, SIZE);
  if (material === 'wood' || material === 'laminate') {
    const boards = 8; // ~15 cm boards
    const bw = SIZE / boards;
    for (let i = 0; i < boards; i++) {
      let y = -r() * SIZE;
      while (y < SIZE) {
        const len = SIZE * (0.45 + r() * 0.5);
        g.fillStyle = shade(color, (r() - 0.5) * 0.08);
        g.fillRect(i * bw, y, bw, len);
        g.strokeStyle = 'rgba(60,35,15,0.10)';
        for (let k = 0; k < 6; k++) {
          g.beginPath();
          const x = i * bw + r() * bw;
          g.moveTo(x, y);
          g.bezierCurveTo(x + (r() - 0.5) * 6, y + len / 3, x + (r() - 0.5) * 6, y + (2 * len) / 3, x, y + len);
          g.stroke();
        }
        g.fillStyle = 'rgba(40,25,10,0.35)';
        g.fillRect(i * bw, y + len - 1, bw, 2);
        y += len;
      }
      g.fillStyle = 'rgba(40,25,10,0.28)';
      g.fillRect(i * bw, 0, 1.5, SIZE);
    }
  } else if (material === 'tile' || material === 'stone') {
    const n = material === 'tile' ? 4 : 2;
    const t = SIZE / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        g.fillStyle = shade(color, (r() - 0.5) * 0.05);
        g.fillRect(i * t + 2, j * t + 2, t - 4, t - 4);
      }
    g.strokeStyle = shade(color, -0.18);
    g.lineWidth = 3;
    for (let i = 0; i <= n; i++) {
      g.beginPath();
      g.moveTo(i * t, 0);
      g.lineTo(i * t, SIZE);
      g.moveTo(0, i * t);
      g.lineTo(SIZE, i * t);
      g.stroke();
    }
    noise(g, 0.05, 3);
  } else if (material === 'carpet') {
    noise(g, 0.18, 5, 1.5);
    noise(g, 0.1, 9, 3);
    sizeM = 0.8;
  } else if (material === 'brick') {
    const rows = 16; // 75 mm courses over 1.2 m
    const rh = SIZE / rows;
    const bl = rh * 2.9;
    g.fillStyle = '#c9c1b4';
    g.fillRect(0, 0, SIZE, SIZE);
    for (let j = 0; j < rows; j++) {
      const off = j % 2 ? bl / 2 : 0;
      for (let x = -off; x < SIZE; x += bl) {
        g.fillStyle = shade(color, (r() - 0.5) * 0.12);
        g.fillRect(x + 2, j * rh + 2, bl - 4, rh - 4);
      }
    }
    noise(g, 0.08, 11);
  } else {
    // paint / wallpaper / concrete / other: smooth, low-frequency mottling
    // (noise drawn small, then scaled up with smoothing so it never looks speckled).
    const small = document.createElement('canvas');
    small.width = small.height = 32;
    const sg = small.getContext('2d')!;
    const amt = material === 'concrete' ? 0.12 : 0.022;
    for (let x = 0; x < 32; x++)
      for (let y = 0; y < 32; y++) {
        const v = r() < 0.5 ? 0 : 255;
        sg.fillStyle = `rgba(${v},${v},${v},${amt * r()})`;
        sg.fillRect(x, y, 1, 1);
      }
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(small, 0, 0, SIZE, SIZE);
    if (material === 'concrete') noise(g, 0.05, 13, 2);
    sizeM = 2.5;
  }
  const tex = new CanvasTexture(c);
  return { tex: finish(tex, sizeM), sizeM };
}

function finish(tex: Texture, sizeM: number): Texture {
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  tex.repeat.set(1 / sizeM, 1 / sizeM);
  return tex;
}

const cache = new Map<string, { tex: Texture; sizeM: number }>();
function proceduralCached(material: SurfaceMaterial | 'brick', color: string) {
  const key = `${material}:${color}`;
  if (!cache.has(key)) cache.set(key, procedural(material, color));
  return cache.get(key)!;
}

/**
 * Crop a patch of a listing photo and mirror it 2×2 so it tiles without
 * seams. Starts with the procedural fallback and swaps when the photo loads.
 */
function photoTexture(url: string, spec: SurfaceSpec, mat: MeshStandardMaterial) {
  const t = spec.texture!;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const [x0, y0, x1, y1] = t.box;
    const sw = (x1 - x0) * img.naturalWidth;
    const sh = (y1 - y0) * img.naturalHeight;
    const side = Math.min(sw, sh); // square crop from the patch centre
    const sx = x0 * img.naturalWidth + (sw - side) / 2;
    const sy = y0 * img.naturalHeight + (sh - side) / 2;
    const half = 256;
    const c = document.createElement('canvas');
    c.width = c.height = half * 2;
    const g = c.getContext('2d')!;
    for (const [fx, fy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
      g.save();
      g.translate(fx === 1 ? 0 : half * 2, fy === 1 ? 0 : half * 2);
      g.scale(fx, fy);
      g.drawImage(img, sx, sy, side, side, 0, 0, half, half);
      g.restore();
    }
    const tex = finish(new CanvasTexture(c), t.patchSizeM * 2);
    mat.map = tex;
    mat.color.set('#ffffff');
    mat.userData.baseColor = mat.color.clone();
    mat.needsUpdate = true;
  };
  img.onerror = () => console.warn('Could not load listing photo for texture', url);
  img.src = url;
}

export interface SurfaceDefaults {
  floor: { material: SurfaceMaterial; color: string };
  wall: { material: SurfaceMaterial; color: string };
}

/** Sensible finishes by room type when no photo was sampled. */
export function defaultSurfaces(type: RoomType): SurfaceDefaults {
  switch (type) {
    case 'kitchen':
    case 'utility':
      return { floor: { material: 'tile', color: '#cfc8bc' }, wall: { material: 'paint', color: '#f1eee8' } };
    case 'bathroom':
    case 'wc':
      return { floor: { material: 'tile', color: '#dfe3e6' }, wall: { material: 'tile', color: '#f4f5f6' } };
    case 'bedroom':
      return { floor: { material: 'wood', color: '#c29a6b' }, wall: { material: 'paint', color: '#ece6dc' } };
    case 'hall':
    case 'landing':
      return { floor: { material: 'wood', color: '#9c7148' }, wall: { material: 'paint', color: '#efebe3' } };
    default:
      return { floor: { material: 'wood', color: '#b8895a' }, wall: { material: 'paint', color: '#f0ebe2' } };
  }
}

export interface MaterialSource {
  surfaces: RoomSurfaces | undefined;
  mediaUrl: (mediaId: string) => string | null;
}

/** A material for one room surface; marked with where its look came from. */
export function surfaceMaterial(kind: 'floor' | 'wall', type: RoomType, src: MaterialSource): MeshStandardMaterial {
  const spec = src.surfaces?.[kind];
  const def = defaultSurfaces(type)[kind];
  const material = spec?.material ?? def.material;
  const color = spec?.colorHex ?? def.color;
  const { tex } = proceduralCached(material, color);
  const mat = new MeshStandardMaterial({ map: tex, roughness: material === 'tile' ? 0.35 : material === 'wood' ? 0.6 : 0.9 });
  mat.userData.baseColor = mat.color.clone();
  mat.userData.source = spec?.texture ? 'photo' : spec ? 'photo-colour' : 'default';
  const url = spec?.texture ? src.mediaUrl(spec.texture.mediaId) : null;
  if (url && spec) photoTexture(url, spec, mat);
  return mat;
}

let exterior: MeshStandardMaterial | null = null;
/** Outside walls: the finish chosen on the review screen, else generic brick. */
export function exteriorMaterial(finish?: ExteriorFinish | null): MeshStandardMaterial {
  if (finish) {
    const kind: SurfaceMaterial | 'brick' = finish.wall === 'brick' ? 'brick' : finish.wall === 'stone' ? 'stone' : finish.wall === 'siding' ? 'wood' : 'concrete';
    const key = `${kind}:${finish.wallColor}`;
    exteriorByKey[key] ??= new MeshStandardMaterial({ map: proceduralCached(kind, finish.wallColor).tex, roughness: 0.95 });
    return exteriorByKey[key];
  }
  exterior ??= new MeshStandardMaterial({ map: proceduralCached('brick', '#a9604a').tex, roughness: 0.9 });
  return exterior;
}
const exteriorByKey: Record<string, MeshStandardMaterial> = {};

let ceiling: MeshStandardMaterial | null = null;
export function ceilingMaterial(): MeshStandardMaterial {
  ceiling ??= new MeshStandardMaterial({ map: proceduralCached('paint', '#faf8f4').tex, roughness: 1 });
  return ceiling;
}
