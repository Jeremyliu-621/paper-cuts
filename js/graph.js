// js/graph.js — DS.Graph: the bounded-but-composable mechanic interpreter ("primitive graph").
//
// THE EVOLUTION of the single-node spec: instead of CHLOE picking 1 of 7 fixed mechanics, it
// COMPOSES primitives (effects) under triggers. A few dozen parts -> thousands of behaviors. And it
// stays SAFE by construction: every `op` is a pre-wired function in EFFECTS — there is no eval, no
// codegen, so a composed graph can never crash or exploit a live match. Unknown ops are skipped and
// every numeric param is clamped, never executed blindly.
//
// GRAPH SHAPE (pure data; validated + clamped before it reaches here):
//   {
//     name, flavor,
//     tags: ['fire'],                 // element tags -> the interaction matrix (fire+water=fizzle)
//     on: {                            // trigger -> ordered list of effects
//       fire:  [ {op:'projectile', speed, damage, ...} ],  // holder pressed attack
//       hit:   [ {op:'aoe', radius, damage}, {op:'status', kind:'burn'} ], // a projectile connected
//       land:  [ ... ],   timer:[ ... ],   pickup:[ ... ],   expire:[ ... ],
//     }
//   }
//
// ctx passed to run(): { world, prop, holder, aimDeg, x, y, facing, hitTarget }
//   world   : engine world (spawnProjectile, spawnProjectileAt, fighters, effects, settings, game)
//   holder  : the Fighter wielding the item;  hitTarget: the Fighter a projectile just struck
//   x,y     : world origin of the effect (holder muzzle, or contact point)
(function (global) {
  'use strict';
  const DS = global.DS;

  // ---- clamp helpers (the JS safety net; mirrors the server-side clamp the model trains against) ----
  function num(v, lo, hi, d) { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; }
  function int(v, lo, hi, d) { return Math.round(num(v, lo, hi, d)); }
  function bool(v) { return v === true || v === 1 || v === 'true'; }
  function pick(v, choices, d) { return choices.indexOf(v) >= 0 ? v : d; }
  function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
  function alive(f, holder) { return f && !f.dead && f.respawnT <= 0 && f !== holder; }

  // when a graph FIRES projectiles, stamp them with the graph's hit/land triggers + element tags, so
  // the engine can run on.hit when they strike a fighter and on.land when they die (bomb arcs ->
  // explodes). Only the `fire` trigger sets attachTriggers, so hit/land effects don't re-propagate.
  function attach(cfg, ctx) {
    if (ctx && ctx.attachTriggers && ctx.graph && ctx.graph.on) {
      if (Array.isArray(ctx.graph.on.hit)) cfg.onHit = ctx.graph.on.hit;
      if (Array.isArray(ctx.graph.on.land)) cfg.onLand = ctx.graph.on.land;
      if (ctx.graph.tags && ctx.graph.tags.length) cfg.tags = ctx.graph.tags;
    }
    return cfg;
  }

  // a clamped engine projectile cfg from an effect's params (+ modifiers). The engine reads these.
  function projCfg(c) {
    return {
      speed: num(c.speed, 200, 1800, 1000), damage: num(c.damage, 0, 30, 8),
      kbBase: num(c.kbBase, 0, 80, 22), kbScale: num(c.kbScale, 0.02, 0.35, 0.09),
      angle: num(c.angle, -60, 60, 0), gravity: num(c.gravity, 0, 2400, 0),
      life: num(c.life, 0.3, 4, 1.3), r: num(c.r, 4, 34, 13),
      homing: bool(c.homing), pierce: bool(c.pierce), bouncy: bool(c.bouncy),
      explosive: bool(c.explosive), aoeRadius: bool(c.explosive) ? num(c.aoeRadius, 20, 160, 60) : 0,
    };
  }

  // ---- vocabulary the dataset generator + validator share (single source of truth) ----
  const TRIGGERS = ['fire', 'hit', 'land', 'timer', 'pickup', 'expire'];
  const STATUSES = ['burn', 'freeze', 'shock', 'poison', 'slow', 'root', 'weaken'];
  const BUFFS = ['invuln', 'speed', 'power'];

  // ---- EFFECT REGISTRY: op -> (cfg, ctx) -> void. THIS is the wired primitive library. ----
  const EFFECTS = {
    // -- ranged / projectile family --------------------------------------------------------
    projectile(c, ctx) {
      const w = ctx.world; if (w && w.spawnProjectile && ctx.holder) w.spawnProjectile(ctx.holder, attach(projCfg(c), ctx), ctx.aimDeg || 0);
    },
    spread(c, ctx) {                          // N projectiles fanned across an arc (shotgun / multishot)
      const w = ctx.world; if (!w || !w.spawnProjectile || !ctx.holder) return;
      const n = int(c.count, 2, 9, 3), arc = num(c.arc, 0, 90, 24), base = attach(projCfg(c), ctx);
      for (let i = 0; i < n; i++) w.spawnProjectile(ctx.holder, base, (ctx.aimDeg || 0) + ((n === 1 ? 0.5 : i / (n - 1)) - 0.5) * arc);
    },
    nova(c, ctx) {                            // N projectiles in a full 360° ring (bomb burst, star nova)
      const w = ctx.world; if (!w || !w.spawnProjectileAt || !ctx.holder) return;
      const n = int(c.count, 3, 16, 8), base = attach(projCfg(c), ctx);
      for (let i = 0; i < n; i++) w.spawnProjectileAt(ctx.holder, base, (i / n) * Math.PI * 2);
    },
    beam(c, ctx) {                            // instant hitscan line from origin along aim (laser/railgun)
      const w = ctx.world; if (!w || !w.fighters) return;
      const a = (ctx.aimDeg || 0) * Math.PI / 180, fc = ctx.facing || (ctx.holder && ctx.holder.facing) || 1;
      const dx = Math.cos(a) * fc, dy = -Math.sin(a);
      const range = num(c.range, 100, 1400, 800), width = num(c.width, 10, 60, 26), dmg = num(c.damage, 1, 35, 14);
      for (const f of w.fighters) {
        if (!alive(f, ctx.holder) || f.invuln > 0) continue;
        const px = f.x - ctx.x, py = f.y - ctx.y, t = px * dx + py * dy;   // projection along the beam
        if (t < 0 || t > range) continue;
        if (Math.abs(px * dy - py * dx) > width) continue;                  // perpendicular distance
        f._takeHit({ damage: dmg, kbBase: num(c.kbBase, 0, 80, 24), kbScale: 0.1, angle: 8 }, dx >= 0 ? 1 : -1, null, w);
      }
      if (w.effects) w.effects.smear(ctx.x, ctx.y, dx * range, dy * range);
    },
    melee(c, ctx) {                           // a REAL swing: arc hitbox IN FRONT of the holder (not a flying shot).
      const w = ctx.world, f = ctx.holder;    // reuses the fighter's melee action (pose + whoosh + crate-smash).
      if (!f || typeof f._startAction !== 'function') return;
      const base = (f.ch && f.ch.actions && f.ch.actions.attack) || { startup: 0, active: 3, recovery: 5 };
      const swing = Object.assign({}, base, {
        hit: { x: num(c.reach, 30, 90, 52), y: -4, r: num(c.r, 20, 70, 34), damage: num(c.damage, 0, 30, 12),
          kbBase: num(c.kbBase, 0, 80, 30), kbScale: num(c.kbScale, 0.02, 0.35, 0.13), angle: num(c.angle, -20, 60, 10) },
      });
      f._startAction('attack', swing);        // 'attack' name -> swing pose + melee whoosh
      if (w && w.effects) w.effects.dust(f.x + f.facing * 34, f.y, f.facing);
      // NOTE: on.hit element effects (e.g. freeze-on-hit) aren't yet propagated through a swing hitbox —
      // they ride projectiles via attach(). A status-on-melee weapon would need the hit loop to run them.
    },
    // -- area / radial ---------------------------------------------------------------------
    aoe(c, ctx) {                             // radial burst at ctx.x,y: hit nearby fighters
      const w = ctx.world; if (!w || !w.fighters) return;
      const R = num(c.radius, 20, 260, 80), dmg = num(c.damage, 0, 40, 12);
      for (const f of w.fighters) {
        if (!alive(f, ctx.holder) || f.invuln > 0) continue;
        if (dist2(f.x, f.y, ctx.x, ctx.y) <= R * R)
          f._takeHit({ damage: dmg, kbBase: num(c.kbBase, 0, 80, 30), kbScale: num(c.kbScale, 0.02, 0.35, 0.12), angle: num(c.angle, 0, 80, 40) }, f.x >= ctx.x ? 1 : -1, null, w);
      }
      if (w.effects) w.effects.impact(ctx.x, ctx.y, 1.2);
    },
    shockwave(c, ctx) {                       // ground-pound: wide low burst that pops everyone up
      EFFECTS.aoe({ radius: num(c.radius, 60, 320, 160), damage: num(c.damage, 0, 30, 9), kbBase: num(c.kbBase, 20, 80, 50), angle: 75 }, ctx);
      if (ctx.world && ctx.world.effects) ctx.world.effects.shake(0.3);
    },
    chain(c, ctx) {                           // lightning hops from the struck target to nearby fighters
      const w = ctx.world; if (!w || !w.fighters || !ctx.hitTarget) return;
      const jumps = int(c.jumps, 1, 5, 2), range = num(c.range, 80, 400, 220), dmg = num(c.damage, 1, 25, 8);
      const seen = new Set([ctx.hitTarget]); let from = ctx.hitTarget;
      for (let j = 0; j < jumps; j++) {
        let best = null, bd = range * range;
        for (const f of w.fighters) { if (!alive(f, ctx.holder) || seen.has(f) || f.invuln > 0) continue; const d = dist2(f.x, f.y, from.x, from.y); if (d <= bd) { bd = d; best = f; } }
        if (!best) break;
        best._takeHit({ damage: dmg, kbBase: 14, kbScale: 0.08, angle: 20 }, best.x >= from.x ? 1 : -1, null, w);
        seen.add(best); from = best;
      }
    },
    // -- control / status ------------------------------------------------------------------
    status(c, ctx) {                          // apply a status to the struck target (engine ticks it)
      const t = ctx.hitTarget; if (!t) return;
      const kind = pick(c.kind, STATUSES, 'burn');
      t._status = t._status || {};
      t._status[kind] = Math.max(t._status[kind] || 0, num(c.dur, 0.5, 8, 3));
    },
    knockback(c, ctx) {                       // pure shove, no damage
      const t = ctx.hitTarget; if (!t) return;
      t._takeHit({ damage: 0, kbBase: num(c.force, 0, 90, 40), kbScale: 0.1, angle: num(c.angle, -30, 80, 30) }, t.x >= ctx.x ? 1 : -1, null, ctx.world);
    },
    pull(c, ctx) {                            // vacuum: draw nearby fighters toward ctx.x,y
      const w = ctx.world; if (!w || !w.fighters) return;
      const R = num(c.radius, 40, 320, 160), f0 = num(c.force, 100, 1400, 600);
      for (const f of w.fighters) { if (!alive(f, ctx.holder)) continue; const dx = ctx.x - f.x, dy = ctx.y - f.y, d = Math.hypot(dx, dy) || 1; if (d <= R) { f.vx += (dx / d) * f0; f.vy += (dy / d) * f0 * 0.6; } }
    },
    push(c, ctx) {                            // radial shove away from ctx.x,y
      const w = ctx.world; if (!w || !w.fighters) return;
      const R = num(c.radius, 40, 320, 160), f0 = num(c.force, 100, 1600, 700);
      for (const f of w.fighters) { if (!alive(f, ctx.holder)) continue; const dx = f.x - ctx.x, dy = f.y - ctx.y, d = Math.hypot(dx, dy) || 1; if (d <= R) { f.vx += (dx / d) * f0; f.vy += (dy / d) * f0 - 120; f.onGround = false; } }
    },
    bounce(c, ctx) {                          // launch the contact target (or holder) upward — spring
      const f = ctx.hitTarget || ctx.holder; if (!f) return;
      f.vy = -num(c.force, 600, 2400, 1300); f.onGround = false; f.ground = null;
    },
    // -- support / self --------------------------------------------------------------------
    heal(c, ctx) {
      const f = ctx.holder; if (!f) return;
      f.damage = Math.max(0, (f.damage || 0) - num(c.amount, 0, 80, 30));
      if (ctx.world && ctx.world.effects) ctx.world.effects.charge(f.x, f.y - 6, f.tagCol);
    },
    buff(c, ctx) {
      const f = ctx.holder; if (!f) return;
      const eff = pick(c.effect, BUFFS, 'invuln'), dur = num(c.dur, 0, 12, 5);
      if (eff === 'invuln') f.invuln = Math.max(f.invuln || 0, dur);
      else { f._buff = f._buff || {}; f._buff[eff] = Math.max(f._buff[eff] || 0, dur); }
      if (ctx.world && ctx.world.effects) ctx.world.effects.charge(f.x, f.y - 6, f.tagCol);
    },
    shield(c, ctx) {                          // temporary damage block (engine checks _shield)
      const f = ctx.holder; if (f) f._shield = Math.max(f._shield || 0, num(c.dur, 0.5, 8, 3));
    },
    dash(c, ctx) {                            // lunge the holder forward (mobility primitive)
      const f = ctx.holder; if (!f) return;
      f.vx += (f.facing || 1) * num(c.force, 200, 1400, 700); if (bool(c.up)) f.vy = -num(c.up, 200, 1200, 500);
    },
    lifesteal(c, ctx) {                       // heal the holder when this item connects
      const f = ctx.holder; if (f) f.damage = Math.max(0, (f.damage || 0) - num(c.amount, 1, 30, 8));
    },
    summon(c, ctx) {                          // spawn N autonomous homing projectiles ("minions")
      const w = ctx.world; if (!w || !w.spawnProjectile || !ctx.holder) return;
      const n = int(c.count, 1, 6, 3), base = attach(projCfg({ speed: c.speed || 700, damage: c.damage || 6, life: c.life || 2.4, homing: true, r: c.r }), ctx);
      for (let i = 0; i < n; i++) w.spawnProjectile(ctx.holder, base, ((i / Math.max(1, n - 1)) - 0.5) * 50);
    },
    hazardField(c, ctx) {                     // drop a lingering damage zone at ctx.x,y (env prop)
      const w = ctx.world; if (!w || !w.game || !w.game.props || !DS.Prop) return;
      const p = new DS.Prop({ label: 'hazard', x: ctx.x, y: ctx.y, w: num(c.radius, 24, 160, 60), h: 40,
        mechanic: { kind: 'hazard', archetype: 'hazard', damage: num(c.damage, 3, 25, 10), radius: num(c.radius, 24, 160, 60) } });
      p.bornT = 0.3; w.game.props.push(p);
    },
  };

  // ---- ELEMENT INTERACTION MATRIX: what happens when two tagged things meet (the fire+water magic) ----
  // Symmetric, keyed on the sorted pair. `both:'remove'` cancels both; `both:'keep'` reacts but keeps
  // both; `strong:<el>` => that element survives and the other is consumed. fx = the visual/audio cue.
  const ELEMENTS = ['fire', 'water', 'ice', 'electric', 'plant', 'rock', 'wind', 'metal', 'poison', 'light', 'dark'];
  const REACTIONS = {
    'fire|water':     { both: 'remove', fx: 'steam',    note: 'fizzle' },
    'fire|ice':       { strong: 'fire', fx: 'melt',     note: 'fire melts ice' },
    'fire|plant':     { strong: 'fire', fx: 'ignite',   note: 'plant catches fire' },
    'fire|metal':     { both: 'keep',   fx: 'forge',    note: 'metal glows hot' },
    'fire|wind':      { both: 'keep',   fx: 'flare',    note: 'wind fans the flames' },
    'electric|water': { both: 'keep',   fx: 'shock',    note: 'water conducts -> shock' },
    'electric|metal': { both: 'keep',   fx: 'overload', note: 'metal overloads' },
    'electric|ice':   { strong: 'electric', fx: 'shatter', note: 'shock shatters ice' },
    'electric|rock':  { strong: 'rock', fx: 'ground',   note: 'rock grounds the charge' },
    'plant|water':    { strong: 'plant', fx: 'grow',    note: 'water feeds the plant' },
    'plant|poison':   { strong: 'poison', fx: 'wither', note: 'poison kills the plant' },
    'poison|water':   { strong: 'water', fx: 'dilute',  note: 'water dilutes poison' },
    'light|poison':   { strong: 'light', fx: 'purify',  note: 'light purifies poison' },
    'dark|light':     { both: 'remove', fx: 'flash',    note: 'light and dark annihilate' },
    'ice|rock':       { both: 'keep',   fx: 'frost',    note: 'rock frosts over' },
    'metal|water':    { both: 'keep',   fx: 'rust',     note: 'metal rusts' },
    'water|wind':     { both: 'keep',   fx: 'mist',     note: 'a fine mist' },
  };

  // Resolve the reaction between two tag-sets. Returns null if no element pair reacts.
  // Result: { winner, loser, remove:[elements...], fx, note } (winner/loser null when symmetric).
  function react(tagsA, tagsB) {
    for (const ea of (tagsA || [])) {
      for (const eb of (tagsB || [])) {
        if (!ELEMENTS.includes(ea) || !ELEMENTS.includes(eb)) continue;
        const r = REACTIONS[[ea, eb].sort().join('|')];
        if (!r) continue;
        if (r.both === 'remove') return { winner: null, loser: null, remove: [ea, eb], fx: r.fx, note: r.note };
        if (r.both === 'keep') return { winner: null, loser: null, remove: [], fx: r.fx, note: r.note };
        const winner = r.strong, loser = (winner === ea) ? eb : ea;
        return { winner: winner, loser: loser, remove: [loser], fx: r.fx, note: r.note };
      }
    }
    return null;
  }

  // ---- element contact resolution: tagged things meeting react (fire+water=fizzle, ...) ----
  function overlap(a, b, ar, br) { return Math.abs(a.x - b.x) <= ar + br && Math.abs(a.y - b.y) <= ar + br; }
  function tagsHit(tags, remove) { for (const t of tags) if (remove.indexOf(t) >= 0) return true; return false; }

  // Scan tagged projectiles against each other (different owners) and against tagged world props, apply
  // react(), consume the elements it removes, and fire onReact(reaction, x, y) for the visual. Each
  // entity reacts at most once (`_reacted`) so a lingering overlap doesn't spam. Returns reaction count.
  function resolveContacts(projectiles, props, onReact) {
    const ps = projectiles || []; let count = 0;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (a.dead || a.fade != null || a._reacted || !a.cfg || !a.cfg.tags) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (b.dead || b.fade != null || b._reacted || !b.cfg || !b.cfg.tags || b.owner === a.owner) continue;
        if (!overlap(a, b, a.r, b.r)) continue;
        const r = react(a.cfg.tags, b.cfg.tags);
        if (!r) continue;
        a._reacted = b._reacted = true;
        if (r.remove.length) { if (tagsHit(a.cfg.tags, r.remove)) a.dead = true; if (tagsHit(b.cfg.tags, r.remove)) b.dead = true; }
        if (onReact) onReact(r, (a.x + b.x) / 2, (a.y + b.y) / 2);
        count++;
        if (a.dead) break;
      }
    }
    for (const a of ps) {
      if (a.dead || a.fade != null || a._reacted || !a.cfg || !a.cfg.tags) continue;
      for (const p of (props || [])) {
        if (p.dead || p.held || !p.mechanic || !p.mechanic.tags || !p.mechanic.tags.length) continue;
        if (Math.abs(a.x - p.x) > a.r + p.w / 2 || Math.abs(a.y - p.y) > a.r + p.h / 2) continue;
        const r = react(a.cfg.tags, p.mechanic.tags);
        if (!r) continue;
        a._reacted = true;
        if (r.remove.length) { if (tagsHit(a.cfg.tags, r.remove)) a.dead = true; if (tagsHit(p.mechanic.tags, r.remove)) p.dead = true; }
        if (onReact) onReact(r, (a.x + p.x) / 2, (a.y + p.y) / 2);
        count++;
        break;
      }
    }
    return count;
  }

  // ---- the interpreter ----
  // runEffects: dispatch a raw effect LIST (used by the engine's collision handlers for on.hit/
  // on.land, where there's no graph object — just the stamped trigger list). Safe: unknown ops skipped.
  function runEffects(list, ctx) {
    if (!Array.isArray(list)) return 0;
    let ran = 0;
    for (const eff of list) {
      const fn = eff && EFFECTS[eff.op];
      if (!fn) continue;                       // unknown primitive -> skip (never throws into the loop)
      try { fn(eff, ctx); ran++; } catch (e) { /* one bad effect can't break the rest */ }
    }
    return ran;
  }
  // run: execute one TRIGGER's effect list. Stamps ctx.graph so attach() can propagate hit/land.
  function run(graph, trigger, ctx) {
    if (!graph || !graph.on) return 0;
    ctx = ctx || {};
    ctx.graph = graph;
    return runEffects(graph.on[trigger], ctx);
  }

  DS.Graph = {
    EFFECTS: EFFECTS, REACTIONS: REACTIONS, ELEMENTS: ELEMENTS,
    TRIGGERS: TRIGGERS, STATUSES: STATUSES, BUFFS: BUFFS,
    OPS: Object.keys(EFFECTS),
    run: run, runEffects: runEffects, react: react, resolveContacts: resolveContacts, projCfg: projCfg,
    isGraph: function (m) { return !!(m && m.on && typeof m.on === 'object'); },
  };
})(window);
