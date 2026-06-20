# Phase 1: Drawing Bridge

Phase 1 is complete: drawings from the draw client can appear as a live, non-mutating overlay on the existing Doodle Smash game canvas.
The draw client also shows the Doodle Smash scene inside the drawing frame, so the user can draw directly on top of the visual game reference.

## What This Phase Does

The current flow is:

1. The laptop opens the existing vanilla Doodle Smash game.
2. The game opts into a creation-overlay room with `?overlay=<room>`.
3. The draw client opens the same room.
4. The draw client displays the Doodle Smash scene inside a 1920 x 1080 game frame.
5. The user draws over that scene reference.
6. The draw client sends:
   - canonical tldraw capture data;
   - derived game-view projection data.
7. The backend stores the latest capture/projection for that room and broadcasts updates.
8. The already-open game page receives the projection over WebSocket and renders it over the actual game canvas.

Phase 1 does **not** mutate `DS.Store.data`. It is visual communication only.

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

The draw client now:

- shows the Doodle Smash scene as a non-interactive background inside the 1920 x 1080 drawing frame;
- keeps the game frame locked in tldraw so drawings share the game's view-space coordinates;
- loads existing room capture, if present;
- keeps tldraw capture as canonical source data;
- derives a projection from tldraw shapes;
- sends capture/projection over WebSocket;
- shows status, room, backend version, room version, object count, and sync time.

The backend URL comes from a `backend` query parameter, `VITE_BACKEND_URL`, or a default inferred from the current browser host on port `8000`.

The game reference URL comes from a `game` query parameter, `VITE_GAME_URL`, or a default inferred from the current browser host on port `8080`. For example, opening the draw client at `http://10.31.151.244:5173/?room=demo` uses backend `http://10.31.151.244:8000` and loads the game reference from `http://10.31.151.244:8080/#play`.

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

- world overlay renders after fighters/effects/markers;
- HUD status renders in the view-space HUD layer.

## Verification Completed

Automated checks run:

- Backend tests: `6 passed`.
- Draw client build: passed.
- Playwright/Chromium installed and used for visual checks.
- Game overlay visual smoke: passed.
- Draw client visual smoke: passed.
- Draw-client-to-backend end-to-end: passed.
- Game receives draw-client projection: passed.
- Human-style walkthrough: passed.

Human-style walkthrough performed:

1. Opened laptop game with an empty overlay room.
2. Confirmed game overlay WebSocket connected with version `0`.
3. Opened draw client in same room.
4. Confirmed draw client debug panel showed connected.
5. Confirmed the Doodle Smash scene was visible inside the draw-client frame.
6. Drew a platform-like stroke over the scene.
7. Checked backend `/capture` endpoint and confirmed projection objects existed.
8. Confirmed the already-open game page received projection version updates without reload.
9. Compared before/after screenshots and confirmed visible canvas change.

Artifacts from the walkthrough were written to:

- `/tmp/magicboard-phase1-before.png`
- `/tmp/magicboard-phase1-after.png`
- `/tmp/draw-scene-bg.png`

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
The Doodle Smash scene should be visible inside that frame while you draw.

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
- The draw client does not show the live game scene behind the tldraw canvas yet; it shows a 1920 x 1080 frame that maps into the game view.
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
