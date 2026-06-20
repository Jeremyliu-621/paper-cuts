// Match flow: spawns two fighters, runs the sim with hitstop, draws HUD + overlays.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;
  const POOF = 0.26; // seconds for a projectile's fade-out animation
  // per-player colours (markers + HUD cards) so up to 6 fighters read apart at a glance
  const PCOL = ['#5b8c5a', '#c0603a', '#3f6fa0', '#9a6cb0', '#b58a2e', '#3f8f86'];
  // after a winner is decided the match doesn't freeze — it keeps simulating (fighters can
  // still move, the world lives on) for this long, THEN the victory screen takes over.
  const OUTRO_DUR = 3.0;
  // anticipation easing with a little overshoot (Smash-y pop-in)
  const outBack = (x) => { x = Math.min(1, Math.max(0, x)); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

  class Game {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.effects = new DS.Effects();
      this.scale = 1; this.ox = 0; this.oy = 0;
      this.state = 'ready';
      this.winner = null;
      this.rebuild();
    }

    get data() { return DS.Store.data; }

    rebuild() {
      const d = this.data;
      this.view = d.view;
      // resolve the selected mode + map (default Smash on the editable Meadow stage)
      this.modeId = this.modeId || 'smash';
      this.mapId = this.mapId || 'meadow';
      this.mode = DS.Modes.get(this.modeId);
      // play a CLONE of the map's editable+persistent stage, so a match (moving platforms,
      // cannon timers, breakable crates, portal cooldowns) never mutates the saved stage
      this.stage = DS.data.clone(DS.Maps.stageFor(d, this.mapId));
      this._prepareStage();
      // how many fighters this match: 2 (keyboard) up to 6 (one per joined phone)
      const n = Math.max(2, Math.min(6, this.getPlayerCount ? this.getPlayerCount() : (this.numPlayers || 2)));
      this.numPlayers = n;
      const spawns = this._spawnPoints(n);
      this.fighters = [];
      for (let i = 0; i < n; i++) {
        const char = i < d.roster.length ? d.roster[i] : this._variantChar(d, i);
        const f = new DS.Fighter(char, d, i, this.stage, spawns[i]);
        f.tagCol = PCOL[i % PCOL.length]; // ult-charge glow uses this player's name-tag colour
        this.fighters.push(f);
      }
      // ultimate per fighter: P1/P2 from the pre-match pick screen, 3–6 default to hammer
      const picks = this.ultPick || [];
      for (let i = 0; i < this.fighters.length; i++) this.fighters[i].ultType = picks[i] || 'hammer';
      // per-player drawings from the lobby → give that fighter its own skinned character
      const skins = this.playerSkins || [];
      this.fighters.forEach((f, i) => { if (skins[i] && skins[i].enabled) { const ch = DS.data.clone(f.ch); ch.skin = skins[i]; f.ch = ch; } });
      this.projectiles = [];
      this.cam = { cx: d.view.w / 2, cy: d.view.h / 2, zoom: 1 };
      // dev: when set (a number), force a fixed overview zoom so you can see the whole
      // arena / blast borders. null = normal dynamic camera. Toggled by keys in main.js.
      if (this.devZoom === undefined) this.devZoom = null;
      this.effects.reset();
      this.timer = d.settings.timerSeconds;
      this.state = 'ready';
      this.winner = null;
      this.modeState = null;
      const game = this;
      this.world = {
        settings: d.settings, platforms: this.stage.platforms, stage: this.stage, view: d.view,
        effects: this.effects, game: this,
        blast: this.blast, bounds: this.bounds,
        // reuse one scratch array instead of allocating a filtered copy on every call (called in
        // attack hit-loops). callers iterate the result immediately and never nest opponents() calls.
        _oppScratch: [],
        opponents: function (self) { const a = this._oppScratch; a.length = 0; for (const f of game.fighters) if (f !== self) a.push(f); return a; },
        onChange: () => game.checkOver(),
        damageBox: (p, amt) => game.damageBox(p, amt),
        spawnProjectile: (owner, cfg, aimDeg) => {
          // launch angle = editable base + the player's aim (held up/down). default straight.
          const a = ((cfg.angle || 0) + (aimDeg || 0)) * Math.PI / 180;
          game.projectiles.push({
            owner, cfg, x: owner.x + 40 * owner.facing, y: owner.y - 6,
            vx: Math.cos(a) * owner.facing * cfg.speed, vy: -Math.sin(a) * cfg.speed,
            life: cfg.life, r: cfg.r, facing: owner.facing, spin: 0,
          });
          game.effects.dust(owner.x + 30 * owner.facing, owner.y, owner.facing);
          if (DS.Audio) DS.Audio.play('shot', { x: owner.x, speed: cfg.speed, dmg: cfg.damage });
        },
        // spawn a projectile travelling along an arbitrary WORLD angle (the sniper ultimate)
        spawnProjectileAt: (owner, cfg, ang) => {
          const ca = Math.cos(ang), sa = Math.sin(ang);
          game.projectiles.push({
            owner, cfg, x: owner.x + ca * 46, y: owner.y - 6 + sa * 46,
            vx: ca * cfg.speed, vy: sa * cfg.speed,
            life: cfg.life, r: cfg.r, facing: ca >= 0 ? 1 : -1, spin: 0,
          });
          game.effects.dust(owner.x + ca * 34, owner.y - 6 + sa * 34, ca >= 0 ? 1 : -1);
          if (DS.Audio) DS.Audio.play('sniper_shot', { x: owner.x });
        },
        // the Super Hammer ultimate: a spinning hammer thrown out to mid range, then back.
        // aimDeg (held up/down, same as the normal shot) tilts the throw direction.
        spawnBoomerang: (owner, cfg, aimDeg) => {
          const a = (aimDeg || 0) * Math.PI / 180, ca = Math.cos(a) * owner.facing, sa = -Math.sin(a);
          game.projectiles.push({
            owner, cfg, boomerang: true, phase: 'out', originX: owner.x, originY: owner.y - 6,
            x: owner.x + ca * 36, y: owner.y - 6 + sa * 36, vx: ca * cfg.speed, vy: sa * cfg.speed,
            life: 3.5, r: cfg.r, facing: owner.facing, spin: 0, hits: new Set(),
          });
          game.effects.charge(owner.x + ca * 30, owner.y - 6 + sa * 30, owner.tagCol);
          if (DS.Audio) DS.Audio.play('boomerang', { x: owner.x });
        },
      };
      this.mode.setup(this);
    }

    // one-time per-match stage prep: stable jitter seeds, breakable hp, initial
    // positions for moving platforms, and the world bounds + blast zone (which now
    // derive from the map so bigger arenas pan and KO correctly).
    _prepareStage() {
      const st = this.stage, v = this.view;
      st._t = 0;
      st.platforms.forEach((p, i) => {
        p._seed = i * 97 + 13;
        if (p.hp != null) p._hp = p.hp;
        if (p.move) this._posMove(p, 0);
        if (p.fire) { p._fireT = p.fire.delay != null ? p.fire.delay : 0; p._flash = 0; } // cannons stagger via delay
        // a hand-drawn platform collides as the stroke itself → world-space line segments
        if (p.kind === 'drawn' && p.pts && p.pts.length > 1) {
          p._segs = [];
          for (let k = 0; k < p.pts.length - 1; k++) {
            p._segs.push({ ax: p.x + p.pts[k][0], ay: p.y + p.pts[k][1], bx: p.x + p.pts[k + 1][0], by: p.y + p.pts[k + 1][1] });
          }
        }
      });
      const b = st.bounds || { x0: 0, y0: 0, x1: v.w, y1: v.h };
      this.bounds = b;
      // explicit map blast > derived-from-bounds (sized maps) > the shared settings blast (Meadow)
      this.blast = st.blast || (st.bounds
        ? { left: b.x0 - 700, right: b.x1 + 700, top: b.y0 - 780, bottom: b.y1 + 560 }
        : this.data.settings.blast);
    }

    // n spawn points: use the map's if it has enough, else spread evenly across the
    // widest solid platform (the main ground) so 3–6 fighters don't pile up.
    _spawnPoints(n) {
      const sp = this.stage.spawns || [];
      if (sp.length >= n) return sp.slice(0, n);
      let ground = null;
      for (const p of this.stage.platforms) if (!p.pass && (!ground || p.w > ground.w)) ground = p;
      const baseY = (sp[0] && sp[0].y) || (ground ? ground.y - 60 : this.view.h * 0.6);
      const x0 = ground ? ground.x + 110 : this.view.w * 0.18;
      const x1 = ground ? ground.x + ground.w - 110 : this.view.w * 0.82;
      const out = [];
      for (let i = 0; i < n; i++) { const t = n === 1 ? 0.5 : i / (n - 1); out.push({ x: x0 + (x1 - x0) * t, y: baseY }); }
      return out;
    }

    // a distinct-looking fighter for slots beyond the 2-character roster: clone a base
    // character (keeps stats/actions/skin) but give it a different head + player colour.
    _variantChar(d, i) {
      const base = d.characters[d.roster[i % d.roster.length]];
      const ch = DS.data.clone(base);
      const heads = ['spikes', 'beanie', 'tuft', 'none'];
      ch.head = heads[i % heads.length];
      ch.accent = PCOL[i % PCOL.length];
      return { name: 'P' + (i + 1), ch };
    }

    // position a moving platform at time t (swing = pendulum from a pivot; linear = ping-pong)
    _posMove(p, t) {
      const m = p.move;
      if (m.type === 'swing') {
        const ang = (m.arc != null ? m.arc : 0.5) * Math.sin((2 * Math.PI * t) / (m.period || 3) + (m.phase || 0));
        p.x = m.pivotX + Math.sin(ang) * m.len - p.w / 2;
        p.y = m.pivotY + Math.cos(ang) * m.len - p.h / 2;
      } else if (m.type === 'linear') {
        const u = (Math.sin((2 * Math.PI * t) / (m.period || 4) + (m.phase || 0)) + 1) / 2;
        p.x = m.ax + (m.bx - m.ax) * u;
        p.y = m.ay + (m.by - m.ay) * u;
      }
    }

    // animate moving platforms and carry any fighter riding on top by the same delta
    _updateStage(dt) {
      const st = this.stage;
      st._t = (st._t || 0) + dt;
      for (const p of st.platforms) {
        if (!p.move) continue;
        const ox = p.x, oy = p.y;
        this._posMove(p, st._t);
        const dx = p.x - ox, dy = p.y - oy;
        if (!dx && !dy) continue;
        for (const f of this.fighters) {
          if (f.dead || f.respawnT > 0) continue;
          if (f.onGround && f.ground === p) { f.x += dx; f.y += dy; }
        }
      }
      // cannons: fire a cannonball along their barrel on each interval
      for (const p of st.platforms) {
        if (!p.fire) continue;
        if (p._flash > 0) p._flash -= dt;
        p._fireT -= dt;
        if (p._fireT <= 0) { p._fireT = p.fire.every; p._flash = 0.14; this._fireCannon(p); }
      }
      // portals: a fighter that steps into one is whisked to its linked exit (brief cooldown
      // so it doesn't instantly bounce back through the destination portal)
      const portals = st.portals;
      if (portals && portals.length) {
        for (const f of this.fighters) {
          if (f.dead || f.respawnT > 0) continue;
          if (f._portalCd > 0) { f._portalCd -= dt; continue; }
          for (const pt of portals) {
            const dx = f.x - pt.x, dy = f.y - pt.y;
            if (dx * dx / (pt.r * pt.r) + dy * dy / (pt.r * pt.r) <= 1) {
              const dest = portals.find((q) => q.id === pt.link);
              if (dest) {
                this.effects.aura(pt.x, pt.y, pt.col || D.COL.power);
                f.x = dest.x; f.y = dest.y; f._portalCd = 0.7;
                this.effects.aura(dest.x, dest.y, dest.col || D.COL.power);
                if (DS.Audio) DS.Audio.play('dash', { x: dest.x });
              }
              break;
            }
          }
        }
      }
    }

    // fire one cannonball from a cannon platform along its barrel angle (no owner — a stage hazard)
    _fireCannon(p) {
      const fire = p.fire, ang = (fire.deg || 0) * Math.PI / 180;
      const ca = Math.cos(ang), sa = -Math.sin(ang); // +deg = up
      const cx = p.x + p.w / 2, cy = p.y + 8, tip = Math.min(p.w * 0.8, 66) + 14;
      const cfg = {
        cannon: true, speed: fire.speed, damage: fire.damage, r: fire.r || 26,
        kbBase: fire.kbBase != null ? fire.kbBase : 30, kbScale: fire.kbScale != null ? fire.kbScale : 0.12,
        angle: fire.kbAngle != null ? fire.kbAngle : 28, gravity: fire.gravity || 0, life: fire.life || 4,
      };
      this.projectiles.push({
        owner: null, cfg, x: cx + ca * tip, y: cy + sa * tip,
        vx: ca * fire.speed, vy: sa * fire.speed, life: cfg.life, r: cfg.r, facing: ca >= 0 ? 1 : -1, spin: 0,
      });
      this.effects.dust(cx + ca * 40, cy + sa * 40, ca >= 0 ? 1 : -1);
      this.effects.shake(0.12);
      if (DS.Audio) DS.Audio.play('shot', { x: cx, speed: fire.speed });
    }

    // damage (and maybe shatter) a breakable platform/crate
    damageBox(p, amount) {
      if (p._hp == null) return;
      p._hp -= amount;
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      if (p._hp <= 0) {
        this.effects.debris(cx, cy, 11, 1.3);
        this.effects.shake(0.3);
        if (DS.Audio) DS.Audio.play('box_break', { x: cx });
        const i = this.stage.platforms.indexOf(p);
        if (i >= 0) this.stage.platforms.splice(i, 1);
        for (const f of this.fighters) if (f.ground === p) { f.ground = null; f.onGround = false; }
      } else {
        this.effects.debris(cx, cy, 3, 0.7);
        this.effects.shake(0.12);
        if (DS.Audio) DS.Audio.play('box_hit', { x: cx });
      }
    }

    start() { if (this.state !== 'playing') { if (this.state === 'over' || this.state === 'outro' || this.state === 'victory' || this.winner) this.rebuild(); this.state = 'playing'; } }
    togglePause() { if (this.state === 'playing') this.state = 'paused'; else if (this.state === 'paused') this.state = 'playing'; }

    // a winner has been decided — but the match doesn't slam to a halt. enter the OUTRO:
    // the sim keeps running (fighters move, the camera lives) for OUTRO_DUR, then the
    // animated victory screen takes over. guarded so the modes can't re-trigger it.
    endMatch(winner) {
      if (this.state !== 'playing') return;
      this.winner = winner || null;
      this.state = 'outro';
      this.outroT = OUTRO_DUR;
      // punch the moment home: a freeze-frame, a big shake, and a darkening veil that
      // flares hard right as they win then settles — clear "someone just won" feedback
      this.winFlash = 1;
      this.effects.shake(1);
      this.effects.hitstop(0.16);
    }

    checkOver() {
      const alive = this.fighters.filter((f) => !f.dead);
      if (alive.length <= 1 && this.state === 'playing') this.endMatch(alive[0] || null);
    }

    finishByScore() {
      // most stocks wins; tie-break on least damage (works for 2..6 fighters)
      let w = null;
      for (const f of this.fighters) {
        if (!w || f.stocks > w.stocks || (f.stocks === w.stocks && f.damage < w.damage)) w = f;
      }
      this.endMatch(w);
    }

    update(dt, input) {
      // global controls
      if (DS.Input.pressed('Enter')) { if (this.state === 'ready' || this.state === 'over' || this.state === 'victory') this.start(); }
      if (DS.Input.pressed('KeyP')) this.togglePause();

      // brush wipe: sim parked, advance the wipe + the (revealing) victory animation
      if (this.state === 'wipe') {
        this.wipe.t += dt; this._tickVictory(dt); this.effects.update(dt);
        this.winFlash = Math.max(0, (this.winFlash || 0) - dt * 0.7);
        if (this.wipe.t >= this.wipe.dur) this.state = 'victory';
        return;
      }
      // victory screen: sim is parked, just advance the celebration animation
      if (this.state === 'victory') { this._tickVictory(dt); this.effects.update(dt); return; }
      // 'outro' keeps the sim fully live (that's the point) — only 'paused'/'ready'/'over' stop it
      if (this.state !== 'playing' && this.state !== 'outro') return;

      this._updateCamera(dt);

      if (this.effects.hitstopT > 0) {
        this.effects.hitstopT -= dt;
        this.effects.update(dt);
        return;
      }
      this._updateStage(dt);
      if (this.demo) {
        this._aiT = (this._aiT || 0) + dt;
        for (const f of this.fighters) f.update(dt, this._ai(f), this.world);
      } else {
        for (let i = 0; i < this.fighters.length; i++) this.fighters[i].update(dt, input.player(i), this.world);
      }
      this._resolveBodies();
      this._updateProjectiles(dt);
      this.effects.update(dt);
      // mode-specific scoring & win conditions (Smash also runs the stock/timer check here)
      this.mode.update(this, dt);
      // outro countdown: the world keeps living, then the brush sweeps in to the victory screen
      if (this.state === 'outro') {
        this.outroT -= dt;
        this.winFlash = Math.max(0, (this.winFlash || 0) - dt * 0.7);
        if (this.outroT <= 0) this._beginWipe();
      }
    }

    // Smash-style dynamic camera: frame both fighters, zoom out (and drift toward) a
    // launched fighter, ease smoothly. Zooms out fast, settles back in slowly.
    _updateCamera(dt) {
      const vw = this.view.w, vh = this.view.h;
      if (!this.cam) this.cam = { cx: vw / 2, cy: vh / 2, zoom: 1 };
      const fs = this.fighters.filter((f) => !f.dead && f.respawnT <= 0);
      let tx = vw / 2, ty = vh / 2, tz = 1;
      if (fs.length) {
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        for (const f of fs) { minX = Math.min(minX, f.x); maxX = Math.max(maxX, f.x); minY = Math.min(minY, f.y); maxY = Math.max(maxY, f.y); }
        tx = (minX + maxX) / 2; ty = (minY + maxY) / 2;
        const needW = (maxX - minX) + 900, needH = (maxY - minY) + 780;
        tz = Math.max(0.42, Math.min(1.15, Math.min(vw / needW, vh / needH)));
      }
      // outro (the dark beat right after the win): push in dramatically on the winner before
      // the brush wipe takes over — a Smash-style victory close-up.
      if (this.state === 'outro' && this.winner && !this.winner.dead && this.winner.respawnT <= 0) {
        tx = this.winner.x; ty = this.winner.y - 10; tz = 1.95;
      }
      // clamp the camera centre to the stage bounds (+margin) so it follows fighters
      // across bigger maps but never drifts off into blank paper.
      const bn = this.bounds || { x0: 0, y0: 0, x1: vw, y1: vh };
      tx = Math.max(bn.x0 - 700, Math.min(bn.x1 + 700, tx));
      ty = Math.max(bn.y0 - 600, Math.min(bn.y1 + 560, ty));
      const ease = (c, t, r) => c + (t - c) * Math.min(1, dt * r);
      this.cam.cx = ease(this.cam.cx, tx, 3.2);
      this.cam.cy = ease(this.cam.cy, ty, 3.2);
      this.cam.zoom = ease(this.cam.zoom, tz, tz < this.cam.zoom ? 6 : 2.6);
      // dev override: lock to a fixed centred overview at the requested zoom
      if (this.devZoom) { this.cam.zoom = this.devZoom; this.cam.cx = vw / 2; this.cam.cy = vh / 2; }
    }

    // hand-drawn dashed border at the KO boundary; comes into view as the camera
    // zooms out toward a launched fighter (off-screen during normal close play)
    _renderBlastBorder(ctx) {
      const b = this.blast || this.data.settings.blast, rnd = DS.makeRng(778);
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.setLineDash([24, 18]);
      const o = { width: 5, color: D.COL.ink, rnd, passes: 1, jitter: 2.5 };
      D.line(ctx, b.left, b.top, b.right, b.top, o);
      D.line(ctx, b.right, b.top, b.right, b.bottom, o);
      D.line(ctx, b.right, b.bottom, b.left, b.bottom, o);
      D.line(ctx, b.left, b.bottom, b.left, b.top, o);
      ctx.setLineDash([]);
      ctx.restore();
    }

    // soft body collision so fighters can't phase through each other. resolves along the
    // smaller overlap axis (push apart side-to-side, or let one rest briefly on the other),
    // splitting the correction between the two.
    _resolveBodies() {
      const F = this.fighters;
      for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) {
        const a = F[i], b = F[j];
        if (a.dead || b.dead || a.respawnT > 0 || b.respawnT > 0) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const ox = (a.w + b.w) / 2 - Math.abs(dx);
        const oy = (a.h + b.h) / 2 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue; // not overlapping
        if (ox <= oy) {
          // side-by-side: push apart horizontally and stop them grinding into each other
          const dir = dx >= 0 ? 1 : -1, push = ox / 2 + 0.25;
          a.x -= dir * push; b.x += dir * push;
          if (a.vx * dir > 0) a.vx = 0;       // cancel velocity heading into the other
          if (b.vx * dir < 0) b.vx = 0;
        } else {
          // stacked: push apart vertically (you can briefly stand on a head, then slide off)
          const dir = dy >= 0 ? 1 : -1, push = oy / 2 + 0.25;
          a.y -= dir * push; b.y += dir * push;
          if (dir > 0) { if (a.vy > 0) a.vy = 0; } else { if (b.vy > 0) b.vy = 0; }
        }
      }
    }

    _updateProjectiles(dt) {
      const b = this.blast || this.data.settings.blast, plats = this.stage.platforms;
      for (const pr of this.projectiles) {
        // already poofing: shrink/float, no movement or collisions
        if (pr.fade != null) { pr.fade -= dt; pr.spin += dt * 22; pr.x += pr.vx * dt; pr.y += pr.vy * dt; continue; }
        if (pr.boomerang) { this._updateBoomerang(pr, dt); continue; } // out-and-back, flies through platforms
        pr.life -= dt; pr.spin += dt * 16;
        pr.vy += (pr.cfg.gravity || 0) * dt;
        // sniper shot homes a LITTLE toward the nearest target (forgiving aim, not a lock-on)
        if (pr.cfg.sniper) {
          let tgt = null, best = 1e9;
          for (const f of this.fighters) { if (f === pr.owner || f.dead || f.respawnT > 0) continue; const dd = (f.x - pr.x) ** 2 + (f.y - pr.y) ** 2; if (dd < best) { best = dd; tgt = f; } }
          if (tgt) {
            const cur = Math.atan2(pr.vy, pr.vx), sp = Math.hypot(pr.vx, pr.vy);
            const des = Math.atan2(tgt.y - pr.y, tgt.x - pr.x);
            let turn = Math.atan2(Math.sin(des - cur), Math.cos(des - cur));
            const maxTurn = 1.0 * dt; turn = Math.max(-maxTurn, Math.min(maxTurn, turn)); // subtle nudge, not a curve
            pr.vx = Math.cos(cur + turn) * sp; pr.vy = Math.sin(cur + turn) * sp;
          }
        }
        pr.x += pr.vx * dt; pr.y += pr.vy * dt;
        let struck = false;
        // hit a fighter (not the owner) -> impact burst handles the disappearance
        for (const f of this.fighters) {
          if (f === pr.owner || f.dead || f.respawnT > 0 || f.invuln > 0) continue;
          if (Math.abs(f.x - pr.x) < f.w / 2 + pr.r && Math.abs(f.y - pr.y) < f.h / 2 + pr.r) {
            f._takeHit(pr.cfg, pr.vx >= 0 ? 1 : -1, pr.owner, this.world);
            if (pr.cfg.sniper) { this.effects.ultHit(pr.x, pr.y, 1.5, pr.owner && pr.owner.tagCol); this.effects.hitstop(0.12); } // satisfying snipe
            else this.effects.impact(pr.x, pr.y, 0.8);
            pr.dead = true; struck = true; break;
          }
        }
        if (struck) continue;
        // fizzle on a solid platform (and chip a breakable crate/structure on the way out)
        for (const p of plats) {
          if (!p.pass && pr.x > p.x && pr.x < p.x + p.w && pr.y > p.y && pr.y < p.y + p.h) {
            if (p._hp != null) this.damageBox(p, pr.cfg.damage || 6);
            else if (DS.Audio) DS.Audio.play('fizzle', { x: pr.x });
            this.effects.impact(pr.x, pr.y, 0.4); pr.dead = true; struck = true; break;
          }
        }
        if (struck) continue;
        // ran out of life / left the arena -> gentle shrink-and-fade poof (not a hard cut)
        if (pr.life <= 0 || pr.x < b.left || pr.x > b.right || pr.y < b.top || pr.y > b.bottom) {
          pr.fade = POOF; pr.vx *= 0.25; pr.vy = pr.vy * 0.25 - 30; // drift up a touch as it dissipates
        }
      }
      this.projectiles = this.projectiles.filter((p) => !p.dead && (p.fade == null || p.fade > 0));
    }

    // boomerang hammer: flies out (decelerating) to mid range, then homes back to the thrower,
    // spinning the whole time and ignoring platforms; big launch, once per pass (out + back)
    _updateBoomerang(pr, dt) {
      const cfg = pr.cfg; pr.spin += dt * 26; pr.life -= dt;
      if (pr.phase === 'out') {
        pr.x += pr.vx * dt; pr.y += pr.vy * dt; const k = 1 - dt * 1.6; pr.vx *= k; pr.vy *= k;
        const dist = Math.hypot(pr.x - pr.originX, pr.y - (pr.originY != null ? pr.originY : pr.y));
        if (dist >= cfg.range || Math.hypot(pr.vx, pr.vy) < cfg.speed * 0.18) { pr.phase = 'back'; pr.hits.clear(); }
      } else {
        const o = pr.owner, dx = o.x - pr.x, dy = (o.y - 6) - pr.y, d = Math.hypot(dx, dy) || 1, sp = cfg.speed * 1.1;
        pr.vx = dx / d * sp; pr.vy = dy / d * sp; pr.x += pr.vx * dt; pr.y += pr.vy * dt;
        if (d < 42 || pr.life <= 0) pr.dead = true; // caught (or timed out)
      }
      for (const f of this.fighters) {
        if (f === pr.owner || f.dead || f.respawnT > 0 || f.invuln > 0 || pr.hits.has(f)) continue;
        if (Math.abs(f.x - pr.x) < f.w / 2 + pr.r && Math.abs(f.y - pr.y) < f.h / 2 + pr.r) {
          pr.hits.add(f); f._takeHit(cfg, pr.vx >= 0 ? 1 : -1, pr.owner, this.world);
          this.effects.ultHit(pr.x, pr.y, 1.5, pr.owner && pr.owner.tagCol); this.effects.hitstop(0.12);
        }
      }
    }

    _renderProjectiles(ctx) {
      for (const pr of this.projectiles) {
        const rnd = DS.makeRng(((pr.spin * 50) | 0) + 1);
        // ult projectiles wear their owner's player colour; a deep variant for fills/accents
        const oc = (pr.owner && pr.owner.tagCol) || D.COL.power, ocDeep = D.mix(oc, D.COL.ink, 0.45);
        // cannonball: a heavy dark iron ball with a stubby lit fuse
        if (pr.cfg && pr.cfg.cannon && pr.fade == null) {
          ctx.save(); ctx.translate(pr.x, pr.y); ctx.rotate(pr.spin);
          D.circle(ctx, 0, 0, pr.r, { width: 5, color: D.COL.ink, rnd, fill: D.mix(D.COL.ink, D.COL.paper, 0.55), wob: 1.5 });
          D.circle(ctx, -pr.r * 0.3, -pr.r * 0.32, pr.r * 0.22, { width: 0, color: D.COL.paper, fill: D.COL.paper }); // shine
          D.line(ctx, 0, -pr.r, pr.r * 0.4, -pr.r - 9, { width: 3, color: D.COL.accent, rnd, passes: 1 }); // fuse
          ctx.restore();
          continue;
        }
        // boomerang hammer: a big spinning hammer in the player's colour
        if (pr.boomerang) {
          ctx.save(); ctx.translate(pr.x, pr.y); ctx.rotate(pr.spin); ctx.scale(1.85, 1.85);
          D.line(ctx, 0, 18, 0, -16, { width: 6, color: oc, rnd, passes: 1 });
          D.strokePts(ctx, [[-11, -16], [15, -16], [15, -33], [-11, -33]], { width: 5, color: oc, rnd, closed: true, fill: ocDeep });
          ctx.restore();
          continue;
        }
        // dissipating: the ball shrinks and fades while little dashes puff outward
        if (pr.fade != null) {
          const k = Math.max(0, pr.fade / POOF);
          ctx.save(); ctx.globalAlpha = k; ctx.translate(pr.x, pr.y);
          D.circle(ctx, 0, 0, pr.r * (0.3 + 0.55 * k), { width: 3.5, color: D.COL.ink, rnd, wob: 1.5 });
          const reach = pr.r * (0.7 + (1 - k) * 1.5);
          for (let i = 0; i < 5; i++) {
            const a = pr.spin * 0.2 + i * (Math.PI * 2 / 5);
            D.line(ctx, Math.cos(a) * reach * 0.45, Math.sin(a) * reach * 0.45, Math.cos(a) * reach, Math.sin(a) * reach, { width: 3, color: D.COL.ink, passes: 1 });
          }
          ctx.restore(); ctx.globalAlpha = 1;
          continue;
        }
        // motion streaks trailing along the actual travel direction (so angled shots angle too)
        const sp = Math.hypot(pr.vx, pr.vy) || 1, dx = pr.vx / sp, dy = pr.vy / sp;
        const px = -dy, py = dx;
        ctx.globalAlpha = 0.6;
        for (const s of [-1, 1]) {
          const ox = px * s * 4, oy = py * s * 4;
          D.line(ctx, pr.x - dx * (pr.r + 4) + ox, pr.y - dy * (pr.r + 4) + oy, pr.x - dx * (pr.r + 26) + ox, pr.y - dy * (pr.r + 26) + oy, { width: 3, color: D.COL.ink, passes: 1 });
        }
        ctx.globalAlpha = 1;
        // the sniper ULT bullet wears the owner's colour; ordinary shots stay ink
        const ballCol = pr.cfg.sniper ? oc : D.COL.ink;
        ctx.save(); ctx.translate(pr.x, pr.y); ctx.rotate(pr.spin);
        D.circle(ctx, 0, 0, pr.r, { width: 4, color: ballCol, rnd, fill: D.COL.paper, wob: 1.5 });
        D.line(ctx, -pr.r * 0.55, 0, pr.r * 0.55, 0, { width: 3, color: ballCol, rnd, passes: 1 });
        D.line(ctx, 0, -pr.r * 0.55, 0, pr.r * 0.55, { width: 3, color: ballCol, rnd, passes: 1 });
        ctx.restore();
      }
    }

    // simple attract-mode AI (also used by #demo to validate combat visually)
    _ai(self) {
      // target the nearest living opponent (works for 2..6 fighters)
      let opp = null, best = Infinity;
      for (const o of this.fighters) {
        if (o === self || o.dead || o.respawnT > 0) continue;
        const dd = Math.hypot(o.x - self.x, o.y - self.y);
        if (dd < best) { best = dd; opp = o; }
      }
      if (!opp) return { left: false, right: false, down: false, shield: false, up: false, pressUp: false, pressDown: false, pressAttack: false, pressSpecial: false, holdAttack: false, holdSpecial: false };
      const dx = opp.x - self.x, adx = Math.abs(dx), t = this._aiT + self.pIndex * 0.37;
      const toward = dx > 0 ? 1 : -1;            // direction to opponent
      const approach = adx > 60, backoff = adx < 36;
      const inRange = adx >= 34 && adx <= 86 && Math.abs(opp.y - self.y) < 64;
      const ranged = adx > 95 && adx < 760 && Math.abs(opp.y - self.y) < 90;
      return {
        right: (toward > 0 && approach) || (toward < 0 && backoff),
        left: (toward < 0 && approach) || (toward > 0 && backoff),
        down: false, shield: false, up: false,
        pressUp: self.onGround && (!opp.onGround && opp.y < self.y - 36) || Math.sin(t * 1.9) > 0.99,
        pressDown: false,
        pressAttack: inRange && !self.action && Math.sin(t * 4.5) > 0.4,
        pressSpecial: self.onGround && !self.action && ranged && Math.cos(t * 1.1) > 0.86,
        holdAttack: false, holdSpecial: false,
      };
    }

    // ---- rendering ----
    _applyView(cw, ch) {
      const vw = this.view.w, vh = this.view.h;
      this.scale = Math.min(cw / vw, ch / vh);
      this.ox = (cw - vw * this.scale) / 2;
      this.oy = (ch - vh * this.scale) / 2;
    }

    render(cssW, cssH) {
      // canvas not laid out yet (0-size) — skip this frame instead of throwing on
      // drawImage(paperTexture(0,..)); the loop will draw once layout settles.
      if (cssW <= 0 || cssH <= 0) return;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, cssW, cssH);
      // one continuous sheet of paper across the whole view (no page/mat boundary)
      ctx.drawImage(D.paperTexture(cssW, cssH), 0, 0);
      this._applyView(cssW, cssH);
      // victory screen fully replaces the world view with its own animated celebration
      if (this.state === 'victory') {
        ctx.save();
        ctx.translate(this.ox, this.oy); ctx.scale(this.scale, this.scale);
        this._renderVictory(ctx);
        ctx.restore();
        return;
      }
      // brush-wipe transition: paints the live game away to reveal the victory screen
      if (this.state === 'wipe') { this._renderWipe(ctx, cssW, cssH); return; }
      this._renderScene(ctx);
      // the win-moment darkening veil rides over the live game during the outro
      if (this.state === 'outro') this._outroVeil(ctx, cssW, cssH);
    }

    // dark wash that flares as the winner is decided then settles — "someone just won"
    _outroVeil(ctx, cssW, cssH) {
      const dark = 0.18 + 0.42 * (this.winFlash || 0);
      if (dark <= 0) return;
      ctx.save();
      ctx.fillStyle = 'rgba(28,24,21,' + dark.toFixed(3) + ')';
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.restore();
    }

    // the live match view (world + HUD) — its own method so the brush wipe can paint it
    // on one side of the screen while the victory screen is revealed on the other.
    _renderScene(ctx) {
      const cam = this.cam || { cx: this.view.w / 2, cy: this.view.h / 2, zoom: 1 };
      // dev overview override applies even while paused (so you can inspect a frozen frame)
      if (this.devZoom) { cam.zoom = this.devZoom; cam.cx = this.view.w / 2; cam.cy = this.view.h / 2; }
      const sh = this.effects.shakeOffset();

      // ---- world layer: view-fit + dynamic camera (pan + zoom around the view centre) ----
      ctx.save();
      // no clip: the world fills the whole canvas (no side margins cutting the field off)
      ctx.translate(this.ox, this.oy);
      ctx.scale(this.scale, this.scale);
      ctx.translate(this.view.w / 2, this.view.h / 2);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.rotate(sh.r);
      ctx.translate(-cam.cx + sh.x, -cam.cy + sh.y);
      // zoomed far out → drop the per-stroke sketch pass (invisible at that scale, ~½ the work)
      D.setLod(cam.zoom < 0.7 ? 0 : 1);
      // parallax home = the stage-centred resting view; scenery sits as authored when the camera is here
      const home = { x: this.view.w / 2, y: this.view.h / 2 };
      DS.stage.drawBackground(ctx, this.stage, cam, home);
      this._renderBlastBorder(ctx);
      DS.stage.drawStage(ctx, this.stage, cam, home);
      if (this.mode.renderWorld) this.mode.renderWorld(this, ctx);
      for (const f of this.fighters) f.render(ctx, this.world);
      this._renderProjectiles(ctx);
      this.effects.render(ctx);
      for (const f of this.fighters) this._marker(ctx, f);
      if (this.devBars) for (const f of this.fighters) this._devSpeedBar(ctx, f);
      ctx.restore();
      D.setLod(1); // HUD always full detail

      // ---- HUD layer: anchored to the view box, unaffected by the camera ----
      ctx.save();
      ctx.translate(this.ox, this.oy);
      ctx.scale(this.scale, this.scale);
      this._hud(ctx);
      this._overlay(ctx);
      // dev: tiny indicator while the overview zoom is engaged
      if (this.devZoom) {
        const U = this._u();
        ctx.save();
        ctx.font = (15 * U) + 'px "Patrick Hand", sans-serif';
        ctx.fillStyle = D.COL.accent; ctx.textAlign = 'center';
        ctx.fillText('DEV ZOOM ' + this.devZoom.toFixed(2) + '×   ( − / =  ·  0 toggle  ·  \\ auto )', this.view.w / 2, this.view.h - 14 * U);
        ctx.restore();
      }
      ctx.restore();
    }

    // HUD/overlay sizes are authored against a 720-tall view; scale by U so they
    // keep a constant on-screen size at any view resolution.
    _u() { return this.view.h / 720; }

    _marker(ctx, f) {
      if (f.dead || f.respawnT > 0) return;
      const U = this._u();
      const x = f.x, y = f.y - f.h / 2 - 48 * U;
      const col = PCOL[f.pIndex % PCOL.length];
      ctx.fillStyle = col;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = (26 * U) + "px 'Patrick Hand', sans-serif";
      ctx.fillText('P' + (f.pIndex + 1), x, y);
      const bob = Math.sin(performance.now() / 200) * 2 * U;
      const rnd = DS.makeRng(f.pIndex + 5);
      D.curve(ctx, [[x - 7 * U, y + 6 * U + bob], [x, y + 14 * U + bob], [x + 7 * U, y + 6 * U + bob]], { width: 3.5 * U, color: col, passes: 1 });
    }

    // dev: a MOMENTUM gauge above each fighter with the "fast" threshold (what gates super
    // punch / super shot / ultra punch) ticked — momentum builds on a dash, decays after.
    _devSpeedBar(ctx, f) {
      if (f.dead || f.respawnT > 0) return;
      const U = this._u();
      const m = Math.max(0, Math.min(1, f.momentum || 0));
      const fast = f._fast ? f._fast() : m > 0.4;
      const W = 92 * U, H = 11 * U, x = f.x - W / 2, y = f.y - f.h / 2 - 98 * U;
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      // track + fill (momentum 0..1)
      ctx.fillStyle = D.COL.paper; ctx.strokeStyle = D.COL.ink; ctx.lineWidth = 2 * U;
      ctx.fillRect(x, y, W, H); ctx.strokeRect(x, y, W, H);
      ctx.fillStyle = fast ? D.COL.accent : D.COL.inkSoft;
      ctx.fillRect(x, y, W * m, H);
      // threshold tick + label (the "fast" cutoff)
      const tx = x + W * 0.4;
      ctx.strokeStyle = D.COL.ink; ctx.lineWidth = 2.5 * U;
      ctx.beginPath(); ctx.moveTo(tx, y - 5 * U); ctx.lineTo(tx, y + H + 5 * U); ctx.stroke();
      ctx.font = (10 * U) + "px 'Patrick Hand', sans-serif"; ctx.fillStyle = D.COL.ink;
      ctx.fillText('fast', tx, y + H + 16 * U);
      // readout: momentum % + ⚡ when in the fast regime
      ctx.font = (13 * U) + "px 'Patrick Hand', sans-serif";
      ctx.fillStyle = fast ? D.COL.accent : D.COL.ink;
      ctx.fillText((fast ? '⚡ ' : '') + 'mom ' + Math.round(m * 100), f.x, y - 6 * U);
      ctx.restore();
    }

    _hud(ctx) {
      const vw = this.view.w, U = this._u();
      // timer (only modes that use the match countdown)
      if (this.mode.usesTimer && this.data.settings.timerSeconds > 0) {
        const t = Math.max(0, Math.ceil(this.timer));
        const mm = Math.floor(t / 60), ss = ('0' + (t % 60)).slice(-2);
        ctx.fillStyle = D.COL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = (46 * U) + "px 'Gloria Hallelujah', cursive";
        ctx.fillText(mm + ':' + ss, vw / 2, 44 * U);
        const rnd = DS.makeRng(3);
        for (const sgn of [-1, 1]) {
          const bx = vw / 2 + sgn * 86 * U;
          for (let i = 0; i < 3; i++) D.line(ctx, bx + sgn * i * 7 * U, (30 + i * 2) * U, bx + sgn * (i * 7 + 9) * U, (26 + i * 2) * U, { width: 3 * U, color: D.COL.ink, rnd, passes: 1 });
        }
      }
      // 1v1: the deluxe corner portraits. 3–6 players: compact cards spread across the top.
      const n = this.fighters.length;
      if (n <= 2) {
        this._portrait(ctx, this.fighters[0], 26 * U, 'left');
        this._portrait(ctx, this.fighters[1], this.view.w - 26 * U, 'right');
      } else {
        const cardW = 150 * U, gap = 18 * U, total = n * cardW + (n - 1) * gap;
        const startX = (vw - total) / 2;
        for (let i = 0; i < n; i++) this._miniCard(ctx, this.fighters[i], startX + cardW / 2 + i * (cardW + gap));
      }
    }

    // compact top-row card for 3–6 player free-for-alls: colour tag + face + % + score
    _miniCard(ctx, f, cx) {
      const U = this._u();
      const timerOn = this.mode.usesTimer && this.data.settings.timerSeconds > 0;
      const y = (timerOn ? 64 : 26) * U;
      const col = PCOL[f.pIndex % PCOL.length];
      const rnd = DS.makeRng(f.pIndex + 11);
      ctx.save();
      if (f.dead) ctx.globalAlpha = 0.4;
      // P# tag (player colour)
      ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = (18 * U) + "px 'Gloria Hallelujah', cursive";
      ctx.fillText('P' + (f.pIndex + 1), cx, y);
      // face frame + mini face
      const fy = y + 30 * U;
      D.roundedRect(ctx, cx - 24 * U, fy - 24 * U, 48 * U, 48 * U, 12 * U, { width: 4 * U, color: D.COL.ink, rnd, fill: D.COL.paper });
      ctx.save(); ctx.translate(cx, fy + 3 * U); ctx.scale(0.68 * U, 0.68 * U); this._face(ctx, f.ch, rnd); ctx.restore();
      // percentage
      ctx.fillStyle = D.COL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = (24 * U) + "px 'Gloria Hallelujah', cursive";
      ctx.fillText(Math.round(f.damage) + '%', cx, fy + 46 * U);
      // score row: hearts (elimination) or the mode's score text
      const sy = fy + 66 * U;
      if (this.mode.elimination) {
        const stocks = this.data.settings.stocks;
        for (let i = 0; i < stocks; i++) this._heart(ctx, cx - (stocks - 1) * 9 * U + i * 18 * U, sy, 7 * U, i < f.stocks, rnd);
      } else if (this.mode.portraitScore) {
        ctx.fillStyle = D.COL.ink; ctx.font = (18 * U) + "px 'Patrick Hand', sans-serif";
        ctx.fillText(this.mode.portraitScore(this, f), cx, sy + 4 * U);
      }
      ctx.restore();
    }

    _portrait(ctx, f, edgeX, side) {
      const U = this._u();
      const y = 60 * U; // top corners; frame top ≈ timer top (same margin from the edge)
      const dir = side === 'left' ? 1 : -1;
      const fx = edgeX + dir * 34 * U;
      const rnd = DS.makeRng(f.pIndex + 11);
      // frame
      D.roundedRect(ctx, fx - 32 * U, y - 32 * U, 64 * U, 64 * U, 14 * U, { width: 5 * U, color: D.COL.ink, rnd, fill: D.COL.paper });
      // mini face
      ctx.save(); ctx.translate(fx, y + 4 * U); ctx.scale(0.9 * U, 0.9 * U);
      this._face(ctx, f.ch, rnd);
      ctx.restore();
      // percentage — with juice: danger glow as it climbs, a punch when you take a big
      // hit, and a trembling shake when you're in KO range
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = side === 'left' ? 'left' : 'right';
      const pct = Math.round(f.damage);
      const danger = Math.max(0, Math.min(1, (pct - 80) / 70)); // 0 at <=80%, 1 by ~150%
      const hf = Math.max(0, f.hitFlash || 0);
      const heat = Math.max(danger, hf);                         // how "red-hot" the number is
      const punch = 1 + 0.5 * hf + 0.1 * danger;                 // scale pop
      const big = (40 + Math.min(28, pct * 0.18)) * punch * U;
      ctx.font = big + "px 'Gloria Hallelujah', cursive";
      const tx = side === 'left' ? fx + 42 * U : fx - 42 * U, py = y + 6 * U;
      const jit = (danger * 1.5 + hf * 4) * U;                   // tremble when hot / just hit
      const jx = jit ? (Math.random() - 0.5) * jit : 0, jy = jit ? (Math.random() - 0.5) * jit : 0;
      ctx.fillStyle = D.COL.ink; ctx.fillText(pct + '%', tx + jx, py + jy);
      if (heat > 0.01) { // tint toward accent (red-hot) by overlaying
        ctx.save(); ctx.globalAlpha = Math.min(1, heat); ctx.fillStyle = D.COL.accent;
        ctx.fillText(pct + '%', tx + jx, py + jy); ctx.restore();
      }
      // underline
      const uw = 64 * U;
      D.line(ctx, side === 'left' ? tx : tx - uw, y + 14 * U, side === 'left' ? tx + uw : tx, y + 14 * U, { width: 4 * U, color: D.COL.ink, rnd, passes: 1 });
      // combo badge — the attacker's live chain, pops on each hit, fades as the window closes
      if (f.combo >= 2 && f.comboT > 0) {
        const cf = Math.max(0, f.comboFlash || 0);
        ctx.save();
        ctx.font = ((16 + 11 * cf) * U) + "px 'Patrick Hand', sans-serif";
        ctx.fillStyle = D.COL.accent; ctx.textAlign = side === 'left' ? 'left' : 'right';
        ctx.globalAlpha = Math.min(1, f.comboT / 0.4);
        ctx.fillText(f.combo + '× COMBO', tx, y - 30 * U);
        ctx.restore();
      }
      // score row: hearts (stocks) for elimination modes, else the mode's score text
      if (this.mode.elimination) {
        for (let i = 0; i < this.data.settings.stocks; i++) {
          const hx = (side === 'left' ? tx + 12 * U : tx - uw + 12 * U) + i * 22 * U;
          this._heart(ctx, hx, y + 30 * U, 8 * U, i < f.stocks, rnd);
        }
      } else if (this.mode.portraitScore) {
        ctx.fillStyle = D.COL.ink; ctx.textAlign = side === 'left' ? 'left' : 'right';
        ctx.textBaseline = 'middle'; ctx.font = (24 * U) + "px 'Patrick Hand', sans-serif";
        ctx.fillText(this.mode.portraitScore(this, f), tx, y + 32 * U);
      }
      // (no charge bar — the fighter itself washes blue as it charges, with an aura when ready)
    }

    _face(ctx, ch, rnd) {
      D.circle(ctx, 0, 0, 17, { width: 4.5, color: D.COL.ink, rnd });
      ctx.strokeStyle = D.COL.ink; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
      for (const ex of [-4, 4]) { ctx.beginPath(); ctx.moveTo(ex, -2); ctx.lineTo(ex, 4); ctx.stroke(); }
      if (ch.head === 'spikes') for (let i = -1; i <= 1; i++) D.line(ctx, i * 7, -14, i * 10, -26, { width: 4, color: D.COL.ink, rnd, passes: 1 });
      else if (ch.head === 'beanie') { D.line(ctx, -13, -10, 13, -10, { width: 4, color: D.COL.ink, rnd, passes: 1 }); D.circle(ctx, 0, -20, 4, { width: 3.5, color: D.COL.ink, rnd }); }
    }

    _heart(ctx, x, y, s, filled, rnd) {
      ctx.strokeStyle = D.COL.ink; ctx.fillStyle = D.COL.ink; ctx.lineWidth = 3; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y + s * 0.4);
      ctx.bezierCurveTo(x - s * 1.1, y - s * 0.3, x - s * 0.5, y - s, x, y - s * 0.25);
      ctx.bezierCurveTo(x + s * 0.5, y - s, x + s * 1.1, y - s * 0.3, x, y + s * 0.4);
      if (filled) ctx.fill(); else ctx.stroke();
    }

    _overlay(ctx) {
      // 'outro' keeps the live game on screen (no overlay); 'wipe'/'victory' draw their own full screen
      if (this.state === 'playing' || this.state === 'outro' || this.state === 'wipe' || this.state === 'victory') return;
      const vw = this.view.w, vh = this.view.h, U = this._u();
      ctx.save();
      ctx.fillStyle = 'rgba(47,42,38,0.18)'; ctx.fillRect(0, 0, vw, vh);
      ctx.fillStyle = D.COL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (this.state === 'ready') {
        const map = DS.Maps.get(this.mapId);
        ctx.font = (52 * U) + "px 'Gloria Hallelujah', cursive";
        ctx.fillText(this.mode.name, vw / 2, vh / 2 - 56 * U);
        ctx.font = (26 * U) + "px 'Patrick Hand', cursive";
        ctx.fillText(map.name + '  ·  ' + this.mode.win, vw / 2, vh / 2 - 18 * U);
        ctx.font = (34 * U) + "px 'Patrick Hand', cursive";
        const vs = this.fighters.length <= 2
          ? this.fighters[0].name + '  vs  ' + this.fighters[1].name
          : this.fighters.length + '-player free-for-all';
        ctx.fillText(vs, vw / 2, vh / 2 + 26 * U);
        ctx.fillText('press  Enter  to fight', vw / 2, vh / 2 + 66 * U);
      } else if (this.state === 'paused') {
        ctx.font = (56 * U) + "px 'Gloria Hallelujah', cursive";
        ctx.fillText('Paused', vw / 2, vh / 2);
      }
      ctx.restore();
    }

    // ===== victory screen — its own animated takeover, Smash-style ==========================
    // a hand-drawn brush sweeps across, painting the live game away and revealing the victory
    // screen behind it. the victory animation is prepped here so it animates as it's uncovered.
    _beginWipe() {
      this.state = 'wipe';
      this.wipe = { t: 0, dur: 0.85 };
      this.victory = { t: 0, parts: [], acc: 0, rnd: DS.makeRng((this.winner ? this.winner.pIndex + 1 : 0) * 97 + 13) };
      if (DS.Audio) { DS.Audio.play('swing_hammer'); DS.Audio.play('win'); }
    }

    _renderWipe(ctx, cssW, cssH) {
      const w = this.wipe, p = Math.min(1, w.t / w.dur);
      // ease so the brush whooshes through the middle, settling at both ends
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const col = (this.winner && this.winner.tagCol) || D.COL.accent;
      const deep = D.mix(col, D.COL.ink, 0.5), bandW = Math.max(70, cssW * 0.08);
      const front = -bandW + e * (cssW + bandW * 2.2);
      // hand-drawn wobble on the leading edge (so it reads as a bristly brush, not a ruler)
      const wob = (y) => front + Math.sin(y * 0.011 + p * 2.0) * 18 + Math.sin(y * 0.047 + 1.3) * 8;
      const steps = 28, dy = cssH / steps;
      const traceFront = () => { ctx.moveTo(wob(-6), -6); for (let i = 0; i <= steps; i++) { const y = i * dy; ctx.lineTo(wob(y), y); } ctx.lineTo(wob(cssH + 6), cssH + 6); };

      // 1) victory screen revealed BEHIND the brush (everything left of the front)
      ctx.save();
      ctx.beginPath(); traceFront(); ctx.lineTo(-bandW * 3, cssH + 6); ctx.lineTo(-bandW * 3, -6); ctx.closePath(); ctx.clip();
      ctx.save(); ctx.translate(this.ox, this.oy); ctx.scale(this.scale, this.scale); this._renderVictory(ctx); ctx.restore();
      ctx.restore();

      // 2) the live (frozen) game still on screen AHEAD of the brush (right of the front)
      ctx.save();
      ctx.beginPath(); traceFront(); ctx.lineTo(cssW + bandW * 3, cssH + 6); ctx.lineTo(cssW + bandW * 3, -6); ctx.closePath(); ctx.clip();
      this._renderScene(ctx);
      this._outroVeil(ctx, cssW, cssH); // the dark veil carries over onto the part still being painted away
      ctx.restore();

      // 3) the wet brush band over the seam — loaded paint in the winner's colour + bristle streaks
      ctx.save();
      ctx.beginPath(); traceFront();
      for (let i = steps; i >= 0; i--) { const y = i * dy; ctx.lineTo(wob(y) - bandW * (0.62 + 0.38 * Math.sin(y * 0.03 + 0.7)), y); }
      ctx.closePath(); ctx.clip();
      ctx.fillStyle = col; ctx.fillRect(0, 0, cssW, cssH);
      // bristle streaks trailing the front (slightly darker), give the band a dragged-paint texture
      const br = DS.makeRng(7); ctx.lineCap = 'round'; ctx.strokeStyle = deep;
      for (let i = 0; i < 22; i++) {
        const y = br() * cssH, x0 = wob(y) - bandW * (0.15 + br() * 0.8);
        ctx.lineWidth = 1.5 + br() * 4; ctx.globalAlpha = 0.25 + br() * 0.4;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(wob(y) - 3, y + (br() - 0.5) * 12); ctx.stroke();
      }
      // a glossy highlight near the leading edge (wet paint catching the light)
      ctx.globalAlpha = 0.5; ctx.strokeStyle = D.mix(col, D.COL.paper, 0.5); ctx.lineWidth = 4;
      ctx.beginPath(); for (let i = 0; i <= steps; i++) { const y = i * dy, x = wob(y) - bandW * 0.22; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); } ctx.stroke();
      ctx.restore();

      // 4) a few paint flecks flung off the leading edge (sketchy, energetic)
      const fr = DS.makeRng(31); ctx.save(); ctx.fillStyle = col;
      for (let i = 0; i < 10; i++) {
        const y = fr() * cssH, fx = wob(y) + 6 + fr() * 26 * (0.4 + e), r = 1.5 + fr() * 3.5;
        ctx.globalAlpha = (0.5 - fr() * 0.4) * (1 - Math.abs(0.5 - p) * 1.2);
        if (ctx.globalAlpha <= 0) continue;
        ctx.beginPath(); ctx.arc(fx, y, r, 0, 6.2832); ctx.fill();
      }
      ctx.restore();
    }

    _tickVictory(dt) {
      const v = this.victory; if (!v) return;
      v.t += dt;
      const w = this.winner, col = (w && w.tagCol) || D.COL.accent;
      const vw = this.view.w, vh = this.view.h, rnd = v.rnd;
      // confetti rain in the winner's colour (+ a couple of accents) — emit at a steady rate
      v.acc += dt;
      const cols = [col, D.mix(col, D.COL.paper, 0.45), D.mix(col, D.COL.ink, 0.3), D.COL.accent];
      while (v.acc > 0.02 && v.parts.length < 170) {
        v.acc -= 0.02;
        v.parts.push({
          x: rnd() * vw, y: -24 - rnd() * 60,
          vx: (rnd() - 0.5) * 90, vy: 150 + rnd() * 170,
          rot: rnd() * 6.28, vr: (rnd() - 0.5) * 9,
          w: 7 + rnd() * 9, h: 4 + rnd() * 5,
          sway: rnd() * 6.28, col: cols[(rnd() * cols.length) | 0],
        });
      }
      for (const p of v.parts) {
        p.sway += dt * 3; p.vy += 140 * dt;
        p.x += (p.vx + Math.sin(p.sway) * 46) * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      }
      if (v.parts.length) v.parts = v.parts.filter((p) => p.y < vh + 40);
    }

    _renderVictory(ctx) {
      const vw = this.view.w, vh = this.view.h, U = this._u();
      const v = this.victory || { t: 0, parts: [] }, t = v.t;
      const w = this.winner;
      const col = (w && w.tagCol) || D.COL.accent, deep = D.mix(col, D.COL.ink, 0.45);
      const cx = vw / 2, cy = vh * 0.52;

      // --- spotlight wash in the winner's colour -------------------------------------------
      const rg = ctx.createRadialGradient(cx, cy, 20, cx, cy, vh * 0.95);
      rg.addColorStop(0, D.mix(D.COL.paper, col, 0.32));
      rg.addColorStop(0.5, D.mix(D.COL.paper, col, 0.13));
      rg.addColorStop(1, D.COL.paper);
      ctx.fillStyle = rg; ctx.fillRect(0, 0, vw, vh);

      // --- slow rotating sunburst rays behind the winner -----------------------------------
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(t * 0.22);
      ctx.fillStyle = col;
      const rays = 16, R = vh * 1.2, fade = Math.min(1, t * 1.4);
      for (let i = 0; i < rays; i++) {
        ctx.save(); ctx.rotate((i / rays) * 6.2832);
        ctx.globalAlpha = (i % 2 ? 0.05 : 0.09) * fade;
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(0.11) * R, Math.sin(0.11) * R);
        ctx.lineTo(Math.cos(-0.11) * R, Math.sin(-0.11) * R);
        ctx.closePath(); ctx.fill(); ctx.restore();
      }
      ctx.restore();

      // --- the winner, big, bouncing in triumph --------------------------------------------
      if (w) {
        const pop = outBack(t * 1.5);
        const hop = Math.abs(Math.sin(t * 2.3)) * 30 * U;     // little victory hops
        const wob = Math.sin(t * 1.6) * 0.05;                  // gentle sway
        const baseY = cy + 30 * U;
        // ground shadow (squashes as it hops)
        ctx.save();
        ctx.globalAlpha = 0.16 * pop;
        ctx.fillStyle = D.COL.ink;
        ctx.beginPath();
        ctx.ellipse(cx, baseY + 96 * U, (78 - hop * 0.4) * U, (16 - hop * 0.1) * U, 0, 0, 6.2832);
        ctx.fill(); ctx.restore();
        ctx.save();
        ctx.translate(cx, baseY - hop);
        ctx.rotate(wob);
        const zoom = 4.5 * U * pop;
        ctx.scale(zoom, zoom);
        const pose = (w.ch.actions.idle && w.ch.actions.idle.pose) || (w.getPose && w.getPose());
        if (pose) DS.character.drawFighter(ctx, w.ch, pose, { facing: 1, expr: '', seed: w.pIndex * 1009 + 7 });
        ctx.restore();
      }

      // --- confetti (drawn over the character) ---------------------------------------------
      for (const p of v.parts) {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = 0.92; ctx.fillStyle = p.col;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      // --- WINNER ribbon up top (drops in) -------------------------------------------------
      const bd = outBack(Math.min(1, t * 1.3));
      ctx.save();
      ctx.translate(cx, vh * 0.15 - (1 - bd) * 160);
      ctx.rotate(-0.03);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = (88 * U) + "px 'Gloria Hallelujah', cursive";
      ctx.lineWidth = 9 * U; ctx.lineJoin = 'round'; ctx.strokeStyle = deep;
      ctx.strokeText('WINNER!', 0, 0);
      ctx.fillStyle = col; ctx.fillText('WINNER!', 0, 0);
      ctx.restore();

      // --- nameplate (pops in under the winner) --------------------------------------------
      const name = w ? ('P' + (w.pIndex + 1) + '   ' + w.name) : 'DRAW';
      const ns = outBack(Math.min(1, (t - 0.25) * 1.4)), na = Math.min(1, Math.max(0, (t - 0.25) * 2));
      ctx.save();
      ctx.globalAlpha = na; ctx.translate(cx, vh * 0.84); ctx.scale(ns, ns);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = (54 * U) + "px 'Gloria Hallelujah', cursive";
      ctx.fillStyle = deep; ctx.fillText(name, 0, 0);
      // sketchy underline in the player colour
      ctx.strokeStyle = col; ctx.lineWidth = 5 * U; ctx.lineCap = 'round';
      const uw = Math.min(vw * 0.4, ctx.measureText(name).width * 0.62);
      ctx.beginPath();
      ctx.moveTo(-uw, 30 * U); ctx.lineTo(-uw * 0.3, 34 * U); ctx.lineTo(uw * 0.3, 28 * U); ctx.lineTo(uw, 33 * U);
      ctx.stroke();
      ctx.restore();

      // --- rematch prompt (pulses, fades in last) ------------------------------------------
      ctx.save();
      ctx.globalAlpha = (0.5 + 0.45 * Math.sin(t * 3.2)) * Math.min(1, Math.max(0, t - 0.9));
      ctx.font = (26 * U) + "px 'Patrick Hand', cursive";
      ctx.fillStyle = D.COL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('press  Enter  for a rematch', cx, vh * 0.965);
      ctx.restore();
    }
  }

  DS.Game = Game;
})(window);
