// Phase 1.5 desktop level preview: subscribes to the same draw-client room
// data and renders clean temporary platform candidates instead of raw tldraw.
(function (global) {
  'use strict';

  const DS = global.DS = global.DS || {};
  const D = DS.draw;
  const DEFAULT_BACKEND = 'http://localhost:8000';
  const RECONNECT_MS = 1000;

  const state = {
    enabled: false,
    world: null,
    roomId: '',
    backendUrl: DEFAULT_BACKEND,
    captureUrl: '',
    wsUrl: '',
    status: 'idle',
    version: 0,
    projection: null,
    semanticDraft: null,
    visualObservation: null,
    socket: null,
    reconnectTimer: 0,
    activityTimer: 0,
    onActivity: null,
    onSemanticDraft: null,
    enterSeq: 0,
    selectionController: null,
  };

  function backendFromParams() {
    const params = new URLSearchParams(global.location.search);
    const raw = params.get('backend') || DEFAULT_BACKEND;
    try { return new URL(raw, global.location.href); }
    catch (_error) { return new URL(DEFAULT_BACKEND); }
  }

  function roomCaptureUrl(backendUrl, roomId) {
    const url = new URL(backendUrl.toString());
    url.pathname = '/rooms/' + encodeURIComponent(roomId) + '/capture';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function roomWsUrl(backendUrl, roomId) {
    const url = new URL(backendUrl.toString());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws/rooms/' + encodeURIComponent(roomId);
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function roomSelectionUrl(backendUrl) {
    const url = new URL(backendUrl.toString());
    url.pathname = '/selection/current';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function stageReferenceForWorld(world) {
    const mapId = world && (world.mapId || world.id);
    const stage = mapId && DS.Maps && DS.Store && DS.Store.data ? DS.Maps.stageFor(DS.Store.data, mapId) : null;
    const bounds = stage && stage.bounds ? stage.bounds : { x0: 0, y0: 0, x1: 1920, y1: 1080 };
    return {
      view: { w: Math.max(1, bounds.x1 - bounds.x0), h: Math.max(1, bounds.y1 - bounds.y0), x: bounds.x0, y: bounds.y0 },
      bounds,
      platforms: stage && Array.isArray(stage.platforms) ? DS.data.clone(stage.platforms) : [],
      portals: stage && Array.isArray(stage.portals) ? DS.data.clone(stage.portals) : [],
      spawns: stage && Array.isArray(stage.spawns) ? DS.data.clone(stage.spawns) : [],
    };
  }

  function publishSelection(backendUrl, world, roomId) {
    if (!global.fetch || !world || !roomId) return;
    if (state.selectionController) state.selectionController.abort();
    state.selectionController = global.AbortController ? new AbortController() : null;
    fetch(roomSelectionUrl(backendUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.selectionController ? state.selectionController.signal : undefined,
      body: JSON.stringify({
        roomId,
        worldId: world.id || roomId,
        worldName: world.name || 'Untitled',
        stageReference: stageReferenceForWorld(world),
      }),
    }).catch((error) => {
      if (error && error.name === 'AbortError') return;
      console.warn('level preview selection publish failed', error);
    });
  }

  function clearSelection(backendUrl) {
    if (!global.fetch) return;
    if (state.selectionController) state.selectionController.abort();
    state.selectionController = global.AbortController ? new AbortController() : null;
    fetch(roomSelectionUrl(backendUrl), {
      method: 'DELETE',
      signal: state.selectionController ? state.selectionController.signal : undefined,
    }).catch((error) => {
      if (error && error.name === 'AbortError') return;
      console.warn('level preview selection clear failed', error);
    });
  }

  function savedDrawingCapture(world) {
    const saved = world && world.drawingCapture && typeof world.drawingCapture === 'object' ? world.drawingCapture : null;
    if (!saved || !saved.capture || !saved.projection) return null;
    return saved;
  }

  async function restoreSavedCapture(backendUrl, world, roomId) {
    const saved = savedDrawingCapture(world);
    if (!global.fetch || !saved || !roomId) return null;
    const currentResponse = await fetch(roomCaptureUrl(backendUrl, roomId));
    if (currentResponse.ok) {
      const current = await currentResponse.json();
      if (current.capture && current.projection) return current;
    }
    const response = await fetch(roomCaptureUrl(backendUrl, roomId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'canvas_capture',
        capture: saved.capture,
        projection: saved.projection,
        clientId: 'desktop-saved-capture',
        sentAt: new Date().toISOString(),
      }),
    });
    if (!response.ok) throw new Error('restore ' + response.status);
    return response.json();
  }

  function setStatus(status) {
    state.status = status;
    syncUi();
  }

  function updateProjection(version, projection, semanticDraft, visualObservation, updatedAt) {
    state.version = version || state.version || 0;
    state.projection = projection || null;
    state.semanticDraft = semanticDraft || null;
    state.visualObservation = visualObservation || state.visualObservation || null;
    syncUi();
    if (state.onActivity && (projection || updatedAt)) {
      clearTimeout(state.activityTimer);
      state.activityTimer = setTimeout(() => state.onActivity(state.world, { version: state.version, updatedAt }), 80);
    }
    if (state.onSemanticDraft && semanticDraft) state.onSemanticDraft(state.world, semanticDraft);
  }

  function syncUi() {
    const root = document.getElementById('level-preview-ui');
    if (!root) return;
    root.hidden = !state.enabled;
    const title = document.getElementById('level-preview-title');
    const room = document.getElementById('level-preview-room');
    const status = document.getElementById('level-preview-status');
    const count = document.getElementById('level-preview-count');
    if (title) title.textContent = state.world ? state.world.name : 'Level Preview';
    if (room) room.textContent = state.roomId ? 'Room ' + state.roomId : 'Room pending';
    if (status) status.textContent = state.status + ' · v' + (state.version || 0);
    if (count) {
      const projection = state.projection || {};
      const draft = state.semanticDraft || {};
      const total = (draft.candidates || []).length || ((projection.strokes || []).length + (projection.shapes || []).length);
      const confirmed = (draft.candidates || []).filter((candidate) => candidate.status === 'confirmed').length;
      if (confirmed) count.textContent = confirmed + ' object' + (confirmed === 1 ? '' : 's') + ' auto-applied';
      else count.textContent = total ? confirmed + '/' + total + ' confirmed' : 'Draw stage objects on the iPad';
    }
    syncActionUi();
  }

  function launchReport() {
    const mapId = state.world && (state.world.mapId || state.world.id);
    if (!DS.MagicBoardGame || !mapId) return { ok: false, missing: ['stage'] };
    return DS.MagicBoardGame.validateLaunchReady(mapId);
  }

  function syncActionUi() {
    const applyButton = document.getElementById('level-preview-apply');
    const playButton = document.getElementById('level-preview-play');
    const launch = launchReport();
    if (applyButton) {
      const hasConfirmed = !!(state.semanticDraft && (state.semanticDraft.candidates || []).some((candidate) => candidate.status === 'confirmed'));
      applyButton.disabled = !hasConfirmed;
    }
    if (playButton) {
      playButton.disabled = !launch.ok;
      playButton.title = launch.ok ? 'Launch this stage' : 'Missing: ' + launch.missing.join(', ');
    }
  }

  async function loadCapture(seq) {
    if (!state.captureUrl) return;
    setStatus('loading');
    try {
      const response = await fetch(state.captureUrl);
      if (!response.ok) throw new Error('capture ' + response.status);
      const room = await response.json();
      if (seq !== state.enterSeq) return;
      updateProjection(room.version || 0, room.projection || state.projection, room.semanticDraft || state.semanticDraft, room.visualObservation || state.visualObservation, room.updatedAt);
      setStatus('loaded');
    } catch (error) {
      if (seq !== state.enterSeq) return;
      console.warn('level preview capture failed', error);
      setStatus('capture error');
    }
  }

  async function saveCapture() {
    if (!state.enabled || !state.captureUrl) throw new Error('No level preview is active.');
    const seq = state.enterSeq;
    const roomId = state.roomId;
    const response = await fetch(state.captureUrl);
    if (!response.ok) throw new Error('Capture save failed: ' + response.status);
    const room = await response.json();
    if (seq !== state.enterSeq || roomId !== state.roomId) throw new Error('Level changed before save completed.');
    updateProjection(room.version || 0, room.projection || null, room.semanticDraft || null, room.visualObservation || null, room.updatedAt);
    return room;
  }

  function connect() {
    clearTimeout(state.reconnectTimer);
    if (!state.enabled || !state.wsUrl) return;
    setStatus('connecting');
    const socket = new WebSocket(state.wsUrl);
    state.socket = socket;

    socket.addEventListener('open', () => {
      if (state.socket !== socket) return;
      setStatus('connected');
    });

    socket.addEventListener('message', (event) => {
      if (state.socket !== socket) return;
      let message;
      try { message = JSON.parse(event.data); }
      catch (_error) { return; }
      if (message.type === 'hello') {
        setStatus('connected');
        updateProjection(message.version || 0, message.projection || state.projection, message.semanticDraft || state.semanticDraft, message.visualObservation || state.visualObservation, null);
      } else if (message.type === 'projection_updated') {
        setStatus('connected');
        updateProjection(message.version || state.version, message.projection || null, message.semanticDraft || null, message.visualObservation || state.visualObservation, message.updatedAt);
      } else if (message.type === 'semantic_draft_updated') {
        setStatus('connected');
        updateProjection(message.version || state.version, state.projection, message.semanticDraft || null, state.visualObservation, null);
      } else if (message.type === 'visual_observation_updated') {
        updateProjection(
          message.version || state.version,
          state.projection,
          message.semanticDraft || state.semanticDraft,
          message.visualObservation || state.visualObservation,
          null,
        );
      }
    });

    socket.addEventListener('close', () => {
      if (state.socket !== socket) return;
      state.socket = null;
      if (!state.enabled) return;
      setStatus('disconnected');
      state.reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });

    socket.addEventListener('error', () => {
      if (state.socket === socket) setStatus('socket error');
    });
  }

  function disconnect() {
    clearTimeout(state.reconnectTimer);
    clearTimeout(state.activityTimer);
    if (state.socket) {
      const socket = state.socket;
      state.socket = null;
      try { socket.close(); } catch (_error) {}
    }
  }

  function enter(world, options) {
    if (!world) return;
    options = options || {};
    disconnect();
    state.enterSeq += 1;
    const seq = state.enterSeq;
    const backend = backendFromParams();
    state.enabled = true;
    state.world = world;
    state.roomId = world.roomId || world.id;
    state.backendUrl = backend.toString().replace(/\/$/, '');
    state.captureUrl = roomCaptureUrl(backend, state.roomId);
    state.wsUrl = roomWsUrl(backend, state.roomId);
    state.status = 'starting';
    const saved = savedDrawingCapture(world);
    state.version = saved ? saved.version || 0 : 0;
    state.projection = saved ? saved.projection : null;
    state.semanticDraft = null;
    state.visualObservation = null;
    state.onActivity = options.onActivity || null;
    state.onSemanticDraft = options.onSemanticDraft || null;
    syncUi();
    publishSelection(backend, world, state.roomId);
    if (saved) {
      setStatus('restoring saved capture');
      restoreSavedCapture(backend, world, state.roomId)
        .then((room) => {
          if (seq !== state.enterSeq || !state.enabled || state.roomId !== (world.roomId || world.id)) return;
          if (room) updateProjection(room.version || state.version, room.projection || state.projection, room.semanticDraft || state.semanticDraft, room.visualObservation || state.visualObservation, room.updatedAt);
          setStatus('loaded');
        })
        .catch((error) => {
          if (seq !== state.enterSeq) return;
          console.warn('level preview restore failed', error);
          setStatus('restore error');
        });
    } else {
      loadCapture(seq);
    }
    connect();
  }

  function exit() {
    const shouldClearSelection = state.enabled && state.backendUrl;
    const backendUrl = state.backendUrl;
    disconnect();
    state.enabled = false;
    state.world = null;
    state.roomId = '';
    state.status = 'idle';
    state.version = 0;
    state.projection = null;
    state.semanticDraft = null;
    state.visualObservation = null;
    state.onSemanticDraft = null;
    syncUi();
    if (shouldClearSelection) clearSelection(backendUrl);
  }

  function stageForWorld() {
    const mapId = state.world && (state.world.mapId || state.world.id);
    if (mapId && DS.Maps && DS.Store && DS.Store.data) return DS.Maps.stageFor(DS.Store.data, mapId);
    const ref = DS.stageReference || {};
    return { bounds: { x0: 0, y0: 0, x1: 1920, y1: 1080 }, platforms: ref.platforms || [] };
  }

  function stageExt(stage) {
    const b = stage && stage.bounds ? stage.bounds : { x0: 0, y0: 0, x1: 1920, y1: 1080 };
    let x0 = b.x0, y0 = b.y0, x1 = b.x1, y1 = b.y1;
    for (const p of stage.platforms || []) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h);
    }
    return { x0, y0, x1, y1 };
  }

  function fitView(cssW, cssH, stage) {
    const ext = stageExt(stage || stageForWorld());
    const view = { x: ext.x0, y: ext.y0, w: Math.max(1, ext.x1 - ext.x0), h: Math.max(1, ext.y1 - ext.y0) };
    const scale = Math.min(cssW / view.w, cssH / view.h);
    return {
      view,
      scale,
      ox: (cssW - view.w * scale) / 2 - view.x * scale,
      oy: (cssH - view.h * scale) / 2 - view.y * scale,
    };
  }

  function drawReferencePlatform(ctx, platform, index) {
    const rnd = DS.makeRng(1200 + index * 31);
    const radius = Math.min(platform.h / 2, platform.pass ? 18 : 24);
    ctx.save();
    ctx.globalAlpha = platform.pass ? 0.72 : 0.95;
    D.roundedRect(ctx, platform.x + 8, platform.y + 12, platform.w, platform.h, radius, {
      width: 3,
      color: 'rgba(47,42,38,0.14)',
      fill: 'rgba(47,42,38,0.08)',
      rnd,
      passes: 1,
      jitter: 0.5,
    });
    D.roundedRect(ctx, platform.x, platform.y, platform.w, platform.h, radius, {
      width: platform.pass ? 5 : 7,
      color: platform.pass ? D.COL.inkSoft : D.COL.ink,
      fill: platform.pass ? 'rgba(246,241,231,0.72)' : D.COL.paperShade,
      rnd,
      passes: 1,
      jitter: 0.6,
    });
    ctx.restore();
  }

  function drawReferencePortal(ctx, portal) {
    if (!portal || !Number.isFinite(portal.x) || !Number.isFinite(portal.y)) return;
    ctx.save();
    ctx.globalAlpha = 0.84;
    ctx.strokeStyle = portal.col || '#2f6fe0';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(portal.x, portal.y, portal.r || 44, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = portal.col || '#2f6fe0';
    ctx.fill();
    ctx.restore();
  }

  function cleanPoints(stroke) {
    return (stroke.points || [])
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .map((point) => [point.x, point.y]);
  }

  function strokeBounds(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point[0]);
      minY = Math.min(minY, point[1]);
      maxX = Math.max(maxX, point[0]);
      maxY = Math.max(maxY, point[1]);
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function renderStrokePlatform(ctx, stroke) {
    const points = cleanPoints(stroke);
    if (points.length < 2) return;
    const bounds = strokeBounds(points);
    const rnd = DS.makeRng(DS.hashSeed(stroke.id || stroke.sourceId || 'candidate-stroke'));
    const thickness = Math.max(28, Math.min(86, Math.max(stroke.width || 6, Math.min(bounds.w, bounds.h) * 0.38 + 22)));

    // TODO: Phase 2 agent will classify drawings into platforms, spawn points, characters, hazards, etc.
    D.strokePts(ctx, points, {
      width: thickness + 12,
      color: D.COL.ink,
      alpha: 0.92,
      rnd,
      jitter: 0.35,
      passes: 1,
    });
    D.strokePts(ctx, points, {
      width: thickness,
      color: D.COL.paperShade,
      alpha: 1,
      rnd,
      jitter: 0.25,
      passes: 1,
    });
    D.strokePts(ctx, points, {
      width: Math.max(4, thickness * 0.12),
      color: '#fffaf0',
      alpha: 0.82,
      rnd,
      jitter: 0.2,
      passes: 1,
    });
  }

  function renderRectPlatform(ctx, shape) {
    if (!Number.isFinite(shape.x) || !Number.isFinite(shape.y) || !Number.isFinite(shape.w) || !Number.isFinite(shape.h)) return;
    const x = shape.w < 0 ? shape.x + shape.w : shape.x;
    const y = shape.h < 0 ? shape.y + shape.h : shape.y;
    const w = Math.abs(shape.w);
    const h = Math.abs(shape.h);
    if (w < 4 || h < 4) return;
    const rnd = DS.makeRng(DS.hashSeed(shape.id || shape.sourceId || 'candidate-shape'));
    const radius = Math.min(h / 2, 26);
    D.roundedRect(ctx, x + 9, y + 12, w, h, radius, {
      width: 4,
      color: 'rgba(47,42,38,0.18)',
      fill: 'rgba(47,42,38,0.08)',
      rnd,
      jitter: 0.35,
      passes: 1,
    });
    D.roundedRect(ctx, x, y, w, h, radius, {
      width: 8,
      color: D.COL.ink,
      fill: D.COL.paperShade,
      rnd,
      jitter: 0.5,
      passes: 1,
    });
    D.line(ctx, x + radius, y + Math.min(16, h / 2), x + w - radius, y + Math.min(16, h / 2), {
      width: 4,
      color: '#fffaf0',
      alpha: 0.78,
      rnd,
      jitter: 0.2,
      passes: 1,
    });
  }

  function renderSemanticCandidate(ctx, candidate, index) {
    const g = candidate && candidate.geometry;
    if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y) || !Number.isFinite(g.w) || !Number.isFinite(g.h)) return;
    const rnd = DS.makeRng(DS.hashSeed(candidate.candidateId || candidate.geometryHash || 'semantic-candidate'));
    const status = candidate.status || 'needs_answer';
    let color = '#3f8f86';
    let fill = 'rgba(63,143,134,0.13)';
    if (status === 'confirmed') { color = '#2e8b57'; fill = 'rgba(46,139,87,0.18)'; }
    else if (status === 'decor') { color = '#7c4e92'; fill = 'rgba(124,78,146,0.13)'; }
    else if (status === 'ignored') { color = D.COL.inkSoft; fill = 'rgba(107,98,89,0.07)'; }
    ctx.save();
    D.roundedRect(ctx, g.x, g.y, g.w, g.h, Math.min(18, Math.max(5, g.h / 3)), {
      width: status === 'confirmed' ? 8 : 6,
      color,
      fill,
      rnd,
      jitter: 0.5,
      passes: 1,
    });
    ctx.font = "30px 'Patrick Hand', sans-serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 7;
    ctx.strokeStyle = D.COL.paper;
    ctx.fillStyle = color;
    ctx.strokeText(String(index + 1), g.x + 8, g.y - 6);
    ctx.fillText(String(index + 1), g.x + 8, g.y - 6);
    ctx.restore();
  }

  function appliedCandidateIds(stage) {
    const ids = new Set();
    for (const platform of stage.platforms || []) {
      const id = platform && platform.source && platform.source.kind === 'magicboard_agent' && platform.source.candidateId;
      if (id) ids.add(id);
    }
    for (const portal of stage.portals || []) {
      const id = portal && portal.source && portal.source.kind === 'magicboard_agent' && portal.source.candidateId;
      if (id) ids.add(id);
    }
    return ids;
  }

  function drawAppliedStage(ctx, stage) {
    if (DS.stage && typeof DS.stage.drawStage === 'function') {
      DS.stage.drawStage(ctx, stage);
      return;
    }
    (stage.platforms || []).forEach((platform, index) => drawReferencePlatform(ctx, platform, index));
    (stage.portals || []).forEach((portal) => drawReferencePortal(ctx, portal));
  }

  function renderEmptyHint(ctx, view) {
    ctx.save();
    ctx.font = "42px 'Gloria Hallelujah', cursive";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = D.COL.inkSoft;
    ctx.fillText('Draw on the iPad to add platform candidates', view.x + view.w / 2, view.y + 180);
    ctx.restore();
  }

  function render(ctx, cssW, cssH) {
    if (!state.enabled) return false;
    if (cssW <= 0 || cssH <= 0) return true;
    const stage = stageForWorld();
    const fitted = fitView(cssW, cssH, stage);
    const view = fitted.view;
    const appliedIds = appliedCandidateIds(stage);

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(D.paperTexture(cssW, cssH), 0, 0);
    ctx.save();
    ctx.translate(fitted.ox, fitted.oy);
    ctx.scale(fitted.scale, fitted.scale);
    D.setLod(1);

    ctx.save();
    ctx.fillStyle = 'rgba(239,231,216,0.45)';
    ctx.fillRect(view.x, view.y, view.w, view.h);
    ctx.restore();

    drawAppliedStage(ctx, stage);

    const projection = state.projection || {};
    const semanticDraft = state.semanticDraft || {};
    const semanticCandidates = (semanticDraft.candidates || []).filter((candidate) => !appliedIds.has(candidate.candidateId));
    const appliedSourceIds = new Set();
    for (const candidate of semanticDraft.candidates || []) {
      if (!appliedIds.has(candidate.candidateId)) continue;
      for (const sourceId of candidate.sourceIds || []) appliedSourceIds.add(sourceId);
    }
    const shapes = (projection.shapes || []).filter((shape) => !appliedSourceIds.has(shape.sourceId || shape.id));
    const strokes = (projection.strokes || []).filter((stroke) => !appliedSourceIds.has(stroke.sourceId || stroke.id));
    if (semanticCandidates.length) {
      semanticCandidates.forEach((candidate, index) => renderSemanticCandidate(ctx, candidate, index));
    } else {
      for (const shape of shapes) renderRectPlatform(ctx, shape);
      for (const stroke of strokes) renderStrokePlatform(ctx, stroke);
    }
    if (!semanticCandidates.length && !shapes.length && !strokes.length) renderEmptyHint(ctx, view);

    ctx.restore();
    return true;
  }

  DS.LevelPreview = {
    enter,
    exit,
    render,
    saveCapture,
    state,
  };
})(window);
