# Phase 1: Static Platform Drawing Bridge

Phase 1 uses a static, platform-only reference layer instead of embedding a second live Doodle Smash match.

The goal is for the iPad/browser drawing surface to have a fixed 1920 x 1080 coordinate frame with only the current level's gameplay platforms visible behind the drawing layer. The laptop game still receives the drawing as a live, non-mutating overlay.

## What This Phase Does

The intended flow is:

1. The laptop opens the existing vanilla Doodle Smash game.
2. The game opts into a creation-overlay room with `?overlay=<room>`.
3. The draw client opens the same room.
4. The draw client displays a static platform-only reference layer inside a 1920 x 1080 game frame.
5. The user draws over those platforms to describe level edits, characters, hazards, labels, or gameplay intent.
6. The draw client sends:
   - canonical tldraw capture data;
   - derived game-view projection data.
7. The backend stores the latest capture/projection for that room and broadcasts updates.
8. The already-open game page receives the projection over WebSocket and renders it over the actual game canvas.

Phase 1 does **not** mutate `DS.Store.data`. It is visual communication only.

## Superseded Direction

The previous implementation direction embedded a live game page inside the draw client. That is now deprecated for Phase 1 because it creates a second simulation with independent timers, fighters, camera, and match state. Even when the coordinates are correct, the iPad and laptop can appear visually different.

The revised Phase 1 reference layer must be:

- static;
- platform-only by default;
- fixed camera;
- fixed 1920 x 1080 view-space coordinates;
- free of HUD, timer, fighters, projectiles, effects, countdown, and dynamic camera motion.

The draw client should not need an iframe pointed at `#play` for its normal reference view. It should consume a stage/platform reference representation and draw that behind tldraw.

## Removed/Replaced Legacy Direction

The old milestone treated the draw client as a standalone tldraw persistence demo. That is no longer the product direction.

The active contract is now projection-based:

- old message: `canvas_snapshot`;
- new message: `canvas_capture`;
- old endpoint: `/rooms/{room_id}/snapshot`;
- new endpoint: `/rooms/{room_id}/capture`;
- old behavior: reload tldraw snapshot;
- new behavior: draw client sends projection and game renders overlay live.

The tldraw snapshot still exists as canonical capture data, but the game consumes only the derived projection.

## Backend Functionality

Files:

- `backend/app/main.py`
- `backend/app/rooms.py`
- `backend/app/schemas.py`
- `backend/tests/test_api.py`

Endpoints:

- `GET /health`
- `GET /rooms/{room_id}/capture`
- `WebSocket /ws/rooms/{room_id}`

Room state contains:

- `roomId`
- `version`
- `capture`
- `projection`
- `updatedAt`
- `recentEvents`

WebSocket messages:

```json
{
  "type": "canvas_capture",
  "capture": {},
  "projection": {},
  "clientId": "optional",
  "sentAt": "optional"
}
```

```json
{
  "type": "projection_updated",
  "roomId": "demo",
  "version": 1,
  "updatedAt": "...",
  "projection": {},
  "sourceClientId": "optional"
}
```

New WebSocket subscribers receive the latest projection in the initial `hello`.

## Draw Client Functionality

Files:

- `draw-client/src/App.jsx`
- `draw-client/src/styles.css`
- `js/stageReferenceData.js`

The draw client now:

- shows a static platform-only Doodle Smash reference inside the 1920 x 1080 drawing frame;
- keeps the game frame locked in tldraw so drawings share the game's view-space coordinates;
- uses a fixed camera centered on the authored view, not the live match camera;
- hides all live-match-only visuals such as fighters, timer, HUD, effects, particles, countdown, and projectiles;
- loads existing room capture, if present;
- keeps tldraw capture as canonical source data;
- derives a projection from tldraw shapes;
- sends capture/projection over WebSocket;
- shows status, room, backend version, room version, object count, and sync time.

The backend URL comes from a `backend` query parameter, `VITE_BACKEND_URL`, or a default inferred from the current browser host on port `8000`.

The static platform reference comes from the shared Meadow/default stage platform data in `js/stageReferenceData.js`, not from a second live `#play` game instance.

Projection currently supports:

- freehand draw strokes;
- basic geo shapes;
- text/note labels.

Projection coordinates are normalized into game view space.

## Game Overlay Functionality

Files:

- `js/createOverlay.js`
- `index.html`
- `js/game.js`
- `js/main.js`

The game overlay is opt-in:

```text
http://localhost:8080/?overlay=demo&backend=http://localhost:8000#play
```

When enabled, it:

- connects to the backend room;
- receives the latest projection;
- renders projection strokes/shapes/labels over the game canvas;
- adds a small HUD status line;
- supports `O` to toggle overlay visibility;
- does not mutate `DS.Store.data`.

Overlay render placement:

- drawing projection renders in view space, aligned to the same 1920 x 1080 coordinate frame used by the draw client;
- HUD status renders in the view-space HUD layer.

## Acceptance Criteria

Phase 1 should be considered complete when all of the following are true:

- Backend tests pass.
- Draw client build passes.
- Draw client shows a static platform-only reference layer.
- Reference layer uses fixed 1920 x 1080 view-space coordinates.
- Reference layer has no timer, fighters, HUD, projectiles, effects, countdown, or dynamic camera.
- User drawings align with the platform reference on the iPad/browser.
- Same drawings appear aligned over the laptop game canvas.
- Backend `/rooms/{room_id}/capture` version increases after drawing.
- The existing game remains playable with the overlay disabled.

Manual walkthrough to perform after implementation:

1. Opened laptop game with an empty overlay room.
2. Confirmed game overlay WebSocket connected with version `0`.
3. Opened draw client in same room.
4. Confirmed draw client debug panel showed connected.
5. Confirmed the static platform reference was visible inside the draw-client frame.
6. Drew a platform-like stroke over the platform reference.
7. Checked backend `/capture` endpoint and confirmed projection objects existed.
8. Confirmed the already-open game page received projection version updates without reload.
9. Compared before/after screenshots and confirmed visible canvas change.

Suggested artifacts from the walkthrough:

- `/tmp/magicboard-phase1-before.png`
- `/tmp/magicboard-phase1-after.png`
- `/tmp/draw-static-platform-reference.png`

## How To Test Manually

Terminal 1:

```sh
cd /Users/chloehouvardas/Documents/CODE/berkley-2026/magicboard/backend
UV_CACHE_DIR=../.uv-cache .venv/bin/uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Terminal 2:

```sh
cd /Users/chloehouvardas/Documents/CODE/berkley-2026/magicboard
npm start
```

Open on laptop:

```text
http://localhost:8080/?overlay=demo&backend=http://localhost:8000#play
```

Terminal 3:

```sh
cd /Users/chloehouvardas/Documents/CODE/berkley-2026/magicboard/draw-client
npm run dev -- --host 0.0.0.0
```

Open the Vite URL it prints, usually:

```text
http://localhost:5173/?room=demo
```

Draw inside the orange 1920 x 1080 frame. The drawing should appear over the laptop game canvas.
The static platform-only reference should be visible inside that frame while you draw.

Backend state:

```text
http://localhost:8000/rooms/demo/capture
```

`version` should increase and `projection.strokes`, `projection.shapes`, or `projection.labels` should contain objects.

## iPad Test

Find laptop LAN IP:

```sh
ipconfig getifaddr en0
```

Start draw client:

```sh
cd /Users/chloehouvardas/Documents/CODE/berkley-2026/magicboard/draw-client
npm run dev -- --host 0.0.0.0
```

Open on iPad:

```text
http://YOUR_LAPTOP_LAN_IP:5173/?room=demo
```

Keep the laptop game open at:

```text
http://localhost:8080/?overlay=demo&backend=http://localhost:8000#play
```

Draw on iPad. The laptop game canvas should update.

## Known Limits

- Projection is visual only. It does not become platforms or characters yet.
- The static reference currently tracks the default editable Meadow platform layout; later phases can add map/stage selection.
- The game overlay renders strokes, boxes/ellipses, and labels; it does not interpret meaning.
- Phase 2 must build the clarification agent and candidate model.

## Next Phase

Phase 2 should add the clarification agent loop:

1. Read latest capture/projection.
2. Extract candidate objects.
3. Ask bounded questions.
4. Track answers against capture version.
5. Produce a scene plan.
6. Do not patch game data yet.
