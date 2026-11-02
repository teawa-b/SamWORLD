/**
 * Compact point-cloud format for sending a scan to the browser ("RSC1"), about a third of a binary PLY's
 * size before compression and far smaller after gzip:
 *  - positions quantised to `stepMetres` (default 3 mm, well under the scan's own noise; uint16 per axis,
 *    offset from the cloud's minimum, coarser only when 65 535 steps don't span the cloud), colours as bytes;
 *  - points sorted along a Morton curve of ~5 cm cells, so neighbours are adjacent;
 *  - each axis delta-coded in that order (mod 2^16) and stored as separate low-byte / high-byte planes,
 *    and each colour channel delta-coded (mod 256), which turns most of the file into long runs of small
 *    numbers that gzip/brotli compress very well.
 * Layout: "RSC1" | count u32 | min xyz f32 | step f32 | xLo xHi yLo yHi zLo zHi r g b (count bytes each).
 */
import type { PointCloud } from './splat.js';

const MAGIC = 0x31435352; // "RSC1" little-endian
const HEADER = 24;

/** Spread the low 10 bits of v so there are two zero bits between each. */
function spread10(v: number): number {
  v &= 0x3ff;
  v = (v | (v << 16)) & 0x30000ff;
  v = (v | (v << 8)) & 0x300f00f;
  v = (v | (v << 4)) & 0x30c30c3;
  v = (v | (v << 2)) & 0x9249249;
  return v;
}

export function encodeCloud(positions: Float32Array, colors: Float32Array, stepMetres = 0.003): Uint8Array {
  const n = Math.floor(positions.length / 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      const v = positions[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  if (!n) min.fill(0), max.fill(0);
  const step = Math.max(stepMetres, Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 65535);
  const q = new Uint16Array(n * 3);
  for (let i = 0; i < n * 3; i++) q[i] = Math.min(65535, Math.max(0, Math.round((positions[i] - min[i % 3]) / step)));
  // Morton order on ~5 cm cells.
  const sh = Math.max(0, Math.round(Math.log2(0.05 / step)));
  const key = new Uint32Array(n);
  for (let i = 0; i < n; i++) key[i] = spread10(q[i * 3] >> sh) | (spread10(q[i * 3 + 1] >> sh) << 1) | (spread10(q[i * 3 + 2] >> sh) << 2);
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => key[a] - key[b]);

  const out = new Uint8Array(HEADER + n * 9);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, n, true);
  for (let k = 0; k < 3; k++) dv.setFloat32(8 + k * 4, min[k], true);
  dv.setFloat32(20, step, true);
  const prev = [0, 0, 0];
  const prevC = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    const i = order[j];
    for (let k = 0; k < 3; k++) {
      const d = (q[i * 3 + k] - prev[k]) & 0xffff;
      prev[k] = q[i * 3 + k];
      out[HEADER + (2 * k) * n + j] = d & 0xff;
      out[HEADER + (2 * k + 1) * n + j] = d >> 8;
    }
    for (let c = 0; c < 3; c++) {
      const v = Math.round(Math.min(1, Math.max(0, colors[i * 3 + c])) * 255);
      out[HEADER + (6 + c) * n + j] = (v - prevC[c]) & 0xff;
      prevC[c] = v;
    }
  }
  return out;
}

export function isEncodedCloud(buf: ArrayBuffer): boolean {
  return buf.byteLength >= HEADER && new DataView(buf).getUint32(0, true) === MAGIC;
}

export function decodeCloud(buf: ArrayBuffer): PointCloud {
  const dv = new DataView(buf);
  if (!isEncodedCloud(buf)) throw new Error('Not an RSC1 point cloud');
  const n = dv.getUint32(4, true);
  if (buf.byteLength < HEADER + n * 9) throw new Error('Truncated RSC1 point cloud');
  const min = [dv.getFloat32(8, true), dv.getFloat32(12, true), dv.getFloat32(16, true)];
  const step = dv.getFloat32(20, true);
  const b = new Uint8Array(buf, HEADER);
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const acc = [0, 0, 0];
  const accC = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < 3; k++) {
      acc[k] = (acc[k] + (b[2 * k * n + j] | (b[(2 * k + 1) * n + j] << 8))) & 0xffff;
      positions[j * 3 + k] = min[k] + acc[k] * step;
    }
    for (let c = 0; c < 3; c++) {
      accC[c] = (accC[c] + b[(6 + c) * n + j]) & 0xff;
      colors[j * 3 + c] = accC[c] / 255;
    }
  }
  return { count: n, positions, colors, isGaussianSplat: false };
}
