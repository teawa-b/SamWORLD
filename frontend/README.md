# WalkIn frontend

IWSDK + Vite frontend. `iwsdk.config.json` holds the declarative world
settings: VR session with hand tracking, grabbing and spatial UI. The built-in
locomotion is off because walking uses plan-wall collision in
`src/systems/walkthrough.ts`. Systems are registered in `src/index.ts`.

```sh
npm run dev:runtime     # plain Vite on https://localhost:8081 (proxies /api to :8787)
npm run dev             # IWSDK managed dev session (browser + emulator tooling)
npm run build
```

- `src/scene/`: manifest → Three.js (structure, proxies, labels)
- `src/systems/`: dollhouse interactions, walkthrough/camera, XR menu
- `src/ui/`: HTML side panel
- `public/ui/property-menu.uikitml`: in-headset menu
- `public/cached/`: baked scenes for API-less hosting (run `npm run bake` in `backend/`)

IWER emulator controls: https://iwsdk.dev/guides/02-testing-experience.html#iwer-controls
