// Juice: particles (impact stars, dust, smears), screen shake, hitstop, floating
// text and KO bursts. All hand-drawn strokes to match the art.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;

  // hard ceiling on live particles — a chaotic 4-way melee can otherwise balloon the array
  // (and its per-frame render cost) without bound, which is where the brief stutters come from.
  const MAX_PARTICLES = 240;
  // particle types we'll sacrifice first when over the cap: the cheap, numerous ones whose
  // individual loss is invisible mid-burst. The dramatic shapes (ring/flash/beam/spike/star)
  // are kept so set-pieces (KO beam, ult connect) always play out in full.
  const CHEAP = { spark: 1, dust: 1, smear: 1, chunk: 1 };

  class Effects {
    constructor() {
      this.particles = [];
      this.texts = [];
      this.trauma = 0;       // 0..1 screen shake energy
      this.hitstopT = 0;     // seconds of freeze remaining
      this._t = 0;
    }
    reset() { this.particles.length = 0; this.texts.length = 0; this.trauma = 0; this.hitstopT = 0; }

    shake(amount) { this.trauma = Math.min(1, this.trauma + amount); }
    hitstop(seconds) { this.hitstopT = Math.max(this.hitstopT, seconds); }

    impact(x, y, power) {
      power = power || 1;
      this.particles.push({ type: 'star', x, y, life: 0.26, max: 0.26, r: 16 + 18 * power, rot: Math.random() * 6 });
      const n = 4 + Math.round(power * 4);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, sp = 120 + Math.random() * 260 * power;
        this.particles.push({ type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.3 + Math.random() * 0.2, max: 0.5 });
      }
    }
    dust(x, y, dir) {
      for (let i = 0; i < 4; i++) {
        this.particles.push({ type: 'dust', x: x + (Math.random() - 0.5) * 14, y: y - Math.random() * 6,
          vx: (dir || (Math.random() - 0.5)) * (40 + Math.random() * 70) * (Math.random() < 0.5 ? 1 : -0.4),
          vy: -20 - Math.random() * 30, life: 0.4 + Math.random() * 0.25, max: 0.65, r: 6 + Math.random() * 7 });
      }
    }
    smear(x, y, vx, vy) {
      this.particles.push({ type: 'smear', x, y, vx: vx * 0.2, vy: vy * 0.2, ang: Math.atan2(vy, vx), len: 26, life: 0.14, max: 0.14 });
    }
    koBurst(x, y) {
      this.particles.push({ type: 'star', x, y, life: 0.5, max: 0.5, r: 46, rot: 0.3 });
      this.shake(0.7);
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * 6.28, sp = 200 + Math.random() * 420;
        this.particles.push({ type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5, max: 0.7 });
      }
    }
    // Smash-style KO blast: a doodle flame-jet that fires outward along the launch
    // direction from the point the fighter crosses the border, + a flash and streaking sparks.
    koBeam(x, y, ang, power) {
      power = power || 1;
      this.particles.push({ type: 'beam', x, y, ang, len: 900 + 760 * power, life: 1.8, max: 1.8, power, seed: (Math.random() * 1000) | 0 });
      // triple flash + two expanding shockwave rings for a big punchy bloom
      this.particles.push({ type: 'flash', x, y, life: 0.95, max: 0.95, r: 60 + 100 * power, seed: (Math.random() * 1000) | 0 });
      this.particles.push({ type: 'flash', x, y, life: 0.65, max: 0.65, r: 36 + 58 * power, seed: (Math.random() * 1000) | 0 });
      this.particles.push({ type: 'ring', x, y, life: 0.95, max: 0.95, r: 24, rmax: 260 + 220 * power });
      this.particles.push({ type: 'ring', x, y, life: 1.3, max: 1.3, r: 40, rmax: 420 + 300 * power });
      // a big fan of sparks streaking out along the blast + slower lingering embers
      for (let i = 0; i < 46; i++) {
        const a = ang + (Math.random() - 0.5) * 1.25, sp = 480 + Math.random() * 1400 * power;
        this.particles.push({ type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.45 + Math.random() * 0.6, max: 1.05 });
      }
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * 6.28, sp = 60 + Math.random() * 200;
        this.particles.push({ type: 'spark', x: x + (Math.random() - 0.5) * 30, y: y + (Math.random() - 0.5) * 30, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120, life: 0.7 + Math.random() * 0.6, max: 1.3 });
      }
      this.shake(1.2 + 0.7 * power);
    }
    floatText(x, y, str) { this.texts.push({ x, y, str, life: 0.8, max: 0.8 }); }
    // tumbling wooden/stone chunks for breakable boxes & structures
    debris(x, y, n, power) {
      power = power || 1; n = n || 6;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, sp = 80 + Math.random() * 220 * power;
        this.particles.push({ type: 'chunk', x: x + (Math.random() - 0.5) * 16, y: y + (Math.random() - 0.5) * 16,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80 * power, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 14,
          size: 6 + Math.random() * 9, life: 0.5 + Math.random() * 0.4, max: 0.9 });
      }
    }
    // jagged ground spikes erupting from an impact point (the hammer slam landing)
    // blue power flash when an ultimate readies / activates / is thrown — NO ring (rings only on hit)
    charge(x, y, col) {
      col = col || D.COL.power;
      this.particles.push({ type: 'flash', x, y, life: 0.4, max: 0.4, r: 54, seed: 7, col });
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * 6.28, sp = 220 + Math.random() * 320;
        this.particles.push({ type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80, life: 0.4 + Math.random() * 0.3, max: 0.7, col });
      }
    }
    // gentle energy wisp drifting up off a fully-charged (ult-ready) fighter's body
    aura(x, y, col) {
      const sp = 18 + Math.random() * 26;
      this.particles.push({ type: 'spark', x: x + (Math.random() - 0.5) * 34, y: y + (Math.random() - 0.5) * 46,
        vx: (Math.random() - 0.5) * sp, vy: -70 - Math.random() * 60, life: 0.5 + Math.random() * 0.4, max: 0.9, col: col || D.COL.powerSoft });
    }
    // satisfying burst when an ultimate connects — tinted to the attacker's player colour so
    // each player's ult reads as theirs. tonal palette (light/base/deep) keeps it lively.
    ultHit(x, y, power, col) {
      power = power || 1;
      const base = col || D.COL.power;
      const light = D.mix(base, '#ffffff', 0.42), deep = D.mix(base, D.COL.ink, 0.45);
      const pop = [base, light, deep, base];
      this.particles.push({ type: 'star', x, y, life: 0.5, max: 0.5, r: 40 * power, rot: 0.3, col: base });
      this.particles.push({ type: 'ring', x, y, life: 0.42, max: 0.42, r: 20, rmax: 110 * power, col: base });
      this.particles.push({ type: 'ring', x, y, life: 0.34, max: 0.34, r: 14, rmax: 72 * power, col: deep });
      this.particles.push({ type: 'flash', x, y, life: 0.34, max: 0.34, r: 44 * power, seed: 11, col: base });
      for (let i = 0; i < 24; i++) {
        const a = Math.random() * 6.28, sp = 220 + Math.random() * 480 * power;
        this.particles.push({ type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.4 + Math.random() * 0.45, max: 0.9, col: pop[i % pop.length] });
      }
      this.shake(0.65 * power);
    }
    groundSpikes(x, y, power) {
      power = power || 1;
      const n = 5 + Math.round(power * 3);
      for (let i = 0; i < n; i++) {
        const side = i === 0 ? 0 : (i % 2 ? 1 : -1);
        const dist = Math.ceil(i / 2) * (15 + Math.random() * 9);
        const falloff = 1 - Math.ceil(i / 2) * 0.13;
        const h = Math.max(12, (30 + Math.random() * 26) * power * falloff);
        this.particles.push({ type: 'spike', x: x + side * dist, y, h, w: 7 + Math.random() * 4,
          lean: (Math.random() - 0.5) * 6 + side * 4, life: 0.42, max: 0.42, seed: (Math.random() * 999) | 0 });
      }
      this.debris(x, y, 4, power);
      this.shake(0.35 * power);
    }

    update(dt) {
      this.trauma = Math.max(0, this.trauma - dt * 1.6);
      this._t += dt;
      // integrate + compact the array IN PLACE (no per-frame reallocation): walk with a write
      // cursor and keep only the still-alive particles. avoids churning a fresh array every frame.
      const ps = this.particles; let w = 0;
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        p.life -= dt;
        if (p.vx != null) { p.x += p.vx * dt; p.y += p.vy * dt; }
        if (p.type === 'dust' || p.type === 'spark') { p.vy += 220 * dt; p.vx *= 0.96; }
        else if (p.type === 'chunk') { p.vy += 900 * dt; p.vx *= 0.99; p.rot += p.vr * dt; }
        if (p.life > 0) ps[w++] = p;
      }
      ps.length = w;
      if (ps.length > MAX_PARTICLES) this._cap();
      const ts = this.texts; let tw = 0;
      for (let i = 0; i < ts.length; i++) { const t = ts[i]; t.life -= dt; t.y -= 34 * dt; if (t.life > 0) ts[tw++] = t; }
      ts.length = tw;
    }

    // over the cap → drop the oldest CHEAP particles (front of the array = oldest) until under it,
    // leaving the dramatic shapes alone. compacts in place, preserving order.
    _cap() {
      const ps = this.particles; let drop = ps.length - MAX_PARTICLES, w = 0;
      for (let i = 0; i < ps.length; i++) {
        if (drop > 0 && CHEAP[ps[i].type]) { drop--; continue; }
        ps[w++] = ps[i];
      }
      ps.length = w;
    }

    shakeOffset() {
      if (this.trauma <= 0) return { x: 0, y: 0, r: 0 };
      const s = this.trauma * this.trauma;
      const rnd = () => (Math.random() * 2 - 1);
      return { x: rnd() * 16 * s, y: rnd() * 16 * s, r: rnd() * 0.03 * s };
    }

    render(ctx) {
      const col = D.COL.ink;
      // one reused RNG for the numerous spark streaks instead of allocating a fresh one per
      // spark per frame (each makeRng = several closures → GC pressure during big bursts). The
      // shaped particles (star/ring/flash/dust) keep their own stable seeds so they look identical.
      const srnd = this._srnd || (this._srnd = DS.makeRng(3));
      const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)); // smoothstep ease
      // smooth in/out envelope over a particle's life (age 0→1): ease up over `inT`, ease
      // down over the last `outT` — so blasts fade in and out gently instead of popping.
      const env = (age, inT, outT) => smooth(Math.min(1, age / inT)) * smooth(Math.min(1, (1 - age) / outT));
      for (const p of this.particles) {
        const k = p.life / p.max;
        const pc = p.col || col; // particle colour (ink unless an ult/charge tinted it)
        ctx.globalAlpha = Math.min(1, k * 1.4);
        if (p.type === 'star') {
          const rnd = DS.makeRng(99);
          const spikes = 8, r = p.r * (1.15 - k * 0.15);
          const pts = [];
          for (let i = 0; i < spikes * 2; i++) {
            const rr = i % 2 ? r * 0.45 : r;
            const a = p.rot + (i / (spikes * 2)) * 6.283;
            pts.push([p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr]);
          }
          D.strokePts(ctx, pts, { width: 4, color: pc, rnd, closed: true, passes: 1 });
        } else if (p.type === 'spark') {
          D.line(ctx, p.x, p.y, p.x - p.vx * 0.03, p.y - p.vy * 0.03, { width: 3.5, color: pc, passes: 1, rnd: srnd });
        } else if (p.type === 'dust') {
          const rnd = DS.makeRng(((p.x | 0) * 13 + (p.y | 0) * 7) | 1);
          D.circle(ctx, p.x, p.y, p.r * (1.2 - k * 0.2), { width: 3, color: col, rnd, passes: 1, wob: 1.5 });
        } else if (p.type === 'smear') {
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.ang);
          for (let i = -1; i <= 1; i++) D.line(ctx, -p.len, i * 5, p.len, i * 5, { width: 3, color: col, passes: 1 });
          ctx.restore();
        } else if (p.type === 'ring') {
          // expanding shockwave ring
          const e = 1 - k;
          const r = p.r + (p.rmax - p.r) * smooth(e); // smooth expansion
          const rnd = DS.makeRng((p.rmax | 0) + 3);
          ctx.globalAlpha = (p.col ? 0.45 : 0.24) * env(e, 0.16, 0.6); // ult rings tinted but gentle
          D.circle(ctx, p.x, p.y, r, { width: 5, color: p.col || D.COL.accent, rnd, passes: 1, wob: 3 });
        } else if (p.type === 'flash') {
          // a quick flash ring at the contact point
          const r = p.r * (1.5 - k * 0.5);
          const rnd = DS.makeRng(p.seed || 5);
          ctx.globalAlpha = (p.col ? 0.55 : 0.3) * env(1 - k, 0.18, 0.6);
          D.circle(ctx, p.x, p.y, r, { width: 6, color: p.col || D.COL.accent, rnd, passes: 1, wob: 3 });
          D.circle(ctx, p.x, p.y, r * 0.58, { width: 3, color: p.col ? D.mix(p.col, D.COL.ink, 0.4) : col, rnd, passes: 1, wob: 2 });
        } else if (p.type === 'beam') {
          // a flame plume blasting along p.ang: a tight fan of flickering tongues, each NARROW
          // at the contact point (the nozzle) and flaring out to a licking tip. Each colour
          // layer is filled as ONE unioned path so overlapping tongues don't compound opacity
          // (that's what kept it looking solid) — the low alpha now actually reads.
          const age = 1 - k;
          // telescoping length: each layer extends OUT from the nozzle, holds, then retracts
          // back IN (length → 0), staggered so the plume reaches out and collapses in a
          // cascade — the in/out is real motion, not just an opacity fade.
          const tele = (t0, t1, t2, t3) => p.len * smooth((age - t0) / (t1 - t0)) * (1 - smooth((age - t2) / (t3 - t2)));
          const Lo = tele(0.10, 0.42, 0.50, 0.84); // outer: reaches last, collapses first
          const Lm = tele(0.05, 0.32, 0.60, 0.92); // mid
          const Lc = tele(0.00, 0.22, 0.70, 1.00); // core: reaches first, collapses last
          const mkPts = (a, tl, w) => {
            const ca = Math.cos(a), sa = Math.sin(a);
            const P = (d, o) => [p.x + ca * d - sa * o, p.y + sa * d + ca * o];
            return [P(0, -w * 0.10), P(tl * 0.34, -w * 0.55), P(tl * 0.7, -w * 0.42), P(tl, 0),
              P(tl * 0.7, w * 0.42), P(tl * 0.34, w * 0.55), P(0, w * 0.10)];
          };
          // fill all tongues of one colour in a single fill() so overlaps stay flat, not stacked
          const layer = (tongues, fill, alpha) => {
            ctx.beginPath();
            for (const pts of tongues) {
              ctx.moveTo(pts[0][0], pts[0][1]);
              for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
              ctx.closePath();
            }
            ctx.globalAlpha = alpha; ctx.fillStyle = fill; ctx.fill();
            ctx.globalAlpha = Math.min(0.5, alpha * 1.5);
            ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
          };
          const SP = 0.22;                                  // fan half-arc (rad) — tight, mostly straight
          const outer = [], mid = [], core = [];
          for (let i = 0; i < 11; i++) {
            const u = (i / 10) * 2 - 1, fl = 1 + 0.24 * Math.sin(this._t * 26 + i * 1.7);
            outer.push(mkPts(p.ang + u * SP, Lo * (0.5 + 0.5 * (1 - Math.abs(u))) * fl, 30 + 32 * p.power));
          }
          for (let i = 0; i < 7; i++) {
            const u = (i / 6) * 2 - 1, fl = 1 + 0.2 * Math.sin(this._t * 31 + i * 2.1);
            mid.push(mkPts(p.ang + u * SP * 0.72, Lm * (0.5 + 0.4 * (1 - Math.abs(u))) * fl * 0.84, 18 + 22 * p.power));
          }
          for (let i = 0; i < 4; i++) {
            const u = (i / 3) * 2 - 1;
            core.push(mkPts(p.ang + u * SP * 0.4, Lc * 0.52 * (0.7 + 0.3 * (1 - Math.abs(u))), 10 + 12 * p.power));
          }
          const a0 = env(age, 0.06, 0.12); // only a brief edge-softening — the telescoping does the in/out
          layer(outer, D.COL.accent, 0.2 * a0);
          layer(mid, '#e89a48', 0.18 * a0);
          layer(core, D.COL.paper, 0.22 * a0);
        } else if (p.type === 'chunk') {
          const rnd = DS.makeRng(((p.x | 0) * 17 + (p.y | 0) * 5) | 1);
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          const s = p.size;
          D.strokePts(ctx, [[-s, -s * 0.7], [s, -s * 0.8], [s * 0.8, s * 0.7], [-s * 0.9, s]], { width: 3, color: col, rnd, closed: true, fill: D.COL.paper, passes: 1 });
          ctx.restore();
        } else if (p.type === 'spike') {
          // a jagged shard erupting upward from the ground, popping up fast then fading
          const grow = Math.min(1, (1 - k) / 0.28);
          const hh = p.h * (grow * grow * (3 - 2 * grow));
          const rnd = DS.makeRng((p.seed || 9) | 1);
          D.strokePts(ctx, [[p.x - p.w, p.y], [p.x + p.lean, p.y - hh], [p.x + p.w, p.y]],
            { width: 3.5, color: col, rnd, closed: true, fill: D.COL.paperShade, passes: 1 });
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  DS.Effects = Effects;
})(window);
