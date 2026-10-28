# Data sources, rights and user trust

- **Demo property:** drawn by the project (`test-fixtures/demo-house`). The address and figures are fictional, so it is free to transform and send to models. It ships with **no photos**. Add only licensed or permission-granted photos to `photos/`.
- **Listing data:** a publicly visible plan or photo is not automatically reusable. Check RealtyAPI's terms and the underlying portal's terms before storing, altering or showing media. Media defaults to `unverified` and is then never sent to a model.
- **Labelling:** the UI always shows "AI reconstruction — dimensions approximate". Each room shows whether its size was printed or inferred and whether a photo supports it. The Evidence tab names the method behind every layer (live Meta, hand-authored fixture, manual correction, deterministic).
- **No personal data:** no owner or tenant information is inferred or stored.
- **Secrets:** `MODEL_API_KEY`, `REALTYAPI_KEY` and `MODAL_AUTH_SECRET` stay server-side. `npm run build` output contains none of them.
- **Abuse limits:** allow-listed providers only, ID validation, path-traversal checks on file routes, a body size limit, per-IP rate limits on paid endpoints, per-run AI call caps and timeouts.
- **Commercial use** beyond the hackathon needs a review of the SAM licence, Meta API terms, listing-data terms and privacy obligations.
