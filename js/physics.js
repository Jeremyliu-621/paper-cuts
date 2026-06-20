// Platformer collision. Bodies are AABBs centered at (x,y) with size (w,h).
// Solid platforms block from all sides; passthrough platforms only catch a
// falling body on their top edge (and can be dropped through).
(function (global) {
  'use strict';

  function xOverlap(body, p, inset) {
    inset = inset || 0;
    return (body.x - body.w / 2 < p.x + p.w - inset) && (body.x + body.w / 2 > p.x + inset);
  }
  function yOverlap(body, p) {
    return (body.y - body.h / 2 < p.y + p.h) && (body.y + body.h / 2 > p.y);
  }
  function rectsOverlap(a, b) {
    return a.x - a.w / 2 < b.x + b.w / 2 && a.x + a.w / 2 > b.x - b.w / 2 &&
           a.y - a.h / 2 < b.y + b.h / 2 && a.y + a.h / 2 > b.y - b.h / 2;
  }

  // integrate velocity and resolve against platforms; returns {onGround, ground}
  // Rectangular platforms are AABBs. A 'drawn' platform is a hand-drawn stroke: a ONE-WAY shaped
  // surface (its p._segs line segments) you can land on from above anywhere along its length — so
  // a C-shape's top arc AND lower arc both catch you — and, once standing on it, your feet follow
  // its slope/curve (a step band keeps you stuck as you walk up and down the face).
  function step(body, platforms, dt, opts) {
    opts = opts || {};
    const dropThru = opts.dropThru || null; // platform object to ignore for landing

    // --- horizontal --- (solid AABB platforms block; drawn surfaces never wall you off)
    body.x += body.vx * dt;
    for (const p of platforms) {
      if (p.pass || p.kind === 'drawn') continue; // floats/drawn never block horizontally
      // only block if we're actually beside it (feet below its top lip)
      if (body.y + body.h / 2 > p.y + 8 && body.y - body.h / 2 < p.y + p.h && xOverlap(body, p)) {
        const penR = (p.x + p.w) - (body.x - body.w / 2); // push right
        const penL = (body.x + body.w / 2) - p.x;         // push left
        if (penL < penR) { body.x = p.x - body.w / 2; } else { body.x = p.x + p.w + body.w / 2; }
        body.vx = 0;
      }
    }

    // --- vertical --- find the highest surface our feet land on (AABB tops + drawn-stroke faces)
    const prevBottom = body.y + body.h / 2;
    const prevTop = body.y - body.h / 2;
    body.y += body.vy * dt;
    let landY = Infinity, ground = null;

    for (const p of platforms) {
      if (p.kind === 'drawn') continue; // handled below
      if (!xOverlap(body, p, 4)) continue;
      // land on top when falling
      if (body.vy >= 0 && p !== dropThru) {
        const top = p.y, newBottom = body.y + body.h / 2;
        if (prevBottom <= top + 8 && newBottom >= top && top < landY) { landY = top; ground = p; }
      }
      // bonk head on solids when rising
      if (!p.pass && body.vy < 0) {
        const bottomEdge = p.y + p.h, newTop = body.y - body.h / 2;
        if (prevTop >= bottomEdge - 8 && newTop <= bottomEdge) { body.y = bottomEdge + body.h / 2; body.vy = 0; }
      }
    }

    // drawn strokes: collide against the actual curve. when already standing on a drawn surface a
    // generous band lets the feet track the slope up/down; airborne, it's a strict land-from-above.
    const onDrawn = body.ground && body.ground.kind === 'drawn';
    const up = onDrawn ? 36 : 10, down = onDrawn ? 36 : 6;
    const fx = body.x, newBottom = body.y + body.h / 2;
    // only stick to the surface when falling or standing — a jump (vy strongly negative) releases
    // you so you launch off cleanly, exactly like a normal platform
    if (body.vy >= -1) {
      for (const p of platforms) {
        if (p.kind !== 'drawn' || p === dropThru || !p._segs) continue;
        for (const s of p._segs) {
          const minx = s.ax < s.bx ? s.ax : s.bx, maxx = s.ax < s.bx ? s.bx : s.ax;
          if (fx < minx || fx > maxx) continue;
          const dxs = s.bx - s.ax;
          const segY = Math.abs(dxs) < 1e-6 ? Math.min(s.ay, s.by) : s.ay + (s.by - s.ay) * ((fx - s.ax) / dxs);
          if (prevBottom <= segY + up && newBottom >= segY - down && segY < landY) { landY = segY; ground = p; }
        }
      }
    }

    let onGround = false;
    if (ground) { body.y = landY - body.h / 2; body.vy = 0; onGround = true; }
    return { onGround, ground };
  }

  global.DS = global.DS || {};
  global.DS.physics = { step, rectsOverlap, xOverlap, yOverlap };
})(window);
