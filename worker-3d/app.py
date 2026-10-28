"""
SAM 3D Objects hero-object worker on Modal.

STATUS: scaffold, NOT yet deployed or run. It has not been executed against the
real model in this repository; verify every marked step against the
facebookresearch/sam-3d-objects README at the commit you pin before running.

Cost guards (see docs/modal-sam3d.md):
  * one GPU container max (max_containers=1), scale to zero quickly
  * hard per-call timeout
  * bearer-token auth; the backend is the only caller
  * nothing runs unless the backend has SAM3D_ENABLED=true AND the run was
    manually approved

Deploy (only after the billing checks in docs/modal-sam3d.md):
    modal secret create sam3d-auth SAM3D_AUTH_TOKEN=<random>
    modal secret create huggingface HF_TOKEN=<token with checkpoint access>
    modal deploy worker-3d/app.py
Stop everything:
    modal app stop propertyxr-sam3d
"""
import base64
import io
import os
import time

import modal

# Pin the upstream commit you have reviewed (licence + code).
SAM3D_REPO = "https://github.com/facebookresearch/sam-3d-objects"
SAM3D_COMMIT = os.environ.get("SAM3D_COMMIT", "main")  # TODO: pin a commit hash
GPU = os.environ.get("SAM3D_GPU", "L40S")
TIMEOUT_S = int(os.environ.get("SAM3D_JOB_TIMEOUT_SECONDS", "600"))

image = (
    modal.Image.from_registry("nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04", add_python="3.11")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .run_commands(
        f"git clone {SAM3D_REPO} /opt/sam3d && cd /opt/sam3d && git checkout {SAM3D_COMMIT}",
        # VERIFY: follow the repository's own install instructions (doc/setup).
        "cd /opt/sam3d && pip install -e '.[inference]'",
    )
    .pip_install("fastapi[standard]", "pillow", "numpy", "cairosvg")
)

weights = modal.Volume.from_name("sam3d-checkpoints", create_if_missing=True)
app = modal.App("propertyxr-sam3d")


@app.cls(
    image=image,
    gpu=GPU,
    timeout=TIMEOUT_S,
    max_containers=1,  # never more than one billed GPU
    scaledown_window=60,  # idle containers stop after a minute
    volumes={"/checkpoints": weights},
    secrets=[modal.Secret.from_name("sam3d-auth"), modal.Secret.from_name("huggingface")],
)
class Sam3d:
    @modal.enter()
    def load(self):
        import sys

        sys.path.insert(0, "/opt/sam3d/notebook")
        # VERIFY: entry point and config path per the upstream README.
        from inference import Inference  # type: ignore

        cfg = "/checkpoints/hf/pipeline.yaml"
        if not os.path.exists(cfg):
            raise RuntimeError("Checkpoints missing: download them into the sam3d-checkpoints volume (see docs/modal-sam3d.md)")
        self.model = Inference(cfg, compile=False)

    @modal.asgi_app()
    def web(self):
        import hmac

        from fastapi import FastAPI, Header, HTTPException

        api = FastAPI()
        token = os.environ["SAM3D_AUTH_TOKEN"]

        @api.post("/reconstruct")
        def reconstruct(body: dict, authorization: str = Header(default="")):
            if not hmac.compare_digest(authorization, f"Bearer {token}"):
                raise HTTPException(status_code=401, detail="unauthorised")
            return self._run(body)

        return api

    def _run(self, body: dict):
        import numpy as np
        from PIL import Image

        started = time.time()
        object_id = body.get("objectId", "")
        try:
            img_b64 = body["image"].split(",", 1)[1]
            img = Image.open(io.BytesIO(base64.b64decode(img_b64))).convert("RGB")
            arr = np.array(img)
            mask = _mask_from_request(body, arr.shape[1], arr.shape[0])
            out = self.model(arr, mask, seed=42)  # VERIFY call signature
            buf = io.BytesIO()
            out["gs"].save_ply(buf)  # VERIFY: output is a Gaussian splat
            return {
                "status": "ok",
                "objectId": object_id,
                "format": "ply-splat",
                "assetBase64": base64.b64encode(buf.getvalue()).decode(),
                "modelVersion": f"sam-3d-objects@{SAM3D_COMMIT}",
                "durationSeconds": round(time.time() - started, 1),
                "diagnostics": [],
            }
        except Exception as e:  # report, never retry here
            return {"status": "error", "objectId": object_id, "diagnostics": [repr(e)], "durationSeconds": round(time.time() - started, 1)}


def _mask_from_request(body: dict, w: int, h: int):
    """Rasterise the SAM 3.1 mask SVG; fall back to the bounding box."""
    import numpy as np

    svg = body.get("maskSvg")
    if svg:
        import cairosvg
        from PIL import Image

        png = cairosvg.svg2png(bytestring=svg.encode(), output_width=w, output_height=h)
        return (np.array(Image.open(io.BytesIO(png)).convert("L")) > 0).astype(np.uint8)
    x0, y0, x1, y1 = body["box"]
    m = np.zeros((h, w), dtype=np.uint8)
    m[int(y0 * h) : int(y1 * h), int(x0 * w) : int(x1 * w)] = 1
    return m
