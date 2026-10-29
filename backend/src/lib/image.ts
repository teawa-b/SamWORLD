/** Tiny header readers so we never need a native image dependency (pngjs is pure JS). */
import { PNG } from 'pngjs';

/**
 * Transparent PNGs flattened onto white. Floor plans are often black lines on a transparent background, and
 * models that drop the alpha channel see an all-black image. Anything else is returned unchanged.
 */
export function flattenTransparentPng(buf: Buffer): Buffer {
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) return buf;
  const colorType = buf[25];
  const hasAlpha = colorType === 4 || colorType === 6 || buf.indexOf('tRNS') !== -1;
  if (!hasAlpha) return buf;
  const png = PNG.sync.read(buf); // RGBA, 8 bits per channel
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    for (let c = 0; c < 3; c++) d[i + c] = Math.round(d[i + c] * a + 255 * (1 - a));
    d[i + 3] = 255;
  }
  return PNG.sync.write(png, { colorType: 2 });
}

export function imageSize(buf: Buffer): { width: number; height: number } | null {
  // PNG
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  // JPEG: walk segments to the first SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  // WebP (VP8 / VP8L / VP8X)
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

export const MODEL_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function mimeFromName(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop();
  return (
    { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', mp4: 'video/mp4' } as Record<string, string>
  )[ext ?? ''] ?? null;
}

export const toDataUrl = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString('base64')}`;
