# Shroozy PropertyXR (working name)

Turns a property listing's **floor plan, photos and video** into a labelled 3D
home you can explore in a desktop browser and in **Meta Quest Browser (WebXR)**:
grab and scale the dollhouse, lift floors off, pull walls away, then step into
a room at 1:1 scale.

- **Frontend:** TypeScript, Vite, Meta **Immersive Web SDK** (`@iwsdk/core` 1.0.1), Three.js, UIKitML.
- **Backend:** TypeScript, Fastify, persistent job runner.
- **AI (primary):** Meta Model API — **Muse Spark 1.3** (plan reading, photo matching, placement suggestions, verification), optional **Muse Wonder 1.0** escalation, **SAM 3.1** segmentation, **Muse Image 1.0** redesign concepts.
- **Optional:** SAM 3D Objects on a Modal GPU worker (off by default).

The floor plan is the source of truth for layout. Photos supply appearance and
evidence. Everything inferred is flagged as estimated in the UI and in the
saved scene.

## What works today, and what is simulated

This was built in a sandbox with **no Meta API key and no network access to
`api.meta.ai`**, so no live Meta inference has run yet. The live code paths
follow Meta's official cookbook and are covered by a test against a local fake
endpoint, but they still need a first real run with your key.

| Area | Status |
| --- | --- |
| IWSDK app: desktop 3D, dollhouse, floor separation, roof, wall pull-out, reset, day/night, empty rooms, evidence colours | **Working** (checked in headless Chromium) |
| Walkthrough: enter a room at 1:1, wall collision, open doorways, up/down stairs | **Working** on desktop. XR thumbstick locomotion is written but **not tested on a headset** |
| WebXR session + in-headset menu | **Working in the IWER emulator**. Hand/controller grab of the plinth and lift handles is **not yet tested on a real Quest** |
| Plan → structure (scale from printed dimensions, walls from room polygons, door/window gaps, stairs, roof) | **Working**, deterministic, unit-tested |
| Placement engine (containment, doorway clearance, collisions) and geometry verification | **Working**, unit-tested |
| Job pipeline, persistence, caching, corrections, shell-first preview | **Working**, integration-tested |
| Muse Spark plan parsing / photo matching / placement / verification pass | **Implemented, not yet run against the real API** (needs `MODEL_API_KEY`) |
| SAM 3.1 segmentation (via `@meta-sam/parser`) | **Implemented, not yet run against the real API** |
| Muse Image redesign | **Implemented, not yet run against the real API** (off unless `REDESIGN_ENABLED=true`) |
| Demo property | **Project-drawn** two-storey plan (fictional address). The plan reading comes from a **hand-authored reference interpretation** labelled `fixture:hand-authored`. **No photos are included** |
| Furniture | **Proxy shapes** from hand-authored placement suggestions, labelled as such. With a key and photos, suggestions come from Muse + SAM |
| RealtyAPI live listings | **Not connected.** Adapter reports what is missing; endpoints must be verified first (see `docs/realtyapi.md`) |
| SAM 3D Objects on Modal | **Scaffold only, never deployed.** Off by default; app works fully without it |
| Supabase / R2 | Not wired up. A JSON-file job table is used (allowed for the prototype); `db/schema.sql` has the Postgres tables |
| Hosting / live URL | **Not deployed yet.** See `docs/deployment.md` |

Screenshots from headless Chromium (desktop) and the IWER emulator (XR):
`docs/screenshots/`.

## Quick start

```bash
npm install
cp .env.example api/.env        # optional; add MODEL_API_KEY for live Meta inference
npm run dev:api                 # http://localhost:8787
npm run dev:web                 # https://localhost:8081 (self-signed; Vite proxies /api)
```

Open https://localhost:8081, search "example", choose the listing, and click
**Explore in 3D**. On localhost the IWSDK dev plugin injects the IWER XR
emulator so you can try **Enter XR** without a headset.

To run the reconstruction once and bake static scenes (the viewer then works
without the API, e.g. on static hosting):

```bash
npm run fixture:bake            # writes app-web/public/cached/
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
| Walk | drag to look, `WASD` | left stick move, right stick snap turn |
| Back to dollhouse | `Esc` | menu |
| Reset | `R` | menu |

## Repository layout

```text
shared/         Zod data contracts, plan→structure geometry, placement engine, verification (+ tests)
api/            Fastify API, job runner, Meta adapters, fixture + RealtyAPI providers, bake script (+ tests)
app-web/        IWSDK + Vite app: scene builder, dollhouse/walkthrough/menu systems, 2D UI
worker-3d/      Optional SAM 3D Objects worker for Modal (not deployed)
test-fixtures/  Project-owned demo property (plan SVG/PNG, reference interpretation, placements)
db/             Supabase/Postgres schema for when the JSON store is replaced
docs/           Meta API notes, Modal runbook, RealtyAPI, deployment, data rights
```

## Pipeline

1. **Ingest** the listing, keeping provenance and usage rights. Media marked `unverified` is never sent to a model.
2. **Parse the plan**: Muse Spark returns room polygons (plan pixels), printed dimensions, doors, windows and stairs as schema-constrained JSON. Without a key, the demo uses its reference interpretation.
3. **Build the structure**: deterministic. Scale comes from printed dimensions (median across rooms), noisy vertices are aligned, walls are derived from shared room edges, openings become real gaps, and floors stack with an estimated 2.4 m ceiling when none is printed. The shell is published straight away.
4. **Match photos to rooms** (Muse). Manual assignments override it.
5. **Segment** matched photos with SAM 3.1, one noun phrase per request, decoded by `@meta-sam/parser`.
6. **Place furniture**: Muse suggests relationships ("against the north wall, 30% along"), and the placement engine turns them into coordinates, rejecting anything outside the room, blocking a doorway or overlapping. Walls never move.
7. **Verify**: geometry checks (closure, overlaps, printed dimensions within 5%, area against the listing, connectivity, collisions), then a Muse review against the plan.
8. **Export** a versioned scene manifest. Loading it needs no AI calls.

Each run is capped at `AI_MAX_CALLS_PER_RUN`, and every call has a timeout and bounded retries. Plan readings are cached, so corrections rebuild without re-reading the plan.

## Tests

```bash
npm test          # shared geometry/placement + API integration (offline and fake-Meta live path)
npm run typecheck
```

## Docs

- `docs/meta-model-api.md`: every model call, request shape, prompt version and cost guard
- `docs/modal-sam3d.md`: SAM 3D on Modal: licence, billing checks, deploy and shut-off
- `docs/realtyapi.md`: how to connect live listings without guessing endpoints
- `docs/deployment.md`: HTTPS hosting and Quest testing
- `docs/data-and-rights.md`: data sources, attribution and limits

## Attribution

- Immersive Web SDK, Three.js (super-three), UIKit (pmndrs): see their licences in `node_modules`.
- `@meta-sam/parser` and the request patterns in `api/src/meta/` follow Meta's `meta-model-cookbook`.
- Demo floor plans were drawn for this project. The address and figures are fictional.
