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
    if (kind !== 'drawn') dropShadow(ctx, p); // a 'drawn' squiggle draws its own soft shadow
    fn(ctx, p, rnd);
  }

  // a hand-drawn platform: the traced stroke is the TOP surface; the body is extruded along the
  // stroke's PERPENDICULAR (not straight down) so the thickness is CONSTANT everywhere — a steep
  // or curved stretch is just as chunky as a flat one (same heft as a Meadow float), instead of
  // thinning to a slanted-pen sliver. pts are stored relative to p.x/p.y.
  const DRAWN_TH = 38; // body thickness ≈ a Meadow float platform (must match the editor bbox pad)
  function traceSmooth(ctx, pts, startMove) {
    if (startMove) ctx.moveTo(pts[0][0], pts[0][1]); else ctx.lineTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1]; ctx.lineTo(last[0], last[1]);
  }
  // each point offset by `d` along its downward-facing normal (perpendicular to the local tangent)
  function offsetAlongNormal(pts, d) {
    const n = pts.length, out = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1]; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      let nx = -ty, ny = tx; if (ny < 0) { nx = -nx; ny = -ny; } // face "down" (+y)
      out.push([pts[i][0] + nx * d, pts[i][1] + ny * d]);
    }
    return out;
  }
  // sample a quadratic Bézier p0->p1 (control c) into n+1 points (for stroking a rounded cap)
  function quadSample(p0, c, p1, n) {
    const out = [];
    for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]); }
    return out;
  }
  function lerp2(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
  // point indices spaced ~`spacing` apart along the stroke by arc length (skips the very ends)
  function strokeMarks(top, spacing) {
    const idx = []; let acc = spacing * 0.55;
    for (let i = 1; i < top.length - 1; i++) { acc += Math.hypot(top[i][0] - top[i - 1][0], top[i][1] - top[i - 1][1]); if (acc >= spacing) { acc = 0; idx.push(i); } }
    return idx;
  }
  // a drawn platform can be RESTYLED into different "types" in the editor while keeping its shape:
  // 'ledge' (plain), 'wood', 'stone', 'crystal' and 'bouncy' (springs you up). All collide the same.
  function drawnPlat(ctx, p, rnd) {
    const pts = p.pts;
    if (!pts || pts.length < 2) { floatPlat(ctx, p, rnd); return; }
    const style = p.style || 'ledge';
    const top = pts, bot = offsetAlongNormal(pts, DRAWN_TH), lip = offsetAlongNormal(pts, 8);
    const N = top.length, A = top[0], B = top[N - 1], Ab = bot[0], Bb = bot[N - 1];
    const r = DRAWN_TH / 2;
    const taX = top[1][0] - A[0], taY = top[1][1] - A[1], La = Math.hypot(taX, taY) || 1;
    const tbX = B[0] - top[N - 2][0], tbY = B[1] - top[N - 2][1], Lb = Math.hypot(tbX, tbY) || 1;
    const ctrlA = [(A[0] + Ab[0]) / 2 - taX / La * r * 1.4, (A[1] + Ab[1]) / 2 - taY / La * r * 1.4];
    const ctrlB = [(B[0] + Bb[0]) / 2 + tbX / Lb * r * 1.4, (B[1] + Bb[1]) / 2 + tbY / Lb * r * 1.4];
    const edge = (style === 'crystal' || style === 'bouncy') ? D.COL.accent : D.COL.ink;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const ribbon = () => {
      ctx.beginPath();
      traceSmooth(ctx, top, true);
      ctx.quadraticCurveTo(ctrlB[0], ctrlB[1], Bb[0], Bb[1]);
      traceSmooth(ctx, bot.slice().reverse(), false);
      ctx.quadraticCurveTo(ctrlA[0], ctrlA[1], A[0], A[1]);
      ctx.closePath();
    };
    // soft cutout shadow + cream body
    ctx.save(); ctx.translate(7, 10); ctx.globalAlpha = 0.1; ribbon(); ctx.fillStyle = D.COL.ink; ctx.fill(); ctx.restore();
    ribbon(); ctx.fillStyle = D.COL.paper; ctx.fill();
    if (style === 'crystal' || style === 'bouncy') { ribbon(); ctx.globalAlpha = 0.08; ctx.fillStyle = edge; ctx.fill(); ctx.globalAlpha = 1; }
    // chunky edges + rounded caps
    D.strokePts(ctx, top, { width: 6, color: edge, rnd, passes: 1, jitter: 0.25 });
    D.strokePts(ctx, bot, { width: 5, color: edge, rnd, passes: 1, jitter: 0.25 });
    D.strokePts(ctx, quadSample(B, ctrlB, Bb, 7), { width: 5, color: edge, rnd, passes: 1, jitter: 0.2 });
    D.strokePts(ctx, quadSample(Ab, ctrlA, A, 7), { width: 5, color: edge, rnd, passes: 1, jitter: 0.2 });
    ctx.globalAlpha = 0.4; D.strokePts(ctx, lip, { width: 2.5, color: edge, passes: 1 }); ctx.globalAlpha = 1;

    // ---- per-type decoration (follows the curve) ----
    if (style === 'wood') {
      strokeMarks(top, 92).forEach((i) => {
        D.strokePts(ctx, [lerp2(top[i], bot[i], 0.12), lerp2(top[i], bot[i], 0.88)], { width: 2.5, color: D.COL.ink, rnd, passes: 1 }); // plank seam
        const nd = lerp2(top[i], bot[i], 0.2); ctx.fillStyle = D.COL.ink; ctx.beginPath(); ctx.arc(nd[0], nd[1], 2.2, 0, 7); ctx.fill(); // nail
      });
    } else if (style === 'stone') {
      const mid = offsetAlongNormal(pts, r);
      ctx.globalAlpha = 0.6; D.strokePts(ctx, mid, { width: 2, color: D.COL.ink, passes: 1 }); ctx.globalAlpha = 1; // course seam
      strokeMarks(top, 84).forEach((i, k) => { // staggered short joints, brick-like
        const a = k % 2 ? lerp2(top[i], bot[i], 0.5) : lerp2(top[i], bot[i], 0.08), b = k % 2 ? lerp2(top[i], bot[i], 0.92) : lerp2(top[i], bot[i], 0.5);
        ctx.globalAlpha = 0.6; D.strokePts(ctx, [a, b], { width: 2.2, color: D.COL.ink, rnd, passes: 1 }); ctx.globalAlpha = 1;
      });
    } else if (style === 'crystal') {
      strokeMarks(top, 74).forEach((i) => { // facets poking up from the surface
        let ux = top[i][0] - bot[i][0], uy = top[i][1] - bot[i][1]; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul; // up-normal
        const tg = lerp2(top[Math.max(0, i - 1)], top[Math.min(N - 1, i + 1)], 0.5); let tx = top[Math.min(N - 1, i + 1)][0] - top[Math.max(0, i - 1)][0], ty = top[Math.min(N - 1, i + 1)][1] - top[Math.max(0, i - 1)][1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const up = 11 + rnd() * 9, apex = [top[i][0] + ux * up, top[i][1] + uy * up];
        D.strokePts(ctx, [[top[i][0] - tx * 8, top[i][1] - ty * 8], apex, [top[i][0] + tx * 8, top[i][1] + ty * 8]], { width: 3, color: D.COL.ink, rnd, fill: D.COL.paper, passes: 1 });
        D.line(ctx, apex[0], apex[1], top[i][0], top[i][1], { width: 1.6, color: D.COL.accent, passes: 1 });
      });
    } else if (style === 'bouncy') {
      // springy zigzag along the underside
      const zig = []; for (let i = 0; i < N; i++) zig.push(lerp2(top[i], bot[i], i % 2 ? 0.78 : 1.0));
      D.strokePts(ctx, zig, { width: 3, color: D.COL.accent, rnd, passes: 1, jitter: 0.3 });
    }
    ctx.restore();
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

  // a hazard slab bristling with sharp spikes — touching it deals heavy damage + knockback
  // (applied in game.js `_updateStage`). Drawn in ink with a thin accent glint up each spike so
  // it reads "do not touch", matching the crystal/trampoline use of accent for special tiles.
  function spikesPlat(ctx, p, rnd) {
    const r = Math.min(p.h / 2, 9);
    D.roundedRect(ctx, p.x, p.y, p.w, p.h, r, { width: 6, color: D.COL.ink, rnd, fill: D.COL.paper });
    // diagonal hazard hatching across the body
    ctx.save(); ctx.globalAlpha = 0.3; ctx.strokeStyle = D.COL.ink; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    for (let x = p.x + 12; x < p.x + p.w - 4; x += 26) {
      ctx.beginPath(); ctx.moveTo(x, p.y + p.h - 5); ctx.lineTo(x + 15, p.y + 7); ctx.stroke();
    }
    ctx.restore();
    // a row of sharp triangular teeth tiled EDGE-TO-EDGE across the full width, so the spikes
    // start and end flush with the slab's sides (no overhang past the box, no gap at the corners)
    const n = Math.max(2, Math.round(p.w / 30)), tw = p.w / n, base = p.y + 3;
    for (let i = 0; i < n; i++) {
      const x0 = p.x + i * tw, xc = x0 + tw / 2, up = 22 + rnd() * 8;
      D.strokePts(ctx, [[x0, base], [xc, base - up], [x0 + tw, base]], { width: 3.5, color: D.COL.ink, rnd, fill: D.COL.paper, passes: 1 });
      ctx.globalAlpha = 0.8;
      D.line(ctx, xc, base - up + 5, xc, base - 2, { width: 1.8, color: D.COL.accent, passes: 1 }); // danger glint
      ctx.globalAlpha = 1;
    }
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

  const PLAT = { ground: groundPlat, float: floatPlat, wood: woodPlat, stone: stonePlat, crystal: crystalPlat, box: boxPlat, trampoline: trampolinePlat, cannon: cannonPlat, drawn: drawnPlat, spikes: spikesPlat };

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

  // ---- procedural "dressing" (Townscaper-style) ----------------------------
  // Cosmetic scenery DERIVED from the platform layout, drawn entirely in the soft background gray
  // (SCN) so it reads as a backdrop while the inky platforms + fighters stay crisp in front. For
  // each platform we look at what sits beneath it across its span:
  //   • nothing below              → a jagged ISLAND underside (a floating chunk of land)
  //   • a surface fully under it   → two PILLARS near its ends, resting on that surface
  //   • it overhangs the surface   → pillars under the supported part + an island edge on the jut
  // plus VARIED plants on top (tuft/stalk/shrub/sprout/sapling) and VARIED foliage hanging beneath
  // (vine/roots/moss/tendril). Deterministic (seeded per platform box) and cached by a
  // geometry+density key, so it regrows the instant a layout changes and costs no derive time when
  // nothing changed. Purely visual: no collision, zero gameplay impact. Density 0..2.
  const SCN = BG_INK;                 // every dressing mark is the background gray
  const GAP_MIN = 40, PILLAR_MAX = 700; // a gap beyond PILLAR_MAX reads as floating → island, not pillar
  const TOP_KINDS = ['tuft', 'stalk', 'shrub', 'sprout'];
  const TOP_KINDS_BIG = ['tuft', 'stalk', 'shrub', 'sprout', 'sapling'];
  const HANG_KINDS = ['vine', 'roots', 'moss', 'tendril'];
  function pick(rnd, arr) { return arr[(rnd() * arr.length) | 0]; }

  // world-space TOP contour of a platform — the drawn stroke itself, or a flat line on a rectangle.
  function topContour(p) {
    if (p.kind === 'drawn' && p.pts && p.pts.length > 1) return p.pts.map((pt) => [p.x + pt[0], p.y + pt[1]]);
    return [[p.x, p.y], [p.x + p.w, p.y]];
  }
  // top point at world x: the HIGHEST surface (smallest y) spanning x + local tilt. null if outside.
  function topAt(contour, x) {
    let y = null, tilt = 0;
    for (let i = 0; i < contour.length - 1; i++) {
      const a = contour[i], b = contour[i + 1];
      if (x < Math.min(a[0], b[0]) - 0.01 || x > Math.max(a[0], b[0]) + 0.01) continue;
      const dx = b[0] - a[0], t = Math.abs(dx) < 1e-6 ? 0 : (x - a[0]) / dx;
      const yy = a[1] + (b[1] - a[1]) * t;
      if (y === null || yy < y) {
        y = yy; let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        tilt = ang;
      }
    }
    return y === null ? null : { y, tilt };
  }
  // the highest platform SURFACE below `belowY` spanning `x`, via each candidate's real top contour
  // (so a pillar lands on the actual, possibly slanted, surface). Returns {y, tilt} or null.
  function surfaceBelow(plats, x, belowY, ignore) {
    let best = null;
    for (const q of plats) {
      if (q === ignore || q.move) continue;
      if (x < q.x + 6 || x > q.x + q.w - 6) continue;
      const ta = topAt(topContour(q), x);
      if (ta && ta.y >= belowY && (!best || ta.y < best.y)) best = ta;
    }
    return best;
  }
  // union x-span (clipped to p) of any non-moving platform sitting beneath/at p within reach;
  // null = nothing under p at all → it's a floating island.
  function supportSpan(plats, p) {
    const pb = p.y + p.h; let l = Infinity, r = -Infinity;
    for (const q of plats) {
      if (q === p || q.move) continue;
      if (q.y < pb - 6 || q.y > pb + PILLAR_MAX) continue; // resting (≈pb) counts; deep-down doesn't
      const oL = Math.max(p.x, q.x), oR = Math.min(p.x + p.w, q.x + q.w);
      if (oR > oL) { l = Math.min(l, oL); r = Math.max(r, oR); }
    }
    return r > l ? { l, r } : null;
  }
  // world-space underside contour of a platform — the drawn stroke's ACTUAL bottom edge (so the
  // dressing follows a tilted/curved platform), or a flat line under a plain rectangle.
  function undersideContour(p) {
    if (p.kind === 'drawn' && p.pts && p.pts.length > 1) {
      const bot = offsetAlongNormal(p.pts, DRAWN_TH);
      return bot.map((b) => [p.x + b[0], p.y + b[1]]);
    }
    const pb = p.y + p.h;
    return [[p.x, pb], [p.x + p.w, pb]];
  }
  // underside point at world x: the LOWEST y where the contour spans x, plus the local surface tilt
  // (radians, normalised to [-90°,90°]) so a support's capital can sit flush. null if x is outside.
  function undersideAt(contour, x) {
    let y = null, tilt = 0;
    for (let i = 0; i < contour.length - 1; i++) {
      const a = contour[i], b = contour[i + 1];
      if (x < Math.min(a[0], b[0]) - 0.01 || x > Math.max(a[0], b[0]) + 0.01) continue;
      const dx = b[0] - a[0], t = Math.abs(dx) < 1e-6 ? 0 : (x - a[0]) / dx;
      const yy = a[1] + (b[1] - a[1]) * t;
      if (y === null || yy > y) {
        y = yy; let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        tilt = ang;
      }
    }
    return y === null ? null : { y, tilt };
  }
  // a point at `frac` (0..1) of arc length ALONG a contour, with the local tilt — used to anchor a
  // pillar to a real point on the underside (so its top always lands on the platform, even a steep
  // or curved end, instead of being guessed from an x that the offset contour may not even span).
  function contourPt(contour, frac) {
    const n = contour.length;
    if (n < 2) return { x: contour[0][0], y: contour[0][1], tilt: 0 };
    const seg = []; let total = 0;
    for (let i = 1; i < n; i++) { const d = Math.hypot(contour[i][0] - contour[i - 1][0], contour[i][1] - contour[i - 1][1]); seg.push(d); total += d; }
    let target = Math.max(0, Math.min(1, frac)) * total, i = 0;
    while (i < seg.length - 1 && target > seg[i]) { target -= seg[i]; i++; }
    const a = contour[i], b = contour[i + 1], t = seg[i] > 1e-6 ? target / seg[i] : 0;
    let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, tilt: ang };
  }
  // sample the underside across x0..x1 into a short polyline (used as an island's upper edge)
  function undersideStrip(contour, x0, x1) {
    const steps = Math.max(2, Math.round(Math.abs(x1 - x0) / 44)), out = [], y0 = contour[0][1];
    for (let i = 0; i <= steps; i++) { const x = x0 + (x1 - x0) * (i / steps), u = undersideAt(contour, x); out.push([x, u ? u.y : y0]); }
    return out;
  }
  function addHang(front, contour, x0, x1, density, seed) {
    const n = Math.max(1, Math.min(3, Math.round(((x1 - x0) / 200) * density)));
    for (let i = 0; i < n; i++) {
      const x = x0 + (x1 - x0) * (n === 1 ? 0.5 : i / (n - 1)), u = undersideAt(contour, x);
      front.push({ t: 'hang', x, y: (u ? u.y : contour[0][1]) - 6, kind: pick(DS.makeRng(seed + i * 13), HANG_KINDS), seed: seed + i * 13 });
    }
  }

  function deriveDressing(st, density) {
    const behind = [], front = [], plats = st.platforms || [];
    let floorBottom = -Infinity; // the lowest platform bottom — anything resting here is the base ground
    for (const q of plats) if (!q.move) floorBottom = Math.max(floorBottom, q.y + q.h);
    for (const p of plats) {
      if (p.move) continue; // swinging/moving platforms ride free — no anchored dressing
      const gimmick = p.kind === 'cannon' || p.kind === 'trampoline' || p.kind === 'spikes' || p.kind === 'box';
      const seed = DS.hashSeed('dr' + p.x + '_' + p.y + '_' + p.w + '_' + p.h);
      const pb = p.y + p.h, pr = p.x + p.w;
      const isBase = !p.pass && p.h >= 100 && pb >= floorBottom - 40; // a ground slab resting on the floor
      // ---- underside: island / pillars / overhang edges (skip the base ground) ----
      // everything anchors to the platform's real underside CONTOUR, so it follows a tilt/curve.
      if (!isBase) {
        const contour = undersideContour(p);
        const sp = supportSpan(plats, p);
        if (!sp) {
          // truly floating → a jagged island that follows the (possibly tilted) underside + foliage
          behind.push({ t: 'island', top: undersideStrip(contour, p.x, pr), depth: Math.min(150, Math.max(46, p.w * 0.4)), seed: seed + 1 });
          addHang(front, contour, p.x + p.w * 0.28, p.x + p.w * 0.72, density, seed + 2);
        } else {
          const l = Math.max(p.x, sp.l), r = Math.min(pr, sp.r), span = r - l;
          const pillars = []; // collect pillars so we can brace between them afterwards
          // drop a pillar from an anchor point (ax,ay,tilt) to the surface beneath; returns it or null
          const addPier = (ax, ay, tlt, idx, thin, plant) => {
            const sup = surfaceBelow(plats, ax, ay + 2, p);
            if (!sup || sup.y - ay <= GAP_MIN || sup.y - ay >= PILLAR_MAX) return null;
            const d = { t: 'pillar', x: ax, topY: ay, botY: sup.y, tilt: tlt, botTilt: sup.tilt, thin, seed: seed + 10 + idx * 7 };
            behind.push(d); pillars.push(d);
            if (plant && density >= 0.5) front.push({ t: 'plant', x: ax, y: sup.y, tilt: sup.tilt, kind: pick(DS.makeRng(seed + 20 + idx), TOP_KINDS), s: 0.78, seed: seed + 20 + idx });
            if (sup.y - ay > 240 && DS.makeRng(seed + 80 + idx)() < 0.38 * Math.min(1.2, density)) // ivy climbs some tall pillars
              front.push({ t: 'ivy', x: ax, topY: ay, botY: sup.y, side: idx % 2 ? 1 : -1, seed: seed + 85 + idx });
            return d;
          };
          // is the supported underside roughly horizontal? (so an x-based arcade reads right)
          const uL = contourPt(contour, 0.12), uR = contourPt(contour, 0.88);
          const flat = Math.abs(uR.y - uL.y) < span * 0.26;
          const midGap = (() => { const s = surfaceBelow(plats, (l + r) / 2, (uL.y + uR.y) / 2 + 2, p); return s ? s.y - (uL.y + uR.y) / 2 : 0; })();
          if (flat && span > 420 && midGap > 150 && density >= 0.6) {
            // ARCADE: a row of slim piers joined by arches (aqueduct/viaduct) — for big, tall, flat spans
            const bays = Math.max(2, Math.min(6, Math.round((span / 250) * density)));
            const tops = [];
            for (let k = 0; k <= bays; k++) {
              const x = l + (span * k) / bays, u = undersideAt(contour, x), ay = u ? u.y : pb;
              addPier(x, ay, u ? u.tilt : 0, k, true, false);
              tops.push([x, ay]);
            }
            for (let k = 0; k < bays; k++) {
              const a = tops[k], b = tops[k + 1], sd = Math.min(64, (b[0] - a[0]) * 0.5);
              behind.push({ t: 'arch', x0: a[0], y0: a[1], x1: b[0], y1: b[1], sd, seed: seed + 50 + k * 5 });
            }
          } else {
            // pillars anchored to points sampled ALONG the underside contour (near each end, + middle
            // when wide), so a support's top always lands ON the platform — even at a steep/curved end.
            const fracs = span < 150 ? [0.5] : [0.13, 0.87];
            if (span > 560 && density >= 1) fracs.splice(1, 0, 0.5);
            for (let i = 0; i < fracs.length; i++) { const a = contourPt(contour, fracs[i]); addPier(a.x, a.y, a.tilt, i, !!p.pass, i < 2); }
          }
          // trestle bracing between neighbouring tall pillars; a buttress for a tall lone pier
          if (density >= 0.7) {
            for (let k = 0; k + 1 < pillars.length; k++) {
              const A = pillars[k], B = pillars[k + 1];
              if (Math.abs(A.x - B.x) < 380 && Math.min(A.botY - A.topY, B.botY - B.topY) > 130)
                behind.push({ t: 'brace', ax: A.x, bx: B.x, topY: Math.max(A.topY, B.topY), botY: Math.min(A.botY, B.botY), seed: seed + 60 + k });
            }
            if (pillars.length === 1 && pillars[0].botY - pillars[0].topY > 300)
              behind.push({ t: 'buttress', x: pillars[0].x, topY: pillars[0].topY, botY: pillars[0].botY, dir: pillars[0].x < (l + r) / 2 ? 1 : -1, seed: seed + 70 });
          }
          // overhangs → a jagged island edge (and foliage) on each jutting side, following the underside
          if (l - p.x > 50) { behind.push({ t: 'island', top: undersideStrip(contour, p.x, l + 8), depth: Math.min(96, (l - p.x) * 0.7), seed: seed + 31 }); addHang(front, contour, p.x + 8, l - 8, density, seed + 32); }
          if (pr - r > 50) { behind.push({ t: 'island', top: undersideStrip(contour, r - 8, pr), depth: Math.min(96, (pr - r) * 0.7), seed: seed + 41 }); addHang(front, contour, r + 8, pr - 8, density, seed + 42); }
        }
      }
      // ---- a few varied plants ON TOP, sitting on the real surface and tilting with it ----
      if (!gimmick && p.w >= 110) {
        const topC = topContour(p);
        const n = Math.max(0, Math.round((p.w / 300) * density));
        for (let i = 0; i < n; i++) {
          const r2 = DS.makeRng(seed + 700 + i * 29);
          const x = p.x + 32 + (p.w - 64) * r2(), ta = topAt(topC, x);
          front.push({ t: 'plant', x, y: ta ? ta.y : p.y, tilt: ta ? ta.tilt : 0, kind: pick(r2, isBase ? TOP_KINDS_BIG : TOP_KINDS), s: 0.76 + r2() * 0.5, seed: seed + 700 + i });
        }
        // a low railing along a wide, roughly-flat top (some of them) — reads as a balcony/parapet
        const eL = topAt(topC, p.x + 30), eR = topAt(topC, pr - 30);
        if (p.w > 300 && density >= 0.6 && eL && eR && Math.abs(eL.y - eR.y) < p.w * 0.2 && DS.makeRng(seed + 900)() < 0.55) {
          const steps = Math.max(3, Math.round(p.w / 70)), pts = [];
          for (let i = 0; i <= steps; i++) { const x = p.x + 24 + (p.w - 48) * (i / steps), ta = topAt(topC, x); pts.push([x, ta ? ta.y : p.y]); }
          front.push({ t: 'railing', pts, seed: seed + 910 });
        }
      }
    }
    // ---- bridges between neighbouring platforms across a modest gap at a similar height ----
    // each platform links to its NEAREST qualifying right-hand neighbour (so ~n bridges, not n²),
    // skipping any pair with another platform sitting in the gap.
    const edges = [];
    for (const p of plats) {
      if (p.move || p.kind === 'cannon' || p.kind === 'trampoline' || p.kind === 'spikes') continue;
      const tc = topContour(p); let lx = Infinity, rx = -Infinity, ly = 0, ry = 0;
      for (const pt of tc) { if (pt[0] < lx) { lx = pt[0]; ly = pt[1]; } if (pt[0] > rx) { rx = pt[0]; ry = pt[1]; } }
      edges.push({ lx, ly, rx, ry, y: p.y });
    }
    for (let i = 0; i < edges.length; i++) {
      const A = edges[i]; let best = null, bestGap = 1e9;
      for (let j = 0; j < edges.length; j++) {
        if (i === j) continue; const B = edges[j], gap = B.lx - A.rx;
        if (gap <= 70 || gap > 430 || Math.abs(A.ry - B.ly) > 150) continue;
        if (gap < bestGap) { bestGap = gap; best = B; }
      }
      if (!best) continue;
      const by = (A.ry + best.ly) / 2;
      let blocked = false;
      for (const C of edges) { if (C === A || C === best) continue; if (C.rx > A.rx + 6 && C.lx < best.lx - 6 && Math.abs(C.y - by) < 200) { blocked = true; break; } }
      if (blocked) continue;
      const kind = bestGap < 150 ? 'stones' : (bestGap < 300 ? 'rope' : 'arch');
      front.push({ t: 'bridge', x0: A.rx, y0: A.ry, x1: best.lx, y1: best.ly, kind, seed: DS.hashSeed('br' + Math.round(A.rx) + '_' + Math.round(best.lx)) });
    }
    return { behind, front };
  }

  // a support pillar/stilt: a vertical tapered paper column dropping to the surface below, capped by
  // a lintel that ROTATES to sit flush against the (possibly tilted) underside it holds up.
  function drawPillar(ctx, it) {
    const rnd = DS.makeRng(it.seed), h = it.botY - it.topY, cx = it.x, topY = it.topY, botY = it.botY, tilt = it.tilt || 0;
    const wt = it.thin ? 9 : 15, wb = it.thin ? 12 : 20; // half-widths: slim stilt vs chunky pier
    D.strokePts(ctx, [[cx - wt, topY + 6], [cx - wb, botY], [cx + wb, botY], [cx + wt, topY + 6]],
      { width: 4.5, color: SCN, rnd, closed: true, fill: D.COL.paper, passes: 1 }); // vertical shaft
    ctx.globalAlpha = 0.5;
    D.line(ctx, cx, topY + 12, cx, botY - 7, { width: 2, color: SCN, passes: 1 });
    const courses = Math.max(1, Math.round(h / 130));
    for (let i = 1; i <= courses; i++) { const y = topY + 6 + ((h - 6) * i) / (courses + 1); D.line(ctx, cx - wt * 0.8, y, cx + wt * 0.8, y, { width: 2, color: SCN, rnd, passes: 1 }); }
    ctx.globalAlpha = 1;
    if (!it.thin && h > 230) { // chunky tall pier → a couple of little arched windows (a tower leg)
      const wins = Math.min(3, Math.floor(h / 170));
      for (let i = 0; i < wins; i++) {
        const wy = topY + 46 + (h - 92) * (i / Math.max(1, wins - 1 || 1)) * (wins > 1 ? 1 : 0) + (wins === 1 ? (h - 92) * 0.4 : 0);
        D.strokePts(ctx, [[cx - 6, wy + 9], [cx - 6, wy - 3], [cx, wy - 11], [cx + 6, wy - 3], [cx + 6, wy + 9]], { width: 2.4, color: SCN, rnd, passes: 1 });
      }
    }
    ctx.save(); ctx.translate(cx, botY); ctx.rotate(it.botTilt || 0); // footing flush to the surface it rests on
    D.strokePts(ctx, [[-wb - 7, 0], [wb + 7, 0], [wb + 2, -9], [-wb - 2, -9]],
      { width: 4, color: SCN, rnd, closed: true, fill: D.COL.paper, passes: 1 });
    ctx.restore();
    ctx.save(); ctx.translate(cx, topY); ctx.rotate(tilt); // capital flush to the underside slope
    D.strokePts(ctx, [[-wt - 6, 0], [wt + 6, 0], [wt + 2, 11], [-wt - 2, 11]],
      { width: 4, color: SCN, rnd, closed: true, fill: D.COL.paper, passes: 1 });
    ctx.restore();
  }

  // a jagged island underside: the upper edge FOLLOWS the platform's underside (so it tilts/curves
  // with it); the belly juts into sharp points, deepest toward the middle, like a chunk of rock.
  function drawIsland(ctx, it) {
    const rnd = DS.makeRng(it.seed), top = it.top, n = top.length, depth = it.depth || 80;
    const pts = top.slice(); // upper edge = the underside contour, left → right
    for (let i = n - 1; i >= 0; i--) {                 // belly, right → left, hanging below each top point
      const t = n === 1 ? 0 : i / (n - 1);
      const dy = depth * Math.sin(t * Math.PI) * (i % 2 ? 1 : 0.55) * (0.7 + 0.45 * rnd());
      pts.push([top[i][0], top[i][1] + dy]);
    }
    D.strokePts(ctx, pts, { width: 4, color: SCN, rnd, closed: true, fill: D.COL.paper, passes: 1 });
  }

  // varied foliage hanging from an underside (x,y) downward
  function drawHang(ctx, it) {
    const rnd = DS.makeRng(it.seed), x = it.x, y = it.y;
    if (it.kind === 'roots') {
      for (let i = -1; i <= 1; i++) { const len = 44 + rnd() * 30, bx = x + i * 7; D.curve(ctx, [[bx, y], [bx + i * 5, y + len * 0.5], [bx + i * 9, y + len]], { width: 3, color: SCN, rnd, passes: 1 }); }
    } else if (it.kind === 'moss') {
      for (let i = -1; i <= 1; i++) { const lx = x + i * 12, ll = 14 + rnd() * 16; D.line(ctx, lx, y, lx, y + ll, { width: 2.5, color: SCN, rnd, passes: 1 }); D.circle(ctx, lx, y + ll, 5 + rnd() * 3, { width: 3, color: SCN, rnd, fill: D.COL.paper }); }
    } else if (it.kind === 'tendril') {
      const len = 66 + rnd() * 34, pts = [];
      for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push([x + Math.sin(t * 7) * 13 * t, y + t * len]); }
      D.strokePts(ctx, pts, { width: 3, color: SCN, rnd, passes: 1 }); D.circle(ctx, pts[8][0], pts[8][1], 4, { width: 2.5, color: SCN, rnd });
    } else { // vine: curvy strand with little leaves
      const len = 80, pts = [];
      for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push([x + Math.sin(t * 6) * 8, y + t * len]); }
      D.strokePts(ctx, pts, { width: 3, color: SCN, rnd, passes: 1 });
      for (let i = 1; i <= 4; i++) { const t = i / 6, lx = x + Math.sin(t * 6) * 8, ly = y + t * len; D.strokePts(ctx, [[lx, ly], [lx + (i % 2 ? 12 : -12), ly - 3], [lx + (i % 2 ? 8 : -8), ly + 7]], { width: 2.5, color: SCN, rnd, closed: true, fill: D.COL.paper, passes: 1 }); }
    }
  }

  // varied little plants growing UP from a surface (x,y)
  function drawTopPlant(ctx, it) {
    const rnd = DS.makeRng(it.seed);
    ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(it.tilt || 0); ctx.scale(it.s || 1, it.s || 1); // grow perpendicular to the surface
    if (it.kind === 'tuft') {
      for (let i = -1; i <= 1; i++) D.curve(ctx, [[i * 6, 0], [i * 9, -13], [i * 15, -20]], { width: 3, color: SCN, rnd, passes: 1 });
    } else if (it.kind === 'stalk') {
      D.curve(ctx, [[0, 0], [-2, -18], [1, -32]], { width: 3, color: SCN, rnd, passes: 1 }); D.circle(ctx, 1, -36, 5, { width: 3, color: SCN, rnd, fill: D.COL.paper });
    } else if (it.kind === 'shrub') {
      const pts = [], N = 14; for (let i = 0; i <= N; i++) { const a = Math.PI + (i / N) * Math.PI, rr = 19 + Math.sin(i * 1.7) * 5; pts.push([Math.cos(a) * rr, Math.sin(a) * rr * 0.7]); }
      pts.push([21, 0]); pts.push([-21, 0]); D.strokePts(ctx, pts, { width: 4, color: SCN, rnd, closed: true, fill: D.COL.paper, passes: 1 });
    } else if (it.kind === 'sprout') {
      D.line(ctx, 0, 0, 0, -22, { width: 4, color: SCN, rnd, passes: 1 }); D.strokePts(ctx, [[-10, -15], [0, -26], [10, -15]], { width: 3, color: SCN, rnd, fill: D.COL.paper, passes: 1 });
    } else { // sapling: a little tree
      D.strokePts(ctx, [[-6, 0], [-4, -34], [4, -34], [6, 0]], { width: 4, color: SCN, rnd, fill: D.COL.paper, passes: 1 });
      for (const b of [[-16, -44, 18], [14, -50, 20], [0, -62, 22]]) D.circle(ctx, b[0], b[1], b[2], { width: 4, color: SCN, rnd, fill: D.COL.paper, wob: 2 });
    }
    ctx.restore();
  }

  // an arcade arch between two piers: springs from a point down each pier and crowns at the deck
  function drawArch(ctx, it) {
    const rnd = DS.makeRng(it.seed), midx = (it.x0 + it.x1) / 2, crown = Math.min(it.y0, it.y1) + 4;
    D.curve(ctx, [[it.x0, it.y0 + it.sd], [midx, crown], [it.x1, it.y1 + it.sd]], { width: 4, color: SCN, rnd, passes: 1 });
    ctx.globalAlpha = 0.4; D.curve(ctx, [[it.x0 + 4, it.y0 + it.sd], [midx, crown + 7], [it.x1 - 4, it.y1 + it.sd]], { width: 2.5, color: SCN, rnd, passes: 1 }); ctx.globalAlpha = 1;
    ctx.fillStyle = SCN; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(midx, crown - 1, 2.6, 0, 7); ctx.fill(); ctx.globalAlpha = 1; // keystone dot
  }
  // a trestle X-brace between two neighbouring pillars, in their lower-middle band
  function drawBrace(ctx, it) {
    const rnd = DS.makeRng(it.seed), h = it.botY - it.topY, y0 = it.topY + h * 0.46, y1 = it.topY + h * 0.74;
    ctx.globalAlpha = 0.55;
    D.line(ctx, it.ax, y0, it.bx, y1, { width: 2.5, color: SCN, rnd, passes: 1 });
    D.line(ctx, it.ax, y1, it.bx, y0, { width: 2.5, color: SCN, rnd, passes: 1 });
    ctx.globalAlpha = 1;
  }
  // a buttress: a wedge strut bracing a tall lone pier back to the ground
  function drawButtress(ctx, it) {
    const rnd = DS.makeRng(it.seed), h = it.botY - it.topY, sy = it.topY + h * 0.34, ex = it.x + it.dir * Math.min(130, h * 0.5);
    D.strokePts(ctx, [[it.x, sy], [ex, it.botY], [ex - it.dir * 18, it.botY], [it.x - it.dir * 9, sy + 12]],
      { width: 4, color: SCN, rnd, closed: true, fill: D.COL.paper, passes: 1 });
  }

  function drawDressBehind(ctx, it) {
    if (it.t === 'pillar') drawPillar(ctx, it);
    else if (it.t === 'island') drawIsland(ctx, it);
    else if (it.t === 'arch') drawArch(ctx, it);
    else if (it.t === 'brace') drawBrace(ctx, it);
    else if (it.t === 'buttress') drawButtress(ctx, it);
  }
  // ivy climbing up a pillar, with little leaves
  function drawIvy(ctx, it) {
    const rnd = DS.makeRng(it.seed), x = it.x, h = it.botY - it.topY, side = it.side || 1, n = Math.max(4, Math.round(h / 42));
    const pts = [];
    for (let i = 0; i <= n; i++) { const t = i / n; pts.push([x + Math.sin(t * 7 + side) * 7 * side, it.botY - t * h]); }
    D.strokePts(ctx, pts, { width: 2.5, color: SCN, rnd, passes: 1 });
    for (let i = 1; i < n; i++) {
      if (i % 2) continue;
      const t = i / n, lx = x + Math.sin(t * 7 + side) * 7 * side, ly = it.botY - t * h, d2 = (i % 4 === 0 ? 1 : -1) * side;
      D.strokePts(ctx, [[lx, ly], [lx + d2 * 11, ly - 5], [lx + d2 * 7, ly + 5]], { width: 2.4, color: SCN, rnd, closed: true, fill: D.COL.paper, passes: 1 });
    }
  }
  // a low parapet railing following a flat top: a rail line on short posts
  function drawRailing(ctx, it) {
    const rnd = DS.makeRng(it.seed), pts = it.pts, H = 18;
    D.strokePts(ctx, pts.map((p) => [p[0], p[1] - H]), { width: 3, color: SCN, rnd, passes: 1 }); // rail
    for (let i = 0; i < pts.length; i++) D.line(ctx, pts[i][0], pts[i][1] - 1, pts[i][0], pts[i][1] - H, { width: 2, color: SCN, rnd, passes: 1 }); // posts
  }
  // a connector spanning a gap between two ledges: stepping-stones / rope bridge / stone arch
  function drawBridge(ctx, it) {
    const rnd = DS.makeRng(it.seed), x0 = it.x0, y0 = it.y0, x1 = it.x1, y1 = it.y1, dx = x1 - x0;
    if (it.kind === 'stones') {
      const n = Math.max(2, Math.round(dx / 46));
      for (let i = 1; i < n; i++) { const t = i / n, x = x0 + dx * t, y = y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * 12; D.circle(ctx, x, y + 6, 7, { width: 3, color: SCN, rnd, fill: D.COL.paper }); }
    } else if (it.kind === 'rope') {
      const sag = Math.min(40, dx * 0.16);
      const rope = (off) => { const p = []; for (let i = 0; i <= 8; i++) { const t = i / 8; p.push([x0 + dx * t, y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * sag + off]); } return p; };
      const top = rope(0), bot = rope(13);
      D.strokePts(ctx, top, { width: 2.5, color: SCN, rnd, passes: 1 });
      D.strokePts(ctx, bot, { width: 3, color: SCN, rnd, passes: 1 });
      for (let i = 1; i < 8; i++) D.line(ctx, top[i][0], top[i][1], bot[i][0], bot[i][1], { width: 2, color: SCN, rnd, passes: 1 }); // planks
    } else { // arch: a flat deck with a stone arch springing below it
      D.line(ctx, x0, y0, x1, y1, { width: 3.5, color: SCN, rnd, passes: 1 });
      const midx = (x0 + x1) / 2, midy = (y0 + y1) / 2;
      D.curve(ctx, [[x0 + dx * 0.12, y0 + (y1 - y0) * 0.12], [midx, midy + Math.min(70, dx * 0.34)], [x1 - dx * 0.12, y1 - (y1 - y0) * 0.12]], { width: 3, color: SCN, rnd, passes: 1 });
    }
  }

  function drawDressFront(ctx, it) {
    if (it.t === 'hang') drawHang(ctx, it);
    else if (it.t === 'plant') drawTopPlant(ctx, it);
    else if (it.t === 'ivy') drawIvy(ctx, it);
    else if (it.t === 'railing') drawRailing(ctx, it);
    else if (it.t === 'bridge') drawBridge(ctx, it);
  }

  // compute (and cache) the derived dressing for a stage. Key = density + every platform's box, so
  // it regenerates only when the layout (or the slider) actually changes. Moving platforms are
  // tokenised out of the key (their live position changes each frame but they're never dressed).
  const EMPTY_DRESS = { behind: [], front: [] };
  function dressOf(st) {
    const sc = DS.Store && DS.Store.data && DS.Store.data.settings && DS.Store.data.settings.scenery;
    const density = sc == null ? 1 : sc;
    if (density <= 0) { st._dress = EMPTY_DRESS; st._dressKey = 'off'; return EMPTY_DRESS; }
    let key = density.toFixed(2) + '|';
    for (const p of st.platforms) key += p.move ? 'M;' : (p.x + ',' + p.y + ',' + p.w + ',' + p.h + ',' + (p.pass ? 1 : 0) + (p.kind || '') + ';');
    if (st._dressKey !== key) { st._dress = deriveDressing(st, density); st._dressKey = key; }
    return st._dress;
  }

  // ---- composition ---------------------------------------------------------
  // accepts a stage object ({platforms,...}) or the data wrapper ({stage:...}).
  function stageOf(data) { return data.platforms ? data : data.stage; }

  // Parallax: a layer drifts at rate `depth` relative to how far the camera has panned from its
  // home (the stage-centred resting view). depth 1 = locked to the playfield (moves 1:1), depth 0
  // = static (infinitely far). Crucially it's anchored to home, so at rest every layer sits exactly
  // where it was authored; only camera *deviation* spreads the layers apart into a diorama.
  // cam/home are optional; without them (e.g. the static editor preview) everything draws unshifted.
  function px(v, cam, home, depth) { return cam == null ? v : v + (1 - depth) * (cam - home); }

  // Background — called before drawStage, inside the world transform. The authored parallax
  // structures (mountains/towers, the `st.bg` array) are intentionally OFF for now: this draws a
  // simple placeholder of a faint line or two (a real background layer is planned separately). The
  // bg art lives in the same scenery gray (SCN) as the dressing so it all reads as one backdrop.
  function drawBackground(ctx, data, cam, home) {
    const st = stageOf(data);
    const b = st.bounds || { x0: 0, y0: 0, x1: DS.VIEW.w, y1: DS.VIEW.h };
    const x0 = b.x0 - 500, x1 = b.x1 + 500;
    const baseY = st.bounds ? b.y1 * 0.46 : DS.VIEW.h * 0.52; // a soft horizon
    ctx.save(); ctx.strokeStyle = SCN; ctx.lineCap = 'round'; ctx.globalAlpha = 0.45;
    for (let i = 0; i < 2; i++) {
      ctx.lineWidth = 3 - i;
      ctx.beginPath();
      ctx.moveTo(px(x0, cam && cam.cx, home && home.x, 0.25), baseY + i * 30);
      ctx.lineTo(px(x1, cam && cam.cx, home && home.x, 0.25), baseY + i * 30);
      ctx.stroke();
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawStage(ctx, data, cam, home) {
    const st = stageOf(data);
    const cx = cam && cam.cx, cy = cam && cam.cy, hx = home && home.x, hy = home && home.y;
    const dress = dressOf(st); // procedural pillars/plants derived from the layout (cached)
    // clouds live in the sky → a gentle far-layer parallax so they drift slower than the field
    for (const d of st.decor || []) if (d.type === 'cloud') cloud(ctx, px(d.x, cx, hx, 0.35), px(d.y, cy, hy, 0.35), d.s);
    for (const it of dress.behind) drawDressBehind(ctx, it); // pillars + island undersides, BEHIND platforms
    for (const p of st.platforms) if (p.move && p.move.type === 'swing') ropes(ctx, p);
    for (const p of st.platforms) platform(ctx, p);
    for (const it of dress.front) drawDressFront(ctx, it);   // hanging foliage + top plants, in FRONT
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
