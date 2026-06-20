// Doodle Smash lobby/relay server.
//
// Serves three things from one origin so a deployed copy "just works" anywhere:
//   1. the game itself (the existing static files — index.html, js/, style.css)
//   2. /c        the mobile controller page (a phone joystick + buttons)
//   3. /qr?d=…   a QR image (SVG) for a join URL
//   4. /ws       a WebSocket relay that ferries controller input to the host
//
// Phones never talk to the host directly; everything hops through here, so it works
// across the internet once this is deployed to a public HTTPS host (Render/Fly/…).
// The game still runs from file:// for solo/keyboard play — the relay is only needed
// for phone controllers.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 6;

// ---- static file serving -------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
// only files we intend to serve (no path traversal, no node_modules/server source)
const ALLOW = new Set(['/index.html', '/style.css', '/controller.html']);
function safeStatic(reqPath) {
  if (reqPath === '/') reqPath = '/index.html';
  if (reqPath.startsWith('/js/')) {
    // serve any js/*.js (the game scripts), but block traversal
    const rel = reqPath.replace(/^\/+/, '');
    if (rel.includes('..')) return null;
    return path.join(ROOT, rel);
  }
  if (ALLOW.has(reqPath)) return path.join(ROOT, reqPath.slice(1));
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // controller page (phones land here from the QR)
  if (p === '/c' || p === '/controller') {
    return sendFile(res, path.join(ROOT, 'controller.html'));
  }
  // QR image for a join URL
  if (p === '/qr') {
    const data = url.searchParams.get('d') || '';
    try {
      const svg = await QRCode.toString(data, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(svg);
    } catch (e) { res.writeHead(400); return res.end('bad qr'); }
  }
  // health check for hosting platforms
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }

  const file = safeStatic(p);
  if (!file) { res.writeHead(404); return res.end('not found'); }
  sendFile(res, file);
});

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---- lobby relay ---------------------------------------------------------
// A lobby is one host + up to MAX_PLAYERS controllers keyed by slot (1..6).
const lobbies = new Map(); // code -> { host, players: Map<slot, {ws, name, color}> }

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let c; do { c = Array.from({ length: 4 }, () => A[(Math.random() * A.length) | 0]).join(''); } while (lobbies.has(c));
  return c;
}
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.role = null; ws.code = null; ws.slot = null;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'host') {
      // register as a host; create (or reuse) a lobby code
      const code = (m.lobby && lobbies.has(m.lobby)) ? m.lobby : newCode();
      if (!lobbies.has(code)) lobbies.set(code, { host: ws, players: new Map() });
      const lobby = lobbies.get(code);
      lobby.host = ws; ws.role = 'host'; ws.code = code;
      send(ws, { t: 'hosted', lobby: code });
      // re-announce any controllers that joined before the host (re)connected
      for (const [slot, pl] of lobby.players) send(ws, { t: 'join', slot, name: pl.name, color: pl.color });
      return;
    }
    if (m.t === 'join') {
      const lobby = lobbies.get(m.lobby);
      if (!lobby) return send(ws, { t: 'nolobby' });
      if (lobby.players.size >= MAX_PLAYERS) return send(ws, { t: 'full' });
      let slot = 1; while (lobby.players.has(slot)) slot++;
      const name = (m.name || 'Player').slice(0, 14);
      const color = m.color || null;
      lobby.players.set(slot, { ws, name, color });
      ws.role = 'controller'; ws.code = m.lobby; ws.slot = slot;
      send(ws, { t: 'joined', slot, lobby: m.lobby, name });
      if (lobby.host) send(lobby.host, { t: 'join', slot, name, color });
      return;
    }
    if (m.t === 'in' && ws.role === 'controller') {
      // relay an input frame to the host, tagged with this controller's slot
      const lobby = lobbies.get(ws.code);
      if (lobby && lobby.host) send(lobby.host, { t: 'in', slot: ws.slot, d: m.d });
      return;
    }
    if (ws.role === 'host') {
      // host -> a specific controller (assignment / start / rumble / etc.)
      const lobby = lobbies.get(ws.code);
      if (!lobby) return;
      if (m.slot != null) { const pl = lobby.players.get(m.slot); if (pl) send(pl.ws, m); }
      else for (const pl of lobby.players.values()) send(pl.ws, m); // broadcast
    }
  });

  ws.on('close', () => {
    const lobby = ws.code && lobbies.get(ws.code);
    if (!lobby) return;
    if (ws.role === 'host' && lobby.host === ws) {
      for (const pl of lobby.players.values()) send(pl.ws, { t: 'hostgone' });
      lobbies.delete(ws.code);
    } else if (ws.role === 'controller') {
      lobby.players.delete(ws.slot);
      if (lobby.host) send(lobby.host, { t: 'leave', slot: ws.slot });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Doodle Smash server on http://localhost:${PORT}`);
  console.log(`  game:       http://localhost:${PORT}/`);
  console.log(`  controller: http://localhost:${PORT}/c?lobby=CODE`);
});
