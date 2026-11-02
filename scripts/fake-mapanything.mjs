#!/usr/bin/env node
/**
 * A stand-in for the MapAnything GPU worker, for trying the Roomshift UI end to end without Modal.
 * Answers POST /reconstruct like worker-3d/mapanything_app.py with a synthetic, slightly tilted and rotated
 * 4.2 × 3.4 × 2.5 m room (floor, walls, part of the ceiling, a sofa, a bookcase, a table), whatever frames you send.
 *
 *   node scripts/fake-mapanything.mjs            (listens on http://127.0.0.1:8790)
 *   then start the backend with  MAPANYTHING_URL=http://127.0.0.1:8790/reconstruct  MAPANYTHING_TOKEN=fake
 * (environment variables override backend/.env).
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8790);
const TOKEN = process.env.MAPANYTHING_TOKEN ?? 'fake';

function room() {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const W = 4.2, D = 3.4, H = 2.5, s = 0.025;
  const pts = [];
  const add = (x, y, z, c) => pts.push([x + rnd() * 0.012, y + rnd() * 0.012, z + rnd() * 0.012, ...c.map((v) => Math.max(0, Math.min(255, v + rnd() * 18)))]);
  const box = (x0, y0, z0, x1, y1, z1, c) => {
    for (let x = x0; x <= x1; x += s) for (let z = z0; z <= z1; z += s) add(x, y1, z, c);
    for (let y = y0; y <= y1; y += s) {
      for (let x = x0; x <= x1; x += s) add(x, y, z1, c.map((v) => v * 0.85)), add(x, y, z0, c.map((v) => v * 0.85));
      for (let z = z0; z <= z1; z += s) add(x0, y, z, c.map((v) => v * 0.75)), add(x1, y, z, c.map((v) => v * 0.75));
    }
  };
  for (let x = 0; x <= W; x += s) for (let z = 0; z <= D; z += s) {
    add(x, 0, z, [150 + 20 * Math.sin(z * 9), 112, 78]); // wooden floor
    if (x > 1 && x < 3.4 && z > 0.6 && z < 2.6) add(x, 0.012, z, [70, 90, 140]); // rug
    if (z < 2.2) add(x, H, z, [236, 236, 230]); // ceiling, partly seen
  }
  for (let y = 0; y <= H; y += s) {
    const skirting = y < 0.1 ? 0.7 : 1;
    for (let x = 0; x <= W; x += s) {
      add(x, y, 0, [214 * skirting, 204 * skirting, 186 * skirting]);
      if (!(x > 1.4 && x < 2.8 && y > 0.9 && y < 2.1)) add(x, y, D, [214 * skirting, 204 * skirting, 186 * skirting]); // window gap
    }
    for (let z = 0; z <= D; z += s) {
      add(0, y, z, [196 * skirting, 206 * skirting, 200 * skirting]);
      if (!(z > 1.2 && z < 2.1 && y < 2.05)) add(W, y, z, [214 * skirting, 204 * skirting, 186 * skirting]); // doorway
    }
  }
  box(0.3, 0, 0.15, 2.3, 0.85, 1.05, [96, 104, 120]); // sofa
  box(3.6, 0, 0.1, 4.1, 1.9, 0.45, [120, 84, 52]); // bookcase
  box(1.6, 0.42, 1.6, 2.6, 0.47, 2.2, [160, 120, 80]); // coffee table top
  // Tilt 6°, yaw 32°, offset: as if the first camera's frame were the world.
  const t = 0.1, yw = 0.56, ct = Math.cos(t), st = Math.sin(t), cy = Math.cos(yw), sy = Math.sin(yw);
  return pts.map(([x, y, z, r, g, b]) => {
    x -= W / 2; z -= D / 2; y -= 1.4;
    const y1 = y * ct - z * st, z1 = y * st + z * ct;
    return [x * cy + z1 * sy + 0.3, y1, -x * sy + z1 * cy - 1.8, r, g, b];
  });
}

function ply(pts) {
  const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${pts.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`);
  const body = Buffer.alloc(pts.length * 15);
  pts.forEach((p, i) => {
    body.writeFloatLE(p[0], i * 15);
    body.writeFloatLE(p[1], i * 15 + 4);
    body.writeFloatLE(p[2], i * 15 + 8);
    body.writeUInt8(Math.round(p[3]), i * 15 + 12);
    body.writeUInt8(Math.round(p[4]), i * 15 + 13);
    body.writeUInt8(Math.round(p[5]), i * 15 + 14);
  });
  return Buffer.concat([head, body]);
}

const pts = room();
const cloud = ply(pts);
createServer((req, res) => {
  if (req.url === '/health') return res.end(JSON.stringify({ ok: true, fake: true }));
  let n = 0;
  req.on('data', (c) => (n += c.length));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end('{"detail":"unauthorised"}');
    setTimeout(() => {
      res.end(JSON.stringify({ status: 'ok', model: 'FAKE MapAnything (scripts/fake-mapanything.mjs)', plyBase64: cloud.toString('base64'), points: pts.length, cameras: [{ pose: [1, 0, 0, 0, 0, Math.cos(0.1), -Math.sin(0.1), 0, 0, Math.sin(0.1), Math.cos(0.1), 0, 0, 0, 0, 1], intrinsics: [500, 500, 259, 194], width: 518, height: 388 }], timings: { inferSeconds: 1.5 }, diagnostics: [] }));
    }, 1500);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Fake MapAnything on http://127.0.0.1:${PORT}/reconstruct (token "${TOKEN}")`));
