# iPad Drawing Client Setup

Use your Mac's LAN IP on the iPad. Do not use `localhost` on the iPad; that points at the iPad itself.

## 1. Find Your Mac IP

On the Mac:

```sh
ipconfig getifaddr en0
```

If that prints nothing, try:

```sh
ipconfig getifaddr en1
```

In the examples below, replace `MAC_IP` with that address.

## 2. Start the Backend

From the repo root:

```sh
cd backend
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8001
```

Check it from the Mac:

```text
http://MAC_IP:8001/health
```

## 3. Start the Desktop Game

In a second terminal from the repo root:

```sh
PORT=8081 npm start
```

Open this on the Mac:

```text
http://MAC_IP:8081/?backend=http://MAC_IP:8001&drawClient=http://MAC_IP:5175/
```

Go to Library, choose a level, then click `Edit Level`. That publishes the active room for the iPad.

## 4. Start the iPad Draw Client

In a third terminal from the repo root:

```sh
cd draw-client
npm run build
npm run preview -- --host 0.0.0.0 --port 5175
```

Open this exact shape of URL on the iPad:

```text
http://MAC_IP:5175/?backend=http://MAC_IP:8001
```

The iPad should auto-join the level currently opened with `Edit Level` on the Mac.

## Direct Room Link

If auto-join is not what you want, use a room link:

```text
http://MAC_IP:5175/?room=ROOM_CODE&backend=http://MAC_IP:8001
```

## Common Fixes

- Blank white screen: make sure the draw client is running with `--host 0.0.0.0`, then reload the iPad page.
- Cannot connect: make sure the iPad and Mac are on the same Wi-Fi and use `MAC_IP`, not `localhost`.
- Backend unreachable: open `http://MAC_IP:8001/health` on the iPad. If it does not load, check the backend terminal and macOS firewall.
- Manual type buttons showing immediately: wait for the VLM pass. Manual choices should only appear if VLM fails, is unavailable, or needs correction.
