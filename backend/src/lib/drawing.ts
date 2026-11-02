/**
 * "Is this image a floor-plan drawing?" from its pixels alone, no AI.
 *
 * Plans are line drawings: mostly white/light-grey background, almost no
 * saturated colour, and a small share of dark line pixels. Room photos fail at
 * least one of those (even a white bathroom has shading, colour casts and few
 * crisp dark lines). Used to find plans hidden in listing galleries.
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export interface DrawingScore {
  plan: boolean;
  white: number; // share of near-white pixels
  colourful: number; // share of clearly coloured pixels
  dark: number; // share of dark (line) pixels
  edges: number; // share of pixels with a sharp light/dark step to the right
  flat: number; // share of pixels (almost) identical to their neighbour: drawings are flat, photos are textured
}

function decode(buf: Buffer): { width: number; height: number; data: Uint8Array } | null {
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256, maxResolutionInMP: 40 });
    if (buf.readUInt32BE(0) === 0x89504e47) return PNG.sync.read(buf);
  } catch {
    return null;
  }
  return null;
}

export function drawingScore(buf: Buffer): DrawingScore | null {
  const img = decode(buf);
  if (!img || !img.width || !img.height) return null;
  const { width: w, height: h, data } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 60000))); // sample ~60k pixels
  let n = 0;
  let white = 0;
  let colourful = 0;
  let dark = 0;
  let edges = 0;
  let flat = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w - step; x += step) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      n++;
      if (min > 225) white++;
      if (max - min > 60 && max > 60) colourful++;
      if (lum < 90) dark++;
      const j = i + step * 4;
      const lum2 = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
      if (Math.abs(lum - lum2) > 120) edges++;
      if (Math.abs(r - data[j]) + Math.abs(g - data[j + 1]) + Math.abs(b - data[j + 2]) < 8) flat++;
    }
  }
  const s = { white: white / n, colourful: colourful / n, dark: dark / n, edges: edges / n, flat: flat / n };
  // Black-on-white line plans, or plans with flat coloured/shaded room fills.
  const lines = s.dark > 0.008 && s.dark < 0.35 && s.edges > 0.004;
  const plan = lines && ((s.white > 0.5 && s.colourful < 0.08) || (s.flat > 0.8 && s.colourful < 0.45));
  return { plan, ...s };
}
