# RealtyAPI (live listings)

**Status: not connected.** `backend/src/providers/realtyapi.ts` deliberately does
not call guessed endpoints. With a key set, `/health` and the search page show
exactly what is still missing.

To connect a provider:
1. Pick the provider from https://www.realtyapi.io/llms.txt (for example a UK portal).
2. Fetch its spec from `https://{provider}.realtyapi.io/openapi.json` and find the search, listing-detail, media and floor-plan operations, and the auth header (documented as `x-realtyapi-key`).
3. Implement `searchRealty` and an `importRealty` that returns the same `{ property, media }` shape as `importFixture`. Mark media `usageRightsStatus: 'unverified'` unless the terms allow transformation and model processing. Unverified media is never sent to Meta models.
4. Download media server-side only from hosts on an allow-list taken from the spec (SSRF protection). Never fetch arbitrary user URLs.
5. Add the provider to the import allow-list in `backend/src/routes.ts`.

Not every listing has a floor plan, video or room dimensions. The UI already
shows missing-data states and refuses to invent a layout.
