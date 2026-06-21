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

**Current (`FAL_GEN_MODE=image`, the default):** `server.js /fal-enhance` → **Recraft v3
image-to-image** (`fal-ai/recraft/v3/image-to-image`, style `digital_illustration/hand_drawn`,
strength **0.72**) augments the kid's ALREADY-ISOLATED doodle → **Bria background removal**
(`fal-ai/bria/background/remove`) → client `_isolateDoodle` keep-largest drops detached blobs.
Result: clean isolated doodle on transparent, **preserving the kid's drawing**. ~11–12s/sprite.

**Why i2i, not t2i (reversed after testing):** `FAL_GEN_MODE=text` draws a clean redraw *from the
label* — but Recraft renders everyday objects (house/sun/heart) inside little **scenes** (a heart hung
between open windows!) that break the cutout. i2i can't invent a scene (it transforms the isolated
input), so it's reliably clean AND on-shape AND keeps the kid's creation (on-vision). `=text` still
available; it's only reliable for game-item words (sword/apple/shield).

**Suite tests (2026-06-21):**
- *16 game-item labels via t2i:* exposed the Recraft background lottery (stripes/grid/rain/scene).
  Fix = **Bria (saliency) + client keep-largest** two-stage cutout. Clean for common game items.
- *9 crude kid doodles (house, star, fish, sun, tree, flower, cat, heart, umbrella):* the realistic
  end-to-end test. **Recognition:** the VLM prompt was over-steering to a game-vocab list (→ house=crown,
  fish=ball, 3/9). Open-vocab prompt → **8/9** (only my lollipop-shaped "tree" was fair-wrong).
  **Generation:** t2i ~4/9 clean (scenes); **i2i 9/9 clean** → made i2i the default. Artifacts in
  `/tmp/doodles/`, `/tmp/doodles-i2i.png` (i2i) vs `/tmp/doodles-out.png` (t2i).

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

## 8. Teammate's cutting-edge features (LANDED 2026-06-21 — these are the real wow)

Two genuinely cutting-edge AI features got committed by the teammate (both wired into `index.html`):

- **AI KO finisher videos** — `js/finishers.js` + `backend/app/finishers.py` (`POST /finishers/jobs`,
  `GET /finishers/jobs/{id}`). On a final KO, captures the doodle fighter render and submits to **fal
  Pika (pikaffects v1.5 / pikaframes v2.2) / Kling motion-control** to generate a short cinematic
  finisher (styles: Melt, Explode, Dissolve, Squish, Tear, Crumble, Cake-ify). Real-time **AI video
  generation** as a game KO cut-in. Gameplay stays deterministic; the video is an optional cached
  cosmetic.
- **AR pose-recorded custom ultimates** — `js/ultimateRecorder.js`. Webcam → **MediaPipe pose
  landmarker** → doodle skeleton → record a ~2.2s move from your body → custom ultimate clip.
  "Gate ultimate recording on skeleton alignment" — actively being polished.

**These + draw→play + CHLOE = the demo.** Multimodal creation (draw + body) + a trained
mechanic-synthesis model + real-time AI video gen. No Trainium needed.

**Finisher TESTED 2026-06-21 — IT WORKS.** The "issues" the teammate hit were infra, not the feature:
1. **Backend wouldn't boot** — `agent_runtime.py` imports `openai` but the venv was never synced (no
   `uv` on this Mac). Fixed: `.venv/bin/pip install openai pillow certifi websockets python-dotenv`.
2. **Old/unfunded FAL_KEY.** Now using the funded key in `.env` + `backend/.env`.
- With both fixed: `POST /finishers/jobs` (Melt, sword doodle) → submitted → generated → `ready` with a
  real `video.url` in **~108s**. Frame check: it correctly animates the doodle (Melt). Pika model
  `fal-ai/pika/v1.5/pikaffects` via `queue.fal.run`.
- **Latency:** ~108s first time. **BUT it caches** — `_cache_key` is `attacker|style|victim|skinHash|
  source|motion|model` (NOT the captured frame), so the **2nd+ KO of the same skin+style is instant
  (0.04s)**. **Demo strategy: pre-warm each character's finisher once before going on stage.**
- Costs per Pika video (fal). MediaPipe AR recorder still needs a webcam test (can't do from CLI).
- (Note: the teammate **removed** `voice.py`; `DEEPGRAM_API_KEY` is in the env but unused now.)

**To run the backend:** `cd backend && .venv/bin/python -m uvicorn app.main:app --port 8000`
(reads `backend/.env`). If it fails on `No module named 'openai'`, run the pip install above.

Underlying KO hooks if you extend finishers: `fighter._takeHit`/`_ko`, KO blast in `effects.js` (~L56),
KO boundary in `game.js` (~L423).

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
