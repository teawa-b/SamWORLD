/**
 * Screen 1 (Import) and Screen 2 (Review media). Everything here talks to the
 * backend import API; the same API is what a future browser extension posts to.
 */
import { typeFromLabel, type Property, type PropertyMedia, type FloorplanInterpretation, type RoomHint } from '../shared/index.js';
import { api, ApiError, mediaUrl, staticMode, type Capabilities, type Extraction } from '../api.js';
import { icon } from './icons.js';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const EXTERIOR_PRESETS: Record<string, { name: string; finish: NonNullable<Property['exterior']> }> = {
  florida: { name: 'Florida stucco, clay tile roof', finish: { wall: 'stucco', wallColor: '#e8a36a', roof: 'clay-tile', roofColor: '#b5532f' } },
  white: { name: 'White render, grey roof', finish: { wall: 'render', wallColor: '#f2f0ea', roof: 'slate', roofColor: '#4d535a' } },
  redbrick: { name: 'Red brick, dark tile roof', finish: { wall: 'brick', wallColor: '#a9604a', roof: 'clay-tile', roofColor: '#5a3a30' } },
  siding: { name: 'Painted siding, shingle roof', finish: { wall: 'siding', wallColor: '#c9d3d8', roof: 'shingle', roofColor: '#3e3e40' } },
};

const ROOM_LABELS = ['Living room', 'Kitchen', 'Dining room', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3', 'Bathroom', 'En-suite', 'WC', 'Hallway', 'Landing', 'Study', 'Utility', 'Exterior'];

interface Suggestion {
  kind?: 'photo' | 'floorplan' | 'exterior' | 'other';
  roomLabel?: string | null;
  source?: string;
  confidence?: number;
  objects?: string[];
  materials?: string[];
}

export interface ImportHost {
  toast(msg: string): void;
  rerender(): void;
  openReview(propertyId: string): Promise<void>;
  startBuild(propertyId: string): Promise<void>;
  openPlanEditor(propertyId: string): void;
  openDiscover(): void;
  caps(): Capabilities | null;
}

export class ImportFlow {
  property: Property | null = null;
  media: PropertyMedia[] = [];
  interp: FloorplanInterpretation | null = null;
  lastExtraction: Extraction | null = null;
  busy: string | null = null;
  private rights = false;
  private urlDraft = '';
  private importError: string | null = null;

  constructor(private host: ImportHost) {}

  // ------------------------------------------------------------ Screen 1
  renderImport(demo: string): string {
    const off = staticMode ? 'disabled' : '';
    return `
      <div class="eyebrow">New property</div>
      <h1>Turn a listing into a 3D home</h1>
      <p class="lede">Paste a listing link or add the photos and floor plan. The floor plan sets the walls and rooms; the photos supply what each room looks like and what is in it.</p>
      ${staticMode ? `<div class="callout info">${icon('info')}<div>The WalkIn server isn’t reachable, so importing is off. Saved demo models still open below.</div></div>` : ''}
      <form id="import-url-form" class="stack">
        <label class="lbl" for="listing-url">Listing link</label>
        <div class="row-input">
          <input id="listing-url" class="field" type="url" inputmode="url" placeholder="https://… (a public property listing page)" value="${esc(this.urlDraft)}" ${off} />
          <button class="btn primary" type="submit" ${off} ${this.busy ? 'disabled' : ''}>${this.busy === 'url' ? 'Importing…' : 'Import'}</button>
        </div>
        <p class="xs faint">WalkIn reads the public page only. It won’t log in or get past bot checks; if a site blocks it, add the images yourself.</p>
      </form>
      ${this.importError ? `<div class="callout">${icon('alert')}<div><b>Couldn’t import that link.</b> ${esc(this.importError)}</div></div>` : ''}
      <div class="or"><span>or</span></div>
      <div class="drop" id="drop-zone" tabindex="0" role="button" data-action="pick-files" aria-label="Add photos and floor plans">
        ${icon('photo', 26)}
        <b>${this.busy === 'upload' ? 'Uploading…' : 'Add photos and floor plans'}</b>
        <span class="xs muted">Drop JPG, PNG or WebP files here, or click to choose. Files with “floor plan” in the name are marked as plans.</span>
      </div>
      <input type="file" id="file-input" accept="image/jpeg,image/png,image/webp" multiple hidden ${off} />
      <details class="url-list"><summary>Add image links instead</summary>
        <textarea id="image-urls" class="field" rows="4" placeholder="One image URL per line" ${off}></textarea>
        <button class="btn block" data-action="import-image-urls" ${off}>Add images</button>
      </details>
      <label class="switch rights"><input type="checkbox" id="rights" ${this.rights ? 'checked' : ''} ${off} />I own these images or have permission to use them to build a 3D model.</label>
      ${demo ? `<h3>Or open the demo home</h3>${demo}` : ''}
      <p class="xs faint" style="margin-top:14px"><a href="#" data-action="open-discover">Browse UK/US listings on a map</a> (needs the listings API key on the server).</p>`;
  }

  // ------------------------------------------------------------ Screen 2
  renderReview(): string {
    const p = this.property;
    if (!p) return '<div class="empty">Loading…</div>';
    const caps = this.host.caps();
    const included = this.media.filter((m) => m.metadata.excluded !== true);
    const plans = this.media.filter((m) => m.type === 'floorplan');
    const photos = this.media.filter((m) => m.type === 'photo');
    const groups = new Map<string, PropertyMedia[]>();
    for (const m of photos) {
      const k = m.roomGuess?.trim() || '';
      groups.set(k, [...(groups.get(k) ?? []), m]);
    }
    const groupKeys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    const traced = this.interp && this.interp.layoutSource === 'floorplan';
    const planNote = !plans.length
      ? `<div class="callout">${icon('info')}<div><b>No floor plan.</b> Without one, room positions are an estimate. Mark an image as a floor plan, or add one.</div></div>`
      : traced
        ? `<div class="callout ok">${icon('check')}<div><b>Floor plan ${this.interp!.provenance.method === 'admin-correction' ? 'traced' : 'read'}:</b> ${this.interp!.levels.reduce((n, l) => n + l.rooms.length, 0)} rooms on ${this.interp!.levels.length} floor(s) (${esc(this.interp!.provenance.method === 'admin-correction' ? 'by hand' : this.interp!.provenance.method)}). <a href="#" data-action="edit-plan">Check or edit it</a></div></div>`
        : caps?.liveMeta
          ? `<div class="callout info">${icon('sparkle')}<div>Muse will read the floor plan when you generate. You can check and correct its reading afterwards, or <a href="#" data-action="edit-plan">trace it yourself</a>.</div></div>`
          : `<div class="callout">${icon('plan')}<div><b>Trace the floor plan for an accurate layout.</b> The AI isn’t configured on this server (no MODEL_API_KEY), so the plan can’t be read automatically. Tracing takes a couple of minutes and needs no AI. Otherwise the layout is estimated.<br/><button class="btn small" data-action="edit-plan" style="margin-top:8px">${icon('plan', 16)}Trace floor plan</button></div></div>`;
    const card = (m: PropertyMedia) => {
      const sug = m.metadata.suggestion as Suggestion | undefined;
      const off = m.metadata.excluded === true;
      const idx = this.media.indexOf(m);
      const showSug = sug && sug.kind !== 'floorplan' && sug.roomLabel && sug.roomLabel !== m.roomGuess;
      const planSug = sug?.kind === 'floorplan' && m.type !== 'floorplan';
      return `<div class="mcard ${off ? 'off' : ''}" data-mid="${esc(m.id)}">
        <a class="mthumb" href="${esc(mediaUrl(m))}" target="_blank" rel="noopener"><img src="${esc(mediaUrl(m))}" alt="" loading="lazy" /></a>
        <div class="mbody">
          <div class="mrow">
            <label class="mini-switch" title="Use this image"><input type="checkbox" data-media-include="${esc(m.id)}" ${off ? '' : 'checked'} />Use</label>
            <select class="field small" data-media-type="${esc(m.id)}" aria-label="Image type">
              <option value="photo" ${m.type === 'photo' ? 'selected' : ''}>Photo</option>
              <option value="floorplan" ${m.type === 'floorplan' ? 'selected' : ''}>Floor plan</option>
            </select>
          </div>
          ${m.type === 'photo' ? `<input class="field small" list="room-labels" data-media-room="${esc(m.id)}" value="${esc(m.roomGuess ?? '')}" placeholder="Room (e.g. Kitchen)" aria-label="Room label" />` : `<div class="xs muted">Floor plan${m.levelGuess ? ` · ${esc(m.levelGuess)}` : ''}</div>`}
          ${showSug ? `<button class="sug" data-action="accept-suggestion" data-mid="${esc(m.id)}">${icon('sparkle', 12)}${esc(sug!.roomLabel)} <span class="faint">· ${esc(sug!.source ?? 'suggested')}${sug!.confidence != null ? ` ${Math.round(sug!.confidence * 100)}%` : ''}</span></button>` : ''}
          ${planSug ? `<button class="sug" data-action="accept-plan" data-mid="${esc(m.id)}">${icon('sparkle', 12)}Looks like a floor plan</button>` : ''}
          ${sug?.objects?.length ? `<div class="xs faint truncate" title="${esc(sug.objects.join(', '))}">Sees: ${esc(sug.objects.slice(0, 5).join(', '))}</div>` : ''}
          <div class="mrow tools">
            <button class="icon-btn s" data-action="media-up" data-mid="${esc(m.id)}" ${idx === 0 ? 'disabled' : ''} aria-label="Move earlier">${icon('up', 14)}</button>
            <button class="icon-btn s" data-action="media-down" data-mid="${esc(m.id)}" ${idx === this.media.length - 1 ? 'disabled' : ''} aria-label="Move later">${icon('down', 14)}</button>
            <span class="grow"></span>
            <button class="icon-btn s" data-action="media-delete" data-mid="${esc(m.id)}" aria-label="Remove image">${icon('close', 14)}</button>
          </div>
        </div>
      </div>`;
    };
    const ex = this.lastExtraction;
    return `
      <div class="view-head">
        <button class="icon-btn" data-action="home" aria-label="Back">${icon('back')}</button>
        <div class="grow"><div class="sub">Review property media</div></div>
      </div>
      <input class="field title-input" id="prop-title" value="${esc(p.address)}" aria-label="Property name" />
      <div class="row3">
        <label class="xs muted">Bedrooms<input class="field small" id="prop-beds" type="number" min="0" max="30" value="${p.bedrooms ?? ''}" /></label>
        <label class="xs muted">Baths<input class="field small" id="prop-baths" type="number" min="0" max="20" step="0.5" value="${p.bathrooms ?? ''}" /></label>
        <label class="xs muted">Floors<input class="field small" id="prop-floors" type="number" min="1" max="6" value="${p.floors ?? ''}" placeholder="?" /></label>
        <label class="xs muted">Area (m²)<input class="field small" id="prop-area" type="number" min="1" max="5000" value="${p.areaSqM ?? ''}" /></label>
      </div>
      <p class="xs faint">${esc(p.sourceInfo.attribution)}. Bedrooms, baths, floors and area shape the estimated layout when there is no floor plan.</p>
      ${ex ? `<p class="xs muted">Found ${ex.found} image(s) on the page (${ex.floorplans} floor plan) via ${esc(ex.adapter)}; ${ex.downloaded} imported${ex.failed.length ? `, ${ex.failed.length} couldn’t be downloaded` : ''}.</p>` : ''}
      ${planNote}
      <div class="review-actions">
        <button class="btn small" data-action="pick-files">${icon('photo', 16)}Add images</button>
        ${caps?.liveMeta ? `<button class="btn small" data-action="suggest-rooms" ${this.busy ? 'disabled' : ''}>${icon('sparkle', 16)}${this.busy === 'suggest' ? 'Looking…' : 'Suggest rooms (Muse)'}</button>` : `<span class="xs faint" title="Needs MODEL_API_KEY on the server">AI room suggestions off: label rooms yourself</span>`}
      </div>
      <input type="file" id="file-input" accept="image/jpeg,image/png,image/webp" multiple hidden />
      <datalist id="room-labels">${ROOM_LABELS.map((l) => `<option value="${esc(l)}"></option>`).join('')}</datalist>
      <h3>Floor plans <span class="faint">${plans.length}</span></h3>
      <div class="mgrid">${plans.map(card).join('') || '<div class="empty xs">None yet. Change an image’s type to “Floor plan”.</div>'}</div>
      ${groupKeys.map((k) => `<h3>${k ? esc(k) : 'Not labelled yet'} <span class="faint">${groups.get(k)!.length}</span></h3><div class="mgrid">${groups.get(k)!.map(card).join('')}</div>`).join('') || '<h3>Photos</h3><div class="empty">No photos yet.</div>'}
      <p class="xs faint">Photos with the same room label are treated as views of one room. Labels are hints: on the Rooms tab you can reassign any photo after the build.</p>
      ${!plans.length ? this.renderHints(groupKeys.filter((k) => k && typeFromLabel(k))) : ''}
      ${this.renderExterior()}
      <div class="sticky-cta">
        <button class="btn primary block" data-action="generate" ${included.length ? '' : 'disabled'}>${icon('cube')}Generate 3D</button>
        <p class="xs faint" style="text-align:center;margin:6px 0 0">${included.length} of ${this.media.length} images will be used · ${caps?.liveMeta ? `Meta ${esc(caps.museModel)} + ${esc(caps.samModel)}` : 'no AI (demo mode)'}</p>
      </div>`;
  }

  /** Without a floor plan: what the photos show about how the rooms fit together. */
  private renderHints(labels: string[]): string {
    const p = this.property!;
    if (!labels.length) return `<div class="callout info">${icon('info')}<div>Label the photos by room (Kitchen, Living room, Bedroom 1…) and you can say how the rooms fit together, so the layout follows the real house.</div></div>`;
    const hint = (l: string): RoomHint => p.roomHints?.find((h) => h.label.toLowerCase() === l.toLowerCase()) ?? { label: l };
    const linkOf = (a: string, b: string) => hint(a).connectsTo?.find((c) => c.label.toLowerCase() === b.toLowerCase())?.kind ?? hint(b).connectsTo?.find((c) => c.label.toLowerCase() === a.toLowerCase())?.kind ?? null;
    const sides = ['unknown', 'front', 'rear', 'left', 'right'];
    return `
      <h3>How the rooms fit together</h3>
      <p class="xs muted">No floor plan, so WalkIn arranges the rooms from what the photos show. Anything you set here is respected; leave what you can't tell. ${this.host.caps()?.liveMeta ? 'Muse also reads this from the photos; your answers win.' : ''}</p>
      <label class="xs muted hint-hall">Hallway between rooms?
        <select class="field small" data-hint-hall>
          <option value="" ${p.hallway == null ? 'selected' : ''}>Not sure</option>
          <option value="yes" ${p.hallway === true ? 'selected' : ''}>Yes, there is a hallway</option>
          <option value="no" ${p.hallway === false ? 'selected' : ''}>No, rooms open into each other</option>
        </select></label>
      <div class="hints">${labels
        .map((l) => {
          const h = hint(l);
          const others = labels.filter((o) => o !== l);
          return `<div class="hint-row card">
            <b>${esc(l)}</b>
            <div class="hint-ctl">
              <select class="field small" data-hint-side="${esc(l)}" aria-label="Side of the house">${sides.map((x) => `<option value="${x}" ${(h.side ?? 'unknown') === x ? 'selected' : ''}>${x === 'unknown' ? 'Side: not sure' : `${x[0].toUpperCase()}${x.slice(1)} of house`}</option>`).join('')}</select>
              <label class="mini-switch"><input type="checkbox" data-hint-entrance="${esc(l)}" ${h.entrance ? 'checked' : ''} />Front door here</label>
              <label class="mini-switch"><input type="checkbox" data-hint-corner="${esc(l)}" ${(h.exteriorWalls ?? 0) >= 2 ? 'checked' : ''} />Corner (windows on 2 walls)</label>
            </div>
            ${others.length ? `<div class="hint-links"><span class="xs muted">Opens into:</span>${others.map((o) => { const k = linkOf(l, o); return `<button class="chip ${k ? 'on' : ''}" data-action="hint-link" data-a="${esc(l)}" data-b="${esc(o)}" title="Click: door → open-plan → none">${esc(o)}${k ? ` <span class="faint">${k === 'open' ? 'open-plan' : 'door'}</span>` : ''}</button>`; }).join('')}</div>` : ''}
          </div>`;
        })
        .join('')}</div>`;
  }

  /** Outside walls and roof as seen in the exterior photos. */
  private renderExterior(): string {
    const e = this.property!.exterior;
    const opt = (v: string, cur: string | undefined, label: string) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    return `
      <h3>Outside of the house</h3>
      <p class="xs muted">Pick what the exterior photos show. Without this the model uses generic brick.</p>
      <div class="ext-row">
        <select class="field small" data-ext-preset aria-label="Preset">
          <option value="">Presets…</option>
          ${Object.entries(EXTERIOR_PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}
        </select>
        <select class="field small" data-ext="wall" aria-label="Wall finish">${opt('stucco', e?.wall, 'Stucco')}${opt('render', e?.wall, 'Smooth render')}${opt('brick', e?.wall, 'Brick')}${opt('siding', e?.wall, 'Siding')}${opt('stone', e?.wall, 'Stone')}</select>
        <input type="color" data-ext="wallColor" value="${e?.wallColor ?? '#a9604a'}" aria-label="Wall colour" />
        <select class="field small" data-ext="roof" aria-label="Roof">${opt('clay-tile', e?.roof, 'Clay tile')}${opt('shingle', e?.roof, 'Shingle')}${opt('slate', e?.roof, 'Slate')}${opt('metal', e?.roof, 'Metal')}${opt('flat', e?.roof, 'Flat')}</select>
        <input type="color" data-ext="roofColor" value="${e?.roofColor ?? '#7a4b3a'}" aria-label="Roof colour" />
      </div>`;
  }

  private async saveExterior(el: HTMLInputElement) {
    if (!this.property) return;
    const cur = this.property.exterior ?? { wall: 'brick' as const, wallColor: '#a9604a', roof: 'clay-tile' as const, roofColor: '#7a4b3a' };
    const next = el.dataset.extPreset !== undefined ? (EXTERIOR_PRESETS[el.value]?.finish ?? null) : { ...cur, [el.dataset.ext!]: el.value };
    if (!next) return;
    this.property = (await api.updateProperty(this.property.id, { exterior: next as Property['exterior'] })).property;
    this.host.rerender();
  }

  private async saveHints(mutate: (hints: RoomHint[]) => void, hallway?: boolean | null) {
    if (!this.property) return;
    const hints: RoomHint[] = structuredClone(this.property.roomHints ?? []);
    mutate(hints);
    const clean = hints.filter((h) => (h.side && h.side !== 'unknown') || h.entrance || h.exteriorWalls || h.connectsTo?.length);
    this.property = (await api.updateProperty(this.property.id, { roomHints: clean, ...(hallway !== undefined ? { hallway } : {}) })).property;
    this.host.rerender();
  }

  private hintFor(hints: RoomHint[], label: string): RoomHint {
    let h = hints.find((x) => x.label.toLowerCase() === label.toLowerCase());
    if (!h) hints.push((h = { label }));
    return h;
  }

  // ------------------------------------------------------------ data
  async load(propertyId: string) {
    const [{ property }, { media }, { interpretation }] = await Promise.all([api.property(propertyId), api.media(propertyId), api.interpretation(propertyId).catch(() => ({ interpretation: null }))]);
    this.property = property;
    this.media = sortMedia(media);
    this.interp = interpretation;
  }

  private needRights(): boolean {
    const box = document.getElementById('rights') as HTMLInputElement | null;
    if (box) this.rights = box.checked;
    if (this.property) return true; // confirmed when the property was created
    if (!this.rights) {
      this.host.toast('Please confirm you own the images or have permission to use them.');
      document.getElementById('rights')?.focus();
      return false;
    }
    return true;
  }

  async importUrl(url: string) {
    this.urlDraft = url;
    if (!url || !this.needRights()) return;
    this.busy = 'url';
    this.importError = null;
    this.host.rerender();
    try {
      const r = await api.importListingUrl(url);
      this.lastExtraction = r.extraction;
      this.busy = null;
      await this.host.openReview(r.property.id);
    } catch (e) {
      this.importError = e instanceof ApiError ? e.message : (e as Error).message;
      this.busy = null;
      this.host.rerender();
    }
  }

  async addFiles(files: File[]) {
    if (!files.length || !this.needRights()) return;
    const bad = files.filter((f) => !/^image\/(jpeg|png|webp)$/.test(f.type) && !/\.(jpe?g|png|webp)$/i.test(f.name));
    if (bad.length) this.host.toast(`Skipped ${bad.length} file(s): only JPG, PNG and WebP are supported.`);
    const good = files.filter((f) => !bad.includes(f));
    if (!good.length) return;
    this.busy = 'upload';
    this.host.rerender();
    try {
      if (!this.property) this.property = (await api.createProperty('Uploaded property')).property;
      const errors: string[] = [];
      let n = 0;
      for (const f of good) {
        try {
          await api.uploadImage(this.property.id, f);
          n++;
        } catch (e) {
          errors.push(`${f.name}: ${(e as Error).message}`);
        }
      }
      if (errors.length) this.host.toast(`${n} added. ${errors.length} failed — ${errors[0]}`);
      this.busy = null;
      await this.host.openReview(this.property.id);
    } catch (e) {
      this.busy = null;
      this.host.toast((e as Error).message);
      this.host.rerender();
    }
  }

  async addUrls(text: string) {
    const urls = text.split(/\s+/).map((u) => u.trim()).filter(Boolean).slice(0, 30);
    if (!urls.length || !this.needRights()) return;
    this.busy = 'urls';
    try {
      if (!this.property) this.property = (await api.createProperty('Imported images')).property;
      const r = await api.addImageUrls(this.property.id, urls.map((url) => ({ url })));
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) this.host.toast(`${r.results.length - failed.length} added, ${failed.length} failed: ${failed[0].error}`);
      this.busy = null;
      await this.host.openReview(this.property.id);
    } catch (e) {
      this.busy = null;
      this.host.toast((e as Error).message);
    }
  }

  reset() {
    this.property = null;
    this.media = [];
    this.interp = null;
    this.lastExtraction = null;
    this.importError = null;
    this.busy = null;
  }

  /** Handles review/import actions. Returns true when handled. */
  async handle(action: string, el: HTMLElement): Promise<boolean> {
    const mid = el.dataset.mid ?? '';
    const pid = this.property?.id ?? '';
    switch (action) {
      case 'pick-files':
        (document.getElementById('file-input') as HTMLInputElement | null)?.click();
        return true;
      case 'import-image-urls':
        await this.addUrls((document.getElementById('image-urls') as HTMLTextAreaElement).value);
        return true;
      case 'open-discover':
        this.host.openDiscover();
        return true;
      case 'media-up':
      case 'media-down': {
        const i = this.media.findIndex((m) => m.id === mid);
        const j = action === 'media-up' ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= this.media.length) return true;
        const ids = this.media.map((m) => m.id);
        [ids[i], ids[j]] = [ids[j], ids[i]];
        this.media = sortMedia((await api.reorderMedia(pid, ids)).media);
        this.host.rerender();
        return true;
      }
      case 'media-delete':
        await api.deleteMedia(mid);
        this.media = this.media.filter((m) => m.id !== mid);
        this.host.rerender();
        return true;
      case 'accept-suggestion': {
        const m = this.media.find((x) => x.id === mid)!;
        await this.patch(mid, { roomGuess: (m.metadata.suggestion as Suggestion).roomLabel ?? null });
        return true;
      }
      case 'accept-plan':
        await this.patch(mid, { type: 'floorplan' });
        return true;
      case 'suggest-rooms':
        this.busy = 'suggest';
        this.host.rerender();
        try {
          const r = await api.suggestRooms(pid);
          this.media = sortMedia(r.media);
          this.host.toast(`Muse looked at the images (${r.aiCalls} call). Suggestions appear under each image; nothing was changed until you accept one.`);
        } finally {
          this.busy = null;
          this.host.rerender();
        }
        return true;
      case 'edit-plan':
        if (!this.media.some((m) => m.type === 'floorplan' && m.metadata.excluded !== true)) {
          this.host.toast('Mark at least one image as a floor plan first.');
          return true;
        }
        this.host.openPlanEditor(pid);
        return true;
      case 'hint-link': {
        // Cycle: none → door → open-plan → none. Stored once, on the first room.
        const a = el.dataset.a!;
        const b = el.dataset.b!;
        await this.saveHints((hs) => {
          const ha = this.hintFor(hs, a);
          const hb = this.hintFor(hs, b);
          const cur = ha.connectsTo?.find((c) => c.label.toLowerCase() === b.toLowerCase())?.kind ?? hb.connectsTo?.find((c) => c.label.toLowerCase() === a.toLowerCase())?.kind ?? null;
          ha.connectsTo = (ha.connectsTo ?? []).filter((c) => c.label.toLowerCase() !== b.toLowerCase());
          hb.connectsTo = (hb.connectsTo ?? []).filter((c) => c.label.toLowerCase() !== a.toLowerCase());
          const next = cur == null ? 'door' : cur === 'door' ? 'open' : null;
          if (next) ha.connectsTo.push({ label: b, kind: next });
        });
        return true;
      }
      case 'generate':
        await this.saveFacts();
        await this.host.startBuild(pid);
        return true;
    }
    return false;
  }

  async onChange(t: HTMLElement) {
    const el = t as HTMLInputElement;
    if (el.id === 'file-input') {
      await this.addFiles([...(el.files ?? [])]);
      el.value = '';
    } else if (el.id === 'rights') this.rights = el.checked;
    else if (el.dataset.mediaInclude) await this.patch(el.dataset.mediaInclude, { excluded: !el.checked });
    else if (el.dataset.mediaType) await this.patch(el.dataset.mediaType, { type: el.value as 'photo' | 'floorplan' });
    else if (el.dataset.mediaRoom) await this.patch(el.dataset.mediaRoom, { roomGuess: el.value.trim() || null }, true);
    else if (el.dataset.ext || el.dataset.extPreset !== undefined) await this.saveExterior(el);
    else if (el.dataset.hintSide) await this.saveHints((hs) => (this.hintFor(hs, el.dataset.hintSide!).side = el.value as RoomHint['side']));
    else if (el.dataset.hintEntrance) {
      const l = el.dataset.hintEntrance;
      // Only one room has the front door.
      await this.saveHints((hs) => {
        for (const h of hs) h.entrance = false;
        this.hintFor(hs, l).entrance = el.checked;
      });
    } else if (el.dataset.hintCorner) await this.saveHints((hs) => (this.hintFor(hs, el.dataset.hintCorner!).exteriorWalls = el.checked ? 2 : null));
    else if (el.hasAttribute('data-hint-hall')) await this.saveHints(() => undefined, el.value === 'yes' ? true : el.value === 'no' ? false : null);
    else if (['prop-title', 'prop-beds', 'prop-baths', 'prop-floors', 'prop-area'].includes(el.id)) await this.saveFacts();
  }

  private async saveFacts() {
    if (!this.property) return;
    const title = (document.getElementById('prop-title') as HTMLInputElement | null)?.value.trim();
    const beds = (document.getElementById('prop-beds') as HTMLInputElement | null)?.value;
    const area = (document.getElementById('prop-area') as HTMLInputElement | null)?.value;
    const baths = (document.getElementById('prop-baths') as HTMLInputElement | null)?.value;
    const floors = (document.getElementById('prop-floors') as HTMLInputElement | null)?.value;
    const num = (v: string | undefined) => (v ? Number(v) : null);
    const patch = { address: title || undefined, bedrooms: num(beds), bathrooms: num(baths), floors: num(floors), areaSqM: num(area) };
    const p = this.property;
    if (patch.address === p.address && patch.bedrooms === p.bedrooms && patch.areaSqM === p.areaSqM && patch.bathrooms === (p.bathrooms ?? null) && patch.floors === (p.floors ?? null)) return;
    this.property = (await api.updateProperty(this.property.id, patch)).property;
  }

  private async patch(mediaId: string, p: Parameters<typeof api.updateMedia>[1], regroupLater = false) {
    const { media } = await api.updateMedia(mediaId, p);
    this.media = this.media.map((m) => (m.id === mediaId ? media : m));
    // Re-grouping while typing would move the input from under the cursor; labels regroup on blur (change event).
    if (!regroupLater || document.activeElement?.getAttribute('data-media-room') !== mediaId) this.host.rerender();
  }
}

const sortMedia = (m: PropertyMedia[]) => [...m].sort((a, b) => Number(a.metadata.order ?? 0) - Number(b.metadata.order ?? 0));
