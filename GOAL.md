# GOAL — Doodle Smash

## The one-liner
A fast, great-looking, hand-drawn 2D platform fighter on the web that is built from day one to become an **AR layer**: computer vision detects real-world platforms (from a camera feed) and the game composites fighters and combat on top of them, in real time.

## Why this shape
- **Performance is the north star.** The endgame runs a live CV pipeline (camera → plane/platform detection → overlay) at interactive framerate. Rendering the game itself must be cheap so the CV budget is protected. Target a rock-solid 60fps with headroom.
- **Web is the right substrate** for that future: native camera access, mature real-time CV (MediaPipe / TensorFlow.js / WebGL), GPU compositing, and it runs anywhere (laptop, tablet, phone) with zero install.

## Pillars (in priority order)
1. **Quick.** 60fps with margin. Doodle strokes are rendered once into offscreen pose-caches and blitted; per-frame work is near-zero. Rendering sits behind an interface so a WebGL/AR-compositing backend can replace Canvas2D without touching game logic.
2. **Looks genuinely good — not "too simple."** Charcoal marker line-art on warm paper. Expressive characters with squash & stretch, secondary motion, idle breathing, blinks. Juice: hitstop, screen shake, impact starbursts, dust puffs, motion smears, KO blast-off. Handwritten HUD typography. It should read as a charming, polished hand-drawn fighter.
3. **Decent fighting-game mechanics.** Smash-style: run/dash, short/full hop, double jump, fast-fall, drop-through platforms, shielding, grabs; attacks with startup/active/recovery frames, hitboxes, damage %, percent-scaled knockback by weight, hitstun, stocks, blast-zone KOs, respawn. Feels responsive and fair.
4. **Everything editable.** An in-app Editor: reshape each character's pose per action (drag joints), tune stats and hitboxes, drag/resize/add platforms, set spawns and decorations, tweak global settings. Data is plain JSON, saved to localStorage with export/import. Play mode reads the same data live.
5. **Built for the AR pivot.** Stage geometry is data (platforms = rectangles/segments with positions), so a CV module can later *generate* that geometry from detected real-world surfaces and feed the exact same game. Keep a clean seam: `stage data` ← (authoring editor today | CV detector tomorrow).

## Default setup
- 2 human players on one keyboard (P1 vs P2), matching the reference.

## Definition of done (v1)
Opens by double-clicking `index.html`. Two doodle fighters battle on a doodle stage at 60fps with the mechanics above; juice and art look polished; the Editor can fully reshape characters/stage/settings and persist them. Architecture leaves obvious seams for the WebGL backend and the CV/AR stage-detector.
