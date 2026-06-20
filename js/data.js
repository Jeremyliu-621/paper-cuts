// Single source of truth: characters, stage, settings. Plain JSON, edited live by
// the Editor and read by Play. Persisted to localStorage with export/import.
// Stage geometry is intentionally plain data so a CV detector can later GENERATE it
// from real-world surfaces and feed the exact same game (see GOAL.md).
(function (global) {
  'use strict';
  const DS = global.DS;

  // logical render resolution (camera is fixed; whole stage visible).
  // Larger view = more world fits the same screen, so fighters (fixed pixel size)
  // render smaller and gain room to move — i.e. the camera reads as "zoomed out".
  const VIEW = { w: 1920, h: 1080 };

  // ---- pose model ----------------------------------------------------------
  // angles in DEGREES, 0 = straight down, +ve rotates toward the facing side.
  // a pose fully describes a character in one action (this is the editable "asset").
  const BASE_POSE = {
    lean: 0, headX: 0, headY: 0, squash: 1,
    armFront: { sh: 16, el: 10 }, armBack: { sh: -14, el: 10 },
    legFront: { hip: 9, knee: 3 }, legBack: { hip: -11, knee: 3 },
  };

  function pose(ov) {
    ov = ov || {};
    return {
      lean: ov.lean ?? BASE_POSE.lean,
      headX: ov.headX ?? BASE_POSE.headX,
      headY: ov.headY ?? BASE_POSE.headY,
      squash: ov.squash ?? BASE_POSE.squash,
      armFront: Object.assign({}, BASE_POSE.armFront, ov.armFront),
      armBack: Object.assign({}, BASE_POSE.armBack, ov.armBack),
      legFront: Object.assign({}, BASE_POSE.legFront, ov.legFront),
      legBack: Object.assign({}, BASE_POSE.legBack, ov.legBack),
    };
  }

  // default action set shared by characters (poses can be edited per character)
  function defaultActions() {
    return {
      idle:   { pose: pose({}) },
      walk:   { pose: pose({ lean: 6, armFront: { sh: 34, el: 18 }, armBack: { sh: -30, el: 18 },
                             legFront: { hip: 26, knee: 6 }, legBack: { hip: -24, knee: 28 } }) },
      dash:   { pose: pose({ lean: 24, headX: 4, squash: 1.03, armFront: { sh: -34, el: 26 }, armBack: { sh: 48, el: 30 },
                             legFront: { hip: 46, knee: 8 }, legBack: { hip: -40, knee: 40 } }) },
      crouch: { pose: pose({ squash: 0.72, headY: 8, legFront: { hip: 24, knee: 46 }, legBack: { hip: -24, knee: 46 },
                             armFront: { sh: 22, el: 24 }, armBack: { sh: -20, el: 24 } }) },
      jump:   { pose: pose({ squash: 1.12, headY: -2, armFront: { sh: 120, el: 10 }, armBack: { sh: -120, el: 10 },
                             legFront: { hip: 18, knee: 40 }, legBack: { hip: -16, knee: 40 } }) },
      fall:   { pose: pose({ squash: 1.04, armFront: { sh: 140, el: 24 }, armBack: { sh: -140, el: 24 },
                             legFront: { hip: 22, knee: 10 }, legBack: { hip: -22, knee: 10 } }) },
      // both arms reach up-and-toward the stage and hook over the ledge corner; body hangs
      // below with legs dangling (sh ~120 = up & forward, el bends the forearm onto the lip)
      ledge:  { pose: pose({ headY: 2, lean: 8, armFront: { sh: 122, el: 36 }, armBack: { sh: 116, el: 30 },
                             legFront: { hip: 6, knee: 22 }, legBack: { hip: -6, knee: 16 } }) },
      attack: {
        pose: pose({ lean: 10, armFront: { sh: 92, el: 2 }, armBack: { sh: -40, el: 30 },
                     legFront: { hip: 30, knee: 6 }, legBack: { hip: -22, knee: 24 } }),
        // frame data at 60fps; hit is relative to fighter center, +x = forward.
        // 0 startup = the jab connects the instant you press (no wind-up). low base
        // knockback so standing jabs combo; momentum (dash/run) adds the launch.
        startup: 0, active: 3, recovery: 4,
        hit: { x: 46, y: -4, r: 30, damage: 5, kbBase: 4, kbScale: 0.05, angle: 8 },
      },
      special: {
        // ranged: a thrown doodle spark. arm-forward pose reads as a throw/cast.
        pose: pose({ lean: 14, headX: 4, armFront: { sh: 98, el: -6 }, armBack: { sh: 64, el: -8 },
                     legFront: { hip: 38, knee: 8 }, legBack: { hip: -28, knee: 32 } }),
        startup: 0, active: 2, recovery: 6,
        projectile: { speed: 720, damage: 7, kbBase: 22, kbScale: 0.13, angle: 0, gravity: 0, life: 1.5, r: 16, cooldown: 1.25 },
      },
      shield: { pose: pose({ squash: 0.9, headY: 4, armFront: { sh: 60, el: 70 }, armBack: { sh: -60, el: 70 },
                             legFront: { hip: 16, knee: 18 }, legBack: { hip: -16, knee: 18 } }) },
      hurt:   { pose: pose({ lean: -18, headY: -4, armFront: { sh: 150, el: 30 }, armBack: { sh: -150, el: 40 },
                             legFront: { hip: 40, knee: 10 }, legBack: { hip: -50, knee: 20 } }) },
      // --- conditional / contextual attacks (chosen by state in Fighter.update) ---
      // air + attack → overhead HAMMER SLAM that spikes down (meteor). pose is the windup;
      // the arms + a drawn hammer swing down over the active frames (see Fighter.getPose/render).
      hammer: {
        pose: pose({ lean: 6, armFront: { sh: 168, el: 10 }, armBack: { sh: 172, el: 10 },
                     legFront: { hip: 16, knee: 30 }, legBack: { hip: -14, knee: 30 } }),
        startup: 0, active: 5, recovery: 9, meteor: true,
        // light & only a tad above a jab — damage scales with fall height in _updateAction;
        // the value here is its identity (a downward spike), not raw power
        hit: { x: 24, y: 34, r: 40, damage: 6, kbBase: 6, kbScale: 0.06, angle: -68 },
      },
      // air + attack while RISING (and just after an up-press) → an upward SPEAR: rockets you up
      // (further than a jump, set in Fighter._startAction via lunge) and pops foes overhead.
      spear: {
        pose: pose({ lean: 2, headY: -3, squash: 1.15,
                     armFront: { sh: 172, el: 4 }, armBack: { sh: 168, el: 6 },
                     legFront: { hip: -8, knee: 4 }, legBack: { hip: 8, knee: 4 } }),
        startup: 0, active: 5, recovery: 7, lunge: true,
        hit: { x: 6, y: -50, r: 36, damage: 8, kbBase: 10, kbScale: 0.09, angle: 80 },
      },
      // fast ground + attack → committed straight SUPER PUNCH
      superpunch: {
        pose: pose({ lean: 16, headX: 4, armFront: { sh: 96, el: -10 }, armBack: { sh: -54, el: 34 },
                     legFront: { hip: 40, knee: 6 }, legBack: { hip: -30, knee: 30 } }),
        // startup: the glove winds back & SNAPS forward through it; the hit lands at full extension
        startup: 13, active: 3, recovery: 22,
        hit: { x: 52, y: -4, r: 33, damage: 9, kbBase: 12, kbScale: 0.10, angle: 12 },
      },
      // fast + special at close range → the big launcher ULTRA PUNCH
      ultrapunch: {
        pose: pose({ lean: 20, headX: 5, armFront: { sh: 100, el: -14 }, armBack: { sh: -64, el: 40 },
                     legFront: { hip: 46, knee: 6 }, legBack: { hip: -34, knee: 34 } }),
        startup: 15, active: 3, recovery: 24,
        hit: { x: 54, y: -2, r: 36, damage: 13, kbBase: 30, kbScale: 0.17, angle: 16 },
      },
      // werewolf melee (only usable while transformed): F = alternating paw swipe, G = AOE slash
      clawswipe: {
        pose: pose({ lean: 18, headX: 5, armFront: { sh: 104, el: -16 }, armBack: { sh: -50, el: 30 },
                     legFront: { hip: 36, knee: 8 }, legBack: { hip: -28, knee: 30 } }),
        startup: 0, active: 3, recovery: 2, wolf: true,
        hit: { x: 48, y: -2, r: 36, damage: 7, kbBase: 5, kbScale: 0.06, angle: 10 },
      },
      wolfslash: {
        pose: pose({ lean: 10, armFront: { sh: 70, el: -30 }, armBack: { sh: -70, el: -30 },
                     legFront: { hip: 30, knee: 10 }, legBack: { hip: -30, knee: 10 } }),
        startup: 5, active: 5, recovery: 9, wolf: true, aoe: true,
        hit: { x: 14, y: -4, r: 98, damage: 14, kbBase: 22, kbScale: 0.12, angle: 32 },
      },
      // ===== ULTIMATES (charged; double-tap G when full) =====
      // Super Hammer: a BOOMERANG hammer — thrown forward to mid range, then spins back to you.
      ulthammer: {
        pose: pose({ lean: 16, headX: 5, armFront: { sh: 150, el: -20 }, armBack: { sh: 78, el: -10 },
                     legFront: { hip: 40, knee: 8 }, legBack: { hip: -30, knee: 30 } }),
        startup: 9, active: 2, recovery: 16, ult: true,
        boomerang: { range: 875, speed: 1500, damage: 24, kbBase: 36, kbScale: 0.15, angle: 40, r: 60 },
      },
      // fast + special at range → a bigger, faster SUPER SHOT
      supershot: {
        pose: pose({ lean: 16, headX: 5, armFront: { sh: 104, el: -8 }, armBack: { sh: 70, el: -10 },
                     legFront: { hip: 40, knee: 8 }, legBack: { hip: -30, knee: 34 } }),
        // the cannon swells/charges through the startup, then fires the shot at the active frame
        startup: 15, active: 2, recovery: 25,
        projectile: { speed: 1020, damage: 11, kbBase: 30, kbScale: 0.16, angle: 0, gravity: 0, life: 1.6, r: 22, cooldown: 1.25 },
      },
    };
  }

  function defaultStats() {
    return {
      walkSpeed: 215, runSpeed: 430, airSpeed: 320, dashSpeed: 780,
      accel: 2800, airAccel: 1500, friction: 2600,
      jumpVel: 830, hopVel: 540, doubleJumpVel: 770, maxJumps: 3,
      fallSpeed: 1450, fastFallSpeed: 2350, gravityScale: 1,
      weight: 1.0, scale: 1.0,
    };
  }

  function makeCharacter(name, head, accent) {
    return { name, head, accent, stats: defaultStats(), actions: defaultActions() };
  }

  // ---- default content -----------------------------------------------------
  function defaults() {
    return {
      version: 3,
      view: { w: VIEW.w, h: VIEW.h },
      settings: {
        gravity: 2300,
        timerSeconds: 99,
        stocks: 3,
        knockbackScale: 1.0,
        hitstop: 1.0,
        // generous KO bounds so fighters fly way out before dying (the dynamic camera
        // zooms out to follow them); ~1100px of margin around the 1920x1080 stage.
        blast: { left: -1100, right: VIEW.w + 1100, top: -900, bottom: VIEW.h + 950 },
      },
      stage: {
        platforms: [
          // [x, y(top), w, h, passthrough] — laid out in the 1920x1080 view
          { x: 225,  y: 863, w: 1470, h: 195, pass: false }, // main ground
          { x: 143,  y: 705, w: 353,  h: 39,  pass: true },  // left float
          { x: 768,  y: 468, w: 384,  h: 39,  pass: true },  // center-high float
          { x: 1425, y: 705, w: 353,  h: 39,  pass: true },  // right float
        ],
        spawns: [ { x: 660, y: 780 }, { x: 1260, y: 780 } ],
        // background structures (drawn behind, faded for depth) — rolling hills + a far ridge
        bg: [
          { type: 'hill', x: 520, y: 1060, w: 1200, h: 250, s: 1, a: 0.22 },
          { type: 'hill', x: 1500, y: 1060, w: 1300, h: 320, s: 1, a: 0.2 },
          { type: 'mountain', x: 980, y: 1060, w: 900, h: 520, s: 1, a: 0.15 },
        ],
        decor: [
          { type: 'cloud', x: 293, y: 180, s: 1.5 },
          { type: 'cloud', x: 1613, y: 218, s: 1.7 },
          { type: 'cloud', x: 950, y: 130, s: 1.3 },
          { type: 'tree', x: 320, y: 858, s: 1.5 },
          { type: 'tree', x: 1600, y: 858, s: 1.35 },
          { type: 'bush', x: 1515, y: 845, s: 1.5 },
          { type: 'mushroom', x: 770, y: 858, s: 1.2 },
          { type: 'flower', x: 430, y: 853, s: 1.4 },
          { type: 'flower', x: 1180, y: 851, s: 1.4 },
          { type: 'reeds', x: 590, y: 857, s: 1.3 },
          { type: 'grass', x: 705, y: 856, s: 1.4 },
          { type: 'grass', x: 1040, y: 857, s: 1.4 },
        ],
      },
      characters: {
        Sprout: makeCharacter('Sprout', 'spikes', '#5b8c5a'),
        Acorn: makeCharacter('Acorn', 'beanie', '#9c6b3f'),
      },
      roster: ['Sprout', 'Acorn'],
    };
  }

  // ---- store ---------------------------------------------------------------
  // v3 enriches the Meadow stage (background hills, trees, plants). Bumping the key
  // lets the new defaults load instead of an older save's plainer stage winning the merge.
  const KEY = 'doodle-smash:data:v3';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  const Store = {
    data: null,
    load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) { this.data = mergeDefaults(JSON.parse(raw)); return this.data; }
      } catch (e) { console.warn('load failed, using defaults', e); }
      this.data = defaults();
      return this.data;
    },
    save() {
      try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { console.warn(e); }
    },
    reset() { this.data = defaults(); this.save(); return this.data; },
    export() { return JSON.stringify(this.data, null, 2); },
    import(text) {
      const obj = JSON.parse(text);
      this.data = mergeDefaults(obj);
      this.save();
      return this.data;
    },
  };

  // shallow-merge unknown/missing fields against defaults so old saves still load
  function mergeDefaults(d) {
    const base = defaults();
    if (!d || typeof d !== 'object') return base;
    const out = Object.assign(base, d);
    out.settings = Object.assign(base.settings, d.settings || {});
    // blast bounds are derived from the view and not user-editable, so always take the
    // current defaults (lets existing saves pick up the bigger KO bounds)
    out.settings.blast = base.settings.blast;
    // refresh the combat tuning of attack/special to the current fluid (zero-startup,
    // low-knockback, instant-projectile) defaults, keeping each character's edited POSE
    // and their drawn skin. also upgrades any old melee 'special' to the ranged projectile.
    const fresh = base.characters.Sprout.actions;
    for (const k in out.characters) {
      const ch = out.characters[k];
      // triple jump is the new baseline — bump saves still on the old default (2) to 3,
      // leaving any intentionally non-default value (e.g. an editor tweak) untouched
      if (ch && ch.stats && ch.stats.maxJumps === 2) ch.stats.maxJumps = 3;
      const acts = ch && ch.actions;
      if (!acts) continue;
      // refresh each move's combat tuning to the current defaults, keeping any edited POSE;
      // also adds moves that didn't exist when the save was made (the conditional attacks).
      const refresh = (key) => {
        if (acts[key]) { const p = acts[key].pose; acts[key] = clone(fresh[key]); acts[key].pose = p; }
        else acts[key] = clone(fresh[key]);
      };
      ['attack', 'special', 'hammer', 'spear', 'superpunch', 'ultrapunch', 'supershot', 'ulthammer', 'clawswipe', 'wolfslash'].forEach(refresh);
      // the ledge pose is a system grip (added late) — refresh it so existing saves that
      // captured an arms-down placeholder pick up the proper "hang on by the arms" pose
      acts.ledge = clone(fresh.ledge);
    }
    return out;
  }

  DS.VIEW = VIEW;
  DS.Store = Store;
  DS.data = { defaults, pose, BASE_POSE, defaultActions, defaultStats, makeCharacter, clone };
})(window);
