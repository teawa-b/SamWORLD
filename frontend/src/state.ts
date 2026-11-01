/**
 * App-wide reactive state shared by the DOM UI, the XR menu and ECS systems.
 * Signals come from IWSDK's bundled @preact/signals-core.
 */
import { signal } from '@iwsdk/core';
import type { SceneManifest } from './shared/index.js';

export type ViewMode = 'dollhouse' | 'walk';

export const app = {
  scene: signal<SceneManifest | null>(null),
  mode: signal<ViewMode>('dollhouse'),
  /** Per-level lift (house meters) requested by buttons; handles write it too. */
  levelLift: signal<number[]>([]),
  roofHidden: signal(false),
  wallsHidden: signal(false),
  pulledWalls: signal<string[]>([]),
  furnitureHidden: signal(false),
  night: signal(false),
  evidenceView: signal(false),
  /** Desktop: clicking a wall pulls it out only while this is on. */
  wallMode: signal(false),
  selectedRoomId: signal<string | null>(null),
  walkLevelId: signal<string | null>(null),
  /** Incremented to ask systems to snap everything back to defaults. */
  resetTick: signal(0),
  inXR: signal(false),
  /** Furniture picked in the viewer (object id). */
  selectedObjectId: signal<string | null>(null),
  /** Furniture hidden in this browser only (not saved). */
  hiddenObjectIds: signal<string[]>([]),
  /** Unsaved moves/turns, by object id (plan metres / radians). */
  objectEdits: signal<Record<string, { x: number; z: number; rotationY: number }>>({}),
};

export const EXPLODE_LIFT_M = 4;

export function separateFloors(on: boolean) {
  const s = app.scene.value;
  if (!s) return;
  app.levelLift.value = s.structure.levels.map((l) => (on && l.index > 0 ? EXPLODE_LIFT_M : 0));
}

export function floorsSeparated(): boolean {
  return app.levelLift.value.some((v) => v > 0.1);
}

export function resetBuilding() {
  app.levelLift.value = app.levelLift.value.map(() => 0);
  app.roofHidden.value = false;
  app.wallsHidden.value = false;
  app.pulledWalls.value = [];
  app.furnitureHidden.value = false;
  app.resetTick.value++;
}

export function toggleWall(wallId: string) {
  const cur = app.pulledWalls.value;
  app.pulledWalls.value = cur.includes(wallId) ? cur.filter((w) => w !== wallId) : [...cur, wallId];
}
