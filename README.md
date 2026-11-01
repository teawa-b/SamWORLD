# WalkIn

_Working name: `walk-in`. A Shroozy project._

Turns a property listing's **floor plan, photos and video** into a labelled 3D
home you can explore in a desktop browser and in **Meta Quest Browser (WebXR)**:
grab and scale the dollhouse, lift floors off, pull walls away, then step into
a room at 1:1 scale.

- **Frontend:** TypeScript, Vite, Meta **Immersive Web SDK** (`@iwsdk/core` 1.0.1), Three.js, UIKitML.
- **Backend:** TypeScript, Fastify, persistent job runner.
- **AI (primary):** Meta Model API — **Muse Spark 1.3** (plan reading, photo matching, placement suggestions, verification), optional **Muse Wonder 1.0** escalation, **SAM 3.1** segmentation, **Muse Image 1.0** redesign concepts.
- **Optional:** SAM 3D Objects on a Modal GPU worker (off by default).

When a listing has a floor plan, it is the source of truth for layout. When
it doesn't, WalkIn still builds the home: it looks for a plan among the photos,
and otherwise Muse reads the room list from the photos (or WalkIn derives it
from the bedrooms, bathrooms and area) and arranges a believable estimated
layout. Photos supply appearance and evidence. Everything inferred is flagged
as estimated in the UI and in the saved scene.

## Main journey (desktop browser)

1. **Import**: paste a public listing URL, drop photos and floor plans, or paste image URLs. Every source goes through the same backend import API (`backend/src/routes-import.ts`), which a future browser extension can call too.
2. **Review media**: include/exclude images, mark floor plans, label rooms (photos with the same label are treated as one room), reorder, and optionally ask Muse for room suggestions (shown, never auto-applied).
3. **Floor plan**: with `MODEL_API_KEY`, Muse reads it. Without a key (or to fix Muse's reading), the **plan editor** lets you trace rooms, doors, windows and stairs over the plan image and enter printed sizes for scale. No AI is needed for a plan-accurate 3D shell.
4. **Generate**: the progress screen shows each stage as done, skipped (with the reason) or failed.
5. **Explore**: dollhouse (roof off, framed on open) and walkthrough (WASD/drag, wall collision), floor-plan mini-map with your position, source-photo viewer with "view this room in 3D", click furniture to move/turn/hide/remove (saved without a rebuild), and per-object SAM 3D reconstruction when enabled.

The VR button is hidden unless the frontend is built with `VITE_ENABLE_XR=true`; the WebXR systems are kept.

## What works today, and what is simulated

| Area | Status |
| --- | --- |
| Import: uploads (JPG/PNG/WebP, type-sniffed, size/integrity checked, de-duplicated), image URLs, listing URLs (robots.txt honoured, SSRF-guarded, generic + site adapters) | **Working**, integration-tested. Listing-URL extraction tested against sample HTML only: the dev sandbox has no internet access |
| Review screen, plan editor, honest progress steps, furniture editing, photo viewer, mini-map | **Working**, clicked through in headless Chromium on desktop |
| Plan → structure (scale from printed dimensions, walls from room polygons, door/window gaps, stairs, roof) | **Working**, deterministic, unit-tested; a hand-traced plan builds with 0 AI calls |
| Muse Spark plan reading / photo matching / finishes / placement / review; SAM 3.1 segmentation | **Running on the deployed backend** (Railway logs, Oct 2026: e.g. 49 Meta calls, 50 SAM 3.1 detections per build). New this round: user room labels are passed to Muse as hints, and a review-time image classifier; those two prompts have **not yet run live** |
| SAM 3D Objects | **Adapter built and tested against a local fake worker only.** Providers: the Modal worker in `worker-3d/` (never deployed) or fal.ai `fal-ai/sam-3/3d-objects` (field names partly unverified: see `docs/modal-sam3d.md`). Splat PLY output is drawn as a point cloud and labelled as a splat |
| Furniture | Proxy shapes, labelled by evidence: seen in a photo / typical, not seen / SAM 3D |
| Demo property | Project-drawn plans (fictional address), no real photos |

## Quick start

`frontend/` and `backend/` are separate apps with their own `package.json`,
lockfile and deployment. Install and run each one:

```bash
cd backend && npm install
cp .env.example .env            # optional; add MODEL_API_KEY for live Meta inference
npm run dev                     # http://localhost:8787

cd ../frontend && npm install
npm run dev:runtime             # https://localhost:8081 (self-signed; Vite proxies /api to :8787)
```

From the repo root, `npm run install:all`, `npm run dev:backend` and
`npm run dev:frontend` do the same.

Open https://localhost:8081. The home screen is the import screen: add photos and a floor plan (or open the demo home), review them, trace the plan if no AI key is set, and click **Generate 3D**. The map of live listings is still available from the link at the bottom (needs `REALTYAPI_KEY`). On localhost the IWSDK dev plugin also injects the IWER XR emulator ("Enter XR" pill); that is a dev-only overlay.

To try it without any keys: upload a floor plan image plus a few room photos, mark the plan on the review screen, click **Trace floor plan**, draw the rooms (enter the printed size of at least one room for scale), add doors, then **Save and build 3D**.

To run the reconstruction once and bake static scenes (the viewer then works
without the API, e.g. on static hosting):

```bash
cd backend && npm run bake      # writes ../frontend/public/cached/ (or BAKE_OUT_DIR)
```

### Controls

| Action | Desktop | Quest |
| --- | --- | --- |
| Orbit / zoom | drag / scroll | — |
| Move, rotate, scale house | — | squeeze both hands on the plinth |
| Separate floors | `1` or button | squeeze a blue knob and lift, or menu |
| Roof | `H` | red knob or menu |
| Hide all walls / pull one wall | `W` / `P`, then click a wall | menu / trigger on a wall |
| Empty rooms, night, evidence colours | `F`, `N`, `V` | menu |
| Select / enter a room | click its floor, then `E` | trigger on the floor, then **Enter room** |
| Select furniture | click it; arrows move 10 cm (Shift 50 cm), `[` `]` turn | — |
| Walk | tap/click a white circle to move, drag to look, `WASD` on desktop | trigger on a circle, left stick move, right stick snap turn |
| Back to dollhouse | `Esc` | menu |
| Reset | `R` | menu |

## Repository layout

```text
frontend/       Deployable web app (IWSDK + Vite): scene builder, dollhouse/walkthrough/menu systems, 2D UI
  src/shared/   Synced copy of backend/src/shared (do not edit here)
backend/        Deployable API + job worker (Fastify), Meta adapters, providers, bake script, tests
  src/shared/   Source of truth: Zod contracts, plan→structure geometry, placement, verification
  fixtures/     Project-owned demo property (plan SVG/PNG, reference interpretation, placements)
  Dockerfile    Container image for the backend
worker-3d/      Optional SAM 3D Objects worker for Modal (not deployed)
scripts/        sync-shared.mjs: copies backend/src/shared to the frontend (--check for CI)
db/             Supabase/Postgres schema for when the JSON store is replaced
docs/           Meta API notes, Modal runbook, RealtyAPI, deployment, data rights
```

Shared contracts are edited in `backend/src/shared/` and copied with
`npm run sync-shared`. `npm test` at the root fails if the copies drift.

## Pipeline

1. **Ingest** the listing, keeping provenance and usage rights. Media marked `unverified` is never sent to a model.
2. **Layout**: with a plan, Muse Spark returns room polygons (plan pixels), printed dimensions, doors, windows and stairs as schema-constrained JSON. Without a plan, Muse checks the photos for one and otherwise lists the rooms it can see; a deterministic packer turns that list (or one derived from the listing facts) into an estimated plan. Without a key, the demo uses its reference interpretation.
3. **Build the structure**: deterministic. Scale comes from printed dimensions (median across rooms), noisy vertices are aligned, walls are derived from shared room edges, openings become real gaps, and floors stack with an estimated 2.4 m ceiling when none is printed. The shell is published straight away.
4. **Match photos to rooms** (Muse), then **read each photographed room's wall and floor finish** (colour, material and a clean patch to sample for textures). Manual assignments override the matching.
5. **Segment** matched photos with SAM 3.1, one noun phrase per request, decoded by `@meta-sam/parser`.
6. **Place furniture**: Muse suggests relationships ("against the north wall, 30% along") from the photos and SAM detections; for rooms without photos, Muse proposes typical furniture, labelled as not observed. The placement engine turns them into coordinates, rejecting anything outside the room, blocking a doorway or overlapping. Walls never move.
7. **Verify**: geometry checks (closure, overlaps, printed dimensions within 5%, area against the listing, connectivity, collisions), then a Muse review against the plan.
8. **Export** a versioned scene manifest. Loading it needs no AI calls.

Each run is capped at `AI_MAX_CALLS_PER_RUN`, and every call has a timeout and bounded retries. Plan readings are cached, so corrections rebuild without re-reading the plan.

## Tests

```bash
cd backend && npm test      # geometry/placement + API integration (offline and fake-Meta live path)
npm run typecheck           # in either folder
```

## Docs

- `docs/meta-model-api.md`: every model call, request shape, prompt version and cost guard
- `docs/modal-sam3d.md`: SAM 3D on Modal: licence, billing checks, deploy and shut-off
- `docs/realtyapi.md`: how to connect live listings without guessing endpoints
- `docs/deployment.md`: HTTPS hosting and Quest testing
- `docs/data-and-rights.md`: data sources, attribution and limits

## Attribution

- Immersive Web SDK, Three.js (super-three), UIKit (pmndrs): see their licences in `node_modules`.
- `@meta-sam/parser` and the request patterns in `backend/src/meta/` follow Meta's `meta-model-cookbook`.
- Demo floor plans were drawn for this project. The address and figures are fictional.
