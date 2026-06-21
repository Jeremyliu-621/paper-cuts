# NEW TODO: Phase 1 VLM-Guided Stage Object Creation

Phase 1 goal: from the desktop Game Library, the user opens a level editor, draws over the active stage on the iPad, and the system turns each doodle into a playable game object. Supported objects for this phase are:

- platform;
- cannon;
- spikes;
- portal pair.

The VLM classifies intent. Deterministic code owns geometry and creates the final game data.

## Phase 1 End State

At the end of Phase 1, this should work:

1. Open the desktop game/library.
2. Click `Edit Level` on a world.
3. The desktop enters the MagicBoard/iPad editing flow for that world.
4. The iPad connects automatically to the active world room.
5. The iPad shows the current stage as the drawing reference.
6. User draws a doodle over the stage.
7. The backend groups the recent drawing into a candidate.
8. A background VLM worker classifies that candidate as platform, cannon, spikes, portal endpoint/pair, or unknown.
9. Deterministic constructors convert accepted classifications into real stage objects.
10. The desktop editor previews those proposed objects.
11. User accepts/corrects/ignores them.
12. Accepted objects are saved into the world stage.
13. Clicking `Play` starts a match using the updated stage.

## Current Repo Reality

### Desktop/Game/Editor

- `Edit Level` currently opens the legacy Stage editor, not the iPad/MagicBoard flow:
  - `js/worldLibrary.js` card button calls `options.onEdit`.
  - `js/main.js` wires that to `enterWorldStageEditor(world)`.
  - `enterWorldStageEditor` calls `editor.editWorldStage(world)`.
- The older iPad bridge still exists as `DS.LevelPreview`, but it is no longer reachable from the library `Edit Level` flow.
- `DS.LevelPreview.enter(world, ...)` publishes the active backend room selection, which is why the iPad waiting screen only works when LevelPreview is active.
- World records live in `magicboard:worlds:v1`.
- Playable stage data lives in `DS.Store.data.stages` under `doodle-smash:data:v3`.
- `DS.Maps.ensureCustomStage(data, world)` creates a custom world stage, but it is mostly one-way. Later `world.draft` changes do not automatically overwrite an existing stage.
- `Play` already uses `DS.Maps.stageFor(data, mapId)` through `Game.rebuild()`, so once objects are saved into the world stage, gameplay will use them.
- Current world readiness can report a new empty world as ready because platform existence is no longer checked.

### Existing Deterministic Outputs

The game already knows how to render/play these objects:

- Platform:
  - stored in `stage.platforms[]`;
  - shape: `{ x, y, w, h, kind, pass }`.
- Cannon:
  - stored in `stage.platforms[]`;
  - shape: `kind: "cannon"` plus `fire: { deg, every, speed, damage, kbBase, kbScale, r, delay }`.
- Spikes:
  - stored in `stage.platforms[]`;
  - shape: `kind: "spikes"` plus `hurt: { damage, kbBase, kbScale, cooldown }`.
- Portal:
  - stored in `stage.portals[]`;
  - always two linked endpoint records;
  - each endpoint shape: `{ id, link, x, y, r, col }`.

Current `js/magicBoardGame.js` can build/apply platform, cannon, and spikes through platform candidates. It does not yet support portal patch operations.

### iPad/Backend/VLM

- `draw-client/src/App.jsx` sends full tldraw capture/projection over WebSocket after a short debounce.
- The iPad can connect by explicit `?room=...` or by listening to backend `/ws/selection`.
- Backend `RoomRegistry.store_capture` stores capture/projection, increments room version, and builds a semantic draft.
- `backend/app/semantic.py` currently extracts platform-shaped candidates:
  - clear rectangles;
  - horizontal strokes;
  - grouped aligned strokes.
- VLM currently observes the whole projection image, not a candidate crop.
- `_schedule_visual_observation` creates a task per capture. There is stale rejection, but not a real candidate-level queue.
- VLM hints can auto-confirm candidates by matching `sourceIds`.
- Current semantic schema supports platform behaviors, including cannon and hurt/spikes. It does not yet model portal endpoints or portal pairs.

## Required Phase 1 User Flow

### Desktop

1. User opens:
   - desktop game/library;
   - backend;
   - iPad draw client.
2. User clicks `Edit Level` on a world.
3. Desktop enters the MagicBoard stage editing flow, not the disconnected legacy-only editor flow.
4. Desktop publishes backend selection:
   - `roomId`;
   - `worldId`;
   - `worldName`;
   - active stage reference/snapshot.
5. Desktop renders proposed and accepted objects over the stage.
6. Desktop exposes simple actions:
   - accept proposed object;
   - correct classification;
   - ignore/delete proposed object;
   - play stage.

### iPad

1. iPad connects to the selected world room.
2. iPad shows the active stage reference, not the empty static `stageReferenceData`.
3. User draws freely. There are no explicit object buttons for Phase 1.
4. Drawing stays responsive while VLM work happens in the background.
5. Candidate outlines/proposed classifications can appear as overlays.

### Backend

1. Receives capture/projection updates.
2. Detects the recently changed source IDs.
3. Builds or updates one active candidate at a time.
4. Enqueues candidate classification work.
5. Coalesces updates for candidates that are still changing.
6. Sends candidate crops to the VLM.
7. Applies only fresh VLM results.
8. Updates semantic objects.
9. Emits semantic/object preview updates to desktop and iPad.

## Semantic Flow

```text
raw iPad strokes
  -> deterministic candidate evidence
  -> candidate-level VLM classification
  -> semantic object
  -> deterministic game-object constructor
  -> typed stage patch
  -> saved playable stage
```

Definitions:

- Candidate: geometry/evidence derived from raw drawing.
- Semantic object: the interpreted intent, still editable.
- Stage object: actual playable game data in `stage.platforms[]` or `stage.portals[]`.

Candidate metadata must include:

- `candidateId`;
- `candidateVersion`;
- `sourceIds`;
- `geometry`;
- `geometryHash`;
- `captureVersion`;
- `extractor`;
- `status`;
- optional `classification`.

Semantic object types for Phase 1:

- `semantic_platform`;
- `semantic_cannon`;
- `semantic_spikes`;
- `semantic_portal_endpoint`;
- `semantic_portal_pair`;
- `semantic_unknown`.

## One-At-A-Time Real-Time Loop

The system should not wait for the whole scene to be finished. It should process the most recent doodle as the unit of work.

```text
stroke burst starts
  -> active candidate updates locally
  -> user pauses briefly
  -> candidate version freezes
  -> candidate crop enters VLM queue
  -> user keeps drawing
  -> VLM result returns later
  -> stale result is accepted or discarded
```

Implementation rules:

- Drawing is never blocked by VLM.
- Candidate extraction is fast and deterministic.
- VLM classification is background work.
- Queue unit is a candidate or candidate group, not the whole scene.
- Reclassify a candidate only when its `candidateVersion` changes.
- If a newer candidate version exists, discard the old VLM result.
- If the user manually corrects a candidate, future VLM results must not overwrite it.

## Candidate Grouping

Phase 1 grouping should be conservative and deterministic first, with VLM used for classification, not geometry creation.

Signals:

- source IDs from tldraw;
- recent changed source IDs;
- temporal stroke burst;
- spatial proximity;
- shape type;
- color/tool continuity;
- nearby labels;
- existing candidate membership.

Initial grouping rules:

- One clear rectangle or horizontal stroke burst -> platform-like candidate.
- Several close, aligned horizontal strokes in one burst -> one platform candidate.
- Compact doodle near/on a platform -> possible cannon or spikes candidate.
- One circle/oval -> possible portal endpoint candidate.
- Two circle/oval candidates -> possible portal pair, even if far apart.
- If uncertain, keep candidates separate and ask/correct later.

Portal exception:

- A portal is drawn as two circles.
- One circle creates a pending portal endpoint.
- The second compatible circle completes a portal pair.
- The two circles can be far apart.
- Pairing can use:
  - draw order;
  - matching color;
  - matching size;
  - labels;
  - user confirmation.

## VLM Input Strategy

Do not rely on whole-scene classification.

For each queued candidate, render:

- candidate crop with padding;
- highlighted candidate mask/outline;
- nearby context crop;
- optional small whole-stage thumbnail;
- metadata:
  - `candidateId`;
  - `candidateVersion`;
  - `sourceIds`;
  - bounds;
  - nearby labels;
  - capture version.

For portal pairing, the VLM may receive:

- one endpoint crop for endpoint classification;
- a two-crop/contact sheet for pair classification;
- a small whole-stage thumbnail so far-apart endpoints still have context.

Expected VLM response:

```json
{
  "candidateId": "candidate-abc123",
  "candidateVersion": 4,
  "sourceIds": ["shape:xyz"],
  "class": "cannon",
  "confidence": 0.86,
  "needsQuestion": false,
  "question": null,
  "reason": "compact cannon-like doodle on a ledge"
}
```

Allowed classes:

- `platform`;
- `cannon`;
- `spikes`;
- `portal_endpoint`;
- `portal_pair`;
- `unknown`;
- `ignore`.

## Queue/Parallelization Requirements

Add a candidate-level coalescing queue.

Required behavior:

- Per room, keep a queue of candidate classification jobs.
- Allow drawing/capture updates to continue while jobs run.
- Coalesce duplicate queued jobs for the same candidate.
- Replace queued stale candidate versions with the latest candidate version.
- Limit active VLM work:
  - per room: likely 1 active job at a time for predictable ordering;
  - globally: small worker limit, such as 2-3 concurrent VLM requests.
- Prioritize:
  - currently active/recent candidate;
  - visible unclassified candidates;
  - portal endpoint pairing jobs after endpoint classification.
- Drop stale results by `roomId`, `captureVersion`, `candidateId`, and `candidateVersion`.
- Never overwrite manual corrections.

## Deterministic Constructors

VLM output maps to deterministic constructors:

- `platform` -> `makePlatform(candidate)`.
- `cannon` -> `makeCannon(candidate)`.
- `spikes` -> `makeSpikes(candidate)`.
- `portal_endpoint` -> `makePortalEndpoint(candidate)`.
- `portal_pair` -> `makePortalPair(endpointA, endpointB)`.

Constructor outputs:

- `makePlatform` creates `stage.platforms[]` record.
- `makeCannon` creates `stage.platforms[]` record with `kind: "cannon"` and default `fire`.
- `makeSpikes` creates `stage.platforms[]` record with `kind: "spikes"` and default `hurt`.
- `makePortalPair` creates two linked `stage.portals[]` records.

Constructors must be pure and deterministic. They should not call VLM or inspect pixels.

## Typed Patch Contract

Extend `js/magicBoardGame.js` beyond platform-only patches.

Current ops:

- `replace_platforms`;
- `add_platform`;
- `set_spawns`.

Needed ops:

- `add_platform`;
- `remove_generated_object`;
- `add_portal_pair`;
- `set_portals` or `replace_portals` if needed;
- optional `replace_generated_objects` instead of wiping all manual platforms.

Important: current `Apply Platforms` can use `replacePlatforms: true`, which wipes existing platforms. Phase 1 should avoid wiping manually edited stage content unless the user explicitly requests reset.

## Implementation Steps

### 1. Fix Desktop Entry And Room Selection

- [ ] Decide final Phase 1 editing entry: `Edit Level` should open MagicBoard/iPad stage editing.
- [ ] Wire `worldLibrary.onEdit` to the MagicBoard editing flow, not legacy-only `enterWorldStageEditor`.
- [ ] Keep legacy Stage editor accessible separately if still needed.
- [ ] On entering MagicBoard editing, publish backend selection for the active world.
- [ ] Make desktop and iPad URLs deterministic:
  - backend URL;
  - draw client URL;
  - room ID;
  - world ID;
  - world name.
- [ ] Add tests/smoke coverage that `Edit Level` publishes selection and the iPad does not stay on waiting.

### 2. Send Active Stage Reference To iPad

- [ ] Add backend room state for active stage reference/snapshot.
- [ ] Include stage bounds, existing platforms, existing portals, and spawns.
- [ ] Update draw-client to render the active stage reference instead of static empty `stageReferenceData`.
- [ ] Update stage reference whenever the desktop changes the active world/stage.
- [ ] Ensure coordinates match world/stage coordinates for large maps, not only 1920x1080 screen space.

### 3. Make World Stage The Source Of Truth

- [ ] Decide whether world `draft` or `DS.Store.data.stages[worldId]` owns stage objects.
- [ ] For Phase 1, prefer `DS.Store.data.stages[worldId]` as the playable source.
- [ ] Sync world library status/thumbnail from the actual stage.
- [ ] Fix readiness so a world needs at least one playable platform or accepted stage object.
- [ ] Ensure `Play` always uses the same stage objects the editor shows.

### 4. Add Candidate Tracking

- [ ] Track changed source IDs from each iPad capture.
- [ ] Add candidate versioning.
- [ ] Keep candidate records in backend room state.
- [ ] Distinguish raw evidence candidates from semantic classifications.
- [ ] Add candidate statuses:
  - `active`;
  - `queued`;
  - `classifying`;
  - `classified`;
  - `needs_confirmation`;
  - `accepted`;
  - `ignored`;
  - `stale`.
- [ ] Preserve candidate provenance for generated stage objects.

### 5. Improve Candidate Extraction And Grouping

- [ ] Keep existing rectangle/horizontal stroke platform extraction.
- [ ] Add stroke-burst grouping around recent source IDs.
- [ ] Add circle/oval detection for portal endpoints.
- [ ] Add compact glyph detection for possible cannon/spikes.
- [ ] Add two-endpoint portal pair grouping:
  - same/near draw time;
  - matching color;
  - compatible size;
  - pending unmatched endpoint list.
- [ ] Keep grouping conservative; prefer user correction over aggressive merging.

### 6. Add Candidate Crop Rendering

- [ ] Render a crop for one candidate with padding.
- [ ] Highlight candidate strokes/shapes in the crop.
- [ ] Include nearby context.
- [ ] Render a two-candidate contact sheet for portal pair checks.
- [ ] Include a small whole-stage thumbnail only as context.
- [ ] Store crop metadata with candidate ID/version/source IDs.

### 7. Add Candidate-Level VLM Queue

- [ ] Replace per-capture whole-scene VLM scheduling with candidate classification jobs.
- [ ] Add per-room coalescing queue.
- [ ] Add global worker limit.
- [ ] Coalesce jobs by candidate ID.
- [ ] Drop stale results by candidate version/capture version.
- [ ] Keep whole-scene observation only as optional debug/fallback.

### 8. Extend Backend Semantic Schema

- [ ] Add semantic object classes:
  - platform;
  - cannon;
  - spikes;
  - portal endpoint;
  - portal pair;
  - unknown;
  - ignore.
- [ ] Add portal endpoint/pair fields to schemas.
- [ ] Add VLM response schema for candidate classification.
- [ ] Preserve existing manual answer/clarification behavior.
- [ ] Ensure manual corrections override VLM output.

### 9. Update VLM Prompt And Parser

- [ ] Prompt model to classify only the highlighted candidate/candidate pair.
- [ ] Make allowed classes explicit.
- [ ] Ask for structured JSON only.
- [ ] Include `candidateId`, `candidateVersion`, and `sourceIds` in the response.
- [ ] Add parser normalization:
  - "hazard", "teeth", "danger" -> `spikes`;
  - "gun", "turret", "shooter" -> `cannon`;
  - "circle", "wormhole", "teleporter" -> `portal_endpoint`;
  - "two portals" -> `portal_pair`.

### 10. Extend Deterministic Patch/Application

- [ ] Keep platform/cannon/spikes platform output.
- [ ] Add portal pair constructor.
- [ ] Add `add_portal_pair` validation.
- [ ] Add portal generated-source provenance.
- [ ] Allow replacing/removing generated portal pairs by candidate IDs.
- [ ] Avoid replacing all existing platforms by default.
- [ ] Apply accepted semantic objects into `DS.Maps.stageFor(data, worldId)`.
- [ ] Save through `DS.Store.save()`.

### 11. Build Desktop Preview And Acceptance UI

- [ ] Preview classified candidates on the desktop stage.
- [ ] Show class label and confidence.
- [ ] Provide accept/correct/ignore actions.
- [ ] Corrections should update semantic object and prevent stale VLM overwrite.
- [ ] Portal endpoints should show pending state until paired.
- [ ] Accepted objects should render using the actual deterministic stage renderer.

### 12. Update iPad Feedback

- [ ] Show candidate outlines while drawing.
- [ ] Show class/status once VLM result returns.
- [ ] Keep interaction lightweight so iPad remains a sketch surface.
- [ ] Do not require waiting for one object before drawing another.

### 13. Save And Play

- [ ] Persist accepted objects into the active world stage.
- [ ] Update library thumbnail/status from saved stage.
- [ ] Verify Play uses updated platform/cannon/spikes/portal objects.
- [ ] Verify cannon firing, spike damage, and portal teleport all work in match.

## Phase 1 Acceptance Criteria

- [ ] From the library, clicking `Edit Level` connects the iPad without manual room ID entry.
- [ ] iPad shows the active stage reference.
- [ ] User can draw a platform; VLM/classifier identifies it; accepted object becomes playable platform.
- [ ] User can draw a cannon; VLM/classifier identifies it; accepted object becomes a firing cannon.
- [ ] User can draw spikes; VLM/classifier identifies them; accepted object damages players.
- [ ] User can draw two portal circles; VLM/classifier identifies endpoints/pair; accepted object teleports players.
- [ ] User can continue drawing while VLM jobs are still running.
- [ ] Stale VLM results do not overwrite newer drawings.
- [ ] Manual corrections override VLM guesses.
- [ ] Play uses the exact updated stage objects.
- [ ] Existing manually edited stage objects are not wiped by applying new generated objects.

## Non-Goals For Phase 1

- No arbitrary code generation.
- No VLM-created geometry.
- No full-scene-only classification as the primary path.
- No final level balancing system.
- No broad object catalog beyond platform, cannon, spikes, and portal.
- No complex voice-agent planning loop yet.

