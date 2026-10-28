# Deployment

WalkIn deploys as two independent services. Each one uses its own folder as
its root directory.

## Railway (current)

Project **WalkIn**, environment `production`, deploying from branch `main`:

| Service | Root dir | Build | URL |
| --- | --- | --- | --- |
| `backend` | `/backend` | `backend/Dockerfile` (Node 22, `npm start`), health check `/health`, volume `walkin-data` mounted at `/data` | https://backend-production-0e42e.up.railway.app |
| `frontend` | `/frontend` | Railpack detects Vite → `npm run build` → Caddy serves `dist/` | https://frontend-production-9b6d.up.railway.app |

Each service only redeploys when files in its own folder change (watch patterns).

### How they are wired together
- `frontend` → `VITE_API_BASE=https://${{backend.RAILWAY_PUBLIC_DOMAIN}}`. This is read at **build time**, so the frontend rebuilds when it changes.
- `backend` → `CORS_ORIGINS=https://${{frontend.RAILWAY_PUBLIC_DOMAIN}},https://localhost:8081`.
- `backend` → `PORT=8787`, `DATA_DIR=/data`, `WORKER_INLINE=true`.

If you add a custom domain, the references update by themselves. Redeploy the frontend afterwards so the new API URL is baked in.

### Secrets (set on the `backend` service only)

| Variable | Needed for | Required? |
| --- | --- | --- |
| `MODEL_API_KEY` | All Meta AI: Muse Spark plan reading, photo matching, placement, verification, SAM 3.1, Muse Image | **Yes, for live AI.** Without it the app runs on fixture data and says so |
| `REDESIGN_ENABLED=true` | Turns on Muse Image redesign (uses `MODEL_API_KEY`) | Optional |
| `MUSE_ESCALATION_ENABLED=true` | Muse Wonder for hard plans and the review pass | Optional |
| `REALTYAPI_KEY`, `REALTYAPI_PROVIDER` | Live listing search. The adapter still has to be finished first (`docs/realtyapi.md`) | Not yet |
| `MODAL_ENDPOINT_URL`, `MODAL_AUTH_SECRET`, `SAM3D_ENABLED=true` | SAM 3D hero object on Modal (`docs/modal-sam3d.md`) | Optional; leave off |

The frontend needs **no** secrets. Anything set on it is public in the bundle.

## Other hosts
- **Frontend:** any static host. Run `VITE_API_BASE=https://<api> npm run build` in `frontend/` and serve `dist/` over HTTPS (WebXR needs a secure origin). With no backend, it falls back to the baked scenes in `public/cached/`.
- **Backend:** any Node 22 or Docker host with a persistent disk for `DATA_DIR`. The JSON store suits a single instance. For more than one instance, move to `db/schema.sql`.

## Quest testing
1. Open the frontend URL in Quest Browser and tap **Enter XR**.
2. Check: plinth two-hand grab and scale, blue knob lift, red knob roof, trigger on a wall, menu buttons, enter room, thumbstick walk and turn, controller fallback without hand tracking.
3. For local testing: run `npm run dev:runtime` in `frontend/` (HTTPS on port 8081), then open `https://<LAN-IP>:8081` on the headset, or use `adb reverse tcp:8081 tcp:8081`.
4. Nothing has been profiled on Quest yet. Measure frame timing on the device.
