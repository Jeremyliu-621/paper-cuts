// js/prop.js — DS.Prop: a drawn item/object that drops into the live match.
//
// A prop is the home for an AI-enhanced drawing: it carries a SPRITE (the CAELLUM raster, set
// later by DS.AI) OR placeholder vector STROKES (shown instantly), an AABB hitbox, and a
// MECHANIC cfg (from DS.Mechanics / CHLOE). It falls, lands on platforms, is auto-picked-up on
// contact, and FIRES on the holder's attack button via world.spawnProjectile.
//
// Lives in WORLD space (same 1920-tall view as fighters); x,y is the prop's CENTRE.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;

  const GRAV = 2600;              // prop gravity (px/s^2)
  const MAXFALL = 2200;
  const HOLD_X = 30, HOLD_Y = 6;  // hand offset from the holder's centre
  const REVEAL_DUR = 0.4;         // seconds the enhanced-sprite reveal animation plays

  function Prop(opts) {
    opts = opts || {};
    this.label = opts.label || 'thing';
    this.mechanic = opts.mechanic || (DS.Mechanics ? DS.Mechanics.defaultFor(this.label)
      : { kind: 'ranged', speed: 800, damage: 8, life: 1.2, r: 14, angle: 0, cooldown: 0.4 });
    this.archetype = this.mechanic.archetype || 'throwable';
    this.x = opts.x != null ? opts.x : 960;
    this.y = opts.y != null ? opts.y : 200;
    this.vx = opts.vx || 0; this.vy = opts.vy || 0;
    this.w = opts.w || 78; this.h = opts.h || 54;          // AABB hitbox (world px)
    this.spriteSize = opts.spriteSize || Math.max(this.w, this.h) * 1.35; // square draw box for the raster
    this.facing = opts.facing || 1;
    this.strokes = opts.strokes || null;                   // placeholder vector strokes (local coords)
    this.sprite = null;                                    // CAELLUM raster (Image), set by DS.AI later
    this.enhanced = false;
    this._enhancing = false;                               // AI enhance in flight -> show the "magic working" scratch FX
    this._revealT = -1;                                    // >=0 while the enhanced sprite reveals in (see render)
    this.held = null;                                      // the Fighter carrying it
    this.onGround = false;
    this.cooldown = 0;
    this.bornT = 0;
    this.dead = false;
    this._rnd = DS.makeRng(DS.hashSeed ? DS.hashSeed('prop' + this.label + (this.x | 0)) : (this.x | 0) + 7);
  }

  Prop.prototype.update = function (dt, world) {
    this.bornT += dt;
    if (this._revealT >= 0) this._revealT += dt;           // advance the sprite reveal animation
    if (this.cooldown > 0) this.cooldown -= dt;

    if (this.held) {
      const f = this.held;
      if (f.dead) { this.held = null; }                    // safety: also released in handlePickups
      else {
        this.facing = f.facing;
        this.x = f.x + f.facing * HOLD_X * (f.scale || 1);
        this.y = f.y - HOLD_Y;
        this.vx = this.vy = 0;
        return;
      }
    }

    // loose: gravity + simple platform landing
    this.vy = Math.min(MAXFALL, this.vy + GRAV * dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= 0.985;

    this.onGround = false;
    const plats = (world.stage && world.stage.platforms) || world.platforms || [];
    const bottom = this.y + this.h / 2;
    for (const p of plats) {
      if ((this.x + this.w / 2) < p.x || (this.x - this.w / 2) > p.x + p.w) continue;
      if (this.vy >= 0 && bottom >= p.y && bottom <= p.y + Math.max(24, p.h * 0.6)) {
        this.y = p.y - this.h / 2; this.vy = 0; this.onGround = true; break;
      }
    }

    const floor = (world.view ? world.view.h : 1080) + 1600;
    if (this.y > floor) this.dead = true;                  // fell off the world
  };

  Prop.prototype.fire = function (world, aimDeg) {
    if (this.cooldown > 0 || !this.held) return;
    const f = this.held, m = this.mechanic;
    this.cooldown = m.cooldown || 0.3;
    // composable mechanic GRAPH: run its `fire` trigger (projectiles it spawns carry on.hit/on.land).
    if (DS.Graph && DS.Graph.isGraph(m)) {
      DS.Graph.run(m, 'fire', { world: world, holder: f, aimDeg: aimDeg || 0,
        x: f.x + f.facing * 30, y: f.y - 6, facing: f.facing, attachTriggers: true });
      if (world.effects) world.effects.dust(f.x + f.facing * 40, f.y, f.facing);
      return;
    }
    if (m.kind === 'melee') {
      // a REAL swing: reuse the fighter's proven melee action machinery so a drawn sword/axe/bat
      // arcs a hitbox in front of the holder (circle-vs-AABB, knockback, smashes crates) with the
      // swing pose + whoosh — not a flying projectile. reach->hit.x, the rest carries through.
      const base = (f.ch && f.ch.actions && f.ch.actions.attack) || { startup: 0, active: 3, recovery: 5 };
      const reach = m.reach != null ? m.reach : (m.r || 40);
      const swing = Object.assign({}, base, {
        hit: { x: reach, y: -4, r: m.r || 32, damage: m.damage || 10,
          kbBase: m.kbBase || 24, kbScale: m.kbScale || 0.12, angle: m.angle || 10 },
      });
      f._startAction('attack', swing);   // 'attack' name -> swing pose + melee whoosh SFX
      if (world.effects) world.effects.dust(f.x + f.facing * 34, f.y, f.facing);
      return;
    }
    if (m.kind === 'ranged') {
      if (world.spawnProjectile) world.spawnProjectile(f, m, aimDeg || 0);
      if (world.effects) world.effects.dust(f.x + f.facing * 40, f.y, f.facing);
    } else if (m.kind === 'heal') {
      f.damage = Math.max(0, (f.damage || 0) - (m.amount || 25));
      if (world.effects) world.effects.charge(f.x, f.y - 6, f.tagCol);
      this._consume(f);
    } else if (m.kind === 'buff') {
      if (m.effect === 'invuln') f.invuln = Math.max(f.invuln || 0, m.dur || 5);
      if (world.effects) world.effects.charge(f.x, f.y - 6, f.tagCol);
      this._consume(f);
    } else if (world.spawnProjectile) {
      // fallback: lob it like a throwable
      world.spawnProjectile(f, Object.assign({ speed: 700, damage: 8, life: 1.5, r: 16, angle: 12, gravity: 1400 }, m), aimDeg || 0);
    }
  };

  Prop.prototype._consume = function (f) {
    if (f && f.heldProp === this) f.heldProp = null;
    this.held = null; this.dead = true;
  };

  // Track B: a prop whose mechanic is an ENVIRONMENT element (drawn into the arena, not a held
  // weapon). hazard = damage-on-contact zone; bouncy = launch pad. These are not picked up and not
  // fired — they sit in the world (still fall + rest on a platform via update()) and act on contact.
  Prop.prototype.isEnv = function () {
    const k = this.mechanic && this.mechanic.kind;
    // 'platform' is reserved for future Track B work (solid drawn surfaces); not env-handled yet,
    // so it keeps its default behavior rather than becoming an inert prop.
    return k === 'hazard' || k === 'bouncy';
  };

  Prop.prototype.render = function (ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    if (!this.held && this.onGround) ctx.translate(0, Math.sin(this.bornT * 3) * 1.5); // idle bob
    const pop = this.bornT < 0.18 ? this.bornT / 0.18 : 1;                              // spawn pop
    if (pop < 1) ctx.scale(pop, pop);

    const spriteReady = this.sprite && this.sprite.complete && this.sprite.naturalWidth;
    const revealing = this._revealT >= 0 && this._revealT < REVEAL_DUR;
    // reveal: a quick swell as the enhanced sprite first appears (the doodle "becomes real")
    const swell = revealing ? 1 + 0.2 * Math.sin((this._revealT / REVEAL_DUR) * Math.PI) : 1;
    ctx.scale(this.facing * swell, swell);

    if (spriteReady) {
      const s = this.spriteSize;
      ctx.drawImage(this.sprite, -s / 2, -s / 2, s, s);
      if (revealing) this._scratchFx(ctx, this._revealT * 6, 1 - this._revealT / REVEAL_DUR); // burst out + fade
    } else {
      // the kid's actual drawing plays while the AI works; jitter it a touch harder mid-enhance.
      if (this.strokes && this.strokes.length) {
        for (const st of this.strokes) D.strokePts(ctx, st.pts, { width: st.w || 5, rnd: this._rnd, jitter: this._enhancing ? 1.3 : 0.5, passes: 1 });
      } else {
        D.strokePts(ctx, [[-this.w / 2, -this.h / 2], [this.w / 2, -this.h / 2], [this.w / 2, this.h / 2], [-this.w / 2, this.h / 2]], { width: 5, rnd: this._rnd, closed: true });
      }
      if (this._enhancing) this._scratchFx(ctx, this.bornT, 1);     // "AI is drawing it" working FX
    }
    ctx.restore();
  };

  // a ring of short rough scratch-dashes that orbit + pulse around the drawing — the "doodle is being
  // sketched into life" effect that masks the enhance latency. t drives the animation, alpha fades it.
  Prop.prototype._scratchFx = function (ctx, t, alpha) {
    const R = Math.max(this.w, this.h) * (0.6 + (alpha < 1 ? (1 - alpha) * 0.5 : 0)); // bursts outward on reveal
    const n = 7;
    ctx.save();
    ctx.globalAlpha = 0.55 * alpha;
    for (let i = 0; i < n; i++) {
      const a = t * 3.2 + i * (Math.PI * 2 / n);
      const rr = R * (0.92 + 0.16 * Math.sin(t * 8 + i * 1.7));
      const cx = Math.cos(a) * rr, cy = Math.sin(a) * rr;
      const tx = -Math.sin(a), ty = Math.cos(a), L = 6 + 4 * Math.sin(t * 6 + i); // tangential dash
      D.strokePts(ctx, [[cx - tx * L, cy - ty * L], [cx + tx * L, cy + ty * L]], { width: 3, rnd: this._rnd, jitter: 1.4, passes: 1 });
    }
    ctx.restore();
  };

  // auto-pickup on contact (keyboard AND phone — no new input field). Call from Game.update.
  Prop.handlePickups = function (game) {
    const props = game.props; if (!props || !props.length) return;
    for (const f of game.fighters) {
      if (f.dead) { if (f.heldProp) { f.heldProp.held = null; f.heldProp = null; } continue; }
      if (f.heldProp) continue;
      for (const p of props) {
        if (p.held || p.dead || p.bornT < 0.25 || p.isEnv()) continue; // env props aren't picked up
        if (Math.abs(f.x - p.x) < (f.w + p.w) / 2 && Math.abs(f.y - p.y) < (f.h + p.h) / 2) {
          f.heldProp = p; p.held = f; p.vx = 0; p.vy = 0;
          if (game.effects) game.effects.charge(f.x, f.y - 6, f.tagCol);
          // graph `pickup` trigger (heal/buff/shield). A pure consumable (no `fire`) is used up at once.
          if (DS.Graph && DS.Graph.isGraph(p.mechanic) && p.mechanic.on && p.mechanic.on.pickup) {
            DS.Graph.run(p.mechanic, 'pickup', { world: game.world, holder: f, x: f.x, y: f.y, facing: f.facing });
            if (!p.mechanic.on.fire) { f.heldProp = null; p.held = null; p.dead = true; }
          }
          break;
        }
      }
    }
  };

  // Track B environment contact: drawn hazards hurt fighters who touch them; springs launch
  // fighters who come down onto them. Call from Game.update AFTER handlePickups. Mirrors the
  // handlePickups iteration (fighters x props) and reuses the same AABB + Fighter._takeHit the
  // rest of the game uses, so a drawn hazard hits exactly like any other source of damage.
  const BOUNCE_VY_MIN = 60;        // a fighter must be actually descending to trigger a spring
  const HAZARD_REHIT = 0.6;        // seconds a fighter is immune to THE SAME hazard after a tick

  Prop.handleEnvironment = function (game, dt) {
    const props = game.props; if (!props || !props.length) return;
    for (const p of props) {
      if (p.dead || p.held || !p.isEnv()) continue;
      const m = p.mechanic;
      // tick down this hazard's per-fighter re-hit cooldowns
      if (p._hitCool) for (const [f, t] of p._hitCool) {
        if (t - dt <= 0) p._hitCool.delete(f); else p._hitCool.set(f, t - dt);
      }
      for (const f of game.fighters) {
        if (f.dead || f.respawnT > 0) continue;
        const dx = Math.abs(f.x - p.x), dy = Math.abs(f.y - p.y);

        if (m.kind === 'hazard') {
          if (f.invuln > 0) continue;
          const R = m.radius || Math.max(p.w, p.h) * 0.5;          // CHLOE's radius widens the field
          if (dx > f.w / 2 + R || dy > f.h / 2 + R) continue;       // not in the hazard zone
          if (p._hitCool && p._hitCool.has(f)) continue;            // already ticked recently
          const dir = (f.x >= p.x) ? 1 : -1;                        // shove away from the hazard
          f._takeHit({ damage: m.damage || 10, kbBase: m.kbBase || 20,
                       kbScale: m.kbScale || 0.08, angle: 35 }, dir, null, game.world);
          (p._hitCool || (p._hitCool = new Map())).set(f, HAZARD_REHIT);
          if (game.effects) { game.effects.groundSpikes(f.x, f.y + f.h / 2, 0.8); game.effects.shake(0.15); }

        } else if (m.kind === 'bouncy') {
          const overlap = dx < (f.w + p.w) / 2 && dy < (f.h + p.h) / 2;
          if (overlap && f.vy >= BOUNCE_VY_MIN) {                   // came down onto the pad
            f.vy = -(m.bounce || 1300);
            f.onGround = false; f.ground = null;
            if (f.ch && f.ch.stats) f.jumps = f.ch.stats.maxJumps;  // refresh air jumps off the spring
            if (game.effects) { game.effects.dust(f.x, f.y + f.h / 2, f.facing); game.effects.charge(f.x, f.y, f.tagCol); }
          }
        }
      }
    }
  };

  DS.Prop = Prop;
})(window);
