// Keyboard input with per-frame pressed/held/released, mapped to two players.
(function (global) {
  'use strict';

  const BINDINGS = [
    { left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS', attack: 'KeyF', special: 'KeyG', shield: 'ShiftLeft' },
    { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', attack: 'Period', special: 'Slash', shield: 'ShiftRight' },
  ];
  // keys we own (so the page doesn't scroll / quick-find)
  const OWNED = new Set();
  BINDINGS.forEach((b) => Object.values(b).forEach((k) => OWNED.add(k)));
  ['Enter', 'KeyP', 'Escape', 'Space'].forEach((k) => OWNED.add(k));

  const Input = {
    held: {}, prev: {},
    _global: { enter: false, pause: false, esc: false },
    init() {
      window.addEventListener('keydown', (e) => {
        if (OWNED.has(e.code)) e.preventDefault();
        if (e.repeat) return;
        this.held[e.code] = true;
      });
      window.addEventListener('keyup', (e) => { this.held[e.code] = false; });
      window.addEventListener('blur', () => { this.held = {}; });
    },
    pressed(code) { return !!this.held[code] && !this.prev[code]; },
    released(code) { return !this.held[code] && !!this.prev[code]; },
    // call once per frame AFTER everyone has read input
    update() { this.prev = Object.assign({}, this.held); },

    player(i) {
      const b = BINDINGS[i];
      return {
        left: !!this.held[b.left], right: !!this.held[b.right],
        up: !!this.held[b.up], down: !!this.held[b.down],
        shield: !!this.held[b.shield],
        pressLeft: this.pressed(b.left), pressRight: this.pressed(b.right),
        pressUp: this.pressed(b.up), pressDown: this.pressed(b.down),
        pressAttack: this.pressed(b.attack), pressSpecial: this.pressed(b.special),
        holdAttack: !!this.held[b.attack], holdSpecial: !!this.held[b.special],
      };
    },
    bindings: BINDINGS,
  };

  global.DS = global.DS || {};
  global.DS.Input = Input;
})(window);
