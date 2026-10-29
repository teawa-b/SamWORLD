# Data sources, rights and user trust

- **Demo property:** drawn by the project (`backend/fixtures/demo-house`). The address and figures are fictional, so it is free to transform and send to models. It ships with **no photos**. Add only licensed or permission-granted photos to `photos/`.
- **Listing data:** live listings come from Rightmove, Zoopla, Zillow and Realtor.com through the owner's RealtyAPI account. Imported media is marked `licensed` on that basis so it can be sent to Meta models. A publicly visible plan or photo is not automatically reusable, so check RealtyAPI's terms and the portal's terms before public or commercial use. Media from any other source defaults to `unverified` and is never sent to a model.
- **Map:** OpenFreeMap tiles (OpenStreetMap data, © OpenStreetMap contributors) and Nominatim geocoding (max 1 request per second, cached).
- **Labelling:** the UI always shows "AI reconstruction — dimensions approximate". Each room shows whether its size was printed or inferred and whether a photo supports it. The Evidence tab names the method behind every layer (live Meta, hand-authored fixture, manual correction, deterministic).
- **No personal data:** no owner or tenant information is inferred or stored.
- **Secrets:** `MODEL_API_KEY`, `REALTYAPI_KEY` and `MODAL_AUTH_SECRET` stay server-side. `npm run build` output contains none of them.
- **Abuse limits:** allow-listed providers only, ID validation, path-traversal checks on file routes, a body size limit, per-IP rate limits on paid endpoints, per-run AI call caps and timeouts.
- **Commercial use** beyond the hackathon needs a review of the SAM licence, Meta API terms, listing-data terms and privacy obligations.
