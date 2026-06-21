#!/usr/bin/env python3
"""
CHLOE dataset generator — RULE-BASED teacher (no API key needed).

ENV: anywhere with Python 3.10+ (no GPU, no Anthropic key). Produces the SAME output format as
data/gen_chloe_dataset.py (the Claude-teacher version), so train/train_chloe_sft.py reads it
unchanged. Use this when you don't have an Anthropic API key — the "teacher reasoning"
(heavy=slow+strong, rapid-fire=low-cooldown+weak, ...) is encoded as deterministic rules instead
of per-example LLM calls. Self-contained = a cleaner Trainium-track story (no external dependency).

    gen_chloe_dataset_rules.py  ──rules──►  data/chloe_pairs.jsonl (SFT chat rows)
                                                   │
    train/train_chloe_sft.py (NeuronSFTTrainer LoRA on config.BASE_MODEL)  ──►  chloe_lora/

Each row: {"messages": [{system: SYSTEM_PROMPT+node_menu()}, {user: description},
{assistant: clamped spec string}]}. Every target is run through config.clamp_spec() so it is valid.

Example:
    python data/gen_chloe_dataset_rules.py --out data/chloe_pairs.jsonl --n 2000 --seed 42
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path

# import the single source of truth (NODES, SYSTEM_PROMPT, node_menu, clamp_spec)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "chloe"))
import config  # noqa: E402

# --- objects per node (the "what the player drew") ---------------------------------------
OBJECTS = {
    "projectile_weapon": ["gun", "pistol", "rifle", "blaster", "ray gun", "laser gun", "bow",
                          "crossbow", "slingshot", "revolver", "shotgun", "dart gun", "cannon", "musket"],
    "throwable": ["bomb", "grenade", "ball", "rock", "boulder", "bottle", "throwing knife",
                  "shuriken", "dynamite", "snowball", "fireball", "brick"],
    "melee_weapon": ["sword", "knife", "dagger", "bat", "club", "hammer", "axe", "mace",
                     "katana", "spear", "staff", "wrench"],
    "heal": ["apple", "bread", "cake", "food", "sandwich", "fruit", "burger", "pizza",
             "medkit", "herb", "soup", "potion"],
    "buff": ["star", "heart", "gem", "crown", "lightning bolt", "mushroom", "wings", "clover"],
    "hazard": ["spikes", "saw", "fire", "lava", "trap", "mine", "thorns", "bear trap", "cactus"],
    "bouncy": ["spring", "trampoline", "bouncy pad", "jelly", "mushroom", "bounce pad"],
}

# --- adjectives -> per-param multipliers (only applied to params the node actually has) ----
ADJ = {
    "heavy":     {"damage": 1.6, "kbBase": 1.5, "speed": 0.65, "cooldown": 1.5, "r": 1.3, "reach": 1.2, "amount": 1.4, "radius": 1.3, "bounce": 1.2},
    "light":     {"damage": 0.75, "speed": 1.3, "cooldown": 0.7, "r": 0.85, "reach": 0.85, "amount": 0.75},
    "tiny":      {"damage": 0.6, "speed": 1.4, "cooldown": 0.6, "r": 0.6, "reach": 0.7, "amount": 0.6, "radius": 0.6, "bounce": 0.7},
    "giant":     {"damage": 1.7, "kbBase": 1.6, "speed": 0.6, "cooldown": 1.6, "r": 1.5, "reach": 1.5, "amount": 1.6, "radius": 1.6, "bounce": 1.4},
    "huge":      {"damage": 1.6, "kbBase": 1.5, "speed": 0.65, "cooldown": 1.5, "r": 1.4, "reach": 1.4, "amount": 1.5, "radius": 1.5, "bounce": 1.4},
    "fast":      {"speed": 1.5, "cooldown": 0.7, "life": 0.85},
    "quick":     {"speed": 1.4, "cooldown": 0.65},
    "slow":      {"speed": 0.6, "cooldown": 1.4},
    "rapid-fire": {"cooldown": 0.35, "damage": 0.6, "speed": 1.1},
    "automatic": {"cooldown": 0.4, "damage": 0.65},
    "powerful":  {"damage": 1.6, "kbBase": 1.5, "amount": 1.5, "radius": 1.3, "bounce": 1.3},
    "strong":    {"damage": 1.5, "kbBase": 1.4, "amount": 1.4},
    "weak":      {"damage": 0.6, "kbBase": 0.7, "amount": 0.6, "radius": 0.7, "bounce": 0.75},
    "explosive": {"damage": 1.5, "kbBase": 1.6, "r": 1.5, "radius": 1.6},
    "long-range": {"speed": 1.5, "life": 1.8},
    "sniper":    {"speed": 1.6, "life": 2.0, "cooldown": 1.3, "damage": 1.3},
    "deadly":    {"damage": 1.7, "kbBase": 1.4},
    "gentle":    {"damage": 0.5, "kbBase": 0.6, "amount": 0.7},
    "super":     {"damage": 1.4, "speed": 1.2, "amount": 1.4, "bounce": 1.3},
    "mega":      {"damage": 1.6, "kbBase": 1.5, "r": 1.4, "amount": 1.6, "bounce": 1.4},
    "rusty":     {"damage": 0.7, "cooldown": 1.25},
    "tiny but mighty": {"damage": 1.5, "speed": 1.3, "r": 0.7, "cooldown": 0.8},
    "bouncy":    {"bounce": 1.4, "kbScale": 1.2},
}

# buff effect chosen from the description (overrides the default invuln)
BUFF_EFFECT = {
    "speed": ["fast", "quick", "rapid-fire", "wings", "lightning bolt"],
    "power": ["powerful", "strong", "deadly", "mega", "super", "star"],
    "invuln": ["shield", "heart", "clover", "gem", "crown", "mushroom"],
}

def article(word: str) -> str:
    return "an" if word[:1].lower() in "aeiou" else "a"


def title(s: str) -> str:
    return " ".join(w.capitalize() for w in s.split())[:40]


def flavor_for(node: str, adjs: list[str]) -> str:
    tag = " ".join(adjs)
    base = {
        "projectile_weapon": "fires a shot", "throwable": "thrown, then it lands",
        "melee_weapon": "a close swing", "heal": "restores health", "buff": "a temporary boost",
        "hazard": "hurts on contact", "bouncy": "bounces you up",
    }[node]
    return (f"{tag} — {base}").strip(" —")[:120]


def build_spec(node: str, obj: str, adjs: list[str], rnd: random.Random) -> dict:
    schema = config.NODES[node]
    params = {}
    for key, s in schema.items():
        if s[0] == "enum":
            # buff effect: pick from the adjectives/object, else default
            choice = s[2]
            if key == "effect":
                tokens = set(adjs) | {obj}
                for eff, words in BUFF_EFFECT.items():
                    if tokens & set(words):
                        choice = eff
                        break
            params[key] = choice
        else:
            _, lo, hi, default = s
            mult = 1.0
            for a in adjs:
                mult *= ADJ.get(a, {}).get(key, 1.0)
            val = default * mult * rnd.uniform(0.9, 1.1)   # jitter so the model doesn't memorize
            params[key] = round(max(lo, min(hi, val)), 3)
    spec = {"node": node, "params": params, "name": title(" ".join(adjs + [obj])),
            "flavor": flavor_for(node, adjs)}
    return config.clamp_spec(spec)   # the safety net — always valid + in range


def main() -> None:
    ap = argparse.ArgumentParser(description="Rule-based CHLOE SFT dataset (no API key).")
    ap.add_argument("--out", default="data/chloe_pairs.jsonl")
    ap.add_argument("--n", type=int, default=2000, help="target rows (default 2000)")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    rnd = random.Random(args.seed)

    system = config.SYSTEM_PROMPT + "\n\n" + config.node_menu()
    adjs_all = list(ADJ.keys())

    # enumerate (node, object, adjective-combo, template) -> description, then shuffle + cap.
    rows, seen = [], set()
    plan = []
    for node, objs in OBJECTS.items():
        for obj in objs:
            combos = [[]]                                   # bare object
            combos += [[a] for a in adjs_all]               # one adjective
            for _ in range(6):                              # a few two-adjective combos
                combos.append(rnd.sample(adjs_all, 2))
            for adjs in combos:
                plan.append((node, obj, adjs))
    rnd.shuffle(plan)

    for node, obj, adjs in plan:
        if len(rows) >= args.n:
            break
        if len(adjs) == 0:                       # bare object -> bare description AND default spec
            desc = rnd.choice([f"{article(obj)} {obj}", obj])
        elif len(adjs) == 1:
            a0 = adjs[0]
            desc = rnd.choice([f"{article(a0)} {a0} {obj}", f"{obj} that is {a0}", f"{article(a0)} {a0} {obj}"])
        else:
            desc = f"{article(adjs[0])} {adjs[0]}, {adjs[1]} {obj}"
        desc = " ".join(desc.split())          # tidy whitespace/commas for bare/one-adj
        if desc in seen:
            continue
        seen.add(desc)
        spec = build_spec(node, obj, adjs, rnd)
        rows.append({"messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": desc},
            {"role": "assistant", "content": json.dumps(spec, separators=(",", ":"))},
        ]})

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    # quick node histogram so you can see the balance
    from collections import Counter
    hist = Counter(json.loads(r["messages"][2]["content"])["node"] for r in rows)
    print(f"[chloe-rules] wrote {len(rows)} rows -> {args.out}")
    print(f"[chloe-rules] node balance: {dict(hist)}")
    print("[chloe-rules] example:", rows[0]["messages"][1]["content"], "->", rows[0]["messages"][2]["content"])


if __name__ == "__main__":
    main()
