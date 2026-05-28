from http.server import BaseHTTPRequestHandler
import json
import base64
import io

try:
    import numpy as np
    from PIL import Image, ImageFilter
    HAS_DEPS = True
except ImportError:
    HAS_DEPS = False


def compute_saliency(image_bytes, max_size=900):
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")

    w, h = img.size
    if max(w, h) > max_size:
        ratio = max_size / max(w, h)
        img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

    W, H = img.size
    arr = np.array(img, dtype=np.float32) / 255.0

    # Luminance
    luma = arr[:, :, 0] * 0.299 + arr[:, :, 1] * 0.587 + arr[:, :, 2] * 0.114
    luma_img = Image.fromarray((luma * 255).clip(0, 255).astype(np.uint8))

    # 1. Contrast — Difference of Gaussians (42%)
    blur_fine   = np.array(luma_img.filter(ImageFilter.GaussianBlur(radius=2)),  dtype=np.float32) / 255.0
    blur_coarse = np.array(luma_img.filter(ImageFilter.GaussianBlur(radius=10)), dtype=np.float32) / 255.0
    contrast = np.abs(blur_fine - blur_coarse)
    contrast /= contrast.max() + 1e-8

    # 2. Edge detection — Sobel via numpy gradient (34%)
    gy, gx = np.gradient(luma)
    edges = np.sqrt(gx ** 2 + gy ** 2)
    edges_img = Image.fromarray((edges / (edges.max() + 1e-8) * 255).clip(0, 255).astype(np.uint8))
    edges = np.array(edges_img.filter(ImageFilter.GaussianBlur(radius=4)), dtype=np.float32) / 255.0

    # 3. Color saturation (18%)
    saturation = np.max(arr, axis=2) - np.min(arr, axis=2)
    saturation /= saturation.max() + 1e-8

    # 4. Spatial bias — center + above-fold (6%)
    y_grid = np.tile(np.linspace(0, 1, H)[:, np.newaxis], (1, W))
    x_grid = np.tile(np.linspace(0, 1, W)[np.newaxis, :], (H, 1))
    dist = np.sqrt((x_grid - 0.5) ** 2 * 0.4 + (y_grid - 0.42) ** 2)
    spatial = np.maximum(0.0, 1.0 - dist * 2.5)
    above_fold = np.where(y_grid < 0.65, 0.3, 0.05)
    spatial = np.clip(spatial + above_fold * 0.3, 0, 1)

    # Weighted combination
    saliency = contrast * 0.42 + edges * 0.34 + saturation * 0.18 + spatial * 0.06

    # Final smoothing
    sal_img = Image.fromarray((saliency / (saliency.max() + 1e-8) * 255).clip(0, 255).astype(np.uint8))
    saliency = np.array(sal_img.filter(ImageFilter.GaussianBlur(radius=6)), dtype=np.float32) / 255.0

    return saliency, W, H


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def do_POST(self):
        if not HAS_DEPS:
            self._json(500, {"error": "numpy/Pillow not available"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            image_b64 = body.get("image", "")
            if "," in image_b64:
                image_b64 = image_b64.split(",")[1]

            image_bytes = base64.b64decode(image_b64)
            saliency, W, H = compute_saliency(image_bytes)

            step = max(5, min(W, H) // 80)
            points = []
            for y in range(step, H - step, step):
                for x in range(step, W - step, step):
                    v = float(saliency[y, x])
                    if v > 0.05:
                        points.append({"x": x, "y": y, "s": round(v, 3)})

            points.sort(key=lambda p: p["s"], reverse=True)
            self._json(200, {"points": points[:600], "width": W, "height": H, "step": step})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass
