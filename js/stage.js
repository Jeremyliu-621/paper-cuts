// Stage rendering: platforms (several material "kinds"), swinging-platform ropes,
// a parallax-free background-structures pass, and doodle plants/decorations.
// Pure function of stage data so the eventual CV detector can swap in geometry.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;
  const ink = () => D.COL.ink;

  // ---- platforms -----------------------------------------------------------
  // dispatch on p.kind; default is ground (solid) / float (pass-through). A stable
  // per-platform seed (set by the Game) keeps hand-drawn jitter from shimmering on
  // moving platforms whose x/y change every frame.
  function platform(ctx, p) {
    const rnd = DS.makeRng(p._seed != null ? p._seed : DS.hashSeed('p' + p.x + '_' + p.y + '_' + p.w));
    const kind = p.kind || (p.pass ? 'float' : 'ground');
    const fn = PLAT[kind] || PLAT.float;
    dropShadow(ctx, p);   // soft paper-cutout shadow → the platform reads as floating above the field
    fn(ctx, p, rnd);
  }

  // Depth cue that fits a pure side-on view: a faint dark silhouette offset down-and-right behind
  // the platform, like a paper cutout lifted off the page. Aligns perfectly (same shape, offset),
  // never pokes past an edge, and reads as the platform sitting in front of the (parallaxed) field.
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function dropShadow(ctx, p) {
    const r = Math.min(20, p.h / 2);
    ctx.save();
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = D.COL.ink;
    roundRectPath(ctx, p.x + 9, p.y + 12, p.w, p.h, r);
    ctx.fill();
    ctx.restore();
  }

  function groundPlat(ctx, p, rnd) {
    const r = 20;
    D.roundedRect(ctx, p.x, p.y, p.w, p.h, r, { width: 6, color: D.COL.ink, rnd, fill: D.COL.paper });
    D.wavy(ctx, p.x + r, p.x + p.w - r, p.y + 16, { amp: 4, wavelen: 30, width: 4, color: D.COL.ink, rnd, passes: 1 });
    ctx.save();
    ctx.setLineDash([3, 16]); ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.strokeStyle = D.COL.ink; ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.moveTo(p.x + 30, p.y + p.h * 0.42); ctx.lineTo(p.x + p.w - 30, p.y + p.h * 0.42); ctx.stroke();
    ctx.restore();
    // a few hanging roots from the underside
    ctx.save(); ctx.globalAlpha = 0.6; ctx.strokeStyle = D.COL.ink; ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (let x = p.x + 60; x < p.x + p.w - 40; x += 150) {
      const h = 14 + (rnd() * 16);
      ctx.beginPath(); ctx.moveTo(x, p.y + p.h); ctx.quadraticCurveTo(x + 4, p.y + p.h + h * 0.6, x + 1, p.y + p.h + h); ctx.stroke();
    }
    ctx.restore();
  }

  function floatPlat(ctx, p, rnd) {
    const r = Math.min(p.h / 2, 16);
    D.roundedRect(ctx, p.x, p.y, p.w, p.h, r, { width: 6, color: D.COL.ink, rnd, fill: D.COL.paper });
    D.wavy(ctx, p.x + r, p.x + p.w - r, p.y + 12, { amp: 3, wavelen: 30, width: 4, color: D.COL.ink, rnd, passes: 1 });
  }

  function woodPlat(ctx, p, rnd) {
    const r = Math.min(p.h / 2, 9);
    D.roundedRect(ctx, p.x, p.y, p.w, p.h, r, { width: 5, color: D.COL.ink, rnd, fill: D.COL.paper });
    const boards = Math.max(2, Math.round(p.w / 95));
    for (let i = 1; i < boards; i++) {
      const x = p.x + (p.w * i) / boards;
      D.line(ctx, x, p.y + 5, x, p.y + p.h - 5, { width: 2.5, color: D.COL.ink, rnd, passes: 1 });
    }
    // grain + a couple nail dots
    ctx.globalAlpha = 0.45;
    D.line(ctx, p.x + 10, p.y + p.h * 0.5, p.x + p.w - 10, p.y + p.h * 0.52, { width: 2, color: D.COL.ink, passes: 1 });
    ctx.globalAlpha = 1;
    ctx.fillStyle = D.COL.ink;
    for (let i = 0; i <= boards; i++) {
      const x = p.x + 8 + (p.w - 16) * (i / boards);
      ctx.beginPath(); ctx.arc(x, p.y + 7, 2.2, 0, 7); ctx.fill();
    }
  }

  function stonePlat(ctx, p, rnd) {
    const r = Math.min(p.h / 2, 12);
    D.roundedRect(ctx, p.x, p.y, p.w, p.h, r, { width: 6, color: D.COL.ink, rnd, fill: D.COL.paper });
    // offset brick courses
    const rows = Math.max(1, Math.round(p.h / 34));
    ctx.globalAlpha = 0.7;
    for (let ry = 1; ry < rows; ry++) {
      const y = p.y + (p.h * ry) / rows;
      D.line(ctx, p.x + 6, y, p.x + p.w - 6, y, { width: 2.5, color: D.COL.ink, rnd, passes: 1 });
    }
    const cols = Math.max(2, Math.round(p.w / 110));
    for (let ry = 0; ry < rows; ry++) {
      const y0 = p.y + (p.h * ry) / rows, y1 = p.y + (p.h * (ry + 1)) / rows;
      for (let c = 1; c < cols; c++) {
        const x = p.x + (p.w * c) / cols + (ry % 2 ? p.w / cols / 2 : 0);
        if (x > p.x + 8 && x < p.x + p.w - 8) D.line(ctx, x, y0 + 3, x, y1 - 3, { width: 2.2, color: D.COL.ink, rnd, passes: 1 });
      }
    }
    ctx.globalAlpha = 1;
  }

  function crystalPlat(ctx, p, rnd) {
    const c = D.COL.accent;
    D.roundedRect(ctx, p.x, p.y, p.w, p.h, 6, { width: 5, color: D.COL.ink, rnd, fill: D.COL.paper });
    // faceted top — little triangular crystals poking up along the surface
    const n = Math.max(2, Math.round(p.w / 70));
    for (let i = 0; i < n; i++) {
      const x = p.x + 14 + (p.w - 28) * (i / Math.max(1, n - 1));
      const up = 10 + rnd() * 14;
      D.strokePts(ctx, [[x - 9, p.y + 2], [x, p.y - up], [x + 9, p.y + 2]], { width: 3, color: D.COL.ink, rnd, fill: D.COL.paper, passes: 1 });
      D.line(ctx, x, p.y - up + 3, x, p.y + 1, { width: 1.8, color: c, passes: 1 });
    }
    // accent facet lines inside
    ctx.globalAlpha = 0.7;
    D.line(ctx, p.x + 8, p.y + p.h * 0.55, p.x + p.w - 8, p.y + p.h * 0.45, { width: 2, color: c, passes: 1 });
    ctx.globalAlpha = 1;
  }

  // breakable crate; shows more cracks as it loses hp
  function boxPlat(ctx, p, rnd) {
    D.roundedRect(ctx, p.x, p.y, p.w, p.h, 5, { width: 5.5, color: D.COL.ink, rnd, fill: D.COL.paper });
    // inset frame + X-brace
    const i = 7;
    D.strokePts(ctx, [[p.x + i, p.y + i], [p.x + p.w - i, p.y + i], [p.x + p.w - i, p.y + p.h - i], [p.x + i, p.y + p.h - i]],
      { width: 3, color: D.COL.ink, rnd, closed: true, passes: 1 });
    D.line(ctx, p.x + i, p.y + i, p.x + p.w - i, p.y + p.h - i, { width: 3, color: D.COL.ink, rnd, passes: 1 });
    D.line(ctx, p.x + p.w - i, p.y + i, p.x + i, p.y + p.h - i, { width: 3, color: D.COL.ink, rnd, passes: 1 });
    // damage cracks
    const hp = p.hp || 1, dmg = 1 - Math.max(0, (p._hp != null ? p._hp : hp)) / hp;
    if (dmg > 0.01) {
      ctx.globalAlpha = 0.8; ctx.strokeStyle = D.COL.ink; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
      const cracks = Math.round(dmg * 4);
      const cr = DS.makeRng((p._seed || 1) + 41);
      for (let k = 0; k < cracks; k++) {
        let cx = p.x + p.w * (0.25 + cr() * 0.5), cy = p.y + p.h * (0.2 + cr() * 0.3);
        ctx.beginPath(); ctx.moveTo(cx, cy);
        for (let s = 0; s < 3; s++) { cx += cr.sym(14); cy += 8 + cr() * 12; ctx.lineTo(cx, cy); }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  // a big bouncy trampoline: taut accent-coloured mat with springs and "boing" chevrons
  function trampolinePlat(ctx, p, rnd) {
    const c = D.COL.accent, r = Math.min(p.h / 2, 14);
    D.roundedRect(ctx, p.x, p.y, p.w, p.h, r, { width: 6, color: D.COL.ink, rnd, fill: D.COL.paper });
    // taut bouncy surface bands along the top
    ctx.save();
    ctx.globalAlpha = 0.9; D.wavy(ctx, p.x + 14, p.x + p.w - 14, p.y + 9, { amp: 5, wavelen: 26, width: 4, color: c, rnd, passes: 1 });
    ctx.globalAlpha = 0.45; D.wavy(ctx, p.x + 14, p.x + p.w - 14, p.y + p.h * 0.55, { amp: 3, wavelen: 44, width: 2.5, color: c, rnd, passes: 1 });
    ctx.restore();
    // coil springs along the underside
    ctx.save(); ctx.globalAlpha = 0.6; ctx.strokeStyle = D.COL.ink; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    for (let x = p.x + 40; x < p.x + p.w - 30; x += 110) {
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) { const yy = p.y + p.h + k * 7; const xx = x + (k % 2 ? 8 : -8); k === 0 ? ctx.moveTo(x, p.y + p.h) : ctx.lineTo(xx, yy); }
      ctx.stroke();
    }
    ctx.restore();
    // upward "boing" chevrons hinting the bounce
    ctx.save(); ctx.globalAlpha = 0.85; ctx.strokeStyle = c; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) { const x = p.x + p.w * (0.3 + 0.2 * i); ctx.beginPath(); ctx.moveTo(x - 10, p.y - 6); ctx.lineTo(x, p.y - 17); ctx.lineTo(x + 10, p.y - 6); ctx.stroke(); }
    ctx.restore();
  }

  // a cannon on a stone mount; barrel points along its fire angle, flashes when it fires
  function cannonPlat(ctx, p, rnd) {
    stonePlat(ctx, p, rnd);
    const deg = (p.fire && p.fire.deg) || 0, ang = -deg * Math.PI / 180; // +deg = up (matches projectile convention)
    const cx = p.x + p.w / 2, cy = p.y + 8, len = Math.min(p.w * 0.8, 66), bw = 17;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
    D.strokePts(ctx, [[-8, -bw / 2], [len, -bw / 2], [len, bw / 2], [-8, bw / 2]], { width: 5, color: D.COL.ink, rnd, closed: true, fill: D.COL.paper });
    D.circle(ctx, -6, 0, bw / 2 + 2, { width: 4, color: D.COL.ink, rnd, fill: D.COL.paper }); // breech
    D.line(ctx, len, -bw / 2 - 3, len, bw / 2 + 3, { width: 5, color: D.COL.ink, rnd, passes: 1 }); // muzzle ring
    if (p._flash > 0) {
      ctx.globalAlpha = Math.min(1, p._flash * 8); ctx.strokeStyle = D.COL.accent; ctx.lineWidth = 4; ctx.lineCap = 'round';
      for (let i = -2; i <= 2; i++) { const a = i * 0.32; ctx.beginPath(); ctx.moveTo(len + 4, 0); ctx.lineTo(len + 6 + Math.cos(a) * 24, Math.sin(a) * 24); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // a teleport portal — wobbly coloured rings with a slow swirl pulled toward the centre
  function portalGlyph(ctx, pt) {
    const t = (typeof performance !== 'undefined' && performance.now) ? performance.now() / 1000 : 0;
    const col = pt.col || D.COL.power, rx = pt.r * 0.72, ry = pt.r;
    ctx.save(); ctx.translate(pt.x, pt.y);
    for (let k = 0; k < 2; k++) {
      ctx.globalAlpha = 0.85 - k * 0.32; ctx.strokeStyle = col; ctx.lineWidth = 5 - k * 1.6;
      ctx.beginPath(); ctx.ellipse(0, 0, rx - k * 7, ry - k * 7, 0, 0, 6.2832); ctx.stroke();
    }
    ctx.globalAlpha = 0.55; ctx.lineWidth = 3; ctx.beginPath();
    const TURNS = 6.2832 * 2.5;
    for (let a = 0; a <= TURNS; a += 0.22) { const rr = a / TURNS, x = Math.cos(a + t * 1.6) * rx * rr, y = Math.sin(a + t * 1.6) * ry * rr; a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
  }

  const PLAT = { ground: groundPlat, float: floatPlat, wood: woodPlat, stone: stonePlat, crystal: crystalPlat, box: boxPlat, trampoline: trampolinePlat, cannon: cannonPlat };

  // ropes for a swinging platform — drawn behind the plank
  function ropes(ctx, p) {
    const mv = p.move; if (!mv || mv.pivotX == null) return;
    const rnd = DS.makeRng((p._seed || 3) + 71);
    ctx.globalAlpha = 0.9;
    D.line(ctx, mv.pivotX, mv.pivotY, p.x + 10, p.y + 4, { width: 3, color: D.COL.ink, rnd, passes: 1 });
    D.line(ctx, mv.pivotX, mv.pivotY, p.x + p.w - 10, p.y + 4, { width: 3, color: D.COL.ink, rnd, passes: 1 });
    ctx.globalAlpha = 1;
    D.circle(ctx, mv.pivotX, mv.pivotY, 6, { width: 4, color: D.COL.ink, rnd, fill: D.COL.paper });
  }

  // ---- clouds & plants (foreground decor) ----------------------------------
  function cloud(ctx, x, y, s) {
    s = s || 1;
    const rnd = DS.makeRng(DS.hashSeed('c' + x + y));
    const bumps = [[-46, 6, 20], [-20, -10, 26], [12, -12, 24], [40, 4, 20], [10, 12, 22], [-18, 14, 22]];
    const pts = [];
    for (const [bx, by, br] of bumps) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * 6.283;
        pts.push([x + (bx + Math.cos(ang) * br) * s, y + (by + Math.sin(ang) * br) * s]);
      }
    }
    const hull = [];
    const N = 22;
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * 6.283;
      let best = null, bd = -1;
      for (const q of pts) {
        const d = (q[0] - x) * Math.cos(ang) + (q[1] - y) * Math.sin(ang);
        if (d > bd) { bd = d; best = q; }
      }
      hull.push(best);
    }
    D.strokePts(ctx, hull, { width: 4.5, color: D.COL.ink, rnd, closed: true, fill: D.COL.paper });
  }

  function flower(ctx, x, y, sx, sy) {
    const rnd = DS.makeRng(DS.hashSeed('f' + (sx || x) + (sy || y)));
    D.curve(ctx, [[x, y], [x - 3, y - 22], [x + 1, y - 40]], { width: 4, color: D.COL.ink, rnd, passes: 1 });
    D.line(ctx, x - 2, y - 18, x - 12, y - 26, { width: 3.5, color: D.COL.ink, rnd, passes: 1 });
    const cx = x + 1, cy = y - 44;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * 6.283 - 1.2;
      D.circle(ctx, cx + Math.cos(a) * 9, cy + Math.sin(a) * 9, 6, { width: 3.5, color: D.COL.ink, rnd });
    }
    D.circle(ctx, cx, cy, 5, { width: 3.5, color: D.COL.accent, rnd });
  }

  function grass(ctx, x, y, sx, sy) {
    const rnd = DS.makeRng(DS.hashSeed('g' + (sx || x) + (sy || y)));
    for (let i = -1; i <= 1; i++) {
      D.curve(ctx, [[x + i * 7, y], [x + i * 10, y - 14], [x + i * 16, y - 22]], { width: 3.5, color: D.COL.ink, rnd, passes: 1 });
    }
  }

  function bush(ctx, x, y, sx, sy) {
    const rnd = DS.makeRng(DS.hashSeed('b' + (sx || x) + (sy || y)));
    const pts = [];
    const N = 16;
    for (let i = 0; i <= N; i++) {
      const a = Math.PI + (i / N) * Math.PI;
      const rr = 26 + Math.sin(i * 1.7) * 6;
      pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.7]);
    }
    pts.push([x + 30, y]); pts.push([x - 30, y]);
    D.strokePts(ctx, pts, { width: 4.5, color: D.COL.ink, rnd, closed: true, fill: D.COL.paper });
  }

  // leafy round tree
  function tree(ctx, x, y, sx, sy) {
    const rnd = DS.makeRng(DS.hashSeed('t' + (sx || x) + (sy || y)));
    // trunk
    D.strokePts(ctx, [[x - 10, y], [x - 7, y - 60], [x + 7, y - 60], [x + 10, y]], { width: 5, color: D.COL.ink, rnd, fill: D.COL.paper, passes: 1 });
    D.line(ctx, x, y - 8, x, y - 56, { width: 2, color: D.COL.ink, passes: 1, alpha: 0.4 });
    // canopy: overlapping blobs
    const blobs = [[-34, -78, 34], [22, -88, 36], [0, -108, 40], [-20, -120, 30], [30, -116, 28]];
    for (const [bx, by, br] of blobs) D.circle(ctx, x + bx, y + by, br, { width: 5, color: D.COL.ink, rnd, fill: D.COL.paper, wob: 2 });
  }

  // pointy pine
  function pine(ctx, x, y, sx, sy) {
    const rnd = DS.makeRng(DS.hashSeed('pi' + (sx || x) + (sy || y)));
    D.strokePts(ctx, [[x - 6, y], [x - 5, y - 30], [x + 5, y - 30], [x + 6, y]], { width: 5, color: D.COL.ink, rnd, fill: D.COL.paper, passes: 1 });
    const tiers = [[40, 36, -26], [34, 28, -54], [24, 22, -78]];
    for (const [w, h, ty] of tiers) {
      D.strokePts(ctx, [[x - w, y + ty], [x, y + ty - h], [x + w, y + ty]], { width: 5, color: D.COL.ink, rnd, fill: D.COL.paper, passes: 1 });
    }
  }

  // mushroom cluster
  function mushroom(ctx, x, y, sx, sy) {
    const rnd = DS.makeRng(DS.hashSeed('m' + (sx || x) + (sy || y)));
    const caps = [[0, 0, 1], [-22, 6, 0.7], [20, 8, 0.6]];
    for (const [mx, my, ms] of caps) {
      // stem
      D.strokePts(ctx, [[x + mx - 6 * ms, y + my], [x + mx - 5 * ms, y + my - 18 * ms], [x + mx + 5 * ms, y + my - 18 * ms], [x + mx + 6 * ms, y + my]],
        { width: 4, color: D.COL.ink, rnd, fill: D.COL.paper, passes: 1 });
      // cap
      const cy = y + my - 18 * ms, cw = 20 * ms;
      D.strokePts(ctx, [[x + mx - cw, cy], [x + mx - cw * 0.6, cy - 14 * ms], [x + mx, cy - 17 * ms], [x + mx + cw * 0.6, cy - 14 * ms], [x + mx + cw, cy]],
        { width: 4, color: D.COL.ink, rnd, closed: true, fill: D.COL.paper, passes: 1 });
      ctx.fillStyle = D.COL.accent; ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.arc(x + mx - 5 * ms, cy - 8 * ms, 2.4 * ms, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(x + mx + 5 * ms, cy - 6 * ms, 2 * ms, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // tall reeds / cattails
  function reeds(ctx, x, y, sx, sy) {
    const rnd = DS.makeRng(DS.hashSeed('rd' + (sx || x) + (sy || y)));
    for (let i = -2; i <= 2; i++) {
      const bx = x + i * 9, bend = i * 6;
      D.curve(ctx, [[bx, y], [bx + bend * 0.5, y - 30], [bx + bend, y - 56]], { width: 3.5, color: D.COL.ink, rnd, passes: 1 });
      if (i % 2 === 0) { ctx.fillStyle = D.COL.ink; ctx.beginPath(); ctx.ellipse(bx + bend, y - 60, 4, 9, 0, 0, 7); ctx.fill(); }
    }
  }

  // hanging vine (grows downward from y)
  function vine(ctx, x, y, sx, sy) {
    const rnd = DS.makeRng(DS.hashSeed('v' + (sx || x) + (sy || y)));
    const len = 90, pts = [];
    for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push([x + Math.sin(t * 6) * 8, y + t * len]); }
    D.strokePts(ctx, pts, { width: 3.5, color: D.COL.ink, rnd, passes: 1 });
    for (let i = 1; i <= 5; i++) {
      const t = i / 6, lx = x + Math.sin(t * 6) * 8, ly = y + t * len;
      D.strokePts(ctx, [[lx, ly], [lx + (i % 2 ? 14 : -14), ly - 4], [lx + (i % 2 ? 10 : -10), ly + 8]],
        { width: 3, color: D.COL.ink, rnd, closed: true, fill: D.COL.paper, passes: 1 });
    }
  }

  const DECOR = { flower, grass, bush, tree, pine, mushroom, reeds, vine };

  // ---- background structures -----------------------------------------------
  // Drawn behind everything in a light, desaturated gray (BG_INK) with paper fill,
  // so they read as scenery and never get mistaken for the inky, interactable
  // platforms. Each fn takes the ink color so the contrast lives in one place.
  const BG_INK = '#b9b1a4'; // soft warm gray — clearly lighter than the charcoal ink

  function mountain(ctx, w, h, c) {
    const rnd = DS.makeRng(DS.hashSeed('mt' + w + h));
    D.strokePts(ctx, [[-w / 2, 0], [-w * 0.16, -h * 0.78], [0, -h], [w * 0.2, -h * 0.7], [w / 2, 0]],
      { width: 5, color: c, rnd, fill: D.COL.paper, passes: 1 });
    // snow cap
    D.strokePts(ctx, [[-w * 0.16, -h * 0.78], [-w * 0.05, -h * 0.68], [0, -h * 0.82], [w * 0.08, -h * 0.7], [w * 0.2, -h * 0.7], [0, -h]],
      { width: 3, color: c, rnd, passes: 1 });
  }

  function hill(ctx, w, h, c) {
    const rnd = DS.makeRng(DS.hashSeed('hl' + w + h));
    const pts = [[-w / 2, 0]];
    for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push([-w / 2 + w * t, -Math.sin(t * Math.PI) * h]); }
    pts.push([w / 2, 0]);
    D.strokePts(ctx, pts, { width: 4.5, color: c, rnd, fill: D.COL.paper, passes: 1 });
  }

  function tower(ctx, w, h, c) {
    const rnd = DS.makeRng(DS.hashSeed('tw' + w + h));
    D.strokePts(ctx, [[-w / 2, 0], [-w / 2, -h], [w / 2, -h], [w / 2, 0]], { width: 5, color: c, rnd, fill: D.COL.paper, passes: 1 });
    // battlements
    for (let i = 0; i < 4; i++) {
      const bx = -w / 2 + (w / 4) * i + 4;
      D.strokePts(ctx, [[bx, -h], [bx, -h - 16], [bx + w / 8, -h - 16], [bx + w / 8, -h]], { width: 4, color: c, rnd, passes: 1 });
    }
    // windows
    for (let r = 1; r <= Math.round(h / 70); r++) {
      const wy = -r * 60;
      D.strokePts(ctx, [[-7, wy], [7, wy], [7, wy + 22], [-7, wy + 22]], { width: 3, color: c, rnd, closed: true, passes: 1 });
    }
  }

  function building(ctx, w, h, c) {
    const rnd = DS.makeRng(DS.hashSeed('bd' + w + h));
    D.strokePts(ctx, [[-w / 2, 0], [-w / 2, -h], [w / 2, -h], [w / 2, 0]], { width: 5, color: c, rnd, fill: D.COL.paper, passes: 1 });
    // pitched roof
    D.strokePts(ctx, [[-w / 2 - 8, -h], [0, -h - w * 0.4], [w / 2 + 8, -h]], { width: 5, color: c, rnd, fill: D.COL.paper, passes: 1 });
    // windows grid
    const cols = Math.max(2, Math.round(w / 60)), rows = Math.max(2, Math.round(h / 70));
    for (let cc = 0; cc < cols; cc++) for (let r = 0; r < rows; r++) {
      const wx = -w / 2 + 16 + cc * (w - 28) / Math.max(1, cols - 1) - 9;
      const wy = -h + 22 + r * (h - 36) / Math.max(1, rows - 1) - 9;
      D.strokePts(ctx, [[wx, wy], [wx + 18, wy], [wx + 18, wy + 18], [wx, wy + 18]], { width: 2.6, color: c, rnd, closed: true, passes: 1 });
    }
  }

  // ruined arch / columns
  function arch(ctx, w, h, c) {
    const rnd = DS.makeRng(DS.hashSeed('ar' + w + h));
    const cw = w * 0.18;
    for (const sgn of [-1, 1]) {
      const cx = sgn * (w / 2 - cw / 2);
      D.strokePts(ctx, [[cx - cw / 2, 0], [cx - cw / 2, -h], [cx + cw / 2, -h], [cx + cw / 2, 0]], { width: 5, color: c, rnd, fill: D.COL.paper, passes: 1 });
      for (let r = 1; r <= Math.round(h / 40); r++) D.line(ctx, cx - cw / 2 + 3, -r * 36, cx + cw / 2 - 3, -r * 36, { width: 2, color: c, passes: 1, alpha: 0.6 });
    }
    // broken arch top — a partial curve
    const pts = [];
    for (let i = 0; i <= 8; i++) { const a = Math.PI * (0.1 + 0.8 * (i / 8)); pts.push([Math.cos(a) * (w / 2 - cw / 2), -h - Math.sin(a) * (w * 0.22)]); }
    D.strokePts(ctx, pts, { width: 5, color: c, rnd, passes: 1 });
  }

  // floating sky island (background)
  function skyisland(ctx, w, h, c) {
    const rnd = DS.makeRng(DS.hashSeed('si' + w + h));
    const pts = [];
    for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push([-w / 2 + w * t, -Math.sin(t * Math.PI) * h * 0.4]); }
    // pointed underside
    pts.push([w * 0.18, h * 0.5]); pts.push([-w * 0.05, h]); pts.push([-w * 0.2, h * 0.45]);
    D.strokePts(ctx, pts, { width: 4.5, color: c, rnd, closed: true, fill: D.COL.paper, passes: 1 });
    for (let i = -1; i <= 1; i++) D.line(ctx, i * w * 0.12, h * 0.4, i * w * 0.12 + 4, h + 18, { width: 2.5, color: c, passes: 1, alpha: 0.6 });
  }

  const BG = { mountain, hill, tower, building, arch, skyisland };

  // ---- composition ---------------------------------------------------------
  // accepts a stage object ({platforms,...}) or the data wrapper ({stage:...}).
  function stageOf(data) { return data.platforms ? data : data.stage; }

  // Parallax: a layer drifts at rate `depth` relative to how far the camera has panned from its
  // home (the stage-centred resting view). depth 1 = locked to the playfield (moves 1:1), depth 0
  // = static (infinitely far). Crucially it's anchored to home, so at rest every layer sits exactly
  // where it was authored; only camera *deviation* spreads the layers apart into a diorama.
  // cam/home are optional; without them (e.g. the static editor preview) everything draws unshifted.
  function px(v, cam, home, depth) { return cam == null ? v : v + (1 - depth) * (cam - home); }

  // far structures — call before drawStage, inside the world transform
  function drawBackground(ctx, data, cam, home) {
    const st = stageOf(data);
    if (!st.bg) return;
    for (const d of st.bg) {
      const fn = BG[d.type]; if (!fn) continue;
      // fainter scenery reads as further away, so fall back to alpha for an unset depth.
      const depth = d.depth != null ? d.depth : Math.max(0.12, Math.min(0.6, d.a != null ? d.a : 0.4));
      ctx.save();
      // the gray ink is what separates scenery from platforms; nudge the (ink-tuned)
      // per-item alpha up a little so the lighter color still reads, keep depth order.
      ctx.globalAlpha = Math.min(0.8, (d.a != null ? d.a : 0.5) + 0.28);
      ctx.translate(px(d.x, cam && cam.cx, home && home.x, depth), px(d.y, cam && cam.cy, home && home.y, depth));
      ctx.scale(d.s || 1, d.s || 1);
      fn(ctx, d.w || 220, d.h || 220, BG_INK);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawStage(ctx, data, cam, home) {
    const st = stageOf(data);
    const cx = cam && cam.cx, cy = cam && cam.cy, hx = home && home.x, hy = home && home.y;
    // clouds live in the sky → a gentle far-layer parallax so they drift slower than the field
    for (const d of st.decor || []) if (d.type === 'cloud') cloud(ctx, px(d.x, cx, hx, 0.35), px(d.y, cy, hy, 0.35), d.s);
    for (const p of st.platforms) if (p.move && p.move.type === 'swing') ropes(ctx, p);
    for (const p of st.platforms) platform(ctx, p);
    for (const pt of st.portals || []) portalGlyph(ctx, pt);
    for (const d of st.decor || []) {
      if (d.type === 'cloud') continue;
      const fn = DECOR[d.type]; if (!fn) continue;
      ctx.save(); ctx.translate(d.x, d.y); ctx.scale(d.s || 1, d.s || 1);
      fn(ctx, 0, 0, d.x, d.y); // draw at origin (scaled); pass orig coords for stable jitter seed
      ctx.restore();
    }
  }

  DS.stage = { drawStage, drawBackground, platform, ropes, cloud, flower, grass, bush, tree, pine, mushroom, reeds, vine };
})(window);
