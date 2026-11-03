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
import { StageLoader, markSpinner } from './loader.js';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Which kind of headset session was asked for (set by the AR button, read when the session starts). */
export const xrMode = { ar: false };

/** `?debug` shows the technical details (models, timings, scan stats) that people using the app never need. */
const LOGO = `${import.meta.env.BASE_URL}brand/`;
const DEBUG = new URLSearchParams(location.search).has('debug');
/** Something went wrong: keep the real reason in the console, show people a plain sentence. */
const friendly = (err: unknown, said = 'Something went wrong. Please try again.') => {
  console.warn('[roomshift]', err);
  return said;
};

const EXAMPLES: { label: string; prompt: string; icon: string }[] = [
  { label: 'Haunted library', prompt: 'haunted Victorian library', icon: 'book' },
  { label: 'Underwater cave', prompt: 'underwater coral cave', icon: 'waves' },
  { label: 'Space station', prompt: 'spaceship bridge', icon: 'rocket' },
  { label: 'Forest cabin', prompt: 'enchanted forest cabin', icon: 'tree' },
  { label: 'Tokyo arcade', prompt: '1970s Tokyo arcade', icon: 'gamepad' },
  { label: 'Egyptian tomb', prompt: 'Egyptian tomb', icon: 'pyramid' },
];

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
export async function framesFromVideo(file: File, onProgress: (n: number, total: number, frame: Blob) => void): Promise<Blob[]> {
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
    onProgress(i + 1, total, out[out.length - 1]);
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
  private loader: StageLoader;
  private statusEl: HTMLElement;
  /** Frames from this session's upload (object URLs), shown pixelated while the room is built. */
  private localFrames: string[] = [];
  private progress: number | null = null;
  private loadTitle = '';
  /** The 3D room has been downloaded and drawn. */
  private roomShown = false;

  constructor(
    private world: World,
    root: HTMLElement,
  ) {
    this.body = root.querySelector('#panel-body') as HTMLElement;
    this.room = new RoomScene(world);
    const stage = document.getElementById('stage')!;
    this.loader = new StageLoader(stage);
    this.statusEl = document.createElement('div');
    this.statusEl.id = 'stage-status';
    this.statusEl.hidden = true;
    stage.appendChild(this.statusEl);
    this.body.addEventListener('change', (e) => void this.onChange(e));
    this.body.addEventListener('click', (e) => void this.onClick(e));
    document.getElementById('stage-controls')?.addEventListener('click', (e) => void this.onClick(e));
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
    this.renderStageNote();
  }

  /** What the 3D view says while there is no room in it yet. */
  private renderStageNote() {
    const note = document.getElementById('stage-note');
    if (!note) return;
    const s = this.scan;
    const building = !!s && (s.state === 'reconstructing' || (s.state === 'ready' && !this.roomShown));
    const frames = this.localFrames.length ? this.localFrames : s && s.frames.length ? sample(s.frames.length, 10).map((i) => `${BASE}/api/scans/${s.id}/frames/${i}`) : [];
    this.loader.show(
      this.busy
        ? { title: this.loadTitle, sub: this.progress != null ? `${Math.round(this.progress * 100)}%` : 'Keep this page open', progress: this.progress, frames }
        : building
          ? { title: s!.state === 'ready' ? 'Opening your room' : 'Building your room in 3D', sub: s!.state === 'ready' ? 'Almost there' : 'This usually takes about a minute', progress: null, frames }
          : null,
    );
    const html = (!s || s.state === 'collecting') && !this.busy ? `<div class="sn-ic">${icon('cube', 22)}</div><b>Your room appears here</b><span>In 3D, at its real size</span>` : '';
    note.hidden = !html;
    if (html && note.innerHTML !== html) note.innerHTML = html;
    this.renderStageControls();
  }

  /** Round buttons over the 3D view: walk in / back out, scan dots, outlines, and back to your own room. */
  private renderStageControls() {
    const el = document.getElementById('stage-controls');
    if (!el) return;
    const s = this.scan;
    const sh = s?.shell;
    const r = this.restyle;
    const walking = app.mode.value === 'walk';
    const btn = (action: string, ic: string, label: string, on?: boolean) =>
      `<button class="fab${on ? ' on' : ''}" data-action="${action}" aria-label="${label}" title="${label}"${on != null ? ` aria-pressed="${on}"` : ''}>${icon(ic, 22)}</button>`;
    const html =
      s?.state === 'ready' && this.shown
        ? `<div class="fab-col left">${r && !r.original ? btn('original', 'undo', 'Back to your room') : ''}</div>
           <div class="fab-col right">
             ${sh && !sh.fallback ? btn('walk', walking ? 'cube' : 'walk', walking ? 'Back to the overview' : 'Walk inside', walking) : ''}
             ${btn('clean', this.cleanView ? 'eyeOff' : 'eye', this.cleanView ? 'Show scan dots' : 'Hide scan dots', !this.cleanView)}
             ${s.objects?.length ? btn('boxes', 'frame', this.boxesOn ? 'Hide furniture outlines' : 'Show furniture outlines', this.boxesOn) : ''}
           </div>`
        : '';
    if (el.innerHTML !== html) el.innerHTML = html;
    const step = r && r.state !== 'done' && r.state !== 'failed' && !r.original ? currentStep(r) : '';
    this.statusEl.hidden = !step;
    const pill = step ? `${markSpinner('sm')}<span>${esc(step)}</span>` : '';
    if (this.statusEl.innerHTML !== pill) this.statusEl.innerHTML = pill;
  }

  private renderAll() {
    const s = this.scan;
    const brand = `<div class="desktop-brand"><img class="logo-light" src="${LOGO}samworld.png" alt="SamWORLD" width="153" height="28" /><img class="logo-dark" src="${LOGO}samworld-white.png" alt="SamWORLD" width="153" height="28" /></div>`;
    if (!s || s.state === 'collecting') {
      this.body.innerHTML = `${brand}
        ${stepper(1, 'Film your room')}
        <h1>Type a world. Your room becomes it.</h1>
        <p class="lede">Film a slow walk around your room and we’ll rebuild it in 3D. Then describe any world and watch your room become it.</p>
        <div id="rs-live"></div>
        <input type="file" id="capture" accept="video/*,image/jpeg,image/png,image/webp" multiple hidden />
        <div class="rs-how-title">Filming tips</div>
        <ol class="rs-how">
          <li>${icon('video', 16)}<div><b>20–40 seconds, slowly</b><span>Phone at chest height, the whole way round.</span></div></li>
          <li>${icon('frame', 16)}<div><b>Every wall and some floor</b><span>Turn to see each wall; tilt down now and then.</span></div></li>
          <li>${icon('eye', 16)}<div><b>Your video stays with you</b><span>Only a few still pictures are sent to build the room.</span></div></li>
        </ol>`;
      return;
    }
    const size = s.shell && !s.shell.fallback ? ` · ${s.shell.size.width.toFixed(1)} × ${s.shell.size.depth.toFixed(1)} m` : '';
    const sub = s.state === 'ready' ? (size ? `Rebuilt${size}` : 'Scanned and rebuilt') : s.state === 'failed' ? 'Couldn’t be rebuilt' : 'Building in 3D…';
    const head = `${brand}<div class="room-head">
        <div class="room-cover">${s.frames.length ? `<img src="${BASE}/api/scans/${esc(s.id)}/cover.jpg" alt="" onerror="this.remove()" />` : ''}</div>
        <div class="grow"><div class="rs-title">Your room</div><div class="sub truncate">${sub}</div></div>
        <button class="btn soft" data-action="new">New room</button>
      </div>`;
    if (s.state !== 'ready') {
      this.body.innerHTML = `${head}${stepper(1, s.state === 'failed' ? 'Film your room' : 'Building your room')}<div id="rs-live"></div>`;
      return;
    }
    this.body.innerHTML = `${head}
      <h2 class="rs-ask">What should your room become?</h2>
      <form class="composer" id="rs-form" autocomplete="off">
        <input id="rs-prompt" placeholder="Describe a world…" maxlength="300" value="${esc(this.prompt)}" aria-label="Describe a world" />
        <button class="btn primary" type="submit">Shift${icon('arrow', 16)}</button>
      </form>
      <div class="scroller rs-examples">${EXAMPLES.map((x) => `<button class="chip" data-action="example" data-prompt="${esc(x.prompt)}">${icon(x.icon, 18)}${esc(x.label)}</button>`).join('')}</div>
      <div id="rs-live"></div>`;
  }

  private liveHtml(): string {
    const s = this.scan;
    if (!s || s.state === 'collecting')
      return `<div class="drop${this.busy ? ' busy' : ''}" data-action="pick" tabindex="0" role="button" aria-busy="${this.busy}">${this.busy ? markSpinner() : icon('video', 24)}<b>${this.busy ? esc(this.status) : 'Choose a video of your room'}</b><span class="xs muted">${this.busy ? 'Keep this page open' : 'Or choose 15–40 photos of it'}</span></div>
        ${this.status && !this.busy ? `<div class="callout">${icon('alert')}<div>${esc(this.status)}</div></div>` : ''}`;
    if (s.state === 'reconstructing') return `<p class="small muted">This usually takes about a minute. Your room appears as soon as it’s ready.</p>`;
    if (s.state === 'failed') return `<div class="callout">${icon('alert')}<div><b>We couldn’t build your room.</b> Try again, or film it once more a little slower with every wall in view.</div></div><div class="rs-retry"><button class="btn primary" data-action="retry">Try again</button><button class="btn" data-action="new">Film again</button></div>${DEBUG ? `<p class="xs faint">${esc(s.message)}</p>` : ''}`;

    const sec = (k: string) => (s.timings[k] != null ? `${s.timings[k]} s` : '—');
    const sh = s.shell;
    const walking = app.mode.value === 'walk';
    const r = this.restyle;
    const steps = r
      ? `<div class="card world-card">
          <div class="world-top"><b>${esc(r.original ? 'Your room' : (r.plan?.title ?? cap(r.prompt)))}</b>${r.state === 'done' ? '<span class="tag ok">Ready</span>' : ''}</div>
          ${r.plan?.brief && !r.offline ? `<p class="small muted world-brief">${esc(r.plan.brief)}</p>` : ''}
          <ul class="steps compact">
            ${stepLi(r.plan ? 'done' : r.state === 'failed' ? 'failed' : 'active', 'Imagining the world', DEBUG && !r.offline ? 'Muse Spark' : '')}
            ${r.surfaces.map((x) => stepLi(x.state === 'done' ? 'done' : x.state === 'failed' ? 'failed' : x.state === 'running' ? 'active' : '', SURFACE_STEP[x.id] ?? cap(x.id), DEBUG && x.state === 'done' ? secs(x.seconds) : '', DEBUG ? x.error : null)).join('')}
            ${(r.objects ?? []).map((x) => stepLi(x.state === 'done' ? 'done' : x.state === 'failed' ? 'failed' : x.state === 'pending' ? '' : 'active', `Restyling the ${x.name.toLowerCase()}`, DEBUG ? (x.state === 'restyling' ? 'Muse Image' : x.state === 'lifting' ? 'SAM 3D' : x.state === 'done' ? secs(x.seconds) : '') : '', DEBUG ? x.error : null)).join('')}
          </ul>
          ${r.state === 'failed' || r.surfaces.some((x) => x.state === 'failed') ? `<p class="xs error-text" style="margin:8px 0 0">Some of this world didn’t come out. Try again, or pick another world.</p>${DEBUG ? `<p class="xs faint">${esc(r.message)}</p>` : ''}` : ''}
        </div>`
      : '';
    const past = this.history.filter((h) => h.state === 'done' && h.id !== r?.id);
    return `
      ${this.error ? `<div class="callout">${icon('alert')}<div>${esc(this.error)}</div></div>` : ''}
      ${sh?.fallback ? `<div class="callout">${icon('alert')}<div><b>We couldn’t make out all of your walls,</b> so this room can’t become a new world yet. Try filming again a little slower, with every wall and some floor in view.</div></div>` : ''}
      ${this.objectsHtml(s)}
      ${steps}
      <p class="xs faint rs-controls">${walking ? 'Drag to look · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to move · <kbd>Esc</kbd> to leave' : 'Drag to orbit · scroll to zoom'}</p>
      ${past.length ? `<div class="level-label">Earlier worlds</div><div class="scroller">${past.map((h) => `<button class="chip" data-action="replay" data-id="${esc(h.id)}">${esc(h.plan?.title ?? h.prompt)}</button>`).join('')}</div>` : ''}
      ${DEBUG ? `<details class="rs-details"><summary>Scan details${icon('down', 16)}</summary>
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
      </details>` : ''}`;
  }

  private objectsHtml(s: Scan): string {
    const st = s.objectsStatus;
    if (!st) return '';
    if (st.state === 'running') return `<div class="hint" style="margin-top:12px">${markSpinner()}<span>Finding your furniture…</span></div>`;
    if (st.state === 'skipped') return DEBUG ? `<p class="xs faint" style="margin:12px 0 0">${esc(st.message)}</p>` : '';
    if (st.state === 'failed') return `<div class="callout" style="margin-top:12px">${icon('alert')}<div><b>We couldn’t pick out your furniture.</b> Your room still works without it.</div></div><button class="btn small" data-action="find-objects">Look again</button>`;
    const list = s.objects ?? [];
    if (!list.length) return `<p class="xs faint" style="margin:12px 0 0">No furniture spotted. <a href="#" data-action="find-objects">Look again</a></p>`;
    return `<div class="level-label">In your room</div>
      <div class="scroller">${list
        .map((o) => `<button class="chip${o.id === this.selected ? ' on' : ''}" data-action="object" data-id="${esc(o.id)}" ${DEBUG ? `title="${esc(`${o.box.size.map((v) => v.toFixed(2)).join(' × ')} m · seen in ${o.views} view${o.views > 1 ? 's' : ''}`)}"` : ''}>${o.crop ? `<img class="chip-thumb" src="${BASE}/api/scans/${esc(s.id)}/objects/${esc(o.id)}/crop.jpg" alt="" />` : ''}${esc(o.name)}</button>`)
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
        this.loadTitle = 'Getting your video ready';
        frames = await framesFromVideo(files[0], (n, t, f) => {
          if (n % 3 === 1 || n === t) this.localFrames.push(URL.createObjectURL(f));
          this.progress = n / t;
          this.setStatus(`Getting your video ready… ${Math.round((n / t) * 100)}%`);
        });
      } else {
        frames = files.filter((f) => f.type.startsWith('image/')).slice(0, 60);
        if (frames.length < 4) throw new Error('Choose a video, or at least 4 photos.');
        this.localFrames = sample(frames.length, 10).map((i) => URL.createObjectURL(frames[i]));
      }
      const { scan } = await postJson<{ scan: Scan }>('/api/scans', { title: files[0].name.replace(/\.[^.]+$/, '') });
      for (const [i, b] of frames.entries()) {
        this.loadTitle = 'Uploading your room';
        this.progress = (i + 1) / frames.length;
        this.setStatus(`Uploading… ${Math.round(((i + 1) / frames.length) * 100)}%`);
        await call(`/api/scans/${scan.id}/frames`, { method: 'POST', headers: { 'content-type': b.type || 'image/jpeg' }, body: b });
      }
      this.loadTitle = 'Starting to build';
      this.progress = null;
      this.setStatus('Almost there…');
      history.replaceState(null, '', `?scan=${scan.id}${DEBUG ? '&debug' : ''}`);
      this.scan = (await postJson<{ scan: Scan }>(`/api/scans/${scan.id}/reconstruct`, {})).scan;
      this.busy = false;
      this.status = '';
      this.follow();
    } catch (err) {
      this.busy = false;
      this.progress = null;
      this.dropLocalFrames();
      this.status = friendly(err, (err as Error).message.startsWith('Choose') || (err as Error).message.startsWith('This video') ? (err as Error).message : 'We couldn’t upload that. Please try again.');
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
      this.roomShown = false;
      this.dropLocalFrames();
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
        this.error = friendly(err);
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
    this.roomShown = true;
    this.dropLocalFrames();
    this.render();
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
      this.error = friendly(err);
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

  private dropLocalFrames() {
    for (const u of this.localFrames) URL.revokeObjectURL(u);
    this.localFrames = [];
  }

  private stopPolls() {
    if (this.poll) clearInterval(this.poll);
    if (this.rpoll) clearInterval(this.rpoll);
    this.poll = this.rpoll = null;
  }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
/** A step's time, left out when it is too short to be worth reading. */
/** Up to n evenly spread indexes out of count. */
const sample = (count: number, n: number) => Array.from({ length: Math.min(count, n) }, (_, i) => Math.floor((i * count) / Math.min(count, n)));

/** What a world in progress is doing right now, in plain words. */
function currentStep(r: Restyle): string {
  if (!r.plan) return 'Imagining the world…';
  const surf = r.surfaces.find((x) => x.state === 'running') ?? r.surfaces.find((x) => x.state === 'pending');
  if (surf) return `${SURFACE_STEP[surf.id] ?? cap(surf.id)}…`;
  const obj = (r.objects ?? []).find((x) => x.state === 'restyling' || x.state === 'lifting') ?? (r.objects ?? []).find((x) => x.state === 'pending');
  if (obj) return `Restyling the ${obj.name.toLowerCase()}…`;
  return 'Finishing touches…';
}

const SURFACE_STEP: Record<string, string> = { walls: 'Painting the walls', floor: 'Laying the floor', ceiling: 'Painting the ceiling' };
const secs = (n: number | null) => (n != null && n >= 0.5 ? `${n} s` : '');

function stepLi(state: string, label: string, note?: string | null, error?: string | null) {
  const badge = state === 'done' ? icon('check', 12) : state === 'failed' ? '!' : '';
  return `<li class="${state}"><span class="badge">${badge}</span><div><span>${esc(label)}</span>${error ? `<span class="xs error-text">${esc(error)}</span>` : ''}</div>${note ? `<span class="step-note">${esc(note)}</span>` : ''}</li>`;
}

/** “Step 1 of 2 · Scan your room”, with a two-segment track. */
function stepper(n: 1 | 2, label: string) {
  return `<div class="stepper"><span class="track"><i class="on"></i><i${n === 2 ? ' class="on"' : ''}></i></span>Step ${n} of 2 · ${esc(label)}</div>`;
}
