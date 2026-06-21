#!/usr/bin/env python
"""
CAELLUM serve — LOCAL backend (vanilla diffusers on Mac MPS / CUDA / CPU). No Trainium needed.

Same /enhance contract as the Neuron serve.py (rough sketch + label -> enhanced, background-removed
sprite), so the game's DS.AI.connect('<url>/enhance') is unchanged. We REUSE serve.py's exact image
helpers (decode/pad/control/cutout) — its top level is Neuron-free (the optimum-neuron import is lazy
inside load_pipeline), so importing it here triggers no Neuron deps — guaranteeing byte-identical
pre/post-processing. Only the pipeline (load + call) is the vanilla diffusers ControlNet pipeline.

Bonus: the Colab-trained CAELLUM LoRA drops straight in at RUNTIME via --lora (no compile/fuse).

    pip install -r services/caellum/requirements-serve-local.txt   # torch diffusers ... (first run downloads SD1.5)
    cd services/caellum
    python serve_local.py                       # auto device (MPS on Mac)
    python serve_local.py --lora ../../caellum_lora_out   # with the trained style LoRA
    # then in the game console:  DS.AI.connect('http://localhost:8400/enhance')
"""
from __future__ import annotations

import argparse
import os
import time
from typing import Optional

import config
import serve   # reuse the Neuron-free image helpers (_decode_png/_resize_pad_square/_make_control_image/_cutout_bg/_encode_png_b64)

PIPE = None
DEVICE = ""
CONTROL_MODE = "scribble"   # sd15 path (the Neuron serve uses scribble for sd15, canny for sdxl)


def pick_device(want: str) -> str:
    import torch
    if want in ("auto", "mps") and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    if want in ("auto", "cuda") and torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load_pipeline(device: str, dtype_name: str, lora_dir: Optional[str]):
    import torch
    from diffusers import ControlNetModel, StableDiffusionControlNetPipeline, UniPCMultistepScheduler

    dtype = {"float16": torch.float16, "float32": torch.float32}[dtype_name]
    print(f"[serve-local] loading SD1.5 + scribble-ControlNet on {device} ({dtype_name}) ...")
    controlnet = ControlNetModel.from_pretrained(config.SD15_CONTROLNET, torch_dtype=dtype)
    pipe = StableDiffusionControlNetPipeline.from_pretrained(
        config.SD15_MODEL, controlnet=controlnet, torch_dtype=dtype, safety_checker=None)
    pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config)   # crisp at ~20 steps
    if lora_dir:
        print(f"[serve-local] applying LoRA from {lora_dir!r} (runtime, no fuse) ...")
        pipe.load_lora_weights(lora_dir)
    pipe = pipe.to(device)
    pipe.set_progress_bar_config(disable=True)
    try:
        pipe.enable_attention_slicing()   # lower peak memory (helps on Mac)
    except Exception:
        pass
    return pipe


def enhance(image_b64: str, label: str, steps: Optional[int] = None) -> dict:
    if PIPE is None:
        raise RuntimeError("pipeline not loaded yet")
    if not isinstance(label, str) or not label.strip():
        raise ValueError("label is required")
    n_steps = int(steps) if steps else config.STEPS
    t0 = time.time()
    sketch = serve._decode_png(image_b64)
    init_img = serve._resize_pad_square(sketch, config.SHAPE)
    control_img = serve._make_control_image(init_img, CONTROL_MODE)
    print(f"[serve-local] enhance label={label!r} steps={n_steps} device={DEVICE}")
    result = PIPE(
        config.prompt_for(label.strip()),
        image=control_img,
        num_inference_steps=n_steps,
        guidance_scale=config.GUIDANCE,
        controlnet_conditioning_scale=config.CONTROLNET_SCALE,
        negative_prompt=config.NEG_PROMPT,
    )
    sprite = serve._cutout_bg(result.images[0].convert("RGB"))
    ms = int((time.time() - t0) * 1000)
    print(f"[serve-local] enhance done in {ms}ms")
    return {"sprite_b64": serve._encode_png_b64(sprite), "ms": ms, "base": "sd15-local"}


def prewarm() -> None:
    from PIL import Image
    print("[serve-local] pre-warming (first generation compiles device kernels) ...")
    t0 = time.time()
    dummy = Image.new("RGB", (config.SHAPE, config.SHAPE), (255, 255, 255))
    control = serve._make_control_image(dummy, CONTROL_MODE)
    PIPE("a doodle", image=control, num_inference_steps=config.STEPS,
         guidance_scale=config.GUIDANCE, controlnet_conditioning_scale=config.CONTROLNET_SCALE,
         negative_prompt=config.NEG_PROMPT)
    print(f"[serve-local] warm in {time.time() - t0:.1f}s — ready")


def build_app():
    from starlette.applications import Starlette
    from starlette.middleware import Middleware
    from starlette.middleware.cors import CORSMiddleware
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def enhance_endpoint(request):
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={"error": "body must be JSON"})
        image_b64 = data.get("image_b64")
        if not isinstance(image_b64, str) or not image_b64:
            return JSONResponse(status_code=400, content={"error": "image_b64 (base64 PNG) is required"})
        try:
            return JSONResponse(enhance(image_b64, data.get("label", "thing"), data.get("steps")))
        except ValueError as e:
            return JSONResponse(status_code=400, content={"error": str(e)})
        except Exception as e:
            return JSONResponse(status_code=500, content={"error": f"enhance failed: {e}"})

    async def healthz(request):
        return JSONResponse({"ok": PIPE is not None, "backend": "local", "device": DEVICE, "base": "sd15"})

    mw = [Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])]
    return Starlette(routes=[
        Route(config.ENHANCE_ENDPOINT, enhance_endpoint, methods=["POST"]),
        Route(config.HEALTH_ENDPOINT, healthz, methods=["GET"]),
    ], middleware=mw)


def main() -> None:
    global PIPE, DEVICE
    ap = argparse.ArgumentParser(description="CAELLUM local serve (diffusers, MPS/CUDA/CPU).")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=config.PORT)
    ap.add_argument("--device", default="auto", choices=["auto", "mps", "cuda", "cpu"])
    ap.add_argument("--dtype", default="auto", choices=["auto", "float16", "float32"])
    ap.add_argument("--lora", default="auto",
                    help="trained CAELLUM LoRA dir (runtime, no fuse). 'auto' = use ../../caellum_lora_out "
                         "if present; 'none' = stock SD1.5; or pass a path.")
    ap.add_argument("--no-warm", action="store_true")
    args = ap.parse_args()

    # resolve --lora: auto-load the repo's caellum_lora_out when it exists, so a plain run is styled.
    lora = args.lora
    if lora == "auto":
        cand = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "caellum_lora_out")
        lora = cand if os.path.isfile(os.path.join(cand, "pytorch_lora_weights.safetensors")) else None
        print(f"[serve-local] --lora auto -> {'using ' + cand if lora else 'none found (stock SD1.5)'}")
    elif lora in ("none", "off", ""):
        lora = None

    DEVICE = pick_device(args.device)
    # MPS/CPU are most reliable in float32; CUDA is fast in float16.
    dtype_name = args.dtype if args.dtype != "auto" else ("float16" if DEVICE == "cuda" else "float32")
    PIPE = load_pipeline(DEVICE, dtype_name, lora)
    if not args.no_warm:
        prewarm()

    import uvicorn
    print(f"[serve-local] listening on http://{args.host}:{args.port}  "
          f"(POST {config.ENHANCE_ENDPOINT}, GET {config.HEALTH_ENDPOINT}) device={DEVICE}")
    uvicorn.run(build_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
