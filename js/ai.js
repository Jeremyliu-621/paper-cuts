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

  // @imgly ML background remover (same lib/version as the camera cutout in campad.js), loaded as an
  // ESM on demand. Gives a clean salient-object edge on generated sprites; flood-fill is the fallback.
  const IMGLY_URL = 'https://esm.sh/@imgly/background-removal@1.7.0';

  const AI = {
    endpoint: null,   // CAELLUM /enhance URL; null = placeholder only
    falEndpoint: null, // fal /fal-enhance URL; null = no fast pass (CAELLUM-only as before)
    chloeEndpoint: null, // CHLOE /mechanic URL; null = default (instant) mechanic only
    recognizerEndpoint: null, // RECOGNIZER /recognize URL; null = caller supplies the label (no auto-naming)
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

    // set the fal /fal-enhance endpoint (mirrors connect() but for the FAST first pass). The route is
    // /fal-enhance; its serve may not expose /healthz, so we ping defensively and never hard-depend on
    // it — set the endpoint + log regardless so a missing health route doesn't disable the fast pass.
    connectFal: function (url) {
      this.falEndpoint = url;
      console.log('[DS.AI] fal connected:', url);
      const base = url.replace(/\/fal-enhance\/?$/, '');
      fetch(base + '/healthz').then(function (r) { return r.json(); })
        .then(function (h) { console.log('[DS.AI] fal healthz:', h); })
        .catch(function () { /* fal route may lack /healthz — non-fatal, endpoint is already set */ });
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

    // set the RECOGNIZER /recognize endpoint and ping its health (mirrors connect/connectChloe)
    connectRecognizer: function (url) {
      this.recognizerEndpoint = url;
      const base = url.replace(/\/recognize\/?$/, '');
      fetch(base + '/healthz').then(function (r) { return r.json(); })
        .then(function (h) { console.log('[DS.AI] RECOGNIZER connected:', h); })
        .catch(function (e) { if (global.__showErr) global.__showErr('RECOGNIZER /healthz failed: ' + (e && e.message || e)); });
      return url;
    },

    // drop a prop from vector strokes (local coords ~ -40..40). Returns the Prop.
    spawnFromStrokes: function (strokes, label, x, y, opts) {
      const game = DS.game; if (!game || !game.props) return null;
      opts = opts || {};
      const bb = bbox(strokes);
      const prop = new DS.Prop(Object.assign({
        label: label || 'thing', strokes: strokes, x: x, y: y,
        w: clamp(bb.w * (opts.scale || 1.0), 44, 160),
        h: clamp(bb.h * (opts.scale || 1.0), 30, 120),
      }, opts));
      game.props.push(prop);
      // AUTO-LABEL: no label given + recognizer connected -> play instantly on a placeholder, let the
      // recognizer NAME the drawing, then run CAELLUM + CHLOE with the real name. The whole "draw
      // anything" loop with zero menu. Otherwise use the caller's label as before.
      if (!label && this.recognizerEndpoint) {
        const self = this;
        this.recognize(strokes).then(function (r) { self._applyRecognition(prop, r, strokes, opts); });
      } else {
        // use prop.label (always non-empty: defaults to 'thing') so a blank label never sends an
        // empty string to CHLOE/fal. opts.description (a typed phrase) drives CHLOE when present.
        if (this.falEndpoint || this.endpoint) {
          const b64 = stripDataUrl(this._rasterizeUrl(strokes));
          if (this.falEndpoint) this._falEnhanceInto(prop, b64, prop.label);   // fast first pass
          if (this.endpoint) this._enhanceInto(prop, b64, prop.label);          // polished pass (wins)
        }
        if (this.chloeEndpoint) this._mechanicInto(prop, prop.label, opts.description);
      }
      return prop;
    },

    // the canonical "a kid drew something" entry: spawn from strokes and let the recognizer name it
    // (CAELLUM + CHLOE follow). Just spawnFromStrokes with no label -> the auto-label path above.
    spawnDrawn: function (strokes, x, y, opts) {
      return this.spawnFromStrokes(strokes, null, x, y, opts);
    },

    // drop a prop from an already-rasterized rough sketch (data URL); the rough image is the
    // placeholder until the enhanced one returns.
    spawnFromImage: function (dataUrl, label, x, y, opts) {
      const game = DS.game; if (!game || !game.props) return null;
      opts = opts || {};
      const prop = new DS.Prop(Object.assign({ label: label || 'thing', x: x, y: y }, opts));
      const rough = new Image();
      rough.onload = function () { if (!prop.enhanced) prop.sprite = rough; };
      rough.src = dataUrl;
      game.props.push(prop);
      const b64 = stripDataUrl(dataUrl);
      if (this.falEndpoint) this._falEnhanceInto(prop, b64, prop.label);   // fast first pass
      if (this.endpoint) this._enhanceInto(prop, b64, prop.label);          // polished pass (wins)
      if (this.chloeEndpoint) this._mechanicInto(prop, prop.label, opts.description);
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

    // POST the rough sketch to fal (FAST first pass, same {image_b64,label}->{sprite_b64} contract as
    // /enhance) and swap the result onto the prop. PRECEDENCE: CAELLUM (/enhance) is the more polished
    // pass, so once it has applied (prop.enhanced === true) we must NOT clobber it — a slow fal reply
    // that lands after CAELLUM is dropped. fal only marks prop._falDone, never prop.enhanced, so the
    // later CAELLUM swap always wins regardless of arrival order. Never throws into the spawn path.
    _falEnhanceInto: function (prop, image_b64, label) {
      prop._enhancing = true;                                // kick off the "magic working" scratch FX
      fetch(this.falEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image_b64: image_b64, label: label }),
      }).then(function (r) { return r.json(); })
        .then(function (out) {
          if (!out || !out.sprite_b64) throw new Error((out && out.error) || 'no sprite in response');
          if (prop.enhanced) { prop._enhancing = false; return; }   // CAELLUM polish already applied -> keep it
          // the sprite is already a TRANSPARENT PNG (background removed server-side by BiRefNet), so
          // there's no client-side cutout work — just swap it straight in. No render-thread stall.
          const sprite = new Image();
          sprite.onload = function () {
            if (prop.enhanced) return;
            prop.sprite = sprite; prop._falDone = true;
            prop._enhancing = false; prop._revealT = 0;      // stop the FX, play the reveal pop
          };
          sprite.src = 'data:image/png;base64,' + out.sprite_b64;
        })
        .catch(function (e) {
          prop._enhancing = false;                           // stop the FX; the kid's drawing stays as-is
          if (global.__showErr) global.__showErr('fal enhance failed: ' + (e && e.message || e));
        });
    },

    // remove a generated sprite's background -> a transparent PNG URL (Promise). Uses the @imgly ML
    // remover (a real salient-object segmentation, same lib as the camera cutout) for a clean edge on
    // any background — checkerboard, gradient, scenery. Falls back to the corner flood-fill if the
    // model can't load. fal/CAELLUM return sprites on a background; this is what makes them blend.
    _cutoutBg: function (dataUrl) {
      // FAST path (a few ms): corner flood-fill. The @imgly ML remover (_cutoutBgML) gives a cleaner
      // edge but runs ONNX on the MAIN THREAD and froze the game for seconds — so it is opt-in ONLY,
      // never on the gameplay hot path. (A future move: do cutout server-side or in a Web Worker.)
      return this._cutoutBgFloodfill(dataUrl);
    },

    // OPT-IN ML cutout via @imgly (clean edge, any background) — but heavy + main-thread. Do NOT call
    // during a live match; it stalls the render loop. Kept for an offline/preview path.
    _cutoutBgML: function (dataUrl) {
      const self = this;
      return import(/* @vite-ignore */ IMGLY_URL)
        .then(function (mod) {
          const removeBackground = mod.removeBackground || (mod.default && mod.default.removeBackground) || mod.default;
          if (typeof removeBackground !== 'function') throw new Error('removeBackground export not found');
          return removeBackground(dataUrl, { output: { format: 'image/png' } });
        })
        .then(function (blob) { return URL.createObjectURL(blob); })
        .catch(function () { return self._cutoutBgFloodfill(dataUrl); });
    },

    // fallback cutout (only if @imgly fails to load): load the dataURL, flood-fill the connected
    // background from the corners/edges within a tolerance, then mop up near-white / light-grey.
    // Returns a Promise<dataURL>. Fragile on textured backgrounds — hence @imgly is preferred.
    _cutoutBgFloodfill: function (dataUrl) {
      return new Promise(function (resolve) {
        const img = new Image();
        img.onerror = function () { resolve(dataUrl); };
        img.onload = function () {
          const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
          const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
          const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
          let id; try { id = ctx.getImageData(0, 0, W, H); } catch (e) { resolve(dataUrl); return; }
          const d = id.data, N = W * H, seen = new Uint8Array(N), TH = 78, stack = [];
          const seeds = [0, W - 1, (H - 1) * W, N - 1, (W >> 1), (H - 1) * W + (W >> 1), (H >> 1) * W, (H >> 1) * W + W - 1];
          for (let s = 0; s < seeds.length; s++) {
            const seed = seeds[s]; if (seen[seed]) continue;
            const sr = d[seed * 4], sg = d[seed * 4 + 1], sb = d[seed * 4 + 2];
            stack.length = 0; stack.push(seed);
            while (stack.length) {
              const i = stack.pop(); if (seen[i]) continue; seen[i] = 1;
              if (Math.abs(d[i * 4] - sr) > TH || Math.abs(d[i * 4 + 1] - sg) > TH || Math.abs(d[i * 4 + 2] - sb) > TH) continue;
              d[i * 4 + 3] = 0;
              const x = i % W, y = (i / W) | 0;
              if (x > 0) stack.push(i - 1); if (x < W - 1) stack.push(i + 1);
              if (y > 0) stack.push(i - W); if (y < H - 1) stack.push(i + W);
            }
          }
          for (let i = 0; i < N; i++) {                          // mop up light-grey / near-white leftovers
            if (d[i * 4 + 3] === 0) continue;
            const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
            if ((r + g + b) / 3 > 175 && (Math.max(r, g, b) - Math.min(r, g, b)) < 28) d[i * 4 + 3] = 0;
          }
          ctx.putImageData(id, 0, 0);
          resolve(cv.toDataURL('image/png'));
        };
        img.src = dataUrl;
      });
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
          // accept BOTH the composable graph format ({name,tags,on:{...}}) and the legacy
          // single-node spec ({node,params}). Only a missing/empty/error payload is a failure.
          if (!spec || spec.error || (!spec.node && !spec.on)) throw new Error((spec && spec.error) || 'no mechanic in response');
          const mech = specToMechanic(spec);
          if (mech) {
            prop.mechanic = mech; prop.archetype = mech.archetype;
            // if CHLOE reclassified it as an environment element (hazard/spring), it's no longer a
            // held weapon — drop it where the holder stands so it acts on the arena instead.
            if (prop.isEnv && prop.isEnv() && prop.held) {
              const h = prop.held; if (h.heldProp === prop) h.heldProp = null; prop.held = null;
            }
          }
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

    // strokes -> what the AI thinks it is. Resolves to the recognizer response ({results,confident,top})
    // or null. The draw flow uses top.label instead of asking the kid to pick a category.
    recognize: function (strokes) {
      if (!this.recognizerEndpoint) return Promise.resolve(null);
      const pixels = this._rasterize28(strokes);
      return fetch(this.recognizerEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pixels: pixels }),
      }).then(function (r) { return r.json(); })
        .then(function (out) { return (out && out.results) ? out : null; })
        .catch(function (e) { if (global.__showErr) global.__showErr('recognize failed: ' + (e && e.message || e)); return null; });
    },

    // strokes -> a 28x28 grayscale (white ink on black = QuickDraw polarity) as 784 floats in [0,1].
    _rasterize28: function (strokes) {
      const N = 28, cv = document.createElement('canvas'); cv.width = N; cv.height = N;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, N, N);
      const bb = bbox(strokes), pad = 3;
      const sc = Math.min((N - pad * 2) / bb.w, (N - pad * 2) / bb.h);
      ctx.translate(N / 2, N / 2); ctx.scale(sc, sc); ctx.translate(-(bb.x + bb.w / 2), -(bb.y + bb.h / 2));
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / sc; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const s of strokes) {
        const p = s.pts; if (!p || !p.length) continue;
        ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
        for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
        ctx.stroke();
      }
      const data = ctx.getImageData(0, 0, N, N).data, px = new Array(N * N);
      for (let i = 0; i < N * N; i++) px[i] = data[i * 4] / 255;   // R channel; white ink -> 1
      return px;
    },

    // a recognition result -> relabel the prop, swap its instant mechanic to match the recognized
    // type, and fire CAELLUM (sprite) + CHLOE (mechanic graph) with the real name. Progressive: the
    // prop was already playing on a placeholder; this upgrades it in place when recognition returns.
    _applyRecognition: function (prop, r, strokes, opts) {
      const top = r && r.top;
      const label = (top && top.label) || 'thing';
      prop.label = label;
      prop.recognized = top || null;            // {category,label,archetype,element,confidence} for the HUD
      if (DS.Mechanics) { prop.mechanic = DS.Mechanics.defaultFor(label); prop.archetype = prop.mechanic.archetype; }
      const desc = (opts && opts.description) || label;
      if (this.falEndpoint || this.endpoint) {
        const b64 = stripDataUrl(this._rasterizeUrl(strokes));
        if (this.falEndpoint) this._falEnhanceInto(prop, b64, label);   // fast first pass
        if (this.endpoint) this._enhanceInto(prop, b64, label);          // polished pass (wins)
      }
      if (this.chloeEndpoint) this._mechanicInto(prop, label, desc);
    },

    // --- dev/testing: spawn a prop with a generated placeholder shape, no iPad needed ---
    devSpawnProp: function (label, x, y) {
      const game = DS.game;
      if (!game || !game.props) { if (global.__showErr) global.__showErr('devSpawnProp: start a match first'); return null; }
      const v = game.view || { w: 1920, h: 1080 };
      label = label || 'gun';
      return this.spawnFromStrokes(placeholder(label), label, x != null ? x : v.w * 0.5, y != null ? y : 150);
    },

    // dev/testing: spawn a prop driven by a hand-authored mechanic GRAPH (no CHLOE needed) so the
    // composable engine can be smoke-tested in the browser. key indexes EXAMPLE_GRAPHS.
    devSpawnGraph: function (key, x, y) {
      const game = DS.game;
      if (!game || !game.props) { if (global.__showErr) global.__showErr('devSpawnGraph: start a match first'); return null; }
      const v = game.view || { w: 1920, h: 1080 };
      const g = EXAMPLE_GRAPHS[key]; if (!g) return null;
      return this.spawnFromStrokes(placeholder(g.label), g.label, x != null ? x : v.w * 0.5, y != null ? y : 150, { mechanic: g.graph });
    },

    // dev/testing: launch a fire shot and a water shot at each other so the element reaction
    // (fizzle + steam) is visible SOLO — no second player needed.
    testElementClash: function () {
      const game = DS.game; if (!game || !game.projectiles) return;
      const v = game.view || { w: 1920, h: 1080 }, y = v.h * 0.42, cx = v.w / 2, sp = 520;
      const mk = (px, dir, tags, col) => ({ owner: { x: px, y: y, facing: dir, tagCol: col },
        cfg: { tags: tags, damage: 5, r: 16, life: 6, gravity: 0 }, x: px, y: y, vx: dir * sp, vy: 0, life: 6, r: 16, facing: dir, spin: 0 });
      game.projectiles.push(mk(cx - 420, 1, ['fire'], '#f93'));
      game.projectiles.push(mk(cx + 420, -1, ['water'], '#39f'));
    },
  };

  // hand-authored demo graphs for the dev keys — exercise hit/land composition + elements w/o CHLOE.
  const EXAMPLE_GRAPHS = {
    frost: { label: 'gun', graph: { kind: 'graph', archetype: 'graph', name: 'Frost Cannon', tags: ['ice'],
      on: { fire: [{ op: 'projectile', speed: 1100, damage: 7 }], hit: [{ op: 'status', kind: 'freeze', dur: 3 }, { op: 'aoe', radius: 70, damage: 6 }] } } },
    cluster: { label: 'bomb', graph: { kind: 'graph', archetype: 'graph', name: 'Cluster Bomb', tags: ['fire'],
      on: { fire: [{ op: 'projectile', speed: 760, gravity: 1500, angle: 22, damage: 6 }], land: [{ op: 'nova', count: 8, damage: 6 }, { op: 'aoe', radius: 90, damage: 12 }] } } },
  };

  // --- helpers ---
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // CHLOE spec {node, params, name, flavor} -> a DS.Prop.fire() mechanic cfg (same shape as
  // DS.Mechanics.DEFAULTS). The spec is already CLAMPED server-side by config.clamp_spec(); this
  // is a pure rename of node->kind, no new gameplay numbers. hazard/bouncy map to ENVIRONMENT
  // mechanics (Track B: DS.Prop.handleEnvironment acts on them — a drawn spike trap / launch pad),
  // everything else maps to a held-item mechanic. Mirrors the DS.Mechanics archetype->kind knowledge.
  function specToMechanic(spec) {
    // composable GRAPH spec (CHLOE's new format: {name,flavor,tags,on}) -> use it directly as the
    // mechanic; DS.Prop.fire runs it via DS.Graph. Falls through to the legacy node mapping below.
    if (spec && spec.on && DS.Graph && DS.Graph.isGraph(spec)) {
      return Object.assign({ kind: 'graph', archetype: 'graph' }, spec);
    }
    const node = spec.node, p = spec.params || {};
    // projectile_weapon/throwable params ARE the engine projectile cfg -> fire() spawns it directly.
    if (node === 'projectile_weapon' || node === 'throwable') {
      return Object.assign({ kind: 'ranged', archetype: node === 'throwable' ? 'throwable' : 'ranged_weapon' }, p);
    }
    // melee: map the spec's {reach,damage,...} onto the SWING mechanic (an arc hitbox in front of
    // the holder — DS.Prop.fire runs it through the fighter's melee action, not a projectile).
    if (node === 'melee_weapon') {
      const base = (DS.Mechanics && DS.Mechanics.DEFAULTS && DS.Mechanics.DEFAULTS.melee_weapon) || {};
      return Object.assign({}, base, {
        kind: 'melee', archetype: 'melee_weapon',
        reach: p.reach != null ? p.reach : base.reach,
        damage: p.damage != null ? p.damage : base.damage,
        r: p.r != null ? p.r : base.r,
      });
    }
    if (node === 'heal') return { kind: 'heal', archetype: 'heal', amount: p.amount, cooldown: 0 };
    if (node === 'buff') return { kind: 'buff', archetype: 'buff', effect: p.effect, dur: p.dur, cooldown: 0 };
    // Track B environment elements — the prop is placed into the arena, not held + fired.
    if (node === 'hazard') return { kind: 'hazard', archetype: 'hazard', damage: p.damage, radius: p.radius };
    if (node === 'bouncy') return { kind: 'bouncy', archetype: 'bouncy', bounce: p.bounce };
    return null; // unknown node: keep the prop's default mechanic
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
    if (L === 'spikes' || L === 'trap' || L === 'saw') return [ // Track B hazard: jagged row
      { pts: [[-34, 18], [-22, -14], [-10, 18], [2, -14], [14, 18], [26, -14], [34, 18]], w: 5 },
      { pts: [[-36, 18], [36, 18]], w: 5 },
    ];
    if (L === 'spring' || L === 'trampoline') return [ // Track B launch pad: coil + bars
      { pts: [[-26, -16], [26, -16]], w: 6 },
      { pts: [[-16, -16], [16, -6], [-16, 2], [16, 10], [-16, 18]], w: 5 },
      { pts: [[-26, 20], [26, 20]], w: 6 },
    ];
    return [{ pts: [[-30, -18], [30, -18], [30, 18], [-30, 18], [-30, -18]], w: 5 }]; // generic box
  }
  function circle(cx, cy, r) {
    const p = []; for (let i = 0; i <= 16; i++) { const a = i / 16 * Math.PI * 2; p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return p;
  }

  DS.AI = AI;
  global.DS.devSpawnProp = function (label, x, y) { return AI.devSpawnProp(label, x, y); };

  // dev keys (testing without the iPad path): held weapons 1=gun 2=sword 3=bomb, and Track B
  // environment elements 4=spikes (hazard) 5=spring (launch pad), spawned mid-stage. The env ones
  // work with zero AI connected — DS.Mechanics.defaultFor() already tags spikes->hazard, spring->bouncy.
  global.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    if (!(DS.game && DS.game.state === 'playing')) return;
    const label = { Digit1: 'gun', Digit2: 'sword', Digit3: 'bomb', Digit4: 'spikes', Digit5: 'spring' }[e.code];
    if (label) return void AI.devSpawnProp(label);
    const gk = { Digit6: 'frost', Digit7: 'cluster' }[e.code];   // graph items: 6=Frost Cannon 7=Cluster Bomb
    if (gk) return void AI.devSpawnGraph(gk);
    if (e.code === 'Digit8') AI.testElementClash();              // 8 = fire-vs-water reaction demo
  });
})(window);
