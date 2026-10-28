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

type Tab = 'explore' | 'rooms' | 'evidence';
type View =
  | { name: 'discover' }
  | { name: 'listing'; propertyId: string }
  | { name: 'processing'; propertyId: string; jobId: string }
  | { name: 'explore'; propertyId: string; tab: Tab };

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STEPS: [ReconstructionRun['state'], string][] = [
  ['INGESTED', 'Reading the listing'],
  ['STRUCTURE_PARSED', 'Interpreting the floor plan'],
  ['SHELL_BUILT', 'Building walls and floors'],
  ['MEDIA_MATCHED', 'Matching photos to rooms'],
  ['SEGMENTED', 'Finding furniture in photos'],
  ['PLACED', 'Placing furniture'],
  ['VERIFIED', 'Checking the result'],
  ['READY', 'Ready to explore'],
];

const METHOD_LABELS: Record<string, string> = {
  'meta:muse-spark-1.3': 'Meta Muse Spark',
  'meta:muse-wonder-1.0': 'Meta Muse Wonder',
  'meta:sam-3.1': 'Meta SAM 3.1',
  'fixture:hand-authored': 'Demo data (no live AI)',
  'admin-correction': 'Manual correction',
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
  private view: View = { name: 'discover' };
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
    document.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('submit', (e) => this.onSubmit(e));
    this.body.addEventListener('change', (e) => this.onChange(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    for (const s of [app.selectedRoomId, app.mode, app.levelLift, app.roofHidden, app.wallsHidden, app.furnitureHidden, app.night, app.evidenceView, app.wallMode, app.pulledWalls, app.walkLevelId]) {
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
    const pid = new URLSearchParams(location.search).get('property');
    if (pid) await this.openProperty(pid, true).catch(() => this.go({ name: 'discover' }));
    else this.go({ name: 'discover' });
  }

  private renderStatus() {
    const el = document.getElementById('status-pill')!;
    el.hidden = false;
    const live = !!this.caps?.liveMeta && !staticMode;
    el.innerHTML = `<span class="status-dot ${live ? 'live' : ''}"></span>${staticMode ? 'Offline demo' : live ? 'Live AI' : 'Demo data'}`;
    el.title = staticMode ? 'API not reachable: showing pre-built scenes' : live ? `${this.caps!.museModel} · ${this.caps!.samModel}` : 'MODEL_API_KEY not set on the server: using demo data';
  }

  private go(v: View) {
    this.view = v;
    if (this.pollTimer && v.name !== 'processing') {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.sheet.set(v.name === 'listing' ? 'full' : 'half');
    this.globe?.show(v.name === 'discover' || v.name === 'listing');
    this.render();
    this.body.scrollTop = 0;
  }

  // ---------------------------------------------------------------- render
  private render() {
    const v = this.view;
    const brand = `<div class="desktop-brand"><span class="logo">${icon('roof', 18)}</span>WalkIn</div>`;
    this.body.innerHTML =
      brand +
      (v.name === 'discover' ? this.renderDiscover() : v.name === 'listing' ? this.renderListing() : v.name === 'processing' ? this.renderProcessing() : this.renderExplore(v.tab));
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
      ${this.nearPlace ? '' : `<div class="eyebrow">WalkIn</div><h1>Find a home, then walk through it</h1>
      <p class="lede">Tap the map or use your location to see listings nearby, then explore any of them in 3D on your phone, computer or Meta Quest.</p>`}
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
          : `<p class="xs faint" style="margin-top:8px">UK listings from Zoopla · US listings from Zillow and Realtor.com</p>`
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
          <div class="src">${esc(l.providerLabel)}</div>
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

  private renderListing() {
    const p = this.property;
    if (!p) return '<div class="empty">Loading…</div>';
    const plans = this.media.filter((m) => m.type === 'floorplan');
    const photos = this.media.filter((m) => m.type === 'photo');
    return `
      <div class="view-head">
        <button class="icon-btn" data-action="back" aria-label="Back">${icon('back')}</button>
        <div class="grow"><div class="sub">${esc(p.status === 'to-let' ? 'To let' : p.status)}</div></div>
      </div>
      <h2>${esc(p.address)}</h2>
      <div class="facts">
        <div class="fact">${icon('door', 16)}<b>${esc(price(p.price))}</b><span>${p.price?.period === 'pcm' ? 'per month' : 'price'}</span></div>
        <div class="fact">${icon('bed', 16)}<b>${p.bedrooms ?? '—'}</b><span>bedrooms</span></div>
        <div class="fact">${icon('area', 16)}<b>${p.areaSqM ?? '—'}</b><span>m²</span></div>
        <div class="fact">${icon('photo', 16)}<b>${photos.length}</b><span>photos</span></div>
      </div>
      <h3>Floor plans</h3>
      ${
        plans.length
          ? `<div class="scroller plans">${plans.map((m, i) => `<a class="plan" href="${esc(mediaUrl(m))}" target="_blank" rel="noopener"><figure><img src="${esc(mediaUrl(m))}" alt="Floor plan" /><figcaption>${esc(m.levelGuess === 'L0' ? 'Ground floor' : m.levelGuess === 'L1' ? 'First floor' : `Plan ${i + 1}`)}</figcaption></figure></a>`).join('')}</div>`
          : `<div class="callout">${icon('alert')}<div><b>No floor plan.</b> WalkIn won’t invent a layout. Upload a plan you have rights to use.</div></div>`
      }
      <h3>Photos</h3>
      ${photos.length ? `<div class="scroller plans">${photos.map((m) => `<figure class="plan"><img src="${esc(mediaUrl(m))}" alt="Listing photo" /></figure>`).join('')}</div>` : `<div class="empty">${icon('photo', 22)}<br />No photos yet. Rooms will be marked as having no photo evidence.</div>`}
      ${p.missingData.length ? `<div class="callout">${icon('info')}<div><b>Not in this listing</b><ul>${p.missingData.map((m) => `<li>${esc(m.split(' — ')[0])}</li>`).join('')}</ul></div></div>` : ''}
      <p class="xs faint">${esc(p.sourceInfo.attribution)}. ${esc(p.sourceInfo.rightsNote)}</p>
      <div class="sticky-cta">
        ${staticMode ? '' : `<button class="btn primary block" data-action="reconstruct" ${plans.length ? '' : 'disabled'}>${icon('cube')}Explore in 3D</button>`}
        <button class="btn block ghost" data-action="open-scene" id="open-cached" hidden>Open saved 3D model</button>
        <p class="xs faint" style="text-align:center;margin:8px 0 0">AI reconstruction · dimensions are approximate</p>
      </div>`;
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
    const steps = STEPS.map(([s, label], i) => {
      const cls = run.state === 'READY' || i < reached ? 'done' : failed && i === reached + 1 ? 'failed' : i === reached + 1 || (i === 0 && reached < 0 && !failed) ? 'active' : '';
      return `<li class="${cls}"><span class="badge">${cls === 'done' ? icon('check', 14) : cls === 'failed' ? icon('close', 14) : ''}</span>${esc(label)}</li>`;
    }).join('');
    const logs = run.logs
      .slice(-30)
      .map((l) => `<li class="log-${l.level}">${esc(l.message)}</li>`)
      .join('');
    return `
      <div class="progress"><div style="width:${Math.max(2, Math.round(run.progress * 100))}%"></div></div>
      <p class="small muted">${failed ? '' : run.totalCostEstimate || 'No AI calls yet'}</p>
      ${failed ? `<div class="callout">${icon('alert')}<div><b>Something went wrong.</b> ${esc(run.errorMessage)}</div></div><button class="btn block" data-action="back-listing">Back to listing</button>` : ''}
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
        <button class="icon-btn" data-action="back-listing" aria-label="Back">${icon('back')}</button>
        <div class="grow"><h2 class="truncate" style="font-size:17px">${esc(s.property.address)}</h2><div class="sub">${s.structure.levels.length} floors · ${s.structure.rooms.length} rooms</div></div>
      </div>
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
      const lvlIdx = level?.index ?? 0;
      return `
        <div class="room-card card">
          <div class="grow"><div class="name">Walking · ${esc(level?.name ?? '')}</div>
          <div class="meta"><span class="touch-only">Tap a white circle to move there. Drag to look around.</span><span class="desktop-only">Click a white circle to move there, drag to look, or use <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>.</span></div></div>
        </div>
        <div class="walk-actions">
          ${tool('level-up', 'up', 'Upstairs', false, '', lvlIdx >= s.structure.levels.length - 1 ? 'disabled' : '')}
          ${tool('level-down', 'down', 'Downstairs', false, '', lvlIdx === 0 ? 'disabled' : '')}
          ${tool('toggle', 'moon', 'Night', app.night.value, '', 'data-key="night"')}
          ${tool('toggle', 'sofa', 'Empty', app.furnitureHidden.value, '', 'data-key="furnitureHidden"')}
        </div>
        <button class="btn primary block" style="margin-top:12px" data-action="exit-room">${icon('cube')}Back to dollhouse <kbd>Esc</kbd></button>`;
    }

    const roomBlock = room
      ? (() => {
          const ev = roomEvidence(room);
          return `<div class="room-card card">
            <div class="grow"><div class="name truncate">${esc(room.label)}</div>
            <div class="meta">${room.areaSqM.toFixed(1)} m² · <span class="tag ${ev.cls}">${ev.text}</span></div></div>
            <button class="btn primary" data-action="enter-room">${icon('walk')}Walk in</button>
          </div>`;
        })()
      : `<div class="hint">${icon('door')}<span>Tap a floor in the model, or pick a room below, then walk in.</span></div>`;

    return `
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
      <p class="xs faint" style="margin-top:16px"><span class="touch-only">Drag to orbit · pinch to zoom.</span><span class="desktop-only">Drag to orbit · scroll to zoom.</span> In a Quest headset, tap VR to grab, scale and pull the house apart with your hands.</p>`;
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
      <h3>Sources</h3>
      <ul class="flags">
        <li><span>Floor plan read by</span><span>${esc(METHOD_LABELS[f.floorplanInterpretedBy] ?? f.floorplanInterpretedBy)}</span></li>
        <li><span>Photo evidence</span><span>${esc({ none: 'None', partial: 'Some rooms', 'all-rooms': 'All rooms' }[f.photoEvidence])}</span></li>
        <li><span>Furniture detection</span><span>${f.segmentationBy ? `${esc(METHOD_LABELS[f.segmentationBy])} · ${s.detections.length}` : 'Not run'}</span></li>
        <li><span>Wall & floor finishes</span><span>${f.surfacesFromPhotos ? `${f.surfacesFromPhotos} room(s) from photos, others default` : 'Defaults by room type'}</span></li>
        <li><span>Furniture models</span><span>${f.sam3d === 'used' ? 'Some 3D-reconstructed' : 'Simple stand-in shapes'}</span></li>
        <li><span>Ceiling height</span><span>${f.ceilingHeightEstimated ? 'Estimated (2.4 m)' : 'From plan'}</span></li>
        <li><span>Scale</span><span>${f.scaleEstimated ? 'Estimated' : 'From printed sizes'}</span></li>
      </ul>
      <h3>Source plans</h3>
      <div class="scroller plans">${plans.map((m) => `<figure class="plan"><img src="${esc(mediaUrl(m))}" alt="Source floor plan" /></figure>`).join('')}</div>
      ${s.detections.length ? `<h3>Detected in photos</h3><div class="dets">${s.detections.slice(0, 24).map((d) => { const m = s.media.find((x) => x.id === d.mediaId); return m ? `<figure class="det"><img src="${esc(mediaUrl(m))}" alt="" />${d.maskKey && !staticMode ? `<img class="mask" src="${esc(absoluteApiUrl(`/api/masks/${d.maskKey.split('/').pop()}`))}" alt="" />` : ''}<span class="box" style="left:${d.box[0] * 100}%;top:${d.box[1] * 100}%;width:${(d.box[2] - d.box[0]) * 100}%;height:${(d.box[3] - d.box[1]) * 100}%"></span><figcaption>${esc(d.concept)} ${Math.round(d.score * 100)}%</figcaption></figure>` : ''; }).join('')}</div>` : ''}
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
    const [{ property, latestRun, hasScene }, { media }] = await Promise.all([api.property(propertyId), api.media(propertyId)]);
    this.property = property;
    this.media = media;
    history.replaceState(null, '', `?property=${encodeURIComponent(propertyId)}`);
    if (latestRun && !['READY', 'FAILED'].includes(latestRun.state)) return this.watchJob(propertyId, latestRun.id);
    if (preferScene && hasScene) {
      await this.loadScene(propertyId);
      return this.go({ name: 'explore', propertyId, tab: 'explore' });
    }
    this.go({ name: 'listing', propertyId });
    const btn = this.body.querySelector('#open-cached') as HTMLButtonElement | null;
    if (btn && hasScene) btn.hidden = false;
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

  private onChange(_e: Event) {}

  private async onClick(e: Event) {
    const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!t || (t as HTMLButtonElement).disabled) return;
    const a = t.dataset.action!;
    const v = this.view;
    const pid = 'propertyId' in v ? v.propertyId : '';
    try {
      switch (a) {
        case 'home':
          this.nearPlace = null;
          this.nearby = [];
          this.nearNotice = null;
          this.globe?.clear();
        // fall through
        case 'back':
          if (app.mode.value === 'walk') exitRoom(this.world);
          history.replaceState(null, '', location.pathname);
          this.go({ name: 'discover' });
          return void this.loadResults(this.query);
        case 'back-listing':
          if (staticMode) return this.go({ name: 'discover' });
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
        case 'reconstruct': {
          (t as HTMLButtonElement).disabled = true;
          const { jobId } = await api.reconstruct(pid);
          return this.watchJob(pid, jobId);
        }
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
    const toggles: Record<string, 'roofHidden' | 'wallsHidden' | 'furnitureHidden' | 'night' | 'evidenceView' | 'wallMode'> = { h: 'roofHidden', w: 'wallsHidden', f: 'furnitureHidden', n: 'night', v: 'evidenceView', p: 'wallMode' };
    if (toggles[k]) app[toggles[k]].value = !app[toggles[k]].value;
    else if (k === '1') separateFloors(!floorsSeparated());
    else if (k === 'r') resetBuilding();
    else if (k === 'e' && app.selectedRoomId.value) enterRoom(this.world, app.selectedRoomId.value);
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
