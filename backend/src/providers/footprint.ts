/**
 * The real outline of the building, from OpenStreetMap (© OpenStreetMap
 * contributors, ODbL). In Miami-Dade and many other places OSM's building
 * outlines come from county LiDAR/planimetric imports, so they are close to
 * the true footprint.
 *
 * Output is in plan metres with the same convention as the rest of the
 * pipeline: x to the right, z "down" the plan, and the street side of the
 * house at the bottom (largest z). Walls are rotated to line up with the axes.
 */
import type { Vec2 } from '../shared/index.js';

export interface Footprint {
  source: 'openstreetmap';
  osmId: string;
  /** Closed ring, metres, front (street side) at max z, min corner at 0,0. */
  polygonM: Vec2[];
  areaSqM: number;
  /** How the front was chosen. */
  front: 'nearest-road' | 'longest-side';
  attribution: string;
}

const OVERPASS = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
type El = { type: string; id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] };

function area(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return a / 2;
}
function inside(pt: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const centroid = (p: Vec2[]): Vec2 => [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length];

/** Drop repeated / collinear vertices (OSM rings often have many). */
function simplify(p: Vec2[], tol = 0.15): Vec2[] {
  let out = p.filter((q, i) => Math.hypot(q[0] - p[(i + 1) % p.length][0], q[1] - p[(i + 1) % p.length][1]) > 0.05);
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      const d = Math.abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])) / L;
      if (d < tol) {
        out = out.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Lat/lng ring → plan metres: rotate so the dominant wall direction is axis-aligned,
 * turn so the street faces the front (+z), snap near-equal coordinates so walls are straight.
 * `roadPoint` is the nearest road point in the same local metre frame (x east, y north), if known.
 */
export function toPlan(ringLatLng: { lat: number; lon: number }[], roadLatLng: { lat: number; lon: number } | null): { polygonM: Vec2[]; front: Footprint['front'] } {
  const lat0 = ringLatLng[0].lat;
  const lon0 = ringLatLng[0].lon;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const local = (g: { lat: number; lon: number }): Vec2 => [(g.lon - lon0) * kx, (g.lat - lat0) * ky];
  let ring = ringLatLng.map(local);
  if (ring.length > 3 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 0.01) ring.pop();
  ring = simplify(ring);
  // Dominant direction: length-weighted histogram of edge angles mod 90°.
  const bins = new Array(90).fill(0);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ang = ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 90;
    bins[Math.round(ang) % 90] += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const smooth = bins.map((_, i) => bins[(i + 89) % 90] + bins[i] + bins[(i + 1) % 90]);
  const theta = (smooth.indexOf(Math.max(...smooth)) * Math.PI) / 180;
  const rot = (p: Vec2, t: number): Vec2 => [p[0] * Math.cos(t) + p[1] * Math.sin(t), -p[0] * Math.sin(t) + p[1] * Math.cos(t)];
  let poly = ring.map((p) => rot(p, theta));
  const c = centroid(poly);
  // Which of the four sides faces the road? Turn the polygon so that side is at +z (plan bottom).
  // In this frame y points north; plan z points "down", so plan z = -y before the turn.
  let front: Footprint['front'] = 'longest-side';
  let turns = 0; // multiples of 90° applied to (x, -y)
  const toPlanXY = (p: Vec2): Vec2 => [p[0], -p[1]];
  poly = poly.map(toPlanXY);
  const cp = toPlanXY(c);
  if (roadLatLng) {
    const r = toPlanXY(rot(local(roadLatLng), theta));
    const dx = r[0] - cp[0];
    const dz = r[1] - cp[1];
    // Direction to the road → number of 90° turns that brings it to +z.
    if (Math.abs(dz) >= Math.abs(dx)) turns = dz > 0 ? 0 : 2;
    else turns = dx > 0 ? 1 : 3;
    front = 'nearest-road';
  } else {
    // No road known: put a long side at the front (houses usually face the street with a long side).
    const xs = poly.map((p) => p[0]);
    const zs = poly.map((p) => p[1]);
    if (Math.max(...zs) - Math.min(...zs) > Math.max(...xs) - Math.min(...xs)) turns = 1;
  }
  // Rotate by 90° steps: (x, z) → (-z, x) brings +x to +z.
  for (let k = 0; k < turns; k++) poly = poly.map(([x, z]) => [-z, x]);
  // Snap near-equal x and z values (walls that should line up), then move to the origin.
  const snapAxis = (vals: number[]) => {
    const sorted = [...new Set(vals)].sort((a, b) => a - b);
    const groups: number[][] = [];
    for (const v of sorted) {
      const g = groups[groups.length - 1];
      if (g && v - g[g.length - 1] < 0.3) g.push(v);
      else groups.push([v]);
    }
    return (v: number) => {
      const g = groups.find((gg) => gg.includes(v))!;
      return g.reduce((a, b) => a + b, 0) / g.length;
    };
  };
  const sx = snapAxis(poly.map((p) => p[0]));
  const sz = snapAxis(poly.map((p) => p[1]));
  poly = simplify(poly.map(([x, z]) => [sx(x), sz(z)] as Vec2), 0.05);
  const minX = Math.min(...poly.map((p) => p[0]));
  const minZ = Math.min(...poly.map((p) => p[1]));
  poly = poly.map(([x, z]) => [Math.round((x - minX) * 100) / 100, Math.round((z - minZ) * 100) / 100]);
  if (area(poly) < 0) poly.reverse();
  return { polygonM: poly, front };
}

/** Outline of the building at (lat, lng), or null when OSM has none nearby. */
export async function fetchFootprint(lat: number, lng: number, fetcher: typeof fetch = fetch): Promise<Footprint | null> {
  const q = `[out:json][timeout:20];(way(around:30,${lat},${lng})["building"];)->.b;.b out geom;way(around:90,${lat},${lng})["highway"]["highway"~"^(residential|tertiary|secondary|primary|unclassified|living_street|trunk)$"];out geom;`;
  const res = await fetcher(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'user-agent': 'WalkIn/0.3 (property reconstruction prototype)' }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`OpenStreetMap lookup failed (HTTP ${res.status})`);
  const data = (await res.json()) as { elements: El[] };
  const pt: Vec2 = [lng, lat];
  const buildings = data.elements.filter((e) => e.tags?.building && e.geometry && e.geometry.length >= 4);
  if (!buildings.length) return null;
  const ringOf = (e: El): Vec2[] => e.geometry!.map((g) => [g.lon, g.lat]);
  // The building containing the point, else the nearest by centroid (small detached sheds are skipped if a house is near).
  const dist = (e: El) => {
    const c = centroid(ringOf(e));
    return Math.hypot((c[0] - lng) * Math.cos((lat * Math.PI) / 180), c[1] - lat) * 111000;
  };
  const containing = buildings.find((b) => inside(pt, ringOf(b)));
  const pick = containing ?? buildings.filter((b) => !/shed|garage|carport|roof/i.test(b.tags!.building)).sort((a, b) => dist(a) - dist(b))[0] ?? buildings[0];
  // Nearest road vertex to the building centroid.
  const bc = centroid(ringOf(pick));
  let road: { lat: number; lon: number } | null = null;
  let best = Infinity;
  for (const w of data.elements.filter((e) => e.tags?.highway && e.geometry)) {
    for (const g of w.geometry!) {
      const d = Math.hypot((g.lon - bc[0]) * Math.cos((lat * Math.PI) / 180), g.lat - bc[1]);
      if (d < best) [best, road] = [d, g];
    }
  }
  const { polygonM, front } = toPlan(pick.geometry!, road);
  const a = Math.abs(area(polygonM));
  if (a < 20 || a > 2000) return null;
  return { source: 'openstreetmap', osmId: `${pick.type}/${pick.id}`, polygonM, areaSqM: Math.round(a * 10) / 10, front, attribution: 'Building outline © OpenStreetMap contributors (ODbL)' };
}
