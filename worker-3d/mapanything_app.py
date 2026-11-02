"""
Roomshift scan worker: MapAnything (Meta, Apache 2.0) on Modal.

Input  (POST /reconstruct, bearer auth): {"frames": [<base64 jpeg/png>, ...]}  (4-60 frames, in capture order)
Output: {"status": "ok", "model": ..., "plyBase64": <binary PLY: float x,y,z + uchar r,g,b>,
         "points": N, "cameras": [{"pose": [16 floats, row-major world-from-camera], "intrinsics": [fx, fy, cx, cy],
                                   "width": W, "height": H}], "timings": {...}}
Coordinates: metres, y-up, three.js camera convention (camera looks down -z). MapAnything outputs OpenCV
(+x right, +y down, +z forward); we convert with M = diag(1, -1, -1): p' = M p, pose' = M @ pose @ M.

Usage follows the MapAnything README (facebookresearch/map-anything, checked 2 Nov 2026 against v1.1.4):
MapAnything.from_pretrained(...), load_images(folder), model.infer(views, ...) -> per-view dicts with pts3d,
camera_poses (OpenCV cam2world), intrinsics, mask (B,H,W,1), conf, img_no_norm.

Cost guards: one GPU container max, scales to zero after 2 minutes idle, hard timeout, bearer auth.

Deploy (owner, from the repo root):
    pip install modal && modal setup
    modal secret create roomshift-auth ROOMSHIFT_AUTH_TOKEN=<random>
    modal deploy worker-3d/mapanything_app.py
Then set on the backend: MAPANYTHING_URL=<printed web URL>/reconstruct, MAPANYTHING_TOKEN=<same token>.
Stop: modal app stop roomshift-mapanything
"""
import base64
import io
import os
import tempfile
import time

import modal

GPU = os.environ.get("MAPANYTHING_GPU", "A10G")
CHECKPOINT = os.environ.get("MAPANYTHING_CHECKPOINT", "facebook/map-anything-apache")  # Apache 2.0, not gated
MAX_POINTS = 400_000

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "libgl1", "libglib2.0-0")
    # MapAnything doesn't pin torch; the default Linux wheels ship with CUDA 12.
    .pip_install("torch>=2.5", "torchvision", "fastapi[standard]", "pillow", "numpy")
    .run_commands(
        "git clone --depth 1 https://github.com/facebookresearch/map-anything.git /opt/map-anything",
        "cd /opt/map-anything && pip install -e .",
        # Bake the weights into the image so cold starts don't download them.
        f"python -c \"from mapanything.models import MapAnything; MapAnything.from_pretrained('{CHECKPOINT}')\"",
    )
)

app = modal.App("roomshift-mapanything")


@app.cls(
    image=image,
    gpu=GPU,
    timeout=600,
    max_containers=1,  # never more than one billed GPU
    scaledown_window=120,  # stop paying 2 minutes after the last scan
    secrets=[modal.Secret.from_name("roomshift-auth")],
)
class MapAnythingWorker:
    @modal.enter()
    def load(self):
        import torch
        from mapanything.models import MapAnything

        t = time.time()
        self.device = "cuda"
        self.model = MapAnything.from_pretrained(CHECKPOINT).to(self.device).eval()
        self.load_seconds = round(time.time() - t, 1)
        torch.backends.cuda.matmul.allow_tf32 = True

    @modal.asgi_app()
    def web(self):
        import hmac

        from fastapi import FastAPI, Header, HTTPException

        api = FastAPI()
        token = os.environ["ROOMSHIFT_AUTH_TOKEN"]

        @api.get("/health")
        def health():
            return {"ok": True, "checkpoint": CHECKPOINT, "gpu": GPU, "loadSeconds": self.load_seconds}

        @api.post("/reconstruct")
        def reconstruct(body: dict, authorization: str = Header(default="")):
            if not hmac.compare_digest(authorization, f"Bearer {token}"):
                raise HTTPException(status_code=401, detail="unauthorised")
            try:
                return self._run(body)
            except Exception as e:  # report, never retry here
                return {"status": "error", "diagnostics": [repr(e)]}

        return api

    def _run(self, body: dict):
        import numpy as np
        import torch
        from mapanything.utils.image import load_images

        frames = body.get("frames") or []
        if not 4 <= len(frames) <= 80:
            return {"status": "error", "diagnostics": [f"need 4-80 frames, got {len(frames)}"]}
        timings = {"modelLoadSeconds": self.load_seconds}
        t = time.time()
        with tempfile.TemporaryDirectory() as d:
            for i, f in enumerate(frames):
                with open(os.path.join(d, f"{i:03d}.jpg"), "wb") as fh:
                    fh.write(base64.b64decode(f.split(",", 1)[-1]))
            views = load_images(d)
        timings["loadSeconds"] = round(time.time() - t, 2)

        t = time.time()
        with torch.inference_mode():
            preds = self.model.infer(
                views,
                memory_efficient_inference=len(frames) > 30,
                use_amp=True,
                amp_dtype="bf16",
                apply_mask=True,
                mask_edges=True,
                apply_confidence_mask=True,
                confidence_percentile=10,
            )
        torch.cuda.synchronize()
        timings["inferSeconds"] = round(time.time() - t, 2)

        M = np.diag([1.0, -1.0, -1.0])
        M4 = np.diag([1.0, -1.0, -1.0, 1.0])
        pts_all, col_all, cameras = [], [], []
        for p in preds:
            pts = p["pts3d"][0].float().cpu().numpy()  # (H, W, 3) world, OpenCV
            img = p["img_no_norm"][0].float().cpu().numpy()  # (H, W, 3), 0..1 (or 0..255 on some versions)
            if img.max() > 1.5:
                img = img / 255.0
            mask = p["mask"][0].squeeze(-1).cpu().numpy().reshape(pts.shape[:2]).astype(bool)
            K = p["intrinsics"][0].float().cpu().numpy()
            pose = p["camera_poses"][0].float().cpu().numpy()  # cam2world, OpenCV
            h, w = pts.shape[:2]
            pts_all.append((pts[mask] @ M.T).astype(np.float32))
            col_all.append((np.clip(img[mask], 0, 1) * 255).astype(np.uint8))
            pose3 = M4 @ pose @ M4
            cameras.append({"pose": [float(v) for v in pose3.reshape(-1)], "intrinsics": [float(K[0, 0]), float(K[1, 1]), float(K[0, 2]), float(K[1, 2])], "width": int(w), "height": int(h)})

        pts = np.concatenate(pts_all) if pts_all else np.zeros((0, 3), np.float32)
        cols = np.concatenate(col_all) if col_all else np.zeros((0, 3), np.uint8)
        if len(pts) > MAX_POINTS:
            # Voxel-ish thinning: keep a random subset (uniform over surfaces seen in many frames).
            keep = np.random.default_rng(0).choice(len(pts), MAX_POINTS, replace=False)
            pts, cols = pts[keep], cols[keep]

        header = (
            "ply\nformat binary_little_endian 1.0\n"
            f"element vertex {len(pts)}\n"
            "property float x\nproperty float y\nproperty float z\n"
            "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
        ).encode()
        rec = np.empty(len(pts), dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")])
        rec["x"], rec["y"], rec["z"] = pts[:, 0], pts[:, 1], pts[:, 2]
        rec["r"], rec["g"], rec["b"] = cols[:, 0], cols[:, 1], cols[:, 2]
        buf = io.BytesIO()
        buf.write(header)
        buf.write(rec.tobytes())
        return {
            "status": "ok",
            "model": f"mapanything ({CHECKPOINT})",
            "plyBase64": base64.b64encode(buf.getvalue()).decode(),
            "points": int(len(pts)),
            "cameras": cameras,
            "timings": timings,
            "diagnostics": [],
        }
