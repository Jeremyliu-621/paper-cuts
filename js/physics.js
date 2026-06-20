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
  function step(body, platforms, dt, opts) {
    opts = opts || {};
    const dropThru = opts.dropThru || null; // platform object to ignore for landing

    // --- horizontal ---
    body.x += body.vx * dt;
    for (const p of platforms) {
      if (p.pass) continue; // floats never block horizontally
      // only block if we're actually beside it (feet below its top lip)
      if (body.y + body.h / 2 > p.y + 8 && body.y - body.h / 2 < p.y + p.h && xOverlap(body, p)) {
        const penR = (p.x + p.w) - (body.x - body.w / 2); // push right
        const penL = (body.x + body.w / 2) - p.x;         // push left
        if (penL < penR) { body.x = p.x - body.w / 2; } else { body.x = p.x + p.w + body.w / 2; }
        body.vx = 0;
      }
    }

    // --- vertical ---
    const prevBottom = body.y + body.h / 2;
    const prevTop = body.y - body.h / 2;
    body.y += body.vy * dt;
    let onGround = false, ground = null;

    for (const p of platforms) {
      if (!xOverlap(body, p, 4)) continue;
      // land on top when falling
      if (body.vy >= 0 && p !== dropThru) {
        const top = p.y;
        const newBottom = body.y + body.h / 2;
        if (prevBottom <= top + 8 && newBottom >= top) {
          body.y = top - body.h / 2; body.vy = 0; onGround = true; ground = p;
        }
      }
      // bonk head on solids when rising
      if (!p.pass && body.vy < 0) {
        const bottomEdge = p.y + p.h;
        const newTop = body.y - body.h / 2;
        if (prevTop >= bottomEdge - 8 && newTop <= bottomEdge) {
          body.y = bottomEdge + body.h / 2; body.vy = 0;
        }
      }
    }
    return { onGround, ground };
  }

  global.DS = global.DS || {};
  global.DS.physics = { step, rectsOverlap, xOverlap, yOverlap };
})(window);
