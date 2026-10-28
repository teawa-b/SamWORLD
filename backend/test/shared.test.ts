import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FloorplanInterpretation,
  PlacementCandidate,
  blockingSegments,
  buildStructure,
  deriveWalls,
  estimateScale,
  placeObjects,
  verifyGeometry,
  wallPieces,
  computeViewpoints,
  pointInPolygon,
} from '../src/shared/index.js';

const fx = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/demo-house/${f}`, import.meta.url), 'utf8'));
const interp = FloorplanInterpretation.parse(fx('interpretation.fixture.json'));
const candidates = PlacementCandidate.array().parse(fx('placements.fixture.json').candidates);
const prov = { method: 'deterministic' as const, at: '2026-10-28T00:00:00Z' };

describe('scale', () => {
  it('recovers 50 px/m from printed dimensions despite read noise', () => {
    const s = estimateScale(interp);
    expect(s.method).toBe('dimension-labels');
    expect(1 / s.metersPerPx).toBeGreaterThan(48.5);
    expect(1 / s.metersPerPx).toBeLessThan(51.5);
  });
});

describe('walls', () => {
  it('turns two adjacent rectangles into 7 walls with one shared', () => {
    const walls = deriveWalls('L', [
      { id: 'a', polygon: [[0, 0], [2, 0], [2, 2], [0, 2]] },
      { id: 'b', polygon: [[2, 0], [5, 0], [5, 2], [2, 2]] },
    ]);
    expect(walls.filter((w) => !w.exterior)).toHaveLength(1);
    expect(walls).toHaveLength(7);
  });

  it('carves a door gap leaving a lintel', () => {
    const wall = { id: 'w', levelId: 'L', a: [0, 0] as [number, number], b: [4, 0] as [number, number], exterior: true, roomIds: ['a'], openingIds: ['d'] };
    const pieces = wallPieces(wall, [{ id: 'd', levelId: 'L', roomIds: ['a'], type: 'door', parentWallId: 'w', offsetAlongWall: 2, position: [2, 0], widthM: 1, heightM: 2, sillM: 0, confidence: 1 }], 2.4);
    expect(pieces).toEqual([
      { s0: 0, s1: 1.5, y0: 0, y1: 2.4 },
      { s0: 1.5, s1: 2.5, y0: 2, y1: 2.4 },
      { s0: 2.5, s1: 4, y0: 0, y1: 2.4 },
    ]);
  });
});

describe('demo house end to end', () => {
  const structure = buildStructure(interp, { propertyId: 'p' });
  const placed = placeObjects(structure, candidates, prov);
  const checks = verifyGeometry(structure, interp, placed.objects, placed.rejected, 130);

  it('builds two levels and nine rooms', () => {
    expect(structure.levels).toHaveLength(2);
    expect(structure.rooms).toHaveLength(9);
    expect(structure.levels[1].elevationMeters).toBeCloseTo(2.6, 5);
    expect(structure.levels[1].stairVoids).toHaveLength(1);
  });

  it('attaches every opening to a wall', () => {
    expect(structure.openings.every((o) => o.parentWallId)).toBe(true);
  });

  it('passes geometry checks with no failures', () => {
    const fails = checks.filter((c) => c.severity === 'fail');
    expect(fails).toEqual([]);
    expect(checks.find((c) => c.id === 'connectivity')?.severity).toBe('pass');
    for (const c of checks.filter((c) => c.id.startsWith('dims-L'))) expect(['pass', 'info']).toContain(c.severity);
  });

  it('places furniture without collisions', () => {
    expect(placed.objects.length).toBeGreaterThanOrEqual(15);
    expect(checks.filter((c) => c.id.startsWith('collide-'))).toEqual([]);
  });

  it('leaves door gaps walkable', () => {
    const segs = blockingSegments(structure, 'L0');
    const door = structure.openings.find((o) => o.id === 'L0-d-hall-living')!;
    const blocked = segs.some(([a, b]) => Math.abs(a[0] - door.position[0]) < 0.05 && Math.abs(b[0] - door.position[0]) < 0.05 && Math.min(a[1], b[1]) < door.position[1] && Math.max(a[1], b[1]) > door.position[1]);
    expect(blocked).toBe(false);
  });
});

describe('placement conventions', () => {
  it('measures `along` west→east / north→south regardless of polygon winding', () => {
    const cw: [number, number][] = [[0, 0], [4, 0], [4, 3], [0, 3]];
    const ccw = [...cw].reverse();
    for (const poly of [cw, ccw]) {
      const structure = buildStructure(
        {
          layoutSource: 'floorplan',
          levels: [{ id: 'L', index: 0, name: 'G', planMediaId: 'm', ceilingHeightMeters: 2.4, rooms: [{ id: 'r', label: 'R', type: 'living', polygonPx: poly.map(([x, z]) => [x * 100, z * 100]), measured: { text: '4 x 3', widthM: 4, depthM: 3 }, confidence: 1 }], openings: [], stairs: [] }],
          statedTotalAreaSqM: null,
          uncertainties: [],
          provenance: prov,
        },
        { propertyId: 'p' },
      );
      const mk = (side: 'west' | 'north', along: number) => ({ id: `${side}${along}`, roomId: 'r', kind: 'box', anchor: { type: 'against-wall' as const, side, along }, sizeM: [1, 1, 0.5] as [number, number, number], sourceDetectionIds: [], sourceMediaIds: [], confidence: 1, rationale: '', provenance: prov });
      const { objects } = placeObjects(structure, [mk('west', 0), mk('north', 1)], prov);
      expect(objects.find((o) => o.id === 'west0')!.positionXYZ[2]).toBeCloseTo(0.5, 2); // north end of west wall
      expect(objects.find((o) => o.id === 'north1')!.positionXYZ[0]).toBeCloseTo(3.5, 2); // east end of north wall
    }
  });
});

describe('viewpoints', () => {
  const structure = buildStructure(interp, { propertyId: 'p' });
  const vps = computeViewpoints(structure);
  it('gives every room at least one look-around point inside it', () => {
    for (const r of structure.rooms) {
      const mine = vps.filter((v) => v.roomId === r.id && v.kind === 'room');
      expect(mine.length, r.label).toBeGreaterThan(0);
      for (const v of mine) expect(pointInPolygon(v.position, r.polygonXZMeters)).toBe(true);
    }
  });
  it('adds a point in each internal doorway and links the floors by stairs', () => {
    const doors = structure.openings.filter((o) => (o.type === 'door' || o.type === 'archway') && o.roomIds.length === 2);
    expect(vps.filter((v) => v.kind === 'door')).toHaveLength(doors.length);
    const stairs = vps.filter((v) => v.kind === 'stairs');
    expect(stairs).toHaveLength(2);
    expect(stairs[0].target?.levelId).toBe(stairs[1].levelId);
  });
  it('keeps points off the stair flight', () => {
    const v = structure.levels[1].stairVoids[0];
    for (const p of vps.filter((x) => x.levelId === 'L0')) expect(pointInPolygon(p.position, v)).toBe(false);
  });
});
