/**
 * Roomshift steps 4–5 (DETAIL.md): a typed world → Muse Spark plan → Muse Image textures for walls, floor
 * and ceiling, and for each found object: Muse Image restyles its photo → SAM 3D rebuilds it as a 3D model,
 * shown where the real one stands. Without MODEL_API_KEY the same flow runs on local placeholders (clearly flagged `offline`)
 * so the app is usable and testable end to end.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { config, metaConfigured } from './config.js';
import { now } from './http.js';
import { AiBudget, museJson } from './meta/client.js';
import { restyleFlat, restyleImage, surfaceTexture } from './meta/image.js';
import { liftImage, sam3dReady } from './jobs/sam3d.js';
import { store, type Restyle, type RestyleObject, type RestylePlan, type Scan, type SurfaceId } from './store.js';

export const SURFACES: SurfaceId[] = ['walls', 'floor', 'ceiling'];
export const textureDir = () => join(config.dataDir, 'textures');
export const PLAN_PROMPT_VERSION = 'roomshift-plan-v2';
/** Per world (largest first): furniture is one Muse Image call + one SAM 3D job; a surface is one Muse Image call. */
const MAX_FURNITURE = 8;
const MAX_SURFACES = 10;

const hexOk = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);
const str = { type: 'string' };
const num = { type: 'number' };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const surfaceSchema = obj({ prompt: str, colorHex: str, tileMetres: num });
const planSchema = obj({
  title: str,
  brief: str,
  walls: surfaceSchema,
  floor: surfaceSchema,
  ceiling: surfaceSchema,
  light: obj({ colorHex: str, intensity: num }),
  fogHex: str,
  objects: { type: 'array', items: obj({ id: str, instruction: str }) },
});
type PlanReply = Omit<RestylePlan, 'surfaces'> & Record<SurfaceId, RestylePlan['surfaces'][SurfaceId]>;

/** Start a restyle of a reconstructed scan; runs in the background, progress is saved on the record. */
export async function startRestyle(scan: Scan, prompt: string): Promise<Restyle> {
  const r: Restyle = {
    id: `rs-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    scanId: scan.id,
    prompt,
    createdAt: now(),
    updatedAt: now(),
    state: 'planning',
    message: metaConfigured() ? 'Muse Spark is planning your world…' : 'Planning (offline placeholder: MODEL_API_KEY is not set)…',
    plan: null,
    surfaces: SURFACES.map((id) => ({ id, state: 'pending', texture: null, model: null, error: null, seconds: null })),
    objects: metaConfigured() ? restylable(scan).map((o) => ({ id: o.id, name: o.name, instruction: '', state: 'pending', image: null, model: null, format: null, error: null, seconds: null })) : [],
    offline: !metaConfigured(),
    models: [],
    usage: '',
  };
  await store.put('restyles', r.id, r);
  void runRestyle(scan, r);
  return r;
}

/**
 * The room as filmed, in 3D: every piece of furniture rebuilt by SAM 3D from its original photo and every door,
 * window and picture shown on its wall as its straightened photo. Runs once after the objects are found.
 */
export async function startOriginal(scan: Scan): Promise<Restyle | null> {
  const list = restylable(scan);
  if (!list.length) return null;
  const r: Restyle = {
    id: `rs-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    scanId: scan.id,
    prompt: 'As filmed',
    createdAt: now(),
    updatedAt: now(),
    state: 'painting',
    message: 'Rebuilding your furniture in 3D with SAM 3D…',
    plan: null,
    surfaces: [],
    objects: list.map((o) => ({ id: o.id, name: o.name, instruction: 'as filmed', state: 'pending', image: null, model: null, format: null, error: null, seconds: null })),
    offline: false,
    models: [],
    usage: '',
    original: true,
  };
  await store.put('restyles', r.id, r);
  const save = (patch: Partial<Restyle> = {}) => store.put('restyles', r.id, Object.assign(r, patch, { updatedAt: now() }));
  void (async () => {
    await paintObjects(scan, r, new AiBudget(0), () => save(), true);
    const objs = r.objects ?? [];
    await save({ state: 'done', message: `Your room in 3D: ${objs.filter((o) => o.state === 'done').length}/${objs.length} pieces placed.` });
  })();
  return r;
}

/** The objects worth restyling, largest first: furniture (needs SAM 3D) and things flat on the walls. */
function restylable(scan: Scan) {
  const all = (scan.objects ?? []).filter((o) => o.crop);
  const surfaces = all.filter((o) => o.kind === 'surface').slice(0, MAX_SURFACES);
  const furniture = sam3dReady().ok ? all.filter((o) => o.kind !== 'surface').slice(0, MAX_FURNITURE) : [];
  return all.filter((o) => surfaces.includes(o) || furniture.includes(o));
}

async function runRestyle(scan: Scan, r: Restyle) {
  const save = (patch: Partial<Restyle> = {}) => store.put('restyles', r.id, Object.assign(r, patch, { updatedAt: now() }));
  const budget = new AiBudget(12 + MAX_FURNITURE + MAX_SURFACES);
  try {
    // ---- plan
    let plan: RestylePlan;
    if (r.offline) plan = offlinePlan(r.prompt);
    else {
      const { data, model } = await museJson<PlanReply>({
        budget,
        system:
          'You are the art director of SamWORLD: a real room has been scanned in 3D, and the user types a world it should become. ' +
          'Write a plan that repaints the room’s surfaces so it convincingly becomes that world while keeping its real shape. ' +
          'For walls, floor and ceiling: `prompt` describes ONE seamless, tileable material texture seen flat and straight-on (material, colour, pattern, wear, small details; no objects, no perspective, no people, no text), ' +
          '`colorHex` is its average colour (#rrggbb) and `tileMetres` how many metres one tile of the texture covers (0.5–4). ' +
          '`light` is the room’s ambient light colour and intensity (0.3 dim … 1.5 bright); `fogHex` is the atmosphere colour. ' +
          '`title` is a 2–5 word name for the world, `brief` one vivid sentence. ' +
          'For every listed object, `objects` gives its `id` and an `instruction` saying what that piece becomes in this world while keeping its role, size and shape ' +
          '(e.g. "a carved dark-oak four-poster bed with velvet drapes"; a door stays a door, a window a window): one concrete sentence about materials, colours and details, no scenery. Return JSON only.',
        text: `World: "${r.prompt}".\n${roomDescription(scan)}\n${objectList(scan)}\nPhotos of the real room follow.`,
        images: await keyframes(scan, 2),
        schemaName: 'roomshift_plan',
        schema: planSchema,
      });
      plan = normalisePlan(data);
      r.models.push(model);
    }
    await save({ plan, state: 'painting', message: `Painting “${plan.title}”…` });

    for (const o of r.objects ?? []) o.instruction = plan.objects?.find((p) => p.id === o.id)?.instruction || `${o.name} reimagined for ${r.prompt}`;
    // ---- paint: the three surfaces in parallel (Muse Image allows a few at a time), objects alongside
    const objectsDone = paintObjects(scan, r, budget, () => save());
    await Promise.all(
      r.surfaces.map(async (s) => {
        const t = Date.now();
        s.state = 'running';
        await save();
        try {
          const spec = plan.surfaces[s.id];
          const surface = s.id === 'walls' ? 'wall' : s.id;
          const key = createHash('sha256').update(JSON.stringify([r.offline ? 'offline-v1' : config.meta.imageModel, surface, spec.prompt, r.offline ? spec.colorHex : ''])).digest('hex').slice(0, 24);
          await mkdir(textureDir(), { recursive: true });
          const cached = ['png', 'jpg', 'webp'].map((e) => `${key}.${e}`).find((f) => existsSync(join(textureDir(), f)));
          if (cached) {
            s.texture = cached;
            s.model = r.offline ? 'offline placeholder' : `${config.meta.imageModel} (cached)`;
          } else if (r.offline) {
            s.texture = `${key}.png`;
            await writeFile(join(textureDir(), s.texture), placeholderTexture(spec.colorHex, s.id, key));
            s.model = 'offline placeholder';
          } else {
            const img = await surfaceTexture({ budget, description: spec.prompt, surface });
            const buf = Buffer.from(img.imageBase64, 'base64');
            s.texture = `${key}.${sniff(buf)}`;
            await writeFile(join(textureDir(), s.texture), buf);
            s.model = img.model;
            if (!r.models.includes(img.model)) r.models.push(img.model);
          }
          s.state = 'done';
        } catch (e) {
          s.state = 'failed';
          s.error = (e as Error).message;
        }
        s.seconds = Math.round((Date.now() - t) / 100) / 10;
        await save();
      }),
    );
    if ((r.objects ?? []).length) await save({ message: 'Walls, floor and ceiling painted; rebuilding the furniture in 3D…' });
    await objectsDone;
    const failed = r.surfaces.filter((s) => s.state === 'failed');
    const objs = r.objects ?? [];
    const objNote = objs.length ? ` ${objs.filter((o) => o.state === 'done').length}/${objs.length} pieces of furniture rebuilt.` : '';
    await save({
      state: failed.length === r.surfaces.length ? 'failed' : 'done',
      message: (failed.length ? `${r.surfaces.length - failed.length}/${r.surfaces.length} surfaces painted. ${failed.map((f) => `${f.id}: ${f.error}`).join('; ')}` : `“${plan.title}” is ready.`) + objNote,
      usage: budget.summary(),
    });
  } catch (e) {
    await save({ state: 'failed', message: (e as Error).message, usage: budget.summary() });
  }
}

function objectList(scan: Scan): string {
  const list = restylable(scan);
  if (!list.length) return 'No objects to restyle: return an empty `objects` list.';
  return `Objects found in the room (id: name, width × height × depth in metres):\n${list.map((o) => `${o.id}: ${o.name}, ${o.box.size.map((v) => v.toFixed(1)).join(' × ')}`).join('\n')}`;
}

/** Run at most `n` of the given jobs at once. */
export function slots(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= n) await new Promise<void>((res) => waiting.push(res));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Muse Image restyles in flight per world (on top of the three surfaces) and SAM 3D jobs in flight (fal). */
const MUSE_OBJECT_SLOTS = 5;
const SAM3D_SLOTS = 5;

/**
 * Each object: Muse Image restyles the crop of its clearest view (same pose and framing), then SAM 3D
 * rebuilds the restyled piece as a 3D model. Two independent queues, so a piece waiting on SAM 3D never
 * holds up the next restyle: every restyle starts at once (5 at a time) and each goes to SAM 3D the moment
 * its image is ready (5 at a time).
 */
async function paintObjects(scan: Scan, r: Restyle, budget: AiBudget, save: () => Promise<void>, asFilmed = false) {
  const muse = slots(MUSE_OBJECT_SLOTS);
  const sam = slots(SAM3D_SLOTS);
  const work = async (o: RestyleObject) => {
    const t = Date.now();
    const so = scan.objects?.find((x) => x.id === o.id);
    try {
      if (!so?.crop) throw new Error('no photo of this object');
      const surface = so.kind === 'surface';
      const crop = await readFile(join(config.dataDir, 'scans', scan.id, surface && so.face ? so.face : so.crop));
      o.state = 'restyling';
      await save();
      const key = createHash('sha256').update(JSON.stringify([config.meta.imageModel, surface ? 'flat-v1' : 'object-v1', o.instruction])).update(crop).digest('hex').slice(0, 24);
      await mkdir(textureDir(), { recursive: true });
      let image = ['png', 'jpg', 'webp'].map((e) => `${key}.${e}`).find((f) => existsSync(join(textureDir(), f)));
      if (asFilmed) {
        // No new world: the photo itself (straightened for surfaces).
        image = `${createHash('sha256').update(crop).digest('hex').slice(0, 24)}.jpg`;
        if (!existsSync(join(textureDir(), image))) await writeFile(join(textureDir(), image), crop);
      } else if (!image) {
        const args = { budget, imageDataUrl: `data:image/jpeg;base64,${crop.toString('base64')}`, instruction: o.instruction, subject: so.label };
        const img = await muse(() => (surface ? restyleFlat(args) : restyleImage({ ...args, subject: o.name })));
        const buf = Buffer.from(img.imageBase64, 'base64');
        image = `${key}.${sniff(buf)}`;
        await writeFile(join(textureDir(), image), buf);
      }
      o.image = image;
      if (surface) {
        // Laid on the wall where the real one is: no 3D model needed.
        o.format = 'plane';
        o.state = 'done';
        o.seconds = Math.round((Date.now() - t) / 100) / 10;
        await save();
        return;
      }
      o.state = 'lifting';
      await save();
      const buf = await readFile(join(textureDir(), image));
      const lifted = await sam(() => liftImage({ id: `${r.id}-${o.id}`, label: so.label, image: buf, mime: image!.endsWith('.png') ? 'image/png' : image!.endsWith('.webp') ? 'image/webp' : 'image/jpeg' }));
      if (!lifted.ok) throw new Error(`SAM 3D: ${lifted.error}`);
      o.model = lifted.url;
      o.format = lifted.format;
      o.state = 'done';
      if (!r.models.includes(lifted.model)) r.models.push(lifted.model);
    } catch (e) {
      o.state = 'failed';
      o.error = (e as Error).message.slice(0, 300);
    }
    o.seconds = Math.round((Date.now() - t) / 100) / 10;
    await save();
  };
  await Promise.all((r.objects ?? []).map(work));
}

function roomDescription(scan: Scan): string {
  const s = scan.shell;
  if (!s || s.fallback) return 'The room’s exact shape could not be measured.';
  return `The room is ${s.size.width.toFixed(1)} × ${s.size.depth.toFixed(1)} m with a ${s.size.height.toFixed(1)} m ceiling.`;
}

async function keyframes(scan: Scan, n: number): Promise<string[]> {
  if (!scan.frames.length) return [];
  const picks = [...new Set(Array.from({ length: n }, (_, i) => Math.floor(((i + 0.5) / n) * scan.frames.length)))];
  return Promise.all(
    picks.map(async (i) => {
      const f = scan.frames[i];
      const buf = await readFile(join(config.dataDir, 'scans', scan.id, f.file));
      const ext = f.file.split('.').pop()!;
      return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`;
    }),
  );
}

function normalisePlan(d: PlanReply): RestylePlan {
  const clamp = (v: number, lo: number, hi: number, dflt: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  const surf = (s: PlanReply['walls'], dflt: string, tile: number) => ({
    prompt: String(s?.prompt ?? '').slice(0, 600) || dflt,
    colorHex: hexOk(s?.colorHex) ? s.colorHex : '#b0a898',
    tileMetres: clamp(s?.tileMetres, 0.5, 4, tile),
  });
  return {
    title: String(d.title ?? '').slice(0, 60) || 'Your new world',
    brief: String(d.brief ?? '').slice(0, 300),
    surfaces: { walls: surf(d.walls, 'painted plaster', 2), floor: surf(d.floor, 'wooden floorboards', 1.5), ceiling: surf(d.ceiling, 'white plaster', 2) },
    light: { colorHex: hexOk(d.light?.colorHex) ? d.light.colorHex : '#ffffff', intensity: clamp(d.light?.intensity, 0.3, 1.5, 1) },
    fogHex: hexOk(d.fogHex) ? d.fogHex : '#000000',
    objects: (Array.isArray(d.objects) ? d.objects : []).map((o) => ({ id: String(o?.id ?? ''), instruction: String(o?.instruction ?? '').slice(0, 300) })).filter((o) => o.id),
  };
}

// ---------------------------------------------------------------------------------- offline placeholders

const MOODS: [RegExp, [string, string, string], string, string][] = [
  [/under ?water|ocean|sea|coral|reef|aquarium/i, ['#1f6f86', '#c9b27c', '#0d3b52'], '#5fd0ff', '#0a3550'],
  [/haunt|gothic|victorian|vampire|spooky|horror/i, ['#3b2a3f', '#3a2618', '#1d1620'], '#c9a0ff', '#120c16'],
  [/forest|jungle|woods|garden|moss/i, ['#46623a', '#4a3a24', '#2c4a2a'], '#d9ffb0', '#1a2a14'],
  [/space|ship|sci.?fi|cyber|neon|future|arcade|tokyo/i, ['#1b2133', '#2a2f3a', '#0e1220'], '#9ad0ff', '#060812'],
  [/desert|egypt|sand|tomb/i, ['#c9a46a', '#d8b98a', '#a78a5a'], '#ffe2b0', '#3a2a14'],
  [/ice|snow|arctic|frozen/i, ['#cfe6f2', '#e8f4fa', '#b6d4e6'], '#dff4ff', '#a8c8dc'],
  [/castle|medieval|dungeon|stone/i, ['#7a7366', '#5a5246', '#4a443a'], '#ffd9a0', '#1a160f'],
  [/candy|pastel|cute|toy/i, ['#f6b6d0', '#b6e3f6', '#fff1b6'], '#ffffff', '#f6d6e6'],
];

export function offlinePlan(prompt: string): RestylePlan {
  const hit = MOODS.find(([re]) => re.test(prompt));
  let cols: [string, string, string];
  let light = '#fff4e6';
  let fog = '#101010';
  if (hit) [, cols, light, fog] = hit;
  else {
    const h = createHash('sha256').update(prompt).digest();
    const hue = (h[0] / 255) * 360;
    cols = [hsl(hue, 0.35, 0.55), hsl((hue + 30) % 360, 0.3, 0.35), hsl(hue, 0.2, 0.8)];
  }
  const title = prompt.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Your new world';
  return {
    title: title[0].toUpperCase() + title.slice(1),
    brief: `Offline placeholder for “${prompt}”. Set MODEL_API_KEY for Muse Spark’s plan and Muse Image’s paint.`,
    surfaces: {
      walls: { prompt: `${prompt}: wall`, colorHex: cols[0], tileMetres: 2 },
      floor: { prompt: `${prompt}: floor`, colorHex: cols[1], tileMetres: 1.5 },
      ceiling: { prompt: `${prompt}: ceiling`, colorHex: cols[2], tileMetres: 2 },
    },
    light: { colorHex: light, intensity: 1 },
    fogHex: fog,
  };
}

/** 256 px tileable texture: planks for floors, soft blocks for walls, smooth mottling for ceilings. */
export function placeholderTexture(colorHex: string, kind: SurfaceId, seed: string): Buffer {
  const N = 256;
  const png = new PNG({ width: N, height: N });
  const base = [1, 3, 5].map((i) => parseInt(colorHex.slice(i, i + 2), 16));
  const sd = createHash('sha256').update(seed).digest();
  const ph = (i: number) => (sd[i % sd.length] / 255) * Math.PI * 2;
  const T = (2 * Math.PI) / N;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      // Periodic noise: integer frequencies keep it seamless.
      let n = 0;
      for (let k = 1; k <= 6; k++) n += (Math.sin(T * (k * x + (k + 1) * y) + ph(k)) + Math.sin(T * ((k + 2) * x - k * y) + ph(k + 7))) / (k * 2);
      let shade = 1 + n * 0.08;
      if (kind === 'floor') {
        const row = Math.floor(y / 32);
        const off = (row * 97) % N;
        shade *= 1 + Math.sin(T * 8 * x + row) * 0.03 + ((sd[row % sd.length] / 255) - 0.5) * 0.12;
        if (y % 32 < 2 || (x + off) % 128 < 2) shade *= 0.72;
      } else if (kind === 'walls') {
        const row = Math.floor(y / 64);
        const off = row % 2 ? 64 : 0;
        if (y % 64 < 2 || (x + off) % 128 < 2) shade *= 0.85;
      }
      const i = (y * N + x) * 4;
      for (let c = 0; c < 3; c++) png.data[i + c] = Math.max(0, Math.min(255, Math.round(base[c] * shade)));
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

function hsl(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function sniff(b: Buffer): 'png' | 'jpg' | 'webp' {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return 'png';
}
