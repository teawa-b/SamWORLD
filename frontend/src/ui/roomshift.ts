/**
 * Roomshift UI (step 1 of DETAIL.md): capture a room → MapAnything → see it in 3D at real scale.
 * The prompt → repaint steps plug in after this.
 */
import type { World } from '@iwsdk/core';
import { BufferGeometry, Float32BufferAttribute, Group, Points, PointsMaterial } from 'three';
import { parsePly } from '../shared/index.js';
import { icon } from './icons.js';
import { focusOrbit } from '../systems/walkthrough.js';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Scan {
  id: string;
  title: string;
  frames: { file: string }[];
  state: 'collecting' | 'reconstructing' | 'ready' | 'failed';
  message: string;
  cloud: { file: string; points: number } | null;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  cameras: unknown[];
  timings: Record<string, number>;
  model: string | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? res.statusText);
  return body as T;
}

/** ~1.5 frames per second of video (12–40 frames), longest side ≤ 1024 px, as JPEG blobs. */
export async function framesFromVideo(file: File, onProgress: (n: number, total: number) => void): Promise<Blob[]> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.src = url;
  await new Promise<void>((res, rej) => {
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error('This video format can’t be read by the browser. Try MP4 or upload photos instead.'));
  });
  const total = Math.max(12, Math.min(40, Math.round(v.duration * 1.5)));
  const scale = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  const g = c.getContext('2d')!;
  const out: Blob[] = [];
  for (let i = 0; i < total; i++) {
    v.currentTime = ((i + 0.5) / total) * v.duration;
    await new Promise<void>((res) => (v.onseeked = () => res()));
    g.drawImage(v, 0, 0, c.width, c.height);
    out.push(await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.88)));
    onProgress(i + 1, total);
  }
  URL.revokeObjectURL(url);
  return out;
}

export class RoomshiftPanel {
  private body: HTMLElement;
  private scan: Scan | null = null;
  private status = '';
  private busy = false;
  private cloud: Group | null = null;
  private poll: number | null = null;

  constructor(
    private world: World,
    root: HTMLElement,
  ) {
    this.body = root.querySelector('#panel-body') as HTMLElement;
    this.body.addEventListener('change', (e) => void this.onChange(e));
    this.body.addEventListener('click', (e) => void this.onClick(e));
  }

  async start() {
    const id = new URLSearchParams(location.search).get('scan');
    if (id) {
      this.scan = (await call<{ scan: Scan }>(`/api/scans/${id}`).catch(() => ({ scan: null as unknown as Scan }))).scan;
      if (this.scan) this.follow();
    }
    this.render();
  }

  private render() {
    const s = this.scan;
    const brand = `<div class="desktop-brand"><span class="logo">${icon('cube', 18)}</span>Roomshift</div>`;
    if (!s || s.state === 'collecting') {
      this.body.innerHTML = `${brand}
        <div class="eyebrow">Step 1 · Scan your room</div>
        <h1>Type a world. Your room becomes it.</h1>
        <p class="lede">Film a slow 20–40 second walk around a room, holding your phone at chest height and turning to see every wall. Meta’s MapAnything rebuilds it in 3D at its real size.</p>
        <div class="drop" data-action="pick" tabindex="0" role="button">${icon('photo', 26)}<b>${this.busy ? esc(this.status) : 'Choose a video (or 15–40 photos)'}</b><span class="xs muted">MP4/MOV video, or JPG/PNG/WebP photos with lots of overlap</span></div>
        <input type="file" id="capture" accept="video/*,image/jpeg,image/png,image/webp" multiple hidden />
        ${this.status && !this.busy ? `<div class="callout">${icon('alert')}<div>${esc(this.status)}</div></div>` : ''}
        <p class="xs faint" style="margin-top:14px">Frames are taken from the video in your browser; only those stills are uploaded.</p>`;
      return;
    }
    const sec = (k: string) => (s.timings[k] != null ? `${s.timings[k]} s` : '—');
    this.body.innerHTML = `${brand}
      <div class="view-head"><button class="icon-btn" data-action="new" aria-label="New scan">${icon('back')}</button><div class="grow"><div class="sub">${esc(s.title)} · ${s.frames.length} frames</div></div></div>
      ${s.state === 'reconstructing' ? `<div class="hint">${icon('cube')}<span>${esc(s.message)}</span></div><div class="progress"><div style="width:60%" class="indeterminate"></div></div>` : ''}
      ${s.state === 'failed' ? `<div class="callout">${icon('alert')}<div><b>Reconstruction failed.</b> ${esc(s.message)}</div></div><button class="btn block" data-action="retry">Try again</button>` : ''}
      ${s.state === 'ready' ? `<h2>Your room in 3D</h2><p class="small muted">${esc(s.message)}</p>
        <ul class="flags"><li><span>Model</span><span>${esc(s.model)}</span></li><li><span>GPU time</span><span>${sec('inferSeconds')}</span></li><li><span>Total</span><span>${sec('totalSeconds')}</span></li><li><span>Points</span><span>${s.cloud?.points.toLocaleString()}</span></li></ul>
        <p class="xs faint">Drag to orbit, scroll to zoom. Next: type a world and watch the room repaint.</p>` : ''}`;
  }

  private async onChange(e: Event) {
    const el = e.target as HTMLInputElement;
    if (el.id !== 'capture' || !el.files?.length) return;
    const files = [...el.files];
    el.value = '';
    this.busy = true;
    try {
      let frames: Blob[];
      if (files.length === 1 && files[0].type.startsWith('video/')) {
        frames = await framesFromVideo(files[0], (n, t) => this.setStatus(`Taking frames from the video… ${n}/${t}`));
      } else {
        frames = files.filter((f) => f.type.startsWith('image/')).slice(0, 60);
        if (frames.length < 4) throw new Error('Choose a video, or at least 4 photos.');
      }
      const { scan } = await call<{ scan: Scan }>('/api/scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: files[0].name.replace(/\.[^.]+$/, '') }) });
      for (const [i, b] of frames.entries()) {
        this.setStatus(`Uploading frames… ${i + 1}/${frames.length}`);
        await call(`/api/scans/${scan.id}/frames`, { method: 'POST', headers: { 'content-type': b.type || 'image/jpeg' }, body: b });
      }
      this.setStatus('Starting MapAnything…');
      this.scan = (await call<{ scan: Scan }>(`/api/scans/${scan.id}/reconstruct`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).scan;
      history.replaceState(null, '', `?scan=${scan.id}`);
      this.busy = false;
      this.follow();
    } catch (err) {
      this.busy = false;
      this.status = (err as Error).message;
    }
    this.render();
  }

  private setStatus(s: string) {
    this.status = s;
    this.render();
  }

  private async onClick(e: Event) {
    const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'pick') (this.body.querySelector('#capture') as HTMLInputElement).click();
    if (a === 'new') {
      this.scan = null;
      this.status = '';
      this.clearCloud();
      history.replaceState(null, '', location.pathname);
      this.render();
    }
    if (a === 'retry' && this.scan) {
      try {
        this.scan = (await call<{ scan: Scan }>(`/api/scans/${this.scan.id}/reconstruct`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).scan;
        this.follow();
      } catch (err) {
        this.scan!.message = (err as Error).message;
      }
      this.render();
    }
  }

  /** Poll the scan until it is ready, then show the point cloud. */
  private follow() {
    if (this.poll) clearInterval(this.poll);
    const tick = async () => {
      if (!this.scan) return;
      this.scan = (await call<{ scan: Scan }>(`/api/scans/${this.scan.id}`)).scan;
      if (this.scan.state !== 'reconstructing') {
        clearInterval(this.poll!);
        this.poll = null;
        if (this.scan.state === 'ready') await this.showCloud();
      }
      this.render();
    };
    void tick();
    this.poll = window.setInterval(tick, 2000);
  }

  private clearCloud() {
    this.cloud?.removeFromParent();
    this.cloud = null;
  }

  private async showCloud() {
    const s = this.scan!;
    const buf = await (await fetch(`${BASE}/api/scans/${s.id}/cloud.ply`)).arrayBuffer();
    const pc = parsePly(buf, { maxPoints: 600_000 });
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pc.positions, 3));
    geo.setAttribute('color', new Float32BufferAttribute(pc.colors, 3));
    this.clearCloud();
    this.cloud = new Group();
    this.cloud.name = 'ScanCloud';
    this.cloud.add(new Points(geo, new PointsMaterial({ size: 0.012, vertexColors: true })));
    this.world.scene.add(this.cloud);
    const b = s.bounds!;
    const c: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    focusOrbit(this.world, c, Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], 2));
  }
}
