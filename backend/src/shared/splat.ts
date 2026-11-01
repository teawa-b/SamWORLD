/**
 * Minimal PLY reader for SAM 3D Objects output. A Gaussian-splat PLY stores
 * per-splat centre (x,y,z), DC colour (f_dc_0..2, spherical-harmonic band 0)
 * and opacity (logit); plain PLY point clouds store red/green/blue. We read
 * centres and colours only, which is enough to show the object as a point
 * cloud. That is NOT a mesh and is labelled as a splat everywhere.
 */
export interface PointCloud {
  count: number;
  /** xyz per point */
  positions: Float32Array;
  /** rgb 0..1 per point */
  colors: Float32Array;
  isGaussianSplat: boolean;
}

const SIZES: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
const SH_C0 = 0.28209479177387814;

export function parsePly(buf: ArrayBuffer, opts: { minOpacity?: number; maxPoints?: number } = {}): PointCloud {
  const bytes = new Uint8Array(buf);
  const headEnd = findHeaderEnd(bytes);
  const header = new TextDecoder().decode(bytes.subarray(0, headEnd));
  const lines = header.split(/\r?\n/);
  if (lines[0].trim() !== 'ply') throw new Error('Not a PLY file');
  const format = lines.find((l) => l.startsWith('format'))?.split(/\s+/)[1];
  if (format !== 'binary_little_endian' && format !== 'ascii') throw new Error(`Unsupported PLY format ${format}`);
  let count = 0;
  const props: { name: string; type: string; offset: number }[] = [];
  let inVertex = false;
  let stride = 0;
  for (const l of lines) {
    const p = l.trim().split(/\s+/);
    if (p[0] === 'element') {
      inVertex = p[1] === 'vertex';
      if (inVertex) count = Number(p[2]);
    } else if (p[0] === 'property' && inVertex) {
      if (p[1] === 'list') throw new Error('List properties in vertex element are not supported');
      props.push({ name: p[2], type: p[1], offset: stride });
      stride += SIZES[p[1]] ?? 4;
    }
  }
  const idx = (n: string) => props.findIndex((p) => p.name === n);
  const ix = idx('x');
  const iy = idx('y');
  const iz = idx('z');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PLY has no x/y/z');
  const dc = [idx('f_dc_0'), idx('f_dc_1'), idx('f_dc_2')];
  const rgb = [idx('red'), idx('green'), idx('blue')];
  const op = idx('opacity');
  const isSplat = dc.every((i) => i >= 0);
  const minOpacity = opts.minOpacity ?? 0.1;
  const max = Math.min(count, opts.maxPoints ?? 400_000);
  const step = count > max ? count / max : 1;
  const positions = new Float32Array(max * 3);
  const colors = new Float32Array(max * 3);
  let n = 0;

  const read = makeReader(bytes, headEnd, format, props, stride, count);
  for (let k = 0; k < max; k++) {
    const row = Math.floor(k * step);
    const v = read(row);
    if (op >= 0 && isSplat && 1 / (1 + Math.exp(-v[op])) < minOpacity) continue;
    positions.set([v[ix], v[iy], v[iz]], n * 3);
    if (isSplat) colors.set(dc.map((i) => clamp01(0.5 + SH_C0 * v[i])), n * 3);
    else if (rgb.every((i) => i >= 0)) colors.set(rgb.map((i) => (props[i].type.includes('char') || props[i].type.includes('int8') ? v[i] / 255 : clamp01(v[i]))), n * 3);
    else colors.set([0.7, 0.7, 0.7], n * 3);
    n++;
  }
  return { count: n, positions: positions.subarray(0, n * 3), colors: colors.subarray(0, n * 3), isGaussianSplat: isSplat };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function findHeaderEnd(b: Uint8Array): number {
  const marker = 'end_header';
  for (let i = 0; i < Math.min(b.length, 64 * 1024); i++) {
    let ok = true;
    for (let j = 0; j < marker.length && ok; j++) ok = b[i + j] === marker.charCodeAt(j);
    if (ok) {
      let k = i + marker.length;
      if (b[k] === 13) k++;
      if (b[k] === 10) k++;
      return k;
    }
  }
  throw new Error('PLY header not terminated');
}

function makeReader(bytes: Uint8Array, start: number, format: string, props: { type: string; offset: number }[], stride: number, count: number): (row: number) => number[] {
  if (format === 'ascii') {
    const rows = new TextDecoder().decode(bytes.subarray(start)).split(/\r?\n/).filter((l) => l.trim());
    return (row) => rows[row].trim().split(/\s+/).map(Number);
  }
  if (bytes.length < start + stride * count) throw new Error('PLY body is shorter than its header says');
  const dv = new DataView(bytes.buffer, bytes.byteOffset + start);
  const getters = props.map((p) => {
    const t = p.type;
    if (t === 'float' || t === 'float32') return (o: number) => dv.getFloat32(o, true);
    if (t === 'double' || t === 'float64') return (o: number) => dv.getFloat64(o, true);
    if (t === 'uchar' || t === 'uint8') return (o: number) => dv.getUint8(o);
    if (t === 'char' || t === 'int8') return (o: number) => dv.getInt8(o);
    if (t === 'short' || t === 'int16') return (o: number) => dv.getInt16(o, true);
    if (t === 'ushort' || t === 'uint16') return (o: number) => dv.getUint16(o, true);
    if (t === 'int' || t === 'int32') return (o: number) => dv.getInt32(o, true);
    return (o: number) => dv.getUint32(o, true);
  });
  return (row) => props.map((p, i) => getters[i](row * stride + p.offset));
}
