// Rough "soft marker" renderer for Canvas2D + an offscreen pose cache.
// Everything is stroke-based so the look is hand-drawn; shapes are jittered and
// drawn with smooth quadratic paths + a light second pass for a charcoal feel.
(function (global) {
  'use strict';
  const DS = global.DS;

  const COL = {
    ink: '#2f2a26',
    inkSoft: '#6b6259',
    paper: '#f6f1e7',
    paperShade: '#e9e0cf',
    accent: '#d4663f',
    power: '#2f6fe0',   // vibrant "charged" blue — ultimate ready / in use
    powerDeep: '#1c46a8',
    powerSoft: '#5b8fcf', // gentler, easier-on-the-eyes blue — the building-up "charge" tint
  };

  // blend two hex colours ('#rrggbb') by t in 0..1 → '#rrggbb'
  function mix(a, b, t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
    const r = Math.round(((ah >> 16) & 255) + (((bh >> 16) & 255) - ((ah >> 16) & 255)) * t);
    const g = Math.round(((ah >> 8) & 255) + (((bh >> 8) & 255) - ((ah >> 8) & 255)) * t);
    const bl = Math.round((ah & 255) + ((bh & 255) - (ah & 255)) * t);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  // material fills: a VERY light wash — at most ~30% of a clean hue mixed into the warm paper, so a
  // shape reads as "that material" while staying almost monochrome. The ink line still does the work.
  const wash = (hue, t) => mix(COL.paper, hue, t);
  COL.mGround = wash('#7cc242', 0.28);   // grass green
  COL.mWood = wash('#d99a3f', 0.24); // wood tan
  COL.mStone = wash('#8aa6bd', 0.26);    // blue-grey stone
  COL.mCrystal = wash('#4ec4bc', 0.24);  // aqua
  COL.mBox = wash('#dd9a36', 0.24);      // crate tan
  COL.mFloat = wash('#79bce4', 0.24);    // sky blue
  COL.leafFill = wash('#82c247', 0.3);   // foliage fill — soft green
  COL.leaf = mix('#4e8a32', COL.paper, 0.2); // foliage stroke — a clearer green (it's a thin line)
  COL.stoneSoft = wash('#8197a8', 0.22); // structures (pillars/arches/islands) — faint stone-grey

  // ---- level of detail -----------------------------------------------------
  // when the camera is zoomed way out (e.g. 4 players spread across the arena) the faint
  // second "sketch" pass on every stroke is sub-pixel and invisible — so we skip it to halve
  // stroke work. lod 1 = full detail (normal play); lod 0 = single-pass. Set per render layer.
  let _lod = 1;
  function setLod(v) { _lod = v; }

  // ---- core path helpers ---------------------------------------------------

  // draw a smooth path through pts using quadratic curves via midpoints
  function smoothPath(ctx, pts, closed) {
    if (pts.length < 2) return;
    ctx.beginPath();
    if (pts.length === 2) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      return;
    }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const n = pts.length - 1;
    if (closed) {
      const mx = (pts[n][0] + pts[0][0]) / 2;
      const my = (pts[n][1] + pts[0][1]) / 2;
      ctx.quadraticCurveTo(pts[n][0], pts[n][1], mx, my);
      ctx.quadraticCurveTo(pts[0][0], pts[0][1], (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
    } else {
      ctx.quadraticCurveTo(pts[n][0], pts[n][1], pts[n][0], pts[n][1]);
    }
  }

  function jittered(pts, rnd, amt, closed) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      // endpoints of an open path wobble less, so lines connect cleanly
      const edge = !closed && (i === 0 || i === pts.length - 1);
      const a = edge ? amt * 0.35 : amt;
      out.push([pts[i][0] + rnd.sym(a), pts[i][1] + rnd.sym(a)]);
    }
    return out;
  }

  // stroke a polyline of anchor points with the rough double-pass look
  function strokePts(ctx, pts, o) {
    o = o || {};
    const rnd = o.rnd || DS.makeRng(1);
    const width = o.width != null ? o.width : 5;
    const color = o.color || COL.ink;
    const jit = o.jitter != null ? o.jitter : 1.6;
    const closed = !!o.closed;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;

    if (o.fill) {
      ctx.fillStyle = o.fill;
      smoothPath(ctx, jittered(pts, rnd, jit * 0.6, closed), closed);
      ctx.closePath();
      ctx.fill();
    }

    // main pass
    ctx.lineWidth = width;
    ctx.globalAlpha = o.alpha != null ? o.alpha : 1;
    smoothPath(ctx, jittered(pts, rnd, jit, closed), closed);
    if (closed) ctx.closePath();
    ctx.stroke();

    // light sketch pass for a soft marker double-line (skip for thin/ui strokes, and when
    // zoomed far out where the second line is imperceptible)
    if (o.passes !== 1 && width >= 3 && _lod >= 1) {
      ctx.lineWidth = Math.max(1, width * 0.55);
      ctx.globalAlpha = (o.alpha != null ? o.alpha : 1) * 0.5;
      smoothPath(ctx, jittered(pts, rnd, jit * 1.5, closed), closed);
      if (closed) ctx.closePath();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---- shapes --------------------------------------------------------------

  function line(ctx, x1, y1, x2, y2, o) {
    o = o || {};
    const len = Math.hypot(x2 - x1, y2 - y1);
    const segs = Math.max(2, Math.round(len / 26));
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    }
    strokePts(ctx, pts, o);
  }

  function curve(ctx, pts, o) { strokePts(ctx, pts, o); }

  function ellipse(ctx, cx, cy, rx, ry, o) {
    o = o || {};
    const n = o.steps || Math.max(10, Math.round((rx + ry) / 6));
    const start = (o.rnd ? o.rnd() : 0) * Math.PI; // random phase so blobs vary
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = start + (i / n) * Math.PI * 2;
      const wob = o.wob != null ? o.wob : 1;
      pts.push([cx + Math.cos(a) * (rx + (o.rnd ? o.rnd.sym(wob) : 0)),
                cy + Math.sin(a) * (ry + (o.rnd ? o.rnd.sym(wob) : 0))]);
    }
    strokePts(ctx, pts, Object.assign({ closed: true }, o));
  }

  function circle(ctx, cx, cy, r, o) { ellipse(ctx, cx, cy, r, r, o); }

  // a rounded rectangle as anchor points (so it strokes hand-drawn)
  function roundedRectPts(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    const k = r * 0.55;
    return [
      [x + r, y], [x + w - r, y], [x + w - k, y + k], [x + w, y + r],
      [x + w, y + h - r], [x + w - k, y + h - k], [x + w - r, y + h],
      [x + r, y + h], [x + k, y + h - k], [x, y + h - r],
      [x, y + r], [x + k, y + k],
    ];
  }

  function roundedRect(ctx, x, y, w, h, r, o) {
    strokePts(ctx, roundedRectPts(x, y, w, h, r), Object.assign({ closed: true }, o));
  }

  // wavy horizontal line (platform underside / water hints)
  function wavy(ctx, x1, x2, y, o) {
    o = o || {};
    const amp = o.amp != null ? o.amp : 3;
    const wl = o.wavelen || 26;
    const n = Math.max(2, Math.round((x2 - x1) / (wl / 2)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([x1 + (x2 - x1) * t, y + Math.sin(t * Math.PI * 2 * ((x2 - x1) / wl)) * amp]);
    }
    strokePts(ctx, pts, o);
  }

  // ---- offscreen pose cache ------------------------------------------------
  // Renders a draw callback once into an offscreen canvas keyed by a string and
  // blits it thereafter — this keeps per-frame cost near zero even with many
  // fighters (important for the eventual CV/AR overlay).
  const _cache = new Map();
  const _order = [];
  const CACHE_MAX = 400;

  function getCached(key, w, h, renderFn) {
    let c = _cache.get(key);
    if (c) return c;
    const cv = document.createElement('canvas');
    const dpr = global.DS.DPR || 1;
    cv.width = Math.ceil(w * dpr);
    cv.height = Math.ceil(h * dpr);
    cv._w = w; cv._h = h;
    const cx = cv.getContext('2d');
    cx.scale(dpr, dpr);
    renderFn(cx, w, h);
    _cache.set(key, cv);
    _order.push(key);
    if (_order.length > CACHE_MAX) {
      const old = _order.shift();
      _cache.delete(old);
    }
    return cv;
  }

  function clearCache() { _cache.clear(); _order.length = 0; }

  // paper grain rendered once, blitted as the backdrop
  let _paper = null;
  function paperTexture(w, h) {
    if (_paper && _paper._w === w && _paper._h === h) return _paper;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h; cv._w = w; cv._h = h;
    const cx = cv.getContext('2d');
    cx.fillStyle = COL.paper;
    cx.fillRect(0, 0, w, h);
    const rnd = DS.makeRng(99);
    // faint specks
    for (let i = 0; i < (w * h) / 5500; i++) {
      cx.fillStyle = `rgba(47,42,38,${0.015 + rnd() * 0.03})`;
      const r = 0.5 + rnd() * 1.4;
      cx.beginPath();
      cx.arc(rnd() * w, rnd() * h, r, 0, 7);
      cx.fill();
    }
    // soft vignette
    const g = cx.createRadialGradient(w / 2, h * 0.42, h * 0.2, w / 2, h / 2, h * 0.85);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(47,42,38,0.06)');
    cx.fillStyle = g;
    cx.fillRect(0, 0, w, h);
    _paper = cv;
    return cv;
  }

  global.DS.draw = {
    COL, mix, line, curve, ellipse, circle, roundedRect, roundedRectPts, wavy,
    strokePts, smoothPath, getCached, clearCache, paperTexture, setLod,
  };
})(window);
