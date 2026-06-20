// Tiny deterministic PRNG so hand-drawn jitter is stable per element (no "boiling"
// unless we want it). Park–Miller LCG.
(function (global) {
  'use strict';

  function makeRng(seed) {
    let s = (seed | 0) % 2147483647;
    if (s <= 0) s += 2147483646;
    const fn = function () {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646; // [0,1)
    };
    fn.range = (a, b) => a + (b - a) * fn();
    fn.sym = (m) => (fn() * 2 - 1) * m; // [-m, m]
    return fn;
  }

  // hash a string -> int seed (so a pose/element key maps to a stable seed)
  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 2147483647;
  }

  global.DS = global.DS || {};
  global.DS.makeRng = makeRng;
  global.DS.hashSeed = hashSeed;
})(window);
