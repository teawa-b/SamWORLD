# SamWORLD — type a world, and your room becomes it

_Working title. Built on the ViewIn/WalkIn codebase for the Meta Global AI Developer Hackathon (indie track: judged on creativity, technical ambition, and whether it works). Submissions due **Wed 4 Nov 2026, 9:00 PM ET**._

## The idea in one paragraph

Film a 30-second walk around your room on your phone. SamWORLD rebuilds it in 3D at real scale with Meta's **MapAnything**, understands what everything is with **SAM 3.1** and **Muse Spark**, and waits. You type a world — _"haunted Victorian library"_, _"underwater coral cave"_, _"1970s Tokyo arcade"_. **Muse Spark** turns that into a plan for every surface and object in _your_ room; **Muse Image** paints the new walls, floor and ceiling and restyles each piece of your furniture; **SAM 3D** turns each restyled piece into a real 3D object standing exactly where your real one stands. Then the room transforms around you — in the browser or at 1:1 on a **Meta Quest** — the paint spreading across your actual walls as each part arrives. Your sofa becomes a chesterfield; your bookcase becomes coral.

Why it matters for judging: every Meta model has a visible, essential job (MapAnything → geometry, SAM 3.1 → objects, Muse Spark → reasoning and planning, Muse Image → generation, SAM 3D → objects in 3D, Quest/IWSDK → being inside it). One-sentence pitch, one "wow" moment, works on any room.

## What the user does (demo script, ~2 min)

1. Opens SamWORLD on a phone or laptop, uploads a 20–40 s walk-around video of a room (or ~20 photos).
2. ~1 minute later: a 3D model of _their_ room, objects outlined and named ("sofa", "bookshelf", "rug", "window", "wall", "floor").
3. Types a prompt. Optionally taps an object and adds a note ("make the TV a fish tank").
4. Watches the room repaint: walls and floor fill in surface by surface, each piece of furniture dissolves into its new version as SAM 3D returns it.
5. Walks through it (WASD / tap-to-move), or presses **Enter VR** on Quest and stands in it at 1:1.
6. Tries another prompt; the scan is cached, so only the paint step reruns.

## Pipeline

```
video ─► frames (browser) ─► [1 SCAN] MapAnything (Modal GPU) ─► cameras + metric point cloud + per-frame depth
                                   │
                                   ▼
                           [2 STRUCTURE] fit floor plane, ceiling, wall planes (RANSAC on points) ─► room shell (metres)
                                   │
                                   ▼
                           [3 UNDERSTAND] SAM 3.1 on keyframes ─► masks ─► lifted into 3D via depth + camera ─► objects
                                          Muse Spark names/merges objects across frames, picks the best crop of each
                                   │
              prompt ─────────────►▼
                           [4 PLAN]  Muse Spark: per surface + per object restyle instructions (JSON)
                                   │
                                   ▼
                           [5 PAINT] Muse Image: seamless textures for walls / floor / ceiling
                                     Muse Image: restyle each object crop (image-to-image)
                                     SAM 3D (fal): restyled crop ─► textured GLB, scaled to the object's real size
                                   │
                                   ▼
                           [6 REVEAL] viewer swaps textures + objects progressively ("paint spreads")
```

### 1. Scan — MapAnything (Meta, Apache 2.0)
- **Why MapAnything over VGGT:** metric output (metres), so the virtual room is the size of the real one — essential for 1:1 on Quest; Apache 2.0 weights, no gating. VGGT stays as a drop-in fallback behind the same worker interface.
- **Input:** 20–60 frames (browser extracts ~1.5 fps from the video, max 1024 px, JPEG).
- **Output:** per frame: camera pose (world-from-camera), intrinsics, depth map; fused coloured point cloud (downsampled to ~300k points), all in metres, y-up.
- **Where it runs:** Modal, one GPU (A10G/L4 to start; A100 if memory demands), `max_containers=1`, scales to zero, bearer-token auth, results cached by content hash. File: `worker-3d/mapanything_app.py`.
- **Speed (estimate, to be measured):** seconds of GPU per scan; 30–90 s cold start.

### 2. Structure — deterministic, no AI
- Floor = dominant horizontal plane low in the cloud; ceiling = dominant horizontal plane high; walls = vertical planes (RANSAC), intersected into a room polygon on the floor.
- Gives the surfaces we repaint and the collision walls for walkthrough. Points not on the shell are "stuff" (furniture).
- Fallback if plane fitting fails: render the raw point cloud and repaint by vertex colour regions (less magical, still works).

### 3. Understand — SAM 3.1 + Muse Spark
- Pick 6–10 keyframes covering the room. Muse Spark lists what it sees in each (reuse of the existing photo-object prompt); SAM 3.1 segments each noun (existing `segmentConcept`).
- Each mask + that frame's depth + camera → a 3D point set → oriented box (position, size, yaw) in the room. Same object seen in several frames → merged by 3D overlap.
- Muse Spark picks the clearest crop of each object (for restyling) and labels it.

### 4. Plan — Muse Spark
- Input: the prompt, the room (dimensions, surfaces), the object list (labels, sizes), a couple of keyframes.
- Output (schema-constrained JSON): a style brief; per surface (walls, floor, ceiling) a texture prompt; per object a restyle instruction that keeps its role and footprint ("sofa → green leather chesterfield, same size"); optional mood (lighting colour, fog).

### 5. Paint — Muse Image + SAM 3D
- **Surfaces:** Muse Image generates a square tileable texture per surface from its prompt; applied with world-scale UVs on the shell.
- **Objects:** Muse Image restyles the object's crop (image-to-image, keeps pose and silhouette) → SAM 3D (fal, `fal-ai/sam-3/3d-objects`, textured GLB) → placed in the object's box, scaled to its measured size, yaw from the box.
- Everything is cached by (scan, prompt, element), so a re-run with the same prompt is free and a new prompt only regenerates what changed.
- Concurrency-capped (fal 5 at a time, Muse Image 4 at a time); per-run caps on calls.

### 6. Reveal — viewer
- Reuse the Three.js/IWSDK app: orbit (dollhouse) + walkthrough + Quest VR (re-enable the VR button for this project).
- Start: the scan as a coloured point cloud / shell with original colours. As each surface texture lands, a shader wipe spreads from where the user is looking; each object crossfades from its scanned points to the new GLB.
- Progress stream: the run's step log, shown as a live checklist ("walls 2/4 · floor ✓ · sofa ✓ · bookshelf …").

## Meta stack used

| Meta tool | Role | Status |
|---|---|---|
| **MapAnything** (Meta open weights, Apache 2.0) | Video frames → metric 3D room + cameras | new: Modal worker |
| **SAM 3.1** (Meta Model API) | Find and outline every object in keyframes | working (85 detections on a live run) |
| **Muse Spark 1.3** (Meta Model API) | Name/merge objects, write the restyle plan | working |
| **Muse Image 1.0** (Meta Model API) | Surface textures + object restyles | adapter exists, **never run live → test first** |
| **SAM 3D Objects** (Meta, via fal) | Restyled crop → textured 3D object | working (25/25 on a live run) |
| **Immersive Web SDK / WebXR** (Meta) | Walk through on Quest at 1:1 | in the codebase, to re-enable |
| VGGT (Meta open weights) | Fallback for MapAnything | optional |

## What we keep from the old project (and what goes)

**Keep:** Fastify backend, job runner + persistent store, step logs and progress UI, Meta client (`museJson`, budgets, model resolution), SAM 3.1 adapter, SAM 3D adapter (fal) with caching/approval, image validation + upload ingest, safe-fetch, Three.js/IWSDK viewer (dollhouse, walkthrough, collisions, VR), Railway deploy, tests setup.

**Remove from the main journey (kept in git history, tag `viewin-listing-v1`):** listing import (RealtyAPI, Zillow/Rightmove adapters, listing-URL extraction, bookmarklet), globe/map, floor-plan reading + plan editor, OSM outlines, layout solver, room-hint UI, Realtor floor-plan search, furniture placement engine for listings.

## Data model (new)

- `Scan`: id, frames[] (media ids, camera pose, intrinsics, depth ref), pointCloud ref (binary .ply/.bin), bounds, scale = metres, provenance (`meta:mapanything`, model version), status.
- `RoomShell`: floor polygon (m), floorY, ceilingY, walls[] (a, b), confidence; fallback flag if fitting failed.
- `SceneObject`: id, label, box (centre, size, yaw), sourceFrames + mask refs, best crop ref.
- `Restyle` (one per prompt): prompt, plan JSON (Muse Spark), surface textures[] (Muse Image refs), objects[] (restyled crop → GLB url), status per element, cost summary.

## API (new)

- `POST /api/scans` (frames as raw JPEG uploads, like today's media upload) → scan id
- `POST /api/scans/:id/reconstruct` → job (MapAnything → structure → understand)
- `GET /api/scans/:id` → scan + shell + objects (+ point cloud URL)
- `POST /api/scans/:id/restyles` `{ prompt, notes? }` → job (plan → paint)
- `GET /api/restyles/:id` → plan + element statuses + asset URLs (polled for the progressive reveal)
- `GET /api/selftest/muse-image` → one live Muse Image edit on a bundled test image (de-risk)

## Milestones

**Mon 2 Nov**
- [x] Pick MapAnything; Modal over Baseten
- [x] DETAIL.md; branch `roomshift`; old app tagged
- [x] Muse Image live self-test endpoint (decides the "paint" path) — `/api/selftest/muse-image`, needs a live run
- [x] MapAnything Modal worker scaffold (`worker-3d/mapanything_app.py`) — [ ] owner deploys → first real scan
- [x] Frame capture (browser) + scan upload API + point-cloud viewer (tested against a fake worker)

**Tue 3 Nov**
- [x] Structure fitting (floor/ceiling/walls) + viewer showing the scan — `shared/room-shell.ts`, `scene/roomshift-scene.ts`
- [x] Objects: SAM 3.1 keyframes → 3D boxes; Muse names/merges — `objects.ts` + `shared/scan-objects.ts` (cloud projected into each keyframe with a z-buffer, shell points dropped, min-area box, merged by shared points); [ ] check on a real scan with the live key
- [x] Plan (Muse Spark) → paint surfaces (Muse Image textures) — `restyle.ts`
- [x] Paint objects: restyle each object's crop (Muse Image) → SAM 3D → GLB in its box — first live world: 7/8 pieces in 2 min 39 s
- [x] Fuller room: photo base coat on the shell, 1 cm voxel cloud (1M points), compact download (15 MB → 3–4 MB)
- [ ] Doors and windows: find them with SAM 3.1 and keep them in painted walls
- [x] Progressive reveal (paint spreads per surface; furniture grows into place)

**Wed 4 Nov**
- [ ] Quest VR pass (1:1), polish, cache a demo room, record the video, submit by 9 PM ET

## Risks and fallbacks

| Risk | Fallback |
|---|---|
| Muse Image can't do image-to-image well | Generate object images from text (Muse Image) using the object's label + style; SAM 3D still lifts them |
| MapAnything slow / OOM on our GPU | Fewer frames (20), smaller frames, bigger GPU; or VGGT |
| Wall/floor plane fitting fails on a messy room | Repaint the point cloud regions directly; keep the room as points |
| SAM 3D objects look odd/oriented wrong | Keep scan points for that object; show restyled crop as a billboard |
| Generation too slow for a live demo | Pre-run the demo prompt (cached), show a second prompt live |
| Quest alignment | VR at 1:1 from a marked starting spot; passthrough MR out of scope |

## Cost guards

- Modal: 1 GPU max, scale to zero, per-scan timeout, cache by frame hash. **Owner confirms remaining Starter credit before the first deploy.**
- Meta Model API: per-run call caps (existing `AiBudget`), cached per element.
- fal SAM 3D: max N objects per restyle (default 8), cached by input hash.

## Owner actions needed

1. Deploy the Modal worker (this sandbox can't reach modal.com):
   ```bash
   pip install modal && modal setup
   modal secret create roomshift-auth ROOMSHIFT_AUTH_TOKEN=$(openssl rand -hex 24)
   modal deploy worker-3d/mapanything_app.py
   ```
   then set `MAPANYTHING_URL` (printed URL + `/reconstruct`) and `MAPANYTHING_TOKEN` on the Railway backend.
2. Record a test capture: 20–40 s slow walk-around of a well-lit room, phone held steady at chest height, overlapping views, include all walls.
3. Quest available for the demo? (browser-only works too)
