import { createComponent, defineComponents, Types } from '@iwsdk/core';

/** Grab disc under the dollhouse; the house follows its transform. */
export const Plinth = createComponent('Plinth', {});
/** One-hand handle that lifts a level (and everything above it). */
export const LevelHandle = createComponent('LevelHandle', {
  levelIndex: { type: Types.Int16, default: 0 },
  baseY: { type: Types.Float32, default: 0 },
});
export const RoomFloor = createComponent('RoomFloor', { roomId: { type: Types.String, default: '' } });
export const WallPanel = createComponent('WallPanel', { wallId: { type: Types.String, default: '' } });
export const PropertyRoot = createComponent('PropertyRoot', {});
/** Tap-to-move look-around point. */
export const Hotspot = createComponent('Hotspot', { viewpointId: { type: Types.String, default: '' } });

export default defineComponents([Plinth, LevelHandle, RoomFloor, WallPanel, PropertyRoot, Hotspot]);
