// In-app editor: reshape character poses per action, tune stats/hitboxes, drag
// platforms/spawns, edit global settings. Mutates the same Store the game reads.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;

  const POSE_ACTIONS = ['idle', 'walk', 'dash', 'crouch', 'jump', 'fall', 'ledge', 'attack', 'special', 'hammer', 'superpunch', 'ultrapunch', 'supershot', 'shield', 'hurt'];

  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  class Editor {
    constructor(game, canvas, panel) {
      this.game = game; this.canvas = canvas; this.panel = panel;
      this.active = false;
      this.subtab = 'characters';
      this.charName = game.data.roster[0];
      this.action = 'idle';
      this.editMap = game.mapId || 'meadow'; // which stage the Stage tab edits (any map, not just Meadow)
      this._sv = null;                        // stage-tab view transform (fits the whole selected map)
      this.selPlat = null; this.selPortal = null; this.drag = null;
      this.platDraw = false; this.platStroke = null; // freehand "draw a platform" mode
      this._saveTimer = 0;
      // draw-tool state
      this.brush = 5; this.drawMode = 'auto'; this.draw = null; this.strokeHistory = [];
      this.Z = 8; // mannequin zoom (mannequin units -> view px)
      this._bindCanvas();
    }
    get data() { return DS.Store.data; }

    // ---------- stage-editing helpers (work on ANY map's persistent stage) ----------
    _stage() { return DS.Maps.stageFor(this.data, this.editMap); }     // the stage object being edited
    // the world rectangle to frame: the map's play-bounds, expanded to include every platform/spawn
    _ext(st) {
      let x0, y0, x1, y1;
      if (st.bounds) { x0 = st.bounds.x0; y0 = st.bounds.y0; x1 = st.bounds.x1; y1 = st.bounds.y1; }
      else { x0 = 0; y0 = 0; x1 = this.data.view.w; y1 = this.data.view.h; }
      for (const p of st.platforms) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h); }
      for (const s of st.spawns || []) { x0 = Math.min(x0, s.x - 40); y0 = Math.min(y0, s.y - 70); x1 = Math.max(x1, s.x + 40); y1 = Math.max(y1, s.y + 40); }
      for (const pt of st.portals || []) { x0 = Math.min(x0, pt.x - pt.r); y0 = Math.min(y0, pt.y - pt.r); x1 = Math.max(x1, pt.x + pt.r); y1 = Math.max(y1, pt.y + pt.r); }
      return { x0, y0, x1, y1 };
    }
    // fit a world rectangle into the canvas (with padding) -> {scale, ox, oy}
    _stageView(cssW, cssH, ext) {
      const pad = 46, ew = Math.max(1, ext.x1 - ext.x0), eh = Math.max(1, ext.y1 - ext.y0);
      const scale = Math.min((cssW - pad * 2) / ew, (cssH - pad * 2) / eh);
      return { scale, ox: (cssW - ew * scale) / 2 - ext.x0 * scale, oy: (cssH - eh * scale) / 2 - ext.y0 * scale, ext };
    }
    _toStage(e) { // client -> stage world coords (uses the live stage-tab transform)
      const r = this.canvas.getBoundingClientRect(), sv = this._sv || { scale: 1, ox: 0, oy: 0 };
      return { x: (e.clientX - r.left - sv.ox) / sv.scale, y: (e.clientY - r.top - sv.oy) / sv.scale };
    }

    activate() { this.active = true; this.panel.hidden = false; this.charName = this.data.roster[0]; this.build(); }
    deactivate() { this.active = false; this.panel.hidden = true; }
    editWorldStage(world) {
      this.subtab = 'stage';
      this.editMap = (world && (world.mapId || world.id)) || this.game.mapId || 'meadow';
      this.selPlat = null; this.selPortal = null; this.drag = null; this.platStroke = null; this.platDraw = false;
      if (DS.WorldLibrary && DS.WorldLibrary.ensureWorldStage && world) DS.WorldLibrary.ensureWorldStage(world);
      this.activate();
    }

    queueSave() { clearTimeout(this._saveTimer); this._saveTimer = setTimeout(() => DS.Store.save(), 250); }

    // ---------- panel UI ----------
    build() {
      const p = this.panel; p.innerHTML = '';
      const tabs = el('div', 'ed-seg');
      [['characters', 'Characters'], ['draw', 'Draw'], ['stage', 'Stage'], ['settings', 'Settings']].forEach(([t, label]) => {
        const b = el('button', this.subtab === t ? 'on' : '', label);
        b.onclick = () => { this.subtab = t; this.build(); };
        tabs.appendChild(b);
      });
      p.appendChild(tabs);

      if (this.subtab === 'characters') this._buildChars(p);
      else if (this.subtab === 'draw') this._buildDraw(p);
      else if (this.subtab === 'stage') this._buildStage(p);
      else this._buildSettings(p);

      // common buttons
      const btns = el('div', 'ed-btns');
      const mk = (label, fn) => { const b = el('button', '', label); b.onclick = fn; return b; };
      btns.appendChild(mk('Save', () => DS.Store.save()));
      btns.appendChild(mk('Reset all', () => { if (confirm('Reset everything to defaults?')) { DS.Store.reset(); this.game.rebuild(); this.build(); } }));
      btns.appendChild(mk('Export', () => this._export()));
      btns.appendChild(mk('Import', () => this._import()));
      btns.appendChild(mk('▶ Play test', () => { if (this.subtab === 'stage') this.game.mapId = this.editMap; document.querySelector('.tab[data-tab="play"]').click(); this.game.rebuild(); this.game.start(); }));
      p.appendChild(btns);
    }

    _slider(parent, label, min, max, step, get, set) {
      const row = el('div', 'ed-row');
      row.appendChild(el('label', '', label));
      const i = el('input'); i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = get();
      const v = el('span', 'val', (+get()).toFixed(step < 1 ? 2 : 0));
      i.oninput = () => { set(+i.value); v.textContent = (+i.value).toFixed(step < 1 ? 2 : 0); this.queueSave(); };
      row.appendChild(i); row.appendChild(v); parent.appendChild(row); return i;
    }
    _num(parent, label, step, get, set) {
      const row = el('div', 'ed-row'); row.appendChild(el('label', '', label));
      const i = el('input'); i.type = 'number'; i.step = step; i.value = get();
      i.oninput = () => { set(+i.value); this.queueSave(); };
      row.appendChild(i); parent.appendChild(row); return i;
    }

    _buildChars(p) {
      const ch = this.data.characters[this.charName];
      // character picker
      const row = el('div', 'ed-row'); row.appendChild(el('label', '', 'Character'));
      const sel = el('select');
      this.data.roster.forEach((n) => { const o = el('option', '', n); o.value = n; if (n === this.charName) o.selected = true; sel.appendChild(o); });
      sel.onchange = () => { this.charName = sel.value; this.build(); };
      row.appendChild(sel); p.appendChild(row);

      // head style
      const hrow = el('div', 'ed-row'); hrow.appendChild(el('label', '', 'Head'));
      const hsel = el('select'); ['bear', 'spikes', 'beanie', 'tuft', 'none'].forEach((h) => { const o = el('option', '', h); o.value = h; if (ch.head === h) o.selected = true; hsel.appendChild(o); });
      hsel.onchange = () => { ch.head = hsel.value; this.queueSave(); }; hrow.appendChild(hsel); p.appendChild(hrow);

      // action selector
      p.appendChild(el('h3', '', 'Action pose'));
      const seg = el('div', 'ed-seg');
      POSE_ACTIONS.forEach((a) => { const b = el('button', this.action === a ? 'on' : '', a); b.onclick = () => { this.action = a; this.build(); }; seg.appendChild(b); });
      p.appendChild(seg);
      p.appendChild(el('div', 'ed-note', 'Big preview shows this pose on the canvas. Drag the joints there, or use the sliders.'));

      const act = ch.actions[this.action];
      const ps = act.pose;
      this._slider(p, 'lean', -30, 30, 1, () => ps.lean, (v) => ps.lean = v);
      this._slider(p, 'squash', 0.6, 1.3, 0.01, () => ps.squash, (v) => ps.squash = v);
      this._slider(p, 'head x', -12, 12, 1, () => ps.headX, (v) => ps.headX = v);
      this._slider(p, 'head y', -14, 14, 1, () => ps.headY, (v) => ps.headY = v);
      const limb = (name, obj, k1, k2) => {
        this._slider(p, name + ' ' + k1, -180, 180, 1, () => obj[k1], (v) => obj[k1] = v);
        this._slider(p, name + ' bend', -110, 110, 1, () => obj[k2], (v) => obj[k2] = v);
      };
      limb('arm front', ps.armFront, 'sh', 'el');
      limb('arm back', ps.armBack, 'sh', 'el');
      limb('leg front', ps.legFront, 'hip', 'knee');
      limb('leg back', ps.legBack, 'hip', 'knee');

      if (act.hit) {
        p.appendChild(el('h3', '', 'Hitbox & frames'));
        this._slider(p, 'reach x', -10, 110, 1, () => act.hit.x, (v) => act.hit.x = v);
        this._slider(p, 'reach y', -40, 40, 1, () => act.hit.y, (v) => act.hit.y = v);
        this._slider(p, 'radius', 8, 56, 1, () => act.hit.r, (v) => act.hit.r = v);
        this._slider(p, 'damage', 1, 30, 1, () => act.hit.damage, (v) => act.hit.damage = v);
        this._slider(p, 'kb base', 0, 80, 1, () => act.hit.kbBase, (v) => act.hit.kbBase = v);
        this._slider(p, 'kb growth', 0, 0.5, 0.01, () => act.hit.kbScale, (v) => act.hit.kbScale = v);
        this._slider(p, 'angle', -10, 90, 1, () => act.hit.angle, (v) => act.hit.angle = v);
        this._slider(p, 'startup f', 1, 30, 1, () => act.startup, (v) => act.startup = v);
        this._slider(p, 'active f', 1, 20, 1, () => act.active, (v) => act.active = v);
        this._slider(p, 'recovery f', 1, 40, 1, () => act.recovery, (v) => act.recovery = v);
      }

      if (act.projectile) {
        p.appendChild(el('h3', '', 'Projectile & frames'));
        const pj = act.projectile;
        this._slider(p, 'speed', 200, 1400, 10, () => pj.speed, (v) => pj.speed = v);
        this._slider(p, 'damage', 1, 30, 1, () => pj.damage, (v) => pj.damage = v);
        this._slider(p, 'kb base', 0, 80, 1, () => pj.kbBase, (v) => pj.kbBase = v);
        this._slider(p, 'kb growth', 0, 0.5, 0.01, () => pj.kbScale, (v) => pj.kbScale = v);
        this._slider(p, 'base angle', -30, 80, 1, () => pj.angle, (v) => pj.angle = v);
        this._slider(p, 'arc (gravity)', 0, 2000, 20, () => pj.gravity, (v) => pj.gravity = v);
        p.appendChild(el('div', 'ed-note', 'base angle 0 = straight. In-game, hold up/down as you fire the Special to aim it up or down.'));
        this._slider(p, 'lifetime', 0.3, 4, 0.1, () => pj.life, (v) => pj.life = v);
        this._slider(p, 'size', 6, 40, 1, () => pj.r, (v) => pj.r = v);
        this._slider(p, 'cooldown', 0, 2, 0.05, () => pj.cooldown == null ? 0.5 : pj.cooldown, (v) => pj.cooldown = v);
        this._slider(p, 'startup f', 1, 30, 1, () => act.startup, (v) => act.startup = v);
        this._slider(p, 'active f', 1, 20, 1, () => act.active, (v) => act.active = v);
        this._slider(p, 'recovery f', 1, 40, 1, () => act.recovery, (v) => act.recovery = v);
      }

      p.appendChild(el('h3', '', 'Stats'));
      const s = ch.stats;
      this._slider(p, 'walk spd', 80, 400, 5, () => s.walkSpeed, (v) => s.walkSpeed = v);
      this._slider(p, 'run spd', 150, 700, 5, () => s.runSpeed, (v) => s.runSpeed = v);
      this._slider(p, 'air spd', 120, 600, 5, () => s.airSpeed, (v) => s.airSpeed = v);
      this._slider(p, 'jump', 400, 1200, 10, () => s.jumpVel, (v) => s.jumpVel = v);
      this._slider(p, 'double jump', 400, 1100, 10, () => s.doubleJumpVel, (v) => s.doubleJumpVel = v);
      this._slider(p, 'max jumps', 1, 4, 1, () => s.maxJumps, (v) => s.maxJumps = v);
      this._slider(p, 'fall spd', 800, 2600, 20, () => s.fallSpeed, (v) => s.fallSpeed = v);
      this._slider(p, 'weight', 0.6, 1.8, 0.05, () => s.weight, (v) => s.weight = v);
      this._slider(p, 'size', 0.7, 1.5, 0.05, () => s.scale, (v) => s.scale = v);
    }

    _ensureSkin(ch) { if (!ch.skin) ch.skin = DS.skin.emptySkin(); return ch.skin; }

    _buildDraw(p) {
      const ch = this.data.characters[this.charName];
      this._ensureSkin(ch);

      const row = el('div', 'ed-row'); row.appendChild(el('label', '', 'Character'));
      const sel = el('select');
      this.data.roster.forEach((n) => { const o = el('option', '', n); o.value = n; if (n === this.charName) o.selected = true; sel.appendChild(o); });
      sel.onchange = () => { this.charName = sel.value; this.build(); };
      row.appendChild(sel); p.appendChild(row);

      p.appendChild(el('div', 'ed-note', 'Draw your fighter right on top of the ghost body. Each stroke is auto-sorted into the body part it lands on. Draw all 6 parts: head, body, both arms, both legs.'));

      p.appendChild(el('h3', '', 'Draw into'));
      const modes = [['auto', 'Auto'], ['head', 'Head'], ['body', 'Body'], ['armFront', 'Arm front'], ['armBack', 'Arm back'], ['legFront', 'Leg front'], ['legBack', 'Leg back']];
      const seg = el('div', 'ed-seg');
      modes.forEach(([m, label]) => { const b = el('button', this.drawMode === m ? 'on' : '', label); b.onclick = () => { this.drawMode = m; this.build(); }; seg.appendChild(b); });
      p.appendChild(seg);
      p.appendChild(el('div', 'ed-note', this.drawMode === 'auto' ? 'Auto: strokes snap to the nearest body part.' : 'Locked to "' + this.drawMode + '" — every stroke goes here.'));

      this._slider(p, 'brush size', 2, 14, 1, () => this.brush, (v) => this.brush = v);

      const tog = el('div', 'ed-row'); tog.appendChild(el('label', '', 'use drawing'));
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = ch.skin.enabled;
      cb.onchange = () => { ch.skin.enabled = cb.checked; this.queueSave(); }; tog.appendChild(cb); p.appendChild(tog);
      p.appendChild(el('div', 'ed-note', 'Off = use the built-in stick figure instead of your drawing.'));

      const btns = el('div', 'ed-btns');
      const mk = (t, fn) => { const b = el('button', '', t); b.onclick = fn; return b; };
      btns.appendChild(mk('Undo stroke', () => {
        const part = this.strokeHistory.pop();
        if (part && ch.skin.parts[part].strokes.length) { ch.skin.parts[part].strokes.pop(); this.queueSave(); }
      }));
      btns.appendChild(mk(this.drawMode !== 'auto' ? 'Clear ' + this.drawMode : 'Clear part', () => {
        if (this.drawMode !== 'auto') { ch.skin.parts[this.drawMode].strokes = []; this.queueSave(); }
      }));
      btns.appendChild(mk('Clear all', () => { if (confirm('Clear the whole drawing?')) { ch.skin = DS.skin.emptySkin(); this.strokeHistory = []; this.queueSave(); } }));
      p.appendChild(btns);

      // stroke counts
      const counts = DS.skin.PARTS.map((k) => k + ': ' + ch.skin.parts[k].strokes.length).join('  ·  ');
      p.appendChild(el('div', 'ed-note', counts));
    }

    _buildStage(p) {
      // map picker — EVERY stage is editable, not just Meadow
      const mrow = el('div', 'ed-row'); mrow.appendChild(el('label', '', 'Map'));
      const msel = el('select');
      const maps = DS.Maps.list().slice();
      if (!maps.some((m) => m.id === this.editMap)) {
        const custom = DS.Maps.get(this.editMap);
        maps.unshift({ id: this.editMap, name: (this._stage() && this._stage().name) || custom.name || 'Custom Level' });
      }
      maps.forEach((m) => { const o = el('option', '', m.name); o.value = m.id; if (m.id === this.editMap) o.selected = true; msel.appendChild(o); });
      msel.onchange = () => { this.editMap = msel.value; this.selPlat = null; this.build(); };
      mrow.appendChild(msel); p.appendChild(mrow);

      const st = this._stage();
      p.appendChild(el('div', 'ed-note', 'Add / drag / resize platforms AND gimmicks (cannons, trampolines, portals). Drag a platform’s bottom-right corner (or a portal’s nub) to resize. Drag spawns (dotted circles). Edits are saved and used in matches.'));

      // freehand draw-a-platform toggle (drag a squiggle on the stage → it becomes a platform)
      const drawRow = el('div', 'ed-btns');
      const drawBtn = el('button', this.platDraw ? 'on' : '', this.platDraw ? '✎ Drawing… (tap to stop)' : '✎ Draw a platform');
      drawBtn.onclick = () => { this.platDraw = !this.platDraw; this.platStroke = null; if (this.platDraw) { this.selPlat = null; this.selPortal = null; } this.build(); };
      drawRow.appendChild(drawBtn); p.appendChild(drawRow);
      if (this.platDraw) p.appendChild(el('div', 'ed-note', 'Drag right on the stage to trace a platform — your squiggle becomes a ledge you can stand on. Tap the button again to stop.'));

      const addr = el('div', 'ed-btns');
      const mkb = (label, fn) => { const b = el('button', '', label); b.onclick = fn; addr.appendChild(b); };
      mkb('+ platform', () => this._addPlat(st, {}));
      mkb('+ cannon', () => this._addPlat(st, { w: 86, h: 52, kind: 'cannon', pass: false, fire: { deg: 0, every: 2.0, speed: 880, damage: 11, kbBase: 32, kbScale: 0.12, r: 26, delay: 0 } }));
      mkb('+ bouncy', () => this._addPlat(st, { w: 360, h: 60, kind: 'trampoline', pass: false, bounce: 1300 }));
      mkb('+ spikes', () => this._addPlat(st, { w: 260, h: 44, kind: 'spikes', pass: false, hurt: { damage: 26, kbBase: 40, kbScale: 0.18, cooldown: 0.6 } }));
      mkb('+ portal', () => this._addPortalPair(st));
      mkb('− selected', () => {
        if (this.selPortal) { const pt = this.selPortal; st.portals = (st.portals || []).filter((q) => q !== pt && q.id !== pt.link && q.link !== pt.id); this.selPortal = null; }
        else if (this.selPlat) { const i = st.platforms.indexOf(this.selPlat); if (i >= 0) st.platforms.splice(i, 1); this.selPlat = null; }
        this.queueSave(); this.build();
      });
      mkb('↺ Reset this stage', () => {
        if (confirm('Reset ' + DS.Maps.get(this.editMap).name + ' to its default layout?')) { DS.Maps.resetStage(this.data, this.editMap); this.selPlat = null; this.selPortal = null; this.queueSave(); this.build(); }
      });
      p.appendChild(addr);

      if (this.selPortal && (st.portals || []).indexOf(this.selPortal) >= 0) this._buildPortalProps(p, st, this.selPortal);
      else if (this.selPlat && st.platforms.indexOf(this.selPlat) >= 0) this._buildPlatProps(p, st, this.selPlat);
      else p.appendChild(el('div', 'ed-note', 'Click a platform, cannon, trampoline or portal to select it.'));
    }

    // add a platform (optionally pre-loaded as a cannon/trampoline), centred in the map
    _addPlat(st, props) {
      const ex = this._ext(st), cx = (ex.x0 + ex.x1) / 2, cy = (ex.y0 + ex.y1) / 2;
      const pl = Object.assign({ w: 220, h: 26, kind: 'wood', pass: true }, props);
      pl.x = Math.round(cx - pl.w / 2); pl.y = Math.round(cy - pl.h / 2);
      st.platforms.push(pl); this.selPlat = pl; this.selPortal = null; this.queueSave(); this.build();
    }
    // turn a traced squiggle into a platform: AABB = stroke bbox (the physics box), and the stroke
    // (stored relative to that box) is what gets drawn. Defaults to pass-through so its irregular
    // shape never makes an invisible side-wall — you simply land on top.
    _finishPlatStroke(st) {
      const s = this.platStroke; this.platStroke = null;
      if (!s || s.pts.length < 2) return;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const [x, y] of s.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const padX = 24;
      x0 -= padX; x1 += padX; y0 -= 20; y1 += 50; // pad covers the perpendicular body + rounded end caps
      const w = Math.max(24, x1 - x0), h = Math.max(14, y1 - y0);
      if ((x1 - x0) < 16 && (y1 - y0) < 16) { this.build(); return; } // ignore an accidental dot
      const pl = { x: Math.round(x0), y: Math.round(y0), w: Math.round(w), h: Math.round(h), pass: true, kind: 'drawn',
        pts: s.pts.map(([x, y]) => [Math.round(x - x0), Math.round(y - y0)]) };
      st.platforms.push(pl); this.selPlat = pl; this.selPortal = null; this.queueSave(); this.build();
    }
    _uid(st) { let id; do { id = 'p' + Math.floor(Math.random() * 1e6); } while ((st.portals || []).some((q) => q.id === id)); return id; }
    _addPortalPair(st) {
      const ex = this._ext(st), cx = (ex.x0 + ex.x1) / 2, cy = (ex.y0 + ex.y1) / 2;
      st.portals = st.portals || [];
      const a = { id: this._uid(st), link: '', x: Math.round(cx - 240), y: Math.round(cy), r: 74, col: '#3f6fa0' };
      const b = { id: this._uid(st), link: a.id, x: Math.round(cx + 240), y: Math.round(cy), r: 74, col: '#3f6fa0' };
      a.link = b.id; st.portals.push(a, b);
      this.selPortal = a; this.selPlat = null; this.queueSave(); this.build();
    }

    _buildPlatProps(p, st, pl) {
      // a DRAWN platform keeps its shape (drag to move / corner to resize on the canvas) — here it
      // gets a "type" that restyles it (and Bouncy makes it springy), not the rectangle kinds.
      if (pl.kind === 'drawn') {
        p.appendChild(el('h3', '', 'Drawn platform'));
        const trow = el('div', 'ed-row'); trow.appendChild(el('label', '', 'type'));
        const tsel = el('select');
        [['ledge', 'Ledge'], ['wood', 'Wood'], ['stone', 'Stone'], ['crystal', 'Crystal'], ['bouncy', 'Bouncy']].forEach(([v, label]) => { const o = el('option', '', label); o.value = v; if ((pl.style || 'ledge') === v) o.selected = true; tsel.appendChild(o); });
        tsel.onchange = () => { pl.style = tsel.value; if (pl.style === 'bouncy') { if (pl.bounce == null) pl.bounce = 1300; } else delete pl.bounce; this.queueSave(); this.build(); };
        trow.appendChild(tsel); p.appendChild(trow);
        if (pl.style === 'bouncy') this._slider(p, 'bounce', 400, 2200, 20, () => pl.bounce, (v) => pl.bounce = v);
        p.appendChild(el('div', 'ed-note', 'Keeps its drawn shape; the type changes how it looks. Bouncy springs you up. Drag it on the canvas to move; drag the corner to resize.'));
        return;
      }
      p.appendChild(el('h3', '', 'Selected platform'));
      this._num(p, 'x', 1, () => Math.round(pl.x), (v) => pl.x = v);
      this._num(p, 'y', 1, () => Math.round(pl.y), (v) => pl.y = v);
      this._num(p, 'width', 1, () => Math.round(pl.w), (v) => pl.w = v);
      this._num(p, 'height', 1, () => Math.round(pl.h), (v) => pl.h = v);
      // kind — also turns a platform into a cannon / trampoline (and back)
      const krow = el('div', 'ed-row'); krow.appendChild(el('label', '', 'kind'));
      const ksel = el('select');
      ['ground', 'wood', 'stone', 'crystal', 'box', 'float', 'cannon', 'trampoline', 'spikes'].forEach((k) => { const o = el('option', '', k); o.value = k; if ((pl.kind || 'wood') === k) o.selected = true; ksel.appendChild(o); });
      ksel.onchange = () => {
        const k = ksel.value; pl.kind = k;
        if (k === 'cannon') { if (!pl.fire) pl.fire = { deg: 0, every: 2.0, speed: 880, damage: 11, kbBase: 32, kbScale: 0.12, r: 26, delay: 0 }; pl.pass = false; } else delete pl.fire;
        if (k === 'trampoline') { if (pl.bounce == null) pl.bounce = 1300; pl.pass = false; } else delete pl.bounce;
        if (k === 'spikes') { if (!pl.hurt) pl.hurt = { damage: 26, kbBase: 40, kbScale: 0.18, cooldown: 0.6 }; pl.pass = false; } else delete pl.hurt;
        this.queueSave(); this.build();
      };
      krow.appendChild(ksel); p.appendChild(krow);
      // solid platforms get pass-through + breakable hp; cannons/trampolines are always solid
      if (!pl.fire && pl.bounce == null) {
        const crow = el('div', 'ed-row'); crow.appendChild(el('label', '', 'pass-through'));
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!pl.pass; cb.onchange = () => { pl.pass = cb.checked; this.queueSave(); };
        crow.appendChild(cb); p.appendChild(crow);
        this._num(p, 'breakable hp', 1, () => pl.hp || 0, (v) => { if (v > 0) pl.hp = v; else delete pl.hp; });
      }
      if (pl.fire) {
        p.appendChild(el('h3', '', 'Cannon'));
        this._slider(p, 'angle', -180, 180, 1, () => pl.fire.deg || 0, (v) => pl.fire.deg = v);
        this._slider(p, 'interval (s)', 0.4, 5, 0.1, () => pl.fire.every, (v) => pl.fire.every = v);
        this._slider(p, 'ball speed', 300, 1400, 10, () => pl.fire.speed, (v) => pl.fire.speed = v);
        this._slider(p, 'damage', 1, 30, 1, () => pl.fire.damage, (v) => pl.fire.damage = v);
        this._slider(p, 'ball size', 10, 50, 1, () => pl.fire.r || 26, (v) => pl.fire.r = v);
        p.appendChild(el('div', 'ed-note', 'angle: 0 = right, 90 = up, 180 = left (matches the projectile aim).'));
      }
      if (pl.bounce != null) {
        p.appendChild(el('h3', '', 'Trampoline'));
        this._slider(p, 'bounce', 400, 2200, 20, () => pl.bounce, (v) => pl.bounce = v);
        p.appendChild(el('div', 'ed-note', 'Minimum launch height; a harder landing still flings you higher.'));
      }
      if (pl.hurt) {
        p.appendChild(el('h3', '', 'Spikes (hazard)'));
        this._slider(p, 'damage', 1, 60, 1, () => pl.hurt.damage, (v) => pl.hurt.damage = v);
        this._slider(p, 'knockback', 4, 80, 1, () => pl.hurt.kbBase, (v) => pl.hurt.kbBase = v);
        this._slider(p, 'kb growth', 0, 0.4, 0.01, () => pl.hurt.kbScale, (v) => pl.hurt.kbScale = v);
        this._slider(p, 'hit cooldown (s)', 0.1, 2, 0.05, () => pl.hurt.cooldown, (v) => pl.hurt.cooldown = v);
        p.appendChild(el('div', 'ed-note', 'Touching this platform deals heavy damage + knockback, then flings the fighter off.'));
      }
      if (pl.move) p.appendChild(el('div', 'ed-note', 'This platform MOVES (' + pl.move.type + '); its motion path is preset.'));
    }

    _buildPortalProps(p, st, pt) {
      p.appendChild(el('h3', '', 'Selected portal'));
      this._num(p, 'x', 1, () => Math.round(pt.x), (v) => pt.x = v);
      this._num(p, 'y', 1, () => Math.round(pt.y), (v) => pt.y = v);
      this._slider(p, 'radius', 30, 160, 1, () => pt.r, (v) => pt.r = v);
      const crow = el('div', 'ed-row'); crow.appendChild(el('label', '', 'colour'));
      const seg = el('div', 'ed-seg');
      ['#3f6fa0', '#9a6cb0', '#3f8f86', '#d4663f', '#b58a2e'].forEach((c) => {
        const b = el('button', pt.col === c ? 'on' : ''); b.style.background = c; b.style.minWidth = '24px'; b.style.width = '24px'; b.style.height = '22px';
        b.onclick = () => { pt.col = c; const partner = (st.portals || []).find((q) => q.id === pt.link); if (partner) partner.col = c; this.queueSave(); this.build(); };
        seg.appendChild(b);
      });
      crow.appendChild(seg); p.appendChild(crow);
      p.appendChild(el('div', 'ed-note', 'Portals come in linked PAIRS — step into one, pop out the other. “− selected” removes the whole pair.'));
    }

    _buildSettings(p) {
      const s = this.data.settings;
      p.appendChild(el('h3', '', 'Match'));
      this._slider(p, 'gravity', 1200, 3600, 50, () => s.gravity, (v) => s.gravity = v);
      this._slider(p, 'timer (s)', 0, 300, 5, () => s.timerSeconds, (v) => s.timerSeconds = v);
      this._slider(p, 'stocks', 1, 9, 1, () => s.stocks, (v) => s.stocks = v);
      this._slider(p, 'knockback', 0.4, 2.2, 0.05, () => s.knockbackScale, (v) => s.knockbackScale = v);
      this._slider(p, 'hitstop', 0, 2, 0.1, () => s.hitstop, (v) => s.hitstop = v);
      p.appendChild(el('div', 'ed-note', 'Tip: lower gravity + higher knockback = floatier, more dramatic launches.'));
      p.appendChild(el('h3', '', 'Scenery'));
      this._slider(p, 'dressing', 0, 2, 0.1, () => (s.scenery == null ? 1 : s.scenery), (v) => s.scenery = v);
      p.appendChild(el('div', 'ed-note', 'Auto-grows pillars under platforms + plants on top from the layout (cosmetic). 0 = off. Updates live as you draw/move platforms.'));
    }

    _export() {
      const blob = new Blob([DS.Store.export()], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'doodle-smash.json'; a.click(); URL.revokeObjectURL(a.href);
    }
    _import() {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
      inp.onchange = () => { const f = inp.files[0]; if (!f) return; const r = new FileReader();
        r.onload = () => { try { DS.Store.import(r.result); this.game.rebuild(); this.build(); } catch (e) { alert('Import failed: ' + e.message); } };
        r.readAsText(f); };
      inp.click();
    }

    // ---------- canvas interaction ----------
    _toView(e) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: (e.clientX - rect.left - this.game.ox) / this.game.scale,
               y: (e.clientY - rect.top - this.game.oy) / this.game.scale };
    }
    _toMan(e) { // client -> mannequin-local coords
      const v = this._toView(e);
      return { x: (v.x - this.data.view.w / 2) / this.Z, y: (v.y - this.data.view.h / 2) / this.Z };
    }
    _finishStroke() {
      const s = this.draw; this.draw = null;
      if (!s || !s.pts.length) return;
      const ch = this.data.characters[this.charName]; this._ensureSkin(ch);
      const part = this.drawMode === 'auto' ? DS.skin.assign(s.pts) : this.drawMode;
      const piv = DS.skin.PIVOTS[part];
      ch.skin.parts[part].strokes.push({ pts: s.pts.map((p) => [p[0] - piv.x, p[1] - piv.y]), w: s.w });
      this.strokeHistory.push(part);
      ch.skin.enabled = true;
      this.queueSave(); this.build();
    }
    _bindCanvas() {
      const cv = this.canvas;
      cv.addEventListener('pointerdown', (e) => {
        if (!this.active) return;
        if (this.subtab === 'draw') {
          const m = this._toMan(e);
          this.draw = { pts: [[m.x, m.y]], w: this.brush };
          try { cv.setPointerCapture(e.pointerId); } catch (_) {}
          return;
        }
        if (this.subtab !== 'stage') return;
        const st = this._stage(), sv = this._sv || { scale: 1 };
        const m = this._toStage(e);
        // freehand draw mode: trace a platform instead of selecting/dragging
        if (this.platDraw) { this.platStroke = { pts: [[m.x, m.y]] }; try { cv.setPointerCapture(e.pointerId); } catch (_) {} return; }
        const hr = 16 / sv.scale; // handle hit-radius in world units (~constant on screen)
        // portals first (drag to move, or grab the radius nub at the bottom to resize)
        for (const pt of st.portals || []) {
          if (Math.hypot(m.x - pt.x, m.y - (pt.y + pt.r)) < 13 / sv.scale) { this.selPortal = pt; this.selPlat = null; this.drag = { mode: 'portalR', t: pt }; this.build(); return; }
          const rx = pt.r * 0.72 || 1, ry = pt.r || 1, ex = (m.x - pt.x) / rx, ey = (m.y - pt.y) / ry;
          if (ex * ex + ey * ey <= 1) { this.selPortal = pt; this.selPlat = null; this.drag = { mode: 'portalMove', t: pt, dx: m.x - pt.x, dy: m.y - pt.y }; this.build(); return; }
        }
        // spawn handles
        for (const sp of st.spawns) {
          if (Math.hypot(sp.x - m.x, sp.y - m.y) < hr) { this.selPortal = null; this.drag = { mode: 'spawn', t: sp }; return; }
        }
        // platforms (topmost last)
        const arr = st.platforms;
        for (let i = arr.length - 1; i >= 0; i--) {
          const pl = arr[i];
          if (m.x >= pl.x && m.x <= pl.x + pl.w && m.y >= pl.y && m.y <= pl.y + pl.h) {
            this.selPlat = pl; this.selPortal = null;
            const corner = Math.hypot(pl.x + pl.w - m.x, pl.y + pl.h - m.y) < 18 / sv.scale;
            this.drag = { mode: corner ? 'resize' : 'move', t: pl, dx: m.x - pl.x, dy: m.y - pl.y,
              ow: pl.w, oh: pl.h, opts: (pl.kind === 'drawn' && pl.pts) ? pl.pts.map((q) => q.slice()) : null };
            this.build(); return;
          }
        }
        this.selPlat = null; this.selPortal = null; this.build();
      });
      window.addEventListener('pointermove', (e) => {
        if (this.draw) { const m = this._toMan(e); this.draw.pts.push([m.x, m.y]); return; }
        if (this.platStroke) { const m = this._toStage(e); this.platStroke.pts.push([m.x, m.y]); return; }
        if (!this.drag) return;
        const m = this._toStage(e); const d = this.drag;
        if (d.mode === 'spawn') { d.t.x = Math.round(m.x); d.t.y = Math.round(m.y); }
        else if (d.mode === 'move') { d.t.x = Math.round(m.x - d.dx); d.t.y = Math.round(m.y - d.dy); }
        else if (d.mode === 'resize') {
          const nw = Math.max(40, Math.round(m.x - d.t.x)), nh = Math.max(14, Math.round(m.y - d.t.y));
          if (d.opts && d.ow > 0 && d.oh > 0) d.t.pts = d.opts.map(([x, y]) => [Math.round(x * nw / d.ow), Math.round(y * nh / d.oh)]); // a drawn squiggle scales with its box
          d.t.w = nw; d.t.h = nh;
        }
        else if (d.mode === 'portalMove') { d.t.x = Math.round(m.x - d.dx); d.t.y = Math.round(m.y - d.dy); }
        else if (d.mode === 'portalR') { d.t.r = Math.max(30, Math.round(m.y - d.t.y)); }
        this.queueSave();
      });
      window.addEventListener('pointerup', () => {
        if (this.draw) { this._finishStroke(); return; }
        if (this.platStroke) { this._finishPlatStroke(this._stage()); return; }
        if (this.drag) { this.drag = null; this.build(); }
      });
    }

    // ---------- render (main canvas while in editor) ----------
    render(cssW, cssH) {
      const ctx = this.game.ctx;
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.fillStyle = D.COL.paperShade; ctx.fillRect(0, 0, cssW, cssH);
      if (this.subtab === 'stage') { this._renderStageTab(ctx, cssW, cssH); return; } // its own fit-to-map view
      this.game._applyView(cssW, cssH);
      ctx.save();
      ctx.translate(this.game.ox, this.game.oy); ctx.scale(this.game.scale, this.game.scale);
      ctx.beginPath(); ctx.rect(0, 0, this.data.view.w, this.data.view.h); ctx.clip();
      ctx.drawImage(D.paperTexture(this.data.view.w, this.data.view.h), 0, 0);

      if (this.subtab === 'characters') this._renderCharPreview(ctx);
      else if (this.subtab === 'draw') this._renderDrawTab(ctx);
      else { DS.stage.drawBackground(ctx, this.data); DS.stage.drawStage(ctx, this.data); } // settings preview
      ctx.restore();
    }

    _renderDrawTab(ctx) {
      const ch = this.data.characters[this.charName]; this._ensureSkin(ch);
      const cx = this.data.view.w / 2, cy = this.data.view.h / 2, Z = this.Z;
      const rnd = DS.makeRng(7);

      ctx.save();
      ctx.translate(cx, cy); ctx.scale(Z, Z);
      // faint ghost body to draw over (active part highlighted)
      DS.skin.drawMannequin(ctx, this.drawMode);
      // the strokes drawn so far, shown in their rest place
      DS.skin.PARTS.forEach((name) => {
        const pt = ch.skin.parts[name]; if (!pt.strokes.length) return;
        ctx.save(); ctx.translate(DS.skin.PIVOTS[name].x, DS.skin.PIVOTS[name].y);
        DS.skin.drawStrokes(ctx, pt.strokes, rnd); ctx.restore();
      });
      // the stroke currently being drawn (accent colour)
      if (this.draw && this.draw.pts.length) {
        DS.draw.strokePts(ctx, this.draw.pts, { width: this.draw.w, color: DS.draw.COL.accent, rnd, jitter: 0.3, passes: 1 });
      }
      ctx.restore();

      ctx.fillStyle = D.COL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = "30px 'Gloria Hallelujah', cursive";
      ctx.fillText('Drawing: ' + this.charName, cx, 64);
      ctx.fillStyle = D.COL.inkSoft; ctx.font = "22px 'Patrick Hand', cursive";
      ctx.fillText(this.drawMode === 'auto' ? 'strokes auto-sort into body parts' : 'drawing into: ' + this.drawMode, cx, 92);
    }

    // Stage tab: frame the WHOLE selected map (it can be far bigger than the 1920x1080 view),
    // render its real scenery + platforms + spawns, plus draggable edit handles.
    _renderStageTab(ctx, cssW, cssH) {
      ctx.drawImage(D.paperTexture(cssW, cssH), 0, 0); // one continuous paper sheet, like in-game
      const st = this._stage(), ext = this._ext(st), sv = this._stageView(cssW, cssH, ext);
      this._sv = sv;
      ctx.save();
      ctx.translate(sv.ox, sv.oy); ctx.scale(sv.scale, sv.scale);
      DS.stage.drawBackground(ctx, st);
      DS.stage.drawStage(ctx, st);
      // the play-bounds the camera/KO use (dashed guide) so big stages read clearly
      if (st.bounds) {
        ctx.save(); ctx.strokeStyle = 'rgba(47,42,38,0.3)'; ctx.setLineDash([11 / sv.scale, 9 / sv.scale]); ctx.lineWidth = 2 / sv.scale;
        ctx.strokeRect(st.bounds.x0, st.bounds.y0, st.bounds.x1 - st.bounds.x0, st.bounds.y1 - st.bounds.y0); ctx.setLineDash([]); ctx.restore();
      }
      this._renderStageHandles(ctx, st, sv);
      // the platform currently being traced (accent), at the same chunk-width it'll become
      if (this.platStroke && this.platStroke.pts.length) {
        D.strokePts(ctx, this.platStroke.pts, { width: 16, color: D.COL.accent, rnd: DS.makeRng(3), jitter: 0.2, passes: 1 });
      }
      ctx.restore();
      ctx.fillStyle = D.COL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = "26px 'Gloria Hallelujah', cursive";
      ctx.fillText('Editing: ' + (st.name || DS.Maps.get(this.editMap).name), cssW / 2, 34);
    }
    // dashed boxes + resize nubs on platforms, dotted circles on spawns (sizes kept ~constant on screen)
    _renderStageHandles(ctx, st, sv) {
      const s = sv.scale;
      for (const pl of st.platforms) {
        const sel = pl === this.selPlat;
        ctx.save();
        ctx.strokeStyle = sel ? D.COL.accent : 'rgba(47,42,38,0.35)';
        ctx.setLineDash([6 / s, 6 / s]); ctx.lineWidth = 2 / s;
        ctx.strokeRect(pl.x, pl.y, pl.w, pl.h);
        ctx.setLineDash([]);
        if (sel) { const h = 12 / s; ctx.fillStyle = D.COL.accent; ctx.fillRect(pl.x + pl.w - h * 0.75, pl.y + pl.h - h * 0.75, h, h); }
        ctx.restore();
      }
      st.spawns.forEach((sp, i) => {
        ctx.save(); ctx.strokeStyle = D.COL.accent; ctx.setLineDash([4 / s, 5 / s]); ctx.lineWidth = 2.5 / s;
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 14 / s, 0, 7); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = D.COL.accent; ctx.font = (20 / s) + "px 'Patrick Hand'"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('P' + (i + 1), sp.x, sp.y); ctx.restore();
      });
      // portals: a selection ring + a radius nub at the bottom (the glyph itself is drawn by drawStage)
      for (const pt of st.portals || []) {
        const sel = pt === this.selPortal;
        ctx.save();
        ctx.strokeStyle = sel ? D.COL.accent : 'rgba(47,42,38,0.4)';
        ctx.setLineDash([5 / s, 5 / s]); ctx.lineWidth = 2 / s;
        ctx.beginPath(); ctx.ellipse(pt.x, pt.y, pt.r * 0.72, pt.r, 0, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
        const hh = 12 / s; ctx.fillStyle = sel ? D.COL.accent : 'rgba(47,42,38,0.4)';
        ctx.fillRect(pt.x - hh / 2, pt.y + pt.r - hh / 2, hh, hh);
        ctx.restore();
      }
    }

    _renderCharPreview(ctx) {
      const ch = this.data.characters[this.charName];
      const act = ch.actions[this.action];
      const cScale = ch.stats.scale || 1;
      const view = this.data.view;
      const cx = view.w / 2, cy = view.h / 2 - 20;       // fighter center
      const PV = 3.2;                                     // preview zoom
      const feetY = cy + 38 * PV * cScale;                // local feet ~ +38

      const rnd = DS.makeRng(5);
      // clean baseline + soft shadow (no stage clutter behind the character)
      D.line(ctx, cx - 200, feetY, cx + 200, feetY, { width: 4, color: D.COL.inkSoft, rnd, passes: 1 });
      ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = D.COL.ink;
      ctx.beginPath(); ctx.ellipse(cx, feetY, 64 * cScale, 11, 0, 0, 7); ctx.fill(); ctx.restore();

      ctx.save(); ctx.translate(cx, cy); ctx.scale(PV, PV);
      // the speed-moves morph into a weapon — show that art (with the pose faint behind it)
      const weaponKind = this.action === 'supershot' ? 'cannon'
        : (this.action === 'superpunch' || this.action === 'ultrapunch') ? 'glove'
          : this.action === 'hammer' ? 'hammer' : null;
      ctx.save();
      // glove/cannon are full-body MORPHS → show the body faint behind the weapon; the hammer
      // is a held prop → keep the body solid (matches how each looks in game)
      if (weaponKind === 'glove' || weaponKind === 'cannon') ctx.globalAlpha = 0.28;
      DS.character.drawFighter(ctx, ch, act.pose, { facing: 1, seed: 7,
        expr: this.action === 'attack' || this.action === 'special' ? 'attack' : this.action === 'hurt' ? 'hurt' : this.action === 'shield' ? 'shield' : '' });
      ctx.restore();
      if (weaponKind) {
        DS.character.weapon(ctx, weaponKind, { dir: 1, big: this.action === 'ultrapunch', scale: cScale, swing: 0.85 });
      }
      if (act.hit) { // hitbox preview (in the same local space the hit is checked)
        const h = act.hit;
        ctx.globalAlpha = 0.55; ctx.strokeStyle = D.COL.accent; ctx.lineWidth = 1.4;
        ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, 7); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
      ctx.restore();

      ctx.fillStyle = D.COL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = "30px 'Gloria Hallelujah', cursive";
      ctx.fillText(this.charName + ' — ' + this.action, cx, 80);
    }
  }

  DS.Editor = Editor;
})(window);
