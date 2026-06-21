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

// ---- fal.ai enhance proxy config ----------------------------------------
// PIPELINE (default 'recraft'): the kid's rough drawing -> Recraft V3 image-to-image (a clean,
// CONSISTENT illustration style that LEVELS UP the doodle into a real game sprite while still
// following its shape) -> BiRefNet background removal (a real ML cutout, run SERVER-SIDE so it never
// stalls the browser render loop) -> transparent PNG. Set FAL_PIPELINE=sdxl for the old canny path.
const FAL_PIPELINE = (process.env.FAL_PIPELINE || 'recraft').toLowerCase();
const FAL_GEN_MODEL = 'fal-ai/recraft/v3/image-to-image';
const FAL_RMBG_MODEL = 'fal-ai/birefnet/v2';
// Recraft style + how far it may stray from the kid's drawing (0 = identical .. 1 = ignore it).
// digital_illustration/hand_drawn fits the doodle world; vector_illustration/bold_stroke is flatter.
// Both are env-tunable so we can dial the look without code edits.
const FAL_STYLE = process.env.FAL_STYLE || 'digital_illustration/hand_drawn';
const FAL_STRENGTH = Number(process.env.FAL_STRENGTH || 0.55);
const FAL_TIMEOUT_MS = 60000;
// legacy fallback: fast-sdxl-controlnet-canny (FAL_PIPELINE=sdxl)
const FAL_SDXL_MODEL = 'fal-ai/fast-sdxl-controlnet-canny';
const FAL_NEG_PROMPT =
  'realistic, photo, photograph, 3d, render, detailed, shading, gradient, texture, ' +
  'noise, busy background, scenery, shadow, reflection, blurry, watermark, text, signature';

// FAL_KEY (format "id:secret"): prefer the env var; otherwise parse a
// FAL_KEY=... line from a .env in the repo root. Never hardcoded.
function falKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY.trim();
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*FAL_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
    }
  } catch (e) { /* no .env => unset */ }
  return null;
}

// Recraft target prompt — the STYLE param carries the look, so the prompt just names the subject
// and asks for a clean, single, game-ready sprite.
function recraftPrompt(label) {
  return `a ${label}, single clean 2D game sprite, bold confident outline, flat bright colors, ` +
    `centered, full object in frame, plain white background, no text, no sparkles, ` +
    `no decorations, no extra marks, nothing in the background`;
}
// Legacy SDXL prompt (FAL_PIPELINE=sdxl).
function falPrompt(label) {
  return `a very simple minimal flat doodle of a ${label}, single thick black marker outline, ` +
    `two flat colors, no shading, no detail, childlike, centered, plain white background`;
}

// Read a request body up to a sane cap, parse as JSON.
function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// POST a fal model and return its parsed JSON (throws a descriptive error on a non-2xx).
async function falPost(model, payload, key, signal) {
  const r = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    const e = new Error(`${model} failed (${r.status}) ${detail.slice(0, 300)}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// Fetch an image URL (hosted or data URI) and return it as base64.
async function fetchB64(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`fetching image failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

// POST /fal-enhance — { image_b64, label } -> { sprite_b64 }.
// Stage 1: generate a clean game sprite from the kid's drawing (Recraft i2i, or SDXL canny).
// Stage 2: remove the background server-side (BiRefNet) so the client gets a TRANSPARENT sprite and
// never has to run a cutout model on its render thread. Cutout is best-effort: if it fails we still
// return the generated sprite rather than failing the whole enhance.
async function falEnhance(req, res) {
  const key = falKey();
  if (!key) return sendJson(res, 500, { error: 'FAL_KEY not configured (env or .env)' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: e.message || 'bad body' }); }

  const image_b64 = body && body.image_b64;
  if (typeof image_b64 !== 'string' || !image_b64) {
    return sendJson(res, 400, { error: 'image_b64 (base64 PNG, no data: prefix) is required' });
  }
  const label = (body && typeof body.label === 'string' && body.label.trim()) || 'object';
  // accept either a raw base64 string or an already-prefixed data URI
  const dataUri = image_b64.startsWith('data:') ? image_b64 : `data:image/png;base64,${image_b64}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FAL_TIMEOUT_MS);
  try {
    // --- stage 1: generate ---
    let genUrl;
    if (FAL_PIPELINE === 'sdxl') {
      const out = await falPost(FAL_SDXL_MODEL, {
        prompt: falPrompt(label), negative_prompt: FAL_NEG_PROMPT, control_image_url: dataUri,
        controlnet_conditioning_scale: 0.45, guidance_scale: 6.5, num_inference_steps: 30,
        image_size: 'square', num_images: 1, enable_safety_checker: false,
      }, key, ctrl.signal);
      genUrl = out && out.images && out.images[0] && out.images[0].url;
    } else {
      const out = await falPost(FAL_GEN_MODEL, {
        image_url: dataUri, prompt: recraftPrompt(label), strength: FAL_STRENGTH, style: FAL_STYLE,
      }, key, ctrl.signal);
      genUrl = out && out.images && out.images[0] && out.images[0].url;
    }
    if (!genUrl) return sendJson(res, 502, { error: 'fal returned no image' });

    // --- stage 2: background removal (server-side, best-effort) ---
    let spriteUrl = genUrl;
    try {
      const cut = await falPost(FAL_RMBG_MODEL, {
        image_url: genUrl, output_format: 'png', refine_foreground: true,
      }, key, ctrl.signal);
      if (cut && cut.image && cut.image.url) spriteUrl = cut.image.url;
    } catch (e) { /* keep the un-cut sprite rather than failing the whole enhance */ }

    const sprite_b64 = await fetchB64(spriteUrl, ctrl.signal);
    return sendJson(res, 200, { sprite_b64 });
  } catch (e) {
    if (e && e.name === 'AbortError') return sendJson(res, 504, { error: 'fal request timed out' });
    return sendJson(res, 502, { error: `fal enhance failed: ${(e && e.message) || e}` });
  } finally {
    clearTimeout(timer);
  }
}

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
  // fal.ai enhance proxy: rough scribble + label -> polished doodle sprite
  if (p === '/fal-enhance') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('method not allowed'); }
    return falEnhance(req, res);
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
