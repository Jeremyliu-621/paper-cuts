(function (global) {
  'use strict';

  const reference = {
    view: { w: 1920, h: 1080 },
    platforms: [
      { x: 225, y: 863, w: 1470, h: 195, pass: false },
      { x: 143, y: 705, w: 353, h: 39, pass: true },
      { x: 768, y: 468, w: 384, h: 39, pass: true },
      { x: 1425, y: 705, w: 353, h: 39, pass: true },
    ],
  };

  global.DS = global.DS || {};
  global.DS.stageReference = reference;
})(typeof window !== 'undefined' ? window : globalThis);
