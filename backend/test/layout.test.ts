import { describe, expect, it } from 'vitest';
import { buildStructure, computeViewpoints, layoutFromRoomList, placeObjects, typicalFurniture, roomListFromFacts, verifyGeometry, type Provenance } from '../src/shared/index.js';

const prov: Provenance = { method: 'deterministic', note: 'test', at: '' };
const build = (facts: Parameters<typeof roomListFromFacts>[0]) => {
  const interp = layoutFromRoomList({ rooms: roomListFromFacts(facts), statedTotalAreaSqM: facts.areaSqM, provenance: prov, confidence: 0.3 });
  const structure = buildStructure(interp, { propertyId: 'p', scaleOverride: { metersPerPx: 0.01, method: 'estimated-layout' } });
  return { interp, structure, checks: verifyGeometry(structure, interp, [], [], facts.areaSqM) };
};

describe('estimated layouts (no floor plan)', () => {
  it('builds a valid single-floor flat from listing facts', () => {
    const { structure, checks } = build({ bedrooms: 2, bathrooms: 1, areaSqM: 70, propertyType: 'Flat' });
    expect(structure.levels).toHaveLength(1);
    expect(structure.rooms.map((r) => r.type).sort()).toEqual(['bathroom', 'bedroom', 'bedroom', 'hall', 'living']);
    expect(checks.filter((c) => c.severity === 'fail')).toEqual([]);
    expect(checks.find((c) => c.id === 'connectivity')?.severity).toBe('pass');
    expect(structure.scale.estimated).toBe(true);
    expect(structure.rooms.every((r) => r.isEstimated)).toBe(true);
    const total = structure.rooms.reduce((a, r) => a + r.areaSqM, 0);
    expect(total).toBeGreaterThan(60);
    expect(total).toBeLessThan(85);
  });

  it('builds a two-floor house with stairs and every room reachable', () => {
    const { structure, checks } = build({ bedrooms: 3, bathrooms: 2, areaSqM: 110, propertyType: 'Semi-detached house' });
    expect(structure.levels).toHaveLength(2);
    expect(structure.levels[1].stairVoids).toHaveLength(1);
    expect(checks.filter((c) => c.severity === 'fail')).toEqual([]);
    expect(checks.find((c) => c.id === 'connectivity')?.severity).toBe('pass');
    const vps = computeViewpoints(structure);
    expect(vps.filter((v) => v.kind === 'stairs')).toHaveLength(2);
    for (const r of structure.rooms) expect(vps.some((v) => v.roomId === r.id)).toBe(true);
  });

  it('handles a studio and a large house', () => {
    for (const f of [{ bedrooms: 0, bathrooms: 1, areaSqM: 28 }, { bedrooms: 5, bathrooms: 3, areaSqM: 220, propertyType: 'Detached house' }]) {
      const { checks } = build(f);
      expect(checks.filter((c) => c.severity === 'fail'), JSON.stringify(f)).toEqual([]);
    }
  });

  it('places typical furniture in estimated rooms without blocking doors', () => {
    const { structure } = build({ bedrooms: 3, bathrooms: 2, areaSqM: 110, propertyType: 'Terraced house' });
    const cands = structure.rooms.flatMap((r) => typicalFurniture(r, '', structure));
    const placed = placeObjects(structure, cands, prov);
    const ok = placed.objects.length;
    expect(ok).toBeGreaterThan(cands.length * 0.7);
    expect(structure.rooms.filter((r) => r.type === 'bedroom').every((r) => placed.objects.some((o) => o.roomId === r.id && o.kind === 'bed'))).toBe(true);
  });
});
