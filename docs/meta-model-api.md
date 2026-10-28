# Meta Model API usage

All calls are server-side (`backend/src/meta/`) through the official `openai` SDK
pointed at `https://api.meta.ai/v1`, as in Meta's
[meta-model-cookbook](https://github.com/meta-models/meta-model-cookbook).
`MODEL_API_KEY` is read from the environment only. It is never logged,
serialised into scenes or sent to the browser.

> **Status:** these adapters have **not yet run against the real API**. The
> sandbox they were written in had no key and no route to `api.meta.ai`. Shapes
> follow the cookbook (structured output, vision input, SAM API basics, Muse
> Image editing) and are checked by `backend/test/meta-live-path.test.ts` against a
> local fake. First real run: set the key, run `npm run bake -- --reparse` in `backend/`,
> and read the run log.

## Calls

| Step | Model | Endpoint | Shape | Prompt version |
| --- | --- | --- | --- | --- |
| Floor plan → rooms/openings (one call per plan image) | `muse-spark-1.3` (escalates to `muse-wonder-1.0` if geometry checks fail and `MUSE_ESCALATION_ENABLED=true`) | `POST /chat/completions` | system text + **user** message with `text` and `image_url` (PNG data URL); `response_format: {type: "json_schema", json_schema: {strict: true}}` | `floorplan-v1` |
| Photos → rooms | `muse-spark-1.3` | `POST /chat/completions` | plans + up to 50 photos in one user message; JSON schema | `photo-match-v1` |
| Wall/floor finishes (per room with photos) | `muse-spark-1.3` | `POST /chat/completions` | room photos; JSON schema with colour, material, photo index and patch rectangle; rectangles validated, bad ones fall back to colour only | `surfaces-v1` |
| Placement suggestions (per room with photos) | `muse-spark-1.3` | `POST /chat/completions` | room geometry text, SAM detections, room photos; JSON schema | `placement-v1` |
| Verification pass | `muse-spark-1.3` (or Wonder) | `POST /chat/completions` | reconstruction summary + plan images; JSON schema | `plan-review-v1` |
| Segmentation | `sam-3.1` | `POST /responses`, `stream: true` | `input_text` (one noun phrase) + `input_image`; decoded with `@meta-sam/parser` `parseImageStream` and the cookbook's `output_text.done` normalisation | — |
| Redesign concept | `muse-image-1.0` | `POST /responses`, `store: false` | `input_text` + `input_image`; image read from the `image_generation_call` output item | `redesign-v1` |

Notes from the cookbook that the code relies on:
- Images are accepted **only in `user` messages** (a 400 otherwise).
- Supported image types: jpeg, png, gif, webp. **SVG is not accepted**, so plans are rasterised (`backend/fixtures/demo-house/render-png.cjs`).
- Roughly 50 images per request, 50 MB per inline image.
- On the Responses API, structured output uses `text.format`, not `response_format`. Only Chat Completions uses `response_format` here.
- SAM: "one short noun phrase per request". A completed request with zero masks is a valid empty result.

## What the models are and are not trusted with

- Muse outputs **plan-pixel polygons, dimension text and relationships**. Code converts them to meters, aligns vertices, derives walls and validates everything (`backend/src/shared/geometry.ts`, `verify.ts`).
- Placement suggestions are **never executed blindly**. `backend/src/shared/placement.ts` re-derives positions inside the room polygon and rejects collisions or blocked doorways.
- SAM masks are 2D evidence only. They are not 3D positions.
- Muse Image output is labelled as a conceptual 2D image and never changes the 3D scene.

## Cost and abuse controls

- `AI_MAX_CALLS_PER_RUN` (default 40) is a hard cap enforced before each call (`AiBudget`).
- `SAM_MAX_IMAGES_PER_RUN`, `SAM_MAX_CONCEPTS_PER_IMAGE` bound segmentation.
- Every call has `AI_TIMEOUT_MS` and SDK `maxRetries: 1`.
- Plan readings are cached per property, so rebuilds and corrections reuse them.
- `/reconstruct` and `/visualise` are rate-limited per IP. Redesigns have a daily cap.
- Each run records call counts and token usage (`totalCostEstimate`) in the job log.
- Alerts are not spending caps. Check your Meta account's quota and billing settings before enabling anything user-facing.

## Things to verify with the owner's account

- That `muse-spark-1.3`, `muse-wonder-1.0`, `sam-3.1` and `muse-image-1.0` are enabled for the project, and their quotas.
- Whether strict JSON schemas with nullable union types (`["number","null"]`) are accepted. If not, relax `strict` in `museJson`.
- Video understanding: not used yet. The spec's video path (Files API upload + `input_video`) follows the same pattern as the cookbook's `02-upload-and-segment-video.ts`.
