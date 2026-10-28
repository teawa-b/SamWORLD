#!/usr/bin/env node
/**
 * Generates the project-owned demo property: two floor-plan drawings (SVG)
 * and the reference interpretation of those drawings in the same schema the
 * Muse Spark plan parser returns (plan-pixel polygons + printed dimensions).
 *
 * Everything here is drawn by the project, so it is free to transform,
 * display and send to a model. The address is fictional.
 *
 * The reference interpretation adds ±2 px read-noise to every vertex so the
 * deterministic pipeline is exercised the way it would be with real model
 * output (vertex snapping, shared-wall detection, scale estimation).
 *
 * Usage: node test-fixtures/demo-house/generate.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PX_PER_M = 50;
const ORIGIN = 60;
const px = (m) => ORIGIN + m * PX_PER_M;

// Seeded jitter so output is reproducible.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const jitter = (v) => Math.round((v + (rand() * 4 - 2)) * 10) / 10;

const rect = (x0, z0, x1, z1) => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
];

const ftIn = (m) => {
  const inches = Math.round(m * 39.3701);
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
};
const dimText = (w, d) => `${w.toFixed(2)}m x ${d.toFixed(2)}m (${ftIn(w)} x ${ftIn(d)})`;

const levels = [
  {
    id: 'L0',
    index: 0,
    name: 'Ground Floor',
    planMediaId: 'media-plan-ground',
    file: 'plan-ground.svg',
    rooms: [
      { id: 'L0-hall', label: 'Entrance Hall', type: 'hall', poly: rect(0, 0, 1.8, 4.2), dims: false },
      { id: 'L0-living', label: 'Living Room', type: 'living', poly: rect(1.8, 0, 9.0, 4.2), dims: true },
      { id: 'L0-utility', label: 'Utility / WC', type: 'utility', poly: rect(0, 4.2, 1.8, 7.6), dims: true },
      { id: 'L0-kitchen', label: 'Kitchen / Diner', type: 'kitchen', poly: rect(1.8, 4.2, 9.0, 7.6), dims: true },
    ],
    openings: [
      { id: 'L0-d-front', type: 'door', at: [0.9, 0], w: 0.9, rooms: ['L0-hall'] },
      { id: 'L0-d-hall-living', type: 'door', at: [1.8, 2.6], w: 0.8, rooms: ['L0-hall', 'L0-living'] },
      { id: 'L0-d-hall-utility', type: 'door', at: [0.9, 4.2], w: 0.75, rooms: ['L0-hall', 'L0-utility'] },
      { id: 'L0-a-living-kitchen', type: 'archway', at: [5.0, 4.2], w: 1.6, rooms: ['L0-living', 'L0-kitchen'] },
      { id: 'L0-d-back', type: 'door', at: [8.2, 7.6], w: 0.9, rooms: ['L0-kitchen'] },
      { id: 'L0-win-living', type: 'window', at: [5.4, 0], w: 2.4, rooms: ['L0-living'] },
      { id: 'L0-win-kitchen', type: 'window', at: [5.0, 7.6], w: 1.8, rooms: ['L0-kitchen'] },
      { id: 'L0-win-kitchen-side', type: 'window', at: [9.0, 5.9], w: 1.2, rooms: ['L0-kitchen'] },
      { id: 'L0-win-utility', type: 'window', at: [0.9, 7.6], w: 0.6, rooms: ['L0-utility'] },
    ],
    stairs: [{ id: 'L0-stairs', poly: rect(0.95, 1.2, 1.75, 4.15), to: 'L1' }],
  },
  {
    id: 'L1',
    index: 1,
    name: 'First Floor',
    planMediaId: 'media-plan-first',
    file: 'plan-first.svg',
    rooms: [
      {
        id: 'L1-landing',
        label: 'Landing',
        type: 'landing',
        poly: [
          [0, 0],
          [1.8, 0],
          [1.8, 3.2],
          [7.0, 3.2],
          [7.0, 4.2],
          [0, 4.2],
        ],
        dims: false,
      },
      { id: 'L1-bed1', label: 'Bedroom 1', type: 'bedroom', poly: rect(1.8, 0, 5.0, 3.2), dims: true },
      {
        id: 'L1-bed2',
        label: 'Bedroom 2',
        type: 'bedroom',
        poly: [
          [5.0, 0],
          [9.0, 0],
          [9.0, 4.2],
          [7.0, 4.2],
          [7.0, 3.2],
          [5.0, 3.2],
        ],
        dims: true,
        dimsOverride: [4.0, 4.2],
      },
      { id: 'L1-bath', label: 'Bathroom', type: 'bathroom', poly: rect(0, 4.2, 3.4, 7.6), dims: true },
      { id: 'L1-bed3', label: 'Bedroom 3', type: 'bedroom', poly: rect(3.4, 4.2, 9.0, 7.6), dims: true },
    ],
    openings: [
      { id: 'L1-d-bed1', type: 'door', at: [3.0, 3.2], w: 0.8, rooms: ['L1-landing', 'L1-bed1'] },
      { id: 'L1-d-bed2', type: 'door', at: [6.0, 3.2], w: 0.8, rooms: ['L1-landing', 'L1-bed2'] },
      { id: 'L1-d-bath', type: 'door', at: [2.4, 4.2], w: 0.75, rooms: ['L1-landing', 'L1-bath'] },
      { id: 'L1-d-bed3', type: 'door', at: [5.0, 4.2], w: 0.8, rooms: ['L1-landing', 'L1-bed3'] },
      { id: 'L1-win-bed1', type: 'window', at: [3.4, 0], w: 1.4, rooms: ['L1-bed1'] },
      { id: 'L1-win-bed2', type: 'window', at: [7.0, 0], w: 1.6, rooms: ['L1-bed2'] },
      { id: 'L1-win-bath', type: 'window', at: [1.7, 7.6], w: 0.8, rooms: ['L1-bath'] },
      { id: 'L1-win-bed3', type: 'window', at: [6.2, 7.6], w: 1.8, rooms: ['L1-bed3'] },
      { id: 'L1-win-landing', type: 'window', at: [0.0, 1.0], w: 0.8, rooms: ['L1-landing'] },
    ],
    stairs: [],
  },
];

// ---------------------------------------------------------------------------
// SVG drawing (estate-agent style, black-on-white)
// ---------------------------------------------------------------------------

function drawSvg(level) {
  const W = px(9.0) + ORIGIN;
  const H = px(7.6) + ORIGIN + 40;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  for (const r of level.rooms) {
    const pts = r.poly.map(([x, z]) => `${px(x)},${px(z)}`).join(' ');
    out.push(`<polygon points="${pts}" fill="#f4f4f4" stroke="#111" stroke-width="5" stroke-linejoin="miter"/>`);
  }
  for (const st of level.stairs) {
    const [x0, z0] = st.poly[0];
    const [x1, z1] = st.poly[2];
    out.push(`<rect x="${px(x0)}" y="${px(z0)}" width="${(x1 - x0) * PX_PER_M}" height="${(z1 - z0) * PX_PER_M}" fill="none" stroke="#111" stroke-width="1.5"/>`);
    for (let z = z0 + 0.25; z < z1; z += 0.25) out.push(`<line x1="${px(x0)}" y1="${px(z)}" x2="${px(x1)}" y2="${px(z)}" stroke="#111" stroke-width="1"/>`);
    out.push(`<text x="${px((x0 + x1) / 2)}" y="${px(z1) - 6}" font-size="10" text-anchor="middle">UP</text>`);
  }
  for (const o of level.openings) {
    const [x, z] = o.at;
    const horizontal = level.rooms.some((r) =>
      r.poly.some((p, i) => {
        const q = r.poly[(i + 1) % r.poly.length];
        return p[1] === q[1] && p[1] === z && Math.min(p[0], q[0]) <= x && x <= Math.max(p[0], q[0]);
      }),
    );
    const hw = (o.w / 2) * PX_PER_M;
    const [cx, cy] = [px(x), px(z)];
    const [ax, ay, bx, by] = horizontal ? [cx - hw, cy, cx + hw, cy] : [cx, cy - hw, cx, cy + hw];
    if (o.type === 'window') {
      out.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#ffffff" stroke-width="5"/>`);
      const off = horizontal ? [0, 2.5] : [2.5, 0];
      for (const s of [-1, 1]) out.push(`<line x1="${ax + off[0] * s}" y1="${ay + off[1] * s}" x2="${bx + off[0] * s}" y2="${by + off[1] * s}" stroke="#111" stroke-width="1.2"/>`);
    } else {
      out.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#f4f4f4" stroke-width="6"/>`);
      if (o.type === 'door') {
        const r = o.w * PX_PER_M;
        const sweep = horizontal ? `M ${ax} ${ay} L ${ax} ${ay + r} A ${r} ${r} 0 0 0 ${bx} ${by}` : `M ${ax} ${ay} L ${ax + r} ${ay} A ${r} ${r} 0 0 1 ${bx} ${by}`;
        out.push(`<path d="${sweep}" fill="none" stroke="#777" stroke-width="1"/>`);
      }
    }
  }
  for (const r of level.rooms) {
    const xs = r.poly.map((p) => p[0]);
    const zs = r.poly.map((p) => p[1]);
    const cx = r.id === 'L1-landing' ? px(0.9) : r.id === 'L1-bed2' ? px(7.0) : px((Math.min(...xs) + Math.max(...xs)) / 2);
    const cy = r.id === 'L1-landing' ? px(0.6) : r.id === 'L1-bed2' ? px(1.5) : px((Math.min(...zs) + Math.max(...zs)) / 2);
    const lines = r.id === 'L0-hall' || r.id === 'L1-landing' ? r.label.split(' ') : [r.label];
    lines.forEach((ln, i) => out.push(`<text x="${cx}" y="${cy + i * 14}" font-size="13" font-weight="700" text-anchor="middle">${ln.toUpperCase()}</text>`));
    if (r.dims) {
      const [w, d] = r.dimsOverride ?? [Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)];
      out.push(`<text x="${cx}" y="${cy + 16}" font-size="10" text-anchor="middle">${w.toFixed(2)}m x ${d.toFixed(2)}m</text>`);
      out.push(`<text x="${cx}" y="${cy + 29}" font-size="10" text-anchor="middle">${ftIn(w)} x ${ftIn(d)}</text>`);
    }
  }
  out.push(`<text x="${ORIGIN}" y="${H - 18}" font-size="14" font-weight="700">${level.name.toUpperCase()}</text>`);
  out.push(`<text x="${W - ORIGIN}" y="${H - 18}" font-size="10" text-anchor="end">Demo property drawn by Shroozy for testing. Not to scale unless dimensioned.</text>`);
  out.push(`</svg>`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Reference interpretation (same schema as the Muse Spark parser output)
// ---------------------------------------------------------------------------

const interpretation = {
  levels: levels.map((l) => ({
    id: l.id,
    index: l.index,
    name: l.name,
    planMediaId: l.planMediaId,
    ceilingHeightMeters: null,
    rooms: l.rooms.map((r) => {
      const xs = r.poly.map((p) => p[0]);
      const zs = r.poly.map((p) => p[1]);
      const [w, d] = r.dimsOverride ?? [Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)];
      return {
        id: r.id,
        label: r.label,
        type: r.type,
        polygonPx: r.poly.map(([x, z]) => [jitter(px(x)), jitter(px(z))]),
        measured: r.dims ? { text: dimText(w, d), widthM: w, depthM: d } : null,
        confidence: r.dims ? 0.9 : 0.75,
      };
    }),
    openings: l.openings.map((o) => ({
      id: o.id,
      type: o.type,
      atPx: [jitter(px(o.at[0])), jitter(px(o.at[1]))],
      widthPx: Math.round(o.w * PX_PER_M),
      roomIds: o.rooms,
      confidence: 0.85,
    })),
    stairs: l.stairs.map((s) => ({
      id: s.id,
      polygonPx: s.poly.map(([x, z]) => [jitter(px(x)), jitter(px(z))]),
      toLevelId: s.to,
      confidence: 0.8,
    })),
  })),
  statedTotalAreaSqM: null,
  uncertainties: [
    'Ceiling heights are not printed on the plan.',
    'Entrance hall and landing have no printed dimensions.',
    'Bedroom 2 dimensions are printed as overall width x depth of an L-shaped room.',
  ],
  provenance: {
    method: 'fixture:hand-authored',
    note: 'Reference reading of the project-drawn plan with simulated ±2px read noise. Stands in for Muse Spark output when MODEL_API_KEY is not configured.',
    at: '2026-10-28T00:00:00.000Z',
  },
};

for (const l of levels) writeFileSync(join(here, l.file), drawSvg(l) + '\n');
writeFileSync(join(here, 'interpretation.fixture.json'), JSON.stringify(interpretation, null, 2) + '\n');
console.log('wrote', levels.map((l) => l.file).join(', '), 'and interpretation.fixture.json');
