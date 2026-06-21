// Typed Magic Board apply facade. This is the only supported MVP path from
// semantic draft objects into persisted Doodle Smash game data.
(function (global) {
  'use strict';

  const DS = global.DS = global.DS || {};
  const ALLOWED_KINDS = new Set(['ground', 'wood', 'stone', 'crystal', 'box', 'float', 'trampoline', 'spikes', 'cannon', 'drawn']);
  const ALLOWED_OPS = new Set(['replace_platforms', 'add_platform', 'set_spawns']);

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function fail(message) {
    return { ok: false, errors: [message] };
  }

  function platformFromCandidate(candidate) {
    if (!candidate || candidate.status !== 'confirmed' || !candidate.geometry || !candidate.answer) return null;
    if (candidate.answer.role !== 'platform') return null;
    const g = candidate.geometry;
    const behavior = candidate.answer.behavior || 'solid';
    const platform = {
      x: Math.round(g.x),
      y: Math.round(g.y),
      w: Math.round(g.w),
      h: Math.max(18, Math.round(g.h)),
      kind: 'drawn',
      pass: false,
      source: {
        kind: 'magicboard_agent',
        roomId: candidate.roomId,
        worldId: candidate.worldId || null,
        captureVersion: candidate.captureVersion,
        candidateId: candidate.candidateId,
        geometryHash: candidate.geometryHash,
        sourceIds: candidate.sourceIds || [],
      },
    };

    if (behavior === 'pass') {
      platform.kind = 'float';
      platform.pass = true;
    } else if (behavior === 'bounce') {
      platform.kind = 'trampoline';
      platform.bounce = 1200;
    } else if (behavior === 'hurt') {
      platform.kind = 'spikes';
      platform.hurt = { damage: 18, kbBase: 34, kbScale: 0.14, cooldown: 0.7 };
    } else if (behavior === 'ice') {
      platform.kind = 'crystal';
    } else if (behavior === 'breakable') {
      platform.kind = 'box';
      platform.hp = 4;
    } else if (behavior === 'cannon') {
      platform.kind = 'cannon';
      platform.pass = false;
      platform.fire = { deg: 0, every: 2.0, speed: 880, damage: 11, kbBase: 32, kbScale: 0.12, r: 26, delay: 0 };
    }
    return platform;
  }

  function buildPatchFromSemanticDraft(draft, options) {
    options = options || {};
    const platforms = (draft && draft.candidates ? draft.candidates : [])
      .map(platformFromCandidate)
      .filter(Boolean);
    const operations = platforms.map((platform) => ({ type: 'add_platform', platform }));
    if (options.replacePlatforms) operations.unshift({ type: 'replace_platforms' });
    return {
      type: 'magicboard_world_patch',
      version: 1,
      worldId: options.worldId || (draft && draft.worldId) || null,
      roomId: options.roomId || (draft && draft.roomId) || null,
      captureVersion: draft ? draft.captureVersion : 0,
      target: { mapId: options.mapId || 'meadow' },
      operations,
    };
  }

  function validatePlatform(platform, index) {
    const errors = [];
    if (!platform || typeof platform !== 'object') return ['operation ' + index + ' platform is required'];
    ['x', 'y', 'w', 'h'].forEach((field) => {
      if (!finite(platform[field])) errors.push('operation ' + index + ' platform.' + field + ' must be finite');
    });
    if (finite(platform.w) && (platform.w <= 0 || platform.w > 5000)) errors.push('operation ' + index + ' platform.w out of range');
    if (finite(platform.h) && (platform.h <= 0 || platform.h > 600)) errors.push('operation ' + index + ' platform.h out of range');
    if (platform.kind && !ALLOWED_KINDS.has(platform.kind)) errors.push('operation ' + index + ' unsupported kind ' + platform.kind);
    return errors;
  }

  function validatePatch(patch) {
    const errors = [];
    if (!patch || typeof patch !== 'object') return fail('patch must be an object');
    if (patch.type !== 'magicboard_world_patch') errors.push('patch.type must be magicboard_world_patch');
    if (patch.version !== 1) errors.push('patch.version must be 1');
    if (!patch.target || !patch.target.mapId) errors.push('patch.target.mapId is required');
    if (!Array.isArray(patch.operations)) errors.push('patch.operations must be an array');
    if (patch.target && patch.target.mapId && DS.Maps) {
      const exists = DS.Maps.has
        ? DS.Maps.has(patch.target.mapId)
        : (DS.Maps.list && DS.Maps.list().some((map) => map.id === patch.target.mapId));
      if (!exists) errors.push('unknown mapId ' + patch.target.mapId);
    }
    (patch.operations || []).forEach((operation, index) => {
      if (!operation || !ALLOWED_OPS.has(operation.type)) {
        errors.push('operation ' + index + ' unsupported type');
        return;
      }
      if (operation.type === 'replace_platforms') return;
      if (operation.type === 'add_platform') errors.push.apply(errors, validatePlatform(operation.platform, index));
      if (operation.type === 'set_spawns') {
        const spawns = operation.spawns || [];
        if (!Array.isArray(spawns) || spawns.length < 2) errors.push('operation ' + index + ' requires at least two spawns');
      }
    });
    return { ok: errors.length === 0, errors };
  }

  function sameGeneratedSource(platform, incomingIds) {
    const source = platform && platform.source;
    return source && source.kind === 'magicboard_agent' && incomingIds.has(source.candidateId);
  }

  function applyPatch(patch, options) {
    options = options || {};
    const validation = validatePatch(patch);
    if (!validation.ok) return validation;
    if (!DS.Store || !DS.Store.data || !DS.Maps) return fail('game store is not loaded');

    const stage = DS.Maps.stageFor(DS.Store.data, patch.target.mapId);
    if (!stage) return fail('target stage not found');

    const incomingCandidateIds = new Set();
    patch.operations.forEach((operation) => {
      if (operation.type === 'add_platform' && operation.platform && operation.platform.source) {
        incomingCandidateIds.add(operation.platform.source.candidateId);
      }
    });
    if (incomingCandidateIds.size) {
      stage.platforms = (stage.platforms || []).filter((platform) => !sameGeneratedSource(platform, incomingCandidateIds));
    }

    if (patch.operations.some((operation) => operation.type === 'replace_platforms')) {
      stage.platforms = [];
    }

    patch.operations.forEach((operation) => {
      if (operation.type === 'add_platform') {
        stage.platforms = stage.platforms || [];
        stage.platforms.push(clone(operation.platform));
      } else if (operation.type === 'set_spawns') {
        stage.spawns = clone(operation.spawns);
      }
    });

    DS.Store.save();
    if (options.rebuild && typeof options.rebuild === 'function') options.rebuild();
    return {
      ok: true,
      applied: patch.operations.length,
      mapId: patch.target.mapId,
      platformCount: (stage.platforms || []).length,
    };
  }

  DS.MagicBoardGame = {
    applyPatch,
    buildPatchFromSemanticDraft,
    platformFromCandidate,
    validatePatch,
  };
  global.MagicBoardGame = DS.MagicBoardGame;
})(window);
