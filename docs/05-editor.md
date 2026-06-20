# 05 — The Editor

`js/editor.js` (`DS.Editor`). Opened via the **Editor** top tab. It mutates `DS.Store.data` in
place and debounce-saves (`queueSave` → `Store.save`). The Play mode reads the same data on
`rebuild()`, so **"▶ Play test"** = rebuild + start with the latest edits.

The editor renders onto the main game canvas (a preview/scene per sub-tab) and builds DOM controls
into `#editor-panel`.

## Sub-tabs
- **Characters** — pick character + head style; pick an action; reshape its pose with joint sliders
  (live big preview on the canvas, with a clean baseline + shadow); tune stats; edit the melee
  `hit` fields (for `attack`) or the `projectile` fields (for `special`).
- **Draw** — draw your own fighter over the faint mannequin. `Auto` sorts each stroke into the
  nearest body part, or lock a specific part. Brush size, Undo, Clear part / Clear all, and a
  "use drawing" toggle (off = built-in stick figure). Shows per-part stroke counts. Saves into
  `ch.skin` (see `04`).
- **Stage** — pick **any map** from the `Map` dropdown and edit it (not just Meadow). Drag platforms
  to move; drag a platform's bottom-right corner to resize; drag the dotted circles to move spawns;
  **↺ Reset this stage** restores the map's built-in layout. Selected platform has numeric x/y/w/h, a
  `kind` (ground/wood/stone/crystal/box/float/**cannon/trampoline**), `pass-through`, and
  `breakable hp` (0 = solid). The canvas auto-frames the whole selected map (presets can be far
  wider than the 1920×1080 view), with a dashed guide showing the map's play-bounds.
  - **Gimmicks** are addable/removable/resizable like platforms:
    - **+ cannon** — a platform with a `fire` config; controls for **angle / interval / ball
      speed / damage / ball size**. (Or set any platform's `kind` to `cannon`.)
    - **+ bouncy** — a `trampoline` platform with a **bounce** strength slider. (Or `kind` =
      `trampoline`.)
    - **+ portal** — a linked **pair** of teleport portals; drag to move, drag the bottom **nub**
      to resize the radius, pick a colour, and **− selected** removes the whole pair. Portals live
      in `stage.portals` (`{id, link, x, y, r, col}`).
    - **✎ Draw a platform** — toggle on, then **trace a squiggle** on the stage and it becomes a
      `kind:'drawn'` platform (`pts`, relative to the platform's top-left). It renders as a chunky
      ledge: the stroke is the **top surface**, with a paper body extruded down (`DRAWN_TH`), ink
      top/bottom edges, end caps, a top lip and a soft shadow. It moves / resizes (the squiggle
      scales with the box) / deletes like any platform.
      - **Collision follows the actual shape.** `_prepareStage` turns the stroke into world-space
        line segments (`p._segs`); `physics.step` treats them as **one-way surfaces** — you land on
        any part from above (so a **C-shape's top arc *and* lower arc both work**), and once standing
        you **stick to the slope/curve within a step band**, so your feet follow the face up and
        down instead of floating. Drawn platforms never wall you off horizontally (shaped one-way
        surface, like a soft platform that follows the drawing). Drop-through (press down) still works.
- **Settings** — `gravity`, `timer`, `stocks`, `knockback`, `hitstop` sliders.

Common buttons: **Save**, **Reset all** (defaults), **Export** (download JSON), **Import** (load
JSON), **▶ Play test**.

## Canvas interaction model
- `_toView(e)` converts a pointer event → view coordinates using `game.ox/oy/scale` (set during
  render). `_toMan(e)` further converts → mannequin-local for the Draw tab (`/Z`, Z = the draw zoom).
- The **Stage tab uses its own fit-to-map transform** (`_stageView` → `this._sv`), so a stage bigger
  than the view still frames fully; `_toStage(e)` maps pointer → stage-world coords with it.
- Pointer handlers branch on `this.subtab` ('stage' = drag platforms/spawns, 'draw' = paint strokes).
- Entering the Editor tab dismisses the menu/lobby overlays so they don't cover the stage canvas.

## All stages are editable (persistence)
`DS.Maps.stageFor(data, id)` returns the **persistent, editable** stage for any map: Meadow is the
live `data.stage`; every preset is materialised from its `build()` **once** into `data.stages[id]`
and then edits stick (saved with the Store). `DS.Maps.resetStage(data, id)` restores one map. The
**Game plays a deep clone** of this stage (`game.rebuild`), so a match's moving platforms, cannon
timers, breakable crates and portal cooldowns never mutate the saved layout.

## Adding a new editable control (the pattern)
1. Put the value in `js/data.js` (a `settings` field, a `stats` field, or an action field).
2. In the relevant `_build*` method, add a row with `this._slider(parent, label, min, max, step,
   () => obj.field, v => obj.field = v)` (or `_num`). The getter/setter close over the data object;
   `_slider` calls `queueSave()` on input automatically.
3. That's it — the game reads the field on next `rebuild()`.

Guiding principle (see `00`/`README`): **every meaningful tunable should be editable here.** If you
add a mechanic with magic numbers, expose them.
