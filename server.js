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
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const TLS_CERT = process.env.MAGICBOARD_TLS_CERT;
const TLS_KEY = process.env.MAGICBOARD_TLS_KEY;
const MAX_PLAYERS = 6;

// ---- fal.ai enhance proxy config ----------------------------------------
// PIPELINE (default 'recraft'): the kid's rough drawing -> Recraft V3 image-to-image (a clean,
// CONSISTENT illustration style that LEVELS UP the doodle into a real game sprite while still
// following its shape) -> BiRefNet background removal (a real ML cutout, run SERVER-SIDE so it never
// stalls the browser render loop) -> transparent PNG. Set FAL_PIPELINE=sdxl for the old canny path.
const FAL_PIPELINE = (process.env.FAL_PIPELINE || 'recraft').toLowerCase();
// 'text' (default): generate a CLEAN game icon FROM the recognized label — ignore the doodle's shape
// entirely (this is what gives a real game-asset look). 'image': image-to-image (traces the doodle —
// only recolors it; kept for comparison via FAL_GEN_MODE=image).
// 'image' (default): image-to-image augments the kid's ALREADY-ISOLATED doodle — reliably clean +
// on-shape across any object (text-to-image invents little SCENES for everyday objects like house/sun/
// heart, which break the cutout). 'text': clean redraw from the label (loses the kid's shape; only
// reliable for game-item words). Suite-tested 2026-06-21: i2i 9/9 clean vs t2i ~4/9 on crude doodles.
const FAL_GEN_MODE = (process.env.FAL_GEN_MODE || 'image').toLowerCase();
const FAL_GEN_MODEL_T2I = 'fal-ai/recraft/v3/text-to-image';
const FAL_GEN_MODEL_I2I = 'fal-ai/recraft/v3/image-to-image';
const FAL_RMBG_MODEL = 'fal-ai/bria/background/remove'; // saliency cutout (handles patterned backgrounds)
// Recraft style + how far it may stray from the kid's drawing (0 = identical .. 1 = ignore it).
// digital_illustration/hand_drawn fits the doodle world; vector_illustration/bold_stroke is flatter.
// Both are env-tunable so we can dial the look without code edits.
const FAL_STYLE = process.env.FAL_STYLE || 'digital_illustration/hand_drawn';
const FAL_STRENGTH = Number(process.env.FAL_STRENGTH || 0.72); // i2i: high enough to clean up + color, low enough to keep the kid's shape
// ---- VLM (open-vocab doodle recognition) ----
const VLM_MODEL = process.env.MAGICBOARD_VLM_MODEL || 'gpt-4.1-mini';
// the words the game can turn into mechanics — steer the VLM toward a USABLE label (js/mechanics.js).
const VLM_VOCAB = 'sword, knife, axe, hammer, bat, gun, bow, slingshot, bomb, ball, dart, rock, ' +
  'fire, water, ice, lightning, plant, poison, wind, metal, light, dark, ' +
  'star, crown, gem, key, heart, shield, apple, banana, food, bread, cake, pizza, ' +
  'cloud, mushroom, tree, anvil, skull, boomerang, umbrella';
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

// OPENAI_API_KEY for the VLM recognizer: env, then root .env, then backend/.env (where the
// level-editor keeps it). Never hardcoded.
function openaiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  for (const rel of ['.env', path.join('backend', '.env')]) {
    try {
      const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+?)\s*$/);
        if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
      }
    } catch (e) { /* skip */ }
  }
  return null;
}

// Recraft target prompt — the STYLE param carries the look, so the prompt just names the subject
// and asks for a clean, single, game-ready sprite.
function recraftPrompt(label) {
  return `a clean, well-drawn hand-drawn doodle of a ${label} — confident tidy ink linework, ` +
    `neat and crisp, simple flat colors, like a polished sketch by a skilled artist. ` +
    `Single centered object, whole object fully visible with margin (not cropped), ` +
    `plain solid white background, clean edges, no text, no background, no scenery.`;
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
    } else if (FAL_GEN_MODE === 'image') {
      const out = await falPost(FAL_GEN_MODEL_I2I, {
        image_url: dataUri, prompt: recraftPrompt(label), strength: FAL_STRENGTH, style: FAL_STYLE,
      }, key, ctrl.signal);
      genUrl = out && out.images && out.images[0] && out.images[0].url;
    } else {
      // text-to-image: a clean game icon FROM the label, ignoring the doodle's shape (the good-looking path)
      const out = await falPost(FAL_GEN_MODEL_T2I, {
        prompt: recraftPrompt(label), style: FAL_STYLE, image_size: 'square_hd',
      }, key, ctrl.signal);
      genUrl = out && out.images && out.images[0] && out.images[0].url;
    }
    if (!genUrl) return sendJson(res, 502, { error: 'fal returned no image' });

    // stage 2: Bria background removal (saliency) — removes the patterned/scene backgrounds that
    // Recraft's hand_drawn style scatters and that a connected-components pass can't (stripes/grid/
    // rain reach the frame edge). Best-effort: keep the raw image if it fails. The CLIENT then drops
    // any leftover DETACHED decoration blobs (rain dashes, sparkles) via keep-largest in _isolateDoodle.
    let spriteUrl = genUrl;
    try {
      const cut = await falPost(FAL_RMBG_MODEL, { image_url: genUrl }, key, ctrl.signal);
      const u = (cut && cut.image && cut.image.url) || (cut && cut.images && cut.images[0] && cut.images[0].url);
      if (u) spriteUrl = u;
    } catch (e) { /* keep the un-cut image rather than failing the whole enhance */ }

    const sprite_b64 = await fetchB64(spriteUrl, ctrl.signal);
    return sendJson(res, 200, { sprite_b64 });
  } catch (e) {
    if (e && e.name === 'AbortError') return sendJson(res, 504, { error: 'fal request timed out' });
    return sendJson(res, 502, { error: `fal enhance failed: ${(e && e.message) || e}` });
  } finally {
    clearTimeout(timer);
  }
}

// POST /vlm-recognize { image_b64 } -> { top:{label,confidence}, results:[...], confident }.
// Open-vocab doodle recognition via the OpenAI vision model — reads ANYTHING (a bare flame -> "fire"),
// unlike the fixed 25-class CNN. Mirrors the CNN /recognize response shape (js/ai.js recognize()).
async function vlmRecognize(req, res) {
  const key = openaiKey();
  if (!key) return sendJson(res, 500, { error: 'OPENAI_API_KEY not configured (env, .env, or backend/.env)' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: e.message || 'bad body' }); }
  const image_b64 = body && body.image_b64;
  if (typeof image_b64 !== 'string' || !image_b64) return sendJson(res, 400, { error: 'image_b64 is required' });
  const dataUri = image_b64.startsWith('data:') ? image_b64 : `data:image/png;base64,${image_b64}`;

  const prompt = `This is a child's simple doodle. In ONE or TWO words, what is it? Name the ACTUAL ` +
    `object with a simple common noun — e.g. fish, house, sun, flower, cat, tree, boat, sword, star, ` +
    `apple, key, heart. Do NOT force it into a weapon/game word: if it's a fish say "fish", if it's a ` +
    `house say "house". Only if it clearly IS a weapon or element, name it plainly (sword, gun, fire, ` +
    `water, ice, lightning). Reply with ONLY the word(s), lowercase, no punctuation, no explanation.`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VLM_MODEL, max_tokens: 12, temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUri } },
        ] }],
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return sendJson(res, 502, { error: `vlm request failed (${r.status})`, detail: detail.slice(0, 300) });
    }
    const out = await r.json();
    let label = ((out && out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) || '')
      .trim().toLowerCase().replace(/[^a-z \-]/g, '').trim() || 'thing';
    const top = { label: label, archetype: null, element: null, confidence: 0.95 };
    return sendJson(res, 200, { results: [top], top: top, confident: true });
  } catch (e) {
    if (e && e.name === 'AbortError') return sendJson(res, 504, { error: 'vlm request timed out' });
    return sendJson(res, 502, { error: `vlm recognize failed: ${(e && e.message) || e}` });
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

const requestHandler = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // CORS: the game page can be served from the Mac's LAN IP (so the iPad QR works) while it fetches
  // /fal-enhance, /vlm-recognize, /healthz — a different origin. Allow it (local dev/demo server).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // controller page (phones land here from the QR)
  if (p === '/c' || p === '/controller') {
    return sendFile(res, path.join(ROOT, 'controller.html'));
  }
  // iPad draw pad (draw -> drag onto the mini-map -> drops into the live match)
  if (p === '/draw' || p === '/drawpad') {
    return sendFile(res, path.join(ROOT, 'drawpad.html'));
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
  // VLM open-vocab recognition: a drawing PNG -> a game label (replaces the 25-class CNN)
  if (p === '/vlm-recognize') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('method not allowed'); }
    return vlmRecognize(req, res);
  }
  // health check for hosting platforms
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }

  const file = safeStatic(p);
  if (!file) { res.writeHead(404); return res.end('not found'); }
  sendFile(res, file);
};

const server = TLS_CERT && TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, requestHandler)
  : http.createServer(requestHandler);

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
      // `draw:true` marks an iPad draw pad — the host keeps it out of the player roster (it just relays drawings)
      if (lobby.host) send(lobby.host, { t: 'join', slot, name, color, draw: !!m.draw });
      return;
    }
    if (m.t === 'in' && ws.role === 'controller') {
      // relay an input frame to the host, tagged with this controller's slot
      const lobby = lobbies.get(ws.code);
      if (lobby && lobby.host) send(lobby.host, { t: 'in', slot: ws.slot, d: m.d });
      return;
    }
    if ((m.t === 'draw' || m.t === 'needstage') && ws.role === 'controller') {
      // an iPad DRAW pad -> relay to the host (game): a drawing to inject, or a mini-map stage request
      const lobby = lobbies.get(ws.code);
      if (lobby && lobby.host) send(lobby.host, Object.assign({}, m, { slot: ws.slot }));
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
  const protocol = TLS_CERT && TLS_KEY ? 'https' : 'http';
  console.log(`Doodle Smash server on ${protocol}://localhost:${PORT}`);
  console.log(`  game:       ${protocol}://localhost:${PORT}/`);
  console.log(`  controller: ${protocol}://localhost:${PORT}/c?lobby=CODE`);
});
