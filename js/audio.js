// Procedural sound design — a tiny Web Audio "studio" for Doodle Smash.
//
// Every sound is SYNTHESISED at runtime (no audio files), so it ships with the
// no-build, file://-friendly project, carries no licensing baggage, stays loudness-
// consistent, and — crucially — is triggered at the exact game moments (the same call
// sites as the visual juice in effects.js), so timing always matches the frame data.
//
// Sonic identity: hand-drawn charcoal-on-paper. Sounds are soft and "papery/inky" —
// filtered-noise swishes (pencil strokes), round triangle/sine blips, woody ticks, and
// muffled thumps — never harsh digital tones. A master limiter keeps a busy 6-player
// brawl from clipping; gentle stereo panning places sounds where the fighter is.
(function (global) {
  'use strict';
  const DS = global.DS || (global.DS = {});

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rnd = (a, b) => a + (b - a) * Math.random();
  const jit = (f, c) => f * (1 + (Math.random() * 2 - 1) * (c || 0.03)); // pitch jitter so repeats vary

  const Audio = {
    ctx: null,
    master: null, comp: null, verb: null, noiseBuf: null,
    muted: false,
    vol: 0.6,            // master trim (kept below 1 for limiter headroom)
    voices: 0,           // live source count (polyphony guard)
    MAXVOICES: 28,
    _last: {},           // per-cue last-trigger time (throttle)
    recent: [],          // {name,t} ring, for self-tests
    count: 0,

    // ---- lifecycle -------------------------------------------------------
    // browsers require a user gesture; we build the graph on the first one.
    _build() {
      if (this.ctx) return;
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;

      // master -> soft brickwall limiter -> out  (keeps stacked hits from clipping)
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : this.vol;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -6; comp.knee.value = 6; comp.ratio.value = 12;
      comp.attack.value = 0.003; comp.release.value = 0.14;
      // a touch of high cut keeps everything soft (charcoal, not glass)
      const air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = 13000; air.Q.value = 0.4;
      master.connect(comp); comp.connect(air); air.connect(ctx.destination);
      this.master = master; this.comp = comp;

      // small papery room — used sparingly via per-cue sends (KO, ults, big hits)
      const verb = ctx.createConvolver(); verb.buffer = this._impulse(ctx, 0.6, 2.8);
      const verbGain = ctx.createGain(); verbGain.gain.value = 0.9;
      verb.connect(verbGain); verbGain.connect(comp);
      this.verb = verb;

      // a long, gentle "aura" reverb — a wide cinematic tail for the big magical moments
      // (ult connects), kept off the fast combat sends so jabs never smear
      const aura = ctx.createConvolver(); aura.buffer = this._impulse(ctx, 2.0, 2.0);
      const auraGain = ctx.createGain(); auraGain.gain.value = 0.9;
      const auraLp = ctx.createBiquadFilter(); auraLp.type = 'lowpass'; auraLp.frequency.value = 5000; // soft, dreamy tail
      aura.connect(auraLp); auraLp.connect(auraGain); auraGain.connect(comp);
      this.aura = aura;

      this.noiseBuf = this._noise(ctx, 1.2);
    },
    unlock() {
      this._build();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    ready() { return this.ctx && this.ctx.state === 'running'; },

    setMuted(m) {
      this.muted = !!m;
      try { localStorage.setItem('doodle-smash:muted', this.muted ? '1' : '0'); } catch (e) {}
      if (this.master) this.master.gain.value = this.muted ? 0 : this.vol;
      this._paintMute();
    },
    // hand-drawn speaker icon on the mute button (charcoal, matches the in-game doodle icons)
    _paintMute() {
      const doc = global.document; if (!doc || !DS.draw) return;
      const b = doc.getElementById('btn-mute'); if (!b) return;
      let cv = b.querySelector('canvas');
      if (!cv) { cv = doc.createElement('canvas'); b.appendChild(cv); }
      const dpr = DS.DPR || (global.devicePixelRatio || 1), w = 24, h = 20;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      drawSpeaker(ctx, w, h, this.muted);
      b.classList.toggle('off', this.muted);
    },
    toggleMute() { this.setMuted(!this.muted); },
    setVolume(v) { this.vol = clamp(v, 0, 1); if (this.master && !this.muted) this.master.gain.value = this.vol; },

    // ---- buffers ---------------------------------------------------------
    _noise(ctx, secs) {
      const n = (ctx.sampleRate * secs) | 0, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      return b;
    },
    _impulse(ctx, secs, decay) {
      const n = (ctx.sampleRate * secs) | 0, b = ctx.createBuffer(2, n, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
      return b;
    },

    // ---- positional pan (camera-aware when the game is running) -----------
    _pan(x) {
      if (x == null) return 0;
      const g = DS.game;
      if (g && g.cam) {
        const half = (g.view ? g.view.w : 1920) / 2 / (g.cam.zoom || 1);
        return clamp((x - g.cam.cx) / half, -1, 1) * 0.55;
      }
      const w = (DS.VIEW && DS.VIEW.w) || 1920;
      return clamp((x / w) * 2 - 1, -1, 1) * 0.4;
    },

    // ---- routing + voice primitives --------------------------------------
    _route(node, pan, send, send2) {
      const ctx = this.ctx;
      let out = node;
      if (pan) { const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null; if (p) { p.pan.value = clamp(pan, -1, 1); node.connect(p); out = p; } }
      out.connect(this.master);
      if (send) { const sg = ctx.createGain(); sg.gain.value = send; out.connect(sg); sg.connect(this.verb); }
      if (send2 && this.aura) { const ag = ctx.createGain(); ag.gain.value = send2; out.connect(ag); ag.connect(this.aura); }
    },
    _track(src, stopAt) {
      this.voices++;
      src.onended = () => { this.voices--; };
      // safety: ensure the count recovers even if onended is skipped
      src.stop(stopAt);
    },
    // pitched voice with an AD envelope (+ optional glide / vibrato)
    _tone(o) {
      const ctx = this.ctx, t0 = o.t0 || ctx.currentTime, dur = o.dur, osc = ctx.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f, t0);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), t0 + dur);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(o.gain, t0 + (o.atk || 0.006));
      if (o.hold) g.gain.setValueAtTime(o.gain, t0 + (o.atk || 0.006) + o.hold);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); this._route(g, o.pan, o.send, o.send2);
      if (o.vib) { const lfo = ctx.createOscillator(); lfo.frequency.value = o.vibf || 6; const lg = ctx.createGain(); lg.gain.value = o.vib; lfo.connect(lg); lg.connect(osc.frequency); lfo.start(t0); lfo.stop(t0 + dur + 0.02); }
      osc.start(t0); this._track(osc, t0 + dur + 0.03);
    },
    // filtered-noise burst (swishes, thumps, paper)
    _noiseHit(o) {
      const ctx = this.ctx, t0 = o.t0 || ctx.currentTime, dur = o.dur, src = ctx.createBufferSource();
      src.buffer = this.noiseBuf; src.playbackRate.value = o.rate || 1;
      const filt = ctx.createBiquadFilter(); filt.type = o.filter || 'bandpass';
      filt.frequency.setValueAtTime(o.f, t0);
      if (o.f2) filt.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + dur);
      filt.Q.value = o.Q || 1;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(o.gain, t0 + (o.atk || 0.004));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(filt); filt.connect(g); this._route(g, o.pan, o.send, o.send2);
      src.start(t0); this._track(src, t0 + dur + 0.03);
    },

    // ---- the cue catalog -------------------------------------------------
    play(name, o) {
      o = o || {};
      if (this.muted || !this.ready()) return;          // silent until unlocked
      const fn = CUES[name]; if (!fn) return;
      const now = this.ctx.currentTime;
      const gap = THROTTLE[name] || 0.025;              // de-machine-gun identical cues
      if (this._last[name] && now - this._last[name] < gap) return;
      if (this.voices > this.MAXVOICES) return;         // polyphony guard
      this._last[name] = now;
      o.pan = (o.pan != null) ? o.pan : this._pan(o.x);
      this.count++; this.recent.push({ name, t: now }); if (this.recent.length > 60) this.recent.shift();
      try { fn(this, o, now); } catch (e) {}
    },
  };

  // minimum seconds between identical cues (frequent ones throttle harder)
  const THROTTLE = {
    swing_jab: 0.05, hit_light: 0.03, hit_heavy: 0.04, hit_proj: 0.04, land: 0.06, dash: 0.08,
    jump: 0.05, draw: 0.03, count: 0.1, score: 0.12, gem_pickup: 0.05, block: 0.04,
  };

  // each cue: (A=Audio, o=opts {x,pan,power,dur,i,speed,dmg}, t=now)
  const CUES = {
    // ---------- UI / menu ----------
    ui_move(A, o, t) { A._tone({ t0: t, f: jit(540), type: 'triangle', dur: 0.07, gain: 0.12, pan: o.pan }); },
    ui_confirm(A, o, t) { A._tone({ t0: t, f: 480, type: 'triangle', dur: 0.09, gain: 0.16 }); A._tone({ t0: t + 0.06, f: 720, type: 'triangle', dur: 0.1, gain: 0.16 }); },
    ui_back(A, o, t) { A._tone({ t0: t, f: 560, type: 'triangle', dur: 0.09, gain: 0.14 }); A._tone({ t0: t + 0.055, f: 400, type: 'triangle', dur: 0.11, gain: 0.14 }); },
    ready(A, o, t) { [523, 659, 784].forEach((f, i) => A._tone({ t0: t + i * 0.05, f, type: 'triangle', dur: 0.18, gain: 0.15, send: 0.1 })); },
    join(A, o, t) { A._tone({ t0: t, f: 300, f2: 720, type: 'sine', dur: 0.14, gain: 0.2 }); A._noiseHit({ t0: t, f: 1800, dur: 0.06, gain: 0.05, Q: 0.7 }); },
    draw(A, o, t) { A._noiseHit({ t0: t, f: jit(2600, 0.18), f2: 1700, dur: 0.045, gain: 0.045, Q: 0.6, filter: 'bandpass', pan: o.pan }); },

    // ---------- countdown ----------
    count(A, o, t) { const up = (o.i || 0) * 90; A._noiseHit({ t0: t, f: 1100 + up, dur: 0.05, gain: 0.18, Q: 2.2 }); A._tone({ t0: t, f: 300 + up, type: 'triangle', dur: 0.12, gain: 0.22, send: 0.12 }); },
    go(A, o, t) {
      [392, 523, 659, 880].forEach((f, i) => A._tone({ t0: t + i * 0.02, f, type: 'triangle', dur: 0.5, gain: 0.16, send: 0.18 }));
      A._noiseHit({ t0: t, f: 600, f2: 3200, dur: 0.22, gain: 0.16, Q: 0.5, filter: 'bandpass', send: 0.15 });
      A._tone({ t0: t, f: 150, f2: 70, type: 'sine', dur: 0.3, gain: 0.3, send: 0.2 });
    },

    // ---------- movement ----------
    jump(A, o, t) { const up = o.i ? 90 : 0; A._tone({ t0: t, f: 300 + up, f2: 540 + up, type: 'sine', dur: 0.11, gain: 0.085, pan: o.pan }); A._noiseHit({ t0: t, f: 1400, f2: 2600, dur: 0.05, gain: 0.02, Q: 0.6, pan: o.pan }); },
    land(A, o, t) { const p = clamp(o.power || 0.5, 0.2, 1.4); A._noiseHit({ t0: t, f: 240, dur: 0.1 + p * 0.04, gain: 0.1 + p * 0.12, Q: 0.7, filter: 'lowpass', pan: o.pan }); A._tone({ t0: t, f: 120, f2: 80, type: 'sine', dur: 0.1, gain: 0.06 + p * 0.08, pan: o.pan }); },
    dash(A, o, t) { A._noiseHit({ t0: t, f: jit(1900, 0.06), f2: 700, dur: 0.15, gain: 0.08, Q: 0.8, filter: 'bandpass', pan: o.pan }); },
    ledge(A, o, t) { A._noiseHit({ t0: t, f: 900, dur: 0.07, gain: 0.1, Q: 1.4, filter: 'lowpass', pan: o.pan }); A._tone({ t0: t, f: 260, type: 'triangle', dur: 0.06, gain: 0.08, pan: o.pan }); },
    drop(A, o, t) { A._noiseHit({ t0: t, f: 700, f2: 360, dur: 0.08, gain: 0.08, Q: 0.7, filter: 'bandpass', pan: o.pan }); },
    shield(A, o, t) { A._tone({ t0: t, f: 520, type: 'sine', dur: 0.14, gain: 0.12, pan: o.pan }); A._noiseHit({ t0: t, f: 800, dur: 0.1, gain: 0.05, Q: 1.2, filter: 'lowpass', pan: o.pan }); },

    // ---------- melee swings ----------
    swing_jab(A, o, t) { A._noiseHit({ t0: t, f: jit(2600, 0.08), f2: 1400, dur: 0.06, gain: 0.13, Q: 0.9, filter: 'bandpass', pan: o.pan }); },
    swing_punch(A, o, t) { A._noiseHit({ t0: t, f: jit(1500, 0.06), f2: 650, dur: 0.14, gain: 0.2, Q: 0.8, filter: 'bandpass', pan: o.pan }); A._tone({ t0: t, f: 160, f2: 110, type: 'sine', dur: 0.12, gain: 0.08, pan: o.pan }); },
    swing_hammer(A, o, t) { A._noiseHit({ t0: t, f: 900, f2: 200, dur: 0.26, gain: 0.22, Q: 0.6, filter: 'lowpass', pan: o.pan }); A._tone({ t0: t, f: 320, f2: 90, type: 'sine', dur: 0.26, gain: 0.12, pan: o.pan }); },
    swing_claw(A, o, t) { [0, 0.03, 0.06].forEach((d, i) => A._noiseHit({ t0: t + d, f: jit(3000 - i * 300, 0.1), f2: 1600, dur: 0.05, gain: 0.1, Q: 1.6, filter: 'bandpass', pan: o.pan })); },
    swing_wolf(A, o, t) { A._noiseHit({ t0: t, f: 1200, f2: 400, dur: 0.2, gain: 0.2, Q: 0.7, filter: 'bandpass', pan: o.pan, send: 0.1 }); A._tone({ t0: t, f: 240, f2: 140, type: 'sawtooth', dur: 0.2, gain: 0.1, pan: o.pan }); },

    // ---------- ranged ----------
    charge_up(A, o, t) { const d = clamp(o.dur || 0.2, 0.08, 0.6); A._tone({ t0: t, f: 200, f2: 560, type: 'triangle', dur: d, gain: 0.16, atk: d * 0.6, pan: o.pan }); },
    shot(A, o, t) {
      const fast = (o.speed || 720) > 900;            // supershot vs the basic spark
      const base = fast ? 520 : 700, g = fast ? 0.24 : 0.17;
      A._tone({ t0: t, f: jit(base, 0.05), f2: fast ? 170 : 300, type: 'square', dur: fast ? 0.18 : 0.12, gain: g, pan: o.pan, send: fast ? 0.12 : 0 });
      A._noiseHit({ t0: t, f: 2000, f2: 900, dur: 0.07, gain: 0.06, Q: 0.6, pan: o.pan });
      if (fast) A._tone({ t0: t, f: 120, f2: 70, type: 'sine', dur: 0.16, gain: 0.14, pan: o.pan });
    },
    sniper_shot(A, o, t) { A._tone({ t0: t, f: 1500, f2: 480, type: 'square', dur: 0.1, gain: 0.22, pan: o.pan }); A._noiseHit({ t0: t, f: 3200, f2: 1400, dur: 0.06, gain: 0.12, Q: 0.5, filter: 'highpass', pan: o.pan, send: 0.1 }); A._tone({ t0: t, f: 140, f2: 80, type: 'sine', dur: 0.12, gain: 0.12, pan: o.pan }); },
    boomerang(A, o, t) { A._tone({ t0: t, f: 300, type: 'sawtooth', dur: 0.42, gain: 0.13, vib: 120, vibf: 22, pan: o.pan, send: 0.08 }); A._noiseHit({ t0: t, f: 1200, dur: 0.42, gain: 0.04, Q: 3, filter: 'bandpass', pan: o.pan }); },

    // ---------- impacts ----------
    // a light jab still reads soft, but gets a crisp little snap so it feels connected
    hit_light(A, o, t) {
      A._noiseHit({ t0: t, f: jit(560, 0.1), dur: 0.06, gain: 0.17, Q: 0.8, filter: 'lowpass', pan: o.pan });
      A._noiseHit({ t0: t, f: 3000, f2: 1500, dur: 0.022, gain: 0.07, Q: 0.5, filter: 'highpass', pan: o.pan }); // snap
      A._tone({ t0: t, f: jit(200), f2: 130, type: 'triangle', dur: 0.06, gain: 0.1, pan: o.pan });
    },
    // big melee / launch hits — a 4-layer punch: crack transient, sub-thump with a pitch drop,
    // a gritty mid body, and a short crunchy tail through the room. scales with knockback power.
    hit_heavy(A, o, t) {
      const p = clamp(o.power || 1, 0.6, 1.7);
      A._noiseHit({ t0: t, f: 3600, f2: 1100, dur: 0.03, gain: 0.16 * p, Q: 0.5, filter: 'highpass', pan: o.pan });   // crack
      A._tone({ t0: t, f: 165, f2: 46, type: 'sine', dur: 0.22, gain: 0.36 * p, pan: o.pan, send: 0.14 });            // sub-thump
      A._tone({ t0: t, f: 92, f2: 58, type: 'triangle', dur: 0.13, gain: 0.14 * p, pan: o.pan });                     // weight
      A._noiseHit({ t0: t + 0.004, f: 430, f2: 150, dur: 0.14, gain: 0.22 * p, Q: 0.7, filter: 'lowpass', pan: o.pan, send: 0.12 }); // body crunch
    },
    // ranged/projectile connect — a satisfying "thwap-splat": zappy transient, square+sub body,
    // and a quick upward sparkle tail so a landed shot really lands.
    hit_proj(A, o, t) {
      const p = clamp(o.power || 1, 0.6, 1.7);
      A._noiseHit({ t0: t, f: jit(2800, 0.06), f2: 700, dur: 0.045, gain: 0.2 * p, Q: 0.6, filter: 'bandpass', pan: o.pan }); // zap
      A._tone({ t0: t, f: 220, f2: 60, type: 'square', dur: 0.12, gain: 0.18 * p, pan: o.pan, send: 0.1 });                    // splat body
      A._tone({ t0: t, f: 130, f2: 50, type: 'sine', dur: 0.2, gain: 0.28 * p, pan: o.pan, send: 0.14 });                      // sub
      A._tone({ t0: t + 0.012, f: 760, f2: 1500, type: 'triangle', dur: 0.1, gain: 0.08 * p, pan: o.pan, send: 0.16 });        // sparkle tail
    },
    block(A, o, t) { A._noiseHit({ t0: t, f: 360, dur: 0.09, gain: 0.15, Q: 1, filter: 'lowpass', pan: o.pan }); A._tone({ t0: t, f: 200, type: 'sine', dur: 0.08, gain: 0.08, pan: o.pan }); },
    // the hammer ground-slam — the big, juicy one: deep boom with a pitch drop, a grindy
    // earth-crunch, a sharp snap on top, and a long room tail.
    spike(A, o, t) {
      A._tone({ t0: t, f: 95, f2: 36, type: 'sine', dur: 0.34, gain: 0.4, pan: o.pan, send: 0.24 });                  // deep boom
      A._tone({ t0: t, f: 150, f2: 52, type: 'triangle', dur: 0.18, gain: 0.18, pan: o.pan, send: 0.14 });            // body
      A._noiseHit({ t0: t, f: 850, f2: 180, dur: 0.24, gain: 0.26, Q: 0.7, filter: 'bandpass', pan: o.pan, send: 0.2 }); // earth crunch
      A._noiseHit({ t0: t, f: 3200, f2: 900, dur: 0.04, gain: 0.13, Q: 0.5, filter: 'highpass', pan: o.pan });        // snap
    },
    fizzle(A, o, t) { A._noiseHit({ t0: t, f: 1400, f2: 500, dur: 0.06, gain: 0.07, Q: 0.7, pan: o.pan }); },

    // ---------- KO / ultimates ----------
    ko(A, o, t) {
      A._noiseHit({ t0: t, f: 1200, f2: 120, dur: 0.5, gain: 0.26, Q: 0.4, filter: 'bandpass', pan: o.pan, send: 0.32 });
      A._tone({ t0: t, f: 160, f2: 46, type: 'sine', dur: 0.45, gain: 0.3, pan: o.pan, send: 0.28 });
      [880, 1175, 1568].forEach((f, i) => A._tone({ t0: t + 0.04 + i * 0.04, f, type: 'triangle', dur: 0.3, gain: 0.08, send: 0.25, pan: o.pan }));
    },
    charge_ready(A, o, t) { [523, 659, 784, 1046].forEach((f, i) => A._tone({ t0: t + i * 0.06, f, type: 'sine', dur: 0.24, gain: 0.13, send: 0.2, pan: o.pan })); },
    ult_hammer(A, o, t) { A._tone({ t0: t, f: 110, type: 'sine', dur: 0.5, gain: 0.28, send: 0.22, pan: o.pan }); A._tone({ t0: t, f: 440, f2: 330, type: 'triangle', dur: 0.6, gain: 0.12, send: 0.25, pan: o.pan }); A._noiseHit({ t0: t, f: 500, dur: 0.2, gain: 0.12, Q: 0.6, filter: 'lowpass', pan: o.pan }); },
    ult_sniper(A, o, t) { A._tone({ t0: t, f: 300, f2: 1000, type: 'triangle', dur: 0.32, gain: 0.18, atk: 0.2, send: 0.18, pan: o.pan }); A._noiseHit({ t0: t + 0.3, f: 3000, dur: 0.05, gain: 0.1, Q: 0.6, filter: 'highpass', pan: o.pan }); },
    ult_wolf(A, o, t) { A._tone({ t0: t, f: 230, f2: 340, type: 'sawtooth', dur: 0.5, gain: 0.2, vib: 22, vibf: 7, send: 0.25, pan: o.pan }); A._tone({ t0: t + 0.18, f: 300, f2: 200, type: 'sawtooth', dur: 0.4, gain: 0.16, send: 0.2, pan: o.pan }); },
    // the marquee impact: an earth-deep boom that blooms into a wide, ringing magical aura.
    ult_hit(A, o, t) {
      const pan = o.pan || 0;
      A._noiseHit({ t0: t, f: 3000, f2: 900, dur: 0.05, gain: 0.12, Q: 0.5, filter: 'highpass', pan: pan });            // soft crack (doesn't dominate)
      A._noiseHit({ t0: t, f: 300, f2: 110, dur: 0.3, gain: 0.28, Q: 0.6, filter: 'lowpass', pan: pan, send: 0.24 });    // impact body
      // DEEP sub — two detuned sines + a long ring, dropping toward sub-bass
      A._tone({ t0: t, f: 58, f2: 24, type: 'sine', dur: 0.7, gain: 0.38, pan: pan, send: 0.26, send2: 0.2 });
      A._tone({ t0: t, f: 44, f2: 21, type: 'sine', dur: 0.85, gain: 0.24, pan: pan, send2: 0.24 });
      A._tone({ t0: t, f: 116, f2: 58, type: 'triangle', dur: 0.4, gain: 0.13, pan: pan, send: 0.2 });                   // low harmonic for presence
      // AURA bloom — a low chord that swells in just after the strike and rings out long on the
      // dedicated aura reverb; slight L/R spread makes it wide and enveloping
      [131, 196, 262, 392].forEach((f, i) => A._tone({ t0: t + 0.03, f, type: 'triangle', dur: 1.1 + i * 0.08, gain: 0.075, atk: 0.1, pan: clamp(pan + (i % 2 ? 0.18 : -0.18), -1, 1), send: 0.18, send2: 0.5 }));
      // high shimmer floating in the tail
      [988, 1318, 1976].forEach((f, i) => A._tone({ t0: t + 0.06 + i * 0.05, f, type: 'sine', dur: 0.7, gain: 0.045, send2: 0.5, pan: pan }));
    },

    // ---------- breakables / mode pickups ----------
    box_break(A, o, t) {
      A._noiseHit({ t0: t, f: 700, f2: 300, dur: 0.2, gain: 0.2, Q: 0.6, filter: 'bandpass', pan: o.pan, send: 0.12 });
      for (let i = 0; i < 4; i++) A._noiseHit({ t0: t + rnd(0, 0.12), f: rnd(900, 2200), dur: 0.05, gain: 0.06, Q: 2, filter: 'bandpass', pan: o.pan });
    },
    box_hit(A, o, t) { A._noiseHit({ t0: t, f: 1000, dur: 0.06, gain: 0.1, Q: 1.5, filter: 'bandpass', pan: o.pan }); },
    gem_pickup(A, o, t) { [784, 1046, 1318].forEach((f, i) => A._tone({ t0: t + i * 0.05, f, type: 'triangle', dur: 0.16, gain: 0.14, send: 0.14, pan: o.pan })); },
    gem_spawn(A, o, t) { A._tone({ t0: t, f: 1046, f2: 1318, type: 'sine', dur: 0.18, gain: 0.08, pan: o.pan, send: 0.1 }); },
    score(A, o, t) { A._tone({ t0: t, f: 880, type: 'triangle', dur: 0.12, gain: 0.14, pan: o.pan }); A._tone({ t0: t + 0.06, f: 1318, type: 'triangle', dur: 0.14, gain: 0.13, send: 0.12, pan: o.pan }); },
    win(A, o, t) { [523, 659, 784, 1046, 1318].forEach((f, i) => A._tone({ t0: t + i * 0.1, f, type: 'triangle', dur: 0.34, gain: 0.16, send: 0.22 })); A._tone({ t0: t, f: 130, type: 'sine', dur: 0.6, gain: 0.14, send: 0.2 }); },
  };

  // hand-drawn speaker glyph (charcoal rough-stroke) for the mute button — no emoji
  function drawSpeaker(ctx, w, h, muted) {
    const D = DS.draw, rnd = DS.makeRng(muted ? 12 : 6), ink = D.COL.ink;
    ctx.save();
    ctx.translate(w / 2 - 3, h / 2);
    // speaker magnet + cone, one stroked outline filled with paper so it reads as a solid shape
    D.strokePts(ctx, [[-9, -3], [-4.5, -3], [0.5, -7.5], [0.5, 7.5], [-4.5, 3], [-9, 3]],
      { width: 2.1, color: ink, rnd, closed: true, fill: D.COL.paper });
    if (muted) {
      // a little hand-scratched 'x' where the sound waves would be
      D.line(ctx, 4.5, -5, 10.5, 4.5, { width: 2.1, color: ink, rnd, passes: 1 });
      D.line(ctx, 10.5, -5, 4.5, 4.5, { width: 2.1, color: ink, rnd, passes: 1 });
    } else {
      // two sound-wave arcs radiating out of the cone
      D.curve(ctx, [[3.5, -3.5], [6.5, 0], [3.5, 3.5]], { width: 1.9, color: ink, rnd });
      D.curve(ctx, [[5.5, -7], [10.5, 0], [5.5, 7]], { width: 1.9, color: ink, rnd });
    }
    ctx.restore();
  }

  // ---- gesture unlock + mute control (self-wiring, no main.js changes) ----
  if (global.document) {
    try { Audio.muted = localStorage.getItem('doodle-smash:muted') === '1'; } catch (e) {}
    const kick = () => { Audio.unlock(); };
    ['pointerdown', 'keydown', 'touchstart', 'mousedown'].forEach((ev) => global.addEventListener(ev, kick, { once: false, passive: true }));
    global.addEventListener('keydown', (e) => { if (e.code === 'KeyM' && !e.metaKey && !e.ctrlKey) Audio.toggleMute(); });
    const wire = () => {
      const b = document.getElementById('btn-mute');
      if (b) { Audio._paintMute(); b.onclick = () => { Audio.unlock(); Audio.toggleMute(); }; }
    };
    if (document.readyState !== 'loading') wire(); else global.addEventListener('DOMContentLoaded', wire);
  }

  DS.Audio = Audio;
})(window);
