# Doodle Smash

A hand-drawn 2D platform fighter (Super Smash Bros–inspired) rendered in a charcoal
"soft marker" doodle style. Vanilla HTML5 Canvas + JavaScript — **no build, no deps**.

See [GOAL.md](GOAL.md) for the project's north star: a **live creation game** where players draw
characters, weapons, and hazards on an iPad and an AI pipeline injects them — refined and
functional — into a projected match in real time. Runtime design: [docs/13](docs/13-ai-pipeline.md).

**Working on this?** Read [`docs/`](docs/) first — especially
[`docs/02-aesthetic-rules.md`](docs/02-aesthetic-rules.md), the visual contract that keeps the
whole game looking hand-drawn. It documents the architecture, mechanics, the character rig, the
draw tool, how to extend things, and the dev workflow.

## Run it

Just open `index.html` in a browser (double-click it, or drag it into Chrome).
No server or install needed.

### MagicBoard drawing

Local desktop and iPad testing can stay on HTTP:

```bash
cd backend
cp .env.example .env
# fill OPENAI_API_KEY and MAGICBOARD_VLM_MODEL for VLM classification
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

cd ../draw-client
npm install
npm run dev -- --host 0.0.0.0

cd ..
npm install
npm start
```

Open the desktop game with `?backend=http://YOUR-LAN-IP:8000&drawClient=http://YOUR-LAN-IP:5173/`, then open the draw client on the iPad. The flow is doodle first: VLM classification can auto-confirm platform/spike/etc. candidates, and the iPad manual choice menu is the fallback when classification fails or is unavailable.

Provider keys belong only in `backend/.env`; do not put OpenAI keys in `draw-client/.env`.

### Phone controllers (optional)
To let people **join by scanning a QR code** and use their phone as a controller (a landscape
Brawlhalla-style pad — D-pad + jump/attack buttons + a special-aim joystick, up to 6 per lobby),
run the bundled server:
```
npm install      # one time (ws + qrcode, server-only)
npm start        # → http://localhost:8080
```
Open that URL, hit **≡ Menu → Players** for the QR, and point a phone at it. Deploy `server.js` to
any Node host (with HTTPS) for play across the internet. Full details: [docs/11](docs/11-online-controllers.md).
(The game itself still runs from `file://` with the keyboard — the server is only for phone controllers.)

Optional URL hashes (handy for testing/demos; not the long-term product entry point):
- `index.html#play` — jump straight into a match
- `index.html#demo` — attract-mode: two AI fighters battle on their own
- `index.html#editor` — open the editor (`#editor-stage`, `#editor-settings` for sub-tabs)

## Controls (2 players, one keyboard)

| | Player 1 | Player 2 |
|---|---|---|
| Move | `A` / `D` | `←` / `→` |
| Jump (×2) | `W` | `↑` |
| Crouch / drop-through | `S` | `↓` |
| Attack (melee) | `F` | `.` |
| Special (ranged) | `G` | `/` |
| Shield | `Left Shift` | `Right Shift` |

`Enter` start / rematch · `P` pause · `?` (top-right) shows this in-app.

Mechanics: run, double jump, fast-fall (hold down in air), drop through soft platforms
(down on a pass-through platform), shield, a melee attack and a ranged **Special** (throws a
projectile), all with frame data, percent-scaled knockback by weight, stocks (hearts),
blast-zone KOs, respawn, match timer.

## Modes & maps

Open the **≡ Menu** (top-right, also shown on load) to pick a **mode** and a **map**:

- **Smash** — the classic; knock rivals off the stage, last one with stocks wins.
- **King of the Hill** — stand alone on the high platform to bank time; first to 12s. Infinite respawns.
- **Gem Grab** — slow-drifting gems float through the air; first to grab 5.
- **K.O. Rush** — no stocks; every knockout scores, first to 5 K.O.s.

Maps: **Meadow** (the editable Editor stage), **Twin Peaks**, **Sky Loft**, **Quarry**, **Ruins** —
big themed arenas with background structures, plants, several material types, **swinging platforms**
you can ride, and **breakable crates**. Modes and maps are small registries in `js/modes.js` — see
[docs/10](docs/10-modes-and-maps.md) to add more.

## Editor

Click the **Editor** tab. Everything is editable and saved to your browser (localStorage);
use **Export/Import** to move setups between machines.

- **Characters** — pick a character + action (idle/walk/jump/attack/…), then reshape its
  pose with the joint sliders (the big canvas preview updates live). Tune stats
  (speed, jumps, weight, size) and, for attack/special, the hitbox + frame data.
- **Draw** — draw your own fighter over a faint "ghost" body. Each stroke is auto-sorted
  into the body part it lands on (head, body, both arms, both legs); lock a part with the
  buttons, or undo/clear. Because the drawing rigs onto the same skeleton, your character
  instantly animates through *every* move. Toggle "use drawing" off to fall back to the
  built-in stick figure. (Each part = vector strokes stored relative to its joint.)
- **Stage** — drag platforms to move them, drag a platform's bottom-right corner to resize,
  drag the dotted circles to reposition spawns, add/remove platforms, toggle pass-through.
- **Settings** — gravity, timer, stocks, knockback scale, hitstop.

## Code map

| File | Role |
|---|---|
| `js/data.js` | Data model (characters/poses, stage, settings) + localStorage store. Single source of truth. |
| `js/draw.js` | Rough "marker" Canvas2D renderer + offscreen pose-cache + paper texture. |
| `js/character.js` | Parametric doodle fighter: pose (joint angles) → line-art (used until a character has a drawn skin). |
| `js/skin.js` | User-drawn "skins": 6 hand-drawn parts rigged to the same joints; stroke→part auto-assignment; mannequin guide. |
| `js/physics.js` | AABB platformer collision (solid + pass-through). |
| `js/fighter.js` | Movement, jumps, attacks, hitboxes, knockback, KO, render. |
| `js/stage.js` | Platforms + doodle decorations. |
| `js/modes.js` | Game modes (Smash/KotH/Gems/K.O. Rush) + map presets, as data-driven registries. |
| `js/effects.js` | Juice: particles, screen shake, hitstop, KO bursts. |
| `js/game.js` | Match flow, active mode/map, HUD (timer/%/hearts/scores/portraits), overlays, attract AI. |
| `js/editor.js` | The editor tab. |
| `js/main.js` | Canvas/DPR sizing, tabs, frame loop. |

## Notes toward the AI creation pipeline

- **Skin / stage / mechanic data is plain and serializable.** AI-generated content (vector strokes,
  `data.stage.platforms` rectangles, mechanic specs) flows through the same seams the editor uses, so
  the drawing pipeline, agents, and the editor all produce the data the game reads. See
  [docs/13](docs/13-ai-pipeline.md).
- **Rendering is isolated** behind `draw.js`; `draw.getCached()` pose-caches to offscreen canvases so
  per-frame cost stays low when many drawn entities are on screen.
- **(Optional, far-future)** a computer-vision module could also generate `data.stage.platforms` from
  detected real-world surfaces through the same seam — a nicety, not the goal. See
  [docs/08](docs/08-roadmap-and-cv-ar.md).
