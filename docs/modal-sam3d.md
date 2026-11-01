# SAM 3D Objects (optional): Modal or fal.ai

Two interchangeable providers sit behind `backend/src/jobs/sam3d.ts`:

| `SAM3D_PROVIDER` | Needs | Status |
| --- | --- | --- |
| `modal` (default) | `MODAL_ENDPOINT_URL`, `MODAL_AUTH_SECRET`, the `worker-3d/` deployment | Scaffold, never deployed |
| `fal` | `FAL_KEY` (optional `FAL_SAM3D_ENDPOINT`, default `fal-ai/sam-3/3d-objects`) | Adapter written, **never called for real**: fal.ai was not reachable from the dev sandbox |

Both need `SAM3D_ENABLED=true`. Nothing is ever reconstructed automatically from the viewer: the user selects an object, picks the SAM 3.1 outline (photo + mask) to build from, and confirms a "paid inference" prompt; the API also refuses requests without `approveGpuCost: true`. Results, including model errors, are cached by content hash (`DATA_DIR/sam3d-cache.json`).

### fal.ai specifics (verify before the first run)

- Queue API: `POST https://queue.fal.run/fal-ai/sam-3/3d-objects` with `Authorization: Key $FAL_KEY`, then poll the returned `status_url` and read `response_url`.
- Input sent: `image_url` (the listing photo as a data URI), `prompt` (the SAM 3.1 concept, e.g. "sofa") and `seed`. These are the fields fal's docs/guide show. Whether the endpoint also accepts a **mask** was not confirmed, so the mask is not sent yet. If it does, add it in `callFal`.
- Output: the adapter takes the first GLB in the result (fal's guide shows `individual_glbs` / `model_glb`), otherwise a PLY (Gaussian splat). Only files on fal's own hosts are downloaded. If fal returns neither, the error lists the keys it did return.
- Price: fal's page listed about $0.02 per unit at the time of writing. Check the current price and your fal balance first.

# Modal worker

**Default: off.** The app works fully with proxy furniture. Nothing in this
document has been run yet: `worker-3d/app.py` is a scaffold that has never been
deployed, and its model calls are marked `VERIFY` against the upstream
repository.

## Zero-spend policy

The owner has the standard Modal Starter monthly included credit and **no**
hackathon promotion. Included credit is **not** a hard spending cap.

Before any GPU work:
1. In the Modal dashboard, record the remaining included credit and current GPU prices. Do not hard-code a rate.
2. Check the workspace's billing settings for whether paid overage is possible and whether a spend limit or restriction exists. **If you cannot confirm that no personal charge is possible, do not deploy. Ask the owner first.**
3. Read the SAM licence and checkpoint access terms in `facebookresearch/sam-3d-objects`.

## Guards built in

- Worker: `max_containers=1`, `scaledown_window=60`, `timeout=SAM3D_JOB_TIMEOUT_SECONDS`, constant-time bearer auth.
- Backend: `SAM3D_ENABLED=false` by default. `SAM3D_REQUIRE_MANUAL_APPROVAL=true` means a run only calls the worker when started with `{"sam3dApproved": true}`. Capped at `SAM3D_MAX_OBJECTS_PER_RUN` (default 1).
- Results, including failures, are cached by content hash in `DATA_DIR/sam3d-cache.json`, so retries never re-bill.
- Only **GLB** output is shown in the scene. Gaussian-splat PLY is stored but **not rendered** until a Quest-tested splat renderer is validated. The proxy stays and the UI says so.

## Steps (after the checks above)

```bash
pip install modal
modal setup                                   # authenticate
modal secret create sam3d-auth SAM3D_AUTH_TOKEN=$(openssl rand -hex 24)
modal secret create huggingface HF_TOKEN=...  # account with checkpoint access
modal volume create sam3d-checkpoints
# download checkpoints per the upstream README, then:
modal volume put sam3d-checkpoints ./checkpoints/hf /hf
# pin SAM3D_COMMIT in worker-3d/app.py, then:
modal deploy worker-3d/app.py
```

Set `MODAL_ENDPOINT_URL` to the printed web URL plus `/reconstruct`, and
`MODAL_AUTH_SECRET` to the same token. Run **one** hero object with
`SAM3D_ENABLED=true`, then check billed time in the dashboard before running
another.

## Shut-off

- Backend: `SAM3D_ENABLED=false` (single switch).
- Worker: `modal app stop walk-in-sam3d`. Confirm with `modal app list`.
