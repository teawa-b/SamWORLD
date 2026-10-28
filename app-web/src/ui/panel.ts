/**
 * Desktop/mobile 2D interface: discovery → listing evidence → processing →
 * reconstruction preview & corrections → dollhouse controls. All state that
 * the 3D systems need goes through `app` signals.
 */
import type { World } from '@iwsdk/core';
import type { Property, PropertyMedia, ReconstructionRun, SceneManifest } from '@propertyxr/shared';
import { api, ApiError, mediaUrl, staticMode, absoluteApiUrl, type Capabilities, type SearchResult } from '../api.js';
import { app, floorsSeparated, resetBuilding, separateFloors } from '../state.js';
import { changeLevel, enterRoom, exitRoom } from '../systems/walkthrough.js';

type View =
  | { name: 'discover' }
  | { name: 'listing'; propertyId: string }
  | { name: 'processing'; propertyId: string; jobId: string }
  | { name: 'explore'; propertyId: string; tab: 'controls' | 'rooms' | 'evidence' };

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STATE_LABELS: Record<string, string> = {
  QUEUED: 'Queued',
  INGESTED: 'Listing ingested',
  STRUCTURE_PARSED: 'Floor plan parsed',
  SHELL_BUILT: '3D shell built',
  MEDIA_MATCHED: 'Photos matched to rooms',
  SEGMENTED: 'Objects segmented',
  PLACED: 'Furniture placed',
  VERIFIED: 'Verified',
  READY: 'Ready',
  FAILED: 'Failed',
};

const METHOD_LABELS: Record<string, string> = {
  'meta:muse-spark-1.3': 'Meta Muse Spark 1.3',
  'meta:muse-wonder-1.0': 'Meta Muse Wonder 1.0',
  'meta:sam-3.1': 'Meta SAM 3.1',
  'fixture:hand-authored': 'Hand-authored fixture (no live AI)',
  'admin-correction': 'Manual correction',
  deterministic: 'Deterministic geometry',
};

export class Panel {
  private el: HTMLElement;
  private view: View = { name: 'discover' };
  private caps: Capabilities | null = null;
  private realtyNotice = '';
  private property: Property | null = null;
  private media: PropertyMedia[] = [];
  private pollTimer: number | null = null;
  private lastShellVersion = 0;

  constructor(
    private world: World,
    root: HTMLElement,
  ) {
    this.el = root;
    this.el.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    for (const s of [app.selectedRoomId, app.mode, app.levelLift, app.roofHidden, app.wallsHidden, app.furnitureHidden, app.night, app.evidenceView, app.wallMode, app.pulledWalls, app.walkLevelId]) {
      s.subscribe(() => this.view.name === 'explore' && this.view.tab === 'controls' && this.render());
    }
  }

  async start() {
    const h = await api.health();
    this.caps = h?.capabilities ?? null;
    this.realtyNotice = h?.realtyApi.available === false ? h.realtyApi.reason : '';
    const params = new URLSearchParams(location.search);
    const pid = params.get('property');
    if (pid) await this.openProperty(pid, true);
    else this.go({ name: 'discover' });
  }

  private go(v: View) {
    this.view = v;
    if (this.pollTimer && v.name !== 'processing') {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.render();
  }

  // ---------------------------------------------------------------- render
  private render() {
    const v = this.view;
    const body =
      v.name === 'discover' ? this.renderDiscover() : v.name === 'listing' ? this.renderListing() : v.name === 'processing' ? this.renderProcessing() : this.renderExplore(v.tab);
    this.el.innerHTML = `
      <header class="brand">
        <div><strong>PropertyXR</strong> <span class="muted">by Shroozy</span></div>
        ${this.capBadge()}
      </header>
      <div class="disclaimer">AI reconstruction — layout from the floor plan, dimensions approximate, furniture estimated.</div>
      ${body}`;
    if (v.name === 'discover') void this.loadResults((this.el.querySelector('#q') as HTMLInputElement)?.value ?? '');
  }

  private capBadge() {
    if (staticMode) return `<span class="badge warn" title="API not reachable">Static demo</span>`;
    if (!this.caps) return '';
    return this.caps.liveMeta
      ? `<span class="badge ok" title="${esc(this.caps.museModel)} · ${esc(this.caps.samModel)}">Live Meta AI</span>`
      : `<span class="badge warn" title="Set MODEL_API_KEY on the server">Meta AI offline — fixture data</span>`;
  }

  private renderDiscover() {
    return `
      <section>
        <h2>Find a property</h2>
        <form id="search-form" class="row">
          <input id="q" placeholder="Address, listing ID or provider URL" aria-label="Search" />
          <button type="submit">Search</button>
        </form>
        ${this.realtyNotice ? `<p class="notice">Live listing search unavailable: ${esc(this.realtyNotice)}</p>` : ''}
        <div id="results"><p class="muted">Loading…</p></div>
      </section>`;
  }

  private async loadResults(q: string) {
    const target = this.el.querySelector('#results');
    if (!target) return;
    try {
      const { results, providerNotice } = await api.search(q);
      target.innerHTML =
        (providerNotice && !this.realtyNotice ? `<p class="notice">${esc(providerNotice)}</p>` : '') +
        (results.length ? results.map((r) => this.resultCard(r)).join('') : '<p class="muted">No matching listings.</p>');
    } catch (e) {
      target.innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
    }
  }

  private resultCard(r: SearchResult) {
    const price = r.price ? `£${r.price.amount.toLocaleString()} ${r.price.period}` : '';
    return `
      <article class="card">
        <div class="card-title">${esc(r.address)}</div>
        <div class="muted">${[price, r.bedrooms != null ? `${r.bedrooms} bed` : '', r.areaSqM ? `${r.areaSqM} m²` : ''].filter(Boolean).map(esc).join(' · ')}</div>
        <div class="chips">
          <span class="chip ${r.hasFloorplan ? 'ok' : 'bad'}">${r.hasFloorplan ? 'Floor plan' : 'No floor plan'}</span>
          <span class="chip ${r.photoCount ? 'ok' : 'warn'}">${r.photoCount} photos</span>
        </div>
        <div class="muted small">Source: ${esc(r.attribution)}</div>
        <button data-action="open-listing" data-provider="${esc(r.provider)}" data-listing="${esc(r.listingId)}" data-pid="${esc(r.importedPropertyId ?? '')}">View listing</button>
      </article>`;
  }

  private renderListing() {
    const p = this.property;
    if (!p) return '<p class="muted">Loading…</p>';
    const plans = this.media.filter((m) => m.type === 'floorplan');
    const photos = this.media.filter((m) => m.type === 'photo');
    return `
      <section>
        <button class="link" data-action="back">← Search</button>
        <h2>${esc(p.address)}</h2>
        <div class="muted">${[p.price ? `£${p.price.amount.toLocaleString()} ${p.price.period}` : '', p.bedrooms != null ? `${p.bedrooms} bedrooms` : '', p.areaSqM ? `${p.areaSqM} m² (${esc(p.areaEvidence ?? 'listing')})` : ''].filter(Boolean).join(' · ')}</div>
        <p class="small muted">${esc(p.sourceInfo.attribution)} — ${esc(p.sourceInfo.rightsNote)}</p>
        ${p.missingData.length ? `<ul class="missing">${p.missingData.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
        <h3>Floor plans (${plans.length})</h3>
        ${plans.length ? `<div class="gallery">${plans.map((m) => `<a href="${esc(mediaUrl(m))}" target="_blank" rel="noopener"><img src="${esc(mediaUrl(m))}" alt="Floor plan ${esc(m.levelGuess ?? '')}" /></a>`).join('')}</div>` : '<p class="error">No floor plan — a layout will not be invented. Upload a plan you have rights to use.</p>'}
        <h3>Photos (${photos.length})</h3>
        ${photos.length ? `<div class="gallery">${photos.map((m) => `<img src="${esc(mediaUrl(m))}" alt="Listing photo" />`).join('')}</div>` : '<p class="muted">No photos supplied. Rooms will be marked as having no photo evidence.</p>'}
        <div class="actions">
          ${staticMode ? '' : `<button class="primary" data-action="reconstruct" ${plans.length ? '' : 'disabled'}>Explore in 3D</button>`}
          <button data-action="open-scene" id="open-cached" hidden>Open saved reconstruction</button>
        </div>
      </section>`;
  }

  private renderProcessing() {
    return `<section><h2>Reconstructing…</h2><div id="job"><p class="muted">Starting…</p></div></section>`;
  }

  private renderJob(run: ReconstructionRun) {
    const order = ['INGESTED', 'STRUCTURE_PARSED', 'SHELL_BUILT', 'MEDIA_MATCHED', 'SEGMENTED', 'PLACED', 'VERIFIED', 'READY'];
    const reached = order.indexOf(run.state);
    const steps = order
      .map((s, i) => `<li class="${run.state === 'FAILED' ? (i <= reached ? 'done' : '') : i < reached || run.state === 'READY' ? 'done' : i === reached ? 'active' : ''}">${STATE_LABELS[s]}</li>`)
      .join('');
    const logs = run.logs
      .slice(-14)
      .map((l) => `<li class="log-${l.level}"><span class="muted">${esc(l.step)}</span> ${esc(l.message)}</li>`)
      .join('');
    return `
      <div class="progress"><div style="width:${Math.round(run.progress * 100)}%"></div></div>
      <p><strong>${esc(STATE_LABELS[run.state] ?? run.state)}</strong> — ${esc(run.totalCostEstimate || 'no AI calls yet')}</p>
      ${run.state === 'FAILED' ? `<p class="error">${esc(run.errorCode)}: ${esc(run.errorMessage)}</p><button data-action="back-listing">Back to listing</button>` : ''}
      <ol class="steps">${steps}</ol>
      <h3>Pipeline log</h3>
      <ul class="logs">${logs}</ul>
      ${['SHELL_BUILT', 'MEDIA_MATCHED', 'SEGMENTED', 'PLACED', 'VERIFIED'].includes(run.state) ? '<p class="small muted">The structural shell is already shown in the 3D view while the remaining steps run.</p>' : ''}`;
  }

  private renderExplore(tab: 'controls' | 'rooms' | 'evidence') {
    const s = app.scene.value;
    if (!s) return '<p class="muted">Loading scene…</p>';
    return `
      <section>
        <button class="link" data-action="back-listing">← Listing</button>
        <h2>${esc(s.property.address)}</h2>
        <nav class="tabs">
          ${(['controls', 'rooms', 'evidence'] as const).map((t) => `<button data-action="tab" data-tab="${t}" class="${t === tab ? 'active' : ''}">${{ controls: 'Explore', rooms: 'Rooms', evidence: 'Evidence' }[t]}</button>`).join('')}
        </nav>
        ${tab === 'controls' ? this.renderControls(s) : tab === 'rooms' ? this.renderRooms(s) : this.renderEvidence(s)}
      </section>`;
  }

  private renderControls(s: SceneManifest) {
    const walking = app.mode.value === 'walk';
    const room = s.structure.rooms.find((r) => r.id === app.selectedRoomId.value);
    const level = s.structure.levels.find((l) => l.id === app.walkLevelId.value);
    const t = (on: boolean) => (on ? 'on' : '');
    if (walking) {
      return `
        <p><strong>Walking</strong> — ${esc(level?.name ?? '')}. Drag to look, <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to move. Doorways are open; walls block.</p>
        <div class="grid2">
          <button data-action="level-up">Upstairs</button>
          <button data-action="level-down">Downstairs</button>
          <button data-action="toggle" data-key="night" class="${t(app.night.value)}">Night</button>
          <button data-action="toggle" data-key="furnitureHidden" class="${t(app.furnitureHidden.value)}">Empty room</button>
        </div>
        <button class="primary" data-action="exit-room">Back to dollhouse <kbd>Esc</kbd></button>`;
    }
    return `
      <div class="grid2">
        <button data-action="separate" class="${t(floorsSeparated())}">Separate floors <kbd>1</kbd></button>
        <button data-action="reset">Reset building <kbd>R</kbd></button>
        <button data-action="toggle" data-key="roofHidden" class="${t(app.roofHidden.value)}">Hide roof <kbd>H</kbd></button>
        <button data-action="toggle" data-key="wallsHidden" class="${t(app.wallsHidden.value)}">Hide walls <kbd>W</kbd></button>
        <button data-action="toggle" data-key="wallMode" class="${t(app.wallMode.value)}">Pull walls (click) <kbd>P</kbd></button>
        <button data-action="toggle" data-key="furnitureHidden" class="${t(app.furnitureHidden.value)}">Empty rooms <kbd>F</kbd></button>
        <button data-action="toggle" data-key="night" class="${t(app.night.value)}">Night <kbd>N</kbd></button>
        <button data-action="toggle" data-key="evidenceView" class="${t(app.evidenceView.value)}">Evidence colours <kbd>V</kbd></button>
      </div>
      ${app.wallMode.value ? `<p class="small muted">Click a wall to slide it out; click again to restore. ${app.pulledWalls.value.length} pulled.</p>` : ''}
      ${app.evidenceView.value ? '<p class="small"><span class="sw g"></span>photo + measured <span class="sw a"></span>measured, no photo <span class="sw r"></span>estimated</p>' : ''}
      <h3>Room</h3>
      ${
        room
          ? `<p><strong>${esc(room.label)}</strong> · ${room.areaSqM.toFixed(1)} m² · ${room.dimensionsMeasured ? 'printed dimensions' : 'size inferred'} · ${room.linkedMediaIds.length ? `${room.linkedMediaIds.length} photo(s)` : 'no photo evidence'}</p>
             <button class="primary" data-action="enter-room">Enter ${esc(room.label)} <kbd>E</kbd></button>`
          : '<p class="muted">Click a floor in the 3D view (or pick below) to select a room.</p>'
      }
      <select data-action="pick-room" aria-label="Pick room">
        <option value="">Choose a room…</option>
        ${s.structure.levels.map((l) => `<optgroup label="${esc(l.name)}">${s.structure.rooms.filter((r) => r.levelId === l.id).map((r) => `<option value="${esc(r.id)}" ${r.id === room?.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</optgroup>`).join('')}
      </select>
      <p class="small muted">Desktop: drag to orbit, scroll to zoom. Headset: squeeze both hands on the plinth to move/scale the house, squeeze a blue knob to lift a floor, red knob for the roof, trigger on a wall to pull it out.</p>`;
  }

  private renderRooms(s: SceneManifest) {
    const photos = s.media.filter((m) => m.type === 'photo');
    const rows = s.structure.rooms
      .map((r) => {
        const lvl = s.structure.levels.find((l) => l.id === r.levelId)!;
        return `<tr>
          <td><input data-room-label="${esc(r.id)}" value="${esc(r.label)}" ${staticMode ? 'disabled' : ''} aria-label="Room label" /></td>
          <td>${esc(lvl.name)}</td>
          <td>${r.areaSqM.toFixed(1)}</td>
          <td>${r.dimensionsMeasured ? 'printed' : '<span class="warn-t">inferred</span>'}</td>
          <td>${r.linkedMediaIds.length || '<span class="warn-t">none</span>'}</td>
          <td>${Math.round(r.confidence * 100)}%</td>
          <td><input type="checkbox" data-room-uncertain="${esc(r.id)}" ${r.isEstimated ? 'checked' : ''} ${staticMode ? 'disabled' : ''} aria-label="Mark uncertain" /></td>
        </tr>`;
      })
      .join('');
    const mappings = photos
      .map((m) => {
        const match = s.mediaMatches.find((x) => x.mediaId === m.id);
        return `<div class="map-row"><img src="${esc(mediaUrl(m))}" alt="" />
          <select data-photo="${esc(m.id)}" ${staticMode ? 'disabled' : ''}><option value="">Not a room</option>${s.structure.rooms.map((r) => `<option value="${esc(r.id)}" ${match?.roomId === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>
          <span class="small muted">${match ? `${esc(METHOD_LABELS[match.provenance.method] ?? match.provenance.method)} ${Math.round(match.confidence * 100)}%` : 'unmatched'}</span></div>`;
      })
      .join('');
    const measured = s.structure.rooms.filter((r) => r.dimensionsMeasured);
    return `
      <table class="rooms"><thead><tr><th>Room</th><th>Level</th><th>m²</th><th>Size</th><th>Photos</th><th>Conf.</th><th>Uncertain</th></tr></thead><tbody>${rows}</tbody></table>
      <h3>Photo → room</h3>
      ${mappings || '<p class="muted">No photos in this listing.</p>'}
      <h3>Scale check</h3>
      <p class="small">Scale ${(1 / s.structure.scale.metersPerPx).toFixed(1)} px/m from ${esc(s.structure.scale.method)} (${s.structure.scale.samples} samples, spread ${s.structure.scale.spreadPct}%). If a known width is wrong, enter it:</p>
      <div class="row">
        <select id="ref-room" ${staticMode ? 'disabled' : ''}>${(measured.length ? measured : s.structure.rooms).map((r) => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('')}</select>
        <input id="ref-width" type="number" step="0.01" min="0.5" max="50" placeholder="width m" ${staticMode ? 'disabled' : ''} />
      </div>
      ${staticMode ? '<p class="notice">Corrections need the API.</p>' : '<button class="primary" data-action="save-corrections">Save corrections & rebuild</button><p class="small muted">Rebuild reuses the cached floor-plan reading — no new plan AI call.</p>'}
      ${this.caps?.redesign ? this.renderRedesign(s) : ''}`;
  }

  private renderRedesign(s: SceneManifest) {
    const photos = s.media.filter((m) => m.type === 'photo' && s.mediaMatches.some((x) => x.mediaId === m.id && x.roomId));
    if (!photos.length) return '';
    return `
      <h3>Visualise a redesign (Muse Image)</h3>
      <p class="small muted">Produces a 2D concept image from a real room photo. It does not change the 3D model.</p>
      <select id="rd-photo">${photos.map((m) => `<option value="${esc(m.id)}">${esc(s.structure.rooms.find((r) => r.id === s.mediaMatches.find((x) => x.mediaId === m.id)?.roomId)?.label ?? m.id)}</option>`).join('')}</select>
      <input id="rd-text" placeholder="e.g. Scandinavian, light oak, plants" maxlength="300" />
      <button data-action="redesign">Generate concept</button>
      <div id="rd-out"></div>`;
  }

  private renderEvidence(s: SceneManifest) {
    const f = s.evidenceFlags;
    const plans = s.media.filter((m) => m.type === 'floorplan');
    const sev = (x: string) => ({ pass: '✓', info: 'i', warn: '!', fail: '✗' })[x] ?? x;
    return `
      <div class="gallery plans">${plans.map((m) => `<figure><img src="${esc(mediaUrl(m))}" alt="Source floor plan" /><figcaption>Source plan ${esc(m.levelGuess ?? '')}</figcaption></figure>`).join('')}</div>
      <h3>How this was built</h3>
      <ul class="flags">
        <li>Floor plan read by: <strong>${esc(METHOD_LABELS[f.floorplanInterpretedBy] ?? f.floorplanInterpretedBy)}</strong></li>
        <li>Live Meta inference in this run: <strong>${f.liveMetaInference ? 'yes' : 'no'}</strong></li>
        <li>Photo evidence: <strong>${esc(f.photoEvidence)}</strong></li>
        <li>Segmentation: <strong>${f.segmentationBy ? esc(METHOD_LABELS[f.segmentationBy]) : 'not run'}</strong> (${s.detections.length} detections)</li>
        <li>SAM 3D objects: <strong>${esc(f.sam3d)}</strong> — furniture shown as proxy shapes</li>
        <li>Ceiling height: <strong>${f.ceilingHeightEstimated ? 'estimated' : 'from plan'}</strong> · Scale: <strong>${f.scaleEstimated ? 'estimated' : 'from printed dimensions'}</strong></li>
      </ul>
      ${f.notes.length ? `<ul class="missing">${f.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${s.detections.length ? `<h3>SAM 3.1 detections</h3><div class="gallery">${s.detections.slice(0, 24).map((d) => { const m = s.media.find((x) => x.id === d.mediaId); return m ? `<figure class="det"><img src="${esc(mediaUrl(m))}" alt="" />${d.maskKey && !staticMode ? `<img class="mask" src="${esc(absoluteApiUrl(`/api/masks/${d.maskKey.split('/').pop()}`))}" alt="" />` : ''}<span class="box" style="left:${d.box[0] * 100}%;top:${d.box[1] * 100}%;width:${(d.box[2] - d.box[0]) * 100}%;height:${(d.box[3] - d.box[1]) * 100}%"></span><figcaption>${esc(d.concept)} ${Math.round(d.score * 100)}%</figcaption></figure>` : ''; }).join('')}</div>` : ''}
      <h3>Geometry checks</h3>
      <ul class="checks">${s.verification.geometry.map((c) => `<li class="sev-${c.severity}"><b>${sev(c.severity)}</b> ${esc(c.message)}</li>`).join('')}</ul>
      <h3>Meta verification pass</h3>
      <p class="small">${esc(s.verification.visualReview.status)}: ${esc(s.verification.visualReview.reason)}</p>
      <ul class="checks">${s.verification.visualReview.findings.map((c) => `<li class="sev-${c.severity}"><b>${sev(c.severity)}</b> ${esc(c.message)}</li>`).join('')}</ul>
      <p class="small muted">Scene v${s.sceneVersion} · generated ${esc(new Date(s.generatedAt).toLocaleString())}. Verification cannot guarantee physical accuracy.</p>`;
  }

  // ---------------------------------------------------------------- actions
  private async openProperty(propertyId: string, preferScene = false) {
    if (staticMode) {
      await this.loadScene(propertyId);
      this.go({ name: 'explore', propertyId, tab: 'controls' });
      return;
    }
    const [{ property, latestRun, hasScene }, { media }] = await Promise.all([api.property(propertyId), api.media(propertyId)]);
    this.property = property;
    this.media = media;
    history.replaceState(null, '', `?property=${encodeURIComponent(propertyId)}`);
    if (latestRun && !['READY', 'FAILED'].includes(latestRun.state)) return this.watchJob(propertyId, latestRun.id);
    if (preferScene && hasScene) {
      await this.loadScene(propertyId);
      return this.go({ name: 'explore', propertyId, tab: 'controls' });
    }
    this.go({ name: 'listing', propertyId });
    const btn = this.el.querySelector('#open-cached') as HTMLButtonElement | null;
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
        const box = this.el.querySelector('#job');
        if (box) box.innerHTML = this.renderJob(run);
        const shellReady = ['SHELL_BUILT', 'MEDIA_MATCHED', 'SEGMENTED', 'PLACED', 'VERIFIED'].includes(run.state);
        if (shellReady && !this.lastShellVersion) {
          const scene = await this.loadScene(propertyId).catch(() => null);
          if (scene) this.lastShellVersion = scene.sceneVersion;
        }
        if (run.state === 'READY') {
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          await this.loadScene(propertyId);
          this.go({ name: 'explore', propertyId, tab: 'controls' });
        } else if (run.state === 'FAILED') {
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
        }
      } catch (e) {
        const box = this.el.querySelector('#job');
        if (box) box.innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
      }
    };
    void tick();
    this.pollTimer = window.setInterval(tick, 1000);
  }

  private async onClick(e: Event) {
    const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!t) return;
    const a = t.dataset.action!;
    const v = this.view;
    const pid = 'propertyId' in v ? v.propertyId : '';
    try {
      switch (a) {
        case 'back':
          history.replaceState(null, '', location.pathname);
          return this.go({ name: 'discover' });
        case 'back-listing':
          if (staticMode) return this.go({ name: 'discover' });
          return this.openProperty(pid);
        case 'open-listing': {
          if (t.dataset.pid) return this.openProperty(t.dataset.pid);
          const { property } = await api.importListing(t.dataset.provider!, t.dataset.listing!);
          return this.openProperty(property.id);
        }
        case 'reconstruct': {
          const { jobId } = await api.reconstruct(pid);
          return this.watchJob(pid, jobId);
        }
        case 'open-scene':
          await this.loadScene(pid);
          return this.go({ name: 'explore', propertyId: pid, tab: 'controls' });
        case 'tab':
          return this.go({ name: 'explore', propertyId: pid, tab: t.dataset.tab as 'controls' });
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
      this.toast(err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message);
    }
  }

  private async saveCorrections(pid: string) {
    const s = app.scene.value!;
    const roomLabels = [...this.el.querySelectorAll<HTMLInputElement>('[data-room-label]')]
      .filter((i) => s.structure.rooms.find((r) => r.id === i.dataset.roomLabel)?.label !== i.value.trim() && i.value.trim())
      .map((i) => ({ roomId: i.dataset.roomLabel!, label: i.value.trim() }));
    const uncertainRoomIds = [...this.el.querySelectorAll<HTMLInputElement>('[data-room-uncertain]')].filter((i) => i.checked).map((i) => i.dataset.roomUncertain!);
    const mappings = [...this.el.querySelectorAll<HTMLSelectElement>('[data-photo]')]
      .filter((sel) => (s.mediaMatches.find((m) => m.mediaId === sel.dataset.photo)?.roomId ?? '') !== sel.value)
      .map((sel) => ({ mediaId: sel.dataset.photo!, roomId: sel.value || null }));
    const width = Number((this.el.querySelector('#ref-width') as HTMLInputElement).value);
    const referenceMeasurement = width > 0 ? { roomId: (this.el.querySelector('#ref-room') as HTMLSelectElement).value, widthM: width } : null;
    await api.saveMappings(pid, { roomLabels, uncertainRoomIds, mappings, referenceMeasurement });
    const { jobId } = await api.reconstruct(pid);
    this.watchJob(pid, jobId);
  }

  private async redesign(pid: string) {
    const s = app.scene.value!;
    const mediaId = (this.el.querySelector('#rd-photo') as HTMLSelectElement).value;
    const text = (this.el.querySelector('#rd-text') as HTMLInputElement).value.trim();
    const roomId = s.mediaMatches.find((m) => m.mediaId === mediaId)?.roomId;
    const out = this.el.querySelector('#rd-out')!;
    if (!roomId || text.length < 3) return this.toast('Choose a photo and describe the style');
    out.innerHTML = '<p class="muted">Generating with Muse Image…</p>';
    const r = await api.visualise(pid, roomId, mediaId, text);
    out.innerHTML = `<figure><img src="${esc(absoluteApiUrl(r.url))}" alt="AI concept" /><figcaption class="warn-t">${esc(r.label)}</figcaption></figure>`;
  }

  private onKey(e: KeyboardEvent) {
    if (this.view.name !== 'explore' || (e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
    const walking = app.mode.value === 'walk';
    const k = e.key.toLowerCase();
    if (walking) {
      if (k === 'escape') exitRoom(this.world);
      return;
    }
    const toggles: Record<string, 'roofHidden' | 'wallsHidden' | 'furnitureHidden' | 'night' | 'evidenceView' | 'wallMode'> = { h: 'roofHidden', w: 'wallsHidden', f: 'furnitureHidden', n: 'night', v: 'evidenceView', p: 'wallMode' };
    if (toggles[k]) app[toggles[k]].value = !app[toggles[k]].value;
    else if (k === '1') separateFloors(!floorsSeparated());
    else if (k === 'r') resetBuilding();
    else if (k === 'e' && app.selectedRoomId.value) enterRoom(this.world, app.selectedRoomId.value);
  }

  bindRoomPicker() {
    this.el.addEventListener('change', (e) => {
      const sel = (e.target as HTMLElement).closest('[data-action="pick-room"]') as HTMLSelectElement | null;
      if (sel) app.selectedRoomId.value = sel.value || null;
    });
  }

  private toast(msg: string) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  bindSearch() {
    this.el.addEventListener('submit', (e) => {
      if ((e.target as HTMLElement).id !== 'search-form') return;
      e.preventDefault();
      void this.loadResults((this.el.querySelector('#q') as HTMLInputElement).value);
    });
  }
}
