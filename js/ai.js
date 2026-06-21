// js/ai.js — DS.AI: the client glue that turns a drawing into a live, enhanced prop.
//
// PROGRESSIVE ENHANCEMENT (the whole trick):
//   1. spawnFromStrokes(strokes,label,x,y) drops a PLACEHOLDER prop instantly — playable NOW.
//   2. if DS.AI.endpoint is set, it rasterizes the sketch, POSTs /enhance to CAELLUM, and swaps
//      the returned sprite onto the SAME prop when it arrives (~2-3s) — gameplay never stalls.
//
// Point it at your running serve.py with:  DS.AI.connect('http://<inf2-host>:8400/enhance')
// Until then the placeholder is what plays — the whole loop works with zero AI.
(function (global) {
  'use strict';
  const DS = global.DS;

  const AI = {
    endpoint: null,   // CAELLUM /enhance URL; null = placeholder only
    chloeEndpoint: null, // CHLOE /mechanic URL; null = default (instant) mechanic only
    SIZE: 512,        // rasterized sketch size sent to /enhance (matches the compiled shape)

    // set the CAELLUM endpoint and ping its health
    connect: function (url) {
      this.endpoint = url;
      const base = url.replace(/\/enhance\/?$/, '');
      fetch(base + '/healthz').then(function (r) { return r.json(); })
        .then(function (h) { console.log('[DS.AI] CAELLUM connected:', h); })
        .catch(function (e) { if (global.__showErr) global.__showErr('CAELLUM /healthz failed: ' + (e && e.message || e)); });
      return url;
    },

    // set the CHLOE /mechanic endpoint and ping its health (mirrors connect()/endpoint above)
    connectChloe: function (url) {
      this.chloeEndpoint = url;
      const base = url.replace(/\/mechanic\/?$/, '');
      fetch(base + '/healthz').then(function (r) { return r.json(); })
        .then(function (h) { console.log('[DS.AI] CHLOE connected:', h); })
        .catch(function (e) { if (global.__showErr) global.__showErr('CHLOE /healthz failed: ' + (e && e.message || e)); });
      return url;
    },

    // drop a prop from vector strokes (local coords ~ -40..40). Returns the Prop.
    spawnFromStrokes: function (strokes, label, x, y, opts) {
      const game = DS.game; if (!game || !game.props) return null;
      opts = opts || {};
      const bb = bbox(strokes);
      const prop = new DS.Prop(Object.assign({
        label: label, strokes: strokes, x: x, y: y,
        w: clamp(bb.w * (opts.scale || 1.0), 44, 160),
        h: clamp(bb.h * (opts.scale || 1.0), 30, 120),
      }, opts));
      game.props.push(prop);
      if (this.endpoint) this._enhanceInto(prop, stripDataUrl(this._rasterizeUrl(strokes)), label);
      if (this.chloeEndpoint) this._mechanicInto(prop, label, opts.description);
      return prop;
    },

    // drop a prop from an already-rasterized rough sketch (data URL); the rough image is the
    // placeholder until the enhanced one returns.
    spawnFromImage: function (dataUrl, label, x, y, opts) {
      const game = DS.game; if (!game || !game.props) return null;
      opts = opts || {};
      const prop = new DS.Prop(Object.assign({ label: label, x: x, y: y }, opts));
      const rough = new Image();
      rough.onload = function () { if (!prop.enhanced) prop.sprite = rough; };
      rough.src = dataUrl;
      game.props.push(prop);
      if (this.endpoint) this._enhanceInto(prop, stripDataUrl(dataUrl), label);
      if (this.chloeEndpoint) this._mechanicInto(prop, label, opts.description);
      return prop;
    },

    // POST the rough sketch to CAELLUM and swap the enhanced sprite onto the prop.
    _enhanceInto: function (prop, image_b64, label) {
      fetch(this.endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image_b64: image_b64, label: label }),
      }).then(function (r) { return r.json(); })
        .then(function (out) {
          if (!out || !out.sprite_b64) throw new Error((out && out.error) || 'no sprite in response');
          const img = new Image();
          img.onload = function () { prop.sprite = img; prop.enhanced = true; };
          img.src = 'data:image/png;base64,' + out.sprite_b64;
        })
        .catch(function (e) { if (global.__showErr) global.__showErr('CAELLUM enhance failed: ' + (e && e.message || e)); });
    },

    // POST the label to CHLOE and, on success, UPGRADE the prop's mechanic in place. Progressive
    // enhancement, same shape as the sprite swap: the default (instant) mechanic plays until CHLOE's
    // tuned spec arrives (~1-2s later) and replaces it. Never throws into the spawn path.
    _mechanicInto: function (prop, label, description) {
      const body = { label: label };
      if (description) body.description = description;
      fetch(this.chloeEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); })
        .then(function (spec) {
          if (!spec || !spec.node) throw new Error((spec && spec.error) || 'no node in response');
          const mech = specToMechanic(spec);
          if (mech) { prop.mechanic = mech; prop.archetype = mech.archetype; }
        })
        .catch(function (e) { if (global.__showErr) global.__showErr('CHLOE mechanic failed: ' + (e && e.message || e)); });
    },

    // strokes -> data-URL PNG (white bg, SIZE x SIZE): the rough sketch CAELLUM enhances.
    _rasterizeUrl: function (strokes) {
      const S = this.SIZE, cv = document.createElement('canvas'); cv.width = S; cv.height = S;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, S, S);
      const bb = bbox(strokes), pad = 64;
      const sc = Math.min((S - pad * 2) / bb.w, (S - pad * 2) / bb.h);
      ctx.translate(S / 2, S / 2); ctx.scale(sc, sc); ctx.translate(-(bb.x + bb.w / 2), -(bb.y + bb.h / 2));
      ctx.strokeStyle = '#111'; ctx.lineWidth = 6 / sc; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const s of strokes) {
        const p = s.pts; if (!p || !p.length) continue;
        ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
        for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
        ctx.stroke();
      }
      return cv.toDataURL('image/png');
    },

    // --- dev/testing: spawn a prop with a generated placeholder shape, no iPad needed ---
    devSpawnProp: function (label, x, y) {
      const game = DS.game;
      if (!game || !game.props) { if (global.__showErr) global.__showErr('devSpawnProp: start a match first'); return null; }
      const v = game.view || { w: 1920, h: 1080 };
      label = label || 'gun';
      return this.spawnFromStrokes(placeholder(label), label, x != null ? x : v.w * 0.5, y != null ? y : 150);
    },
  };

  // --- helpers ---
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // CHLOE spec {node, params, name, flavor} -> a DS.Prop.fire() mechanic cfg (same shape as
  // DS.Mechanics.DEFAULTS). The spec is already CLAMPED server-side by config.clamp_spec(); this
  // is a pure rename of node->kind, no new gameplay numbers. Returns null for nodes that aren't a
  // held-item mechanic (hazard/bouncy are Track-B environment placement, not a fired prop) so the
  // default mechanic is left untouched. Mirrors the DS.Mechanics archetype->kind knowledge.
  function specToMechanic(spec) {
    const node = spec.node, p = spec.params || {};
    // projectile_weapon/throwable params ARE the engine projectile cfg -> fire() spawns it directly.
    if (node === 'projectile_weapon' || node === 'throwable') {
      return Object.assign({ kind: 'ranged', archetype: node === 'throwable' ? 'throwable' : 'ranged_weapon' }, p);
    }
    // melee: the spec carries {reach,...} but the engine slash needs {r,speed,life}. Map reach->r and
    // keep the demo-tuned speed/life so the short fast strike still reads (DS.Mechanics.DEFAULTS).
    if (node === 'melee_weapon') {
      const base = (DS.Mechanics && DS.Mechanics.DEFAULTS && DS.Mechanics.DEFAULTS.melee_weapon) || {};
      return Object.assign({}, base, p, {
        kind: 'ranged', archetype: 'melee_weapon',
        r: p.reach != null ? p.reach : base.r,
        speed: base.speed, life: base.life, gravity: base.gravity || 0,
      });
    }
    if (node === 'heal') return { kind: 'heal', archetype: 'heal', amount: p.amount, cooldown: 0 };
    if (node === 'buff') return { kind: 'buff', archetype: 'buff', effect: p.effect, dur: p.dur, cooldown: 0 };
    // hazard/bouncy/anything else: not a held-and-fired mechanic — keep the default.
    return null;
  }
  function stripDataUrl(u) { const i = u.indexOf(','); return i >= 0 ? u.slice(i + 1) : u; }
  function bbox(strokes) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const s of (strokes || [])) for (const p of s.pts) {
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
    if (x0 > x1) { x0 = -40; y0 = -30; x1 = 40; y1 = 30; }
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  // rough placeholder shapes for the common test labels (local coords, centred at 0).
  function placeholder(label) {
    const L = (label || '').toLowerCase();
    if (L === 'gun' || L === 'pistol') return [
      { pts: [[-34, -8], [22, -8], [22, 6], [-34, 6], [-34, -8]], w: 5 }, // body
      { pts: [[-28, 6], [-30, 22], [-18, 22], [-16, 6]], w: 5 },          // grip
      { pts: [[22, -4], [34, -4], [34, 2], [22, 2]], w: 4 },              // barrel
    ];
    if (L === 'sword' || L === 'knife') return [
      { pts: [[-30, 0], [28, 0]], w: 5 }, { pts: [[-30, -9], [-30, 9]], w: 5 }, { pts: [[-38, 0], [-30, 0]], w: 6 },
    ];
    if (L === 'bomb' || L === 'ball') return [
      { pts: circle(0, 4, 22), w: 6 }, { pts: [[6, -16], [12, -26], [20, -24]], w: 4 },
    ];
    return [{ pts: [[-30, -18], [30, -18], [30, 18], [-30, 18], [-30, -18]], w: 5 }]; // generic box
  }
  function circle(cx, cy, r) {
    const p = []; for (let i = 0; i <= 16; i++) { const a = i / 16 * Math.PI * 2; p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return p;
  }

  DS.AI = AI;
  global.DS.devSpawnProp = function (label, x, y) { return AI.devSpawnProp(label, x, y); };

  // dev keys (testing without the iPad path): 1=gun 2=sword 3=bomb, spawned mid-stage.
  global.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    const label = { Digit1: 'gun', Digit2: 'sword', Digit3: 'bomb' }[e.code];
    if (label && DS.game && DS.game.state === 'playing') AI.devSpawnProp(label);
  });
})(window);
