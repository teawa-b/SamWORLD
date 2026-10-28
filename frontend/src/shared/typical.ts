/**
 * Typical furniture for a room type, used only where there is no photo
 * evidence (e.g. listings without photos, or rooms nobody photographed).
 * Labelled as typical, never as observed; the placement engine still checks
 * every item against walls, doors and other furniture.
 */
import type { PlacementCandidate, Provenance, Room, Structure, Vec3, WallSide } from './schemas.js';

type Item = [kind: string, anchor: PlacementCandidate['anchor'], size: Vec3];
const wall = (side: WallSide, along = 0.5): PlacementCandidate['anchor'] => ({ type: 'against-wall', side, along });

const TYPICAL: Partial<Record<Room['type'], Item[]>> = {
  living: [
    ['sofa', wall('west'), [2.0, 0.85, 0.9]],
    ['tv-unit', wall('east'), [1.4, 0.5, 0.42]],
    ['coffee-table', { type: 'centre' }, [1.0, 0.42, 0.55]],
    ['armchair', wall('north', 0.85), [0.8, 0.9, 0.8]],
  ],
  kitchen: [
    ['kitchen-units', wall('north', 0.4), [2.4, 0.9, 0.6]],
    ['fridge', wall('north', 0.95), [0.65, 1.8, 0.65]],
    ['dining-table', { type: 'centre' }, [1.4, 0.75, 0.85]],
  ],
  dining: [['dining-table', { type: 'centre' }, [1.6, 0.75, 0.9]]],
  bedroom: [
    ['bed', wall('north', 0.5), [1.4, 0.6, 2.0]],
    ['wardrobe', wall('east', 0.3), [1.0, 2.0, 0.6]],
  ],
  bathroom: [
    ['bathtub', wall('west'), [1.7, 0.55, 0.7]],
    ['basin', wall('east'), [0.55, 0.85, 0.42]],
    ['toilet', wall('north', 0.8), [0.4, 0.8, 0.68]],
  ],
  wc: [
    ['toilet', wall('north', 0.5), [0.4, 0.8, 0.68]],
    ['basin', wall('east'), [0.45, 0.85, 0.35]],
  ],
  study: [['desk', wall('north'), [1.2, 0.75, 0.6]]],
  utility: [['washing-machine', wall('north'), [0.6, 0.85, 0.6]]],
};

const OPPOSITE: Record<WallSide, WallSide> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/** Walls of the room that have a door or archway on them. */
function doorSides(room: Room, structure: Structure): Set<WallSide> {
  const xs = room.polygonXZMeters.map((p) => p[0]);
  const zs = room.polygonXZMeters.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const sides = new Set<WallSide>();
  for (const o of structure.openings) {
    if (!o.roomIds.includes(room.id) || (o.type !== 'door' && o.type !== 'archway')) continue;
    const [x, z] = o.position;
    const d: [WallSide, number][] = [['north', Math.abs(z - z0)], ['south', Math.abs(z - z1)], ['west', Math.abs(x - x0)], ['east', Math.abs(x - x1)]];
    sides.add(d.sort((a, b) => a[1] - b[1])[0][0]);
  }
  return sides;
}

export function typicalFurniture(room: Room, at: string, structure?: Structure): PlacementCandidate[] {
  const prov: Provenance = { method: 'deterministic', note: `typical furniture for a ${room.type}; not observed in photos`, at };
  const doors = structure ? doorSides(room, structure) : new Set<WallSide>();
  // Keep big items off walls with doors: mirror to the opposite wall when it is free.
  const side = (a: PlacementCandidate['anchor']): PlacementCandidate['anchor'] =>
    a.type === 'against-wall' && doors.has(a.side) && !doors.has(OPPOSITE[a.side]) ? { ...a, side: OPPOSITE[a.side] } : a;
  return (TYPICAL[room.type] ?? []).map(([kind, anchor, size], i) => ({
    id: `${room.id}-typical-${i}-${kind}`,
    roomId: room.id,
    kind,
    anchor: side(anchor),
    sizeM: size,
    sourceDetectionIds: [],
    sourceMediaIds: [],
    confidence: 0.3,
    rationale: `Typical ${kind.replace(/-/g, ' ')} for a ${room.type}; no photo of this room was available.`,
    provenance: prov,
  }));
}
