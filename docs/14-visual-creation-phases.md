# Visual Creation Phases

Magic Board adds a creation phase to the existing Doodle Smash game. The creation phase starts with visual intent, then moves through clarification, patching, and asset enhancement.

## Phase 1: Drawing Bridge

Goal: drawings from an iPad or browser appear on the laptop game canvas while the drawing surface shows a static, platform-only reference of the level.

The user journey:

1. Laptop opens the Doodle Smash game scene.
2. iPad or laptop opens a drawing surface in the same room.
3. Drawing surface displays only gameplay-relevant platforms in a fixed 1920 x 1080 frame.
4. User draws rough platforms, character ideas, arrows, labels, or gameplay notes over that static reference.
5. Backend stores the canonical drawing and a derived projection.
6. Laptop game renders the projection as an overlay.
7. No game data is mutated.

Phase 1 proves spatial communication. It is successful when the user can draw on top of a stable platform reference and see the drawing aligned over the laptop game canvas.

The iPad reference should not be a second live match. It should not show timers, fighters, effects, projectiles, countdown, HUD, or dynamic camera movement.

## Phase 2: Clarification Agent

Goal: an agent turns messy drawing intent into a clear scene plan.

The agent reads:

- latest drawing capture;
- derived projection;
- current game capability contract;
- selected map/mode context;
- user natural-language brief.

The agent outputs:

- accepted supported candidates;
- rejected unsupported requests;
- concrete clarification questions;
- a scene plan once enough information exists.

The agent should ask bounded questions. It should not ask vague "what do you want?" questions when it can ask "solid or pass-through?" or "Gem Grab or Smash?".

## Phase 3: Build Scene

Goal: approved scene plans become valid game data.

The agent emits typed domain patches. The vanilla game validates and applies them through a small facade. Patches target existing seams:

- `DS.Maps.stageFor(...)`;
- `stage.platforms`;
- `stage.spawns`;
- `stage.portals`;
- `stage.decor`;
- `stage.bg`;
- `DS.Store.data.settings`;
- character skin/stats/pose data where supported.

The user can preview, accept, reject, and playtest.

## Phase 4: Asset Enhancement

Goal: rough doodles become polished in-game assets without breaking the visual identity.

Enhancement output should stay compatible with the current game model:

- procedural `DS.draw` code;
- skin stroke JSON;
- decor/background records;
- stage/platform style metadata;
- WebAudio recipes;
- pose/action tuning.

Asset enhancement is proposal-first. Generated assets are previewed before being applied.

## What This Is Not

This is not a generic game engine builder. The first target is the current Smash-style platform fighter. New mechanics can be added later, but the initial creation system should be excellent at building what the current game can already play.
