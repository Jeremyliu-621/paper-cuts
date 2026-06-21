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

  // Ddoski the Bear — the built-in fighter, a hand-traced 6-part skin (head/body/arms) drawn in
  // the editor, simplified (RDP) to ~145 points so it animates without lag. Drawn via DS.skin.
  const DDOSKI_SKIN = {"enabled":true,"offsetY":14,"parts":{"head":{"strokes":[{"pts":[[21.5,-17.6],[23.7,-19.7]],"w":2.4},{"pts":[[21.3,-16.6],[22.9,-18.1]],"w":2.4},{"pts":[[22.9,-18.1]],"w":2.4},{"pts":[[21.8,-30.3],[21.9,-30]],"w":2.4},{"pts":[[21.1,-30.2],[24.2,-24.9],[23.8,-20.5]],"w":2.4},{"pts":[[21.4,-30.6],[19.3,-32],[13.9,-32.5],[10,-30],[8.3,-27.3]],"w":2.4},{"pts":[[-12.4,-26.3],[-0.6,-28.8],[7.3,-27.8]],"w":2.4},{"pts":[[-1.3,-29.3],[-8.3,-28.2]],"w":2.4},{"pts":[[-22.4,-30.5],[-15.3,-29.7],[-12.2,-25.5]],"w":2.4},{"pts":[[-22.2,-30.3],[-26.4,-27.6],[-29,-23.6],[-30,-16.9]],"w":2.4},{"pts":[[-30,-16.9],[-28.7,-13.6],[-24.8,-10.8]],"w":2.4},{"pts":[[-21.9,-15.1],[-18.7,-20.2],[-15.3,-22]],"w":2.4},{"pts":[[-15.3,-22],[-18.2,-24.4],[-21.8,-23.8],[-24,-20.1],[-23.5,-17.2],[-22,-15.5]],"w":2.4},{"pts":[[9.2,-26.9],[17.3,-21.9],[21,-17.2]],"w":2.4},{"pts":[[12.8,-26.5],[16.3,-27.3],[19.2,-25.7],[18.7,-19.9]],"w":2.4},{"pts":[[-6,-17.9],[-8.2,-17.3],[-8.7,-14.5],[-6.7,-13.3],[-3.1,-14.2],[-3.3,-16.8],[-6.5,-17.6]],"w":2.4},{"pts":[[12.5,-19.1],[10.4,-18.2],[10.4,-16],[13.9,-15.1],[15.5,-16.4],[14.6,-18.6],[12.5,-19]],"w":2.4},{"pts":[[-6.8,-11.1],[-10,-9.6],[-12.1,-5.1],[-11.1,2.1],[-8,4.7],[-4.1,4.5],[-1.5,-1.9],[-3.9,-10.2],[-6.4,-10.9]],"w":2.4},{"pts":[[-5.8,-9.6],[-8,-6.7],[-7.9,-0.2],[-7,1.5],[-4.5,2.4],[-7.9,-5.2],[-7.7,-7.8],[-5.6,-9.4],[-6.6,-5.4],[-5.9,-4.1],[-3.2,-3.8],[-5.3,-0.1],[-5.7,-2.6],[-3.4,-0.6],[-4.2,0.5],[-2.8,-2.1]],"w":2.4},{"pts":[[16.5,-11.1],[14.9,-9.6],[14.9,-6.8],[16.6,-1.7],[16.1,-4.3],[14.2,-5.9],[14.3,-9.1],[16,-11.2]],"w":2.4},{"pts":[[13.8,-5.4],[15.5,-1.9],[18.3,-0.3]],"w":2.4},{"pts":[[11,-3.9],[10.6,-8.8],[11.8,-11.3],[16.3,-13],[18.3,-11.1]],"w":2.4},{"pts":[[20.1,-1.6],[16,-7.1],[18.5,-0.6],[20,-4.7],[20,-3.6],[17.8,-5.8],[20.5,-3.7]],"w":2.4},{"pts":[[19.6,-10.8]],"w":2.4},{"pts":[[19.3,-10.8],[19.8,-6]],"w":2.4},{"pts":[[21,-17.1],[24.9,-4.5],[25.2,3.3],[23.1,7.7],[19.5,11.6],[10.6,15.3]],"w":2.4},{"pts":[[-25.4,-11.8],[-25.8,1.2],[-22.9,9.1],[-17,13.1]],"w":2.4},{"pts":[[4.4,-2.9],[10.8,-2.6],[13.3,3.2],[12.7,5.8],[9.9,8.7],[4.8,9.8],[1.5,7.7],[0.1,3.6],[1.2,-0.3],[3.9,-2.9]],"w":2.4},{"pts":[[5.4,0.9],[10,0.3],[8.3,2.7],[5.7,1.5]],"w":2.4},{"pts":[[19.8,-0.4],[17.5,1.6],[13.5,1.9]],"w":2.4},{"pts":[[-1.2,17],[6.3,16.9],[10.5,15.3],[4,16.6]],"w":2.4},{"pts":[[-17.5,13.6],[-8.1,16.6],[-1.2,17]],"w":2.4}]},"body":{"strokes":[{"pts":[[-10.2,2.6],[-12,10.7]],"w":4.25},{"pts":[[9.3,-5],[13.8,9.5]],"w":4.25},{"pts":[[-11.5,10.6],[-1.1,13.4],[4.6,13.4],[14.6,10.2]],"w":4.25},{"pts":[[-10.7,3],[-8.8,-4.5],[-8.8,-10.5]],"w":4.25},{"pts":[[7.8,-10.4],[8.3,-5.5],[9.3,-4.9]],"w":4.25}]},"armFront":{"strokes":[{"pts":[[11.5,-5.7],[16.4,-1.3],[19.5,3.6]],"w":4.25},{"pts":[[20.4,4.5],[13.3,9.5]],"w":4.25},{"pts":[[19.6,5.3],[21.1,15.4],[19.3,17.4],[14.4,17.8],[11.5,15.2],[9.1,11]],"w":4.25},{"pts":[[9.2,10.7],[12.7,9.3]],"w":4.25},{"pts":[[8.8,3],[9.3,10.7]],"w":4.25}]},"armBack":{"strokes":[{"pts":[[-13.7,-4.4],[-17.9,0.2],[-20.6,5.1]],"w":4.25},{"pts":[[-20.6,5.1],[-10,10.6]],"w":4.25},{"pts":[[-7.3,5.2],[-9.5,10.7]],"w":4.25},{"pts":[[-10.3,11.3],[-12.8,19.5],[-18.8,20.1],[-21.7,13.3],[-19.9,5.8]],"w":4.25}]},"legFront":{"strokes":[{"pts":[[13.6,-0.7],[14.2,11.5]],"w":4.25},{"pts":[[14.2,11.5],[14.7,15.5],[13.7,17.6],[8.9,19.4],[4.1,18.8],[1,12.6],[1.2,5.4]],"w":4.25}]},"legBack":{"strokes":[{"pts":[[-12.4,0.5],[-13.7,17.2]],"w":4.25},{"pts":[[-13.4,16.6],[-6.8,19.7],[-0.4,18.4],[1.1,16.3],[0.9,6.1]],"w":4.25}]}}};

  function makeCharacter(name, head, accent, skin) {
    const c = { name, head, accent, stats: defaultStats(), actions: defaultActions() };
    if (skin) c.skin = JSON.parse(JSON.stringify(skin));
    return c;
  }

  // ---- default content -----------------------------------------------------
  function defaults() {
    const stageReference = DS.stageReference || { view: VIEW, platforms: [] };
    return {
      version: 4,
      view: { w: VIEW.w, h: VIEW.h },
      settings: {
        gravity: 2300,
        timerSeconds: 99,
        stocks: 3,
        knockbackScale: 1.0,
        hitstop: 1.0,
        scenery: 1.0, // procedural "dressing" density (pillars/plants under+on platforms); 0 = off

        // generous KO bounds so fighters fly way out before dying (the dynamic camera
        // zooms out to follow them); ~1100px of margin around the 1920x1080 stage.
        blast: { left: -1100, right: VIEW.w + 1100, top: -900, bottom: VIEW.h + 950 },
      },
      stage: {
        // [x, y(top), w, h, passthrough] — laid out in the 1920x1080 view
        platforms: clone(stageReference.platforms),
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
        // the built-in fighters wear the hand-drawn Ddoski bear skin (animates via DS.skin)
        Sprout: makeCharacter('Sprout', 'none', '#5b8c5a', DDOSKI_SKIN),
        Acorn: makeCharacter('Acorn', 'none', '#9c6b3f', DDOSKI_SKIN),
      },
      roster: ['Sprout', 'Acorn'],
    };
  }

  // ---- store ---------------------------------------------------------------
  // Bumping the key forces fresh defaults to load instead of an older save winning the merge.
  // v16: Ddoski offsetY 14 (feet on the ground).
  const KEY = 'doodle-smash:data:v16';

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
