# WalkIn — project status and next steps

Snapshot for picking the work up in a new session. Repo: `teawa-b/viewin`, branch `main` (default).
Commits are authored as `teawa-b <bdbakre@gmail.com>`; keep the repo free of any AI-assistant credit lines.

## What WalkIn is

Turns a real property listing (photos, floor plan if any, details) into a labelled 3D home you can
explore on desktop, phone and Meta Quest (WebXR via Meta IWSDK): dollhouse view, lift floors off,
pull walls away, walk inside with tap-to-move points (no joystick on mobile). The home screen is a
MapLibre globe showing listings near you. **All AI is Meta models** (no other providers):

| Step | Model |
| --- | --- |
| Read floor plan / find a plan among photos / infer room list from photos | Muse Spark 1.3 (Muse Wonder 1.0 optional escalation) |
| Match photos to rooms, read wall/floor finishes (textures cropped from the real photos) | Muse Spark |
| Find objects in photos | SAM 3.1 (Responses API + `@meta-sam/parser`) |
| Furniture placement (from photos, and "typical, not observed" pieces for unphotographed rooms) | Muse Spark, then a deterministic placement engine (inside room, doors clear, no overlaps) |
| Review | Muse Spark (only when a plan exists) + deterministic geometry checks |
| Redesign concepts | Muse Image 1.0 (off unless `REDESIGN_ENABLED=true`) |
| 3D objects (optional) | SAM 3D on the owner's Modal endpoint (`worker-3d/`, needs an approve switch in the UI — not built yet) |

Listings: RealtyAPI — Rightmove for the UK, Realtor.com for the US; the globe shows only homes with a floor plan (Zoopla and Zillow are import-only) (`backend/src/providers/realtyapi.ts`, `docs/realtyapi.md`).

## Layout of the repo

- `frontend/` — Vite + IWSDK app (separate Railway service). `src/ui/panel.ts` (2D UI: discover → listing → processing → explore), `src/ui/globe.ts`, `src/scene/*` (builder, materials, furniture proxies), `src/systems/*` (dollhouse, walkthrough, menu). `src/shared/` is a synced copy — never edit it there.
- `backend/` — Fastify API + inline job worker (separate Railway service, Dockerfile). `src/jobs/pipeline.ts` is the whole reconstruction pipeline; `src/meta/*` are the Meta adapters (`muse.ts`, `sam.ts`, `image.ts`, `client.ts`, `models.ts`); `src/shared/` is the source of truth for schemas, geometry, placement, verification, viewpoints, estimated layouts (`layout.ts`), typical furniture (`typical.ts`).
- `npm run sync-shared` (root) copies `backend/src/shared` → `frontend/src/shared`; `npm test` fails if they drift.
- Tests: `cd backend && npm test` (31 passing: geometry, placement, layout, model resolution, API, fake-Meta live path). `npm run typecheck` in either folder.
- Docs: `docs/meta-model-api.md` (every model call + prompt version), `docs/deployment.md`, `docs/realtyapi.md`, `docs/modal-sam3d.md`, `docs/data-and-rights.md`.

## Deployment (Railway)

- Project id `c1403d6e-13c9-49ed-9295-5dc5d63335f4`; services `backend` (`7f5ecc53-…`, root `/backend`, **region US West** — keep it there) and `frontend` (`978ed381-…`, root `/frontend`). Both auto-deploy from `main`.
- Backend URL `backend-production-0e42e.up.railway.app`; `/health` shows capabilities and `metaModels` (models the key can use).
- Backend env (set by the owner): `MODEL_API_KEY`, `REALTYAPI_KEY`, `MODAL_ENDPOINT_URL`, `MODAL_AUTH_SECRET`, `SAM3D_ENABLED`, `DATA_DIR=/data` (volume), etc. Tunables: `MUSE_REASONING_EFFORT` (default `low`), `AI_MAX_CALLS_PER_RUN` (120), `SAM_MAX_IMAGES_PER_RUN` (12), `SAM_MAX_CONCEPTS_PER_IMAGE` (6).
- Job logs are printed to stdout as `[job <id>] <step>: <message>` — read them with Railway logs.
- The dev sandbox could not reach `api.meta.ai`, RealtyAPI or the Railway backend directly; live behaviour was verified only via Railway logs and the owner's phone.

## History worth knowing

- Meta returned `404 model_not_found` for every model until the key's access switched on (around the move to US West). `src/meta/models.ts` now lists models at startup and before each job, falls back to the newest model of the same family, and probes documented Muse Spark IDs if the list is empty.
- First successful live build (Zoopla listing, 9 photos, no floor plan) took ~5½ min, 32 Meta calls. Since then: room placement and finishes run in parallel, reasoning effort is low for perception steps, SAM is asked about everything Muse saw (not a fixed list), estimated layouts put front/rear rooms on the right side. **These changes are deployed but not yet tested on a real build.**
- Floor plans are optional: plan → plan found among photos → room list from photos (Muse) → room list from listing facts. Estimated layouts are flagged everywhere (badge, "Layout from" row). Without a plan, room *positions* are a guess by design.

## Owner feedback on the latest build

- SAM seemed to capture only one object per photo (fixed in code: concept list now comes from Muse's per-photo object list; the "50%" was a placeholder for a missing SAM score, now hidden).
- Layout "extremely inaccurate", furniture positions inaccurate.
- Too slow.
- Wants the AI to be smarter: iterate over the images a few times, check its work, and show a **side-by-side comparison** of photos vs the model.

## Agreed next step (proposed, awaiting go-ahead)

**Render-and-compare refinement loop, running in the background after the first model is shown:**

1. First pass as now; the scene is published so the user can explore immediately.
2. For each photographed room, draw a labelled top-down diagram server-side (walls, doors, windows, every placed item with its label) and send it with 2–3 of the room's photos to Muse: "does this match; list missing / misplaced / wrong-size items as concrete fixes" (same relationship format as placement: wall side + `along`, sizes in metres).
3. Apply fixes through the placement engine (walls never move, doors stay clear), publish a new scene version, repeat — max 2 rounds per room, stop early when Muse says it matches. Rooms in parallel (3 at a time). UI shows "Refining… round 1 of 2" and the model updates live.
4. New **"Photo vs model"** view: each listing photo next to a render of the 3D room from the estimated camera position (Muse estimates where the photographer stood and which way they faced); show before/after per round.
5. For the demo video, prefer listings **with** a floor plan; consider a "Floor plan" badge on the globe's listing cards.

Other open items: SAM 3D approve switch in the UI; Muse review for photo-only layouts (currently skipped without a plan).
