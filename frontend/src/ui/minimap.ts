/**
 * Floor-plan mini-map over the 3D view: rooms of one floor from the scene's
 * structure, the selected room, and (while walking) where you are and which
 * way you face. Click a room to select it, or to walk there.
 */
import type { World } from '@iwsdk/core';
import { Vector3 } from 'three';
import type { SceneManifest } from '../shared/index.js';
import { app } from '../state.js';
import { mounted } from '../systems/dollhouse.js';
import { enterRoom } from '../systems/walkthrough.js';
import { esc } from './importer.js';

export class Minimap {
  private el: HTMLElement;
  private levelId: string | null = null;
  private dir = new Vector3();
  private raf = 0;

  constructor(private world: World) {
    this.el = document.createElement('div');
    this.el.id = 'minimap';
    this.el.hidden = true;
    document.getElementById('stage')!.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = (e.target as Element).closest('[data-mm]') as HTMLElement | SVGElement | null;
      if (!t) return;
      const d = (t as HTMLElement).dataset;
      if (d.mm === 'level') {
        this.levelId = d.level ?? null;
        return this.render();
      }
      if (d.mm === 'room' && d.room) {
        if (app.mode.value === 'walk') enterRoom(this.world, d.room);
        else app.selectedRoomId.value = d.room;
      }
      if (d.mm === 'toggle') this.el.classList.toggle('small');
    });
    for (const s of [app.scene, app.selectedRoomId, app.mode, app.walkLevelId]) s.subscribe(() => this.render());
  }

  show(on: boolean) {
    this.el.hidden = !on;
    if (on) this.render();
  }

  private level(s: SceneManifest) {
    const sel = s.structure.rooms.find((r) => r.id === app.selectedRoomId.value);
    const want = app.mode.value === 'walk' ? app.walkLevelId.value : (this.levelId ?? sel?.levelId);
    return s.structure.levels.find((l) => l.id === want) ?? [...s.structure.levels].sort((a, b) => a.index - b.index)[0];
  }

  render() {
    const s = app.scene.value;
    if (!s || this.el.hidden) return;
    const lvl = this.level(s);
    const rooms = s.structure.rooms.filter((r) => r.levelId === lvl.id);
    const pts = rooms.flatMap((r) => r.polygonXZMeters);
    const minX = Math.min(...pts.map((p) => p[0])) - 0.5;
    const minZ = Math.min(...pts.map((p) => p[1])) - 0.5;
    const w = Math.max(...pts.map((p) => p[0])) - minX + 0.5;
    const h = Math.max(...pts.map((p) => p[1])) - minZ + 0.5;
    const doors = s.structure.openings.filter((o) => o.levelId === lvl.id && (o.type === 'door' || o.type === 'archway'));
    this.el.innerHTML = `
      <div class="mm-head">${s.structure.levels.length > 1 ? s.structure.levels.map((l) => `<button data-mm="level" data-level="${esc(l.id)}" class="${l.id === lvl.id ? 'on' : ''}" ${app.mode.value === 'walk' ? 'disabled' : ''}>${esc(l.name.replace(/ floor$/i, ''))}</button>`).join('') : `<span>${esc(lvl.name)}</span>`}<button data-mm="toggle" aria-label="Resize map">⤢</button></div>
      <svg viewBox="${minX} ${minZ} ${w} ${h}" preserveAspectRatio="xMidYMid meet">
        ${rooms
          .map((r) => {
            const c = r.spawnPoint;
            const on = r.id === app.selectedRoomId.value;
            return `<g data-mm="room" data-room="${esc(r.id)}" class="mm-room ${on ? 'on' : ''} ${r.isEstimated ? 'est' : ''}"><polygon points="${r.polygonXZMeters.map((p) => p.join(',')).join(' ')}" /><text x="${c[0]}" y="${c[1]}" font-size="${Math.min(0.42, Math.max(0.22, Math.sqrt(r.areaSqM) / 9))}">${esc(r.label)}</text></g>`;
          })
          .join('')}
        ${doors.map((d) => `<circle class="mm-door" cx="${d.position[0]}" cy="${d.position[1]}" r="0.14" />`).join('')}
        <g id="mm-me" style="display:none"><circle r="0.28" /><path d="M0 0 L0 -0.8" /></g>
      </svg>`;
    cancelAnimationFrame(this.raf);
    if (app.mode.value === 'walk') this.track();
  }

  /** Follow the walker: position from the player rig, heading from the camera. */
  private track() {
    const me = this.el.querySelector('#mm-me') as SVGGElement | null;
    const m = mounted(this.world);
    if (!me || !m || app.mode.value !== 'walk' || this.el.hidden) return;
    const x = this.world.player.position.x + m.build.centre[0];
    const z = this.world.player.position.z + m.build.centre[1];
    this.world.camera.getWorldDirection(this.dir);
    const deg = (Math.atan2(this.dir.x, -this.dir.z) * 180) / Math.PI;
    me.style.display = '';
    me.setAttribute('transform', `translate(${x} ${z}) rotate(${deg})`);
    this.raf = requestAnimationFrame(() => this.track());
  }
}
