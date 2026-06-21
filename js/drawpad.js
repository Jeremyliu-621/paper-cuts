// js/drawpad.js — DS.DrawPad: a lightweight in-page drawing canvas to TEST the draw->play loop.
//
// Press 'D' to toggle a little draw panel. Sketch with mouse/touch, optionally type a label
// (BLANK = let the recognizer name it, or fall back to a placeholder), hit Spawn -> the strokes go
// straight through DS.AI (CAELLUM enhance + CHLOE mechanic) and drop into the live match. This is the
// stand-in for the real iPad-over-the-relay input; it exercises the exact same DS.AI entry points.
(function (global) {
  'use strict';
  const DS = global.DS;
  let panel, cv, ctx, labelInput, strokes = [], cur = null, open = false;

  function btn(txt, fn, bg) {
    const b = document.createElement('button');
    b.textContent = txt; b.onclick = fn;
    b.style.cssText = 'padding:6px 10px;border:2px solid #1a1a1a;border-radius:5px;font-weight:700;cursor:pointer;background:' + (bg || '#eee');
    return b;
  }
  function pos(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  function build() {
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#f7f3e9;border:3px solid #1a1a1a;' +
      'border-radius:10px;padding:10px;font-family:sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);display:none';
    const title = document.createElement('div');
    title.textContent = '✏️ Draw  (D to toggle)';
    title.style.cssText = 'font-weight:700;margin-bottom:6px;font-size:13px';
    panel.appendChild(title);

    cv = document.createElement('canvas'); cv.width = 300; cv.height = 300;
    cv.style.cssText = 'background:#fff;border:2px solid #1a1a1a;border-radius:6px;touch-action:none;cursor:crosshair;display:block';
    panel.appendChild(cv);

    const row = document.createElement('div'); row.style.cssText = 'margin-top:8px;display:flex;gap:6px;align-items:center';
    labelInput = document.createElement('input'); labelInput.placeholder = 'label (blank = AI names it)';
    labelInput.style.cssText = 'flex:1;min-width:0;padding:5px;border:2px solid #1a1a1a;border-radius:5px;font-size:12px';
    row.appendChild(labelInput);
    row.appendChild(btn('Clear', doClear, '#eee'));
    row.appendChild(btn('Spawn ▶', doSpawn, '#ffd34d'));
    panel.appendChild(row);

    document.body.appendChild(panel);
    ctx = cv.getContext('2d');
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    global.addEventListener('pointerup', up);
    redraw();
  }

  function down(e) { cur = { pts: [pos(e)], w: 5 }; strokes.push(cur); try { cv.setPointerCapture(e.pointerId); } catch (x) {} e.preventDefault(); }
  function move(e) { if (!cur) return; cur.pts.push(pos(e)); redraw(); }
  function up() { cur = null; }

  function redraw() {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of strokes) {
      const p = s.pts; if (!p.length) continue;
      ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
      ctx.stroke();
    }
  }
  function doClear() { strokes = []; cur = null; redraw(); }

  // normalize canvas-pixel strokes -> local coords (~-40..40, centred) the way DS.AI expects, so the
  // placeholder prop renders centred and sized right (CAELLUM/recognizer re-normalize from bbox anyway).
  function normalize(src) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const s of src) for (const p of s.pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, sc = 80 / Math.max(w, h);
    return src.map(function (s) { return { w: s.w || 5, pts: s.pts.map(function (p) { return [(p[0] - cx) * sc, (p[1] - cy) * sc]; }) }; });
  }

  function doSpawn() {
    if (!strokes.length) return;
    if (!DS.AI || !DS.game || DS.game.state !== 'playing') { if (global.__showErr) global.__showErr('DrawPad: start a match first'); return; }
    const v = DS.game.view || { w: 1920, h: 1080 };
    const norm = normalize(strokes);
    const label = (labelInput.value || '').trim();
    // blank label -> spawnDrawn (recognizer names it, else 'thing'); typed label -> use it directly.
    if (label) DS.AI.spawnFromStrokes(norm, label, v.w * 0.5, 150);
    else DS.AI.spawnDrawn(norm, v.w * 0.5, 150);
    doClear();
  }

  function toggle() { if (!panel) build(); open = !open; panel.style.display = open ? 'block' : 'none'; }

  DS.DrawPad = { toggle: toggle };
  global.addEventListener('keydown', function (e) {
    if (e.code === 'KeyD' && !e.repeat && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) toggle();
  });
})(window);
