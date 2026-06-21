# 10 — Game Modes & Maps

Two small **data-driven registries** in `js/modes.js` (`DS.Modes`, `DS.Maps`) plus a main-menu
overlay. A match is `{ mode, map }`: the mode decides scoring/win, the map decides geometry. Both
are additive — new content is a new registry entry, no engine changes.

## The main menu
An HTML overlay (`#menu-overlay` in `index.html`, styled in `style.css`, wired in `js/main.js`).
It builds clickable cards from `DS.Modes.list()` / `DS.Maps.list()`, so listing a new mode/map
makes it appear automatically. **Start** sets `game.modeId` / `game.mapId`, then `rebuild()` +
`start()`. The topbar **≡ Menu** button reopens it (pausing a live match). Shown on a fresh load
(no dev `#hash`).

## Modes (`DS.Modes`)
A mode is a plain object of hooks the `Game` calls; **per-match runtime state lives on
`game.modeState`** (modes are shared singletons, so never store match state on the mode itself).

| field / hook | purpose |
|---|---|
| `elimination` | `true` → running out of stocks ends the match (Smash). `false` → infinite respawns. |
| `usesTimer` | `true` → the match countdown runs and can end the match (Smash only). |
| `setup(game)` | **required** — initialise `game.modeState`. |
| `update(game, dt)` | per-frame logic; set `game.winner` + `game.state='over'` to end. Called from `Game.update` after fighters/projectiles. |
| `renderWorld(game, ctx)` | optional world-space drawing (gems, the hill), inside the camera transform. |
| `portraitScore(game, f)` | optional short score string the HUD draws under a non-elimination portrait (in place of hearts). |
| `overText(game)` | optional headline for the game-over overlay. |
| `onKO(game, victim)` | optional; called from `Fighter._ko` when a fighter is knocked out. |

Built-in modes:
- **Smash** (`smash`) — elimination + timer. The original: last fighter with stocks wins. Hearts HUD.
- **King of the Hill** (`koth`) — infinite respawns. `setup` picks the **highest platform** of the
  active map as the hill (so it's automatically the hard-to-reach one). A *lone* occupant standing
  on it banks time; first to `holdToWin` (12s) wins. Draws a dashed highlight + bobbing crown.
- **Gem Grab** (`gems`) — infinite respawns. Gems **slow-drift** through the air (eased wander +
  wall bounce, ~60px/s) so they're a bit of a chase; touch one to bank it; first to `gemsToWin` (5).
- **K.O. Rush** (`bounty`) — infinite respawns, no stocks. Every knockout scores: `onKO` credits the
  victim's `lastHitBy` (set in `Fighter._takeHit`; cleared on respawn — self-destructs score nobody).
  First to `kosToWin` (5).

### How non-elimination modes stay alive
`Fighter._ko` reads `world.game.mode`: if `mode.elimination` is false it always respawns (never sets
`dead`), and it calls `mode.onKO` *before* respawning so the killer can be credited. Smash is
unchanged. `Game.checkOver()` (last-one-standing) is only called by Smash's `update`.

## Maps (`DS.Maps`)
`{ id, name, desc, editable?, build(data) -> stage }`. A built stage is
`{ bounds?, blast?, platforms, spawns, decor, bg? }`. The active stage is resolved in
`Game.rebuild`: `game.stage = map.editable ? data.stage : map.build(data)`, then `Game._prepareStage`
stamps stable jitter seeds, breakable `_hp`, initial moving-platform positions, and the world
`bounds` + `blast`.

- **Demo** (`demo`, `editable:true`) — the permanent menu-flow level: classic Doodle Smash setup,
  local/player lobby, and the same live stage surface the original menu path used.
- **Meadow** (`meadow`, `editable:true`) — **is** the live `data.stage` the Editor owns; editor
  changes show when you play Meadow (now with a hill/tree background + plants). View-sized.
- **Twin Peaks** (`twin`) — stone mesas over a chasm, swinging rope-bridge, crates, mountains + keep.
- **Sky Loft** (`loft`) — floating wood platforms, a swinging plank, crystal summit, sky-islands.
- **Quarry** (`quarry`) — wide stone floor, crystal ledges, a rising elevator + a trolley, crate wall.
- **Ruins** (`ruins`) — stone terraces over a pit, column ledges under broken arches, a swinging gate.

`Game.stage` (not `data.stage`) is the source of truth during a match: fighters spawn from it,
physics/projectiles collide with `game.stage.platforms`, and `DS.stage.drawStage` accepts either a
stage or the data wrapper (duck-typed on `.platforms`).

### Bigger arenas
Maps may set `bounds {x0,y0,x1,y1}` larger than the 1920×1080 view. `Game._updateCamera` clamps the
camera centre to `bounds` (+margin) and the min zoom is `0.42`, so the dynamic camera follows
fighters across the whole arena. `blast` derives from `bounds` (margin out) unless the map sets it;
Meadow (no bounds) keeps the shared `settings.blast`. `Game.blast`/`Game.bounds` are exposed on
`world` and read by the fighter KO check, projectiles, and the blast border.

### Dynamic platforms & breakables
Platform objects gained optional fields (absent = a plain static platform):
- `kind`: `ground | float | wood | stone | crystal | box | spikes` — picks the look in `js/stage.js` (`PLAT`).
- `hurt`: `{ damage, kbBase, kbScale, cooldown }` on a `kind:'spikes'` slab — touching it deals heavy
  damage + knockback (`Game._updateStage`, no attacker, per-fighter cooldown, then launches you off).
- `move`: `{ type:'swing', pivotX, pivotY, len, arc, period, phase }` (pendulum) or
  `{ type:'linear', ax, ay, bx, by, period, phase }` (ping-pong). `Game._updateStage` repositions it
  each frame and **carries any rider** (a fighter whose `ground === plat`) by the same delta.
  `js/stage.js` draws ropes for swings.
- `hp`: breakable. Melee (`Fighter._updateAction`) and projectiles (`Game._updateProjectiles`) call
  `world.damageBox(plat, amount)`; at 0 hp the platform is spliced out and `Effects.debris` shatters
  it. The crate look shows more cracks as `_hp` drops.

### Background structures & plants
`stage.bg` is a far layer drawn by `DS.stage.drawBackground` (behind everything, faded via `a` for
depth, no parallax so structures stay aligned with the platforms they "build into" — e.g. a `tower`
behind a perch, `arch`es framing column ledges). Background types: `mountain, hill, tower, building,
arch, skyisland`. Foreground `decor` plant types: `tree, pine, mushroom, reeds, vine` (+ the original
`flower, grass, bush, cloud`).

## Adding a mode or map
- **Mode:** add an entry to `DS.Modes.defs` + its id to `_order`. Implement `setup` (+ whatever
  hooks you need). For score modes set `elimination:false` and provide `portraitScore`. Done — the
  menu lists it and the Game calls it.
- **Map:** add an entry to `DS.Maps.defs` + its id to `_order` with a `build()` returning a stage.
  Mix in `kind`/`move`/`hp` platforms, a `bg` array, and `bounds` for a bigger arena. KotH auto-uses
  the highest platform as the hill.

See `06` for the general extension recipes and `03` for the combat the modes sit on top of.
