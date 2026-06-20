# Creation Patch Contract

This is the proposed contract for Phase 3. It is intentionally domain-specific. Do not use arbitrary JSON Patch or generated JavaScript for game edits.

## Patch Principles

- Patch existing game data, not source code.
- Validate before mutation.
- Preserve manual user edits by default.
- Track generated object provenance.
- Apply only after user approval.
- Rebuild/playtest after apply.

## Patch Envelope

```json
{
  "type": "magicboard_scene_patch",
  "version": 1,
  "roomId": "demo",
  "captureVersion": 12,
  "target": {
    "mapId": "meadow"
  },
  "operations": []
}
```

## Operation Types

Initial operation types should be limited to:

- `add_platform`
- `update_platform`
- `remove_generated_platform`
- `set_spawns`
- `add_portal_pair`
- `add_trampoline`
- `add_cannon`
- `set_mode`
- `set_settings`
- `add_decor`
- `set_character_skin`

## Generated Object Metadata

Generated game objects should include source metadata when possible:

```json
{
  "source": {
    "kind": "magicboard_agent",
    "roomId": "demo",
    "captureVersion": 12,
    "candidateId": "candidate-platform-3"
  }
}
```

This lets later generated patches replace generated content without deleting manual editor work.

## Validation Requirements

Every patch application should check:

- map exists;
- operation type is allowed;
- coordinates are finite numbers;
- platform width/height are positive and reasonable;
- `kind` is supported;
- portal pairs are linked;
- settings are within playable ranges;
- operation references current capture/session version or requests confirmation.

## Apply Path

The eventual browser facade should roughly follow this flow:

1. validate patch envelope;
2. resolve stage through `DS.Maps.stageFor(DS.Store.data, mapId)`;
3. apply domain operations;
4. call `DS.Store.save()`;
5. call `game.rebuild()` or equivalent preview refresh;
6. report success/failure.

The facade should reject unknown operations rather than guessing.

