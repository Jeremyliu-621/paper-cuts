// A fighter: platformer movement + Smash-style combat, rendered as a doodle.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;
  const DASH = 0.322;  // dash duration (s) — distance ∝ duration, so this travels 15% further than 0.28
  const TAPWIN = 0.26; // double-tap window (s)
  const AIM = 40;      // degrees the special tilts when up/down is held as it fires
  const LEDGE_X = 48;  // horizontal reach to grab a ledge (outside the corner)
  const LEDGE_Y = 78;  // vertical band below the top edge where a grab catches
  const MOM_FAST = 0.4; // momentum needed to count as "fast" (gates super punch / shot / ultra)
  const SPEARWIN = 0.34; // window (s) between an up-press and a jab to launch the SPEAR
  const WOLF_SIZE = 2;   // the werewolf transforms to 2x size (hurtbox, body, and its melee reach)
  const CHARGE_NEED = 75; // cumulative % damage dealt to fill the ultimate meter
  // the sniper ultimate's shot: very fast, long, hard-hitting
  const SNIPER_SHOT = { speed: 2400, damage: 42, kbBase: 46, kbScale: 0.18, angle: 0, gravity: 0, life: 0.9, r: 48, sniper: true, ult: true };

  function clonePose(p) {
    return { lean: p.lean, headX: p.headX, headY: p.headY, squash: p.squash,
      armFront: Object.assign({}, p.armFront), armBack: Object.assign({}, p.armBack),
      legFront: Object.assign({}, p.legFront), legBack: Object.assign({}, p.legBack) };
  }

  class Fighter {
    constructor(char, data, pIndex, stage, spawnPt) {
      // char is a roster name (looked up in data.characters) or a built {name, ch} variant
      if (typeof char === 'string') { this.name = char; this.ch = data.characters[char]; }
      else { this.name = char.name; this.ch = char.ch; }
      this.pIndex = pIndex;
      this.scale = (this.ch.stats.scale) || 1;
      this.w = 42 * this.scale; this.h = 74 * this.scale;
      // spawn point: the one the Game assigned (spread for 3–6 players), else the map's
      this._spawnPt = spawnPt || ((stage || data.stage).spawns || [])[pIndex];
      this.reset(data);
    }
    reset(data) {
      const sp = this._spawnPt || data.stage.spawns[this.pIndex] || { x: 400 + this.pIndex * 400, y: 400 };
      this.x = sp.x; this.y = sp.y; this.vx = 0; this.vy = 0;
      this.facing = this.pIndex === 0 ? 1 : -1;
      this.onGround = false; this.ground = null;
      this.jumps = this.ch.stats.maxJumps;
      this.damage = 0; this.stocks = data.settings.stocks;
      this.action = null; this.hitstun = 0; this.shielding = false; this.crouching = false;
      this.invuln = 1.0; this.respawnT = 0; this.dead = false;
      this.heldProp = null; // a picked-up drawn item (DS.Prop); fire it with the attack button
      // item FINISHER: the FIRST item you ever pick up imprints a Pika KO video (see prop.js / finishers.js).
      this.hasPickedUpItem = false;  // one-shot: only the first pickup arms a finisher
      this.finisherItem = null;      // { label, element }
      this.finisherCacheKey = null;  // key into ch.finisher.clips once the job is created
      this.finisherClip = null;      // resolved {videoUrl,...} once the video is buffered
      this.finisherReady = false;    // true once buffered -> green aura
      this.finisherUsed = false;     // spent after one elimination
      this.dropPlat = null; this.dropTimer = 0;
      this.animPhase = Math.random() * 6; this.blinkTimer = 1 + Math.random() * 3; this.blinkUntil = 0;
      this.expr = '';
      // double-tap dash
      this.dashT = 0; this.dashDir = 1; this._clock = 0; this.lastLeftPress = -1; this.lastRightPress = -1;
      this.airDashUsed = false; this._dashPuffT = 0;
      this.lastUpPress = -1; this.airSpearUsed = false; // rising-spear gate (one per airtime)
      this.aimHold = 0; // live up/down aim during the ranged special (degrees, + = up)
      this.specialCd = 0; // ranged-special cooldown timer (melee jab stays uncapped)
      this.ledge = null; this.ledgeCd = 0; this.ledgeLock = 0; // ledge-hang state
      this._portalCd = 0; // teleport cooldown so portals don't ping-pong
      this.lastHitBy = null; // most recent attacker, for KO attribution (score modes)
      this.lastHitWasUltimate = false;
      this.item = null;      // held power-up prop (set by a mode): { key, name, left, action }. F uses it.
      // combo + HUD juice: combo = current chain landed, comboT = window left to extend it,
      // comboFlash pops the badge on each hit, hitFlash punches the % when you take a big hit
      this.combo = 0; this.comboT = 0; this.comboFlash = 0; this.hitFlash = 0;
      this.hitTilt = 0; this.hitTiltV = 0; // knocked-off-balance lean (springs back upright)
      this.momentum = 0; // 0..1 stored momentum: full on a dash, sustained by a jump, decays
      this.attackCd = 0; // melee (attack-button) cooldown so the jab can't be machine-gunned
      // ultimate: charge fills from damage dealt; once full (lines turn blue) double-tap G
      this.charge = 0; this.ult = null; this.lastGPress = -1; this.aimAngle = 0;
      this._wasReady = false; this._burstT = 0; // ult-ready bloom (drawn attached to the body)
      // ultType is the chosen ultimate ('hammer'|'sniper'|'werewolf'), set per match; keep across resets
      if (this.ultType == null) this.ultType = 'hammer';
    }

    // dataOverride lets a power-up prop supply its own move data (held items) without
    // touching the character's action table; everything downstream reads action.data.
    _startAction(name, dataOverride) {
      const d = dataOverride || this.ch.actions[name];
      if (!d || (!d.hit && !d.projectile && !d.boomerang)) return;
      // attacks no longer pause/cancel movement or the dash — you keep all momentum,
      // which is what makes a dash-in attack hit harder (see _takeHit)
      this.action = { name, t: 0, data: d, hits: new Set(), fired: false };
      // a meteor slam (the air hammer) dives the attacker downward for the slam
      if (d.meteor) { this.vy = Math.max(this.vy, 320); this.vx += this.facing * 110; this._slamY = this.y; }
      // a rising spear ROCKETS the attacker upward — fast, well past a jump — spent for this airtime
      if (d.lunge) { this.vy = -this.ch.stats.jumpVel * 1.56; this.vx += this.facing * 80; this.airSpearUsed = true; }
      // SFX: the swing/cast — a melee whoosh now, or (for a ranged move with real wind-up) a
      // rising charge sized to the startup so the shot lands on its own active frame.
      if (DS.Audio) {
        if (d.projectile || d.boomerang) { if (!d.ult && d.startup >= 8) DS.Audio.play('charge_up', { x: this.x, dur: d.startup / 60 }); }
        else if (d.hit) {
          const sw = name === 'hammer' || name === 'bat' ? 'swing_hammer' : (name === 'superpunch' || name === 'ultrapunch') ? 'swing_punch'
            : name === 'spear' ? 'swing_punch' : name === 'wolfslash' ? 'swing_wolf' : name === 'clawswipe' ? 'swing_claw' : 'swing_jab';
          DS.Audio.play(sw, { x: this.x });
        }
      }
    }

    // use a held power-up prop: its move replaces this fighter's attack (F). Reuses the normal
    // action machinery via a data override, decrements the prop's remaining uses, drops it at 0.
    _useItem(world) {
      const it = this.item, d = it.action;
      this._startAction(d.name, d);
      if (!this.action) return;              // safety: malformed prop, keep the item
      this.attackCd = d.cooldown || 0.4;
      it.left -= 1;
      if (it.left <= 0) { this.item = null; if (world.effects) world.effects.dust(this.x, this.y, this.facing); }
    }
    // "fast" now means real MOMENTUM (built by dashing, sustained by a jump) — not just
    // walking at run speed. plain running no longer triggers the speed moves.
    _fast() { return this.dashT > 0 || this.momentum > MOM_FAST; }
    // a jump carries existing momentum into the air (so dash→jump stays fast); never grants it
    _carryMomentum() { if (this.momentum > 0.05) this.momentum = Math.max(this.momentum, 0.85); }
    // pick which melee comes out of the attack button, by state (contextual attacks)
    _pickAttack() {
      if (!this.onGround) {
        // up-press + jab in quick succession → SPEAR up (once per airtime, any velocity);
        // any other air jab → HAMMER down
        const upRecent = (this._clock - this.lastUpPress) < SPEARWIN;
        return (upRecent && !this.airSpearUsed) ? 'spear' : 'hammer';
      }
      if (this._fast()) return 'superpunch';      // momentum → super punch
      return 'attack';
    }
    // pick which special comes out, by state: only with momentum does it upgrade —
    // close range → ultra punch (melee), far → super shot (ranged); else the normal shot
    _pickSpecial(world) {
      if (!this._fast()) return 'special';
      let near = Infinity;
      for (const o of world.opponents(this)) {
        if (o.dead || o.respawnT > 0) continue;
        near = Math.min(near, Math.hypot(o.x - this.x, o.y - this.y));
      }
      return near < 110 ? 'ultrapunch' : 'supershot';
    }

    _ultReady() { return this.charge >= 1 && !this.ult; }
    // fire the chosen ultimate (called on a double-tap of G when charged)
    _activateUlt(world) {
      // the FIRST tap of the double-tap already fired a normal special — clear our in-flight
      // shots so they don't interfere with the ultimate
      if (world.game && world.game.projectiles) {
        world.game.projectiles = world.game.projectiles.filter((pr) => pr.owner !== this);
      }
      if (DS.Audio) DS.Audio.play(this.ultType === 'sniper' ? 'ult_sniper' : this.ultType === 'werewolf' ? 'ult_wolf' : 'ult_hammer', { x: this.x });
      if (this.ultType === 'hammer') {
        this.charge = 0;
        this._startAction('ulthammer');
        world.effects.shake(0.4); world.effects.charge(this.x, this.y - 6, this.tagCol); // a flash of power as it winds up
      } else if (this.ultType === 'sniper') {
        this.charge = 0; this.action = null;
        // enter the frozen aiming stance; aim starts pointing the way you face
        this.ult = { type: 'sniper', t: 0, aim: this.facing > 0 ? 0 : Math.PI };
        world.effects.charge(this.x, this.y - 6, this.tagCol);
      } else if (this.ultType === 'werewolf') {
        this.charge = 0; this.action = null;
        this.ult = { type: 'werewolf', t: 0, dur: 9, paw: 1 }; // dur extends as it deals damage
        this._setSize(WOLF_SIZE); // grow to a 3x beast (feet stay planted)
        world.effects.charge(this.x, this.y - 6, this.tagCol); world.effects.shake(0.5);
      }
    }
    // grow/shrink the hurtbox around the feet (so a transform doesn't pop us through the floor)
    _setSize(mult) {
      const bw = 42 * this.scale, bh = 74 * this.scale, newH = bh * mult;
      this.y -= (newH - this.h) / 2; // keep the bottom edge (feet) where it was
      this.w = bw * mult; this.h = newH;
    }
    _wolfSize() { return (this.ult && this.ult.type === 'werewolf') ? WOLF_SIZE : 1; }
    // buffed stats while transformed: faster, 5 air jumps (→ 5 dashes), snappier
    _wolfStats(s) {
      return Object.assign({}, s, {
        runSpeed: s.runSpeed * 1.32, airSpeed: s.airSpeed * 1.32, dashSpeed: s.dashSpeed * 1.15,
        accel: s.accel * 1.25, airAccel: s.airAccel * 1.3, maxJumps: 6,
        jumpVel: s.jumpVel * 1.35, doubleJumpVel: s.doubleJumpVel * 1.35, // springy beast — leaps higher
      });
    }

    // sniper aim stance: frozen in place, full 360° WASD aiming, G fires, F cancels (+ a jab)
    _updateSniper(dt, input, world) {
      const u = this.ult;
      u.t += dt;
      this.vx = 0; this.vy = 0; this.hitstun = 0; // hold position while aiming
      // WASD aim the full circle: the held direction(s) set a target the aim snaps toward fast
      const dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      const dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
      if (dx || dy) {
        const target = Math.atan2(dy, dx);
        const d = Math.atan2(Math.sin(target - u.aim), Math.cos(target - u.aim)); // shortest turn
        u.aim += d * Math.min(1, dt * 11);
      }
      this.facing = Math.cos(u.aim) >= 0 ? 1 : -1;
      if (input.pressSpecial && u.t > 0.12) {           // G fires the shot along the aim
        if (world.spawnProjectileAt) world.spawnProjectileAt(this, SNIPER_SHOT, u.aim);
        world.effects.shake(0.5); world.effects.smear(this.x, this.y, Math.cos(u.aim) * 600, Math.sin(u.aim) * 600);
        this.ult = null; this.specialCd = 0.4;
      } else if (input.pressAttack) {                   // F cancels — and jabs as you do
        this.ult = null; this._startAction('attack'); this.attackCd = 0.26;
      } else if (u.t > 6) { this.ult = null; }          // safety: don't let it stall forever
    }

    _startDash(dir, world) {
      this.dashDir = dir; this.dashT = DASH; this.facing = dir;
      this.vx = dir * this.ch.stats.dashSpeed; this.vy = 0; this._dashPuffT = 0;
      if (!this.onGround) this.airDashUsed = true;
      // kick-off smoke behind the dash
      world.effects.dust(this.x - dir * 8, this.y + this.h / 2, -dir);
      world.effects.dust(this.x - dir * 16, this.y + this.h / 3, -dir);
      if (DS.Audio) DS.Audio.play('dash', { x: this.x });
    }

    // ---- ledge hang & recovery (Smash-style) ----
    _tryLedgeGrab(world) {
      for (const p of world.platforms) {
        if (p.pass) continue; // only the solid stage's outer corners are grabbable
        const inBandY = this.y > p.y - 24 && this.y < p.y + LEDGE_Y;
        if (!inBandY) continue;
        if (this.x < p.x && this.x > p.x - LEDGE_X) { this._grabLedge(p, 'left', p.x, p.y); return; }
        const rx = p.x + p.w;
        if (this.x > rx && this.x < rx + LEDGE_X) { this._grabLedge(p, 'right', rx, p.y); return; }
      }
    }
    _grabLedge(p, side, cx, cy) {
      this.ledge = { plat: p, side, x: cx, y: cy };
      this.ledgeLock = 0.14;
      const toStage = side === 'left' ? 1 : -1;
      this.facing = toStage;
      this.x = cx - toStage * (this.w * 0.45);
      this.y = cy + this.h * 0.42;
      this.vx = 0; this.vy = 0; this.onGround = false; this.action = null; this.dashT = 0;
      this.jumps = this.ch.stats.maxJumps; this.airDashUsed = false; // recovery resources back
      this.invuln = Math.max(this.invuln, 0.4);                       // brief safety on grab
      if (DS.Audio) DS.Audio.play('ledge', { x: this.x });
    }
    _releaseLedge(cd) { this.ledge = null; this.ledgeCd = cd; this.ledgeLock = 0; }
    _updateLedge(dt, input, world, s) {
      const L = this.ledge, toStage = L.side === 'left' ? 1 : -1;
      // stay pinned to the corner, facing the stage
      this.facing = toStage; this.vx = 0; this.vy = 0; this.hitstun = 0;
      this.x = L.x - toStage * (this.w * 0.45); this.y = L.y + this.h * 0.42;
      if (this.ledgeLock > 0) { this.ledgeLock -= dt; return; } // brief guaranteed hang
      const towardHeld = toStage > 0 ? input.right : input.left;
      const awayHeld = toStage > 0 ? input.left : input.right;
      if (input.pressUp) {
        this.vy = -s.jumpVel; this.vx = toStage * s.airSpeed * 0.5; this.jumps = s.maxJumps - 1;
        this.onGround = false; world.effects.dust(this.x, this.y + this.h / 2, toStage); this._releaseLedge(0.3);
        if (DS.Audio) DS.Audio.play('jump', { x: this.x });
      } else if (towardHeld) {
        // climb up onto the platform
        this.x = L.x + toStage * (this.w * 0.5 + 8); this.y = L.plat.y - this.h / 2 - 1;
        this.onGround = true; this.ground = L.plat; this.jumps = s.maxJumps;
        world.effects.dust(this.x, this.y + this.h / 2, 0); this._releaseLedge(0.2);
      } else if (input.down || awayHeld) {
        this.vy = 50; this._releaseLedge(0.4);
      }
    }

    _updateAction(dt, world, input) {
      const a = this.action, d = a.data;
      if (a.faceLock) this.facing = a.faceLock; // octagon special: keep firing the pressed way
      const startup = d.startup / 60, active = d.active / 60, total = (d.startup + d.active + d.recovery) / 60;
      // (no movement damping — attacks never slow you down; momentum is kept on purpose)
      // live aim for a ranged move: tracks held up/down the whole move (drives the throw pose)
      if (d.projectile || d.boomerang) this.aimHold = input && input.up ? AIM : input && input.down ? -AIM : 0;
      if (a.t >= startup && a.t < startup + active) {
        if (d.boomerang) {
          if (!a.fired && world.spawnBoomerang) { a.fired = true; world.spawnBoomerang(this, d.boomerang, this.aimHold); }
        } else if (d.projectile) {
          // fire once at the start of the active window, at the current aim. a prop with
          // `pellets` fans out a spread (shotgun); otherwise it's a single shot.
          if (!a.fired && world.spawnProjectile) {
            a.fired = true;
            const pellets = d.pellets || 1;
            for (let k = 0; k < pellets; k++) {
              const off = pellets > 1 ? (k - (pellets - 1) / 2) * (d.spread || 8) : 0;
              world.spawnProjectile(this, d.projectile, (this.aimHold || 0) + off);
            }
            if (a.name === 'supershot') world.effects.dust(this.x + this.facing * 46, this.y, this.facing); // muzzle puff
          }
        } else if (d.hit) {
          let h = d.hit;
          // the hammer's damage scales with how far it fell — NO cap, so a big committed dive
          // really pays off (a short hop stays jab-ish, a screen-high drop hits hard)
          if (d.meteor) {
            const fallen = Math.max(0, this.y - (this._slamY != null ? this._slamY : this.y));
            h = Object.assign({}, h, { damage: 6 + (fallen / 240) * 3 });
          }
          // the 3x werewolf's reach + AOE scale with its body so the hitbox matches the big model
          const sz = this._wolfSize();
          if (sz !== 1) h = Object.assign({}, h, { x: h.x * sz, y: h.y * sz, r: h.r * sz });
          const hx = this.x + h.x * this.facing, hy = this.y + h.y;
          for (const opp of world.opponents(this)) {
            if (opp.dead || opp.respawnT > 0 || opp.invuln > 0 || a.hits.has(opp)) continue;
            const cx = Math.max(opp.x - opp.w / 2, Math.min(hx, opp.x + opp.w / 2));
            const cy = Math.max(opp.y - opp.h / 2, Math.min(hy, opp.y + opp.h / 2));
            if ((cx - hx) ** 2 + (cy - hy) ** 2 <= h.r * h.r) {
              a.hits.add(opp);
              opp._takeHit(h, this.facing, this, world);
              if (d.ult) { world.effects.ultHit(opp.x, opp.y, 1.4, this.tagCol); world.effects.hitstop(0.12); if (DS.Audio) DS.Audio.play('ult_hit', { x: opp.x }); } // satisfying ult connect
            }
          }
          // melee also smashes breakable crates/structures within reach (once each)
          const plats = world.stage ? world.stage.platforms : [];
          for (const p of plats) {
            if (p._hp == null || a.hits.has(p)) continue;
            const bx = Math.max(p.x, Math.min(hx, p.x + p.w));
            const by = Math.max(p.y, Math.min(hy, p.y + p.h));
            if ((bx - hx) ** 2 + (by - hy) ** 2 <= h.r * h.r) {
              a.hits.add(p);
              if (world.damageBox) world.damageBox(p, h.damage);
            }
          }
        }
      }
      // the air HAMMER hangs at the slam (hitbox live, hammer held down) until you touch the
      // ground — then it runs out its recovery and ends. otherwise advance/end normally.
      if (d.meteor && !this.onGround) {
        a.t = Math.min(a.t + dt, startup + active - 1e-4);
      } else {
        if (a.t >= total) this.action = null;
        a.t += dt;
      }
    }

    _takeHit(hit, atkFacing, attacker, world) {
      const set = world.settings;
      if (this.shielding) {
        this.vx += atkFacing * (hit.kbBase + 4) * 3;
        world.effects.impact(this.x + atkFacing * 22, this.y, 0.4);
        world.effects.hitstop(0.04 * set.hitstop);
        if (DS.Audio) DS.Audio.play('block', { x: this.x });
        return;
      }
      // getting hit breaks YOUR own combo
      this.combo = 0; this.comboT = 0;
      // credit the attacker's chain and scale the % dealt by it: the longer the combo,
      // the more damage each hit lands (up to +80% at a ~7-hit chain). movement still
      // drives the chain (you must keep landing hits within the window to keep it alive).
      let comboMul = 1;
      if (attacker && attacker !== this) {
        this.lastHitBy = attacker;
        this.lastHitWasUltimate = !!(hit.ult
          || (attacker.action && attacker.action.data && attacker.action.data.ult)
          || (attacker.ult && attacker.ult.type === 'werewolf'));
        attacker.combo += 1; attacker.comboT = 1.1; attacker.comboFlash = 0.5;
        comboMul = 1 + Math.min(0.8, (attacker.combo - 1) * 0.12);
      }
      let dealt = hit.damage * comboMul;
      // werewolf hits deal a bit more, drain the wolf's OWN % (knockback), and extend its timer
      if (attacker && attacker.ult && attacker.ult.type === 'werewolf') {
        dealt *= 1.3;
        attacker.damage = Math.max(0, attacker.damage - dealt * 0.6);
        attacker.ult.dur += dealt * 0.05;
      }
      this.damage += dealt;
      // the attacker charges their ultimate by the % they deal (full at CHARGE_NEED)
      if (attacker && attacker !== this) {
        const wasFull = attacker.charge >= 1;
        attacker.charge = Math.min(1, attacker.charge + dealt / CHARGE_NEED);
        if (!wasFull && attacker.charge >= 1 && DS.Audio) DS.Audio.play('charge_ready', { x: attacker.x }); // ultimate just filled
      }
      const weight = this.ch.stats.weight || 1;
      let launch = (hit.kbBase * 8 + this.damage * hit.kbScale * 62) * set.knockbackScale;
      // momentum: charging in (dash or run) toward the target adds knockback — a *slight*
      // speed bonus so running jabs still combo and a committed dash-in is the finisher
      // (Minecraft sprint-hit / W-tap). tune this multiplier to taste.
      if (attacker) { const into = attacker.vx * atkFacing; if (into > 0) launch += into * 0.35; }
      launch /= weight;
      // a transformed werewolf is a heavy beast — it shrugs off a chunk of the knockback
      if (this.ult && this.ult.type === 'werewolf') launch *= 0.55;
      const ang = (hit.angle || 0) * Math.PI / 180; // guard: a missing angle must not NaN the velocity
      this.vx = Math.cos(ang) * atkFacing * launch;
      this.vy = -Math.sin(ang) * launch - 90;
      // Smash-style lift: a hit doesn't just shove you straight back, it pops you UP a bit too,
      // scaling with the launch — but NOT for downward spikes (the hammer meteor stays a spike)
      if ((hit.angle || 0) >= 0) this.vy -= launch * 0.5;
      // Minecraft 1.8.9 feel: a light hit is *pure knockback* — you slide back but keep
      // full control (no freeze), so W-tapping / counter-hits / trades work. Hitstun only
      // kicks in above STUN_FLOOR, so the dash-in finisher and high-% hits still combo.
      const STUN_FLOOR = 120;
      this.hitstun = launch <= STUN_FLOOR ? 0 : Math.min(1.1, (launch - STUN_FLOOR) * 0.002);
      this.hitFlash = Math.min(1, 0.45 + launch / 650); // punch the % readout (bigger hit = bigger pop)
      // knocked off-balance: lean in the direction you're sent. hit from the LEFT (atkFacing +1)
      // sends you right → "/" lean; hit from the RIGHT → "\" lean. scales with the hit, then springs upright.
      this.hitTilt = atkFacing * Math.min(0.6, 0.2 + launch / 900);
      this.hitTiltV = 0;
      this.onGround = false; this.shielding = false;
      if (this.hitstun > 0) this.action = null; // a no-stun light hit doesn't interrupt your swing (clean trades)
      this.facing = -atkFacing;
      const power = Math.min(1.7, 0.4 + launch / 680);
      world.effects.impact(this.x + atkFacing * 14, this.y - 6, power);
      if (DS.Audio) {
        // the hard-to-land hits get the meaty cues: a projectile connect (hit carries a `speed`)
        // splats; a hammer meteor slam thwacks even though its knockback is intentionally low.
        const meteor = attacker && attacker.action && attacker.action.data && attacker.action.data.meteor;
        const cue = hit.speed != null ? 'hit_proj' : (meteor || power > 0.95) ? 'hit_heavy' : 'hit_light';
        DS.Audio.play(cue, { x: this.x, power: meteor ? Math.max(power, 1.1) : power });
      }
      world.effects.shake(Math.min(0.7, 0.14 + launch / 2400));
      world.effects.hitstop(Math.min(0.13, 0.03 + launch / 8500) * set.hitstop);
      world.effects.smear(this.x, this.y, this.vx, this.vy);
      world.effects.floatText(this.x, this.y - this.h / 2 - 12, Math.round(this.damage) + '%');
    }

    _ko(world) {
      if (world.game && world.game.tryStartFinisher && world.game.tryStartFinisher(this, world)) return;
      this._completeKO(world);
    }

    _completeKO(world) {
      // anchor the blast AT the blast border the fighter crossed (clamp to the blast
      // bounds, not the stage edge) so the flame originates from the boundary, then jets
      // OUTWARD along the launch — the fighter blazing off through the border.
      const bb = world.blast || set.blast;
      const cx = Math.max(bb.left, Math.min(bb.right, this.x));
      const cy = Math.max(bb.top, Math.min(bb.bottom, this.y));
      const sp = Math.hypot(this.vx, this.vy);
      const ang = (sp > 5 ? Math.atan2(this.vy, this.vx)
        : Math.atan2(cy - world.view.h / 2, cx - world.view.w / 2)) + Math.PI;
      world.effects.koBeam(cx, cy, ang, Math.min(2.0, 0.7 + sp / 850));
      world.effects.koBurst(cx, cy);
      if (DS.Audio) DS.Audio.play('ko', { x: cx });
      this.action = null; this.hitstun = 0; this.vx = 0; this.vy = 0;
      this.combo = 0; this.comboT = 0; this.hitFlash = 0;
      this.item = null; // you drop your power-up when you're KO'd
      const mode = world.game && world.game.mode;
      // let the mode score the knockout (e.g. credit the last attacker) before respawn
      if (mode && mode.onKO) mode.onKO(world.game, this);
      const elimination = mode ? mode.elimination : true;
      if (elimination) {
        this.stocks -= 1;
        if (this.stocks <= 0) { this.dead = true; if (world.onChange) world.onChange(); }
        else { this.respawnT = 0.8; this.damage = 0; if (world.onChange) world.onChange(); }
      } else {
        // non-elimination modes (KotH / Gems / K.O. Rush): infinite respawns
        this.respawnT = 0.8; this.damage = 0;
      }
      this.lastHitBy = null;
      this.lastHitWasUltimate = false;
    }

    _respawn(world) {
      // drop back in above this fighter's own spawn (so 3–6 players don't stack on respawn)
      const sp = this._spawnPt || { x: world.view.w / 2, y: 200 };
      this.x = sp.x; this.y = sp.y - 220; this.vx = 0; this.vy = 0; this.onGround = false;
      this.jumps = this.ch.stats.maxJumps; this.invuln = 1.4; this.facing = this.x < world.view.w / 2 ? 1 : -1;
    }

    update(dt, input, world) {
      if (this.dead) return;
      if (this.invuln > 0) this.invuln -= dt;
      if (this.specialCd > 0) this.specialCd -= dt;
      if (this.attackCd > 0) this.attackCd -= dt;
      if (this.comboT > 0) { this.comboT -= dt; if (this.comboT <= 0) this.combo = 0; } // chain times out
      if (this.comboFlash > 0) this.comboFlash -= dt;
      if (this.hitFlash > 0) this.hitFlash -= dt;
      // off-balance lean springs back toward upright (underdamped → a little wobble)
      if (this.hitTilt || this.hitTiltV) {
        this.hitTiltV += (-150 * this.hitTilt - 14 * this.hitTiltV) * dt;
        this.hitTilt += this.hitTiltV * dt;
        if (Math.abs(this.hitTilt) < 0.002 && Math.abs(this.hitTiltV) < 0.02) { this.hitTilt = 0; this.hitTiltV = 0; }
      }
      if (this.respawnT > 0) {
        this.respawnT -= dt;
        if (this.respawnT <= 0) this._respawn(world);
        return;
      }
      let s = this.ch.stats; const set = world.settings;
      if (this.ledgeCd > 0) this.ledgeCd -= dt;
      // fully charged & not yet unleashed → wisp energy off the body so it's obvious you can ult
      const ready = this._ultReady();
      if (ready && !this._wasReady) this._burstT = 0.45; // subtle pop the instant it charges (drawn ON the body)
      this._wasReady = ready;
      if (this._burstT > 0) this._burstT -= dt;
      if (ready) {
        this._auraT = (this._auraT || 0) - dt;
        if (this._auraT <= 0) { world.effects.aura(this.x, this.y - 8, this.tagCol); this._auraT = 0.05; }
      }
      // werewolf: a timed transform that buffs stats (doesn't take over input) — ends on a timer
      if (this.ult && this.ult.type === 'werewolf') {
        this.ult.t += dt;
        if (this.ult.t >= this.ult.dur) { this.ult = null; this._setSize(1); world.effects.charge(this.x, this.y - 6, this.tagCol); }
        else s = this._wolfStats(s);
      }

      // hanging on a ledge: pinned, with recovery options (jump up / climb on / drop off)
      if (this.ledge) {
        this._updateLedge(dt, input, world, s);
        this.animPhase += dt * 4;
        this.blinkTimer -= dt; if (this.blinkTimer <= 0) { this.blinkTimer = 2 + Math.random() * 2.6; this.blinkUntil = 0.12; }
        if (this.blinkUntil > 0) this.blinkUntil -= dt;
        this.expr = ''; this.shielding = false; this.crouching = false;
        return;
      }

      // sniper ultimate: frozen aiming stance takes over input until you fire or cancel
      if (this.ult && this.ult.type === 'sniper') {
        this._updateSniper(dt, input, world);
        this.animPhase += dt * 3;
        this.blinkTimer -= dt; if (this.blinkTimer <= 0) { this.blinkTimer = 2 + Math.random() * 2.6; this.blinkUntil = 0.12; }
        if (this.blinkUntil > 0) this.blinkUntil -= dt;
        this.expr = ''; this.shielding = false; this.crouching = false;
        return;
      }

      const controllable = this.hitstun <= 0;
      this.shielding = false; this.crouching = false;
      let moveDir = 0;

      // double-tap left/right to dash (works mid-swing too; just not while already dashing)
      this._clock += dt;
      if (controllable && this.dashT <= 0) {
        const canDash = this.onGround || !this.airDashUsed;
        if (input.pressLeft) { if (this._clock - this.lastLeftPress < TAPWIN && canDash) this._startDash(-1, world); this.lastLeftPress = this._clock; }
        if (input.pressRight) { if (this._clock - this.lastRightPress < TAPWIN && canDash) this._startDash(1, world); this.lastRightPress = this._clock; }
        // explicit dash command (phone controller flick) — same rules, no double-tap needed
        if (input.dash && canDash) this._startDash(input.dash < 0 ? -1 : 1, world);
      }

      // movement runs every frame — attacking never locks it (Minecraft-like fluidity)
      if (controllable) {
        // record EVERY up-press (works across the dash-jump and normal-jump paths below) so a
        // quick jab after any jump becomes a SPEAR; the once-per-airtime gate prevents fly-spam
        if (input.pressUp) this.lastUpPress = this._clock;
        if (this.onGround && input.shield) {
          if (!this.shielding && DS.Audio) DS.Audio.play('shield', { x: this.x }); // raise (rising edge only)
          this.shielding = true; this.dashT = 0;
          this.vx -= this.vx * Math.min(1, dt * 18);
        } else if (this.dashT > 0) {
          // dashing: committed burst easing down to run speed; stays flat (incl. air dash)
          this.dashT -= dt;
          this.momentum = 1; // a dash charges momentum to full
          const k = Math.max(0, this.dashT / DASH);
          this.vx = this.dashDir * (s.runSpeed + (s.dashSpeed - s.runSpeed) * k);
          this.vy *= (1 - Math.min(1, dt * 12));
          if (!(this.action && this.action.faceLock)) this.facing = this.dashDir;
          this._dashPuffT -= dt;
          if (this._dashPuffT <= 0) { world.effects.dust(this.x - this.dashDir * 14, this.y + this.h / 2, -this.dashDir); this._dashPuffT = 0.04; }
          if (input.pressUp) {
            // only a REAL jump cancels the dash / refreshes the air-dash — otherwise spamming
            // jump+dash with no jumps left would reset the air-dash forever (infinite flight)
            let jumped = false;
            if (this.onGround) { this.vy = -s.jumpVel; this.jumps = s.maxJumps - 1; this.onGround = false; jumped = true; }
            else if (this.jumps > 0) { this.vy = -s.doubleJumpVel; this.jumps--; jumped = true; }
            if (jumped) { this.airDashUsed = false; this.dashT = 0; this._carryMomentum(); world.effects.dust(this.x, this.y + this.h / 2, this.dashDir); if (DS.Audio) DS.Audio.play('jump', { x: this.x, i: this.onGround ? 0 : 1 }); }
          }
        } else {
          if (input.left) moveDir = -1; else if (input.right) moveDir = 1;
          if (moveDir !== 0 && !(this.action && this.action.faceLock)) this.facing = moveDir;
          // momentum grants a brief marginal speed boost (so a dash carries a little after it)
          const boost = 1 + 0.22 * this.momentum;
          const maxv = (this.onGround ? s.runSpeed : s.airSpeed) * boost;
          const acc = this.onGround ? s.accel : s.airAccel;
          if (moveDir !== 0) {
            this.vx += moveDir * acc * dt;
            this.vx = Math.max(-maxv, Math.min(maxv, this.vx));
          } else if (this.onGround) {
            const f = s.friction * dt;
            this.vx = Math.abs(this.vx) <= f ? 0 : this.vx - Math.sign(this.vx) * f;
          }
          if (this.onGround && input.down && moveDir === 0) this.crouching = true;
          if (input.pressUp) {
            if (this.onGround) { this.vy = -s.jumpVel; this.jumps = s.maxJumps - 1; this.onGround = false; this.airDashUsed = false; this._carryMomentum(); world.effects.dust(this.x, this.y + this.h / 2, 0); if (DS.Audio) DS.Audio.play('jump', { x: this.x }); }
            else if (this.jumps > 0) { this.vy = -s.doubleJumpVel; this.jumps--; this.airDashUsed = false; this._carryMomentum(); world.effects.dust(this.x, this.y, moveDir); if (DS.Audio) DS.Audio.play('jump', { x: this.x, i: 1 }); }
          }
          if (input.pressDown && this.onGround && this.ground && this.ground.pass) {
            this.dropPlat = this.ground; this.dropTimer = 0.2; this.y += 5; this.onGround = false;
            if (DS.Audio) DS.Audio.play('drop', { x: this.x });
          }
        }
        // attacks fire instantly with zero startup and no movement lock — works while
        // running, dashing, or airborne (dash-in attacks carry momentum -> big knockback).
        // which move comes out depends on state (see _pickAttack / _pickSpecial).
        const wolf = this.ult && this.ult.type === 'werewolf';
        if (!this.shielding) {
          // a held drawn item (DS.Prop) fires on the attack button and consumes that press,
          // so the normal melee doesn't also come out while you're carrying a weapon.
          if (this.heldProp && input.pressAttack) {
            this.heldProp.fire(world, this.aimHold || 0);
            input = Object.assign({}, input, { pressAttack: false });
          }
          if (input.pressAttack && this.attackCd <= 0) {
            if (this.item) {
              this._useItem(world);          // a held prop hijacks your next F (bat / blaster / bomb …)
            } else if (wolf) {
              // the werewolf KEEPS the spear (up+jab dash-up); otherwise its alternating-paw flurry
              const upRecent = (this._clock - this.lastUpPress) < SPEARWIN;
              if (!this.onGround && upRecent && !this.airSpearUsed) { this._startAction('spear'); this.attackCd = 0.2; }
              else { this._startAction('clawswipe'); this.ult.paw *= -1; this.attackCd = 0.11; } // alternating paws (fast flurry)
            } else {
              const name = this._pickAttack();
              this._startAction(name);
              const d = this.ch.actions[name];
              this.attackCd = (d && d.cooldown) || 0.26; // paced jab (and the contextual melees)
            }
          } else if (wolf) {
            if (input.pressSpecial && this.specialCd <= 0) { this._startAction('wolfslash'); this.specialCd = 0.55; } // big AOE slash
          } else if (input.pressSpecial) {
            // octagon special pad (phone): pressing the left/right side aims the shot that way
            // regardless of which way you're looking — turn to fire in the chosen direction.
            if (input.specialDir) this.facing = input.specialDir;
            // double-tap G fires the charged ULTIMATE; a single G is the normal special
            const dbl = this._clock - this.lastGPress < TAPWIN;
            this.lastGPress = this._clock;
            if (this._ultReady() && dbl) {
              this._activateUlt(world);
            } else if (this.specialCd <= 0) {
              const name = this._pickSpecial(world);
              this._startAction(name);
              // octagon aim: lock facing to the pressed side for the WHOLE move, so a held
              // direction (or a dash) can't flip it back during a startup before the shot fires
              if (input.specialDir && this.action) this.action.faceLock = input.specialDir;
              const d = this.ch.actions[name]; // any special-button move shares the cooldown
              this.specialCd = (d && d.projectile && d.projectile.cooldown) || (d && d.cooldown) || 1.25;
            }
          }
        }
      }

      // run the active swing's hitbox / projectile in parallel, AFTER the triggers above,
      // so a just-pressed Special fires this very frame (no wind-up delay)
      if (this.action) this._updateAction(dt, world, input);

      // gravity (suspended during a dash so it stays flat, including in the air)
      if (!this.onGround && this.dashT <= 0) {
        this.vy += set.gravity * s.gravityScale * dt;
        const cap = input.down ? s.fastFallSpeed : s.fallSpeed;
        if (this.vy > cap) this.vy = cap;
      }
      if (this.dropTimer > 0) { this.dropTimer -= dt; if (this.dropTimer <= 0) this.dropPlat = null; }

      const wasAir = !this.onGround, impactVy = this.vy;
      const res = DS.physics.step(this, world.platforms, dt, { dropThru: this.dropPlat });
      this.onGround = res.onGround; this.ground = res.ground;
      // trampoline: landing on a bouncy platform launches you back up instead of stopping —
      // the harder you come down, the higher you go (Smash-trampoline feel), with a floor.
      if (this.onGround && res.ground && res.ground.bounce) {
        this.vy = -Math.max(res.ground.bounce, Math.abs(impactVy) * 1.08);
        this.onGround = false; this.ground = null;
        this.jumps = s.maxJumps; this.airDashUsed = false; this.airSpearUsed = false;
        world.effects.dust(this.x, this.y + this.h / 2, 0);
        world.effects.shake(0.1);
        if (DS.Audio) DS.Audio.play('jump', { x: this.x, i: 1 });
      } else if (this.onGround) {
        this.jumps = s.maxJumps; this.airDashUsed = false; this.airSpearUsed = false;
        if (wasAir) {
          world.effects.dust(this.x, this.y + this.h / 2, 0);
          // a hammer slam erupts spikes from the ground where it lands
          if (this.action && this.action.data.meteor) { world.effects.groundSpikes(this.x, this.y + this.h / 2, 1.3); if (DS.Audio) DS.Audio.play('spike', { x: this.x }); }
          else if (DS.Audio && impactVy > 240) DS.Audio.play('land', { x: this.x, power: impactVy / 1100 }); // only an actual fall thuds
        }
      }
      if (this.hitstun > 0) this.hitstun -= dt;

      // grab a stage ledge when falling beside an outer corner (after recovering control)
      if (!this.onGround && !this.ledge && this.ledgeCd <= 0 && this.hitstun <= 0 && this.vy > -60) {
        this._tryLedgeGrab(world);
      }

      const b = world.blast || set.blast;
      if (this.x < b.left || this.x > b.right || this.y < b.top || this.y > b.bottom) this._ko(world);

      // momentum decays once you're no longer dashing (~0.55s to empty) — short enough that
      // it can't be banked, long enough to carry a dash a beat (and through a jump)
      if (this.dashT <= 0) this.momentum = Math.max(0, this.momentum - dt * 1.8);

      // anim + blink
      this.animPhase += dt * (6 + Math.abs(this.vx) * 0.03);
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) { this.blinkTimer = 2 + Math.random() * 2.6; this.blinkUntil = 0.12; }
      if (this.blinkUntil > 0) this.blinkUntil -= dt;

      this.expr = this.hitstun > 0 ? 'hurt' : this.shielding ? 'shield' : this.action ? 'attack' : '';
    }

    _poseName() {
      if (this.ledge) return 'ledge';
      if (this.action) return this.action.name;
      if (this.hitstun > 0) return 'hurt';
      if (this.shielding) return 'shield';
      if (this.dashT > 0 && this.onGround) return 'dash';
      if (!this.onGround) return this.vy < 0 ? 'jump' : 'fall';
      if (this.crouching) return 'crouch';
      if (Math.abs(this.vx) > 35) return 'walk';
      return 'idle';
    }

    getPose() {
      const name = this._poseName();
      const act = this.ch.actions[name] || this.ch.actions.idle;
      const p = clonePose(act.pose);
      if (name === 'idle') {
        const b = Math.sin(this.animPhase * 0.5);
        p.headY += b * 1.4; p.squash *= 1 + b * 0.012;
        p.armFront.sh += b * 2; p.armBack.sh -= b * 2;
      } else if (name === 'walk') {
        const sw = Math.sin(this.animPhase);
        p.legFront.hip += sw * 13; p.legBack.hip -= sw * 13;
        p.legFront.knee += Math.max(0, sw) * 12;
        p.armFront.sh -= sw * 10; p.armBack.sh += sw * 10;
        p.headY += Math.abs(sw) * -1.2;
      } else if (name === 'dash') {
        // fast churn + a little ease into the lean over the dash
        const sw = Math.sin(this.animPhase * 1.7);
        const ramp = this.dashT > 0 ? Math.min(1, (DASH - this.dashT) / 0.08) : 1;
        p.lean *= ramp;
        p.legFront.hip += sw * 9; p.legBack.hip -= sw * 9;
        p.armFront.sh -= sw * 7; p.armBack.sh += sw * 7;
      } else if (name === 'special') {
        // the throwing arm (and a little of the head/lean) follow the up/down aim
        const aim = this.aimHold || 0;
        p.armFront.sh += aim; p.armBack.sh += aim * 0.4;
        p.headY -= aim * 0.12; p.lean += aim * 0.06;
      } else if (name === 'ledge') {
        const sw = Math.sin(this.animPhase * 0.8); // gentle dangle
        p.legFront.hip += sw * 5; p.legBack.hip += sw * 5; p.headY += sw * 0.8;
      } else if (name === 'hammer') {
        // both arms swing the overhead hammer down, reaching the slam by the active-window
        // end and HOLDING there (sw=1) while airborne until you land (see _updateAction)
        const a = this.action, d = a.data;
        const activeEnd = (d.startup + d.active) / 60;
        const ss = (t) => t * t * (3 - 2 * t);
        const sw = ss(Math.min(1, a.t / activeEnd));
        const sh = 178 + (28 - 178) * sw;           // overhead → down-front
        p.armFront.sh = sh; p.armFront.el = 8; p.armBack.sh = sh + 6; p.armBack.el = 8;
        p.lean = -10 + 26 * sw; p.headY = -3 + 5 * sw; // wind back, then drive forward/down
      } else if (name === 'spear') {
        // a sharp upward thrust: arms shoot overhead and the whole body stretches tall, then settles
        const a = this.action, d = a.data;
        const ph = Math.min(1, a.t / ((d.startup + d.active + d.recovery) / 60));
        const ss = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
        const thrust = ph < 0.28 ? ss(ph / 0.28) : 1 - 0.55 * ss((ph - 0.28) / 0.72); // snap up, ease down
        p.armFront.sh = 174 + thrust * 6; p.armFront.el = 2; p.armBack.sh = 170 + thrust * 6; p.armBack.el = 2;
        p.squash = 1.04 + 0.22 * thrust; p.headY = -3 - thrust * 3; p.lean = this.facing * 2;
        p.legFront.hip = -6 - thrust * 6; p.legBack.hip = 6 + thrust * 6; // legs trail straight down
      } else if (name === 'superpunch' || name === 'ultrapunch') {
        // cock the fist back, snap it forward to full extension, then recoil — a real thrust
        const a = this.action, d = a.data;
        const ph = Math.min(1, a.t / ((d.startup + d.active + d.recovery) / 60));
        const ss = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
        let reach; // snap out fast, HOLD extended so the glove stays out, then recoil
        if (ph < 0.10) reach = -0.5 * ss(ph / 0.10);                  // wind back
        else if (ph < 0.26) reach = -0.5 + 1.5 * ss((ph - 0.10) / 0.16); // snap to full
        else if (ph < 0.80) reach = 1;                                // hold extended
        else reach = 1 - ss((ph - 0.80) / 0.20);                      // recoil/settle
        const big = name === 'ultrapunch' ? 1.25 : 1;
        p.armFront.sh = 64 + reach * 34; p.armFront.el = -30 + reach * 28; // bent-back → straight-forward
        p.armBack.sh = -36 - reach * 22 * big;
        p.lean = 6 + reach * 12 * big; p.headX = 3 + reach * 3;
        p.legFront.hip = 24 + reach * 18; p.legBack.hip = -20 - reach * 10; // step into it
      } else if (name === 'bat') {
        // a big home-run swing synced to the bat art: coil back over the shoulder through the
        // startup, then drive the whole body through during the active (contact) window
        const a = this.action, d = a.data;
        const ph = Math.min(1, a.t / ((d.startup + d.active + d.recovery) / 60));
        const st = d.startup / (d.startup + d.active + d.recovery);
        const ae = (d.startup + d.active) / (d.startup + d.active + d.recovery);
        const ss = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
        let sw; // -0.45 coiled back → 1 followed through
        if (ph < st) sw = -0.45 * ss(ph / st);
        else if (ph < ae) sw = -0.45 + 1.45 * ss((ph - st) / (ae - st));
        else sw = 1;
        p.armFront.sh = 74 + sw * 60; p.armFront.el = -10;
        p.armBack.sh = 56 + sw * 60; p.armBack.el = -8;
        p.lean = -10 + sw * 24; p.headX = 3;
        p.legFront.hip = 20 + sw * 10; p.legBack.hip = -16 - sw * 6;
      } else if (name === 'gun' || name === 'shotgun' || name === 'bomb') {
        // brace and point the prop forward; the lead arm follows the held up/down aim
        const aim = this.aimHold || 0;
        p.armFront.sh = 92 + aim; p.armFront.el = -8;
        p.armBack.sh = -30; p.lean = 8; p.headX = 4; p.headY -= aim * 0.1;
        p.legFront.hip = 16; p.legBack.hip = -14;
      } else if (name === 'supershot') {
        // cock the throwing arm up-and-back, snap it forward as the blast fires, then settle
        const a = this.action, d = a.data;
        const ph = Math.min(1, a.t / ((d.startup + d.active + d.recovery) / 60));
        const ss = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
        let thr; // cock back, snap forward, HOLD the bazooka out, then settle
        if (ph < 0.22) thr = -ss(ph / 0.22);
        else if (ph < 0.40) thr = -1 + 1.7 * ss((ph - 0.22) / 0.18);
        else if (ph < 0.82) thr = 0.7;
        else thr = 0.7 - 0.7 * ss((ph - 0.82) / 0.18);
        const aim = this.aimHold || 0;
        p.armFront.sh = 96 - thr * 46 + aim; p.armFront.el = -6 - Math.max(0, -thr) * 18;
        p.armBack.sh = 64 + thr * 16; p.lean = 12 + thr * 8;
        p.headY -= aim * 0.12; p.headX = 4 + thr * 3;
      }
      return p;
    }

    render(ctx, world) {
      if (this.dead || this.respawnT > 0) return;
      // soft contact shadow
      if (this.onGround) {
        ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = D.COL.ink;
        ctx.beginPath(); ctx.ellipse(this.x, this.y + this.h / 2 + 2, 24, 6, 0, 0, 7); ctx.fill();
        ctx.restore();
      }
      ctx.save();
      ctx.translate(this.x, this.y);
      // tilt when knocked off-balance (positive = "/" lean for a hit from the left)
      if (this.hitTilt) ctx.rotate(this.hitTilt);
      let baseA = 1;
      if (this.invuln > 0 && Math.floor(this.invuln * 18) % 2 === 0) baseA = 0.4;
      const p = this.getPose();
      const act = this.action && this.action.name;
      // charging up → the fighter's ink steadily washes its OWN name-tag colour as % is dealt
      // (so you can tell who's charged at a glance); full + aura when ult-ready.
      const chgCol = this.tagCol || D.COL.powerSoft;
      // vibrant player colour (+ a deep variant) for the ult weapons/effects, so each fighter's
      // ultimate reads as theirs rather than a universal blue
      const ultCol = this.tagCol || D.COL.power, ultDeep = D.mix(ultCol, D.COL.ink, 0.45);
      const cg = Math.max(0, Math.min(1, this.charge || 0));
      const ultActive = !!this.ult || (this.action && this.action.data && this.action.data.ult);
      const full = this._ultReady() || ultActive;
      const tint = full ? 1 : Math.pow(cg, 0.6); // ramps visibly coloured well before the bar would
      const lineCol = tint > 0.02 ? D.mix(D.COL.ink, chgCol, tint) : null;
      // ready-to-unleash aura: a soft breathing halo (player colour) drawn behind the body
      if (this._ultReady()) {
        const pulse = 0.5 + 0.5 * Math.sin(this.animPhase * 1.5); // slow, barely-there breathing
        ctx.save();
        ctx.translate(0, -10); ctx.strokeStyle = chgCol;
        for (let k = 0; k < 2; k++) {
          ctx.globalAlpha = (0.17 - k * 0.06) + 0.035 * pulse;
          ctx.lineWidth = (6 - k * 2) * this.scale;
          const rr = (30 + k * 16) * this.scale * (1 + 0.035 * pulse);
          ctx.beginPath(); ctx.ellipse(0, 0, rr * 0.82, rr, 0, 0, 6.2832); ctx.stroke();
        }
        ctx.restore();
      }
      // item FINISHER: armed silently for the demo (no aura / prompt) — the holder just presses their
      // finisher key (P1 'T', P2 'M') in range of an opponent to fire the KO video.
      // one-shot "you're charged" bloom — drawn ON the body (in local space) so it tracks the
      // fighter even at full sprint, instead of leaving a ring where they used to stand
      if (this._burstT > 0) {
        const bp = 1 - this._burstT / 0.45;            // 0 → 1 over the burst
        const ease = 1 - (1 - bp) * (1 - bp);          // ease-out expansion
        ctx.save();
        ctx.translate(0, -10); ctx.strokeStyle = chgCol;
        ctx.globalAlpha = 0.55 * (1 - bp);             // fade out as it grows
        const rr = (18 + 74 * ease) * this.scale;
        ctx.lineWidth = 4 * this.scale * (1 - bp);
        ctx.beginPath(); ctx.ellipse(0, 0, rr * 0.85, rr, 0, 0, 6.2832); ctx.stroke();
        // a quiet ring of little outward dashes (energy puffing off the body)
        ctx.lineWidth = 3 * this.scale;
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * 6.2832, c = Math.cos(a), s = Math.sin(a);
          ctx.beginPath(); ctx.moveTo(c * rr * 0.85, s * rr); ctx.lineTo(c * rr * 0.85 * 1.16, s * rr * 1.16); ctx.stroke();
        }
        ctx.restore();
      }
      // the speed-special moves morph the whole fighter into a big sketch of the weapon
      const morph = act === 'supershot' ? 'cannon' : (act === 'superpunch' || act === 'ultrapunch') ? 'glove' : null;
      const isWolf = this.ult && this.ult.type === 'werewolf';
      const drawBody = (alpha) => {
        ctx.save(); ctx.globalAlpha = alpha;
        const opts = { facing: this.facing, color: lineCol, expr: this.expr, blink: this.blinkUntil > 0, seed: this.pIndex * 1009 + 7 };
        if (isWolf) { ctx.scale(WOLF_SIZE, WOLF_SIZE); DS.character.drawWolf(ctx, this.ch, p, opts); } // 3x beast
        else DS.character.drawFighter(ctx, this.ch, p, opts);
        ctx.restore();
      };
      if (morph) {
        const a = this.action, d = a.data;
        const frames = d.startup + d.active + d.recovery;
        const ph = Math.min(1, a.t / (frames / 60));
        const pI = d.startup ? d.startup / frames : 0.2;   // impact phase (fraction of the move)
        const ss = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
        // weapon forms in the first half of the startup, then winds up + strikes, then morphs back
        const m = ph < pI ? ss((ph - 0.02) / Math.max(0.05, pI * 0.5 - 0.02)) : ph > 0.86 ? 1 - ss((ph - 0.86) / 0.14) : 1;
        if (m < 0.97) { ctx.save(); ctx.scale(1 - 0.3 * m, 1 - 0.3 * m); drawBody(baseA * (1 - m)); ctx.restore(); }
        // DYNAMIC motion across the startup delay — anticipation → snap → settle (this sells it)
        let tx = 0, sc = 0.55 + 0.45 * m;
        if (morph === 'glove') {
          let lp; // -0.55 cocked → ~1.07 overshoot at impact → settle to 1 → retract
          if (ph < pI) { const u = ph / pI; lp = u < 0.62 ? -0.55 * ss(u / 0.62) : -0.55 + 1.62 * ss((u - 0.62) / 0.38); }
          else if (ph < pI + 0.16) lp = 1.07 - 0.07 * ss((ph - pI) / 0.16);
          else lp = 1 - 0.72 * ss((ph - pI - 0.16) / Math.max(0.05, 1 - pI - 0.16));
          tx = this.facing * 50 * this.scale * lp;
          if (ph < pI) sc *= 1 + 0.05 * ss(ph / pI);       // a little wind-up swell
        } else {
          // cannon: swell + intensifying throb while charging, then a recoil kick + settle on fire
          if (ph < pI) { const u = ph / pI; sc *= 1 + 0.18 * ss(u) + 0.045 * Math.sin(u * Math.PI * 7) * u; }
          else { const k = Math.min(1, (ph - pI) / 0.24); sc *= 1 + 0.18 * (1 - ss(k)); tx = -this.facing * 32 * this.scale * Math.sin(k * Math.PI); }
        }
        ctx.save(); ctx.globalAlpha = baseA * m; ctx.translate(tx, 0); ctx.scale(sc, sc);
        if (morph === 'glove') DS.character.weapon(ctx, 'glove', { dir: this.facing, big: act === 'ultrapunch', scale: this.scale });
        else DS.character.weapon(ctx, 'cannon', { dir: this.facing, aim: (this.aimHold || 0) * Math.PI / 180, scale: this.scale });
        ctx.restore();
      } else {
        drawBody(baseA);
      }
      ctx.restore();

      // --- held props for the contextual moves (witty distinct weapons) ---
      if (act === 'hammer') {
        // overhead hammer that swings down and holds at the slam until landing
        const a = this.action, d = a.data;
        const sw = (function (t) { return t * t * (3 - 2 * t); })(Math.min(1, a.t / ((d.startup + d.active) / 60)));
        ctx.save(); ctx.translate(this.x, this.y);
        DS.character.weapon(ctx, 'hammer', { dir: this.facing, swing: sw, scale: this.scale });
        ctx.restore();
      } else if (act === 'spear' && !isWolf) {
        // a spear gripped at the raised hands that thrusts UP as the move snaps out, with a
        // couple of faint motion streaks below to sell the rocket-up (the werewolf just pounces)
        const a = this.action, d = a.data;
        const ss = (t) => t * t * (3 - 2 * t);
        const ext = ss(Math.min(1, a.t / ((d.startup + d.active) / 60)));
        ctx.save(); ctx.globalAlpha = 0.32 * (1 - ext); ctx.strokeStyle = D.COL.inkSoft;
        for (let i = -1; i <= 1; i++) D.line(ctx, this.x + i * 9, this.y + 24, this.x + i * 9, this.y + 60 + ext * 40, { width: 3, passes: 1 });
        ctx.restore();
        ctx.save(); ctx.translate(this.x + this.facing * 4, this.y - 30 - ext * 30);
        DS.character.weapon(ctx, 'spear', { dir: this.facing, scale: this.scale * 1.05 });
        ctx.restore();
      } else if (act === 'ulthammer' && !this.action.fired) {
        // ULTIMATE wind-up: hold the big blue hammer cocked back, about to be thrown as a boomerang
        ctx.save(); ctx.translate(this.x, this.y - 4);
        DS.character.weapon(ctx, 'hammer', { dir: this.facing, swing: 0.12, scale: this.scale * 1.6, color: ultCol, headFill: ultDeep });
        ctx.restore();
      }

      // power-up props in hand (bat / blaster / scatter / bomb) — drawn for the move's lifetime
      const idat = this.action && this.action.data;
      if (idat && idat.weapon) {
        const a = this.action, d = idat;
        const ph = Math.min(1, a.t / ((d.startup + d.active + d.recovery) / 60));
        const ss = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
        ctx.save(); ctx.translate(this.x, this.y);
        if (d.weapon === 'bat') {
          // hold cocked over the shoulder through startup, then WHIP through during the active
          // (contact) window, then settle the follow-through during recovery
          const st = d.startup / (d.startup + d.active + d.recovery);
          const ae = (d.startup + d.active) / (d.startup + d.active + d.recovery);
          let sw;
          if (ph < st) sw = ss(ph / st) * 0.08;                       // tiny wind-up, stays cocked
          else if (ph < ae) sw = 0.08 + ss((ph - st) / (ae - st)) * 0.82; // snap through on contact
          else sw = 0.9 + ss((ph - ae) / (1 - ae)) * 0.1;             // settle the follow-through
          DS.character.weapon(ctx, 'bat', { dir: this.facing, swing: sw, scale: this.scale });
        } else if (d.weapon === 'rifle' || d.weapon === 'shotgun') {
          DS.character.weapon(ctx, d.weapon, { dir: this.facing, aim: (this.aimHold || 0) * Math.PI / 180, scale: this.scale });
        } else if (d.weapon === 'bomb' && !a.fired) {
          // a round bomb with a lit fuse held in the lead hand, until it's thrown
          const rnd = DS.makeRng(9), bx = this.facing * 18, by = -8;
          D.circle(ctx, bx, by, 11, { width: 4, color: D.COL.ink, rnd, fill: D.mix(D.COL.ink, D.COL.paper, 0.55) });
          D.circle(ctx, bx - this.facing * 3, by - 3, 2.6, { width: 0, color: D.COL.paper, fill: D.COL.paper }); // shine
          D.line(ctx, bx, by - 11, bx + this.facing * 6, by - 21, { width: 3, color: D.COL.accent, rnd, passes: 1 }); // fuse
        }
        ctx.restore();
      } else if (this.item) {
        // CARRIED prop: while you hold an item but aren't mid-swing, show it on the fighter
        // (rested/ready) so it's clear you're armed until the uses run out
        const key = this.item.key;
        ctx.save(); ctx.translate(this.x, this.y);
        if (key === 'bat') {
          DS.character.weapon(ctx, 'bat', { dir: this.facing, swing: 0, scale: this.scale }); // resting over the shoulder
        } else if (key === 'blaster') {
          DS.character.weapon(ctx, 'rifle', { dir: this.facing, aim: -0.35, scale: this.scale }); // AK held at the ready
        } else if (key === 'scatter') {
          DS.character.weapon(ctx, 'shotgun', { dir: this.facing, aim: -0.35, scale: this.scale }); // shotgun held at the ready
        } else if (key === 'bomb') {
          const rnd = DS.makeRng(9), bx = this.facing * 18, by = -8;
          D.circle(ctx, bx, by, 11, { width: 4, color: D.COL.ink, rnd, fill: D.mix(D.COL.ink, D.COL.paper, 0.55) });
          D.circle(ctx, bx - this.facing * 3, by - 3, 2.6, { width: 0, color: D.COL.paper, fill: D.COL.paper });
          D.line(ctx, bx, by - 11, bx + this.facing * 6, by - 21, { width: 3, color: D.COL.accent, rnd, passes: 1 });
        }
        ctx.restore();
      }

      // werewolf melee visuals (scaled with the 3x body so the streaks match the AOE)
      const wsz = this._wolfSize();
      if (act === 'wolfslash') {
        // big visible AOE slash — three claw-streaks sweeping across the front
        const a = this.action, d = a.data, st = d.startup / 60, ac = d.active / 60;
        if (a.t >= st && a.t < st + ac + 0.1) {
          const R = d.hit.r * wsz, rnd = DS.makeRng(13), prog = Math.min(1, (a.t - st) / ac);
          ctx.save(); ctx.globalAlpha = 0.85 * (1 - prog * 0.4);
          for (let i = -1; i <= 1; i++) {
            const o = i * 24 * wsz;
            D.curve(ctx, [[this.x - this.facing * R * 0.35, this.y - R * 0.6 + o], [this.x + this.facing * R * 0.75, this.y + o * 0.4], [this.x + this.facing * R * 0.25, this.y + R * 0.7 + o]],
              { width: 6 * wsz, color: i === 0 ? ultDeep : ultCol, rnd, passes: 1 });
          }
          ctx.globalAlpha = 1; ctx.restore();
        }
      } else if (act === 'clawswipe') {
        // a quick claw rake; alternates high/low with each swipe (left/right paw)
        const a = this.action, d = a.data, st = d.startup / 60, ac = d.active / 60;
        if (a.t < st + ac + 0.05) {
          const hx = this.x + d.hit.x * wsz * this.facing, hy = this.y + d.hit.y * wsz + (this.ult ? this.ult.paw * 14 * wsz : 0), rnd = DS.makeRng(17);
          ctx.save(); ctx.globalAlpha = 0.9;
          for (let i = -1; i <= 1; i++) D.line(ctx, hx - this.facing * 16 * wsz, hy - 14 * wsz + i * 12 * wsz, hx + this.facing * 14 * wsz, hy + 16 * wsz + i * 12 * wsz, { width: 4 * wsz, color: ultCol, rnd, passes: 1 });
          ctx.globalAlpha = 1; ctx.restore();
        }
      }

      // ULTIMATE sniper: a held rifle + a long laser sight along the aim
      if (this.ult && this.ult.type === 'sniper') {
        const a = this.ult.aim, ca = Math.cos(a), sa = Math.sin(a), rnd = DS.makeRng(9);
        const mx = this.x + ca * 30, my = this.y - 6 + sa * 30;
        // laser beam (pulsing) + a crosshair partway down it
        ctx.save();
        ctx.globalAlpha = 0.45 + 0.3 * Math.sin(performance.now() / 70);
        D.line(ctx, mx, my, mx + ca * 1700, my + sa * 1700, { width: 2.5, color: ultCol, passes: 1 });
        ctx.globalAlpha = 1;
        const rx = mx + ca * 230, ry = my + sa * 230;
        D.circle(ctx, rx, ry, 13, { width: 2.5, color: ultCol, rnd });
        D.line(ctx, rx - 20, ry, rx + 20, ry, { width: 2, color: ultCol, passes: 1 });
        D.line(ctx, rx, ry - 20, rx, ry + 20, { width: 2, color: ultCol, passes: 1 });
        ctx.restore();
        // rifle along the aim (barrel + scope), drawn in the player's charged colour
        ctx.save(); ctx.translate(this.x, this.y - 6); ctx.rotate(a); if (ca < 0) ctx.scale(1, -1);
        D.strokePts(ctx, [[-16, -5], [44, -5], [44, 5], [-16, 5]], { width: 5, color: ultCol, rnd, closed: true, fill: D.COL.paperShade });
        D.strokePts(ctx, [[4, -6], [20, -6], [20, -15], [4, -15]], { width: 4, color: ultCol, rnd, closed: true, fill: D.COL.paper });
        D.line(ctx, 44, 0, 52, 0, { width: 7, color: ultCol, rnd, passes: 1 });
        ctx.restore();
      }

      // attack swoosh during active frames (scaled up for the heavier punches)
      if (this.action) {
        const a = this.action, d = a.data;
        const startup = d.startup / 60, active = d.active / 60;
        if (a.t >= startup && a.t < startup + active && d.hit) {
          const hx = this.x + d.hit.x * this.facing, hy = this.y + d.hit.y;
          const sc = d.hit.r / 30, rnd = DS.makeRng(7);
          ctx.globalAlpha = 0.8;
          DS.draw.curve(ctx, [[hx - this.facing * 18 * sc, hy - 16 * sc], [hx + this.facing * 6 * sc, hy], [hx - this.facing * 14 * sc, hy + 16 * sc]],
            { width: 4, color: D.COL.ink, rnd, passes: 1 });
          ctx.globalAlpha = 1;
        }
      }

      // shield bubble
      if (this.shielding) {
        const rnd = DS.makeRng(((this.animPhase * 10) | 0) + 3);
        ctx.globalAlpha = 0.5;
        DS.draw.circle(ctx, this.x, this.y - 4, 40, { width: 4, color: D.COL.ink, rnd, wob: 2 });
        ctx.globalAlpha = 1;
      }
    }
  }

  DS.Fighter = Fighter;
})(window);
