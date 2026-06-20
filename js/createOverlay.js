// Phase 1 visual creation bridge: subscribes to drawing projections and renders
// them over the live game scene without mutating DS.Store.data.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;

  const DEFAULT_BACKEND = 'http://localhost:8000';
  const RECONNECT_MS = 1000;
  const state = {
    enabled: false,
    visible: true,
    roomId: 'demo',
    backendUrl: DEFAULT_BACKEND,
    wsUrl: '',
    status: 'off',
    version: 0,
    projection: null,
    socket: null,
    reconnectTimer: 0,
  };

  function backendFromParams(params) {
    const raw = params.get('backend') || DEFAULT_BACKEND;
    try { return new URL(raw, global.location.href); }
    catch (_) { return new URL(DEFAULT_BACKEND); }
  }

  function wsUrlForRoom(backendUrl, roomId) {
    const url = new URL(backendUrl.toString());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws/rooms/' + encodeURIComponent(roomId);
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function init() {
    const params = new URLSearchParams(global.location.search);
    const room = params.get('overlay') || params.get('room');
    if (!room) return;
    state.enabled = true;
    state.roomId = room;
    state.backendUrl = backendFromParams(params).toString().replace(/\/$/, '');
    state.wsUrl = wsUrlForRoom(new URL(state.backendUrl), state.roomId);
    connect();
    global.addEventListener('keydown', (event) => {
      if (event.code === 'KeyO') state.visible = !state.visible;
    });
  }

  function connect() {
    clearTimeout(state.reconnectTimer);
    if (!state.enabled) return;
    state.status = 'connecting';
    const socket = new WebSocket(state.wsUrl);
    state.socket = socket;

    socket.addEventListener('open', () => {
      if (state.socket !== socket) return;
      state.status = 'connected';
    });
    socket.addEventListener('message', (event) => {
      if (state.socket !== socket) return;
      let message;
      try { message = JSON.parse(event.data); }
      catch (_) { return; }
      if (message.type === 'hello') {
        state.status = 'connected';
        state.version = message.version || 0;
        if (message.projection) state.projection = message.projection;
      } else if (message.type === 'projection_updated') {
        state.status = 'connected';
        state.version = message.version || state.version;
        state.projection = message.projection || null;
      }
    });
    socket.addEventListener('close', () => {
      if (state.socket !== socket) return;
      state.socket = null;
      state.status = 'disconnected';
      state.reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
    socket.addEventListener('error', () => {
      if (state.socket === socket) state.status = 'error';
    });
  }

  function pointsFor(stroke) {
    return (stroke.points || [])
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => [p.x, p.y]);
  }

  function renderStroke(ctx, stroke) {
    const pts = pointsFor(stroke);
    if (pts.length < 2) return;
    const rnd = DS.makeRng(DS.hashSeed(stroke.id || stroke.sourceId || 'stroke'));
    const width = Math.max(2, Math.min(26, stroke.width || 6));
    D.strokePts(ctx, pts, {
      width: width + 9,
      color: D.COL.paper,
      alpha: 0.78,
      rnd,
      jitter: 0.45,
      passes: 1,
    });
    D.strokePts(ctx, pts, {
      width,
      color: stroke.color || D.COL.accent,
      alpha: stroke.opacity == null ? 0.9 : stroke.opacity,
      rnd,
      jitter: 0.8,
      passes: 1,
    });
  }

  function renderShape(ctx, shape) {
    if (!Number.isFinite(shape.x) || !Number.isFinite(shape.y) || !Number.isFinite(shape.w) || !Number.isFinite(shape.h)) return;
    const rnd = DS.makeRng(DS.hashSeed(shape.id || shape.sourceId || 'shape'));
    const color = shape.color || D.COL.accent;
    const width = Math.max(2, Math.min(24, shape.width || 5));
    const alpha = shape.opacity == null ? 0.85 : shape.opacity;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (shape.kind === 'ellipse' || shape.kind === 'oval') {
      D.ellipse(ctx, shape.x + shape.w / 2, shape.y + shape.h / 2, Math.abs(shape.w / 2), Math.abs(shape.h / 2), { width: width + 8, color: D.COL.paper, rnd, passes: 1 });
      D.ellipse(ctx, shape.x + shape.w / 2, shape.y + shape.h / 2, Math.abs(shape.w / 2), Math.abs(shape.h / 2), { width, color, rnd, passes: 1 });
    } else {
      D.roundedRect(ctx, shape.x, shape.y, shape.w, shape.h, 8, { width: width + 8, color: D.COL.paper, rnd, passes: 1 });
      D.roundedRect(ctx, shape.x, shape.y, shape.w, shape.h, 8, { width, color, rnd, passes: 1 });
    }
    ctx.restore();
  }

  function renderLabel(ctx, label) {
    if (!label.text || !Number.isFinite(label.x) || !Number.isFinite(label.y)) return;
    ctx.save();
    ctx.font = "28px 'Patrick Hand', sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = D.COL.paper;
    ctx.fillStyle = label.color || D.COL.accent;
    ctx.strokeText(label.text, label.x, label.y);
    ctx.fillText(label.text, label.x, label.y);
    ctx.restore();
  }

  function renderView(ctx) {
    if (!state.enabled || !state.visible || !state.projection) return;
    ctx.save();
    ctx.globalAlpha = 0.95;
    for (const shape of state.projection.shapes || []) renderShape(ctx, shape);
    for (const stroke of state.projection.strokes || []) renderStroke(ctx, stroke);
    for (const label of state.projection.labels || []) renderLabel(ctx, label);
    ctx.restore();
  }

  function renderHud(ctx, game) {
    if (!state.enabled) return;
    const U = game && game._u ? game._u() : 1;
    const label = 'creation overlay: ' + state.status + '  room ' + state.roomId + '  v' + state.version + '  O toggles';
    ctx.save();
    ctx.font = (17 * U) + "px 'Patrick Hand', sans-serif";
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = state.visible ? D.COL.accent : D.COL.inkSoft;
    ctx.fillText(label, (game ? game.view.w : 1920) - 18 * U, (game ? game.view.h : 1080) - 18 * U);
    ctx.restore();
  }

  DS.CreateOverlay = { init, renderView, renderHud, state };
})(window);
