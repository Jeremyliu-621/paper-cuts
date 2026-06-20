// Parametric doodle fighter: turns a pose (joint angles) into charcoal line-art.
// Monochrome, soft-marker look. Used by Play and by the Editor preview.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;
  const RAD = Math.PI / 180;

  // local-space skeleton geometry (origin = fighter center). chunky, cute proportions.
  const GEO = {
    shoulder: { x: 0, y: -8 },
    hip: { x: 0, y: 12 },
    headY: -33, headR: 19,
    bodyCx: 0, bodyCy: 0, bodyRx: 15, bodyRy: 17,
    armUp: 13, armFore: 12,
    legUp: 13, legShin: 13,
  };
  // generous draw box so reach/jumps fit when cached/blitted
  const BOX = { w: 190, h: 190, ox: 95, oy: 104 };

  function solveLimb(hx, hy, l1, l2, a1, a2, facing) {
    const r1 = a1 * RAD;
    const e1x = hx + Math.sin(r1) * facing * l1;
    const e1y = hy + Math.cos(r1) * l1;
    const r2 = (a1 + a2) * RAD;
    const e2x = e1x + Math.sin(r2) * facing * l2;
    const e2y = e1y + Math.cos(r2) * l2;
    return [[hx, hy], [e1x, e1y], [e2x, e2y]];
  }

  function limbStroke(ctx, pts, w, col, rnd, end) {
    D.strokePts(ctx, pts, { width: w, color: col, rnd, jitter: 1.2 });
    if (end === 'fist') { // filled nub hand
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(pts[2][0], pts[2][1], w * 0.62, 0, 7); ctx.fill();
    } else if (end === 'foot') { // little shoe pointing forward
      const ang = Math.atan2(pts[2][1] - pts[1][1], pts[2][0] - pts[1][0]) + Math.PI / 2;
      ctx.save(); ctx.translate(pts[2][0], pts[2][1]); ctx.rotate(ang * 0.3);
      ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(0, 0, w * 0.95, w * 0.62, 0, 0, 7); ctx.fill();
      ctx.restore();
    }
  }

  function head(ctx, cx, cy, r, headType, facing, expr, blink, col, rnd) {
    D.circle(ctx, cx, cy, r, { width: 5.5, color: col, rnd, wob: 1.2 });

    // face (eyes biased toward facing)
    const ex = cx + facing * 4.5, ey = cy + 1, gap = 7;
    ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.lineCap = 'round';
    const eye = (x) => {
      ctx.beginPath();
      if (blink || expr === 'shield') { ctx.moveTo(x - 3, ey); ctx.lineTo(x + 3, ey); }
      else if (expr === 'hurt') { ctx.moveTo(x - 3, ey - 3); ctx.lineTo(x + 3, ey + 3); ctx.moveTo(x + 3, ey - 3); ctx.lineTo(x - 3, ey + 3); }
      else { ctx.moveTo(x, ey - 4); ctx.lineTo(x, ey + 4); }
      ctx.stroke();
    };
    eye(ex - gap / 2); eye(ex + gap / 2);
    if (expr === 'attack') { // little open mouth
      D.line(ctx, cx + facing * 2, cy + 9, cx + facing * 7, cy + 9, { width: 3, color: col, rnd, passes: 1 });
    }

    // head decoration
    if (headType === 'spikes') {
      const top = cy - r;
      for (let i = -1; i <= 1; i++) {
        const bx = cx + i * 7;
        D.line(ctx, bx, top + 6, bx + i * 4, top - 9, { width: 4.5, color: col, rnd, passes: 1 });
      }
    } else if (headType === 'beanie') {
      // cap arc over the top half
      const pts = [];
      for (let a = 200; a <= 340; a += 14) pts.push([cx + Math.cos(a * RAD) * (r + 1), cy + Math.sin(a * RAD) * (r + 1)]);
      D.strokePts(ctx, pts, { width: 5, color: col, rnd });
      D.line(ctx, cx - r * 0.8, cy - r * 0.55, cx + r * 0.8, cy - r * 0.55, { width: 4, color: col, rnd, passes: 1 });
      D.circle(ctx, cx, cy - r - 4, 4, { width: 4, color: col, rnd });
    } else if (headType === 'tuft') {
      D.curve(ctx, [[cx - 4, cy - r + 4], [cx + 2, cy - r - 8], [cx + 9, cy - r + 2]], { width: 4.5, color: col, rnd });
    }
  }

  // Draws a fighter in LOCAL space; caller sets the transform so (0,0) is the
  // fighter center. opts: { facing, color, expr, blink, seed }
  function drawFighter(ctx, ch, p, opts) {
    opts = opts || {};
    // a hand-drawn skin replaces the parametric stick figure (same rig/joints)
    if (DS.skin && DS.skin.hasSkin(ch)) { DS.skin.render(ctx, ch, p, opts); return; }
    const facing = opts.facing || 1;
    const col = opts.color || D.COL.ink;
    const rnd = DS.makeRng(opts.seed || 7);
    const g = GEO;

    const scale = (ch.stats && ch.stats.scale) || opts.scale || 1;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(0, GEO_BIAS);            // small bias so feet sit near origin baseline
    ctx.rotate(p.lean * facing * RAD * 0.5);
    ctx.scale(1, p.squash || 1);

    const sh = g.shoulder, hip = g.hip;
    const headC = { x: (p.headX || 0) * facing, y: g.headY + (p.headY || 0) };

    // back limbs (depth: thinner + slightly faded)
    ctx.globalAlpha = 0.85;
    limbStroke(ctx, solveLimb(sh.x, sh.y, g.armUp, g.armFore, p.armBack.sh, p.armBack.el, facing), 5.5, col, rnd, 'fist');
    limbStroke(ctx, solveLimb(hip.x, hip.y, g.legUp, g.legShin, p.legBack.hip, p.legBack.knee, facing), 6, col, rnd, 'foot');
    ctx.globalAlpha = 1;

    // body (round egg)
    D.ellipse(ctx, g.bodyCx + facing * 1, g.bodyCy, g.bodyRx, g.bodyRy, { width: 5.5, color: col, rnd, fill: D.COL.paper, wob: 1 });

    // head
    head(ctx, headC.x, headC.y, g.headR, ch.head, facing, opts.expr, opts.blink, col, rnd);

    // front limbs (on top, full weight)
    limbStroke(ctx, solveLimb(sh.x, sh.y, g.armUp, g.armFore, p.armFront.sh, p.armFront.el, facing), 6.5, col, rnd, 'fist');
    limbStroke(ctx, solveLimb(hip.x, hip.y, g.legUp, g.legShin, p.legFront.hip, p.legFront.knee, facing), 7, col, rnd, 'foot');

    ctx.restore();
  }
  const GEO_BIAS = -4;

  // the big doodle weapons the speed-moves morph into (and the hammer prop), drawn centered
  // at the fighter origin facing +x*dir. shared by Fighter.render and the editor preview.
  // opts: { dir, scale, big (glove), aim (cannon), swing (hammer 0=up→1=slammed) }
  function weapon(ctx, kind, opts) {
    opts = opts || {};
    const dir = opts.dir || 1, S = opts.scale || 1, ink = opts.color || D.COL.ink;
    const rnd = DS.makeRng(kind === 'cannon' ? 41 : kind === 'hammer' ? 21 : 31);
    ctx.save(); ctx.scale(S, S);
    if (kind === 'glove') {
      const fill = opts.big ? D.COL.accent : D.COL.paper, g = opts.big ? 1.18 : 1;
      ctx.scale(dir * g, g); ctx.translate(4, 0);
      D.strokePts(ctx, [[-46, -22], [-24, -28], [-24, 28], [-46, 22]], { width: 6, color: ink, rnd, closed: true, fill: D.COL.paperShade }); // cuff
      D.line(ctx, -35, -25, -35, 25, { width: 4, color: ink, rnd, passes: 1 });
      D.circle(ctx, 8, 4, 34, { width: 6, color: ink, rnd, fill, wob: 2 });    // mitt
      D.circle(ctx, 0, -26, 16, { width: 5, color: ink, rnd, fill, wob: 1.5 }); // thumb
      D.curve(ctx, [[24, -20], [32, 4], [24, 26]], { width: 4, color: ink, rnd });
    } else if (kind === 'cannon') {
      ctx.scale(dir, 1); ctx.rotate(-(opts.aim || 0));
      D.strokePts(ctx, [[-34, -16], [34, -18], [34, 18], [-34, 16]], { width: 6, color: ink, rnd, closed: true, fill: D.COL.paperShade }); // barrel
      D.strokePts(ctx, [[30, -22], [46, -20], [46, 20], [30, 22]], { width: 6, color: ink, rnd, closed: true, fill: D.COL.paper }); // muzzle
      D.circle(ctx, 41, 0, 10, { width: 4, color: ink, rnd, fill: ink });  // bore
      D.circle(ctx, -34, 0, 17, { width: 6, color: ink, rnd, fill: D.COL.paper }); // breech
      D.circle(ctx, -8, 28, 16, { width: 5, color: ink, rnd, fill: D.COL.paper }); // wheel
      D.circle(ctx, -8, 28, 4, { width: 4, color: ink, rnd, fill: ink });
    } else if (kind === 'hammer') {
      const rot = -0.6 + (opts.swing == null ? 0.85 : opts.swing) * 3.0, HL = 48;
      ctx.translate(0, -6); ctx.scale(dir, 1); ctx.rotate(rot);
      D.line(ctx, 0, 8, 0, -HL, { width: 6, color: ink, rnd, passes: 1 }); // handle
      D.strokePts(ctx, [[-14, -HL - 1], [16, -HL - 1], [16, -HL - 21], [-14, -HL - 21]], { width: 5, color: ink, rnd, closed: true, fill: opts.headFill || D.COL.paperShade }); // head
    } else if (kind === 'spear') {
      // a long shaft thrust straight UP with a big leaf-shaped point at the top + a binding wrap
      const SL = 86; ctx.scale(dir, 1);
      D.line(ctx, 0, 34, 0, -SL, { width: 6, color: ink, rnd, passes: 1 });           // long shaft
      D.strokePts(ctx, [[0, -SL - 36], [-13, -SL], [0, -SL + 10], [13, -SL]], { width: 5, color: ink, rnd, closed: true, fill: opts.headFill || D.COL.paperShade }); // big leaf blade
      D.line(ctx, -7, -SL + 17, 7, -SL + 11, { width: 3.5, color: ink, rnd, passes: 1 }); // wrap
    }
    ctx.restore();
  }

  // a clawed paw at the end of a limb: 3 short claws fanning forward
  function claws(ctx, pt, facing, col, rnd) {
    const x = pt[2][0], y = pt[2][1];
    for (let i = -1; i <= 1; i++) D.line(ctx, x, y, x + facing * 9, y + i * 6 - 2, { width: 3, color: col, rnd, passes: 1 });
  }

  function wolfHead(ctx, cx, cy, facing, col, rnd, expr, blink) {
    // ears (pointed, swept back)
    for (const s of [-1, 1]) {
      const ex = cx + (s < 0 ? -facing * 9 : facing * 2);
      D.strokePts(ctx, [[ex - 5, cy - 11], [ex + facing * (s < 0 ? -4 : 6), cy - 26], [ex + 7, cy - 10]],
        { width: 4, color: col, rnd, closed: true, fill: D.COL.paper });
    }
    // skull
    D.circle(ctx, cx, cy, 10, { width: 4.5, color: col, rnd, fill: D.COL.paper, wob: 1.2 });
    // snout (long tapered muzzle forward)
    D.strokePts(ctx, [[cx + facing * 5, cy - 5], [cx + facing * 30, cy - 1], [cx + facing * 29, cy + 8], [cx + facing * 4, cy + 7]],
      { width: 4.5, color: col, rnd, closed: true, fill: D.COL.paper });
    // nose
    D.circle(ctx, cx + facing * 29, cy + 2, 2.6, { width: 3, color: col, rnd, fill: col });
    // fierce slanted eye
    if (blink) D.line(ctx, cx + facing * 2, cy - 2, cx + facing * 9, cy - 2, { width: 3, color: col, rnd, passes: 1 });
    else { ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(cx + facing * 5, cy - 2, 2.6, 2, facing * -0.5, 0, 7); ctx.fill(); }
    D.line(ctx, cx - facing * 1, cy - 6, cx + facing * 10, cy - 3, { width: 2.5, color: col, rnd, passes: 1 }); // brow
    // fangs (open maw)
    for (let i = 0; i < 2; i++) {
      const fx = cx + facing * (12 + i * 8);
      D.strokePts(ctx, [[fx, cy + 6], [fx + facing * 3, cy + 12], [fx + facing * 5, cy + 6]], { width: 2.5, color: col, rnd, closed: true, fill: D.COL.paper });
    }
  }

  // the WEREWOLF transform — drawn from the same pose joints so it animates (bigger, hunched,
  // clawed, snouted, with ears + a bushy tail + back fur). opts: {facing, color, expr, blink, seed}
  function drawWolf(ctx, ch, p, opts) {
    opts = opts || {};
    const facing = opts.facing || 1, col = opts.color || D.COL.ink, rnd = DS.makeRng(opts.seed || 7);
    const scale = ((ch.stats && ch.stats.scale) || 1) * 1.3;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(0, GEO_BIAS - 4);
    ctx.rotate(p.lean * facing * RAD * 0.5);
    ctx.scale(1, p.squash || 1);
    // anchors: shoulders high & forward, hips low & back (a hunched, leaning beast)
    const shX = facing * 9, shY = -6, hip = { x: -facing * 7, y: 13 };
    const leg = (lp, w, a) => { ctx.globalAlpha = a; const L = solveLimb(hip.x, hip.y, 12, 15, lp.hip, lp.knee + 16, facing); D.strokePts(ctx, L, { width: w, color: col, rnd }); claws(ctx, L, facing, col, rnd); ctx.globalAlpha = 1; };
    const arm = (sh, el, w, a) => { ctx.globalAlpha = a; const L = solveLimb(shX, shY, 14, 15, sh, el, facing); D.strokePts(ctx, L, { width: w, color: col, rnd }); claws(ctx, L, facing, col, rnd); ctx.globalAlpha = 1; };
    // bushy tail off the low rump, sweeping up and back
    const tx = -facing * 16;
    D.curve(ctx, [[tx, 12], [tx - facing * 14, 6], [tx - facing * 22, -12]], { width: 7, color: col, rnd });
    D.circle(ctx, tx - facing * 22, -14, 7, { width: 4, color: col, rnd, fill: D.COL.paper });
    // depth layer: back leg (faded)
    leg(p.legBack, 6, 0.78);
    // body: an angled capsule (rotated ellipse) — long axis rises from the rump to the shoulders.
    // thin outline so it reads as a filled mass behind the limbs, not a dominating ring
    ctx.save(); ctx.rotate(-facing * 0.5);
    D.ellipse(ctx, 0, 4, 18, 9, { width: 3.5, color: col, rnd, fill: D.COL.paper, wob: 1.2 });
    ctx.restore();
    // back arm tucked behind the body (faint)
    arm(44, -22, 5, 0.55);
    // shaggy fur ridge along the raised back
    for (let i = 0; i < 3; i++) { const bx = -facing * (2 + i * 6), by = 0 + i * 5; D.line(ctx, bx, by, bx - facing * 4, by - 11, { width: 3, color: col, rnd, passes: 1 }); }
    // head — up and forward at the front-top of the body
    wolfHead(ctx, facing * 15, -16, facing, col, rnd, opts.expr, opts.blink);
    // front leg + front arm (full weight, on top)
    leg(p.legFront, 7, 1);
    arm(54, -28, 6.5, 1);
    ctx.restore();
  }

  DS.character = { GEO, BOX, drawFighter, solveLimb, weapon, drawWolf };
})(window);
