# Doodle Smash — Documentation

This folder is the brain for anyone (especially a future Claude session) picking up this
project. Read these in order; **`02-aesthetic-rules.md` is the most important file** — it is
the visual contract that keeps the game looking like one coherent hand-drawn world.

| File | What it covers |
|---|---|
| [00-vision.md](00-vision.md) | What this is, who it's for, the AR/CV endgame, current state. |
| [01-architecture.md](01-architecture.md) | Code map, module responsibilities, data flow, the core principle. |
| [02-aesthetic-rules.md](02-aesthetic-rules.md) | **The visual bible.** Palette, fonts, stroke style, do/don'ts. Obey this. |
| [03-gameplay-and-mechanics.md](03-gameplay-and-mechanics.md) | Fighting mechanics, frame data, knockback math, feel, tuning. |
| [04-character-rig-and-skins.md](04-character-rig-and-skins.md) | The skeleton/pose model, parametric figures, draw-your-own skins. |
| [05-editor.md](05-editor.md) | Editor tabs and how editing maps to data. |
| [06-extending.md](06-extending.md) | How to add a character / move / stage piece / control. Recipes. |
| [07-rendering-and-coordinates.md](07-rendering-and-coordinates.md) | Coordinate spaces, DPR, letterbox, pose cache, gotchas. |
| [08-roadmap-and-cv-ar.md](08-roadmap-and-cv-ar.md) | The CV/AR pivot, backlog, known limitations. |
| [09-conventions-and-dev-workflow.md](09-conventions-and-dev-workflow.md) | Code style, running, testing, git, dev URL hooks. |
| [10-modes-and-maps.md](10-modes-and-maps.md) | Game modes + map presets registries, the main menu, how to add either. |
| [11-online-controllers.md](11-online-controllers.md) | Lobbies + phone controllers: the server, the QR/controller page, the WS relay, input routing. |
| [13-ipad-drawing-capture-and-editor-seams.md](13-ipad-drawing-capture-and-editor-seams.md) | Drawing capture, projection, and existing editor/game seams. |
| [14-visual-creation-phases.md](14-visual-creation-phases.md) | Four-phase creation architecture: drawing bridge, clarification agent, scene patching, asset enhancement. |
| [15-creation-patch-contract.md](15-creation-patch-contract.md) | Proposed typed patch contract for approved scene edits. |
| [16-agent-clarification-loop.md](16-agent-clarification-loop.md) | Accept/reject/ask loop and scene-plan contract. |

## 30-second orientation
- Vanilla **HTML5 Canvas 2D + JS**, no build, no deps. Open `index.html` (or serve it).
- Hand-drawn **charcoal-on-paper doodle** look, generated procedurally (no image assets).
- Local 2-player platform fighter, Smash-style. Plus a **Draw** tool to make your own fighters.
- Built so a **visual creation layer** and later CV/AR modules can feed game-valid scene data into the same runtime.
- Single source of truth: `js/data.js` `Store` (localStorage). Editor writes it, game reads it.

## Golden rules (the short version)
1. **Never break the aesthetic.** Monochrome charcoal, rough marker strokes, warm paper. See `02`.
2. **The rig is constant; the art is swappable.** Stick figures and hand-drawn skins share one skeleton.
3. **Everything is data and editable.** New tunables go in `data.js` and get an editor control.
4. **Keep it cheap.** 60fps with headroom; all drawing goes through `js/draw.js`.
5. **Verify by screenshot.** No console in normal runs — use the dev URL hooks + on-page banner (see `09`).
