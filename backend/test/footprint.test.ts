import { describe, expect, it } from 'vitest';
import { fetchFootprint, toPlan } from '../src/providers/footprint.js';
import { buildStructure, layoutFromRoomList, roomListFromEvidence, verifyGeometry, ringArea, type Provenance } from '../src/shared/index.js';

// A small L-shaped house in Miami (lat/lng), rotated ~12° off north, with a street to its south.
const lat0 = 25.7716;
const lon0 = -80.2903;
const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
const ky = 110540;
const t = (12 * Math.PI) / 180;
const L: [number, number][] = [[0, 0], [12, 0], [12, 6], [7, 6], [7, 10], [0, 10]]; // metres, x east, y north
const ring = L.map(([x, y]) => {
  const xr = x * Math.cos(t) - y * Math.sin(t);
  const yr = x * Math.sin(t) + y * Math.cos(t);
  return { lat: lat0 + yr / ky, lon: lon0 + xr / kx };
});
const road = { lat: lat0 - 12 / ky, lon: lon0 + 6 / kx }; // 12 m south of the house

describe('building outline (OpenStreetMap)', () => {
  it('turns a rotated OSM ring into an axis-aligned plan outline with the street at the front', () => {
    const { polygonM, front } = toPlan([...ring, ring[0]], road);
    expect(front).toBe('nearest-road');
    expect(polygonM).toHaveLength(6);
    expect(ringArea(polygonM)).toBeGreaterThan(97);
    expect(ringArea(polygonM)).toBeLessThan(103); // 12×6 + 7×4 = 100 m²
    // Walls line up with the axes.
    for (let i = 0; i < polygonM.length; i++) {
      const a = polygonM[i];
      const b = polygonM[(i + 1) % polygonM.length];
      expect(Math.min(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))).toBeLessThan(0.05);
    }
    // The street (south) side — the full 12 m wall — is at the bottom of the plan (max z).
    const maxZ = Math.max(...polygonM.map((p) => p[1]));
    const frontXs = polygonM.filter((p) => Math.abs(p[1] - maxZ) < 0.05).map((p) => p[0]);
    expect(Math.max(...frontXs) - Math.min(...frontXs)).toBeGreaterThan(11.5);
  });

  it('picks the building at the point from an Overpass reply', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          elements: [
            { type: 'way', id: 1, tags: { building: 'shed' }, geometry: [{ lat: lat0 + 0.0003, lon: lon0 }, { lat: lat0 + 0.0003, lon: lon0 + 0.00003 }, { lat: lat0 + 0.00033, lon: lon0 + 0.00003 }, { lat: lat0 + 0.0003, lon: lon0 }] },
            { type: 'way', id: 42, tags: { building: 'house' }, geometry: [...ring, ring[0]] },
            { type: 'way', id: 7, tags: { highway: 'residential' }, geometry: [road, { lat: road.lat, lon: road.lon + 0.0002 }] },
          ],
        }),
      )) as unknown as typeof fetch;
    const fp = await fetchFootprint(lat0 + 3 / ky, lon0 + 3 / kx, fake);
    expect(fp?.osmId).toBe('way/42');
    expect(fp?.front).toBe('nearest-road');
    expect(fp?.attribution).toMatch(/OpenStreetMap/);
  });

  it('fits the rooms inside an L-shaped outline, connected and without overlaps', () => {
    const { polygonM } = toPlan([...ring, ring[0]], road);
    const prov: Provenance = { method: 'deterministic', at: '2026-11-02T00:00:00Z' };
    const rooms = roomListFromEvidence({ bedrooms: 3, bathrooms: 2, areaSqM: 95, floors: 1 }, ['Living room', 'Kitchen', 'Bedroom 1'], [
      { label: 'Living room', side: 'front', entrance: true, connectsTo: [{ label: 'Kitchen', kind: 'door' }] },
    ]);
    const interp = layoutFromRoomList({ rooms, footprint: polygonM, statedTotalAreaSqM: 95, provenance: prov, confidence: 0.4, layoutSource: 'photos' });
    const structure = buildStructure(interp, { propertyId: 'p', scaleOverride: { metersPerPx: 0.01, method: 'estimated-layout' } });
    const checks = verifyGeometry(structure, interp, [], [], null);
    expect(checks.filter((c) => c.severity === 'fail')).toEqual([]);
    expect(checks.find((c) => c.id === 'connectivity')?.severity).toBe('pass');
    // The rooms fill the L, not a rectangle: total close to the outline's 100 m², and the notch stays empty.
    const total = structure.rooms.reduce((a, r) => a + r.areaSqM, 0);
    expect(total).toBeGreaterThan(90);
    expect(total).toBeLessThan(102);
    const notch: [number, number] = [Math.max(...polygonM.map((p) => p[0])) - 1, 1]; // inside the bounding box, outside the L
    const inPoly = (p: [number, number], poly: [number, number][]) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (poly[i][1] > p[1] !== poly[j][1] > p[1] && p[0] < ((poly[j][0] - poly[i][0]) * (p[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
      return c;
    };
    const notchInOutline = inPoly(notch, polygonM);
    for (const r of structure.rooms) expect(inPoly(notch, r.polygonXZMeters)).toBe(notchInOutline);
    expect(interp.uncertainties.join(' ')).toMatch(/OpenStreetMap outline/);
  });
});
