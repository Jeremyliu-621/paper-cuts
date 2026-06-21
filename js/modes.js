// Game modes + map presets. Both are small data-driven registries so new content
// is additive: a mode is a set of hooks the Game calls; a map is a stage builder.
//
// MODE hooks (all optional except where noted), called by DS.Game with (game, ...):
//   elimination  bool   — true: running out of stocks ends the match (Smash). false: infinite respawns.
//   usesTimer    bool   — true: the match countdown runs and can end the match by score.
//   setup(game)         — REQUIRED. init per-match runtime state on game.modeState.
//   update(game, dt)    — per-frame logic; set game.winner + game.state='over' to end.
//   renderWorld(game,ctx)— world-space drawing (gems, the hill), inside the camera transform.
//   portraitScore(game,f)— short score string drawn by the HUD under a non-elimination portrait.
//   overText(game)      — headline for the game-over overlay.
//   onKO(game, victim)  — called from Fighter._ko when a fighter is knocked out.
//
// MAP: { id, name, desc, editable?, build(data) -> { platforms, spawns, decor } }.
// 'editable' maps reuse the live, Editor-owned data.stage; presets build fresh geometry
// in the 1920x1080 view space (ground top ~880, fighters are 74px tall).
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;

  // ---- power-up props (used by the "Power-Up Mayhem" mode) ------------------
  // Each prop is a held item that hijacks a fighter's next F (attack). `action` is a normal
  // move-data object (the same shape as a character action) fed straight into the fighter via
  // _useItem → _startAction(dataOverride), so all the existing combat/pose/render plumbing works.
  // `weapon` names the in-hand doodle; `uses` is how many times you can fire it before it's spent.
  const ITEMS = {
    _order: ['bat', 'blaster', 'scatter', 'bomb'],
    defs: {
      // the home-run hitter: ONE swing, but huge damage and a colossal launch — a near-guaranteed KO
      bat: {
        key: 'bat', name: 'Bat', uses: 1, icon: 'bat',
        action: { name: 'bat', weapon: 'bat', startup: 4, active: 5, recovery: 14, cooldown: 0.42,
          hit: { x: 56, y: -6, r: 58, damage: 24, kbBase: 82, kbScale: 0.30, angle: 35 } },
      },
      // rapid-fire AK: a handful of fast, light shots
      blaster: {
        key: 'blaster', name: 'Blaster', uses: 4, icon: 'rifle',
        action: { name: 'gun', weapon: 'rifle', startup: 1, active: 2, recovery: 6, cooldown: 0.2,
          projectile: { speed: 1600, damage: 7, kbBase: 15, kbScale: 0.09, angle: 0, gravity: 0, life: 1.1, r: 10 } },
      },
      // shotgun: a fan of short-range pellets — devastating point-blank
      scatter: {
        key: 'scatter', name: 'Scatter', uses: 2, icon: 'shotgun',
        action: { name: 'shotgun', weapon: 'shotgun', startup: 3, active: 2, recovery: 15, cooldown: 0.55,
          pellets: 5, spread: 9,
          projectile: { speed: 1380, damage: 5, kbBase: 16, kbScale: 0.11, angle: 0, gravity: 0, life: 0.42, r: 9 } },
      },
      // lobbed bomb: ONE throw — rockets out in a big high arc and BOUNCES Mario-style off the
      // stage until it clips someone (or its bounces run out), then detonates. Heavy hit.
      bomb: {
        key: 'bomb', name: 'Bomb', uses: 1, icon: 'bomb',
        action: { name: 'bomb', weapon: 'bomb', startup: 6, active: 3, recovery: 18, cooldown: 0.7,
          projectile: { cannon: true, bounce: 4, speed: 1200, damage: 20, kbBase: 44, kbScale: 0.2, angle: 60, gravity: 2800, life: 5, r: 22 } },
      },
    },
    rand() { const o = this._order; return this.defs[o[(Math.random() * o.length) | 0]]; },
  };

  // a floating pickup: a big, centred prop emblem inside a glowing bubble that bobs + twinkles.
  // (purpose-built icons — the in-hand weapon() art is positioned for being held, not centred.)
  function drawPickup(ctx, it) {
    const c = D.COL.accent, ink = D.COL.ink, shade = D.COL.paperShade;
    const R = it.r, yb = it.y + Math.sin(it.bob) * 5;
    ctx.save(); ctx.translate(it.x, yb);
    // soft glow halo
    ctx.globalAlpha = 0.16; D.circle(ctx, 0, 0, R * 1.5, { width: 4, color: c, rnd: DS.makeRng(3), passes: 1 }); ctx.globalAlpha = 1;
    // four little twinkle ticks around the bubble, pulsing with the bob
    ctx.save(); ctx.globalAlpha = 0.45 + 0.4 * Math.sin(it.bob * 1.7); ctx.strokeStyle = c; ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) { const a = it.bob * 0.4 + i * 1.571, rr = R * 1.28; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); ctx.lineTo(Math.cos(a) * (rr + 6), Math.sin(a) * (rr + 6)); ctx.stroke(); }
    ctx.restore();
    // the bubble: a faintly accent-tinted disc with a sketchy accent ring
    D.circle(ctx, 0, 0, R, { width: 4.5, color: c, rnd: DS.makeRng(5), fill: D.mix(D.COL.paper, c, 0.12) });
    // the prop emblem — centred and bold, sized to fill the bubble
    const key = it.key;
    ctx.save();
    if (key === 'bat') {
      ctx.rotate(-0.62); const BL = 21, hw = 7; // diagonal bat, centred on the grip
      D.strokePts(ctx, [[-4, BL], [4, BL], [hw, -BL], [-hw, -BL]], { width: 4, color: ink, rnd: DS.makeRng(7), closed: true, fill: shade });
      D.circle(ctx, 0, -BL, 7.5, { width: 4, color: ink, rnd: DS.makeRng(8), fill: shade }); // barrel end
      D.circle(ctx, 0, BL, 5, { width: 3.5, color: ink, rnd: DS.makeRng(9), fill: D.COL.paper }); // knob
    } else if (key === 'blaster') {
      // compact AK silhouette: stock + receiver + barrel + front sight + curved banana mag
      const rnd = DS.makeRng(11); ctx.translate(-3, -4);
      D.strokePts(ctx, [[-22, -2], [-12, 0], [-12, 5], [-22, 3]], { width: 3.5, color: ink, rnd, closed: true, fill: shade }); // stock
      D.strokePts(ctx, [[-12, -5], [12, -5], [12, 4], [-12, 4]], { width: 4, color: ink, rnd, closed: true, fill: shade }); // receiver
      D.line(ctx, 12, -3, 27, -3, { width: 4, color: ink, rnd, passes: 1 }); // barrel
      D.line(ctx, 24, -7, 24, -1, { width: 3, color: ink, rnd, passes: 1 }); // front sight
      D.strokePts(ctx, [[-1, 4], [9, 4], [14, 19], [5, 20]], { width: 4, color: ink, rnd, closed: true, fill: shade }); // banana mag
      D.strokePts(ctx, [[-9, 4], [-2, 4], [-6, 15], [-12, 14]], { width: 3.5, color: ink, rnd, closed: true, fill: D.COL.paper }); // grip
    } else if (key === 'scatter') {
      // compact double-barrel shotgun: stock + breech + two stacked barrels + grip
      const rnd = DS.makeRng(12); ctx.translate(-1, -3);
      D.strokePts(ctx, [[-20, -1], [-10, 1], [-10, 8], [-20, 6]], { width: 3.5, color: ink, rnd, closed: true, fill: shade }); // stock
      D.strokePts(ctx, [[-10, -6], [-2, -6], [-2, 8], [-10, 8]], { width: 4, color: ink, rnd, closed: true, fill: shade }); // breech
      D.strokePts(ctx, [[-2, -6], [22, -6], [22, -1], [-2, -1]], { width: 3.5, color: ink, rnd, closed: true, fill: D.COL.paper }); // top barrel
      D.strokePts(ctx, [[-2, 0], [22, 0], [22, 5], [-2, 5]], { width: 3.5, color: ink, rnd, closed: true, fill: D.COL.paper }); // bottom barrel
      D.circle(ctx, 21, -3.5, 2.4, { width: 2.5, color: ink, rnd, fill: ink }); // top bore
      D.circle(ctx, 21, 2.5, 2.4, { width: 2.5, color: ink, rnd, fill: ink }); // bottom bore
      D.strokePts(ctx, [[-6, 8], [1, 8], [-3, 18], [-10, 17]], { width: 4, color: ink, rnd, closed: true, fill: D.COL.paper }); // grip
    } else if (key === 'bomb') {
      const rnd = DS.makeRng(13);
      D.circle(ctx, 0, 6, 17, { width: 4.5, color: ink, rnd, fill: D.mix(ink, D.COL.paper, 0.55) }); // body
      D.circle(ctx, -6, 0, 4.5, { width: 0, color: D.COL.paper, fill: D.COL.paper }); // shine
      D.strokePts(ctx, [[-5, -10], [5, -10], [4, -16], [-4, -16]], { width: 3.5, color: ink, rnd, closed: true, fill: shade }); // cap
      D.line(ctx, 0, -16, 10, -27, { width: 4, color: c, rnd, passes: 1 }); // fuse
      D.circle(ctx, 10, -27, 3, { width: 0, color: c, fill: c }); // spark
    }
    ctx.restore();
    ctx.restore();
  }

  // a small "armed" tag above a fighter holding a prop: name + remaining uses, in player colour
  function drawHeldTag(ctx, f) {
    const c = f.tagCol || D.COL.accent, it = f.item;
    const x = f.x, y = f.y - f.h / 2 - 104; // above the P# name marker
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = "24px 'Patrick Hand', sans-serif"; ctx.lineJoin = 'round';
    ctx.lineWidth = 5; ctx.strokeStyle = D.COL.paper;
    const msg = it.name + ' ×' + it.left;
    ctx.strokeText(msg, x, y); ctx.fillStyle = c; ctx.fillText(msg, x, y);
    ctx.restore();
  }

  // ---- maps ----------------------------------------------------------------
  const Maps = {
    _order: ['meadow', 'twin', 'loft', 'quarry', 'ruins', 'crates', 'bounce', 'cannons', 'portals', 'chaos'],
    defs: {
      meadow: {
        id: 'meadow', name: 'Meadow', editable: true,
        desc: 'A sunny field with rolling hills, trees and a flower-strewn ground. The stage the Editor edits.',
      },

      // Two stone mesas over a deep chasm, crossed by stepping planks and a swinging
      // rope-bridge; a high stone perch up top; crates to smash. Mountains + a keep behind.
      twin: {
        id: 'twin', name: 'Twin Peaks',
        desc: 'Stone mesas across a chasm, linked by a swinging rope-bridge. Smash the crates, fight for the high perch.',
        build() {
          return {
            bounds: { x0: -320, y0: -220, x1: 2240, y1: 1280 },
            platforms: [
              { x: -200, y: 980, w: 760, h: 300, kind: 'stone', pass: false }, // left mesa
              { x: 1360, y: 980, w: 760, h: 300, kind: 'stone', pass: false }, // right mesa
              { x: 520,  y: 800, w: 180, h: 26, kind: 'wood', pass: true },     // stepping planks
              { x: 1220, y: 800, w: 180, h: 26, kind: 'wood', pass: true },
              { x: 760,  y: 430, w: 400, h: 34, kind: 'stone', pass: true },    // high perch (KotH hill)
              // swinging rope-bridge plank across the chasm
              { x: 860, y: 640, w: 210, h: 26, kind: 'wood', pass: true, move: { type: 'swing', pivotX: 960, pivotY: 300, len: 352, arc: 0.5, period: 3.4 } },
              // breakable crates stacked on the mesas
              { x: 110, y: 900, w: 80, h: 80, kind: 'box', pass: false, hp: 3 },
              { x: 110, y: 820, w: 80, h: 80, kind: 'box', pass: false, hp: 3 },
              { x: 1900, y: 900, w: 80, h: 80, kind: 'box', pass: false, hp: 3 },
            ],
            spawns: [{ x: 200, y: 880 }, { x: 1720, y: 880 }],
            bg: [
              { type: 'mountain', x: 240, y: 1010, w: 760, h: 560, s: 1, a: 0.32 },
              { type: 'mountain', x: 1740, y: 1010, w: 820, h: 620, s: 1, a: 0.3 },
              { type: 'tower', x: 960, y: 1010, w: 230, h: 600, s: 1, a: 0.42 }, // keep whose top meets the perch
              { type: 'hill', x: 1000, y: 1020, w: 1500, h: 240, s: 1, a: 0.2 },
            ],
            decor: [
              { type: 'cloud', x: 320, y: 150, s: 1.6 }, { type: 'cloud', x: 1640, y: 200, s: 1.8 },
              { type: 'pine', x: 60, y: 980, s: 1.5 }, { type: 'pine', x: 1840, y: 980, s: 1.4 },
              { type: 'bush', x: 430, y: 968, s: 1.4 }, { type: 'bush', x: 1500, y: 968, s: 1.4 },
              { type: 'grass', x: 300, y: 975, s: 1.4 }, { type: 'grass', x: 1660, y: 975, s: 1.4 },
              { type: 'vine', x: 820, y: 462, s: 1 }, { type: 'vine', x: 1100, y: 462, s: 1 },
            ],
          };
        },
      },

      // Floating wooden platforms in the clouds, a swinging plank, a crystal top tier,
      // hanging vines and sky-islands behind. No big ground — fall and you're gone.
      loft: {
        id: 'loft', name: 'Sky Loft',
        desc: 'Wooden platforms adrift in the clouds with a swinging plank and a crystal summit. Mind the long drop.',
        build() {
          return {
            bounds: { x0: -260, y0: -320, x1: 2180, y1: 1320 },
            platforms: [
              { x: 760, y: 1060, w: 400, h: 150, kind: 'wood', pass: false }, // central base
              { x: 120, y: 880, w: 300, h: 28, kind: 'wood', pass: true },    // low sides
              { x: 1500, y: 880, w: 300, h: 28, kind: 'wood', pass: true },
              { x: 430, y: 700, w: 260, h: 28, kind: 'wood', pass: true },    // mid
              { x: 1230, y: 700, w: 260, h: 28, kind: 'wood', pass: true },
              { x: 800, y: 330, w: 320, h: 30, kind: 'crystal', pass: true }, // crystal summit (KotH hill)
              { x: 860, y: 560, w: 200, h: 26, kind: 'wood', pass: true, move: { type: 'swing', pivotX: 960, pivotY: 235, len: 338, arc: 0.55, period: 3 } },
              { x: 250, y: 820, w: 70, h: 70, kind: 'box', pass: false, hp: 2 },
              { x: 1600, y: 820, w: 70, h: 70, kind: 'box', pass: false, hp: 2 },
            ],
            spawns: [{ x: 860, y: 980 }, { x: 1060, y: 980 }],
            bg: [
              { type: 'skyisland', x: 300, y: 520, w: 460, h: 150, s: 1, a: 0.32 },
              { type: 'skyisland', x: 1640, y: 460, w: 520, h: 170, s: 1, a: 0.3 },
              { type: 'tower', x: 960, y: 1080, w: 200, h: 560, s: 1, a: 0.36 },
            ],
            decor: [
              { type: 'cloud', x: 240, y: 220, s: 1.8 }, { type: 'cloud', x: 1680, y: 180, s: 1.6 },
              { type: 'cloud', x: 980, y: 120, s: 1.4 }, { type: 'cloud', x: 700, y: 740, s: 1.2 },
              { type: 'vine', x: 170, y: 906, s: 1 }, { type: 'vine', x: 1560, y: 906, s: 1 },
              { type: 'vine', x: 470, y: 726, s: 1.1 }, { type: 'vine', x: 1290, y: 726, s: 1.1 },
              { type: 'mushroom', x: 880, y: 1058, s: 1.3 }, { type: 'grass', x: 1020, y: 1062, s: 1.3 },
            ],
          };
        },
      },

      // A wide stone quarry floor with crystal ledges, a rising elevator, a raised center
      // and a wall of crates. Sheer quarry walls and a crane behind.
      quarry: {
        id: 'quarry', name: 'Quarry',
        desc: 'A broad stone floor with crystal ledges, a rising elevator and a wall of crates to smash through.',
        build() {
          return {
            bounds: { x0: -300, y0: -200, x1: 2220, y1: 1280 },
            platforms: [
              { x: -200, y: 1000, w: 2320, h: 260, kind: 'stone', pass: false }, // wide floor
              { x: 150, y: 760, w: 320, h: 32, kind: 'crystal', pass: true },     // left ledge
              { x: 1450, y: 760, w: 320, h: 32, kind: 'crystal', pass: true },    // right ledge
              { x: 800, y: 540, w: 320, h: 34, kind: 'stone', pass: true },       // raised center (KotH hill)
              // vertical elevator on the left, horizontal trolley on the right
              { x: 540, y: 820, w: 200, h: 26, kind: 'wood', pass: true, move: { type: 'linear', ax: 540, ay: 840, bx: 540, by: 560, period: 4.5 } },
              { x: 1180, y: 820, w: 200, h: 26, kind: 'wood', pass: true, move: { type: 'linear', ax: 1120, ay: 820, bx: 1500, by: 820, period: 5 } },
              // a breakable crate wall on the floor
              { x: 920, y: 920, w: 80, h: 80, kind: 'box', pass: false, hp: 2 },
              { x: 1000, y: 920, w: 80, h: 80, kind: 'box', pass: false, hp: 2 },
              { x: 960, y: 840, w: 80, h: 80, kind: 'box', pass: false, hp: 3 },
            ],
            spawns: [{ x: 360, y: 900 }, { x: 1560, y: 900 }],
            bg: [
              { type: 'building', x: 280, y: 1010, w: 360, h: 620, s: 1, a: 0.3 },
              { type: 'building', x: 1660, y: 1010, w: 320, h: 560, s: 1, a: 0.28 },
              { type: 'tower', x: 960, y: 1010, w: 200, h: 720, s: 1, a: 0.34 },
              { type: 'mountain', x: 1000, y: 1020, w: 2000, h: 360, s: 1, a: 0.16 },
            ],
            decor: [
              { type: 'cloud', x: 360, y: 190, s: 1.6 }, { type: 'cloud', x: 1560, y: 230, s: 1.7 },
              { type: 'reeds', x: 220, y: 998, s: 1.4 }, { type: 'reeds', x: 1700, y: 998, s: 1.4 },
              { type: 'flower', x: 460, y: 996, s: 1.4 }, { type: 'bush', x: 1300, y: 990, s: 1.4 },
              { type: 'grass', x: 720, y: 998, s: 1.4 }, { type: 'grass', x: 1180, y: 998, s: 1.4 },
            ],
          };
        },
      },

      // Ancient ruins: two stone terraces over a central pit, column-top platforms that
      // line up under broken arches, a swinging gate, and rubble crates to break.
      ruins: {
        id: 'ruins', name: 'Ruins',
        desc: 'Crumbling stone terraces over a pit, with column-top ledges beneath broken arches and a swinging gate.',
        build() {
          return {
            bounds: { x0: -360, y0: -240, x1: 2440, y1: 1280 },
            platforms: [
              { x: -260, y: 980, w: 1000, h: 300, kind: 'stone', pass: false }, // left terrace
              { x: 1300, y: 980, w: 1000, h: 300, kind: 'stone', pass: false }, // right terrace (pit between 740..1300)
              { x: 470, y: 700, w: 240, h: 32, kind: 'stone', pass: true },     // column-top ledges
              { x: 1330, y: 700, w: 240, h: 32, kind: 'stone', pass: true },
              { x: 850, y: 470, w: 360, h: 34, kind: 'stone', pass: true },     // high altar (KotH hill)
              // swinging gate across the pit
              { x: 920, y: 680, w: 200, h: 26, kind: 'wood', pass: true, move: { type: 'swing', pivotX: 1020, pivotY: 320, len: 372, arc: 0.5, period: 3.6 } },
              // rubble crates
              { x: 200, y: 900, w: 80, h: 80, kind: 'box', pass: false, hp: 3 },
              { x: 1760, y: 900, w: 80, h: 80, kind: 'box', pass: false, hp: 3 },
              { x: 1840, y: 900, w: 80, h: 80, kind: 'box', pass: false, hp: 2 },
            ],
            spawns: [{ x: 260, y: 880 }, { x: 1780, y: 880 }],
            bg: [
              { type: 'arch', x: 590, y: 700, w: 360, h: 230, s: 1, a: 0.4 },   // arches framing the column ledges
              { type: 'arch', x: 1450, y: 700, w: 360, h: 230, s: 1, a: 0.4 },
              { type: 'arch', x: 1030, y: 470, w: 480, h: 300, s: 1, a: 0.42 }, // big arch over the altar
              { type: 'mountain', x: 200, y: 1010, w: 720, h: 480, s: 1, a: 0.22 },
              { type: 'mountain', x: 1840, y: 1010, w: 760, h: 520, s: 1, a: 0.2 },
            ],
            decor: [
              { type: 'cloud', x: 360, y: 170, s: 1.6 }, { type: 'cloud', x: 1700, y: 210, s: 1.7 },
              { type: 'vine', x: 510, y: 728, s: 1.1 }, { type: 'vine', x: 1450, y: 728, s: 1.1 },
              { type: 'vine', x: 900, y: 500, s: 1 }, { type: 'vine', x: 1120, y: 500, s: 1 },
              { type: 'reeds', x: 360, y: 975, s: 1.4 }, { type: 'bush', x: 1560, y: 968, s: 1.4 },
              { type: 'mushroom', x: 620, y: 975, s: 1.2 },
            ],
          };
        },
      },

      // ===== TWIST MAPS (big arenas, each with a gimmick) ====================================

      // Crate Yard — the WHOLE stage is breakable crates. Smash through the floor, the cover,
      // everything; the arena literally crumbles as you fight.
      crates: {
        id: 'crates', name: 'Crate Yard',
        desc: 'Every surface is a breakable crate — the floor, the cover, all of it. Smash the stage apart beneath your rival. The yard crumbles as you fight.',
        build() {
          const plats = [], bw = 96, floorY = 980, left = -300, right = 2900;
          // deep floor: two box courses (the lower one is tougher) so it doesn't vanish instantly
          for (let x = left; x < right; x += bw) {
            plats.push({ x, y: floorY, w: bw - 4, h: 130, kind: 'box', pass: false, hp: 7 });
            plats.push({ x, y: floorY + 130, w: bw - 4, h: 130, kind: 'box', pass: false, hp: 12 });
          }
          // cover stacks on the floor
          [[300, 3], [820, 4], [1500, 3], [2120, 4], [2520, 3]].forEach(([sx, n]) => {
            for (let k = 0; k < n; k++) plats.push({ x: sx, y: floorY - (k + 1) * 84, w: 80, h: 80, kind: 'box', pass: false, hp: 3 });
          });
          // jump-through crate platforms up high (to fight on as the floor erodes)
          [[560, 720], [1180, 600], [1820, 720], [1000, 440], [1560, 440], [2300, 600]].forEach(([x, y]) => {
            for (let k = 0; k < 3; k++) plats.push({ x: x + k * 82, y, w: 78, h: 78, kind: 'box', pass: true, hp: 3 });
          });
          return {
            bounds: { x0: left - 220, y0: -340, x1: right + 220, y1: 1500 },
            platforms: plats,
            spawns: [{ x: 160, y: 860 }, { x: 2620, y: 860 }, { x: 1060, y: 320 }, { x: 1880, y: 600 }, { x: 600, y: 600 }, { x: 2360, y: 480 }],
            bg: [
              { type: 'building', x: 360, y: 1010, w: 420, h: 640, s: 1, a: 0.28 },
              { type: 'building', x: 2480, y: 1010, w: 460, h: 700, s: 1, a: 0.26 },
              { type: 'tower', x: 1300, y: 1010, w: 220, h: 760, s: 1, a: 0.3 },
            ],
            decor: [
              { type: 'cloud', x: 500, y: 200, s: 1.7 }, { type: 'cloud', x: 1700, y: 150, s: 1.9 }, { type: 'cloud', x: 2500, y: 240, s: 1.6 },
            ],
          };
        },
      },

      // Big Bounce — a GIANT trampoline fills the central gap. Fall in and you rocket sky-high
      // toward the upper platforms; KO each other off the top or punt them past the sides.
      bounce: {
        id: 'bounce', name: 'Big Bounce',
        desc: 'A giant trampoline fills the pit in the middle — fall in and you ROCKET skyward toward the upper tiers. The harder you land, the higher you fly.',
        build() {
          return {
            bounds: { x0: -440, y0: -520, x1: 3000, y1: 1360 },
            platforms: [
              { x: -360, y: 1000, w: 1180, h: 320, kind: 'stone', pass: false }, // left ground
              { x: 1820, y: 1000, w: 1180, h: 320, kind: 'stone', pass: false }, // right ground
              // the giant trampoline, slung low across the central pit
              { x: 880, y: 1080, w: 760, h: 64, kind: 'trampoline', pass: false, bounce: 1320 },
              { x: 470, y: 640, w: 320, h: 28, kind: 'wood', pass: true },     // mid launch pads
              { x: 1730, y: 640, w: 320, h: 28, kind: 'wood', pass: true },
              { x: 1010, y: 700, w: 300, h: 28, kind: 'wood', pass: true },    // centre catch
              { x: 1010, y: 400, w: 500, h: 32, kind: 'crystal', pass: true }, // high summit (KotH hill)
            ],
            spawns: [{ x: 240, y: 900 }, { x: 2280, y: 900 }, { x: 560, y: 560 }, { x: 1900, y: 560 }, { x: 1160, y: 320 }, { x: 1160, y: 620 }],
            bg: [
              { type: 'mountain', x: 300, y: 1020, w: 820, h: 560, s: 1, a: 0.22 },
              { type: 'mountain', x: 2260, y: 1020, w: 880, h: 620, s: 1, a: 0.2 },
              { type: 'tower', x: 1260, y: 1020, w: 210, h: 640, s: 1, a: 0.34 },
            ],
            decor: [
              { type: 'cloud', x: 360, y: 200, s: 1.8 }, { type: 'cloud', x: 1280, y: 110, s: 1.5 }, { type: 'cloud', x: 2300, y: 230, s: 1.7 },
              { type: 'bush', x: 520, y: 988, s: 1.4 }, { type: 'bush', x: 2080, y: 988, s: 1.4 },
              { type: 'grass', x: 300, y: 995, s: 1.4 }, { type: 'grass', x: 2300, y: 995, s: 1.4 },
            ],
          };
        },
      },

      // Crossfire — a battery of CANNONS in the middle sweeps the whole arena with cannonballs.
      // Time your crossings, use the crates for cover, and bait rivals into the line of fire.
      cannons: {
        id: 'cannons', name: 'Crossfire',
        desc: 'A battery of cannons in the middle rakes the whole stage with cannonballs — low sweeps and high salvos. Use cover, time your crossings, and bait rivals into the line of fire.',
        build() {
          return {
            bounds: { x0: -420, y0: -300, x1: 3020, y1: 1320 },
            platforms: [
              { x: -360, y: 1000, w: 3260, h: 320, kind: 'stone', pass: false }, // wide floor
              { x: 1380, y: 540, w: 160, h: 480, kind: 'stone', pass: false },    // central tower the battery clings to
              // low cannons — sweep the floor at body height (jump to clear)
              { x: 1296, y: 912, w: 86, h: 52, kind: 'cannon', pass: false, fire: { deg: 180, every: 2.0, speed: 880, damage: 11, kbBase: 32, kbScale: 0.12, r: 26, delay: 0.0 } },
              { x: 1538, y: 912, w: 86, h: 52, kind: 'cannon', pass: false, fire: { deg: 0, every: 2.0, speed: 880, damage: 11, kbBase: 32, kbScale: 0.12, r: 26, delay: 1.0 } },
              // high cannons — salvos across the upper lanes (slightly downward)
              { x: 1316, y: 540, w: 86, h: 50, kind: 'cannon', pass: false, fire: { deg: 172, every: 2.6, speed: 800, damage: 10, kbBase: 30, kbScale: 0.12, r: 24, delay: 0.7 } },
              { x: 1518, y: 540, w: 86, h: 50, kind: 'cannon', pass: false, fire: { deg: 8, every: 2.6, speed: 800, damage: 10, kbBase: 30, kbScale: 0.12, r: 24, delay: 1.7 } },
              { x: 360, y: 740, w: 320, h: 32, kind: 'crystal', pass: true },  // side perches / escape
              { x: 1900, y: 740, w: 320, h: 32, kind: 'crystal', pass: true },
              { x: 820, y: 900, w: 84, h: 84, kind: 'box', pass: false, hp: 4 }, // cover crates
              { x: 1996, y: 900, w: 84, h: 84, kind: 'box', pass: false, hp: 4 },
            ],
            spawns: [{ x: 200, y: 900 }, { x: 2600, y: 900 }, { x: 460, y: 660 }, { x: 2000, y: 660 }, { x: 760, y: 900 }, { x: 2080, y: 900 }],
            bg: [
              { type: 'building', x: 360, y: 1010, w: 380, h: 560, s: 1, a: 0.28 },
              { type: 'building', x: 2520, y: 1010, w: 360, h: 600, s: 1, a: 0.26 },
              { type: 'tower', x: 1460, y: 1010, w: 200, h: 720, s: 1, a: 0.32 },
            ],
            decor: [
              { type: 'cloud', x: 420, y: 200, s: 1.6 }, { type: 'cloud', x: 1500, y: 150, s: 1.8 }, { type: 'cloud', x: 2480, y: 220, s: 1.7 },
              { type: 'reeds', x: 260, y: 998, s: 1.4 }, { type: 'reeds', x: 2620, y: 998, s: 1.4 },
            ],
          };
        },
      },

      // Wormholes — split arena stitched together by PORTALS. Step in to flash across the map
      // (or loop up from a side ledge to the summit). Master the warps to chase and escape.
      portals: {
        id: 'portals', name: 'Wormholes',
        desc: 'A stage split by a deep pit and stitched together by portals — flash across the map or loop up to the summit. Master the warps to chase, escape, and edge-guard.',
        build() {
          return {
            bounds: { x0: -440, y0: -360, x1: 3120, y1: 1340 },
            platforms: [
              { x: -360, y: 980, w: 960, h: 320, kind: 'stone', pass: false }, // left island
              { x: 2160, y: 980, w: 960, h: 320, kind: 'stone', pass: false }, // right island (deep pit between)
              { x: 1140, y: 760, w: 420, h: 30, kind: 'crystal', pass: true }, // floating centre ledge over the pit
              { x: 1230, y: 470, w: 240, h: 28, kind: 'wood', pass: true },    // centre top
              { x: 420, y: 700, w: 280, h: 28, kind: 'wood', pass: true },     // side ledges
              { x: 2040, y: 700, w: 280, h: 28, kind: 'wood', pass: true },
            ],
            // two portal pairs: blue = lateral (island ⇄ island), purple = vertical shuffle
            portals: [
              { id: 'a', link: 'b', x: 60, y: 860, r: 74, col: '#3f6fa0' },
              { id: 'b', link: 'a', x: 2760, y: 860, r: 74, col: '#3f6fa0' },
              { id: 'c', link: 'd', x: 1350, y: 420, r: 64, col: '#9a6cb0' },
              { id: 'd', link: 'c', x: 540, y: 640, r: 64, col: '#9a6cb0' },
            ],
            spawns: [{ x: 220, y: 860 }, { x: 2540, y: 860 }, { x: 1350, y: 700 }, { x: 1350, y: 400 }, { x: 480, y: 620 }, { x: 2120, y: 620 }],
            bg: [
              { type: 'skyisland', x: 360, y: 540, w: 480, h: 160, s: 1, a: 0.3 },
              { type: 'skyisland', x: 2520, y: 500, w: 520, h: 170, s: 1, a: 0.28 },
              { type: 'tower', x: 1340, y: 1020, w: 210, h: 700, s: 1, a: 0.32 },
            ],
            decor: [
              { type: 'cloud', x: 420, y: 220, s: 1.8 }, { type: 'cloud', x: 1380, y: 130, s: 1.5 }, { type: 'cloud', x: 2460, y: 240, s: 1.7 },
              { type: 'vine', x: 460, y: 726, s: 1.1 }, { type: 'vine', x: 2080, y: 726, s: 1.1 },
              { type: 'mushroom', x: 1200, y: 758, s: 1.3 },
            ],
          };
        },
      },

      // Pandemonium — the everything map. A central trampoline pit, a cannon perched above it
      // raking the floor, breakable cover, AND a portal pair across the whole arena. Go nuts.
      chaos: {
        id: 'chaos', name: 'Pandemonium',
        desc: 'Everything at once: a trampoline pit launching you skyward, a cannon raking the floor, crates to smash for cover, a bed of spikes to dodge, and a portal pair spanning the arena. Pure chaos.',
        build() {
          return {
            bounds: { x0: -520, y0: -560, x1: 3360, y1: 1380 },
            platforms: [
              { x: -440, y: 1000, w: 1180, h: 340, kind: 'stone', pass: false }, // left ground
              { x: 2100, y: 1000, w: 1240, h: 340, kind: 'stone', pass: false }, // right ground
              { x: 900, y: 1090, w: 660, h: 60, kind: 'trampoline', pass: false, bounce: 1240 }, // trampoline pit
              // a cannon on a mast over the pit, sweeping the right ground
              { x: 1140, y: 360, w: 170, h: 640, kind: 'stone', pass: false },   // central mast
              { x: 1150, y: 308, w: 84, h: 52, kind: 'cannon', pass: false, fire: { deg: 200, every: 2.3, speed: 820, damage: 11, kbBase: 32, kbScale: 0.13, r: 25, gravity: 520, delay: 0.4 } },
              { x: 1224, y: 308, w: 84, h: 52, kind: 'cannon', pass: false, fire: { deg: -20, every: 2.3, speed: 820, damage: 11, kbBase: 32, kbScale: 0.13, r: 25, gravity: 520, delay: 1.5 } },
              { x: 470, y: 640, w: 300, h: 28, kind: 'wood', pass: true },       // launch pads
              { x: 1760, y: 640, w: 300, h: 28, kind: 'wood', pass: true },
              { x: 980, y: 520, w: 360, h: 30, kind: 'crystal', pass: true },    // high summit
              { x: 300, y: 880, w: 84, h: 84, kind: 'box', pass: false, hp: 4 }, // cover
              { x: 2620, y: 880, w: 84, h: 84, kind: 'box', pass: false, hp: 4 },
              { x: 2536, y: 880, w: 84, h: 84, kind: 'box', pass: false, hp: 3 },
              { x: 2130, y: 952, w: 300, h: 48, kind: 'spikes', pass: false, hurt: { damage: 26, kbBase: 40, kbScale: 0.18, cooldown: 0.6 } }, // a bed of spikes on the right ground
            ],
            portals: [
              { id: 'x', link: 'y', x: -120, y: 880, r: 72, col: '#3f8f86' },
              { id: 'y', link: 'x', x: 3040, y: 880, r: 72, col: '#3f8f86' },
            ],
            spawns: [{ x: 220, y: 900 }, { x: 2760, y: 900 }, { x: 560, y: 560 }, { x: 1900, y: 560 }, { x: 1160, y: 440 }, { x: 1160, y: 900 }],
            bg: [
              { type: 'mountain', x: 320, y: 1020, w: 820, h: 600, s: 1, a: 0.2 },
              { type: 'mountain', x: 2520, y: 1020, w: 900, h: 660, s: 1, a: 0.18 },
              { type: 'tower', x: 1220, y: 1020, w: 220, h: 760, s: 1, a: 0.32 },
              { type: 'arch', x: 980, y: 520, w: 460, h: 280, s: 1, a: 0.36 },
            ],
            decor: [
              { type: 'cloud', x: 420, y: 200, s: 1.9 }, { type: 'cloud', x: 1400, y: 110, s: 1.5 }, { type: 'cloud', x: 2600, y: 240, s: 1.8 },
              { type: 'bush', x: 600, y: 988, s: 1.4 }, { type: 'pine', x: 2300, y: 988, s: 1.4 },
              { type: 'grass', x: 360, y: 995, s: 1.4 }, { type: 'mushroom', x: 940, y: 1088, s: 1.2 },
            ],
          };
        },
      },
    },
    isCustom(id) { return /^world-/.test(String(id || '')); },
    emptyStage(name) {
      return {
        name: name || 'Custom Level',
        bounds: { x0: 0, y0: 0, x1: DS.VIEW.w, y1: DS.VIEW.h },
        platforms: [],
        spawns: [{ x: 660, y: 780 }, { x: 1260, y: 780 }],
        bg: [],
        decor: [],
      };
    },
    stageFromDraft(draft, name) {
      draft = draft && typeof draft === 'object' ? draft : {};
      const st = this.emptyStage(name);
      if (Array.isArray(draft.platforms)) st.platforms = DS.data.clone(draft.platforms);
      if (Array.isArray(draft.spawns) && draft.spawns.length) st.spawns = DS.data.clone(draft.spawns);
      return st;
    },
    ensureCustomStage(data, id, name, draft) {
      if (!this.isCustom(id)) return null;
      if (!data.stages) data.stages = {};
      if (!data.stages[id]) data.stages[id] = this.stageFromDraft(draft, name);
      else if (name) data.stages[id].name = name;
      return data.stages[id];
    },
    has(id) { return !!this.defs[id] || this.isCustom(id); },
    get(id) {
      if (this.defs[id]) return this.defs[id];
      if (this.isCustom(id)) return { id, name: 'Custom Level', editable: true, custom: true };
      return this.defs.meadow;
    },
    list() { return this._order.map((id) => this.defs[id]); },

    // The editable, PERSISTENT stage for a map. Meadow is the live Editor-owned data.stage;
    // every preset is materialised from its build() ONCE into data.stages[id], then edits to it
    // stick (saved with the Store) — so all stages are editable, not just Meadow. The Game plays
    // a CLONE of this (so moving platforms / cannons / breakables during a match never mutate it).
    stageFor(data, id) {
      if (this.isCustom(id)) return this.ensureCustomStage(data, id);
      const map = this.get(id);
      if (map.editable || !map.build) return data.stage;
      if (!data.stages) data.stages = {};
      if (!data.stages[id]) data.stages[id] = map.build(data);
      return data.stages[id];
    },
    // restore one map's stage to its built-in default (Editor "Reset this stage")
    resetStage(data, id) {
      if (this.isCustom(id)) {
        data.stages = data.stages || {};
        data.stages[id] = this.emptyStage(data.stages[id] && data.stages[id].name);
        return data.stages[id];
      }
      const map = this.get(id);
      if (map.editable || !map.build) { data.stage = DS.data.defaults().stage; return data.stage; }
      data.stages = data.stages || {};
      data.stages[id] = map.build(data);
      return data.stages[id];
    },
  };

  // ---- small shared doodles ------------------------------------------------
  function crown(ctx, x, y, label) {
    const rnd = DS.makeRng(424);
    const c = D.COL.accent, w = 26, h = 18;
    const pts = [[x - w, y], [x - w, y - h], [x - w / 2, y - h * 0.4],
      [x, y - h * 1.3], [x + w / 2, y - h * 0.4], [x + w, y - h], [x + w, y]];
    D.strokePts(ctx, pts, { width: 4, color: c, rnd, closed: true, fill: D.COL.paper, passes: 1 });
    if (label) {
      ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = "20px 'Patrick Hand', sans-serif";
      ctx.fillText(label, x, y - h * 0.45);
    }
  }

  function gem(ctx, g) {
    const c = D.COL.accent;
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(Math.sin(g.spin) * 0.18); // gentle wobble, not a full spin
    const r = g.r, rnd = DS.makeRng(7);
    // faint glow behind so it reads as a pickup
    ctx.globalAlpha = 0.18; D.circle(ctx, 0, 0, r * 1.7, { width: 3, color: c, rnd, passes: 1 }); ctx.globalAlpha = 1;
    // diamond body
    const body = [[0, -r * 1.25], [r, -r * 0.2], [0, r * 1.25], [-r, -r * 0.2]];
    D.strokePts(ctx, body, { width: 4, color: D.COL.ink, rnd, closed: true, fill: D.COL.paper, passes: 1 });
    // facets
    D.line(ctx, -r, -r * 0.2, r, -r * 0.2, { width: 2.5, color: c, passes: 1 });
    D.line(ctx, 0, -r * 1.25, 0, r * 1.25, { width: 2.5, color: c, passes: 1 });
    // sparkle
    const tw = 0.6 + 0.4 * Math.sin(g.spin * 2);
    ctx.globalAlpha = tw;
    D.line(ctx, -r * 0.35, -r * 0.55, r * 0.1, -r * 0.55, { width: 2.5, color: c, passes: 1 });
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function highlightPlatform(ctx, p, controlled) {
    const c = D.COL.accent;
    ctx.save();
    if (controlled) { ctx.globalAlpha = 0.14; ctx.fillStyle = c; ctx.fillRect(p.x, p.y, p.w, p.h); ctx.globalAlpha = 1; }
    ctx.globalAlpha = 0.8; ctx.setLineDash([16, 12]); ctx.lineWidth = 4; ctx.strokeStyle = c;
    ctx.strokeRect(p.x + 2, p.y + 2, p.w - 4, p.h - 4);
    ctx.setLineDash([]); ctx.restore();
  }

  // ---- modes ---------------------------------------------------------------
  const Modes = {
    _order: ['smash', 'mayhem', 'koth', 'gems', 'bounty'],
    defs: {
      smash: {
        id: 'smash', name: 'Smash', win: 'Last fighter standing',
        desc: 'The classic. Knock your rival past the blast zone — last one with stocks left wins.',
        elimination: true, usesTimer: true,
        setup() { /* nothing extra: stocks/KO live on the fighters */ },
        update(game, dt) {
          game.checkOver();
          if (game.data.settings.timerSeconds > 0 && game.state === 'playing') {
            game.timer -= dt;
            if (game.timer <= 0) { game.timer = 0; game.finishByScore(); }
          }
        },
        overText(game) {
          const w = game.winner;
          return w ? 'P' + (w.pIndex + 1) + ' (' + w.name + ') wins!' : 'Draw!';
        },
      },

      // Power-Up Mayhem — Smash rules (stocks + timer, last one standing) but random weapon
      // pick-ups rain onto the platforms. Grab one and your next F (attack) unloads it: a bat
      // that sends rivals flying, a rapid blaster, a scatter gun, a lobbed bomb. Drop it on KO.
      mayhem: {
        id: 'mayhem', name: 'Power-Up Mayhem', win: 'Last fighter standing',
        desc: 'Smash with random weapon pick-ups raining in — grab a Bat, Blaster, Scatter gun or Bomb and unload with F. Stocks + timer; last fighter standing wins.',
        elimination: true, usesTimer: true, spawnEvery: 6.5, maxItems: 2,
        setup(game) {
          game.modeState = { items: [], spawnT: 2.0, slots: this._slots(game) };
        },
        // candidate spawn spots: the top-centre of each platform (skip hazards / cannons)
        _slots(game) {
          const out = [];
          for (const p of game.stage.platforms) {
            if (p.kind === 'spikes' || p.kind === 'cannon' || p.kind === 'trampoline') continue;
            out.push({ x: p.x + p.w / 2, y: p.y - 34 });
          }
          return out.length ? out : [{ x: game.view.w / 2, y: 200 }];
        },
        _spawn(game) {
          const st = game.modeState, s = st.slots[(Math.random() * st.slots.length) | 0], def = ITEMS.rand();
          st.items.push({ x: s.x, y: s.y, key: def.key, r: 32, bob: Math.random() * 6.28 });
          if (DS.Audio) DS.Audio.play('gem_spawn', { x: s.x });
        },
        update(game, dt) {
          const st = game.modeState;
          // Smash rules: stocks decide it (checkOver) and the timer can end it on score
          game.checkOver();
          if (game.data.settings.timerSeconds > 0 && game.state === 'playing') {
            game.timer -= dt;
            if (game.timer <= 0) { game.timer = 0; game.finishByScore(); }
          }
          // drip-feed pickups onto the field
          st.spawnT -= dt;
          if (st.items.length < this.maxItems && st.spawnT <= 0) { this._spawn(game); st.spawnT = this.spawnEvery; }
          for (const it of st.items) it.bob += dt * 3;
          // pickup: an unarmed, living fighter overlapping a pickup grabs it
          for (const f of game.fighters) {
            if (f.dead || f.respawnT > 0 || f.item) continue;
            for (const it of st.items) {
              if (it.taken) continue;
              if (Math.abs(f.x - it.x) < f.w / 2 + it.r && Math.abs(f.y - it.y) < f.h / 2 + it.r) {
                it.taken = true;
                const def = ITEMS.defs[it.key];
                f.item = { key: def.key, name: def.name, left: def.uses, action: def.action };
                game.effects.impact(it.x, it.y, 0.6);
                game.effects.floatText(it.x, it.y - 20, def.name + '!');
                if (DS.Audio) DS.Audio.play('gem_pickup', { x: it.x });
              }
            }
          }
          st.items = st.items.filter((it) => !it.taken);
        },
        renderWorld(game, ctx) {
          const st = game.modeState;
          for (const it of st.items) drawPickup(ctx, it);
          for (const f of game.fighters) { if (!f.dead && f.respawnT <= 0 && f.item) drawHeldTag(ctx, f); }
        },
        overText(game) {
          const w = game.winner;
          return w ? 'P' + (w.pIndex + 1) + ' (' + w.name + ') wins the mayhem!' : 'Draw!';
        },
      },

      koth: {
        id: 'koth', name: 'King of the Hill', win: 'Hold the hill 12s',
        desc: 'Stand alone on the high platform to bank time. First to 12 seconds of control wins. Infinite respawns.',
        elimination: false, usesTimer: false, holdToWin: 12,
        setup(game) {
          // the hill = the highest platform (smallest y), tie-broken toward center.
          const cx = game.view.w / 2; let hill = null, best = 1e9;
          for (const p of game.stage.platforms) {
            const s = p.y * 10 + Math.abs((p.x + p.w / 2) - cx) * 0.1;
            if (s < best) { best = s; hill = p; }
          }
          game.modeState = { hill, t: new Array(game.fighters.length).fill(0), target: this.holdToWin, controller: -1 };
        },
        update(game, dt) {
          const st = game.modeState, hill = st.hill;
          // only a SOLE occupant banks time (contested = nobody scores) — works for 2..6
          let occ = -1, cnt = 0;
          game.fighters.forEach((f, i) => { if (!f.dead && f.respawnT <= 0 && f.onGround && f.ground === hill) { cnt++; occ = i; } });
          const c = cnt === 1 ? occ : -1;
          if (c >= 0 && c !== st.controller && DS.Audio) DS.Audio.play('score', { x: hill.x + hill.w / 2 }); // a new king takes the hill
          st.controller = c;
          if (c >= 0) {
            st.t[c] += dt;
            if (st.t[c] >= st.target && game.state === 'playing') game.endMatch(game.fighters[c]);
          }
        },
        renderWorld(game, ctx) {
          const st = game.modeState, hill = st.hill; if (!hill) return;
          highlightPlatform(ctx, hill, st.controller >= 0);
          const cx = hill.x + hill.w / 2;
          const bob = Math.sin(performance.now() / 260) * 3;
          crown(ctx, cx, hill.y - 16 + bob, st.controller >= 0 ? 'P' + (st.controller + 1) : '');
        },
        portraitScore(game, f) {
          const st = game.modeState;
          return Math.floor(st.t[f.pIndex]) + ' / ' + st.target + 's';
        },
        overText(game) {
          const w = game.winner;
          return w ? 'P' + (w.pIndex + 1) + ' is King of the Hill!' : 'Time!';
        },
      },

      gems: {
        id: 'gems', name: 'Gem Grab', win: 'Hold 10 gems for 15s',
        desc: 'Grab the drifting gems — but you don\'t win by reaching 10. Hit 10 and a 15-second countdown starts; hold the lead the whole time to win. Get KO\'d and you SPILL all your gems for anyone to swoop up (Brawl-Stars style). Infinite respawns.',
        elimination: false, usesTimer: false, gemsToWin: 10, holdTime: 15,
        setup(game) {
          // one fresh gem drifts at a time; KO drops add more to the pool
          game.modeState = {
            gems: [], counts: new Array(game.fighters.length).fill(0), target: this.gemsToWin, holdTime: this.holdTime,
            spawnT: 0, max: 1, holdBy: -1, holdT: this.holdTime,
            bounds: { x0: 240, x1: game.view.w - 240, y0: 180, y1: 760 },
          };
          this._spawn(game);
        },
        _spawn(game) {
          const b = game.modeState.bounds;
          this._drop(game, b.x0 + Math.random() * (b.x1 - b.x0), b.y0 + Math.random() * (b.y1 - b.y0));
        },
        // add a gem to the field (used by both the spawner and KO spills)
        _drop(game, x, y) {
          const a = Math.random() * 6.283;
          game.modeState.gems.push({ x, y, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60, r: 17, spin: Math.random() * 6, steer: a });
        },
        update(game, dt) {
          const st = game.modeState, b = st.bounds;
          st.spawnT -= dt;
          if (st.gems.length < st.max && st.spawnT <= 0) { this._spawn(game); st.spawnT = 2.5; if (DS.Audio) DS.Audio.play('gem_spawn', { x: st.gems[st.gems.length - 1].x }); }
          // slow wander: ease each gem's velocity toward a slowly-turning heading
          for (const g of st.gems) {
            g.steer += (Math.random() - 0.5) * dt * 2.4;
            const tvx = Math.cos(g.steer) * 60, tvy = Math.sin(g.steer) * 60;
            g.vx += (tvx - g.vx) * Math.min(1, dt * 0.7);
            g.vy += (tvy - g.vy) * Math.min(1, dt * 0.7);
            g.x += g.vx * dt; g.y += g.vy * dt; g.spin += dt * 1.6;
            if (g.x < b.x0) { g.x = b.x0; g.vx = Math.abs(g.vx); g.steer = Math.atan2(g.vy, g.vx); }
            else if (g.x > b.x1) { g.x = b.x1; g.vx = -Math.abs(g.vx); g.steer = Math.atan2(g.vy, g.vx); }
            if (g.y < b.y0) { g.y = b.y0; g.vy = Math.abs(g.vy); g.steer = Math.atan2(g.vy, g.vx); }
            else if (g.y > b.y1) { g.y = b.y1; g.vy = -Math.abs(g.vy); g.steer = Math.atan2(g.vy, g.vx); }
          }
          // collect — reaching the target NO LONGER wins instantly; it (re)arms the hold timer
          for (const f of game.fighters) {
            if (f.dead || f.respawnT > 0) continue;
            for (const g of st.gems) {
              if (g.dead) continue;
              if (Math.abs(f.x - g.x) < f.w / 2 + g.r && Math.abs(f.y - g.y) < f.h / 2 + g.r) {
                g.dead = true; st.counts[f.pIndex]++; st.spawnT = Math.max(st.spawnT, 1.0);
                game.effects.impact(g.x, g.y, 0.5);
                if (DS.Audio) DS.Audio.play('gem_pickup', { x: g.x });
                game.effects.floatText(g.x, g.y - 18, '+1');
              }
            }
          }
          st.gems = st.gems.filter((g) => !g.dead);
          // ---- Brawl-Stars finish: be the SOLE leader with `target`+ gems for `holdTime`s ----
          let topI = -1, topN = -1, tie = false;
          for (let i = 0; i < st.counts.length; i++) { const c = st.counts[i]; if (c > topN) { topN = c; topI = i; tie = false; } else if (c === topN) tie = true; }
          if (topN >= st.target && !tie) {
            if (st.holdBy !== topI) { st.holdBy = topI; st.holdT = st.holdTime; } // new leader → fresh 15s
            else {
              const prev = st.holdT; st.holdT -= dt;
              if (st.holdT <= 5 && Math.ceil(prev) !== Math.ceil(st.holdT) && st.holdT > 0 && DS.Audio) DS.Audio.play('count', { i: 0 }); // tick the final 5s
              if (st.holdT <= 0 && game.state === 'playing') game.endMatch(game.fighters[topI]);
            }
          } else { st.holdBy = -1; } // lost the sole lead (KO/contested) → countdown resets
        },
        // KO in this mode SPILLS the victim's gems right next to whoever landed the last hit
        // (so the killer can swoop them up) — falls back to arena centre on a self-destruct
        onKO(game, victim) {
          const st = game.modeState; if (!st) return;
          const n = st.counts[victim.pIndex] | 0; if (n <= 0) return;
          st.counts[victim.pIndex] = 0;
          const b = st.bounds, killer = victim.lastHitBy;
          const cxp = killer && killer !== victim ? killer.x : (b.x0 + b.x1) / 2;
          const cyp = killer && killer !== victim ? killer.y : (b.y0 + b.y1) / 2;
          // scatter the gems in a tight cluster around the killer, clamped inside the arena
          for (let i = 0; i < n; i++) {
            const gx = Math.max(b.x0, Math.min(b.x1, cxp + (Math.random() - 0.5) * 150));
            const gy = Math.max(b.y0, Math.min(b.y1, cyp + (Math.random() - 0.5) * 110));
            this._drop(game, gx, gy);
          }
          game.effects.floatText(cxp, cyp - 50, 'P' + (victim.pIndex + 1) + ' spilled ' + n + ' ◆!');
          if (DS.Audio) DS.Audio.play('gem_spawn', { x: cxp });
        },
        renderWorld(game, ctx) {
          const st = game.modeState;
          for (const g of st.gems) gem(ctx, g);
          // big "about to win" countdown banner over the arena while someone holds the lead
          if (st.holdBy >= 0) {
            const b = st.bounds, cxp = (b.x0 + b.x1) / 2, t = Math.max(0, Math.ceil(st.holdT));
            ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.font = "46px 'Gloria Hallelujah', cursive"; ctx.lineJoin = 'round';
            const msg = 'P' + (st.holdBy + 1) + ' WINS IN ' + t;
            ctx.lineWidth = 7; ctx.strokeStyle = D.COL.paper; ctx.strokeText(msg, cxp, b.y0 - 30);
            ctx.fillStyle = D.COL.accent; ctx.fillText(msg, cxp, b.y0 - 30);
            ctx.restore();
          }
        },
        portraitScore(game, f) {
          const st = game.modeState;
          if (st.holdBy === f.pIndex) return '◆ ' + st.counts[f.pIndex] + '  ⏱' + Math.max(0, Math.ceil(st.holdT));
          return '◆ ' + st.counts[f.pIndex] + ' / ' + st.target;
        },
        overText(game) {
          const w = game.winner;
          return w ? 'P' + (w.pIndex + 1) + ' held the gems!' : 'Game!';
        },
      },

      bounty: {
        id: 'bounty', name: 'K.O. Rush', win: 'First to 5 K.O.s',
        desc: 'No stocks, infinite respawns — every knockout you land scores a point. First to 5 K.O.s wins.',
        elimination: false, usesTimer: false, kosToWin: 5,
        setup(game) { game.modeState = { counts: new Array(game.fighters.length).fill(0), target: this.kosToWin }; },
        update() { /* scoring happens on KO; nothing per-frame */ },
        onKO(game, victim) {
          const a = victim.lastHitBy;
          if (!a || a === victim) return;            // self-destructs score nobody
          const st = game.modeState, i = a.pIndex;
          st.counts[i]++;
          game.effects.floatText(victim.x, victim.y - 40, 'P' + (i + 1) + '  KO!');
          if (DS.Audio) DS.Audio.play('score', { x: victim.x });
          if (st.counts[i] >= st.target && game.state === 'playing') game.endMatch(a);
        },
        portraitScore(game, f) {
          const st = game.modeState;
          return '★ ' + st.counts[f.pIndex] + ' / ' + st.target;
        },
        overText(game) {
          const w = game.winner;
          return w ? 'P' + (w.pIndex + 1) + ' wins the K.O. Rush!' : 'Time!';
        },
      },
    },
    get(id) { return this.defs[id] || this.defs.smash; },
    list() { return this._order.map((id) => this.defs[id]); },
  };

  DS.Maps = Maps;
  DS.Modes = Modes;
})(window);
