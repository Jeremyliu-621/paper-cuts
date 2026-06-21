// Bootstrap: canvas + DPR sizing, tab switching, help overlay, the frame loop.
(function (global) {
  'use strict';
  const DS = global.DS;

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const panel = document.getElementById('editor-panel');

  DS.DPR = Math.min(2, global.devicePixelRatio || 1);

  // keep the backing store matched to the displayed size; the editor panel changes
  // the canvas width on tab switch, so we check every frame (cheap) not just on resize
  function syncSize() {
    const needW = Math.max(1, Math.round(canvas.clientWidth * DS.DPR));
    const needH = Math.max(1, Math.round(canvas.clientHeight * DS.DPR));
    if (canvas.width !== needW || canvas.height !== needH) { canvas.width = needW; canvas.height = needH; }
  }
  global.addEventListener('resize', syncSize);

  DS.Store.load();
  DS.Input.init();

  const game = new DS.Game(canvas);
  const editor = new DS.Editor(game, canvas, panel);
  syncSize();

  function setActiveTab(tabName) {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
  }

  function hideRuntimeOverlays() {
    closeHelp();
    closeMenu();
    document.getElementById('draw-overlay').hidden = true;
  }

  function enterLevelPreview(world) {
    if (!world || !DS.LevelPreview) return;
    hideRuntimeOverlays();
    if (worldLibrary) worldLibrary.close();
    editor.deactivate();
    mode = 'levelPreview';
    setActiveTab('');
    setPreviewSaveState('Save', false);
    setPreviewApplyState('Apply Platforms', false);
    DS.LevelPreview.enter(world, {
      onActivity(activeWorld, activity) {
        if (!activeWorld || !worldLibrary) return;
        worldLibrary.updateWorld(activeWorld.id, {
          lastEditedAt: activity && activity.updatedAt ? activity.updatedAt : new Date().toISOString(),
        });
      },
    });
  }

  function exitLevelPreview() {
    if (DS.LevelPreview) DS.LevelPreview.exit();
  }

  function setPreviewSaveState(label, disabled) {
    const button = document.getElementById('level-preview-save');
    if (!button) return;
    button.textContent = label;
    button.disabled = !!disabled;
  }

  function setPreviewApplyState(label, disabled) {
    const button = document.getElementById('level-preview-apply');
    if (!button) return;
    button.textContent = label;
    button.disabled = !!disabled;
  }

  function openActiveDrawClient() {
    if (!DS.LevelPreview || !worldLibrary) return;
    const activeWorld = DS.LevelPreview.state && DS.LevelPreview.state.world;
    if (!activeWorld) return;
    const url = worldLibrary.drawClientUrl(activeWorld);
    global.open(url, '_blank', 'noopener');
  }

  async function saveLevelPreviewCapture() {
    if (!DS.LevelPreview || !worldLibrary) return;
    const activeWorld = DS.LevelPreview.state && DS.LevelPreview.state.world;
    const activeRoomId = DS.LevelPreview.state && DS.LevelPreview.state.roomId;
    if (!activeWorld) return;
    setPreviewSaveState('Saving...', true);
    try {
      const roomCapture = await DS.LevelPreview.saveCapture();
      if (!DS.LevelPreview.state || DS.LevelPreview.state.world !== activeWorld || DS.LevelPreview.state.roomId !== activeRoomId) {
        throw new Error('Level changed before save completed.');
      }
      const updated = worldLibrary.saveDrawingCapture(activeWorld.id, roomCapture);
      if (!updated) throw new Error('World save failed.');
      DS.LevelPreview.state.world = updated;
      setPreviewSaveState('Saved', true);
      window.setTimeout(() => setPreviewSaveState('Save', false), 1200);
    } catch (error) {
      console.warn('level preview save failed', error);
      setPreviewSaveState('Save failed', false);
    }
  }

  async function applyLevelPreviewSemanticDraft() {
    if (!DS.LevelPreview || !DS.MagicBoardGame || !worldLibrary) return;
    const activeWorld = DS.LevelPreview.state && DS.LevelPreview.state.world;
    if (!activeWorld) return;
    setPreviewApplyState('Applying...', true);
    try {
      let draft = DS.LevelPreview.state.semanticDraft;
      if (!draft) {
        const room = await DS.LevelPreview.saveCapture();
        draft = room.semanticDraft;
      }
      const mapId = activeWorld.mapId || 'meadow';
      const patch = DS.MagicBoardGame.buildPatchFromSemanticDraft(draft, {
        worldId: activeWorld.id,
        roomId: activeWorld.roomId || activeWorld.id,
        mapId,
        replacePlatforms: true,
      });
      if (!patch.operations.length) throw new Error('Confirm at least one platform first.');
      const result = DS.MagicBoardGame.applyPatch(patch, {
        rebuild() {
          game.mapId = mapId;
          game.rebuild();
        },
      });
      if (!result.ok) throw new Error(result.errors.join('; '));

      const stage = DS.Maps.stageFor(DS.Store.data, mapId);
      const platforms = patch.operations
        .filter((operation) => operation.type === 'add_platform')
        .map((operation) => operation.platform);
      const spawns = (stage.spawns && stage.spawns.length >= 2 ? stage.spawns : [{ x: 660, y: 780 }, { x: 1260, y: 780 }]).slice(0, 2);
      const characters = (DS.Store.data.roster || ['Sprout', 'Acorn']).slice(0, 2);
      const updated = worldLibrary.updateWorld(activeWorld.id, {
        lastEditedAt: new Date().toISOString(),
        mapId,
        draft: { platforms, spawns, characters },
      });
      if (updated) DS.LevelPreview.state.world = updated;
      setPreviewApplyState('Applied', true);
      window.setTimeout(() => setPreviewApplyState('Apply Platforms', false), 1400);
    } catch (error) {
      console.warn('semantic apply failed', error);
      setPreviewApplyState(error && error.message ? error.message : 'Apply failed', false);
      window.setTimeout(() => setPreviewApplyState('Apply Platforms', false), 2200);
    }
  }

  function openHomeLibrary() {
    if (global.history && global.history.replaceState && global.location.hash !== '#library') {
      global.history.replaceState(null, '', global.location.pathname + global.location.search + '#library');
    }
    exitLevelPreview();
    closeHelp();
    closeMenu();
    document.getElementById('draw-overlay').hidden = true;
    editor.deactivate();
    mode = 'play';
    setActiveTab('');
    if (game.state === 'playing') game.togglePause();
    if (worldLibrary) worldLibrary.open();
    else openMenu();
  }

  // how many fighters a match spawns: one per joined phone (2..6), else 2 for the keyboard.
  // read live at each rebuild so newly-joined phones are included in the next match.
  game.getPlayerCount = () => {
    if (!DS.Net.available()) return 2;
    return Math.max(2, Math.min(6, DS.Net.maxSlot() || 2));
  };
  const worldLibrary = DS.WorldLibrary && DS.WorldLibrary.init({
    onEdit(world) {
      enterLevelPreview(world);
    },
    onPlay(world) {
      exitLevelPreview();
      game.modeId = world.modeId || 'smash';
      game.mapId = world.mapId || 'meadow';
      document.querySelector('.tab[data-tab="play"]').click();
      game.rebuild();
      game.start();
    },
  });

  // tabs
  let mode = 'play';
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      setActiveTab(t.dataset.tab);
      mode = t.dataset.tab;
      exitLevelPreview();
      // the menu/lobby/draw overlays sit over the stage area — dismiss them when entering the
      // Editor so its canvas (platform dragging etc.) isn't covered
      if (mode === 'editor') { closeMenu(); if (worldLibrary) worldLibrary.close(); document.getElementById('draw-overlay').hidden = true; editor.activate(); }
      else { editor.deactivate(); }
    };
  });

  // help overlay
  const help = document.getElementById('help-overlay');
  const openHelp = () => { help.hidden = false; };
  const closeHelp = () => { help.hidden = true; };
  document.getElementById('btn-help').onclick = openHelp;
  document.getElementById('help-close').onclick = closeHelp;

  // ============ Setup page (mode + map) → Lobby page (QR + per-player ult/ready) ============
  const D = DS.draw, PAPER = D.COL.paper, ACCENT = D.COL.accent, POWER = '#2f6fe0', POWERD = '#1c46a8';
  const menu = document.getElementById('menu-overlay');
  const menuModes = document.getElementById('menu-modes');
  const menuMaps = document.getElementById('menu-maps');
  const lobby = document.getElementById('lobby-overlay');
  const lobbyQR = document.getElementById('lobby-qr');
  const lobbyPlayers = document.getElementById('lobby-players');
  const lobbyCols = document.getElementById('lobby-cols');
  const lobbyHint = document.getElementById('lobby-hint');
  const countdownOverlay = document.getElementById('countdown-overlay');
  const countdownCanvas = document.getElementById('countdown-canvas');
  let selMode = game.modeId || 'smash';
  let selMap = game.mapId || 'meadow';
  let ults = [], ready = [], cd = null; // cd = active countdown state (null when idle)
  let playerSkins = [], drawIndex = -1, drawing = null, drawHist = [];
  const drawOverlay = document.getElementById('draw-overlay');
  const drawCanvas = document.getElementById('draw-canvas');
  const drawTitle = document.getElementById('draw-title');
  const ULTS = [{ id: 'hammer', name: 'Hammer' }, { id: 'sniper', name: 'Sniper' }, { id: 'werewolf', name: 'Werewolf' }];
  const mkEl = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  // ---- doodle icons ----
  function paintCanvas(cv, lw, lh, fn) {
    const dpr = DS.DPR || 1; cv.width = Math.round(lw * dpr); cv.height = Math.round(lh * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, lw, lh); fn(ctx, lw, lh);
  }
  function drawUltIcon(ctx, id, w, h) {
    const rnd = DS.makeRng(id.length + 3); ctx.save(); ctx.translate(w / 2, h / 2);
    if (id === 'hammer') {
      ctx.rotate(0.5);
      D.line(ctx, 0, 13, 0, -12, { width: 5, color: POWER, rnd, passes: 1 });
      D.strokePts(ctx, [[-9, -12], [12, -12], [12, -24], [-9, -24]], { width: 4, color: POWER, rnd, closed: true, fill: POWERD });
    } else if (id === 'sniper') {
      D.circle(ctx, 0, 0, 14, { width: 4, color: ACCENT, rnd });
      D.line(ctx, -20, 0, 20, 0, { width: 3, color: ACCENT, rnd, passes: 1 });
      D.line(ctx, 0, -20, 0, 20, { width: 3, color: ACCENT, rnd, passes: 1 });
      D.circle(ctx, 0, 0, 3.5, { width: 3, color: ACCENT, rnd, fill: ACCENT });
    } else { // werewolf — front-facing snouted head
      const c = '#5b8c5a';
      D.strokePts(ctx, [[-12, -4], [-17, -21], [-3, -10]], { width: 3, color: c, rnd, closed: true, fill: PAPER });
      D.strokePts(ctx, [[12, -4], [17, -21], [3, -10]], { width: 3, color: c, rnd, closed: true, fill: PAPER });
      D.circle(ctx, 0, 0, 13, { width: 4, color: c, rnd, fill: PAPER });
      D.strokePts(ctx, [[-6, 6], [6, 6], [4, 17], [-4, 17]], { width: 3, color: c, rnd, closed: true, fill: PAPER });
      D.circle(ctx, 0, 15, 2.4, { width: 2.4, color: c, rnd, fill: c });
      ctx.fillStyle = c; for (const ex of [-5, 5]) { ctx.beginPath(); ctx.arc(ex, -2, 2, 0, 7); ctx.fill(); }
    }
    ctx.restore();
  }
  function drawModeIcon(ctx, id, w, h) {
    const rnd = DS.makeRng(id.length + 7); ctx.save(); ctx.translate(w / 2, h / 2);
    if (id === 'smash') {
      const c = '#c0603a', pts = []; for (let i = 0; i < 12; i++) { const r = i % 2 ? 9 : 22, a = i / 12 * 6.283; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
      D.strokePts(ctx, pts, { width: 4, color: c, rnd, closed: true, fill: PAPER });
    } else if (id === 'koth') {
      const c = '#b58a2e';
      D.strokePts(ctx, [[-20, 11], [-20, -6], [-10, 4], [0, -12], [10, 4], [20, -6], [20, 11]], { width: 4, color: c, rnd, closed: true, fill: PAPER });
    } else if (id === 'gems') {
      const c = '#3f6fa0';
      D.strokePts(ctx, [[0, -20], [16, -3], [0, 20], [-16, -3]], { width: 4, color: c, rnd, closed: true, fill: PAPER });
      D.line(ctx, -16, -3, 16, -3, { width: 2.5, color: c, rnd, passes: 1 });
    } else if (id === 'mayhem') {
      // a power-up crate with a star — random weapon pick-ups
      const c = '#c0603a';
      D.roundedRect(ctx, -18, -16, 36, 34, 5, { width: 4, color: c, rnd, fill: PAPER });
      const pts = []; for (let i = 0; i < 10; i++) { const r = i % 2 ? 4 : 10, a = i / 10 * 6.283 - Math.PI / 2; pts.push([Math.cos(a) * r, Math.sin(a) * r + 1]); }
      D.strokePts(ctx, pts, { width: 3, color: c, rnd, closed: true, fill: c });
    } else {
      const c = '#9a6cb0';
      D.circle(ctx, 0, 0, 20, { width: 4, color: c, rnd }); D.circle(ctx, 0, 0, 12, { width: 3, color: c, rnd }); D.circle(ctx, 0, 0, 4, { width: 3, color: c, rnd, fill: c });
    }
    ctx.restore();
  }
  function drawMapIcon(ctx, id, w, h) {
    let stage; try { stage = DS.Maps.stageFor(game.data, id); } catch (e) { stage = null; } // reflects edits
    if (!stage || !stage.platforms || !stage.platforms.length) return;
    const ps = stage.platforms; let a = 1e9, b = 1e9, c = -1e9, dd = -1e9;
    for (const p of ps) { a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x + p.w); dd = Math.max(dd, p.y + p.h); }
    const pad = 7, sc = Math.min((w - pad * 2) / (c - a), (h - pad * 2) / (dd - b)), rnd = DS.makeRng(5);
    ctx.save(); ctx.translate(pad + (w - pad * 2 - (c - a) * sc) / 2, pad + (h - pad * 2 - (dd - b) * sc) / 2);
    for (const p of ps) D.roundedRect(ctx, (p.x - a) * sc, (p.y - b) * sc, p.w * sc, Math.max(2.5, p.h * sc), 2, { width: 1.6, color: p.pass ? D.COL.inkSoft : D.COL.ink, rnd, fill: D.COL.paperShade });
    ctx.restore();
  }
  function iconCard(kind, id, name, sel, onclick) {
    const bt = mkEl('button', 'icon-card' + (sel ? ' sel' : '')); const cv = document.createElement('canvas');
    bt.appendChild(cv); bt.appendChild(mkEl('div', 'ic-name', name)); bt.onclick = onclick;
    paintCanvas(cv, 88, 60, (ctx) => (kind === 'mode' ? drawModeIcon : drawMapIcon)(ctx, id, 88, 60));
    return bt;
  }

  // ---- setup page ----
  function buildSetup() {
    menuModes.innerHTML = ''; DS.Modes.list().forEach((m) => menuModes.appendChild(iconCard('mode', m.id, m.name, selMode === m.id, () => { selMode = m.id; if (DS.Audio) DS.Audio.play('ui_move'); buildSetup(); })));
    menuMaps.innerHTML = ''; DS.Maps.list().forEach((m) => menuMaps.appendChild(iconCard('map', m.id, m.name, selMap === m.id, () => { selMap = m.id; if (DS.Audio) DS.Audio.play('ui_move'); buildSetup(); })));
  }
  function openMenu() {
    if (worldLibrary) worldLibrary.close();
    if (game.state === 'playing') game.togglePause();
    if (DS.Net.available()) { DS.Net.onChange = () => { if (!lobby.hidden) refreshLobby(); }; DS.Net.host(); }
    buildSetup(); lobby.hidden = true; cancelCountdown(); menu.hidden = false;
  }
  function closeMenu() { menu.hidden = true; lobby.hidden = true; cancelCountdown(); }

  // ---- lobby page ----
  function drawCharPreview(ctx, i, w, h) {
    const d = game.data, name = i < d.roster.length ? d.roster[i] : d.roster[0];
    let ch = d.characters[name];
    const sk = playerSkins[i];
    if (sk && sk.enabled) { ch = DS.data.clone(ch); ch.skin = sk; } // show the player's own drawing
    ctx.save(); ctx.translate(w / 2, h / 2 + 28);
    DS.character.drawFighter(ctx, ch, ch.actions.idle.pose, { facing: 1, seed: i * 1009 + 7 });
    ctx.restore();
  }
  function lobbyColumn(i) {
    const onPhone = DS.Net.hasPlayer(i + 1);   // a phone owns this slot → host shows it read-only
    const col = mkEl('div', 'lobby-col' + (ready[i] ? ' ready' : ''));
    const tag = mkEl('div', 'lobby-col-name', (onPhone ? '📱 ' : '') + 'P' + (i + 1));
    col.appendChild(tag);
    const cc = mkEl('canvas', 'lobby-char'); col.appendChild(cc); paintCanvas(cc, 120, 108, (ctx) => drawCharPreview(ctx, i, 120, 108));

    if (onPhone) {
      // mirror-only: the phone draws, picks an ult, and readies; the host just reflects it.
      col.appendChild(mkEl('div', 'lobby-onphone', 'drawing on phone…'));
      const ur = mkEl('div', 'lobby-ults');
      ULTS.forEach((u) => {
        const ub = mkEl('div', 'lobby-ult ro' + (ults[i] === u.id ? ' sel' : '')); const c2 = document.createElement('canvas');
        ub.appendChild(c2); paintCanvas(c2, 42, 42, (ctx) => drawUltIcon(ctx, u.id, 42, 42)); ub.title = u.name; ur.appendChild(ub);
      });
      col.appendChild(ur);
      col.appendChild(mkEl('div', 'lobby-ready ro' + (ready[i] ? ' on' : ''), ready[i] ? '✓ Ready' : 'not ready'));
      return col;
    }

    // keyboard slot (no phone) — the host drives draw / ult / ready as before
    const db = mkEl('button', 'lobby-draw', (playerSkins[i] && playerSkins[i].enabled) ? '✎ Redraw' : '✎ Draw');
    db.onclick = () => openDraw(i); col.appendChild(db);
    const ur = mkEl('div', 'lobby-ults');
    ULTS.forEach((u) => {
      const ub = mkEl('button', 'lobby-ult' + (ults[i] === u.id ? ' sel' : '')); const c2 = document.createElement('canvas');
      ub.appendChild(c2); paintCanvas(c2, 42, 42, (ctx) => drawUltIcon(ctx, u.id, 42, 42)); ub.title = u.name;
      ub.onclick = () => { ults[i] = u.id; if (DS.Audio) DS.Audio.play('ui_move'); buildLobbyCols(); }; ur.appendChild(ub);
    });
    col.appendChild(ur);
    const rb = mkEl('button', 'lobby-ready' + (ready[i] ? ' on' : ''), ready[i] ? '✓ Ready' : 'Ready');
    rb.onclick = () => { ready[i] = !ready[i]; if (DS.Audio) DS.Audio.play(ready[i] ? 'ready' : 'ui_back'); buildLobbyCols(); }; col.appendChild(rb);
    return col;
  }
  function buildLobbyCols() {
    lobbyCols.innerHTML = ''; for (let i = 0; i < ults.length; i++) lobbyCols.appendChild(lobbyColumn(i));
    const allReady = ults.length > 0 && ready.every(Boolean);
    lobbyHint.textContent = allReady ? 'starting…' : 'pick your ultimate, then Ready';
    if (allReady && !cd) startCountdown();
    else if (!allReady && cd) { cancelCountdown(); lobby.hidden = false; DS.Net.broadcast({ t: 'notstarting' }); }
  }
  function renderLobbyTop() {
    lobbyQR.innerHTML = ''; lobbyPlayers.innerHTML = '';
    if (DS.Net.available() && DS.Net.connected) {
      const img = document.createElement('img'); img.src = '/qr?d=' + encodeURIComponent(DS.Net.joinURL()); img.alt = 'scan to join';
      lobbyQR.appendChild(img); lobbyQR.appendChild(mkEl('div', 'lobby-cap', 'Scan to join')); lobbyQR.appendChild(mkEl('div', 'lobby-code', DS.Net.code));
      for (let s = 1; s <= DS.Net.MAX; s++) { const pl = DS.Net.players[s]; const chip = mkEl('div', 'lobby-slot' + (pl ? ' on' : '')); chip.appendChild(mkEl('span', 'slot-tag', 'P' + s)); chip.appendChild(mkEl('span', 'slot-name', pl ? pl.name : 'open')); lobbyPlayers.appendChild(chip); }
    } else {
      lobbyQR.appendChild(mkEl('div', 'lobby-note', 'Keyboard play — P1 & P2 share one keyboard. (Run node server.js for phone players.)'));
    }
  }
  function refreshLobby() {
    const n = Math.max(2, game.getPlayerCount ? game.getPlayerCount() : 2);
    for (let i = 0; i < n; i++) {
      const pl = DS.Net.players[i + 1];
      if (pl) {
        // a phone owns its own slot — adopt whatever it drew / picked / readied
        ults[i] = pl.ult || 'hammer';
        ready[i] = !!pl.ready;
        if (pl.skin) playerSkins[i] = pl.skin;
      } else {
        if (ults[i] == null) ults[i] = 'hammer';
        if (ready[i] == null) ready[i] = false;
      }
    }
    ults.length = n; ready.length = n; renderLobbyTop(); buildLobbyCols();
  }
  function openLobby() {
    menu.hidden = true; ults = []; ready = [];
    for (const s in DS.Net.players) DS.Net.players[s].ready = false; // clear stale ready (phones re-send)
    DS.Net.broadcast({ t: 'lobby' });   // tell any phones to (re)open their draw/ult/ready screen
    refreshLobby(); lobby.hidden = false;
  }

  // ---- dramatic full-screen countdown (its own canvas page) ----------------
  const CD_BEATS = ['3', '2', '1', 'FIGHT!'];
  const CD_DURS = [0.78, 0.78, 0.78, 1.05];
  const cdRnd = DS.makeRng(5);
  const lerp = (a, b, t) => a + (b - a) * t;
  // ease-out-back: shoots past the target then settles — gives the number its "slam" bounce
  const outBack = (t) => { const c = 1.9, d = c + 1; return 1 + d * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  function cdColor(b) { return b === '3' ? '#d4663f' : b === '2' ? '#2f6fe0' : b === '1' ? '#3f8f86' : '#d4663f'; }

  // TWO pre-match screens, both on this overlay/canvas: (1) the ROSTER — a Smash-style row of
  // full-height columns, one per player, that build in; then (2) the 3·2·1·FIGHT! COUNTDOWN.
  // the match is built up front (fighters frozen in 'ready') so the columns show real fighters.
  const COL_STAGGER = 0.13, COL_POP = 0.5, ROSTER_HOLD = 3.15;
  function startCountdown() {
    DS.Net.broadcast({ t: 'starting' });   // everyone's ready → tell phones to rotate to landscape now
    game.modeId = selMode; game.mapId = selMap; game.ultPick = ults.slice();
    game.playerSkins = playerSkins.map((s) => (s && s.enabled ? s : null));
    game.rebuild();
    lobby.hidden = true; countdownOverlay.hidden = false;
    // each fighter's display name: the phone gamertag for its slot, else "PLAYER n"
    const names = game.fighters.map((f, i) => { const pl = DS.Net.players[i + 1]; return (pl && pl.name) || ('PLAYER ' + (i + 1)); });
    cd = { phase: 'roster', t: 0, idx: -1, revealed: 0, shake: 0, flash: 0, spin: 0,
           parts: [], rings: [], fighters: game.fighters.slice(), ults: ults.slice(), names };
    if (DS.Audio) DS.Audio.play('ready');
  }
  function cancelCountdown() { cd = null; countdownOverlay.hidden = true; }

  function tickCommon(dt) {
    cd.t += dt; cd.spin += dt;
    cd.shake *= Math.pow(0.0009, dt); cd.flash = Math.max(0, cd.flash - dt * 1.6);
    for (const p of cd.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.9; p.vy *= 0.9; p.life -= dt; }
    cd.parts = cd.parts.filter((p) => p.life > 0);
    for (const r of cd.rings) r.t += dt;
    cd.rings = cd.rings.filter((r) => r.t < r.life);
  }

  function tickCountdown(dt) {
    if (dt > 0.05) dt = 0.05;
    tickCommon(dt);
    if (cd.phase === 'roster') { tickRoster(dt); return; }
    // ---- countdown phase ----
    let acc = 0, idx = 0;
    while (idx < CD_DURS.length && cd.t >= acc + CD_DURS[idx]) { acc += CD_DURS[idx]; idx++; }
    if (idx >= CD_BEATS.length) { const c = cd; cancelCountdown(); if (c) startMatch(); return; }
    if (idx !== cd.idx) { cd.idx = idx; cdImpact(CD_BEATS[idx]); }
    renderCount(CD_BEATS[idx], (cd.t - acc) / CD_DURS[idx]);
  }

  // ===== phase 1: ROSTER (full-height player columns, building in left-to-right) =====
  function tickRoster(dt) {
    const n = cd.fighters.length;
    while (cd.revealed < n && cd.t >= cd.revealed * COL_STAGGER + COL_POP * 0.45) {
      const i = cd.revealed++, col = cd.fighters[i].tagCol || ACCENT;
      if (DS.Audio) DS.Audio.play('join');
      cd.shake = Math.max(cd.shake, 8); cd.flash = Math.max(cd.flash, 0.16);
      for (let k = 0; k < 12; k++) { const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6, sp = 200 + Math.random() * 260;
        cd.parts.push({ x: 0, y: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.4 + Math.random() * 0.4, max: 0.8, col, card: i }); }
    }
    if (cd.t >= (n - 1) * COL_STAGGER + COL_POP + ROSTER_HOLD) { cd.phase = 'count'; cd.t = 0; cd.idx = -1; cd.parts.length = 0; cd.rings.length = 0; cd.shake = 0; cd.flash = 0; return; }
    renderRoster();
  }

  function renderRoster() {
    const cv = countdownCanvas, dpr = DS.DPR || 1, lw = cv.clientWidth, lh = cv.clientHeight;
    if (!lw || !lh) return;
    if (cv.width !== Math.round(lw * dpr)) { cv.width = Math.round(lw * dpr); cv.height = Math.round(lh * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, lw, lh);
    const n = cd.fighters.length, colW = lw / n, slant = Math.min(colW * 0.16, lw * 0.03);
    if (cd.flash > 0) { ctx.save(); ctx.globalAlpha = cd.flash * 0.16; ctx.fillStyle = ACCENT; ctx.fillRect(0, 0, lw, lh); ctx.restore(); }
    for (let i = 0; i < n; i++) {
      const p = Math.min(1, (cd.t - i * COL_STAGGER) / COL_POP); if (p <= 0) continue;
      drawColumn(ctx, cd.fighters[i], cd.ults[i], cd.names[i], i, n, colW, slant, lw, lh, p);
    }
    // slanted ink dividers between columns (draw in with the rightmost-revealed column)
    ctx.save(); ctx.globalAlpha = 0.9;
    for (let b = 1; b < n; b++) { const pp = Math.min(1, (cd.t - (b - 1) * COL_STAGGER) / COL_POP); if (pp <= 0.2) continue;
      D.line(ctx, b * colW + slant, -4, b * colW - slant, lh + 4, { width: 4, color: D.COL.ink, passes: 1, rnd: cdRnd }); }
    ctx.restore();
    // reveal sparks (column-tagged) drift up from each column centre
    for (const part of cd.parts) { if (part.card == null) continue; const cxp = (part.card + 0.5) * colW;
      ctx.globalAlpha = Math.min(1, (part.life / part.max) * 1.4);
      D.line(ctx, cxp + part.x, lh * 0.5 + part.y, cxp + part.x - part.vx * 0.03, lh * 0.5 + part.y - part.vy * 0.03, { width: 3, color: part.col, passes: 1, rnd: cdRnd }); }
    ctx.globalAlpha = 1;
  }

  // one full-height player column: tinted parallelogram bg, a slanted header banner holding the
  // P# + name + ult icon, and a big portrait filling the rest.
  function drawColumn(ctx, f, ultId, name, i, n, colW, slant, lw, lh, p) {
    const col = f.tagCol || ACCENT, cx = (i + 0.5) * colW;
    const a = Math.min(1, p * 1.6), slide = (1 - outBack(p)) * 70; // content slides up with overshoot
    const hb = lh * 0.2;                                           // header-banner height
    // parallelogram bounds (outer columns run off-screen so there are no gaps)
    const lt = i === 0 ? -300 : i * colW + slant, lb = i === 0 ? -300 : i * colW - slant;
    const rt = i === n - 1 ? lw + 300 : (i + 1) * colW + slant, rb = i === n - 1 ? lw + 300 : (i + 1) * colW - slant;
    // visible inner edges at the very top (for placing P# / ult icon inside the screen)
    const visL = i === 0 ? 0 : i * colW + slant, visR = i === n - 1 ? lw : (i + 1) * colW + slant, innerW = visR - visL;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(lt, 0); ctx.lineTo(rt, 0); ctx.lineTo(rb, lh); ctx.lineTo(lb, lh); ctx.closePath(); ctx.clip();
    // background: paper + a player-colour wash (stronger toward the bottom) + a few ember sparks.
    // fill the FULL canvas (the clip already limits it to this column's parallelogram) — a narrow
    // rect would miss the slanted bottom corner and leave an unfilled wedge along the divider.
    ctx.globalAlpha = a; ctx.fillStyle = D.COL.paper; ctx.fillRect(0, 0, lw, lh);
    const g = ctx.createLinearGradient(0, 0, 0, lh); g.addColorStop(0, D.mix(D.COL.paper, col, 0.05)); g.addColorStop(1, D.mix(D.COL.paper, col, 0.26));
    ctx.fillStyle = g; ctx.fillRect(0, 0, lw, lh);
    const er = DS.makeRng(f.pIndex * 31 + 7); ctx.fillStyle = col;
    for (let k = 0; k < 12; k++) { ctx.globalAlpha = a * (0.12 + er() * 0.18); const ex = lt + er() * (rt - lt), ey = hb + er() * (lh - hb), es = 1.5 + er() * 3; ctx.beginPath(); ctx.arc(ex, ey, es, 0, 7); ctx.fill(); }
    ctx.globalAlpha = a;
    // the fighter portrait, big, filling the column BELOW the banner (slides up into place)
    const zoom = Math.min((lh - hb) / 132, colW / 48);
    ctx.save(); ctx.translate(cx, hb + (lh - hb) * 0.56 + slide); ctx.scale(zoom, zoom);
    const pose = f.getPose ? f.getPose() : null;
    if (pose) DS.character.drawFighter(ctx, f.ch, pose, { facing: 1, expr: '', seed: f.pIndex * 1009 + 7 });
    ctx.restore();
    // ---- slanted header banner (parallelogram parallel to the dividers), solid player colour ----
    const dd = 2 * slant * hb / lh, by = -slide * 0.5;            // banner also eases down on reveal
    ctx.save(); ctx.translate(0, by);
    ctx.beginPath(); ctx.moveTo(lt - 12, 0); ctx.lineTo(rt + 12, 0); ctx.lineTo(rt + 12 - dd, hb); ctx.lineTo(lt - 12 - dd, hb); ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = D.mix(col, D.COL.ink, 0.5); ctx.lineJoin = 'round'; ctx.stroke();
    // the name, centred in the banner (smaller now that the P# tag is gone), fit to leave room
    // for the ult icon on the right
    let nm = String(name).toUpperCase(), nf = Math.min(innerW * 0.1, hb * 0.32);
    ctx.font = nf + "px 'Gloria Hallelujah', cursive";
    while (nf > 8 && ctx.measureText(nm).width > innerW * 0.72) { nf -= 1; ctx.font = nf + "px 'Gloria Hallelujah', cursive"; }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = D.COL.paper;
    ctx.fillText(nm, cx - dd * 0.5, hb * 0.5);
    // ult icon (top-right)
    const ic = hb * 0.4, k = ic / 42; ctx.save();
    ctx.translate(visR - innerW * 0.05 - ic, hb * 0.5 - ic / 2); ctx.scale(k, k); drawUltIcon(ctx, ultId || 'hammer', 42, 42); ctx.restore();
    ctx.restore();
    ctx.restore(); // unclip
  }

  // ===== phase 2: COUNTDOWN (big centred 3·2·1·FIGHT! with full-screen FX + shake) =====
  function cdImpact(b) {
    const big = b === 'FIGHT!', col = cdColor(b);
    if (DS.Audio) DS.Audio.play(big ? 'go' : 'count', { i: cd.idx });
    cd.shake = big ? 28 : 16; cd.flash = big ? 0.55 : 0.3;
    cd.rings.push({ t: 0, life: big ? 0.75 : 0.55, col });
    if (big) cd.rings.push({ t: -0.1, life: 0.85, col });
    const m = big ? 40 : 24;
    for (let i = 0; i < m; i++) { const a = (i / m) * 6.2832 + Math.random() * 0.25, sp = (big ? 440 : 320) + Math.random() * 380;
      cd.parts.push({ x: 0, y: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5 + Math.random() * 0.45, max: 0.95, col }); }
  }

  function renderCount(text, local) {
    const cv = countdownCanvas, dpr = DS.DPR || 1, lw = cv.clientWidth, lh = cv.clientHeight;
    if (!lw || !lh) return;
    if (cv.width !== Math.round(lw * dpr)) { cv.width = Math.round(lw * dpr); cv.height = Math.round(lh * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, lw, lh);
    const cx = lw / 2, cy = lh / 2, big = text === 'FIGHT!', col = cdColor(text), reach = Math.max(lw, lh), span = Math.min(lw, lh);
    if (cd.flash > 0) { ctx.save(); ctx.globalAlpha = cd.flash * 0.3; ctx.fillStyle = col; ctx.fillRect(0, 0, lw, lh); ctx.restore(); }
    ctx.save(); ctx.translate(cx + cdRnd.sym(cd.shake), cy + cdRnd.sym(cd.shake));
    // radiating speed lines
    const burst = Math.max(0, 1 - local * 2.4);
    ctx.globalAlpha = 0.08 + 0.16 * burst;
    for (let i = 0; i < 20; i++) { const a = cd.spin * 0.25 + (i / 20) * 6.2832, r0 = 130 + 36 * Math.sin(i * 1.7), r1 = reach * (0.45 + 0.55 * burst);
      D.line(ctx, Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * r1, Math.sin(a) * r1, { width: 3, color: D.COL.inkSoft, passes: 1, rnd: cdRnd }); }
    ctx.globalAlpha = 1;
    for (const r of cd.rings) { const e = Math.max(0, r.t / r.life); if (e <= 0) continue;
      ctx.globalAlpha = 0.5 * (1 - e); D.circle(ctx, 0, 0, reach * 0.62 * (e * (2 - e)), { width: 6, color: r.col, rnd: cdRnd, passes: 1, wob: 5 }); }
    for (const p of cd.parts) { ctx.globalAlpha = Math.min(1, (p.life / p.max) * 1.4);
      D.line(ctx, p.x, p.y, p.x - p.vx * 0.03, p.y - p.vy * 0.03, { width: 4, color: p.col, passes: 1, rnd: cdRnd }); }
    ctx.globalAlpha = 1;
    let s = 1, alpha = 1;
    if (local < 0.16) { s = lerp(2.8, 1, outBack(Math.min(1, local / 0.16))); alpha = Math.min(1, local / 0.05); }
    else if (local < 0.82 || big) { s = 1 + 0.025 * Math.sin(cd.t * 24); }
    else { const o = (local - 0.82) / 0.18; s = 1 + 0.8 * o; alpha = 1 - o; }
    const fs = span * (big ? 0.2 : 0.46) * s;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = fs + "px 'Gloria Hallelujah', cursive"; ctx.globalAlpha = alpha;
    const off = fs * 0.05;
    ctx.fillStyle = D.mix(col, D.COL.ink, 0.55); ctx.fillText(text, off, off);
    ctx.fillStyle = col; ctx.fillText(text, 0, 0);
    ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, fs * 0.018); ctx.strokeStyle = D.COL.ink; ctx.strokeText(text, 0, 0);
    ctx.globalAlpha = 1; ctx.restore();
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function startMatch() {
    // the match was already built in startCountdown (for the intro close-ups) — just go live
    lobby.hidden = true;
    DS.Net.broadcast({ t: 'play' });   // flip every phone from its draw/ready screen to the game pad
    document.querySelector('.tab[data-tab="play"]').click();
    game.start();
  }

  // ---- draw-your-fighter pad (host mouse) — strokes auto-sort into body parts (DS.skin) ----
  function manXform(lw, lh) { const Z = Math.min(lw / 100, lh / 124); return { cx: lw / 2, cy: lh / 2 - 4 * Z, Z }; }
  function toMan(e) {
    const r = drawCanvas.getBoundingClientRect(), T = manXform(r.width, r.height);
    return [((e.clientX - r.left) - T.cx) / T.Z, ((e.clientY - r.top) - T.cy) / T.Z];
  }
  function renderDraw() {
    const cv = drawCanvas, dpr = DS.DPR || 1, lw = cv.clientWidth, lh = cv.clientHeight;
    if (!lw || !lh) return;
    if (cv.width !== Math.round(lw * dpr)) { cv.width = Math.round(lw * dpr); cv.height = Math.round(lh * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, lw, lh);
    const T = manXform(lw, lh); ctx.save(); ctx.translate(T.cx, T.cy); ctx.scale(T.Z, T.Z);
    DS.skin.drawMannequin(ctx, 'auto');
    const sk = playerSkins[drawIndex];
    if (sk) DS.skin.PARTS.forEach((name) => { const pt = sk.parts[name]; if (!pt.strokes.length) return; ctx.save(); ctx.translate(DS.skin.PIVOTS[name].x, DS.skin.PIVOTS[name].y); DS.skin.drawStrokes(ctx, pt.strokes, DS.makeRng(9)); ctx.restore(); });
    if (drawing && drawing.pts.length) DS.draw.strokePts(ctx, drawing.pts, { width: drawing.w, color: DS.draw.COL.accent, rnd: DS.makeRng(3), jitter: 0.3, passes: 1 });
    ctx.restore();
  }
  function storeStroke(s) {
    const sk = playerSkins[drawIndex]; if (!sk || s.pts.length < 2) return;
    const part = DS.skin.assign(s.pts), piv = DS.skin.PIVOTS[part];
    sk.parts[part].strokes.push({ pts: s.pts.map((p) => [p[0] - piv.x, p[1] - piv.y]), w: s.w });
    drawHist.push(part); sk.enabled = true;
    if (DS.Audio) DS.Audio.play('draw');
  }
  function openDraw(i) { if (!playerSkins[i]) playerSkins[i] = DS.skin.emptySkin(); drawIndex = i; drawing = null; drawHist = []; drawTitle.textContent = 'P' + (i + 1) + ' — draw your fighter'; drawOverlay.hidden = false; }
  function closeDraw() { drawOverlay.hidden = true; drawIndex = -1; drawing = null; if (!lobby.hidden) buildLobbyCols(); }
  drawCanvas.addEventListener('pointerdown', (e) => { if (drawIndex < 0) return; e.preventDefault(); drawing = { pts: [toMan(e)], w: 6 }; try { drawCanvas.setPointerCapture(e.pointerId); } catch (_) {} });
  window.addEventListener('pointermove', (e) => { if (drawing) drawing.pts.push(toMan(e)); });
  window.addEventListener('pointerup', () => { if (drawing) { storeStroke(drawing); drawing = null; } });
  document.getElementById('draw-undo').onclick = () => { const p = drawHist.pop(); const sk = playerSkins[drawIndex]; if (sk && p && sk.parts[p].strokes.length) sk.parts[p].strokes.pop(); };
  document.getElementById('draw-clear').onclick = () => { playerSkins[drawIndex] = DS.skin.emptySkin(); drawHist = []; };
  document.getElementById('draw-done').onclick = closeDraw;

  document.getElementById('brand-home').onclick = () => {
    if (DS.Audio) DS.Audio.play('ui_confirm');
    openHomeLibrary();
  };
  document.getElementById('btn-menu').onclick = () => { if (DS.Audio) DS.Audio.play('ui_confirm'); openMenu(); };
  document.getElementById('level-preview-library').onclick = () => {
    openHomeLibrary();
  };
  document.getElementById('level-preview-draw').onclick = () => {
    if (DS.Audio) DS.Audio.play('ui_confirm');
    openActiveDrawClient();
  };
  document.getElementById('level-preview-apply').onclick = () => {
    if (DS.Audio) DS.Audio.play('ui_confirm');
    applyLevelPreviewSemanticDraft();
  };
  document.getElementById('level-preview-save').onclick = () => {
    if (DS.Audio) DS.Audio.play('ui_confirm');
    saveLevelPreviewCapture();
  };
  document.getElementById('menu-start').onclick = () => { if (DS.Audio) DS.Audio.play('ui_confirm'); openLobby(); };       // Next → lobby
  document.getElementById('lobby-back').onclick = () => { if (DS.Audio) DS.Audio.play('ui_back'); cancelCountdown(); lobby.hidden = true; menu.hidden = false; };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { if (!drawOverlay.hidden) { closeDraw(); return; } closeHelp(); closeMenu(); }
  });
  // expose so the frame loop can paint the draw pad live
  DS._renderDraw = () => { if (!drawOverlay.hidden) renderDraw(); };

  // input source: a phone on slot (i+1) drives fighter i, else the keyboard does.
  // (global keys like Enter/P stay on the keyboard inside game.update.)
  const inputSource = {
    player(i) {
      const slot = i + 1;
      return DS.Net.hasPlayer(slot) ? DS.Net.player(slot) : DS.Input.player(i);
    },
  };

  // frame loop
  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.05) dt = 0.05; // clamp big stalls so physics stays sane

    // never let a per-frame exception kill the rAF loop (a dead loop = frozen game)
    try {
      syncSize();
      ctx.setTransform(DS.DPR, 0, 0, DS.DPR, 0, 0);
      const cssW = canvas.clientWidth, cssH = canvas.clientHeight;

      if (mode === 'levelPreview') {
        if (DS.LevelPreview) DS.LevelPreview.render(ctx, cssW, cssH);
      } else if (mode === 'play') {
        // --- dev camera zoom: see the whole arena / blast borders ---
        //  -  zoom out   ·   =  zoom in   ·   0  toggle overview   ·   \  back to auto
        if (DS.Input.pressed('Digit0')) game.devZoom = game.devZoom ? null : 0.3;
        if (DS.Input.pressed('Backslash')) game.devZoom = null;
        if (DS.Input.held['Minus']) game.devZoom = Math.max(0.1, (game.devZoom || game.cam.zoom) * (1 - dt * 1.8));
        if (DS.Input.held['Equal']) {
          const z = (game.devZoom || game.cam.zoom) * (1 + dt * 1.8);
          game.devZoom = z >= 1.15 ? null : z; // zoom all the way in → resume auto camera
        }
        if (DS.Input.pressed('KeyB')) game.devBars = !game.devBars; // toggle the fastness speed gauge
        if (DS.Input.pressed('KeyU')) game.fighters.forEach((f) => { f.charge = 1; }); // dev: charge both ultimates
        game.update(dt, inputSource);
        game.render(cssW, cssH);
      } else {
        editor.render(cssW, cssH);
      }
      if (DS._renderDraw) DS._renderDraw(); // live-paint the draw pad when open
      if (cd) tickCountdown(dt);            // drive the dramatic countdown when active
      DS.Input.update();
      DS.Net.update();
    } catch (e) {
      if (global.__showErr) global.__showErr((e && e.message) || String(e));
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // expose for debugging and optional creation overlay bridge
  DS.game = game; DS.editor = editor;
  if (DS.CreateOverlay) DS.CreateOverlay.init();

  // dev self-test: instant projectile + standing-jab vs dash-jab knockback (movement = power)
  if (location.hash === '#combattest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      a.x = 500; a.y = 826; a.vx = 0; a.vy = 0; a.onGround = true; a.facing = 1; a.action = null; a.specialCd = 0; game.projectiles.length = 0;
      a.update(1 / 60, mk({ pressSpecial: true }), game.world);
      const instant = game.projectiles.length === 1;
      // immediate re-press is blocked by the cooldown; after it elapses it fires again
      a.action = null; a.update(1 / 60, mk({ pressSpecial: true }), game.world);
      const blocked = game.projectiles.length === 1;
      a.action = null; a.specialCd = 0; a.update(1 / 60, mk({ pressSpecial: true }), game.world);
      const refire = game.projectiles.length === 2;
      // standing jab vs a momentum (fast) swing — fast picks the harder super punch (which now
      // has a startup), so step frames until its hit lands. attacker stays put so it connects.
      const swing = (fast) => {
        b.x = 560; b.y = 826; b.vx = 0; b.vy = 0; b.onGround = true; b.invuln = 0; b.respawnT = 0; b.damage = 0;
        a.x = 520; a.y = 826; a.onGround = true; a.facing = 1; a.vx = 0; a.dashT = 0; a.momentum = fast ? 1 : 0; a.action = null; a.attackCd = 0;
        a.update(1 / 60, mk({ pressAttack: true }), game.world);
        for (let i = 0; i < 16 && Math.abs(b.vx) < 1; i++) a.update(1 / 60, mk(), game.world);
        return Math.abs(b.vx);
      };
      const stand = swing(false), dash = swing(true);
      const pass = instant && blocked && refire && stand < 90 && dash > stand + 30;
      window.__showErr('COMBAT: instant=' + instant + ' cd[block=' + blocked + ',refire=' + refire + '] standKB=' + Math.round(stand) + ' dashKB=' + Math.round(dash) + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: contextual attacks pick the right move by state
  if (location.hash === '#condtest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      const setup = (o) => { a.x = 500; a.y = 826; a.vx = 0; a.vy = 0; a.onGround = true; a.dashT = 0; a.momentum = 0; a.facing = 1; a.action = null; a.specialCd = 0; a.attackCd = 0; a.hitstun = 0; a.invuln = 0; Object.assign(a, o); };
      const pick = (press, o) => { setup(o); a.update(1 / 60, mk(press), game.world); return a.action && a.action.name; };
      b.x = 4000; b.y = 826; b.invuln = 9; // far away by default (out of melee range)
      // "fast" = momentum (from a dash), NOT raw speed: running fast but momentum 0 stays normal
      const jabGround = pick({ pressAttack: true }, {});
      const jabRun = pick({ pressAttack: true }, { vx: 760 });          // fast vx, no momentum → still jab
      const jabAir = pick({ pressAttack: true }, { onGround: false, y: 400 });
      const jabMom = pick({ pressAttack: true }, { momentum: 1 });      // momentum → super punch
      const spNormal = pick({ pressSpecial: true }, { vx: 760 });        // fast vx, no momentum → normal shot
      const spFar = pick({ pressSpecial: true }, { momentum: 1 });
      b.x = 540; // now within melee range for the close-special case
      const spClose = pick({ pressSpecial: true }, { momentum: 1 });
      const pass = jabGround === 'attack' && jabRun === 'attack' && jabAir === 'hammer' && jabMom === 'superpunch'
        && spNormal === 'special' && spFar === 'supershot' && spClose === 'ultrapunch';
      window.__showErr('COND: jab[grnd=' + jabGround + ',run=' + jabRun + ',air=' + jabAir + ',mom=' + jabMom + '] sp[norm=' + spNormal + ',far=' + spFar + ',close=' + spClose + ']  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: rising SPEAR vs falling HAMMER, gating, upward launch, and overhead hit
  if (location.hash === '#speartest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      const base = () => { a.x = 500; a.y = 400; a.vx = 0; a.onGround = false; a.action = null; a.attackCd = 0; a.hitstun = 0; a.invuln = 0; a.momentum = 0; a.airSpearUsed = false; a._clock = 10; a.facing = 1; };
      const jab = () => { a.update(1 / 60, mk({ pressAttack: true }), game.world); return a.action && a.action.name; };
      b.x = 4000; b.invuln = 9;
      base(); a.vy = -200; a.lastUpPress = 10; const rising = jab(); const spearVy = a.vy, jv = a.ch.stats.jumpVel, used = a.airSpearUsed;
      base(); a.vy = 200;  a.lastUpPress = 10; const falling = jab(); // up+jab close → SPEAR even while falling
      base(); a.vy = -200; a.lastUpPress = 9;  const stale = jab();   // up-press too old → hammer
      base(); a.vy = -200; a.lastUpPress = 10; a.airSpearUsed = true; const spent = jab(); // already speared → hammer
      // jumping OUT of a dash must still record the up-press (the reported bug)
      base(); a.dashT = 0.2; a.dashDir = 1; a.jumps = 2; a.vy = -100; a.lastUpPress = -99;
      a.update(1 / 60, mk({ pressUp: true }), game.world);     // double-jump that cancels the dash
      const dashJump = jab();                                  // → SPEAR (up-press was just recorded)
      // overhead hit: place an opponent just above and confirm the spear connects
      base(); a.vy = -200; a.lastUpPress = 10; b.x = 506; b.y = 345; b.invuln = 0; b.respawnT = 0; b.dead = false; b.damage = 0;
      let hit = false; jab(); for (let i = 0; i < 8 && !hit; i++) { a.update(1 / 60, mk({}), game.world); if (b.damage > 0) hit = true; }
      const farther = spearVy < -jv * 1.3; // launched upward well past a normal jump
      const pass = rising === 'spear' && used === true && falling === 'spear' && stale === 'hammer' && spent === 'hammer' && dashJump === 'spear' && farther && hit;
      window.__showErr('SPEAR: rise=' + rising + ' fall=' + falling + ' stale=' + stale + ' spent=' + spent + ' dashJump=' + dashJump + ' vy=' + spearVy.toFixed(0) + ' overheadHit=' + hit + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  if (location.hash.indexOf('#spearshow') === 0) { // freeze mid-spear for a screenshot
    game.start();
    setTimeout(() => {
      const a = game.fighters[0]; if (game.fighters[1]) game.fighters[1].x = -99999;
      const mk = (o) => Object.assign({ left: 0, right: 0, up: 0, down: 0, shield: 0, pressLeft: 0, pressRight: 0, pressUp: 0, pressDown: 0, pressAttack: 0, pressSpecial: 0 }, o || {});
      a.x = 960; a.y = 470; a.vx = 0; a.vy = -200; a.onGround = false; a.facing = 1; a.invuln = 0; a.action = null; a.attackCd = 0; a._clock = 10; a.lastUpPress = 10; a.airSpearUsed = false;
      const step = parseInt(location.hash.split('=')[1], 10) || 3;
      a.update(1 / 60, mk({ pressAttack: 1 }), game.world);
      for (let i = 1; i < step; i++) a.update(1 / 60, mk({}), game.world);
      game.cam = { cx: a.x + 150, cy: a.y - 70, zoom: 3.6 }; game.state = 'paused';
    }, 250);
  }

  // dev self-test: Gem Grab — reaching 10 arms a 15s hold (no instant win), a KO spills the
  // gems + cancels the countdown, and holding the lead the full time wins
  if (location.hash === '#gemtest') {
    game.modeId = 'gems'; game.rebuild(); game.start();
    setTimeout(() => {
      const m = game.mode, st = game.modeState, a = game.fighters[0], b = game.fighters[1];
      a.x = 500; a.y = 700; a.dead = false; a.respawnT = 0; b.x = 99999; b.invuln = 9; b.respawnT = 9;
      // reach the target → arms the timer, does NOT win instantly
      st.counts[0] = st.target; st.gems = []; m.update(game, 0.1);
      const armed = st.holdBy === 0 && game.state === 'playing' && st.holdT > st.holdTime - 0.2;
      // KO before the timer ends → spills `target` gems and zeroes the count
      const before = st.gems.length; a.lastHitBy = b; m.onKO(game, a);
      const spilled = st.counts[0] === 0 && st.gems.length === before + st.target;
      m.update(game, 0.1);
      const cancelled = st.holdBy === -1;
      // hold the lead the full time → win
      st.counts[0] = st.target; st.counts[1] = 0; st.gems = []; b.x = 99999;
      let won = false; const N = Math.ceil(st.holdTime / 0.1) + 6;
      for (let i = 0; i < N; i++) { st.gems = []; m.update(game, 0.1); if (game.state !== 'playing' && game.winner === a) { won = true; break; } }
      const pass = armed && spilled && cancelled && won;
      window.__showErr('GEM: target=' + st.target + ' hold=' + st.holdTime + 's armed=' + armed + ' spillTo=' + spilled + ' cancel=' + cancelled + ' won=' + won + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 200);
  }

  // dev self-test: boomerang hammer — throw spawns it, it flies out then returns to the thrower
  if (location.hash === '#boomtest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      const b = game.fighters[1];
      a.x = 600; a.y = 826; a.onGround = true; a.facing = 1; a.action = null; game.projectiles.length = 0;
      b.x = 760; b.y = 826; b.vx = 0; b.vy = 0; b.invuln = 0; b.hitstun = 0; b.damage = 0; b.respawnT = 0; b.dead = false; // in the path
      a._startAction('ulthammer');
      for (let i = 0; i < 12 && game.projectiles.length === 0; i++) { a.update(1 / 60, mk(), game.world); }
      const spawned = game.projectiles.length === 1 && game.projectiles[0].boomerang;
      const x0 = spawned ? game.projectiles[0].x : 0;
      let maxOut = x0, returned = false;
      for (let i = 0; i < 240 && game.projectiles.length; i++) {
        game._updateProjectiles(1 / 60);
        if (game.projectiles[0]) { maxOut = Math.max(maxOut, game.projectiles[0].x); if (game.projectiles[0].phase === 'back') returned = true; }
      }
      const wentOut = maxOut - x0 > 150, cameBack = returned && game.projectiles.length === 0;
      const finiteHit = b.damage > 0 && isFinite(b.vx) && isFinite(b.vy) && isFinite(b.x); // no NaN teleport
      // directional: holding UP throws it up-forward (vy < 0), same as the normal shot
      b.x = -99999; a.x = 600; a.action = null; game.projectiles.length = 0;
      a._startAction('ulthammer');
      for (let i = 0; i < 12 && game.projectiles.length === 0; i++) { a.update(1 / 60, mk({ up: true }), game.world); }
      const aimedUp = game.projectiles.length === 1 && game.projectiles[0].vy < -100;
      const pass = spawned && wentOut && cameBack && finiteHit && aimedUp;
      window.__showErr('BOOM: out=' + Math.round(maxOut - x0) + ' returned=' + returned + ' finiteHit=' + finiteHit + ' aimUp=' + aimedUp + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: a per-player drawn skin is applied to that fighter only (lobby → match)
  if (location.hash === '#skintest') {
    game.start();
    setTimeout(() => {
      const sk = DS.skin.emptySkin();
      sk.parts.head.strokes.push({ pts: [[-8, 0], [8, 0]], w: 5 }); sk.enabled = true;
      game.playerSkins = [sk, null];
      game.rebuild();
      const f0 = game.fighters[0], f1 = game.fighters[1];
      const applied = f0.ch.skin === sk && DS.skin.hasSkin(f0.ch);
      const p2clean = f1.ch.skin !== sk; // the other fighter didn't get P1's drawing
      const pass = applied && p2clean;
      window.__showErr('SKIN: applied=' + applied + ' p2clean=' + p2clean + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.playerSkins = null; game.state = 'paused';
    }, 300);
  }

  // dev self-test: ultimate charges from damage dealt, double-tap G fires it (single = normal special)
  if (location.hash === '#ulttest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      a.charge = 0; a.ultType = 'hammer'; a.ult = null; a.combo = 0;
      const hit = { x: 0, y: 0, r: 30, damage: 25, kbBase: 1, kbScale: 0.01, angle: 0 };
      for (let i = 0; i < 3; i++) { b.invuln = 0; b.hitstun = 0; b.respawnT = 0; b.dead = false; b._takeHit(hit, 1, a, game.world); }
      const charge = a.charge, ready = a._ultReady();
      // single G (ready) → normal special, NOT the ult
      a.x = 500; a.y = 826; a.onGround = true; a.action = null; a.specialCd = 0; a.momentum = 0; a._clock = 10; a.lastGPress = -1;
      a.update(1 / 60, mk({ pressSpecial: true }), game.world);
      const single = a.action && a.action.name;
      // double-tap G within the window → the ultimate
      // a normal shot is in flight (from the 1st tap); the double-tap activation must clear it
      game.projectiles.length = 0;
      game.projectiles.push({ owner: a, cfg: {}, x: a.x, y: a.y, vx: 100, vy: 0, life: 1, r: 10, spin: 0 });
      a.action = null; a.specialCd = 0; a.charge = 1; a.ult = null; a.lastGPress = a._clock;
      a.update(1 / 60, mk({ pressSpecial: true }), game.world);
      const dbl = a.action && a.action.name;
      const cleared = !game.projectiles.some((pr) => pr.owner === a && !pr.boomerang);
      const pass = ready && charge >= 1 && single === 'special' && dbl === 'ulthammer' && cleared;
      window.__showErr('ULT: charge=' + charge.toFixed(2) + ' ready=' + ready + ' single=' + single + ' double=' + dbl + ' clearedShot=' + cleared + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev visual: a fully-charged fighter (blue lines + meter). =swing swings the hammer; =sniper aims
  if (location.hash.indexOf('#ultshow') === 0) {
    game.start();
    const v = location.hash.split('=')[1];
    setTimeout(() => {
      const a = game.fighters[0];
      if (game.fighters[1]) game.fighters[1].x = -99999;
      a.x = 960; a.y = 700; a.onGround = true; a.facing = 1; a.invuln = 0; a.charge = 1;
      if (v === 'hit') { game.effects.ultHit(a.x, a.y - 8, 1.4, a.tagCol); game.effects.update(0.16); } // preview the connect burst
      else if (v === 'sniper') { a.ultType = 'sniper'; a._activateUlt(game.world); a.ult.aim = -1.0; } // aimed up
      else if (v === 'boom') {
        a.ultType = 'hammer'; if (game.fighters[1]) game.fighters[1].x = -99999;
        a._startAction('ulthammer');
        const neutral = { left: 0, right: 0, up: 0, down: 0, shield: 0, pressLeft: 0, pressRight: 0, pressUp: 0, pressDown: 0, pressAttack: 0, pressSpecial: 0 };
        for (let i = 0; i < 22; i++) { a.update(1 / 60, neutral, game.world); game._updateProjectiles(1 / 60); }
      }
      else if (v === 'wolf' || v === 'slash' || v === 'claw') {
        a.ultType = 'werewolf'; a._activateUlt(game.world);
        if (v === 'slash') { a._startAction('wolfslash'); a.action.t = (a.action.data.startup + 1) / 60; }
        else if (v === 'claw') { a._startAction('clawswipe'); a.action.t = 1 / 60; }
      } else { a.ultType = 'hammer'; if (v === 'swing') { a._startAction('ulthammer'); a.action.t = 0.6 * ((a.action.data.startup + a.action.data.active + a.action.data.recovery) / 60); } }
      const wv = v === 'wolf' || v === 'claw' || v === 'slash';
      game.cam = { cx: a.x + (wv ? 260 : v === 'boom' ? 170 : 0), cy: a.y - 30, zoom: wv ? 2.0 : v === 'boom' ? 1.4 : 1.7 }; game.state = 'paused';
    }, 250);
  }

  // dev self-test: sniper ult — activate (aim), A/D rotate, G fires, F cancels with a jab
  if (location.hash === '#sniptest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      a.x = 600; a.y = 826; a.onGround = true; a.facing = 1; a.charge = 1; a.ultType = 'sniper'; a.ult = null; a.action = null; a.specialCd = 0; a._clock = 10; a.lastGPress = a._clock;
      a.update(1 / 60, mk({ pressSpecial: true }), game.world);
      const aiming = !!a.ult && a.ult.type === 'sniper', aim0 = a.ult ? a.ult.aim : 0;
      for (let i = 0; i < 10; i++) a.update(1 / 60, mk({ left: true }), game.world);
      const rotated = !!a.ult && Math.abs(a.ult.aim - aim0) > 0.05;
      game.projectiles.length = 0;
      a.update(1 / 60, mk({ pressSpecial: true }), game.world);
      const fired = game.projectiles.length === 1 && !a.ult;
      a.charge = 1; a.ult = null; a.action = null; a._clock += 1; a.lastGPress = a._clock;
      a.update(1 / 60, mk({ pressSpecial: true }), game.world);
      a.update(1 / 60, mk({ pressAttack: true }), game.world);
      const cancelJab = !a.ult && a.action && a.action.name === 'attack';
      // homing: fire a shot aimed straight, put the target above the line → it should curve up
      const b = game.fighters[1];
      game.projectiles.length = 0;
      game.projectiles.push({ owner: a, cfg: { speed: 2400, damage: 1, kbBase: 0, kbScale: 0, angle: 0, gravity: 0, life: 1, r: 13, sniper: true }, x: a.x, y: a.y, vx: 2400, vy: 0, life: 1, r: 13, facing: 1, spin: 0 });
      b.x = a.x + 300; b.y = a.y - 200; b.invuln = 0; b.dead = false; b.respawnT = 0; // up and to the right
      const vy0 = game.projectiles[0].vy;
      for (let i = 0; i < 4; i++) game._updateProjectiles(1 / 60);
      const homed = game.projectiles[0] && game.projectiles[0].vy < vy0 - 20; // curved upward toward the target
      const pass = aiming && rotated && fired && cancelJab && homed;
      window.__showErr('SNIP: aim=' + aiming + ' rotate=' + rotated + ' fire=' + fired + ' cancel=' + cancelJab + ' homed=' + homed + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: werewolf — transform, claw (alternating) + AOE slash, 5 air jumps, lifesteal
  if (location.hash === '#wolftest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      a.x = 600; a.y = 826; a.onGround = true; a.facing = 1; a.charge = 1; a.ultType = 'werewolf'; a.ult = null; a.action = null; a.specialCd = 0; a.attackCd = 0; a._clock = 10; a.lastGPress = a._clock;
      a.update(1 / 60, mk({ pressSpecial: true }), game.world);
      const on = !!a.ult && a.ult.type === 'werewolf';
      a.action = null; a.attackCd = 0; a.update(1 / 60, mk({ pressAttack: true }), game.world);
      const claw = a.action && a.action.name === 'clawswipe', paw1 = a.ult.paw;
      a.action = null; a.attackCd = 0; a.update(1 / 60, mk({ pressAttack: true }), game.world);
      const alt = a.ult.paw !== paw1;
      a.action = null; a.specialCd = 0; a.update(1 / 60, mk({ pressSpecial: true }), game.world);
      const slash = a.action && a.action.name === 'wolfslash';
      a.action = null; a.onGround = true; a.vx = 0; a.update(1 / 60, mk({ pressUp: true }), game.world);
      const jumps5 = a.jumps === 5; // maxJumps buffed to 6 → 5 air jumps left after the ground jump
      const big = Math.abs(a.h - 74 * a.scale * 2) < 1; // transformed to 2x size
      // the werewolf KEEPS the spear: airborne + up-press + jab → spear (not clawswipe)
      a.action = null; a.attackCd = 0; a.onGround = false; a.vy = -200; a.airSpearUsed = false; a.lastUpPress = a._clock;
      a.update(1 / 60, mk({ pressAttack: true }), game.world);
      const wolfSpear = a.action && a.action.name === 'spear';
      a.damage = 50; b.x = 4000; b.invuln = 0; b.hitstun = 0; b.respawnT = 0; b.dead = false; b.combo = 0;
      const before = a.damage; b._takeHit({ x: 0, y: 0, r: 30, damage: 10, kbBase: 1, kbScale: 0.01, angle: 0 }, 1, a, game.world);
      const lifesteal = a.damage < before;
      const pass = on && claw && alt && slash && jumps5 && lifesteal && big && wolfSpear;
      window.__showErr('WOLF: on=' + on + ' claw=' + claw + ' alt=' + alt + ' slash=' + slash + ' jumps=' + a.jumps + ' lifesteal=' + lifesteal + ' 2x=' + big + ' spear=' + wolfSpear + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: match-end no longer freezes — it runs a live OUTRO, then the victory screen
  if (location.hash === '#victorytest') {
    game.start();
    setTimeout(() => {
      const noInput = { player() { return { left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }; } };
      const a = game.fighters[0];
      // decide a winner — the match must NOT slam to a halt, it enters the live outro
      game.endMatch(a);
      const outro = game.state === 'outro' && game.winner === a && game.outroT > 0;
      // the world keeps simulating during the outro (timer decrements, fighters still tick) —
      // step past the brief win-moment freeze-frame (hitstop) first
      const beforeT = game.outroT; for (let i = 0; i < 16; i++) game.update(1 / 60, noInput);
      const live = game.state === 'outro' && game.outroT < beforeT;
      // run past OUTRO_DUR → the brush wipe kicks in (not an instant cut to victory)
      let steps = 0; while (game.state === 'outro' && steps < 600) { game.update(1 / 60, noInput); steps++; }
      const wipe = game.state === 'wipe' && !!game.wipe && game.wipe.t >= 0 && !!game.victory;
      // step through the wipe → it resolves to the victory screen
      steps = 0; while (game.state === 'wipe' && steps < 600) { game.update(1 / 60, noInput); steps++; }
      const screen = game.state === 'victory' && !!game.victory && game.winner === a;
      // the celebration animates: time advances and confetti spawns
      const t0 = game.victory.t; game.update(0.2, noInput); game.update(0.2, noInput);
      const anim = game.victory.t > t0 && game.victory.parts.length > 0;
      const pass = outro && live && wipe && screen && anim;
      window.__showErr('VICTORY: outro=' + outro + ' live=' + live + ' wipe=' + wipe + ' screen=' + screen + ' anim=' + anim + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev visual: park on the victory screen at a nice animated frame (for screenshots)
  if (location.hash === '#victoryshow') {
    game.start();
    setTimeout(() => {
      const noInput = { player() { return { left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }; } };
      game.endMatch(game.fighters[0]);
      let steps = 0; while (game.state === 'outro' && steps < 600) { game.update(1 / 60, noInput); steps++; }
      steps = 0; while (game.state === 'wipe' && steps < 600) { game.update(1 / 60, noInput); steps++; }
      for (let i = 0; i < 90; i++) game.update(1 / 60, noInput); // advance the celebration ~1.5s
    }, 300);
  }

  // dev self-test: the five twist maps build and their gimmicks work (boxes/trampoline/cannons/portals)
  if (location.hash === '#maptest') {
    const noInput = { player() { return { left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }; } };
    const out = [];
    const build = (id) => { game.mapId = id; game.rebuild(); game.state = 'playing'; };
    try {
      // all five build without throwing, with sane platform counts
      let built = true;
      for (const id of ['crates', 'bounce', 'cannons', 'portals', 'chaos']) { build(id); if (!game.stage.platforms.length) built = false; }
      out.push('built=' + built);

      // CRATES: every platform is a breakable box
      build('crates');
      const allBoxes = game.stage.platforms.every((p) => p.kind === 'box');
      out.push('allBoxes=' + allBoxes);

      // BOUNCE: a fighter dropped onto the trampoline rockets back up (vy strongly negative)
      build('bounce');
      const tramp = game.stage.platforms.find((p) => p.bounce);
      const f = game.fighters[0];
      f.x = tramp.x + tramp.w / 2; f.y = tramp.y - 200; f.vx = 0; f.vy = 600; f.onGround = false; f.action = null; f.hitstun = 0; f.invuln = 0;
      let bounced = false;
      for (let i = 0; i < 40; i++) { game.update(1 / 60, noInput); if (f.vy < -900) { bounced = true; break; } }
      out.push('trampoline=' + bounced + '(' + Math.round(f.vy) + ')');

      // CANNONS: the battery auto-fires cannonballs into the arena
      build('cannons');
      let sawBall = false;
      for (let i = 0; i < 200 && !sawBall; i++) { game.update(1 / 60, noInput); if (game.projectiles.some((pr) => pr.cfg && pr.cfg.cannon)) sawBall = true; }
      out.push('cannonball=' + sawBall);

      // PORTALS: stepping into portal A whisks the fighter to its linked exit B
      build('portals');
      const A = game.stage.portals[0], B = game.stage.portals.find((q) => q.id === A.link);
      const g = game.fighters[0];
      g.x = A.x; g.y = A.y; g.vx = 0; g.vy = 0; g._portalCd = 0; g.dead = false; g.respawnT = 0;
      game.update(1 / 60, noInput);
      const warped = Math.hypot(g.x - B.x, g.y - B.y) < 80;
      out.push('portal=' + warped);

      const pass = built && allBoxes && bounced && sawBall && warped;
      window.__showErr('MAPS: ' + out.join(' ') + '  ' + (pass ? 'PASS' : 'FAIL'));
    } catch (e) {
      window.__showErr('MAPS: ERR ' + e.message + ' | ' + out.join(' ') + '  FAIL');
    }
    game.mapId = 'meadow'; game.rebuild(); game.state = 'paused';
  }

  // dev visual: load a specific map for a screenshot, e.g. #mapshow=cannons
  if (location.hash.indexOf('#mapshow') === 0) {
    const id = location.hash.split('=')[1] || 'chaos';
    const noInput = { player() { return { left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }; } };
    game.mapId = id; game.rebuild(); game.state = 'playing'; game.devZoom = 0.42;
    setTimeout(() => { for (let i = 0; i < 90; i++) game.update(1 / 60, noInput); game.update = function () {}; }, 250);
  }

  // dev visual: freeze on the win instant (darken veil + shake) for a screenshot
  if (location.hash === '#winshow') {
    game.start();
    setTimeout(() => {
      const noInput = { player() { return { left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }; } };
      game.endMatch(game.fighters[0]);
      for (let i = 0; i < 55; i++) game.update(1 / 60, noInput); // veil flare + camera push-in on the winner
      game.update = function () {}; // freeze so the screenshot catches it
    }, 300);
  }

  // dev visual: park mid brush-wipe (for screenshots of the transition itself)
  if (location.hash === '#wipeshow') {
    game.start();
    setTimeout(() => {
      const noInput = { player() { return { left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }; } };
      game.endMatch(game.fighters[0]);
      let steps = 0; while (game.state === 'outro' && steps < 600) { game.update(1 / 60, noInput); steps++; }
      // advance the wipe to roughly its midpoint so both halves + the brush band are visible
      while (game.state === 'wipe' && game.wipe.t < game.wipe.dur * 0.5) game.update(1 / 60, noInput);
      game.update = function () {}; // freeze the frame so the screenshot catches the mid-wipe
    }, 300);
  }

  // dev self-test: the jab now has a cooldown (can't be machine-gunned)
  if (location.hash === '#jabtest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      a.x = 500; a.y = 826; a.onGround = true; a.vx = 0; a.momentum = 0; a.action = null; a.attackCd = 0; a.invuln = 0;
      a.update(1 / 60, mk({ pressAttack: true }), game.world);
      const first = !!a.action && a.action.name === 'attack', cd = a.attackCd;
      a.action = null; a.update(1 / 60, mk({ pressAttack: true }), game.world);
      const blockedImmediately = !a.action; // cooldown blocks the next jab
      for (let i = 0; i < 20; i++) a.update(1 / 60, mk({}), game.world); // wait out the cd
      a.action = null; a.update(1 / 60, mk({ pressAttack: true }), game.world);
      const refires = !!a.action && a.action.name === 'attack';
      const pass = first && cd > 0.15 && blockedImmediately && refires;
      window.__showErr('JAB: first=' + first + ' cd=' + cd.toFixed(2) + ' blocked=' + blockedImmediately + ' refire=' + refires + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: hammer damage scales with fall height but stays modest (jab+ish)
  if (location.hash === '#hammerdmg') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      const dmgFromFall = (fall) => {
        b.damage = 0; b.invuln = 0; b.hitstun = 0; b.respawnT = 0; b.dead = false;
        a.combo = 0; a.comboT = 0; // isolate each measurement from the combo multiplier
        a.x = b.x = 900; a.facing = 1; a.action = null;
        a.y = b.y - fall; a._startAction('hammer'); a._slamY = a.y;
        a.y = b.y - 4; // now "fallen" to the target
        a.action.t = a.action.data.startup / 60; // into the active window
        a._updateAction(1 / 60, game.world, mk0());
        return b.damage;
      };
      function mk0() { return { up: false, down: false }; }
      const low = dmgFromFall(20), high = dmgFromFall(600), huge = dmgFromFall(1200);
      // uncapped now: a short hop stays jab-ish, a big drop hits hard, a huge drop hits even harder
      const pass = low >= 6 && low < 7 && high > 12 && huge > high + 5;
      window.__showErr('HAMMERDMG: low=' + low.toFixed(1) + ' high=' + high.toFixed(1) + ' huge=' + huge.toFixed(1) + ' (uncapped)  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: mashing jump+dash must NOT let you fly forever (bounded air time)
  if (location.hash === '#flytest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      a.x = 960; a.onGround = true; a.vx = 0; a.vy = 0; a.invuln = 0; a.y = a._spawnPt ? a._spawnPt.y : 700;
      const startY = a.y; let minY = a.y, groundedLate = 0;
      for (let i = 0; i < 300; i++) {
        a.update(1 / 60, mk({ pressUp: true, pressRight: true, right: true }), game.world);
        minY = Math.min(minY, a.y);
        if (i > 120 && a.onGround) groundedLate++;
      }
      const climbed = Math.round(startY - minY);
      const ok = climbed < 700 && groundedLate > 0; // came back down within ~700px
      window.__showErr('FLY: climbed=' + climbed + 'px groundedLate=' + groundedLate + '  ' + (ok ? 'OK' : 'BUG'));
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: the air hammer holds at the slam until landing, then ends
  if (location.hash === '#hammertest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      a.x = 900; a.y = 300; a.onGround = false; a.vy = 0; a.invuln = 0; a.action = null;
      a._startAction('hammer');
      const d = a.action.data, activeEnd = (d.startup + d.active) / 60;
      // advance many airborne frames — the action must NOT end, and a.t holds at the slam
      for (let i = 0; i < 40; i++) { a.onGround = false; if (a.action) a._updateAction(1 / 60, game.world, mk()); }
      const heldAir = !!a.action && Math.abs(a.action.t - activeEnd) < 0.02;
      // now "land": let it run out the recovery and end
      let ended = false;
      for (let i = 0; i < 40; i++) { a.onGround = true; if (a.action) a._updateAction(1 / 60, game.world, mk()); if (!a.action) { ended = true; break; } }
      const pass = heldAir && ended;
      window.__showErr('HAMMER: heldAirborne=' + heldAir + ' endsAfterLanding=' + ended + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: momentum builds on dash, walking stays low, a jump carries it, it decays
  if (location.hash === '#momtest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      a.x = 500; a.y = 826; a.vx = 0; a.vy = 0; a.onGround = true; a.dashT = 0; a.momentum = 0; a.invuln = 0; a.action = null;
      // walk at full run speed for a while — momentum must stay ~0 (not fast)
      for (let i = 0; i < 30; i++) a.update(1 / 60, mk({ right: true }), game.world);
      const walkMom = a.momentum, walkFast = a._fast();
      // dash → momentum to full (fast)
      a.dashT = 0; a.lastRightPress = a._clock - 0.05; a.update(1 / 60, mk({ pressRight: true, right: true }), game.world);
      const dashFast = a._fast(), dashMom = a.momentum;
      // jump out of the dash, then coast a few frames in the air — momentum carries
      a.update(1 / 60, mk({ pressUp: true, right: true }), game.world);
      for (let i = 0; i < 6; i++) a.update(1 / 60, mk({ right: true }), game.world);
      const airCarry = a._fast();
      // let it sit (no dash) ~0.7s — momentum decays away
      for (let i = 0; i < 42; i++) a.update(1 / 60, mk({}), game.world);
      const decayed = !a._fast();
      const pass = walkMom < 0.05 && !walkFast && dashFast && dashMom > 0.9 && airCarry && decayed;
      window.__showErr('MOM: walk=' + walkMom.toFixed(2) + '(' + walkFast + ') dash=' + dashMom.toFixed(2) + '(' + dashFast + ') airCarry=' + airCarry + ' decayed=' + decayed + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev visual: the fastness speed gauge — P1 slow (below threshold), P2 fast (above)
  if (location.hash === '#barsshow') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      game.devBars = true;
      a.x = 760; a.y = 700; a.vx = 180; a.onGround = true; a.invuln = 0;
      b.x = 1160; b.y = 700; b.vx = 720; b.onGround = true; b.invuln = 0;
      game.cam = { cx: 960, cy: 640, zoom: 1.4 };
      game.state = 'paused';
    }, 250);
  }

  // dev visual: freeze ANY move mid-animation. #moveshow=ultrapunch,0.4
  if (location.hash.indexOf('#moveshow') === 0) {
    game.start();
    const parts = (location.hash.split('=')[1] || 'superpunch,0.5').split(',');
    const name = parts[0], ph = parseFloat(parts[1]);
    setTimeout(() => {
      const a = game.fighters[0];
      if (game.fighters[1]) game.fighters[1].x = -99999; // keep the other fighter out of frame
      a.x = 960; a.y = 300; a.onGround = name !== 'hammer'; a.vy = 0; a.vx = 700; a.facing = 1; a.invuln = 0; a.dashT = 0;
      a._startAction(name);
      if (!a.action) { window.__showErr('no action: ' + name); return; }
      const tt = (a.action.data.startup + a.action.data.active + a.action.data.recovery) / 60;
      a.action.t = (isNaN(ph) ? 0.5 : ph) * tt; a.vy = 0; a.y = 300;
      game.cam = { cx: a.x, cy: a.y - 10, zoom: 2.4 }; game.state = 'paused';
    }, 250);
  }

  // dev visual: ground spikes from a hammer-slam landing
  if (location.hash === '#spikeshow') {
    game.start();
    setTimeout(() => {
      const f = game.fighters[0];
      const gy = f.y + f.h / 2;
      game.effects.groundSpikes(f.x, gy, 1.3);
      game.effects.update(0.18); // let the spikes pop up
      game.cam = { cx: f.x, cy: f.y, zoom: 2.0 };
      game.state = 'paused';
    }, 250);
  }

  // dev visual: freeze the hammer slam mid-swing
  if (location.hash.indexOf('#hammershow') === 0) {
    game.start();
    const ph = parseFloat(location.hash.split('=')[1]);
    setTimeout(() => {
      const a = game.fighters[0];
      a.x = 960; a.y = 230; a.onGround = false; a.vy = 0; a.facing = 1; a.invuln = 0;
      a._startAction('hammer');
      const total = (a.action.data.startup + a.action.data.active + a.action.data.recovery) / 60;
      a.action.t = (isNaN(ph) ? 0.5 : ph) * total; a.vy = 0; a.y = 230;
      game.cam = { cx: a.x, cy: a.y, zoom: 2.4 };
      game.state = 'paused';
    }, 250);
  }

  // dev self-test: a combo chain scales the % dealt and bumps the combo counter
  if (location.hash === '#combotest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      a.combo = 0; a.comboT = 0; b.damage = 0; b.invuln = 0; b.respawnT = 0; b.dead = false;
      const hit = { x: 0, y: 0, r: 30, damage: 10, kbBase: 1, kbScale: 0.01, angle: 0 };
      const dmgOf = () => { const before = b.damage; b.invuln = 0; b.hitstun = 0; b._takeHit(hit, 1, a, game.world); return b.damage - before; };
      const d1 = dmgOf();                 // combo 1 → ×1.00 → 10
      const d2 = dmgOf();                 // combo 2 → ×1.12 → 11.2
      const c2 = a.combo;
      for (let i = 0; i < 8; i++) dmgOf(); // push the chain past the cap
      const dCap = dmgOf();               // capped at +80% → 18
      // breaking it: the attacker getting hit resets their chain
      a.invuln = 0; a.hitstun = 0; a._takeHit(hit, -1, b, game.world);
      const reset = a.combo === 0;
      const pass = Math.abs(d1 - 10) < 0.1 && d2 > d1 + 0.5 && c2 === 2 && Math.abs(dCap - 18) < 0.1 && reset;
      window.__showErr('COMBO: d1=' + d1.toFixed(1) + ' d2=' + d2.toFixed(1) + ' combo2=' + c2 + ' capped=' + dCap.toFixed(1) + ' breakReset=' + reset + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev visual: freeze a frame with an active combo + high % so the HUD juice is visible
  if (location.hash === '#comboshow') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      a.combo = 5; a.comboT = 1.1; a.comboFlash = 0.4; a.damage = 64;
      b.damage = 132; b.hitFlash = 0.9; // in danger + just took a big hit
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: triple jump (1 ground + 2 air) each refreshing the air-dash, no 4th
  if (location.hash === '#triplejump') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0];
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      a.x = 600; a.y = 400; a.vx = 0; a.vy = 0; a.onGround = true; a.dead = false; a.respawnT = 0; a.hitstun = 0; a.dashT = 0; a.invuln = 0;
      const vys = [];
      const jump = () => { a.update(1 / 60, mk({ pressUp: true }), game.world); vys.push(Math.round(a.vy)); a.update(1 / 60, mk(), game.world); };
      a.onGround = true; jump();            // ground jump
      jump();                               // air jump 1
      jump();                               // air jump 2 (the third)
      const dashFresh = !a.airDashUsed;     // air-dash available after the 3rd jump
      const before = a.vy;
      a.update(1 / 60, mk({ pressUp: true }), game.world); // 4th press → no jump
      const noFourth = a.vy >= before - 5;
      const pass = vys.length === 3 && vys.every((v) => v < -300) && dashFresh && noFourth && a.ch.stats.maxJumps === 3;
      window.__showErr('TRIPLE: vys=' + vys.join(',') + ' max=' + a.ch.stats.maxJumps + ' dashFresh=' + dashFresh + ' noFourth=' + noFourth + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: two overlapping fighters separate (no phasing)
  if (location.hash === '#bodytest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      a.x = 600; a.y = 826; a.vx = 100; a.vy = 0; a.onGround = true; a.dead = false; a.respawnT = 0;
      b.x = 610; b.y = 826; b.vx = -100; b.vy = 0; b.onGround = true; b.dead = false; b.respawnT = 0;
      game._resolveBodies();
      const gap = Math.abs(b.x - a.x), need = (a.w + b.w) / 2;
      const pass = gap >= need - 1 && a.vx === 0 && b.vx === 0;
      window.__showErr('BODY: gap=' + Math.round(gap) + ' need>=' + Math.round(need) + ' vx[a=' + Math.round(a.vx) + ',b=' + Math.round(b.vx) + ']  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev self-test: ledge grab + hang + climb recovery
  if (location.hash === '#ledgetest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], plat = game.stage.platforms.find((p) => !p.pass);
      const rx = plat.x + plat.w, ry = plat.y;
      const mk = (o) => Object.assign({ left: false, right: false, up: false, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false }, o || {});
      a.ledge = null; a.ledgeCd = 0; a.hitstun = 0; a.onGround = false; a.dead = false; a.respawnT = 0; a.invuln = 0;
      a.x = rx + 20; a.y = ry + 20; a.vx = 0; a.vy = 200;
      a.update(1 / 60, mk(), game.world);
      const grabbed = !!a.ledge, side = a.ledge && a.ledge.side;
      for (let i = 0; i < 14; i++) a.update(1 / 60, mk(), game.world); // hang through the lock
      const stillHang = !!a.ledge;
      a.update(1 / 60, mk({ left: true }), game.world); // toward stage from a right ledge -> climb
      const climbed = a.onGround && !a.ledge;
      const pass = grabbed && side === 'right' && stillHang && climbed;
      window.__showErr('LEDGE: grab=' + grabbed + ' side=' + side + ' hang=' + stillHang + ' climbed=' + climbed + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }

  // dev visual: a fighter hanging on the right stage ledge (to eyeball the grip pose).
  // set up synchronously + pause immediately so the dynamic camera can't drift off it.
  if (location.hash === '#ledgeshow') {
    game.start();
    const plat = game.stage.platforms.find((p) => !p.pass);
    const b = game.fighters[1];
    b.invuln = 0;
    b._grabLedge(plat, 'right', plat.x + plat.w, plat.y);
    game.cam = { cx: plat.x + plat.w, cy: plat.y + 40, zoom: 3.4 };
    game.state = 'paused';
  }

  // dev visual: fire a KO flame-jet and freeze a frame mid-blast to eyeball it.
  // optional advance time after the launch: #koshow=0.9 freezes 0.9s into the blast.
  if (location.hash.indexOf('#koshow') === 0) {
    game.start();
    const adv = parseFloat(location.hash.split('=')[1]) || 0.45;
    setTimeout(() => {
      // a REAL launch + KO through the _ko path so we see the blast at the actual border
      // with the live (zoomed-out) camera, exactly as it appears in a match
      const f = game.fighters[1];
      f.invuln = 0; f.damage = 120; f.vx = 1500; f.vy = -1000; // rocket off up-and-right
      for (let i = 0; i < 120 && f.respawnT <= 0 && !f.dead; i++) game.update(1 / 60, DS.Input);
      for (let i = 0; i < Math.round(adv * 60); i++) game.effects.update(1 / 60);
      game.state = 'paused';
    }, 250);
  }
  // dev visual: the overview zoom engaged so the whole arena + blast borders are visible
  if (location.hash === '#zoomshow') {
    game.start();
    setTimeout(() => { game.devZoom = 0.3; game.state = 'paused'; }, 250);
  }
  if (location.hash === '#kotest') {
    game.start();
    setTimeout(() => {
      const b = game.fighters[1], bb = game.data.settings.blast;
      b.invuln = 0; b.x = 999999; b.vx = 1400; b.vy = -300; // shove past the right blast line
      b.update(0.016, { left: 0, right: 0 }, game.world);
      const beamP = game.effects.particles.find((p) => p.type === 'beam');
      const ring = game.effects.particles.filter((p) => p.type === 'ring').length;
      const onBorder = beamP && Math.abs(beamP.x - bb.right) < 1; // origin clamped to the border
      const trailsBack = beamP && Math.cos(beamP.ang) < 0;        // spurts opposite the launch (-x)
      const pass = !!beamP && ring >= 1 && onBorder && trailsBack && b.respawnT > 0;
      window.__showErr('KO: beam=' + (beamP ? 1 : 0) + ' ring=' + ring + ' onBorder=' + onBorder + ' trailsBack=' + trailsBack + '  ' + (pass ? 'PASS' : 'FAIL'));
    }, 200);
  }

  // dev/demo: open with #play to jump straight into a match, #editor for the editor
  // dev self-test: synthesize a pointer drag on a platform and report if it moved
  if (location.hash === '#dragtest') {
    editor.subtab = 'stage';
    document.querySelector('.tab[data-tab="editor"]').click();
    setTimeout(() => {
      const pl = game.data.stage.platforms[1];
      const before = pl.x;
      const rect = canvas.getBoundingClientRect();
      const sx = rect.left + game.ox + (pl.x + pl.w / 2) * game.scale;
      const sy = rect.top + game.oy + (pl.y + pl.h / 2) * game.scale;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: sx, clientY: sy, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: sx + 160, clientY: sy + 30, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: sx + 160, clientY: sy + 30, bubbles: true }));
      const ok = Math.abs(pl.x - before) > 80;
      window.__showErr('DRAG TEST platform[1]: x ' + Math.round(before) + ' -> ' + Math.round(pl.x) + '  ' + (ok ? 'PASS' : 'FAIL'));
    }, 500);
  }
  // dev: inject a hand-authored skin on both fighters and run the demo, to verify
  // that drawn parts render and animate through the existing rig
  if (location.hash === '#skindraw') {
    const mk = () => ({ enabled: true, parts: {
      head: { strokes: [{ pts: [[-14, -14], [14, -14], [14, 14], [-14, 14], [-14, -14]], w: 5 }] },
      body: { strokes: [{ pts: [[0, -13], [11, -2], [8, 11], [-8, 11], [-11, -2], [0, -13]], w: 5 }] },
      armFront: { strokes: [{ pts: [[0, 0], [17, 24]], w: 6 }] },
      armBack: { strokes: [{ pts: [[0, 0], [-15, 26]], w: 6 }] },
      legFront: { strokes: [{ pts: [[0, 0], [8, 31]], w: 7 }] },
      legBack: { strokes: [{ pts: [[0, 0], [-7, 31]], w: 7 }] },
    } });
    game.data.characters[game.data.roster[0]].skin = mk();
    game.data.characters[game.data.roster[1]].skin = mk();
    game.rebuild(); game.demo = true; game.start();
  }
  // dev self-test: synthesize strokes in two regions and verify they auto-sort correctly
  if (location.hash === '#drawtest') {
    editor.subtab = 'draw'; editor.drawMode = 'auto';
    document.querySelector('.tab[data-tab="editor"]').click();
    setTimeout(() => {
      const ch = game.data.characters[game.data.roster[0]]; editor._ensureSkin(ch);
      const rect = canvas.getBoundingClientRect();
      const Z = editor.Z, cx = game.data.view.w / 2, cy = game.data.view.h / 2;
      const toClient = (mx, my) => ({ x: rect.left + game.ox + (cx + mx * Z) * game.scale, y: rect.top + game.oy + (cy + my * Z) * game.scale });
      const stroke = (m1, m2) => {
        const a = toClient(m1[0], m1[1]), b = toClient(m2[0], m2[1]);
        canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: a.x, clientY: a.y, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: b.x, clientY: b.y, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: b.x, clientY: b.y, bubbles: true, pointerId: 1 }));
      };
      stroke([-6, -32], [6, -28]);   // head region
      stroke([8, 40], [10, 44]);     // front-leg region
      stroke([-15, 18], [-18, 26]);  // back-arm region
      const c = ch.skin.parts;
      const pass = c.head.strokes.length === 1 && c.legFront.strokes.length === 1 && c.armBack.strokes.length === 1;
      window.__showErr('DRAW TEST  head=' + c.head.strokes.length + ' legFront=' + c.legFront.strokes.length + ' armBack=' + c.armBack.strokes.length + '  ' + (pass ? 'PASS' : 'FAIL'));
    }, 500);
  }
  // dev self-test: fire a projectile at a lined-up opponent, step sim, check damage
  if (location.hash === '#projtest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      a.x = 500; a.y = 760; a.facing = 1; b.x = 760; b.y = 760; b.invuln = 0; b.respawnT = 0; b.damage = 0;
      game.world.spawnProjectile(a, a.ch.actions.special.projectile);
      let hit = false;
      for (let i = 0; i < 90; i++) { game._updateProjectiles(1 / 60); if (b.damage > 0) { hit = true; break; } }
      window.__showErr('PROJ TEST: opponent damage=' + Math.round(b.damage) + '  ' + (hit ? 'PASS' : 'FAIL'));
    }, 300);
  }
  // dev: freeze a projectile mid fade-out so the poof is visible in a screenshot
  if (location.hash === '#pooftest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0];
      game.world.spawnProjectile(a, Object.assign({}, a.ch.actions.special.projectile, { angle: 90, speed: 120, life: 0.02 }));
      for (let i = 0; i < 40; i++) { game._updateProjectiles(1 / 60); const pr = game.projectiles[0]; if (pr && pr.fade != null && pr.fade < 0.15) break; }
      game.state = 'paused';
    }, 350);
  }
  // dev self-test: ground dash (with trail) + air dash
  if (location.hash === '#dashtest') {
    game.start();
    setTimeout(() => {
      const mk = (pl, pr) => ({ left: pl, right: pr, up: false, down: false, shield: false, pressLeft: pl, pressRight: pr, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false });
      // ground dash + let it run so an after-image trail builds
      const f = game.fighters[0]; f.x = 1150; f.y = 826; f.vx = 0; f.vy = 0;
      f.update(1 / 60, mk(false, false), game.world);
      f._clock = 0; f.lastLeftPress = -1;
      f.update(1 / 60, mk(true, false), game.world);
      for (let i = 0; i < 5; i++) f.update(1 / 60, mk(false, false), game.world);
      f.update(1 / 60, mk(true, false), game.world);          // dash left
      for (let i = 0; i < 6; i++) f.update(1 / 60, mk(false, false), game.world);
      // air dash
      const g = game.fighters[1]; g.x = 520; g.y = 420; g.vx = 0; g.vy = 200; g.onGround = false; g.airDashUsed = false;
      g.update(1 / 60, mk(false, false), game.world);
      g._clock = 0; g.lastRightPress = -1;
      g.update(1 / 60, mk(false, true), game.world);
      for (let i = 0; i < 5; i++) g.update(1 / 60, mk(false, false), game.world);
      g.update(1 / 60, mk(false, true), game.world);          // air dash right
      const airPass = g.dashT > 0 && Math.abs(g.vx) > 600;
      for (let i = 0; i < 5; i++) g.update(1 / 60, mk(false, false), game.world);
      const smoke = game.effects.particles.length;
      window.__showErr('DASH: airDash vx=' + Math.round(g.vx) + ' used=' + g.airDashUsed + ' smoke=' + smoke + '  ' + (airPass && smoke > 0 ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 350);
  }
  // dev: place fighters far apart and converge the camera; expect zoom-out + drift toward them
  if (location.hash === '#camtest') {
    game.start();
    setTimeout(() => {
      const a = game.fighters[0], b = game.fighters[1];
      a.x = 220; a.y = 520; b.x = 2580; b.y = 280;
      for (let i = 0; i < 150; i++) game._updateCamera(1 / 60);
      const c = game.cam;
      const pass = c.zoom < 0.95 && c.cx > 1100;
      window.__showErr('CAM: cx=' + Math.round(c.cx) + ' cy=' + Math.round(c.cy) + ' zoom=' + c.zoom.toFixed(2) + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 350);
  }
  // dev self-test: fire the special straight / aimed up / aimed down
  if (location.hash === '#aimtest') {
    game.start();
    setTimeout(() => {
      const f = game.fighters[0]; f.x = 600; f.y = 826; f.vx = 0; f.vy = 0;
      const mk = (up, down) => ({ left: false, right: false, up, down, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false });
      const fire = (up, down) => {
        f.action = null; game.projectiles.length = 0; f._startAction('special');
        for (let i = 0; i < 40 && !game.projectiles.length; i++) f._updateAction(1 / 60, game.world, mk(up, down));
        return game.projectiles[0] || { vy: NaN };
      };
      const s = fire(false, false), u = fire(true, false), d = fire(false, true);
      const pass = Math.abs(s.vy) < 1 && u.vy < -100 && d.vy > 100;
      window.__showErr('AIM: straight vy=' + Math.round(s.vy) + '  up vy=' + Math.round(u.vy) + '  down vy=' + Math.round(d.vy) + '  ' + (pass ? 'PASS' : 'FAIL'));
      game.state = 'paused';
    }, 300);
  }
  // dev: fire an up-aimed special and freeze it so the throw pose + angled trail are visible
  if (location.hash === '#aimshow') {
    game.start();
    setTimeout(() => {
      const f = game.fighters[0]; f.x = 540; f.y = 826; f.vx = 0; f.vy = 0; f.onGround = true; f.facing = 1;
      const up = { left: false, right: false, up: true, down: false, shield: false, pressLeft: false, pressRight: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false };
      f._startAction('special');
      for (let i = 0; i < 20; i++) { f._updateAction(1 / 60, game.world, up); game._updateProjectiles(1 / 60); }
      game.cam = { cx: 760, cy: 640, zoom: 1.15 };
      game.state = 'paused';
    }, 300);
  }
  if (location.hash === '#demo') { game.demo = true; game.start(); }
  else if (location.hash === '#library') { if (worldLibrary) worldLibrary.open(); else openMenu(); }
  else if (location.hash === '#lobby') openLobby(); // preview the lobby page
  else if (location.hash === '#setup') openMenu();  // preview the setup page
  else if (location.hash === '#draw') { openLobby(); openDraw(0); } // preview the draw pad
  else if (location.hash.indexOf('#cdshow') === 0) { // preview intro+countdown; #cdshow=4 forces a count
    const want = parseInt(location.hash.split('=')[1], 10); if (want >= 2 && want <= 6) game.getPlayerCount = () => want;
    game.start(); startCountdown();
  }
  else if (location.hash === '#cdunit') {
    // dev self-test: roster reveals every column, then countdown 3→2→1→FIGHT! starts the match
    game.start(); startCountdown();
    const phases = [], seen = []; let started = false, maxReveal = 0; const realStart = startMatch;
    startMatch = function () { started = true; }; // stub so we don't actually go live
    for (let i = 0; i < 800 && cd; i++) {
      tickCountdown(1 / 60);
      if (cd) {
        if (phases[phases.length - 1] !== cd.phase) phases.push(cd.phase);
        if (cd.phase === 'roster') maxReveal = Math.max(maxReveal, cd.revealed);
        else { const b = CD_BEATS[cd.idx]; if (cd.idx >= 0 && seen[seen.length - 1] !== b) seen.push(b); }
      }
    }
    startMatch = realStart;
    const pass = phases.join(',') === 'roster,count' && maxReveal === game.fighters.length && seen.join(',') === '3,2,1,FIGHT!' && started && !cd;
    window.__showErr('CD: phases=' + phases.join('>') + ' cols=' + maxReveal + '/' + game.fighters.length + ' beats=' + seen.join('>') + ' started=' + started + '  ' + (pass ? 'PASS' : 'FAIL'));
  }
  else if (location.hash === '#play') game.start();
  else if (location.hash.indexOf('#editor') === 0) {
    const parts = location.hash.split('-'); // #editor-<subtab>-<action>
    if (parts[1]) editor.subtab = parts[1];
    if (parts[2]) editor.action = parts[2];
    document.querySelector('.tab[data-tab="editor"]').click();
  }
  // fresh load with no dev hash: creation-first Game Library.
  else if (location.hash === '') { if (worldLibrary) worldLibrary.open(); else openMenu(); }
})(window);
