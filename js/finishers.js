// AI KO finishers: generated MP4 cut-ins are optional cached cosmetics.
// Gameplay remains deterministic canvas doodles; this module only captures official
// in-game renders and asks the backend to generate rare final-KO videos.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;

  const MODEL = 'pikaffects-v1.5';
  const MOTION_MODEL = 'doodle-keyframes-v1';
  const STYLES = ['Melt', 'Explode', 'Dissolve', 'Squish', 'Tear', 'Crumble', 'Cake-ify'];
  const DEFAULT_BACKEND = 'http://localhost:8000';
  const RENDER_VERSION = 'finisher-render-v1';
  const preloaded = {};

  function backendUrl() {
    const params = new URLSearchParams(global.location.search);
    const raw = params.get('finisherBackend') || params.get('drawBackend') || params.get('backend') || DEFAULT_BACKEND;
    try { return new URL(raw, global.location.href); }
    catch (_error) { return new URL(DEFAULT_BACKEND); }
  }

  function apiUrl(path) {
    const url = backendUrl();
    url.pathname = path;
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function stable(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }

  function hashText(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function ensure(ch) {
    if (!ch.finisher || typeof ch.finisher !== 'object') ch.finisher = {};
    if (!STYLES.includes(ch.finisher.style)) ch.finisher.style = 'Melt';
    if (!ch.finisher.jobs || typeof ch.finisher.jobs !== 'object') ch.finisher.jobs = {};
    if (!ch.finisher.clips || typeof ch.finisher.clips !== 'object') ch.finisher.clips = {};
    if (!ch.finisher.customUltimates || typeof ch.finisher.customUltimates !== 'object') ch.finisher.customUltimates = {};
    return ch.finisher;
  }

  function victimSkinHash(name, ch) {
    return hashText([name || (ch && ch.name) || 'character', stable(ch && ch.skin ? ch.skin : null), RENDER_VERSION].join('|'));
  }

  function cacheKey(attackerId, style, victimId, skinHash, sourceType, motionHash) {
    return [attackerId, style, victimId, skinHash, sourceType || 'pikaffects_image', motionHash || '', MODEL].join('|');
  }

  function customUltimateKey(playerId, characterId, skinHash, motionHash, style) {
    return [playerId, characterId, skinHash || '', motionHash || '', style || 'Melt', MOTION_MODEL].join('|');
  }

  function renderCharacterDataUrl(ch) {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 512;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = D.COL.paper;
    ctx.fillRect(0, 0, 512, 512);
    if (D.paperTexture) ctx.drawImage(D.paperTexture(512, 512), 0, 0);
    const pose = (ch.actions && ch.actions.hurt && ch.actions.hurt.pose)
      || (ch.actions && ch.actions.idle && ch.actions.idle.pose);
    ctx.save();
    ctx.translate(256, 298);
    ctx.scale(4.45, 4.45);
    DS.character.drawFighter(ctx, ch, pose, { facing: 1, expr: 'hurt', seed: 917 });
    ctx.restore();
    return cv.toDataURL('image/png');
  }

  async function submitJob(attackerId, victimId, victimSkinHashValue, style, imageDataUrl, options) {
    options = options || {};
    const response = await fetch(apiUrl('/finishers/jobs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attackerId,
        victimId,
        victimSkinHash: victimSkinHashValue,
        style,
        imageDataUrl,
        sourceType: options.sourceType || 'pikaffects_image',
        motionClipDataUrl: options.motionClipDataUrl || null,
        keyframeDataUrls: options.keyframeDataUrls || [],
        motionSummary: options.motionSummary || null,
        skinHash: options.skinHash || null,
      }),
    });
    if (!response.ok) throw new Error('finisher job failed: ' + response.status);
    return response.json();
  }

  async function getJob(jobId) {
    const response = await fetch(apiUrl('/finishers/jobs/' + encodeURIComponent(jobId)), { cache: 'no-store' });
    if (!response.ok) throw new Error('finisher status failed: ' + response.status);
    return response.json();
  }

  function storeJob(attackerCh, key, victimId, skinHash, style, job, options) {
    options = options || {};
    const finisher = ensure(attackerCh);
    finisher.jobs[key] = {
      jobId: job.jobId,
      status: job.status,
      error: job.error || null,
      victimId,
      victimSkinHash: skinHash,
      style,
      sourceType: options.sourceType || 'pikaffects_image',
      motionHash: options.motionHash || null,
      playerId: options.playerId || null,
      characterId: options.characterId || null,
      skinHash: options.skinHash || null,
      updatedAt: new Date().toISOString(),
    };
    if (job.status === 'ready' && job.videoUrl) {
      const clip = {
        videoUrl: job.videoUrl,
        jobId: job.jobId,
        victimId,
        victimSkinHash: skinHash,
        style,
        sourceType: options.sourceType || 'pikaffects_image',
        motionHash: options.motionHash || null,
        playerId: options.playerId || null,
        characterId: options.characterId || null,
        model: options.sourceType === 'doodle_keyframes' ? MOTION_MODEL : MODEL,
        updatedAt: new Date().toISOString(),
        note: 'fal media URLs may expire; V1 stores the hosted URL for local demo persistence.',
      };
      finisher.clips[key] = clip;
      if (options.sourceType === 'doodle_keyframes' && options.playerId != null) {
        finisher.customUltimates[options.playerId] = Object.assign({ key, armed: true }, clip);
      }
    }
    if (DS.Store && DS.Store.save) DS.Store.save();
  }

  async function generate(attackerId, victimId, options) {
    options = options || {};
    const data = DS.Store && DS.Store.data;
    const attacker = data && data.characters && data.characters[attackerId];
    const victim = data && data.characters && data.characters[victimId];
    if (!attacker || (!victim && !options.sourceType)) throw new Error('Choose valid attacker and victim characters.');
    const finisher = ensure(attacker);
    const style = options.style || finisher.style || 'Melt';
    const skinHash = options.skinHash || victimSkinHash(victimId, victim);
    const sourceType = options.sourceType || 'pikaffects_image';
    const motionHash = options.motionHash || hashText(stable({
      motionClipDataUrl: options.motionClipDataUrl || '',
      keyframeDataUrls: options.keyframeDataUrls || [],
      motionSummary: options.motionSummary || null,
    }));
    const key = sourceType === 'doodle_keyframes' && options.playerId != null
      ? customUltimateKey(options.playerId, attackerId, skinHash, motionHash, style)
      : cacheKey(attackerId, style, victimId, skinHash, sourceType, sourceType === 'pikaffects_image' ? '' : motionHash);
    const imageDataUrl = options.imageDataUrl || renderCharacterDataUrl(victim || attacker);
    const job = await submitJob(attackerId, victimId || 'custom-ultimate', skinHash, style, imageDataUrl, Object.assign({}, options, { sourceType, motionHash, skinHash }));
    storeJob(attacker, key, victimId || 'custom-ultimate', skinHash, style, job, Object.assign({}, options, { sourceType, motionHash, skinHash, characterId: attackerId }));
    return { key, job };
  }

  async function generateCustomUltimate(playerId, characterId, options) {
    options = options || {};
    return generate(characterId, characterId, Object.assign({}, options, {
      playerId: String(playerId),
      characterId,
      sourceType: options.sourceType || 'doodle_keyframes',
    }));
  }

  async function refresh(attackerId, key) {
    const data = DS.Store && DS.Store.data;
    const attacker = data && data.characters && data.characters[attackerId];
    const finisher = attacker && ensure(attacker);
    const record = finisher && finisher.jobs[key];
    if (!record || !record.jobId) throw new Error('No finisher job to refresh.');
    const job = await getJob(record.jobId);
    storeJob(attacker, key, record.victimId, record.victimSkinHash, record.style, job, record);
    return job;
  }

  async function refreshPendingForGame(game) {
    if (!game || !game.fighters) return;
    const seen = new Set();
    for (const f of game.fighters) {
      if (!f || !f.ch) continue;
      const finisher = ensure(f.ch);
      for (const key in finisher.jobs) {
        const record = finisher.jobs[key];
        if (!record || !record.jobId || seen.has(record.jobId)) continue;
        if (record.status === 'ready' || record.status === 'failed' || record.status === 'missing_key') continue;
        seen.add(record.jobId);
        try {
          const latest = await getJob(record.jobId);
          storeJob(f.ch, key, record.victimId, record.victimSkinHash, record.style, latest, record);
          if (latest.status === 'ready' && latest.videoUrl) videoForClip(Object.assign({ key }, finisher.clips[key]));
        } catch (_error) {
          record.error = 'refresh failed';
          record.updatedAt = new Date().toISOString();
        }
      }
    }
  }

  function findReadyClip(attacker, victim) {
    if (!attacker || !victim || !attacker.ch || !victim.ch) return null;
    const finisher = ensure(attacker.ch);
    const custom = finisher.customUltimates && finisher.customUltimates[String(attacker.pIndex)];
    if (custom && custom.armed && custom.videoUrl) return Object.assign({ key: custom.key, customUltimate: true }, custom);
    const style = finisher.style || 'Melt';
    const skinHash = victimSkinHash(victim.name, victim.ch);
    const key = cacheKey(attacker.name, style, victim.name, skinHash);
    const clip = finisher.clips && finisher.clips[key];
    return clip && clip.videoUrl ? Object.assign({ key }, clip) : null;
  }

  function videoForClip(clip) {
    if (!clip || !clip.videoUrl) return null;
    if (preloaded[clip.key] && preloaded[clip.key].src === clip.videoUrl) return preloaded[clip.key];
    const video = document.createElement('video');
    video.src = clip.videoUrl;
    video.preload = 'auto';
    video.playsInline = true;
    video.muted = true;
    preloaded[clip.key] = video;
    return video;
  }

  function preloadForGame(game) {
    if (!game || !game.fighters) return;
    for (const attacker of game.fighters) {
      for (const victim of game.fighters) {
        if (attacker === victim) continue;
        const clip = findReadyClip(attacker, victim);
        if (clip) videoForClip(clip);
      }
    }
  }

  DS.Finishers = {
    MODEL,
    MOTION_MODEL,
    STYLES,
    ensure,
    victimSkinHash,
    cacheKey,
    customUltimateKey,
    renderCharacterDataUrl,
    generate,
    generateCustomUltimate,
    refresh,
    refreshPendingForGame,
    findReadyClip,
    videoForClip,
    preloadForGame,
  };
})(window);
