#!/usr/bin/env python3
"""
CHLOE /mechanic HTTP server — turns a drawn object's DESCRIPTION/LABEL into a
bounded JSON mechanic SPEC (a node from config.NODES + clamped params).

ENV: runs anywhere with `config.py` importable (run from inside `services/chloe/`).
Two backends, picked at launch with --backend:
  - claude (default): Anthropic API teacher (claude-haiku-4-5). Needs ANTHROPIC_API_KEY.
                      No Neuron/torch deps — just `anthropic`.
  - local           : the trained student — config.BASE_MODEL + the LoRA adapter in
                      --lora-dir, loaded with transformers/peft. Pre-warmed at startup.

What it does (per IMPLEMENTATION-SPEC):
  POST {config.MECHANIC_ENDPOINT}  {description|label} -> generate spec -> config.clamp_spec()
                                                       -> {node, params, name, flavor}
  GET  {config.HEALTH_ENDPOINT}    liveness / backend / warm state
on host 0.0.0.0 : config.PORT.

The model NEVER decides the final numbers — config.clamp_spec() is the safety net: a
hallucinated node raises (400), and out-of-range / wrong-type params are clamped to NODES.

Serving note (CRITICAL): this box's FastAPI mis-classifies typed handler params as
required query params -> 422 (see services/caellum/serve.py for the same workaround).
So /mechanic is a PLAIN STARLETTE route added via app.add_route(...) that reads the body
with `await request.json()` — no typed-param handler.

Example invocation (from services/chloe/):
    # Claude backend (default) — distill on the fly from the teacher:
    export ANTHROPIC_API_KEY=sk-ant-...
    python serve.py
    # or pick the trained student:
    python serve.py --backend local --lora-dir chloe_lora
    # custom host/port:
    python serve.py --backend claude --host 0.0.0.0 --port 8500
    # smoke test:
    curl -s localhost:8500/healthz
    curl -s -X POST localhost:8500/mechanic \
         -H 'content-type: application/json' \
         -d '{"description":"a heavy slow cannon"}'
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import traceback
from typing import Any, Optional

# graph_config is the single source of truth for the COMPOSABLE graph contract (mirrors js/graph.js).
# It exposes drop-in aliases (NODES, node_menu, clamp_spec, BASE_MODEL, SYSTEM_PROMPT, serve cfg) so
# this server is unchanged below. (For the legacy single-node schema, swap back to `import config`.)
import graph_config as config


# --------------------------------------------------------------------------------------
# Globals populated at startup. Kept module-level so the Starlette handler (and a future
# queue consumer) can reach the warm backend without re-loading it per request.
# --------------------------------------------------------------------------------------
BACKEND: str = "claude"            # "claude" or "local"
WARM: bool = False                 # flips True once the backend is ready
MODEL_ID: str = ""                 # for /healthz visibility

# claude backend
CLAUDE_CLIENT: Any = None          # anthropic.Anthropic()
CLAUDE_MODEL = "claude-haiku-4-5"  # spec-verified teacher model

# local backend
LOCAL_MODEL: Any = None            # transformers model
LOCAL_TOKENIZER: Any = None        # transformers tokenizer
LORA_DIR: str = ""                 # adapter dir, for /healthz


def build_prompt() -> str:
    """The system prompt the model sees: the contract + the bounded node menu.

    Mirrors the SFT training rows' system content (config.SYSTEM_PROMPT + node_menu),
    so the trained student sees exactly what it was trained on, and the Claude teacher
    gets the same bounded instructions.
    """
    return config.SYSTEM_PROMPT + "\n\n" + config.node_menu()


def _extract_json(text: str) -> dict:
    """Pull a JSON object out of model text. Strips ```json fences, then falls back to
    the first {...} span. Raises ValueError if nothing parseable is found (caller maps
    that to a 500 — the clamp happens after this)."""
    if not isinstance(text, str):
        raise ValueError(f"model returned non-text output: {type(text)!r}")
    s = text.strip()

    # Strip a ```json ... ``` (or bare ``` ... ```) fence if present.
    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", s, re.DOTALL)
    if fence:
        s = fence.group(1).strip()

    # Try the whole thing first; then fall back to the first balanced-looking {...} span.
    candidates = [s]
    brace = re.search(r"\{.*\}", s, re.DOTALL)
    if brace:
        candidates.append(brace.group(0))

    last_err: Optional[Exception] = None
    for cand in candidates:
        try:
            obj = json.loads(cand)
        except (json.JSONDecodeError, ValueError) as exc:
            last_err = exc
            continue
        if isinstance(obj, dict):
            return obj
        last_err = ValueError("model JSON was not an object")
    raise ValueError(f"could not parse a JSON object from model output: {last_err}")


# --------------------------------------------------------------------------------------
# Backend: Claude (Anthropic API). Distills the teacher live.
# --------------------------------------------------------------------------------------
def load_claude() -> None:
    """Construct the Anthropic client and flip WARM. Reads ANTHROPIC_API_KEY from env."""
    global CLAUDE_CLIENT, MODEL_ID, WARM
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit(
            "[serve] --backend claude requires ANTHROPIC_API_KEY in the environment."
        )
    # Imported lazily so the local backend doesn't need `anthropic` installed.
    from anthropic import Anthropic

    print(f"[serve] claude backend: initializing Anthropic client (model={CLAUDE_MODEL})")
    CLAUDE_CLIENT = Anthropic()
    MODEL_ID = CLAUDE_MODEL
    WARM = True
    print("[serve] claude backend ready")


def gen_claude(description: str, system: str) -> dict:
    """Ask the Claude teacher for a spec; return the parsed (un-clamped) dict.

    Uses the spec-verified call shape: client.messages.create(model, max_tokens, system,
    messages). Parses JSON out of the text; on parse failure, retries once then raises.
    """
    if CLAUDE_CLIENT is None:
        raise RuntimeError("claude backend not loaded yet")

    last_err: Optional[Exception] = None
    for attempt in range(2):  # parse failure -> retry once, then give up
        resp = CLAUDE_CLIENT.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=400,
            system=system,
            messages=[{"role": "user", "content": description}],
        )
        text = "".join(
            block.text for block in resp.content if getattr(block, "type", None) == "text"
        )
        try:
            return _extract_json(text)
        except ValueError as exc:
            last_err = exc
            print(f"[serve] claude parse failure (attempt {attempt + 1}): {exc}")
    raise RuntimeError(f"claude backend could not produce parseable JSON: {last_err}")


# --------------------------------------------------------------------------------------
# Backend: local (trained student — BASE_MODEL + LoRA adapter via transformers/peft).
# --------------------------------------------------------------------------------------
def load_local(lora_dir: str) -> None:
    """Load config.BASE_MODEL, apply the LoRA adapter from `lora_dir`, and pre-warm."""
    global LOCAL_MODEL, LOCAL_TOKENIZER, MODEL_ID, LORA_DIR, WARM
    if not os.path.isdir(lora_dir):
        raise SystemExit(
            f"[serve] --backend local: LoRA dir {lora_dir!r} not found — train first "
            f"(train/train_chloe_sft.py --output_dir {lora_dir})."
        )

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    LORA_DIR = lora_dir
    print(f"[serve] local backend: loading base {config.BASE_MODEL!r} ...")
    t0 = time.time()
    LOCAL_TOKENIZER = AutoTokenizer.from_pretrained(config.BASE_MODEL)
    base = AutoModelForCausalLM.from_pretrained(
        config.BASE_MODEL,
        torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
    )
    print(f"[serve] local backend: applying LoRA adapter from {lora_dir!r} ...")
    LOCAL_MODEL = PeftModel.from_pretrained(base, lora_dir)
    LOCAL_MODEL.eval()
    if torch.cuda.is_available():
        LOCAL_MODEL.to("cuda")
    MODEL_ID = f"{config.BASE_MODEL}+lora({lora_dir})"
    print(f"[serve] local backend loaded in {time.time() - t0:.1f}s")

    # Pre-warm: one throwaway generation so the first real /mechanic isn't slow.
    print("[serve] pre-warming local model...")
    try:
        gen_local("a small ball", build_prompt())
        WARM = True
        print("[serve] pre-warm complete — ready to serve")
    except Exception:
        # Don't crash on a warm failure; /healthz reports not-warm, first request pays it.
        print("[serve] WARNING: pre-warm failed; first request will be slow:")
        traceback.print_exc()


def gen_local(description: str, system: str) -> dict:
    """Generate a spec with the trained student; return the parsed (un-clamped) dict.

    Formats the chat with the tokenizer's apply_chat_template (same shape as training),
    generates, decodes only the new tokens, and parses the JSON out.
    """
    if LOCAL_MODEL is None or LOCAL_TOKENIZER is None:
        raise RuntimeError("local backend not loaded yet")

    import torch

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": description},
    ]
    prompt = LOCAL_TOKENIZER.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    inputs = LOCAL_TOKENIZER(prompt, return_tensors="pt").to(LOCAL_MODEL.device)

    with torch.no_grad():
        out = LOCAL_MODEL.generate(
            **inputs,
            max_new_tokens=400,
            do_sample=False,  # deterministic spec
            pad_token_id=LOCAL_TOKENIZER.eos_token_id,
        )
    # Decode ONLY the newly generated tokens (skip the prompt).
    new_tokens = out[0][inputs["input_ids"].shape[1]:]
    text = LOCAL_TOKENIZER.decode(new_tokens, skip_special_tokens=True)
    return _extract_json(text)


# --------------------------------------------------------------------------------------
# Core: description/label -> generate via the chosen backend -> clamp_spec -> spec dict.
# Framework-agnostic so a future queue consumer can call it directly.
# --------------------------------------------------------------------------------------
def mechanic_for(description: str) -> dict:
    """Build the prompt, generate a raw spec via the active backend, and run it through
    config.clamp_spec(). Raises ValueError for a bad/unknown node (client-fixable -> 400)
    and other exceptions for backend failures (-> 500).
    """
    if not isinstance(description, str) or not description.strip():
        raise ValueError("description (or label) is required and must be a non-empty string")

    system = build_prompt()
    desc = description.strip()
    print(f"[serve] mechanic backend={BACKEND} desc={desc!r}")

    raw = gen_claude(desc, system) if BACKEND == "claude" else gen_local(desc, system)

    # The safety net: validate + clamp to NODES. clamp_spec raises ValueError on an
    # unknown node and clamps everything else. A garbage number can never break the match.
    spec = config.clamp_spec(raw)
    print(f"[serve] mechanic -> node={spec['node']} name={spec['name']!r}")
    return spec


# --------------------------------------------------------------------------------------
# App — Starlette base (FastAPI base would also work). /mechanic is a plain route to
# dodge this box's typed-param 422 bug; /healthz takes no params so it's a normal route.
# --------------------------------------------------------------------------------------
def build_app():
    """Construct the Starlette app. Imported lazily so non-serve tooling can import this
    module without pulling in starlette."""
    from starlette.applications import Starlette
    from starlette.middleware import Middleware
    from starlette.middleware.cors import CORSMiddleware
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    # The game calls /mechanic from the browser (file:// or the relay host), a different
    # origin — allow cross-origin requests, same as services/caellum/serve.py.
    middleware = [
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
        )
    ]

    async def healthz(request):
        return JSONResponse(
            {
                "status": "ok" if WARM else "loading",
                "warm": WARM,
                "backend": BACKEND,
                "model": MODEL_ID,
                "nodes": list(config.NODES),
            }
        )

    # PLAIN STARLETTE route: add_route passes the raw request positionally with NO type
    # introspection, and we read the JSON body by hand — bypassing FastAPI's parameter
    # machinery (which 422s on typed handler params on this box). Accepts {description}
    # or {label} (the game POSTs the prop label).
    async def mechanic(request):
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={"error": "request body must be JSON"})
        if not isinstance(data, dict):
            return JSONResponse(
                status_code=400, content={"error": "request body must be a JSON object"}
            )
        description = data.get("description", data.get("label"))
        if not isinstance(description, str) or not description.strip():
            return JSONResponse(
                status_code=400,
                content={"error": "'description' (or 'label') is required and must be a non-empty string"},
            )
        try:
            spec = mechanic_for(description)
            return JSONResponse(content=spec)
        except ValueError as exc:
            # bad client input OR an unknown node from the model (clamp_spec raised).
            return JSONResponse(status_code=400, content={"error": str(exc)})
        except Exception as exc:
            traceback.print_exc()
            return JSONResponse(status_code=500, content={"error": f"mechanic failed: {exc}"})

    return Starlette(
        routes=[
            Route(config.HEALTH_ENDPOINT, healthz, methods=["GET"]),
            Route(config.MECHANIC_ENDPOINT, mechanic, methods=["POST"]),
        ],
        middleware=middleware,
    )


def init_server(backend: str, lora_dir: str) -> None:
    """Load + pre-warm the chosen backend, populating module globals."""
    global BACKEND
    BACKEND = backend
    if backend == "claude":
        load_claude()
    elif backend == "local":
        load_local(lora_dir)
    else:
        raise SystemExit(f"[serve] unknown backend {backend!r} (must be 'claude' or 'local')")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Serve CHLOE /mechanic: description/label -> clamped JSON mechanic spec."
    )
    parser.add_argument(
        "--backend",
        default="claude",
        choices=["claude", "local"],
        help="claude = Anthropic API teacher (default); local = trained BASE_MODEL + LoRA",
    )
    parser.add_argument("--host", default="0.0.0.0", help="bind host (default: 0.0.0.0)")
    parser.add_argument(
        "--port", type=int, default=config.PORT, help=f"bind port (default: {config.PORT})"
    )
    parser.add_argument(
        "--lora-dir",
        default="chloe_lora",
        help="LoRA adapter dir for --backend local (default: chloe_lora)",
    )
    args = parser.parse_args()

    print(f"[serve] CHLOE starting | backend={args.backend}")
    init_server(args.backend, args.lora_dir)

    import uvicorn

    app = build_app()
    print(
        f"[serve] listening on http://{args.host}:{args.port}  "
        f"(POST {config.MECHANIC_ENDPOINT}, GET {config.HEALTH_ENDPOINT})"
    )
    # Single worker: the backend (Anthropic client or the loaded model) lives once in
    # this process.
    uvicorn.run(app, host=args.host, port=args.port, workers=1, log_level="info")


if __name__ == "__main__":
    main()
