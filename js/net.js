// Host-side networking for phone controllers.
//
// Connects to the relay (server.js) as the *host* of a lobby and turns the phone's
// messages into the exact input shape the game already consumes (`DS.Input.player(i)`),
// so a phone drives a fighter with no game/fighter changes beyond the `dash` command.
//
// The Brawlhalla-style controller sends:
//   movement (D-pad):       { mx:-1|0|1, my:-1|0|1 }   — held
//   jump button:            { ev:'jump' }
//   attack button:          { ev:'jab' }
//   special joystick:       { ev:'special', aim:-1|0|1 }   (aim = up/straight/down)
//   (optional explicit dash){ ev:'dash', dir:-1|1 }
//
// Movement becomes held left/right/up/down, AND a rising edge on left/right is latched as a
// press so a quick double-tap of an arrow triggers the keyboard-style double-tap dash. Action
// events latch a press for one game frame (cleared in update(), which runs after the game reads
// input). WS messages are processed *between* frames, so a latched tap is always read once and
// never lost. A special's "aim" holds up/down for a few frames WITHOUT a jump press, so aiming
// up never makes the fighter jump (jump only comes from the jump button).
//
// Multiplayer needs the relay, so it's only available when served over http(s). From file:// it
// stays dormant and the game plays exactly as before on the keyboard.
(function (global) {
  'use strict';
  const DS = global.DS;
  const MAX = 6;
  const AIM_FRAMES = 6; // how long a special's aim is held after it fires

  function freshPlayer(name, color) {
    return {
      name: name, color: color,
      mv: { left: false, right: false, up: false, down: false },
      aim: 0, aimT: 0, sdir: 0,
      latch: { left: false, right: false, jab: false, special: false, jump: false, drop: false, dash: 0 },
      // lobby choices the phone makes for itself (mirrored into the host lobby UI)
      skin: null, ult: 'hammer', ready: false,
    };
  }

  const Net = {
    ws: null,
    code: null,           // lobby code once hosting
    connected: false,     // socket open + lobby registered
    players: {},          // slot(1..MAX) -> player state
    onChange: null,       // menu callback: roster/connection changed
    _retry: null,

    available() { return location.protocol === 'http:' || location.protocol === 'https:'; },
    joinURL() { return this.code ? (location.origin + '/c?lobby=' + this.code) : null; },
    count() { return Object.keys(this.players).length; },
    maxSlot() { let m = 0; for (const s in this.players) m = Math.max(m, +s); return m; },
    hasPlayer(slot) { return !!this.players[slot]; },

    _wsURL() { return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws'; },

    // begin hosting a lobby (idempotent — reuses the existing code on reconnect)
    host() {
      if (!this.available()) return;
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      let ws;
      try { ws = new WebSocket(this._wsURL()); } catch (e) { return; }
      this.ws = ws;
      ws.onopen = () => { ws.send(JSON.stringify({ t: 'host', lobby: this.code || undefined })); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'hosted') { this.code = m.lobby; this.connected = true; this._emit(); }
        else if (m.t === 'join') { if (!m.draw) this.players[m.slot] = freshPlayer(m.name || ('Player ' + m.slot), m.color || null); this._emit(); }
        else if (m.t === 'leave') { delete this.players[m.slot]; this._emit(); }
        else if (m.t === 'in') { this._applyInput(m.slot, m.d); }
        else if (m.t === 'draw') { this._injectDraw(m); }          // iPad draw pad: inject a drawing
        else if (m.t === 'needstage') { this._sendStage(m.slot); } // iPad draw pad: send the mini-map stage
      };
      ws.onclose = () => {
        this.connected = false; this._emit();
        clearTimeout(this._retry); this._retry = setTimeout(() => this.host(), 1500);
      };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
    },

    _applyInput(slot, d) {
      const pl = this.players[slot]; if (!pl || !d) return;
      if (d.mx !== undefined) {
        const nl = d.mx < 0, nr = d.mx > 0;
        if (nl && !pl.mv.left) pl.latch.left = true;    // rising edge → double-tap dash
        if (nr && !pl.mv.right) pl.latch.right = true;
        pl.mv.left = nl; pl.mv.right = nr;
      }
      if (d.my !== undefined) {
        const nu = d.my < 0, nd = d.my > 0;
        if (nd && !pl.mv.down) pl.latch.drop = true;    // tap down on a soft platform = drop-through
        pl.mv.up = nu; pl.mv.down = nd;
      }
      switch (d.ev) {
        case 'jab': pl.latch.jab = true; break;
        case 'special': pl.latch.special = true; pl.aim = d.aim || 0; pl.aimT = AIM_FRAMES; pl.sdir = d.dir || 0; break;
        case 'jump': pl.latch.jump = true; break;
        case 'dash': pl.latch.dash = d.dir < 0 ? -1 : 1; break;
        // lobby (pre-match) choices the phone makes for itself — refresh the lobby UI live
        case 'skin': pl.skin = d.skin || null; this._emit(); break;
        case 'ult': pl.ult = d.ult || 'hammer'; this._emit(); break;
        case 'ready': pl.ready = !!d.ready; this._emit(); break;
      }
    },

    // an iPad DRAW controller sent a drawing to drop into the live match. strokes are already
    // normalized (~-40..40, centred) like DS.DrawPad; x/y are world/view coords from the mini-map
    // placement. Blank label -> the recognizer names it (DS.AI.spawnDrawn). Never throws.
    _injectDraw(m) {
      if (!DS.AI || !DS.game || DS.game.state !== 'playing') return;
      const strokes = m && m.strokes;
      if (!Array.isArray(strokes) || !strokes.length) return;
      const v = DS.game.view || { w: 1920, h: 1080 };
      const x = (typeof m.x === 'number') ? m.x : v.w * 0.5;
      const y = (typeof m.y === 'number') ? m.y : 150;
      try {
        if (m.label) DS.AI.spawnFromStrokes(strokes, m.label, x, y);
        else DS.AI.spawnDrawn(strokes, x, y);
      } catch (e) { /* a bad payload can't break the match */ }
    },

    // send the live stage layout to a draw controller so its placement mini-map matches the arena.
    _sendStage(slot) {
      const g = DS.game, v = (g && g.view) || { w: 1920, h: 1080 };
      const plats = (g && g.stage && g.stage.platforms) || (g && g.platforms) || [];
      const platforms = plats.map(function (p) { return { x: p.x, y: p.y, w: p.w, h: p.h }; });
      this.send({ t: 'stage', slot: slot, w: v.w, h: v.h, platforms: platforms });
    },

    // host → phones: a one-off control message (lobby/play phase, colour assign, …).
    // slot omitted = broadcast to every controller in the lobby.
    send(obj) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); } catch (e) {} },
    broadcast(obj) { this.send(obj); },

    // input in the same shape as DS.Input.player(i); neutral if no phone on this slot
    player(slot) {
      const pl = this.players[slot];
      if (!pl) return NEUTRAL;
      const aiming = pl.aimT > 0;
      const up = pl.mv.up || (aiming && pl.aim < 0);
      const down = pl.mv.down || (aiming && pl.aim > 0);
      return {
        left: pl.mv.left, right: pl.mv.right, up: up, down: down, shield: false,
        pressLeft: pl.latch.left, pressRight: pl.latch.right,  // double-tap dash
        pressUp: pl.latch.jump, pressDown: pl.latch.drop,
        pressAttack: pl.latch.jab, pressSpecial: pl.latch.special,
        holdAttack: false, holdSpecial: false,
        specialDir: pl.latch.special ? pl.sdir : 0,            // octagon: L/R half fires that way
        dash: pl.latch.dash,                                   // explicit dash command (-1/0/1)
      };
    },

    // call once per frame AFTER the game has read input — clears the one-frame latches
    update() {
      for (const slot in this.players) {
        const pl = this.players[slot], L = pl.latch;
        L.left = L.right = L.jab = L.special = L.jump = L.drop = false; L.dash = 0;
        if (pl.aimT > 0) pl.aimT--;
      }
    },

    _emit() { if (this.onChange) this.onChange(); },
  };

  const NEUTRAL = {
    left: false, right: false, up: false, down: false, shield: false,
    pressLeft: false, pressRight: false, pressUp: false, pressDown: false,
    pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false, specialDir: 0, dash: 0,
  };

  Net.MAX = MAX;
  DS.Net = Net;
})(window);
