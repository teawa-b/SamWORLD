/**
 * Roomshift UI (DETAIL.md): capture a room → MapAnything → your room in 3D at real scale → type a world →
 * Muse Spark plans it → Muse Image paints walls, floor and ceiling, spreading across the room as each lands.
 */
import type { World } from '@iwsdk/core';
import { filmingStart, type RoomShell } from '../shared/index.js';
import { RoomScene, paintOrigin, type RoomObject, type SurfaceId } from '../scene/roomshift-scene.js';
import { app } from '../state.js';
import { enterScanWalk, exitRoom, focusOrbit, scanXR } from '../systems/walkthrough.js';
import { icon } from './icons.js';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Which kind of headset session was asked for (set by the AR button, read when the session starts). */
export const xrMode = { ar: false };

const EXAMPLES = ['haunted Victorian library', 'underwater coral cave', '1970s Tokyo arcade', 'enchanted forest cabin', 'spaceship bridge', 'Egyptian tomb'];

interface Scan {
  id: string;
  title: string;
  frames: { file: string }[];
  state: 'collecting' | 'reconstructing' | 'ready' | 'failed';
  message: string;
  cloud: { file: string; points: number } | null;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  cameras: { pose: number[]; intrinsics: [number, number, number, number]; width: number; height: number }[];
  timings: Record<string, number>;
  model: string | null;
  shell?: RoomShell | null;
  photoWalls?: { id: string; file: string }[];
  updatedAt?: string;
  objects?: (RoomObject & { label: string; views: number; crop: string | null })[];
  objectsStatus?: { state: 'running' | 'done' | 'failed' | 'skipped'; message: string; usage: string };
}

interface Restyle {
  id: string;
  prompt: string;
  state: 'planning' | 'painting' | 'done' | 'failed';
  message: string;
  offline: boolean;
  plan: {
    title: string;
    brief: string;
    surfaces: Record<SurfaceId, { prompt: string; colorHex: string; tileMetres: number }>;
    light: { colorHex: string; intensity: number };
    fogHex: string;
  } | null;
  surfaces: { id: SurfaceId; state: 'pending' | 'running' | 'done' | 'failed'; texture: string | null; model: string | null; error: string | null; seconds: number | null }[];
  objects?: { id: string; name: string; instruction: string; state: 'pending' | 'restyling' | 'lifting' | 'done' | 'failed'; image: string | null; model: string | null; format: string | null; error: string | null; seconds: number | null }[];
  models: string[];
  usage: string;
  createdAt: string;
  /** The room as filmed, rebuilt in 3D (no new world). */
  original?: boolean;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? res.statusText);
  return body as T;
}
const postJson = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

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
  private poll: number | null = null;
  private rpoll: number | null = null;
  private room: RoomScene;
  private restyle: Restyle | null = null;
  private history: Restyle[] = [];
  private origin: ReturnType<typeof paintOrigin> | null = null;
  private phase = '';
  private prompt = '';
  private error = '';
  private shown: string | null = null;
  private selected: string | null = null;
  private boxesOn = true;
  /** Hide the scan's points (surfaces, pictures and 3D furniture only). */
  private cleanView = false;

  constructor(
    private world: World,
    root: HTMLElement,
  ) {
    this.body = root.querySelector('#panel-body') as HTMLElement;
    this.room = new RoomScene(world);
    this.body.addEventListener('change', (e) => void this.onChange(e));
    this.body.addEventListener('click', (e) => void this.onClick(e));
    this.body.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.id === 'rs-prompt') this.prompt = el.value;
    });
    this.body.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.shift(this.prompt);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && app.mode.value === 'walk') this.leaveWalk();
    });
    // Headset: line the room up with the real one (1:1) from where filming began; AR shows only the new world.
    app.inXR.subscribe((xr) => {
      scanXR.active = xr && !!this.scan?.shell && !this.scan.shell.fallback;
      scanXR.pending = scanXR.active;
      this.room.setHeadset(xr);
      this.room.setPassthrough(xr && xrMode.ar);
      if (!xr) xrMode.ar = false;
    });
  }

  async start() {
    const id = new URLSearchParams(location.search).get('scan');
    if (id) {
      this.scan = (await call<{ scan: Scan }>(`/api/scans/${id}`).catch(() => ({ scan: null as unknown as Scan }))).scan;
      if (this.scan) this.follow();
    }
    this.render();
  }

  // ------------------------------------------------------------------------------------------ rendering

  /** Full render when the screen changes; otherwise only the live part, so typing isn't interrupted. */
  private render() {
    const s = this.scan;
    const phase = !s || s.state === 'collecting' ? `capture:${this.busy}` : s.state;
    if (phase !== this.phase || !this.body.querySelector('#rs-live')) {
      this.phase = phase;
      this.renderAll();
    }
    const live = this.body.querySelector('#rs-live');
    if (live) live.innerHTML = this.liveHtml();
  }

  private renderAll() {
    const s = this.scan;
    const brand = `<div class="desktop-brand"><span class="logo">${icon('cube', 18)}</span>Roomshift</div>`;
    if (!s || s.state === 'collecting') {
      this.body.innerHTML = `${brand}
        <div class="eyebrow">Step 1 · Scan your room</div>
        <h1>Type a world. Your room becomes it.</h1>
        <p class="lede">Film a slow 20–40 second walk around a room, holding your phone at chest height and turning to see every wall. Meta’s MapAnything rebuilds it in 3D at its real size.</p>
        <div id="rs-live"></div>
        <input type="file" id="capture" accept="video/*,image/jpeg,image/png,image/webp" multiple hidden />
        <p class="xs faint" style="margin-top:14px">Frames are taken from the video in your browser; only those stills are uploaded.</p>`;
      return;
    }
    const head = `${brand}<div class="view-head"><button class="icon-btn" data-action="new" aria-label="New scan">${icon('back')}</button><div class="grow"><div class="sub">${esc(s.title)} · ${s.frames.length} frames</div></div></div>`;
    if (s.state !== 'ready') {
      this.body.innerHTML = `${head}<div id="rs-live"></div>`;
      return;
    }
    this.body.innerHTML = `${head}
      <div class="eyebrow">Step 2 · Type a world</div>
      <h2 style="margin:6px 0 10px">What should your room become?</h2>
      <form class="row-input" id="rs-form" autocomplete="off">
        <input class="field" id="rs-prompt" placeholder="e.g. haunted Victorian library" maxlength="300" value="${esc(this.prompt)}" />
        <button class="btn primary" type="submit">${icon('sparkle', 16)}Shift</button>
      </form>
      <div class="scroller" style="margin-top:10px">${EXAMPLES.map((x) => `<button class="chip" data-action="example" data-prompt="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      <div id="rs-live"></div>`;
  }

  private liveHtml(): string {
    const s = this.scan;
    if (!s || s.state === 'collecting')
      return `<div class="drop" data-action="pick" tabindex="0" role="button">${icon('photo', 26)}<b>${this.busy ? esc(this.status) : 'Choose a video (or 15–40 photos)'}</b><span class="xs muted">MP4/MOV video, or JPG/PNG/WebP photos with lots of overlap</span></div>
        ${this.status && !this.busy ? `<div class="callout">${icon('alert')}<div>${esc(this.status)}</div></div>` : ''}`;
    if (s.state === 'reconstructing') return `<div class="hint">${icon('cube')}<span>${esc(s.message)}</span></div><div class="progress"><div style="width:60%" class="indeterminate"></div></div>`;
    if (s.state === 'failed') return `<div class="callout">${icon('alert')}<div><b>Reconstruction failed.</b> ${esc(s.message)}</div></div><button class="btn block" data-action="retry">Try again</button>`;

    const sec = (k: string) => (s.timings[k] != null ? `${s.timings[k]} s` : '—');
    const sh = s.shell;
    const walking = app.mode.value === 'walk';
    const r = this.restyle;
    const steps = r
      ? `<div class="card" style="padding:12px 14px;margin:14px 0">
          <div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(r.plan?.title ?? r.prompt)}</b>${r.offline ? '<span class="tag warn">offline placeholder</span>' : ''}</div>
          ${r.plan?.brief ? `<p class="small muted" style="margin:4px 0 0">${esc(r.plan.brief)}</p>` : ''}
          <ul class="steps" style="margin:8px 0 0">
            ${stepLi(r.plan ? 'done' : r.state === 'failed' ? 'failed' : 'active', `Plan${r.offline ? '' : ' · Muse Spark'}`)}
            ${r.surfaces.map((x) => stepLi(x.state === 'done' ? 'done' : x.state === 'failed' ? 'failed' : x.state === 'running' ? 'active' : '', `${cap(x.id)}${x.seconds != null && x.state === 'done' ? ` · ${x.seconds} s` : ''}`, x.error)).join('')}
            ${(r.objects ?? []).map((x) => stepLi(x.state === 'done' ? 'done' : x.state === 'failed' ? 'failed' : x.state === 'pending' ? '' : 'active', `${cap(x.name)}${x.state === 'restyling' ? ' · Muse Image' : x.state === 'lifting' ? ' · SAM 3D' : x.state === 'done' && x.seconds != null ? ` · ${x.seconds} s` : ''}`, x.error)).join('')}
          </ul>
          ${r.state === 'failed' || r.surfaces.some((x) => x.state === 'failed') ? `<p class="xs error-text" style="margin:6px 0 0">${esc(r.message)}</p>` : ''}
          ${r.offline ? `<p class="xs faint" style="margin:6px 0 0">MODEL_API_KEY isn’t set on the backend, so these are local stand-ins, not Muse output.</p>` : ''}
        </div>`
      : '';
    const past = this.history.filter((h) => h.state === 'done' && h.id !== r?.id);
    return `
      ${this.error ? `<div class="callout">${icon('alert')}<div>${esc(this.error)}</div></div>` : ''}
      ${sh?.fallback ? `<div class="callout">${icon('alert')}<div><b>Couldn’t find the room’s walls.</b> Showing the raw scan; repainting needs walls and a floor. Try a slower video that sees every wall and some floor.</div></div>` : ''}
      ${this.objectsHtml(s)}
      ${steps}
      <div class="review-actions">
        ${sh && !sh.fallback ? `<button class="btn small" data-action="walk">${icon(walking ? 'cube' : 'walk', 16)}${walking ? 'Back to overview' : 'Walk inside'}</button>` : ''}
        <button class="btn small" data-action="clean">${icon('cube', 16)}${this.cleanView ? 'Show scan dots' : 'Hide scan dots'}</button>
        ${s.objects?.length ? `<button class="btn small" data-action="boxes">${icon('cube', 16)}${this.boxesOn ? 'Hide' : 'Show'} outlines</button>` : ''}
        ${r ? `<button class="btn small" data-action="original">${icon('reset', 16)}Show original</button>` : ''}
      </div>
      ${walking ? '<p class="xs faint">Drag to look, WASD or arrow keys to move, Esc to leave.</p>' : '<p class="xs faint">Drag to orbit, scroll to zoom.</p>'}
      ${past.length ? `<div class="level-label">Earlier worlds</div><div class="scroller">${past.map((h) => `<button class="chip" data-action="replay" data-id="${esc(h.id)}">${esc(h.plan?.title ?? h.prompt)}</button>`).join('')}</div>` : ''}
      <details style="margin-top:16px"><summary class="small muted" style="cursor:pointer">Scan details</summary>
        <p class="small muted">${esc(s.message)}</p>
        <ul class="flags">
          <li><span>Model</span><span>${esc(s.model)}</span></li>
          ${sh && !sh.fallback ? `<li><span>Room</span><span>${sh.size.width.toFixed(2)} × ${sh.size.depth.toFixed(2)} × ${sh.size.height.toFixed(2)} m</span></li><li><span>Walls seen</span><span>${sh.walls.filter((w) => !w.inferred).length}/4${sh.ceilingInferred ? ' · ceiling assumed' : ''}</span></li>` : ''}
          <li><span>GPU time</span><span>${sec('inferSeconds')}</span></li>
          <li><span>Total</span><span>${sec('totalSeconds')}</span></li>
          <li><span>Points</span><span>${s.cloud?.points.toLocaleString()}</span></li>
          ${s.objectsStatus?.usage ? `<li><span>Objects</span><span>${esc(s.objectsStatus.usage)}</span></li>` : ''}
          ${r?.usage ? `<li><span>Meta API</span><span>${esc(r.usage)}</span></li>` : ''}
        </ul>
        ${sh?.diagnostics.length ? `<ul class="logs">${sh.diagnostics.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
      </details>`;
  }

  private objectsHtml(s: Scan): string {
    const st = s.objectsStatus;
    if (!st) return '';
    if (st.state === 'running') return `<div class="hint" style="margin-top:12px">${icon('sparkle')}<span>${esc(st.message)}</span></div>`;
    if (st.state === 'skipped') return `<p class="xs faint" style="margin:12px 0 0">${esc(st.message)}</p>`;
    if (st.state === 'failed') return `<div class="callout" style="margin-top:12px">${icon('alert')}<div><b>Couldn’t find the furniture.</b> ${esc(st.message)}</div></div><button class="btn small" data-action="find-objects">Look again</button>`;
    const list = s.objects ?? [];
    if (!list.length) return `<p class="xs faint" style="margin:12px 0 0">${esc(st.message)} <a href="#" data-action="find-objects">Look again</a></p>`;
    return `<div class="level-label">In your room · SAM 3.1</div>
      <div class="scroller">${list
        .map((o) => `<button class="chip${o.id === this.selected ? ' on' : ''}" data-action="object" data-id="${esc(o.id)}" title="${esc(`${o.box.size.map((v) => v.toFixed(2)).join(' × ')} m · seen in ${o.views} view${o.views > 1 ? 's' : ''}`)}">${o.crop ? `<img src="${BASE}/api/scans/${esc(s.id)}/objects/${esc(o.id)}/crop.jpg" alt="" style="width:22px;height:22px;object-fit:cover;border-radius:6px" />` : ''}${esc(o.name)}</button>`)
        .join('')}</div>`;
  }

  // ------------------------------------------------------------------------------------------ events

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
      const { scan } = await postJson<{ scan: Scan }>('/api/scans', { title: files[0].name.replace(/\.[^.]+$/, '') });
      for (const [i, b] of frames.entries()) {
        this.setStatus(`Uploading frames… ${i + 1}/${frames.length}`);
        await call(`/api/scans/${scan.id}/frames`, { method: 'POST', headers: { 'content-type': b.type || 'image/jpeg' }, body: b });
      }
      this.setStatus('Starting MapAnything…');
      history.replaceState(null, '', `?scan=${scan.id}`);
      this.scan = (await postJson<{ scan: Scan }>(`/api/scans/${scan.id}/reconstruct`, {})).scan;
      this.busy = false;
      this.status = '';
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
      this.stopPolls();
      if (app.mode.value === 'walk') exitRoom(this.world);
      this.scan = null;
      this.shown = null;
      this.selected = null;
      this.restyle = null;
      this.history = [];
      this.status = '';
      this.room.clear();
      history.replaceState(null, '', location.pathname);
      this.render();
    }
    if (a === 'retry' && this.scan) {
      try {
        this.scan = (await postJson<{ scan: Scan }>(`/api/scans/${this.scan.id}/reconstruct`, {})).scan;
        this.follow();
      } catch (err) {
        this.scan!.message = (err as Error).message;
      }
      this.render();
    }
    if (a === 'object') {
      this.selected = this.selected === t.dataset.id ? null : (t.dataset.id ?? null);
      if (this.selected && !this.boxesOn) this.room.showObjects((this.boxesOn = true));
      this.room.highlight(this.selected);
      this.render();
    }
    if (a === 'clean') {
      this.cleanView = !this.cleanView;
      this.room.setClean(this.cleanView);
      this.render();
    }
    if (a === 'boxes') {
      this.room.showObjects((this.boxesOn = !this.boxesOn));
      this.render();
    }
    if (a === 'find-objects' && this.scan) {
      e.preventDefault();
      try {
        this.scan = (await postJson<{ scan: Scan }>(`/api/scans/${this.scan.id}/objects`, {})).scan;
        this.follow();
      } catch (err) {
        this.error = (err as Error).message;
      }
      this.render();
    }
    if (a === 'example') {
      this.prompt = t.dataset.prompt ?? '';
      const input = this.body.querySelector('#rs-prompt') as HTMLInputElement | null;
      if (input) input.value = this.prompt;
      void this.shift(this.prompt);
    }
    if (a === 'walk') {
      if (app.mode.value === 'walk') this.leaveWalk();
      else {
        // Start where filming began (the video's first view); else near one end, looking down the room.
        const sh = this.scan?.shell;
        const start = sh && !sh.fallback ? filmingStart(this.scan!.cameras, sh.alignment) : null;
        enterScanWalk(this.world, this.room.wallSegments(), [0, sh ? Math.max(0, sh.size.depth / 2 - 0.6) : 0], start ?? undefined);
        this.render();
      }
    }
    if (a === 'original') {
      if (this.rpoll) clearInterval(this.rpoll);
      this.rpoll = null;
      this.restyle = null;
      this.room.reset();
      this.room.clearModels();
      const asFilmed = this.history.find((h) => h.original);
      if (asFilmed) {
        this.restyle = asFilmed;
        this.apply(asFilmed);
      }
      this.render();
    }
    if (a === 'replay') {
      const h = this.history.find((x) => x.id === t.dataset.id);
      if (h) {
        this.room.reset();
        this.room.clearModels();
        this.origin = paintOrigin(this.world, this.scan?.shell ?? null);
        this.restyle = h;
        this.apply(h);
        this.render();
      }
    }
  }

  private leaveWalk() {
    exitRoom(this.world);
    this.frameRoom();
    this.render();
  }

  // ------------------------------------------------------------------------------------------ scan

  /** Poll the scan until it is ready (and its objects are found), showing the room as soon as it can. */
  private follow() {
    if (this.poll) clearInterval(this.poll);
    const tick = async () => {
      if (!this.scan) return;
      this.scan = (await call<{ scan: Scan }>(`/api/scans/${this.scan.id}`)).scan;
      const s = this.scan;
      if (s.state === 'ready') {
        // Rebuild when the cloud or the inner walls change (furniture fronts are dropped after objects are found).
        const key = `${s.id}:${s.cloud?.file}:${JSON.stringify(s.shell?.inner ?? [])}:${(s.photoWalls ?? []).length}`;
        if (this.shown !== key) {
          this.shown = key;
          await this.showRoom();
        }
        this.room.setObjects(s.objects ?? []);
        this.room.highlight(this.selected);
        this.room.showObjects(this.boxesOn);
        // New or re-found objects: put the current world's pieces into them (placing is idempotent).
        if (this.restyle) this.apply(this.restyle);
      }
      if (s.state !== 'reconstructing' && s.objectsStatus?.state !== 'running') {
        clearInterval(this.poll!);
        this.poll = null;
        if (s.state === 'ready' && s.objectsStatus?.state === 'done') void this.showDefault();
      }
      this.render();
    };
    void tick();
    this.poll = window.setInterval(tick, 2000);
  }

  private async showRoom() {
    const s = this.scan!;
    scanXR.target = s.shell && !s.shell.fallback ? filmingStart(s.cameras, s.shell.alignment) : null;
    // Compact cloud first (about a quarter of the size); the PLY if this backend doesn't serve it.
    const compact = await fetch(`${BASE}/api/scans/${s.id}/cloud.rsc`).catch(() => null);
    const buf = await (compact?.ok ? compact : await fetch(`${BASE}/api/scans/${s.id}/cloud.ply`)).arrayBuffer();
    const photos = Object.fromEntries((s.photoWalls ?? []).map((w) => [w.id, `${BASE}/api/scans/${s.id}/walls/${w.file}?v=${encodeURIComponent(s.updatedAt ?? '')}`]));
    this.room.load(buf, s.shell, photos);
    this.room.setClean(this.cleanView);
    // Objects before any world: a world's furniture is placed into these slots.
    this.room.setObjects(s.objects ?? []);
    this.frameRoom();
    // Bring back the most recent finished world for this room.
    this.history = (await call<{ restyles: Restyle[] }>(`/api/scans/${s.id}/restyles`).catch(() => ({ restyles: [] }))).restyles;
    // The newest finished version (a world, or the room as filmed); the list comes newest first.
    const last = this.history.find((h) => h.state === 'done');
    if (last && !this.restyle) {
      this.origin = paintOrigin(this.world, s.shell ?? null);
      this.restyle = last;
      this.apply(last);
    }
  }

  /** With no world chosen, show (and follow) the room as filmed, rebuilt in 3D. */
  private async showDefault() {
    if (!this.scan || (this.restyle && !this.restyle.original)) return;
    this.history = (await call<{ restyles: Restyle[] }>(`/api/scans/${this.scan.id}/restyles`).catch(() => ({ restyles: [] }))).restyles;
    const asFilmed = this.history.find((h) => h.original);
    if (!asFilmed || this.restyle?.id === asFilmed.id) return;
    this.restyle = asFilmed;
    this.apply(asFilmed);
    if (asFilmed.state !== 'done' && asFilmed.state !== 'failed') this.followRestyle(asFilmed.id);
    this.render();
  }

  private frameRoom() {
    const f = this.room.frame();
    focusOrbit(this.world, f.target, f.span);
  }

  // ------------------------------------------------------------------------------------------ restyle

  private async shift(prompt: string) {
    prompt = prompt.trim();
    if (!this.scan || prompt.length < 2) return;
    this.error = '';
    try {
      const { restyle } = await postJson<{ restyle: Restyle }>(`/api/scans/${this.scan.id}/restyles`, { prompt });
      this.room.reset();
      this.room.clearModels();
      this.origin = paintOrigin(this.world, this.scan.shell ?? null);
      this.restyle = restyle;
      this.followRestyle(restyle.id);
    } catch (err) {
      this.error = (err as Error).message;
    }
    this.render();
  }

  private followRestyle(id: string) {
    if (this.rpoll) clearInterval(this.rpoll);
    const tick = async () => {
      const r = (await call<{ restyle: Restyle }>(`/api/restyles/${id}`).catch(() => null))?.restyle;
      if (!r || this.restyle?.id !== id) return;
      this.restyle = r;
      this.apply(r);
      if (r.state === 'done' || r.state === 'failed') {
        clearInterval(this.rpoll!);
        this.rpoll = null;
        this.history = [r, ...this.history.filter((h) => h.id !== r.id)];
      }
      this.render();
    };
    void tick();
    this.rpoll = window.setInterval(tick, 1200);
  }

  /** Push whatever has arrived into the 3D room (idempotent). */
  private apply(r: Restyle) {
    for (const o of r.objects ?? []) {
      // Objects found again since this world was made may have new ids: only use pieces that still match.
      if (o.state !== 'done' || this.scan?.objects?.find((x) => x.id === o.id)?.name !== o.name) continue;
      const done = o.format === 'plane' && o.image ? this.room.placeSurface(o.id, `${BASE}/api/textures/${o.image}`) : o.model && o.format === 'glb' ? this.room.placeModel(o.id, `${BASE}${o.model}`) : null;
      void done?.catch((e) => console.warn(`${o.name} failed to load`, e));
    }
    if (!r.plan) return;
    this.room.mood(r.plan.light, r.plan.fogHex);
    const from = this.origin ?? paintOrigin(this.world, this.scan?.shell ?? null);
    for (const s of r.surfaces) {
      if (s.state !== 'done' || !s.texture) continue;
      const spec = r.plan.surfaces[s.id];
      void this.room.paint({ id: s.id, url: `${BASE}/api/textures/${s.texture}`, tileMetres: spec.tileMetres, colorHex: spec.colorHex }, from);
    }
  }

  private stopPolls() {
    if (this.poll) clearInterval(this.poll);
    if (this.rpoll) clearInterval(this.rpoll);
    this.poll = this.rpoll = null;
  }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function stepLi(state: string, label: string, error?: string | null) {
  const badge = state === 'done' ? icon('check', 14) : state === 'failed' ? '!' : '';
  return `<li class="${state}"><span class="badge">${badge}</span><div><span>${esc(label)}</span>${error ? `<span class="xs error-text">${esc(error)}</span>` : ''}</div></li>`;
}
