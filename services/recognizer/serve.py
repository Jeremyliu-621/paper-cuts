#!/usr/bin/env python
"""
RECOGNIZER serve — POST a drawing, get back what the AI thinks it is (+ the game mapping).

Loads the tiny CNN trained by train/train_recognizer.py and serves top-3 predictions on CPU (instant).
The predicted QuickDraw class -> config.game_for() -> {label, archetype, element} that CAELLUM/CHLOE
consume. Plain Starlette routes (read the JSON body by hand) to dodge this box's typed-param 422 bug.

    POST /recognize  {pixels:[784 floats 0..1] }   # the game rasterizes strokes to 28x28 (white ink on black)
                  OR {image_b64:"<png>"}           # convenience: any-size PNG, auto grayscaled/resized/oriented
        -> {"results":[{label,category,archetype,element,confidence}...], "confident":bool, "top":{...}}
    GET  /healthz

    python serve.py --model recognizer_model --port 8600
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import config

# --- the CNN (KEEP IN SYNC with train/train_recognizer.py DoodleCNN) ---
class DoodleCNN(nn.Module):
    def __init__(self, n_classes: int):
        super().__init__()
        self.c1 = nn.Conv2d(1, 32, 3, padding=1)
        self.c2 = nn.Conv2d(32, 64, 3, padding=1)
        self.fc1 = nn.Linear(64 * 7 * 7, 128)
        self.fc2 = nn.Linear(128, n_classes)
        self.drop = nn.Dropout(0.3)

    def forward(self, x):
        x = F.max_pool2d(F.relu(self.c1(x)), 2)
        x = F.max_pool2d(F.relu(self.c2(x)), 2)
        x = x.flatten(1)
        x = self.drop(F.relu(self.fc1(x)))
        return self.fc2(x)


MODEL = None
CLASSES: list = []


def load_model(model_dir: str) -> None:
    global MODEL, CLASSES
    with open(os.path.join(model_dir, "classes.json")) as f:
        CLASSES = json.load(f)["classes"]
    MODEL = DoodleCNN(len(CLASSES))
    MODEL.load_state_dict(torch.load(os.path.join(model_dir, "model.pt"), map_location="cpu"))
    MODEL.eval()
    print(f"[serve] loaded recognizer: {len(CLASSES)} classes from {model_dir}")


def _to_28(body: dict) -> "np.ndarray":
    """Turn the request into a (28,28) float array in [0,1], white-ink-on-black (QuickDraw polarity)."""
    n = config.IMG_SIZE
    if "pixels" in body:
        arr = np.asarray(body["pixels"], dtype=np.float32).reshape(n, n)
        if arr.max() > 1.5:                       # sent as 0..255
            arr = arr / 255.0
        return np.clip(arr, 0.0, 1.0)
    if "image_b64" in body:
        from PIL import Image                      # only needed for the image path
        raw = base64.b64decode(body["image_b64"].split(",")[-1])
        img = Image.open(io.BytesIO(raw)).convert("L").resize((n, n))
        arr = np.asarray(img, dtype=np.float32) / 255.0
        if arr.mean() > 0.5:                       # dark ink on light bg -> invert to match QuickDraw
            arr = 1.0 - arr
        return arr
    raise ValueError("body must contain 'pixels' (784) or 'image_b64'")


def predict(arr28: "np.ndarray"):
    x = torch.from_numpy(arr28).float().view(1, 1, config.IMG_SIZE, config.IMG_SIZE)
    with torch.no_grad():
        probs = F.softmax(MODEL(x), dim=1)[0]
    k = min(3, len(CLASSES))
    top = torch.topk(probs, k)
    results = []
    for p, i in zip(top.values.tolist(), top.indices.tolist()):
        cat = CLASSES[i]
        g = config.game_for(cat)
        results.append({"category": cat, "label": g["label"], "archetype": g.get("archetype"),
                        "element": g.get("element"), "confidence": round(float(p), 4)})
    return results


# --- Starlette app (lazy import so non-serve tooling can import this module) ---
def build_app():
    from starlette.applications import Starlette
    from starlette.middleware import Middleware
    from starlette.middleware.cors import CORSMiddleware
    from starlette.requests import Request
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def recognize(request: Request):
        try:
            body = await request.json()
            arr = _to_28(body)
        except Exception as e:
            return JSONResponse({"error": f"bad input: {e}"}, status_code=400)
        try:
            results = predict(arr)
        except Exception as e:
            return JSONResponse({"error": f"inference failed: {e}"}, status_code=500)
        confident = bool(results and results[0]["confidence"] >= config.CONF_THRESHOLD)
        return JSONResponse({"results": results, "confident": confident, "top": results[0] if results else None})

    async def healthz(request: Request):
        return JSONResponse({"ok": MODEL is not None, "classes": len(CLASSES),
                             "threshold": config.CONF_THRESHOLD})

    mw = [Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])]
    return Starlette(routes=[
        Route(config.RECOGNIZE_ENDPOINT, recognize, methods=["POST"]),
        Route(config.HEALTH_ENDPOINT, healthz, methods=["GET"]),
    ], middleware=mw)


def main() -> None:
    ap = argparse.ArgumentParser(description="Serve the doodle recognizer.")
    ap.add_argument("--model", default="recognizer_model", help="dir with model.pt + classes.json")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=config.PORT)
    args = ap.parse_args()

    load_model(args.model)
    import uvicorn
    print(f"[serve] listening on http://{args.host}:{args.port}  "
          f"(POST {config.RECOGNIZE_ENDPOINT}, GET {config.HEALTH_ENDPOINT})")
    uvicorn.run(build_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
