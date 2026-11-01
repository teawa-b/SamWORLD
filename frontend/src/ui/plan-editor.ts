/**
 * Floor-plan editor (Screen 5, and the no-AI path from a plan to 3D).
 *
 * Works in plan-image pixels, exactly like Muse's plan reading, and saves a
 * FloorplanInterpretation that the deterministic geometry engine turns into
 * walls, door gaps and rooms. It is used to trace a plan by hand when no AI
 * is configured, and to correct an AI reading when it is.
 *
 * Tools: rectangle room, polygon room, door, window, stairs, select (drag
 * corners, edit label/type/printed size), delete. New corners snap to the
 * edges of neighbouring rooms so shared walls line up.
 */
import type { FloorplanInterpretation, OpeningType, PlanLevel, PlanOpening, PlanRoom, PropertyMedia, RoomType, Vec2 } from '../shared/index.js';
import { api, ApiError, mediaUrl } from '../api.js';
import { esc } from './importer.js';
import { icon } from './icons.js';

type Tool = 'select' | 'rect' | 'poly' | 'door' | 'window' | 'stairs';
type Sel = { kind: 'room' | 'opening' | 'stair'; id: string } | null;

interface Draft extends PlanLevel {
  url: string;
  W: number;
  H: number;
}

const TYPES: RoomType[] = ['living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'wc', 'hall', 'landing', 'utility', 'study', 'other'];
const TYPE_LABEL: Record<RoomType, string> = { living: 'Living room', kitchen: 'Kitchen', dining: 'Dining room', bedroom: 'Bedroom', bathroom: 'Bathroom', wc: 'WC', hall: 'Hallway', landing: 'Landing', utility: 'Utility', study: 'Study', other: 'Other' };
const LEVEL_NAMES = ['Ground floor', 'First floor', 'Second floor', 'Third floor', 'Fourth floor', 'Fifth floor'];
const SVGNS = 'http://www.w3.org/2000/svg';

const loadSize = (url: string) =>
  new Promise<{ W: number; H: number }>((res, rej) => {
    const img = new Image();
    img.onload = () => res({ W: img.naturalWidth || 1000, H: img.naturalHeight || 800 });
    img.onerror = () => rej(new Error('Could not load the floor plan image'));
    img.src = url;
  });

/** Distance from p to segment ab and the closest point on it. */
function nearestOnSeg(p: Vec2, a: Vec2, b: Vec2): { d: number; q: Vec2; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
  const q: Vec2 = [a[0] + t * dx, a[1] + t * dy];
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), q, t };
}

function pointIn(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Overlap of two roughly collinear edges, as a midpoint and length (or null). */
function sharedEdge(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2, tol: number): { mid: Vec2; len: number } | null {
  const L = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
  if (L < 1) return null;
  const ux = (a1[0] - a0[0]) / L;
  const uy = (a1[1] - a0[1]) / L;
  const off = (p: Vec2) => Math.abs((p[0] - a0[0]) * uy - (p[1] - a0[1]) * ux);
  if (off(b0) > tol || off(b1) > tol) return null;
  const s = (p: Vec2) => (p[0] - a0[0]) * ux + (p[1] - a0[1]) * uy;
  const lo = Math.max(0, Math.min(s(b0), s(b1)));
  const hi = Math.min(L, Math.max(s(b0), s(b1)));
  if (hi - lo <= 0) return null;
  const m = (lo + hi) / 2;
  return { mid: [a0[0] + ux * m, a0[1] + uy * m], len: hi - lo };
}

export class PlanEditor {
  private el: HTMLElement;
  private levels: Draft[] = [];
  private li = 0;
  private tool: Tool = 'rect';
  private sel: Sel = null;
  private drawing: { start?: Vec2; cur?: Vec2; pts?: Vec2[]; drag?: { roomId: string; vi: number } } = {};
  private dirty = false;
  private n = 0;
  private sourceNote = '';
  private sizeDraft: Record<string, { w: number; d: number }> = {};

  constructor(
    private propertyId: string,
    private media: PropertyMedia[],
    private onClose: (saved: boolean, rebuild: boolean) => void,
    private toast: (m: string) => void,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'plan-editor';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Floor plan editor');
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    this.el.addEventListener('input', (e) => this.onInput(e));
    window.addEventListener('keydown', this.onKey);
  }

  async open() {
    this.el.innerHTML = '<div class="pe-loading">Loading floor plan…</div>';
    const plans = this.media.filter((m) => m.type === 'floorplan' && m.metadata.excluded !== true);
    const { interpretation } = await api.interpretation(this.propertyId).catch(() => ({ interpretation: null as FloorplanInterpretation | null }));
    const usable = interpretation && interpretation.layoutSource === 'floorplan' && interpretation.levels.every((l) => plans.some((p) => p.id === l.planMediaId)) ? interpretation : null;
    if (usable) this.sourceNote = usable.provenance.method === 'admin-correction' ? 'Your traced plan' : `Starting from the reading by ${usable.provenance.method}. Check every room.`;
    for (const [i, m] of plans.entries()) {
      const url = mediaUrl(m);
      const size = typeof m.metadata.width === 'number' && typeof m.metadata.height === 'number' ? { W: m.metadata.width as number, H: m.metadata.height as number } : await loadSize(url);
      const existing = usable?.levels.find((l) => l.planMediaId === m.id);
      this.levels.push({
        ...(existing ?? { id: `L${i}`, index: i, name: LEVEL_NAMES[i] ?? `Floor ${i}`, planMediaId: m.id, ceilingHeightMeters: null, rooms: [], openings: [], stairs: [] }),
        rooms: structuredClone(existing?.rooms ?? []),
        openings: structuredClone(existing?.openings ?? []),
        stairs: structuredClone(existing?.stairs ?? []),
        url,
        ...size,
      });
    }
    this.levels.sort((a, b) => a.index - b.index);
    this.n = this.levels.reduce((s, l) => s + l.rooms.length + l.openings.length + l.stairs.length, 0) + 1;
    if (this.levels.some((l) => l.rooms.length)) this.tool = 'select';
    this.render();
  }

  close(saved = false, rebuild = false) {
    window.removeEventListener('keydown', this.onKey);
    this.el.remove();
    this.onClose(saved, rebuild);
  }

  private get L(): Draft {
    return this.levels[this.li];
  }
  private tol() {
    return Math.max(this.L.W, this.L.H) * 0.012;
  }
  private uid(p: string) {
    return `${p}${this.n++}-${Math.random().toString(36).slice(2, 5)}`;
  }

  /** Metres per pixel from rooms with a printed size (median), or null. */
  private mpp(): number | null {
    const s: number[] = [];
    for (const l of this.levels)
      for (const r of l.rooms) {
        if (!r.measured) continue;
        const xs = r.polygonPx.map((p) => p[0]);
        const ys = r.polygonPx.map((p) => p[1]);
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        if (w > 0 && h > 0) s.push(r.measured.widthM / w, r.measured.depthM / h);
      }
    if (!s.length) return null;
    s.sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // ------------------------------------------------------------ render
  private render() {
    const L = this.L;
    const mpp = this.mpp();
    const room = this.sel?.kind === 'room' ? L.rooms.find((r) => r.id === this.sel!.id) : null;
    const op = this.sel?.kind === 'opening' ? L.openings.find((o) => o.id === this.sel!.id) : null;
    const tools: [Tool, string, string, string][] = [
      ['select', 'cursor', 'Select', 'Click a room, door or window. Drag a room’s corners to adjust it.'],
      ['rect', 'square', 'Room', 'Drag a rectangle over a room, inside its walls.'],
      ['poly', 'plan', 'L-shape', 'Click each corner; click the first corner again (or press Enter) to finish.'],
      ['door', 'door', 'Door', 'Click on a wall where there is a door. Doors on shared walls connect the two rooms.'],
      ['window', 'window', 'Window', 'Click on an outside wall where there is a window.'],
      ['stairs', 'up', 'Stairs', 'Drag a rectangle over the staircase.'],
    ];
    const roomCount = this.levels.reduce((s, l) => s + l.rooms.length, 0);
    this.el.innerHTML = `
      <header class="pe-head">
        <b>Floor plan editor</b>
        <div class="segmented small">${this.levels.map((l, i) => `<button data-pe="level" data-i="${i}" class="${i === this.li ? 'active' : ''}">${esc(l.name)} <span class="faint">${l.rooms.length}</span></button>`).join('')}</div>
        <span class="grow"></span>
        <button class="btn small ghost" data-pe="cancel">Cancel</button>
        <button class="btn small" data-pe="save" ${roomCount ? '' : 'disabled'}>Save</button>
        <button class="btn small primary" data-pe="save-build" ${roomCount ? '' : 'disabled'}>${icon('cube', 16)}Save and build 3D</button>
      </header>
      <div class="pe-main">
        <div class="pe-tools">${tools.map(([t, ic, label, tip]) => `<button class="tool ${this.tool === t ? 'on' : ''}" data-pe="tool" data-tool="${t}" title="${esc(tip)}">${icon(ic, 18)}${label}</button>`).join('')}
          <button class="tool" data-pe="auto-doors" title="Add a door wherever a hall, landing or living space shares a wall with another room. Check them afterwards.">${icon('sparkle', 18)}Auto doors</button>
        </div>
        <div class="pe-canvas"><svg id="pe-svg" viewBox="0 0 ${L.W} ${L.H}" preserveAspectRatio="xMidYMid meet"></svg></div>
        <aside class="pe-side">
          <p class="xs muted">${esc(tools.find((t) => t[0] === this.tool)![3])}</p>
          ${this.sourceNote ? `<p class="xs callout info">${esc(this.sourceNote)}</p>` : ''}
          <div class="pe-scale ${mpp ? 'ok' : 'warn'}">${mpp ? `Scale: 1 m ≈ ${(1 / mpp).toFixed(0)} px, from printed room sizes` : 'No scale yet: enter the printed size of at least one room (select it, then fill width × depth). Without it the scale is a guess.'}</div>
          ${room ? this.roomInspector(room) : op ? this.openingInspector(op, mpp) : ''}
          <h4>Rooms on ${esc(L.name)}</h4>
          <ul class="pe-list">${L.rooms.map((r) => `<li class="${room?.id === r.id ? 'on' : ''}" data-pe="pick" data-id="${esc(r.id)}">${esc(r.label)} <span class="faint">${TYPE_LABEL[r.type]}${r.measured ? ` · ${r.measured.widthM}×${r.measured.depthM} m` : ''}</span></li>`).join('') || '<li class="faint">None yet</li>'}</ul>
          <p class="xs faint">${L.openings.filter((o) => o.type === 'door' || o.type === 'archway').length} doors · ${L.openings.filter((o) => o.type === 'window').length} windows · ${L.stairs.length} stairs. Ceiling height is not on most plans; 2.4 m is assumed and shown as estimated.</p>
        </aside>
      </div>`;
    this.drawSvg();
  }

  private roomInspector(r: PlanRoom) {
    return `<div class="pe-insp card">
      <label class="xs muted">Name<input class="field small" data-pe-in="label" value="${esc(r.label)}" /></label>
      <label class="xs muted">Type<select class="field small" data-pe-in="type">${TYPES.map((t) => `<option value="${t}" ${t === r.type ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`).join('')}</select></label>
      <div class="xs muted">Printed size (metres), if shown on the plan</div>
      <div class="row2"><input class="field small" type="number" step="0.01" min="0.3" max="40" placeholder="Width" data-pe-in="w" value="${r.measured?.widthM ?? (this.sizeDraft[r.id]?.w || '')}" /><input class="field small" type="number" step="0.01" min="0.3" max="40" placeholder="Depth" data-pe-in="d" value="${r.measured?.depthM ?? (this.sizeDraft[r.id]?.d || '')}" /></div>
      <button class="btn small ghost block" data-pe="delete">${icon('close', 14)}Delete room</button>
    </div>`;
  }

  private openingInspector(o: PlanOpening, mpp: number | null) {
    const names = o.roomIds.map((id) => this.L.rooms.find((r) => r.id === id)?.label ?? id).join(' ↔ ') || 'outside';
    return `<div class="pe-insp card">
      <label class="xs muted">Type<select class="field small" data-pe-in="otype">${(['door', 'archway', 'window'] as OpeningType[]).map((t) => `<option value="${t}" ${t === o.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="xs muted">Connects: ${esc(names)}${o.roomIds.length === 1 && o.type !== 'window' ? ' (outside)' : ''}</div>
      <label class="xs muted">Width ${mpp ? '(m)' : '(px)'}<input class="field small" type="number" step="${mpp ? 0.05 : 1}" data-pe-in="owidth" value="${mpp ? (o.widthPx * mpp).toFixed(2) : Math.round(o.widthPx)}" /></label>
      ${o.confidence < 0.6 ? '<div class="xs callout">Added automatically: check it is really there.</div>' : ''}
      <button class="btn small ghost block" data-pe="delete">${icon('close', 14)}Delete</button>
    </div>`;
  }

  private drawSvg() {
    const svg = this.el.querySelector('#pe-svg') as SVGSVGElement;
    const L = this.L;
    const sw = Math.max(L.W, L.H) / 400; // stroke width that reads at any image size
    const parts: string[] = [`<image href="${esc(L.url)}" x="0" y="0" width="${L.W}" height="${L.H}" />`];
    for (const r of L.rooms) {
      const on = this.sel?.kind === 'room' && this.sel.id === r.id;
      const pts = r.polygonPx.map((p) => p.join(',')).join(' ');
      const c = r.polygonPx.reduce((a, p) => [a[0] + p[0] / r.polygonPx.length, a[1] + p[1] / r.polygonPx.length], [0, 0]);
      parts.push(`<polygon class="pe-room ${on ? 'on' : ''}" data-room="${esc(r.id)}" points="${pts}" stroke-width="${sw}" />`);
      parts.push(`<text x="${c[0]}" y="${c[1]}" font-size="${sw * 9}" class="pe-label">${esc(r.label)}</text>`);
      if (on) r.polygonPx.forEach((p, i) => parts.push(`<circle class="pe-handle" data-room="${esc(r.id)}" data-vi="${i}" cx="${p[0]}" cy="${p[1]}" r="${sw * 4}" />`));
    }
    for (const s of L.stairs) parts.push(`<polygon class="pe-stair ${this.sel?.id === s.id ? 'on' : ''}" data-stair="${esc(s.id)}" points="${s.polygonPx.map((p) => p.join(',')).join(' ')}" stroke-width="${sw}" />`);
    for (const o of L.openings) {
      const on = this.sel?.kind === 'opening' && this.sel.id === o.id;
      parts.push(`<circle class="pe-op ${o.type} ${on ? 'on' : ''} ${o.confidence < 0.6 ? 'auto' : ''}" data-op="${esc(o.id)}" cx="${o.atPx[0]}" cy="${o.atPx[1]}" r="${Math.max(o.widthPx / 2, sw * 4)}" stroke-width="${sw}" />`);
    }
    const d = this.drawing;
    if (d.start && d.cur && (this.tool === 'rect' || this.tool === 'stairs')) {
      const [x0, y0] = d.start;
      const [x1, y1] = d.cur;
      parts.push(`<rect class="pe-preview" x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" stroke-width="${sw}" />`);
    }
    if (d.pts?.length) {
      parts.push(`<polyline class="pe-preview" points="${[...d.pts, ...(d.cur ? [d.cur] : [])].map((p) => p.join(',')).join(' ')}" stroke-width="${sw}" />`);
      d.pts.forEach((p, i) => parts.push(`<circle class="pe-handle ${i === 0 ? 'first' : ''}" cx="${p[0]}" cy="${p[1]}" r="${sw * 4}" />`));
    }
    svg.innerHTML = parts.join('');
    svg.onpointerdown = (e) => this.down(e, svg);
    svg.onpointermove = (e) => this.move(e, svg);
    svg.onpointerup = (e) => this.up(e, svg);
    svg.ondblclick = () => this.finishPoly();
  }

  // ------------------------------------------------------------ geometry input
  private at(e: PointerEvent | MouseEvent, svg: SVGSVGElement): Vec2 {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return [Math.max(0, Math.min(this.L.W, p.x)), Math.max(0, Math.min(this.L.H, p.y))];
  }

  /** Snap each axis to the nearest corner coordinate of another room. */
  private snap(p: Vec2, exceptRoom?: string): Vec2 {
    const tol = this.tol();
    let [x, y] = p;
    let bx = tol;
    let by = tol;
    for (const r of this.L.rooms) {
      if (r.id === exceptRoom) continue;
      for (const v of r.polygonPx) {
        if (Math.abs(v[0] - p[0]) < bx) [bx, x] = [Math.abs(v[0] - p[0]), v[0]];
        if (Math.abs(v[1] - p[1]) < by) [by, y] = [Math.abs(v[1] - p[1]), v[1]];
      }
    }
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  }

  private down(e: PointerEvent, svg: SVGSVGElement) {
    const p = this.at(e, svg);
    const t = e.target as Element;
    if (this.tool === 'select') {
      if (t.classList.contains('pe-handle') && (t as SVGElement).dataset.room) {
        this.drawing = { drag: { roomId: (t as SVGElement).dataset.room!, vi: Number((t as SVGElement).dataset.vi) } };
        svg.setPointerCapture(e.pointerId);
        return;
      }
      const op = (t as SVGElement).dataset?.op;
      const st = (t as SVGElement).dataset?.stair;
      const room = (t as SVGElement).dataset?.room ?? [...this.L.rooms].reverse().find((r) => pointIn(p, r.polygonPx))?.id;
      this.sel = op ? { kind: 'opening', id: op } : st ? { kind: 'stair', id: st } : room ? { kind: 'room', id: room } : null;
      return this.render();
    }
    if (this.tool === 'rect' || this.tool === 'stairs') {
      this.drawing = { start: this.snap(p), cur: this.snap(p) };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    if (this.tool === 'poly') {
      const pts = this.drawing.pts ?? [];
      if (pts.length >= 3 && Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < this.tol() * 1.5) return this.finishPoly();
      this.drawing = { pts: [...pts, this.snap(p)] };
      return this.drawSvg();
    }
    if (this.tool === 'door' || this.tool === 'window') this.addOpening(p, this.tool);
  }

  private move(e: PointerEvent, svg: SVGSVGElement) {
    const d = this.drawing;
    if (d.drag) {
      const r = this.L.rooms.find((x) => x.id === d.drag!.roomId)!;
      r.polygonPx[d.drag.vi] = this.snap(this.at(e, svg), r.id);
      this.dirty = true;
      return this.drawSvg();
    }
    if (d.start || d.pts) {
      d.cur = this.snap(this.at(e, svg));
      this.drawSvg();
    }
  }

  private up(_e: PointerEvent, _svg: SVGSVGElement) {
    const d = this.drawing;
    if (d.drag) {
      this.drawing = {};
      return this.render();
    }
    if (!d.start || !d.cur) return;
    const [x0, y0] = d.start;
    const [x1, y1] = d.cur;
    this.drawing = {};
    const min = this.tol();
    if (Math.abs(x1 - x0) < min || Math.abs(y1 - y0) < min) return this.drawSvg();
    const poly: Vec2[] = [
      [Math.min(x0, x1), Math.min(y0, y1)],
      [Math.max(x0, x1), Math.min(y0, y1)],
      [Math.max(x0, x1), Math.max(y0, y1)],
      [Math.min(x0, x1), Math.max(y0, y1)],
    ];
    if (this.tool === 'stairs') {
      const id = this.uid('s');
      const above = this.levels.find((l) => l.index === this.L.index + 1);
      this.L.stairs.push({ id, polygonPx: poly, toLevelId: above?.id ?? null, confidence: 0.9 });
      this.sel = { kind: 'stair', id };
    } else this.addRoom(poly);
  }

  private finishPoly() {
    const pts = this.drawing.pts ?? [];
    this.drawing = {};
    if (pts.length >= 3) this.addRoom(pts);
    else this.drawSvg();
  }

  private addRoom(poly: Vec2[]) {
    const id = this.uid('r');
    this.L.rooms.push({ id, label: `Room ${this.L.rooms.length + 1}`, type: 'other', polygonPx: poly, measured: null, confidence: 0.9 });
    this.sel = { kind: 'room', id };
    this.dirty = true;
    this.render();
    (this.el.querySelector('[data-pe-in="label"]') as HTMLInputElement | null)?.select();
  }

  private addOpening(p: Vec2, type: 'door' | 'window', confidence = 0.9, roomIds?: string[]) {
    const tol = this.tol() * 1.6;
    let best: { d: number; q: Vec2 } | null = null;
    const near = new Set<string>();
    for (const r of this.L.rooms) {
      const ring = r.polygonPx;
      for (let i = 0; i < ring.length; i++) {
        const n = nearestOnSeg(p, ring[i], ring[(i + 1) % ring.length]);
        if (n.d < tol) near.add(r.id);
        if (!best || n.d < best.d) best = n;
      }
    }
    if (!best || best.d > tol || !near.size) {
      if (confidence > 0.6) this.toast('Click on a wall (a room’s edge) to place it.');
      return;
    }
    const mpp = this.mpp();
    const widthPx = mpp ? (type === 'door' ? 0.85 : 1.2) / mpp : Math.max(this.L.W, this.L.H) * (type === 'door' ? 0.035 : 0.05);
    const id = this.uid(type === 'door' ? 'd' : 'w');
    this.L.openings.push({ id, type, atPx: [Math.round(best.q[0] * 10) / 10, Math.round(best.q[1] * 10) / 10], widthPx, roomIds: roomIds ?? [...near].slice(0, 2), confidence });
    if (confidence > 0.6) this.sel = { kind: 'opening', id };
    this.dirty = true;
    this.render();
  }

  private autoDoors() {
    const L = this.L;
    const hub = new Set<RoomType>(['hall', 'landing', 'living', 'kitchen', 'dining']);
    const tol = this.tol();
    let added = 0;
    for (let i = 0; i < L.rooms.length; i++)
      for (let j = i + 1; j < L.rooms.length; j++) {
        const A = L.rooms[i];
        const B = L.rooms[j];
        if (!hub.has(A.type) && !hub.has(B.type)) continue;
        if (L.openings.some((o) => o.roomIds.includes(A.id) && o.roomIds.includes(B.id))) continue;
        let best: { mid: Vec2; len: number } | null = null;
        for (let a = 0; a < A.polygonPx.length; a++)
          for (let b = 0; b < B.polygonPx.length; b++) {
            const s = sharedEdge(A.polygonPx[a], A.polygonPx[(a + 1) % A.polygonPx.length], B.polygonPx[b], B.polygonPx[(b + 1) % B.polygonPx.length], tol);
            if (s && (!best || s.len > best.len)) best = s;
          }
        const mpp = this.mpp();
        const need = mpp ? 1.0 / mpp : Math.max(L.W, L.H) * 0.04;
        if (best && best.len > need) {
          this.addOpening(best.mid, 'door', 0.4, [A.id, B.id]);
          added++;
        }
      }
    this.toast(added ? `Added ${added} door(s) between neighbouring rooms. They are guesses — move or delete any that aren’t on the plan.` : 'No neighbouring rooms without a door were found. Rooms must share a wall edge.');
    this.render();
  }

  // ------------------------------------------------------------ events
  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.('input,select,textarea')) return;
    if (e.key === 'Escape') {
      if (this.drawing.pts || this.drawing.start) {
        this.drawing = {};
        return this.drawSvg();
      }
      return this.cancel();
    }
    if (e.key === 'Enter') this.finishPoly();
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) this.deleteSel();
    const keys: Record<string, Tool> = { v: 'select', r: 'room' as Tool, l: 'poly', d: 'door', w: 'window', s: 'stairs' };
    const t = keys[e.key.toLowerCase()];
    if (t) {
      this.tool = t === ('room' as Tool) ? 'rect' : t;
      this.drawing = {};
      this.render();
    }
  };

  private cancel() {
    if (this.dirty && !confirm('Discard your changes to the floor plan?')) return;
    this.close(false, false);
  }

  private deleteSel() {
    const s = this.sel;
    if (!s) return;
    const L = this.L;
    if (s.kind === 'room') {
      L.rooms = L.rooms.filter((r) => r.id !== s.id);
      L.openings = L.openings.filter((o) => !o.roomIds.includes(s.id) || o.roomIds.length > 1).map((o) => ({ ...o, roomIds: o.roomIds.filter((x) => x !== s.id) })).filter((o) => o.roomIds.length);
    } else if (s.kind === 'opening') L.openings = L.openings.filter((o) => o.id !== s.id);
    else L.stairs = L.stairs.filter((x) => x.id !== s.id);
    this.sel = null;
    this.dirty = true;
    this.render();
  }

  private async onClick(e: Event) {
    const t = (e.target as HTMLElement).closest('[data-pe]') as HTMLElement | null;
    if (!t) return;
    switch (t.dataset.pe) {
      case 'tool':
        this.tool = t.dataset.tool as Tool;
        this.drawing = {};
        return this.render();
      case 'level':
        this.li = Number(t.dataset.i);
        this.sel = null;
        this.drawing = {};
        return this.render();
      case 'pick':
        this.sel = { kind: 'room', id: t.dataset.id! };
        this.tool = 'select';
        return this.render();
      case 'delete':
        return this.deleteSel();
      case 'auto-doors':
        return this.autoDoors();
      case 'cancel':
        return this.cancel();
      case 'save':
      case 'save-build':
        return this.save(t.dataset.pe === 'save-build');
    }
  }

  private onInput(e: Event) {
    const el = e.target as HTMLInputElement;
    const r = this.sel?.kind === 'room' ? this.L.rooms.find((x) => x.id === this.sel!.id) : null;
    if (r && el.dataset.peIn === 'label') {
      r.label = el.value.slice(0, 60) || 'Room';
      this.dirty = true;
      this.drawSvg();
    }
  }

  private onChange(e: Event) {
    const el = e.target as HTMLInputElement;
    const k = el.dataset.peIn;
    if (!k) return;
    const L = this.L;
    const r = this.sel?.kind === 'room' ? L.rooms.find((x) => x.id === this.sel!.id) : null;
    const o = this.sel?.kind === 'opening' ? L.openings.find((x) => x.id === this.sel!.id) : null;
    this.dirty = true;
    if (r && k === 'type') {
      const before = TYPE_LABEL[r.type];
      r.type = el.value as RoomType;
      if (/^Room \d+$/.test(r.label) || r.label === before) r.label = TYPE_LABEL[r.type];
    }
    if (r && (k === 'w' || k === 'd')) {
      // Keep a half-entered size (width typed, depth not yet) instead of wiping it on re-render.
      const draft = { ...(this.sizeDraft[r.id] ?? { w: r.measured?.widthM ?? NaN, d: r.measured?.depthM ?? NaN }), [k]: Number(el.value) || NaN };
      this.sizeDraft[r.id] = draft;
      r.measured = draft.w > 0 && draft.d > 0 ? { text: `${draft.w} m x ${draft.d} m (entered in editor)`, widthM: draft.w, depthM: draft.d } : null;
      const next = el.dataset.peIn === 'w' ? 'd' : null;
      this.render();
      if (next) (this.el.querySelector(`[data-pe-in="${next}"]`) as HTMLInputElement | null)?.focus();
      return;
    }
    if (o && k === 'otype') o.type = el.value as OpeningType;
    if (o && k === 'owidth') {
      const mpp = this.mpp();
      const v = Number(el.value);
      if (v > 0) o.widthPx = mpp ? v / mpp : v;
      o.confidence = Math.max(o.confidence, 0.9);
    }
    this.render();
  }

  private async save(rebuild: boolean) {
    const levels: PlanLevel[] = this.levels
      .filter((l) => l.rooms.length)
      .map(({ url: _u, W: _w, H: _h, ...l }) => ({ ...l, stairs: l.stairs.filter((s) => s.toLevelId && this.levels.some((x) => x.id === s.toLevelId && x.rooms.length)) }));
    if (!levels.length) return this.toast('Draw at least one room first.');
    if (levels.length < this.levels.length) this.toast('Floors without rooms are left out.');
    try {
      await api.saveInterpretation(this.propertyId, levels);
      this.dirty = false;
      this.close(true, rebuild);
    } catch (e) {
      this.toast(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }
}
