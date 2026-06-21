// Typed Magic Board apply facade. This is the only supported MVP path from
// semantic draft objects into persisted Doodle Smash game data.
(function (global) {
  'use strict';

  const DS = global.DS = global.DS || {};
  const ALLOWED_KINDS = new Set(['ground', 'wood', 'stone', 'crystal', 'box', 'float', 'trampoline', 'spikes', 'cannon', 'drawn']);
  const ALLOWED_OPS = new Set([
    'replace_platforms',
    'add_platform',
    'update_platform',
    'add_portal_pair',
    'remove_generated',
    'set_spawns',
    'set_character_skin',
    'set_roster',
    'set_world_metadata',
  ]);

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function fail(message) {
    return { ok: false, errors: [message] };
  }

  function sourceFromCandidate(candidate) {
    return {
      kind: 'magicboard_agent',
      roomId: candidate.roomId,
      worldId: candidate.worldId || null,
      captureVersion: candidate.captureVersion,
      candidateId: candidate.candidateId,
      candidateVersion: candidate.candidateVersion || 1,
      geometryHash: candidate.geometryHash,
      sourceIds: candidate.sourceIds || [],
    };
  }

  function classForCandidate(candidate) {
    const answer = candidate && (candidate.answer || candidate.classification);
    const role = answer && answer.role;
    const behavior = answer && answer.behavior;
    if (role === 'cannon' || behavior === 'cannon') return 'cannon';
    if (role === 'spikes' || behavior === 'spikes' || behavior === 'hurt') return 'spikes';
    if (role === 'portal_pair' || behavior === 'portal_pair') return 'portal_pair';
    if (role === 'portal_endpoint' || behavior === 'portal_endpoint') return 'portal_endpoint';
    if (role === 'platform' || ['solid', 'pass', 'bounce', 'ice', 'breakable'].includes(behavior)) return 'platform';
    if (role === 'ignore' || behavior === 'ignore') return 'ignore';
    return candidate && candidate.semanticType ? candidate.semanticType : 'unknown';
  }

  function platformFromCandidate(candidate) {
    if (!candidate || candidate.status !== 'confirmed' || !candidate.geometry || !candidate.answer) return null;
    const objectClass = classForCandidate(candidate);
    if (!['platform', 'cannon', 'spikes'].includes(objectClass)) return null;
    const g = candidate.geometry;
    const behavior = candidate.answer.behavior || 'solid';
    const platform = {
      x: Math.round(g.x),
      y: Math.round(g.y),
      w: Math.round(g.w),
      h: Math.max(18, Math.round(g.h)),
      kind: 'drawn',
      pass: false,
      source: sourceFromCandidate(candidate),
    };

    if (objectClass === 'cannon') {
      platform.kind = 'cannon';
      platform.pass = false;
      platform.fire = { deg: 0, every: 2.0, speed: 880, damage: 11, kbBase: 32, kbScale: 0.12, r: 26, delay: 0 };
    } else if (objectClass === 'spikes') {
      platform.kind = 'spikes';
      platform.hurt = { damage: 26, kbBase: 40, kbScale: 0.18, cooldown: 0.6 };
    } else if (behavior === 'pass') {
      platform.kind = 'float';
      platform.pass = true;
    } else if (behavior === 'bounce') {
      platform.kind = 'trampoline';
      platform.bounce = 1200;
    } else if (behavior === 'hurt' || behavior === 'spikes') {
      platform.kind = 'spikes';
      platform.hurt = { damage: 26, kbBase: 40, kbScale: 0.18, cooldown: 0.6 };
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

  function portalPairFromCandidate(candidate) {
    if (!candidate || candidate.status !== 'confirmed' || !candidate.answer) return null;
    if (classForCandidate(candidate) !== 'portal_pair') return null;
    const endpoints = Array.isArray(candidate.portalEndpoints) ? candidate.portalEndpoints : [];
    if (endpoints.length < 2) return null;
    const source = sourceFromCandidate(candidate);
    const pairId = 'mb-' + String(candidate.candidateId || 'portal').replace(/[^a-zA-Z0-9_-]/g, '').slice(-18);
    const a = endpoints[0];
    const b = endpoints[1];
    const radiusA = Math.max(60, Math.min(120, Math.round(a.r || 74)));
    const radiusB = Math.max(60, Math.min(120, Math.round(b.r || 74)));
    const color = '#3f6fa0';
    return {
      a: { id: pairId + '-a', x: Math.round(a.x), y: Math.round(a.y), r: radiusA, col: color, link: pairId + '-b', source },
      b: { id: pairId + '-b', x: Math.round(b.x), y: Math.round(b.y), r: radiusB, col: color, link: pairId + '-a', source },
    };
  }

  function buildPatchFromSemanticDraft(draft, options) {
    options = options || {};
    const candidates = draft && draft.candidates ? draft.candidates : [];
    const operations = [];
    candidates.forEach((candidate) => {
      const platform = platformFromCandidate(candidate);
      if (platform) operations.push({ type: 'add_platform', platform });
      const portalPair = portalPairFromCandidate(candidate);
      if (portalPair) operations.push({ type: 'add_portal_pair', portalPair });
    });
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

  function validatePortalPair(portalPair, index) {
    const errors = [];
    if (!portalPair || typeof portalPair !== 'object') return ['operation ' + index + ' portalPair is required'];
    ['a', 'b'].forEach((key) => {
      const endpoint = portalPair[key];
      if (!endpoint || typeof endpoint !== 'object') {
        errors.push('operation ' + index + ' portalPair.' + key + ' is required');
        return;
      }
      ['x', 'y', 'r'].forEach((field) => {
        if (!finite(endpoint[field])) errors.push('operation ' + index + ' portalPair.' + key + '.' + field + ' must be finite');
      });
      if (finite(endpoint.r) && (endpoint.r < 20 || endpoint.r > 200)) errors.push('operation ' + index + ' portalPair.' + key + '.r out of range');
    });
    return errors;
  }

  function validateSpawns(spawns, index) {
    const errors = [];
    if (!Array.isArray(spawns) || spawns.length < 2) return ['operation ' + index + ' requires at least two spawns'];
    spawns.forEach((spawn, spawnIndex) => {
      if (!spawn || typeof spawn !== 'object') {
        errors.push('operation ' + index + ' spawn ' + spawnIndex + ' is required');
        return;
      }
      if (!finite(spawn.x) || !finite(spawn.y)) errors.push('operation ' + index + ' spawn ' + spawnIndex + ' must have finite x/y');
    });
    return errors;
  }

  function validateRoster(roster, index) {
    const errors = [];
    if (!Array.isArray(roster) || roster.length < 2) return ['operation ' + index + ' roster requires at least two entries'];
    roster.forEach((name, rosterIndex) => {
      if (typeof name !== 'string' || !name.trim()) errors.push('operation ' + index + ' roster ' + rosterIndex + ' must be a character name');
      if (DS.Store && DS.Store.data && DS.Store.data.characters && !DS.Store.data.characters[name]) {
        errors.push('operation ' + index + ' unknown character ' + name);
      }
    });
    return errors;
  }

  function validateGeneratedSelector(operation, index) {
    const ids = operation.candidateIds || (operation.candidateId ? [operation.candidateId] : []);
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id)) {
      return ['operation ' + index + ' requires candidateId or candidateIds'];
    }
    return [];
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
      if (operation.type === 'update_platform') {
        errors.push.apply(errors, validateGeneratedSelector(operation, index));
        if (operation.patch) errors.push.apply(errors, validatePlatform(Object.assign({ x: 1, y: 1, w: 1, h: 1 }, operation.patch), index));
      }
      if (operation.type === 'add_portal_pair') errors.push.apply(errors, validatePortalPair(operation.portalPair, index));
      if (operation.type === 'remove_generated') errors.push.apply(errors, validateGeneratedSelector(operation, index));
      if (operation.type === 'set_spawns') errors.push.apply(errors, validateSpawns(operation.spawns || [], index));
      if (operation.type === 'set_roster') errors.push.apply(errors, validateRoster(operation.roster || [], index));
      if (operation.type === 'set_character_skin' && (!operation.character || !operation.skin)) {
        errors.push('operation ' + index + ' requires character and skin');
      }
      if (operation.type === 'set_world_metadata' && operation.name != null && typeof operation.name !== 'string') {
        errors.push('operation ' + index + ' name must be a string');
      }
    });
    return { ok: errors.length === 0, errors };
  }

  function sameGeneratedSource(platform, incomingIds) {
    const source = platform && platform.source;
    return source && source.kind === 'magicboard_agent' && incomingIds.has(source.candidateId);
  }

  function sameGeneratedPortal(portal, incomingIds) {
    const source = portal && portal.source;
    return source && source.kind === 'magicboard_agent' && incomingIds.has(source.candidateId);
  }

  function selectorIds(operation) {
    if (!operation) return [];
    if (Array.isArray(operation.candidateIds)) return operation.candidateIds;
    return operation.candidateId ? [operation.candidateId] : [];
  }

  function updateGeneratedPlatforms(stage, operation) {
    const ids = new Set(selectorIds(operation));
    const patch = operation.patch || operation.platform || {};
    stage.platforms = (stage.platforms || []).map((platform) => {
      if (!sameGeneratedSource(platform, ids)) return platform;
      return Object.assign({}, platform, clone(patch), { source: platform.source });
    });
  }

  function validateLaunchReady(mapId, roster) {
    const missing = [];
    if (!DS.Store || !DS.Store.data || !DS.Maps) return { ok: false, missing: ['game store'], stage: null };
    let stage = null;
    try { stage = DS.Maps.stageFor(DS.Store.data, mapId); }
    catch (_error) { stage = null; }
    if (!stage) missing.push('stage');
    const platforms = stage && Array.isArray(stage.platforms) ? stage.platforms : [];
    const spawns = stage && Array.isArray(stage.spawns) ? stage.spawns : [];
    const activeRoster = Array.isArray(roster) && roster.length ? roster : (DS.Store.data.roster || []);
    if (!platforms.length) missing.push('platform');
    if (spawns.filter((spawn) => spawn && finite(spawn.x) && finite(spawn.y)).length < 2) missing.push('two spawns');
    if (activeRoster.filter((name) => DS.Store.data.characters && DS.Store.data.characters[name]).length < 2) missing.push('valid roster');
    return { ok: missing.length === 0, missing, stage };
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
      } else if (operation.type === 'add_portal_pair' && operation.portalPair && operation.portalPair.a && operation.portalPair.a.source) {
        incomingCandidateIds.add(operation.portalPair.a.source.candidateId);
      } else if (operation.type === 'remove_generated' && operation.candidateId) {
        incomingCandidateIds.add(operation.candidateId);
      } else if (operation.type === 'remove_generated' && Array.isArray(operation.candidateIds)) {
        operation.candidateIds.forEach((id) => incomingCandidateIds.add(id));
      }
    });
    if (incomingCandidateIds.size) {
      stage.platforms = (stage.platforms || []).filter((platform) => !sameGeneratedSource(platform, incomingCandidateIds));
      stage.portals = (stage.portals || []).filter((portal) => !sameGeneratedPortal(portal, incomingCandidateIds));
    }

    if (patch.operations.some((operation) => operation.type === 'replace_platforms')) {
      stage.platforms = [];
    }

    patch.operations.forEach((operation) => {
      if (operation.type === 'add_platform') {
        stage.platforms = stage.platforms || [];
        stage.platforms.push(clone(operation.platform));
      } else if (operation.type === 'add_portal_pair') {
        stage.portals = stage.portals || [];
        const pair = operation.portalPair;
        stage.portals.push(clone(pair.a), clone(pair.b));
      } else if (operation.type === 'update_platform') {
        updateGeneratedPlatforms(stage, operation);
      } else if (operation.type === 'set_spawns') {
        stage.spawns = clone(operation.spawns);
      } else if (operation.type === 'set_roster') {
        DS.Store.data.roster = clone(operation.roster);
      } else if (operation.type === 'set_character_skin') {
        DS.Store.data.characters = DS.Store.data.characters || {};
        DS.Store.data.characters[operation.character] = DS.Store.data.characters[operation.character] || { name: operation.character };
        DS.Store.data.characters[operation.character].skin = clone(operation.skin);
      } else if (operation.type === 'set_world_metadata') {
        if (operation.name) stage.name = operation.name;
      }
    });

    DS.Store.save();
    if (options.rebuild && typeof options.rebuild === 'function') options.rebuild();
    return {
      ok: true,
      applied: patch.operations.length,
      mapId: patch.target.mapId,
      platformCount: (stage.platforms || []).length,
      portalCount: (stage.portals || []).length,
      launch: validateLaunchReady(patch.target.mapId),
    };
  }

  DS.MagicBoardGame = {
    applyPatch,
    buildPatchFromSemanticDraft,
    classForCandidate,
    platformFromCandidate,
    portalPairFromCandidate,
    validateLaunchReady,
    validatePatch,
  };
  global.MagicBoardGame = DS.MagicBoardGame;
})(window);
