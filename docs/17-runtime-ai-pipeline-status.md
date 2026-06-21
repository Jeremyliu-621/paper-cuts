# 17 — Runtime AI Creation Pipeline: Status, Decisions & Setbacks

**Last updated:** 2026-06-21 (Cal Hacks weekend). This is a living status/handoff doc for the
runtime "draw → playable game object" pipeline. Read this before touching the AI props code so you
don't re-litigate settled decisions or re-walk dead ends.

---

## 0. TL;DR — where we are right now

A kid draws something on the in-game **Draw pad** (press `D`) → it drops in instantly as a placeholder
→ within ~8–13s it's recognized, given real **mechanics**, and swapped for a **clean doodle game
asset**. Two players can draw weapons/elements and fight with them live.

**The pipeline (current, working):**
```
draw strokes
  → recognize  (CNN :8600 fast-path, instant; VLM fallback for unknowns)
  → [ in parallel once we have the label ]
      ├─ sprite:  Recraft v3 text-to-image (clean doodle from the label)
      │           → client connected-components isolation (drop bg + decoration blobs)
      └─ mechanic: CHLOE :8500 (composes a bounded mechanic GRAPH) — skipped for pure elements
  → swap the clean sprite + real mechanic onto the live prop
```

**Connect (browser console, after reload):**
```js
DS.AI.connectFal('http://localhost:8080/fal-enhance');     // sprite (Recraft via server proxy)
DS.AI.connectRecognizer('http://localhost:8600/recognize'); // CNN — instant fast-path
DS.AI.connectVLM('http://localhost:8080/vlm-recognize');    // open-vocab fallback
DS.AI.connectChloe('http://localhost:8500/mechanic');       // mechanics
```

---

## 1. The three "engines" and their status

| Engine | What it does | Status |
|---|---|---|
| **CHLOE** (Qwen3-0.6B + PEFT LoRA, served local :8500) | Turns a label/phrase → a **bounded, typed mechanic GRAPH** (ops × triggers × element tags). `js/graph.js` is the deterministic VM that runs it (no eval, clamped, safe-by-construction, composable). | ✅ **Core, in use.** Every mechanic comes from here. This is our real technical depth — *neuro-symbolic program synthesis for game mechanics*. |
| **RECOGNIZER** (25-class CNN, served local :8600) | 28×28 doodle → game label. Instant, free, offline. | ✅ In use as the **fast path** (see §3). Limited to 25 classes; mislabels OOD kid drawings. |
| **VLM** (OpenAI gpt-4.1-mini, `/vlm-recognize` on the game server) | Open-vocab recognition — reads *anything* ("a bare flame" → `fire`). | ✅ In use as **fallback** when the CNN isn't confident. ~5s, costs OpenAI credits. |
| **CAELLUM** (visual LoRA, `caellum_lora_out/`) | Was meant to enhance doodles into the game's hand-drawn aesthetic, on Trainium. | ❌ **Dropped.** See §4. |

---

## 2. The sprite pipeline (the hard-won part)

**Current:** `server.js /fal-enhance` → **Recraft v3 text-to-image** (`fal-ai/recraft/v3/text-to-image`,
style `digital_illustration/hand_drawn`) draws a *clean new doodle from the recognized word* → returns
the **raw** WebP → the client (`js/ai.js _isolateDoodle`) runs a **fast connected-components pass** that
keeps only the largest shape, turning the plain background AND Recraft's scattered decoration blobs
fully transparent.

- `FAL_GEN_MODE=text` (default) = text-to-image (clean asset). `FAL_GEN_MODE=image` = image-to-image
  (traces the doodle — kept only for comparison; **rejected**, see §3).
- `FAL_STYLE`, `FAL_STRENGTH` env-tunable. Old SDXL-controlnet path behind `FAL_PIPELINE=sdxl`.
- Recraft returns **WebP**, not PNG — `dataUrlFor()` sniffs the MIME so `<img>` decodes it.

**Why this shape (don't redo the dead ends):**
- **image-to-image just recolors the messy scribble** — the kid's wobbly lines survive; it never looks
  "clean." Rejected hard by the user. text-to-image draws it fresh and clean.
- **Recraft's `hand_drawn` style always adds a background** (clouds/sparkles/scene) — no prompt removes
  it. That's why we isolate client-side instead of trusting the prompt.
- **BiRefNet** (server-side ML cutout) grabbed the *wrong* region on thin-lined doodles → dropped.
- **@imgly** (ML cutout) ran ONNX on the main thread and **froze the game for seconds** → dropped.
- The **connected-components isolation** is the answer: pure JS, ~tens of ms, no model, drops bg +
  decorations reliably. Keeps only the largest blob (a multi-piece object loses its smaller pieces —
  acceptable for now; loosen the threshold in `_isolateDoodle` if it bites).

---

## 3. Latency & the recognition fast-path

End-to-end ≈ **8–13s** (the squiggly "magic working" FX in `js/prop.js` masks it):
- recognition: CNN ~0.1s (confident) **or** VLM ~5s (fallback)
- Recraft text-to-image ~8s (this is the floor; cloud)
- CHLOE ~1–2s (local, parallel)

**CNN fast-path** (`js/ai.js recognize()`): try the local CNN first; if `confident` (≥0.4) use it
(instant); else fall to the VLM. Common drawings of the 25 known things → ~8s total. Unknown/ambiguous
→ ~13s. This is the ~5s latency win we still get from the trained recognizer.

Sprite gen can't be parallelized with recognition anymore because **text-to-image needs the label
first** (we reverted the earlier parallelization).

---

## 4. Setbacks & the big decisions (the honest log)

- **Trainium went away when the hackathon event ended.** CAELLUM was trained/served on Trainium; we
  lost box access. Re-hosting locally stalled (HF download throttle, since resolved) and—more
  importantly—**the design goal changed.** CAELLUM was trained to *match the hand-drawn doodle
  aesthetic*; the product evolved to want *clean, polished game assets*. Those are opposite targets, so
  even a revived CAELLUM would produce the look we moved away from. **CAELLUM is dropped.**
- **Neuron consolidation bug:** the NeuronSFTTrainer saved a sharded adapter optimum-neuron couldn't
  fuse → we'd used no-Neuron vanilla PEFT for CHLOE.
- **Sprite quality saga** (multiple rounds): SDXL-controlnet ("way too detailed", framed) → Recraft i2i
  ("just recolors the scribble") → Recraft t2i + isolation ("clean doodle, finally right").
- **fp16 diffusion on MPS = rainbow noise** (see §6). Apple-GPU half-precision instability.
- **Status effects are a STUB:** the `status` op (burn/freeze/shock/poison/…) sets `fighter._status`
  but **nothing reads it**. Wiring it is easy but judged *not* a real wow-factor — parked.

---

## 5. Gameplay features added this session

- **Real melee swing:** drawn swords/axes now swing an arc hitbox in front of the holder (reuses the
  fighter's melee action) instead of firing a stub projectile. (`mechanics.js`, `prop.js`, `graph.js`.)
- **Elemental weapons that fire the drawing itself:** a drawn element (fire/water/ice/…) becomes a
  weapon that shoots **its own sprite** as an element-tagged projectile. Two elements from different
  players **clash** via the existing `DS.Graph.resolveContacts` reaction table (fire+water fizzle, fire
  beats plant and flies on, dark+light annihilate — 17 pairs). Pure elements **skip CHLOE** so they stay
  deterministic clashing projectiles.
- **Latency-masking FX:** the kid's drawing plays under an orbiting scratch-dash ring while enhancing,
  then bursts + pops into the clean sprite (`prop.js _scratchFx`).

---

## 6. Local real-time diffusion experiment (TESTED — conclusion below)

Goal: replace the ~8s cloud Recraft call with **on-device LCM-distilled diffusion** (depth flex +
latency). Stack tested: **SD1.5 + ControlNet-scribble (shape) + LCM-LoRA (4-step distillation)
[+ the trained CAELLUM LoRA]** on MPS. Test scripts: `/tmp/ds-localdiff*.py`, `/tmp/ds-caellum*.py`.

**Findings (extensive testing 2026-06-21):**
- **Download works** (earlier stall was transient).
- **fp16 on MPS → rainbow garbage** (Apple-GPU half-precision instability). Must use **fp32**.
- **fp32 ~1.3s/step** → 4 steps ≈ **5–6.5s** warm (competitive with ~8s cloud), ~14–20s one-time load/warmup.
- **The trained CAELLUM LoRA loads + stacks with LCM and runs locally** (`caellum_ok=True`). This is
  the meaningful win: *CAELLUM is alive again, on-device, distilled.*
- **Quality:** bold colorful doodle, decent — but **a notch below Recraft** and **inconsistent**
  (ControlNet hallucinates blobs from the scribble; results vary run-to-run).
- **The killer problem — backgrounds don't isolate.** SD1.5/ControlNet fills a **solid colored**
  background; the CAELLUM LoRA adds **lined/grid PAPER** (its training signature — kids draw on ruled
  paper). Neither is the white-with-detached-blobs that our `_isolateDoodle` (keep-largest) expects, so
  it keeps the background. A corner flood-fill helps on a *uniform* bg but not on grid/lined paper.

**CONCLUSION: local diffusion is a DEPTH/NARRATIVE asset, NOT a clean replacement for cloud Recraft.**
It's not faster, it's slightly uglier, and its backgrounds fight our cutout. **Keep Recraft as the
visible-demo path.** Use local-CAELLUM as (a) an **optional "100% on-device, no-cloud" mode** and (b)
the **pitch centerpiece**: *"we trained CAELLUM, and we run it fully on-device in real-time via LCM
consistency distillation + ControlNet shape-guidance — no API."* That claim is now **true and
demonstrated**.

To make it a *live* toggle: `services/caellum/serve_local.py` already exists — add the LCM-LoRA +
CAELLUM-LoRA stack, the anti-paper negative prompt, and a corner-flood-fill cutout, serve on :8400,
and `DS.AI.connect('http://localhost:8400/enhance')`. ~1 hour of work; do it only if you want the
on-device demo mode live (the depth *claim* stands either way).

**Aside / possible aesthetic pivot:** CAELLUM's paper-background "signature" could be embraced — render
drawn props as little **paper-card stickers** (doodle on paper) to match the game's paper world,
sidestepping the cutout entirely. That's a design change, not done.

---

## 7. Demo / "wow factor" strategy (Cal Hacks)

- **Trainium was never the wow** — judges never see infra. The wow is the **live multimodal creation
  loop** on screen.
- **Real depth to pitch:** CHLOE = *neuro-symbolic program synthesis* — a trained model that
  generates **executable, safety-bounded, composable game logic** from multimodal input, run by a
  deterministic VM (`graph.js`). Most teams ship a GPT wrapper; we trained a mechanic *synthesizer*.
- **Highest-wattage additions still on the table:** voice→game (teammate's voice scaffolding +
  CHLOE already takes text), camera→game (`campad.js`, real object → cutout → drop in), local
  distilled diffusion (§6, depth but execution-risky).

### Trainium cost (asked 2026-06-21)
- inf2.xlarge ≈ **$0.76/hr**, trn1.2xlarge ≈ **$1.34/hr** → a few hours of demo ≈ **$3–8**.
- Real cost is **time, not money**: inf2/trn1 vCPU **quota approval** (hours–days) + **Neuron
  compilation** of SDXL. And it'd run CAELLUM (doodle look) → **wouldn't help the clean-icon
  pipeline.** Recommendation: skip unless purely for a "served on Trainium" narrative.

---

## 8. Teammate's "finishers" — pointer for the separate agent

There is **no committed `finisher`/`fatality` feature** — the attempt didn't land in the tree. What
exists to build on:
- **KO system:** `js/fighter.js` `_ko` path (search `_ko`, `respawnT`, `stocks`); KO visuals in
  `js/effects.js` (the "Smash-style KO blast" doodle flame-jet, ~line 56; KO beam set-pieces).
- **KO boundary / camera:** `js/game.js` (KO boundary border ~line 423; "KO range" trembling ~line 919).
- **Dev KO harness:** `js/main.js` ~line 1508 ("fire a KO flame-jet and freeze a frame mid-blast").
- Modes that score on KO: `js/modes.js` (stocks, KO-to-score, gem-spill-on-KO).
- A "finisher" would most naturally hook the moment a hit would KO (in `fighter._takeHit`/`_ko`):
  trigger a special cinematic move/effect instead of the normal launch. Start there.

---

## 9. Files changed this session (all on `main`)

- `server.js` — `/fal-enhance` (Recraft t2i + raw return), `/vlm-recognize` (OpenAI vision),
  `openaiKey()`, `FAL_GEN_MODE`/`FAL_STYLE`/`FAL_STRENGTH`, merged with teammate's TLS/voice refactor.
- `js/ai.js` — VLM + CNN fast-path recognize(), `_isolateDoodle` (connected-components cutout),
  `dataUrlFor`, element-skips-CHLOE, enhance/scratch wiring, `connectVLM`.
- `js/mechanics.js` — `elementWeapon()` + `ELEMENT_LABELS` + `elementOf`; melee default → swing.
- `js/prop.js` — real melee swing in `fire()`; element projectile carries the sprite; scratch FX +
  reveal pop.
- `js/graph.js` — `melee` op = real swing; `attach()` threads the prop sprite onto graph projectiles.
- `js/game.js` — `_renderProjectiles` draws the projectile *as the drawing* (`useSprite`).

## 10. Running it
- Game server: `node server.js` (:8080) — needs `.env` (`FAL_KEY`) and `backend/.env`
  (`OPENAI_API_KEY`). Both gitignored.
- CHLOE: `services/chloe/serve.py` (:8500, local Qwen+LoRA backend).
- Recognizer: `services/recognizer/serve.py` (:8600).
- Local diffusion venv: `.venv-caellum` (torch 2.12, diffusers 0.38, MPS).
