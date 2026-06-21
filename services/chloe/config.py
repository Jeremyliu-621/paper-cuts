"""
CHLOE — bounded mechanic-spec contract (single source of truth).

CHLOE maps a drawn object's DESCRIPTION -> a JSON "mechanic spec": it picks ONE node from a
fixed library and fills that node's numeric/enum params. The spec is DATA, never code — the game
already runs it (a ranged/throwable spec IS the engine's projectile cfg, so the host calls
world.spawnProjectile(holder, params, aim) with zero translation).

NODES mirrors js/mechanics.js DEFAULTS/ARCHETYPE (keep them in sync). Params are clamped to the
ranges here at serve time, so a hallucinated/garbage number can never break the match.
"""

# ---- the model CHLOE fine-tunes (small instruct LLM: Trainium SFT-LoRA + fast inference) ----
BASE_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"   # fallback: meta-llama/Llama-3.2-1B-Instruct

# ---- the bounded node library: node -> {param: (type, min, max, default)} ----
# (enum params use ("enum", [choices...], default).) A spec fills exactly one node's params.
NODES = {
    # held weapons --------------------------------------------------------------------------
    "projectile_weapon": {  # gun / bow / blaster — hold + fire a projectile
        "speed":   ("float", 400, 1600, 1100), "damage": ("float", 3, 20, 8),
        "kbBase":  ("float", 10, 60, 22),       "kbScale": ("float", 0.03, 0.25, 0.09),
        "angle":   ("float", -30, 30, 0),       "gravity": ("float", 0, 1600, 0),
        "life":    ("float", 0.4, 3.0, 1.3),    "r": ("float", 6, 28, 13),
        "cooldown": ("float", 0.1, 1.5, 0.3),
    },
    "throwable": {  # bomb / ball / rock — arcs, impacts/explodes
        "speed": ("float", 300, 1100, 760), "damage": ("float", 6, 28, 15),
        "kbBase": ("float", 20, 70, 44),    "kbScale": ("float", 0.05, 0.3, 0.17),
        "angle": ("float", 5, 45, 22),      "gravity": ("float", 600, 2200, 1500),
        "life": ("float", 0.8, 3.0, 2.2),   "r": ("float", 10, 32, 20),
        "cooldown": ("float", 0.3, 1.5, 0.7),
    },
    "melee_weapon": {  # sword / bat / hammer — short fast strike
        "reach": ("float", 30, 90, 55), "damage": ("float", 6, 22, 12),
        "kbBase": ("float", 18, 60, 34), "kbScale": ("float", 0.05, 0.25, 0.13),
        "angle": ("float", -20, 60, 20), "cooldown": ("float", 0.2, 0.8, 0.34),
    },
    # consumables / effects -----------------------------------------------------------------
    "heal": {"amount": ("float", 5, 60, 30)},                                   # food/fruit
    "buff": {"effect": ("enum", ["invuln", "speed", "power"], "invuln"),        # star/heart
             "dur": ("float", 2, 10, 5)},
    # environment ---------------------------------------------------------------------------
    "hazard": {"damage": ("float", 3, 25, 10), "radius": ("float", 20, 120, 50)},  # spikes/saw
    "bouncy": {"bounce": ("float", 600, 2200, 1300)},                              # spring/pad
}

# The spec the model emits (validated + clamped against NODES at serve time):
#   {"node": <one of NODES>, "params": {<that node's fields>}, "name": "<short>", "flavor": "<1 line>"}

SYSTEM_PROMPT = (
    "You assign game mechanics to objects a player DREW in a 2D platform fighter. Given a short "
    "description of the drawn object, choose exactly ONE node from the library and fill its numeric "
    "params so the object FEELS like the description (heavy=slow+strong+big cooldown, tiny=fast+weak, "
    "rapid-fire=low cooldown, etc.). Stay within each param's range. Reply with ONLY a JSON object: "
    '{"node": <node>, "params": {...}, "name": "<short name>", "flavor": "<one short line>"}. No prose.'
)


def node_menu() -> str:
    """Compact menu of nodes + params (with ranges) for the prompt."""
    lines = []
    for node, params in NODES.items():
        parts = []
        for k, spec in params.items():
            if spec[0] == "enum":
                parts.append(f"{k}:one of {spec[1]}")
            else:
                parts.append(f"{k}:{spec[1]}..{spec[2]}")
        lines.append(f"- {node}: {{{', '.join(parts)}}}")
    return "NODE LIBRARY:\n" + "\n".join(lines)


def clamp_spec(spec: dict) -> dict:
    """Validate + clamp a model-emitted spec to NODES. Raises ValueError if the node is unknown;
    fills missing params with defaults and clamps out-of-range / wrong-type values. SAFE to run."""
    node = (spec or {}).get("node")
    if node not in NODES:
        raise ValueError(f"unknown node: {node!r} (must be one of {list(NODES)})")
    schema = NODES[node]
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


# ---- serve config ----
PORT = 8500
MECHANIC_ENDPOINT = "/mechanic"   # POST {description|label} -> {node, params, name, flavor}
HEALTH_ENDPOINT = "/healthz"
