# Drawing Capture And Editor Seams

This document replaces the old standalone iPad persistence framing. The drawing client and backend are useful plumbing, but the product direction is a visual creation phase layered over the actual Doodle Smash level structure.

## Correct Mental Model

The drawing is not the level editor by itself. It is visual intent captured over a static game-stage reference. The system should store the drawing, derive game-friendly projection data, ask clarifying questions, and eventually produce typed game patches.

Phase 1 must only render drawings over the game canvas. It should not mutate game data.

The iPad/browser reference for Phase 1 should be static and platform-only. It should use the game's 1920 x 1080 view-space coordinate system without a live match simulation, dynamic camera, fighters, timer, HUD, projectiles, particles, or countdown state.

## Current Game Source Of Truth

The active game is the root vanilla app:

- `index.html`
- `style.css`
- `controller.html`
- `server.js`
- `js/*.js`

`js/data.js` owns `DS.Store.data`, a serializable JSON tree persisted to `localStorage` under `doodle-smash:data:v3`. `js/stageReferenceData.js` contains the shared default platform reference used by both the editable Meadow defaults and the Phase 1 draw-client underlay.

Important data:

- `view`: logical 1920 x 1080 game view.
- `settings`: match settings such as gravity, timer, stocks, knockback, hitstop, and blast bounds.
- `stage`: editable Meadow stage.
- `stages`: materialized editable copies of preset maps.
- `characters` and `roster`: character stats, action poses, hitboxes/projectiles, and skin strokes.

## Existing Editor Seams

`js/editor.js` mutates `DS.Store.data` directly and saves through `DS.Store.save()`. The future creation system should reuse these concepts instead of inventing a parallel game model.

Target seams:

- `DS.Maps.stageFor(data, mapId)` returns the persistent stage object for the selected map.
- `stage.platforms` contains rectangle records such as `{ x, y, w, h, pass }`.
- `stage.spawns` contains `{ x, y }` spawn points.
- `stage.portals` contains linked portal records: `{ id, link, x, y, r, col }`.
- `stage.decor` and `stage.bg` contain visual scenery records.
- Character skins live under `ch.skin.parts[part].strokes`, with strokes stored relative to `DS.skin.PIVOTS[part]`.

Supported platform/gimmick fields include:

- `kind`: `ground`, `wood`, `stone`, `crystal`, `box`, `float`, `cannon`, or `trampoline`;
- `pass`: pass-through behavior;
- `hp`: breakable platform health;
- `fire`: cannon config;
- `bounce`: trampoline strength;
- `move`: runtime moving-platform metadata.

## Coordinate Seams

The creation bridge must preserve coordinate meaning.

- Game view space is 1920 x 1080 for view-sized maps.
- Larger maps may have stage-world bounds beyond the default view.
- The current Stage editor computes a fit-to-map transform and maps pointer input back to stage-world coordinates.
- Character drawing uses mannequin/fighter-local coordinates.

Future drawing projection data should be normalized so it can map cleanly to:

- game view coordinates;
- selected stage-world coordinates;
- character mannequin-local coordinates when drawing character skins.

## Phase 1 Projection Requirement

The backend should store both:

- canonical drawing capture, such as a tldraw snapshot;
- derived projection data that the vanilla game can render cheaply.

The draw client's background/reference layer should come from selected stage platform data:

- render platform rectangles/gimmick outlines in 1920 x 1080 view space;
- keep camera fixed;
- show only gameplay-relevant geometry needed for drawing alignment;
- avoid running a second live game scene.

Projection data should include:

- room ID;
- capture/projection version;
- source object IDs;
- primitive type;
- points/bounds in normalized or game coordinates;
- label text where present;
- tool/color/style metadata;
- timestamp/client metadata.

The game should render projection data as a non-mutating overlay. It should not write to `DS.Store.data` until a later approved patch phase.

## Later Conversion Boundary

The future agent should infer candidate game records and ask clarifying questions before proposing patches. It should produce typed proposals against known seams, not arbitrary code changes.
