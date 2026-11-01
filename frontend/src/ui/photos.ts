/**
 * Source-photo viewer: the listing photo next to what WalkIn made of it —
 * which room it was matched to (by whom, how confidently, on what evidence)
 * and the objects SAM 3.1 found in it. "View in 3D" jumps into that room.
 */
import type { SceneManifest } from '../shared/index.js';
import { absoluteApiUrl, mediaUrl, staticMode } from '../api.js';
import { esc } from './importer.js';
import { icon } from './icons.js';

const METHOD: Record<string, string> = {
  'meta:muse-spark-1.3': 'Meta Muse Spark',
  'meta:muse-wonder-1.0': 'Meta Muse Wonder',
  'admin-correction': 'you (manual label)',
  'fixture:hand-authored': 'demo data',
};

export class PhotoViewer {
  private el: HTMLElement | null = null;
  private ids: string[] = [];
  private i = 0;
  private showBoxes = true;

  constructor(private onViewRoom: (roomId: string) => void) {}

  open(scene: SceneManifest, mediaIds: string[], start = 0) {
    this.ids = mediaIds;
    this.i = Math.max(0, Math.min(start, mediaIds.length - 1));
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.id = 'photo-viewer';
      this.el.setAttribute('role', 'dialog');
      document.body.appendChild(this.el);
      this.el.addEventListener('click', (e) => {
        const t = (e.target as HTMLElement).closest('[data-pv]') as HTMLElement | null;
        if (!t && e.target === this.el) return this.close();
        if (!t) return;
        const a = t.dataset.pv;
        if (a === 'close') this.close();
        if (a === 'prev') this.go(scene, -1);
        if (a === 'next') this.go(scene, 1);
        if (a === 'boxes') {
          this.showBoxes = !this.showBoxes;
          this.render(scene);
        }
        if (a === 'room' && t.dataset.room) {
          this.close();
          this.onViewRoom(t.dataset.room);
        }
      });
      window.addEventListener('keydown', (e) => {
        if (!this.el?.isConnected || this.el.hidden) return;
        if (e.key === 'Escape') this.close();
        if (e.key === 'ArrowLeft') this.go(scene, -1);
        if (e.key === 'ArrowRight') this.go(scene, 1);
      });
    }
    this.el.hidden = false;
    this.render(scene);
  }

  close() {
    if (this.el) this.el.hidden = true;
  }

  private go(scene: SceneManifest, d: number) {
    this.i = (this.i + d + this.ids.length) % this.ids.length;
    this.render(scene);
  }

  private render(s: SceneManifest) {
    const m = s.media.find((x) => x.id === this.ids[this.i]);
    if (!m || !this.el) return;
    const match = s.mediaMatches.find((x) => x.mediaId === m.id);
    const room = s.structure.rooms.find((r) => r.id === match?.roomId);
    const dets = s.detections.filter((d) => d.mediaId === m.id);
    const used = s.objects.filter((o) => o.sourceMediaIds.includes(m.id));
    this.el.innerHTML = `
      <div class="pv-card">
        <div class="pv-img">
          <img src="${esc(mediaUrl(m))}" alt="Listing photo" />
          ${this.showBoxes ? dets.map((d) => `${d.maskKey && !staticMode ? `<img class="mask" src="${esc(absoluteApiUrl(`/api/masks/${d.maskKey.split('/').pop()}`))}" alt="" />` : ''}<span class="box" style="left:${d.box[0] * 100}%;top:${d.box[1] * 100}%;width:${(d.box[2] - d.box[0]) * 100}%;height:${(d.box[3] - d.box[1]) * 100}%"><i>${esc(d.concept)}</i></span>`).join('') : ''}
          ${this.ids.length > 1 ? `<button class="pv-nav l" data-pv="prev" aria-label="Previous photo">${icon('back')}</button><button class="pv-nav r" data-pv="next" aria-label="Next photo">${icon('chevron')}</button>` : ''}
        </div>
        <div class="pv-info">
          <div class="pv-top"><b>${room ? esc(room.label) : 'Not matched to a room'}</b><span class="faint">${this.i + 1} / ${this.ids.length}</span><button class="icon-btn" data-pv="close" aria-label="Close">${icon('close')}</button></div>
          ${match ? `<p class="xs muted">Matched by ${esc(METHOD[match.provenance.method] ?? match.provenance.method)} · ${Math.round(match.confidence * 100)}% confident</p>${match.evidence.length ? `<ul class="xs pv-ev">${match.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}` : '<p class="xs muted">No room assignment. Fix it on the Rooms tab.</p>'}
          ${dets.length ? `<p class="xs"><b>Found by SAM 3.1:</b> ${esc([...new Set(dets.map((d) => d.concept))].join(', '))} <button class="linkish" data-pv="boxes">${this.showBoxes ? 'hide' : 'show'} outlines</button></p>` : '<p class="xs faint">No segmentation for this photo (SAM 3.1 runs only with the AI configured).</p>'}
          ${used.length ? `<p class="xs"><b>In the 3D room from this photo:</b> ${esc(used.map((o) => o.kind).join(', '))}</p>` : ''}
          ${room ? `<button class="btn primary block" data-pv="room" data-room="${esc(room.id)}">${icon('walk')}View this room in 3D</button>` : ''}
          <p class="xs faint">The 3D room is a reconstruction: walls come from the floor plan, furniture positions are estimates. Surfaces not visible in any photo use default finishes.</p>
        </div>
      </div>`;
  }
}
