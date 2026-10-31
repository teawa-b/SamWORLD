import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FloorplanInterpretation,
  PlacementCandidate,
  blockingSegments,
  buildStructure,
  closeGaps,
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

describe('closing gaps between rooms', () => {
  it('moves an unmeasured room to meet its neighbour, and leaves two measured rooms apart', () => {
    const [hall, wc, bed1, bed2] = closeGaps(
      [
        [[0, 0], [1, 0], [1, 4], [0, 4]], // hall
        [[1.3, 1], [3, 1], [3, 2], [1.3, 2]], // WC, 0.3 m east of the hall
        [[-3, 0], [-0.12, 0], [-0.12, 2], [-3, 2]], // bedroom, 0.12 m west of the hall
        [[-3, 2.15], [-0.12, 2.15], [-0.12, 4], [-3, 4]], // second bedroom, 0.15 m below the first
      ],
      [false, false, true, true],
    );
    expect(wc[0][0]).toBeCloseTo(1, 5); // the WC moved to the hall, not the other way round
    expect(Math.min(...hall.map((p) => p[0]))).toBeCloseTo(-0.12, 5); // the hall moved to the measured bedroom
    expect(bed1).toEqual([[-3, 0], [-0.12, 0], [-0.12, 2], [-3, 2]]);
    expect(bed2[0][1]).toBeCloseTo(2.15, 5); // both measured: the gap is real wall thickness
  });
});

describe('fittings (shaped like the Craven Street flat)', () => {
  // Hall on the west; kitchen above the bathroom on the east. The kitchen door is marked near the corner where
  // the hall, kitchen and bathroom meet, closer to the kitchen/bathroom wall than to the hall.
  const room = (id: string, type: 'kitchen' | 'bathroom' | 'hall', poly: [number, number][]) =>
    ({ id, label: id, type, polygonPx: poly.map(([x, z]) => [x * 100, z * 100] as [number, number]), measured: null, confidence: 1 });
  const structure = buildStructure(
    {
      layoutSource: 'floorplan',
      levels: [
        {
          id: 'L', index: 0, name: 'G', planMediaId: 'm', ceilingHeightMeters: 2.4,
          rooms: [
            room('hall', 'hall', [[-1.2, 0], [0, 0], [0, 6.3], [-1.2, 6.3]]),
            room('kitchen', 'kitchen', [[0, 0], [2, 0], [2, 3.8], [0, 3.8]]),
            room('bath', 'bathroom', [[0, 3.8], [2, 3.8], [2, 6.3], [0, 6.3]]),
          ],
          openings: [
            { id: 'd-kitchen', type: 'door', atPx: [15, 378], widthPx: 76, roomIds: ['kitchen', 'hall'], confidence: 1 },
            { id: 'd-bath', type: 'door', atPx: [0, 560], widthPx: 76, roomIds: ['bath', 'hall'], confidence: 1 },
          ],
          stairs: [],
        },
      ],
      statedTotalAreaSqM: null,
      uncertainties: [],
      provenance: prov,
    },
    { propertyId: 'p' },
  );
  const wallOf = (id: string) => structure.walls.find((w) => w.id === structure.openings.find((o) => o.id === id)!.parentWallId)!;
  const mk = (id: string, roomId: string, kind: string, side: 'north' | 'south' | 'east' | 'west', along: number, sizeM: [number, number, number]) =>
    ({ id, roomId, kind, anchor: { type: 'against-wall' as const, side, along }, sizeM, sourceDetectionIds: [], sourceMediaIds: [], confidence: 1, rationale: '', provenance: prov });

  it('puts a door on a wall between the rooms it connects', () => {
    expect([...wallOf('d-kitchen').roomIds].sort()).toEqual(['hall', 'kitchen']);
  });

  it('places the bath along the wall it shares with the kitchen', () => {
    const { objects, rejected } = placeObjects(structure, [mk('tub', 'bath', 'bathtub', 'north', 0.5, [1.7, 0.55, 0.7])], prov);
    expect(rejected).toEqual([]);
    const northZ = Math.min(...structure.rooms.find((r) => r.id === 'bath')!.polygonXZMeters.map((p) => p[1]));
    expect(objects[0].positionXYZ[2]).toBeCloseTo(northZ + 0.03 + 0.35, 2); // against the wall, not moved off it
  });

  it('moves a bath to another wall when its own doorway blocks the suggested one', () => {
    // Long enough that it can't slide past the doorway on the west wall (the test plan has no printed sizes, so
    // it's built at the default 2 cm/px: the bathroom is 4 × 5 m).
    const { objects, rejected } = placeObjects(structure, [mk('tub', 'bath', 'bathtub', 'west', 0.5, [4.5, 0.55, 0.7])], prov);
    expect(rejected).toEqual([]);
    expect(objects[0].placementNotes[0]).toMatch(/instead of the west wall/);
  });

  it('tries the other corners when the asked corner is a doorway', () => {
    // The bathroom door is on its west wall, so a bath in the south-west corner can't go there.
    const tub = { ...mk('tub', 'bath', 'bathtub', 'west', 0, [4.5, 0.55, 0.7]), anchor: { type: 'corner' as const, sides: ['west', 'south'] as ['west', 'south'] } };
    const { objects, rejected } = placeObjects(structure, [tub], prov);
    expect(rejected).toEqual([]);
    expect(objects[0].placementNotes[0]).not.toMatch(/^against west wall$/);
  });

  it('treats a base cabinet in a kitchen as units the sink can sit in', () => {
    const { objects, rejected } = placeObjects(
      structure,
      [mk('base', 'kitchen', 'base-cabinet', 'east', 0.5, [3.0, 0.9, 0.6]), mk('sink', 'kitchen', 'sink', 'east', 0.5, [0.8, 0.2, 0.5])],
      prov,
    );
    expect(rejected).toEqual([]);
    expect(objects.find((o) => o.id === 'base')!.kind).toBe('kitchen-units');
  });

  it('fits an oven and sink into the kitchen units and hangs wall cupboards above them', () => {
    const { objects, rejected } = placeObjects(
      structure,
      [
        mk('units', 'kitchen', 'cabinet', 'east', 0.5, [3.0, 0.9, 0.6]),
        mk('oven', 'kitchen', 'oven', 'east', 0.3, [0.6, 0.85, 0.55]),
        mk('sink', 'kitchen', 'sink', 'east', 0.7, [0.8, 0.2, 0.5]),
        mk('upper', 'kitchen', 'cabinet', 'east', 0.5, [1.6, 0.7, 0.35]),
      ],
      prov,
    );
    expect(rejected).toEqual([]);
    const by = Object.fromEntries(objects.map((o) => [o.id, o]));
    expect(by.units.kind).toBe('kitchen-units');
    expect(by.upper.kind).toBe('wall-cabinet');
    expect(by.upper.positionXYZ[1] - by.upper.sizeM[1] / 2).toBeGreaterThan(0.9); // above the worktop
    expect(by.oven.sizeM[2]).toBeCloseTo(0.62, 2); // front 2 cm proud of the units
    expect(by.sink.positionXYZ[1]).toBeCloseTo(0.9, 1); // in the worktop
  });

  it('hangs a mirror above the basin and stands a lamp on the bedside table', () => {
    const { objects, rejected } = placeObjects(
      structure,
      [
        mk('basin', 'bath', 'basin', 'east', 0.5, [0.55, 0.85, 0.45]),
        mk('mirror', 'bath', 'mirror', 'east', 0.5, [0.5, 0.7, 0.04]),
        mk('table', 'bath', 'bedside-table', 'south', 0.8, [0.45, 0.55, 0.4]),
        mk('lamp', 'bath', 'lamp', 'south', 0.8, [0.2, 0.4, 0.2]),
      ],
      prov,
    );
    expect(rejected).toEqual([]);
    const by = Object.fromEntries(objects.map((o) => [o.id, o]));
    expect(by.mirror.positionXYZ[1] - 0.35).toBeGreaterThanOrEqual(0.95);
    expect(by.lamp.positionXYZ[1] - 0.2).toBeCloseTo(0.55, 2);
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
