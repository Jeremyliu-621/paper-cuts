#!/usr/bin/env python3
"""
CHLOE GRAPH dataset generator — RULE-BASED teacher (no API key needed).

The composable successor to data/gen_chloe_dataset_rules.py: instead of one node + params, each
target is a composed mechanic GRAPH (tags + triggers + effects from services/chloe/graph_config.py).
The "teacher reasoning" (freeze gun = projectile + freeze-on-hit, bomb = aoe-on-land, heavy = slower+
stronger, fire = burn-on-hit, ...) is encoded as deterministic rules. Every target is run through
graph_config.clamp_graph(), so it is always valid + in range.

    gen_chloe_graph_dataset.py  ──rules──►  data/chloe_graph_pairs.jsonl  ──►  train_chloe_peft.py

Each row: {"messages":[{system: SYSTEM_PROMPT+graph_menu()},{user: desc},{assistant: graph json}]}.

Example:
    python data/gen_chloe_graph_dataset.py --out data/chloe_graph_pairs.jsonl --n 2000 --seed 42
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "chloe"))
import graph_config as gc  # noqa: E402

# --- objects grouped by base archetype (the "what the player drew") -----------------------
OBJECTS = {
    "shooter":  ["gun", "pistol", "rifle", "blaster", "ray gun", "revolver", "dart gun", "musket"],
    "shotgun":  ["shotgun", "scattergun", "spread gun", "blunderbuss"],
    "launcher": ["rocket launcher", "grenade launcher", "cannon", "bazooka"],
    "thrown":   ["bomb", "grenade", "dynamite", "rock", "ball", "snowball", "brick"],
    "nova":     ["firework", "star bomb", "cluster bomb", "fireball"],
    "laser":    ["laser", "laser gun", "ray", "beam gun", "railgun"],
    "melee":    ["sword", "knife", "bat", "club", "hammer", "axe", "katana", "spear", "wrench"],
    "chainer":  ["lightning staff", "tesla coil", "thunder rod", "shock wand"],
    "vortex":   ["black hole gun", "vacuum gun", "gravity gun"],
    "repulsor": ["force gun", "push gun", "knockback hammer"],
    "healer":   ["apple", "bread", "medkit", "potion", "herb", "sandwich"],
    "buffer":   ["star", "crown", "power gem", "mushroom"],
    "shielder": ["shield", "barrier", "force field"],
    "spring":   ["spring", "trampoline", "bouncy pad"],
    "trap":     ["mine", "bear trap", "spike trap", "land mine"],
    "summoner": ["wand", "totem", "spirit bell", "summon staff"],
    "dasher":   ["boots", "jetpack", "dash gauntlet", "rocket boots"],
}

# --- element keyword -> (tag, on-hit status if any) ---------------------------------------
ELEMENT_WORDS = {
    "fire": (["fire", "flame", "flaming", "lava", "inferno", "burning"], "burn"),
    "ice": (["ice", "icy", "frost", "frozen", "snow", "freeze"], "freeze"),
    "poison": (["poison", "toxic", "venom", "acid"], "poison"),
    "electric": (["electric", "lightning", "thunder", "shock", "tesla"], "shock"),
    "water": (["water", "aqua", "wave", "tidal"], None),
    "wind": (["wind", "gust", "air", "storm"], None),
    "rock": (["rock", "stone", "earth", "boulder"], None),
    "metal": (["metal", "steel", "iron"], None),
    "plant": (["plant", "vine", "thorn", "leaf"], None),
    "light": (["light", "holy", "solar", "radiant"], None),
    "dark": (["dark", "shadow", "void", "cursed"], None),
}

# --- adjective -> per-field multipliers (applied only to fields an effect actually has) ----
ADJ = {
    "heavy":     {"damage": 1.6, "kbBase": 1.5, "speed": 0.7, "r": 1.3, "reach": 1.2, "force": 1.4, "amount": 1.4},
    "light":     {"damage": 0.75, "speed": 1.3, "r": 0.85, "reach": 0.85},
    "tiny":      {"damage": 0.6, "speed": 1.4, "r": 0.65, "count": 1.4},
    "giant":     {"damage": 1.7, "kbBase": 1.6, "speed": 0.65, "r": 1.5, "radius": 1.5, "force": 1.5},
    "fast":      {"speed": 1.5, "life": 0.9},
    "slow":      {"speed": 0.6},
    "rapid-fire": {"damage": 0.6, "count": 1.5, "speed": 1.1},
    "powerful":  {"damage": 1.6, "kbBase": 1.5, "radius": 1.3, "force": 1.4, "amount": 1.4},
    "weak":      {"damage": 0.6, "kbBase": 0.7, "force": 0.7, "amount": 0.7},
    "mega":      {"damage": 1.6, "kbBase": 1.4, "radius": 1.4, "count": 1.3},
    "deadly":    {"damage": 1.7, "kbBase": 1.4},
    "gentle":    {"damage": 0.5, "amount": 0.7},
    "long-range": {"speed": 1.4, "life": 1.7, "range": 1.4},
    "sniper":    {"speed": 1.6, "life": 1.9, "damage": 1.3, "range": 1.5},
}
# adjectives that flip a boolean modifier on projectiles
FLAG_ADJ = {"homing": "homing", "seeking": "homing", "piercing": "pierce", "explosive": "explosive", "bouncy": "bouncy"}


def base_graph(arch: str, rnd: random.Random) -> dict:
    """The base composed graph for an archetype (before adjective/element modulation)."""
    if arch == "shooter":
        return {"on": {"fire": [{"op": "projectile", "speed": 1150, "damage": 8, "r": 12}]}}
    if arch == "shotgun":
        return {"on": {"fire": [{"op": "spread", "count": 5, "arc": 30, "damage": 5, "speed": 950}]}}
    if arch == "launcher":
        return {"on": {"fire": [{"op": "projectile", "speed": 900, "damage": 10, "gravity": 300, "explosive": True, "aoeRadius": 70}],
                       "hit": [{"op": "aoe", "radius": 90, "damage": 14}]}}
    if arch == "thrown":
        return {"on": {"fire": [{"op": "projectile", "speed": 760, "damage": 8, "gravity": 1500, "angle": 22, "r": 18}],
                       "land": [{"op": "aoe", "radius": 90, "damage": 15}]}}
    if arch == "nova":
        return {"on": {"fire": [{"op": "projectile", "speed": 700, "damage": 5, "gravity": 1200, "angle": 24}],
                       "land": [{"op": "nova", "count": 8, "damage": 7, "speed": 700}]}}
    if arch == "laser":
        return {"on": {"fire": [{"op": "beam", "range": 900, "width": 26, "damage": 14}]}}
    if arch == "melee":
        return {"on": {"fire": [{"op": "melee", "reach": 55, "damage": 12, "kbBase": 34}]}}
    if arch == "chainer":
        return {"tags": ["electric"], "on": {"fire": [{"op": "projectile", "speed": 1200, "damage": 6}],
                                              "hit": [{"op": "chain", "jumps": 2, "range": 220, "damage": 8}]}}
    if arch == "vortex":
        return {"on": {"fire": [{"op": "pull", "radius": 180, "force": 700}]}}
    if arch == "repulsor":
        return {"on": {"fire": [{"op": "push", "radius": 160, "force": 800}]}}
    if arch == "healer":
        return {"on": {"pickup": [{"op": "heal", "amount": 30}]}}
    if arch == "buffer":
        return {"on": {"pickup": [{"op": "buff", "effect": rnd.choice(gc.BUFFS), "dur": 6}]}}
    if arch == "shielder":
        return {"on": {"pickup": [{"op": "shield", "dur": 5}]}}
    if arch == "spring":
        return {"on": {"land": [{"op": "bounce", "force": 1500}]}}
    if arch == "trap":
        return {"on": {"land": [{"op": "hazardField", "radius": 70, "damage": 12}]}}
    if arch == "summoner":
        return {"on": {"fire": [{"op": "summon", "count": 3, "damage": 6}]}}
    if arch == "dasher":
        return {"on": {"pickup": [{"op": "buff", "effect": "speed", "dur": 5}], "fire": [{"op": "dash", "force": 800}]}}
    return {"on": {"fire": [{"op": "projectile"}]}}


def modulate(graph: dict, adjs: list, rnd: random.Random) -> None:
    """Apply adjective multipliers (and boolean flags) to every numeric param present, in place."""
    flags = [FLAG_ADJ[a] for a in adjs if a in FLAG_ADJ]
    for effects in graph["on"].values():
        for eff in effects:
            for k in list(eff.keys()):
                if k in ("op", "kind", "effect") or isinstance(eff[k], bool):
                    continue
                mult = 1.0
                for a in adjs:
                    mult *= ADJ.get(a, {}).get(k, 1.0)
                if mult != 1.0:
                    eff[k] = round(eff[k] * mult * rnd.uniform(0.92, 1.08), 3)
            if eff["op"] in ("projectile", "spread", "summon"):
                for fl in flags:
                    eff[fl] = True
                    if fl == "explosive":
                        eff.setdefault("aoeRadius", 60)


def attach_element(graph: dict, element: str) -> None:
    """Tag the graph with its element and add a fitting on-hit status (fire->burn, ice->freeze...)."""
    if not element:
        return
    tags = graph.setdefault("tags", [])
    if element not in tags:
        tags.append(element)
    status = ELEMENT_WORDS[element][1]
    if status:
        graph["on"].setdefault("hit", [])
        if not any(e.get("op") == "status" for e in graph["on"]["hit"]):
            graph["on"]["hit"].append({"op": "status", "kind": status, "dur": 3})


def title(words: list) -> str:
    return " ".join(w.capitalize() for w in words if w)[:40] or "Thing"


def main() -> None:
    ap = argparse.ArgumentParser(description="Rule-based CHLOE GRAPH SFT dataset (no API key).")
    ap.add_argument("--out", default="data/chloe_graph_pairs.jsonl")
    ap.add_argument("--n", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    rnd = random.Random(args.seed)

    system = gc.SYSTEM_PROMPT + "\n\n" + gc.graph_menu()
    adjs_all = list(ADJ.keys()) + list(FLAG_ADJ.keys())
    elem_list = [None] + list(ELEMENT_WORDS.keys())

    # enumerate (archetype, object, element, adjective-combo) -> description + graph
    plan = []
    for arch, objs in OBJECTS.items():
        for obj in objs:
            for element in elem_list:
                combos = [[]] + [[a] for a in adjs_all]
                for _ in range(4):
                    combos.append(rnd.sample(adjs_all, 2))
                for adjs in combos:
                    plan.append((arch, obj, element, adjs))
    rnd.shuffle(plan)

    rows, seen = [], set()
    for arch, obj, element, adjs in plan:
        if len(rows) >= args.n:
            break
        ewords = ELEMENT_WORDS[element][0] if element else []
        eword = rnd.choice(ewords) if ewords else ""
        words = adjs + ([eword] if eword else []) + [obj]
        desc = " ".join(w for w in words if w)
        article = "an" if desc[:1].lower() in "aeiou" else "a"
        desc = f"{article} {desc}"
        if desc in seen:
            continue
        seen.add(desc)

        g = base_graph(arch, rnd)
        modulate(g, adjs, rnd)
        attach_element(g, element)
        g["name"] = title(words)
        g["flavor"] = f"{arch} — {' '.join(w for w in words if w)}"[:120]
        spec = gc.clamp_graph(g)   # the safety net: always valid + in range

        rows.append({"messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": desc},
            {"role": "assistant", "content": json.dumps(spec, separators=(",", ":"))},
        ]})

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    # stats
    op_hist, trig_hist, elem_hist = Counter(), Counter(), Counter()
    for r in rows:
        g = json.loads(r["messages"][2]["content"])
        for t, effs in g["on"].items():
            trig_hist[t] += 1
            for e in effs:
                op_hist[e["op"]] += 1
        for tag in g["tags"]:
            elem_hist[tag] += 1
    print(f"[chloe-graph] wrote {len(rows)} rows -> {args.out}")
    print(f"[chloe-graph] ops used: {dict(op_hist)}")
    print(f"[chloe-graph] triggers: {dict(trig_hist)}")
    print(f"[chloe-graph] elements: {dict(elem_hist)}")
    print(f"[chloe-graph] example: {rows[0]['messages'][1]['content']}  ->  {rows[0]['messages'][2]['content']}")


if __name__ == "__main__":
    main()
