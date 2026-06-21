(function (global) {
  'use strict';

  const reference = {
    view: { w: 1920, h: 1080 },
    platforms: [],
  };

  global.DS = global.DS || {};
  global.DS.stageReference = reference;
})(typeof window !== 'undefined' ? window : globalThis);
