/**
 * Shrink a GLB for the browser without changing how it looks at room scale, and without anything the
 * standard three.js loader can't read (no Draco/meshopt decoders):
 *  - embedded PNG/JPEG textures downscaled to at most `maxTexture` px and re-encoded as JPEG (opaque
 *    materials only; a texture used with alpha is left alone);
 *  - 32-bit triangle indices stored as 16-bit when every index fits.
 * Anything it doesn't recognise (external buffers, sparse accessors, extensions) is returned untouched.
 * SAM 3D models go from ~1.4 MB to roughly a quarter of that before gzip.
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

interface Gltf {
  buffers?: { byteLength: number; uri?: string }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; sparse?: unknown; min?: number[]; max?: number[] }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  textures?: { source?: number }[];
  materials?: { alphaMode?: string; pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
  meshes?: { primitives: { indices?: number }[] }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

export function shrinkGlb(glb: Buffer, opts: { maxTexture?: number; jpegQuality?: number } = {}): Buffer {
  const maxTexture = opts.maxTexture ?? 1024;
  const quality = opts.jpegQuality ?? 82;
  if (glb.length < 20 || glb.readUInt32LE(0) !== GLB_MAGIC) return glb;
  const jsonLen = glb.readUInt32LE(12);
  if (glb.readUInt32LE(16) !== JSON_CHUNK) return glb;
  const json: Gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen;
  if (binStart + 8 > glb.length || glb.readUInt32LE(binStart + 4) !== BIN_CHUNK) return glb;
  const bin = glb.subarray(binStart + 8, binStart + 8 + glb.readUInt32LE(binStart));
  if ((json.buffers ?? []).length !== 1 || json.buffers![0].uri || (json.extensionsRequired ?? []).length) return glb;
  if ((json.accessors ?? []).some((a) => a.sparse)) return glb;

  const views = json.bufferViews.map((v) => Buffer.from(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)));

  // Textures used with alpha keep their PNG.
  const alphaImages = new Set<number>();
  for (const m of json.materials ?? []) {
    const t = m.pbrMetallicRoughness?.baseColorTexture?.index;
    const src = t != null ? json.textures?.[t]?.source : undefined;
    if (src != null && m.alphaMode && m.alphaMode !== 'OPAQUE') alphaImages.add(src);
  }
  for (const [k, img] of (json.images ?? []).entries()) {
    if (img.bufferView == null || alphaImages.has(k) || !/image\/(png|jpeg)/.test(img.mimeType ?? '')) continue;
    try {
      const raw = views[img.bufferView];
      // Some exporters pad the view after the PNG's IEND chunk; the decoder rejects trailing bytes.
      const iend = raw.indexOf('IEND');
      const png = iend > 0 ? raw.subarray(0, iend + 8) : raw;
      const dec = img.mimeType === 'image/png' ? PNG.sync.read(png) : jpeg.decode(raw, { useTArray: true, formatAsRGBA: true });
      const { data, width, height } = downscale(dec.data, dec.width, dec.height, maxTexture);
      const out = Buffer.from(jpeg.encode({ data, width, height }, quality).data);
      if (out.length < raw.length) {
        views[img.bufferView] = out;
        img.mimeType = 'image/jpeg';
      }
    } catch {
      // Unreadable image: keep it as it is.
    }
  }

  // 32-bit indices → 16-bit where they fit and the view holds nothing else.
  const viewUse = new Map<number, number>();
  for (const a of json.accessors ?? []) if (a.bufferView != null) viewUse.set(a.bufferView, (viewUse.get(a.bufferView) ?? 0) + 1);
  const indexAccessors = new Set<number>();
  for (const m of json.meshes ?? []) for (const p of m.primitives) if (p.indices != null) indexAccessors.add(p.indices);
  for (const ai of indexAccessors) {
    const a = json.accessors![ai];
    if (a.componentType !== 5125 || a.bufferView == null || viewUse.get(a.bufferView) !== 1) continue;
    const src = views[a.bufferView];
    const off = a.byteOffset ?? 0;
    let max = 0;
    for (let i = 0; i < a.count; i++) max = Math.max(max, src.readUInt32LE(off + i * 4));
    if (max >= 65535) continue;
    const out = Buffer.alloc(a.count * 2);
    for (let i = 0; i < a.count; i++) out.writeUInt16LE(src.readUInt32LE(off + i * 4), i * 2);
    views[a.bufferView] = out;
    a.componentType = 5123;
    a.byteOffset = 0;
  }

  // Repack the binary chunk, every view 4-byte aligned.
  const parts: Buffer[] = [];
  let at = 0;
  views.forEach((v, i) => {
    const pad = (4 - (at % 4)) % 4;
    if (pad) parts.push(Buffer.alloc(pad)), (at += pad);
    json.bufferViews[i].byteOffset = at;
    json.bufferViews[i].byteLength = v.length;
    parts.push(v);
    at += v.length;
  });
  const binOut = Buffer.concat([...parts, Buffer.alloc((4 - (at % 4)) % 4)]);
  json.buffers![0].byteLength = binOut.length;
  let jsonOut = Buffer.from(JSON.stringify(json), 'utf8');
  jsonOut = Buffer.concat([jsonOut, Buffer.alloc((4 - (jsonOut.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonOut.length + 8 + binOut.length, 8);
  const chunk = (type: number, body: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(body.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, body]);
  };
  return Buffer.concat([header, chunk(JSON_CHUNK, jsonOut), chunk(BIN_CHUNK, binOut)]);
}

/** Box-filter an RGBA image down so its longer side is at most `max` (power-of-two steps not required). */
function downscale(data: Uint8Array | Buffer, w: number, h: number, max: number): { data: Buffer; width: number; height: number } {
  const s = Math.max(w, h) / max;
  if (s <= 1) return { data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), width: w, height: h };
  const W = Math.max(1, Math.round(w / s)), H = Math.max(1, Math.round(h / s));
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor((y * h) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * w) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / W));
      const acc = [0, 0, 0, 0];
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) for (let c = 0; c < 4; c++) acc[c] += data[(yy * w + xx) * 4 + c];
      const n = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < 4; c++) out[(y * W + x) * 4 + c] = Math.round(acc[c] / n);
    }
  }
  return { data: out, width: W, height: H };
}
