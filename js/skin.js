// User-drawn character "skins". A skin is 6 hand-drawn parts: head, body, and four
// limbs (front/back arm, front/back leg). Each part rotates around the same joints the
// stick-figure rig uses, so every existing move animates a drawn character for free.
//
// Coordinate space == the parametric fighter's local space (origin = fighter center,
// matches character.js GEO). Part strokes are stored RELATIVE TO THE PART'S PIVOT.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;
  const RAD = Math.PI / 180;

  const PARTS = ['head', 'body', 'armBack', 'legBack', 'body2', 'armFront', 'legFront']; // draw order helper (body2 unused)
  const PART_LIST = ['head', 'body', 'armFront', 'armBack', 'legFront', 'legBack'];

  // joints (local space): arms swing at the shoulder, legs at the hip.
  const PIVOTS = {
    head: { x: 0, y: -30 }, body: { x: 0, y: 0 },
    armFront: { x: 0, y: -8 }, armBack: { x: 0, y: -8 },
    legFront: { x: 0, y: 12 }, legBack: { x: 0, y: 12 },
  };
  // the angle each limb is drawn at on the mannequin (its rest). Front limbs fan
  // forward (+), back limbs fan backward (-) so all four occupy distinct regions.
  const REST = { armFront: 35, armBack: -30, legFront: 14, legBack: -12 };

  // bones used to auto-assign a stroke to a part (signed local coords).
  const BONES = {
    head: [[0, -30], [0, -30]],
    body: [[0, -13], [0, 12]],
    armFront: [[0, -8], [17, 16]],
    armBack: [[0, -8], [-15, 18]],
    legFront: [[0, 12], [8, 43]],
    legBack: [[0, 12], [-7, 43]],
  };

  function emptySkin() {
    const parts = {};
    PART_LIST.forEach((k) => { parts[k] = { strokes: [] }; });
    return { enabled: true, parts };
  }
  function hasSkin(ch) {
    if (!ch.skin || !ch.skin.enabled) return false;
    const p = ch.skin.parts;
    return p && PART_LIST.some((k) => p[k] && p[k].strokes && p[k].strokes.length);
  }

  function distToBone(px, py, b) {
    const ax = b[0][0], ay = b[0][1], bx = b[1][0], by = b[1][1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }
  // pick the part for a stroke based on its centroid (signed, so front vs back differ)
  function assign(ptsLocal) {
    let cx = 0, cy = 0;
    for (const p of ptsLocal) { cx += p[0]; cy += p[1]; }
    cx /= ptsLocal.length; cy /= ptsLocal.length;
    let best = 'body', bd = 1e9;
    for (const k in BONES) { const d = distToBone(cx, cy, BONES[k]); if (d < bd) { bd = d; best = k; } }
    return best;
  }

  function drawStrokes(ctx, strokes, rnd, col) {
    col = col || D.COL.ink;
    for (const s of strokes) {
      if (s.pts && s.pts.length === 1) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(s.pts[0][0], s.pts[0][1], (s.w || 5) / 2, 0, 7); ctx.fill(); continue; }
      if (!s.pts || s.pts.length < 2) continue;
      D.strokePts(ctx, s.pts, { width: s.w || 5, color: col, rnd, jitter: 0.35, passes: 1 });
    }
  }
  function part(ctx, ch, name, rnd, col) {
    const pt = ch.skin.parts[name];
    if (pt && pt.strokes.length) drawStrokes(ctx, pt.strokes, rnd, col);
  }
  function limb(ctx, ch, name, poseAngle, rnd, col) {
    const pt = ch.skin.parts[name];
    if (!pt || !pt.strokes.length) return;
    ctx.save();
    ctx.translate(PIVOTS[name].x, PIVOTS[name].y);
    ctx.rotate(-(poseAngle - REST[name]) * RAD);
    drawStrokes(ctx, pt.strokes, rnd, col);
    ctx.restore();
  }

  // Render skinned fighter in LOCAL space (caller already translated to world pos).
  function render(ctx, ch, p, opts) {
    opts = opts || {};
    const facing = opts.facing || 1;
    const scale = (ch.stats && ch.stats.scale) || 1;
    const rnd = DS.makeRng(opts.seed || 7);
    const col = opts.color || D.COL.ink;        // ult-charge tints the whole drawn fighter blue
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(0, -4);                       // GEO_BIAS
    ctx.rotate(p.lean * facing * RAD * 0.5);
    ctx.scale(facing, 1);                       // face direction
    ctx.scale(1, p.squash || 1);

    ctx.globalAlpha = 0.82;                      // back limbs sit behind, faded
    limb(ctx, ch, 'armBack', p.armBack.sh, rnd, col);
    limb(ctx, ch, 'legBack', p.legBack.hip, rnd, col);
    ctx.globalAlpha = 1;

    ctx.save(); ctx.translate(PIVOTS.body.x, PIVOTS.body.y); part(ctx, ch, 'body', rnd, col); ctx.restore();
    ctx.save(); ctx.translate(PIVOTS.head.x + (p.headX || 0), PIVOTS.head.y + (p.headY || 0)); part(ctx, ch, 'head', rnd, col); ctx.restore();

    limb(ctx, ch, 'armFront', p.armFront.sh, rnd, col);
    limb(ctx, ch, 'legFront', p.legFront.hip, rnd, col);
    ctx.restore();
  }

  // Faint guide in local space (caller sets the transform). Shows where each part goes.
  function drawMannequin(ctx, activePart) {
    const seg = (px, py, qx, qy, w) => { ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(qx, qy); ctx.stroke(); };
    const end = (name) => { const a = REST[name] * RAD; const piv = PIVOTS[name]; const L = name.indexOf('leg') === 0 ? 32 : 30; return [piv.x + Math.sin(a) * L, piv.y + Math.cos(a) * L]; };
    const ghost = (name, fn) => {
      ctx.save();
      ctx.globalAlpha = (!activePart || activePart === 'auto') ? 0.26 : (activePart === name ? 0.5 : 0.1);
      ctx.strokeStyle = D.COL.inkSoft; ctx.fillStyle = D.COL.inkSoft; ctx.lineCap = 'round';
      fn(); ctx.restore();
    };
    ['legBack', 'legFront', 'armBack', 'armFront'].forEach((n) => { const e = end(n); ghost(n, () => seg(PIVOTS[n].x, PIVOTS[n].y, e[0], e[1], 4.5)); });
    ghost('body', () => seg(0, -13, 0, 12, 7));
    ghost('head', () => { ctx.beginPath(); ctx.arc(0, -30, 16, 0, 7); ctx.fill(); });
  }

  DS.skin = { PARTS: PART_LIST, PIVOTS, REST, BONES, emptySkin, hasSkin, assign, render, drawMannequin, drawStrokes };
})(window);
