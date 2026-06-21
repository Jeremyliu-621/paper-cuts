# RUNBOOK — Track B: draw the *world* (environment elements)

Track A is "draw a held item, pick it up, use it." **Track B is "draw a piece of the
arena."** A drawn object can become a live environment element instead of a held weapon:
a spike trap that hurts, a spring that launches. Same pipeline, same props — the prop just
*acts on the arena* instead of being carried.

Status: **hazard + spring shipped** (branch `feat/track-b-environment-props`). Platform is
scaffolded but intentionally not yet live (see Next steps — there's a real landmine).

---

## What's live

| Element | CHLOE node | Behavior in the match |
|---|---|---|
| **Hazard** (spikes / saw / fire / trap) | `hazard` | Damages + knocks back any fighter who touches its zone. Per-fighter re-hit cooldown (0.6 s) so it ticks, doesn't shotgun. `radius` (from CHLOE) widens the zone. Skips invulnerable fighters. |
| **Spring** (spring / trampoline) | `bouncy` | Launches a fighter who comes **down** onto it (`vy ≥ 60`), refreshing their air jumps. Walking into it sideways while grounded does nothing. |

Environment props are **not** auto-picked-up and are **not** fired — they fall, rest on a
platform (existing prop physics), and act on contact.

### How it works (files)
- `js/prop.js` — `Prop.isEnv()` (kind ∈ {hazard, bouncy}) + `Prop.handleEnvironment(game, dt)`.
  Mirrors `Prop.handlePickups`; reuses the same AABB and `Fighter._takeHit` the whole game uses,
  so a drawn hazard hits exactly like any other damage source.
- `js/game.js` — calls `DS.Prop.handleEnvironment(this, dt)` right after `handlePickups` in the play loop.
- `js/ai.js` — `specToMechanic` maps `hazard`/`bouncy` CHLOE specs to env mechanics (they used to be
  dropped to `null`); a prop CHLOE reclassifies as env *while held* is released; placeholder art +
  dev keys for testing.

---

## Test it in 10 seconds (no AI needed)

The local default mechanics already tag `spikes → hazard` and `spring → bouncy`
(`DS.Mechanics.defaultFor`), so Track B works with **zero** CAELLUM/CHLOE connected:

1. Start a match.
2. Press **4** → drops a spike trap (`spikes`). Walk a fighter into it → damage + knockback.
3. Press **5** → drops a spring (`spring`). Jump and come down onto it → launched up.

(Keys 1/2/3 are the Track A held items: gun / sword / bomb.)

## With CHLOE connected
Nothing extra to wire — `DS.AI.connectChloe('<url>/mechanic')` already routes through
`specToMechanic`. When CHLOE returns a `hazard`/`bouncy` spec, the placeholder prop upgrades to
the tuned environment element in place (~1–2 s), same progressive-enhancement swap as everything else.

---

## Verification

Logic is covered by a headless harness (load real `prop.js` + `mechanics.js`, 15 assertions:
overlap detection, knockback direction, re-hit cooldown, invuln/distance gating, descending-only
spring trigger, held-prop safety). The harness is throwaway — re-create it from the commit if needed.

---

## Next steps (not done — pick up here)

1. **Drawn platforms (solid surfaces).** The natural third element: draw a ledge → stand on it.
   `DS.Mechanics` already maps `block/plank/cloud → platform` and `Prop.isEnv` reserves the
   `'platform'` kind. **Landmine:** a real platform must be injected into `stage.platforms`, but
   `Game._prepareStage()` assigns every platform a one-time `_seed` (and `_hp`/`_segs`/move state)
   that a mid-match insert would skip → render-jitter / ledge / breakable loops can hit `undefined`.
   So on spawn you must set `_seed` (and omit `hp`/`move`/`fire`), build the platform as
   `{x: prop.x - prop.w/2, y: prop.y - prop.h/2, w: prop.w, h: prop.h, _seed: …}`, and remove it
   from `stage.platforms` when the prop dies. **Verify in a real browser** — fighter landing/ledge
   logic lives in `fighter.js`/`physics.js` and can't be checked headlessly.
2. **The input/placement half.** Today env props spawn at a fixed point (dev) or wherever the
   Track A draw flow drops them. Track B wants the kid to *place* the element — map the iPad draw
   canvas to a world location so "draw a spring here" lands here. That's the UX side; the engine
   side (this runbook) is ready to receive it.
3. **Juice.** Hazards could read as dangerous (a red pulse / heat shimmer) and springs show a
   compression squash on bounce. Pure `Prop.render` polish — verify visually.
