# Deployment and Quest testing

**Not deployed yet. There is no live URL.** Suggested setup:

## Web app (static)
```bash
VITE_API_BASE=https://<api-host> npm run build -w app-web   # output: app-web/dist
```
Host `app-web/dist` on any HTTPS static host (Vercel, Cloudflare Pages).
WebXR needs a secure origin. Without an API, the app falls back to the scenes
baked into `dist/cached/` (`npm run fixture:bake` before building).

## API + worker
Any Node 22 host that supports a long-running process (Railway, Fly, Render):
```bash
npm ci
npm run start -w api        # WORKER_INLINE=true runs jobs in-process
```
Set the variables from `.env.example` in the host's secret manager, set
`CORS_ORIGINS` to the web origin, and mount a persistent volume for `DATA_DIR`
(job table, scenes, masks). The JSON store suits a single instance. For more
than one instance, move to the Postgres schema in `db/schema.sql`.

## Quest testing
1. `npm run dev:web` serves HTTPS on port 8081 with a self-signed certificate.
2. On the same network, open `https://<your-LAN-IP>:8081` in Quest Browser and accept the certificate. Alternatively, use `adb reverse tcp:8081 tcp:8081` and open `https://localhost:8081`.
3. Tap **Enter XR**. Check: plinth two-hand grab and scale, blue knob lift, red knob roof, trigger on a wall, menu buttons, enter room, thumbstick walk and turn, controller fallback without hand tracking.
4. Measure frame timing on device. Nothing here has been profiled on Quest yet.
