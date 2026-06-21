// AI KO finishers: generated MP4 cut-ins are optional cached cosmetics.
// Gameplay remains deterministic canvas doodles; this module only captures official
// in-game renders and asks the backend to generate rare final-KO videos.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;

  const MODEL = 'pikaffects-v1.5';
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
    return ch.finisher;
  }

  function victimSkinHash(name, ch) {
    return hashText([name || (ch && ch.name) || 'character', stable(ch && ch.skin ? ch.skin : null), RENDER_VERSION].join('|'));
  }

  function cacheKey(attackerId, style, victimId, skinHash) {
    return [attackerId, style, victimId, skinHash, MODEL].join('|');
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

  async function submitJob(attackerId, victimId, victimSkinHashValue, style, imageDataUrl) {
    const response = await fetch(apiUrl('/finishers/jobs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attackerId,
        victimId,
        victimSkinHash: victimSkinHashValue,
        style,
        imageDataUrl,
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

  function storeJob(attackerCh, key, victimId, skinHash, style, job) {
    const finisher = ensure(attackerCh);
    finisher.jobs[key] = {
      jobId: job.jobId,
      status: job.status,
      error: job.error || null,
      victimId,
      victimSkinHash: skinHash,
      style,
      updatedAt: new Date().toISOString(),
    };
    if (job.status === 'ready' && job.videoUrl) {
      finisher.clips[key] = {
        videoUrl: job.videoUrl,
        jobId: job.jobId,
        victimId,
        victimSkinHash: skinHash,
        style,
        model: MODEL,
        updatedAt: new Date().toISOString(),
        note: 'fal media URLs may expire; V1 stores the hosted URL for local demo persistence.',
      };
    }
    if (DS.Store && DS.Store.save) DS.Store.save();
  }

  async function generate(attackerId, victimId) {
    const data = DS.Store && DS.Store.data;
    const attacker = data && data.characters && data.characters[attackerId];
    const victim = data && data.characters && data.characters[victimId];
    if (!attacker || !victim) throw new Error('Choose valid attacker and victim characters.');
    const finisher = ensure(attacker);
    const style = finisher.style || 'Melt';
    const skinHash = victimSkinHash(victimId, victim);
    const key = cacheKey(attackerId, style, victimId, skinHash);
    const imageDataUrl = renderCharacterDataUrl(victim);
    const job = await submitJob(attackerId, victimId, skinHash, style, imageDataUrl);
    storeJob(attacker, key, victimId, skinHash, style, job);
    return { key, job };
  }

  async function refresh(attackerId, key) {
    const data = DS.Store && DS.Store.data;
    const attacker = data && data.characters && data.characters[attackerId];
    const finisher = attacker && ensure(attacker);
    const record = finisher && finisher.jobs[key];
    if (!record || !record.jobId) throw new Error('No finisher job to refresh.');
    const job = await getJob(record.jobId);
    storeJob(attacker, key, record.victimId, record.victimSkinHash, record.style, job);
    return job;
  }

  function findReadyClip(attacker, victim) {
    if (!attacker || !victim || !attacker.ch || !victim.ch) return null;
    const finisher = ensure(attacker.ch);
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
    STYLES,
    ensure,
    victimSkinHash,
    cacheKey,
    renderCharacterDataUrl,
    generate,
    refresh,
    findReadyClip,
    videoForClip,
    preloadForGame,
  };
})(window);
