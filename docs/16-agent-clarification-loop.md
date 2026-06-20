# Agent Clarification Loop

The clarification agent sits between raw drawings and game patches. Its job is to understand intent, not to silently mutate the game.

## Inputs

- Room ID.
- Capture version.
- Canonical drawing snapshot.
- Derived projection data.
- Current map/mode context.
- Natural-language user brief.
- Current capability contract.

## Outputs

- Candidate objects.
- Accept/reject/ask classification.
- Clarifying questions.
- User answers.
- Scene plan.
- Later, an approved patch proposal.

## Candidate Types

Initial candidate types:

- platform;
- pass-through platform;
- spawn;
- cannon;
- trampoline;
- portal pair;
- breakable platform;
- decor/background note;
- character sketch;
- gameplay rule/mode note;
- unsupported/unknown.

## Accept / Reject / Ask

**Accept** when the drawing/request maps clearly to existing game data.

Example: a horizontal rectangle labeled "platform" can become a platform candidate.

**Reject** when the request is unsupported and cannot be approximated cleanly.

Example: "make water physics" is not currently supported.

**Ask** when the answer materially changes the build.

Good questions:

- "Should this platform be solid or pass-through?"
- "Should these circles behave like Gem Grab collectibles or just decoration?"
- "Should this curved bridge be approximated with rectangles?"
- "Is this drawing a character, decoration, or hazard?"
- "Which mode should this level use: Smash, Gem Grab, King of the Hill, or K.O. Rush?"

Bad questions:

- "Tell me more."
- "What do you want?"
- "Should I make it fun?"

## Scene Plan

Before patching, the agent should produce a scene plan:

- title/name;
- selected mode;
- map target;
- platforms and gimmicks;
- spawns;
- character definitions;
- settings;
- unsupported requests;
- approximations;
- unresolved questions.

The user must approve the scene plan before Phase 3 patching.

## Version Safety

Questions and answers must reference the capture/projection version they came from. If the drawing changes after questions are generated, answers should not silently apply to stale candidates.

