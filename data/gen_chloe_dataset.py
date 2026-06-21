#!/usr/bin/env python3
"""
CHLOE dataset generator — distill Claude (teacher) into SFT chat rows for the mechanic-spec model.

ENV: local / Colab / any box with internet + an Anthropic API key (NOT the Neuron box).
     Only requirement is `pip install anthropic`. No GPU, no repo checkout strictly needed
     (it falls back to mirrored constants if `services/chloe/config.py` can't be imported).

This is the FIRST stage of the CHLOE pipeline (distill -> train on Trainium -> serve):
    gen_chloe_dataset.py  --Claude teacher-->  data/chloe_pairs.jsonl  (SFT chat rows)
                                                       |
    train/train_chloe_sft.py (NeuronSFTTrainer LoRA on config.BASE_MODEL)  -->  chloe_lora/

What it does:
  - Builds a breadth of short object descriptions by crossing OBJECTS x ADJECTIVES
    (objects = the semantics behind config.NODES + the 35 CAELLUM labels; adjectives =
    heavy/light/tiny/giant/fast/slow/rapid-fire/explosive/... ).
  - For each description, calls Claude (model claude-haiku-4-5) with config.SYSTEM_PROMPT +
    config.node_menu() as the system and the description as the user message, asking for a
    JSON mechanic spec (pick ONE node, fill its clamped params).
  - Parses the JSON out of the reply (strips ```json fences); on parse failure, retries once
    then skips. ALWAYS runs the parsed spec through config.clamp_spec() before writing, so every
    training target is a valid, in-range spec (the safety net).
  - Writes one SFT chat row per line to data/chloe_pairs.jsonl:
        {"messages": [{system}, {user: description}, {assistant: clamped spec string}]}
    flushing after each row so a crash leaves a valid partial dataset.

Verified Anthropic SDK usage (teacher call):
    from anthropic import Anthropic
    client = Anthropic()                      # reads ANTHROPIC_API_KEY from env
    client.messages.create(model="claude-haiku-4-5", max_tokens=400,
                           system=<SYSTEM_PROMPT + node_menu()>,
                           messages=[{"role": "user", "content": description}])

Example invocation (run from the repo root so `import config` works; or anywhere on Colab):
    export ANTHROPIC_API_KEY=sk-ant-...
    python data/gen_chloe_dataset.py --out data/chloe_pairs.jsonl --n 2000 --concurrency 8
    # smaller smoke run:
    python data/gen_chloe_dataset.py --n 40 --concurrency 4

Output:
    data/chloe_pairs.jsonl   # one JSON chat row per line (system, user, assistant)
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


# --------------------------------------------------------------------------------------
# config import — single source of truth on machines that have the repo; mirrored fallback
# for Colab/Kaggle where there's no checkout. We add services/chloe to sys.path so a plain
# `import config` resolves to services/chloe/config.py (same module the Neuron/serve side uses).
# --------------------------------------------------------------------------------------
def _load_config():
    """Return the chloe config module. Prefer the real services/chloe/config.py (so the
    teacher targets match what serve.py clamps to); fall back to mirrored constants on Colab."""
    here = Path(__file__).resolve()
    # repo layout: <repo>/data/gen_chloe_dataset.py  ->  <repo>/services/chloe/config.py
    chloe_dir = here.parent.parent / "services" / "chloe"
    if (chloe_dir / "config.py").is_file():
        sys.path.insert(0, str(chloe_dir))
        try:
            import config  # type: ignore

            return config
        except Exception as exc:  # pragma: no cover - defensive; fall through to mirror
            print(f"[chloe] WARNING: failed to import services/chloe/config.py ({exc}); "
                  f"using mirrored constants.")
    else:
        print("[chloe] note: services/chloe/config.py not found (Colab?); "
              "using mirrored constants. KEEP IN SYNC with that file.")
    return _MirroredConfig()


# --- MIRROR OF services/chloe/config.py (used only when the real file isn't importable) ----
# KEEP IN SYNC with services/chloe/config.py (NODES, SYSTEM_PROMPT, node_menu, clamp_spec).
class _MirroredConfig:
    BASE_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"

    NODES = {
        "projectile_weapon": {
            "speed": ("float", 400, 1600, 1100), "damage": ("float", 3, 20, 8),
            "kbBase": ("float", 10, 60, 22), "kbScale": ("float", 0.03, 0.25, 0.09),
            "angle": ("float", -30, 30, 0), "gravity": ("float", 0, 1600, 0),
            "life": ("float", 0.4, 3.0, 1.3), "r": ("float", 6, 28, 13),
            "cooldown": ("float", 0.1, 1.5, 0.3),
        },
        "throwable": {
            "speed": ("float", 300, 1100, 760), "damage": ("float", 6, 28, 15),
            "kbBase": ("float", 20, 70, 44), "kbScale": ("float", 0.05, 0.3, 0.17),
            "angle": ("float", 5, 45, 22), "gravity": ("float", 600, 2200, 1500),
            "life": ("float", 0.8, 3.0, 2.2), "r": ("float", 10, 32, 20),
            "cooldown": ("float", 0.3, 1.5, 0.7),
        },
        "melee_weapon": {
            "reach": ("float", 30, 90, 55), "damage": ("float", 6, 22, 12),
            "kbBase": ("float", 18, 60, 34), "kbScale": ("float", 0.05, 0.25, 0.13),
            "angle": ("float", -20, 60, 20), "cooldown": ("float", 0.2, 0.8, 0.34),
        },
        "heal": {"amount": ("float", 5, 60, 30)},
        "buff": {"effect": ("enum", ["invuln", "speed", "power"], "invuln"),
                 "dur": ("float", 2, 10, 5)},
        "hazard": {"damage": ("float", 3, 25, 10), "radius": ("float", 20, 120, 50)},
        "bouncy": {"bounce": ("float", 600, 2200, 1300)},
    }

    SYSTEM_PROMPT = (
        "You assign game mechanics to objects a player DREW in a 2D platform fighter. Given a short "
        "description of the drawn object, choose exactly ONE node from the library and fill its numeric "
        "params so the object FEELS like the description (heavy=slow+strong+big cooldown, tiny=fast+weak, "
        "rapid-fire=low cooldown, etc.). Stay within each param's range. Reply with ONLY a JSON object: "
        '{"node": <node>, "params": {...}, "name": "<short name>", "flavor": "<one short line>"}. No prose.'
    )

    def node_menu(self) -> str:
        lines = []
        for node, params in self.NODES.items():
            parts = []
            for k, spec in params.items():
                if spec[0] == "enum":
                    parts.append(f"{k}:one of {spec[1]}")
                else:
                    parts.append(f"{k}:{spec[1]}..{spec[2]}")
            lines.append(f"- {node}: {{{', '.join(parts)}}}")
        return "NODE LIBRARY:\n" + "\n".join(lines)

    def clamp_spec(self, spec: dict) -> dict:
        node = (spec or {}).get("node")
        if node not in self.NODES:
            raise ValueError(f"unknown node: {node!r} (must be one of {list(self.NODES)})")
        schema = self.NODES[node]
        raw = (spec.get("params") or {})
        out = {}
        for key, s in schema.items():
            if s[0] == "enum":
                _, choices, default = s
                v = raw.get(key, default)
                out[key] = v if v in choices else default
            else:
                _, lo, hi, default = s
                try:
                    v = float(raw.get(key, default))
                except (TypeError, ValueError):
                    v = default
                out[key] = max(lo, min(hi, v))
        return {
            "node": node,
            "params": out,
            "name": str(spec.get("name", node))[:40],
            "flavor": str(spec.get("flavor", ""))[:120],
        }
# --------------------------------------------------------------------------------------


# --------------------------------------------------------------------------------------
# Vocabulary — OBJECTS x ADJECTIVES gives breadth. Objects span the semantics behind
# config.NODES (held weapons, throwables, melee, food/heal, buffs, hazards, bouncy) PLUS the
# 35 CAELLUM labels (KEEP IN SYNC with data/gen_teacher.py CATEGORIES). The model must MAP each
# to one node, so we list nouns broadly and let Claude pick the node — that's the supervision.
# --------------------------------------------------------------------------------------
OBJECTS = [
    # ranged / projectile
    "gun", "pistol", "rifle", "blaster", "cannon", "bow", "crossbow", "slingshot",
    "ray gun", "dart gun", "nerf gun", "laser",
    # throwables
    "bomb", "grenade", "ball", "rock", "boulder", "bottle", "dart", "snowball",
    "throwing knife", "shuriken", "pebble", "stick of dynamite",
    # melee
    "sword", "knife", "dagger", "bat", "hammer", "mallet", "axe", "club", "spear",
    "frying pan", "wand", "staff",
    # food / heal
    "apple", "bread", "cake", "banana", "burger", "potion", "fruit", "sandwich",
    "mushroom", "cookie", "pizza slice",
    # buffs
    "star", "heart", "gem", "crown", "crystal", "shield charm", "lucky clover",
    "power orb", "halo",
    # hazards
    "spikes", "saw", "saw blade", "fire", "flame", "trap", "bear trap", "thorns",
    "lava blob", "buzzsaw", "landmine",
    # bouncy
    "spring", "trampoline", "bounce pad", "rubber ball", "jelly cube", "pogo stick",
    # misc destructibles the player might draw
    "crate", "barrel", "balloon", "key", "coin", "cloud", "block", "plank",
]

ADJECTIVES = [
    "heavy", "light", "tiny", "giant", "huge", "small", "fast", "slow", "rapid-fire",
    "explosive", "powerful", "weak", "bouncy", "spiky", "glowing", "sharp", "blunt",
    "magic", "rusty", "golden", "icy", "fiery", "electric", "poison", "sticky",
    "wobbly", "razor", "armored", "feather-light", "supercharged", "cursed", "blessed",
    "double-barreled", "long-range", "short-range", "homing", "piercing", "fragile",
    "sturdy", "ancient", "shiny", "deadly", "gentle", "cheap", "deluxe",
]


def build_descriptions(n: int, seed: int) -> list[str]:
    """Build up to `n` UNIQUE short descriptions by crossing adjectives x objects.

    We sample without replacement from the full cross product (plus some bare-object and
    two-adjective variants for variety), so each call site is distinct and reproducible.
    """
    rng = random.Random(seed)
    descs: list[str] = []
    seen: set[str] = set()

    def add(text: str) -> None:
        text = " ".join(text.split())  # normalize whitespace
        if text and text not in seen:
            seen.add(text)
            descs.append(text)

    # bare objects (lets the model learn the default node for each noun)
    bare = list(OBJECTS)
    rng.shuffle(bare)
    for obj in bare:
        add(f"a {obj}")

    # full single-adjective cross product, shuffled
    pairs = [(adj, obj) for adj in ADJECTIVES for obj in OBJECTS]
    rng.shuffle(pairs)
    for adj, obj in pairs:
        if len(descs) >= n:
            break
        add(f"a {adj} {obj}")

    # two-adjective variants to top up breadth if n is large
    while len(descs) < n:
        adj1, adj2 = rng.sample(ADJECTIVES, 2)
        obj = rng.choice(OBJECTS)
        before = len(descs)
        add(f"a {adj1} {adj2} {obj}")
        if len(descs) == before:
            # cross product exhausted enough that we keep colliding; stop to avoid a spin.
            # (only happens if n far exceeds the available unique combinations)
            if len(seen) >= len(OBJECTS) * (1 + len(ADJECTIVES) + 200):
                break
    return descs[:n]


# --------------------------------------------------------------------------------------
# JSON extraction — strip ```json / ``` fences and pull the first {...} object out of the text.
# --------------------------------------------------------------------------------------
def extract_json(text: str) -> dict:
    """Parse a JSON object out of a model reply, tolerating code fences / surrounding prose.

    Raises ValueError if no valid JSON object can be recovered (caller retries once, then skips).
    """
    s = (text or "").strip()
    # strip a leading ```json / ``` fence and trailing ``` if present
    if s.startswith("```"):
        s = s.split("```", 2)
        # s == ["", "json\n{...}\n", ...] or ["", "{...}\n", ...]
        body = s[1] if len(s) > 1 else ""
        if body.lower().startswith("json"):
            body = body[4:]
        s = body.strip()
        # drop any trailing closing fence remnants
        if s.endswith("```"):
            s = s[:-3].strip()

    # fast path: the whole thing is the JSON object
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    # fallback: grab the first balanced {...} span
    start = s.find("{")
    if start == -1:
        raise ValueError("no JSON object found in reply")
    depth = 0
    for i in range(start, len(s)):
        c = s[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                candidate = s[start:i + 1]
                obj = json.loads(candidate)  # may raise JSONDecodeError -> caller handles
                if not isinstance(obj, dict):
                    raise ValueError("recovered JSON is not an object")
                return obj
    raise ValueError("unbalanced JSON object in reply")


# --------------------------------------------------------------------------------------
# Teacher call — one description -> one clamped spec dict (or None to skip).
# --------------------------------------------------------------------------------------
def teacher_spec(client, model: str, system: str, description: str, config) -> dict | None:
    """Ask Claude for a spec for `description`, parse + clamp it. Retry a parse/clamp failure
    once, then return None to skip. Network/SDK errors propagate (worker logs + skips)."""
    last_err = None
    for attempt in range(2):  # one retry on parse/clamp failure
        msg = client.messages.create(
            model=model,
            max_tokens=400,
            system=system,
            messages=[{"role": "user", "content": description}],
        )
        # concatenate any text blocks in the reply
        text = "".join(getattr(b, "text", "") for b in msg.content)
        try:
            spec = extract_json(text)
            return config.clamp_spec(spec)  # the safety net — guarantees a valid target
        except (ValueError, json.JSONDecodeError) as exc:
            last_err = exc
            continue
    print(f"[chloe] skip {description!r}: bad spec after retry ({last_err})")
    return None


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Distill Claude into SFT chat rows for CHLOE (data/chloe_pairs.jsonl).",
    )
    p.add_argument("--out", type=str, default="data/chloe_pairs.jsonl",
                   help="Output JSONL path (default: data/chloe_pairs.jsonl).")
    p.add_argument("--n", type=int, default=2000,
                   help="Target number of rows / descriptions (default: 2000).")
    p.add_argument("--model", type=str, default="claude-haiku-4-5",
                   help="Anthropic teacher model id (default: claude-haiku-4-5).")
    p.add_argument("--concurrency", type=int, default=8,
                   help="Number of parallel teacher requests (default: 8).")
    p.add_argument("--seed", type=int, default=0,
                   help="Seed for the description sampler (reproducible runs; default: 0).")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit(
            "ERROR: ANTHROPIC_API_KEY is not set. Export your Anthropic API key first:\n"
            "    export ANTHROPIC_API_KEY=sk-ant-..."
        )

    # Import the SDK lazily so --help works without `anthropic` installed.
    try:
        from anthropic import Anthropic
    except ImportError:
        raise SystemExit(
            "ERROR: the `anthropic` package is not installed. Run:\n    pip install anthropic"
        )

    config = _load_config()
    system = config.SYSTEM_PROMPT + "\n\n" + config.node_menu()
    client = Anthropic()  # reads ANTHROPIC_API_KEY from env

    descriptions = build_descriptions(args.n, args.seed)
    total = len(descriptions)
    print(f"[chloe] generating up to {total} rows "
          f"({len(OBJECTS)} objects x {len(ADJECTIVES)} adjectives) "
          f"via {args.model} @ concurrency={args.concurrency} -> {args.out}")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    written = 0
    skipped = 0
    done = 0
    lock = threading.Lock()  # serialize writes + the shared counters across worker threads

    with out_path.open("w", encoding="utf-8") as out, \
            ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = {
            pool.submit(teacher_spec, client, args.model, system, desc, config): desc
            for desc in descriptions
        }
        for fut in as_completed(futures):
            desc = futures[fut]
            try:
                spec = fut.result()
            except Exception as exc:  # network/SDK/rate-limit error for this description
                spec = None
                print(f"[chloe] skip {desc!r}: teacher error ({exc})")

            with lock:
                done += 1
                if spec is None:
                    skipped += 1
                else:
                    # SFT chat row: system + user(description) + assistant(clamped spec string).
                    # The assistant content is compact JSON so the student learns to emit JSON.
                    row = {
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": desc},
                            {"role": "assistant",
                             "content": json.dumps(spec, separators=(",", ":"))},
                        ]
                    }
                    out.write(json.dumps(row, ensure_ascii=False) + "\n")
                    out.flush()  # crash-safe: a partial file is still valid JSONL
                    written += 1
                if done % 25 == 0 or done == total:
                    print(f"[chloe] {done}/{total}  written={written}  skipped={skipped}")

    print(f"[chloe] DONE. wrote {written} rows ({skipped} skipped) -> {out_path}")
    if written:
        print(f"[chloe] next: train with train/train_chloe_sft.py --data {out_path}")


if __name__ == "__main__":
    main()
