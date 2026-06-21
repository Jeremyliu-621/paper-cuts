"""
CHLOE — composable mechanic-GRAPH contract (Python mirror of js/graph.js DS.Graph).

This is the evolution of config.py's single-node spec: CHLOE now COMPOSES primitives (effects)
under triggers into a graph. A few dozen parts -> thousands of behaviors, all SAFE by construction
(every op is a pre-wired engine function — no eval, no codegen). `clamp_graph()` is the serve-time
safety net (same role `config.clamp_spec` plays today): it validates structure + clamps every param,
so a hallucinated graph can never break a match.

KEEP IN SYNC with js/graph.js (EFFECTS param ranges, TRIGGERS, STATUSES, BUFFS, ELEMENTS).
Both sides clamp, so small drift only costs quality, never safety.

Graph shape:
    {"name": "...", "flavor": "...", "tags": ["fire"],
     "on": {"fire": [{"op":"projectile","speed":1200,"damage":9}],
            "hit":  [{"op":"status","kind":"burn","dur":3}]}}
"""

# ---- vocab (mirror js/graph.js) ----
TRIGGERS = ["fire", "hit", "land", "timer", "pickup", "expire"]
STATUSES = ["burn", "freeze", "shock", "poison", "slow", "root", "weaken"]
BUFFS = ["invuln", "speed", "power"]
ELEMENTS = ["fire", "water", "ice", "electric", "plant", "rock", "wind", "metal", "poison", "light", "dark"]

MAX_EFFECTS_PER_TRIGGER = 4
MAX_TAGS = 2

# ---- the primitive library: op -> {param: (type, ...)} ----
# types: ("float", lo, hi, default) | ("int", lo, hi, default) | ("enum", [choices], default) | ("bool", default)
EFFECTS = {
    # ranged ------------------------------------------------------------------------------
    "projectile": {"speed": ("float", 200, 1800, 1000), "damage": ("float", 0, 30, 8),
                   "kbBase": ("float", 0, 80, 22), "kbScale": ("float", 0.02, 0.35, 0.09),
                   "angle": ("float", -60, 60, 0), "gravity": ("float", 0, 2400, 0),
                   "life": ("float", 0.3, 4, 1.3), "r": ("float", 4, 34, 13),
                   "homing": ("bool", False), "pierce": ("bool", False), "bouncy": ("bool", False),
                   "explosive": ("bool", False), "aoeRadius": ("float", 20, 160, 60)},
    "spread": {"count": ("int", 2, 9, 3), "arc": ("float", 0, 90, 24),
               "speed": ("float", 200, 1800, 900), "damage": ("float", 0, 30, 6),
               "gravity": ("float", 0, 2400, 0), "life": ("float", 0.3, 4, 1.1),
               "r": ("float", 4, 34, 11), "homing": ("bool", False)},
    "nova": {"count": ("int", 3, 16, 8), "speed": ("float", 200, 1800, 700),
             "damage": ("float", 0, 30, 7), "life": ("float", 0.3, 4, 1.4), "r": ("float", 4, 34, 12)},
    "beam": {"range": ("float", 100, 1400, 800), "width": ("float", 10, 60, 26),
             "damage": ("float", 1, 35, 14), "kbBase": ("float", 0, 80, 24)},
    "melee": {"reach": ("float", 30, 90, 50), "damage": ("float", 0, 30, 12),
              "kbBase": ("float", 0, 80, 34), "kbScale": ("float", 0.02, 0.35, 0.13), "angle": ("float", -20, 60, 6)},
    # area --------------------------------------------------------------------------------
    "aoe": {"radius": ("float", 20, 260, 80), "damage": ("float", 0, 40, 12),
            "kbBase": ("float", 0, 80, 30), "kbScale": ("float", 0.02, 0.35, 0.12), "angle": ("float", 0, 80, 40)},
    "shockwave": {"radius": ("float", 60, 320, 160), "damage": ("float", 0, 30, 9), "kbBase": ("float", 20, 80, 50)},
    "chain": {"jumps": ("int", 1, 5, 2), "range": ("float", 80, 400, 220), "damage": ("float", 1, 25, 8)},
    # control -----------------------------------------------------------------------------
    "status": {"kind": ("enum", STATUSES, "burn"), "dur": ("float", 0.5, 8, 3)},
    "knockback": {"force": ("float", 0, 90, 40), "angle": ("float", -30, 80, 30)},
    "pull": {"radius": ("float", 40, 320, 160), "force": ("float", 100, 1400, 600)},
    "push": {"radius": ("float", 40, 320, 160), "force": ("float", 100, 1600, 700)},
    "bounce": {"force": ("float", 600, 2400, 1300)},
    # support / self ----------------------------------------------------------------------
    "heal": {"amount": ("float", 0, 80, 30)},
    "buff": {"effect": ("enum", BUFFS, "invuln"), "dur": ("float", 0, 12, 5)},
    "shield": {"dur": ("float", 0.5, 8, 3)},
    "dash": {"force": ("float", 200, 1400, 700), "up": ("float", 200, 1200, 500)},
    "lifesteal": {"amount": ("float", 1, 30, 8)},
    "summon": {"count": ("int", 1, 6, 3), "speed": ("float", 200, 1800, 700),
               "damage": ("float", 0, 30, 6), "life": ("float", 0.3, 4, 2.4)},
    "hazardField": {"radius": ("float", 24, 160, 60), "damage": ("float", 3, 25, 10)},
}


def _clamp_effect(eff):
    """Validate + clamp ONE effect. Keep op + only-its-known params (clamped); drop unknowns.
    Returns None if the op is unknown (caller skips it). Lean output = clean training targets;
    the JS interpreter fills any omitted param with its own default."""
    if not isinstance(eff, dict):
        return None
    op = eff.get("op")
    spec = EFFECTS.get(op)
    if spec is None:
        return None
    out = {"op": op}
    for key, s in spec.items():
        if key not in eff:
            continue                      # omitted -> JS default; keep targets lean
        kind = s[0]
        if kind == "enum":
            out[key] = eff[key] if eff[key] in s[1] else s[2]
        elif kind == "bool":
            out[key] = bool(eff[key])
        else:
            _, lo, hi, d = s
            try:
                v = float(eff[key])
            except (TypeError, ValueError):
                v = d
            v = max(lo, min(hi, v))
            out[key] = int(round(v)) if kind == "int" else round(v, 3)
    return out


def clamp_graph(graph):
    """Validate + clamp a model-emitted graph to the schema. SAFE to run on anything.
    Drops unknown ops/triggers/params, clamps numerics, filters tags to known elements, and
    guarantees the item DOES something (falls back to a basic shot if nothing valid survives)."""
    graph = graph or {}
    tags = [t for t in (graph.get("tags") or []) if t in ELEMENTS][:MAX_TAGS]
    on = {}
    raw_on = graph.get("on") or {}
    if isinstance(raw_on, dict):
        for trig, effects in raw_on.items():
            if trig not in TRIGGERS or not isinstance(effects, list):
                continue
            clamped = []
            for eff in effects[:MAX_EFFECTS_PER_TRIGGER]:
                ce = _clamp_effect(eff)
                if ce:
                    clamped.append(ce)
            if clamped:
                on[trig] = clamped
    if not on:                            # nothing valid -> a safe default so every item is playable
        on = {"fire": [{"op": "projectile"}]}
    return {
        "name": str(graph.get("name", "thing"))[:40],
        "flavor": str(graph.get("flavor", ""))[:120],
        "tags": tags,
        "on": on,
    }


def graph_menu():
    """Compact menu of triggers + primitives (with ranges) + elements for the system prompt."""
    lines = ["TRIGGERS: " + ", ".join(TRIGGERS)]
    lines.append("ELEMENTS (for `tags`, drive interactions like fire+water=fizzle): " + ", ".join(ELEMENTS))
    lines.append("EFFECTS (op: params):")
    for op, params in EFFECTS.items():
        parts = []
        for k, s in params.items():
            if s[0] == "enum":
                parts.append(f"{k}:one of {s[1]}")
            elif s[0] == "bool":
                parts.append(f"{k}:bool")
            else:
                parts.append(f"{k}:{s[1]}..{s[2]}")
        lines.append(f"  - {op}: {{{', '.join(parts)}}}")
    return "\n".join(lines)


SYSTEM_PROMPT = (
    "You design game mechanics for objects a player DREW in a 2D platform fighter. Given a short "
    "description, COMPOSE a mechanic GRAPH: pick element tags and, under each relevant trigger, a short "
    "list of effects from the library so the object FEELS like the description (heavy=slow+strong, "
    "rapid-fire=low cooldown, freeze gun=projectile+freeze-on-hit, bomb=aoe-on-land, etc.). Use only the "
    "listed ops, triggers, elements, and params; stay within ranges. Reply with ONLY a JSON object: "
    '{"name":"<short>","flavor":"<one line>","tags":[<elements>],"on":{<trigger>:[{"op":...,...}]}}. No prose.'
)

# serve config (same wire contract as config.py)
MECHANIC_ENDPOINT = "/mechanic"
HEALTH_ENDPOINT = "/healthz"
PORT = 8500
