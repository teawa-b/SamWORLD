/**
 * 2D interface: discovery → listing evidence → processing → explore
 * (controls, rooms & corrections, evidence). A sidebar on desktop and a
 * bottom sheet on phones. All state the 3D systems need goes through `app`.
 */
import type { World } from '@iwsdk/core';
import type { Property, PropertyMedia, ReconstructionRun, Room, SceneManifest } from '../shared/index.js';
import { api, ApiError, mediaUrl, staticMode, absoluteApiUrl, type Capabilities, type NearbyListing, type Place, type SearchResult } from '../api.js';
import type { Globe } from './globe.js';
import { app, floorsSeparated, resetBuilding, separateFloors } from '../state.js';
import { changeLevel, enterRoom, exitRoom } from '../systems/walkthrough.js';
import { icon } from './icons.js';
import type { Sheet } from './sheet.js';
import { ImportFlow } from './importer.js';
import { takeCollected } from './bookmarklet.js';
import { PlanEditor } from './plan-editor.js';
import { PhotoViewer } from './photos.js';
import { Minimap } from './minimap.js';
import { nudgeObject, removeObjectLocally, resetObject, sceneObject } from '../systems/objects.js';

type Tab = 'explore' | 'rooms' | 'evidence';
type View =
  | { name: 'import' }
  | { name: 'discover' }
  | { name: 'review'; propertyId: string }
  | { name: 'processing'; propertyId: string; jobId: string }
  | { name: 'explore'; propertyId: string; tab: Tab };

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Run state reached, label, and the log step name its messages are filed under. */
const STEPS: [ReconstructionRun['state'], string, string][] = [
  ['INGESTED', 'Collecting photographs', 'ingest'],
  ['STRUCTURE_PARSED', 'Analysing the floor plan', 'parse'],
  ['SHELL_BUILT', 'Building room geometry', 'shell'],
  ['MEDIA_MATCHED', 'Matching photographs to rooms', 'match'],
  ['SEGMENTED', 'Finding furniture in photos', 'segment'],
  ['PLACED', 'Preparing furniture', 'place'],
  ['VERIFIED', 'Checking the result', 'verify'],
  ['READY', 'Loading the 3D scene', 'done'],
];
/** A finished step whose own log says it didn't really run is shown as skipped, with the reason. */
const SKIPPED_RE = /skipped|not set|can’t be read|estimating the layout|failed|no photos supplied/i;

const LAYOUT_LABELS: Record<string, string> = {
  floorplan: 'Listing floor plan',
  'photo-floorplan': 'Floor plan found in the photos',
  photos: 'Estimated from photos (Muse)',
  'listing-details': 'Estimated from listing details',
};
const estimatedLayout = (s: SceneManifest) => s.evidenceFlags.layoutSource === 'photos' || s.evidenceFlags.layoutSource === 'listing-details';
const METHOD_LABELS: Record<string, string> = {
  'meta:muse-spark-1.3': 'Meta Muse Spark',
  'meta:muse-wonder-1.0': 'Meta Muse Wonder',
  'meta:sam-3.1': 'Meta SAM 3.1',
  'fixture:hand-authored': 'Demo data (no live AI)',
  'admin-correction': 'Traced / corrected by hand',
  'modal:sam-3d-objects': 'SAM 3D Objects',
  deterministic: 'Geometry engine',
};

const LEVEL_SHORT = (name: string) => name.replace(/ floor$/i, '');
const SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
const price = (p: Property['price']) =>
  p ? `${SYMBOL[p.currency] ?? `${p.currency} `}${Math.round(p.amount).toLocaleString()}${p.period === 'sale' ? '' : p.period === 'pcm' ? ' pcm' : ` ${p.period}`}` : '—';

function roomEvidence(r: Room): { cls: string; text: string; color: string } {
  if (r.linkedMediaIds.length && r.dimensionsMeasured && !r.isEstimated) return { cls: 'ok', text: 'Photo + measured', color: '#4caf7a' };
  if (r.dimensionsMeasured && !r.isEstimated) return { cls: 'warn', text: 'Measured', color: '#e0b24a' };
  return { cls: 'bad', text: 'Estimated', color: '#d9645a' };
}

export class Panel {
  private body: HTMLElement;
  private view: View = { name: 'import' };
  private flow: ImportFlow;
  private photos: PhotoViewer;
  private minimap: Minimap;
  private sam3dReason = '';
  private objectJob: string | null = null;
  private furniturePoll: number | null = null;
  private caps: Capabilities | null = null;
  private realtyNotice = '';
  private property: Property | null = null;
  private media: PropertyMedia[] = [];
  private results: SearchResult[] = [];
  private query = '';
  private pollTimer: number | null = null;
  private lastShellVersion = 0;
  private nearby: NearbyListing[] = [];
  private nearPlace: Place | null = null;
  private nearNotice: string | null = null;
  private nearLoading = false;
  private mode: 'rent' | 'buy' = 'rent';
  private globe: Globe | null = null;

  attachGlobe(globe: Globe) {
    this.globe = globe;
    globe.onPick((lat, lng) => void this.searchAt(lat, lng));
  }

  constructor(
    private world: World,
    private root: HTMLElement,
    private sheet: Sheet,
  ) {
    this.body = root.querySelector('#panel-body') as HTMLElement;
    this.flow = new ImportFlow({
      toast: (m) => this.toast(m),
      rerender: () => (this.view.name === 'import' || this.view.name === 'review') && this.renderKeepScroll(),
      openReview: (id) => this.openProperty(id),
      startBuild: (id, opts) => this.build(id, opts),
      openPlanEditor: (id) => this.openPlanEditor(id),
      openDiscover: () => this.go({ name: 'discover' }),
      caps: () => this.caps,
    });
    this.photos = new PhotoViewer((roomId) => {
      app.selectedRoomId.value = roomId;
      enterRoom(this.world, roomId);
    });
    this.minimap = new Minimap(world);
    // Drag and drop images onto the import / review screens.
    this.body.addEventListener('dragover', (e) => {
      if (this.view.name === 'import' || this.view.name === 'review') {
        e.preventDefault();
        this.body.querySelector('#drop-zone')?.classList.add('over');
      }
    });
    this.body.addEventListener('dragleave', () => this.body.querySelector('#drop-zone')?.classList.remove('over'));
    this.body.addEventListener('drop', (e) => {
      if (this.view.name !== 'import' && this.view.name !== 'review') return;
      e.preventDefault();
      void this.flow.addFiles([...(e.dataTransfer?.files ?? [])]);
    });
    document.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('submit', (e) => this.onSubmit(e));
    this.body.addEventListener('change', (e) => this.onChange(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    for (const s of [app.selectedRoomId, app.mode, app.levelLift, app.roofHidden, app.wallsHidden, app.furnitureHidden, app.night, app.evidenceView, app.wallMode, app.pulledWalls, app.walkLevelId, app.selectedObjectId, app.hiddenObjectIds, app.objectEdits]) {
      s.subscribe(() => this.view.name === 'explore' && this.view.tab === 'explore' && this.render());
    }
    // Selecting a room in 3D opens the sheet enough to show it.
    app.selectedRoomId.subscribe((id) => id && this.sheet.current === 'peek' && this.sheet.set('half'));
    app.mode.subscribe((m) => {
      if (this.view.name === 'explore') this.sheet.set(m === 'walk' ? 'peek' : 'half');
    });
  }

  async start() {
    const h = await api.health();
    this.caps = h?.capabilities ?? null;
    this.realtyNotice = h?.realtyApi.available === false ? h.realtyApi.reason : '';
    this.renderStatus();
    if (!staticMode) this.sam3dReason = (await api.sam3dStatus().catch(() => ({ reason: '' }))).reason;
    const collected = takeCollected();
    if (collected) {
      this.flow.collected = collected;
      return this.go({ name: 'import' });
    }
    const pid = new URLSearchParams(location.search).get('property');
    if (pid) await this.openProperty(pid, true).catch(() => this.go({ name: 'import' }));
    else this.go({ name: 'import' });
  }

  private renderStatus() {
    const el = document.getElementById('status-pill')!;
    el.hidden = false;
    const live = !!this.caps?.liveMeta && !staticMode;
    el.innerHTML = `<span class="status-dot ${live ? 'live' : ''}"></span>${staticMode ? 'Offline demo' : live ? 'Live AI' : 'AI off'}`;
    el.title = staticMode ? 'API not reachable: showing pre-built scenes' : live ? `${this.caps!.museModel} · ${this.caps!.samModel}` : 'MODEL_API_KEY is not set on the server: no AI steps run (floor plans can be traced by hand)';
  }

  private go(v: View) {
    this.view = v;
    if (this.pollTimer && v.name !== 'processing') {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.sheet.set(v.name === 'review' || v.name === 'import' ? 'full' : 'half');
    this.globe?.show(v.name === 'discover');
    document.body.classList.toggle('wide-panel', v.name === 'import' || v.name === 'review');
    this.minimap.show(v.name === 'explore' || v.name === 'processing');
    this.render();
    if (v.name === 'explore') this.watchFurniture(v.propertyId);
    else if (this.furniturePoll) {
      clearInterval(this.furniturePoll);
      this.furniturePoll = null;
    }
    this.body.scrollTop = 0;
  }

  // ---------------------------------------------------------------- render
  private render() {
    const v = this.view;
    const brand = `<div class="desktop-brand"><span class="logo">${icon('roof', 18)}</span>WalkIn</div>`;
    this.body.innerHTML =
      brand +
      (v.name === 'import'
        ? this.flow.renderImport(this.results.map((r) => this.resultCard(r)).join(''))
        : v.name === 'discover'
          ? this.renderDiscover()
          : v.name === 'review'
            ? this.flow.renderReview()
            : v.name === 'processing'
              ? this.renderProcessing()
              : this.renderExplore(v.tab));
  }

  /** Re-render without jumping to the top (review edits). */
  private renderKeepScroll() {
    const y = this.body.scrollTop;
    this.render();
    this.body.scrollTop = y;
  }

  private renderDiscover() {
    const demo = this.results.length ? this.results.map((r) => this.resultCard(r)).join('') : '';
    const near = this.nearLoading
      ? '<div class="empty">Finding listings…</div>'
      : this.nearby.length
        ? this.nearby.map((l, i) => this.nearbyCard(l, i)).join('')
        : this.nearNotice
          ? `<div class="callout info">${icon('info')}<div>${esc(this.nearNotice)}</div></div>`
          : '';
    return `
      <div class="view-head"><button class="icon-btn" data-action="home" aria-label="Back">${icon('back')}</button><div class="grow"><div class="sub">Browse listings</div></div></div>
      ${this.nearPlace ? '' : `<h1>Find a listing on the map</h1>
      <p class="lede">Tap the map or use your location to see listings nearby, then open one to review its photos and floor plan.</p>`}
      <div class="search-row">
        <form id="search-form" class="search" role="search">
          ${icon('search')}
          <input id="q" value="${esc(this.query)}" placeholder="City, postcode or address" aria-label="Search a place" autocomplete="off" enterkeyhint="search" />
        </form>
        <button class="icon-btn locate" data-action="locate" aria-label="Use my location" title="Use my location">${icon('locate', 20)}</button>
      </div>
      ${
        this.nearPlace || this.nearLoading
          ? `<div class="near-head"><h3>${this.nearLoading ? 'Searching…' : `Near ${esc(this.nearPlace?.label || 'here')}`}</h3>
             <div class="segmented small">${(['rent', 'buy'] as const).map((m) => `<button data-action="mode" data-mode="${m}" class="${this.mode === m ? 'active' : ''}">${m === 'rent' ? 'To rent' : 'For sale'}</button>`).join('')}</div></div>
             <div id="nearby">${near}</div>`
          : `<p class="xs faint" style="margin-top:8px">UK listings from Rightmove · US listings from Realtor.com · only homes with a floor plan</p>`
      }
      ${demo ? `<h3>Try the demo home</h3>${demo}` : ''}`;
  }

  private nearbyCard(l: NearbyListing, i: number) {
    return `
      <button class="card listing" data-action="open-nearby" data-index="${i}">
        <div class="thumb">${l.photoUrl ? `<img src="${esc(l.photoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : icon('photo', 26)}</div>
        <div>
          <div class="title">${i + 1}. ${esc(l.address)}</div>
          <div class="meta">${[l.priceText, l.bedrooms != null ? `${l.bedrooms} bed` : '', l.bathrooms != null ? `${l.bathrooms} bath` : ''].filter(Boolean).map(esc).join(' · ')}</div>
          <div class="src">${esc(l.providerLabel)}${l.hasFloorPlan ? ` <span class="tag ok">Floor plan</span>` : ''}</div>
        </div>
      </button>`;
  }

  /** Listings near a point (from a map tap, search or the user's location). */
  private async searchAt(lat: number, lng: number) {
    if (this.view.name !== 'discover') return;
    this.globe?.dropAt(lat, lng);
    this.nearLoading = true;
    this.nearNotice = null;
    this.nearby = [];
    this.sheet.set('half');
    this.render();
    try {
      const r = await api.nearby(lat, lng, this.mode);
      this.nearPlace = r.place;
      this.nearby = r.listings;
      this.nearNotice = r.notice;
      this.globe?.setListings(
        r.listings.map((l, i) => ({ id: String(i), lat: l.lat, lng: l.lng, title: l.address, photoUrl: l.photoUrl })),
        (id) => void this.openNearby(Number(id)),
      );
    } catch (e) {
      this.nearNotice = e instanceof ApiError ? e.message : 'Couldn’t load listings right now.';
      this.nearPlace ??= { lat, lng, label: '', countryCode: '' };
    }
    this.nearLoading = false;
    if (this.view.name === 'discover') this.render();
  }

  private async openNearby(i: number) {
    const l = this.nearby[i];
    if (!l) return;
    this.globe?.highlight(String(i));
    this.body.querySelectorAll('.listing.active').forEach((n) => n.classList.remove('active'));
    this.body.querySelector(`[data-action="open-nearby"][data-index="${i}"]`)?.classList.add('active');
    await this.globe?.flyToBuilding(l.lat, l.lng);
    try {
      if (l.importedPropertyId) return await this.openProperty(l.importedPropertyId);
      this.toast(`Loading the ${l.providerLabel} listing…`);
      const { property } = await api.importListing(l.provider, l.listingId);
      l.importedPropertyId = property.id;
      await this.openProperty(property.id);
    } catch (e) {
      this.toast(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  private locate() {
    if (!navigator.geolocation) return this.toast('This browser can’t share your location. Search instead.');
    navigator.geolocation.getCurrentPosition(
      (pos) => void this.searchAt(pos.coords.latitude, pos.coords.longitude),
      (err) => this.toast(err.code === err.PERMISSION_DENIED ? 'Location is blocked. Allow it in your browser, or search instead.' : 'Couldn’t get your location. Search instead.'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  }

  private resultCard(r: SearchResult) {
    const thumb = r.thumbnailUrl;
    return `
      <button class="card listing" data-action="open-listing" data-provider="${esc(r.provider)}" data-listing="${esc(r.listingId)}" data-pid="${esc(r.importedPropertyId ?? '')}">
        <div class="thumb">${thumb ? `<img src="${esc(thumb.startsWith('/api') ? absoluteApiUrl(thumb) : thumb)}" alt="" loading="lazy" />` : icon('plan', 28)}</div>
        <div>
          <div class="title">${esc(r.address)}</div>
          <div class="meta">${[r.price ? price(r.price) : '', r.bedrooms != null ? `${r.bedrooms} bed` : '', r.areaSqM ? `${r.areaSqM} m²` : ''].filter(Boolean).map(esc).join(' · ')}</div>
          <div class="tags">
            <span class="tag ${r.hasFloorplan ? 'ok' : 'bad'}">${icon(r.hasFloorplan ? 'check' : 'close', 12)}Floor plan</span>
            <span class="tag ${r.photoCount ? 'ok' : ''}">${r.photoCount} photos</span>
          </div>
        </div>
      </button>`;
  }

  private async loadResults(q: string) {
    this.query = q;
    try {
      const { results } = await api.search(q);
      this.results = results;
    } catch (e) {
      this.results = [];
      this.toast((e as Error).message);
    }
    if (this.view.name === 'discover') this.render();
  }

  private renderProcessing() {
    return `
      <div class="eyebrow">Building</div>
      <h2>Creating your 3D home</h2>
      <div id="job"><div class="progress"><div style="width:2%"></div></div><p class="small muted">Starting…</p></div>`;
  }

  private renderJob(run: ReconstructionRun) {
    const reached = STEPS.findIndex(([s]) => s === run.state);
    const failed = run.state === 'FAILED';
    const steps = STEPS.map(([s, label, key], i) => {
      let cls = run.state === 'READY' || i <= reached ? 'done' : failed && i === reached + 1 ? 'failed' : i === reached + 1 || (i === 0 && reached < 0 && !failed) ? 'active' : '';
      const warn = run.logs.filter((l) => l.step === key && l.level !== 'info').pop();
      if (cls === 'done' && warn && SKIPPED_RE.test(warn.message)) cls = 'skipped';
      const last = run.logs.filter((l) => l.step === key).pop();
      const note = cls === 'skipped' ? warn!.message : cls === 'active' || cls === 'failed' ? (failed ? run.errorMessage : last?.message) : '';
      return `<li class="${cls}"><span class="badge">${cls === 'done' ? icon('check', 14) : cls === 'failed' ? icon('close', 14) : cls === 'skipped' ? '–' : ''}</span><div>${esc(label)}${cls === 'skipped' ? ' <span class="tag">skipped</span>' : ''}${note ? `<div class="xs muted">${esc(note)}</div>` : ''}</div></li>`;
    }).join('');
    const logs = run.logs
      .slice(-30)
      .map((l) => `<li class="log-${l.level}">${esc(l.message)}</li>`)
      .join('');
    return `
      <div class="progress"><div style="width:${Math.max(2, Math.round(run.progress * 100))}%"></div></div>
      <p class="small muted">${failed ? '' : run.totalCostEstimate || 'No AI calls yet'}</p>
      ${failed ? `<div class="callout">${icon('alert')}<div><b>Something went wrong.</b> ${esc(run.errorMessage)}</div></div><button class="btn block" data-action="back-listing">Back to the media</button><p class="xs faint">The property and its images are kept; fix the problem and generate again.</p>` : ''}
      <ul class="steps">${steps}</ul>
      ${['SHELL_BUILT', 'MEDIA_MATCHED', 'SEGMENTED', 'PLACED', 'VERIFIED'].includes(run.state) ? `<div class="hint">${icon('cube')}The walls are already up in the 3D view. Furniture is on its way.</div>` : ''}
      <details><summary>Technical log <span class="faint">${run.logs.length}</span></summary><ul class="logs">${logs}</ul></details>`;
  }

  private renderExplore(tab: Tab) {
    const s = app.scene.value;
    if (!s) return '<div class="empty">Loading 3D model…</div>';
    const walking = app.mode.value === 'walk';
    return `
      <div class="view-head">
        <button class="icon-btn" data-action="back-listing" aria-label="Back to media" title="Back to media">${icon('back')}</button>
        <div class="grow"><h2 class="truncate" style="font-size:17px">${esc(s.property.address)}</h2><div class="sub">${s.structure.levels.length} floors · ${s.structure.rooms.length} rooms${estimatedLayout(s) ? ' · <span class="badge-est">estimated layout</span>' : ''}</div></div>
      </div>
      ${s.furniture3d?.running ? `<div class="hint furniture3d">${icon('sparkle')}<span>Building 3D furniture from the photos: <b>${s.furniture3d.done} of ${s.furniture3d.total}</b> done${s.furniture3d.failed ? `, ${s.furniture3d.failed} kept as stand-ins` : ''}. Models appear as they finish; you can explore meanwhile.</span></div>` : s.furniture3d && s.furniture3d.total ? `<p class="xs muted">${s.furniture3d.done} of ${s.furniture3d.total} pieces of furniture rebuilt from the photos with SAM 3D.</p>` : ''}
      ${walking ? '' : `<div class="segmented" role="tablist">${(['explore', 'rooms', 'evidence'] as const).map((t) => `<button role="tab" data-action="tab" data-tab="${t}" class="${t === tab ? 'active' : ''}">${{ explore: 'Explore', rooms: 'Rooms', evidence: 'How it’s built' }[t]}</button>`).join('')}</div>`}
      ${walking || tab === 'explore' ? this.renderControls(s) : tab === 'rooms' ? this.renderRooms(s) : this.renderEvidence(s)}`;
  }

  private renderControls(s: SceneManifest) {
    const walking = app.mode.value === 'walk';
    const room = s.structure.rooms.find((r) => r.id === app.selectedRoomId.value);
    const on = (b: boolean) => (b ? 'on' : '');
    const tool = (action: string, ic: string, label: string, active: boolean, key?: string, extra = '') =>
      `<button class="tool ${on(active)}" data-action="${action}" ${extra} aria-pressed="${active}">${icon(ic, 20)}${label}${key ? `<kbd>${key}</kbd>` : ''}</button>`;

    if (walking) {
      const level = s.structure.levels.find((l) => l.id === app.walkLevelId.value);
      const here = s.structure.rooms.find((r) => r.id === app.selectedRoomId.value && r.levelId === app.walkLevelId.value);
      const lvlIdx = level?.index ?? 0;
      return `
        <div class="room-card card">
          <div class="grow"><div class="name">Walking · ${esc(level?.name ?? '')}</div>
          <div class="meta"><span class="touch-only">Tap a white circle to move there. Drag to look around.</span><span class="desktop-only">Click a white circle to move there, drag to look, or use <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>.</span></div></div>
        </div>
        <div class="walk-actions">
          ${s.structure.levels.length > 1 ? `${tool('level-up', 'up', 'Upstairs', false, '', lvlIdx >= s.structure.levels.length - 1 ? 'disabled' : '')}${tool('level-down', 'down', 'Downstairs', false, '', lvlIdx === 0 ? 'disabled' : '')}` : ''}
          ${tool('toggle', 'moon', 'Night', app.night.value, '', 'data-key="night"')}
          ${tool('toggle', 'sofa', 'Empty', app.furnitureHidden.value, '', 'data-key="furnitureHidden"')}
        </div>
        ${here ? `<div class="level-label">Photos of ${esc(here.label)}</div>${this.photoStrip(s, here.id)}` : ''}
        ${this.objectBlock(s)}
        <button class="btn primary block" style="margin-top:12px" data-action="exit-room">${icon('cube')}Back to dollhouse <kbd>Esc</kbd></button>`;
    }

    const roomBlock = room
      ? (() => {
          const ev = roomEvidence(room);
          return `<div class="room-card card">
            <div class="grow"><div class="name truncate">${esc(room.label)}</div>
            <div class="meta">${room.areaSqM.toFixed(1)} m² · <span class="tag ${ev.cls}">${ev.text}</span></div></div>
            <button class="btn primary" data-action="enter-room">${icon('walk')}Walk in</button>
          </div>${this.photoStrip(s, room.id)}`;
        })()
      : `<div class="hint">${icon('door')}<span>Tap a floor in the model, or pick a room below, then walk in.</span></div>`;

    return `
      ${this.objectBlock(s)}
      ${roomBlock}
      <div class="scroller tools-grid">
        ${tool('separate', 'layers', 'Floors', floorsSeparated(), '1')}
        ${tool('toggle', 'roof', 'Roof off', app.roofHidden.value, 'H', 'data-key="roofHidden"')}
        ${tool('toggle', 'walls', 'Walls off', app.wallsHidden.value, 'W', 'data-key="wallsHidden"')}
        ${tool('toggle', 'pull', 'Pull wall', app.wallMode.value, 'P', 'data-key="wallMode"')}
        ${tool('toggle', 'sofa', 'Empty', app.furnitureHidden.value, 'F', 'data-key="furnitureHidden"')}
        ${tool('toggle', 'moon', 'Night', app.night.value, 'N', 'data-key="night"')}
        ${tool('toggle', 'eye', 'Evidence', app.evidenceView.value, 'V', 'data-key="evidenceView"')}
        ${tool('reset', 'reset', 'Reset', false, 'R')}
      </div>
      ${app.wallMode.value ? `<p class="xs muted" style="margin-top:8px">Tap a wall to slide it out, tap again to put it back.</p>` : ''}
      ${app.evidenceView.value ? `<div class="legend"><span><i style="background:#4caf7a"></i>Photo + measured</span><span><i style="background:#e0b24a"></i>Measured, no photo</span><span><i style="background:#d9645a"></i>Estimated</span></div>` : ''}
      ${s.structure.levels
        .map(
          (l) => `<div class="level-label">${esc(l.name)}</div>
        <div class="scroller">${s.structure.rooms
          .filter((r) => r.levelId === l.id)
          .map((r) => `<button class="chip ${r.id === room?.id ? 'on' : ''}" data-action="pick-room" data-room="${esc(r.id)}"><span class="dot" style="background:${roomEvidence(r).color}"></span>${esc(r.label)}</button>`)
          .join('')}</div>`,
        )
        .join('')}
      <p class="xs faint" style="margin-top:16px"><span class="touch-only">Drag to orbit · pinch to zoom.</span><span class="desktop-only">Drag to orbit · scroll to zoom · click furniture to select it.</span></p>`;
  }

  private renderRooms(s: SceneManifest) {
    const photos = s.media.filter((m) => m.type === 'photo');
    const ro = staticMode ? 'disabled' : '';
    const rows = s.structure.rooms
      .map((r) => {
        const lvl = s.structure.levels.find((l) => l.id === r.levelId)!;
        const ev = roomEvidence(r);
        return `<div class="card room-row">
          <div class="top"><input class="name" data-room-label="${esc(r.id)}" value="${esc(r.label)}" ${ro} aria-label="Room name" /><span class="tag ${ev.cls}">${ev.text}</span></div>
          <div class="meta"><span>${esc(LEVEL_SHORT(lvl.name))}</span>·<span>${r.areaSqM.toFixed(1)} m²</span>·<span>${r.dimensionsMeasured ? 'size from plan' : 'size inferred'}</span>·<span>${r.linkedMediaIds.length ? `${r.linkedMediaIds.length} photo(s)` : 'no photos'}</span>·<span>${Math.round(r.confidence * 100)}% confident</span></div>
          <label class="switch" style="margin-top:10px"><input type="checkbox" data-room-uncertain="${esc(r.id)}" ${r.isEstimated ? 'checked' : ''} ${ro} />Mark as uncertain</label>
        </div>`;
      })
      .join('');
    const mappings = photos
      .map((m) => {
        const match = s.mediaMatches.find((x) => x.mediaId === m.id);
        return `<div class="map-row"><img src="${esc(mediaUrl(m))}" alt="" />
          <div><select class="field" data-photo="${esc(m.id)}" ${ro}><option value="">Not a room</option>${s.structure.rooms.map((r) => `<option value="${esc(r.id)}" ${match?.roomId === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>
          <div class="xs faint" style="margin-top:4px">${match ? `${esc(METHOD_LABELS[match.provenance.method] ?? match.provenance.method)} · ${Math.round(match.confidence * 100)}%` : 'Unmatched'}</div></div></div>`;
      })
      .join('');
    const measured = s.structure.rooms.filter((r) => r.dimensionsMeasured);
    return `
      <p class="small muted" style="margin-top:14px">Fix anything the AI got wrong, then rebuild. The floor plan isn’t re-read, so rebuilding is quick and free.</p>
      ${!staticMode && s.media.some((m) => m.type === 'floorplan') ? `<button class="btn block" data-action="edit-plan">${icon('plan')}Edit room shapes, doors and sizes on the plan</button>` : ''}
      ${rows}
      <h3>Photos → rooms</h3>
      ${mappings || '<div class="empty">No photos in this listing.</div>'}
      <h3>Scale</h3>
      <p class="small muted">${(1 / s.structure.scale.metersPerPx).toFixed(1)} px per metre, from ${s.structure.scale.method === 'dimension-labels' ? `${s.structure.scale.samples} printed measurements` : s.structure.scale.method}. If a width is wrong, enter the real one:</p>
      <div class="row2">
        <select class="field" id="ref-room" ${ro}>${(measured.length ? measured : s.structure.rooms).map((r) => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('')}</select>
        <input class="field" id="ref-width" type="number" inputmode="decimal" step="0.01" min="0.5" max="50" placeholder="Width (m)" ${ro} />
      </div>
      ${staticMode ? `<div class="callout info">${icon('info')}<div>Editing needs the WalkIn server, which isn’t reachable right now.</div></div>` : `<div class="sticky-cta"><button class="btn primary block" data-action="save-corrections">${icon('check')}Save and rebuild</button></div>`}
      ${this.caps?.redesign ? this.renderRedesign(s) : ''}`;
  }

  private renderRedesign(s: SceneManifest) {
    const photos = s.media.filter((m) => m.type === 'photo' && s.mediaMatches.some((x) => x.mediaId === m.id && x.roomId));
    if (!photos.length) return '';
    return `
      <h3>Imagine a redesign</h3>
      <p class="small muted">Creates a 2D concept image from a real room photo with Meta Muse Image. The 3D model doesn’t change.</p>
      <select class="field" id="rd-photo">${photos.map((m) => `<option value="${esc(m.id)}">${esc(s.structure.rooms.find((r) => r.id === s.mediaMatches.find((x) => x.mediaId === m.id)?.roomId)?.label ?? m.id)}</option>`).join('')}</select>
      <input class="field" style="margin-top:8px" id="rd-text" placeholder="e.g. Scandinavian, light oak, plants" maxlength="300" />
      <button class="btn block" style="margin-top:8px" data-action="redesign">${icon('sparkle')}Generate concept</button>
      <div id="rd-out" style="margin-top:10px"></div>`;
  }

  private renderEvidence(s: SceneManifest) {
    const f = s.evidenceFlags;
    const plans = s.media.filter((m) => m.type === 'floorplan');
    const geo = s.verification.geometry;
    const fails = geo.filter((c) => c.severity === 'fail').length;
    const warns = geo.filter((c) => c.severity === 'warn').length;
    return `
      ${!f.liveMetaInference ? `<div class="callout" style="margin-top:14px">${icon('info')}<div><b>Demo data.</b> This model was built from a reference reading of the plan, not live Meta AI.</div></div>` : ''}
      ${estimatedLayout(s) ? `<div class="callout" style="margin-top:14px">${icon('alert')}<div><b>Estimated layout.</b> ${f.layoutSource === 'photos' ? 'There was no floor plan, so the rooms were read from the photos and arranged into a believable plan.' : 'There was no floor plan or usable photos, so the rooms come from the listing details.'} The rooms exist, but their positions, sizes and doors are a guess.</div></div>` : ''}
      <h3>Sources</h3>
      <ul class="flags">
        <li><span>Layout from</span><span>${esc(LAYOUT_LABELS[f.layoutSource] ?? f.layoutSource)}</span></li>
        <li><span>Floor plan read by</span><span>${esc(METHOD_LABELS[f.floorplanInterpretedBy] ?? f.floorplanInterpretedBy)}</span></li>
        <li><span>Photo evidence</span><span>${esc({ none: 'None', partial: 'Some rooms', 'all-rooms': 'All rooms' }[f.photoEvidence])}</span></li>
        <li><span>Furniture detection</span><span>${f.segmentationBy ? `${esc(METHOD_LABELS[f.segmentationBy])} · ${s.detections.length}` : 'Not run'}</span></li>
        <li><span>Wall & floor finishes</span><span>${f.surfacesFromPhotos ? `${f.surfacesFromPhotos} room(s) from photos, others default` : 'Defaults by room type'}</span></li>
        <li><span>Furniture models</span><span>${f.sam3d === 'used' ? 'Some 3D-reconstructed' : 'Simple stand-in shapes'}</span></li>
        <li><span>Ceiling height</span><span>${f.ceilingHeightEstimated ? 'Estimated (2.4 m)' : 'From plan'}</span></li>
        <li><span>Scale</span><span>${f.scaleEstimated ? 'Estimated' : 'From printed sizes'}</span></li>
      </ul>
      ${plans.length ? '<h3>Source plans</h3>' : ''}
      <div class="scroller plans">${plans.map((m) => `<figure class="plan"><img src="${esc(mediaUrl(m))}" alt="Source floor plan" /></figure>`).join('')}</div>
      ${s.detections.length ? `<h3>Detected in photos</h3><div class="dets">${s.detections.slice(0, 24).map((d) => { const m = s.media.find((x) => x.id === d.mediaId); return m ? `<figure class="det"><img src="${esc(mediaUrl(m))}" alt="" />${d.maskKey && !staticMode ? `<img class="mask" src="${esc(absoluteApiUrl(`/api/masks/${d.maskKey.split('/').pop()}`))}" alt="" />` : ''}<span class="box" style="left:${d.box[0] * 100}%;top:${d.box[1] * 100}%;width:${(d.box[2] - d.box[0]) * 100}%;height:${(d.box[3] - d.box[1]) * 100}%"></span><figcaption>${esc(d.concept)}${d.score != null ? ` ${Math.round(d.score * 100)}%` : ''}</figcaption></figure>` : ''; }).join('')}</div>` : ''}
      <h3>Geometry checks · <span style="color:${fails ? 'var(--bad)' : warns ? 'var(--warn)' : 'var(--ok)'}">${fails ? `${fails} failed` : warns ? `${warns} warnings` : 'all passed'}</span></h3>
      <ul class="checks">${geo.map((c) => `<li class="sev-${c.severity}"><i></i><span>${esc(c.message)}</span></li>`).join('')}</ul>
      <h3>AI review</h3>
      <p class="small muted">${esc(s.verification.visualReview.reason)}</p>
      <ul class="checks">${s.verification.visualReview.findings.map((c) => `<li class="sev-${c.severity}"><i></i><span>${esc(c.message)}</span></li>`).join('')}</ul>
      ${f.notes.length ? `<h3>Notes</h3><ul class="checks">${f.notes.map((n) => `<li><i></i><span>${esc(n)}</span></li>`).join('')}</ul>` : ''}
      <p class="xs faint" style="margin-top:16px">Model v${s.sceneVersion} · ${esc(new Date(s.generatedAt).toLocaleString())}. Checks can’t guarantee physical accuracy.</p>`;
  }

  // ---------------------------------------------------------------- actions
  private async openProperty(propertyId: string, preferScene = false) {
    if (staticMode) {
      await this.loadScene(propertyId);
      this.go({ name: 'explore', propertyId, tab: 'explore' });
      return;
    }
    const [{ property, latestRun, hasScene }] = await Promise.all([api.property(propertyId), this.flow.load(propertyId)]);
    this.property = property;
    this.media = this.flow.media;
    history.replaceState(null, '', `?property=${encodeURIComponent(propertyId)}`);
    if (latestRun && !['READY', 'FAILED'].includes(latestRun.state)) return this.watchJob(propertyId, latestRun.id);
    if (preferScene && hasScene) {
      await this.loadScene(propertyId);
      return this.go({ name: 'explore', propertyId, tab: 'explore' });
    }
    this.go({ name: 'review', propertyId });
    if (hasScene) {
      const cta = this.body.querySelector('.sticky-cta');
      cta?.insertAdjacentHTML('beforeend', `<button class="btn block ghost" data-action="open-scene" style="margin-top:8px">Open the last 3D model</button>`);
    }
  }

  private async loadScene(propertyId: string) {
    const scene = await api.scene(propertyId);
    app.selectedRoomId.value = null;
    if (app.mode.value === 'walk') exitRoom(this.world);
    app.scene.value = scene;
    if (staticMode) this.media = scene.media;
    return scene;
  }

  private watchJob(propertyId: string, jobId: string) {
    this.go({ name: 'processing', propertyId, jobId });
    this.lastShellVersion = 0;
    const tick = async () => {
      try {
        const run = await api.job(jobId);
        const box = this.body.querySelector('#job');
        if (box) {
          const open = (box.querySelector('details') as HTMLDetailsElement | null)?.open;
          box.innerHTML = this.renderJob(run);
          if (open) (box.querySelector('details') as HTMLDetailsElement).open = true;
        }
        const shellReady = ['SHELL_BUILT', 'MEDIA_MATCHED', 'SEGMENTED', 'PLACED', 'VERIFIED'].includes(run.state);
        if (shellReady && !this.lastShellVersion) {
          const scene = await this.loadScene(propertyId).catch(() => null);
          if (scene) this.lastShellVersion = scene.sceneVersion;
        }
        if (run.state === 'READY' || run.state === 'FAILED') {
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
        }
        if (run.state === 'READY') {
          await this.loadScene(propertyId);
          this.go({ name: 'explore', propertyId, tab: 'explore' });
        }
      } catch (e) {
        const box = this.body.querySelector('#job');
        if (box) box.innerHTML = `<div class="callout">${icon('alert')}<div>${esc((e as Error).message)}</div></div>`;
      }
    };
    void tick();
    this.pollTimer = window.setInterval(tick, 1000);
  }

  private async onSubmit(e: Event) {
    if ((e.target as HTMLElement).id === 'import-url-form') {
      e.preventDefault();
      return this.flow.importUrl((this.body.querySelector('#listing-url') as HTMLInputElement).value.trim());
    }
    if ((e.target as HTMLElement).id !== 'search-form') return;
    e.preventDefault();
    const input = this.body.querySelector('#q') as HTMLInputElement;
    input.blur();
    this.query = input.value.trim();
    if (!this.query) return;
    if (staticMode) return void this.loadResults(this.query);
    try {
      const { place } = await api.geocode(this.query);
      await this.searchAt(place.lat, place.lng);
    } catch (err) {
      this.toast(err instanceof ApiError ? err.message : 'Search failed.');
    }
  }

  private onChange(e: Event) {
    if (this.view.name === 'import' || this.view.name === 'review') void this.flow.onChange(e.target as HTMLElement).catch((err) => this.toast((err as Error).message));
  }

  private async onClick(e: Event) {
    const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!t || (t as HTMLButtonElement).disabled) return;
    const a = t.dataset.action!;
    const v = this.view;
    const pid = 'propertyId' in v ? v.propertyId : '';
    try {
      if ((this.view.name === 'import' || this.view.name === 'review') && (await this.flow.handle(a, t))) {
        e.preventDefault();
        return;
      }
      switch (a) {
        case 'home':
          this.nearPlace = null;
          this.nearby = [];
          this.nearNotice = null;
          this.globe?.clear();
          if (app.mode.value === 'walk') exitRoom(this.world);
          history.replaceState(null, '', location.pathname);
          this.flow.reset();
          app.scene.value = null;
          this.go({ name: 'import' });
          return void this.loadResults('');
        case 'back':
          if (app.mode.value === 'walk') exitRoom(this.world);
          history.replaceState(null, '', location.pathname);
          this.go({ name: 'discover' });
          return void this.loadResults(this.query);
        case 'back-listing':
          if (staticMode) return this.go({ name: 'import' });
          if (app.mode.value === 'walk') exitRoom(this.world);
          return this.openProperty(pid);
        case 'locate':
          return this.locate();
        case 'mode':
          this.mode = t.dataset.mode as 'rent' | 'buy';
          if (this.nearPlace) return void this.searchAt(this.nearPlace.lat, this.nearPlace.lng);
          return this.render();
        case 'open-nearby':
          return void this.openNearby(Number(t.dataset.index));
        case 'open-listing': {
          if (t.dataset.pid) return this.openProperty(t.dataset.pid);
          const { property } = await api.importListing(t.dataset.provider!, t.dataset.listing!);
          return this.openProperty(property.id);
        }
        case 'reconstruct':
          (t as HTMLButtonElement).disabled = true;
          return this.build(pid);
        case 'open-photo': {
          const s = app.scene.value;
          if (!s) return;
          const ids = t.dataset.room ? s.structure.rooms.find((r) => r.id === t.dataset.room)?.linkedMediaIds ?? [] : s.media.filter((m) => m.type === 'photo').map((m) => m.id);
          return this.photos.open(s, ids, Math.max(0, ids.indexOf(t.dataset.mid ?? '')));
        }
        case 'edit-plan':
          if (this.view.name === 'explore') return this.openPlanEditor(pid);
          break;
        case 'obj-close':
          app.selectedObjectId.value = null;
          return;
        case 'obj-move':
          return nudgeObject(this.world, t.dataset.id!, Number(t.dataset.dx ?? 0), Number(t.dataset.dz ?? 0));
        case 'obj-rot':
          return nudgeObject(this.world, t.dataset.id!, 0, 0, Number(t.dataset.r));
        case 'obj-reset':
          return resetObject(this.world, t.dataset.id!);
        case 'obj-hide': {
          const id = t.dataset.id!;
          const cur = app.hiddenObjectIds.value;
          app.hiddenObjectIds.value = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
          return;
        }
        case 'obj-save':
          return this.saveObjectEdits(pid);
        case 'obj-remove': {
          const o = sceneObject(t.dataset.id!);
          if (!o || !confirm(`Remove the ${o.kind} from the model? You can bring it back by rebuilding after clearing corrections.`)) return;
          await api.saveObjects(pid, [{ id: o.id, removed: true }]);
          removeObjectLocally(this.world, o.id);
          app.scene.value!.objects = app.scene.value!.objects.filter((x) => x.id !== o.id);
          return this.toast(`${o.kind} removed and saved.`);
        }
        case 'obj-sam3d':
          return this.requestSam3d(pid, t.dataset.id!);
        case 'open-scene':
          await this.loadScene(pid);
          return this.go({ name: 'explore', propertyId: pid, tab: 'explore' });
        case 'tab':
          this.view = { name: 'explore', propertyId: pid, tab: t.dataset.tab as Tab };
          if (this.sheet.current === 'peek') this.sheet.set('half');
          return this.render();
        case 'pick-room':
          app.selectedRoomId.value = t.dataset.room ?? null;
          return;
        case 'separate':
          return separateFloors(!floorsSeparated());
        case 'reset':
          return resetBuilding();
        case 'toggle': {
          const key = t.dataset.key as 'roofHidden';
          app[key].value = !app[key].value;
          return;
        }
        case 'enter-room':
          if (app.selectedRoomId.value) enterRoom(this.world, app.selectedRoomId.value);
          return;
        case 'exit-room':
          return exitRoom(this.world);
        case 'level-up':
          return void changeLevel(this.world, 1);
        case 'level-down':
          return void changeLevel(this.world, -1);
        case 'save-corrections':
          return this.saveCorrections(pid);
        case 'redesign':
          return this.redesign(pid);
      }
    } catch (err) {
      this.toast(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  private async saveCorrections(pid: string) {
    const s = app.scene.value!;
    const roomLabels = [...this.body.querySelectorAll<HTMLInputElement>('[data-room-label]')]
      .filter((i) => s.structure.rooms.find((r) => r.id === i.dataset.roomLabel)?.label !== i.value.trim() && i.value.trim())
      .map((i) => ({ roomId: i.dataset.roomLabel!, label: i.value.trim() }));
    const uncertainRoomIds = [...this.body.querySelectorAll<HTMLInputElement>('[data-room-uncertain]')].filter((i) => i.checked).map((i) => i.dataset.roomUncertain!);
    const mappings = [...this.body.querySelectorAll<HTMLSelectElement>('[data-photo]')]
      .filter((sel) => (s.mediaMatches.find((m) => m.mediaId === sel.dataset.photo)?.roomId ?? '') !== sel.value)
      .map((sel) => ({ mediaId: sel.dataset.photo!, roomId: sel.value || null }));
    const width = Number((this.body.querySelector('#ref-width') as HTMLInputElement).value);
    const referenceMeasurement = width > 0 ? { roomId: (this.body.querySelector('#ref-room') as HTMLSelectElement).value, widthM: width } : null;
    await api.saveMappings(pid, { roomLabels, uncertainRoomIds, mappings, referenceMeasurement });
    const { jobId } = await api.reconstruct(pid);
    this.watchJob(pid, jobId);
  }

  private async redesign(pid: string) {
    const s = app.scene.value!;
    const mediaId = (this.body.querySelector('#rd-photo') as HTMLSelectElement).value;
    const text = (this.body.querySelector('#rd-text') as HTMLInputElement).value.trim();
    const roomId = s.mediaMatches.find((m) => m.mediaId === mediaId)?.roomId;
    const out = this.body.querySelector('#rd-out')!;
    if (!roomId || text.length < 3) return this.toast('Choose a photo and describe the style');
    out.innerHTML = '<p class="small muted">Generating with Muse Image…</p>';
    const r = await api.visualise(pid, roomId, mediaId, text);
    out.innerHTML = `<figure><img style="border-radius:12px" src="${esc(absoluteApiUrl(r.url))}" alt="AI concept" /><figcaption>${esc(r.label)}</figcaption></figure>`;
  }

  private onKey(e: KeyboardEvent) {
    if (this.view.name !== 'explore' || (e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
    const k = e.key.toLowerCase();
    if (app.mode.value === 'walk') {
      if (k === 'escape') exitRoom(this.world);
      return;
    }
    const sel = app.selectedObjectId.value;
    if (sel && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', '[', ']'].includes(k)) {
      e.preventDefault();
      const step = e.shiftKey ? 0.5 : 0.1;
      if (k === '[' || k === ']') return nudgeObject(this.world, sel, 0, 0, ((k === '[' ? 1 : -1) * Math.PI) / 12);
      return nudgeObject(this.world, sel, k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0);
    }
    if (sel && k === 'escape') return void (app.selectedObjectId.value = null);
    const toggles: Record<string, 'roofHidden' | 'wallsHidden' | 'furnitureHidden' | 'night' | 'evidenceView' | 'wallMode'> = { h: 'roofHidden', w: 'wallsHidden', f: 'furnitureHidden', n: 'night', v: 'evidenceView', p: 'wallMode' };
    if (toggles[k]) app[toggles[k]].value = !app[toggles[k]].value;
    else if (k === '1') separateFloors(!floorsSeparated());
    else if (k === 'r') resetBuilding();
    else if (k === 'e' && app.selectedRoomId.value) enterRoom(this.world, app.selectedRoomId.value);
  }

  /** While SAM 3D models are still being made, reload the scene as they land (every 8 s). */
  private watchFurniture(pid: string) {
    if (this.furniturePoll) clearInterval(this.furniturePoll);
    this.furniturePoll = null;
    if (staticMode || !app.scene.value?.furniture3d?.running) return;
    this.furniturePoll = window.setInterval(async () => {
      const cur = app.scene.value;
      if (this.view.name !== 'explore' || !cur) return;
      const next = await api.scene(pid).catch(() => null);
      if (!next) return;
      if (next.sceneVersion !== cur.sceneVersion) {
        app.scene.value = next;
        if (this.view.name === 'explore' && this.view.tab === 'explore' && app.mode.value !== 'walk') this.render();
      }
      if (!next.furniture3d?.running && this.furniturePoll) {
        clearInterval(this.furniturePoll);
        this.furniturePoll = null;
        this.toast(`3D furniture finished: ${next.furniture3d?.done ?? 0} piece(s) rebuilt from the photos.`);
        this.render();
      }
    }, 8000);
  }

  private async build(pid: string, opts: { sam3dApproved?: boolean; sam3dMaxObjects?: number } = {}) {
    const { jobId } = await api.reconstruct(pid, opts);
    this.watchJob(pid, jobId);
  }

  private openPlanEditor(pid: string) {
    const media = this.view.name === 'explore' && app.scene.value ? app.scene.value.media : this.flow.media;
    const ed = new PlanEditor(
      pid,
      media,
      async (saved, rebuild) => {
        if (!saved) return;
        await this.flow.load(pid).catch(() => undefined);
        if (rebuild) await this.build(pid);
        else {
          this.toast('Floor plan saved. Generate 3D to see it.');
          if (this.view.name === 'review') this.renderKeepScroll();
        }
      },
      (m) => this.toast(m),
    );
    void ed.open().catch((e) => {
      ed.close();
      this.toast((e as Error).message);
    });
  }

  /** Thumbnails of the photos matched to a room; click to compare with the model. */
  private photoStrip(s: SceneManifest, roomId: string) {
    const room = s.structure.rooms.find((r) => r.id === roomId);
    const ms = (room?.linkedMediaIds ?? []).map((id) => s.media.find((m) => m.id === id)).filter((m): m is PropertyMedia => !!m);
    if (!ms.length) return `<p class="xs faint">No listing photo shows this room; its look and furniture are typical for the room type, not observed.</p>`;
    return `<div class="scroller photo-strip">${ms.map((m) => `<button class="thumb-btn" data-action="open-photo" data-mid="${esc(m.id)}" data-room="${esc(roomId)}" aria-label="Open photo"><img src="${esc(mediaUrl(m))}" alt="" loading="lazy" /></button>`).join('')}</div>`;
  }

  /** The selected piece of furniture: what it is, where it came from, and controls. */
  private objectBlock(s: SceneManifest) {
    const o = sceneObject(app.selectedObjectId.value);
    if (!o) return '';
    const hidden = app.hiddenObjectIds.value.includes(o.id);
    const edited = !!app.objectEdits.value[o.id];
    const typical = o.placementNotes.some((n) => n.startsWith('Typical '));
    const what =
      o.reconstructionMethod === 'sam3d'
        ? o.modelFormat === 'ply-splat'
          ? { cls: 'ok', text: 'SAM 3D splat', note: 'Reconstructed from a photo by SAM 3D Objects. Shown as a point cloud — a Gaussian splat is not an editable mesh. Size and position are estimates.' }
          : { cls: 'ok', text: 'SAM 3D mesh', note: 'Reconstructed from a photo by SAM 3D Objects, scaled to the estimated size.' }
        : typical
          ? { cls: 'bad', text: 'Typical, not seen', note: 'No photo shows this; it is typical furniture for the room type. Simple stand-in shape.' }
          : o.provenance.method === 'admin-correction' && o.provenance.note?.includes('fixture')
            ? { cls: 'warn', text: 'Demo data', note: 'Hand-authored demo placement. Simple stand-in shape.' }
            : o.sourceMediaIds.length
              ? { cls: 'warn', text: 'Seen in a photo', note: 'Identified in a listing photo. Shown as a simple stand-in shape with an estimated size and position, not an exact copy.' }
              : { cls: 'warn', text: 'Approximate', note: 'Simple stand-in shape; size and position are estimates.' };
    const room = s.structure.rooms.find((r) => r.id === o.roomId);
    const photos = o.sourceMediaIds.map((id) => s.media.find((m) => m.id === id)).filter((m): m is PropertyMedia => !!m);
    const dets = s.detections.filter((d) => o.sourceMediaIds.includes(d.mediaId));
    const btn = (action: string, label: string, extra = '') => `<button class="btn small" data-action="${action}" data-id="${esc(o.id)}" ${extra}>${label}</button>`;
    const pad = (dx: number, dz: number, lbl: string) => `<button class="icon-btn s" data-action="obj-move" data-id="${esc(o.id)}" data-dx="${dx}" data-dz="${dz}" aria-label="Move ${lbl}">${lbl}</button>`;
    const sam3d = this.caps?.sam3d
      ? dets.length
        ? `<div class="xs muted" style="margin-top:8px">Rebuild this item from a photo with SAM 3D (${esc(this.caps.sam3dProvider ?? '')}). Pick the outline to use:</div>
           <div class="dets small">${dets.slice(0, 6).map((d, i) => { const m = s.media.find((x) => x.id === d.mediaId); return m ? `<label class="det"><input type="radio" name="sam3d-det" value="${esc(d.id)}" ${i === 0 ? 'checked' : ''} /><img src="${esc(mediaUrl(m))}" alt="" /><span class="box" style="left:${d.box[0] * 100}%;top:${d.box[1] * 100}%;width:${(d.box[2] - d.box[0]) * 100}%;height:${(d.box[3] - d.box[1]) * 100}%"></span><span class="cap">${esc(d.concept)}</span></label>` : ''; }).join('')}</div>
           ${btn('obj-sam3d', `${icon('sparkle', 14)}${this.objectJob ? 'Reconstructing…' : o.reconstructionMethod === 'sam3d' ? 'Regenerate with SAM 3D' : 'Reconstruct with SAM 3D'}`, this.objectJob ? 'disabled' : '')} <span class="xs faint">paid inference · asks first</span>`
        : `<p class="xs faint" style="margin-top:8px">SAM 3D needs a SAM 3.1 outline of this item from a photo; none exists yet (segmentation runs during a live AI build).</p>`
      : `<p class="xs faint" style="margin-top:8px">3D reconstruction (SAM 3D) is off on this server${this.sam3dReason ? `: ${esc(this.sam3dReason)}` : '.'}</p>`;
    return `<div class="card obj-card">
      <div class="obj-top"><b>${esc(o.kind.replace(/-/g, ' '))}</b><span class="tag ${what.cls}">${what.text}</span><span class="grow"></span><button class="icon-btn s" data-action="obj-close" aria-label="Deselect">${icon('close', 14)}</button></div>
      <p class="xs muted">${esc(room?.label ?? '')} · ${o.sizeM.map((v) => v.toFixed(2)).join(' × ')} m (estimated) · placement ${Math.round(o.placementConfidence * 100)}% confident</p>
      <p class="xs">${esc(what.note)}</p>
      ${photos.length ? `<div class="scroller photo-strip">${photos.map((m) => `<button class="thumb-btn" data-action="open-photo" data-mid="${esc(m.id)}" data-room="${esc(o.roomId)}"><img src="${esc(mediaUrl(m))}" alt="" /></button>`).join('')}</div>` : ''}
      <div class="obj-tools">
        <div class="dpad">${pad(0, -0.1, '↑')}<div>${pad(-0.1, 0, '←')}${pad(0.1, 0, '→')}</div>${pad(0, 0.1, '↓')}</div>
        <div class="obj-btns">
          ${btn('obj-rot', `${icon('rotate', 14)}−15°`, `data-r="${Math.PI / 12}"`)}${btn('obj-rot', `${icon('rotate', 14)}+15°`, `data-r="${-Math.PI / 12}"`)}
          ${btn('obj-hide', hidden ? 'Show' : 'Hide')}${btn('obj-remove', 'Remove')}
          ${edited ? `${btn('obj-reset', 'Undo move')}${staticMode ? '' : btn('obj-save', `${icon('check', 14)}Save`, 'data-primary')}` : ''}
        </div>
      </div>
      <p class="xs faint desktop-only">Arrow keys move 10 cm (Shift: 50 cm), [ and ] turn. Hiding only affects this browser.</p>
      ${staticMode ? '' : sam3d}
    </div>`;
  }

  private async saveObjectEdits(pid: string) {
    const edits = app.objectEdits.value;
    const list = Object.entries(edits).map(([id, e]) => ({ id, positionXZ: [e.x, e.z] as [number, number], rotationY: e.rotationY }));
    if (!list.length) return;
    await api.saveObjects(pid, list);
    // Keep the loaded scene in step without rebuilding the house.
    for (const o of app.scene.value!.objects) {
      const e = edits[o.id];
      if (e) {
        o.positionXYZ = [e.x, o.positionXYZ[1], e.z];
        o.rotationY = e.rotationY;
      }
    }
    app.objectEdits.value = {};
    this.toast(`Saved ${list.length} change(s). They are kept when the model is rebuilt.`);
  }

  private async requestSam3d(pid: string, objectId: string) {
    const o = sceneObject(objectId);
    const det = (this.body.querySelector('input[name="sam3d-det"]:checked') as HTMLInputElement | null)?.value;
    if (!o || !det) return;
    if (!confirm(`Send this ${o.kind} to SAM 3D (${this.caps?.sam3dProvider ?? 'GPU'})? This is paid inference on your account. Results are cached, so the same request is never billed twice.`)) return;
    const { job } = await api.reconstructObject(pid, objectId, det);
    this.objectJob = job.id;
    this.render();
    const poll = async () => {
      const j = await api.objectJob(job.id).catch(() => null);
      if (j && j.state === 'running') return void setTimeout(poll, 3000);
      this.objectJob = null;
      this.toast(j?.message ?? 'SAM 3D request ended.');
      if (j?.state === 'done') await this.loadScene(pid);
      else this.render();
    };
    setTimeout(poll, 2000);
  }

  private toast(msg: string) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }

  /** Kick off the first listing search once the panel is on screen. */
  initialSearch() {
    void this.loadResults('');
  }
}
