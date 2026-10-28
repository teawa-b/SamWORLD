/**
 * Wires the in-headset UIKitML panel to app state. Hidden outside XR (the
 * desktop has the HTML panel). While walking, the panel follows the head.
 */
import { Follower, FollowBehavior, VisibilityState, createSystem, type UIKit, type UIKitMLAsset } from '@iwsdk/core';
import { app, floorsSeparated, resetBuilding, separateFloors } from '../state.js';
import { changeLevel, enterRoom, exitRoom } from './walkthrough.js';

export class MenuSystem extends createSystem({}) {
  init() {
    const panel = this.world.getSceneObject<UIKitMLAsset>('property-menu');
    if (!panel) return;
    const entity = this.world.getSceneEntity('property-menu') ?? null;
    const el = (id: string) => panel.getElementById<UIKit.Text>(id);
    const on = (id: string, fn: () => void) => {
      const b = el(id);
      if (!b) return;
      b.addEventListener('click', fn);
      this.cleanupFuncs.push(() => b.removeEventListener('click', fn));
    };
    const status = el('status');

    on('btn-separate', () => separateFloors(!floorsSeparated()));
    on('btn-reset', () => resetBuilding());
    on('btn-roof', () => (app.roofHidden.value = !app.roofHidden.value));
    on('btn-walls', () => (app.wallsHidden.value = !app.wallsHidden.value));
    on('btn-furniture', () => (app.furnitureHidden.value = !app.furnitureHidden.value));
    on('btn-night', () => (app.night.value = !app.night.value));
    on('btn-evidence', () => (app.evidenceView.value = !app.evidenceView.value));
    on('btn-enter', () => {
      const id = app.selectedRoomId.value;
      if (id) enterRoom(this.world, id);
    });
    on('btn-exit', () => exitRoom(this.world));
    on('btn-up', () => changeLevel(this.world, 1));
    on('btn-down', () => changeLevel(this.world, -1));
    on('btn-exit-xr', () => this.world.exitXR());

    const refresh = () => {
      const room = app.scene.value?.structure.rooms.find((r) => r.id === app.selectedRoomId.value);
      const text =
        app.mode.value === 'walk'
          ? `Walking: ${app.scene.value?.structure.levels.find((l) => l.id === app.walkLevelId.value)?.name ?? ''}. Left stick move, right stick turn.`
          : room
            ? `Selected: ${room.label} (${room.areaSqM.toFixed(1)} m²${room.isEstimated ? ', estimated' : ''})`
            : 'Point at a floor and pull the trigger to select a room';
      status?.setProperties({ text });
      for (const id of ['btn-enter']) el(id)?.setProperties({ display: app.mode.value === 'dollhouse' && room ? 'flex' : 'none' });
      for (const id of ['btn-exit', 'btn-up', 'btn-down']) el(id)?.setProperties({ display: app.mode.value === 'walk' ? 'flex' : 'none' });
      for (const id of ['btn-separate', 'btn-roof', 'btn-walls']) el(id)?.setProperties({ display: app.mode.value === 'dollhouse' ? 'flex' : 'none' });
    };
    this.cleanupFuncs.push(app.selectedRoomId.subscribe(refresh), app.mode.subscribe(refresh), app.walkLevelId.subscribe(refresh));

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        const xr = state !== VisibilityState.NonImmersive;
        app.inXR.value = xr;
        const obj = entity?.object3D;
        if (obj) obj.visible = xr;
      }),
      app.mode.subscribe((mode) => {
        if (!entity) return;
        if (mode === 'walk' && !entity.hasComponent(Follower)) {
          entity.addComponent(Follower, { target: this.player.head, offsetPosition: [0.3, -0.25, -0.6], behavior: FollowBehavior.PivotY, maxAngle: 35, tolerance: 0.4, speed: 1 });
        } else if (mode === 'dollhouse' && entity.hasComponent(Follower)) {
          entity.removeComponent(Follower);
          entity.object3D?.position.set(-0.6, 1.3, -0.62);
          entity.object3D?.rotation.set(0, (40 * Math.PI) / 180, 0);
        }
      }),
    );
  }
}
