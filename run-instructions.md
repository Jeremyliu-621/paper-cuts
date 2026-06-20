# Run Instructions

These commands run the current Phase 1 creation bridge: draw over a visible Doodle Smash scene in the draw client, and see that drawing as a non-mutating overlay on the existing Doodle Smash game canvas.

Copy commands as full lines. If your terminal wraps a long command visually, do not press Enter in the middle of flags like `--host`.

## First-Time Setup

From the repo root:

```sh
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install uv
UV_CACHE_DIR=../.uv-cache .venv/bin/uv sync
```

Then install frontend/game packages:

```sh
cd ../draw-client
npm install
cd ..
npm install
```

## Terminal 1: Backend

From the repo root:

```sh
cd backend
UV_CACHE_DIR=../.uv-cache .venv/bin/uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Health check:

```sh
curl http://localhost:8000/health
```

Expected response:

```json
{"ok":true,"version":"0.1.0"}
```

## Terminal 2: Existing Game With Overlay

From the repo root:

```sh
npm start
```

Open this on your laptop:

```text
http://localhost:8080/?overlay=demo&backend=http://localhost:8000#play
```

The `overlay=demo` query enables the creation overlay for room `demo`. Press `O` to toggle overlay visibility. The overlay does not mutate game data.

## Terminal 3: Draw Client

From the repo root:

```sh
cd draw-client
npm run dev -- --host 0.0.0.0
```

Open the Vite URL it prints. Usually:

```text
http://localhost:5173/?room=demo
```

If Vite says it used another port, use that port instead.

Draw inside the orange 1920 x 1080 game frame. Your drawing should appear over the laptop game canvas.
The Doodle Smash scene should be visible inside the drawing frame so you can align your drawing with the actual level.
By default, the draw client loads the game scene from the same host on port `8080`.

Inspect backend capture state:

```text
http://localhost:8000/rooms/demo/capture
```

After drawing, `projection.strokes`, `projection.shapes`, or `projection.labels` should contain objects and `version` should increase.

## iPad Testing

The iPad must use the laptop's LAN IP address, not `localhost`.

Find your laptop LAN IP. On macOS, this often works:

```sh
ipconfig getifaddr en0
```

If it prints `10.31.151.244`, start the draw client like this:

```sh
cd draw-client
npm run dev -- --host 0.0.0.0
```

When the iPad opens the draw client from `10.31.151.244`, the draw client automatically uses:

- backend: `http://10.31.151.244:8000`
- game reference: `http://10.31.151.244:8080/#play`

Open on the laptop:

```text
http://localhost:8080/?overlay=demo&backend=http://localhost:8000#play
```

Open on the iPad:

```text
http://10.31.151.244:5173/?room=demo
```

Replace `10.31.151.244` and `5173` with your actual IP and Vite port. Draw on the iPad; the laptop game canvas should show the overlay.

If you need to override the backend manually, add it to the iPad URL:

```text
http://10.31.151.244:5173/?room=demo&backend=http://10.31.151.244:8000
```
